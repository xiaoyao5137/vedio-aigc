import test from 'node:test'
import assert from 'node:assert/strict'
import { ANIMATION_AESTHETICS } from '../src/animation-shot.ts'
import { LEGACY_SAND_TABLE_CONTRACT_PROMPT, SAND_TABLE_CONTRACT_PROMPT, SANGUO_SAND_TABLE_WRITING_PROMPT,
  isHistoricalSandTable, normalizeSandTableAesthetic } from '../src/sand-table-contract.ts'
import { SANGUO_SCENE_OUTLINE_PROMPT, refreshSceneOutlineSandTablePrompt } from '../src/scene-outline-prompt.ts'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT, refreshStoryboardSandTablePrompt } from '../src/storyboard-prompt.ts'
import { ANIMATED_MAP_FIRST_FRAME_PROMPT, ANIMATED_MAP_END_FRAME_PROMPT, SAND_TABLE_END_FRAME_CONTINUITY,
  refreshAnimatedFrameSandTablePrompt } from '../src/animated-map-frames.ts'
import { EDITORIAL_VIDEO_PROMPT } from '../src/quality-node-presets.ts'
import { renderVideoProviderPrompt, SAND_TABLE_VIDEO_MOTION_PROMPT } from '../src/video-provider-prompt.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'
import { upgradeSandTableWorkflow } from '../src/sand-table-workflow.ts'

const map = { visualTreatment: 'animated', animationStyle: 'historical_map', animationAesthetic: 'historical_cartography', editorialRole: 'episode_opening' }
const timing = '0至4秒：历史地理地图显示当阳与长坂的相对位置。4至8秒：沿已批准路线渐显进军轨迹，终点与史实旁白一致。'
const params = { ...map, duration: 8, pacingVersion: 'duration-v2', audioType: '环境声', audioText: '', sound: 'on',
  characterVoices: [], characters: [], referenceImage: '/sand-first.png', endImage: '/sand-last.png' }
const oldWritingPrompt = `本系列仅在 visualTreatment=animated/animated_map、animationStyle=historical_map 且 editorialRole=episode_opening/context_bridge/payoff 的历史地图信息镜头使用下列合同，其他人物和环境叙事继续真人实景；不把自定义的非串联动画强改成沙盘。此类新计划的 animationAesthetic 使用 physical_sand_table；旧 cinematic_gongbi 标签只作兼容，不能把实体沙盘画成平面工笔。${LEGACY_SAND_TABLE_CONTRACT_PROMPT}大纲 observable.visual/mustShow 与分镜 visualPrompt/videoPrompt/lastFramePrompt 写出本段具体地形、势力模型的区别、相对位置和路线变化，不以“地图解释局势”或大箭头标签代替可见内容。首帧呈现运动前的实体盘面，尾帧呈现同一盘面上的真实预期结果；光线、盘框、尺度、阵营样式和地理朝向保持一致。`
const oldFrameScope = `仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时：${LEGACY_SAND_TABLE_CONTRACT_PROMPT}此时上述通用插画与文字字形规则不能改变实体沙盘质感或允许沙盘文字。首尾帧各是同一盘面一个静态时刻，不在单张图里绘制运动残影、连续步骤或多个时刻；微缩旗队不是具名人物演员。`
const oldEndContinuity = '【沙盘首尾帧实物连续性】仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时，把附件首帧中可见的盘框、地形、水道、城池、桥舟、营垒、微缩兵偶、旗杆和旗面逐件视为同一批实体道具。尾帧保留未被本镜明确移除的每件道具及其材质、形状、颜色、尺度、阵营和连接关系；只让分镜明确指定的实体沿指定路线改变位置，未指定移动的道具留在原位。旗标若附着于兵队或舟船，旗面、旗杆与载体必须一同移动；兵偶和舟船不能被凭空擦除，旗帜不能悬空或变成城牌、路牌，阵营颜色不能互换。尾帧必须能辨认移动后的完整实体及未移动的实体，不能只留下孤立旗标；只有分镜明确要求撤离、毁损或移除时才改变这些实体。'
const prompt = () => renderWorkflowTemplate(EDITORIAL_VIDEO_PROMPT, { shot_script: { ...params,
  visualPrompt: '古代历史地理地图显示当阳与长坂、山川道路及双方位置，纸本文献视觉质感。',
  videoPrompt: timing, lastFramePrompt: '同一地理底图上路线已经延伸到长坂，地点和势力关系仍可辨。', camera: '固定俯视，地图缓慢推进' } })

