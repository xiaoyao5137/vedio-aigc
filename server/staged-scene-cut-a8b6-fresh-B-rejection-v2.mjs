/** A source-bound rejection for any B-only child whose native B fails a
 * directly watched continuity check. The accepted A remains in its parent. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { extractFreshNativeJpeg, inspectFreshNativeVideo } from
  './staged-scene-cut-a8b6-fresh-native.mjs'
import { freshA8B6Directory, freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { probeFreshA8B6AudioIsolationV3 } from
  './staged-scene-cut-a8b6-fresh-audio-v3.mjs'

export const B_REJECTION_V2 = 'staged-a8b6-fresh-native-B-rejection-v2'
export const B_REJECTION_REPORT_V2 =
  'staged-a8b6-fresh-native-B-rejection-report-v2'
export const B_REJECTION_NATIVE_FRAMES_V2 =
  Object.freeze([0, 1, 24, 48, 72, 96, 120, 144])
const CHECKS = new Set([
  'actualATailToBFrame1AtOriginalSpeed',
  'guardsContinueWithdrawalWithoutRegrab',
  'frontWristKnotRemainsVisibleThroughout',
  'zhangApproachesAndStopsByNativeFrame120',
  'stableFinalSecond',
  'noSpeechMouthAtOriginalSpeed',
  'noSceneOrIdentityJumpAtOriginalSpeed',
])
const SHA = /^[a-f0-9]{64}$/
const REPORT_FILE = /^qa\/staged-scene-cut\/[\w.-]+\.json$/
const fail = reason => { throw Error(`A8B6_FRESH_B_REJECTION_V2_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

function signed(filename, key) {
  const bytes = readFileSync(filename)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { fail(`${path.basename(filename)} is malformed JSON`) }
  const { signature, ...body } = value ?? {}
  const expected = createHmac('sha256', key)
    .update(canonical(body)).digest('hex')
  if (!SHA.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')))
    fail(`${path.basename(filename)} signature changed`)
  return { value, sha256: sha(bytes) }
}

function reportName(file) {
  if (!REPORT_FILE.test(String(file)))
    fail('direct rejection report must be retained in QA JSON')
  return file
}

/** Every later B-only child must name its immediately rejected predecessor.
 * The full forbidden list is inherited so no paid failed take can be reused. */
export function assertFreshA8B6PhaseBRejectionChainV2({ planId,
  manifest, approval, previousRejection, previousRejectionSha256,
  previousManifest }) {
  const prior = manifest?.bRetake?.previousChild
  if (!prior) {
    if (approval?.version !== 'staged-a8b6-B-only-retake-approval-v1'
      || approval.previousChild !== undefined
      || previousRejection !== undefined
      || previousManifest !== undefined)
      fail('first B-only child unexpectedly claims previous rejected child')
    return true
  }
  if (approval?.version !== 'staged-a8b6-B-only-retake-approval-v2'
    || !SHA.test(String(prior.planId)) || prior.planId === planId
    || !previousRejection
    || !SHA.test(String(previousRejectionSha256))
    || previousRejection.planId !== prior.planId
    || previousRejection.version !== B_REJECTION_V2
    || previousRejection.parentPlanId !== manifest.bRetake.parentPlanId
    || previousRejection.nextPaidPhaseBlocked !== true
    || previousRejection.failedChecks
      ?.guardsContinueWithdrawalWithoutRegrab !== false
    || previousRejection.checks
      ?.frontWristKnotRemainsVisibleThroughout !== true)
    fail('B-only child lacks a verified rejected predecessor')
  const expected = { planId: previousRejection.planId,
    manifestSha256: previousRejection.manifestSha256,
    approvalSha256: previousRejection.childApprovalSha256,
    phaseBPlanSha256: previousRejection.phaseBPlanSha256,
    requestSha256: previousRejection.requestSha256,
    taskId: previousRejection.taskId,
    taskSha256: previousRejection.taskSha256,
    mediaSha256: previousRejection.mediaSha256,
    videoSha256: previousRejection.videoSha256,
    rejectionSha256: previousRejectionSha256 }
  const expectedForbidden = [
    ...(previousManifest?.forbiddenSources ?? []),
    { kind: 'rejected-B-native-video',
      url: previousRejection.videoUrl,
      sha256: previousRejection.videoSha256,
      taskId: previousRejection.taskId },
  ]
  if (!isDeepStrictEqual(prior, expected)
    || !isDeepStrictEqual(approval.previousChild, expected)
    || !Array.isArray(previousManifest?.forbiddenSources)
    || !isDeepStrictEqual(manifest.forbiddenSources,
      expectedForbidden))
    fail('B-only child changed predecessor or cumulative forbidden media')
  return true
}

