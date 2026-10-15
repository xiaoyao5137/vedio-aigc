#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const row = (await db.query(`select *,md5(result::text) as result_md5 from execution_records
    where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  const workflow = (await db.query(`select * from workflow_configs
    where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(row?.workflow_id, workflow?.id)
  assert.equal(workflow.schema_version, 186)
  const source = decodeExecutionState(row.result), before = source.nodeRuns
  assert.equal(source.id, sourceId)
  assert.equal(before[45]?.status, 'success')
  assert.equal(before[48]?.status, 'success')
  assert.equal(before[49]?.status, 'success')
  assert.equal(before[50]?.status, 'failed')
  assert.match(before[50].error, /^SCENE_CUT_FRAME_BLOCKED:/)
  const runs = refreshPendingExecutionNodes({ ...workflow, schemaVersion: workflow.schema_version },
    manualRetryRuns(before, 50))
  assert.ok(before.slice(0, 50).every((run, index) => isDeepStrictEqual(run, runs[index])))
  assert.equal(runs[50].status, 'idle')
  assert.equal(prepareWorkflowRunContext(runs, 50)?.run.node.id, 'sanguo-scene-cut-approval')
  const id = `record-${randomBytes(5).toString('hex')}`
  const state = { ...source, id, parentExecutionId: sourceId,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns: runs,
    context: runs[49].context ?? {}, selectedNodeId: runs[50].node.id,
    logs: [...source.logs, `保留 ${sourceId} 的已付费首帧和通过复审的结论；重试账本审批。`] }
  if (apply) {
    const saved = await db.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8) returning id`,
    [id, row.workflow_id, row.workflow_name, `首帧审批重试 · ${sourceId}`,
      JSON.stringify(row.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    assert.equal(saved.rowCount, 1)
  }
  assert.equal((await db.query('select md5(result::text) as hash from execution_records where id=$1',
    [sourceId])).rows[0].hash, row.result_md5)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, sourceId, approvalRecordId: apply ? id : null,
    firstPendingIndex: 50, preservedPrefix: 50, providerImageCalls: 0 }))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
