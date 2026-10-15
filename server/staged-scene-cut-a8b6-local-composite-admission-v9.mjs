/** Signed V9 timber-only source. V8's real rejection is image ancestry,
 * never first-frame approval. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import sharp from 'sharp'
import { A8B6_LOCAL_V9_REJECTED_V8,
  verifyA8B6LocalV9RejectedV8Ancestry } from
  './staged-scene-cut-a8b6-local-v9-rejected-ancestry.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV8Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v8.mjs'
import { A8B6_LOCAL_V9_PIXEL_ALGORITHM_ID,
  A8B6_LOCAL_V9_PIXEL_PARAMETERS,
  renderA8B6LocalFirstFrameV9 } from
  './staged-scene-cut-a8b6-local-pixels-v9.mjs'
import { verifySourceInCallTree } from
  './staged-scene-cut-a8b6-source-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_V9_COMPOSITE_INVALID: ${reason}`) }
const SHA = /^[a-f0-9]{64}$/
const OUTPUT_SHA =
  '683f51931e8e02325c22d594a1af007019471bc46532d10deaba70b47d57ee04'
const RAW = { path: 'qa/staged-scene-cut/wall-imagegen-v9-full-raw.png',
  sha256: 'e3d99b8e6dc46fc34ff700b4681c5d8c792c9f920e1371e7cf31d42c671bc36a' }
const PROMPT_SHA =
  'c5dd6fc637171c2fe8cf45beb7f48c435f273a64e9fa338a7ba36012268f148b'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const same = (a, b) => isDeepStrictEqual(a, b)
const receiptFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-local-composite-v9/receipt.json')

const insidePolygon = (polygon, x, y) => {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y)
      && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** Independent decoded-pixel scan. The signed ROI extends past the image
 * edge so the rightmost visible column receives full donor pixels. */
export async function inspectA8B6LocalCompositePixelsV9(baseBytes,
  outputBytes, regions) {
  if (!same(regions, [{ role: 'timber',
    polygons: A8B6_LOCAL_V9_PIXEL_PARAMETERS.polygons }]))
    fail('timber polygon changed')
  const [base, output] = await Promise.all([baseBytes, outputBytes]
    .map(async bytes => {
      const image = sharp(bytes, { failOn: 'error', limitInputPixels: 2_000_000 })
      const meta = await image.metadata()
      if (meta.format !== 'png' || meta.width !== 1536
        || meta.height !== 864 || meta.space !== 'srgb'
        || meta.hasProfile || meta.depth !== 'uchar')
        fail('V9 source/output must be 1536x864 sRGB PNG')
      return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    }))
  if (base.info.channels !== 4 || output.info.channels !== 4)
    fail('V9 image channels changed')
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
    if (!regions[0].polygons.some(polygon =>
      insidePolygon(polygon, x + .5, y + .5)))
      outsideAllowedChangedPixels++
  }
  if (!changedPixels || outsideAllowedChangedPixels)
    fail('timber unchanged or pixels changed outside signed ROI')
  return { changedPixels, outsideAllowedChangedPixels,
    changedBounds: { minX, minY, maxX, maxY } }
}

function regularBytes(root, relativePath, expectedSha) {
  if (!SHA.test(String(expectedSha)) || typeof relativePath !== 'string'
    || relativePath.startsWith('/') || relativePath.includes('..')
    || !/^(?:qa\/staged-scene-cut|public\/generated)\/[\w.-]+$/.test(relativePath))
    fail('source path or SHA invalid')
  const filename = path.join(root, relativePath)
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('source is not a regular file')
  const bytes = readFileSync(filename)
  if (sha(bytes) !== expectedSha) fail('source bytes changed')
  return bytes
}

