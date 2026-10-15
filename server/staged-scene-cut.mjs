/** A local, source-bound staging ledger for a single approved scene-cut shot.
 * This module prepares provider requests; it never sends or pays for one.
 * A later stage cannot be prepared until its predecessor has a signed task
 * receipt and a native-frame, independently reviewed acceptance receipt. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createReadStream, readFileSync, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from './scene-cut-frame-approval.ts'
import { buildKlingVideoRequest, prepareKlingImageInputs } from './model-adapters.ts'
import { deriveCompactInputs, saveCompactInputs, verifyCompactInputs } from './staged-scene-cut-compact-inputs.mjs'
import { composeNarration } from './independent-narration.ts'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const SHA = /^[a-f0-9]{64}$/
const ID = /^record-[\w-]+$/
const generatedImage = /^\/generated\/[\w.-]+\.(?:jpg|jpeg|png)$/i
const generatedVideo = /^\/generated\/[\w.-]+\.mp4$/i
const COMPACT_PROVIDER_LOCK = Object.freeze({ modelId: 'keling3',
  endpointSha256: '27d9f6b9e9ea4f2072ec278cc03f344eb2b14a0f9a21d265a56c5cf43c60f73c' })
const INVALID = message => { throw Error(`STAGED_SCENE_CUT_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

export const STAGED_SHOT1_PHASES = Object.freeze([
  Object.freeze({ id: 'A', providerSeconds: 8, acceptedSeconds: 7.5, globalStart: 0,
    seamFrame: 180, guideFrame: 215, required: ['front-wrist-binding-by-7.5', 'zhang-remains-at-origin'] }),
  Object.freeze({ id: 'B', providerSeconds: 6, acceptedSeconds: 5.5, globalStart: 7.5,
    seamFrame: 132, guideFrame: 312, required: ['approach-after-binding', 'zhang-stopped-by-9.5', 'stable-through-13'] }),
])
export const STAGED_SHOT1_FRAME_RATE = 24
export const STAGED_SHOT1_DELIVERED_FRAMES = 313 // 181 + (133 - duplicate seam)

export function stagedShot1FrameMapping(outputFrameIndex) {
  if (!Number.isInteger(outputFrameIndex) || outputFrameIndex < 0 || outputFrameIndex >= 313)
    INVALID('stitched output frame index invalid')
  return outputFrameIndex <= 180
    ? { phase: 'A', sourceFrameIndex: outputFrameIndex, outputFrameIndex }
    : { phase: 'B', sourceFrameIndex: outputFrameIndex - 180, outputFrameIndex }
}

export function validateStagedShot1Timeline(phases = STAGED_SHOT1_PHASES) {
  if (phases.length !== 2 || phases[0].id !== 'A' || phases[1].id !== 'B'
    || phases[0].providerSeconds !== 8 || phases[1].providerSeconds !== 6
    || phases[0].acceptedSeconds !== 7.5 || phases[1].acceptedSeconds !== 5.5
    || phases[0].seamFrame !== 180 || phases[1].seamFrame !== 132
    || phases[0].globalStart !== 0 || phases[1].globalStart !== 7.5
    || phases[0].acceptedSeconds + phases[1].acceptedSeconds !== 13
    || phases[0].seamFrame + phases[1].seamFrame + 1 !== STAGED_SHOT1_DELIVERED_FRAMES)
    INVALID('8+6 provider / 7.5+5.5 accepted timeline was changed')
  return true
}

export function stagePrompt(phaseId, promptVersion = 'v1') {
  if (phaseId === 'B' && promptVersion === 'salvage-a-frame-drop-v1') return [
    '16:9真人实景，紧接上一段实际逐帧重定时画面的第180帧；它与原已付费原生第192帧像素一致。同一江州街口、人物、服装、机位和运动方向，6秒画面；画内无人发声或做语言口型。',
    '首帧严颜双腕已在身前清楚绑好，两军士的手刚离开绳索，继续自然撤到两侧；张飞必须在军士松手后才从左侧原位迈步，来到严颜面前，最晚本段1.5秒完全停稳，不挡住绳结。',
    '第1.5–6秒张飞持续停在严颜面前，严颜双腕绳结始终可见；仅允许呼吸、目光与衣物自然微动。最后0.5秒供核验，交付只取前5.5秒。',
    '不要重新绑缚、问责对白、镜头切换、字幕、重复人物或新场景。',
  ].join('\n')
  if (phaseId === 'A' && ['early-binding-v3', 'early-binding-v3-retry1', 'early-binding-v3-compact1'].includes(promptVersion)) return [
    '16:9真人实景，江州战后街口，同一机位连续8秒；四人衣甲与提供的首帧一致。画内无人说话、做语言口型或出现字幕。',
    '0–2.5秒：张飞保持画面左侧原位，短促抬手示意；左右两军士封住严颜身前缺口，严颜站稳。',
    '2.5–4.8秒：两军士只做一次清楚的身前缚腕动作：并住严颜双腕，绕绳，收紧，结绳。绳只在双腕，不缠腰；不要反复缠绕或拖延。',
    '4.8–5.5秒：结绳结束，两军士各自双手全部松开严颜手腕和绳索，双手放低、身体退到两侧。严颜双腕独立保持身前束缚，明显绳圈始终可见。',
    '5.5–8秒：持续展示已完成的束缚状态，军士双手与严颜双腕保持清楚空隙，绝不再触碰、重绑或挡住绳圈；张飞双脚始终留在左侧原位，不走近。仅允许呼吸和衣物微动。',
    '全程不跳切、不换景、不新增人物；动作完成须在第132帧(5.5秒)已可见，并保持到第180帧(7.5秒)和第192帧(8秒)。',
  ].join('\n')
  if (phaseId === 'A' && promptVersion === 'early-binding-v2') return [
    '16:9真人实景，同一江州战后街口、单一连续机位，8秒画面，画内无人发声或做语言口型。',
    '0–2.5秒：张飞始终在左侧原位，抬手示意两军士向严颜身前合拢并封住缺口。',
    '2.5–5.8秒：两军士在严颜身前并拢双腕，清楚连续展示绕绳、拉紧、结绳。到5.8秒绳结固定，严颜双腕并拢且已牢固缚住，工作绳不缠腰。',
    '5.8–6.3秒：两名军士各自双手共四只手全部离开严颜手腕与绳索，严颜仍保持独立的身前缚腕状态。',
    '6.3–8秒：已缚双腕和绳结连续清晰可见，军士退至两侧且绝不再碰、重缠手腕；张飞双脚始终站在左侧原位、绝不迈步。此终态在第180帧前至少已保持1.2秒。不得跳切、后补绳圈、字幕或额外动作。',
  ].join('\n')
  if (phaseId === 'A') return [
    '16:9真人实景，同一江州战后街口、单一连续机位，8秒画面，画内无人发声或做语言口型。',
    '0–2.5秒：张飞始终在左侧原位，抬手示意两军士向严颜身前合拢并封住缺口。',
    '2.5–7.5秒：两军士在严颜身前并拢双腕，连续展示绕绳、拉紧、结绳、松手。7.5秒前双腕已明确缚住，工作绳不缠腰；张飞此时仍未迈步。',
    '7.5–8秒仅保持完成后的自然微动，严颜站立，两腕及绳结清楚可见。不得跳切、提前走近、换人、字幕或增添动作。',
  ].join('\n')
  if (phaseId === 'B' && ['early-binding-v2', 'early-binding-v3', 'early-binding-v3-retry1', 'early-binding-v3-compact1'].includes(promptVersion)) return [
    '16:9真人实景，紧接上一段实际原生第180帧，同一江州街口、人物、服装、机位和运动方向，6秒画面；画内无人发声或做语言口型。',
    '首帧严颜双腕已在身前绑好，军士已明确松手并退至两侧。张飞只能在此后迈步，从左侧原位走到严颜面前，不挡住绳结；本段1.3–1.5秒前完全停稳。',
    '第1.5–6秒张飞持续停在严颜面前，严颜双腕绳结始终可见；仅允许呼吸、目光与衣物自然微动。最后0.5秒是供核验的余量，交付只取前5.5秒。',
    '不要重新绑缚、问责对白、镜头切换、字幕、重复人物或新场景。',
  ].join('\n')
  if (phaseId === 'B') return [
    '16:9真人实景，紧接上一段实际原生第180帧，同一江州街口、人物、服装、机位和运动方向，6秒画面；画内无人发声或做语言口型。',
    '首帧严颜双腕已在身前绑好，军士已完成缚腕。张飞只在此后迈步，从左侧原位走到严颜面前，不能挡住绳结；本段第2秒前完全停稳。',
    '第2–6秒张飞持续停在严颜面前，严颜双腕绳结始终可见；仅允许呼吸、目光与衣物自然微动。最后0.5秒是供核验的余量，交付只取前5.5秒。',
    '不要重新绑缚、问责对白、镜头切换、字幕、重复人物或新场景。',
  ].join('\n')
  return INVALID(`unknown phase ${phaseId}`)
}

function localFile(root, url, expression) {
  if (typeof url !== 'string' || !expression.test(url) || url.includes('..')) INVALID('asset must be a generated local file')
  return path.join(root, 'public', url.slice(1))
}

async function fileSha256(filename) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(filename)) digest.update(bytes)
  return digest.digest('hex')
}
function fileSha256Sync(filename) {
  return sha256(readFileSync(filename))
}

export async function inspectStagedNativeVideo(filename, expectedCount, expectedLastPts) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-map', '0:v:0', '-an', '-f', 'framemd5', '-'],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  const lines = stdout.split(/\r?\n/)
  const frameLines = lines.filter(line => /^0,/.test(line))
  const frames = frameLines.map(line => {
    const fields = line.split(',').map(field => field.trim())
    return { index: Number(fields[2]), digest: fields[5] }
  })
  if (!lines.some(line => line.trim() === '#tb 0: 1/24')
    || !lines.some(line => line.trim() === '#dimensions 0: 1280x720')
    || frames.length !== expectedCount || frames.some((frame, index) => frame.index !== index || !/^[a-f0-9]{32}$/.test(frame.digest))
    || (expectedCount - 1) / 24 !== expectedLastPts)
    INVALID(`video is not ${expectedCount} native 1280x720 frames at 24fps, PTS 0–${expectedLastPts}`)
  return { count: frames.length, firstPts: 0, lastPts: expectedLastPts,
    frameDigestSha256: sha256(frameLines.join('\n')), hashes: frames.map(frame => frame.digest) }
}

async function nativeJpeg(filename, frameIndex) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${frameIndex})`, '-vsync', 'vfr', '-frames:v', '1',
    '-q:v', '2', '-f', 'image2', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 20 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 1000 || stdout[0] !== 0xff || stdout[1] !== 0xd8)
    INVALID(`native frame ${frameIndex} was not decoded as JPEG`)
  return stdout
}

async function verifiedAsset(root, url, expectedSha256, expression) {
  if (!SHA.test(String(expectedSha256))) INVALID('asset SHA-256 is missing')
  const actual = await fileSha256(localFile(root, url, expression))
  if (actual !== expectedSha256) INVALID(`asset bytes changed: ${url}`)
  return { url, sha256: actual }
}

/** Read-only preflight. The rejected video is reference-only and never accepted. */
export async function planStagedShot1(input, root = process.cwd()) {
  validateStagedShot1Timeline()
  const { recordId, resultMd5, shot, certificate, videoParams, rejectedVideoUrl,
    rejectedVideoSha256, narrationTracks } = input
  const promptVersion = input.promptVersion ?? 'v1'
  if (!['v1', 'early-binding-v2', 'early-binding-v3', 'early-binding-v3-retry1', 'early-binding-v3-compact1'].includes(promptVersion)) INVALID('staged prompt version invalid')
  const phaseAGuideFrame = promptVersion === 'v1' ? 215 : 219
  const phases = promptVersion !== 'v1'
    ? STAGED_SHOT1_PHASES.map(phase => phase.id === 'A' ? { ...phase, guideFrame: 219 } : phase)
    : STAGED_SHOT1_PHASES
  validateStagedShot1Timeline(phases)
  if (!ID.test(recordId) || !/^[a-f0-9]{32}$/.test(resultMd5)
    || shot?.id !== 'scene-01' || shot.duration !== 13
    || shot.visualTreatment !== 'live_action' || shot.continuity?.mode !== 'scene_cut'
    || shot.pacing?.version !== 'duration-v2'
    || !Array.isArray(narrationTracks) || narrationTracks.length !== 3)
    INVALID('record, approved shot, or original narration is incomplete')
  verifySceneCutFrameApproval(certificate, root)
  if (certificate.passed !== true || certificate.shotSha256 !== sceneCutShotSha256(shot)
    || videoParams?.referenceImage !== certificate.frame?.sourceUrl
    || canonical(videoParams.sceneCutFrameGate) !== canonical(certificate)
    || canonical(videoParams.sceneCutShot) !== canonical(shot)
    || canonical(videoParams.referenceImages) !== canonical(certificate.assets?.map(asset => asset.sourceUrl)))
    INVALID('current video inputs are not the signed approved shot, first frame, and identity sources')
  const first = await verifiedAsset(root, certificate.frame.sourceUrl, certificate.sourceSha256s?.[0], generatedImage)
  const identities = await Promise.all(certificate.assets.map((asset, index) => verifiedAsset(
    root, asset.sourceUrl, certificate.sourceSha256s?.[index + 1], generatedImage)))
  const rejectedVideo = await verifiedAsset(root, rejectedVideoUrl, rejectedVideoSha256, generatedVideo)
  const frames = await inspectStagedNativeVideo(localFile(root, rejectedVideo.url, generatedVideo), 313, 13)
  const guideBytes = await Promise.all([phaseAGuideFrame, 312].map(index => nativeJpeg(
    localFile(root, rejectedVideo.url, generatedVideo), index)))
  const guides = Object.fromEntries([phaseAGuideFrame, 312].map((index, offset) => {
    const digest = sha256(guideBytes[offset])
    return [String(index), { sourceFrameIndex: index, sourceFrameMd5: frames.hashes[index],
      sourceVideoSha256: rejectedVideo.sha256, jpegSha256: digest,
      url: `/generated/staged-guide-${rejectedVideo.sha256.slice(0, 16)}-f${index}-${digest.slice(0, 16)}.jpg` }]
  }))
  const tracks = await Promise.all(narrationTracks.map(async (track, index) => {
    const verified = await verifiedAsset(root, track.url, track.sha256, /^\/generated\/[\w.-]+\.wav$/i)
    if (track.beatId !== `b01-narration-${index + 1}`
      || Math.abs(track.start - [0, 2.5, 9.5][index]) > .001
      || track.end > [2.5, 7.5, 11.75][index] + .001) INVALID('original TTS timing changed')
    if (!Number.isFinite(track.duration) || track.duration <= 0
      || !Number.isFinite(track.tempo) || track.tempo <= 0
      || track.start + track.duration > [2.5, 7.5, 11.75][index] + .001
      || typeof track.text !== 'string')
      INVALID('original TTS recipe is incomplete')
    return { ...track, ...verified }
  }))
  let previousRejectedAttempt
  if (['early-binding-v3', 'early-binding-v3-retry1', 'early-binding-v3-compact1'].includes(promptVersion)) {
    const priorPlanId = '4943c717afbca42420da54ad14290f7b8bd0d181d79de048a27f4d30c2501c64'
    const prior = await readStageRejection(priorPlanId, 'A', root)
    const rejectionSha256 = await fileSha256(path.join(root, '.runtime/staged-scene-cut', priorPlanId,
      'phase-A-rejection.json'))
    if (prior.taskId !== '933780648094494775'
      || prior.videoSha256 !== '84e9ecfccacef6b2fb98b616fe2f8f2ad5da28b221c79ff9f983200f0019f96e'
      || rejectionSha256 !== '973d671bd04e899812f4fec81e4b7f9dd4025f17677c050040939522b64bfc50')
      INVALID('v3 prior paid A rejection is not the locked v2 receipt')
    previousRejectedAttempt = { planId: priorPlanId, phase: 'A', taskId: prior.taskId,
      videoSha256: prior.videoSha256, rejectionSha256,
      status: 'rejected; no acceptance inherited' }
  }
  let retryOf
  if (promptVersion === 'early-binding-v3-retry1') {
    const { readFailedV3TaskReceipt } = await import('./staged-scene-cut-failed-task.mjs')
    const failure = await readFailedV3TaskReceipt(root)
    retryOf = { planId: failure.receipt.planId,
      taskId: failure.receipt.taskId,
      failedRequestSha256: failure.receipt.requestSha256,
      failureReceiptSha256: failure.sha256,
      attempt: 1, maximum: 1, reason: failure.receipt.retryAllowance.reason,
      status: 'terminal-failed-zero-deduction; no media inherited' }
  }
  let compactTransport, transportImageBytes, transportAfterFailures
  if (promptVersion === 'early-binding-v3-compact1') {
    const { readFailedV3TaskReceipt, readFailedV3Retry1TaskReceipt } =
      await import('./staged-scene-cut-failed-task.mjs')
    const firstFailure = await readFailedV3TaskReceipt(root)
    const secondFailure = await readFailedV3Retry1TaskReceipt(root)
    const derived = await deriveCompactInputs([{ role: 'first_frame', ...first },
      { role: 'identity_1', ...identities[0] }, { role: 'identity_2', ...identities[1] }], root)
    compactTransport = { version: derived.version, encoder: derived.encoder,
      entries: derived.entries, totalBytes: derived.totalBytes,
      unchangedEndGuideSha256: guides[String(phaseAGuideFrame)].jpegSha256 }
    transportImageBytes = derived.buffers
    transportAfterFailures = { v3: { planId: firstFailure.receipt.planId,
      taskId: firstFailure.receipt.taskId, failureReceiptSha256: firstFailure.sha256 },
    retry1: { planId: secondFailure.receipt.planId,
      taskId: secondFailure.receipt.taskId, failureReceiptSha256: secondFailure.sha256 },
    variant: 'one source-bound bounded-jpeg transport; no identical request retry' }
  }
  const binding = { version: promptVersion === 'v1'
    ? 'staged-scene-cut-shot1-v1' : promptVersion === 'early-binding-v2'
      ? 'staged-scene-cut-shot1-v2' : promptVersion === 'early-binding-v3'
        ? 'staged-scene-cut-shot1-v3' : promptVersion === 'early-binding-v3-retry1'
          ? 'staged-scene-cut-shot1-v3-retry1' : 'staged-scene-cut-shot1-v3-compact1',
    ...(promptVersion === 'v1' ? {} : { promptVersion }), sourceRecordId: recordId,
    sourceResultMd5: resultMd5, approvedShotSha256: certificate.shotSha256,
    approvalSha256: sha256(canonical(certificate)), first, identities,
    rejectedVideo, rejectedVideoNativeFrames: { count: frames.count,
      firstPts: frames.firstPts, lastPts: frames.lastPts, frameDigestSha256: frames.frameDigestSha256 },
    guides, narrationTracks: tracks, phases,
    ...(previousRejectedAttempt ? { previousRejectedAttempt } : {}),
    ...(retryOf ? { retryOf } : {}),
    ...(compactTransport ? { compactTransport, transportAfterFailures,
      providerLock: COMPACT_PROVIDER_LOCK } : {}),
    deliveredFrames: STAGED_SHOT1_DELIVERED_FRAMES, fps: STAGED_SHOT1_FRAME_RATE,
    boundary: 'reference-only-failed-video; no provider calls; no workflow mutation' }
  const planId = sha256(canonical(binding))
  return { ...binding, planId, stagedGuideBytes: guideBytes,
    ...(transportImageBytes ? { transportImageBytes } : {}) }
}

