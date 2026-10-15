/** Reuse a rejected, paid 8-second A take through an explicit local frame drop.
 * The failed parent plan stays rejected. Its derivative is a new source-bound
 * candidate, never represented as provider-native footage. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { inspectStagedNativeVideo, readStagedSceneCutManifest, readStageMediaReceipt,
  readStageRejection, readStageTaskReceipt, validateStagedShot1Timeline } from './staged-scene-cut.mjs'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const SHA = /^[a-f0-9]{64}$/
const INVALID = message => { throw Error(`STAGED_SALVAGE_INVALID: ${message}`) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const directory = (root, planId) => {
  if (!SHA.test(String(planId))) INVALID('plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut', planId)
}
const localVideo = (root, url) => {
  if (!/^\/generated\/[\w.-]+\.mp4$/.test(String(url))) INVALID('video URL invalid')
  return path.join(root, 'public', url.slice(1))
}
const localImage = (root, url) => {
  if (!/^\/generated\/[\w.-]+\.jpg$/.test(String(url))) INVALID('review image URL invalid')
  return path.join(root, 'public', url.slice(1))
}
async function fileSha256(filename) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filename)) hash.update(bytes)
  return hash.digest('hex')
}
async function signingKey(root) {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) INVALID('staging signing key invalid')
  return key
}
function signature(value, key) {
  const { signature: ignored, ...body } = value
  void ignored
  return createHmac('sha256', key).update(canonical(body)).digest('hex')
}
function verifySignature(value, key) {
  const actual = String(value?.signature ?? ''), expected = signature(value, key)
  if (!SHA.test(actual) || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')))
    INVALID('signed salvage receipt changed')
}
async function writeOnce(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(Buffer.from(bytes)))
      INVALID(`immutable salvage artifact differs: ${filename}`)
  }
}
async function frameRawSha256(filename, frameIndex) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${frameIndex})`, '-vsync', 'vfr', '-frames:v', '1',
    '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 3 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length !== 1280 * 720 * 1.5)
    INVALID(`decoded frame ${frameIndex} is incomplete`)
  return sha256(stdout)
}
async function frameJpeg(filename, frameIndex) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', filename,
    '-vf', `select=eq(n\\,${frameIndex})`, '-vsync', 'vfr', '-frames:v', '1',
    '-q:v', '2', '-f', 'image2', '-'],
  { encoding: 'buffer', timeout: 120000, maxBuffer: 20 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 1000 || stdout[0] !== 0xff || stdout[1] !== 0xd8)
    INVALID(`frame ${frameIndex} did not decode as JPEG`)
  return stdout
}

export const SALVAGE_METHOD = 'native-frame-drop-v1'
export const SALVAGE_FILTER = 'setpts=(PTS-STARTPTS)*15/16,fps=fps=24:round=near'
export const SALVAGE_DROP_INDICES = Object.freeze(Array.from({ length: 12 }, (_, index) => 8 + 16 * index))
export const SALVAGE_A_REVIEW_FRAMES = Object.freeze([
  0, 24, 48, 60, 81, 82, 83, 84, 96, 97, 98, 99, 120, 144,
  156, 168, 172, 173, 174, 178, 180,
])

export function salvageSourceFrame(outputFrameIndex) {
  if (!Number.isInteger(outputFrameIndex) || outputFrameIndex < 0 || outputFrameIndex > 180)
    INVALID('retimed output frame index invalid')
  return outputFrameIndex + Math.floor((outputFrameIndex + 7) / 15)
}

export function salvageCommandTemplate() {
  return ['-hide_banner', '-v', 'error', '-xerror', '-y', '-i', '%SOURCE%',
    '-map_metadata', '-1', '-vf', SALVAGE_FILTER, '-frames:v', '181', '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-qp', '0', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '%OUTPUT%']
}

/** Local-only render. `outputPath` should be /tmp for preflight. */
export async function renderSalvageA(parentPlanId, outputPath, root = process.cwd()) {
  const parent = await readStagedSceneCutManifest(parentPlanId, root)
  if (parent.version !== 'staged-scene-cut-shot1-v2' || parent.promptVersion !== 'early-binding-v2')
    INVALID('source plan must be the rejected v2 staged shot')
  const [task, media, rejection] = await Promise.all([
    readStageTaskReceipt(parentPlanId, 'A', root),
    readStageMediaReceipt(parentPlanId, 'A', root),
    readStageRejection(parentPlanId, 'A', root),
  ])
  if (rejection.videoSha256 !== media.videoSha256 || rejection.taskId !== task.taskId)
    INVALID('source rejection is not bound to the paid A take')
  const sourceFile = localVideo(root, media.videoUrl)
  const sourceNative = await inspectStagedNativeVideo(sourceFile, 193, 8)
  if (sourceNative.frameDigestSha256 !== media.nativeFrameDigestSha256)
    INVALID('source paid native frame sequence changed')
  if (!path.isAbsolute(outputPath)
    || !(outputPath.startsWith(os.tmpdir() + path.sep) || outputPath.startsWith('/tmp/'))
    || path.extname(outputPath) !== '.mp4') INVALID('preflight output must be a /tmp MP4')
  await mkdir(path.dirname(outputPath), { recursive: true })
  const args = salvageCommandTemplate().map(value => value === '%SOURCE%' ? sourceFile
    : value === '%OUTPUT%' ? outputPath : value)
  await exec(ffmpeg, args, { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 })
  const derivedNative = await inspectStagedNativeVideo(outputPath, 181, 7.5)
  const [sourceFirstRawSha256, sourceLastRawSha256, outputFirstRawSha256, outputLastRawSha256] = await Promise.all([
    frameRawSha256(sourceFile, 0), frameRawSha256(sourceFile, 192),
    frameRawSha256(outputPath, 0), frameRawSha256(outputPath, 180),
  ])
  if (derivedNative.hashes[0] !== sourceNative.hashes[0]
    || derivedNative.hashes[180] !== sourceNative.hashes[192]
    || outputFirstRawSha256 !== sourceFirstRawSha256
    || outputLastRawSha256 !== sourceLastRawSha256)
    INVALID('retime first/last decoded pixels differ from the paid source')
  // Every interior frame must be one of the original decoded native frames,
  // at the exact nearest-frame selector index. No optical synthesis is hidden.
  for (let frame = 0; frame <= 180; frame++)
    if (derivedNative.hashes[frame] !== sourceNative.hashes[salvageSourceFrame(frame)])
      INVALID(`retime output frame ${frame} is not its selected native source frame`)
  return { parent, task, media, rejection, sourceNative, derivedNative,
    outputPath, outputSha256: await fileSha256(outputPath),
    sourceFirstRawSha256, sourceLastRawSha256, outputFirstRawSha256, outputLastRawSha256,
    ffmpegSha256: await fileSha256(ffmpeg), commandTemplate: salvageCommandTemplate() }
}

