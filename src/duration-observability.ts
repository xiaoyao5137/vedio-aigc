type Value = Record<string, unknown>

/** Self-contained: also embedded into the persisted metrics node. */
export function deriveDurationMetrics(shot: Value, evidence: Value, legacy: Value) {
  const pacing = shot.pacing as Value | undefined
  if (pacing?.version !== 'duration-v2') return legacy
  const policy = pacing.timingPolicy as Value
  const windows = (pacing.speechWindows ?? []) as Value[]
  const speech = ((evidence.speechMetrics ?? []) as Value[]).map((row, index) => {
    const window = windows[index]
    const allowedSpan = window ? Number(window.end) - Number(window.start) : NaN
    const reliable = row.timingReliable === true && row.boundaryStatus === 'reliable'
    const elapsed = Number(row.elapsed)
    const tolerance = Number(policy?.measurementToleranceSeconds ?? .25)
    const assessment = !reliable || !Number.isFinite(allowedSpan) ? 'uncertain'
      : elapsed <= allowedSpan ? 'within-allowance' : elapsed - tolerance > allowedSpan ? 'outside-allowance' : 'uncertain'
    return { ...row, allowedSpan: Number.isFinite(allowedSpan) ? allowedSpan : null,
      excessSeconds: Number.isFinite(allowedSpan) ? elapsed - allowedSpan : null, timingAssessment: assessment,
      budgetSource: 'compiled-speech-window', beatId: window?.beatId, deliveryStyle: window?.deliveryStyle, policyVersion: 'duration-v2' }
  })
  const validation = evidence.speechValidation as Value | undefined
  const lastSpeechEnd = Number(validation?.lastSpeechEnd)
  const reserve = Number(policy?.endingReadabilityReserve ?? policy?.endingReadabilitySeconds ?? .4)
  const speechTail = Number.isFinite(lastSpeechEnd) && lastSpeechEnd > 0 ? Number(evidence.duration) - lastSpeechEnd : null
  const maxIdle = Number((legacy.policy as Value | undefined)?.maxIdleTailSeconds ?? 1.2)
  const tailTiming = { actualSeconds: speechTail, minSeconds: reserve, maxSeconds: maxIdle,
    assessment: speech.length === 0 ? 'not-applicable' : speechTail === null || speech.some(row => row.timingAssessment === 'uncertain') ? 'uncertain'
      : speechTail < reserve ? 'outside-allowance' : speechTail <= maxIdle ? 'within-allowance' : 'uncertain',
    scope: 'voice-tail-only-not-action-completion', measurementToleranceDeducted: false,
    idleAssessmentRequires: 'actual-completion-of-all-required-actions-and-vocalizations' }
  const activePolicy = { ...(legacy.policy as Value) }
  delete activePolicy.minSpeechRate
  Object.assign(activePolicy, { shortPauseSeconds: policy.shortPauseSeconds, sentencePauseSeconds: policy.sentencePauseSeconds,
    timingToleranceSeconds: policy.measurementToleranceSeconds, tailSeconds: reserve,
    timingPolicy: policy, timingPolicyVersion: 'duration-v2' })
  return { ...legacy, policy: activePolicy, speech, tailTiming,
    durationPlan: { version: 'duration-v2', scheduleHash: pacing.scheduleHash, requestedDuration: shot.duration,
      actualDuration: evidence.duration, timingEstimate: shot.timingEstimate, schedule: pacing.schedule, beats: pacing.beats },
    audioReviewRequired: ((pacing.beats ?? []) as Value[]).filter(beat => beat.kind === 'vocalization').map(beat => ({ beatId: beat.id, requirement: beat.vocalization, status: 'uncertain' })),
  }
}

