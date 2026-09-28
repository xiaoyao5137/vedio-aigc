import { storyboardTimelineMatches } from './storyboard-timeline.ts'
import { serializeRuntimeFunction, type SerializableRuntimeFunction } from './serialized-runtime.ts'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT, SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING, SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE, refreshStoryboardEditorialPrompt,
  STORYBOARD_AUDIO_COVERAGE_BEFORE_LINE_BINDING, STORYBOARD_AUDIO_COVERAGE_LINE_BINDING,
  STORYBOARD_DIALOGUE_BEFORE_LINE_BINDING, STORYBOARD_DIALOGUE_LINE_BINDING } from './storyboard-prompt.ts'
import { SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING } from './legacy-storyboard-timing-prompt.ts'
import { CINEMATIC_WORLD_STATE_REVIEW_PROMPT } from './history-media.ts'
import { GROUNDED_FRAME_OBSERVATION_PROMPT, refreshMediaAttributionReviewPrompt, refreshMediaDetailReviewPrompt, refreshIndependentMediaReviewPrompt } from './media-observation.ts'
import { deriveIdleTailEdit } from './media-edit.ts'
import { validateMediaDefectEvidence, refreshMediaDefectEvidencePrompt, refreshScopedMediaDefectPrompt } from './media-defect-evidence.ts'
import { deriveMediaRequirements, validateMediaRequirementChecks } from './media-requirement-coverage.ts'
import { CANONICAL_MEDIA_REVIEW_PROMPT, isCanonicalMediaReviewPrompt } from './canonical-media-review.ts'
import { validateReviewParts } from './review-validation.ts'
import { validateScriptStateEvidence } from './script-state-evidence.ts'
import { uncertainMediaReviewDiagnostic } from './media-review-diagnostics.ts'
import { MEDIA_EVIDENCE_GAPS_PROMPT, validateMediaEvidenceGaps } from './media-evidence-gaps.ts'
import { deriveAdaptiveMediaSamplingPlan } from './media-adaptive-sampling.ts'
import { resolveNativeFrameDisplayInterval } from './media-frame-display.ts'
import { REPORT_FORMAT_FEEDBACK_RETURN, reportFormatRetryBranchReturn } from './branch-migration.ts'
import { deriveMediaSamplingPlan } from './media-sampling-plan.ts'
import { deriveMediaEvidenceViews } from './media-evidence-views.ts'
import { deriveMediaSamplingReview } from './media-sampling-review.ts'
import { REQUIREMENT_MEDIA_REVIEW_PROMPT, deriveRequirementReviewInputs, combineIndependentMediaReviews } from './media-requirement-review.ts'
import { refreshEmbeddedDramaturgyReviewCode, refreshDramaturgyReviewPrompt, DRAMATURGY_ACCEPT_CODE, EPISODE_EVIDENCE_CODE, EPISODE_REVIEW_PROMPT, EPISODE_REVIEW_ACCEPT_CODE } from './drama-quality-presets.ts'
import { SCENE_OUTLINE_CAST_CONTRACT, SCENE_OUTLINE_CAST_CONTRACT_BEFORE_ACTORLESS_BRIDGE, SANGUO_SCENE_OUTLINE_PROMPT, refreshSceneOutlineAnchorPrompt } from './scene-outline-prompt.ts'
import { Locale } from 'opencc-js/t2cn'
import { animatedMapFirstFrameNode, refreshStaticBoundaryFrameScope, upgradeAnimatedMapBoundaryFrames, upgradeAnimatedShotStyles } from './animated-map-frames.ts'
import { SANGUO_CHARACTER_LOOKUP_CODE, SANGUO_FIRST_FRAME_BRANCH_CODE } from './code-node-presets.ts'
import { PRINCIPLE_IMAGE_REVIEW_PROMPT } from './principle-media-quality.ts'
import { DEFAULT_DURATION_POLICY } from './duration-policy.ts'
import { deriveApprovedReactionDeadline } from './speech-reaction-deadline.ts'
import { validateHistoricalAgency, refreshEmbeddedHistoricalAgencyCode } from './history-content-guards.ts'
import { HISTORICAL_SOURCE_REVIEW_RUNTIME_CODE } from './history-source-review.ts'
import { hasExplicitWorldStateUncertainty, hasValidCinematicWorldFactShape } from './history-cinema.ts'
// Workflow configuration. Prompts, thresholds and code are persisted and editable.
import type { AcceptancePolicy, ErrorRetryPolicy } from './node-retry.ts'
import { upgradeDurationWorkflow } from './duration-workflow.ts'
import { DURATION_COMPLETION_REVIEW_PROMPT } from './duration-completion.ts'
import { DURATION_ACTOR_IDS_CONTRACT, DURATION_ACTOR_IDS_CONTRACT_BEFORE_ACTORLESS_EDITORIAL, DURATION_ACTOR_IDS_CONTRACT_BEFORE_SETTING_ESTABLISHMENT } from './duration-prompts.ts'

// Explicit dependency declarations keep embedded code isolated after production
// name mangling. These are top-level declarations, not closures over module data.
const mediaRuntimeDependencies = new Map<SerializableRuntimeFunction, SerializableRuntimeFunction[]>([
  [deriveMediaRequirements, [storyboardTimelineMatches]],
  [deriveRequirementReviewInputs, [deriveMediaRequirements, resolveNativeFrameDisplayInterval]],
  [combineIndependentMediaReviews, [validateMediaEvidenceGaps, validateScriptStateEvidence]],
  [validateMediaRequirementChecks, [deriveMediaRequirements, resolveNativeFrameDisplayInterval, validateMediaEvidenceGaps]],
  [validateMediaDefectEvidence, [validateScriptStateEvidence, storyboardTimelineMatches, resolveNativeFrameDisplayInterval]],
  [deriveAdaptiveMediaSamplingPlan, [deriveMediaRequirements, resolveNativeFrameDisplayInterval]],
  [deriveMediaSamplingReview, [deriveMediaRequirements, validateMediaRequirementChecks, resolveNativeFrameDisplayInterval]],
  [uncertainMediaReviewDiagnostic, [deriveMediaRequirements]],
  [deriveMediaSamplingPlan, [deriveMediaRequirements]],
])
function mediaRuntimeCode(consumer: SerializableRuntimeFunction, ancestors = new Set<SerializableRuntimeFunction>()): string {
  if (ancestors.has(consumer)) throw Error('WORKFLOW_RUNTIME_BINDING_INVALID: 媒体运行时依赖存在循环')
  const next = new Set([...ancestors, consumer])
  return serializeRuntimeFunction(consumer, (mediaRuntimeDependencies.get(consumer) ?? []).map(dependency => ({ dependency,
    expression: mediaRuntimeCode(dependency, next) })))
}

// Freeze the deployed schema112 prefix: older migrations must not depend on
// the current parser implementation or later managed-code helpers.
export const VIDEO_REQUEST_PREFIX_SCHEMA112 = String.raw`
const shot = context.shot_script;
const text = String(shot.audioText || '');
const timeline = String(shot.videoPrompt || '').split('【')[0];
const matches = [...timeline.matchAll(/(\d+(?:\.\d+)?)\s*[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*秒\s*[:：]/g)];
const normalize = s => s.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '');
`;

export const VIDEO_REQUEST_CODE = String.raw`
const shot = context.shot_script;
const text = String(shot.audioText || '');
const timeline = String(shot.videoPrompt || '').split(/【(?!\s*(?:第\s*)?\d)/)[0];
const storyboardTimelineMatches = (${storyboardTimelineMatches.toString()});
const matches = storyboardTimelineMatches(timeline);
const normalize = s => s.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '');
const reactionDeadline = (${deriveApprovedReactionDeadline.toString()})(shot);
const windows = shot.pacing?.version === 'duration-v2' && Array.isArray(shot.pacing.speechWindows)
  ? shot.pacing.speechWindows
  : shot.audioType === '旁白' ? [{start: .5, end: shot.duration - .3, text}]
  : text.split(/\n+/).filter(Boolean).map(line => {
    const content = line.replace(/^[^：:]+[：:]/, '');
    const index = matches.findIndex((m,i) => normalize(timeline.slice(m.index + m[0].length, matches[i+1]?.index)).includes(normalize(content)));
    if(index < 0) throw Error('对白缺少时间窗：' + content);
    return { start: Number(matches[index][1]), end: Number(matches[index][2]), text: content };
  });
return { audioText: text, speechWindows: windows, latestSpeechEnd: reactionDeadline?.startSecond ?? shot.duration - .3,
  dependentReaction: reactionDeadline };
`

export const MEDIA_OBSERVATION_PROMPT = `只描述附件的实际画面，不评判剧本。附件按时间排列，时刻为 \${video_evidence.frameTimes} 秒。逐帧记录人物服装、站位、手部、持物和动作变化，不根据后一帧臆造中间动作。看不清的部分明确 unknown。背景路人不要强行算作主演。不知道角色姓名，不要猜。末帧状态只从最后一张图片提取。
返回 JSON {"frames":[{"index":0,"second":0,"setting":"实际场景","people":[{"clothing":"服装","position":"画面位置","pose":"身体和双手的实际状态","heldObjects":"实际可见物件"}]}],"tailObservation":"末帧实际状态"}。必须覆盖每个附件。`

export const MEDIA_REVIEW_PROMPT = `你是独立成片验收节点。依据实际采证和无剧本画面观察，对照本镜目标评估能否使用。不得把计划当成已发生事实。每条拒绝必须引用实际帧编号或 ASR 时间，给出保留全部台词、人物和剧情的可执行重拍建议。
语速参考下限为每秒 \${params.minSpeechRate} 汉字；逗号/分号短停顿各允许 \${params.shortPauseSeconds} 秒，句末停顿各 \${params.sentencePauseSeconds} 秒，ASR 边界容差 \${params.timingToleranceSeconds} 秒。跨度包含静音停顿，不能把总跨度直接当纯发音时间。逐词概率低、对齐覆盖不足、临界差异都应标 uncertain，不能凭几毫秒差异断言明显拖慢。明显连续拖腔、为填时长延长人声仍须 rejected，不能为通过放宽要求或删词。ASR 没有证明逐帧口型，不得声称验过。
逐项使用原 completionCriteria，不能新增点头、手指、收手等微姿态要求。视觉动作如递交、接稳必须有物件归属变化的证据，不能用台词替代。微表情未采样到不等于动作没发生，证据不足标 uncertain。剧情继续中的镜头允许未完成整个单元，但必须完成本镜已承诺动作。只拒绝明确角色/道具错误、动作缺失、尾帧缺人、时代错误；自然色差、台阶微差不拒绝。必须检查清式成排盘扣等明显服饰错误。将无名观察中的人物依据服装映射到汉字全名，不能按人物数组顺序猜左右。
尾部空等参考上限 \${params.maxIdleTailSeconds} 秒。最后必要动作时刻来自帧或 ASR，不能抄计划。尾帧 endingState 必须忠实引用观察，不得复制期望尾帧姿态。
返回 JSON {"decision":"accepted或rejected或uncertain","passed":true或false,"issues":["有证据的问题"],"warnings":[],"retryPrompt":"只针对实际问题的重拍指令","endingState":"汉字全名与实际尾帧状态","endCharacters":["实际可见全名"],"narrativeClosure":{"unitId":"原单元id","complete":true或false,"actionEvidence":"实际动作证据","responseEvidence":"实际回应证据","unresolvedActions":[],"criteriaChecks":[{"criterion":"原条件逐字","status":"complete或incomplete或unobservable","evidence":"具体证据"}]},"pacingReview":{"passed":true或false,"reason":"结合逐句语速、停顿和实际动作的判断","lastMeaningfulActionSecond":0},"evidence":[{"source":"frame或asr","reference":"实际编号或时刻","finding":"实际观察"}]}。
剧本：\${shot_script}
实际音视频采证：\${video_evidence}
无剧本逐帧观察：\${media_observations}
`

// Exact schema89 body is retained only to migrate already persisted editable gates.
export const LEGACY_IDLE_TAIL_EDIT_CODE = String.raw`
const warnings = [...(review.warnings ?? [])];
let tailTrim = null;
const idleTailSeconds = e.duration - pacing.lastMeaningfulActionSecond;
const pacingBlockedElsewhere = (review.speechChecks ?? []).some(row => row.assessment === 'slow')
  || (context.media_metrics?.speech ?? []).some(row => row.timingAssessment !== 'within-allowance')
  || (pacing.performanceChecks ?? []).some(row => row.status === 'incomplete');
const trimmableIdleTail = idleTailSeconds > params.maxIdleTailSeconds && !pacingBlockedElsewhere;
if (trimmableIdleTail) {
  const substantiveComplaint = /道具|持物|扇|笏|人物|台词|字幕|音轨|画幅|时长|离场|位置|缺失|不符|矛盾|越权|未完成|未发生|不一致/;
  const tailOnlyComplaint = text => !substantiveComplaint.test(String(text)) && /空等|idle|剪辑余量|尾部|收尾|收镜|停机/.test(String(text));
  const trimmedComplaints = issues.filter(text => !tailOnlyComplaint(text));
  issues.filter(tailOnlyComplaint).forEach(text => warnings.push('（尾部空等按剪辑裁尾处理，不购买新视频）' + text));
  if (trimmedComplaints.length !== issues.length) { issues.length = 0; issues.push(...trimmedComplaints); }
  const keptSeconds = Number(Math.min(e.duration, Math.max(pacing.lastMeaningfulActionSecond, speech?.lastSpeechEnd ?? 0) + params.tailSeconds).toFixed(3));
  tailTrim = { keptSeconds, idleSeconds: Number(idleTailSeconds.toFixed(3)), maxIdleTailSeconds: params.maxIdleTailSeconds, evidence: '逐句实际语速均在程序派生 allowedSpan 内且无未完成表演节拍，缺陷只是收尾空等' };
  warnings.push('尾部空等 ' + idleTailSeconds.toFixed(2) + ' 秒超出 ' + params.maxIdleTailSeconds + ' 秒，按剪辑裁尾放行：保留至 ' + keptSeconds + ' 秒，不购买新视频');
} else if (!pacing.passed || idleTailSeconds > params.maxIdleTailSeconds) issues.push('节奏未通过或尾部空等');
`

/** Propose local editing only after every original quality and evidence gate has
 * run. An unapplied proposal must never publish accepted media or buy a retake. */
export const IDLE_TAIL_EDIT_CODE = String.raw`
// media-edit-proposal-v1
const warnings = [...(review.warnings ?? [])];
const tailTrim = null;
const tailEditAssessment = (${deriveIdleTailEdit.toString()})({duration:e.duration,lastMeaningfulActionSecond:pacing.lastMeaningfulActionSecond,
  lastSpeechEnd:speech?.lastSpeechEnd,performanceChecks:pacing.performanceChecks,maxIdleTailSeconds:params.maxIdleTailSeconds,tailSeconds:params.tailSeconds});
const pacingBlockedElsewhere = (review.speechChecks ?? []).some(row => row.assessment === 'slow')
  || (context.media_metrics?.speech ?? []).some(row => row.timingAssessment !== 'within-allowance')
  || (pacing.performanceChecks ?? []).some(row => row.status !== 'observed');
const pendingMediaEdit = tailEditAssessment.edit && !pacingBlockedElsewhere ? {
  ...tailEditAssessment.edit, sourceUrl:e.url || e.originalUrl || context.video_take?.url,
  originalUrl:e.originalUrl || context.video_take?.url, evidenceUrl:e.evidenceUrl,
  lastRequiredSecond:tailEditAssessment.lastRequiredSecond, idleSeconds:tailEditAssessment.idleSeconds,
  reason:'实际动作、已观察表演与ASR全部结束后仍有超预算空等；保留原素材，实施通用裁尾后重新采证'} : null;
if (!pendingMediaEdit && (!pacing.passed || tailEditAssessment.idleSeconds > params.maxIdleTailSeconds)) issues.push('节奏未通过或尾部空等');
// /media-edit-proposal-v1
`;

export const IDLE_TAIL_FINAL_DECISION_CODE = String.raw`
// media-edit-required-v1
if (pendingMediaEdit && issues.length === 0) throw Error('MEDIA_EDIT_REQUIRED: ' + JSON.stringify(pendingMediaEdit));
// /media-edit-required-v1
const passed = review.passed && issues.length === 0;`.trim();

export const MEDIA_ACCEPT_CODE = String.raw`
const e = context.video_evidence, review = context.media_review, shot = context.shot_script;
const observations = context.media_observations;
const invalid = reason => { throw Error('REVIEW_RESULT_INVALID: ' + reason); };
if (!e?.decoded || !e.evidenceUrl) invalid('缺少真实采证');
if (!Array.isArray(observations?.frames) || observations.frames.length !== e.frames.length
  || observations.frames.some((r,i) => r.index !== i || !Array.isArray(r.people) || typeof r.setting !== 'string') || !observations.tailObservation) invalid('逐帧观察不完整');
if (!review || typeof review.passed !== 'boolean' || !['accepted','rejected','uncertain'].includes(review.decision)
  || !Array.isArray(review.issues) || !Array.isArray(review.evidence) || !review.evidence.length
  || !Array.isArray(review.endCharacters) || !review.endingState?.trim()) invalid('审查报告结构不完整');
if (review.decision === 'uncertain') invalid('证据不足，补充采证或重跑审查；不能因此购买新视频');
if (review.passed !== (review.decision === 'accepted') || (review.passed && review.issues.length)) invalid('判定与问题列表矛盾');
const closure = review.narrativeClosure, pacing = review.pacingReview;
if (!closure || closure.unitId !== shot.storyProgress?.unitId || typeof closure.complete !== 'boolean'
  || !closure.actionEvidence?.trim() || !closure.responseEvidence?.trim() || !Array.isArray(closure.unresolvedActions)
  || !Array.isArray(closure.criteriaChecks) || closure.criteriaChecks.length !== shot.completionCriteria?.length
  || shot.completionCriteria.some(c => closure.criteriaChecks.filter(x => x.criterion === c).length !== 1)
  || closure.criteriaChecks.some(c => !['complete','incomplete','unobservable'].includes(c.status) || !c.evidence?.trim())
  || !pacing || typeof pacing.passed !== 'boolean' || !pacing.reason?.trim()
  || !Number.isFinite(pacing.lastMeaningfulActionSecond) || pacing.lastMeaningfulActionSecond < 0 || pacing.lastMeaningfulActionSecond > e.duration) invalid('剧情或节奏证据不完整');
if (shot.storyProgress.status === 'complete' && closure.criteriaChecks.some(c => c.status === 'unobservable')) invalid('剧情完成条件证据不足');
const issues = [...review.issues];
if (Math.abs(e.duration - shot.duration) > params.durationTolerance) issues.push('实际时长不符：' + e.duration);
if (Math.abs(e.width / e.height - params.aspectWidth / params.aspectHeight) > params.aspectTolerance) issues.push('实际画幅不符');
if (!e.hasAudio || e.meanVolumeDb === null || e.meanVolumeDb < params.minVolumeDb) issues.push('无真实有效音轨');
const speech = e.speechValidation;
if (!speech || !Number.isFinite(speech.phoneticErrorRate) || speech.phoneticErrorRate > params.maxPhoneticErrorRate) issues.push('实际对白缺失或内容错误');
if (speech) {
  if (!Number.isFinite(speech.lastSpeechEnd) || speech.lastSpeechEnd <= 0 || speech.lastSpeechEnd > e.duration - params.tailSeconds + params.timingTolerance) issues.push('人声结束时间不满足剪辑余量');
  if (!Array.isArray(speech.alignment) || speech.alignment.length !== context.media_request.speechWindows.length) invalid('台词无法可靠对齐');
  let end = -1;
  for(const row of speech.alignment) {
    if(!Number.isFinite(row.actualStart) || !Number.isFinite(row.actualEnd) || row.actualEnd <= row.actualStart || row.actualStart < end - params.timingTolerance) invalid('实际台词顺序证据不完整');
    end = row.actualEnd;
  }
}
if (e.firstFrameDifference !== undefined && e.firstFrameDifference > params.maxFirstFrameDifference) issues.push('续接首帧偏离前镜实际尾帧');
if (JSON.stringify([...review.endCharacters].sort()) !== JSON.stringify([...shot.endCharacters].sort())) issues.push('实际尾帧角色不完整');
if (shot.storyProgress.status === 'complete' && (!closure.complete || closure.unresolvedActions.length || closure.criteriaChecks.some(c => c.status !== 'complete'))) issues.push('动作与对手回应未完成');
if (!pacing.passed || e.duration - pacing.lastMeaningfulActionSecond > params.maxIdleTailSeconds) issues.push('节奏未通过或尾部空等');
const passed = review.passed && issues.length === 0;
if (!passed && !issues.length) invalid('拒绝但未提供实际问题');
return { ...e, passed, issues, retryPrompt: [review.retryPrompt, ...issues].filter(Boolean).join('\n'),
  visualReview: { ...review, passed, issues, observations: observations.frames, scope:'sampled-frames', lipSyncVerified:false,
    endingStateEvidence:{method:'actual-tail-image',frame:e.lastFrameUrl} },
  technicalValidation: {passed, speechVerified: passed && !!speech, scope:'decoded-media', visualContinuityVerified:false},
  extractedLastFrameUrl:e.lastFrameUrl, audioEmbedded:e.hasAudio, raw:context.video_take };
`