export async function planSalvageA(parentPlanId, outputPath, root = process.cwd()) {
  const rendered = await renderSalvageA(parentPlanId, outputPath, root)
  const { parent, task, media, sourceNative, derivedNative } = rendered
  const parentDirectory = directory(root, parentPlanId)
  const source = { parentPlanId,
    parentManifestSha256: await fileSha256(path.join(parentDirectory, 'manifest.json')),
    parentTaskReceiptSha256: await fileSha256(path.join(parentDirectory, 'phase-A-task.json')),
    parentMediaReceiptSha256: await fileSha256(path.join(parentDirectory, 'phase-A-media.json')),
    parentRejectionSha256: await fileSha256(path.join(parentDirectory, 'phase-A-rejection.json')),
    taskId: task.taskId, videoUrl: media.videoUrl, videoSha256: media.videoSha256,
    nativeFrameDigestSha256: sourceNative.frameDigestSha256,
    firstRawSha256: rendered.sourceFirstRawSha256,
    lastRawSha256: rendered.sourceLastRawSha256 }
  const derivedA = { kind: 'deterministic-derivative-of-rejected-paid-A',
    url: `/generated/staged-salvage-a-${rendered.outputSha256}.mp4`,
    sha256: rendered.outputSha256, nativeFrameDigestSha256: derivedNative.frameDigestSha256,
    frameCount: 181, fps: 24, lastPts: 7.5,
    firstRawSha256: rendered.outputFirstRawSha256,
    lastRawSha256: rendered.outputLastRawSha256 }
  const { planId: ignoredId, phaseAPreview: ignoredPreview, signature: ignoredSignature,
    version: ignoredVersion, promptVersion: ignoredPromptVersion,
    boundary: ignoredBoundary, ...approvedBinding } = parent
  void ignoredId; void ignoredPreview; void ignoredSignature; void ignoredVersion
  void ignoredPromptVersion; void ignoredBoundary
  const binding = { ...approvedBinding, version: 'staged-scene-cut-salvage-v1',
    promptVersion: 'salvage-a-frame-drop-v1',
    salvage: { source, transform: { method: SALVAGE_METHOD,
      sourceFrameStart: 0, sourceFrameEnd: 192, sourceFrameCount: 193,
      outputFrameCount: 181, outputLastPts: 7.5, outputFps: 24,
      outputToSource: 's(j)=j+floor((j+7)/15), 0<=j<=180',
      skippedSourceFrames: [...SALVAGE_DROP_INDICES],
      ffmpegSha256: rendered.ffmpegSha256, commandTemplate: rendered.commandTemplate },
    derivedA },
    boundary: 'new derivative plan; rejected paid A remains rejected; B requires independent/direct derivative review' }
  const planId = sha256(canonical(binding))
  return { ...binding, planId, phaseAPreview: { kind: 'deterministic-local-derivative',
    videoSha256: derivedA.sha256, providerCalls: 0 }, stagedVideoPath: outputPath }
}

