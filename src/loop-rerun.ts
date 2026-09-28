import type { StepRunStatus } from './workflow-core.ts'
import { invalidateRunExecution } from './run-invalidation.ts'

export type LoopIterationScope = { loopGroupId: string; loopIndex: number }
type IterationRun = {
  id: string
  status: StepRunStatus
  loopGroupId?: string
  loopIndex?: number
  attempt?: number
  revision?: number
}
export type LoopRerunRun = IterationRun & {
  node: { id: string; title?: string; resultVar?: string }
  context: Record<string, unknown>
  attempts?: Array<Record<string, unknown>>
}
export type LoopRerunSelection = { anchorIndex: number; targetIndex: number }
export type LoopRerunPlan = LoopIterationScope & LoopRerunSelection & {
  targetRunId: string
  targetNodeId: string
  roundEndIndex: number
  preservedRunCount: number
  invalidatedIndexes: number[]
  invalidatedRunIds: string[]
  completedInvalidatedCount: number
  currentRoundInvalidatedCount: number
  laterLoopIndexes: number[]
  downstreamInvalidatedCount: number
}
export type LoopRerunProvenance = LoopIterationScope & {
  sourceExecutionId: string
  targetRunId: string
  targetNodeId: string
  createdAt: string
  invalidatedRunIds: string[]
  laterLoopIndexes: number[]
}
export type LoopRerunMetadata = LoopRerunProvenance
type LoopRerunExecution<R extends LoopRerunRun> = {
  id: string
  requestScopeId?: string
  generationScopeId?: string
  nodeRuns: R[]
  context: Record<string, unknown>
  logs: string[]
  persistenceError?: string
  loopRerunHistory?: LoopRerunProvenance[]
}

export function isLoopIterationRun(run: { loopGroupId?: string; loopIndex?: number }, scope: LoopIterationScope) {
  return run.loopGroupId === scope.loopGroupId && run.loopIndex === scope.loopIndex
}

function iterationScope(run: { loopGroupId?: string; loopIndex?: number } | undefined): LoopIterationScope | undefined {
  if (!run?.loopGroupId || !Number.isInteger(run.loopIndex) || run.loopIndex! < 0) return undefined
  return { loopGroupId: run.loopGroupId, loopIndex: run.loopIndex! }
}

/** A node ID alone is ambiguous once a loop has multiple expanded instances. */
export function loopRerunCandidates<R extends IterationRun>(runs: R[], anchorIndex: number): Array<{ index: number; run: R }> {
  const scope = Number.isInteger(anchorIndex) ? iterationScope(runs[anchorIndex]) : undefined
  if (!scope) return []
  return runs.flatMap((run, index) => isLoopIterationRun(run, scope) && (run.status === 'success' || run.status === 'failed')
    ? [{ index, run }] : [])
}

/** Conservative invalidation is intentional: arbitrary node code may read
 * loop.previous or aggregate all rounds without declaring graph edges. */
export function planLoopRerun<R extends LoopRerunRun>(runs: R[], selection: LoopRerunSelection): LoopRerunPlan {
  const { anchorIndex, targetIndex } = selection
  const scope = Number.isInteger(anchorIndex) ? iterationScope(runs[anchorIndex]) : undefined
  if (!scope) throw Error('LOOP_RERUN_SCOPE_INVALID: 请先选择一个已展开的循环轮次')
  const target = Number.isInteger(targetIndex) ? runs[targetIndex] : undefined
  if (!target || !isLoopIterationRun(target, scope)) throw Error('LOOP_RERUN_TARGET_INVALID: 重做节点必须属于所选循环的同一轮')
  if (runs.some(run => run.status === 'running')) throw Error('LOOP_RERUN_BUSY: 请等待当前节点执行结束再重做本轮')
  if (target.status !== 'success' && target.status !== 'failed') throw Error('LOOP_RERUN_TARGET_NOT_EXECUTED: 只能从本轮已经执行的节点开始重做')
  const blockedPrefix = runs.slice(0, targetIndex).find(run => run.status !== 'success' && run.status !== 'skipped')
  if (blockedPrefix) throw Error('LOOP_RERUN_PREFIX_BLOCKED: 所选节点之前仍有未完成节点，请先处理该节点或选择更早的重做位置')
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw Error('LOOP_RERUN_IDENTITY_INVALID: 执行实例标识重复，无法安全定位重做范围')
  const invalidatedIndexes = runs.flatMap((_, index) => index >= targetIndex ? [index] : [])
  const invalidated = invalidatedIndexes.map(index => runs[index])
  const currentRoundIndexes = runs.flatMap((run, index) => isLoopIterationRun(run, scope) ? [index] : [])
  return {
    ...scope, anchorIndex, targetIndex, targetRunId: target.id, targetNodeId: target.node.id,
    roundEndIndex: currentRoundIndexes.at(-1)!, preservedRunCount: targetIndex,
    invalidatedIndexes, invalidatedRunIds: invalidated.map(run => run.id),
    completedInvalidatedCount: invalidated.filter(run => run.status === 'success').length,
    currentRoundInvalidatedCount: invalidated.filter(run => isLoopIterationRun(run, scope)).length,
    laterLoopIndexes: [...new Set(invalidated.filter(run => run.loopGroupId === scope.loopGroupId && run.loopIndex! > scope.loopIndex)
      .map(run => run.loopIndex!))].sort((a, b) => a - b),
    downstreamInvalidatedCount: invalidated.filter(run => !isLoopIterationRun(run, scope)).length,
  }
}

