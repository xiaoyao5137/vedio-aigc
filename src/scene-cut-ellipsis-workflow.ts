import { SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE } from './scene-cut-first-frame-gate.ts'
import { COVERAGE_CUT_VIDEO_REFERENCES_CODE } from './coverage-cut-frame-gate.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V170 } from './scene-cut-opening-projection-workflow.ts'
import { characterSelectionsForEpisode } from './character-visual-workflow.ts'

/** An actual previous tail is appended after the candidate and identity
 * sheets. The order is signed later, so it cannot be replaced by a planned
 * last frame or silently omitted from the model's attachments. */
export const SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171 = SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE
  .replace('return { items: [{ role:', 'const items = [{ role:')
  .replace('url: item.url }))] }', `url: item.url }))]
if (sources.approvedEllipsis) {
  const tail = sources.approvedEllipsis.priorTailUrl
  if (!/^\\/generated\\/[\\w.-]+\\.(?:png|jpe?g|webp)$/i.test(tail))
    throw Error('SCENE_CUT_FRAME_INVALID: 批准省略的前镜实际尾帧无效')
  items.push({ role: 'prior_actual_tail', url: tail })
}
return { items }`)

export const SCENE_CUT_VIDEO_REFERENCES_CODE = COVERAGE_CUT_VIDEO_REFERENCES_CODE.replace(
  'return branch && branch.referenceRequest ?', `if (branch && branch.shouldGenerateSceneFrame) {
  if (!params.sceneSources || params.sceneSources.version !== 'scene-cut-sources-v1'
    || !Array.isArray(params.sceneSources.referenceImages)
    || !Array.isArray(params.sceneSources.referenceBindings)
    || params.sceneSources.referenceImages.length !== params.sceneSources.referenceBindings.length)
    throw Error('SCENE_CUT_SOURCE_INVALID: 视频身份资产未归档')
  return { referenceImages: params.sceneSources.referenceImages,
    referenceBindings: params.sceneSources.referenceBindings,
    referenceMode: params.sceneSources.referenceImages.length <= 2 ? 'three-view-all' : 'three-view-front' }
}
return branch && branch.referenceRequest ?`)

const DURATION_REPLAN_BRANCH_CODE = `const report=context.video_shot;
if(report?.durationCompletion?.route!=='replan')return true;
if(branch.counts.false+1>=Number(params.maxAttempts))throw Error('DURATION_REPLAN_LIMIT: 已达时长重排上限，保留当前素材和诊断');
return {value:false,feedback:report.durationRepair,contextPatch:{durationRepair:report.durationRepair}};`

/** The archived source and generated image carry base64 references for paid
 * model calls. This managed code node only reads their URL identities. */
