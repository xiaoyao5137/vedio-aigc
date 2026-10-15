/** Write-once rejection of a failed paid B take. The original v1 receipt is
 * preserved byte-for-byte; B-only children use a generic v2 failure report. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { extractFreshNativeJpeg, inspectFreshNativeVideo } from
  './staged-scene-cut-a8b6-fresh-native.mjs'
import { freshA8B6Directory, freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { probeFreshA8B6AudioIsolationV3 } from
  './staged-scene-cut-a8b6-fresh-audio-v3.mjs'
import { prepareFreshA8B6PhaseBRejectionV2,
  verifyFreshA8B6PhaseBRejectionV2Sync } from
  './staged-scene-cut-a8b6-fresh-B-rejection-v2.mjs'

export const REJECTED_B_PLAN_ID =
  '0dcb1683df0c3383f533d6c93dec3d7bf6bc6e57b10329eed5808410d648f6fb'
export const REJECTED_B_TASK_ID = '934067678212788304'
export const REJECTED_B_VIDEO_SHA256 =
  'f364dd5a0a8d8da026d9db4f8981b25f65d12c830fd411b7354a415fa94adb78'
const VERSION = 'staged-a8b6-fresh-native-B-rejection-v1'
const REPORT_VERSION = 'staged-a8b6-fresh-native-B-rejection-report-v1'
const FRAMES = [0, 24, 48, 72, 96, 144]
const SHA = /^[a-f0-9]{64}$/
const REPORT_FILE = /^qa\/staged-scene-cut\/[\w.-]+\.json$/
const fail = reason => { throw Error(`A8B6_FRESH_B_REJECTION_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const receiptPath = (planId, root) => path.join(
  freshA8B6Directory(planId, root), 'phase-B-rejection.json')

async function key(root) {
  const bytes = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (bytes.length !== 32) fail('staging signing key invalid')
  return bytes
}

function reportName(file) {
  if (!REPORT_FILE.test(String(file)))
    fail('rejection report must be a repository staged-scene-cut QA JSON file')
  return file
}

/** A direct full-speed witness and exact native frame hashes are required. */
export function assertFreshA8B6PhaseBDirectRejection(report, context) {
  const { media, mediaSha256, native, plan, planSha256, acceptedA,
    audioIsolationSha256, frameHashes } = context
  const watch = report?.playback
  let viewerValid = false
  try {
    const viewer = new URL(watch?.viewerUrl)
    viewerValid = ['127.0.0.1', 'localhost'].includes(viewer.hostname)
      && viewer.pathname === media.videoUrl
      && !viewer.search && !viewer.hash
  } catch { /* invalid URL */ }
  const frames = report?.nativeFrames
  const timed = report?.observations
  if (report?.version !== REPORT_VERSION
    || report.planId !== REJECTED_B_PLAN_ID || report.phase !== 'B'
    || report.taskId !== REJECTED_B_TASK_ID
    || report.videoSha256 !== REJECTED_B_VIDEO_SHA256
    || report.mediaSha256 !== mediaSha256
    || report.nativeFrameDigestSha256 !== native.frameDigestSha256
    || report.phaseBPlanSha256 !== planSha256
    || report.sourceA?.acceptanceSha256 !== acceptedA.acceptanceSha256
    || report.sourceA?.frameIndex !== plan.sourceA.frameIndex
    || report.sourceA?.frameSha256 !== plan.sourceA.frameSha256
    || report.audioIsolationSha256 !== audioIsolationSha256
    || report.verdict !== 'reject' || report.reviewer !== 'Codex'
    || report.reviewMethod !== 'agent-direct-normal-speed-watch-and-native-frame-inspection'
    || !Number.isFinite(Date.parse(report.reviewedAt))
    || !viewerValid || watch.surface !== 'browser-1x-session'
    || watch.sourceUrl !== media.videoUrl
    || watch.sourceVideoSha256 !== media.videoSha256
    || watch.rate !== 1 || watch.startSeconds !== 0
    || !Number.isFinite(watch.endSeconds)
    || Math.abs(watch.endSeconds - native.lastPts) > 1e-8
    || watch.continuous !== true
    || !Number.isFinite(Date.parse(watch.observedAt))
    || report.failedChecks?.frontWristKnotRemainsVisibleThroughout !== false
    || report.failedChecks?.boundHandsRemainTogetherThroughout !== false
    || report.acceptanceState !== 'rejected-native-B; no composite or scene2 may use this media'
    || !Array.isArray(timed) || timed.length < 4
    || timed.some(item => !Number.isFinite(item.timeSeconds)
      || item.timeSeconds < 0 || item.timeSeconds > native.lastPts + 1 / 24 + 1e-8
      || typeof item.description !== 'string'
      || item.description.trim().length < 12)
    || !timed.some(item => item.timeSeconds === 0)
    || !timed.some(item => item.timeSeconds >= 0.9 && item.timeSeconds <= 1.3)
    || !timed.some(item => item.timeSeconds >= 1.9 && item.timeSeconds <= 3)
    || !timed.some(item => item.timeSeconds >= native.lastPts)
    || !Array.isArray(frames) || frames.length !== FRAMES.length
    || frames.some((item, position) =>
      item.frameIndex !== FRAMES[position]
      || item.sha256 !== frameHashes.get(item.frameIndex)
      || typeof item.description !== 'string'
      || item.description.trim().length < 12)
    || !Array.isArray(report.limitations))
    fail('direct B rejection lost full-speed witness, source binding or native frames')
  return true
}

