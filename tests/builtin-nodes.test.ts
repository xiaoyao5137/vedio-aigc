import { readFileSync } from 'node:fs'
import { validateDramaOutline } from '../src/history-drama.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { buildThreeViewGenerationPrompt, buildThreeViewNegativePrompt, enrichCharactersWithHistoricalPortraits, executeBuiltinNode, resolveFirstFramePrompt, shouldRetrieveHistoricalPortrait, threeViewReferencePoseIssue } from '../server/builtin-nodes.ts'

test('actual clean-shaven portrait failure becomes a positive target and conditional negative constraints', () => {
  const character = { name: '甘陵乡人甲', description: '中年男性圆脸无须戴灰褐色麻布头巾', designPrompt: '中年男性圆脸无须，深灰色短袄' }
  const prompt = buildThreeViewGenerationPrompt(character, 'CHARACTER_APPEARANCE_REJECTED: ["实际人物有明显的短须和山羊胡"]')
  assert.match(prompt, /Clean-shaven face/)
  assert.match(prompt, /重新落实目标外观/)
  assert.doesNotMatch(prompt, /实际人物有明显的短须和山羊胡/)
  assert.match(buildThreeViewNegativePrompt(character), /胡茬/)
  assert.doesNotMatch(buildThreeViewNegativePrompt({ name: '甘陵乡人乙', description: '中年男性留短须' }), /胡茬|beard/)
  const repair = buildThreeViewGenerationPrompt(character, 'CHARACTER_APPEARANCE_REJECTED: beard', true)
  assert.match(repair, /^编辑<<<image_1>>>/)
  assert.match(repair, /保留眉毛和面部五官/)
  assert.doesNotMatch(repair, /东汉|中年男性/)
})

test('three-view generation prompt enforces one horizontal row and strips scene staging by instruction', () => {
  const prompt = buildThreeViewGenerationPrompt({
    name: '桓帝',
    designPrompt: '桓帝坐于矮几后，身前有诏书和油灯',
  })
  assert.match(prompt, /16:9 横向人物设定图/)
  assert.match(prompt, /单行三列/)
  assert.match(prompt, /禁止上下结构、上下两排、2×2宫格/)
  assert.match(prompt, /禁止复现这些场景、动作和道具/)
})

test('historical portrait lookup skips extras and generic functional roles', () => {
  assert.equal(shouldRetrieveHistoricalPortrait('刘备'), true)
  assert.equal(shouldRetrieveHistoricalPortrait('张角弟子'), false)
  assert.equal(shouldRetrieveHistoricalPortrait('一名黄巾军'), false)
  assert.equal(shouldRetrieveHistoricalPortrait('求评者'), false)
})

test('historical portrait enrichment keeps sourced evidence and tolerates empty results', async () => {
  const calls: string[] = []
  const enriched = await enrichCharactersWithHistoricalPortraits([
    { name: '刘备', designPrompt: '刘备三视图' },
    { name: '张角', designPrompt: '张角三视图' },
    { name: '张角弟子', designPrompt: '弟子三视图' },
  ], async (input) => {
    calls.push(input.query)
    if (input.query.includes('張角')) throw new Error('没有匹配页面')
    return {
      query: input.query,
      sourceDetail: '',
      count: 1,
      citations: [{
        index: 1,
        id: 'source-1',
        title: '三國志/卷32',
        source: '维基文库',
        edition: '',
        url: 'https://example.test/history',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        content: '先主姓劉，諱備。身長七尺五寸，垂手下膝，顧自見其耳。',
        retrieval: 'internet',
      }],
      text: '',
      sourceMode: 'internet',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      attemptedUrls: [],
      failures: [],
    }
  })
  assert.equal(calls.length, 4)
  assert.equal(enriched.foundCount, 1)
  assert.equal(enriched.skippedCount, 1)
  assert.match(enriched.characters[0].designPrompt, /身長七尺五寸/)
  assert.equal(enriched.characters[1].historicalPortrait.status, 'retrieval_failed')
  assert.match(enriched.characters[1].designPrompt, /史料检索失败，体貌状态未知/)
  assert.equal(enriched.characters[2].historicalPortrait.status, 'skipped')
})

