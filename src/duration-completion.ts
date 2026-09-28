/** Completion evidence belongs to a particular schedule and inspected material.
 * This function is intentionally self-contained for persisted code-node VMs.
 * It validates evidence contracts, not the truth of a model's observations. */
export function assessDurationCompletion(shot: Record<string, unknown>, evidence: Record<string, unknown>, review: Record<string, unknown>) {
  type Row = Record<string, unknown>
  type Range = { lower: number; upper: number }
  type Check = { beatId: string; sourceBeatId: string; status: 'complete' | 'incomplete' | 'uncertain'; reasons: string[];
    observedStart: Range | null; observedEnd: Range | null; defect?: { kind: string; reason: string; modality?: string } }
  const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
  const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
  const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  const uncertainText = (value: unknown) => !nonempty(value) || /(?:无法|不能|难以|未能)\s*(?:完全\s*)?(?:确定|确认|判断|辨认|区分|排除)|不(?:明确|确定|清楚)|未确认|看不清|证据不足|可能|疑似|未知|\b(?:unknown|uncertain|unobservable|unclear|possibly|may|might)\b/i.test(value)
  const pacing = record(shot.pacing)
  if (pacing.version !== 'duration-v2') return { applicable: false, assessment: 'not-applicable' as const, route: 'legacy' as const,
    passed: false, checks: [] as Check[], reasons: [] as string[], remainingMandatoryBeats: [] as string[], actualCompletionInterval: null,
    requiredEndSecond: null, minimumAdditionalSeconds: null, evidenceRequests: [] as Row[] }
  const invalid = (reason: string): never => { throw Error('DURATION_COMPLETION_CONTRACT_INVALID: ' + reason + '；恢复原排程契约，不能沿用旧视频验收') }
  const beats = rows(pacing.beats), schedule = rows(pacing.schedule), policy = record(pacing.timingPolicy)
  const duration = Number(evidence.duration), reserve = Number(policy.endingReadabilityReserve)
  if (!beats.length || beats.some(beat => !nonempty(beat.id) || !nonempty(beat.sourceBeatId)
    || !['visual', 'audio', 'audio-visual'].includes(String(record(beat.completion).modality))
    || typeof record(beat.completion).requiredThisClip !== 'boolean' || !nonempty(record(beat.completion).finalState)
    || !Array.isArray(beat.actorIds) || !beat.actorIds.length || beat.actorIds.some(id => !nonempty(id))
    || !Array.isArray(beat.dependsOn) || beat.dependsOn.some(id => !beats.some(other => other.id === id)))
    || new Set(beats.map(beat => beat.id)).size !== beats.length) invalid('必需节拍、原节拍绑定、主体、完成态或依赖不完整')
  if (!nonempty(pacing.scheduleHash) || shot.scheduleHash !== undefined && shot.scheduleHash !== pacing.scheduleHash
    || schedule.length !== beats.length || beats.some(beat => schedule.filter(row => row.beatId === beat.id && row.sourceBeatId === beat.sourceBeatId).length !== 1)
    || !Number.isFinite(reserve) || reserve < 0) invalid('排程哈希、逐节拍排程或可读余量不完整')
  const mandatory = beats.filter(beat => record(beat.completion).requiredThisClip === true)
  if (!mandatory.length) invalid('本镜没有必须完成的节拍')
  const report = record(review.durationCompletion), reportRows = rows(report.checks)
  const evidenceRef = [evidence.evidenceUrl, evidence.url].find(nonempty)
  const globalReasons: string[] = []
  if (!Number.isFinite(duration) || duration <= 0 || evidence.decoded !== true) globalReasons.push('缺少本素材的有效解码时长')
  if (!evidenceRef || report.evidenceRef !== evidenceRef || report.scheduleHash !== pacing.scheduleHash) globalReasons.push('完成报告未绑定本次排程和本素材采证回执')
  if (!Array.isArray(report.checks) || reportRows.some(row => !beats.some(beat => beat.id === row.beatId))) globalReasons.push('完成报告含未知节拍或缺少checks')
  const epsilon = 1e-7
  const range = (value: unknown): Range | null => {
    const r = record(value)
    return typeof r.lower === 'number' && typeof r.upper === 'number' && Number.isFinite(r.lower) && Number.isFinite(r.upper)
      && r.lower >= 0 && r.upper >= r.lower && r.upper <= duration + epsilon ? { lower: r.lower, upper: r.upper } : null
  }
  const frames = Array.isArray(evidence.frames) ? evidence.frames : [], times = Array.isArray(evidence.frameTimes) ? evidence.frameTimes : []
  const native = record(evidence.nativeSequence), frameRefs = rows(evidence.frameReferences)
  const nativeWindows = rows(native.windows)
  const nativeFrame = (index: unknown): Row | null => {
    if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= frameRefs.length
      || !/^[a-f0-9]{64}$/.test(String(native.sourceVideoSha256)) || !/^[a-f0-9]{64}$/.test(String(native.archiveSha256))) return null
    const i = Number(index), ref = frameRefs[i], first = frameRefs[0]
    const base = /^(\d+)\/(\d+)$/.exec(String(ref.timeBase)), numerator = Number(base?.[1]), denominator = Number(base?.[2])
    if (!first || first.nativeFrameIndex !== 0 || first.second !== 0 || !Number.isSafeInteger(first.pts)
      || !Number.isSafeInteger(ref.nativeFrameIndex) || Number(ref.nativeFrameIndex) < 0 || !Number.isSafeInteger(native.totalNativeFrames)
      || Number(ref.nativeFrameIndex) >= Number(native.totalNativeFrames) || !Number.isSafeInteger(ref.pts)
      || !Array.isArray(native.selectedNativeFrameIndices) || native.selectedNativeFrameIndices[i] !== ref.nativeFrameIndex
      || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0
      || first.timeBase !== ref.timeBase || ref.evidenceIndex !== i || ref.url !== frames[i] || ref.second !== times[i]
      || !/^[a-f0-9]{64}$/.test(String(ref.sourceSha256))
      || Math.abs((Number(ref.pts) - Number(first.pts)) * numerator / denominator - Number(ref.second)) > epsilon) return null
    return ref
  }
  const lexical = (value: unknown) => String(value ?? '').replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '')
  const speech = record(evidence.speechValidation), alignments = rows(speech.alignment), audioObservations = rows(evidence.audioObservations)
  const checks: Check[] = []
  const evidenceRequests: Row[] = []
  for (const beat of mandatory) {
    const reasons = [...globalReasons], matches = reportRows.filter(row => row.beatId === beat.id), row = matches[0] ?? {}
    let start = range(row.observedStart), end = range(row.observedEnd)
    const completion = record(beat.completion)
    const scheduled = schedule.find(item => item.beatId === beat.id)!, constraint = record(scheduled.timingConstraint ?? beat.timingConstraint)
    if (!['reference', 'hard'].includes(String(constraint.mode))) invalid('节拍 ' + beat.id + ' 缺少生成前的reference/hard分类')
    const searchStart = constraint.mode === 'hard' && constraint.notBeforeSecond !== undefined ? Number(constraint.notBeforeSecond) : 0
    const searchEnd = constraint.mode === 'hard' && constraint.deadlineSecond !== undefined ? Math.min(duration, Number(constraint.deadlineSecond)) : duration
    if (constraint.mode === 'hard' && (!Number.isFinite(searchStart) || !Number.isFinite(searchEnd) || searchStart < 0 || searchEnd < searchStart)) invalid('硬时间约束非法：' + beat.id)
    if (matches.length !== 1 || row.sourceBeatId !== beat.sourceBeatId) reasons.push('缺少唯一绑定原sourceBeatId的逐节拍完成报告')
    if (!['complete', 'incomplete', 'uncertain'].includes(String(row.status)) || !nonempty(row.reason)) reasons.push('缺少完成状态或实际观察说明')
    if (row.status === 'uncertain' || uncertainText(row.reason)) reasons.push('观察尚不能证明本节拍完成或确证不符')
    if (!start || !end || start.lower > end.upper || start.upper > end.upper) reasons.push('缺少有效的实际开始/结束时间区间')
    const visualRequired = completion.modality === 'visual' || completion.modality === 'audio-visual'
    const audioRequired = completion.modality === 'audio' || completion.modality === 'audio-visual'
    const defect = record(row.defect), defectModality = defect.modality ?? (visualRequired && !audioRequired ? 'visual' : audioRequired && !visualRequired ? 'audio' : undefined)
    const visualFailure = row.status === 'incomplete' && ['visual', 'audio-visual'].includes(String(defectModality))
    const audioFailure = row.status === 'incomplete' && ['audio', 'audio-visual'].includes(String(defectModality))
    if (row.status === 'incomplete' && (!['visual', 'audio', 'audio-visual'].includes(String(defectModality))
      || visualFailure && !visualRequired || audioFailure && !audioRequired)) reasons.push('混合模态缺陷必须明确归属visual/audio/audio-visual，不能声称所有模态均未完成')
    const channelSpans: Array<{ start: Range; end: Range }> = []
    const visual = record(row.visual), visualIndices = Array.isArray(visual.frameIndices) ? visual.frameIndices : []
    let visualReliable = !visualRequired, audioReliable = !audioRequired
    if (visualRequired) {
      const refs = visualIndices.map(nativeFrame)
      const valid = refs.length >= 2 && new Set(visualIndices).size === refs.length && refs.every(ref => ref !== null)
      const ordered = valid ? (refs as Row[]).sort((a, b) => Number(a.nativeFrameIndex) - Number(b.nativeFrameIndex)) : []
      const first = ordered[0], last = ordered.at(-1)
      const visualStart = range(visual.observedStart) ?? (audioRequired && first ? { lower: Number(first.second), upper: Number(first.second) } : start)
      const visualEnd = range(visual.observedEnd) ?? (audioRequired && last ? { lower: Number(last.second), upper: Number(last.second) } : end)
      const sequenceCovered = valid && ordered.every((ref, i) => i === 0 || Number(ref.nativeFrameIndex) === Number(ordered[i - 1].nativeFrameIndex) + 1)
        && nativeWindows.some(window => window.complete === true && Number(window.start) <= Number(first.second) + epsilon
          && Number(window.end) >= Number(last!.second) - epsilon)
      visualReliable = Boolean(sequenceCovered && visualStart && visualEnd && Number(first.second) <= visualStart.upper + epsilon
        && Number(last!.second) >= visualEnd.lower - epsilon && Number(last!.second) <= visualEnd.upper + epsilon
        && !uncertainText(visual.observedChange) && (visualFailure || !uncertainText(visual.observedFinalState)))
      if (visualReliable && visualStart && visualEnd) channelSpans.push({ start: visualStart, end: visualEnd })
      if (!visualReliable) reasons.push('缺少覆盖动作开始、过程和结束的连续原生PTS证据；静帧或ASR不能证明动作完成')
      if (visualFailure && defect.kind === 'truncated'
        && (!last || Number(last.nativeFrameIndex) !== Number(native.totalNativeFrames) - 1)) {
        reasons.push('截断结论必须看到该素材实际末帧，不能把采样窗末尾当片尾'); visualReliable = false
      }
      if (visualFailure && defect.kind === 'missing-action' && !nativeWindows.some(window => window.complete === true
        && Number(window.start) <= searchStart + epsilon && Number(window.end) >= searchEnd - epsilon
        && Array.isArray(window.evidenceFrameIndices) && window.evidenceFrameIndices.length >= 2
        && window.evidenceFrameIndices.every(index => visualIndices.includes(index)))) {
        reasons.push('动作缺失须完整观察本节拍合法查找范围，局部窗口未见不证明全片缺失'); visualReliable = false
      }
    }
    if (audioRequired) {
      const ids = record(row.audio).evidenceIds
      const candidates: Row[] = []
      if (Array.isArray(ids) && ids.length && new Set(ids).size === ids.length) for (const id of ids) {
        const asr = /^speech-(\d+)$/.exec(String(id)), alignment = asr ? alignments[Number(asr[1])] : undefined
        const planned = record(alignment?.planned)
        if (alignment && !audioFailure && beat.kind === 'speech' && lexical(planned.text) === lexical(beat.textOrVocalization)
          && planned.beatId === beat.id && planned.sourceBeatId === beat.sourceBeatId && Array.isArray(planned.actorIds)
          && new Set(planned.actorIds).size === planned.actorIds.length && planned.actorIds.length === (beat.actorIds as unknown[]).length
          && (beat.actorIds as unknown[]).every(actor => (planned.actorIds as unknown[]).includes(actor))
          && lexical(beat.textOrVocalization) && alignment.boundaryStatus === 'reliable' && alignment.boundaryEvidenceVersion === 2
          && alignment.alignmentCoverage === 1 && Array.isArray(alignment.boundaryUncertaintyReasons) && alignment.boundaryUncertaintyReasons.length === 0
          && alignment.firstTokenMatched === true && alignment.lastTokenMatched === true) {
          const a = range(alignment.startBoundaryRange), b = range(alignment.endBoundaryRange)
          if (a && b) candidates.push({ start: a, end: b })
        } else {
          const items = audioObservations.filter(item => item.id === id), audio = items[0]
          const actorIds = audio?.actorIds
          if (items.length !== 1 || !audio || audio.evidenceRef !== evidenceRef || audio.status !== 'confirmed'
            || !['human-listen', 'audio-model'].includes(String(audio.method)) || uncertainText(audio.finding)
            || audio.audibility !== 'observed' || audio.completionCue !== (audioFailure ? 'incomplete' : 'observed')
            || !Array.isArray(actorIds) || !Array.isArray(beat.actorIds) || beat.actorIds.some(actor => !actorIds.includes(actor))) continue
          if (beat.kind === 'vocalization' && nonempty(record(beat.vocalization).melodyRelation)
            && !['none', 'not-required'].includes(String(record(beat.vocalization).melodyRelation)) && audio.melodyRelation !== 'observed') continue
          if (beat.kind === 'speech' && !audioFailure && lexical(audio.text) !== lexical(beat.textOrVocalization)) continue
          if (audioFailure && defect.kind === 'truncated' && audio.truncatedAtMediaEnd !== true) continue
          if (audioFailure && defect.kind === 'missing-action' && !(Number(record(audio.coverageWindow).start) <= searchStart
            && Number(record(audio.coverageWindow).end) >= searchEnd)) continue
          const a = range(audio.observedStart), b = range(audio.observedEnd)
          if (a && b) candidates.push({ start: a, end: b })
        }
      }
      audioReliable = Boolean(Array.isArray(ids) && ids.length && candidates.length === ids.length && start && end
        && Math.min(...candidates.map(item => (item.start as Range).lower)) >= start.lower - epsilon
        && Math.max(...candidates.map(item => (item.end as Range).upper)) <= end.upper + epsilon)
      if (audioReliable) channelSpans.push(...candidates as Array<{ start: Range; end: Range }>)
      if (!audioReliable) reasons.push('缺少同素材可靠句尾或具名音频观察；无词声部、声部归属和曲调不能由画面或零字数证明')
    }
    if (visualReliable && audioReliable && channelSpans.length && start && end) {
      const actualStart = { lower: Math.min(...channelSpans.map(item => item.start.lower)), upper: Math.min(...channelSpans.map(item => item.start.upper)) }
      const actualEnd = { lower: Math.max(...channelSpans.map(item => item.end.lower)), upper: Math.max(...channelSpans.map(item => item.end.upper)) }
      if (actualStart.lower < start.lower - epsilon || actualStart.upper > start.upper + epsilon
        || actualEnd.lower < end.lower - epsilon || actualEnd.upper > end.upper + epsilon) reasons.push('整体节拍时间区间没有覆盖各必需声画模态实际起止')
      else { start = actualStart; end = actualEnd }
    }
    let status: Check['status'] = reasons.length ? 'uncertain' : row.status as Check['status']
    if (status === 'incomplete') {
      if (!['truncated', 'missing-action', 'hard-timing'].includes(String(defect.kind)) || uncertainText(defect.reason)
        || !visualReliable || !audioReliable) { reasons.push('未完成结论没有绑定确证缺陷与可靠证据'); status = 'uncertain' }
    }
    if (status === 'complete' && start && end && constraint.mode === 'hard') {
      if (start.upper < searchStart - epsilon || end.lower > searchEnd + epsilon) {
        status = 'incomplete'; reasons.push('实测事件违反生成前的硬时间边界，不能放宽原约束')
      } else if (start.lower < searchStart - epsilon || end.upper > searchEnd + epsilon) {
        status = 'uncertain'; reasons.push('实测时间区间跨越硬边界，需复核同一素材')
      }
    }
    checks.push({ beatId: String(beat.id), sourceBeatId: String(beat.sourceBeatId), status, reasons, observedStart: start, observedEnd: end,
      ...(status === 'incomplete' ? { defect: { kind: row.status === 'incomplete' ? String(record(row.defect).kind) : 'hard-timing',
        reason: row.status === 'incomplete' ? String(record(row.defect).reason) : reasons[reasons.length - 1],
        modality: row.status === 'incomplete' ? String(defectModality) : String(completion.modality) } } : {}) })
    if (status === 'uncertain') evidenceRequests.push({ beatId: beat.id, sourceBeatId: beat.sourceBeatId,
      evidenceRef, scheduleHash: pacing.scheduleHash,
      modality: !audioReliable ? (!visualReliable ? 'audio-visual' : 'audio') : 'visual',
      kind: !audioReliable ? 'audio-review' : !visualReliable ? 'native-sequence' : 'report-review', timingConstraint: { ...constraint },
      startSecond: searchStart, endSecond: searchEnd, searchWindow: { start: searchStart, end: searchEnd }, reasons: [...reasons] })
  }
  // Resolve dependencies repeatedly so a later-listed predecessor becoming
  // uncertain cannot leave an earlier-listed dependent spuriously complete.
  for (let pass = 0; pass < checks.length; pass++) for (const check of checks) {
    if (check.status !== 'complete') continue
    const beat = beats.find(item => item.id === check.beatId)!
    for (const dependency of beat.dependsOn as unknown[]) {
      const prior = checks.find(item => item.beatId === dependency)
      if (!prior || prior.status !== 'complete' || !prior.observedEnd || !check.observedStart) {
        check.status = 'uncertain'; check.reasons.push('前置节拍尚无可靠完成证据：' + dependency)
      } else if (check.observedStart.upper < prior.observedEnd.lower - epsilon) {
        check.status = 'incomplete'; check.reasons.push('实测先后关系违反原节拍依赖：' + dependency)
        check.defect = { kind: 'hard-timing', reason: check.reasons[check.reasons.length - 1] }
      } else if (check.observedStart.lower < prior.observedEnd.upper - epsilon) {
        check.status = 'uncertain'; check.reasons.push('实测时间区间不能证明前置节拍已完成：' + dependency)
      }
    }
  }
  let assessment: Check['status'] = checks.some(check => check.status === 'incomplete') ? 'incomplete'
    : checks.some(check => check.status !== 'complete') ? 'uncertain' : 'complete'
  const completionRange = assessment === 'complete' ? { lower: Math.max(...checks.map(check => check.observedEnd!.lower)),
    upper: Math.max(...checks.map(check => check.observedEnd!.upper)) } : null
  const requiredEndSecond = completionRange ? completionRange.upper + reserve : null
  if (completionRange && completionRange.lower + reserve > duration + epsilon) {
    assessment = 'incomplete'; globalReasons.push('必需事件完成后没有原政策要求的可读余量，必须重新排镜')
  } else if (requiredEndSecond !== null && requiredEndSecond > duration + epsilon) {
    assessment = 'uncertain'; globalReasons.push('可用片长落在实际完成时间的不确定区间与可读余量内')
  }
  for (const check of checks.filter(check => check.status === 'uncertain')) if (!evidenceRequests.some(request => request.beatId === check.beatId)) {
    const slot = schedule.find(item => item.beatId === check.beatId)!, beat = beats.find(item => item.id === check.beatId)!
    const constraint = record(slot.timingConstraint)
    evidenceRequests.push({ beatId: check.beatId, sourceBeatId: check.sourceBeatId, evidenceRef, scheduleHash: pacing.scheduleHash,
      modality: record(beat.completion).modality, kind: 'report-review', timingConstraint: { ...constraint },
      startSecond: constraint.mode === 'hard' ? Number(constraint.notBeforeSecond ?? 0) : 0,
      endSecond: constraint.mode === 'hard' ? Math.min(duration, Number(constraint.deadlineSecond ?? duration)) : duration,
      searchWindow: { start: constraint.mode === 'hard' ? Number(constraint.notBeforeSecond ?? 0) : 0,
        end: constraint.mode === 'hard' ? Math.min(duration, Number(constraint.deadlineSecond ?? duration)) : duration }, reasons: [...check.reasons] })
  }
  if (assessment === 'uncertain' && !evidenceRequests.length) evidenceRequests.push({ evidenceRef, scheduleHash: pacing.scheduleHash,
    modality: 'visual', kind: 'native-sequence', startSecond: completionRange?.lower ?? 0, endSecond: duration,
    searchWindow: { start: completionRange?.lower ?? 0, end: duration }, reasons: [...globalReasons] })
  return { applicable: true, assessment, route: assessment === 'complete' ? 'accept' as const
    : assessment === 'incomplete' ? 'replan' as const : 'same-media-evidence' as const,
    passed: assessment === 'complete', checks, reasons: [...globalReasons, ...checks.flatMap(check => check.reasons)],
    remainingMandatoryBeats: checks.filter(check => check.status !== 'complete').map(check => check.beatId), actualCompletionInterval: completionRange,
    requiredEndSecond, minimumAdditionalSeconds: completionRange ? Math.max(0, completionRange.lower + reserve - duration) : null,
    evidenceRequests }
}

