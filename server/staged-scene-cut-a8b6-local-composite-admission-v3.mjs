/** Signed wall/gate/face source admission. V3 remains unapproved until node49/50. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { A8B6_LOCAL_V3_REJECTED_V2,
  verifyA8B6LocalV3RejectedV2Ancestry } from
  './staged-scene-cut-a8b6-local-v3-rejected-ancestry.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV2Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v2.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_V3_COMPOSITE_INVALID: ${reason}`) }
const SHA = /^[a-f0-9]{64}$/
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
  '.runtime/staged-scene-cut-a8b6-local-composite-v3/receipt.json')

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
  return Array.isArray(regions) && regions.length === 3
    && regions[0]?.role === 'wall'
    && regions[1]?.role === 'gate-frame'
    && regions[2]?.role === 'yan-face'
    && regions.every(region => Array.isArray(region.polygons)
      && region.polygons.length >= 1 && region.polygons.length <= 16
      && region.polygons.every(polygon => Array.isArray(polygon)
        && polygon.length >= 3 && polygon.length <= 32
        && polygon.every(point => Array.isArray(point)
          && point.length === 2 && point.every(Number.isInteger)
          && point[0] >= 0 && point[0] < 1536
          && point[1] >= 0 && point[1] < 864)))
}

/** Local HMAC and archived bytes. The async gate below also replays all pixels. */
export function verifyA8B6LocalCompositeSourceReceiptV3Sync(
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
    Buffer.from(expected, 'hex'))) fail('signed V3 receipt changed')
  const v2 = verifyA8B6LocalCompositeSourceReceiptV2Sync(root)
  const sources = body.sources, imageGen = body.imageGen
  if (!keys(body, ['version', 'markerVersion', 'sources',
    'sourceReceipts', 'priorLocalV2', 'imageGen', 'algorithm', 'output',
    'allowedRegions', 'pixelProof', 'target', 'approvedFirstFrame',
    'requiresFreshIndependentReview'])
    || body.version !== 'a8b6-local-first-frame-source-v3'
    || body.markerVersion !== 'scene-cut-a8b6-local-first-frame-v3'
    || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || !same(body.target, {
      executionId: 'record-4x5m31-a8b6-local-face-wall-v3',
      markerVersion: body.markerVersion })
    || !same(body.priorLocalV2, A8B6_LOCAL_V3_REJECTED_V2)
    || !same(body.sourceReceipts,
      { localV2SourceReceiptSha256: v2.receiptSha256 })
    || !Array.isArray(sources) || sources.length !== 4
    || !same(sources[0], { role: 'base-layout',
      executionId: A8B6_LOCAL_V3_REJECTED_V2.executionId,
      resultMd5: A8B6_LOCAL_V3_REJECTED_V2.resultMd5,
      url: v2.receipt.output.url, sha256: v2.receipt.output.sha256 })
    || !keys(sources[1], ['role', 'tool', 'archivePath', 'sha256'])
    || !keys(sources[2], ['role', 'tool', 'archivePath', 'sha256'])
    || !keys(sources[3], ['role', 'tool', 'archivePath', 'sha256'])
    || sources[1].role !== 'wall-imagegen'
    || sources[2].role !== 'face-imagegen'
    || sources[3].role !== 'gate-frame-imagegen'
    || sources.slice(1).some(source => source.tool !== 'image_gen__imagegen')
    || !SHA.test(String(sources[1]?.sha256))
    || !SHA.test(String(sources[2]?.sha256))
    || !SHA.test(String(sources[3]?.sha256))
    || !keys(imageGen, ['wall', 'face', 'gateFrame'])
    || imageGen.wall?.tool !== 'image_gen__imagegen'
    || imageGen.face?.tool !== 'image_gen__imagegen'
    || imageGen.gateFrame?.tool !== 'image_gen__imagegen'
    || imageGen.wall?.rawOutput?.path !== sources[1].archivePath
    || imageGen.wall.rawOutput.sha256 !== sources[1].sha256
    || imageGen.face?.rawOutput?.path !== sources[2].archivePath
    || imageGen.face.rawOutput.sha256 !== sources[2].sha256
    || imageGen.gateFrame?.rawOutput?.path !== sources[3].archivePath
    || imageGen.gateFrame.rawOutput.sha256 !== sources[3].sha256
    || !SHA.test(String(imageGen.wall.promptSha256))
    || !SHA.test(String(imageGen.face.promptSha256))
    || !SHA.test(String(imageGen.gateFrame.promptSha256))
    || sha(imageGen.wall.prompt ?? '') !== imageGen.wall.promptSha256
    || sha(imageGen.face.prompt ?? '') !== imageGen.face.promptSha256
    || sha(imageGen.gateFrame.prompt ?? '')
      !== imageGen.gateFrame.promptSha256
    || typeof body.algorithm?.id !== 'string'
    || !SHA.test(String(body.algorithm.implementationSha256))
    || !SHA.test(String(body.output?.sha256))
    || body.output.url
      !== `/generated/image-${body.output.sha256.slice(0, 32)}.png`
    || body.output.width !== 1536 || body.output.height !== 864
    || !validRegions(body.allowedRegions)
    || body.pixelProof?.outsideAllowedChangedPixels !== 0
    || !Number.isInteger(body.pixelProof.changedPixels)
    || body.pixelProof.changedPixels <= 0)
    fail('V3 source, rejected ancestry or three-region contract changed')
  return { receipt, receiptSha256: sha(bytes),
    baseBytes: regularBytes(root, `public${sources[0].url}`,
      sources[0].sha256),
    wallRawBytes: regularBytes(root, sources[1].archivePath,
      sources[1].sha256),
    faceRawBytes: regularBytes(root, sources[2].archivePath,
      sources[2].sha256),
    gateFrameRawBytes: regularBytes(root, sources[3].archivePath,
      sources[3].sha256),
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

/** Full decoded comparison. Overlaps belong to the last rendered signed ROI. */
export async function inspectA8B6LocalCompositePixelsV3(baseBytes,
  outputBytes, regions) {
  if (!validRegions(regions)) fail('wall, gate-frame and face polygons required')
  const [base, output] = await Promise.all([baseBytes, outputBytes]
    .map(async bytes => {
      const image = sharp(bytes, { failOn: 'error', limitInputPixels: 2_000_000 })
      const meta = await image.metadata()
      if (meta.format !== 'png' || meta.width !== 1536
        || meta.height !== 864 || meta.space !== 'srgb'
        || meta.hasProfile || meta.depth !== 'uchar')
        fail('V3 source/output must be 1536x864 sRGB PNG')
      return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    }))
  if (base.info.channels !== 4 || output.info.channels !== 4)
    fail('V3 image channels changed')
  let changedPixels = 0, outsideAllowedChangedPixels = 0
  const perRegion = [0, 0, 0]
  let minX = 1536, minY = 864, maxX = -1, maxY = -1
  for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) {
    const offset = (y * 1536 + x) * 4
    if (base.data[offset + 3] !== 255 || output.data[offset + 3] !== 255)
      fail('transparent pixels cannot hide a change')
    const inside = regions.map(region => region.polygons.some(polygon =>
      insidePolygon(polygon, x + .5, y + .5)))
    if (base.data[offset] === output.data[offset]
      && base.data[offset + 1] === output.data[offset + 1]
      && base.data[offset + 2] === output.data[offset + 2]) continue
    changedPixels++
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    const finalRegion = inside.lastIndexOf(true)
    if (finalRegion < 0) outsideAllowedChangedPixels++
    else perRegion[finalRegion]++
  }
  if (!changedPixels || outsideAllowedChangedPixels || perRegion.includes(0))
    fail('wall/gate/face unchanged or pixels changed outside signed ROI')
  return { changedPixels, outsideAllowedChangedPixels,
    changedBounds: { minX, minY, maxX, maxY } }
}