test('first-frame prompt falls back to the explicit node parameter', () => {
  assert.equal(resolveFirstFramePrompt({ prompt: '', params: { firstFramePrompt: '东汉村落稳定首帧' } }), '东汉村落稳定首帧')
  assert.equal(resolveFirstFramePrompt({ prompt: '插值后的首帧', params: { firstFramePrompt: '参数首帧' } }), '插值后的首帧')
  assert.equal(resolveFirstFramePrompt({ prompt: '', params: {} }), '')
})

test('character.ensure generates and persists every missing character asset', async () => {
  const inserts: unknown[][] = []
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (/^\s*select id, workflow_id, character_name/.test(sql)) return { rows: [] }
      if (/insert into character_assets/.test(sql)) {
        inserts.push(params ?? [])
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected query: ${sql}`)
    },
  }
  const mediaCalls: string[] = []
  const result = await executeBuiltinNode(pool as never, {
    operation: 'character.ensure',
    model: { id: 'image-model', provider: 'Kling', capability: 'image', settings: {} },
    params: {
      workflowId: 'wf-history',
      characters: [
        { name: '张角', designPrompt: '张角三视图', continuityKey: 'zhang-jiao-v1' },
        { name: '张角弟子', designPrompt: '张角弟子三视图', continuityKey: 'disciple-v1' },
      ],
    },
  }, async ({ params }) => {
    const name = String(params.characterName)
    mediaCalls.push(name)
    return { status: 200, body: { images: [{ url: `https://example.test/${encodeURIComponent(name)}.png` }] } }
  })

  assert.deepEqual(mediaCalls, ['张角', '张角弟子'])
  assert.equal(inserts.length, 2)
  assert.deepEqual(inserts.map((params) => params.slice(1, 4)), [
    ['wf-history', '张角', 'https://example.test/%E5%BC%A0%E8%A7%92.png'],
    ['wf-history', '张角弟子', 'https://example.test/%E5%BC%A0%E8%A7%92%E5%BC%9F%E5%AD%90.png'],
  ])
  assert.equal(result.generatedCount, 2)
  assert.equal(result.count, 2)
})

