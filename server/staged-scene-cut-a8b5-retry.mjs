/** A distinct, source-bound B request after the first B clip was rejected.
 * Plan and preview are read-only; saving signs a manifest. No provider call is
 * possible from this module. Paid submission requires a separate guarded step. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildKlingVideoRequest, prepareKlingImageInputs } from './model-adapters.ts'
import { readA8B5Plan, readA8B5ProvisionalReview,
  readA8B5BRejection } from './staged-scene-cut-a8b5.mjs'

const SHA = /^[a-f0-9]{64}$/
const INVALID = message => { throw Error(`STAGED_A8B5_RETRY_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const runtimeDirectory = (root, planId) => {
  if (!SHA.test(String(planId))) INVALID('retry plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b5', planId)
}
const previousDirectory = (root, planId) => {
  if (!SHA.test(String(planId))) INVALID('previous plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b5', planId)
}
const generatedImage = (root, url) => {
  if (!/^\/generated\/[\w.-]+\.(?:jpg|jpeg|png)$/i.test(url ?? '') || url.includes('..'))
    INVALID('signed source image URL invalid')
  return path.join(root, 'public', url.slice(1))
}
async function exactAsset(root, url, expectedSha256) {
  if (!SHA.test(String(expectedSha256))) INVALID('image SHA-256 invalid')
  const bytes = await readFile(generatedImage(root, url))
  if (sha256(bytes) !== expectedSha256) INVALID(`signed source image changed: ${url}`)
  return bytes
}
async function signingKey(root) {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) INVALID('staged source signing key invalid')
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
    INVALID('signed retry manifest changed')
}
async function writeOnce(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true })
  const bytes = Buffer.from(value)
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      INVALID(`existing retry manifest differs: ${filename}`)
  }
}

export function a8b5RetryBPrompt() {
  return [
    '16:9 真人实景，单机位连续六秒，首帧严格接续上一段原生第192帧。江州战后同一街口，画面中四人衣甲、脸、绳索和站位延续首帧。画内四人全程不说话、没有语言口型。',
    '动作从第0帧立即开始：严颜身前双腕绳结已完整，左右军士各自双手持续落在自己身侧，向侧后方各撤一步。第0至0.25秒完成这一步，双腕和绳结保持无遮挡。',
    '同时张飞从画面左侧原站位立即迈步。第0.25至1.5秒沿原街道走近严颜，1.5秒即第36帧之前双脚着地、身体停稳于严颜身前左侧，严颜正面与双腕绳结始终清楚可见。',
    '第1.5至5秒保持完成后的站位：张飞双脚不再挪动，军士站在严颜两侧后方看押，四人只保留呼吸与衣摆微动；交付终帧为第120帧。第5至6秒延续同一稳定画面供核验。',
    '维持真实摄影的动作速度、人物比例和街景光线，无转场、无新人物、无字幕或可读文字。',
  ].join('\n')
}

async function sourceForRetry(previousPlanId, root) {
  const previous = await readA8B5Plan(previousPlanId, root)
  await readA8B5ProvisionalReview(previousPlanId, root)
  const { report: rejection, sha256: rejectionSha256 } = await readA8B5BRejection(previousPlanId, root)
  const dir = previousDirectory(root, previousPlanId)
  if (existsSync(path.join(dir, 'phase-B-acceptance.json'))
    || existsSync(path.join(dir, 'composite-receipt.json')))
    INVALID('previous B already accepted or composed')
  if (rejection.nextPaidPhaseBlocked !== true
    || rejection.videoSha256 !== '11dec8fb80b62d4d70eec2bfdcb9e03a370990a365259ddccd809d15d7a35eba'
    || !rejection.frames?.some(frame => frame.index === 36)
    || !rejection.frames?.some(frame => frame.index === 120))
    INVALID('previous rejected B source does not bind the observed timing failure')
  const [manifestBytes, provisionalBytes, intentBytes, taskBytes, mediaBytes, first] = await Promise.all([
    readFile(path.join(dir, 'manifest.json')),
    readFile(path.join(dir, 'provisional-A-review.json')),
    readFile(path.join(dir, 'phase-B-submit-intent.json')),
    readFile(path.join(dir, 'phase-B-task.json')),
    readFile(path.join(dir, 'phase-B-media.json')),
    exactAsset(root, previous.sourceAFrame.url, previous.sourceAFrame.sha256),
  ])
  for (const asset of previous.identityTransport)
    await exactAsset(root, asset.url, asset.sha256)
  await exactAsset(root, previous.endGuide.url, previous.endGuide.sha256)
  const intent = JSON.parse(intentBytes.toString('utf8'))
  if (intent.version !== 'staged-a8b5-B-submit-intent-v1'
    || intent.planId !== previousPlanId || intent.phase !== 'B'
    || intent.requestSha256 !== previous.phaseBPreview.requestSha256
    || intent.modelId !== previous.providerLock.modelId
    || intent.endpointSha256 !== previous.providerLock.endpointSha256)
    INVALID('previous paid B write-once intent changed')
  return { previous, rejection, first, source: {
    ...previous.source,
    previousPlanId, previousManifestSha256: sha256(manifestBytes),
    previousProvisionalAReviewSha256: sha256(provisionalBytes),
    previousBSubmitIntentSha256: sha256(intentBytes),
    previousBTaskSha256: sha256(taskBytes), previousBMediaSha256: sha256(mediaBytes),
    previousBRejectionSha256: rejectionSha256,
    previousBTaskId: rejection.taskId,
    previousBRequestSha256: previous.phaseBPreview.requestSha256,
    previousBVideoSha256: rejection.videoSha256,
    previousBNativeFrameDigestSha256: rejection.nativeFrameDigestSha256,
    recordId: previous.source.recordId, resultMd5: previous.source.resultMd5,
    approvedShotSha256: previous.source.approvedShotSha256,
    approvalSha256: previous.source.approvalSha256,
    sourceAOriginalPlanId: previous.source.planId,
    sourceAOriginalRejectionSha256: previous.source.rejectionSha256,
    sourceAOriginalVideoSha256: previous.source.videoSha256,
  } }
}

async function buildRetryRequest(source, root) {
  const { previous, first } = source
  const prepared = await prepareKlingImageInputs({
    referenceImage: `data:image/jpeg;base64,${first.toString('base64')}`,
    referenceImages: previous.identityTransport.map(asset => asset.url),
    duration: 6, mode: 'std', model_name: 'kling-v3-omni', sound: 'off',
    pacingVersion: 'independent-narration-v1', audioType: '环境声', audioText: '',
  }, path.join(root, 'public/generated'))
  const request = buildKlingVideoRequest({ settings: { model: 'kling-v3-omni' } },
    a8b5RetryBPrompt(), prepared)
  const imageTypes = request.image_list?.map(item => item.type ?? 'reference')
  if (canonical(imageTypes) !== canonical(['reference', 'reference', 'first_frame'])
    || request.duration !== '6' || request.model_name !== 'kling-v3-omni'
    || request.sound !== 'off' || Array.from(request.prompt).length > 2500
    || sha256(Buffer.from(request.image_list[2].image_url, 'base64')) !== previous.sourceAFrame.sha256
    || sha256(Buffer.from(request.image_list[0].image_url, 'base64')) !== previous.identityTransport[0].sha256
    || sha256(Buffer.from(request.image_list[1].image_url, 'base64')) !== previous.identityTransport[1].sha256
    || request.image_list.some(item => item.type === 'end_frame')
    || request.end_image || request.endImage)
    INVALID('retry B paid request lost real A f192 or added end-frame anchoring')
  return { request, preview: { phase: 'B', providerDuration: 6, acceptedDuration: 5,
    globalStart: 8, requestSha256: sha256(canonical(request)),
    requestByteLength: Buffer.byteLength(JSON.stringify(request)),
    promptSha256: sha256(request.prompt), promptCharacters: Array.from(request.prompt).length,
    imageTypes, firstFrameSha256: previous.sourceAFrame.sha256,
    identitySha256s: previous.identityTransport.map(asset => asset.sha256),
    endFrameSent: false, providerCalls: 0 } }
}

/** Rebuild from signed rejected source; no filesystem or provider writes. */
export async function planA8B5Retry(previousPlanId, root = process.cwd()) {
  const source = await sourceForRetry(previousPlanId, root)
  const { preview } = await buildRetryRequest(source, root)
  if (source.previous.phaseBPreview.requestSha256 === preview.requestSha256)
    INVALID('retry request is identical to rejected paid B request')
  const body = { version: 'staged-scene-cut-a8b5-retry-b-v1', source: source.source,
    sourceAFrame: source.previous.sourceAFrame,
    identityTransport: source.previous.identityTransport,
    endGuide: { ...source.previous.endGuide,
      role: 'signed-source-only; omitted-from-paid-request' },
    narrationTracks: source.previous.narrationTracks,
    providerLock: source.previous.providerLock,
    timeline: source.previous.timeline,
    retryStrategy: { variant: 'positive-action-beats-no-end-frame-v1',
      previousBStatus: 'signed-rejected', firstFrameRule: 'native-A-f192-exact',
      previousEndGuideRule: 'source-bound-read-only; omitted-from-paid-request',
      noAutomaticRepeatPost: true,
      deliveredFrameRule: 'A0-192+B1-120=313@24fps; no retime',
      originalNarrationRule: 'preserve-signed-three-track-TTS-and-full-source-mute',
      finalAcceptance: 'pending native B and two-shot review' },
    phaseBPreview: preview,
    acceptanceState: 'none; retry preview only; no provider task' }
  return { ...body, planId: sha256(canonical(body)) }
}

