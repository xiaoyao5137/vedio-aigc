import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aggregateLoopOutputs, applyNodeOutputToContext, availableLoopIterations, buildSceneOutlineRepairSuffix, buildStoryboardRepairSuffix, buildVariableMetadata, canAdvanceStep, canContinueToNextBreakpoint, containsUnicodeReplacementCharacter, deriveSceneContinuity, deriveSceneOutlineMetrics, estimateStoryboardTiming, extractTextResponse, findInspectableNodeRunIndex, findLoopSnapshotRunIndex, findNextBreakpointIndex, firstBlockingRunIndex, hasExecutionPlanMismatch, isDisplayedRunCompletedBeforeStep, refreshPendingExecutionNodes, storyboardDialogueScheduleHint, hasRemovedExecutionNodes, missingRequiredParamNames, normalizeStaticIllustrationCamera, normalizeStructuredTextOutput, parseStructuredJson, recoverInterruptedNodeRuns, repairStoryboardDialogueBindings, repairStoryboardNarrationEntrances, resolveVariableMetadata, scopedLoopNodes, serializedValuesDiffer, shouldRunNode, shouldSkipStep, validateHistoricalStoryboardSegments, validateHistoricalStructuredOutput, validationResultVariables } from '../src/workflow-core.ts'

test('actual parenthetical role labels bind to dialogue without endless false repairs', () => {
  const candidate = JSON.parse(readFileSync(new URL('./fixtures/storyboard-parenthetical-speaker.json', import.meta.url), 'utf8'))
  const expected = { scene: { targetDuration: 15, continuityFromPrevious: false }, productionSpeechRate: 3 }
  const result = validateHistoricalStructuredOutput('history.storyboard', candidate, expected)
  assert.doesNotMatch(String((result as Record<string, unknown>).videoPrompt), /冀州官吏（功曹）(?:全程闭口|没有台词)/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...candidate, audioText: candidate.audioText.replace('冀州官吏（功曹）', '冀州官吏乙') }, expected), /说话人未列入/)
})

test('storyboard schema accepts the documented illustration layer field', () => {
  const candidate = JSON.parse(readFileSync(new URL('./fixtures/storyboard-parenthetical-speaker.json', import.meta.url), 'utf8'))
  const expected = { scene: { targetDuration: 15, continuityFromPrevious: false }, productionSpeechRate: 3 }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', { ...candidate, illustrationLayers: [] }, expected))
})

test('static illustration camera normalization preserves framing while stating the renderer invariant', () => {
  const scene = { visualTreatment: 'animated', animationStyle: 'historical_tableau' }
  assert.equal(normalizeStaticIllustrationCamera('中景，整幅画缓慢放大', scene), '固定机位，中景，整幅画缓慢放大')
  assert.equal(normalizeStaticIllustrationCamera('二维编排，无实拍机位', scene), '二维编排，无实拍机位')
  assert.equal(normalizeStaticIllustrationCamera('推轨跟拍', { visualTreatment: 'live_action' }), '推轨跟拍')
})

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

test('scene continuity repairs an immediate answer after a question but leaves a new scene alone', () => {
  const scenes = deriveSceneContinuity([
    { purpose: '李膺展开名单，抬头质问来客想换什么', continuityFromPrevious: false },
    { purpose: '来者坦言宦官已掌握半数名单', continuityFromPrevious: false },
    { purpose: '数日后朝堂传来新的任命', continuityFromPrevious: false },
  ])
  assert.equal(scenes[1].continuityFromPrevious, true)
  assert.equal(scenes[2].continuityFromPrevious, false)
})

test('scene continuity repairs an explicit next-shot carry-over declaration', () => {
  const scenes = deriveSceneContinuity([
    { purpose: '周福门生在宫门外与房植宾客对视', continuityFromPrevious: false },
    { purpose: '紧接上一镜，从承接周福门生的眼神开始对峙', continuityFromPrevious: false },
  ])
  assert.equal(scenes[1].continuityFromPrevious, true)
})

