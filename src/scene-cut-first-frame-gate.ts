import { sceneCutEstablishmentBeat } from './scene-cut-establishment.ts'
import { sceneCutVisualChangeRequired } from './scene-cut-visual-change.ts'

/** A new live-action scene needs an approved opening still, independent of
 * the previous scene's tail. The still fixes t=0, not any later beat's result. */
const SCENE_CUT_FIRST_FRAME_PROMPT_V1 = `【真人换场首帧：已批准分镜的零秒状态】
只生成一张16:9写实电影画面，是本镜 t=0 的实际第一帧，不是动作过程拼图，也不是首个动作完成后的状态。场景：\${shot_script.visualPrompt}。机位：\${shot_script.camera}。具名人物和装备：\${shot_script.characters}；\${shot_script.characterEquipment}。匿名群体演员：\${shot_script.pacing.actorGroups}。具名人物名单不包含匿名群体；若批准的零秒动作写明群体成员已经在场，按其人数和站位全部画出，不能省略，也不能添加无关人物。逐节拍与预期终态：\${shot_script.pacing.beats}；排程：\${shot_script.pacing.schedule}。
逐条阅读所有 requiredThisClip=true 的视觉动作及完成态。零秒画面须处在最早动作的可继续发生起点；对其后没有已批准显式复位节拍的动作，零秒也不能预先呈现其完成态。若随后要收紧、踏稳挺直、举物、交接、跨门或迈步，首帧不能已经绳结收紧、双脚和背脊完全站稳挺直、举完、物已易主、已跨门或已抵达。例如分镜说人物“站在院中”，但后续还要踏稳挺直，就让站姿仍可见失衡、屈膝或躯干未挺直的动作余地，不凭静图宣称后续完成。严格保留分镜指定的身体部位、道具位置、左右方位和身份；后续动作留给视频。每位具名人物只出现一次，已选人设正面参考按顺序对应 \${scene_cut_sources.referenceBindings}，只继承脸、发式、年龄、体型、衣甲，不复制三视图拼版姿势。不要文字、字幕、水印、分格或额外具名人物。`

const SCENE_CUT_OPENING_IMAGE_ADDENDUM = `
【零秒动作余地优先于静态构图·v2】上面的 visualPrompt 只提供地点、人物、光线和机位；若其中静态姿态或靠近目的地的构图会提前完成 pacing 中任何 requiredThisClip 视觉动作，以逐节拍动作起点为准。逐条对照每个 completion.finalState，把该终态留在未来视频中：绳/道具要看出仍可继续操作；站姿若后续还需站稳挺直，零秒须可见膝、足或躯干尚待调整；押送、步行、跨越、接近目标等位移动作须让起点与终点在画面空间上有可辨的距离和仍可走的路径，不能一开始就站在目标台阶、门槛或交接点。身份参考仅裁取头肩上身，不提供站姿依据。若这些未完成余地无法同时画出，本张图不合格；不要凭文字说明掩盖已完成的像素。`

export const SCENE_CUT_CROSS_THRESHOLD_IMAGE_ADDENDUM = `
【跨门首帧的门槛几何·v197】仅当当前批准的首个必需视觉动作是多人从门外跨入门内时：按批准机位呈现一条完整清晰的门槛，门槛横在镜头与全部门外行走者之间。所有参与跨门者的左右鞋都落在门槛的院外一侧，鞋尖距门槛至少一只鞋长；门槛不能从任何人的两脚之间或脚后方穿过，也不能把领头者先放到门内。众人按批准站位横向错开，每人的双腿和两只鞋之间保留可见背景缝隙，衣摆、前排人物或门框不得遮住后排行走者的内侧脚、脚掌和脚跟。镜头前方门内保留从门槛到等候者之间的空地，供后续完整跨门、收步和下一必需动作。这个几何要求只细化批准的零秒位置，不改变人数、相对方位、服饰、动作与机位。`

