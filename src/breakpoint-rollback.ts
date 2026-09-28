import type { StepRunStatus } from './workflow-core.ts'
import { invalidateRunExecution } from './run-invalidation.ts'
import { shouldPauseAtBreakpoint, type WorkflowBreakpoint } from './workflow-breakpoints.ts'

export type BreakpointRollbackRun = {
  id: string
  node: { id: string; title?: string; resultVar?: string }
  status: StepRunStatus
  context: Record<string, unknown>
  inputContext?: Record<string, unknown>
  attempts?: Array<Record<string, unknown>>
  revision?: number
  loopGroupId?: string
  loopIndex?: number
}

export type BreakpointRollbackPlan = {
  targetIndex: number
  targetRunId: string
  targetNodeId: string
  preservedRunCount: number
  invalidatedIndexes: number[]
  invalidatedRunIds: string[]
  completedInvalidatedCount: number
}

export type BreakpointRollbackMetadata = {
  sourceExecutionId: string
  targetRunId: string
  targetNodeId: string
  createdAt: string
  breakpoint: WorkflowBreakpoint
  preservedRunCount: number
  invalidatedRunIds: string[]
  loopGroupId?: string
  loopIndex?: number
}

type RollbackExecution<R extends BreakpointRollbackRun> = {
  id: string
  requestScopeId?: string
  generationScopeId?: string
  nodeRuns: R[]
  context: Record<string, unknown>
  logs: string[]
  persistenceError?: string
  breakpointRollbackHistory?: BreakpointRollbackMetadata[]
}

/** Conditions are evaluated against the concrete instance's saved input. A
 * current idle checkpoint is reached; later expanded idle instances are not. */
export function breakpointRollbackCandidates<R extends BreakpointRollbackRun>(
  runs: R[], breakpoints: ReadonlyArray<WorkflowBreakpoint>,
): Array<{ index: number; run: R; breakpoint: WorkflowBreakpoint }> {
  const enabled = new Map(breakpoints.filter(breakpoint => breakpoint.enabled)
    .map(breakpoint => [breakpoint.nodeId, breakpoint]))
  const candidates: Array<{ index: number; run: R; breakpoint: WorkflowBreakpoint }> = []
  let completedPrefix = true
  runs.forEach((run, index) => {
    if (!completedPrefix) return
    const breakpoint = enabled.get(run.node.id)
    const reached = run.status === 'success' || run.status === 'failed'
      || run.status === 'idle' && Boolean(run.inputContext && Object.keys(run.inputContext).length)
    if (reached && breakpoint && shouldPauseAtBreakpoint(breakpoint, run.node.id, run.inputContext ?? {})) {
      candidates.push({ index, run, breakpoint })
    }
    completedPrefix = run.status === 'success' || run.status === 'skipped'
  })
  return candidates
}

/** The step cursor points at the current run; without one, the first
 * unfinished run is the execution frontier. Never treat an idle checkpoint
 * at that frontier as the previous breakpoint. */
export function previousBreakpointRollbackCandidate<R extends BreakpointRollbackRun>(
  runs: R[], breakpoints: ReadonlyArray<WorkflowBreakpoint>, currentStepIndex?: number,
) {
  const firstUnfinished = runs.findIndex(run => run.status !== 'success' && run.status !== 'skipped')
  const beforeIndex = currentStepIndex ?? (firstUnfinished < 0 ? runs.length : firstUnfinished)
  if (!Number.isInteger(beforeIndex) || beforeIndex < 0 || beforeIndex > runs.length) return undefined
  return breakpointRollbackCandidates(runs, breakpoints).filter(candidate => candidate.index < beforeIndex).at(-1)
}

/** Invalidate the entire suffix because code nodes can read preceding rounds
 * and aggregates without declaring those dependencies in graph edges. */
