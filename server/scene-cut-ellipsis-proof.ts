import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { approvedSceneCutEllipsis, adjacentSceneCutBridgeIssue } from '../src/history-drama.ts'
import { principleDurationTransitionIssue, principleMediaEvidenceIssue } from '../src/history-cinema.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const invalid = (message: string): never => { throw Error(`SCENE_CUT_ELLIPSIS_INVALID: ${message}`) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value ?? null)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const bytesHash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
function savedFile(url: unknown, root: string, extension: RegExp) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url) || !extension.test(url))
    invalid('真实成片或尾帧必须是本地归档文件')
  return path.join(root, 'public', String(url))
}

/** The accepted outline and actual prior take are frozen into the source
 * archive. For an editorial ellipsis, a completed previous take and its
 * decoded last frame are mandatory even though the next shot uses a fresh
 * opening image. */
export function deriveSceneCutEllipsisProof(input: { shot: unknown; approvedOutline: unknown;
  previous?: unknown }, root = process.cwd()) {
  const shot = object(input.shot), outline = object(input.approvedOutline)
  const scenes = Array.isArray(outline.scenes) ? outline.scenes.map(object) : []
  const index = scenes.findIndex(scene => scene.id === shot.id)
  if (typeof shot.id !== 'string' || !shot.id || index < 0 || scenes.length < 1
    || new Set(scenes.map(scene => scene.id)).size !== scenes.length)
    invalid('当前分镜不在唯一的已批准大纲场景中')
  const current = scenes[index]
  const previousScene = scenes[index - 1]
  const outlineBinding = { outlineSha256: hash(outline), currentSceneId: String(current.id),
    currentSceneSha256: hash(current), sceneIndex: index }
  if (!previousScene) return { outlineBinding }
  const previous = object(input.previous), priorShot = object(previous.shot_script)
  if (priorShot.id !== previousScene.id) invalid('上一分镜与已批准相邻场景不一致')
  const approved = approvedSceneCutEllipsis(previousScene, current)
  const issue = adjacentSceneCutBridgeIssue(previousScene, current)
  if (issue) invalid(issue)
  if (!approved) return { outlineBinding }
  const video = object(previous.video_shot), tail = object(previous.last_frame)
  const mediaIssue = principleMediaEvidenceIssue(video, priorShot)
  const durationIssue = principleDurationTransitionIssue(priorShot, video)
  const review = object(video.visualReview), endingEvidence = object(review.endingStateEvidence)
  const frames = Array.isArray(video.frames) ? video.frames : []
  const endingState = typeof review.endingState === 'string' ? review.endingState : ''
  if (mediaIssue || durationIssue || video.qualityPolicy !== 'principle-v1'
    || object(priorShot.storyProgress).status !== 'complete'
    || !Array.isArray(object(priorShot.storyProgress).pendingActions)
    || (object(priorShot.storyProgress).pendingActions as unknown[]).length
    || video.decoded !== true || typeof video.lastFrameUrl !== 'string'
    || frames.at(-1) !== video.lastFrameUrl || tail.available !== true
    || tail.url !== video.lastFrameUrl || tail.source !== 'extracted-from-video'
    || review.passed !== true || endingEvidence.method !== 'actual-tail-image'
    || endingEvidence.frame !== video.lastFrameUrl
    || approved.sharedCast.some(name => !endingState.includes(name)))
    invalid(`前镜未以同素材完成全部必需节拍和真实尾帧状态：${mediaIssue ?? durationIssue ?? ''}`)
  let videoBytes: Buffer, tailBytes: Buffer
  try {
    videoBytes = readFileSync(savedFile(video.url, root, /\.mp4$/i))
    tailBytes = readFileSync(savedFile(video.lastFrameUrl, root, /\.(?:png|jpe?g|webp)$/i))
  } catch { return invalid('前镜真实成片或采证末帧文件缺失') }
  if (!videoBytes.length || !tailBytes.length) invalid('前镜真实成片或采证末帧为空')
  if (typeof video.sha256 === 'string' && video.sha256 !== bytesHash(videoBytes))
    invalid('前镜成片字节与采证输出 SHA 不一致')
  return { outlineBinding, approvedEllipsis: {
    ...approved, previousSceneSha256: hash(previousScene), currentSceneSha256: hash(current),
    priorShotSha256: hash(priorShot), priorVideoUrl: video.url,
    priorVideoSha256: bytesHash(videoBytes), priorEvidenceUrl: video.evidenceUrl,
    priorTailUrl: video.lastFrameUrl, priorTailSha256: bytesHash(tailBytes),
    priorScheduleHash: object(priorShot.pacing).scheduleHash,
  } }
}

/** Recompute provenance and file bytes at each paid and signing boundary. */
export function verifySceneCutEllipsisProof(sources: unknown, shot: unknown, root = process.cwd()) {
  const archive = object(sources), sourceContext = object(archive.sourceContext)
  const expected = deriveSceneCutEllipsisProof({ shot,
    approvedOutline: sourceContext.approvedOutline, previous: sourceContext.previous }, root)
  if (canonical(archive.outlineBinding) !== canonical(expected.outlineBinding)
    || canonical(archive.approvedEllipsis ?? null) !== canonical(expected.approvedEllipsis ?? null))
    invalid('已批准大纲、前镜成片或末帧与冻结来源不一致')
  return expected
}
