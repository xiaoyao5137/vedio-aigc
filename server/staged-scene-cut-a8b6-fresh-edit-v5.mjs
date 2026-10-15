/** Source-bound layout reference for a new edit after v4's real review rejected
 * only the partly hidden near guard. Neither rejected image is an identity
 * authority or an approved first frame. */
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
  A8B6_FRESH_V5_EDIT_FRAME_VERSION,
  A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V5_EDIT_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { assertA8B6FreshEditHop, verifyA8B6FreshEditReceipt,
  verifyA8B6FreshEditReceiptSync } from './staged-scene-cut-a8b6-fresh-edit.mjs'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_FRAME_ID } from '../src/scene-cut-a8b6-fresh-frame-workflow.ts'

export const A8B6_FRESH_V4_IMAGE_MD5 = 'bc5b2614194cd18fef359520bf010a11'
export const A8B6_FRESH_V4_REVIEW_MD5 = '55a5075553b5f07663c27e7bc0a7a392'
export const A8B6_FRESH_V4_IMAGE_URL = '/generated/image-6732c53b6900c5de13f3b22ee070c5a7.png'
export const A8B6_FRESH_V4_IMAGE_SHA = '6732c53b6900c5de13f3b22ee070c5a701042c529e701cec3ce0dd3d578dd7aa'
export const A8B6_FRESH_V4_REVIEW_SHA = '707562b5998a2903c0ae834796e8d9aa1e2fbec52ec5b631341a439016b70df9'
export const A8B6_FRESH_V4_IMAGE_LEDGER = 'model-run-mumlf3af-oslfvgt'
export const A8B6_FRESH_V4_REVIEW_LEDGER = 'model-run-mumlmlyt-aefsaa3'
export const A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5 = '7c3a5e832b06cd28769efeffb7577cfe'
export const A8B6_FRESH_V5_PRE_PROVIDER_LEDGER = 'model-run-mummb8ln-hwghfyu'
const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_FRESH_V5_EDIT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const filename = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-fresh-edit-v5/reference.json')
const imageFile = (root, url) => {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.png$/.test(url))
    fail('layout image URL invalid')
  return path.join(root, 'public', url.slice(1))
}
const imageBytes = (root, url, expectedSha) => {
  const bytes = readFileSync(imageFile(root, url))
  if (sha(bytes) !== expectedSha) fail('rejected layout bytes changed')
  return bytes
}
const jpeg = bytes => sharp(bytes, { failOn: 'error',
  limitInputPixels: 16 * 1024 * 1024 })
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()

