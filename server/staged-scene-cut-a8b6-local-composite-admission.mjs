/** Read-only gates for a locally derived first frame.
 *
 * A provider image ledger is never synthesized for this variant. A signed
 * source receipt proves the source files and algorithm parameters; a separate
 * workflow review and frame certificate must approve the actual output.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { A8B6_FRESH_EDIT_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_V4_IMAGE_MD5, A8B6_FRESH_V4_IMAGE_SHA,
  A8B6_FRESH_V4_REVIEW_SHA, verifyA8B6FreshV5EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v5.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID, A8B6_V7_SELECTION_CLARIFICATION,
  verifyA8B6V7DualOutputRecoveryReceipt,
  verifyA8B6V7DualOutputClarification } from
  './staged-scene-cut-a8b6-v7-dual-output.mjs'
import { A8B6_V7_REJECTED_MD5, A8B6_V7_REVIEW_SHA,
  verifyA8B6FreshV8EditReceipt,
  verifyA8B6FreshV8EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { verifyA8B6FreshV7EditReceiptSync } from
  './staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { renderA8B6LocalFirstFrame } from
  './staged-scene-cut-a8b6-local-pixels.mjs'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'

export const A8B6_LOCAL_COMPOSITE_RECEIPT_VERSION =
  'a8b6-local-first-frame-source-v1'
export const A8B6_LOCAL_COMPOSITE_MARKER_VERSION =
  'scene-cut-a8b6-local-first-frame-v1'
export const A8B6_LOCAL_COMPOSITE_PRIOR_V8 = Object.freeze({
  executionId: 'record-4x5m31-a8b6-fresh-first-frame-v8-edit',
  resultMd5: 'c0d9ba72214c3ba539d5957385f605a6',
  rejectedReviewSha256: '2e92771cca94bfb59a1872a9ee127a29a23eeffad69352efc73f315ebca0be73',
  imageModelExecutionId: 'model-run-mumrlddj-vci9pj8',
  reviewModelExecutionId: 'model-run-mumrwvmg-uq4gil9',
})
const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/
const fail = reason => { throw Error(`A8B6_LOCAL_COMPOSITE_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const receiptFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-local-composite/receipt.json')

function generatedPng(root, url, expectedSha) {
  if (!SHA.test(String(expectedSha))
    || url !== `/generated/image-${expectedSha.slice(0, 32)}.png`)
    fail('PNG URL is not content addressed by its recorded SHA-256')
  const filename = path.join(root, 'public', url.slice(1))
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('PNG is not a regular file')
  const bytes = readFileSync(filename)
  if (sha(bytes) !== expectedSha) fail('PNG bytes changed')
  return bytes
}

function generatedFrontJpeg(root, url, expectedSha) {
  if (!SHA.test(String(expectedSha))
    || url !== `/generated/scene-cut-front-${expectedSha}.jpg`)
    fail('frozen board URL is not content addressed')
  const filename = path.join(root, 'public', url.slice(1))
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('board is not a regular file')
  const bytes = readFileSync(filename)
  if (sha(bytes) !== expectedSha) fail('frozen board bytes changed')
  return bytes
}

/** Local-source signature and immutable byte gate. This does not approve the
 * frame; call the async pixel and workflow gates before admitting a candidate. */
