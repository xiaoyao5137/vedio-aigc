/** One fresh image from the approved 14s shot after same-image identity rejection. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { A8B6_FRESH_FRAME_ID, A8B6_FRESH_FRAME_VERSION,
  A8B6_FRESH_V2_FRAME_ID,
  A8B6_FRESH_FIRST_FRAME_PROMPT, A8B6_FRESH_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { verifyA8B6FrameConflictReceipt } from './staged-scene-cut-a8b6-frame-conflict.mjs'

export { A8B6_FRESH_FRAME_ID, A8B6_FRESH_FRAME_VERSION,
  A8B6_FRESH_FIRST_FRAME_PROMPT, A8B6_FRESH_REVIEW_PROMPT }
export const A8B6_FRESH_FRAME_PARENT_ID = 'record-4x5m31-a8b6-timing-approval-v3'
export const A8B6_FRESH_FRAME_PARENT_MD5 = '7024e0652a9fd878ef00a5a2dcec99f8'
export const A8B6_FRESH_REJECTED_ID = 'record-4x5m31-a8b6-frame-conflict-review-v1'
export const A8B6_FRESH_REJECTED_MD5 = 'de84b207979a369a455f4f2ce39c1b22'
export const A8B6_FRESH_QA_PLAN = 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'
export const A8B6_FRESH_NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
export const A8B6_FRESH_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
export const A8B6_REJECTED_IMAGE_SHA = '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
export const A8B6_FRESH_V2_RESULT_MD5 = '078812c4cb3c830c3515e6bbc907753d'
export const A8B6_FRESH_V2_IMAGE_SHA = '18e4feab5da795450b653bed01967251e96427e8d88ef86527a1470b6e3c97c8'
export const A8B6_FRESH_V2_IMAGE_URL = '/generated/image-18e4feab5da795450b653bed01967251.png'
export const A8B6_FRESH_V2_REVIEW_LEDGER = 'model-run-mumk2hv4-kmtwjsy'
export const A8B6_FRESH_V2_IMAGE_LEDGER = 'model-run-mumjxgt4-2kes3e9'
const fail = message => { throw Error(`A8B6_FRESH_FRAME_INVALID: ${message}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

export const A8B6_FRESH_FIRST_PROMPT_SHA = sha(A8B6_FRESH_FIRST_FRAME_PROMPT)
export const A8B6_FRESH_REVIEW_PROMPT_SHA = sha(A8B6_FRESH_REVIEW_PROMPT)

/** A previous new paid image was genuinely rejected, rather than simply
 * relabelled. This is the added permission boundary for another new take. */
