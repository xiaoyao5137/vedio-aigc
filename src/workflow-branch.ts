import { applyNodeOutputToContext, scopedLoopNodes, type GraphNode } from './workflow-core.ts'
import { reportFormatRetryError, reportFormatRetryFeedback, reviewRetryDiagnostics } from './review-retry.ts'
import { invalidateRunExecution } from './run-invalidation.ts'
import { collectTargetedRepairRetry, withTargetedRepairRetry } from './targeted-repair-retry.ts'

export type BranchPort = 'true' | 'false'
export type RouteEdge = { id: string; from: string; to: string; branch?: BranchPort }
export type RouteWorkflow<N extends GraphNode = GraphNode> = { nodes: N[]; edges: RouteEdge[] }
export type BranchState = { visits: number; counts: Record<BranchPort, number> }
export const emptyBranchState = (): BranchState => ({ visits: 0, counts: { true: 0, false: 0 } })
export const DEFAULT_BRANCH_CODE = `// 可读取 context 中前面节点的输出，以及 params 中的可编辑参数。
// branch.counts.false 是本轮此前已走 false 出口的次数。
const report = params.report;
if (typeof report?.passed !== 'boolean') throw Error('缺少布尔质检结果');
if (report.passed) return true;
const limit = Number(params.maxAttempts);
if (!Number.isInteger(limit) || limit < 1) throw Error('maxAttempts 必须是正整数');
if (branch.counts.false + 1 >= limit) {
  throw Error('已达到尝试次数；可在单步调试中修改 maxAttempts 后重试本分支');
}
return { value: false, feedback: report.issues };`

/** Branch edges are user-owned control flow. Acyclic ones help order forward
 * arms; edges closing a cycle are jumps, not dependency cycles. */
export function executionRouteEdges(workflow: RouteWorkflow): RouteEdge[] {
  let edges = [...workflow.edges]
  // Remove only an explicit branch edge from each cycle. Ordinary cycles stay
  // invalid. This also handles nodes created after their forward destinations.
  for (let pass = 0; pass <= workflow.edges.length; pass++) {
    const visited = new Set<string>(), stack: string[] = [], path: RouteEdge[] = []
    let jump: RouteEdge | undefined
    const visit = (id: string) => {
      if (visited.has(id) || jump) return
      stack.push(id)
      for (const edge of edges.filter(e => e.from === id)) {
        const at = stack.indexOf(edge.to)
        if (at >= 0) {
          jump = [...path.slice(at), edge].filter(e => e.branch !== undefined).at(-1)
          if (jump) break
        } else if (!visited.has(edge.to)) { path.push(edge); visit(edge.to); path.pop(); if (jump) break }
      }
      stack.pop(); visited.add(id)
    }
    workflow.nodes.forEach(n => visit(n.id))
    if (!jump) break
    edges = edges.filter(e => e !== jump)
  }
  return edges
}

export function branchConfigurationErrors(workflow: RouteWorkflow): string[] {
  const errors: string[] = []
  for (const edge of workflow.edges) {
    const source = workflow.nodes.find(n => n.id === edge.from)
    if (!source || !workflow.nodes.some(n => n.id === edge.to)) { errors.push(`连线 ${edge.id} 的节点不存在`); continue }
    if (edge.branch !== undefined && (source.kind !== 'branch' || !['true', 'false'].includes(edge.branch))) errors.push(`连线 ${edge.id} 的分支出口无效`)
    if (source.kind === 'branch' && edge.branch === undefined) errors.push(`分支 ${source.id} 必须使用 true / false 出口`)
  }
  for (const node of workflow.nodes.filter(n => n.kind === 'branch')) {
    for (const port of ['true', 'false'] as const) {
      if (workflow.edges.filter(e => e.from === node.id && e.branch === port).length !== 1) errors.push(`分支 ${node.id} 的 ${port} 出口必须连接一个目标`)
    }
  }
  if (orderRouteNodes(workflow).hasCycle) errors.push('普通依赖线存在循环；回路必须从分支 true / false 出口连接')
  return errors
}

