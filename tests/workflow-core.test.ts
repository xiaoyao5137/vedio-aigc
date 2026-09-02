import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateLoopOutputs, applyNodeOutputToContext, availableLoopIterations, buildVariableMetadata, canAdvanceStep, containsUnicodeReplacementCharacter, deriveSceneOutlineMetrics, estimateStoryboardTiming, extractTextResponse, findInspectableNodeRunIndex, findLoopSnapshotRunIndex, findNextBreakpointIndex, firstBlockingRunIndex, hasExecutionPlanMismatch, hasRemovedExecutionNodes, missingRequiredParamNames, normalizeStructuredTextOutput, parseStructuredJson, resolveVariableMetadata, scopedLoopNodes, serializedValuesDiffer, shouldRunNode, shouldSkipStep, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

test('unicode replacement characters are detected in persisted workflow text', () => {
  assert.equal(containsUnicodeReplacementCharacter('你是兼具电视剧叙事能力的分镜师'), false)
  assert.equal(containsUnicodeReplacementCharacter('你是兼具电视剧叙事�力的分镜师'), true)
  assert.equal(containsUnicodeReplacementCharacter({ nodes: [{ prompt: '正常' }, { prompt: '人物塑��能力' }] }), true)
})

test('content migrations are detected even when collection lengths do not change', () => {
  const stored = [{ id: 'wf', schemaVersion: 25, nodes: [{ id: 'target-tail' }] }]
  const migrated = [{ id: 'wf', schemaVersion: 26, nodes: [{ id: 'video' }] }]
  assert.equal(stored.length, migrated.length)
  assert.equal(serializedValuesDiffer(stored, migrated), true)
  assert.equal(serializedValuesDiffer(migrated, structuredClone(migrated)), false)
})

test('live execution snapshots detect nodes removed by a workflow migration', () => {
  const workflow = { nodes: [{ id: 'branch', kind: 'code' }, { id: 'video', kind: 'video' }], edges: [{ from: 'branch', to: 'video' }] }
  assert.equal(hasRemovedExecutionNodes(workflow, [{ node: { id: 'branch' } }, { node: { id: 'target-tail' } }]), true)
  assert.equal(hasRemovedExecutionNodes(workflow, [{ node: { id: 'branch' } }, { node: { id: 'video' } }]), false)
})

test('live execution snapshots are invalidated when a required media input is added', () => {
  const current = {
    nodes: [{ id: 'video', kind: 'video', params: [{ name: '目标尾帧', englishName: 'endImage', required: true }] }],
    edges: [],
  }
  const stale = [{ node: { id: 'video', kind: 'video', params: [] } }]
  const matching = [{ node: structuredClone(current.nodes[0]) }]
  assert.equal(hasExecutionPlanMismatch(current, stale), true)
  assert.equal(hasExecutionPlanMismatch(current, matching), false)
})

test('direct retries restart at the earliest unfinished prerequisite', () => {
  const runs = [
    { status: 'success' as const },
    { status: 'skipped' as const },
    { status: 'idle' as const },
    { status: 'success' as const },
    { status: 'idle' as const },
  ]
  assert.equal(firstBlockingRunIndex(runs, 4), 2)
  assert.equal(firstBlockingRunIndex(runs.slice(0, 2), 1), 1)
})

test('required media inputs reject empty resolved values', () => {
  const params = [
    { name: '首帧', englishName: 'referenceImage', required: true },
    { name: '目标尾帧', englishName: 'endImage', required: true },
    { name: '人物参考', englishName: 'referenceImages', required: false },
  ]
  assert.deepEqual(missingRequiredParamNames(params, { referenceImage: '/first.png', endImage: undefined }), ['目标尾帧'])
  assert.deepEqual(missingRequiredParamNames(params, { referenceImage: '/first.png', endImage: '/end.png' }), [])
})