type Node = { id: string; title: string; kind: string; resultVar: string; prompt: string; modelId?: string; params: Array<{id:string;name:string;englishName?:string;type:string;required:boolean;value:string}>; uploads: unknown[]; loop: {enabled:boolean;sourcePath:string;fallbackCount:number;itemVar:string}; position: {x:number;y:number}; parentId?:string;childIds?:string[];operation?:string;code?:string;outputMode?:string; runIf?:{path:string;equals:unknown}; request?:{url:string;method:'POST'|'GET'};acceptance?:AcceptancePolicy;errorRetry?:ErrorRetryPolicy;captureTail?:boolean;mapInput?:{sourcePath:string;itemVar:string;maxItems?:number;concurrency?:number} }
type Workflow<N extends Node> = {id:string;schemaVersion?:number;nodes:N[];edges:Array<{id:string;from:string;to:string}>}
const p = (name:string, value:string, type='json', required=true) => ({id:'qa-'+name,name,englishName:name,type,required,value})
export function upgradeConfigurableQuality<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) >= 60) return workflow
  const video = workflow.nodes.find(n=>n.id==='sanguo-video')
  if (!video) return workflow
  const common = {uploads:[], loop:{enabled:false,sourcePath:'',fallbackCount:1,itemVar:'item'},parentId:video.parentId}
  const node = (id:string, title:string, kind:string, resultVar:string, prompt:string, extra:Partial<Node> = {}):N => ({...common,id,title,kind,resultVar,prompt,params:[],position:{x:3730,y:60},...extra}) as N
  const nodes = [
    node('sanguo-media-request','采证参数整理','code','media_request','从分镜配置提取逐句时间窗。',{code:VIDEO_REQUEST_CODE}),
    node('sanguo-video-evidence','音视频实际采证','http','video_evidence','下载实际视频、解码、抽帧和本地 ASR，只输出证据。',{
      request:{url:'/api/video-evidence',method:'POST'},params:[p('url','${video_take.url}','text'),p('audioText','${media_request.audioText}','text'),p('speechWindows','${media_request.speechWindows}'),p('latestSpeechEnd','${media_request.latestSpeechEnd}','number'),p('previousTail','${first_frame.url}','text',false)]}),
    node('sanguo-media-observe','独立画面观察','text','media_observations',MEDIA_OBSERVATION_PROMPT,{modelId:'claude-opus-4-8',outputMode:'json',params:[p('reviewImages','${video_evidence.frames}'),p('temperature','0','number')]}),
    node('sanguo-media-review','成片质量推理','text','media_review',MEDIA_REVIEW_PROMPT,{modelId:'claude-opus-4-8',outputMode:'json',params:[p('minSpeechRate','3.3','number'),p('shortPauseSeconds','0.15','number'),p('sentencePauseSeconds','0.25','number'),p('timingToleranceSeconds','0.25','number'),p('maxIdleTailSeconds','1.2','number'),p('temperature','0','number')]}),
    node('sanguo-media-accept','验收与自动重试','code','video_shot','报告有效且通过才发布成片；明确拒绝则按配置回退重拍。证据不足或执行异常停止在当前节点。',{
      code:MEDIA_ACCEPT_CODE,acceptance:{passedPath:'passed',retryFrom:'sanguo-video',maxAttempts:4,feedbackPath:'retryPrompt'},
      params:[p('durationTolerance','.5','number'),p('aspectWidth','16','number'),p('aspectHeight','9','number'),p('aspectTolerance','.04','number'),p('minVolumeDb','-50','number'),p('maxPhoneticErrorRate','.2','number'),p('tailSeconds','.3','number'),p('timingTolerance','.25','number'),p('maxFirstFrameDifference','.1','number'),p('maxIdleTailSeconds','1.2','number')]}),
  ]
  nodes.forEach((n,i)=>{n.position={x:3730+i*280,y:60}})
  const ids=nodes.map(n=>n.id)
  const result=workflow.nodes.flatMap(n=>n.id===video.id ? [{...n,resultVar:'video_take',captureTail:false,
    params:[...n.params,p('multiShot','false','boolean'),p('initialCharacters','${shot_script.initialCharacters}')],
    prompt:n.prompt+'\n以自然语速完整说出台词，逗号短停；不要宣诏式拖腔。动作与对白可同时进行，回应完成即结束，仅留0.3秒剪辑余量。人物不要转向镜头摆拍。'} as N,...nodes] : [{...n,
    ...(n.childIds?.includes(video.id)?{childIds:n.childIds.flatMap(id=>id===video.id?[id,...ids]:[id])}:{}),
    ...(n.id==='sanguo-last-frame'?{position:{x:5130,y:60}}:n.id==='sanguo-verify'?{position:{x:5410,y:160}}:n.id==='sanguo-compose'?{position:{x:5690,y:160}}:{})}])
  const chain=[video.id,...ids,'sanguo-last-frame'];
  return {...workflow,schemaVersion:60,nodes:result,edges:[...workflow.edges.filter(e=>!(e.from===video.id&&e.to==='sanguo-last-frame')),...chain.slice(1).map((to,i)=>({id:'qa-'+chain[i]+'-'+to,from:chain[i],to}))]}
}

export const SOURCE_QUOTE_REVIEW_PROMPT = `【史料引文复制规则 v1】
本规则仅用于兼容旧式 citationIndex+quote 的最外层史实 evidence；采用 sourceSpanId 时由程序回填引文，不要重打 quote。dramaturgyReview.evidence 仍引用候选声画。
每条史实 evidence.quote 必须直接复制当前史料正文中一个连续短片段，至少4字，建议4–30汉字。采用编号正文输入时，原文在 sources[].numberedText，片段标记不属于原文；citationIndex 使用对应来源的实际序号。旧式输入则取 historical_sources.citations[citationIndex-1].content；不能按记忆或其他编号填写。
先找到支持判断的原文位置，再复制引文；不要先写摘要再为摘要配来源。不能把 candidate.historicalBasis、requiredBeats、来源标题或摘要当正文；不能默写、改写、简繁转换、替换词语、调整语序、拼接不相邻句子或用省略号合并引文。保留原文用字与片段内标点。
一个判断需要多处原文时，拆成多条 evidence，每条复制一个连续片段，可重复同一 itemId/citationIndex；把解释、推断和拟制边界写在 supports，绝不写进 quote。短引文只解决定位，不降低史实审核要求；每项复杂判断仍须有足够原文支持。
提交前逐条检查：quote 能否在所选 content 中原样连续找到，itemId 是否属于当前候选，引用是否确实支持 supports。找不到支持时如实保留疑问或指出实际错误，不得伪造引文，也不得为了通过而改写候选。审核结论由内容与证据决定，不预设 passed。
【史料引文复制规则结束】`;

/** Refresh one bounded instruction block while preserving custom reviewer text. */
export function refreshScriptReviewSourceQuotes(prompt: string) {
  const start = '【史料引文复制规则 v1】', end = '【史料引文复制规则结束】';
  if (!prompt.includes(start)) return prompt + '\n' + SOURCE_QUOTE_REVIEW_PROMPT;
  if (!prompt.includes(end)) throw Error('Cannot safely refresh incomplete source-quote instruction block');
  return prompt.replace(/【史料引文复制规则 v1】[\s\S]*?【史料引文复制规则结束】/g, SOURCE_QUOTE_REVIEW_PROMPT);
}

export const SOURCE_SPAN_REVIEW_PROMPT = `【史料片段编号与审核覆盖 v1】
程序从当前真实史料和候选生成的完整编号正文及逐场逐人清单：\${history_source_review}
sources 包含全部来源的 citationIndex、title、url 和 numberedText。numberedText 无损保留每字原文，仅在可引用片段两侧插入 ⟦片段id⟧原文⟦/⟧；标记不是史料。通读完整上下文后判断 supports，不能忽略片段外的短句、否定词或其它来源的冲突证据。
最外层事实 evidence 优先返回 {"itemId":"当前场景id","sourceSpanId":"从sources[].numberedText的⟦片段id⟧标记内原样复制的id","supports":"该原文片段支持本场什么事实，及拟制边界"}，不要重打 quote/citationIndex，程序将从当前实际史料回填；编号不存在、已过期或附带引文冲突均会拒绝。此格式替代上文旧式事实 evidence 示例；dramaturgyReview 的声画证据不接受 itemIds 共享，仍按上方叙事审核块的 itemId 单场逐字引用与 uncovered 逐场声明执行。
同一原文确实支持多场时，可以显式返回 {"itemIds":["scene-01","scene-02"],"sourceSpanId":"实际片段id","supports":"共同支持的具体事实"}，程序逐场展开；itemId 与 itemIds 不得同时出现。必须覆盖 expectedCoverage 中每一个 itemId，不能只为第一场给引证，不能让程序猜测某项证据适用于哪些场。itemIds 共享只适用于最外层事实 evidence；dramaturgyReview 的声画证据仍只接受 itemId 单场逐字引用，连续短段的缺证必须走 dramaturgyReview.uncovered 显式声明承担者。
通过报告的 checks 必须对 expectedCoverage 中每个 (itemId,character) 恰好一项，包含 startingState、finalActionState、requestedEndState、canExecuteAsWritten。无台词、只倾听、静候的人物仍在检查范围，按候选如实写出状态，不得捏造动作来填表。拒绝报告应给明确问题及其证据，不要求替道具编造人物检查。
有前镜时，第一帧承接前镜实际尾帧状态；此后当前候选明确已写的新动作可以改变姿态，包括重新抬起已放下的手。检查是否写出可执行的动作过程，不能把前镜姿态当作本镜全程不可改变的约束，也不能把旧审核报告里的旧计划当作实测状态。
单镜不必重复承担已由前镜完成的人物关系或处境交代。若本镜无需新交代，dramaturgyReview.orientation 可如实给 not_applicable 和具体理由；payoff、dramaticProgression、characterDistinction 同理，本候选未分配该义务时四项都应当如实给 not_applicable，而不是 passed 配空 evidenceRefs。如判 passed，仍必须给当前候选中真实有效的 evidenceRefs；同一条 evidence 索引允许被多个分项复用，证据条数少于分项数属正常，不需为每个分项另造新证据。不得为了凑证据虚构交代，也不得预设结论。
提交前逐行核对完整清单：每场至少一项事实 evidence；通过时每场每个在场人物都有 checks；dramaturgyReview 每场要么有 evidence 声画落点、要么在 uncovered 逐场声明 {itemId,reason,coveredBy}（coveredBy 是同一场完整戏内已有落点的另一短段），且每个 dramaticSceneId 至少一条落点。supports 是解释，不是引文。不能为填满清单而预设通过；有证据的史实/因果/叙事问题仍须拒绝，风格偏好仍只作建议。
【史料片段编号与审核覆盖结束】`;

export function refreshHistoricalSourceReviewPrompt(prompt: string) {
  const base = refreshScriptReviewSourceQuotes(prompt).replace(/^史料：[ \t]*\$\{historical_sources\.citations\}[ \t]*$/gm, '史料：全部可引用原文及完整上下文见下方 sources[].numberedText，来源信息见同一 sources；片段标记不是原文。'), start = '【史料片段编号与审核覆盖 v1】', end = '【史料片段编号与审核覆盖结束】';
  if (!base.includes(start)) return base + '\n' + SOURCE_SPAN_REVIEW_PROMPT;
  if (!base.includes(end)) throw Error('Cannot safely refresh incomplete source-span prompt block');
  return base.replace(/【史料片段编号与审核覆盖 v1】[\s\S]*?【史料片段编号与审核覆盖结束】/g, SOURCE_SPAN_REVIEW_PROMPT);
}

export const SCRIPT_REVIEW_PROMPT = refreshScriptReviewSourceQuotes(`独立审核候选内容，不替生成器省略、改写错误后判通过。检查史料引用是否支持剧情，拟制对白是否标注边界，剧情动作与回应是否完整，人物身份和服装是否沿用既有参考。逐镜逐人推演已写动作，区分期望尾帧和动作实际可达到状态；已收回的手不能无动作又伸出。若提供前镜实际尾帧，只按可见实际状态检查开场，不能重演已完成动作。普通呼吸、闭口、眼神、轻微站位变化不必逐个写步骤，不能臆造隐含矛盾。审查意见必须引用原文与来源，不把“无矛盾”放入 issues。
只返回 JSON {"passed":true或false,"issues":[{"problem":"原文中的明确问题","repair":"保留剧情台词的局部修复"}],"evidence":[{"citationIndex":1,"quote":"来源原句","supports":"支持的具体事实"}],"checks":[{"itemId":"候选镜头或场景id","character":"人物全名","startingState":"起始状态","finalActionState":"只按已写动作到达的状态","requestedEndState":"目标状态","canExecuteAsWritten":true或false}]}。
候选：\${params.candidate}
史料：\${historical_sources.citations}
场景：\${scene}
前镜实际尾帧状态：\${loop.previous.actualTailEvidence}
前镜分镜：\${loop.previous.shot_script}
`)
export const SCRIPT_ACCEPT_CODE = String.raw`
const candidate = params.candidate, review = params.review;
const items = candidate.scenes || [candidate];
if (!review || typeof review.passed !== 'boolean' || !Array.isArray(review.issues) || !Array.isArray(review.evidence) || !review.evidence.length || !Array.isArray(review.checks)) throw Error('REVIEW_RESULT_INVALID: 缺少内容审核证据');
for (const item of items) for (const character of item.characters || item.cast || []) {
  const checks = review.checks.filter(c => c.itemId === item.id && c.character === character);
  if(checks.length !== 1 || typeof checks[0].canExecuteAsWritten !== 'boolean' || !checks[0].finalActionState || !checks[0].requestedEndState) throw Error('REVIEW_RESULT_INVALID: 缺少逐人动作审核证据');
}
if (review.passed && (review.issues.length || review.checks.some(c => !c.canExecuteAsWritten))) throw Error('REVIEW_RESULT_INVALID: 判定与证据矛盾');
if (!review.passed && !review.issues.length) throw Error('REVIEW_RESULT_INVALID: 未给出局部修复问题');
return {...candidate, passed:review.passed, issues:review.issues, contentReview:review};
`

export function upgradeIndependentScriptReviews<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if(workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) >= 61) return workflow
  let nodes = workflow.nodes;
  let edges = workflow.edges;
  for(const [writerId, candidateVar, resultVar] of [['sanguo-scene-outline','outline_candidate','scene_outline'],['sanguo-shot-script','shot_candidate','shot_script']]) {
    const writer = nodes.find(n=>n.id===writerId);
    if(!writer) continue;
    const reviewId=writerId+'-review', gateId=writerId+'-accept';
    const common={uploads:[],loop:{enabled:false,sourcePath:'',fallbackCount:1,itemVar:'item'},parentId:writer.parentId};
    const review={...common,id:reviewId,title:writerId==='sanguo-shot-script'?'分镜内容与动作推理':'大纲史料与剧情推理',kind:'text',operation:'history.script-review',resultVar:resultVar+'_review',modelId:writer.modelId,
      outputMode:'json',prompt:SCRIPT_REVIEW_PROMPT,params:[p('candidate','${'+candidateVar+'}'),p('temperature','0','number')],position:{x:writer.position.x,y:writer.position.y+200}} as unknown as N;
    const gate={...common,id:gateId,title:'内容验收与重试',kind:'code',resultVar,prompt:'只有完整的独立内容审核报告可发布候选，明确拒绝回退生成器。',code:SCRIPT_ACCEPT_CODE,
      acceptance:{passedPath:'passed',retryFrom:writerId,maxAttempts:3,feedbackPath:'issues'},params:[p('candidate','${'+candidateVar+'}'),p('review','${'+resultVar+'_review}')],position:{x:writer.position.x+280,y:writer.position.y+200}} as unknown as N;
    nodes=nodes.flatMap(n=>n.id===writerId?[{...n,resultVar:candidateVar},review,gate]:[{...n,...(n.childIds?.includes(writerId)?{childIds:n.childIds.flatMap(id=>id===writerId?[id,reviewId,gateId]:[id])}:{})}]);
    edges=edges.map(e=>e.from===writerId?{...e,from:gateId}:e).concat([{id:writerId+'-review-edge',from:writerId,to:reviewId},{id:writerId+'-accept-edge',from:reviewId,to:gateId}]);
  }
  return {...workflow,schemaVersion:61,nodes,edges};
}

export const IMAGE_REVIEW_PROMPT = `审核附件中的人物定妆三视图。附件与资产列表一一对应，每张图应为同一个人物按正面、90度侧面、背面在一行三列展示，完整全身，身份、须发、服装一致。禁止上下两排、宫格、重复正面、裁切、剧情场景。纯色背景、中性站姿是正确要求。对照明确的年龄大类、性别、胡须、衣袍主色/款式和冠帽形状；自然色差不拒绝。东汉人物拒绝明显清式成排盘扣等时代错误。不臆造设计未禁止的细节。
返回 JSON {"passed":true或false,"issues":["具体资产、可见问题和修复"],"items":[{"characterName":"原姓名","passed":true或false,"appearance":"80至200字实际可见的稳定外观，不写动作场景或猜精确年龄","issues":[],"evidence":"对应图片实际布局和外观证据"}]}。
候选与图片对应：\${character_image_evidence.items}
目标设计：\${character_portraits.characters}
`
export const NEUTRAL_THREE_VIEW_GENERATION_TEMPLATE = '{{character.designPrompt}}。稳定外观：{{character.description}}。同一人物正面、90度侧面、背面一行三列，完整全身、同身份同服装、真人电影质感、纯色背景，无文字无水印。三个视角均直立且双臂自然下垂，双手低于腰部并远离脸和胸口，嘴鼻眼下巴完全无遮挡。禁止念咒、指唇、掩嘴、托腮、持物、结印、挥手、剧情动作、上下排版和宫格。具体修复：{{feedback}}'
export const IMAGE_ACCEPT_CODE = String.raw`
const candidate=context.character_candidates, review=context.character_image_review;
if (!review || typeof review.passed !== 'boolean' || !Array.isArray(review.issues) || !Array.isArray(review.items)) throw Error('REVIEW_RESULT_INVALID: 图片审核报告缺失');
const items=candidate.items.map(item=>{
 const rows=review.items.filter(r=>r.characterName===item.characterName);
 if(rows.length!==1 || typeof rows[0].passed!=='boolean' || !Array.isArray(rows[0].issues) || String(rows[0].appearance||'').length<20 || !rows[0].evidence) throw Error('REVIEW_RESULT_INVALID: 缺少具名图片证据');
 const r=rows[0];return {...item,metadata:{...item.metadata,quality:r,visualProfile:{appearance:r.appearance,scope:'independent-image-review',referenceImage:context.character_image_evidence.items.find(e=>e.characterName===item.characterName)?.referenceImage}}};
});
if(review.items.length!==items.length || (review.passed && (review.issues.length || review.items.some(r=>!r.passed || r.issues.length)))) throw Error('REVIEW_RESULT_INVALID: 图片报告矛盾');
if(!review.passed && !review.issues.length) throw Error('REVIEW_RESULT_INVALID: 缺少重拍意见');
return {...candidate,items,passed:review.passed,issues:review.issues};
`
export function upgradeIndependentImageReviews<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if(workflow.id!=='wf-sanguo-history-drama' || (workflow.schemaVersion??0)>=62)return workflow;
  const writer=workflow.nodes.find(n=>n.id==='sanguo-character-image');if(!writer)return workflow;
  const common={uploads:[],loop:{enabled:false,sourcePath:'',fallbackCount:1,itemVar:'item'},parentId:writer.parentId,runIf:{path:'character_lookup.shouldGenerate',equals:true}};
  const evidence={...common,id:'sanguo-character-evidence',title:'人物图片采证',kind:'http',resultVar:'character_image_evidence',prompt:'解码图片并提供独立推理附件。',request:{url:'/api/image-evidence',method:'POST'},params:[p('items','${character_candidates.items}')],position:{x:2330,y:260}} as unknown as N;
  const review={...common,id:'sanguo-character-review',title:'人物三视图质量推理',kind:'text',resultVar:'character_image_review',modelId:'claude-opus-4-8',outputMode:'json',prompt:IMAGE_REVIEW_PROMPT,params:[p('reviewImages','${character_image_evidence.reviewImages}'),p('temperature','0','number')],position:{x:2610,y:260}} as unknown as N;
  const gate={...common,id:'sanguo-character-accept',title:'人物图片验收与重试',kind:'code',resultVar:'character_assets',prompt:'明确拒绝回退图片生成；验收通过后才允许入库。',code:IMAGE_ACCEPT_CODE,acceptance:{passedPath:'passed',retryFrom:writer.id,maxAttempts:3,feedbackPath:'issues'},params:[],position:{x:2890,y:260}} as unknown as N;
  const added=[evidence,review,gate];
  const generationTemplate=NEUTRAL_THREE_VIEW_GENERATION_TEMPLATE;
  const nodes=workflow.nodes.flatMap(n=>n.id===writer.id?[{...n,resultVar:'character_candidates',params:[...n.params.filter(p=>!['validateThreeView','maxGenerationAttempts','fallbackModelId'].includes(p.englishName??'')),p('validateThreeView','false','boolean'),p('deferArchive','true','boolean'),p('generationPromptTemplate',generationTemplate,'text'),p('retryFeedback','${retry.feedback}','text',false)]},...added]:[{...n,...(n.childIds?.includes(writer.id)?{childIds:n.childIds.flatMap(id=>id===writer.id?[id,...added.map(a=>a.id)]:[id])}:{})}]);
  const chain=[writer.id,...added.map(n=>n.id)];
  return {...workflow,schemaVersion:62,nodes,edges:[...workflow.edges.map(e=>e.from===writer.id?{...e,from:gate.id}:e),...chain.slice(1).map((to,i)=>({id:'image-qa-'+i,from:chain[i],to}))]};
}

export function upgradeReviewRecovery<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) >= 63) return workflow
  const starts:Record<string,string>={'sanguo-media-accept':'sanguo-media-observe','sanguo-character-accept':'sanguo-character-review','sanguo-shot-script-accept':'sanguo-shot-script-review','sanguo-scene-outline-accept':'sanguo-scene-outline-review'}
  return {...workflow,schemaVersion:63,nodes:workflow.nodes.map(n=>starts[n.id]?{...n,errorRetry:{retryFrom:starts[n.id],maxAttempts:2,patterns:['REVIEW_RESULT_INVALID:']}}:n)}
}

