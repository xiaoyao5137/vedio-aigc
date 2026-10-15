#!/usr/bin/env node
// Schema173 same-version, review.prompt-only clarification before any v173 execution.
// Dry-run by default; --apply requires source graph MD5 CAS and writes a backup.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { refreshSceneCutStagingReviewPrompt } from '../src/scene-cut-staging-workflow.ts'

const apply = process.argv.includes('--apply')
const argument = flag => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? '' : process.argv[at + 1] ?? ''
}
const expectedNodesMd5 = argument('--expected-nodes-md5')
const expectedEdgesMd5 = argument('--expected-edges-md5')
if (apply && (!/^[a-f0-9]{32}$/.test(expectedNodesMd5)
  || !/^[a-f0-9]{32}$/.test(expectedEdgesMd5)))
  throw Error('CAS requires --expected-nodes-md5 and --expected-edges-md5')

const backupDirectory = path.resolve('logs/dramatic-expression/live-20260929/scene-cut-staging-schema173')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let committed = false
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`select id,schema_version,nodes,edges,xmin::text as revision,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5,updated_at
    from workflow_configs where id='wf-sanguo-history-drama'${apply ? ' for update' : ''}`)).rows[0]
  assert.ok(before && before.schema_version === 173, 'Expected saved schema173')
  const current = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = refreshSceneCutStagingReviewPrompt(current)
  assert.notEqual(next, current, 'Expected the exact initial schema173 review prompt')
  assert.equal(refreshSceneCutStagingReviewPrompt(next), next, 'Prompt refresh is not idempotent')
  assert.equal(next.schemaVersion, current.schemaVersion)
  assert.equal(next.edges, current.edges)
  assert.equal(next.nodes.length, current.nodes.length)
  const changedNodeIds = current.nodes.filter((node, index) =>
    JSON.stringify(node) !== JSON.stringify(next.nodes[index])).map(node => node.id)
  assert.deepEqual(changedNodeIds, ['sanguo-scene-cut-review'])
  const target = (await db.query('select md5($1::jsonb::text) as nodes_md5',
    [JSON.stringify(next.nodes)])).rows[0]
  let backupPath = ''
  if (apply) {
    assert.equal(before.nodes_md5, expectedNodesMd5, 'CAS source nodes MD5 differs')
    assert.equal(before.edges_md5, expectedEdgesMd5, 'CAS source edges MD5 differs')
    const active = (await db.query(`select count(*)::int as count from execution_records
      where workflow_id='wf-sanguo-history-drama' and created_at > $1`,
    [before.updated_at])).rows[0]
    assert.equal(active.count, 0, 'An execution began after schema173 CAS')
    await mkdir(backupDirectory, { recursive: true })
    backupPath = path.join(backupDirectory, `workflow-schema173-before-review-refresh-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const saved = await db.query(`update workflow_configs set nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=173 and md5(nodes::text)=$3
      and md5(edges::text)=$4 and xmin::text=$5 returning id`,
    [before.id, JSON.stringify(next.nodes), before.nodes_md5, before.edges_md5, before.revision])
    assert.equal(saved.rowCount, 1, 'Prompt refresh CAS lost to a concurrent editor')
  }
  const after = (await db.query(`select schema_version,nodes,edges,md5(nodes::text) as nodes_md5,
    md5(edges::text) as edges_md5 from workflow_configs where id=$1`, [before.id])).rows[0]
  assert.equal(after.schema_version, 173)
  assert.deepEqual(after.nodes, apply ? next.nodes : current.nodes)
  assert.deepEqual(after.edges, current.edges)
  assert.equal(after.edges_md5, before.edges_md5)
  if (apply) { await db.query('COMMIT'); committed = true }
  else await db.query('ROLLBACK')
  console.log(JSON.stringify({ applied: apply, committed, schemaVersion: 173,
    changedNodeIds, nodesMd5Before: before.nodes_md5,
    nodesMd5Target: target.nodes_md5, nodesMd5After: after.nodes_md5,
    edgesMd5: before.edges_md5, backupPath, executionWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
