import { MAX_NODE_ATTEMPTS } from './retry-budget.ts'

type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = {
  id: string; title: string; kind: string; resultVar: string; prompt: string; params: Param[]; uploads: unknown[]
  loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string }
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; operation?: string
  modelId?: string; code?: string
}
type Edge = { id: string; from: string; to: string; branch?: string }
type Workflow<N extends Node = Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: Edge[] }

export const STORY_SCRIPT_REVIEW_NODE_ID = 'node-script-review'
export const STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID = 'node-script-review-result-branch'
export const STORY_VIDEO_REVIEW_NODE_ID = 'node-video-review'
export const STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID = 'node-video-review-result-branch'
const STORY_SHOT_BINDING: Param = { id: 'story-reviewed-shot-binding', name: '已审分镜绑定',
  englishName: 'storyShot', type: 'json', required: true, value: '${shot}' }
const STORY_LAYOUT_ORDER = [
  'node-input', 'node-model-images', 'node-script', STORY_SCRIPT_REVIEW_NODE_ID,
  STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID,
  'node-loop', 'node-image', 'node-video', STORY_VIDEO_REVIEW_NODE_ID,
  STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, 'node-video-concat',
] as const
const STORY_NODE_X_SPACING = 300

/** Only a completed, source-bound review can send a draft forward. A rejected
 * draft returns to its writer with the review issues and a bounded budget. */
export const STORY_SCRIPT_REVIEW_RESULT_BRANCH_CODE = `const report = params.report;
if (!report || report.version !== 'story-script-review-v1' || typeof report.passed !== 'boolean')
  throw Error('STORY_SCRIPT_REVIEW_INVALID: 缺少完整剧本质检结论');
if (report.passed) {
  if (!Array.isArray(report.shots) || !report.shots.length || !Array.isArray(report.issues) || report.issues.length)
    throw Error('STORY_SCRIPT_REVIEW_INVALID: 通过结论缺少已审分镜');
  return true;
}
if (!Array.isArray(report.issues) || !report.issues.length || report.issues.some(issue => typeof issue !== 'string' || !issue.trim()))
  throw Error('STORY_SCRIPT_REVIEW_INVALID: 未通过结论缺少可用问题清单');
const limit = Number(params.maxAttempts);
if (!Number.isInteger(limit) || limit < 1 || limit > ${MAX_NODE_ATTEMPTS})
  throw Error('maxAttempts 必须在 1 至 ${MAX_NODE_ATTEMPTS} 之间');
if (branch.counts.false + 1 >= limit)
  throw Error('STORY_SCRIPT_RETRY_BUDGET_EXHAUSTED: 剧本生成已达 ' + limit + ' 次；保留初稿与质检报告供人工处理');
return { value: false, feedback: { code: report.code || 'STORY_SCRIPT_REVIEW_REJECTED',
  issues: report.issues, repairAttempt: report.repairAttempt } };`

export const STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT = '明确完成或证据不足时进入拼接，疑点保留在质检报告；有同镜实测未完成证据且未达上限，沿 false 回线重拍。执行异常暂停，用户不满意时可设置断点后回退重做。'
export const STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT = '确证同镜未完成且未达上限时沿 false 连线回跳重拍；缺陷不明确、影响较小或质检服务中断时沿 true 连线继续，并用 riskReminder 记录风险。保留原片和原质检报告。'

/** A rejected take may buy one more take only when the saved, decoded report
 * cites the same missing state at its planned end and actual final frame.
 * The runner also checks the complete run instance before following false. */
