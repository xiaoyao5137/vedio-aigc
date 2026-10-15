#!/usr/bin/env node
/** Read-only contingency inspection; never prepares a paid request. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { verifyA8B6FrameConflictReceipt } from
  '../server/staged-scene-cut-a8b6-frame-conflict.mjs'
import { A8B6_FRESH_PREFLIGHT_SOURCE_IDS, readA8B6HistoricQaManifest,
  prepareA8B6FreshRegenerationPreflight } from
  '../server/staged-scene-cut-a8b6-fresh-preflight.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const values = process.argv.slice(2)
if (values.length !== 2 || values[0] !== '--expected-retry-md5'
  || !/^[a-f0-9]{32}$/.test(values[1]))
  throw Error('A8B6_FRESH_PREFLIGHT_INVALID: only --expected-retry-md5 <exact current DB MD5> is supported')
const expectedRetryMd5 = values[1]
const { SOURCE_ID, TIMING_ID, REJECTED_ID, RETRY_ID, QA_PLAN_ID } =
  A8B6_FRESH_PREFLIGHT_SOURCE_IDS
const qa = readA8B6HistoricQaManifest(root)
const conflict = await verifyA8B6FrameConflictReceipt(QA_PLAN_ID, root)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('BEGIN READ ONLY')
  const ids = [SOURCE_ID, TIMING_ID, REJECTED_ID, RETRY_ID]
  const rows = (await db.query(`SELECT id,workflow_id,result,
    md5(result::text) AS result_md5 FROM execution_records WHERE id = ANY($1)`,
  [ids])).rows
  const byId = new Map(rows.map(row => [row.id, row]))
  const retryRow = byId.get(RETRY_ID)
  if (rows.length !== 4 || retryRow?.result_md5 !== expectedRetryMd5)
    throw Error('A8B6_FRESH_PREFLIGHT_INVALID: same-image retry missing or CAS MD5 changed')
  const workflowRow = (await db.query(`SELECT schema_version,nodes,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
  const ledgerRows = (await db.query(`SELECT * FROM model_execution_records
    WHERE workflow_id='wf-sanguo-history-drama'
      AND node_id='sanguo-scene-cut-review'
      AND status='succeeded'
      AND request_data->>'requestKey' LIKE $1
    ORDER BY created_at DESC LIMIT 20`, [`${RETRY_ID}:%`])).rows
  const preview = prepareA8B6FreshRegenerationPreflight({
    sourceRow: byId.get(SOURCE_ID), timingRow: byId.get(TIMING_ID),
    rejectedRow: byId.get(REJECTED_ID), retryRow, workflowRow, qa,
    conflict, ledgerRows, root })
  if ((await db.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
    [RETRY_ID])).rows[0]?.result_md5 !== expectedRetryMd5)
    throw Error('A8B6_FRESH_PREFLIGHT_INVALID: same-image retry changed during read-only preflight')
  await db.query('ROLLBACK')
  console.log(JSON.stringify({ mode: 'read-only-fresh-A8B6-backup-preflight',
    ...preview }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
