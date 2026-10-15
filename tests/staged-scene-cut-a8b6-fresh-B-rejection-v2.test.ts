import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertFreshA8B6PhaseBDirectRejectionV2,
  assertFreshA8B6PhaseBRejectionChainV2,
  B_REJECTION_NATIVE_FRAMES_V2,
  B_REJECTION_REPORT_V2,
} from '../server/staged-scene-cut-a8b6-fresh-B-rejection-v2.mjs'

const planId = '1'.repeat(64)
const parentPlanId = '2'.repeat(64)
const taskId = '934079221507838016'
const videoSha256 = '3'.repeat(64)
const frameHashes = new Map(B_REJECTION_NATIVE_FRAMES_V2
  .map((index, position) => [index, String(position + 4).repeat(64)]))
const media = { value: { taskId, videoSha256,
  videoUrl: `/generated/fresh-a8b6-${planId.slice(0, 16)}-B-${taskId}.mp4` },
sha256: '4'.repeat(64) }
const context = { planId, parentPlanId, media,
  plan: { value: { sourceA: { frameIndex: 192,
    frameSha256: '5'.repeat(64) } }, sha256: '6'.repeat(64) },
  acceptedA: { sha256: '7'.repeat(64) },
  native: { frameDigestSha256: '8'.repeat(64), lastPts: 6 },
  frameHashes }
const report = {
  version: B_REJECTION_REPORT_V2,
  planId, phase: 'B', taskId, videoSha256,
  mediaSha256: media.sha256,
  nativeFrameDigestSha256: context.native.frameDigestSha256,
  phaseBPlanSha256: context.plan.sha256,
  sourceA: { sourcePlanId: parentPlanId,
    acceptanceSha256: context.acceptedA.sha256,
    frameIndex: 192, frameSha256: context.plan.value.sourceA.frameSha256 },
  reviewer: 'Codex', reviewedAt: '2026-09-30T01:19:11.000Z',
  verdict: 'reject',
  reviewMethod: 'agent-direct-normal-speed-watch-and-native-frame-inspection',
  playback: { surface: 'browser-1x-session',
    viewerUrl: `http://127.0.0.1:5174${media.value.videoUrl}`,
    sourceUrl: media.value.videoUrl,
    sourceVideoSha256: videoSha256, rate: 1,
    startSeconds: 0, endSeconds: 6, continuous: true,
    observedAt: '2026-09-30T01:17:53.875Z' },
  checks: { actualATailToBFrame1AtOriginalSpeed: true,
    frontWristKnotRemainsVisibleThroughout: true,
    guardsContinueWithdrawalWithoutRegrab: false },
  acceptanceState: 'rejected-native-B; no composite or scene2 may use this media',
  observations: [0, 1.691213, 3.226327, 6].map(timeSeconds => ({
    timeSeconds, description: '原速连续播放见卫士重新抓住已经完成的前腕绳结。' })),
  nativeFrames: B_REJECTION_NATIVE_FRAMES_V2.map(frameIndex => ({
    frameIndex, sha256: frameHashes.get(frameIndex),
    description: '原生帧可见卫士和严颜双腕之间的绳结位置。' })),
  limitations: ['静态帧只说明对应时刻，动作由浏览器原速播放判定。'],
}

test('generic child B rejection can cite regrab while knot remains visible', () => {
  assert.equal(assertFreshA8B6PhaseBDirectRejectionV2(report, context), true)
})

test('child B rejection refuses approval-like or unobserved failure claims', () => {
  for (const changed of [
    { ...report, checks: { ...report.checks,
      guardsContinueWithdrawalWithoutRegrab: true } },
    { ...report, checks: { ...report.checks,
      imaginedUnboundCheck: false } },
    { ...report, verdict: 'accept' },
    { ...report, playback: { ...report.playback, continuous: false } },
    { ...report, playback: { ...report.playback,
      viewerUrl: 'http://127.0.0.1:5174/generated/old-B.mp4' } },
    { ...report, observations: report.observations.filter(item =>
      item.timeSeconds !== 1.691213) },
  ]) assert.throws(() => assertFreshA8B6PhaseBDirectRejectionV2(
    changed, context), /direct child B rejection/)
})