export function verifyA8B6LocalCompositeSourceReceiptSync(root = process.cwd()) {
  const bytes = readFileSync(receiptFile(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = receipt
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  if (key.length !== 32 || !SHA.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
    fail('local source receipt signature changed')
  const sources = body.sources
  const selected = verifyA8B6V7DualOutputRecoveryReceipt(root)
  const clarification = verifyA8B6V7DualOutputClarification(root)
  const v4 = verifyA8B6FreshV5EditReceiptSync(root)
  const v7 = verifyA8B6FreshV7EditReceiptSync(root)
  const v8 = verifyA8B6FreshV8EditReceiptSync(root)
  if (body.version !== A8B6_LOCAL_COMPOSITE_RECEIPT_VERSION
    || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || body.target?.markerVersion !== A8B6_LOCAL_COMPOSITE_MARKER_VERSION
    || !/^record-[\w-]+$/.test(String(body.target?.executionId))
    || !Array.isArray(sources) || sources.length !== 2
    || sources[0]?.role !== 'base-layout'
    || sources[0].executionId !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || sources[0].resultMd5 !== A8B6_V7_REJECTED_MD5
    || sources[0].sha256 !== selected.receipt.normalizedImageSha256
    || sources[0].url !== selected.receipt.imageUrl
    || sources[1]?.role !== 'donor-face'
    || sources[1].sha256 !== A8B6_FRESH_V4_IMAGE_SHA
    || sources[1].resultMd5 !== A8B6_FRESH_V4_IMAGE_MD5
    || sources[1].executionId !== A8B6_FRESH_EDIT_FRAME_ID
    || sources.some(source => !/^record-[\w-]+$/.test(String(source.executionId))
      || !MD5.test(String(source.resultMd5))
      || !SHA.test(String(source.sha256)))
    || body.sourceReceipts?.v7SelectionSha256 !== selected.receiptSha256
    || body.sourceReceipts?.v7ClarificationSha256
      !== clarification.clarificationSha256
    || body.sourceReceipts?.v4ReviewSha256 !== A8B6_FRESH_V4_REVIEW_SHA
    || body.sourceReceipts?.v4EditSha256 !== v4.receiptSha256
    || body.sourceReceipts?.v7RejectedReviewSha256 !== A8B6_V7_REVIEW_SHA
    || body.sourceReceipts?.v8EditSha256 !== v8.receiptSha256
    || canonical(body.priorV8) !== canonical(A8B6_LOCAL_COMPOSITE_PRIOR_V8)
    || selected.receipt.normalizedImageSha256
      !== v8.receipt.referenceOrder[2].sourceSha256
    || clarification.clarification.statement
      !== A8B6_V7_SELECTION_CLARIFICATION
    || !SHA.test(String(body.algorithm?.implementationSha256))
    || !/^[a-z0-9-]+-v\d+$/.test(String(body.algorithm?.id))
    || !SHA.test(String(body.output?.sha256))
    || body.output?.width !== 1536 || body.output?.height !== 864
    || body.pixelProof?.outsideAllowedChangedPixels !== 0
    || !Number.isInteger(body.pixelProof?.changedPixels)
    || body.pixelProof.changedPixels <= 0
    || !Array.isArray(body.allowedRegions)
    || body.allowedRegions.length < 1)
    fail('local source receipt lacks required roles, algorithm or pixel proof')
  const outputBytes = generatedPng(root, body.output.url, body.output.sha256)
  const baseBytes = generatedPng(root, sources[0].url, sources[0].sha256)
  generatedPng(root, sources[1].url, sources[1].sha256)
  generatedFrontJpeg(root, v7.receipt.referenceOrder[1].frontUrl,
    v7.receipt.referenceOrder[1].sha256)
  return { receipt, receiptSha256: sha(bytes), baseBytes, outputBytes }
}

function contains(region, x, y) {
  if (region?.type === 'rect') {
    const { left, top, width, height } = region
    if (![left, top, width, height].every(Number.isInteger)
      || left < 0 || top < 0 || width < 1 || height < 1
      || left + width > 1536 || top + height > 864)
      fail('invalid rectangular local edit region')
    return x >= left && x < left + width && y >= top && y < top + height
  }
  if (region?.type === 'ellipse') {
    const { centerX, centerY, radiusX, radiusY } = region
    if (![centerX, centerY, radiusX, radiusY].every(Number.isFinite)
      || radiusX <= 0 || radiusY <= 0
      || centerX - radiusX < 0 || centerY - radiusY < 0
      || centerX + radiusX >= 1536 || centerY + radiusY >= 864)
      fail('invalid elliptical local edit region')
    return ((x - centerX) / radiusX) ** 2
      + ((y - centerY) / radiusY) ** 2 < 1
  }
  fail('unsupported local edit region')
}

/** Independently decode two PNGs and prove the entire non-ROI picture is
 * bit identical. No image generation or file write occurs here. */
export async function inspectA8B6LocalCompositePixels(baseBytes, outputBytes,
  allowedRegions) {
  if (!Array.isArray(allowedRegions) || allowedRegions.length < 1)
    fail('no signed local edit region')
  // Validate every region before the scan; `some()` below may short circuit.
  for (const region of allowedRegions) contains(region, 0, 0)
  const inputs = await Promise.all([baseBytes, outputBytes].map(async bytes => {
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 2_000_000 })
    const meta = await image.metadata()
    if (meta.format !== 'png' || meta.width !== 1536 || meta.height !== 864
      || meta.space !== 'srgb' || meta.hasProfile || meta.depth !== 'uchar')
      fail('local image must be native 1536x864 sRGB PNG')
    return image.ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true })
  }))
  const [base, output] = inputs
  if (base.info.channels !== 4 || output.info.channels !== 4
    || base.data.length !== output.data.length)
    fail('local image channel shape changed')
  let changedPixels = 0, outsideAllowedChangedPixels = 0
  let minX = 1536, minY = 864, maxX = -1, maxY = -1
  for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) {
    const i = (y * 1536 + x) * 4
    if (base.data[i + 3] !== 255 || output.data[i + 3] !== 255)
      fail('local PNG cannot contain transparent pixels')
    if (base.data[i] === output.data[i]
      && base.data[i + 1] === output.data[i + 1]
      && base.data[i + 2] === output.data[i + 2]) continue
    changedPixels++
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    if (!allowedRegions.some(region => contains(region, x, y)))
      outsideAllowedChangedPixels++
  }
  if (!changedPixels || outsideAllowedChangedPixels)
    fail('local output changed nothing or changed pixels outside signed ROI')
  return { changedPixels, outsideAllowedChangedPixels,
    changedBounds: { minX, minY, maxX, maxY } }
}