const valueRecord = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const valueRows = (value: unknown): Value[] => Array.isArray(value) ? value.map(valueRecord) : []
const seconds = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function durationExecutionSummary(context: Value, output?: Value, run: { status?: string; error?: string; resultVar?: string } = {}) {
  const current = { ...context, ...(run.resultVar && output ? { [run.resultVar]: output } : {}) }
  const candidate = (current.shot_script ?? current.shot_candidate) as Value | undefined
  const shot = output?.pacing && !output?.decoded ? output : candidate
  const evidence = (output?.decoded ? output : current.video_evidence) as Value | undefined
  const accepted = (output?.durationCompletion ? output : current.video_shot) as Value | undefined
  const metrics = (output?.durationPlan ? output : current.media_metrics) as Value | undefined
  if (!shot?.timingEstimate && !shot?.pacing) return undefined
  const estimate = shot.timingEstimate as Value | undefined
  const completion = valueRecord(accepted?.durationCompletion)
  const speech: Value[] = valueRows(metrics?.speech ?? evidence?.speechMetrics).map(row => ({ ...row,
    // Legacy within-allowance is not evidence of intact sentence boundaries.
    timingAssessment: row.timingReliable === true && row.boundaryStatus === 'reliable' ? row.timingAssessment ?? '未评估' : 'uncertain' }))
  const completionStatus = ['complete', 'incomplete', 'uncertain'].includes(String(completion.assessment)) ? String(completion.assessment) : 'uncertain'
  const interval = valueRecord(completion.actualCompletionInterval)
  const completionUpper = seconds(interval.upper)
  const actualDuration = seconds(evidence?.duration)
  const plannedEnd = seconds(estimate?.contentEndBudget)
  const failed = run.status === 'failed' || Boolean(run.error)
  const acceptedCurrentMaterial = accepted?.passed === true && (!evidence?.url || !accepted.url || evidence.url === accepted.url)
  const status = failed ? '失败' : acceptedCurrentMaterial && (valueRecord(shot.pacing).version !== 'duration-v2' || completionStatus === 'complete') ? '已验收'
    : completion.route === 'replan' ? '需重新排镜' : accepted?.routeError ? '审核待恢复'
      : accepted?.passed === false && completionStatus === 'incomplete' ? '未通过验收'
        : evidence || current.video_take ? '待审核' : '待生成'
  return { version: String(valueRecord(shot.pacing).version ?? 'legacy'),
    plan: seconds(estimate?.plannedDuration), requested: seconds(valueRecord(current.media_request).duration ?? shot.duration), actual: seconds(evidence?.duration),
    contentBudget: seconds(estimate?.contentEndBudget ?? estimate?.plannedEndSecond ?? estimate?.occupiedSeconds
      ?? (typeof estimate?.rawRequiredSeconds === 'number' ? estimate.rawRequiredSeconds - Number(estimate.tailSeconds ?? 0) : undefined)),
    safeBudget: seconds(estimate?.safeEndBudget ?? estimate?.rawRequiredSeconds),
    endingReserve: seconds(estimate?.endingReadabilityReserve ?? estimate?.tailSeconds),
    completionInterval: seconds(interval.lower) !== null && completionUpper !== null ? { lower: Number(interval.lower), upper: completionUpper } : null,
    remainingAfterCompletion: completionUpper !== null && actualDuration !== null ? Number((actualDuration - completionUpper).toFixed(3)) : null,
    completionBudgetDelta: completionUpper !== null && plannedEnd !== null ? Number((completionUpper - plannedEnd).toFixed(3)) : null,
    speech, completion: completionStatus, completionReasons: Array.isArray(completion.reasons) ? completion.reasons.map(String) : [],
    status, error: run.error ?? String(accepted?.routeError ?? ''),
    evidenceUrl: typeof evidence?.evidenceUrl === 'string' ? evidence.evidenceUrl : null,
    pendingEvidence: valueRows(completion.evidenceRequests), legacy: valueRecord(shot.pacing).version !== 'duration-v2' }
}

