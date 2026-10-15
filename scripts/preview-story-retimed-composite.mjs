#!/usr/bin/env node
// Local, source-bound preview only. No provider request or execution-record write.
// Dry-run is read-only; --apply needs the exact reviewed CAS values printed there.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { link, readFile, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'

const exec = promisify(execFile)
const scriptFile = fileURLToPath(import.meta.url)
const TRIM_SECONDS = 1
const HOLD_SECONDS = 2
const VERSION = 'story-retimed-composite-preview-v2'
const DUCK_V4_MEOW = Object.freeze({ startSecond: 3.6, endSecond: 4.7,
  fadeSeconds: .18, floorGain: .04,
  reason: 'source-v4 ASR estimated unwanted second meow at retimed 3.83–4.47 s; not human-verified' })
const fail = message => { throw Error(`STORY_RETIMED_PREVIEW_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sha256Json = value => sha256(JSON.stringify(value))
const hex64 = value => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)
const hex32 = value => typeof value === 'string' && /^[a-f\d]{32}$/i.test(value)
const localUrl = (value, extension) => typeof value === 'string'
  && new RegExp(`^/generated/[A-Za-z0-9._-]+\\.${extension}$`).test(value)
const localDogWav = value => typeof value === 'string'
  && /^qa\/story-roommates-20260930\/[A-Za-z0-9._-]+\.wav$/.test(value)
const safeError = error => String(error?.message ?? error)
  .replace(/https?:\/\/[^\s"'<>]+/gi, '[remote URL omitted]')
  .replace(/data:[^\s"'<>]+/gi, '[data omitted]').slice(0, 1400)

export function parseArgs(args) {
  const result = { apply: false, dogAt: 3.2, dogGain: .65, duckV4Meow: false }
  const keys = new Set(['source-record', 'video', 'evidence', 'dog-source-record', 'dog-source-video',
    'dog-source-evidence', 'dog-extract-start', 'dog-extract-duration', 'dog-wav', 'dog-at',
    'dog-gain', 'duck-start', 'duck-end', 'duck-fade', 'duck-floor', 'source-end-frame-second',
    'expected-plan-sha256', 'expected-record-md5', 'expected-video-sha256',
    'expected-evidence-sha256', 'expected-image-sha256', 'expected-dog-record-md5',
    'expected-dog-source-video-sha256', 'expected-dog-source-evidence-sha256',
    'expected-dog-wav-sha256'])
  let modeSeen = false
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--help') { result.help = true; continue }
    if (flag === '--duck-v4-meow') {
      if (result.duckV4Meow) fail('duplicate --duck-v4-meow')
      result.duckV4Meow = true; continue
    }
    if (flag === '--dry-run' || flag === '--apply') {
      if (modeSeen) fail('choose one --dry-run or --apply')
      result.apply = flag === '--apply'; modeSeen = true; continue
    }
    const key = flag.startsWith('--') ? flag.slice(2) : ''
    if (!keys.has(key) || result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail(`unknown, missing or duplicate ${flag}`)
    result[key] = args[++i]
  }
  if (result.help) return result
  if (!/^record-[\w-]+$/.test(result['source-record'] ?? '')
    || !localUrl(result.video, 'mp4') || !localUrl(result.evidence, 'json')) fail('require --source-record, --video and --evidence local URLs')
  const dogKeys = ['dog-source-record', 'dog-source-video', 'dog-source-evidence',
    'dog-extract-start', 'dog-extract-duration', 'dog-wav']
  if (dogKeys.some(key => result[key] !== undefined)
    && (!dogKeys.every(key => result[key] !== undefined)
      || !/^record-[\w-]+$/.test(result['dog-source-record'])
      || !localUrl(result['dog-source-video'], 'mp4')
      || !localUrl(result['dog-source-evidence'], 'json')
      || !localDogWav(result['dog-wav']))) fail('dog clip needs a QA WAV, source record, source video/evidence, and exact extract window')
  result.dogExtractStart = Number(result['dog-extract-start'])
  result.dogExtractDuration = Number(result['dog-extract-duration'])
  if (result['dog-wav'] && (!Number.isFinite(result.dogExtractStart)
    || result.dogExtractStart < 0 || !Number.isFinite(result.dogExtractDuration)
    || result.dogExtractDuration < .2 || result.dogExtractDuration > 2)) fail('invalid dog extraction interval')
  if (result.duckV4Meow && !result['dog-wav']) fail('--duck-v4-meow requires a disclosed dog WAV overlay')
  if (!result.duckV4Meow && ['duck-start', 'duck-end', 'duck-fade', 'duck-floor'].some(key => result[key] !== undefined)) fail('duck envelope needs --duck-v4-meow')
  result.dogAt = Number(result['dog-at'] ?? result.dogAt)
  if (!Number.isFinite(result.dogAt) || result.dogAt < 3 || result.dogAt > 5) fail('--dog-at must be 3–5 seconds in the retimed preview')
  result.sourceEndFrameSecond = result['source-end-frame-second'] === undefined
    ? null : Number(result['source-end-frame-second'])
  if (result.sourceEndFrameSecond !== null && (!Number.isFinite(result.sourceEndFrameSecond)
    || result.sourceEndFrameSecond <= TRIM_SECONDS + 4
    || result.sourceEndFrameSecond >= 11.5)) fail('--source-end-frame-second must select a decoded source frame after 5 and before 11.5 seconds')
  result.dogGain = Number(result['dog-gain'] ?? result.dogGain)
  if (!Number.isFinite(result.dogGain) || result.dogGain < .1 || result.dogGain > 5
    || result['dog-gain'] && !result['dog-wav']) fail('--dog-gain must be 0.1–5 and requires a dog WAV')
  if (result.duckV4Meow) {
    result.duck = {
      startSecond: Number(result['duck-start'] ?? DUCK_V4_MEOW.startSecond),
      endSecond: Number(result['duck-end'] ?? DUCK_V4_MEOW.endSecond),
      fadeSeconds: Number(result['duck-fade'] ?? DUCK_V4_MEOW.fadeSeconds),
      floorGain: Number(result['duck-floor'] ?? DUCK_V4_MEOW.floorGain),
      reason: ['duck-start', 'duck-end', 'duck-fade', 'duck-floor'].some(key => result[key] !== undefined)
        ? 'custom local attenuation around the retimed v4 second vocal: ASR estimated 3.83–4.47 s; PCM remained loud through 4.70 s; both need human listening'
        : DUCK_V4_MEOW.reason,
    }
    duckVolumeExpression(result.duck)
    if (result.duck.startSecond < 3 || result.duck.endSecond > 5.5) fail('duck window must be within 3–5.5 seconds')
  }
  const expected = ['expected-plan-sha256', 'expected-record-md5', 'expected-video-sha256',
    'expected-evidence-sha256', 'expected-image-sha256']
  if (result['dog-wav']) expected.push('expected-dog-record-md5', 'expected-dog-source-video-sha256',
    'expected-dog-source-evidence-sha256', 'expected-dog-wav-sha256')
  if (result.apply) {
    for (const key of expected) if (!(key.endsWith('-md5') ? hex32(result[key]) : hex64(result[key]))) fail(`--apply requires ${key} from a reviewed dry run`)
  } else if (expected.some(key => result[key] !== undefined)
    || ['expected-dog-record-md5', 'expected-dog-source-video-sha256',
      'expected-dog-source-evidence-sha256', 'expected-dog-wav-sha256'].some(key => result[key] !== undefined)) fail('CAS values are for --apply only')
  if (!result['dog-wav'] && ['expected-dog-record-md5', 'expected-dog-source-video-sha256',
    'expected-dog-source-evidence-sha256', 'expected-dog-wav-sha256'].some(key => result[key] !== undefined)) fail('dog CAS requires a dog clip')
  return result
}

async function fileSha256(filename) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filename)) digest.update(chunk)
  return digest.digest('hex')
}

async function generatedAsset(url, extension, generated) {
  if (!localUrl(url, extension)) fail(`expected a local ${extension} asset`)
  const filename = await realpath(path.join(generated, path.basename(url)))
  if (!filename.startsWith(generated + path.sep) || !(await stat(filename)).isFile()) fail('missing or unsafe generated asset')
  return { url, filename, sha256: await fileSha256(filename) }
}

async function qaDogAsset(relativePath) {
  if (!localDogWav(relativePath)) fail('dog clip must be a bounded QA WAV')
  const root = await realpath(path.join(process.cwd(), 'qa/story-roommates-20260930'))
  const filename = await realpath(path.join(process.cwd(), relativePath))
  if (!filename.startsWith(root + path.sep) || !(await stat(filename)).isFile()) fail('missing or unsafe QA dog WAV')
  return { path: relativePath, filename, sha256: await fileSha256(filename) }
}

async function command(args, timeout = 120000) {
  if (!ffmpeg) fail('bundled ffmpeg is missing')
  try { return await exec(ffmpeg, args, { timeout, maxBuffer: 16 * 1024 * 1024 }) }
  catch (error) { fail(`ffmpeg failed: ${safeError(error?.stderr || error).slice(-1100)}`) }
}

async function extractedPcmSha256(sourceVideo, startSecond, duration) {
  const { stdout } = await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror',
    '-ss', String(startSecond), '-i', sourceVideo, '-t', String(duration),
    '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  if (stdout.length !== Math.round(duration * 16000) * 2) fail('dog extraction PCM length does not match interval')
  return sha256(stdout)
}

async function wavPcmSha256(wavFile, duration) {
  const { stdout } = await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror',
    '-i', wavFile, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  if (stdout.length !== Math.round(duration * 16000) * 2) fail('dog WAV decoded PCM length does not match interval')
  return sha256(stdout)
}

export function parseFrameMd5(stdout) {
  const match = stdout.match(/^#tb 0:\s*(\d+)\/(\d+)\s*$/m)
  if (!match || !Number(match[2])) fail('frame timebase unavailable')
  const timebase = Number(match[1]) / Number(match[2])
  const frames = stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(line => {
    const parts = line.split(',').map(part => part.trim())
    const pts = Number(parts[2]), hash = parts.at(-1)
    if (!Number.isFinite(pts) || !/^[a-f\d]{32}$/i.test(hash)) fail('invalid decoded frame receipt')
    return { second: pts * timebase, hash }
  })
  if (!frames.length || frames.some((frame, index) => index && frame.second <= frames[index - 1].second)) fail('missing or nonmonotonic decoded frames')
  return frames
}

async function frames(filename) {
  const result = await command(['-hide_banner', '-v', 'error', '-xerror', '-i', filename,
    '-map', '0:v:0', '-f', 'framemd5', '-'], 180000)
  return parseFrameMd5(result.stdout)
}

async function inspect(filename, video) {
  const result = await command(['-hide_banner', '-xerror', '-i', filename,
    ...(video ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:a:0']), '-f', 'null', '-'], 180000)
  const durationPart = result.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
  if (!durationPart) fail('media duration unavailable')
  const duration = Number(durationPart[1]) * 3600 + Number(durationPart[2]) * 60 + Number(durationPart[3])
  if (!Number.isFinite(duration)) fail('invalid media duration')
  if (!video) return { duration }
  const videoLine = result.stderr.split(/\r?\n/).find(line => /Stream #\d+:\d+.*Video:/.test(line))
  const dimensions = videoLine?.match(/\b(\d{2,5})x(\d{2,5})(?:[\s,\[]|$)/)
  const fpsPart = videoLine?.match(/,\s*([\d.]+) fps\b/)
  const width = Number(dimensions?.[1]), height = Number(dimensions?.[2]), fps = Number(fpsPart?.[1])
  if (![width, height, fps].every(Number.isFinite) || fps <= 0
    || !result.stderr.split(/\r?\n/).some(line => /Stream #\d+:\d+.*Audio:/.test(line))) fail('video dimensions, frame rate or audio stream unavailable')
  return { duration, width, height, fps }
}

async function readRecord(id) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const row = (await db.query('SELECT id,workflow_id,md5(result::text) AS result_md5,result FROM execution_records WHERE id=$1', [id])).rows[0]
    await db.query('COMMIT')
    if (!row || row.workflow_id !== 'wf-story') fail('source record unavailable or not wf-story')
    return { id: row.id, md5: row.result_md5, state: decodeExecutionState(row.result) }
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
  finally { await db.end() }
}

function firstShotRuns(record) {
  const runs = record.state.nodeRuns
  if (record.state.id !== record.id || !Array.isArray(runs)) fail('invalid execution state')
  const image = runs.find(run => run.loopIndex === 0 && /^node-image-/.test(run.id))
  const video = runs.find(run => run.loopIndex === 0 && /^node-video-/.test(run.id))
  const review = runs.find(run => run.loopIndex === 0 && /^node-video-review-/.test(run.id))
  if (image?.status !== 'success' || video?.status !== 'success' || !image.output?.url || !video.output?.url) fail('first paid image/video prefix is incomplete')
  return { image, video, review }
}

export function buildPlan(input) {
  const { record, image, video, evidence, dog, dogAt, dogGain = .65,
    duckV4Meow = false, duck = DUCK_V4_MEOW, sourceEndFrameSecond = null } = input
  if (Math.abs(video.duration - 12) > .5 || Math.abs(video.width / video.height - 9 / 16) > .02
    || video.fps < 12 || video.fps > 60 || !Array.isArray(video.frames) || video.frames.length < 100) fail('source is not the expected decoded 12-second 9:16 take')
  if (evidence.duration !== video.duration || evidence.width !== video.width || evidence.height !== video.height
    || evidence.sha256 !== video.sha256 || evidence.url !== video.url || evidence.decoded !== true) fail('review receipt is not bound to source bytes')
  if (dog && (dog.duration < .2 || dog.duration > 2 || dogAt + dog.duration > video.duration - TRIM_SECONDS + HOLD_SECONDS)) fail('dog clip duration/placement is invalid')
  if (dog && (!Number.isFinite(dogGain) || dogGain < .1 || dogGain > 5)) fail('invalid dog overlay gain')
  if (duckV4Meow && (!dog || dogAt < duck.startSecond + duck.fadeSeconds
    || dogAt + dog.duration > duck.endSecond - duck.fadeSeconds)) fail('dog overlay must fit inside the source-audio duck plateau')
  const selectedEndFrame = sourceEndFrameSecond === null ? null
    : video.frames.find(frame => Math.abs(frame.second - sourceEndFrameSecond) < .000001)
  if (sourceEndFrameSecond !== null && (!selectedEndFrame || sourceEndFrameSecond <= TRIM_SECONDS + 4
    || sourceEndFrameSecond >= video.duration - .5)) fail('source end cut must be an existing decoded frame well after the vocal calls')
  const retained = video.frames.filter(frame => frame.second >= TRIM_SECONDS - .000001
    && (sourceEndFrameSecond === null || frame.second <= sourceEndFrameSecond + .000001))
  if (retained.length < 10 || retained.length >= video.frames.length) fail('one-second trim does not select a proper source suffix')
  const targetDuration = Number(((sourceEndFrameSecond === null
    ? video.duration - TRIM_SECONDS : retained.length / video.fps) + HOLD_SECONDS).toFixed(2))
  if (dog && dogAt + dog.duration > targetDuration - HOLD_SECONDS) fail('dog clip cannot extend beyond the retained moving picture')
  const plan = { version: VERSION, purpose: 'unaccepted source-bound preview',
    record: { id: record.id, resultMd5: record.md5, videoRunId: record.videoRunId,
      imageRunId: record.imageRunId, videoOutputSha256: record.videoOutputSha256 },
    source: { videoUrl: video.url, videoSha256: video.sha256, imageUrl: image.url, imageSha256: image.sha256,
      evidenceUrl: evidence.evidenceUrl, evidenceSha256: evidence.receiptSha256,
      duration: video.duration, width: video.width, height: video.height, fps: video.fps,
      decodedFrameCount: video.frames.length, decodedFramesSha256: sha256Json(video.frames.map(frame => frame.hash)) },
    edit: { trimLeadSeconds: TRIM_SECONDS, cloneFinalFrameSeconds: HOLD_SECONDS, targetDuration,
      ...(sourceEndFrameSecond === null ? {} : { sourceEndFrameSecond,
        sourceEndExclusiveSecond: Number((sourceEndFrameSecond + 1 / video.fps).toFixed(9)) }),
      retainedFrameCount: retained.length, retainedFrameHashesSha256: sha256Json(retained.map(frame => frame.hash)) },
    audio: dog ? { mode: 'composite-two-source-candidate', dogSourceRecordId: dog.recordId,
      dogSourceRecordMd5: dog.recordMd5, dogSourceVideoUrl: dog.sourceVideoUrl,
      dogSourceVideoSha256: dog.sourceVideoSha256, dogSourceEvidenceUrl: dog.sourceEvidenceUrl,
      dogSourceEvidenceSha256: dog.sourceEvidenceSha256,
      dogExtractStartSecond: dog.extractStart, dogExtractDurationSecond: dog.extractDuration,
      dogDecodedPcmSha256: dog.pcmSha256, dogWavPath: dog.path, dogWavSha256: dog.sha256,
      dogWavDuration: dog.duration, dogOverlayAtSecond: dogAt,
      ...(dogGain !== .65 ? { dogOverlayGain: dogGain } : {}),
      ...(duckV4Meow ? { nativeSourceAudioDuck: duck } : {}),
      dogSoundSemanticStatus: 'unverified; requires user listening', nativeSourceAudio: 'trimmed and padded' }
      : { mode: 'native-source-only', nativeSourceAudio: 'trimmed and padded', dogSoundSemanticStatus: 'not included' },
    acceptance: { humanAccepted: false, semanticAudioAccepted: false, mediaReviewPassed: false,
      workflowAdvanceAuthorized: false } }
  const planSha256 = sha256Json(plan)
  const stem = `story-retimed-${video.sha256.slice(0, 16)}-${planSha256.slice(0, 16)}`
  return { plan, planSha256, urls: { outputUrl: `/generated/${stem}.mp4`,
    manifestUrl: `/generated/${stem}.json` }, retained }
}

export function assertApplyCas(options, built) {
  const { plan, planSha256 } = built
  const checks = [
    ['expected-plan-sha256', planSha256], ['expected-record-md5', plan.record.resultMd5],
    ['expected-video-sha256', plan.source.videoSha256], ['expected-evidence-sha256', plan.source.evidenceSha256],
    ['expected-image-sha256', plan.source.imageSha256],
  ]
  if (plan.audio.mode === 'composite-two-source-candidate') checks.push(
    ['expected-dog-record-md5', plan.audio.dogSourceRecordMd5],
    ['expected-dog-source-video-sha256', plan.audio.dogSourceVideoSha256],
    ['expected-dog-source-evidence-sha256', plan.audio.dogSourceEvidenceSha256],
    ['expected-dog-wav-sha256', plan.audio.dogWavSha256])
  for (const [key, expected] of checks) if (!expected || options[key]?.toLowerCase() !== expected.toLowerCase()) fail(`${key} changed since dry run`)
}

export function assertVideoFrames(sourceFrames, outputFrames, trimSeconds = TRIM_SECONDS, holdSeconds = HOLD_SECONDS,
  fps = 25, sourceEndFrameSecond = null) {
  const expected = sourceFrames.filter(frame => frame.second >= trimSeconds - .000001
    && (sourceEndFrameSecond === null || frame.second <= sourceEndFrameSecond + .000001)).map(frame => frame.hash)
  if (!expected.length || outputFrames.length <= expected.length) fail('retimed derivative has no complete source suffix and held tail')
  if (expected.some((hash, index) => outputFrames[index].hash !== hash)) fail('derivative changed a retained source frame')
  const clones = outputFrames.slice(expected.length)
  if (clones.some(frame => frame.hash !== expected.at(-1)) || Math.abs(clones.length - holdSeconds * fps) > 2) fail('terminal frames do not clone the source final frame for requested hold')
  return { retainedFrameCount: expected.length, heldFrameCount: clones.length,
    retainedFramesSha256: sha256Json(expected), outputFramesSha256: sha256Json(outputFrames.map(frame => frame.hash)),
    everyRetainedDecodedFrameMatched: true, everyHeldFrameMatchesSourceLast: true }
}

export async function renderDerivative({ sourceFile, dogFile, outputFile, targetDuration, dogAt = 3.2,
  dogGain = .65, trimSeconds = TRIM_SECONDS, holdSeconds = HOLD_SECONDS, duck = null,
  sourceEndExclusiveSecond = null }) {
  const endPart = sourceEndExclusiveSecond === null ? '' : `:end=${sourceEndExclusiveSecond}`
  const videoFilter = `[0:v]trim=start=${trimSeconds}${endPart},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${holdSeconds}[v]`
  const duckFilter = duck ? `,volume='${duckVolumeExpression(duck)}':eval=frame` : ''
  const baseAudio = `[0:a]atrim=start=${trimSeconds}${endPart},asetpts=PTS-STARTPTS,apad=pad_dur=${holdSeconds},atrim=duration=${targetDuration}${duckFilter}`
  const audioFilter = dogFile
    ? `${baseAudio},aresample=48000,aformat=channel_layouts=stereo,volume=0.75[base];`+
      `[1:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(dogAt * 1000)}:all=1,volume=${dogGain}[dog];`+
      `[base][dog]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.89,atrim=duration=${targetDuration}[a]`
    : `${baseAudio}[a]`
  await command(['-hide_banner', '-v', 'error', '-xerror', '-n', '-i', sourceFile,
    ...(dogFile ? ['-i', dogFile] : []), '-filter_complex', `${videoFilter};${audioFilter}`,
    '-map', '[v]', '-map', '[a]', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'medium',
    '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputFile], 300000)
}

export function duckVolumeExpression(duck) {
  const { startSecond: start, endSecond: end, fadeSeconds: fade, floorGain: floor } = duck
  if (![start, end, fade, floor].every(Number.isFinite) || start < 0 || fade <= 0
    || end - start <= 2 * fade || floor <= 0 || floor >= 1) fail('invalid source-audio duck envelope')
  const inEnd = Number((start + fade).toFixed(3)), outStart = Number((end - fade).toFixed(3))
  return `if(lt(t,${start}),1,if(lt(t,${inEnd}),1-(1-${floor})*(t-${start})/${fade},if(lt(t,${outStart}),${floor},if(lt(t,${end}),${floor}+(1-${floor})*(t-${outStart})/${fade},1))))`
}

async function makeContext(options) {
  const generated = await realpath(path.join(process.cwd(), 'public/generated'))
  const record = await readRecord(options['source-record'])
  const { image, video, review } = firstShotRuns(record)
  const imageAsset = await generatedAsset(image.output.url, 'png', generated)
  const videoAsset = await generatedAsset(options.video, 'mp4', generated)
  const evidenceAsset = await generatedAsset(options.evidence, 'json', generated)
  const evidence = JSON.parse(await readFile(evidenceAsset.filename, 'utf8'))
  if (evidence.url !== options.video || evidence.sha256 !== videoAsset.sha256
    || evidence.originalUrl !== video.output.url || evidence.evidenceRequest?.url !== video.output.url
    || evidence.evidenceUrl !== options.evidence) fail('local video/evidence does not bind to the first paid video run')
  if (review?.output?.storyMediaReview?.videoEvidence
    && (review.output.storyMediaReview.videoEvidence.sha256 !== videoAsset.sha256
      || review.output.storyMediaReview.videoEvidence.url !== options.video)) fail('saved review points to different video bytes')
  const meta = await inspect(videoAsset.filename, true)
  const sourceFrames = await frames(videoAsset.filename)
  let dog
  if (options['dog-wav']) {
    const dogRecord = await readRecord(options['dog-source-record'])
    const dogRuns = firstShotRuns(dogRecord)
    const videoAsset = await generatedAsset(options['dog-source-video'], 'mp4', generated)
    const evidenceAsset = await generatedAsset(options['dog-source-evidence'], 'json', generated)
    const evidence = JSON.parse(await readFile(evidenceAsset.filename, 'utf8'))
    if (evidence.url !== options['dog-source-video'] || evidence.sha256 !== videoAsset.sha256
      || evidence.originalUrl !== dogRuns.video.output.url
      || evidence.evidenceRequest?.url !== dogRuns.video.output.url
      || evidence.evidenceUrl !== options['dog-source-evidence'] || evidence.decoded !== true) fail('dog source video/evidence does not bind to its first paid video run')
    if (dogRuns.review?.output?.storyMediaReview?.videoEvidence
      && (dogRuns.review.output.storyMediaReview.videoEvidence.sha256 !== videoAsset.sha256
        || dogRuns.review.output.storyMediaReview.videoEvidence.url !== options['dog-source-video'])) fail('dog saved review points to different source video bytes')
    const asset = await qaDogAsset(options['dog-wav'])
    const meta = await inspect(asset.filename, false)
    if (Math.abs(meta.duration - options.dogExtractDuration) > .02) fail('dog WAV duration differs from extraction interval')
    const [expectedPcmSha256, candidatePcmSha256] = await Promise.all([
      extractedPcmSha256(videoAsset.filename, options.dogExtractStart, options.dogExtractDuration),
      wavPcmSha256(asset.filename, options.dogExtractDuration),
    ])
    if (expectedPcmSha256 !== candidatePcmSha256) fail('dog WAV PCM differs from exact source video extraction')
    dog = { recordId: dogRecord.id, recordMd5: dogRecord.md5, ...asset,
      duration: meta.duration, sourceVideoUrl: videoAsset.url, sourceVideoSha256: videoAsset.sha256,
      sourceEvidenceUrl: evidenceAsset.url, sourceEvidenceSha256: evidenceAsset.sha256,
      sourceVideoFile: videoAsset.filename, sourceEvidenceFile: evidenceAsset.filename,
      extractStart: options.dogExtractStart, extractDuration: options.dogExtractDuration,
      pcmSha256: candidatePcmSha256 }
  }
  const built = buildPlan({ record: { id: record.id, md5: record.md5,
    videoRunId: video.id, imageRunId: image.id, videoOutputSha256: sha256Json(video.output) },
  image: imageAsset, video: { ...videoAsset, ...meta, frames: sourceFrames },
  evidence: { ...evidence, receiptSha256: evidenceAsset.sha256 }, dog, dogAt: options.dogAt,
  dogGain: options.dogGain, duckV4Meow: options.duckV4Meow, duck: options.duck,
  sourceEndFrameSecond: options.sourceEndFrameSecond })
  return { generated, record, imageAsset, videoAsset, evidenceAsset, dog, sourceFrames, built }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/preview-story-retimed-composite.mjs --source-record RECORD --video /generated/ARCHIVE.mp4 --evidence /generated/EVIDENCE.json [--dog-source-record OLD_RECORD --dog-source-video /generated/OLD.mp4 --dog-source-evidence /generated/OLD-EVIDENCE.json --dog-extract-start 7 --dog-extract-duration 1.5 --dog-wav qa/story-roommates-20260930/DOG.wav --dog-at 3.65] [--duck-v4-meow --duck-start 3.5 --duck-end 5.3 --duck-fade 0.12 --duck-floor 0.01] [--source-end-frame-second 9] [--dry-run]\nDry-run writes nothing. The QA dog WAV must decode bit-identically to the stated source-video extraction. --source-end-frame-second selects an exact decoded frame then clones it for two seconds. --duck-v4-meow crossfades a local duck over the unwanted source call and requires the dog overlay inside its quiet plateau. --apply needs exact dry-run CAS values, and creates only a separate unaccepted MP4 and manifest; no DB/provider call.')
    return
  }
  const context = await makeContext(options)
  const { plan, planSha256, urls } = context.built
  if (!options.apply) {
    console.log(JSON.stringify({ mode: 'dry-run', planSha256, plan, ...urls,
      modelCalls: 0, databaseWrites: 0, mediaWrites: 0 }, null, 2))
    return
  }
  assertApplyCas(options, context.built)
  const outputFile = path.join(context.generated, path.basename(urls.outputUrl))
  const manifestFile = path.join(context.generated, path.basename(urls.manifestUrl))
  if (await stat(outputFile).catch(() => null) || await stat(manifestFile).catch(() => null)) fail('separate output or manifest already exists; refusing overwrite')
  const temporary = path.join(context.generated, `.${path.basename(urls.outputUrl)}.${randomUUID()}.tmp.mp4`)
  try {
    await renderDerivative({ sourceFile: context.videoAsset.filename, dogFile: context.dog?.filename,
      outputFile: temporary, targetDuration: plan.edit.targetDuration, dogAt: options.dogAt,
      dogGain: options.dogGain, duck: plan.audio.nativeSourceAudioDuck ?? null,
      sourceEndExclusiveSecond: plan.edit.sourceEndExclusiveSecond ?? null })
    const [meta, outputFrames] = await Promise.all([inspect(temporary, true), frames(temporary)])
    if (meta.width !== plan.source.width || meta.height !== plan.source.height
      || Math.abs(meta.duration - plan.edit.targetDuration) > .15) fail('derivative size or duration differs from plan')
    const frameProof = assertVideoFrames(context.sourceFrames, outputFrames, TRIM_SECONDS, HOLD_SECONDS,
      plan.source.fps, plan.edit.sourceEndFrameSecond ?? null)
    const [sourceAfter, imageAfter, evidenceAfter, dogAfter, dogVideoAfter, dogEvidenceAfter, recordAfter] = await Promise.all([
      fileSha256(context.videoAsset.filename), fileSha256(context.imageAsset.filename),
      fileSha256(context.evidenceAsset.filename), context.dog ? fileSha256(context.dog.filename) : Promise.resolve(null),
      context.dog ? fileSha256(context.dog.sourceVideoFile) : Promise.resolve(null),
      context.dog ? fileSha256(context.dog.sourceEvidenceFile) : Promise.resolve(null),
      readRecord(context.record.id) ])
    if (sourceAfter !== plan.source.videoSha256 || imageAfter !== plan.source.imageSha256
      || evidenceAfter !== plan.source.evidenceSha256 || dogAfter !== (context.dog?.sha256 ?? null)
      || dogVideoAfter !== (context.dog?.sourceVideoSha256 ?? null)
      || dogEvidenceAfter !== (context.dog?.sourceEvidenceSha256 ?? null)
      || recordAfter.md5 !== plan.record.resultMd5
      || context.dog && (await readRecord(context.dog.recordId)).md5 !== context.dog.recordMd5) fail('source or execution record changed during derivative render')
    const outputSha256 = await fileSha256(temporary)
    const manifest = { ...plan, planSha256, outputUrl: urls.outputUrl, outputSha256,
      outputDuration: meta.duration, outputWidth: meta.width, outputHeight: meta.height,
      outputVideoCodec: 'lossless H.264 reencode of retained source frames plus cloned last frame',
      outputAudioPolicy: context.dog ? `trimmed original audio${plan.audio.nativeSourceAudioDuck ? ' with a crossfaded local duck of an ASR-estimated unwanted vocal window' : ''} plus unverified dog WAV from a different paid take; post-production composite`
        : 'trimmed original audio with padded silence; no cross-take audio',
      frameProof, provenance: { paidVideoAndImageUntouched: true, originalExecutionUntouched: true,
        derivativeOnly: true, accepted: false, requiresHumanAudioListening: true,
        requiresFreshVisualAndMediaReview: true } }
    await link(temporary, outputFile)
    const manifestTemporary = `${manifestFile}.${randomUUID()}.tmp`
    try {
      await import('node:fs/promises').then(fs => fs.writeFile(manifestTemporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }))
      await link(manifestTemporary, manifestFile)
    } finally { await rm(manifestTemporary, { force: true }) }
    console.log(JSON.stringify({ mode: 'applied-unaccepted-preview', outputUrl: urls.outputUrl,
      outputSha256, manifestUrl: urls.manifestUrl, manifestSha256: await fileSha256(manifestFile),
      planSha256, frameProof, humanAccepted: false, semanticAudioAccepted: false,
      modelCalls: 0, databaseWrites: 0 }, null, 2))
  } finally { await rm(temporary, { force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1 })
}