export function setBranchEdge<E extends RouteEdge>(edges: E[], from: string, port: BranchPort, to: string, id: string): E[] {
  const remaining = edges.filter(e => e.from !== from || e.branch !== port)
  return to ? [...remaining, { id, from, to, branch: port } as E] : remaining
}

export function branchDecision(output: unknown): boolean {
  const value = output && typeof output === 'object' ? (output as { value?: unknown }).value : output
  if (typeof value !== 'boolean') throw new Error('BRANCH_RESULT_INVALID: 分支代码必须返回 true / false，或 { value: true / false }')
  return value
}

export type BranchRun = {
  id: string; node: GraphNode & { resultVar: string; params?: Array<{ id?: string; name?: string; englishName?: string; type?: string; value?: string }> }; status: string; context: Record<string, unknown>; output?: unknown
  inputContext?: Record<string, unknown>; routeInputContext?: Record<string, unknown>; routeInputOverrides?: Record<string, unknown>; inputs?: Record<string, unknown>
  loopGroupId?: string; loopIndex?: number; loopNode?: GraphNode; loopItem?: unknown; loopIsLast?: boolean
  durationMs: number; startedAt?: number; error?: string; attempt?: number; revision?: number; retryFeedback?: unknown
  branchEntryTarget?: string
  branchCarry?: Record<string, { loopIndex?: number; state: BranchState; paramOverrides?: Record<string, string> }>
  branchState?: BranchState; attempts?: Array<Record<string, unknown>>; paramOverrides?: Record<string, string>
}
// Keep a flat complete scene: nested attempts would duplicate earlier rounds exponentially.
function updatedScene<R extends BranchRun>(runs: R[], index: number, success: R) {
  return runs.map((run, i) => {
    const copy = { ...(i === index ? success : run) }
    delete copy.attempts
    return copy
  })
}
const snapshot = (r: BranchRun) => ({ id: r.id, nodeId: r.node.id, status: r.status, output: r.output, inputs: r.inputs, durationMs: r.durationMs, attempt: r.attempt, loopIndex: r.loopIndex, branchState: r.branchState })

/** Review groups are editable branch configuration, never model-selected jump
 * destinations. The existing edge still determines the rewind boundary. */
function reviewRetryTargets(workflow: RouteWorkflow, source: BranchRun): string[] | undefined {
  const parameters = (source.node.params ?? []).filter(param => (param.englishName || param.name) === 'reviewRetryTargets')
  if (!parameters.length) return undefined
  const invalid = (reason: string): never => { throw Error('REVIEW_RETRY_CONFIG_INVALID: reviewRetryTargets ' + reason) }
  if (parameters.length !== 1 || parameters[0].type !== 'json') invalid('必须是唯一的 JSON 参数')
  const parameter = parameters[0]
  let value: unknown
  if (source.inputs && Object.hasOwn(source.inputs, 'reviewRetryTargets')) value = source.inputs.reviewRetryTargets
  else {
    const configured = parameter.id && source.paramOverrides?.[parameter.id] !== undefined ? source.paramOverrides[parameter.id] : parameter.value
    try { value = JSON.parse(configured ?? '') } catch { invalid('不是合法 JSON') }
  }
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim())
    || new Set(value).size !== value.length) invalid('必须是非空且不重复的节点 ID 数组')
  const resultVars = new Set<string>()
  for (const id of value as string[]) {
    const matches = workflow.nodes.filter(node => node.id === id) as BranchRun['node'][]
    if (matches.length !== 1 || matches[0].kind !== 'text' || !matches[0].resultVar?.trim()) invalid('节点 ' + id + ' 必须唯一存在且为有结果变量的 text 审核节点')
    if (resultVars.has(matches[0].resultVar)) invalid('审核节点的结果变量不能重复：' + matches[0].resultVar)
    resultVars.add(matches[0].resultVar)
  }
  return value as string[]
}

