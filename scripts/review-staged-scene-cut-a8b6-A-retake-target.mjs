#!/usr/bin/env node
/** Independent two-image model review. Default is read-only; --apply makes
 * at most one text+vision call with a persisted intent, never a video call. */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from
  '../src/workflow-core.ts'
import { verifyA8B6ARetakeTargetSourceSync } from
  '../server/staged-scene-cut-a8b6-A-retake-target.mjs'
import { issueA8B6ARetakeTargetReviewEvidence,
  verifyA8B6ARetakeTargetReviewEvidenceSync } from
  '../server/staged-scene-cut-a8b6-A-retake-target-review-evidence.mjs'
import { freshA8B6ARetakeTargetReviewPrompt,
  verifyA8B6ARetakeTargetReviewModelLedger,
  issueA8B6ARetakeTargetReview } from
  '../server/staged-scene-cut-a8b6-A-retake-target-review.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_TARGET_REVIEW_CLI_INVALID: ${reason}`) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), opts = { apply: false,
  prepareEvidence: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--prepare-evidence') {
    if (opts.prepareEvidence) fail('duplicate --prepare-evidence')
    opts.prepareEvidence = true
    continue
  }
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const key = { '--expected-source-receipt-sha256': 'sourceSha256',
    '--expected-target-sha256': 'targetSha256' }[args[i]]
  if (!key || opts[key] || !/^[a-f0-9]{64}$/.test(args[i + 1] ?? ''))
    fail(`invalid ${args[i]}`)
  opts[key] = args[++i]
}
const source = verifyA8B6ARetakeTargetSourceSync(root)
if (opts.sourceSha256 && opts.sourceSha256 !== source.receiptSha256
  || opts.targetSha256 && opts.targetSha256 !== source.receipt.output.sha256)
  fail('reviewed target source changed')
if (opts.apply && (!opts.sourceSha256 || !opts.targetSha256))
  fail('--apply requires source receipt and target pixel hash')
if (opts.apply && opts.prepareEvidence)
  fail('prepare evidence separately before model apply')
const evidence = opts.prepareEvidence
  ? await issueA8B6ARetakeTargetReviewEvidence(root)
  : verifyA8B6ARetakeTargetReviewEvidenceSync(root)
const images = evidence.receipt.imageOrder.map(item => item.url)
if (images.some(url => !/^\/generated\/[\w.-]+\.jpg$/.test(url)))
  fail('model review attachments must be local content-addressed JPEG')
const prompt = freshA8B6ARetakeTargetReviewPrompt(
  source.receipt, source.receiptSha256, evidence)
const intentPath = path.join(root,
  '.runtime/staged-scene-cut-a8b6-A-retake/target-model-review-intent.json')
let intent
try { intent = JSON.parse(await readFile(intentPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!opts.apply) {
  console.log(JSON.stringify({ mode: opts.prepareEvidence
    ? 'signed-four-JPEG-target-review-evidence'
    : 'read-only-target-review-preview',
    sourceReceiptSha256: source.receiptSha256,
    targetSha256: source.receipt.output.sha256,
    reviewEvidenceSha256: evidence.evidenceSha256,
    reviewImageHashes: evidence.receipt.imageOrder,
    reviewImages: images, prompt,
    modelReviewIntent: intent?.requestKey ?? null,
    modelCalls: 0, videoProviderCalls: 0, databaseWrites: 0 }, null, 2))
  process.exit(0)
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let modelCallMade = false
try {
  const workflow = (await db.query(`SELECT nodes FROM workflow_configs
    WHERE id='wf-sanguo-history-drama'`)).rows[0]
  const node = workflow?.nodes?.find(item => item.id === 'sanguo-media-review')
  const model = node && (await db.query(`SELECT id,name,provider,capability,settings
    FROM model_configs WHERE id=$1`, [node.modelId])).rows[0]
  if (node?.operation !== 'history.media-review'
    || model?.provider !== 'Codex' || model.capability !== 'text')
    fail('independent review model changed')
  if (!intent) {
    intent = { version: 'staged-a8b6-A-retake-target-intent-v1',
      sourceReceiptSha256: source.receiptSha256,
      targetSha256: source.receipt.output.sha256,
      modelId: model.id,
      requestKey: `staged-a8b6-A-retake-target:${source.receiptSha256}:${randomUUID()}`,
      createdAt: new Date().toISOString() }
    await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
    const request = { model, prompt,
      operation: 'history.media-review',
      params: { reviewImages: images,
        promptInputMode: 'normalized-results',
        qualityDisposition: 'manual-review-v1', qualityMode: 'principle-v1',
        maxReviewAttempts: 1, temperature: 0 },
      executionContext: { workflowId: 'wf-sanguo-history-drama',
        workflowName: '三国原著史料短剧（分步生成）',
        nodeId: 'staged-a8b6-A-retake-target-review',
        nodeName: 'A 拒收后目标尾帧独立审核',
        requestKey: intent.requestKey } }
    const base = process.env.APP_BASE_URL ?? 'http://127.0.0.1:5173'
    const response = await fetch(`${base}/api/node-run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(300000) })
    modelCallMade = true
    const envelope = await response.json()
    if (!response.ok || envelope.status !== 200)
      fail(`model review HTTP ${response.status}; intent locked, inspect ledger`)
  } else if (intent.version !== 'staged-a8b6-A-retake-target-intent-v1'
    || intent.sourceReceiptSha256 !== source.receiptSha256
    || intent.targetSha256 !== source.receipt.output.sha256
    || intent.modelId !== model.id)
    fail('existing target review intent changed')
  const rows = (await db.query(`SELECT id,response_data,status
    FROM model_execution_records WHERE request_data->>'requestKey'=$1
    ORDER BY created_at`, [intent.requestKey])).rows
  const succeeded = rows.find(row => row.status === 'succeeded')
  if (!succeeded) fail('model ledger not successful; no automatic repeat call')
  const report = parseStructuredJson(extractTextResponse(succeeded.response_data))
  const accepted = report?.decision === 'accept'
    ? await verifyA8B6ARetakeTargetReviewModelLedger(
      succeeded.id, root, db.query.bind(db)) : undefined
  const signed = accepted ? await issueA8B6ARetakeTargetReview(
    succeeded.id, root) : undefined
  console.log(JSON.stringify({ mode: 'independent-target-image-model-review',
    sourceReceiptSha256: source.receiptSha256,
    targetSha256: source.receipt.output.sha256,
    executionId: succeeded.id,
    decision: report?.decision, issues: report?.issues,
    targetReviewSha256: signed?.reviewSha256 ?? null,
    modelCalls: modelCallMade ? 1 : 0, videoProviderCalls: 0 }, null, 2))
} finally { await db.end() }
