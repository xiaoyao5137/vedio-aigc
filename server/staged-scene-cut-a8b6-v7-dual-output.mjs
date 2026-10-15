/** Admit one image from a completed V7 CLI turn that saved two PNG files. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { constants, lstatSync, openSync, closeSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { normalizeOutputSize } from './codex-image.ts'
import { A8B6_FRESH_V7_EDIT_FRAME_ID,
  A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V6_EDIT_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_V6_REJECTED_MD5,
  assertA8B6FreshV7EditHop, verifyA8B6FreshV7EditReceipt,
  verifyA8B6FreshV7EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v7.mjs'

export const A8B6_V7_DUAL_OUTPUT_CHILD_ID =
  'record-4x5m31-a8b6-fresh-v7-dual-output-recovery'
export const A8B6_V7_DUAL_OUTPUT_VERSION =
  'scene-cut-a8b6-v7-dual-output-recovery-v1'
export const A8B6_V7_FAILED_MD5 = 'f8b8552b474de60fd830b17a3d4354d1'
export const A8B6_V7_FAILED_IMAGE_LEDGER = 'model-run-mumpcpcb-qayj0nx'
export const A8B6_V7_THREAD_ID = '01a0ed51-7716-7b80-95c5-b263fd81206c'
export const A8B6_V7_SOURCE_IMAGES = Object.freeze([
  { name: 'exec-b48f9659-ead8-4646-9146-cb1f5f2835c2.png',
    sha256: '2ae3d2a6ec014e0ce36d08cd8bbfaaa15ddef789d3ece244246c14547469990f',
    bytes: 2584726 },
  { name: 'exec-33c66bc7-453e-4684-8121-52906395129d.png',
    sha256: 'e42f42cd96c0e90850acd08fddb5106acd2eae378c7b8b4e4cff383937d52578',
    bytes: 2496870 },
])
const fail = reason => { throw Error(`A8B6_V7_DUAL_OUTPUT_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const receiptFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-v7-dual-output/receipt.json')
const clarificationFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-v7-dual-output/clarification.json')
export const A8B6_V7_SELECTION_CLARIFICATION =
  'The completion order of the two PNG files is unknown. The selected SHA-256 image was chosen from the two retained outputs for its narrower, darker Yan beard and more natural lower-left ground; no timing claim is used for admission.'
const sourceFolder = () => path.join(process.env.CODEX_HOME ??
  path.join(homedir(), '.codex'), 'generated_images', A8B6_V7_THREAD_ID)

function readOriginals() {
  const folder = sourceFolder()
  const names = readdirSync(folder).filter(name => name.endsWith('.png')).sort()
  if (!isDeepStrictEqual(names, A8B6_V7_SOURCE_IMAGES.map(x => x.name).sort()))
    fail('CLI thread no longer has exactly the two recorded PNG files')
  return A8B6_V7_SOURCE_IMAGES.map(source => {
    const file = path.join(folder, source.name)
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== source.bytes)
      fail('source PNG type or byte length changed')
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try { bytes = readFileSync(fd) } finally { closeSync(fd) }
    if (sha(bytes) !== source.sha256
      || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      fail('source PNG hash or signature changed')
    return { ...source, bytesBuffer: bytes }
  })
}

export async function prepareA8B6V7DualOutputRecovery(root = process.cwd()) {
  const edit = await verifyA8B6FreshV7EditReceipt(root)
  const original = readOriginals()
  for (const source of original) {
    const pixels = await sharp(source.bytesBuffer,
      { failOn: 'error', limitInputPixels: 50_000_000 }).raw().toBuffer()
    if (!pixels.length) fail('source PNG cannot be fully decoded')
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_FRESH_V6_EDIT_FRAME_ID, A8B6_FRESH_V7_EDIT_FRAME_ID]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timingRow = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const rejectedRow = byId.get(A8B6_FRESH_V6_EDIT_FRAME_ID)
    const failedRow = byId.get(A8B6_FRESH_V7_EDIT_FRAME_ID)
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    if (rows.length !== 3 || rows.some(row => row.workflow_id !== 'wf-sanguo-history-drama')
      || timingRow?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || rejectedRow?.result_md5 !== A8B6_FRESH_V6_REJECTED_MD5
      || failedRow?.result_md5 !== A8B6_V7_FAILED_MD5
      || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5)
      fail('signed timing, rejected source, failed V7 or graph changed')
    const timing = decodeExecutionState(timingRow.result)
    const rejected = decodeExecutionState(rejectedRow.result)
    const failed = decodeExecutionState(failedRow.result)
    assertA8B6FreshV7EditHop(timing, failed, timingRow.result_md5,
      edit, rejected, 'dual-output-failed')
    const ledgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`,
    [`${A8B6_FRESH_V7_EDIT_FRAME_ID}:%`])).rows
    if (ledgers.length !== 1) fail('failed request does not have one unique ledger')
    const ledger = ledgers[0], request = ledger.request_data ?? {},
      params = request.params ?? {}, response = ledger.response_data ?? {},
      raw = response.raw ?? {}, marker = failed.sceneCutA8B6FreshFrameRecovery
    const refs = edit.referenceImages.map((value, index) => {
      const bytes = Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64')
      return { index: index + 1, bytes: bytes.length, sha256: sha(bytes) }
    })
    if (ledger.id !== A8B6_V7_FAILED_IMAGE_LEDGER
      || ledger.status !== 'failed' || ledger.provider !== 'Codex'
      || ledger.capability !== 'image'
      || ledger.error !== 'CODEX_IMAGE_COUNT_INVALID: 本次线程必须恰好保存1张 PNG 图片'
      || raw.imageCount !== 2 || raw.threadId !== A8B6_V7_THREAD_ID
      || raw.exitCode !== 0 || raw.provider !== 'Codex'
      || !Array.isArray(raw.eventTypes)
      || !raw.eventTypes.some(item => item?.[0] === 'turn.completed')
      || !String(request.requestKey ?? '').startsWith(`${A8B6_FRESH_V7_EDIT_FRAME_ID}:`)
      || !isDeepStrictEqual(params.sceneCutFreshImage, marker)
      || !isDeepStrictEqual(params.sceneCutFreshEditReceipt, edit.receipt)
      || !isDeepStrictEqual(params.sceneCutShot, failed.nodeRuns[11].output)
      || !isDeepStrictEqual(
        { ...params.sceneCutSources, imageReferenceImages: undefined },
        { ...failed.nodeRuns[41].output, imageReferenceImages: undefined })
      || !isDeepStrictEqual(params.sceneCutOpeningPlan, failed.nodeRuns[43].output)
      || !isDeepStrictEqual(params.referenceImages,
        edit.referenceImages.map(value => `[素材内容已隐藏，${value.length} 字符]`))
      || !isDeepStrictEqual(raw.references, refs)
      || request.prompt !== renderWorkflowTemplate(
        A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT,
        { shot_script: failed.nodeRuns[11].output,
          scene_cut_sources: failed.nodeRuns[41].output,
          scene_cut_opening_state: failed.nodeRuns[43].output }))
      fail('failed CLI ledger differs from the signed four-reference request')
    const normalizeInfo = {}
    const normalized = await normalizeOutputSize(original[0].bytesBuffer,
      '1536x864', normalizeInfo)
    const normalizedSha256 = sha(normalized)
    const imageUrl = `/generated/image-${normalizedSha256.slice(0, 32)}.png`
    const body = {
      version: 'a8b6-v7-dual-output-selection-v1',
      failedExecutionId: failed.id, failedResultMd5: failedRow.result_md5,
      failedImageModelExecutionId: ledger.id,
      failedRequestKey: request.requestKey,
      threadId: A8B6_V7_THREAD_ID,
      editReceiptSha256: edit.receiptSha256,
      imageCount: 2, sourceImages: A8B6_V7_SOURCE_IMAGES,
      selectedSourceSha256: original[0].sha256,
      unselectedSourceSha256: original[1].sha256,
      selectionReason: 'earlier completed PNG has the narrower darker Yan beard and natural lower-left ground; both complete outputs retained for audit',
      requestedSize: '1536x864', outputSize: normalizeInfo.outputSize,
      normalizedImageSha256: normalizedSha256,
      normalizedImageBytes: normalized.length, imageUrl,
      targetExecutionId: A8B6_V7_DUAL_OUTPUT_CHILD_ID,
      requiresIndependentReview: true, providerRetryAuthorized: false,
    }
    await db.query('ROLLBACK')
    return { body, normalized }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

export function verifyA8B6V7DualOutputRecoveryReceipt(root = process.cwd()) {
  const bytes = readFileSync(receiptFile(root)), receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = receipt
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  const edit = verifyA8B6FreshV7EditReceiptSync(root)
  if (key.length !== 32 || !/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || body.version !== 'a8b6-v7-dual-output-selection-v1'
    || body.failedExecutionId !== A8B6_FRESH_V7_EDIT_FRAME_ID
    || body.failedResultMd5 !== A8B6_V7_FAILED_MD5
    || body.failedImageModelExecutionId !== A8B6_V7_FAILED_IMAGE_LEDGER
    || body.threadId !== A8B6_V7_THREAD_ID
    || body.editReceiptSha256 !== edit.receiptSha256
    || body.imageCount !== 2
    || !isDeepStrictEqual(body.sourceImages, A8B6_V7_SOURCE_IMAGES)
    || body.selectedSourceSha256 !== A8B6_V7_SOURCE_IMAGES[0].sha256
    || body.unselectedSourceSha256 !== A8B6_V7_SOURCE_IMAGES[1].sha256
    || body.targetExecutionId !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || body.requiresIndependentReview !== true
    || body.providerRetryAuthorized !== false
    || body.imageUrl !== `/generated/image-${body.normalizedImageSha256?.slice(0, 32)}.png`)
    fail('signed dual-output selection changed')
  readOriginals()
  const image = readFileSync(path.join(root, 'public', body.imageUrl.slice(1)))
  if (sha(image) !== body.normalizedImageSha256
    || image.length !== body.normalizedImageBytes)
    fail('selected normalized PNG is not the signed output')
  return { receipt, receiptSha256: sha(bytes) }
}

export async function verifyA8B6V7DualOutputRecoveryReceiptAsync(root = process.cwd()) {
  const signed = verifyA8B6V7DualOutputRecoveryReceipt(root)
  const prepared = await prepareA8B6V7DualOutputRecovery(root)
  const { signature: _signature, ...body } = signed.receipt
  if (canonical(body) !== canonical(prepared.body)
    || sha(prepared.normalized) !== body.normalizedImageSha256)
    fail('selected output differs from original failed turn or source DB')
  return signed
}

/** Additive erratum: retain the original signed selection while excluding an
 * unsupported completion-order phrase from creative and workflow admission. */
