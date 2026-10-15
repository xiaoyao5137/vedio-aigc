import { SCENE_CUT_FIRST_FRAME_PROMPT_V176 } from './scene-cut-closure-start-layout-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V177 } from './scene-cut-controlled-edit-prompt.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from './scene-cut-action-start-workflow.ts'

/** The shared image node also serves ordinary scene cuts without repair images. */
export function buildSceneCutGeometryGuidePrompt(identityPlateCount: number,
  approvedOpeningPrompt: string): string {
  if (!Number.isInteger(identityPlateCount) || identityPlateCount < 1
    || identityPlateCount > 3 || !approvedOpeningPrompt.trim()) {
    throw Error('SCENE_CUT_GEOMETRY_GUIDE_INVALID: 身份板须为 1–3 张且零秒起点不能为空')
  }
  const rejectedIndex = identityPlateCount + 1
  const guideIndex = identityPlateCount + 2
  const identityRange = identityPlateCount === 1 ? '第 1 张'
    : `第 1 至 ${identityPlateCount} 张`
  return `【真人换场首帧·四参考几何修复·v178】
仅当服务端已绑定本次审核失败的首帧和独立几何引导图、参考图共 ${guideIndex} 张时，执行本节局部编辑。普通镜头若只有冻结身份板，跳过本节，按文末已批准零秒起点生成。不得把身份板、失败图或几何引导图互相替换。
参考顺序：${identityRange}是获批人物的冻结身份板，是脸、发冠、衣甲、外袍、连续深色内摆和鞋靴的唯一人物依据；第 ${rejectedIndex} 张是上一轮审核未通过的完整画面，仅供保留其中已核对正确的场景、机位、位置、绳端和物件细节；第 ${guideIndex} 张是另行生成的几何目标示意，仅指示执行者之间的无遮挡空间关系与衣摆高度。第 ${guideIndex} 张可能含身份、服装、背景细节的漂移，不得用它复制脸、甲片、旗幡、其他道具或背景。第 ${rejectedIndex}、${guideIndex} 张均非已批准首帧，失败结论不得继承为通过；新图必须独立重审。
在获批左右关系、侧前镜头轴线、人物数量与景深内，仅修正失败处：
1. 若获批镜头需要目标两侧的近身合拢执行者，把第 ${rejectedIndex} 张中被目标遮腿的那名执行者整体放到目标袍身外轮廓的同侧外方，同时保留其原本侧后方景深。其完整髋、双膝、两条腿、双靴和各自接地点须有像素可见，不得与目标袍身或杂物重叠，也不得前跨或进入原本开放的封口缺口。第 ${guideIndex} 张只用于核对这种独立轮廓、落脚和仍开放的间距，不提供人物身份。
2. 以冻结身份板同一正面人物的腰带上沿为纵向 0、双靴鞋底为 1，分别复制外袍摆和深色内摆的相对终点、层次、宽度与露靴比例。第 ${rejectedIndex} 张若把两层下摆延长，须两层都收回冻结板地标；第 ${guideIndex} 张只提示目标高度，不能凌驾于冻结板或改写衣装。双靴、双足和脚下地面完整入画。
3. 将第 ${rejectedIndex} 张出现、但已批准分镜并未要求的旗幡、可读字或其他新增道具去掉。第 ${guideIndex} 张即使画出旗幡，也不能作为其批准依据。场景中已获批的建筑、地面和其他物件保持。
保留第 ${rejectedIndex} 张中已经通过的发令者姿态和位置、目标未缚的双腕与起点、画面另一侧唯一持绳执行者的站位/双足/持绳手、同一根松绳的工作段和真实可辨自由端；持绳者整只外侧靴和足下地面必须与右画边留可见背景间隙，不能复制第 ${guideIndex} 张可能出现的右边裁切。不得把自由端画成闭环、藏入手中或移出画幅。第 ${guideIndex} 张只取左执行者的独立空间、两层衣摆目标高度和无新增旗幡的几何信息，右持绳者仍以第 ${rejectedIndex} 张已通过部分为准。不得增删人物、改变台词、提前执行合拢或缚腕；输出单幅写实 16:9 画面，不绘制引导线、标记、边框或参考图拼贴。
以下仍是获批的零秒起点与环境约束；未来动作不可提前画成终态：
${approvedOpeningPrompt}`
}

export const SCENE_CUT_FIRST_FRAME_PROMPT_V178 = buildSceneCutGeometryGuidePrompt(
  2, SCENE_CUT_FIRST_FRAME_PROMPT_V176)

type Node = { id: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

/** Schema177→178 changes only the managed first-frame image prompt. */
export function upgradeSceneCutGeometryGuideWorkflow<N extends Node, W extends Workflow<N>>(
  workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama'
    || ![177, 178].includes(workflow.schemaVersion ?? 0)) return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V177, SCENE_CUT_FIRST_FRAME_PROMPT_V178]
      .includes(image.prompt ?? '')
    || review.prompt !== SCENE_CUT_FRAME_REVIEW_PROMPT_V174) return workflow
  if (workflow.schemaVersion === 178 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V178)
    return workflow
  return { ...workflow, schemaVersion: 178,
    nodes: workflow.nodes.map(node => node.id === image.id
      ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V178 } as N : node) } as W
}