export function sceneCutEvidencePlanCodeInput(node: { id: string; code?: string },
  values: Record<string, unknown>, context: Record<string, unknown>) {
  if (node.id !== 'sanguo-scene-cut-evidence-plan'
    || node.code !== SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171) {
    if (node.id === 'sanguo-duration-replan' && node.code === DURATION_REPLAN_BRANCH_CODE) {
      const report = context.video_shot as Record<string, unknown> | undefined
      const branch = context.branch as Record<string, unknown> | undefined
      return { values, context: {
        video_shot: { durationCompletion: report?.durationCompletion,
          durationRepair: report?.durationRepair },
        branch: { counts: branch?.counts },
      } }
    }
    if (node.id === 'sanguo-media-accept-error-branch'
      && node.code?.startsWith('const error = context["video_shot"]?.routeError;\nif (!error) return true;')
      && node.code.includes('resolveRetryContextPatch(context')
      && Array.isArray(values.patterns)
      && JSON.stringify(values.retryContextSources) === JSON.stringify({ mediaSamplingRetry:
        ['video_shot.samplingRetryPlan', 'mediaSamplingRetry'] })) {
      const report = context.video_shot as Record<string, unknown> | undefined
      return { values, context: { video_shot: { routeError: report?.routeError,
        samplingRetryPlan: report?.samplingRetryPlan },
      mediaSamplingRetry: context.mediaSamplingRetry, branch: context.branch } }
    }
    if (node.id === 'sanguo-media-accept-accept-branch'
      && node.code?.startsWith("const at = (obj, path) => path.split('.').reduce((v,k) => v?.[k], obj);\nconst report = context[\"video_shot\"];")
      && values.passedPath === 'passed' && values.feedbackPath === 'retryPrompt') {
      const report = context.video_shot as Record<string, unknown> | undefined
      const review = report?.qualityReview as Record<string, unknown> | undefined
      return { values, context: { video_shot: {
        passed: report?.passed, retryPrompt: report?.retryPrompt,
        subtitleAssessment: report?.subtitleAssessment,
        qualityReview: { subtitleAssessment: review?.subtitleAssessment },
      }, branch: context.branch } }
    }
    if (node.id === 'sanguo-last-frame'
      && node.code?.startsWith('// 使用视频模型返回或系统从成片提取的实际尾帧，供下一镜复用。\nconst videoResult = ${video_shot}\n')
      && node.code.includes("source: modelTail ? (video.extractedLastFrameUrl ? 'extracted-from-video'")) {
      return { values, context: { video_shot: context.video_shot } }
    }
    if (node.id === 'sanguo-shot-script-accept' && values.qualityMode === 'principle-v1'
      && node.code?.startsWith("// PRINCIPLE_POLICY_START\nif (params.qualityMode === 'principle-v1') {")
      && node.code.includes('// principle-text-quality-v1\nreturn ')
      && node.code.includes('citations: params.sources ?? context.historical_sources?.citations,')
      && node.code.includes('sourceCandidate: params.sourceCandidate ?? context.scene,')) {
      const historical = context.historical_sources as Record<string, unknown> | undefined
      return { values, context: { historical_sources: { citations: historical?.citations },
        scene: context.scene } }
    }
    if (node.id === 'sanguo-shot-script-accept-error-branch'
      && node.code?.startsWith('const error = context["shot_script"]?.routeError;\nif (!error) return true;')
      && node.code.endsWith("? {kind:'report-format',error} : error };")) {
      const report = context.shot_script as Record<string, unknown> | undefined
      return { values, context: { shot_script: { routeError: report?.routeError }, branch: context.branch } }
    }
    if (node.id === 'sanguo-shot-script-accept-accept-branch'
      && node.code?.startsWith("const at = (obj, path) => path.split('.').reduce((v,k) => v?.[k], obj);\nconst report = context[\"shot_script\"];")
      && values.passedPath === 'passed' && values.feedbackPath === 'repairContext') {
      return { values, context: { shot_script: context.shot_script, branch: context.branch } }
    }
    if (node.id === 'sanguo-character-lookup'
      && node.code?.startsWith('// 通过占位符直接读取短分镜人物和系统人物库查询结果，不配置节点入参字段。\nconst characters = ${shot_script.characters}\n')
      && [...node.code.matchAll(/\$\{([^}]+)\}/g)].every(([, path]) => [
        'shot_script.characters', 'shot_script.firstFramePrompt', 'shot_script.visualPrompt',
        'shot_script.lastFramePrompt', 'character_lookup_result',
      ].includes(path))) {
      const shot = context.shot_script as Record<string, unknown> | undefined
      return { values, context: { shot_script: {
        characters: shot?.characters, firstFramePrompt: shot?.firstFramePrompt,
        visualPrompt: shot?.visualPrompt, lastFramePrompt: shot?.lastFramePrompt,
      }, character_lookup_result: context.character_lookup_result } }
    }
    if (node.id === 'sanguo-first-frame-branch'
      && node.code?.startsWith('// 动态动画生成稳定首尾帧；人物插画生成背景底板，由系统编排静态人物图层。\n')
      && [...node.code.matchAll(/\$\{([^}]+)\}/g)].every(([, path]) => [
        'shot_script.firstFrameMode', 'shot_script.visualTreatment', 'shot_script.animationStyle',
        'shot_script.visualPrompt', 'shot_script.videoPrompt', 'shot_script.illustrationLayers',
        'shot_script.enteringCharacters', 'loop.previous.last_frame.url', 'shot_script.continuity.mode',
        'character_lookup.names', 'character_lookup.existingAssets', 'character_lookup.existingImages',
        'character_assets', 'character_lookup.equipmentBindings', 'input.characterAssetSelections',
        'shot_script.firstFramePrompt', 'shot_script.camera',
      ].includes(path))) {
      const shot = context.shot_script as Record<string, unknown> | undefined
      const continuity = shot?.continuity as Record<string, unknown> | undefined
      const lookup = context.character_lookup as Record<string, unknown> | undefined
      const loop = context.loop as Record<string, unknown> | undefined
      const previous = loop?.previous as Record<string, unknown> | undefined
      const lastFrame = previous?.last_frame as Record<string, unknown> | undefined
      const input = context.input as Record<string, unknown> | undefined
      const selections = characterSelectionsForEpisode(input?.characterAssetSelections, input?.episode_number)
      return { values, context: {
        shot_script: {
          firstFrameMode: shot?.firstFrameMode, visualTreatment: shot?.visualTreatment,
          animationStyle: shot?.animationStyle, visualPrompt: shot?.visualPrompt,
          videoPrompt: shot?.videoPrompt, illustrationLayers: shot?.illustrationLayers,
          enteringCharacters: shot?.enteringCharacters,
          continuity: { mode: continuity?.mode }, firstFramePrompt: shot?.firstFramePrompt,
          camera: shot?.camera,
        },
        loop: { previous: { last_frame: { url: lastFrame?.url } } },
        character_lookup: { names: lookup?.names, existingAssets: lookup?.existingAssets,
          existingImages: lookup?.existingImages, equipmentBindings: lookup?.equipmentBindings },
        character_assets: context.character_assets,
        input: { characterAssetSelections: selections },
      } }
    }
    if (node.id === 'sanguo-coverage-precheck'
      && node.code?.startsWith('const tail = params.previousLastFrame\nconst video = params.previousVideoShot\n')
      && !node.code.includes('context.') && !node.code.includes('${')) {
      return { values, context: {} }
    }
    if (node.id === 'sanguo-coverage-evidence-plan'
      && node.code?.startsWith('const sources = params.sources\nconst frame = params.frame\n')
      && !node.code.includes('context.') && !node.code.includes('${')) {
      return { values, context: {} }
    }
    if (node.id === 'sanguo-media-request' && values.qualityMode === 'principle-v1'
      && node.code?.startsWith("// PRINCIPLE_POLICY_START\nif (params.qualityMode === 'principle-v1') {")
      && node.code.includes('// PRINCIPLE_DURATION_V2_GATE_SCHEMA159\nconst principleRequest=principleMediaQuality.mediaRequest(context);')
      && node.code.includes('// PRINCIPLE_POLICY_END\n// duration-v2-media-request')) {
      const video = context.video_take as Record<string, unknown> | undefined
      const firstFrame = context.first_frame as Record<string, unknown> | undefined
      return { values, context: {
        shot_script: context.shot_script,
        video_take: { url: video?.url },
        first_frame: { url: firstFrame?.url },
        mediaSamplingRetry: context.mediaSamplingRetry,
      } }
    }
    if (node.id === 'sanguo-media-metrics' && values.qualityMode === 'principle-v1'
      && node.code?.startsWith("// PRINCIPLE_POLICY_START\nif (params.qualityMode === 'principle-v1') {")
      && node.code.includes('// NATIVE_PRINCIPLE_SEQUENCE_GRID_SCHEMA163\nconst metrics=principleMediaQuality.mediaMetrics(context,params);')
      && node.code.includes('// PRINCIPLE_POLICY_END')) {
      const video = context.video_take as Record<string, unknown> | undefined
      const videoParams = video?.params as Record<string, unknown> | undefined
      return { values, context: {
        shot_script: context.shot_script,
        video_evidence: context.video_evidence,
        video_take: { params: { subtitlePolicy: videoParams?.subtitlePolicy } },
      } }
    }
    if (node.id === 'sanguo-media-accept' && values.qualityMode === 'principle-v1'
      && node.code?.startsWith("// PRINCIPLE_POLICY_START\nif (params.qualityMode === 'principle-v1') {")
      && node.code.includes('// PRINCIPLE_DURATION_V2_GATE_SCHEMA159\nif(context.shot_script?.pacing?.version')
      && node.code.includes('// PRINCIPLE_POLICY_END')) {
      const take = context.video_take as Record<string, unknown> | undefined
      const paid = take?.params as Record<string, unknown> | undefined
      const sources = paid?.sceneCutSources as Record<string, unknown> | undefined
      const sourceContext = sources?.sourceContext as Record<string, unknown> | undefined
      const outline = sourceContext?.approvedOutline as Record<string, unknown> | undefined
      const previous = sourceContext?.previous as Record<string, unknown> | undefined
      const previousShot = previous?.shot_script as Record<string, unknown> | undefined
      const firstFrame = context.first_frame as Record<string, unknown> | undefined
      const retry = context.retry as Record<string, unknown> | undefined
      const historical = context.historical_sources as Record<string, unknown> | undefined
      return { values, context: {
        shot_script: context.shot_script,
        video_evidence: context.video_evidence,
        media_review: context.media_review,
        video_take: { url: take?.url, params: {
          scheduleHash: paid?.scheduleHash, subtitlePolicy: paid?.subtitlePolicy,
          referenceImage: paid?.referenceImage, coverageCutFrameGate: paid?.coverageCutFrameGate,
          sceneCutFrameGate: paid?.sceneCutFrameGate,
          sceneCutShot: paid?.sceneCutShot,
          sceneCutSources: sources && { version: sources.version,
            outlineBinding: sources.outlineBinding,
            approvedEllipsis: sources.approvedEllipsis,
            sourceContext: { acceptedRecordBinding: sourceContext?.acceptedRecordBinding,
              approvedOutline: { scenes: Array.isArray(outline?.scenes)
                ? outline.scenes.map((scene: Record<string, unknown>) => ({ id: scene.id })) : undefined },
              previous: { shot_script: { id: previousShot?.id } },
            },
          },
        } },
        first_frame: { url: firstFrame?.url },
        mediaSamplingRetry: context.mediaSamplingRetry,
        audio_visual_review: context.audio_visual_review,
        retry: { feedback: retry?.feedback },
        targeted_repair_assessment: context.targeted_repair_assessment,
        historical_sources: { citations: historical?.citations },
      } }
    }
    if (node.id === 'sanguo-video-reference-router'
      && node.code === SCENE_CUT_VIDEO_REFERENCES_CODE) return { values, context: {} }
    return { values, context }
  }
  const frame = values.frame as Record<string, unknown> | undefined
  const sources = values.sources as Record<string, unknown> | undefined
  const bindings = Array.isArray(sources?.referenceBindings)
    ? sources.referenceBindings.map((item: Record<string, unknown>) => ({
      characterName: item.characterName, assetId: item.assetId, url: item.url }))
    : sources?.referenceBindings
  const ellipsis = sources?.approvedEllipsis as Record<string, unknown> | undefined
  return { values: {
    ...values,
    frame: { url: frame?.url },
    sources: { version: sources?.version, referenceBindings: bindings,
      ...(ellipsis ? { approvedEllipsis: { priorTailUrl: ellipsis.priorTailUrl } } : {}) },
  }, context: {} }
}

