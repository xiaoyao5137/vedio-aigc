import { parseStructuredJson } from './workflow-core.ts'

type Value = Record<string, unknown>
const record = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const REPORT_ENVELOPE_KEYS = new Set(['raw', 'text', 'model', 'executionLogs'])
const PREVIOUS_SHOT_WRAPPERS = new Set([
  ...REPORT_ENVELOPE_KEYS, 'contentReview', 'factualReview', 'dramaturgyReview', 'repairContext', 'repairProvenance',
  'passed', 'issues', 'reviewVersion', 'scriptValidation', 'timingEstimate',
])

function withoutTopLevelKeys<T>(value: T, keys: Set<string>): T {
  if (!record(value) || !Object.keys(value).some(key => keys.has(key))) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key))) as T
}

/** The normalized report is authoritative. Its raw/text fields duplicate that
 * report; nested issue.text, ASR text and quoted evidence remain untouched. */
export function compactReviewReport<T>(report: T): T {
  if (!record(report) || !(typeof report.passed === 'boolean' || typeof report.decision === 'string'
    || Array.isArray(report.evidence) || Array.isArray(report.issues))) return report
  return withoutTopLevelKeys(report, REPORT_ENVELOPE_KEYS)
}

function hasNormalizedResultPayload(value: Value): boolean {
  if (!Object.hasOwn(value, 'raw')) return false
  if (typeof value.text === 'string') {
    // Match the normalizer's output shape, including fenced JSON and array
    // outputs. Plain text or malformed JSON is still the only useful output.
    const parsed = parseStructuredJson(value.text)
    if (Array.isArray(parsed)) return Array.isArray(value.items) || Array.isArray(value.shots)
    if (!record(parsed)) return false
    const payloadKeys = Object.keys(parsed).filter(key => !REPORT_ENVELOPE_KEYS.has(key))
    // Values may have been grounded or repaired since normalization. The
    // durable parsed text must not replace those authoritative current fields.
    return payloadKeys.length > 0 && payloadKeys.every(key => Object.hasOwn(value, key))
  }
  // Media nodes expose their usable asset outside the provider response.
  // A raw response or a status/model-only envelope has no normalized payload.
  const modelResult = typeof value.model === 'string' || (record(value.raw) && typeof value.raw.model === 'string')
  return modelResult && ((typeof value.url === 'string' && value.url.length > 0)
    || (Array.isArray(value.urls) && value.urls.length > 0)
    || (Array.isArray(value.items) && value.items.length > 0))
}

/** Prompt-only view of normalized node results, including mapped items and
 * nested result snapshots. Never drop arbitrary business `text`/`data` fields:
 * only a recognized result envelope loses its top-level transport fields.
 * No truncation, frame sampling, evidence rewriting or durable mutation occurs. */
export function compactNodeResultValue<T>(value: T): T {
  const seen = new WeakMap<object, unknown>()
  const compact = (current: unknown): unknown => {
    if (!Array.isArray(current) && !record(current)) return current
    if (seen.has(current)) return seen.get(current)
    if (Array.isArray(current)) {
      const items = current.map(compact)
      const result = items.some((item, index) => item !== current[index]) ? items : current
      seen.set(current, result)
      return result
    }
    const normalized = hasNormalizedResultPayload(current)
    let changed = false
    const entries = Object.entries(current).flatMap(([key, item]) => {
      if (normalized && REPORT_ENVELOPE_KEYS.has(key)) {
        changed = true
        return []
      }
      // Unparsed transport data remains intact as repair evidence. Walking it
      // could mistake a provider's nested fields for another node result.
      const next = REPORT_ENVELOPE_KEYS.has(key) ? item : compact(item)
      if (next !== item) changed = true
      return [[key, next]]
    })
    const result = changed ? Object.fromEntries(entries) : current
    seen.set(current, result)
    return result
  }
  return compact(value) as T
}

/** Opt-in node parameter; execution/validation/code contexts keep the originals. */
export function nodePromptInputContext<T extends Value>(context: T, mode: unknown): T {
  return mode === 'normalized-results' ? compactNodeResultValue(context) : context
}

function compactPreviousReport<T>(value: T): T {
  if (!record(value) || !Object.hasOwn(value, 'previousReport')) return value
  const previousReport = compactReviewReport(value.previousReport)
  return previousReport === value.previousReport ? value : { ...value, previousReport }
}

/** Reviewer-only projection; never edit the candidate or durable execution
 * records. Grounded top-level state wins over obsolete scripts quoted inside
 * previous reviews and repair snapshots. */
export function compactHistoricalReviewContext<T extends Value>(context: T): T {
  let result: Value = context
  if (record(context.loop) && record(context.loop.previous)) {
    const previous = context.loop.previous
    const shot = withoutTopLevelKeys(previous.shot_script, PREVIOUS_SHOT_WRAPPERS)
    if (shot !== previous.shot_script) result = { ...result, loop: { ...context.loop, previous: { ...previous, shot_script: shot } } }
  }
  if (record(context.retry)) {
    const retry = compactPreviousReport(context.retry)
    const feedback = compactPreviousReport(retry.feedback)
    if (retry !== context.retry || feedback !== retry.feedback) result = { ...result, retry: { ...retry, feedback } }
  }
  return result as T
}