export const STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE = `const report = params.report;
const review = report?.storyMediaReview;
const shot = params.shot;
const video = params.video;
const evidence = review?.videoEvidence;
const assessment = review?.assessment;
const observations = review?.observations;
const fail = reason => { throw Error('STORY_MEDIA_RETAKE_EVIDENCE_INVALID: ' + reason); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const safe = value => String(value).replace(/https?:\\/\\/[^\\s"'<>]+|\\/generated\\/[\\w.\\-/?=&%]+/gi, '[素材地址已省略]').replace(/\\s+/g, ' ').trim().slice(0, 70);
if (typeof report?.passed !== 'boolean' || !review || review.version !== 'story-shot-media-review-v1'
  || review.passed !== report.passed || !shot || !video || !nonempty(video.url)
  || review.videoUrl !== video.url || report.originalUrl !== video.url) fail('质检结果与当前分镜视频未绑定');
// Uncertain observations are advisory: keep the original report and let the
// user decide whether to retake via an explicit breakpoint rollback.
if (review.reviewStatus === 'uncertain' && review.retryable === false) {
  if (!evidence?.decoded || !/^\\/generated\\/[\\w.-]+\\.mp4$/.test(evidence.url)
    || !/^[a-f0-9]{64}$/.test(evidence.sha256)
    || !/^\\/generated\\/[\\w.-]+\\.json$/.test(evidence.evidenceUrl)
    || evidence.originalUrl !== video.url || report.url !== evidence.url
    || report.videoEvidence?.sha256 !== evidence.sha256
    || report.videoEvidence?.evidenceUrl !== evidence.evidenceUrl
    || review.assessment?.sourceVideoSha256 !== evidence.sha256
    || review.assessment?.evidenceUrl !== evidence.evidenceUrl
    || review.observations?.sourceVideoSha256 !== evidence.sha256
    || review.observations?.evidenceUrl !== evidence.evidenceUrl
    || !Array.isArray(shot.visualBeats) || !shot.visualBeats.length
    || !Array.isArray(review.assessment?.beatChecks)
    || review.assessment.beatChecks.length !== shot.visualBeats.length
    || review.assessment.beatChecks.some((check, index) => check.id !== shot.visualBeats[index].id
      || !['complete', 'uncertain'].includes(check.status))
    || !['complete', 'uncertain'].includes(review.assessment?.endingHold?.status)) fail('待复核报告缺少同源采证或包含明确未完成项');
  return true;
}
if (report.passed) {
  if (review.reviewStatus !== 'passed' || !evidence?.sha256 || report.videoEvidence?.sha256 !== evidence.sha256
    || !/^\\/generated\\/[\\w.-]+\\.mp4$/.test(evidence.url) || report.url !== evidence.url) fail('通过结论缺少审定本地视频');
  return true;
}
if (review.reviewStatus !== 'incomplete' || review.retryable !== true
  || !Array.isArray(review.issues) || !review.issues.length) {
  const status = safe(review.reviewStatus || 'unknown');
  const issues = Array.isArray(review.issues) ? review.issues.filter(nonempty).slice(0, 2).map(safe).join('；') : '';
  throw Error('STORY_MEDIA_REVIEW_REQUIRED: ' + status + '；' + (issues || '缺少可核验的通过或重拍证据')
    + '；请复核同一素材，不能自动付费重拍或拼接');
}
if (!evidence?.decoded || !/^\\/generated\\/[\\w.-]+\\.mp4$/.test(evidence.url)
  || !/^[a-f0-9]{64}$/.test(evidence.sha256) || !/^\\/generated\\/[\\w.-]+\\.json$/.test(evidence.evidenceUrl)
  || evidence.originalUrl !== video.url || report.url !== evidence.url
  || report.videoEvidence?.sha256 !== evidence.sha256 || report.videoEvidence?.evidenceUrl !== evidence.evidenceUrl
  || assessment?.version !== 'story-shot-media-review-v1' || assessment.passed !== false
  || assessment.sourceVideoSha256 !== evidence.sha256 || assessment.evidenceUrl !== evidence.evidenceUrl
  || observations?.version !== 'story-shot-observations-v1'
  || observations.sourceVideoSha256 !== evidence.sha256 || observations.evidenceUrl !== evidence.evidenceUrl) fail('原片、散列或复核来源不一致');
const beats = shot.visualBeats, checks = assessment.beatChecks, frames = evidence.frames;
const times = evidence.frameTimes, observed = observations.frames;
if (!Array.isArray(beats) || !beats.length || !Array.isArray(checks) || checks.length !== beats.length
  || !Array.isArray(frames) || frames.length < 4 || !Array.isArray(times) || times.length !== frames.length
  || !Array.isArray(observed) || observed.length !== frames.length
  || !frames.every((frame, i) => /^\\/generated\\/[\\w.-]+\\.jpg$/.test(frame)
    && Number.isFinite(times[i]) && (i === 0 || times[i] > times[i - 1])
    && observed[i]?.frameIndex === i && observed[i]?.second === times[i]
    && observed[i]?.frameUrl === frame && nonempty(observed[i]?.description))) fail('逐帧证据或动作覆盖不完整');
const missing = [];
for (let i = 0; i < beats.length; i++) {
  const beat = beats[i], check = checks[i];
  if (!nonempty(beat?.id) || check?.id !== beat.id || !['complete', 'incomplete', 'uncertain'].includes(check.status)) fail('动作结果与原分镜不一致');
  if (check.status !== 'incomplete') continue;
  const pair = check.evidenceFrameIndices, quotes = check.evidenceObservations;
  if (!Array.isArray(pair) || pair.length !== 2 || !Array.isArray(quotes) || quotes.length !== 2
    || !Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1]) || pair[0] < 0
    || pair[0] >= pair[1] || pair[1] !== frames.length - 1 || !Number.isFinite(beat.endSecond)
    || Math.abs(times[pair[0]] - beat.endSecond) > .35 || !nonempty(quotes[0]) || quotes[0] !== quotes[1]
    || !observed[pair[0]].description.includes(quotes[0]) || !observed[pair[1]].description.includes(quotes[1])
    || !nonempty(beat.completion)) fail('未完成动作缺少结束帧和末帧的同一实测状态');
  missing.push('动作 ' + safe(beat.id) + '：结束帧及片尾均见“' + safe(quotes[0]) + '”；原目标“' + safe(beat.completion) + '”未完成');
}
const hold = assessment.endingHold;
if (!hold || !['complete', 'incomplete', 'uncertain'].includes(hold.status)) fail('片尾结果无效');
if (hold.status === 'incomplete' && missing.length === 0) {
  const first = hold.firstFrameIndex, last = hold.lastFrameIndex;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || first >= last
    || last !== frames.length - 1 || Math.abs(times[first] - beats[beats.length - 1].endSecond) > .15
    || !nonempty(hold.firstObservation) || !nonempty(hold.lastObservation)
    || !observed[first].description.includes(hold.firstObservation)
    || !observed[last].description.includes(hold.lastObservation)
    || hold.firstObservation === hold.lastObservation) fail('片尾未完成结论缺少两帧实测状态');
  missing.push('片尾终态：结束帧“' + safe(hold.firstObservation) + '”，片尾“' + safe(hold.lastObservation) + '”，未保持已完成状态');
}
if (!missing.length) fail('没有足以触发重拍的确证缺口');
const limit = Number(params.maxAttempts);
if (!Number.isInteger(limit) || limit < 1 || limit > ${MAX_NODE_ATTEMPTS}) throw Error('maxAttempts 必须在 1 至 ${MAX_NODE_ATTEMPTS} 之间');
if (branch.counts.false + 1 >= limit) throw Error('成片重拍达到上限 ' + limit + '；保留原片及质检证据供人工处理');
return { value: false, feedback: ('同镜重拍确证缺口：' + missing.slice(0, 2).join('；')
  + '；保留原分镜全部动作和道具归属，按实际画面完成后再留可读终态').slice(0, 550) };`