export const MEDIA_METRICS_CODE = String.raw`
const policy={...params}, evidence=context.video_evidence, shot=context.shot_script;
const speech=(evidence.speechMetrics || []).map(row=>{
 const pauseAllowance=row.shortPauses*policy.shortPauseSeconds+row.sentencePauses*policy.sentencePauseSeconds;
 const allowedSpan=row.characters/policy.minSpeechRate+pauseAllowance+policy.timingToleranceSeconds;
 return {...row,pauseAllowance,allowedSpan,excessSeconds:row.elapsed-allowedSpan,
   timingAssessment:row.elapsed>allowedSpan?'outside-allowance':'within-allowance'};
});
return {policy,speech,unitCompletionRequired:shot.storyProgress.status==='complete',deferredActions:shot.storyProgress.pendingActions,
 currentActionTimeline:shot.videoPrompt,unitCriteria:shot.completionCriteria};
`
export function upgradeReviewEvidenceScope<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=64)return workflow;
  const evidence=workflow.nodes.find(n=>n.id==='sanguo-video-evidence');if(!evidence)return workflow;
  const metrics={...evidence,id:'sanguo-media-metrics',title:'验收口径与语速预算',kind:'code',resultVar:'media_metrics',request:undefined,prompt:'计算含标点停顿与ASR边界误差的逐句预算，并明确本镜与后续镜头的目标。只计算证据，不替模型作艺术判断。',code:MEDIA_METRICS_CODE,
    params:[p('minSpeechRate','3.3','number'),p('shortPauseSeconds','.15','number'),p('sentencePauseSeconds','.25','number'),p('timingToleranceSeconds','.25','number'),p('maxIdleTailSeconds','1.2','number')],position:{x:evidence.position.x,y:260}} as unknown as N;
  const scopePrompt='\n【本流程的唯一数值与剧情范围口径】${media_metrics}\n逐句allowedSpan已含标点停顿和ASR容差，禁止另算一个不含容差的门槛。within-allowance不构成语速过慢证据，不得把相同时间戳再次算作明显拖慢；outside-allowance仍须结合对齐可信度判断。输出speechChecks数组，每句一项 {text:原句,assessment:natural或slow或uncertain,reason:具体证据}。\nunitCompletionRequired=false代表当前单元尚在进行；deferredActions是明确计划后续镜头完成的动作。未在本镜执行这些后续动作属于正确分镜安排，不得列issues，也不能要求提前拍完。criteriaChecks仍如实记为incomplete，但仅审核currentActionTimeline中的本镜承诺是否完成。unitCompletionRequired=true时才要求全部原单元条件完成。';
  const gateCheck=String.raw`
const computed=context.media_metrics;
review.speechChecks = review.speechChecks || review.pacingReview?.speechChecks;
if(!computed || !Array.isArray(review.speechChecks) || review.speechChecks.length!==computed.speech.length) invalid('缺少逐句语速复核');
for(const row of computed.speech){
 const check=review.speechChecks.find(c=>c.text===row.text);
 if(!check || !['natural','slow','uncertain'].includes(check.assessment) || !check.reason) invalid('缺少逐句语速证据');
 if(check.assessment==='uncertain') invalid('ASR边界或对齐证据不足，复核同一素材');
 if(check.assessment==='slow' && row.timingAssessment==='within-allowance') invalid('语速误判：'+row.text+'实际'+row.elapsed+'秒，含停顿及容差上限'+row.allowedSpan+'秒；不能漏算容差后拒绝');
}
`;
  const nodes=workflow.nodes.flatMap(n=>n.id===evidence.id?[n,metrics]:[{...n,
    ...(n.id==='sanguo-media-review'?{prompt:n.prompt.replace(/语速参考下限为[\s\S]*?逐词概率低/, '逐词概率低').replace(/尾部空等参考上限[^秒]+秒。/,'尾部空等参考上限见验收口径。')+scopePrompt,params:n.params.filter(p=>p.englishName==='temperature')}:{}),
    ...(n.id==='sanguo-media-accept'?{code:n.code!.replace('const issues = [...review.issues];',gateCheck+'\nconst issues = [...review.issues];')}:{}),
    ...(n.childIds?.includes(evidence.id)?{childIds:n.childIds.flatMap(id=>id===evidence.id?[id,metrics.id]:[id])}:{})}]);
  return {...workflow,schemaVersion:64,nodes,edges:[...workflow.edges.map(e=>e.from===evidence.id?{...e,from:metrics.id}:e),{id:'qa-evidence-metrics',from:evidence.id,to:metrics.id}]};
}

export function upgradeReviewPrompt<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=65)return workflow;
  return {...workflow,schemaVersion:65,nodes:workflow.nodes.map(n=>n.id==='sanguo-media-review'?{...n,prompt:MEDIA_REVIEW_FINAL_PROMPT}:n.id==='sanguo-media-accept'?{...n,code:n.code!.replace('if(!computed || !Array.isArray(review.speechChecks)', 'review.speechChecks = review.speechChecks || review.pacingReview?.speechChecks;\nif(!computed || !Array.isArray(review.speechChecks)')}:n)}
}
export const MEDIA_REVIEW_FINAL_PROMPT = `独立验收此镜，只依据实际 ASR、数值预算和无剧本抽帧观察；计划只定义目标，不能作为事实证据。
判定规则：
1. 逐句按照 media_metrics.speech 中已计算的 allowedSpan 评估。它已经包含标点停顿和 ASR 边界容差，within-allowance 不构成拖慢证据。ASR 词概率不是语速、发音错误或拖腔证据，同音字识别也不是错词。不得因低概率推断拖腔。outside-allowance 结合可靠对齐证据评估；明显连续拖慢不能放行。
2. unitCompletionRequired=false 时，deferredActions 是明确留给后续镜头的动作，不得要求本镜提前完成，不得列作 issues。criteriaChecks 如实记 incomplete，但整段剧情尚未完成不影响本镜通过。只验当前时间轴的核心动作与回应。unitCompletionRequired=true 才要求全部单元条件完成。
3. 核对角色、实际物件归属、核心动作、时代、尾帧人物。拒绝有证据的错误道具或凭空增减，保留自然微差。微向前倾、细微眼神、手指姿态等不能可靠观测的细节不得列 issues。未观察到不等于没有发生。姓名按服装与身份线索匹配，不能按数组顺序猜左右。
4. 结尾状态只根据最后一帧的独立观察。最后有意义动作时刻须来自 ASR 或实际抽帧，不能抄计划。不得声称已检验逐帧口型。缺证据应 uncertain，不能用重拍解决审查故障。
5. retryPrompt 仅修正明确问题，完整保留原人物、台词和剧情，不加新的精细姿态约束。issues 仅包含当前实质问题，不含已经自我纠正的误判。
仅返回下面一个 JSON 对象；speechChecks 放最外层：
{"decision":"accepted/rejected/uncertain","passed":true或false,"issues":["具体问题与证据"],"warnings":[],"retryPrompt":"明确重拍建议","speechChecks":[{"text":"计划原句","assessment":"natural/slow/uncertain","reason":"实际跨度与allowedSpan比较"}],"endingState":"汉字全名与实际尾帧状态","endCharacters":["尾帧可见全名"],"narrativeClosure":{"unitId":"原单元id","complete":true或false,"actionEvidence":"实际动作证据","responseEvidence":"实际回应证据","unresolvedActions":[],"criteriaChecks":[{"criterion":"原条件逐字","status":"complete/incomplete/unobservable","evidence":"具体帧/音轨证据"}]},"pacingReview":{"passed":true或false,"reason":"基于数值预算与实际动作","lastMeaningfulActionSecond":0},"evidence":[{"source":"frame/asr","reference":"实际编号/时刻","finding":"实际观察"}]}。
验收数值和本镜范围：\${media_metrics}
本镜目标：\${shot_script}
实际音视频证据：\${video_evidence}
无剧本逐帧观察：\${media_observations}
`

export function upgradePerFrameObservations<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=66)return workflow;
  const nodes=workflow.nodes.map(n=>n.id==='sanguo-media-metrics'?{...n,code:n.code!.replace('return {policy,speech,','return {frames:evidence.frames.map((url,index)=>({url,index,second:evidence.frameTimes[index]})),policy,speech,')}
    :n.id==='sanguo-media-observe'?{...n,mapInput:{sourcePath:'media_metrics.frames',itemVar:'frame',maxItems:24},prompt:FRAME_OBSERVATION_PROMPT,params:[p('reviewImages','["${frame.url}"]'),p('temperature','0','number')]}
    :n.id==='sanguo-media-review'?{...n,prompt:n.prompt+'\n必须逐人逐帧审核道具：输出最外层 visualChecks 数组，每位人物一项 {character:原全名,consistent:true或false,expectedObjects:剧本要求,actualObjectsByFrame:[{index:帧编号,objects:该人物实际持物}],evidence:具体一致或矛盾证据}。每个人必须覆盖所有采样帧。未计划的扇子、笏板、权杖、剧情道具属于实质错误，即使后续帧没有观察到，也不能忽略第一帧明确持物。出现或消失必须有已写动作，不得脑补收起以放行。consistent=false必须拒绝。'}
    :n.id==='sanguo-media-accept'?{...n,code:n.code!.replace('const observations = context.media_observations;', 'const mapped=context.media_observations; const observations = mapped.items ? {frames:mapped.items,tailObservation:mapped.items.at(-1)?.tailObservation} : mapped;').replace('const issues = [...review.issues];',String.raw`
if(!Array.isArray(review.visualChecks) || review.visualChecks.length!==shot.characters.length) invalid('缺少逐人道具复核');
for(const name of shot.characters){const check=review.visualChecks.find(c=>c.character===name);
 if(!check || typeof check.consistent!=='boolean' || !check.expectedObjects || !check.evidence || !Array.isArray(check.actualObjectsByFrame) || check.actualObjectsByFrame.length!==e.frames.length || check.actualObjectsByFrame.some((r,i)=>r.index!==i || typeof r.objects!=='string')) invalid('缺少逐帧持物证据');
}
const issues = [...review.issues, ...review.visualChecks.filter(c=>!c.consistent).map(c=>c.character+'道具不符：'+c.evidence)];
`)}:n);
  return {...workflow,schemaVersion:66,nodes};
}
export const FRAME_OBSERVATION_PROMPT = `附件只有一张图片，编号 \${frame.index}，时刻 \${frame.second} 秒。独立观察，不评剧本，不猜人物姓名，不使用其他帧的状态。按左、中、右列出每个可见人物的服装、双手、持物和姿态。仔细检查靠近腰带、袖口、下半身的细长物件或扇柄，不能把物件放低当成空手；看不清明确 unknown，不能默认无。只观察明确可见内容，不臆造历史道具名称，形状、颜色、位置优先。
返回 JSON {"index":\${frame.index},"second":\${frame.second},"setting":"实际场景","people":[{"clothing":"服装身份线索","position":"画面位置","pose":"身体及双手实际状态","heldObjects":"持物形状、颜色、所在位置；明确空手才写无"}],"tailObservation":"忠实描述这张图中每人站位、双手、持物和视线"}。`

const SOURCE_EVIDENCE_CODE = String.raw`
const sources=context.historical_sources?.citations || [];
const normalize=value=>String(value||'').replace(/〈[^〉]*〉/g,'').replace(/[\s。，、；：！？,.;:!?「」『』“”"']/g,'');
for(const item of items){
 const evidence=review.evidence.filter(e=>e.itemId===item.id);
 if(!evidence.length)throw Error('REVIEW_RESULT_INVALID: '+item.id+' 缺少逐场史料引证');
 for(const row of evidence){const quote=normalize(row.quote),source=sources[Number(row.citationIndex)-1];
  if(quote.length<4 || !source || !normalize(source.content).includes(quote))throw Error('REVIEW_RESULT_INVALID: 引文不在对应史料正文中：'+item.id);
 }
}
`;

/** Resolve trusted locators immediately before the unchanged strict quote gate. */
export function refreshHistoricalSourceReviewGateCode(code: string) {
  const oldHeader = 'const candidate = params.candidate, review = params.review;', newHeader = 'const candidate = params.candidate; let review = params.review;';
  const sourceLine = 'const sources=context.historical_sources?.citations || [];';
  const start = '// SOURCE_SPAN_RESOLUTION_START', end = '// SOURCE_SPAN_RESOLUTION_END';
  const block = start + '\n' + HISTORICAL_SOURCE_REVIEW_RUNTIME_CODE + `
review = resolveHistoricalReviewSourceSpans(review, sources);
if (review.evidence.some(row => !items.some(item => item.id === row.itemId))) throw Error("REVIEW_RESULT_INVALID: 史料证据含不属于当前候选的itemId");
const missingSourceEvidence = items.filter(item => !review.evidence.some(row => row.itemId === item.id)).map(item => item.id);
if (missingSourceEvidence.length) throw Error('REVIEW_RESULT_INVALID: 顶层 review.evidence 缺少逐场史料引证：' + missingSourceEvidence.join('、') + '。必须覆盖所有当前候选 id，可用 itemIds 明确共享原文引证；dramaturgyReview.uncovered 仅豁免声画落点，不豁免史料。修正 issues 的 path/quote 时保留两层已有有效 evidence；不得删除场景引证来修复问题项。');
` + end;
  if (!code.includes(oldHeader) && !code.includes(newHeader)) throw Error('Cannot safely locate review declaration; preserve custom gate code');
  if (!code.includes(sourceLine)) throw Error('Cannot safely locate trusted sources; preserve custom gate code');
  let next = code.replace(oldHeader, newHeader);
  if (next.includes(start)) {
    if (!next.includes(end)) throw Error('Cannot safely refresh incomplete source-span gate block');
    next = next.replace(/\/\/ SOURCE_SPAN_RESOLUTION_START[\s\S]*?\/\/ SOURCE_SPAN_RESOLUTION_END/g, block);
  } else next = next.replace(sourceLine, sourceLine + '\n' + block);
  return next;
}
export function upgradeSourceEvidence<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=67)return workflow;
  return {...workflow,schemaVersion:67,nodes:workflow.nodes.map(n=>['sanguo-shot-script-review','sanguo-scene-outline-review'].includes(n.id)?{...n,prompt:n.prompt.replace('"issues":[{"problem"','"issues":[{"itemId":"具体候选id","problem"').replace('"evidence":[{"citationIndex"','"evidence":[{"itemId":"每个场景或镜头id","citationIndex"')+'\n每个候选id至少一项evidence，quote须至少4字并逐字来自对应正文，不得按记忆默写、简繁转换。仅审当前片段任务，不强迫提前完成后续镜头。大纲尚无逐秒分镜，不要求audioText、口型或尾帧。审查行动主体、官职时代、事件因果、歌谣归属、同名角色立场，不能把宾客的行动改为主人的授意；已声明拟制的日常对白和动作不需要史料逐字记载，只拒绝真正违背事实的改编。'}
    :['sanguo-shot-script-accept','sanguo-scene-outline-accept'].includes(n.id)?{...n,acceptance:{...n.acceptance!,feedbackPath:'repairContext'},code:n.code!.replace('for (const item of items)',SOURCE_EVIDENCE_CODE+'\nfor (const item of items)').replace('contentReview:review};','contentReview:review,repairContext:{issues:review.issues,previousCandidate:candidate}};')}
    :['sanguo-shot-script','sanguo-scene-outline'].includes(n.id)?{...n,prompt:n.prompt+'\n若重试反馈包含 previousCandidate，仅修复 issues 指出的具体部分；保留所有未被点名场景、角色、id、原台词与剧情锚点，拆段不得删剧情。'}:n)};
}

export function upgradeQualityWorkflow<N extends Node,W extends Workflow<N>>(workflow:W):W {
  return [upgradeConfigurableQuality,upgradeIndependentScriptReviews,upgradeIndependentImageReviews,upgradeReviewRecovery,upgradeReviewEvidenceScope,upgradeReviewPrompt,upgradePerFrameObservations,upgradeSourceEvidence,upgradeConfiguredSourceGuard,upgradeConciseRepair,upgradeTailTimingPolicy,upgradeAcceptedMediaContract,upgradeReportRepairTarget,upgradeSourceOrthography,upgradeRejectedContentRouting,upgradeGroundedContentReview,upgradeConditionalReviewBranches,upgradeAudienceSceneOutline,upgradeCinematicDramaQuality,upgradeDramaturgyReportConvergence,upgradeHistoricalAgencyConvergence,upgradeShotAnchorVerbatimCoverage,upgradeDramaturgyEvidencePathGrounding,upgradeDramaturgyCoverageChannels,upgradeFictionBoundaryReviewRules,upgradeReviewReportRecoveryBudget,upgradeReviewerCoverageChecklist,upgradeDramaturgyQuoteTypography,upgradeHistoricalAgencySourceCitation,upgradeIdleTailEditDecision,upgradeUnknownWorldStateEvidence,upgradeGroundedMediaObservation,upgradePendingMediaEditGate,upgradeConfirmedMediaDefects,upgradeMediaReviewDetails,upgradeIndependentMediaEvidence,upgradeScopedMediaDefects,upgradeLiveMediaPolicy,upgradeCompleteMediaRequirements,upgradeBoundMediaRequirements,upgradeCompleteMediaDiagnostics,upgradeRequirementMediaSampling,upgradeIndependentRequirementReview,upgradeLiteralRequirementReview,upgradeMediaReviewRetryGroup,upgradeMediaStateEvidence,upgradeAdaptiveMediaSampling,upgradeStructuredMediaEvidenceGaps,upgradeMediaContextQuoteContract,upgradeSharedMediaCriticalityContext,upgradeNativeSequenceMediaEvidence,upgradeNativeDisplayEvidenceScope,upgradeVideoRequestTimeSeparators,upgradeStoryboardTimelineSyntax,upgradeDurationQuality,refreshSceneOutlineAnchors,refreshHistoricalReportContracts,upgradeEditorialFilmGrammar,upgradeThreeViewLayoutContract,upgradeActorlessEditorialBridge,upgradeActorlessEditorialPacing,upgradeEditorialVideoIdentityContract,upgradeHistoricalTextTransportFailover,upgradeIndependentHistoricalTextFallback,upgradeBoundedIndependentHistoricalTextFallback,upgradeBoundedHistoricalPrimaryAttempts,upgradeObservedHistoricalPrimaryAttemptWindow,upgradeAnimatedMapBoundaryFrames,upgradeAnimatedShotStyleContract,upgradeIllustrationLayerLayout,upgradeNeutralPortraitAndIllustrationBackground,upgradeFirstFrameBranchLineSplitting,upgradeBriskNarrationPolicy,refreshStaticBoundaryFrameScope].reduce((w,upgrade)=>upgrade(w),workflow)
}

/** Schema 144 aligns the persisted writer prompt with the validator's narrow
 * actorless setting-establishment exception. Frozen execution records remain
 * immutable; retries receive the refreshed managed clause through the workflow. */
export function upgradeActorlessSettingEstablishment<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==143)return workflow
  const writers=workflow.nodes.filter(node=>node.id==='sanguo-shot-script')
  const writer=writers[0]
  if(writers.length!==1||writer.kind!=='text')return workflow
  const oldCount=writer.prompt.split(DURATION_ACTOR_IDS_CONTRACT_BEFORE_SETTING_ESTABLISHMENT).length-1
  const newCount=writer.prompt.split(DURATION_ACTOR_IDS_CONTRACT).length-1
  if(oldCount+newCount!==1)return workflow
  const prompt=oldCount===1
    ?writer.prompt.replace(DURATION_ACTOR_IDS_CONTRACT_BEFORE_SETTING_ESTABLISHMENT,DURATION_ACTOR_IDS_CONTRACT)
    :writer.prompt
  return {...workflow,schemaVersion:144,nodes:workflow.nodes.map(node=>node===writer?{...node,prompt}:node)}
}

export const EDITORIAL_VIDEO_PROMPT = '【本镜影视处理】${shot_script.visualTreatment} / ${shot_script.editorialRole}\n【动画叙事类型与美术风格】${shot_script.animationStyle} / ${shot_script.animationAesthetic}\n【场景与开场画面】${shot_script.visualPrompt}\n【视觉处理硬约束】live_action 必须生成具有真实空间深度、自然光影和可信时代环境的完整实景；animated 严格执行 animationStyle 与 animationAesthetic，可使用历史人物插画、历史场景、象征物、时间或环境动画，不默认地图。character_illustration 使用系统二维插画编排路线：人物素材内部姿态、表情、嘴部和衣物全程不变，只允许整个人物图层在合适的历史背景上淡入、平移、缩放、淡出；系统裁切人物正面并必须完全忽略附件中的纯色底。historical_tableau 仅允许整幅定格画面轻微缩放、平移或渐变。二者均不向视频模型请求人物走路、转身、说话等肢体动画，背景由独立画外旁白讲清。其他动画按分镜运动。禁止低幼卡通、Q版、现代动漫符号、游戏CG和玄幻光效。旧 animated_map/historical_montage 分别按 historical_map/historical_tableau 兼容。人物参考附件只用于身份、脸部、体型和服装。\n${shot_script.videoPrompt}\n【本镜结束时的自然动作结果】${shot_script.lastFramePrompt}\n运镜：${shot_script.camera}\n人声类型：${shot_script.audioType}\n【音轨文本；环境声模式为空且禁止人声】${shot_script.audioText}'
export const EDITORIAL_VIDEO_NEGATIVE_PROMPT = '画面闪烁、人物变形、身份漂移、服饰突变、未按二维图层编排的人物出现或消失、纯色背景、摄影棚背景、幕布背景、舞台布景、三视图背景复现、人物抠图感、空洞背景、现代物件、字幕、水印、低幼卡通、游戏CG、玄幻光效、AI塑料感'

export function upgradeAnimatedShotStyleContract<N extends Node,W extends Workflow<N>>(workflow:W):W {
  const framed=upgradeAnimatedShotStyles(workflow)
  if(framed.id!=='wf-sanguo-history-drama'||framed.schemaVersion!==131)return workflow
  const nodes=framed.nodes.map(node=>{
    if(node.id==='sanguo-scene-outline'&&node.kind==='text')return {...node,prompt:SANGUO_SCENE_OUTLINE_PROMPT}
    if(node.id==='sanguo-shot-script'&&node.kind==='text')return {...node,prompt:refreshStoryboardEditorialPrompt(node.prompt)}
    if(node.id==='sanguo-video'&&node.kind==='video'){
      const names=new Set(node.params.map(param=>param.englishName||param.name))
      const params=[...node.params]
      if(!names.has('animationStyle'))params.push({id:'editorial-animation-style',name:'动画叙事类型',type:'text',value:'${shot_script.animationStyle}',required:false,englishName:'animationStyle'})
      if(!names.has('animationAesthetic'))params.push({id:'editorial-animation-aesthetic',name:'动画美术风格',type:'text',value:'${shot_script.animationAesthetic}',required:false,englishName:'animationAesthetic'})
      return {...node,prompt:EDITORIAL_VIDEO_PROMPT,params}
    }
    return node
  })
  return {...framed,nodes}
}

/** Schema 132 turns the storyboard's semantic 2D composition into executable
 * coordinates and timing at the video boundary. Existing models, edges and
 * completed media remain untouched. */
