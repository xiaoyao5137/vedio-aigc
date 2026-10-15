import { assessDurationCompletion } from './duration-completion.ts'

type Node = { id: string; code?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[] }

const MANAGED_START = '// PRINCIPLE_POLICY_START'
const MANAGED_END = '// PRINCIPLE_POLICY_END'
const PRIOR_MARKER = '// INDEPENDENT_NARRATION_TRANSFER_GATE_SCHEMA162'
const COMPLETION_PREFIX = 'const completion=('
const COMPLETION_START = 'const completion=(function assessDurationCompletion'
const COMPLETION_CALL = ')(context.shot_script,context.video_evidence,context.media_review);'
const NEW_BLOCK_START = '          const primaryAsr = record(sourceAsr.primaryAsr)\n'
const NEW_BLOCK_END = '          const scheduledStart = Number(scheduled.startSecond), scheduledEnd = Number(scheduled.endSecond)'
const NEW_ASR_CHECK = '&& asrProvenance && sourceAsr.reliable === true'
const OLD_ASR_CHECK = "&& sourceAsr.method === 'isolated-source-asr-v2' && sourceAsr.reliable === true"
const occurrences = (text: string, value: string) => text.split(value).length - 1

/** Reconstruct the exact schema 163 function from the new implementation.
 * If any unrelated change to the function has landed, the saved source will
 * differ and this migration refuses to overwrite it. */
export function previousNarrationAsrCompletionSource() {
  const current = assessDurationCompletion.toString()
  const start = current.indexOf(NEW_BLOCK_START), end = current.indexOf(NEW_BLOCK_END, start)
  if (start < 0 || end <= start || occurrences(current, NEW_BLOCK_START) !== 1
    || occurrences(current, NEW_BLOCK_END) !== 1 || occurrences(current, NEW_ASR_CHECK) !== 1) return undefined
  return (current.slice(0, start) + current.slice(end)).replace(NEW_ASR_CHECK, OLD_ASR_CHECK)
}

/** Schema 164 refreshes only the embedded completion assessor in the managed
 * media-accept block. Every other byte of every saved node stays intact. */
export function upgradeNarrationAsrFallbackWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 163) return workflow
  const oldSource = previousNarrationAsrCompletionSource()
  const accept = workflow.nodes.find(node => node.id === 'sanguo-media-accept')
  if (!oldSource || !accept?.code) return workflow
  const code = accept.code
  if ([MANAGED_START, MANAGED_END, PRIOR_MARKER].some(anchor => occurrences(code, anchor) !== 1)) return workflow
  const managedStart = code.indexOf(MANAGED_START), managedEnd = code.indexOf(MANAGED_END)
  if (managedStart < 0 || managedEnd <= managedStart) return workflow
  const managed = code.slice(managedStart, managedEnd)
  if (occurrences(managed, COMPLETION_START) !== 1 || occurrences(managed, COMPLETION_CALL) !== 1) return workflow
  const marker = code.indexOf(PRIOR_MARKER), start = code.indexOf(COMPLETION_START, managedStart), call = code.indexOf(COMPLETION_CALL, start)
  const functionStart = start + COMPLETION_PREFIX.length
  if (marker <= managedStart || marker >= start
    || start <= marker || call <= start || call >= managedEnd || managedEnd <= call + COMPLETION_CALL.length
    || code.slice(functionStart, call) !== oldSource) return workflow
  const nextCode = code.slice(0, functionStart) + assessDurationCompletion.toString() + code.slice(call)
  return { ...workflow, schemaVersion: 164,
    nodes: workflow.nodes.map(node => node.id === accept.id ? { ...node, code: nextCode } : node) } as W
}
