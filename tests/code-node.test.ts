import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { executeCodeNode } from '../server/code-node.ts'
import { SANGUO_CHARACTER_LOOKUP_CODE, SANGUO_CONTEXT_INIT_CODE, SANGUO_FIRST_FRAME_BRANCH_CODE, SANGUO_REUSE_TAIL_CODE, SANGUO_TAIL_FRAME_CODE } from '../src/code-node-presets.ts'

const workbookPath = new URL('../public/data/三国历史短剧1000集策划总表.xlsx', import.meta.url)

async function workbookUpload() {
  const buffer = await readFile(workbookPath)
  return {
    id: 'sanguo-workbook',
    name: '三国历史短剧1000集策划总表.xlsx',
    dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buffer.toString('base64')}`,
  }
}

test('configurable JavaScript matches episode 41 and emits an input context patch', async () => {
  const result = await executeCodeNode({
    code: SANGUO_CONTEXT_INIT_CODE,
    context: { input: { episode_number: 41 } },
    files: [await workbookUpload()],
  })
  assert.equal(result.matchedBy.rowNumber, 42)
  assert.equal(result.fields.episode_number, 41)
  assert.equal(result.fields.episode_title, '符水与饥民')
  assert.equal(result.fields.historical_period, '184')
  assert.deepEqual(result.fields.source_titles, ['后汉书'])
  assert.deepEqual(result.fields.verification_urls, [
    'https://ctext.org/hou-han-shu/huang-fu-song-zhu-jun-lie-zhuan/zhs',
    'https://zh.wikisource.org/zh-hans/%E8%B3%87%E6%B2%BB%E9%80%9A%E9%91%91',
  ])
  assert.equal('scene_count' in result.fields, false)
  assert.equal('target_duration' in result.fields, false)
  assert.equal('historical_query' in result.fields, false)
  assert.match(String(result.internetRequest.query), /符水与饥民 后汉书 .*卷七十一/)
  assert.deepEqual(result.internetRequest.urls, result.fields.verification_urls)
  assert.equal(result.internetRequest.maxSources, 3)
  assert.equal(result.internetRequest.maxPassages, 6)
  assert.deepEqual(result.contextPatch, { input: { episode_number: 41, ...result.fields } })
  assert.equal(result.sheet.rowCount, 1000)
  assert.match(result.executionLogs[0], /符水与饥民/)
})

test('node code controls matching and reports a clear error for an unknown episode', async () => {
  await assert.rejects(
    executeCodeNode({
      code: SANGUO_CONTEXT_INIT_CODE,
      context: { input: { episode_number: 1001 } },
      files: [await workbookUpload()],
    }),
    /Excel 中未找到第 1001 集/,
  )
})

test('excel.parse exposes workbook metadata and bounded parsed rows to custom code', async () => {
  const result = await executeCodeNode({
    code: `
      const parsed = excel.parse(files[0], { sheetName: params.sheet, headerRow: 1, outputLimit: 2 })
      return { ...parsed, selectedEpisode: input.episode_number, note: prompt }
    `,
    prompt: '自定义解析',
    params: { sheet: '1000集总表' },
    context: { input: { episode_number: 7 } },
    files: [await workbookUpload()],
  })
  assert.equal(result.count, 1000)
  assert.equal(result.rows.length, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.selectedEpisode, 7)
  assert.equal(result.note, '自定义解析')
  assert.deepEqual(result.workbook.sheetNames, ['总览', '1000集总表', '史料索引', '使用说明'])
})

test('character lookup code preserves cached assets and marks only new cast members for generation', async () => {
  const cached = { id: 'character-zhangjiao', characterName: '张角', url: '/characters/zhangjiao.png' }
  const result = await executeCodeNode({
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    context: {
      shot_script: { characters: ['张角', '张宝', '张角'], firstFramePrompt: '张宝二十余岁，头戴黄巾。' },
      character_lookup_result: {
        characters: [{ name: '张角', continuityKey: '张角-eastern-han-v1' }, { name: '张宝', continuityKey: '张宝-eastern-han-v1' }],
        items: [cached],
        missingCharacters: [{ name: '张宝', continuityKey: '张宝-eastern-han-v1' }],
      },
    },
  })
  assert.deepEqual(result.names, ['张角', '张宝'])
  assert.deepEqual(result.existingAssets, [cached])
  assert.deepEqual(result.existingImages, ['/characters/zhangjiao.png'])
  assert.deepEqual(result.existingNames, ['张角'])
  assert.deepEqual(result.missingCharacters.map((item: Record<string, unknown>) => item.name), ['张宝'])
  assert.equal(result.foundCount, 1)
  assert.equal(result.missingCount, 1)
  assert.equal(result.shouldGenerate, true)
  assert.equal(result.imageRequest.size, '1792x1024')
  assert.equal(result.imageRequest.aspectRatio, '16:9')
  assert.equal(result.imageRequest.n, 1)
  assert.deepEqual(result.imageRequest.referenceImages, [])
  assert.match(String(result.imageRequest.prompt), /张宝/)
  assert.match(String(result.imageRequest.prompt), /定妆三视图/)
  assert.match(String(result.missingCharacters[0].designPrompt), /二十余岁/)
  assert.deepEqual(result.imageRequest.requests.map((item: Record<string, unknown>) => item.n), [1])
})

test('character lookup preserves a three-view master for derived identity references', async () => {
  const result = await executeCodeNode({
    code: SANGUO_CHARACTER_LOOKUP_CODE,
    context: {
      shot_script: { characters: ['张角'] },
      character_lookup_result: {
        characters: [{ name: '张角', continuityKey: '张角-eastern-han-v1' }],
        items: [{ characterName: '张角', assetType: 'three-view', url: '/characters/zhangjiao-sheet.png' }],
        missingCharacters: [],
      },
    },
  })
  assert.deepEqual(result.existingImages, ['/characters/zhangjiao-sheet.png'])
  assert.equal(result.shouldGenerate, false)
  assert.deepEqual(result.missingCharacters, [])
})

test('first-frame branch routes to character references or previous-tail extraction exclusively', async () => {
  const referenced = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reference', firstFramePrompt: '' },
      loop: { previous: undefined },
      character_lookup: { existingImages: [] },
    },
  })
  assert.equal(referenced.shouldGenerate, false)
  assert.equal(referenced.shouldReusePreviousTail, false)
  assert.equal(referenced.route, 'reference')
  assert.deepEqual(referenced.referenceRequest.referenceImages, [])

  const reused = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reuse_previous_tail', firstFramePrompt: '' },
      loop: { previous: { last_frame: { url: '/frames/previous-tail.png' } } },
      character_lookup: { existingImages: [] },
    },
  })
  assert.equal(reused.shouldGenerate, false)
  assert.equal(reused.shouldReusePreviousTail, true)
  assert.equal(reused.route, 'reuse_previous_tail')
  const extracted = await executeCodeNode({
    code: SANGUO_REUSE_TAIL_CODE,
    context: { first_frame_branch: { previousLastFrame: reused.previousLastFrame } },
  })
  assert.equal(extracted.url, '/frames/previous-tail.png')
  assert.equal(extracted.generated, false)
})

test('first-frame branch merges cached and generated images into video character references', async () => {
  const result = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reference', firstFramePrompt: '竖屏历史电影首帧' },
      loop: { previous: undefined },
      character_lookup: {
        names: ['张角', '张宝', '张良'],
        existingAssets: [{ characterName: '张角', url: '/characters/zhangjiao.png', metadata: { continuityKey: '张角-v1' } }],
      },
      character_assets: {
        items: [
          { characterName: '张宝', url: '/generated/zhangbao.png', metadata: { continuityKey: '张宝-v1' } },
          { characterName: '张良', url: 'https://cdn.example.com/zhangliang.png', metadata: { continuityKey: '张良-v1' } },
        ],
      },
    },
  })
  assert.deepEqual(result.referenceRequest, {
    referenceImages: [
      '/characters/zhangjiao.png',
      '/generated/zhangbao.png',
      'https://cdn.example.com/zhangliang.png',
    ],
    referenceBindings: [
      { characterName: '张角', continuityKey: '张角-v1' },
      { characterName: '张宝', continuityKey: '张宝-v1' },
      { characterName: '张良', continuityKey: '张良-v1' },
    ],
    referenceMode: 'three-view-all',
  })
})

test('tail-frame code prefers the actual model tail and falls back to the generated target tail', async () => {
  const available = await executeCodeNode({
    code: SANGUO_TAIL_FRAME_CODE,
    context: { video_shot: { raw: { data: { task_result: { last_frame_url: 'https://cdn.example.com/tail.png' } } } } },
  })
  assert.equal(available.url, 'https://cdn.example.com/tail.png')
  assert.equal(available.available, true)
  assert.equal(available.source, 'video-model-output')

  const targetFallback = await executeCodeNode({
    code: SANGUO_TAIL_FRAME_CODE,
    context: {
      video_shot: { url: 'https://cdn.example.com/clip.mp4' },
      end_frame: { url: 'https://cdn.example.com/target-tail.png' },
    },
  })
  assert.equal(targetFallback.url, 'https://cdn.example.com/target-tail.png')
  assert.equal(targetFallback.source, 'target-end-frame')

  const unavailable = await executeCodeNode({
    code: SANGUO_TAIL_FRAME_CODE,
    context: { video_shot: { url: 'https://cdn.example.com/clip.mp4', raw: { cover_url: 'https://cdn.example.com/cover.png' } } },
  })
  assert.equal(unavailable.url, '')
  assert.equal(unavailable.available, false)
  assert.match(String(unavailable.warning), /目标尾帧不可用/)
})

test('first-frame branch falls back to character-reference video when the requested previous tail is unavailable', async () => {
  const result = await executeCodeNode({
    code: SANGUO_FIRST_FRAME_BRANCH_CODE,
    context: {
      shot_script: { firstFrameMode: 'reuse_previous_tail', firstFramePrompt: '新首帧' },
      loop: { previous: { last_frame: { url: '' } } },
      character_lookup: { existingImages: [] },
    },
  })
  assert.equal(result.shouldGenerate, false)
  assert.equal(result.shouldReusePreviousTail, false)
  assert.match(String(result.fallbackReason), /没有可用尾帧/)
  assert.equal(result.route, 'reference')
})

test('code placeholders inject JSON literals and resolve missing paths as undefined', async () => {
  const result = await executeCodeNode({
    code: `
      const title = \${input.title}
      const characters = \${shot.characters}
      const missing = \${loop.previous.last_frame.url}
      return { title, characters, missing: missing ?? null }
    `,
    context: { input: { title: '符水与饥民' }, shot: { characters: ['张角', '张宝'] }, loop: {} },
  })
  assert.deepEqual(result, {
    title: '符水与饥民',
    characters: ['张角', '张宝'],
    missing: null,
    executionLogs: [],
  })
})

test('code nodes can execute without Excel and return a context patch', async () => {
  const result = await executeCodeNode({
    code: `console.log('plain code'); return { total: params.a + params.b, contextPatch: { metrics: { ready: true } } }`,
    params: { a: 2, b: 3 },
    context: {},
  })
  assert.equal(result.total, 5)
  assert.deepEqual(result.contextPatch, { metrics: { ready: true } })
  assert.deepEqual(result.executionLogs, ['[log] plain code'])
})

test('restricted runtime rejects dynamic code generation and runaway scripts', async () => {
  await assert.rejects(
    executeCodeNode({ code: `return Function('return 1')()`, context: {} }),
    /Code generation from strings disallowed/,
  )
  await assert.rejects(
    executeCodeNode({ code: `return console.log.constructor('return process')()`, context: {} }),
    /Code generation from strings disallowed/,
  )
  await assert.rejects(
    executeCodeNode({ code: 'while (true) {}', context: {} }),
    /Script execution timed out/,
  )
})
