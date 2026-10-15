import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { phaseAV3Prompt, planPhaseAV3, validateV3Binding,
  V3_GUIDE_FRAME, V3_GUIDE_JPEG_SHA256, V3_GUIDE_NATIVE_MD5,
  V3_REVIEW_FRAMES, V3_SOURCE_V2_PLAN_ID, V3_SOURCE_V2_REJECTION_SHA256,
  V3_APPROVED_FIRST_SHA256, V3_SOURCE_VIDEO_SHA256,
} from '../server/staged-scene-cut-v3-preflight.mjs'
import { a180ContinuationPrompt, validateA180ContinuationBinding,
  PARENT_V2_PLAN_ID, PARENT_V2_TASK_ID, PARENT_V2_MEDIA_SHA256,
  PARENT_V2_REJECTION_SHA256, APPROVED_FIRST_SHA256,
} from '../server/staged-scene-cut-a180-continuation.mjs'
import { stagePrompt, stageReviewPrompt } from '../server/staged-scene-cut.mjs'

const sha = 'a'.repeat(64)

function validV3Binding() {
  return { version: 'staged-scene-cut-shot1-phase-a-v3-preview-v1',
    source: { recordId: 'record-4x5m31-original-repair-tail-guide-v2',
      resultMd5: '34abee4a7c010616b837dbc175b69c56',
      approvedShotSha256: 'cd192f86b554192ef9be23a3f34cb8e643fd6e1aa11144a7e5aa675c832947d7',
      approvalSha256: 'a15360db90b3d45077c95166ec296ee2c168323a75821ef596788e4c9afc4819',
      firstSha256: V3_APPROVED_FIRST_SHA256, rejectedVideoSha256: V3_SOURCE_VIDEO_SHA256,
      identitySha256s: [sha, sha], narrationTrackSha256s: [sha, sha, sha] },
    oldPaidAttempt: { planId: V3_SOURCE_V2_PLAN_ID,
      rejectionSha256: V3_SOURCE_V2_REJECTION_SHA256 },
    endGuide: { sourceFrameIndex: V3_GUIDE_FRAME,
      sourceFrameMd5: V3_GUIDE_NATIVE_MD5, jpegSha256: V3_GUIDE_JPEG_SHA256,
      role: 'reference-only; not an accepted A outcome' },
    timeline: { providerSeconds: 8, acceptedSeconds: 7.5,
      acceptedLastFrame: 180, fps: 24, handsOffByFrame: 132, stationaryThroughFrame: 180 },
    review: { status: 'not-generated; native-and-human-review-required' } }
}

test('v3 requests a released, settled wrist binding ahead of the 7.5-second seam', () => {
  const prompt = phaseAV3Prompt()
  assert.match(prompt, /4\.8–5\.5秒：结绳结束/)
  assert.match(prompt, /双手全部松开严颜手腕和绳索/)
  assert.match(prompt, /第132帧\(5\.5秒\)/)
  assert.match(prompt, /第180帧\(7\.5秒\)/)
  assert.match(prompt, /张飞双脚始终留在左侧原位/)
  assert.deepEqual(V3_REVIEW_FRAMES.filter(index => [132, 156, 180, 192].includes(index)),
    [132, 156, 180, 192])
  assert.match(stagePrompt('B', 'early-binding-v3'), /首帧严颜双腕已在身前绑好/)
  assert.match(stagePrompt('B', 'early-binding-v3'), /1\.3–1\.5秒前完全停稳/)
  const A = stageReviewPrompt('A', { phase: 'A', videoSha256: sha, frames: [] }, 'early-binding-v3')
  assert.match(A, /guardsReleasedByFrame132/)
  assert.match(A, /stableBoundHoldFromFrame132Through180/)
  assert.match(A, /第192帧仅核余量，不得代替第180帧完成态/)
  const B = stageReviewPrompt('B', { phase: 'B', videoSha256: sha, frames: [] }, 'early-binding-v3')
  assert.match(B, /seamContinuity/)
  assert.match(B, /zhangStoppedByFrame36/)
  assert.equal(stagePrompt('A', 'early-binding-v3-retry1'), stagePrompt('A', 'early-binding-v3'))
  assert.equal(stagePrompt('B', 'early-binding-v3-retry1'), stagePrompt('B', 'early-binding-v3'))
  const retryA = stageReviewPrompt('A', { phase: 'A', videoSha256: sha, frames: [] },
    'early-binding-v3-retry1')
  assert.match(retryA, /guardsReleasedByFrame132/)
})

test('v3 source and guide locks reject implicit approval or delayed release', () => {
  const binding = validV3Binding()
  assert.equal(validateV3Binding(binding), true)
  assert.throws(() => validateV3Binding({ ...binding,
    source: { ...binding.source, firstSha256: sha } }), /source, guide, timeline/)
  assert.throws(() => validateV3Binding({ ...binding,
    timeline: { ...binding.timeline, handsOffByFrame: 180 } }), /source, guide, timeline/)
  assert.throws(() => validateV3Binding({ ...binding,
    review: { status: 'accepted' } }), /source, guide, timeline/)
  assert.throws(() => validateV3Binding({ ...binding,
    endGuide: { ...binding.endGuide, sourceFrameIndex: 226 } }), /source, guide, timeline/)
})

test('v3 plan read fails closed without an old signed parent and writes no signing key', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'staged-v3-readonly-'))
  try {
    await assert.rejects(planPhaseAV3(root))
    assert.equal((await import('node:fs')).existsSync(path.join(root, '.runtime/staged-scene-cut.key')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('paid-prefix continuation is explicitly a separate reapproval route', () => {
  const binding = { version: 'staged-scene-cut-a180-continuation-v1',
    parent: { planId: PARENT_V2_PLAN_ID, taskId: PARENT_V2_TASK_ID,
      videoSha256: PARENT_V2_MEDIA_SHA256, rejectionSha256: PARENT_V2_REJECTION_SHA256,
      nativeFrameDigestSha256: sha, frame180JpegSha256: sha },
    source: { recordId: 'record-4x5m31-original-repair-tail-guide-v2',
      resultMd5: '34abee4a7c010616b837dbc175b69c56',
      approvedShotSha256: 'cd192f86b554192ef9be23a3f34cb8e643fd6e1aa11144a7e5aa675c832947d7',
      approvalSha256: 'a15360db90b3d45077c95166ec296ee2c168323a75821ef596788e4c9afc4819',
      firstSha256: APPROVED_FIRST_SHA256, endGuideSha256: sha,
      identitySha256s: [sha, sha], narrationTrackSha256s: [sha, sha, sha] },
    timeline: { aLastFrame: 180, bFirstFrame: 0, bStitchedFirstFrame: 1,
      bLastDeliveredFrame: 132, deliveredFrames: 313, fps: 24,
      narration2End: 7.1, narration3Start: 9.5, handsOffByBFrame: 12,
      stableReleaseByBFrame: 18, zhangStoppedByBFrame: 48 },
    review: { parentAStatus: 'rejected-in-original-plan; partial-prefix-only',
      wholeShotStatus: 'pending-independent-native-and-audio-review',
      originalShotApprovalStatus: 'invalid-for-shifted-schedule; revised-shot-and-fresh-approval-required' } }
  assert.equal(validateA180ContinuationBinding(binding), true)
  assert.match(a180ContinuationPrompt(), /全镜7\.5–8\.0秒/)
  assert.throws(() => validateA180ContinuationBinding({ ...binding,
    review: { ...binding.review, originalShotApprovalStatus: 'accepted' } }), /pending-review boundary/)
})