test('historical cartography plans normalize legacy aesthetics without modifying events or unrelated custom animation', () => {
  assert.ok((ANIMATION_AESTHETICS as readonly string[]).includes('historical_cartography'))
  for (const editorialRole of ['episode_opening', 'context_bridge', 'payoff']) {
    for (const oldAesthetic of ['physical_sand_table', 'cinematic_gongbi', 'ink_wash']) {
      const source = { ...map, editorialRole, animationAesthetic: oldAesthetic, audioText: '原始旁白全文。',
        requiredBeats: [{ id: 'source-beat', description: '原始史事', mustShow: ['原事件的空间关系'] }] }
      const before = structuredClone(source), normalized = normalizeSandTableAesthetic(source)
      assert.equal(normalized.animationAesthetic, 'historical_cartography')
      assert.equal(normalized.requiredBeats, source.requiredBeats)
      assert.equal(normalized.audioText, source.audioText)
      assert.deepEqual(source, before)
      assert.equal(normalizeSandTableAesthetic(normalized), normalized)
    }
  }
  const legacy = { ...map, visualTreatment: 'animated_map', animationStyle: undefined, animationAesthetic: undefined }
  assert.deepEqual(normalizeSandTableAesthetic(legacy), map)
  for (const source of [{ ...map, editorialRole: 'story' }, { ...map, visualTreatment: 'live_action' },
    { ...map, animationStyle: 'symbolic_transition', animationAesthetic: 'ink_wash' },
    { ...map, animationStyle: 'character_illustration' }, { ...map, animationAesthetic: 'unknown-custom-value' }]) {
    assert.equal(normalizeSandTableAesthetic(source), source)
  }
  assert.equal(isHistoricalSandTable({ ...map, editorialRole: 'story' }), false)
})

test('outline, storyboard and static boundary prompts share one historical map contract and managed refreshes are idempotent', () => {
  assert.match(SAND_TABLE_CONTRACT_PROMPT, /historical-cartography-v1/)
  assert.doesNotMatch(SAND_TABLE_CONTRACT_PROMPT, /physical-sand-table-v1|可见低矮盘框|微缩兵偶、舟船、旗杆/)
  assert.match(SAND_TABLE_CONTRACT_PROMPT, /禁止实体盘框|禁止.*盘框/)
  for (const [source, refresh] of [[SANGUO_SCENE_OUTLINE_PROMPT, refreshSceneOutlineSandTablePrompt],
    [SANGUO_CINEMATIC_STORYBOARD_PROMPT, refreshStoryboardSandTablePrompt],
    [ANIMATED_MAP_FIRST_FRAME_PROMPT, refreshAnimatedFrameSandTablePrompt],
    [ANIMATED_MAP_END_FRAME_PROMPT, refreshAnimatedFrameSandTablePrompt]] as const) {
    assert.ok(source.includes(SAND_TABLE_CONTRACT_PROMPT))
    assert.equal(refresh(source), source)
    assert.equal(refresh('用户自定义的非串联动画'), '用户自定义的非串联动画')
    const without = source.split('\n').filter(line => !line.includes(SAND_TABLE_CONTRACT_PROMPT)).join('\n')
    const wrapped = '导演自定义前言\n' + without + '\n导演自定义结语'
    // Frame templates have an exact leading header; arbitrary prefixes cannot
    // masquerade as their managed provenance. Writers preserve user wrappers.
    const candidate = refresh === refreshAnimatedFrameSandTablePrompt ? without : wrapped
    const next = refresh(candidate)
    assert.ok(next.includes(SAND_TABLE_CONTRACT_PROMPT))
    assert.equal(refresh(next), next)
    if (refresh !== refreshAnimatedFrameSandTablePrompt) {
      assert.ok(next.startsWith('导演自定义前言\n'))
      assert.ok(next.endsWith('\n导演自定义结语'))
    }
  }
  assert.ok(SANGUO_SCENE_OUTLINE_PROMPT.includes('"animationAesthetic":"historical_cartography"'))
  assert.ok(ANIMATED_MAP_FIRST_FRAME_PROMPT.includes('一个静态时刻'))
  assert.ok(ANIMATED_MAP_END_FRAME_PROMPT.includes('一个静态时刻'))
  assert.ok(!ANIMATED_MAP_END_FRAME_PROMPT.includes('${shot_script.videoPrompt}'))
})