/** Calibration rows keep censored failures; they are not successful duration observations. */
export function durationCalibrationRecord(input: { shot: Value; video: Value; modelVersion: string }) {
  const pacing = input.shot.pacing as Value
  const completion = valueRecord(input.video.durationCompletion), interval = valueRecord(completion.actualCompletionInterval)
  const rawHash = input.video.sourceSha256 ?? valueRecord(input.video.nativeSequence).sourceVideoSha256
  const mediaHash = typeof rawHash === 'string' && /^[a-f0-9]{64}$/i.test(rawHash) ? rawHash.toLowerCase() : null
  const modelVersion = input.modelVersion.trim() || 'unknown'
  const groupIds = new Set(valueRows(pacing?.actorGroups).map(group => group.id))
  const beats = valueRows(pacing?.beats), voiceBeats = beats.filter(beat => ['speech', 'vocalization'].includes(String(beat.kind)))
  const modes = new Set((voiceBeats.length ? voiceBeats : beats).map(beat => {
    const actors = Array.isArray(beat.actorIds) ? beat.actorIds : []
    return !actors.length ? 'unknown' : actors.length > 1 || actors.some(actor => groupIds.has(actor)) ? 'group' : 'solo'
  }))
  const performerMode = !modes.size || modes.has('unknown') ? 'unknown' : modes.size > 1 ? 'mixed' : [...modes][0]
  const assessment = ['complete', 'incomplete', 'uncertain'].includes(String(completion.assessment)) ? String(completion.assessment) : 'uncertain'
  const truncated = valueRows(completion.checks).some(check => check.status === 'incomplete' && valueRecord(check.defect).kind === 'truncated')
  const spokenBeats = valueRows(pacing?.beats).filter(beat => beat.kind === 'speech')
  const alignment = valueRows(valueRecord(input.video.speechValidation).alignment)
  const unreliableSpeech = spokenBeats.length > 0 && (alignment.length !== spokenBeats.length || alignment.some(row =>
    row.boundaryStatus !== 'reliable' || row.firstTokenMatched !== true || row.lastTokenMatched !== true || row.alignmentCoverage !== 1))
  const hasInterval = seconds(interval.lower) !== null && seconds(interval.upper) !== null && Number(interval.upper) >= Number(interval.lower)
    && seconds(input.video.duration) !== null && Number(interval.upper) <= Number(input.video.duration)
  const reasons = [!mediaHash ? 'missing-media-hash' : '', modelVersion === 'unknown' ? 'missing-model-version' : '',
    input.video.passed !== true ? 'not-accepted' : '', assessment !== 'complete' ? 'completion-' + assessment : '',
    !hasInterval ? 'missing-reliable-completion-interval' : '', truncated ? 'confirmed-truncation' : '',
    pacing?.version !== 'duration-v2' ? 'legacy-duration-policy' : '', unreliableSpeech ? 'unreliable-speech-boundaries' : '',
    performerMode === 'unknown' ? 'unknown-performer-mode' : ''].filter(Boolean)
  return { policyVersion: String(valueRecord(pacing?.timingPolicy).version ?? pacing?.version ?? 'unknown'),
    pacingVersion: String(pacing?.version ?? 'unknown'), scheduleHash: pacing?.scheduleHash ?? null, mediaHash,
    modelVersion, performerMode, deliveryStyles: [...new Set(valueRows(pacing?.beats).map(beat => String(beat.deliveryStyle ?? '')).filter(Boolean))].sort(),
    requestedDuration: seconds(input.shot.duration), decodedDuration: seconds(input.video.duration), completion: assessment,
    actualCompletionInterval: hasInterval ? { lower: Number(interval.lower), upper: Number(interval.upper) } : null,
    accepted: input.video.passed === true, eligibleForDurationCalibration: reasons.length === 0, exclusionReasons: reasons,
    censored: assessment === 'incomplete' || truncated, truncated, sampleUnit: 'unique-media-hash' }
}

export type DurationCalibrationRecord = ReturnType<typeof durationCalibrationRecord>

/** Deduplicate re-reviews of the same bytes before computing denominators.
 * Resolved uncertainty may become usable; conflicting definitive outcomes may not. */
