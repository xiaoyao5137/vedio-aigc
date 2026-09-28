// Preview by default. --apply upgrades only the saved Sanguo workflow graph;
// paid execution records and their node outputs remain immutable.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { upgradeSandTableWorkflow } from '../src/sand-table-workflow.ts'

const apply = process.argv.includes('--apply')
const workflowId = 'wf-sanguo-history-drama'
const outputIndex = process.argv.indexOf('--out')
const directory = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : 'logs/historical-map-20260928/frame-gate-migration')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const history = async () => (await client.query('SELECT id,xmin::text AS revision,ctid::text AS location FROM execution_records WHERE workflow_id=$1 ORDER BY id', [workflowId])).rows
await client.connect()
try {
  await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  assert.ok(before?.schema_version >= 151, 'Historical geography contract schema 151 must be installed first')
  const after = upgradeSandTableWorkflow({ ...before, schemaVersion: before.schema_version })
  assert.deepEqual(upgradeSandTableWorkflow(after), after, 'Graph/prompt upgrade must be idempotent')
  assert.ok(after.schemaVersion >= 153, 'Signed map frame and annotation gates must be present')
  const addedIds = new Set(['sanguo-map-annotation-review', 'sanguo-map-annotation-approval',
    'sanguo-map-first-evidence', 'sanguo-map-first-review', 'sanguo-map-first-accept',
    'sanguo-map-end-evidence', 'sanguo-map-end-review', 'sanguo-map-end-accept'])
  for (const id of addedIds) assert.equal(after.nodes.filter(node => node.id === id).length, 1, `Missing/duplicate ${id}`)
  const managedExisting = new Map([
    ['sanguo-scene-loop', ['childIds']], ['sanguo-first-frame-branch', ['code']], ['sanguo-video', ['params']],
    ['sanguo-scene-outline', ['prompt']], ['sanguo-shot-script', ['prompt']],
    ['sanguo-animated-map-first-frame', ['prompt', 'params']], ['sanguo-end-frame', ['prompt', 'params']],
    ['sanguo-map-first-evidence', ['runIf']], ['sanguo-map-end-evidence', ['runIf']],
    ['sanguo-map-first-review', ['params', 'prompt', 'runIf']], ['sanguo-map-end-review', ['params', 'prompt', 'runIf']],
    ['sanguo-map-first-accept', ['kind', 'code', 'request', 'prompt', 'runIf']],
    ['sanguo-map-end-accept', ['kind', 'code', 'request', 'prompt', 'runIf']],
  ])
  const stable = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
  for (const node of before.nodes) {
    const next = after.nodes.find(candidate => candidate.id === node.id)
    assert.ok(next, `Existing node removed: ${node.id}`)
    assert.deepEqual(stable(next, managedExisting.get(node.id) ?? []), stable(node, managedExisting.get(node.id) ?? []), `Unexpected existing node change: ${node.id}`)
  }
  assert.deepEqual(after.edges.filter(edge => !edge.id.startsWith('sg-e-map-') && !(edge.from === 'sanguo-end-frame' && edge.to === 'sanguo-video')),
    before.edges.filter(edge => !edge.id.startsWith('sg-e-map-') && !(edge.from === 'sanguo-end-frame' && edge.to === 'sanguo-video')), 'Unexpected existing edge change')
  const beforeHistory = await history()
  // PostgreSQL jsonb may reorder object keys. That is not a workflow change,
  // and must not trigger a needless write over a newer concurrent schema.
  const changed = !isDeepStrictEqual(
    [before.nodes, before.edges, before.schema_version],
    [after.nodes, after.edges, after.schemaVersion],
  )
  await fs.mkdir(directory, { recursive: true })
  let backup
  if (apply && changed) {
    backup = path.join(directory, `workflow-before-schema${before.schema_version}-${Date.now()}.json`)
    await fs.writeFile(backup, JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 })
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,edges=$3::jsonb,schema_version=$4,updated_at=now() WHERE id=$1',
      [workflowId, JSON.stringify(after.nodes), JSON.stringify(after.edges), after.schemaVersion])
  }
  const saved = (await client.query('SELECT * FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  assert.deepEqual(stable(saved, ['nodes', 'edges', 'schema_version', 'updated_at']), stable(before, ['nodes', 'edges', 'schema_version', 'updated_at']))
  assert.deepEqual(saved.nodes, apply ? after.nodes : before.nodes)
  assert.deepEqual(saved.edges, apply ? after.edges : before.edges)
  assert.deepEqual(await history(), beforeHistory, 'Execution records must not be rewritten')
  await client.query(apply ? 'COMMIT' : 'ROLLBACK')
  const proof = { at: new Date().toISOString(), workflowId, applied: apply, changed, backup,
    schemaBefore: before.schema_version, schemaAfter: after.schemaVersion, persistedSchema: saved.schema_version,
    nodeCountBefore: before.nodes.length, nodeCountAfter: after.nodes.length,
    edgeCountBefore: before.edges.length, edgeCountAfter: after.edges.length,
    changedExistingNodes: before.nodes.filter(node => !isDeepStrictEqual(node, after.nodes.find(candidate => candidate.id === node.id))).map(node => node.id),
    preservedExecutionRows: beforeHistory.length, executionRowsHash: hash(beforeHistory), executionWrites: 0, idempotent: true }
  await fs.writeFile(path.join(directory, `migration-${apply ? 'applied' : 'preview'}.json`), JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
