#!/usr/bin/env node
// Read-only schema-5 story inspection. Never downloads media, runs a model,
// changes a record, or writes into public/generated. An export is not acceptance.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { storyShotIdentity } from '../src/story-same-media-retry.ts'
import { renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { storyReviewSampleTimes, validateStoryShotAssessment } from '../server/story-media-review.ts'
import { parseFfmpegMetadata } from '../server/video-inspection.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mediaRoot = path.join(root, 'public/generated')
const exec = promisify(execFile)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const fingerprint = value => hash(storyShotIdentity(value))
const localUrl = value => typeof value === 'string' && /^\/generated\/[\w.-]+$/.test(value) ? value : null
// Only allowlisted fields are exported. Redact URLs/data even inside free text.
const safeText = value => typeof value === 'string' ? value
  .replace(/data:[^\s"'<>]+/gi, '[data omitted]')
  .replace(/https?:\/\/[^\s"'<>]+/gi, '[remote URL omitted]')
  .replace(/(?:bearer\s+)[\w.+/=-]+/gi, '[credential omitted]')
  .replace(/(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '[credential omitted]')
  .replace(/[A-Za-z0-9+/=_-]{180,}/g, '[long encoded value omitted]').slice(0, 5000) : null
const messages = values => Array.isArray(values) ? values.map(safeText).filter(Boolean) : []
const fail = message => { throw Error(`STORY_INSPECTION_INVALID: ${message}`) }
const same = (left, right) => left !== undefined && right !== undefined && storyShotIdentity(left) === storyShotIdentity(right)

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const result = {}
  const usage = 'Use --record record-ID --out FRESH_DIRECTORY [--workflow wf-ID]'
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--record': 'recordId', '--out': 'out', '--workflow': 'workflowId' }[args[index]]
    if (!key || result[key] || !args[index + 1] || args[index + 1].startsWith('--')) fail(usage)
    result[key] = args[index + 1]
  }
  result.workflowId ??= 'wf-story'
  if (!/^record-[\w-]+$/.test(result.recordId ?? '') || !result.out || !/^wf-[\w-]+$/.test(result.workflowId)) fail(usage)
  return result
}

function runSummary(run) {
  return run ? { runId: safeText(run.id), nodeId: safeText(run.node?.id), status: safeText(run.status),
    revision: run.revision ?? null, loopIndex: run.loopIndex ?? null, loopGroupId: safeText(run.loopGroupId),
    error: safeText(run.error) } : { status: 'not-scheduled' }
}

/** No earlier success can hide the latest pending/rejected run. */
export function selectStoryInspection(state, { workflowId = 'wf-story' } = {}) {
  if (!object(state) || state.workflowId !== workflowId || !Array.isArray(state.nodeRuns)) fail(`Expected a ${workflowId} execution`)
  const runs = state.nodeRuns
  const sourceIndex = runs.findLastIndex(run => run.node?.id === 'node-script')
  const reviewIndex = runs.findLastIndex(run => run.node?.id === 'node-script-review')
  const script = runs[sourceIndex], scriptReview = runs[reviewIndex]
  const reviewedShots = scriptReview?.output?.shots
  const issues = []
  let scriptPassed = Boolean(script?.status === 'success' && scriptReview?.status === 'success'
    && scriptReview?.node?.operation === 'story.script-review' && scriptReview.output?.passed === true
    && reviewIndex > sourceIndex && Array.isArray(reviewedShots))
  const expectedCount = Number(state.runtimeInputs?.input?.vedio_count ?? state.context?.input?.vedio_count)
  if (scriptPassed) {
    try {
      validateStoryShotTimingOutput(reviewedShots, { ...(Number.isSafeInteger(expectedCount) && expectedCount > 0 ? { expectedCount } : {}) })
      if (reviewedShots.some(shot => shot.timedActions !== renderStoryShotTimedActions(shot))) fail('Reviewed timedActions differ from visualBeats')
      if (!same(scriptReview.inputContext?.[script.node.resultVar], script.output)) fail('Script review is bound to a different draft')
    } catch (error) { scriptPassed = false; issues.push(safeText(error.message)) }
  }
  if (!scriptPassed) issues.push('No passing current script-review plan; media cannot be accepted from draft script output')
  const shots = Array.isArray(reviewedShots) ? reviewedShots : []
  const count = Math.max(shots.length, Number.isSafeInteger(expectedCount) && expectedCount > 0 && expectedCount <= 100 ? expectedCount : 0)
  const selections = Array.from({ length: count }, (_, loopIndex) => {
    const latest = nodeId => runs.findLast((run, index) => index > reviewIndex && run.node?.id === nodeId && run.loopIndex === loopIndex)
    const shot = shots[loopIndex], image = latest('node-image'), video = latest('node-video'), review = latest('node-video-review'), concat = latest('node-video-concat')
    const bindingIssues = []
    const executed = [image, video, review].filter(run => run && ['success', 'failed'].includes(run.status))
    if (!object(shot)) bindingIssues.push('Current reviewed shot is unavailable')
    for (const run of executed) {
      if (!run.loopGroupId || !same(run.loopItem, shot) || !same(run.inputContext?.shot, shot)) {
        bindingIssues.push(`${run.node.id}: loop/shot binding differs from script-review.shots`)
      }
    }
    if (new Set(executed.map(run => run.loopGroupId)).size > 1) bindingIssues.push('Latest image/video/review belong to different loop groups')
    if (video?.output && video.status === 'success') {
      const reference = video.output.params?.referenceImage
      if ((typeof reference === 'string' ? reference : reference?.url) !== image?.output?.url) bindingIssues.push('Video request first frame differs from current image')
      if (Number(video.output.params?.duration) !== shot?.duration || !video.output.prompt?.includes(shot?.timedActions)) bindingIssues.push('Video request differs from approved duration/actions')
    }
    if (review?.output) {
      if (review.node.operation !== 'story.media-review') bindingIssues.push('Review node operation differs from schema 5')
      if (!same(review.inputContext?.[video?.node?.resultVar], video?.output)) bindingIssues.push('Media review input differs from latest video output')
      if (review.output.storyMediaReview?.videoUrl !== video?.output?.url) bindingIssues.push('Media review source URL differs from latest video output')
    }
    return { number: loopIndex + 1, shot, image, video, review, concat, bindingIssues, scriptPassed }
  })
  return { script, scriptReview, scriptPassed, expectedCount: count, issues, selections }
}

async function generatedFile(url, extensions) {
  if (!localUrl(url) || !extensions.includes(path.extname(url).toLowerCase())) fail('Only saved /generated/ media with the expected extension is accepted')
  const base = await realpath(mediaRoot)
  const file = await realpath(path.join(base, url.slice('/generated/'.length)))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('Local media is missing or escapes public/generated')
  return file
}

async function checkedImage(url) {
  const file = await generatedFile(url, ['.png', '.jpg', '.jpeg', '.webp'])
  const bytes = await readFile(file)
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 })
  const metadata = await image.metadata()
  await image.raw().toBuffer()
  return { url, file, sha256: hash(bytes), width: metadata.width, height: metadata.height }
}

async function ffmpegRun(args, timeout = 180_000) {
  if (!ffmpeg) fail('ffmpeg-static unavailable')
  try { return await exec(ffmpeg, ['-hide_banner', '-nostdin', '-n', '-xerror', ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { fail(`FFmpeg failed: ${safeText(String(error.stderr ?? error.message)).slice(-1200)}`) }
}

async function decodeVideo(url, expectedDuration) {
  const file = await generatedFile(url, ['.mp4', '.mov', '.webm'])
  const sha256 = hash(await readFile(file))
  const decoded = await ffmpegRun(['-i', file, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'])
  const parsed = parseFfmpegMetadata(decoded.stderr)
  const video = parsed.streams?.find(stream => stream.codec_type === 'video')
  const duration = Number(parsed.format?.duration)
  if (!video || !Number.isFinite(duration) || duration <= 0) fail('Decoded video metadata unavailable')
  const hasAudio = parsed.streams.some(stream => stream.codec_type === 'audio')
  const audio = hasAudio ? await ffmpegRun(['-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], 60_000) : null
  const number = pattern => { const value = Number(audio?.stderr.match(pattern)?.[1]); return Number.isFinite(value) ? value : null }
  const meanVolumeDb = number(/mean_volume:\s*(-?[\d.]+) dB/)
  const maxVolumeDb = number(/max_volume:\s*(-?[\d.]+) dB/)
  const issues = []
  if (!Number.isFinite(expectedDuration) || Math.abs(duration - expectedDuration) > .5) issues.push('Actual duration differs from reviewed plan or plan is unavailable')
  if (Math.abs(video.width / video.height - 9 / 16) > .04) issues.push('Actual frame aspect is not 9:16')
  if (!hasAudio || meanVolumeDb === null || meanVolumeDb < -50) issues.push('No usable audio track or mean audio is below -50 dB')
  return { url, file, sha256, decoded: true, duration, width: video.width, height: video.height,
    hasAudio, meanVolumeDb, maxVolumeDb, audioMeaningReview: 'pending-listening', technicalPassed: issues.length === 0, issues }
}

async function pixelDifference(left, right) {
  const pixels = file => sharp(file).resize(144, 256, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  const [a, b] = await Promise.all([pixels(left), pixels(right)])
  if (a.length !== b.length) fail('Frame pixel sizes differ')
  return Number((a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / (a.length * 255)).toFixed(6))
}

const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character])
async function contactSheet(frames, destination, columns = 5) {
  const tileWidth = 256, tileHeight = 456, labelHeight = 32
  const cells = await Promise.all(frames.map(async (frame, index) => ({
    input: await sharp(frame.file).resize(tileWidth, tileHeight, { fit: 'contain', background: '#111' })
      .extend({ bottom: labelHeight, background: '#f4f1e9' })
      .composite([{ input: Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}"><text x="8" y="22" font-size="15" font-family="Arial,sans-serif" fill="#222">${xml(frame.label)}</text></svg>`), left: 0, top: tileHeight }]).jpeg({ quality: 90 }).toBuffer(),
    left: index % columns * tileWidth, top: Math.floor(index / columns) * (tileHeight + labelHeight),
  })))
  await sharp({ create: { width: Math.min(columns, frames.length) * tileWidth,
    height: Math.ceil(frames.length / columns) * (tileHeight + labelHeight), channels: 3, background: '#f4f1e9' } })
    .composite(cells).jpeg({ quality: 94 }).toFile(destination)
  return destination
}

async function sampleVideo(video, shot, directory) {
  await mkdir(directory)
  const tail = Math.max(0, Number((video.duration - .08).toFixed(3)))
  let planned = []
  try { planned = storyReviewSampleTimes(shot) } catch { planned = [0, video.duration / 4, video.duration / 2, video.duration * .75] }
  const times = [...new Set([0, ...planned.map(time => Math.min(time, tail)), tail])].sort((a, b) => a - b)
  const frames = []
  for (const [index, second] of times.entries()) {
    const file = path.join(directory, `frame-${String(index).padStart(2, '0')}.jpg`)
    await ffmpegRun(['-v', 'error', '-ss', String(second), '-i', video.file, '-frames:v', '1', '-q:v', '2', file], 30_000)
    frames.push({ index, second, file, sha256: hash(await readFile(file)), label: `${second.toFixed(2)} s${index === 0 ? ' / opening' : index === times.length - 1 ? ' / ending' : ''}` })
  }
  return frames
}

function shotPlan(shot) {
  if (!object(shot)) return null
  return { title: safeText(shot.title), content: safeText(shot.content), duration: shot.duration,
    visualBeats: Array.isArray(shot.visualBeats) ? shot.visualBeats.map(beat => ({ id: safeText(beat.id),
      action: safeText(beat.action), completion: safeText(beat.completion), startSecond: beat.startSecond, endSecond: beat.endSecond })) : [] }
}

async function inspectShot(selection, out) {
  const { number, shot, image, video, review, concat } = selection
  const report = { number, plan: shotPlan(shot), nodes: { image: runSummary(image), video: runSummary(video),
    review: runSummary(review), concat: runSummary(concat) }, bindingIssues: [...selection.bindingIssues],
    firstFrame: null, video: null, savedReview: null, frames: [], contactSheet: null,
    machineChecksPassed: false, humanVisualReview: 'pending', scriptAttractivenessReview: 'pending' }
  const frameInputs = []
  if (localUrl(image?.output?.url)) {
    try {
      report.firstFrame = await checkedImage(image.output.url)
      const file = path.join(out, `shot-${number}-first-frame.jpg`)
      await sharp(report.firstFrame.file).jpeg({ quality: 94 }).toFile(file)
      report.firstFrame.preview = file
      frameInputs.push({ file, label: `Shot ${number} / planned first frame` })
    } catch (error) { report.bindingIssues.push(safeText(error.message)) }
  } else if (image?.status === 'success') report.bindingIssues.push('Successful first frame has no local archive; image bytes were not inspected')
  const saved = review?.output?.storyMediaReview
  const evidence = saved?.videoEvidence
  let sourceUrl = localUrl(evidence?.url) ?? localUrl(review?.output?.url) ?? localUrl(video?.output?.url)
  report.localMediaSource = sourceUrl === localUrl(evidence?.url) && sourceUrl ? 'current-review-evidence'
    : sourceUrl === localUrl(review?.output?.url) && sourceUrl ? 'current-review-output'
      : sourceUrl ? 'current-video-output' : null
  // collectVideoEvidence atomically archives bytes before the asynchronous
  // review finishes. During that interval the saved video run still has its
  // original provider URL and the review has no output yet. Resolve only the
  // exact archive key from that run; never search by newest filename or fetch.
  if (!sourceUrl && video?.status === 'success' && /^https?:\/\//.test(video.output?.url ?? '')
    && review && ['running', 'failed'].includes(review.status)
    && same(review.inputContext?.[video.node?.resultVar], video.output)) {
    const candidate = `/generated/verified-${hash(video.output.url).slice(0, 20)}.mp4`
    try {
      await generatedFile(candidate, ['.mp4'])
      sourceUrl = candidate
      report.localMediaSource = 'existing-archive-of-current-video-url'
    } catch { /* Review has not archived local bytes yet; keep this pending. */ }
  }
  if (!sourceUrl) {
    report.status = video?.status === 'success' ? 'video-has-no-local-archive' : 'video-not-completed'
    if (frameInputs.length) report.contactSheet = await contactSheet(frameInputs, path.join(out, `shot-${number}-contact.jpg`))
    return report
  }
  try {
    report.video = await decodeVideo(sourceUrl, Number(shot?.duration))
    report.frames = await sampleVideo(report.video, shot, path.join(out, `shot-${number}-frames`))
    frameInputs.push(...report.frames)
    report.contactSheet = await contactSheet(frameInputs, path.join(out, `shot-${number}-contact.jpg`))
    if (report.firstFrame) report.openingReferencePixelDifference = await pixelDifference(report.firstFrame.file, report.frames[0].file)
    if (saved) {
      const issues = []
      let semanticReplay = null, evidenceFilesVerified = false
      if (evidence?.url !== sourceUrl || evidence?.sha256 !== report.video.sha256 || evidence?.decoded !== true
        || review.output?.videoEvidence?.sha256 !== report.video.sha256 || review.output?.url !== sourceUrl) issues.push('Review is not bound to the inspected local bytes')
      if (evidence?.duration !== report.video.duration || evidence?.width !== report.video.width || evidence?.height !== report.video.height
        || evidence?.hasAudio !== report.video.hasAudio) issues.push('Saved evidence metadata differs from full local decode')
      try {
        const evidenceFile = await generatedFile(evidence?.evidenceUrl, ['.json'])
        const receipt = JSON.parse(await readFile(evidenceFile, 'utf8'))
        if (receipt.sha256 !== report.video.sha256 || receipt.url !== sourceUrl || !same(receipt.frames, evidence.frames)
          || !same(receipt.frameTimes, evidence.frameTimes)) fail('Saved evidence receipt does not match review output')
        if (!Array.isArray(evidence.frames) || evidence.frames.length < 4 || evidence.frames.length !== evidence.frameTimes?.length) fail('Saved evidence frame list is incomplete')
        for (const [index, url] of evidence.frames.entries()) {
          const second = evidence.frameTimes[index]
          if (!Number.isFinite(second) || second < 0 || second >= report.video.duration || index > 0 && second <= evidence.frameTimes[index - 1]) fail('Saved evidence frame times are invalid')
          const savedFrame = await checkedImage(url)
          let fresh = report.frames.find(frame => Math.abs(frame.second - second) < .001)
          if (!fresh) {
            const file = path.join(out, `shot-${number}-frames`, `evidence-${index}.jpg`)
            await ffmpegRun(['-v', 'error', '-ss', String(second), '-i', report.video.file, '-frames:v', '1', '-q:v', '2', file], 30_000)
            fresh = { file }
          }
          if (await pixelDifference(fresh.file, savedFrame.file) > .06) fail('Saved review frame differs from freshly decoded local video')
        }
        evidenceFilesVerified = true
        semanticReplay = validateStoryShotAssessment(shot, evidence, saved.observations, saved.assessment)
        if (saved.passed !== semanticReplay.passed || saved.reviewStatus !== semanticReplay.reviewStatus
          || !same(saved.beatChecks, semanticReplay.beatChecks) || !same(saved.endingHold, semanticReplay.endingHold)) issues.push('Saved review conclusion cannot be reproduced')
      } catch (error) { issues.push(safeText(error.message)) }
      report.savedReview = { status: safeText(saved.reviewStatus), passed: saved.passed === true,
        evidenceUrl: localUrl(evidence?.evidenceUrl), sourceSha256: /^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '') ? evidence.sha256 : null,
        evidenceFilesVerified, semanticReplayPassed: semanticReplay?.passed === true,
        beatStatuses: Array.isArray(saved.beatChecks) ? saved.beatChecks.map(beat => ({ id: safeText(beat.id), status: safeText(beat.status), reason: safeText(beat.reason) })) : [],
        endingHold: safeText(saved.endingHold?.status), issues: messages(saved.issues), verificationIssues: issues }
    }
    if (hash(await readFile(report.video.file)) !== report.video.sha256
      || report.firstFrame && hash(await readFile(report.firstFrame.file)) !== report.firstFrame.sha256) report.bindingIssues.push('Source media changed during inspection')
    report.machineChecksPassed = selection.scriptPassed && [image, video, review].every(run => run?.status === 'success')
      && report.bindingIssues.length === 0 && Boolean(report.firstFrame) && report.video.technicalPassed && report.savedReview?.passed === true
      && report.savedReview.status === 'passed' && report.savedReview.semanticReplayPassed
      && report.savedReview.evidenceFilesVerified && report.savedReview.verificationIssues.length === 0
    report.status = report.machineChecksPassed ? 'machine-checks-passed-human-review-pending'
      : review?.status === 'idle' || review?.status === 'running' || !review ? 'media-review-pending' : 'machine-checks-not-passed'
  } catch (error) { report.status = 'local-inspection-failed'; report.bindingIssues.push(safeText(error.message)) }
  return report
}

async function resolveFuturePath(target) {
  let parent = path.resolve(target)
  const parts = []
  for (;;) {
    try { return path.join(await realpath(parent), ...parts) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      parts.unshift(path.basename(parent)); const next = path.dirname(parent)
      if (next === parent) throw error
      parent = next
    }
  }
}

async function loadRecord(db, id) {
  // Read-only transactions also protect against accidental future SQL writes.
  await db.query('BEGIN READ ONLY')
  try {
    const row = (await db.query('SELECT id,workflow_id,md5(result::text) AS result_md5,result FROM execution_records WHERE id=$1', [id])).rows[0]
    await db.query('COMMIT')
    return row
  } catch (error) { await db.query('ROLLBACK'); throw error }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/inspect-story-generation.mjs --record record-ID --out FRESH_DIRECTORY [--workflow wf-ID]\nWorkflow defaults to wf-story. Exports a partial or complete schema-5 inspection. Local saved media only; no generation, downloads, DB writes, or source edits. Exit 0 means the manifest was exported, not that content passed.')
    return
  }
  const out = await resolveFuturePath(options.out)
  const mediaBase = await realpath(mediaRoot)
  if (out === mediaBase || out.startsWith(mediaBase + path.sep)) fail('Output directory must be outside public/generated')
  try { if ((await readdir(out)).length) fail('Output directory must be fresh and empty') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const row = await loadRecord(db, options.recordId)
    if (!row || row.workflow_id !== options.workflowId) fail('Record is missing or belongs to another workflow')
    const state = decodeExecutionState(row.result)
    if (state.id !== row.id) fail('Stored execution identity differs from record ID')
    const selection = selectStoryInspection(state, { workflowId: options.workflowId })
    await mkdir(out, { recursive: true })
    const shots = []
    for (const shot of selection.selections) shots.push(await inspectShot(shot, out))
    const finalRow = await loadRecord(db, options.recordId)
    const finalState = finalRow ? decodeExecutionState(finalRow.result) : null
    for (const [index, shot] of shots.entries()) {
      const selected = selection.selections[index]
      const boundRuns = [selection.script, selection.scriptReview, selected.image, selected.video, selected.review].filter(Boolean)
      shot.snapshotUnchanged = boundRuns.every(run => fingerprint(run) === fingerprint(finalState?.nodeRuns?.find(candidate => candidate.id === run.id)))
      if (!shot.snapshotUnchanged) { shot.machineChecksPassed = false; shot.status = 'execution-changed-during-inspection' }
    }
    const completed = shots.filter(shot => shot.machineChecksPassed).length
    const manifest = { version: 'story-generation-inspection-v1', inspectedAt: new Date().toISOString(), recordId: row.id, workflowId: state.workflowId,
      sourceResultMd5: row.result_md5, finalResultMd5: finalRow?.result_md5 ?? null,
      recordUnchanged: row.result_md5 === finalRow?.result_md5, databaseReadOnly: true, sourceMediaModified: false,
      modelCalls: 0, providerCalls: 0, remoteDownloads: 0, acceptance: 'not-human-accepted',
      scriptReview: { ...runSummary(selection.scriptReview), passed: selection.scriptPassed, issues: selection.issues },
      expectedShotCount: selection.expectedCount, inspectedLocalVideoCount: shots.filter(shot => shot.video?.decoded).length,
      machinePassedShotCount: completed, allMachineChecksPassed: selection.expectedCount > 0 && completed === selection.expectedCount,
      shots, notes: ['Manifest export success does not imply content acceptance.',
        'Contact sheets and loudness checks do not prove joke quality, natural motion, or meaningful sound; playback and independent editorial review remain required.',
        'Only script-review.shots is authoritative; draft script output never substitutes for an approved plan.',
        'Remote URLs, model prompts, provider raw responses, and image data are not exported.'] }
    const destination = path.join(out, 'manifest.json')
    await writeFile(destination, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ manifest: destination, expectedShotCount: manifest.expectedShotCount,
      inspectedLocalVideoCount: manifest.inspectedLocalVideoCount, machinePassedShotCount: completed,
      allMachineChecksPassed: manifest.allMachineChecksPassed, acceptance: manifest.acceptance,
      shots: shots.map(shot => ({ number: shot.number, status: shot.status, contactSheet: shot.contactSheet })) }, null, 2))
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(safeText(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