test('single-step debug only advances after the current step succeeds', () => {
  assert.equal(canAdvanceStep('idle', 0, 3), false)
  assert.equal(canAdvanceStep('running', 0, 3), false)
  assert.equal(canAdvanceStep('failed', 0, 3), false)
  assert.equal(canAdvanceStep(undefined, 0, 3), false)
  assert.equal(canAdvanceStep('success', 0, 3), true)
  assert.equal(canAdvanceStep('success', 2, 3), false)
  assert.equal(canAdvanceStep('skipped', 0, 3), true)
  assert.equal(canAdvanceStep('success', -1, 3), false)
})

test('single-step debug finds the next node breakpoint, including repeated loop runs', () => {
  const runs = [
    { node: { id: 'input' } },
    { node: { id: 'shot' } },
    { node: { id: 'video' } },
    { node: { id: 'shot' } },
  ]
  const breakpoints = new Set(['shot'])
  assert.equal(findNextBreakpointIndex(runs, breakpoints, -1), 1)
  assert.equal(findNextBreakpointIndex(runs, breakpoints, 1), 3)
  assert.equal(findNextBreakpointIndex(runs, breakpoints, 3), -1)
})

test('node run conditions select exactly one first-frame branch', () => {
  const generate = { first_frame_branch: { shouldGenerate: true, shouldReusePreviousTail: false } }
  const reuse = { first_frame_branch: { shouldGenerate: false, shouldReusePreviousTail: true } }
  assert.equal(shouldRunNode({ path: 'first_frame_branch.shouldGenerate', equals: true }, generate), true)
  assert.equal(shouldRunNode({ path: 'first_frame_branch.shouldReusePreviousTail', equals: true }, generate), false)
  assert.equal(shouldRunNode({ path: 'first_frame_branch.shouldGenerate', equals: true }, reuse), false)
  assert.equal(shouldRunNode({ path: 'first_frame_branch.shouldReusePreviousTail', equals: true }, reuse), true)
  assert.equal(shouldRunNode(undefined, {}), true)
})

test('single-step routing skips only the idle branch that did not match', () => {
  const generate = { first_frame_branch: { shouldGenerate: true, shouldReusePreviousTail: false } }
  const reuse = { first_frame_branch: { shouldGenerate: false, shouldReusePreviousTail: true } }
  const generateCondition = { path: 'first_frame_branch.shouldGenerate', equals: true }
  const reuseCondition = { path: 'first_frame_branch.shouldReusePreviousTail', equals: true }
  assert.equal(shouldSkipStep('idle', generateCondition, generate), false)
  assert.equal(shouldSkipStep('idle', reuseCondition, generate), true)
  assert.equal(shouldSkipStep('idle', generateCondition, reuse), true)
  assert.equal(shouldSkipStep('idle', reuseCondition, reuse), false)
  assert.equal(shouldSkipStep('success', reuseCondition, generate), false)
  assert.equal(shouldSkipStep('idle', undefined, generate), false)
})

test('explicit loop children do not swallow final downstream nodes', () => {
  const nodes = [
    { id: 'loop', kind: 'loop', childIds: ['shot', 'video'] },
    { id: 'shot', kind: 'text', parentId: 'loop' },
    { id: 'video', kind: 'video', parentId: 'loop' },
    { id: 'verify', kind: 'validation' },
    { id: 'compose', kind: 'compose' },
  ]
  const workflow = {
    nodes,
    edges: [
      { from: 'loop', to: 'shot' },
      { from: 'shot', to: 'video' },
      { from: 'video', to: 'verify' },
      { from: 'verify', to: 'compose' },
    ],
  }
  assert.deepEqual(scopedLoopNodes(workflow, 'loop', nodes).map((node) => node.id), ['shot', 'video'])
})

test('legacy loop still scopes all downstream nodes', () => {
  const nodes = [{ id: 'loop', kind: 'loop' }, { id: 'image', kind: 'image' }, { id: 'video', kind: 'video' }]
  const workflow = { nodes, edges: [{ from: 'loop', to: 'image' }, { from: 'image', to: 'video' }] }
  assert.deepEqual(scopedLoopNodes(workflow, 'loop', nodes).map((node) => node.id), ['image', 'video'])
})

