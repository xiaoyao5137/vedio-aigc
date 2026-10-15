#!/usr/bin/env node
// Read-only audit of the first two wf-story loop rounds. It reads the saved
// execution and source media, temporarily downloads remote videos for decoding,
// and never resumes a workflow, calls a model, or changes saved records/media.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { validateStoryShotAssessment } from '../server/story-media-review.ts'
import { parseFfmpegMetadata, validateVideoMetadata } from '../server/video-inspection.ts'
import { isPublicInternetUrl } from '../server/web-sources.ts'

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const generated = path.join(root, 'public/generated')
const maxVideoBytes = 250 * 1024 * 1024
const maxImageBytes = 20 * 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const issue = (report, message) => report.issues.push(message)
const semanticIssue = (report, message) => report.semanticIssues.push(message)
const urlOf = value => typeof value === 'string' ? value : object(value) && typeof value.url === 'string' ? value.url : ''
const publicUrl = url => url.startsWith('/generated/') ? url : isPublicInternetUrl(url) ? new URL(url).origin + '/[signed-media]' : '[invalid-url]'
const retainedReviewFailure = run => run?.status === 'failed' && /^STORY_SHOT_[A-Z_-]+:/.test(String(run.error ?? run.output?.error ?? ''))
  && Boolean(urlOf(run.output))

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== '--record' || !/^record-[\w-]+$/.test(args[1])) {
    throw Error('Usage: node scripts/audit-story-two-shots.mjs --record record-ID')
  }
  return args[1]
}

async function readRecord(id) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const row = (await db.query('SELECT id,workflow_id,title,created_at,result FROM execution_records WHERE id=$1', [id])).rows[0]
    await db.query('COMMIT')
    return row
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

async function localFile(url, extension) {
  const pattern = extension === 'image' ? /^\/generated\/[\w.-]+\.(?:png|jpg|jpeg|webp)$/i
    : /^\/generated\/[\w.-]+\.(?:mp4|mov|webm)$/i
  if (!pattern.test(url)) throw Error(`invalid local ${extension} URL`)
  const filename = path.join(generated, path.basename(url))
  const resolved = await realpath(filename)
  const base = await realpath(generated)
  if (!resolved.startsWith(base + path.sep)) throw Error('generated media resolves outside its directory')
  if (!(await stat(resolved)).isFile()) throw Error('generated media is not a file')
  return resolved
}

async function fileSha256(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function inspectImage(url, expectedSize) {
  const filename = await localFile(url, 'image')
  const info = await stat(filename)
  if (info.size < 64 || info.size > maxImageBytes) throw Error(`image byte length ${info.size} outside 64..${maxImageBytes}`)
  const bytes = await readFile(filename)
  const raster = sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 })
  const metadata = await raster.metadata()
  await raster.raw().toBuffer()
  const dimensions = `${metadata.width}x${metadata.height}`
  if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)) throw Error('image has no dimensions')
  if (expectedSize && dimensions !== expectedSize) throw Error(`image ${dimensions} differs from configured ${expectedSize}`)
  const ratio = metadata.width / metadata.height
  if (Math.abs(ratio - 9 / 16) > .04) throw Error(`image ${dimensions} is not 9:16`)
  return { url, bytes: info.size, sha256: sha256(bytes), width: metadata.width, height: metadata.height,
    format: metadata.format, configuredSize: expectedSize || null, fullyDecoded: true }
}

async function downloadVideo(url, destination) {
  let current = url
  for (let redirect = 0; redirect <= 4; redirect++) {
    if (!isPublicInternetUrl(current)) throw Error('video URL is not public HTTP(S)')
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(120_000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location || redirect === 4) throw Error('video redirect chain is incomplete')
      current = new URL(location, current).href
      continue
    }
    if (!response.ok || !response.body) throw Error(`video download HTTP ${response.status}`)
    const announced = Number(response.headers.get('content-length'))
    if (Number.isFinite(announced) && announced > maxVideoBytes) throw Error('video exceeds 250 MB')
    const handle = await open(destination, 'wx', 0o600)
    let bytes = 0
    const digest = createHash('sha256')
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > maxVideoBytes) throw Error('video exceeds 250 MB')
        digest.update(chunk)
        await handle.writeFile(chunk)
      }
    } finally { await handle.close() }
    if (!bytes) throw Error('video download is empty')
    return { filename: destination, bytes, sha256: digest.digest('hex'), downloadedToTemporaryFile: true }
  }
  throw Error('video redirect chain is too long')
}

