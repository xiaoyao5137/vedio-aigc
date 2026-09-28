import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeAnimatedMapBoundaryFrames, upgradeAnimatedShotStyles, ANIMATED_MAP_FRAME_OPERATION, ANIMATED_MAP_END_FRAME_PROMPT,
  ANIMATED_MAP_FIRST_FRAME_PROMPT, SAND_TABLE_END_FRAME_CONTINUITY, refreshAnimatedFrameSandTablePrompt,
  refreshStaticBoundaryFrameScope } from '../src/animated-map-frames.ts'
import { SANGUO_FIRST_FRAME_BRANCH_CODE } from '../src/code-node-presets.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'
import { upgradeAnimatedShotStyleContract, upgradeFirstFrameBranchLineSplitting, upgradeIllustrationLayerLayout, upgradeNeutralPortraitAndIllustrationBackground, upgradeQualityWorkflow } from '../src/quality-node-presets.ts'

const loop = { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' }
const node = (id: string, kind: string) => ({ id, title: id, kind, resultVar: id, prompt: 'kept', params: [], uploads: [], loop,
  position: { x: 100, y: 100 }, parentId: id === 'sanguo-scene-loop' ? undefined : 'sanguo-scene-loop',
  ...(id === 'sanguo-scene-loop' ? { childIds: ['sanguo-first-frame-branch', 'sanguo-first-frame-tail', 'sanguo-end-frame', 'sanguo-video'] } : {}) })

test('schema 130 adds one Kling boundary-frame route and preserves the selected video model', () => {
  const source = {
    id: 'wf-sanguo-history-drama', schemaVersion: 129,
    nodes: [node('sanguo-scene-loop', 'loop'), { ...node('sanguo-first-frame-branch', 'code'), code: 'old managed branch' },
      node('sanguo-first-frame-tail', 'code'), { ...node('sanguo-end-frame', 'image'), modelId: 'kling-image-3' },
      { ...node('sanguo-video', 'video'), modelId: 'user-kling-video', params: [{ id: 'duration', name: 'duration', englishName: 'duration', type: 'number', required: true, value: '8' }] }],
    edges: [{ id: 'branch-video', from: 'sanguo-first-frame-branch', to: 'sanguo-video' }],
  }
  const migrated = upgradeAnimatedMapBoundaryFrames(source)
  assert.equal(migrated.schemaVersion, 130)
  const first = migrated.nodes.find(item => item.id === 'sanguo-animated-map-first-frame')!
  const end = migrated.nodes.find(item => item.id === 'sanguo-end-frame')!
  const video = migrated.nodes.find(item => item.id === 'sanguo-video')!
  assert.equal(first.modelId, 'kling-image-3')
  assert.equal(first.operation, ANIMATED_MAP_FRAME_OPERATION)
  assert.deepEqual(first.runIf, { path: 'first_frame_branch.shouldGenerateAnimatedFirstFrame', equals: true })
  assert.equal(end.modelId, 'kling-image-3')
  assert.equal(end.params.find(item => item.englishName === 'referenceImage')?.value, '${first_frame.url}')
  assert.equal(video.modelId, 'user-kling-video')
  assert.equal(video.params.find(item => item.englishName === 'endImage')?.value, '${end_frame.url}')
  assert.ok(migrated.edges.some(edge => edge.from === first.id && edge.to === end.id))
  assert.ok(migrated.edges.some(edge => edge.from === end.id && edge.to === video.id))
  assert.deepEqual(upgradeAnimatedMapBoundaryFrames(migrated), migrated)
})

test('schema 131 generalizes Kling boundary frames to all animation styles without replacing node ids', () => {
  const source = {
    id: 'wf-sanguo-history-drama', schemaVersion: 130, edges: [], nodes: [
      { ...node('sanguo-first-frame-branch', 'code'), code: 'map only' },
      { ...node('sanguo-animated-map-first-frame', 'image'), modelId: 'kling-image-3' },
      { ...node('sanguo-end-frame', 'image'), modelId: 'kling-image-3' },
      { ...node('sanguo-video', 'video'), modelId: 'user-video', params: [{ id: 'end', name: '动画地图目标尾帧', englishName: 'endImage', type: 'image', required: false, value: '${end_frame.url}' }] },
    ],
  }
  const migrated = upgradeAnimatedShotStyles(source)
  assert.equal(migrated.schemaVersion, 131)
  assert.match(String(migrated.nodes[0].code), /shouldGenerateAnimatedEndFrame/)
  assert.deepEqual(migrated.nodes[1].runIf, { path: 'first_frame_branch.shouldGenerateAnimatedFirstFrame', equals: true })
  assert.deepEqual(migrated.nodes[2].runIf, { path: 'first_frame_branch.shouldGenerateAnimatedEndFrame', equals: true })
  assert.equal(migrated.nodes[3].modelId, 'user-video')
  assert.deepEqual(upgradeAnimatedShotStyles(migrated), migrated)
})

test('schema 131 refreshes animation grammar without replacing later duration and state guidance', () => {
  const managedWriter = 'custom duration-v2 worldState prompt\n- editorialRole 与 visualTreatment 必须逐字继承当前scene。legacy managed line'
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 130, edges: [], nodes: [
    { ...node('sanguo-scene-outline', 'text'), prompt: 'old outline' },
    { ...node('sanguo-shot-script', 'text'), prompt: managedWriter },
    { ...node('sanguo-first-frame-branch', 'code'), code: 'map only' },
    { ...node('sanguo-animated-map-first-frame', 'image'), modelId: 'kling-image-3' },
    { ...node('sanguo-end-frame', 'image'), modelId: 'kling-image-3' },
    { ...node('sanguo-video', 'video'), modelId: 'user-video', params: [] },
  ] }
  const migrated = upgradeAnimatedShotStyleContract(source)
  const writer = migrated.nodes.find(item => item.id === 'sanguo-shot-script')!
  assert.match(writer.prompt, /duration-v2/)
  assert.match(writer.prompt, /worldState/)
  assert.match(writer.prompt, /character_illustration/)
  assert.deepEqual(upgradeAnimatedShotStyleContract(migrated), migrated)
})

