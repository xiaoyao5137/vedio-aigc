export const MANUAL_QUALITY_DISPOSITION = 'manual-review-v1'
export const STRICT_QUALITY_DISPOSITION = 'strict-v1'
export type QualityDisposition = typeof MANUAL_QUALITY_DISPOSITION | typeof STRICT_QUALITY_DISPOSITION

/** Missing markers preserve strict semantics for saved executions and callers. */
export function isManualReview(value: unknown): boolean {
  return value === MANUAL_QUALITY_DISPOSITION || Boolean(value && typeof value === 'object'
    && (value as Record<string, unknown>).qualityDisposition === MANUAL_QUALITY_DISPOSITION)
}