/** A visual-only workflow routes source-bound review uncertainty forward with
 * an explicit risk variable. Only demonstrated missing action takes the false
 * edge back to paid video generation. */
export const STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE = STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE.replace(
  '// Uncertain observations are advisory:',
  `if (['invalid', 'unavailable'].includes(review.reviewStatus) && review.retryable === false && report.passed === false) {
  if (!evidence?.decoded || !/^\\/generated\\/[\\w.-]+\\.mp4$/.test(evidence.url)
    || !/^[a-f0-9]{64}$/.test(evidence.sha256)
    || !/^\\/generated\\/[\\w.-]+\\.json$/.test(evidence.evidenceUrl)
    || evidence.originalUrl !== video.url || report.url !== evidence.url
    || report.videoEvidence?.sha256 !== evidence.sha256
    || report.videoEvidence?.evidenceUrl !== evidence.evidenceUrl
    || evidence.technicalValidation?.passed !== true
    || (assessment && (assessment.sourceVideoSha256 !== evidence.sha256
      || assessment.evidenceUrl !== evidence.evidenceUrl))
    || (observations && (observations.sourceVideoSha256 !== evidence.sha256
      || observations.evidenceUrl !== evidence.evidenceUrl))
    || !Array.isArray(review.issues) || !review.issues.length)
    fail('风险放行缺少同源视频、技术校验或问题记录');
  return { value: true, passed: true, riskReminder: {
    sourceVideoSha256: evidence.sha256, reviewStatus: review.reviewStatus,
    issues: review.issues.map(safe).slice(0, 3),
    message: '逐帧质检未能确证缺陷；本镜按通过连线继续，保留原报告风险。' } };
}
// Uncertain observations are advisory:`).replace(
  '  return true;\n}\nif (report.passed)',
  `  return { value: true, passed: true, riskReminder: {
    sourceVideoSha256: evidence.sha256, reviewStatus: 'uncertain',
    issues: review.issues.map(safe).slice(0, 3),
    message: '质检疑点未确证缺陷；本镜按通过连线继续，保留原报告风险。' } };
}
if (report.passed)`)

/** The managed review branch reads its source-bound report, shot and video from
 * params and only the retry counter from context. Keep custom code on the full
 * context path because its dependencies cannot be inferred safely. */
export function storyQualityBranchCodeContext(
  workflowId: string,
  node: { id: string; kind: string; code?: string },
  context: Record<string, unknown>,
): Record<string, unknown> {
  if (workflowId === 'wf-workplace-second-trial-v1' && node.id === 'node-video-review-accepted'
    && node.kind === 'code' && node.code === 'return { routed: true };') return {}
  if (!['wf-story', 'wf-workplace-second-trial-v1'].includes(workflowId) || node.kind !== 'branch'
    || !((node.id === STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID
      && (node.code === STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE
        || workflowId === 'wf-workplace-second-trial-v1' && node.code === STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE))
      || (node.id === STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID && node.code === STORY_SCRIPT_REVIEW_RESULT_BRANCH_CODE))) return context
  return { branch: context.branch }
}
export const storyVideoReviewBranchCodeContext = storyQualityBranchCodeContext

function midpoint(left: Node, right: Node) {
  return { x: (left.position.x + right.position.x) / 2, y: (left.position.y + right.position.y) / 2 }
}

function reviewNode<N extends Node>(node: Node): N {
  return node as N
}