test('character.ensure requests a wide board and retries with the validation failure', async () => {
  const square = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#777777' } }).png().toBuffer()
  const valid = await sharp({ create: { width: 900, height: 300, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ee1111' } }).composite([{ input: await sharp({ create: { width: 300, height: 150, channels: 3, background: '#770808' } }).png().toBuffer(), left: 0, top: 150 }]).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#11ee11' } }).composite([{ input: await sharp({ create: { width: 300, height: 150, channels: 3, background: '#087708' } }).png().toBuffer(), left: 0, top: 150 }]).png().toBuffer(), left: 300, top: 0 },
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#1111ee' } }).composite([{ input: await sharp({ create: { width: 300, height: 150, channels: 3, background: '#080877' } }).png().toBuffer(), left: 0, top: 150 }]).png().toBuffer(), left: 600, top: 0 },
    ])
    .png()
    .toBuffer()
  const responses = [square, valid].map((image) => `data:image/png;base64,${image.toString('base64')}`)
  const calls: Array<{ prompt: string; params: Record<string, unknown> }> = []
  const pool = {
    async query(sql: string) {
      if (/^\s*select id, workflow_id, character_name/.test(sql)) return { rows: [] }
      if (/insert into character_assets/.test(sql)) return { rows: [], rowCount: 1 }
      throw new Error(`Unexpected query: ${sql}`)
    },
  }
  const result = await executeBuiltinNode(pool as never, {
    operation: 'character.ensure',
    model: { id: 'image-model', provider: 'Kling', capability: 'image', settings: {} },
    params: {
      workflowId: 'wf-history',
      characters: [{ name: '桓帝', designPrompt: '桓帝坐于矮几后' }],
      validateThreeView: true,
      maxGenerationAttempts: 2,
    },
  }, async ({ prompt, params }) => {
    calls.push({ prompt, params })
    return { status: 200, body: { images: [{ url: responses[calls.length - 1] }] } }
  }) as Record<string, unknown>

  assert.equal(calls.length, 2)
  assert.equal(calls[0].params.aspectRatio, '16:9')
  assert.match(calls[0].prompt, /单行三列/)
  assert.match(calls[1].prompt, /上一次结果已被程序拒绝/)
  assert.match(calls[1].prompt, /禁止正方形、竖版或上下分层结构/)
  assert.equal((result.generated as Array<Record<string, unknown>>)[0].metadata && ((result.generated as Array<Record<string, unknown>>)[0].metadata as Record<string, unknown>).quality !== undefined, true)
})

test('character.ensure cannot reintroduce a cached sheet rejected by lookup', async () => {
  const invalid = await sharp({ create: { width: 768, height: 1360, channels: 3, background: '#777777' } }).png().toBuffer()
  const valid = await sharp({ create: { width: 900, height: 300, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ee1111' } }).composite([{ input: await sharp({ create: { width: 300, height: 150, channels: 3, background: '#770808' } }).png().toBuffer(), left: 0, top: 150 }]).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#11ee11' } }).composite([{ input: await sharp({ create: { width: 300, height: 150, channels: 3, background: '#087708' } }).png().toBuffer(), left: 0, top: 150 }]).png().toBuffer(), left: 300, top: 0 },
      { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: '#1111ee' } }).composite([{ input: await sharp({ create: { width: 300, height: 150, channels: 3, background: '#080877' } }).png().toBuffer(), left: 0, top: 150 }]).png().toBuffer(), left: 600, top: 0 },
    ]).png().toBuffer()
  const inserts: unknown[][] = []
  const pool = { async query(sql: string, params?: unknown[]) {
    if (/select id, workflow_id, character_name/.test(sql)) return { rows: [{
      id: 'bad-cache', workflow_id: 'wf-history', character_name: '张角', asset_type: 'three-view',
      uri: `data:image/png;base64,${invalid.toString('base64')}`, prompt: '', version: 1,
      metadata: { continuityKey: '张角-eastern-han-v1' }, created_at: new Date(), updated_at: new Date(),
    }] }
    if (/insert into character_assets/.test(sql)) { inserts.push(params ?? []); return { rows: [], rowCount: 1 } }
    throw new Error(`Unexpected query: ${sql}`)
  } }
  let calls = 0
  const result = await executeBuiltinNode(pool as never, {
    operation: 'character.ensure', model: { id: 'image-model', provider: 'Kling', capability: 'image', settings: {} },
    params: { workflowId: 'wf-history', characters: ['张角'], validateThreeView: true, maxGenerationAttempts: 2 },
  }, async () => { calls += 1; return { status: 200, body: { url: `data:image/png;base64,${valid.toString('base64')}` } } }) as Record<string, unknown>
  assert.equal(calls, 1)
  assert.equal(result.cachedCount, 0)
  assert.equal(result.generatedCount, 1)
  assert.equal(inserts.length, 1)
})