test('scene continuity repairs adjacent shots in the same physical setting unless time jumps', () => {
  const scenes = deriveSceneContinuity([
    {
      cast: ['县令', '郭泰'], title: '堂前对峙', purpose: '县令盯住来客', continuityFromPrevious: false,
      requiredBeats: [{ setting: '甘陵县衙正堂' }],
    },
    {
      cast: ['县令', '郭泰'], title: '来客入局', purpose: '郭泰走到案前回应县令', continuityFromPrevious: false,
      requiredBeats: [{ setting: '甘陵县衙正堂' }],
    },
    {
      title: '数日后再议', purpose: '数日后众人重新聚集', continuityFromPrevious: false,
      requiredBeats: [{ setting: '甘陵县衙正堂' }],
    },
  ])
  assert.equal(scenes[1].continuityFromPrevious, true)
  assert.equal(scenes[2].continuityFromPrevious, false)
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

test('a changed uploaded reference invalidates a source-bound media execution', () => {
  const oldNode = { id: 'video', kind: 'video', params: [], uploads: [{ id: 'reference', url: '/generated/old.png' }] }
  const current = { nodes: [{ ...oldNode, uploads: [{ id: 'reference', url: '/generated/new.png' }] }], edges: [] }
  assert.equal(hasExecutionPlanMismatch(current, [{ node: oldNode }]), true)
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

test('a browser-interrupted step is restored as the next retryable step', () => {
  const runs = [
    { id: 'input', status: 'success' as const, durationMs: 12 },
    { id: 'model', status: 'running' as const, durationMs: 0, startedAt: 900 },
    { id: 'video', status: 'idle' as const, durationMs: 0 },
  ]

  const recovered = recoverInterruptedNodeRuns(runs)

  assert.equal(recovered.interrupted, true)
  assert.equal(recovered.resumeIndex, 1)
  assert.equal(recovered.nodeRuns[1].status, 'idle')
  assert.equal(recovered.nodeRuns[1].startedAt, undefined)
  assert.equal(recovered.nodeRuns[0], runs[0])
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

test('required JSON preserves explicit empty arrays while absent values and empty media stay missing', () => {
  const params = [
    { name: 'initialCharacters', type: 'json', required: true },
    { name: 'referenceImages', type: 'images', required: true },
  ]
  assert.deepEqual(missingRequiredParamNames(params, {initialCharacters: [], referenceImages: ['/actor.png']}), [])
  assert.deepEqual(missingRequiredParamNames(params, {initialCharacters: [], referenceImages: []}), ['referenceImages'])
  for (const absent of [undefined, null, '']) {
    assert.deepEqual(missingRequiredParamNames(params, {initialCharacters: absent, referenceImages: ['/actor.png']}), ['initialCharacters'])
  }
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

test('continue to breakpoint stops offering an action once a completed record has no pending runs', () => {
  const completed = Array.from({ length: 16 }, () => ({ status: 'success' as const }))
  assert.equal(canContinueToNextBreakpoint(completed, 15), false)
  assert.equal(canContinueToNextBreakpoint([...completed.slice(0, 12), { status: 'idle' }, ...completed.slice(13)], 11), true)
  assert.equal(canContinueToNextBreakpoint([{ status: 'success' }, { status: 'failed' }, { status: 'idle' }], 1), false)
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
  assert.equal(validated.totalDuration, 8)
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
  assert.equal(normalized.totalDuration, 23)
  assert.deepEqual((normalized.scenes as Array<Record<string, unknown>>).map((item) => item.targetDuration), [8, 15])
  const validated = validateHistoricalStructuredOutput('history.scene-outline', normalized)
  assert.equal((validated as Record<string, unknown>).count, 2)
  assert.equal((validated as Record<string, unknown>).totalDuration, 23)
  for (const modelDuration of [2, 16, 8.5]) {
    assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {episodeTitle:'test', scenes:[{...scene,targetDuration:modelDuration}]}), /3–15/)
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '符水与饥民', scenes: [{ ...scene, note: '不在契约中' }],
  }), /未声明字段：note/)
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '符水与饥民', scenes: [],
  }), /至少需要一个场景/)

  const storyboard = {
    id: 'scene-01', title: '入局', duration: 8, characters: ['张角'], visualPrompt: '竖屏真人实景', camera: '50mm推进', mood: '克制',
    firstFrameMode: 'reference', lastFramePrompt: '结束构图', videoPrompt: '0-2秒：张角入村。2-4秒：百姓抬头。4-6.5秒：张角停步。6.5-8秒：画面稳定。', audioType: '旁白',
    audioText: '百姓等待救济', historicalBasis: '[史料1] 张角传道', adaptationBoundary: '对白拟制',
  }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }))
  const normalizedStoryboard = validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }) as Record<string, unknown>
  assert.match(String(normalizedStoryboard.lastFramePrompt), /【静态尾帧】/)
  assert.match(String(normalizedStoryboard.lastFramePrompt), /上下三段/)
  assert.match(String(normalizedStoryboard.lastFramePrompt), /任何可读文字/)
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', { ...storyboard, duration: 15, videoPrompt: storyboard.videoPrompt.replace('6.5-8秒', '6.5-15秒') }, { scene: { ...scene, targetDuration: 15 } }))
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...storyboard, duration: 2 }, { scene: { ...scene, targetDuration: 2 } }), /3 到 15 之间的整数/)
  const normalizedAmbientNarration = validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    audioType: '旁白+环境音',
  }, { scene }) as Record<string, unknown>
  assert.equal(normalizedAmbientNarration.audioType, '旁白')
  const normalizedActionDialogue = validateHistoricalStructuredOutput('history.storyboard', {
    ...storyboard,
    characters: ['张角'],
    audioType: '对白／动作音',
    audioText: '张角：先救百姓。',
    videoPrompt: '0-2秒：张角入村。2-4秒：张角开口说出“先救百姓”。4-6.5秒：百姓抬头。6.5-8秒：画面稳定。',
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

test('runtime scene outlines require beat coverage and reject cross-location beats in one clip', () => {
  const baseScene = {
    id: 'scene-01', sequence: 1, title: '授印', purpose: '桓帝授印后周福走出宫门',
    historicalBasis: '[史料1] 周福受印', adaptationBoundary: '调度拟制', targetDuration: 15, continuityFromPrevious: false,
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '甘陵党议', scenes: [baseScene],
  }, { requireBeatCoverage: true }), /requiredBeats 必须是非空数组/)
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '甘陵党议', scenes: [{
      ...baseScene,
      requiredBeats: [
        { id: 'beat-01', description: '桓帝授印', setting: '宫殿内室', mustShow: ['桓帝', '授印'] },
        { id: 'beat-02', description: '周福走出宫门', setting: '宫门外', mustShow: ['周福', '宫门'] },
      ],
    }],
  }, { requireBeatCoverage: true }), /跨越了多个物理空间/)
  const transition = validateHistoricalStructuredOutput('history.scene-outline', {
    episodeTitle: '甘陵党议', scenes: [
      {
        ...baseScene, purpose: '桓帝在宫内向周福授印',
        requiredBeats: [{ id: 'beat-01', description: '桓帝授印', setting: '宫殿内室', mustShow: ['桓帝', '授印'] }],
      },
      {
        ...baseScene, id: 'scene-02', sequence: 2, purpose: '紧接上一镜，周福在宫门外遇见房植',
        requiredBeats: [{ id: 'beat-02', description: '周福遇见房植', setting: '宫门外', mustShow: ['周福', '房植'] }],
      },
    ],
  }, { requireBeatCoverage: true }) as { scenes: Array<{ continuityFromPrevious: boolean }> }
  assert.equal(transition.scenes[1].continuityFromPrevious, false)
})