export function aggregateDurationCalibration(records: DurationCalibrationRecord[]) {
  const identified = new Map<string, DurationCalibrationRecord[]>(), missing: DurationCalibrationRecord[] = []
  for (const row of records) {
    if (!row.mediaHash) { missing.push(row); continue }
    identified.set(row.mediaHash, [...(identified.get(row.mediaHash) ?? []), row])
  }
  const unique = [...identified.values()].map(duplicates => {
    const key = (row: DurationCalibrationRecord) => JSON.stringify([row.policyVersion, row.modelVersion, row.deliveryStyles, row.performerMode, row.scheduleHash])
    const metadataConflict = new Set(duplicates.map(key)).size > 1
    const outcomeConflict = duplicates.some(row => row.completion === 'complete') && duplicates.some(row => row.completion === 'incomplete')
    const chosen = duplicates.find(row => row.eligibleForDurationCalibration) ?? duplicates.find(row => row.censored) ?? duplicates[0]
    return metadataConflict || outcomeConflict ? { ...chosen, completion: 'uncertain', eligibleForDurationCalibration: false,
      exclusionReasons: [...chosen.exclusionReasons, metadataConflict ? 'duplicate-metadata-conflict' : 'duplicate-completion-conflict'],
      censored: duplicates.some(row => row.censored), truncated: duplicates.some(row => row.truncated) } : chosen
  })
  const groups = new Map<string, { rows: DurationCalibrationRecord[]; missingHashRecords: number }>()
  const groupKey = (row: DurationCalibrationRecord) => JSON.stringify([row.policyVersion, row.modelVersion, row.deliveryStyles, row.performerMode])
  for (const row of unique) {
    const key = groupKey(row), group = groups.get(key) ?? { rows: [], missingHashRecords: 0 }
    group.rows.push(row); groups.set(key, group)
  }
  for (const row of missing) {
    const key = groupKey(row), group = groups.get(key) ?? { rows: [], missingHashRecords: 0 }
    group.missingHashRecords++; groups.set(key, group)
  }
  const reportGroups = [...groups.entries()].map(([key, group]) => {
    const [policyVersion, modelVersion, deliveryStyles, performerMode] = JSON.parse(key) as [string, string, string[], string]
    const eligible = group.rows.filter(row => row.eligibleForDurationCalibration && row.actualCompletionInterval)
    const upperBounds = eligible.map(row => row.actualCompletionInterval!.upper).sort((a, b) => a - b)
    const denominator = group.rows.length, uncertainCount = group.rows.filter(row => row.completion === 'uncertain').length
    const quantile = (q: number) => upperBounds[Math.max(0, Math.ceil(q * upperBounds.length) - 1)]
    return { policyVersion, modelVersion, deliveryStyles, performerMode, denominator, denominatorUnit: 'unique-media-hash',
      missingHashRecords: group.missingHashRecords, eligibleSampleCount: eligible.length,
      acceptedCompleteCount: group.rows.filter(row => row.accepted && row.completion === 'complete').length, censoredCount: group.rows.filter(row => row.censored).length,
      confirmedTruncationCount: group.rows.filter(row => row.truncated).length, uncertainCount,
      uncertainRate: denominator ? uncertainCount / denominator : null,
      censoredRate: denominator ? group.rows.filter(row => row.censored).length / denominator : null,
      confirmedTruncationRate: denominator ? group.rows.filter(row => row.truncated).length / denominator : null,
      percentiles: eligible.length >= 30 ? { sampleCount: eligible.length, method: 'nearest-rank-of-completion-interval-upper-bound',
        p90CompletionUpperSeconds: quantile(.9), p95CompletionUpperSeconds: quantile(.95) } : null,
      percentileStatus: eligible.length >= 30 ? 'descriptive-only-not-a-guarantee' : 'insufficient-samples-minimum-30' }
  })
  return { inputRecords: records.length, uniqueMediaCount: unique.length, duplicatesRemoved: records.length - missing.length - unique.length,
    missingMediaHashRecords: missing.length, minimumPercentileSamples: 30, groups: reportGroups, samples: unique,
    limitations: ['Unknown media hashes are excluded from unique-media rate denominators.',
      'Incomplete, uncertain, legacy, conflicting or unaccepted observations never enter successful duration percentiles.',
      'Completion upper-bound percentiles are descriptive and do not estimate missing/censored duration.'] }
}
