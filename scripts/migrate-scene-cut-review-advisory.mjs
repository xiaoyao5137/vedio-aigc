#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from '../src/scene-cut-action-start-workflow.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V186 } from '../src/scene-cut-advisory-review.ts'

const args = process.argv.slice(2), apply = args.includes('--apply')
const option = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] ?? '' }
const expectedNodes = option('--expected-nodes-md5'), expectedEdges = option('--expected-edges-md5')
if (apply && (!/^[a-f0-9]{32}$/.test(expectedNodes) || !/^[a-f0-9]{32}$/.test(expectedEdges)))
  throw Error('Expected current graph MD5s for apply')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await db.query(`select id,schema_version,nodes,edges,xmin::text as revision,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5 from workflow_configs
    where id='wf-sanguo-history-drama'${apply ? ' for update' : ''}`)).rows[0]
  assert.equal(before?.schema_version, 185)
  const target = before.nodes.filter(node => node.id === 'sanguo-scene-cut-review')
  assert.equal(target.length, 1)
  assert.equal(target[0].kind, 'text')
  assert.equal(target[0].prompt, SCENE_CUT_FRAME_REVIEW_PROMPT_V174)
  const nodes = before.nodes.map(node => node.id === target[0].id
    ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V186 } : node)
  assert.deepEqual(before.nodes.filter((node, index) => JSON.stringify(node) !== JSON.stringify(nodes[index]))
    .map(node => node.id), [target[0].id])
  if (apply) {
    assert.equal(before.nodes_md5, expectedNodes)
    assert.equal(before.edges_md5, expectedEdges)
    const dir = path.resolve('logs/dramatic-expression/live-20261007/scene-cut-advisory-schema186')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `workflow-schema185-before-${Date.now()}.json`),
      JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    const updated = await db.query(`update workflow_configs set schema_version=186,nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=185 and md5(nodes::text)=$3 and md5(edges::text)=$4
      and xmin::text=$5 returning id`,
    [before.id, JSON.stringify(nodes), expectedNodes, expectedEdges, before.revision])
    assert.equal(updated.rowCount, 1)
  }
  const after = (await db.query("select schema_version,nodes,edges from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  assert.equal(after.schema_version, apply ? 186 : 185)
  assert.deepEqual(after.nodes, apply ? nodes : before.nodes)
  assert.deepEqual(after.edges, before.edges)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, schemaBefore: 185, schemaAfter: apply ? 186 : 185,
    changedNodeIds: [target[0].id], oldPromptLength: target[0].prompt.length,
    newPromptLength: SCENE_CUT_FRAME_REVIEW_PROMPT_V186.length, providerCalls: 0 }))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
