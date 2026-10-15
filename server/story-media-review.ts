import { collectVideoEvidence, inspectGeneratedVideo } from './video-inspection.ts'
import { applyAudioLevelRemediation, planAudioLevelRemediation } from './audio-level-remediation.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { validateStoryVocalBeats, type StoryVocalBeat } from '../src/story-shot-vocals.ts'
import { collectStoryVocalEvidence, type StoryVocalEvidence } from './story-vocal-evidence.ts'

type Value = Record<string, unknown>
type StoryTextModel = { id: string; provider: string; capability: string }
type StoryExecutionContext = { requestKey?: string; workflowId?: string; workflowName?: string; nodeId?: string; nodeName?: string }
type ModelRequest<TModel> = { model: TModel; prompt: string; params: Record<string, unknown>; operation?: string; executionContext?: StoryExecutionContext }
type ModelResponse = { status: number; body: unknown }
type Evidence = Awaited<ReturnType<typeof collectVideoEvidence>>

// The blind pass can describe 24 distinct frames and the second pass can cite
// each of them. The ordinary text default (1200 tokens) truncates those JSON
// reports; this explicit ceiling is forwarded to both supported text routes.
const STORY_SHOT_REVIEW_MAX_TOKENS = 8192

export type StoryShotReviewStatus = 'passed' | 'incomplete' | 'uncertain' | 'invalid' | 'unavailable' | 'technical-failure'

function record(value: unknown): Value | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** A directional move is not evidence that a prop reached a character's
 * usable space. Evaluate the quoted prop sentence, not unrelated distances
 * elsewhere in a frame (for example the gap between two animals). */
function reachabilityEvidence(beat: Value, completionObservation: unknown): boolean {
  const criterion = String(beat.completion ?? '')
  if (!/(?:可触及|触手可及|够得着|够得到|伸手可及|伸爪可及|(?:到|在).{0,12}(?:面前|跟前|爪边|手边|身边))/.test(criterion)) return true
  if (!nonempty(completionObservation)) return false
  const observed = completionObservation
  if (/(?:仍有|尚有|还有|还留有|明显有|隔着).{0,8}(?:间隔|距离|空隙|障碍)|(?:间隔|距离|空隙).{0,4}(?:明显|较大|很大)|离.{0,12}(?:爪|手|脚|嘴|身).{0,6}(?:很远|较远|远处|一段距离)|(?:无法|不能|未能|尚未|还没|够不着|够不到).{0,8}(?:触及|碰到|接触|够到)|(?:远离|离得远|相距较远)|(?:超过|大于).{0,4}(?:一个|一只)爪宽/.test(observed)) return false
  return /(?:可触及|触手可及|够得着|够得到|伸手可及|伸爪可及|(?:紧邻|紧挨|紧贴|贴着).{0,24}(?:爪|手|脚|嘴|身)|(?:爪|手|脚|嘴|身).{0,24}(?:紧邻|紧挨|紧贴|贴着)|(?:爪|手|脚|嘴|身).{0,12}(?:不到|不足|小于|约半个|半个|半只)爪宽)/.test(observed)
}

function quotedObservationSentence(description: unknown, quotation: unknown): unknown {
  if (!nonempty(description) || !nonempty(quotation)) return description
  const sentence = description.split(/[。；\n]/).find(part => part.includes(quotation))
  return sentence ?? description
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error) }

function parsedResponse(body: unknown): Value | undefined {
  const parsed = parseStructuredJson(extractTextResponse(body))
  return record(parsed)
}

/** Keep each beat's opening, near-completion and completed state, then sample
 * motion at half-second intervals where the 24-frame budget permits. Two
 * intermediate positions per beat make brief prop/contact transitions easier
 * to inspect without choosing times from a particular script or video. The
 * evidence collector adds the actual decodable tail after this plan. */