test('schema 132 carries authored illustration layout to the video compositor', () => {
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 131, edges: [{ id: 'kept', from: 'a', to: 'b' }], nodes: [
    { ...node('sanguo-shot-script', 'text'), prompt: 'custom duration-v2 worldState prompt\n- editorialRole、visualTreatment 以及 animated 模式的 animationStyle/animationAesthetic 必须逐字继承当前scene。动画镜头可用于片头、片中、payoff及任意场间衔接，但必须完成本段声画义务，不得只是装饰。character_illustration 和 historical_tableau 使用二维插画口播：audioType=旁白，人物插画内部的姿态、表情、嘴部和衣物从头到尾不变，不承载人物动作、对白或口型表演；允许整个人物插画图层淡入、平移、缩放、淡出并放在合适的历史背景上，historical_tableau 允许整幅定格画面轻微二维移动或渐变；背景事实由画外旁白讲清。其他无人物动画可使用空人物数组，shotIntent.viewpointCharacter固定为“观众”。地名年代必须由旁白清楚说出，不依赖生成画面中的可读文字。' },
    { ...node('sanguo-video', 'video'), modelId: 'user-video', params: [] },
  ] }
  const migrated = upgradeIllustrationLayerLayout(source)
  assert.equal(migrated.schemaVersion, 132)
  assert.match(migrated.nodes[0].prompt, /illustrationLayers/)
  assert.equal(migrated.nodes[1].params.find(item => item.englishName === 'illustrationLayers')?.value, '${shot_script.illustrationLayers}')
  assert.equal(migrated.nodes[1].modelId, 'user-video')
  assert.equal(migrated.edges, source.edges)
  assert.deepEqual(upgradeIllustrationLayerLayout(migrated), migrated)
})