export function verifyA8B6FreshV5EditReceiptSync(root = process.cwd()) {
  const bytes = readFileSync(filename(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('signing key invalid')
  const { signature, ...body } = receipt
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  const refs = body.referenceOrder
  const old = verifyA8B6FreshEditReceiptSync(root)
  if (!SHA.test(String(signature)) || !timingSafeEqual(
    Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || body.version !== 'a8b6-fresh-v5-edit-reference-v1'
    || body.role !== 'layout-only-rejected-source'
    || body.identityAuthority !== false || body.approvedFirstFrame !== false
    || body.sourceImageExecutionId !== A8B6_FRESH_EDIT_FRAME_ID
    || body.sourceImageResultMd5 !== A8B6_FRESH_V4_IMAGE_MD5
    || body.sourceReviewExecutionId !== A8B6_FRESH_V4_REVIEW_RETRY_ID
    || body.sourceReviewResultMd5 !== A8B6_FRESH_V4_REVIEW_MD5
    || body.sourceImageUrl !== A8B6_FRESH_V4_IMAGE_URL
    || body.sourceImageSha256 !== A8B6_FRESH_V4_IMAGE_SHA
    || body.failedReviewSha256 !== A8B6_FRESH_V4_REVIEW_SHA
    || body.sourceImageModelExecutionId !== A8B6_FRESH_V4_IMAGE_LEDGER
    || body.sourceReviewModelExecutionId !== A8B6_FRESH_V4_REVIEW_LEDGER
    || body.priorEditReceiptSha256 !== old.receiptSha256
    || body.targetExecutionId !== A8B6_FRESH_V5_EDIT_FRAME_ID
    || !Array.isArray(refs) || refs.length !== 3
    || refs[0]?.position !== 1 || refs[1]?.position !== 2
    || refs[0]?.role !== 'frozen-identity' || refs[1]?.role !== 'frozen-identity'
    || refs[2]?.position !== 3 || refs[2]?.role !== 'rejected-layout-only'
    || refs[2].sourceSha256 !== A8B6_FRESH_V4_IMAGE_SHA
    || !SHA.test(String(refs[2].jpegSha256))
    || !Number.isSafeInteger(refs[2].bytes) || refs[2].bytes < 1)
    fail('signed v5 edit source or reference roles changed')
  imageBytes(root, body.sourceImageUrl, body.sourceImageSha256)
  for (const ref of refs.slice(0, 2)) {
    if (typeof ref.frontUrl !== 'string'
      || !/^\/generated\/[\w.-]+\.jpg$/.test(ref.frontUrl)
      || sha(readFileSync(path.join(root, 'public', ref.frontUrl.slice(1))))
        !== ref.sha256) fail('frozen identity board bytes changed')
  }
  return { receipt, receiptSha256: sha(bytes) }
}

/** Deep read-only proof of the actual V4 paid picture and the one genuine
 * rejected review in its UI retry child. */
export async function prepareA8B6FreshV5EditReference(root = process.cwd()) {
  const old = await verifyA8B6FreshEditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_ID,
      A8B6_FRESH_EDIT_FRAME_ID, A8B6_FRESH_V4_REVIEW_RETRY_ID]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records WHERE id=ANY($1)`,
    [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    if (rows.length !== ids.length
      || rows.some(row => row.workflow_id !== 'wf-sanguo-history-drama')
      || byId.get(A8B6_FRESH_FRAME_PARENT_ID)?.result_md5
        !== A8B6_FRESH_FRAME_PARENT_MD5
      || byId.get(A8B6_FRESH_EDIT_FRAME_ID)?.result_md5
        !== A8B6_FRESH_V4_IMAGE_MD5
      || byId.get(A8B6_FRESH_V4_REVIEW_RETRY_ID)?.result_md5
        !== A8B6_FRESH_V4_REVIEW_MD5)
      fail('v4 picture or genuine review records changed')
    const timing = decodeExecutionState(byId.get(A8B6_FRESH_FRAME_PARENT_ID).result)
    const prior = decodeExecutionState(byId.get(A8B6_FRESH_FRAME_ID).result)
    const mother = decodeExecutionState(byId.get(A8B6_FRESH_EDIT_FRAME_ID).result)
    const child = decodeExecutionState(byId.get(A8B6_FRESH_V4_REVIEW_RETRY_ID).result)
    assertA8B6FreshEditHop(timing, mother, A8B6_FRESH_FRAME_PARENT_MD5,
      old, prior, 'image-complete')
    if (mother.nodeRuns[45]?.output?.url !== A8B6_FRESH_V4_IMAGE_URL
      || mother.nodeRuns[48]?.status !== 'success'
      || mother.nodeRuns[49]?.status !== 'failed'
      || mother.nodeRuns[49]?.error
        !== 'A8B6_FRESH_EDIT_INVALID: v4 request is not the exact running, reviewed 14s edit branch'
      || mother.nodeRuns[50]?.status !== 'idle'
      || child.id !== A8B6_FRESH_V4_REVIEW_RETRY_ID
      || child.parentExecutionId !== mother.id
      || child.generationScopeId !== child.id
      || child.requestScopeId !== mother.requestScopeId
      || !isDeepStrictEqual(child.nodeRuns.slice(0, 49),
        mother.nodeRuns.slice(0, 49))
      || !isDeepStrictEqual(child.sceneCutA8B6FreshFrameRecovery,
        mother.sceneCutA8B6FreshFrameRecovery)
      || child.nodeRuns[49]?.status !== 'success'
      || child.nodeRuns[49].output?.passed !== false
      || child.nodeRuns[50]?.status !== 'idle'
      || child.nodeRuns.slice(51).some(run => run.status !== 'idle')
      || !isDeepStrictEqual(child.nodeRuns[49].output?.issues?.map(x => x.code),
        ['closure_performer_start_not_fully_verifiable'])
      || child.nodeRuns[49].output?.hardChecks?.castAndIdentity !== true
      || child.nodeRuns[49].output?.hardChecks?.wardrobeAndEquipment !== true
      || child.nodeRuns[49].output?.hardChecks?.allRequiredVisualActionsOpen !== false
      || sha(canonical(child.nodeRuns[49].output)) !== A8B6_FRESH_V4_REVIEW_SHA)
      fail('v4 review rejection or paid image prefix changed')
    const picture = imageBytes(root, A8B6_FRESH_V4_IMAGE_URL,
      A8B6_FRESH_V4_IMAGE_SHA)
    const ledgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=ANY($1)`, [[A8B6_FRESH_V4_IMAGE_LEDGER,
        A8B6_FRESH_V4_REVIEW_LEDGER]])).rows
    if (ledgers.length !== 2) fail('v4 image or review model ledger missing')
    const ledger = new Map(ledgers.map(row => [row.id, row]))
    const image = ledger.get(A8B6_FRESH_V4_IMAGE_LEDGER)
    const review = ledger.get(A8B6_FRESH_V4_REVIEW_LEDGER)
    const { assertSceneCutReviewLedgerRecord } = await import('./scene-cut-frame-runtime.ts')
    const expectedRefs = old.referenceImages.map((value, index) => {
      const bytes = Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64')
      return { index: index + 1, bytes: bytes.length, sha256: sha(bytes) }
    })
    if (image.status !== 'succeeded' || image.provider !== 'Codex'
      || image.capability !== 'image'
      || image.workflow_id !== 'wf-sanguo-history-drama'
      || image.node_id !== 'sanguo-scene-cut-first-frame'
      || !String(image.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_FRESH_EDIT_FRAME_ID}:`)
      || image.request_data?.sceneCutFreshEditReceiptSha256
        !== old.receiptSha256
      || !isDeepStrictEqual(image.request_data?.params?.sceneCutFreshEditReceipt,
        old.receipt)
      || !isDeepStrictEqual(image.request_data?.params?.referenceImages,
        old.referenceImages.map(value => `[素材内容已隐藏，${value.length} 字符]`))
      || !isDeepStrictEqual(image.response_data?.raw?.references, expectedRefs)
      || image.response_data?.raw?.image?.sha256 !== A8B6_FRESH_V4_IMAGE_SHA
      || image.response_data?.data?.[0]?.url !== A8B6_FRESH_V4_IMAGE_URL
      || assertSceneCutReviewLedgerRecord(review, child.nodeRuns[49].output,
        { evidence: child.nodeRuns[48].output, shot: child.nodeRuns[11].output,
          sources: child.nodeRuns[41].output,
          reviewImages: child.nodeRuns[48].output.reviewImages,
          openingStatePlan: child.nodeRuns[43].output,
          sceneCutFreshImage: child.sceneCutA8B6FreshFrameRecovery },
        root, 180) !== A8B6_FRESH_V4_REVIEW_LEDGER
      || !String(review.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_FRESH_V4_REVIEW_RETRY_ID}:`))
      fail('v4 image and independent rejected review lack exact ledgers')
    const boards = mother.nodeRuns[41].output.referenceBindings
    if (!Array.isArray(boards) || boards.length !== 2
      || boards[0]?.characterName !== '张飞'
      || boards[1]?.characterName !== '严颜')
      fail('frozen identity board order changed')
    const transport = await jpeg(picture)
    const referenceOrder = boards.map((board, index) => ({
      position: index + 1, role: 'frozen-identity',
      characterName: board.characterName,
      frontUrl: board.frontUrl, sha256: board.frontSha256,
      bytes: readFileSync(path.join(root, 'public', board.frontUrl.slice(1))).length }))
    referenceOrder.push({ position: 3, role: 'rejected-layout-only',
      sourceUrl: A8B6_FRESH_V4_IMAGE_URL,
      sourceSha256: A8B6_FRESH_V4_IMAGE_SHA,
      jpegSha256: sha(transport), bytes: transport.length })
    const body = { version: 'a8b6-fresh-v5-edit-reference-v1',
      role: 'layout-only-rejected-source', identityAuthority: false,
      approvedFirstFrame: false, requiresFreshIndependentReview: true,
      sourceImageExecutionId: A8B6_FRESH_EDIT_FRAME_ID,
      sourceImageResultMd5: A8B6_FRESH_V4_IMAGE_MD5,
      sourceReviewExecutionId: A8B6_FRESH_V4_REVIEW_RETRY_ID,
      sourceReviewResultMd5: A8B6_FRESH_V4_REVIEW_MD5,
      sourceImageUrl: A8B6_FRESH_V4_IMAGE_URL,
      sourceImageSha256: A8B6_FRESH_V4_IMAGE_SHA,
      failedReviewSha256: A8B6_FRESH_V4_REVIEW_SHA,
      sourceImageModelExecutionId: A8B6_FRESH_V4_IMAGE_LEDGER,
      sourceReviewModelExecutionId: A8B6_FRESH_V4_REVIEW_LEDGER,
      priorEditReceiptSha256: old.receiptSha256,
      targetExecutionId: A8B6_FRESH_V5_EDIT_FRAME_ID,
      referenceOrder, conversion: { format: 'jpeg', quality: 90,
        chromaSubsampling: '4:4:4' } }
    await db.query('ROLLBACK')
    return { body, referenceImages: [
      ...boards.map(board => `data:image/jpeg;base64,${readFileSync(path.join(root,
        'public', board.frontUrl.slice(1))).toString('base64')}`),
      `data:image/jpeg;base64,${transport.toString('base64')}`] }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export async function verifyA8B6FreshV5EditReceipt(root = process.cwd()) {
  const signed = verifyA8B6FreshV5EditReceiptSync(root)
  const prepared = await prepareA8B6FreshV5EditReference(root)
  const { signature: _signature, ...body } = signed.receipt
  void _signature
  if (canonical(body) !== canonical(prepared.body))
    fail('signed v5 source differs from the rejected v4 image and review')
  return { ...signed, referenceImages: prepared.referenceImages }
}

