/** Five source-bound references for a face-only V8 edit with the failed face hidden. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { A8B6_FRESH_EDIT_FRAME_ID, A8B6_FRESH_V4_REVIEW_RETRY_ID,
  A8B6_FRESH_V8_EDIT_FRAME_ID, A8B6_FRESH_V8_EDIT_FRAME_VERSION,
  A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V8_EDIT_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { A8B6_FRESH_V4_IMAGE_MD5, A8B6_FRESH_V4_REVIEW_MD5,
  A8B6_FRESH_V4_IMAGE_URL, A8B6_FRESH_V4_IMAGE_SHA,
  A8B6_FRESH_V4_REVIEW_LEDGER,
  verifyA8B6FreshV5EditReceipt, verifyA8B6FreshV5EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v5.mjs'
import { verifyA8B6FreshV7EditReceipt,
  verifyA8B6FreshV7EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID, A8B6_V7_FAILED_MD5,
  assertA8B6V7DualOutputRecoveryHop,
  verifyA8B6V7DualOutputRecoveryReceiptAsync,
  verifyA8B6V7DualOutputRecoveryReceipt,
  verifyA8B6V7DualOutputClarification } from
  './staged-scene-cut-a8b6-v7-dual-output.mjs'

export const A8B6_V7_REJECTED_MD5 = '474085677d68cea9f0cb436e06bf71af'
export const A8B6_V7_REVIEW_SHA = 'a38fdfaf7aff5d1f9a43ac0b1b71b27141899c37fc3026d1c1f8862797eace5c'
export const A8B6_V7_REVIEW_LEDGER = 'model-run-mumqcckm-v7og8o9'
export const A8B6_V8_LAYOUT_MASK = Object.freeze({
  left: 1022, top: 108, width: 143, height: 132,
  color: '#8f897d' })
export const A8B6_V8_V4_FACE_CROP = Object.freeze({
  left: 1015, top: 55, width: 175, height: 200 })
const fail = reason => { throw Error(`A8B6_FRESH_V8_EDIT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const dir = root => path.join(root, '.runtime/staged-scene-cut-a8b6-fresh-edit-v8')
const receiptFile = root => path.join(dir(root), 'reference.json')
const layoutFile = root => path.join(dir(root), 'face-masked-layout.jpg')
const helperFile = root => path.join(dir(root), 'v4-face-helper.jpg')

function localBytes(root, url, expectedSha) {
  if (!/^\/generated\/[\w.-]+\.(png|jpe?g)$/.test(String(url)))
    fail('source image URL invalid')
  const bytes = readFileSync(path.join(root, 'public', url.slice(1)))
  if (sha(bytes) !== expectedSha) fail('source image bytes changed')
  return bytes
}

async function derivedReferences(root, layoutSourceSha) {
  const layoutSource = localBytes(root,
    `/generated/image-${layoutSourceSha.slice(0, 32)}.png`, layoutSourceSha)
  const meta = await sharp(layoutSource).metadata()
  if (meta.width !== 1536 || meta.height !== 864 || meta.format !== 'png')
    fail('selected V7 layout geometry changed')
  const block = await sharp({ create: { width: A8B6_V8_LAYOUT_MASK.width,
    height: A8B6_V8_LAYOUT_MASK.height, channels: 3,
    background: A8B6_V8_LAYOUT_MASK.color } }).png().toBuffer()
  const masked = await sharp(layoutSource)
    .composite([{ input: block, left: A8B6_V8_LAYOUT_MASK.left,
      top: A8B6_V8_LAYOUT_MASK.top }])
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
  const v4 = localBytes(root, A8B6_FRESH_V4_IMAGE_URL,
    A8B6_FRESH_V4_IMAGE_SHA)
  const helper = await sharp(v4, { failOn: 'error' })
    .extract(A8B6_V8_V4_FACE_CROP)
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()
  return { masked, helper }
}

export function verifyA8B6FreshV8EditReceiptSync(root = process.cwd()) {
  const bytes = readFileSync(receiptFile(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = receipt
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  const v4 = verifyA8B6FreshV5EditReceiptSync(root)
  const v7 = verifyA8B6FreshV7EditReceiptSync(root)
  const dual = verifyA8B6V7DualOutputRecoveryReceipt(root)
  const clarification = verifyA8B6V7DualOutputClarification(root)
  const refs = body.referenceOrder
  if (key.length !== 32 || !/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || body.version !== 'a8b6-fresh-v8-five-reference-v1'
    || body.sourceExecutionId !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || body.sourceResultMd5 !== A8B6_V7_REJECTED_MD5
    || body.failedReviewModelExecutionId !== A8B6_V7_REVIEW_LEDGER
    || body.failedReviewSha256 !== A8B6_V7_REVIEW_SHA
    || body.sourceSelectionReceiptSha256 !== dual.receiptSha256
    || body.sourceSelectionClarificationSha256 !== clarification.clarificationSha256
    || body.sourceEditReceiptSha256 !== v7.receiptSha256
    || body.v4SourceReceiptSha256 !== v4.receiptSha256
    || body.v4ReviewExecutionId !== A8B6_FRESH_V4_REVIEW_RETRY_ID
    || body.v4ReviewModelExecutionId !== A8B6_FRESH_V4_REVIEW_LEDGER
    || body.v4ReviewSha256 !== v4.receipt.failedReviewSha256
    || body.targetExecutionId !== A8B6_FRESH_V8_EDIT_FRAME_ID
    || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || !Array.isArray(refs) || refs.length !== 5
    || refs[0]?.role !== 'frozen-zhang-identity'
    || refs[1]?.role !== 'frozen-yan-identity'
    || refs[2]?.role !== 'face-masked-layout-only'
    || refs[2].sourceSha256 !== dual.receipt.normalizedImageSha256
    || canonical(refs[2].mask) !== canonical(A8B6_V8_LAYOUT_MASK)
    || refs[2].identityAuthority !== false
    || refs[3]?.role !== 'v4-face-appearance-helper'
    || refs[3].sourceSha256 !== A8B6_FRESH_V4_IMAGE_SHA
    || canonical(refs[3].crop) !== canonical(A8B6_V8_V4_FACE_CROP)
    || refs[3].identityAuthority !== false
    || refs[4]?.role !== 'frozen-yan-original-face-crop'
    || refs[4].identityAuthority !== true
    || canonical(refs[4].crop)
      !== canonical(v7.receipt.referenceOrder[3].crop)
    || refs[4].jpegSha256 !== v7.receipt.referenceOrder[3].jpegSha256
    || !isDeepStrictEqual(refs.slice(0, 2).map(x => x.sha256),
      v7.receipt.referenceOrder.slice(0, 2).map(x => x.sha256)))
    fail('signed V8 source roles, rejected review or identity references changed')
  if (sha(readFileSync(layoutFile(root))) !== refs[2].jpegSha256
    || sha(readFileSync(helperFile(root))) !== refs[3].jpegSha256)
    fail('derived masked layout or V4 face helper changed')
  localBytes(root, A8B6_FRESH_V4_IMAGE_URL, A8B6_FRESH_V4_IMAGE_SHA)
  return { receipt, receiptSha256: sha(bytes) }
}

export async function prepareA8B6FreshV8EditReference(root = process.cwd()) {
  const v4 = await verifyA8B6FreshV5EditReceipt(root)
  const v7 = await verifyA8B6FreshV7EditReceipt(root)
  const dual = await verifyA8B6V7DualOutputRecoveryReceiptAsync(root)
  const clarification = verifyA8B6V7DualOutputClarification(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_V7_DUAL_OUTPUT_CHILD_ID,
      dual.receipt.failedExecutionId,
      A8B6_FRESH_EDIT_FRAME_ID, A8B6_FRESH_V4_REVIEW_RETRY_ID]
    const rows = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const childRow = byId.get(A8B6_V7_DUAL_OUTPUT_CHILD_ID)
    const motherRow = byId.get(dual.receipt.failedExecutionId)
    const v4ImageRow = byId.get(A8B6_FRESH_EDIT_FRAME_ID)
    const v4ReviewRow = byId.get(A8B6_FRESH_V4_REVIEW_RETRY_ID)
    if (rows.length !== ids.length
      || childRow?.result_md5 !== A8B6_V7_REJECTED_MD5
      || motherRow?.result_md5 !== A8B6_V7_FAILED_MD5
      || v4ImageRow?.result_md5 !== A8B6_FRESH_V4_IMAGE_MD5
      || v4ReviewRow?.result_md5 !== A8B6_FRESH_V4_REVIEW_MD5)
      fail('V7 rejection or V4 appearance helper history changed')
    const child = decodeExecutionState(childRow.result)
    const mother = decodeExecutionState(motherRow.result)
    const v4Review = decodeExecutionState(v4ReviewRow.result)
    assertA8B6V7DualOutputRecoveryHop(mother, child,
      motherRow.result_md5, dual, 'review-rejected')
    const review = child.nodeRuns[49].output
    if (sha(canonical(review)) !== A8B6_V7_REVIEW_SHA
      || !Array.isArray(review.issues) || review.issues.length !== 1
      || !String(review.issues[0]).includes('严颜身份外观不一致')
      || v4Review.nodeRuns[49]?.status !== 'success'
      || v4Review.nodeRuns[49].output?.passed !== false
      || v4Review.nodeRuns[49].output?.hardChecks?.castAndIdentity !== true)
      fail('V7 face rejection or V4 identity-only pass changed')
    const ledgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=ANY($1)`, [[A8B6_V7_REVIEW_LEDGER,
        A8B6_FRESH_V4_REVIEW_LEDGER]])).rows
    const byLedger = new Map(ledgers.map(row => [row.id, row]))
    if (ledgers.length !== 2
      || assertSceneCutReviewLedgerRecord(byLedger.get(A8B6_V7_REVIEW_LEDGER),
        review, { evidence: child.nodeRuns[48].output,
          shot: child.nodeRuns[11].output,
          sources: child.nodeRuns[41].output,
          reviewImages: child.nodeRuns[48].output.reviewImages,
          openingStatePlan: child.nodeRuns[43].output,
          sceneCutFreshImage: child.sceneCutA8B6FreshFrameRecovery },
        root, 180) !== A8B6_V7_REVIEW_LEDGER
      || byLedger.get(A8B6_FRESH_V4_REVIEW_LEDGER)?.status !== 'succeeded')
      fail('independent V7/V4 model review ledger changed')
    const { masked, helper } = await derivedReferences(root,
      dual.receipt.normalizedImageSha256)
    const refs = [
      { position: 1, role: 'frozen-zhang-identity', identityAuthority: true,
        sourceSha256: v7.receipt.referenceOrder[0].sha256,
        sha256: v7.receipt.referenceOrder[0].sha256 },
      { position: 2, role: 'frozen-yan-identity', identityAuthority: true,
        sourceSha256: v7.receipt.referenceOrder[1].sha256,
        sha256: v7.receipt.referenceOrder[1].sha256 },
      { position: 3, role: 'face-masked-layout-only', identityAuthority: false,
        sourceSha256: dual.receipt.normalizedImageSha256,
        mask: A8B6_V8_LAYOUT_MASK,
        jpegSha256: sha(masked), jpegBytes: masked.length,
        jpegQuality: 90, chromaSubsampling: '4:4:4' },
      { position: 4, role: 'v4-face-appearance-helper', identityAuthority: false,
        sourceSha256: A8B6_FRESH_V4_IMAGE_SHA,
        crop: A8B6_V8_V4_FACE_CROP,
        jpegSha256: sha(helper), jpegBytes: helper.length,
        jpegQuality: 95, chromaSubsampling: '4:4:4' },
      { position: 5, role: 'frozen-yan-original-face-crop',
        identityAuthority: true,
        sourceSha256: v7.receipt.referenceOrder[3].sourceSha256,
        crop: v7.receipt.referenceOrder[3].crop,
        jpegSha256: v7.receipt.referenceOrder[3].jpegSha256,
        jpegQuality: 95, chromaSubsampling: '4:4:4' },
    ]
    const body = {
      version: 'a8b6-fresh-v8-five-reference-v1',
      sourceExecutionId: child.id,
      sourceResultMd5: childRow.result_md5,
      failedReviewModelExecutionId: A8B6_V7_REVIEW_LEDGER,
      failedReviewSha256: A8B6_V7_REVIEW_SHA,
      sourceSelectionReceiptSha256: dual.receiptSha256,
      sourceSelectionClarificationSha256:
        clarification.clarificationSha256,
      sourceEditReceiptSha256: v7.receiptSha256,
      v4SourceReceiptSha256: v4.receiptSha256,
      v4ReviewExecutionId: A8B6_FRESH_V4_REVIEW_RETRY_ID,
      v4ReviewModelExecutionId: A8B6_FRESH_V4_REVIEW_LEDGER,
      v4ReviewSha256: v4.receipt.failedReviewSha256,
      targetExecutionId: A8B6_FRESH_V8_EDIT_FRAME_ID,
      approvedFirstFrame: false, requiresFreshIndependentReview: true,
      referenceOrder: refs,
    }
    await db.query('ROLLBACK')
    return { body, derived: { masked, helper }, referenceImages: [
      v7.referenceImages[0], v7.referenceImages[1],
      `data:image/jpeg;base64,${masked.toString('base64')}`,
      `data:image/jpeg;base64,${helper.toString('base64')}`,
      v7.referenceImages[3],
    ] }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export async function verifyA8B6FreshV8EditReceipt(root = process.cwd()) {
  const signed = verifyA8B6FreshV8EditReceiptSync(root)
  const prepared = await prepareA8B6FreshV8EditReference(root)
  const { signature: _signature, ...body } = signed.receipt
  if (canonical(body) !== canonical(prepared.body))
    fail('signed V8 references differ from the V7 rejection and V4 helper')
  return { ...signed, referenceImages: prepared.referenceImages }
}

export function assertA8B6FreshV8EditHop(timing, current, timingMd5,
  signed, rejected, phase = 'pending') {
  if (!['pending', 'running', 'image-complete', 'review-complete',
    'approval-running', 'approved'].includes(phase)) fail('phase invalid')
  const before = timing?.nodeRuns, runs = current?.nodeRuns
  const marker = current?.sceneCutA8B6FreshFrameRecovery
  if (timing?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || current?.id !== A8B6_FRESH_V8_EDIT_FRAME_ID
    || current.parentExecutionId !== timing.id
    || current.generationScopeId !== current.id
    || current.requestScopeId !== timing.requestScopeId
    || rejected?.id !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || !Array.isArray(before) || !Array.isArray(runs)
    || before.length !== 464 || runs.length !== before.length
    || !isDeepStrictEqual(runs.slice(0, 45), before.slice(0, 45))
    || !isDeepStrictEqual(rejected.nodeRuns.slice(0, 45), before.slice(0, 45))
    || marker?.version !== A8B6_FRESH_V8_EDIT_FRAME_VERSION
    || marker.sourceExecutionId !== timing.id
    || marker.sourceResultMd5 !== timingMd5
    || marker.priorFreshExecutionId !== rejected.id
    || marker.priorFreshResultMd5 !== A8B6_V7_REJECTED_MD5
    || marker.priorFreshImageSha256
      !== signed.receipt.referenceOrder[2].sourceSha256
    || marker.priorFreshReviewSha256 !== A8B6_V7_REVIEW_SHA
    || marker.editReceiptSha256 !== signed.receiptSha256
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || marker.firstPromptSha256 !== sha(A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT)
    || marker.reviewPromptSha256 !== sha(A8B6_FRESH_V8_EDIT_REVIEW_PROMPT)
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(before.slice(0, 45)))
    || marker.firstPendingIndex !== 45
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || runs[45]?.node?.prompt !== A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT
    || runs[49]?.node?.prompt !== A8B6_FRESH_V8_EDIT_REVIEW_PROMPT
    || canonical(runs[45]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_V8_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-first-frame', marker })
    || canonical(runs[49]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_V8_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-review', marker })
    || runs[45]?.node?.params?.find(x => x.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || runs[49]?.node?.params?.find(x => x.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || current.sceneCutImageRepairRecovery !== undefined
    || current.sceneCutApprovalRebindRecovery !== undefined)
    fail('V8 fork lost signed source or managed prompts')
  if (phase === 'pending' && runs.slice(45).some(run => run.status !== 'idle'))
    fail('V8 fork did not start at node45')
  if (phase === 'running' && runs[45]?.status !== 'running')
    fail('V8 image request is not running')
  if (['image-complete', 'review-complete', 'approval-running', 'approved']
    .includes(phase) && (runs[45]?.status !== 'success'
      || runs[45].output?.url === rejected.nodeRuns[45].output?.url))
    fail('V8 image missing or reused rejected V7 pixels')
  if (['review-complete', 'approval-running', 'approved'].includes(phase)
    && (runs[49]?.status !== 'success' || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])))
    fail('V8 image did not independently pass review')
  if (phase === 'approval-running' && runs[50]?.status !== 'running'
    || phase === 'approved' && runs[50]?.status !== 'success')
    fail('V8 certificate phase missing')
  return true
}

export async function bindA8B6FreshV8EditReference(request,
  root = process.cwd(), options = {}) {
  const key = request?.executionContext?.requestKey
  if (request?.model?.capability !== 'image'
    || request?.executionContext?.nodeId !== 'sanguo-scene-cut-first-frame'
    || typeof key !== 'string'
    || !key.startsWith(`${A8B6_FRESH_V8_EDIT_FRAME_ID}:`))
    return { applied: false, request }
  const signed = await verifyA8B6FreshV8EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_V7_DUAL_OUTPUT_CHILD_ID, A8B6_FRESH_V8_EDIT_FRAME_ID]
    const rows = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    const timingRow = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const rejectedRow = byId.get(A8B6_V7_DUAL_OUTPUT_CHILD_ID)
    const currentRow = byId.get(A8B6_FRESH_V8_EDIT_FRAME_ID)
    if (rows.length !== 3
      || timingRow?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || rejectedRow?.result_md5 !== A8B6_V7_REJECTED_MD5
      || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5)
      fail('V8 running request lost exact source or graph')
    const timing = decodeExecutionState(timingRow.result)
    const rejected = decodeExecutionState(rejectedRow.result)
    const current = decodeExecutionState(currentRow.result)
    const params = request.params
    if (current.nodeRuns[45]?.status !== (options.previewOnly ? 'idle' : 'running')
      || !isDeepStrictEqual(params?.sceneCutFreshImage,
        current.sceneCutA8B6FreshFrameRecovery)
      || !isDeepStrictEqual(params?.sceneCutShot, current.nodeRuns[11].output)
      || !isDeepStrictEqual(params?.sceneCutSources,
        current.nodeRuns[41].output)
      || !isDeepStrictEqual(params?.sceneCutOpeningPlan,
        current.nodeRuns[43].output)
      || !isDeepStrictEqual(params?.referenceImages,
        current.nodeRuns[41].output?.imageReferenceImages)
      || params?.sceneCutFreshEditReceipt !== undefined
      || request.prompt !== renderWorkflowTemplate(
        A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT,
        { shot_script: current.nodeRuns[11].output,
          scene_cut_sources: current.nodeRuns[41].output,
          scene_cut_opening_state: current.nodeRuns[43].output }))
      fail('V8 image request differs from reviewed 14-second opening')
    assertA8B6FreshV8EditHop(timing, current, timingRow.result_md5,
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

export async function verifyA8B6FreshV8EditPaidRequest(request,
  root = process.cwd()) {
  const signed = await verifyA8B6FreshV8EditReceipt(root)
  const marker = request?.params?.sceneCutFreshImage
  if (marker?.version !== A8B6_FRESH_V8_EDIT_FRAME_VERSION
    || marker.editReceiptSha256 !== signed.receiptSha256
    || !String(request?.executionContext?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_V8_EDIT_FRAME_ID}:`)
    || canonical(request?.params?.sceneCutFreshEditReceipt)
      !== canonical(signed.receipt)
    || canonical(request?.params?.referenceImages)
      !== canonical(signed.referenceImages))
    fail('paid V8 request changed after source binding')
  return { receiptSha256: signed.receiptSha256 }
}
