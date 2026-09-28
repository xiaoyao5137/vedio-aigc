import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCodeNode } from '../server/code-node.ts'
import { acceptPrincipleTextQuality, PRINCIPLE_TEXT_ACCEPT_CODE } from '../src/principle-text-quality.ts'
import { collectPrincipleEditorialFeedback } from '../src/principle-editorial-feedback.ts'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { requiresManualMediaDecision, runWorkflowToCompletion } from '../src/workflow-runner.ts'
import type { StepRunStatus } from '../src/workflow-core.ts'

const manual = { qualityDisposition: 'manual-review-v1' }
const report = (warnings: unknown[]) => ({ version: 'principle-review-v1', decision: 'pass', issues: [], warnings })
const scene = (id: string, drama: string, cast: string[], visual: string[], audio: string[], extra: Record<string, unknown> = {}) => ({
  id, dramaticSceneId: drama, cast, visualTreatment: 'live_action',
  requiredBeats: [{ id: `beat-${id}`, observable: { visual, audio } }], ...extra,
})

// Minimal exact sound/image excerpts from the saved 610, 637 and 693 outlines.
const episode610 = { scenes: [
  scene('scene-01', 'drama-01', [], [
    '低矮盘框围住砂土地形，连续河道由右下伸向左上，江州城池小模型位于左上河岸。',
    '城内灰褐三角旗标保持原位，暗红方旗队伍从右下沿连续的沿江路线移至城外。',
  ], ['刘备攻打刘璋时，部将张飞进抵江州。严颜不降，会怎样？'], { visualTreatment: 'animated', animationStyle: 'historical_map', targetDuration: 8 }),
  scene('scene-02', 'drama-02', ['严颜'], ['严颜的剑被军士从手中夺下，落在脚边。'], ['巴郡太守严颜，抓住了！']),
] }
const episode637 = { scenes: [
  scene('scene-01', 'drama-01', [], [
    '全画幅二维古地图以墨线、淡设色和地形晕染呈现汉中与巴西的相对位置及其间山地。',
    '一条贴合图面的二维路线从汉中向巴西延伸，末端停在巴西区域。',
  ], ['画外旁白：汉末巴西，曹将张郃南下迁民。刘备部将张飞能挡住吗？'], { visualTreatment: 'animated', animationStyle: 'historical_map' }),
  scene('scene-02', 'drama-02', ['张飞'], ['张飞沿营垒内侧走过持盾候命的士卒，一名军士跟到他身侧。'], [
    '匿名军士：将军，和张郃对峙五十多天了，还这么守着？', '张飞：守住这里，不等于能赶他走。',
  ]),
] }
const episode693 = { scenes: [
  scene('scene-01', 'drama-01', [], [
    '阆中城址位于河流沿岸，周围山地以墨线和淡色晕染展开',
    '阆中城址周围缓慢加深设色，河道和城址位置保持不变',
  ], ['画外旁白：章武元年，刘备伐吴，张飞在阆中备兵。严刑能让部下服从吗？'], { visualTreatment: 'animated', animationStyle: 'historical_map' }),
  scene('scene-02', 'drama-02', [], ['帐幕下沿被风轻轻掀起，绷紧的系绳保持原位'], [
    '画外旁白：先回到此前。这样的治兵方式，刘备曾多次劝过张飞。',
  ]),
  scene('scene-03', 'drama-03', ['刘备', '张飞'], ['刘备站在案旁，张飞隔着一步半的距离面对他'], [
    '刘备：你处罚人太重，又总是鞭打军士。', '张飞：不严，军令怎么行？',
  ]),
] }

const mapWarning = {
  code: 'unnecessary_map', itemId: 'scene-01', relatedItemId: 'scene-02',
  evidence: [
    { itemId: 'scene-01', path: 'scenes.0.requiredBeats.0.observable.visual.1', quote: '阆中城址周围缓慢加深设色，河道和城址位置保持不变' },
    { itemId: 'scene-02', path: 'scenes.1.requiredBeats.0.observable.audio.0', quote: '先回到此前。这样的治兵方式，刘备曾多次劝过张飞。' },
  ],
  problem: '地图只让阆中城址加深设色，空帐再次用旁白讲背景；两段没有新增路线或地理因果，连续占用开场，延迟刘备和张飞交锋。',
  repair: '把阆中地点和此前劝诫并入刘备、张飞真人交锋开场。',
}

