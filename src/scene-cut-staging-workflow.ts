import { SCENE_CUT_FIRST_FRAME_PROMPT_V172,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V172 } from './scene-cut-action-visibility-workflow.ts'

const previousFlagInstruction = '背景有旗帜时使用纯色无字布面，不画字形、拟字形、符号或标语。'
const approvedFlagInstruction = '只有已批准静态场景明确要求旗帜时才画旗帜，并只用纯色无字布面；未要求旗帜时不要添加旗帜、幡或旗杆。任何已批准旗面都不得画字形、拟字形、符号或标语。'
const previousTextVerdict = '只要出现可辨文字或拟字形，或远景无法确认无字，readableGlyphsPresent=true 或 backgroundInspected=false，passed=false，issues 写出区域；无字时说明实见证据。'
const observedTextVerdict = '逐一检查实图区域；只有实见可辨文字或可辨拟字形时才填 readableGlyphsPresent=true、passed=false，并在 issues 标出区域。远处小物因分辨率低而完全看不出字形时，不得把“无法证明绝对无字”推断成“实见文字”：已查看该区域则 backgroundInspected=true、readableGlyphsPresent=false，在 pixelEvidence 写明距离、模糊程度与没有可辨笔画。若该区域被完全遮挡而无法检查，backgroundInspected=false；可辨的规整拟字笔画仍须拒绝。'
const previousHemVerdict = '只同色但内摆变窄、被外袍盖没或比例改变时 matches=false，hardChecks.wardrobeAndEquipment=false，passed=false。'
const proportionalHemVerdict = '只同色但衣层缺失、内摆被外袍盖没，或归一化下摆/露靴比例出现实见且显著改变时 matches=false，hardChecks.wardrobeAndEquipment=false，passed=false；衣褶、视角与轻微比例差异须按可见层次和归一化地标判断。'

/** Schema173 keeps the approved cast, positions, camera, action plan and v4
 * identity plate. It gives the image model an auditable frame composition. */
export const SCENE_CUT_FIRST_FRAME_PROMPT_V173 = SCENE_CUT_FIRST_FRAME_PROMPT_V172
  .replace(previousFlagInstruction, approvedFlagInstruction) + `
【动作区、边界留白与连续衣装·v8】在已批准机位、人物左右关系、起始距离和匿名群体规模内，只让执行必需合拢、缚住或移动动作所需的最少近身人物占据动作区；其他已批准的匿名背景人物留在原有背景层次，不持与操作人相同的工作绳，不挤入、重复或遮住动作区。不要增加第二组操作者或复制工作绳。把主要人物与全部动作执行者安排在可看清的安全画幅内，四边留出足、手和绳端的空间；不裁脚、不把执行者藏在主角后面，也不为此改变批准的左右位置、视线轴、景别或人数。
同一条必需缚住动作只安排一名明确的持绳操作者和一根工作绳，除非批准分镜明确要求多人共持；其他合拢者空手或仅持原分镜批准的道具，不复制第二根绳。持绳操作者位于待缚目标的可见侧，双手、工作段、自由端与未缚肢体各有清楚轮廓，彼此不重叠；其足部在批准全景里完整可见。合拢者各自停在已批准的缺口两侧或其他批准起点，手和双足不被主角、背景军士、兵器或画边遮住。保持每条动作仍处零秒未完成状态。
服装参考板下方是同尺度连续的腰带至靴子图像。对每位具名人物把“腰带到鞋底”视为相同的相对长度，再对齐外袍下摆、内层下摆与露靴起点的位置及层次；保留人设原本的外摆宽度、内摆可见面积和靴筒露出比例。允许正常站姿、衣褶、透视造成的小变化，不把内摆缩没，也不为了遮靴拉长外袍。`

/** Existing action and identity checks stay fail closed. The previous rule
 * treated an unresolvable distant blur as a positive text finding; v173 asks
 * for observed glyphs while the image prompt omits unapproved flags. */
export const SCENE_CUT_FRAME_REVIEW_PROMPT_V173 = SCENE_CUT_FRAME_REVIEW_PROMPT_V172
  .replace(previousTextVerdict, observedTextVerdict)
  .replace(previousHemVerdict, proportionalHemVerdict) + `
【动作区与归一化服装审查·v8】从批准分镜辨出实际参与必需动作的最少近身人员，检查每位执行者仍在批准起点，手、道具、工作绳两端和批准景别中的足部是否各自完整且无遮挡；纯背景人员可留在远景，但不得进入动作区遮挡或冒充第二组操作者。若某个执行者被主角、另一军士或画边遮挡，对应 gestureClosureStartCheck、bindingStartCheck 或 travelStartCheck 的可见性布尔项填 false，passed=false。同一条缚住动作若批准分镜未明确多人共持，必须能辨出仅一名持工作绳的操作者；第二名合拢者不得另持重复绳索。不能以额外人手或两根含糊的绳代替一名明确的操作者。
wardrobeHemCheck 的 originalHemAndFootwear 和 candidateHemAndFootwear 须逐位具名人物写出实见层次，并以各自“腰带到鞋底”高度归一化，说明外摆、内摆和露靴起点的约略相对位置。比较同一个人时允许视角、衣褶与站姿带来的轻微偏差；仅凭靴筒多露一点或袍摆一条边的微小差异，不得判 matches=false。只有衣层缺失、可见内摆面积或下摆/露靴比例有清楚且显著改变，才判 matches=false，并在 issues 写明两图的归一化地标和具体差异；关键部位被遮挡到无法核对时不确定仍不得通过。保持脸、衣甲与身体状态连续性的既有硬检。
若场景未要求旗帜而候选图自行添加，审查在 issues 标明未批准道具，setting/bodyAndProps 不通过。已批准但极远且模糊的旗面依实际可辨字形判断，不把“看不清”当成有字；一旦能辨出文字或拟字形仍按禁字规则拒绝。`

/** The first schema173 CAS used this otherwise identical prompt. Keep the
 * exact bytes for a narrowly guarded pre-execution refresh. */
export const SCENE_CUT_FRAME_REVIEW_PROMPT_V173_INITIAL =
  SCENE_CUT_FRAME_REVIEW_PROMPT_V173.replace(proportionalHemVerdict, previousHemVerdict)

type Node = { id: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

/** Prompt-only upgrade for a rejected candidate; source archive and opening
 * plan are retained, so the traceable retry can begin at the image node. */
export function upgradeSceneCutStagingWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![172, 173].includes(workflow.schemaVersion ?? 0))
    return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V172, SCENE_CUT_FIRST_FRAME_PROMPT_V173].includes(image.prompt ?? '')
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V172, SCENE_CUT_FRAME_REVIEW_PROMPT_V173].includes(review.prompt ?? ''))
    return workflow
  if (workflow.schemaVersion === 173 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V173
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V173) return workflow
  return { ...workflow, schemaVersion: 173,
    nodes: workflow.nodes.map(node => node.id === image.id
      ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V173 } as N
      : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V173 } as N : node) } as W
}

/** Only the contradictory wardrobe sentence is refreshed; the image prompt,
 * approved graph and schema number remain unchanged. */
export function refreshSceneCutStagingReviewPrompt<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 173) return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (image?.prompt !== SCENE_CUT_FIRST_FRAME_PROMPT_V173 || !review
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V173_INITIAL,
      SCENE_CUT_FRAME_REVIEW_PROMPT_V173].includes(review.prompt ?? '')) return workflow
  if (review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V173) return workflow
  return { ...workflow, nodes: workflow.nodes.map(node => node.id === review.id
    ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V173 } as N : node) } as W
}
