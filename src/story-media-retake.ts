import { STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID } from './story-quality-workflow.ts'

type Value = Record<string, unknown>

export type StoryMediaRetakeRun = {
  node: { id: string; kind?: string; operation?: string }
  status: string
  loopGroupId?: string
  loopIndex?: number
  loopItem?: unknown
  inputs?: unknown
  output?: unknown
}

export type StoryMediaRetakePlan = { videoIndex: number; feedback: string }

/** A direct retry of a paid story video must first inspect the failed review
 * for that exact loop instance; otherwise the ordinary retry loses feedback. */
export function failedStoryMediaReviewIndexForVideo(runs: ReadonlyArray<StoryMediaRetakeRun>, videoIndex: number): number | undefined {
  const video = runs[videoIndex]
  if (!video || video.node.id !== 'node-video' || video.node.kind !== 'video' || video.status !== 'success') return undefined
  const reviewIndex = runs.findIndex(run => run.status !== 'success' && run.status !== 'skipped')
  const review = runs[reviewIndex]
  return reviewIndex > videoIndex && review?.status === 'failed' && review.node.operation === 'story.media-review'
    && review.loopGroupId === video.loopGroupId && review.loopIndex === video.loopIndex
    && identity(review.loopItem) === identity(video.loopItem) ? reviewIndex : undefined
}

const record = (value: unknown): Value | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Value : undefined
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const localVideo = (value: unknown): value is string => typeof value === 'string' && /^\/generated\/[\w.-]+\.mp4$/.test(value)
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function identity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(identity).join(',')}]`
  const object = record(value)
  return object ? `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${identity(object[key])}`).join(',')}}`
    : JSON.stringify(value) ?? ''
}