/** Re-render both signed source PNGs in memory. The output must equal the
 * selected PNG byte for byte, including its encoding. */
export async function verifyA8B6LocalCompositeSourceReceipt(
  root = process.cwd()) {
  const signed = verifyA8B6LocalCompositeSourceReceiptSync(root)
  const v8Source = await verifyA8B6FreshV8EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const prior = A8B6_LOCAL_COMPOSITE_PRIOR_V8
    const row = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1`, [prior.executionId])).rows[0]
    const history = decodeExecutionState(row?.result)
    const image = history?.nodeRuns?.[45]
    const review = history?.nodeRuns?.[49]
    const ledgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=ANY($1)`, [[prior.imageModelExecutionId,
        prior.reviewModelExecutionId]])).rows
    const byId = new Map(ledgers.map(ledger => [ledger.id, ledger]))
    const imageLedger = byId.get(prior.imageModelExecutionId)
    const reviewLedger = byId.get(prior.reviewModelExecutionId)
    const imageUrl = image?.output?.url
    const imageSha = /^\/generated\/image-([a-f0-9]{32})\.png$/.test(
      String(imageUrl)) ? sha(readFileSync(path.join(root, 'public',
        imageUrl.slice(1)))) : undefined
    if (row?.result_md5 !== prior.resultMd5
      || history?.id !== prior.executionId
      || image?.status !== 'success'
      || review?.status !== 'success'
      || review.output?.passed !== false
      || !Array.isArray(review.output?.issues)
      || review.output.issues.length !== 2
      || sha(canonical(review.output)) !== prior.rejectedReviewSha256
      || imageLedger?.status !== 'succeeded'
      || !SHA.test(String(imageSha))
      || imageUrl !== `/generated/image-${imageSha.slice(0, 32)}.png`
      || imageLedger.response_data?.raw?.image?.sha256 !== imageSha
      || imageLedger.response_data?.data?.[0]?.url !== imageUrl
      || imageLedger.request_data?.params?.sceneCutFreshEditReceipt?.signature
        !== v8Source.receipt.signature
      || imageLedger.request_data?.params?.sceneCutFreshImage?.version
        !== history.sceneCutA8B6FreshFrameRecovery?.version
      || !String(imageLedger.request_data?.requestKey ?? '')
        .startsWith(`${prior.executionId}:`)
      || ledgers.length !== 2
      || assertSceneCutReviewLedgerRecord(reviewLedger, review.output,
        { evidence: history.nodeRuns[48].output,
          shot: history.nodeRuns[11].output,
          sources: history.nodeRuns[41].output,
          reviewImages: history.nodeRuns[48].output.reviewImages,
          openingStatePlan: history.nodeRuns[43].output,
          sceneCutFreshImage: history.sceneCutA8B6FreshFrameRecovery },
        root, 180) !== prior.reviewModelExecutionId)
      fail('prior V8 rejection, native image or model ledgers changed')
    await db.query('ROLLBACK')
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
  const rendered = await renderA8B6LocalFirstFrame(root)
  const algorithmFile = new URL('./staged-scene-cut-a8b6-local-pixels.mjs',
    import.meta.url)
  if (signed.receipt.algorithm.id !== rendered.algorithmId
    || signed.receipt.algorithm.implementationSha256
      !== sha(readFileSync(algorithmFile))
    || canonical(signed.receipt.algorithm.parameters)
      !== canonical(rendered.algorithmParameters)
    || canonical(signed.receipt.sources.map(source => source.sha256))
      !== canonical(rendered.sourceSha256s)
    || signed.receipt.output.sha256 !== rendered.outputSha256
    || !signed.outputBytes.equals(rendered.pngBytes)
    || canonical(signed.receipt.allowedRegions)
      !== canonical(rendered.allowedRegions))
    fail('deterministic renderer, implementation or output PNG changed')
  const observed = await inspectA8B6LocalCompositePixels(signed.baseBytes,
    signed.outputBytes, signed.receipt.allowedRegions)
  if (canonical(observed) !== canonical(signed.receipt.pixelProof)
    || canonical(observed) !== canonical(rendered.pixelProof))
    fail('signed local pixel proof differs from independently decoded PNGs')
  return { ...signed, pixelProof: observed }
}

