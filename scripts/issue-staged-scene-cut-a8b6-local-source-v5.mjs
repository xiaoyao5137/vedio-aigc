#!/usr/bin/env node
/** Write-once V5 source receipt. The V4 model retry was a real rejection. */
import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { A8B6_LOCAL_V5_FRAME_ID, A8B6_LOCAL_V5_FRAME_VERSION } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { verifyA8B6LocalCompositeSourceReceiptV4 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v4.mjs'
import { verifyA8B6LocalV5RejectedV4Ancestry } from
  '../server/staged-scene-cut-a8b6-local-v5-rejected-ancestry.mjs'
import { renderA8B6LocalFirstFrameV5 } from
  '../server/staged-scene-cut-a8b6-local-pixels-v5.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const fail = reason => { throw Error(`A8B6_LOCAL_V5_SOURCE_INVALID: ${reason}`) }
const args = process.argv.slice(2)
if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
  fail('only --apply is supported')
const apply = args.length === 1
const writeOnceOrVerify = async (filename, bytes) => {
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (!(await readFile(filename)).equals(bytes))
      fail(`existing artifact changed: ${filename}`)
  }
}

const [rendered, ancestry, v4] = await Promise.all([
  renderA8B6LocalFirstFrameV5(root),
  verifyA8B6LocalV5RejectedV4Ancestry(root),
  verifyA8B6LocalCompositeSourceReceiptV4(root),
])
const wall = rendered.provenance?.imageGen?.wall
if (ancestry.sourceReceiptSha256 !== v4.receiptSha256
  || rendered.sourceSha256s?.[0] !== v4.receipt.output.sha256
  || rendered.sourceSha256s?.[1] !== wall?.rawOutput?.sha256
  || rendered.pixelProof?.outsideAllowedChangedPixels !== 0
  || ancestry.rejectedImageSha256 !== rendered.sourceSha256s[0])
  fail('V4 rejection, wall source or isolated pixel proof changed')
const body = {
  version: 'a8b6-local-first-frame-source-v5',
  markerVersion: A8B6_LOCAL_V5_FRAME_VERSION,
  sources: [
    { role: 'base-layout', executionId: ancestry.rejected.executionId,
      resultMd5: ancestry.rejected.failedResultMd5,
      url: v4.receipt.output.url, sha256: v4.receipt.output.sha256 },
    { role: 'wall-imagegen', tool: 'image_gen__imagegen',
      archivePath: wall.rawOutput.path, sha256: wall.rawOutput.sha256 },
  ],
  sourceReceipts: { localV4SourceReceiptSha256: v4.receiptSha256 },
  priorLocalV4: ancestry.rejected,
  imageGen: rendered.provenance.imageGen,
  algorithm: { id: rendered.algorithmId,
    implementationSha256: sha(await readFile(path.join(root,
      'server/staged-scene-cut-a8b6-local-pixels-v5.mjs'))),
    parameters: rendered.algorithmParameters },
  output: { url: `/generated/image-${rendered.outputSha256.slice(0, 32)}.png`,
    sha256: rendered.outputSha256, width: 1536, height: 864 },
  allowedRegions: rendered.allowedRegions,
  pixelProof: rendered.pixelProof,
  target: { executionId: A8B6_LOCAL_V5_FRAME_ID,
    markerVersion: A8B6_LOCAL_V5_FRAME_VERSION },
  approvedFirstFrame: false,
  requiresFreshIndependentReview: true,
}
const receiptPath = path.join(root,
  '.runtime/staged-scene-cut-a8b6-local-composite-v5/receipt.json')
const outputPath = path.join(root, 'public', body.output.url.slice(1))
const summary = { mode: apply ? 'signed-local-v5-source' : 'read-only-preview',
  output: body.output, pixelProof: body.pixelProof,
  priorLocalV4: ancestry.rejected,
  targetExecutionId: body.target.executionId,
  approvedFirstFrame: false, providerCalls: 0, databaseWrites: 0 }
if (!apply) console.log(JSON.stringify({ ...summary, artifactWrites: 0 }, null, 2))
else {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('signing key invalid')
  await mkdir(path.dirname(receiptPath), { recursive: true })
  await writeOnceOrVerify(outputPath, rendered.pngBytes)
  const receiptBytes = Buffer.from(JSON.stringify({ ...body,
    signature: createHmac('sha256', key).update(canonical(body))
      .digest('hex') }, null, 2) + '\n')
  await writeOnceOrVerify(receiptPath, receiptBytes)
  const { verifyA8B6LocalCompositeSourceReceiptV5 } = await import(
    '../server/staged-scene-cut-a8b6-local-composite-admission-v5.mjs')
  const verified = await verifyA8B6LocalCompositeSourceReceiptV5(root)
  console.log(JSON.stringify({ ...summary,
    receiptSha256: verified.receiptSha256,
    receiptPath, outputPath, artifactWrites: 2 }, null, 2))
}
