/** Read-only candidate for continuing the rejected, paid v2 A take at native f180.
 * It never promotes the rejected A phase to acceptance or submits a provider task.
 * A future paid B runner needs a separate signed plan and independent review gates. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildKlingVideoRequest, prepareKlingImageInputs } from './model-adapters.ts'
import { inspectStagedNativeVideo, readStagedSceneCutManifest, readStageMediaReceipt,
  readStageRejection, readStageTaskReceipt, validateStagedShot1Timeline } from './staged-scene-cut.mjs'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const SHA = /^[a-f0-9]{64}$/
const invalid = message => { throw Error(`STAGED_A180_CONTINUATION_INVALID: ${message}`) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const fileSha256 = async filename => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filename)) hash.update(bytes)
  return hash.digest('hex')
}
const generatedPath = (root, url, ext) => {
  if (typeof url !== 'string' || !new RegExp(`^/generated/[\\w.-]+\\.${ext}$`, 'i').test(url)
    || url.includes('..')) invalid('generated asset URL invalid')
  return path.join(root, 'public', url.slice(1))
}
async function nativeJpeg(filename, frameIndex) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${frameIndex})`, '-vsync', 'vfr', '-frames:v', '1',
    '-q:v', '2', '-f', 'image2', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 20 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 1000 || stdout[0] !== 0xff || stdout[1] !== 0xd8)
    invalid(`native f${frameIndex} JPEG extraction failed`)
  return stdout
}

export const PARENT_V2_PLAN_ID = '4943c717afbca42420da54ad14290f7b8bd0d181d79de048a27f4d30c2501c64'
export const PARENT_V2_TASK_ID = '933780648094494775'
export const PARENT_V2_MEDIA_SHA256 = '84e9ecfccacef6b2fb98b616fe2f8f2ad5da28b221c79ff9f983200f0019f96e'
export const PARENT_V2_REJECTION_SHA256 = '973d671bd04e899812f4fec81e4b7f9dd4025f17677c050040939522b64bfc50'
export const APPROVED_FIRST_SHA256 = '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'

export const A180_CONTINUATION_REVIEW_FRAMES = Object.freeze({
  parentA: Object.freeze([0, 60, 120, 156, 180]),
  proposedB: Object.freeze([0, 1, 6, 12, 18, 24, 36, 48, 60, 84, 108, 132, 144]),
})

/** The first half-second in B visibly finishes the binding; B f0 is unfinished. */
export function a180ContinuationPrompt() {
  return [
    '16:9真人实景，单一连续机位，接续所附实际已付费A段第180帧：江州战后街口、同四人同衣甲、相同空间方位；6秒画面，画内无对白、口型或字幕。',
    'B段0–0.5秒（全镜7.5–8.0秒）：严颜双腕已有可见绳圈，两军士正触及腕部，必须沿原有动作松开，四只手全部清楚离开双腕和绳索；不可重新开始绑缚、改变绳结位置或跳切。',
    'B段0.5–0.75秒（全镜8.0–8.25秒）：严颜独立保持身前缚腕，绳圈清晰，两军士手继续撤到身体两侧，不再接触；张飞仍站在画面左侧原位。',
    '只在双军士完全松手且稳定之后，张飞才从左侧走近严颜；B段第2秒（全镜9.5秒）前在严颜身前完全停稳，不遮挡缚腕。',
    'B段2–6秒张飞持续站定，严颜双腕绳圈可见，两军士各守一侧，仅有自然微动。不得新增人物、换景、反打、对白或重复缚腕。交付只取B段前5.5秒。',
  ].join('\n')
}

