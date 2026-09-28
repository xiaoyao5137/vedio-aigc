import { PRINCIPLE_TEXT_REVIEW_PROMPT, PRINCIPLE_TEXT_ACCEPT_CODE } from './principle-text-quality.ts'
import { PRINCIPLE_MEDIA_REVIEW_PROMPT, PRINCIPLE_IMAGE_REVIEW_PROMPT, PRINCIPLE_MEDIA_RUNTIME_CODE } from './principle-media-quality.ts'
import { PRINCIPLE_EPISODE_EVIDENCE_CODE, PRINCIPLE_EPISODE_REVIEW_PROMPT, PRINCIPLE_EPISODE_ACCEPT_CODE } from './principle-episode-quality.ts'
import { MAX_NODE_ATTEMPTS, resolveRetryAttemptLimit, upgradeWorkflowRetryAttempts } from './retry-budget.ts'
import { STORYBOARD_SPEECH_STAGING_PROMPT } from './speech-performance.ts'
import { refreshPronunciationStoryboardPrompt } from './pronunciation-hints.ts'
type Param = { id: string; name: string; englishName?: string; value: string; type: string; required: boolean }
type Node = { id: string; kind: string; prompt: string; params: Param[]; code?: string; operation?: string; runIf?: { path: string; equals: unknown } }
const param = (name: string, value: string, type = 'text'): Param => ({ id: 'principle-' + name, name, englishName: name, value, type, required: true })
function updateParams<N extends Node>(node: N, params: Param[]): N {
  return { ...node, params: [...node.params.filter(p => !params.some(next => next.name === (p.englishName || p.name))), ...params] }
}
function attemptParam(node: Node, name: string): Param {
  const existing = node.params.find(value => (value.englishName || value.name) === name)
  const configured = node.params.some(value => (value.englishName || value.name) === 'retryBudgetProfile' && ['principle-lean-v1', 'manual-review-v1'].includes(value.value))
  return { ...(existing ?? param(name, String(MAX_NODE_ATTEMPTS), 'number')), value: String(configured ? resolveRetryAttemptLimit(existing?.value, 2) : MAX_NODE_ATTEMPTS) }
}
const START = '// PRINCIPLE_POLICY_START', END = '// PRINCIPLE_POLICY_END'
function codePolicy(code: string, body: string) {
  const block = `${START}\nif (params.qualityMode === 'principle-v1') {\ntry {\n${body}\n} catch (error) { return {passed:false,routeError:error.message}; }\n}\n${END}`
  return code.includes(START) ? code.replace(/\/\/ PRINCIPLE_POLICY_START[\s\S]*?\/\/ PRINCIPLE_POLICY_END/, () => block) : block + '\n' + code
}
/** Explicit production policy upgrade. Original code remains as the strict
 * branch; saved execution snapshots are not passed to this configuration edit. */