// Exact structured warning from the single schema154 independent review of
// the preserved 693 candidate (not a simulated quality judgment).
const observed693Warning = {
  code: 'unnecessary_map', itemId: 'scene-01', relatedItemId: 'scene-02',
  evidence: [
    { itemId: 'scene-01', path: 'scenes.0.requiredBeats.0.observable.visual.0', quote: '阆中城址位于河流沿岸，周围山地以墨线和淡色晕染展开' },
    { itemId: 'scene-02', path: 'scenes.1.requiredBeats.0.observable.visual.0', quote: '帐幕下沿被风轻轻掀起，绷紧的系绳保持原位' },
  ],
  problem: '地图虽呈现城址、河流与山地，但这些空间关系没有影响随后劝诫、拒绝换值或近身当值的选择，缺少本集因果所需的独立地理增量。地图后又接无人帐幕与回溯旁白，两段连续铺陈使实际行动人物到第三场才进入。将时地和回溯信息简短交代后，仍能完整理解本集冲突。',
  repair: '建议回大纲合并这两段说明，将必要时地及此前多次告诫的信息并入scene-03开端，从刘备批评与张飞反问的阻力切入；保留原有对答、动作及回溯关系，不必另设地图与空帐幕两个独立短段。',
}

test('693 evidence-bound map plus empty tent pauses before downstream work without changing accepted candidate or verdict', async () => {
  const candidate = structuredClone(episode693), review = report([mapWarning])
  const inputBefore = structuredClone(candidate)
  const accepted = acceptPrincipleTextQuality({ candidate, review, ...manual })
  assert.equal(accepted.passed, true)
  assert.deepEqual(accepted.issues, [])
  assert.deepEqual(accepted.scenes, candidate.scenes)
  assert.deepEqual(candidate, inputBefore)
  assert.deepEqual(accepted.qualityReview.rawReport, review)
  assert.deepEqual(accepted.qualityReview.warnings[0], mapWarning)
  assert.equal(accepted.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.editorialHold?.findings.length, 1)
  assert.deepEqual(collectPrincipleEditorialFeedback(accepted).map(row => [row.status, row.itemId]), [
    ['located', 'scene-01'], ['located', 'scene-02'],
  ], 'the paused review shows both adjacent observations as located')
  assert.equal(accepted.qualityReview.automaticRetakeAllowed, false)
  const deployed = await executeCodeNode({ code: PRINCIPLE_TEXT_ACCEPT_CODE, params: { candidate, review, ...manual }, context: {} })
  assert.equal(deployed.manualDecisionRequired, true, 'persisted code-node runtime has the same guard')

  const runs = [
    { id: 'writer', node: { id: 'sanguo-scene-outline' }, status: 'success' as StepRunStatus, output: candidate },
    { id: 'review', node: { id: 'sanguo-scene-outline-review' }, status: 'success' as StepRunStatus, output: review },
    { id: 'gate', node: { id: 'sanguo-scene-outline-accept' }, status: 'idle' as StepRunStatus, output: undefined as unknown },
    { id: 'video', node: { id: 'sanguo-video' }, status: 'idle' as StepRunStatus, output: undefined as unknown },
  ]
  const calls: string[] = []
  const execute = async (index: number, state: { nodeRuns: typeof runs }) => {
    calls.push(state.nodeRuns[index].id)
    return { nodeRuns: state.nodeRuns.map((run, at) => at === index
      ? { ...run, status: 'success' as StepRunStatus, output: index === 2 ? accepted : { url: '/generated/video.mp4' } } : run) }
  }
  const paused = await runWorkflowToCompletion({ nodeRuns: runs }, execute)
  assert.deepEqual(calls, ['gate'])
  assert.equal(paused.nodeRuns[2].status, 'success')
  assert.equal(paused.nodeRuns[3].status, 'idle')
  assert.equal(requiresManualMediaDecision(paused.nodeRuns[2]), true)
  const restored = decodeExecutionState<typeof paused>(JSON.parse(JSON.stringify(encodeExecutionState(paused))))
  assert.equal(requiresManualMediaDecision(restored.nodeRuns[2]), true)
  const continued = await runWorkflowToCompletion(restored, execute)
  assert.deepEqual(calls, ['gate', 'video'])
  assert.equal(continued.nodeRuns[3].status, 'success')
  assert.deepEqual(continued.nodeRuns[0].output, candidate)
})