test('schema 135 refreshes saved identity, neutral-pose review, and background routes without replacing selected models', () => {
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 132, edges: [], nodes: [
    { ...node('sanguo-shot-script', 'text'), prompt: 'managed editorialRole visualTreatment character_illustration' },
    { ...node('sanguo-character-lookup', 'code'), code: 'old pose extraction' },
    { ...node('sanguo-character-image', 'image'), params: [{ id: 'generation', name: 'generationPromptTemplate', englishName: 'generationPromptTemplate', type: 'text', required: false, value: 'old pose prompt' }] },
    { ...node('sanguo-character-review', 'text'), prompt: 'old permissive review' },
    { ...node('sanguo-first-frame-branch', 'code'), code: 'old reference route' },
    { ...node('sanguo-animated-map-first-frame', 'image'), modelId: 'selected-image' },
  ] }
  const migrated = upgradeNeutralPortraitAndIllustrationBackground(source)
  assert.equal(migrated.schemaVersion, 135)
  assert.match(String(migrated.nodes[1].code), /action-only clause/)
  assert.match(String(migrated.nodes[2].params[0].value), /双手低于腰部/)
  assert.match(String(migrated.nodes[3].prompt), /手抬到胸口以上/)
  assert.match(String(migrated.nodes[4].code), /backgroundOnlyPrompt/)
  assert.equal(migrated.nodes[5].modelId, 'selected-image')
  assert.equal(migrated.nodes[5].params.find(item => item.englishName === 'referenceImages')?.value, '${first_frame_branch.frameReferenceImages}')
  assert.match(migrated.nodes[5].prompt, /first_frame_branch\.framePrompt/)
  assert.deepEqual(upgradeNeutralPortraitAndIllustrationBackground(migrated), migrated)
})

