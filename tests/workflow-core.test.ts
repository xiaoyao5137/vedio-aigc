import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateLoopOutputs, applyNodeOutputToContext, buildVariableMetadata, canAdvanceStep, containsUnicodeReplacementCharacter, deriveSceneOutlineMetrics, extractTextResponse, normalizeStructuredTextOutput, parseStructuredJson, resolveVariableMetadata, scopedLoopNodes, shouldRunNode, shouldSkipStep, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

test('unicode replacement characters are detected in persisted workflow text', () => {
  assert.equal(containsUnicodeReplacementCharacter('你是兼具电视剧叙事能力的分镜师'), false)
  assert.equal(containsUnicodeReplacementCharacter('你是兼具电视剧叙事�力的分镜师'), true)
  assert.equal(containsUnicodeReplacementCharacter({ nodes: [{ prompt: '正常' }, { prompt: '人物塑��能力' }] }), true)
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

test('structured output parses extracted model text before the provider response envelope', () => {
  const scene = {
    id: 'scene-01', sequence: 1, title: '入局', purpose: '张角入村', historicalBasis: '[史料1] 张角传道',
    adaptationBoundary: '村落细节为拟制', targetDuration: 5, continuityFromPrevious: false,
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
  assert.equal(validated.totalDuration, 5)
  assert.deepEqual(validated.raw, anthropicEnvelope)
})

test('structured output unwraps provider content strings without validating the response envelope', () => {
  const scene = {
    id: 'scene-01', sequence: 1, title: '入局', purpose: '张角入村', historicalBasis: '[史料1] 张角传道',
    adaptationBoundary: '村落细节为拟制', targetDuration: 5, continuityFromPrevious: false,
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
    adaptationBoundary: '村落细节为拟制', targetDuration: 5, continuityFromPrevious: false,
  }
  const generated = {
    episodeTitle: '符水与饥民', count: 99, totalDuration: 999, scenes: [scene, { ...scene, id: 'scene-02', sequence: 2, targetDuration: 10, continuityFromPrevious: true }],
  }
  const normalized = deriveSceneOutlineMetrics(generated)
  assert.equal(normalized.count, 2)
  assert.equal(normalized.totalDuration, 15)
  const validated = validateHistoricalStructuredOutput('history.scene-outline', normalized)
  assert.equal((validated as Record<string, unknown>).count, 2)
  assert.equal((validated as Record<string, unknown>).totalDuration, 15)
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '符水与饥民', scenes: [{ ...scene, targetDuration: 6 }],
  }), /只能是 5 或 10/)
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '符水与饥民', scenes: [{ ...scene, note: '不在契约中' }],
  }), /未声明字段：note/)
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '符水与饥民', scenes: [],
  }), /至少需要一个场景/)

  const storyboard = {
    id: 'scene-01', title: '入局', duration: 5, characters: ['张角'], visualPrompt: '竖屏真人实景', camera: '50mm推进', mood: '克制',
    firstFrameMode: 'generate', firstFramePrompt: '开始构图', lastFramePrompt: '结束构图', videoPrompt: '缓慢推进', audioType: '旁白',
    audioText: '百姓等待救济', historicalBasis: '[史料1] 张角传道', adaptationBoundary: '对白拟制',
  }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }))
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
    firstFramePrompt: '',
  }, { scene }) as Record<string, unknown>
  assert.equal(repairedStoryboard.historicalBasis, scene.historicalBasis)
  assert.equal(repairedStoryboard.adaptationBoundary, scene.adaptationBoundary)
  assert.match(String(repairedStoryboard.firstFramePrompt), /竖屏真人实景/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    historicalBasis: '',
  }, { scene: { ...scene, historicalBasis: '' } }), /historicalBasis 必须是非空字符串/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...storyboard, firstFrameMode: 'reuse_previous_tail' }, { scene }), /非连续镜头/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...storyboard, shots: [] }, { scene }), /未声明字段：shots/)
})

test('loop output aggregation exposes items and count per result variable', () => {
  const aggregated = aggregateLoopOutputs([{ shot: { id: 1 }, video: { id: 'v1' } }, { shot: { id: 2 }, video: { id: 'v2' } }])
  assert.equal(aggregated.shot.count, 2)
  assert.deepEqual(aggregated.video.items, [{ id: 'v1' }, { id: 'v2' }])
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
