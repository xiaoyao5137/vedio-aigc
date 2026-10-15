#!/usr/bin/env node
// Schema174→175: the managed first-frame image prompt only. Dry-run by default.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { upgradeSceneCutClosureLayoutWorkflow } from '../src/scene-cut-closure-layout-workflow.ts'

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

const backupDirectory = path.resolve('logs/dramatic-expression/live-20260929/scene-cut-closure-layout-schema175')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let committed = false
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`select id,schema_version,nodes,edges,xmin::text as revision,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id='wf-sanguo-history-drama'${apply ? ' for update' : ''}`)).rows[0]
  assert.ok(before && before.schema_version === 174, 'Expected saved schema174')
  const current = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = upgradeSceneCutClosureLayoutWorkflow(current)
  assert.equal(next.schemaVersion, 175, 'Managed image/review prompt anchors did not match')
  assert.equal(upgradeSceneCutClosureLayoutWorkflow(next), next, 'Migration is not idempotent')
  assert.equal(next.edges, current.edges, 'Schema175 must preserve edge bytes and order')
  assert.equal(next.nodes.length, current.nodes.length)
  const changedNodeIds = current.nodes.filter((node, index) =>
    JSON.stringify(node) !== JSON.stringify(next.nodes[index])).map(node => node.id).sort()
  assert.deepEqual(changedNodeIds, ['sanguo-scene-cut-first-frame'])
  assert.deepEqual(next.nodes.find(node => node.id === 'sanguo-scene-loop')?.childIds,
    current.nodes.find(node => node.id === 'sanguo-scene-loop')?.childIds)
  const targetHashes = (await db.query(`select md5($1::jsonb::text) as nodes_md5,
    md5($2::jsonb::text) as edges_md5`, [JSON.stringify(next.nodes), JSON.stringify(next.edges)])).rows[0]
  let backupPath = ''
  if (apply) {
    assert.equal(before.nodes_md5, expectedNodesMd5, 'CAS source nodes MD5 differs')
    assert.equal(before.edges_md5, expectedEdgesMd5, 'CAS source edges MD5 differs')
    await mkdir(backupDirectory, { recursive: true })
    backupPath = path.join(backupDirectory, `workflow-schema174-before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const saved = await db.query(`update workflow_configs set nodes=$2::jsonb,
      schema_version=175,updated_at=now() where id=$1 and schema_version=174
      and md5(nodes::text)=$3 and md5(edges::text)=$4 and xmin::text=$5 returning id`,
    [before.id, JSON.stringify(next.nodes), before.nodes_md5, before.edges_md5, before.revision])
    assert.equal(saved.rowCount, 1, 'Workflow CAS lost to a concurrent editor')
  }
  const saved = (await db.query(`select schema_version,nodes,edges,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(saved.schema_version, apply ? 175 : 174)
  assert.deepEqual(saved.nodes, apply ? next.nodes : current.nodes)
  assert.deepEqual(saved.edges, current.edges)
  if (apply) { await db.query('COMMIT'); committed = true }
  else await db.query('ROLLBACK')
  console.log(JSON.stringify({ applied: apply, committed,
    schemaBefore: 174, schemaAfter: apply ? 175 : 174, changedNodeIds,
    nodeCount: next.nodes.length, edgeCount: next.edges.length,
    nodesMd5Before: before.nodes_md5, nodesMd5Target: targetHashes.nodes_md5,
    edgesMd5Before: before.edges_md5, edgesMd5Target: targetHashes.edges_md5,
    backupPath, executionWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