/** Filesystem writes only: immutable derivative and signed new manifest. */
export async function saveSalvagePlan(plan, root = process.cwd()) {
  const { stagedVideoPath, planId, phaseAPreview, ...binding } = plan ?? {}
  if (!SHA.test(planId) || planId !== sha256(canonical(binding))
    || phaseAPreview?.kind !== 'deterministic-local-derivative'
    || phaseAPreview.videoSha256 !== plan.salvage?.derivedA?.sha256)
    INVALID('salvage binding changed since read-only preflight')
  const rerendered = await planSalvageA(plan.salvage.source.parentPlanId, stagedVideoPath, root)
  if (rerendered.planId !== planId) INVALID('source or transformation changed since preflight')
  await writeOnce(localVideo(root, plan.salvage.derivedA.url), await readFile(stagedVideoPath))
  const manifest = { ...binding, planId, phaseAPreview, signature: '' }
  manifest.signature = signature(manifest, await signingKey(root))
  const filename = path.join(directory(root, planId), 'manifest.json')
  await writeOnce(filename, JSON.stringify(manifest, null, 2) + '\n')
  return { planId, manifestPath: filename, derivedA: plan.salvage.derivedA,
    manifestSha256: await fileSha256(filename) }
}

export async function readSalvagePlan(planId, root = process.cwd()) {
  const manifest = await readStagedSceneCutManifest(planId, root)
  if (manifest.version !== 'staged-scene-cut-salvage-v1'
    || manifest.promptVersion !== 'salvage-a-frame-drop-v1'
    || !validateStagedShot1Timeline(manifest.phases)
    || manifest.salvage?.transform?.method !== SALVAGE_METHOD
    || manifest.salvage.transform.sourceFrameStart !== 0
    || manifest.salvage.transform.sourceFrameEnd !== 192
    || manifest.salvage.transform.sourceFrameCount !== 193
    || manifest.salvage.transform.outputFrameCount !== 181
    || manifest.salvage.transform.outputLastPts !== 7.5
    || manifest.salvage.transform.outputFps !== 24
    || manifest.salvage.derivedA?.kind !== 'deterministic-derivative-of-rejected-paid-A'
    || manifest.salvage.derivedA.frameCount !== 181
    || manifest.salvage.derivedA.fps !== 24 || manifest.salvage.derivedA.lastPts !== 7.5
    || canonical(manifest.salvage.transform.commandTemplate) !== canonical(salvageCommandTemplate())
    || canonical(manifest.salvage.transform.skippedSourceFrames) !== canonical(SALVAGE_DROP_INDICES)
    || manifest.salvage.transform.outputToSource !== 's(j)=j+floor((j+7)/15), 0<=j<=180')
    INVALID('salvage plan variant/timeline changed')
  const source = manifest.salvage.source, derived = manifest.salvage.derivedA
  const parentDirectory = directory(root, source.parentPlanId)
  for (const [name, expected] of [
    ['manifest.json', source.parentManifestSha256],
    ['phase-A-task.json', source.parentTaskReceiptSha256],
    ['phase-A-media.json', source.parentMediaReceiptSha256],
    ['phase-A-rejection.json', source.parentRejectionSha256],
  ]) if (await fileSha256(path.join(parentDirectory, name)) !== expected)
    INVALID(`source paid/rejected receipt changed: ${name}`)
  const [parent, task, media, rejection] = await Promise.all([
    readStagedSceneCutManifest(source.parentPlanId, root),
    readStageTaskReceipt(source.parentPlanId, 'A', root),
    readStageMediaReceipt(source.parentPlanId, 'A', root),
    readStageRejection(source.parentPlanId, 'A', root),
  ])
  if (parent.sourceRecordId !== manifest.sourceRecordId
    || parent.version !== 'staged-scene-cut-shot1-v2'
    || parent.promptVersion !== 'early-binding-v2'
    || parent.sourceResultMd5 !== manifest.sourceResultMd5
    || parent.approvedShotSha256 !== manifest.approvedShotSha256
    || parent.approvalSha256 !== manifest.approvalSha256
    || canonical(parent.narrationTracks) !== canonical(manifest.narrationTracks)
    || task.taskId !== source.taskId || media.videoSha256 !== source.videoSha256
    || media.videoUrl !== source.videoUrl || rejection.videoSha256 !== source.videoSha256
    || rejection.verdict !== 'reject' || source.nativeFrameDigestSha256 !== media.nativeFrameDigestSha256)
    INVALID('source approval, narration or rejected paid A lineage changed')
  const [sourceNative, derivedNative] = await Promise.all([
    inspectStagedNativeVideo(localVideo(root, source.videoUrl), 193, 8),
    inspectStagedNativeVideo(localVideo(root, derived.url), 181, 7.5),
  ])
  if (await fileSha256(localVideo(root, derived.url)) !== derived.sha256
    || await fileSha256(ffmpeg) !== manifest.salvage.transform.ffmpegSha256
    || sourceNative.frameDigestSha256 !== source.nativeFrameDigestSha256
    || derivedNative.frameDigestSha256 !== derived.nativeFrameDigestSha256
    || await frameRawSha256(localVideo(root, source.videoUrl), 0) !== source.firstRawSha256
    || await frameRawSha256(localVideo(root, source.videoUrl), 192) !== source.lastRawSha256
    || await frameRawSha256(localVideo(root, derived.url), 0) !== derived.firstRawSha256
    || await frameRawSha256(localVideo(root, derived.url), 180) !== derived.lastRawSha256
    || derived.firstRawSha256 !== source.firstRawSha256
    || derived.lastRawSha256 !== source.lastRawSha256)
    INVALID('source-bound derivative video/endpoints changed')
  for (let frame = 0; frame <= 180; frame++)
    if (derivedNative.hashes[frame] !== sourceNative.hashes[salvageSourceFrame(frame)])
      INVALID(`derived frame ${frame} no longer maps to actual paid source`)
  return manifest
}