export function storyReviewSampleTimes(shot: unknown): number[] {
  validateStoryShotTimingOutput([shot])
  const value = shot as Value
  const duration = value.duration as number
  const beats = value.visualBeats as Value[]
  const times = new Set<number>()
  const add = (second: number) => times.add(Number(second.toFixed(3)))
  // Reserve one slot for collectVideoEvidence's actual decodable tail. These
  // anchors fit within 23 planned frames even at 15 seconds with seven beats.
  for (const beat of beats) {
    const start = beat.startSecond as number, end = beat.endSecond as number
    add(start); add(end - .5); add(end)
  }
  const lastEnd = beats.at(-1)!.endSecond as number
  add((lastEnd + duration) / 2); add(duration - .5)
  // A half-second grid catches brief paw/prop contact that a beat midpoint
  // may miss. Greedy farthest-point insertion spreads remaining slots over a
  // 15-second shot; an 8-second shot has room for the complete grid.
  const candidates = Array.from({ length: duration * 2 }, (_, tick) => tick / 2)
  while (times.size < 23) {
    const next = candidates.filter(second => !times.has(second))
      .map(second => ({ second, gap: Math.min(...[...times].map(anchor => Math.abs(anchor - second))) }))
      .sort((left, right) => right.gap - left.gap || left.second - right.second)[0]
    if (!next) break
    add(next.second)
  }
  for (const fraction of [.6, .4]) {
    for (const beat of beats) {
      if (times.size >= 23) break
      const start = beat.startSecond as number, end = beat.endSecond as number
      add(start + (end - start) * fraction)
    }
  }
  if (times.size > 23) throw new Error('STORY_SHOT_SAMPLING_INVALID: 逐动作采证超过 24 帧上限')
  return [...times].sort((a, b) => a - b)
}

/** Add detail views at evenly spread source indices, including both ends.
 * Keep every full frame; at the 24-frame sampling ceiling this adds 20 crops
 * for 44 attachments. loadReviewImages still enforces count/byte budgets. */
export function storyReviewImageDetail(frameCount: number) {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new Error('STORY_SHOT_REVIEW_INVALID: 局部采证缺少原帧')
  const anchorCount = Math.min(5, frameCount)
  return { indices: Array.from({ length: anchorCount }, (_, index) =>
    Math.round(index * (frameCount - 1) / Math.max(1, anchorCount - 1))), columns: 2, rows: 2, overlap: .2 }
}

function evidenceFrames(evidence: Evidence) {
  return evidence.frames.map((url, frameIndex) => ({ frameIndex, frameUrl: url, second: evidence.frameTimes[frameIndex] }))
}

function validEvidence(evidence: Evidence): boolean {
  return evidence.decoded === true && /^[a-f0-9]{64}$/.test(evidence.sha256)
    && nonempty(evidence.evidenceUrl) && Array.isArray(evidence.frames) && evidence.frames.length >= 4
    && evidence.frames.length === evidence.frameTimes.length
    && evidence.frames.every(url => /^\/generated\/[\w.-]+\.jpg$/.test(url))
    && evidence.frameTimes.every((time, index, all) => Number.isFinite(time) && time >= 0 && (index === 0 || time > all[index - 1]))
}

export function buildStoryShotObservationPrompt(evidence: Evidence) {
  // Frame URLs are trusted server evidence. The model only identifies an
  // attachment by its ordinal and time; asking it to repeat long generated
  // paths caused some models to emit JavaScript expressions instead of JSON.
  const frameTimes = evidence.frameTimes.map((second, frameIndex) => ({ frameIndex, second }))
  return `【短视频原片盲观察】附件是同一支已解码视频的全部原始完整帧，以及选定原帧的原像素局部图。附件标签中的 frameIndex 标识其对应原帧，源像素矩形标识局部位置；局部图仅从该原帧裁剪，未放大、未补画或生成细节。结合完整帧确认局部的空间归属，合并为同一 frameIndex 的一条描述，不把局部附件当成新的帧或时刻，不按附件序号新增帧索引。现在不要判断剧情是否完成；你没有剧本，不能猜情节、动作意图或人物身份。
按原帧顺序逐帧独立描述实际可见状态：主体姿态、头脸朝向、眼睛状态、手/爪及所持物的位置与接触；正在被操作、承托、递交或发生变化的物体；可见表面的标记、数量、内容与开合状态；屏幕可辨布局；服饰、配件、构图及身体哪些部分在画内。涉及工具与表面时，区分握持、悬停、接触或看不清。涉及交接或接近时，记录相关物体到相关角色的实际可见间隙、接触和遮挡，可用紧邻、约半个或一个手/爪宽等画面关系；不穷举所有背景道具与所有角色的距离。不要把“在某角色一侧/前方”当成距离描述，不要推断看不见的手/爪是否够得到。
看不清写“不清楚”，不要用前后帧补全单张画面。每帧先写本帧事实；可另写“与第 X 帧相比的可见差异”，仅比较两帧都清楚可辨的同一部位、物体或表面，区分物体状态变化与构图、遮挡或光照变化，不推断中间过程或变化原因。避免重复无关场景细节；相同的实际可见状态请在每张 description 里使用相同的简短措辞，方便核对其是否持续；仍须独立观察每一帧。\n证据绑定：${JSON.stringify({ sourceVideoSha256: evidence.sha256, evidenceUrl: evidence.evidenceUrl, frameTimes })}\n严格只返回一个完整 JSON 对象，不要 Markdown、解释、代码或表达式。格式：{"version":"story-shot-observations-v1","sourceVideoSha256":"原片SHA256","evidenceUrl":"采证URL","frames":[{"frameIndex":0,"second":0,"description":"这一帧实际看见的状态"}]}。frames 须严格按原始完整帧顺序覆盖全部 ${frameTimes.length} 个采证帧，局部图不增加条目；frameIndex 和 second 原样使用证据绑定中的数字。每帧只写 frameIndex、second、description，绝对不要输出 frameUrl 或其他 URL；帧地址由服务端绑定。`
}

