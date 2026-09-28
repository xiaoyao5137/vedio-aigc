import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptPrincipleMedia, PRINCIPLE_MEDIA_REVIEW_PROMPT, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { newlyRequiredManualMediaDecision, requiresManualMediaDecision, runWorkflowToCompletion } from '../src/workflow-runner.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import type { StepRunStatus } from '../src/workflow-core.ts'

function mediaContext() {
  const shot = { id: 'scene-01', duration: 8, audioType: '旁白', audioText: '刘备攻刘璋。',
    pacing: { version: 'duration-v2', scheduleHash: 'scene-01', speechWindows: [], beats: [
      { textOrVocalization: '队伍沿水道移动，最后停在城门外，船与旗标一直随队伍保留。' },
    ] } }
  const take = { url: '/generated/original.mp4', params: { scheduleHash: 'scene-01' } }
  return { shot_script: shot, video_take: take, video_evidence: {
    decoded: true, originalUrl: take.url, url: '/generated/verified.mp4', evidenceUrl: '/generated/evidence.json',
    duration: 8.04, width: 1280, height: 720, frames: Array.from({ length: 8 }, (_, index) => `/generated/frame-${index}.jpg`),
    frameTimes: [0, 1.14, 2.27, 3.41, 4.55, 5.69, 6.82, 7.96], lastFrameUrl: '/generated/frame-7.jpg',
    hasAudio: true, meanVolumeDb: -20, transcript: [{ start: 1.1, end: 4.1, text: '刘备攻刘章' }],
    speechValidation: { passed: false, phoneticErrorRate: .08, alignment: [], issues: ['ASR 无法确认同音字'] },
  }, media_review: { version: 'principle-review-v1', decision: 'revise', issues: [{
    code: 'core_event_contradiction', problem: '船和队伍进入门洞后从画面消失', repair: '只修复当前镜头末态，保留旁白与沙盘',
    evidence: { source: 'frame', frameIndices: [5, 6, 7], path: 'pacing.beats[0].textOrVocalization',
      quote: '最后停在城门外，船与旗标一直随队伍保留', finding: '第 6、7 帧军队与船消失，旗标独立留在原位' },
  }], warnings: [{ code: 'visual_continuity', problem: '白旗形状不稳定' }] } }
}

const manual = { qualityDisposition: 'manual-review-v1' }

test('manual review pauses only a frame- and script-bound core event contradiction while preserving paid take and report', async () => {
  const input = mediaContext(), before = structuredClone(input)
  const accepted = acceptPrincipleMedia(input, manual)
  assert.equal(accepted.passed, true, 'existing manual acceptance and provider retry budget remain unchanged')
  assert.equal(accepted.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.status, 'needs_attention')
  assert.equal(accepted.qualityReview.automaticRetakeAllowed, false)
  assert.equal(accepted.visualReview.passed, false)
  assert.equal(accepted.qualityReview.principleIssues.length, 1)
  assert.deepEqual(accepted.qualityReview.principleIssues[0].evidence, input.media_review.issues[0].evidence)
  assert.deepEqual(accepted.qualityReview.rawReport, input.media_review)
  assert.equal(accepted.originalUrl, input.video_take.url)
  assert.deepEqual(input, before)
  const code = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input, params: manual })
  assert.equal(code.manualDecisionRequired, true, 'saved code-node runtime gets the same marker')

  const beforeRuns = [
    { id: 'video-1', node: { id: 'sanguo-video' }, status: 'success' as StepRunStatus, output: { url: input.video_take.url } },
    { id: 'accept-1', node: { id: 'sanguo-media-accept' }, status: 'idle' as StepRunStatus, output: undefined as unknown },
    { id: 'concat-1', node: { id: 'sanguo-video-concat' }, status: 'idle' as StepRunStatus, output: undefined as unknown },
  ]
  const calls: string[] = []
  const execute = async (index: number, state: { nodeRuns: typeof beforeRuns }) => {
    const id = state.nodeRuns[index].node.id
    calls.push(id)
    return { nodeRuns: state.nodeRuns.map((run, at) => at === index
      ? { ...run, status: 'success' as StepRunStatus, output: id === 'sanguo-media-accept' ? accepted : { url: '/generated/final.mp4' } } : run) }
  }
  const paused = await runWorkflowToCompletion({ nodeRuns: beforeRuns }, execute)
  assert.deepEqual(calls, ['sanguo-media-accept'])
  assert.equal(paused.nodeRuns[1].status, 'success')
  assert.equal(paused.nodeRuns[2].status, 'idle')
  assert.equal(requiresManualMediaDecision(paused.nodeRuns[1]), true)
  // A saved checkpoint remains actionable after reload. Explicit Continue
  // consumes only the idle successor, never re-runs the paid media prefix.
  const restored = decodeExecutionState<typeof paused>(JSON.parse(JSON.stringify(encodeExecutionState(paused))))
  assert.equal(requiresManualMediaDecision(restored.nodeRuns[1]), true, 'the production storage codec retains the decision marker')
  const resumed = await runWorkflowToCompletion(restored, execute)
  assert.deepEqual(calls, ['sanguo-media-accept', 'sanguo-video-concat'])
  assert.deepEqual(resumed.nodeRuns[1].output, accepted)
  assert.equal(resumed.nodeRuns[2].status, 'success')
})

