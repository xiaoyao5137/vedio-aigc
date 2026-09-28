import { deriveMediaRequirements } from './media-requirement-coverage.ts'
import { resolveNativeFrameDisplayInterval } from './media-frame-display.ts'

export type AdaptiveMediaSamplingPlan = { sourceUrl: string; round: number; sampleTimes: number[]; requirementIds: string[];
  nativeSequence?: { enabled: true; windows: Array<{ start: number; end: number }>; reviewMaxFrames: number } }
export type AdaptiveMediaSamplingPolicy = { maxFrames: number; maxRounds: number; nativeSequence?: boolean; nativeReviewMaxFrames?: number }

/** Request denser evidence for unresolved authored intervals, never another
 * video or a changed verdict. Embed with an explicit deriveMediaRequirements
 * binding. The inspection service remains responsible for actual seek times. */
export function deriveAdaptiveMediaSamplingPlan(shot: Record<string, unknown>, evidence: Record<string, unknown>, review: Record<string, unknown>,
  policy: AdaptiveMediaSamplingPolicy, previousPlan?: AdaptiveMediaSamplingPlan | null): AdaptiveMediaSamplingPlan | null {
  const invalid = (reason: string): never => { throw Error('MEDIA_ADAPTIVE_SAMPLING_INVALID: ' + reason) }
  const limit = (reason: string): never => { throw Error('MEDIA_ADAPTIVE_SAMPLING_LIMIT: ' + reason + '；保留未知与原素材，不截断原要求、不购买新视频') }
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const near = (left: number, right: number) => Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right))
  if (!policy || !Number.isSafeInteger(policy.maxFrames) || policy.maxFrames < 2 || policy.maxFrames > 24) invalid('maxFrames 必须为 2..24 的整数')
  if (!Number.isSafeInteger(policy.maxRounds) || policy.maxRounds < 1) invalid('maxRounds 必须为正整数')
  if (policy.nativeSequence !== undefined && typeof policy.nativeSequence !== 'boolean') invalid('nativeSequence 必须为显式布尔配置')
  if (policy.nativeSequence && (!Number.isSafeInteger(policy.nativeReviewMaxFrames) || Number(policy.nativeReviewMaxFrames) < 2 || Number(policy.nativeReviewMaxFrames) > 256)) invalid('nativeReviewMaxFrames 必须为 2..256 的整数，独立于稀疏采样预算')
  if (!Array.isArray(review.requirementChecks)) return null
  let requirements: ReturnType<typeof deriveMediaRequirements>
  try { requirements = deriveMediaRequirements(shot) } catch (error) { invalid('无法绑定原时间窗：' + (error instanceof Error ? error.message : String(error))) }
  const rows = review.requirementChecks
  const unknownRows = rows.filter(value => record(value).status === 'unobservable')
  if (!unknownRows.length) return null
  for (const value of unknownRows) if (!requirements!.some(requirement => requirement.id === record(value).requirementId)) invalid('unobservable requirementId 不属于当前原要求')
  const intervals = requirements!.filter(requirement => requirement.scope === 'interval' && unknownRows.some(value => record(value).requirementId === requirement.id))
    .map(requirement => {
      const search = requirement.eventSearchRanges?.[0]
      // V2 requirements are already separated per source timing beat. This is
      // only a same-material discovery range; never mutate the authored quote
      // or classify a hard boundary as a reference after generation.
      return search ? { ...requirement, startSecond: search.startSecond,
        endSecond: search.timingConstraint.mode === 'reference' || search.timingConstraint.deadlineSecond === undefined
          ? Number(evidence.duration) : Math.min(Number(evidence.duration), search.endSecond) } : requirement
    })
  if (!intervals.length) return null
  const duration = evidence.duration, times = evidence.frameTimes
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) invalid('缺少有效实际视频时长')
  if (!Array.isArray(times) || times.length < 2 || times[0] !== 0
    || times.some((time, index) => typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time >= Number(duration)
      || (index > 0 && time <= Number(times[index - 1])))) invalid('frameTimes 必须保留实际 0 秒首帧与尾帧，且为时长内严格递增的真实采样时刻')
  const actualTimes = times as number[]
  const displays = actualTimes.map((_, index) => resolveNativeFrameDisplayInterval(evidence, index))
  if (evidence.frames !== undefined && (!Array.isArray(evidence.frames) || evidence.frames.length !== actualTimes.length
    || evidence.frames.some(url => typeof url !== 'string' || !url.trim()))) invalid('frames 必须与实际 frameTimes 一一对应')
  const sourceUrl = [evidence.originalUrl, evidence.url].find(value => typeof value === 'string' && value.trim())
  if (typeof sourceUrl !== 'string') invalid('缺少同素材来源 URL，不能绑定补证轮次')
  for (const requirement of intervals) {
    if (requirement.endSecond <= requirement.startSecond || requirement.endSecond > Number(duration)) invalid('原时间窗超出实际可采证范围：' + JSON.stringify(requirement))
    const matches = rows.filter(value => record(value).requirementId === requirement.id)
    if (matches.length !== 1) invalid('原要求必须恰好有一份审核：' + requirement.id)
    const check = record(matches[0]), refs = check.frameIndices
    if (typeof check.evidence !== 'string' || !check.evidence.trim() || check.repair !== undefined || check.defectIndex !== undefined
      || !Array.isArray(refs) || new Set(refs).size !== refs.length || refs.some(index => !Number.isInteger(index) || Number(index) < 0 || Number(index) >= actualTimes.length
        || (((actualTimes[Number(index)] < requirement.startSecond && !near(actualTimes[Number(index)], requirement.startSecond))
          || (actualTimes[Number(index)] > requirement.endSecond && !near(actualTimes[Number(index)], requirement.endSecond)))
          && !(displays[Number(index)] && displays[Number(index)]!.startSecond <= requirement.endSecond && displays[Number(index)]!.endSecond > requirement.startSecond)))) invalid('不可观察原要求缺少合法证据或引用了范围外帧：' + requirement.id)
  }
  let previousRound = 0
  const sameSource = previousPlan != null && previousPlan.sourceUrl === sourceUrl
  if (evidence.nativeSequence !== undefined && (!sameSource || !previousPlan.nativeSequence)) {
    const receipt = record(evidence.nativeSequence)
    if (!/^[a-f0-9]{64}$/.test(String(receipt.sourceVideoSha256)) || !Array.isArray(receipt.windows) || !receipt.windows.length
      || receipt.windows.some(value => record(value).complete !== true)) invalid('已有原生采证回执缺少合法来源或完整覆盖信息；不能从丢失的重试上下文重建轮次')
    limit('已有同素材连续原生帧回执，重试上下文缺失或不一致；不能重置为稀疏第1轮，须核对原执行记录')
  }
  if (sameSource) {
    if (!Number.isSafeInteger(previousPlan.round) || previousPlan.round < 1 || !Array.isArray(previousPlan.sampleTimes) || !previousPlan.sampleTimes.length
      || previousPlan.sampleTimes.some((time, index) => !Number.isFinite(time) || time < 0 || time > Number(duration) || (index > 0 && time <= previousPlan.sampleTimes[index - 1]))
      || !Array.isArray(previousPlan.requirementIds) || previousPlan.requirementIds.some(id => typeof id !== 'string' || !id.trim())) invalid('同素材 previousPlan 缺少合法轮次或采样计划')
    if (previousPlan.nativeSequence) {
      const receipt = record(evidence.nativeSequence), requested = previousPlan.nativeSequence
      if (requested.enabled !== true || !Array.isArray(requested.windows) || !requested.windows.length) invalid('原生帧计划缺少有效窗口')
      if (!Array.isArray(receipt.windows) || !requested.windows.every(window => (receipt.windows as unknown[]).some(value => {
        const observed = record(value)
        return observed.start === window.start && observed.end === window.end && observed.complete === true
      }))) throw Error('MEDIA_ADAPTIVE_SAMPLING_PENDING: 连续原生帧计划尚未完整采证；不能重复创建或购买新视频')
      const uncovered = intervals.filter(requirement => {
        let coveredEnd = requirement.startSecond
        for (const window of [...requested.windows].sort((left, right) => left.start - right.start)) {
          if (window.end <= coveredEnd) continue
          if (window.start > coveredEnd && !near(window.start, coveredEnd)) break
          coveredEnd = Math.max(coveredEnd, window.end)
          if (coveredEnd >= requirement.endSecond || near(coveredEnd, requirement.endSecond)) return false
        }
        return true
      })
      if (uncovered.length) limit('本次有原生计划尚未覆盖的未知时间窗='
        + JSON.stringify(uncovered.map(requirement => ({ requirementId: requirement.id, start: requirement.startSecond, end: requirement.endSecond })))
        + '；旧窗口完成不能证明新窗口已穷尽，须安排满足原预算的同素材独立采证与复核批次，不能自动丢弃旧证据或重置轮数')
      limit('同素材连续原生帧已覆盖本次请求窗口，剩余未知需要人工或其他有效证据；不能循环重采相同画面')
    }
    const sampling = record(evidence.samplingPlan)
    // A normalized seek may differ from its request. In that case the service's
    // actual sampling receipt must bind both the request and returned frames.
    const receiptApplied = sampling.mode === 'sample-times' && Array.isArray(sampling.requested) && Array.isArray(sampling.times)
      && sampling.times.length === actualTimes.length && sampling.times.every((time, index) => typeof time === 'number' && near(time, actualTimes[index]))
      && previousPlan.sampleTimes.every(time => (sampling.requested as unknown[]).some(value => typeof value === 'number' && near(value, time)))
    if (!receiptApplied && !previousPlan.sampleTimes.every(time => actualTimes.some(actual => near(actual, time)))) {
      throw Error('MEDIA_ADAPTIVE_SAMPLING_PENDING: 上轮同素材计划尚未实际采证；先执行已有计划，不能在相同旧帧上递增补证轮数')
    }
    previousRound = previousPlan.round
  }
  const nativeFallback = (reason: string): AdaptiveMediaSamplingPlan => {
    if (!policy.nativeSequence) limit(reason)
    return { sourceUrl: sourceUrl as string, round: Math.max(1, previousRound), sampleTimes: [...actualTimes],
      requirementIds: intervals.map(requirement => requirement.id),
      nativeSequence: { enabled: true, windows: intervals.map(requirement => ({ start: requirement.startSecond, end: requirement.endSecond })),
        reviewMaxFrames: Number(policy.nativeReviewMaxFrames) } }
  }
  type Candidate = { time: number; gapWidth: number }
  const candidates: Candidate[] = [], lastActualFrame = actualTimes[actualTimes.length - 1]
  const addCandidate = (time: number, gapWidth: number) => {
    if (actualTimes.some(existing => near(existing, time))) return
    const existing = candidates.find(candidate => near(candidate.time, time))
    if (existing) existing.gapWidth = Math.max(existing.gapWidth, gapWidth)
    else candidates.push({ time, gapWidth })
  }
  const ranges = intervals.map(requirement => ({ id: requirement.id, start: requirement.startSecond, end: Math.min(requirement.endSecond, lastActualFrame) }))
  const contains = (range: typeof ranges[number], time: number) => (time >= range.start || near(time, range.start)) && (time <= range.end || near(time, range.end))
  for (const range of ranges) {
    if (range.end <= range.start || near(range.end, range.start)) continue
    const anchors = [range.start, ...actualTimes.filter(time => time >= range.start && time <= range.end), range.end]
      .sort((left, right) => left - right).filter((time, index, all) => index === 0 || !near(time, all[index - 1]))
    // Unsampled boundaries belong to the complete plan, but interior gap
    // midpoints get priority when only part of that plan fits this round.
    anchors.forEach(time => addCandidate(time, 0))
    for (let index = 1; index < anchors.length; index++) {
      const left = anchors[index - 1], right = anchors[index], midpoint = left + (right - left) / 2
      if (!near(midpoint, left) && !near(midpoint, right)) addCandidate(midpoint, right - left)
    }
  }
  if (!candidates.length) return null
  if (sameSource && candidates.every(candidate => previousPlan.sampleTimes.some(time => near(candidate.time, time)))) return null
  const widestFirst = (left: Candidate, right: Candidate) => near(left.gapWidth, right.gapWidth) ? left.time - right.time : right.gapWidth - left.gapWidth
  const selected: Candidate[] = []
  let uncovered = ranges.filter(range => candidates.some(candidate => contains(range, candidate.time)))
  while (uncovered.length) {
    // Earliest-ending interval + rightmost available point gives a minimum
    // interval cover. Among points covering that same set, prefer the widest
    // gap. This reserves evidence for short intervals and lets overlaps share
    // a point without falsely declaring their minimum budget insufficient.
    const first = [...uncovered].sort((left, right) => left.end - right.end || left.start - right.start)[0]
    const choices = candidates.filter(candidate => contains(first, candidate.time))
    const rightmost = choices.reduce((left, right) => left.time > right.time ? left : right)
    const covered = uncovered.filter(range => contains(range, rightmost.time))
    const chosen = choices.filter(candidate => covered.every(range => contains(range, candidate.time))).sort(widestFirst)[0]
    selected.push(chosen)
    uncovered = uncovered.filter(range => !contains(range, chosen.time))
  }
  const minimumFrames = actualTimes.length + selected.length
  if (previousRound >= policy.maxRounds) return nativeFallback('同素材已完成 ' + previousRound + ' 轮补证，达到 maxRounds=' + policy.maxRounds)
  if (minimumFrames > policy.maxFrames) return nativeFallback('保留全部实际帧并覆盖每个可细化未知时间窗至少需要 ' + minimumFrames + ' 帧，超过 maxFrames=' + policy.maxFrames + '；全部未知时间窗='
    + JSON.stringify(intervals.map(requirement => ({ id: requirement.id, startSecond: requirement.startSecond, endSecond: requirement.endSecond }))))
  for (const candidate of [...candidates].sort(widestFirst)) {
    if (actualTimes.length + selected.length >= policy.maxFrames) break
    if (!selected.includes(candidate)) selected.push(candidate)
  }
  const sampleTimes = [...actualTimes, ...selected.map(candidate => candidate.time)].sort((left, right) => left - right)
  // A legacy receipt may contain requested tail times normalized to the same
  // last frame. Do not resubmit an already attempted subset as a new round.
  if (sameSource && selected.every(candidate => previousPlan.sampleTimes.some(time => near(candidate.time, time)))) return null
  return { sourceUrl: sourceUrl as string, round: previousRound + 1, sampleTimes, requirementIds: intervals.map(requirement => requirement.id) }
}