const A_CHECKS = Object.freeze(['frontWristBindingByFrame180', 'guardsReleasedByFrame180',
  'zhangStationaryThroughFrame180', 'motionCadenceAcceptable', 'endpointContinuity',
  'noCoreContradiction'])
export { A_CHECKS as SALVAGE_A_REQUIRED_CHECKS }

export async function saveSalvageAReviewEvidence(planId, root = process.cwd()) {
  const manifest = await readSalvagePlan(planId, root)
  const derived = manifest.salvage.derivedA, source = manifest.salvage.source
  const frames = []
  for (const frameIndex of SALVAGE_A_REVIEW_FRAMES) {
    const bytes = await frameJpeg(localVideo(root, derived.url), frameIndex)
    const digest = sha256(bytes)
    const url = `/generated/staged-salvage-review-${derived.sha256.slice(0, 16)}-f${frameIndex}-${digest.slice(0, 16)}.jpg`
    await writeOnce(localImage(root, url), bytes)
    frames.push({ kind: 'derived', frameIndex, sourceFrameIndex: salvageSourceFrame(frameIndex),
      url, sha256: digest, videoSha256: derived.sha256 })
  }
  const sourceLast = await frameJpeg(localVideo(root, source.videoUrl), 192)
  const sourceLastSha256 = sha256(sourceLast)
  const sourceLastUrl = `/generated/staged-salvage-source-${source.videoSha256.slice(0, 16)}-f192-${sourceLastSha256.slice(0, 16)}.jpg`
  await writeOnce(localImage(root, sourceLastUrl), sourceLast)
  frames.push({ kind: 'paid-source', frameIndex: 192, url: sourceLastUrl,
    sha256: sourceLastSha256, videoSha256: source.videoSha256 })
  if (frames[frames.length - 2].sha256 !== sourceLastSha256)
    INVALID('derived last JPEG differs from exact paid source f192')
  const value = { version: 'staged-salvage-review-evidence-v1', planId, phase: 'A',
    videoUrl: derived.url, videoSha256: derived.sha256,
    nativeFrameDigestSha256: derived.nativeFrameDigestSha256,
    sourceVideoSha256: source.videoSha256, sourceRejectionSha256: source.parentRejectionSha256,
    frames, reviewImages: frames.map(frame => frame.url), signature: '' }
  value.signature = signature(value, await signingKey(root))
  const filename = path.join(directory(root, planId), 'phase-A-review-evidence.json')
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return { evidence: value, sha256: await fileSha256(filename) }
}