/** Layer after the source receipt and native model review ledger have been
 * checked by the workflow admission. Passing a QA preview cannot satisfy it. */
export function assertA8B6LocalCompositeWorkflowResult({ receipt,
  receiptSha256, execution, imageLedgers, reviewLedgerCount,
  frameCertificateSha256 }) {
  const runs = execution?.nodeRuns
  const marker = execution?.sceneCutA8B6LocalFrameRecovery
  if (receipt?.target?.executionId !== execution?.id
    || !SHA.test(String(receiptSha256))
    || !SHA.test(String(receipt?.output?.sha256))
    || marker?.version !== A8B6_LOCAL_COMPOSITE_MARKER_VERSION
    || marker.sourceReceiptSha256 !== receiptSha256
    || !Array.isArray(runs) || runs[45]?.status !== 'success'
    || runs[45].output?.sourceBoundLocalComposite?.sourceReceiptSha256
      !== receiptSha256
    || runs[45].output.url !== receipt.output.url
    || runs[48]?.status !== 'success'
    || runs[49]?.status !== 'success'
    || runs[49].output?.passed !== true
    || !Array.isArray(runs[49].output?.issues)
    || runs[49].output.issues.length !== 0
    || runs[50]?.status !== 'success'
    || runs[50].output?.passed !== true
    || runs[50].output?.frame?.sourceUrl !== receipt.output.url
    || runs[50].output?.sourceSha256s?.[0] !== receipt.output.sha256
    || !SHA.test(String(frameCertificateSha256))
    || !Array.isArray(imageLedgers) || imageLedgers.length !== 0
    || reviewLedgerCount !== 1)
    fail('local first-frame workflow lacks fresh review, certificate or zero-payment proof')
  return { approvedFirstFrameUrl: receipt.output.url,
    approvedFirstFrameSha256: receipt.output.sha256,
    frameCertificateSha256 }
}
