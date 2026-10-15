import { PRINCIPLE_TEXT_REVIEW_PROMPT, PRINCIPLE_TEXT_ACCEPT_CODE } from './principle-text-quality.ts'
import { PRINCIPLE_MEDIA_REVIEW_PROMPT, PRINCIPLE_IMAGE_REVIEW_PROMPT, PRINCIPLE_MEDIA_RUNTIME_CODE } from './principle-media-quality.ts'
import { PRINCIPLE_EPISODE_EVIDENCE_CODE, PRINCIPLE_EPISODE_REVIEW_PROMPT, PRINCIPLE_EPISODE_ACCEPT_CODE } from './principle-episode-quality.ts'
import { MAX_NODE_ATTEMPTS, resolveRetryAttemptLimit, upgradeWorkflowRetryAttempts } from './retry-budget.ts'
import { STORYBOARD_SPEECH_STAGING_PROMPT } from './speech-performance.ts'
import { refreshPronunciationStoryboardPrompt } from './pronunciation-hints.ts'
import { assessDurationCompletion, DURATION_COMPLETION_REVIEW_PROMPT } from './duration-completion.ts'
import { durationCompletionRecovery, durationMediaRequest } from './duration-workflow.ts'
import { DURATION_REFERENCE_REVIEW } from './duration-prompts.ts'
import { deriveMediaEvidenceViews } from './media-evidence-views.ts'
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
export const durationMediaRequestCode = `const principleRequest=principleMediaQuality.mediaRequest(context);\nif(context.shot_script?.pacing?.version==='duration-v2'){\nconst durationRequest=(${durationMediaRequest.toString()})(context,params);\nreturn {...principleRequest,...durationRequest,dependentReaction:principleRequest.dependentReaction,latestSpeechEnd:principleRequest.dependentReaction?principleRequest.latestSpeechEnd:durationRequest.latestSpeechEnd};\n}\nreturn principleRequest;`
export const durationMediaAcceptCode = `if(context.shot_script?.pacing?.version==='duration-v2'){\nif(context.video_take?.params?.scheduleHash!==context.shot_script.pacing.scheduleHash)return {passed:false,routeError:'DURATION_CONTRACT_INVALID: 视频不属于当前排程，禁止沿用旧素材验收'};\nif(context.video_evidence?.originalUrl!==context.video_take?.url)return {passed:false,routeError:'DURATION_CONTRACT_INVALID: 采证不属于当前视频'};\nconst completion=(${assessDurationCompletion.toString()})(context.shot_script,context.video_evidence,context.media_review);\nif(!completion.passed){\nconst allegedConflict=Array.isArray(context.media_review?.issues)&&context.media_review.issues.some(row=>row?.code==='core_event_contradiction'&&row?.evidence?.source==='frame');\nif(allegedConflict){\nconst accepted=principleMediaQuality.acceptMedia(context,params);\nconst confirmedIssues=accepted.qualityReview?.principleIssues?.filter(row=>row?.code==='core_event_contradiction'&&row?.evidence?.source==='frame')??[];\nif(confirmedIssues.length){\nconst replanned={...completion,assessment:'incomplete',route:'replan',passed:false,reasons:[...completion.reasons,...confirmedIssues.map(row=>row.problem)]};\nconst priorRepair=context.durationRepair??context.retry?.feedback;\nif(params.qualityDisposition==='manual-review-v1'&&priorRepair?.sourceVideo&&priorRepair.sourceVideo!==context.video_evidence?.url&&priorRepair.previousCandidate?.id===context.shot_script?.id&&Array.isArray(priorRepair.issues)&&priorRepair.issues.length){\nconst qualityRisks=[...(accepted.qualityRisks??[]),...confirmedIssues.map(issue=>({...issue,code:'core_event_contradiction',disposition:'human_review_after_retake'}))];\nreturn {...accepted,passed:true,manualDecisionRequired:false,qualityReview:{...accepted.qualityReview,status:'needs_attention',canProceed:true,manualDecisionRequired:false},durationCompletion:{...replanned,route:'manual-review'},qualityRisks,warnings:[...(accepted.warnings??[]),{code:'core_event_contradiction_after_retake',problem:'重拍后仍发现画面与必需动作矛盾；保留实图证据并建议在此镜打断点人工验收'}]};\n}\nreturn {...accepted,passed:false,manualDecisionRequired:false,durationCompletion:replanned,routeError:'DURATION_REPLAN_REQUIRED: 已确认前镜必需动作与实际成片矛盾；保留原视频并重新排镜',durationRepair:{previousCandidate:context.shot_script,durationCompletion:replanned,sourceVideo:context.video_evidence.url,issues:confirmedIssues.map(row=>row.repair||row.problem)}};\n}\n}\nconst recovery=(${durationCompletionRecovery.toString()})(context,completion,params);\nif(params.qualityDisposition==='manual-review-v1'&&completion.assessment==='uncertain'&&/^(?:DURATION_EVIDENCE_EXHAUSTED|DURATION_AUDIO_REVIEW_REQUIRED|REVIEW_RESULT_INVALID):/.test(recovery.routeError??'')){\nconst accepted=principleMediaQuality.acceptMedia(context,params);\nconst qualityRisks=[...(accepted.qualityRisks??[]),...completion.checks.filter(row=>row.status!=='complete').map(row=>({code:'duration_completion_unverified',beatId:row.beatId,sourceBeatId:row.sourceBeatId,status:row.status,reasons:row.reasons,evidenceRef:completion.evidenceRef})),{code:'duration_evidence_limit',reason:recovery.routeError,evidenceRef:completion.evidenceRef}];\nreturn {...accepted,passed:true,manualDecisionRequired:false,qualityReview:{...accepted.qualityReview,status:'needs_attention',canProceed:true,manualDecisionRequired:false},durationCompletion:completion,qualityRisks,warnings:[...(accepted.warnings??[]),{code:'duration_completion_unverified',problem:'逐节拍完成证据尚不充分，建议在此镜打断点播放验收',evidenceRef:completion.evidenceRef}],retryPrompt:accepted.retryPrompt};\n}\nreturn recovery;\n}\nconst accepted=principleMediaQuality.acceptMedia(context,params);\nreturn {...accepted,durationCompletion:completion};\n}\nreturn principleMediaQuality.acceptMedia(context,params);`
export const principleNativeSequenceMetricsCode = `// NATIVE_PRINCIPLE_SEQUENCE_GRID_SCHEMA163\nconst metrics=principleMediaQuality.mediaMetrics(context,params);\nif(context.shot_script?.pacing?.version==='duration-v2'&&context.video_evidence?.nativeSequence){\nconst views=(${deriveMediaEvidenceViews.toString()})(context.video_evidence);\nreturn {...metrics,nativeReviewImageDetail:views.reviewImageDetail};\n}\nreturn metrics;`
function codePolicy(code: string, body: string) {
  const block = `${START}\nif (params.qualityMode === 'principle-v1') {\ntry {\n${body}\n} catch (error) { return {passed:false,routeError:error.message}; }\n}\n${END}`
  return code.includes(START) ? code.replace(/\/\/ PRINCIPLE_POLICY_START[\s\S]*?\/\/ PRINCIPLE_POLICY_END/, () => block) : block + '\n' + code
}
/** Refresh only a pending managed video acceptance gate in a resumed run.
 * Completed reviews and paid video results retain their saved definitions. */
