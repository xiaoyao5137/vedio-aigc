#!/usr/bin/env node
// Schema194→195: replace only the managed scene-cut image prompt.
import assert from 'node:assert/strict'
import pg from 'pg'
import { SCENE_CUT_FIRST_FRAME_PROMPT } from '../src/scene-cut-first-frame-gate.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V195 } from '../src/scene-cut-static-opening-v195.ts'

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
  const image = before.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')
  assert.equal(image?.prompt, SCENE_CUT_FIRST_FRAME_PROMPT)
  const next = before.nodes.map(node => node.id === image.id
    ? { ...node, prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V195 } : node)
  assert.equal(next.length, before.nodes.length)
  assert.deepEqual(next.filter((node, index) => JSON.stringify(node) !== JSON.stringify(before.nodes[index]))
    .map(node => node.id), [image.id])
  if (apply) {
    assert.equal(before.nodes_md5, expected)
    const result = await db.query(`update workflow_configs set schema_version=195,nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=194 and md5(nodes::text)=$3 and xmin::text=$4 returning id`,
    [before.id, JSON.stringify(next), expected, before.revision])
    assert.equal(result.rowCount, 1)
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, schemaBefore: 194, schemaAfter: apply ? 195 : 194,
    changedNodeIds: [image.id], nodesMd5Before: before.nodes_md5,
    edgesMd5Before: before.edges_md5, executionWrites: 0, providerCalls: 0 }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
