#!/usr/bin/env node
// One-time CAS repair after a hydration loop inflated only schema_version.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const id = 'wf-sanguo-history-drama'
const expectedNodesMd5 = '5bac37e19818e412cbe71129721c08b0'
const expectedEdgesMd5 = '15720c9a26f6ec66dcd12fd91a49d3f4'
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const directory = path.resolve('logs/dramatic-expression/live-20260929/scene-cut-opening-state-schema166')
await db.connect()
let committed = false
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  const before = (await db.query(`SELECT id,schema_version,nodes,edges,xmin::text AS revision,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id=$1 FOR UPDATE`, [id])).rows[0]
  assert.ok(before, 'Workflow row missing')
  assert.ok(before.schema_version > 166, 'No inflated schema version to reset')
  assert.equal(before.nodes_md5, expectedNodesMd5, 'Node graph changed since schema166 CAS')
  assert.equal(before.edges_md5, expectedEdgesMd5, 'Edge graph changed since schema166 CAS')
  await mkdir(directory, { recursive: true })
  const backupPath = path.join(directory, `before-version-reset-${Date.now()}.json`)
  await writeFile(backupPath, JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
  const changed = await db.query(`UPDATE workflow_configs SET schema_version=166,updated_at=now()
    WHERE id=$1 AND schema_version=$2 AND md5(nodes::text)=$3 AND md5(edges::text)=$4
    AND xmin::text=$5 RETURNING id`, [id, before.schema_version, before.nodes_md5,
    before.edges_md5, before.revision])
  assert.equal(changed.rowCount, 1, 'CAS lost to concurrent editor')
  const after = (await db.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
    md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [id])).rows[0]
  assert.equal(after.schema_version, 166)
  assert.equal(after.nodes_md5, before.nodes_md5)
  assert.equal(after.edges_md5, before.edges_md5)
  await db.query('COMMIT'); committed = true
  console.log(JSON.stringify({ committed, schemaBefore: before.schema_version,
    schemaAfter: after.schema_version, nodesMd5Before: before.nodes_md5,
    nodesMd5After: after.nodes_md5, edgesMd5Before: before.edges_md5,
    edgesMd5After: after.edges_md5, backupPath, executionWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
