import { scopedLoopNodes, type GraphNode, type GraphWorkflow, type StepRunStatus } from './workflow-core.ts'

/** A manual-review gate can retain a source-bound media contradiction or a
 * reviewer warning grounded in two adjacent current scene observations. The
 * marker survives persistence; only a newly completed gate pauses. Explicit
 * resume starts with its saved successor, preserving completed work. */
type DecisionRun = { id?: string; node?: { id?: string }; status?: StepRunStatus; output?: unknown }
export function requiresManualMediaDecision(run: DecisionRun | undefined) {
  if (!['sanguo-media-accept', 'sanguo-character-accept', 'sanguo-scene-outline-accept'].includes(String(run?.node?.id))
    || run?.status !== 'success') return false
  const output = run.output && typeof run.output === 'object' && !Array.isArray(run.output) ? run.output as Record<string, unknown> : {}
  const review = output.qualityReview && typeof output.qualityReview === 'object' && !Array.isArray(output.qualityReview)
    ? output.qualityReview as Record<string, unknown> : {}
  return output.qualityDisposition === 'manual-review-v1' && output.manualDecisionRequired === true && review.manualDecisionRequired === true
}

/** Only a gate completed in this step pauses. A restored checkpoint with the
 * same marker moves forward after the user explicitly chooses Continue. */
export function newlyRequiredManualMediaDecision<Run extends DecisionRun>(before: Run[], after: Run[]) {
  const existing = new Set(before.filter(requiresManualMediaDecision).map(run => run.id).filter((id): id is string => Boolean(id)))
  return after.find((run, index) => requiresManualMediaDecision(run) && (run.id
    ? !existing.has(run.id) : !requiresManualMediaDecision(before[index])))
}

/** A historical video-only retake changes its tail and subsequent same-scene
 * takes. Completed cuts with unchanged scripts do not depend on those pixels. */
export function historicalVideoRetryIndexes(runs: Array<{ node: { kind: string }; loopGroupId?: string; loopIndex?: number; loopItem?: unknown; loopIsLast?: boolean }>, index: number) {
  const selected = runs[index]
  if (selected?.node.kind !== 'video' || !selected.loopGroupId || selected.loopIndex === undefined) return new Set(runs.map((_, i) => i).filter(i => i >= index))
  const firstCut = runs.find(run => run.loopGroupId === selected.loopGroupId && (run.loopIndex ?? -1) > selected.loopIndex!
    && (run.loopItem as { continuityFromPrevious?: boolean })?.continuityFromPrevious === false)?.loopIndex
  return new Set(runs.flatMap((run, i) => i >= index && (run.loopGroupId !== selected.loopGroupId || firstCut === undefined
    || (run.loopIndex ?? -1) < firstCut || run.loopIsLast) ? [i] : []))
}

/** Disconnected loop children remain placeholders after their owner, never tasks
 * before it. The shared step executor expands them only when the loop starts. */
export function orderLoopPlaceholders<Node extends GraphNode>(workflow: GraphWorkflow<Node>, ordered: Node[]) {
  const loops = ordered.filter(node => node.kind === 'loop')
  const children = new Map(loops.map(loop => [loop.id, scopedLoopNodes(workflow, loop.id, ordered)]))
  const owned = new Set([...children.values()].flat().map(node => node.id))
  const result: Node[] = []
  const seen = new Set<string>()
  const append = (node: Node) => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    result.push(node)
    children.get(node.id)?.forEach(append)
  }
  ordered.filter(node => !owned.has(node.id)).forEach(append)
  return result
}

/** Full execution invokes exactly the same checkpointed step executor as debug.
 * Re-read its expanded queue after every step, including newly split scenes. */
export async function runWorkflowToCompletion<State extends { nodeRuns: Array<{ id?: string; status: StepRunStatus; node?: { id?: string }; output?: unknown }> }>(
  state: State, execute: (index: number, state: State) => Promise<State | undefined>,
) {
  while (!state.nodeRuns.some(run => run.status === 'failed' || run.status === 'running')) {
    const index = state.nodeRuns.findIndex(run => run.status === 'idle')
    if (index < 0) return state
    const updated = await execute(index, state)
    if (!updated) return state
    if (updated === state) throw new Error('执行器未推进，已停止以避免重复提交节点')
    const needsDecision = newlyRequiredManualMediaDecision(state.nodeRuns, updated.nodeRuns)
    state = updated
    if (needsDecision) return state
  }
  return state
}