export async function previewStageARequest(plan, root = process.cwd(), includeRequest = false) {
  if (plan?.version === 'staged-scene-cut-salvage-v1')
    INVALID('salvage A is a signed local derivative; no provider A request is permitted')
  const { planId: _id, stagedGuideBytes: _bytes, transportImageBytes: _transportBytes, ...body } = plan ?? {}
  void _id; void _bytes; void _transportBytes
  if (!SHA.test(plan?.planId) || plan.planId !== sha256(canonical(body)))
    INVALID('plan body changed after preflight')
  const first = await verifiedAsset(root, plan.first.url, plan.first.sha256, generatedImage)
  const identities = await Promise.all(plan.identities.map(asset => verifiedAsset(root, asset.url, asset.sha256, generatedImage)))
  const guideFrame = plan.phases[0].guideFrame
  const end = plan.guides[String(guideFrame)]
  if (sha256(plan.stagedGuideBytes?.[0] ?? Buffer.alloc(0)) !== end.jpegSha256)
    INVALID('phase A end guide bytes changed')
  const compact = plan.promptVersion === 'early-binding-v3-compact1'
  const transport = plan.compactTransport
  let imageInputs = [first.url, ...identities.map(asset => asset.url)]
  if (compact) {
    if (transport?.entries?.length !== 3
      || transport.entries[0].source.sha256 !== first.sha256
      || transport.entries[1].source.sha256 !== identities[0].sha256
      || transport.entries[2].source.sha256 !== identities[1].sha256)
      INVALID('compact transport lost approved first/identity source bindings')
    const bytes = plan.transportImageBytes ?? await Promise.all(transport.entries.map(entry =>
      readFile(localFile(root, entry.transport.url, generatedImage))))
    if (bytes.length !== 3 || bytes.some((value, index) => !Buffer.isBuffer(value)
      || value.length !== transport.entries[index].transport.byteLength
      || sha256(value) !== transport.entries[index].transport.sha256))
      INVALID('compact transport JPEG bytes changed')
    imageInputs = bytes.map(value => `data:image/jpeg;base64,${value.toString('base64')}`)
  }
  const prepared = await prepareKlingImageInputs({ referenceImage: imageInputs[0],
    referenceImages: imageInputs.slice(1),
    endImage: `data:image/jpeg;base64,${plan.stagedGuideBytes[0].toString('base64')}`,
    duration: 8, mode: 'std', model_name: 'kling-v3-omni', sound: 'off',
    pacingVersion: 'independent-narration-v1', audioType: '环境声', audioText: '' },
  path.join(root, 'public/generated'))
  const request = buildKlingVideoRequest({ settings: { model: 'kling-v3-omni' } },
    stagePrompt('A', plan.promptVersion ?? 'v1'), prepared)
  const imageTypes = request.image_list?.map(item => item.type ?? 'reference')
  if (canonical(imageTypes) !== canonical(['reference', 'reference', 'first_frame', 'end_frame'])
    || request.duration !== '8' || request.sound !== 'off'
    || Array.from(request.prompt).length > 2500) INVALID('phase A provider request contract changed')
  const requestByteLength = Buffer.byteLength(JSON.stringify(request))
  if (compact && (requestByteLength > 2_000_000
    || sha256(Buffer.from(request.image_list[2].image_url, 'base64')) !== transport.entries[0].transport.sha256
    || sha256(Buffer.from(request.image_list[0].image_url, 'base64')) !== transport.entries[1].transport.sha256
    || sha256(Buffer.from(request.image_list[1].image_url, 'base64')) !== transport.entries[2].transport.sha256
    || sha256(Buffer.from(request.image_list[3].image_url, 'base64')) !== end.jpegSha256))
    INVALID('compact paid request lost bounded source-bound image bytes')
  return { phase: 'A', providerDuration: 8, acceptedDuration: 7.5,
    requestSha256: sha256(canonical(request)), promptCharacters: Array.from(request.prompt).length,
    requestByteLength,
    imageTypes, firstFrameSha256: compact ? transport.entries[0].transport.sha256 : first.sha256,
    endFrameSha256: end.jpegSha256,
    identitySha256s: compact ? transport.entries.slice(1).map(item => item.transport.sha256)
      : identities.map(item => item.sha256),
    ...(compact ? { approvedFirstFrameSha256: first.sha256,
      approvedIdentitySha256s: identities.map(item => item.sha256),
      compactTransportBytes: transport.totalBytes } : {}), providerCalls: 0,
    ...(includeRequest ? { request } : {}) }
}

