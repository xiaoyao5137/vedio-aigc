import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateDurationCalibration, durationCalibrationRecord, durationExecutionSummary, deriveDurationMetrics } from '../src/duration-observability.ts'
import { DEFAULT_DURATION_POLICY } from '../src/duration-policy.ts'

const shot = { duration: 9, timingEstimate: { plannedDuration: 8, contentEndBudget: 8.2, safeEndBudget: 8.7, endingReadabilityReserve: .5 },
  pacing: { version: 'duration-v2', scheduleHash: 'schedule', timingPolicy: { version: 'duration-policy-v2.1' }, beats: [{ deliveryStyle: 'singing', actorIds: ['singer'] }] } }
const evidence = { url: '/generated/take.mp4', decoded: true, duration: 9.04, sourceSha256: 'a'.repeat(64),
  speechMetrics: [{ text: '天下规矩房伯武', actualStart: .37, actualEnd: 4.99, utteranceCandidateStart: .37, utteranceCandidateEnd: 5.53,
    timingReliable: false, boundaryStatus: 'uncertain', timingAssessment: 'within-allowance' }] }
const completed = { ...evidence, passed: true, durationCompletion: { assessment: 'complete', passed: true,
  actualCompletionInterval: { lower: 8, upper: 8.2 }, checks: [] } }
const calibration = (id: number, extra = {}) => durationCalibrationRecord({ shot, video: { ...completed, sourceSha256: id.toString(16).padStart(64, '0'), ...extra }, modelVersion: 'kling-3.0' })

test('v2 chant metrics expose only the shared clock and cannot label time after lyrics as confirmed idle', () => {
  const current = { duration: 11, pacing: { version: 'duration-v2', timingPolicy: DEFAULT_DURATION_POLICY,
    speechWindows: [{ start: 1.8, end: 7.3, beatId: 'song', deliveryStyle: 'chant' }], beats: [] } }
  const raw = { duration: 11.04, speechValidation: { lastSpeechEnd: 7.26 },
    speechMetrics: [{ elapsed: 4.84, timingReliable: true, boundaryStatus: 'reliable' }] }
  const legacy = { policy: { minSpeechRate: 3.3, tailSeconds: .3, maxIdleTailSeconds: 1.2, timingToleranceSeconds: .25 } }
  const metric = deriveDurationMetrics(current, raw, legacy)
  const policy = metric.policy as Record<string, unknown>
  const tail = metric.tailTiming as Record<string, unknown>
  assert.equal(policy.minSpeechRate, undefined)
  assert.equal(policy.tailSeconds, .5)
  assert.deepEqual(policy.timingPolicy, DEFAULT_DURATION_POLICY)
  assert.equal((metric.speech as Record<string, unknown>[])[0].timingAssessment, 'within-allowance')
  assert.equal((metric.speech as Record<string, unknown>[])[0].deliveryStyle, 'chant')
  assert.equal(tail.assessment, 'uncertain', 'post-lyric time may contain required response actions or untranscribed vocalizations')
  assert.equal((deriveDurationMetrics(current, { ...raw, duration: 7.5 }, legacy).tailTiming as Record<string, unknown>).assessment, 'outside-allowance')
  assert.equal(deriveDurationMetrics({ pacing: { version: 'dynamic-v1' } }, raw, legacy), legacy)
})

test('execution diagnosis distinguishes planned, decoded, failed and accepted states', () => {
  assert.equal(durationExecutionSummary({ unrelated: true }), undefined)
  const planned = durationExecutionSummary({ shot_script: shot })!
  assert.equal(planned.status, '待生成')
  assert.equal(planned.plan, 8)
  assert.equal(planned.contentBudget, 8.2)
  assert.equal(planned.safeBudget, 8.7)
  assert.equal(planned.requested, 9)
  assert.equal(planned.actual, null)
  const decoded = durationExecutionSummary({ shot_script: shot, video_evidence: evidence })!
  assert.equal(decoded.status, '待审核')
  assert.equal(decoded.actual, 9.04)
  assert.equal(decoded.completion, 'uncertain')
  assert.equal(decoded.speech[0].timingAssessment, 'uncertain')
  assert.equal(decoded.speech[0].utteranceCandidateEnd, 5.53)
  assert.equal(durationExecutionSummary({ shot_script: shot, video_evidence: evidence }, undefined, { status: 'failed', error: '观察失败' })!.status, '失败')
  assert.equal(durationExecutionSummary({ shot_script: shot, video_evidence: evidence }, completed, { resultVar: 'video_shot' })!.status, '已验收')
})

test('replanning, review recovery and material identity do not falsely show acceptance', () => {
  assert.equal(durationExecutionSummary({ shot_script: shot, video_evidence: evidence }, { passed: false, durationCompletion: { assessment: 'incomplete', route: 'replan' } })!.status, '需重新排镜')
  assert.equal(durationExecutionSummary({ shot_script: shot, video_evidence: evidence }, { routeError: '需补证' }, { resultVar: 'video_shot' })!.status, '审核待恢复')
  assert.equal(durationExecutionSummary({ shot_script: shot, video_evidence: evidence, video_shot: { ...completed, url: '/generated/older.mp4' } })!.status, '待审核')
  assert.equal(durationExecutionSummary({ shot_script: shot, video_evidence: evidence, video_shot: { ...completed, durationCompletion: { assessment: 'uncertain' } } })!.status, '待审核')
})