function reviewGroupRetryFeedback(workflow: RouteWorkflow, runs: BranchRun[], sourceIndex: number, targetIndex: number, inputContext: Record<string, unknown>, rawFeedback: unknown) {
  const source = runs[sourceIndex], group = reviewRetryTargets(workflow, source)
  if (targetIndex > sourceIndex || !reportFormatRetryError(rawFeedback)) return undefined
  const diagnostics = reviewRetryDiagnostics(rawFeedback)
  // Old single-reviewer routes retain their existing context behavior.
  if (!group && !diagnostics) return undefined
  const ids = group ?? [runs[targetIndex].node.id]
  const recipients = ids.map(id => {
    const matches = runs.flatMap((run, index) => run.node.id === id && index >= targetIndex && index <= sourceIndex
      && run.loopGroupId === source.loopGroupId && run.loopIndex === source.loopIndex ? [index] : [])
    if (matches.length !== 1 || runs[matches[0]].node.kind !== 'text') throw Error('REVIEW_RETRY_CONFIG_INVALID: 审核节点 ' + id + ' 必须唯一位于当前循环的回跳区间内')
    return matches[0]
  })
  if (diagnostics?.some(diagnostic => recipients.filter(index => runs[index].node.resultVar === diagnostic.reportResultVar).length !== 1)) {
    throw Error('REVIEW_RETRY_CONFIG_INVALID: diagnostics 的 reportResultVar 必须唯一归属于本次配置的审核组')
  }
  return new Map(recipients.flatMap(index => {
    const run = runs[index], context = { ...inputContext }
    // Only this execution instance can supply its previous report. Context may
    // still contain another iteration's value under the same result variable.
    if (group) {
      if (run.output === undefined) delete context[run.node.resultVar]
      else context[run.node.resultVar] = run.output
    }
    const feedback = reportFormatRetryFeedback(run.node, context, rawFeedback, { unassigned: !diagnostics })
    return feedback === undefined ? [] : [[index, feedback] as const]
  }))
}

/** One shared transition for full execution and single-step debugging. It only
 * reads the boolean and actual edge: budgets and quality semantics live in code. */