export function validateA180ContinuationBinding(binding) {
  if (binding?.version !== 'staged-scene-cut-a180-continuation-v1'
    || binding.parent?.planId !== PARENT_V2_PLAN_ID
    || binding.parent?.taskId !== PARENT_V2_TASK_ID
    || binding.parent?.videoSha256 !== PARENT_V2_MEDIA_SHA256
    || binding.parent?.rejectionSha256 !== PARENT_V2_REJECTION_SHA256
    || binding.source?.recordId !== 'record-4x5m31-original-repair-tail-guide-v2'
    || binding.source?.resultMd5 !== '34abee4a7c010616b837dbc175b69c56'
    || binding.source?.firstSha256 !== APPROVED_FIRST_SHA256
    || binding.source?.approvedShotSha256 !== 'cd192f86b554192ef9be23a3f34cb8e643fd6e1aa11144a7e5aa675c832947d7'
    || binding.source?.approvalSha256 !== 'a15360db90b3d45077c95166ec296ee2c168323a75821ef596788e4c9afc4819'
    || binding.timeline?.aLastFrame !== 180 || binding.timeline?.bFirstFrame !== 0
    || binding.timeline?.bStitchedFirstFrame !== 1 || binding.timeline?.bLastDeliveredFrame !== 132
    || binding.timeline?.deliveredFrames !== 313 || binding.timeline?.fps !== 24
    || binding.timeline?.narration2End !== 7.1 || binding.timeline?.narration3Start !== 9.5
    || binding.timeline?.handsOffByBFrame !== 12 || binding.timeline?.stableReleaseByBFrame !== 18
    || binding.timeline?.zhangStoppedByBFrame !== 48
    || binding.review?.parentAStatus !== 'rejected-in-original-plan; partial-prefix-only'
    || binding.review?.wholeShotStatus !== 'pending-independent-native-and-audio-review'
    || binding.review?.originalShotApprovalStatus !== 'invalid-for-shifted-schedule; revised-shot-and-fresh-approval-required'
    || !SHA.test(binding.parent?.nativeFrameDigestSha256 ?? '')
    || !SHA.test(binding.parent?.frame180JpegSha256 ?? '')
    || !SHA.test(binding.source?.endGuideSha256 ?? '')
    || binding.source?.identitySha256s?.length !== 2
    || binding.source.identitySha256s.some(value => !SHA.test(value))
    || binding.source.narrationTrackSha256s?.length !== 3
    || binding.source.narrationTrackSha256s.some(value => !SHA.test(value)))
    invalid('source, paid parent, timeline, or pending-review boundary changed')
  return true
}

/** Verifies signed old receipts, actual bytes, and native f180; no DB or writes. */
export async function planA180Continuation(root = process.cwd()) {
  validateStagedShot1Timeline()
  const planId = PARENT_V2_PLAN_ID
  const [manifest, task, media, rejection] = await Promise.all([
    readStagedSceneCutManifest(planId, root), readStageTaskReceipt(planId, 'A', root),
    readStageMediaReceipt(planId, 'A', root), readStageRejection(planId, 'A', root),
  ])
  const directory = path.join(root, '.runtime/staged-scene-cut', planId)
  const rejectionSha256 = await fileSha256(path.join(directory, 'phase-A-rejection.json'))
  const first = manifest.first
  if (manifest.version !== 'staged-scene-cut-shot1-v2' || manifest.promptVersion !== 'early-binding-v2'
    || manifest.sourceRecordId !== 'record-4x5m31-original-repair-tail-guide-v2'
    || manifest.sourceResultMd5 !== '34abee4a7c010616b837dbc175b69c56'
    || first.sha256 !== APPROVED_FIRST_SHA256
    || task.taskId !== PARENT_V2_TASK_ID || media.videoSha256 !== PARENT_V2_MEDIA_SHA256
    || rejectionSha256 !== PARENT_V2_REJECTION_SHA256
    || rejection.verdict !== 'reject' || !rejection.nextPaidPhaseBlocked)
    invalid('immutable rejected v2 parent is not the expected paid A source')
  const videoFile = generatedPath(root, media.videoUrl, 'mp4')
  const native = await inspectStagedNativeVideo(videoFile, 193, 8)
  if (native.frameDigestSha256 !== media.nativeFrameDigestSha256) invalid('paid A native frames changed')
  const frame180 = await nativeJpeg(videoFile, 180)
  const frame180Sha256 = sha256(frame180)
  if (!rejection.frames?.some(item => item.frameIndex === 180 && item.sha256 === frame180Sha256))
    invalid('rejected f180 observation is not bound to the current native frame')
  const endGuide = manifest.guides?.['312']
  if (!endGuide || endGuide.sourceVideoSha256 !== manifest.rejectedVideo.sha256
    || await fileSha256(generatedPath(root, endGuide.url, 'jpg')) !== endGuide.jpegSha256)
    invalid('source-bound B end guide changed')
  const binding = {
    version: 'staged-scene-cut-a180-continuation-v1',
    parent: { planId, manifestSha256: await fileSha256(path.join(directory, 'manifest.json')),
      taskReceiptSha256: await fileSha256(path.join(directory, 'phase-A-task.json')),
      mediaReceiptSha256: await fileSha256(path.join(directory, 'phase-A-media.json')),
      rejectionSha256, taskId: task.taskId, videoUrl: media.videoUrl,
      videoSha256: media.videoSha256, nativeFrameDigestSha256: native.frameDigestSha256,
      frame180NativeMd5: native.hashes[180], frame180JpegSha256 },
    source: { recordId: manifest.sourceRecordId, resultMd5: manifest.sourceResultMd5,
      approvedShotSha256: manifest.approvedShotSha256, approvalSha256: manifest.approvalSha256,
      firstSha256: first.sha256, identitySha256s: manifest.identities.map(item => item.sha256),
      endGuideUrl: endGuide.url, endGuideSha256: endGuide.jpegSha256,
      narrationTrackSha256s: manifest.narrationTracks.map(item => item.sha256) },
    timeline: { aLastFrame: 180, bFirstFrame: 0, bStitchedFirstFrame: 1,
      bLastDeliveredFrame: 132, deliveredFrames: 313, fps: 24,
      narration2End: 7.1, narration3Start: 9.5,
      handsOffByBFrame: 12, stableReleaseByBFrame: 18, zhangStoppedByBFrame: 48 },
    review: { parentAStatus: 'rejected-in-original-plan; partial-prefix-only',
      wholeShotStatus: 'pending-independent-native-and-audio-review',
      originalShotApprovalStatus: 'invalid-for-shifted-schedule; revised-shot-and-fresh-approval-required',
      requiredBFrames: [...A180_CONTINUATION_REVIEW_FRAMES.proposedB],
      hardChecks: ['A180-to-B0-and-B1-continuity', 'visible-four-hand-release-by-global-8.0',
        'independent-bound-hold-by-global-8.25', 'Zhang-moves-only-after-release',
        'Zhang-stopped-by-global-9.5', 'hold-and-visible-wrist-rope-through-global-13',
        'original-TTS-three-track-timing-and-full-source-mute',
        'whole-shot-native-watch-listen-and-second-shot-boundary'] },
  }
  validateA180ContinuationBinding(binding)
  return { ...binding, planId: sha256(canonical(binding)), frame180Jpeg: frame180,
    endGuideUrl: endGuide.url, identityUrls: manifest.identities.map(item => item.url) }
}

