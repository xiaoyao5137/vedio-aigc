import test from 'node:test'
import assert from 'node:assert/strict'
import { SCENE_CUT_FIRST_FRAME_PROMPT, SCENE_CUT_FRAME_REVIEW_PROMPT } from '../src/scene-cut-first-frame-gate.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V167, SCENE_CUT_FRAME_REVIEW_PROMPT_V167,
  sceneCutManipulationStartRequired, sceneCutReadableTextForbidden,
  upgradeSceneCutT0ImageContractWorkflow, validateSceneCutT0ImageContract } from '../src/scene-cut-t0-image-contract.ts'

const shot = { visualPrompt: '院落全身画面，无字幕、标题、水印或可读文字；保留长袍下摆和靴。',
  pacing: { beats: [
    { id: 'bind', kind: 'action', textOrVocalization: '军士在双腕收紧绳结',
      completion: { requiredThisClip: true, finalState: '腕部绳结收紧' } },
    { id: 'stand', kind: 'action', textOrVocalization: '严颜挺直背脊',
      completion: { requiredThisClip: true, finalState: '背脊挺直' } },
  ], schedule: [{ beatId: 'bind', startSecond: 0 }, { beatId: 'stand', startSecond: 2 }] } }

const review = { passed: true, requiredVisualActionChecks: [
  { beatId: 'bind', approvedResetBeatId: '', manipulationStartCheck: {
    applicable: true, slackOrGapVisible: true, operatingEndUntensioned: true,
    unfinishedFastenerVisible: true,
    pixelEvidence: '双腕和绳间有空隙；绳端下垂未拉直；结扣仍敞开' } },
  { beatId: 'stand', approvedResetBeatId: '', manipulationStartCheck: { applicable: false } },
], readableTextCheck: { applicable: true, backgroundInspected: true,
  readableGlyphsPresent: false, pixelEvidence: '背景旗、木门、衣甲均无字形' },
wardrobeHemCheck: { applicable: true, originalHemAndFootwear: '长袍下摆遮住大半裤腿，布靴',
  candidateHemAndFootwear: '同样长度下摆、布靴', matches: true } }

test('schema 167 upgrades only two managed prompts and is idempotent', () => {
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 166,
    nodes: [{ id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT },
      { id: 'manual', prompt: '用户自定义' },
      { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT }],
    edges: [{ id: 'edge', from: 'manual', to: 'sanguo-scene-cut-review' }] }
  const next = upgradeSceneCutT0ImageContractWorkflow(graph)
  assert.equal(next.schemaVersion, 167)
  assert.equal(next.nodes[0].prompt, SCENE_CUT_FIRST_FRAME_PROMPT_V167)
  assert.equal(next.nodes[2].prompt, SCENE_CUT_FRAME_REVIEW_PROMPT_V167)
  assert.equal(next.nodes[1], graph.nodes[1])
  assert.equal(next.edges, graph.edges)
  assert.equal(upgradeSceneCutT0ImageContractWorkflow(next), next)
  assert.equal(upgradeSceneCutT0ImageContractWorkflow({ ...next, schemaVersion: 168 }).schemaVersion, 168)
  assert.equal(upgradeSceneCutT0ImageContractWorkflow({ ...graph,
    nodes: graph.nodes.map(node => node.id === 'sanguo-scene-cut-review'
      ? { ...node, prompt: `${node.prompt}\n手工改动` } : node) }).schemaVersion, 166)
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V167, /上身和下装两个局部拼成单张板/)
  assert.doesNotMatch(SCENE_CUT_FIRST_FRAME_PROMPT_V167, /身份参考仅裁取头肩上身/)
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V167, /审核附件仍是原始三视图/)
})