/** Exact v5 branch contract; provider and certificate paths call this with
 * the current DB row, while receipt preparation stays read-only. */
export function assertA8B6FreshV5EditHop(timing, current, timingMd5,
  signed, rejectedImage, rejectedReview, phase = 'pending') {
  if (!['pending', 'running', 'pre-provider-failed', 'image-complete', 'review-complete',
    'approval-running', 'approved'].includes(phase)) fail('phase invalid')
  const before = timing?.nodeRuns, runs = current?.nodeRuns
  const marker = current?.sceneCutA8B6FreshFrameRecovery
  if (timing?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || current?.id !== A8B6_FRESH_V5_EDIT_FRAME_ID
    || current.parentExecutionId !== timing.id
    || current.generationScopeId !== current.id
    || current.requestScopeId !== timing.requestScopeId
    || rejectedImage?.id !== A8B6_FRESH_EDIT_FRAME_ID
    || rejectedReview?.id !== A8B6_FRESH_V4_REVIEW_RETRY_ID
    || rejectedReview.parentExecutionId !== rejectedImage.id
    || rejectedImage.nodeRuns?.[45]?.output?.url !== A8B6_FRESH_V4_IMAGE_URL
    || rejectedReview.nodeRuns?.[49]?.output?.passed !== false
    || !Array.isArray(before) || !Array.isArray(runs)
    || before.length !== 464 || runs.length !== 464
    || !isDeepStrictEqual(runs.slice(0, 45), before.slice(0, 45))
    || !isDeepStrictEqual(rejectedImage.nodeRuns.slice(0, 45),
      before.slice(0, 45))
    || marker?.version !== A8B6_FRESH_V5_EDIT_FRAME_VERSION
    || marker.sourceExecutionId !== timing.id
    || marker.sourceResultMd5 !== timingMd5
    || marker.priorFreshImageExecutionId !== rejectedImage.id
    || marker.priorFreshImageResultMd5 !== A8B6_FRESH_V4_IMAGE_MD5
    || marker.priorFreshExecutionId !== rejectedReview.id
    || marker.priorFreshResultMd5 !== A8B6_FRESH_V4_REVIEW_MD5
    || marker.priorFreshImageSha256 !== A8B6_FRESH_V4_IMAGE_SHA
    || marker.priorFreshReviewSha256 !== A8B6_FRESH_V4_REVIEW_SHA
    || marker.editReceiptSha256 !== signed?.receiptSha256
    || signed.receipt?.sourceReviewExecutionId !== rejectedReview.id
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || marker.firstPromptSha256 !== sha(A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT)
    || marker.reviewPromptSha256 !== sha(A8B6_FRESH_V5_EDIT_REVIEW_PROMPT)
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(before.slice(0, 45)))
    || marker.firstPendingIndex !== 45
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || runs[45]?.node?.prompt !== A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT
    || runs[49]?.node?.prompt !== A8B6_FRESH_V5_EDIT_REVIEW_PROMPT
    || canonical(runs[45]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_V5_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-first-frame', marker })
    || canonical(runs[49]?.sourceBoundNodeOverride) !== canonical({
      version: A8B6_FRESH_V5_EDIT_FRAME_VERSION,
      nodeId: 'sanguo-scene-cut-review', marker })
    || runs[45]?.node?.params?.find(x => x.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || runs[49]?.node?.params?.find(x => x.name === 'sceneCutFreshImage')?.value
      !== canonical(marker)
    || current.sceneCutImageRepairRecovery !== undefined
    || current.sceneCutApprovalRebindRecovery !== undefined)
    fail('v5 branch lost exact signed source or managed prompt')
  if (phase === 'pending' && runs.slice(45).some(run => run.status !== 'idle'))
    fail('v5 branch did not start at node45')
  if (phase === 'running' && runs[45]?.status !== 'running')
    fail('v5 image request is not running')
  if (phase === 'pre-provider-failed'
    && (runs[45]?.status !== 'failed'
      || runs[45].error !== 'SCENE_CUT_FRAME_BLOCKED: 首帧付费请求未使用当前批准分镜的正向零秒起点计划'
      || !isDeepStrictEqual(runs[45].output, { error:
        'SCENE_CUT_FRAME_BLOCKED: 首帧付费请求未使用当前批准分镜的正向零秒起点计划' })
      || runs.slice(46).some(run => run.status !== 'idle')))
    fail('v5 pre-provider failure changed or had downstream work')
  if (['image-complete', 'review-complete', 'approval-running', 'approved']
    .includes(phase) && (runs[45]?.status !== 'success'
      || runs[45].output?.url === A8B6_FRESH_V4_IMAGE_URL))
    fail('v5 image missing or reused rejected v4 pixels')
  if (['review-complete', 'approval-running', 'approved'].includes(phase)
    && (runs[49]?.status !== 'success' || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])))
    fail('v5 image did not independently pass review')
  if (phase === 'approval-running' && runs[50]?.status !== 'running'
    || phase === 'approved' && runs[50]?.status !== 'success')
    fail('v5 certificate phase missing')
  return true
}

