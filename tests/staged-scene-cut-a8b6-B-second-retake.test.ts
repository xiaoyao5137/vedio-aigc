import test from 'node:test'
import assert from 'node:assert/strict'
import { freshA8B6PhaseBRetakePrompt,
  freshA8B6PhaseBSecondRetakePrompt } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { assertFreshA8B6BSecondRetakeGuideReview } from
  '../server/staged-scene-cut-a8b6-B-second-retake-target.mjs'

test('second B prompt explicitly forbids the observed guard regrab in every interval', () => {
  const oldPrompt = freshA8B6PhaseBRetakePrompt()
  const newPrompt = freshA8B6PhaseBSecondRetakePrompt()
  assert.notEqual(newPrompt, oldPrompt)
  for (const interval of ['0–1.25 秒', '1.25–3 秒', '3–5 秒',
    '5–6 秒', '全 0–6 秒'])
    assert.ok(newPrompt.includes(interval), `missing ${interval}`)
  assert.match(newPrompt, /绝不转身返回、靠近严颜、伸手到腕部、触碰或重新抓住绳结/)
  assert.match(newPrompt, /军士绝不回身、返步、回到双腕旁、调整已经打好的结/)
  assert.match(newPrompt, /全 0–6 秒禁止任何军士再次接触严颜、已完成的绳结或两只手腕/)
  assert.match(newPrompt, /绳结都保持原位可见/)
  assert.doesNotMatch(oldPrompt, /全 0–6 秒禁止任何军士再次接触/)
})

test('second guide review binds the previous rejected B and guards far from wrists', () => {
  const source = { parentPlanId: '1'.repeat(64),
    previousChildPlanId: '2'.repeat(64),
    previousChildRejectionSha256: '3'.repeat(64),
    output: { sha256: '4'.repeat(64) } }
  const sourceSha256 = '5'.repeat(64)
  const review = { version: 'staged-a8b6-B-second-retake-target-review-v1',
    parentPlanId: source.parentPlanId,
    previousChildPlanId: source.previousChildPlanId,
    previousChildRejectionSha256:
      source.previousChildRejectionSha256,
    sourceReceiptSha256: sourceSha256,
    targetSha256: source.output.sha256,
    reviewer: 'Codex', verdict: 'accept',
    reviewedAt: '2026-09-30T01:20:00.000Z',
    checks: { sameStreetAndFourIdentities: true,
      yanFrontWristKnotClearlyVisible: true,
      zhangAtStopPosition: true,
      bothGuardsFarAwayHandsDown: true,
      guideIsNotAcceptedNativeTail: true },
    observations: [
      '两名军士在远离严颜腕部的位置，双臂自然垂下。',
      '严颜两腕绳结清楚，张飞已经在前方站定。' ],
  }
  assert.equal(assertFreshA8B6BSecondRetakeGuideReview(
    review, source, sourceSha256), true)
  assert.throws(() => assertFreshA8B6BSecondRetakeGuideReview({
    ...review, checks: { ...review.checks,
      bothGuardsFarAwayHandsDown: false } }, source, sourceSha256),
  /visual review incomplete/)
  assert.throws(() => assertFreshA8B6BSecondRetakeGuideReview({
    ...review, previousChildRejectionSha256: '0'.repeat(64) },
  source, sourceSha256), /visual review incomplete/)
})
