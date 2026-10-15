#!/usr/bin/env node
// Schema181→182. Read-only unless --apply; locks the reviewed graph bytes.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { upgradeDurationRepairRoutingWorkflow } from '../src/duration-confirmed-conflict-workflow.ts'

const args = process.argv.slice(2)
const option = key => { const i = args.indexOf(key); return i < 0 ? '' : args[i + 1] ?? '' }
const apply = args.includes('--apply')
const expectedNodes = option('--expected-nodes-md5'), expectedEdges = option('--expected-edges-md5')
if (apply && (!/^[a-f0-9]{32}$/.test(expectedNodes) || !/^[a-f0-9]{32}$/.test(expectedEdges)))
  throw Error('Expected source nodes and edges MD5 for apply')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await client.connect()
try {
  await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await client.query(`select id,schema_version,nodes,edges,xmin::text as revision,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5 from workflow_configs
    where id='wf-sanguo-history-drama'${apply ? ' for update' : ''}`)).rows[0]
  assert.equal(before?.schema_version, 181)
  const workflow = { id: before.id, schemaVersion: before.schema_version, nodes: before.nodes, edges: before.edges }
  const upgraded = upgradeDurationRepairRoutingWorkflow(workflow)
  assert.equal(upgraded.schemaVersion, 182)
  assert.strictEqual(upgraded.edges, workflow.edges)
  assert.deepEqual(workflow.nodes.filter((node, i) => JSON.stringify(node) !== JSON.stringify(upgraded.nodes[i])).map(node => node.id), ['sanguo-media-accept'])
  if (apply) {
    assert.equal(before.nodes_md5, expectedNodes)
    assert.equal(before.edges_md5, expectedEdges)
    const directory = path.resolve('logs/dramatic-expression/live-20261007/duration-repair-routing-schema182')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, `workflow-schema181-before-${Date.now()}.json`), JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const update = await client.query(`update workflow_configs set schema_version=182,nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=181 and md5(nodes::text)=$3 and md5(edges::text)=$4 and xmin::text=$5 returning id`,
      [before.id, JSON.stringify(upgraded.nodes), expectedNodes, expectedEdges, before.revision])
    assert.equal(update.rowCount, 1)
  }
  const after = (await client.query("select schema_version,nodes,edges from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  assert.equal(after.schema_version, apply ? 182 : 181)
  assert.deepEqual(after.nodes, apply ? upgraded.nodes : workflow.nodes)
  assert.deepEqual(after.edges, workflow.edges)
  await client.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, schemaBefore: 181, schemaAfter: apply ? 182 : 181,
    changedNodeIds: ['sanguo-media-accept'], nodesMd5Before: before.nodes_md5, edgesMd5Before: before.edges_md5,
    executionWrites: 0, providerCalls: 0 }))
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await client.end() }
