import { SCENE_CUT_FRAME_REVIEW_PROMPT_V171 } from './scene-cut-ellipsis-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V170 } from './scene-cut-opening-projection-workflow.ts'
import { sceneCutBindingFromUnboundRequired, sceneCutGestureClosureStartRequired,
  sceneCutManipulationStartRequired, sceneCutFeetInspectionRequired } from './scene-cut-t0-image-contract.ts'

const oldIdentityBoard = '每位具名人物的冻结人设以一张 2×2 局部参考板附图提供：左上仅脸、发冠与颈肩，右上仅领口、肩胸和衣甲，左下为革带至外袍摆，右下为内层下摆与鞋靴。这四块属于同一人，只复制容貌、材质、外袍长度、内层下摆和露靴比例；不拼成两个演员，也不复制原人设的直立姿势。'
const identityBoardV4 = '每位具名人物的冻结人设以一张局部参考板附图提供：上方左块是脸、发冠与颈肩，上方右块是领口、肩胸与衣甲；下方是同一正面原图从腰带连续到外袍摆、内层下摆和鞋靴的一整块，腰以下只缩放一次，不把外袍和内摆分开缩放。三块属于同一人，只复制容貌、衣甲以及下方连续衣装的真实宽窄、长度、层次和露靴比例；不拼成多个演员，也不复制原人设的直立姿势。'

/** The approved shot and opening plan remain frozen. This addendum only makes
 * their visible t=0 staging easier for the image model and reviewer to audit. */
export const SCENE_CUT_FIRST_FRAME_PROMPT_V172 = SCENE_CUT_FIRST_FRAME_PROMPT_V170
  .replace(oldIdentityBoard, identityBoardV4) + `
【动作执行者与道具的可审构图·v7】按零秒起点计划区分本镜必需动作的执行者和纯背景人物。若军士随后要合拢缺口、缚腕或押送，执行这些动作的近身军士保持在已批准的两侧、侧后方或其他起始站位；不要把他们藏到背景军士身后，也不要为露脚更换左右关系、机位或人数。纯背景军士只保持批准的场景层次，不要求逐个拍到双足。
批准为全景、全身或明确能看见足部的构图时，所有必需动作执行者，包括具名人物和执行动作的匿名人物，都从头到靴完整入画；各自脚掌、脚跟和接触地面之间不被前景人物、兵器、衣摆或画幅边缘遮住，静止留在批准的起点。若批准为近景或脚部不入画，保留原景别，以肩胯、手中道具和相对站位呈现尚未起步，不为拍脚扩大画幅。
若随后要缚住原本未缚的肢体，把待缚双腕、操作者的持绳手、绳的工作段与可辨的自由端安排在同一可见区域：绳与腕仍分离、没有围腕闭结，持绳手在绳端侧边，不能盖住双腕或将来打结的区域。若随后只要收紧已绕好的松圈，则松圈、敞开结口、工作端和自由端同框可辨，手不得遮住结口；外段垂环不能代替腕侧松量。不增加新的操作步骤。
人物服装逐块对照同一身份参考板的外袍和内层下摆：保留两层各自的宽窄、长度、垂落轮廓及露出的裤腿和鞋靴比例。不要为了构图拉长外袍、缩窄或遮没内摆；在批准的可见范围内让衣摆与鞋靴足够清楚，供审核与原始人设图比对。`

export const SCENE_CUT_FRAME_REVIEW_PROMPT_V172 = SCENE_CUT_FRAME_REVIEW_PROMPT_V171 + `
【动作执行者可见性与衣摆比例·v7】逐条从批准节拍识别真正要合拢、缚腕、押送或走近的人，含执行动作的匿名军士；仅在这些执行者身上核对起点姿态、手部道具和批准景别所要求的足部，纯背景军士不算必需动作执行者。若批准镜头为全景、全身或足部可见，执行者有任一脚掌、脚跟或其接触地面被遮挡、裁出画幅，就不能证明其尚未起步：对应 gestureClosureStartCheck.guardsBeforeClosure 或 travelStartCheck.allParticipantsFeetGrounded 为 false，hardChecks.bodyAndProps=false，passed=false。全景的 travelStartCheck.feetInspectionRequired=true；若批准为近景且脚部本来不入画，填 false，不强迫改景别拍脚，仍需通过肩胯、道具与相对站位证实静止起点。
对于合拢缺口动作，在 gestureClosureStartCheck 补 actionHandsUnoccluded、actionPerformersFeetAndGroundVisible 布尔值与 visibilityEvidence 字符串；执行合拢的军士和发令者的动作手必须实见，批准全景/全身时他们各脚与地面也须实见，否则对应项 false。对于由未缚到缚住的动作，在 bindingStartCheck 补 operatorHandAndRopeEndsVisible、targetRegionUnoccluded、actionPerformersFeetAndGroundVisible 布尔值与 visibilityEvidence；待缚肢体、持绳手、工作段和自由端须分别可辨，手不得挡住腕侧或打结区域；若不明则对应项 false，bindingActionSpaceVisible=false。此类起点不要求已有结口；对于已绕松圈待收紧的动作，在 manipulationStartCheck 补 operatorHandAndRopeEndsVisible、knotAndEndsUnoccluded 布尔值与 visibilityEvidence，松圈、敞开结口和自由端须同框，遮挡则 unfinishedFastenerVisible=false。非全景/全身/足部可见时 actionPerformersFeetAndGroundVisible 可填 false，不因此判失败；其他适用的手部/道具证据仍须实见。
wardrobeHemCheck 必须对照原始三视图和候选图的外袍宽窄及长度、连续内层下摆的可见面积与垂落高度、裤腿和鞋靴露出比例；只同色但内摆变窄、被外袍盖没或比例改变时 matches=false，hardChecks.wardrobeAndEquipment=false，passed=false。看不清即不确定，不能依据提示或参考板代替实图。`