function signedObject(value, key) {
  const { signature: _signature, ...content } = value
  void _signature
  return createHmac('sha256', key).update(canonical(content)).digest('hex')
}
function verifySignature(value, key) {
  const expected = signedObject(value, key), actual = String(value?.signature ?? '')
  if (!SHA.test(actual) || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')))
    INVALID('local staging signature mismatch')
  return true
}
async function readSigningKey(root) {
  const filename = path.join(root, '.runtime/staged-scene-cut.key')
  let key
  try { key = await readFile(filename) }
  catch (error) { if (error.code === 'ENOENT') INVALID('staging key missing'); throw error }
  if (key.length !== 32) INVALID('staging key length invalid')
  return key
}
function readSigningKeySync(root) {
  const filename = path.join(root, '.runtime/staged-scene-cut.key')
  if (!existsSync(filename)) INVALID('staging key missing')
  const key = readFileSync(filename)
  if (key.length !== 32) INVALID('staging key length invalid')
  return key
}
async function ensureSigningKey(root) {
  const filename = path.join(root, '.runtime/staged-scene-cut.key')
  try { return await readSigningKey(root) }
  catch (error) { if (!String(error.message).includes('staging key missing')) throw error }
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return readSigningKey(root)
}
async function writeOnce(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !Buffer.from(await readFile(filename)).equals(Buffer.from(bytes)))
      INVALID(`existing staged artifact differs: ${filename}`)
  }
}

