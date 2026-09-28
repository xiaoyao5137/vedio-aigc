export const MEDIA_EVIDENCE_GAPS_PROMPT = `【观察事实与未证实细项】
关键性依原文与上下文：completionCriteria=剧情完成条件；storyProgress=阶段/结果/待续行动；pacing.performanceBeats=明确表演节拍；pacing.activityWindows=活动时间预算，kind/起止时间本身不建立独立回应、因果或节拍义务，须读原条目和剧情语义。原计划仅解释关键性，不能证明实际发生。原文明定的结果/回应/因果/节拍动作即使轻微仍关键；完成条件或节拍未列出不等于可忽略时间线。物件归属、递交接收、场景行动、人物进出、明确持续状态等实质要求未重复仍须实证；关键性不明保留unobservable/undetermined。
evidence只写实见；scopeNotes为非空文本数组，仅方法/模态限制；计划不是实证。
evidenceGaps每项含requirementQuote（本项原文子句）、status=unobservable、evidence（未知原因）、frameIndices（合法无重复，可[]）、acceptanceImpact:{level:blocking/warning/undetermined,reason,policyRule?,contextReferences?:[{sourcePath,quote}]}。有gap时本项仍为unobservable，不能藏入complete/warnings；旧unobservable无gap默认阻断。
sourcePath用已给根或真实子路径。quote只能复制一个字符串叶子的连续原文，不含JSON键名、结构引号、数值、转义或跨字段/数组元素拼接。合法引文不等于关键性依据。无可用原文不造引用，用undetermined。
warning须allowNoncriticalEvidenceGaps=true、policyRule=noncritical-performance-variation、非空reason和≥1有效contextReferences，并有本项范围内原图及frameIndices支撑实质事实；gap帧号仍可[]。reason说明细项为何不承担行动结果、人物回应、因果或明确表演节拍且不影响实质义务；不能仅因幅度轻微、采样未见或完成条件未重复列出而降级。无充分依据用undetermined；与blocking均须同素材补证。
warning只表示政策允许未知不阻断，未知仍保留。代码只校验契约与来源绑定，不替你判断语义；不得自动把综合报告的uncertain/false升级为accepted/true。
【观察事实与未证实细项结束】`

/** Validate declared evidence gaps and their explicit policy disposition. This
 * checks the contract and source bindings, not the truth of a semantic claim.
 * Self-contained for embedding in the isolated workflow VM. */