export const SCENE_CUT_FIRST_FRAME_PROMPT = SCENE_CUT_FIRST_FRAME_PROMPT_V1 + SCENE_CUT_OPENING_IMAGE_ADDENDUM
  + '\n【当前分镜零秒计划】${scene_cut_opening_state.positiveOpeningDescription}。静态场景、位置与机位：${scene_cut_opening_state.openingVisualContext}。上述当前分镜和计划是唯一动作依据；不得继承其他镜头的发令者、持绳者、未缚目标、合拢者或背景人数。'
  + '\n【全景动作区清晰度】只画当前分镜已批准的道具；未要求旗帜、幡或旗杆时，一律不画。批准全身或脚步可辨的位移动作时，每名实际移动者的两只鞋靴、脚跟与接地轮廓都须各自可见，人物横向错开，内侧脚也不能被主角衣摆、另一人或画边遮住；保持原批准人数、左右关系和机位。'

const SCENE_CUT_FRAME_REVIEW_PROMPT_V1 = `【真人换场首帧独立实图审核】
只能根据附件实际像素判断，不凭生成提示词推定。附件第1张是拟用首帧，后续按顺序是已选人物三视图原图。采证：\${scene_cut_evidence.evidenceUrl}；项目：\${scene_cut_evidence.items}。已批准分镜：\${shot_script}。已冻结身份资产：\${scene_cut_sources.referenceBindings}。
首帧必须与本镜 t=0 的地点、机位、具名人物、服装、道具和可见世界状态一致。逐条检查所有 requiredThisClip 视觉动作和排程，不只看最早一条：首条须处在动作起点；其后各条若没有已批准的显式复位节拍，零秒也不能已经呈现其完成态。例如随后收紧绳结，图中必须看得见正确腕位、绳端和可继续收紧的关系；随后踏稳挺直，图中不能已经完全站稳挺立。每条写出实见 t=0 状态，不确定即判未通过。只有前置已批准动作的 completion.resetsBeatIds 明确列出该后续 beatId，且排程确在后续动作之前，才可填 approvedResetBeatId；单靠解释“以后会复位”不算。身份原图只用于核对人设，不把三视图的中性站姿当作本镜表演。无需前镜尾帧相同；真换场不强行续接同一机位。不能改写分镜动作或对白。
只返回 JSON：{"version":"scene-cut-first-frame-review-v1","passed":false,"evidenceUrl":"采证地址","frame":{"sourceUrl":"首帧原图URL","evidenceReferenceImage":"首帧审核附件URL"},"assets":[{"characterName":"人物名","assetId":"资产ID","sourceUrl":"人设原图URL","evidenceReferenceImage":"审核附件URL"}],"firstRequiredVisualBeatId":"节拍ID或空字符串","requiredVisualActionChecks":[{"beatId":"必需视觉动作ID","observedT0":"零秒画面实际所见","terminalStateAlreadyPresent":false,"approvedResetBeatId":"若确有已批准显式复位则填前置节拍ID，否则空字符串"}],"observedOpening":{"setting":"实际所见","characters":"实际所见","bodyAndProps":"实际所见","actionStart":"实际所见"},"hardChecks":{"setting":false,"castAndIdentity":false,"wardrobeAndEquipment":false,"bodyAndProps":false,"actionStartNotCompleted":false,"allRequiredVisualActionsOpen":false,"singleFullFrame":false},"issues":[]}。passed 仅在七项均有像素证据、所有必需视觉动作状态逐条合格且 issues 为空时为 true；不确定为 false。`

const SCENE_CUT_OPENING_REVIEW_ADDENDUM = `
【逐节拍剩余动作与空间·v2】requiredVisualActionChecks 的每条还必须给 actionStillPossible 布尔值与 remainingActionEvidence 字符串。只看首帧像素：指出可见的绳端松量、可继续改变的足/膝/背脊姿态、或从现站位到目标地点尚可行走的空间和路径；不能只写“后续可以发生”。若画面已将人物放到目标台阶/门槛附近、绳圈已收紧、身体已站稳挺直，相关节拍 actionStillPossible=false，hardChecks.allRequiredVisualActionsOpen=false，passed=false。visualPrompt 中的静态站姿不能覆盖逐节拍的未完成要求；无法从像素确认余地则 false。`

