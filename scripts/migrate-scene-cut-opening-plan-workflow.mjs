#!/usr/bin/env node
// CAS schema167→168. Adds the deterministic opening plan before image purchase.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { upgradeSceneCutOpeningPlanWorkflow } from '../src/scene-cut-opening-plan-workflow.ts'

const id = 'wf-sanguo-history-drama'
const apply = process.argv.includes('--apply')
const index = process.argv.indexOf('--expected-before-md5')
const expectedBeforeMd5 = index < 0 ? '' : process.argv[index + 1] ?? ''
const directory = path.resolve('logs/dramatic-expression/live-20260929/scene-cut-opening-plan-schema168')
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
  assert.ok(before && before.schema_version === 167, 'Expected saved schema167')
  const current = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = upgradeSceneCutOpeningPlanWorkflow(current)
  assert.equal(next.schemaVersion, 168, 'Managed graph anchors did not match')
  assert.equal(upgradeSceneCutOpeningPlanWorkflow(next), next, 'Migration is not idempotent')
  const changed = current.nodes.filter((node, at) =>
    JSON.stringify(node) !== JSON.stringify(next.nodes[at])).map(node => node.id).sort()
  assert.deepEqual(changed, ['sanguo-scene-loop', 'sanguo-scene-cut-first-frame',
    'sanguo-scene-cut-review', 'sanguo-scene-cut-approval'].sort())
  const added = next.nodes.filter(node => !current.nodes.some(item => item.id === node.id)).map(node => node.id)
  assert.deepEqual(added, ['sanguo-scene-cut-opening-plan'])
  assert.equal(next.nodes.length, current.nodes.length + 1)
  assert.equal(next.edges.length, current.edges.length + 1)
  const removedEdges = current.edges.filter(edge => !next.edges.some(item => item.id === edge.id))
  const addedEdges = next.edges.filter(edge => !current.edges.some(item => item.id === edge.id))
  assert.equal(removedEdges.length, 1)
  assert.equal(removedEdges[0].from, 'sanguo-scene-cut-source-archive')
  assert.equal(removedEdges[0].to, 'sanguo-scene-cut-first-frame')
  assert.deepEqual(addedEdges.map(edge => `${edge.from}->${edge.to}`).sort(), [
    'sanguo-scene-cut-opening-plan->sanguo-scene-cut-first-frame',
    'sanguo-scene-cut-source-archive->sanguo-scene-cut-opening-plan' ].sort())
  let backupPath = ''
  if (apply) {
    assert.equal(expectedBeforeMd5, before.nodes_md5, 'CAS expected nodes MD5 differs')
    await mkdir(directory, { recursive: true })
    backupPath = path.join(directory, `workflow-schema167-before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const updated = await db.query(`update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,
      schema_version=168,updated_at=now() where id=$1 and schema_version=167
      and md5(nodes::text)=$4 and md5(edges::text)=$5 and xmin::text=$6 returning id`,
    [id, JSON.stringify(next.nodes), JSON.stringify(next.edges),
      before.nodes_md5, before.edges_md5, before.revision])
    assert.equal(updated.rowCount, 1, 'Workflow CAS lost to concurrent editor')
  }
  const saved = (await db.query(`select schema_version,nodes,edges,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id=$1`, [id])).rows[0]
  assert.equal(saved.schema_version, apply ? 168 : 167)
  assert.deepEqual(saved.nodes, apply ? next.nodes : current.nodes)
  assert.deepEqual(saved.edges, apply ? next.edges : current.edges)
  if (apply) { await db.query('COMMIT'); committed = true }
  else await db.query('ROLLBACK')
  console.log(JSON.stringify({ applied: apply, committed, schemaBefore: 167,
    schemaAfter: saved.schema_version, changedNodeIds: changed, addedNodeIds: added,
    removedEdges, addedEdges, nodesMd5Before: before.nodes_md5,
    nodesMd5After: saved.nodes_md5, edgesMd5Before: before.edges_md5,
    edgesMd5After: saved.edges_md5, backupPath, executionWrites: 0,
    providerCalls: 0 }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