test('persisted physical-map prompts migrate precisely without carrying toy instructions into the new request', () => {
  const nodes = [
    { id: 'sanguo-scene-outline', kind: 'text', source: SANGUO_SCENE_OUTLINE_PROMPT, refresh: refreshSceneOutlineSandTablePrompt },
    { id: 'sanguo-shot-script', kind: 'text', source: SANGUO_CINEMATIC_STORYBOARD_PROMPT, refresh: refreshStoryboardSandTablePrompt },
    { id: 'sanguo-animated-map-first-frame', kind: 'image', source: ANIMATED_MAP_FIRST_FRAME_PROMPT, refresh: refreshAnimatedFrameSandTablePrompt },
    { id: 'sanguo-end-frame', kind: 'image', source: ANIMATED_MAP_END_FRAME_PROMPT, refresh: refreshAnimatedFrameSandTablePrompt },
  ]
  const persisted = nodes.map((node, index) => ({ id: node.id, kind: node.kind,
    prompt: (node.kind === 'text'
      ? node.source.replace(SANGUO_SAND_TABLE_WRITING_PROMPT, oldWritingPrompt)
      : node.source.replace(node.source.split('\n').find(line => line.includes(SAND_TABLE_CONTRACT_PROMPT))!, oldFrameScope)
        .replace(SAND_TABLE_END_FRAME_CONTINUITY, oldEndContinuity)) + '\n导演保留备注' + index,
    modelId: 'untouched-model-' + index }))
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 150, nodes: persisted,
    edges: [{ id: 'preserved-edge', from: persisted[0].id, to: persisted[1].id }],
    frozenExecutions: [{ id: 'paid', mediaUrl: '/generated/existing-paid.mp4' }] }
  const next = upgradeSandTableWorkflow(source)
  assert.equal(next.schemaVersion, 151)
  assert.equal(next.edges, source.edges)
  assert.equal(next.frozenExecutions, source.frozenExecutions)
  next.nodes.forEach((node, index) => {
    assert.equal(node.modelId, persisted[index].modelId)
    assert.ok(node.prompt.includes('导演保留备注' + index))
    assert.equal(node.prompt.split(SAND_TABLE_CONTRACT_PROMPT).length, 2, node.id)
    assert.doesNotMatch(node.prompt, /实体沙盘表达合同 physical-sand-table-v1|可见低矮盘框|不能改变实体沙盘质感|微缩旗队不是具名人物演员|旗面、旗杆与载体必须一同移动/)
    assert.equal(nodes[index].refresh(node.prompt), node.prompt)
  })
  assert.equal(upgradeSandTableWorkflow(next), next)
  assert.deepEqual(source.nodes, persisted)
})