export const SCENE_CUT_POST_TRAVEL_SETTLE_REVIEW_ADDENDUM = `
【跨门后收步的零秒判定·v196】按完整节拍终态比较画面，地点、动作顺序与状态不可拆开单判。若必需“停在两侧／收步站稳”节拍明确依赖前一条“从门外跨入厅内”等位移动作，零秒人物仍在门外批准起点且留有可走的门洞路径时，零秒双脚落地静止是前一条位移动作的正确起点，不能因此要求人物预先屈膝、抬脚、失衡或尚未落稳；跨门后的“厅内两侧停稳”终态此时尚未出现，actionStillPossible=true、terminalStateAlreadyPresent=false。该条不是虚构复位，approvedResetBeatId 必须仍为空。若人物已在厅内终点并已停稳、路径被遮断，或画面脚部被衣摆或他人遮住而无法检查批准的位移动作，则继续如实记硬失败。逐条写明门槛两侧、实际脚位与可走路径的像素证据；不能用本规则放过脚部遮挡或提前完成。`

export const SCENE_CUT_FRAME_REVIEW_PROMPT = SCENE_CUT_FRAME_REVIEW_PROMPT_V1
  .replace('"terminalStateAlreadyPresent":false,"approvedResetBeatId"',
    '"terminalStateAlreadyPresent":false,"actionStillPossible":false,"remainingActionEvidence":"实见的继续动作余地或空间路径","approvedResetBeatId"')
  + SCENE_CUT_OPENING_REVIEW_ADDENDUM
  + SCENE_CUT_POST_TRAVEL_SETTLE_REVIEW_ADDENDUM

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const reject = (reason: string): never => { throw Error(`SCENE_CUT_FRAME_REJECTED: ${reason}`) }
const sourceImage = (value: unknown) => typeof value === 'string' && /^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(value)