function source(planId, root, parentRejection, ancestors = new Set()) {
  if (!SHA.test(String(planId)) || !parentRejection?.rejection
    || !SHA.test(String(parentRejection.rejectionSha256)))
    fail('signed child and verified parent rejection required')
  if (ancestors.has(planId)) fail('B-only child ancestry contains a cycle')
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('staging signing key invalid')
  const childDir = freshA8B6Directory(planId, root)
  const readChild = name => signed(path.join(childDir, name), key)
  const manifest = readChild('manifest.json')
  const plan = readChild('phase-B-plan.json')
  const task = readChild('phase-B-task.json')
  const media = readChild('phase-B-media.json')
  const approval = signed(path.join(root,
    '.runtime/staged-scene-cut-a8b6-B-retake', planId,
    'approval.json'), key)
  const parentPlanId = manifest.value.bRetake?.parentPlanId
  if (!SHA.test(String(parentPlanId))
    || parentRejection.rejection.planId !== parentPlanId)
    fail('child does not descend from verified rejected parent B')
  const parentDir = freshA8B6Directory(parentPlanId, root)
  const acceptedA = signed(path.join(parentDir,
    'phase-A-acceptance.json'), key)
  const Amedia = signed(path.join(parentDir, 'phase-A-media.json'), key)
  const intentBytes = readFileSync(path.join(childDir,
    'phase-B-submit-intent.json'))
  let intent
  try { intent = JSON.parse(intentBytes.toString('utf8')) }
  catch { fail('paid B intent JSON malformed') }
  const { signature: _signature, planId: _planId,
    workflowApprovalSha256: _workflowApprovalSha256,
    ...manifestBody } = manifest.value
  void _signature; void _planId; void _workflowApprovalSha256
  const b = manifest.value.bRetake
  const A = acceptedA.value
  const B = media.value
  const p = plan.value
  const a = approval.value
  const old = parentRejection.rejection
  const previousPlanId = b?.previousChild?.planId
  const previous = previousPlanId
    ? verifyFreshA8B6PhaseBRejectionV2Sync(previousPlanId, root,
      parentRejection, new Set([...ancestors, planId])) : undefined
  const previousManifest = previousPlanId
    ? signed(path.join(freshA8B6Directory(previousPlanId, root),
      'manifest.json'), key).value : undefined
  assertFreshA8B6PhaseBRejectionChainV2({ planId,
    manifest: manifest.value, approval: a,
    previousRejection: previous?.rejection,
    previousRejectionSha256: previous?.rejectionSha256,
    previousManifest })
  const oldForbidden = manifest.value.forbiddenSources?.some(item =>
    item.url === old.videoUrl && item.sha256 === old.videoSha256
      && item.taskId === old.taskId)
  const newForbidden = manifest.value.forbiddenSources?.some(item =>
    item.url === B.videoUrl || item.sha256 === B.videoSha256
      || item.taskId === B.taskId)
  if (manifest.value.version !== 'staged-a8b6-fresh-A-plan-v3'
    || manifest.value.planId !== planId
    || sha(canonical(manifestBody)) !== planId
    || b.parentAAcceptanceSha256 !== acceptedA.sha256
    || b.parentAMediaSha256 !== Amedia.sha256
    || b.parentAVideoSha256 !== A.videoSha256
    || b.parentANativeTailSha256 !== A.acceptedFrameSha256
    || b.parentBRejectionSha256 !== parentRejection.rejectionSha256
    || b.parentBTaskId !== old.taskId
    || b.parentBMediaSha256 !== old.mediaSha256
    || b.parentBVideoSha256 !== old.videoSha256
    || !oldForbidden || newForbidden
    || A.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || A.planId !== parentPlanId || A.phase !== 'A'
    || A.acceptedFrameIndex !== 192
    || A.mediaSha256 !== Amedia.sha256
    || Amedia.value.videoSha256 !== A.videoSha256
    || a.planId !== planId || a.parentPlanId !== parentPlanId
    || a.parentManifestSha256 !== b.parentManifestSha256
    || a.acceptedA?.acceptanceSha256 !== acceptedA.sha256
    || a.acceptedA?.mediaSha256 !== Amedia.sha256
    || a.acceptedA?.videoSha256 !== A.videoSha256
    || a.acceptedA?.nativeTailSha256 !== A.acceptedFrameSha256
    || a.failedB?.rejectionSha256 !== parentRejection.rejectionSha256
    || a.failedB?.taskId !== old.taskId
    || a.failedB?.mediaSha256 !== old.mediaSha256
    || a.failedB?.videoSha256 !== old.videoSha256
    || a.newBRequestSha256 !== b.newBRequestSha256
    || a.newBRequestSha256 !== p.phaseBPreview?.requestSha256
    || a.targetSourceSha256 !== b.targetSourceSha256
    || a.targetReviewSha256 !== b.targetReviewSha256
    || a.targetEndFrameSha256 !== b.targetEndFrameSha256
    || a.acceptedAReusedByReference !== true
    || a.newBProviderTaskAccepted !== false
    || p.version !== 'staged-a8b6-fresh-B-plan-v1'
    || p.planId !== planId || p.manifestSha256 !== manifest.sha256
    || p.sourceA?.sourcePlanId !== parentPlanId
    || p.sourceA?.acceptanceSha256 !== acceptedA.sha256
    || p.sourceA?.mediaSha256 !== Amedia.sha256
    || p.sourceA?.videoSha256 !== A.videoSha256
    || p.sourceA?.frameIndex !== A.acceptedFrameIndex
    || p.sourceA?.frameSha256 !== A.acceptedFrameSha256
    || task.value.planId !== planId || task.value.phase !== 'B'
    || task.value.requestSha256 !== p.phaseBPreview.requestSha256
    || task.value.intentSha256 !== sha(intentBytes)
    || intent.planId !== planId || intent.phase !== 'B'
    || intent.requestSha256 !== task.value.requestSha256
    || B.version !== 'staged-a8b6-fresh-native-media-v1'
    || B.planId !== planId || B.phase !== 'B'
    || B.taskId !== task.value.taskId
    || B.taskSha256 !== task.sha256
    || B.videoUrl !== `/generated/fresh-a8b6-${planId.slice(0, 16)}-B-${B.taskId}.mp4`
    || B.nativeFps !== 24 || B.nativeFrameCount !== 145
    || B.nativeLastFrameIndex !== 144 || B.nativeLastPts !== 6
    || existsSync(path.join(childDir, 'phase-B-acceptance.json'))
    || existsSync(path.join(childDir, 'composite.json')))
    fail('child B source, accepted parent A or signed approval changed')
  const video = freshA8B6GeneratedFile(B.videoUrl, 'video', root)
  const Afile = freshA8B6GeneratedFile(Amedia.value.videoUrl,
    'video', root)
  const first = freshA8B6GeneratedFile(p.sourceA.firstFrameUrl,
    'image', root)
  if (sha(readFileSync(video)) !== B.videoSha256
    || sha(readFileSync(Afile)) !== A.videoSha256
    || sha(readFileSync(first)) !== A.acceptedFrameSha256)
    fail('child B, accepted A or A native seam bytes changed')
  return { planId, parentPlanId, manifest, approval, acceptedA,
    Amedia, plan, task, media, intentSha256: sha(intentBytes),
    parentRejection, video }
}