function observationIssues(observations: unknown, evidence: Evidence, bound: boolean): string[] {
  const result = record(observations), frames = Array.isArray(result?.frames) ? result.frames : []
  const expected = evidenceFrames(evidence)
  const issues: string[] = []
  if (!validEvidence(evidence)) issues.push('实际视频帧或来源散列不完整')
  if (result?.version !== 'story-shot-observations-v1' || result.sourceVideoSha256 !== evidence.sha256
    || result.evidenceUrl !== evidence.evidenceUrl || frames.length !== expected.length) issues.push('盲观察未覆盖当前视频全部采证帧')
  const seen = new Set<number>()
  for (const [index, frame] of frames.entries()) {
    const row = record(frame), target = expected[index]
    const frameIndex = row?.frameIndex
    if (typeof frameIndex === 'number') {
      if (seen.has(frameIndex)) issues.push(`第 ${index + 1} 张盲观察索引重复`)
      seen.add(frameIndex)
    }
    const keys = row ? Object.keys(row).sort() : []
    const expectedKeys = bound ? ['description', 'frameIndex', 'frameUrl', 'second'] : ['description', 'frameIndex', 'second']
    if (!target || !row || JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || row.frameIndex !== target.frameIndex || row.second !== target.second
      || (bound && row.frameUrl !== target.frameUrl) || !nonempty(row.description)) {
      issues.push(`第 ${index + 1} 张盲观察缺失或证据绑定错误`)
    }
  }
  return issues
}

/** Validate the untrusted compact model response before adding server-owned
 * frame URLs. Never accept a model-supplied frame address as provenance. */
export function validateStoryShotObservations(observations: unknown, evidence: Evidence): string[] {
  return observationIssues(observations, evidence, false)
}

export function bindStoryShotObservations(observations: unknown, evidence: Evidence): Value {
  const issues = validateStoryShotObservations(observations, evidence)
  if (issues.length) throw new Error(issues.join('；'))
  const result = observations as Value
  const rows = result.frames as Value[]
  return { version: 'story-shot-observations-v1', sourceVideoSha256: evidence.sha256,
    evidenceUrl: evidence.evidenceUrl,
    frames: evidenceFrames(evidence).map((trusted, index) => ({ ...trusted, description: rows[index].description })) }
}