/** Keep the saved topological order readable without disturbing wider custom gaps. */
function spaceStoryNodes<N extends Node, W extends Workflow<N>>(workflow: W): W {
  const nodesById = new Map(workflow.nodes.map(node => [node.id, node]))
  const movedX = new Map<string, number>()
  let previousX: number | undefined
  for (const id of STORY_LAYOUT_ORDER) {
    const node = nodesById.get(id)
    if (!node) continue
    const x = previousX === undefined ? node.position.x
      : Math.max(node.position.x, previousX + STORY_NODE_X_SPACING)
    if (x !== node.position.x) movedX.set(id, x)
    previousX = x
  }
  if (!movedX.size) return workflow
  return { ...workflow, nodes: workflow.nodes.map(node => {
    const x = movedX.get(node.id)
    return x === undefined ? node : { ...node, position: { ...node.position, x } } as N
  }) } as W
}

function pathAvoiding(edges: Edge[], from: string, targets: Set<string>, excluded: string): boolean {
  const pending = [from]
  const seen = new Set<string>()
  while (pending.length) {
    const current = pending.pop()!
    if (current === excluded || seen.has(current)) continue
    if (targets.has(current)) return true
    seen.add(current)
    for (const edge of edges) if (edge.from === current) pending.push(edge.to)
  }
  return false
}

/** Existing schema-5 graphs can gain the paid-media binding without changing
 * their custom prompts, node order, or reviewed results. */
function bindPaidStoryShot<N extends Node, W extends Workflow<N>>(workflow: W): W {
  let changed = false
  const nodes = workflow.nodes.map(node => {
    if (!['node-image', 'node-video'].includes(node.id)
      || node.params.some(param => (param.englishName || param.name) === 'storyShot')) return node
    changed = true
    return { ...node, params: [...node.params, { ...STORY_SHOT_BINDING }] } as N
  })
  return changed ? { ...workflow, nodes } as W : workflow
}