test('schema 136 repairs a persisted literal-newline regular expression in the managed first-frame branch', () => {
  const brokenCode = 'const frameReferenceImages = []\nconst backgroundOnlyPrompt = visualPrompt.split(/[。！？；;\n]+/)'
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 135, edges: [], nodes: [
    { ...node('sanguo-first-frame-branch', 'code'), code: brokenCode },
    { ...node('custom-code', 'code'), code: brokenCode },
  ] }
  const migrated = upgradeFirstFrameBranchLineSplitting(source)
  const branchCode = String(migrated.nodes[0].code)
  assert.equal(migrated.schemaVersion, 136)
  assert.match(branchCode, /String\.fromCharCode\(10\)/)
  assert.doesNotMatch(branchCode, /split\(\/\[。！？；;\n/)
  assert.equal(migrated.nodes[1].code, brokenCode)
  assert.deepEqual(upgradeFirstFrameBranchLineSplitting(migrated), migrated)
})

test('current saved workflows refresh only managed static-frame scope and preserve custom node configuration', () => {
  const newExpression = /: \[String\(\$\{shot_script\.firstFramePrompt\} \|\| visualPrompt\)\.trim\(\),[\s\S]*?\]\.filter\(Boolean\)\.join\('\\n'\)/
  const oldExpression = ": [visualPrompt, videoPrompt].filter(Boolean).join('\\n')"
  assert.match(SANGUO_FIRST_FRAME_BRANCH_CODE, newExpression)
  const oldCode = SANGUO_FIRST_FRAME_BRANCH_CODE.replace(newExpression, () => oldExpression)
    + '\n// Custom reference auditing remains exact.\n'
  const oldPrompt = ANIMATED_MAP_END_FRAME_PROMPT.replace('构图视角参考：${shot_script.camera}；只参考本镜最终构图，不展示运镜过程。',
    '【本镜动画过程】${shot_script.videoPrompt}') + '\n用户补充的服装材质约束。'
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 144, edges: [], nodes: [
    { ...node('sanguo-first-frame-branch', 'code'), code: oldCode },
    { ...node('sanguo-end-frame', 'image'), prompt: oldPrompt, modelId: 'selected-image-model',
      params: [{ id: 'custom', name: 'custom', type: 'text', required: false, value: 'preserved' }] },
    { ...node('custom-code', 'code'), code: oldCode },
  ] }
  const updated = refreshStaticBoundaryFrameScope(source)
  assert.equal(updated.schemaVersion, 144)
  assert.equal(updated.edges, source.edges)
  assert.equal(updated.nodes[0].code, SANGUO_FIRST_FRAME_BRANCH_CODE + '\n// Custom reference auditing remains exact.\n')
  assert.equal(updated.nodes[1].prompt, ANIMATED_MAP_END_FRAME_PROMPT + '\n用户补充的服装材质约束。')
  assert.equal(updated.nodes[1].modelId, source.nodes[1].modelId)
  assert.equal(updated.nodes[1].params, source.nodes[1].params)
  assert.equal(updated.nodes[1].position, source.nodes[1].position)
  assert.equal(updated.nodes[2], source.nodes[2])
  assert.equal(refreshStaticBoundaryFrameScope(updated), updated, 'idempotent without rewriting authored content')
  assert.equal(refreshStaticBoundaryFrameScope({ ...source, id: 'custom-workflow' }).nodes, source.nodes)
  assert.deepEqual(upgradeQualityWorkflow(source), updated, 'the persisted workflow normalization chain applies the current-schema refresh')

  const runs = [{ node: source.nodes[0], status: 'success' }, { node: source.nodes[1], status: 'failed' },
    { node: source.nodes[2], status: 'idle' }]
  const refreshed = refreshPendingExecutionNodes(updated, runs)
  assert.equal(refreshed[0], runs[0], 'completed branch evidence stays frozen and must be rerun in a retry fork')
  assert.equal(refreshed[1].node, updated.nodes[1])
})

test('target tail frame consumes final visible state and composition while keeping video and audio fields unchanged', () => {
  const shot = { animationStyle: 'historical_map', animationAesthetic: 'cinematic_gongbi', camera: '俯视历史地图沙盘',
    lastFramePrompt: '八州地图边界清晰连结，大方与小方大小标记完整呈现。',
    videoPrompt: '0-3秒：边界逐次浮现。3-8秒：画外旁白朗读历史原文。', audioText: '历史旁白原文。' }
  const before = structuredClone(shot)
  const prompt = renderWorkflowTemplate(ANIMATED_MAP_END_FRAME_PROMPT, { shot_script: shot })
  assert.match(prompt, /八州地图边界清晰连结|大小标记完整呈现|俯视历史地图沙盘/)
  assert.doesNotMatch(prompt, /0-3秒|3-8秒|画外旁白|历史原文|历史旁白原文/)
  assert.deepEqual(shot, before)
})

test('historical map end frame keeps geography, route and portrait placements coherent', () => {
  const prior = ANIMATED_MAP_END_FRAME_PROMPT.replace('\n' + SAND_TABLE_END_FRAME_CONTINUITY, '')
  const refreshed = refreshAnimatedFrameSandTablePrompt(prior)
  assert.equal(refreshed, ANIMATED_MAP_END_FRAME_PROMPT)
  assert.equal(refreshAnimatedFrameSandTablePrompt(refreshed), refreshed)
  assert.equal(refreshAnimatedFrameSandTablePrompt(ANIMATED_MAP_FIRST_FRAME_PROMPT), ANIMATED_MAP_FIRST_FRAME_PROMPT)
  assert.equal(refreshAnimatedFrameSandTablePrompt('【动画镜头目标尾帧】\n导演自定义尾帧，不含受管占位符。'),
    '【动画镜头目标尾帧】\n导演自定义尾帧，不含受管占位符。')
  const shot = { animationStyle: 'historical_map', animationAesthetic: 'historical_cartography', editorialRole: 'episode_opening',
    camera: '固定俯视，长江水道从右下至左上。',
    lastFramePrompt: '同一历史地理底图上，红色路线渐显至当阳；人物静态肖像仍在对应地点。' }
  const rendered = renderWorkflowTemplate(refreshed, { shot_script: shot })
  assert.match(rendered, /同一历史地理底图上，红色路线渐显至当阳/)
  assert.match(rendered, /地理|底图|地图/)
  assert.match(rendered, /禁止实体盘框|禁止.*盘框/)
  assert.doesNotMatch(rendered, /【实体沙盘表达合同|【沙盘首尾帧实物连续性】|旗面、旗杆与载体必须一同移动/)
})