export function planBreakpointRollback<R extends BreakpointRollbackRun>(
  runs: R[], breakpoints: ReadonlyArray<WorkflowBreakpoint>, targetRunId: string,
): BreakpointRollbackPlan {
  if (runs.some(run => run.status === 'running')) throw Error('BREAKPOINT_ROLLBACK_BUSY: 请等待当前节点执行结束再回退')
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw Error('BREAKPOINT_ROLLBACK_IDENTITY_INVALID: 执行实例标识重复，无法安全定位回退范围')
  const target = breakpointRollbackCandidates(runs, breakpoints).find(candidate => candidate.run.id === targetRunId)
  if (!target) throw Error('BREAKPOINT_ROLLBACK_TARGET_INVALID: 请选择一个已到达且条件命中的断点实例；目标之前的节点必须已完成')
  const invalidatedIndexes = runs.flatMap((_, index) => index >= target.index ? [index] : [])
  return {
    targetIndex: target.index, targetRunId: target.run.id, targetNodeId: target.run.node.id,
    preservedRunCount: target.index,
    invalidatedIndexes, invalidatedRunIds: invalidatedIndexes.map(index => runs[index].id),
    completedInvalidatedCount: invalidatedIndexes.filter(index => runs[index].status === 'success').length,
  }
}

/** Creates only a saved-ready fork. The caller persists it before changing the
 * active cursor; a later explicit continue action submits new provider work. */
export function forkBreakpointRollback<R extends BreakpointRollbackRun, State extends RollbackExecution<R>>(
  state: State,
  options: { id: string; createdAt: string; targetRunId: string; breakpoints: ReadonlyArray<WorkflowBreakpoint> },
) {
  if (state.persistenceError) throw Error('BREAKPOINT_ROLLBACK_UNSAVED: 请先保存当前执行记录，再创建回退记录')
  if (!options.id.trim() || options.id === state.id) throw Error('BREAKPOINT_ROLLBACK_FORK_ID_INVALID: 回退必须使用新的执行记录标识')
  if (!options.createdAt.trim()) throw Error('BREAKPOINT_ROLLBACK_TIME_INVALID: 回退记录缺少创建时间')
  const plan = planBreakpointRollback(state.nodeRuns, options.breakpoints, options.targetRunId)
  const target = state.nodeRuns[plan.targetIndex]
  const breakpoint = breakpointRollbackCandidates(state.nodeRuns, options.breakpoints)
    .find(candidate => candidate.run.id === target.id)!.breakpoint
  const metadata: BreakpointRollbackMetadata = {
    sourceExecutionId: state.id, targetRunId: target.id, targetNodeId: target.node.id,
    createdAt: options.createdAt, breakpoint: structuredClone(breakpoint),
    preservedRunCount: plan.preservedRunCount, invalidatedRunIds: [...plan.invalidatedRunIds],
    ...(target.loopGroupId !== undefined ? { loopGroupId: target.loopGroupId } : {}),
    ...(target.loopIndex !== undefined ? { loopIndex: target.loopIndex } : {}),
  }
  const nodeRuns = state.nodeRuns.map((run, index) => {
    if (index < plan.targetIndex) return run
    const snapshot: Record<string, unknown> = { ...run }
    delete snapshot.attempts
    return {
      ...invalidateRunExecution(run), loopPrevious: undefined,
      attempt: 1, errorAttempt: 1, revision: (run.revision ?? 0) + 1,
      attempts: run.status === 'idle' ? run.attempts : [...(run.attempts ?? []), structuredClone(snapshot)],
    }
  })
  const fork = {
    ...state, id: options.id,
    requestScopeId: state.requestScopeId ?? state.id,
    generationScopeId: options.id,
    parentExecutionId: state.id, mode: 'step' as const, historical: false, persistenceError: undefined,
    breakpointRollback: metadata,
    breakpointRollbackHistory: [...(state.breakpointRollbackHistory ?? []), metadata],
    nodeRuns: nodeRuns as State['nodeRuns'],
    context: state.nodeRuns.slice(0, plan.targetIndex).filter(run => run.status === 'success').at(-1)?.context ?? {},
    selectedNodeId: target.node.id,
    logs: [...state.logs, `从记录 ${state.id} 回退到断点：${target.node.title ?? target.node.id}${target.loopIndex === undefined ? '' : ` · 第 ${target.loopIndex + 1} 轮`}；保留之前 ${plan.preservedRunCount} 个实例，后续 ${plan.invalidatedIndexes.length} 个实例等待重新执行`],
  }
  return { state: fork, plan }
}
