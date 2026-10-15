/** QA-only, source-bound 14 second reuse of the two already paid native clips.
 * A8+B6 changes the approved 13 second timing. This module cannot accept a
 * shot, submit a provider request, or fork the original workflow. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { inspectStagedNativeVideo } from './staged-scene-cut.mjs'
import { readA8B5BRejection } from './staged-scene-cut-a8b5.mjs'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const SHA = /^[a-f0-9]{64}$/
const INVALID = message => { throw Error(`STAGED_A8B6_QA_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const stageDirectory = (root, planId) => {
  if (!SHA.test(String(planId))) INVALID('source plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b5', planId)
}
const qaDirectory = (root, planId) => {
  if (!SHA.test(String(planId))) INVALID('QA plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b6-qa', planId)
}
function generatedVideo(root, url, prefix) {
  if (typeof url !== 'string' || !new RegExp(`^/generated/${prefix}[\\w.-]+\\.mp4$`).test(url)
    || url.includes('..')) INVALID('QA generated video URL invalid')
  return path.join(root, 'public', url.slice(1))
}
async function signingKey(root) {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) INVALID('source signing key invalid')
  return key
}
function signature(value, key) {
  const { signature: _signature, ...body } = value
  void _signature
  return createHmac('sha256', key).update(canonical(body)).digest('hex')
}
function verifySignature(value, key) {
  const actual = String(value?.signature ?? ''), expected = signature(value, key)
  if (!SHA.test(actual) || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')))
    INVALID('signed QA plan changed')
}
async function writeOnce(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true })
  const bytes = Buffer.from(value)
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      INVALID(`existing QA artifact differs: ${filename}`)
  }
}
async function checkedSha(filename, expected) {
  if (!SHA.test(String(expected))) INVALID('source asset hash missing')
  const digest = sha256(await readFile(filename))
  if (digest !== expected) INVALID(`source asset changed: ${filename}`)
  return digest
}
async function nativeJpeg(filename, index) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${index})`, '-vsync', 'vfr', '-frames:v', '1',
    '-q:v', '2', '-f', 'image2', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 20 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 1000 || stdout[0] !== 0xff || stdout[1] !== 0xd8)
    INVALID(`native frame ${index} did not decode`)
  return sha256(stdout)
}
async function assertSilentAudio(filename) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 16000 * 4 * 13.9 || stdout.length % 4)
    INVALID('QA picture silent audio missing or truncated')
  for (let offset = 0; offset < stdout.length; offset += 4)
    if (Math.abs(stdout.readFloatLE(offset)) > .00001)
      INVALID('QA picture still contains provider source audio')
}
async function verifyQaPictureMapping(phaseAFile, phaseBFile, pictureFile) {
  const filter = '[0:v]trim=start_frame=0:end_frame=193,setpts=PTS-STARTPTS[a];'
    + '[1:v]trim=start_frame=1:end_frame=145,setpts=PTS-STARTPTS[b];'
    + '[a][b]concat=n=2:v=1:a=0[expected];[expected][2:v]ssim=stats_file=-'
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror',
    '-i', phaseAFile, '-i', phaseBFile, '-i', pictureFile,
    '-filter_complex', filter, '-an', '-f', 'null', '/dev/null'],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 })
  const lines = stdout.trim().split(/\r?\n/)
  if (lines.length !== 337) INVALID('QA picture mapping frame count differs from A8+B6')
  const scores = lines.map((line, index) => {
    const match = /^n:(\d+) Y:([\d.]+) U:([\d.]+) V:([\d.]+) All:([\d.]+)/.exec(line)
    if (!match || Number(match[1]) !== index + 1)
      INVALID('QA picture mapping lacks consecutive frame-level comparison')
    return Number(match[5])
  })
  const min = Math.min(...scores), mean = scores.reduce((a, b) => a + b, 0) / scores.length
  if (min < .975 || mean < .985)
    INVALID('QA picture does not closely match original-speed A0–192 plus B1–144')
  return { version: 'a8b6-qa-source-frame-ssim-v1', frameCount: scores.length,
    perFrameStatsSha256: sha256(stdout.trim()), minAll: min, meanAll: mean,
    minimumRequired: .975, meanRequired: .985 }
}
async function verifyNarratedPictureMatch(pictureFile, narratedFile) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror',
    '-i', pictureFile, '-i', narratedFile,
    '-filter_complex', '[0:v][1:v]ssim=stats_file=-',
    '-an', '-f', 'null', '/dev/null'],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 })
  const lines = stdout.trim().split(/\r?\n/)
  if (lines.length !== 337) INVALID('narrated QA video has different frame count')
  const scores = lines.map((line, index) => {
    const match = /^n:(\d+) Y:([\d.]+) U:([\d.]+) V:([\d.]+) All:([\d.]+)/.exec(line)
    if (!match || Number(match[1]) !== index + 1)
      INVALID('narrated QA video frame mapping is discontinuous')
    return Number(match[5])
  })
  if (Math.min(...scores) < .985 || scores.reduce((a, b) => a + b, 0) / 337 < .99)
    INVALID('narrated QA picture differs from stitched picture')
}

export const A8B6_QA_MAPPING = Object.freeze({
  phaseA: { sourceStartFrame: 0, sourceEndFrame: 192,
    outputStartFrame: 0, outputEndFrame: 192 },
  phaseB: { sourceStartFrame: 1, sourceEndFrame: 144,
    outputStartFrame: 193, outputEndFrame: 336 },
})

export function mapA8B6QAFrame(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 337)
    INVALID('QA frame outside 14 second range')
  return index <= 192 ? { phase: 'A', sourceFrameIndex: index, outputFrameIndex: index }
    : { phase: 'B', sourceFrameIndex: index - 192, outputFrameIndex: index }
}

/** Read-only validation of exact source receipts, native frames and QA output. */
export async function planA8B6QA(retryPlanId, pictureUrl, narratedQaUrl,
  compositionReceiptKey, root = process.cwd()) {
  const { report: rejection, sha256: rejectionSha256 } =
    await readA8B5BRejection(retryPlanId, root)
  // readA8B5BRejection deeply verifies B media → task → signed retry plan →
  // rejected prior plan. Read those same signed bytes once more to bind this
  // QA manifest without repeating the expensive native A/B validation.
  const sourceDir = stageDirectory(root, retryPlanId)
  const key = await signingKey(root)
  const retry = JSON.parse(await readFile(path.join(sourceDir, 'manifest.json'), 'utf8'))
  const media = JSON.parse(await readFile(path.join(sourceDir, 'phase-B-media.json'), 'utf8'))
  verifySignature(retry, key)
  verifySignature(media, key)
  if (retry.version !== 'staged-scene-cut-a8b5-retry-b-v1'
    || retry.planId !== retryPlanId || media.planId !== retryPlanId
    || media.version !== 'staged-a8b5-retry-provider-media-v1'
    || retry.sourceAFrame.index !== 192 || retry.timeline.deliveredFrames !== 313
    || media.taskId !== '933827087445159950'
    || media.videoSha256 !== 'b3cbd5364aa7a8ab2ec22f6c2bc78b5655ea956b8653f35c6e3b6ea810a6762a'
    || rejection.taskId !== media.taskId || rejection.videoSha256 !== media.videoSha256
    || rejection.rejectionScope !== 'signed-a8b5-13s-timing-only; preserve-paid-native-B-for-separate-14s-QA'
    || !rejection.frames?.some(frame => frame.index === 36)
    || !rejection.frames?.some(frame => frame.index === 144))
    INVALID('QA source is not the exact rejected 13 second B paid clip')
  const sourceHashes = {
    retryManifestSha256: sha256(await readFile(path.join(sourceDir, 'manifest.json'))),
    retryBSubmitIntentSha256: sha256(await readFile(path.join(sourceDir, 'phase-B-submit-intent.json'))),
    retryBTaskSha256: sha256(await readFile(path.join(sourceDir, 'phase-B-task.json'))),
    retryBMediaSha256: sha256(await readFile(path.join(sourceDir, 'phase-B-media.json'))),
    retryBRejectionSha256: rejectionSha256,
  }
  const pictureFile = generatedVideo(root, pictureUrl, 'qa-unaccepted-a8b6-picture-')
  const finalFile = generatedVideo(root, narratedQaUrl, 'qa-unaccepted-a8b6-narrated-')
  const sourceAFile = path.join(root, 'public', retry.source.videoUrl.slice(1))
  const sourceBFile = path.join(root, 'public', media.videoUrl.slice(1))
  const pictureSha256 = sha256(await readFile(pictureFile))
  const finalSha256 = sha256(await readFile(finalFile))
  const picture = await inspectStagedNativeVideo(pictureFile, 337, 14)
  const final = await inspectStagedNativeVideo(finalFile, 337, 14)
  await assertSilentAudio(pictureFile)
  const sourceFrameMatch = await verifyQaPictureMapping(sourceAFile, sourceBFile, pictureFile)
  await verifyNarratedPictureMatch(pictureFile, finalFile)
  const [Aframe192Sha256, Bframe0Sha256, Bframe1Sha256, Bframe120Sha256, Bframe144Sha256] =
    await Promise.all([
      nativeJpeg(sourceAFile, 192),
      nativeJpeg(sourceBFile, 0),
      nativeJpeg(sourceBFile, 1),
      nativeJpeg(sourceBFile, 120),
      nativeJpeg(sourceBFile, 144),
    ])
  if (Aframe192Sha256 !== retry.sourceAFrame.sha256
    || Bframe0Sha256 !== rejection.frames.find(frame => frame.index === 0)?.sha256
    || Bframe1Sha256 !== rejection.frames.find(frame => frame.index === 1)?.sha256
    || Bframe120Sha256 !== rejection.frames.find(frame => frame.index === 120)?.sha256
    || Bframe144Sha256 !== rejection.frames.find(frame => frame.index === 144)?.sha256)
    INVALID('QA seam or end evidence changed')
  const trackStarts = retry.narrationTracks.map(track => track.start)
  if (canonical(trackStarts) !== canonical([0, 2.5, 9.5])
    || retry.narrationTracks[2].end !== 11.75)
    INVALID('original TTS placement changed')
  for (const track of retry.narrationTracks)
    await checkedSha(path.join(root, 'public', track.url.slice(1)), track.sha256)
  if (!SHA.test(String(compositionReceiptKey)))
    INVALID('standard narration composition key missing')
  const compositionBytes = await readFile(path.join(root, '.runtime/narration-compositions',
    `${compositionReceiptKey}.json`))
  const compositionSha256 = sha256(compositionBytes)
  const composition = JSON.parse(compositionBytes.toString('utf8'))
  if (composition.version !== 'narration-composition-v1'
    || composition.key !== compositionReceiptKey || composition.mixerVersion !== 6
    || composition.outputUrl !== `/generated/narrated-${compositionReceiptKey}.mp4`
    || composition.pictureSha256 !== pictureSha256
    || composition.outputSha256 !== finalSha256
    || composition.audioRole !== 'narration'
    || canonical(composition.tracks) !== canonical(retry.narrationTracks)
    || composition.pictureVoiceIsolation?.status !== 'fully-muted-unverified'
    || composition.pictureVoiceIsolation.sourceSha256 !== pictureSha256
    || composition.pictureVoiceIsolation.preservedOutsideWindows !== false
    || !composition.pictureVoiceIsolation.mutedWindows?.some(window =>
      window.start <= 0 && window.end >= 14))
    INVALID('QA output does not use original three TTS and full source mute')
  await checkedSha(path.join(root, 'public', composition.outputUrl.slice(1)), finalSha256)
  const body = { version: 'staged-scene-cut-a8b6-qa-v1',
    source: { recordId: retry.source.recordId, resultMd5: retry.source.resultMd5,
      approvedShotSha256: retry.source.approvedShotSha256,
      approvalSha256: retry.source.approvalSha256,
      originalAPlanId: retry.source.planId,
      originalARejectionSha256: retry.source.rejectionSha256,
      originalATaskId: retry.source.taskId,
      originalARequestSha256: retry.source.requestSha256,
      originalAVideoUrl: retry.source.videoUrl,
      originalAVideoSha256: retry.source.videoSha256,
      originalANativeFrameDigestSha256: retry.source.nativeFrameDigestSha256,
      retryPlanId, ...sourceHashes,
      BTaskId: media.taskId, BVideoUrl: media.videoUrl,
      BVideoSha256: media.videoSha256,
      BNativeFrameDigestSha256: media.nativeFrameDigestSha256 },
    mapping: A8B6_QA_MAPPING,
    picture: { url: pictureUrl, sha256: pictureSha256,
      nativeFrameDigestSha256: picture.frameDigestSha256,
      fps: 24, frameCount: 337, lastPts: 14, silentAudio: true,
      sourceFrameMatch },
    narration: { qaUrl: narratedQaUrl, qaSha256: finalSha256,
      compositionUrl: composition.outputUrl,
      compositionReceiptKey, compositionReceiptSha256: compositionSha256,
      nativeFrameDigestSha256: final.frameDigestSha256,
      mixerVersion: 6, fullSourceMute: true,
      tracks: retry.narrationTracks },
    seam: { phaseAFrameIndex: 192, phaseAFrameSha256: Aframe192Sha256,
      phaseBFirstFrameIndex: 0, phaseBFirstFrameSha256: Bframe0Sha256,
      stitchedPhaseBStartFrameIndex: 1, phaseBFrame1Sha256: Bframe1Sha256,
      phaseBFinalFrameIndex: 144, phaseBFinalFrameSha256: Bframe144Sha256,
      phaseBFrame120Sha256: Bframe120Sha256 },
    observedNativeFrames: rejection.frames.map(({ index, sha256: frameSha256 }) =>
      ({ phase: 'B', index, sha256: frameSha256 })),
    timingDeviation: { originalApprovedShotSeconds: 13,
      qaCandidateSeconds: 14, addedSeconds: 1,
      originalStopDeadline: { globalSeconds: 9.5, BFrameIndex: 36 },
      observedProgress: 'Zhang approaches through B frames ~108–120; B f120–144 provides stable closing view',
      originalTtsStarts: [0, 2.5, 9.5], originalTtsEnds: [2.5, 7.1, 11.75],
      narration3Meaning: 'unchanged question now accompanies approach; pending original-speed creative review',
      stableVisualHold: { globalStartApproxSeconds: 13, globalEndSeconds: 14 },
      approvalState: 'creative and timing deviation awaiting direct whole-shot review' },
    acceptanceState: 'QA-only; no first-shot, seam, two-shot or workflow approval',
    providerCalls: 0 }
  return { ...body, planId: sha256(canonical(body)) }
}

