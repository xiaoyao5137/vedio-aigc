#!/usr/bin/env node
import pg from 'pg'
import { upgradeWorkplaceShotSubtitles } from '../src/story-subtitle-workflow.ts'

const id = 'wf-workplace-second-trial-v1'
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('begin')
  const source = (await db.query(`select id,name,schema_version,nodes,edges,md5(nodes::text) nodes_md5,
    md5(edges::text) edges_md5 from workflow_configs where id=$1 for update`, [id])).rows[0]
  if (!source || source.name !== '打工猫') throw Error('工作流身份不符合预期')
  const next = upgradeWorkplaceShotSubtitles({ id, schemaVersion: source.schema_version,
    nodes: source.nodes, edges: source.edges })
  if (next.nodes === source.nodes) {
    await db.query('commit')
    console.log(JSON.stringify({ id, schemaVersion: source.schema_version, alreadyApplied: true }))
  } else {
    const updated = await db.query(`update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,
      schema_version=$4,updated_at=now() where id=$1 and schema_version=$5
      and md5(nodes::text)=$6 and md5(edges::text)=$7`,
    [id, JSON.stringify(next.nodes), JSON.stringify(next.edges), next.schemaVersion,
      source.schema_version, source.nodes_md5, source.edges_md5])
    if (updated.rowCount !== 1) throw Error('工作流并发变化，未写入')
    await db.query('commit')
    console.log(JSON.stringify({ id, schemaVersion: next.schemaVersion, nodeId: 'node-shot-subtitles',
      resultVar: 'shot_subtitles', from: 'node-video', to: 'node-video-review' }))
  }
} catch (error) {
  await db.query('rollback')
  throw error
} finally { await db.end() }