/** Fork before persisting or submitting paid work. The original record remains
 * the authoritative old result, and flat attempts keep rejected outputs visible
 * in the new record without recursively nesting earlier attempt histories. */
export function forkLoopRerun<R extends LoopRerunRun, State extends LoopRerunExecution<R>>(
  state: State,
  options: LoopRerunSelection & { id: string; createdAt: string },
) {
  if (state.persistenceError) throw Error('LOOP_RERUN_UNSAVED: 请先保存当前执行记录，再创建本轮重做记录')
  if (!options.id.trim() || options.id === state.id) throw Error('LOOP_RERUN_FORK_ID_INVALID: 重做必须使用新的执行记录标识')
  if (!options.createdAt.trim()) throw Error('LOOP_RERUN_TIME_INVALID: 重做记录缺少创建时间')
  const plan = planLoopRerun(state.nodeRuns, options)
  const provenance: LoopRerunProvenance = {
    sourceExecutionId: state.id, targetRunId: plan.targetRunId, targetNodeId: plan.targetNodeId,
    loopGroupId: plan.loopGroupId, loopIndex: plan.loopIndex, createdAt: options.createdAt,
    invalidatedRunIds: [...plan.invalidatedRunIds], laterLoopIndexes: [...plan.laterLoopIndexes],
  }
  const nodeRuns = state.nodeRuns.map((run, index) => {
    if (index < plan.targetIndex) return run
    const snapshot: Record<string, unknown> = { ...run }
    delete snapshot.attempts
    return {
      ...invalidateRunExecution(run),
      attempt: 1, errorAttempt: 1, revision: (run.revision ?? 0) + 1,
      attempts: run.status === 'idle' ? run.attempts : [...(run.attempts ?? []), structuredClone(snapshot)],
    }
  })
  const target = state.nodeRuns[plan.targetIndex]
  const fork = {
    ...state, id: options.id,
    // Stable voice/archive identity must not be replaced by retake identity.
    requestScopeId: state.requestScopeId ?? state.id,
    // Sibling forks can have identical revision numbers. This distinct namespace
    // prevents the provider ledger from replaying another retake's paid request.
    generationScopeId: options.id,
    mode: 'step' as const, historical: false, persistenceError: undefined,
    parentExecutionId: state.id, loopRerun: provenance,
    loopRerunHistory: [...(state.loopRerunHistory ?? []), provenance],
    nodeRuns: nodeRuns as State['nodeRuns'],
    context: state.nodeRuns.slice(0, plan.targetIndex).filter(run => run.status === 'success').at(-1)?.context ?? {},
    selectedNodeId: target.node.id,
    logs: [...state.logs, `从记录 ${state.id} 创建本轮重做：第 ${plan.loopIndex + 1} 轮 / ${target.node.title ?? target.node.id}；目标前 ${plan.preservedRunCount} 个实例保留，后续 ${plan.invalidatedIndexes.length} 个实例等待重做`],
  }
  return { state: fork, plan }
}

/** Never jump over an earlier pending node, or enter a later round. The actual
 * step executor must also enforce this scope while skipping conditional nodes. */
export function nextLoopIterationRunIndex(runs: IterationRun[], scope: LoopIterationScope) {
  const index = runs.findIndex(run => run.status !== 'success' && run.status !== 'skipped')
  return index >= 0 && runs[index].status === 'idle' && isLoopIterationRun(runs[index], scope) ? index : -1
}

export async function runWorkflowLoopIteration<State extends { nodeRuns: IterationRun[] }>(
  state: State, scope: LoopIterationScope, execute: (index: number, state: State) => Promise<State | undefined>,
): Promise<State> {
  while (true) {
    const index = nextLoopIterationRunIndex(state.nodeRuns, scope)
    if (index < 0) return state
    const pending = state.nodeRuns[index]
    const updated = await execute(index, state)
    if (!updated) return state
    const after = updated.nodeRuns.find(run => run.id === pending.id)
    // A breakpoint returns an idle checkpoint; a branch rewind increments the
    // revision and therefore remains a real transition that may continue.
    if (updated === state || after?.status === 'idle' && after.revision === pending.revision && after.attempt === pending.attempt) return updated
    state = updated
  }
}