test('character.archive pairs generic image output with characters and persists it', async () => {
  const inserts: unknown[][] = []
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (!/insert into character_assets/.test(sql)) throw new Error(`Unexpected query: ${sql}`)
      inserts.push(params ?? [])
      return { rows: [], rowCount: 1 }
    },
  }
  const result = await executeBuiltinNode(pool as never, {
    operation: 'character.archive',
    executionContext: { workflowId: 'wf-history', nodeId: 'character-archive' },
    params: {
      workflowId: 'wf-history',
      characters: [
        { name: '张角', designPrompt: '张角三视图' },
        { name: '张角弟子', designPrompt: '张角弟子三视图' },
      ],
      generatedAssets: {
        urls: ['https://example.test/zhang-jiao.png', 'https://example.test/disciple.png'],
        raw: { images: [{ url: 'https://example.test/zhang-jiao.png' }] },
      },
    },
  })

  assert.deepEqual(inserts.map((params) => params.slice(1, 5)), [
    ['wf-history', '张角', 'https://example.test/zhang-jiao.png', '张角三视图'],
    ['wf-history', '张角弟子', 'https://example.test/disciple.png', '张角弟子三视图'],
  ])
  assert.equal(result.archivedCount, 2)
})

test('character.archive treats an explicit empty cast as an idempotent editorial no-op', async () => {
  let queries = 0
  const result = await executeBuiltinNode({ query: async () => { queries += 1; return { rows: [] } } } as never, {
    operation: 'character.archive',
    executionContext: { workflowId: 'wf-history', nodeId: 'character-archive' },
    params: { workflowId: 'wf-history', characters: [], generatedAssets: { items: [] } },
  }) as Record<string, unknown>
  assert.equal(queries, 0)
  assert.deepEqual(result, { items: [], urls: [], byCharacter: {}, archivedCount: 0, count: 0 })
  await assert.rejects(executeBuiltinNode({ query: async () => ({ rows: [] }) } as never, {
    operation: 'character.archive', params: { workflowId: 'wf-history' },
  }), /未收到 characters/)
})

test('character.archive reuses a named actors stable voice across portrait versions', async () => {
  const updates: unknown[][] = []
  const pool = { async query(sql: string, params?: unknown[]) {
    if (/select \* from character_assets/.test(sql)) return { rows: [{
      id: 'zhang-jiao-visual-v22', workflow_id: 'wf-history', character_name: '张角', asset_type: 'three-view',
      uri: 'https://example.test/zhang-jiao-v22.png', prompt: '', version: 22,
      metadata: { continuityKey: '张角-eastern-han-v22' }, created_at: new Date(), updated_at: new Date(),
    }] }
    if (/select v\.\* from original_character_voices/.test(sql)) return { rows: [{
      character_id: 'voice-character-zhang-jiao', voice_id: 'voice-14', model_id: 'tts-model',
    }] }
    if (/update character_assets/.test(sql)) { updates.push(params ?? []); return { rows: [], rowCount: 1 } }
    throw new Error(`Unexpected query: ${sql}`)
  } }
  const result = await executeBuiltinNode(pool as never, {
    operation: 'character.archive',
    params: {
      workflowId: 'wf-history',
      characters: [{ name: '张角', continuityKey: '张角-eastern-han-v22' }],
      generatedAssets: { items: [] },
      voiceAssets: [{
        contract: 'voice-candidate-v2', workflowId: 'wf-history', continuityKey: 'voice:张角',
        characterName: '张角', voiceId: 'voice-14', modelId: 'tts-model', accountScope: 'acct',
        targetModel: 'kling-v2-6', prefix: 'p', description: 'd', previewText: 't', previewUrl: 'https://example.test/voice.mp3',
      }],
    },
  }) as Record<string, unknown>
  assert.equal(updates.length, 1)
  assert.equal((result.voiceAssets as Array<Record<string, unknown>>)[0].characterId, 'voice-character-zhang-jiao')
  assert.equal(((result.items as Array<Record<string, unknown>>)[0].metadata as Record<string, unknown>).continuityKey, '张角-eastern-han-v22')
})

