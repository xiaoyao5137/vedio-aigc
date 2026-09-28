import { MAX_NODE_ATTEMPTS } from './retry-budget.ts'

/** A new semantic candidate must not reuse a transport-success checkpoint for
 * an older, invalid candidate with the same prompt. Pass the original context
 * and the shared writer budget's consumed generation number, including child repairs.
 * Socket reattachment reuses this returned context unchanged. */
export function contextWithGenerationAttempt<T extends { requestKey?: string }>(context: T, generation: number): T {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_NODE_ATTEMPTS) {
    throw new Error(`GENERATION_ATTEMPT_INVALID: 语义生成序号必须为 1–${MAX_NODE_ATTEMPTS} 的整数`)
  }
  if (!context.requestKey?.trim()) return context
  return { ...context, requestKey: `${context.requestKey}:generation-${generation}` }
}