export function verifyA8B6LocalCompositeSourceReceiptV9Sync(
  root = process.cwd()) {
  const bytes = readFileSync(receiptFile(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = receipt
  if (key.length !== 32 || !SHA.test(String(signature)))
    fail('source signature invalid')
  const expected = createHmac('sha256', key).update(canonical(body))
    .digest('hex')
  if (!timingSafeEqual(Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex'))) fail('signed V9 receipt changed')
  const v8 = verifyA8B6LocalCompositeSourceReceiptV8Sync(root)
  const source = body.sources, imageGen = body.imageGen?.wall
  const expectedFields = ['version', 'markerVersion', 'sources',
    'sourceReceipts', 'priorLocalV8', 'imageGen', 'algorithm', 'output',
    'allowedRegions', 'pixelProof', 'target', 'approvedFirstFrame',
    'requiresFreshIndependentReview']
  if (!same(Object.keys(body).sort(), expectedFields.sort())
    || body.version !== 'a8b6-local-first-frame-source-v9'
    || body.markerVersion !== 'scene-cut-a8b6-local-first-frame-v9'
    || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || !same(body.target, {
      executionId: 'record-4x5m31-a8b6-local-wall-v9',
      markerVersion: body.markerVersion })
    || !same(body.priorLocalV8, A8B6_LOCAL_V9_REJECTED_V8)
    || !same(body.sourceReceipts,
      { localV8SourceReceiptSha256: v8.receiptSha256 })
    || !Array.isArray(source) || source.length !== 2
    || !same(source[0], { role: 'base-layout',
      executionId: A8B6_LOCAL_V9_REJECTED_V8.executionId,
      resultMd5: A8B6_LOCAL_V9_REJECTED_V8.resultMd5,
      url: v8.receipt.output.url, sha256: v8.receipt.output.sha256 })
    || !same(source[1], { role: 'wall-imagegen',
      tool: 'image_gen__imagegen', archivePath: RAW.path,
      sha256: RAW.sha256 })
    || imageGen?.tool !== 'image_gen__imagegen'
    || imageGen.transparentBackground !== false
    || imageGen.promptSha256 !== PROMPT_SHA
    || sha(imageGen.prompt ?? '') !== PROMPT_SHA
    || !same(imageGen.references, [{
      path: `public${v8.receipt.output.url}`,
      sha256: v8.receipt.output.sha256,
      identityAuthority: false }])
    || !same(imageGen.rawOutput, {
      path: RAW.path, sha256: RAW.sha256, width: 1672, height: 941 })
    || body.algorithm?.id !== A8B6_LOCAL_V9_PIXEL_ALGORITHM_ID
    || !same(body.algorithm.parameters, A8B6_LOCAL_V9_PIXEL_PARAMETERS)
    || !SHA.test(String(body.algorithm.implementationSha256))
    || body.output?.sha256 !== OUTPUT_SHA
    || body.output.url !== `/generated/image-${OUTPUT_SHA.slice(0, 32)}.png`
    || body.output.width !== 1536 || body.output.height !== 864
    || !same(body.allowedRegions, [{ role: 'timber',
      polygons: A8B6_LOCAL_V9_PIXEL_PARAMETERS.polygons }])
    || body.pixelProof?.outsideAllowedChangedPixels !== 0
    || body.pixelProof.changedPixels !== 11727)
    fail('V9 source, rejected V8 ancestry or timber-only bounds changed')
  return { receipt, receiptSha256: sha(bytes),
    baseBytes: regularBytes(root, `public${source[0].url}`,
      source[0].sha256),
    wallRawBytes: regularBytes(root, RAW.path, RAW.sha256),
    outputBytes: regularBytes(root, `public${body.output.url}`,
      body.output.sha256) }
}

export async function verifyA8B6LocalCompositeSourceReceiptV9(
  root = process.cwd()) {
  return verifySourceInCallTree('v9', root, async () => {
    const signed = verifyA8B6LocalCompositeSourceReceiptV9Sync(root)
    const [ancestry, rendered] = await Promise.all([
      verifyA8B6LocalV9RejectedV8Ancestry(root),
      renderA8B6LocalFirstFrameV9(root),
    ])
    const source = signed.receipt.sources
    const moduleBytes = readFileSync(new URL(
      './staged-scene-cut-a8b6-local-pixels-v9.mjs', import.meta.url))
    if (signed.receipt.sourceReceipts.localV8SourceReceiptSha256
        !== ancestry.sourceReceiptSha256
      || ancestry.rejectedImageSha256 !== source[0].sha256
      || signed.receipt.algorithm.id !== rendered.algorithmId
      || signed.receipt.algorithm.implementationSha256 !== sha(moduleBytes)
      || !same(signed.receipt.algorithm.parameters,
        rendered.algorithmParameters)
      || !same(source.map(item => item.sha256), rendered.sourceSha256s)
      || !same(signed.receipt.imageGen, rendered.provenance.imageGen)
      || !same(signed.receipt.allowedRegions, rendered.allowedRegions)
      || signed.receipt.output.sha256 !== rendered.outputSha256
      || !signed.outputBytes.equals(rendered.pngBytes)
      || !same(signed.receipt.pixelProof, rendered.pixelProof))
      fail('V9 imagegen source, rejected ledger, renderer or output changed')
    const observed = await inspectA8B6LocalCompositePixelsV9(
      signed.baseBytes, signed.outputBytes, signed.receipt.allowedRegions)
    if (!same(observed, signed.receipt.pixelProof))
      fail('independent pixel scan differs from signed V9 proof')
    return { ...signed, pixelProof: observed }
  })
}

export function assertA8B6LocalCompositeWorkflowResultV9({ receipt,
  receiptSha256, execution, imageLedgers, reviewLedgerCount,
  frameCertificateSha256 }) {
  const runs = execution?.nodeRuns
  const marker = execution?.sceneCutA8B6LocalFrameRecovery
  if (receipt?.target?.executionId !== execution?.id
    || !SHA.test(String(receiptSha256))
    || marker?.version !== 'scene-cut-a8b6-local-first-frame-v9'
    || marker.sourceReceiptSha256 !== receiptSha256
    || runs?.[45]?.status !== 'success'
    || runs[45].output?.sourceBoundLocalComposite?.sourceReceiptSha256
      !== receiptSha256
    || runs[45].output?.url !== receipt.output?.url
    || runs[48]?.status !== 'success'
    || runs[49]?.status !== 'success'
    || runs[49].output?.passed !== true
    || !same(runs[49].output.issues, [])
    || runs[50]?.status !== 'success'
    || runs[50].output?.passed !== true
    || runs[50].output?.frame?.sourceUrl !== receipt.output.url
    || runs[50].output?.sourceSha256s?.[0] !== receipt.output.sha256
    || !SHA.test(String(frameCertificateSha256))
    || !Array.isArray(imageLedgers) || imageLedgers.length !== 0
    || reviewLedgerCount !== 1)
    fail('V9 lacks independent review, certificate or zero-image-payment proof')
  return { approvedFirstFrameUrl: receipt.output.url,
    approvedFirstFrameSha256: receipt.output.sha256,
    frameCertificateSha256 }
}