export async function saveA8B6QAPlan(plan, root = process.cwd()) {
  const rebuilt = await planA8B6QA(plan?.source?.retryPlanId, plan?.picture?.url,
    plan?.narration?.qaUrl, plan?.narration?.compositionReceiptKey, root)
  if (rebuilt.planId !== plan?.planId) INVALID('reviewed QA plan changed')
  const signed = { ...rebuilt, signature: '' }
  signed.signature = signature(signed, await signingKey(root))
  const filename = path.join(qaDirectory(root, plan.planId), 'manifest.json')
  await writeOnce(filename, JSON.stringify(signed, null, 2) + '\n')
  return { planId: plan.planId, manifestPath: filename }
}

export async function readA8B6QAPlan(planId, root = process.cwd()) {
  const filename = path.join(qaDirectory(root, planId), 'manifest.json')
  const manifest = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(manifest, await signingKey(root))
  const rebuilt = await planA8B6QA(manifest.source?.retryPlanId, manifest.picture?.url,
    manifest.narration?.qaUrl, manifest.narration?.compositionReceiptKey, root)
  if (manifest.version !== 'staged-scene-cut-a8b6-qa-v1'
    || manifest.planId !== planId
    || canonical(manifest) !== canonical({ ...rebuilt, signature: manifest.signature }))
    INVALID('signed QA plan no longer matches paid native media and mixer')
  return manifest
}

