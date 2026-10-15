/** Source-bound admission for the separate imagegen-face local v2 candidate.
 * This module never treats a local composite as a succeeded image provider run. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { A8B6_LOCAL_V2_FRAME_ID } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID,
  A8B6_FRESH_FRAME_PARENT_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID,
  verifyA8B6V7DualOutputRecoveryReceipt,
  verifyA8B6V7DualOutputClarification } from
  './staged-scene-cut-a8b6-v7-dual-output.mjs'
import { A8B6_V7_REJECTED_MD5 } from
  './staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { verifyA8B6LocalCompositeSourceReceiptSync,
  verifyA8B6LocalCompositeSourceReceipt } from
  './staged-scene-cut-a8b6-local-composite-admission.mjs'
import { renderA8B6LocalFirstFrameV2 } from
  './staged-scene-cut-a8b6-local-pixels-v2.mjs'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { assertA8B6LocalFrameHop } from
  '../scripts/fork-original-shot1-a8b6-local-face.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_V2_COMPOSITE_INVALID: ${reason}`) }
const SHA = /^[a-f0-9]{64}$/
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const same = (left, right) => canonical(left) === canonical(right)
const exactKeys = (value, names) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',')
const receiptFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-local-composite-v2/receipt.json')
const V1 = Object.freeze({ executionId: 'record-4x5m31-a8b6-local-face-v1',
  resultMd5: '43176cd739ba633eaa0568a827d9c4b4',
  rejectedReviewSha256:
    '00071a2d91b9c1fe3a917c424056ed068e552d98d04f02e6f48380ec479bce4a',
  reviewModelExecutionId: 'model-run-mumtwqnv-e0u5nqy',
  imageLedgerCount: 0, frameApprovalStatus: 'idle' })
const RAW = Object.freeze({ path:
  'qa/staged-scene-cut/yan-imagegen-v2-raw-1494cbd3.png',
  sha256: '1494cbd3acc592bdf181723115fdb653215c95071b35e8424f9d360c9769b4df' })

function regularBytes(root, relativePath, expectedSha) {
  if (!SHA.test(String(expectedSha))
    || typeof relativePath !== 'string'
    || relativePath.startsWith('/') || relativePath.includes('..')
    || !/^(?:qa\/staged-scene-cut|public\/generated)\/[\w.-]+$/.test(relativePath))
    fail('source path or SHA is invalid')
  const filename = path.join(root, relativePath)
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink())
    fail('source is not an immutable regular file')
  const bytes = readFileSync(filename)
  if (sha(bytes) !== expectedSha) fail('source bytes changed')
  return bytes
}

/** HMAC, archived imagegen inputs, V7/V1 rejection provenance, and byte gate.
 * The asynchronous gate below additionally replays pixels and checks DB/ledgers. */
