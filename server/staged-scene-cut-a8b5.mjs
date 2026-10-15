/** A source-bound, provisional 8s + 5s continuation of scene 01.
 * The already paid A clip is never re-labelled as accepted under its original
 * 7.5s plan. Only a separately signed direct review may unlock a B POST, and
 * even then neither stage nor the full shot is accepted by this module. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildKlingVideoRequest, prepareKlingImageInputs } from './model-adapters.ts'
import { composeNarration } from './independent-narration.ts'
import { inspectStagedNativeVideo, readStageMediaReceipt, readStageRejection, readStageTaskReceipt,
  readStagedSceneCutManifest } from './staged-scene-cut.mjs'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import pg from 'pg'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const SHA = /^[a-f0-9]{64}$/
const INVALID = message => { throw Error(`STAGED_A8B5_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const runtimeDirectory = (root, planId) => {
  if (!SHA.test(String(planId))) INVALID('plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b5', planId)
}
const generatedFile = (root, url, type = 'image') => {
  const pattern = type === 'video' ? /^\/generated\/[\w.-]+\.mp4$/i
    : type === 'audio' ? /^\/generated\/[\w.-]+\.wav$/i
    : /^\/generated\/[\w.-]+\.(?:jpg|jpeg|png)$/i
  if (typeof url !== 'string' || !pattern.test(url) || url.includes('..'))
    INVALID('generated asset URL invalid')
  return path.join(root, 'public', url.slice(1))
}
async function verifiedBytes(root, url, expectedSha256, type = 'image') {
  if (!SHA.test(String(expectedSha256))) INVALID('asset hash missing')
  const bytes = await readFile(generatedFile(root, url, type))
  if (sha256(bytes) !== expectedSha256) INVALID(`asset changed: ${url}`)
  return bytes
}
async function nativeJpeg(filename, index) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${index})`, '-vsync', 'vfr', '-frames:v', '1',
    '-q:v', '2', '-f', 'image2', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 20 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 1000 || stdout[0] !== 0xff || stdout[1] !== 0xd8)
    INVALID(`native frame ${index} did not decode`)
  return stdout
}
async function signingKey(root) {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) INVALID('source staging key invalid')
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
    INVALID('signed continuation artifact changed')
}
async function writeOnce(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true })
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      INVALID(`existing continuation artifact differs: ${filename}`)
  }
}

export const A8B5_TIMELINE = Object.freeze({ fps: 24, deliveredFrames: 313,
  providerASeconds: 8, providerBSeconds: 6, acceptedASeconds: 8,
  acceptedBSeconds: 5, phaseAEndFrame: 192, phaseBEndFrame: 120,
  phaseBGlobalStart: 8, zhangStoppedByBFrame: 36,
  narration3GlobalStart: 9.5 })

export function mapA8B5Frame(outputFrameIndex) {
  if (!Number.isInteger(outputFrameIndex) || outputFrameIndex < 0
    || outputFrameIndex >= A8B5_TIMELINE.deliveredFrames)
    INVALID('composite frame index outside 13s timeline')
  return outputFrameIndex <= 192
    ? { phase: 'A', sourceFrameIndex: outputFrameIndex, outputFrameIndex }
    : { phase: 'B', sourceFrameIndex: outputFrameIndex - 192, outputFrameIndex }
}

export function validateA8B5Timeline(timeline = A8B5_TIMELINE) {
  if (canonical(timeline) !== canonical(A8B5_TIMELINE)
    || timeline.phaseAEndFrame + timeline.phaseBEndFrame + 1 !== timeline.deliveredFrames
    || timeline.acceptedASeconds + timeline.acceptedBSeconds !== 13
    || timeline.phaseBGlobalStart + timeline.zhangStoppedByBFrame / timeline.fps !== 9.5)
    INVALID('8+5 continuation timeline changed')
  return true
}

export function a8b5PhaseBPrompt() {
  return [
    '16:9真人实景，紧接上一段已付费视频真实原生第192帧，江州战后同一街口、同一机位、四人衣甲与姿态；六秒连续画面，不跳切、不换景。画内无人说话或做语言口型。',
    '首帧严颜双腕已在身前被绳索缚住，两名军士的双手刚离开双腕，正向两侧撤离；从首帧起自然继续这一次撤手，双手保持离开双腕和绳索，不得重新抓腕、重绑、遮挡绳圈或让已完成的动作倒退。',
    '张飞只能在军士双手离腕之后从画面左侧原位沿封堵线内侧走近严颜；本段第1.5秒即第36帧以前在严颜面前完全停稳，且不遮住严颜身前绳结。',
    '第36帧到本段第120帧始终保持张飞站稳、严颜双腕绳结可见、军士退侧看押；其余时段只允许呼吸与衣物自然微动。本段第120帧是全镜13秒交付终帧，第121–144帧仅供核验。',
    '严颜服装、发冠、绳索位置和张飞衣甲都延续真实首帧；不得新增人物、问责对白、字幕或可读文字。',
  ].join('\n')
}

async function sourceA(basePlanId, root) {
  if (!SHA.test(String(basePlanId))) INVALID('source A plan ID invalid')
  const base = await readStagedSceneCutManifest(basePlanId, root)
  if (base.version !== 'staged-scene-cut-shot1-v3-compact1'
    || base.promptVersion !== 'early-binding-v3-compact1'
    || base.phases?.[0]?.seamFrame !== 180 || base.phases?.[1]?.seamFrame !== 132
    || base.deliveredFrames !== 313 || base.fps !== 24
    || base.providerLock?.modelId !== 'keling3'
    || !SHA.test(base.providerLock?.endpointSha256 ?? ''))
    INVALID('source A is not the immutable compact 7.5+5.5 plan')
  const task = await readStageTaskReceipt(basePlanId, 'A', root)
  const media = await readStageMediaReceipt(basePlanId, 'A', root)
  if (task.requestSha256 !== base.phaseAPreview.requestSha256
    || task.providerModelId !== base.providerLock.modelId
    || task.endpointSha256 !== base.providerLock.endpointSha256
    || media.taskId !== task.taskId)
    INVALID('source A paid task/media/model lock changed')
  const dir = path.join(root, '.runtime/staged-scene-cut', basePlanId)
  if (existsSync(path.join(dir, 'phase-A-acceptance.json')))
    INVALID('old A plan already has an acceptance; rejected A reuse is not applicable')
  const rejection = await readStageRejection(basePlanId, 'A', root)
  if (rejection.taskId !== task.taskId || rejection.videoSha256 !== media.videoSha256
    || rejection.nextPaidPhaseBlocked !== true)
    INVALID('old A rejection is not source-bound and blocking')
  const [manifestBytes, taskBytes, mediaBytes, rejectionBytes] = await Promise.all([
    readFile(path.join(dir, 'manifest.json')),
    readFile(path.join(dir, 'phase-A-task.json')),
    readFile(path.join(dir, 'phase-A-media.json')),
    readFile(path.join(dir, 'phase-A-rejection.json')),
  ])
  const videoFile = generatedFile(root, media.videoUrl, 'video')
  const native = await inspectStagedNativeVideo(videoFile, 193, 8)
  if (native.frameDigestSha256 !== media.nativeFrameDigestSha256)
    INVALID('source A native sequence changed')
  const first = await nativeJpeg(videoFile, 192)
  const firstSha256 = sha256(first)
  const firstUrl = `/generated/staged-a8b5-source-${media.videoSha256.slice(0, 16)}-f192-${firstSha256.slice(0, 16)}.jpg`
  const identities = base.compactTransport.entries.slice(1).map(entry => entry.transport)
  for (const asset of identities) await verifiedBytes(root, asset.url, asset.sha256)
  const end = base.guides['312']
  await verifiedBytes(root, end.url, end.jpegSha256)
  if (base.narrationTracks?.length !== 3
    || canonical(base.narrationTracks.map(track => track.start)) !== canonical([0, 2.5, 9.5])
    || base.narrationTracks[2].end > 11.75)
    INVALID('original narration timing changed')
  for (const track of base.narrationTracks)
    await verifiedBytes(root, track.url, track.sha256, 'audio')
  return { base, task, media, rejection, native, first, firstSha256, firstUrl, identities, end,
    receiptHashes: { manifestSha256: sha256(manifestBytes), taskSha256: sha256(taskBytes),
      mediaSha256: sha256(mediaBytes), rejectionSha256: sha256(rejectionBytes) } }
}

async function buildPhaseBRequest(source, root) {
  const prepared = await prepareKlingImageInputs({
    referenceImage: `data:image/jpeg;base64,${source.first.toString('base64')}`,
    referenceImages: source.identities.map(asset => asset.url),
    endImage: source.end.url, duration: 6, mode: 'std',
    model_name: 'kling-v3-omni', sound: 'off',
    pacingVersion: 'independent-narration-v1', audioType: '环境声', audioText: '',
  }, path.join(root, 'public/generated'))
  const prompt = a8b5PhaseBPrompt()
  const request = buildKlingVideoRequest({ settings: { model: 'kling-v3-omni' } }, prompt, prepared)
  const imageTypes = request.image_list?.map(item => item.type ?? 'reference')
  if (canonical(imageTypes) !== canonical(['reference', 'reference', 'first_frame', 'end_frame'])
    || request.duration !== '6' || request.model_name !== 'kling-v3-omni'
    || request.sound !== 'off' || Array.from(request.prompt).length > 2500
    || sha256(Buffer.from(request.image_list[2].image_url, 'base64')) !== source.firstSha256
    || sha256(Buffer.from(request.image_list[0].image_url, 'base64')) !== source.identities[0].sha256
    || sha256(Buffer.from(request.image_list[1].image_url, 'base64')) !== source.identities[1].sha256
    || sha256(Buffer.from(request.image_list[3].image_url, 'base64')) !== source.end.jpegSha256)
    INVALID('B paid request lost actual A f192 or approved identity/end sources')
  return { request, preview: { phase: 'B', providerDuration: 6, acceptedDuration: 5,
    globalStart: 8, requestSha256: sha256(canonical(request)),
    requestByteLength: Buffer.byteLength(JSON.stringify(request)),
    promptSha256: sha256(request.prompt), promptCharacters: Array.from(request.prompt).length,
    imageTypes, firstFrameSha256: source.firstSha256,
    identitySha256s: source.identities.map(asset => asset.sha256),
    endFrameSha256: source.end.jpegSha256, providerCalls: 0 } }
}

/** Read-only source and provider-request preflight; no files or DB are changed. */
export async function planA8B5Continuation(basePlanId, root = process.cwd()) {
  validateA8B5Timeline()
  const source = await sourceA(basePlanId, root)
  const { preview } = await buildPhaseBRequest(source, root)
  const body = { version: 'staged-scene-cut-a8b5-provisional-v1',
    source: { planId: basePlanId, ...source.receiptHashes,
      recordId: source.base.sourceRecordId, resultMd5: source.base.sourceResultMd5,
      approvedShotSha256: source.base.approvedShotSha256,
      approvalSha256: source.base.approvalSha256,
      taskId: source.task.taskId, requestSha256: source.task.requestSha256,
      videoUrl: source.media.videoUrl, videoSha256: source.media.videoSha256,
      nativeFrameDigestSha256: source.native.frameDigestSha256,
      nativeFrame192Md5: source.native.hashes[192],
      oldPlanAStatus: 'signed-rejected-at-f180; no A acceptance inherited' },
    sourceAFrame: { index: 192, ptsSeconds: 8, url: source.firstUrl,
      sha256: source.firstSha256, byteLength: source.first.length,
      role: 'provisional-B-first-frame; not accepted A endpoint' },
    identityTransport: source.identities,
    endGuide: { index: 312, url: source.end.url, sha256: source.end.jpegSha256,
      role: 'reference-only' },
    narrationTracks: source.base.narrationTracks,
    providerLock: source.base.providerLock,
    timeline: A8B5_TIMELINE,
    scheduleDeviation: { originalBindingEnd: 7.5, observedFirstHandsOff: 8,
      originalApproachEnd: 9.5, proposedApproachWindow: [8, 9.5],
      originalConstraintMode: 'reference', finalAcceptance: 'pending B continuation and full-shot review' },
    phaseBPreview: preview,
    acceptanceState: 'none; provisional A only; B and two-shot review pending' }
  return { ...body, planId: sha256(canonical(body)), sourceAFrameBytes: source.first }
}