const WHOLE_SHOT_CHECKS = Object.freeze([
  'A192HandsOffAndBContinuesWithdrawal',
  'seamMotionContinuous',
  'BWithdrawsWithoutRegrab',
  'boundWristsRemainVisible',
  'ZhangSettlesByB120',
  'stableClosingB120ToB144',
  'noSourceDialogueCanOverlapNarrationByMixerEvidence',
  'narration3DuringApproachIsNatural',
  'fourteenSecondCreativeTimingApproved',
])
const WHOLE_SHOT_FRAMES = Object.freeze([
  ['A', 192], ['B', 0], ['B', 1], ['B', 36],
  ['B', 108], ['B', 120], ['B', 132], ['B', 144],
])

function verifyWholeShotReview(report, manifest, root) {
  const expectedFrames = WHOLE_SHOT_FRAMES.map(([phase, index]) => ({ phase, index,
    sha256: phase === 'A' ? manifest.seam.phaseAFrameSha256
      : manifest.observedNativeFrames.find(frame => frame.index === index)?.sha256 }))
  const transferPath = 'qa/staged-scene-cut/a8b6-14s-narration-transfer.json'
  if (report?.audioEvidence?.transferEvidencePath !== transferPath
    || !SHA.test(report?.audioEvidence?.transferEvidenceSha256 ?? ''))
    INVALID('independent decoded narration transfer evidence missing')
  const transferFile = path.join(root, transferPath)
  checkedShaSync(transferFile, report.audioEvidence.transferEvidenceSha256)
  const transfer = JSON.parse(readFileSync(transferFile, 'utf8'))
  if (transfer.version !== 'independent-track-transfer-v1'
    || transfer.status !== 'confirmed'
    || transfer.originalUrl !== manifest.narration.compositionUrl
    || transfer.outputVideoSha256 !== manifest.narration.qaSha256
    || transfer.pictureSha256 !== manifest.picture.sha256
    || transfer.compositionReceiptSha256 !== manifest.narration.compositionReceiptSha256
    || transfer.decodedAudioDuration < 14
    || transfer.sourceSpeechIsolation?.status !== 'confirmed'
    || transfer.sourceSpeechIsolation.mode !== 'full-source-mute'
    || transfer.sourceSpeechIsolation.pictureSha256 !== manifest.picture.sha256
    || transfer.sourceSpeechIsolation.mixerVersion !== 6
    || transfer.scope !== 'source-TTS-phonetic-boundary-and-final-audio-transfer;not-pronunciation-or-human-listening'
    || transfer.lines?.length !== 3
    || transfer.lines.some((line, index) => line.status !== 'confirmed'
      || line.sourceAsr?.reliable !== true
      || line.fullWindow?.passed !== true || line.lastWordWindow?.passed !== true
      || line.sourceWavSha256 !== manifest.narration.tracks[index].sha256
      || line.scheduledStart !== manifest.narration.tracks[index].start
      || line.scheduledEnd !== manifest.narration.tracks[index].end))
    INVALID('independent decoded narration transfer does not confirm original tracks')
  if (report?.version !== 'staged-a8b6-whole-shot-review-v1'
    || report.planId !== manifest.planId
    || report.pictureSha256 !== manifest.picture.sha256
    || report.outputSha256 !== manifest.narration.qaSha256
    || report.reviewer !== 'Codex'
    || report.reviewMethod !== 'agent-direct-normal-speed-watch-and-decoded-audio-evidence'
    || !Number.isFinite(Date.parse(report.reviewedAt))
    || report.normalSpeedPlaybackReviewed !== true
    || report.verdict !== 'accept'
    || report.decisionScope !== '14s-first-shot-only; second-shot-pending'
    || report.audioEvidence?.pictureDecodedSilence !== true
    || report.audioEvidence?.mixerVersion !== 6
    || report.audioEvidence?.fullSourceMute !== true
    || report.audioEvidence?.compositionReceiptSha256
      !== manifest.narration.compositionReceiptSha256
    || canonical(report.audioEvidence?.originalTtsTrackSha256s)
      !== canonical(manifest.narration.tracks.map(track => track.sha256))
    || typeof report.reason !== 'string' || report.reason.length < 50
    || WHOLE_SHOT_CHECKS.some(check => report.checks?.[check] !== true)
    || canonical(report.evidenceFrames) !== canonical(expectedFrames))
    INVALID('direct 14 second whole-shot review incomplete or source-mismatched')
}

