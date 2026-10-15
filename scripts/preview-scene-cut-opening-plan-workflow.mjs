#!/usr/bin/env node
// Read-only schema167→168 graph rehearsal. Never writes workflow or executions.
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeSceneCutOpeningPlanWorkflow } from '../src/scene-cut-opening-plan-workflow.ts'

const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('BEGIN READ ONLY')
  const row = (await db.query(`select id,schema_version,nodes,edges,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.ok(row && row.schema_version === 167, 'Expected persisted schema167')
  const before = { id: row.id, schemaVersion: row.schema_version, nodes: row.nodes, edges: row.edges }
  const after = upgradeSceneCutOpeningPlanWorkflow(before)
  assert.equal(after.schemaVersion, 168)
  assert.equal(upgradeSceneCutOpeningPlanWorkflow(after), after)
  assert.equal(after.nodes.length, before.nodes.length + 1)
  assert.equal(after.edges.length, before.edges.length + 1)
  const changedNodes = before.nodes.filter((node, index) =>
    JSON.stringify(node) !== JSON.stringify(after.nodes[index])).map(node => node.id).sort()
  const addedNodes = after.nodes.filter(node => !before.nodes.some(item => item.id === node.id)).map(node => node.id)
  const removedEdges = before.edges.filter(edge => !after.edges.some(item => item.id === edge.id))
  const addedEdges = after.edges.filter(edge => !before.edges.some(item => item.id === edge.id))
  assert.deepEqual(changedNodes, ['sanguo-scene-loop', 'sanguo-scene-cut-first-frame',
    'sanguo-scene-cut-review', 'sanguo-scene-cut-approval'].sort())
  assert.deepEqual(addedNodes, ['sanguo-scene-cut-opening-plan'])
  assert.equal(removedEdges.length, 1)
  assert.equal(removedEdges[0].from, 'sanguo-scene-cut-source-archive')
  assert.equal(removedEdges[0].to, 'sanguo-scene-cut-first-frame')
  assert.deepEqual(addedEdges.map(edge => `${edge.from}->${edge.to}`).sort(), [
    'sanguo-scene-cut-opening-plan->sanguo-scene-cut-first-frame',
    'sanguo-scene-cut-source-archive->sanguo-scene-cut-opening-plan' ].sort())
  const hashes = (await db.query(`select md5($1::jsonb::text) as nodes_md5,
    md5($2::jsonb::text) as edges_md5`, [JSON.stringify(after.nodes), JSON.stringify(after.edges)])).rows[0]
  await db.query('COMMIT')
  console.log(JSON.stringify({ dryRun: true, schemaBefore: 167, schemaAfter: 168,
    changedNodes, addedNodes, removedEdges, addedEdges,
    nodeCountBefore: before.nodes.length, nodeCountAfter: after.nodes.length,
    edgeCountBefore: before.edges.length, edgeCountAfter: after.edges.length,
    nodesMd5Before: row.nodes_md5, nodesMd5After: hashes.nodes_md5,
    edgesMd5Before: row.edges_md5, edgesMd5After: hashes.edges_md5,
    databaseWrites: 0, executionWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