export const SCENE_CUT_FRAME_REVIEW_PROMPT_V171 = SCENE_CUT_FRAME_REVIEW_PROMPT_V170
  .replace('首条须处在动作起点；其后各条若没有已批准的显式复位节拍，零秒也不能已经呈现其完成态。',
    '纯静态建立节拍须在零秒实见其状态；抬手、缚住、俯身、走近等变化节拍须处在动作起点，其后没有已批准显式复位的变化动作也不得在零秒已呈终态。') + `
【静态建立节拍】若 requiredThisClip 的动作节拍仅交代首帧已经成立的人物、场所、束缚和守位关系，且没有变化动作，这一条必须已在 t=0 实见：对应 requiredVisualActionChecks 填 terminalStateAlreadyPresent=true、establishedStateVisible=true、approvedResetBeatId=""，observedT0 写逐项像素证据；此条无需 actionStillPossible=true。前文“首个动作起点”“全部动作未完成”和 hardChecks.actionStartNotCompleted / allRequiredVisualActionsOpen 对静态建立节拍解释为“建立状态已实见”，只对后续变化动作要求终态未现、仍可继续；这两个 hardChecks 在静态已实见且其余变化动作均未完成时可为 true。不能把抬手、缚住、俯身或走近等变化动作归为静态建立；其后真正变化节拍仍须保持零秒未完成余地。
【已批准省略切场·真实尾帧对照】若 scene_cut_sources.approvedEllipsis 存在，附件最后一张必须是上一镜已解码成片的真实末帧，不能是计划尾帧。审核首帧与该实际末帧及中间各具名人物原始人设图；允许已批准的不同场地和机位，但连续身体状态必须实见成立。批准场景与前镜素材绑定：\${scene_cut_sources.approvedEllipsis}。前镜已批准节拍：\${scene_cut_sources.sourceContext.previous.shot_script.pacing.beats}。顶层增加 priorTail：{"sourceUrl":"前镜真实尾帧原图URL","evidenceReferenceImage":"最后一张审核附件URL"}。逐项报告 transitionContinuityCheck：{"applicable":true,"sameCharacters":false,"sameWardrobeAndEquipment":false,"sameRestraintState":false,"priorTailShowsCompletedState":false,"newSettingLegible":false,"relativeBlockingPlausible":false,"pixelEvidence":{"characters":"两帧脸、发冠、胡须和人数的位置","wardrobeAndEquipment":"两帧衣甲、袍摆、兵器与可见装备","restraint":"前尾和新首腕绳的部位、结扣与松紧","completedState":"前尾中上一镜全部必需视觉动作的可见终态，含人物相对站位","newSetting":"新场地的实见空间标志","blocking":"省略转移后人物相对位置为何成立"}}。不确定、被遮挡或只靠剧情文字推断时相应项 false，passed=false；前尾如果仍在束缚操作或走近动作尚未达到批准终点，priorTailShowsCompletedState=false。首帧若把束缚、人物衣甲或位置重置，连续项 false。若没有批准省略，填 {"applicable":false}，不强求其他合法 scene_cut 复用前镜尾帧。`

