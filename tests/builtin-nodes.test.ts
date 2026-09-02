import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { buildThreeViewGenerationPrompt, enrichCharactersWithHistoricalPortraits, executeBuiltinNode, resolveFirstFramePrompt, shouldRetrieveHistoricalPortrait } from '../server/builtin-nodes.ts'

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
    if (input.query.includes('张角')) throw new Error('没有匹配页面')
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
  assert.equal(enriched.characters[1].historicalPortrait.status, 'not_found')
  assert.match(enriched.characters[1].designPrompt, /正史未检索到可靠体貌记载/)
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

test('generic roles use scene-scoped continuity and do not reuse an older generic asset', async () => {
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
  assert.equal((result.missingCharacters as Array<Record<string, unknown>>)[0].continuityKey, 'ep001-scene-01-求评者-v2')
})