export async function readSalvageAReviewEvidence(planId, root = process.cwd()) {
  const manifest = await readSalvagePlan(planId, root)
  const filename = path.join(directory(root, planId), 'phase-A-review-evidence.json')
  const bytes = await readFile(filename), evidence = JSON.parse(bytes.toString('utf8'))
  verifySignature(evidence, await signingKey(root))
  const derived = manifest.salvage.derivedA, source = manifest.salvage.source
  if (evidence.version !== 'staged-salvage-review-evidence-v1' || evidence.phase !== 'A'
    || evidence.planId !== planId || evidence.videoSha256 !== derived.sha256
    || evidence.videoUrl !== derived.url
    || evidence.nativeFrameDigestSha256 !== derived.nativeFrameDigestSha256
    || evidence.sourceVideoSha256 !== source.videoSha256
    || evidence.sourceRejectionSha256 !== source.parentRejectionSha256
    || evidence.frames?.length !== SALVAGE_A_REVIEW_FRAMES.length + 1
    || canonical(evidence.reviewImages) !== canonical(evidence.frames.map(frame => frame.url)))
    INVALID('salvage A review evidence identity invalid')
  for (const [offset, frame] of evidence.frames.entries()) {
    const sourceFrame = offset === SALVAGE_A_REVIEW_FRAMES.length
    const expectedIndex = sourceFrame ? 192 : SALVAGE_A_REVIEW_FRAMES[offset]
    const expectedVideo = sourceFrame ? source : derived
    if (frame.kind !== (sourceFrame ? 'paid-source' : 'derived')
      || frame.frameIndex !== expectedIndex
      || frame.videoSha256 !== (sourceFrame ? source.videoSha256 : derived.sha256)
      || !sourceFrame && frame.sourceFrameIndex !== salvageSourceFrame(expectedIndex)
      || await fileSha256(localImage(root, frame.url)) !== frame.sha256
      || sha256(await frameJpeg(localVideo(root, expectedVideo.url ?? expectedVideo.videoUrl), expectedIndex)) !== frame.sha256)
      INVALID(`salvage A review frame ${expectedIndex} changed`)
  }
  if (evidence.frames.at(-2).sha256 !== evidence.frames.at(-1).sha256)
    INVALID('derived A endpoint is not the actual paid source frame192')
  return { evidence, sha256: sha256(bytes) }
}

