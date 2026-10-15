type Node = { id: string; kind: string; title?: string; resultVar?: string; code?: string;
  parentId?: string; childIds?: string[]; runIf?: unknown; loop?: unknown; uploads?: unknown[];
  position?: { x: number; y: number }; params?: unknown[]; acceptance?: unknown }
type Edge = { id: string; from: string; to: string; branch?: 'true' | 'false' }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: Edge[] }
const approvalParam = { id: 'cc-approve-route', name: 'reviewRoute', englishName: 'reviewRoute',
  type: 'json', required: false, value: '${coverage_review_route}' }
function decisionCode(result: string, advisory: boolean, retryLimit = 0) {
  return `const report = context[${JSON.stringify(result)}];
if (!report || typeof report.passed !== 'boolean' || !Array.isArray(report.issues))
  throw Error('IMAGE_REVIEW_RESULT_INVALID: 缺少本镜完整的实图审核结论');
if (report.passed) return true;
${retryLimit ? `if (branch.counts.false + 1 >= ${retryLimit})
  throw Error('IMAGE_REVIEW_RETRY_EXHAUSTED: 连续实图审核未通过，停止重复付费生图并保留候选与缺陷证据');\n` : ''}${advisory ? `if (context.input?.qualityDisposition === 'manual-review-v1' && branch.counts.false + 1 >= 7)
  return { value: true, advisory: true, reviewPassed: false,
    qualityRisks: report.issues, retryCount: branch.counts.false + 1 };\n` : ''}return { value: false, feedback: { kind: 'image-review-retry', issues: report.issues,
  hardChecks: report.hardChecks, reviewVersion: report.version,
  attempt: branch.counts.false + 1 } };`
}

/** Refresh only an idle managed decision. Older executions may lack the
 * scene-cut sibling node, which makes a whole-graph refresh too conservative. */
export function refreshPendingImageReviewRouteRuns<N extends Node, R extends { node: N; status: string }>(
  workflow: Workflow<N>, runs: R[]): R[] {
  const current = workflow.nodes.find(node => node.id === 'sanguo-coverage-review-route')
  const approval = workflow.nodes.find(node => node.id === 'sanguo-coverage-approval')
  if (current?.code !== decisionCode('coverage_review', true)) return runs
  let changed = false
  const updated = runs.map(run => {
    if (['idle', 'failed'].includes(run.status) && run.node.id === approval?.id
      && Array.isArray(run.node.params) && !run.node.params.some(param =>
        param && typeof param === 'object' && (param as { englishName?: string }).englishName === 'reviewRoute')) {
      changed = true
      return { ...run, node: { ...run.node, params: [...run.node.params, approvalParam] } }
    }
    if (run.status !== 'idle' || run.node.id !== current.id
      || run.node.code !== decisionCode('coverage_review', false)) return run
    changed = true
    return { ...run, node: current }
  })
  return changed ? updated : runs
}

/** A negative visual review is a graph decision, before the paid video gate.
 * The false edge reuses the frozen sources and pays only for a new first frame. */
export function upgradeImageReviewRouteWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 190) return workflow
  const owner = workflow.nodes.find(node => node.id === 'sanguo-scene-loop')
  if (!owner?.childIds) return workflow
  const routes = [
    { review: 'sanguo-coverage-review', image: 'sanguo-coverage-first-frame', approval: 'sanguo-coverage-approval', result: 'coverage_review', id: 'sanguo-coverage-review-route' },
    { review: 'sanguo-scene-cut-review', image: 'sanguo-scene-cut-first-frame', approval: 'sanguo-scene-cut-approval', result: 'scene_cut_review', id: 'sanguo-scene-cut-review-route' },
  ]
  const additions: N[] = []
  let changed = false
  let nodes = workflow.nodes.map(node => ({ ...node }))
  let edges = workflow.edges.map(edge => ({ ...edge }))
  let childIds = [...owner.childIds]
  for (const route of routes) {
    const review = nodes.find(node => node.id === route.review)
    const image = nodes.find(node => node.id === route.image)
    const approval = nodes.find(node => node.id === route.approval)
    const existing = nodes.find(node => node.id === route.id)
    if (!review || !image || !approval) continue
    if (existing) {
      if (route.id === 'sanguo-scene-cut-review-route'
        && existing.code === decisionCode(route.result, false)) {
        nodes = nodes.map(node => node.id === existing.id
          ? { ...node, code: decisionCode(route.result, false, 7) } : node)
        changed = true
      }
      if (route.id === 'sanguo-coverage-review-route' && existing.code === decisionCode(route.result, false)) {
        nodes = nodes.map(node => node.id === existing.id ? { ...node, code: decisionCode(route.result, true) }
          : node.id === approval.id ? { ...node, params: [...(node.params ?? []), approvalParam] } : node)
        changed = true
      }
      continue
    }
    if (!edges.some(edge => edge.from === review.id && edge.to === approval.id)
      || !childIds.includes(review.id) || !childIds.includes(image.id) || !childIds.includes(approval.id)) continue
    const decision = {
      id: route.id, kind: 'branch', title: `${review.title ?? '首帧实图审核'}结果路由`,
      resultVar: `${route.result}_route`, parentId: 'sanguo-scene-loop',
      runIf: review.runIf, loop: review.loop, uploads: [], params: [],
      position: { x: (review.position?.x ?? 0) + 120, y: review.position?.y ?? 0 },
      code: decisionCode(route.result, route.id === 'sanguo-coverage-review-route',
        route.id === 'sanguo-scene-cut-review-route' ? 7 : 0),
    } as unknown as N
    additions.push(decision)
    nodes = nodes.map(node => node.id === review.id ? { ...node, acceptance: undefined } : node)
    if (route.id === 'sanguo-coverage-review-route')
      nodes = nodes.map(node => node.id === approval.id ? { ...node, params: [...(node.params ?? []), approvalParam] } : node)
    const at = childIds.indexOf(review.id)
    childIds.splice(at + 1, 0, decision.id)
    edges = edges.filter(edge => !(edge.from === review.id && edge.to === approval.id))
    edges.push({ id: `${decision.id}-entry`, from: review.id, to: decision.id },
      { id: `${decision.id}-pass`, from: decision.id, to: approval.id, branch: 'true' },
      { id: `${decision.id}-retry`, from: decision.id, to: image.id, branch: 'false' })
  }
  if (!additions.length && !changed) return workflow
  nodes = nodes.map(node => node.id === owner.id ? { ...node, childIds } : node)
  return { ...workflow, schemaVersion: Math.max(192, workflow.schemaVersion ?? 0), nodes: [...nodes, ...additions], edges } as W
}
