type SceneRun = {
  id: string
  node: { id: string }
  loopGroupId?: string
  loopIndex?: number
}

/** A scene contains the whole plan, including untouched predecessors and idle
 * successors. Only runs archived by the rewind participated in that round. */
export function branchSceneIncludesRun(entry: Record<string, unknown>, run: SceneRun | undefined): boolean {
  if (!run || !entry.backwards || !Array.isArray(entry.scene) || !Array.isArray(entry.runs)) return false
  const archivedIds = new Set(entry.runs.map((item: { id?: string }) => item.id))
  return entry.scene.some((item: SceneRun) => archivedIds.has(item.id)
    && item.node.id === run.node.id
    && item.loopGroupId === run.loopGroupId
    && item.loopIndex === run.loopIndex)
}

export function branchSceneIndicesForRun(scenes: Array<Record<string, unknown>>, run: SceneRun | undefined): number[] {
  return scenes.flatMap((scene, index) => branchSceneIncludesRun(scene, run) ? [index] : [])
}