/** Append to the independent actual-media review. No prior script verdict is evidence. */
export const DURATION_COMPLETION_REVIEW_PROMPT = `【duration-v2逐节拍完成证据】
仅pacing.version=duration-v2时输出durationCompletion:{scheduleHash:原排程哈希,evidenceRef:本次video_evidence.evidenceUrl,checks:[{beatId:原id,sourceBeatId:原sourceBeatId,status:complete/incomplete/uncertain,reason:实际证据,observedStart:{lower:实际开始下界,upper:实际上界},observedEnd:{lower:实际完成下界,upper:实际上界},visual:{frameIndices:[连续原生帧编号],observedChange:前后实际变化,observedFinalState:实际结束态},audio:{evidenceIds:[真实音频证据id]},defect:{kind:truncated/missing-action/hard-timing,modality:visual/audio/audio-visual,reason:确证不符}}]}。
逐个覆盖completion.requiredThisClip=true节拍。声画可在不同时刻完成，整体结束区间取必要模态结束的最大值；visual可另填observedStart/observedEnd区间；某一模态已完整不能抹去另一必要模态的确证截断，defect.modality须明确归属。省略不适用的visual/audio/defect。开始和完成时刻无法确定则省略时间区间、status=uncertain。visual必须引用本次帧编号及连续原生PTS从开始到结束的实际过程，单张静帧或计划不证明变化；截断必须看实际最后原生帧，微动不独证截断。
audio.evidenceIds只引用真实video_evidence.audioObservations.id或可靠speechValidation.alignment的speech-0等编号。无词声部仍须音频听证，包括可听发声、声部及明确要求的同曲调关系；看人物姿态、空文字或ASR有声音均不能代替。无能力或句尾未可靠匹配时uncertain，复核同一素材，不能重拍制造证据。
v2原要求有timingBeatId/sourceBeatId及eventSearchRanges时，只审该独立节拍的原beatQuote。参考窗可查找实际事件，不能把短暂动作变成全片持续义务；同一并行窗的硬节拍不能借用另一个参考节拍范围。confirmed script defect还须逐字原quote及相同timingBeatId/sourceBeatId；参考节拍defect的startSecond/endSecond和帧必须在本报告该节拍实际observedStart.lower至observedEnd.upper内，不能拿事件之前的姿态作反证。硬约束不加测量容差放宽。
参考窗口只提示事件查找位置，可在同素材内按原sourceBeatId查找实际发生与结束；硬notBeforeSecond/deadlineSecond和dependsOn不得放宽或改写。完整且可读余量足够才可通过。确证不足交回重新排程，不原样重拍；证据不足保持unknown并补同素材。【duration-v2逐节拍完成证据结束】`