function failedChecks(checks) {
  return Object.fromEntries(Object.entries(checks)
    .filter(([, value]) => value === false))
}

/** The report records only checks actually witnessed at normal speed. */
export function assertFreshA8B6PhaseBDirectRejectionV2(report, context) {
  const { planId, parentPlanId, media, plan, acceptedA,
    native, frameHashes } = context
  const B = media.value
  const p = plan.value
  const watch = report?.playback
  let viewerValid = false
  try {
    const viewer = new URL(watch?.viewerUrl)
    viewerValid = ['127.0.0.1', 'localhost'].includes(viewer.hostname)
      && viewer.pathname === B.videoUrl && !viewer.search && !viewer.hash
  } catch { /* invalid URL */ }
  const checks = report?.checks
  const checkEntries = checks && typeof checks === 'object'
    && !Array.isArray(checks) ? Object.entries(checks) : []
  const observations = report?.observations
  const frames = report?.nativeFrames
  if (report?.version !== B_REJECTION_REPORT_V2
    || report.planId !== planId || report.phase !== 'B'
    || report.taskId !== B.taskId
    || report.videoSha256 !== B.videoSha256
    || report.mediaSha256 !== media.sha256
    || report.nativeFrameDigestSha256 !== native.frameDigestSha256
    || report.phaseBPlanSha256 !== plan.sha256
    || report.sourceA?.sourcePlanId !== parentPlanId
    || report.sourceA?.acceptanceSha256 !== acceptedA.sha256
    || report.sourceA?.frameIndex !== p.sourceA.frameIndex
    || report.sourceA?.frameSha256 !== p.sourceA.frameSha256
    || report.verdict !== 'reject' || report.reviewer !== 'Codex'
    || report.reviewMethod
      !== 'agent-direct-normal-speed-watch-and-native-frame-inspection'
    || !Number.isFinite(Date.parse(report.reviewedAt))
    || !viewerValid || watch.surface !== 'browser-1x-session'
    || watch.sourceUrl !== B.videoUrl
    || watch.sourceVideoSha256 !== B.videoSha256
    || watch.rate !== 1 || watch.startSeconds !== 0
    || Math.abs(watch.endSeconds - native.lastPts) > 1e-8
    || watch.continuous !== true
    || !Number.isFinite(Date.parse(watch.observedAt))
    || checkEntries.length < 2
    || checkEntries.some(([name, value]) =>
      !CHECKS.has(name) || typeof value !== 'boolean')
    || !checkEntries.some(([, value]) => value === false)
    || checks.actualATailToBFrame1AtOriginalSpeed !== true
    || report.acceptanceState
      !== 'rejected-native-B; no composite or scene2 may use this media'
    || !Array.isArray(observations) || observations.length < 4
    || observations.some(item => !Number.isFinite(item.timeSeconds)
      || item.timeSeconds < 0 || item.timeSeconds > native.lastPts
      || typeof item.description !== 'string'
      || item.description.trim().length < 12)
    || !observations.some(item => item.timeSeconds === 0)
    || !observations.some(item => item.timeSeconds >= 1
      && item.timeSeconds <= 2.5)
    || !observations.some(item => item.timeSeconds >= 2.5
      && item.timeSeconds <= 4)
    || !observations.some(item => item.timeSeconds === native.lastPts)
    || !Array.isArray(frames)
    || frames.length !== B_REJECTION_NATIVE_FRAMES_V2.length
    || frames.some((item, index) =>
      item.frameIndex !== B_REJECTION_NATIVE_FRAMES_V2[index]
      || item.sha256 !== frameHashes.get(item.frameIndex)
      || typeof item.description !== 'string'
      || item.description.trim().length < 12)
    || !Array.isArray(report.limitations)
    || report.limitations.some(item =>
      /未观看|未播放|抽帧代替|not watched|not played/i.test(item)))
    fail('direct child B rejection lost 1x witness, failing check or native frames')
  return true
}