type Param = { id: string; name: string; englishName?: string; type: string;
  required: boolean; value: string }
type Node = { id: string; code?: string; prompt?: string; params?: Param[] }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }
const p = (id: string, name: string, type: string, value: string): Param =>
  ({ id, name, englishName: name, type, required: false, value })
const archiveAdditions = [
  p('sc-source-approved-outline', 'approvedOutline', 'json', '${approved_scene_outline}'),
  p('sc-source-previous', 'previous', 'json', '${loop.previous}'),
  p('sc-source-boundary-version', 'sceneCutBoundaryVersion', 'text', 'scene-cut-approved-boundary-v1'),
]
const evidenceAdditions = [
  p('sc-video-evidence-continuity-mode', 'continuityMode', 'text', '${video_take.params.continuityMode}'),
  p('sc-video-evidence-visual-treatment', 'visualTreatment', 'text', '${video_take.params.visualTreatment}'),
  p('sc-video-evidence-frame-gate', 'sceneCutFrameGate', 'json', '${video_take.params.sceneCutFrameGate}'),
  p('sc-video-evidence-reference', 'sceneCutReferenceImage', 'text', '${video_take.params.referenceImage}'),
]
function withParams(current: Param[], additions: Param[]) {
  if (additions.some(item => current.some(existing => existing.englishName === item.englishName
    && (existing.id !== item.id || existing.value !== item.value)))) return undefined
  return [...current, ...additions.filter(item => !current.some(existing => existing.englishName === item.englishName))]
}

