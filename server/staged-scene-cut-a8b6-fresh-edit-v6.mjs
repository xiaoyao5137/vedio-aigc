/** Signed, source-bound layout-only edit of the genuinely rejected V5 frame. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { A8B6_FRESH_EDIT_FRAME_ID, A8B6_FRESH_V4_REVIEW_RETRY_ID,
  A8B6_FRESH_V5_EDIT_FRAME_ID, A8B6_FRESH_V5_RUNTIME_RETRY_ID,
  A8B6_FRESH_V6_EDIT_FRAME_ID, A8B6_FRESH_V6_EDIT_FRAME_VERSION,
  A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V6_EDIT_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_V4_IMAGE_MD5, A8B6_FRESH_V4_REVIEW_MD5,
  A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5,
  assertA8B6FreshV5EditHop, assertA8B6FreshV5RuntimeRetryHop,
  verifyA8B6FreshV5EditReceipt } from './staged-scene-cut-a8b6-fresh-edit-v5.mjs'

export const A8B6_FRESH_V5_REJECTED_MD5 = 'cb173ed88867d7dceef6df23ca556c2c'
export const A8B6_FRESH_V5_IMAGE_URL = '/generated/image-ef67600d77179361406cfafe32e36bdd.png'
export const A8B6_FRESH_V5_IMAGE_SHA = 'ef67600d77179361406cfafe32e36bdd4eb6075fddce3e8982b894ac12588be9'
export const A8B6_FRESH_V5_REVIEW_SHA = '46e6995f0b9bc7deec225f9e8eb866265a8300a9d1282f84f65043e9a90b7639'
export const A8B6_FRESH_V5_IMAGE_LEDGER = 'model-run-mummljbe-mjkdtii'
export const A8B6_FRESH_V5_REVIEW_LEDGER = 'model-run-mummq9te-g265mh2'
const fail = reason => { throw Error(`A8B6_FRESH_V6_EDIT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const receiptFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-fresh-edit-v6/reference.json')
const sourceImageBytes = root => {
  const bytes = readFileSync(path.join(root, 'public', A8B6_FRESH_V5_IMAGE_URL.slice(1)))
  if (sha(bytes) !== A8B6_FRESH_V5_IMAGE_SHA) fail('V5 rejected image bytes changed')
  return bytes
}
const transportJpeg = bytes => sharp(bytes, { failOn: 'error',
  limitInputPixels: 16 * 1024 * 1024 })
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()

export function verifyA8B6FreshV6EditReceiptSync(root = process.cwd()) {
  const bytes = readFileSync(receiptFile(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = receipt
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  const refs = body.referenceOrder
  if (key.length !== 32 || !/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || body.version !== 'a8b6-fresh-v6-edit-reference-v1'
    || body.role !== 'layout-only-rejected-source'
    || body.identityAuthority !== false || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || body.sourceImageExecutionId !== A8B6_FRESH_V5_RUNTIME_RETRY_ID
    || body.sourceImageResultMd5 !== A8B6_FRESH_V5_REJECTED_MD5
    || body.sourceReviewExecutionId !== A8B6_FRESH_V5_RUNTIME_RETRY_ID
    || body.sourceReviewResultMd5 !== A8B6_FRESH_V5_REJECTED_MD5
    || body.sourceImageUrl !== A8B6_FRESH_V5_IMAGE_URL
    || body.sourceImageSha256 !== A8B6_FRESH_V5_IMAGE_SHA
    || body.failedReviewSha256 !== A8B6_FRESH_V5_REVIEW_SHA
    || body.sourceImageModelExecutionId !== A8B6_FRESH_V5_IMAGE_LEDGER
    || body.sourceReviewModelExecutionId !== A8B6_FRESH_V5_REVIEW_LEDGER
    || body.targetExecutionId !== A8B6_FRESH_V6_EDIT_FRAME_ID
    || body.conversion?.format !== 'jpeg' || body.conversion.quality !== 90
    || body.conversion.chromaSubsampling !== '4:4:4'
    || !Array.isArray(refs) || refs.length !== 3
    || refs[0]?.position !== 1 || refs[1]?.position !== 2
    || refs[0]?.role !== 'frozen-identity' || refs[1]?.role !== 'frozen-identity'
    || refs[2]?.position !== 3 || refs[2]?.role !== 'rejected-layout-only'
    || refs[2].sourceSha256 !== A8B6_FRESH_V5_IMAGE_SHA
    || !/^[a-f0-9]{64}$/.test(String(refs[2].jpegSha256)))
    fail('V6 signed rejected source or roles changed')
  sourceImageBytes(root)
  for (const ref of refs.slice(0, 2)) {
    if (!/^\/generated\/[\w.-]+\.jpg$/.test(String(ref.frontUrl))
      || sha(readFileSync(path.join(root, 'public', ref.frontUrl.slice(1))))
        !== ref.sha256) fail('frozen identity reference changed')
  }
  return { receipt, receiptSha256: sha(bytes) }
}

export async function prepareA8B6FreshV6EditReference(root = process.cwd()) {
  const prior = await verifyA8B6FreshV5EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_EDIT_FRAME_ID,
      A8B6_FRESH_V4_REVIEW_RETRY_ID, A8B6_FRESH_V5_EDIT_FRAME_ID,
      A8B6_FRESH_V5_RUNTIME_RETRY_ID]
    const rows = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    if (rows.length !== ids.length
      || byId.get(A8B6_FRESH_FRAME_PARENT_ID)?.result_md5
        !== A8B6_FRESH_FRAME_PARENT_MD5
      || byId.get(A8B6_FRESH_EDIT_FRAME_ID)?.result_md5 !== A8B6_FRESH_V4_IMAGE_MD5
      || byId.get(A8B6_FRESH_V4_REVIEW_RETRY_ID)?.result_md5
        !== A8B6_FRESH_V4_REVIEW_MD5
      || byId.get(A8B6_FRESH_V5_EDIT_FRAME_ID)?.result_md5
        !== A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5
      || byId.get(A8B6_FRESH_V5_RUNTIME_RETRY_ID)?.result_md5
        !== A8B6_FRESH_V5_REJECTED_MD5)
      fail('V5 rejection ancestry CAS changed')
    const state = Object.fromEntries([...byId].map(([id, row]) =>
      [id, decodeExecutionState(row.result)]))
    const timing = state[A8B6_FRESH_FRAME_PARENT_ID]
    const mother = state[A8B6_FRESH_V5_EDIT_FRAME_ID]
    const rejected = state[A8B6_FRESH_V5_RUNTIME_RETRY_ID]
    assertA8B6FreshV5EditHop(timing, mother,
      A8B6_FRESH_FRAME_PARENT_MD5, prior,
      state[A8B6_FRESH_EDIT_FRAME_ID],
      state[A8B6_FRESH_V4_REVIEW_RETRY_ID], 'pre-provider-failed')
    assertA8B6FreshV5RuntimeRetryHop(mother, rejected,
      A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5, 'image-complete')
    const review = rejected.nodeRuns[49]?.output
    if (rejected.nodeRuns[45]?.output?.url !== A8B6_FRESH_V5_IMAGE_URL
      || rejected.nodeRuns[48]?.status !== 'success'
      || rejected.nodeRuns[49]?.status !== 'success'
      || review?.passed !== false
      || !isDeepStrictEqual(review?.issues?.map(issue => issue.code),
        ['identity_facial_hair_age_continuity', 'visible_watermark_or_pseudotext'])
      || review?.hardChecks?.allRequiredVisualActionsOpen !== true
      || review?.hardChecks?.wardrobeAndEquipment !== true
      || review?.hardChecks?.castAndIdentity !== false
      || sha(canonical(review)) !== A8B6_FRESH_V5_REVIEW_SHA
      || rejected.nodeRuns[50]?.status !== 'idle'
      || rejected.nodeRuns.slice(51).some(run => run.status !== 'idle'))
      fail('V5 true image review rejection changed')
    const ledgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=ANY($1)`, [[A8B6_FRESH_V5_IMAGE_LEDGER,
        A8B6_FRESH_V5_REVIEW_LEDGER]])).rows
    const byLedger = new Map(ledgers.map(row => [row.id, row]))
    const image = byLedger.get(A8B6_FRESH_V5_IMAGE_LEDGER)
    const modelReview = byLedger.get(A8B6_FRESH_V5_REVIEW_LEDGER)
    const refs = prior.referenceImages.map((value, index) => {
      const bytes = Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64')
      return { index: index + 1, bytes: bytes.length, sha256: sha(bytes) }
    })
    const { assertSceneCutReviewLedgerRecord } = await import('./scene-cut-frame-runtime.ts')
    if (ledgers.length !== 2 || image.status !== 'succeeded'
      || image.provider !== 'Codex' || image.capability !== 'image'
      || image.node_id !== 'sanguo-scene-cut-first-frame'
      || !String(image.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_FRESH_V5_RUNTIME_RETRY_ID}:`)
      || image.request_data?.sceneCutFreshEditReceiptSha256
        !== prior.receiptSha256
      || canonical(image.request_data?.params?.sceneCutFreshEditReceipt)
        !== canonical(prior.receipt)
      || !isDeepStrictEqual(image.response_data?.raw?.references, refs)
      || image.response_data?.raw?.image?.sha256 !== A8B6_FRESH_V5_IMAGE_SHA
      || image.response_data?.data?.[0]?.url !== A8B6_FRESH_V5_IMAGE_URL
      || assertSceneCutReviewLedgerRecord(modelReview, review,
        { evidence: rejected.nodeRuns[48].output,
          shot: rejected.nodeRuns[11].output,
          sources: rejected.nodeRuns[41].output,
          reviewImages: rejected.nodeRuns[48].output.reviewImages,
          openingStatePlan: rejected.nodeRuns[43].output,
          sceneCutFreshImage: rejected.sceneCutA8B6FreshFrameRecovery },
        root, 180) !== A8B6_FRESH_V5_REVIEW_LEDGER
      || !String(modelReview.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_FRESH_V5_RUNTIME_RETRY_ID}:`))
      fail('V5 genuine paid image or independent review ledger changed')
    const picture = sourceImageBytes(root)
    const transport = await transportJpeg(picture)
    const referenceOrder = [
      ...prior.receipt.referenceOrder.slice(0, 2),
      { position: 3, role: 'rejected-layout-only',
        sourceUrl: A8B6_FRESH_V5_IMAGE_URL,
        sourceSha256: A8B6_FRESH_V5_IMAGE_SHA,
        jpegSha256: sha(transport), bytes: transport.length }]
    const body = { version: 'a8b6-fresh-v6-edit-reference-v1',
      role: 'layout-only-rejected-source', identityAuthority: false,
      approvedFirstFrame: false, requiresFreshIndependentReview: true,
      sourceImageExecutionId: A8B6_FRESH_V5_RUNTIME_RETRY_ID,
      sourceImageResultMd5: A8B6_FRESH_V5_REJECTED_MD5,
      sourceReviewExecutionId: A8B6_FRESH_V5_RUNTIME_RETRY_ID,
      sourceReviewResultMd5: A8B6_FRESH_V5_REJECTED_MD5,
      sourceImageUrl: A8B6_FRESH_V5_IMAGE_URL,
      sourceImageSha256: A8B6_FRESH_V5_IMAGE_SHA,
      failedReviewSha256: A8B6_FRESH_V5_REVIEW_SHA,
      sourceImageModelExecutionId: A8B6_FRESH_V5_IMAGE_LEDGER,
      sourceReviewModelExecutionId: A8B6_FRESH_V5_REVIEW_LEDGER,
      priorEditReceiptSha256: prior.receiptSha256,
      targetExecutionId: A8B6_FRESH_V6_EDIT_FRAME_ID,
      referenceOrder, conversion: { format: 'jpeg', quality: 90,
        chromaSubsampling: '4:4:4' } }
    await db.query('ROLLBACK')
    return { body, referenceImages: [
      ...prior.referenceImages.slice(0, 2),
      `data:image/jpeg;base64,${transport.toString('base64')}`] }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export async function verifyA8B6FreshV6EditReceipt(root = process.cwd()) {
  const signed = verifyA8B6FreshV6EditReceiptSync(root)
  const prepared = await prepareA8B6FreshV6EditReference(root)
  const { signature: _signature, ...body } = signed.receipt
  void _signature
  if (canonical(body) !== canonical(prepared.body)
    || signed.receipt.referenceOrder[2].jpegSha256
      !== sha(Buffer.from(prepared.referenceImages[2].slice(
        'data:image/jpeg;base64,'.length), 'base64')))
    fail('signed V6 source differs from real V5 rejection')
  return { ...signed, referenceImages: prepared.referenceImages }
}

export function assertA8B6FreshV6EditHop(timing, current, timingMd5,
  signed, rejected, phase = 'pending') {
  if (!['pending', 'running', 'image-complete', 'review-complete',
    'approval-running', 'approved'].includes(phase)) fail('phase invalid')
  const before = timing?.nodeRuns, runs = current?.nodeRuns
  const marker = current?.sceneCutA8B6FreshFrameRecovery
  if (timing?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || current?.id !== A8B6_FRESH_V6_EDIT_FRAME_ID
    || current.parentExecutionId !== timing.id
    || current.generationScopeId !== current.id
    || current.requestScopeId !== timing.requestScopeId
    || rejected?.id !== A8B6_FRESH_V5_RUNTIME_RETRY_ID
    || !Array.isArray(before) || !Array.isArray(runs)
    || before.length !== 464 || runs.length !== before.length
    || !isDeepStrictEqual(runs.slice(0, 45), before.slice(0, 45))
    || !isDeepStrictEqual(rejected.nodeRuns.slice(0, 45), before.slice(0, 45))
    || marker?.version !== A8B6_FRESH_V6_EDIT_FRAME_VERSION
    || marker.sourceExecutionId !== timing.id
    || marker.sourceResultMd5 !== timingMd5
    || marker.priorFreshExecutionId !== rejected.id
    || marker.priorFreshResultMd5 !== A8B6_FRESH_V5_REJECTED_MD5
    || marker.priorFreshImageSha256 !== A8B6_FRESH_V5_IMAGE_SHA
    || marker.priorFreshReviewSha256 !== A8B6_FRESH_V5_REVIEW_SHA
    || marker.editReceiptSha256 !== signed?.receiptSha256
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || marker.firstPromptSha256 !== sha(A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT)
    || marker.reviewPromptSha256 !== sha(A8B6_FRESH_V6_EDIT_REVIEW_PROMPT)
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(before.slice(0, 45)))
    || marker.firstPendingIndex !== 45
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || runs[45]?.node?.prompt !== A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT
    || runs[49]?.node?.prompt !== A8B6_FRESH_V6_EDIT_REVIEW_PROMPT
    || canonical(runs[45]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_V6_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-first-frame', marker })
    || canonical(runs[49]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_V6_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-review', marker })
    || runs[45]?.node?.params?.find(x => x.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || runs[49]?.node?.params?.find(x => x.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || current.sceneCutImageRepairRecovery !== undefined
    || current.sceneCutApprovalRebindRecovery !== undefined)
    fail('V6 fork lost signed source or managed prompts')
  if (phase === 'pending' && runs.slice(45).some(run => run.status !== 'idle'))
    fail('V6 fork did not start at node45')
  if (phase === 'running' && runs[45]?.status !== 'running')
    fail('V6 image request is not running')
  if (['image-complete', 'review-complete', 'approval-running', 'approved']
    .includes(phase) && (runs[45]?.status !== 'success'
      || runs[45].output?.url === A8B6_FRESH_V5_IMAGE_URL))
    fail('V6 image missing or reused rejected V5 pixels')
  if (['review-complete', 'approval-running', 'approved'].includes(phase)
    && (runs[49]?.status !== 'success' || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])))
    fail('V6 image did not independently pass review')
  if (phase === 'approval-running' && runs[50]?.status !== 'running'
    || phase === 'approved' && runs[50]?.status !== 'success')
    fail('V6 certificate phase missing')
  return true
}

export async function bindA8B6FreshV6EditReference(request,
  root = process.cwd(), options = {}) {
  const key = request?.executionContext?.requestKey
  if (request?.model?.capability !== 'image'
    || request?.executionContext?.nodeId !== 'sanguo-scene-cut-first-frame'
    || typeof key !== 'string'
    || !key.startsWith(`${A8B6_FRESH_V6_EDIT_FRAME_ID}:`))
    return { applied: false, request }
  const signed = await verifyA8B6FreshV6EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_FRESH_V5_RUNTIME_RETRY_ID, A8B6_FRESH_V6_EDIT_FRAME_ID]
    const rows = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    const parentRow = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const rejectedRow = byId.get(A8B6_FRESH_V5_RUNTIME_RETRY_ID)
    const row = byId.get(A8B6_FRESH_V6_EDIT_FRAME_ID)
    if (rows.length !== ids.length
      || parentRow?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || rejectedRow?.result_md5 !== A8B6_FRESH_V5_REJECTED_MD5
      || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5)
      fail('V6 running request lost exact source or graph')
    const timing = decodeExecutionState(parentRow.result)
    const rejected = decodeExecutionState(rejectedRow.result)
    const state = decodeExecutionState(row.result)
    const params = request.params
    if (state.nodeRuns[45]?.status !== (options.previewOnly ? 'idle' : 'running')
      || !isDeepStrictEqual(params?.sceneCutFreshImage,
        state.sceneCutA8B6FreshFrameRecovery)
      || !isDeepStrictEqual(params?.sceneCutShot, state.nodeRuns[11].output)
      || !isDeepStrictEqual(params?.sceneCutSources, state.nodeRuns[41].output)
      || !isDeepStrictEqual(params?.sceneCutOpeningPlan, state.nodeRuns[43].output)
      || !isDeepStrictEqual(params?.referenceImages,
        state.nodeRuns[41].output?.imageReferenceImages)
      || params?.sceneCutFreshEditReceipt !== undefined
      || request.prompt !== renderWorkflowTemplate(
        A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT,
        { shot_script: state.nodeRuns[11].output,
          scene_cut_sources: state.nodeRuns[41].output,
          scene_cut_opening_state: state.nodeRuns[43].output }))
      fail('V6 image request differs from reviewed 14-second opening')
    assertA8B6FreshV6EditHop(timing, state, parentRow.result_md5,
      signed, rejected, options.previewOnly ? 'pending' : 'running')
    await db.query('ROLLBACK')
    return { applied: true, receiptSha256: signed.receiptSha256,
      request: { ...request, params: { ...params,
        referenceImages: signed.referenceImages,
        sceneCutFreshEditReceipt: signed.receipt } } }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export async function verifyA8B6FreshV6EditPaidRequest(request,
  root = process.cwd()) {
  const signed = await verifyA8B6FreshV6EditReceipt(root)
  const marker = request?.params?.sceneCutFreshImage
  if (marker?.version !== A8B6_FRESH_V6_EDIT_FRAME_VERSION
    || marker.editReceiptSha256 !== signed.receiptSha256
    || !String(request?.executionContext?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_V6_EDIT_FRAME_ID}:`)
    || canonical(request?.params?.sceneCutFreshEditReceipt)
      !== canonical(signed.receipt)
    || canonical(request?.params?.referenceImages)
      !== canonical(signed.referenceImages))
    fail('paid V6 request changed after source binding')
  return { receiptSha256: signed.receiptSha256 }
}
