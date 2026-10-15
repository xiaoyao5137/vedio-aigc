// A direct visual verdict is separate from the automated storyMediaReview.
// Only its provenance can be checked mechanically; the observations remain an
// explicitly identified reviewer judgement.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import ffmpeg from 'ffmpeg-static'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const root = path.resolve(import.meta.dirname, '..')
const generated = path.join(root, 'public/generated')
const qa = path.join(root, 'qa')
const digest = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw Error(`STORY_SHOT_HUMAN_REVIEW_INVALID: ${message}`) }
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

async function safeFile(base, relative) {
  if (typeof relative !== 'string' || !/^[\w./-]+$/.test(relative) || relative.includes('..')) fail('unsafe evidence path')
  const parent = await realpath(base)
  const file = await realpath(path.join(parent, relative))
  if (!file.startsWith(parent + path.sep) || !(await stat(file)).isFile()) fail('missing or unsafe evidence file')
  return file
}

async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function generatedAsset(url, extension) {
  const name = typeof url === 'string' && /^\/generated\/([\w.-]+)$/.exec(url)?.[1]
  if (!name || !extension.includes(path.extname(name).toLowerCase())) fail('invalid generated asset URL')
  const file = await safeFile(generated, name)
  return { url, file, sha256: await fileHash(file) }
}

export async function loadHumanStoryReview(fileName) {
  const file = await safeFile(qa, typeof fileName === 'string' && fileName.startsWith('qa/')
    ? fileName.slice(3) : fileName)
  if ((await stat(file)).size > 128 * 1024) fail('review file exceeds 128 KiB')
  const bytes = await readFile(file)
  let report
  try { report = JSON.parse(bytes.toString('utf8')) } catch { fail('review JSON cannot be parsed') }
  return { report, file: path.relative(root, file), sha256: digest(bytes) }
}

function frameAt(report, second) {
  return report.frames.find(frame => frame.second === second)
}

