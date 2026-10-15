#!/usr/bin/env node
// Synchronize only the managed scene-cut review route. Existing executions are untouched.
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeImageReviewRouteWorkflow } from '../src/image-review-route-workflow.ts'

const apply = process.argv.includes('--apply')
const expected = process.argv.find(arg => arg.startsWith('--expected-nodes-md5='))?.split('=')[1]
if (apply && !/^[a-f0-9]{32}$/i.test(expected ?? '')) throw Error('Exact nodes MD5 required')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`select id,schema_version,nodes,edges,xmin::text as revision,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id='wf-sanguo-history-drama'${apply ? ' for update' : ''}`)).rows[0]
  assert.equal(before?.schema_version, 194)
  const original = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const upgraded = upgradeImageReviewRouteWorkflow(original)
  assert.deepEqual(upgradeImageReviewRouteWorkflow(upgraded), upgraded)
  assert.deepEqual(upgraded.edges, original.edges)
  const changed = upgraded.nodes.filter((node, index) =>
    JSON.stringify(node) !== JSON.stringify(original.nodes[index])).map(node => node.id)
  assert.deepEqual(changed, ['sanguo-scene-cut-review-route'])
  if (apply) {
    assert.equal(before.nodes_md5, expected)
    const update = await db.query(`update workflow_configs set nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=194 and md5(nodes::text)=$3 and xmin::text=$4 returning id`,
    [before.id, JSON.stringify(upgraded.nodes), expected, before.revision])
    assert.equal(update.rowCount, 1)
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, changedNodeIds: changed,
    nodesMd5Before: before.nodes_md5, edgesMd5Before: before.edges_md5,
    executionWrites: 0, providerCalls: 0 }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
