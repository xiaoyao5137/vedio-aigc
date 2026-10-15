#!/usr/bin/env node
// Read-only schema166→167 rehearsal against the current persisted graph.
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeSceneCutT0ImageContractWorkflow } from '../src/scene-cut-t0-image-contract.ts'

const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('BEGIN READ ONLY')
  const row = (await db.query(`select id,schema_version,nodes,edges,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.ok(row, 'Workflow missing')
  assert.equal(row.schema_version, 166, 'Expected persisted schema166')
  const before = { id: row.id, schemaVersion: row.schema_version, nodes: row.nodes, edges: row.edges }
  const after = upgradeSceneCutT0ImageContractWorkflow(before)
  assert.equal(after.schemaVersion, 167, 'Managed prompt anchors did not match')
  assert.equal(after.nodes.length, before.nodes.length)
  assert.deepEqual(after.edges, before.edges)
  assert.equal(upgradeSceneCutT0ImageContractWorkflow(after), after)
  const changedNodes = before.nodes.filter((node, index) =>
    JSON.stringify(node) !== JSON.stringify(after.nodes[index])).map(node => node.id).sort()
  assert.deepEqual(changedNodes,
    ['sanguo-scene-cut-first-frame', 'sanguo-scene-cut-review'].sort())
  const nextNodesMd5 = (await db.query('select md5($1::jsonb::text) as hash',
    [JSON.stringify(after.nodes)])).rows[0].hash
  await db.query('COMMIT')
  console.log(JSON.stringify({ dryRun: true, schemaBefore: row.schema_version,
    schemaAfter: after.schemaVersion, changedNodes, changedEdges: 0,
    nodeCount: before.nodes.length, edgeCount: before.edges.length,
    nodesMd5Before: row.nodes_md5, nodesMd5After: nextNodesMd5,
    edgesMd5Before: row.edges_md5, edgesMd5After: row.edges_md5,
    databaseWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
