#!/usr/bin/env node
import assert from 'node:assert/strict'
import pg from 'pg'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V186,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V187 } from '../src/scene-cut-advisory-review.ts'

const apply = process.argv.includes('--apply')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await db.query(`select schema_version,nodes,edges,md5(nodes::text) as nodes_md5,
    md5(edges::text) as edges_md5 from workflow_configs where id=$1${apply ? ' for update' : ''}`,
  ['wf-sanguo-history-drama'])).rows[0]
  assert.equal(row?.schema_version, 186)
  const review = row.nodes.find(node => node.id === 'sanguo-scene-cut-review')
  assert.equal(review?.prompt, SCENE_CUT_FRAME_REVIEW_PROMPT_V186)
  const nodes = row.nodes.map(node => node.id === review.id
    ? { ...node, prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V187 } : node)
  if (apply) {
    const updated = await db.query(`update workflow_configs set schema_version=187,nodes=$2::jsonb,
      updated_at=now() where id=$1 and schema_version=186 and md5(nodes::text)=$3
      and md5(edges::text)=$4`, ['wf-sanguo-history-drama', JSON.stringify(nodes),
      row.nodes_md5, row.edges_md5])
    assert.equal(updated.rowCount, 1)
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, schemaBefore: 186,
    schemaAfter: apply ? 187 : 186, changedNodeId: review.id,
    edgesMd5: row.edges_md5, providerCalls: 0 }))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
