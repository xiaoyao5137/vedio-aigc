/** Separate creative approval for the 14s shot and locally derived t=0 image. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from
  '../src/workflow-core.ts'
import { A8B6_LOCAL_V7_FRAME_ID } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
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
import { verifyA8B6LocalCompositeSourceReceiptV7Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v7.mjs'
import { prepareA8B6LocalApprovedImageCandidateV7 } from
  './staged-scene-cut-a8b6-local-approved-candidate-v7.mjs'
import { planFreshA8B6PhaseA } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'

const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/
const fail = reason => { throw Error(`A8B6_LOCAL_V7_APPROVAL_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const directory = (root, planId) => {
  if (!SHA.test(String(planId))) fail('plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b6-local-approval-v7', planId)
}

/** Sync gate proves the signed artifact, local source pixels and certificate.
 * The async gate additionally reconstructs the DB and unsigned A request. */
export function verifyA8B6LocalWorkflowApprovalV7Sync(planId,
  root = process.cwd()) {
  const bytes = readFileSync(path.join(directory(root, planId), 'approval.json'))
  const approval = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('staging signing key invalid')
  const { signature, ...body } = approval
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  const source = verifyA8B6LocalCompositeSourceReceiptV7Sync(root)
  const certificate = verifySceneCutFrameApproval(approval.frameCertificate, root)
  if (!SHA.test(String(signature)) || !timingSafeEqual(
    Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || approval.version !== 'scene-cut-a8b6-local-workflow-approval-v7'
    || approval.planId !== planId
    || approval.approvalState !== 'approved-local-first-frame-before-A-request'
    || approval.frameProvenanceVariant !== 'a8b6-local-composite-v7'
    || approval.sourceExecutionId !== A8B6_FRESH_PREFLIGHT_SOURCE_IDS.SOURCE_ID
    || approval.timingExecutionId !== A8B6_FRESH_FRAME_PARENT_ID
    || approval.timingResultMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || approval.approvalExecutionId !== A8B6_LOCAL_V7_FRAME_ID
    || !MD5.test(String(approval.approvalResultMd5))
    || approval.imageModelExecutionId !== null
    || approval.imagePaymentExecutionId !== null
    || approval.localCompositeSourceReceiptSha256 !== source.receiptSha256
    || approval.localCompositeAlgorithmSha256
      !== source.receipt.algorithm.implementationSha256
    || approval.wallImageGenRawSha256 !== source.receipt.sources[1].sha256
    || approval.priorLocalV6RejectedReviewSha256
      !== source.receipt.priorLocalV6.rejectedReviewSha256
    || approval.approvedFirstFrameUrl !== source.receipt.output.url
    || approval.approvedFirstFrameSha256 !== source.receipt.output.sha256
    || !SHA.test(String(approval.phaseARequestSha256))
    || !SHA.test(String(approval.approvedShotSha256))
    || !SHA.test(String(approval.sceneCutFrameCertificateSha256))
    || !SHA.test(String(approval.freshFrameMarkerSha256))
    || !SHA.test(String(approval.conflictReceiptSha256))
    || !/^model-run-[\w-]+$/.test(String(approval.storyboardReviewExecutionId))
    || !/^model-run-[\w-]+$/.test(String(approval.frameReviewExecutionId))
    || approval.workflowSchemaVersion !== 180
    || approval.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || approval.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || certificate.passed !== true
    || certificate.repairBinding !== undefined
    || certificate.shotSha256 !== approval.approvedShotSha256
    || certificate.frame?.sourceUrl !== approval.approvedFirstFrameUrl
    || certificate.sourceSha256s?.[0] !== approval.approvedFirstFrameSha256
    || certificate.reviewExecutionId !== approval.frameReviewExecutionId
    || sceneCutRebindSha256(certificate)
      !== approval.sceneCutFrameCertificateSha256)
    fail('signed local approval, source pixels or frame certificate changed')
  return { approval, approvalSha256: sha(bytes) }
}

export async function prepareA8B6LocalWorkflowApprovalV7(planId,
  root = process.cwd()) {
  if (!SHA.test(String(planId))) fail('plan ID invalid')
  const candidate = await prepareA8B6LocalApprovedImageCandidateV7(root)
  const signedSource = verifyA8B6LocalCompositeSourceReceiptV7Sync(root)
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
      fail('original source or approved 14-second timing changed')
    const preflight = prepareA8B6FreshRegenerationPreflight({
      sourceRow: byId.get(ids.SOURCE_ID), timingRow: candidate.timingRow,
      rejectedRow: byId.get(ids.REJECTED_ID), retryRow: byId.get(ids.RETRY_ID),
      workflowRow: workflow, qa, conflict, ledgerRows: retryLedgerRows,
      root })
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
    if (!script) fail('14-second script decision lacks its exact model ledger')
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
    if (plan.planId !== planId
      || plan.source?.frameProvenanceVariant !== 'a8b6-local-composite-v7'
      || plan.source.localCompositeSourceReceiptSha256
        !== signedSource.receiptSha256
      || plan.source.localCompositeAlgorithmSha256
        !== candidate.localCompositeAlgorithmSha256
      || plan.source.wallImageGenRawSha256
        !== candidate.wallImageGenRawSha256
      || plan.source.priorLocalV6RejectedReviewSha256
        !== candidate.priorLocalV6RejectedReviewSha256
      || plan.source.imageModelExecutionId !== null)
      fail('new A request changed after local review')
    const body = {
      version: 'scene-cut-a8b6-local-workflow-approval-v7',
      planId, approvalState: 'approved-local-first-frame-before-A-request',
      frameProvenanceVariant: 'a8b6-local-composite-v7',
      sourceExecutionId: ids.SOURCE_ID,
      sourceResultMd5: byId.get(ids.SOURCE_ID).result_md5,
      timingExecutionId: ids.TIMING_ID,
      timingResultMd5: candidate.timingRow.result_md5,
      approvalExecutionId: candidate.sourceRow.id,
      approvalResultMd5: candidate.sourceRow.result_md5,
      imageModelExecutionId: null, imagePaymentExecutionId: null,
      conflictReceiptSha256: conflict.receiptSha256,
      localCompositeSourceReceiptSha256:
        candidate.localCompositeSourceReceiptSha256,
      localCompositeAlgorithmSha256:
        signedSource.receipt.algorithm.implementationSha256,
      wallImageGenRawSha256: candidate.wallImageGenRawSha256,
      priorLocalV6RejectedReviewSha256:
        candidate.priorLocalV6RejectedReviewSha256,
      workflowSchemaVersion: workflow.schema_version,
      workflowNodesMd5: workflow.nodes_md5,
      workflowEdgesMd5: workflow.edges_md5,
      storyboardReviewExecutionId: script.id,
      frameReviewExecutionId: candidate.frameReviewExecutionId,
      freshFrameMarkerSha256: candidate.markerSha256,
      approvedShotSha256: candidate.approvedShotSha256,
      approvedScheduleHash: candidate.approvedScheduleHash,
      approvedFirstFrameUrl: candidate.approvedFirstFrameUrl,
      approvedFirstFrameSha256: candidate.approvedFirstFrameSha256,
      sceneCutFrameCertificateSha256: candidate.frameCertificateSha256,
      frameCertificate: candidate.frameCertificate,
      phaseARequestSha256: plan.phaseAPreview.requestSha256,
      phaseAProviderLock: plan.providerLock,
    }
    await db.query('ROLLBACK')
    return { body, approvalResultMd5: candidate.sourceRow.result_md5,
      planId, phaseARequestSha256: plan.phaseAPreview.requestSha256 }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export async function verifyA8B6LocalWorkflowApprovalV7(planId,
  root = process.cwd()) {
  const signed = verifyA8B6LocalWorkflowApprovalV7Sync(planId, root)
  const prepared = await prepareA8B6LocalWorkflowApprovalV7(planId, root)
  const { signature: _signature, ...body } = signed.approval
  void _signature
  if (canonical(body) !== canonical(prepared.body))
    fail('signed local approval differs from the actual DB and A request')
  return signed
}