export function routeBranch<R extends BranchRun>(workflow: RouteWorkflow, runs: R[], index: number, output: unknown, inputContext: Record<string, unknown>) {
  const source = runs[index]
  const value = branchDecision(output), port: BranchPort = value ? 'true' : 'false'
  const links = workflow.edges.filter(e => e.from === source.node.id && e.branch === port)
  if (links.length !== 1) throw new Error(`BRANCH_ROUTE_INVALID: ${port} 出口必须连接一个目标`)
  const targetId = links[0].to
  const candidates = runs.flatMap((r, i) => r.node.id === targetId ? [i] : [])
  // Prefer the current loop iteration; otherwise the nearest executed instance,
  // then the first future instance. No same-scope/ancestor-only restriction.
  let targetIndex = candidates.find(i => runs[i].loopGroupId === source.loopGroupId && runs[i].loopIndex === source.loopIndex)
    ?? candidates.filter(i => i <= index).at(-1) ?? candidates[0]
  const targetRun = targetIndex === undefined ? undefined : runs[targetIndex]
  const targetNode = workflow.nodes.find(n => n.id === targetId)
  const owner = workflow.nodes.find(n => n.kind === 'loop' && (n.childIds?.includes(targetId) || targetNode?.parentId === n.id))
  const ownerIndex = owner ? runs.findIndex(r => r.node.id === owner.id) : -1
  const ownerEnabled = owner && (owner as GraphNode & {loop?:{enabled?:boolean}}).loop?.enabled
  const enterLoop = !targetRun?.loopGroupId && ownerEnabled && ownerIndex >= 0 && (!targetRun || runs[ownerIndex].status !== 'success')
  if (enterLoop) targetIndex = ownerIndex
  if (targetIndex === undefined) throw new Error(`BRANCH_ROUTE_INVALID: 目标 ${targetId} 未出现在执行计划`)

  const targetRunId = runs[targetIndex].id
  const oldState = source.branchState ?? emptyBranchState()
  const branchState = { visits: oldState.visits + 1, counts: { ...oldState.counts, [port]: oldState.counts[port] + 1 } }
  const nextContext = applyNodeOutputToContext(inputContext, source.node.resultVar, output)
  const success = { ...source, status: 'success', output, context: nextContext, branchState } as R
  const backwards = targetIndex <= index
  const rawFeedback = output && typeof output === 'object' ? (output as { feedback?: unknown }).feedback : undefined
  const groupFeedback = reviewGroupRetryFeedback(workflow, runs, index, targetIndex, inputContext, rawFeedback)
  const feedback = backwards ? groupFeedback ? groupFeedback.get(targetIndex) : reportFormatRetryFeedback(runs[targetIndex].node, inputContext, rawFeedback) : rawFeedback
  const history = { from: source.node.id, to: targetId, value, branchState, backwards, scene: backwards ? structuredClone(updatedScene(runs, index, success)) : undefined, runs: [] as Array<Record<string, unknown>> }
  let updated = runs.map((r, i) => i === index ? success : r)
  if (backwards) {
    const repairCarry = collectTargetedRepairRetry(runs, targetIndex, index)
    const restored = { ...(runs[targetIndex].inputContext ?? {}) }
    // Explicit contextPatch is carried across a rewind; stale outputs are not.
    const routedContext = applyNodeOutputToContext(restored, source.node.resultVar, output)
    history.runs = updated.slice(targetIndex).filter(r => r.status !== 'idle').map(snapshot)
    updated = updated.map((r, i) => i < targetIndex! ? r : ({
      ...invalidateRunExecution(r), attempts: r.status === 'idle' ? r.attempts : [...(r.attempts ?? []), snapshot(r)],
      revision: (r.revision ?? 0) + 1, attempt: (r.attempt ?? 1) + 1,
      branchState: i === index ? branchState : undefined,
      ...(i <= index && r.loopGroupId === source.loopGroupId && r.loopIndex === source.loopIndex && repairCarry
        ? { retryFeedback: withTargetedRepairRetry(undefined, repairCarry) } : {}),
    } as R))
    updated[targetIndex] = { ...updated[targetIndex], routeInputContext: routedContext, retryFeedback: withTargetedRepairRetry(groupFeedback ? groupFeedback.get(targetIndex) : feedback, repairCarry) }
    if (groupFeedback) updated = updated.map((run, i) => groupFeedback.has(i) ? { ...run, retryFeedback: withTargetedRepairRetry(groupFeedback.get(i), repairCarry) } : run)
  } else {
    // A manually re-evaluated branch may have completed successors. Its new
    // decision invalidates those results before selecting an arm.
    history.runs = updated.slice(index + 1).filter(r => r.status !== 'idle').map(snapshot)
    updated = updated.map((r, i) => i <= index || r.status === 'idle' ? r : ({
      ...invalidateRunExecution(r), attempts: [...(r.attempts ?? []), snapshot(r)],
      revision: (r.revision ?? 0) + 1, attempt: (r.attempt ?? 1) + 1,
    } as R))
    // Skip the unchosen arm, retaining a shared merge and its descendants.
    const forwardEdges = executionRouteEdges(workflow)
    const reachable = (start: string) => {
      const ids = new Set<string>(), pending = [start]
      while (pending.length) { const id = pending.pop()!; if (id === source.node.id || ids.has(id)) continue; ids.add(id); forwardEdges.filter(e => e.from === id).forEach(e => pending.push(e.to)) }
      return ids
    }
    const selected = reachable(targetId)
    const other = workflow.edges.find(e => e.from === source.node.id && e.branch !== undefined && e.branch !== port)
    const excluded = other ? reachable(other.to) : new Set<string>()
    updated = updated.map((r, i) => i > index && (i < targetIndex! || (excluded.has(r.node.id) && !selected.has(r.node.id) && r.loopGroupId === source.loopGroupId && r.loopIndex === source.loopIndex))
      ? { ...r, status: 'skipped', output: { skipped: true, branch: source.node.id, value }, context: nextContext, routeInputContext: undefined } as R : r)
    updated[targetIndex] = { ...updated[targetIndex], routeInputContext: nextContext }
  }
  // If a jump re-enters a loop owner, its old expanded children are removed now;
  // the owner expands fresh items later. Evidence is retained in the route log.
  if (backwards) {
    const resetLoopIds = new Set(updated.slice(targetIndex).filter(r => r.node.kind === 'loop').map(r => r.node.id))
    if (source.loopNode && resetLoopIds.has(source.loopNode.id)) {
      updated = updated.map(r => r.node.id === source.loopNode!.id ? { ...r, branchCarry: { ...r.branchCarry, [source.node.id]: { loopIndex: source.loopIndex, state: branchState, paramOverrides: source.paramOverrides } } } : r)
    }

    updated = updated.filter(r => !r.loopNode || !resetLoopIds.has(r.loopNode.id))
    targetIndex = updated.findIndex(r => r.id === targetRunId)
  }
  if (enterLoop) updated[targetIndex] = { ...updated[targetIndex], branchEntryTarget: targetId }
  return { runs: updated, index: targetIndex, context: updated[targetIndex].routeInputContext ?? nextContext, history }
}