export function validateSceneCutFrameReview(review: unknown, evidence: unknown, shot: unknown, sources: unknown,
  options: { allowReviewRisks?: boolean } = {}) {
  const r = object(review), e = object(evidence), s = object(shot), archive = object(sources)
  const reviewRisks = options.allowReviewRisks === true && r.passed === false
    && Array.isArray(r.issues) && r.issues.length > 0 && !archive.approvedEllipsis
  if (!reviewRisks && r.version === 'scene-cut-first-frame-review-v1' && r.passed === false
    && Array.isArray(r.issues) && r.issues.length) {
    const summary = r.issues.slice(0, 5).map(issue => {
      const item = object(issue)
      const code = typeof item.code === 'string' ? item.code.slice(0, 64) : typeof issue === 'string' ? 'VISUAL_REVIEW_REJECTED' : 'UNSPECIFIED'
      const detail = typeof item.problem === 'string' ? item.problem
        : typeof item.detail === 'string' ? item.detail : typeof issue === 'string' ? issue : ''
      return `${code}${detail ? `：${detail.slice(0, 180)}` : ''}`
    }).join('；')
    reject(`实图审核未通过：${summary}`)
  }
  const bindings = Array.isArray(archive.referenceBindings) ? archive.referenceBindings.map(object) : []
  const reviewedAssets = Array.isArray(r.assets) ? r.assets.map(object) : []
  const items = Array.isArray(e.items) ? e.items.map(object) : []
  const frame = object(r.frame), checks = object(r.hardChecks)
  const ellipsis = object(archive.approvedEllipsis)
  const hasEllipsis = ellipsis.version === 'scene-cut-approved-ellipsis-v1'
  const beats = Array.isArray(object(s.pacing).beats) ? object(s.pacing).beats as Value[] : []
  const schedule = Array.isArray(object(s.pacing).schedule) ? object(s.pacing).schedule as Value[] : []
  const visualActions = beats.filter(sceneCutVisualChangeRequired)
    .map(beat => ({ beat, at: Number(schedule.find(item => item.beatId === beat.id)?.startSecond ?? 0) }))
    .sort((a, b) => a.at - b.at)
  const first = visualActions[0]?.beat
  const actionChecks = Array.isArray(r.requiredVisualActionChecks) ? r.requiredVisualActionChecks.map(object) : []
  const visualActionChecks = visualActions.map(({ beat }) =>
    actionChecks.find(check => check.beatId === beat.id))
  const knownBeatIds = new Set(beats.map(beat => String(beat.id ?? '')))
  if (object(s.continuity).mode !== 'scene_cut' || s.visualTreatment !== 'live_action'
    || s.firstFrameMode !== 'reference' || archive.version !== 'scene-cut-sources-v1'
    || archive.shotId !== s.id || r.firstRequiredVisualBeatId !== (first?.id ?? '')
    || r.version !== 'scene-cut-first-frame-review-v1' || r.passed !== true && !reviewRisks
    || typeof e.evidenceUrl !== 'string' || !/^\/generated\/image-evidence-[a-f0-9]{24}\.json$/.test(e.evidenceUrl)
    || r.evidenceUrl !== e.evidenceUrl || !Array.isArray(r.issues) || r.issues.length && !reviewRisks
    || !Array.isArray(r.assets) || reviewedAssets.length !== bindings.length
    || visualActionChecks.some(check => !check)
    || actionChecks.length !== new Set(actionChecks.map(check => check.beatId)).size
    || actionChecks.some(check => !knownBeatIds.has(String(check.beatId ?? '')))
    || items.length !== bindings.length + 1 + (hasEllipsis ? 1 : 0) || !sourceImage(frame.sourceUrl)
    || Object.keys(checks).length !== 7 || !['setting', 'castAndIdentity', 'wardrobeAndEquipment',
      'bodyAndProps', 'actionStartNotCompleted', 'allRequiredVisualActionsOpen', 'singleFullFrame']
      .every(key => reviewRisks ? typeof checks[key] === 'boolean' : checks[key] === true)
    || !['setting', 'characters', 'bodyAndProps', 'actionStart'].every(key =>
      typeof object(r.observedOpening)[key] === 'string' && String(object(r.observedOpening)[key]).trim())) {
    reject('首帧、t=0 动作起点、实图结论或身份资产不完整')
  }
  for (const [index, { beat, at }] of visualActions.entries()) {
    const check = visualActionChecks[index]!
    if (reviewRisks) {
      if (check?.beatId !== beat.id || typeof check.observedT0 !== 'string'
        || !check.observedT0.trim()) reject('风险模式仍须保留逐节拍原始观察')
      continue
    }
    const resetBeatId = check.approvedResetBeatId
    const reset = visualActions.find(item => item.beat.id === resetBeatId && item.at < at)
    if (sceneCutEstablishmentBeat(beat)) {
      if (check.beatId !== beat.id || typeof check.observedT0 !== 'string' || !check.observedT0.trim()
        || check.terminalStateAlreadyPresent !== true || check.establishedStateVisible !== true
        || resetBeatId !== '') reject('静态建立节拍在零秒必须实见，且不能伪称尚未完成')
      continue
    }
    if (check.beatId !== beat.id || typeof check.observedT0 !== 'string' || !check.observedT0.trim()
      || typeof check.terminalStateAlreadyPresent !== 'boolean'
      || check.actionStillPossible !== true
      || typeof check.remainingActionEvidence !== 'string' || !check.remainingActionEvidence.trim()
      || typeof resetBeatId !== 'string'
      || (check.terminalStateAlreadyPresent && (!reset || !Array.isArray(object(reset.beat.completion).resetsBeatIds)
        || !(object(reset.beat.completion).resetsBeatIds as unknown[]).includes(beat.id)))
      || (!check.terminalStateAlreadyPresent && resetBeatId)) {
      reject('必需视觉动作在零秒已呈终态，或缺少逐节拍实图与批准复位依据')
    }
  }
  const reportFrame = items[0]
  if (frame.sourceUrl !== reportFrame.url || frame.evidenceReferenceImage !== reportFrame.referenceImage
    || reportFrame.decoded !== true || !sourceImage(reportFrame.referenceImage)) reject('首帧与实际采证不匹配')
  const assets = bindings.map((binding, index) => {
    const asset = reviewedAssets[index], item = items[index + 1]
    if (asset.characterName !== binding.characterName || asset.assetId !== binding.assetId
      || asset.sourceUrl !== binding.url || asset.sourceUrl !== item.url
      || asset.evidenceReferenceImage !== item.referenceImage || item.decoded !== true
      || !sourceImage(asset.sourceUrl) || !sourceImage(asset.evidenceReferenceImage)
      || !/^\/generated\/image-evidence-[a-f0-9]{24}\.jpg$/.test(String(item.referenceImage))) {
      reject('人设资产或模型审核附件与冻结来源不符')
    }
    return asset
  })
  let priorTail: Value | undefined
  if (hasEllipsis) {
    const item = items.at(-1) ?? {}, reviewed = object(r.priorTail)
    const continuity = object(r.transitionContinuityCheck), pixels = object(continuity.pixelEvidence)
    if (item.role !== 'prior_actual_tail' || item.url !== ellipsis.priorTailUrl
      || reviewed.sourceUrl !== item.url || reviewed.evidenceReferenceImage !== item.referenceImage
      || item.decoded !== true || !sourceImage(item.url) || !sourceImage(item.referenceImage)
      || continuity.applicable !== true
      || !['sameCharacters', 'sameWardrobeAndEquipment', 'sameRestraintState',
        'priorTailShowsCompletedState', 'newSettingLegible', 'relativeBlockingPlausible']
        .every(key => continuity[key] === true)
      || !['characters', 'wardrobeAndEquipment', 'restraint', 'completedState',
        'newSetting', 'blocking'].every(key => typeof pixels[key] === 'string' && String(pixels[key]).trim()))
      reject('批准省略切场缺少真实前镜尾帧和逐项跨帧像素对照')
    priorTail = reviewed
  } else if (object(r.transitionContinuityCheck).applicable === true
    || r.priorTail !== undefined && (Object.keys(object(r.priorTail)).some(key =>
      !['sourceUrl', 'evidenceReferenceImage'].includes(key))
      || Object.values(object(r.priorTail)).some(value => value !== ''))) {
    reject('非批准省略切场不得伪造前镜尾帧对照')
  }
  return { version: 'scene-cut-frame-gate-v1', passed: true, evidenceUrl: e.evidenceUrl,
    frame, assets, firstRequiredVisualBeatId: first?.id ?? '', requiredVisualActionChecks: actionChecks,
    ...(reviewRisks ? { deferredToUser: true,
      qualityRisks: (r.issues as unknown[]).map((issue, index) => ({
        code: 'scene_cut_first_frame_review_failed', issueIndex: index,
        issue, reviewEvidenceUrl: e.evidenceUrl })) } : {}),
    ...(Array.isArray(r.advisoryIssues) ? { advisoryIssues: r.advisoryIssues } : {}),
    ...(actionChecks.some(check => object(check.manipulationStartCheck).uncertainStartAdvisory === true)
      ? { deferredToUser: true } : {}),
    ...(archive.outlineBinding ? { outlineBinding: archive.outlineBinding } : {}),
    ...(object(archive.sourceContext).acceptedRecordBinding
      ? { acceptedRecordBinding: object(archive.sourceContext).acceptedRecordBinding } : {}),
    ...(priorTail ? { priorTail, approvedEllipsis: archive.approvedEllipsis } : {}) }
}