/** Signs a direct normal-speed picture judgment plus decoded audio evidence.
 * The original 13 second approval remains intact and workflow admission needs
 * a separate revised shot and frame certificate. */
export async function saveA8B6WholeShotReview(planId, report, root = process.cwd()) {
  const manifest = await readA8B6QAPlan(planId, root)
  verifyWholeShotReview(report, manifest, root)
  const qaManifestSha256 = sha256(await readFile(path.join(qaDirectory(root, planId),
    'manifest.json')))
  const value = { ...report, qaManifestSha256,
    inputReportSha256: sha256(canonical(report)),
    requiresRevised14sWorkflowApproval: true, signature: '' }
  value.signature = signature(value, await signingKey(root))
  const filename = path.join(qaDirectory(root, planId), 'whole-shot-review.json')
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return { path: filename, sha256: sha256(await readFile(filename)), signature: value.signature }
}

export async function preflightA8B6WholeShotReview(planId, report, root = process.cwd()) {
  const manifest = await readA8B6QAPlan(planId, root)
  verifyWholeShotReview(report, manifest, root)
  return { planId, pictureSha256: manifest.picture.sha256,
    outputSha256: manifest.narration.qaSha256,
    inputReportSha256: sha256(canonical(report)),
    requiredWorkflowApproval: 'separate revised 14 second shot and frame certificate' }
}

