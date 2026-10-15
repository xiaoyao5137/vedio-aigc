import test from 'node:test'
import assert from 'node:assert/strict'
import { freshA8B6PhaseBSecondRetakePrompt,
  freshA8B6PhaseBThirdRetakePrompt } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { assertFreshA8B6BThirdRetakeGuideReview } from
  '../server/staged-scene-cut-a8b6-B-third-retake-target.mjs'

test('third B request holds guards at their original watch areas after B2 contact', () => {
  const prior = freshA8B6PhaseBSecondRetakePrompt()
  const next = freshA8B6PhaseBThirdRetakePrompt()
  assert.notEqual(prior, next)
  assert.match(next, /全 0–6 秒不走近、不撤离、不折返、不抬手、不伸手、不碰严颜身体、手腕或绳结/)
  assert.match(next, /禁止军士再次接触严颜的上臂、身体、双腕或绳结/)
  assert.match(next, /手保持在各自身体旁或原有靠腰姿态/)
  assert.match(next, /只有张飞从左侧原站位以真实速度走近严颜/)
  assert.match(next, /腕结和并拢双腕始终在原位清楚可见/)
  assert.match(next, /最后一秒是稳定自然尾段/)
})

test('third target review requires the static-guard relationship and signed B2 rejection', () => {
  const source = { parentPlanId: '1'.repeat(64),
    previousChildPlanId: '2'.repeat(64),
    previousChildRejectionSha256: '3'.repeat(64),
    output: { sha256: '4'.repeat(64) } }
  const sourceSha256 = '5'.repeat(64)
  const review = { version: 'staged-a8b6-B-third-retake-target-review-v1',
    parentPlanId: source.parentPlanId,
    previousChildPlanId: source.previousChildPlanId,
    previousChildRejectionSha256:
      source.previousChildRejectionSha256,
    sourceReceiptSha256: sourceSha256,
    targetSha256: source.output.sha256,
    reviewer: 'Codex', verdict: 'accept',
    reviewedAt: '2026-09-30T02:00:50.000Z',
    checks: { sameStreetAndFourIdentities: true,
      yanFrontWristKnotClearlyVisible: true,
      zhangAtStopPosition: true,
      bothGuardsRetainOriginalWatchPositionsHandsAway: true,
      guideIsNotAcceptedNativeTail: true },
    observations: [
      '卫士维持严颜左后方和最右侧看押关系，双手离开严颜。',
      '严颜双腕绳结清楚，张飞已在其左侧站定。' ],
  }
  assert.equal(assertFreshA8B6BThirdRetakeGuideReview(
    review, source, sourceSha256), true)
  assert.throws(() => assertFreshA8B6BThirdRetakeGuideReview({
    ...review, checks: { ...review.checks,
      bothGuardsRetainOriginalWatchPositionsHandsAway: false } },
  source, sourceSha256), /visual review incomplete/)
  assert.throws(() => assertFreshA8B6BThirdRetakeGuideReview({
    ...review, previousChildRejectionSha256: '0'.repeat(64) },
  source, sourceSha256), /visual review incomplete/)
})
