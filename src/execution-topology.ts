import { scopedLoopNodes, type GraphNode } from './workflow-core.ts'
import { executionRouteEdges, orderRouteNodes, type RouteWorkflow } from './workflow-branch.ts'
import { invalidateRunExecution } from './run-invalidation.ts'

type RecoveryNode = GraphNode & { title?: string; resultVar?: string }
type RecoveryRun<N extends RecoveryNode> = {
  id: string; node: N; status: string; durationMs: number; context: Record<string, unknown>
  output?: unknown; revision?: number; attempts?: Array<Record<string, unknown>>
  loopNode?: N; loopGroupId?: string; loopIndex?: number; loopItem?: unknown
  loopPrevious?: Record<string, unknown>; loopIsLast?: boolean
  branchState?: unknown; branchCarry?: unknown
}

/** Recover additive topology changes in a new record. Existing nodes must keep
 * their scope and relative order; incompatible edits and active calls are left
 * untouched for the caller's topology guard. No newly inserted work is adopted
 * as success, and downstream verdicts cannot bypass the added dependency. */
export function insertMissingExecutionNodes<N extends RecoveryNode, R extends RecoveryRun<N>>(workflow: RouteWorkflow<N>, runs: R[]): R[] {
  if (!runs.length || runs.some(run => run.status === 'running')) return runs
  const mapMediaGateIds = ['sanguo-map-first-evidence', 'sanguo-map-first-review', 'sanguo-map-first-accept',
    'sanguo-map-end-evidence', 'sanguo-map-end-review', 'sanguo-map-end-accept']
  const mapGateIds = new Set(['sanguo-map-annotation-review', 'sanguo-map-annotation-approval', ...mapMediaGateIds])
  const mapGateUpgrade = (workflow as RouteWorkflow<N> & { id?: string }).id === 'wf-sanguo-history-drama'
    // Annotation gates are optional in newer map topologies. Requiring them
    // disabled the paid-iteration protection for the six active media gates.
    && mapMediaGateIds.every(id => workflow.nodes.some(node => node.id === id))
    && runs.some(run => !mapGateIds.has(run.node.id))
  const byId = new Map(workflow.nodes.map(node => [node.id, node]))
  const managedAcceptIds = new Set(['sanguo-map-first-accept', 'sanguo-map-end-accept'])
  const managedAcceptKindUpgrade = (run: R) => {
    const current = byId.get(run.node.id) as (N & { request?: { url?: string } }) | undefined
    const oldCode = (run.node as N & { code?: string }).code
    return mapGateUpgrade && managedAcceptIds.has(run.node.id) && run.node.kind === 'code'
      && typeof oldCode === 'string' && oldCode.includes('HISTORICAL_MAP_FRAME_REJECTED')
      && current?.kind === 'http' && current.request?.url === '/api/historical-map-frame-approval'
  }
  if (byId.size !== workflow.nodes.length || runs.some(run => !byId.has(run.node.id)
    || byId.get(run.node.id)!.kind !== run.node.kind && !managedAcceptKindUpgrade(run))) return runs
  const ordered = orderRouteNodes(workflow)
  if (ordered.hasCycle) return runs
  const graph = { ...workflow, edges: executionRouteEdges(workflow) }
  const children = new Map(workflow.nodes.filter(node => node.kind === 'loop').map(loop => [loop.id, scopedLoopNodes(graph, loop.id, ordered.ordered)]))
  const owner = new Map<string, string>()
  for (const [loopId, nodes] of children) for (const node of nodes) {
    if (node.id === loopId || node.kind === 'loop' || owner.has(node.id)) return runs
    owner.set(node.id, loopId)
  }
  const oldOwner = new Map<string, string>()
  for (const run of runs) {
    for (const loop of [run.node.kind === 'loop' ? run.node : undefined, run.loopNode]) {
      for (const id of loop?.childIds ?? []) oldOwner.set(id, loop!.id)
    }
    if (run.node.parentId) oldOwner.set(run.node.id, run.node.parentId)
  }
  if (runs.some(run => (run.loopNode?.id ?? oldOwner.get(run.node.id)) !== owner.get(run.node.id))) return runs

  type Scope = { nodes: N[]; entries: Array<{ run: R; index: number }>; loop?: N; fallbackIndex: number }
  const scopes = new Map<string, Scope>([['root', { nodes: ordered.ordered.filter(node => !owner.has(node.id)), entries: [], fallbackIndex: runs.length }]])
  for (const [index, run] of runs.entries()) {
    const loopId = owner.get(run.node.id)
    const key = loopId ? JSON.stringify([loopId, run.loopGroupId ?? null, run.loopIndex ?? null]) : 'root'
    if (!scopes.has(key)) scopes.set(key, { nodes: children.get(loopId!)!, entries: [], loop: byId.get(loopId!), fallbackIndex: index })
    scopes.get(key)!.entries.push({ run, index })
  }
  // An unstarted previously-empty loop needs placeholders. An expanded empty
  // loop has zero iterations and must not execute a new child once at root scope.
  for (const [loopId, nodes] of children) if (nodes.length && ![...scopes.values()].some(scope => scope.loop?.id === loopId)) {
    const index = runs.findIndex(run => run.node.id === loopId)
    if (index >= 0 && runs[index].status === 'idle') scopes.set(JSON.stringify([loopId, null, null]), { nodes, entries: [], loop: byId.get(loopId), fallbackIndex: index + 1 })
  }

  const insertions = new Map<number, R[]>()
  const missingIds = new Set<string>()
  const managedAcceptUpdates = new Set<string>()
  const usedRunIds = new Set(runs.map(run => run.id))
  for (const [scopeKey, scope] of scopes) {
    // A completed old iteration is a paid, immutable snapshot. Adding a new
    // prepayment review must not turn its already successful video back to idle.
    const completedVideo = mapGateUpgrade && scope.entries.some(entry => entry.run.node.id === 'sanguo-video' && entry.run.status === 'success')
    if (!completedVideo) for (const { run } of scope.entries) {
      if (managedAcceptKindUpgrade(run)) managedAcceptUpdates.add(run.id)
    }
    const positions = scope.entries.map(entry => scope.nodes.findIndex(node => node.id === entry.run.node.id))
    if (positions.some((position, i) => position < 0 || (i > 0 && position <= positions[i - 1]))) return runs
    const present = new Set(scope.entries.map(entry => entry.run.node.id))
    for (const [position, node] of scope.nodes.entries()) if (!present.has(node.id)) {
      if (completedVideo && mapGateIds.has(node.id)) continue
      // Creating a new loop would require deriving iterations, outside additive recovery.
      if (node.kind === 'loop') return runs
      const next = scope.entries.find((_, i) => positions[i] > position)
      const insertionIndex = next?.index ?? (scopeKey === 'root' ? runs.length : scope.entries.at(-1)?.index !== undefined ? scope.entries.at(-1)!.index + 1 : scope.fallbackIndex)
      const source = scope.entries[0]?.run
      let id = `recovery:${scopeKey}:${node.id}`
      while (usedRunIds.has(id)) id += ':new'
      usedRunIds.add(id)
      const run = {
        id, node, status: 'idle', durationMs: 0, output: undefined, context: {}, inputs: {}, inputContext: {}, attempt: 1, revision: 0,
        label: `${source?.loopIndex === undefined ? '' : `第 ${source.loopIndex + 1} 轮 / `}${node.title ?? node.id} -> ${node.resultVar ?? ''}`,
        ...(scope.loop && source?.loopGroupId ? { loopNode: scope.loop, loopGroupId: source.loopGroupId, loopIndex: source.loopIndex, loopItem: source.loopItem, loopPrevious: source.loopPrevious, loopIsLast: false } : {}),
      } as unknown as R
      insertions.set(insertionIndex, [...(insertions.get(insertionIndex) ?? []), run])
      missingIds.add(node.id)
    }
  }
  const loopChanged = runs.some(run => run.node.kind === 'loop' && JSON.stringify(run.node.childIds) !== JSON.stringify(byId.get(run.node.id)?.childIds))
  const onlyMapGateAdditions = mapGateUpgrade && [...missingIds].every(id => mapGateIds.has(id))
  const onlyMapGateLoopChange = loopChanged && runs.filter(run => run.node.kind === 'loop').every(run => {
    const oldChildren = run.node.childIds ?? []
    const newChildren = byId.get(run.node.id)?.childIds ?? []
    return JSON.stringify(oldChildren) === JSON.stringify(newChildren.filter(id => !mapGateIds.has(id)))
  })
  if (!insertions.size && onlyMapGateLoopChange && !managedAcceptUpdates.size) return runs
  if (!insertions.size && !loopChanged && !managedAcceptUpdates.size) return runs
  const firstInsertion = Math.min(...insertions.keys())
  const refreshLoop = (node: N) => ({ ...node, childIds: byId.get(node.id)?.childIds })
  const recovered: R[] = []
  for (let index = 0; index <= runs.length; index++) {
    recovered.push(...(insertions.get(index) ?? []))
    if (index === runs.length) break
    const original = runs[index]
    let run = original
    const completedPaidIteration = onlyMapGateAdditions && original.loopGroupId
      && runs.some(run => run.loopGroupId === original.loopGroupId && run.node.id === 'sanguo-video' && run.status === 'success')
    const preservePaidImage = onlyMapGateAdditions && original.status === 'success' && original.node.kind === 'image'
    const replaceManagedAccept = managedAcceptUpdates.has(original.id)
    if (replaceManagedAccept && original.status === 'skipped') {
      run = { ...original, node: byId.get(original.node.id)! } as R
    } else if ((index >= firstInsertion || replaceManagedAccept) && !completedPaidIteration && !preservePaidImage) {
      const archive = original.status !== 'idle' || original.output !== undefined
        ? [{ ...original, attempts: undefined, topologyInvalidatedBy: [...missingIds] }] : []
      run = { ...invalidateRunExecution(original), node: byId.get(original.node.id)!, revision: (original.revision ?? 0) + 1,
        attempts: [...(original.attempts ?? []), ...archive], branchState: original.branchState, branchCarry: original.branchCarry } as R
    }
    if (run.node.kind === 'loop' && !(onlyMapGateAdditions && run.status === 'success')) run = { ...run, node: refreshLoop(run.node) }
    if (run.loopNode && !completedPaidIteration) run = { ...run, loopNode: refreshLoop(run.loopNode) }
    recovered.push(run)
  }
  for (const scope of scopes.values()) {
    const previousLast = scope.entries.find(entry => entry.run.loopIsLast)?.run
    if (!previousLast) continue
    const lastNodeId = scope.nodes.at(-1)?.id
    for (let i = 0; i < recovered.length; i++) {
      const run = recovered[i]
      if (run.loopGroupId === previousLast.loopGroupId && run.loopIndex === previousLast.loopIndex) {
        const loopIsLast = run.node.id === lastNodeId
        if (run.loopIsLast !== loopIsLast) recovered[i] = { ...run, loopIsLast }
      }
    }
  }
  // Additive recovery may invalidate downstream verdicts, but it must never
  // silently turn a completed provider asset into a new paid request. If an
  // unfamiliar topology needs that, leave the old checkpoint intact so the
  // caller's topology guard can stop execution instead of charging again.
  const recoveredById = new Map(recovered.map(run => [run.id, run]))
  if (runs.some(run => run.status === 'success' && (['image', 'video', 'audio'].includes(run.node.kind) || Boolean((run.node as { modelId?: string }).modelId))
    && (recoveredById.get(run.id)?.status !== 'success' || recoveredById.get(run.id)?.output !== run.output))) return runs
  return recovered
}
