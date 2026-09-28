import { storyboardTimelineConsumerCode } from '../src/storyboard-timeline.ts'
import { resolveNativeFrameDisplayInterval } from '../src/media-frame-display.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMediaSamplingReview } from '../src/media-sampling-review.ts'
import { deriveMediaRequirements, validateMediaRequirementChecks } from '../src/media-requirement-coverage.ts'
import { validateMediaEvidenceGaps } from '../src/media-evidence-gaps.ts'
import { deriveAdaptiveMediaSamplingPlan } from '../src/media-adaptive-sampling.ts'

const builders = [deriveMediaSamplingReview, new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});const deriveMediaRequirements=${storyboardTimelineConsumerCode(deriveMediaRequirements)};
  const validateMediaEvidenceGaps=(${validateMediaEvidenceGaps.toString()});
  const validateMediaRequirementChecks=(${validateMediaRequirementChecks.toString()});return (${deriveMediaSamplingReview.toString()});`)() as typeof deriveMediaSamplingReview]
const shot = { duration: 4, videoPrompt: '1-3秒：人物保持持卷姿态，以眼神微动作表现礼貌。',
  storyProgress: { response: '礼貌神态仅为日常闲谈表现，不承担决定、许可或事件回应。' } }
const requirement = deriveMediaRequirements(shot)[0]
const evidence = { duration: 4.04, originalUrl: '/generated/current.mp4', frames: ['first', 'before', 'start', 'middle', 'end', 'after', 'tail'],
  frameTimes: [0, .98, 1, 2, 3, 3.02, 4] }
const policy = { allowNoncriticalEvidenceGaps: true, timingToleranceSeconds: .05 }
const complete = () => ({ requirementId: requirement.id, status: 'complete', evidence: '人物躯干直立，卷宗位于相合双手之间。', frameIndices: [2, 3, 4] })
const unknown = (frameIndices = [2, 4], message = '人物手部部分被袖口遮挡，持卷归属仍无法确认。') =>
  ({ ...complete(), status: 'unobservable', evidence: message, frameIndices })
const warning = () => ({ ...unknown(), evidence: '人物躯干直立，卷宗位于双手之间。', evidenceGaps: [{
  requirementQuote: '以眼神微动作表现礼貌', status: 'unobservable', evidence: '细微眼神过程未捕捉。', frameIndices: [],
  acceptanceImpact: { level: 'warning', policyRule: 'noncritical-performance-variation',
    reason: '该细项不承担行动结果、人物回应、因果或明确节拍，持卷实质义务已有可见依据。',
    contextReferences: [{ sourcePath: 'storyProgress.response', quote: '礼貌神态仅为日常闲谈表现，不承担决定、许可或事件回应。' }] },
}] })
const report = (row: Record<string, unknown>) => ({ decision: 'uncertain', passed: false, requirementChecks: [row] })

test('primary blocking unknown survives independent warning or completion without mutating either report or decision', () => {
  for (const derive of builders) for (const combinedRow of [warning(), complete()]) {
    const primary = report(unknown()), combined = report(combinedRow), before = structuredClone({ primary, combined, shot, evidence })
    const result = derive(primary, combined, shot, evidence, policy)
    assert.deepEqual(result, { decision: 'uncertain', passed: false, requirementChecks: [
      { requirementId: requirement.id, status: 'unobservable', evidence: 'primary原报告：' + primary.requirementChecks[0].evidence, frameIndices: [2, 4] },
    ] })
    assert.deepEqual({ primary, combined, shot, evidence }, before)
    const plan = deriveAdaptiveMediaSamplingPlan(shot, evidence, result, { maxFrames: 24, maxRounds: 2 })!
    assert.deepEqual(plan.requirementIds, [requirement.id])
    assert.ok(plan.sampleTimes.includes(1.5));assert.ok(plan.sampleTimes.includes(2.5))
  }
})

test('duplicate requirements across reports merge their frame union and retain both evidence sources in authored order', () => {
  for (const derive of builders) {
    const primary = report(unknown([2, 3], '主审：持卷接触仍被遮挡。'))
    const combined = report(unknown([3, 4], '独立：卷宗归属仍不清楚。'))
    const result = derive(primary, combined, shot, evidence, policy)
    assert.equal(result.requirementChecks.length, 1)
    assert.deepEqual(result.requirementChecks[0].frameIndices, [2, 3, 4])
    assert.equal(result.requirementChecks[0].evidence, 'primary原报告：主审：持卷接触仍被遮挡。\ncombined派生报告：独立：卷宗归属仍不清楚。')
    assert.equal(derive(report(complete()), combined, shot, evidence, policy).requirementChecks[0].evidence,
      'combined派生报告：独立：卷宗归属仍不清楚。')
  }
})

test('no blocking unknown produces an empty sampling view and never promotes either decision', () => {
  for (const derive of builders) for (const primaryRow of [complete(), warning()]) {
    const primary = report(primaryRow), combined = report(warning())
    assert.deepEqual(derive(primary, combined, shot, evidence, policy), { decision: 'uncertain', passed: false, requirementChecks: [] })
    assert.equal(primary.passed, false);assert.equal(combined.decision, 'uncertain')
  }
})

test('valid tolerance-only references are excluded from the sampling view without narrowing the original requirement', () => {
  for (const derive of builders) {
    const primary = report(unknown([1, 2, 3, 4, 5])), combined = report(complete()), before = structuredClone(primary)
    const result = derive(primary, combined, shot, evidence, policy)
    assert.deepEqual(result.requirementChecks[0].frameIndices, [2, 3, 4]);assert.deepEqual(primary, before)
    assert.equal(deriveMediaRequirements(shot)[0].startSecond, 1);assert.equal(deriveMediaRequirements(shot)[0].endSecond, 3)
    const onlyOutside = derive(report(unknown([1, 5])), combined, shot, evidence, policy)
    assert.deepEqual(onlyOutside.requirementChecks[0].frameIndices, [])
    assert.ok(deriveAdaptiveMediaSamplingPlan(shot, evidence, onlyOutside, { maxFrames: 24, maxRounds: 2 }))
  }
})

test('invalid references, foreign or duplicate requirements and malformed exemptions fail in either source before union', () => {
  for (const derive of builders) {
    const invalidRows = [unknown([0]), unknown([99]), unknown([2, 2]), { ...unknown(), requirementId: 'foreign' },
      { ...unknown(), frameIndices: ['2'] }, { ...unknown(), repair: '重拍' },
      { ...warning(), evidenceGaps: [{ ...warning().evidenceGaps[0], acceptanceImpact: { level: 'warning', reason: '仅猜测。' } }] }]
    for (const row of invalidRows) for (const side of ['primary', 'combined']) {
      const primary = report(side === 'primary' ? row : complete()), combined = report(side === 'combined' ? row : complete())
      assert.throws(() => derive(primary, combined, shot, evidence, policy), /REVIEW_RESULT_INVALID/)
    }
    const duplicate = { ...report(unknown()), requirementChecks: [unknown(), unknown()] }
    assert.throws(() => derive(duplicate, report(complete()), shot, evidence, policy), /必须恰好复核一次/)
    assert.throws(() => derive(report(complete()), {}, shot, evidence, policy), /缺少原要求逐项/)
  }
})
