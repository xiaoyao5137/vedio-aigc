import { SCENE_CUT_FIRST_FRAME_PROMPT_V173,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V173 } from './scene-cut-staging-workflow.ts'
import { sceneCutBindingFromUnboundRequired, sceneCutGestureClosureStartRequired,
  sceneCutManipulationStartRequired } from './scene-cut-t0-image-contract.ts'
import { sceneCutActionPerformerFeetRequired } from './scene-cut-action-visibility-workflow.ts'

const replaceOnce = (source: string, before: string, after: string) => {
  if (source.split(before).length !== 2)
    throw Error('SCENE_CUT_MANAGED_PROMPT_DRIFT: 零秒动作起点的受管提示锚点变化')
  return source.replace(before, after)
}

/** Version 174 retains the approved shot and v4 identity plate. Source
 * landmarks are copied for each actor rather than inferred from a generic robe. */
export const SCENE_CUT_FIRST_FRAME_PROMPT_V174 = SCENE_CUT_FIRST_FRAME_PROMPT_V173 + `
【连续衣摆的零秒几何锚点·v9】逐位具名人物读取其所附局部身份参考板下方的连续正面衣装（这块从冻结三视图正面裁出）：把同一人的腰带上沿记为纵向 0、双靴鞋底记为纵向 1，分别看清外袍下摆、内层下摆和靴筒露出起点落在这段距离的哪个相对高度。把这些分界高度、外摆宽度、内摆可见面积和前后层次复制到本镜人物；人物的站姿和透视可自然变化，但不得把外摆与内摆一起向鞋底拉长、缩短露靴段，也不得以“同色且两层都在”代替比例一致。每个人只取其自身人设的地标，不套用别人的衣摆或固定数值。保持已批准的动作区与人物站位，尽量让合拢者的髋、膝、承重脚、动作手和唯一持绳者的手、松绳工作段及至少一个明确自由端可见；没有必要为显示绳的第二端增加绳索或改变动作。`

const v170Feet = '全身画幅必须完整看见参与者各脚的脚掌和脚跟，前景裁足或被遮挡使 allParticipantsFeetGrounded=false；严格比对批准机位方位和侧前角度。'
const v174Feet = '全身画幅对真正执行位移的参与者仍须完整看见脚掌、脚跟和接地状态，前景裁足或被遮挡使其 travelStartCheck.allParticipantsFeetGrounded=false；原地合拢者按发令手、开放缺口、各自起点及髋膝承重等静止正证逐人核对，个别远端手脚被遮不自动等于已经起步。严格比对批准机位方位和侧前角度。'
const v167Manipulation = '对每个 requiredThisClip 视觉动作，若动作要收紧、系结、拉紧或闭合绳带扣，且没有已批准的前置复位，requiredVisualActionChecks 对应项必须增加 manipulationStartCheck'
const v174Manipulation = '按每条 completion.evidenceAnchor 的主动作分类：从双腕未缚开始、在本节拍内再绕绳收紧结绳，使用 bindingStartCheck，manipulationStartCheck 填 {"applicable":false}；只有起点已绕松圈、主动作是收紧、系结、拉紧或闭合绳带扣且没有已批准前置复位，才为该条 requiredVisualActionChecks 增加 manipulationStartCheck'
const v172GeneralFeet = '若批准镜头为全景、全身或足部可见，执行者有任一脚掌、脚跟或其接触地面被遮挡、裁出画幅，就不能证明其尚未起步：对应 gestureClosureStartCheck.guardsBeforeClosure 或 travelStartCheck.allParticipantsFeetGrounded 为 false，hardChecks.bodyAndProps=false，passed=false。'
const v174GeneralFeet = '若批准镜头为全景、全身或足部可见，真正执行位移者的脚掌、脚跟和接地状态仍须完整可查；原地合拢者某只手脚局部被挡时，须逐人有仍在批准起点的髋膝、承重腿或支撑脚等可见静止正证，且被遮肢体不能存在正在前跨的合理可能。若起步状态无法确定，guardsBeforeClosure=false、passed=false；不可仅凭发令者未抬手或缺口仍开推定所有军士未动。'
const v172Closure = '对于合拢缺口动作，在 gestureClosureStartCheck 补 actionHandsUnoccluded、actionPerformersFeetAndGroundVisible 布尔值与 visibilityEvidence 字符串；执行合拢的军士和发令者的动作手必须实见，批准全景/全身时他们各脚与地面也须实见，否则对应项 false。'
const v174Closure = '对于合拢缺口动作，在 gestureClosureStartCheck 补 allApprovedPerformersCovered 布尔值、performerStartChecks 数组与 visibilityEvidence 字符串；数组逐位列出批准动作的合拢者，每项含 role、atApprovedOrigin、hipKneeOrSupportCueVisible、hiddenLimbCouldBeAdvancing、gapIntrusion、pixelEvidence。发令手必须实见仍未抬起，缺口敞开；每位合拢者须仍在原站位，有髋膝、承重腿或支撑脚的可见静止正证，隐藏肢体不能合理地正在前跨。可见抬脚、前跨、重心向缺口转移、身体已进入缺口，或缺乏足够正证时相应项 false、passed=false；不因次要手脚局部遮挡机械拒绝。'
const v172Binding = '对于由未缚到缚住的动作，在 bindingStartCheck 补 operatorHandAndRopeEndsVisible、targetRegionUnoccluded、actionPerformersFeetAndGroundVisible 布尔值与 visibilityEvidence；待缚肢体、持绳手、工作段和自由端须分别可辨，手不得挡住腕侧或打结区域；若不明则对应项 false，bindingActionSpaceVisible=false。此类起点不要求已有结口；'
const v174Binding = '对于由未缚到缚住的动作，在 bindingStartCheck 补 uniqueWorkingRopeOperator、operatorHandVisible、workingRopeVisible、oneFreeEndVisible、ropeSlackVisible、noWristContactOrClosedKnot、targetRegionUnoccluded 布尔值与 visibilityEvidence；双腕仍未缚且可见，唯一操作者的持绳手、工作段、至少一个可辨且松弛的自由端与腕侧负空间须实见。另一端可以在手中，不要求两端都展开，也不要求尚未形成的结口；只有模糊垂环而看不见任何端点、绳已贴腕或围腕、手遮住腕侧以致接触无法排除时对应项 false、passed=false。'
const v173ActionArea = '从批准分镜辨出实际参与必需动作的最少近身人员，检查每位执行者仍在批准起点，手、道具、工作绳两端和批准景别中的足部是否各自完整且无遮挡；纯背景人员可留在远景，但不得进入动作区遮挡或冒充第二组操作者。若某个执行者被主角、另一军士或画边遮挡，对应 gestureClosureStartCheck、bindingStartCheck 或 travelStartCheck 的可见性布尔项填 false，passed=false。'
const v174ActionArea = '从批准分镜辨出实际参与必需动作的最少近身人员。位移者在批准全景中的双足须可查；原地合拢者逐人核起点、髋膝或承重支撑的静止正证，只有不妨碍判断的局部遮挡才可接受；缚住动作核唯一操作者、待缚双腕、松绳工作段和至少一可辨自由端。纯背景人员可留远景，但不得进入动作区遮挡或冒充第二组操作者。可见起步/合拢/腕侧接触或结扣闭合，或遮挡使这些状态无法判定时，对应检查填 false、passed=false。'
const v173TwoEnds = '必须能辨出仅一名持工作绳的操作者；第二名合拢者不得另持重复绳索。'
const v174OneOperator = '必须能辨出仅一名持工作绳的操作者及至少一个松弛自由端；第二名合拢者不得另持重复绳索。'