async function context(planId, root) {
  if (planId !== REJECTED_B_PLAN_ID)
    fail('rejection belongs only to this failed paid B take')
  const directory = freshA8B6Directory(planId, root)
  const signingKey = readFileSync(path.join(root,
    '.runtime/staged-scene-cut.key'))
  if (signingKey.length !== 32) fail('staging signing key invalid')
  const read = name => signedSync(path.join(directory, name), signingKey)
  const manifest = read('manifest.json')
  const Amedia = read('phase-A-media.json')
  const acceptedA = read('phase-A-acceptance.json')
  const { value: plan, sha256: planSha256 } = read('phase-B-plan.json')
  const { value: task, sha256: taskSha256 } = read('phase-B-task.json')
  const { value: media, sha256: mediaSha256 } = read('phase-B-media.json')
  const { value: audio, sha256: audioIsolationSha256 } = read(
    'phase-B-audio-isolation-v3.json')
  const intentBytes = await readFile(path.join(directory,
    'phase-B-submit-intent.json'))
  const intent = JSON.parse(intentBytes.toString('utf8'))
  const intentSha256 = sha(intentBytes)
  const manifestSha256 = manifest.sha256
  const video = freshA8B6GeneratedFile(media.videoUrl, 'video', root)
  const native = await inspectFreshNativeVideo(video)
  const probe = await probeFreshA8B6AudioIsolationV3(video, native.lastPts)
  if (existsSync(path.join(directory, 'phase-B-acceptance.json'))
    || media.taskId !== REJECTED_B_TASK_ID
    || media.videoSha256 !== REJECTED_B_VIDEO_SHA256
    || media.planId !== planId || media.phase !== 'B'
    || media.taskSha256 !== taskSha256
    || task.requestSha256 !== intent.requestSha256
    || task.intentSha256 !== intentSha256
    || task.planId !== planId || task.phase !== 'B'
    || task.taskId !== media.taskId
    || intent.planId !== planId || intent.phase !== 'B'
    || intent.requestSha256 !== plan.phaseBPreview?.requestSha256
    || plan.manifestSha256 !== manifestSha256
    || plan.planId !== planId
    || plan.sourceA?.acceptanceSha256 !== acceptedA.sha256
    || acceptedA.value.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || acceptedA.value.planId !== planId
    || acceptedA.value.phase !== 'A'
    || acceptedA.value.mediaSha256 !== Amedia.sha256
    || acceptedA.value.videoSha256 !== Amedia.value.videoSha256
    || sha(readFileSync(freshA8B6GeneratedFile(
      Amedia.value.videoUrl, 'video', root))) !== Amedia.value.videoSha256
    || sha(readFileSync(freshA8B6GeneratedFile(
      plan.sourceA.firstFrameUrl, 'image', root)))
      !== acceptedA.value.acceptedFrameSha256
    || sha(readFileSync(video)) !== media.videoSha256
    || native.frameCount !== 145 || native.lastFrameIndex !== 144
    || native.lastPts !== 6
    || native.frameDigestSha256 !== media.nativeFrameDigestSha256
    || plan.sourceA.frameSha256 !== acceptedA.value.acceptedFrameSha256
    || plan.sourceA.frameIndex !== acceptedA.value.acceptedFrameIndex
    || audio.planId !== planId || audio.phase !== 'B'
    || audio.taskId !== media.taskId
    || audio.videoSha256 !== media.videoSha256
    || audio.mediaSha256 !== mediaSha256
    || audio.nativeFrameDigestSha256 !== native.frameDigestSha256
    || audio.status !== 'no-audio-stream'
    || audio.witness?.probedStreamCount !== 0
    || !isDeepStrictEqual({ status: audio.status, witness: audio.witness }, probe))
    fail('failed B media, A ancestry, audio or acceptance boundary changed')
  const frameHashes = new Map()
  for (const index of FRAMES)
    frameHashes.set(index, (await extractFreshNativeJpeg(video, index)).sha256)
  return { media, mediaSha256, native, plan, planSha256,
    acceptedA: { acceptance: acceptedA.value,
      acceptanceSha256: acceptedA.sha256 },
    task, taskSha256, intentSha256, manifestSha256,
    audioIsolationSha256, frameHashes }
}