test('a contradictory issue with verified frame and source evidence pauses even if the report headline says pass', () => {
  const input = mediaContext()
  input.media_review.decision = 'pass'
  const accepted = acceptPrincipleMedia(input, manual)
  assert.equal(accepted.passed, true)
  assert.equal(accepted.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.principleIssues.length, 1)
})

test('an explicit continuing physical state can be rejected from before/after frames without treating costume detail as proof', async () => {
  assert.match(PRINCIPLE_MEDIA_REVIEW_PROMPT, /束缚、持物、伤势.*首帧与中后帧/)
  assert.match(PRINCIPLE_MEDIA_REVIEW_PROMPT, /手部被身体遮挡、单帧模糊.*不猜已经解绑/)
  const input = mediaContext()
  Object.assign(input.shot_script, {
    videoPrompt: '俘虏双腕始终被绳索缚于身前，直到下一个镜头才由将军亲自松开。',
    continuity: { bridgeAnchor: '承接前镜双腕被缚的对峙。' },
  })
  input.media_review.issues = [{
    code: 'core_event_contradiction', problem: '尚未释放时，俘虏两手分开，只有一腕留有绳圈', repair: '局部修复本镜束腕状态，保留已批准台词和其余画面',
    evidence: { source: 'frame', frameIndices: [0, 2, 3, 7], path: 'videoPrompt',
      quote: '俘虏双腕始终被绳索缚于身前', finding: '首帧双腕并拢被缚；第2、3、7帧两手清楚分开，仅一腕留有绳圈，未见解绑动作' },
  }]
  const accepted = acceptPrincipleMedia(input, manual)
  assert.equal(accepted.manualDecisionRequired, true)
  assert.equal(accepted.visualReview.passed, false)
  assert.equal(accepted.qualityReview.principleIssues.length, 1)
  assert.equal(accepted.qualityReview.principleIssues[0].code, 'core_event_contradiction')
  const deployed = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input, params: manual })
  assert.equal(deployed.manualDecisionRequired, true)
  input.media_review.issues[0].evidence.path = 'shot.videoPrompt'
  assert.equal(acceptPrincipleMedia(input, manual).manualDecisionRequired, true,
    'an explicit shot root is accepted only when the exact approved quote still matches')
  input.media_review.issues[0].evidence.path = 'shot_script.videoPrompt'
  assert.equal(acceptPrincipleMedia(input, manual).manualDecisionRequired, true)
  input.media_review.issues[0].evidence.quote = '未在本镜批准的解绑动作'
  assert.equal(acceptPrincipleMedia(input, manual).manualDecisionRequired, false, 'unbound visual allegations stay advisory')
})

test('weak frame proof, uncertainty, stylistic notes and ASR ambiguity do not pause or repurchase media', async () => {
  const cases = [
    (input: ReturnType<typeof mediaContext>) => { input.media_review.issues[0].evidence.frameIndices = [99] },
    (input: ReturnType<typeof mediaContext>) => { input.media_review.issues[0].evidence.quote = '原分镜没有这句话' },
    (input: ReturnType<typeof mediaContext>) => { input.media_review.decision = 'uncertain' },
    (input: ReturnType<typeof mediaContext>) => { input.media_review.issues[0].code = 'slow_pacing' },
    (input: ReturnType<typeof mediaContext>) => { input.media_review.issues = []; input.media_review.decision = 'pass' },
  ]
  for (const mutate of cases) {
    const input = mediaContext(); mutate(input)
    const accepted = acceptPrincipleMedia(input, manual)
    assert.equal(accepted.passed, true)
    assert.equal(accepted.manualDecisionRequired, false)
    assert.equal(accepted.qualityReview.manualDecisionRequired, false)
    assert.equal(accepted.qualityReview.automaticRetakeAllowed, false)
    const calls: string[] = []
    const result = await runWorkflowToCompletion({ nodeRuns: [
      { id: 'accept', node: { id: 'sanguo-media-accept' }, status: 'idle' as StepRunStatus, output: undefined as unknown },
      { id: 'concat', node: { id: 'sanguo-video-concat' }, status: 'idle' as StepRunStatus, output: undefined as unknown },
    ] }, async (index, state) => {
      calls.push(state.nodeRuns[index].id)
      return { nodeRuns: state.nodeRuns.map((run, at) => at === index
        ? { ...run, status: 'success' as StepRunStatus, output: index === 0 ? accepted : { url: '/generated/final.mp4' } } : run) }
    })
    assert.deepEqual(calls, ['accept', 'concat'])
    assert.equal(result.nodeRuns[1].status, 'success')
  }
  const strict = acceptPrincipleMedia(mediaContext())
  assert.equal(strict.passed, false)
  assert.equal(strict.manualDecisionRequired, false, 'strict quality routing remains owned by the existing retry branch')
})

test('new decision detection tolerates a skipped route and ignores an already persisted marker', () => {
  const accepted = acceptPrincipleMedia(mediaContext(), manual)
  const before = [
    { id: 'route', node: { id: 'sanguo-media-observe' }, status: 'idle' as StepRunStatus },
    { id: 'gate', node: { id: 'sanguo-media-accept' }, status: 'idle' as StepRunStatus },
  ]
  const after = [
    { ...before[0], status: 'skipped' as StepRunStatus },
    { ...before[1], status: 'success' as StepRunStatus, output: accepted },
  ]
  assert.equal(newlyRequiredManualMediaDecision(before, after)?.id, 'gate')
  assert.equal(newlyRequiredManualMediaDecision(JSON.parse(JSON.stringify(after)), after), undefined)
})