export async function saveA8B5RetryPlan(plan, root = process.cwd()) {
  const rebuilt = await planA8B5Retry(plan?.source?.previousPlanId, root)
  if (plan?.planId !== rebuilt.planId) INVALID('reviewed retry plan changed')
  const signed = { ...rebuilt, signature: '' }
  signed.signature = signature(signed, await signingKey(root))
  const filename = path.join(runtimeDirectory(root, rebuilt.planId), 'manifest.json')
  await writeOnce(filename, JSON.stringify(signed, null, 2) + '\n')
  return { planId: rebuilt.planId, manifestPath: filename,
    phaseBPreview: rebuilt.phaseBPreview }
}

export async function readA8B5RetryPlan(planId, root = process.cwd()) {
  const filename = path.join(runtimeDirectory(root, planId), 'manifest.json')
  const manifest = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(manifest, await signingKey(root))
  const { signature: _signature, planId: _planId, ...body } = manifest
  void _signature; void _planId
  if (manifest.version !== 'staged-scene-cut-a8b5-retry-b-v1'
    || manifest.planId !== planId || sha256(canonical(body)) !== planId)
    INVALID('retry manifest identity invalid')
  const rebuilt = await planA8B5Retry(manifest.source?.previousPlanId, root)
  if (canonical(manifest) !== canonical({ ...rebuilt, signature: manifest.signature }))
    INVALID('retry manifest differs from signed rejection and exact provider request')
  return manifest
}

