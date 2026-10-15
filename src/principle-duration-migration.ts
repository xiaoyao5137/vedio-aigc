import { DURATION_COMPLETION_REVIEW_PROMPT } from './duration-completion.ts'
import { DURATION_REFERENCE_REVIEW } from './duration-prompts.ts'
import { durationMediaAcceptCode, durationMediaRequestCode } from './principle-workflow.ts'

type Node = { id: string; code?: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[] }
const START = '// PRINCIPLE_POLICY_START'
const END = '// PRINCIPLE_POLICY_END'
const MARKER = '// PRINCIPLE_DURATION_V2_GATE_SCHEMA159'
const COMPLETION_START = '【duration-v2逐节拍完成证据】'
const COMPLETION_END = '【duration-v2逐节拍完成证据结束】'
const REFERENCE_START = '【duration-v2时间解释】'

/** Replace only the final return of an existing managed principle branch. The
 * old strict/legacy code after END and the lean/manual policy functions before
 * that return belong to their original owners and must remain byte-identical. */
function refreshManagedReturn(code: string, finalReturn: string, replacement: string): string | undefined {
  const start = code.indexOf(START), end = code.indexOf(END)
  if (start < 0 || end <= start || code.indexOf(START, start + START.length) >= 0
    || code.indexOf(END, end + END.length) >= 0) return undefined
  const managed = code.slice(start, end)
  if (managed.includes(MARKER)) return code
  const index = managed.indexOf(finalReturn)
  if (index < 0 || managed.indexOf(finalReturn, index + finalReturn.length) >= 0
    || !/^\s*}\s*catch\s*\(/.test(managed.slice(index + finalReturn.length))) return undefined
  return code.slice(0, start) + managed.slice(0, index) + MARKER + '\n' + replacement
    + managed.slice(index + finalReturn.length) + code.slice(end)
}

/** Keep editor prose and other duration sections; change only the three
 * contradictory principle sentences and the two evidence contracts. */
function refreshReviewPrompt(source: string): string | undefined {
  if (!source.includes('【原则质检结束】') || source.split('【原则质检结束】').length !== 2) return undefined
  let prompt = (source.includes('非duration-v2仅拦：主演身份') ? source : source
    .replace('仅拦：主演身份', '非duration-v2仅拦：主演身份'))
    .replace('普通表情、手势、布料色差、小道具细节、节奏、尾部空等、剪辑余量、镜头美感都写warnings；',
      '普通表情、手势、布料色差、小道具细节、镜头美感写warnings；duration-v2的必需节拍、先后顺序与收尾余量须另按完成证据契约评估；')
    .replace('不要逐节拍/逐秒/逐人物填大型检查表。',
      '非duration-v2分镜无需逐节拍/逐秒/逐人物填大型检查表；duration-v2必须按下述完成证据契约逐个检查必需节拍。')
  const completionPattern = /【duration-v2逐节拍完成证据】[\s\S]*?【duration-v2逐节拍完成证据结束】/g
  const completionMatches = [...prompt.matchAll(completionPattern)]
  if (completionMatches.length > 1 || (prompt.includes(COMPLETION_START) && !completionMatches.length)
    || (prompt.includes(COMPLETION_END) && !completionMatches.length)) return undefined
  if (completionMatches.length) prompt = prompt.replace(completionPattern, () => DURATION_COMPLETION_REVIEW_PROMPT)
  const referencePattern = /【duration-v2时间解释】[^\n]*/g
  const referenceMatches = [...prompt.matchAll(referencePattern)]
  if (referenceMatches.length > 1) return undefined
  if (referenceMatches.length) prompt = prompt.replace(referencePattern, () => DURATION_REFERENCE_REVIEW.trimStart())
  if (!prompt.includes(COMPLETION_START)) prompt = prompt.replace('【原则质检结束】',
    () => `${DURATION_COMPLETION_REVIEW_PROMPT}\n【原则质检结束】`)
  if (!prompt.includes(REFERENCE_START)) prompt = prompt.replace(COMPLETION_END,
    () => `${COMPLETION_END}${DURATION_REFERENCE_REVIEW}`)
  return prompt
}

/** Schema 158 persisted graphs skip upgradePrincipleQuality in the outer
 * hydration chain. This one-time migration updates only the three affected
 * policy surfaces, and refuses ambiguous custom anchors without altering the
 * saved graph or claiming schema 159. Callers decide when to persist. */
export function upgradePrincipleDurationWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 158
    || (workflow.schemaVersion ?? 0) > 159) return workflow
  const request = workflow.nodes.find(node => node.id === 'sanguo-media-request')
  const accept = workflow.nodes.find(node => node.id === 'sanguo-media-accept')
  const review = workflow.nodes.find(node => node.id === 'sanguo-media-review')
  if (!request?.code || !accept?.code || typeof review?.prompt !== 'string') return workflow
  const requestCode = refreshManagedReturn(request.code, 'return principleMediaQuality.mediaRequest(context);', durationMediaRequestCode)
  const acceptCode = refreshManagedReturn(accept.code, 'return principleMediaQuality.acceptMedia(context,params);', durationMediaAcceptCode)
  const reviewPrompt = refreshReviewPrompt(review.prompt)
  if (requestCode === undefined || acceptCode === undefined || reviewPrompt === undefined) return workflow
  if (workflow.schemaVersion === 159 && requestCode === request.code && acceptCode === accept.code && reviewPrompt === review.prompt) return workflow
  return { ...workflow, schemaVersion: 159, nodes: workflow.nodes.map(node => node.id === request.id
    ? { ...node, code: requestCode } : node.id === accept.id ? { ...node, code: acceptCode }
      : node.id === review.id ? { ...node, prompt: reviewPrompt } : node) } as W
}