export function salvageAReviewPrompt(evidence) {
  if (evidence?.version !== 'staged-salvage-review-evidence-v1' || evidence.phase !== 'A')
    INVALID('salvage A review prompt evidence invalid')
  const checks = Object.fromEntries(A_CHECKS.map(name => [name, true]))
  return `你是独立逐帧视觉审核员。这里只能从附件里的真实画面判断，不能把参考图当完成证据。前${SALVAGE_A_REVIEW_FRAMES.length}张是已付费A片的逐帧抽取重定时衍生画面，最后一张是该已付费原生片第192帧；不能称衍生帧为provider-native。重定时从原生193帧抽取181帧，按s(j)=j+floor((j+7)/15)，每16原生帧舍弃1帧，不生成像素。请查开头张飞左侧示意，2.5秒后两军士身前缚严颜双腕、绳圈清晰，7.5秒第180帧两军士已离开双腕且张飞仍站左侧未迈步。检查第81–84、96–99、172–174帧是否有明显跳帧或手腕绳索断裂；第180帧与最后的原生第192帧应同一可见画面。无法从静态帧判断运动顺滑则给uncertain，不要虚构观看体验。原三轨旁白时点0、2.5、9.5秒不变；本阶段只审7.5秒前画面。视频SHA256=${evidence.videoSha256}。附件依次：${evidence.frames.map(frame => `${frame.kind}:${frame.frameIndex}:${frame.sha256}`).join('，')}。只返回JSON：{"version":"staged-salvage-a-review-v1","phase":"A","videoSha256":"${evidence.videoSha256}","decision":"accept|revise|uncertain","checks":${JSON.stringify(checks)},"frameObservations":[{"kind":"derived|paid-source","frameIndex":0,"description":"可见事实"}],"issues":[]}。每张必须有对应观察；任何动作未完成、明显卡顿或不确定都不能accept。`
}

export async function verifySalvageAModelLedger(planId, executionId, root = process.cwd(), query) {
  if (!/^model-run-[\w-]+$/.test(String(executionId))) INVALID('independent model execution ID invalid')
  const { evidence, sha256: nativeEvidenceSha256 } = await readSalvageAReviewEvidence(planId, root)
  const prompt = salvageAReviewPrompt(evidence)
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
  if (row?.channel !== 'workflow' || row?.workflow_id !== 'wf-sanguo-history-drama'
    || row?.node_id !== 'staged-salvage-a-review'
    || row?.capability !== 'text' || row?.provider !== 'Codex' || row?.status !== 'succeeded'
    || row?.id !== executionId || !SHA.test(request?.fingerprint ?? '')
    || !String(request?.requestKey ?? '').startsWith(`staged-salvage:${planId}:A:${evidence.videoSha256}:`)
    || request?.prompt !== prompt || request?.operation !== 'history.media-review'
    || canonical(request?.params?.reviewImages) !== canonical(evidence.reviewImages)
    || request?.reviewImageHashes?.length !== evidence.frames.length)
    INVALID('salvage A independent model ledger is missing or unbound')
  for (const [index, frame] of evidence.frames.entries())
    if (request.reviewImageHashes[index]?.url !== frame.url
      || request.reviewImageHashes[index]?.sha256 !== frame.sha256)
      INVALID(`independent model did not see salvage frame ${frame.frameIndex}`)
  let report
  try { report = parseStructuredJson(extractTextResponse(row.response_data)) }
  catch { INVALID('salvage A independent model response cannot be parsed') }
  if (report?.version !== 'staged-salvage-a-review-v1' || report.phase !== 'A'
    || report.videoSha256 !== evidence.videoSha256 || report.decision !== 'accept'
    || A_CHECKS.some(name => report.checks?.[name] !== true)
    || !Array.isArray(report.issues) || report.issues.length
    || report.frameObservations?.length !== evidence.frames.length
    || report.frameObservations.some((observation, index) =>
      observation.kind !== evidence.frames[index].kind
      || observation.frameIndex !== evidence.frames[index].frameIndex
      || typeof observation.description !== 'string' || observation.description.length < 12))
    INVALID('salvage A independent model did not establish all actions and cadence')
  return { row, report, ledgerSha256: sha256(canonical(row)), nativeEvidenceSha256,
    requestKey: request.requestKey, promptSha256: sha256(prompt) }
}

