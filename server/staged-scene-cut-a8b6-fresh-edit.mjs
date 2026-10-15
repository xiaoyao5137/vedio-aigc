/** Source-bound layout-only reference for editing the rejected v3 first frame.
 * Frozen identity boards remain the sole character authority. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { A8B6_FRESH_EDIT_FRAME_ID, A8B6_FRESH_EDIT_FRAME_VERSION,
  A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT, A8B6_FRESH_EDIT_REVIEW_PROMPT,
  A8B6_FRESH_FRAME_ID } from '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { verifyA8B6FrameConflictReceipt } from './staged-scene-cut-a8b6-frame-conflict.mjs'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_QA_PLAN, A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5,
  A8B6_FRESH_V2_IMAGE_LEDGER, A8B6_FRESH_V2_REVIEW_LEDGER,
  verifyA8B6FreshV2Rejection } from './staged-scene-cut-a8b6-fresh-frame.mjs'

export const A8B6_FRESH_V3_RESULT_MD5 = '80d3d76fb68ef45b82f198837c8e182e'
export const A8B6_FRESH_V3_IMAGE_URL = '/generated/image-d8944a9e69d092a95990574615e375b0.png'
export const A8B6_FRESH_V3_IMAGE_SHA = 'd8944a9e69d092a95990574615e375b0dd024cd47d8742abbb3a8f964cab9c3c'
export const A8B6_FRESH_V3_REVIEW_SHA = '0c357695cf19160a60515a8b284e9f0a67a54ba6e8573eb1274f5fa7d3f117e9'
export const A8B6_FRESH_V3_IMAGE_LEDGER = 'model-run-mumkl7dd-4mw7jl5'
export const A8B6_FRESH_V3_REVIEW_LEDGER = 'model-run-mumkq5ig-7aaqwg0'
const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_FRESH_EDIT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const filename = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-fresh-edit/reference.json')
const imageFile = (root, url) => {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.png$/.test(url))
    fail('source image URL invalid')
  return path.join(root, 'public', url.slice(1))
}
const jpeg = async bytes => sharp(bytes, { failOn: 'error',
  limitInputPixels: 16 * 1024 * 1024 })
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()

export function verifyA8B6FreshEditReceiptSync(root = process.cwd()) {
  const bytes = readFileSync(filename(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('staging signing key invalid')
  const { signature, ...body } = receipt
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  const refs = body.referenceOrder
  if (!SHA.test(String(signature)) || !timingSafeEqual(
    Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || body.version !== 'a8b6-fresh-v4-edit-reference-v1'
    || body.role !== 'layout-only-rejected-source'
    || body.identityAuthority !== false || body.approvedFirstFrame !== false
    || body.sourceExecutionId !== A8B6_FRESH_FRAME_ID
    || body.sourceResultMd5 !== A8B6_FRESH_V3_RESULT_MD5
    || body.sourceImageUrl !== A8B6_FRESH_V3_IMAGE_URL
    || body.sourceImageSha256 !== A8B6_FRESH_V3_IMAGE_SHA
    || body.failedReviewSha256 !== A8B6_FRESH_V3_REVIEW_SHA
    || body.sourceImageModelExecutionId !== A8B6_FRESH_V3_IMAGE_LEDGER
    || body.sourceReviewModelExecutionId !== A8B6_FRESH_V3_REVIEW_LEDGER
    || body.targetExecutionId !== A8B6_FRESH_EDIT_FRAME_ID
    || !Array.isArray(refs) || refs.length !== 3
    || refs[0]?.position !== 1 || refs[1]?.position !== 2
    || refs[0]?.role !== 'frozen-identity'
    || refs[1]?.role !== 'frozen-identity'
    || refs[2]?.position !== 3 || refs[2]?.role !== 'rejected-layout-only'
    || refs[2].sourceSha256 !== A8B6_FRESH_V3_IMAGE_SHA
    || !SHA.test(String(refs[2].jpegSha256))
    || !Number.isSafeInteger(refs[2].bytes) || refs[2].bytes < 1
    || sha(readFileSync(imageFile(root, body.sourceImageUrl)))
      !== body.sourceImageSha256)
    fail('signed rejected edit source, role or image bytes changed')
  for (const ref of refs.slice(0, 2)) {
    if (typeof ref.frontUrl !== 'string'
      || !/^\/generated\/[\w.-]+\.jpg$/.test(ref.frontUrl)
      || sha(readFileSync(path.join(root, 'public', ref.frontUrl.slice(1))))
        !== ref.sha256) fail('frozen identity board bytes changed')
  }
  return { receipt, receiptSha256: sha(bytes) }
}

/** Reconstruct all three transport references and actual failed-model proof.
 * This is read-only even when used by the provider binder. */
