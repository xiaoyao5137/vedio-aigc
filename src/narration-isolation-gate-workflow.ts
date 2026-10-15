import { assessDurationCompletion } from './duration-completion.ts'

type Node = { id: string; code?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

const GATE_ID = 'sanguo-media-accept'
const POLICY_START = '// PRINCIPLE_POLICY_START'
const POLICY_END = '// PRINCIPLE_POLICY_END'
const BINDING_MARKER = '// INDEPENDENT_NARRATION_TRANSFER_GATE_SCHEMA162'
const FUNCTION_START = 'const completion=('
const FUNCTION_END = ')(context.shot_script,context.video_evidence,context.media_review);'

/** Update only the active principle quality duration gate. The legacy branch
 * remains in place for historical executions using another quality mode. */
export function upgradeNarrationIsolationGateWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 178) return workflow
  const matches = workflow.nodes.filter(node => node.id === GATE_ID)
  if (matches.length !== 1 || typeof matches[0].code !== 'string') {
    throw Error('NARRATION_ISOLATION_GATE_MIGRATION_CONFLICT: unique media acceptance code required')
  }
  const code = matches[0].code
  const policyStart = code.indexOf(POLICY_START)
  const policyEnd = code.indexOf(POLICY_END)
  const marker = code.indexOf(BINDING_MARKER)
  const start = code.indexOf(FUNCTION_START, marker + BINDING_MARKER.length)
  const end = code.indexOf(FUNCTION_END, start + FUNCTION_START.length)
  const active = code.slice(policyStart, policyEnd)
  const previous = code.slice(start + FUNCTION_START.length, end)
  if (policyStart !== 0 || policyEnd < 0 || marker < policyStart || marker >= policyEnd
    || code.indexOf(BINDING_MARKER, marker + 1) >= 0
    || start <= marker || end <= start || end >= policyEnd
    || active.split(FUNCTION_START).length !== 2 || active.split(FUNCTION_END).length !== 2
    || !previous.startsWith('function assessDurationCompletion(')
    || !previous.includes('transfer.mixerVersion === 5') || previous.includes('full-source-mute')) {
    throw Error('NARRATION_ISOLATION_GATE_MIGRATION_CONFLICT: schema178 principle duration gate differs from expected v5 contract')
  }
  const current = assessDurationCompletion.toString()
  if (!current.startsWith('function assessDurationCompletion(')
    || !current.includes('[5, 6].includes(Number(transfer.mixerVersion))')
    || !current.includes("sourceSpeechIsolation.mode === 'full-source-mute'")) {
    throw Error('NARRATION_ISOLATION_GATE_MIGRATION_CONFLICT: current v6 full source mute gate is unavailable')
  }
  const upgradedCode = code.slice(0, start + FUNCTION_START.length) + current + code.slice(end)
  return { ...workflow, schemaVersion: 179, nodes: workflow.nodes.map(node => node.id === GATE_ID
    ? { ...node, code: upgradedCode } : node), edges: workflow.edges }
}
