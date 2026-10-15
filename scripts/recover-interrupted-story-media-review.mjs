#!/usr/bin/env node
// Recover only the two audited review-only checkpoints whose hosting process
// exited before the review result was saved. Dry-run unless --apply is given.
// No model or video provider is called, and no other execution is touched.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { readStorySameMediaReviewRetry, recoverInterruptedStorySameMediaReviewRun,
  selectStorySameMediaReviewRetry } from '../src/story-same-media-retry.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const TARGETS = {
  'record-90jojn': '8bf0e76effe9b5a2a9c78a3e3778e5dd',
  'record-wk202h': '7fbf4f0aca96b30260c802657b00ae73',
}
const VIDEO_SHA256 = '0a10e6fd3fb9258c91bb690a75438d9ecae06d6dfb9987fe8c8cd15aeba71c6a'
const SOURCE_EXECUTION_ID = 'record-story-shot1-audio-review-v1'
const generatedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const fail = message => { throw Error(`STORY_INTERRUPTED_REVIEW_RECOVERY_INVALID: ${message}`) }
// PostgreSQL jsonb reorders object keys. Compare decoded evidence by JSON
// value, never by insertion order of the JavaScript objects.
const hash = createJsonHasher()

function verifyRecovery(saved, prepared, sourceRuns, retry, label) {
  const mismatches = []
  if (hash(saved) !== hash(prepared)) mismatches.push('state')
  if (saved.nodeRuns?.[5]?.status !== 'idle') mismatches.push('node-status')
  if (hash(saved.nodeRuns.slice(0, 5)) !== hash(sourceRuns.slice(0, 5))) mismatches.push('paid-prefix')
  if (hash(saved.nodeRuns.slice(6)) !== hash(sourceRuns.slice(6))) mismatches.push('pending-suffix')
  if (hash(readStorySameMediaReviewRetry(saved.nodeRuns[5].retryFeedback, saved.nodeRuns[5])) !== hash(retry)) {
    mismatches.push('saved-media-pointer')
  }
  if (mismatches.length) fail(`${label} differs: ${mismatches.join(', ')}`)
}

