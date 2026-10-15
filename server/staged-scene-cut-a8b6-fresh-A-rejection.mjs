/** Signed rejection of the original paid A take. No provider request here. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from
  '../src/workflow-core.ts'
import { readFreshA8B6PhaseAPlan, freshA8B6Directory,
  freshA8B6GeneratedFile } from './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6MediaReceipt } from
  './staged-scene-cut-a8b6-fresh-phases.mjs'
import { readFreshA8B6ReviewEvidence,
  freshA8B6ReviewPrompt, assertFreshA8B6JpegReviewRecovery,
  readFreshA8B6ReviewRecoveryArtifact } from
  './staged-scene-cut-a8b6-fresh-review.mjs'
import { withV9VerifiedSource } from
  './staged-scene-cut-a8b6-v9-verification-scope.mjs'

export const REJECTED_A_PLAN_ID =
  '2022b73d1894b904985c72e6ab2cfe18584d0f8f6e154ff0175658429ff67660'
export const REJECTED_A_TASK_ID = '934036356547235843'
export const REJECTED_A_VIDEO_SHA256 =
  'd6c216f055c94f2897d84cf207242db0bcbbfd0313972c4b22767904d59f8f13'
const VERSION = 'staged-a8b6-fresh-native-rejection-v1'
const REPORT_VERSION = 'staged-a8b6-fresh-native-frame-rejection-report-v1'
const SHA = /^[a-f0-9]{64}$/
const MODEL_ID = /^model-run-[\w-]+$/
const REPORT_PATH = /^qa\/[\w./-]+\.json$/
const fail = reason => { throw Error(`A8B6_FRESH_A_REJECTION_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const rejectionPath = (planId, root) => path.join(
  freshA8B6Directory(planId, root), 'phase-A-rejection.json')
const relativeReport = filename => {
  if (!REPORT_PATH.test(String(filename)) || filename.includes('..'))
    fail('direct rejection report must be a repository QA JSON file')
  return filename
}

function signingKey(root) {
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('staging signing key invalid')
  return key
}
function signedFile(planId, name, root) {
  const bytes = readFileSync(path.join(freshA8B6Directory(planId, root), name))
  const value = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = value
  const expected = createHmac('sha256', signingKey(root))
    .update(canonical(body)).digest('hex')
  if (!SHA.test(String(signature)) || !timingSafeEqual(
    Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
    fail(`${name} signature changed`)
  return { value, sha256: sha(bytes) }
}

export function assertFreshA8B6PhaseADirectRejection(report, evidence,
  evidenceSha256) {
  const frames = new Map((evidence?.frames ?? []).map(frame =>
    [frame.frameIndex, frame]))
  const observed = new Map((report?.observations ?? []).map(item =>
    [item.frameIndex, item]))
  if (report?.version !== REPORT_VERSION
    || report.planId !== REJECTED_A_PLAN_ID || report.phase !== 'A'
    || report.taskId !== REJECTED_A_TASK_ID
    || report.videoSha256 !== REJECTED_A_VIDEO_SHA256
    || report.evidenceSha256 !== evidenceSha256
    || report.verdict !== 'reject'
    || report.reviewMethod !== 'native-frame-inspection'
    || report.originalSpeedWatchPerformed !== false
    || report.reviewer !== 'Codex'
    || !Number.isFinite(Date.parse(report.reviewedAt))
    || report.failedChecks?.frontWristKnotCompletedByNativeTail !== false
    || evidence.version === 'staged-a8b6-fresh-native-review-evidence-v2'
      && (report.evidenceRebinding?.version !== 'jpeg-v2-format-recovery'
        || report.evidenceRebinding.priorV1EvidenceSha256
          !== evidence.priorV1EvidenceSha256
        || report.evidenceRebinding.certSourcePngSha256
          !== evidence.frames[0].sourceOriginal?.sha256
        || report.evidenceRebinding.certTransportJpegSha256
          !== evidence.frames[0].sha256)
    || !Array.isArray(report.limitations)
    || !Array.isArray(report.observations)
    || report.observations.length !== 2
    || observed.size !== 2
    || [144, 192].some(index => {
      const frame = frames.get(index), item = observed.get(index)
      return frame?.kind !== 'provider-native-frame'
        || frame.phase !== 'A' || item?.phase !== 'A'
        || item.sha256 !== frame.sha256
        || typeof item.description !== 'string'
        || item.description.trim().length < 12
    })) fail('n144/n192 native-frame rejection evidence incomplete')
  return true
}

export function assertFreshA8B6PhaseANegativeModelLedger(row,
  evidence, evidenceSha256) {
  const request = row?.request_data
  if (!MODEL_ID.test(String(row?.id))
    || row.channel !== 'workflow'
    || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'staged-a8b6-fresh-phase-review'
    || row.capability !== 'text' || row.provider !== 'Codex'
    || row.status !== 'succeeded'
    || request?.operation !== 'history.media-review'
    || !String(request.requestKey ?? '').startsWith(
      `staged-a8b6-fresh:${REJECTED_A_PLAN_ID}:A:${REJECTED_A_VIDEO_SHA256}:`)
    || request.prompt !== freshA8B6ReviewPrompt('A', evidence)
    || !isDeepStrictEqual(request.params?.reviewImages, evidence.reviewImages)
    || request.reviewImageHashes?.length !== evidence.frames.length
    || evidence.phase !== 'A' || evidence.planId !== REJECTED_A_PLAN_ID
    || evidence.videoSha256 !== REJECTED_A_VIDEO_SHA256
    || !SHA.test(String(evidenceSha256)))
    fail('independent A model ledger did not review this native evidence')
  for (const [index, frame] of evidence.frames.entries()) {
    if (request.reviewImageHashes[index]?.url !== frame.url
      || request.reviewImageHashes[index]?.sha256 !== frame.sha256)
      fail(`model attachment ${index} differs from archived native frame`)
  }
  let report
  try { report = parseStructuredJson(extractTextResponse(row.response_data)) }
  catch { fail('independent model response is not structured JSON') }
  if (report?.version !== 'staged-a8b6-fresh-phase-review-v1'
    || report.phase !== 'A'
    || report.videoSha256 !== REJECTED_A_VIDEO_SHA256
    || !['revise', 'uncertain'].includes(report.decision)
    || report.checks?.frontWristKnotCompletedByNativeTail !== false
    || !Array.isArray(report.issues) || report.issues.length < 1)
    fail('independent model did not reject the unfinished front wrist knot')
  return { executionId: row.id, requestKey: request.requestKey,
    decision: report.decision, failedCheck: false,
    report, reportSha256: sha(canonical(report)),
    ledgerSha256: sha(canonical(row)),
    promptSha256: sha(request.prompt) }
}

/** A v2 negative result must descend from the sole failed PNG preflight. */
export function assertFreshA8B6PhaseARejectionRecovery({ priorEvidence,
  priorEvidenceSha256, priorIntent, priorIntentSha256,
  recoveredEvidence, recoveredEvidenceSha256,
  recoveredIntent, recoveredIntentSha256, submit, submitSha256,
  modelRow, rows }) {
  if (!Array.isArray(rows) || rows.length !== 2
    || rows.filter(row => row.id === modelRow?.id).length !== 1
    || modelRow.status !== 'succeeded'
    || recoveredEvidence?.version
      !== 'staged-a8b6-fresh-native-review-evidence-v2'
    || recoveredEvidence.priorV1EvidenceSha256 !== priorEvidenceSha256
    || recoveredIntent?.version
      !== 'staged-a8b6-fresh-model-review-intent-v2'
    || recoveredIntent.planId !== REJECTED_A_PLAN_ID
    || recoveredIntent.phase !== 'A'
    || recoveredIntent.videoSha256 !== REJECTED_A_VIDEO_SHA256
    || recoveredIntent.evidenceSha256 !== recoveredEvidenceSha256
    || recoveredIntent.modelId !== modelRow.model_id
    || recoveredIntent.requestKey !== modelRow.request_data?.requestKey
    || !String(recoveredIntent.requestKey).includes(':jpeg-v2:')
    || !SHA.test(String(recoveredIntentSha256))
    || submit?.version !== 'staged-a8b6-fresh-model-review-submit-v2'
    || submit.planId !== REJECTED_A_PLAN_ID
    || submit.requestKey !== recoveredIntent.requestKey
    || submit.intentSha256 !== recoveredIntentSha256
    || !SHA.test(String(submitSha256))
    || !Number.isFinite(Date.parse(recoveredIntent.createdAt))
    || !Number.isFinite(Date.parse(submit.createdAt)))
    fail('JPEG v2 model review lacks signed intent or one-shot submission')
  const legacy = rows.filter(row => row.id !== modelRow.id)
  const priorFailure = assertFreshA8B6JpegReviewRecovery({
    intent: priorIntent, intentSha256: priorIntentSha256,
    evidence: priorEvidence, evidenceSha256: priorEvidenceSha256,
    rows: legacy, modelId: modelRow.model_id })
  if (!isDeepStrictEqual(recoveredIntent.priorFailure, priorFailure))
    fail('JPEG v2 intent lost exact failed-ledger ancestry')
  return { intentSha256: recoveredIntentSha256,
    submitSha256, priorFailure }
}