test('storyboard duration must match its complete timeline instead of silently forcing 15 seconds', () => {
  const timing = estimateStoryboardTiming(
    '求评者：劭公，我家三代盐铁，求公一评。\n许劭：家资非才望。月旦评人品行，不评财货。',
    '许劭沉默两秒后回答，求评者起身，最后稳定停在许劭面部。',
  )
  assert.equal(timing.explicitPauseSeconds, 2)
  assert.equal(timing.requiredDuration, 14)

  const scene = { targetDuration: 12, continuityFromPrevious: false, historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制' }
  const storyboard = {
    id: 'scene-01', title: '月旦评', duration: 12, characters: ['许劭', '求评者'], visualPrompt: '竖屏真人实景', camera: '推至面部', mood: '克制',
    firstFrameMode: 'reference', lastFramePrompt: '许劭面部特写',
    videoPrompt: '0-4秒：许劭沉默2秒。4-9秒：求评者开口说出“劭公，我家三代盐铁，求公一评”。9-13.5秒：许劭开口回答“家资非才望，不评财货”。13.5-15秒：稳定在许劭面部。', audioType: '对白',
    audioText: '求评者：劭公，我家三代盐铁，求公一评。\n许劭：家资非才望，不评财货。',
    historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制',
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', storyboard, {scene}), /duration=12/)
  const validated = validateHistoricalStructuredOutput('history.storyboard', {...storyboard,duration:15}, { scene }) as Record<string, unknown>
  assert.equal(validated.duration, 15)
  assert.equal((validated.timingEstimate as Record<string, unknown>).plannedDuration, 12)
})

test('storyboard timing rejects the latest Xu Shao script instead of forcing rushed speech', () => {
  const longDialogue = '求评者：劭公，在下家中三代经营盐铁，今求一评，望劭公不吝赐教。\n许劭：足下家资虽厚，然不过贩夫之利。月旦评所评者，乃天下士人之品行才望，非富即可入品。'
  const base = {
    id: 'scene-01', title: '月旦评', duration: 12, characters: ['许劭', '求评者'], visualPrompt: '竖屏真人实景', camera: '推至面部', mood: '克制',
    firstFrameMode: 'reference', lastFramePrompt: '许劭面部特写',
    videoPrompt: '0-4秒：许劭沉默3秒。4-9秒：求评者开口说出“劭公，在下家中三代经营盐铁，今求一评，望劭公不吝赐教”。9-13.5秒：许劭回答“足下家资虽厚，然不过贩夫之利。月旦评所评者，乃天下士人之品行才望，非富即可入品”。13.5-15秒：定格许劭面部。', audioType: '对白', audioText: longDialogue,
    historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制',
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', base, {
    scene: { targetDuration: 12, continuityFromPrevious: false, historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制' },
  }), /STORYBOARD_TIMING_OVERFLOW/)
})

test('overflow recovery accepts multiple independently valid storyboard segments', () => {
  const scene = { id: 'scene-01', title: '月旦评', targetDuration: 15, continuityFromPrevious: false, historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制' }
  const segment = {
    id: 'scene-01-a', title: '求评', duration: 15, characters: ['许劭', '来客'], visualPrompt: '竖屏真人实景', camera: '缓慢推进', mood: '克制',
    firstFrameMode: 'reference', lastFramePrompt: '许劭抬眼看向来客', videoPrompt: '0-5秒：来客上前。5-10秒：来客开口说出“望劭公一评”。10-13秒：许劭抬眼。13-15秒：画面稳定停留2秒。', audioType: '对白',
    audioText: '来客：望劭公一评。', historicalBasis: '[史料1] 清议', adaptationBoundary: '对白拟制',
  }
  const segments = validateHistoricalStoryboardSegments({ segments: [
    segment,
    { ...segment, id: 'scene-01-b', title: '拒评', firstFrameMode: 'reuse_previous_tail', initialCharacters: ['许劭', '来客'], enteringCharacters: [], videoPrompt: '0-5秒：许劭抬眼。5-10秒：许劭开口说出“只评品行，不评财货”。10-13秒：来客低头。13-15秒：画面稳定停留2秒。', audioText: '许劭：只评品行，不评财货。' },
  ] }, { scene })
  assert.equal(segments.length, 2)
  assert.equal(segments[0].duration, 15)
  assert.equal(segments[1].firstFrameMode, 'reuse_previous_tail')
  assert.throws(() => validateHistoricalStoryboardSegments({ segments: [segment, { ...segment, id: 'scene-01-b' }] }, { scene }), /reuse_previous_tail/)
})

test('storyboard coverage rejects a shot that silently drops the latter half of its scene', () => {
  const scene = {
    id: 'scene-01', title: '授印与相逢', targetDuration: 15, continuityFromPrevious: false,
    historicalBasis: '[史料1] 周福受印', adaptationBoundary: '相逢调度拟制',
    requiredBeats: [
      { id: 'beat-01', description: '桓帝向周福授印', setting: '东汉宫殿内室', mustShow: ['桓帝', '周福', '授印'] },
      { id: 'beat-02', description: '周福在宫门与房植相逢', setting: '东汉宫殿内室', mustShow: ['宫门', '房植', '相逢'] },
    ],
  }
  const truncated = {
    id: 'scene-01', title: '周福受印', duration: 15, characters: ['桓帝', '周福'],
    initialCharacters: ['桓帝', '周福'], enteringCharacters: [], coveredBeatIds: ['beat-01'],
    visualPrompt: '东汉宫殿，桓帝手捧官印面对周福。', camera: '固定中景', mood: '庄重',
    firstFrameMode: 'reference', lastFramePrompt: '周福捧住官印。',
    videoPrompt: '0-5秒：桓帝向周福授印。5-10秒：周福接印。10-13.5秒：二人对视。13.5-15秒：稳定尾帧。',
    audioType: '旁白', audioText: '桓帝向旧师周福授印。', historicalBasis: '[史料1] 周福受印', adaptationBoundary: '动作拟制',
  }
  assert.throws(
    () => validateHistoricalStructuredOutput('history.storyboard', truncated, { scene }),
    /STORYBOARD_COVERAGE_INCOMPLETE.*beat-01、beat-02/,
  )
})

test('coverage recovery partitions every required beat once and forces the second segment to reuse the real tail', () => {
  const scene = {
    id: 'scene-01', title: '授印相逢', targetDuration: 15, continuityFromPrevious: false,
    historicalBasis: '[史料1] 周福受印', adaptationBoundary: '动作拟制',
    requiredBeats: [
      { id: 'beat-01', description: '桓帝授印', setting: '东汉宫殿内室', mustShow: ['桓帝', '授印'] },
      { id: 'beat-02', description: '周福转身', setting: '东汉宫殿内室', mustShow: ['周福', '转身'] },
    ],
  }
  const common = {
    duration: 15, characters: ['桓帝', '周福'], initialCharacters: ['桓帝', '周福'], enteringCharacters: [],
    camera: '固定中景', mood: '庄重', audioType: '旁白', historicalBasis: '[史料1] 周福受印', adaptationBoundary: '动作拟制',
  }
  const segments = validateHistoricalStoryboardSegments({ segments: [
    {
      ...common, id: 'scene-01-a', title: '授印', coveredBeatIds: ['beat-01'], firstFrameMode: 'reference',
      visualPrompt: '宫殿内桓帝面对周福。', lastFramePrompt: '桓帝手臂落下。', audioText: '桓帝向周福授印。',
      videoPrompt: '0-5秒：桓帝授印。5-10秒：周福接住。10-13.5秒：二人对视。13.5-15秒：稳定尾帧。',
    },
    {
      ...common, id: 'scene-01-b', title: '转身', coveredBeatIds: ['beat-02'], firstFrameMode: 'reuse_previous_tail',
      visualPrompt: '从前段尾帧继续，周福捧印。', lastFramePrompt: '周福面向殿门。', audioText: '周福转身走向殿门。',
      videoPrompt: '0-5秒：周福转身。5-10秒：周福迈步。10-13.5秒：桓帝目送。13.5-15秒：稳定尾帧。',
    },
  ] }, { scene })
  assert.deepEqual(segments.map((segment) => segment.coveredBeatIds), [['beat-01'], ['beat-02']])
  assert.equal(segments[1].firstFrameMode, 'reuse_previous_tail')
  assert.throws(() => validateHistoricalStoryboardSegments({ segments: [
    { ...segments[0], coveredBeatIds: ['beat-01'] },
    { ...segments[1], coveredBeatIds: ['beat-01'] },
  ] }, { scene }), /恰好一次覆盖全部剧情节拍/)
})

test('storyboard retry carries the rejected split and gives exact dialogue-binding repair instructions', () => {
  const rejected = {
    segments: [{
      audioText: '范滂：俭,此举荐虽合朝廷选才之制,然侯览党羽遍布朝野,你弹劾必遭反噬。',
      videoPrompt: '0-5秒：范滂看向张俭。5-10秒：张俭展开奏牍。10-13.5秒：二人对视。13.5-15秒：画面稳定。声音：范滂说出劝告。',
    }],
  }
  const message = 'STORYBOARD_PROMPT_OVERLOAD: 对白“范滂：俭,此举荐虽合朝廷选才之制,然侯览党羽遍布朝野,你弹劾必遭反噬。”未逐字绑定到任何明确时间段'
  const suffix = buildStoryboardRepairSuffix(message, rejected, '第 1 次拆分结果仍未通过校验')

  assert.match(suffix, /上一版未通过的 JSON/)
  assert.match(suffix, /范滂：俭,此举荐虽合朝廷选才之制/)
  assert.match(suffix, /冒号后的完整台词逐字写进同一个“起止秒”段/)
  assert.match(suffix, /严禁把同一行台词拆成前后半句/)
  assert.match(suffix, /声音清单之前/)
  assert.match(suffix, /0-5秒：范滂看向张俭/)
})

test('outline correction names the fields a history-subject rejection must rewrite, and stays quiet otherwise', () => {
  const rejected = { scenes: [{ id: 'scene-09', cast: ['周福'], requiredBeats: [{ id: 'beat-09', observable: { visual: ['周福不满地拂袖'] } }] }], dramaticScenes: [{ id: 'drama-03', characters: ['周福'] }] }
  const message = 'HISTORY_CONTENT_REJECTED: scene-09 把宾客之间的讥揣归因于周福本人嫉妒，原文没有支持两位本人的政治动机。由宾客承担接报与不满反应。'
  const prompt = buildSceneOutlineRepairSuffix('【原大纲提示词基线】', message, rejected)
  assert.match(prompt, /【原大纲提示词基线】/)
  assert.match(prompt, /scene-09 把宾客之间的讥揣/)
  assert.match(prompt, /该场 cast、requiredBeats 的 description\/observable\/mustShow/)
  // The agency guard also reads purpose/function/stateChange; a recipe that keeps them out of the
  // editable list leaves the writer no legal edit for a sentence it just named.
  assert.match(prompt, /description\/observable\/mustShow\/function\/stateChange\/purpose/)
  assert.match(prompt, /characters\/tactics\/turn\/result\/characterStates/)
  assert.match(prompt, /属于必改范围，不算越界润色/)
  assert.match(prompt, /仍然违规/)
  assert.match(prompt, /上一版未通过的 JSON/)
  assert.match(prompt, /周福不满地拂袖/)
  // A purely structural rejection does not get the history-subject lecture.
  const structural = buildSceneOutlineRepairSuffix('基线', 'HISTORY_DRAMA_INVALID: scene-02 的 mustShow 锚点“整理货物”过于抽象', rejected)
  assert.doesNotMatch(structural, /行动主体|不算越界润色/)
  assert.match(structural, /只把该锚点换成可直接拍出的具体可见短语/)
})

test('long uninterrupted dialogue is rejected before native audio can drift from lip motion', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: true, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制' }
  const line = '俭,此举荐虽合朝廷选才之制,然侯览党羽遍布朝野,你弹劾必遭反噬。'
  const storyboard = {
    id: 'scene-fan-pang', title: '范滂劝诫', duration: 15, characters: ['范滂', '张俭'], visualPrompt: '东汉官署内，范滂与张俭隔案相对', camera: '中景缓推', mood: '凝重',
    initialCharacters: ['范滂', '张俭'], enteringCharacters: [],
    firstFrameMode: 'reuse_previous_tail', lastFramePrompt: '张俭握住奏牍，范滂注视他',
    videoPrompt: `0-2秒：范滂看向张俭。2-12秒：范滂开口说出“${line}”，张俭闭口聆听。12-13.5秒：张俭握住奏牍。13.5-15秒：画面稳定停留。`,
    audioType: '对白', audioText: `范滂：${line}`, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制',
  }

  assert.throws(
    () => validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }),
    /超过单条口型锚点 6 秒上限/,
  )
})