export async function prepareFreshA8B6PhaseBRejection({ planId, reportFile },
  root = process.cwd()) {
  if (planId !== REJECTED_B_PLAN_ID)
    return prepareFreshA8B6PhaseBRejectionV2({ planId, reportFile },
      root, verifyFreshA8B6PhaseBRejectionSync(REJECTED_B_PLAN_ID, root))
  return preparePhaseBRejectionVerified({ planId, reportFile }, root)
}

async function preparePhaseBRejectionVerified({ planId, reportFile }, root) {
  reportName(reportFile)
  const source = await context(planId, root)
  const bytes = await readFile(path.join(root, reportFile))
  const report = JSON.parse(bytes.toString('utf8'))
  assertFreshA8B6PhaseBDirectRejection(report, source)
  const reportSha256 = sha(bytes)
  const body = { version: VERSION, planId, phase: 'B',
    taskId: source.media.taskId, videoUrl: source.media.videoUrl,
    videoSha256: source.media.videoSha256,
    mediaSha256: source.mediaSha256,
    nativeFrameDigestSha256: source.native.frameDigestSha256,
    nativeFrameCount: source.native.frameCount,
    nativeLastFrameIndex: source.native.lastFrameIndex,
    nativeLastPts: source.native.lastPts,
    manifestSha256: source.manifestSha256,
    taskSha256: source.taskSha256,
    submitIntentSha256: source.intentSha256,
    requestSha256: source.task.requestSha256,
    phaseBPlanSha256: source.planSha256,
    sourceA: { acceptanceSha256: source.acceptedA.acceptanceSha256,
      frameIndex: source.plan.sourceA.frameIndex,
      frameSha256: source.plan.sourceA.frameSha256 },
    audioIsolationSha256: source.audioIsolationSha256,
    reportFile, reportSha256,
    nativeFrames: report.nativeFrames,
    failedChecks: report.failedChecks,
    directReview: { reviewer: report.reviewer,
      method: report.reviewMethod,
      playbackSurface: report.playback.surface,
      originalSpeedWatchPerformed: true,
      playbackStartSeconds: 0,
      playbackEndSeconds: source.native.lastPts,
      reportSha256 },
    nextPaidPhaseBlocked: true,
    acceptanceState: report.acceptanceState }
  return { body, reportSha256, mediaSha256: source.mediaSha256,
    phaseBPlanSha256: source.planSha256,
    audioIsolationSha256: source.audioIsolationSha256 }
}