/** Reads persisted provider, native-frame, direct and model evidence. */
export async function prepareFreshA8B6PhaseARejection({ planId,
  reportFile, modelExecutionId }, root = process.cwd(), query) {
  if (planId !== REJECTED_A_PLAN_ID
    || !MODEL_ID.test(String(modelExecutionId)))
    fail('old A plan and independent model execution required')
  relativeReport(reportFile)
  return withV9VerifiedSource(root, () => preparePhaseARejectionVerified({
    planId, reportFile, modelExecutionId }, root, query))
}

async function preparePhaseARejectionVerified({ planId,
  reportFile, modelExecutionId }, root, query) {
  const reportPath = reportFile
  const { media, mediaSha256, native } = await readFreshA8B6MediaReceipt(
    planId, 'A', root)
  const { manifestSha256 } = await readFreshA8B6PhaseAPlan(planId, root)
  if (media.taskId !== REJECTED_A_TASK_ID
    || media.videoSha256 !== REJECTED_A_VIDEO_SHA256
    || media.nativeFrameCount !== 193
    || media.nativeLastFrameIndex !== 192
    || Math.abs(media.nativeLastPts - 8) > 1e-8
    || native.frameDigestSha256 !== media.nativeFrameDigestSha256
    || existsSync(path.join(freshA8B6Directory(planId, root),
      'phase-A-acceptance.json')))
    fail('old A media identity, duration or rejection boundary changed')
  const reportBytes = await readFile(path.join(root, reportPath))
  const report = JSON.parse(reportBytes.toString('utf8'))
  let db
  if (!query) {
    db = new pg.Client({ connectionString: process.env.DATABASE_URL
      ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    await db.connect()
    query = db.query.bind(db)
  }
  let row, reviewRows
  try {
    row = (await query(`SELECT id,channel,workflow_id,node_id,model_id,
      capability,provider,status,error,request_data,response_data
      FROM model_execution_records WHERE id=$1`, [modelExecutionId])).rows[0]
    if (String(row?.request_data?.requestKey ?? '').includes(':jpeg-v2:')) {
      reviewRows = (await query(`SELECT id,channel,workflow_id,node_id,
        model_id,capability,provider,status,error,request_data,response_data
        FROM model_execution_records
        WHERE request_data->>'requestKey' LIKE $1
        ORDER BY created_at`,
      [`staged-a8b6-fresh:${planId}:A:${media.videoSha256}:%`])).rows
    }
  } finally { if (db) await db.end() }
  const reviewEvidenceVariant = String(row?.request_data?.requestKey ?? '')
    .includes(':jpeg-v2:') ? 'v2' : 'v1'
  const { evidence, evidenceSha256 } = await readFreshA8B6ReviewEvidence(
    planId, 'A', root, reviewEvidenceVariant)
  assertFreshA8B6PhaseADirectRejection(report, evidence, evidenceSha256)
  const model = assertFreshA8B6PhaseANegativeModelLedger(row,
    evidence, evidenceSha256)
  let reviewRecovery
  if (reviewEvidenceVariant === 'v2') {
    const prior = await readFreshA8B6ReviewEvidence(planId, 'A', root)
    const priorIntentBytes = await readFile(path.join(
      freshA8B6Directory(planId, root), 'phase-A-model-review-intent.json'))
    const signedIntent = await readFreshA8B6ReviewRecoveryArtifact(planId,
      'phase-A-model-review-intent-v2.json', root)
    const signedSubmit = await readFreshA8B6ReviewRecoveryArtifact(planId,
      'phase-A-model-review-submit-v2.json', root)
    reviewRecovery = assertFreshA8B6PhaseARejectionRecovery({
      priorEvidence: prior.evidence,
      priorEvidenceSha256: prior.evidenceSha256,
      priorIntent: JSON.parse(priorIntentBytes.toString('utf8')),
      priorIntentSha256: sha(priorIntentBytes),
      recoveredEvidence: evidence,
      recoveredEvidenceSha256: evidenceSha256,
      recoveredIntent: signedIntent.value,
      recoveredIntentSha256: signedIntent.sha256,
      submit: signedSubmit.value, submitSha256: signedSubmit.sha256,
      modelRow: row, rows: reviewRows })
  }
  const reportSha256 = sha(reportBytes)
  const body = { version: VERSION, planId, phase: 'A',
    taskId: media.taskId, videoUrl: media.videoUrl,
    videoSha256: media.videoSha256, mediaSha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    nativeFrameCount: native.frameCount,
    nativeLastFrameIndex: native.lastFrameIndex,
    nativeLastPts: native.lastPts,
    planManifestSha256: manifestSha256,
    evidenceSha256, reviewEvidenceVariant,
    ...(reviewEvidenceVariant === 'v2'
      ? { priorV1EvidenceSha256: evidence.priorV1EvidenceSha256,
        reviewRecovery } : {}),
    reportFile: reportPath, reportSha256,
    directReview: { verdict: 'reject', method: 'native-frame-inspection',
      originalSpeedWatchPerformed: false, reportSha256,
      frameIndices: [144, 192] },
    modelReview: { executionId: model.executionId,
      requestKey: model.requestKey, decision: model.decision,
      report: model.report, reportSha256: model.reportSha256,
      ledgerSha256: model.ledgerSha256,
      promptSha256: model.promptSha256 },
    failedChecks: { frontWristKnotCompletedByNativeTail: false },
    acceptanceState: 'rejected-native-A; no A tail may seed B' }
  return { body, reportSha256, evidenceSha256,
    modelLedgerSha256: model.ledgerSha256 }
}

export async function saveFreshA8B6PhaseARejection(input,
  expected, root = process.cwd()) {
  const prepared = await prepareFreshA8B6PhaseARejection(input, root)
  if (prepared?.body?.version !== VERSION
    || expected?.reportSha256 !== prepared.reportSha256
    || expected.evidenceSha256 !== prepared.evidenceSha256
    || expected.modelLedgerSha256 !== prepared.modelLedgerSha256
    || expected.videoSha256 !== REJECTED_A_VIDEO_SHA256)
    fail('rejection preview hashes changed before signing')
  const planId = prepared.body.planId
  const body = { ...prepared.body }
  const signature = createHmac('sha256', signingKey(root))
    .update(canonical(body)).digest('hex')
  const bytes = Buffer.from(JSON.stringify({ ...body, signature }, null, 2) + '\n')
  const filename = rejectionPath(planId, root)
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST'
      || !(await readFile(filename)).equals(bytes))
      fail('existing A rejection certificate differs')
  }
  return verifyFreshA8B6PhaseARejectionSync(planId, root)
}