function assertQualityTopology(workflow: Workflow) {
  const resultBranch = (workflow.schemaVersion ?? 0) >= 6
    ? workflow.nodes.find(node => node.id === STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID) : undefined
  const scriptResultBranch = workflow.schemaVersion === 7
    ? workflow.nodes.find(node => node.id === STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID) : undefined
  const script = workflow.nodes.find(node => node.id === 'node-script')
  const scriptReview = workflow.nodes.find(node => node.id === STORY_SCRIPT_REVIEW_NODE_ID)
  const input = workflow.nodes.find(node => node.id === 'node-input')
  const loop = workflow.nodes.find(node => node.id === 'node-loop')
  const image = workflow.nodes.find(node => node.id === 'node-image')
  const video = workflow.nodes.find(node => node.id === 'node-video')
  const videoReview = workflow.nodes.find(node => node.id === STORY_VIDEO_REVIEW_NODE_ID)
  const concat = workflow.nodes.find(node => node.id === 'node-video-concat')
  const route = (from: string, to: string) => workflow.edges.filter(edge => edge.from === from && edge.to === to && !edge.branch).length === 1
  const param = (node: Node, key: string) => node.params.filter(item => (item.englishName || item.name) === key)
  if (!input || !script || !scriptReview || !loop || !image || !video || !videoReview || !concat
    || image.kind !== 'image'
    || loop.loop.itemVar !== 'shot'
    || new Set(workflow.nodes.map(node => node.id)).size !== workflow.nodes.length
    || workflow.nodes.some(node => node.resultVar === 'script_review' && node.id !== scriptReview.id
      || node.resultVar === 'video_review' && node.id !== videoReview.id)
    || workflow.nodes.some(node => node.kind === 'video' && node.id !== video.id)
    || scriptReview.kind !== 'validation' || scriptReview.operation !== 'story.script-review'
    || scriptReview.resultVar !== 'script_review' || videoReview.kind !== 'validation'
    || videoReview.operation !== 'story.media-review' || videoReview.resultVar !== 'video_review'
    || videoReview.parentId !== loop.id || loop.loop.sourcePath !== 'script_review.shots'
    || loop.loop.fallbackCount !== 0
    || !loop.childIds || ![video.id, videoReview.id, concat.id,
      ...((workflow.schemaVersion ?? 0) >= 6 ? [STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID] : [])]
      .every(id => loop.childIds!.includes(id))
    || !(loop.childIds.indexOf(video.id) < loop.childIds.indexOf(videoReview.id)
      && loop.childIds.indexOf(videoReview.id) < loop.childIds.indexOf(concat.id))
    || !route(script.id, scriptReview.id)
    || (workflow.schemaVersion === 7 ? !route(scriptReview.id, scriptResultBranch?.id ?? '') : !route(scriptReview.id, loop.id))
    || !route(video.id, videoReview.id)
    || (workflow.schemaVersion === 5 && !route(videoReview.id, concat.id))
    || param(scriptReview, 'script').length !== 1 || !param(scriptReview, 'script')[0].required
    || param(scriptReview, 'script')[0].value !== `\${${script.resultVar}}`
    || param(scriptReview, 'expectedCount').length !== 1 || !param(scriptReview, 'expectedCount')[0].required
    || param(scriptReview, 'expectedCount')[0].value !== '${input.vedio_count}'
    || param(scriptReview, 'source').length !== 1
    || param(scriptReview, 'source')[0].value !== '${storyScriptSource}'
    || [image, video].some(node => param(node, 'storyShot').length !== 1
      || !param(node, 'storyShot')[0].required || param(node, 'storyShot')[0].value !== '${shot}')
    || param(videoReview, 'shot').length !== 1 || !param(videoReview, 'shot')[0].required
    || param(videoReview, 'shot')[0].value !== '${shot}'
    || param(videoReview, 'video').length !== 1 || !param(videoReview, 'video')[0].required
    || param(videoReview, 'video')[0].value !== `\${${video.resultVar}}`
    || param(concat, 'currentVideo').length !== 1 || param(concat, 'currentVideo')[0].value !== '${video_review}'
    || !video.prompt.includes('${shot.timedActions}')
    || !(['requiredPromptText', 'promptOverflowPolicy', 'expectedDuration', 'requiredSound'] as const)
      .every(key => param(video, key).length === 1 && param(video, key)[0].required)
    || param(video, 'requiredPromptText')[0].value !== '${shot.timedActions}'
    || param(video, 'promptOverflowPolicy')[0].value !== 'reject'
    || param(video, 'expectedDuration')[0].value !== '${shot.duration}'
    || param(video, 'requiredSound')[0].value !== 'on') {
    throw new Error('STORY_QUALITY_CONFLICT: 分镜质检节点或付费前置约束缺失，已停止执行')
  }
  const paid = new Set(workflow.nodes.filter(node => ['image', 'video', 'audio'].includes(node.kind))
    .map(node => node.id))
  if (pathAvoiding(workflow.edges, input.id, new Set([loop.id]), scriptReview.id)
    || pathAvoiding(workflow.edges, input.id, new Set([concat.id]), videoReview.id)
    || pathAvoiding(workflow.edges, script.id, new Set([loop.id, ...paid]), scriptReview.id)
    || pathAvoiding(workflow.edges, video.id, new Set([concat.id]), videoReview.id)
    || pathAvoiding(workflow.edges, loop.id, new Set([concat.id]), videoReview.id)) {
    throw new Error('STORY_QUALITY_CONFLICT: 自定义路径绕过了剧本或成片质检')
  }
  if ((workflow.schemaVersion ?? 0) >= 6) {
    const outgoingReview = workflow.edges.filter(edge => edge.from === videoReview.id)
    const outgoingBranch = workflow.edges.filter(edge => edge.from === resultBranch?.id)
    const maxAttempts = resultBranch && param(resultBranch, 'maxAttempts')
    if (!resultBranch || resultBranch.kind !== 'branch' || resultBranch.resultVar !== 'video_review_decision'
      || resultBranch.parentId !== loop.id || !resultBranch.code?.trim()
      || workflow.nodes.some(node => node.id !== resultBranch.id && node.resultVar === resultBranch.resultVar)
      || !(loop.childIds.indexOf(videoReview.id) < loop.childIds.indexOf(resultBranch.id)
        && loop.childIds.indexOf(resultBranch.id) < loop.childIds.indexOf(concat.id))
      || outgoingReview.length !== 1 || outgoingReview[0].to !== resultBranch.id || outgoingReview[0].branch !== undefined
      || outgoingBranch.length !== 2
      || outgoingBranch.filter(edge => edge.branch === 'true' && edge.to === concat.id).length !== 1
      || outgoingBranch.filter(edge => edge.branch === 'false' && edge.to === video.id).length !== 1
      || param(resultBranch, 'report').length !== 1 || !param(resultBranch, 'report')[0].required
      || param(resultBranch, 'report')[0].value !== '${video_review}'
      || param(resultBranch, 'shot').length !== 1 || !param(resultBranch, 'shot')[0].required
      || param(resultBranch, 'shot')[0].value !== '${shot}'
      || param(resultBranch, 'video').length !== 1 || !param(resultBranch, 'video')[0].required
      || param(resultBranch, 'video')[0].value !== `\${${video.resultVar}}`
      || maxAttempts?.length !== 1 || !maxAttempts[0].required
      || !Number.isInteger(Number(maxAttempts[0].value)) || Number(maxAttempts[0].value) < 1
      || Number(maxAttempts[0].value) > MAX_NODE_ATTEMPTS
      || pathAvoiding(workflow.edges, videoReview.id, new Set([concat.id]), resultBranch.id)) {
      throw new Error('STORY_QUALITY_CONFLICT: 成片质检结果分支、回线或付费重拍门禁无效')
    }
  }
  if (workflow.schemaVersion === 7) {
    const outgoingReview = workflow.edges.filter(edge => edge.from === scriptReview.id)
    const outgoingBranch = workflow.edges.filter(edge => edge.from === scriptResultBranch?.id)
    const maxAttempts = scriptResultBranch && param(scriptResultBranch, 'maxAttempts')
    if (!scriptResultBranch || scriptResultBranch.kind !== 'branch'
      || scriptResultBranch.resultVar !== 'script_review_decision'
      || scriptResultBranch.code !== STORY_SCRIPT_REVIEW_RESULT_BRANCH_CODE
      || workflow.nodes.some(node => node.id !== scriptResultBranch.id && node.resultVar === scriptResultBranch.resultVar)
      || outgoingReview.length !== 1 || outgoingReview[0].to !== scriptResultBranch.id || outgoingReview[0].branch !== undefined
      || outgoingBranch.length !== 2
      || outgoingBranch.filter(edge => edge.branch === 'true' && edge.to === loop.id).length !== 1
      || outgoingBranch.filter(edge => edge.branch === 'false' && edge.to === script.id).length !== 1
      || param(scriptResultBranch, 'report').length !== 1 || !param(scriptResultBranch, 'report')[0].required
      || param(scriptResultBranch, 'report')[0].value !== '${script_review}'
      || maxAttempts?.length !== 1 || !maxAttempts[0].required
      || !Number.isInteger(Number(maxAttempts[0].value)) || Number(maxAttempts[0].value) < 1
      || Number(maxAttempts[0].value) > MAX_NODE_ATTEMPTS
      || pathAvoiding(workflow.edges, scriptReview.id, new Set([loop.id]), scriptResultBranch.id)) {
      throw new Error('STORY_QUALITY_CONFLICT: 剧本质检结果分支或有界回线无效')
    }
  }
}

