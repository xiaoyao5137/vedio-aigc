// Preview by default. --apply changes only managed prompt text and the schema.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeDramaticExpression } from '../src/dramatic-expression.ts'

const apply = process.argv.includes('--apply')
const workflowId = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/dramatic-expression')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const historySnapshot = async () => (await client.query(
  'SELECT id,xmin::text AS row_version,ctid::text AS row_location FROM execution_records WHERE workflow_id=$1 ORDER BY id', [workflowId])).rows
const withoutMutableFields = row => Object.fromEntries(Object.entries(row)
  .filter(([key]) => !['nodes', 'schema_version', 'updated_at'].includes(key)))

await client.connect()
try {
  await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const row = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  assert.ok(row, 'Production Sanguo workflow is missing')
  assert.ok(row.schema_version >= 144, 'Complete the preceding workflow migrations through schema144 before this prompt-only migration')
  const before = { ...row, schemaVersion: row.schema_version }
  const after = upgradeDramaticExpression(before)
  assert.deepEqual(upgradeDramaticExpression(after), after, 'Migration must be idempotent')
  assert.deepEqual(after.edges, before.edges, 'Prompt migration must preserve all edges')
  assert.equal(after.nodes.length, before.nodes.length, 'Prompt migration must preserve all nodes')
  for (const [index, node] of after.nodes.entries()) {
    const unchanged = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'prompt'))
    assert.deepEqual(unchanged(node), unchanged(before.nodes[index]), `Migration changed non-prompt settings for ${node.id}`)
  }
  const changedNodes = after.nodes.filter((node, index) => JSON.stringify(node) !== JSON.stringify(before.nodes[index])).map(node => node.id)
  const changed = hash([before.nodes, before.schemaVersion]) !== hash([after.nodes, after.schemaVersion])
  const historyBefore = await historySnapshot()
  await fs.mkdir(directory, { recursive: true })
  let backup
  if (apply && changed) {
    backup = path.join(directory, `workflow-backup-schema${row.schema_version}-${Date.now()}.json`)
    await fs.writeFile(backup, JSON.stringify(row, null, 2), { flag: 'wx', mode: 0o600 })
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,schema_version=$3,updated_at=now() WHERE id=$1',
      [row.id, JSON.stringify(after.nodes), after.schemaVersion])
  }
  const persisted = (await client.query('SELECT * FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  assert.deepEqual(withoutMutableFields(persisted), withoutMutableFields(row), 'Migration changed another workflow setting')
  assert.deepEqual(persisted.nodes, apply ? after.nodes : before.nodes)
  assert.equal(persisted.schema_version, apply ? after.schemaVersion : before.schemaVersion)
  const historyAfter = await historySnapshot()
  assert.deepEqual(historyAfter, historyBefore, 'Migration changed execution history visible in its transaction')
  await client.query(apply ? 'COMMIT' : 'ROLLBACK')
  const proof = {
    at: new Date().toISOString(), applied: apply, changed, workflowId, backup,
    schemaBefore: row.schema_version, schemaAfter: after.schemaVersion, persistedSchema: persisted.schema_version,
    changedNodes, nodeCount: after.nodes.length, edgeCount: after.edges.length,
    configurationHashBefore: hash([before.nodes, before.edges, before.schemaVersion]),
    configurationHashAfter: hash([after.nodes, after.edges, after.schemaVersion]),
    graphPreserved: true, nonPromptNodeSettingsPreserved: true, otherWorkflowSettingsPreserved: true,
    executionWrites: 0, preservedExecutionRows: historyBefore.length, executionRowVersionsHash: hash(historyBefore),
    historyCheckScope: 'same repeatable-read transaction; execution row id/xmin/ctid unchanged', idempotent: true,
  }
  await fs.writeFile(path.join(directory, `migration-${apply ? 'applied' : 'preview'}.json`), JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally { await client.end() }
