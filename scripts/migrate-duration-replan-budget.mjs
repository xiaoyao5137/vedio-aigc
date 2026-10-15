#!/usr/bin/env node
// Allow one bounded, evidence-driven storyboard replan after a confirmed failure.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const args = process.argv.slice(2), apply = args.includes('--apply')
const option = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] ?? '' }
const expectedNodes = option('--expected-nodes-md5'), expectedEdges = option('--expected-edges-md5')
if (apply && (!/^[a-f0-9]{32}$/.test(expectedNodes) || !/^[a-f0-9]{32}$/.test(expectedEdges)))
  throw Error('Expected source graph MD5s for apply')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`select id,schema_version,nodes,edges,xmin::text as revision,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5 from workflow_configs
    where id='wf-sanguo-history-drama'${apply ? ' for update' : ''}`)).rows[0]
  assert.equal(before?.schema_version, 182)
  const matches = before.nodes.filter(node => node.id === 'sanguo-duration-replan')
  assert.equal(matches.length, 1)
  const node = matches[0], params = node.params.filter(param => (param.englishName ?? param.name) === 'maxAttempts')
  assert.equal(params.length, 1)
  assert.equal(params[0].value, '1')
  assert.equal(node.params.find(param => param.name === 'retryBudgetProfile')?.value, 'manual-review-v1')
  assert.match(node.code, /DURATION_REPLAN_LIMIT/)
  const nodes = before.nodes.map(item => item.id === node.id ? { ...item,
    params: item.params.map(param => param.id === params[0].id ? { ...param, value: '2' } : param) } : item)
  assert.deepEqual(before.nodes.filter((item, i) => JSON.stringify(item) !== JSON.stringify(nodes[i])).map(item => item.id), ['sanguo-duration-replan'])
  if (apply) {
    assert.equal(before.nodes_md5, expectedNodes)
    assert.equal(before.edges_md5, expectedEdges)
    const directory = path.resolve('logs/dramatic-expression/live-20261007/duration-replan-budget-schema183')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, `workflow-schema182-before-${Date.now()}.json`), JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const update = await db.query(`update workflow_configs set schema_version=183,nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=182 and md5(nodes::text)=$3 and md5(edges::text)=$4 and xmin::text=$5 returning id`,
      [before.id, JSON.stringify(nodes), expectedNodes, expectedEdges, before.revision])
    assert.equal(update.rowCount, 1)
  }
  const after = (await db.query("select schema_version,nodes,edges from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  assert.equal(after.schema_version, apply ? 183 : 182)
  assert.deepEqual(after.nodes, apply ? nodes : before.nodes)
  assert.deepEqual(after.edges, before.edges)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, schemaBefore: 182, schemaAfter: apply ? 183 : 182,
    changedNodeIds: ['sanguo-duration-replan'], maxAttemptsBefore: 1, maxAttemptsAfter: 2,
    nodesMd5Before: before.nodes_md5, edgesMd5Before: before.edges_md5, executionWrites: 0, providerCalls: 0 }))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