test('history verification reports final duration growth without rejecting a valid re-estimate', async () => {
  const result = await executeBuiltinNode({ query: async () => ({ rows: [], rowCount: 0 }) } as never, {
    operation: 'history.verify',
    params: {
      citations: [{ title: '后汉书' }],
      expectedSceneCount: 1,
      expectedTotalDuration: 12,
      shots: [{
        duration: 15,
        characters: ['许劭'],
        historicalBasis: '[史料1] 清议',
        adaptationBoundary: '对白与调度为合理拟制',
      }],
    },
  }) as Record<string, unknown>

  assert.equal(result.passed, true)
  assert.equal(result.totalDuration, 15)
  assert.equal(result.expectedTotalDuration, 12)
  assert.equal(result.durationDelta, 3)
})

test('production history verification rejects simulator flags without real media evidence', async () => {
  const params = { citations: [{ title: '后汉书' }], expectedSceneCount: 1, expectedTotalDuration: 15, requireQualityEvidence: true,
    shots: [{ duration: 15, characters: ['许劭'], historicalBasis: '[史料1] 清议', adaptationBoundary: '拟制' }],
    videos: [{ url: 'simulated.svg', audioEmbedded: true }] }
  const invoke = (values: unknown) => executeBuiltinNode({ query: async () => ({ rows: [] }) } as never, { operation: 'history.verify', params: values as Record<string, unknown> }) as Promise<Record<string, unknown>>
  const rejected = await invoke(params)
  assert.equal(rejected.passed, false)
  const accepted = await invoke({ ...params,
    shots: params.shots.map(s => ({ ...s, scriptValidation: { passed: true }, contentReview: { passed: true } })),
    videos: [{ url: '/generated/real.mp4', technicalValidation: { passed: true, speechVerified: true }, visualReview: { passed: true } }],
  })
  assert.equal(accepted.passed, false, 'old fixed-duration flags cannot certify the new pacing contract')
})

test('character.archive binds structured results by character name even when provider results are reordered', async () => {
  const inserts: unknown[][] = []
  const pool = { async query(_sql: string, params?: unknown[]) { inserts.push(params ?? []); return { rows: [], rowCount: 1 } } }
  await executeBuiltinNode(pool as never, {
    operation: 'character.archive',
    params: {
      workflowId: 'wf-history',
      characters: [{ name: '许劭', continuityKey: 'xushao-v1' }, { name: '求评者', continuityKey: 'requester-v2' }],
      generatedAssets: { items: [
        { characterName: '求评者', url: 'https://example.test/requester.png' },
        { characterName: '许劭', url: 'https://example.test/xushao.png' },
      ] },
    },
  })
  assert.deepEqual(inserts.map((params) => params[3]), [
    'https://example.test/xushao.png',
    'https://example.test/requester.png',
  ])
})

test('generic roles use episode continuity and do not reuse an older generic asset', async () => {
  const pool = { async query() { return { rows: [{
    id: 'old-requester', workflow_id: 'wf-history', character_name: '求评者', asset_type: 'three-view',
    uri: 'https://example.test/old.png', prompt: '', version: 1,
    metadata: { continuityKey: '求评者-eastern-han-v1' }, created_at: new Date(), updated_at: new Date(),
  }] } } }
  const result = await executeBuiltinNode(pool as never, {
    operation: 'character.lookup',
    params: { workflowId: 'wf-history', episodeNumber: 1, sceneId: 'scene-01', characters: ['求评者'] },
  }) as Record<string, unknown>
  assert.equal(result.foundCount, 0)
  assert.equal(result.missingCount, 1)
  assert.equal((result.missingCharacters as Array<Record<string, unknown>>)[0].continuityKey, 'ep001-求评者-v3')
})