export async function readA8B6WholeShotReview(planId, root = process.cwd()) {
  const directory = qaDirectory(root, planId)
  const filename = path.join(directory, 'whole-shot-review.json')
  const bytes = await readFile(filename)
  const review = JSON.parse(bytes.toString('utf8'))
  verifySignature(review, await signingKey(root))
  const manifest = await readA8B6QAPlan(planId, root)
  verifyWholeShotReview(review, manifest, root)
  const { qaManifestSha256, inputReportSha256, requiresRevised14sWorkflowApproval,
    signature: _signature, ...input } = review
  void _signature
  if (qaManifestSha256 !== sha256(await readFile(path.join(directory, 'manifest.json')))
    || inputReportSha256 !== sha256(canonical(input))
    || requiresRevised14sWorkflowApproval !== true)
    INVALID('signed direct review source changed')
  return { review, sha256: sha256(bytes) }
}

export function reviewA8B6WholeShotTemplate(planId, root = process.cwd()) {
  const filename = path.join(qaDirectory(root, planId), 'manifest.json')
  const manifest = JSON.parse(readFileSync(filename, 'utf8'))
  verifySignature(manifest, readFileSync(path.join(root, '.runtime/staged-scene-cut.key')))
  if (manifest.planId !== planId || manifest.version !== 'staged-scene-cut-a8b6-qa-v1')
    INVALID('review template QA source invalid')
  return { version: 'staged-a8b6-whole-shot-review-v1', planId,
    pictureSha256: manifest.picture.sha256,
    outputSha256: manifest.narration.qaSha256,
    reviewer: 'Codex',
    reviewMethod: 'agent-direct-normal-speed-watch-and-decoded-audio-evidence',
    reviewedAt: new Date().toISOString(), normalSpeedPlaybackReviewed: true,
    verdict: 'accept', decisionScope: '14s-first-shot-only; second-shot-pending',
    reason: '请填写原速观看完整首镜后，对动作、停步、留白及第三句旁白语义的具体判断；音频结论仅依据解码和混音收据，不声称主观试听。',
    audioEvidence: { pictureDecodedSilence: true, mixerVersion: 6,
      fullSourceMute: true,
      compositionReceiptSha256: manifest.narration.compositionReceiptSha256,
      transferEvidencePath: 'qa/staged-scene-cut/a8b6-14s-narration-transfer.json',
      transferEvidenceSha256: sha256(readFileSync(path.join(root,
        'qa/staged-scene-cut/a8b6-14s-narration-transfer.json'))),
      originalTtsTrackSha256s: manifest.narration.tracks.map(track => track.sha256) },
    checks: Object.fromEntries(WHOLE_SHOT_CHECKS.map(check => [check, false])),
    evidenceFrames: WHOLE_SHOT_FRAMES.map(([phase, index]) => ({ phase, index,
      sha256: phase === 'A' ? manifest.seam.phaseAFrameSha256
        : manifest.observedNativeFrames.find(frame => frame.index === index)?.sha256 })) }
}