export function buildStoryShotAssessmentPrompt(shot: unknown, evidence: Evidence, observations: unknown) {
  const value = shot as Value
  const beats = value.visualBeats as Value[]
  return `【短视频逐动作完成审查】下面是先于剧本完成的逐帧盲观察。你现在只能根据这些实际观察，对照逐项动作完成条件；不能看见、不能从首帧意图或生成提示词推断的过程，一律标 uncertain。动作须有不同帧的开始状态和完成状态；道具交接须有归属或位置变化，接触动作须看到接触关系变化，反应须看到反应后的状态。静止终态不能倒推出动作过程。完成引文只逐字摘取能证明该动作所要求状态的相关句子，不要复制整帧描述。仅当动作涉及道具交接、到达可触及处或接触时，依据相关物体与指定对象之间的实际间隙、接触或归属状态判断；接触类动作须引用相应接触双方的可见关系。对于到达可触及处：朝指定对象方向移动、停在画面中央或对象所在一侧，不能证明已经到达；须引用相关物体与指定对象手/爪实际间隙或接触的原句，并依据该间隙和遮挡判断是否足够接近。直接接触接收对象不是“停到可触及处”的必要条件，但不能把角色彼此的间隙误当成道具到接收对象的间隙。上述动作所需的距离、接触或归属看不清时标 uncertain。其他动作引用证明所要求的姿态、可见表面状态、服饰或构图变化等的原句，不要求道具到手/爪的距离。\n每项按原 id 顺序返回 status=complete/incomplete/uncertain。complete 必须给不同的 startFrameIndex 和 completionFrameIndex，并从对应盲观察 description 原文逐字摘取 startObservation 和 completionObservation；二者须体现所要求的可见状态变化，完成帧须在该动作计划 endSecond 附近或之前。incomplete 只用于原帧明确证明该动作在计划结束时以及片尾都没有完成：另给 evidenceFrameIndices=[计划结束帧编号,实际末帧编号] 和 evidenceObservations=[分别从这两帧 description 逐字摘取的同一句未完成状态]。缺少这种跨帧证据，或者遮挡/抽帧不足，应标 uncertain，不可用来要求另购重拍。片尾完成状态从最后动作计划结束帧持续到实际末帧，至少可见 0.8 秒；firstObservation 和 lastObservation 须从两帧逐字摘取同一句已完成终态，不能仅靠尾部 0.2 秒判保持。片尾未完成也要给这两个原帧编号、引文和具体原因。不得把 3 秒视频的“参数时长正确”当剧情完成。\n证据：${JSON.stringify({ sourceVideoSha256: evidence.sha256, evidenceUrl: evidence.evidenceUrl, videoDuration: evidence.duration, observations })}\n剧本：${JSON.stringify({ title: value.title, content: value.content, duration: value.duration, visualBeats: beats })}\n只返回 JSON：{"version":"story-shot-media-review-v1","sourceVideoSha256":"原片SHA256","evidenceUrl":"采证URL","passed":false,"beatChecks":[{"id":"原动作id","status":"complete/incomplete/uncertain","startFrameIndex":0,"completionFrameIndex":1,"startObservation":"逐字摘自开始帧描述","completionObservation":"逐字摘自完成帧描述","evidenceFrameIndices":[0,1],"evidenceObservations":["逐字摘自未完成状态","逐字摘自未完成状态"],"reason":"判断依据；若未完成或不确定写明"}],"endingHold":{"status":"complete/incomplete/uncertain","firstFrameIndex":0,"lastFrameIndex":1,"firstObservation":"逐字摘自第一张终态帧描述","lastObservation":"逐字摘自最后一张终态帧描述","reason":"判断依据"},"issues":["具体未完成项或证据不足；全部完成时为空数组"]}。只有每项动作完成、终态保持完整且 issues 为空时 passed=true。`
}