function safeExcerpt(value: unknown, limit: number): string {
  if (!text(value)) return ''
  return value.replace(/https?:\/\/[^\s\u3000"'<>]+|\/generated\/[\w.\-/?=&%]+/gi, '[素材地址已省略]')
    .replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Return an explicit video retake target only for a source-bound, decoded
 * media review that proves at least one missing action across two frames.
 * Uncertain observations remain questions for the next review, not defects. */
export function planStoryMediaRetake(runs: ReadonlyArray<StoryMediaRetakeRun>, reviewIndex: number): StoryMediaRetakePlan | undefined {
  if (!Number.isSafeInteger(reviewIndex) || reviewIndex < 1 || reviewIndex >= runs.length) return undefined
  if (runs.slice(0, reviewIndex).some(run => run.status !== 'success' && run.status !== 'skipped')
    || runs.slice(reviewIndex + 1).some(run => run.status === 'success' || run.status === 'running')) return undefined
  const run = runs[reviewIndex]
  if (run.status !== 'failed' || run.node.kind !== 'validation' || run.node.operation !== 'story.media-review'
    || !text(run.loopGroupId) || !Number.isSafeInteger(run.loopIndex) || Number(run.loopIndex) < 0) return undefined
  const reviewOutput = record(run.output), review = record(reviewOutput?.storyMediaReview)
  const evidence = record(review?.videoEvidence), publishedEvidence = record(reviewOutput?.videoEvidence)
  const assessment = record(review?.assessment)
  const observations = record(review?.observations)
  if (review?.version !== 'story-shot-media-review-v1' || review.passed !== false
    || review.reviewStatus !== 'incomplete' || review.retryable !== true
    || reviewOutput?.passed !== false || assessment?.version !== 'story-shot-media-review-v1'
    || assessment.passed !== false || observations?.version !== 'story-shot-observations-v1'
    || evidence?.decoded !== true || !localVideo(evidence.url) || !sha256(evidence.sha256)
    || !text(evidence.evidenceUrl) || !/^\/generated\/[\w.-]+\.json$/.test(evidence.evidenceUrl)
    || publishedEvidence?.sha256 !== evidence.sha256 || publishedEvidence.url !== evidence.url
    || publishedEvidence.evidenceUrl !== evidence.evidenceUrl || reviewOutput?.url !== evidence.url
    || assessment.sourceVideoSha256 !== evidence.sha256 || assessment.evidenceUrl !== evidence.evidenceUrl
    || observations?.sourceVideoSha256 !== evidence.sha256 || observations.evidenceUrl !== evidence.evidenceUrl) return undefined
  const frames = evidence.frames, times = evidence.frameTimes, observed = observations.frames
  if (!Array.isArray(frames) || frames.length < 4 || !frames.every(frame => typeof frame === 'string' && /^\/generated\/[\w.-]+\.jpg$/.test(frame))
    || !Array.isArray(times) || times.length !== frames.length || !times.every((time, index) =>
      typeof time === 'number' && Number.isFinite(time) && time >= 0 && (index === 0 || time > times[index - 1]))
    || !Array.isArray(observed) || observed.length !== frames.length || !observed.every((candidate, index) => {
      const frame = record(candidate)
      return frame?.frameIndex === index && frame.second === times[index] && frame.frameUrl === frames[index] && text(frame.description)
    })) return undefined

  const shot = record(run.loopItem), inputShot = record(record(run.inputs)?.shot)
  const beats = shot?.visualBeats
  if (!shot || !Array.isArray(beats) || !beats.length || !inputShot || identity(inputShot) !== identity(shot)) return undefined
  const videos = runs.slice(0, reviewIndex).flatMap((candidate, index) =>
    candidate.node.id === 'node-video' && candidate.node.kind === 'video' && candidate.status === 'success'
      && candidate.loopGroupId === run.loopGroupId && candidate.loopIndex === run.loopIndex
      && identity(candidate.loopItem) === identity(shot) ? [index] : [])
  if (videos.length !== 1) return undefined
  const videoIndex = videos[0], video = record(runs[videoIndex].output), sourceUrl = video?.url
  if (!text(sourceUrl) || reviewOutput?.originalUrl !== sourceUrl || review?.videoUrl !== sourceUrl
    || evidence.originalUrl !== sourceUrl
    || record(record(run.inputs)?.video)?.url !== sourceUrl) return undefined

  const checks = assessment.beatChecks, hold = record(assessment.endingHold)
  if (!Array.isArray(checks) || checks.length !== beats.length || identity(review.beatChecks) !== identity(checks)
    || !hold || identity(review.endingHold) !== identity(hold)
    || !['complete', 'incomplete', 'uncertain'].includes(String(hold.status))) return undefined
  const confirmed: string[] = [], uncertain: string[] = []
  for (const [index, candidate] of checks.entries()) {
    const beat = record(beats[index]), check = record(candidate), id = beat?.id
    if (!text(id) || check?.id !== id || !['complete', 'incomplete', 'uncertain'].includes(String(check.status))) return undefined
    if (check.status === 'uncertain') { uncertain.push(safeExcerpt(id, 24)); continue }
    if (check.status !== 'incomplete') continue
    const indices = check.evidenceFrameIndices, quotes = check.evidenceObservations
    const end = beat?.endSecond
    if (!Array.isArray(indices) || indices.length !== 2 || !Array.isArray(quotes) || quotes.length !== 2
      || !Number.isSafeInteger(indices[0]) || !Number.isSafeInteger(indices[1])
      || indices[0] < 0 || indices[0] >= indices[1] || indices[1] !== frames.length - 1
      || typeof end !== 'number' || !Number.isFinite(end) || Math.abs(times[indices[0]] - end) > .35
      || !text(quotes[0]) || quotes[0] !== quotes[1]
      || !String((observed[indices[0]] as Value).description).includes(quotes[0])
      || !String((observed[indices[1]] as Value).description).includes(quotes[1])) return undefined
    if (!text(beat?.completion)) return undefined
    confirmed.push(`动作 ${safeExcerpt(id, 24)}：计划结束帧与片尾均见“${safeExcerpt(quotes[0], 60)}”；目标“${safeExcerpt(beat.completion, 60)}”未完成`)
  }
  const firstHold = hold.firstFrameIndex, lastHold = hold.lastFrameIndex
  if (hold.status !== 'uncertain') {
    const lastBeat = record(beats.at(-1)), end = lastBeat?.endSecond
    if (typeof firstHold !== 'number' || typeof lastHold !== 'number'
      || !Number.isSafeInteger(firstHold) || !Number.isSafeInteger(lastHold)
      || firstHold < 0 || firstHold >= lastHold || lastHold !== frames.length - 1
      || typeof end !== 'number' || Math.abs(times[firstHold] - end) > .15
      || !text(hold.firstObservation) || !text(hold.lastObservation)
      || !String((observed[firstHold] as Value).description).includes(hold.firstObservation)
      || !String((observed[lastHold] as Value).description).includes(hold.lastObservation)) return undefined
    if (hold.status === 'complete' && (hold.firstObservation !== hold.lastObservation
      || times[lastHold] - times[firstHold] < .8)) return undefined
    if (hold.status === 'incomplete' && !confirmed.length && hold.firstObservation === hold.lastObservation) return undefined
    if (hold.status === 'incomplete' && !confirmed.length) {
      confirmed.push(`片尾终态：动作结束帧“${safeExcerpt(hold.firstObservation, 60)}”，片尾“${safeExcerpt(hold.lastObservation, 60)}”，未保持已完成状态`)
    }
  } else if (!text(hold.reason)) return undefined
  if (!confirmed.length) return undefined
  const parts = [`同镜重拍确证缺口：${confirmed.slice(0, 2).join('；')}`]
  if (confirmed.length > 2) parts.push(`另有 ${confirmed.length - 2} 项确证缺口`)
  if (uncertain.length) parts.push(`待观察：${uncertain.slice(0, 3).join('、')}${uncertain.length > 3 ? `等 ${uncertain.length} 项` : ''}`)
  parts.push('保留原分镜全部动作和道具归属，按实际画面完成后再留可读终态')
  return { videoIndex, feedback: parts.join('；').slice(0, 550) }
}

/** A routed review is saved as a successful node even when its report rejects
 * the clip. Reuse the exact manual-retake proof before following a paid false
 * edge; the temporary status change never touches the execution record. */
export function planStoryMediaBranchRetake(runs: ReadonlyArray<StoryMediaRetakeRun>, branchIndex: number): StoryMediaRetakePlan | undefined {
  const branch = runs[branchIndex], reviewIndex = branchIndex - 1, review = runs[reviewIndex]
  if (!branch || branch.node.id !== STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID || branch.node.kind !== 'branch'
    || branch.status !== 'running' || !review || review.node.id !== 'node-video-review'
    || review.status !== 'success' || review.loopGroupId !== branch.loopGroupId
    || review.loopIndex !== branch.loopIndex || identity(review.loopItem) !== identity(branch.loopItem)) return undefined
  const sourceRuns = runs.slice(0, branchIndex).map((run, index) => index === reviewIndex
    ? { ...run, status: 'failed' } : run)
  return planStoryMediaRetake(sourceRuns, reviewIndex)
}
