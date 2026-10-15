/** Signed V8 wall-only source. V7's real rejection is its image ancestry,
 * never first-frame approval. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { A8B6_LOCAL_V8_REJECTED_V7,
  verifyA8B6LocalV8RejectedV7Ancestry } from
  './staged-scene-cut-a8b6-local-v8-rejected-ancestry.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV7Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v7.mjs'
import { inspectA8B6LocalCompositePixelsV4 } from
  './staged-scene-cut-a8b6-local-composite-admission-v4.mjs'
import { A8B6_LOCAL_V8_PIXEL_ALGORITHM_ID,
  A8B6_LOCAL_V8_PIXEL_PARAMETERS,
  renderA8B6LocalFirstFrameV8 } from
  './staged-scene-cut-a8b6-local-pixels-v8.mjs'
import { verifySourceInCallTree } from
  './staged-scene-cut-a8b6-source-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_V8_COMPOSITE_INVALID: ${reason}`) }
const SHA = /^[a-f0-9]{64}$/
const OUTPUT_SHA =
  '8149dea0eb98744508ac0615d37d70dcede1d8859c25c0edf301909748a4fb90'
const RAW = { path: 'qa/staged-scene-cut/wall-imagegen-v8-full-raw.png',
  sha256: '3e185620ce34d0d98af75b032a1b1db9c15cd51cf649cbdcbab1ab3f180e4cc6' }
const PROMPT_SHA =
  'f082420eaf157068ef30b1b55fec88f4a81fa13a80b7a06529f7b16db50ae0e3'
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
  '.runtime/staged-scene-cut-a8b6-local-composite-v8/receipt.json')

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

export function verifyA8B6LocalCompositeSourceReceiptV8Sync(
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
    Buffer.from(expected, 'hex'))) fail('signed V8 receipt changed')
  const v7 = verifyA8B6LocalCompositeSourceReceiptV7Sync(root)
  const source = body.sources, imageGen = body.imageGen?.wall
  const expectedFields = ['version', 'markerVersion', 'sources',
    'sourceReceipts', 'priorLocalV7', 'imageGen', 'algorithm', 'output',
    'allowedRegions', 'pixelProof', 'target', 'approvedFirstFrame',
    'requiresFreshIndependentReview']
  if (!same(Object.keys(body).sort(), expectedFields.sort())
    || body.version !== 'a8b6-local-first-frame-source-v8'
    || body.markerVersion !== 'scene-cut-a8b6-local-first-frame-v8'
    || body.approvedFirstFrame !== false
    || body.requiresFreshIndependentReview !== true
    || !same(body.target, {
      executionId: 'record-4x5m31-a8b6-local-wall-v8',
      markerVersion: body.markerVersion })
    || !same(body.priorLocalV7, A8B6_LOCAL_V8_REJECTED_V7)
    || !same(body.sourceReceipts,
      { localV7SourceReceiptSha256: v7.receiptSha256 })
    || !Array.isArray(source) || source.length !== 2
    || !same(source[0], { role: 'base-layout',
      executionId: A8B6_LOCAL_V8_REJECTED_V7.executionId,
      resultMd5: A8B6_LOCAL_V8_REJECTED_V7.resultMd5,
      url: v7.receipt.output.url, sha256: v7.receipt.output.sha256 })
    || !same(source[1], { role: 'wall-imagegen',
      tool: 'image_gen__imagegen', archivePath: RAW.path,
      sha256: RAW.sha256 })
    || imageGen?.tool !== 'image_gen__imagegen'
    || imageGen.transparentBackground !== false
    || imageGen.promptSha256 !== PROMPT_SHA
    || sha(imageGen.prompt ?? '') !== PROMPT_SHA
    || !same(imageGen.references, [{
      path: `public${v7.receipt.output.url}`,
      sha256: v7.receipt.output.sha256,
      identityAuthority: false }])
    || !same(imageGen.rawOutput, {
      path: RAW.path, sha256: RAW.sha256, width: 1672, height: 941 })
    || body.algorithm?.id !== A8B6_LOCAL_V8_PIXEL_ALGORITHM_ID
    || !same(body.algorithm.parameters, A8B6_LOCAL_V8_PIXEL_PARAMETERS)
    || !SHA.test(String(body.algorithm.implementationSha256))
    || body.output?.sha256 !== OUTPUT_SHA
    || body.output.url !== `/generated/image-${OUTPUT_SHA.slice(0, 32)}.png`
    || body.output.width !== 1536 || body.output.height !== 864
    || !same(body.allowedRegions, [{ role: 'wall',
      polygons: A8B6_LOCAL_V8_PIXEL_PARAMETERS.polygons }])
    || body.pixelProof?.outsideAllowedChangedPixels !== 0
    || body.pixelProof.changedPixels !== 69358)
    fail('V8 source, rejected V7 ancestry or wall-only bounds changed')
  return { receipt, receiptSha256: sha(bytes),
    baseBytes: regularBytes(root, `public${source[0].url}`,
      source[0].sha256),
    wallRawBytes: regularBytes(root, RAW.path, RAW.sha256),
    outputBytes: regularBytes(root, `public${body.output.url}`,
      body.output.sha256) }
}

export async function verifyA8B6LocalCompositeSourceReceiptV8(
  root = process.cwd()) {
  return verifySourceInCallTree('v8', root, async () => {
    const signed = verifyA8B6LocalCompositeSourceReceiptV8Sync(root)
    const v7 = verifyA8B6LocalCompositeSourceReceiptV7Sync(root)
    const [ancestry, rendered] = await Promise.all([
      verifyA8B6LocalV8RejectedV7Ancestry(root),
      renderA8B6LocalFirstFrameV8(root),
    ])
    const source = signed.receipt.sources
    const moduleBytes = readFileSync(new URL(
      './staged-scene-cut-a8b6-local-pixels-v8.mjs', import.meta.url))
    if (signed.receipt.sourceReceipts.localV7SourceReceiptSha256
        !== v7.receiptSha256
      || ancestry.sourceReceiptSha256 !== v7.receiptSha256
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
      fail('V8 imagegen source, rejected ledger, renderer or output changed')
    const observed = await inspectA8B6LocalCompositePixelsV4(
      signed.baseBytes, signed.outputBytes, signed.receipt.allowedRegions)
    if (!same(observed, signed.receipt.pixelProof))
      fail('independent pixel scan differs from signed V8 proof')
    return { ...signed, pixelProof: observed }
  })
}

export function assertA8B6LocalCompositeWorkflowResultV8({ receipt,
  receiptSha256, execution, imageLedgers, reviewLedgerCount,
  frameCertificateSha256 }) {
  const runs = execution?.nodeRuns
  const marker = execution?.sceneCutA8B6LocalFrameRecovery
  if (receipt?.target?.executionId !== execution?.id
    || !SHA.test(String(receiptSha256))
    || marker?.version !== 'scene-cut-a8b6-local-first-frame-v8'
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
    fail('V8 lacks independent review, certificate or zero-image-payment proof')
  return { approvedFirstFrameUrl: receipt.output.url,
    approvedFirstFrameSha256: receipt.output.sha256,
    frameCertificateSha256 }
}
