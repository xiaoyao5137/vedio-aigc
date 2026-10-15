#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { upgradeWorkingCatTimeline } from '../src/working-cat-timeline-workflow.ts'

const apply = process.argv.includes('--apply')
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('仅支持 --apply；不带参数为只读预览')
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
let committed = false
try {
  await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const saved = (await client.query(`SELECT id,name,schema_version,nodes,edges,xmin::text revision,
    md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs
    WHERE id='wf-workplace-second-trial-v1'${apply ? ' FOR UPDATE' : ''}`)).rows[0]
  assert.ok(saved && saved.name === '打工猫', '没有找到目标打工猫工作流')
  const next = upgradeWorkingCatTimeline({ id: saved.id, schemaVersion: saved.schema_version,
    nodes: saved.nodes, edges: saved.edges })
  assert.equal(next.schemaVersion, 11)
  assert.deepEqual(upgradeWorkingCatTimeline(next), next)
  const beforeRecords = (await client.query('SELECT count(*)::int count FROM execution_records WHERE workflow_id=$1', [saved.id])).rows[0].count
  let backupPath
  if (apply) {
    assert.equal(saved.schema_version, 10, '目标工作流已经更新')
    const directory = path.resolve('logs/working-cat-timeline')
    await mkdir(directory, { recursive: true })
    backupPath = path.join(directory, `schema10-${saved.nodes_md5}-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 })
    const result = await client.query(`UPDATE workflow_configs SET nodes=$2::jsonb,edges=$3::jsonb,
      schema_version=11,updated_at=now() WHERE id=$1 AND schema_version=10
      AND md5(nodes::text)=$4 AND md5(edges::text)=$5 AND xmin::text=$6`,
    [saved.id, JSON.stringify(next.nodes), JSON.stringify(next.edges), saved.nodes_md5, saved.edges_md5, saved.revision])
    assert.equal(result.rowCount, 1, '工作流在迁移期间发生并发修改')
  }
  const after = (await client.query('SELECT schema_version,nodes,edges FROM workflow_configs WHERE id=$1', [saved.id])).rows[0]
  assert.deepEqual(after.nodes, apply ? next.nodes : saved.nodes)
  assert.deepEqual(after.edges, apply ? next.edges : saved.edges)
  assert.equal(after.schema_version, apply ? 11 : saved.schema_version)
  const afterRecords = (await client.query('SELECT count(*)::int count FROM execution_records WHERE workflow_id=$1', [saved.id])).rows[0].count
  assert.equal(afterRecords, beforeRecords, '执行记录数量发生变化')
  if (apply) { await client.query('COMMIT'); committed = true } else await client.query('ROLLBACK')
  console.log(JSON.stringify({ applied: apply, schemaBefore: saved.schema_version, schemaAfter: apply ? 11 : saved.schema_version,
    nodesMd5Before: saved.nodes_md5, edgesMd5Before: saved.edges_md5,
    addedNode: next.nodes.find(node => node.id === 'node-timeline-compose'),
    addedEdge: next.edges.find(edge => edge.id === 'edge-cat-timeline-compose'),
    executionRecords: afterRecords, executionRecordWrites: 0, providerCalls: 0, backupPath }, null, 2))
} catch (error) {
  if (!committed) await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { client.release(); await pool.end() }