test('t0 manipulation gate requires visible slack, untensioned end and unfinished fastener', () => {
  assert.equal(sceneCutManipulationStartRequired(shot.pacing.beats[0]), true)
  assert.equal(sceneCutManipulationStartRequired(shot.pacing.beats[1]), false)
  assert.equal(sceneCutManipulationStartRequired({ kind: 'action', textOrVocalization: '木门闭合',
    completion: { requiredThisClip: true } }), false)
  assert.equal(validateSceneCutT0ImageContract(review, shot), true)
  for (const key of ['slackOrGapVisible', 'operatingEndUntensioned', 'unfinishedFastenerVisible']) {
    const failed = structuredClone(review)
    failed.requiredVisualActionChecks[0].manipulationStartCheck[key] = false
    assert.throws(() => validateSceneCutT0ImageContract(failed, shot), /SCENE_CUT_FRAME_REJECTED/)
  }
  const missing = structuredClone(review)
  missing.requiredVisualActionChecks[0].manipulationStartCheck.pixelEvidence = ''
  assert.throws(() => validateSceneCutT0ImageContract(missing, shot), /SCENE_CUT_FRAME_REJECTED/)
})

test('explicit uncertainty can be deferred only with a visible operator and uncompleted action', () => {
  const uncertain = structuredClone(review)
  uncertain.advisoryIssues = [{ code: 'TIGHTENING_START_NOT_VERIFIABLE', beatId: 'bind' }]
  const check = uncertain.requiredVisualActionChecks[0]
  check.terminalStateAlreadyPresent = false
  check.actionStillPossible = true
  Object.assign(check.manipulationStartCheck, { slackOrGapVisible: true,
    operatingEndUntensioned: false, unfinishedFastenerVisible: false,
    uncertainStartAdvisory: true, operatorHandAndRopeEndsVisible: true,
    visibilityEvidence: '操作者手和绳端可见，结口局部遮挡' })
  assert.throws(() => validateSceneCutT0ImageContract(uncertain, shot), /SCENE_CUT_FRAME_REJECTED/)
  assert.equal(validateSceneCutT0ImageContract(uncertain, shot,
    { uncertainManipulationAdvisory: true }), true)
  check.terminalStateAlreadyPresent = true
  assert.throws(() => validateSceneCutT0ImageContract(uncertain, shot,
    { uncertainManipulationAdvisory: true }), /SCENE_CUT_FRAME_REJECTED/)
})

test('forbidden readable background text and full-body costume mismatch reject', () => {
  assert.equal(sceneCutReadableTextForbidden(shot), true)
  for (const change of [
    { readableTextCheck: { ...review.readableTextCheck, readableGlyphsPresent: true } },
    { readableTextCheck: { ...review.readableTextCheck, backgroundInspected: false } },
    { wardrobeHemCheck: { ...review.wardrobeHemCheck, matches: false } },
    { wardrobeHemCheck: { ...review.wardrobeHemCheck, applicable: false } },
  ]) assert.throws(() => validateSceneCutT0ImageContract({ ...review, ...change }, shot),
    /SCENE_CUT_FRAME_REJECTED/)
})

test('approved earlier reset may restore a later tightening start', () => {
  const resetShot = { visualPrompt: '帐内中景', pacing: { beats: [
    { id: 'loosen', kind: 'action', completion: { requiredThisClip: true,
      resetsBeatIds: ['retie'] } },
    { id: 'retie', kind: 'action', textOrVocalization: '重新系紧腰带',
      completion: { requiredThisClip: true } },
  ], schedule: [{ beatId: 'loosen', startSecond: 0 }, { beatId: 'retie', startSecond: 3 }] } }
  const resetReview = { passed: true, requiredVisualActionChecks: [
    { beatId: 'loosen', approvedResetBeatId: '' },
    { beatId: 'retie', approvedResetBeatId: 'loosen' }],
    wardrobeHemCheck: { applicable: false } }
  assert.equal(validateSceneCutT0ImageContract(resetReview, resetShot), true)
  assert.throws(() => validateSceneCutT0ImageContract({ ...resetReview,
    requiredVisualActionChecks: [resetReview.requiredVisualActionChecks[0],
      { ...resetReview.requiredVisualActionChecks[1], approvedResetBeatId: 'invalid' }] }, resetShot),
  /SCENE_CUT_FRAME_REJECTED/)
})
