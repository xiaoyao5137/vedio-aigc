/** Signed 14s script and V8 first-frame approval, tied to the A request plan. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { A8B6_FRESH_V8_EDIT_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { resolveKlingOmniVideoEndpoint } from './model-adapters.ts'
import { verifySceneCutFrameApproval } from './scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { verifyA8B6FrameConflictReceipt } from
  './staged-scene-cut-a8b6-frame-conflict.mjs'
import { A8B6_FRESH_PREFLIGHT_SOURCE_IDS, readA8B6HistoricQaManifest,
  prepareA8B6FreshRegenerationPreflight } from
  './staged-scene-cut-a8b6-fresh-preflight.mjs'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID } from
  './staged-scene-cut-a8b6-v7-dual-output.mjs'
import { A8B6_V7_REJECTED_MD5,
  verifyA8B6FreshV8EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { prepareA8B6FreshApprovedImageCandidate } from
  './staged-scene-cut-a8b6-approved-image-candidate.mjs'
import { planFreshA8B6PhaseA } from './staged-scene-cut-a8b6-fresh-ledger.mjs'

const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/
const fail = reason => { throw Error(`A8B6_FRESH_APPROVAL_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const directory = (root, planId) => {
  if (!SHA.test(String(planId))) fail('plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b6-fresh-approval', planId)
}
const generatedImage = (root, url) => {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.png$/.test(url))
    fail('approved image URL invalid')
  return path.join(root, 'public', url.slice(1))
}

/** Local signature, frozen image bytes and first-frame certificate. The async
 * verifier additionally proves the actual DB/model ledger and A request. */
