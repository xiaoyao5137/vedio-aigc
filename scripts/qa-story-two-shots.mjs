#!/usr/bin/env node
// Read a completed wf-story record, sample its LOCAL saved clips, and create a
// contact sheet plus a compact evidence report. No model/provider calls or DB
// writes. This deliberately differs from the Sanguo native-frame QA script.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { storyShotIdentity } from '../src/story-same-media-retry.ts'
import { renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { storyReviewSampleTimes, validateStoryShotAssessment } from '../server/story-media-review.ts'
import { parseFfmpegMetadata, validateVideoMetadata } from '../server/video-inspection.ts'

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mediaRoot = path.join(root, 'public/generated')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw Error(`STORY_TWO_SHOT_QA_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function parseArguments(args) {
  const options = { allowFailed: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help') return { help: true }
    if (flag === '--allow-failed') { if (options.allowFailed) fail('duplicate --allow-failed'); options.allowFailed = true; continue }
    const key = { '--record': 'recordId', '--out': 'outputDirectory', '--shot': 'shotNumber' }[flag]
    if (!key || options[key] || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (!/^record-[\w-]+$/.test(options.recordId ?? '') || !options.outputDirectory) {
    fail('usage: node scripts/qa-story-two-shots.mjs --record record-ID --out FRESH_QA_DIRECTORY [--shot 1|2 --allow-failed]')
  }
  if (options.shotNumber && !['1', '2'].includes(options.shotNumber)) fail('--shot must be 1 or 2')
  if (options.allowFailed && !options.shotNumber) fail('--allow-failed requires --shot to scope the saved rejected take')
  return options
}

async function generatedFile(url, extensions) {
  const filename = typeof url === 'string' ? url.match(/^\/generated\/([\w.-]+)$/)?.[1] : undefined
  if (!filename || !extensions.includes(path.extname(filename).toLowerCase())) fail(`invalid generated media URL ${String(url)}`)
  const base = await realpath(mediaRoot)
  const file = await realpath(path.join(base, filename))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail(`generated media missing or unsafe: ${url}`)
  return file
}

async function checkedImage(url) {
  const file = await generatedFile(url, ['.png', '.jpg', '.jpeg', '.webp'])
  const bytes = await readFile(file)
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 })
  const metadata = await image.metadata()
  await image.raw().toBuffer()
  if (!metadata.width || !metadata.height) fail(`image has no dimensions: ${url}`)
  return { url, file, sha256: sha256(bytes), bytes: bytes.length,
    width: metadata.width, height: metadata.height, format: metadata.format }
}

/** Selection is strict: the latest in-scope run must be successful. An older
 * success cannot hide a later failed take or incomplete paid retry. */
export function selectStoryTwoShotQaInputs(state, options = {}) {
  if (!object(state) || state.workflowId !== 'wf-story' || !Array.isArray(state.nodeRuns)) fail('record is not a wf-story execution')
  const runs = state.nodeRuns
  const scriptAt = runs.findLastIndex(run => run.node?.id === 'node-script')
  const script = runs[scriptAt]
  if (!script || script.status !== 'success') fail('successful source script is missing')
  validateStoryShotTimingOutput(script.output, { expectedCount: 2 })
  const shots = script.output.shots
  const indexes = options.shotNumber ? [Number(options.shotNumber) - 1] : [0, 1]
  const result = indexes.map(loopIndex => {
    const shot = shots[loopIndex]
    const imageAt = runs.findLastIndex(run => run.node?.id === 'node-image' && run.loopIndex === loopIndex)
    const videoAt = runs.findLastIndex(run => run.node?.id === 'node-video' && run.loopIndex === loopIndex)
    const image = runs[imageAt], video = runs[videoAt]
    if (!image || !video || image.status !== 'success'
      || !(video.status === 'success' || options.allowFailed && video.status === 'failed')
      || scriptAt >= imageAt || imageAt >= videoAt) {
      fail(`shot ${loopIndex + 1} has no latest inspectable image-then-video pair`)
    }
    if (!image.loopGroupId || image.loopGroupId !== video.loopGroupId
      || typeof image.node.modelId !== 'string' || !image.node.modelId
      || typeof video.node.modelId !== 'string' || !video.node.modelId
      || image.output?.model !== image.node.modelId
      || video.output?.model !== video.node.modelId) fail(`shot ${loopIndex + 1} model or loop binding changed`)
    if (storyShotIdentity(image.loopItem) !== storyShotIdentity(shot)
      || storyShotIdentity(video.loopItem) !== storyShotIdentity(shot)
      || storyShotIdentity(image.inputContext?.shot) !== storyShotIdentity(shot)
      || storyShotIdentity(video.inputContext?.shot) !== storyShotIdentity(shot)) fail(`shot ${loopIndex + 1} is bound to a stale script`)
    const referenceUrl = typeof video.output?.params?.referenceImage === 'string'
      ? video.output.params.referenceImage : video.output?.params?.referenceImage?.url
    if (!video.output?.prompt?.includes(renderStoryShotTimedActions(shot))
      || Number(video.output?.params?.duration) !== shot.duration
      || referenceUrl !== image.output?.url) fail(`shot ${loopIndex + 1} provider request differs from the approved script/first frame`)
    const review = video.output?.storyMediaReview
    const evidence = review?.videoEvidence
    if (!object(review) || !object(evidence) || evidence.decoded !== true || !Array.isArray(evidence.frames)
      || !Array.isArray(evidence.frameTimes) || evidence.frames.length !== evidence.frameTimes.length
      || evidence.frames.length < 4 || evidence.url !== video.output.url
      || video.output.videoEvidence?.sha256 !== evidence.sha256) fail(`shot ${loopIndex + 1} has no complete saved media evidence`)
    if (!options.allowFailed || video.status === 'success') {
      if (review.passed !== true || review.reviewStatus !== 'passed' || review.retryable !== false) {
        fail(`shot ${loopIndex + 1} has no passing saved media review`)
      }
      const checked = validateStoryShotAssessment(shot, evidence, review.observations, review.assessment)
      if (!checked.passed || checked.reviewStatus !== 'passed'
        || checked.beatChecks.length !== review.beatChecks?.length
        || checked.beatChecks.some((beat, index) => beat.id !== review.beatChecks[index]?.id || beat.status !== review.beatChecks[index]?.status)) {
        fail(`shot ${loopIndex + 1} saved semantic review cannot be reproduced from its frame observations`)
      }
    }
    return { number: loopIndex + 1, shot, image, video, review, evidence }
  })
  if (result.length === 2 && result[0].image.loopGroupId !== result[1].image.loopGroupId) fail('two shots are not consecutive rounds of the same loop')
  return result
}

async function readSavedEvidence(evidence) {
  const file = await generatedFile(evidence.evidenceUrl, ['.json'])
  const report = JSON.parse(await readFile(file, 'utf8'))
  if (report.sha256 !== evidence.sha256 || report.url !== evidence.url
    || JSON.stringify(report.frames) !== JSON.stringify(evidence.frames)
    || JSON.stringify(report.frameTimes) !== JSON.stringify(evidence.frameTimes)) fail('saved evidence JSON differs from the reviewed clip')
  return { file, report }
}

async function ffmpegRun(args, timeout = 180_000) {
  if (!ffmpeg) fail('ffmpeg-static is unavailable')
  try { return await exec(ffmpeg, ['-hide_banner', '-nostdin', '-xerror', ...args], { timeout, maxBuffer: 12 * 1024 * 1024 }) }
  catch (error) { fail(`ffmpeg failed: ${String(error.stderr ?? error.message ?? error).slice(-1200)}`) }
}

async function pixelDifference(left, right) {
  const pixels = file => sharp(file).resize(144, 256, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  const [a, b] = await Promise.all([pixels(left), pixels(right)])
  if (a.length !== b.length) fail('comparison frames have incompatible pixels')
  return Number((a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / (a.length * 255)).toFixed(5))
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character])
}

async function contactSheet(frames, destination, columns = 7) {
  const tileWidth = 192, tileHeight = 342, labelHeight = 34
  const cells = await Promise.all(frames.map(async (frame, index) => {
    const label = `镜 ${frame.shot} · ${frame.second.toFixed(2)} 秒${frame.tag ? ` · ${frame.tag}` : ''}`
    const picture = await sharp(frame.file).resize(tileWidth, tileHeight, { fit: 'contain', background: '#111' })
      .extend({ bottom: labelHeight, background: '#f7f3eb' })
      .composite([{ input: Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}"><text x="5" y="22" font-size="12" font-family="Arial,sans-serif" fill="#222">${xml(label)}</text></svg>`), left: 0, top: tileHeight }])
      .jpeg({ quality: 88 }).toBuffer()
    return { input: picture, left: index % columns * tileWidth,
      top: Math.floor(index / columns) * (tileHeight + labelHeight) }
  }))
  const width = Math.min(columns, frames.length) * tileWidth
  const height = Math.ceil(frames.length / columns) * (tileHeight + labelHeight)
  await sharp({ create: { width, height, channels: 3, background: '#f7f3eb' } }).composite(cells).jpeg({ quality: 92 }).toFile(destination)
  return destination
}