/** A narrowly scoped retry after an old orphan service missed the new v5
 * binder. The original failed run is immutable and must have no provider task. */
export function assertA8B6FreshV5RuntimeRetryHop(parent, child, parentMd5,
  phase = 'pending') {
  if (!['pending', 'running', 'image-complete', 'review-complete',
    'approval-running', 'approved'].includes(phase)) fail('runtime retry phase invalid')
  const before = parent?.nodeRuns, runs = child?.nodeRuns
  if (parent?.id !== A8B6_FRESH_V5_EDIT_FRAME_ID
    || parentMd5 !== A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5
    || child?.id !== A8B6_FRESH_V5_RUNTIME_RETRY_ID
    || child.parentExecutionId !== parent.id
    || child.workflowId !== parent.workflowId
    || child.requestScopeId !== parent.requestScopeId
    || child.generationScopeId !== child.id
    || !Array.isArray(before) || !Array.isArray(runs)
    || before.length !== 464 || runs.length !== before.length
    || before[45]?.status !== 'failed'
    || before[45].error
      !== 'SCENE_CUT_FRAME_BLOCKED: 首帧付费请求未使用当前批准分镜的正向零秒起点计划'
    || !isDeepStrictEqual(before[45].output, { error:
      'SCENE_CUT_FRAME_BLOCKED: 首帧付费请求未使用当前批准分镜的正向零秒起点计划' })
    || before.slice(46).some(run => run.status !== 'idle')
    || !isDeepStrictEqual(runs.slice(0, 45), before.slice(0, 45))
    || !isDeepStrictEqual(child.sceneCutA8B6FreshFrameRecovery,
      parent.sceneCutA8B6FreshFrameRecovery)
    || !isDeepStrictEqual(runs[45]?.node, before[45]?.node)
    || !isDeepStrictEqual(runs[45]?.sourceBoundNodeOverride,
      before[45]?.sourceBoundNodeOverride)
    || !isDeepStrictEqual(runs[49]?.node, before[49]?.node)
    || !isDeepStrictEqual(runs[49]?.sourceBoundNodeOverride,
      before[49]?.sourceBoundNodeOverride)
    || Number(runs[45]?.revision) !== Number(before[45]?.revision) + 1)
    fail('runtime retry altered the approved prefix or signed v5 prompt')
  if (phase === 'pending' && runs.slice(45).some(run => run.status !== 'idle'))
    fail('runtime retry did not start at the failed image')
  if (phase === 'running' && runs[45]?.status !== 'running')
    fail('runtime retry image request is not running')
  if (['image-complete', 'review-complete', 'approval-running', 'approved']
    .includes(phase) && runs[45]?.status !== 'success')
    fail('runtime retry image missing')
  if (['review-complete', 'approval-running', 'approved'].includes(phase)
    && (runs[49]?.status !== 'success' || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])))
    fail('runtime retry did not independently pass first-frame review')
  if (phase === 'approval-running' && runs[50]?.status !== 'running'
    || phase === 'approved' && runs[50]?.status !== 'success')
    fail('runtime retry frame certificate missing')
  return true
}

