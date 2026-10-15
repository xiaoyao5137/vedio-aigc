#!/usr/bin/env node
/** Strict read-only technical audit of the completed 14+10 s schema180 pair.
 * It reports visual continuity as pending direct original-speed review. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { verifyA8B6WorkflowApprovalSync } from '../server/staged-scene-cut-a8b6-approval.mjs'
import { verifyA8B6CompositeReceipt } from '../server/staged-scene-cut-a8b6-qa.mjs'
import { assertA8B6ConcatFrames, assertA8B6NativeSecondTiming,
  assertA8B6ShotCompletion, assertA8B6SpeechBoundary, parseA8B6FrameMd5,
  requireA8B6TwoShotRuns } from '../server/sanguo-a8b6-two-shot-qa.mjs'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const root = path.resolve(import.meta.dirname, '..')
const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/
const AUDIO_REPORT_SHA = '4226f42067e5b9cb3029515ff7f271a6e922b0e52580d5d005ff92e6bf543728'
const fail = reason => { throw Error(`SANGUO_A8B6_TWO_SHOT_READONLY_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const args = process.argv.slice(2)
const options = { record: '', expectedMd5: '', planId: '', contactSheet: '' }
for (let index = 0; index < args.length; index++) {
  const key = args[index]
  if (key === '--record' && args[index + 1]) options.record = args[++index]
  else if (key === '--expected-md5' && args[index + 1]) options.expectedMd5 = args[++index]
  else if (key === '--plan-id' && args[index + 1]) options.planId = args[++index]
  else if (key === '--contact-sheet' && args[index + 1]) options.contactSheet = args[++index]
  else fail(`unknown or incomplete argument: ${key}`)
}
if (!/^record-[\w-]+$/.test(options.record) || !MD5.test(options.expectedMd5)
  || !SHA.test(options.planId))
  fail('usage: node scripts/verify-sanguo-a8b6-two-shot-readonly.mjs --record record-ID --expected-md5 MD5 --plan-id SHA [--contact-sheet qa/staged-scene-cut/name.png]')
if (options.contactSheet && (!/^qa\/staged-scene-cut\/[\w.-]+\.png$/.test(options.contactSheet)
  || options.contactSheet.includes('..')))
  fail('contact sheet must be a simple qa/staged-scene-cut/*.png path')

function localGenerated(url, extension) {
  if (typeof url !== 'string'
    || !new RegExp(`^/generated/[\\w.-]+\\.${extension}$`, 'i').test(url)
    || url.includes('..')) fail('media must be archived under /generated')
  return path.join(root, 'public', url.slice(1))
}
function localGeneratedImage(url) {
  if (typeof url !== 'string'
    || !/^\/generated\/[\w.-]+\.(?:jpe?g|png|webp)$/i.test(url)
    || url.includes('..')) fail('frame must be an archived /generated image')
  return path.join(root, 'public', url.slice(1))
}
async function checkedFile(url, expectedSha, extension = 'mp4') {
  if (!SHA.test(String(expectedSha))) fail('media lacks a signed or recorded SHA')
  const filename = localGenerated(url, extension)
  const actualSha = sha(await readFile(filename))
  if (actualSha !== expectedSha) fail(`media bytes changed: ${url}`)
  return filename
}
async function ffmpegBytes(args, limit = 32 * 1024 * 1024) {
  const { stdout } = await exec(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error',
    '-xerror', ...args], { encoding: 'buffer', timeout: 180000, maxBuffer: limit })
  if (!Buffer.isBuffer(stdout)) fail('FFmpeg returned no decoded bytes')
  return stdout
}
async function decodedFrames(filename) {
  const bytes = await ffmpegBytes(['-i', filename, '-map', '0:v:0', '-an',
    '-vsync', '0', '-f', 'framemd5', '-'], 4 * 1024 * 1024)
  return parseA8B6FrameMd5(bytes.toString('utf8'))
}
async function adts(filename) {
  return ffmpegBytes(['-i', filename, '-map', '0:a:0', '-vn', '-c:a', 'copy',
    '-f', 'adts', '-'], 16 * 1024 * 1024)
}
async function frameJpeg(filename, index) {
  return ffmpegBytes(['-i', filename, '-map', '0:v:0', '-an',
    '-vf', `select=eq(n\\,${index})`, '-vsync', 'vfr',
    '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
  20 * 1024 * 1024)
}
async function reducedDifference(left, right) {
  const buffers = await Promise.all([left, right].map(bytes => sharp(bytes)
    .resize(96, 54, { fit: 'fill' }).removeAlpha().raw().toBuffer()))
  return buffers[0].reduce((sum, value, index) =>
    sum + Math.abs(value - buffers[1][index]), 0) / (buffers[0].length * 255)
}
async function contactSheet(firstFile, secondFile, firstTailUrl,
  secondCandidateUrl, secondCount) {
  const frames = [
    { label: 'first actual f336', bytes: await frameJpeg(firstFile, 336) },
    { label: 'first saved tail', bytes: await readFile(localGeneratedImage(firstTailUrl)) },
    { label: 'second approved image', bytes: await readFile(localGeneratedImage(secondCandidateUrl)) },
    { label: 'second native f0', bytes: await frameJpeg(secondFile, 0) },
    ...[1, 12, 24, 72, 120, secondCount - 1].map(index => ({
      label: `second native f${index}`, filename: secondFile, index })),
  ]
  for (const frame of frames) if (!frame.bytes)
    frame.bytes = await frameJpeg(frame.filename, frame.index)
  const cellW = 480, cellH = 300, columns = 2
  const composites = []
  for (const [index, frame] of frames.entries()) {
    const x = index % columns * cellW, y = Math.floor(index / columns) * cellH
    const image = await sharp(frame.bytes).resize(cellW, 270, { fit: 'fill' }).toBuffer()
    const label = Buffer.from(`<svg width="${cellW}" height="30"><rect width="100%" height="100%" fill="#171717"/><text x="12" y="21" fill="white" font-family="sans-serif" font-size="17">${frame.label}</text></svg>`)
    composites.push({ input: image, left: x, top: y },
      { input: label, left: x, top: y + 270 })
  }
  const output = path.join(root, options.contactSheet)
  await mkdir(path.dirname(output), { recursive: true })
  await sharp({ create: { width: cellW * columns,
    height: cellH * Math.ceil(frames.length / columns), channels: 3,
    background: '#171717' } }).composite(composites).png().toFile(output)
  return { path: output, sha256: sha(await readFile(output)),
    status: 'frames for direct review; no automatic semantic verdict' }
}

const { manifest, receipt, manifestSha256, receiptSha256 } =
  await verifyA8B6CompositeReceipt(options.planId, root)
const { approval } = verifyA8B6WorkflowApprovalSync(options.planId, root)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let row, source
try {
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const rows = (await db.query('SELECT id, workflow_id, md5(result::text) AS result_md5, result FROM execution_records WHERE id = ANY($1::text[])',
    [[options.record, manifest.source.recordId]])).rows
  row = rows.find(item => item.id === options.record)
  source = rows.find(item => item.id === manifest.source.recordId)
  await db.query('COMMIT')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
if (!row || row.result_md5 !== options.expectedMd5
  || row.workflow_id !== 'wf-sanguo-history-drama'
  || !source || source.result_md5 !== manifest.source.resultMd5)
  fail('current or original source record and exact result MD5 differ')
const state = decodeExecutionState(row.result)
const shots = requireA8B6TwoShotRuns(state, row.id)
const first = shots.first, second = shots.second
const firstCompletion = assertA8B6ShotCompletion(first.script.output,
  first.accept.output)
const secondCompletion = assertA8B6ShotCompletion(second.script.output,
  second.accept.output)
const firstTake = first.video.output, firstEvidence = first.evidence.output,
  firstAccepted = first.accept.output, firstTail = first.last.output,
  secondTake = second.video.output, secondEvidence = second.evidence.output,
  secondAccepted = second.accept.output, secondOpening = second.firstFrame.output,
  secondCertificate = second.certificate.output, concat = second.concat.output
if (firstTake?.url !== receipt.output.url
  || sceneCutShotSha256(first.script.output) !== receipt.workflowApproval.amendedShotSha256
  || first.certificate.output?.signature !== approval.sceneCutFrameApprovalSignature
  || first.certificate.output?.shotSha256 !== receipt.workflowApproval.amendedShotSha256
  || first.script.output?.scheduleHash !== receipt.workflowApproval.amendedScheduleHash
  || firstEvidence?.originalUrl !== receipt.output.url
  || firstEvidence?.sha256 !== receipt.output.sha256
  || firstAccepted?.sha256 !== receipt.output.sha256
  || firstAccepted?.url !== firstEvidence.url
  || first.review.output?.decision !== 'pass' || firstAccepted.passed !== true
  || firstTail?.available !== true || firstTail.url !== firstEvidence.lastFrameUrl
  || firstTail.source !== 'extracted-from-video'
  || secondTake?.url !== secondEvidence?.originalUrl
  || secondEvidence?.sha256 !== secondAccepted?.sha256
  || secondAccepted?.url !== secondEvidence?.url
  || second.review.output?.decision !== 'pass' || secondAccepted?.passed !== true
  || second.last.output?.url !== secondEvidence.lastFrameUrl
  || secondOpening?.previousLastFrame !== firstTail.url)
  fail('paid media, workflow acceptance or actual first-tail lineage differs')
verifySceneCutFrameApproval(first.certificate.output, root)
verifySceneCutFrameApproval(secondCertificate, root)
const tailFile = localGeneratedImage(firstTail.url)
const tailSha = sha(await readFile(tailFile))
if (secondCertificate?.priorTail?.sourceUrl !== firstTail.url
  || secondCertificate?.sourceSha256s?.at(-1) !== tailSha
  || secondCertificate?.approvedEllipsis?.priorVideoSha256 !== receipt.output.sha256
  || secondCertificate?.approvedEllipsis?.priorTailSha256 !== tailSha
  || secondEvidence?.sceneCutOutputFirstFrame?.status !== 'matched'
  || secondEvidence.sceneCutOutputFirstFrame.approvalSignature !== secondCertificate.signature
  || secondEvidence.sceneCutOutputFirstFrame.outputVideoSha256 !== secondEvidence.sha256
  || secondEvidence.sceneCutOutputFirstFrame.candidateSha256 !== secondCertificate.sourceSha256s[0])
  fail('second paid first-frame certificate does not bind actual first tail or decoded opening')
if (concat?.count !== 2 || concat?.concatMode !== 'normalized-stream-copy'
  || concat?.resolution !== '720p' || concat.width !== 1280
  || concat.height !== 720 || concat.fps !== 24 || concat.audioSampleRate !== 48000
  || concat.clips?.[0]?.url !== firstAccepted.url
  || concat.clips?.[1]?.url !== secondAccepted.url
  || concat.sourceSha256?.[0] !== receipt.output.sha256
  || concat.sourceSha256?.[1] !== secondAccepted.sha256)
  fail('two-shot concat sources or normalization profile differ')

const firstFile = await checkedFile(firstAccepted.url, receipt.output.sha256)
const secondFile = await checkedFile(secondAccepted.url, secondAccepted.sha256)
const concatFile = localGenerated(concat.url, 'mp4')
const concatSha = sha(await readFile(concatFile))
const secondNative = await decodedFrames(secondFile)
const nativeTiming = assertA8B6NativeSecondTiming(secondNative)
if (secondEvidence.decoded !== true
  || Math.abs(Number(secondEvidence.duration) - 10) > .15)
  fail('second decoded evidence duration differs from approved native PTS window')
const normalizedPrefix = path.join(root, '.runtime/video-concat-sources',
  'normalized-v3-720p-1280x720-24fps-48k-')
const [normalizedFirst, normalizedSecond] = await Promise.all([
  decodedFrames(`${normalizedPrefix}${receipt.output.sha256}.mp4`),
  decodedFrames(`${normalizedPrefix}${secondAccepted.sha256}.mp4`),
])
const concatFrames = await decodedFrames(concatFile)
const frameMapping = assertA8B6ConcatFrames(normalizedFirst,
  normalizedSecond, concatFrames, secondNative)
const firstNative = await decodedFrames(firstFile)
if (firstNative.hashes.length !== 337
  || firstNative.pts.some((pts, index) => pts !== index)
  || firstNative.frameDigestSha256 !== receipt.output.nativeFrameDigestSha256)
  fail('formal first-shot native frame sequence differs from signed 337-frame receipt')
const [firstAudio, secondAudio, concatAudio, secondPcm] = await Promise.all([
  adts(`${normalizedPrefix}${receipt.output.sha256}.mp4`),
  adts(`${normalizedPrefix}${secondAccepted.sha256}.mp4`),
  adts(concatFile),
  ffmpegBytes(['-i', secondFile, '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], 4 * 1024 * 1024),
])
if (!Buffer.concat([firstAudio, secondAudio]).equals(concatAudio))
  fail('two-shot concat changed AAC packets or audio clip order')
if (secondPcm.length % 4 || secondPcm.length < 16000 * 4 * 9.85)
  fail('second-shot decoded PCM tail is missing or sample alignment changed')
const secondSpeechSource = { videoSha256: secondAccepted.sha256,
  evidenceVideoSha256: secondEvidence.sha256,
  nativeTiming, decodedAudioSampleCount: secondPcm.length / 4 }
const independentReportBytes = await readFile(path.join(root,
  'qa/staged-scene-cut/a8b6-14s-narration-transfer.json'))
if (sha(independentReportBytes) !== AUDIO_REPORT_SHA)
  fail('independent first-shot decoded audio report changed')
const independentReport = JSON.parse(independentReportBytes.toString('utf8'))
const independentAudioBoundary = assertA8B6SpeechBoundary(independentReport,
  secondEvidence.speechValidation, receipt, secondSpeechSource)
const workflowAudioBoundary = assertA8B6SpeechBoundary(
  firstEvidence.independentNarrationTransfer,
  secondEvidence.speechValidation, receipt, secondSpeechSource)
const firstTailPcm = await ffmpegBytes(['-ss', '12.5', '-i', firstFile,
  '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
4 * 1024 * 1024)
if (firstTailPcm.length % 4) fail('first-shot tail PCM sample alignment is invalid')
let maxTailAmplitude = 0
for (let index = 0; index < firstTailPcm.length; index += 4)
  maxTailAmplitude = Math.max(maxTailAmplitude,
    Math.abs(firstTailPcm.readFloatLE(index)))
if (firstTailPcm.length < 16000 * 4 * 1.4 || maxTailAmplitude > .001)
  fail('first-shot audio is not silent well before the two-shot cut')
const actualFirstTail = await frameJpeg(firstFile, 336)
const actualSecondOpening = await frameJpeg(secondFile, 0)
const savedTailDifference = await reducedDifference(actualFirstTail,
  await readFile(tailFile))
if (savedTailDifference > .08)
  fail('node64 saved tail is visibly different from first-shot native final frame')
const approvedOpeningFile = localGeneratedImage(secondCertificate.frame.sourceUrl)
const approvedOpeningDifference = await reducedDifference(actualSecondOpening,
  await readFile(approvedOpeningFile))
const sheet = options.contactSheet ? await contactSheet(firstFile, secondFile,
  firstTail.url, secondCertificate.frame.sourceUrl, nativeTiming.nativeFrameCount) : null

const finalDb = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await finalDb.connect()
try {
  await finalDb.query('BEGIN READ ONLY')
  const currentMd5 = (await finalDb.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
    [row.id])).rows[0]?.md5
  await finalDb.query('COMMIT')
  if (currentMd5 !== row.result_md5) fail('record changed during read-only media audit')
} catch (error) {
  await finalDb.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await finalDb.end() }

console.log(JSON.stringify({ version: 'sanguo-a8b6-two-shot-readonly-v1',
  recordId: row.id, recordResultMd5: row.result_md5,
  sourceRecordId: source.id, sourceResultMd5: source.result_md5,
  qaPlanId: options.planId, manifestSha256, compositeReceiptSha256: receiptSha256,
  first: { approvedSeconds: 14, nativeFrames: firstNative.hashes.length,
    acceptedVideoSha256: receipt.output.sha256,
    completion: firstCompletion,
    actualTailUrl: firstTail.url, actualTailSha256: tailSha,
    savedTailPixelDifference96x54: savedTailDifference },
  second: { approvedSeconds: 10, nativeTiming,
    acceptedVideoSha256: secondAccepted.sha256,
    completion: secondCompletion,
    firstFrameCertificateSignature: secondCertificate.signature,
    nativeFirstVsApprovedPixelDifference96x54: approvedOpeningDifference,
    speechValidation: secondEvidence.speechValidation?.passed === true },
  concat: { url: concat.url, sha256: concatSha, frameMapping,
    normalizedAudioPacketOrder: 'identical',
    containerDurationEqualityTo24SecondsRequired: false },
  speech: { independentAudioBoundary, workflowAudioBoundary,
    firstShotTailPcmMaxAmplitude: maxTailAmplitude,
    independentReportSha256: AUDIO_REPORT_SHA,
    scope: 'decoded audio transfer/alignment and AAC packet order; not human listening' },
  visualContinuity: { firstTailToSecondFirst: 'pending-direct-original-speed-review',
    spatialLayout: 'pending-direct-original-speed-review',
    costumesAndIdentity: 'pending-direct-original-speed-review',
    tiedWristAndRope: 'pending-direct-original-speed-review',
    whole24SecondPacing: 'pending-direct-original-speed-review',
    ...(sheet ? { contactSheet: sheet } : {}) },
  technicalVerdict: 'pass', subjectiveVerdict: 'pending-direct-original-speed-review',
  providerCalls: 0, databaseWrites: 0,
  qaContactSheetWrites: sheet ? 1 : 0 }, null, 2))