test('structured output accepts fenced objects and preserves legacy shots alias', () => {
  const parsed = parseStructuredJson('```json\n{"scenes":[{"id":"s1"}]}\n```')
  assert.deepEqual(parsed, { scenes: [{ id: 's1' }] })
  const output = normalizeStructuredTextOutput('[{"id":"shot-1"}]', '[{"id":"shot-1"}]')
  assert.deepEqual(output.shots, [{ id: 'shot-1' }])
  assert.deepEqual(output.items, output.shots)
})

test('structured output repairs literal quotes inside model-generated JSON strings', () => {
  const modelText = `\`\`\`json
{
  "episodeTitle": "符水与饥民",
  "scenes": [{
    "id": "scene-01",
    "sequence": 1,
    "title": "跪拜符水",
    "purpose": "张角自称"大贤良师"，并以"善道"教化天下",
    "historicalBasis": "[史料1] 讹言"苍天已死，黄天当立，岁在甲子，天下大吉"",
    "adaptationBoundary": "对白与仪式细节为合理拟制",
    "targetDuration": 10,
    "continuityFromPrevious": false
  }]
}
\`\`\``
  const parsed = parseStructuredJson(modelText) as Record<string, unknown>
  const scenes = parsed.scenes as Array<Record<string, unknown>>

  assert.equal(scenes[0].purpose, '张角自称"大贤良师"，并以"善道"教化天下')
  assert.equal(scenes[0].historicalBasis, '[史料1] 讹言"苍天已死，黄天当立，岁在甲子，天下大吉"')
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.scene-outline', parsed))
})

test('structured output does not mistake a prose comma after a literal quote for JSON punctuation', () => {
  const modelText = `\`\`\`json
{
  "episodeTitle": "甘陵党议",
  "scenes": [{
    "id": "scene-01",
    "sequence": 1,
    "title": "郡中舆论发酵",
    "purpose": "人群中有人高呼"党人何罪",县令面对民意压力，并质问"何罪之有",随后当场表态",
    "historicalBasis": "[史料4] 党锢传载党人被捕",
    "adaptationBoundary": "具体呼声为戏剧化处理",
    "targetDuration": 10,
    "continuityFromPrevious": false
  }]
}
\`\`\``
  const parsed = parseStructuredJson(modelText) as Record<string, unknown>
  const scenes = parsed.scenes as Array<Record<string, unknown>>

  assert.equal(scenes[0].purpose, '人群中有人高呼"党人何罪",县令面对民意压力，并质问"何罪之有",随后当场表态')
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.scene-outline', parsed))
})

test('structured output parses extracted model text before the provider response envelope', () => {
  const scene = {
    id: 'scene-01', sequence: 1, title: '入局', purpose: '张角入村', historicalBasis: '[史料1] 张角传道',
    adaptationBoundary: '村落细节为拟制', targetDuration: 8, continuityFromPrevious: false,
  }
  const modelText = JSON.stringify({ episodeTitle: '符水与饥民', scenes: [scene] })
  const anthropicEnvelope = {
    id: 'msg_01', type: 'message', role: 'assistant', content: [{ type: 'text', text: modelText }],
    model: 'claude-opus-4-8', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 200 },
  }

  const normalized = normalizeStructuredTextOutput(anthropicEnvelope, modelText, 'json')
  const validated = validateHistoricalStructuredOutput('history.scene-outline', normalized) as Record<string, unknown>

  assert.equal(validated.episodeTitle, '符水与饥民')
  assert.equal(validated.count, 1)
  assert.equal(validated.totalDuration, 15)
  assert.deepEqual(validated.raw, anthropicEnvelope)
})

test('structured output unwraps provider content strings without validating the response envelope', () => {
  const scene = {
    id: 'scene-01', sequence: 1, title: '入局', purpose: '张角入村', historicalBasis: '[史料1] 张角传道',
    adaptationBoundary: '村落细节为拟制', targetDuration: 8, continuityFromPrevious: false,
  }
  const modelText = `\`\`\`json\n${JSON.stringify({ episodeTitle: '符水与饥民', scenes: [scene] })}\n\`\`\``
  const proxyEnvelope = {
    id: 'msg_02', type: 'message', role: 'assistant', content: modelText,
    model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { output_tokens: 100 },
  }

  const extracted = extractTextResponse(proxyEnvelope)
  const normalized = normalizeStructuredTextOutput(proxyEnvelope, extracted, 'json')
  const validated = validateHistoricalStructuredOutput('history.scene-outline', normalized) as Record<string, unknown>

  assert.equal(validated.episodeTitle, '符水与饥民')
  assert.equal(validated.count, 1)
})

