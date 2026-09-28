/**
 * Keep the inspector pinned after the user explicitly chooses a run.
 * The execution cursor may continue moving independently in the DAG.
 */
export function nextInspectorRunIndex(currentIndex: number, executionIndex: number, autoFollow: boolean) {
  return autoFollow ? executionIndex : currentIndex
}

/** Repeated node IDs identify definitions, not loop instances. Prefer the real
 * failure/pending cursor; an entirely completed record opens its last match. */
export function historicalInspectorRunIndex(runs: Array<{ node: { id: string }; status: string }>, selectedNodeId?: string) {
  const blocked = runs.findIndex(run => !['success', 'skipped'].includes(run.status))
  if (blocked >= 0) return blocked
  const matching = runs.map((run, index) => ({ run, index })).filter(({ run }) => run.node.id === selectedNodeId)
  return matching.at(-1)?.index ?? Math.max(0, runs.length - 1)
}
