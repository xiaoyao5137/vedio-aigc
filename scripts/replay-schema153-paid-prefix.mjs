#!/usr/bin/env node
// Read-only replay of the saved scene-4 breakpoint against the current graph.
// No workflow step, provider, or execution record is written by this script.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { migrateBranchRuns } from '../src/branch-migration.ts'
import { firstBlockingRunIndex } from '../src/workflow-core.ts'

const workflowId = 'wf-sanguo-history-drama'
const executionId = 'record-610-scene4-review-retry-20260928-v1'
const outputPath = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop4-media/schema153-paid-prefix-postflight.json')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

await db.connect()
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const workflow = (await db.query('SELECT id,schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  const record = (await db.query('SELECT id,result,xmin::text AS row_version FROM execution_records WHERE id=$1', [executionId])).rows[0]
  assert.ok(workflow && record, 'Expected saved workflow and source execution record')
  assert.equal(workflow.schema_version, 153, 'Replay must use the current schema153 workflow')
  const source = decodeExecutionState(record.result)
  const runs = source.nodeRuns
  assert.ok(Array.isArray(runs) && runs.length > 0, 'Saved execution must have a decoded node queue')
  const graph = { id: workflow.id, schemaVersion: workflow.schema_version, nodes: workflow.nodes, edges: workflow.edges }
  const beforeById = new Map(runs.map(run => [run.id, run]))
  const provider = run => ['video', 'image', 'audio'].includes(run.node?.kind) || Boolean(run.node?.modelId)
  const paid = runs.filter(run => run.status === 'success' && provider(run))
  assert.equal(paid.length, 25, 'Expected 25 successful provider nodes in the saved source prefix')
  const sourceIndex = firstBlockingRunIndex(runs, runs.length - 1)
  const migrated = migrateBranchRuns(graph, runs)
  const replayIndex = firstBlockingRunIndex(migrated, migrated.length - 1)
  assert.equal(sourceIndex, 134)
  assert.equal(replayIndex, 134)
  assert.equal(migrated[replayIndex].node.id, 'sanguo-media-review')
  assert.equal(migrated[replayIndex].loopIndex, 3)
  const afterById = new Map(migrated.map(run => [run.id, run]))
  for (const original of runs) {
    if (!['success', 'skipped'].includes(original.status)) continue
    const after = afterById.get(original.id)
    assert.ok(after, `Completed run ${original.id} disappeared`)
    assert.equal(after.status, original.status, `Completed run ${original.id} changed status`)
    assert.deepEqual(after.output, original.output, `Completed run ${original.id} changed output`)
  }
  for (const original of paid) {
    const after = afterById.get(original.id)
    assert.ok(after && after.status === 'success', `Paid provider ${original.id} became pending`)
    assert.deepEqual(after.output, original.output, `Paid provider ${original.id} changed output`)
  }
  assert.equal(migrated.filter(run => run.status === 'success' && provider(run)).length, paid.length)
  assert.equal(migrateBranchRuns(graph, migrated), migrated, 'Schema153 topology replay must be idempotent')
  assert.equal(beforeById.size, runs.length, 'Source run ids must be unique')
  const proof = { format: 'schema153-paid-prefix-postflight-v1', capturedAt: new Date().toISOString(),
    databaseReadOnly: true, providerCalls: 0,
    workflow: { id: workflow.id, schemaVersion: workflow.schema_version, rowVersion: workflow.row_version,
      nodeCount: workflow.nodes.length, edgesSha256: hash(workflow.edges) },
    source: { id: record.id, rowVersion: record.row_version, runCount: runs.length,
      firstPending: { index: sourceIndex, nodeId: runs[sourceIndex]?.node.id, loopIndex: runs[sourceIndex]?.loopIndex } },
    replay: { runCount: migrated.length,
      firstPending: { index: replayIndex, nodeId: migrated[replayIndex]?.node.id, loopIndex: migrated[replayIndex]?.loopIndex },
      newlyInsertedRunCount: migrated.length - runs.length, completedProviderRunCount: paid.length,
      completedProviderRunsPreserved: true, completedPrefixPreserved: true, idempotent: true } }
  await db.query('ROLLBACK')
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify({ ...proof, outputPath }, null, 2))
} catch (error) {
  await db.query('ROLLBACK')
  throw error
} finally { await db.end() }