test('calibration needs verified completion interval, accepted material and model/hash identity', () => {
  assert.equal(calibration(1).eligibleForDurationCalibration, true)
  assert.equal(calibration(1, { durationCompletion: { assessment: 'complete' } }).eligibleForDurationCalibration, false)
  assert.equal(calibration(1, { sourceSha256: 'url-is-not-a-hash' }).eligibleForDurationCalibration, false)
  assert.equal(durationCalibrationRecord({ shot, video: completed, modelVersion: '' }).eligibleForDurationCalibration, false)
  assert.equal(calibration(1, { durationCompletion: { assessment: 'uncertain', actualCompletionInterval: { lower: 8, upper: 8.2 } } }).eligibleForDurationCalibration, false)
  const spoken = { ...shot, pacing: { ...shot.pacing, beats: [{ kind: 'speech', deliveryStyle: 'singing' }] } }
  assert.equal(durationCalibrationRecord({ shot: spoken, video: completed, modelVersion: 'kling-3.0' }).eligibleForDurationCalibration, false)
})

test('unique media denominator preserves uncertain and censored outcomes; small samples have no P90/P95', () => {
  const good = calibration(1), uncertain = calibration(2, { passed: false, durationCompletion: { assessment: 'uncertain' } }),
    truncated = calibration(3, { passed: false, durationCompletion: { assessment: 'incomplete', checks: [{ status: 'incomplete', defect: { kind: 'truncated' } }] } })
  const report = aggregateDurationCalibration([good, good, uncertain, truncated])
  assert.equal(report.uniqueMediaCount, 3)
  assert.equal(report.duplicatesRemoved, 1)
  const group = report.groups[0]
  assert.equal(group.denominator, 3)
  assert.equal(group.eligibleSampleCount, 1)
  assert.equal(group.uncertainRate, 1 / 3)
  assert.equal(group.censoredCount, 1)
  assert.equal(group.confirmedTruncationCount, 1)
  assert.equal(group.percentiles, null)
})

test('resolved same-media uncertainty is usable, conflicting definitive outcomes stay excluded', () => {
  const uncertain = calibration(1, { passed: false, durationCompletion: { assessment: 'uncertain' } })
  assert.equal(aggregateDurationCalibration([uncertain, calibration(1)]).groups[0].eligibleSampleCount, 1)
  const conflict = aggregateDurationCalibration([calibration(1), calibration(1, { passed: false, durationCompletion: { assessment: 'incomplete' } })])
  assert.equal(conflict.groups[0].eligibleSampleCount, 0)
  assert.equal(conflict.groups[0].uncertainCount, 1)
  assert.equal(conflict.groups[0].censoredCount, 1)
})

test('percentiles require thirty eligible samples within each model and delivery group', () => {
  const thirty = Array.from({ length: 30 }, (_, index) => calibration(index + 1))
  assert.equal(aggregateDurationCalibration(thirty.slice(1)).groups[0].percentiles, null)
  assert.equal(aggregateDurationCalibration(thirty).groups[0].percentiles?.p90CompletionUpperSeconds, 8.2)
  const split = aggregateDurationCalibration(thirty.map((row, index) => ({ ...row, modelVersion: index < 15 ? 'a' : 'b' })))
  assert.equal(split.groups.length, 2)
  assert.ok(split.groups.every(group => group.percentiles === null))
})

test('solo, group and mixed vocal performance are separate calibration populations', () => {
  const record = (beats: Array<Record<string, unknown>>, actorGroups: Array<Record<string, unknown>> = []) => durationCalibrationRecord({
    shot: { ...shot, pacing: { ...shot.pacing, beats, actorGroups } }, video: completed, modelVersion: 'kling-3.0' })
  const solo = record([{ kind: 'vocalization', actorIds: ['singer'] }])
  const group = record([{ kind: 'vocalization', actorIds: ['crowd'] }], [{ id: 'crowd' }])
  const mixed = record([{ kind: 'vocalization', actorIds: ['singer'] }, { kind: 'vocalization', actorIds: ['crowd'] }], [{ id: 'crowd' }])
  assert.equal(solo.performerMode, 'solo')
  assert.equal(group.performerMode, 'group')
  assert.equal(mixed.performerMode, 'mixed')
  assert.equal(record([]).performerMode, 'unknown')
  const separate = aggregateDurationCalibration([{ ...solo, mediaHash: '1'.repeat(64) }, { ...group, mediaHash: '2'.repeat(64) }, { ...mixed, mediaHash: '3'.repeat(64) }])
  assert.deepEqual(separate.groups.map(value => value.performerMode).sort(), ['group', 'mixed', 'solo'])
  const conflict = aggregateDurationCalibration([solo, group])
  assert.equal(conflict.uniqueMediaCount, 1)
  assert.equal(conflict.samples[0].eligibleForDurationCalibration, false)
  assert.ok(conflict.samples[0].exclusionReasons.includes('duplicate-metadata-conflict'))
})
