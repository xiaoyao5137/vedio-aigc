import { durationMediaAcceptCode } from './principle-workflow.ts'

type Node = { id: string; code?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

const GATE_ID = 'sanguo-media-accept'
const POLICY_START = '// PRINCIPLE_POLICY_START'
const POLICY_END = '// PRINCIPLE_POLICY_END'
const OLD_START = 'if(!completion.passed)return (function durationCompletionRecovery('
const OLD_PREFIX = 'if(!completion.passed)return '
const NEW_START = 'if(!completion.passed){'
const RECOVERY_START = 'return (function durationCompletionRecovery('
const RECOVERY_END = ')(context,completion,params);'
const NEXT_STATEMENT = '\nconst accepted=principleMediaQuality.acceptMedia(context,params);\nreturn {...accepted,durationCompletion:completion};'

/** Only wrap the schema179 active principle gate's existing recovery call.
 * The serialized assessor, recovery implementation and historical branch stay
 * byte-for-byte identical. */
export function upgradeDurationReviewConflictWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 179) return workflow
  const matches = workflow.nodes.filter(node => node.id === GATE_ID)
  if (matches.length !== 1 || typeof matches[0].code !== 'string') {
    throw Error('DURATION_REVIEW_CONFLICT_MIGRATION_CONFLICT: unique media acceptance code required')
  }
  const code = matches[0].code
  const policyStart = code.indexOf(POLICY_START), policyEnd = code.indexOf(POLICY_END)
  const active = code.slice(policyStart, policyEnd)
  const start = code.indexOf(OLD_START, policyStart)
  const callEnd = code.indexOf(RECOVERY_END, start) + RECOVERY_END.length
  const next = code.indexOf(NEXT_STATEMENT, callEnd)
  if (policyStart !== 0 || policyEnd < 0 || code.indexOf(POLICY_END, policyEnd + 1) !== -1
    || start <= policyStart || start >= policyEnd || callEnd <= start || callEnd >= policyEnd
    || next !== callEnd || active.split(OLD_START).length !== 2
    || !active.includes('const completion=(function assessDurationCompletion(')
    || !active.includes('[5, 6].includes(Number(transfer.mixerVersion))')
    || active.includes(NEW_START)) {
    throw Error('DURATION_REVIEW_CONFLICT_MIGRATION_CONFLICT: schema179 principle duration gate differs from expected contract')
  }
  const newStart = durationMediaAcceptCode.indexOf(NEW_START)
  const newCallStart = durationMediaAcceptCode.indexOf(RECOVERY_START, newStart)
  const newCallEnd = durationMediaAcceptCode.indexOf(RECOVERY_END, newCallStart) + RECOVERY_END.length
  const newNext = durationMediaAcceptCode.indexOf(NEXT_STATEMENT, newCallEnd)
  if (newStart < 0 || newCallStart < newStart || newCallEnd < newCallStart || newNext < newCallEnd
    || durationMediaAcceptCode.slice(newCallEnd, newNext) !== '\n}') {
    throw Error('DURATION_REVIEW_CONFLICT_MIGRATION_CONFLICT: source conflict priority is unavailable')
  }
  const recoveryCall = code.slice(start + OLD_PREFIX.length, callEnd)
  const replacement = durationMediaAcceptCode.slice(newStart, newCallStart)
    + 'return ' + recoveryCall + durationMediaAcceptCode.slice(newCallEnd, newNext)
  const upgradedCode = code.slice(0, start) + replacement + code.slice(callEnd)
  return { ...workflow, schemaVersion: 180, nodes: workflow.nodes.map(node => node.id === GATE_ID
    ? { ...node, code: upgradedCode } : node), edges: workflow.edges }
}