export async function prepareFreshA8B6PhaseBRejectionV2(input,
  root, parentRejection) {
  reportName(input.reportFile)
  const state = source(input.planId, root, parentRejection)
  const native = await inspectFreshNativeVideo(state.video)
  const B = state.media.value
  if (native.fps !== 24 || native.frameCount !== 145
    || native.lastFrameIndex !== 144 || native.lastPts !== 6
    || native.frameDigestSha256 !== B.nativeFrameDigestSha256)
    fail('child B original native video does not match signed media')
  const audioProbe = await probeFreshA8B6AudioIsolationV3(
    state.video, native.lastPts)
  if (!['no-audio-stream', 'decoded-silence'].includes(audioProbe.status)
    || sha(await readFile(state.video)) !== B.videoSha256)
    fail('child B audio or video changed during native inspection')
  const frameHashes = new Map()
  for (const index of B_REJECTION_NATIVE_FRAMES_V2)
    frameHashes.set(index,
      (await extractFreshNativeJpeg(state.video, index)).sha256)
  const reportBytes = await readFile(path.join(root, input.reportFile))
  let report
  try { report = JSON.parse(reportBytes.toString('utf8')) }
  catch { fail('child B direct rejection report JSON malformed') }
  assertFreshA8B6PhaseBDirectRejectionV2(report,
    { ...state, native, frameHashes })
  const reportSha256 = sha(reportBytes)
  const audioProbeSha256 = sha(canonical(audioProbe))
  const body = { version: B_REJECTION_V2,
    planId: input.planId, phase: 'B',
    parentPlanId: state.parentPlanId,
    parentBRejectionSha256: parentRejection.rejectionSha256,
    childApprovalSha256: state.approval.sha256,
    manifestSha256: state.manifest.sha256,
    taskId: B.taskId, taskSha256: state.task.sha256,
    submitIntentSha256: state.intentSha256,
    requestSha256: state.task.value.requestSha256,
    videoUrl: B.videoUrl, videoSha256: B.videoSha256,
    mediaSha256: state.media.sha256,
    phaseBPlanSha256: state.plan.sha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    nativeFrameCount: native.frameCount,
    nativeLastFrameIndex: native.lastFrameIndex,
    nativeLastPts: native.lastPts,
    sourceA: { sourcePlanId: state.parentPlanId,
      acceptanceSha256: state.acceptedA.sha256,
      frameIndex: state.plan.value.sourceA.frameIndex,
      frameSha256: state.plan.value.sourceA.frameSha256 },
    audioProbe, audioProbeSha256,
    reportFile: input.reportFile, reportSha256,
    checks: report.checks,
    failedChecks: failedChecks(report.checks),
    nativeFrames: report.nativeFrames,
    directReview: { reviewer: report.reviewer,
      method: report.reviewMethod,
      playbackSurface: report.playback.surface,
      originalSpeedWatchPerformed: true,
      playbackStartSeconds: 0,
      playbackEndSeconds: native.lastPts,
      reportSha256 },
    nextPaidPhaseBlocked: true,
    acceptanceState: report.acceptanceState }
  return { body, reportSha256, mediaSha256: state.media.sha256,
    phaseBPlanSha256: state.plan.sha256,
    audioProbeSha256 }
}

