/** Read-only Phase A v3 proposal. No signed plan, provider POST, DB write, or
 * media acceptance is created here. A future runner must bind this exact
 * request SHA to a new signed plan and review native f132–f180 before B. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildKlingVideoRequest, prepareKlingImageInputs } from './model-adapters.ts'
import { inspectStagedNativeVideo, readStagedSceneCutManifest, readStageMediaReceipt,
  readStageRejection, readStageTaskReceipt, stagePrompt,
  validateStagedShot1Timeline } from './staged-scene-cut.mjs'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const invalid = message => { throw Error(`STAGED_SCENE_CUT_V3_INVALID: ${message}`) }
const generatedFile = (root, url, ext) => {
  if (typeof url !== 'string' || !new RegExp(`^/generated/[\\w.-]+\\.${ext}$`, 'i').test(url)
    || url.includes('..')) invalid('generated asset URL invalid')
  return path.join(root, 'public', url.slice(1))
}
async function fileSha256(filename) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filename)) hash.update(bytes)
  return hash.digest('hex')
}
async function nativeJpeg(filename, frameIndex) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${frameIndex})`, '-vsync', 'vfr', '-frames:v', '1',
    '-q:v', '2', '-f', 'image2', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 20 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 1000 || stdout[0] !== 0xff || stdout[1] !== 0xd8)
    invalid(`reference native f${frameIndex} did not decode`)
  return stdout
}

export const V3_SOURCE_V2_PLAN_ID = '4943c717afbca42420da54ad14290f7b8bd0d181d79de048a27f4d30c2501c64'
export const V3_SOURCE_V2_REJECTION_SHA256 = '973d671bd04e899812f4fec81e4b7f9dd4025f17677c050040939522b64bfc50'
export const V3_GUIDE_FRAME = 219
export const V3_GUIDE_NATIVE_MD5 = '87a632a740d6c1fd9729ae9df381bde4'
export const V3_GUIDE_JPEG_SHA256 = '815d4bd5497e46a14827deb4fdd3a366033d37ea5e10ec8ff4ac00de31f795af'
export const V3_SOURCE_VIDEO_SHA256 = 'a7e6eaa136e69d30a3fa4f8e633016790451651ea358fb3b260d6fd50e093867'
export const V3_APPROVED_FIRST_SHA256 = '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
export const V3_REVIEW_FRAMES = Object.freeze([0, 48, 60, 96, 108, 120, 132, 144,
  156, 168, 174, 180, 186, 192])

export function phaseAV3Prompt() {
  return stagePrompt('A', 'early-binding-v3')
}

export function validateV3Binding(binding) {
  if (binding?.version !== 'staged-scene-cut-shot1-phase-a-v3-preview-v1'
    || binding.source?.recordId !== 'record-4x5m31-original-repair-tail-guide-v2'
    || binding.source?.resultMd5 !== '34abee4a7c010616b837dbc175b69c56'
    || binding.source?.approvedShotSha256 !== 'cd192f86b554192ef9be23a3f34cb8e643fd6e1aa11144a7e5aa675c832947d7'
    || binding.source?.approvalSha256 !== 'a15360db90b3d45077c95166ec296ee2c168323a75821ef596788e4c9afc4819'
    || binding.source?.firstSha256 !== V3_APPROVED_FIRST_SHA256
    || binding.source?.rejectedVideoSha256 !== V3_SOURCE_VIDEO_SHA256
    || binding.oldPaidAttempt?.planId !== V3_SOURCE_V2_PLAN_ID
    || binding.oldPaidAttempt?.rejectionSha256 !== V3_SOURCE_V2_REJECTION_SHA256
    || binding.endGuide?.sourceFrameIndex !== V3_GUIDE_FRAME
    || binding.endGuide?.sourceFrameMd5 !== V3_GUIDE_NATIVE_MD5
    || binding.endGuide?.jpegSha256 !== V3_GUIDE_JPEG_SHA256
    || binding.endGuide?.role !== 'reference-only; not an accepted A outcome'
    || binding.timeline?.providerSeconds !== 8 || binding.timeline?.acceptedSeconds !== 7.5
    || binding.timeline?.acceptedLastFrame !== 180 || binding.timeline?.fps !== 24
    || binding.timeline?.handsOffByFrame !== 132 || binding.timeline?.stationaryThroughFrame !== 180
    || binding.review?.status !== 'not-generated; native-and-human-review-required'
    || binding.source?.identitySha256s?.length !== 2
    || binding.source?.narrationTrackSha256s?.length !== 3)
    invalid('v3 source, guide, timeline, or review boundary changed')
  return true
}

/** Uses signed v2 receipts only to identify failures and preserve their record.
 * Rejected source video f219 is the earliest hands-off, Zhang-planted reference. */
