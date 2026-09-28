import { compactHistoricalReviewContext } from './review-input.ts'

/** Stable locators over the actual retrieved text. No model text is used here. */
export function historicalSourceSpans(value: unknown) {
  const sources = Array.isArray(value) ? value : []
  const spans: { id: string; citationIndex: number; start: number; end: number; quote: string }[] = []
  for (const [index, source] of sources.entries()) {
    const content = source && typeof source === 'object' && typeof source.content === 'string' ? source.content : ''
    for (const match of content.matchAll(/[^\n。！？]+(?:[。！？]+|(?=\n|$))/gu)) {
      const leading = match[0].length - match[0].trimStart().length
      const text = match[0].trim()
      if (text.replace(/[\s\p{P}\p{S}]/gu, '').length < 4) continue
      for (let offset = 0; offset < text.length; offset += 320) {
        const quote = text.slice(offset, offset + 320)
        if (quote.replace(/[\s\p{P}\p{S}]/gu, '').length < 4) continue
        const start = match.index + leading + offset, end = start + quote.length
        // Detect stale locators without browser-only or Node-only crypto APIs.
        // Resolution always rebuilds the catalogue from current source bytes.
        let hash = 2166136261
        for (let i = 0; i < quote.length; i++) hash = Math.imul(hash ^ quote.charCodeAt(i), 16777619) >>> 0
        spans.push({ id: 's' + (index + 1) + ':' + start + '-' + end + ':' + hash.toString(16), citationIndex: index + 1, start, end, quote })
      }
    }
  }
  return spans
}

/** Self-contained apart from historicalSourceSpans, for editable code nodes. */
export function resolveHistoricalReviewSourceSpans(value: unknown, sources: unknown, buildSpans: typeof historicalSourceSpans = historicalSourceSpans) {
  const invalid = (reason: string): never => { throw Error('REVIEW_RESULT_INVALID: 史料片段引用 ' + reason) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const review = value as Record<string, unknown>
  if (!Array.isArray(review.evidence)) return value
  const spans = new Map(buildSpans(sources).map(span => [span.id, span]))
  const evidence = review.evidence.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('证据条目无效')
    const row = { ...value } as Record<string, unknown>
    if (row.sourceSpanId !== undefined) {
      const span = typeof row.sourceSpanId === 'string' ? spans.get(row.sourceSpanId) : undefined
      if (!span) return invalid('编号不存在或史料已变化；重新从当前目录选择，禁止猜测编号')
      if (row.citationIndex !== undefined && row.citationIndex !== span.citationIndex) invalid('编号与来源序号冲突')
      if (row.quote !== undefined && row.quote !== span.quote) invalid('编号与附带引文冲突；不得用转述覆盖原文')
      if (typeof row.supports !== 'string' || !row.supports.trim()) invalid('缺少该片段支持当前候选的具体事实说明')
      Object.assign(row, { citationIndex: span.citationIndex, quote: span.quote, sourceSpan: { id: span.id, start: span.start, end: span.end } })
    }
    if (row.itemIds === undefined) return [row]
    if (row.itemId !== undefined || !Array.isArray(row.itemIds) || !row.itemIds.length || row.itemIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(row.itemIds).size !== row.itemIds.length) invalid('共享引证必须显式列出不重复的itemIds，不能与itemId混用')
    const { itemIds, ...rest } = row
    return (itemIds as string[]).map(itemId => ({ ...rest, itemId }))
  })
  return { ...review, evidence }
}

/** Use after node parameters resolve, so both the app and CLI review the same candidate. */
export function historicalSourceReviewContext(inputContext: Record<string, unknown>) {
  const context = compactHistoricalReviewContext(inputContext)
  const params = context.params && typeof context.params === 'object' ? context.params as Record<string, unknown> : {}
  const candidate = params.candidate as Record<string, unknown> | undefined
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw Error('HISTORY_REVIEW_INPUT_INVALID: 缺少实际candidate，已阻止发送空审核请求')
  if (candidate.scenes !== undefined && !Array.isArray(candidate.scenes)) throw Error('HISTORY_REVIEW_INPUT_INVALID: candidate.scenes必须是已校验的场景数组')
  const items = Array.isArray(candidate.scenes) ? candidate.scenes : [candidate]
  if (!items.length || items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim()) || new Set(items.map(item => item.id)).size !== items.length) throw Error('HISTORY_REVIEW_INPUT_INVALID: 审核候选必须有非空、唯一的场景或镜头id')
  const sources = context.historical_sources && typeof context.historical_sources === 'object'
    ? (context.historical_sources as Record<string, unknown>).citations : undefined
  const sourceSpans = historicalSourceSpans(sources)
  if (!sourceSpans.length) throw Error('HISTORY_REVIEW_INPUT_INVALID: 当前史料没有可定位正文片段')
  // Keep every original character, including short lines between citable spans.
  // Inline labels avoid sending both the full source and hundreds of repeated
  // JSON objects with the same text, offsets and source metadata.
  const numberedSources = (Array.isArray(sources) ? sources : []).map((source, index) => {
    const content = typeof source?.content === 'string' ? source.content : ''
    let cursor = 0, numberedText = ''
    for (const span of sourceSpans.filter(span => span.citationIndex === index + 1)) {
      numberedText += content.slice(cursor, span.start) + '⟦' + span.id + '⟧' + span.quote + '⟦/⟧'
      cursor = span.end
    }
    numberedText += content.slice(cursor)
    return { citationIndex: index + 1, title: source?.title, url: source?.url, numberedText }
  })
  const expectedCoverage = items.map((item: Record<string, unknown>) => ({
    itemId: item.id,
    characters: [...new Set(Array.isArray(item.cast) ? item.cast : Array.isArray(item.characters) ? item.characters : [])],
    evidenceRequired: true,
  }))
  return { ...context, history_source_review: { version: 'source-spans-v1', expectedCoverage, sources: numberedSources } }
}

// Explicit bindings and dependency injection also survive production minification.
// The resolver's default dependency is never evaluated in the sandbox.
export const HISTORICAL_SOURCE_REVIEW_RUNTIME_CODE = 'const historicalSourceSpans = (' + historicalSourceSpans.toString() + ');\n'
  + 'const resolveHistoricalReviewSourceSpans = (value, sources) => (' + resolveHistoricalReviewSourceSpans.toString() + ')(value, sources, historicalSourceSpans);'
