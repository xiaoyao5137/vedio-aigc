import { sceneCutApproachStartRequired, sceneCutFeetInspectionRequired,
  sceneCutMovementStartRequired } from './scene-cut-t0-image-contract.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V168,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V168 } from './scene-cut-opening-plan-workflow.ts'

export const SCENE_CUT_FIRST_FRAME_PROMPT_V169 = `【真人换场零秒首帧·静态投影】
只画一张 16:9 写实电影首帧：镜头尚未开始任何本镜必需动作时的单一静止瞬间。已批准静态环境、人物和初始机位：\${scene_cut_opening_state.openingVisualContext}。逐节拍派生的零秒可见起点：\${scene_cut_opening_state.positiveOpeningDescription}。已冻结人物的局部身份参考板已作为图片附件按名字顺序提供；每板左右两块属于同一个人，不是两个演员。
在批准的起点与机位上清楚画出当前操作还未完成的物体结构。若后续要收紧绳带，束缚处本体与皮肤或道具之间有清楚可见松圈空隙，结口未闭，自由端尚在操作者手中；外侧牵引绳下垂不能替代束缚处松量。人物在原地静止，若后续要踏稳挺背，原地屈膝、偏重心、躯干前倾。若批准构图是全身或足部可见，参与位移者每只脚的脚掌和脚跟都落地；若是近景，保持原构图，以肩胯、道具和相对站位呈现尚未起步。目标可在人物背后，留出后续转身和行走空间。
逐图复制身份板的脸型、眉眼、胡须分布与年龄感，以及外袍长度、连续内层下摆和裤靴比例；仅继承人设，不复制原图站姿。每位具名人物只出现一次。背景旗帜、匾额、衣甲及道具保持无字；无字幕、水印、分格。`
export const SCENE_CUT_FRAME_REVIEW_PROMPT_V169 = SCENE_CUT_FRAME_REVIEW_PROMPT_V168 + `
【未起步与转向空间实图硬检·v5】对每个 requiredThisClip 的押送、步行、跨门、转移或抵达动作，requiredVisualActionChecks 增加 travelStartCheck：{"applicable":true,"atApprovedOrigin":false,"feetInspectionRequired":false,"allParticipantsFeetGrounded":false,"noStrideInProgress":false,"destinationNotReached":false,"routeStillPossible":false,"pixelEvidence":"分别指出批准画幅、出发位置、足部若可见时每位参与者足跟脚掌、身体或牵引物是否已运动、目标与可转身或行走空间"}。feetInspectionRequired 只在批准分镜明确全身或足部可见时为 true，此时每位移动参与者的足跟脚掌必须实见均接地，无法核对则 false。近景或局部填 feetInspectionRequired=false，不为看脚强迫改变构图，但必须从肩胯、牵引物及相对站位实证静止未起步。人物或押送者一只脚抬起、脚跟离地、前后跨步成行走姿态，或已被牵行，noStrideInProgress=false；只因双腿不均衡而称尚未踏稳，不得覆盖已经起步的像素。起始背对目标允许，门在背后也允许，但须按已批准地点、朝向保留后续转身及行走余地；不得仅因目标在背后就判失败。任何必需项无法从实际图片确认时该项为 false，passed=false。无位移动作的检查填 {"applicable":false}。同时从原三视图实图逐项核对脸型、眉眼、胡须、年龄与连续长袍下摆，不能让人设板或提示词替代证据。`

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const reject = (reason: string): never => { throw Error(`SCENE_CUT_FRAME_REJECTED: ${reason}`) }

/** Schema-169 paid-video gate: a later movement beat must not be in progress at t=0. */
export function validateSceneCutTravelStartReview(review: unknown, shot: unknown,
  contractVersion: 2 | 3 = 2, feetInspectionOverride?: boolean) {
  const r = object(review), pacing = object(object(shot).pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  const schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(object) : []
  const checks = Array.isArray(r.requiredVisualActionChecks)
    ? r.requiredVisualActionChecks.map(object) : []
  const byId = new Map(checks.map(check => [String(check.beatId ?? ''), check]))
  const feetInspectionRequired = feetInspectionOverride ?? sceneCutFeetInspectionRequired(shot)
  for (const beat of beats.filter(item => sceneCutMovementStartRequired(item)
    || contractVersion === 3 && sceneCutApproachStartRequired(item))) {
    const id = String(beat.id ?? ''), check = byId.get(id)
    if (!check) return reject(`位移动作 ${id} 缺少首帧审核`)
    if (check.approvedResetBeatId) {
      const reset = beats.find(item => item.id === check.approvedResetBeatId)
      const resetAt = Number(schedule.find(item => item.beatId === check.approvedResetBeatId)?.startSecond)
      const beatAt = Number(schedule.find(item => item.beatId === id)?.startSecond)
      if (!reset || !Array.isArray(object(reset.completion).resetsBeatIds)
        || !(object(reset.completion).resetsBeatIds as unknown[]).includes(id)
        || !Number.isFinite(resetAt) || !Number.isFinite(beatAt) || resetAt >= beatAt)
        reject(`位移动作 ${id} 的零秒复位依据无效`)
      continue
    }
    const start = object(check.travelStartCheck)
    if (start.applicable !== true || start.atApprovedOrigin !== true
      || start.feetInspectionRequired !== feetInspectionRequired
      || feetInspectionRequired && start.allParticipantsFeetGrounded !== true
      || start.noStrideInProgress !== true
      || start.destinationNotReached !== true || start.routeStillPossible !== true
      || typeof start.pixelEvidence !== 'string' || !start.pixelEvidence.trim())
      reject(`位移动作 ${id} 在零秒已起步、离开原位或缺少可见后续路径`)
  }
  return true
}

type Node = { id: string; prompt?: string }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: unknown[] }

/** Prompt-only schema169 migration. Preserves the approved shot and graph topology. */
export function upgradeSceneCutTravelStartWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![168, 169].includes(workflow.schemaVersion ?? 0)) return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  const plan = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-opening-plan')
  if (!image || !review || !plan
    || !workflow.edges.some(edge => object(edge).from === 'sanguo-scene-cut-source-archive'
      && object(edge).to === plan.id)
    || !workflow.edges.some(edge => object(edge).from === plan.id
      && object(edge).to === image.id)
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V168, SCENE_CUT_FIRST_FRAME_PROMPT_V169].includes(image.prompt ?? '')
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V168, SCENE_CUT_FRAME_REVIEW_PROMPT_V169].includes(review.prompt ?? '')) return workflow
  if (workflow.schemaVersion === 169 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V169
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V169) return workflow
  return { ...workflow, schemaVersion: 169, nodes: workflow.nodes.map(node => node.id === image.id
    ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V169 } as N
    : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V169 } as N : node) } as W
}
