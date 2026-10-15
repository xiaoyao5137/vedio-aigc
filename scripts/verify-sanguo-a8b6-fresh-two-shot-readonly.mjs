#!/usr/bin/env node
/** Read-only technical audit of one genuinely new A8+B6 first shot followed by
 * one genuinely new ten-second dialogue shot. Visual judgment stays separate. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { verifySceneCutFrameApproval } from
  '../server/scene-cut-frame-approval.ts'
import { verifyFreshA8B6CompositeReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'
import { readFreshA8B6Artifact } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { inspectNewFirstShotForHistoricalReuse } from
  './audit-original-second-shot-media-reuse.mjs'
import { assertA8B6ConcatFrames, assertA8B6NativeSecondTiming,
  assertA8B6ShotCompletion, assertA8B6SpeechBoundary,
  parseA8B6FrameMd5, requireA8B6TwoShotRuns } from
  '../server/sanguo-a8b6-two-shot-qa.mjs'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const root = path.resolve(import.meta.dirname, '..')
const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/
const fail = reason => { throw Error(`SANGUO_FRESH_TWO_SHOT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const options = {}
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  const name = { '--record': 'recordId', '--expected-md5': 'resultMd5',
    '--first-record': 'firstRecordId',
    '--expected-first-md5': 'firstResultMd5', '--plan-id': 'planId',
    '--contact-sheet': 'contactSheet' }[args[index]]
  if (!name || options[name] || !args[index + 1]
    || args[index + 1].startsWith('--')) fail(`unexpected ${args[index]}`)
  options[name] = args[++index]
}
if (!/^record-[\w-]+$/.test(options.recordId ?? '')
  || !/^record-[\w-]+$/.test(options.firstRecordId ?? '')
  || !MD5.test(options.resultMd5 ?? '')
  || !MD5.test(options.firstResultMd5 ?? '')
  || !SHA.test(options.planId ?? '')
  || options.contactSheet && (!/^qa\/staged-scene-cut\/[\w.-]+\.png$/.test(
    options.contactSheet) || options.contactSheet.includes('..')))
  fail('requires exact final/first record IDs and MD5, fresh plan ID, optional QA sheet')

const local = url => {
  if (typeof url !== 'string'
    || !/^\/generated\/[\w.-]+\.mp4$/i.test(url))
    fail('generated media path invalid')
  return path.join(root, 'public', url.slice(1))
}
const imageFile = url => {
  if (typeof url !== 'string'
    || !/^\/generated\/[\w.-]+\.(?:jpe?g|png)$/.test(url))
    fail('generated frame path invalid')
  return path.join(root, 'public', url.slice(1))
}
const checked = async (url, digest) => {
  if (!SHA.test(String(digest))) fail('saved video lacks SHA256')
  const filename = local(url)
  if (sha(await readFile(filename)) !== digest) fail('saved video bytes changed')
  return filename
}
const ffmpegBytes = async (args, maxBuffer = 16 * 1024 * 1024) => {
  const { stdout } = await exec(ffmpeg, ['-hide_banner', '-nostdin',
    '-v', 'error', '-xerror', ...args], { encoding: 'buffer',
    timeout: 180000, maxBuffer })
  if (!Buffer.isBuffer(stdout)) fail('FFmpeg produced no decoded bytes')
  return stdout
}
const decoded = async filename => parseA8B6FrameMd5((await ffmpegBytes([
  '-i', filename, '-map', '0:v:0', '-an', '-vsync', '0',
  '-f', 'framemd5', '-'], 5 * 1024 * 1024)).toString('utf8'))
const adts = filename => ffmpegBytes(['-i', filename, '-map', '0:a:0',
  '-vn', '-c:a', 'copy', '-f', 'adts', '-'])
const frameJpeg = (filename, index) => ffmpegBytes(['-i', filename,
  '-map', '0:v:0', '-an', '-vf', `select=eq(n\\,${index})`,
  '-vsync', 'vfr', '-frames:v', '1', '-q:v', '2',
  '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], 20 * 1024 * 1024)
async function reducedDifference(left, right) {
  const [a, b] = await Promise.all([left, right].map(bytes => sharp(bytes)
    .resize(96, 54, { fit: 'fill' }).removeAlpha().raw().toBuffer()))
  return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0)
    / (a.length * 255)
}
async function makeSheet(firstFile, secondFile, firstCount, secondCount,
  savedTailUrl, approvedOpeningUrl) {
  const frames = [
    { label: `first native f${firstCount - 1}`,
      bytes: await frameJpeg(firstFile, firstCount - 1) },
    { label: 'first saved tail', bytes: await readFile(imageFile(savedTailUrl)) },
    { label: 'second approved image',
      bytes: await readFile(imageFile(approvedOpeningUrl)) },
    { label: 'second native f0', bytes: await frameJpeg(secondFile, 0) },
    ...[1, 12, 24, 72, 120, secondCount - 1].map(index => ({
      label: `second native f${index}`,
      filename: secondFile, index }))]
  const width = 480, height = 300, composites = []
  for (const [index, frame] of frames.entries()) {
    const bytes = frame.bytes ?? await frameJpeg(frame.filename, frame.index)
    const x = index % 2 * width, y = Math.floor(index / 2) * height
    const tile = await sharp(bytes).resize(width, 270, { fit: 'fill' }).toBuffer()
    const label = Buffer.from(`<svg width="${width}" height="30"><rect width="100%" height="100%" fill="#171717"/><text x="12" y="21" fill="white" font-family="sans-serif" font-size="17">${frame.label}</text></svg>`)
    composites.push({ input: tile, left: x, top: y },
      { input: label, left: x, top: y + 270 })
  }
  const output = path.join(root, options.contactSheet)
  await mkdir(path.dirname(output), { recursive: true })
  await sharp({ create: { width: width * 2,
    height: height * Math.ceil(frames.length / 2), channels: 3,
    background: '#171717' } }).composite(composites).png().toFile(output)
  return { path: output, sha256: sha(await readFile(output)),
    status: 'direct visual review aid; no semantic verdict' }
}

const verified = await verifyFreshA8B6CompositeReceipt(options.planId, root)
const { receipt, manifestSha256, receiptSha256 } = verified
const transfer = await readFreshA8B6Artifact(options.planId,
  'narration-transfer.json', root)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let finalRow, firstRow, routerRow, approvalRow, originalRow, lineageDepth
try {
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const row = async id => (await db.query(`SELECT id,workflow_id,result,
    md5(result::text) AS result_md5 FROM execution_records WHERE id=$1`,
  [id])).rows[0]
  finalRow = await row(options.recordId)
  firstRow = await row(options.firstRecordId)
  originalRow = await row('record-4x5m31')
  const marker = decodeExecutionState(firstRow?.result)
    ?.sceneCutCompositeRecovery
  routerRow = marker?.sourceExecutionId && await row(marker.sourceExecutionId)
  approvalRow = marker?.imageApprovalExecutionId
    && await row(marker.imageApprovalExecutionId)
  if (finalRow?.result_md5 !== options.resultMd5
    || firstRow?.result_md5 !== options.firstResultMd5
    || !routerRow || !approvalRow || !originalRow)
    fail('final/first/ancestor source MD5 or record missing')
  const firstState = decodeExecutionState(firstRow.result)
  const prefix = firstState.nodeRuns.slice(0, 65)
  let current = finalRow, reached = false
  for (let depth = 0; depth < 16; depth++) {
    const state = decodeExecutionState(current.result)
    if (!isDeepStrictEqual(state.nodeRuns.slice(0, 65), prefix))
      fail('second-shot fork changed first-shot nodes')
    if (current.id === firstRow.id) {
      reached = true; lineageDepth = depth; break
    }
    if (!state.parentExecutionId || state.parentExecutionId === current.id)
      fail('second-shot fork ancestry is incomplete')
    current = await row(state.parentExecutionId)
    if (!current) fail('second-shot ancestor missing')
  }
  if (!reached) fail('final record did not descend from accepted first shot')
  await db.query('COMMIT')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
const firstReady = inspectNewFirstShotForHistoricalReuse(firstRow,
  originalRow, routerRow, root, approvalRow)
if (firstReady.firstShotReady !== true
  || firstReady.firstShotLineage?.receiptSha256 !== receiptSha256
  || firstReady.firstShotLineage.manifestSha256 !== manifestSha256
  || firstReady.newFirstVideoSha256 !== receipt.output.sha256
  || firstReady.firstShotLineage.nativeFrameCount
    !== receipt.output.frameCount)
  fail('first shot in same record is not the accepted fresh composite')
const state = decodeExecutionState(finalRow.result)
const shots = requireA8B6TwoShotRuns(state, finalRow.id)
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
  || firstEvidence?.originalUrl !== receipt.output.url
  || firstEvidence?.sha256 !== receipt.output.sha256
  || firstAccepted?.sha256 !== receipt.output.sha256
  || firstAccepted?.url !== firstEvidence.url
  || first.review.output?.decision !== 'pass'
  || firstTail?.available !== true
  || firstTail.url !== firstEvidence.lastFrameUrl
  || firstTail.source !== 'extracted-from-video'
  || secondTake?.url !== secondEvidence?.originalUrl
  || secondEvidence?.sha256 !== secondAccepted?.sha256
  || secondAccepted?.url !== secondEvidence?.url
  || second.review.output?.decision !== 'pass'
  || second.last.output?.url !== secondEvidence.lastFrameUrl
  || secondOpening?.previousLastFrame !== firstTail.url)
  fail('consecutive paid clips or accepted actual tail changed')
verifySceneCutFrameApproval(first.certificate.output, root)
verifySceneCutFrameApproval(secondCertificate, root)
const tailSha = sha(await readFile(imageFile(firstTail.url)))
if (secondCertificate?.priorTail?.sourceUrl !== firstTail.url
  || secondCertificate?.sourceSha256s?.at(-1) !== tailSha
  || secondCertificate?.approvedEllipsis?.priorVideoSha256
    !== receipt.output.sha256
  || secondCertificate?.approvedEllipsis?.priorTailSha256 !== tailSha
  || secondEvidence?.sceneCutOutputFirstFrame?.status !== 'matched'
  || secondEvidence.sceneCutOutputFirstFrame.approvalSignature
    !== secondCertificate.signature
  || secondEvidence.sceneCutOutputFirstFrame.outputVideoSha256
    !== secondEvidence.sha256
  || secondEvidence.sceneCutOutputFirstFrame.candidateSha256
    !== secondCertificate.sourceSha256s[0])
  fail('second image and native frame0 are not bound to first actual tail')
if (concat?.count !== 2 || concat?.concatMode !== 'normalized-stream-copy'
  || concat?.resolution !== '720p' || concat.width !== 1280
  || concat.height !== 720 || concat.fps !== 24
  || concat.audioSampleRate !== 48000
  || concat.clips?.[0]?.url !== firstAccepted.url
  || concat.clips?.[1]?.url !== secondAccepted.url
  || concat.sourceSha256?.[0] !== receipt.output.sha256
  || concat.sourceSha256?.[1] !== secondAccepted.sha256)
  fail('two-shot concat is not the approved 14+10 normalized cut')
const firstFile = await checked(firstAccepted.url, receipt.output.sha256)
const secondFile = await checked(secondAccepted.url, secondAccepted.sha256)
const concatFile = local(concat.url)
const concatSha = sha(await readFile(concatFile))
const nativeFirst = await decoded(firstFile)
const nativeSecond = await decoded(secondFile)
const nativeSecondTiming = assertA8B6NativeSecondTiming(nativeSecond)
if (nativeFirst.hashes.length !== receipt.output.frameCount
  || nativeFirst.frameDigestSha256
    !== receipt.output.nativeFrameDigestSha256
  || nativeFirst.pts.some((pts, index) => pts !== index)
  || secondEvidence.decoded !== true
  || Math.abs(Number(secondEvidence.duration) - 10) > .15)
  fail('new native source video PTS or accepted duration changed')
const normalizedPrefix = path.join(root, '.runtime/video-concat-sources',
  'normalized-v3-720p-1280x720-24fps-48k-')
const [normalizedFirst, normalizedSecond, concatFrames] = await Promise.all([
  decoded(`${normalizedPrefix}${receipt.output.sha256}.mp4`),
  decoded(`${normalizedPrefix}${secondAccepted.sha256}.mp4`),
  decoded(concatFile)])
const frameMapping = assertA8B6ConcatFrames(normalizedFirst,
  normalizedSecond, concatFrames, nativeSecond, receipt.output.frameCount)
const [firstAudio, secondAudio, concatAudio, secondPcm] = await Promise.all([
  adts(`${normalizedPrefix}${receipt.output.sha256}.mp4`),
  adts(`${normalizedPrefix}${secondAccepted.sha256}.mp4`),
  adts(concatFile),
  ffmpegBytes(['-i', secondFile, '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], 4 * 1024 * 1024)])
if (!Buffer.concat([firstAudio, secondAudio]).equals(concatAudio))
  fail('concat altered AAC packets or clip order')
if (secondPcm.length % 4 || secondPcm.length < 16000 * 4 * 9.85)
  fail('second-shot decoded PCM tail is missing or sample alignment changed')
const secondSpeechSource = { videoSha256: secondAccepted.sha256,
  evidenceVideoSha256: secondEvidence.sha256,
  nativeTiming: nativeSecondTiming,
  decodedAudioSampleCount: secondPcm.length / 4 }
const signedAudioBoundary = assertA8B6SpeechBoundary(transfer.value,
  secondEvidence.speechValidation, receipt, secondSpeechSource)
const workflowAudioBoundary = assertA8B6SpeechBoundary(
  firstEvidence.independentNarrationTransfer,
  secondEvidence.speechValidation, receipt, secondSpeechSource)
const firstTailPcm = await ffmpegBytes(['-ss',
  String(Math.max(0, receipt.output.frameCount / 24 - 1.5)),
  '-i', firstFile, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
  '-f', 'f32le', '-'], 4 * 1024 * 1024)
if (firstTailPcm.length % 4 || firstTailPcm.length < 16000 * 4 * 1.3)
  fail('first-shot decoded audio tail is missing')
let maxTailAmplitude = 0
for (let index = 0; index < firstTailPcm.length; index += 4)
  maxTailAmplitude = Math.max(maxTailAmplitude,
    Math.abs(firstTailPcm.readFloatLE(index)))
if (maxTailAmplitude > .001)
  fail('first-shot narration or other sound reaches the scene cut')
const firstNativeTail = await frameJpeg(firstFile,
  receipt.output.frameCount - 1)
const savedTailDifference = await reducedDifference(firstNativeTail,
  await readFile(imageFile(firstTail.url)))
if (savedTailDifference > .08)
  fail('saved first tail differs from narrated native last frame')
const secondNativeFirst = await frameJpeg(secondFile, 0)
const openingDifference = await reducedDifference(secondNativeFirst,
  await readFile(imageFile(secondCertificate.frame.sourceUrl)))
const sheet = options.contactSheet ? await makeSheet(firstFile, secondFile,
  receipt.output.frameCount, nativeSecondTiming.nativeFrameCount,
  firstTail.url, secondCertificate.frame.sourceUrl) : undefined
const dbAgain = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await dbAgain.connect()
try {
  const current = (await dbAgain.query(`SELECT md5(result::text) AS md5
    FROM execution_records WHERE id=$1`, [finalRow.id])).rows[0]
  if (current?.md5 !== options.resultMd5)
    fail('two-shot record changed during read-only audit')
} finally { await dbAgain.end() }
console.log(JSON.stringify({ version: 'sanguo-a8b6-fresh-two-shot-readonly-v1',
  recordId: finalRow.id, resultMd5: finalRow.result_md5,
  firstRecordId: firstRow.id, firstResultMd5: firstRow.result_md5,
  ancestryDepthToFirst: lineageDepth, planId: options.planId,
  manifestSha256, receiptSha256,
  first: { approvedSeconds: 14, nativeFrames: nativeFirst.hashes.length,
    videoSha256: receipt.output.sha256, completion: firstCompletion,
    actualTailUrl: firstTail.url, actualTailSha256: tailSha,
    savedTailPixelDifference96x54: savedTailDifference },
  second: { approvedSeconds: 10, nativeTiming: nativeSecondTiming,
    videoSha256: secondAccepted.sha256, completion: secondCompletion,
    firstFrameCertificateSignature: secondCertificate.signature,
    nativeFirstVsApprovedPixelDifference96x54: openingDifference,
    speechValidationPassed: secondEvidence.speechValidation?.passed === true },
  concat: { url: concat.url, sha256: concatSha, frameMapping,
    normalizedAudioPacketOrder: 'identical',
    containerDurationEqualityTo24SecondsRequired: false },
  audio: { signedAudioBoundary, workflowAudioBoundary,
    firstTailPcmMaxAmplitude: maxTailAmplitude,
    scope: 'decoded TTS transfer, dialogue alignment and AAC packets; no human listening claim' },
  visualContinuity: { firstTailToSecondFirst: 'pending-direct-original-speed-review',
    spatialLayout: 'pending-direct-original-speed-review',
    costumesAndIdentity: 'pending-direct-original-speed-review',
    tiedWristAndRope: 'pending-direct-original-speed-review',
    whole24SecondPacing: 'pending-direct-original-speed-review',
    ...(sheet ? { contactSheet: sheet } : {}) },
  technicalVerdict: 'pass', subjectiveVerdict: 'pending-direct-original-speed-review',
  providerCalls: 0, databaseWrites: 0,
  qaContactSheetWrites: sheet ? 1 : 0 }, null, 2))
