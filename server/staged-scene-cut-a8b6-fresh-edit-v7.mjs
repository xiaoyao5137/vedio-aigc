/** Signed V7 local face correction from a rejected V6 frame and frozen pixels. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { A8B6_FRESH_V6_EDIT_FRAME_ID, A8B6_FRESH_V7_EDIT_FRAME_ID,
  A8B6_FRESH_V7_EDIT_FRAME_VERSION,
  A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V7_EDIT_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_V5_REJECTED_MD5, assertA8B6FreshV6EditHop,
  verifyA8B6FreshV6EditReceipt,
  verifyA8B6FreshV6EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v6.mjs'

export const A8B6_FRESH_V6_REJECTED_MD5 = '57c70c044b43f567edcc44d268b725e5'
export const A8B6_FRESH_V6_IMAGE_URL = '/generated/image-a69fe77f6a5e3f5575f9eb810cf37e9c.png'
export const A8B6_FRESH_V6_IMAGE_SHA = 'a69fe77f6a5e3f5575f9eb810cf37e9cee3b9645e2f157cf7cb0805254f80119'
export const A8B6_FRESH_V6_REVIEW_SHA = '9ef4f34ed392ea770e75d58c3637e472a76a1adac69cea46868dc3fbb59aa77a'
export const A8B6_FRESH_V6_IMAGE_LEDGER = 'model-run-mumojdbs-4vmznke'
export const A8B6_FRESH_V6_REVIEW_LEDGER = 'model-run-mumoq7qg-pvomq3w'
export const A8B6_FRESH_V7_YAN_FRONT_URL = '/generated/scene-cut-front-55c299bd043eb89664e44cc18e00caccd8c5ac9f61c2ea6e0eb9b463f191000c.jpg'
export const A8B6_FRESH_V7_YAN_FRONT_SHA = '55c299bd043eb89664e44cc18e00caccd8c5ac9f61c2ea6e0eb9b463f191000c'
export const A8B6_FRESH_V7_FACE_CROP = Object.freeze({ left: 140, top: 60,
  width: 185, height: 205 })
const fail = reason => { throw Error(`A8B6_FRESH_V7_EDIT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const receiptFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-fresh-edit-v7/reference.json')
const sourceImageBytes = root => {
  const bytes = readFileSync(path.join(root, 'public', A8B6_FRESH_V6_IMAGE_URL.slice(1)))
  if (sha(bytes) !== A8B6_FRESH_V6_IMAGE_SHA) fail('V6 rejected image bytes changed')
  return bytes
}
const transportJpeg = bytes => sharp(bytes, { failOn: 'error',
  limitInputPixels: 16 * 1024 * 1024 })
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
const faceCropJpeg = bytes => sharp(bytes, { failOn: 'error',
  limitInputPixels: 16 * 1024 * 1024 })
  .extract(A8B6_FRESH_V7_FACE_CROP)
  .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()

export function verifyA8B6FreshV7EditReceiptSync(root = process.cwd()) {
  const bytes = readFileSync(receiptFile(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = receipt
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  const refs = body.referenceOrder
  const prior = verifyA8B6FreshV6EditReceiptSync(root)
  const crop = refs?.[3]
  if (key.length !== 32 || !/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || body.version !== 'a8b6-fresh-v7-edit-reference-v1'
    || body.role !== 'rejected-layout-plus-frozen-face-crop'
    || body.identityAuthority !== false || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || body.sourceImageExecutionId !== A8B6_FRESH_V6_EDIT_FRAME_ID
    || body.sourceImageResultMd5 !== A8B6_FRESH_V6_REJECTED_MD5
    || body.sourceReviewExecutionId !== A8B6_FRESH_V6_EDIT_FRAME_ID
    || body.sourceReviewResultMd5 !== A8B6_FRESH_V6_REJECTED_MD5
    || body.sourceImageUrl !== A8B6_FRESH_V6_IMAGE_URL
    || body.sourceImageSha256 !== A8B6_FRESH_V6_IMAGE_SHA
    || body.failedReviewSha256 !== A8B6_FRESH_V6_REVIEW_SHA
    || body.sourceImageModelExecutionId !== A8B6_FRESH_V6_IMAGE_LEDGER
    || body.sourceReviewModelExecutionId !== A8B6_FRESH_V6_REVIEW_LEDGER
    || body.priorEditReceiptSha256 !== prior.receiptSha256
    || body.targetExecutionId !== A8B6_FRESH_V7_EDIT_FRAME_ID
    || body.conversion?.format !== 'jpeg' || body.conversion.quality !== 90
    || body.conversion.chromaSubsampling !== '4:4:4'
    || !Array.isArray(refs) || refs.length !== 4
    || canonical(refs.slice(0, 2))
      !== canonical(prior.receipt.referenceOrder.slice(0, 2))
    || refs[2]?.position !== 3 || refs[2]?.role !== 'rejected-layout-only'
    || refs[2].sourceSha256 !== A8B6_FRESH_V6_IMAGE_SHA
    || !/^[a-f0-9]{64}$/.test(String(refs[2].jpegSha256))
    || crop?.position !== 4 || crop.role !== 'frozen-face-crop'
    || crop.identityAuthority !== true
    || crop.sourceUrl !== A8B6_FRESH_V7_YAN_FRONT_URL
    || crop.sourceSha256 !== A8B6_FRESH_V7_YAN_FRONT_SHA
    || canonical(crop.crop) !== canonical(A8B6_FRESH_V7_FACE_CROP)
    || crop.outputFormat !== 'jpeg' || crop.jpegQuality !== 95
    || !/^[a-f0-9]{64}$/.test(String(crop.jpegSha256)))
    fail('V7 signed rejected source, identity crop or roles changed')
  sourceImageBytes(root)
  if (sha(readFileSync(path.join(root, 'public',
    A8B6_FRESH_V7_YAN_FRONT_URL.slice(1)))) !== A8B6_FRESH_V7_YAN_FRONT_SHA)
    fail('frozen Yan front bytes changed')
  return { receipt, receiptSha256: sha(bytes) }
}

export async function prepareA8B6FreshV7EditReference(root = process.cwd()) {
  const prior = await verifyA8B6FreshV6EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      'record-4x5m31-a8b6-fresh-first-frame-v5-runtime-retry',
      A8B6_FRESH_V6_EDIT_FRAME_ID]
    const rows = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    if (rows.length !== ids.length
      || byId.get(A8B6_FRESH_FRAME_PARENT_ID)?.result_md5
        !== A8B6_FRESH_FRAME_PARENT_MD5
      || byId.get(ids[1])?.result_md5 !== A8B6_FRESH_V5_REJECTED_MD5
      || byId.get(A8B6_FRESH_V6_EDIT_FRAME_ID)?.result_md5
        !== A8B6_FRESH_V6_REJECTED_MD5)
      fail('V6 rejected image ancestry CAS changed')
    const timing = decodeExecutionState(byId.get(ids[0]).result)
    const rejectedV5 = decodeExecutionState(byId.get(ids[1]).result)
    const rejected = decodeExecutionState(byId.get(ids[2]).result)
    assertA8B6FreshV6EditHop(timing, rejected,
      A8B6_FRESH_FRAME_PARENT_MD5, prior, rejectedV5, 'image-complete')
    const review = rejected.nodeRuns[49]?.output
    if (rejected.nodeRuns[45]?.output?.url !== A8B6_FRESH_V6_IMAGE_URL
      || rejected.nodeRuns[48]?.status !== 'success'
      || rejected.nodeRuns[49]?.status !== 'success'
      || review?.passed !== false
      || !isDeepStrictEqual(review?.issues?.map(issue => issue.code),
        ['identity_age_and_beard_continuity_uncertain'])
      || review?.hardChecks?.allRequiredVisualActionsOpen !== true
      || review?.hardChecks?.wardrobeAndEquipment !== true
      || review?.hardChecks?.castAndIdentity !== false
      || sha(canonical(review)) !== A8B6_FRESH_V6_REVIEW_SHA
      || rejected.nodeRuns[50]?.status !== 'idle'
      || rejected.nodeRuns.slice(51).some(run => run.status !== 'idle'))
      fail('V6 true independent rejection changed')
    const ledgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=ANY($1)`, [[A8B6_FRESH_V6_IMAGE_LEDGER,
        A8B6_FRESH_V6_REVIEW_LEDGER]])).rows
    const byLedger = new Map(ledgers.map(row => [row.id, row]))
    const image = byLedger.get(A8B6_FRESH_V6_IMAGE_LEDGER)
    const modelReview = byLedger.get(A8B6_FRESH_V6_REVIEW_LEDGER)
    const expectedRefs = prior.referenceImages.map((value, index) => {
      const data = Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64')
      return { index: index + 1, bytes: data.length, sha256: sha(data) }
    })
    const { assertSceneCutReviewLedgerRecord } = await import('./scene-cut-frame-runtime.ts')
    if (ledgers.length !== 2 || image?.status !== 'succeeded'
      || image.provider !== 'Codex' || image.capability !== 'image'
      || image.node_id !== 'sanguo-scene-cut-first-frame'
      || !String(image.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_FRESH_V6_EDIT_FRAME_ID}:`)
      || image.request_data?.sceneCutFreshEditReceiptSha256
        !== prior.receiptSha256
      || canonical(image.request_data?.params?.sceneCutFreshEditReceipt)
        !== canonical(prior.receipt)
      || !isDeepStrictEqual(image.response_data?.raw?.references, expectedRefs)
      || image.response_data?.raw?.image?.sha256 !== A8B6_FRESH_V6_IMAGE_SHA
      || image.response_data?.data?.[0]?.url !== A8B6_FRESH_V6_IMAGE_URL
      || assertSceneCutReviewLedgerRecord(modelReview, review,
        { evidence: rejected.nodeRuns[48].output,
          shot: rejected.nodeRuns[11].output,
          sources: rejected.nodeRuns[41].output,
          reviewImages: rejected.nodeRuns[48].output.reviewImages,
          openingStatePlan: rejected.nodeRuns[43].output,
          sceneCutFreshImage: rejected.sceneCutA8B6FreshFrameRecovery },
        root, 180) !== A8B6_FRESH_V6_REVIEW_LEDGER
      || !String(modelReview.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_FRESH_V6_EDIT_FRAME_ID}:`))
      fail('V6 paid image or rejected model review ledger changed')
    const board = rejected.nodeRuns[41].output?.referenceBindings?.[1]
    if (board?.characterName !== '严颜'
      || board.frontUrl !== A8B6_FRESH_V7_YAN_FRONT_URL
      || board.frontSha256 !== A8B6_FRESH_V7_YAN_FRONT_SHA)
      fail('Yan face crop does not come from the frozen identity board')
    const yanBytes = readFileSync(path.join(root, 'public',
      A8B6_FRESH_V7_YAN_FRONT_URL.slice(1)))
    if (sha(yanBytes) !== A8B6_FRESH_V7_YAN_FRONT_SHA)
      fail('frozen Yan identity pixels changed')
    const face = await faceCropJpeg(yanBytes)
    const picture = sourceImageBytes(root)
    const transport = await transportJpeg(picture)
    const referenceOrder = [...prior.receipt.referenceOrder.slice(0, 2),
      { position: 3, role: 'rejected-layout-only',
        sourceUrl: A8B6_FRESH_V6_IMAGE_URL,
        sourceSha256: A8B6_FRESH_V6_IMAGE_SHA,
        jpegSha256: sha(transport), bytes: transport.length },
      { position: 4, role: 'frozen-face-crop', identityAuthority: true,
        sourceUrl: A8B6_FRESH_V7_YAN_FRONT_URL,
        sourceSha256: A8B6_FRESH_V7_YAN_FRONT_SHA,
        crop: A8B6_FRESH_V7_FACE_CROP, outputFormat: 'jpeg', jpegQuality: 95,
        jpegSha256: sha(face), bytes: face.length }]
    const body = { version: 'a8b6-fresh-v7-edit-reference-v1',
      role: 'rejected-layout-plus-frozen-face-crop', identityAuthority: false,
      approvedFirstFrame: false, requiresFreshIndependentReview: true,
      sourceImageExecutionId: A8B6_FRESH_V6_EDIT_FRAME_ID,
      sourceImageResultMd5: A8B6_FRESH_V6_REJECTED_MD5,
      sourceReviewExecutionId: A8B6_FRESH_V6_EDIT_FRAME_ID,
      sourceReviewResultMd5: A8B6_FRESH_V6_REJECTED_MD5,
      sourceImageUrl: A8B6_FRESH_V6_IMAGE_URL,
      sourceImageSha256: A8B6_FRESH_V6_IMAGE_SHA,
      failedReviewSha256: A8B6_FRESH_V6_REVIEW_SHA,
      sourceImageModelExecutionId: A8B6_FRESH_V6_IMAGE_LEDGER,
      sourceReviewModelExecutionId: A8B6_FRESH_V6_REVIEW_LEDGER,
      priorEditReceiptSha256: prior.receiptSha256,
      targetExecutionId: A8B6_FRESH_V7_EDIT_FRAME_ID,
      referenceOrder, conversion: { format: 'jpeg', quality: 90,
        chromaSubsampling: '4:4:4' } }
    await db.query('ROLLBACK')
    return { body, referenceImages: [
      ...prior.referenceImages.slice(0, 2),
      `data:image/jpeg;base64,${transport.toString('base64')}`,
      `data:image/jpeg;base64,${face.toString('base64')}`] }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export async function verifyA8B6FreshV7EditReceipt(root = process.cwd()) {
  const signed = verifyA8B6FreshV7EditReceiptSync(root)
  const prepared = await prepareA8B6FreshV7EditReference(root)
  const { signature: _signature, ...body } = signed.receipt
  void _signature
  if (canonical(body) !== canonical(prepared.body)
    || signed.receipt.referenceOrder[2].jpegSha256
      !== sha(Buffer.from(prepared.referenceImages[2].slice(
        'data:image/jpeg;base64,'.length), 'base64'))
    || signed.receipt.referenceOrder[3].jpegSha256
      !== sha(Buffer.from(prepared.referenceImages[3].slice(
        'data:image/jpeg;base64,'.length), 'base64')))
    fail('signed V7 source differs from rejected V6 and frozen Yan face')
  return { ...signed, referenceImages: prepared.referenceImages }
}

export function assertA8B6FreshV7EditHop(timing, current, timingMd5,
  signed, rejected, phase = 'pending') {
  if (!['pending', 'running', 'dual-output-failed', 'image-complete', 'review-complete',
    'approval-running', 'approved'].includes(phase)) fail('phase invalid')
  const before = timing?.nodeRuns, runs = current?.nodeRuns
  const marker = current?.sceneCutA8B6FreshFrameRecovery
  if (timing?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || current?.id !== A8B6_FRESH_V7_EDIT_FRAME_ID
    || current.parentExecutionId !== timing.id
    || current.generationScopeId !== current.id
    || current.requestScopeId !== timing.requestScopeId
    || rejected?.id !== A8B6_FRESH_V6_EDIT_FRAME_ID
    || !Array.isArray(before) || !Array.isArray(runs)
    || before.length !== 464 || runs.length !== before.length
    || !isDeepStrictEqual(runs.slice(0, 45), before.slice(0, 45))
    || !isDeepStrictEqual(rejected.nodeRuns.slice(0, 45), before.slice(0, 45))
    || marker?.version !== A8B6_FRESH_V7_EDIT_FRAME_VERSION
    || marker.sourceExecutionId !== timing.id
    || marker.sourceResultMd5 !== timingMd5
    || marker.priorFreshExecutionId !== rejected.id
    || marker.priorFreshResultMd5 !== A8B6_FRESH_V6_REJECTED_MD5
    || marker.priorFreshImageSha256 !== A8B6_FRESH_V6_IMAGE_SHA
    || marker.priorFreshReviewSha256 !== A8B6_FRESH_V6_REVIEW_SHA
    || marker.editReceiptSha256 !== signed?.receiptSha256
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || marker.firstPromptSha256 !== sha(A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT)
    || marker.reviewPromptSha256 !== sha(A8B6_FRESH_V7_EDIT_REVIEW_PROMPT)
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(before.slice(0, 45)))
    || marker.firstPendingIndex !== 45
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || runs[45]?.node?.prompt !== A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT
    || runs[49]?.node?.prompt !== A8B6_FRESH_V7_EDIT_REVIEW_PROMPT
    || canonical(runs[45]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_V7_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-first-frame', marker })
    || canonical(runs[49]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_V7_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-review', marker })
    || runs[45]?.node?.params?.find(x => x.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || runs[49]?.node?.params?.find(x => x.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || current.sceneCutImageRepairRecovery !== undefined
    || current.sceneCutApprovalRebindRecovery !== undefined)
    fail('V7 fork lost signed source or managed prompts')
  if (phase === 'pending' && runs.slice(45).some(run => run.status !== 'idle'))
    fail('V7 fork did not start at node45')
  if (phase === 'running' && runs[45]?.status !== 'running')
    fail('V7 image request is not running')
  if (phase === 'dual-output-failed'
    && (runs[45]?.status !== 'failed'
      || runs[45].error !== 'CODEX_IMAGE_COUNT_INVALID: 本次线程必须恰好保存1张 PNG 图片'
      || runs.slice(46).some(run => run.status !== 'idle')))
    fail('V7 failed image must be the exact dual-output gate with no downstream work')
  if (['image-complete', 'review-complete', 'approval-running', 'approved']
    .includes(phase) && (runs[45]?.status !== 'success'
      || runs[45].output?.url === A8B6_FRESH_V6_IMAGE_URL))
    fail('V7 image missing or reused rejected V6 pixels')
  if (['review-complete', 'approval-running', 'approved'].includes(phase)
    && (runs[49]?.status !== 'success' || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])))
    fail('V7 image did not independently pass review')
  if (phase === 'approval-running' && runs[50]?.status !== 'running'
    || phase === 'approved' && runs[50]?.status !== 'success')
    fail('V7 certificate phase missing')
  return true
}

export async function bindA8B6FreshV7EditReference(request,
  root = process.cwd(), options = {}) {
  const key = request?.executionContext?.requestKey
  if (request?.model?.capability !== 'image'
    || request?.executionContext?.nodeId !== 'sanguo-scene-cut-first-frame'
    || typeof key !== 'string'
    || !key.startsWith(`${A8B6_FRESH_V7_EDIT_FRAME_ID}:`))
    return { applied: false, request }
  const signed = await verifyA8B6FreshV7EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_FRESH_V6_EDIT_FRAME_ID, A8B6_FRESH_V7_EDIT_FRAME_ID]
    const rows = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    const parentRow = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const rejectedRow = byId.get(A8B6_FRESH_V6_EDIT_FRAME_ID)
    const row = byId.get(A8B6_FRESH_V7_EDIT_FRAME_ID)
    if (rows.length !== ids.length
      || parentRow?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || rejectedRow?.result_md5 !== A8B6_FRESH_V6_REJECTED_MD5
      || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5)
      fail('V7 running request lost exact source or graph')
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
        A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT,
        { shot_script: state.nodeRuns[11].output,
          scene_cut_sources: state.nodeRuns[41].output,
          scene_cut_opening_state: state.nodeRuns[43].output }))
      fail('V7 image request differs from reviewed 14-second opening')
    assertA8B6FreshV7EditHop(timing, state, parentRow.result_md5,
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

export async function verifyA8B6FreshV7EditPaidRequest(request,
  root = process.cwd()) {
  const signed = await verifyA8B6FreshV7EditReceipt(root)
  const marker = request?.params?.sceneCutFreshImage
  if (marker?.version !== A8B6_FRESH_V7_EDIT_FRAME_VERSION
    || marker.editReceiptSha256 !== signed.receiptSha256
    || !String(request?.executionContext?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_V7_EDIT_FRAME_ID}:`)
    || canonical(request?.params?.sceneCutFreshEditReceipt)
      !== canonical(signed.receipt)
    || canonical(request?.params?.referenceImages)
      !== canonical(signed.referenceImages))
    fail('paid V7 request changed after source binding')
  return { receiptSha256: signed.receiptSha256 }
}