test('the reported round-three dialogue passes after semantic cue splitting', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: true, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制' }
  const originalLine = '侯览是桓帝宠信的中常侍，你这一劾，不只是你的官，是我们所有人的命'
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    id: 'scene-03-original', title: '党人劝阻', duration: 15, characters: ['张俭', '年长党人'], visualPrompt: '东汉室内两人隔案对峙', camera: '固定中景', mood: '凝重',
    initialCharacters: ['张俭'], enteringCharacters: [{ name: '年长党人', startSecond: 0, endSecond: 3, path: '画面右后方门口' }],
    firstFrameMode: 'reuse_previous_tail', lastFramePrompt: '张俭抬眼直视年长党人',
    videoPrompt: `0-10秒：年长党人开口说出“${originalLine}”，张俭闭口聆听。10-13.5秒：张俭抬眼。13.5-15秒：画面稳定。`,
    audioType: '对白', audioText: `年长党人：${originalLine}`,
    historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制',
  }, { scene }), /必须在 0-3 秒时间段内写明从“画面右后方门口”连续走入画面/)

  const storyboard = {
    id: 'scene-03', title: '党人劝阻', duration: 15, characters: ['张俭', '年长党人'], visualPrompt: '东汉室内两人隔案对峙', camera: '固定中景', mood: '凝重',
    initialCharacters: ['张俭'], enteringCharacters: [{ name: '年长党人', startSecond: 0, endSecond: 3, path: '画面右后方门口' }],
    firstFrameMode: 'reuse_previous_tail', lastFramePrompt: '张俭抬眼直视年长党人',
    videoPrompt: '0-3秒：年长党人从画面右后方门口连续步入，先出现身体轮廓再完整入画，张俭闭口看向他。3-7秒：年长党人开口说出“侯览是桓帝宠信的中常侍”，张俭闭口聆听。7-13.5秒：年长党人开口说出“你这一劾，是我们所有人的命”，张俭闭口注视。13.5-15秒：二人闭口，画面稳定。',
    audioType: '对白',
    audioText: '年长党人：侯览是桓帝宠信的中常侍\n年长党人：你这一劾，是我们所有人的命',
    historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制',
  }

  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }))
})

test('an entering character cannot speak before completing the visible entrance', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: true, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制' }
  const line = '张俭，且听老夫一言。'
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    id: 'scene-entry-speaking', title: '老人入场', duration: 15, characters: ['张俭', '年长党人'], initialCharacters: ['张俭'],
    enteringCharacters: [{ name: '年长党人', startSecond: 0, endSecond: 4, path: '画面右侧门口' }],
    visualPrompt: '东汉室内，张俭位于案前', camera: '固定中景', mood: '凝重', firstFrameMode: 'reuse_previous_tail',
    lastFramePrompt: '年长党人站在张俭身侧',
    videoPrompt: `0-4秒：年长党人从画面右侧门口连续步入，先出现身体轮廓再完整入画，并开口说出“${line}”。4-9秒：张俭闭口看向他。9-13.5秒：二人停在案旁。13.5-15秒：画面稳定。`,
    audioType: '对白', audioText: `年长党人：${line}`, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制',
  }, { scene }), /完成入场前就开始说话/)
})

