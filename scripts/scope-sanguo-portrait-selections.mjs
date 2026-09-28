// Make the already approved Changban portraits the default for episode 518
// without imposing their artistic age and campaign costume on later episodes.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'

const apply = process.argv.includes('--apply')
const workflowId = 'wf-sanguo-history-drama'
const proofFile = path.resolve('logs/portrait-upgrade-20260928/episode-scoped-default.json')
const approved = JSON.parse(await fs.readFile('logs/portrait-upgrade-20260928/workflow-bind-proof.json', 'utf8'))
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const client = new pg.Client({connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'})
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  assert.ok(row)
  const input = row.nodes.find(node => node.id === 'sanguo-input')
  assert.ok(input?.kind === 'input')
  const param = input.params.find(value => (value.englishName || value.name) === 'characterAssetSelections')
  assert.ok(param)
  const existing = typeof param.value === 'string' ? JSON.parse(param.value) : param.value
  assert.deepEqual(existing, approved.newSelections, 'Default portraits changed since prior approved binding; refuse to change user choice')
  const scoped = Object.fromEntries(Object.entries(existing).map(([name, assetId]) => [name, {assetId, episodes:[518]}]))
  const nodes = row.nodes.map(node => node.id !== 'sanguo-input' ? node : {
    ...node, params: node.params.map(value => value === param ? {...value, value: JSON.stringify(scoped)} : value),
  })
  const unaffected = before => before.filter(node => node.id !== 'sanguo-input')
  assert.deepEqual(unaffected(nodes), unaffected(row.nodes))
  const executionBefore = (await client.query('SELECT id,xmin::text AS version,ctid::text AS location FROM execution_records WHERE workflow_id=$1 ORDER BY id', [workflowId])).rows
  const backupFile = path.resolve('logs/portrait-upgrade-20260928/workflow-before-episode-scope.json')
  if (apply) {
    await fs.writeFile(backupFile, JSON.stringify(row, null, 2), {flag:'wx', mode:0o600})
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now() WHERE id=$1', [workflowId, JSON.stringify(nodes)])
  }
  const persisted = (await client.query('SELECT nodes,edges,schema_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  assert.deepEqual(persisted.nodes, apply ? nodes : row.nodes)
  assert.deepEqual(persisted.edges, row.edges)
  assert.equal(persisted.schema_version, row.schema_version)
  const executionAfter = (await client.query('SELECT id,xmin::text AS version,ctid::text AS location FROM execution_records WHERE workflow_id=$1 ORDER BY id', [workflowId])).rows
  assert.deepEqual(executionAfter, executionBefore)
  const proof = {at:new Date().toISOString(), applied:apply, workflowId, episode:518, portraits:scoped,
    beforeHash:hash(row.nodes), afterHash:hash(apply ? persisted.nodes : nodes), changedNodes:['sanguo-input'],
    graphPreserved:true, historicalRecordsPreserved:true, historicalRecordCount:executionBefore.length,
    backupFile:apply ? backupFile : null, executionWrites:0}
  await client.query(apply ? 'COMMIT' : 'ROLLBACK')
  if (apply) await fs.writeFile(proofFile, JSON.stringify(proof, null, 2), {flag:'wx'})
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {await client.end()}