export async function saveSalvageAManualReview(planId, report, root = process.cwd()) {
  const { evidence, sha256: nativeEvidenceSha256 } = await readSalvageAReviewEvidence(planId, root)
  if (report?.version !== 'staged-salvage-a-direct-review-v1' || report?.planId !== planId
    || report?.phase !== 'A' || report.videoSha256 !== evidence.videoSha256
    || report.nativeEvidenceSha256 !== nativeEvidenceSha256
    || report.reviewMethod !== 'agent-direct-visual' || report.reviewer !== 'Codex'
    || !Number.isFinite(Date.parse(report.reviewedAt)) || report.verdict !== 'accept'
    || A_CHECKS.some(name => report.checks?.[name] !== true)
    || report.observations?.length !== evidence.frames.length
    || report.observations.some((observation, index) =>
      observation.kind !== evidence.frames[index].kind
      || observation.frameIndex !== evidence.frames[index].frameIndex
      || observation.sha256 !== evidence.frames[index].sha256
      || typeof observation.description !== 'string' || observation.description.length < 12)
    || !Array.isArray(report.limitations)
    || typeof report.motionCadenceAssessment !== 'string'
    || report.motionCadenceAssessment.length < 30)
    INVALID('salvage A direct visual review incomplete')
  const value = { ...report, signature: '' }
  value.signature = signature(value, await signingKey(root))
  const filename = path.join(directory(root, planId), 'phase-A-manual-review.json')
  await writeOnce(filename, JSON.stringify(value, null, 2) + '\n')
  return { review: value, sha256: await fileSha256(filename) }
}

export async function readSalvageAManualReview(planId, root = process.cwd()) {
  const filename = path.join(directory(root, planId), 'phase-A-manual-review.json')
  const bytes = await readFile(filename), report = JSON.parse(bytes.toString('utf8'))
  verifySignature(report, await signingKey(root))
  const { evidence, sha256: nativeEvidenceSha256 } = await readSalvageAReviewEvidence(planId, root)
  if (report.planId !== planId || report.videoSha256 !== evidence.videoSha256
    || report.nativeEvidenceSha256 !== nativeEvidenceSha256 || report.verdict !== 'accept'
    || A_CHECKS.some(name => report.checks?.[name] !== true))
    INVALID('salvage A direct visual review changed')
  return { report, sha256: sha256(bytes) }
}

