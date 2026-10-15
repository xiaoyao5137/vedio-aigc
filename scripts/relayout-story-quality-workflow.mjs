#!/usr/bin/env node
// Reposition the saved wf-story cards without changing their behavior or run history.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const argument = flag => {
  const index = args.indexOf(flag)
  return index < 0 ? '' : args[index + 1] ?? ''
}
const expectedNodesMd5 = argument('--expected-nodes-md5')
const expectedEdgesMd5 = argument('--expected-edges-md5')
if (args.some(arg => !['--apply', '--expected-nodes-md5', '--expected-edges-md5',
  expectedNodesMd5, expectedEdgesMd5].includes(arg))) throw Error('Unknown argument')
if (apply && (!/^[a-f0-9]{32}$/.test(expectedNodesMd5)
  || !/^[a-f0-9]{32}$/.test(expectedEdgesMd5))) {
  throw Error('Apply requires the fresh nodes and edges MD5 values from a preview')
}

const order = [
  'node-input', 'node-model-images', 'node-script', 'node-script-review',
  'node-loop', 'node-image', 'node-video', 'node-video-review', 'node-video-concat',
]
const recordSql = `SELECT count(*)::int AS count,
  md5(coalesce(string_agg(er.id || ':' || md5(to_jsonb(er)::text), ',' ORDER BY er.id), '')) AS fingerprint
  FROM execution_records er WHERE er.workflow_id='wf-story'`
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let committed = false
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`SELECT id,schema_version,nodes,edges,xmin::text AS revision,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-story'${apply ? ' FOR UPDATE' : ''}`)).rows[0]
  assert.ok(before && before.schema_version === 5, 'Expected saved wf-story schema 5')
  const current = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = upgradeStoryQualityWorkflow(current)
  assert.equal(upgradeStoryQualityWorkflow(next), next, 'Layout is not idempotent')
  assert.equal(next.schemaVersion, 5)
  assert.equal(next.nodes.length, current.nodes.length)
  assert.equal(next.edges, current.edges, 'Edges must retain their original reference')
  assert.deepEqual(next.edges, current.edges)
  const changedNodeIds = []
  for (let index = 0; index < current.nodes.length; index++) {
    const oldNode = current.nodes[index]
    const newNode = next.nodes[index]
    assert.equal(newNode.id, oldNode.id, 'Node order changed')
    assert.deepEqual({ ...newNode, position: { ...newNode.position, x: oldNode.position.x } },
      oldNode, `Unexpected node change: ${oldNode.id}`)
    if (newNode.position.x !== oldNode.position.x) changedNodeIds.push(oldNode.id)
  }
  const byId = new Map(next.nodes.map(node => [node.id, node]))
  assert.equal(byId.size, next.nodes.length, 'Duplicate node IDs')
  for (let index = 1; index < order.length; index++) {
    const left = byId.get(order[index - 1])
    const right = byId.get(order[index])
    assert.ok(left && right, 'Required story card missing')
    assert.ok(right.position.x - left.position.x >= 300 - 1e-6,
      `${left.id} overlaps ${right.id}`)
  }
  const recordsBefore = (await db.query(recordSql)).rows[0]
  const targetHash = (await db.query('SELECT md5($1::jsonb::text) AS nodes_md5',
    [JSON.stringify(next.nodes)])).rows[0].nodes_md5
  let backupPath = ''
  if (apply && changedNodeIds.length) {
    assert.equal(before.nodes_md5, expectedNodesMd5, 'Saved nodes changed since preview')
    assert.equal(before.edges_md5, expectedEdgesMd5, 'Saved edges changed since preview')
    const backupDirectory = path.resolve('logs/story-quality/layout')
    await mkdir(backupDirectory, { recursive: true })
    backupPath = path.join(backupDirectory, `wf-story-before-${before.nodes_md5}-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify({ capturedAt: new Date().toISOString(),
      workflow: before }, null, 2), { flag: 'wx', mode: 0o600 })
    const saved = await db.query(`UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now()
      WHERE id=$1 AND schema_version=5 AND md5(nodes::text)=$3
      AND md5(edges::text)=$4 AND xmin::text=$5 RETURNING id`,
    [before.id, JSON.stringify(next.nodes), before.nodes_md5, before.edges_md5, before.revision])
    assert.equal(saved.rowCount, 1, 'Workflow was edited concurrently')
  }
  const after = (await db.query(`SELECT schema_version,nodes,edges,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-story'`)).rows[0]
  assert.equal(after.schema_version, 5)
  assert.deepEqual(after.nodes, apply ? next.nodes : current.nodes)
  assert.deepEqual(after.edges, current.edges)
  assert.equal(after.nodes_md5, apply ? targetHash : before.nodes_md5)
  assert.equal(after.edges_md5, before.edges_md5)
  const recordsAfter = (await db.query(recordSql)).rows[0]
  assert.deepEqual(recordsAfter, recordsBefore, 'Execution history changed')
  if (apply) { await db.query('COMMIT'); committed = true }
  else await db.query('ROLLBACK')
  console.log(JSON.stringify({ applied: apply, committed, schemaVersion: 5,
    changedNodeIds, nodePositions: order.map(id => ({ id, ...byId.get(id)?.position })),
    nodesMd5Before: before.nodes_md5, nodesMd5Target: targetHash,
    edgesMd5Before: before.edges_md5, edgesMd5After: after.edges_md5,
    executionRecordCount: recordsAfter.count, executionRecordsFingerprint: recordsAfter.fingerprint,
    executionRecordWrites: 0, providerCalls: 0, backupPath }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
