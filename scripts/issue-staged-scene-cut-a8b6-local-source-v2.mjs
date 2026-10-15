#!/usr/bin/env node
/** Sign the image_gen face-region source; this never approves the first frame. */
import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { A8B6_LOCAL_V2_FRAME_ID, A8B6_LOCAL_V2_FRAME_VERSION } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID,
  verifyA8B6V7DualOutputRecoveryReceiptAsync,
  verifyA8B6V7DualOutputClarification } from
  '../server/staged-scene-cut-a8b6-v7-dual-output.mjs'
import { A8B6_V7_REJECTED_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { verifyA8B6LocalCompositeSourceReceipt } from
  '../server/staged-scene-cut-a8b6-local-composite-admission.mjs'
import { A8B6_LOCAL_V2_SOURCE_FILES,
  renderA8B6LocalFirstFrameV2 } from
  '../server/staged-scene-cut-a8b6-local-pixels-v2.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const fail = reason => { throw Error(`A8B6_LOCAL_V2_SOURCE_INVALID: ${reason}`) }
const writeOnceOrVerify = async (filename, bytes) => {
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readFile(filename)
    if (!existing.equals(bytes))
      fail(`existing signed artifact bytes changed: ${filename}`)
  }
}
const args = process.argv.slice(2)
if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
  fail('only --apply is supported')
const apply = args.length === 1

const [selection, clarification, localV1, rendered] = await Promise.all([
  verifyA8B6V7DualOutputRecoveryReceiptAsync(root),
  Promise.resolve(verifyA8B6V7DualOutputClarification(root)),
  verifyA8B6LocalCompositeSourceReceipt(root),
  renderA8B6LocalFirstFrameV2(root),
])
if (rendered.outputSha256 !==
  '63a701c1c4b38ae9fa04c450d13b8089b3220977ea2df55d86061c7a75e1d0f5')
  fail('renderer no longer reproduces selected QA image')

const prior = {
  executionId: 'record-4x5m31-a8b6-local-face-v1',
  resultMd5: '43176cd739ba633eaa0568a827d9c4b4',
  rejectedReviewSha256:
    '00071a2d91b9c1fe3a917c424056ed068e552d98d04f02e6f48380ec479bce4a',
  reviewModelExecutionId: 'model-run-mumtwqnv-e0u5nqy',
  imageLedgerCount: 0,
  frameApprovalStatus: 'idle',
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('BEGIN READ ONLY')
  const row = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1`, [prior.executionId])).rows[0]
  const state = row && decodeExecutionState(row.result)
  const ledgers = (await db.query(`SELECT id,status,node_id,
    request_data->>'requestKey' AS request_key
    FROM model_execution_records
    WHERE request_data->>'requestKey' LIKE $1`,
  [`${prior.executionId}:%`])).rows
  const reviewLedger = ledgers.find(item =>
    item.id === prior.reviewModelExecutionId)
  if (row?.result_md5 !== prior.resultMd5
    || state?.nodeRuns?.[49]?.status !== 'success'
    || state.nodeRuns[49].output?.passed !== false
    || sha(canonical(state.nodeRuns[49].output))
      !== prior.rejectedReviewSha256
    || state.nodeRuns[50]?.status !== prior.frameApprovalStatus
    || ledgers.some(item => item.node_id === 'sanguo-scene-cut-first-frame')
    || reviewLedger?.status !== 'succeeded'
    || reviewLedger.node_id !== 'sanguo-scene-cut-review'
    || localV1.receipt.target.executionId !== prior.executionId)
    fail('local V1 review rejection or no-paid-image history changed')
  await db.query('ROLLBACK')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }

const implementationPath = path.join(root,
  'server/staged-scene-cut-a8b6-local-pixels-v2.mjs')
const body = {
  version: 'a8b6-local-first-frame-source-v2',
  markerVersion: A8B6_LOCAL_V2_FRAME_VERSION,
  sources: [
    { role: 'base-layout', executionId: A8B6_V7_DUAL_OUTPUT_CHILD_ID,
      resultMd5: A8B6_V7_REJECTED_MD5,
      url: selection.receipt.imageUrl,
      sha256: selection.receipt.normalizedImageSha256 },
    { role: 'imagegen-face', tool: 'image_gen__imagegen',
      archivePath: A8B6_LOCAL_V2_SOURCE_FILES.imageGenRaw.path,
      sha256: A8B6_LOCAL_V2_SOURCE_FILES.imageGenRaw.sha256 },
  ],
  sourceReceipts: {
    v7SelectionSha256: selection.receiptSha256,
    v7ClarificationSha256: clarification.clarificationSha256,
    localV1SourceReceiptSha256: localV1.receiptSha256,
  },
  priorLocalV1: prior,
  imageGen: rendered.provenance,
  algorithm: { id: rendered.algorithmId,
    implementationSha256: sha(await readFile(implementationPath)),
    parameters: rendered.algorithmParameters },
  output: { url: `/generated/image-${rendered.outputSha256.slice(0, 32)}.png`,
    sha256: rendered.outputSha256, width: 1536, height: 864 },
  allowedRegions: rendered.allowedRegions,
  pixelProof: rendered.pixelProof,
  target: { executionId: A8B6_LOCAL_V2_FRAME_ID,
    markerVersion: A8B6_LOCAL_V2_FRAME_VERSION },
  approvedFirstFrame: false,
  requiresFreshIndependentReview: true,
}
const receiptPath = path.join(root,
  '.runtime/staged-scene-cut-a8b6-local-composite-v2/receipt.json')
const outputPath = path.join(root, 'public', body.output.url.slice(1))
const summary = { mode: apply ? 'signed-local-v2-source' : 'read-only-preview',
  targetExecutionId: body.target.executionId,
  output: body.output, pixelProof: body.pixelProof,
  implementationSha256: body.algorithm.implementationSha256,
  approvedFirstFrame: false, providerCalls: 0, databaseWrites: 0 }
if (!apply) {
  console.log(JSON.stringify({ ...summary, artifactWrites: 0 }, null, 2))
} else {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('signing key invalid')
  await mkdir(path.dirname(receiptPath), { recursive: true })
  await writeOnceOrVerify(outputPath, rendered.pngBytes)
  const receiptBytes = Buffer.from(JSON.stringify({ ...body,
    signature: createHmac('sha256', key).update(canonical(body))
      .digest('hex') }, null, 2) + '\n')
  await writeOnceOrVerify(receiptPath, receiptBytes)
  const { verifyA8B6LocalCompositeSourceReceiptV2 } = await import(
    '../server/staged-scene-cut-a8b6-local-composite-admission-v2.mjs')
  const verified = await verifyA8B6LocalCompositeSourceReceiptV2(root)
  console.log(JSON.stringify({ ...summary,
    receiptSha256: verified.receiptSha256,
    receiptPath, outputPath, artifactWrites: 2 }, null, 2))
}