function addStoryScriptReviewResultBranch<N extends Node, W extends Workflow<N>>(workflow: W): W {
  const review = workflow.nodes.find(node => node.id === STORY_SCRIPT_REVIEW_NODE_ID)!
  const script = workflow.nodes.find(node => node.id === 'node-script')!
  const loop = workflow.nodes.find(node => node.id === 'node-loop')!
  if (workflow.nodes.some(node => node.id === STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID
    || node.resultVar === 'script_review_decision')
    || workflow.edges.some(edge => ['edge-script-review-pass', 'edge-script-review-retry'].includes(edge.id))) {
    throw new Error('STORY_QUALITY_CONFLICT: 剧本结果分支 ID 或输出变量已被占用')
  }
  const branch = reviewNode<N>({
    id: STORY_SCRIPT_REVIEW_RESULT_BRANCH_NODE_ID, title: '剧本质检结果与重写回退',
    kind: 'branch', resultVar: 'script_review_decision',
    prompt: '通过后进入分镜循环；未通过时携带质检问题回到剧本生成，达到上限后暂停。',
    code: STORY_SCRIPT_REVIEW_RESULT_BRANCH_CODE,
    params: [
      { id: 'story-script-result-report', name: '剧本质检报告', englishName: 'report', type: 'json', required: true, value: '${script_review}' },
      { id: 'story-script-result-limit', name: '总尝试次数', englishName: 'maxAttempts', type: 'number', required: true, value: '3' },
    ],
    uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    position: midpoint(review, loop),
  })
  const nodes = workflow.nodes.flatMap(node => node.id === review.id ? [node, branch] : [node])
  const edges = workflow.edges.map(edge => edge.from === review.id && edge.to === loop.id && edge.branch === undefined
    ? { ...edge, to: branch.id } : edge)
  edges.push({ id: 'edge-script-review-pass', from: branch.id, to: loop.id, branch: 'true' })
  edges.push({ id: 'edge-script-review-retry', from: branch.id, to: script.id, branch: 'false' })
  const upgraded = { ...workflow, schemaVersion: 7, nodes, edges } as W
  assertQualityTopology(upgraded)
  return spaceStoryNodes(upgraded)
}