export function validateStoryShotAssessment(shot: unknown, evidence: Evidence, observations: unknown, assessment: unknown) {
  validateStoryShotTimingOutput([shot])
  const beats = (shot as Value).visualBeats as Value[]
  const result = record(assessment)
  const checks = Array.isArray(result?.beatChecks) ? result.beatChecks : []
  const hold = record(result?.endingHold)
  const observed = (record(observations)?.frames as Value[] | undefined) ?? []
  const issues: string[] = []
  const validIndex = (index: unknown): index is number => Number.isSafeInteger(index) && Number(index) >= 0 && Number(index) < evidence.frames.length
  const quote = (index: number, value: unknown): boolean => nonempty(value) && String(observed[index]?.description ?? '').includes(value)
  if (observationIssues(observations, evidence, true).length) issues.push('盲观察证据无效')
  if (result?.version !== 'story-shot-media-review-v1' || result.sourceVideoSha256 !== evidence.sha256
    || result.evidenceUrl !== evidence.evidenceUrl || typeof result.passed !== 'boolean'
    || !Array.isArray(result.issues) || result.issues.some(issue => !nonempty(issue))) issues.push('审核报告格式或视频证据绑定无效')
  if (checks.length !== beats.length) issues.push('审核未逐项覆盖剧本动作')
  let hasIncomplete = false, hasUncertain = false, modelUncertain = false
  const semanticUncertainty: string[] = []
  for (const [index, beat] of beats.entries()) {
    const check = record(checks[index]), label = `动作 ${String(beat.id)}`
    if (!check || check.id !== beat.id || !['complete', 'incomplete', 'uncertain'].includes(String(check.status))) {
      issues.push(`${label} 缺少合法结果或顺序错误`)
      continue
    }
    if (check.status === 'incomplete') hasIncomplete = true
    if (check.status === 'uncertain') { hasUncertain = true; modelUncertain = true }
    if (check.status !== 'complete') {
      if (!nonempty(check.reason)) issues.push(`${label} 缺少未完成或无法判定的原因`)
      if (check.status === 'incomplete') {
        const indices = check.evidenceFrameIndices, quotes = check.evidenceObservations
        const end = beat.endSecond as number
        if (!Array.isArray(indices) || indices.length !== 2 || !Array.isArray(quotes) || quotes.length !== 2
          || !validIndex(indices[0]) || !validIndex(indices[1]) || indices[0] >= indices[1]
          || indices[1] !== evidence.frames.length - 1
          || evidence.frameTimes[indices[0]] < end - .35 || evidence.frameTimes[indices[0]] > end + .35
          || !quote(indices[0], quotes[0]) || !quote(indices[1], quotes[1]) || quotes[0] !== quotes[1]) {
          issues.push(`${label} 未完成结论缺少计划结束帧和实际末帧中持续可见的原文证据`)
        }
      }
      continue
    }
    const first = check.startFrameIndex, last = check.completionFrameIndex
    const begin = beat.startSecond as number, end = beat.endSecond as number
    if (!validIndex(first) || !validIndex(last) || first >= last
      || evidence.frameTimes[first] < begin - .15 || evidence.frameTimes[first] >= end
      || evidence.frameTimes[last] <= begin || evidence.frameTimes[last] > end + .35
      || !quote(first, check.startObservation) || !quote(last, check.completionObservation)
      || check.startObservation === check.completionObservation) issues.push(`${label} 缺少当前时间窗内的前后状态原帧引文`)
    else if (!reachabilityEvidence(beat, check.completionObservation)
      || !reachabilityEvidence(beat, quotedObservationSentence(observed[last]?.description, check.completionObservation))) {
      hasUncertain = true
      semanticUncertainty.push(`${label} 完成引文未证明道具到达指定对象可触及处`)
    }
  }
  if (!hold || !['complete', 'incomplete', 'uncertain'].includes(String(hold.status))) issues.push('片尾终态保持结果无效')
  else if (hold.status === 'uncertain') { hasUncertain = true; modelUncertain = true; if (!nonempty(hold.reason)) issues.push('片尾无法判定原因缺失') }
  else {
    if (hold.status === 'incomplete') hasIncomplete = true
    const first = hold.firstFrameIndex, last = hold.lastFrameIndex
    const lastBeatEnd = beats.at(-1)!.endSecond as number
    const anchorsValid = validIndex(first) && validIndex(last) && first < last
      && last === evidence.frames.length - 1
      && Math.abs(evidence.frameTimes[first] - lastBeatEnd) <= .15
      && quote(first, hold.firstObservation) && quote(last, hold.lastObservation)
    if (!anchorsValid || (hold.status === 'incomplete' && !nonempty(hold.reason))) {
      issues.push('片尾结果缺少动作结束帧与实际末帧的原文引文')
    } else if (hold.status === 'complete') {
      if (evidence.frameTimes[last] - evidence.frameTimes[first] < .8
        || hold.firstObservation !== hold.lastObservation) {
        issues.push('片尾通过结论没有证明同一终态至少持续 0.8 秒')
      }
    } else if (hold.firstObservation === hold.lastObservation
      && evidence.frameTimes[last] - evidence.frameTimes[first] >= .8 && !beats.some((_, index) => record(checks[index])?.status === 'incomplete')) {
      issues.push('动作均完成且原片终态持续，片尾失败结论缺少状态变化证据')
    }
  }
  const reportedIssues = Array.isArray(result?.issues) ? result.issues.map(String) : []
  const allComplete = !hasIncomplete && !hasUncertain && issues.length === 0 && reportedIssues.length === 0
  const semanticUncertaintyOnly = semanticUncertainty.length > 0 && !hasIncomplete && !modelUncertain
    && issues.length === 0 && reportedIssues.length === 0
  if (result?.passed === true && !allComplete && !semanticUncertaintyOnly) issues.push('总体通过结论与逐项证据矛盾')
  if (result?.passed === false && allComplete) issues.push('逐项全部完成却被报告为失败，须复核模型结果')
  const valid = issues.length === 0
  const reviewStatus: StoryShotReviewStatus = !valid ? 'invalid' : hasIncomplete ? 'incomplete' : hasUncertain ? 'uncertain'
    : result?.passed === true ? 'passed' : 'invalid'
  return { passed: reviewStatus === 'passed', reviewStatus, retryable: reviewStatus === 'incomplete',
    beatChecks: checks, endingHold: hold ?? null, issues: [...issues, ...semanticUncertainty, ...reportedIssues] }
}