export async function prepareA8B6FreshEditReference(root = process.cwd()) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_ID,
      'record-4x5m31-a8b6-fresh-first-frame-v2']
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records WHERE id=ANY($1)`,
    [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const parentRow = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const sourceRow = byId.get(A8B6_FRESH_FRAME_ID)
    const priorRow = byId.get('record-4x5m31-a8b6-fresh-first-frame-v2')
    if (rows.length !== ids.length
      || parentRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || sourceRow.result_md5 !== A8B6_FRESH_V3_RESULT_MD5
      || rows.some(row => row.workflow_id !== 'wf-sanguo-history-drama'))
      fail('actual timing and rejected first-frame records changed')
    const modelIds = [A8B6_FRESH_V2_IMAGE_LEDGER, A8B6_FRESH_V2_REVIEW_LEDGER,
      A8B6_FRESH_V3_IMAGE_LEDGER, A8B6_FRESH_V3_REVIEW_LEDGER]
    const modelRows = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=ANY($1)`, [modelIds])).rows
    const models = new Map(modelRows.map(row => [row.id, row]))
    if (modelRows.length !== modelIds.length) fail('prior image/review model ledgers missing')
    const prior = await verifyA8B6FreshV2Rejection(priorRow,
      models.get(A8B6_FRESH_V2_IMAGE_LEDGER),
      models.get(A8B6_FRESH_V2_REVIEW_LEDGER), root)
    const source = decodeExecutionState(sourceRow.result)
    const parent = decodeExecutionState(parentRow.result)
    const runs = source.nodeRuns, marker = source.sceneCutA8B6FreshFrameRecovery
    const conflict = await verifyA8B6FrameConflictReceipt(A8B6_FRESH_QA_PLAN, root)
    if (source.id !== A8B6_FRESH_FRAME_ID
      || source.parentExecutionId !== parent.id
      || !isDeepStrictEqual(runs.slice(0, 45), parent.nodeRuns.slice(0, 45))
      || marker?.version !== 'scene-cut-a8b6-fresh-first-frame-v3'
      || marker.priorFreshExecutionId !== prior.state.id
      || marker.priorFreshResultMd5 !== priorRow.result_md5
      || marker.adjudicationReceiptSha256 !== conflict.receiptSha256
      || runs[45]?.status !== 'success'
      || runs[45].output?.url !== A8B6_FRESH_V3_IMAGE_URL
      || runs[48]?.status !== 'success'
      || runs[49]?.status !== 'success' || runs[49].output?.passed !== false
      || !isDeepStrictEqual(runs[49].output?.hardChecks?.castAndIdentity, false)
      || runs[49].output?.hardChecks?.actionStartNotCompleted !== false
      || runs[49].output?.hardChecks?.wardrobeAndEquipment !== true
      || runs[50]?.status !== 'idle'
      || sha(canonical(runs[49].output)) !== A8B6_FRESH_V3_REVIEW_SHA)
      fail('rejected v3 picture or independent two-point review changed')
    const imageLedger = models.get(A8B6_FRESH_V3_IMAGE_LEDGER)
    const reviewLedger = models.get(A8B6_FRESH_V3_REVIEW_LEDGER)
    const { assertSceneCutReviewLedgerRecord } = await import('./scene-cut-frame-runtime.ts')
    if (imageLedger.status !== 'succeeded'
      || imageLedger.provider !== 'Codex' || imageLedger.capability !== 'image'
      || imageLedger.workflow_id !== 'wf-sanguo-history-drama'
      || imageLedger.node_id !== 'sanguo-scene-cut-first-frame'
      || !String(imageLedger.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_FRESH_FRAME_ID}:`)
      || imageLedger.request_data?.prompt !== runs[45].output.prompt
      || imageLedger.response_data?.data?.[0]?.url !== A8B6_FRESH_V3_IMAGE_URL
      || imageLedger.response_data?.raw?.image?.sha256 !== A8B6_FRESH_V3_IMAGE_SHA
      || assertSceneCutReviewLedgerRecord(reviewLedger, runs[49].output,
        { evidence: runs[48].output, shot: runs[11].output,
          sources: runs[41].output, reviewImages: runs[48].output.reviewImages,
          openingStatePlan: runs[43].output,
          sceneCutFreshImage: marker }, root, 180) !== A8B6_FRESH_V3_REVIEW_LEDGER)
      fail('rejected v3 image or review lacks its exact model ledger')
    const sourcePng = readFileSync(imageFile(root, A8B6_FRESH_V3_IMAGE_URL))
    if (sha(sourcePng) !== A8B6_FRESH_V3_IMAGE_SHA)
      fail('rejected v3 PNG bytes changed')
    const editJpeg = await jpeg(sourcePng)
    const boards = runs[41].output.referenceBindings
    if (!Array.isArray(boards) || boards.length !== 2
      || boards[0]?.characterName !== '张飞'
      || boards[1]?.characterName !== '严颜')
      fail('frozen identity plate order changed')
    const referenceOrder = boards.map((board, index) => ({
      position: index + 1, role: 'frozen-identity',
      characterName: board.characterName,
      frontUrl: board.frontUrl, sha256: board.frontSha256,
      bytes: readFileSync(path.join(root, 'public', board.frontUrl.slice(1))).length }))
    referenceOrder.push({ position: 3, role: 'rejected-layout-only',
      sourceUrl: A8B6_FRESH_V3_IMAGE_URL,
      sourceSha256: A8B6_FRESH_V3_IMAGE_SHA,
      jpegSha256: sha(editJpeg), bytes: editJpeg.length })
    const body = { version: 'a8b6-fresh-v4-edit-reference-v1',
      role: 'layout-only-rejected-source', identityAuthority: false,
      approvedFirstFrame: false, requiresFreshIndependentReview: true,
      sourceExecutionId: A8B6_FRESH_FRAME_ID,
      sourceResultMd5: sourceRow.result_md5,
      sourceImageUrl: A8B6_FRESH_V3_IMAGE_URL,
      sourceImageSha256: A8B6_FRESH_V3_IMAGE_SHA,
      failedReviewSha256: A8B6_FRESH_V3_REVIEW_SHA,
      sourceImageModelExecutionId: A8B6_FRESH_V3_IMAGE_LEDGER,
      sourceReviewModelExecutionId: A8B6_FRESH_V3_REVIEW_LEDGER,
      targetExecutionId: A8B6_FRESH_EDIT_FRAME_ID,
      referenceOrder, conversion: { format: 'jpeg', quality: 90,
        chromaSubsampling: '4:4:4' } }
    await db.query('ROLLBACK')
    return { body, referenceImages: [
      ...boards.map(board => `data:image/jpeg;base64,${readFileSync(path.join(root,
        'public', board.frontUrl.slice(1))).toString('base64')}`),
      `data:image/jpeg;base64,${editJpeg.toString('base64')}`],
      editJpegSha256: sha(editJpeg) }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export async function verifyA8B6FreshEditReceipt(root = process.cwd()) {
  const signed = verifyA8B6FreshEditReceiptSync(root)
  const prepared = await prepareA8B6FreshEditReference(root)
  const { signature: _signature, ...body } = signed.receipt
  void _signature
  if (canonical(body) !== canonical(prepared.body))
    fail('signed edit reference differs from actual rejected model review')
  return { ...signed, referenceImages: prepared.referenceImages }
}

export function assertA8B6FreshEditHop(parent, current, parentMd5,
  signed, prior, phase = 'pending') {
  const before = parent?.nodeRuns, runs = current?.nodeRuns
  const marker = current?.sceneCutA8B6FreshFrameRecovery
  const rejected = prior?.nodeRuns
  if (!['pending', 'running', 'image-complete', 'review-complete',
    'approval-running', 'approved'].includes(phase)) fail('edit phase invalid')
  if (parent?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || parentMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || current?.id !== A8B6_FRESH_EDIT_FRAME_ID
    || current.parentExecutionId !== parent.id
    || current.generationScopeId !== current.id
    || current.requestScopeId !== parent.requestScopeId
    || prior?.id !== A8B6_FRESH_FRAME_ID
    || prior.parentExecutionId !== parent.id
    || rejected?.[45]?.output?.url !== A8B6_FRESH_V3_IMAGE_URL
    || rejected?.[49]?.output?.passed !== false
    || rejected?.[50]?.status !== 'idle'
    || !Array.isArray(before) || !Array.isArray(runs)
    || before.length !== 464 || runs.length !== 464
    || !isDeepStrictEqual(runs.slice(0, 45), before.slice(0, 45))
    || !isDeepStrictEqual(rejected.slice(0, 45), before.slice(0, 45))
    || marker?.version !== A8B6_FRESH_EDIT_FRAME_VERSION
    || marker.sourceExecutionId !== parent.id
    || marker.sourceResultMd5 !== parentMd5
    || marker.priorFreshExecutionId !== prior.id
    || marker.priorFreshResultMd5 !== A8B6_FRESH_V3_RESULT_MD5
    || marker.priorFreshImageSha256 !== A8B6_FRESH_V3_IMAGE_SHA
    || marker.priorFreshReviewSha256 !== A8B6_FRESH_V3_REVIEW_SHA
    || marker.editReceiptSha256 !== signed?.receiptSha256
    || signed.receipt?.sourceExecutionId !== prior.id
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || marker.firstPromptSha256 !== sha(A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT)
    || marker.reviewPromptSha256 !== sha(A8B6_FRESH_EDIT_REVIEW_PROMPT)
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(before.slice(0, 45)))
    || marker.firstPendingIndex !== 45
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || runs[45]?.node?.prompt !== A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT
    || runs[49]?.node?.prompt !== A8B6_FRESH_EDIT_REVIEW_PROMPT
    || canonical(runs[45]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-first-frame', marker })
    || canonical(runs[49]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-review', marker })
    || runs[45]?.node?.params?.find(item => item.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || runs[49]?.node?.params?.find(item => item.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || current.sceneCutImageRepairRecovery !== undefined
    || current.sceneCutApprovalRebindRecovery !== undefined)
    fail('new edit branch lost rejected-source or managed-node binding')
  if (phase === 'pending' && runs.slice(45).some(run => run.status !== 'idle'))
    fail('new edit branch did not start at node45')
  if (phase === 'running' && runs[45]?.status !== 'running')
    fail('new edit image request is not running')
  if (['image-complete', 'review-complete', 'approval-running', 'approved']
    .includes(phase)) {
    if (runs[45]?.status !== 'success'
      || typeof runs[45].output?.url !== 'string'
      || runs[45].output.url === A8B6_FRESH_V3_IMAGE_URL)
      fail('new edit image was missing or reused the rejected still')
  }
  if (['review-complete', 'approval-running', 'approved'].includes(phase)
    && (runs[49]?.status !== 'success' || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])))
    fail('edited image did not independently pass every review item')
  if (phase === 'approval-running' && runs[50]?.status !== 'running'
    || phase === 'approved' && runs[50]?.status !== 'success')
    fail('edited image frame certificate missing')
  return true
}

export const A8B6_FRESH_EDIT_PROMPTS = Object.freeze({
  first: A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT,
  review: A8B6_FRESH_EDIT_REVIEW_PROMPT,
  version: A8B6_FRESH_EDIT_FRAME_VERSION })

/** No-op for all other requests. For v4 only, append the signed rejected
 * picture after the two identity boards before the provider fingerprint and
 * ledger are recorded. The unsigned browser request can never add its own. */
export async function bindA8B6FreshEditReference(request, root = process.cwd(),
  options = {}) {
  const key = request?.executionContext?.requestKey
  if (request?.model?.capability !== 'image'
    || request?.executionContext?.nodeId !== 'sanguo-scene-cut-first-frame'
    || typeof key !== 'string'
    || !key.startsWith(`${A8B6_FRESH_EDIT_FRAME_ID}:`))
    return { applied: false, request }
  const signed = await verifyA8B6FreshEditReceipt(root)
  const receipt = signed.receipt
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const row = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records WHERE id=$1`,
    [A8B6_FRESH_EDIT_FRAME_ID])).rows[0]
    const parentRow = (await db.query(`SELECT id,result,
      md5(result::text) AS result_md5 FROM execution_records WHERE id=$1`,
      [A8B6_FRESH_FRAME_PARENT_ID])).rows[0]
    const priorRow = (await db.query(`SELECT id,result,
      md5(result::text) AS result_md5 FROM execution_records WHERE id=$1`,
    [A8B6_FRESH_FRAME_ID])).rows[0]
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    const state = decodeExecutionState(row?.result)
    const parent = decodeExecutionState(parentRow?.result)
    const prior = decodeExecutionState(priorRow?.result)
    const marker = state?.sceneCutA8B6FreshFrameRecovery
    const params = request?.params
    if (row?.workflow_id !== 'wf-sanguo-history-drama'
      || state?.id !== A8B6_FRESH_EDIT_FRAME_ID
      || state.parentExecutionId !== A8B6_FRESH_FRAME_PARENT_ID
      || parentRow?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || priorRow?.result_md5 !== A8B6_FRESH_V3_RESULT_MD5
      || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5
      || !isDeepStrictEqual(state.nodeRuns.slice(0, 45), parent.nodeRuns.slice(0, 45))
      || marker?.version !== A8B6_FRESH_EDIT_FRAME_VERSION
      || marker.editReceiptSha256 !== signed.receiptSha256
      || marker.priorFreshExecutionId !== receipt.sourceExecutionId
      || marker.priorFreshResultMd5 !== receipt.sourceResultMd5
      || marker.priorFreshImageSha256 !== receipt.sourceImageSha256
      || marker.priorFreshReviewSha256 !== receipt.failedReviewSha256
      || marker.sourceExecutionId !== A8B6_FRESH_FRAME_PARENT_ID
      || marker.sourceResultMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || marker.firstPromptSha256 !== sha(A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT)
      || marker.reviewPromptSha256 !== sha(A8B6_FRESH_EDIT_REVIEW_PROMPT)
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256 !== sha(canonical(parent.nodeRuns.slice(0, 45)))
      || marker.firstPendingIndex !== 45
      || state.nodeRuns[45]?.status !== (options.previewOnly ? 'idle' : 'running')
      || state.nodeRuns[45]?.node?.prompt !== A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT
      || state.nodeRuns[49]?.node?.prompt !== A8B6_FRESH_EDIT_REVIEW_PROMPT
      || !isDeepStrictEqual(params?.sceneCutFreshImage, marker)
      || !isDeepStrictEqual(params?.sceneCutShot, state.nodeRuns[11].output)
      || !isDeepStrictEqual(params?.sceneCutSources, state.nodeRuns[41].output)
      || !isDeepStrictEqual(params?.sceneCutOpeningPlan, state.nodeRuns[43].output)
      || !isDeepStrictEqual(params?.referenceImages,
        state.nodeRuns[41].output?.imageReferenceImages)
      || params?.sceneCutFreshEditReceipt !== undefined
      || request.prompt !== renderWorkflowTemplate(A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT,
        { shot_script: state.nodeRuns[11].output,
          scene_cut_sources: state.nodeRuns[41].output,
          scene_cut_opening_state: state.nodeRuns[43].output }))
      fail('v4 request is not the exact running, reviewed 14s edit branch')
    assertA8B6FreshEditHop(parent, state, parentRow.result_md5,
      signed, prior, options.previewOnly ? 'pending' : 'running')
    await db.query('ROLLBACK')
    return { applied: true, receiptSha256: signed.receiptSha256,
      request: { ...request, params: { ...params,
        referenceImages: signed.referenceImages,
        sceneCutFreshEditReceipt: receipt } } }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

/** Request-level post-binder byte and order guard; complements the DB gate. */
export async function verifyA8B6FreshEditPaidRequest(request, root = process.cwd()) {
  const signed = await verifyA8B6FreshEditReceipt(root)
  const marker = request?.params?.sceneCutFreshImage
  if (marker?.version !== A8B6_FRESH_EDIT_FRAME_VERSION
    || marker.editReceiptSha256 !== signed.receiptSha256
    || request?.executionContext?.requestKey?.split(':')[0]
      !== A8B6_FRESH_EDIT_FRAME_ID
    || canonical(request?.params?.sceneCutFreshEditReceipt)
      !== canonical(signed.receipt)
    || canonical(request?.params?.referenceImages)
      !== canonical(signed.referenceImages))
    fail('paid v4 edit request changed after source binding')
  return { receiptSha256: signed.receiptSha256 }
}