export const SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE = `const frame = params.frame
const sources = params.sources
const url = String(frame && frame.url || '').trim()
if (!/^\\/generated\\/[\\w.-]+\\.(?:png|jpe?g|webp)$/i.test(url)
  || !sources || sources.version !== 'scene-cut-sources-v1'
  || !Array.isArray(sources.referenceBindings)) throw Error('SCENE_CUT_FRAME_INVALID: 首帧或身份资产未归档')
return { items: [{ role: 'candidate_first', url }, ...sources.referenceBindings.map(item => ({
  role: 'identity', characterName: item.characterName, assetId: item.assetId, url: item.url }))] }`

type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = { id: string; kind: string; title?: string; resultVar?: string; modelId?: string; outputMode?: string;
  prompt?: string; code?: string; operation?: string; params?: Param[]; uploads?: unknown[]; loop?: unknown;
  parentId?: string; childIds?: string[]; position?: { x: number; y: number }; runIf?: { path: string; equals: unknown };
  request?: { url: string; method: 'POST' | 'GET' } }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[];
  edges: Array<{ id: string; from: string; to: string; branch?: 'true' | 'false' }> }
const p = (id: string, name: string, type: string, value: string): Param =>
  ({ id, name, englishName: name, type, required: false, value })
const sceneIf = { path: 'first_frame_branch.shouldGenerateSceneFrame', equals: true }