function parseArgs(args) {
  const options = { apply: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { options.help = true; continue }
    if (arg === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (!['--record', '--expected-md5'].includes(arg) || seen.has(arg) || !args[i + 1]
      || args[i + 1].startsWith('--')) fail(`unknown or incomplete ${arg}`)
    options[arg === '--record' ? 'recordId' : 'expectedMd5'] = args[++i]
    seen.add(arg)
  }
  if (options.help) return options
  if (!Object.hasOwn(TARGETS, options.recordId ?? '')) fail('record must be one of the two audited interruptions')
  if (options.expectedMd5 && options.expectedMd5 !== TARGETS[options.recordId]) fail('supplied MD5 differs from the frozen audit')
  if (options.apply && !options.expectedMd5) fail('--apply requires --expected-md5 from the dry-run')
  return options
}

async function inspect(client, options) {
  const row = (await client.query(`select id,workflow_id,created_at,md5(result::text) as result_md5,result
    from execution_records where id=$1${options.apply ? ' for update' : ''}`, [options.recordId])).rows[0]
  if (!row || row.workflow_id !== 'wf-story' || row.result_md5 !== TARGETS[options.recordId]) fail('record or frozen result MD5 changed')
  const state = decodeExecutionState(row.result), runs = state.nodeRuns
  if (state.id !== row.id || state.workflowId !== 'wf-story' || state.parentExecutionId !== SOURCE_EXECUTION_ID
    || state.generationScopeId !== row.id || !Array.isArray(runs) || runs.length !== 8
    || runs.slice(0, 5).some(run => run.status !== 'success') || runs[5]?.status !== 'running'
    || runs[5].node?.id !== 'node-video' || runs[5].loopIndex !== 0
    || runs.slice(6).some(run => run.status !== 'idle') || state.interruptionRecovery) {
    fail('record is no longer the audited first-shot review-only checkpoint')
  }
  const run = runs[5], retry = readStorySameMediaReviewRetry(run.retryFeedback, run)
  if (!retry || retry.sourceExecutionId !== SOURCE_EXECUTION_ID
    || retry.sourceVideoSha256 !== VIDEO_SHA256
    || state.storyAudioReviewRecovery?.derivativeVideoSha256 !== VIDEO_SHA256
    || !/^\/generated\/[\w.-]+\.mp4$/.test(retry.sourceUrl)) fail('saved-media provenance changed')
  const videoPath = path.resolve(generatedRoot, path.basename(retry.sourceUrl))
  if (!videoPath.startsWith(`${generatedRoot}${path.sep}`)) fail('video path escaped generated assets')
  const actualSha = createHash('sha256').update(await readFile(videoPath)).digest('hex')
  if (actualSha !== VIDEO_SHA256) fail('saved video bytes differ from source binding')
  const ledger = await client.query(`select count(*)::int as count from model_execution_records
    where request_data->>'requestKey' like $1`, [`${row.id}:%`])
  if (ledger.rows[0].count !== 0) fail('model ledger changed; inspect any completed or active request before recovery')
  const idleRun = recoverInterruptedStorySameMediaReviewRun(run)
  // The selector independently validates that a retry will reuse this media.
  if (hash(selectStorySameMediaReviewRetry(idleRun, row.id)) !== hash(retry)) fail('recovered pointer changed')
  const recoveredAt = new Date().toISOString()
  const recovery = { version: 'story-same-media-review-interruption-v1', recoveredAt,
    reason: 'hosting-process-exited-before-review-result-persisted', sourceExecutionId: row.id,
    sourceResultMd5: row.result_md5, parentExecutionId: state.parentExecutionId,
    nodeRunId: run.id, previousStatus: 'running', nextStatus: 'idle',
    previousStartedAtPerformanceMs: run.startedAt ?? null, sourceVideoUrl: retry.sourceUrl,
    sourceVideoSha256: VIDEO_SHA256, modelLedgerRecords: 0, providerCallsMadeByRecovery: 0 }
  const next = { ...state, nodeRuns: runs.map((item, index) => index === 5 ? idleRun : item),
    logs: [...(Array.isArray(state.logs) ? state.logs : []),
      '第 1 镜同素材审核因原服务进程退出而中断；已核验原片哈希，恢复为待复核检查点，未重新生成视频。'],
    interruptionRecovery: recovery }
  const encoded = encodeExecutionState(next), roundTrip = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  verifyRecovery(roundTrip, next, runs, retry, 'local storage round-trip')
  // Read-only JSONB cast exercises PostgreSQL's key normalization and the
  // exact parser path used after UPDATE, without changing the source row.
  const jsonbRoundTrip = decodeExecutionState((await client.query('select $1::jsonb as result',
    [JSON.stringify(encoded)])).rows[0].result)
  verifyRecovery(jsonbRoundTrip, next, runs, retry, 'PostgreSQL jsonb round-trip')
  return { row, next, encoded, recovery, actualSha, sourceRuns: runs, retry }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: DATABASE_URL=... node scripts/recover-interrupted-story-media-review.mjs --record record-90jojn [--expected-md5 HASH --apply]')
    return
  }
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    if (options.apply) await client.query('begin')
    const inspected = await inspect(client, options)
    if (options.apply) {
      const changed = await client.query(`update execution_records set result=$2::jsonb,
          succeeded_count=5,failed_count=0,total_count=8
        where id=$1 and md5(result::text)=$3 and result #>> '{nodeRuns,5,status}'='running'
        returning id,md5(result::text) as result_md5,result`,
      [options.recordId, JSON.stringify(inspected.encoded), options.expectedMd5])
      if (changed.rowCount !== 1) fail('concurrent update or changed checkpoint')
      const saved = decodeExecutionState(changed.rows[0].result)
      verifyRecovery(saved, inspected.next, inspected.sourceRuns, inspected.retry, 'saved recovery')
      await client.query('commit')
      console.log(JSON.stringify({ applied: true, recordId: options.recordId,
        previousMd5: inspected.row.result_md5, recoveredMd5: changed.rows[0].result_md5,
        node5Status: 'idle', videoSha256: inspected.actualSha, modelCalls: 0 }, null, 2))
    } else {
      console.log(JSON.stringify({ applied: false, recordId: options.recordId,
        sourceMd5: inspected.row.result_md5, node5Status: 'running', recoverableTo: 'idle',
        videoSha256: inspected.actualSha, modelLedgerRecords: 0, modelCalls: 0 }, null, 2))
    }
  } catch (error) {
    if (options.apply) await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