/** Schema171 leaves the approved outline/shot and graph edges untouched. */
export function upgradeSceneCutEllipsisWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![170, 171].includes(workflow.schemaVersion ?? 0))
    return workflow
  const archive = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-source-archive')
  const plan = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-evidence-plan')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  const videoEvidence = workflow.nodes.find(node => node.id === 'sanguo-video-evidence')
  const video = workflow.nodes.find(node => node.id === 'sanguo-video')
  if (!archive?.params || !plan?.code || !review?.prompt || !videoEvidence?.params
    || !video?.params
    || ![SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE, SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171].includes(plan.code)
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V170, SCENE_CUT_FRAME_REVIEW_PROMPT_V171].includes(review.prompt))
    return workflow
  const archiveParams = withParams(archive.params, archiveAdditions)
  const videoParams = withParams(videoEvidence.params, evidenceAdditions)
  const paidVideoParams = withParams(video.params, [p('sc-video-sources', 'sceneCutSources', 'json', '${scene_cut_sources}')])
  if (!archiveParams || !videoParams || !paidVideoParams) return workflow
  if (workflow.schemaVersion === 171 && archiveParams.length === archive.params.length
    && videoParams.length === videoEvidence.params.length
    && paidVideoParams.length === video.params.length
    && plan.code === SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V171) return workflow
  return { ...workflow, schemaVersion: 171,
    nodes: workflow.nodes.map(node => node.id === archive.id
      ? { ...node, params: archiveParams } as N
      : node.id === plan.id ? { ...node, code: SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171 } as N
      : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V171 } as N
      : node.id === videoEvidence.id ? { ...node, params: videoParams } as N
      : node.id === video.id ? { ...node, params: paidVideoParams } as N : node),
  } as W
}