export async function saveA8B5Plan(plan, root = process.cwd()) {
  const rebuilt = await planA8B5Continuation(plan?.source?.planId, root)
  if (plan?.planId !== rebuilt.planId) INVALID('reviewed A8B5 plan changed')
  const key = await signingKey(root)
  const { sourceAFrameBytes: _bytes, ...body } = rebuilt
  void _bytes
  const signed = { ...body, signature: '' }
  signed.signature = signature(signed, key)
  await writeOnce(generatedFile(root, body.sourceAFrame.url), rebuilt.sourceAFrameBytes)
  await writeOnce(path.join(runtimeDirectory(root, plan.planId), 'manifest.json'),
    JSON.stringify(signed, null, 2) + '\n')
  return { planId: plan.planId, manifestPath: path.join(runtimeDirectory(root, plan.planId), 'manifest.json'),
    sourceAFrameUrl: body.sourceAFrame.url, phaseBPreview: body.phaseBPreview }
}

export async function readA8B5Plan(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'manifest.json')
  const manifest = JSON.parse(await readFile(filename, 'utf8'))
  if (manifest.version === 'staged-scene-cut-a8b5-retry-b-v1') {
    const { readA8B5RetryPlan } = await import('./staged-scene-cut-a8b5-retry.mjs')
    return readA8B5RetryPlan(planId, root)
  }
  verifySignature(manifest, await signingKey(root))
  const { signature: _signature, planId: _id, ...body } = manifest
  void _signature; void _id
  if (manifest.version !== 'staged-scene-cut-a8b5-provisional-v1'
    || manifest.planId !== planId || sha256(canonical(body)) !== planId)
    INVALID('continuation manifest identity invalid')
  const rebuilt = await planA8B5Continuation(manifest.source?.planId, root)
  const { sourceAFrameBytes: _bytes, ...expected } = rebuilt
  void _bytes
  if (canonical({ ...body, planId }) !== canonical(expected))
    INVALID('continuation manifest differs from signed source A and request')
  await verifiedBytes(root, manifest.sourceAFrame.url, manifest.sourceAFrame.sha256)
  return manifest
}

export async function previewA8B5PhaseB(planId, root = process.cwd(), includeRequest = false) {
  const manifest = await readA8B5Plan(planId, root)
  if (manifest.version === 'staged-scene-cut-a8b5-retry-b-v1') {
    const { previewA8B5RetryRequestFromSignedManifest } =
      await import('./staged-scene-cut-a8b5-retry.mjs')
    return previewA8B5RetryRequestFromSignedManifest(manifest, root, includeRequest)
  }
  const source = await sourceA(manifest.source.planId, root)
  const { request, preview } = await buildPhaseBRequest(source, root)
  if (canonical(preview) !== canonical(manifest.phaseBPreview))
    INVALID('B request differs from immutable signed preview')
  return includeRequest ? { ...preview, request } : preview
}

const PROVISIONAL_INDICES = Object.freeze([180, 186, 188, 190, 191, 192])
async function validateProvisionalReview(planId, report, root) {
  const manifest = await readA8B5Plan(planId, root)
  const checks = report?.checks
  if (report?.version !== 'staged-a8b5-provisional-a-review-v1'
    || report?.planId !== planId || report?.reviewer !== 'Codex'
    || report?.reviewMethod !== 'agent-direct-native-frames'
    || !Number.isFinite(Date.parse(report?.reviewedAt))
    || report?.verdict !== 'continue-with-B-only'
    || report?.sourceVideoSha256 !== manifest.source.videoSha256
    || report?.sourceFrame192Sha256 !== manifest.sourceAFrame.sha256
    || checks?.frontWristRopeVisibleAtFrame192 !== true
    || checks?.bothGuardsHandsOffAtFrame192 !== true
    || checks?.zhangStationaryThroughFrame192 !== true
    || checks?.stableCompletedHoldInA !== false
    || checks?.BWithdrawalContinuationRequired !== true
    || report?.frames?.length !== PROVISIONAL_INDICES.length
    || typeof report?.limitations !== 'string' || report.limitations.length < 20)
    INVALID('provisional source-A review incomplete or falsely final')
  const video = generatedFile(root, manifest.source.videoUrl, 'video')
  for (const [offset, index] of PROVISIONAL_INDICES.entries()) {
    const frame = report.frames[offset]
    if (frame?.index !== index || !SHA.test(frame?.sha256 ?? '')
      || typeof frame.observation !== 'string' || frame.observation.length < 16
      || frame.sha256 !== sha256(await nativeJpeg(video, index)))
      INVALID(`provisional review frame ${index} unbound`)
  }
  return manifest
}

export async function saveA8B5ProvisionalReview(planId, report, root = process.cwd()) {
  await validateProvisionalReview(planId, report, root)
  const value = { ...report, signature: '' }
  value.signature = signature(value, await signingKey(root))
  const filename = path.join(runtimeDirectory(root, planId), 'provisional-A-review.json')
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readA8B5ProvisionalReview(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'provisional-A-review.json')
  const report = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(report, await signingKey(root))
  const { signature: _signature, ...body } = report
  void _signature
  await validateProvisionalReview(planId, body, root)
  return report
}

