import { SCENE_CUT_FIRST_FRAME_PROMPT_V176 } from './scene-cut-closure-start-layout-workflow.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from './scene-cut-action-start-workflow.ts'

export type SceneCutControlledEditPromptInput = {
  /** Frozen identity plates, in the same order as the approved source archive. */
  identityPlateCount: number
  /** The approved opening prompt, kept intact as the source of scene and T0 rules. */
  approvedOpeningPrompt: string
  /** Shared workflow prompt: ordinary shots without a rejected extra image use the base. */
  onlyWhenRejectedFrameAttached?: boolean
}

/**
 * A prompt for a retry with one additional, rejected frame as a composition
 * reference. The caller must separately bind the ordered image bytes and
 * hashes; this text alone is not a source or payment certificate.
 */
export function buildSceneCutControlledEditPrompt(input: SceneCutControlledEditPromptInput): string {
  const { identityPlateCount, approvedOpeningPrompt, onlyWhenRejectedFrameAttached = false } = input
  if (!Number.isInteger(identityPlateCount) || identityPlateCount < 1 || identityPlateCount > 4)
    throw Error('SCENE_CUT_EDIT_REFERENCE_INVALID: 身份板数量须为 1–4，且总附图数不超过 5')
  if (!approvedOpeningPrompt.trim())
    throw Error('SCENE_CUT_EDIT_REFERENCE_INVALID: 缺少已批准的首帧起点提示')

  const candidateIndex = identityPlateCount + 1
  const identityRange = identityPlateCount === 1 ? '第 1 张'
    : `第 1 至 ${identityPlateCount} 张`
  const imageCountIntro = onlyWhenRejectedFrameAttached
    ? `上述编辑条件成立时，附图共 ${candidateIndex} 张`
    : `本次共附 ${candidateIndex} 张参考图`
  return `【真人换场首帧·受控局部改图·v177】
${onlyWhenRejectedFrameAttached
  ? `仅当本次请求确有经服务端绑定的额外失败首帧编辑参考图、且前 ${identityPlateCount} 张是冻结身份板、第 ${candidateIndex} 张是该失败图时，执行本节受控改图。若没有这张额外失败图，或第 ${candidateIndex} 张仍是某个人物的身份板，则跳过本节改图，只按文末已批准零秒起点正常生成；不得把身份板误当失败图。\n`
  : ''}
${imageCountIntro}，顺序不可互换：${identityRange}是按获批人物顺序排列的冻结身份参考板，负责脸、发冠、衣甲、外袍与内层下摆、鞋靴的身份和比例；第 ${candidateIndex} 张是上一次审核未通过的完整首帧，仅供复用已经正确的构图、机位、场景和物件位置。最后一张不能作为人物身份或衣摆长度的依据；凡与前面的冻结身份板冲突，均以前面的身份板为准。最后一张也不是已批准输出，其旧审核结论不得继承；新画面必须重新独立审查。
在最后一张的完整单幅画面上做最少范围的两项可见修正，保持批准分镜和下列原首帧零秒起点：
1. 若批准镜头是两侧近身合拢同一目标、且参考首帧的目标画面左后方执行者腿部被目标袍身挡住，只把这位获批执行者整体向画面左方横移少量，并保持其原本侧后方景深和静止站位。他仍是原来那个人，不新增或删减军士；不得挪到发令者与目标之间的开放缺口。横移后，他与目标外轮廓不重叠：整副髋部、双膝、两条腿、两只靴及各自接触地面的点均清楚入画；身体不前跨、不伸手、不提前合拢。目标与发令者的已批准左右关系、初始距离和镜头轴线保持。
2. 若冻结身份板显示目标人物的双层衣摆比最后一张参考图更高，按该人物自己的连续下装参考裁片校正两层下摆。以同一人的腰带上沿为纵向 0、双靴鞋底为 1，对照原板中外袍摆、深色内层摆及露出的裤腿和靴筒的相对高度与宽度；只把错误下延的外摆和内摆收至原板地标，保留原来的布料颜色、层次、衣甲、腰带、双靴及脚下地面。不能只缩外层而让内层继续盖住靴筒，也不能把脚或鞋靴裁出画面。若原板不支持该修正，不凭失败图猜造新衣装。
除上述确需修正的像素外，保留最后一张中已通过核对的完整画面：发令者的容貌、衣甲、姿态和位置；目标的脸、冠、上装、未缚的双腕和起点姿态；画面右侧唯一持绳执行者的身份、站位、双足、持绳手；同一根松绳的工作段、与双腕的负空间，以及已经清晰露出的真实自由端。不得把真实自由端改成闭合绳环、藏入手中或移出画幅。保留已批准的其余人物数量、背景、光线和相机方位，不重排整场、不变更动作或台词；一张写实 16:9 首帧，不做分屏、拼贴或局部补丁边框。
以下是必须继续遵守的已批准零秒起点与环境约束；其中的未来动作仅用于保证零秒尚未开始，不得画成动作终态：
${approvedOpeningPrompt}`
}

/** The schema177 retry candidate for the current two-identity-board route.
 * Integration must still prove the third image is the recorded rejected frame. */
export const SCENE_CUT_FIRST_FRAME_PROMPT_V177 = buildSceneCutControlledEditPrompt({
  identityPlateCount: 2,
  approvedOpeningPrompt: SCENE_CUT_FIRST_FRAME_PROMPT_V176,
  onlyWhenRejectedFrameAttached: true,
})

type Node = { id: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

/** Schema176→177 replaces the managed image prompt only. Source archive,
 * opening plan, independent review, approved shot and graph stay unchanged. */
export function upgradeSceneCutControlledEditWorkflow<N extends Node, W extends Workflow<N>>(
  workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama'
    || ![176, 177].includes(workflow.schemaVersion ?? 0)) return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V176, SCENE_CUT_FIRST_FRAME_PROMPT_V177]
      .includes(image.prompt ?? '')
    || review.prompt !== SCENE_CUT_FRAME_REVIEW_PROMPT_V174) return workflow
  if (workflow.schemaVersion === 177 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V177)
    return workflow
  return { ...workflow, schemaVersion: 177,
    nodes: workflow.nodes.map(node => node.id === image.id
      ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V177 } as N : node) } as W
}
