/** V5 may reuse V4 pixels only after proving V4's actual rejected review.
 * Node 49 failed on transport. Its one independent same-image retry succeeded
 * as a model call and rejected the wall; it was never a workflow approval. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { verifyA8B6LocalCompositeSourceReceiptV4 } from
  './staged-scene-cut-a8b6-local-composite-admission-v4.mjs'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'

export const A8B6_LOCAL_V5_REJECTED_V4 = Object.freeze({
  executionId: 'record-4x5m31-a8b6-local-wall-v4',
  failedResultMd5: 'ecd4fe2f2ec5809388a3365aa06523e8',
  workflowReviewStatus: 'failed',
  failedModelExecutionId: 'model-run-mumzh0mf-dx5icbo',
  failedRequestSha256:
    '3928bf22b25efb68b2ca307e889a3311dc8f0bf3280187f0b1bd1b4717210237',
  reviewModelExecutionId: 'model-run-mun0ctyo-efttaa2',
  rejectedReviewSha256:
    'd60200bcba71d976ad351b38af1e472c44d81dbc6935b0969e4e7d9e83fac0ac',
  retryModelResponseSha256:
    '155fa4c346226dc7bc174909459efd44b94dd5a6b83b384393649e81dcf90f23',
  retryIntentSha256:
    '680aa8e6a91f63c326dc96bd1eaf64a54ca076b5a20cfdca40ff1baa9287702f',
  frameApprovalStatus: 'idle',
  modelLedgerCount: 2,
  imageLedgerCount: 0,
  soleIssueCode: 'visible_masonry_conflicts_with_rammed_earth_requirement',
})

const fail = reason => { throw Error(`A8B6_LOCAL_V5_ANCESTRY_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const same = (a, b) => isDeepStrictEqual(a, b)
const attachmentIdentity = value => ({ url: value?.url, sha256: value?.sha256 })

/** Pure join of the frozen V4 workflow snapshot, both model ledgers and the
 * write-once retry intent. This never upgrades the failed workflow node. */
