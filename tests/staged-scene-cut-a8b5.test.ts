import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { A8B5_TIMELINE, a8b5PhaseBPrompt, mapA8B5Frame,
  planA8B5Continuation, readA8B5Plan, validateA8B5Timeline,
  verifyA8B5CompositeReceipt, verifyA8B5CompositeReceiptSync } from '../server/staged-scene-cut-a8b5.mjs'

const root = process.cwd()
const sourcePlanId = '572e94f20cb92cb21219799693838d6b78a0c6477bac3e94d655ef0e691404f8'
const sourceReady = existsSync(path.join(root, '.runtime/staged-scene-cut', sourcePlanId,
  'phase-A-media.json'))
const savedPlanId = '661ef8939c68bf97409de73194854713f3966e2aea868888694287e626f0d604'
const savedProvisional = existsSync(path.join(root, '.runtime/staged-scene-cut-a8b5',
  savedPlanId, 'provisional-A-review.json'))

test('A8+B5 maps exactly 313 delivered frames without retiming or duplicate B f0', () => {
  assert.equal(validateA8B5Timeline(), true)
  assert.deepEqual(mapA8B5Frame(0), { phase: 'A', sourceFrameIndex: 0, outputFrameIndex: 0 })
  assert.deepEqual(mapA8B5Frame(192), { phase: 'A', sourceFrameIndex: 192, outputFrameIndex: 192 })
  assert.deepEqual(mapA8B5Frame(193), { phase: 'B', sourceFrameIndex: 1, outputFrameIndex: 193 })
  assert.deepEqual(mapA8B5Frame(228), { phase: 'B', sourceFrameIndex: 36, outputFrameIndex: 228 })
  assert.deepEqual(mapA8B5Frame(312), { phase: 'B', sourceFrameIndex: 120, outputFrameIndex: 312 })
  assert.throws(() => mapA8B5Frame(313), /outside 13s timeline/)
  assert.throws(() => validateA8B5Timeline({ ...A8B5_TIMELINE,
    phaseAEndFrame: 180 }), /timeline changed/)
})

test('B prompt forces native A frame192 withdrawal continuation and stop before narration3', () => {
  const prompt = a8b5PhaseBPrompt()
  assert.match(prompt, /真实原生第192帧/)
  assert.match(prompt, /自然继续这一次撤手/)
  assert.match(prompt, /不得重新抓腕、重绑/)
  assert.match(prompt, /第36帧以前.*完全停稳/)
  assert.match(prompt, /第120帧是全镜13秒交付终帧/)
  assert.match(prompt, /画内无人说话或做语言口型/)
})

test('read-only candidate binds this paid source, original TTS, and B raw first frame',
  { skip: !sourceReady }, async () => {
    const plan = await planA8B5Continuation(sourcePlanId, root)
    assert.equal(plan.source.planId, sourcePlanId)
    assert.equal(plan.source.videoSha256,
      '1fee974e72deceb0bd44809551c309dac335875cd7df92a130cce747a8512832')
    assert.equal(plan.source.nativeFrame192Md5, 'c08ba3ed7a3fce86db98337f9a556ada')
    assert.match(plan.source.rejectionSha256, /^[a-f0-9]{64}$/)
    assert.equal(plan.source.oldPlanAStatus,
      'signed-rejected-at-f180; no A acceptance inherited')
    assert.equal(plan.sourceAFrame.sha256,
      '7eb831e0dab7623ef38c45eb41ffcf88d54e5eba79111ce5bbdde34cd9695be7')
    assert.equal(plan.phaseBPreview.firstFrameSha256, plan.sourceAFrame.sha256)
    assert.equal(plan.phaseBPreview.acceptedDuration, 5)
    assert.equal(plan.phaseBPreview.globalStart, 8)
    assert.equal(plan.narrationTracks.length, 3)
    assert.deepEqual(plan.narrationTracks.map((track: { start: number }) => track.start), [0, 2.5, 9.5])
    assert.equal(plan.acceptanceState,
      'none; provisional A only; B and two-shot review pending')
  })

test('an unsigned or missing continuation plan cannot unlock B', async () => {
  await assert.rejects(readA8B5Plan('a'.repeat(64), root), /ENOENT/)
  assert.throws(() => verifyA8B5CompositeReceiptSync('a'.repeat(64), root),
    /ENOENT/)
  await assert.rejects(verifyA8B5CompositeReceipt('a'.repeat(64), root),
    /ENOENT/)
})

test('signed provisional A alone cannot pass the synchronous composite replay gate',
  { skip: !savedProvisional }, () => {
    assert.throws(() => verifyA8B5CompositeReceiptSync(savedPlanId, root),
      /B was rejected or provider failed|ENOENT/)
  })
