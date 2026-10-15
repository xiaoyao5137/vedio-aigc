#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V186 } from '../src/scene-cut-advisory-review.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const row = (await db.query(`select *,md5(result::text) as result_md5 from execution_records
    where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  const workflow = (await db.query(`select *,md5(edges::text) as edges_md5
    from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(row?.workflow_id, workflow?.id)
  assert.equal(workflow.schema_version, 186)
  const source = decodeExecutionState(row.result), before = source.nodeRuns
  assert.equal(source.id, sourceId)
  assert.equal(before[45]?.status, 'success')
  assert.equal(before[48]?.status, 'success')
  assert.equal(before[49]?.status, 'success')
  assert.equal(before[50]?.status, 'failed')
  assert.match(before[50].error, /^SCENE_CUT_FRAME_REJECTED:/)
  assert.ok(before.slice(0, 49).every(run => ['success', 'skipped'].includes(run.status)))
  const runs = refreshPendingExecutionNodes({ ...workflow, schemaVersion: workflow.schema_version },
    manualRetryRuns(before, 49))
  assert.ok(before.slice(0, 49).every((run, index) => isDeepStrictEqual(run, runs[index])))
  assert.equal(runs[49].node.prompt, SCENE_CUT_FRAME_REVIEW_PROMPT_V186)
  assert.ok(runs.slice(49).every(run => run.status === 'idle'))
  assert.equal(prepareWorkflowRunContext(runs, 49)?.run.node.id, 'sanguo-scene-cut-review')
  const id = `record-${randomBytes(5).toString('hex')}`
  const state = { ...source, id, parentExecutionId: sourceId,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns: runs,
    sceneCutAdvisoryReviewRecovery: { version: 'scene-cut-advisory-review-v1', sourceExecutionId: sourceId,
      sourceResultMd5: row.result_md5, workflowSchemaVersion: 186, workflowEdgesMd5: workflow.edges_md5,
      firstPendingIndex: 49, originalImageUrl: before[45].output?.url },
    context: runs[48].context ?? {}, selectedNodeId: runs[49].node.id,
    logs: [...source.logs, `保留 ${sourceId} 的分镜、原首帧与采证；以用户验收口径重新审核首帧，未重新生成图片。`] }
  if (apply) {
    const saved = await db.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8) returning id`,
    [id, row.workflow_id, row.workflow_name, `首帧用户验收复审 · ${sourceId}`,
      JSON.stringify(row.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    assert.equal(saved.rowCount, 1)
  }
  assert.equal((await db.query('select md5(result::text) as hash from execution_records where id=$1',
    [sourceId])).rows[0].hash, row.result_md5)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, sourceId, reviewRecordId: apply ? id : null,
    firstPendingIndex: 49, preservedPrefix: 49, providerImageCalls: 0 }))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
