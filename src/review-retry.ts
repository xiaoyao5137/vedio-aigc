type Value = Record<string, unknown>
type ReviewTarget = { kind: string; resultVar: string; operation?: string; prompt?: string; params?: Array<{ name?: string; englishName?: string; value?: string }> }
const record = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const at = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' && !['__proto__', 'constructor', 'prototype'].includes(key) ? (current as Value)[key] : undefined, value)

export const REPORT_FORMAT_ERROR_PATTERN = /^(?:REVIEW_RESULT_INVALID|HISTORY_REVIEW_INVALID|VIDEO_REVIEW_INVALID):/

export type ReviewRetryDiagnostic = Value & { reportResultVar: string; error: string }

export function reportFormatRetryError(feedback: unknown): string | undefined {
  const value = record(feedback)
  const error = typeof feedback === 'string' ? feedback : value.kind === 'report-format' ? value.error : undefined
  return typeof error === 'string' && REPORT_FORMAT_ERROR_PATTERN.test(error) ? error : undefined
}

/** A present attribution list must be usable. An empty/malformed list must not
 * silently become an unassigned broadcast to the entire review group. */
export function reviewRetryDiagnostics(feedback: unknown): ReviewRetryDiagnostic[] | undefined {
  const value = record(feedback)
  if (!Object.hasOwn(value, 'diagnostics')) return undefined
  if (!reportFormatRetryError(feedback) || !Array.isArray(value.diagnostics) || !value.diagnostics.length
    || value.diagnostics.some(item => {
      const diagnostic = record(item)
      return typeof diagnostic.reportResultVar !== 'string' || !diagnostic.reportResultVar.trim()
        || typeof diagnostic.error !== 'string' || !diagnostic.error.trim()
    })) throw Error('REVIEW_RETRY_CONFIG_INVALID: diagnostics 必须逐项声明非空 reportResultVar 与 error')
  return value.diagnostics as ReviewRetryDiagnostic[]
}

/** Resolve only the failed reviewer's declared inputs. Never reconstruct missing
 * report content or borrow characters from a previous scene or report. */