function checkedShaSync(filename, expected) {
  if (!SHA.test(String(expected)) || sha256(readFileSync(filename)) !== expected)
    INVALID(`signed source asset bytes changed: ${filename}`)
}
function readSignedSync(filename, key) {
  const bytes = readFileSync(filename)
  const value = JSON.parse(bytes.toString('utf8'))
  verifySignature(value, key)
  return { value, sha256: sha256(bytes) }
}
function readReviewSync(planId, root, manifest, manifestSha256, key) {
  const item = readSignedSync(path.join(qaDirectory(root, planId),
    'whole-shot-review.json'), key)
  const review = item.value
  verifyWholeShotReview(review, manifest, root)
  const { qaManifestSha256, inputReportSha256, requiresRevised14sWorkflowApproval,
    signature: _signature, ...input } = review
  void _signature
  if (qaManifestSha256 !== manifestSha256
    || inputReportSha256 !== sha256(canonical(input))
    || requiresRevised14sWorkflowApproval !== true)
    INVALID('signed 14 second direct review lineage changed')
  return item
}
function verifiedWorkflowApproval(planId, root, manifest) {
  // CJS interop for this synchronous replay gate. The approval module has no
  // top-level await, and its own verifier checks the new creative/shot/frame
  // approval ledger. Missing module or artifact intentionally blocks admission.
  const { verifyA8B6WorkflowApprovalSync } = require('./staged-scene-cut-a8b6-approval.mjs')
  if (typeof verifyA8B6WorkflowApprovalSync !== 'function')
    INVALID('14 second workflow approval verifier unavailable')
  const verified = verifyA8B6WorkflowApprovalSync(planId, root)
  if (verified?.approval?.qaPlanId !== planId
    || verified.approval.sourceResultMd5 !== manifest.source.resultMd5
    || verified.approval.originalShotSha256 !== manifest.source.approvedShotSha256
    || verified.approval.approvalState !== 'approved-in-new-schema180-branch'
    || verified.approval.workflowSchemaVersion !== 180
    || !SHA.test(verified.approvalSha256 ?? ''))
    INVALID('revised 14 second workflow approval mismatch')
  return verified
}
async function verifiedWorkflowApprovalDeep(planId, root, manifest) {
  const module = await import('./staged-scene-cut-a8b6-approval.mjs')
  if (typeof module.verifyA8B6WorkflowApproval !== 'function')
    INVALID('14 second DB/model review approval verifier unavailable')
  const deep = await module.verifyA8B6WorkflowApproval(planId, root)
  const local = verifiedWorkflowApproval(planId, root, manifest)
  if (deep?.approvalSha256 !== local.approvalSha256
    || canonical(deep.approval) !== canonical(local.approval))
    INVALID('deep 14 second workflow approval differs from signed local artifact')
  return local
}
function buildCompositeReceipt(manifest, manifestSha256, reviewSha256, approval,
  approvalSha256) {
  return { version: 'staged-a8b6-composite-v1', planId: manifest.planId,
    manifestSha256, wholeShotReviewSha256: reviewSha256,
    sourceRecordId: manifest.source.recordId,
    sourceResultMd5: manifest.source.resultMd5,
    originalApprovedShotSha256: manifest.source.approvedShotSha256,
    originalApprovalSha256: manifest.source.approvalSha256,
    sources: { phaseA: { taskId: manifest.source.originalATaskId,
      videoUrl: manifest.source.originalAVideoUrl,
      videoSha256: manifest.source.originalAVideoSha256,
      nativeFrameDigestSha256: manifest.source.originalANativeFrameDigestSha256,
      acceptedFrameIndex: 192, sourcePlanId: manifest.source.originalAPlanId,
      sourceRejectionSha256: manifest.source.originalARejectionSha256,
      sourceStatus: 'accepted-only-as-14s-continuation; original A7.5 rejection preserved' },
    phaseB: { taskId: manifest.source.BTaskId,
      videoUrl: manifest.source.BVideoUrl,
      videoSha256: manifest.source.BVideoSha256,
      nativeFrameDigestSha256: manifest.source.BNativeFrameDigestSha256,
      acceptedFrameIndex: 144,
      rejected13sPlanId: manifest.source.retryPlanId,
      rejected13sReceiptSha256: manifest.source.retryBRejectionSha256 } },
    mapping: manifest.mapping,
    seam: manifest.seam,
    picture: { url: manifest.picture.url, sha256: manifest.picture.sha256,
      nativeFrameDigestSha256: manifest.picture.nativeFrameDigestSha256,
      frameCount: 337, fps: 24, lastPts: 14, silentAudio: true,
      sourceFrameMatch: manifest.picture.sourceFrameMatch },
    narration: { url: manifest.narration.compositionUrl,
      sha256: manifest.narration.qaSha256,
      nativeFrameDigestSha256: manifest.narration.nativeFrameDigestSha256,
      compositionReceiptKey: manifest.narration.compositionReceiptKey,
      compositionReceiptSha256: manifest.narration.compositionReceiptSha256,
      mixerVersion: 6, fullSourceMute: true,
      ttsTrackSha256s: manifest.narration.tracks.map(track => track.sha256),
      ttsTrackStarts: manifest.narration.tracks.map(track => track.start) },
    output: { url: manifest.narration.compositionUrl,
      sha256: manifest.narration.qaSha256,
      nativeFrameDigestSha256: manifest.narration.nativeFrameDigestSha256,
      frameCount: 337, fps: 24, lastPts: 14 },
    review: { seamVerdict: 'accept', directWholeShotVerdict: 'accept',
      wholeShot: 'pending-node58', secondShot: 'pending-independent-acceptance' },
    timingDeviation: { ...manifest.timingDeviation,
      approvalState: 'approved-in-new-schema180-branch',
      qaSourceApprovalState: manifest.timingDeviation.approvalState,
      narration3Meaning: 'unchanged question accompanies approach; accepted in direct visual/semantic review',
      directFirstShotReview: 'accept',
      amendedShotSha256: approval.amendedShotSha256,
      amendedScheduleHash: approval.amendedScheduleHash },
    workflowApproval: { approvalSha256,
      amendedShotSha256: approval.amendedShotSha256,
      amendedScheduleHash: approval.amendedScheduleHash,
      sceneCutFrameCertificateSha256: approval.sceneCutFrameCertificateSha256 },
    providerCalls: 0 }
}