export function verifyA8B6LocalCompositeSourceReceiptV2Sync(
  root = process.cwd()) {
  const bytes = readFileSync(receiptFile(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = receipt
  if (key.length !== 32 || !SHA.test(String(signature)))
    fail('local v2 signing key or signature invalid')
  const expected = createHmac('sha256', key).update(canonical(body))
    .digest('hex')
  if (!timingSafeEqual(Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')))
    fail('local v2 receipt signature changed')
  const v1 = verifyA8B6LocalCompositeSourceReceiptSync(root)
  const selected = verifyA8B6V7DualOutputRecoveryReceipt(root)
  const clarification = verifyA8B6V7DualOutputClarification(root)
  const source = body.sources
  const image = body.imageGen
  if (!exactKeys(body, ['version', 'markerVersion', 'sources',
    'sourceReceipts', 'priorLocalV1', 'imageGen', 'algorithm', 'output',
    'allowedRegions', 'pixelProof', 'target', 'approvedFirstFrame',
    'requiresFreshIndependentReview'])
    || body.version !== 'a8b6-local-first-frame-source-v2'
    || body.markerVersion !== 'scene-cut-a8b6-local-first-frame-v2'
    || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || !same(body.target, { executionId: A8B6_LOCAL_V2_FRAME_ID,
      markerVersion: body.markerVersion })
    || !same(body.priorLocalV1, V1)
    || !Array.isArray(source) || source.length !== 2
    || !same(source[0], { role: 'base-layout',
      executionId: A8B6_V7_DUAL_OUTPUT_CHILD_ID,
      resultMd5: A8B6_V7_REJECTED_MD5,
      url: selected.receipt.imageUrl,
      sha256: selected.receipt.normalizedImageSha256 })
    || !same(source[1], { role: 'imagegen-face',
      tool: 'image_gen__imagegen', archivePath: RAW.path,
      sha256: RAW.sha256 })
    || !same(body.sourceReceipts, {
      v7SelectionSha256: selected.receiptSha256,
      v7ClarificationSha256: clarification.clarificationSha256,
      localV1SourceReceiptSha256: v1.receiptSha256 })
    || image?.tool !== 'image_gen__imagegen'
    || image.transparentBackground !== false
    || !SHA.test(String(image.promptSha256))
    || sha(image.prompt ?? '') !== image.promptSha256
    || image.rawOutput?.path !== RAW.path
    || image.rawOutput.sha256 !== RAW.sha256
    || image.identityBoard?.sha256
      !== '55c299bd043eb89664e44cc18e00caccd8c5ac9f61c2ea6e0eb9b463f191000c'
    || !Array.isArray(image.references) || image.references.length !== 2
    || image.references[0]?.role !== 'target-camera-layout'
    || image.references[0].identityAuthority !== false
    || image.references[0].sourceSha256 !== source[0].sha256
    || image.references[1]?.role !== 'frozen-Yan-identity'
    || image.references[1].identityAuthority !== true
    || image.references[1].sourceSha256 !== image.identityBoard.sha256
    || body.algorithm?.id !== 'v7-imagegen-face-two-roi-v2'
    || !SHA.test(String(body.algorithm.implementationSha256))
    || !SHA.test(String(body.output?.sha256))
    || body.output.url
      !== `/generated/image-${body.output.sha256.slice(0, 32)}.png`
    || body.output.width !== 1536 || body.output.height !== 864
    || !Array.isArray(body.allowedRegions)
    || body.allowedRegions.length !== 2
    || body.allowedRegions.some(region => region.type !== 'polygon'
      || !Array.isArray(region.points))
    || body.pixelProof?.outsideAllowedChangedPixels !== 0
    || !Number.isInteger(body.pixelProof.changedPixels)
    || body.pixelProof.changedPixels <= 0)
    fail('local v2 source, imagegen provenance or ROI contract changed')
  const baseBytes = regularBytes(root,
    `public${source[0].url}`, source[0].sha256)
  const rawBytes = regularBytes(root, RAW.path, RAW.sha256)
  const outputBytes = regularBytes(root,
    `public${body.output.url}`, body.output.sha256)
  for (const ref of image.references)
    regularBytes(root, ref.path, ref.sha256)
  regularBytes(root, image.identityBoard.path,
    image.identityBoard.sha256)
  return { receipt, receiptSha256: sha(bytes), baseBytes,
    rawBytes, outputBytes }
}

function containsPolygon(polygon, x, y) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y)
      && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Independently decode both PNGs. The signed polygon boundary is checked
 * against every pixel, rather than trusting an issuer's aggregate counter. */
export async function inspectA8B6LocalCompositePixelsV2(baseBytes,
  outputBytes, polygons) {
  if (!Array.isArray(polygons) || polygons.length !== 2
    || polygons.some(polygon => !Array.isArray(polygon)
      || polygon.length < 3 || polygon.length > 32
      || polygon.some(point => !Array.isArray(point) || point.length !== 2
        || point.some(value => !Number.isInteger(value))
        || point[0] < 0 || point[0] >= 1536
        || point[1] < 0 || point[1] >= 864)))
    fail('two bounded face polygons are required')
  const images = await Promise.all([baseBytes, outputBytes].map(async bytes => {
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 2_000_000 })
    const meta = await image.metadata()
    if (meta.format !== 'png' || meta.width !== 1536 || meta.height !== 864
      || meta.space !== 'srgb' || meta.hasProfile || meta.depth !== 'uchar')
      fail('local v2 output must be 1536x864 sRGB PNG')
    return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  }))
  const [base, output] = images
  if (base.info.channels !== 4 || output.info.channels !== 4
    || base.data.length !== output.data.length)
    fail('local v2 channels changed')
  let changedPixels = 0, outsideAllowedChangedPixels = 0
  let minX = 1536, minY = 864, maxX = -1, maxY = -1
  for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) {
    const offset = (y * 1536 + x) * 4
    if (base.data[offset + 3] !== 255 || output.data[offset + 3] !== 255)
      fail('transparent pixels cannot hide a change')
    if (base.data[offset] === output.data[offset]
      && base.data[offset + 1] === output.data[offset + 1]
      && base.data[offset + 2] === output.data[offset + 2]) continue
    changedPixels++
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    if (!polygons.some(polygon => containsPolygon(polygon, x + .5, y + .5)))
      outsideAllowedChangedPixels++
  }
  if (!changedPixels || outsideAllowedChangedPixels)
    fail('output changed nothing or changed pixels outside the face polygons')
  return { changedPixels, outsideAllowedChangedPixels,
    changedBounds: { minX, minY, maxX, maxY } }
}

/** Rebuild the candidate from archived sources, then prove V1 actually failed
 * its independent model review. A source receipt alone cannot approve V2. */