export function upgradeIllustrationLayerLayout<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==131)return workflow
  const writer=workflow.nodes.find(node=>node.id==='sanguo-shot-script')
  const video=workflow.nodes.find(node=>node.id==='sanguo-video')
  if(writer?.kind!=='text'||video?.kind!=='video')return workflow
  const refreshedParams=video.params.map(param=>(param.englishName||param.name)==='negativePrompt'?{...param,value:EDITORIAL_VIDEO_NEGATIVE_PROMPT}:param)
  const params=refreshedParams.some(param=>(param.englishName||param.name)==='illustrationLayers')?refreshedParams:[...refreshedParams,
    {id:'sg-v-illustration-layers',name:'二维人物图层编排',englishName:'illustrationLayers',type:'json',required:false,value:'${shot_script.illustrationLayers}'}]
  return {...workflow,schemaVersion:132,nodes:workflow.nodes.map(node=>node===writer?{...node,prompt:refreshStoryboardEditorialPrompt(node.prompt)}
    :node===video?{...node,params}:node)}
}

/** Schema 135 separates reusable identity from shot pose, strengthens the
 * neutral-pose generation/review contract and makes the character-illustration
 * first frame a true background plate. It also repairs partially persisted 133/134. */
export function upgradeNeutralPortraitAndIllustrationBackground<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)<132||(workflow.schemaVersion??0)>=135)return workflow
  const nodes=workflow.nodes.map(node=>{
    if(node.id==='sanguo-character-lookup'&&node.kind==='code')return {...node,code:SANGUO_CHARACTER_LOOKUP_CODE}
    if(node.id==='sanguo-character-image')return {...node,params:node.params.map(param=>(param.englishName||param.name)==='generationPromptTemplate'?{...param,value:NEUTRAL_THREE_VIEW_GENERATION_TEMPLATE}:param)}
    if(node.id==='sanguo-character-review'&&node.kind==='text')return {...node,prompt:PRINCIPLE_IMAGE_REVIEW_PROMPT}
    if(node.id==='sanguo-first-frame-branch'&&node.kind==='code')return {...node,code:SANGUO_FIRST_FRAME_BRANCH_CODE}
    if(node.id==='sanguo-animated-map-first-frame'&&node.kind==='image')return {...node,...animatedMapFirstFrameNode,modelId:node.modelId,position:node.position,parentId:node.parentId} as N
    if(node.id==='sanguo-shot-script'&&node.kind==='text')return {...node,prompt:refreshStoryboardEditorialPrompt(node.prompt)}
    return node
  })
  return {...workflow,schemaVersion:135,nodes}
}

/** Schema 136 refreshes the managed first-frame branch with newline splitting
 * that cannot be corrupted into a literal line break when saved and restored. */
export function upgradeFirstFrameBranchLineSplitting<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==135)return workflow
  const branch=workflow.nodes.find(node=>node.id==='sanguo-first-frame-branch')
  if(branch?.kind!=='code'||!branch.code?.includes('backgroundOnlyPrompt')||!branch.code.includes('frameReferenceImages'))return workflow
  return {...workflow,schemaVersion:136,nodes:workflow.nodes.map(node=>node===branch?{...node,code:SANGUO_FIRST_FRAME_BRANCH_CODE}:node)}
}

/** Schema 137 adopts a brisk but still bounded narration profile. It changes
 * only detached voice-over planning; dialogue, chant and singing retain their
 * performance budgets. Existing execution snapshots remain immutable. */
export function upgradeBriskNarrationPolicy<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==136)return workflow
  let changed=false
  const nodes=workflow.nodes.map(node=>{
    const params=node.params.map(param=>{
      if((param.englishName||param.name)!=='timingPolicy')return param
      changed=true
      return {...param,value:JSON.stringify(DEFAULT_DURATION_POLICY)}
    })
    return params.some((param,index)=>param!==node.params[index])?{...node,params}:node
  })
  return changed?{...workflow,schemaVersion:137,nodes}:workflow
}

/** Schema 142 makes the series' visual treatment explicit: the sand-table/map
 * information insert is the only animated route; every other shot is planned
 * and rendered as live action. Frozen execution records remain untouched. */
export function upgradeLiveActionExceptSandTable<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)<141||(workflow.schemaVersion??0)>142)return workflow
  const outline=workflow.nodes.find(node=>node.id==='sanguo-scene-outline')
  if(outline?.kind!=='text')return workflow
  if(workflow.schemaVersion===142&&outline.prompt===SANGUO_SCENE_OUTLINE_PROMPT)return workflow
  return {...workflow,schemaVersion:142,nodes:workflow.nodes.map(node=>node===outline?{...node,prompt:SANGUO_SCENE_OUTLINE_PROMPT}:node)}
}

/** Schema 120 adds film-editing grammar without adding bespoke workflow nodes.
 * Existing model choices, retry budgets, duration-v2 code and graph stay intact. */
export function upgradeEditorialFilmGrammar<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=120)return workflow
  const outline=workflow.nodes.find(node=>node.id==='sanguo-scene-outline')
  const writer=workflow.nodes.find(node=>node.id==='sanguo-shot-script')
  const video=workflow.nodes.find(node=>node.id==='sanguo-video')
  if(outline?.kind!=='text'||writer?.kind!=='text'||video?.kind!=='video')return workflow
  const writerPrompt=refreshStoryboardEditorialPrompt(writer.prompt)
  if(!writerPrompt.includes('editorialRole')||!writerPrompt.includes('visualTreatment'))return workflow
  const nodes=workflow.nodes.map(node=>{
    if(node===outline)return {...node,prompt:SANGUO_SCENE_OUTLINE_PROMPT}
    if(node===writer)return {...node,prompt:writerPrompt}
    if(node===video)return {...node,prompt:EDITORIAL_VIDEO_PROMPT,params:node.params.map(param=>(param.englishName||param.name)==='negativePrompt'
      ?{...param,value:EDITORIAL_VIDEO_NEGATIVE_PROMPT}:param)}
    return node
  })
  return {...workflow,schemaVersion:120,nodes}
}

/** Schema 121 restores the deterministic horizontal-sheet gate that the
 * independent appearance-review migration accidentally disabled. Layout is a
 * provider input contract, not an aesthetic review preference. */
export function upgradeThreeViewLayoutContract<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=121)return workflow
  const writers=workflow.nodes.filter(node=>node.id==='sanguo-character-image')
  const writer=writers[0]
  if(writers.length!==1||writer?.operation!=='character.ensure')return workflow
  const layoutParams=writer.params.filter(param=>(param.englishName||param.name)==='validateThreeView')
  const deferred=writer.params.some(param=>(param.englishName||param.name)==='deferArchive'&&String(param.value)==='true')
  if(layoutParams.length!==1||!deferred)return workflow
  const nodes=workflow.nodes.map(node=>node===writer?{...node,params:node.params.map(param=>param===layoutParams[0]?{...param,value:'true'}:param)}:node)
  return {...workflow,schemaVersion:121,nodes}
}

/** Schema 122 aligns the persisted writer prompt with the validator: an
 * environment-only live-action context bridge does not invent a cast member. */
export function upgradeActorlessEditorialBridge<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==121)return workflow
  const writers=workflow.nodes.filter(node=>node.id==='sanguo-scene-outline')
  const writer=writers[0]
  if(writers.length!==1||writer.kind!=='text')return workflow
  const oldCount=writer.prompt.split(SCENE_OUTLINE_CAST_CONTRACT_BEFORE_ACTORLESS_BRIDGE).length-1
  const newCount=writer.prompt.split(SCENE_OUTLINE_CAST_CONTRACT).length-1
  if(oldCount+newCount!==1)return workflow
  const prompt=oldCount===1
    ?writer.prompt.replace(SCENE_OUTLINE_CAST_CONTRACT_BEFORE_ACTORLESS_BRIDGE,SCENE_OUTLINE_CAST_CONTRACT)
    :writer.prompt
  return {...workflow,schemaVersion:122,nodes:workflow.nodes.map(node=>node===writer?{...node,prompt}:node)}
}

/** Schema 123 aligns duration-v2 with the same actorless editorial contract.
 * Environment actions have no performer; narration remains an explicit voice. */
export function upgradeActorlessEditorialPacing<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==122)return workflow
  const writers=workflow.nodes.filter(node=>node.id==='sanguo-shot-script')
  const writer=writers[0]
  if(writers.length!==1||writer.kind!=='text')return workflow
  const oldCount=writer.prompt.split(DURATION_ACTOR_IDS_CONTRACT_BEFORE_ACTORLESS_EDITORIAL).length-1
  const newCount=writer.prompt.split(DURATION_ACTOR_IDS_CONTRACT).length-1
  if(oldCount+newCount!==1)return workflow
  const prompt=oldCount===1
    ?writer.prompt.replace(DURATION_ACTOR_IDS_CONTRACT_BEFORE_ACTORLESS_EDITORIAL,DURATION_ACTOR_IDS_CONTRACT)
    :writer.prompt
  return {...workflow,schemaVersion:123,nodes:workflow.nodes.map(node=>node===writer?{...node,prompt}:node)}
}

/** Schema 124 carries the approved editorial identity to the final paid-video
 * boundary. The prompt header remains a compatibility source for frozen runs. */
export function upgradeEditorialVideoIdentityContract<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==123)return workflow
  const videos=workflow.nodes.filter(node=>node.id==='sanguo-video'),video=videos[0]
  if(videos.length!==1||video.kind!=='video')return workflow
  const names=new Set(video.params.map(param=>param.englishName||param.name))
  if(names.has('visualTreatment')||names.has('editorialRole'))return workflow
  const params=[...video.params,
    {id:'editorial-visual-treatment',name:'影视处理',type:'text',value:'${shot_script.visualTreatment}',required:true,englishName:'visualTreatment'},
    {id:'editorial-role',name:'剪辑角色',type:'text',value:'${shot_script.editorialRole}',required:true,englishName:'editorialRole'}]
  return {...workflow,schemaVersion:124,nodes:workflow.nodes.map(node=>node===video?{...node,params}:node)}
}

/** Schema 125 gives long historical writers a real recovery dimension. Two
 * identical gateway timeouts trigger the already-configured secondary text
 * channel; semantic repair budgets remain separate and unchanged. */
export function upgradeHistoricalTextTransportFailover<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==124)return workflow
  const writers=workflow.nodes.filter(node=>['sanguo-scene-outline','sanguo-shot-script'].includes(node.id))
  const fallback=workflow.nodes.find(node=>node.id==='sanguo-media-observe'&&node.kind==='text'
    && node.modelId && writers.every(writer=>writer.modelId!==node.modelId))?.modelId
  if(writers.length!==2||!fallback)return workflow
  const nodes=workflow.nodes.map(node=>!writers.includes(node)?node:{...node,params:[...node.params,
    {id:`${node.id}-primary-transport-attempts`,name:'主通道传输尝试',englishName:'primaryTransportAttempts',type:'number',required:true,value:'2'},
    {id:`${node.id}-transport-fallback`,name:'传输备用文本模型',englishName:'transportFallbackModelId',type:'text',required:true,value:fallback}]})
  return {...workflow,schemaVersion:125,nodes}
}

/** Schema 126 moves writer recovery off the shared Doro gateway. Switching a
 * model behind the same gateway did not isolate the observed 524 failure. */
export function upgradeIndependentHistoricalTextFallback<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==125)return workflow
  const writers=workflow.nodes.filter(node=>['sanguo-scene-outline','sanguo-shot-script'].includes(node.id))
  const fallback=workflow.nodes.find(node=>node.kind==='text'&&node.modelId&&node.modelId==='codex-local-vision'
    && writers.every(writer=>writer.modelId!==node.modelId))?.modelId
  if(writers.length!==2||!fallback)return workflow
  const nodes=workflow.nodes.map(node=>!writers.includes(node)?node:{...node,params:node.params.map(param=>(param.englishName||param.name)==='transportFallbackModelId'
    ?{...param,value:fallback,name:'独立传输备用文本模型'}:param)})
  return {...workflow,schemaVersion:126,nodes}
}

/** Schema 127 prevents the independent writer fallback from inheriting the
 * ultra/long-running settings used by visual review. The fallback remains a
 * bounded recovery path, rather than a second unbounded wait. */
export function upgradeBoundedIndependentHistoricalTextFallback<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==126)return workflow
  const writers=workflow.nodes.filter(node=>['sanguo-scene-outline','sanguo-shot-script'].includes(node.id))
  if(writers.length!==2||writers.some(node=>node.params.some(param=>(param.englishName||param.name)==='transportFallbackTimeoutMs')))return workflow
  const nodes=workflow.nodes.map(node=>!writers.includes(node)?node:{...node,params:[...node.params,
    {id:`${node.id}-fallback-timeout`,name:'备用通道超时',englishName:'transportFallbackTimeoutMs',type:'number',required:true,value:'240000'},
    {id:`${node.id}-fallback-reasoning`,name:'备用通道推理强度',englishName:'transportFallbackReasoningEffort',type:'text',required:true,value:'medium'}]})
  return {...workflow,schemaVersion:127,nodes}
}

/** Schema 128 bounds each primary HTTP request as well as the attempt count. */
export function upgradeBoundedHistoricalPrimaryAttempts<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==127)return workflow
  const writers=workflow.nodes.filter(node=>['sanguo-scene-outline','sanguo-shot-script'].includes(node.id))
  if(writers.length!==2||writers.some(node=>node.params.some(param=>(param.englishName||param.name)==='primaryTransportAttemptTimeoutMs')))return workflow
  const nodes=workflow.nodes.map(node=>!writers.includes(node)?node:{...node,params:[...node.params,
    {id:`${node.id}-primary-attempt-timeout`,name:'主通道单次超时',englishName:'primaryTransportAttemptTimeoutMs',type:'number',required:true,value:'150000'}]})
  return {...workflow,schemaVersion:128,nodes}
}

/** Schema 129 corrects the first bounded timeout with production evidence.
 * Successful Doro writer calls take about 204-211 seconds, so 150 seconds
 * creates false transport failures. Only the exact managed value is changed;
 * user-edited limits and frozen executions remain untouched. */
export function upgradeObservedHistoricalPrimaryAttemptWindow<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==128)return workflow
  const writers=workflow.nodes.filter(node=>['sanguo-scene-outline','sanguo-shot-script'].includes(node.id))
  const timeoutParams=writers.map(node=>node.params.find(param=>(param.englishName||param.name)==='primaryTransportAttemptTimeoutMs'))
  if(writers.length!==2||timeoutParams.some(param=>!param)||timeoutParams.some(param=>String(param?.value)!=='150000'))return workflow
  const nodes=workflow.nodes.map(node=>!writers.includes(node)?node:{...node,params:node.params.map(param=>(param.englishName||param.name)==='primaryTransportAttemptTimeoutMs'
    ?{...param,value:'240000'}:param)})
  return {...workflow,schemaVersion:129,nodes}
}

/** Refresh bounded shipped report contracts even when the topology is current.
 * Frozen executions and unmarked custom prompts/code are not rewritten. */
export function refreshHistoricalReportContracts<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama')return workflow;
  let changed=false;
  const nodes=workflow.nodes.map(node=>{
    let next=node;
    if(['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id)&&node.kind==='text'
      &&node.prompt.includes('【cinematic-v1 叙事审核】')&&node.prompt.includes('【cinematic-v1 叙事审核结束】')) {
      const prompt=refreshDramaturgyReviewPrompt(node.prompt);
      if(prompt!==node.prompt)next={...node,prompt};
    }
    if(['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.kind==='code'&&node.code
      &&node.code.includes('// SOURCE_SPAN_RESOLUTION_START')&&node.code.includes('// SOURCE_SPAN_RESOLUTION_END')
      &&node.code.includes('const candidate = params.candidate; let review = params.review;')
      &&node.code.includes('const sources=context.historical_sources?.citations || [];')) {
      const code=refreshHistoricalSourceReviewGateCode(refreshEmbeddedDramaturgyReviewCode(node.code));
      if(code!==node.code)next={...node,code};
    }
    if(next!==node)changed=true;
    return next;
  });
  return changed?{...workflow,nodes}:workflow;
}

/** Prompt-only correction within the current topology; frozen execution runs
 * are not passed here. Unknown custom wording is left alone. */
export function refreshSceneOutlineAnchors<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama')return workflow;
  let changed=false;
  const nodes=workflow.nodes.map(node=>{
    if(node.id!=='sanguo-scene-outline'||node.kind!=='text')return node;
    const prompt=refreshSceneOutlineAnchorPrompt(node.prompt);
    if(prompt===node.prompt)return node;
    changed=true;
    return {...node,prompt};
  });
  return changed?{...workflow,nodes}:workflow;
}

export function upgradeConfiguredSourceGuard<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=68)return workflow;
  const guard=`\nlet policyIssue; try { (${validateHistoricalAgency.toString()})(candidate, sources); } catch(error) { policyIssue={itemId:candidate.id,problem:error.message,repair:'保留剧情，恢复史料记载的行动主体和时代'}; }\nconst accepted=review.passed&&!policyIssue; const combinedIssues=[...review.issues,...(policyIssue?[policyIssue]:[])];\n`;
  return {...workflow,schemaVersion:68,nodes:workflow.nodes.map(n=>['sanguo-shot-script-accept','sanguo-scene-outline-accept'].includes(n.id)?{...n,code:n.code!.replace('return {...candidate, passed:review.passed, issues:review.issues, contentReview:review,repairContext:{issues:review.issues,previousCandidate:candidate}};',guard+'return {...candidate,passed:accepted,issues:combinedIssues,contentReview:{...review,passed:accepted,issues:combinedIssues},repairContext:{issues:combinedIssues,previousCandidate:candidate}};')}:n)};
}

export function upgradeConciseRepair<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=69)return workflow;
  return {...workflow,schemaVersion:69,nodes:workflow.nodes.map(n=>n.id==='sanguo-media-review'?{...n,prompt:n.prompt+'\nretryPrompt必须是200汉字以内的局部修复指令，只写改什么与保留什么，禁止重写整段时间轴、整份原剧本或复制issues全文。第一帧可以是0–1秒展开卷轴动作的起始阶段，不能要求动作在0秒已经完成。'}
    :n.id==='sanguo-media-accept'?{...n,params:[...n.params,p('maxRepairChars','350','number')],code:n.code!.replace('const passed = review.passed && issues.length === 0;',"const passed = review.passed && issues.length === 0;\nif(!passed && (!review.retryPrompt?.trim() || review.retryPrompt.length > params.maxRepairChars)) invalid('修复意见超过预算或为空：请只返回200字以内的局部修改，不重写原时间轴');").replace("retryPrompt: [review.retryPrompt, ...issues].filter(Boolean).join('\\n')", "retryPrompt: review.retryPrompt")}:n)};
}

export const TAIL_TIMING_CODE = String.raw`
const speechEnd=evidence.speechValidation?.lastSpeechEnd;
const tailSeconds=Number.isFinite(speechEnd)?evidence.duration-speechEnd:null;
const tailTiming={actualSeconds:tailSeconds,minSeconds:Math.max(0,policy.tailSeconds-policy.timingToleranceSeconds),maxSeconds:policy.maxIdleTailSeconds};
tailTiming.assessment=tailSeconds===null?'uncertain':tailSeconds>=tailTiming.minSeconds&&tailSeconds<=tailTiming.maxSeconds?'within-allowance':'outside-allowance';
`;
export function upgradeTailTimingPolicy<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=70)return workflow;
  return {...workflow,schemaVersion:70,nodes:workflow.nodes.map(n=>n.id==='sanguo-media-metrics'?{...n,params:[...n.params,p('tailSeconds','.3','number')],code:n.code!.replace('return {frames:',TAIL_TIMING_CODE+'\nreturn {tailTiming,frames:')}
    :n.id==='sanguo-media-review'?{...n,prompt:n.prompt+'\n剪辑余量按media_metrics.tailTiming区间验收。0.3秒是目标值，非必须精确相等；不得把0.36秒等区间内差异判成空等或要求精确8.9秒停机。输出tailTimingCheck:{assessment:原数值assessment,reason:数值证据}。空等另参考实际必要动作及maxIdleTailSeconds，禁止擅自建立更严格的阈值。'}
    :n.id==='sanguo-media-accept'?{...n,code:n.code!.replace('const computed=context.media_metrics;',"const computed=context.media_metrics;\nif(!review.tailTimingCheck || review.tailTimingCheck.assessment!==computed.tailTiming?.assessment || !review.tailTimingCheck.reason) invalid('剪辑余量判断未遵循配置的容差区间，复核同一素材');")}:n)};
}

export function upgradeAcceptedMediaContract<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=71)return workflow;
  return {...workflow,schemaVersion:71,nodes:workflow.nodes.map(n=>n.id==='sanguo-media-accept'?{...n,code:n.code!.replace('return { ...e, passed, issues,',"return { ...e, params:context.video_take.params, speechValidation:{...e.speechValidation,passed,acceptanceSource:'configured-gate'}, passed, issues,")}:n)};
}

export function upgradeReportRepairTarget<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=72)return workflow;
  return {...workflow,schemaVersion:72,nodes:workflow.nodes.map(n=>n.id==='sanguo-media-accept'?{...n,errorRetry:{retryFrom:'sanguo-media-review',maxAttempts:2,patterns:['REVIEW_RESULT_INVALID:']},code:n.code!.replace('const closure = review.narrativeClosure, pacing = review.pacingReview;',"const closure = review.narrativeClosure, pacing = review.pacingReview;\nif(!Number.isFinite(pacing?.lastMeaningfulActionSecond)) invalid('报告必须补充 pacingReview.lastMeaningfulActionSecond 数值字段，以实际 ASR 或帧时间为依据；保留其他有证据的判定，仅修复本报告，不重拍也不重新观察');")}
    :n.id==='sanguo-media-review'?{...n,prompt:n.prompt+'\npacingReview.lastMeaningfulActionSecond 是必填数字，不能只在reason文字里写秒数；输出前检查该字段存在。收到报告格式修复意见时，使用已有实际观察修复报告。'}:n)};
}

// Embed only single-character orthographic mappings in editable, sandboxed code.
// No fuzzy matching or phrase/meaning substitutions are used for source evidence.
const sourceCharacterMap = Object.fromEntries(Locale.to.cn.flat().flatMap(dictionary => typeof dictionary === 'string' ? dictionary.split('|').map(entry => entry.split(' ')) : dictionary.map(entry => [...entry]))
  .filter(([from, to]) => [...from].length === 1 && !!to && [...to].length === 1)
  .map(([from, to]) => [from, to]));