/** Fast read of signed ancestry; the deep verifier redecodes each JPEG. */
export function verifyFreshA8B6PhaseBRejectionV2Sync(planId,
  root, parentRejection, ancestors = new Set()) {
  const state = source(planId, root, parentRejection, ancestors)
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { value: rejection, sha256: rejectionSha256 } = signed(
    path.join(freshA8B6Directory(planId, root),
      'phase-B-rejection.json'), key)
  const reportFile = reportName(rejection.reportFile)
  const reportBytes = readFileSync(path.join(root, reportFile))
  let report
  try { report = JSON.parse(reportBytes.toString('utf8')) }
  catch { fail('signed child B report JSON malformed') }
  const B = state.media.value
  const frameHashes = new Map(rejection.nativeFrames?.map(item =>
    [item.frameIndex, item.sha256]))
  if (rejection.version !== B_REJECTION_V2
    || rejection.planId !== planId || rejection.phase !== 'B'
    || rejection.parentPlanId !== state.parentPlanId
    || rejection.parentBRejectionSha256
      !== parentRejection.rejectionSha256
    || rejection.childApprovalSha256 !== state.approval.sha256
    || rejection.manifestSha256 !== state.manifest.sha256
    || rejection.taskId !== B.taskId
    || rejection.taskSha256 !== state.task.sha256
    || rejection.submitIntentSha256 !== state.intentSha256
    || rejection.requestSha256 !== state.task.value.requestSha256
    || rejection.videoUrl !== B.videoUrl
    || rejection.videoSha256 !== B.videoSha256
    || rejection.mediaSha256 !== state.media.sha256
    || rejection.phaseBPlanSha256 !== state.plan.sha256
    || rejection.nativeFrameDigestSha256
      !== B.nativeFrameDigestSha256
    || rejection.nativeFrameCount !== B.nativeFrameCount
    || rejection.nativeLastFrameIndex !== B.nativeLastFrameIndex
    || rejection.nativeLastPts !== B.nativeLastPts
    || rejection.sourceA?.sourcePlanId !== state.parentPlanId
    || rejection.sourceA?.acceptanceSha256 !== state.acceptedA.sha256
    || rejection.sourceA?.frameIndex
      !== state.plan.value.sourceA.frameIndex
    || rejection.sourceA?.frameSha256
      !== state.plan.value.sourceA.frameSha256
    || !['no-audio-stream', 'decoded-silence']
      .includes(rejection.audioProbe?.status)
    || rejection.audioProbeSha256 !== sha(canonical(rejection.audioProbe))
    || rejection.reportSha256 !== sha(reportBytes)
    || !isDeepStrictEqual(rejection.checks, report.checks)
    || !isDeepStrictEqual(rejection.failedChecks,
      failedChecks(report.checks))
    || !isDeepStrictEqual(rejection.nativeFrames, report.nativeFrames)
    || rejection.directReview?.reportSha256 !== rejection.reportSha256
    || rejection.directReview?.originalSpeedWatchPerformed !== true
    || rejection.directReview?.playbackEndSeconds !== 6
    || rejection.nextPaidPhaseBlocked !== true
    || rejection.acceptanceState
      !== 'rejected-native-B; no composite or scene2 may use this media')
    fail('signed child B rejection lost source, audio or direct review')
  assertFreshA8B6PhaseBDirectRejectionV2(report,
    { ...state, native: { frameDigestSha256:
      B.nativeFrameDigestSha256, lastPts: B.nativeLastPts },
    frameHashes })
  return { rejection, rejectionSha256 }
}