export async function saveFreshA8B6PhaseBRejection(input, expected,
  root = process.cwd()) {
  const prepared = await prepareFreshA8B6PhaseBRejection(input, root)
  if (expected?.reportSha256 !== prepared.reportSha256
    || expected?.mediaSha256 !== prepared.mediaSha256
    || expected?.phaseBPlanSha256 !== prepared.phaseBPlanSha256
    || (input.planId === REJECTED_B_PLAN_ID
      ? expected?.audioIsolationSha256 !== prepared.audioIsolationSha256
      : expected?.audioProbeSha256 !== prepared.audioProbeSha256)
    || expected?.videoSha256 !== prepared.body.videoSha256)
    fail('B rejection preview hashes changed before signing')
  const body = prepared.body
  const value = { ...body,
    signature: createHmac('sha256', await key(root))
      .update(canonical(body)).digest('hex') }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  const filename = receiptPath(input.planId, root)
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST'
      || !(await readFile(filename)).equals(bytes))
      fail('existing B rejection certificate differs')
  }
  return verifyFreshA8B6PhaseBRejection(input.planId, root)
}

function signedSync(filename, signingKey) {
  const bytes = readFileSync(filename)
  const value = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = value
  const expected = createHmac('sha256', signingKey)
    .update(canonical(body)).digest('hex')
  if (!SHA.test(String(signature)) || !timingSafeEqual(
    Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
    fail(`${path.basename(filename)} signature changed`)
  return { value, sha256: sha(bytes) }
}

/** Fast ancestry gate for a B-only retake. The async verifier also decodes. */
export function verifyFreshA8B6PhaseBRejectionSync(planId,
  root = process.cwd()) {
  if (planId !== REJECTED_B_PLAN_ID)
    return verifyFreshA8B6PhaseBRejectionV2Sync(planId, root,
      verifyFreshA8B6PhaseBRejectionSync(REJECTED_B_PLAN_ID, root))
  const directory = freshA8B6Directory(planId, root)
  const signingKey = readFileSync(path.join(root,
    '.runtime/staged-scene-cut.key'))
  if (signingKey.length !== 32) fail('staging signing key invalid')
  const read = name => signedSync(path.join(directory, name), signingKey)
  const { value: rejection, sha256: rejectionSha256 } = read(
    'phase-B-rejection.json')
  const manifest = read('manifest.json')
  const A = read('phase-A-acceptance.json')
  const Amedia = read('phase-A-media.json')
  const Bplan = read('phase-B-plan.json')
  const Btask = read('phase-B-task.json')
  const Bmedia = read('phase-B-media.json')
  const audio = read('phase-B-audio-isolation-v3.json')
  const intentBytes = readFileSync(path.join(directory,
    'phase-B-submit-intent.json'))
  const intent = JSON.parse(intentBytes.toString('utf8'))
  const reportFile = reportName(rejection.reportFile)
  const reportBytes = readFileSync(path.join(root, reportFile))
  const report = JSON.parse(reportBytes.toString('utf8'))
  const frameIndices = rejection.nativeFrames?.map(item => item.frameIndex)
  if (rejection.version !== VERSION || rejection.planId !== planId
    || rejection.phase !== 'B'
    || rejection.taskId !== REJECTED_B_TASK_ID
    || rejection.videoSha256 !== REJECTED_B_VIDEO_SHA256
    || rejection.mediaSha256 !== Bmedia.sha256
    || rejection.videoUrl !== Bmedia.value.videoUrl
    || rejection.nativeFrameDigestSha256
      !== Bmedia.value.nativeFrameDigestSha256
    || rejection.nativeFrameCount !== 145
    || rejection.nativeLastFrameIndex !== 144
    || rejection.nativeLastPts !== 6
    || Bmedia.value.taskId !== rejection.taskId
    || Bmedia.value.videoSha256 !== rejection.videoSha256
    || Bmedia.value.taskSha256 !== Btask.sha256
    || rejection.taskSha256 !== Btask.sha256
    || rejection.requestSha256 !== Btask.value.requestSha256
    || rejection.submitIntentSha256 !== sha(intentBytes)
    || Btask.value.intentSha256 !== rejection.submitIntentSha256
    || Btask.value.taskId !== rejection.taskId
    || Btask.value.requestSha256 !== intent.requestSha256
    || intent.planId !== planId || intent.phase !== 'B'
    || intent.requestSha256 !== Bplan.value.phaseBPreview?.requestSha256
    || rejection.manifestSha256 !== manifest.sha256
    || Bplan.value.manifestSha256 !== manifest.sha256
    || rejection.phaseBPlanSha256 !== Bplan.sha256
    || Bplan.value.sourceA?.acceptanceSha256 !== A.sha256
    || rejection.sourceA?.acceptanceSha256 !== A.sha256
    || rejection.sourceA?.frameIndex !== A.value.acceptedFrameIndex
    || rejection.sourceA?.frameSha256 !== A.value.acceptedFrameSha256
    || Bplan.value.sourceA?.frameIndex !== A.value.acceptedFrameIndex
    || Bplan.value.sourceA?.frameSha256 !== A.value.acceptedFrameSha256
    || A.value.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || A.value.planId !== planId || A.value.phase !== 'A'
    || A.value.mediaSha256 !== Amedia.sha256
    || Amedia.value.videoSha256 !== A.value.videoSha256
    || audio.value.planId !== planId || audio.value.phase !== 'B'
    || audio.value.videoSha256 !== rejection.videoSha256
    || audio.value.mediaSha256 !== Bmedia.sha256
    || audio.value.nativeFrameDigestSha256
      !== rejection.nativeFrameDigestSha256
    || audio.value.status !== 'no-audio-stream'
    || audio.value.witness?.probedStreamCount !== 0
    || rejection.audioIsolationSha256 !== audio.sha256
    || rejection.reportSha256 !== sha(reportBytes)
    || rejection.directReview?.reportSha256 !== rejection.reportSha256
    || rejection.directReview?.originalSpeedWatchPerformed !== true
    || rejection.directReview?.playbackEndSeconds !== 6
    || rejection.failedChecks?.frontWristKnotRemainsVisibleThroughout
      !== false
    || rejection.failedChecks?.boundHandsRemainTogetherThroughout !== false
    || rejection.nextPaidPhaseBlocked !== true
    || rejection.acceptanceState
      !== 'rejected-native-B; no composite or scene2 may use this media'
    || !isDeepStrictEqual(frameIndices, FRAMES)
    || !isDeepStrictEqual(rejection.nativeFrames, report.nativeFrames)
    || existsSync(path.join(directory, 'phase-B-acceptance.json'))
    || existsSync(path.join(directory, 'composite.json')))
    fail('signed B rejection lost source, A lineage or negative review')
  if (sha(readFileSync(freshA8B6GeneratedFile(
    rejection.videoUrl, 'video', root))) !== rejection.videoSha256
    || sha(readFileSync(freshA8B6GeneratedFile(
      Amedia.value.videoUrl, 'video', root))) !== A.value.videoSha256
    || sha(readFileSync(freshA8B6GeneratedFile(
      Bplan.value.sourceA.firstFrameUrl, 'image', root)))
      !== A.value.acceptedFrameSha256)
    fail('rejected paid source, accepted A or seam frame bytes changed')
  assertFreshA8B6PhaseBDirectRejection(report, {
    media: Bmedia.value, mediaSha256: Bmedia.sha256,
    native: { frameDigestSha256: Bmedia.value.nativeFrameDigestSha256,
      lastPts: Bmedia.value.nativeLastPts },
    plan: Bplan.value, planSha256: Bplan.sha256,
    acceptedA: { acceptanceSha256: A.sha256 },
    audioIsolationSha256: audio.sha256,
    frameHashes: new Map(rejection.nativeFrames.map(item =>
      [item.frameIndex, item.sha256])) })
  return { rejection, rejectionSha256 }
}

/** Deep verifier redecodes the original paid bytes and every cited frame. */
export async function verifyFreshA8B6PhaseBRejection(planId,
  root = process.cwd()) {
  const signed = verifyFreshA8B6PhaseBRejectionSync(planId, root)
  const { signature: _signature, ...body } = signed.rejection
  void _signature
  const prepared = await prepareFreshA8B6PhaseBRejection({ planId,
    reportFile: signed.rejection.reportFile }, root)
  if (!isDeepStrictEqual(body, prepared.body))
    fail('signed B rejection differs from native source or report')
  return signed
}