const SOURCE_ORTHOGRAPHY_CODE = `const sourceCharacterMap=${JSON.stringify(sourceCharacterMap)};\n`;
export function upgradeSourceOrthography<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=73)return workflow;
  return {...workflow,schemaVersion:73,nodes:workflow.nodes.map(node=>{
    if(!['sanguo-shot-script-accept','sanguo-scene-outline-accept'].includes(node.id)||!node.code)return node;
    const original=SOURCE_EVIDENCE_CODE.match(/const normalize=.*;/)![0];
    const replacement=SOURCE_ORTHOGRAPHY_CODE+original.replace("String(value||'')", "[...String(value||'')].map(c=>sourceCharacterMap[c]||c).join('')");
    return {...node,code:node.code.replace(original,replacement)};
  })};
}

export function upgradeRejectedContentRouting<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=74)return workflow;
  return {...workflow,schemaVersion:74,nodes:workflow.nodes.map(node=>{
    if(['sanguo-scene-outline','sanguo-shot-script'].includes(node.id))return {...node,prompt:node.prompt+'\ncast/characters 只能列实际人物或群体，不得放入卷宗、印绶等道具；道具写入 requiredBeats.mustShow 或场景描述。'};
    if(['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id))return {...node,prompt:node.prompt+'\n检查 cast/characters 是否混入道具，若有须 passed=false 并在 issues 中指出具体条目与修复建议，不能替道具编造人物动作检查。拒绝报告可以只包含已核实的问题和相关证据；通过报告必须完整覆盖每个真实人物。'};
    if(!['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)||!node.code)return node;
    return {...node,code:node.code.replace('for (const item of items) for (const character of item.characters || item.cast || []) {', 'if (review.passed) for (const item of items) for (const character of item.characters || item.cast || []) {')
      .replace("throw Error('REVIEW_RESULT_INVALID: 缺少逐人动作审核证据');", "throw Error('REVIEW_RESULT_INVALID: 缺少逐人动作审核证据：'+item.id+' / '+character+'；需恰好一项 checks 且包含 canExecuteAsWritten、finalActionState、requestedEndState；若人物名单混入道具，应明确拒绝并报告修复问题');")};
  })};
}

export function upgradeGroundedContentReview<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=75)return workflow;
  return {...workflow,schemaVersion:75,nodes:workflow.nodes.map(node=>!['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id)?node:{...node,prompt:node.prompt+`\n拒绝依据与收敛规则：每条 issues 必须指出候选中实际存在的错误及原文位置，不能因为“可能暗示”“容易误导”“需确认”就拒绝。先阅读该场景完整 purpose、requiredBeats、adaptationBoundary；已经声明清楚的边界不重复要求。cast/characters 是人物，mustShow 可以包含人物、道具、动作、文字，不能混淆两种字段。人物持物和动作已在任一 beat 写明即有效，不要求每字段重复。群体/背景人物可作普通回应，无台词时无需强制命名。不得将宾客的自发结交推断为主人的授意，只有候选明确写主人组织/授意时才据此拒绝。不得要求已明确转述既有歌谣的角色额外声明并非原创。对未证实的疑问放 warnings，不得包装成事实错误。不要提出多种互斥的局部修复方案后轮流拒绝，保持此前已满足的要求。确有史料主体、因果、年代、说话归属错误仍须拒绝。`} )};
}


export function upgradeConditionalReviewBranches<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=76)return workflow;
  const nodes=workflow.nodes.map(node=>{
    if(node.kind!=='branch'||node.runIf)return node;
    const gate=workflow.nodes.find(g=>g.runIf && [g.id+'-error-branch',g.id+'-accept-branch'].includes(node.id));
    return gate?{...node,runIf:gate.runIf}:node;
  });
  return {...workflow,schemaVersion:76,nodes};
}


export function upgradeAudienceSceneOutline<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=77)return workflow;
  return {...workflow,schemaVersion:77,nodes:workflow.nodes.map(node=>node.id==='sanguo-scene-outline'?{...node,prompt:SANGUO_SCENE_OUTLINE_PROMPT}:node)};
}

const CINEMATIC_MEDIA_REVIEW_PROMPT = `
【同场切镜与有目的沉默】continuity.mode=coverage_cut允许反打/特写构图变化，不用前镜像素相同验收；tail_continuation仍须遵循真实尾帧。characters/endCharacters是本镜实际可见人物，presentCharacters包含画外仍在场的人，画外不等于离场，不能强迫全部同框。实际worldState只能来自当前观察及先前已验收证据，未知状态写unknown，不能拿剧本期望当observed。输出worldState实际尾帧状态供后镜使用。
环境声镜头audioText为空，speechChecks=[]，不编造ASR或宣称验证对白；仍须有真实音轨并按实际动作检验节奏。tailTiming.assessment=not-applicable只表示没有人声余量问题，不免除maxIdleTailSeconds。
对pacing.performanceBeats逐项输出pacingReview.performanceChecks:[{beatId,status:"observed|incomplete|unobservable",evidence:"实际变化证据",observedStateChange:"实际动作前后变化",startSecond:0,endSecond:1,frameIndices:[0,1]}]。observed必须引用至少2张实际采样帧显示状态变化；一张静帧、剧本purpose、计划时间窗不能证明正在作决定。看不清标unobservable并复核同一素材，禁止因此购买新视频。实际没有推进才incomplete；lastMeaningfulActionSecond需按实际帧/ASR，不能抄表演留白的计划结束时间。保留现有空等阈值。
`;

const CINEMATIC_EVIDENCE_CERTAINTY_CODE = String.raw` // cinematic-evidence-certainty-v1
 const uncertainWorldEvidence=(${hasExplicitWorldStateUncertainty.toString()});
 for(const character of (Array.isArray(review.worldState?.characters)?review.worldState.characters:[]))for(const field of ['position','heldProps','pendingAction']){const fact=character?.[field];
  if(fact?.status==='observed'&&(uncertainWorldEvidence(fact.value)||uncertainWorldEvidence(fact.evidence)))invalid('实际尾帧observed与明确不确定证据矛盾，须保留unknown并复核');
 }
 for(const row of (Array.isArray(review.continuityReview?.checks)?review.continuityReview.checks:[])){
  if(row?.status==='observed'&&uncertainWorldEvidence(row.evidence))invalid('首帧observed与明确不确定证据矛盾，须复核同一素材');
 }
 // /cinematic-evidence-certainty-v1`;

const LEGACY_CINEMATIC_WORLD_FACT_GUARD_CODE = "if(!fact||!['observed','unknown'].includes(fact.status)||(fact.status==='observed'&&(!fact.value?.trim()||!fact.evidence?.trim()))||(fact.status==='unknown'&&(fact.value||fact.evidence)))invalid('实际尾帧状态必须有采证或明确unknown');";
export const CINEMATIC_WORLD_FACT_GUARD_CODE = `if(!(${hasValidCinematicWorldFactShape.toString()})(fact))invalid('实际尾帧状态必须为有value/evidence的observed，或无事实value的unknown；unknown可保留字符串evidence说明不可观察原因');`;

const CINEMATIC_MEDIA_PERFORMANCE_CODE = String.raw`
if(shot.contentContractVersion==='cinematic-v1'){
${CINEMATIC_EVIDENCE_CERTAINTY_CODE}
 const exits=shot.continuity?.exitingCharacters||[];
 const state=review.worldState,expectedNames=(shot.presentCharacters||[]).filter(name=>!exits.some(exit=>exit.name===name));
 const names=exits.length?review.presentCharacters:expectedNames;
 if(exits.length){
  if(!Array.isArray(review.presentCharacters)||new Set(review.presentCharacters).size!==review.presentCharacters.length||review.presentCharacters.some(name=>!shot.presentCharacters.includes(name))||expectedNames.some(name=>!review.presentCharacters.includes(name))||!Array.isArray(review.presenceChecks)||review.presenceChecks.length!==exits.length)invalid('真实离场缺少末尾在场名单与逐人实际证据');
  for(const exit of exits){const check=review.presenceChecks.find(c=>c.character===exit.name);
   if(!check||!['observed','incomplete','unobservable'].includes(check.status)||!check.evidence?.trim()||!Array.isArray(check.frameIndices)||new Set(check.frameIndices).size<2||check.frameIndices.some(index=>!observations.frames.some(frame=>frame.index===index)))invalid('真实离场不能用画外或单帧证明');
   if(check.status==='unobservable')invalid('真实离场未观察到，复核同一素材而非重拍');
   if(check.status==='observed'&&review.presentCharacters.includes(exit.name))invalid('已观察离场却仍列为在场，修正报告');
   if(check.status==='incomplete'){if(!review.presentCharacters.includes(exit.name))invalid('实际未离場却从在场名单消失，修正报告');issues.push('人物未完成真实离场：'+exit.name+' '+check.evidence);}
  }
 }

 if(!state?.settingId||state.settingId!==shot.worldState?.settingId||!Array.isArray(state.characters)||JSON.stringify(state.characters.map(c=>c.name).sort())!==JSON.stringify([...names].sort()))invalid('尾帧worldState缺少场内人物或场所标识');
 for(const character of state.characters)for(const field of ['position','heldProps','pendingAction']){const fact=character[field];
  ${CINEMATIC_WORLD_FACT_GUARD_CODE}
  if(fact.status==='observed'&&!review.endCharacters.includes(character.name))invalid('画外人物状态不能冒充实际尾帧观察');
  if(field==='position'&&fact.status==='observed'&&/画面|屏幕|镜头(?:左|右)|构图|screen|frame\s*(?:left|right)/i.test(fact.value))invalid('实际世界位置不能用构图坐标代替');
 }
 if(shot.continuity?.mode==='coverage_cut'){
  const check=review.continuityReview,initial=shot.initialCharacters||shot.characters;
  const required=(shot.worldState?.characters||[]).flatMap(character=>initial.includes(character.name)?['position','heldProps','pendingAction'].filter(field=>character[field]?.status==='observed').map(field=>({character:character.name,field})):[]);
  if(check?.mode!=='coverage_cut'||typeof check.passed!=='boolean'||!Array.isArray(check.checks)||required.some(r=>check.checks.filter(c=>c?.character===r.character&&c?.field===r.field).length!==1)||new Set(check.checks.map(row=>JSON.stringify([row?.character,row?.field]))).size!==check.checks.length||check.checks.some(row=>!row||!(shot.worldState?.characters||[]).some(character=>character.name===row.character)||!['position','heldProps','pendingAction'].includes(row.field)))invalid('同场切镜缺少首帧逐项世界状态证据或含非法重复项目');
  for(const row of check.checks){if(!['observed','mismatch','unobservable'].includes(row.status)||!row.evidence?.trim()||!Array.isArray(row.frameIndices)||!row.frameIndices.includes(0)||row.frameIndices.some(index=>!observations.frames.some(frame=>frame.index===index)))invalid('同场切镜未引用实际首帧');
   if(!required.some(r=>r.character===row.character&&r.field===row.field)){if(row.status!=='unobservable')invalid('前镜未知状态不能冒充可核对的一致或不一致事实');continue;}
   if(row.status==='unobservable')invalid('同场切镜关键状态不可观察，复核同一素材而非重拍');
   if(row.status==='mismatch')issues.push('同场切镜改变实际连续状态：'+row.character+'.'+row.field+' '+row.evidence);
  }
  if(!check.passed&&!check.checks.some(c=>c.status==='mismatch'))invalid('同场切镜各状态一致却报告失败');
 }
}
const performances=shot.pacing?.performanceBeats||[];
if(performances.length){
 const checks=pacing.performanceChecks;
 if(!Array.isArray(checks)||checks.length!==performances.length)invalid('缺少逐项有目的沉默实际采证');
 for(const beat of performances){const check=checks.find(c=>c.beatId===beat.id);
  if(!check||!['observed','incomplete','unobservable'].includes(check.status)||!check.evidence?.trim()||!Number.isFinite(check.startSecond)||!Number.isFinite(check.endSecond)||check.startSecond<0||check.endSecond<=check.startSecond||check.endSecond>e.duration)invalid('表演留白证据不完整');
  if(check.status==='unobservable')invalid('表演状态变化未采样到，复核同一素材而非重拍');
  if(check.status==='observed'&&(!check.observedStateChange?.trim()||!Array.isArray(check.frameIndices)||new Set(check.frameIndices).size<2||check.frameIndices.some(index=>!observations.frames.some(frame=>frame.index===index))))invalid('表演留白不能由单一静帧或计划意图证明');
  if(check.status==='incomplete')issues.push('表演节拍未发生：'+beat.id+' '+check.evidence);
 }
}
`;

/** Refresh only the bounded coverage-opening block, preserving editable media checks. */
export function refreshCinematicOpeningGateCode(code:string){
 const start=" if(shot.continuity?.mode==='coverage_cut'){",end='\n }\n}\nconst performances=';
 const from=code.indexOf(start),to=code.indexOf(end,from);
 const currentFrom=CINEMATIC_MEDIA_PERFORMANCE_CODE.indexOf(start),currentTo=CINEMATIC_MEDIA_PERFORMANCE_CODE.indexOf(end,currentFrom);
 if(from<0||to<from||currentFrom<0||currentTo<currentFrom)throw Error('Cannot safely locate cinematic opening gate; preserve custom code');
 let current=CINEMATIC_MEDIA_PERFORMANCE_CODE.slice(currentFrom,currentTo);
 if(code.includes('// native-media-observation-scope-v1'))current=current.replaceAll('!observations.frames.some(frame=>frame.index===index)','!Number.isInteger(index)||index<0||index>=e.frames.length');
 return code.slice(0,from)+current+code.slice(to);
}

export function refreshCinematicEvidenceCertaintyCode(code:string){
 const start=' // cinematic-evidence-certainty-v1',end=' // /cinematic-evidence-certainty-v1';
 const from=code.indexOf(start),to=code.indexOf(end,from);
 if(from>=0){if(to<from)throw Error('Cannot safely locate cinematic evidence certainty gate');return code.slice(0,from)+CINEMATIC_EVIDENCE_CERTAINTY_CODE+code.slice(to+end.length);}
 const anchor="if(shot.contentContractVersion==='cinematic-v1'){";
 if(!code.includes(anchor))throw Error('Cannot safely locate cinematic media block; preserve custom code');
 return code.replace(anchor,anchor+'\n'+CINEMATIC_EVIDENCE_CERTAINTY_CODE);
}

const DIRECT_MEDIA_IMAGE_REVIEW = `\n【原始采样帧复核】附件是video_evidence.frames按原编号排列的真实图片。media_observations是模型观察草稿，可能误读人物、手势或持物，不能直接当作原图事实；逐项对照附件纠正，尤其首帧与尾帧。实际图像优先于观察文本，冲突写入warnings并给出准确帧号；不清楚仍写unknown/unobservable，不凭计划或另一份报告补造。heldProps只描述可证实的持物；只有部分手可见时不得把完整双手空置写成确定事实。continuityReview只对开场已observed的字段核对一致性，其余unknown可说明不确定，不能声称已验证。首帧已有某姿态不能证明此前动作过程，末帧若无抬手不得新增该手势。ASR仍只证明实际台词与时长，不证明逐帧口型。`;

export function refreshCinematicMediaImageReview<N extends Node>(node:N):N{
 if(node.id!=='sanguo-media-review')return node;
 const images=node.params.filter(param=>(param.englishName||param.name)==='reviewImages');
 const completePrompt=node.prompt.includes('【原始采样帧复核】')||isCanonicalMediaReviewPrompt(node.prompt);
 if(node.operation==='history.media-review'&&completePrompt&&images.length===1&&images[0].value==='${video_evidence.frames}'&&images[0].type==='json'&&images[0].required===true)return node;
 return {...node,operation:'history.media-review',prompt:completePrompt?node.prompt:node.prompt+DIRECT_MEDIA_IMAGE_REVIEW,
  params:[...node.params.filter(param=>!['reviewImages'].includes(param.englishName||param.name||'')),p('reviewImages','${video_evidence.frames}')]} as N;
}