test('parenthetical role annotations cannot bypass the entrance-before-speech rule', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: true, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制' }
  const line = '张俭，且听老夫一言。'
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    id: 'scene-entry-speaking', title: '老人入场', duration: 15, characters: ['张俭', '年长党人（族老）'], initialCharacters: ['张俭'],
    enteringCharacters: [{ name: '年长党人（族老）', startSecond: 0, endSecond: 4, path: '画面右侧门口' }],
    visualPrompt: '东汉室内，张俭位于案前', camera: '固定中景', mood: '凝重', firstFrameMode: 'reuse_previous_tail',
    lastFramePrompt: '年长党人（族老）站在张俭身侧',
    videoPrompt: `0-4秒：年长党人（族老）从画面右侧门口连续步入，先出现身体轮廓再完整入画，并开口说出“${line}”。4-9秒：张俭闭口看向他。9-13.5秒：二人停在案旁。13.5-15秒：画面稳定。`,
    audioType: '对白', audioText: `年长党人：${line}`, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制',
  }, { scene }), /完成入场前就开始说话/)
})

test('storyboard locally merges overlapping narration entrance beats into four continuous ranges', () => {
  const rejected = {
    id: 'scene-02', title: '饮下符水', duration: 15,
    characters: ['张角', '病人', '饥民甲', '饥民乙'],
    initialCharacters: ['张角', '病人'],
    enteringCharacters: [
      { name: '饥民甲', startSecond: 0.5, endSecond: 2.5, path: '画面右后方破庙门口' },
      { name: '饥民乙', startSecond: 1, endSecond: 3, path: '画面右后方破庙门口,紧跟饥民甲身后' },
    ],
    visualPrompt: '东汉破庙内，张角和病人在前景，门外暂时无人。', camera: '固定中景', mood: '压抑',
    firstFrameMode: 'reuse_previous_tail', lastFramePrompt: '四人同处破庙内。',
    videoPrompt: '0.5-2.5秒:饥民甲身体轮廓从画面右后方破庙门口先现、连续走入至后景土墙根站定闭口。1-3秒:饥民乙身体轮廓紧随从门口出现、连续走至饥民甲身旁站定闭口。3-7秒:病人双手颤抖捧碗至唇停顿，张角木剑轻点碗口。7-11秒:病人倾碗吞咽，饥民甲闭口注视。11-13.5秒:病人饮尽，张角收剑。13.5-15秒:四人闭口稳定尾帧。',
    audioType: '旁白', audioText: '病人饮下符水，饥民闻声而至。',
    historicalBasis: '[史料1] 张角以符水疗病。', adaptationBoundary: '人物动作拟制',
  }
  const repaired = repairStoryboardNarrationEntrances(rejected) as Record<string, unknown>
  assert.equal((String(repaired.videoPrompt).match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?秒/g) ?? []).length, 4)
  assert.doesNotMatch(JSON.stringify(repaired.enteringCharacters), /紧跟/)
  assert.match(String(repaired.videoPrompt), /0-3秒：饥民甲从画面右后方破庙门口连续走入/)
  assert.match(String(repaired.videoPrompt), /饥民乙从画面右后方破庙门口连续走入/)
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', repaired, {
    scene: { targetDuration: 15, continuityFromPrevious: true },
  }))
})

test('storyboard locally repairs a missing short Zhang Jian dialogue binding before asking the model again', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: false, historicalBasis: '[史料1] 张俭任督邮', adaptationBoundary: '对话拟制' }
  const line = '侯览族人强占民田，逼死佃农二人。'
  const rejected = {
    id: 'scene-zhang-jian', title: '查田', duration: 15, characters: ['张俭', '书佐'], visualPrompt: '东汉县廷内实景', camera: '中景缓推', mood: '凝重',
    firstFrameMode: 'reference', lastFramePrompt: '张俭按住田籍，书佐垂手等候',
    videoPrompt: `0-3秒：张俭翻开田籍。3-11秒：张俭抬眼质问，书佐闭口聆听。11-13.5秒：张俭按住田籍。13.5-15秒：画面稳定。声音：张俭说“${line}”，纸张声。`,
    audioType: '对白', audioText: `张俭：${line}`, historicalBasis: '[史料1] 张俭任督邮', adaptationBoundary: '对话拟制',
  }

  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', rejected, { scene }), /未逐字绑定/)
  const repaired = repairStoryboardDialogueBindings(rejected) as Record<string, unknown>
  assert.match(String(repaired.videoPrompt), new RegExp(`3-11秒：[^]*张俭开口说出“${line}”`))
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', repaired, { scene }))
})

test('storyboard refuses to merge time ranges when one audio line spans two timed beats', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: true, historicalBasis: '[史料1] 张俭弹劾侯览', adaptationBoundary: '对话拟制' }
  const line = '侯览族属强占民田，逼死无辜七人。'
  const rejected = {
    id: 'scene-02', title: '张俭破局', duration: 15, characters: ['张俭'], visualPrompt: '东汉议事厅真人实景', camera: '中景固定', mood: '凝重',
    initialCharacters: ['张俭'], enteringCharacters: [],
    firstFrameMode: 'reuse_previous_tail', lastFramePrompt: '张俭握紧竹简直视前方',
    videoPrompt: "0-6秒：张俭握紧竹简向前推送，开口说出'侯览族属强占民田'。6-10秒：张俭点向竹简，继续开口说出'逼死无辜七人'。10-13.5秒：张俭收回竹简。13.5-15秒：张俭嘴唇紧闭，画面稳定。",
    audioType: '对白', audioText: `张俭：${line}`, historicalBasis: '[史料1] 张俭弹劾侯览', adaptationBoundary: '对话拟制',
  }

  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', rejected, { scene }), /未逐字绑定/)
  const before = structuredClone(rejected)
  assert.equal(repairStoryboardDialogueBindings(rejected), undefined)
  assert.deepEqual(rejected, before)
})

test('storyboard local dialogue repair refuses to guess when no timed beat identifies the speaker', () => {
  const rejected = {
    audioType: '对白', audioText: '张俭：这人能作证？',
    videoPrompt: '0-5秒：镜头推近竹简。5-10秒：案上灯火摇动。10-13.5秒：门外有脚步声。13.5-15秒：画面稳定。',
  }
  assert.equal(repairStoryboardDialogueBindings(rejected), undefined)
})

test('storyboard local dialogue repair also fixes binding failures inside split segments', () => {
  const line = '侯览族人已占民田三百余亩。'
  const split = {
    segments: [{
      audioType: '对白', audioText: `张俭：${line}`,
      videoPrompt: `0-4秒：书佐递上田籍。4-10秒：张俭抬眼质问。10-13.5秒：书佐俯身。13.5-15秒：画面稳定。声音：张俭说“${line}”。`,
    }],
  }
  const repaired = repairStoryboardDialogueBindings(split) as Record<string, unknown>
  const segment = (repaired.segments as Array<Record<string, unknown>>)[0]
  assert.match(String(segment.videoPrompt), new RegExp(`4-10秒：[^]*张俭开口说出“${line}”`))
})

