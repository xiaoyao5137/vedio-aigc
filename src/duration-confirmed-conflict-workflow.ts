type Node = { id: string; code?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

const oldReturn = 'if(confirmedConflict)return {...accepted,durationCompletion:completion};'
const oldCheck = "const confirmedConflict=accepted.qualityReview?.principleIssues?.some(row=>row?.code==='core_event_contradiction'&&row?.evidence?.source==='frame');\n"
const replacement = "const confirmedIssues=accepted.qualityReview?.principleIssues?.filter(row=>row?.code==='core_event_contradiction'&&row?.evidence?.source==='frame')??[];\nif(confirmedIssues.length){\nconst replanned={...completion,assessment:'incomplete',route:'replan',passed:false,reasons:[...completion.reasons,...confirmedIssues.map(row=>row.problem)]};\nreturn {...accepted,passed:false,durationCompletion:replanned,routeError:'DURATION_REPLAN_REQUIRED: 已确认前镜必需动作与实际成片矛盾；保留原视频并重新排镜',durationRepair:{previousCandidate:context.shot_script,durationCompletion:replanned,sourceVideo:context.video_evidence.url,issues:confirmedIssues.map(row=>row.repair||row.problem)}};\n}"

/** The schema180 principle gate could return passed=true for a confirmed
 * source-frame contradiction, bypassing the duration replan branch. */
export function upgradeDurationConfirmedConflictWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 180) return workflow
  const matches = workflow.nodes.filter(node => node.id === 'sanguo-media-accept')
  if (matches.length !== 1 || typeof matches[0].code !== 'string') throw Error('DURATION_CONFIRMED_CONFLICT_MIGRATION_CONFLICT: unique media gate required')
  const code = matches[0].code
  const start = code.indexOf('// PRINCIPLE_POLICY_START'), end = code.indexOf('// PRINCIPLE_POLICY_END')
  const active = code.slice(start, end)
  if (start !== 0 || end < 0 || active.split(oldCheck).length !== 2 || active.split(oldReturn).length !== 2
    || active.includes('const confirmedIssues=')) throw Error('DURATION_CONFIRMED_CONFLICT_MIGRATION_CONFLICT: schema180 gate differs')
  const upgradedCode = code.replace(oldCheck + oldReturn, replacement)
  if (upgradedCode === code) throw Error('DURATION_CONFIRMED_CONFLICT_MIGRATION_CONFLICT: contiguous anchor missing')
  return { ...workflow, schemaVersion: 181, nodes: workflow.nodes.map(node => node.id === 'sanguo-media-accept'
    ? { ...node, code: upgradedCode } : node), edges: workflow.edges }
}

/** A rejected take is routed to repair without asking a human to accept it. */
export function upgradeDurationRepairRoutingWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 181) return workflow
  const matches = workflow.nodes.filter(node => node.id === 'sanguo-media-accept')
  if (matches.length !== 1 || typeof matches[0].code !== 'string') throw Error('DURATION_REPAIR_ROUTING_MIGRATION_CONFLICT: unique media gate required')
  const code = matches[0].code
  const anchor = 'return {...accepted,passed:false,durationCompletion:replanned,routeError:'
  if (code.split(anchor).length !== 2 || code.includes('passed:false,manualDecisionRequired:false,durationCompletion:replanned'))
    throw Error('DURATION_REPAIR_ROUTING_MIGRATION_CONFLICT: schema181 route differs')
  return { ...workflow, schemaVersion: 182, nodes: workflow.nodes.map(node => node.id === 'sanguo-media-accept'
    ? { ...node, code: code.replace(anchor, 'return {...accepted,passed:false,manualDecisionRequired:false,durationCompletion:replanned,routeError:') } : node), edges: workflow.edges }
}