test('character.lookup rejects mechanically unusable cached sheets before voice element creation', async () => {
  const invalid = await sharp({ create: { width: 768, height: 1360, channels: 3, background: '#888888' } }).png().toBuffer()
  const pool = { async query(sql: string) {
    if (/select id, workflow_id, character_name/.test(sql)) return { rows: [{
      id: 'legacy-portrait', workflow_id: 'wf-history', character_name: '张角', asset_type: 'three-view',
      uri: `data:image/png;base64,${invalid.toString('base64')}`, prompt: '', version: 1,
      metadata: { continuityKey: '张角-eastern-han-v1' }, created_at: new Date(), updated_at: new Date(),
    }] }
    if (/from original_character_voices/.test(sql)) return { rows: [] }
    throw new Error(`Unexpected query: ${sql}`)
  } }
  const result = await executeBuiltinNode(pool as never, {
    operation: 'character.lookup',
    params: { workflowId: 'wf-history', characters: ['张角'], includeVoices: true },
  }) as Record<string, unknown>
  assert.equal(result.foundCount, 0)
  assert.equal(result.missingCount, 1)
  assert.deepEqual(result.items, [])
  assert.match(String((result.rejectedAssets as Array<Record<string, unknown>>)[0].reason), /单行水平结构/)
})

test('character.lookup skips a contaminated named sheet and reuses the newest valid reviewed identity', async () => {
  const pool = { async query(sql: string) {
    if (/select id, workflow_id, character_name/.test(sql)) return { rows: [{
      id: 'zhangjiao-v1', workflow_id: 'wf-sanguo-history-drama', character_name: '张角', asset_type: 'three-view',
      uri: 'https://example.test/zhangjiao-v1.png',
      prompt: '身份与稳定外观：张角口唇微合，念咒动作刚完成。中性站姿。',
      version: 1, metadata: { continuityKey: '张角-eastern-han-v1', quality: {
        status: 'needs_attention', warnings: ['正面与侧面右手遮住口鼻，无法辨认面部，不能作为稳定身份参考。'],
      } }, created_at: new Date(), updated_at: new Date(),
    }, {
      id: 'zhangjiao-legacy', workflow_id: 'wf-sanguo-history-drama', character_name: '张角', asset_type: 'three-view',
      uri: 'https://example.test/zhangjiao-legacy.png', prompt: '张角，东汉道袍，中性站姿。', version: 1,
      metadata: { continuityKey: '张角-eastern-han-v1' }, created_at: new Date(0), updated_at: new Date(0),
    }] }
    throw new Error('Unexpected query: ' + sql)
  } }
  const result = await executeBuiltinNode(pool as never, {
    operation: 'character.lookup',
    params: { workflowId: 'wf-sanguo-history-drama', characters: ['张角'] },
  }) as Record<string, unknown>
  assert.equal(result.foundCount, 1)
  assert.equal(result.missingCount, 0)
  assert.equal((result.items as Array<Record<string, unknown>>)[0].id, 'zhangjiao-legacy')
  assert.match(String((result.rejectedAssets as Array<Record<string, unknown>>)[0].reason), /POSE_INVALID/)
})

test('three-view negative instructions do not quarantine an otherwise clean asset', () => {
  assert.equal(threeViewReferencePoseIssue({
    prompt: '双手自然下垂。禁止念咒、手靠近脸、手遮挡嘴。',
    metadata: { description: '生成提示同上', visualProfile: { appearance: '张角直立，双手低于腰部，面部无遮挡，无持物或遮脸动作' }, quality: { warnings: [] } },
  }), '')
  assert.match(threeViewReferencePoseIssue({ metadata: { quality: { warnings: ['实际画面中右手遮挡嘴唇'] } } }), /POSE_INVALID/)
  for (const warning of ['正面与侧面抬手、手指靠近唇部，与中性站姿略有差异，属于手势细节，不阻断。', '手抬到胸口以上但未遮脸', '口唇微合，面部清晰可见', '双手自然抬起，普通手势细节']) {
    assert.equal(threeViewReferencePoseIssue({ metadata: { quality: { warnings: [warning] } } }), '', warning)
  }
})


