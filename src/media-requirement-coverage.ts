import { storyboardTimelineMatches } from './storyboard-timeline.ts'
import { validateMediaEvidenceGaps } from './media-evidence-gaps.ts'
import { resolveNativeFrameDisplayInterval } from './media-frame-display.ts'

export type MediaRequirement = {
  id: string
  requirementPath: string
  requirementQuote: string
  scope: 'opening' | 'interval' | 'ending'
  startSecond: number
  endSecond: number
  timingBeatId?: string
  sourceBeatId?: string
  /** V2 event discovery scopes. The authored quote and original window above
   * remain unchanged; hard conditions are checked per original timing beat. */
  eventSearchRanges?: Array<{ beatId: string; sourceBeatId: string; timingConstraint: Record<string, unknown>; startSecond: number; endSecond: number }>
}

/** Preserve the candidate's actual words and bounds. This inventory defines
 * coverage, not a claim that every subtle direction can be observed in stills. */
export function deriveMediaRequirements(shot: Record<string, unknown>): MediaRequirement[] {
  const requirements: MediaRequirement[] = []
  const duration = Number(shot.duration)
  const add = (path: string, quote: string, scope: MediaRequirement['scope'], start: number, end: number) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) throw Error('MEDIA_REQUIREMENTS_INVALID: 原要求缺少有效时间范围：' + path)
    let hash = 2166136261
    for (const character of path + '\0' + scope + '\0' + quote) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619) }
    const base = 'media-requirement-' + (hash >>> 0).toString(36)
    const id = base + (requirements.some(item => item.id === base) ? '-' + requirements.filter(item => item.id === base || item.id.startsWith(base + '-')).length : '')
    requirements.push({ id, requirementPath: path, requirementQuote: quote, scope, startSecond: start, endSecond: end })
  }
  for (const path of ['visualPrompt', 'firstFramePrompt']) {
    if (typeof shot[path] === 'string' && shot[path].trim()) add(path, shot[path].trim(), 'opening', 0, 0)
  }
  const source = typeof shot.videoPrompt === 'string' ? shot.videoPrompt : ''
  const windows = storyboardTimelineMatches(source)
  if (source.trim() && !windows.length) throw Error('MEDIA_REQUIREMENTS_INVALID: videoPrompt 未提供可定位的原始时间窗，不能静默漏审其动作要求')
  for (const [index, window] of windows.entries()) {
    const sectionEnd = source.indexOf('【', window.index + window[0].length)
    const endIndex = Math.min(windows[index + 1]?.index ?? source.length, sectionEnd < 0 ? source.length : sectionEnd)
    add('videoPrompt', source.slice(window.index, endIndex).trim(), 'interval', Number(window[1]), Number(window[2]))
    const pacing = shot.pacing && typeof shot.pacing === 'object' && !Array.isArray(shot.pacing) ? shot.pacing as Record<string, unknown> : {}
    if (pacing.version === 'duration-v2') {
      const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      const timeline = Array.isArray(pacing.timelineWindows) ? pacing.timelineWindows.map(record) : []
      const bindings = timeline.filter(item => item.startSecond === Number(window[1]) && item.endSecond === Number(window[2]))
      if (bindings.length !== 1 || !Array.isArray(bindings[0].beatIds)) throw Error('MEDIA_REQUIREMENTS_INVALID: duration-v2 原时间窗必须唯一绑定生成前的timelineWindows，不能事后推测参考窗')
      const beats = Array.isArray(pacing.beats) ? pacing.beats.map(record) : []
      const schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(record) : []
      const ids = bindings[0].beatIds as unknown[]
      if (new Set(ids).size !== ids.length) throw Error('MEDIA_REQUIREMENTS_INVALID: duration-v2 原时间窗含重复节拍')
      const beatQuotes = Array.isArray(bindings[0].beatQuotes) ? bindings[0].beatQuotes.map(record) : []
      const authoredBody = source.slice(window.index + window[0].length, endIndex).trim()
      if (ids.length && (beatQuotes.length !== ids.length || beatQuotes.some((quote, i) => quote.beatId !== ids[i]
        || typeof quote.quote !== 'string' || !quote.quote.trim()) || beatQuotes.map(quote => quote.quote).join('同时，') !== authoredBody)) {
        throw Error('MEDIA_REQUIREMENTS_INVALID: duration-v2 beatQuotes必须按原顺序逐字覆盖原窗口正文，不得漏审或把其他节拍义务混入')
      }
      const searches = ids.map(id => {
        const items = beats.filter(beat => beat.id === id), slots = schedule.filter(row => row.beatId === id)
        const beat = items[0], slot = slots[0], constraint = record(slot?.timingConstraint)
        if (items.length !== 1 || slots.length !== 1 || typeof beat.sourceBeatId !== 'string' || !beat.sourceBeatId.trim()
          || slot.sourceBeatId !== beat.sourceBeatId || !['reference', 'hard'].includes(String(constraint.mode))
          || ['mode', 'notBeforeSecond', 'deadlineSecond'].some(key => constraint[key] !== record(beat.timingConstraint)[key])
          || Number(slot.startSecond) < Number(window[1]) || Number(slot.endSecond) > Number(window[2])) throw Error('MEDIA_REQUIREMENTS_INVALID: duration-v2 节拍来源或生成前时间分类不一致')
        const start = constraint.mode === 'hard' && constraint.notBeforeSecond !== undefined ? Number(constraint.notBeforeSecond) : 0
        const end = constraint.mode === 'hard' && constraint.deadlineSecond !== undefined ? Number(constraint.deadlineSecond) : duration
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration) throw Error('MEDIA_REQUIREMENTS_INVALID: duration-v2 硬时间范围非法；不得放宽或截断')
        return { beatId: String(id), sourceBeatId: beat.sourceBeatId, timingConstraint: { ...constraint }, startSecond: start, endSecond: end }
      })
      if (searches.length) {
        // A mixed parallel window must not let a reference beat lend its
        // full-clip discovery scope to a different beat's hard obligation.
        requirements.pop()
        for (const [i, search] of searches.entries()) {
          add('videoPrompt', String(beatQuotes[i].quote), 'interval', Number(window[1]), Number(window[2]))
          Object.assign(requirements[requirements.length - 1], { timingBeatId: search.beatId, sourceBeatId: search.sourceBeatId, eventSearchRanges: [search] })
        }
      }
    }
  }
  if (typeof shot.lastFramePrompt === 'string' && shot.lastFramePrompt.trim()) add('lastFramePrompt', shot.lastFramePrompt.trim(), 'ending', duration, duration)
  return requirements
}