async function requireA8B5SourceReview(manifest, root) {
  if (manifest.version === 'staged-scene-cut-a8b5-retry-b-v1') {
    await readA8B5ProvisionalReview(manifest.source.previousPlanId, root)
    await readA8B5BRejection(manifest.source.previousPlanId, root)
  } else await readA8B5ProvisionalReview(manifest.planId, root)
}

export async function saveA8B5BTask(planId, receipt, root = process.cwd()) {
  const manifest = await readA8B5Plan(planId, root)
  await requireA8B5SourceReview(manifest, root)
  if (receipt?.planId !== planId || receipt?.phase !== 'B'
    || !/^[\w-]{8,128}$/.test(String(receipt.taskId ?? ''))
    || receipt.requestSha256 !== manifest.phaseBPreview.requestSha256
    || receipt.providerModelId !== manifest.providerLock.modelId
    || receipt.endpointSha256 !== manifest.providerLock.endpointSha256
    || !Number.isFinite(Date.parse(receipt.submittedAt)))
    INVALID('B provider task receipt differs from signed plan/lock')
  const retry = manifest.version === 'staged-scene-cut-a8b5-retry-b-v1'
  let submitIntentSha256
  if (retry) {
    const intentBytes = await readFile(path.join(runtimeDirectory(root, planId),
      'phase-B-submit-intent.json'))
    const intent = JSON.parse(intentBytes.toString('utf8'))
    if (intent.version !== 'staged-a8b5-retry-B-submit-intent-v1'
      || intent.planId !== planId || intent.phase !== 'B'
      || intent.requestSha256 !== receipt.requestSha256
      || intent.modelId !== receipt.providerModelId
      || intent.endpointSha256 !== receipt.endpointSha256)
      INVALID('retry B task lacks exact write-once pre-POST intent')
    submitIntentSha256 = sha256(intentBytes)
  }
  const value = { version: retry ? 'staged-a8b5-retry-provider-task-v1'
    : 'staged-a8b5-provider-task-v1', planId, phase: 'B',
    taskId: String(receipt.taskId), requestSha256: receipt.requestSha256,
    providerModelId: receipt.providerModelId, endpointSha256: receipt.endpointSha256,
    ...(retry ? { rejectedPreviousPlanId: manifest.source.previousPlanId,
      submitIntentSha256 } : {}),
    submittedAt: receipt.submittedAt, signature: '' }
  value.signature = signature(value, await signingKey(root))
  await writeOnce(path.join(runtimeDirectory(root, planId), 'phase-B-task.json'),
    JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readA8B5BTask(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'phase-B-task.json')
  const task = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(task, await signingKey(root))
  const plan = await readA8B5Plan(planId, root)
  const retry = plan.version === 'staged-scene-cut-a8b5-retry-b-v1'
  let submitIntentSha256
  if (retry) {
    const intentBytes = await readFile(path.join(runtimeDirectory(root, planId),
      'phase-B-submit-intent.json'))
    const intent = JSON.parse(intentBytes.toString('utf8'))
    if (intent.version !== 'staged-a8b5-retry-B-submit-intent-v1'
      || intent.planId !== planId || intent.phase !== 'B'
      || intent.requestSha256 !== plan.phaseBPreview.requestSha256
      || intent.modelId !== plan.providerLock.modelId
      || intent.endpointSha256 !== plan.providerLock.endpointSha256)
      INVALID('retry B write-once intent changed')
    submitIntentSha256 = sha256(intentBytes)
  }
  if (task.version !== (retry ? 'staged-a8b5-retry-provider-task-v1'
    : 'staged-a8b5-provider-task-v1') || task.planId !== planId
    || task.phase !== 'B' || task.requestSha256 !== plan.phaseBPreview.requestSha256
    || task.providerModelId !== plan.providerLock.modelId
    || task.endpointSha256 !== plan.providerLock.endpointSha256
    || (retry && task.rejectedPreviousPlanId !== plan.source.previousPlanId)
    || (retry && task.submitIntentSha256 !== submitIntentSha256)
    || (!retry && task.rejectedPreviousPlanId !== undefined))
    INVALID('B provider task source lock changed')
  return task
}

export async function saveA8B5BMedia(planId, media, root = process.cwd()) {
  const task = await readA8B5BTask(planId, root)
  if (media?.taskId !== task.taskId || !SHA.test(media?.videoSha256 ?? ''))
    INVALID('B media task/hash missing')
  const bytes = await verifiedBytes(root, media.videoUrl, media.videoSha256, 'video')
  if (bytes.length < 10000) INVALID('B media too short')
  const native = await inspectStagedNativeVideo(generatedFile(root, media.videoUrl, 'video'), 145, 6)
  const retry = task.version === 'staged-a8b5-retry-provider-task-v1'
  const value = { version: retry ? 'staged-a8b5-retry-provider-media-v1'
    : 'staged-a8b5-provider-media-v1', planId, phase: 'B', taskId: task.taskId,
    videoUrl: media.videoUrl, videoSha256: media.videoSha256,
    ...(retry ? { rejectedPreviousPlanId: task.rejectedPreviousPlanId } : {}),
    nativeFrameDigestSha256: native.frameDigestSha256, frameCount: 145,
    lastPts: 6, signature: '' }
  value.signature = signature(value, await signingKey(root))
  await writeOnce(path.join(runtimeDirectory(root, planId), 'phase-B-media.json'),
    JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readA8B5BMedia(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'phase-B-media.json')
  const media = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(media, await signingKey(root))
  const task = await readA8B5BTask(planId, root)
  const retry = task.version === 'staged-a8b5-retry-provider-task-v1'
  if (media.version !== (retry ? 'staged-a8b5-retry-provider-media-v1'
    : 'staged-a8b5-provider-media-v1') || media.planId !== planId
    || media.phase !== 'B' || media.taskId !== task.taskId
    || (retry && media.rejectedPreviousPlanId !== task.rejectedPreviousPlanId)
    || (!retry && media.rejectedPreviousPlanId !== undefined)
    || media.frameCount !== 145 || media.lastPts !== 6)
    INVALID('B media receipt changed')
  await verifiedBytes(root, media.videoUrl, media.videoSha256, 'video')
  const native = await inspectStagedNativeVideo(generatedFile(root, media.videoUrl, 'video'), 145, 6)
  if (native.frameDigestSha256 !== media.nativeFrameDigestSha256)
    INVALID('B native media changed')
  return media
}

const A_REVIEW_FRAMES = Object.freeze([188, 190, 191, 192])
const B_REVIEW_FRAMES = Object.freeze([0, 1, 2, 4, 8, 12, 24, 36, 48, 84, 120, 144])
const B_CHECKS = Object.freeze(['aHandsOffAt192', 'bFirstFrameContinuity',
  'withdrawalContinuesWithoutRegrab', 'frontWristBoundThroughB120',
  'zhangStopsByB36', 'zhangHoldsThroughB120', 'identityWardrobeContinuity',
  'noCoreContradiction', 'seamContinuity'])

export async function saveA8B5BReviewEvidence(planId, root = process.cwd()) {
  const manifest = await readA8B5Plan(planId, root)
  await requireA8B5SourceReview(manifest, root)
  const media = await readA8B5BMedia(planId, root)
  const sources = [
    { phase: 'A', url: manifest.source.videoUrl, videoSha256: manifest.source.videoSha256,
      indices: A_REVIEW_FRAMES },
    { phase: 'B', url: media.videoUrl, videoSha256: media.videoSha256,
      indices: B_REVIEW_FRAMES },
  ]
  const frames = []
  for (const source of sources) {
    const filename = generatedFile(root, source.url, 'video')
    for (const index of source.indices) {
      const bytes = await nativeJpeg(filename, index)
      const digest = sha256(bytes)
      const url = `/generated/staged-a8b5-review-${source.videoSha256.slice(0, 16)}-f${index}-${digest.slice(0, 16)}.jpg`
      await writeOnce(generatedFile(root, url), bytes)
      frames.push({ phase: source.phase, index, url, sha256: digest,
        sourceVideoSha256: source.videoSha256 })
    }
  }
  const value = { version: 'staged-a8b5-B-native-evidence-v1', planId,
    sourceAVideoSha256: manifest.source.videoSha256, phaseBVideoSha256: media.videoSha256,
    phaseBNativeFrameDigestSha256: media.nativeFrameDigestSha256,
    frames, reviewImages: frames.map(frame => frame.url), signature: '' }
  value.signature = signature(value, await signingKey(root))
  const filename = path.join(runtimeDirectory(root, planId), 'phase-B-review-evidence.json')
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return { evidence: value, sha256: sha256(await readFile(filename)) }
}

export async function readA8B5BReviewEvidence(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'phase-B-review-evidence.json')
  const bytes = await readFile(filename), evidence = JSON.parse(bytes.toString('utf8'))
  verifySignature(evidence, await signingKey(root))
  const manifest = await readA8B5Plan(planId, root)
  const media = await readA8B5BMedia(planId, root)
  const indices = [...A_REVIEW_FRAMES, ...B_REVIEW_FRAMES]
  if (evidence.version !== 'staged-a8b5-B-native-evidence-v1' || evidence.planId !== planId
    || evidence.sourceAVideoSha256 !== manifest.source.videoSha256
    || evidence.phaseBVideoSha256 !== media.videoSha256
    || evidence.phaseBNativeFrameDigestSha256 !== media.nativeFrameDigestSha256
    || evidence.frames?.length !== indices.length
    || canonical(evidence.reviewImages) !== canonical(evidence.frames.map(frame => frame.url)))
    INVALID('B native review evidence changed')
  for (const [position, frame] of evidence.frames.entries()) {
    const phase = position < A_REVIEW_FRAMES.length ? 'A' : 'B'
    const expectedVideoSha256 = phase === 'A' ? manifest.source.videoSha256 : media.videoSha256
    const videoUrl = phase === 'A' ? manifest.source.videoUrl : media.videoUrl
    if (frame.phase !== phase || frame.index !== indices[position]
      || frame.sourceVideoSha256 !== expectedVideoSha256)
      INVALID('B review frame order/source changed')
    await verifiedBytes(root, frame.url, frame.sha256)
    const native = await nativeJpeg(generatedFile(root, videoUrl, 'video'), frame.index)
    if (sha256(native) !== frame.sha256)
      INVALID(`B review image is not actual ${phase} native frame ${frame.index}`)
  }
  return { evidence, sha256: sha256(bytes) }
}

export function a8b5BReviewPrompt(evidence) {
  if (evidence?.version !== 'staged-a8b5-B-native-evidence-v1')
    INVALID('B model review evidence invalid')
  const template = Object.fromEntries(B_CHECKS.map(key => [key, true]))
  return [
    '你是独立逐帧视觉审核员，只能依据附件里的真实原生视频帧。A段被原7.5秒方案签名拒绝：A第192帧才初见军士双手离腕且撤手未结束，绝不能把A单独判为完成。B段必须从此瞬间无跳变继续撤手，绳索仍在严颜身前双腕；两军士不得再次抓腕、重绑或遮挡绳圈。',
    'B第0帧是供应商真实首帧；合成时舍去B第0帧，直接接A第192帧到B第1帧。检查A第188/190/191/192帧与B第0/1/2/4/8/12帧的动作、人物、衣甲和机位接缝。张飞只能在双手离腕后迈步，B第36帧（全镜9.5秒）之前必须已在严颜面前完全停稳，B第36–120帧持续站稳且绳圈可见。B第120帧是全镜13秒终帧，B第144帧仅核余量。',
    '静态帧无法证明正常速度运动顺滑时应给 uncertain；目标尾帧和提示词不是完成证据。任何撤手倒退、补绑、停步迟到、服装突变或跳切都不能 accept。',
    `A视频SHA256=${evidence.sourceAVideoSha256}；B视频SHA256=${evidence.phaseBVideoSha256}。附件按序：${evidence.frames.map(frame => `${frame.phase}:${frame.index}:${frame.sha256}`).join('，')}。`,
    `只返回JSON：{"version":"staged-a8b5-B-review-v1","phase":"B","videoSha256":"${evidence.phaseBVideoSha256}","decision":"accept|revise|uncertain","checks":${JSON.stringify(template)},"frameObservations":[{"phase":"A|B","index":0,"description":"可见事实"}],"issues":[]}。逐帧给出观察，未看清时不可猜测。`,
  ].join('\n')
}

export async function verifyA8B5BModelReviewLedger(planId, executionId, root = process.cwd(), query) {
  if (!/^model-run-[\w-]+$/.test(String(executionId))) INVALID('independent B model execution ID invalid')
  const { evidence, sha256: nativeEvidenceSha256 } = await readA8B5BReviewEvidence(planId, root)
  const prompt = a8b5BReviewPrompt(evidence)
  let client
  if (!query) {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL
      ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    await client.connect()
    query = client.query.bind(client)
  }
  let row
  try {
    row = (await query(`select id,channel,workflow_id,node_id,model_id,capability,provider,status,
      request_data,response_data from model_execution_records where id=$1`, [executionId])).rows[0]
  } finally { if (client) await client.end() }
  const request = row?.request_data
  if (row?.channel !== 'workflow' || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'staged-a8b5-phase-B-review'
    || row.capability !== 'text' || row.provider !== 'Codex' || row.status !== 'succeeded'
    || request?.operation !== 'history.media-review'
    || !String(request?.requestKey ?? '').startsWith(`staged-a8b5:${planId}:B:${evidence.phaseBVideoSha256}:`)
    || request.prompt !== prompt
    || canonical(request?.params?.reviewImages) !== canonical(evidence.reviewImages)
    || request?.reviewImageHashes?.length !== evidence.frames.length)
    INVALID('independent B review ledger not bound to native evidence')
  for (const [position, frame] of evidence.frames.entries())
    if (request.reviewImageHashes[position]?.url !== frame.url
      || request.reviewImageHashes[position]?.sha256 !== frame.sha256)
      INVALID(`independent model did not see ${frame.phase} frame ${frame.index}`)
  let report
  try { report = parseStructuredJson(extractTextResponse(row.response_data)) }
  catch { INVALID('independent B review JSON invalid') }
  if (report?.version !== 'staged-a8b5-B-review-v1' || report.phase !== 'B'
    || report.videoSha256 !== evidence.phaseBVideoSha256 || report.decision !== 'accept'
    || B_CHECKS.some(check => report.checks?.[check] !== true)
    || !Array.isArray(report.issues) || report.issues.length
    || report.frameObservations?.length !== evidence.frames.length
    || report.frameObservations.some((observation, position) =>
      observation.phase !== evidence.frames[position].phase
      || observation.index !== evidence.frames[position].index
      || typeof observation.description !== 'string' || observation.description.length < 12))
    INVALID('independent model did not establish B native/seam actions')
  return { report, row, ledgerSha256: sha256(canonical(row)),
    nativeEvidenceSha256, requestKey: request.requestKey, promptSha256: sha256(prompt) }
}

export async function saveA8B5BManualReview(planId, report, root = process.cwd()) {
  const { evidence, sha256: nativeEvidenceSha256 } = await readA8B5BReviewEvidence(planId, root)
  if (report?.version !== 'staged-a8b5-B-direct-review-v1'
    || report?.planId !== planId || report?.phase !== 'B'
    || report?.reviewer !== 'Codex' || report?.reviewMethod !== 'agent-direct-visual'
    || !Number.isFinite(Date.parse(report?.reviewedAt))
    || report?.verdict !== 'accept' || report?.seamVerdict !== 'accept'
    || report?.videoSha256 !== evidence.phaseBVideoSha256
    || report?.nativeEvidenceSha256 !== nativeEvidenceSha256
    || report?.normalSpeedPlaybackReviewed !== true
    || B_CHECKS.some(check => report.checks?.[check] !== true)
    || report?.observations?.length !== evidence.frames.length
    || report.observations.some((observation, position) =>
      observation.phase !== evidence.frames[position].phase
      || observation.index !== evidence.frames[position].index
      || observation.sha256 !== evidence.frames[position].sha256
      || typeof observation.description !== 'string' || observation.description.length < 12)
    || !Array.isArray(report?.limitations))
    INVALID('direct B native/seam review incomplete')
  const value = { ...report, signature: '' }
  value.signature = signature(value, await signingKey(root))
  const filename = path.join(runtimeDirectory(root, planId), 'phase-B-manual-review.json')
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return { report: value, sha256: sha256(await readFile(filename)) }
}

export async function readA8B5BManualReview(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'phase-B-manual-review.json')
  const bytes = await readFile(filename), report = JSON.parse(bytes.toString('utf8'))
  verifySignature(report, await signingKey(root))
  const { evidence, sha256: nativeEvidenceSha256 } = await readA8B5BReviewEvidence(planId, root)
  if (report.version !== 'staged-a8b5-B-direct-review-v1' || report.planId !== planId
    || report.videoSha256 !== evidence.phaseBVideoSha256
    || report.nativeEvidenceSha256 !== nativeEvidenceSha256
    || report.verdict !== 'accept' || report.seamVerdict !== 'accept'
    || report.normalSpeedPlaybackReviewed !== true
    || B_CHECKS.some(check => report.checks?.[check] !== true))
    INVALID('signed direct B review changed')
  return { report, sha256: sha256(bytes) }
}

