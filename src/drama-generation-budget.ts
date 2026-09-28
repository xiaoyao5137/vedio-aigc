import { MAX_NODE_ATTEMPTS, resolveRetryAttemptLimit } from './retry-budget.ts'
export const DEFAULT_DRAMA_GENERATION_ATTEMPTS = 2

/** Configuration, writer loops and shared accounting must use the same bound. */
export function resolveDramaGenerationLimit(value: unknown, fallback = DEFAULT_DRAMA_GENERATION_ATTEMPTS, qualityDisposition?: unknown) {
  return Math.min(qualityDisposition === 'manual-review-v1' ? 2 : MAX_NODE_ATTEMPTS, resolveRetryAttemptLimit(value, fallback))
}

/** Structural correction and editorial rewrites share the same writer budget. */
export function createDramaGenerationBudget(feedback: unknown, configuredLimit = DEFAULT_DRAMA_GENERATION_ATTEMPTS) {
  const limit = resolveRetryAttemptLimit(configuredLimit)
  const value = feedback && typeof feedback === 'object' ? feedback as Record<string, unknown> : {}
  const previous = value.previousCandidate as Record<string, unknown> | undefined
  const provenance = previous?.repairProvenance as Record<string, unknown> | undefined
  let used = Number(provenance?.generationAttempts ?? 0)
  if (!Number.isInteger(used) || used < 0) throw new Error('DRAMA_GENERATION_LIMIT: 无效的实际生成次数')
  return {
    consume() {
      if (used >= limit) throw new Error(`DRAMA_GENERATION_LIMIT: 结构修正与内容重写合计已达 ${limit} 次，保留候选及审核意见，不继续购买生成`)
      used += 1
    },
    /** Structural self-correction must stop before the shared budget is spent so the caller
     * surfaces the real validation error; letting `consume()` fire there replaced an
     * actionable defect list with a cost message and discarded the best candidate. */
    canConsume() { return used < limit },
    get used() { return used },
  }
}

/** Keep repeated diagnostics visible, but never let this secondary guard shorten
 * the configured generation budget. The caller passes one more than its total
 * attempt limit, so exhaustion surfaces the actionable validator error after all
 * configured attempts have actually been used. */
export function createDramaRepairProgressGuard(repeatLimit = MAX_NODE_ATTEMPTS + 1) {
  let previous = ''
  let repeats = 0
  return {
    record(validationMessage: string) {
      const fingerprint = validationMessage.trim()
      repeats = fingerprint === previous ? repeats + 1 : 1
      previous = fingerprint
      if (repeats >= repeatLimit) {
        throw new Error(`${validationMessage}\nDRAMA_REPAIR_STALLED: 同一校验缺陷已连续出现 ${repeats} 次，已停止无进展的付费重试`)
      }
    },
  }
}