export async function planPhaseAV3(root = process.cwd()) {
  validateStagedShot1Timeline()
  const parentPlanId = V3_SOURCE_V2_PLAN_ID
  const [manifest, task, media, rejection] = await Promise.all([
    readStagedSceneCutManifest(parentPlanId, root), readStageTaskReceipt(parentPlanId, 'A', root),
    readStageMediaReceipt(parentPlanId, 'A', root), readStageRejection(parentPlanId, 'A', root),
  ])
  const parentDirectory = path.join(root, '.runtime/staged-scene-cut', parentPlanId)
  const rejectionSha256 = await fileSha256(path.join(parentDirectory, 'phase-A-rejection.json'))
  if (manifest.version !== 'staged-scene-cut-shot1-v2' || manifest.promptVersion !== 'early-binding-v2'
    || manifest.rejectedVideo.sha256 !== V3_SOURCE_VIDEO_SHA256
    || manifest.first.sha256 !== V3_APPROVED_FIRST_SHA256
    || media.taskId !== task.taskId || rejection.taskId !== task.taskId
    || media.videoSha256 !== '84e9ecfccacef6b2fb98b616fe2f8f2ad5da28b221c79ff9f983200f0019f96e'
    || rejectionSha256 !== V3_SOURCE_V2_REJECTION_SHA256 || rejection.verdict !== 'reject'
    || rejection.nextPaidPhaseBlocked !== true)
    invalid('old rejected paid attempt is not the locked v2 source')
  const sourceFile = generatedFile(root, manifest.rejectedVideo.url, 'mp4')
  const native = await inspectStagedNativeVideo(sourceFile, 313, 13)
  if (native.frameDigestSha256 !== manifest.rejectedVideoNativeFrames.frameDigestSha256
    || native.hashes[V3_GUIDE_FRAME] !== V3_GUIDE_NATIVE_MD5)
    invalid('source native frame sequence or selected guide changed')
  const endGuideJpeg = await nativeJpeg(sourceFile, V3_GUIDE_FRAME)
  if (sha256(endGuideJpeg) !== V3_GUIDE_JPEG_SHA256) invalid('f219 native JPEG changed')
  const firstFile = generatedFile(root, manifest.first.url, 'png')
  if (await fileSha256(firstFile) !== V3_APPROVED_FIRST_SHA256)
    invalid('approved first frame bytes changed')
  const binding = {
    version: 'staged-scene-cut-shot1-phase-a-v3-preview-v1',
    source: { recordId: manifest.sourceRecordId, resultMd5: manifest.sourceResultMd5,
      approvedShotSha256: manifest.approvedShotSha256, approvalSha256: manifest.approvalSha256,
      firstUrl: manifest.first.url, firstSha256: manifest.first.sha256,
      identitySha256s: manifest.identities.map(item => item.sha256),
      rejectedVideoSha256: manifest.rejectedVideo.sha256,
      rejectedVideoNativeFrameDigestSha256: native.frameDigestSha256,
      narrationTrackSha256s: manifest.narrationTracks.map(item => item.sha256) },
    oldPaidAttempt: { planId: parentPlanId, taskId: task.taskId,
      videoSha256: media.videoSha256, rejectionSha256,
      status: 'rejected; immutable; no acceptance inherited' },
    endGuide: { sourceVideoSha256: manifest.rejectedVideo.sha256,
      sourceFrameIndex: V3_GUIDE_FRAME, sourceFrameMd5: native.hashes[V3_GUIDE_FRAME],
      jpegSha256: V3_GUIDE_JPEG_SHA256,
      role: 'reference-only; not an accepted A outcome',
      visualObservation: 'native f219 shows wrist rope and guard hands away; Zhang visibly planted at left; same reference as failed v2' },
    timeline: { providerSeconds: 8, acceptedSeconds: 7.5,
      acceptedLastFrame: 180, fps: 24, handsOffByFrame: 132, stationaryThroughFrame: 180 },
    review: { status: 'not-generated; native-and-human-review-required',
      nativeFrameIndices: [...V3_REVIEW_FRAMES],
      hardChecks: ['first-frame-and-identity-continuity', 'rope-on-front-wrists-by-f132',
        'four-guard-hands-off-by-f132', 'stable-no-touch-through-f180',
        'Zhang-stationary-through-f180', 'action-continuity-no-cut',
        'native-seam-before-phase-B', '13-second-whole-shot-audio-and-visual-review'] },
  }
  validateV3Binding(binding)
  return { ...binding, planId: sha256(canonical(binding)), endGuideJpeg,
    identityUrls: manifest.identities.map(item => item.url) }
}

export async function previewPhaseAV3(root = process.cwd(), includeRequest = false) {
  const plan = await planPhaseAV3(root)
  const prepared = await prepareKlingImageInputs({ referenceImage: plan.source.firstUrl,
    referenceImages: plan.identityUrls,
    endImage: `data:image/jpeg;base64,${plan.endGuideJpeg.toString('base64')}`,
    duration: 8, mode: 'std', model_name: 'kling-v3-omni', sound: 'off',
    pacingVersion: 'independent-narration-v1', audioType: '环境声', audioText: '',
  }, path.join(root, 'public/generated'))
  const request = buildKlingVideoRequest({ settings: { model: 'kling-v3-omni' } },
    phaseAV3Prompt(), prepared)
  const imageTypes = request.image_list?.map(item => item.type ?? 'reference')
  if (canonical(imageTypes) !== canonical(['reference', 'reference', 'first_frame', 'end_frame'])
    || request.model_name !== 'kling-v3-omni' || request.duration !== '8'
    || request.sound !== 'off' || Array.from(request.prompt).length > 2500)
    invalid('A v3 provider request changed')
  const { endGuideJpeg: _guide, identityUrls: _identities, ...publicPlan } = plan
  void _guide; void _identities
  return { plan: publicPlan, phaseA: { requestSha256: sha256(canonical(request)),
    prompt: request.prompt, imageTypes, providerDuration: 8, acceptedDuration: 7.5,
    firstFrameSha256: plan.source.firstSha256, endGuideSha256: V3_GUIDE_JPEG_SHA256,
    identitySha256s: plan.source.identitySha256s,
    providerCalls: 0, databaseReads: 0, databaseWrites: 0,
    ...(includeRequest ? { request } : {}) } }
}
