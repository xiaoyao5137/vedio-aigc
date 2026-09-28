/** Total attempts per retryable node, including its first execution. */
export const MAX_NODE_ATTEMPTS = 5

/** The configuration and every execution layer share the same finite bound. */
export function resolveRetryAttemptLimit(value: unknown, fallback = MAX_NODE_ATTEMPTS) {
  const configured = Number(value)
  const defaultLimit = Number.isSafeInteger(fallback) && fallback >= 1
    ? Math.min(MAX_NODE_ATTEMPTS, fallback) : MAX_NODE_ATTEMPTS
  return Number.isSafeInteger(configured) && configured >= 1
    ? Math.min(MAX_NODE_ATTEMPTS, configured) : defaultLimit
}

type RetryParam = { name: string; englishName?: string; value: string }
type RetryNode = {
  params: RetryParam[]
  acceptance?: { maxAttempts: number }
  errorRetry?: { maxAttempts: number }
}
const attemptParameters = new Set(['maxAttempts', 'maxGenerationAttempts', 'maxReviewAttempts', 'maxSamplingRounds', 'maxAdaptiveSamplingRounds', 'primaryTransportAttempts'])

/** Apply an explicit workflow retry-budget change to its configuration only.
 * No node ids, quality rules, execution snapshots or provider polling are involved. */
export function upgradeWorkflowRetryAttempts<N extends RetryNode, W extends { nodes: N[] }>(workflow: W): W {
  let changed = false
  const nodes = workflow.nodes.map(node => {
    // Principle review/retake defaults are explicitly migrated to a smaller
    // budget. Keep later user edits instead of silently restoring five on load.
    const preserveConfigured = node.params.some(param => (param.englishName || param.name) === 'retryBudgetProfile' && ['principle-lean-v1', 'manual-review-v1'].includes(param.value))
    const limit = (value: unknown) => preserveConfigured ? resolveRetryAttemptLimit(value, 2) : MAX_NODE_ATTEMPTS
    let nodeChanged = false
    const params = node.params.map(param => {
      if (!attemptParameters.has(param.englishName || param.name) || param.value === String(limit(param.value))) return param
      nodeChanged = true
      return { ...param, value: String(limit(param.value)) }
    })
    const acceptance = node.acceptance && node.acceptance.maxAttempts !== limit(node.acceptance.maxAttempts)
      ? { ...node.acceptance, maxAttempts: limit(node.acceptance.maxAttempts) } : node.acceptance
    const errorRetry = node.errorRetry && node.errorRetry.maxAttempts !== limit(node.errorRetry.maxAttempts)
      ? { ...node.errorRetry, maxAttempts: limit(node.errorRetry.maxAttempts) } : node.errorRetry
    if (!nodeChanged && acceptance === node.acceptance && errorRetry === node.errorRetry) return node
    changed = true
    return { ...node, params, ...(acceptance ? { acceptance } : {}), ...(errorRetry ? { errorRetry } : {}) }
  })
  return changed ? { ...workflow, nodes } : workflow
}
