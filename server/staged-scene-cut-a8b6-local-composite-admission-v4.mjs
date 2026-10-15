/** Signed V4 wall-only source. V3 remains a rejected ancestor. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { A8B6_LOCAL_V4_REJECTED_V3,
  verifyA8B6LocalV4RejectedV3Ancestry } from
  './staged-scene-cut-a8b6-local-v4-rejected-ancestry.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV3Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v3.mjs'
import { A8B6_LOCAL_V4_PIXEL_ALGORITHM_ID,
  A8B6_LOCAL_V4_PIXEL_PARAMETERS } from
  './staged-scene-cut-a8b6-local-pixels-v4.mjs'
import { verifySourceInCallTree } from
  './staged-scene-cut-a8b6-source-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_V4_COMPOSITE_INVALID: ${reason}`) }
const SHA = /^[a-f0-9]{64}$/
const RAW = Object.freeze({ path: 'qa/staged-scene-cut/wall-imagegen-v4-raw.png',
  sha256: '241ff3bbb9b100385e1c2dd01dc79124523111242bf0da29660711da1e9015c3' })
const OUTPUT_SHA =
  'de30188b2385c89494a294557044a0b0f7d42aefb82d090c7ab31dd7cf28861c'
const WALL_REFERENCE_SHA =
  'c61fa0a1c3625017d4a0e83afe9b1f19dab61b5c2ee084e343b0078195fae683'
const WALL_PROMPT_SHA =
  '85d2a2c7535e64148ea319600776724856a8abb0a58c1115f74b3b5fae7948a7'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const same = (a, b) => canonical(a) === canonical(b)
const keys = (value, expected) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const receiptFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-local-composite-v4/receipt.json')

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

function validRegions(regions) {
  return Array.isArray(regions) && regions.length === 1
    && regions[0]?.role === 'wall'
    && Array.isArray(regions[0].polygons)
    && regions[0].polygons.length >= 1
    && regions[0].polygons.length <= 16
    && regions[0].polygons.every(polygon => Array.isArray(polygon)
      && polygon.length >= 3 && polygon.length <= 32
      && polygon.every(point => Array.isArray(point)
        && point.length === 2 && point.every(Number.isInteger)
        && point[0] >= 0 && point[0] < 1536
        && point[1] >= 0 && point[1] < 864))
}

/** Local signature and archived-byte gate; V4 cannot borrow V3 acceptance. */
export function verifyA8B6LocalCompositeSourceReceiptV4Sync(
  root = process.cwd()) {
  const bytes = readFileSync(receiptFile(root))
  const receipt = JSON.parse(bytes.toString('utf8'))
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const { signature, ...body } = receipt
  if (key.length !== 32 || !SHA.test(String(signature)))
    fail('source signing key or signature invalid')
  const expected = createHmac('sha256', key).update(canonical(body))
    .digest('hex')
  if (!timingSafeEqual(Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex'))) fail('signed V4 receipt changed')
  const v3 = verifyA8B6LocalCompositeSourceReceiptV3Sync(root)
  const sources = body.sources, imageGen = body.imageGen
  if (!keys(body, ['version', 'markerVersion', 'sources',
    'sourceReceipts', 'priorLocalV3', 'imageGen', 'algorithm', 'output',
    'allowedRegions', 'pixelProof', 'target', 'approvedFirstFrame',
    'requiresFreshIndependentReview'])
    || body.version !== 'a8b6-local-first-frame-source-v4'
    || body.markerVersion !== 'scene-cut-a8b6-local-first-frame-v4'
    || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || !same(body.target, {
      executionId: 'record-4x5m31-a8b6-local-wall-v4',
      markerVersion: body.markerVersion })
    || !same(body.priorLocalV3, A8B6_LOCAL_V4_REJECTED_V3)
    || !same(body.sourceReceipts,
      { localV3SourceReceiptSha256: v3.receiptSha256 })
    || !Array.isArray(sources) || sources.length !== 2
    || !same(sources[0], { role: 'base-layout',
      executionId: A8B6_LOCAL_V4_REJECTED_V3.executionId,
      resultMd5: A8B6_LOCAL_V4_REJECTED_V3.resultMd5,
      url: v3.receipt.output.url, sha256: v3.receipt.output.sha256 })
    || !same(sources[1], { role: 'wall-imagegen',
      tool: 'image_gen__imagegen', archivePath: RAW.path,
      sha256: RAW.sha256 })
    || !keys(imageGen, ['wall'])
    || imageGen.wall?.tool !== 'image_gen__imagegen'
    || imageGen.wall.transparentBackground !== false
    || imageGen.wall.promptSha256 !== WALL_PROMPT_SHA
    || sha(imageGen.wall.prompt ?? '') !== imageGen.wall.promptSha256
    || !same(imageGen.wall.references, [{
      path: 'qa/staged-scene-cut/wall-target-local-crop-v4.png',
      sha256: WALL_REFERENCE_SHA,
      sourceSha256: sources[0].sha256,
      crop: { left: 430, top: 0, width: 704, height: 704 },
      resizedTo: { width: 1024, height: 1024 },
      identityAuthority: false,
    }])
    || imageGen.wall.rawOutput?.path !== RAW.path
    || imageGen.wall.rawOutput.sha256 !== RAW.sha256
    || body.algorithm?.id !== A8B6_LOCAL_V4_PIXEL_ALGORITHM_ID
    || !same(body.algorithm.parameters, A8B6_LOCAL_V4_PIXEL_PARAMETERS)
    || !SHA.test(String(body.algorithm.implementationSha256))
    || body.output?.sha256 !== OUTPUT_SHA
    || body.output.url
      !== `/generated/image-${body.output.sha256.slice(0, 32)}.png`
    || body.output.width !== 1536 || body.output.height !== 864
    || !validRegions(body.allowedRegions)
    || body.pixelProof?.outsideAllowedChangedPixels !== 0
    || !Number.isInteger(body.pixelProof.changedPixels)
    || body.pixelProof.changedPixels <= 0)
    fail('V4 source or rejected V3 ancestry changed')
  return { receipt, receiptSha256: sha(bytes),
    baseBytes: regularBytes(root, `public${sources[0].url}`,
      sources[0].sha256),
    wallRawBytes: regularBytes(root, RAW.path, RAW.sha256),
    outputBytes: regularBytes(root, `public${body.output.url}`,
      body.output.sha256) }
}

function insidePolygon(polygon, x, y) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y)
      && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Independent native-resolution pixel scan, including alpha and ROI edges. */
export async function inspectA8B6LocalCompositePixelsV4(baseBytes,
  outputBytes, regions) {
  if (!validRegions(regions)) fail('one wall region required')
  const [base, output] = await Promise.all([baseBytes, outputBytes]
    .map(async bytes => {
      const image = sharp(bytes, { failOn: 'error', limitInputPixels: 2_000_000 })
      const meta = await image.metadata()
      if (meta.format !== 'png' || meta.width !== 1536
        || meta.height !== 864 || meta.space !== 'srgb'
        || meta.hasProfile || meta.depth !== 'uchar')
        fail('V4 source/output must be 1536x864 sRGB PNG')
      return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    }))
  if (base.info.channels !== 4 || output.info.channels !== 4)
    fail('V4 image channels changed')
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
    fail('wall unchanged or pixels changed outside signed ROI')
  return { changedPixels, outsideAllowedChangedPixels,
    changedBounds: { minX, minY, maxX, maxY } }
}

/** Full admission replays the producer algorithm and V3's real rejection. */
export async function verifyA8B6LocalCompositeSourceReceiptV4(
  root = process.cwd()) {
  return verifySourceInCallTree('v4', root, async () => {
    const signed = verifyA8B6LocalCompositeSourceReceiptV4Sync(root)
    const ancestry = await verifyA8B6LocalV4RejectedV3Ancestry(root)
    if (signed.receipt.sourceReceipts.localV3SourceReceiptSha256
      !== ancestry.sourceReceiptSha256
      || signed.receipt.sources[0].sha256 !== ancestry.rejectedImageSha256)
      fail('V3 signed source or rejected image changed')
    const { renderA8B6LocalFirstFrameV4 } = await import(
      './staged-scene-cut-a8b6-local-pixels-v4.mjs')
    const rendered = await renderA8B6LocalFirstFrameV4(root)
    const moduleBytes = readFileSync(new URL(
      './staged-scene-cut-a8b6-local-pixels-v4.mjs', import.meta.url))
    if (signed.receipt.algorithm.id !== rendered.algorithmId
      || signed.receipt.algorithm.implementationSha256 !== sha(moduleBytes)
      || !same(signed.receipt.algorithm.parameters, rendered.algorithmParameters)
      || !same(signed.receipt.sources.map(source => source.sha256),
        rendered.sourceSha256s)
      || !same(signed.receipt.imageGen, rendered.provenance?.imageGen)
      || !same(signed.receipt.allowedRegions, rendered.allowedRegions)
      || signed.receipt.output.sha256 !== rendered.outputSha256
      || !signed.outputBytes.equals(rendered.pngBytes)
      || !same(signed.receipt.pixelProof, rendered.pixelProof))
      fail('V4 imagegen source, renderer or output changed')
    const observed = await inspectA8B6LocalCompositePixelsV4(
      signed.baseBytes, signed.outputBytes, signed.receipt.allowedRegions)
    if (!same(observed, signed.receipt.pixelProof)
      || !same(observed, rendered.pixelProof))
      fail('independent pixel scan differs from signed V4 proof')
    return { ...signed, pixelProof: observed }
  })
}

/** Media admission requires an independent V4 node49 pass and node50 cert. */
export function assertA8B6LocalCompositeWorkflowResultV4({ receipt,
  receiptSha256, execution, imageLedgers, reviewLedgerCount,
  frameCertificateSha256 }) {
  const runs = execution?.nodeRuns
  const marker = execution?.sceneCutA8B6LocalFrameRecovery
  if (receipt?.target?.executionId !== execution?.id
    || !SHA.test(String(receiptSha256))
    || marker?.version !== 'scene-cut-a8b6-local-first-frame-v4'
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
    || !SHA.test(String(frameCertificateSha256))
    || !Array.isArray(imageLedgers) || imageLedgers.length !== 0
    || reviewLedgerCount !== 1)
    fail('V4 lacks independent review, certificate or zero-image-payment proof')
  return { approvedFirstFrameUrl: receipt.output.url,
    approvedFirstFrameSha256: receipt.output.sha256,
    frameCertificateSha256 }
}