export async function verifyA8B6LocalCompositeSourceReceiptV2(
  root = process.cwd()) {
  const signed = verifyA8B6LocalCompositeSourceReceiptV2Sync(root)
  const v1Source = await verifyA8B6LocalCompositeSourceReceipt(root)
  if (signed.receipt.sourceReceipts.localV1SourceReceiptSha256
    !== v1Source.receiptSha256)
    fail('local v1 rejected source receipt changed')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [[A8B6_FRESH_FRAME_PARENT_ID,
      V1.executionId]])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timing = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const v1 = byId.get(V1.executionId)
    const state = decodeExecutionState(v1?.result)
    const runs = state?.nodeRuns
    const imageLedgers = (await db.query(`SELECT id FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`,
    [`${V1.executionId}:%`])).rows
    const reviewLedger = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=$1`, [V1.reviewModelExecutionId])).rows[0]
    if (rows.length !== 2
      || rows.some(row => row.workflow_id !== 'wf-sanguo-history-drama')
      || timing?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || v1?.result_md5 !== V1.resultMd5
      || !runs || runs[49]?.status !== 'success'
      || runs[49].output?.passed !== false
      || !Array.isArray(runs[49].output?.issues)
      || runs[49].output.issues.length !== 1
      || sha(canonical(runs[49].output)) !== V1.rejectedReviewSha256
      || runs[50]?.status !== V1.frameApprovalStatus
      || imageLedgers.length !== V1.imageLedgerCount
      || reviewLedger?.status !== 'succeeded'
      || !String(reviewLedger.request_data?.requestKey ?? '')
        .startsWith(`${V1.executionId}:`))
      fail('local v1 rejected review, DB CAS or zero-payment chain changed')
    assertA8B6LocalFrameHop(decodeExecutionState(timing.result), state,
      timing.result_md5, v1Source, 'review-complete')
    if (assertSceneCutReviewLedgerRecord(reviewLedger,
      runs[49].output, { evidence: runs[48].output,
        shot: runs[11].output, sources: runs[41].output,
        reviewImages: runs[48].output.reviewImages,
        openingStatePlan: runs[43].output,
        sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery },
      root, 180) !== V1.reviewModelExecutionId)
      fail('local v1 rejection lacks its exact model ledger')
    await db.query('ROLLBACK')
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
  const rendered = await renderA8B6LocalFirstFrameV2(root)
  const moduleBytes = readFileSync(new URL(
    './staged-scene-cut-a8b6-local-pixels-v2.mjs', import.meta.url))
  if (signed.receipt.algorithm?.id !== rendered.algorithmId
    || signed.receipt.algorithm.implementationSha256 !== sha(moduleBytes)
    || !same(signed.receipt.algorithm.parameters,
      rendered.algorithmParameters)
    || !same(signed.receipt.sources.map(source => source.sha256),
      rendered.sourceSha256s)
    || !same(signed.receipt.imageGen, rendered.provenance)
    || !same(signed.receipt.allowedRegions, rendered.allowedRegions)
    || signed.receipt.output.sha256 !== rendered.outputSha256
    || !signed.outputBytes.equals(rendered.pngBytes)
    || !same(signed.receipt.pixelProof, rendered.pixelProof))
    fail('imagegen source, deterministic renderer or signed output changed')
  const observed = await inspectA8B6LocalCompositePixelsV2(
    signed.baseBytes, signed.outputBytes,
    signed.receipt.allowedRegions.map(region => region.points))
  if (!same(observed, signed.receipt.pixelProof)
    || !same(observed, rendered.pixelProof))
    fail('independent full-frame pixel scan differs from signed v2 proof')
  return { ...signed, pixelProof: observed }
}

/** Only a truly approved new child can enter an A8 request. */
export function assertA8B6LocalCompositeWorkflowResultV2({ receipt,
  receiptSha256, execution, imageLedgers, reviewLedgerCount,
  frameCertificateSha256 }) {
  const runs = execution?.nodeRuns
  const marker = execution?.sceneCutA8B6LocalFrameRecovery
  if (receipt?.target?.executionId !== execution?.id
    || !/^[a-f0-9]{64}$/.test(String(receiptSha256))
    || marker?.version !== 'scene-cut-a8b6-local-first-frame-v2'
    || marker.sourceReceiptSha256 !== receiptSha256
    || runs?.[45]?.status !== 'success'
    || runs[45].output?.sourceBoundLocalComposite?.sourceReceiptSha256
      !== receiptSha256
    || runs[45].output?.url !== receipt.output?.url
    || runs[48]?.status !== 'success'
    || runs[49]?.status !== 'success'
    || runs[49].output?.passed !== true
    || !Array.isArray(runs[49].output?.issues)
    || runs[49].output.issues.length !== 0
    || runs[50]?.status !== 'success'
    || runs[50].output?.passed !== true
    || runs[50].output?.frame?.sourceUrl !== receipt.output?.url
    || runs[50].output?.sourceSha256s?.[0] !== receipt.output?.sha256
    || !/^[a-f0-9]{64}$/.test(String(frameCertificateSha256))
    || !Array.isArray(imageLedgers) || imageLedgers.length !== 0
    || reviewLedgerCount !== 1)
    fail('local v2 source lacks independent review, certificate or zero-payment proof')
  return { approvedFirstFrameUrl: receipt.output.url,
    approvedFirstFrameSha256: receipt.output.sha256,
    frameCertificateSha256 }
}