/** Schema 78 keeps existing models and editable branches, adding one post-media reviewer only. */
export function upgradeCinematicDramaQuality<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=78)return workflow;
  const oldReturn='return {...candidate,passed:accepted,issues:combinedIssues,contentReview:{...review,passed:accepted,issues:combinedIssues},repairContext:{issues:combinedIssues,previousCandidate:candidate}};';
  let nodes=workflow.nodes.map(node=>{
    if(node.id==='sanguo-scene-outline')return {...node,prompt:SANGUO_SCENE_OUTLINE_PROMPT};
    if(node.id==='sanguo-shot-script')return {...node,prompt:SANGUO_CINEMATIC_STORYBOARD_PROMPT};
    if(node.id==='sanguo-video'){
      const fields=['contentContractVersion','continuityMode','firstFrameMode','audioType','audioText','worldState','presentCharacters'];
      return {...node,prompt:node.prompt.replace('【必须生成的同期人声原文】','【音轨文本；环境声模式为空且禁止人声】'),params:[...node.params.filter(param=>!fields.includes(param.englishName||'')),...fields.map(name=>p(name,'${shot_script.'+(name==='continuityMode'?'continuity.mode':name)+'}',name==='worldState'||name==='presentCharacters'?'json':'text',name!=='audioText'))]};
    }
    if(node.id==='sanguo-verify')return {...node,params:[...node.params.filter(param=>!['outline','sceneOutline','approvedSceneOutline'].includes(param.englishName||'')),p('sceneOutline','${scene_outline}'),p('approvedSceneOutline','${approved_scene_outline}')]};
    if(node.id==='sanguo-compose')return {...node,params:[...node.params.filter(param=>param.englishName!=='historicalVerification'),p('historicalVerification','${historical_verification}')]};

    if(['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id))return {...node,operation:'history.script-review',prompt:refreshHistoricalSourceReviewPrompt(refreshScriptReviewSourceQuotes(node.prompt))};
    if(['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code){
      let code=refreshEmbeddedDramaturgyReviewCode(node.code.replace(oldReturn,DRAMATURGY_ACCEPT_CODE));
      code=refreshEmbeddedHistoricalAgencyCode(code);
      code=code.replace("policyIssue={itemId:candidate.id,problem:error.message,repair:","const sourceTarget=(candidate.scenes||[candidate]).find(item=>String(error.message).includes(': '+item.id+' ')); if(!sourceTarget)throw Error('REVIEW_RESULT_INVALID: 史料主体错误缺少可定位场景：'+error.message); policyIssue={itemId:sourceTarget.id,problem:error.message,repair:");
      return {...node,code:refreshHistoricalSourceReviewGateCode(code)};
    }
    if(node.id==='sanguo-media-request')return {...node,code:VIDEO_REQUEST_CODE.replace('const windows =', "const speechRequired=shot.audioType!=='环境声';\nif(!speechRequired && (shot.contentContractVersion!=='cinematic-v1'||text.trim()))throw Error('环境声镜头需cinematic-v1且无台词');\nconst windows = !speechRequired ? [] :").replace('return { audioText: text,',"return { audioType:shot.audioType,speechRequired,previousTail:(!shot.continuity?.mode||shot.continuity.mode==='tail_continuation')?context.first_frame?.url:'',audioText: text,")};
    if(node.id==='sanguo-video-evidence')return {...node,params:[...node.params.filter(param=>!['audioType','previousTail'].includes(param.englishName||'')).map(param=>['audioText','speechWindows'].includes(param.englishName||'')?{...param,required:false}:param),p('audioType','${media_request.audioType}','text'),p('previousTail','${media_request.previousTail}','text',false)]};
    if(node.id==='sanguo-media-metrics'&&node.code)return {...node,code:node.code.replace("tailTiming.assessment=tailSeconds===null?'uncertain'", "tailTiming.assessment=shot.audioType==='环境声'?'not-applicable':tailSeconds===null?'uncertain'")};
    if(node.id==='sanguo-media-review')return refreshCinematicMediaImageReview({...node,prompt:node.prompt.includes('【同场切镜与有目的沉默】')?node.prompt:node.prompt+CINEMATIC_MEDIA_REVIEW_PROMPT+CINEMATIC_WORLD_STATE_REVIEW_PROMPT});
    if(node.id==='sanguo-media-accept'&&node.code)return {...node,code:node.code
      .replace('const speech = e.speechValidation;',"const speechRequired=shot.audioType!=='环境声';\nconst speech = speechRequired?e.speechValidation:undefined;")
      .replace('if (!speech || !Number.isFinite(speech.phoneticErrorRate) || speech.phoneticErrorRate > params.maxPhoneticErrorRate)', 'if (speechRequired && (!speech || !Number.isFinite(speech.phoneticErrorRate) || speech.phoneticErrorRate > params.maxPhoneticErrorRate))')
      .replace('if (e.firstFrameDifference !== undefined', "if ((!shot.continuity?.mode || shot.continuity.mode==='tail_continuation') && e.firstFrameDifference !== undefined")
      .replace('const passed = review.passed && issues.length === 0;',CINEMATIC_MEDIA_PERFORMANCE_CODE+'\nconst passed = review.passed && issues.length === 0;')
      .replace("speechValidation:{...e.speechValidation,passed,acceptanceSource:'configured-gate'},", "speechValidation:speechRequired?{...e.speechValidation,passed,acceptanceSource:'configured-gate'}:undefined,audioMode:speechRequired?'speech':'ambient',worldState:review.worldState,presentCharacters:review.presentCharacters||review.worldState?.characters?.map(c=>c.name),")};
    return node;
  });
  const compose=nodes.find(node=>node.id==='sanguo-compose')||nodes.find(node=>node.id==='sanguo-verify');
  let edges=[...workflow.edges];
  if(compose){
    const reviewModel=nodes.find(node=>node.id==='sanguo-media-review')?.modelId||nodes.find(node=>node.id==='sanguo-scene-outline-review')?.modelId;
    const common={uploads:[],loop:{enabled:false,sourcePath:'',fallbackCount:1,itemVar:'item'},params:[],prompt:''};
    const added=[
      {...common,id:'sanguo-episode-evidence',title:'整集实际声画整理',kind:'code',resultVar:'episode_review_evidence',code:EPISODE_EVIDENCE_CODE,position:{x:compose.position.x+280,y:compose.position.y}},
      {...common,id:'sanguo-episode-review',title:'整集叙事声画审看',kind:'text',operation:'history.episode-review',resultVar:'episode_dramaturgy_review',modelId:reviewModel,outputMode:'json',prompt:EPISODE_REVIEW_PROMPT,runIf:{path:'episode_review_evidence.shouldReview',equals:true},params:[p('reviewImages','${episode_review_evidence.reviewImages}'),p('temperature','0','number')],position:{x:compose.position.x+560,y:compose.position.y}},
      {...common,id:'sanguo-episode-review-accept',title:'整集审看报告',kind:'code',resultVar:'episode_quality_review',code:EPISODE_REVIEW_ACCEPT_CODE,errorRetry:{retryFrom:'sanguo-episode-review',maxAttempts:2,patterns:['REVIEW_RESULT_INVALID:']},position:{x:compose.position.x+840,y:compose.position.y}},
    ].filter(node=>!nodes.some(old=>old.id===node.id)) as unknown as N[];
    nodes=[...nodes,...added];
    const chain=[compose.id,'sanguo-episode-evidence','sanguo-episode-review','sanguo-episode-review-accept'];
    if(!edges.some(edge=>edge.from===compose.id&&edge.to===chain[1]))edges=edges.map(edge=>edge.from===compose.id?{...edge,from:chain.at(-1)!}:edge);
    for(let index=1;index<chain.length;index++)if(!edges.some(edge=>edge.from===chain[index-1]&&edge.to===chain[index]))edges.push({id:'drama-qa-'+chain[index],from:chain[index-1],to:chain[index]});
  }
  return {...workflow,schemaVersion:78,nodes,edges};
}

/** Schema 79 makes one review attempt converge inside the existing maxAttempts=2 budget.
 * The embedded report validator used to throw on its first defect, so a report carrying
 * two independent format defects spent attempt 1 on defect A and attempt 2 discovering
 * defect B, never getting an attempt to fix B. It now reports every defect at once, and
 * the reviewer prompt states the legal way out for all four dramaturgy dimensions. */
export function upgradeDramaturgyReportConvergence<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=79)return workflow;
  return {...workflow,schemaVersion:79,nodes:workflow.nodes.map(node=>{
    // Both instruction blocks matter: the dramaturgy block carries the hard status rule,
    // the source-span block carries the per-dimension not_applicable guidance a deployed
    // schema-78 prompt still limits to `orientation` alone.
    if(['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id))return {...node,prompt:refreshHistoricalSourceReviewPrompt(refreshDramaturgyReviewPrompt(node.prompt))};
    if(['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code)return {...node,code:refreshEmbeddedDramaturgyReviewCode(node.code)};
    return node;
  })};
}

/** Schema 80 lets one writer generation surface every historical-content defect.
 * `validateHistoricalAgency` is embedded in both accept gates and used to throw on the first
 * offending scene. The writer shares one three-generation budget between structural correction
 * and editorial rewrite, so a candidate defective in two scenes spent generation 1 on scene A,
 * generation 2 discovering scene B, then hit DRAMA_GENERATION_LIMIT before anything could fix B. */
export function upgradeHistoricalAgencyConvergence<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=80)return workflow;
  return {...workflow,schemaVersion:80,nodes:workflow.nodes.map(node=>
    ['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code
      ? {...node,code:refreshEmbeddedHistoricalAgencyCode(node.code)}
      : node)};
}

/** Schema 81 stops the literal coverage checks from假失败 on high-quality concrete storyboards.
 * The old shot prompt said “逐字落实为真实动作”，which the writer read as “paraphrase into a
 * concrete action”，so it declared its own wording (抱起布匹) and the outline's observable/mustShow
 * anchors (百姓整理货物、传唱动作) never matched literally—three substring checks all failed on a
 * storyboard that actually filmed everything. The prompt now requires each anchor to be carried
 * verbatim into both beatDramaturgy and the actual prompt. It also re-embeds the agency guard whose
 * principalResentment span no longer misreads a 对…周福…的…不满 nominalized clause (the guests'
 * grievance about a ballad) as the patron's own resentment. */
export function upgradeShotAnchorVerbatimCoverage<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=81)return workflow;
  return {...workflow,schemaVersion:81,nodes:workflow.nodes.map(node=>{
    if(node.id==='sanguo-shot-script')return {...node,prompt:SANGUO_CINEMATIC_STORYBOARD_PROMPT};
    if(['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code)return {...node,code:refreshEmbeddedHistoricalAgencyCode(node.code)};
    return node;
  })};
}

/** Schema 82 stops the dramaturgy report from假失败 on a mislabeled itemId. The path+quote are
 * grounded against the candidate, but reviewers routinely copy a line's real path while tagging a
 * different scene id (scene-03's dialogue labeled scene-05). The old check ordered them to rewrite
 * the path, which only produced a second defect because the quote is not in the mislabeled scene, so
 * a two-defect report never converged under error_branch maxAttempts=2 (verified: a real retry went
 * 6→2 defects then stalled). The embedded validator now derives the scene from the grounded path and
 * corrects itemId to it; the per-scene coverage check still holds every scene accountable. */
export function upgradeDramaturgyEvidencePathGrounding<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=82)return workflow;
  return {...workflow,schemaVersion:82,nodes:workflow.nodes.map(node=>
    ['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code
      ? {...node,code:refreshEmbeddedDramaturgyReviewCode(node.code)}
      : node)};
}

/** Schema 83 gives the audio-visual coverage gate the explicit channels the historical citation gate
 * already has. 逐场必证 used to be the only allowed answer, so a 21-segment outline could never
 * converge under maxAttempts=2: the reviewer emitted 18~19 grounded rows covering 13~14 segments and
 * clustered on the dialogue-bearing scenes, skipping the wordless transition beats (verified on
 * record-r93dr0; both calls returned stop_reason=end_turn, so output length was not the limit). The
 * report now also accepts a per-scene `uncovered:{itemId,reason,coveredBy}` statement naming an
 * already cited segment of the same dramaticScene, keeps the floor that every dramaticScene carries
 * at least one citation, and refuses exemptions on the first/last segment and on the owners of the
 * opening promise and closing payoff. Silence is still a defect: the gate never guesses which
 * segments a citation covers, and the candidate is untouched by a report repair. */
export function upgradeDramaturgyCoverageChannels<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=83)return workflow;
  return {...workflow,schemaVersion:83,nodes:workflow.nodes.map(node=>{
    if(['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id))return {...node,prompt:refreshHistoricalSourceReviewPrompt(refreshDramaturgyReviewPrompt(node.prompt))};
    if(['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code)return {...node,code:refreshEmbeddedDramaturgyReviewCode(node.code)};
    return node;
  })};
}

/** Reviewers keep rejecting correctly declared dramatization: “正史没写这句对白、这个神情” or
 * “台词应标（拟制）”. The generator contract forbids the opposite — a fictional-dialogue tag must
 * never enter spoken text, and adaptationSpace.policy already declares every line as reasonable
 * dramatization — so obeying such advice guarantees the next rejection, and refusing it burns the
 * writer's whole paid budget on an unfixable complaint (verified on record-14lmio). */
export const FICTION_BOUNDARY_REVIEW_PROMPT = `【拟制边界与修复建议规则 v1】
adaptationSpace.policy/sourceLevel 与本场景 adaptationBoundary 已完成的声明就是本集拟制边界。不得要求把“（拟制）”“【拟制对白】”等字样写进对白、audioText、videoPrompt 或画面文字，也不得以缺少这类标注作为通过条件：标注进入台词会让候选违反生成契约。
“史料没有记载这句日常对白、神情、礼貌应答、内心反应或某个具体动作”本身不是史实矛盾。候选已声明为合理拟制，且行动主体、因果、先后、结果与名言原文均未改变时，最多写 warnings，禁止进入 issues。
人物以自己口吻转述既有歌谣、诏令或传闻是转述而非宣称原创；用词与原文不完全一致或“可能让观众误以为是本人所作”不构成拒绝，除非候选明确把该言论标成史料记载的本人发言。
每条 repair 只给一项可执行的最小修复，禁止并列互斥方案（如“删掉这句台词，或补一个拟制标注”）；不得在后续尝试中推翻本报告已经判定合格的字段。
【拟制边界与修复建议规则结束】`;

/** Refresh only the bounded block, keeping any hand-written reviewer rules. */
export function refreshFictionBoundaryReviewPrompt(prompt: string) {
  const start = '【拟制边界与修复建议规则 v1】', end = '【拟制边界与修复建议规则结束】';
  if (!prompt.includes(start)) return prompt + '\n' + FICTION_BOUNDARY_REVIEW_PROMPT;
  if (!prompt.includes(end)) throw Error('Cannot safely refresh incomplete fiction-boundary instruction block');
  return prompt.replace(/【拟制边界与修复建议规则 v1】[\s\S]*?【拟制边界与修复建议规则结束】/g, FICTION_BOUNDARY_REVIEW_PROMPT);
}

export function upgradeFictionBoundaryReviewRules<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=84)return workflow;
  return {...workflow,schemaVersion:84,nodes:workflow.nodes.map(node=>
    ['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id)
      ? {...node,prompt:refreshFictionBoundaryReviewPrompt(refreshHistoricalSourceReviewPrompt(refreshDramaturgyReviewPrompt(node.prompt)))}
      : node)};
}

/** Schema 85 lets one review report actually converge. Every gate report has to ground each of its
 * rows against the candidate, so a long outline report routinely carries several independent locator
 * slips, and with maxAttempts=2 the branch threw 异常复核达到上限 2 after a single fix attempt (four
 * times in two days, once on a report that had already gone 6 defects → 2). A report repair rebuys
 * only the reviewer call — the candidate and its paid generation stay untouched — so the attempt
 * budget is the cheap side of that trade. Only the shipped default 2 is raised, so a hand-tuned
 * value survives, and the two gates re-embed the validator that no longer rejects report bookkeeping
 * it can correct itself. */
export function upgradeReviewReportRecoveryBudget<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=85)return workflow;
  return {...workflow,schemaVersion:85,nodes:workflow.nodes.map(node=>{
    if(['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code)return {...node,code:refreshEmbeddedDramaturgyReviewCode(node.code)};
    if(node.kind!=='branch'||!node.params.some(item=>item.englishName==='patterns'&&item.value.includes('REVIEW_RESULT_INVALID:')))return node;
    return {...node,params:node.params.map(item=>item.englishName==='maxAttempts'&&item.value==='2'?{...item,value:'4'}:item)};
  })};
}

/** Schema 86 stops the coverage defect before it is bought. A 21-scene outline report cited only 14
 * scenes and stalled the branch at 异常复核达到上限 (record-r93dr0, and again in record-or4n54); the
 * misses sat in the middle of the list, so no number of retries fixes a reviewer that loses count.
 * The shipped rule now states the order of work — one grounded row per scene, front to back, then
 * verify the cited ids against the candidate — which is a bookkeeping procedure, not a lower bar:
 * every row is still checked verbatim against the candidate by the gate. Only the two reviewers
 * change, and only inside the delimited dramaturgy block, so custom text outside it is preserved. */
export function upgradeReviewerCoverageChecklist<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=86)return workflow;
  return {...workflow,schemaVersion:86,nodes:workflow.nodes.map(node=>
    ['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id)
      ? {...node,prompt:refreshDramaturgyReviewPrompt(node.prompt)}
      : node)};
}

/** Schema 87 stops spending a paid re-review on a comma. The gate compared each citation byte for byte,
 * but the outline emits half-width “,”“?” while the reviewer transcribes the full-width forms of the
 * identical sentence, so in record-l2t6gi three of four “引文不在候选声画原文中” defects were pure
 * glyph differences and repeated verbatim in all four attempts — the message named neither side, so
 * there was nothing to copy. Citations now fold punctuation variants onto one glyph (words, digits and
 * spacing still have to match, so a restated line is still a defect) and every remaining locator defect
 * prints the cited text, the real text and where the quote actually lives. Only the two gates re-embed
 * the validator; no reviewer rule, generation input or approval standard moves. */
export function upgradeDramaturgyQuoteTypography<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=87)return workflow;
  return {...workflow,schemaVersion:87,nodes:workflow.nodes.map(node=>
    ['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code
      ? {...node,code:refreshEmbeddedDramaturgyReviewCode(node.code)}
      : node)};
}

/** Schema 88 re-embeds the agency guard that now names the field it rejected. The guard scans purpose,
 * beat function and stateChange along with the filmed text, but its message only restated the rule, so
 * record-vrwgoy carried the same requiredBeats[2].function “呈现房植的矜持和内心波动,暗示其默许宾客行动”
 * through all four paid outline generations — nothing in the feedback told the writer which field to
 * open, and the repair recipe forbade editing the intent fields the guard reads. The rejection now
 * quotes the path and sentence, and the recipe names those same fields as the required edit.
 * Rejection conditions are unchanged: the guard still refuses the same causal fabrication. */
export function upgradeHistoricalAgencySourceCitation<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=88)return workflow;
  return {...workflow,schemaVersion:88,nodes:workflow.nodes.map(node=>
    ['sanguo-scene-outline-accept','sanguo-shot-script-accept'].includes(node.id)&&node.code
      ? {...node,code:refreshEmbeddedHistoricalAgencyCode(node.code)}
      : node)};
}

const IDLE_TAIL_GATE_CODE = "if (!pacing.passed || e.duration - pacing.lastMeaningfulActionSecond > params.maxIdleTailSeconds) issues.push('节奏未通过或尾部空等');";
const IDLE_TAIL_PASSED_CODE = 'const passed = review.passed && issues.length === 0;';
const IDLE_TAIL_RETURN_ANCHOR = 'technicalValidation: {passed,';
const IDLE_TAIL_REVIEW_CLAUSE = '尾部空等属于剪辑裁尾缺陷：逐句都在程序派生 allowedSpan 内时，只写进 pacingReview 与 tailTimingCheck，不要把同一件事重复列进 issues 来要求重拍整镜。';

/** Install the idle-tail policy on older gates. Schema92 corrected the original
 * implementation: a proposed edit now blocks acceptance until it is applied. */
export function upgradeIdleTailEditDecision<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=89)return workflow;
  let changed=false;
  let reviewerTold=false;
  const nodes=workflow.nodes.map(node=>{
    if(node.id==='sanguo-media-accept'&&node.code&&node.code.includes(IDLE_TAIL_GATE_CODE)&&!node.code.includes('trimmableIdleTail')){
      changed=true;
      return {...node,code:node.code.replace(IDLE_TAIL_GATE_CODE,IDLE_TAIL_EDIT_CODE.trim())
        .replace(IDLE_TAIL_PASSED_CODE,IDLE_TAIL_FINAL_DECISION_CODE)
        .replace(IDLE_TAIL_RETURN_ANCHOR,'warnings, tailTrim, '+IDLE_TAIL_RETURN_ANCHOR)};
    }
    if(node.id==='sanguo-media-review'&&node.prompt.includes('禁止擅自建立更严格的阈值。')&&!node.prompt.includes(IDLE_TAIL_REVIEW_CLAUSE)){
      reviewerTold=true;
      return {...node,prompt:node.prompt.replace('禁止擅自建立更严格的阈值。','禁止擅自建立更严格的阈值。'+IDLE_TAIL_REVIEW_CLAUSE)};
    }
    return node;
  });
  // The version only advances when this upgrade really rewrote the gate, so a hand-edited gate that no longer
  // carries the anchored pacing rule keeps its own schema version instead of claiming a rule it does not have.
  // A reviewer prompt that was the only thing to publish stays at the version the workflow already declares.
  if(!changed&&!reviewerTold)return workflow;
  return {...workflow,schemaVersion:changed?89:workflow.schemaVersion,nodes};
}

/** Schema 90 keeps uncertainty reasons without promoting them to observed facts.
 * Only replace the shipped guard; preserve custom gate edits and every other node. */
export function upgradeUnknownWorldStateEvidence<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=90)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  if(!gate?.code||(!gate.code.includes(LEGACY_CINEMATIC_WORLD_FACT_GUARD_CODE)&&!gate.code.includes(CINEMATIC_WORLD_FACT_GUARD_CODE)))return workflow;
  const nodes=workflow.nodes.map(node=>node!==gate?node:{...node,code:node.code!.replace(LEGACY_CINEMATIC_WORLD_FACT_GUARD_CODE,CINEMATIC_WORLD_FACT_GUARD_CODE)});
  return {...workflow,schemaVersion:90,nodes};
}

/** Publish the general observation contract and opt-in normalized model inputs.
 * Existing user-authored observation prompts are preserved. */
export function upgradeGroundedMediaObservation<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=91)return workflow;
  const nodes=workflow.nodes.map(node=>{
    if(node.id==='sanguo-media-observe'&&node.prompt===FRAME_OBSERVATION_PROMPT)
      return {...node,prompt:GROUNDED_FRAME_OBSERVATION_PROMPT};
    if(node.id==='sanguo-media-review')return {...node,
      prompt:refreshMediaAttributionReviewPrompt(node.prompt),
      params:node.params.some(param=>(param.englishName||param.name)==='promptInputMode')?node.params:
        [...node.params,p('promptInputMode','normalized-results','text')]};
    return node;
  });
  return {...workflow,schemaVersion:91,nodes};
}

/** Schema92 removes the old natural-language veto deletion and acceptance
 * override. The exact shipped pair is migrated atomically; custom code is kept. */
export function upgradePendingMediaEditGate<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=92)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  if(!gate?.code)return workflow;
  const oldDecision='const passed = (review.passed || trimmableIdleTail) && issues.length === 0;';
  const alreadyCurrent=gate.code.includes(IDLE_TAIL_EDIT_CODE.trim())&&gate.code.includes(IDLE_TAIL_FINAL_DECISION_CODE);
  const shippedLegacy=gate.code.includes(LEGACY_IDLE_TAIL_EDIT_CODE.trim())&&gate.code.includes(oldDecision);
  if(!alreadyCurrent&&!shippedLegacy)return workflow;
  const nodes=workflow.nodes.map(node=>node!==gate?node:{...node,code:alreadyCurrent?node.code:
    node.code!.replace(LEGACY_IDLE_TAIL_EDIT_CODE.trim(),IDLE_TAIL_EDIT_CODE.trim()).replace(oldDecision,IDLE_TAIL_FINAL_DECISION_CODE)});
  return {...workflow,schemaVersion:92,nodes};
}

const LEGACY_MEDIA_DEFECT_ISSUES_CODE = "const issues = [...review.issues, ...review.visualChecks.filter(c=>!c.consistent).map(c=>c.character+'道具不符：'+c.evidence)];";
export const MEDIA_DEFECT_EVIDENCE_CODE = String.raw`// media-defect-evidence-v1
const resolveNativeFrameDisplayInterval = (${resolveNativeFrameDisplayInterval.toString()});
const mediaDefects = ${mediaRuntimeCode(validateMediaDefectEvidence)}(review,e);
const issues = [...mediaDefects.issues];
const reportRepairPrompt = mediaDefects.retryPrompt || review.retryPrompt;
// /media-defect-evidence-v1`;

/** Schema93 binds each model refusal to its own actual evidence. Only the
 * shipped issue assembly and repair aliases are refreshed; code-derived
 * technical, action and continuity defects keep their existing gates. */
export function upgradeConfirmedMediaDefects<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=93)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  if(!gate?.code)return workflow;
  const current=gate.code.includes(MEDIA_DEFECT_EVIDENCE_CODE);
  const legacy=gate.code.includes(LEGACY_MEDIA_DEFECT_ISSUES_CODE)&&gate.code.includes('retryPrompt: review.retryPrompt')
    &&gate.code.includes('!review.retryPrompt?.trim() || review.retryPrompt.length > params.maxRepairChars');
  if(!current&&!legacy)return workflow;
  const nodes=workflow.nodes.map(node=>{
    if(node===gate&&!current)return {...node,code:node.code!.replace(LEGACY_MEDIA_DEFECT_ISSUES_CODE,MEDIA_DEFECT_EVIDENCE_CODE)
      .replace('!review.retryPrompt?.trim() || review.retryPrompt.length > params.maxRepairChars','!reportRepairPrompt?.trim() || reportRepairPrompt.length > params.maxRepairChars')
      .replace('retryPrompt: review.retryPrompt','retryPrompt: reportRepairPrompt')};
    if(node.id==='sanguo-media-review')return {...node,prompt:refreshMediaDefectEvidencePrompt(node.prompt)};
    return node;
  });
  return {...workflow,schemaVersion:93,nodes};
}

/** Detail sampling is a text-node attachment option, independent of content or provider. */
export function upgradeMediaReviewDetails<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=94)return workflow;
  return {...workflow,schemaVersion:94,nodes:workflow.nodes.map(node=>node.id!=='sanguo-media-review'?node:{...node,
    prompt:refreshMediaDetailReviewPrompt(node.prompt),
    params:node.params.some(param=>(param.englishName||param.name)==='reviewImageDetail')?node.params:
      [...node.params,p('reviewImageDetail',JSON.stringify({indices:[0],columns:2,rows:2,overlap:.25}))]})};
}

export function upgradeIndependentMediaEvidence<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=95)return workflow;
  return {...workflow,schemaVersion:95,nodes:workflow.nodes.map(node=>node.id==='sanguo-media-review'
    ? {...node,prompt:refreshIndependentMediaReviewPrompt(node.prompt)}:node)};
}

export const SCOPED_MEDIA_DEFECT_EVIDENCE_CODE = String.raw`// media-defect-evidence-v2
const resolveNativeFrameDisplayInterval = (${resolveNativeFrameDisplayInterval.toString()});
const validateScriptStateEvidence = (${validateScriptStateEvidence.toString()});
const mediaDefects = ${mediaRuntimeCode(validateMediaDefectEvidence)}(review,e,{shot,metrics:context.media_metrics,policy:params});
const issues = [...mediaDefects.issues];
const reportRepairPrompt = mediaDefects.retryPrompt || review.retryPrompt;
// /media-defect-evidence-v2`;

/** Keep the authored shot and paid outputs intact. Evidence now binds a defect
 * to the actual requirement and interval; image-only instructions stay out of
 * the opt-in motion prompt. Only the marked shipped guard is replaced. */
