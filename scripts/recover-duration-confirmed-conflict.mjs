#!/usr/bin/env node
// Replay the corrected media gate on the same paid video and review evidence.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const assert = (value, reason) => { if (!value) throw Error(`DURATION_CONFLICT_RECOVERY_INVALID: ${reason}`) }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await db.query(`select *,md5(result::text) as result_md5 from execution_records where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  assert(row?.workflow_id === 'wf-sanguo-history-drama', 'source not found')
  const source = decodeExecutionState(row.result), before = source.nodeRuns, index = 59
  assert(source.id === sourceId && before[index]?.node.id === 'sanguo-media-accept'
    && before[index].output?.passed === true
    && before[index].output?.durationCompletion?.assessment === 'uncertain'
    && before[index].output?.qualityReview?.principleIssues?.some(issue => issue.code === 'core_event_contradiction' && issue.evidence?.source === 'frame')
    && before[65]?.node.id === 'sanguo-shot-script' && before[65].status === 'failed'
    && before.slice(0, index).every(run => ['success', 'skipped'].includes(run.status)),
  'source is not the confirmed duration conflict')
  const workflow = (await db.query('select * from workflow_configs where id=$1', [row.workflow_id])).rows[0]
  assert(workflow?.schema_version === 182, 'corrected schema182 workflow missing')
  const runs = refreshPendingExecutionNodes({ ...workflow, schemaVersion: workflow.schema_version }, manualRetryRuns(before, index))
  const prepared = prepareWorkflowRunContext(runs, index)
  assert(runs[index].status === 'idle' && runs[index].node.code.includes('passed:false,manualDecisionRequired:false,durationCompletion:replanned')
    && isDeepStrictEqual(prepared?.inputContext?.media_review, before[58].output)
    && isDeepStrictEqual(prepared?.inputContext?.video_evidence, before[54].output)
    && runs.slice(0, index).every((run, i) => isDeepStrictEqual(run, before[i]))
    && runs.slice(index).every(run => run.status === 'idle'), 'same-media replay boundary differs')
  const id = `record-${randomBytes(5).toString('hex')}`
  const marker = { version: 'duration-confirmed-conflict-replay-v1', sourceExecutionId: sourceId,
    sourceResultMd5: row.result_md5, firstPendingIndex: index, firstPendingNodeId: runs[index].node.id,
    sourceVideoUrl: before[54].output?.url }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    durationConfirmedConflictRecovery: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: runs[index - 1].context, selectedNodeId: runs[index].node.id,
    logs: [...source.logs, `从 ${sourceId} 对同一成片和审核证据重放修正后的媒体验收；保留之前 ${index} 个节点结果。`] }
  if (apply) {
    await db.query(`insert into execution_records (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [id, row.workflow_id, row.workflow_name,
      `媒体验收路由修复 · ${sourceId}`, JSON.stringify(row.runtime_inputs ?? {}),
      JSON.stringify(encodeExecutionState(state)), index, runs.length])
    const saved = decodeExecutionState((await db.query('select result from execution_records where id=$1', [id])).rows[0]?.result)
    assert(saved.id === id && saved.nodeRuns[index].status === 'idle' && saved.durationConfirmedConflictRecovery.sourceResultMd5 === row.result_md5,
      'fork did not round trip')
  }
  assert((await db.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]?.md5 === row.result_md5,
    'source changed')
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: row.result_md5,
    newRecordId: apply ? id : null, firstPendingIndex: index, preservedPrefix: index,
    sourceVideoUrl: marker.sourceVideoUrl, providerCalls: 0 }, null, 2))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