export async function saveA8B5BRejection(planId, report, root = process.cwd()) {
  const media = await readA8B5BMedia(planId, root)
  const directory = runtimeDirectory(root, planId)
  if (existsSync(path.join(directory, 'phase-B-acceptance.json')))
    INVALID('cannot reject accepted B media')
  if (report?.version !== 'staged-a8b5-B-rejection-v1' || report?.planId !== planId
    || report?.phase !== 'B'
    || report?.videoSha256 !== media.videoSha256 || report?.verdict !== 'reject'
    || report?.reviewer !== 'Codex' || report?.reviewMethod !== 'agent-direct-visual'
    || !Number.isFinite(Date.parse(report?.reviewedAt))
    || typeof report?.reason !== 'string' || report.reason.length < 30
    || report?.frames?.length < 2
    || report?.frames?.some(frame => typeof frame.observation !== 'string'
      || frame.observation.length < 12))
    INVALID('B rejection report incomplete')
  const video = generatedFile(root, media.videoUrl, 'video')
  for (const frame of report.frames) {
    if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index > 144
      || !SHA.test(frame.sha256 ?? '')
      || frame.sha256 !== sha256(await nativeJpeg(video, frame.index)))
      INVALID('B rejection frame is not native provider source')
  }
  const value = { ...report, taskId: media.taskId,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    nextPaidPhaseBlocked: true, signature: '' }
  value.signature = signature(value, await signingKey(root))
  await writeOnce(path.join(directory, 'phase-B-rejection.json'), JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readA8B5BRejection(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'phase-B-rejection.json')
  const bytes = await readFile(filename)
  const report = JSON.parse(bytes.toString('utf8'))
  verifySignature(report, await signingKey(root))
  const media = await readA8B5BMedia(planId, root)
  if (report.version !== 'staged-a8b5-B-rejection-v1' || report.planId !== planId
    || report.phase !== 'B' || report.taskId !== media.taskId
    || report.videoSha256 !== media.videoSha256
    || report.nativeFrameDigestSha256 !== media.nativeFrameDigestSha256
    || report.verdict !== 'reject' || report.nextPaidPhaseBlocked !== true
    || report.frames?.length < 2)
    INVALID('signed B rejection changed')
  const video = generatedFile(root, media.videoUrl, 'video')
  for (const frame of report.frames)
    if (!Number.isInteger(frame?.index) || frame.index < 0 || frame.index > 144
      || !SHA.test(frame.sha256 ?? '')
      || frame.sha256 !== sha256(await nativeJpeg(video, frame.index)))
      INVALID('signed B rejection native frame changed')
  return { report, sha256: sha256(bytes) }
}