async function inspectShot(input, outputDirectory) {
  const { number, shot, image, video, review, evidence } = input
  const clipFile = await generatedFile(video.output.url, ['.mp4', '.mov', '.webm'])
  const clipBytes = await readFile(clipFile)
  const clipSha256 = sha256(clipBytes)
  if (clipSha256 !== evidence.sha256) fail(`shot ${number} saved video bytes do not match the review SHA256`)
  const saved = await readSavedEvidence(evidence)
  const { stderr } = await ffmpegRun(['-i', clipFile, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'])
  const media = validateVideoMetadata(parseFfmpegMetadata(stderr), shot.duration, '9:16', false)
  if (evidence.hasAudio !== true || Math.abs(media.duration - evidence.duration) > .08
    || media.width !== evidence.width || media.height !== evidence.height) fail(`shot ${number} saved metadata differs from decoded media`)
  const volume = media.hasAudio ? await ffmpegRun(['-i', clipFile, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], 60_000) : undefined
  const meanVolumeDb = Number(volume?.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] ?? '-Infinity')
  const audioPassed = media.hasAudio && Number.isFinite(meanVolumeDb) && meanVolumeDb >= -50
  const sourceImage = await checkedImage(image.output.url)
  const targetImage = typeof video.output.params?.endImage === 'string' && video.output.params.endImage
    ? await checkedImage(video.output.params.endImage) : null
  const frameDirectory = path.join(outputDirectory, `shot-${number}`)
  await mkdir(frameDirectory)
  const frames = []
  const plannedTimes = storyReviewSampleTimes(shot)
  const tailTime = Number((media.duration - .08).toFixed(3))
  const sampleTimes = [...new Set([0, ...plannedTimes, tailTime])].sort((a, b) => a - b)
  for (const [index, second] of sampleTimes.entries()) {
    if (typeof second !== 'number' || !Number.isFinite(second) || second < 0 || index > 0 && second <= sampleTimes[index - 1]) {
      fail(`shot ${number} evidence frame times are invalid`)
    }
    const filename = path.join(frameDirectory, `sample-${String(index).padStart(2, '0')}.jpg`)
    await ffmpegRun(['-v', 'error', '-ss', String(second), '-i', clipFile, '-frames:v', '1', '-q:v', '2', filename], 30_000)
    const savedIndex = evidence.frameTimes.findIndex(time => Math.abs(time - second) < .001)
    const actual = savedIndex >= 0 ? await checkedImage(evidence.frames[savedIndex]) : null
    const difference = actual ? await pixelDifference(filename, actual.file) : null
    if (difference !== null && difference > .06) fail(`shot ${number} fresh frame at ${second}s differs from the saved review frame (${difference})`)
    frames.push({ shot: number, index, second, file: filename, sha256: sha256(await readFile(filename)),
      savedEvidenceFrameUrl: actual?.url ?? null, savedEvidenceFrameSha256: actual?.sha256 ?? null,
      freshVsSavedPixelDifference: difference })
  }
  const first = frames[0], last = frames.at(-1)
  if (first.second !== 0 || last.second < media.duration - .25) fail(`shot ${number} first or tail frame is missing`)
  if (sha256(await readFile(clipFile)) !== clipSha256
    || (await checkedImage(sourceImage.url)).sha256 !== sourceImage.sha256
    || targetImage && (await checkedImage(targetImage.url)).sha256 !== targetImage.sha256) {
    fail(`shot ${number} source media changed during local QA`)
  }
  const openingReferenceDifference = await pixelDifference(first.file, sourceImage.file)
  const targetEndFrameDifference = targetImage ? await pixelDifference(last.file, targetImage.file) : null
  const shotSheet = await contactSheet(frames, path.join(outputDirectory, `shot-${number}-contact.jpg`), Math.min(7, frames.length))
  return { number, title: shot.title, plannedDuration: shot.duration, actualDuration: media.duration,
    width: media.width, height: media.height, hasAudio: media.hasAudio, meanVolumeDb, audioPassed,
    technicalPassed: audioPassed,
    videoUrl: video.output.url, videoFile: clipFile, videoSha256: clipSha256,
    firstFrameImage: { url: sourceImage.url, sha256: sourceImage.sha256,
      width: sourceImage.width, height: sourceImage.height },
    targetEndFrameImage: targetImage ? { url: targetImage.url, sha256: targetImage.sha256,
      width: targetImage.width, height: targetImage.height } : null,
    savedEvidenceUrl: evidence.evidenceUrl, savedEvidenceFile: saved.file,
    savedReview: { status: review.reviewStatus, passed: review.passed,
      beatStatuses: Array.isArray(review.beatChecks) ? review.beatChecks.map(beat => ({ id: beat.id, status: beat.status })) : [],
      endingHold: review.endingHold?.status },
    openingReferencePixelDifference: openingReferenceDifference,
    targetEndFramePixelDifference: targetEndFrameDifference,
    actualFirstFrame: first, actualTailFrame: last,
    frames, contactSheet: shotSheet }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/qa-story-two-shots.mjs --record record-ID --out FRESH_QA_DIRECTORY [--shot 1|2 --allow-failed]\nDefault requires two successful, reviewed shots. --allow-failed only samples one saved rejected take and reports failed gates.')
    return
  }
  const out = path.resolve(options.outputDirectory)
  const mediaBase = await realpath(mediaRoot)
  const relative = path.relative(mediaBase, out)
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    fail('QA output directory must be outside public/generated')
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  let row
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    row = (await db.query('SELECT id,workflow_id,md5(result::text) AS result_md5,result FROM execution_records WHERE id=$1', [options.recordId])).rows[0]
    await db.query('COMMIT')
  } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error }
  finally { await db.end() }
  if (!row || row.workflow_id !== 'wf-story') fail('execution record is missing or belongs to another workflow')
  const selected = selectStoryTwoShotQaInputs(decodeExecutionState(row.result), options)
  await mkdir(out, { recursive: true })
  if ((await readdir(out)).length) fail('QA directory must be fresh and empty')
  const shots = []
  for (const input of selected) shots.push(await inspectShot(input, out))
  const combined = await contactSheet(shots.flatMap(shot => shot.frames), path.join(out, 'two-shot-contact.jpg'),
    Math.max(...shots.map(shot => shot.frames.length)))
  const boundaryFrames = shots.flatMap(shot => [
    { ...shot.actualFirstFrame, shot: shot.number, tag: '开场' },
    { ...shot.actualTailFrame, shot: shot.number, tag: '结尾' },
  ])
  const boundary = await contactSheet(boundaryFrames, path.join(out, 'first-tail-boundary.jpg'), boundaryFrames.length)
  const technicalPassed = shots.every(shot => shot.technicalPassed)
  const savedReviewPassed = shots.every(shot => shot.savedReview.passed && shot.savedReview.status === 'passed')
  const verificationDb = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await verificationDb.connect()
  try {
    const verified = (await verificationDb.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [options.recordId])).rows[0]
    if (verified?.result_md5 !== row.result_md5) fail('source execution record changed during local QA')
  } finally { await verificationDb.end() }
  const report = { version: 'wf-story-two-shot-local-qa-v1', recordId: options.recordId, sourceResultMd5: row.result_md5,
    databaseReadOnly: true, sourceRecordUnchanged: true, modelCalls: 0, providerCalls: 0, sourceMediaChanged: false,
    requestedShotCount: shots.length, allowFailed: options.allowFailed,
    technicalPassed, savedReviewPassed, humanVisualReview: 'pending',
    contactSheet: combined, firstTailBoundarySheet: boundary,
    shots: shots.map(shot => ({ ...shot, frames: shot.frames.map(frame => ({ ...frame, file: path.relative(out, frame.file) })),
      actualFirstFrame: { ...shot.actualFirstFrame, file: path.relative(out, shot.actualFirstFrame.file) },
      actualTailFrame: { ...shot.actualTailFrame, file: path.relative(out, shot.actualTailFrame.file) },
      contactSheet: path.relative(out, shot.contactSheet) })) }
  const reportFile = path.join(out, 'qa.json')
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ reportFile, contactSheet: combined, firstTailBoundarySheet: boundary,
    videos: shots.map(shot => ({ title: shot.title, duration: shot.actualDuration,
      meanVolumeDb: shot.meanVolumeDb, sha256: shot.videoSha256 })),
    technicalPassed, savedReviewPassed, humanVisualReview: 'pending' }, null, 2))
  if (!technicalPassed || !savedReviewPassed) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