test('storyboard rejects overloaded zero-second directions and silent lip movement', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: false, historicalBasis: '[史料1] 李膺刚正', adaptationBoundary: '互动拟制' }
  const base = {
    id: 'scene-01', title: '拒茶', duration: 15, characters: ['李膺', '士绅甲'], visualPrompt: '竖屏真人实景', camera: '固定中景', mood: '压抑',
    firstFrameMode: 'reference', lastFramePrompt: '李膺指向门外，士绅低头', audioType: '对白',
    audioText: '士绅甲（颤声）：大人……这……', historicalBasis: '[史料1] 李膺刚正', adaptationBoundary: '互动拟制',
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    ...base,
    videoPrompt: '第0秒：李膺俯视茶盏，士绅甲弯腰。1-5秒：士绅甲嘴唇无声张合。',
  }, { scene }), /STORYBOARD_PROMPT_OVERLOAD.*第0秒/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    ...base,
    videoPrompt: '0-5秒：士绅甲抬手示意。5-10秒：李膺咬牙后指向门外。10-13.5秒：士绅甲开口说出“大人……这……”。13.5-15秒：两人定住。',
  }, { scene }), /非说话人“李膺”被安排了口部动作/)
})

test('storyboard rejects a subtly open mouth in narration shots', () => {
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    id: 'scene-01', title: '旁白镜头', duration: 15,
    characters: ['饥民乙'], initialCharacters: ['饥民乙'], enteringCharacters: [],
    visualPrompt: '竖屏真人东汉历史片。', camera: '固定中景', mood: '压抑', firstFrameMode: 'reference',
    lastFramePrompt: '饥民乙站在墙边。',
    videoPrompt: '0-5秒：饥民乙扶墙观察。5-10秒：饥民乙嘴唇微张。10-13.5秒：他转身。13.5-15秒：稳定尾帧。',
    audioType: '旁白', audioText: '饥民闻声而至。', historicalBasis: '[史料1] 记载', adaptationBoundary: '动作拟制',
  }, { scene: { targetDuration: 15, continuityFromPrevious: false } }), /无声口型/)
})

test('storyboard rejects dialogue relegated to an untimed sound list or contradicted by closed mouths', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: false, historicalBasis: '[史料1] 张俭任督邮', adaptationBoundary: '对话拟制' }
  const base = {
    id: 'scene-01', title: '核实人证', duration: 15, characters: ['张俭', '刘表'], visualPrompt: '竖屏真人实景', camera: '固定中景', mood: '压抑',
    firstFrameMode: 'reference', lastFramePrompt: '二人隔案对坐', audioType: '对白',
    audioText: '张俭：这人能作证？\n刘表：能，但牵扯的不止侯览一人。', historicalBasis: '[史料1] 张俭任督邮', adaptationBoundary: '对话拟制',
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    ...base,
    videoPrompt: '0-5秒：张俭指向竹简，嘴唇未动。5-10秒：刘表低头看竹简。10-13.5秒：二人嘴唇紧闭。13.5-15秒：画面稳定。声音：张俭说“这人能作证”，刘表说“能，但牵扯的不止侯览一人”，竹简摩擦声。',
  }, { scene }), /未逐字绑定到任何明确时间段/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {
    ...base,
    videoPrompt: '0-5秒：张俭嘴唇紧闭并说出“这人能作证”。5-10秒：刘表开口说出“能，但牵扯的不止侯览一人”。10-13.5秒：二人对视。13.5-15秒：画面稳定。',
  }, { scene }), /台词时间段内同时被要求闭口/)
})

test('storyboard does not attribute other characters closed mouths to the active speaker', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: false, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制' }
  const storyboard = {
    id: 'scene-party', title: '席间议论', duration: 15, characters: ['年长党人', '年轻党人'], visualPrompt: '东汉室内席间', camera: '中景缓推', mood: '凝重',
    firstFrameMode: 'reference', lastFramePrompt: '众人看向年长党人',
    videoPrompt: '0-4秒：年长党人抬眼看向众人。4-10秒：年长党人开口说出“此事不可操之过急”，其他人物全程闭口。10-13.5秒：年轻党人放下竹简。13.5-15秒：画面稳定。',
    audioType: '对白', audioText: '年长党人：此事不可操之过急。', historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制',
  }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }))
})

test('storyboard binds a short quoted line exactly instead of matching it inside another speakers line', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: false, historicalBasis: '[史料1] 分遣弟子', adaptationBoundary: '对白拟制' }
  const storyboard = {
    id: 'scene-orders', title: '分头领命', duration: 15, characters: ['张角', '马元义', '唐周'],
    initialCharacters: ['张角', '马元义', '唐周'], enteringCharacters: [],
    visualPrompt: '东汉室内真人实景', camera: '中景缓推', mood: '凝重', firstFrameMode: 'reference',
    lastFramePrompt: '三人站在室内。',
    videoPrompt: '0-5秒：张角开口说出“你等分头前往”，二弟子闭口听令。5-9秒：马元义开口说出“弟子领命”，唐周闭口。9-12秒：唐周开口说出“领命”，张角与马元义闭口。12-13.5秒：三人起身。13.5-15秒：三人闭口稳定。',
    audioType: '对白', audioText: '张角：你等分头前往\n马元义：弟子领命\n唐周：领命',
    historicalBasis: '[史料1] 分遣弟子', adaptationBoundary: '对白拟制',
  }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', storyboard, { scene }))
})

test('storyboard does not treat a silent character looking at the speaker as the speaker closing their mouth', () => {
  const line = '天师符水,可解尔身厄难,当诚心叩首,罪去病消'
  const output = {
    id: 'scene-01', title: '符水病榻', duration: 15,
    characters: ['张角', '病人'],
    initialCharacters: ['张角', '病人'],
    enteringCharacters: [],
    visualPrompt: '东汉茅屋内，病人卧于榻上，张角在一旁。',
    camera: '固定中景', mood: '压抑', firstFrameMode: 'reference',
    lastFramePrompt: '张角放下符纸，病人仰卧。',
    audioType: '对白',
    audioText: `张角:${line}`,
    videoPrompt: `0-3秒：张角走到病榻旁，病人闭口仰卧。3-8.5秒：张角开口说出“${line}”，病人嘴唇紧闭目光转向张角。8.5-13.5秒：张角放下符纸，病人闭口注视。13.5-15秒：二人保持姿态，画面稳定。`,
    historicalBasis: '[史料1] 张角以符水疗病。', adaptationBoundary: '对白拟制',
  }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', output, {
    scene: { continuityFromPrevious: false },
  }))
})