export function validateMediaEvidenceGaps(check: Record<string, unknown>, requirement: { requirementQuote: string }, allowedFrameIndices: number[],
  criticalityContext: Array<{ sourcePath: string; value: unknown }>, policy: { allowNoncriticalEvidenceGaps?: boolean } = {}): {
    errors: string[]; blocking: boolean; nonblockingGapIndices: number[]
  } {
  const errors: string[] = [], nonblockingGapIndices: number[] = []
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  const row = record(check)
  if (row.scopeNotes !== undefined && (!Array.isArray(row.scopeNotes) || row.scopeNotes.some(note => !nonempty(note)))) errors.push('scopeNotes须为非空文本组成的数组，方法限制不得混入事实evidence')
  const value = row.evidenceGaps
  if (value === undefined) return { errors, blocking: errors.length > 0 || row.status === 'unobservable', nonblockingGapIndices }
  if (!Array.isArray(value)) return { errors: [...errors, 'evidenceGaps须为数组，不能隐藏未证实细项'], blocking: true, nonblockingGapIndices }
  if (!value.length) return { errors, blocking: errors.length > 0 || row.status === 'unobservable', nonblockingGapIndices }
  if (row.status !== 'unobservable') errors.push('存在evidenceGaps时本项status必须保留unobservable，不能把未知改为complete或incomplete')
  if (!nonempty(record(requirement).requirementQuote)) errors.push('缺少可绑定的本项requirementQuote原文')
  if (!Array.isArray(allowedFrameIndices) || allowedFrameIndices.some(index => !Number.isInteger(index) || index < 0)
    || new Set(allowedFrameIndices).size !== allowedFrameIndices.length) errors.push('allowedFrameIndices须为无重复的有效原编号数组')
  if (!Array.isArray(criticalityContext)) errors.push('criticalityContext须为保留原字段来源的数组')
  // Match a contiguous excerpt in one original string value, never a JSON key,
  // a serialized escape, or text assembled across separate source fields.
  const includesSourceQuote = (source: unknown, quote: string): boolean => {
    const pending = [source], visited = new WeakSet<object>()
    while (pending.length) {
      const current = pending.pop()
      if (typeof current === 'string' && current.includes(quote)) return true
      if (current && typeof current === 'object' && !visited.has(current)) {
        visited.add(current)
        pending.push(...(Array.isArray(current) ? current : Object.values(current)))
      }
    }
    return false
  }
  const sourcePathParts = (path: unknown): string[] | undefined => {
    if (!nonempty(path)) return undefined
    const parts = path.replace(/\[(0|[1-9]\d*)\]/g, '.$1').split('.')
    if (parts.some(part => !/^(?:[\p{L}_$][\p{L}\p{N}_$]*|0|[1-9]\d*)$/u.test(part)
      || ['__proto__', 'prototype', 'constructor'].includes(part))) return undefined
    return parts
  }
  const resolveContextSource = (path: unknown): { found: boolean; value?: unknown } => {
    const requested = sourcePathParts(path)
    if (!requested || !Array.isArray(criticalityContext)) return { found: false }
    const roots = criticalityContext.flatMap(source => {
      const root = record(source), parts = sourcePathParts(root.sourcePath)
      return parts && parts.length <= requested.length && parts.every((part, index) => part === requested[index]) ? [{ root, parts }] : []
    })
    const longest = Math.max(0, ...roots.map(root => root.parts.length)), matches = roots.filter(root => root.parts.length === longest)
    if (matches.length !== 1) return { found: false }
    let value = matches[0].root.value
    for (const part of requested.slice(longest)) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)
        || (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(part))) return { found: false }
      value = (value as Record<string, unknown>)[part]
    }
    return { found: true, value }
  }
  let blocking = false
  for (const [index, entry] of value.entries()) {
    const gap = record(entry), impact = record(gap.acceptanceImpact), label = 'evidenceGaps[' + index + ']'
    const startErrorCount = errors.length
    if (!nonempty(gap.requirementQuote) || !String(record(requirement).requirementQuote ?? '').includes(gap.requirementQuote)) errors.push(label + '.requirementQuote须逐字取自本项原文，不能借用其他要求或改写')
    if (gap.status !== 'unobservable' || !nonempty(gap.evidence)) errors.push(label + '须保留status=unobservable及非空未知原因evidence')
    if (!Array.isArray(gap.frameIndices) || new Set(gap.frameIndices).size !== gap.frameIndices.length
      || gap.frameIndices.some(frame => !Number.isInteger(frame) || !Array.isArray(allowedFrameIndices) || !allowedFrameIndices.includes(Number(frame)))) errors.push(label + '.frameIndices须为本项合法、无重复的帧编号，未知可为空数组')
    if (!['blocking', 'warning', 'undetermined'].includes(String(impact.level)) || !nonempty(impact.reason)) errors.push(label + '.acceptanceImpact须包含合法level及非空reason，代码不代判关键性')
    if (impact.policyRule !== undefined && impact.policyRule !== 'noncritical-performance-variation') errors.push(label + '.acceptanceImpact.policyRule不属于可用政策规则')
    const references = impact.contextReferences
    if (references !== undefined && !Array.isArray(references)) errors.push(label + '.acceptanceImpact.contextReferences须为原上下文引用数组')
    if (Array.isArray(references)) for (const [referenceIndex, value] of references.entries()) {
      const reference = record(value), source = resolveContextSource(reference.sourcePath)
      if (!nonempty(reference.quote) || !source.found
        || !includesSourceQuote(source.value, String(reference.quote))) errors.push(label + '.acceptanceImpact.contextReferences[' + referenceIndex + ']须唯一定位原sourcePath或其真实子路径及原值内连续逐字引文，不能引用计划证明实际发生')
    }
    if (impact.level === 'warning') {
      if (policy?.allowNoncriticalEvidenceGaps !== true) errors.push(label + '的warning需要本次政策明确allowNoncriticalEvidenceGaps=true，默认不能降级未知')
      if (impact.policyRule !== 'noncritical-performance-variation' || !Array.isArray(references) || !references.length) errors.push(label + '的warning须绑定noncritical-performance-variation及至少一条原上下文引用')
      if (!Array.isArray(allowedFrameIndices) || !allowedFrameIndices.length || !Array.isArray(row.frameIndices) || !row.frameIndices.length
        || new Set(row.frameIndices).size !== row.frameIndices.length || row.frameIndices.some(frame => !Number.isInteger(frame)
          || !Array.isArray(allowedFrameIndices) || !allowedFrameIndices.includes(Number(frame)))) errors.push(label + '的warning须有本项范围内原图及合法frameIndices实际引用支撑已确认的实质事实，不能豁免整个无图要求')
      if (errors.length === startErrorCount) nonblockingGapIndices.push(index)
    } else blocking = true
  }
  // An invalid declaration must never accidentally exempt even one uncertainty.
  return errors.length ? { errors, blocking: true, nonblockingGapIndices: [] } : { errors, blocking, nonblockingGapIndices }
}