test('structured output reports truncated provider text instead of treating envelope fields as business fields', () => {
  const truncatedEnvelope = {
    id: 'msg_03', type: 'message', role: 'assistant', content: [{ type: 'text', text: '{"episodeTitle":"符水与饥民","scenes":[' }],
    model: 'claude-opus-4-8', stop_reason: 'max_tokens', stop_sequence: null, usage: { output_tokens: 4096 },
  }

  assert.throws(
    () => normalizeStructuredTextOutput(truncatedEnvelope, extractTextResponse(truncatedEnvelope), 'json'),
    /输出因 max_tokens 被截断，未形成有效 JSON/,
  )
})

test('structured output still accepts a direct JSON response when extracted text is not JSON', () => {
  const direct = { episodeTitle: '符水与饥民', scenes: [] }
  const normalized = normalizeStructuredTextOutput(direct, 'not-json', 'json')
  assert.equal(normalized.episodeTitle, direct.episodeTitle)
  assert.deepEqual(normalized.scenes, [])
})

test('historical JSON contracts derive scene count and duration from the generated outline', () => {
  const scene = {
    id: 'scene-01', sequence: 1, title: '入局', purpose: '张角入村', historicalBasis: '[史料1] 张角传道',
    adaptationBoundary: '村落细节为拟制', targetDuration: 8, continuityFromPrevious: false,
  }
  const generated = {
    episodeTitle: '符水与饥民', count: 99, totalDuration: 999, scenes: [scene, { ...scene, id: 'scene-02', sequence: 2, targetDuration: 15, continuityFromPrevious: true }],
  }
  const normalized = deriveSceneOutlineMetrics(generated)
  assert.equal(normalized.count, 2)
  assert.equal(normalized.totalDuration, 30)
  assert.deepEqual((normalized.scenes as Array<Record<string, unknown>>).map((item) => item.targetDuration), [15, 15])
  const validated = validateHistoricalStructuredOutput('history.scene-outline', normalized)
  assert.equal((validated as Record<string, unknown>).count, 2)
  assert.equal((validated as Record<string, unknown>).totalDuration, 30)
  for (const modelDuration of [6, 16, 8.5]) {
    const fixed = validateHistoricalStructuredOutput('history.scene-outline', {
      episodeTitle: '符水与饥民', scenes: [{ ...scene, targetDuration: modelDuration }],
    }) as Record<string, unknown>
    assert.equal(((fixed.scenes as Array<Record<string, unknown>>)[0]).targetDuration, 15)
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '符水与饥民', scenes: [{ ...scene, note: '不在契约中' }],
  }), /未声明字段：note/)
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '符水与饥民', scenes: [],
  }), /至少需要一个场景/)

  const storyboard = {
    id: 'scene-01', title: '入局', duration: 8, characters: ['张角'], visualPrompt: '竖屏真人实景', camera: '50mm推进', mood: '克制',
    firstFrameMode: 'reference', lastFramePrompt: '结束构图', videoPrompt: '缓慢推进', audioType: '旁白',
    audioText: '百姓等待救济', historicalBasis: '[史料1] 张角传道', adaptationBoundary: '对白拟制',
  }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }))
  const normalizedStoryboard = validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }) as Record<string, unknown>
  assert.match(String(normalizedStoryboard.lastFramePrompt), /【静态尾帧】/)
  assert.match(String(normalizedStoryboard.lastFramePrompt), /上下三段/)
  assert.match(String(normalizedStoryboard.lastFramePrompt), /任何可读文字/)
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', { ...storyboard, duration: 15 }, { scene: { ...scene, targetDuration: 15 } }))
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...storyboard, duration: 7 }, { scene: { ...scene, targetDuration: 7 } }), /8 到 15 之间的整数/)
  const normalizedAmbientNarration = validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    audioType: '旁白+环境音',
  }, { scene }) as Record<string, unknown>
  assert.equal(normalizedAmbientNarration.audioType, '旁白')
  const normalizedActionDialogue = validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    audioType: '对白／动作音',
  }, { scene }) as Record<string, unknown>
  assert.equal(normalizedActionDialogue.audioType, '对白')
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    audioType: '旁白+对白',
  }, { scene }), /audioType 只能是旁白或对白/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    audioType: '环境音',
  }, { scene }), /audioType 只能是旁白或对白/)
  const repairedStoryboard = validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    historicalBasis: '',
    adaptationBoundary: '',
  }, { scene }) as Record<string, unknown>
  assert.equal(repairedStoryboard.historicalBasis, scene.historicalBasis)
  assert.equal(repairedStoryboard.adaptationBoundary, scene.adaptationBoundary)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    historicalBasis: '',
  }, { scene: { ...scene, historicalBasis: '' } }), /historicalBasis 必须是非空字符串/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...storyboard, firstFrameMode: 'reuse_previous_tail' }, { scene }), /非连续镜头/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...storyboard, shots: [] }, { scene }), /未声明字段：shots/)
})