test('storyboard does not treat the object of a speaking character gaze as another speaker', () => {
  const line = '这真能治病？'
  const output = {
    id: 'scene-02', title: '饮下符水', duration: 15,
    characters: ['张角', '病人'], initialCharacters: ['张角', '病人'], enteringCharacters: [],
    visualPrompt: '东汉草棚内，张角和病人相对。', camera: '固定中景', mood: '压抑',
    firstFrameMode: 'reuse_previous_tail', lastFramePrompt: '病人捧碗，张角闭口注视。',
    videoPrompt: `0-3秒：病人捧碗，张角闭口注视。3-9秒：病人开口说出“${line}”，说话时眼神仍盯着张角寻求确认。9-13.5秒：病人开始饮水，张角闭口以手势催促。13.5-15秒：二人稳定停留。`,
    audioType: '对白', audioText: `病人：${line}`,
    historicalBasis: '[史料1] 张角以符水疗病。', adaptationBoundary: '对白拟制',
  }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', output, {
    scene: { targetDuration: 15, continuityFromPrevious: true },
  }))
})

test('storyboard locally removes a closed-mouth cue attached to the active speaker', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: false, historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制' }
  const rejected = {
    id: 'scene-party', title: '席间议论', duration: 15, characters: ['年长党人', '年轻党人'], visualPrompt: '东汉室内席间', camera: '中景缓推', mood: '凝重',
    firstFrameMode: 'reference', lastFramePrompt: '众人看向年长党人',
    videoPrompt: '0-4秒：年长党人抬眼看向众人。4-10秒：年长党人嘴唇紧闭并开口说出“此事不可操之过急”，年轻党人闭口聆听。10-13.5秒：年轻党人放下竹简。13.5-15秒：画面稳定。',
    audioType: '对白', audioText: '年长党人：此事不可操之过急。', historicalBasis: '[史料1] 党锢列传', adaptationBoundary: '对白拟制',
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', rejected, { scene }), /台词时间段内同时被要求闭口/)
  const repaired = repairStoryboardDialogueBindings(rejected) as Record<string, unknown>
  assert.match(String(repaired.videoPrompt), /年长党人开口说出“此事不可操之过急”/)
  assert.match(String(repaired.videoPrompt), /年轻党人闭口聆听/)
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', repaired, { scene }))

  const suffix = buildStoryboardRepairSuffix('STORYBOARD_PROMPT_OVERLOAD: 说话人“年长党人”在台词时间段内同时被要求闭口；必须删除冲突动作，并明确其开口说出台词', rejected, '第 1 次精简重写')
  assert.match(suffix, /只删除该台词时间段内附着在 年长党人 身上的/)
  assert.match(suffix, /其他未说话人物仍须闭口/)
})

test('storyboard appends an explicit speaker-to-lip-sync contract', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: false, historicalBasis: '[史料1] 李膺刚正', adaptationBoundary: '互动拟制' }
  const validated = validateHistoricalStructuredOutput('history.storyboard', {
    id: 'scene-01', title: '拒茶', duration: 15, characters: ['李膺', '士绅甲'], visualPrompt: '竖屏真人实景', camera: '固定中景', mood: '压抑',
    firstFrameMode: 'reference', lastFramePrompt: '李膺指向门外，士绅低头',
    videoPrompt: '0-4秒：士绅甲抬手请茶，李膺看向茶盏。4-9秒：士绅甲开口说出“大人……这……”，李膺保持不动。9-13.5秒：李膺指向门外，士绅甲低头。13.5-15秒：画面稳定。环境声仅风声与衣料声。',
    audioType: '对白', audioText: '士绅甲（颤声）：大人……这……', historicalBasis: '[史料1] 李膺刚正', adaptationBoundary: '互动拟制',
  }, { scene }) as Record<string, unknown>
  assert.match(String(validated.videoPrompt), /【同期对白硬约束】.*仅士绅甲/)
  assert.match(String(validated.videoPrompt), /李膺没有台词，不得抢说或做语言口型/)
  assert.match(String(validated.videoPrompt), /整张脸和嘴唇必须持续清晰入镜、无遮挡/)
  assert.match(String(validated.videoPrompt), /最后 1.5 秒所有人物双唇完全贴合/)
})