test('ambiguous author edited physical wording is not silently appended to a conflicting map contract', () => {
  const hybrid = SANGUO_SCENE_OUTLINE_PROMPT.replace(SAND_TABLE_CONTRACT_PROMPT, LEGACY_SAND_TABLE_CONTRACT_PROMPT)
  assert.equal(refreshSceneOutlineSandTablePrompt(hybrid), hybrid)
})

test('cartography refresh preserves models, parameters, graph, custom prompts and old workflow objects', () => {
  const beforeContract = (source: string) => source.split('\n').filter(line => !line.includes(SAND_TABLE_CONTRACT_PROMPT)).join('\n')
  const nodes = [
    { id: 'sanguo-scene-outline', kind: 'text', prompt: beforeContract(SANGUO_SCENE_OUTLINE_PROMPT) },
    { id: 'sanguo-shot-script', kind: 'text', prompt: beforeContract(SANGUO_CINEMATIC_STORYBOARD_PROMPT) },
    { id: 'sanguo-animated-map-first-frame', kind: 'image', prompt: beforeContract(ANIMATED_MAP_FIRST_FRAME_PROMPT) },
    { id: 'sanguo-end-frame', kind: 'image', prompt: beforeContract(ANIMATED_MAP_END_FRAME_PROMPT) },
    { id: 'sanguo-video', kind: 'video', prompt: EDITORIAL_VIDEO_PROMPT },
    { id: 'author-custom-animation', kind: 'image', prompt: '作者专用纸上水墨动画，不作串联' },
  ].map((node, index) => ({ ...node, modelId: 'configured-model-' + index, operation: 'unchanged-operation',
    params: [{ id: 'voice', name: 'originalVoice', value: 'existing-original-voice' }],
    runIf: { path: 'original.branch', equals: true }, code: 'return originalPayload;' }))
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 147, nodes,
    edges: [{ id: 'stable-edge', from: nodes[0].id, to: nodes[1].id }],
    frozenExecutions: [{ id: 'prior', output: { animationAesthetic: 'physical_sand_table', mediaUrl: '/original-paid.mp4' } }] }
  const before = structuredClone(source), updated = upgradeSandTableWorkflow(source)
  assert.ok(updated.schemaVersion >= 149)
  assert.equal(updated.edges, source.edges)
  assert.equal(updated.frozenExecutions, source.frozenExecutions)
  assert.equal(updated.nodes.length, source.nodes.length)
  updated.nodes.forEach((node, index) => {
    assert.equal(node.modelId, source.nodes[index].modelId)
    assert.equal(node.params, source.nodes[index].params)
    assert.equal(node.operation, source.nodes[index].operation)
    assert.equal(node.runIf, source.nodes[index].runIf)
    assert.equal(node.code, source.nodes[index].code)
    if (index < 4) assert.ok(node.prompt.includes(SAND_TABLE_CONTRACT_PROMPT))
    else assert.equal(node, source.nodes[index])
  })
  assert.equal(upgradeSandTableWorkflow(updated), updated)
  assert.deepEqual(source, before)
  assert.equal(upgradeSandTableWorkflow({ ...source, id: 'custom-workflow' }).nodes, source.nodes)
  assert.equal(upgradeSandTableWorkflow({ ...source, schemaVersion: 146 }).nodes, source.nodes)
  const custom = { ...source, nodes: source.nodes.map(node => ({ ...node, prompt: '完全自定义的非串联动画' })) }
  assert.equal(upgradeSandTableWorkflow(custom), custom)
})