/** Materialize guides and a signed immutable manifest. No paid call occurs. */
export async function saveStagedPlan(plan, root = process.cwd()) {
  const preview = await previewStageARequest(plan, root)
  const key = await ensureSigningKey(root)
  const { stagedGuideBytes, transportImageBytes, ...content } = plan
  const directory = path.join(root, '.runtime/staged-scene-cut', plan.planId)
  const indices = [plan.phases[0].guideFrame, 312]
  for (const [offset, index] of indices.entries()) {
    const guide = plan.guides[String(index)]
    const target = localFile(root, guide.url, generatedImage)
    await writeOnce(target, stagedGuideBytes[offset])
  }
  if (plan.compactTransport) await saveCompactInputs(plan.compactTransport, transportImageBytes, root)
  const manifest = { ...content, phaseAPreview: preview, signature: '' }
  manifest.signature = signedObject(manifest, key)
  await writeOnce(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { planId: plan.planId, manifestPath: path.join(directory, 'manifest.json'),
    guideUrls: indices.map(index => plan.guides[String(index)].url), phaseAPreview: preview }
}

export async function readStagedSceneCutManifest(planId, root = process.cwd()) {
  if (!SHA.test(planId)) INVALID('plan id invalid')
  const filename = path.join(root, '.runtime/staged-scene-cut', planId, 'manifest.json')
  const manifest = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(manifest, await readSigningKey(root))
  const { planId: _id, phaseAPreview: _preview, signature: _sig, ...binding } = manifest
  void _id; void _preview; void _sig
  if (manifest.planId !== planId || sha256(canonical(binding)) !== planId) INVALID('manifest identity invalid')
  if (['staged-scene-cut-shot1-v3', 'staged-scene-cut-shot1-v3-retry1',
    'staged-scene-cut-shot1-v3-compact1'].includes(manifest.version)) {
    const prior = manifest.previousRejectedAttempt
    const expectedPromptVersion = manifest.version === 'staged-scene-cut-shot1-v3'
      ? 'early-binding-v3' : manifest.version === 'staged-scene-cut-shot1-v3-retry1'
        ? 'early-binding-v3-retry1' : 'early-binding-v3-compact1'
    if (manifest.promptVersion !== expectedPromptVersion
      || manifest.sourceRecordId !== 'record-4x5m31-original-repair-tail-guide-v2'
      || manifest.sourceResultMd5 !== '34abee4a7c010616b837dbc175b69c56'
      || manifest.approvedShotSha256 !== 'cd192f86b554192ef9be23a3f34cb8e643fd6e1aa11144a7e5aa675c832947d7'
      || manifest.first?.sha256 !== '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
      || manifest.phases?.[0]?.guideFrame !== 219
      || manifest.guides?.['219']?.jpegSha256 !== '815d4bd5497e46a14827deb4fdd3a366033d37ea5e10ec8ff4ac00de31f795af'
      || prior?.planId !== '4943c717afbca42420da54ad14290f7b8bd0d181d79de048a27f4d30c2501c64'
      || prior?.taskId !== '933780648094494775'
      || prior?.videoSha256 !== '84e9ecfccacef6b2fb98b616fe2f8f2ad5da28b221c79ff9f983200f0019f96e'
      || prior?.rejectionSha256 !== '973d671bd04e899812f4fec81e4b7f9dd4025f17677c050040939522b64bfc50'
      || prior?.status !== 'rejected; no acceptance inherited'
      || await fileSha256(path.join(root, '.runtime/staged-scene-cut', prior.planId,
        'phase-A-rejection.json')) !== prior.rejectionSha256)
      INVALID('v3 signed plan lost prior rejected paid attempt')
    await readStageRejection(prior.planId, 'A', root)
    if (manifest.version === 'staged-scene-cut-shot1-v3-retry1') {
      const { readFailedV3TaskReceipt } = await import('./staged-scene-cut-failed-task.mjs')
      const failure = await readFailedV3TaskReceipt(root)
      const retry = manifest.retryOf
      if (retry?.planId !== failure.receipt.planId
        || retry?.taskId !== failure.receipt.taskId
        || retry?.failedRequestSha256 !== failure.receipt.requestSha256
        || retry?.failureReceiptSha256 !== failure.sha256
        || retry?.attempt !== 1 || retry?.maximum !== 1
        || retry?.reason !== failure.receipt.retryAllowance.reason
        || retry?.status !== 'terminal-failed-zero-deduction; no media inherited'
        || manifest.phaseAPreview?.requestSha256 !== failure.receipt.requestSha256)
        INVALID('v3 retry1 is not the single identical-request zero-deduction fork')
    }
    if (manifest.version === 'staged-scene-cut-shot1-v3-compact1') {
      const { readFailedV3TaskReceipt, readFailedV3Retry1TaskReceipt } =
        await import('./staged-scene-cut-failed-task.mjs')
      const firstFailure = await readFailedV3TaskReceipt(root)
      const secondFailure = await readFailedV3Retry1TaskReceipt(root)
      const after = manifest.transportAfterFailures, compact = manifest.compactTransport
      if (after?.v3?.planId !== firstFailure.receipt.planId
        || after.v3.taskId !== firstFailure.receipt.taskId
        || after.v3.failureReceiptSha256 !== firstFailure.sha256
        || after?.retry1?.planId !== secondFailure.receipt.planId
        || after.retry1.taskId !== secondFailure.receipt.taskId
        || after.retry1.failureReceiptSha256 !== secondFailure.sha256
        || after.variant !== 'one source-bound bounded-jpeg transport; no identical request retry'
        || firstFailure.receipt.requestSha256 !== secondFailure.receipt.requestSha256
        || manifest.phaseAPreview?.requestSha256 === secondFailure.receipt.requestSha256
        || compact?.unchangedEndGuideSha256 !== manifest.guides['219'].jpegSha256
        || compact.entries?.length !== 3
        || compact.entries[0].source.sha256 !== manifest.first.sha256
        || compact.entries[1].source.sha256 !== manifest.identities[0].sha256
        || compact.entries[2].source.sha256 !== manifest.identities[1].sha256)
        INVALID('compact v3 plan lost two failed-task receipts or approved source binding')
      if (canonical(manifest.providerLock) !== canonical(COMPACT_PROVIDER_LOCK))
        INVALID('compact v3 paid model or endpoint plan lock changed')
      await verifyCompactInputs(compact, root)
      const stagedGuideBytes = [await readFile(localFile(root, manifest.guides['219'].url, generatedImage)),
        await readFile(localFile(root, manifest.guides['312'].url, generatedImage))]
      const preview = await previewStageARequest({ ...binding, planId, stagedGuideBytes }, root)
      if (canonical(preview) !== canonical(manifest.phaseAPreview))
        INVALID('compact v3 paid request differs from signed preview')
    }
  }
  await verifiedAsset(root, manifest.rejectedVideo.url, manifest.rejectedVideo.sha256, generatedVideo)
  await verifiedAsset(root, manifest.first.url, manifest.first.sha256, generatedImage)
  for (const asset of manifest.identities) await verifiedAsset(root, asset.url, asset.sha256, generatedImage)
  for (const guide of Object.values(manifest.guides)) await verifiedAsset(root, guide.url, guide.jpegSha256, generatedImage)
  for (const track of manifest.narrationTracks) await verifiedAsset(root, track.url, track.sha256, /^\/generated\/[\w.-]+\.wav$/i)
  return manifest
}

/** Persist a provider task only after the caller has submitted the exact
 * request that preflight hashed. An unreviewed task never enables phase B. */
export async function saveStageTaskReceipt(planId, receipt, root = process.cwd()) {
  const manifest = await readStagedSceneCutManifest(planId, root)
  const phase = receipt?.phase
  if (phase === 'A' && manifest.version === 'staged-scene-cut-salvage-v1')
    INVALID('salvage A has no new provider task')
  const preview = phase === 'A' ? manifest.phaseAPreview
    : phase === 'B' ? await previewStageBRequest(planId, root) : INVALID('provider phase invalid')
  if (!/^[\w-]{8,128}$/.test(String(receipt.taskId))
    || receipt.requestSha256 !== preview.requestSha256
    || phase === 'A' && manifest.providerLock
      && (receipt.providerModelId !== manifest.providerLock.modelId
        || receipt.endpointSha256 !== manifest.providerLock.endpointSha256)
    || (phase === 'B' || phase === 'A' && manifest.version === 'staged-scene-cut-shot1-v3-compact1')
      && (!/^[\w-]+$/.test(receipt.providerModelId ?? '')
      || !SHA.test(receipt.endpointSha256 ?? ''))
    || !Number.isFinite(Date.parse(receipt.submittedAt))) INVALID(`phase ${phase} provider task receipt invalid`)
  const value = { version: 'staged-provider-task-v1', planId, phase,
    taskId: String(receipt.taskId), requestSha256: receipt.requestSha256,
    submittedAt: receipt.submittedAt,
    ...(receipt.providerModelId ? { providerModelId: receipt.providerModelId } : {}),
    ...(receipt.endpointSha256 ? { endpointSha256: receipt.endpointSha256 } : {}),
    signature: '' }
  value.signature = signedObject(value, await readSigningKey(root))
  const filename = path.join(root, '.runtime/staged-scene-cut', planId, `phase-${phase}-task.json`)
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readStageTaskReceipt(planId, phase, root = process.cwd()) {
  if (!['A', 'B'].includes(phase)) INVALID('provider phase invalid')
  const manifest = await readStagedSceneCutManifest(planId, root)
  const filename = path.join(root, '.runtime/staged-scene-cut', planId, `phase-${phase}-task.json`)
  const task = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(task, await readSigningKey(root))
  const expected = phase === 'A' ? manifest.phaseAPreview : await previewStageBRequest(planId, root)
  if (task.version !== 'staged-provider-task-v1' || task.planId !== planId || task.phase !== phase
    || task.requestSha256 !== expected.requestSha256 || !/^[\w-]{8,128}$/.test(task.taskId)
    || phase === 'A' && manifest.providerLock
      && (task.providerModelId !== manifest.providerLock.modelId
        || task.endpointSha256 !== manifest.providerLock.endpointSha256)
    || (phase === 'B' || phase === 'A' && manifest.version === 'staged-scene-cut-shot1-v3-compact1')
      && (!/^[\w-]+$/.test(task.providerModelId ?? '')
      || !SHA.test(task.endpointSha256 ?? '')))
    INVALID(`phase ${phase} provider task identity invalid`)
  return task
}

/** Archive a completed paid result separately from its immutable task ID. */
export async function saveStageMediaReceipt(planId, phase, media, root = process.cwd()) {
  const task = await readStageTaskReceipt(planId, phase, root)
  if (media?.taskId !== task.taskId || !SHA.test(media?.videoSha256 ?? ''))
    INVALID(`phase ${phase} media does not belong to submitted task`)
  await verifiedAsset(root, media.videoUrl, media.videoSha256, generatedVideo)
  const native = await inspectStagedNativeVideo(localFile(root, media.videoUrl, generatedVideo),
    phase === 'A' ? 193 : 145, phase === 'A' ? 8 : 6)
  const value = { version: 'staged-provider-media-v1', planId, phase, taskId: task.taskId,
    videoUrl: media.videoUrl, videoSha256: media.videoSha256,
    nativeFrameDigestSha256: native.frameDigestSha256, frameCount: native.count,
    lastPts: native.lastPts, signature: '' }
  value.signature = signedObject(value, await readSigningKey(root))
  await writeOnce(path.join(stageDirectory(root, planId), `phase-${phase}-media.json`),
    JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readStageMediaReceipt(planId, phase, root = process.cwd()) {
  const task = await readStageTaskReceipt(planId, phase, root)
  const media = JSON.parse(await readFile(path.join(stageDirectory(root, planId), `phase-${phase}-media.json`), 'utf8'))
  verifySignature(media, await readSigningKey(root))
  if (media.version !== 'staged-provider-media-v1' || media.planId !== planId
    || media.phase !== phase || media.taskId !== task.taskId)
    INVALID(`phase ${phase} media/task binding invalid`)
  await verifiedAsset(root, media.videoUrl, media.videoSha256, generatedVideo)
  const native = await inspectStagedNativeVideo(localFile(root, media.videoUrl, generatedVideo),
    phase === 'A' ? 193 : 145, phase === 'A' ? 8 : 6)
  if (media.nativeFrameDigestSha256 !== native.frameDigestSha256
    || media.frameCount !== native.count || media.lastPts !== native.lastPts)
    INVALID(`phase ${phase} native media changed`)
  return media
}

const REVIEW_INDICES = Object.freeze({ A: [0, 48, 60, 96, 132, 156, 180],
  B: [0, 1, 36, 48, 84, 132] })
const REVIEW_INDICES_A_V2 = Object.freeze([0, 48, 60, 96, 120, 132, 138, 144,
  150, 156, 168, 180, 192])
const REVIEW_INDICES_A_V3 = Object.freeze([0, 48, 60, 96, 108, 120, 132, 144,
  156, 168, 174, 180, 186, 192])
const REVIEW_INDICES_B_V2 = Object.freeze([0, 1, 12, 24, 36, 48, 60, 84, 108, 132, 144])
function reviewIndices(phase, promptVersion) {
  if (['early-binding-v3', 'early-binding-v3-retry1', 'early-binding-v3-compact1'].includes(promptVersion))
    return phase === 'A' ? REVIEW_INDICES_A_V3 : REVIEW_INDICES_B_V2
  if (promptVersion === 'early-binding-v2' || promptVersion === 'salvage-a-frame-drop-v1')
    return phase === 'A' ? REVIEW_INDICES_A_V2 : REVIEW_INDICES_B_V2
  return REVIEW_INDICES[phase]
}

export async function saveStageReviewEvidence(planId, phase, root = process.cwd()) {
  if (!['A', 'B'].includes(phase)) INVALID('review phase invalid')
  const manifest = await readStagedSceneCutManifest(planId, root)
  const indices = reviewIndices(phase, manifest.promptVersion ?? 'v1')
  const media = await readStageMediaReceipt(planId, phase, root)
  const native = await inspectStagedNativeVideo(localFile(root, media.videoUrl, generatedVideo),
    phase === 'A' ? 193 : 145, phase === 'A' ? 8 : 6)
  const frames = []
  if (phase === 'B') {
    const A = await readStageAcceptance(planId, 'A', root)
    frames.push({ phase: 'A', frameIndex: 180, url: A.acceptedFrameUrl,
      sha256: A.acceptedFrameSha256, sourceVideoSha256: A.videoSha256 })
  }
  for (const index of indices) {
    const bytes = await nativeJpeg(localFile(root, media.videoUrl, generatedVideo), index)
    const digest = sha256(bytes)
    const url = `/generated/staged-review-${media.videoSha256.slice(0, 16)}-f${index}-${digest.slice(0, 16)}.jpg`
    await writeOnce(localFile(root, url, generatedImage), bytes)
    frames.push({ phase, frameIndex: index, url, sha256: digest,
      sourceVideoSha256: media.videoSha256, sourceFrameMd5: native.hashes[index] })
  }
  const value = { version: 'staged-native-review-evidence-v1', planId, phase,
    taskId: media.taskId, videoUrl: media.videoUrl, videoSha256: media.videoSha256,
    nativeFrameDigestSha256: native.frameDigestSha256, frames,
    reviewImages: frames.map(frame => frame.url), signature: '' }
  value.signature = signedObject(value, await readSigningKey(root))
  const filename = path.join(stageDirectory(root, planId), `phase-${phase}-review-evidence.json`)
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return { evidence: value, sha256: await fileSha256(filename) }
}

export async function readStageReviewEvidence(planId, phase, root = process.cwd()) {
  const filename = path.join(stageDirectory(root, planId), `phase-${phase}-review-evidence.json`)
  const bytes = await readFile(filename)
  const evidence = JSON.parse(bytes.toString('utf8'))
  verifySignature(evidence, await readSigningKey(root))
  const manifest = await readStagedSceneCutManifest(planId, root)
  const media = await readStageMediaReceipt(planId, phase, root)
  const indices = reviewIndices(phase, manifest.promptVersion ?? 'v1')
  const expected = phase === 'A' ? indices : [180, ...indices]
  if (evidence.version !== 'staged-native-review-evidence-v1' || evidence.planId !== planId
    || evidence.phase !== phase || evidence.taskId !== media.taskId
    || evidence.videoSha256 !== media.videoSha256 || evidence.videoUrl !== media.videoUrl
    || evidence.nativeFrameDigestSha256 !== media.nativeFrameDigestSha256
    || evidence.frames?.length !== expected.length
    || canonical(evidence.reviewImages) !== canonical(evidence.frames.map(frame => frame.url)))
    INVALID(`phase ${phase} review evidence identity invalid`)
  for (const [index, frame] of evidence.frames.entries()) {
    if (frame.frameIndex !== expected[index] || frame.phase !== (phase === 'B' && index === 0 ? 'A' : phase))
      INVALID(`phase ${phase} review sample order invalid`)
    await verifiedAsset(root, frame.url, frame.sha256, generatedImage)
    const source = phase === 'B' && index === 0
      ? await readStageAcceptance(planId, 'A', root) : media
    if (frame.sourceVideoSha256 !== source.videoSha256)
      INVALID(`phase ${phase} review sample source changed`)
    const native = await nativeJpeg(localFile(root, source.videoUrl, generatedVideo), frame.frameIndex)
    if (sha256(native) !== frame.sha256) INVALID(`phase ${phase} review image is not native frame`)
  }
  return { evidence, sha256: sha256(bytes) }
}

function requiredStageChecks(phase, promptVersion = 'v1') {
  if (phase === 'A') return ['early-binding-v3', 'early-binding-v3-retry1', 'early-binding-v3-compact1'].includes(promptVersion)
    ? ['frontWristBindingByFrame132', 'guardsReleasedByFrame132',
      'stableBoundHoldFromFrame132Through180', 'zhangStationaryThroughFrame180', 'noCoreContradiction']
    : promptVersion === 'early-binding-v2'
      ? ['frontWristBindingByFrame180', 'guardsReleasedByFrame156',
      'stableBoundHoldThroughFrame180', 'zhangStationaryThroughFrame180', 'noCoreContradiction']
    : ['frontWristBindingByFrame180', 'zhangStationaryThroughFrame180', 'noCoreContradiction']
  return ['early-binding-v2', 'early-binding-v3', 'early-binding-v3-retry1',
    'early-binding-v3-compact1', 'salvage-a-frame-drop-v1'].includes(promptVersion)
    ? ['bindingVisibleAtFrame0', 'guardsReleasedAtFrame0',
      'zhangStoppedByFrame36', 'zhangStoppedByFrame48',
      'zhangStableFromFrame36Through132', 'zhangStableThroughFrame132',
      'frontWristBindingVisibleThroughFrame132', 'noCoreContradiction']
    : ['bindingVisibleAtFrame0', 'zhangStoppedByFrame48', 'zhangStableThroughFrame132',
      'frontWristBindingVisibleThroughFrame132', 'noCoreContradiction']
}

export function stageReviewPrompt(phase, evidence, promptVersion = 'v1') {
  if (!['A', 'B'].includes(phase) || evidence?.phase !== phase)
    INVALID('review prompt phase/evidence mismatch')
  const rule = phase === 'A'
    ? ['early-binding-v3', 'early-binding-v3-retry1', 'early-binding-v3-compact1'].includes(promptVersion)
      ? 'A段：0–2.5秒张飞在左原位示意军士封缺口；2.5–4.8秒双腕绕绳、拉紧、结绳；4.8–5.5秒双军士四只手全部松开并退侧；第132帧(5.5秒)必须已独立缚腕，四只手均不碰双腕或绳索；第132–180帧持续保持明显绳圈及双手空隙，张飞仍未起步。第192帧仅核余量，不得代替第180帧完成态。'
      : promptVersion === 'early-binding-v2'
      ? 'A段：0–2.5秒张飞在左原位示意军士封缺口；2.5–5.8秒双腕绕绳、拉紧、结绳；5.8–6.3秒双军士完全松手；第156帧(6.5秒)必须已独立缚腕且军士已松手；第156–180帧持续保持明显绳圈，张飞仍未起步。'
      : 'A段：0–2.5秒张飞在左原位示意军士封缺口；2.5–7.5秒必须真实连续出现严颜身前并腕、绕绳、拉紧、结绳、松手；第180帧腕部已绑牢且张飞仍未起步。'
    : promptVersion === 'salvage-a-frame-drop-v1'
      ? 'B段：原生第0帧承接衍生A段第180帧，此帧与已付费原生A第192帧像素一致；交付去掉B第0帧，须检查A第180帧与B第1帧是否跳变。军士手已离开绳索并继续撤侧，张飞只能在松手后迈步；第36帧（全镜9秒）已在严颜面前完全停稳，第48帧（全镜9.5秒）仍稳；第36–132帧绳结清楚且张飞持续站定。'
      : ['early-binding-v2', 'early-binding-v3', 'early-binding-v3-retry1',
        'early-binding-v3-compact1'].includes(promptVersion)
      ? 'B段：原生第0帧承接A段实际第180帧，交付去掉B第0帧，须检查A第180帧与B第1帧是否跳变；A段军士已松手并退侧后张飞才迈步；第36帧（本段1.5秒）张飞已在严颜面前完全停稳，第48帧（全镜9.5秒）仍稳；第36–132帧绳结清楚且张飞持续站定。'
      : 'B段：原生第0帧承接A段实际第180帧，交付拼接时去掉B第0帧，必须直接检查A第180帧与B第1帧是否跳变；严颜已被绑腕；张飞随后才走近，第48帧（本段2秒、全镜9.5秒）前已在严颜面前完全停稳；第48–132帧绳结清楚且张飞保持站定。'
  const checkTemplate = Object.fromEntries(requiredStageChecks(phase, promptVersion).map(key => [key, true]))
  if (phase === 'B') checkTemplate.seamContinuity = true
  const evidenceRule = promptVersion === 'salvage-a-frame-drop-v1'
    ? '附件中的A第180帧是已付费原生A片逐帧抽取的衍生画面，像素对应原生A第192帧；B帧才是本段provider-native。不得把衍生帧称为provider-native。'
    : '附件均为实际原生视频帧。'
  return `你是独立逐帧视觉审核员，只能从所附真实画面判断，目标参考图不算完成证据。${evidenceRule}无法从静态帧判定动作连续性时必须给 uncertain。\n${rule}\n视频SHA256=${evidence.videoSha256}；阶段=${phase}。附件按顺序：${evidence.frames.map(frame => `${frame.phase}:${frame.frameIndex}:${frame.sha256}`).join('，')}。\n只返回JSON：{"version":"staged-phase-review-v1","phase":"${phase}","videoSha256":"${evidence.videoSha256}","decision":"accept|revise|uncertain","checks":${JSON.stringify(checkTemplate)},"frameObservations":[{"phase":"A|B","frameIndex":0,"description":"可见事实"}],"issues":[]}。必须逐项给证据，任何未完成、不清楚或跳切都不能 accept。`
}

export async function verifyStageModelReviewLedger(planId, phase, executionId, root = process.cwd(), query) {
  if (!/^model-run-[\w-]+$/.test(String(executionId))) INVALID('independent model execution ID invalid')
  const { evidence, sha256: nativeEvidenceSha256 } = await readStageReviewEvidence(planId, phase, root)
  const manifest = await readStagedSceneCutManifest(planId, root)
  const promptVersion = manifest.promptVersion ?? 'v1'
  const prompt = stageReviewPrompt(phase, evidence, promptVersion)
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
  const request = row?.request_data, images = request?.params?.reviewImages
  if (row?.channel !== 'workflow' || row?.workflow_id !== 'wf-sanguo-history-drama'
    || row?.node_id !== 'staged-scene-cut-phase-review'
    || row?.capability !== 'text' || row?.provider !== 'Codex' || row?.status !== 'succeeded'
    || row?.id !== executionId || !SHA.test(request?.fingerprint ?? '')
    || !String(request?.requestKey ?? '').startsWith(`staged-scene-cut:${planId}:${phase}:${evidence.videoSha256}:`)
    || request?.prompt !== prompt || request?.operation !== 'history.media-review'
    || canonical(images) !== canonical(evidence.reviewImages)
    || request?.reviewImageHashes?.length !== evidence.frames.length)
    INVALID(`phase ${phase} independent model ledger is missing or unbound`)
  for (const [index, frame] of evidence.frames.entries()) {
    if (request.reviewImageHashes[index]?.url !== frame.url
      || request.reviewImageHashes[index]?.sha256 !== frame.sha256)
      INVALID(`phase ${phase} independent model did not see native frame ${frame.frameIndex}`)
  }
  let report
  try { report = parseStructuredJson(extractTextResponse(row.response_data)) }
  catch { INVALID(`phase ${phase} independent model output cannot be parsed`) }
  const required = requiredStageChecks(phase, promptVersion)
  if (phase === 'B') required.push('seamContinuity')
  if (report?.version !== 'staged-phase-review-v1' || report?.phase !== phase
    || report?.videoSha256 !== evidence.videoSha256 || report?.decision !== 'accept'
    || required.some(name => report.checks?.[name] !== true)
    || !Array.isArray(report.issues) || report.issues.length
    || report.frameObservations?.length !== evidence.frames.length
    || report.frameObservations.some((observation, index) =>
      observation.phase !== evidence.frames[index].phase
      || observation.frameIndex !== evidence.frames[index].frameIndex
      || typeof observation.description !== 'string' || observation.description.length < 12))
    INVALID(`phase ${phase} independent model did not establish all native actions`)
  return { row, report, ledgerSha256: sha256(canonical(row)),
    nativeEvidenceSha256, requestKey: request.requestKey, promptSha256: sha256(prompt) }
}

/** Human/agent direct viewing remains a separate source-bound judgement. */
export async function saveStageManualReview(planId, phase, report, root = process.cwd()) {
  const { evidence, sha256: nativeEvidenceSha256 } = await readStageReviewEvidence(planId, phase, root)
  const manifest = await readStagedSceneCutManifest(planId, root)
  const required = requiredStageChecks(phase, manifest.promptVersion ?? 'v1')
  if (phase === 'B') required.push('seamContinuity')
  if (report?.version !== 'staged-direct-visual-review-v1' || report?.phase !== phase
    || report?.planId !== planId || report?.videoSha256 !== evidence.videoSha256
    || report?.nativeEvidenceSha256 !== nativeEvidenceSha256
    || report?.reviewMethod !== 'agent-direct-visual' || report?.reviewer !== 'Codex'
    || !Number.isFinite(Date.parse(report?.reviewedAt)) || report?.verdict !== 'accept'
    || required.some(name => report.checks?.[name] !== true)
    || report?.observations?.length !== evidence.frames.length
    || report.observations.some((observation, index) =>
      observation.phase !== evidence.frames[index].phase
      || observation.frameIndex !== evidence.frames[index].frameIndex
      || observation.sha256 !== evidence.frames[index].sha256
      || typeof observation.description !== 'string' || observation.description.length < 12)
    || !Array.isArray(report?.limitations)
    || phase === 'B' && report.seamVerdict !== 'accept')
    INVALID(`phase ${phase} direct visual report incomplete`)
  const value = { ...report, signature: '' }
  value.signature = signedObject(value, await readSigningKey(root))
  const filename = path.join(stageDirectory(root, planId), `phase-${phase}-manual-review.json`)
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return { review: value, sha256: await fileSha256(filename) }
}

export async function readStageManualReview(planId, phase, root = process.cwd()) {
  const filename = path.join(stageDirectory(root, planId), `phase-${phase}-manual-review.json`)
  const bytes = await readFile(filename)
  const report = JSON.parse(bytes.toString('utf8'))
  verifySignature(report, await readSigningKey(root))
  const { evidence, sha256: nativeEvidenceSha256 } = await readStageReviewEvidence(planId, phase, root)
  if (report.phase !== phase || report.planId !== planId || report.videoSha256 !== evidence.videoSha256
    || report.nativeEvidenceSha256 !== nativeEvidenceSha256 || report.verdict !== 'accept')
    INVALID(`phase ${phase} direct visual report changed`)
  return { report, sha256: sha256(bytes) }
}

/** A failed paid clip remains archived and permanently blocks the next phase
 * for this plan; a retry requires a newly signed plan and request fingerprint. */
export async function saveStageRejection(planId, phase, report, root = process.cwd()) {
  const media = await readStageMediaReceipt(planId, phase, root)
  const directory = stageDirectory(root, planId)
  if (existsSync(path.join(directory, `phase-${phase}-acceptance.json`)))
    INVALID('cannot reject a stage already accepted')
  if (report?.version !== 'staged-native-rejection-v1' || report?.planId !== planId
    || report?.phase !== phase || report?.videoSha256 !== media.videoSha256
    || report?.verdict !== 'reject' || report?.reviewMethod !== 'agent-direct-visual'
    || report?.reviewer !== 'Codex' || !Number.isFinite(Date.parse(report?.reviewedAt))
    || !Array.isArray(report?.frames) || report.frames.length < 2
    || typeof report.reason !== 'string' || report.reason.length < 30)
    INVALID('direct native-frame rejection incomplete')
  for (const frame of report.frames) {
    if (!Number.isInteger(frame.frameIndex) || frame.frameIndex < 0
      || frame.frameIndex > (phase === 'A' ? 192 : 144)
      || !SHA.test(frame.sha256 ?? '')
      || typeof frame.observation !== 'string' || frame.observation.length < 16
      || sha256(await nativeJpeg(localFile(root, media.videoUrl, generatedVideo), frame.frameIndex)) !== frame.sha256)
      INVALID('rejection frame is not the archived native source')
  }
  const value = { ...report, taskId: media.taskId, videoUrl: media.videoUrl,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    nextPaidPhaseBlocked: true, signature: '' }
  value.signature = signedObject(value, await readSigningKey(root))
  await writeOnce(path.join(directory, `phase-${phase}-rejection.json`), JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readStageRejection(planId, phase, root = process.cwd()) {
  const directory = stageDirectory(root, planId)
  const value = JSON.parse(await readFile(path.join(directory, `phase-${phase}-rejection.json`), 'utf8'))
  verifySignature(value, await readSigningKey(root))
  const media = await readStageMediaReceipt(planId, phase, root)
  if (value.planId !== planId || value.phase !== phase || value.videoSha256 !== media.videoSha256
    || value.videoUrl !== media.videoUrl || value.taskId !== media.taskId
    || value.nativeFrameDigestSha256 !== media.nativeFrameDigestSha256
    || value.verdict !== 'reject' || value.nextPaidPhaseBlocked !== true)
    INVALID('signed stage rejection changed')
  return value
}

/** The reviewed native frame is the only legal first frame for the next
 * phase. A target end guide is never promoted into an accepted actual frame. */
export async function saveStageAcceptance(planId, evidence, root = process.cwd()) {
  const phase = evidence?.phase
  if (!['A', 'B'].includes(phase)) INVALID('acceptance phase invalid')
  if (existsSync(path.join(stageDirectory(root, planId), `phase-${phase}-rejection.json`)))
    INVALID(`phase ${phase} was explicitly rejected; new signed plan required`)
  if (phase === 'A' && (await readStagedSceneCutManifest(planId, root)).version === 'staged-scene-cut-salvage-v1')
    INVALID('derived salvage A requires its separate source-bound acceptance gate')
  const task = await readStageTaskReceipt(planId, phase, root)
  const media = await readStageMediaReceipt(planId, phase, root)
  const manifest = await readStagedSceneCutManifest(planId, root)
  const index = phase === 'A' ? 180 : 132
  const nativeCount = phase === 'A' ? 193 : 145
  const nativeLastPts = phase === 'A' ? 8 : 6
  const checks = requiredStageChecks(phase, manifest.promptVersion ?? 'v1')
  if (evidence?.phase !== phase || evidence?.taskId !== task.taskId
    || evidence?.review?.verdict !== 'accept' || evidence?.review?.manualVerdict !== 'accept'
    || !/^model-run-[\w-]+$/.test(evidence.review?.executionId ?? '')
    || !SHA.test(evidence.review?.ledgerSha256 ?? '')
    || !SHA.test(evidence.nativeEvidenceSha256 ?? '')
    || checks.some(name => evidence?.checks?.[name] !== true)
    || evidence?.acceptedFrameIndex !== index || evidence?.videoSha256 !== media.videoSha256
    || evidence?.videoUrl !== media.videoUrl
    || !SHA.test(evidence?.acceptedFrameSha256 ?? ''))
    INVALID(`phase ${phase} independent/native acceptance incomplete`)
  const model = await verifyStageModelReviewLedger(planId, phase, evidence.review.executionId, root)
  const manual = await readStageManualReview(planId, phase, root)
  if (evidence.nativeEvidenceSha256 !== model.nativeEvidenceSha256
    || evidence.review.ledgerSha256 !== model.ledgerSha256
    || evidence.review.requestKey !== model.requestKey
    || evidence.review.promptSha256 !== model.promptSha256
    || evidence.review.manualReviewSha256 !== manual.sha256
    || checks.some(name => model.report.checks[name] !== true || manual.report.checks[name] !== true)
    || phase === 'B' && (model.report.checks.seamContinuity !== true
      || manual.report.checks.seamContinuity !== true))
    INVALID(`phase ${phase} signed acceptance is not backed by real independent and direct reviews`)
  await verifiedAsset(root, evidence.videoUrl, evidence.videoSha256, generatedVideo)
  const native = await inspectStagedNativeVideo(localFile(root, evidence.videoUrl, generatedVideo), nativeCount, nativeLastPts)
  const frameBytes = await nativeJpeg(localFile(root, evidence.videoUrl, generatedVideo), index)
  if (sha256(frameBytes) !== evidence.acceptedFrameSha256)
    INVALID(`phase ${phase} accepted frame is not its real native frame${index}`)
  const acceptedFrameUrl = `/generated/staged-seam-${evidence.videoSha256.slice(0, 16)}-f${index}-${evidence.acceptedFrameSha256.slice(0, 16)}.jpg`
  await writeOnce(localFile(root, acceptedFrameUrl, generatedImage), frameBytes)
  let seam
  if (phase === 'B') {
    const previous = await readStageAcceptance(planId, 'A', root)
    const firstBytes = await nativeJpeg(localFile(root, evidence.videoUrl, generatedVideo), 0)
    const firstSha256 = sha256(firstBytes)
    const stitchedFirstSha256 = sha256(await nativeJpeg(localFile(root, evidence.videoUrl, generatedVideo), 1))
    if (evidence.firstFrameSha256 !== firstSha256
      || evidence.stitchedFirstFrameSha256 !== stitchedFirstSha256
      || evidence.seamReview?.verdict !== 'accept'
      || evidence.seamReview?.manualVerdict !== 'accept'
      || evidence.seamReview?.ledgerSha256 !== model.ledgerSha256
      || evidence.seamReview?.manualReviewSha256 !== manual.sha256
      || evidence.seamReview?.phaseAFrameSha256 !== previous.acceptedFrameSha256
      || evidence.seamReview?.phaseBFrameSha256 !== firstSha256
      || evidence.seamReview?.phaseBStitchedFirstFrameSha256 !== stitchedFirstSha256)
      INVALID('phase A→B actual native-frame seam review missing or unbound')
    seam = { phaseAFrameIndex: 180, phaseAFrameSha256: previous.acceptedFrameSha256,
      phaseBFirstFrameIndex: 0, phaseBFirstFrameSha256: firstSha256,
      stitchedPhaseBStartFrameIndex: 1, phaseBStitchedFirstFrameSha256: stitchedFirstSha256,
      review: evidence.seamReview }
  }
  const value = { version: 'staged-native-acceptance-v1', planId, phase,
    taskId: task.taskId, videoUrl: evidence.videoUrl, videoSha256: evidence.videoSha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    acceptedFrameIndex: index, acceptedFrameSha256: evidence.acceptedFrameSha256,
    acceptedFrameUrl, nativeEvidenceSha256: evidence.nativeEvidenceSha256,
    ...(seam ? { seam } : {}), review: evidence.review, checks: evidence.checks, signature: '' }
  value.signature = signedObject(value, await readSigningKey(root))
  await writeOnce(path.join(root, '.runtime/staged-scene-cut', planId, `phase-${phase}-acceptance.json`),
    JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readStageAcceptance(planId, phase, root = process.cwd()) {
  if (!['A', 'B'].includes(phase)) INVALID('acceptance phase invalid')
  if (existsSync(path.join(stageDirectory(root, planId), `phase-${phase}-rejection.json`)))
    INVALID(`phase ${phase} was explicitly rejected; acceptance cannot be read`)
  if (phase === 'A') {
    const candidate = await readStagedSceneCutManifest(planId, root)
    if (candidate.version === 'staged-scene-cut-salvage-v1') {
      const { readSalvageAAcceptance } = await import('./staged-scene-cut-salvage.mjs')
      return readSalvageAAcceptance(planId, root)
    }
  }
  const task = await readStageTaskReceipt(planId, phase, root)
  const media = await readStageMediaReceipt(planId, phase, root)
  const manifest = await readStagedSceneCutManifest(planId, root)
  const filename = path.join(root, '.runtime/staged-scene-cut', planId, `phase-${phase}-acceptance.json`)
  const acceptance = JSON.parse(await readFile(filename, 'utf8'))
  verifySignature(acceptance, await readSigningKey(root))
  const index = phase === 'A' ? 180 : 132
  const count = phase === 'A' ? 193 : 145
  const lastPts = phase === 'A' ? 8 : 6
  const checks = requiredStageChecks(phase, manifest.promptVersion ?? 'v1')
  if (acceptance.version !== 'staged-native-acceptance-v1' || acceptance.planId !== planId
    || acceptance.phase !== phase || acceptance.taskId !== task.taskId
    || acceptance.videoSha256 !== media.videoSha256 || acceptance.videoUrl !== media.videoUrl
    || acceptance.acceptedFrameIndex !== index || acceptance.review?.verdict !== 'accept'
    || acceptance.review?.manualVerdict !== 'accept'
    || checks.some(name => acceptance.checks?.[name] !== true))
    INVALID(`phase ${phase} acceptance contract invalid`)
  const model = await verifyStageModelReviewLedger(planId, phase, acceptance.review?.executionId, root)
  const manual = await readStageManualReview(planId, phase, root)
  if (acceptance.nativeEvidenceSha256 !== model.nativeEvidenceSha256
    || acceptance.review.ledgerSha256 !== model.ledgerSha256
    || acceptance.review.requestKey !== model.requestKey
    || acceptance.review.promptSha256 !== model.promptSha256
    || acceptance.review.manualReviewSha256 !== manual.sha256)
    INVALID(`phase ${phase} review ledger changed after acceptance`)
  await verifiedAsset(root, acceptance.videoUrl, acceptance.videoSha256, generatedVideo)
  const native = await inspectStagedNativeVideo(localFile(root, acceptance.videoUrl, generatedVideo), count, lastPts)
  if (native.frameDigestSha256 !== acceptance.nativeFrameDigestSha256)
    INVALID(`phase ${phase} native frame sequence changed`)
  const actualFrame = await nativeJpeg(localFile(root, acceptance.videoUrl, generatedVideo), index)
  if (sha256(actualFrame) !== acceptance.acceptedFrameSha256)
    INVALID(`phase ${phase} accepted native frame changed`)
  await verifiedAsset(root, acceptance.acceptedFrameUrl, acceptance.acceptedFrameSha256, generatedImage)
  if (phase === 'B') {
    const previous = await readStageAcceptance(planId, 'A', root)
    const actualFirst = await nativeJpeg(localFile(root, acceptance.videoUrl, generatedVideo), 0)
    const actualStitchedFirst = await nativeJpeg(localFile(root, acceptance.videoUrl, generatedVideo), 1)
    if (sha256(actualFirst) !== acceptance.seam?.phaseBFirstFrameSha256
      || sha256(actualStitchedFirst) !== acceptance.seam?.phaseBStitchedFirstFrameSha256
      || acceptance.seam?.phaseAFrameSha256 !== previous.acceptedFrameSha256
      || acceptance.seam?.phaseAFrameIndex !== 180 || acceptance.seam?.phaseBFirstFrameIndex !== 0
      || acceptance.seam?.stitchedPhaseBStartFrameIndex !== 1
      || acceptance.seam?.review?.verdict !== 'accept'
      || acceptance.seam?.review?.manualVerdict !== 'accept')
      INVALID('phase A→B actual seam is not accepted')
  }
  return acceptance
}

export async function previewStageBRequest(planId, root = process.cwd(), includeRequest = false) {
  const manifest = await readStagedSceneCutManifest(planId, root)
  const receipt = await readStageAcceptance(planId, 'A', root)
  const actualFrame = await verifiedAsset(root, receipt.acceptedFrameUrl,
    receipt.acceptedFrameSha256, generatedImage)
  const end = await verifiedAsset(root, manifest.guides['312'].url,
    manifest.guides['312'].jpegSha256, generatedImage)
  const compact = manifest.promptVersion === 'early-binding-v3-compact1'
  const references = compact ? manifest.compactTransport.entries.slice(1).map(entry => entry.transport.url)
    : manifest.identities.map(asset => asset.url)
  const prepared = await prepareKlingImageInputs({ referenceImage: actualFrame.url,
    referenceImages: references, endImage: end.url,
    duration: 6, mode: 'std', model_name: 'kling-v3-omni', sound: 'off',
    pacingVersion: 'independent-narration-v1', audioType: '环境声', audioText: '' },
  path.join(root, 'public/generated'))
  const request = buildKlingVideoRequest({ settings: { model: 'kling-v3-omni' } },
    stagePrompt('B', manifest.promptVersion ?? 'v1'), prepared)
  const imageTypes = request.image_list?.map(item => item.type ?? 'reference')
  if (canonical(imageTypes) !== canonical(['reference', 'reference', 'first_frame', 'end_frame'])
    || request.duration !== '6' || request.sound !== 'off'
    || Array.from(request.prompt).length > 2500)
    INVALID('phase B provider request contract changed')
  return { phase: 'B', providerDuration: 6, acceptedDuration: 5.5,
    requestSha256: sha256(canonical(request)), promptCharacters: Array.from(request.prompt).length,
    imageTypes, firstFrameSha256: actualFrame.sha256, endFrameSha256: end.sha256,
    identitySha256s: compact ? manifest.compactTransport.entries.slice(1).map(item => item.transport.sha256)
      : manifest.identities.map(item => item.sha256),
    ...(compact ? { approvedIdentitySha256s: manifest.identities.map(item => item.sha256) } : {}),
    providerCalls: 0,
    ...(includeRequest ? { request } : {}) }
}

function stageDirectory(root, planId) {
  if (!SHA.test(String(planId))) INVALID('plan id invalid')
  return path.join(root, '.runtime/staged-scene-cut', planId)
}
function readSignedSync(filename, key) {
  const bytes = readFileSync(filename)
  const value = JSON.parse(bytes.toString('utf8'))
  verifySignature(value, key)
  return { value, sha256: sha256(bytes) }
}
function verifiedAssetSync(root, url, expectedSha256, expression) {
  if (!SHA.test(String(expectedSha256)) || fileSha256Sync(localFile(root, url, expression)) !== expectedSha256)
    INVALID(`source-bound asset changed: ${url}`)
}
function verifySalvageASignedLineageSync(manifest, planId, root, key, directory) {
  const source = manifest.salvage?.source, derived = manifest.salvage?.derivedA
  if (manifest.version !== 'staged-scene-cut-salvage-v1'
    || manifest.promptVersion !== 'salvage-a-frame-drop-v1'
    || derived?.kind !== 'deterministic-derivative-of-rejected-paid-A'
    || derived?.frameCount !== 181 || derived?.fps !== 24 || derived?.lastPts !== 7.5
    || manifest.salvage?.transform?.method !== 'native-frame-drop-v1'
    || manifest.salvage?.transform?.outputToSource !== 's(j)=j+floor((j+7)/15), 0<=j<=180')
    INVALID('salvage A manifest variant invalid')
  const parentDirectory = stageDirectory(root, source.parentPlanId)
  const parent = readSignedSync(path.join(parentDirectory, 'manifest.json'), key)
  const task = readSignedSync(path.join(parentDirectory, 'phase-A-task.json'), key)
  const media = readSignedSync(path.join(parentDirectory, 'phase-A-media.json'), key)
  const rejection = readSignedSync(path.join(parentDirectory, 'phase-A-rejection.json'), key)
  if (parent.sha256 !== source.parentManifestSha256
    || task.sha256 !== source.parentTaskReceiptSha256
    || media.sha256 !== source.parentMediaReceiptSha256
    || rejection.sha256 !== source.parentRejectionSha256
    || parent.value.sourceRecordId !== manifest.sourceRecordId
    || parent.value.sourceResultMd5 !== manifest.sourceResultMd5
    || parent.value.approvedShotSha256 !== manifest.approvedShotSha256
    || parent.value.approvalSha256 !== manifest.approvalSha256
    || canonical(parent.value.narrationTracks) !== canonical(manifest.narrationTracks)
    || task.value.taskId !== source.taskId || media.value.taskId !== source.taskId
    || media.value.videoUrl !== source.videoUrl || media.value.videoSha256 !== source.videoSha256
    || rejection.value.taskId !== source.taskId || rejection.value.videoSha256 !== source.videoSha256
    || rejection.value.verdict !== 'reject')
    INVALID('salvage A rejected paid source lineage invalid')
  verifiedAssetSync(root, source.videoUrl, source.videoSha256, generatedVideo)
  verifiedAssetSync(root, derived.url, derived.sha256, generatedVideo)
  if (existsSync(path.join(directory, 'phase-A-rejection.json')))
    INVALID('new salvage plan A was explicitly rejected')
  const evidence = readSignedSync(path.join(directory, 'phase-A-review-evidence.json'), key)
  const manual = readSignedSync(path.join(directory, 'phase-A-manual-review.json'), key)
  const acceptance = readSignedSync(path.join(directory, 'phase-A-acceptance.json'), key).value
  const lastDerived = evidence.value.frames?.at(-2), lastSource = evidence.value.frames?.at(-1)
  if (evidence.value.version !== 'staged-salvage-review-evidence-v1'
    || evidence.value.planId !== planId || evidence.value.videoSha256 !== derived.sha256
    || evidence.value.sourceVideoSha256 !== source.videoSha256
    || evidence.value.nativeFrameDigestSha256 !== derived.nativeFrameDigestSha256
    || lastDerived?.kind !== 'derived' || lastDerived.frameIndex !== 180
    || lastSource?.kind !== 'paid-source' || lastSource.frameIndex !== 192
    || lastDerived.sha256 !== lastSource.sha256
    || manual.value.version !== 'staged-salvage-a-direct-review-v1'
    || manual.value.planId !== planId || manual.value.verdict !== 'accept'
    || manual.value.videoSha256 !== derived.sha256
    || manual.value.nativeEvidenceSha256 !== evidence.sha256
    || acceptance.version !== 'staged-salvage-a-acceptance-v1'
    || acceptance.planId !== planId || acceptance.phase !== 'A'
    || acceptance.sourceKind !== derived.kind
    || acceptance.sourcePlanId !== source.parentPlanId
    || acceptance.sourceVideoSha256 !== source.videoSha256
    || acceptance.sourceRejectionSha256 !== source.parentRejectionSha256
    || acceptance.taskId !== source.taskId || acceptance.videoUrl !== derived.url
    || acceptance.videoSha256 !== derived.sha256
    || acceptance.nativeFrameDigestSha256 !== derived.nativeFrameDigestSha256
    || acceptance.acceptedFrameIndex !== 180
    || acceptance.acceptedFrameSha256 !== lastDerived.sha256
    || acceptance.nativeEvidenceSha256 !== evidence.sha256
    || acceptance.review?.verdict !== 'accept' || acceptance.review?.manualVerdict !== 'accept'
    || !/^model-run-[\w-]+$/.test(acceptance.review?.executionId ?? '')
    || !SHA.test(acceptance.review?.ledgerSha256 ?? '')
    || acceptance.review?.manualReviewSha256 !== manual.sha256)
    INVALID('salvage A signed review/acceptance lineage invalid')
  for (const check of ['frontWristBindingByFrame180', 'guardsReleasedByFrame180',
    'zhangStationaryThroughFrame180', 'motionCadenceAcceptable', 'endpointContinuity',
    'noCoreContradiction'])
    if (acceptance.checks?.[check] !== true || manual.value.checks?.[check] !== true)
      INVALID(`salvage A direct review did not pass ${check}`)
  verifiedAssetSync(root, acceptance.acceptedFrameUrl, acceptance.acceptedFrameSha256, generatedImage)
  verifiedAssetSync(root, lastDerived.url, lastDerived.sha256, generatedImage)
  verifiedAssetSync(root, lastSource.url, lastSource.sha256, generatedImage)
  return { task: task.value, acceptance }
}

/** The synchronous verifier is for the existing synchronous replay lineage.
 * It validates current bytes, signed provenance and the standard narration
 * recipe; the async verifier additionally decodes every native frame/audio. */
export function verifyStagedSceneCutCompositeReceiptSync(planId, root = process.cwd()) {
  const key = readSigningKeySync(root), directory = stageDirectory(root, planId)
  const { value: manifest, sha256: manifestSha256 } = readSignedSync(path.join(directory, 'manifest.json'), key)
  const { planId: _id, phaseAPreview: _preview, signature: _signature, ...binding } = manifest
  void _id; void _preview; void _signature
  if (manifest.planId !== planId || sha256(canonical(binding)) !== planId
    || !validateStagedShot1Timeline(manifest.phases)
    || manifest.deliveredFrames !== 313 || manifest.fps !== 24)
    INVALID('staged manifest identity/timeline invalid')
  for (const asset of [manifest.first, ...manifest.identities])
    verifiedAssetSync(root, asset.url, asset.sha256, generatedImage)
  for (const guide of Object.values(manifest.guides))
    verifiedAssetSync(root, guide.url, guide.jpegSha256, generatedImage)
  verifiedAssetSync(root, manifest.rejectedVideo.url, manifest.rejectedVideo.sha256, generatedVideo)
  for (const track of manifest.narrationTracks)
    verifiedAssetSync(root, track.url, track.sha256, /^\/generated\/[\w.-]+\.wav$/i)
  if (manifest.version === 'staged-scene-cut-shot1-v3-compact1') {
    const firstFailure = readSignedSync(path.join(stageDirectory(root,
      'dc8f9fd00f18fade4c8b38c34779639b5305d2946cbd5c61ed927d19efed9418'),
    'phase-A-failure.json'), key)
    const secondFailure = readSignedSync(path.join(stageDirectory(root,
      'ff5e5f076006371431bb718741420a8a493f4a96ed75b5efd95057be4c9f595e'),
    'phase-A-failure.json'), key)
    const after = manifest.transportAfterFailures, compact = manifest.compactTransport
    if (manifest.promptVersion !== 'early-binding-v3-compact1'
      || manifest.sourceRecordId !== 'record-4x5m31-original-repair-tail-guide-v2'
      || manifest.sourceResultMd5 !== '34abee4a7c010616b837dbc175b69c56'
      || manifest.first?.sha256 !== '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
      || manifest.phases?.[0]?.guideFrame !== 219
      || manifest.guides?.['219']?.jpegSha256 !== '815d4bd5497e46a14827deb4fdd3a366033d37ea5e10ec8ff4ac00de31f795af'
      || firstFailure.value.taskStatus !== 'failed' || secondFailure.value.taskStatus !== 'failed'
      || firstFailure.value.finalUnitDeduction !== '0' || secondFailure.value.finalUnitDeduction !== '0'
      || firstFailure.value.outputMedia !== 'none' || secondFailure.value.outputMedia !== 'none'
      || firstFailure.value.requestSha256 !== secondFailure.value.requestSha256
      || manifest.phaseAPreview?.requestSha256 === firstFailure.value.requestSha256
      || after?.v3?.planId !== firstFailure.value.planId
      || after.v3.taskId !== firstFailure.value.taskId
      || after.v3.failureReceiptSha256 !== firstFailure.sha256
      || after?.retry1?.planId !== secondFailure.value.planId
      || after.retry1.taskId !== secondFailure.value.taskId
      || after.retry1.failureReceiptSha256 !== secondFailure.sha256
      || after.variant !== 'one source-bound bounded-jpeg transport; no identical request retry'
      || compact?.version !== 'staged-compact-jpeg-transport-v1'
      || canonical(manifest.providerLock) !== canonical(COMPACT_PROVIDER_LOCK)
      || compact.unchangedEndGuideSha256 !== manifest.guides['219'].jpegSha256
      || compact.entries?.length !== 3
      || compact.totalBytes > 1_100_000)
      INVALID('compact composite lost approved sources or terminal-failure lineage')
    for (const [index, entry] of compact.entries.entries()) {
      const source = index === 0 ? manifest.first : manifest.identities[index - 1]
      if (entry.source?.url !== source.url || entry.source.sha256 !== source.sha256
        || entry.transport?.format !== 'jpeg'
        || entry.transport.byteLength > [650000, 250000, 250000][index]
        || !SHA.test(entry.transport.sha256 ?? ''))
        INVALID('compact composite source/transport asset binding invalid')
      verifiedAssetSync(root, entry.transport.url, entry.transport.sha256, generatedImage)
      if (readFileSync(localFile(root, entry.transport.url, generatedImage)).length !== entry.transport.byteLength)
        INVALID('compact composite transport byte length changed')
    }
  }
  const salvage = manifest.version === 'staged-scene-cut-salvage-v1'
  const stages = Object.fromEntries(['A', 'B'].map(phase => {
    if (existsSync(path.join(directory, `phase-${phase}-rejection.json`)))
      INVALID(`phase ${phase} was explicitly rejected; composite is forbidden`)
    if (phase === 'A' && salvage)
      return [phase, verifySalvageASignedLineageSync(manifest, planId, root, key, directory)]
    const task = readSignedSync(path.join(directory, `phase-${phase}-task.json`), key).value
    const media = readSignedSync(path.join(directory, `phase-${phase}-media.json`), key).value
    const acceptance = readSignedSync(path.join(directory, `phase-${phase}-acceptance.json`), key).value
    if (task.version !== 'staged-provider-task-v1' || task.phase !== phase || task.planId !== planId
      || media.version !== 'staged-provider-media-v1' || media.phase !== phase
      || media.planId !== planId || media.taskId !== task.taskId
      || media.videoUrl !== acceptance.videoUrl || media.videoSha256 !== acceptance.videoSha256
      || media.nativeFrameDigestSha256 !== acceptance.nativeFrameDigestSha256
      || acceptance.version !== 'staged-native-acceptance-v1' || acceptance.phase !== phase
      || acceptance.planId !== planId || acceptance.taskId !== task.taskId
      || acceptance.acceptedFrameIndex !== (phase === 'A' ? 180 : 132)
      || acceptance.review?.verdict !== 'accept' || acceptance.review?.manualVerdict !== 'accept'
      || !SHA.test(acceptance.nativeFrameDigestSha256 ?? ''))
      INVALID(`phase ${phase} task/acceptance identity invalid`)
    verifiedAssetSync(root, acceptance.videoUrl, acceptance.videoSha256, generatedVideo)
    verifiedAssetSync(root, acceptance.acceptedFrameUrl, acceptance.acceptedFrameSha256, generatedImage)
    return [phase, { task, acceptance }]
  }))
  const A = stages.A.acceptance, B = stages.B.acceptance
  if (!salvage && stages.A.task.requestSha256 !== manifest.phaseAPreview?.requestSha256
    || manifest.version === 'staged-scene-cut-shot1-v3-compact1'
      && (stages.A.task.providerModelId !== manifest.providerLock.modelId
        || stages.A.task.endpointSha256 !== manifest.providerLock.endpointSha256)
    || B.seam?.phaseAFrameIndex !== 180 || B.seam?.phaseAFrameSha256 !== A.acceptedFrameSha256
    || B.seam?.phaseBFirstFrameIndex !== 0 || !SHA.test(B.seam?.phaseBFirstFrameSha256 ?? '')
    || B.seam?.stitchedPhaseBStartFrameIndex !== 1
    || !SHA.test(B.seam?.phaseBStitchedFirstFrameSha256 ?? '')
    || B.seam?.review?.verdict !== 'accept' || B.seam?.review?.manualVerdict !== 'accept')
    INVALID('staged provider/seam lineage incomplete')
  const { value: receipt, sha256: receiptSha256 } = readSignedSync(path.join(directory, 'composite-receipt.json'), key)
  const mapping = { phaseA: { sourceStartFrame: 0, sourceEndFrame: 180, outputStartFrame: 0, outputEndFrame: 180 },
    phaseB: { sourceStartFrame: 1, sourceEndFrame: 132, outputStartFrame: 181, outputEndFrame: 312 } }
  if (receipt.version !== 'staged-scene-cut-composite-v1' || receipt.planId !== planId
    || receipt.manifestSha256 !== manifestSha256 || receipt.sourceRecordId !== manifest.sourceRecordId
    || receipt.sourceResultMd5 !== manifest.sourceResultMd5
    || receipt.approvedShotSha256 !== manifest.approvedShotSha256
    || receipt.approvalSha256 !== manifest.approvalSha256
    || canonical(receipt.mapping) !== canonical(mapping)
    || receipt.sources?.phaseA?.taskId !== stages.A.task.taskId
    || receipt.sources?.phaseA?.videoSha256 !== A.videoSha256
    || receipt.sources?.phaseA?.videoUrl !== A.videoUrl
    || receipt.sources?.phaseA?.acceptedFrameIndex !== 180
    || salvage && (receipt.sources?.phaseA?.kind !== 'deterministic-derivative-of-rejected-paid-A'
      || receipt.sources?.phaseA?.sourcePlanId !== manifest.salvage.source.parentPlanId
      || receipt.sources?.phaseA?.sourceVideoSha256 !== manifest.salvage.source.videoSha256
      || receipt.sources?.phaseA?.sourceRejectionSha256 !== manifest.salvage.source.parentRejectionSha256)
    || receipt.sources?.phaseB?.taskId !== stages.B.task.taskId
    || receipt.sources?.phaseB?.videoSha256 !== B.videoSha256
    || receipt.sources?.phaseB?.videoUrl !== B.videoUrl
    || receipt.sources?.phaseB?.acceptedFrameIndex !== 132
    || canonical(receipt.seam) !== canonical(B.seam)
    || receipt.picture?.frameCount !== 313 || receipt.picture?.fps !== 24
    || receipt.picture?.lastPts !== 13 || receipt.picture?.silentAudio !== true
    || !SHA.test(receipt.picture?.nativeFrameDigestSha256 ?? '')
    || receipt.output?.url !== receipt.narration?.url || receipt.output?.sha256 !== receipt.narration?.sha256
    || receipt.narration?.mixerVersion !== 6 || receipt.narration?.fullSourceMute !== true
    || canonical(receipt.narration?.ttsTrackSha256s) !== canonical(manifest.narrationTracks.map(track => track.sha256))
    || receipt.review?.seamVerdict !== 'accept' || receipt.review?.wholeShot !== 'pending-node58')
    INVALID('composite source/timeline/review contract invalid')
  verifiedAssetSync(root, receipt.picture.url, receipt.picture.sha256, generatedVideo)
  verifiedAssetSync(root, receipt.output.url, receipt.output.sha256, generatedVideo)
  const keyMatch = /^\/generated\/narrated-([a-f0-9]{64})\.mp4$/.exec(receipt.output.url)
  if (!keyMatch || keyMatch[1] !== receipt.narration.compositionReceiptKey)
    INVALID('final narration is not a standard composition')
  const compositionBytes = readFileSync(path.join(root, '.runtime/narration-compositions', `${keyMatch[1]}.json`))
  const composition = JSON.parse(compositionBytes.toString('utf8'))
  const windows = composition.pictureVoiceIsolation?.mutedWindows
  if (sha256(compositionBytes) !== receipt.narration.compositionReceiptSha256
    || composition.version !== 'narration-composition-v1' || composition.key !== keyMatch[1]
    || composition.outputUrl !== receipt.output.url || composition.outputSha256 !== receipt.output.sha256
    || composition.pictureUrl !== receipt.picture.url || composition.pictureSha256 !== receipt.picture.sha256
    || composition.mixerVersion !== 6 || composition.duration !== 13 || composition.audioRole !== 'narration'
    || canonical(composition.tracks) !== canonical(manifest.narrationTracks)
    || composition.pictureVoiceIsolation?.status !== 'fully-muted-unverified'
    || composition.pictureVoiceIsolation?.sourceSha256 !== receipt.picture.sha256
    || composition.pictureVoiceIsolation?.preservedOutsideWindows !== false
    || !Array.isArray(windows) || !windows.some(window => window.start <= 0 && window.end >= 13))
    INVALID('independent narration composition/full-source-mute receipt invalid')
  return { manifest, receipt, manifestSha256, receiptSha256 }
}

async function assertSilentAudio(filename) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename, '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 16000 * 4 * 12.9 || stdout.length % 4)
    INVALID('stitched picture silent audio is missing or truncated')
  for (let offset = 0; offset < stdout.length; offset += 4)
    if (Math.abs(stdout.readFloatLE(offset)) > .00001) INVALID('stitched picture carries non-silent source audio')
  return true
}

export async function verifyStagedSceneCutCompositeReceipt(planId, root = process.cwd()) {
  const verified = verifyStagedSceneCutCompositeReceiptSync(planId, root)
  const { manifest, receipt } = verified
  const A = await readStageAcceptance(planId, 'A', root)
  const B = await readStageAcceptance(planId, 'B', root)
  const picture = await inspectStagedNativeVideo(localFile(root, receipt.picture.url, generatedVideo), 313, 13)
  const final = await inspectStagedNativeVideo(localFile(root, receipt.output.url, generatedVideo), 313, 13)
  if (picture.frameDigestSha256 !== receipt.picture.nativeFrameDigestSha256
    || final.count !== manifest.deliveredFrames
    || A.videoSha256 !== receipt.sources.phaseA.videoSha256
    || B.videoSha256 !== receipt.sources.phaseB.videoSha256)
    INVALID('composite native frames or stage sources changed')
  await assertSilentAudio(localFile(root, receipt.picture.url, generatedVideo))
  return verified
}

/** Only signed and independently accepted actual A/B clips may be stitched.
 * The source clips are never overwritten or used as soundtrack inputs. */
export async function composeStagedSceneCut(planId, root = process.cwd()) {
  const manifest = await readStagedSceneCutManifest(planId, root)
  const A = await readStageAcceptance(planId, 'A', root)
  const B = await readStageAcceptance(planId, 'B', root)
  const directory = stageDirectory(root, planId)
  const manifestSha256 = await fileSha256(path.join(directory, 'manifest.json'))
  const mapping = { phaseA: { sourceStartFrame: 0, sourceEndFrame: 180, outputStartFrame: 0, outputEndFrame: 180 },
    phaseB: { sourceStartFrame: 1, sourceEndFrame: 132, outputStartFrame: 181, outputEndFrame: 312 } }
  const pictureKey = sha256(canonical({ version: 'staged-picture-v1', planId,
    phaseA: { sha256: A.videoSha256, nativeFrameDigestSha256: A.nativeFrameDigestSha256 },
    phaseB: { sha256: B.videoSha256, nativeFrameDigestSha256: B.nativeFrameDigestSha256 }, mapping }))
  const pictureUrl = `/generated/staged-picture-${pictureKey}.mp4`
  const pictureFile = localFile(root, pictureUrl, generatedVideo)
  if (!existsSync(pictureFile)) {
    const temporary = path.join(root, 'public/generated', `staged-picture-${pictureKey}-${randomUUID()}.mp4`)
    const filter = '[0:v]trim=start_frame=0:end_frame=181,setpts=PTS-STARTPTS[a];'
      + '[1:v]trim=start_frame=1:end_frame=133,setpts=PTS-STARTPTS[b];'
      + '[a][b]concat=n=2:v=1:a=0,fps=24[v];'
      + '[2:a]atrim=duration=13.041666667,asetpts=PTS-STARTPTS[s]'
    await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror',
      '-i', localFile(root, A.videoUrl, generatedVideo), '-i', localFile(root, B.videoUrl, generatedVideo),
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex', filter, '-map', '[v]', '-map', '[s]', '-frames:v', '313',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart', temporary],
    { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
    try { await writeOnce(pictureFile, await readFile(temporary)) }
    finally { const { unlink } = await import('node:fs/promises'); await unlink(temporary).catch(() => {}) }
  }
  const pictureSha256 = await fileSha256(pictureFile)
  const pictureNative = await inspectStagedNativeVideo(pictureFile, 313, 13)
  await assertSilentAudio(pictureFile)
  const composed = await composeNarration(pictureUrl, manifest.narrationTracks, 13, '16:9', root, '720p',
    'narration', { detectPictureVoice: async () => { throw Error('verified silent picture: require full source mute') } })
  const outputSha256 = await fileSha256(localFile(root, composed.url, generatedVideo))
  await inspectStagedNativeVideo(localFile(root, composed.url, generatedVideo), 313, 13)
  const compositionReceiptKey = /^\/generated\/narrated-([a-f0-9]{64})\.mp4$/.exec(composed.url)?.[1]
  if (!compositionReceiptKey) INVALID('independent narration did not return standard output')
  const compositionReceiptFile = path.join(root, '.runtime/narration-compositions', `${compositionReceiptKey}.json`)
  const compositionReceiptSha256 = await fileSha256(compositionReceiptFile)
  const value = { version: 'staged-scene-cut-composite-v1', planId, manifestSha256,
    sourceRecordId: manifest.sourceRecordId, sourceResultMd5: manifest.sourceResultMd5,
    approvedShotSha256: manifest.approvedShotSha256, approvalSha256: manifest.approvalSha256,
    sources: { phaseA: { taskId: A.taskId, videoUrl: A.videoUrl, videoSha256: A.videoSha256,
      acceptedFrameIndex: 180,
      ...(manifest.version === 'staged-scene-cut-salvage-v1' ? { kind: A.sourceKind,
        sourcePlanId: A.sourcePlanId, sourceVideoSha256: A.sourceVideoSha256,
        sourceRejectionSha256: A.sourceRejectionSha256 } : {}) },
    phaseB: { taskId: B.taskId, videoUrl: B.videoUrl,
      videoSha256: B.videoSha256, acceptedFrameIndex: 132 } },
    mapping, seam: B.seam,
    picture: { url: pictureUrl, sha256: pictureSha256,
      nativeFrameDigestSha256: pictureNative.frameDigestSha256,
      frameCount: 313, fps: 24, lastPts: 13, silentAudio: true },
    narration: { url: composed.url, sha256: outputSha256, compositionReceiptKey,
      compositionReceiptSha256, mixerVersion: 6, fullSourceMute: true,
      ttsTrackSha256s: manifest.narrationTracks.map(track => track.sha256) },
    output: { url: composed.url, sha256: outputSha256 },
    review: { seamVerdict: 'accept', wholeShot: 'pending-node58' }, signature: '' }
  value.signature = signedObject(value, await readSigningKey(root))
  await writeOnce(path.join(directory, 'composite-receipt.json'), JSON.stringify(value, null, 2) + '\n')
  return verifyStagedSceneCutCompositeReceipt(planId, root)
}