test('storyboard rejects different speakers sharing one timed lip-sync beat', () => {
  const scene = { targetDuration: 15, continuityFromPrevious: true, historicalBasis: '[史料1] 张角以符水疗病。', adaptationBoundary: '对白拟制' }
  const output = {
    id: 'scene-03', title: '众人跪拜', duration: 15,
    characters: ['张角', '病者', '饥民甲', '饥民乙'], initialCharacters: ['张角', '病者'],
    enteringCharacters: [
      { name: '饥民甲', path: '画面左后方', startSecond: 0, endSecond: 3 },
      { name: '饥民乙', path: '画面右后方', startSecond: 0, endSecond: 3 },
    ],
    visualPrompt: '东汉荒地，张角与病者在画面中。', camera: '中景', mood: '激动', firstFrameMode: 'reuse_previous_tail',
    lastFramePrompt: '众人闭口跪拜。',
    videoPrompt: '0-3秒：饥民甲从画面左后方连续走入，饥民乙从画面右后方连续走入。3-8秒：病者开口说出“大贤良师救我性命”。8-13.5秒：饥民甲开口说出“大贤良师”，饥民乙开口说出“大贤良师”。13.5-15秒：所有人物闭口静止。',
    audioType: '对白', audioText: '病者：大贤良师救我性命\n饥民甲：大贤良师\n饥民乙：大贤良师',
    historicalBasis: '[史料1] 张角以符水疗病。', adaptationBoundary: '对白拟制',
  }
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', output, { scene }), /同一时间段绑定了多个不同说话人：饥民甲、饥民乙/)
  const suffix = buildStoryboardRepairSuffix('STORYBOARD_PROMPT_OVERLOAD: 同一时间段绑定了多个不同说话人：饥民甲、饥民乙', output, '第 1 次精简重写')
  assert.match(suffix, /每段只允许一个说话人/)
  assert.match(suffix, /第 5 或第 6 个时间段/)
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

test('step completion belongs to the displayed loop run instead of a previous round with the same node id', () => {
  const runs = [
    { node: { id: 'shot' }, loopGroupId: 'loop-a', loopIndex: 0, status: 'success' as const },
    { node: { id: 'review' }, loopGroupId: 'loop-a', loopIndex: 0, status: 'success' as const },
    { node: { id: 'shot' }, loopGroupId: 'loop-a', loopIndex: 1, status: 'success' as const },
    { node: { id: 'review' }, loopGroupId: 'loop-a', loopIndex: 1, status: 'idle' as const },
  ]

  assert.equal(isDisplayedRunCompletedBeforeStep(runs, 0, 3), true)
  assert.equal(isDisplayedRunCompletedBeforeStep(runs, 3, 3), false)
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

test('context patches cannot replace another validation result while ordinary and own outputs still work', () => {
  const validationResultVars = validationResultVariables([
    { kind: 'validation', resultVar: 'quality_report' },
    { kind: 'validation', resultVar: 'media_report' },
    { kind: 'code', resultVar: 'ordinary' },
  ])
  const original = { quality_report: { passed: true }, media_report: { passed: true }, input: { topic: 'kept' } }
  const forged = { contextPatch: { quality_report: { passed: false }, input: { topic: 'changed' } } }
  assert.throws(() => applyNodeOutputToContext(original, 'ordinary', forged,
    { validationResultVars, sourceKind: 'code' }), /VALIDATION_RESULT_CONTEXT_PATCH_CONFLICT/)
  assert.deepEqual(original, { quality_report: { passed: true }, media_report: { passed: true }, input: { topic: 'kept' } })
  assert.throws(() => applyNodeOutputToContext(original, 'media_report',
    { passed: true, contextPatch: { quality_report: { passed: false } } },
    { validationResultVars, sourceKind: 'validation' }), /VALIDATION_RESULT_CONTEXT_PATCH_CONFLICT/)
  const own = { passed: true, contextPatch: { quality_report: { passed: false }, input: { topic: 'changed' } } }
  const accepted = applyNodeOutputToContext(original, 'quality_report', own,
    { validationResultVars, sourceKind: 'validation' })
  assert.equal(accepted.quality_report, own, 'the validation node owns its direct result even when it patches its own name')
  assert.deepEqual(accepted.input, { topic: 'changed' })
  const ordinary = applyNodeOutputToContext(original, 'ordinary', { contextPatch: { input: { count: 1 } } },
    { validationResultVars, sourceKind: 'code' })
  assert.deepEqual(ordinary.input, { topic: 'kept', count: 1 })
  assert.deepEqual(ordinary.quality_report, { passed: true })
})


test('same-named location does not force a new cast to inherit the previous image', () => {
  const scenes = deriveSceneContinuity([
    { cast: ['周家宾客', '房家宾客'], purpose: '二人错身离开', requiredBeats: [{ setting: '甘陵街巷' }], continuityFromPrevious: false },
    { cast: ['长者甲', '长者乙'], purpose: '长者议论南北部', requiredBeats: [{ setting: '甘陵街巷' }], continuityFromPrevious: false },
  ])
  assert.equal(scenes[1].continuityFromPrevious, false)
})


test('production budgets slower historical delivery before buying video', () => {
  const text = '桓帝：朕即位以来，常念蠡吾受学之恩，今擢卿为尚书。'
  const production = estimateStoryboardTiming(text, '', 3)
  assert.equal(production.speechCharacterCount, 19)
  assert.equal(production.speechSeconds, 6.33)
  assert.ok(production.rawRequiredSeconds > estimateStoryboardTiming(text, '').rawRequiredSeconds)
})


test('compatible migrations retain completed evidence and refresh only unstarted nodes', () => {
  const old = { id: 'shot', kind: 'text', prompt: 'old' }
  const updated = { ...old, prompt: 'new' }
  const runs = [{ node: old, status: 'success', output: { video: 'paid-result' } }, { node: old, status: 'idle', output: undefined }]
  const migrated = refreshPendingExecutionNodes({ nodes: [updated], edges: [] }, runs)
  assert.equal(migrated[0], runs[0])
  assert.equal(migrated[1].node.prompt, 'new')
  assert.equal(refreshPendingExecutionNodes({ nodes: [updated], edges: [] }, migrated), migrated)
})

test('compatible migrations refresh failed node bindings while preserving successful paid outputs', () => {
  const paid = { id: 'video', kind: 'video', resultVar: 'video_take', prompt: '', params: [] }
  const stale = { id: 'concat', kind: 'videoConcat', resultVar: 'stage_video', prompt: '', params: [{ id: 'current', name: '本轮分镜视频', required: true, value: '${video_shot}' }] }
  const fixed = { ...stale, params: [{ ...stale.params[0], value: '${video_take}' }] }
  const paidOutput = { url: '/generated/already-paid.mp4' }
  const runs = [
    { node: paid, status: 'success', output: paidOutput },
    { node: stale, status: 'failed', output: { error: 'missing input' } },
  ]
  const refreshed = refreshPendingExecutionNodes({ nodes: [paid, fixed], edges: [{ from: 'video', to: 'concat' }] }, runs)
  assert.equal(refreshed[0], runs[0])
  assert.equal(refreshed[0].output, paidOutput)
  assert.equal(refreshed[1].node, fixed)
  assert.equal(refreshed[1].status, 'failed', 'definition refresh does not erase the visible failure until the user retries it')
})


test('long-dialogue repair provides concrete legal windows without dropping source words', () => {
  const audioText = '冀州官吏：延熹二年诏，宦官单超封为列侯，具瑗、左悺、徐璜、唐衡同日封侯'
  const hint = storyboardDialogueScheduleHint({ audioText }, 3)
  assert.match(hint, /audioText写为/)
  for (const name of ['单超', '具瑗', '左悺', '徐璜', '唐衡']) assert.ok(hint.includes(name))
  assert.equal(storyboardDialogueScheduleHint({ audioText, enteringCharacters: [{ name: '来客' }] }, 3), '')
})

test('actual raised drinking-vessel action fulfills 举杯 without keyword laundering', () => {
  const shot = JSON.parse(readFileSync(new URL('./fixtures/storyboard-raised-cup.json', import.meta.url), 'utf8'))
  const scene = { targetDuration: 15, continuityFromPrevious: false,
    requiredBeats: [{ id: 'beat-05', description: '房家宾客举杯传谣', setting: '房家厅堂', mustShow: ['举杯'] }] }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', shot, { scene, productionSpeechRate: 3, previousShot: { id: 'scene-04' } }))
  for (const falseAction of ['房家宾客甲没有举杯', '房家宾客甲提到举杯', '房家宾客甲必须举杯', '房家宾客甲说出「举杯」', '房家宾客甲说出「举杯，畅饮吧」', '陶樽放在案上']) {
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...shot,
      videoPrompt: `0-4秒：${falseAction}。4-10秒：二人坐定。10-13.5秒：二人对望。13.5-15秒：二人静止。`,
      audioType: '旁白', audioText: '两人谈论举杯。',
    }, { scene, previousShot: { id: 'scene-04' } }), /STORYBOARD_COVERAGE_INCOMPLETE/)
  }
})

test('an unenacted anchor repair copies the named phrase into the shot instead of deleting the obligation', () => {
  const rejected = { beatDramaturgy: [{ beatId: 'beat-01', visual: ['台上案几陈设'] }], videoPrompt: '0-4秒:周福整理台上文书。' }
  const message = 'HISTORY_DRAMA_INVALID: beat-01.visual 仅声明完成，却未落在实际画面动作中：“台上案几陈设”'
  const suffix = buildStoryboardRepairSuffix(message, rejected, '第 1 次校验，修复全部问题')

  assert.match(suffix, /错误已经点名每一条未落地的锚点短语/)
  assert.match(suffix, /只允许在锚点前后补充细节/)
  assert.match(suffix, /禁止在锚点中间插入修饰词/)
  assert.match(suffix, /禁止用删除节拍、清空 beatDramaturgy/)
  assert.match(suffix, /台上案几陈设/)
})