test('numbered extras share identity across scenes but not episodes', async () => {
  for (const name of ['周福门客甲', '朝臣', '甘陵长者甲', '观者乙', '行人甲']) assert.equal(shouldRetrieveHistoricalPortrait(name), false)
  const pool = { async query() { return { rows: [] } } }
  const key = async (episodeNumber: number, sceneId: string) => {
    const result = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { characters: ['周福门客甲'], episodeNumber, sceneId } }) as { missingCharacters: { continuityKey: string }[] }
    return result.missingCharacters[0].continuityKey
  }
  assert.equal(await key(1, 's1'), await key(1, 's2'))
  assert.notEqual(await key(1, 's1'), await key(2, 's1'))
})

type FixtureValue = ReturnType<typeof JSON.parse>
function cinematicPublicationFixture() {
 const unknown={status:'unknown'},observed=(value:string)=>({status:'observed',value,evidence:'实际帧0与尾帧'});
 const check={status:'passed',reason:'实际可拍信息已建立',evidenceRefs:[0]};
 const editorial=(id:string,path:string,quote:string)=>({version:'dramaturgy-v1',passed:true,orientation:check,dramaticProgression:check,characterDistinction:check,payoff:check,evidence:[{itemId:id,path,quote,finding:'可听可见的具体行动'}],issues:[],warnings:[],repairScope:'scene'});
 const approved=validateDramaOutline(JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json',import.meta.url),'utf8'))) as FixtureValue;
 approved.scenes[1].continuityMode='coverage_cut';
 const shots=approved.scenes.map((scene:FixtureValue,index:number)=>({id:scene.id,contentContractVersion:'cinematic-v1',dramaticSceneId:scene.dramaticSceneId,duration:scene.targetDuration,characters:scene.cast,initialCharacters:scene.cast,endCharacters:scene.cast,presentCharacters:scene.cast,worldState:{settingId:scene.dramaticSceneId,characters:scene.cast.map((name:string)=>({name,position:observed('门旁'),heldProps:observed('空手'),pendingAction:unknown}))},firstFrameMode:'reference',continuity:{mode:scene.continuityMode,bridgeType:index?'cut':'opening',previousShotId:index?approved.scenes[index-1].id:'',bridgeAnchor:'看清对方回应后的选择'},historicalBasis:scene.historicalBasis,adaptationBoundary:scene.adaptationBoundary,scriptValidation:{passed:true},factualReview:{passed:true},contentReview:{passed:true},pacing:{version:'dynamic-v1'},storyProgress:{unitId:scene.dramaticSceneId,status:scene.closesUnit?'complete':'continuing'},completionCriteria:scene.completionCriteria,audioType:index===2?'环境声':'旁白',audioText:scene.requiredBeats.flatMap((beat:FixtureValue)=>beat.observable.audio).join('。'),videoPrompt:scene.requiredBeats.flatMap((beat:FixtureValue)=>beat.observable.visual).join('。'),lastFramePrompt:'两名宾客站在门旁',coveredBeatIds:scene.requiredBeats.map((beat:FixtureValue)=>beat.id),shotIntent:{viewpointCharacter:scene.cast[0],purpose:scene.purpose,cameraReason:'回应处观察人物选择'},beatDramaturgy:scene.requiredBeats.map((beat:FixtureValue)=>({beatId:beat.id,function:beat.function,stateChange:beat.stateChange,...beat.observable})),dramaturgyReview:editorial(scene.id,'videoPrompt',scene.requiredBeats[0].observable.visual[0])}));
 const videos=shots.map((shot:FixtureValue,index:number)=>({url:'/generated/s'+(index+1)+'.mp4',duration:shot.duration,decoded:true,hasAudio:true,audioMode:index===2?'ambient':'speech',audioEmbedded:true,evidenceUrl:'/generated/s'+index+'.json',frames:['/generated/s'+index+'-0.jpg','/generated/s'+index+'-1.jpg'],lastFrameUrl:'/generated/s'+index+'-1.jpg',...(index===2?{}:{speechValidation:{passed:true}}),technicalValidation:{passed:true,speechVerified:index!==2},visualReview:{passed:true,issues:[],endCharacters:shot.characters,endingState:'两名宾客站在门旁',worldState:shot.worldState,endingStateEvidence:{method:'actual-tail-image',frame:'/generated/s'+index+'-1.jpg'},...(shot.continuity.mode==='coverage_cut'?{continuityReview:{mode:'coverage_cut',passed:true,checks:shot.characters.flatMap((character:string)=>['position','heldProps'].map(field=>({character,field,status:'observed',evidence:'首帧与前镜实际状态一致',frameIndices:[0]})))}}:{}),narrativeClosure:{unitId:shot.dramaticSceneId,complete:shot.storyProgress.status==='complete',actionEvidence:'实际收回招呼',responseEvidence:'以离开作出回应',unresolvedActions:[],criteriaChecks:shot.completionCriteria.map((criterion:string)=>({criterion,status:'complete',evidence:'尾帧实际状态'}))},pacingReview:{passed:true,reason:'动作推进',lastMeaningfulActionSecond:shot.duration-.3}}}));
 const outline={...approved,factualReview:{passed:true},dramaturgyReview:{...editorial(approved.scenes[0].id,'scenes.0.requiredBeats.0.observable.visual.0',approved.scenes[0].requiredBeats[0].observable.visual[0]),evidence:approved.scenes.map((scene:FixtureValue,index:number)=>({itemId:scene.id,path:'scenes.'+index+'.requiredBeats.0.observable.visual.0',quote:scene.requiredBeats[0].observable.visual[0],finding:'实际行动呈现选择'}))}};
 outline.count=4;outline.totalDuration=28;
 return {citations:[{title:'后汉书',content:'宾客互相讥评'}],expectedSceneCount:4,requireQualityEvidence:true,approvedSceneOutline:outline,sceneOutline:outline,shots,videos};
}

test('final publication accepts same-scene coverage and ambient acting without false ASR, while keeping editorial and media scopes separate',async()=>{
 const pool={query:async()=>({rows:[]})} as never;
 const params=cinematicPublicationFixture();
 const invoke=(values:Record<string,unknown>)=>executeBuiltinNode(pool,{operation:'history.verify',params:values}) as Promise<Record<string,unknown>>;
 const result=await invoke(params);assert.equal(result.passed,true,JSON.stringify(result.violations));assert.equal(result.contentContractVersion,'cinematic-v1');assert.equal(result.totalDuration,28);
 assert.deepEqual(result.reviewSummary,{scriptFacts:'passed',scriptDramaturgy:'passed',segmentMedia:'passed',episodePlayback:'not-reviewed',fullVideoWatched:false});
 const timeline=await executeBuiltinNode(pool,{operation:'timeline.compose',params:{storyboards:params.shots,videos:params.videos,historicalVerification:result}}) as Record<string,unknown>;
 assert.deepEqual(timeline.episodePlayback,{status:'not-reviewed',fullVideoWatched:false});assert.equal(timeline.contentContractVersion,'cinematic-v1');
 const fakeSpeech=structuredClone(params);fakeSpeech.videos[2].speechValidation={passed:true};assert.equal((await invoke(fakeSpeech)).passed,false);
 const missingDrama=structuredClone(params);delete (missingDrama.shots[1] as Record<string,unknown>).dramaturgyReview;assert.equal((await invoke(missingDrama)).passed,false);
 const undeccoded=structuredClone(params);undeccoded.videos[1].decoded=false;assert.equal((await invoke(undeccoded)).passed,false);
 const fakeCut=structuredClone(params);fakeCut.shots[1].continuity.mode='scene_cut';assert.equal((await invoke(fakeCut)).passed,false);
 await assert.rejects(()=>executeBuiltinNode(pool,{operation:'timeline.compose',params:{storyboards:params.shots,videos:params.videos}}),/HISTORY_PUBLICATION_REJECTED/);
});
