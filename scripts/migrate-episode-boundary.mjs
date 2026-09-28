#!/usr/bin/env node
// Preview by default. Apply only after the dramatic-expression prompt refresh;
// this preserves every node setting, uploaded workbook, and execution record.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeEpisodeBoundary } from '../src/episode-boundary.ts'

const apply = process.argv.includes('--apply')
const workflowId = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/episode-boundary-20260928')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const history = async () => (await client.query('SELECT id,xmin::text AS version,ctid::text AS location FROM execution_records WHERE workflow_id=$1 ORDER BY id', [workflowId])).rows

await client.connect()
try {
  await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const row = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  assert.ok(row && row.schema_version >= 148, 'Sanguo saved workflow at schema 148 or later is required')
  const before = { ...row, schemaVersion: row.schema_version }
  const after = upgradeEpisodeBoundary(before)
  assert.deepEqual(upgradeEpisodeBoundary(after), after, 'Episode boundary migration must be idempotent')
  assert.deepEqual(after.edges, before.edges, 'Episode boundary migration must preserve edges')
  assert.equal(after.nodes.length, before.nodes.length, 'Episode boundary migration must preserve node count')
  const allowed = { 'sanguo-context-init': ['code'], 'sanguo-scene-outline': ['prompt'], 'sanguo-scene-outline-review': ['prompt'] }
  const changedNodes = []
  for (const [index, node] of after.nodes.entries()) {
    const old = before.nodes[index]
    assert.equal(node.id, old.id, 'Episode boundary migration changed node order')
    const changedKeys = [...new Set([...Object.keys(old), ...Object.keys(node)])]
      .filter(key => JSON.stringify(node[key]) !== JSON.stringify(old[key]))
    assert.deepEqual(changedKeys.sort(), (allowed[node.id] ?? []).filter(key => changedKeys.includes(key)).sort(),
      `Episode boundary migration changed unowned setting on ${node.id}`)
    if (changedKeys.length) changedNodes.push({ id: node.id, fields: changedKeys })
  }
  const init = after.nodes.find(node => node.id === 'sanguo-context-init')
  const writer = after.nodes.find(node => node.id === 'sanguo-scene-outline')
  const reviewer = after.nodes.find(node => node.id === 'sanguo-scene-outline-review')
  assert.ok(init?.code?.includes('episode-boundary-v1') && writer?.prompt?.includes('【策划表分集边界】')
    && reviewer?.prompt?.includes('【策划表分集归属审查】'), 'All three episode-boundary contracts must be installed')
  assert.ok(writer.prompt.includes('【影视表达与现代汉语·大纲】'), 'Apply the dramatic-expression prompt migration first')
  const beforeHistory = await history()
  await fs.mkdir(directory, { recursive: true })
  const changed = hash([before.nodes, before.schema_version]) !== hash([after.nodes, after.schemaVersion])
  let backup
  if (apply && changed) {
    backup = path.join(directory, `workflow-backup-schema${row.schema_version}-${Date.now()}.json`)
    await fs.writeFile(backup, JSON.stringify(row, null, 2), { flag: 'wx', mode: 0o600 })
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,schema_version=$3,updated_at=now() WHERE id=$1',
      [workflowId, JSON.stringify(after.nodes), after.schemaVersion])
  }
  const persisted = (await client.query('SELECT * FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  assert.deepEqual(persisted.nodes, apply ? after.nodes : before.nodes)
  assert.equal(persisted.schema_version, apply ? after.schemaVersion : before.schema_version)
  assert.deepEqual(await history(), beforeHistory, 'Migration touched execution history')
  await client.query(apply ? 'COMMIT' : 'ROLLBACK')
  const proof = { at: new Date().toISOString(), applied: apply, changed, workflowId, backup,
    schemaBefore: row.schema_version, schemaAfter: after.schemaVersion, changedNodes,
    nodeCount: after.nodes.length, edgeCount: after.edges.length,
    workflowHashBefore: hash([before.nodes, before.edges, before.schema_version]),
    workflowHashAfter: hash([after.nodes, after.edges, after.schemaVersion]),
    preservedExecutionRows: beforeHistory.length, executionRowVersionsHash: hash(beforeHistory),
    uploadsAndParamsUnchanged: true, graphUnchanged: true, idempotent: true, executionWrites: 0 }
  await fs.writeFile(path.join(directory, `migration-${apply ? 'applied' : 'preview'}.json`), JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally { await client.end() }
