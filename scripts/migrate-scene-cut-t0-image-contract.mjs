#!/usr/bin/env node
// CAS migration of the two managed schema166 scene-cut prompts. Executions are untouched.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { upgradeSceneCutT0ImageContractWorkflow } from '../src/scene-cut-t0-image-contract.ts'

const id = 'wf-sanguo-history-drama'
const apply = process.argv.includes('--apply')
const expectedIndex = process.argv.indexOf('--expected-before-md5')
const expectedBeforeMd5 = expectedIndex < 0 ? '' : process.argv[expectedIndex + 1] ?? ''
const directory = path.resolve('logs/dramatic-expression/live-20260929/scene-cut-t0-schema167')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

await db.connect()
let committed = false
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`select id,schema_version,nodes,edges,xmin::text as revision,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id=$1${apply ? ' for update' : ''}`, [id])).rows[0]
  assert.ok(before, 'Sanguo workflow config missing')
  assert.equal(before.schema_version, 166, 'Expected schema166')
  const current = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = upgradeSceneCutT0ImageContractWorkflow(current)
  assert.equal(next.schemaVersion, 167, 'Managed prompt anchors did not match')
  assert.equal(upgradeSceneCutT0ImageContractWorkflow(next), next, 'Migration must be idempotent')
  assert.equal(next.nodes.length, current.nodes.length)
  assert.equal(next.edges, current.edges)
  const changed = current.nodes.filter((node, index) =>
    JSON.stringify(node) !== JSON.stringify(next.nodes[index])).map(node => node.id).sort()
  assert.deepEqual(changed, ['sanguo-scene-cut-first-frame', 'sanguo-scene-cut-review'].sort())
  assert.deepEqual(next.nodes.find(node => node.id === 'sanguo-scene-loop')?.childIds,
    current.nodes.find(node => node.id === 'sanguo-scene-loop')?.childIds)
  let backupPath = ''
  if (apply) {
    assert.equal(expectedBeforeMd5, before.nodes_md5, 'CAS expected nodes MD5 differs')
    await mkdir(directory, { recursive: true })
    backupPath = path.join(directory, `workflow-schema166-before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const updated = await db.query(`update workflow_configs set nodes=$2::jsonb,
      schema_version=167,updated_at=now() where id=$1 and schema_version=166
      and md5(nodes::text)=$3 and md5(edges::text)=$4 and xmin::text=$5 returning id`,
    [id, JSON.stringify(next.nodes), before.nodes_md5, before.edges_md5, before.revision])
    assert.equal(updated.rowCount, 1, 'Workflow CAS lost to another writer')
  }
  const saved = (await db.query(`select schema_version,nodes,edges,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id=$1`, [id])).rows[0]
  assert.equal(saved.schema_version, apply ? 167 : 166)
  assert.deepEqual(saved.nodes, apply ? next.nodes : current.nodes)
  assert.deepEqual(saved.edges, current.edges)
  if (apply) { await db.query('COMMIT'); committed = true }
  else await db.query('ROLLBACK')
  console.log(JSON.stringify({ applied: apply, committed, schemaBefore: 166,
    schemaAfter: saved.schema_version, changedNodeIds: changed,
    nodeCount: saved.nodes.length, edgeCount: saved.edges.length,
    nodesMd5Before: before.nodes_md5, nodesMd5After: saved.nodes_md5,
    edgesMd5Before: before.edges_md5, edgesMd5After: saved.edges_md5,
    backupPath, executionWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