/** Sign a formal first-shot composite only after the revised 14 second
 * storyboard, schedule and frame certificate were independently approved. */
export async function preflightA8B6CompositeReceipt(planId, root = process.cwd()) {
  const manifest = await readA8B6QAPlan(planId, root)
  const directory = qaDirectory(root, planId)
  const manifestSha256 = sha256(await readFile(path.join(directory, 'manifest.json')))
  const key = await signingKey(root)
  const review = readReviewSync(planId, root, manifest, manifestSha256, key)
  const { approval, approvalSha256 } =
    await verifiedWorkflowApprovalDeep(planId, root, manifest)
  return { candidate: buildCompositeReceipt(manifest, manifestSha256,
    review.sha256, approval, approvalSha256), manifestSha256,
    wholeShotReviewSha256: review.sha256, workflowApprovalSha256: approvalSha256 }
}

export async function saveA8B6CompositeReceipt(planId, root = process.cwd()) {
  const { candidate } = await preflightA8B6CompositeReceipt(planId, root)
  const value = { ...candidate, signature: '' }
  const key = await signingKey(root)
  value.signature = signature(value, key)
  const filename = path.join(qaDirectory(root, planId), 'composite-receipt.json')
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return verifyA8B6CompositeReceiptSync(planId, root)
}