test('the real schema154 693 review pauses only for its two grounded adjacent empty scenes', async () => {
  const actual = report([observed693Warning])
  const accepted = acceptPrincipleTextQuality({ candidate: episode693, review: actual, ...manual })
  assert.equal(accepted.passed, true)
  assert.equal(accepted.manualDecisionRequired, true)
  assert.deepEqual(accepted.qualityReview?.editorialHold?.findings, [observed693Warning])
  assert.deepEqual(accepted.qualityReview?.rawReport, actual)
  const vm = await executeCodeNode({ code: PRINCIPLE_TEXT_ACCEPT_CODE,
    params: { candidate: episode693, review: actual, ...manual }, context: {} })
  assert.equal(vm.manualDecisionRequired, true)

  const shortMapThenActors = { scenes: [episode693.scenes[0], episode693.scenes[2]] }
  const warningOnActors = { ...observed693Warning, relatedItemId: 'scene-03', evidence: [
    observed693Warning.evidence[0],
    { itemId: 'scene-03', path: 'scenes.1.requiredBeats.0.observable.visual.0', quote: '刘备站在案旁，张飞隔着一步半的距离面对他' },
  ] }
  assert.equal(acceptPrincipleTextQuality({ candidate: shortMapThenActors,
    review: report([warningOnActors]), ...manual }).manualDecisionRequired, false,
  'a single short map followed directly by character conflict must remain eligible')
  const routeWarning = { ...observed693Warning, evidence: [
    { itemId: 'scene-01', path: 'scenes.0.requiredBeats.0.observable.visual.1', quote: '一条贴合图面的二维路线从汉中向巴西延伸，末端停在巴西区域。' },
    { itemId: 'scene-02', path: 'scenes.1.requiredBeats.0.observable.visual.0', quote: '张飞沿营垒内侧走过持盾候命的士卒，一名军士跟到他身侧。' },
  ] }
  assert.equal(acceptPrincipleTextQuality({ candidate: episode637,
    review: report([routeWarning]), ...manual }).manualDecisionRequired, false,
  'an actually routed 637 map must remain eligible even under the mistaken 693 warning')
})

test('610 and 637 route-bearing maps proceed despite a mistaken structured map warning', () => {
  for (const [candidate, visual] of [
    [episode610, '城内灰褐三角旗标保持原位，暗红方旗队伍从右下沿连续的沿江路线移至城外。'],
    [episode637, '一条贴合图面的二维路线从汉中向巴西延伸，末端停在巴西区域。'],
  ] as const) {
    const warning = { ...mapWarning, evidence: [
      { itemId: 'scene-01', path: 'scenes.0.requiredBeats.0.observable.visual.1', quote: visual },
      { itemId: 'scene-02', path: 'scenes.1.requiredBeats.0.observable.visual.0', quote: candidate.scenes[1].requiredBeats[0].observable.visual[0] },
    ] }
    const accepted = acceptPrincipleTextQuality({ candidate, review: report([warning]), ...manual })
    assert.equal(accepted.passed, true)
    assert.equal(accepted.manualDecisionRequired, false)
    assert.deepEqual(accepted.qualityReview.warnings[0], warning)
  }
})

test('the submitted 637 and 693 reviewer warnings remain intact, advisory, and do not invent a new code', () => {
  // These are excerpts of the two already-submitted schema-152 text reviewer
  // responses. Their earlier prompt used path/quote/relatedEvidence, not the
  // new code + two-evidence contract; do not reinterpret paid historical runs.
  const actual637 = { itemId: 'scene-01', path: 'scenes.0.requiredBeats.0.observable.visual.1',
    quote: '一条贴合图面的二维路线从汉中向巴西延伸，末端停在巴西区域。',
    problem: '地图交代了进军方向，但没有显示影响张飞下一步选择的路线分歧、阻隔或两军空间关系。相邻真人戏的压力是长期相持，解决方式是改道截击；这两者并不依赖当前地图提供的空间信息。',
    relatedEvidence: [{ itemId: 'scene-02', path: 'scenes.1.requiredBeats.0.observable.audio.0',
      quote: '匿名军士：将军，和张郃对峙五十多天了，还这么守着？' }],
    repair: '建议回大纲评估以scene-02的人物问答开场，将必要时地、双方身份和迁民背景并入该段。' }
  const actual693 = { itemId: 'scene-01', path: 'scenes.0.requiredBeats.0.observable.visual.1',
    quote: '阆中城址周围缓慢加深设色，河道和城址位置保持不变',
    problem: '地图只展示城址与周边山川，没有呈现影响本集选择或结果的路线、阻隔或势力空间关系。紧接的无人帐幕继续交代背景，实际人物冲突到第三场才开始。',
    relatedEvidence: [{ itemId: 'scene-02', path: 'scenes.1.requiredBeats.0.observable.visual.0',
      quote: '帐幕下沿被风轻轻掀起，绷紧的系绳保持原位' }],
    repair: '建议回大纲评估以刘备劝诫遭到张飞反问的真人冲突开场。' }
  for (const [candidate, warning] of [[episode637, actual637], [episode693, actual693]] as const) {
    const review = report([warning]), accepted = acceptPrincipleTextQuality({ candidate, review, ...manual })
    assert.equal(accepted.passed, true)
    assert.equal(accepted.manualDecisionRequired, false)
    assert.deepEqual(accepted.qualityReview.warnings[0], warning)
    assert.deepEqual(accepted.qualityReview.rawReport, review)
  }
})

