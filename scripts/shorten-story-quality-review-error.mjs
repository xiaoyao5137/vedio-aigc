#!/usr/bin/env node
// One-record repair for a duplicated megabyte-sized validation error string.
// Keeps the complete structured report, paid clip, statuses, and source record.
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const ID = 'record-story-quality-review-v1'
const SOURCE_ID = 'record-story-shot1-visual-v1'
const RUN_INDEX = 7
const VIDEO_SHA256 = '0a10e6fd3fb9258c91bb690a75438d9ecae06d6dfb9987fe8c8cd15aeba71c6a'
const BACKUP = path.resolve('qa/story-quality-review/record-story-quality-review-v1-before-error-shortening.json.gz')
const fail = reason => { throw Error(`STORY_REVIEW_ERROR_REPAIR_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function args(argv) {
  const options = { apply: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (argv[i] === '--help') { options.help = true; continue }
    if (argv[i] === '--expected-md5' && !options.expectedMd5 && argv[i + 1]) { options.expectedMd5 = argv[++i]; continue }
    fail(`unknown or incomplete argument ${argv[i]}`)
  }
  if (options.apply && !/^[a-f0-9]{32}$/.test(options.expectedMd5 || '')) fail('--apply needs the reviewed result MD5')
  return options
}

function inspect(row, source) {
  if (!row || row.id !== ID || row.workflow_id !== 'wf-story' || !source || source.id !== SOURCE_ID) fail('record identity differs')
  const state = decodeExecutionState(row.result)
  const sourceState = decodeExecutionState(source.result)
  const run = state.nodeRuns?.[RUN_INDEX]
  const paid = state.nodeRuns?.[6]
  const originalPaid = sourceState.nodeRuns?.[5]
  if (state.id !== ID || state.parentExecutionId !== SOURCE_ID || state.storyQualityVisibleFork?.version !== 'story-quality-visible-fork-v1'
    || state.nodeRuns?.length !== 13 || run?.node?.id !== 'node-video-review' || run.status !== 'failed'
    || run.output?.passed !== false || run.output?.storyMediaReview?.reviewStatus !== 'uncertain'
    || !Array.isArray(run.output.storyMediaReview.issues) || !run.output.storyMediaReview.issues.length
    || !paid || paid.status !== 'success' || paid.node.id !== 'node-video'
    || !originalPaid || originalPaid.output?.videoEvidence?.sha256 !== VIDEO_SHA256
    || paid.output?.videoEvidence?.sha256 !== VIDEO_SHA256
    || run.output?.videoEvidence?.sha256 !== VIDEO_SHA256
    || state.nodeRuns.slice(8).some(item => item.status !== 'idle')
    || typeof run.error !== 'string' || run.error.length < 100000
    || typeof run.output.error !== 'string' || run.output.error.length < 100000) {
    fail('review, paid asset or downstream checkpoint differs from inspected state')
  }
  const hash = createJsonHasher()
  if (hash(paid.output) !== hash(originalPaid.output)) fail('paid output differs from source record')
  const issues = run.output.storyMediaReview.issues.map(item => String(item).trim()).filter(Boolean)
  const short = `质量校验未通过：STORY_SHOT_UNCERTAIN；${issues.join('；')}`
  if (short.length > 1000) fail('review issues are unexpectedly long')
  const withoutError = candidate => {
    const runs = [...candidate.nodeRuns]
    const { error: _runError, ...rest } = runs[RUN_INDEX]
    const { error: _outputError, ...output } = rest.output
    void _runError; void _outputError
    runs[RUN_INDEX] = { ...rest, output }
    return { ...candidate, nodeRuns: runs }
  }
  return { state, sourceState, short, reportHash: hash(run.output.storyMediaReview),
    evidenceHash: hash(run.output.videoEvidence), paidHash: hash(paid.output),
    normalizedHash: hash(withoutError(state)), withoutError, previousLengths: [run.error.length, run.output.error.length] }
}

export async function shortenStoryReviewError(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const row = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR UPDATE' : ''}`, [ID])).rows[0]
    const source = (await client.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [SOURCE_ID])).rows[0]
    if (options.expectedMd5 && row?.result_md5 !== options.expectedMd5) fail('record MD5 changed since review')
    const before = inspect(row, source)
    const fileBefore = await readFile(`public${before.state.nodeRuns[6].output.url}`)
    if (sha(fileBefore) !== VIDEO_SHA256) fail('paid clip bytes changed before repair')
    let backupSha256
    if (options.apply) {
      const backup = gzipSync(Buffer.from(JSON.stringify({ id: row.id, workflowId: row.workflow_id,
        resultMd5: row.result_md5, sourceId: SOURCE_ID, sourceResultMd5: source.result_md5, result: row.result })))
      await mkdir(path.dirname(BACKUP), { recursive: true })
      await writeFile(BACKUP, backup, { flag: 'wx' })
      backupSha256 = sha(backup)
      const updated = await client.query(`UPDATE execution_records SET result = jsonb_set(
        jsonb_set(result, '{nodeRuns,7,error}', to_jsonb($2::text), false),
        '{nodeRuns,7,output,error}', to_jsonb($2::text), false)
        WHERE id=$1 AND md5(result::text)=$3 RETURNING result,md5(result::text) AS result_md5`,
      [ID, before.short, row.result_md5])
      if (updated.rowCount !== 1) fail('compare-and-swap update did not match')
      const after = decodeExecutionState(updated.rows[0].result)
      const hash = createJsonHasher()
      if (after.nodeRuns[RUN_INDEX].error !== before.short || after.nodeRuns[RUN_INDEX].output.error !== before.short
        || hash(before.withoutError(after)) !== before.normalizedHash
        || hash(after.nodeRuns[RUN_INDEX].output.storyMediaReview) !== before.reportHash
        || hash(after.nodeRuns[RUN_INDEX].output.videoEvidence) !== before.evidenceHash
        || hash(after.nodeRuns[6].output) !== before.paidHash
        || (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [SOURCE_ID])).rows[0]?.md5 !== source.result_md5
        || sha(await readFile(`public${after.nodeRuns[6].output.url}`)) !== VIDEO_SHA256) {
        fail('post-update structure, evidence or source check failed')
      }
      await client.query('COMMIT')
      return { applied: true, id: ID, beforeMd5: row.result_md5, afterMd5: updated.rows[0].result_md5,
        sourceMd5BeforeAfter: source.result_md5, previousLengths: before.previousLengths,
        newLength: before.short.length, normalizedStructureHash: before.normalizedHash,
        reportHash: before.reportHash, evidenceHash: before.evidenceHash, paidOutputHash: before.paidHash,
        paidVideoSha256: VIDEO_SHA256, backupPath: BACKUP, backupSha256, downstreamIdle: true }
    }
    await client.query('COMMIT')
    return { applied: false, id: ID, beforeMd5: row.result_md5, sourceMd5: source.result_md5,
      previousLengths: before.previousLengths, newLength: before.short.length,
      normalizedStructureHash: before.normalizedHash, reportHash: before.reportHash,
      evidenceHash: before.evidenceHash, paidOutputHash: before.paidHash,
      paidVideoSha256: VIDEO_SHA256, backupPath: BACKUP, downstreamIdle: true }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function main() {
  const options = args(process.argv.slice(2))
  if (options.help) { console.log('node scripts/shorten-story-quality-review-error.mjs [--expected-md5 MD5 --apply]'); return }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try { const client = await pool.connect(); try { console.log(JSON.stringify(await shortenStoryReviewError(client, options), null, 2)) }
    finally { client.release() } }
  finally { await pool.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1
})
