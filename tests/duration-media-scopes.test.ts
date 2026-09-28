import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMediaRequirements, validateMediaRequirementChecks } from '../src/media-requirement-coverage.ts'
import { deriveRequirementReviewInputs, combineIndependentMediaReviews } from '../src/media-requirement-review.ts'
import { deriveAdaptiveMediaSamplingPlan } from '../src/media-adaptive-sampling.ts'
import { validateMediaDefectEvidence } from '../src/media-defect-evidence.ts'
import { validateMediaEvidenceGaps } from '../src/media-evidence-gaps.ts'
import { resolveNativeFrameDisplayInterval } from '../src/media-frame-display.ts'
import { validateScriptStateEvidence } from '../src/script-state-evidence.ts'
import { storyboardTimelineMatches } from '../src/storyboard-timeline.ts'

function fixture() {
  const refQuote = '（节拍 response）乡人点头回应；完成态：恢复抬头姿态。'
  const hardQuote = '（节拍 handoff）来客必须在第三秒之前接住竹简；完成态：来客双手持竹简。'
  const tailQuote = '保持已完成动作的自然结果。'
  const reference = { mode: 'reference' }, hard = { mode: 'hard', deadlineSecond: 3 }
  const shot = { duration: 8, videoPrompt: `0-3秒：${refQuote}同时，${hardQuote}\n3-8秒：${tailQuote}`,
    pacing: { version: 'duration-v2', scheduleHash: 'a', beats: [
      { id: 'response', sourceBeatId: 'required-response', timingConstraint: reference },
      { id: 'handoff', sourceBeatId: 'required-handoff', timingConstraint: hard } ],
      schedule: [
        { beatId: 'response', sourceBeatId: 'required-response', startSecond: 0, endSecond: 3, timingConstraint: reference },
        { beatId: 'handoff', sourceBeatId: 'required-handoff', startSecond: 1, endSecond: 3, timingConstraint: hard } ],
      timelineWindows: [ { startSecond: 0, endSecond: 3, beatIds: ['response', 'handoff'],
        beatQuotes: [{ beatId: 'response', quote: refQuote }, { beatId: 'handoff', quote: hardQuote }] },
      { startSecond: 3, endSecond: 8, beatIds: [], beatQuotes: [] } ] } }
  const frameTimes = [0, 1, 2, 3, 5, 6, 7.96]
  const evidence = { decoded: true, duration: 8, originalUrl: 'https://example.test/video.mp4', url: '/generated/verified.mp4',
    frameTimes, frames: frameTimes.map((_, i) => '/generated/frame-' + i + '.jpg') }
  return { shot, evidence, refQuote, hardQuote }
}

const embedded = new Function(`const storyboardTimelineMatches=(${storyboardTimelineMatches.toString()});
const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});
const validateMediaEvidenceGaps=(${validateMediaEvidenceGaps.toString()});
const validateScriptStateEvidence=(${validateScriptStateEvidence.toString()});
const deriveMediaRequirements=(${deriveMediaRequirements.toString()});
return {deriveMediaRequirements,validateMediaRequirementChecks:(${validateMediaRequirementChecks.toString()}),
deriveRequirementReviewInputs:(${deriveRequirementReviewInputs.toString()}),combineIndependentMediaReviews:(${combineIndependentMediaReviews.toString()}),
deriveAdaptiveMediaSamplingPlan:(${deriveAdaptiveMediaSamplingPlan.toString()}),validateMediaDefectEvidence:(${validateMediaDefectEvidence.toString()})};`)() as {
  deriveMediaRequirements: typeof deriveMediaRequirements; validateMediaRequirementChecks: typeof validateMediaRequirementChecks;
  deriveRequirementReviewInputs: typeof deriveRequirementReviewInputs; combineIndependentMediaReviews: typeof combineIndependentMediaReviews;
  deriveAdaptiveMediaSamplingPlan: typeof deriveAdaptiveMediaSamplingPlan; validateMediaDefectEvidence: typeof validateMediaDefectEvidence;
}
const implementations = [{ deriveMediaRequirements, validateMediaRequirementChecks, deriveRequirementReviewInputs, combineIndependentMediaReviews,
  deriveAdaptiveMediaSamplingPlan, validateMediaDefectEvidence }, embedded]

test('mixed reference and hard timing requirements remain separate with verbatim source quotes', () => {
  for (const api of implementations) {
    const f = fixture(), original = structuredClone(f), requirements = api.deriveMediaRequirements(f.shot)
    assert.equal(requirements.length, 3)
    assert.deepEqual(requirements.slice(0, 2).map(r => r.requirementQuote), [f.refQuote, f.hardQuote])
    assert.deepEqual(requirements.slice(0, 2).map(r => [r.startSecond, r.endSecond]), [[0, 3], [0, 3]], '保留原排程窗')
    assert.deepEqual(requirements.slice(0, 2).map(r => r.eventSearchRanges!.map(s => [s.startSecond, s.endSecond])), [[[0, 8]], [[0, 3]]])
    assert.equal(requirements[2].eventSearchRanges, undefined, '尾部自然结果仍按原要求范围')
    assert.deepEqual(f, original)
    const inputs = api.deriveRequirementReviewInputs(f.shot, f.evidence)
    assert.deepEqual(inputs[0].frameReferences.map(frame => frame.second), f.evidence.frameTimes)
    assert.deepEqual(inputs[1].frameReferences.map(frame => frame.second), [0, 1, 2, 3])
    assert.ok(inputs[0].compatibleRequirements.some(r => r.overlapEndSecond === 3), '事件查找不能把同窗约束自动扩成全片义务')
  }
})

