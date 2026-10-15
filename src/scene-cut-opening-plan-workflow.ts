import { SCENE_CUT_FIRST_FRAME_PROMPT_V167,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V167, sceneCutActionAnchor,
  sceneCutStanceStartRequired } from './scene-cut-t0-image-contract.ts'

export const SCENE_CUT_FIRST_FRAME_PROMPT_V168 = SCENE_CUT_FIRST_FRAME_PROMPT_V167 + `
【正向可见零秒起点计划·v4】这是由已批准 requiredThisClip 动作自动派生的逐节拍起点计划：\${scene_cut_opening_state}。把每条 visibleT0 具体画在同一张零秒首帧中，不凭文字说明代替像素。若收紧绳结，画出束缚处本身的明显松圈或空隙、未闭合的活结和下垂自由端；仅左侧牵引绳弯曲而腕圈贴紧不合格。若要踏稳或挺直，画出弯膝、偏移重心与上身明显前倾，给后续直膝、踏实、挺背留出可辨幅度；双腿伸直且背脊垂直不合格。若要押送到目的地，人物留在起点，前方地面路径清楚可见。所有姿态必须和已批准分镜及冻结人设同时相容。`

export const SCENE_CUT_FRAME_REVIEW_PROMPT_V168 = SCENE_CUT_FRAME_REVIEW_PROMPT_V167 + `
【站姿起点实图硬检·v4】由已批准分镜派生的起点计划：\${scene_cut_opening_state}。对每个 requiredThisClip 的踏稳、站直、挺直或起身动作，requiredVisualActionChecks 增加 stanceStartCheck：{"applicable":true,"bentKneeOrUnsettledWeightVisible":false,"torsoNotFullyStraight":false,"pixelEvidence":"逐项指明膝足受力与背脊角度的实际像素"}。分镜只要求足部调整时，仅足/重心项必须 true；只要求背脊挺直时，仅躯干项必须 true；两者都要求则两项都须 true。双腿伸直且双足站定，或躯干已竖直，相关项必须 false，不得仅写“仍可继续”。没有这种动作的项填 {"applicable":false}。如有排程在前且明确批准的复位，按原复位规则记录。首帧不能提前呈现后续动作终态；一项缺实见证据就 passed=false。`

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const reject = (reason: string): never => { throw Error(`SCENE_CUT_FRAME_REJECTED: ${reason}`) }

/** Extra schema-168 visual gate, applied after the v167 frame checks. */
export function validateSceneCutStanceStartReview(review: unknown, shot: unknown) {
  const r = object(review), pacing = object(object(shot).pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  const schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(object) : []
  const checks = Array.isArray(r.requiredVisualActionChecks)
    ? r.requiredVisualActionChecks.map(object) : []
  const byId = new Map(checks.map(check => [String(check.beatId ?? ''), check]))
  for (const beat of beats.filter(sceneCutStanceStartRequired)) {
    const id = String(beat.id ?? ''), check = byId.get(id)
    if (!check) return reject(`踏稳挺直动作 ${id} 缺少首帧审核`)
    if (check.approvedResetBeatId) {
      const reset = beats.find(item => item.id === check.approvedResetBeatId)
      const resetAt = Number(schedule.find(item => item.beatId === check.approvedResetBeatId)?.startSecond)
      const beatAt = Number(schedule.find(item => item.beatId === id)?.startSecond)
      if (!reset || !Array.isArray(object(reset.completion).resetsBeatIds)
        || !(object(reset.completion).resetsBeatIds as unknown[]).includes(id)
        || !Number.isFinite(resetAt) || !Number.isFinite(beatAt) || resetAt >= beatAt)
        reject(`踏稳挺直动作 ${id} 的零秒复位依据无效`)
      continue
    }
    const source = sceneCutActionAnchor(beat)
    const needsLegs = /脚|足|腿|膝|踏|站稳|站实|起身|起立/.test(source)
    const needsTorso = /背|脊|躯|身|腰|挺直|直起|起身|起立/.test(source)
    const stance = object(check.stanceStartCheck)
    if (stance.applicable !== true
      || needsLegs && stance.bentKneeOrUnsettledWeightVisible !== true
      || needsTorso && stance.torsoNotFullyStraight !== true
      || typeof stance.pixelEvidence !== 'string' || !stance.pixelEvidence.trim())
      reject(`踏稳挺直动作 ${id} 在零秒缺少可见屈膝、未稳重心或前倾背脊`)
  }
  return true
}

type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = { id: string; kind: string; prompt?: string; params?: Param[]; childIds?: string[];
  loop?: unknown; parentId?: string; uploads?: unknown[]; position?: { x: number; y: number };
  resultVar?: string; runIf?: { path: string; equals: unknown };
  request?: { url: string; method: 'POST' | 'GET' } }
type Edge = { id: string; from: string; to: string; branch?: 'true' | 'false' }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: Edge[] }
const p = (id: string, name: string, type: string, value: string): Param =>
  ({ id, name, englishName: name, type, required: false, value })
