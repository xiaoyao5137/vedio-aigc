#!/usr/bin/env node
// CAS migration of the two managed schema-165 opening prompts. Does not edit executions.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { upgradeSceneCutOpeningStateWorkflow } from '../src/scene-cut-first-frame-gate.ts'

const workflowId = 'wf-sanguo-history-drama'
const apply = process.argv.includes('--apply')
const expected = process.argv.indexOf('--expected-before-md5')
const expectedBeforeMd5 = expected < 0 ? '' : process.argv[expected + 1] ?? ''
const output = path.resolve('logs/dramatic-expression/live-20260929/scene-cut-opening-state-schema166')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

await db.connect()
let committed = false
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`SELECT id,schema_version,nodes,edges,xmin::text AS revision,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs
    WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  assert.ok(before, 'Sanguo workflow config missing')
  assert.equal(before.schema_version, 165, `Expected schema165, got ${before.schema_version}`)
  const current = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = upgradeSceneCutOpeningStateWorkflow(current)
  assert.equal(next.schemaVersion, 166)
  assert.equal(upgradeSceneCutOpeningStateWorkflow(next), next, 'Migration must be idempotent')
  assert.equal(next.nodes.length, current.nodes.length)
  assert.equal(next.edges, current.edges, 'Migration must preserve all edges')
  const byId = new Map(current.nodes.map(node => [node.id, node]))
  const changed = next.nodes.filter(node => hash(node) !== hash(byId.get(node.id))).map(node => node.id)
  assert.deepEqual(changed.sort(), ['sanguo-scene-cut-first-frame', 'sanguo-scene-cut-review'].sort())
  const oldLoop = current.nodes.find(node => node.id === 'sanguo-scene-loop')?.childIds
  const newLoop = next.nodes.find(node => node.id === 'sanguo-scene-loop')?.childIds
  assert.deepEqual(newLoop, oldLoop)
  let backupPath = ''
  if (apply) {
    assert.equal(expectedBeforeMd5, before.nodes_md5, 'CAS expected nodes MD5 differs from saved row')
    await mkdir(output, { recursive: true })
    backupPath = path.join(output, `workflow-schema165-before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const updated = await db.query(`UPDATE workflow_configs SET nodes=$2::jsonb,
      schema_version=166,updated_at=now() WHERE id=$1 AND schema_version=165
      AND md5(nodes::text)=$3 AND md5(edges::text)=$4 AND xmin::text=$5 RETURNING id`,
    [workflowId, JSON.stringify(next.nodes), before.nodes_md5, before.edges_md5, before.revision])
    assert.equal(updated.rowCount, 1, 'Workflow CAS lost to concurrent editor')
  }
  const saved = (await db.query(`SELECT schema_version,nodes,edges,md5(nodes::text) AS nodes_md5,
    md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [workflowId])).rows[0]
  assert.equal(saved.schema_version, apply ? 166 : 165)
  assert.deepEqual(saved.nodes, apply ? next.nodes : current.nodes)
  assert.deepEqual(saved.edges, current.edges)
  if (apply) { await db.query('COMMIT'); committed = true }
  else await db.query('ROLLBACK')
  console.log(JSON.stringify({ applied: apply, committed, workflowId, schemaBefore: 165,
    schemaAfter: saved.schema_version, changedNodeIds: changed, nodesBefore: current.nodes.length,
    nodesAfter: next.nodes.length, edgesBefore: current.edges.length, edgesAfter: next.edges.length,
    nodesMd5Before: before.nodes_md5, nodesMd5After: saved.nodes_md5,
    edgesMd5Before: before.edges_md5, edgesMd5After: saved.edges_md5,
    backupPath, executionWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  if (!committed) await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