/** Image-only pre-provider binder. It validates the exact running checkpoint
 * before appending the signed layout JPEG to the two frozen identity boards. */
export async function bindA8B6FreshV5EditReference(request,
  root = process.cwd(), options = {}) {
  const key = request?.executionContext?.requestKey
  const retry = typeof key === 'string'
    && key.startsWith(`${A8B6_FRESH_V5_RUNTIME_RETRY_ID}:`)
  if (request?.model?.capability !== 'image'
    || request?.executionContext?.nodeId !== 'sanguo-scene-cut-first-frame'
    || typeof key !== 'string'
    || !(key.startsWith(`${A8B6_FRESH_V5_EDIT_FRAME_ID}:`) || retry))
    return { applied: false, request }
  const signed = await verifyA8B6FreshV5EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_FRESH_EDIT_FRAME_ID, A8B6_FRESH_V4_REVIEW_RETRY_ID,
      A8B6_FRESH_V5_EDIT_FRAME_ID,
      ...(retry ? [A8B6_FRESH_V5_RUNTIME_RETRY_ID] : [])]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    const row = byId.get(retry ? A8B6_FRESH_V5_RUNTIME_RETRY_ID
      : A8B6_FRESH_V5_EDIT_FRAME_ID)
    const originalRow = byId.get(A8B6_FRESH_V5_EDIT_FRAME_ID)
    const parentRow = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const rejectedImageRow = byId.get(A8B6_FRESH_EDIT_FRAME_ID)
    const rejectedReviewRow = byId.get(A8B6_FRESH_V4_REVIEW_RETRY_ID)
    if (rows.length !== ids.length
      || rows.some(item => item.workflow_id !== 'wf-sanguo-history-drama')
      || parentRow?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || rejectedImageRow?.result_md5 !== A8B6_FRESH_V4_IMAGE_MD5
      || rejectedReviewRow?.result_md5 !== A8B6_FRESH_V4_REVIEW_MD5
      || retry && originalRow?.result_md5
        !== A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5
      || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5)
      fail('current v5 request lost approved timing or rejected-source CAS')
    const state = decodeExecutionState(row.result)
    const parent = decodeExecutionState(parentRow.result)
    const rejectedImage = decodeExecutionState(rejectedImageRow.result)
    const rejectedReview = decodeExecutionState(rejectedReviewRow.result)
    const marker = state.sceneCutA8B6FreshFrameRecovery
    const params = request?.params
    if (state.id !== (retry ? A8B6_FRESH_V5_RUNTIME_RETRY_ID
      : A8B6_FRESH_V5_EDIT_FRAME_ID)
      || state.nodeRuns[45]?.status !== (options.previewOnly ? 'idle' : 'running')
      || !isDeepStrictEqual(params?.sceneCutFreshImage, marker)
      || !isDeepStrictEqual(params?.sceneCutShot, state.nodeRuns[11].output)
      || !isDeepStrictEqual(params?.sceneCutSources, state.nodeRuns[41].output)
      || !isDeepStrictEqual(params?.sceneCutOpeningPlan, state.nodeRuns[43].output)
      || !isDeepStrictEqual(params?.referenceImages,
        state.nodeRuns[41].output?.imageReferenceImages)
      || params?.sceneCutFreshEditReceipt !== undefined
      || request.prompt !== renderWorkflowTemplate(
        A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT,
        { shot_script: state.nodeRuns[11].output,
          scene_cut_sources: state.nodeRuns[41].output,
          scene_cut_opening_state: state.nodeRuns[43].output }))
      fail('v5 request is not the exact running, reviewed 14s edit branch')
    if (retry) {
      const original = decodeExecutionState(originalRow.result)
      assertA8B6FreshV5EditHop(parent, original, parentRow.result_md5,
        signed, rejectedImage, rejectedReview, 'pre-provider-failed')
      assertA8B6FreshV5RuntimeRetryHop(original, state,
        originalRow.result_md5, options.previewOnly ? 'pending' : 'running')
      const failed = (await db.query(`SELECT id,status,task_id,request_data,
        response_data FROM model_execution_records WHERE id=$1`,
      [A8B6_FRESH_V5_PRE_PROVIDER_LEDGER])).rows[0]
      if (failed?.status !== 'failed' || failed.task_id !== null
        || !String(failed.request_data?.requestKey ?? '')
          .startsWith(`${A8B6_FRESH_V5_EDIT_FRAME_ID}:`)
        || failed.response_data?.task_id)
        fail('v5 prior gate failure might have submitted a provider task')
    } else assertA8B6FreshV5EditHop(parent, state, parentRow.result_md5,
      signed, rejectedImage, rejectedReview,
      options.previewOnly ? 'pending' : 'running')
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

/** Request-level post-binder byte and order guard. */
export async function verifyA8B6FreshV5EditPaidRequest(request,
  root = process.cwd()) {
  const signed = await verifyA8B6FreshV5EditReceipt(root)
  const marker = request?.params?.sceneCutFreshImage
  if (marker?.version !== A8B6_FRESH_V5_EDIT_FRAME_VERSION
    || marker.editReceiptSha256 !== signed.receiptSha256
    || ![A8B6_FRESH_V5_EDIT_FRAME_ID,
      A8B6_FRESH_V5_RUNTIME_RETRY_ID].includes(
        request?.executionContext?.requestKey?.split(':')[0])
    || canonical(request?.params?.sceneCutFreshEditReceipt)
      !== canonical(signed.receipt)
    || canonical(request?.params?.referenceImages)
      !== canonical(signed.referenceImages))
    fail('paid v5 edit request changed after signed source binding')
  return { receiptSha256: signed.receiptSha256 }
}