export async function verifyA8B6FreshV2Rejection(row, imageLedger,
  reviewLedger, root = process.cwd()) {
  if (row?.id !== A8B6_FRESH_V2_FRAME_ID
    || row.result_md5 !== A8B6_FRESH_V2_RESULT_MD5)
    fail('previous fresh frame record changed')
  const old = decodeExecutionState(row.result)
  const runs = old.nodeRuns, image = runs?.[45]?.output
  const review = runs?.[49]?.output
  const marker = old.sceneCutA8B6FreshFrameRecovery
  if (old.id !== row.id || old.parentExecutionId !== A8B6_FRESH_FRAME_PARENT_ID
    || marker?.version !== 'scene-cut-a8b6-fresh-first-frame-v2'
    || runs?.[45]?.status !== 'success'
    || image?.url !== A8B6_FRESH_V2_IMAGE_URL
    || runs?.[48]?.status !== 'success'
    || runs?.[49]?.status !== 'success' || review?.passed !== false
    || !isDeepStrictEqual(review?.issues?.map(issue => issue.code),
      ['identity_age_and_beard_mismatch', 'closure_performer_start_unconfirmed'])
    || runs?.[50]?.status !== 'idle'
    || sha(readFileSync(path.join(root, 'public',
      A8B6_FRESH_V2_IMAGE_URL.slice(1)))) !== A8B6_FRESH_V2_IMAGE_SHA)
    fail('prior new image and its two independent rejection findings changed')
  const { assertSceneCutReviewLedgerRecord } = await import(
    './scene-cut-frame-runtime.ts')
  const reviewedId = assertSceneCutReviewLedgerRecord(reviewLedger, review,
    { evidence: runs[48].output, shot: runs[11].output,
      sources: runs[41].output, reviewImages: runs[48].output.reviewImages,
      openingStatePlan: runs[43].output, sceneCutFreshImage: marker },
    root, 180)
  if (reviewedId !== A8B6_FRESH_V2_REVIEW_LEDGER
    || imageLedger?.id !== A8B6_FRESH_V2_IMAGE_LEDGER
    || imageLedger.status !== 'succeeded'
    || imageLedger.provider !== 'Codex'
    || imageLedger.capability !== 'image'
    || imageLedger.node_id !== 'sanguo-scene-cut-first-frame'
    || !String(imageLedger.request_data?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_V2_FRAME_ID}:`)
    || imageLedger.request_data?.prompt !== image.prompt
    || !isDeepStrictEqual(imageLedger.request_data?.params?.sceneCutFreshImage,
      marker)
    || imageLedger.response_data?.data?.[0]?.url !== image.url)
    fail('previous fresh image or review does not match its model ledgers')
  return { state: old, reviewSha256: sha(canonical(review)),
    imageSha256: A8B6_FRESH_V2_IMAGE_SHA }
}

export function assertA8B6FreshFrameHop(parent, current, parentMd5,
  conflictReceipt, priorFresh, phase = 'pending') {
  const prior = parent?.nodeRuns, runs = current?.nodeRuns
  const marker = current?.sceneCutA8B6FreshFrameRecovery
  const old = priorFresh?.nodeRuns
  if (!['pending', 'image-complete', 'review-complete', 'approval-running',
    'approved'].includes(phase)) fail('fresh image phase invalid')
  if (parent?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || parentMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || current?.id !== A8B6_FRESH_FRAME_ID
    || current.parentExecutionId !== parent.id
    || current.generationScopeId !== current.id
    || current.requestScopeId !== parent.requestScopeId
    || current.workflowId !== parent.workflowId
    || current.sceneCutImageRepairRecovery !== undefined
    || current.sceneCutApprovalRebindRecovery !== undefined
    || !Array.isArray(prior) || !Array.isArray(runs)
    || prior.length !== 464 || runs.length !== 464
    || !isDeepStrictEqual(runs.slice(0, 45), prior.slice(0, 45))
    || prior[45]?.status !== 'failed'
    || !String(prior[45].error ?? '').includes('SCENE_CUT_EDIT_BINDER_INVALID')
    || marker?.version !== A8B6_FRESH_FRAME_VERSION
    || marker.sourceExecutionId !== parent.id
    || marker.sourceResultMd5 !== parentMd5
    || marker.rejectedExecutionId !== A8B6_FRESH_REJECTED_ID
    || marker.rejectedResultMd5 !== A8B6_FRESH_REJECTED_MD5
    || marker.qaPlanId !== A8B6_FRESH_QA_PLAN
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || marker.adjudicationReceiptSha256 !== conflictReceipt.receiptSha256
    || marker.rejectedImageSha256 !== A8B6_REJECTED_IMAGE_SHA
    || marker.priorFreshExecutionId !== A8B6_FRESH_V2_FRAME_ID
    || marker.priorFreshResultMd5 !== A8B6_FRESH_V2_RESULT_MD5
    || marker.priorFreshImageSha256 !== A8B6_FRESH_V2_IMAGE_SHA
    || marker.priorFreshReviewSha256 !== sha(canonical(old?.[49]?.output))
    || priorFresh?.id !== A8B6_FRESH_V2_FRAME_ID
    || priorFresh.parentExecutionId !== parent.id
    || !Array.isArray(old) || old.length !== 464
    || !isDeepStrictEqual(old.slice(0, 45), prior.slice(0, 45))
    || old[45]?.status !== 'success'
    || old[45].output?.url !== A8B6_FRESH_V2_IMAGE_URL
    || old[49]?.status !== 'success' || old[49].output?.passed !== false
    || !isDeepStrictEqual(old[49].output?.issues?.map(issue => issue.code),
      ['identity_age_and_beard_mismatch', 'closure_performer_start_unconfirmed'])
    || old[50]?.status !== 'idle'
    || marker.firstPromptSha256 !== A8B6_FRESH_FIRST_PROMPT_SHA
    || marker.reviewPromptSha256 !== A8B6_FRESH_REVIEW_PROMPT_SHA
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(prior.slice(0, 45)))
    || marker.firstPendingIndex !== 45
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || runs[45]?.node?.prompt !== A8B6_FRESH_FIRST_FRAME_PROMPT
    || runs[49]?.node?.prompt !== A8B6_FRESH_REVIEW_PROMPT
    || canonical(runs[45]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-first-frame', marker })
    || canonical(runs[49]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-review', marker })
    || runs[45]?.node?.params?.find(item => item.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || runs[49]?.node?.params?.find(item => item.name === 'sceneCutFreshImage')?.value
      !== canonical(marker))
    fail('fresh image fork lost approved shot, source or managed prompt')
  if (phase === 'pending') {
    if (runs.slice(45).some(run => run.status !== 'idle'))
      fail('fresh image fork is not at its first paid node')
  } else {
    if (runs[45]?.status !== 'success'
      || typeof runs[45].output?.url !== 'string'
      || runs[45].output.url === conflictReceipt.receipt.sourceImageUrl
      || runs[45].output.url === A8B6_FRESH_V2_IMAGE_URL
      || runs[45].output.url === parent.nodeRuns[45]?.output?.url)
      fail('new paid image is missing or reused the rejected still')
    if (phase === 'image-complete' && runs[46]?.status !== 'idle')
      fail('image continuation advanced unexpectedly')
    if (['review-complete', 'approval-running', 'approved'].includes(phase)) {
      if (runs[49]?.status !== 'success' || runs[49].output?.passed !== true
        || !isDeepStrictEqual(runs[49].output?.issues, []))
        fail('new image independent review not passed')
    }
    if (phase === 'approval-running' && runs[50]?.status !== 'running')
      fail('new image approval is not running')
    if (phase === 'approved' && runs[50]?.status !== 'success')
      fail('new image approval is not signed')
  }
  return true
}

/** Called at the provider boundary, before a fresh image purchase. */
export async function verifyA8B6FreshImageRequest(request, root = process.cwd()) {
  const key = request?.executionContext?.requestKey
  if (typeof key !== 'string' || !key.startsWith(`${A8B6_FRESH_FRAME_ID}:`))
    fail('fresh image provider key is not the new record')
  const params = request?.params
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const get = async id => (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1`, [id])).rows[0]
    const parent = await get(A8B6_FRESH_FRAME_PARENT_ID)
    const current = await get(A8B6_FRESH_FRAME_ID)
    const rejected = await get(A8B6_FRESH_REJECTED_ID)
    const prior = await get(A8B6_FRESH_V2_FRAME_ID)
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    const signed = await verifyA8B6FrameConflictReceipt(A8B6_FRESH_QA_PLAN, root)
    if (parent?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || rejected?.result_md5 !== A8B6_FRESH_REJECTED_MD5
      || prior?.result_md5 !== A8B6_FRESH_V2_RESULT_MD5
      || !current || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5)
      fail('fresh provider source records or graph changed')
    const p = decodeExecutionState(parent.result), c = decodeExecutionState(current.result)
    const [oldImageLedger, oldReviewLedger] = await Promise.all([
      db.query('SELECT * FROM model_execution_records WHERE id=$1',
        [A8B6_FRESH_V2_IMAGE_LEDGER]).then(result => result.rows[0]),
      db.query('SELECT * FROM model_execution_records WHERE id=$1',
        [A8B6_FRESH_V2_REVIEW_LEDGER]).then(result => result.rows[0]),
    ])
    const verifiedPrior = await verifyA8B6FreshV2Rejection(prior,
      oldImageLedger, oldReviewLedger, root)
    const old = verifiedPrior.state
    // The running node may have gained execution metadata, but its inputs and
    // pre-paid prefix must still equal the source-bound checkpoint.
    const marker = c.sceneCutA8B6FreshFrameRecovery
    if (c.id !== A8B6_FRESH_FRAME_ID || c.parentExecutionId !== p.id
      || !isDeepStrictEqual(c.nodeRuns.slice(0, 45), p.nodeRuns.slice(0, 45))
      || marker?.version !== A8B6_FRESH_FRAME_VERSION
      || marker.sourceExecutionId !== p.id
      || marker.sourceResultMd5 !== parent.result_md5
      || marker.rejectedExecutionId !== A8B6_FRESH_REJECTED_ID
      || marker.rejectedResultMd5 !== A8B6_FRESH_REJECTED_MD5
      || marker.qaPlanId !== A8B6_FRESH_QA_PLAN
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
      || marker.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
      || marker?.adjudicationReceiptSha256 !== signed.receiptSha256
      || marker.rejectedImageSha256 !== A8B6_REJECTED_IMAGE_SHA
      || marker.firstPromptSha256 !== A8B6_FRESH_FIRST_PROMPT_SHA
      || marker.reviewPromptSha256 !== A8B6_FRESH_REVIEW_PROMPT_SHA
      || marker.priorFreshExecutionId !== A8B6_FRESH_V2_FRAME_ID
      || marker.priorFreshResultMd5 !== prior.result_md5
      || marker.priorFreshImageSha256 !== A8B6_FRESH_V2_IMAGE_SHA
      || marker.priorFreshReviewSha256 !== sha(canonical(old.nodeRuns?.[49]?.output))
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256 !== sha(canonical(p.nodeRuns.slice(0, 45)))
      || marker.firstPendingIndex !== 45
      || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
      || old.nodeRuns?.[45]?.output?.url !== A8B6_FRESH_V2_IMAGE_URL
      || old.nodeRuns?.[49]?.output?.passed !== false
      || c.sceneCutImageRepairRecovery !== undefined
      || c.sceneCutApprovalRebindRecovery !== undefined
      || c.nodeRuns[45].node?.prompt !== A8B6_FRESH_FIRST_FRAME_PROMPT
      || canonical(c.nodeRuns[45].sourceBoundNodeOverride) !== canonical({
        version: A8B6_FRESH_FRAME_VERSION,
        nodeId: 'sanguo-scene-cut-first-frame', marker })
      || canonical(c.nodeRuns[49].sourceBoundNodeOverride) !== canonical({
        version: A8B6_FRESH_FRAME_VERSION,
        nodeId: 'sanguo-scene-cut-review', marker })
      || !isDeepStrictEqual(params.sceneCutFreshImage, marker)
      || !isDeepStrictEqual(params.sceneCutShot, c.nodeRuns[11].output)
      || !isDeepStrictEqual(params.sceneCutSources, c.nodeRuns[41].output)
      || !isDeepStrictEqual(params.sceneCutOpeningPlan, c.nodeRuns[43].output)
      || params.sceneCutRepairReceipt !== undefined
      || !isDeepStrictEqual(params.referenceImages,
        c.nodeRuns[41].output?.imageReferenceImages)
      || params.referenceImages?.length !== 2
      || request.prompt !== renderWorkflowTemplate(A8B6_FRESH_FIRST_FRAME_PROMPT,
        { shot_script: c.nodeRuns[11].output, scene_cut_sources: c.nodeRuns[41].output,
          scene_cut_opening_state: c.nodeRuns[43].output }))
      fail('fresh provider request is not the exact new approved two-reference image')
    if (c.nodeRuns[45]?.status !== 'running')
      fail('fresh provider node has not started; dry-run request shape was valid')
    await db.query('COMMIT')
    return { marker, sourceRecordMd5: parent.result_md5,
      rejectedRecordMd5: rejected.result_md5 }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export function verifyA8B6FreshImageBytes(url, root = process.cwd()) {
  if (typeof url !== 'string' || !/^\/generated\/image-[a-f0-9]{32}\.png$/.test(url))
    fail('new paid image URL invalid')
  const digest = sha(readFileSync(path.join(root, 'public', url.slice(1))))
  if ([A8B6_REJECTED_IMAGE_SHA, A8B6_FRESH_V2_IMAGE_SHA].includes(digest))
    fail('new image bytes equal a rejected still')
  return digest
}
