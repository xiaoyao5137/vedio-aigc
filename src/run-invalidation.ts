/** Drop only state derived from an invalidated execution. Retry policies add
 * their own new feedback/counters after this reset; saved attempts and user
 * parameter overrides remain evidence and configuration. */
export function invalidateRunExecution<R extends object>(run: R) {
  return {
    ...run,
    status: 'idle' as const,
    output: undefined,
    context: {},
    inputs: {},
    inputContext: {},
    routeInputContext: undefined,
    routeInputOverrides: undefined,
    retryFeedback: undefined,
    storyboardSplitPlan: undefined,
    storyboardSplitCandidate: undefined,
    branchState: undefined,
    branchEntryTarget: undefined,
    branchCarry: undefined,
    error: undefined,
    startedAt: undefined,
    durationMs: 0,
  }
}

type RetryEvidence = {
  id?: string
  status?: string
  node?: { id?: string; operation?: string; kind?: string; mapInput?: unknown }
  loopGroupId?: string
  loopIndex?: number
  error?: unknown
  attempt?: number
  errorAttempt?: number
  retryFeedback?: unknown
  routeInputContext?: unknown
  routeInputOverrides?: unknown
  storyboardSplitPlan?: unknown
  storyboardSplitCandidate?: unknown
}

/** A future draft may survive a media retry only while its complete source
 * script remains in the immutable prefix. Rerunning that source clears every
 * reference; the reader still checks its full provenance before using a draft. */
function retainedStoryboardSplitCandidate(runs: RetryEvidence[], runIndex: number, retryIndex: number) {
  const reference = runs[runIndex]?.storyboardSplitCandidate
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return undefined
  const sourceRunId = (reference as { sourceRunId?: unknown }).sourceRunId
  if (typeof sourceRunId !== 'string' || !sourceRunId) return undefined
  const sourceIndex = runs.findIndex(run => run.id === sourceRunId)
  const source = runs[sourceIndex]
  return sourceIndex >= 0 && sourceIndex < retryIndex && source.status === 'success'
    && source.node?.operation === 'history.storyboard' && source.storyboardSplitPlan
    ? reference : undefined
}

/** A mapped text request can have completed siblings when one item exhausts
 * transport recovery. Only recognize the actual outer transport error, never a
 * reviewer report that merely quotes network failures in its explanation. */
function resumesMappedTextTransport(run: RetryEvidence) {
  if (run.status !== 'failed' || run.node?.kind !== 'text' || !run.node.mapInput
    || typeof run.node.mapInput !== 'object' || Array.isArray(run.node.mapInput) || typeof run.error !== 'string') return false
  const cause = run.error.match(/^MAP_ITEM_FAILED: [^\r\n]+?\[\d+\]（第 \d+ 项）: ([\s\S]+)$/)?.[1]
  if (!cause) return false
  const http = cause.match(/^HTTP (?:408|429|5\d\d): ([\s\S]+)$/)
  if (http) {
    try {
      const body = JSON.parse(http[1])
      return body?.error?.type === 'MODEL_TRANSPORT_EXHAUSTED' && body.error.retryExhausted === true
    } catch { return false }
  }
  return /^NODE_RESPONSE_INCOMPLETE:/.test(cause)
    || /^(?:(?:TypeError|Error): )?(?:Failed to fetch|Load failed|NetworkError|socket hang up|(?:read )?ECONNRESET)(?:$|[\s:])/.test(cause)
}

/** A manual retry replaces this node and its invalidated dependants. A failed
 * mapped text transport resumes its existing request identity so the server can
 * reuse successful items by requestKey + fingerprint and retry only missing ones.
 * Explicitly rerunning a completed node or a quality failure still starts fresh. */
export function manualRetryRuns<R extends { revision?: number }>(runs: R[], index: number, invalidated?: ReadonlySet<number>, failedCandidateBinding?: FailedTextCandidateBinding): R[] {
  const selected = runs[index] as R & RetryEvidence
  const failedCandidate = failedCandidateBinding && selected?.status === 'failed' && selected.node?.kind === 'text'
    ? readFailedTextCandidate(selected.retryFeedback, failedCandidateBinding) : undefined
  if (failedCandidate && (selected.id !== failedCandidateBinding!.runId || selected.node?.id !== failedCandidateBinding!.nodeId
    || selected.node?.operation !== failedCandidateBinding!.operation || selected.node.mapInput
    || (selected.loopGroupId ?? null) !== failedCandidateBinding!.loopGroupId || (selected.loopIndex ?? 0) !== failedCandidateBinding!.loopIndex)) {
    throw new Error('FAILED_TEXT_CANDIDATE_INVALID: manual retry target does not match the failed node and iteration')
  }
  const groups = new Map<string, number[]>()
  const scoped = runs as Parameters<typeof collectTargetedRepairRetry>[0]
  runs.forEach((_, at) => {
    if (at < index || invalidated && !invalidated.has(at)) return
    const scope = JSON.stringify([scoped[at].loopGroupId ?? null, scoped[at].loopIndex ?? null])
    groups.set(scope, [...(groups.get(scope) ?? []), at])
  })
  const repairCarry = new Map<number, ReturnType<typeof collectTargetedRepairRetry>>()
  for (const indexes of groups.values()) {
    // Each invalidated iteration retains only its own unresolved reports. In
    // particular, the first retried shot must not leak into future iterations.
    const affected = indexes.map(at => scoped[at])
    const carry = collectTargetedRepairRetry(affected, 0, affected.length - 1)
    indexes.forEach(at => repairCarry.set(at, carry))
  }
  return runs.map((run, runIndex) => {
    if (runIndex < index || (invalidated && !invalidated.has(runIndex))) return run
    const retry = run as R & RetryEvidence
    const resume = runIndex === index && resumesMappedTextTransport(retry)
    const splitCandidate = retainedStoryboardSplitCandidate(runs as Array<R & RetryEvidence>, runIndex, index)
    return {
      ...invalidateRunExecution(run),
      ...(splitCandidate ? { storyboardSplitCandidate: splitCandidate } : {}),
      attempt: resume ? retry.attempt : 1,
      errorAttempt: resume ? retry.errorAttempt : 1,
      revision: resume ? run.revision : (run.revision ?? 0) + 1,
      // These are request inputs: removing them would change the fingerprint of
      // an otherwise identical report-repair request and rebuy completed items.
      ...(resume ? { retryFeedback: retry.retryFeedback, routeInputContext: retry.routeInputContext,
        routeInputOverrides: retry.routeInputOverrides } : {}),
      ...(repairCarry.get(runIndex) ? { retryFeedback: withTargetedRepairRetry(resume ? retry.retryFeedback : undefined, repairCarry.get(runIndex)) } : {}),
      ...(runIndex === index && failedCandidate ? { retryFeedback: withFailedTextCandidate(
        withTargetedRepairRetry(undefined, repairCarry.get(runIndex)), failedCandidate) } : {}),
    }
  })
}
import { collectTargetedRepairRetry, withTargetedRepairRetry } from './targeted-repair-retry.ts'
import { readFailedTextCandidate, withFailedTextCandidate, type FailedTextCandidateBinding } from './failed-text-candidate.ts'