/** A failed branch is re-evaluated against the same evidence and edited params.
 * This must not reset counters or rerun its generator before the decision. */
export function retryBranchRun<R extends BranchRun>(runs: R[], index: number): R[] {
  return runs.map((run, i) => i !== index ? run : {
    ...run, status: 'idle', routeInputContext: run.routeInputContext ?? run.inputContext ?? {},
    attempts: [...(run.attempts ?? []), snapshot(run)], output: undefined, error: undefined,
    startedAt: undefined, durationMs: 0, revision: (run.revision ?? 0) + 1,
  }) as R[]
}

export function orderRouteNodes<N extends GraphNode>(workflow: RouteWorkflow<N>) {
  const edges = executionRouteEdges(workflow)
  const indegree = new Map(workflow.nodes.map(n => [n.id, 0]))
  edges.forEach(e => { if (indegree.has(e.from) && indegree.has(e.to)) indegree.set(e.to, indegree.get(e.to)! + 1) })
  const queue = workflow.nodes.filter(n => indegree.get(n.id) === 0), ordered: N[] = []
  while (queue.length) {
    const node = queue.shift()!
    ordered.push(node)
    edges.filter(e => e.from === node.id).forEach(e => {
      indegree.set(e.to, (indegree.get(e.to) ?? 1) - 1)
      if (indegree.get(e.to) === 0) { const next = workflow.nodes.find(n => n.id === e.to); if (next) queue.push(next) }
    })
  }
  return { ordered: ordered.length === workflow.nodes.length ? ordered : workflow.nodes, hasCycle: ordered.length !== workflow.nodes.length }
}

export function branchRunContext(run: Pick<BranchRun, 'branchState' | 'routeInputContext' | 'attempt' | 'retryFeedback'>, context: Record<string, unknown>) {
  return { ...context, ...(run.routeInputContext ?? {}), branch: run.branchState ?? emptyBranchState(), retry: { attempt: run.attempt ?? 1, feedback: run.retryFeedback ?? '' } }
}

/** Explicit loop ownership lets a user add a branch to an existing loop without
 * editing JSON or inferring execution scope from canvas coordinates. */
export function setBranchLoop<N extends GraphNode, W extends RouteWorkflow<N>>(workflow: W, id: string, parentId: string): W {
  if (parentId && !workflow.nodes.some(n => n.id === parentId && n.kind === 'loop')) throw new Error('循环节点不存在')
  const graph = { ...workflow, edges: executionRouteEdges(workflow) }
  return { ...workflow, nodes: workflow.nodes.map(n => {
    if (n.id === id) return { ...n, parentId: parentId || undefined }
    if (n.kind !== 'loop') return n
    const members = scopedLoopNodes(graph, n.id, orderRouteNodes(graph).ordered).map(child => child.id).filter(child => child !== id)
    return { ...n, childIds: n.id === parentId ? [...members, id] : members }
  }) } as W
}