/** Fast signed gate for retake ancestry; issuance checks the live model DB. */
export function verifyFreshA8B6PhaseARejectionSync(planId,
  root = process.cwd()) {
  if (planId !== REJECTED_A_PLAN_ID)
    fail('rejection does not belong to the original A plan')
  const { value: rejection, sha256: rejectionSha256 } = signedFile(
    planId, 'phase-A-rejection.json', root)
  const manifest = signedFile(planId, 'manifest.json', root)
  const task = signedFile(planId, 'phase-A-task.json', root)
  const media = signedFile(planId, 'phase-A-media.json', root)
  const reviewEvidenceVariant = rejection.reviewEvidenceVariant ?? 'v1'
  if (!['v1', 'v2'].includes(reviewEvidenceVariant))
    fail('signed A rejection evidence variant invalid')
  const evidence = signedFile(planId,
    reviewEvidenceVariant === 'v2' ? 'phase-A-review-evidence-v2.json'
      : 'phase-A-review-evidence.json', root)
  const priorV1Evidence = reviewEvidenceVariant === 'v2'
    ? signedFile(planId, 'phase-A-review-evidence.json', root) : null
  const recoveryIntent = reviewEvidenceVariant === 'v2'
    ? signedFile(planId, 'phase-A-model-review-intent-v2.json', root) : null
  const recoverySubmit = reviewEvidenceVariant === 'v2'
    ? signedFile(planId, 'phase-A-model-review-submit-v2.json', root) : null
  const priorIntentBytes = reviewEvidenceVariant === 'v2'
    ? readFileSync(path.join(freshA8B6Directory(planId, root),
      'phase-A-model-review-intent.json')) : null
  const priorIntent = priorIntentBytes
    ? JSON.parse(priorIntentBytes.toString('utf8')) : null
  const video = media.value.videoUrl
  const reportPath = relativeReport(rejection.reportFile)
  const reportBytes = readFileSync(path.join(root, reportPath))
  const report = JSON.parse(reportBytes.toString('utf8'))
  if (rejection.version !== VERSION || rejection.planId !== planId
    || rejection.phase !== 'A'
    || rejection.taskId !== REJECTED_A_TASK_ID
    || rejection.videoSha256 !== REJECTED_A_VIDEO_SHA256
    || rejection.videoUrl !== video
    || rejection.planManifestSha256 !== manifest.sha256
    || manifest.value.planId !== planId
    || task.value.taskId !== rejection.taskId
    || task.sha256 !== media.value.taskSha256
    || media.value.taskId !== rejection.taskId
    || media.value.videoSha256 !== rejection.videoSha256
    || media.sha256 !== rejection.mediaSha256
    || media.value.nativeFrameDigestSha256
      !== rejection.nativeFrameDigestSha256
    || media.value.nativeFrameCount !== 193
    || media.value.nativeLastFrameIndex !== 192
    || Math.abs(media.value.nativeLastPts - 8) > 1e-8
    || rejection.nativeFrameCount !== 193
    || rejection.nativeLastFrameIndex !== 192
    || Math.abs(rejection.nativeLastPts - 8) > 1e-8
    || evidence.sha256 !== rejection.evidenceSha256
    || evidence.value.taskId !== rejection.taskId
    || evidence.value.videoSha256 !== rejection.videoSha256
    || evidence.value.mediaSha256 !== rejection.mediaSha256
    || evidence.value.nativeFrameDigestSha256
      !== rejection.nativeFrameDigestSha256
    || reviewEvidenceVariant === 'v2' && (
      evidence.value.version !== 'staged-a8b6-fresh-native-review-evidence-v2'
      || priorV1Evidence.sha256 !== rejection.priorV1EvidenceSha256
      || evidence.value.priorV1EvidenceSha256
        !== rejection.priorV1EvidenceSha256
      || priorV1Evidence.value.frames?.[0]?.url
        !== manifest.value.source?.approvedFirstFrameUrl
      || priorV1Evidence.value.frames?.[0]?.sha256
        !== manifest.value.source?.approvedFirstFrameSha256
      || evidence.value.frames?.[0]?.url
        !== manifest.value.compactTransport?.entries?.[0]?.transport?.url
      || evidence.value.frames?.[0]?.sha256
        !== manifest.value.compactTransport?.entries?.[0]?.transport?.sha256
      || evidence.value.frames?.[0]?.sourceOriginal?.url
        !== manifest.value.source?.approvedFirstFrameUrl
      || evidence.value.frames?.[0]?.sourceOriginal?.sha256
        !== manifest.value.source?.approvedFirstFrameSha256
      || recoveryIntent.value.version
        !== 'staged-a8b6-fresh-model-review-intent-v2'
      || recoveryIntent.value.planId !== planId
      || recoveryIntent.value.phase !== 'A'
      || recoveryIntent.value.videoSha256 !== rejection.videoSha256
      || recoveryIntent.value.evidenceSha256 !== evidence.sha256
      || recoveryIntent.value.requestKey
        !== rejection.modelReview?.requestKey
      || !String(recoveryIntent.value.requestKey).includes(':jpeg-v2:')
      || !Number.isFinite(Date.parse(recoveryIntent.value.createdAt))
      || recoverySubmit.value.version
        !== 'staged-a8b6-fresh-model-review-submit-v2'
      || recoverySubmit.value.planId !== planId
      || recoverySubmit.value.requestKey
        !== recoveryIntent.value.requestKey
      || recoverySubmit.value.intentSha256 !== recoveryIntent.sha256
      || !Number.isFinite(Date.parse(recoverySubmit.value.createdAt))
      || priorIntent.version
        !== 'staged-a8b6-fresh-model-review-intent-v1'
      || priorIntent.planId !== planId || priorIntent.phase !== 'A'
      || priorIntent.videoSha256 !== rejection.videoSha256
      || priorIntent.evidenceSha256 !== priorV1Evidence.sha256
      || priorIntent.modelId !== recoveryIntent.value.modelId
      || !String(priorIntent.requestKey ?? '').startsWith(
        `staged-a8b6-fresh:${planId}:A:${rejection.videoSha256}:`)
      || recoveryIntent.value.priorFailure?.priorV1IntentSha256
        !== sha(priorIntentBytes)
      || recoveryIntent.value.priorFailure?.priorV1EvidenceSha256
        !== priorV1Evidence.sha256
      || !MODEL_ID.test(String(recoveryIntent.value.priorFailure
        ?.failedModelExecutionId))
      || !SHA.test(String(recoveryIntent.value.priorFailure
        ?.failedModelLedgerSha256))
      || recoveryIntent.value.priorFailure?.failure
        !== 'REVIEW_IMAGES_INVALID: 审查只接受 /generated/ 下的本地 JPEG 帧'
      || canonical(rejection.reviewRecovery) !== canonical({
        intentSha256: recoveryIntent.sha256,
        submitSha256: recoverySubmit.sha256,
        priorFailure: recoveryIntent.value.priorFailure }))
    || sha(reportBytes) !== rejection.reportSha256
    || rejection.directReview?.verdict !== 'reject'
    || rejection.directReview.method !== 'native-frame-inspection'
    || rejection.directReview.originalSpeedWatchPerformed !== false
    || rejection.directReview.reportSha256 !== rejection.reportSha256
    || !isDeepStrictEqual(rejection.directReview.frameIndices, [144, 192])
    || rejection.failedChecks?.frontWristKnotCompletedByNativeTail !== false
    || rejection.modelReview?.reportSha256
      !== sha(canonical(rejection.modelReview.report))
    || !MODEL_ID.test(String(rejection.modelReview.executionId))
    || !SHA.test(String(rejection.modelReview.ledgerSha256))
    || !SHA.test(String(rejection.modelReview.promptSha256))
    || !String(rejection.modelReview.requestKey).startsWith(
      `staged-a8b6-fresh:${planId}:A:${rejection.videoSha256}:`)
    || reviewEvidenceVariant === 'v2'
      && !rejection.modelReview.requestKey.includes(':jpeg-v2:')
    || !['revise', 'uncertain'].includes(rejection.modelReview.decision)
    || rejection.modelReview.report?.checks
      ?.frontWristKnotCompletedByNativeTail !== false
    || rejection.modelReview.report?.decision
      !== rejection.modelReview.decision
    || rejection.acceptanceState
      !== 'rejected-native-A; no A tail may seed B'
    || existsSync(path.join(freshA8B6Directory(planId, root),
      'phase-A-acceptance.json')))
    fail('signed A rejection lost its plan, media or independent audit')
  if (!/^\/generated\/[\w.-]+\.mp4$/.test(video)
    || sha(readFileSync(freshA8B6GeneratedFile(video, 'video', root)))
      !== rejection.videoSha256)
    fail('rejected paid video bytes changed')
  if (reviewEvidenceVariant === 'v2') {
    const reference = evidence.value.frames[0]
    if (!/^\/generated\/[\w.-]+\.jpe?g$/.test(reference.url)
      || sha(readFileSync(freshA8B6GeneratedFile(reference.url,
        'image', root))) !== reference.sha256
      || sha(readFileSync(freshA8B6GeneratedFile(
        reference.sourceOriginal.url, 'image', root)))
        !== reference.sourceOriginal.sha256)
      fail('recovered CERT JPEG or original V9 PNG bytes changed')
  }
  assertFreshA8B6PhaseADirectRejection(report, evidence.value,
    evidence.sha256)
  for (const index of [144, 192]) {
    const frame = evidence.value.frames.find(item => item.phase === 'A'
      && item.frameIndex === index)
    if (!frame || !/^\/generated\/[\w.-]+\.jpg$/.test(frame.url)
      || sha(readFileSync(freshA8B6GeneratedFile(frame.url, 'image', root)))
        !== frame.sha256)
      fail(`native evidence frame ${index} changed`)
  }
  return { rejection, rejectionSha256 }
}

/** Optional deep read: repeat the live DB/model and native-frame checks. */
export async function verifyFreshA8B6PhaseARejection(planId,
  root = process.cwd(), query) {
  const signed = verifyFreshA8B6PhaseARejectionSync(planId, root)
  const prepared = await prepareFreshA8B6PhaseARejection({ planId,
    reportFile: signed.rejection.reportFile,
    modelExecutionId: signed.rejection.modelReview.executionId }, root, query)
  const { signature: _signature, ...body } = signed.rejection
  void _signature
  if (canonical(body) !== canonical(prepared.body))
    fail('signed A rejection differs from live model and native evidence')
  return signed
}