test('child B rejection refuses altered A and native frame evidence', () => {
  assert.throws(() => assertFreshA8B6PhaseBDirectRejectionV2({ ...report,
    sourceA: { ...report.sourceA,
      acceptanceSha256: '0'.repeat(64) } }, context),
  /direct child B rejection/)
  assert.throws(() => assertFreshA8B6PhaseBDirectRejectionV2({ ...report,
    nativeFrames: report.nativeFrames.map(item => item.frameIndex === 48
      ? { ...item, sha256: '0'.repeat(64) } : item) }, context),
  /direct child B rejection/)
  assert.throws(() => assertFreshA8B6PhaseBDirectRejectionV2({ ...report,
    nativeFrames: report.nativeFrames.filter(item =>
      item.frameIndex !== 1) }, context), /direct child B rejection/)
})

test('later B-only rejection binds its rejected predecessor and every forbidden take', () => {
  const prior = { planId: '9'.repeat(64),
    version: 'staged-a8b6-fresh-native-B-rejection-v2',
    parentPlanId, manifestSha256: 'a'.repeat(64),
    childApprovalSha256: 'b'.repeat(64),
    phaseBPlanSha256: 'c'.repeat(64),
    requestSha256: 'd'.repeat(64), taskId,
    taskSha256: 'e'.repeat(64), mediaSha256: 'f'.repeat(64),
    videoUrl: media.value.videoUrl, videoSha256,
    nextPaidPhaseBlocked: true,
    checks: { frontWristKnotRemainsVisibleThroughout: true },
    failedChecks: { guardsContinueWithdrawalWithoutRegrab: false } }
  const rejectionSha256 = '0'.repeat(64)
  const link = { planId: prior.planId,
    manifestSha256: prior.manifestSha256,
    approvalSha256: prior.childApprovalSha256,
    phaseBPlanSha256: prior.phaseBPlanSha256,
    requestSha256: prior.requestSha256,
    taskId: prior.taskId, taskSha256: prior.taskSha256,
    mediaSha256: prior.mediaSha256,
    videoSha256: prior.videoSha256,
    rejectionSha256 }
  const previousManifest = { forbiddenSources: [{ kind: 'old-B',
    url: '/generated/old-B.mp4', sha256: '1'.repeat(64),
    taskId: 'old-task' }] }
  const rejectedVideo = { kind: 'rejected-B-native-video',
    url: prior.videoUrl, sha256: prior.videoSha256, taskId }
  const descendant = { bRetake: { parentPlanId,
    previousChild: link },
  forbiddenSources: [...previousManifest.forbiddenSources, rejectedVideo] }
  const approval = { version: 'staged-a8b6-B-only-retake-approval-v2',
    previousChild: link }
  const input = { planId, manifest: descendant, approval,
    previousRejection: prior, previousRejectionSha256: rejectionSha256,
    previousManifest }
  assert.equal(assertFreshA8B6PhaseBRejectionChainV2(input), true)
  for (const changed of [
    { ...input, approval: { ...approval, previousChild: undefined } },
    { ...input, manifest: { ...descendant,
      forbiddenSources: previousManifest.forbiddenSources } },
    { ...input, manifest: { ...descendant,
      bRetake: { ...descendant.bRetake,
        previousChild: { ...link, rejectionSha256: '2'.repeat(64) } } } },
    { ...input, previousRejection: { ...prior,
      failedChecks: {} } },
  ]) assert.throws(() => assertFreshA8B6PhaseBRejectionChainV2(changed),
    /A8B6_FRESH_B_REJECTION_V2_INVALID/)
})