function addStoryVideoReviewResultBranch<N extends Node, W extends Workflow<N>>(workflow: W): W {
  const review = workflow.nodes.find(node => node.id === STORY_VIDEO_REVIEW_NODE_ID)!
  const video = workflow.nodes.find(node => node.id === 'node-video')!
  const concat = workflow.nodes.find(node => node.id === 'node-video-concat')!
  const loop = workflow.nodes.find(node => node.id === 'node-loop')!
  if (workflow.nodes.some(node => node.id === STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID
    || node.resultVar === 'video_review_decision')
    || workflow.edges.some(edge => ['edge-video-review-retake', 'edge-video-review-pass'].includes(edge.id))) {
    throw new Error('STORY_QUALITY_CONFLICT: 成片结果分支 ID 或输出变量已被占用')
  }
  const resultBranch = reviewNode<N>({
    id: STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, title: '成片质检结果与重拍回退',
    kind: 'branch', resultVar: 'video_review_decision',
    prompt: STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT,
    code: STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE,
    params: [
      { id: 'story-video-result-report', name: '已审成片报告', englishName: 'report', type: 'json', required: true, value: '${video_review}' },
      { id: 'story-video-result-shot', name: '本镜原分镜', englishName: 'shot', type: 'json', required: true, value: '${shot}' },
      { id: 'story-video-result-source', name: '本镜原视频', englishName: 'video', type: 'json', required: true, value: `\${${video.resultVar}}` },
      { id: 'story-video-result-limit', name: '总尝试次数', englishName: 'maxAttempts', type: 'number', required: true, value: '2' },
    ],
    uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    parentId: loop.id, position: midpoint(review, concat),
  })
  const nodes = workflow.nodes.flatMap(node => node.id === review.id ? [node, resultBranch]
    : node.id === loop.id ? [{ ...node, childIds: node.childIds!.flatMap(id => id === review.id ? [id, resultBranch.id] : [id]) } as N]
      : [node])
  const edges = workflow.edges.map(edge => edge.from === review.id && edge.to === concat.id && edge.branch === undefined
    ? { ...edge, to: resultBranch.id } : edge)
  edges.push({ id: 'edge-video-review-pass', from: resultBranch.id, to: concat.id, branch: 'true' })
  edges.push({ id: 'edge-video-review-retake', from: resultBranch.id, to: video.id, branch: 'false' })
  const upgraded = { ...workflow, schemaVersion: 6, nodes, edges } as W
  assertQualityTopology(upgraded)
  return spaceStoryNodes(upgraded)
}

/** Schema 7 adds an explicit, bounded script rewrite route. Earlier schemas
 * retain their validated migration path through the media result branch. */