test('missing, rewritten or crossed beat quotations cannot manufacture a new discovery scope', () => {
  for (const api of implementations) for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.shot.pacing.timelineWindows[0].beatQuotes.pop() },
    (f: ReturnType<typeof fixture>) => { f.shot.pacing.timelineWindows[0].beatQuotes[0].quote = '已点头' },
    (f: ReturnType<typeof fixture>) => { f.shot.pacing.timelineWindows[0].beatQuotes.reverse() },
    (f: ReturnType<typeof fixture>) => { f.shot.pacing.schedule[1].timingConstraint = { mode: 'reference' } },
  ]) {
    const f = fixture(); mutate(f)
    assert.throws(() => api.deriveMediaRequirements(f.shot), /MEDIA_REQUIREMENTS_INVALID/)
  }
})

test('late reference action has evidence but hard action cannot borrow its late frames', () => {
  for (const api of implementations) {
    const f = fixture(), reqs = api.deriveMediaRequirements(f.shot)
    const review = { requirementChecks: reqs.map((r, i) => ({ requirementId: r.id, status: 'complete',
      frameIndices: i === 0 ? [4, 5] : i === 1 ? [2, 3] : [6], evidence: '实际帧显示本项人物和动作的结束姿态。' })) }
    assert.deepEqual(api.validateMediaRequirementChecks(review, f.shot, f.evidence).issues, [])
    review.requirementChecks[1].frameIndices = [4, 5]
    assert.throws(() => api.validateMediaRequirementChecks(review, f.shot, f.evidence, { timingTolerance: 10 }), /引用帧不在原要求/)
  }
})

test('adaptive sampling discovers late reference events but preserves each hard boundary', () => {
  for (const api of implementations) for (const target of ['response', 'handoff']) {
    const f = fixture(), reqs = api.deriveMediaRequirements(f.shot)
    const review = { requirementChecks: reqs.map(r => ({ requirementId: r.id,
      status: r.timingBeatId === target ? 'unobservable' : 'complete', evidence: '需要连续帧确认本节拍过程。', frameIndices: [] })) }
    const config = { maxFrames: 8, maxRounds: 1, nativeSequence: true, nativeReviewMaxFrames: 160 }
    const first = api.deriveAdaptiveMediaSamplingPlan(f.shot, f.evidence, review, config)!
    const additions = first.sampleTimes.filter(second => !f.evidence.frameTimes.includes(second))
    assert.equal(additions.length, 1)
    if (target === 'response') assert.ok(additions.some(second => second > 3))
    else assert.ok(additions.every(second => second <= 3))
    const actual = { ...f.evidence, frameTimes: first.sampleTimes, frames: first.sampleTimes.map((_, i) => '/generated/more-' + i + '.jpg') }
    const native = api.deriveAdaptiveMediaSamplingPlan(f.shot, actual, review, config, first)!
    assert.deepEqual(native.nativeSequence!.windows, [{ start: 0, end: target === 'response' ? 8 : 3 }])
  }
})

test('reference defect binds actual event and original timing beat; mixed hard quote cannot escape its boundary', () => {
  for (const api of implementations) {
    const f = fixture()
    const row = { issueIndex: 0, status: 'confirmed', category: 'script', source: 'frame', requirementPath: 'videoPrompt',
      requirementQuote: f.refQuote, scope: 'interval', startSecond: 5, endSecond: 6, timingBeatId: 'response', sourceBeatId: 'required-response',
      frameIndices: [4, 5], finding: '回应结束位置中头部保持低垂，与本项结束态相反。', repair: '保留其他剧情，呈现回应后抬头的结果。' }
    const review = { issues: ['回应未结束'], defectEvidence: [row], durationCompletion: { checks: [{ beatId: 'response', sourceBeatId: 'required-response',
      observedStart: { lower: 5, upper: 5 }, observedEnd: { lower: 6, upper: 6 } }] } }
    assert.deepEqual(api.validateMediaDefectEvidence(review, f.evidence, { shot: f.shot }).issues, ['回应未结束'])
    review.durationCompletion.checks = []
    assert.throws(() => api.validateMediaDefectEvidence(review, f.evidence, { shot: f.shot }), /实际事件区间/)
    Object.assign(row, { requirementQuote: f.hardQuote, timingBeatId: 'handoff', sourceBeatId: 'required-handoff' })
    assert.throws(() => api.validateMediaDefectEvidence(review, f.evidence, { shot: f.shot, policy: { timingTolerance: 10 } }), /时间范围超出原要求|引用帧不在/)
  }
})