/** Prompt amendments replace prior all-limbs/all-ends instructions; merely
 * appending an exception would leave conflicting reviewer instructions. */
export const SCENE_CUT_FRAME_REVIEW_PROMPT_V174 = [
  [v170Feet, v174Feet],
  [v167Manipulation, v174Manipulation],
  [v172GeneralFeet, v174GeneralFeet],
  [v172Closure, v174Closure],
  [v172Binding, v174Binding],
  [v173ActionArea, v174ActionArea],
  [v173TwoEnds, v174OneOperator],
].reduce((prompt, [before, after]) => replaceOnce(prompt, before, after),
  SCENE_CUT_FRAME_REVIEW_PROMPT_V173) + `
【起点正证与显著衣装差异·v9】合拢者个别远端手脚被挡时，performerStartChecks 的 pixelEvidence 必须写明其可见髋膝、承重腿或支撑脚如何证明仍在批准侧位、没有前跨；看不到足够身体锚点就填 hiddenLimbCouldBeAdvancing=true，不得只以发令者手势未起和缺口敞开替代。绳端检查只数真实可辨的端点：一段松绳的折返弧线不是自由端；至少一自由端加可操作工作段即可，不能要求第二端外露。服装仍以原三视图为准；若同一人的外摆、内摆都向鞋底明显偏移、露靴高度显著改变，即使颜色和两层结构相似，wardrobeHemCheck.matches=false 并列出腰带到鞋底的相对地标。`

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Value : {}
const reject = (reason: string): never => { throw Error(`SCENE_CUT_FRAME_REJECTED: ${reason}`) }
const twoSidedClosure = (shot: Value, beat: Value) => {
  const text = [shot.visualPrompt, beat.textOrVocalization, object(beat.completion).evidenceAnchor]
    .filter(value => typeof value === 'string').join(' ')
  return /(?:军士|士兵|卫兵)[^。；]{0,18}(?:两侧|左右)|(?:两侧|左右)[^。；]{0,18}(?:军士|士兵|卫兵)|(?:两名|两人|二名)[^。；]{0,8}(?:军士|士兵|卫兵)/u.test(text)
}

/** Versioned schema174 evidence gate. It accepts partial occlusion only when
 * every closure performer still has visible positive evidence of not moving. */