type Param = { id: string; englishName?: string; value: string }
type Node = { id: string; prompt?: string; params?: Param[] }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }
type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Value : {}
const reject = (reason: string): never => { throw Error(`SCENE_CUT_FRAME_REJECTED: ${reason}`) }

/** Wide shots expose the people performing an approved visual action. The
 * earlier opening-plan contract intentionally stays frozen for old records. */
export function sceneCutActionPerformerFeetRequired(shot: unknown) {
  const s = object(shot)
  const camera = typeof s.camera === 'string' ? s.camera : ''
  const opening = camera.split(/[。；\n]/u).find(part => /(?:开场|首帧|零秒)/u.test(part)) ?? ''
  if (/(?:中景|近景|特写|半身|头部至大腿|胸部以上)/u.test(opening)
    && !/(?:全身|全景|足部可见|脚掌可见|脚跟可见)/u.test(opening)) return false
  return sceneCutFeetInspectionRequired(s)
    || /全景/u.test([s.visualPrompt, s.camera, s.visualConstraints]
      .filter(value => typeof value === 'string').join(' '))
}

/** V172 adds inspectability to the existing beat checks. It never asks that
 * background bystanders or feet outside an approved close shot be visible. */
export function validateSceneCutActionVisibilityReview(review: unknown, shot: unknown) {
  const r = object(review), pacing = object(object(shot).pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  const checks = Array.isArray(r.requiredVisualActionChecks)
    ? r.requiredVisualActionChecks.map(object) : []
  const byId = new Map(checks.map(check => [String(check.beatId ?? ''), check]))
  const feetRequired = sceneCutActionPerformerFeetRequired(shot)
  for (const beat of beats) {
    const binding = sceneCutBindingFromUnboundRequired(beat)
    const closure = sceneCutGestureClosureStartRequired(beat)
    const tightening = sceneCutManipulationStartRequired(beat)
    if (!binding && !closure && !tightening) continue
    const id = String(beat.id ?? ''), check = byId.get(id)
    if (!check) return reject(`动作 ${id} 缺少执行者可见性审核`)
    if (check.approvedResetBeatId) continue // The base validator checks the approved reset.
    if (closure) {
      const visibility = object(check.gestureClosureStartCheck)
      if (visibility.actionHandsUnoccluded !== true
        || feetRequired && visibility.actionPerformersFeetAndGroundVisible !== true
        || typeof visibility.visibilityEvidence !== 'string' || !visibility.visibilityEvidence.trim())
        reject(`合拢动作 ${id} 的执行者手部或批准景别内的双足被遮挡`)
    }
    if (binding) {
      const visibility = object(check.bindingStartCheck)
      if (visibility.operatorHandAndRopeEndsVisible !== true
        || visibility.targetRegionUnoccluded !== true
        || feetRequired && visibility.actionPerformersFeetAndGroundVisible !== true
        || typeof visibility.visibilityEvidence !== 'string' || !visibility.visibilityEvidence.trim())
        reject(`缚住动作 ${id} 的持绳手、绳端、腕侧或执行者足部不可核对`)
    } else if (tightening) {
      const visibility = object(check.manipulationStartCheck)
      if (visibility.operatorHandAndRopeEndsVisible !== true
        || visibility.knotAndEndsUnoccluded !== true
        || typeof visibility.visibilityEvidence !== 'string' || !visibility.visibilityEvidence.trim())
        reject(`收紧动作 ${id} 的结口、操作手或绳端不可核对`)
    }
  }
  if (feetRequired) {
    const hem = object(r.wardrobeHemCheck)
    if (hem.applicable !== true || hem.matches !== true
      || typeof hem.originalHemAndFootwear !== 'string' || !hem.originalHemAndFootwear.trim()
      || typeof hem.candidateHemAndFootwear !== 'string' || !hem.candidateHemAndFootwear.trim())
      reject('全景或全身首帧缺少原人设与候选图的连续衣摆比例核对')
  }
  return true
}

/** Schema172 changes only the frozen reference-board version and two managed
 * prompts. The shot-bound opening plan, edges and accepted script remain
 * byte-identical. A failed candidate retries from source archive. */
export function upgradeSceneCutActionVisibilityWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![171, 172].includes(workflow.schemaVersion ?? 0))
    return workflow
  const archive = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-source-archive')
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  const plateParams = archive?.params?.filter(param => param.englishName === 'identityPlateVersion') ?? []
  if (!archive?.params || plateParams.length !== 1
    || plateParams[0].id !== 'sc-source-identity-plate-version'
    || !['scene-cut-identity-plate-v3', 'scene-cut-identity-plate-v4'].includes(plateParams[0].value)
    || !image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V170, SCENE_CUT_FIRST_FRAME_PROMPT_V172].includes(image.prompt ?? '')
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V171, SCENE_CUT_FRAME_REVIEW_PROMPT_V172].includes(review.prompt ?? ''))
    return workflow
  if (workflow.schemaVersion === 172 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V172
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V172
    && plateParams[0].value === 'scene-cut-identity-plate-v4') return workflow
  return { ...workflow, schemaVersion: 172,
    nodes: workflow.nodes.map(node => node.id === archive.id
      ? { ...node, params: node.params?.map(param => param.englishName === 'identityPlateVersion'
        ? { ...param, value: 'scene-cut-identity-plate-v4' } : param) } as N
      : node.id === image.id
      ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V172 } as N
      : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V172 } as N : node) } as W
}
