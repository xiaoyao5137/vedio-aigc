#!/usr/bin/env node
import assert from 'node:assert/strict'
import pg from 'pg'
import { SCENE_CUT_POST_TRAVEL_SETTLE_REVIEW_ADDENDUM } from '../src/scene-cut-first-frame-gate.ts'

const expectedNodesMd5 = process.argv.find(arg => arg.startsWith('--expected-nodes-md5='))?.split('=')[1]
const apply = process.argv.includes('--apply')
if (apply && !/^[a-f0-9]{32}$/i.test(expectedNodesMd5 ?? '')) throw Error('Apply requires nodes MD5 lock')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const row = (await db.query(`select schema_version,nodes,md5(nodes::text) as nodes_md5,
    md5(edges::text) as edges_md5 from workflow_configs where id=$1${apply ? ' for update' : ''}`,
  ['wf-sanguo-history-drama'])).rows[0]
  assert.equal(row?.schema_version, 195)
  if (apply) assert.equal(row.nodes_md5, expectedNodesMd5)
  const review = row.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  assert.equal(typeof review?.prompt, 'string')
  assert.ok(review.prompt.includes('【不明确的收绳起点留待用户断点判断·v187】'))
  assert.ok(!review.prompt.includes(SCENE_CUT_POST_TRAVEL_SETTLE_REVIEW_ADDENDUM.trim()))
  const nodes = row.nodes.map(node => node.id === review.id
    ? { ...node, prompt: node.prompt + SCENE_CUT_POST_TRAVEL_SETTLE_REVIEW_ADDENDUM } : node)
  if (apply) {
    const result = await db.query(`update workflow_configs set schema_version=196,nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=195 and md5(nodes::text)=$3`,
    ['wf-sanguo-history-drama', JSON.stringify(nodes), row.nodes_md5])
    assert.equal(result.rowCount, 1)
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  const final = apply ? (await db.query(`select md5(nodes::text) as nodes_md5,
    md5(edges::text) as edges_md5 from workflow_configs where id=$1`,
  ['wf-sanguo-history-drama'])).rows[0] : undefined
  console.log(JSON.stringify({ applied: apply, oldNodesMd5: row.nodes_md5,
    newNodesMd5: final?.nodes_md5, edgesMd5: final?.edges_md5,
    updatedNode: review.id, providerCalls: 0 }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