const planId = 'sanguo-scene-cut-opening-plan'

/** Schema 168 inserts a deterministic shot-bound plan before image purchase.
 * It retains the approved shot, source archive and all unrelated graph data. */
export function upgradeSceneCutOpeningPlanWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![167, 168].includes(workflow.schemaVersion ?? 0)) return workflow
  const find = (id: string) => workflow.nodes.find(node => node.id === id)
  const owner = find('sanguo-scene-loop'), archive = find('sanguo-scene-cut-source-archive')
  const image = find('sanguo-scene-cut-first-frame'), review = find('sanguo-scene-cut-review')
  const approval = find('sanguo-scene-cut-approval'), existing = find(planId)
  if (!owner?.childIds || !archive?.position || !image?.position || !image.params
    || !review?.params || !approval?.params
    || ![SCENE_CUT_FIRST_FRAME_PROMPT_V167, SCENE_CUT_FIRST_FRAME_PROMPT_V168].includes(image.prompt ?? '')
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V167, SCENE_CUT_FRAME_REVIEW_PROMPT_V168].includes(review.prompt ?? '')
    || existing && existing.request?.url !== '/api/scene-cut-opening-plan') return workflow
  if (workflow.schemaVersion === 168 && existing
    && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT_V168
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT_V168
    && workflow.edges.some(edge => edge.from === archive.id && edge.to === planId)
    && workflow.edges.some(edge => edge.from === planId && edge.to === image.id)
    && !workflow.edges.some(edge => edge.from === archive.id && edge.to === image.id)) return workflow
  const plan = existing ?? { id: planId, title: '换场零秒正向动作计划', kind: 'http',
    resultVar: 'scene_cut_opening_state', uploads: [], loop: archive.loop,
    parentId: 'sanguo-scene-loop', runIf: { path: 'first_frame_branch.shouldGenerateSceneFrame', equals: true },
    prompt: '从已批准逐节拍动作生成首帧可见起点，不改写分镜。',
    request: { url: '/api/scene-cut-opening-plan', method: 'POST' },
    params: [p('sc-plan-shot', 'shot', 'json', '${shot_script}')],
    position: { x: Math.round((archive.position.x + image.position.x) / 2),
      y: image.position.y - 120 } } as unknown as N
  const addParam = (params: Param[], id: string, name: string) => params.some(item => item.englishName === name)
    ? params : [...params, p(id, name, 'json', '${scene_cut_opening_state}')]
  const nodes = workflow.nodes.map(node => node.id === owner.id ? {
    ...node, childIds: node.childIds?.includes(planId) ? node.childIds
      : (() => { const at = node.childIds?.indexOf(image.id) ?? -1
        return at < 0 ? [...(node.childIds ?? []), planId]
          : [...(node.childIds ?? []).slice(0, at), planId, ...(node.childIds ?? []).slice(at)] })(),
  } as N : node.id === image.id ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V168,
    params: addParam(node.params ?? [], 'sc-image-opening-plan', 'sceneCutOpeningPlan') } as N
    : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V168,
      params: addParam(node.params ?? [], 'sc-review-opening-plan', 'openingStatePlan') } as N
      : node.id === approval.id ? { ...node,
        params: addParam(node.params ?? [], 'sc-approval-opening-plan', 'openingStatePlan') } as N : node)
  if (!existing) nodes.push(plan)
  const edges = workflow.edges.filter(edge => !(edge.from === archive.id && edge.to === image.id))
  const additions: Edge[] = []
  if (!edges.some(edge => edge.from === archive.id && edge.to === planId))
    additions.push({ id: 'sg-e-scene-opening-plan-in', from: archive.id, to: planId })
  if (!edges.some(edge => edge.from === planId && edge.to === image.id))
    additions.push({ id: 'sg-e-scene-opening-plan-out', from: planId, to: image.id })
  // The historical-map upgrader keeps its managed route edges at the tail.
  // Place these scene edges before that tail so cold-start hydration does not
  // reorder the saved graph or invalidate a frozen execution snapshot.
  const mapTail = edges.findIndex(edge => edge.id === 'sg-e-map-annotation-review')
  edges.splice(mapTail < 0 ? edges.length : mapTail, 0, ...additions)
  return { ...workflow, schemaVersion: 168, nodes, edges } as W
}
