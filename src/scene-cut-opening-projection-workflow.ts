import { sceneCutBindingFromUnboundRequired,
  sceneCutGestureClosureStartRequired } from './scene-cut-t0-image-contract.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V169,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V169 } from './scene-cut-travel-start-workflow.ts'

/** Schema170 sends the image model only the approved opening projection. The
 * complete shot remains in request params and in the signed review contract. */
export const SCENE_CUT_FIRST_FRAME_PROMPT_V170 = `【真人换场首帧·零秒可见结构】
生成一张 16:9 写实电影画面。先画出以下逐节拍零秒起点，所有细节必须同时看见：\${scene_cut_opening_state.positiveOpeningDescription}。
已批准的静态场景、人物位置、服装和初始机位：\${scene_cut_opening_state.openingVisualContext}。严格遵守初始机位的方位、焦距和取景方向；若批准为全身画面，人物双脚及脚下留白全部留在画幅内，前景人物和道具不能挡住需要审查的腕、膝、背脊与鞋靴。人物原地静止，后续移动尚未起步。背景有旗帜时使用纯色无字布面，不画字形、拟字形、符号或标语。
每位具名人物的冻结人设以一张 2×2 局部参考板附图提供：左上仅脸、发冠与颈肩，右上仅领口、肩胸和衣甲，左下为革带至外袍摆，右下为内层下摆与鞋靴。这四块属于同一人，只复制容貌、材质、外袍长度、内层下摆和露靴比例；不拼成两个演员，也不复制原人设的直立姿势。每位具名人物在场景中只出现一次。无字幕、水印或分格。`

export const SCENE_CUT_FRAME_REVIEW_PROMPT_V170 = SCENE_CUT_FRAME_REVIEW_PROMPT_V169 + `
【零秒投影与画幅实图复核·v6】生图只收到静态投影和正向零秒起点，审核仍以本请求所附完整批准分镜与原始三视图为准。若首帧绳圈已经贴腕、出现闭合结、只在外段看到垂环，manipulationStartCheck 的松圈/结口项为 false；若双膝没有实见弯曲、躯干接近竖直，stanceStartCheck 对应项为 false。全身画幅必须完整看见参与者各脚的脚掌和脚跟，前景裁足或被遮挡使 allParticipantsFeetGrounded=false；严格比对批准机位方位和侧前角度。若禁止文字，远景旗面、匾额及服饰上的拟字也算 readableGlyphsPresent=true。原三视图的外袍摆、连续深色内层下摆和鞋靴比例必须逐项核对。
若 requiredThisClip 是由未缚到缚住，requiredVisualActionChecks 对应项增加 bindingStartCheck：{"applicable":true,"targetStillUnbound":false,"bindingMaterialSeparate":false,"bindingActionSpaceVisible":false,"pixelEvidence":"实际双腕/绳索/操作者在哪里，能否继续并腕绕绳结绳"}；双腕已缠绕或绳圈已贴腕则前两项 false，哪怕文字声称尚待缚住。若 requiredThisClip 是抬手示意军士封住缺口，增加 gestureClosureStartCheck：{"applicable":true,"gestureNotRaised":false,"gapStillOpen":false,"guardsBeforeClosure":false,"pixelEvidence":"发令手的位置、缺口轮廓、军士各自起点"}；已抬手或已堵住时相应项 false。若 requiredThisClip 是走到另一人面前，按 travelStartCheck 审核，出发间距仍可见且尚未抵达。无对应动作填 {"applicable":false}。任何适用项不实见或不确定就 passed=false。`

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const reject = (message: string): never => { throw Error(`SCENE_CUT_FRAME_REJECTED: ${message}`) }
const hasText = (value: unknown) => typeof value === 'string' && Boolean(value.trim())

/** Schema174 review replaced one summary pixelEvidence with observable fields.
 * Older reviews still need their original pixelEvidence contract. */
function hasStructuredBindingEvidence(start: Value, schemaVersion: number) {
  return schemaVersion >= 174 && hasText(start.visibilityEvidence)
    && start.uniqueWorkingRopeOperator === true && start.operatorHandVisible === true
    && start.workingRopeVisible === true && start.oneFreeEndVisible === true
    && start.ropeSlackVisible === true && start.noWristContactOrClosedKnot === true
    && start.targetRegionUnoccluded === true
}

