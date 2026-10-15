import { SCENE_CUT_FIRST_FRAME_PROMPT_V174,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from './scene-cut-action-start-workflow.ts'

/** Schema175 changes only the image request. The schema174 independent
 * reviewer and all signed approval conditions retain their exact bytes. */
export const SCENE_CUT_FIRST_FRAME_PROMPT_V175 = SCENE_CUT_FIRST_FRAME_PROMPT_V174 + `
【多名合拢者的独立起点轮廓·v10】仅当批准节拍确有多人从目标两侧合拢缺口时，在原批准机位、视线轴、左右关系、人数与侧后方起点内安排画面：真正随后要合拢的近身执行者分别在目标画面左侧和右侧的侧翼，各有独立、连续的人形轮廓；若批准每侧不止一人，也逐人横向错开，不减少或增加批准人数。即使某人原位偏侧后，也与目标身体横向错开，让其头肩、髋膝、承重腿、另一条腿、两只靴及脚下接地地面在首帧可见。把筐箱、堆物、立柱等场景遮挡物留在执行者身后，不要让它们或目标袍身盖住髋膝与支撑腿；近画边的持绳者若也是合拢者，整只外侧靴和足下留白必须入画。执行者不得与目标袍身、另一执行者、兵器或画幅边缘叠成一条遮挡线；每名实际合拢者都保持原地静止、尚未伸手或向缺口迈步。单人合拢或其他动作不增设第二名执行者。
保留批准的发令者与目标相对左右位置、起始距离和斜侧全景角度；可把目标放在画幅内侧、留足两侧横向空间，不把目标推到极右或极左边缘，不为露脚改变场所、动作、视线轴或取景尺度。需要在侧后方出现、但不执行本条合拢动作的背景人物放在更远景深，不贴目标两侧或遮住近身执行者；他们不拿工作绳，也不冒充第三个合拢者。唯一持绳操作者可以同时是已批准的合拢者，不额外复制人物或绳索。保留连续身份板的衣摆地标和此前全部零秒未完成要求。`

type Node = { id: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

/** Strict image-prompt-only schema174→175 migration. Saved review prompts,
 * archive/plan nodes, edges and approved shot script stay byte-identical. */
export function upgradeSceneCutClosureLayoutWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![174, 175].includes(workflow.schemaVersion ?? 0))
    return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!image || !review
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V174, SCENE_CUT_FIRST_FRAME_PROMPT_V175].includes(image.prompt ?? '')
    || review.prompt !== SCENE_CUT_FRAME_REVIEW_PROMPT_V174)
    return workflow
  if (workflow.schemaVersion === 175 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V175)
    return workflow
  return { ...workflow, schemaVersion: 175,
    nodes: workflow.nodes.map(node => node.id === image.id
      ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V175 } as N : node) } as W
}
