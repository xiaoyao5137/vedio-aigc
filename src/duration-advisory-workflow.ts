import { durationMediaAcceptCode } from './principle-workflow.ts'

type Node = { id: string; code?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[] }

/** Keep paid takes and completed nodes intact while updating the pending media gate. */
export function upgradeDurationAdvisoryWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 187) return workflow
  const matches = workflow.nodes.filter(node => node.id === 'sanguo-media-accept')
  if (matches.length !== 1 || typeof matches[0].code !== 'string')
    throw Error('DURATION_ADVISORY_MIGRATION_CONFLICT: unique media gate required')
  const code = matches[0].code
  const startAnchor = 'return (function durationCompletionRecovery('
  const endAnchor = ')(context,completion,params);'
  const start = code.indexOf(startAnchor), end = code.indexOf(endAnchor, start) + endAnchor.length
  const newStart = durationMediaAcceptCode.indexOf('const recovery=(function durationCompletionRecovery(')
  const newEnd = durationMediaAcceptCode.indexOf('return recovery;', newStart) + 'return recovery;'.length
  const managedEnd = code.indexOf('// PRINCIPLE_POLICY_END')
  if (start < 0 || end <= start || end >= managedEnd
    || code.indexOf(startAnchor, start + startAnchor.length) < managedEnd && code.indexOf(startAnchor, start + startAnchor.length) >= 0
    || newStart < 0 || newEnd <= newStart || !code.includes('const completion=(function assessDurationCompletion('))
    throw Error('DURATION_ADVISORY_MIGRATION_CONFLICT: media gate differs from expected contract')
  const upgraded = code.slice(0, start) + durationMediaAcceptCode.slice(newStart, newEnd) + code.slice(end)
  return { ...workflow, schemaVersion: 188, nodes: workflow.nodes.map(node => node.id === 'sanguo-media-accept'
    ? { ...node, code: upgraded } : node) } as W
}