test('storyboard timing keeps every valid shot at the fixed 15-second duration', () => {
  const timing = estimateStoryboardTiming(
    '求评者：劭公，我家三代盐铁，求公一评。\n许劭：家资非才望。月旦评人品行，不评财货。',
    '许劭沉默两秒后回答，求评者起身，最后稳定停在许劭面部。',
  )
  assert.equal(timing.explicitPauseSeconds, 2)
  assert.equal(timing.requiredDuration, 14)

  const scene = { targetDuration: 12, continuityFromPrevious: false, historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制' }
  const storyboard = {
    id: 'scene-01', title: '月旦评', duration: 12, characters: ['许劭'], visualPrompt: '竖屏真人实景', camera: '推至面部', mood: '克制',
    firstFrameMode: 'reference', lastFramePrompt: '许劭面部特写',
    videoPrompt: '许劭沉默两秒后回答，求评者起身，最后稳定停在许劭面部。', audioType: '对白',
    audioText: '求评者：劭公，我家三代盐铁，求公一评。\n许劭：家资非才望。月旦评人品行，不评财货。',
    historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制',
  }
  const validated = validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }) as Record<string, unknown>
  assert.equal(validated.duration, 15)
  assert.equal((validated.timingEstimate as Record<string, unknown>).plannedDuration, 12)
})

test('storyboard timing rejects the latest Xu Shao script instead of forcing rushed speech', () => {
  const longDialogue = '求评者：劭公，在下家中三代经营盐铁，今求一评，望劭公不吝赐教。\n许劭：足下家资虽厚，然不过贩夫之利。月旦评所评者，乃天下士人之品行才望，非富即可入品。'
  const base = {
    id: 'scene-01', title: '月旦评', duration: 12, characters: ['许劭'], visualPrompt: '竖屏真人实景', camera: '推至面部', mood: '克制',
    firstFrameMode: 'reference', lastFramePrompt: '许劭面部特写',
    videoPrompt: '许劭沉默三秒后回答，求评者起身离去，最后定格许劭面部。', audioType: '对白', audioText: longDialogue,
    historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制',
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', base, {
    scene: { targetDuration: 12, continuityFromPrevious: false, historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制' },
  }), /STORYBOARD_TIMING_OVERFLOW/)
})

test('loop output aggregation exposes items and count per result variable', () => {
  const aggregated = aggregateLoopOutputs([{ shot: { id: 1 }, video: { id: 'v1' } }, { shot: { id: 2 }, video: { id: 'v2' } }])
  assert.equal(aggregated.shot.count, 2)
  assert.deepEqual(aggregated.video.items, [{ id: 'v1' }, { id: 'v2' }])
})

