#!/usr/bin/env node
// Prepare a traceable, surgical execution fork at a reached node. Dry-run by default.
// This uses the same pure rollback contract as the UI and never mutates the source.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { forkBreakpointRollback } from '../src/breakpoint-rollback.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = message => { throw Error(`BREAKPOINT_FORK_INVALID: ${message}`) }
const args = process.argv.slice(2)
const options = { apply: false }
for (let i = 0; i < args.length; i++) {
  const flag = args[i]
  if (flag === '--apply') { options.apply = true; continue }
  const key = { '--source': 'sourceId', '--node': 'nodeId', '--loop': 'loop', '--id': 'id', '--proof': 'proofPath', '--expected-source-md5': 'md5' }[flag]
  if (!key || !args[i + 1] || args[i + 1].startsWith('--') || options[key] !== undefined) fail(`invalid argument ${flag}`)
  options[key] = args[++i]
}
if (!options.sourceId || !options.nodeId || !/^record-[\w-]+$/.test(options.sourceId)) fail('--source record-ID and --node node-ID are required')
if (options.loop !== undefined && (!/^\d+$/.test(options.loop) || Number(options.loop) < 1)) fail('--loop must be a one-based positive integer')
if (options.md5 !== undefined && !/^[a-f\d]{32}$/i.test(options.md5)) fail('--expected-source-md5 must be 32 hex digits')

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = createJsonHasher()
await db.connect()
try {
  await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const source = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
  if (!source) fail('source record missing')
  if (options.md5 && options.md5.toLowerCase() !== source.result_md5) fail('source MD5 changed')
  const workflow = (await db.query('SELECT * FROM workflow_configs WHERE id=$1', [source.workflow_id])).rows[0]
  if (!workflow || !Array.isArray(workflow.nodes)) fail('current workflow missing')
  const state = decodeExecutionState(source.result)
  if (state.id !== source.id || state.workflowId !== source.workflow_id || !Array.isArray(state.nodeRuns)) fail('source state identity invalid')
  if (state.nodeRuns.some(run => run.status === 'running')) fail('source still running')
  const matches = state.nodeRuns.filter(run => run.node?.id === options.nodeId && run.status === 'success'
    && (options.loop === undefined || run.loopIndex === Number(options.loop) - 1))
  if (matches.length !== 1) fail(`target must identify exactly one successful node instance; found ${matches.length}`)
  const id = options.id ?? `record-breakpoint-repair-${randomUUID()}`
  const { state: fork, plan } = forkBreakpointRollback(state, {
    id, createdAt: new Date().toISOString(), targetRunId: matches[0].id,
    breakpoints: [{ nodeId: options.nodeId, enabled: true }],
  })
  const refreshed = { ...fork, nodeRuns: refreshPendingExecutionNodes(
    { id: workflow.id, nodes: workflow.nodes, edges: workflow.edges }, fork.nodeRuns,
  ) }
  if (hash(refreshed.nodeRuns.slice(0, plan.targetIndex)) !== hash(state.nodeRuns.slice(0, plan.targetIndex))) fail('completed prefix changed')
  const target = refreshed.nodeRuns[plan.targetIndex]
  if (target.node.id !== options.nodeId || target.status !== 'idle') fail('target is not idle after rollback')
  const originalOutputHashes = state.nodeRuns.slice(0, plan.targetIndex).map(run => hash(run.output ?? null))
  const nextOutputHashes = refreshed.nodeRuns.slice(0, plan.targetIndex).map(run => hash(run.output ?? null))
  if (hash(originalOutputHashes) !== hash(nextOutputHashes)) fail('paid prefix output changed')
  const roundTrip = decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(refreshed))))
  if (hash(roundTrip) !== hash(refreshed)) fail('storage encoding changed fork')
  const sourceAfter = (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.md5
  if (sourceAfter !== source.result_md5) fail('source changed during fork')
  const proof = { format: 'breakpoint-repair-fork-v1', applied: options.apply,
    sourceRecordId: source.id, sourceResultMd5: source.result_md5, sourceResultMd5After: sourceAfter,
    newRecordId: id, targetIndex: plan.targetIndex, targetRunId: target.id, targetNodeId: target.node.id,
    loopIndex: target.loopIndex, preservedRunCount: plan.preservedRunCount,
    invalidatedRunCount: plan.invalidatedRunIds.length, completedInvalidatedCount: plan.completedInvalidatedCount,
    completedPrefixHash: hash(state.nodeRuns.slice(0, plan.targetIndex)),
    originalOutputHashes, requestScopeId: refreshed.requestScopeId,
    generationScopeId: refreshed.generationScopeId, schemaVersion: workflow.schema_version,
    roundTripVerified: true, sourceUnchanged: true }
  if (options.apply) {
    await db.query(`INSERT INTO execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`, [
      id, source.workflow_id, source.workflow_name, 'step', `断点回退修复 · ${source.id}`,
      JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(refreshed)),
      refreshed.nodeRuns.filter(run => run.status === 'success').length,
      0, refreshed.nodeRuns.length,
    ])
    const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [id])).rows[0]
    if (!saved || hash(decodeExecutionState(saved.result)) !== hash(refreshed)) fail('saved fork differs from prepared state')
  }
  await db.query('COMMIT')
  if (options.proofPath) await writeFile(options.proofPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ ...proof, originalOutputHashCount: proof.originalOutputHashes.length,
    ...(options.proofPath ? { proofPath: options.proofPath } : {}), originalOutputHashes: undefined }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