export function upgradeStoryQualityWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-story') return workflow
  if (workflow.schemaVersion === 7) {
    assertQualityTopology(workflow)
    return spaceStoryNodes(workflow)
  }
  if (workflow.schemaVersion === 6) {
    assertQualityTopology(workflow)
    return addStoryScriptReviewResultBranch(workflow)
  }
  if (workflow.schemaVersion === 5) {
    const bound = bindPaidStoryShot(workflow)
    assertQualityTopology(bound)
    return addStoryVideoReviewResultBranch(bound)
  }
  if (workflow.schemaVersion !== 4) throw new Error('STORY_QUALITY_CONFLICT: 分镜工作流版本缺少可迁移的质检拓扑')
  const script = workflow.nodes.find(node => node.id === 'node-script')
  const loop = workflow.nodes.find(node => node.id === 'node-loop')
  const video = workflow.nodes.find(node => node.id === 'node-video')
  const concat = workflow.nodes.find(node => node.id === 'node-video-concat')
  if (!script || !loop || !video || !concat || script.kind !== 'text' || loop.kind !== 'loop'
    || new Set(workflow.nodes.map(node => node.id)).size !== workflow.nodes.length
    || video.kind !== 'video' || concat.kind !== 'videoConcat' || !script.resultVar?.trim()
    || !video.resultVar?.trim() || !loop.childIds?.includes(video.id)
    || !loop.childIds.includes(concat.id)
    || workflow.nodes.some(node => node.kind === 'video' && node.id !== video.id)) {
    throw new Error('STORY_QUALITY_CONFLICT: 旧分镜图缺少剧本、循环、视频或拼接节点')
  }

  const scriptEdge = workflow.edges.filter(edge => edge.from === script.id && edge.to === loop.id && !edge.branch)
  const videoEdge = workflow.edges.filter(edge => edge.from === video.id && edge.to === concat.id && !edge.branch)
  if (scriptEdge.length !== 1 || videoEdge.length !== 1 || loop.loop.sourcePath !== `${script.resultVar}.shots`) {
    throw new Error('STORY_QUALITY_CONFLICT: 旧分镜路由不能安全插入质检节点')
  }
  if (workflow.edges.some(edge => edge.branch && (edge.from === script.id && edge.to === loop.id
    || edge.from === video.id && edge.to === concat.id))) {
    throw new Error('STORY_QUALITY_CONFLICT: 分支直连将绕过质检节点')
  }
  if (workflow.nodes.some(node => [STORY_SCRIPT_REVIEW_NODE_ID, STORY_VIDEO_REVIEW_NODE_ID].includes(node.id)
    || ['script_review', 'video_review'].includes(node.resultVar))) {
    throw new Error('STORY_QUALITY_CONFLICT: 质检节点 ID 或输出变量已被占用')
  }
  if (workflow.edges.some(edge => ['edge-script-review-loop', 'edge-video-review-concat'].includes(edge.id))) {
    throw new Error('STORY_QUALITY_CONFLICT: 质检连线 ID 已被占用')
  }
  const currentVideoParams = concat.params.filter(param => (param.englishName || param.name) === 'currentVideo')
  if (currentVideoParams.length !== 1 || currentVideoParams[0].value !== `\${${video.resultVar}}`) {
    throw new Error('STORY_QUALITY_CONFLICT: 当前拼接输入不是原视频节点，不能静默改写自定义来源')
  }
  const videoPosition = midpoint(video, concat)
  const scriptReview = reviewNode<N>({
    id: STORY_SCRIPT_REVIEW_NODE_ID,
    title: '分镜剧本质检', kind: 'validation', operation: 'story.script-review', resultVar: 'script_review',
    modelId: script.modelId,
    prompt: '逐项核对剧情动作、时间窗、完成状态与收尾时长；仅通过后才进入首帧和视频循环。',
    params: [
      { id: 'story-review-script', name: '待检剧本', englishName: 'script', type: 'json', required: true, value: `\${${script.resultVar}}` },
      { id: 'story-review-expected-count', name: '要求分镜数', englishName: 'expectedCount', type: 'number', required: true, value: '${input.vedio_count}' },
      { id: 'story-review-source', name: '重排来源（可选）', englishName: 'source', type: 'json', required: false, value: '${storyScriptSource}' },
    ],
    uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    position: midpoint(script, loop),
  })
  const videoReview = reviewNode<N>({
    id: STORY_VIDEO_REVIEW_NODE_ID,
    title: '分镜成片质检', kind: 'validation', operation: 'story.media-review', resultVar: 'video_review',
    modelId: script.modelId,
    prompt: '核对已保存视频的音画规格、逐项动作完成状态和结尾停留；复核同一素材不重新生成视频。',
    params: [
      { id: 'story-review-shot', name: '已审分镜', englishName: 'shot', type: 'json', required: true, value: '${shot}' },
      { id: 'story-review-video', name: '已生成视频', englishName: 'video', type: 'json', required: true, value: `\${${video.resultVar}}` },
    ],
    uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    parentId: loop.id, position: videoPosition,
  })

  const upgradedLoop: N = { ...loop, childIds: [...loop.childIds.slice(0, loop.childIds.indexOf(video.id) + 1),
    videoReview.id, ...loop.childIds.slice(loop.childIds.indexOf(video.id) + 1)],
  loop: { ...loop.loop, sourcePath: 'script_review.shots', fallbackCount: 0 } } as N
  const timedPrompt = video.prompt.replaceAll('${shotTimedActions}', '${shot.timedActions}')
  const videoParams = video.params.map(param => {
    const key = param.englishName || param.name
    if (key === 'promptOverflowPolicy') return { ...param, required: true, value: 'reject' }
    if (key === 'requiredPromptText') return { ...param, required: true, value: '${shot.timedActions}' }
    if (key === 'expectedDuration') return { ...param, required: true, value: '${shot.duration}' }
    if (key === 'requiredSound') return { ...param, required: true, value: 'on' }
    return param
  })
  if (!videoParams.some(param => (param.englishName || param.name) === 'requiredPromptText')) videoParams.push(
    { id: 'story-video-reviewed-actions', name: '视频提示必须包含', englishName: 'requiredPromptText',
      type: 'text', required: true, value: '${shot.timedActions}' })
  if (!videoParams.some(param => (param.englishName || param.name) === 'promptOverflowPolicy')) videoParams.push(
    { id: 'story-video-prompt-overflow', name: '提示词超限策略', englishName: 'promptOverflowPolicy',
      type: 'text', required: true, value: 'reject' })
  if (!videoParams.some(param => (param.englishName || param.name) === 'expectedDuration')) videoParams.push(
    { id: 'story-video-expected-duration', name: '剧本要求时长', englishName: 'expectedDuration',
      type: 'number', required: true, value: '${shot.duration}' })
  if (!videoParams.some(param => (param.englishName || param.name) === 'requiredSound')) videoParams.push(
    { id: 'story-video-required-sound', name: '要求原生声音', englishName: 'requiredSound',
      type: 'text', required: true, value: 'on' })
  const upgradedVideo: N = { ...video, prompt: timedPrompt.includes('${shot.timedActions}') ? timedPrompt
    : `${timedPrompt.trim()}\n逐项完成已质检的分镜节拍：\${shot.timedActions}。`,
  params: videoParams } as N
  const upgradedConcat: N = { ...concat, params: concat.params.map(param =>
    (param.englishName || param.name) === 'currentVideo' ? { ...param, value: '${video_review}' } : param) } as N

  const nodes: N[] = []
  for (const node of workflow.nodes) {
    nodes.push(node.id === loop.id ? upgradedLoop : node.id === video.id ? upgradedVideo
      : node.id === concat.id ? upgradedConcat : node)
    if (node.id === script.id) nodes.push(scriptReview)
    if (node.id === video.id) nodes.push(videoReview)
  }
  const edges = workflow.edges.map(edge => scriptEdge.includes(edge)
    ? { ...edge, to: scriptReview.id }
    : videoEdge.includes(edge) ? { ...edge, to: videoReview.id } : edge)
  edges.push({ id: 'edge-script-review-loop', from: scriptReview.id, to: loop.id })
  edges.push({ id: 'edge-video-review-concat', from: videoReview.id, to: concat.id })
  const upgraded = bindPaidStoryShot({ ...workflow, schemaVersion: 5, nodes, edges } as W)
  assertQualityTopology(upgraded)
  return spaceStoryNodes(upgraded)
}
