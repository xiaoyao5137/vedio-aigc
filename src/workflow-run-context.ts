import { branchRunContext, type BranchState } from './workflow-branch.ts'
import { loopIterationContext } from './storyboard-runtime.ts'
import { mergeContextPatch } from './workflow-core.ts'

type Value = Record<string, unknown>
type ContextRun = {
  node: { resultVar: string }
  status: string
  output?: unknown
  context: Value
  routeInputContext?: Value
  routeInputOverrides?: Value
  branchState?: BranchState
  attempt?: number
  retryFeedback?: unknown
  loopNode?: { loop: { itemVar: string } }
  loopItem?: unknown
  loopIndex?: number
  loopPrevious?: Value
  loopGroupId?: string
}

/** A route snapshot establishes the starting context once. Then replay current
 * successful outputs in execution order. Merging the route snapshot again after
 * that replay resurrects superseded observations and previous-loop values. */
export function prepareWorkflowRunContext<R extends ContextRun>(runs: R[], index: number) {
  const run = runs[index]
  if (!run) return undefined
  const context = run.routeInputContext ?? runs.slice(0, index).filter(item => item.status === 'success').at(-1)?.context ?? {}
  const previousLoopResult = run.loopGroupId && (run.loopIndex ?? 0) > 0
    ? Object.fromEntries(runs
        .filter(item => item.loopGroupId === run.loopGroupId && item.loopIndex === (run.loopIndex ?? 0) - 1 && item.status === 'success')
        .map(item => [item.node.resultVar, item.output]))
    : run.loopPrevious
  const scoped = runs.filter(item => item.loopGroupId === run.loopGroupId)
  const stepContext = run.loopNode ? loopIterationContext(
    context, scoped.map(item => item.node.resultVar), run.loopNode.loop.itemVar,
    run.loopItem, run.loopIndex ?? 0, previousLoopResult,
    runs.slice(0, index).filter(item => item.loopGroupId === run.loopGroupId && item.loopIndex === run.loopIndex && item.status === 'success')
      .map(item => ({ resultVar: item.node.resultVar, output: item.output })),
  ) : { ...context }
  // Only execution-local retry controls belong on top of the rebuilt context.
  // Automatic routing still supplies its current feedback and source counters.
  const inputContext = branchRunContext({
    branchState: run.branchState, attempt: run.attempt, retryFeedback: run.retryFeedback,
  }, run.routeInputOverrides ? mergeContextPatch(stepContext, run.routeInputOverrides) : stepContext)
  return { run, context, previousLoopResult, inputContext }
}