export function refreshPendingDurationMediaAcceptRuns<N extends Node, R extends { node: N; status: string }>(
  workflow: { nodes: N[] }, runs: R[]): R[] {
  const current = workflow.nodes.find(node => node.id === 'sanguo-media-accept')
  if (!current?.code?.includes('core_event_contradiction_after_retake')) return runs
  let changed = false
  const updated = runs.map(run => {
    if (!['idle', 'failed'].includes(run.status) || run.node.id !== current.id
      || run.node.code === current.code) return run
    changed = true
    return { ...run, node: { ...run.node, code: current.code } }
  })
  return changed ? updated : runs
}
/** Reconcile the managed media gate after older migrations have finished. */
export function upgradeDurationRetakeAdvisoryWorkflow<N extends Node, W extends { id: string; schemaVersion?: number; nodes: N[] }>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 192) return workflow
  const current = workflow.nodes.find(node => node.id === 'sanguo-media-accept')
  if (!current?.code) return workflow
  const canonical = upgradePrincipleQuality(workflow).nodes.find(node => node.id === current.id)
  if (!canonical?.code?.includes('core_event_contradiction_after_retake')) return workflow
  if (current.code === canonical.code && (workflow.schemaVersion ?? 0) >= 193) return workflow
  return { ...workflow, schemaVersion: Math.max(193, workflow.schemaVersion ?? 0),
    nodes: workflow.nodes.map(node => node.id === current.id ? { ...node, code: canonical.code } : node) }
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
      const prompt = node.id === 'sanguo-character-review' ? PRINCIPLE_IMAGE_REVIEW_PROMPT : node.id === 'sanguo-media-review'
        ? PRINCIPLE_MEDIA_REVIEW_PROMPT
          .replace('仅拦：主演身份', '非duration-v2仅拦：主演身份')
          .replace('普通表情、手势、布料色差、小道具细节、节奏、尾部空等、剪辑余量、镜头美感都写warnings；', '普通表情、手势、布料色差、小道具细节、镜头美感写warnings；duration-v2的必需节拍、先后顺序与收尾余量须另按完成证据契约评估；')
          .replace('不要逐节拍/逐秒/逐人物填大型检查表。', '非duration-v2分镜无需逐节拍/逐秒/逐人物填大型检查表；duration-v2必须按下述完成证据契约逐个检查必需节拍。')
          .replace('【原则质检结束】', `${DURATION_COMPLETION_REVIEW_PROMPT}\n${DURATION_REFERENCE_REVIEW}\n【原则质检结束】`)
        : node.id === 'sanguo-episode-review' ? PRINCIPLE_EPISODE_REVIEW_PROMPT : PRINCIPLE_TEXT_REVIEW_PROMPT
      next = updateParams({ ...next, prompt }, [param('qualityMode', 'principle-v1'), attemptParam(next, 'maxReviewAttempts')])
      if (node.id === 'sanguo-media-review') {
        next = { ...next, params: next.params.filter(p => !['reviewPolicySource', 'reviewImageDetail'].includes(p.englishName || p.name)) }
        if ((workflow.schemaVersion ?? 0) >= 163) next = updateParams(next,
          [{ ...param('reviewImageDetail', '${media_metrics.nativeReviewImageDetail}', 'json'), required: false }])
      }
    }
    const media = { 'sanguo-media-request': durationMediaRequestCode,
      'sanguo-media-metrics': (workflow.schemaVersion ?? 0) >= 163 ? principleNativeSequenceMetricsCode : 'return principleMediaQuality.mediaMetrics(context,params);',
      'sanguo-media-accept': durationMediaAcceptCode, 'sanguo-character-accept': 'return principleMediaQuality.acceptImages(context,params);' } as Record<string, string>
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