async function inspectVideo(url, expectedDuration, temporary, index) {
  const source = url.startsWith('/generated/')
    ? await (async () => { const filename = await localFile(url, 'video'); const info = await stat(filename)
      return { filename, bytes: info.size, sha256: await fileSha256(filename), downloadedToTemporaryFile: false } })()
    : await downloadVideo(url, path.join(temporary, `shot-${index + 1}.mp4`))
  if (!source.bytes || source.bytes > maxVideoBytes) throw Error('video size is invalid')
  const { stderr } = await exec(ffmpeg, ['-hide_banner', '-nostdin', '-xerror', '-i', source.filename,
    '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
  const metadata = parseFfmpegMetadata(stderr)
  const verified = validateVideoMetadata(metadata, expectedDuration, '9:16', true)
  const volume = await exec(ffmpeg, ['-hide_banner', '-nostdin', '-i', source.filename,
    '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  const meanVolumeDb = Number(volume.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] ?? '-Infinity')
  if (!Number.isFinite(meanVolumeDb) || meanVolumeDb < -50) throw Error(`audio is effectively silent (${meanVolumeDb} dB)`)
  return { url: publicUrl(url), bytes: source.bytes, sha256: source.sha256,
    duration: verified.duration, width: verified.width, height: verified.height, hasAudio: verified.hasAudio,
    meanVolumeDb, fullyDecoded: true, downloadedToTemporaryFile: source.downloadedToTemporaryFile }
}

function selectRuns(state, report) {
  const runs = Array.isArray(state.nodeRuns) ? state.nodeRuns : []
  const script = runs.filter(run => run.node?.id === 'node-script' && run.status === 'success').at(-1)
  const sourceImages = runs.filter(run => run.node?.id === 'node-model-images' && run.status === 'success').at(-1)
  if (!script || !Array.isArray(script.output?.shots) || script.output.shots.length < 2) issue(report, 'successful source script with at least two shots is missing')
  if (!sourceImages || !Array.isArray(sourceImages.output?.items) || !sourceImages.output.items.length) issue(report, 'source character reference images are missing')
  const shots = [0, 1].map(loopIndex => {
    const imageEntries = runs.map((run, index) => ({ run, index })).filter(item => item.run.node?.id === 'node-image' && item.run.loopIndex === loopIndex)
    const videoEntries = runs.map((run, index) => ({ run, index })).filter(item => item.run.node?.id === 'node-video' && item.run.loopIndex === loopIndex)
    const image = imageEntries.at(-1), video = videoEntries.at(-1)
    if (!image || !video) issue(report, `shot ${loopIndex + 1}: image or video node is missing`)
    else {
      if (image.run.status !== 'success' || video.run.status !== 'success' && !retainedReviewFailure(video.run)) {
        issue(report, `shot ${loopIndex + 1}: latest image/video has no inspectable completed media`)
      }
      if (retainedReviewFailure(video.run)) semanticIssue(report, `shot ${loopIndex + 1}: 视频已保存，但工作流的逐动作审核未通过`)
      if (image.index >= video.index) issue(report, `shot ${loopIndex + 1}: video did not follow its image`)
      if (!image.run.loopGroupId || image.run.loopGroupId !== video.run.loopGroupId) issue(report, `shot ${loopIndex + 1}: image/video loop groups differ`)
      if (image.run.node?.modelId !== 'codex-gpt-image-2' || image.run.output?.model !== 'codex-gpt-image-2') {
        issue(report, `shot ${loopIndex + 1}: first frame was not produced by codex-gpt-image-2`)
      }
      if (video.run.node?.modelId !== 'keling3' || video.run.output?.model !== 'keling3') {
        issue(report, `shot ${loopIndex + 1}: video was not produced by keling3`)
      }
    }
    return { loopIndex, script: script?.output?.shots?.[loopIndex], image: image?.run, video: video?.run,
      sourceImages: sourceImages?.output?.items }
  })
  if (shots[0].image?.loopGroupId && shots[1].image?.loopGroupId
    && shots[0].image.loopGroupId !== shots[1].image.loopGroupId) issue(report, 'the two shots are not consecutive rounds of one loop group')
  return shots
}

function auditStoryTiming(script, report, number) {
  const beats = Array.isArray(script?.visualBeats) ? script.visualBeats : []
  const summary = { status: 'invalid', beatCount: beats.length,
    beats: beats.map(beat => ({ id: beat?.id ?? null, startSecond: beat?.startSecond ?? null,
      endSecond: beat?.endSecond ?? null, completion: beat?.completion ?? null })),
    endingReserveSeconds: Number(script?.duration) - Number(beats.at(-1)?.endSecond), issues: [] }
  if (!Number.isFinite(summary.endingReserveSeconds)) summary.endingReserveSeconds = null
  try {
    validateStoryShotTimingOutput([script])
    summary.status = 'valid'
    return { summary, timedActions: renderStoryShotTimedActions(script) }
  } catch (error) {
    summary.issues = Array.isArray(error?.issues) ? error.issues : [error instanceof Error ? error.message : String(error)]
    semanticIssue(report, `shot ${number}: 逐动作时长计划无效：${summary.issues.join('；')}`)
    return { summary, timedActions: '' }
  }
}

function auditStoryMediaReview(script, video, inspectedVideo, report, number) {
  const review = object(video?.output?.storyMediaReview) ? video.output.storyMediaReview : null
  const summary = review ? { version: review.version ?? null, reviewStatus: review.reviewStatus ?? null,
    passed: review.passed === true, evidenceUrl: review.videoEvidence?.evidenceUrl ?? null,
    sourceVideoSha256: review.videoEvidence?.sha256 ?? null,
    beatStatuses: Array.isArray(review.beatChecks) ? review.beatChecks.map(check => ({ id: check?.id ?? null, status: check?.status ?? null })) : [],
    endingHoldStatus: review.endingHold?.status ?? null,
    issues: Array.isArray(review.issues) ? review.issues : [] } : null
  if (!review) {
    semanticIssue(report, `shot ${number}: 缺少已保存的逐动作成片审核`)
    return { summary, passed: false }
  }
  if (!inspectedVideo?.sha256 || review.videoEvidence?.sha256 !== inspectedVideo.sha256) {
    semanticIssue(report, `shot ${number}: 逐动作审核未绑定当前已解码视频的 SHA256`)
    return { summary, passed: false }
  }
  if (review.passed !== true || review.reviewStatus !== 'passed' || summary.issues.length) {
    semanticIssue(report, `shot ${number}: 逐动作成片审核未通过（${String(review.reviewStatus ?? 'missing')}）`)
    return { summary, passed: false }
  }
  try {
    const verified = validateStoryShotAssessment(script, review.videoEvidence, review.observations, review.assessment)
    const storedChecks = Array.isArray(review.beatChecks) ? review.beatChecks : []
    if (!verified.passed || storedChecks.length !== verified.beatChecks.length
      || storedChecks.some((check, index) => check?.id !== verified.beatChecks[index]?.id || check?.status !== verified.beatChecks[index]?.status)
      || review.endingHold?.status !== verified.endingHold?.status) {
      semanticIssue(report, `shot ${number}: 已保存的通过结论与原帧引文、节拍顺序或片尾证据不一致`)
      return { summary, passed: false }
    }
  } catch (error) {
    semanticIssue(report, `shot ${number}: 逐动作审核无法重新验证：${error instanceof Error ? error.message : String(error)}`)
    return { summary, passed: false }
  }
  return { summary, passed: true }
}

async function auditShot(item, report, temporary) {
  const number = item.loopIndex + 1
  const { script, image, video, sourceImages } = item
  const result = { order: number, loopIndex: item.loopIndex, title: script?.title ?? null,
    plannedDuration: script?.duration ?? null, imageStatus: image?.status ?? 'missing', videoStatus: video?.status ?? 'missing',
    imageModel: image?.output?.model ?? image?.node?.modelId ?? null, videoModel: video?.output?.model ?? video?.node?.modelId ?? null,
    semanticReview: 'pending', semanticPassed: false }
  const timing = auditStoryTiming(script, report, number)
  result.storyTiming = timing.summary
  if (!script || !image || !video || image.status !== 'success'
    || video.status !== 'success' && !retainedReviewFailure(video)) return result
  if (image.node?.modelId !== 'codex-gpt-image-2' || image.output?.model !== 'codex-gpt-image-2') issue(report, `shot ${number}: first frame was not produced by codex-gpt-image-2`)
  if (video.node?.modelId !== 'keling3' || video.output?.model !== 'keling3') issue(report, `shot ${number}: video was not produced by keling3`)
  for (const [label, run, expected] of [['image', image, script.firstFramePrompt],
    ['video', video, timing.timedActions || script.content]]) {
    if (run.loopItem?.title !== script.title || run.inputContext?.shot?.title !== script.title
      || !String(run.output?.prompt ?? '').includes(String(expected ?? ''))) {
      issue(report, `shot ${number}: ${label} is not bound to its saved script`)
    }
  }
  const imageUrl = urlOf(image.output)
  const referenceUrl = urlOf(video.inputs?.referenceImage)
  const requestReferenceUrl = urlOf(video.output?.params?.referenceImage)
  const contextReferenceUrl = urlOf(video.inputContext?.first_frame)
  result.firstFrameBinding = { imageUrl, videoInputUrl: referenceUrl,
    videoRequestUrl: requestReferenceUrl, videoContextUrl: contextReferenceUrl,
    allMatch: Boolean(imageUrl && imageUrl === referenceUrl && imageUrl === requestReferenceUrl && imageUrl === contextReferenceUrl) }
  if (!result.firstFrameBinding.allMatch) issue(report, `shot ${number}: video first-frame URL is not bound to this shot's generated image`)
  const referenceCount = Array.isArray(image.inputs?.referenceImages) ? image.inputs.referenceImages.length : 0
  result.characterReferenceCount = referenceCount
  if (!Array.isArray(sourceImages) || referenceCount !== sourceImages.length || referenceCount === 0) {
    issue(report, `shot ${number}: source character reference count differs from first-frame input`)
  } else {
    const sourceHashes = sourceImages.map(value => sha256(urlOf(value)))
    const passedHashes = image.inputs.referenceImages.map(value => sha256(urlOf(value)))
    if (JSON.stringify(sourceHashes) !== JSON.stringify(passedHashes)) issue(report, `shot ${number}: first-frame references differ from source images`)
  }
  const expectedSize = String(image.inputs?.size ?? '').trim()
  if (expectedSize && !/^\d{2,5}x\d{2,5}$/.test(expectedSize)) issue(report, `shot ${number}: configured image size is invalid`)
  try { result.image = await inspectImage(imageUrl, expectedSize) }
  catch (error) { issue(report, `shot ${number}: image inspection failed: ${error.message}`) }
  const duration = Number(script.duration)
  if (!Number.isFinite(duration) || duration <= 0 || Number(video.output?.params?.duration) !== duration) {
    issue(report, `shot ${number}: video duration is not bound to the script`)
  }
  const videoUrl = urlOf(video.output)
  if (!videoUrl) issue(report, `shot ${number}: successful video node has no URL`)
  else if (Number.isFinite(duration) && duration > 0) {
    try { result.video = await inspectVideo(videoUrl, duration, temporary, item.loopIndex) }
    catch (error) { issue(report, `shot ${number}: video inspection failed: ${error.message}`) }
  }
  const review = auditStoryMediaReview(script, video, result.video, report, number)
  result.storyMediaReview = review.summary
  result.semanticPassed = timing.summary.status === 'valid' && review.passed
  result.semanticReview = result.semanticPassed ? 'passed' : 'not-passed'
  return result
}

async function main() {
  const id = parseArguments(process.argv.slice(2))
  const report = { version: 'wf-story-two-shot-audit-v2', recordId: id, readOnly: true, modelCalls: 0,
    recordChanged: false, technicalPassed: false, semanticPassed: false, issues: [], semanticIssues: [], shots: [],
    humanReviewGaps: ['Subjective playback and listening', 'Character appearance against the four references',
      'Cross-shot character identity and scene continuity'] }
  let temporary
  try {
    const row = await readRecord(id)
    if (!row) throw Error('execution record not found')
    report.workflowId = row.workflow_id
    report.createdAt = row.created_at
    if (row.workflow_id !== 'wf-story') issue(report, 'record is not wf-story')
    const state = decodeExecutionState(row.result)
    const shots = selectRuns(state, report)
    // Reject stale or structurally mismatched records before downloading media.
    if (!report.issues.length) {
      temporary = await mkdtemp(path.join(tmpdir(), 'story-two-shot-audit-'))
      for (const item of shots) report.shots.push(await auditShot(item, report, temporary))
    }
    if (report.shots.length === 2 && report.shots.every(shot => shot.image?.fullyDecoded && shot.video?.fullyDecoded)
      && report.shots[0].image.sha256 === report.shots[1].image.sha256) issue(report, 'the two first frames have identical bytes')
    if (report.shots.length === 2 && report.shots.every(shot => shot.video?.fullyDecoded)
      && report.shots[0].video.sha256 === report.shots[1].video.sha256) issue(report, 'the two videos have identical bytes')
    report.technicalPassed = report.issues.length === 0 && report.shots.length === 2
    report.semanticPassed = report.technicalPassed && report.semanticIssues.length === 0
      && report.shots.length === 2 && report.shots.every(shot => shot.semanticPassed)
  } catch (error) { issue(report, `audit could not complete: ${error.message}`) }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
  console.log(JSON.stringify(report, null, 2))
  if (!report.technicalPassed || !report.semanticPassed) process.exitCode = 1
}

await main()