export function upgradeScopedMediaDefects<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=96)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const guard=/\/\/ media-defect-evidence-v([12])\n[\s\S]*?\/\/ \/media-defect-evidence-v\1/;
  if(!gate?.code||!guard.test(gate.code))return workflow;
  return {...workflow,schemaVersion:96,nodes:workflow.nodes.map(node=>{
    if(node===gate)return {...node,code:node.code!.replace(guard,()=>SCOPED_MEDIA_DEFECT_EVIDENCE_CODE)};
    if(node.id==='sanguo-media-review')return {...node,prompt:refreshScopedMediaDefectPrompt(refreshIndependentMediaReviewPrompt(node.prompt))};
    if(node.id==='sanguo-video'&&!node.params.some(param=>(param.englishName||param.name)==='promptInputMode'))
      return {...node,params:[...node.params,p('promptInputMode','motion-state','text')]};
    return node;
  })};
}

const LIVE_MEDIA_POLICY_PROMPT = '【本次实际门禁配置】${params.reviewPolicy}\n所有阈值以该配置和media_metrics.policy为准，不自行猜测或另设更严阈值。审核报告不能把ASR字形误识别当作确证错音。\n';

/** Review and validation read the same effective policy, including per-run
 * overrides. Refresh all independent report errors together on the same media. */
export function upgradeLiveMediaPolicy<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=97)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const guard=/\/\/ media-defect-evidence-v2\n[\s\S]*?\/\/ \/media-defect-evidence-v2/;
  if(!gate?.code||!guard.test(gate.code))return workflow;
  return {...workflow,schemaVersion:97,nodes:workflow.nodes.map(node=>{
    if(node===gate)return {...node,code:node.code!.replace(guard,()=>SCOPED_MEDIA_DEFECT_EVIDENCE_CODE)};
    if(node.id!=='sanguo-media-review')return node;
    return {...node,prompt:node.prompt.includes('【本次实际门禁配置】')?node.prompt:LIVE_MEDIA_POLICY_PROMPT+node.prompt,
      params:node.params.some(param=>(param.englishName||param.name)==='reviewPolicySource')?node.params:
        [...node.params,p('reviewPolicySource',JSON.stringify({nodeId:gate.id,fields:['maxPhoneticErrorRate','timingTolerance','maxIdleTailSeconds','tailSeconds','maxRepairChars']}))]};
  })};
}

export const MEDIA_REQUIREMENT_METRICS_CODE = String.raw`// media-requirement-list-v1
const requirements = ${mediaRuntimeCode(deriveMediaRequirements)}(shot);
// /media-requirement-list-v1`;

export const COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE = String.raw`// media-defect-evidence-v3
const deriveMediaRequirements = ${mediaRuntimeCode(deriveMediaRequirements)};
const resolveNativeFrameDisplayInterval = (${resolveNativeFrameDisplayInterval.toString()});
const validateScriptStateEvidence = (${validateScriptStateEvidence.toString()});
const validateMediaEvidenceGaps = (${validateMediaEvidenceGaps.toString()});
const {requirementCoverage,mediaDefects} = (${validateReviewParts.toString()})({
 requirementCoverage:()=>${mediaRuntimeCode(validateMediaRequirementChecks)}(review,shot,e,params),
 mediaDefects:()=>${mediaRuntimeCode(validateMediaDefectEvidence)}(review,e,{shot,metrics:context.media_metrics,policy:params})
});
if(requirementCoverage.blockingUnobservableRequirements.length&&!mediaDefects.issues.length)throw Error('REVIEW_RESULT_INVALID: 原要求仍不可观察且没有已确证拒绝依据：'+JSON.stringify(requirementCoverage.blockingUnobservableRequirements)+'；补充同素材采证，不购买新视频');
const issues = [...new Set([...mediaDefects.issues,...requirementCoverage.issues])];
const reportRepairPrompt = [...new Set([mediaDefects.retryPrompt,requirementCoverage.retryPrompt].filter(Boolean))].join('；') || review.retryPrompt;
// /media-defect-evidence-v3`;

/** Inventory every authored interval and endpoint before review, so an omitted
 * obligation cannot disappear merely because the model only listed warnings. */
export function upgradeCompleteMediaRequirements<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=98)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const metrics=workflow.nodes.find(node=>node.id==='sanguo-media-metrics');
  const reviewer=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const guard=/\/\/ media-defect-evidence-v([23])\n[\s\S]*?\/\/ \/media-defect-evidence-v\1/;
  const metricsReturn='return {tailTiming,frames:';
  if(!gate?.code||!guard.test(gate.code)||!metrics?.code||!reviewer
    ||(!metrics.code.includes(metricsReturn)&&!metrics.code.includes('// media-requirement-list-v1'))
    ||(!reviewer.prompt.includes('【缺陷需求范围与语音证据 v1】')&&!reviewer.prompt.includes('【独立成片验收完整契约 v1】')))return workflow;
  return {...workflow,schemaVersion:98,nodes:workflow.nodes.map(node=>{
    if(node===gate)return {...node,code:node.code!.replace(guard,()=>COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE)};
    if(node===metrics)return node.code!.includes('// media-requirement-list-v1')?node:
      {...node,code:node.code!.replace(metricsReturn,()=>MEDIA_REQUIREMENT_METRICS_CODE+'\nreturn {requirements,tailTiming,frames:')};
    if(node===reviewer)return {...node,prompt:CANONICAL_MEDIA_REVIEW_PROMPT};
    return node;
  })};
}

/** Coverage can identify omissions, but every retake must still pass the same
 * typed defect validator and its actual visual/speech evidence requirements. */
export function upgradeBoundMediaRequirements<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=99)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const reviewer=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const guard=/\/\/ media-defect-evidence-v3\n[\s\S]*?\/\/ \/media-defect-evidence-v3/;
  if(!gate?.code||!guard.test(gate.code)||!reviewer||!isCanonicalMediaReviewPrompt(reviewer.prompt))return workflow;
  return {...workflow,schemaVersion:99,nodes:workflow.nodes.map(node=>node===gate
    ? {...node,code:node.code!.replace(guard,()=>COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE)}
    :node===reviewer?{...node,prompt:CANONICAL_MEDIA_REVIEW_PROMPT}:node)};
}

/** Publish all report diagnostics together, including actual valid frame/time
 * choices. No change to the evidence bounds or paid retry policy. */
export function upgradeCompleteMediaDiagnostics<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=100)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const guard=/\/\/ media-defect-evidence-v3\n[\s\S]*?\/\/ \/media-defect-evidence-v3/;
  if(!gate?.code||!guard.test(gate.code))return workflow;
  return {...workflow,schemaVersion:100,nodes:workflow.nodes.map(node=>node===gate
    ? {...node,code:node.code!.replace(guard,()=>COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE)}
    :node.id==='sanguo-media-review'&&isCanonicalMediaReviewPrompt(node.prompt)?{...node,prompt:CANONICAL_MEDIA_REVIEW_PROMPT}:node)};
}

export const MEDIA_SAMPLING_REQUEST_CODE = String.raw`// media-sampling-plan-v1
const deriveMediaRequirements = ${mediaRuntimeCode(deriveMediaRequirements)};
const samplingPlan = ${mediaRuntimeCode(deriveMediaSamplingPlan)}(shot,{maxFrames:params.maxSamplingFrames});
// /media-sampling-plan-v1`;

/** Sample each authored action window before claiming it was observable; this
 * reuses actual media and preserves all prior evidence files and paid outputs. */
export function upgradeRequirementMediaSampling<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=101)return workflow;
  const request=workflow.nodes.find(node=>node.id==='sanguo-media-request');
  const evidence=workflow.nodes.find(node=>node.id==='sanguo-video-evidence');
  const observer=workflow.nodes.find(node=>node.id==='sanguo-media-observe');
  const anchor='return { audioType:shot.audioType,speechRequired,';
  if(!request?.code||!request.code.includes(anchor)||evidence?.request?.url!=='/api/video-evidence'
    ||observer?.mapInput?.sourcePath!=='media_metrics.frames')return workflow;
  return {...workflow,schemaVersion:101,nodes:workflow.nodes.map(node=>node===request
    ? {...node,code:node.code!.replace(anchor,()=>MEDIA_SAMPLING_REQUEST_CODE+'\nreturn { sampleTimes:samplingPlan.sampleTimes,samplingPlan,audioType:shot.audioType,speechRequired,'),
      params:node.params.some(param=>(param.englishName||param.name)==='maxSamplingFrames')?node.params:[...node.params,p('maxSamplingFrames','24','number')]}
    :node===evidence?{...node,params:node.params.some(param=>(param.englishName||param.name)==='sampleTimes')?node.params:[...node.params,p('sampleTimes','${media_request.sampleTimes}')]}
    :node===observer?{...node,mapInput:{...node.mapInput,concurrency:node.mapInput?.concurrency??4}}
    :node.id==='sanguo-media-accept'&&node.code?.includes('// media-defect-evidence-v3')&&!node.code.includes(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE)?{...node,code:node.code.replace(/\/\/ media-defect-evidence-v3\n[\s\S]*?\/\/ \/media-defect-evidence-v3/,()=>COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE)}:node)};
}

export const REQUIREMENT_REVIEW_METRICS_CODE = String.raw`// media-requirement-review-input-v1
const requirementReviewInputs = (() => {
 const deriveMediaRequirements = ${mediaRuntimeCode(deriveMediaRequirements)};
 const resolveNativeFrameDisplayInterval = (${resolveNativeFrameDisplayInterval.toString()});
 return ${mediaRuntimeCode(deriveRequirementReviewInputs)}(shot,evidence);
})();
// /media-requirement-review-input-v1`;

export const INDEPENDENT_MEDIA_REVIEW_VIEW_CODE = String.raw`// independent-media-review-view-v1
const e = context.video_evidence, shot = context.shot_script;
const review = (() => {
 const deriveMediaRequirements = ${mediaRuntimeCode(deriveMediaRequirements)};
 const resolveNativeFrameDisplayInterval = (${resolveNativeFrameDisplayInterval.toString()});
 const validateScriptStateEvidence = (${validateScriptStateEvidence.toString()});
 const validateMediaEvidenceGaps = (${validateMediaEvidenceGaps.toString()});
 const inputs = ${mediaRuntimeCode(deriveRequirementReviewInputs)}(shot,e);
 return ${mediaRuntimeCode(combineIndependentMediaReviews)}(context.media_review,context.media_requirement_reviews,inputs,params);
})();
// /independent-media-review-view-v1`;

/** One bounded visual request per authored requirement, with local attachment
 * indexes mapped back to actual evidence. The primary report remains intact. */
export function upgradeIndependentRequirementReview<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=102)return workflow;
  const observer=workflow.nodes.find(node=>node.id==='sanguo-media-observe');
  const reviewer=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const metrics=workflow.nodes.find(node=>node.id==='sanguo-media-metrics');
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const newId='sanguo-requirement-review';
  const gateAnchor='const e = context.video_evidence, review = context.media_review, shot = context.shot_script;';
  const metricsAnchor='return {requirements,tailTiming,frames:';
  if(!observer||!reviewer||!gate?.code?.includes(gateAnchor)||!metrics?.code?.includes(metricsAnchor)
    ||workflow.nodes.some(node=>node.id===newId)
    ||workflow.edges.filter(edge=>edge.from===observer.id&&edge.to===reviewer.id).length!==1)return workflow;
  const requirementReviewer={...observer,id:newId,title:'原要求逐项画面审核',resultVar:'media_requirement_reviews',
    modelId:reviewer.modelId,operation:undefined,prompt:REQUIREMENT_MEDIA_REVIEW_PROMPT,outputMode:'json',
    position:{x:observer.position.x+140,y:observer.position.y+230},
    mapInput:{sourcePath:'media_metrics.requirementReviewInputs',itemVar:'requirementInput',maxItems:24,concurrency:4},
    params:[p('reviewImages','${requirementInput.reviewImages}'),p('temperature','0','number'),p('promptInputMode','normalized-results','text')]} as N;
  const nodes=workflow.nodes.flatMap(node=>{
    if(node===observer)return [node,requirementReviewer];
    if(node===metrics)return [{...node,code:node.code!.replace(metricsAnchor,()=>REQUIREMENT_REVIEW_METRICS_CODE+'\nreturn {requirementReviewInputs,requirements,tailTiming,frames:')}];
    if(node===gate)return [{...node,code:node.code!.replace(gateAnchor,()=>INDEPENDENT_MEDIA_REVIEW_VIEW_CODE),
      ...(node.errorRetry?.retryFrom===reviewer.id?{errorRetry:{...node.errorRetry,retryFrom:newId}}:{})}];
    if(node.childIds?.includes(observer.id))return [{...node,childIds:node.childIds.flatMap(id=>id===observer.id?[id,newId]:[id])}];
    return [node];
  });
  const edges=workflow.edges.map(edge=>edge.to===reviewer.id&&(edge.from===observer.id||edge.from===gate.id+'-error-branch')?{...edge,to:newId}:edge);
  edges.push({id:newId+'-to-media-review',from:newId,to:reviewer.id});
  return {...workflow,schemaVersion:102,nodes,edges};
}

/** Make unsupported interpretations repair the report, with exact original
 * state quotes and overlapping requirements available as compatibility checks. */
export function upgradeLiteralRequirementReview<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=103)return workflow;
  const requirementReviewer=workflow.nodes.find(node=>node.id==='sanguo-requirement-review');
  const reviewer=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const metrics=workflow.nodes.find(node=>node.id==='sanguo-media-metrics');
  const viewBlock=/\/\/ independent-media-review-view-v1\n[\s\S]*?\/\/ \/independent-media-review-view-v1/;
  const inputBlock=/\/\/ media-requirement-review-input-v1\n[\s\S]*?\/\/ \/media-requirement-review-input-v1/;
  if(!requirementReviewer?.prompt.startsWith('你是独立的单项画面验收员')||!reviewer||!isCanonicalMediaReviewPrompt(reviewer.prompt)
    ||!gate?.code||!viewBlock.test(gate.code)||!metrics?.code||!inputBlock.test(metrics.code))return workflow;
  return {...workflow,schemaVersion:103,nodes:workflow.nodes.map(node=>node===requirementReviewer?{...node,prompt:REQUIREMENT_MEDIA_REVIEW_PROMPT}
    :node===reviewer?{...node,prompt:node.prompt.replace(/【独立成片验收完整契约 v1】[\s\S]*?【独立成片验收完整契约结束】/,()=>CANONICAL_MEDIA_REVIEW_PROMPT)}
    :node===gate?{...node,code:node.code!.replace(viewBlock,()=>INDEPENDENT_MEDIA_REVIEW_VIEW_CODE)}
    :node===metrics?{...node,code:node.code!.replace(inputBlock,()=>REQUIREMENT_REVIEW_METRICS_CODE)}:node)};
}

/** The return edge revisits the whole review group. Each reviewer must receive
 * its own previous report and the gate diagnosis when its turn is replayed. */
export function upgradeMediaReviewRetryGroup<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=104)return workflow;
  const first=workflow.nodes.find(node=>node.id==='sanguo-requirement-review');
  const primary=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const branch=workflow.nodes.find(node=>node.id==='sanguo-media-accept-error-branch');
  const metrics=workflow.nodes.find(node=>node.id==='sanguo-media-metrics');
  const inputBlock=/\/\/ media-requirement-review-input-v1\n[\s\S]*?\/\/ \/media-requirement-review-input-v1/;
  const viewBlock=/\/\/ independent-media-review-view-v1\n[\s\S]*?\/\/ \/independent-media-review-view-v1/;
  if(first?.kind!=='text'||primary?.kind!=='text'||!gate?.code?.includes('// independent-media-review-view-v1'))return workflow;
  const targets=[first.id,primary.id];
  if(branch && (branch.kind!=='branch'||!workflow.edges.some(edge=>edge.from===branch.id&&edge.to===first.id)))return workflow;
  if(!branch && gate.errorRetry?.retryFrom!==first.id)return workflow;
  return {...workflow,schemaVersion:104,nodes:workflow.nodes.map(node=>{
    if(node===branch)return {...node,params:node.params.some(param=>(param.englishName||param.name)==='reviewRetryTargets')?node.params:[...node.params,p('reviewRetryTargets',JSON.stringify(targets))]};
    if(node===first&&node.prompt.startsWith('你是独立的单项画面验收员'))return {...node,prompt:REQUIREMENT_MEDIA_REVIEW_PROMPT};
    if(node===metrics&&node.code&&inputBlock.test(node.code))return {...node,code:node.code.replace(inputBlock,()=>REQUIREMENT_REVIEW_METRICS_CODE)};
    if(node===gate)return {...node,code:node.code!.replace(viewBlock,()=>INDEPENDENT_MEDIA_REVIEW_VIEW_CODE),
      ...(node.errorRetry?{errorRetry:{...node.errorRetry,reviewRetryTargets:node.errorRetry.reviewRetryTargets??targets}}:{})};
    return node;
  })};
}

export const UNCERTAIN_MEDIA_REVIEW_GUARD_CODE = String.raw`// media-uncertainty-diagnostic-v1
if (review.decision === 'uncertain') invalid((() => {
 const deriveMediaRequirements = ${mediaRuntimeCode(deriveMediaRequirements)};
 return ${mediaRuntimeCode(uncertainMediaReviewDiagnostic)}(review,shot);
})());
// /media-uncertainty-diagnostic-v1`;

/** Preserve every report, but require the same state proof from both reviewers
 * before a refusal can purchase another video. Unknown diagnoses remain blocked. */
export function upgradeMediaStateEvidence<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=105)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const reviewer=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const guard=/\/\/ media-defect-evidence-v3\n[\s\S]*?\/\/ \/media-defect-evidence-v3/;
  const viewBlock=/\/\/ independent-media-review-view-v1\n[\s\S]*?\/\/ \/independent-media-review-view-v1/;
  const unknownGuard="if (review.decision === 'uncertain') invalid('证据不足，补充采证或重跑审查；不能因此购买新视频');";
  if(!gate?.code||!guard.test(gate.code)||!viewBlock.test(gate.code)||!gate.code.includes(unknownGuard)
    ||!reviewer||!isCanonicalMediaReviewPrompt(reviewer.prompt))return workflow;
  return {...workflow,schemaVersion:105,nodes:workflow.nodes.map(node=>{
    if(node===gate)return {...node,code:node.code!.replace(guard,()=>COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE)
      .replace(viewBlock,()=>INDEPENDENT_MEDIA_REVIEW_VIEW_CODE).replace(unknownGuard,()=>UNCERTAIN_MEDIA_REVIEW_GUARD_CODE),
      params:node.params.some(param=>(param.englishName||param.name)==='requireScriptStateEvidence')?node.params:[...node.params,p('requireScriptStateEvidence','true','boolean')]};
    if(node!==reviewer)return node;
    return {...node,prompt:node.prompt.replace(/【独立成片验收完整契约 v1】[\s\S]*?【独立成片验收完整契约结束】/,()=>CANONICAL_MEDIA_REVIEW_PROMPT),
      params:node.params.map(param=>{
        if((param.englishName||param.name)!=='reviewPolicySource')return param;
        let source;try{source=JSON.parse(param.value)}catch{return param}
        if(source?.nodeId!==gate.id||!Array.isArray(source.fields)||source.fields.includes('requireScriptStateEvidence'))return param;
        return {...param,value:JSON.stringify({...source,fields:[...source.fields,'requireScriptStateEvidence']})};
      })};
  })};
}

export const ADAPTIVE_MEDIA_REVIEW_GUARD_CODE = String.raw`// media-uncertainty-diagnostic-v2
if (review.decision === 'uncertain') {
 const deriveMediaRequirements = ${mediaRuntimeCode(deriveMediaRequirements)};
 const resolveNativeFrameDisplayInterval = (${resolveNativeFrameDisplayInterval.toString()});
 const validateMediaEvidenceGaps = (${validateMediaEvidenceGaps.toString()});
 const validateMediaRequirementChecks = ${mediaRuntimeCode(validateMediaRequirementChecks)};
 const samplingView = ${mediaRuntimeCode(deriveMediaSamplingReview)}(context.media_review,review,shot,e,params);
 const samplingRetryPlan = ${mediaRuntimeCode(deriveAdaptiveMediaSamplingPlan)}(shot,e,samplingView,
  {maxFrames:params.maxAdaptiveSamplingFrames,maxRounds:params.maxAdaptiveSamplingRounds,nativeSequence:params.nativeSequenceEvidence,nativeReviewMaxFrames:params.maxNativeReviewFrames},context.mediaSamplingRetry??undefined);
 return {routeError:'REVIEW_RESULT_INVALID: '+${mediaRuntimeCode(uncertainMediaReviewDiagnostic)}(review,shot),samplingRetryPlan};
}
// /media-uncertainty-diagnostic-v2`;

export const ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE = String.raw`// media-sampling-plan-v2
const deriveMediaRequirements = ${mediaRuntimeCode(deriveMediaRequirements)};
let samplingPlan = ${mediaRuntimeCode(deriveMediaSamplingPlan)}(shot,{maxFrames:params.maxSamplingFrames});
const retryPlan = context.mediaSamplingRetry;
if(retryPlan && retryPlan.sourceUrl===context.video_take?.url) {
 if(!Number.isSafeInteger(retryPlan.round)||retryPlan.round<1||!Array.isArray(retryPlan.sampleTimes)
   ||retryPlan.sampleTimes.length<2||retryPlan.sampleTimes.length>samplingPlan.maxFrames
   ||retryPlan.sampleTimes.some((time,index)=>!Number.isFinite(time)||time<0||(index>0&&time<=retryPlan.sampleTimes[index-1]))
   ||retryPlan.sampleTimes[0]!==0)throw Error('MEDIA_SAMPLING_RETRY_INVALID: 同素材补采计划无效；保留原视频并检查采证配置');
 samplingPlan={...samplingPlan,sampleTimes:[...retryPlan.sampleTimes],sourceUrl:retryPlan.sourceUrl,adaptiveRound:retryPlan.round,...(retryPlan.nativeSequence?{nativeSequence:retryPlan.nativeSequence}:{})};
}
// /media-sampling-plan-v2`;

/** Evidence shortage returns to sampling on the existing video. It never
 * routes unknowns to paid generation or silently discards prior samples. */