export function verifyA8B6V7DualOutputClarification(root = process.cwd()) {
  const source = verifyA8B6V7DualOutputRecoveryReceipt(root)
  const bytes = readFileSync(clarificationFile(root))
  const clarification = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = clarification
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  if (key.length !== 32 || !/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || body.version !== 'a8b6-v7-dual-output-selection-clarification-v1'
    || body.sourceReceiptSha256 !== source.receiptSha256
    || body.selectedSourceSha256 !== source.receipt.selectedSourceSha256
    || body.unselectedSourceSha256 !== source.receipt.unselectedSourceSha256
    || body.statement !== A8B6_V7_SELECTION_CLARIFICATION
    || body.completionOrderKnown !== false
    || body.requiredForWorkflowAdmission !== true)
    fail('additive selection clarification changed')
  return { clarification, clarificationSha256: sha(bytes) }
}

export function assertA8B6V7DualOutputRecoveryHop(parent, child,
  parentMd5, signed, phase = 'image-complete') {
  const before = parent?.nodeRuns, runs = child?.nodeRuns
  const marker = child?.sceneCutA8B6V7DualOutputRecovery
  const receipt = signed?.receipt
  if (parent?.id !== A8B6_FRESH_V7_EDIT_FRAME_ID
    || parentMd5 !== A8B6_V7_FAILED_MD5
    || child?.id !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || child.parentExecutionId !== parent.id
    || child.generationScopeId !== child.id
    || child.requestScopeId !== parent.requestScopeId
    || !Array.isArray(before) || !Array.isArray(runs)
    || before.length !== 464 || runs.length !== before.length
    || !isDeepStrictEqual(runs.slice(0, 45), before.slice(0, 45))
    || marker?.version !== A8B6_V7_DUAL_OUTPUT_VERSION
    || marker.parentExecutionId !== parent.id
    || marker.parentResultMd5 !== parentMd5
    || marker.failedImageModelExecutionId !== A8B6_V7_FAILED_IMAGE_LEDGER
    || marker.receiptSha256 !== signed.receiptSha256
    || marker.selectedSourceSha256 !== receipt.selectedSourceSha256
    || marker.normalizedImageSha256 !== receipt.normalizedImageSha256
    || marker.imageUrl !== receipt.imageUrl
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(before.slice(0, 45)))
    || marker.firstPendingIndex !== 46
    || !isDeepStrictEqual(child.sceneCutA8B6FreshFrameRecovery,
      parent.sceneCutA8B6FreshFrameRecovery)
    || runs[45]?.status !== 'success'
    || runs[45].output?.url !== receipt.imageUrl
    || runs[45].output?.sourceBoundDualOutput?.receiptSha256
      !== signed.receiptSha256
    || runs[45].output.sourceBoundDualOutput.failedImageModelExecutionId
      !== A8B6_V7_FAILED_IMAGE_LEDGER)
    fail('child changed failed request history, selected PNG or signed source')
  if (phase === 'image-complete' && runs.slice(46).some(run => run.status !== 'idle'))
    fail('recovery child did not start at post-image boundary')
  if (phase === 'review-rejected'
    && (runs[49]?.status !== 'success'
      || runs[49].output?.passed !== false
      || runs[49].output?.hardChecks?.castAndIdentity !== false
      || runs[50]?.status !== 'idle'))
    fail('recovery child lacks its genuine rejected identity review')
  if (['review-complete', 'approval-running', 'approved'].includes(phase)
    && (runs[49]?.status !== 'success' || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])))
    fail('selected output has not passed an independent new review')
  if (phase === 'approval-running' && runs[50]?.status !== 'running'
    || phase === 'approved' && runs[50]?.status !== 'success')
    fail('selected output lacks its own frame certificate')
  return true
}
