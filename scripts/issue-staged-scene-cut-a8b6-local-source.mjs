#!/usr/bin/env node
/** Sign a reproducible local first-frame source, without approving its image. */
import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { A8B6_FRESH_EDIT_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_V4_IMAGE_MD5, A8B6_FRESH_V4_IMAGE_SHA,
  A8B6_FRESH_V4_IMAGE_URL, A8B6_FRESH_V4_REVIEW_SHA,
  verifyA8B6FreshV5EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v5.mjs'
import { verifyA8B6FreshV7EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { verifyA8B6FreshV8EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID,
  verifyA8B6V7DualOutputRecoveryReceiptAsync,
  verifyA8B6V7DualOutputClarification } from
  '../server/staged-scene-cut-a8b6-v7-dual-output.mjs'
import { A8B6_V7_REJECTED_MD5, A8B6_V7_REVIEW_SHA } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { A8B6_LOCAL_COMPOSITE_RECEIPT_VERSION,
  A8B6_LOCAL_COMPOSITE_MARKER_VERSION,
  A8B6_LOCAL_COMPOSITE_PRIOR_V8,
  verifyA8B6LocalCompositeSourceReceipt } from
  '../server/staged-scene-cut-a8b6-local-composite-admission.mjs'
import { renderA8B6LocalFirstFrame } from
  '../server/staged-scene-cut-a8b6-local-pixels.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const fail = reason => { throw Error(`A8B6_LOCAL_SOURCE_ISSUE_INVALID: ${reason}`) }
const args = process.argv.slice(2)
if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
  fail('only --apply is supported')
const apply = args.length === 1

const [selection, clarification, v4, v7, v8, rendered] = await Promise.all([
  verifyA8B6V7DualOutputRecoveryReceiptAsync(root),
  Promise.resolve(verifyA8B6V7DualOutputClarification(root)),
  verifyA8B6FreshV5EditReceipt(root),
  verifyA8B6FreshV7EditReceipt(root),
  verifyA8B6FreshV8EditReceipt(root),
  renderA8B6LocalFirstFrame(root),
])
if (rendered.outputSha256 !==
  'f0c8fcc82fae74e8d736bb5e099471a799280db5e7b9d64b4e149efc26314ba1')
  fail('renderer no longer reproduces the selected local candidate')

// The failed V8 workflow is a source constraint, not a usable approval.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('BEGIN READ ONLY')
  const prior = A8B6_LOCAL_COMPOSITE_PRIOR_V8
  const row = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1`, [prior.executionId])).rows[0]
  const ledgers = (await db.query(`SELECT id,status FROM model_execution_records
    WHERE id=ANY($1)`, [[prior.imageModelExecutionId,
    prior.reviewModelExecutionId]])).rows
  const byLedger = new Map(ledgers.map(item => [item.id, item]))
  const state = row && decodeExecutionState(row.result)
  const review = state?.nodeRuns?.[49]?.output
  if (row?.result_md5 !== prior.resultMd5
    || state?.nodeRuns?.[45]?.status !== 'success'
    || state?.nodeRuns?.[49]?.status !== 'success'
    || review?.passed !== false
    || sha(canonical(review)) !== prior.rejectedReviewSha256
    || state?.nodeRuns?.[50]?.status !== 'idle'
    || byLedger.get(prior.imageModelExecutionId)?.status !== 'succeeded'
    || byLedger.get(prior.reviewModelExecutionId)?.status !== 'succeeded')
    fail('V8 rejected workflow or its two real model ledgers changed')
  await db.query('ROLLBACK')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }

const implementationFile = path.join(root,
  'server/staged-scene-cut-a8b6-local-pixels.mjs')
const body = {
  version: A8B6_LOCAL_COMPOSITE_RECEIPT_VERSION,
  markerVersion: A8B6_LOCAL_COMPOSITE_MARKER_VERSION,
  sources: [
    { role: 'base-layout', executionId: A8B6_V7_DUAL_OUTPUT_CHILD_ID,
      resultMd5: A8B6_V7_REJECTED_MD5,
      url: selection.receipt.imageUrl,
      sha256: selection.receipt.normalizedImageSha256 },
    { role: 'donor-face', executionId: A8B6_FRESH_EDIT_FRAME_ID,
      resultMd5: A8B6_FRESH_V4_IMAGE_MD5,
      url: A8B6_FRESH_V4_IMAGE_URL,
      sha256: A8B6_FRESH_V4_IMAGE_SHA },
  ],
  sourceReceipts: {
    v7SelectionSha256: selection.receiptSha256,
    v7ClarificationSha256: clarification.clarificationSha256,
    v4ReviewSha256: A8B6_FRESH_V4_REVIEW_SHA,
    v4EditSha256: v4.receiptSha256,
    v7RejectedReviewSha256: A8B6_V7_REVIEW_SHA,
    v8EditSha256: v8.receiptSha256,
  },
  priorV8: A8B6_LOCAL_COMPOSITE_PRIOR_V8,
  algorithm: { id: rendered.algorithmId,
    implementationSha256: sha(await readFile(implementationFile)),
    parameters: rendered.algorithmParameters },
  output: { url: `/generated/image-${rendered.outputSha256.slice(0, 32)}.png`,
    sha256: rendered.outputSha256, width: 1536, height: 864 },
  allowedRegions: rendered.allowedRegions,
  pixelProof: rendered.pixelProof,
  target: { executionId: 'record-4x5m31-a8b6-local-face-v1',
    markerVersion: A8B6_LOCAL_COMPOSITE_MARKER_VERSION },
  approvedFirstFrame: false,
  requiresFreshIndependentReview: true,
}
const receiptPath = path.join(root,
  '.runtime/staged-scene-cut-a8b6-local-composite/receipt.json')
const outputPath = path.join(root, 'public', body.output.url.slice(1))
const summary = { mode: apply ? 'signed-local-source' : 'read-only-preview',
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
  await writeFile(outputPath, rendered.pngBytes, { flag: 'wx', mode: 0o600 })
  await writeFile(receiptPath, JSON.stringify({ ...body,
    signature: createHmac('sha256', key).update(canonical(body))
      .digest('hex') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const verified = await verifyA8B6LocalCompositeSourceReceipt(root)
  console.log(JSON.stringify({ ...summary,
    receiptSha256: verified.receiptSha256,
    receiptPath, outputPath, artifactWrites: 2 }, null, 2))
}