/** Deterministic request preview only. The caller must never POST this preview. */
export async function previewA180ContinuationB(root = process.cwd(), includeRequest = false) {
  const plan = await planA180Continuation(root)
  const prepared = await prepareKlingImageInputs({
    referenceImage: `data:image/jpeg;base64,${plan.frame180Jpeg.toString('base64')}`,
    referenceImages: plan.identityUrls, endImage: plan.endGuideUrl,
    duration: 6, mode: 'std', model_name: 'kling-v3-omni', sound: 'off',
    pacingVersion: 'independent-narration-v1', audioType: '环境声', audioText: '',
  }, path.join(root, 'public/generated'))
  const request = buildKlingVideoRequest({ settings: { model: 'kling-v3-omni' } },
    a180ContinuationPrompt(), prepared)
  const imageTypes = request.image_list?.map(item => item.type ?? 'reference')
  if (canonical(imageTypes) !== canonical(['reference', 'reference', 'first_frame', 'end_frame'])
    || request.model_name !== 'kling-v3-omni' || request.duration !== '6'
    || request.sound !== 'off' || Array.from(request.prompt).length > 2500)
    invalid('preview B provider request changed')
  const { frame180Jpeg: _frame, identityUrls: _identities, endGuideUrl: _guide, ...publicPlan } = plan
  void _frame; void _identities; void _guide
  return { plan: publicPlan, phaseB: { providerDuration: 6, deliveredDuration: 5.5,
    requestSha256: sha256(canonical(request)), prompt: request.prompt,
    promptCharacters: Array.from(request.prompt).length, imageTypes,
    firstFrameSha256: plan.parent.frame180JpegSha256,
    endFrameSha256: plan.source.endGuideSha256,
    identitySha256s: plan.source.identitySha256s,
    providerCalls: 0, databaseReads: 0, databaseWrites: 0,
    ...(includeRequest ? { request } : {}) } }
}