/** Pure schema 165 migration. It adds the gate in series with existing
 * coverage-cut nodes and preserves every unrelated node/prompt/code byte. */
export function upgradeSceneCutFirstFrameWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 164) return workflow
  const find = (id: string) => workflow.nodes.find(node => node.id === id)
  const owner = find('sanguo-scene-loop'), branch = find('sanguo-first-frame-branch')
  const router = find('sanguo-video-reference-router'), video = find('sanguo-video')
  const coverage = find('sanguo-coverage-approval')
  if (!owner?.childIds || !branch?.code || !branch.position || !router?.code || !router.params
    || !router.position || !video?.params || !coverage) return workflow
  const ids = ['sanguo-scene-cut-source-archive', 'sanguo-scene-cut-first-frame',
    'sanguo-scene-cut-evidence-plan', 'sanguo-scene-cut-evidence',
    'sanguo-scene-cut-review', 'sanguo-scene-cut-approval']
  if ((workflow.schemaVersion ?? 0) >= 165 && ids.every(id => find(id))
    && !workflow.edges.some(edge => edge.from === coverage.id && edge.to === router.id)
    && workflow.edges.some(edge => edge.from === coverage.id && edge.to === ids[0])
    && workflow.edges.some(edge => edge.from === ids.at(-1) && edge.to === router.id)) return workflow
  if (ids.some(id => find(id)) && !ids.every(id => find(id))) return workflow
  const marker = "const shouldGenerateAnimatedEndFrame ="
  const branchCode = branch.code.includes('const shouldGenerateSceneFrame =') ? branch.code
    : branch.code.includes(marker) ? branch.code
      .replace(marker, "const shouldGenerateSceneFrame = requestedMode === 'reference' && visualTreatment === 'live_action' && String(${shot_script.continuity.mode} || '') === 'scene_cut'\n" + marker)
      .replace('  shouldReusePreviousTail,\n  shouldGenerateCoverageFrame,',
        '  shouldReusePreviousTail,\n  shouldGenerateSceneFrame,\n  shouldGenerateCoverageFrame,') : ''
  if (!branchCode.includes('  shouldGenerateSceneFrame,\n  shouldGenerateCoverageFrame,')) return workflow
  const routerCode = router.code.includes('branch.shouldGenerateSceneFrame') ? router.code
    : router.code.replace('return branch && branch.referenceRequest ?',
      `if (branch && branch.shouldGenerateSceneFrame) {
  if (!params.sceneSources || params.sceneSources.version !== 'scene-cut-sources-v1'
    || !Array.isArray(params.sceneSources.referenceImages)
    || !Array.isArray(params.sceneSources.referenceBindings)
    || params.sceneSources.referenceImages.length !== params.sceneSources.referenceBindings.length)
    throw Error('SCENE_CUT_SOURCE_INVALID: 视频身份资产未归档')
  return { referenceImages: params.sceneSources.referenceImages,
    referenceBindings: params.sceneSources.referenceBindings,
    referenceMode: params.sceneSources.referenceImages.length <= 2 ? 'three-view-all' : 'three-view-front' }
}
return branch && branch.referenceRequest ?`)
  if (!routerCode.includes('branch.shouldGenerateSceneFrame')) return workflow
  const common = { uploads: [], loop: branch.loop, parentId: 'sanguo-scene-loop', runIf: sceneIf }
  const nodes: N[] = [
    { ...common, id: ids[0], title: '换场人物资产冻结', kind: 'http', resultVar: 'scene_cut_sources',
      prompt: '按已批准分镜保存所选三视图，生成小尺寸正面生图参考。',
      request: { url: '/api/scene-cut-source-archive', method: 'POST' },
      params: [p('sc-source-shot', 'shot', 'json', '${shot_script}'),
        p('sc-source-bindings', 'referenceBindings', 'json', '${first_frame_branch.referenceRequest.referenceBindings}'),
        p('sc-source-images', 'referenceImages', 'images', '${first_frame_branch.referenceRequest.referenceImages}')],
      position: { x: branch.position.x + 240, y: branch.position.y + 600 } },
    { ...common, id: ids[1], title: '换场准确首帧', kind: 'image', modelId: 'codex-gpt-image-2',
      operation: 'history.scene-cut-first-frame', resultVar: 'first_frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT,
      params: [p('sc-image-refs', 'referenceImages', 'images', '${scene_cut_sources.imageReferenceImages}'),
        p('sc-image-sources', 'sceneCutSources', 'json', '${scene_cut_sources}'),
        p('sc-image-shot', 'sceneCutShot', 'json', '${shot_script}'),
        p('sc-image-size', 'size', 'text', '1536x864'),
        p('sc-image-single', 'singleFrame', 'boolean', 'true')],
      position: { x: branch.position.x + 480, y: branch.position.y + 600 } },
    { ...common, id: ids[2], title: '换场首帧采证清单', kind: 'code', resultVar: 'scene_cut_evidence_plan',
      prompt: '固定新首帧与人设原图的采证顺序。', code: SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE,
      params: [p('sc-plan-frame', 'frame', 'json', '${first_frame}'),
        p('sc-plan-sources', 'sources', 'json', '${scene_cut_sources}')],
      position: { x: branch.position.x + 720, y: branch.position.y + 600 } },
    { ...common, id: ids[3], title: '换场首帧实图采证', kind: 'http', resultVar: 'scene_cut_evidence',
      prompt: '解码首帧与身份原图，供独立视觉模型审核。',
      request: { url: '/api/image-evidence', method: 'POST' },
      params: [p('sc-evidence-items', 'items', 'json', '${scene_cut_evidence_plan.items}')],
      position: { x: branch.position.x + 960, y: branch.position.y + 600 } },
    { ...common, id: ids[4], title: '换场零秒实图审核', kind: 'text', resultVar: 'scene_cut_review',
      modelId: find('sanguo-media-review')?.modelId || 'codex-local-vision', outputMode: 'json',
      prompt: SCENE_CUT_FRAME_REVIEW_PROMPT,
      params: [p('sc-review-images', 'reviewImages', 'json', '${scene_cut_evidence.reviewImages}'),
        p('sc-review-evidence', 'evidence', 'json', '${scene_cut_evidence}'),
        p('sc-review-shot', 'shot', 'json', '${shot_script}'),
        p('sc-review-sources', 'sources', 'json', '${scene_cut_sources}'),
        p('sc-review-temp', 'temperature', 'number', '0')],
      position: { x: branch.position.x + 1200, y: branch.position.y + 600 } },
    { ...common, id: ids[5], title: '换场视频付款前首帧验收', kind: 'http', resultVar: 'scene_cut_frame_gate',
      prompt: '仅对已采证且审核通过的零秒首帧签发视频凭证。',
      request: { url: '/api/scene-cut-frame-approval', method: 'POST' },
      params: [p('sc-approval-review', 'review', 'json', '${scene_cut_review}'),
        p('sc-approval-evidence', 'evidence', 'json', '${scene_cut_evidence}'),
        p('sc-approval-shot', 'shot', 'json', '${shot_script}'),
        p('sc-approval-sources', 'sources', 'json', '${scene_cut_sources}')],
      position: { x: branch.position.x + 1440, y: branch.position.y + 600 } },
  ] as unknown as N[]
  const routerParams = router.params.some(param => param.englishName === 'sceneSources') ? router.params
    : [...router.params, p('sc-router-sources', 'sceneSources', 'json', '${scene_cut_sources}')]
  const videoParams = video.params.filter(param => !['sceneCutFrameGate', 'sceneCutShot'].includes(String(param.englishName)))
  videoParams.push(p('sc-video-gate', 'sceneCutFrameGate', 'json', '${scene_cut_frame_gate}'),
    p('sc-video-shot', 'sceneCutShot', 'json', '${shot_script}'))
  const nextNodes = workflow.nodes.map(node => node.id === branch.id ? { ...node, code: branchCode } as N
    : node.id === router.id ? { ...node, code: routerCode, params: routerParams } as N
      : node.id === video.id ? { ...node, params: videoParams } as N
        : node.id === owner.id ? (() => {
          const without = node.childIds!.filter(id => !ids.includes(id))
          const before = without.indexOf(router.id)
          const childIds = before < 0 ? [...without, ...ids]
            : [...without.slice(0, before), ...ids, ...without.slice(before)]
          return { ...node, childIds } as N
        })() : node)
  const nextEdges = workflow.edges.filter(edge => !(edge.from === coverage.id && edge.to === router.id))
  const sequence = [coverage.id, ...ids, router.id]
  for (let index = 0; index < sequence.length - 1; index++) {
    const from = sequence[index], to = sequence[index + 1]
    if (!nextEdges.some(edge => edge.from === from && edge.to === to))
      nextEdges.push({ id: `sg-e-scene-frame-${index}`, from, to })
  }
  const next = { ...workflow, schemaVersion: Math.max(165, workflow.schemaVersion ?? 0),
    nodes: [...nextNodes, ...nodes.filter(node => !find(node.id))], edges: nextEdges } as W
  return JSON.stringify(next) === JSON.stringify(workflow) ? workflow : next
}

/** Tightens only the two managed schema-165 prompts. Unknown/manual prompt
 * edits are left intact, rather than silently replacing their content. */
export function upgradeSceneCutOpeningStateWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || ![165, 166].includes(workflow.schemaVersion ?? 0)) return workflow
  const image = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  if (!image || !review || ![SCENE_CUT_FIRST_FRAME_PROMPT_V1, SCENE_CUT_FIRST_FRAME_PROMPT].includes(image.prompt ?? '')
    || ![SCENE_CUT_FRAME_REVIEW_PROMPT_V1, SCENE_CUT_FRAME_REVIEW_PROMPT].includes(review.prompt ?? '')) return workflow
  if (workflow.schemaVersion === 166 && image.prompt === SCENE_CUT_FIRST_FRAME_PROMPT
    && review.prompt === SCENE_CUT_FRAME_REVIEW_PROMPT) return workflow
  return { ...workflow, schemaVersion: 166, nodes: workflow.nodes.map(node => node.id === image.id
    ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT } as N
    : node.id === review.id ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT } as N : node) } as W
}
