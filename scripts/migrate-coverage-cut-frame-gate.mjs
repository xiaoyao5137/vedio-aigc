#!/usr/bin/env node
// Preview by default. --apply requires the exact previewed before-hash and
// changes only the saved Sanguo workflow graph, never execution history.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { upgradeCoverageCutFrameWorkflow } from '../src/coverage-cut-frame-gate.ts'
import { branchConfigurationErrors, executionRouteEdges, orderRouteNodes } from '../src/workflow-branch.ts'
import { scopedLoopNodes } from '../src/workflow-core.ts'

const workflowId = 'wf-sanguo-history-drama'
const apply = process.argv.includes('--apply')
const option = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? '' : process.argv[index + 1] ?? ''
}
const directory = path.resolve(option('--out') || 'logs/dramatic-expression/live-20260928/coverage-cut-frame-gate-migration')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value
const canonicalHash = value => hash(canonical(value))
const beforeHash = row => hash([row.schema_version, row.nodes, row.edges, row.updated_at, row.row_revision])
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
// PostgreSQL MVCC changes xmin/ctid for any row rewrite. Include the stored
// byte count, then compare every record before/after without de-TOASTing the
// 3.5 GB execution archive twice merely to prove this migration did not write it.
const history = async () => (await client.query(`select id,xmin::text as revision,ctid::text as location,
  pg_column_size(result) as stored_bytes from execution_records where workflow_id=$1 order by id`, [workflowId])).rows
await client.connect()
let committed = false
try {
  await client.query(apply ? 'begin isolation level repeatable read' : 'begin isolation level repeatable read read only')
  const current = (await client.query(`select id,name,description,nodes,edges,schema_version,updated_at,
    xmin::text as row_revision
    from workflow_configs where id=$1${apply ? ' for update' : ''}`, [workflowId])).rows[0]
  assert.ok(current, 'Sanguo workflow row missing')
  assert.ok([155, 156].includes(current.schema_version), `Expected schema 155/156; received ${current.schema_version}`)
  const before = beforeHash(current)
  const executionBefore = await history()
  const projected = upgradeCoverageCutFrameWorkflow({ ...current, schemaVersion: current.schema_version })
  assert.equal(projected.schemaVersion, 156)
  assert.equal(upgradeCoverageCutFrameWorkflow(projected), projected, 'Upgrade must be idempotent')
  const addedIds = ['sanguo-coverage-precheck', 'sanguo-coverage-source-archive', 'sanguo-coverage-first-frame',
    'sanguo-coverage-evidence-plan', 'sanguo-coverage-evidence', 'sanguo-coverage-review',
    'sanguo-coverage-approval', 'sanguo-video-reference-router']
  for (const id of addedIds) assert.equal(projected.nodes.filter(node => node.id === id).length, 1, `Missing/duplicate ${id}`)
  const oldIds = new Set(current.nodes.map(node => node.id))
  const changes = current.nodes.filter(node => JSON.stringify(node) !== JSON.stringify(projected.nodes.find(next => next.id === node.id)))
    .map(node => node.id)
  assert.deepEqual(new Set(changes), new Set(current.schema_version === 155
    ? ['sanguo-scene-loop', 'sanguo-first-frame-branch', 'sanguo-video'] : []), 'Unexpected managed existing nodes changed')
  assert.equal(projected.nodes.length, current.nodes.length + (current.schema_version === 155 ? addedIds.length : 0))
  assert.deepEqual(projected.nodes.filter(node => !oldIds.has(node.id)).map(node => node.id),
    current.schema_version === 155 ? addedIds : [])
  assert.deepEqual(branchConfigurationErrors(projected), [])
  const ordered = orderRouteNodes(projected)
  assert.equal(ordered.hasCycle, false)
  const graph = { ...projected, edges: executionRouteEdges(projected) }
  const loopOrder = scopedLoopNodes(graph, 'sanguo-scene-loop', ordered.ordered).map(node => node.id)
  for (const [index, id] of [...addedIds, 'sanguo-video'].entries()) {
    if (index) assert.ok(loopOrder.indexOf(addedIds[index - 1]) < loopOrder.indexOf(id), `Paid route out of order: ${id}`)
  }
  assert.equal(graph.edges.some(edge => edge.from === 'sanguo-first-frame-branch' && edge.to === 'sanguo-video'), false)
  assert.equal(graph.edges.some(edge => edge.from === 'sanguo-video-reference-router' && edge.to === 'sanguo-video'), true)
  const changed = current.schema_version === 155
  let backupPath
  if (apply && changed) {
    assert.equal(option('--expected-before-sha256'), before,
      `CAS requires preview hash ${before}; saved row may have changed`)
    await mkdir(directory, { recursive: true })
    backupPath = path.join(directory, `before-schema155-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(current, null, 2), { flag: 'wx', mode: 0o600 })
    const updated = await client.query(`update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,
      schema_version=$4,updated_at=now() where id=$1 and schema_version=$5 and nodes=$6::jsonb
      and edges=$7::jsonb and xmin::text=$8 returning id`, [workflowId, JSON.stringify(projected.nodes),
      JSON.stringify(projected.edges), projected.schemaVersion, current.schema_version,
      JSON.stringify(current.nodes), JSON.stringify(current.edges), current.row_revision])
    assert.equal(updated.rowCount, 1, 'Workflow CAS lost to another editor')
  }
  const saved = (await client.query('select nodes,edges,schema_version from workflow_configs where id=$1', [workflowId])).rows[0]
  assert.equal(saved.schema_version, apply ? projected.schemaVersion : current.schema_version)
  assert.equal(canonicalHash(saved.nodes), canonicalHash(apply ? projected.nodes : current.nodes))
  assert.equal(canonicalHash(saved.edges), canonicalHash(apply ? projected.edges : current.edges))
  const executionAfter = await history()
  assert.deepEqual(executionAfter, executionBefore, 'Existing execution row bytes or versions changed')
  if (apply) { await client.query('commit'); committed = true }
  else await client.query('rollback')
  const report = { format: 'coverage-cut-frame-gate-migration-v1', at: new Date().toISOString(),
    applied: apply, changed, workflowId, beforeSha256: before,
    schemaBefore: current.schema_version, projectedSchema: projected.schemaVersion,
    persistedSchema: saved.schema_version, nodeCountBefore: current.nodes.length,
    nodeCountProjected: projected.nodes.length, edgeCountBefore: current.edges.length,
    edgeCountProjected: projected.edges.length, changedExistingNodes: changes, addedIds,
    videoInboundEdges: graph.edges.filter(edge => edge.to === 'sanguo-video').map(edge => edge.from),
    oldDirectPaidEdgeRemoved: true, executionRowCount: executionBefore.length,
    executionVersionRowsSha256: hash(executionBefore), executionWrites: 0, providerCalls: 0,
    idempotent: true, backupPath }
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `migration-${apply ? 'applied' : 'preview'}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  if (!committed) await client.query('rollback').catch(() => {})
  throw error
} finally {
  await client.end()
}