/** Synchronous replay gate for signed provenance and current asset bytes. */
export function verifyA8B6CompositeReceiptSync(planId, root = process.cwd()) {
  const directory = qaDirectory(root, planId)
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) INVALID('source signing key invalid')
  const { value: manifest, sha256: manifestSha256 } =
    readSignedSync(path.join(directory, 'manifest.json'), key)
  const { planId: _id, signature: _signature, ...planBody } = manifest
  void _id; void _signature
  if (manifest.version !== 'staged-scene-cut-a8b6-qa-v1'
    || manifest.planId !== planId || sha256(canonical(planBody)) !== planId
    || manifest.acceptanceState !== 'QA-only; no first-shot, seam, two-shot or workflow approval'
    || canonical(manifest.mapping) !== canonical(A8B6_QA_MAPPING)
    || manifest.picture.frameCount !== 337 || manifest.picture.fps !== 24
    || manifest.picture.lastPts !== 14 || manifest.picture.silentAudio !== true
    || manifest.picture.sourceFrameMatch?.frameCount !== 337
    || manifest.picture.sourceFrameMatch?.minAll < .975
    || manifest.picture.sourceFrameMatch?.meanAll < .985
    || manifest.seam.phaseAFrameIndex !== 192
    || manifest.seam.phaseBFirstFrameIndex !== 0
    || manifest.seam.stitchedPhaseBStartFrameIndex !== 1
    || manifest.seam.phaseBFinalFrameIndex !== 144
    || canonical(manifest.observedNativeFrames.map(frame => frame.index))
      !== canonical([0, 1, 6, 30, 36, 108, 120, 132, 144])
    || manifest.narration.mixerVersion !== 6
    || manifest.narration.fullSourceMute !== true
    || canonical(manifest.narration.tracks.map(track => track.start))
      !== canonical([0, 2.5, 9.5]))
    INVALID('14 second QA manifest identity or frame/audio contract changed')
  const retryDirectory = stageDirectory(root, manifest.source.retryPlanId)
  for (const [field, name] of [
    ['retryManifestSha256', 'manifest.json'],
    ['retryBSubmitIntentSha256', 'phase-B-submit-intent.json'],
    ['retryBTaskSha256', 'phase-B-task.json'],
    ['retryBMediaSha256', 'phase-B-media.json'],
    ['retryBRejectionSha256', 'phase-B-rejection.json'],
  ]) checkedShaSync(path.join(retryDirectory, name), manifest.source[field])
  if (existsSync(path.join(retryDirectory, 'phase-B-acceptance.json'))
    || existsSync(path.join(retryDirectory, 'composite-receipt.json')))
    INVALID('rejected 13 second retry was later accepted')
  const originalDir = path.join(root, '.runtime/staged-scene-cut',
    manifest.source.originalAPlanId)
  checkedShaSync(path.join(originalDir, 'phase-A-rejection.json'),
    manifest.source.originalARejectionSha256)
  if (existsSync(path.join(originalDir, 'phase-A-acceptance.json')))
    INVALID('rejected original A plan was later accepted')
  for (const [url, digest] of [
    [manifest.source.originalAVideoUrl, manifest.source.originalAVideoSha256],
    [manifest.source.BVideoUrl, manifest.source.BVideoSha256],
    [manifest.picture.url, manifest.picture.sha256],
    [manifest.narration.qaUrl, manifest.narration.qaSha256],
    ...manifest.narration.tracks.map(track => [track.url, track.sha256]),
  ]) checkedShaSync(path.join(root, 'public', url.slice(1)), digest)
  const compositionPath = path.join(root, '.runtime/narration-compositions',
    `${manifest.narration.compositionReceiptKey}.json`)
  checkedShaSync(compositionPath, manifest.narration.compositionReceiptSha256)
  const composition = JSON.parse(readFileSync(compositionPath, 'utf8'))
  if (composition.key !== manifest.narration.compositionReceiptKey
    || composition.outputUrl !== manifest.narration.compositionUrl
    || composition.duration !== 14 || composition.audioRole !== 'narration'
    || composition.pictureSha256 !== manifest.picture.sha256
    || composition.outputSha256 !== manifest.narration.qaSha256
    || composition.mixerVersion !== 6
    || canonical(composition.tracks) !== canonical(manifest.narration.tracks)
    || composition.pictureVoiceIsolation?.status !== 'fully-muted-unverified'
    || composition.pictureVoiceIsolation.preservedOutsideWindows !== false
    || !composition.pictureVoiceIsolation.mutedWindows?.some(window =>
      window.start <= 0 && window.end >= 14))
    INVALID('14 second original TTS/full mute composition changed')
  checkedShaSync(path.join(root, 'public', composition.outputUrl.slice(1)),
    manifest.narration.qaSha256)
  const review = readReviewSync(planId, root, manifest, manifestSha256, key)
  const { approval, approvalSha256 } = verifiedWorkflowApproval(planId, root, manifest)
  const { value: receipt, sha256: receiptSha256 } =
    readSignedSync(path.join(directory, 'composite-receipt.json'), key)
  const expected = buildCompositeReceipt(manifest, manifestSha256, review.sha256,
    approval, approvalSha256)
  const { signature: _receiptSignature, ...receiptBody } = receipt
  void _receiptSignature
  if (canonical(receiptBody) !== canonical(expected))
    INVALID('formal 14 second composite receipt differs from approved source')
  return { manifest, receipt, manifestSha256, receiptSha256 }
}

/** Deep native-frame and full-source-audio validation before workflow fork. */
export async function verifyA8B6CompositeReceipt(planId, root = process.cwd()) {
  const manifest = await readA8B6QAPlan(planId, root)
  await verifiedWorkflowApprovalDeep(planId, root, manifest)
  return verifyA8B6CompositeReceiptSync(planId, root)
}