export function upgradePrincipleQuality<N extends Node, W extends { id: string; schemaVersion?: number; nodes: N[] }>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 115) return workflow
  let changed = false
  const nodes = workflow.nodes.map(node => {
    let next = node
    if (['sanguo-scene-outline', 'sanguo-shot-script'].includes(node.id)) {
      next = updateParams(next, [param('qualityMode', 'principle-v1'), attemptParam(next, 'maxGenerationAttempts')])
      if (node.id === 'sanguo-shot-script') {
        const existing = /【说话人与声画一致性】[\s\S]*?【说话人与声画一致性结束】/g
        next = { ...next, prompt: existing.test(next.prompt) ? next.prompt.replace(existing, () => STORYBOARD_SPEECH_STAGING_PROMPT) : next.prompt + '\n' + STORYBOARD_SPEECH_STAGING_PROMPT }
        next = { ...next, prompt: refreshPronunciationStoryboardPrompt(next.prompt) }
      }
    }
    if (['sanguo-scene-outline-review', 'sanguo-shot-script-review', 'sanguo-character-review', 'sanguo-media-review', 'sanguo-episode-review'].includes(node.id)) {
      const prompt = node.id === 'sanguo-character-review' ? PRINCIPLE_IMAGE_REVIEW_PROMPT : node.id === 'sanguo-media-review' ? PRINCIPLE_MEDIA_REVIEW_PROMPT : node.id === 'sanguo-episode-review' ? PRINCIPLE_EPISODE_REVIEW_PROMPT : PRINCIPLE_TEXT_REVIEW_PROMPT
      next = updateParams({ ...next, prompt }, [param('qualityMode', 'principle-v1'), attemptParam(next, 'maxReviewAttempts')])
      if (node.id === 'sanguo-media-review') next = { ...next, params: next.params.filter(p => !['reviewPolicySource', 'reviewImageDetail'].includes(p.englishName || p.name)) }
    }
    const media = { 'sanguo-media-request': 'return principleMediaQuality.mediaRequest(context);', 'sanguo-media-metrics': 'return principleMediaQuality.mediaMetrics(context,params);',
      'sanguo-media-accept': 'return principleMediaQuality.acceptMedia(context,params);', 'sanguo-character-accept': 'return principleMediaQuality.acceptImages(context,params);' } as Record<string, string>
    if (media[node.id] && node.code) next = updateParams({ ...next, code: codePolicy(node.code, PRINCIPLE_MEDIA_RUNTIME_CODE + '\n' + media[node.id]) }, [param('qualityMode', 'principle-v1')])
    if (node.id === 'sanguo-video-evidence') next = updateParams(next, [param('qualityMode', 'principle-v1')])
    if (node.id === 'sanguo-video') next = updateParams(next, [param('qualityMode', 'principle-v1'),
      { ...param('pronunciationHints', '${shot_script.pronunciationHints}', 'json'), required: false }])
    if (['sanguo-video', 'sanguo-media-review', 'sanguo-media-accept'].includes(node.id)
      && !next.params.some(value => (value.englishName || value.name) === 'subtitlePolicy')) next = updateParams(next, [param('subtitlePolicy', 'none')])
    if (['sanguo-media-accept', 'sanguo-video-concat'].includes(node.id)) next = updateParams(next, [param('speechEvidencePolicy', 'enforce-evidenced-v1')])
    if (['sanguo-episode-evidence', 'sanguo-episode-review-accept'].includes(node.id) && node.code) {
      next = updateParams({ ...next, code: codePolicy(node.code, node.id === 'sanguo-episode-evidence' ? PRINCIPLE_EPISODE_EVIDENCE_CODE : PRINCIPLE_EPISODE_ACCEPT_CODE) }, [param('qualityMode', 'principle-v1')])
    }
    if (['sanguo-scene-outline-accept', 'sanguo-shot-script-accept'].includes(node.id) && node.code) {
      next = updateParams({ ...next, code: codePolicy(node.code, PRINCIPLE_TEXT_ACCEPT_CODE) }, [param('qualityMode', 'principle-v1')])
    }
    if (['sanguo-media-observe', 'sanguo-requirement-review'].includes(node.id)) next = { ...next, runIf: { path: 'media_metrics.requireDetailedReview', equals: true } }
    const ownedSubtitlePolicy = next.params.find(value => value.id === 'principle-subtitlePolicy' && (value.englishName || value.name) === 'subtitlePolicy' && value.value === 'none')
    if (ownedSubtitlePolicy && next.params.at(-1) !== ownedSubtitlePolicy) next = { ...next, params: [...next.params.filter(value => value !== ownedSubtitlePolicy), ownedSubtitlePolicy] }
    if (JSON.stringify(next) === JSON.stringify(node)) return node
    changed = true
    return next
  })
  const upgraded = changed || (workflow.schemaVersion ?? 0) < 117 ? { ...workflow, schemaVersion: Math.max(117, workflow.schemaVersion ?? 0), nodes } : workflow
  return upgradeWorkflowRetryAttempts(upgraded)
}
