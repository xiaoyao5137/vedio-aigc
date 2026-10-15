import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertFreshA8B6PhaseBDirectRejection,
  verifyFreshA8B6PhaseBRejectionSync,
  REJECTED_B_PLAN_ID as planId,
  REJECTED_B_TASK_ID as taskId,
  REJECTED_B_VIDEO_SHA256 as videoSha256 } from
  '../server/staged-scene-cut-a8b6-fresh-B-rejection.mjs'

const indices = [0, 24, 48, 72, 96, 144]
const frameHashes = new Map(indices.map((index, position) =>
  [index, String(position + 1).repeat(64)]))
const media = { taskId, videoSha256,
  videoUrl: `/generated/fresh-a8b6-${planId.slice(0, 16)}-B-${taskId}.mp4` }
const context = { media, mediaSha256: '7'.repeat(64),
  native: { frameDigestSha256: '8'.repeat(64), lastPts: 6 },
  plan: { sourceA: { frameIndex: 192, frameSha256: '9'.repeat(64) } },
  planSha256: 'a'.repeat(64),
  acceptedA: { acceptanceSha256: 'b'.repeat(64) },
  audioIsolationSha256: 'c'.repeat(64), frameHashes }
const report = {
  version: 'staged-a8b6-fresh-native-B-rejection-report-v1',
  planId, phase: 'B', taskId, videoSha256,
  mediaSha256: context.mediaSha256,
  nativeFrameDigestSha256: context.native.frameDigestSha256,
  phaseBPlanSha256: context.planSha256,
  sourceA: { acceptanceSha256: context.acceptedA.acceptanceSha256,
    frameIndex: 192, frameSha256: context.plan.sourceA.frameSha256 },
  audioIsolationSha256: context.audioIsolationSha256,
  reviewer: 'Codex', reviewedAt: '2026-09-30T00:35:00.000Z',
  verdict: 'reject',
  reviewMethod: 'agent-direct-normal-speed-watch-and-native-frame-inspection',
  playback: { surface: 'browser-1x-session',
    viewerUrl: `http://127.0.0.1:5174${media.videoUrl}`,
    sourceUrl: media.videoUrl, sourceVideoSha256: videoSha256,
    rate: 1, startSeconds: 0, endSeconds: 6,
    continuous: true, observedAt: '2026-09-30T00:29:00.000Z' },
  failedChecks: { frontWristKnotRemainsVisibleThroughout: false,
    boundHandsRemainTogetherThroughout: false },
  acceptanceState: 'rejected-native-B; no composite or scene2 may use this media',
  observations: [
    { timeSeconds: 0, description: '首帧严颜双腕在身前并拢，前腕绳结清楚可见。' },
    { timeSeconds: 1.09, description: '此时双腕仍有绳结，绳索可见。' },
    { timeSeconds: 2.881, description: '双手分到身体两侧，前腕结已从画面消失。' },
    { timeSeconds: 6, description: '尾端严颜两手仍在两侧，身前没有绳结。' },
  ],
  nativeFrames: indices.map(index => ({ frameIndex: index,
    sha256: frameHashes.get(index),
    description: index <= 24
      ? '原生画面严颜双腕并拢，身前绳结可以辨认。'
      : '原生画面严颜双腕已分离，身前绳结不再存在。' })),
  limitations: ['1 倍速连续播放并记录关键时点；静态原生帧只证明对应时点。'],
}

test('failed B report binds paid media, accepted A, 1x watch and native frames', () => {
  assert.equal(assertFreshA8B6PhaseBDirectRejection(report, context), true)
})

test('B rejection refuses fabricated full-speed review or restored knot claim', () => {
  for (const changed of [
    { ...report, playback: { ...report.playback, rate: 2 } },
    { ...report, playback: { ...report.playback, continuous: false } },
    { ...report, failedChecks: {
      ...report.failedChecks, frontWristKnotRemainsVisibleThroughout: true } },
    { ...report, observations: report.observations.filter(item =>
      item.timeSeconds !== 2.881) },
    { ...report, playback: { ...report.playback,
      viewerUrl: 'http://127.0.0.1:5174/generated/different.mp4' } },
  ]) assert.throws(() => assertFreshA8B6PhaseBDirectRejection(
    changed, context), /direct B rejection/)
})

test('B rejection refuses changed native samples, A ancestry or audio proof', () => {
  assert.throws(() => assertFreshA8B6PhaseBDirectRejection({ ...report,
    nativeFrames: report.nativeFrames.map(item => item.frameIndex === 48
      ? { ...item, sha256: '0'.repeat(64) } : item) }, context),
  /direct B rejection/)
  assert.throws(() => assertFreshA8B6PhaseBDirectRejection({ ...report,
    sourceA: { ...report.sourceA, acceptanceSha256: '0'.repeat(64) } },
  context), /direct B rejection/)
  assert.throws(() => assertFreshA8B6PhaseBDirectRejection({ ...report,
    audioIsolationSha256: '0'.repeat(64) }, context), /direct B rejection/)
})

test('retake gate rejects a tampered signed B rejection body', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a8b6-B-reject-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, '.runtime/staged-scene-cut-a8b6-fresh',
    planId)
  await mkdir(directory, { recursive: true })
  const key = Buffer.alloc(32, 7)
  await writeFile(path.join(root, '.runtime/staged-scene-cut.key'), key)
  const body = { version: 'staged-a8b6-fresh-native-B-rejection-v1',
    planId, phase: 'B', failedChecks: {
      frontWristKnotRemainsVisibleThroughout: false } }
  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => `${JSON.stringify(name)}:${canonical(child)}`)
        .join(',')}}` : JSON.stringify(value ?? null)
  const signature = createHmac('sha256', key)
    .update(canonical(body)).digest('hex')
  await writeFile(path.join(directory, 'phase-B-rejection.json'),
    JSON.stringify({ ...body, failedChecks: {
      frontWristKnotRemainsVisibleThroughout: true }, signature }))
  assert.throws(() => verifyFreshA8B6PhaseBRejectionSync(planId, root),
    /phase-B-rejection.json signature changed/)
})
