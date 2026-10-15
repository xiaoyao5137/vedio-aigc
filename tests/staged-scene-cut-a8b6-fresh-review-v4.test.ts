import assert from 'node:assert/strict'
import test from 'node:test'
import { B3_FRAME_V4_RECOVERY,
  buildFreshA8B6ReviewEvidenceV4,
  freshA8B6FrameChecksV4,
  freshA8B6FrameReviewPromptV4,
  assertFreshA8B6FrameModelLedgerV4,
  assertFreshA8B6V3MarkerUncertaintyForV4 } from
  '../server/staged-scene-cut-a8b6-fresh-review-v4.mjs'

const indices = [84, 108, 120, 132, 144]
const source = { planId: B3_FRAME_V4_RECOVERY.planId, phase: 'B',
  taskId: '934096978895081552',
  videoSha256: B3_FRAME_V4_RECOVERY.videoSha256,
  mediaSha256: 'a'.repeat(64), nativeFrameDigestSha256: 'b'.repeat(64),
  frames: [0, 1, ...indices].map(index => ({
    kind: 'provider-native-frame', phase: 'B', frameIndex: index,
    sourceVideoSha256: B3_FRAME_V4_RECOVERY.videoSha256,
    url: `/generated/B3-f${index}.jpg`,
    sha256: String(index).padStart(64, '0') })) }
const priorV3 = { executionId: B3_FRAME_V4_RECOVERY.v3ExecutionId,
  ledgerSha256: B3_FRAME_V4_RECOVERY.v3LedgerSha256,
  intentSha256: B3_FRAME_V4_RECOVERY.v3IntentSha256,
  submitSha256: B3_FRAME_V4_RECOVERY.v3SubmitSha256,
  evidenceSha256: B3_FRAME_V4_RECOVERY.v3EvidenceSha256,
  reportSha256: 'c'.repeat(64) }
const evidence = buildFreshA8B6ReviewEvidenceV4(source, priorV3)
const checks = Object.fromEntries(freshA8B6FrameChecksV4()
  .map(name => [name, true]))
const report = { version: 'staged-a8b6-fresh-frame-clarification-v4',
  phase: 'B', videoSha256: source.videoSha256, decision: 'accept', checks,
  observations: evidence.frames.map(frame => ({ phase: 'B',
    frameIndex: frame.frameIndex,
    description: '张飞站在严颜左侧近处，双脚着地，面朝严颜。' })),
  issues: [] }
const intent = { modelId: 'codex-local-vision',
  requestKey: `staged-a8b6-fresh-frame-v4:${source.planId}:B:${source.videoSha256}:one-shot` }
const row = { id: 'model-run-v4-clarification', channel: 'workflow',
  workflow_id: 'wf-sanguo-history-drama',
  node_id: 'staged-a8b6-fresh-frame-review-v4',
  model_id: intent.modelId, capability: 'text', provider: 'Codex',
  status: 'succeeded', request_data: {
    operation: 'history.media-review', requestKey: intent.requestKey,
    prompt: freshA8B6FrameReviewPromptV4(evidence),
    params: { reviewImages: evidence.reviewImages },
    reviewImageHashes: evidence.frames.map(frame => ({
      url: frame.url, sha256: frame.sha256 })) },
  response_data: JSON.stringify(report) }

test('B3 clarification sends only five signed native JPEGs and asks observable facts', () => {
  assert.deepEqual(evidence.frames.map(frame => frame.frameIndex), indices)
  assert.equal(evidence.reviewImages.length, 5)
  const prompt = freshA8B6FrameReviewPromptV4(evidence)
  assert.match(prompt, /不假设画面存在地面标线或预设停步坐标/)
  assert.match(prompt, /静态样本不能证明全程运动、1×连续停步/)
  assert.deepEqual(freshA8B6FrameChecksV4(), [
    'zhangNearYanLeftFacingByF120Sample',
    'zhangFeetGroundedAndPoseConsistentAtF120F132F144Samples'])
  assert.equal(assertFreshA8B6FrameModelLedgerV4(
    row, 'B', evidence, intent).accepted, true)
  assert.throws(() => buildFreshA8B6ReviewEvidenceV4({ ...source,
    frames: source.frames.filter(frame => frame.frameIndex !== 132) },
  priorV3), /five native JPEG samples/)
})

test('B3 v4 ledger rejects omitted sample, false visible fact and changed image', () => {
  const missingObservation = { ...row,
    response_data: JSON.stringify({ ...report,
      observations: report.observations.slice(0, -1) }) }
  assert.throws(() => assertFreshA8B6FrameModelLedgerV4(
    missingObservation, 'B', evidence, intent), /five observable B3 samples/)
  const failedFact = { ...row,
    response_data: JSON.stringify({ ...report, decision: 'uncertain',
      checks: { ...checks, zhangNearYanLeftFacingByF120Sample: false },
      issues: ['B:f120 无法看清面部朝向。'] }) }
  assert.equal(assertFreshA8B6FrameModelLedgerV4(
    failedFact, 'B', evidence, intent).accepted, false)
  const changedImage = { ...row, request_data: { ...row.request_data,
    reviewImageHashes: row.request_data.reviewImageHashes.map(
      (frame, index) => index === 2 ? { ...frame,
        sha256: 'd'.repeat(64) } : frame) } }
  assert.throws(() => assertFreshA8B6FrameModelLedgerV4(
    changedImage, 'B', evidence, intent), /attachment 2 changed/)
})

test('a different or accepted v3 review cannot become the B3 clarification', () => {
  assert.throws(() => assertFreshA8B6V3MarkerUncertaintyForV4({
    evidence: source, evidenceSha256: 'd'.repeat(64),
    intent: {}, intentSha256: B3_FRAME_V4_RECOVERY.v3IntentSha256,
    submit: {}, submitSha256: B3_FRAME_V4_RECOVERY.v3SubmitSha256,
    row: {} }), /signed B3 recovery/)
})