export function assertA8B6LocalV5RejectedV4State(state, resultMd5,
  timing, timingResultMd5, signed, modelLedgers, intentBytes,
  root = process.cwd()) {
  const rejected = A8B6_LOCAL_V5_REJECTED_V4
  const runs = state?.nodeRuns, marker = state?.sceneCutA8B6LocalFrameRecovery
  const source = signed?.receipt
  const ledgers = Array.isArray(modelLedgers) ? modelLedgers : []
  const failed = ledgers.find(row => row?.id === rejected.failedModelExecutionId)
  const retry = ledgers.find(row => row?.id === rejected.reviewModelExecutionId)
  const failedRequest = failed?.request_data, retryRequest = retry?.request_data
  const failedRaw = failed?.response_data?.raw
  const retryRaw = retry?.response_data?.raw
  const retryKey = `${rejected.executionId}:attempt-2:revision-3:`
    + 'sanguo-scene-cut-review:0:scene-01'
  const failedKey = `${rejected.executionId}:attempt-1:revision-2:`
    + 'sanguo-scene-cut-review:0:scene-01'
  if (state?.id !== rejected.executionId
    || resultMd5 !== rejected.failedResultMd5
    || timing?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingResultMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || state.parentExecutionId !== timing.id
    || !Array.isArray(runs) || !Array.isArray(timing.nodeRuns)
    || runs.length !== timing.nodeRuns.length
    || !same(runs.slice(0, 45), timing.nodeRuns.slice(0, 45))
    || marker?.version !== 'scene-cut-a8b6-local-first-frame-v4'
    || marker.sourceExecutionId !== timing.id
    || marker.sourceResultMd5 !== timingResultMd5
    || marker.sourceReceiptSha256 !== signed?.receiptSha256
    || marker.outputUrl !== source?.output?.url
    || marker.outputSha256 !== source?.output?.sha256
    || source?.target?.executionId !== state.id
    || source.approvedFirstFrame !== false
    || source.requiresFreshIndependentReview !== true
    || runs[45]?.status !== 'success'
    || runs[45].output?.url !== source.output.url
    || runs[45].output?.sourceBoundLocalComposite?.sourceReceiptSha256
      !== signed.receiptSha256
    || runs[48]?.status !== 'success'
    || runs[49]?.status !== rejected.workflowReviewStatus
    || runs[49].node?.id !== 'sanguo-scene-cut-review'
    || runs[49].node?.modelId !== 'codex-local-vision'
    || runs[49].attempt !== 1 || runs[49].revision !== 2
    || runs[49].error
      !== 'CODEX_ERROR_EVENT: CLI未产生可验收的完整文本；本次不自动重试'
    || runs[50]?.status !== rejected.frameApprovalStatus
    || runs.slice(50).some(run => run?.status !== 'idle')
    || ledgers.length !== rejected.modelLedgerCount
    || failed?.status !== 'failed'
    || retry?.status !== 'succeeded'
    || failed.model_id !== runs[49].node.modelId
    || retry.model_id !== runs[49].node.modelId
    || failed.provider !== 'Codex' || retry.provider !== 'Codex'
    || failed.workflow_id !== 'wf-sanguo-history-drama'
    || retry.workflow_id !== 'wf-sanguo-history-drama'
    || failed.node_id !== 'sanguo-scene-cut-review'
    || retry.node_id !== 'sanguo-scene-cut-review'
    || failedRequest?.requestKey !== failedKey
    || retryRequest?.requestKey !== retryKey
    || sha(JSON.stringify(failedRequest)) !== rejected.failedRequestSha256
    || !same(failedRequest.prompt, retryRequest.prompt)
    || !same(failedRequest.params, retryRequest.params)
    || !Array.isArray(failedRaw?.events)
    || !failedRaw.events.some(event =>
      String(event?.message ?? '').includes('usage limit'))
    || !Array.isArray(failedRaw.attachments)
    || failedRaw.attachments.length !== runs[48].output?.reviewImages?.length
    || !same(failedRaw.attachments.map(attachmentIdentity),
      retryRaw?.attachments?.map(attachmentIdentity))
    || !same(failedRaw.attachments.map(attachmentIdentity),
      retryRequest.reviewImageHashes?.map(attachmentIdentity)))
    fail('V4 failed workflow, same-image retry or zero-paid-media state changed')

  if (!Buffer.isBuffer(intentBytes)
    || sha(intentBytes) !== rejected.retryIntentSha256)
    fail('write-once retry intent bytes changed')
  let intent, parsed
  try {
    intent = JSON.parse(intentBytes.toString('utf8'))
    parsed = parseStructuredJson(extractTextResponse(retry.response_data))
  } catch { fail('retry intent or model result is not valid JSON') }
  if (!parsed || Array.isArray(parsed)
    || intent.version !== 'a8b6-v4-same-image-review-transport-retry-v1'
    || intent.executionId !== state.id
    || intent.failedResultMd5 !== resultMd5
    || intent.failedModelExecutionId !== failed.id
    || intent.failedRequestSha256 !== rejected.failedRequestSha256
    || intent.sourceReceiptSha256 !== signed.receiptSha256
    || intent.candidateSha256 !== source.output.sha256
    || intent.promptSha256 !== sha(failedRequest.prompt)
    || intent.modelId !== retry.model_id
    || intent.requestKey !== retryKey
    || !same(intent.reviewImages,
      failedRaw.attachments.map(attachmentIdentity)))
    fail('retry intent is not bound to rejected V4 source and original image')
  if (parsed.passed !== false
    || parsed.hardChecks?.setting !== false
    || parsed.hardChecks?.castAndIdentity !== true
    || parsed.hardChecks?.wardrobeAndEquipment !== true
    || parsed.hardChecks?.bodyAndProps !== true
    || parsed.hardChecks?.actionStartNotCompleted !== true
    || parsed.hardChecks?.allRequiredVisualActionsOpen !== true
    || parsed.hardChecks?.singleFullFrame !== true
    || canonical(parsed.issues?.map(issue => issue.code))
      !== canonical([rejected.soleIssueCode])
    || parsed.frame?.sourceUrl !== source.output.url
    || sha(canonical(parsed)) !== rejected.rejectedReviewSha256
    || sha(canonical(retry.response_data))
      !== rejected.retryModelResponseSha256)
    fail('independent V4 model result is not the recorded wall-only rejection')
  const review = { ...parsed, model: retry.model_id }
  if (assertSceneCutReviewLedgerRecord(retry, review, {
    evidence: runs[48].output, shot: runs[11].output,
    sources: runs[41].output,
    reviewImages: runs[48].output.reviewImages,
    openingStatePlan: runs[43].output,
    sceneCutLocalComposite: marker,
  }, root, 180) !== rejected.reviewModelExecutionId)
    fail('independent V4 review ledger did not inspect the signed source')
  return rejected
}

/** Recheck the signed V4 source and the immutable DB/model history read-only. */
export async function verifyA8B6LocalV5RejectedV4Ancestry(
  root = process.cwd()) {
  const signed = await verifyA8B6LocalCompositeSourceReceiptV4(root)
  const intentBytes = readFileSync(path.join(root,
    '.runtime/staged-scene-cut-a8b6-local-composite-v4/review-transport-retry-intent.json'))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_LOCAL_V5_REJECTED_V4.executionId]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timing = byId.get(ids[0]), v4 = byId.get(ids[1])
    const modelLedgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
    if (rows.length !== 2 || rows.some(row => row.workflow_id
      !== 'wf-sanguo-history-drama') || !timing || !v4)
      fail('approved timing or failed V4 child is missing')
    const rejected = assertA8B6LocalV5RejectedV4State(
      decodeExecutionState(v4.result), v4.result_md5,
      decodeExecutionState(timing.result), timing.result_md5,
      signed, modelLedgers, intentBytes, root)
    await db.query('ROLLBACK')
    return { rejected, sourceReceiptSha256: signed.receiptSha256,
      timingResultMd5: timing.result_md5,
      rejectedImageSha256: signed.receipt.output.sha256 }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}