test('loop snapshot navigation exposes started rounds and preserves the selected child node', () => {
  const runs = [
    { node: { id: 'shot' }, loopGroupId: 'loop-a', loopIndex: 0, status: 'success' as const },
    { node: { id: 'video' }, loopGroupId: 'loop-a', loopIndex: 0, status: 'success' as const },
    { node: { id: 'shot' }, loopGroupId: 'loop-a', loopIndex: 1, status: 'running' as const },
    { node: { id: 'video' }, loopGroupId: 'loop-a', loopIndex: 1, status: 'idle' as const },
    { node: { id: 'shot' }, loopGroupId: 'loop-a', loopIndex: 2, status: 'idle' as const },
  ]

  assert.deepEqual(availableLoopIterations(runs, 'loop-a'), [0, 1])
  assert.equal(findLoopSnapshotRunIndex(runs, 'loop-a', 0, 'video'), 1)
  assert.equal(findLoopSnapshotRunIndex(runs, 'loop-a', 1, 'video'), 2)
  assert.equal(findLoopSnapshotRunIndex(runs, 'missing', 0, 'shot'), -1)
})

test('node inspection leaves the loop snapshot when clicking a node outside the loop', () => {
  const runs = [
    { node: { id: 'before-loop' }, status: 'success' as const },
    { node: { id: 'shot' }, loopGroupId: 'loop-a', loopIndex: 0, status: 'success' as const },
    { node: { id: 'shot' }, loopGroupId: 'loop-a', loopIndex: 1, status: 'running' as const },
    { node: { id: 'after-loop' }, status: 'idle' as const },
  ]

  assert.equal(findInspectableNodeRunIndex(runs, 'shot', 2, 'loop-a', 0), 1)
  assert.equal(findInspectableNodeRunIndex(runs, 'before-loop', 0, 'loop-a', 1), 0)
  assert.equal(findInspectableNodeRunIndex(runs, 'after-loop', 3, 'loop-a', 1), 3)
})

test('variable metadata exposes Chinese names and tracks runtime producer nodes', () => {
  const inputNode = {
    id: 'input-node', kind: 'input', title: '项目输入', resultVar: 'input',
    params: [{ name: '集数', englishName: 'episode_number', value: '41' }],
  }
  const contextNode = {
    id: 'context-node', kind: 'code', title: '剧集上下文初始化', resultVar: 'episode_context', params: [],
  }
  const outlineNode = {
    id: 'outline-node', kind: 'text', title: '场景大纲', resultVar: 'scene_outline',
    params: [{ name: '集名', englishName: 'episodeTitle', value: '${input.episode_title}' }],
  }
  const metadata = buildVariableMetadata([inputNode, contextNode, outlineNode], [
    { node: inputNode, status: 'success', output: { episode_number: 41 } },
    {
      node: contextNode,
      status: 'success',
      output: { fields: { episode_title: '符水与饥民' }, contextPatch: { input: { episode_title: '符水与饥民' } } },
    },
    { node: outlineNode, status: 'success', output: { scenes: [] } },
  ])

  assert.deepEqual(resolveVariableMetadata(metadata, ['input', 'episode_number']), {
    nodeId: 'input-node', nodeTitle: '项目输入', chineseName: '集数',
  })
  assert.deepEqual(resolveVariableMetadata(metadata, ['input', 'episode_title']), {
    nodeId: 'context-node', nodeTitle: '剧集上下文初始化', chineseName: '集名',
  })
  assert.deepEqual(resolveVariableMetadata(metadata, ['scene_outline']), {
    nodeId: 'outline-node', nodeTitle: '场景大纲', chineseName: '场景大纲',
  })
  assert.deepEqual(resolveVariableMetadata(metadata, ['scene_outline', 'scenes', '0']), {
    nodeId: 'outline-node', nodeTitle: '场景大纲',
  })
})

test('code node context patches merge nested input values and retain the node output', () => {
  const output = {
    fields: { episode_number: 41, episode_title: '符水与饥民' },
    contextPatch: { input: { episode_number: 41, episode_title: '符水与饥民' } },
  }
  const context = applyNodeOutputToContext({ input: { episode_number: 41 }, prior: true }, 'episode_context', output)
  assert.deepEqual(context.input, { episode_number: 41, episode_title: '符水与饥民' })
  assert.equal(context.prior, true)
  assert.equal(context.episode_context, output)
})