export async function saveA8B5BAcceptance(planId, evidence, root = process.cwd()) {
  const directory = runtimeDirectory(root, planId)
  if (existsSync(path.join(directory, 'phase-B-rejection.json')))
    INVALID('B was explicitly rejected')
  const manifest = await readA8B5Plan(planId, root)
  const task = await readA8B5BTask(planId, root)
  const media = await readA8B5BMedia(planId, root)
  const model = await verifyA8B5BModelReviewLedger(planId, evidence?.review?.executionId, root)
  const manual = await readA8B5BManualReview(planId, root)
  const video = generatedFile(root, media.videoUrl, 'video')
  const last = await nativeJpeg(video, 120), first = await nativeJpeg(video, 0)
  const stitchedFirst = await nativeJpeg(video, 1)
  if (evidence?.version !== 'staged-a8b5-B-acceptance-input-v1'
    || evidence?.planId !== planId || evidence?.phase !== 'B'
    || evidence?.taskId !== task.taskId || evidence?.videoSha256 !== media.videoSha256
    || evidence?.acceptedFrameIndex !== 120
    || evidence?.acceptedFrameSha256 !== sha256(last)
    || evidence?.firstFrameSha256 !== sha256(first)
    || evidence?.stitchedFirstFrameSha256 !== sha256(stitchedFirst)
    || evidence?.nativeEvidenceSha256 !== model.nativeEvidenceSha256
    || evidence?.review?.verdict !== 'accept'
    || evidence.review.manualVerdict !== 'accept'
    || evidence.review.ledgerSha256 !== model.ledgerSha256
    || evidence.review.requestKey !== model.requestKey
    || evidence.review.promptSha256 !== model.promptSha256
    || evidence.review.manualReviewSha256 !== manual.sha256
    || evidence?.seamReview?.verdict !== 'accept'
    || evidence.seamReview.manualVerdict !== 'accept'
    || evidence.seamReview.phaseAFrameSha256 !== manifest.sourceAFrame.sha256
    || evidence.seamReview.phaseBFrameSha256 !== sha256(first)
    || evidence.seamReview.phaseBStitchedFirstFrameSha256 !== sha256(stitchedFirst)
    || evidence.seamReview.ledgerSha256 !== model.ledgerSha256
    || evidence.seamReview.manualReviewSha256 !== manual.sha256
    || B_CHECKS.some(check => evidence.checks?.[check] !== true
      || model.report.checks?.[check] !== true || manual.report.checks?.[check] !== true))
    INVALID('B native/seam acceptance lacks independent and direct evidence')
  const frameSha = sha256(last)
  const acceptedFrameUrl = `/generated/staged-a8b5-seam-${media.videoSha256.slice(0, 16)}-f120-${frameSha.slice(0, 16)}.jpg`
  await writeOnce(generatedFile(root, acceptedFrameUrl), last)
  const seam = { phaseAFrameIndex: 192, phaseAFrameSha256: manifest.sourceAFrame.sha256,
    phaseBFirstFrameIndex: 0, phaseBFirstFrameSha256: sha256(first),
    stitchedPhaseBStartFrameIndex: 1,
    phaseBStitchedFirstFrameSha256: sha256(stitchedFirst),
    review: evidence.seamReview }
  const value = { version: 'staged-a8b5-native-acceptance-v1', planId, phase: 'B',
    taskId: task.taskId, videoUrl: media.videoUrl, videoSha256: media.videoSha256,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    acceptedFrameIndex: 120, acceptedFrameSha256: frameSha, acceptedFrameUrl,
    nativeEvidenceSha256: model.nativeEvidenceSha256,
    review: evidence.review, checks: evidence.checks, seam, signature: '' }
  value.signature = signature(value, await signingKey(root))
  await writeOnce(path.join(directory, 'phase-B-acceptance.json'),
    JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readA8B5BAcceptance(planId, root = process.cwd()) {
  const directory = runtimeDirectory(root, planId)
  if (existsSync(path.join(directory, 'phase-B-rejection.json')))
    INVALID('B rejection blocks acceptance')
  const filename = path.join(directory, 'phase-B-acceptance.json')
  const acceptance = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(acceptance, await signingKey(root))
  const manifest = await readA8B5Plan(planId, root)
  const task = await readA8B5BTask(planId, root)
  const media = await readA8B5BMedia(planId, root)
  const model = await verifyA8B5BModelReviewLedger(planId, acceptance.review?.executionId, root)
  const manual = await readA8B5BManualReview(planId, root)
  if (acceptance.version !== 'staged-a8b5-native-acceptance-v1'
    || acceptance.planId !== planId || acceptance.phase !== 'B'
    || acceptance.taskId !== task.taskId
    || acceptance.videoUrl !== media.videoUrl
    || acceptance.videoSha256 !== media.videoSha256
    || acceptance.nativeFrameDigestSha256 !== media.nativeFrameDigestSha256
    || acceptance.acceptedFrameIndex !== 120
    || acceptance.review?.verdict !== 'accept'
    || acceptance.review?.manualVerdict !== 'accept'
    || acceptance.review.ledgerSha256 !== model.ledgerSha256
    || acceptance.review.requestKey !== model.requestKey
    || acceptance.review.promptSha256 !== model.promptSha256
    || acceptance.review.manualReviewSha256 !== manual.sha256
    || acceptance.nativeEvidenceSha256 !== model.nativeEvidenceSha256
    || B_CHECKS.some(check => acceptance.checks?.[check] !== true)
    || acceptance.seam?.phaseAFrameIndex !== 192
    || acceptance.seam.phaseAFrameSha256 !== manifest.sourceAFrame.sha256
    || acceptance.seam.phaseBFirstFrameIndex !== 0
    || acceptance.seam.stitchedPhaseBStartFrameIndex !== 1
    || acceptance.seam.review?.verdict !== 'accept'
    || acceptance.seam.review?.manualVerdict !== 'accept')
    INVALID('B signed native/seam acceptance changed')
  const video = generatedFile(root, acceptance.videoUrl, 'video')
  for (const [index, expected] of [[0, acceptance.seam.phaseBFirstFrameSha256],
    [1, acceptance.seam.phaseBStitchedFirstFrameSha256],
    [120, acceptance.acceptedFrameSha256]])
    if (sha256(await nativeJpeg(video, index)) !== expected)
      INVALID(`B native frame ${index} changed after acceptance`)
  await verifiedBytes(root, acceptance.acceptedFrameUrl, acceptance.acceptedFrameSha256)
  return acceptance
}

export async function saveA8B5TerminalFailure(planId, receipt, root = process.cwd()) {
  const task = await readA8B5BTask(planId, root)
  if (receipt?.taskId !== task.taskId || receipt?.status !== 'failed'
    || receipt?.requestSha256 !== task.requestSha256
    || !Number.isFinite(Date.parse(receipt.observedAt)))
    INVALID('B terminal failure unbound')
  const value = { version: 'staged-a8b5-provider-failure-v1', planId,
    taskId: task.taskId, requestSha256: task.requestSha256,
    status: 'failed', observedAt: receipt.observedAt,
    providerMessage: String(receipt.providerMessage ?? ''),
    noAutomaticRetry: true, signature: '' }
  value.signature = signature(value, await signingKey(root))
  await writeOnce(path.join(runtimeDirectory(root, planId), 'phase-B-failure.json'),
    JSON.stringify(value, null, 2) + '\n')
  return value
}

export function inspectA8B5RawIntent(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'phase-B-submit-intent.json')
  try { return JSON.parse(readFileSync(filename, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

const A8B5_MAPPING = Object.freeze({
  phaseA: { sourceStartFrame: 0, sourceEndFrame: 192,
    outputStartFrame: 0, outputEndFrame: 192 },
  phaseB: { sourceStartFrame: 1, sourceEndFrame: 120,
    outputStartFrame: 193, outputEndFrame: 312 },
})

function readSignedSync(filename, key) {
  const bytes = readFileSync(filename)
  const value = JSON.parse(bytes.toString('utf8'))
  verifySignature(value, key)
  return { value, sha256: sha256(bytes) }
}
function verifiedAssetSync(root, url, expected, type = 'image') {
  if (!SHA.test(String(expected))
    || sha256(readFileSync(generatedFile(root, url, type))) !== expected)
    INVALID(`composite source asset changed: ${url}`)
}

/** Synchronous replay gate: exact signed lineage and current bytes. The async
 * verifier additionally decodes all native picture/audio and model reviews. */
export function verifyA8B5CompositeReceiptSync(planId, root = process.cwd()) {
  const directory = runtimeDirectory(root, planId)
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) INVALID('staging signature key invalid')
  const { value: manifest, sha256: manifestSha256 } = readSignedSync(path.join(directory, 'manifest.json'), key)
  const { planId: _id, signature: _signature, ...planBody } = manifest
  void _id; void _signature
  const retry = manifest.version === 'staged-scene-cut-a8b5-retry-b-v1'
  if (!retry && manifest.version !== 'staged-scene-cut-a8b5-provisional-v1'
    || manifest.planId !== planId || sha256(canonical(planBody)) !== planId
    || !validateA8B5Timeline(manifest.timeline)
    || manifest.acceptanceState !== (retry
      ? 'none; retry preview only; no provider task'
      : 'none; provisional A only; B and two-shot review pending')
    || manifest.phaseBPreview?.acceptedDuration !== 5
    || manifest.phaseBPreview?.firstFrameSha256 !== manifest.sourceAFrame?.sha256
    || manifest.sourceAFrame?.index !== 192 || manifest.sourceAFrame?.ptsSeconds !== 8)
    INVALID('A8+B5 signed manifest/timeline changed')
  const baseDirectory = path.join(root, '.runtime/staged-scene-cut', manifest.source?.planId ?? '')
  const oldManifest = readSignedSync(path.join(baseDirectory, 'manifest.json'), key)
  const oldTask = readSignedSync(path.join(baseDirectory, 'phase-A-task.json'), key)
  const oldMedia = readSignedSync(path.join(baseDirectory, 'phase-A-media.json'), key)
  const oldRejection = readSignedSync(path.join(baseDirectory, 'phase-A-rejection.json'), key)
  if (existsSync(path.join(baseDirectory, 'phase-A-acceptance.json'))
    || oldManifest.sha256 !== manifest.source.manifestSha256
    || oldTask.sha256 !== manifest.source.taskSha256
    || oldMedia.sha256 !== manifest.source.mediaSha256
    || oldRejection.sha256 !== manifest.source.rejectionSha256
    || oldManifest.value.version !== 'staged-scene-cut-shot1-v3-compact1'
    || oldManifest.value.sourceRecordId !== manifest.source.recordId
    || oldManifest.value.sourceResultMd5 !== manifest.source.resultMd5
    || oldManifest.value.approvedShotSha256 !== manifest.source.approvedShotSha256
    || oldManifest.value.approvalSha256 !== manifest.source.approvalSha256
    || canonical(oldManifest.value.narrationTracks) !== canonical(manifest.narrationTracks)
    || oldTask.value.planId !== manifest.source.planId
    || oldTask.value.taskId !== manifest.source.taskId
    || oldTask.value.requestSha256 !== manifest.source.requestSha256
    || oldMedia.value.taskId !== oldTask.value.taskId
    || oldMedia.value.videoUrl !== manifest.source.videoUrl
    || oldMedia.value.videoSha256 !== manifest.source.videoSha256
    || oldMedia.value.nativeFrameDigestSha256 !== manifest.source.nativeFrameDigestSha256
    || oldRejection.value.taskId !== oldTask.value.taskId
    || oldRejection.value.videoSha256 !== oldMedia.value.videoSha256
    || oldRejection.value.nextPaidPhaseBlocked !== true
    || manifest.source.oldPlanAStatus !== 'signed-rejected-at-f180; no A acceptance inherited')
    INVALID('old A rejected paid source lineage changed or acquired an acceptance')
  verifiedAssetSync(root, manifest.source.videoUrl, manifest.source.videoSha256, 'video')
  verifiedAssetSync(root, manifest.sourceAFrame.url, manifest.sourceAFrame.sha256)
  for (const asset of manifest.identityTransport)
    verifiedAssetSync(root, asset.url, asset.sha256)
  verifiedAssetSync(root, manifest.endGuide.url, manifest.endGuide.sha256)
  for (const track of manifest.narrationTracks)
    verifiedAssetSync(root, track.url, track.sha256, 'audio')
  let provisionalDirectory = directory, provisionalPlanId = planId
  if (retry) {
    const priorId = manifest.source.previousPlanId
    const priorDirectory = runtimeDirectory(root, priorId)
    if (priorId === planId
      || existsSync(path.join(priorDirectory, 'phase-B-acceptance.json'))
      || existsSync(path.join(priorDirectory, 'composite-receipt.json')))
      INVALID('retry predecessor already accepted or cycles')
    const previous = readSignedSync(path.join(priorDirectory, 'manifest.json'), key)
    const priorProvisional = readSignedSync(path.join(priorDirectory, 'provisional-A-review.json'), key)
    const priorTask = readSignedSync(path.join(priorDirectory, 'phase-B-task.json'), key)
    const priorMedia = readSignedSync(path.join(priorDirectory, 'phase-B-media.json'), key)
    const priorRejection = readSignedSync(path.join(priorDirectory, 'phase-B-rejection.json'), key)
    const priorIntentBytes = readFileSync(path.join(priorDirectory, 'phase-B-submit-intent.json'))
    const priorIntent = JSON.parse(priorIntentBytes.toString('utf8'))
    if (previous.sha256 !== manifest.source.previousManifestSha256
      || previous.value.version !== 'staged-scene-cut-a8b5-provisional-v1'
      || previous.value.planId !== priorId
      || previous.value.source.planId !== manifest.source.planId
      || previous.value.source.videoSha256 !== manifest.source.videoSha256
      || previous.value.sourceAFrame.sha256 !== manifest.sourceAFrame.sha256
      || previous.value.phaseBPreview.requestSha256 === manifest.phaseBPreview.requestSha256
      || priorProvisional.sha256 !== manifest.source.previousProvisionalAReviewSha256
      || sha256(priorIntentBytes) !== manifest.source.previousBSubmitIntentSha256
      || priorIntent.planId !== priorId
      || priorIntent.requestSha256 !== previous.value.phaseBPreview.requestSha256
      || priorTask.sha256 !== manifest.source.previousBTaskSha256
      || priorTask.value.taskId !== manifest.source.previousBTaskId
      || priorTask.value.requestSha256 !== priorIntent.requestSha256
      || priorTask.value.requestSha256 !== manifest.source.previousBRequestSha256
      || priorMedia.sha256 !== manifest.source.previousBMediaSha256
      || priorMedia.value.taskId !== priorTask.value.taskId
      || priorMedia.value.videoSha256 !== manifest.source.previousBVideoSha256
      || priorMedia.value.nativeFrameDigestSha256 !== manifest.source.previousBNativeFrameDigestSha256
      || priorRejection.sha256 !== manifest.source.previousBRejectionSha256
      || priorRejection.value.taskId !== priorTask.value.taskId
      || priorRejection.value.videoSha256 !== priorMedia.value.videoSha256
      || priorRejection.value.nextPaidPhaseBlocked !== true
      || manifest.source.sourceAOriginalPlanId !== manifest.source.planId
      || manifest.source.sourceAOriginalRejectionSha256 !== manifest.source.rejectionSha256
      || manifest.source.sourceAOriginalVideoSha256 !== manifest.source.videoSha256
      || manifest.endGuide.role !== 'signed-source-only; omitted-from-paid-request'
      || manifest.phaseBPreview.endFrameSent !== false
      || canonical(manifest.phaseBPreview.imageTypes)
        !== canonical(['reference', 'reference', 'first_frame']))
      INVALID('retry previous B signed rejection or no-end-frame request changed')
    verifiedAssetSync(root, priorMedia.value.videoUrl, priorMedia.value.videoSha256, 'video')
    provisionalDirectory = priorDirectory
    provisionalPlanId = priorId
  }
  const provisional = readSignedSync(path.join(provisionalDirectory, 'provisional-A-review.json'), key)
  if (provisional.value.planId !== provisionalPlanId
    || provisional.value.verdict !== 'continue-with-B-only'
    || provisional.value.sourceVideoSha256 !== manifest.source.videoSha256
    || provisional.value.sourceFrame192Sha256 !== manifest.sourceAFrame.sha256
    || provisional.value.checks?.stableCompletedHoldInA !== false
    || provisional.value.checks?.BWithdrawalContinuationRequired !== true)
    INVALID('provisional A proof falsely claims completion or changed')
  if (existsSync(path.join(directory, 'phase-B-rejection.json'))
    || existsSync(path.join(directory, 'phase-B-failure.json')))
    INVALID('B was rejected or provider failed')
  const task = readSignedSync(path.join(directory, 'phase-B-task.json'), key)
  const media = readSignedSync(path.join(directory, 'phase-B-media.json'), key)
  let retryIntentSha256
  if (retry) {
    const intentBytes = readFileSync(path.join(directory, 'phase-B-submit-intent.json'))
    const intent = JSON.parse(intentBytes.toString('utf8'))
    if (intent.version !== 'staged-a8b5-retry-B-submit-intent-v1'
      || intent.planId !== planId || intent.phase !== 'B'
      || intent.requestSha256 !== manifest.phaseBPreview.requestSha256
      || intent.modelId !== manifest.providerLock.modelId
      || intent.endpointSha256 !== manifest.providerLock.endpointSha256)
      INVALID('retry current B write-once intent changed')
    retryIntentSha256 = sha256(intentBytes)
  }
  const evidence = readSignedSync(path.join(directory, 'phase-B-review-evidence.json'), key)
  const manual = readSignedSync(path.join(directory, 'phase-B-manual-review.json'), key)
  const acceptance = readSignedSync(path.join(directory, 'phase-B-acceptance.json'), key)
  if (task.value.version !== (retry ? 'staged-a8b5-retry-provider-task-v1'
    : 'staged-a8b5-provider-task-v1')
    || task.value.planId !== planId || task.value.phase !== 'B'
    || (retry && task.value.rejectedPreviousPlanId !== manifest.source.previousPlanId)
    || (retry && task.value.submitIntentSha256 !== retryIntentSha256)
    || (!retry && task.value.rejectedPreviousPlanId !== undefined)
    || task.value.requestSha256 !== manifest.phaseBPreview.requestSha256
    || task.value.providerModelId !== manifest.providerLock.modelId
    || task.value.endpointSha256 !== manifest.providerLock.endpointSha256
    || media.value.version !== (retry ? 'staged-a8b5-retry-provider-media-v1'
      : 'staged-a8b5-provider-media-v1')
    || media.value.planId !== planId || media.value.taskId !== task.value.taskId
    || (retry && media.value.rejectedPreviousPlanId !== manifest.source.previousPlanId)
    || (!retry && media.value.rejectedPreviousPlanId !== undefined)
    || media.value.frameCount !== 145 || media.value.lastPts !== 6
    || evidence.value.phaseBVideoSha256 !== media.value.videoSha256
    || evidence.value.sourceAVideoSha256 !== manifest.source.videoSha256
    || manual.value.planId !== planId || manual.value.videoSha256 !== media.value.videoSha256
    || manual.value.verdict !== 'accept' || manual.value.seamVerdict !== 'accept'
    || manual.value.normalSpeedPlaybackReviewed !== true
    || B_CHECKS.some(check => manual.value.checks?.[check] !== true)
    || acceptance.value.version !== 'staged-a8b5-native-acceptance-v1'
    || acceptance.value.planId !== planId || acceptance.value.taskId !== task.value.taskId
    || acceptance.value.videoUrl !== media.value.videoUrl
    || acceptance.value.videoSha256 !== media.value.videoSha256
    || acceptance.value.nativeFrameDigestSha256 !== media.value.nativeFrameDigestSha256
    || acceptance.value.acceptedFrameIndex !== 120
    || acceptance.value.nativeEvidenceSha256 !== evidence.sha256
    || acceptance.value.review?.verdict !== 'accept'
    || acceptance.value.review?.manualVerdict !== 'accept'
    || acceptance.value.review.manualReviewSha256 !== manual.sha256
    || acceptance.value.seam?.phaseAFrameIndex !== 192
    || acceptance.value.seam.phaseAFrameSha256 !== manifest.sourceAFrame.sha256
    || acceptance.value.seam.phaseBFirstFrameIndex !== 0
    || acceptance.value.seam.stitchedPhaseBStartFrameIndex !== 1
    || acceptance.value.seam.review?.verdict !== 'accept'
    || acceptance.value.seam.review?.manualVerdict !== 'accept'
    || B_CHECKS.some(check => acceptance.value.checks?.[check] !== true))
    INVALID('B paid media or independent/native seam acceptance incomplete')
  verifiedAssetSync(root, media.value.videoUrl, media.value.videoSha256, 'video')
  verifiedAssetSync(root, acceptance.value.acceptedFrameUrl,
    acceptance.value.acceptedFrameSha256)
  for (const frame of evidence.value.frames ?? []) verifiedAssetSync(root, frame.url, frame.sha256)
  const { value: receipt, sha256: receiptSha256 } = readSignedSync(path.join(directory, 'composite-receipt.json'), key)
  const A = manifest.source, B = acceptance.value
  if (receipt.version !== 'staged-a8b5-composite-v1' || receipt.planId !== planId
    || receipt.manifestSha256 !== manifestSha256
    || canonical(receipt.retrySource ?? null) !== canonical(retry ? {
      previousPlanId: A.previousPlanId,
      previousBTaskId: A.previousBTaskId,
      previousBVideoSha256: A.previousBVideoSha256,
      previousBRejectionSha256: A.previousBRejectionSha256,
      previousBRequestSha256: A.previousBRequestSha256,
    } : null)
    || receipt.sourceRecordId !== A.recordId || receipt.sourceResultMd5 !== A.resultMd5
    || receipt.approvedShotSha256 !== A.approvedShotSha256
    || receipt.approvalSha256 !== A.approvalSha256
    || canonical(receipt.mapping) !== canonical(A8B5_MAPPING)
    || receipt.sources?.phaseA?.taskId !== A.taskId
    || receipt.sources.phaseA.videoUrl !== A.videoUrl
    || receipt.sources.phaseA.videoSha256 !== A.videoSha256
    || receipt.sources.phaseA.acceptedFrameIndex !== 192
    || receipt.sources.phaseA.sourcePlanId !== A.planId
    || receipt.sources.phaseA.sourceRejectionSha256 !== A.rejectionSha256
    || receipt.sources?.phaseB?.taskId !== B.taskId
    || receipt.sources.phaseB.videoUrl !== B.videoUrl
    || receipt.sources.phaseB.videoSha256 !== B.videoSha256
    || receipt.sources.phaseB.acceptedFrameIndex !== 120
    || canonical(receipt.seam) !== canonical(B.seam)
    || receipt.picture?.frameCount !== 313 || receipt.picture.fps !== 24
    || receipt.picture.lastPts !== 13 || receipt.picture.silentAudio !== true
    || !SHA.test(receipt.picture.nativeFrameDigestSha256 ?? '')
    || receipt.narration?.mixerVersion !== 6
    || receipt.narration.fullSourceMute !== true
    || canonical(receipt.narration.ttsTrackSha256s)
      !== canonical(manifest.narrationTracks.map(track => track.sha256))
    || receipt.output?.url !== receipt.narration.url
    || receipt.output.sha256 !== receipt.narration.sha256
    || receipt.review?.seamVerdict !== 'accept'
    || receipt.review.wholeShot !== 'pending-node58')
    INVALID('A8+B5 composite receipt lost exact sources, frames or original TTS')
  verifiedAssetSync(root, receipt.picture.url, receipt.picture.sha256, 'video')
  verifiedAssetSync(root, receipt.output.url, receipt.output.sha256, 'video')
  const keyMatch = /^\/generated\/narrated-([a-f0-9]{64})\.mp4$/.exec(receipt.output.url)
  if (!keyMatch || keyMatch[1] !== receipt.narration.compositionReceiptKey)
    INVALID('A8+B5 narration output does not use standard composition')
  const compositionBytes = readFileSync(path.join(root, '.runtime/narration-compositions', `${keyMatch[1]}.json`))
  const composition = JSON.parse(compositionBytes.toString('utf8'))
  const windows = composition.pictureVoiceIsolation?.mutedWindows
  if (sha256(compositionBytes) !== receipt.narration.compositionReceiptSha256
    || composition.version !== 'narration-composition-v1'
    || composition.key !== keyMatch[1]
    || composition.outputUrl !== receipt.output.url
    || composition.outputSha256 !== receipt.output.sha256
    || composition.pictureUrl !== receipt.picture.url
    || composition.pictureSha256 !== receipt.picture.sha256
    || composition.mixerVersion !== 6 || composition.duration !== 13
    || composition.audioRole !== 'narration'
    || canonical(composition.tracks) !== canonical(manifest.narrationTracks)
    || composition.pictureVoiceIsolation?.status !== 'fully-muted-unverified'
    || composition.pictureVoiceIsolation.sourceSha256 !== receipt.picture.sha256
    || composition.pictureVoiceIsolation.preservedOutsideWindows !== false
    || !Array.isArray(windows) || !windows.some(window => window.start <= 0 && window.end >= 13))
    INVALID('A8+B5 standard narration/full-picture-mute receipt invalid')
  return { manifest, receipt, manifestSha256, receiptSha256 }
}

async function assertSilentAudio(filename) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 16000 * 4 * 12.9 || stdout.length % 4)
    INVALID('A8+B5 stitched picture silent audio missing or truncated')
  for (let offset = 0; offset < stdout.length; offset += 4)
    if (Math.abs(stdout.readFloatLE(offset)) > .00001)
      INVALID('A8+B5 stitched picture contains native source audio')
  return true
}

export async function verifyA8B5CompositeReceipt(planId, root = process.cwd()) {
  const verified = verifyA8B5CompositeReceiptSync(planId, root)
  const { manifest, receipt } = verified
  await readA8B5Plan(planId, root)
  await requireA8B5SourceReview(manifest, root)
  const B = await readA8B5BAcceptance(planId, root)
  const picture = await inspectStagedNativeVideo(generatedFile(root, receipt.picture.url, 'video'), 313, 13)
  const final = await inspectStagedNativeVideo(generatedFile(root, receipt.output.url, 'video'), 313, 13)
  if (picture.frameDigestSha256 !== receipt.picture.nativeFrameDigestSha256
    || final.count !== manifest.timeline.deliveredFrames
    || B.videoSha256 !== receipt.sources.phaseB.videoSha256)
    INVALID('A8+B5 native composite media changed')
  await assertSilentAudio(generatedFile(root, receipt.picture.url, 'video'))
  return verified
}

/** Stitch only the signed A source and independently accepted B native clip.
 * Provider sound is discarded before original narration is mixed. */
export async function composeA8B5SceneCut(planId, root = process.cwd()) {
  const manifest = await readA8B5Plan(planId, root)
  await requireA8B5SourceReview(manifest, root)
  const B = await readA8B5BAcceptance(planId, root)
  const manifestSha256 = sha256(await readFile(path.join(runtimeDirectory(root, planId), 'manifest.json')))
  const pictureKey = sha256(canonical({ version: 'staged-a8b5-picture-v1', planId,
    phaseA: { sha256: manifest.source.videoSha256,
      nativeFrameDigestSha256: manifest.source.nativeFrameDigestSha256 },
    phaseB: { sha256: B.videoSha256, nativeFrameDigestSha256: B.nativeFrameDigestSha256 },
    mapping: A8B5_MAPPING }))
  const pictureUrl = `/generated/staged-a8b5-picture-${pictureKey}.mp4`
  const pictureFile = generatedFile(root, pictureUrl, 'video')
  if (!existsSync(pictureFile)) {
    const temporary = path.join(root, 'public/generated',
      `staged-a8b5-picture-${pictureKey}-${randomUUID()}.mp4`)
    const filter = '[0:v]trim=start_frame=0:end_frame=193,setpts=PTS-STARTPTS[a];'
      + '[1:v]trim=start_frame=1:end_frame=121,setpts=PTS-STARTPTS[b];'
      + '[a][b]concat=n=2:v=1:a=0,fps=24[v];'
      + '[2:a]atrim=duration=13.041666667,asetpts=PTS-STARTPTS[s]'
    await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror',
      '-i', generatedFile(root, manifest.source.videoUrl, 'video'),
      '-i', generatedFile(root, B.videoUrl, 'video'),
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex', filter, '-map', '[v]', '-map', '[s]', '-frames:v', '313',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-movflags', '+faststart', temporary],
    { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
    try { await writeOnce(pictureFile, await readFile(temporary)) }
    finally { const { unlink } = await import('node:fs/promises'); await unlink(temporary).catch(() => {}) }
  }
  const pictureSha256 = sha256(await readFile(pictureFile))
  const pictureNative = await inspectStagedNativeVideo(pictureFile, 313, 13)
  await assertSilentAudio(pictureFile)
  const narrated = await composeNarration(pictureUrl, manifest.narrationTracks, 13,
    '16:9', root, '720p', 'narration',
    { detectPictureVoice: async () => { throw Error('verified silent picture: full source mute required') } })
  const outputSha256 = sha256(await readFile(generatedFile(root, narrated.url, 'video')))
  await inspectStagedNativeVideo(generatedFile(root, narrated.url, 'video'), 313, 13)
  const keyMatch = /^\/generated\/narrated-([a-f0-9]{64})\.mp4$/.exec(narrated.url)
  if (!keyMatch) INVALID('standard narration composition did not return content address')
  const compositionReceiptSha256 = sha256(await readFile(path.join(root,
    '.runtime/narration-compositions', `${keyMatch[1]}.json`)))
  const value = { version: 'staged-a8b5-composite-v1', planId, manifestSha256,
    sourceRecordId: manifest.source.recordId, sourceResultMd5: manifest.source.resultMd5,
    approvedShotSha256: manifest.source.approvedShotSha256,
    approvalSha256: manifest.source.approvalSha256,
    ...(manifest.version === 'staged-scene-cut-a8b5-retry-b-v1'
      ? { retrySource: { previousPlanId: manifest.source.previousPlanId,
        previousBTaskId: manifest.source.previousBTaskId,
        previousBVideoSha256: manifest.source.previousBVideoSha256,
        previousBRejectionSha256: manifest.source.previousBRejectionSha256,
        previousBRequestSha256: manifest.source.previousBRequestSha256 } } : {}),
    sources: { phaseA: { taskId: manifest.source.taskId,
      videoUrl: manifest.source.videoUrl, videoSha256: manifest.source.videoSha256,
      acceptedFrameIndex: 192, sourcePlanId: manifest.source.planId,
      sourceRejectionSha256: manifest.source.rejectionSha256,
      sourceStatus: 'provisional-continuation; not standalone acceptance' },
    phaseB: { taskId: B.taskId, videoUrl: B.videoUrl,
      videoSha256: B.videoSha256, acceptedFrameIndex: 120 } },
    mapping: A8B5_MAPPING, seam: B.seam,
    picture: { url: pictureUrl, sha256: pictureSha256,
      nativeFrameDigestSha256: pictureNative.frameDigestSha256,
      frameCount: 313, fps: 24, lastPts: 13, silentAudio: true },
    narration: { url: narrated.url, sha256: outputSha256,
      compositionReceiptKey: keyMatch[1], compositionReceiptSha256,
      mixerVersion: 6, fullSourceMute: true,
      ttsTrackSha256s: manifest.narrationTracks.map(track => track.sha256) },
    output: { url: narrated.url, sha256: outputSha256 },
    review: { seamVerdict: 'accept', wholeShot: 'pending-node58' }, signature: '' }
  value.signature = signature(value, await signingKey(root))
  await writeOnce(path.join(runtimeDirectory(root, planId), 'composite-receipt.json'),
    JSON.stringify(value, null, 2) + '\n')
  return verifyA8B5CompositeReceipt(planId, root)
}
