import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import pg from 'pg'
import assert from 'node:assert/strict'
import { upgradeQualityWorkflow } from '../src/quality-node-presets.ts'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'
import { branchConfigurationErrors } from '../src/workflow-branch.ts'

const apply = process.argv.includes('--apply')
const refreshManaged = process.argv.includes('--refresh-managed')
const directory = 'logs/duration-v2-implementation'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
await fs.mkdir(directory, { recursive: true })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, ['wf-sanguo-history-drama'])).rows[0]
  assert.ok(row, 'Production workflow must exist')
  const before = { ...row, schemaVersion: row.schema_version }
  const upgrade = value => migrateBranchWorkflow(upgradeQualityWorkflow(value))
  const candidate = upgrade(refreshManaged && before.schemaVersion === 115 ? { ...before, schemaVersion: 114 } : before)
  assert.equal(candidate.schemaVersion, 115, 'Expected duration-v2 migration')
  assert.deepEqual(upgrade(candidate), candidate, 'Migration must be idempotent')
  assert.deepEqual(branchConfigurationErrors(candidate), [])
  for (const node of before.nodes) {
    const next = candidate.nodes.find(n => n.id === node.id)
    assert.equal(next.modelId, node.modelId, `Preserve selected model: ${node.id}`)
    assert.deepEqual(next.mapInput, node.mapInput, `Preserve concurrency: ${node.id}`)
  }
  const recordsBefore = (await client.query('SELECT id,md5(result::text) AS hash FROM execution_records WHERE workflow_id=$1 ORDER BY id', [row.id])).rows
  const changed = hash([before.nodes, before.edges, before.schemaVersion]) !== hash([candidate.nodes, candidate.edges, candidate.schemaVersion])
  const stamp = new Date().toISOString().replaceAll(':', '-')
  await fs.writeFile(`${directory}/workflow-reviewed.json`, JSON.stringify(candidate, null, 2))
  if (apply && changed) {
    await fs.writeFile(`${directory}/workflow-rollback-${stamp}.json`, JSON.stringify(row, null, 2), { flag: 'wx' })
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,edges=$3::jsonb,schema_version=$4,updated_at=now() WHERE id=$1',
      [row.id, JSON.stringify(candidate.nodes), JSON.stringify(candidate.edges), candidate.schemaVersion])
  }
  const after = (await client.query('SELECT nodes,edges,schema_version FROM workflow_configs WHERE id=$1', [row.id])).rows[0]
  if (apply) assert.deepEqual([after.nodes, after.edges, after.schema_version], [candidate.nodes, candidate.edges, candidate.schemaVersion])
  const recordsAfter = (await client.query('SELECT id,md5(result::text) AS hash FROM execution_records WHERE workflow_id=$1 ORDER BY id', [row.id])).rows
  // The migration does not write executions; record any independent live app updates.
  const concurrentChanges = recordsAfter.filter(record => recordsBefore.some(old => old.id === record.id && old.hash !== record.hash)).map(r => r.id)
  await client.query('COMMIT')
  const proof = { at: new Date().toISOString(), applied: apply, changed, workflowId: row.id, name: row.name,
    schemaBefore: row.schema_version, schemaAfter: apply ? after.schema_version : candidate.schemaVersion,
    nodes: candidate.nodes.length, edges: candidate.edges.length, modelChoicesPreserved: true, idempotent: true,
    executionWrites: 0, concurrentExecutionChanges: concurrentChanges,
    configurationHash: hash([candidate.nodes, candidate.edges, candidate.schemaVersion]) }
  await fs.writeFile(`${directory}/migration-${apply ? 'applied' : 'preview'}.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally { await client.end() }