/** Rebuilds the V3 source from archived inputs and rechecks real V2 rejection. */
export async function verifyA8B6LocalCompositeSourceReceiptV3(
  root = process.cwd()) {
  const signed = verifyA8B6LocalCompositeSourceReceiptV3Sync(root)
  const ancestry = await verifyA8B6LocalV3RejectedV2Ancestry(root)
  if (signed.receipt.sourceReceipts.localV2SourceReceiptSha256
    !== ancestry.sourceReceiptSha256)
    fail('V2 signed source changed')
  const { renderA8B6LocalFirstFrameV3 } = await import(
    './staged-scene-cut-a8b6-local-pixels-v3.mjs')
  const rendered = await renderA8B6LocalFirstFrameV3(root)
  const moduleBytes = readFileSync(new URL(
    './staged-scene-cut-a8b6-local-pixels-v3.mjs', import.meta.url))
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
    fail('V3 imagegen sources, renderer or output changed')
  const observed = await inspectA8B6LocalCompositePixelsV3(
    signed.baseBytes, signed.outputBytes, signed.receipt.allowedRegions)
  if (!same(observed, signed.receipt.pixelProof)
    || !same(observed, rendered.pixelProof))
    fail('independent pixel scan differs from signed V3 proof')
  return { ...signed, pixelProof: observed }
}

/** A paid request needs a different child and a real model pass/certificate. */
export function assertA8B6LocalCompositeWorkflowResultV3({ receipt,
  receiptSha256, execution, imageLedgers, reviewLedgerCount,
  frameCertificateSha256 }) {
  const runs = execution?.nodeRuns
  const marker = execution?.sceneCutA8B6LocalFrameRecovery
  if (receipt?.target?.executionId !== execution?.id
    || !SHA.test(String(receiptSha256))
    || marker?.version !== 'scene-cut-a8b6-local-first-frame-v3'
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
    fail('V3 lacks independent review, certificate or zero-image-payment proof')
  return { approvedFirstFrameUrl: receipt.output.url,
    approvedFirstFrameSha256: receipt.output.sha256,
    frameCertificateSha256 }
}