export function upgradeAdaptiveMediaSampling<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=106)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const request=workflow.nodes.find(node=>node.id==='sanguo-media-request');
  const branch=workflow.nodes.find(node=>node.id==='sanguo-media-accept-error-branch');
  const firstId='sanguo-requirement-review';
  const unknownGuard=/\/\/ media-uncertainty-diagnostic-v1\n[\s\S]*?\/\/ \/media-uncertainty-diagnostic-v1/;
  const planBlock=/\/\/ media-sampling-plan-v1\n[\s\S]*?\/\/ \/media-sampling-plan-v1/;
  if(!gate?.code||!unknownGuard.test(gate.code)||!request?.code||!planBlock.test(request.code))return workflow;
  if(branch && (!branch.code?.includes(REPORT_FORMAT_FEEDBACK_RETURN)||workflow.edges.filter(edge=>edge.from===branch.id&&edge.to===firstId).length!==1))return workflow;
  if(!branch&&gate.errorRetry?.retryFrom!==firstId)return workflow;
  const retryContextSources={mediaSamplingRetry:[gate.resultVar+'.samplingRetryPlan','mediaSamplingRetry']};
  return {...workflow,schemaVersion:106,nodes:workflow.nodes.map(node=>{
    if(node===gate)return {...node,code:node.code!.replace(unknownGuard,()=>ADAPTIVE_MEDIA_REVIEW_GUARD_CODE),
      params:[...node.params,...(!node.params.some(param=>(param.englishName||param.name)==='maxAdaptiveSamplingFrames')?[p('maxAdaptiveSamplingFrames','24','number')]:[]),
        ...(!node.params.some(param=>(param.englishName||param.name)==='maxAdaptiveSamplingRounds')?[p('maxAdaptiveSamplingRounds','2','number')]:[])],
      ...(node.errorRetry?{errorRetry:{...node.errorRetry,retryFrom:request.id,retryContextSources:node.errorRetry.retryContextSources??retryContextSources}}:{})};
    if(node===request)return {...node,code:node.code!.replace(planBlock,()=>ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE)};
    if(node===branch)return {...node,code:node.code!.replace(REPORT_FORMAT_FEEDBACK_RETURN,()=>reportFormatRetryBranchReturn(true)),
      params:node.params.some(param=>(param.englishName||param.name)==='retryContextSources')?node.params:[...node.params,p('retryContextSources',JSON.stringify(retryContextSources))]};
    return node;
  }),edges:workflow.edges.map(edge=>branch&&edge.from===branch.id&&edge.to===firstId?{...edge,to:request.id}:edge)};
}

/** Preserve unresolved evidence as unresolved. An explicitly permitted,
 * source-bound noncritical gap may remain a warning, never an invented fact
 * or a programmatic promotion of the primary review's decision. */
export function upgradeStructuredMediaEvidenceGaps<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=107)return workflow;
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const reviewer=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const independent=workflow.nodes.find(node=>node.id==='sanguo-requirement-review');
  const guard=/\/\/ media-defect-evidence-v3\n[\s\S]*?\/\/ \/media-defect-evidence-v3/;
  const view=/\/\/ independent-media-review-view-v1\n[\s\S]*?\/\/ \/independent-media-review-view-v1/;
  const sampling=/\/\/ media-uncertainty-diagnostic-v2\n[\s\S]*?\/\/ \/media-uncertainty-diagnostic-v2/;
  const independentPrompt=/你是独立的单项画面验收员[\s\S]*?不要返回综合成片决定，也不要增写原文没有的要求。/;
  if(!gate?.code||!guard.test(gate.code)||!view.test(gate.code)||!sampling.test(gate.code)
    ||!reviewer||!isCanonicalMediaReviewPrompt(reviewer.prompt)||!independent||!independentPrompt.test(independent.prompt))return workflow;
  const field='allowNoncriticalEvidenceGaps';
  const policyParams=(node:N)=>{
    const existing=node.params.find(param=>(param.englishName||param.name)==='reviewPolicySource');
    if(!existing)return [...node.params,p('reviewPolicySource',JSON.stringify({nodeId:gate.id,fields:[field]}))];
    return node.params.map(param=>{
      if(param!==existing)return param;
      let source;try{source=JSON.parse(param.value)}catch{return param}
      if(source?.nodeId!==gate.id||!Array.isArray(source.fields)||source.fields.includes(field))return param;
      return {...param,value:JSON.stringify({...source,fields:[...source.fields,field]})};
    });
  };
  return {...workflow,schemaVersion:107,nodes:workflow.nodes.map(node=>{
    if(node===gate)return {...node,code:node.code!.replace(guard,()=>COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE)
      .replace(view,()=>INDEPENDENT_MEDIA_REVIEW_VIEW_CODE).replace(sampling,()=>ADAPTIVE_MEDIA_REVIEW_GUARD_CODE),
      params:node.params.some(param=>(param.englishName||param.name)===field)?node.params:[...node.params,p(field,'true','boolean')]};
    if(node===reviewer)return {...node,prompt:node.prompt.replace(/【独立成片验收完整契约 v1】[\s\S]*?【独立成片验收完整契约结束】/,()=>CANONICAL_MEDIA_REVIEW_PROMPT),params:policyParams(node)};
    if(node===independent)return {...node,prompt:node.prompt.replace(independentPrompt,()=>REQUIREMENT_MEDIA_REVIEW_PROMPT),params:policyParams(node)};
    return node;
  })};
}

/** Clarify the existing string-leaf citation contract without changing its
 * validator, policy, model selection, retry budgets or execution topology. */
export function upgradeMediaContextQuoteContract<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=108)return workflow;
  const independent=workflow.nodes.find(node=>node.id==='sanguo-requirement-review');
  const primary=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const shared=/【观察事实与未证实细项】[\s\S]*?不得自动把综合报告的uncertain\/false升级为accepted\/true。(?:\n【观察事实与未证实细项结束】)?/;
  const canonical=/【独立成片验收完整契约 v1】[\s\S]*?【独立成片验收完整契约结束】/;
  const exactlyOnce=(text:string,block:RegExp)=>[...text.matchAll(new RegExp(block.source,'g'))].length===1;
  if(independent?.kind!=='text'||primary?.kind!=='text'||!exactlyOnce(independent.prompt,shared)
    ||!exactlyOnce(primary.prompt,shared)||!exactlyOnce(primary.prompt,canonical))return workflow;
  return {...workflow,schemaVersion:108,nodes:workflow.nodes.map(node=>node===independent
    ?{...node,prompt:node.prompt.replace(shared,()=>MEDIA_EVIDENCE_GAPS_PROMPT)}
    :node===primary?{...node,prompt:node.prompt.replace(canonical,()=>CANONICAL_MEDIA_REVIEW_PROMPT)}:node)};
}

/** Give both reviewers the same authored-context semantics. A budget window
 * supplies timing context, not an independently invented performance duty. */
export function upgradeSharedMediaCriticalityContext<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=109)return workflow;
  const independent=workflow.nodes.find(node=>node.id==='sanguo-requirement-review');
  const primary=workflow.nodes.find(node=>node.id==='sanguo-media-review');
  const shared=/【观察事实与未证实细项】[\s\S]*?【观察事实与未证实细项结束】/;
  const canonical=/【独立成片验收完整契约 v1】[\s\S]*?【独立成片验收完整契约结束】/;
  const exactlyOnce=(text:string,block:RegExp)=>[...text.matchAll(new RegExp(block.source,'g'))].length===1;
  if(independent?.kind!=='text'||primary?.kind!=='text'||!exactlyOnce(independent.prompt,shared)
    ||!exactlyOnce(primary.prompt,shared)||!exactlyOnce(primary.prompt,canonical))return workflow;
  const legacyCriticality='先结合本项逐字原文与剧情上下文，区分实质视觉义务和非关键表演微差。completionCriteria是原剧情完成条件，storyProgress是原故事阶段、结果与待续行动，pacing.performanceBeats是明确表演节拍，activityWindows只是原活动时间预算；这些计划说明为何要验收，不能证明画面已经发生。原文明确承担行动结果、人物回应、因果或表演节拍的动作仍是关键要求，即使幅度轻微也不能降为warning。完成条件或节拍没有列出某动作，不代表原时间线的动作可以忽略；物件归属、递交接收、场景行动、人物进出及明确持续状态等实质要求即使未在其他字段重复，仍须实际证据。不能把未采到写成已发生，不能仅凭“微微”等词自动降级，关键性无法判断时保留unobservable。\n';
  return {...workflow,schemaVersion:109,nodes:workflow.nodes.map(node=>node===independent
    ?{...node,prompt:node.prompt.replace(shared,()=>MEDIA_EVIDENCE_GAPS_PROMPT).replace(legacyCriticality,'')}
    :node===primary?{...node,prompt:node.prompt.replace(canonical,()=>CANONICAL_MEDIA_REVIEW_PROMPT)}:node)};
}

export const NATIVE_MEDIA_OBSERVATION_GUARD_CODE = String.raw`// native-media-observation-scope-v1
const expectedObservationFrames = (${deriveMediaEvidenceViews.toString()})(e).observerFrames;
if (!Array.isArray(observations?.frames) || observations.frames.length !== expectedObservationFrames.length
  || observations.frames.some((r,i) => r.index !== expectedObservationFrames[i].index || !Array.isArray(r.people) || typeof r.setting !== 'string'
    || (e.nativeSequence && r.second !== expectedObservationFrames[i].second)) || !observations.tailObservation) invalid('逐帧观察不完整：草稿须覆盖其明确采样范围，不能冒充全部原生审核帧');
// /native-media-observation-scope-v1`;

/** Once sparse evidence is exhausted, permit one bounded continuous native
 * view of unresolved original windows. Transport indexes remain separate. */
export function upgradeNativeSequenceMediaEvidence<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||(workflow.schemaVersion??0)>=110)return workflow;
  const find=(id:string)=>workflow.nodes.find(node=>node.id===id);
  const request=find('sanguo-media-request'),evidence=find('sanguo-video-evidence'),metrics=find('sanguo-media-metrics');
  const independent=find('sanguo-requirement-review'),primary=find('sanguo-media-review'),gate=find('sanguo-media-accept');
  const sampling=/\/\/ media-sampling-plan-v2\n[\s\S]*?\/\/ \/media-sampling-plan-v2/;
  const input=/\/\/ media-requirement-review-input-v1\n[\s\S]*?\/\/ \/media-requirement-review-input-v1/;
  const view=/\/\/ independent-media-review-view-v1\n[\s\S]*?\/\/ \/independent-media-review-view-v1/;
  const guard=/\/\/ media-uncertainty-diagnostic-v2\n[\s\S]*?\/\/ \/media-uncertainty-diagnostic-v2/;
  const independentBlock=/你是独立的单项画面验收员[\s\S]*?不要返回综合成片决定，也不要增写原文没有的要求。/;
  const canonicalBlock=/【独立成片验收完整契约 v1】[\s\S]*?【独立成片验收完整契约结束】/;
  const once=(text:string,block:RegExp)=>[...text.matchAll(new RegExp(block.source,'g'))].length===1;
  const onceText=(text:string,needle:string)=>text.split(needle).length===2;
  const metricsReturn='return {requirementReviewInputs,requirements,tailTiming,frames:evidence.frames.map((url,index)=>({url,index,second:evidence.frameTimes[index]})),';
  const observationGuard="if (!Array.isArray(observations?.frames) || observations.frames.length !== e.frames.length\n  || observations.frames.some((r,i) => r.index !== i || !Array.isArray(r.people) || typeof r.setting !== 'string') || !observations.tailObservation) invalid('逐帧观察不完整');";
  if(!request?.code||!once(request.code,sampling)||!onceText(request.code,'return { sampleTimes:samplingPlan.sampleTimes,')
    ||evidence?.request?.url!=='/api/video-evidence'||!metrics?.code||!once(metrics.code,input)||!onceText(metrics.code,metricsReturn)
    ||!gate?.code||!once(gate.code,view)||!once(gate.code,guard)||!onceText(gate.code,observationGuard)||!independent||!once(independent.prompt,independentBlock)
    ||!primary||!once(primary.prompt,canonicalBlock))return workflow;
  const set=(params:N['params'],key:string,value:string,required=true,type='json')=>[
    ...params.filter(param=>(param.englishName||param.name)!==key),p(key,value,type,required)];
  return {...workflow,schemaVersion:110,nodes:workflow.nodes.map(node=>{
    if(node===request)return {...node,code:node.code!.replace(sampling,()=>ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE)
      .replace('return { sampleTimes:samplingPlan.sampleTimes,','return { nativeSequence:samplingPlan.nativeSequence,sampleTimes:samplingPlan.sampleTimes,')};
    if(node===evidence)return {...node,params:set(node.params,'nativeSequence','${media_request.nativeSequence}',false)};
    if(node===metrics)return {...node,code:node.code!.replace(input,()=>REQUIREMENT_REVIEW_METRICS_CODE)
      .replace(metricsReturn,()=>`const evidenceViews = (${deriveMediaEvidenceViews.toString()})(evidence);\nreturn {reviewImageDetail:evidenceViews.reviewImageDetail,requirementReviewInputs,requirements,tailTiming,frames:evidenceViews.observerFrames,`)};
    if(node===independent)return {...node,prompt:node.prompt.replace(independentBlock,()=>REQUIREMENT_MEDIA_REVIEW_PROMPT),params:set(node.params,'reviewImageDetail','${requirementInput.reviewImageDetail}',false)};
    if(node===primary)return {...node,prompt:node.prompt.replace(canonicalBlock,()=>CANONICAL_MEDIA_REVIEW_PROMPT),
      params:set(node.params,'reviewImageDetail','${media_metrics.reviewImageDetail}')};
    if(node===gate)return {...node,code:node.code!.replace(view,()=>INDEPENDENT_MEDIA_REVIEW_VIEW_CODE).replace(guard,()=>ADAPTIVE_MEDIA_REVIEW_GUARD_CODE)
      .replace(observationGuard,()=>NATIVE_MEDIA_OBSERVATION_GUARD_CODE)
      .replaceAll('!observations.frames.some(frame=>frame.index===index)','!Number.isInteger(index)||index<0||index>=e.frames.length'),
      params:[...node.params,...(!node.params.some(param=>(param.englishName||param.name)==='nativeSequenceEvidence')?[p('nativeSequenceEvidence','true','boolean')]:[]),
        ...(!node.params.some(param=>(param.englishName||param.name)==='maxNativeReviewFrames')?[p('maxNativeReviewFrames','160','number')]:[])]};
    return node;
  })};
}

/** Refresh managed display boundaries and the writer's timing contract. Keep
 * authored obligations, custom prompt surroundings and review budgets intact. */
export function upgradeNativeDisplayEvidenceScope<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==110)return workflow;
  const metrics=workflow.nodes.find(node=>node.id==='sanguo-media-metrics');
  const gate=workflow.nodes.find(node=>node.id==='sanguo-media-accept');
  const independent=workflow.nodes.find(node=>node.id==='sanguo-requirement-review');
  const writer=workflow.nodes.find(node=>node.id==='sanguo-shot-script');
  const input=/\/\/ media-requirement-review-input-v1\n[\s\S]*?\/\/ \/media-requirement-review-input-v1/;
  const view=/\/\/ independent-media-review-view-v1\n[\s\S]*?\/\/ \/independent-media-review-view-v1/;
  const guard=/\/\/ media-uncertainty-diagnostic-v2\n[\s\S]*?\/\/ \/media-uncertainty-diagnostic-v2/;
  const defects=/\/\/ media-defect-evidence-v3\n[\s\S]*?\/\/ \/media-defect-evidence-v3/;
  const prompt=/你是独立的单项画面验收员[\s\S]*?不要返回综合成片决定，也不要增写原文没有的要求。/;
  const once=(text:string,block:RegExp)=>[...text.matchAll(new RegExp(block.source,'g'))].length===1;
  const oldWriterCount=(writer?.prompt.split(SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING).length??1)-1;
  const newWriterCount=(writer?.prompt.split(SANGUO_CINEMATIC_STORYBOARD_PROMPT).length??1)-1
    +(writer?.prompt.split(SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE).length??1)-1;
  const intermediateWriterCount=(writer?.prompt.split(SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING).length??1)-1;
  const writerPrompt=oldWriterCount===1&&newWriterCount===0&&intermediateWriterCount===0
    ?writer!.prompt.replace(SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING,()=>SANGUO_CINEMATIC_STORYBOARD_PROMPT)
    :oldWriterCount===0&&newWriterCount+intermediateWriterCount===1?writer!.prompt:undefined;
  if(!metrics?.code||!once(metrics.code,input)||!gate?.code||!once(gate.code,view)||!once(gate.code,guard)
    ||!once(gate.code,defects)||!gate.code.includes('// native-media-observation-scope-v1')
    ||independent?.kind!=='text'||!once(independent.prompt,prompt)||writer?.kind!=='text'||writerPrompt===undefined)return workflow;
  return {...workflow,schemaVersion:111,nodes:workflow.nodes.map(node=>node===metrics
    ?{...node,code:node.code!.replace(input,()=>REQUIREMENT_REVIEW_METRICS_CODE)}
    :node===gate?{...node,code:node.code!.replace(view,()=>INDEPENDENT_MEDIA_REVIEW_VIEW_CODE)
      .replace(guard,()=>ADAPTIVE_MEDIA_REVIEW_GUARD_CODE).replace(defects,()=>COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE)}
    :node===independent?{...node,prompt:node.prompt.replace(prompt,()=>REQUIREMENT_MEDIA_REVIEW_PROMPT)}
    :node===writer?{...node,prompt:writerPrompt}:node)};
}


/** Extend only the exact managed timeline parser. Editable custom code, sample
 * limits, models and the graph remain untouched. Align the managed writer's
 * full audio obligations with per-line timing; ambiguous anchors do not migrate. */
export function upgradeVideoRequestTimeSeparators<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==111)return workflow;
  const requests=workflow.nodes.filter(node=>node.id==='sanguo-media-request');
  const request=requests[0];
  if(requests.length!==1||request.kind!=='code'||!request.code)return workflow;
  const current=VIDEO_REQUEST_PREFIX_SCHEMA112;
  const previous=current.replace('[-–—~～至到]','[-—~～至到]');
  const latest=VIDEO_REQUEST_CODE.slice(0,VIDEO_REQUEST_CODE.indexOf('const windows ='));
  const count=(text:string,part:string)=>text.split(part).length-1;
  const oldCount=count(request.code,previous),newCount=count(request.code,current);
  if(oldCount+newCount+count(request.code,latest)!==1
    ||count(request.code,'const matches = [...timeline.matchAll(')+count(request.code,'const matches = storyboardTimelineMatches(timeline);')!==1)return workflow;
  const writers=workflow.nodes.filter(node=>node.id==='sanguo-shot-script');
  const writer=writers[0];
  if(writers.length!==1||writer.kind!=='text')return workflow;
  let writerPrompt=writer.prompt;
  for(const [oldClause,newClause] of [[STORYBOARD_AUDIO_COVERAGE_BEFORE_LINE_BINDING,STORYBOARD_AUDIO_COVERAGE_LINE_BINDING],
    [STORYBOARD_DIALOGUE_BEFORE_LINE_BINDING,STORYBOARD_DIALOGUE_LINE_BINDING]]) {
    if(count(writerPrompt,oldClause)+count(writerPrompt,newClause)!==1)return workflow;
    writerPrompt=writerPrompt.replace(oldClause,()=>newClause);
  }
  return {...workflow,schemaVersion:112,nodes:workflow.nodes.map(node=>node===request&&oldCount===1
    ?{...node,code:node.code!.replace(previous,()=>current)}:node===writer&&writerPrompt!==writer.prompt?{...node,prompt:writerPrompt}:node)};
}

/** Upgrade only the known managed timeline statements, retaining edited code
 * around them. Persisted samplers and evidence scopes must read the same syntax
 * as the writer validator before the next paid generation can proceed. */
export function upgradeStoryboardTimelineSyntax<N extends Node,W extends Workflow<N>>(workflow:W):W {
  if(workflow.id!=='wf-sanguo-history-drama'||workflow.schemaVersion!==112)return workflow;
  const requests=workflow.nodes.filter(node=>node.id==='sanguo-media-request');
  const request=requests[0];
  if(requests.length!==1||request.kind!=='code'||!request.code)return workflow;
  const current=VIDEO_REQUEST_CODE.slice(0,VIDEO_REQUEST_CODE.indexOf('const windows ='));
  const count=(source:string,part:string)=>source.split(part).length-1;
  if(count(request.code,VIDEO_REQUEST_PREFIX_SCHEMA112)+count(request.code,current)!==1)return workflow;
  const oldWindows=String.raw`[...source.matchAll(/(\d+(?:\.\d+)?)\s*[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*秒\s*[:：]/g)]`;
  const targets=new Set(['sanguo-media-request','sanguo-media-metrics','sanguo-media-accept']);
  const managed=/\/\/ (?:media-sampling-plan|media-requirement-list|media-requirement-review-input|media-defect-evidence|independent-media-review-view|media-uncertainty-diagnostic)-v\d/;
  for(const id of targets) {
    const matching=workflow.nodes.filter(node=>node.id===id);
    if(matching.length>1||matching.some(node=>node.code?.includes(oldWindows)&&!managed.test(node.code)))return workflow;
  }
  const nodes=workflow.nodes.map(node=>{
    if(!targets.has(node.id)||node.kind!=='code'||!node.code)return node;
    let code=node.code;
    if(node===request)code=code.replace(VIDEO_REQUEST_PREFIX_SCHEMA112,()=>current);
    if(code.includes(oldWindows)) {
      // This statement belongs to the shipped requirement/defect functions.
      // Unmarked custom nodes do not opt into migration by matching a regex.
      code=code.replaceAll(oldWindows,'storyboardTimelineMatches(source)');
      if(!code.includes('const storyboardTimelineMatches = '))code=`const storyboardTimelineMatches = (${storyboardTimelineMatches.toString()});\n`+code;
    }
    return code===node.code?node:{...node,code};
  });
  return {...workflow,schemaVersion:113,nodes};
}

export function upgradeDurationQuality<N extends Node,W extends Workflow<N>>(workflow:W):W {
  return upgradeDurationWorkflow(workflow,{requirements:MEDIA_REQUIREMENT_METRICS_CODE,reviewInputs:REQUIREMENT_REVIEW_METRICS_CODE,
    reviewView:INDEPENDENT_MEDIA_REVIEW_VIEW_CODE,uncertainty:ADAPTIVE_MEDIA_REVIEW_GUARD_CODE,defects:COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE,
    completionPrompt:DURATION_COMPLETION_REVIEW_PROMPT,refreshDramaturgyGate:refreshEmbeddedDramaturgyReviewCode,
    refreshDramaturgyPrompt:refreshDramaturgyReviewPrompt})
}
