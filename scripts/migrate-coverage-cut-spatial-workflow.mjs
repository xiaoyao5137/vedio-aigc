#!/usr/bin/env node
// Schema193→194: change only the two managed coverage-cut prompts.
// Dry-run by default; completed execution snapshots and media are untouched.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { upgradeCoverageCutSpatialWorkflow } from '../src/coverage-cut-identity-workflow.ts'

const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] ?? '' }
const apply = args.includes('--apply')
const expectedNodes = option('--expected-nodes-md5')
const expectedEdges = option('--expected-edges-md5')
if (apply && (!/^[a-f0-9]{32}$/.test(expectedNodes) || !/^[a-f0-9]{32}$/.test(expectedEdges)))
  throw Error('Apply requires exact source nodes and edges MD5')

const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`select id,schema_version,nodes,edges,xmin::text as revision,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5 from workflow_configs
    where id='wf-sanguo-history-drama'${apply ? ' for update' : ''}`)).rows[0]
  assert.equal(before?.schema_version, 193, 'Expected saved schema193')
  const workflow = { id: before.id, schemaVersion: before.schema_version,
    nodes: before.nodes, edges: before.edges }
  const next = upgradeCoverageCutSpatialWorkflow(workflow)
  assert.equal(next.schemaVersion, 194)
  assert.deepEqual(upgradeCoverageCutSpatialWorkflow(next), next)
  assert.strictEqual(next.edges, workflow.edges)
  const changed = workflow.nodes.filter((node, index) =>
    JSON.stringify(node) !== JSON.stringify(next.nodes[index])).map(node => node.id).sort()
  assert.deepEqual(changed, ['sanguo-coverage-first-frame', 'sanguo-coverage-review'])
  if (apply) {
    assert.equal(before.nodes_md5, expectedNodes)
    assert.equal(before.edges_md5, expectedEdges)
    const backupDir = path.resolve('logs/dramatic-expression/live-20261009/coverage-spatial-schema194')
    await mkdir(backupDir, { recursive: true })
    await writeFile(path.join(backupDir, `workflow-schema193-before-${Date.now()}.json`),
      JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const update = await db.query(`update workflow_configs set schema_version=194,nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=193 and md5(nodes::text)=$3 and md5(edges::text)=$4
      and xmin::text=$5 returning id`,
    [before.id, JSON.stringify(next.nodes), expectedNodes, expectedEdges, before.revision])
    assert.equal(update.rowCount, 1)
  }
  const after = (await db.query(`select schema_version,nodes,edges from workflow_configs
    where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(after.schema_version, apply ? 194 : 193)
  assert.deepEqual(after.nodes, apply ? next.nodes : workflow.nodes)
  assert.deepEqual(after.edges, workflow.edges)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, schemaBefore: 193, schemaAfter: after.schema_version,
    changedNodeIds: changed, nodesMd5Before: before.nodes_md5, edgesMd5Before: before.edges_md5,
    executionWrites: 0, providerCalls: 0 }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