/** Bind deriveMediaRequirements, validateMediaEvidenceGaps and resolveNativeFrameDisplayInterval.
 * Audio timing remains governed by measured speech checks, never these windows. */
export function validateMediaRequirementChecks(review: Record<string, unknown>, shot: Record<string, unknown>, evidence: Record<string, unknown>, policy: Record<string, unknown> = {}) {
  const requirements = deriveMediaRequirements(shot)
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  const errors: string[] = [], issues: string[] = []
  const unobservableRequirements: Array<{ requirementId: string; requirementPath: string; scope: string; evidence: string; frameIndices: number[]; scopeNotes?: unknown; evidenceGaps?: unknown }> = []
  const blockingUnobservableRequirements: typeof unobservableRequirements = []
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const pacing = record(shot.pacing)
  const criticalityContext = [
    { sourcePath: 'completionCriteria', value: shot.completionCriteria },
    { sourcePath: 'storyProgress', value: shot.storyProgress },
    { sourcePath: 'pacing.performanceBeats', value: pacing.performanceBeats },
    { sourcePath: 'pacing.activityWindows', value: pacing.activityWindows },
    ...(pacing.version === 'duration-v2' ? [{ sourcePath: 'pacing.beats', value: pacing.beats }] : []),
  ].filter(source => source.value !== undefined)
  const invalid = (reason: string): never => { throw Error('REVIEW_RESULT_INVALID: ' + reason + '；逐项复核同一素材，不购买新视频') }
  if (!Array.isArray(review.requirementChecks)) invalid('缺少原要求逐项 requirementChecks，不能只报告主动发现的缺陷')
  const checks = review.requirementChecks as unknown[], knownIds = new Set(requirements.map(item => item.id))
  const frames = Array.isArray(evidence.frames) ? evidence.frames : [], times = Array.isArray(evidence.frameTimes) ? evidence.frameTimes : []
  const displays = frames.map((_, index) => resolveNativeFrameDisplayInterval(evidence, index))
  const toleranceValue = [policy.timingTolerance, policy.timingToleranceSeconds].find(value => Number.isFinite(value))
  const tolerance = toleranceValue === undefined ? 0 : Math.max(0, Number(toleranceValue))
  const uncertain = (value: unknown) => typeof value === 'string' && /疑似|可能(?:是|为|存在|属于|手持|持有|有)|可能性|需(?:要)?(?:进一步)?确认|(?:无法|不能|难以|未能)\s*(?:完全\s*)?(?:确定|确认|判断|辨认|区分|排除)|不(?:明确|确定|清楚)|证据不足|看不清|\b(?:unknown|uncertain|may|might|possibly|unclear|unconfirmed)\b/i.test(value)
  for (const [index, value] of checks.entries()) {
    if (!knownIds.has(String(record(value).requirementId))) errors.push('requirementChecks[' + index + '] 不对应当前原要求 id')
  }
  for (const requirement of requirements) {
    const matches = checks.filter(value => record(value).requirementId === requirement.id), label = requirement.id + ' (' + requirement.requirementPath + ')'
    if (matches.length !== 1) { errors.push(label + ' 必须恰好复核一次，当前 ' + matches.length + ' 项'); continue }
    const check = record(matches[0]), startErrorCount = errors.length
    if (!['complete', 'incomplete', 'unobservable'].includes(String(check.status)) || !nonempty(check.evidence)) {
      errors.push(label + ' 缺少 complete/incomplete/unobservable 与实际 evidence'); continue
    }
    if (check.status !== 'unobservable' && uncertain(check.evidence)) errors.push(label + ' 状态与本项不确定证据矛盾；原要求未知须保留 evidenceGaps 与 unobservable')
    const searchRanges = requirement.eventSearchRanges?.map(search => ({ ...search,
      endSecond: search.timingConstraint.mode === 'reference' || search.timingConstraint.deadlineSecond === undefined
        ? Number(evidence.duration) : Math.min(Number(evidence.duration), search.endSecond) }))
      ?? [{ startSecond: requirement.startSecond, endSecond: requirement.endSecond }]
    const allowedFrames = frames.flatMap((_, index) => Number.isFinite(times[index]) && (requirement.scope === 'opening' ? index === 0
      : requirement.scope === 'ending' ? index === frames.length - 1
        : searchRanges.some(search => Number(times[index]) >= search.startSecond - (requirement.eventSearchRanges ? 0 : tolerance)
          && Number(times[index]) <= search.endSecond + (requirement.eventSearchRanges ? 0 : tolerance)
          || Boolean(displays[index] && displays[index]!.startSecond <= search.endSecond && displays[index]!.endSecond > search.startSecond)))
      ? [{ index, second: times[index] }] : [])
    const gaps = validateMediaEvidenceGaps(check, requirement, allowedFrames.map(frame => frame.index), criticalityContext,
      { allowNoncriticalEvidenceGaps: policy.allowNoncriticalEvidenceGaps === true })
    errors.push(...gaps.errors.map(error => label + ' ' + error))
    const refs = check.frameIndices
    if (!Array.isArray(refs) || (check.status !== 'unobservable' && !refs.length) || new Set(refs).size !== refs.length
      || refs.some(index => !Number.isInteger(index) || Number(index) < 0 || Number(index) >= frames.length || !Number.isFinite(times[Number(index)]))) {
      errors.push(label + ' 缺少有效实际帧编号与时刻，不能仅凭ASR证明姿态或动作')
    } else if (refs.some(index => !allowedFrames.some(frame => frame.index === index))) {
      errors.push(label + ' 引用帧不在原要求 ' + requirement.scope + ' 的实际范围内；原时间范围=[' + requirement.startSecond + ',' + requirement.endSecond + ']秒'
        + '，实际容差=' + tolerance + '秒，收到原帧=' + JSON.stringify(refs.map(index => ({ index, second: times[Number(index)] })))
        + '，合法原帧=' + JSON.stringify(allowedFrames) + '；不得借用区间前后的上下文帧。合法索引只限定采证范围，不证明complete；须根据实际画面重新判断，证据不足仍为unobservable')
    }
    if (check.status === 'unobservable') {
      if (check.repair !== undefined || check.defectIndex !== undefined) errors.push(label + ' unobservable 不得绑定拒绝缺陷或提供重拍 repair')
      if (errors.length === startErrorCount) {
        const item = { requirementId: requirement.id, requirementPath: requirement.requirementPath,
          scope: requirement.scope, evidence: String(check.evidence), frameIndices: [...refs as number[]],
          ...(check.scopeNotes === undefined ? {} : { scopeNotes: clone(check.scopeNotes) }),
          ...(check.evidenceGaps === undefined ? {} : { evidenceGaps: clone(check.evidenceGaps) }) }
        unobservableRequirements.push(item)
        if (gaps.blocking) blockingUnobservableRequirements.push(clone(item))
      }
      continue
    }
    if (check.status === 'incomplete') {
      const defects = Array.isArray(review.defectEvidence) ? review.defectEvidence : [], defect = record(defects[Number(check.defectIndex)])
      const complaints = Array.isArray(review.issues) ? review.issues : []
      if (!Number.isInteger(check.defectIndex) || Number(check.defectIndex) < 0 || Number(check.defectIndex) >= defects.length
        || defect.status !== 'confirmed' || defect.category !== 'script' || defect.source !== 'frame'
        || String(defect.requirementPath).replace(/^(?:shot_script|shot)\./, '') !== requirement.requirementPath
        || !nonempty(defect.requirementQuote) || !requirement.requirementQuote.includes(defect.requirementQuote)
        || requirement.timingBeatId !== undefined && (defect.timingBeatId !== requirement.timingBeatId || defect.sourceBeatId !== requirement.sourceBeatId)
        || defect.scope !== requirement.scope || !Number.isInteger(defect.issueIndex) || !nonempty(complaints[Number(defect.issueIndex)])) {
        errors.push(label + ' incomplete 的 defectIndex 必须绑定同一原要求的 confirmed script/source=frame 缺陷与其实际 issueIndex；未绑定不能触发重拍')
      }
      if (check.repair !== undefined) errors.push(label + ' 不得独立提供 repair；仅复用绑定 defectEvidence 经类别、来源和指标校验的修复')
      if (!nonempty(defect.repair) || uncertain(defect.repair)) errors.push(label + ' 绑定的确证缺陷需明确局部 repair')
      if (errors.length === startErrorCount) issues.push(String(complaints[Number(defect.issueIndex)]))
    }
  }
  if (errors.length) invalid(errors.map((reason, index) => '(' + (index + 1) + ') ' + reason).join('；'))
  // Coverage cannot create a second, untyped route to a paid retake. The defect
  // validator must validate and publish every issue's sole repair instruction.
  return { issues, retryPrompt: '', unobservableRequirements, blockingUnobservableRequirements }
}
