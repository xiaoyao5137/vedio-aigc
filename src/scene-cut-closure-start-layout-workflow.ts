import { SCENE_CUT_FIRST_FRAME_PROMPT_V175 } from './scene-cut-closure-layout-workflow.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from './scene-cut-action-start-workflow.ts'

/** A leading positive composition instruction for the approved two-sided
 * closure pattern. The previous signed reviewer remains exactly v174. */
export const SCENE_CUT_FIRST_FRAME_PROMPT_V176 = `【零秒首帧最先执行的动作区布局·v11】
仅当批准镜头是两侧近身执行者随后合拢同一目标、且右侧执行者兼持一根工作绳时，首帧先按画面横向排出三个互不重叠的完整轮廓：左合拢执行者 — 目标人物 — 右侧持绳合拢执行者。左执行者保持批准的目标侧后起点及景深，但整体位于目标袍身外轮廓的画面左方；其头肩、完整髋部、双膝、两条腿、双靴和各自踩住的地面都在目标袍摆左缘外清楚可见。左执行者是获批的近身合拢人员，不能由发令者或远景守兵充当；若原分镜仅右侧一人持工作绳，左者空手或只持原批准道具，不复制绳索。左执行者不得藏在目标正后方、筐箱后方或右侧人群内。右侧持绳执行者保持批准右侧起点，完整身形和双靴留在画内。发令者仍在批准的左侧距离，目标身前通向发令者的缺口仍敞开；两名合拢者只守在缺口的左右侧后起点，尚未迈步、伸手或占据缺口。其他已批准的侧后军士只作更远景的背景守位，不挤到目标近身、不遮挡实际合拢者，也不冒充新的执行者。若批准角色位置不同，按已批准位置对应安排清晰轮廓，不强行镜像或增加人物。
仅当批准镜头含从未缚到缚住的动作时，一名获批操作者只持一根尚未接触待缚肢体的松绳；若获批多人共持则按原分镜。持绳手握工作绳中段，工作段与一条真正的松弛短尾巴分开可见；若批准画幅含全身，短尾巴从手中垂到膝下、踝上，在浅色地面背景前以清楚的截断头或少量散股终止。这个末梢端点与回折绳股、手、衣甲、靴子和地面之间留出可见背景间隙；要验证的端头不能藏在拳内、折回成封闭绳圈、与另一段混成回环或伸出画幅，绳的另一端可留在手中。若批准是近景，仍在原画幅内呈现端头，不为露端扩大景别。可以有自然松弧，但单纯垂环绝不是自由端。待缚肢体仍分开未缚，肢体与绳之间有负空间，不预画围绕肢体的绳圈或已结绳结。持绳者仍在已批准的那一侧，不另添操作者或绳索。保留批准机位轴线、场所、人物数量与左右关系、冻结身份衣摆比例；不修改动作或台词。\n${SCENE_CUT_FIRST_FRAME_PROMPT_V175}`

type Node = { id: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

/** Schema175→176 changes only the managed image prompt. Approval and
 * reviewer contracts, source archive, plan, graph and accepted shot are fixed. */
export function upgradeSceneCutClosureStartLayoutWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![175, 176].includes(workflow.schemaVersion ?? 0))
    return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V175, SCENE_CUT_FIRST_FRAME_PROMPT_V176].includes(image.prompt ?? '')
    || review.prompt !== SCENE_CUT_FRAME_REVIEW_PROMPT_V174)
    return workflow
  if (workflow.schemaVersion === 176 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V176)
    return workflow
  return { ...workflow, schemaVersion: 176,
    nodes: workflow.nodes.map(node => node.id === image.id
      ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V176 } as N : node) } as W
}