test('persisted managed frame prompts remove old instructions to draw routes and preserve text on the bare map', () => {
  const oldFirst = ANIMATED_MAP_FIRST_FRAME_PROMPT.replace(
    'historical_map 只绘制古代地理底板，路线、地名和人物均留给本地已批准图层',
    'historical_map 强调疆域、路线与区域关系') + '\n导演自定义地理色彩。'
  const first = refreshAnimatedFrameSandTablePrompt(oldFirst)
  assert.match(first, /historical_map 只绘制古代地理底板，路线、地名和人物均留给本地已批准图层/)
  assert.doesNotMatch(first, /historical_map 强调疆域、路线与区域关系/)
  assert.match(first, /导演自定义地理色彩。$/)
  assert.equal(refreshAnimatedFrameSandTablePrompt(first), first)

  const oldEnd = ANIMATED_MAP_END_FRAME_PROMPT
    .replace('以附件中的动画首图为构图基准生成本镜单一 16:9 尾帧；historical_map 只继承同一地理底板，其他动画继续锁定角色身份：${shot_script.lastFramePrompt}',
      '以附件中的动画首图为构图、角色身份和文字基准，生成本镜动作完成后的单一 16:9 尾帧：${shot_script.lastFramePrompt}')
    .replace('historical_map 只保持首图的地理范围、方位、山川、水系、城址、边界和设色连续；不得在地图底片增添文字、路线、箭头或人物。其他动画保持首图的构图体系、美术语言、人物身份、时代服饰以及已有文字的字形、字号、位置和版式稳定，只改变分镜明确要求的动作结果、环境状态、象征物或镜头景别；其他动画不得重绘、改写、增删或移动已有中文；',
      '保持首图的构图体系、美术语言、人物身份、时代服饰以及已有文字的字形、字号、位置和版式稳定，只改变分镜明确要求的动作结果、环境状态、区域高亮、路线进度、象征物或镜头景别。不得重绘、改写、增删或移动任何中文；')
    + '\n导演自定义山川连续性。'
  const end = refreshAnimatedFrameSandTablePrompt(oldEnd)
  assert.match(end, /historical_map 只保持首图的地理范围/)
  assert.doesNotMatch(end, /文字基准|只改变分镜明确要求的动作结果、环境状态、区域高亮、路线进度/)
  assert.match(end, /导演自定义山川连续性。$/)
  assert.equal(refreshAnimatedFrameSandTablePrompt(end), end)
})

test('Kling video request uses generated first and end frames as first-tail mode', () => {
  const model = { id: 'keling3', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3' } }
  const built = buildKlingVideoRequest(model, '地图区域缓慢高亮。', {
    referenceImage: 'https://example.com/kling-first.png',
    endImage: 'https://example.com/kling-end.png',
    aspectRatio: '16:9', duration: 8, mode: 'std', sound: 'on',
  })
  assert.equal(built.image, 'https://example.com/kling-first.png')
  assert.equal(built.image_tail, 'https://example.com/kling-end.png')
  assert.equal('aspect_ratio' in built, false)
})