export function validateSceneCutActionStartReview(review: unknown, shot: unknown,
  options: { visualDetailsAdvisory?: boolean; uncertainManipulationAdvisory?: boolean } = {}) {
  const r = object(review), s = object(shot), pacing = object(s.pacing)
  if (r.passed !== true) reject('首帧审核原结论未通过，不可复用')
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  const checks = Array.isArray(r.requiredVisualActionChecks)
    ? r.requiredVisualActionChecks.map(object) : []
  const byId = new Map(checks.map(check => [String(check.beatId ?? ''), check]))
  for (const beat of beats) {
    const binding = sceneCutBindingFromUnboundRequired(beat)
    const closure = sceneCutGestureClosureStartRequired(beat)
    const tightening = sceneCutManipulationStartRequired(beat)
    if (!binding && !closure && !tightening) continue
    const id = String(beat.id ?? ''), check = byId.get(id)
    if (!check) return reject(`动作 ${id} 缺少零秒执行者审核`)
    if (check.approvedResetBeatId) continue // The base validator verifies the reset.
    if (closure) {
      const start = object(check.gestureClosureStartCheck)
      const performers = Array.isArray(start.performerStartChecks)
        ? start.performerStartChecks.map(object) : []
      if (start.allApprovedPerformersCovered !== true
        || performers.length < (twoSidedClosure(s, beat) ? 2 : 1)
        || start.gestureNotRaised !== true || start.gapStillOpen !== true
        || start.guardsBeforeClosure !== true
        || typeof start.visibilityEvidence !== 'string' || !start.visibilityEvidence.trim()
        || performers.some(actor => typeof actor.role !== 'string' || !actor.role.trim()
          || actor.atApprovedOrigin !== true || actor.hipKneeOrSupportCueVisible !== true
          || actor.hiddenLimbCouldBeAdvancing !== false || actor.gapIntrusion !== false
          || typeof actor.pixelEvidence !== 'string' || !actor.pixelEvidence.trim()))
        reject(`合拢动作 ${id} 缺少逐位执行者未起步的可见正证`)
    }
    if (binding) {
      const start = object(check.bindingStartCheck)
      const manipulation = object(check.manipulationStartCheck)
      if (start.applicable !== true || start.targetStillUnbound !== true
        || start.bindingMaterialSeparate !== true || start.bindingActionSpaceVisible !== true
        || start.uniqueWorkingRopeOperator !== true
        || start.operatorHandVisible !== true || start.workingRopeVisible !== true
        || start.oneFreeEndVisible !== true || start.ropeSlackVisible !== true
        || start.noWristContactOrClosedKnot !== true || start.targetRegionUnoccluded !== true
        || manipulation.applicable !== false
        || typeof start.visibilityEvidence !== 'string' || !start.visibilityEvidence.trim())
        reject(`缚住动作 ${id} 缺少未缚双腕、松绳工作段和可辨自由端`)
    } else if (tightening) {
      const start = object(check.manipulationStartCheck)
      const uncertain = options.uncertainManipulationAdvisory
        && start.uncertainStartAdvisory === true
        && check.terminalStateAlreadyPresent === false
        && check.actionStillPossible === true
        && start.slackOrGapVisible === true
        && start.operatorHandAndRopeEndsVisible === true
        && typeof start.visibilityEvidence === 'string' && start.visibilityEvidence.trim()
        && Array.isArray(r.advisoryIssues) && r.advisoryIssues.some(issue =>
          object(issue).beatId === id && /uncertain|not.verifiable|不明确/i.test(String(object(issue).code ?? '')))
      if (start.operatorHandAndRopeEndsVisible !== true
        || start.knotAndEndsUnoccluded !== true && !uncertain
        || typeof start.visibilityEvidence !== 'string' || !start.visibilityEvidence.trim())
        reject(`收紧动作 ${id} 的结口、操作手或绳端不可核对`)
    }
  }
  if (sceneCutActionPerformerFeetRequired(shot)) {
    const hem = object(r.wardrobeHemCheck)
    if (hem.applicable !== true || (!options.visualDetailsAdvisory && hem.matches !== true)
      || typeof hem.originalHemAndFootwear !== 'string' || !hem.originalHemAndFootwear.trim()
      || typeof hem.candidateHemAndFootwear !== 'string' || !hem.candidateHemAndFootwear.trim())
      reject('全景或全身首帧缺少原人设与候选图的连续衣摆比例核对')
  }
  return true
}

type Node = { id: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

/** Prompt-only schema173→174 migration. Rejected image records are preserved;
 * the traceable retry can keep source archive/plan and start at image. */
export function upgradeSceneCutActionStartWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![173, 174].includes(workflow.schemaVersion ?? 0))
    return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V173, SCENE_CUT_FIRST_FRAME_PROMPT_V174].includes(image.prompt ?? '')
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V173, SCENE_CUT_FRAME_REVIEW_PROMPT_V174].includes(review.prompt ?? ''))
    return workflow
  if (workflow.schemaVersion === 174 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V174
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V174) return workflow
  return { ...workflow, schemaVersion: 174,
    nodes: workflow.nodes.map(node => node.id === image.id
      ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V174 } as N
      : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } as N : node) } as W
}