export async function previewA8B5RetryRequest(planId, root = process.cwd(), includeRequest = false) {
  const manifest = await readA8B5RetryPlan(planId, root)
  return previewA8B5RetryRequestFromSignedManifest(manifest, root, includeRequest)
}

/** The caller may pass a manifest, but its signature and identity are checked
 * again before rebuilding the exact request from the rejected native source. */
export async function previewA8B5RetryRequestFromSignedManifest(manifest,
  root = process.cwd(), includeRequest = false) {
  verifySignature(manifest, await signingKey(root))
  const { signature: _signature, planId: _planId, ...body } = manifest
  void _signature; void _planId
  if (manifest.version !== 'staged-scene-cut-a8b5-retry-b-v1'
    || !SHA.test(manifest.planId ?? '')
    || sha256(canonical(body)) !== manifest.planId)
    INVALID('retry request manifest identity invalid')
  const source = await sourceForRetry(manifest.source.previousPlanId, root)
  if (canonical(manifest.source) !== canonical(source.source)
    || canonical(manifest.sourceAFrame) !== canonical(source.previous.sourceAFrame)
    || canonical(manifest.identityTransport) !== canonical(source.previous.identityTransport)
    || canonical(manifest.narrationTracks) !== canonical(source.previous.narrationTracks)
    || canonical(manifest.providerLock) !== canonical(source.previous.providerLock)
    || canonical(manifest.timeline) !== canonical(source.previous.timeline)
    || canonical(manifest.endGuide) !== canonical({ ...source.previous.endGuide,
      role: 'signed-source-only; omitted-from-paid-request' }))
    INVALID('retry provider request source changed')
  const { request, preview } = await buildRetryRequest(source, root)
  if (canonical(preview) !== canonical(manifest.phaseBPreview))
    INVALID('retry provider request differs from signed manifest')
  return includeRequest ? { ...preview, request } : preview
}
