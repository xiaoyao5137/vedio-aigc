#!/usr/bin/env node
/** One independent same-image review after node49's recorded Codex transport failure.
 * The default is read-only. An intent is written before --apply sends one request;
 * an ambiguous response never authorizes a second POST. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { assertSceneCutReviewLedgerRecord } from '../server/scene-cut-frame-runtime.ts'
import { verifyA8B6LocalCompositeSourceReceiptV4 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v4.mjs'

const ID = 'record-4x5m31-a8b6-local-wall-v4'
const FAILED_MD5 = 'ecd4fe2f2ec5809388a3365aa06523e8'
const FAILED_LEDGER = 'model-run-mumzh0mf-dx5icbo'
const REQUEST_KEY = `${ID}:attempt-2:revision-3:sanguo-scene-cut-review:0:scene-01`
const INTENT = '.runtime/staged-scene-cut-a8b6-local-composite-v4/review-transport-retry-intent.json'
const sha = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => isDeepStrictEqual(a, b)
const fail = reason => { throw Error(`A8B6_V4_REVIEW_RECOVERY_INVALID: ${reason}`) }
const apply = process.argv.length === 3 && process.argv[2] === '--apply'
if (process.argv.length !== (apply ? 3 : 2)) fail('only --apply is supported')
const root = process.cwd(), intentFile = path.join(root, INTENT)
const signed = await verifyA8B6LocalCompositeSourceReceiptV4(root)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let state, failed, model, currentMd5, existingRetry
try {
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const row = (await db.query(`SELECT id,workflow_id,result,
    md5(result::text) AS result_md5 FROM execution_records WHERE id=$1`, [ID])).rows[0]
  failed = (await db.query('SELECT * FROM model_execution_records WHERE id=$1', [FAILED_LEDGER])).rows[0]
  existingRetry = (await db.query(`SELECT * FROM model_execution_records
    WHERE request_data->>'requestKey'=$1 ORDER BY created_at`, [REQUEST_KEY])).rows
  state = decodeExecutionState(row?.result)
  currentMd5 = row?.result_md5
  const run = state?.nodeRuns?.[49], params = failed?.request_data?.params
  if (row?.workflow_id !== 'wf-sanguo-history-drama'
    || currentMd5 !== FAILED_MD5 || state?.id !== ID
    || state.sceneCutA8B6LocalFrameRecovery?.sourceReceiptSha256 !== signed.receiptSha256
    || state.nodeRuns?.[45]?.status !== 'success'
    || state.nodeRuns?.[45]?.output?.url !== signed.receipt.output.url
    || state.nodeRuns?.[48]?.status !== 'success'
    || run?.status !== 'failed' || run.node?.id !== 'sanguo-scene-cut-review'
    || run.node?.modelId !== 'codex-local-vision'
    || run.error !== 'CODEX_ERROR_EVENT: CLI未产生可验收的完整文本；本次不自动重试'
    || state.nodeRuns?.[50]?.status !== 'idle'
    || failed?.status !== 'failed' || failed.model_id !== run.node.modelId
    || failed.request_data?.requestKey
      !== `${ID}:attempt-1:revision-2:sanguo-scene-cut-review:0:scene-01`
    || !Array.isArray(failed.response_data?.raw?.events)
    || !failed.response_data.raw.events.some(event =>
      String(event.message ?? '').includes('usage limit'))
    || !params || !same(params.evidence, state.nodeRuns[48].output)
    || !same(params.shot, state.nodeRuns[11].output)
    || !same(params.openingStatePlan, state.nodeRuns[43].output)
    || !same(params.sceneCutLocalComposite, state.sceneCutA8B6LocalFrameRecovery)
    || !same(params.reviewImages, state.nodeRuns[48].output.reviewImages))
    fail('failed source, its true model error, or locked attachments changed')
  model = (await db.query(`SELECT id,name,provider,capability,settings
    FROM model_configs WHERE id=$1`, [run.node.modelId])).rows[0]
  if (model?.provider !== 'Codex' || model.capability !== 'text'
    || model.settings?.model !== 'gpt-6-astra') fail('reviewer model changed')
  await db.query('ROLLBACK')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
const intended = { version: 'a8b6-v4-same-image-review-transport-retry-v1',
  executionId: ID, failedResultMd5: FAILED_MD5,
  failedModelExecutionId: FAILED_LEDGER,
  failedRequestSha256: sha(JSON.stringify(failed.request_data)),
  sourceReceiptSha256: signed.receiptSha256,
  candidateSha256: signed.receipt.output.sha256,
  promptSha256: sha(failed.request_data.prompt),
  reviewImages: failed.response_data.raw.attachments.map(item =>
    ({ url: item.url, sha256: item.sha256 })),
  modelId: model.id, requestKey: REQUEST_KEY }
let existingIntent
try { existingIntent = JSON.parse(await readFile(intentFile, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (existingIntent && !same(existingIntent, intended)) fail('saved one-call intent changed')
if (!apply) {
  console.log(JSON.stringify({ mode: 'read-only-same-image-review-recovery',
    executionId: ID, failedResultMd5: currentMd5,
    failedModelExecutionId: FAILED_LEDGER, requestKey: REQUEST_KEY,
    sourceReceiptSha256: signed.receiptSha256,
    candidateSha256: signed.receipt.output.sha256,
    promptSha256: intended.promptSha256,
    existingIntent: Boolean(existingIntent), existingRetryLedgers: existingRetry.length,
    providerCalls: 0, databaseWrites: 0 }, null, 2))
  process.exit(0)
}
if (!existingIntent) {
  if (existingRetry.length) fail('retry ledger exists without its write-once intent')
  await writeFile(intentFile, JSON.stringify(intended, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  const response = await fetch('http://127.0.0.1:5173/api/node-run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: failed.request_data.prompt,
      params: failed.request_data.params,
      executionContext: { workflowId: 'wf-sanguo-history-drama',
        workflowName: '三国原著史料短剧-生产工作流',
        nodeId: 'sanguo-scene-cut-review',
        nodeName: state.nodeRuns[49].node.title,
        requestKey: REQUEST_KEY } }),
    signal: AbortSignal.timeout(900000),
  })
  if (!response.ok) fail(`review HTTP ${response.status}; intent retained, no automatic repeat POST`)
}
const audit = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await audit.connect()
try {
  await audit.query('BEGIN READ ONLY')
  const ledgers = (await audit.query(`SELECT * FROM model_execution_records
    WHERE request_data->>'requestKey'=$1 ORDER BY created_at`, [REQUEST_KEY])).rows
  const row = ledgers[0]
  if (ledgers.length !== 1 || row?.status !== 'succeeded'
    || row.model_id !== model.id) fail('no unique successful same-image model result; no repeat POST')
  const parsed = parseStructuredJson(extractTextResponse(row.response_data))
  if (!parsed || Array.isArray(parsed)) fail('review model returned no structured JSON')
  const review = { ...parsed, model: model.id }
  assertSceneCutReviewLedgerRecord(row, review, {
    evidence: state.nodeRuns[48].output,
    shot: state.nodeRuns[11].output,
    sources: state.nodeRuns[41].output,
    reviewImages: state.nodeRuns[48].output.reviewImages,
    openingStatePlan: state.nodeRuns[43].output,
    sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery,
  }, root, 180)
  await audit.query('ROLLBACK')
  console.log(JSON.stringify({ mode: 'actual-independent-review-recorded',
    executionId: ID, ledgerId: row.id, requestKey: REQUEST_KEY,
    decision: { passed: review.passed, hardChecks: review.hardChecks,
      issues: review.issues },
    node50Authorized: false, databaseWrites: 0,
    providerCalls: existingIntent ? 0 : 1 }, null, 2))
} catch (error) {
  await audit.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await audit.end() }