/** Fail closed on identities, planned actions and every quoted sample. */
export function validateHumanStoryReview(report, source, media, reportSha256) {
  const hash = createJsonHasher()
  const state = source.result
  const runs = state?.nodeRuns
  const shot = runs?.[2]?.output?.shots?.[0]
  const image = runs?.[4]?.output
  const video = runs?.[5]?.output
  const review = video?.storyMediaReview
  if (!object(report) || report.version !== 'story-shot-direct-visual-review-v1'
    || report.reviewMethod !== 'agent-direct-visual' || report.verdict !== 'pass'
    || !['moderate', 'high'].includes(report.confidence)
    || !Number.isFinite(Date.parse(report.reviewedAt)) || report.reviewer !== 'Codex'
    || !Array.isArray(report.limitations) || !report.limitations.length
    || report.limitations.some(value => typeof value !== 'string' || value.length < 15)) fail('review identity, verdict or limitations are invalid')
  if (runs?.[5]?.status !== 'failed' || review?.reviewStatus !== 'uncertain' || review.passed !== false
    || review.retryable !== false || review.videoEvidence?.decoded !== true
    || review.videoEvidence?.sha256 !== media.videoSha256 || review.videoEvidence?.url !== video?.url
    || report.sourceRecordId !== source.id || report.sourceResultMd5 !== source.result_md5
    || report.sourceReviewStatus !== 'uncertain' || report.sourceReviewSha256 !== hash(review)
    || report.sourceVideoOutputSha256 !== hash(video)
    || report.sourceScriptOutputSha256 !== hash(runs[2].output)
    || report.sourceShotSha256 !== hash(shot)
    || report.firstFrame?.url !== image?.url || report.firstFrame?.sha256 !== media.imageSha256
    || report.video?.url !== video?.url || report.video?.sha256 !== media.videoSha256
    || report.video?.durationSeconds !== review.videoEvidence.duration
    || report.video?.durationSeconds < shot?.duration || report.video?.durationSeconds > shot.duration + .25
    || !sha(reportSha256)) fail('review does not bind the uncertain source, script and exact media')
  const recovery = state.storyAudioReviewRecovery
  const audio = video.audioLevelRemediation
  if (recovery?.derivativeVideoSha256 !== media.videoSha256
    || video.sameMediaReviewRetry?.sourceVideoSha256 !== media.videoSha256
    || audio?.outputSha256 !== media.videoSha256 || audio.manifestSha256 !== recovery.manifestSha256
    || report.audioLevelManifest?.url !== recovery.manifestUrl
    || report.audioLevelManifest?.sha256 !== recovery.manifestSha256
    || report.audioLevelManifest?.sourceVideoSha256 !== recovery.sourceVideoSha256
    || report.audioLevelManifest?.sameDecodedVideoFramesSha256 !== recovery.sameDecodedVideoFramesSha256) {
    fail('audio-only derivative provenance is missing or changed')
  }
  const beats = shot.visualBeats
  if (!Array.isArray(report.frames) || report.frames.length < 10
    || !Array.isArray(report.beatChecks) || report.beatChecks.length !== beats.length
    || !report.frames.every((frame, index) => object(frame)
      && Number.isFinite(frame.second) && frame.second >= 0 && frame.second < report.video.durationSeconds
      && (index === 0 || frame.second > report.frames[index - 1].second)
      && /^story-shot1-endframe-local-qa-v2\/[\w./-]+\.jpg$/.test(frame.file)
      && !frame.file.includes('..') && sha(frame.sha256)
      && typeof frame.observation === 'string' && frame.observation.length >= 16)) fail('visual frames are incomplete or out of order')
  for (const second of [0, 1.5, 2.5, 3.5, 4, 4.5, 5.5, 6, 7, 7.5, 7.96]) {
    if (!frameAt(report, second)) fail(`required action or hold frame at ${second}s is missing`)
  }
  for (const [index, beat] of beats.entries()) {
    const check = report.beatChecks[index]
    const start = frameAt(report, check?.startSecond)
    const end = frameAt(report, check?.completionSecond)
    if (!object(check) || check.id !== beat.id || check.action !== beat.action
      || check.requiredCompletion !== beat.completion || check.status !== 'complete'
      || !['moderate', 'high'].includes(check.confidence)
      || !start || !end || start.second >= end.second
      || start.second < beat.startSecond || end.second > beat.endSecond + .05
      || check.startFrameSha256 !== start.sha256 || check.completionFrameSha256 !== end.sha256
      || typeof check.observation !== 'string' || check.observation.length < 24) fail(`beat ${beat.id} lacks bound before/after visual evidence`)
  }
  const hold = report.endingHold
  const first = frameAt(report, hold?.startSecond), last = frameAt(report, hold?.endSecond)
  if (!object(hold) || hold.status !== 'complete' || !['moderate', 'high'].includes(hold.confidence)
    || !first || !last || first.second !== beats.at(-1).endSecond || last.second - first.second < .8
    || report.video.durationSeconds - last.second > .1
    || hold.firstFrameSha256 !== first.sha256 || hold.lastFrameSha256 !== last.sha256
    || typeof hold.observation !== 'string' || hold.observation.length < 24) fail('ending hold lacks bound duration and actual final frame')
  return { version: report.version, verdict: report.verdict, reviewMethod: report.reviewMethod,
    reviewer: report.reviewer, reviewedAt: report.reviewedAt, confidence: report.confidence,
    evidenceFileSha256: reportSha256, sourceRecordId: source.id, sourceResultMd5: source.result_md5,
    sourceReviewStatus: report.sourceReviewStatus,
    sourceReviewSha256: report.sourceReviewSha256, sourceVideoOutputSha256: report.sourceVideoOutputSha256,
    sourceScriptOutputSha256: report.sourceScriptOutputSha256, sourceShotSha256: report.sourceShotSha256,
    firstFrame: report.firstFrame, video: report.video,
    audioLevelManifest: report.audioLevelManifest,
    frames: report.frames, beatChecks: report.beatChecks, endingHold: report.endingHold,
    limitations: report.limitations }
}

function ffmpegFrame(videoFile, second, outputFile) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) return reject(Error('ffmpeg-static unavailable'))
    const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(second), '-i', videoFile,
      '-frames:v', '1', '-q:v', '2', outputFile], { stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk.toString().slice(0, 1024) })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(Error(`ffmpeg frame extraction failed: ${errors.slice(-1000)}`)))
  })
}

/** Re-decode every sampled timestamp from the exact candidate MP4. The report
 * can be prepared ahead of time, but mismatched image bytes cannot pass. */
export async function verifyHumanStoryReviewFrames(review, videoFile) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'story-human-review-'))
  try {
    for (const [index, frame] of review.frames.entries()) {
      const saved = await safeFile(qa, frame.file)
      if (await fileHash(saved) !== frame.sha256) fail(`saved frame at ${frame.second}s changed`)
      const extracted = path.join(temporary, `${index}.jpg`)
      await ffmpegFrame(videoFile, frame.second, extracted)
      if (await fileHash(extracted) !== frame.sha256) fail(`frame at ${frame.second}s is not decoded from the bound video`)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
  return { decodedFrameCount: review.frames.length, decodedFramesVerified: true }
}
