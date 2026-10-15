/** New native A/B review. Neither model success nor frame samples alone accept. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { extractFreshNativeJpeg } from './staged-scene-cut-a8b6-fresh-native.mjs'
import { readFreshA8B6PhaseAPlan, readFreshA8B6Artifact,
  saveFreshA8B6Artifact, saveFreshA8B6Bytes,
  freshA8B6Directory, freshA8B6GeneratedFile } from './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6MediaReceipt, readFreshA8B6PhaseBPlan,
  readFreshA8B6Acceptance } from './staged-scene-cut-a8b6-fresh-phases.mjs'

const SHA = /^[a-f0-9]{64}$/
const invalid = reason => { throw Error(`A8B6_FRESH_REVIEW_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const phaseName = phase => {
  if (phase !== 'A' && phase !== 'B') invalid('phase must be A or B')
  return phase
}
const artifact = (phase, kind) => `phase-${phaseName(phase)}-${kind}.json`
const FORMAT_ERROR = 'REVIEW_IMAGES_INVALID: 审查只接受 /generated/ 下的本地 JPEG 帧'
const RECOVERY_FILES = new Set(['phase-A-review-evidence-v2.json',
  'phase-A-model-review-intent-v2.json', 'phase-A-model-review-submit-v2.json'])

function approvedAReference(A) {
  const entries = A.manifest.compactTransport?.entries ?? []
  const first = entries.filter(entry => entry.role === 'first_frame')
  if (first.length !== 1 || first[0].source?.url
    !== A.manifest.source.approvedFirstFrameUrl
    || first[0].source?.sha256
      !== A.manifest.source.approvedFirstFrameSha256
    || first[0].transport?.format !== 'jpeg'
    || !/^\/generated\/[\w.-]+\.jpe?g$/.test(first[0].transport.url ?? '')
    || !SHA.test(String(first[0].transport.sha256)))
    invalid('signed compact first_frame JPEG is not bound to approved V9 PNG')
  return { kind: 'approved-new-first-frame', phase: 'CERT', frameIndex: -1,
    url: first[0].transport.url, sha256: first[0].transport.sha256,
    sourceOriginal: { url: first[0].source.url,
      sha256: first[0].source.sha256 } }
}

function legacyAReference(A) {
  return { kind: 'approved-new-first-frame', phase: 'CERT', frameIndex: -1,
    url: A.manifest.source.approvedFirstFrameUrl,
    sha256: A.manifest.source.approvedFirstFrameSha256 }
}

export async function verifyFreshA8B6ApprovedReferenceBytes(reference,
  root = process.cwd()) {
  if (reference?.kind !== 'approved-new-first-frame'
    || reference.phase !== 'CERT' || reference.frameIndex !== -1
    || !/^\/generated\/[\w.-]+\.jpe?g$/.test(reference.url ?? '')
    || !/^\/generated\/[\w.-]+\.png$/.test(
      reference.sourceOriginal?.url ?? '')
    || !SHA.test(String(reference.sha256))
    || !SHA.test(String(reference.sourceOriginal?.sha256)))
    invalid('CERT JPEG and original PNG provenance missing')
  const jpeg = await readFile(freshA8B6GeneratedFile(reference.url,
    'image', root))
  const png = await readFile(freshA8B6GeneratedFile(
    reference.sourceOriginal.url, 'image', root))
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8
    || !png.subarray(0, 8).equals(Buffer.from(
      [137, 80, 78, 71, 13, 10, 26, 10]))
    || sha(jpeg) !== reference.sha256
    || sha(png) !== reference.sourceOriginal.sha256)
    invalid('CERT compact JPEG or original V9 PNG bytes changed')
  return true
}

/** Write-once signed recovery files live beside the immutable v1 artifacts. */
export async function saveFreshA8B6ReviewRecoveryArtifact(planId, name,
  body, root = process.cwd()) {
  if (!RECOVERY_FILES.has(name)) invalid('recovery artifact name invalid')
  const secret = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (secret.length !== 32) invalid('staging signing key invalid')
  const value = { ...body, signature: createHmac('sha256', secret)
    .update(canonical(body)).digest('hex') }
  const filename = path.join(freshA8B6Directory(planId, root), name)
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST'
      || !(await readFile(filename)).equals(bytes))
      invalid(`existing recovery artifact differs: ${name}`)
  }
  return { value, sha256: sha(bytes) }
}