test('stale, metadata, single-scene, uncertain and generic style reports stay advisory', () => {
  const variants = [
    { ...mapWarning, evidence: [{ ...mapWarning.evidence[0], quote: '候选已经改掉的地图描述' }, mapWarning.evidence[1]] },
    { ...mapWarning, evidence: [{ ...mapWarning.evidence[0], path: 'scenes.0.purpose', quote: '地图只让阆中城址加深设色' }, mapWarning.evidence[1]] },
    { ...mapWarning, relatedItemId: 'scene-03' },
    { ...mapWarning, evidence: [mapWarning.evidence[0], { ...mapWarning.evidence[1], itemId: 'scene-01' }] },
    { ...mapWarning, problem: '地图可能不够生动，可以更有电影感。' },
    { ...mapWarning, repair: '再试试' },
  ]
  for (const warning of variants) {
    const accepted = acceptPrincipleTextQuality({ candidate: episode693, review: report([warning]), ...manual })
    assert.equal(accepted.manualDecisionRequired, false)
    assert.deepEqual(accepted.qualityReview.warnings[0], warning)
  }
  const uncertain = acceptPrincipleTextQuality({ candidate: episode693,
    review: { ...report([mapWarning]), decision: 'uncertain' }, ...manual })
  assert.equal(uncertain.manualDecisionRequired, false)
  const strict = acceptPrincipleTextQuality({ candidate: episode693, review: report([mapWarning]) })
  assert.equal(strict.manualDecisionRequired, false)
  assert.equal(strict.passed, true)
})

test('adjacent same-drama repeated action holds only with two grounded leaves and a concrete no-delta finding', () => {
  const candidate = { scenes: [
    scene('scene-08', 'drama-05', ['张飞'], ['受罚军士用左手护住右臂，在帐内站定。'], ['张飞：站到我旁边。']),
    scene('scene-09', 'drama-05', ['张飞'], ['受罚军士仍用左手护住右臂，在同一处站定。'], ['张飞：就在我旁边站着。']),
  ] }
  const warning = { code: 'repeated_action_without_delta', itemId: 'scene-09', relatedItemId: 'scene-08',
    evidence: [
      { itemId: 'scene-08', path: 'scenes.0.requiredBeats.0.observable.visual.0', quote: '受罚军士用左手护住右臂，在帐内站定。' },
      { itemId: 'scene-09', path: 'scenes.1.requiredBeats.0.observable.visual.0', quote: '受罚军士仍用左手护住右臂，在同一处站定。' },
    ],
    problem: '后一段再次让受罚军士护着右臂原地站定，没有新增压力、选择或回应，张飞与军士的局面未推进。',
    repair: '两段合并，只保留一次站位命令；若保留后一段，应补出当场新的选择。',
  }
  const accepted = acceptPrincipleTextQuality({ candidate, review: report([warning]), ...manual })
  assert.equal(accepted.manualDecisionRequired, true)
  const movedDrama = { scenes: candidate.scenes.map((row, index) => index ? { ...row, dramaticSceneId: 'drama-06' } : row) }
  assert.equal(acceptPrincipleTextQuality({ candidate: movedDrama, review: report([warning]), ...manual }).manualDecisionRequired, false)
  const real693NewPressure = { scenes: [
    scene('scene-08', 'drama-05', ['张飞'], ['受罚军士跪在帐内空地，右上臂衣料留有鞭痕'], ['张飞：起来。今天仍在我身边当值。']),
    scene('scene-09', 'drama-05', ['张飞'], ['受罚军士以左手护着右臂，站在原地'], [
      '受罚军士：将军，能让我先换下吗？这只胳膊抬不起来。', '张飞：伤处包好。还是你当值。',
    ]),
  ] }
  const generic = { ...warning, evidence: [
    { itemId: 'scene-08', path: 'scenes.0.requiredBeats.0.observable.visual.0', quote: '受罚军士跪在帐内空地，右上臂衣料留有鞭痕' },
    { itemId: 'scene-09', path: 'scenes.1.requiredBeats.0.observable.visual.0', quote: '受罚军士以左手护着右臂，站在原地' },
  ], problem: '动作看起来相似，但军士新增换岗请求，张飞明确拒绝，人物选择和风险已经改变。' }
  assert.equal(acceptPrincipleTextQuality({ candidate: real693NewPressure, review: report([generic]), ...manual }).manualDecisionRequired, false)
})
