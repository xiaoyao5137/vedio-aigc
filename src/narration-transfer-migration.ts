import { assessDurationCompletion, DURATION_COMPLETION_REVIEW_PROMPT } from './duration-completion.ts'

type Node = { id: string; code?: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[] }

const START = '// PRINCIPLE_POLICY_START'
const END = '// PRINCIPLE_POLICY_END'
const OLD_GATE = '// PRINCIPLE_DURATION_V2_GATE_SCHEMA159'
const NEW_GATE = '// INDEPENDENT_NARRATION_TRANSFER_GATE_SCHEMA162'
const COMPLETION_START = '【duration-v2逐节拍完成证据】'
const COMPLETION_END = '【duration-v2逐节拍完成证据结束】'
const OLD_AUDIO_INSTRUCTION = 'audio.evidenceIds只引用真实video_evidence.audioObservations.id或可靠speechValidation.alignment的speech-0等编号。'
const CALL_END = ')(context.shot_script,context.video_evidence,context.media_review);'

/** Update only the saved duration-v2 completion function and its bounded review
 * instruction. Saved graphs embed the function source, so changing the module
 * alone cannot give an already configured workflow the transfer proof gate. */
export function upgradeNarrationTransferWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 161) return workflow
  const accept = workflow.nodes.find(node => node.id === 'sanguo-media-accept')
  const review = workflow.nodes.find(node => node.id === 'sanguo-media-review')
  if (!accept?.code || typeof review?.prompt !== 'string') return workflow
  const code = accept.code
  const managedStart = code.indexOf(START), managedEnd = code.indexOf(END)
  const gate = code.indexOf(OLD_GATE), beginning = code.indexOf('const completion=(function assessDurationCompletion', gate)
  const ending = code.indexOf(CALL_END, beginning)
  if (managedStart < 0 || managedEnd <= managedStart || gate <= managedStart || gate >= managedEnd
    || beginning <= gate || beginning >= managedEnd || ending <= beginning || ending >= managedEnd
    || (code.indexOf('const completion=(function assessDurationCompletion', beginning + 1) !== -1
      && code.indexOf('const completion=(function assessDurationCompletion', beginning + 1) < managedEnd)
    || code.includes(NEW_GATE)) return workflow
  const replacement = `${NEW_GATE}\nconst completion=(${assessDurationCompletion.toString()}${CALL_END}`
  const nextCode = code.slice(0, beginning) + replacement + code.slice(ending + CALL_END.length)

  const prompt = review.prompt
  const promptStart = prompt.indexOf(COMPLETION_START), promptEnd = prompt.indexOf(COMPLETION_END, promptStart)
  if (promptStart < 0 || promptEnd <= promptStart
    || prompt.indexOf(COMPLETION_START, promptStart + COMPLETION_START.length) !== -1
    || prompt.indexOf(COMPLETION_END, promptEnd + COMPLETION_END.length) !== -1
    || !prompt.slice(promptStart, promptEnd).includes(OLD_AUDIO_INSTRUCTION)
    || !DURATION_COMPLETION_REVIEW_PROMPT.includes('independent-track-0')) return workflow
  const nextPrompt = prompt.slice(0, promptStart) + DURATION_COMPLETION_REVIEW_PROMPT
    + prompt.slice(promptEnd + COMPLETION_END.length)
  return { ...workflow, schemaVersion: 162, nodes: workflow.nodes.map(node => node.id === accept.id
    ? { ...node, code: nextCode } : node.id === review.id ? { ...node, prompt: nextPrompt } : node) } as W
}