/** Frame review can pass while the audio still contains only room noise. The
 * scheduled excerpts are a listening aid, never proof of animal identity. */
export function applyStoryVocalReviewGate(visual: { passed: boolean; reviewStatus: StoryShotReviewStatus;
  retryable: boolean; issues: string[] }, vocalEvidence?: StoryVocalEvidence) {
  if (!vocalEvidence || !visual.passed) return visual
  return { ...visual, passed: false, reviewStatus: 'uncertain' as const, retryable: false,
    issues: ['声音时间窗有音频信号，但尚未证实为芙伊“喵儿”和卷毛“旺”的真实叫声、交互与口型同步；请听审同一素材'] }
}

/** Audit one already paid take. Unclear or unavailable observation never asks
 * the caller to purchase another video; every result retains the original URL
 * and, where decoding worked, the local video plus its immutable frame report. */
export async function reviewStoryShotVideo<TModel extends StoryTextModel>(options: {
  shot: unknown; videoUrl: string; model: TModel; execute: (request: ModelRequest<TModel>) => Promise<ModelResponse>
  executionContext?: StoryExecutionContext; root?: string; aspectRatio?: string; requireAudio?: boolean
}) {
  const { shot, videoUrl, model, execute, executionContext } = options
  const sampleTimes = storyReviewSampleTimes(shot)
  const vocalPlanRequired = record(shot)?.vocalBeats !== undefined
    || record(shot)?.audioContractVersion !== undefined
  let audioLevelRemediation: Awaited<ReturnType<typeof applyAudioLevelRemediation>> | undefined
  let vocalEvidence: StoryVocalEvidence | undefined
  const base = () => ({ version: 'story-shot-media-review-v1' as const, videoUrl, vocalPlanRequired,
    ...(audioLevelRemediation ? { audioLevelRemediation } : {}),
    ...(vocalEvidence ? { vocalEvidence } : {}) })
  let videoEvidence: Evidence | undefined
  try {
    videoEvidence = await inspectGeneratedVideo({ url: videoUrl, duration: Number((shot as Value).duration),
      aspectRatio: options.aspectRatio ?? '9:16', requireAudio: options.requireAudio ?? true, sampleTimes }, options.root)
  } catch (error) {
    let technicalFailure = message(error)
    if (technicalFailure === 'VIDEO_QUALITY_REJECTED: 实际音轨接近静音'
      && (options.requireAudio ?? true)) {
      try {
        // The evidence collector archives remote paid media locally. The
        // remediation helper only accepts that saved MP4 and proves genuine
        // audio, safe gain and identical decoded video frames before review.
        const archived = await collectVideoEvidence({ url: videoUrl }, options.root)
        if (!/^\/generated\/[\w.-]+\.mp4$/.test(archived.url)) throw Error('原片未保存为本地 MP4', { cause: error })
        const plan = await planAudioLevelRemediation(archived.url, { root: options.root })
        const derivative = await applyAudioLevelRemediation(plan)
        const candidate = await inspectGeneratedVideo({ url: derivative.outputUrl,
          duration: Number((shot as Value).duration), aspectRatio: options.aspectRatio ?? '9:16',
          requireAudio: true, sampleTimes }, options.root)
        if (candidate.sha256 !== derivative.outputSha256 || !derivative.everyDecodedVideoFrameMatched) {
          throw Error('派生片散列或逐帧一致性与音轨补救清单不符', { cause: error })
        }
        videoEvidence = candidate
        audioLevelRemediation = derivative
      } catch (remediationError) {
        technicalFailure += `；原音轨增益补救未通过：${message(remediationError)}`
      }
    }
    if (!audioLevelRemediation) {
      let retainedEvidence: Evidence | undefined
      try { retainedEvidence = await collectVideoEvidence({ url: videoUrl }, options.root) } catch { /* The source URL remains in the result. */ }
      return { ...base(), passed: false, retryable: false, reviewStatus: 'technical-failure' as const,
        issues: [technicalFailure], assessment: null, observations: null, beatChecks: [], endingHold: null,
        videoEvidence: retainedEvidence ?? null }
    }
  }
  if (!videoEvidence) throw Error('STORY_SHOT_REVIEW_INVALID: 技术复核没有产生媒体证据')
  const fail = (reviewStatus: StoryShotReviewStatus, issue: string, observations: unknown = null, assessment: unknown = null) => ({ ...base(),
    passed: false, retryable: false, reviewStatus, issues: [issue], observations, assessment,
    beatChecks: [], endingHold: null, videoEvidence })
  if (!validEvidence(videoEvidence)) return fail('invalid', '原片采证缺少完整帧或散列')
  const vocalPlan = record(shot)?.vocalBeats
  if (vocalPlan !== undefined || record(shot)?.audioContractVersion !== undefined) {
    const issues = validateStoryVocalBeats(shot, { required: true })
    if (issues.length) return fail('invalid', `ANIMAL_INTERACTION_INVALID: ${issues.join('；')}`)
    try {
      vocalEvidence = await collectStoryVocalEvidence({ url: videoEvidence.url, sha256: videoEvidence.sha256,
        duration: videoEvidence.duration }, vocalPlan as StoryVocalBeat[], options.root,
        (record(shot)?.visualBeats ?? []) as Array<{ id: string; startSecond: number; endSecond: number }>)
    } catch (error) {
      return fail('unavailable', `叫声同素材采证未完成：${message(error)}`)
    }
    if (vocalEvidence.acousticStatus === 'silent-window') {
      return fail('technical-failure', '计划的猫狗叫声时间窗存在无有效声音信号的片段；已保存原片和逐声试听片段')
    }
  }
  if (!model?.id || model.capability !== 'text' || !model.provider || model.provider === 'Local') {
    return fail('unavailable', '缺少已配置的实际视觉文本模型')
  }
  let observationDraft: Value | undefined
  try {
    const response = await execute({ model, prompt: buildStoryShotObservationPrompt(videoEvidence),
      params: { reviewImages: videoEvidence.frames, reviewImageDetail: storyReviewImageDetail(videoEvidence.frames.length),
        temperature: 0, reasoningEffort: 'high', maxTokens: STORY_SHOT_REVIEW_MAX_TOKENS }, operation: 'story.frame-observe', executionContext })
    if (response.status >= 400) throw new Error(`逐帧盲观察模型 HTTP ${response.status}`)
    observationDraft = parsedResponse(response.body)
  } catch (error) { return fail('unavailable', `逐帧盲观察未完成：${message(error)}`) }
  const draftIssues = validateStoryShotObservations(observationDraft, videoEvidence)
  if (draftIssues.length) return fail('invalid', draftIssues.join('；'), observationDraft)
  const observations = bindStoryShotObservations(observationDraft, videoEvidence)
  let assessment: Value | undefined
  try {
    const response = await execute({ model, prompt: buildStoryShotAssessmentPrompt(shot, videoEvidence, observations),
      params: { temperature: 0, reasoningEffort: 'high', maxTokens: STORY_SHOT_REVIEW_MAX_TOKENS }, operation: 'story.beat-review', executionContext })
    if (response.status >= 400) throw new Error(`剧情完成审核模型 HTTP ${response.status}`)
    assessment = parsedResponse(response.body)
  } catch (error) { return fail('unavailable', `剧情完成审核未完成：${message(error)}`, observations) }
  const validation = validateStoryShotAssessment(shot, videoEvidence, observations, assessment)
  return { ...base(), ...validation, ...applyStoryVocalReviewGate(validation, vocalEvidence),
    observations, assessment: assessment ?? null, videoEvidence }
}