export async function readFreshA8B6ReviewRecoveryArtifact(planId, name,
  root = process.cwd()) {
  if (!RECOVERY_FILES.has(name)) invalid('recovery artifact name invalid')
  const bytes = await readFile(path.join(freshA8B6Directory(planId, root), name))
  const value = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = value
  const secret = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (secret.length !== 32 || !SHA.test(String(signature)))
    invalid('recovery artifact signature invalid')
  const expected = createHmac('sha256', secret)
    .update(canonical(body)).digest('hex')
  if (!timingSafeEqual(Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')))
    invalid('recovery artifact signature changed')
  return { value, sha256: sha(bytes) }
}

export function buildFreshA8B6ReviewEvidenceV2(v1, v1Sha256,
  approvedReference) {
  if (v1?.version !== 'staged-a8b6-fresh-native-review-evidence-v1'
    || v1.phase !== 'A' || !SHA.test(String(v1Sha256))
    || v1.frames?.[0]?.kind !== 'approved-new-first-frame'
    || v1.frames[0].phase !== 'CERT'
    || v1.frames[0].frameIndex !== -1
    || v1.frames[0].url !== approvedReference.sourceOriginal?.url
    || v1.frames[0].sha256 !== approvedReference.sourceOriginal?.sha256)
    invalid('v2 recovery requires signed v1 PNG reference')
  const frames = [approvedReference, ...v1.frames.slice(1)]
  return { version: 'staged-a8b6-fresh-native-review-evidence-v2',
    planId: v1.planId, phase: 'A', taskId: v1.taskId,
    videoSha256: v1.videoSha256, mediaSha256: v1.mediaSha256,
    nativeFrameDigestSha256: v1.nativeFrameDigestSha256,
    priorV1EvidenceSha256: v1Sha256, frames,
    reviewImages: frames.map(frame => frame.url) }
}

/** The only permitted recovery is the exact old PNG attachment format error. */
export function assertFreshA8B6JpegReviewRecovery({ intent, intentSha256,
  evidence, evidenceSha256, rows, modelId }) {
  const prefix = `staged-a8b6-fresh:${evidence?.planId}:A:${evidence?.videoSha256}:`
  if (intent?.version !== 'staged-a8b6-fresh-model-review-intent-v1'
    || intent.planId !== evidence?.planId || intent.phase !== 'A'
    || intent.videoSha256 !== evidence.videoSha256
    || intent.evidenceSha256 !== evidenceSha256
    || intent.modelId !== modelId || !SHA.test(String(intentSha256))
    || !SHA.test(String(evidenceSha256))
    || !String(intent.requestKey ?? '').startsWith(prefix)
    || !/^\/generated\/[\w.-]+\.png$/.test(evidence.frames?.[0]?.url ?? '')
    || evidence.reviewImages?.[0] !== evidence.frames[0].url
    || evidence.frames.slice(1).some(frame =>
      !/^\/generated\/[\w.-]+\.jpe?g$/.test(frame.url)))
    invalid('v1 intent is not the signed PNG attachment failure')
  if (!Array.isArray(rows) || rows.length !== 1)
    invalid('recovery requires exactly one prior failed model ledger')
  const row = rows[0], request = row?.request_data
  if (row.id == null || row.channel !== 'workflow'
    || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'staged-a8b6-fresh-phase-review'
    || row.model_id !== modelId || row.capability !== 'text'
    || row.provider !== 'Codex' || row.status !== 'failed'
    || row.error !== FORMAT_ERROR
    || request?.operation !== 'history.media-review'
    || request.requestKey !== intent.requestKey
    || canonical(request.params?.reviewImages)
      !== canonical(evidence.reviewImages)
    || typeof request.prompt !== 'string'
    || !request.prompt.includes(`计划=${evidence.planId}，阶段=A，视频SHA256=${evidence.videoSha256}`)
    || !request.prompt.includes(`CERT:f-1:${evidence.frames[0].sha256}`))
    invalid('failed ledger is not the exact JPEG-only preflight error')
  return { failedModelExecutionId: row.id,
    failedModelLedgerSha256: sha(canonical(row)),
    priorV1IntentSha256: intentSha256,
    priorV1EvidenceSha256: evidenceSha256,
    failure: FORMAT_ERROR }
}

export function freshA8B6RequiredChecks(phase) {
  return phaseName(phase) === 'A'
    ? ['newCertifiedFirstFrameIdentity', 'originalSpeedContinuousBinding',
      'frontWristKnotCompletedByNativeTail', 'guardsReleaseWristByNativeTail',
      'zhangRemainsAtOriginalStation', 'noSpeechOrSpeechMouth',
      'noSceneOrIdentityJump']
    : ['AActualTailToBFirstFrame', 'AActualTailToBStitchedFrame1',
      'guardsContinueWithdrawalWithoutRegrab', 'frontWristKnotRemainsVisible',
      'zhangApproachesAndStopsByNativeFrame120',
      'stableFinalSecond', 'noSpeechOrSpeechMouth',
      'noSceneOrIdentityJump']
}

function sampleIndices(phase, last) {
  const base = phase === 'A'
    ? [0, 24, 48, 60, 96, 120, 144, 168, last - 12, last - 6, last]
    : [0, 1, 6, 12, 24, 36, 48, 60, 84, 108, 120,
      last - 12, last]
  return [...new Set(base.filter(value => Number.isInteger(value)
    && value >= 0 && value <= last))].sort((a, b) => a - b)
}

/** Produces source-labeled JPEGs from archived provider video, write once. */
export async function saveFreshA8B6ReviewEvidence(planId, phase,
  root = process.cwd()) {
  const { media, mediaSha256, native, manifest } = await readFreshA8B6MediaReceipt(
    planId, phase, root)
  const reference = phase === 'A'
    ? approvedAReference({ manifest })
    : await (async () => {
      const B = await readFreshA8B6PhaseBPlan(planId, root)
      return { kind: 'accepted-A-native-tail', phase: 'A',
        frameIndex: B.plan.sourceA.frameIndex,
        url: B.plan.sourceA.firstFrameUrl,
        sha256: B.plan.sourceA.frameSha256,
        sourceVideoSha256: B.plan.sourceA.videoSha256 }
    })()
  const sourceFile = freshA8B6GeneratedFile(media.videoUrl, 'video', root)
  const frames = [reference]
  for (const index of sampleIndices(phase, native.lastFrameIndex)) {
    const frame = await extractFreshNativeJpeg(sourceFile, index)
    const url = `/generated/fresh-a8b6-review-${media.videoSha256.slice(0, 16)}-f${index}-${frame.sha256.slice(0, 16)}.jpg`
    await saveFreshA8B6Bytes(freshA8B6GeneratedFile(url, 'image', root),
      frame.bytes)
    frames.push({ kind: 'provider-native-frame', phase, frameIndex: index,
      url, sha256: frame.sha256, sourceVideoSha256: media.videoSha256 })
  }
  return saveFreshA8B6Artifact(planId, artifact(phase, 'review-evidence'), {
    version: 'staged-a8b6-fresh-native-review-evidence-v1', planId, phase,
    taskId: media.taskId, videoSha256: media.videoSha256, mediaSha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    frames, reviewImages: frames.map(frame => frame.url),
  }, root)
}

export async function readFreshA8B6ReviewEvidence(planId, phase,
  root = process.cwd(), variant = 'v1') {
  if (variant !== 'v1' && variant !== 'v2')
    invalid('review evidence variant invalid')
  if (variant === 'v2') {
    if (phase !== 'A') invalid('JPEG recovery is only available for A')
    const prior = await readFreshA8B6ReviewEvidence(planId, phase, root)
    const A = await readFreshA8B6PhaseAPlan(planId, root)
    const expected = buildFreshA8B6ReviewEvidenceV2(prior.evidence,
      prior.evidenceSha256, approvedAReference(A))
    const { value: evidence, sha256: evidenceSha256 } =
      await readFreshA8B6ReviewRecoveryArtifact(planId,
        'phase-A-review-evidence-v2.json', root)
    if (canonical(evidence) !== canonical({ ...expected,
      signature: evidence.signature }))
      invalid('signed JPEG recovery evidence changed')
    await verifyFreshA8B6ApprovedReferenceBytes(evidence.frames[0], root)
    return { evidence, evidenceSha256, media: prior.media,
      native: prior.native }
  }
  const { media, mediaSha256, native, manifest } = await readFreshA8B6MediaReceipt(
    planId, phase, root)
  const { value: evidence, sha256: evidenceSha256 } =
    await readFreshA8B6Artifact(planId, artifact(phase, 'review-evidence'), root)
  const indices = sampleIndices(phase, native.lastFrameIndex)
  if (evidence.version !== 'staged-a8b6-fresh-native-review-evidence-v1'
    || evidence.planId !== planId || evidence.phase !== phase
    || evidence.taskId !== media.taskId
    || evidence.videoSha256 !== media.videoSha256
    || evidence.mediaSha256 !== mediaSha256
    || evidence.nativeFrameDigestSha256 !== native.frameDigestSha256
    || evidence.frames?.length !== indices.length + 1
    || canonical(evidence.reviewImages)
      !== canonical(evidence.frames.map(frame => frame.url)))
    invalid('signed native review evidence changed')
  const A = { manifest }
  const expectedReference = phase === 'A'
    ? (canonical(evidence.frames[0]) === canonical(legacyAReference(A))
      ? legacyAReference(A) : approvedAReference(A))
    : await (async () => {
      const B = await readFreshA8B6PhaseBPlan(planId, root)
      return { kind: 'accepted-A-native-tail', phase: 'A',
        frameIndex: B.plan.sourceA.frameIndex,
        url: B.plan.sourceA.firstFrameUrl,
        sha256: B.plan.sourceA.frameSha256,
        sourceVideoSha256: B.plan.sourceA.videoSha256 }
    })()
  if (canonical(evidence.frames[0]) !== canonical(expectedReference)
    || sha(await readFile(freshA8B6GeneratedFile(
      expectedReference.url, 'image', root))) !== expectedReference.sha256)
    invalid('review reference is not certified image or accepted native A tail')
  if (phase === 'A' && expectedReference.sourceOriginal)
    await verifyFreshA8B6ApprovedReferenceBytes(expectedReference, root)
  for (const [position, index] of indices.entries()) {
    const frame = evidence.frames[position + 1]
    const nativeFrame = await extractFreshNativeJpeg(
      freshA8B6GeneratedFile(media.videoUrl, 'video', root), index)
    if (frame.kind !== 'provider-native-frame' || frame.phase !== phase
      || frame.frameIndex !== index
      || frame.sourceVideoSha256 !== media.videoSha256
      || frame.sha256 !== nativeFrame.sha256
      || sha(await readFile(freshA8B6GeneratedFile(frame.url,
        'image', root))) !== frame.sha256)
      invalid(`review image is not native frame ${index}`)
  }
  return { evidence, evidenceSha256, media, native, manifest }
}

export async function saveFreshA8B6ReviewEvidenceV2(planId,
  root = process.cwd()) {
  const prior = await readFreshA8B6ReviewEvidence(planId, 'A', root)
  const A = await readFreshA8B6PhaseAPlan(planId, root)
  const reference = approvedAReference(A)
  await verifyFreshA8B6ApprovedReferenceBytes(reference, root)
  const body = buildFreshA8B6ReviewEvidenceV2(prior.evidence,
    prior.evidenceSha256, reference)
  return saveFreshA8B6ReviewRecoveryArtifact(planId,
    'phase-A-review-evidence-v2.json', body, root)
}

export function freshA8B6ReviewPrompt(phase, evidence) {
  if (evidence?.phase !== phase) invalid('review phase/evidence mismatch')
  const checks = Object.fromEntries(freshA8B6RequiredChecks(phase)
    .map(name => [name, false]))
  const rule = phase === 'A'
    ? 'A段是新批准首帧导出的真实8秒原生视频。依次核对张飞原位示意、军士封缺口、严颜身前并腕绕绳拉紧打结、末尾军士双手离腕且结绳持续可见。必须在原生末帧看见两腕并拢及两腕之间完成的前结；若末帧仅有腰部缠绳、分别缠在两侧手臂上的绳或双手仍分开，就不算完成，此时 frontWristKnotCompletedByNativeTail=false 且 decision=revise。A末帧可以是撤手进行中，下一段必须接续，不可把末帧动作当作已有稳定停顿。'
    : 'B段以新A真实验收尾帧为第0帧，拼接去掉B第0帧。从A末帧到B第1帧不能跳人、重抓腕绳或重置动作；张飞约B第120帧之前停止并在末秒稳定，腕结一直可见。'
  return `你是独立原生视频取帧审核员。参考首图不能替代真实动作证据。逐项根据附件把 checks 设为 true 或 false，下面的 false 只是待核对初值；静态帧不足以断言连续性时必须判 uncertain；不能只因提示词写了动作就判通过。${rule}\n计划=${evidence.planId}，阶段=${phase}，视频SHA256=${evidence.videoSha256}，证据SHA256=${evidence.mediaSha256}。附件顺序：${evidence.frames.map(frame => `${frame.phase}:f${frame.frameIndex}:${frame.sha256}`).join('；')}。\n只返回JSON：{"version":"staged-a8b6-fresh-phase-review-v1","phase":"${phase}","videoSha256":"${evidence.videoSha256}","decision":"accept|revise|uncertain","checks":${JSON.stringify(checks)},"observations":[{"phase":"A|B|CERT","frameIndex":0,"description":"可见事实"}],"issues":[]}。`
}

/** Checks the real saved model call, its exact frame list, and accept report. */
export async function verifyFreshA8B6ModelReviewLedger(planId, phase,
  executionId, root = process.cwd(), query, variant = 'v1') {
  if (!/^model-run-[\w-]+$/.test(String(executionId)))
    invalid('independent model execution ID invalid')
  const { evidence, evidenceSha256 } = await readFreshA8B6ReviewEvidence(
    planId, phase, root, variant)
  const prompt = freshA8B6ReviewPrompt(phase, evidence)
  let db
  if (!query) {
    db = new pg.Client({ connectionString: process.env.DATABASE_URL
      ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    await db.connect()
    query = db.query.bind(db)
  }
  let row
  try {
    row = (await query(`SELECT id,channel,workflow_id,node_id,model_id,
      capability,provider,status,request_data,response_data
      FROM model_execution_records WHERE id=$1`, [executionId])).rows[0]
  } finally { if (db) await db.end() }
  const request = row?.request_data
  if (row?.channel !== 'workflow'
    || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'staged-a8b6-fresh-phase-review'
    || row.capability !== 'text' || row.provider !== 'Codex'
    || row.status !== 'succeeded'
    || request?.operation !== 'history.media-review'
    || !String(request.requestKey ?? '').startsWith(
      `staged-a8b6-fresh:${planId}:${phase}:${evidence.videoSha256}:`)
    || request.prompt !== prompt
    || canonical(request.params?.reviewImages)
      !== canonical(evidence.reviewImages)
    || request.reviewImageHashes?.length !== evidence.frames.length)
    invalid('independent model ledger is absent or did not see these native frames')
  for (const [index, frame] of evidence.frames.entries()) {
    if (request.reviewImageHashes[index]?.url !== frame.url
      || request.reviewImageHashes[index]?.sha256 !== frame.sha256)
      invalid(`model review image ${index} differs from native evidence`)
  }
  let report
  try { report = parseStructuredJson(extractTextResponse(row.response_data)) }
  catch { invalid('model review output is not structured JSON') }
  const required = freshA8B6RequiredChecks(phase)
  if (report?.version !== 'staged-a8b6-fresh-phase-review-v1'
    || report.phase !== phase || report.videoSha256 !== evidence.videoSha256
    || report.decision !== 'accept'
    || required.some(name => report.checks?.[name] !== true)
    || !Array.isArray(report.issues) || report.issues.length
    || report.observations?.length !== evidence.frames.length
    || report.observations.some((item, index) =>
      item.phase !== evidence.frames[index].phase
      || item.frameIndex !== evidence.frames[index].frameIndex
      || typeof item.description !== 'string' || item.description.length < 12))
    invalid('independent model review did not accept all required native facts')
  return { row, report, ledgerSha256: sha(canonical(row)),
    evidenceSha256, requestKey: request.requestKey,
    promptSha256: sha(prompt) }
}

/** The direct report is authored separately after real-speed viewing. */
export async function saveFreshA8B6ManualReview(planId, phase,
  report, root = process.cwd()) {
  const { evidence, evidenceSha256 } = await readFreshA8B6ReviewEvidence(
    planId, phase, root)
  const required = freshA8B6RequiredChecks(phase)
  if (report?.version !== 'staged-a8b6-fresh-direct-review-v1'
    || report.planId !== planId || report.phase !== phase
    || report.videoSha256 !== evidence.videoSha256
    || report.evidenceSha256 !== evidenceSha256
    || report.reviewMethod !== 'agent-direct-normal-speed-watch'
    || report.reviewer !== 'Codex'
    || !Number.isFinite(Date.parse(report.reviewedAt))
    || report.verdict !== 'accept'
    || required.some(name => report.checks?.[name] !== true)
    || report.observations?.length !== evidence.frames.length
    || report.observations.some((item, index) =>
      item.phase !== evidence.frames[index].phase
      || item.frameIndex !== evidence.frames[index].frameIndex
      || item.sha256 !== evidence.frames[index].sha256
      || typeof item.description !== 'string' || item.description.length < 12)
    || !Array.isArray(report.limitations)
    || phase === 'B' && report.seamVerdict !== 'accept')
    invalid('direct original-speed visual report incomplete')
  return saveFreshA8B6Artifact(planId, artifact(phase, 'manual-review'),
    report, root)
}

export async function readFreshA8B6ManualReview(planId, phase,
  root = process.cwd()) {
  const { value: report, sha256: reportSha256 } = await readFreshA8B6Artifact(
    planId, artifact(phase, 'manual-review'), root)
  const { evidence, evidenceSha256 } = await readFreshA8B6ReviewEvidence(
    planId, phase, root)
  const required = freshA8B6RequiredChecks(phase)
  if (report.version !== 'staged-a8b6-fresh-direct-review-v1'
    || report.planId !== planId || report.phase !== phase
    || report.videoSha256 !== evidence.videoSha256
    || report.evidenceSha256 !== evidenceSha256
    || report.reviewMethod !== 'agent-direct-normal-speed-watch'
    || report.reviewer !== 'Codex'
    || !Number.isFinite(Date.parse(report.reviewedAt))
    || report.verdict !== 'accept'
    || required.some(name => report.checks?.[name] !== true)
    || report.observations?.length !== evidence.frames.length
    || report.observations.some((item, index) =>
      item.phase !== evidence.frames[index].phase
      || item.frameIndex !== evidence.frames[index].frameIndex
      || item.sha256 !== evidence.frames[index].sha256
      || typeof item.description !== 'string'
      || item.description.length < 12)
    || !Array.isArray(report.limitations)
    || phase === 'B' && report.seamVerdict !== 'accept')
    invalid('signed direct visual report changed')
  return { report, reportSha256, evidenceSha256 }
}

export async function saveFreshA8B6Acceptance(planId, phase,
  { modelExecutionId, reportSha256, acceptedFrameIndex },
  root = process.cwd()) {
  const { media, mediaSha256, native } = await readFreshA8B6MediaReceipt(
    planId, phase, root)
  const { evidenceSha256 } = await readFreshA8B6ReviewEvidence(
    planId, phase, root)
  const model = await verifyFreshA8B6ModelReviewLedger(planId, phase,
    modelExecutionId, root)
  const manual = await readFreshA8B6ManualReview(planId, phase, root)
  if (model.evidenceSha256 !== evidenceSha256
    || manual.evidenceSha256 !== evidenceSha256
    || manual.reportSha256 !== reportSha256
    || !Number.isInteger(acceptedFrameIndex)
    || Math.abs(acceptedFrameIndex / 24 - (phase === 'A' ? 8 : 6))
      > 1 / 24 + 1e-8
    || acceptedFrameIndex !== native.lastFrameIndex)
    invalid('model/direct review or approved source cut is incomplete')
  const accepted = await extractFreshNativeJpeg(
    freshA8B6GeneratedFile(media.videoUrl, 'video', root),
    acceptedFrameIndex)
  let seam
  if (phase === 'B') {
    const A = await readFreshA8B6Acceptance(planId, 'A', root)
    const B = await readFreshA8B6PhaseBPlan(planId, root)
    const zero = await extractFreshNativeJpeg(
      freshA8B6GeneratedFile(media.videoUrl, 'video', root), 0)
    const one = await extractFreshNativeJpeg(
      freshA8B6GeneratedFile(media.videoUrl, 'video', root), 1)
    if (B.plan.sourceA.acceptanceSha256 !== A.acceptanceSha256
      || manual.report.seamVerdict !== 'accept')
      invalid('B did not start from reviewed A native tail')
    seam = { phaseAFrameIndex: A.acceptance.acceptedFrameIndex,
      phaseAFrameSha256: A.acceptance.acceptedFrameSha256,
      phaseBFirstFrameIndex: 0, phaseBFirstFrameSha256: zero.sha256,
      stitchedPhaseBStartFrameIndex: 1,
      stitchedPhaseBFirstFrameSha256: one.sha256,
      directVerdict: manual.report.seamVerdict }
  }
  return saveFreshA8B6Artifact(planId, artifact(phase, 'acceptance'), {
    version: 'staged-a8b6-fresh-native-acceptance-v1', planId, phase,
    taskId: media.taskId, videoSha256: media.videoSha256,
    mediaSha256, nativeFrameDigestSha256: native.frameDigestSha256,
    acceptedFrameIndex, acceptedFrameSha256: accepted.sha256,
    evidenceSha256,
    directReview: { verdict: 'accept', reportSha256,
      reviewerMethod: 'agent-direct-normal-speed-watch',
      audioEvidence: 'provider-sound-off; final-narration-checked-separately' },
    modelReview: { verdict: 'accept', executionId: modelExecutionId,
      ledgerSha256: model.ledgerSha256,
      promptSha256: model.promptSha256, requestKey: model.requestKey },
    ...(seam ? { seam } : {}),
  }, root)
}