export function reportFormatRetryFeedback(target: ReviewTarget, context: Value, feedback: unknown, options: { unassigned?: boolean } = {}): unknown {
  const originalError = reportFormatRetryError(feedback)
  if (target.kind !== 'text' || !originalError) return feedback
  const diagnostics = reviewRetryDiagnostics(feedback)?.filter(item => item.reportResultVar === target.resultVar)
  if (diagnostics && !diagnostics.length) return undefined
  // Do not leak another report's diagnosis through the aggregate error string.
  const error = diagnostics ? 'REVIEW_RESULT_INVALID: ' + diagnostics.map(item => item.error.replace(REPORT_FORMAT_ERROR_PATTERN, '').trim()).join('\n') : originalError
  const parameters = target.params ?? []
  const candidateParameter = parameters.find(param => (param.englishName || param.name) === 'candidate')
  const candidatePath = candidateParameter?.value?.match(/^\$\{([^}]+)\}$/)?.[1]?.trim()
  const paths = candidatePath ? [candidatePath] : [...new Set(
    [target.prompt ?? '', ...parameters.map(param => param.value ?? '')].flatMap(text => [...text.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1].trim())),
  )]
  const coverage: Value[] = []
  for (const path of paths) {
    if (/^(?:loop\.previous|retry|branch|params)(?:\.|$)/.test(path) || path === target.resultVar) continue
    const source = record(at(context, path))
    const entries = Array.isArray(source.scenes) ? source.scenes.map((item, index) => ({ item: record(item), path: `${path}.scenes.${index}` }))
      : Array.isArray(source.segments) ? source.segments.map((item, index) => ({ item: record(item), path: `${path}.segments.${index}` }))
        : [{ item: source, path }]
    for (const entry of entries) {
      const itemId = entry.item.id ?? entry.item.shotId
      const characters = entry.item.characters ?? entry.item.cast
      const beats = entry.item.requiredBeats ?? entry.item.beatDramaturgy
      if (typeof itemId !== 'string' || (!Array.isArray(characters) && !Array.isArray(beats) && !Array.isArray(entry.item.frames))) continue
      coverage.push({ path: entry.path, itemId,
        ...(Array.isArray(characters) ? { characters: characters.filter(name => typeof name === 'string') } : {}),
        ...(Array.isArray(beats) ? { beatIds: beats.map(beat => record(beat).id ?? record(beat).beatId).filter(id => typeof id === 'string') } : {}),
      })
    }
  }
  const previousReport = compactReviewReport(context[target.resultVar])
  const historicalReview = target.operation === 'history.script-review' && Boolean(candidatePath)
    && Object.keys(record(context.historical_sources)).length > 0
  let dramaturgyValidationError: string | undefined
  if (historicalReview && candidatePath && Object.hasOwn(record(previousReport), 'dramaturgyReview')) {
    const candidate = record(at(context, candidatePath))
    if (Object.keys(candidate).length) {
      try { validateDramaturgyReview(structuredClone(candidate), structuredClone(record(previousReport).dramaturgyReview)) }
      catch (failure) {
        if (!(failure instanceof Error) || !REPORT_FORMAT_ERROR_PATTERN.test(failure.message)) throw failure
        dramaturgyValidationError = failure.message
      }
    }
  }
  const expectedItemIds = [...new Set(coverage.map(item => item.itemId).filter((id): id is string => typeof id === 'string'))]
  const declaredIds = (value: unknown, shared: boolean): string[] => Array.isArray(value) ? [...new Set(value.flatMap(item => {
    const entry = record(item)
    if (typeof entry.itemId === 'string' && entry.itemId.trim() && entry.itemIds === undefined) return [entry.itemId]
    if (shared && entry.itemId === undefined && Array.isArray(entry.itemIds)
      && entry.itemIds.every(id => typeof id === 'string' && id.trim())) return entry.itemIds as string[]
    return []
  }))] : []
  const sourceIds = declaredIds(record(previousReport).evidence, true)
  const sourceEvidenceCoverage = historicalReview ? {
    field: 'review.evidence（报告最外层事实史料引证）', expectedItemIds, declaredItemIds: sourceIds,
    missingItemIds: expectedItemIds.filter(id => !sourceIds.includes(id)),
    declarationOnly: true,
    evidence: '{itemId,sourceSpanId,supports}，或原契约允许的逐字 quote/citationIndex；必须来自当前实际史料',
    shared: '同一史料确实支持多场时允许 {itemIds:[...],sourceSpanId,supports}；itemId 与 itemIds 不能并用',
    noExemption: '每场都必须有最外层事实 evidence；dramaturgyReview.evidence 或 dramaturgyReview.uncovered 均不能豁免史料引证',
  } : undefined
  // A reviewer that must fill four dramaturgy dimensions from a short evidence list
  // kept emitting `passed` with empty refs, because nothing stated that one index may
  // serve several dimensions. Hand back the exact index budget and current verdicts.
  const dramaturgy = record(record(previousReport).dramaturgyReview)
  const dimensions = ['orientation', 'dramaticProgression', 'characterDistinction', 'payoff']
    .filter(key => Object.hasOwn(dramaturgy, key))
    .map(key => { const check = record(dramaturgy[key]); return { key, status: check.status ?? null, evidenceRefs: check.evidenceRefs ?? null } })
  const evidenceCount = Array.isArray(dramaturgy.evidence) ? dramaturgy.evidence.length : 0
  // The audio-visual coverage gate has two honest exits. Naming both here stops a
  // reviewer from "fixing" a bookkeeping defect by rewriting the candidate, and keeps
  // it from inventing a citation just to satisfy a segment that a cited neighbour serves.
  const coverageChannels = Array.isArray(dramaturgy.evidence) ? {
    evidence: 'itemId 单场逐字引用（不支持 itemIds）',
    uncovered: '{itemId,reason,coveredBy}：coveredBy 必须是本报告中已被 evidence 引用的、与本场同一个 dramaticSceneId 的短段',
    neverUncoverable: ['候选首场', '候选末场', 'episodeDrama.openingPromise.beatIds 所属场', 'episodeDrama.payoff.beatIds 所属场', '单场候选'],
    alreadyCitedCannotBeDeclared: true,
    everyDramaticSceneNeedsOneCitation: true,
    ...(historicalReview ? {
      field: 'review.dramaturgyReview.evidence（候选声画落点，独立于最外层事实引证）', expectedItemIds,
      declaredItemIds: declaredIds(dramaturgy.evidence, false),
      declaredUncoveredItemIds: declaredIds(dramaturgy.uncovered, false),
      missingItemIds: expectedItemIds.filter(id => !declaredIds(dramaturgy.evidence, false).includes(id)
        && !declaredIds(dramaturgy.uncovered, false).includes(id)),
      declarationOnly: true,
    } : {}),
  } : undefined
  return structuredClone({ kind: 'report-format', error, reportResultVar: target.resultVar,
    ...(diagnostics ? { diagnostics, attribution: 'explicit' } : options.unassigned ? { attribution: 'unassigned' } : {}),
    previousReportAvailable: Object.hasOwn(context, target.resultVar), previousReport,
    coverage,
    ...(sourceEvidenceCoverage ? { sourceEvidenceCoverage } : {}),
    ...(dramaturgyValidationError ? { dramaturgyValidationError } : {}),
    ...(dimensions.length ? { dramaturgy: { evidenceCount,
      validEvidenceRefs: Array.from({ length: evidenceCount }, (_, index) => index),
      indexReuseAllowed: true, notApplicableAllowed: true, checks: dimensions } } : {}),
    ...(coverageChannels ? { dramaturgyCoverageChannels: coverageChannels } : {}),
    instruction: [
      ...(options.unassigned && !diagnostics ? ['本次门禁错误尚未归属到单份报告；这是审核组复核通知，不代表本报告一定有错。只核对自己负责的报告与原始证据，不代改其他审核报告，不凭其他报告的错误新增本报告的拒绝。'] : []),
      (options.unassigned && !diagnostics ? '先判断诊断是否涉及本报告的字段；本报告没有相关错误时保留有据内容，涉及本报告时修正相应格式、引文或覆盖缺漏。' : '修正上一份报告中已定位的格式、引文或覆盖缺漏，按当前候选覆盖清单逐项核对。')
        + '报错一次列出多项缺陷时，必须在同一份报告里全部修完再返回，不要只修第一项。上一报告是待核对草稿；只保留经当前原始证据与实际配置支持的内容，不保留已被否定的结论。对声称“不构成错误”的条目、被实测阈值否定的拒绝及缺少事实的推断，应纠正其分类并重新核对 issues、逐项检查与最终判定的一致性，不能补造证据维护旧判定。真实有据缺陷仍须保留，未知仍为未知。',
      ...(dimensions.length ? ['dramaturgyReview 的四个分项判 passed 或 failed 时必须给出 validEvidenceRefs 中至少一个索引，同一条索引可被多个分项复用；本候选确实未分配该义务时如实改判 not_applicable 并说明理由，这是如实结论，不属于编造通过。'] : []),
      ...(coverageChannels ? [(historicalReview
        ? '被点名缺少声画覆盖的场次，只需就地为它补一条 review.dramaturgyReview.evidence 逐字落点，或在 review.dramaturgyReview.uncovered 里声明由同一场完整戏内哪个已落点短段承担；'
        : '被点名缺少声画覆盖的场次，只需就地为它补一条 evidence 逐字落点，或在 uncovered 里声明由同一场完整戏内哪个已落点短段承担；')
        + '其余仍有原文支持且未被本次错误否定的证据条目必须逐字保留原文，不重排、不改写、不删除，也不得因此改动候选。'] : []),
      ...(sourceEvidenceCoverage ? [
        '按字段分别完成两层任务：review.evidence 是报告最外层的事实史料引证，必须覆盖 sourceEvidenceCoverage.expectedItemIds 的每一场；优先逐项补齐 missingItemIds，同一原文确实支持多场时可明确用 itemIds 共享。review.dramaturgyReview.evidence 是候选中的实际声画落点，只用 itemId；声画层允许的 uncovered 不能代替或免除该场最外层史料引证。上列 declaredItemIds 只是上一报告的声明清单，不代表引文已通过真实性审核。',
        '修复 issues 的非法 path/quote（例如 cast 演员名单不属于实际 beat/action/dialogue 声画正文）时，只纠正该问题项的定位、分类或无据结论；不能通过删除任何一层 evidence 中该场的已有有据条目或缩小 itemIds 来修复 issue。若原拒绝缺少可定位的声画证据，应如实撤销该拒绝或按契约归类，不能补造动作引文，也不能把同场史料证据一起删掉。',
      ] : []),
      ...(dramaturgyValidationError ? ['dramaturgyValidationError 是对同一候选与上一份叙事报告的独立只读复验结果；它可能被先前的史料引证错误遮挡。本次必须同时修正这些已知问题（包括非法 issues 定位与越界 evidenceRefs），不能先修史料后再等待下一轮发现；原错误、各层覆盖及仍有据证据均须保留并一起核对。'] : []),
      '仅返回当前审核契约要求的完整报告，不新增其他审核类型的字段，不改写候选，不把缺少证据编造成通过。',
    ].join(''),
  })
}
import { compactReviewReport } from './review-input.ts'
import { validateDramaturgyReview } from './drama-quality-presets.ts'
