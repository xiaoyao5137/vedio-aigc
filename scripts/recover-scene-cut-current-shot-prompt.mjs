#!/usr/bin/env node
// Re-enter only the rejected image node after removing the stale, foreign-shot
// image instructions. Every approved script and paid prefix run is retained.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT } from '../src/scene-cut-first-frame-gate.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide rejected source record ID')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const sourceRow = (await db.query(`select *,md5(result::text) as result_md5 from execution_records
    where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  const workflow = (await db.query(`select *,md5(edges::text) as edges_md5 from workflow_configs
    where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(sourceRow?.workflow_id, workflow?.id)
  assert.equal(workflow.schema_version, 185)
  const source = decodeExecutionState(sourceRow.result), before = source.nodeRuns
  assert.equal(source.id, sourceId)
  assert.equal(before[11]?.status, 'success')
  assert.equal(before[11]?.output?.passed, true)
  assert.equal(before[43]?.status, 'success')
  assert.equal(before[45]?.status, 'success')
  assert.equal(before[49]?.output?.passed, false)
  assert.equal(before[50]?.status, 'failed')
  assert.match(before[50].error, /^SCENE_CUT_FRAME_REJECTED:/)
  assert.equal(source.sceneCutAutoRetry?.count, 2)
  assert.match(before[45].node.prompt, /^【真人换场首帧：已批准分镜的零秒状态】/)
  assert.doesNotMatch(before[45].node.prompt, /【全景动作区清晰度】/)
  assert.ok(before.slice(0, 45).every(run => ['success', 'skipped'].includes(run.status)))
  const configured = workflow.nodes.find(node => node.id === before[45].node.id)
  assert.equal(configured?.prompt, SCENE_CUT_FIRST_FRAME_PROMPT)
  const runs = refreshPendingExecutionNodes({ ...workflow, schemaVersion: workflow.schema_version },
    manualRetryRuns(before, 45))
  assert.ok(before.slice(0, 45).every((run, index) => isDeepStrictEqual(run, runs[index])))
  assert.equal(runs[45].node.prompt, SCENE_CUT_FIRST_FRAME_PROMPT)
  assert.ok(runs.slice(45).every(run => run.status === 'idle'))
  const prepared = prepareWorkflowRunContext(runs, 45)
  assert.equal(prepared?.run.node.id, 'sanguo-scene-cut-first-frame')
  assert.ok(isDeepStrictEqual(prepared.inputContext.shot_script, before[11].output))
  const id = `record-${randomBytes(5).toString('hex')}`
  const marker = { version: 'scene-cut-current-shot-prompt-recovery-v2', parentExecutionId: sourceId,
    parentResultMd5: sourceRow.result_md5, workflowSchemaVersion: 185,
    workflowEdgesMd5: workflow.edges_md5, firstPendingIndex: 45,
    originalImageUrl: before[45].output?.url }
  const state = { ...source, id, parentExecutionId: sourceId,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    sceneCutCurrentShotPromptRecovery: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: before[44].context ?? {}, selectedNodeId: runs[45].node.id,
    logs: [...source.logs, `保留 ${sourceId} 的已批准分镜与付费前缀；移除旧镜头专用首帧提示，等待当前分镜首帧独立生成和审核。`] }
  if (apply) {
    const saved = await db.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8) returning id`,
      [id, sourceRow.workflow_id, sourceRow.workflow_name, `当前分镜首帧提示修复 · ${sourceId}`,
        JSON.stringify(sourceRow.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
        runs.filter(run => run.status === 'success').length, runs.length])
    assert.equal(saved.rowCount, 1)
    const reloaded = decodeExecutionState((await db.query('select result from execution_records where id=$1', [id])).rows[0].result)
    assert.equal(reloaded.nodeRuns[45].node.prompt, SCENE_CUT_FIRST_FRAME_PROMPT)
    assert.equal(reloaded.nodeRuns[45].status, 'idle')
  }
  assert.equal((await db.query('select md5(result::text) as hash from execution_records where id=$1',
    [sourceId])).rows[0].hash, sourceRow.result_md5)
  await db.query(apply ? 'COMMIT' : 'ROLLBACK')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceResultMd5: sourceRow.result_md5,
    newRecordId: apply ? id : null, firstPendingIndex: 45, preservedPrefix: 45,
    oldPromptLength: before[45].node.prompt.length, newPromptLength: SCENE_CUT_FIRST_FRAME_PROMPT.length,
    providerCalls: 0 }))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