export async function saveSalvageAAcceptance(planId, input, root = process.cwd()) {
  const manifest = await readSalvagePlan(planId, root)
  const rejectionFile = path.join(directory(root, planId), 'phase-A-rejection.json')
  try { await readFile(rejectionFile); INVALID('new salvage plan A was explicitly rejected') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const model = await verifySalvageAModelLedger(planId, input?.executionId, root)
  const manual = await readSalvageAManualReview(planId, root)
  const { evidence, sha256: nativeEvidenceSha256 } = await readSalvageAReviewEvidence(planId, root)
  const derived = manifest.salvage.derivedA, source = manifest.salvage.source
  if (input?.videoSha256 !== derived.sha256 || input?.nativeEvidenceSha256 !== nativeEvidenceSha256
    || input?.ledgerSha256 !== model.ledgerSha256
    || input?.manualReviewSha256 !== manual.sha256
    || A_CHECKS.some(name => model.report.checks[name] !== true
      || manual.report.checks[name] !== true))
    INVALID('salvage A independent/direct acceptance incomplete')
  const last = evidence.frames.find(frame => frame.kind === 'derived' && frame.frameIndex === 180)
  if (!last || last.sha256 !== evidence.frames.at(-1).sha256)
    INVALID('salvage A seam is not paid source f192')
  const acceptedFrameUrl = `/generated/staged-salvage-seam-${derived.sha256.slice(0, 16)}-f180-${last.sha256.slice(0, 16)}.jpg`
  await writeOnce(localImage(root, acceptedFrameUrl), await readFile(localImage(root, last.url)))
  const value = { version: 'staged-salvage-a-acceptance-v1', planId, phase: 'A',
    sourceKind: 'deterministic-derivative-of-rejected-paid-A',
    sourcePlanId: source.parentPlanId, sourceVideoSha256: source.videoSha256,
    sourceRejectionSha256: source.parentRejectionSha256, taskId: source.taskId,
    videoUrl: derived.url, videoSha256: derived.sha256,
    nativeFrameDigestSha256: derived.nativeFrameDigestSha256,
    acceptedFrameIndex: 180, acceptedFrameSha256: last.sha256, acceptedFrameUrl,
    nativeEvidenceSha256,
    review: { verdict: 'accept', manualVerdict: 'accept', executionId: input.executionId,
      ledgerSha256: model.ledgerSha256, requestKey: model.requestKey,
      promptSha256: model.promptSha256, manualReviewSha256: manual.sha256 },
    checks: manual.report.checks, signature: '' }
  value.signature = signature(value, await signingKey(root))
  await writeOnce(path.join(directory(root, planId), 'phase-A-acceptance.json'),
    JSON.stringify(value, null, 2) + '\n')
  return value
}

export async function readSalvageAAcceptance(planId, root = process.cwd()) {
  const manifest = await readSalvagePlan(planId, root)
  const rejectionFile = path.join(directory(root, planId), 'phase-A-rejection.json')
  try { await readFile(rejectionFile); INVALID('new salvage plan A was explicitly rejected') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const filename = path.join(directory(root, planId), 'phase-A-acceptance.json')
  let bytes
  try { bytes = await readFile(filename, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') INVALID('independent and direct salvage A acceptance is required before B'); throw error }
  const acceptance = JSON.parse(bytes)
  verifySignature(acceptance, await signingKey(root))
  const derived = manifest.salvage.derivedA, source = manifest.salvage.source
  if (acceptance.version !== 'staged-salvage-a-acceptance-v1' || acceptance.planId !== planId
    || acceptance.phase !== 'A' || acceptance.sourceKind !== derived.kind
    || acceptance.sourcePlanId !== source.parentPlanId
    || acceptance.sourceVideoSha256 !== source.videoSha256
    || acceptance.sourceRejectionSha256 !== source.parentRejectionSha256
    || acceptance.taskId !== source.taskId || acceptance.videoUrl !== derived.url
    || acceptance.videoSha256 !== derived.sha256
    || acceptance.nativeFrameDigestSha256 !== derived.nativeFrameDigestSha256
    || acceptance.acceptedFrameIndex !== 180
    || acceptance.review?.verdict !== 'accept' || acceptance.review?.manualVerdict !== 'accept'
    || A_CHECKS.some(name => acceptance.checks?.[name] !== true))
    INVALID('salvage A signed acceptance identity invalid')
  const model = await verifySalvageAModelLedger(planId, acceptance.review.executionId, root)
  const manual = await readSalvageAManualReview(planId, root)
  const { evidence, sha256: nativeEvidenceSha256 } = await readSalvageAReviewEvidence(planId, root)
  const last = evidence.frames.find(frame => frame.kind === 'derived' && frame.frameIndex === 180)
  if (acceptance.nativeEvidenceSha256 !== nativeEvidenceSha256
    || acceptance.review.ledgerSha256 !== model.ledgerSha256
    || acceptance.review.requestKey !== model.requestKey
    || acceptance.review.promptSha256 !== model.promptSha256
    || acceptance.review.manualReviewSha256 !== manual.sha256
    || acceptance.acceptedFrameSha256 !== last?.sha256
    || await fileSha256(localImage(root, acceptance.acceptedFrameUrl)) !== last.sha256
    || sha256(await frameJpeg(localVideo(root, derived.url), 180)) !== last.sha256)
    INVALID('salvage A model/direct/native acceptance lineage changed')
  return acceptance
}