export function verifyA8B6FreshWorkflowApprovalSync(planId,
  root = process.cwd()) {
  const bytes = readFileSync(path.join(directory(root, planId), 'approval.json'))
  const approval = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('staging signing key invalid')
  const { signature, ...body } = approval
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  const edit = verifyA8B6FreshV8EditReceiptSync(root)
  const certificate = verifySceneCutFrameApproval(approval.frameCertificate, root)
  if (!SHA.test(String(signature)) || !timingSafeEqual(
    Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || approval.version !== 'scene-cut-a8b6-fresh-workflow-approval-v6'
    || approval.planId !== planId
    || approval.approvalState !== 'approved-new-first-frame-before-A-request'
    || approval.timingExecutionId !== A8B6_FRESH_FRAME_PARENT_ID
    || approval.timingResultMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || approval.approvalExecutionId !== A8B6_FRESH_V8_EDIT_FRAME_ID
    || approval.imagePaymentExecutionId !== A8B6_FRESH_V8_EDIT_FRAME_ID
    || approval.imagePaymentResultMd5 !== approval.approvalResultMd5
    || !MD5.test(String(approval.approvalResultMd5))
    || approval.priorFreshReviewExecutionId !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || approval.priorFreshReviewResultMd5 !== A8B6_V7_REJECTED_MD5
    || approval.editReceiptSha256 !== edit.receiptSha256
    || approval.v8EditReceiptSha256 !== edit.receiptSha256
    || approval.v8SourceSelectionClarificationSha256
      !== edit.receipt.sourceSelectionClarificationSha256
    || approval.maskedLayoutSourceSha256
      !== edit.receipt.referenceOrder?.[2]?.sourceSha256
    || approval.maskedLayoutTransportSha256
      !== edit.receipt.referenceOrder?.[2]?.jpegSha256
    || approval.rejectedLayoutImageSha256
      !== edit.receipt.referenceOrder?.[2]?.sourceSha256
    || approval.rejectedLayoutTransportSha256
      !== edit.receipt.referenceOrder?.[2]?.jpegSha256
    || approval.v4FaceHelperSourceSha256
      !== edit.receipt.referenceOrder?.[3]?.sourceSha256
    || approval.v4FaceHelperTransportSha256
      !== edit.receipt.referenceOrder?.[3]?.jpegSha256
    || approval.frozenFaceCropSourceSha256
      !== edit.receipt.referenceOrder?.[4]?.sourceSha256
    || approval.frozenFaceCropJpegSha256
      !== edit.receipt.referenceOrder?.[4]?.jpegSha256
    || canonical(approval.frozenFaceCropBox)
      !== canonical(edit.receipt.referenceOrder?.[4]?.crop)
    || approval.workflowSchemaVersion !== 180
    || approval.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || approval.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || !SHA.test(String(approval.phaseARequestSha256))
    || !SHA.test(String(approval.approvedShotSha256))
    || !SHA.test(String(approval.approvedFirstFrameSha256))
    || !SHA.test(String(approval.sceneCutFrameCertificateSha256))
    || !SHA.test(String(approval.freshFrameMarkerSha256))
    || !SHA.test(String(approval.conflictReceiptSha256))
    || !/^model-run-[\w-]+$/.test(String(approval.storyboardReviewExecutionId))
    || !/^model-run-[\w-]+$/.test(String(approval.imageModelExecutionId))
    || !/^model-run-[\w-]+$/.test(String(approval.frameReviewExecutionId))
    || certificate.passed !== true
    || certificate.repairBinding !== undefined
    || certificate.shotSha256 !== approval.approvedShotSha256
    || certificate.frame?.sourceUrl !== approval.approvedFirstFrameUrl
    || certificate.sourceSha256s?.[0] !== approval.approvedFirstFrameSha256
    || approval.approvedFirstFrameSha256
      === edit.receipt.referenceOrder?.[2]?.sourceSha256
    || certificate.reviewExecutionId !== approval.frameReviewExecutionId
    || sceneCutRebindSha256(certificate)
      !== approval.sceneCutFrameCertificateSha256
    || sha(readFileSync(generatedImage(root, approval.approvedFirstFrameUrl)))
      !== approval.approvedFirstFrameSha256)
    fail('signed approval, approved image or frame certificate changed')
  return { approval, approvalSha256: sha(bytes) }
}

/** Reconstruct the exact candidate and unsigned A request after real node50. */
export async function prepareA8B6FreshWorkflowApproval(planId,
  root = process.cwd()) {
  if (!SHA.test(String(planId))) fail('plan ID invalid')
  const candidate = await prepareA8B6FreshApprovedImageCandidate(root)
  const edit = verifyA8B6FreshV8EditReceiptSync(root)
  const ids = A8B6_FRESH_PREFLIGHT_SOURCE_IDS
  const qa = readA8B6HistoricQaManifest(root)
  const conflict = await verifyA8B6FrameConflictReceipt(ids.QA_PLAN_ID, root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const rowIds = [ids.SOURCE_ID, ids.REJECTED_ID, ids.RETRY_ID]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records WHERE id=ANY($1)`,
    [rowIds])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const workflow = (await db.query(`SELECT id,schema_version,nodes,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    const retryLedgerRows = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-review' AND status='succeeded'
        AND request_data->>'requestKey' LIKE $1
      ORDER BY created_at DESC LIMIT 20`, [`${ids.RETRY_ID}:%`])).rows
    if (rows.length !== rowIds.length
      || candidate.timingRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5)
      fail('original source or approved 14s timing changed')
    const preflight = prepareA8B6FreshRegenerationPreflight({
      sourceRow: byId.get(ids.SOURCE_ID),
      timingRow: candidate.timingRow,
      rejectedRow: byId.get(ids.REJECTED_ID),
      retryRow: byId.get(ids.RETRY_ID),
      workflowRow: workflow, qa, conflict,
      ledgerRows: retryLedgerRows, root })
    const timing = decodeExecutionState(candidate.timingRow.result)
    const runs = timing.nodeRuns
    const scriptLedgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-shot-script-review' AND status='succeeded'
        AND request_data->>'requestKey' LIKE $1
      ORDER BY created_at DESC LIMIT 20`, [`${ids.TIMING_ID}:%`])).rows
    const output = runs[10].output
    const submitted = Object.fromEntries(Object.entries(output)
      .filter(([key]) => !['text', 'raw', 'model', 'reviewTransport'].includes(key)))
    const script = scriptLedgers.find(row => row.provider !== 'Local'
      && row.capability === 'text' && row.model_id === output.model
      && SHA.test(String(row.request_data?.fingerprint))
      && isDeepStrictEqual(row.request_data?.params?.candidate, runs[9].output)
      && isDeepStrictEqual(row.response_data, output.raw)
      && isDeepStrictEqual(parseStructuredJson(extractTextResponse(
        row.response_data)), submitted))
    if (!script) fail('14s script decision lacks its exact model ledger')
    const videoNode = workflow.nodes?.find(node => node.id === 'sanguo-video')
    const model = videoNode && (await db.query(`SELECT id,provider,capability,settings
      FROM model_configs WHERE id=$1`, [videoNode.modelId])).rows[0]
    if (model?.id !== 'keling3' || model.provider !== 'Kling'
      || model.capability !== 'video' || !model.settings?.endpoint)
      fail('configured video provider changed')
    const providerLock = { modelId: model.id,
      endpointSha256: sha(resolveKlingOmniVideoEndpoint(model.settings.endpoint)) }
    const plan = await planFreshA8B6PhaseA(preflight, candidate,
      providerLock, root)
    if (plan.planId !== planId) fail('new A request changed after review')
    const body = { version: 'scene-cut-a8b6-fresh-workflow-approval-v6',
      planId, approvalState: 'approved-new-first-frame-before-A-request',
      sourceExecutionId: ids.SOURCE_ID,
      sourceResultMd5: byId.get(ids.SOURCE_ID).result_md5,
      timingExecutionId: ids.TIMING_ID,
      timingResultMd5: candidate.timingRow.result_md5,
      approvalExecutionId: candidate.sourceRow.id,
      approvalResultMd5: candidate.sourceRow.result_md5,
      imagePaymentExecutionId: candidate.imagePaymentExecutionId,
      imagePaymentResultMd5: candidate.sourceRow.result_md5,
      priorFreshReviewExecutionId: A8B6_V7_DUAL_OUTPUT_CHILD_ID,
      priorFreshReviewResultMd5: A8B6_V7_REJECTED_MD5,
      conflictReceiptSha256: conflict.receiptSha256,
      editReceiptSha256: candidate.editReceiptSha256,
      v8EditReceiptSha256: candidate.v8EditReceiptSha256,
      v8SourceSelectionClarificationSha256:
        edit.receipt.sourceSelectionClarificationSha256,
      maskedLayoutSourceSha256: candidate.maskedLayoutSourceSha256,
      maskedLayoutTransportSha256: candidate.maskedLayoutTransportSha256,
      rejectedLayoutImageSha256: candidate.rejectedLayoutImageSha256,
      rejectedLayoutTransportSha256: candidate.rejectedLayoutTransportSha256,
      v4FaceHelperSourceSha256: candidate.v4FaceHelperSourceSha256,
      v4FaceHelperTransportSha256: candidate.v4FaceHelperTransportSha256,
      frozenFaceCropSourceSha256: candidate.frozenFaceCropSourceSha256,
      frozenFaceCropJpegSha256: candidate.frozenFaceCropJpegSha256,
      frozenFaceCropBox: candidate.frozenFaceCropBox,
      workflowSchemaVersion: workflow.schema_version,
      workflowNodesMd5: workflow.nodes_md5,
      workflowEdgesMd5: workflow.edges_md5,
      storyboardReviewExecutionId: script.id,
      imageModelExecutionId: candidate.imageLedger.id,
      frameReviewExecutionId: candidate.frameReviewExecutionId,
      freshFrameMarkerSha256: candidate.markerSha256,
      approvedShotSha256: candidate.approvedShotSha256,
      approvedScheduleHash: candidate.approvedScheduleHash,
      approvedFirstFrameUrl: candidate.approvedFirstFrameUrl,
      approvedFirstFrameSha256: candidate.approvedFirstFrameSha256,
      sceneCutFrameCertificateSha256: candidate.frameCertificateSha256,
      frameCertificate: candidate.frameCertificate,
      phaseARequestSha256: plan.phaseAPreview.requestSha256,
      phaseAProviderLock: plan.providerLock }
    await db.query('ROLLBACK')
    return { body, approvalResultMd5: candidate.sourceRow.result_md5,
      planId, phaseARequestSha256: plan.phaseAPreview.requestSha256 }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export async function verifyA8B6FreshWorkflowApproval(planId,
  root = process.cwd()) {
  const signed = verifyA8B6FreshWorkflowApprovalSync(planId, root)
  const prepared = await prepareA8B6FreshWorkflowApproval(planId, root)
  const { signature: _signature, ...body } = signed.approval
  void _signature
  if (canonical(body) !== canonical(prepared.body))
    fail('signed approval differs from actual workflow and A request')
  return signed
}