function hasStructuredClosureEvidence(start: Value, schemaVersion: number) {
  const performers = Array.isArray(start.performerStartChecks)
    ? start.performerStartChecks.map(object) : []
  return schemaVersion >= 174 && hasText(start.visibilityEvidence)
    && start.allApprovedPerformersCovered === true && performers.length > 0
    && performers.every(actor => hasText(actor.role) && hasText(actor.pixelEvidence)
      && actor.atApprovedOrigin === true && actor.hipKneeOrSupportCueVisible === true
      && actor.hiddenLimbCouldBeAdvancing === false && actor.gapIntrusion === false)
}

/** Additional evidence gate for transformation actions omitted by earlier
 * tighten/travel classifiers. It does not change old signed plan semantics. */
export function validateSceneCutOpeningProjectionReview(review: unknown, shot: unknown,
  schemaVersion = 170) {
  const r = object(review), pacing = object(object(shot).pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  const schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(object) : []
  const checks = Array.isArray(r.requiredVisualActionChecks)
    ? r.requiredVisualActionChecks.map(object) : []
  const byId = new Map(checks.map(check => [String(check.beatId ?? ''), check]))
  for (const beat of beats) {
    const binding = sceneCutBindingFromUnboundRequired(beat)
    const closure = sceneCutGestureClosureStartRequired(beat)
    if (!binding && !closure) continue
    const id = String(beat.id ?? ''), check = byId.get(id)
    if (!check) return reject(`动作 ${id} 缺少零秒实图审核`)
    if (check.approvedResetBeatId) {
      const reset = beats.find(item => item.id === check.approvedResetBeatId)
      const resetAt = Number(schedule.find(item => item.beatId === check.approvedResetBeatId)?.startSecond)
      const beatAt = Number(schedule.find(item => item.beatId === id)?.startSecond)
      if (!reset || !Array.isArray(object(reset.completion).resetsBeatIds)
        || !(object(reset.completion).resetsBeatIds as unknown[]).includes(id)
        || !Number.isFinite(resetAt) || !Number.isFinite(beatAt) || resetAt >= beatAt)
        reject(`动作 ${id} 的零秒复位依据无效`)
      continue
    }
    if (binding) {
      const start = object(check.bindingStartCheck)
      if (start.applicable !== true || start.targetStillUnbound !== true
        || start.bindingMaterialSeparate !== true || start.bindingActionSpaceVisible !== true
        || !hasText(start.pixelEvidence)
          && !hasStructuredBindingEvidence(start, schemaVersion))
        reject(`动作 ${id} 已提前缚住，或缺少绳与肢体分离的像素证据`)
    }
    if (closure) {
      const start = object(check.gestureClosureStartCheck)
      if (start.applicable !== true || start.gestureNotRaised !== true
        || start.gapStillOpen !== true || start.guardsBeforeClosure !== true
        || !hasText(start.pixelEvidence)
          && !hasStructuredClosureEvidence(start, schemaVersion))
        reject(`动作 ${id} 已提前抬手或封住缺口，或缺少起点像素证据`)
    }
  }
  return true
}

type Param = { id: string; name: string; englishName?: string; type: string;
  required: boolean; value: string }
type Node = { id: string; prompt?: string; params?: Param[] }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }
const plateParam: Param = { id: 'sc-source-identity-plate-version', name: 'identityPlateVersion',
  englishName: 'identityPlateVersion', type: 'text', required: false,
  value: 'scene-cut-identity-plate-v3' }

/** Targeted schema169→170 update: source reference version plus two managed
 * prompts. Preserve all other node fields, edge order and manual edits. */
export function upgradeSceneCutOpeningProjectionWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![169, 170].includes(workflow.schemaVersion ?? 0))
    return workflow
  const archive = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-source-archive')
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!archive?.params || !image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V169, SCENE_CUT_FIRST_FRAME_PROMPT_V170].includes(image.prompt ?? '')
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V169, SCENE_CUT_FRAME_REVIEW_PROMPT_V170].includes(review.prompt ?? '')) return workflow
  const existing = archive.params.filter(param => param.englishName === 'identityPlateVersion')
  if (existing.length > 1 || existing.length === 1
    && (existing[0].id !== plateParam.id || existing[0].value !== plateParam.value)) return workflow
  if (workflow.schemaVersion === 170 && existing.length === 1
    && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V170
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V170) return workflow
  return { ...workflow, schemaVersion: 170, nodes: workflow.nodes.map(node => node.id === archive.id
    ? { ...node, params: existing.length ? node.params : [...(node.params ?? []), plateParam] } as N
    : node.id === image.id ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V170 } as N
      : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V170 } as N
        : node) } as W
}