test('current-schema map migration updates only managed end-frame continuity rule', () => {
  const prior = ANIMATED_MAP_END_FRAME_PROMPT.replace('\n' + SAND_TABLE_END_FRAME_CONTINUITY, '')
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 150,
    nodes: [
      { id: 'sanguo-animated-map-first-frame', kind: 'image', prompt: ANIMATED_MAP_FIRST_FRAME_PROMPT, modelId: 'kept-first' },
      { id: 'sanguo-end-frame', kind: 'image', prompt: prior + '\n导演补充：光照由左侧射入。', modelId: 'kept-end' },
      { id: 'sanguo-video', kind: 'video', prompt: EDITORIAL_VIDEO_PROMPT, modelId: 'kept-video' },
    ], edges: [{ id: 'saved-edge', from: 'sanguo-end-frame', to: 'sanguo-video' }],
    executionHistory: [{ id: 'existing-paid-video' }] }
  const updated = upgradeSandTableWorkflow(source)
  assert.equal(updated.schemaVersion, 151)
  assert.equal(updated.nodes[0], source.nodes[0])
  assert.equal(updated.nodes[2], source.nodes[2])
  assert.equal(updated.nodes[1].prompt, ANIMATED_MAP_END_FRAME_PROMPT + '\n导演补充：光照由左侧射入。')
  assert.equal(updated.nodes[1].modelId, source.nodes[1].modelId)
  assert.equal(updated.edges, source.edges)
  assert.equal(updated.executionHistory, source.executionHistory)
  assert.equal(upgradeSandTableWorkflow(updated), updated)
})

test('provider replaces only known managed map rule, retaining every authored line and original prompt budget', () => {
  const source = prompt(), rendered = renderVideoProviderPrompt(source, params)
  assert.ok(rendered.includes('【视觉处理硬约束】' + SAND_TABLE_VIDEO_MOTION_PROMPT))
  assert.match(rendered, /历史地理|古代地图|地图底图/)
  assert.match(rendered, /路线/)
  assert.doesNotMatch(rendered, /低矮盘框|砂土颗粒|微缩兵偶|微缩沙盘/)
  assert.ok(rendered.includes(timing))
  for (const line of source.split('\n').filter(line => !line.startsWith('【视觉处理硬约束】'))) assert.ok(rendered.includes(line))
  const model = { id: 'offline', name: 'offline', capability: 'video', provider: 'Kling', settings: { model: 'kling-v3-omni', mode: 'std', sound: 'on' } } as Parameters<typeof buildKlingVideoRequest>[0]
  const request = buildKlingVideoRequest(model, source, params)
  assert.ok(String(request.prompt).includes(SAND_TABLE_VIDEO_MOTION_PROMPT))
  assert.ok(String(request.prompt).includes(timing))
  assert.ok(Array.from(String(request.prompt)).length <= 2500)
  assert.throws(() => buildKlingVideoRequest(model, source + '\n' + '完整原事件不能截断。'.repeat(300), params), /STORYBOARD_PROMPT_OVERLOAD/)
  const unknown = source.replace('【视觉处理硬约束】', '【作者自定义视觉要求】')
  assert.equal(renderVideoProviderPrompt(unknown, params), unknown)
  for (const changed of [{ ...params, editorialRole: 'story' }, { ...params, animationStyle: 'time_montage' },
    { ...params, pacingVersion: 'unvalidated-version' }, { ...params, editorialRole: 'payoff' }]) {
    assert.equal(renderVideoProviderPrompt(source, changed), source)
  }
})

test('independent narration picture projection retains physical map grammar without weakening custom/spoofed routes', () => {
  const footer = '【独立画外配音】本次仅生成画面和与场景相符的自然环境音。旁白将在后期添加，本次不得生成任何可辨词语或配音；画内人物不朗读、不作说话口型，保留已批准的动作、视线、呼吸和微动。'
  const source = prompt() + '\n' + footer
  const independent = { ...params, pacingVersion: 'independent-narration-v1' }
  const rendered = renderVideoProviderPrompt(source, independent)
  assert.ok(rendered.includes(SAND_TABLE_VIDEO_MOTION_PROMPT))
  assert.ok(rendered.endsWith(footer))
  assert.equal(renderVideoProviderPrompt(prompt(), independent), prompt())
  assert.equal(renderVideoProviderPrompt(source, { ...independent, sound: 'off' }), source)
})
