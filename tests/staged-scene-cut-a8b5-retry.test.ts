import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { readA8B5BRejection, readA8B5Plan,
  verifyA8B5CompositeReceiptSync } from '../server/staged-scene-cut-a8b5.mjs'
import { a8b5RetryBPrompt, planA8B5Retry, readA8B5RetryPlan,
  previewA8B5RetryRequest } from '../server/staged-scene-cut-a8b5-retry.mjs'

const root = process.cwd()
const previousPlanId = '661ef8939c68bf97409de73194854713f3966e2aea868888694287e626f0d604'
const rejectionReady = existsSync(path.join(root, '.runtime/staged-scene-cut-a8b5',
  previousPlanId, 'phase-B-rejection.json'))
const retryPlanId = '4346beadd2a7fc12c9f4f2991deae63642e3a691954634472dc9b0ae7cb905b2'
const retryReady = existsSync(path.join(root, '.runtime/staged-scene-cut-a8b5',
  retryPlanId, 'manifest.json'))
const retryBRejected = existsSync(path.join(root, '.runtime/staged-scene-cut-a8b5',
  retryPlanId, 'phase-B-rejection.json'))

test('retry prompt demands immediate visible actions and stable hold by B f36', () => {
  const prompt = a8b5RetryBPrompt()
  assert.match(prompt, /第0帧立即开始/)
  assert.match(prompt, /第0至0.25秒/)
  assert.match(prompt, /第0.25至1.5秒/)
  assert.match(prompt, /第36帧之前双脚着地/)
  assert.match(prompt, /第1.5至5秒保持完成后的站位/)
  assert.match(prompt, /第120帧/)
  assert.doesNotMatch(prompt, /重新抓腕|重绑/)
})

test('signed B rejection binds exact paid task, native clip and disqualifying frames',
  { skip: !rejectionReady }, async () => {
    const { report } = await readA8B5BRejection(previousPlanId, root)
    assert.equal(report.taskId, '933813742730084445')
    assert.equal(report.videoSha256,
      '11dec8fb80b62d4d70eec2bfdcb9e03a370990a365259ddccd809d15d7a35eba')
    assert.equal(report.verdict, 'reject')
    assert.equal(report.nextPaidPhaseBlocked, true)
    assert.deepEqual(report.frames.map((frame: { index: number }) => frame.index),
      [0, 6, 18, 24, 36, 66, 114, 120, 144])
  })

test('read-only retry is a distinct signed-source request without paid end frame',
  { skip: !rejectionReady }, async () => {
    const plan = await planA8B5Retry(previousPlanId, root)
    assert.equal(plan.version, 'staged-scene-cut-a8b5-retry-b-v1')
    assert.equal(plan.planId, retryPlanId)
    assert.equal(plan.source.previousPlanId, previousPlanId)
    assert.equal(plan.source.previousBTaskId, '933813742730084445')
    assert.equal(plan.source.previousBVideoSha256,
      '11dec8fb80b62d4d70eec2bfdcb9e03a370990a365259ddccd809d15d7a35eba')
    assert.match(plan.source.previousBRejectionSha256, /^[a-f0-9]{64}$/)
    assert.equal(plan.sourceAFrame.index, 192)
    assert.equal(plan.sourceAFrame.sha256,
      '7eb831e0dab7623ef38c45eb41ffcf88d54e5eba79111ce5bbdde34cd9695be7')
    assert.deepEqual(plan.phaseBPreview.imageTypes, ['reference', 'reference', 'first_frame'])
    assert.equal(plan.phaseBPreview.endFrameSent, false)
    assert.notEqual(plan.phaseBPreview.requestSha256,
      'f8ffe912531a3e9293397a0d6811868c8cb1fdba54751dc5e7bde1a38cc4ee38')
    assert.equal(plan.timeline.deliveredFrames, 313)
    assert.deepEqual(plan.narrationTracks.map((track: { start: number }) => track.start),
      [0, 2.5, 9.5])
  })

test('signed retry preserves request source and refuses an unaccepted 13 second composite',
  { skip: !retryReady }, async () => {
    const manifest = await readA8B5Plan(retryPlanId, root)
    assert.equal(manifest.planId, retryPlanId)
    assert.equal(manifest.source.previousBRejectionSha256,
      'ca5751b84f96b009b545a7512c810786680f88a670413570cc1bcbe1271aab48')
    assert.equal(manifest.phaseBPreview.endFrameSent, false)
    assert.throws(() => verifyA8B5CompositeReceiptSync(retryPlanId, root),
      retryBRejected ? /B was rejected or provider failed/ : /ENOENT/)
  })

test('missing signed retry manifest cannot be used for submission', async () => {
  await assert.rejects(readA8B5RetryPlan('a'.repeat(64), root), /ENOENT/)
  await assert.rejects(previewA8B5RetryRequest('a'.repeat(64), root, true), /ENOENT/)
})
