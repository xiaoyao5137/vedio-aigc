#!/usr/bin/env node
// Recover a failed one-image Codex request without adopting any unreviewed file.
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { SCENE_CUT_IMAGE_COUNT_RETRY_FEEDBACK } from '../src/scene-cut-image-count-retry.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const assert = (value, reason) => { if (!value) throw Error(`SCENE_CUT_IMAGE_COUNT_RECOVERY_INVALID: ${reason}`) }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const sourceRow = (await db.query(`SELECT *,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
  assert(sourceRow?.workflow_id === 'wf-sanguo-history-drama', 'source missing')
  const source = decodeExecutionState(sourceRow.result), before = source.nodeRuns, index = 45
  assert(source.id === sourceId && before[index]?.node.id === 'sanguo-scene-cut-first-frame'
    && before[index].status === 'failed'
    && before[index].error === 'CODEX_IMAGE_COUNT_INVALID: 本次线程必须恰好保存1张 PNG 图片'
    && before.slice(0, index).every(run => ['success', 'skipped'].includes(run.status))
    && before[index - 2].output?.version === 'scene-cut-opening-plan-v3',
  'source is not the expected first-image count failure')
  const ledger = (await db.query(`SELECT id,status,error,response_data FROM model_execution_records
    WHERE workflow_id=$1 AND node_id=$2 AND status='failed'
      AND request_data->>'requestKey' LIKE $3 AND error=$4
    ORDER BY created_at DESC LIMIT 1`, [sourceRow.workflow_id, before[index].node.id,
    `${sourceId}:%`, before[index].error])).rows[0]
  assert(ledger?.error === before[index].error && ledger.response_data?.raw?.imageCount === 2
    && /^01[a-z0-9-]+$/.test(ledger.response_data.raw.threadId ?? ''),
  'two-image provider evidence missing')
  const runs = manualRetryRuns(before, index)
  runs[index] = { ...runs[index], retryFeedback: SCENE_CUT_IMAGE_COUNT_RETRY_FEEDBACK }
  const id = `record-${randomBytes(5).toString('hex')}`
  const marker = { version: 'scene-cut-image-count-retry-v1', sourceExecutionId: sourceId,
    sourceResultMd5: sourceRow.result_md5, failedModelExecutionId: ledger.id,
    failedThreadId: ledger.response_data.raw.threadId,
    firstPendingIndex: index, firstPendingNodeId: before[index].node.id }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    sceneCutImageCountRecovery: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: runs[index - 1].context,
    selectedNodeId: runs[index].node.id, logs: [...source.logs,
      `从 ${sourceId} 的首帧数量错误恢复；保留原线程两张未审核文件作为失败证据，重新请求恰好一张。`] }
  if (apply) {
    await db.query(`INSERT INTO execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, sourceRow.workflow_id, sourceRow.workflow_name, `首帧数量错误恢复 · ${sourceId}`,
      JSON.stringify(sourceRow.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    const saved = decodeExecutionState((await db.query('SELECT result FROM execution_records WHERE id=$1',
      [id])).rows[0]?.result)
    assert(saved.id === id && saved.nodeRuns[index].status === 'idle'
      && saved.sceneCutImageCountRecovery.failedModelExecutionId === ledger.id,
    'fork did not round trip')
  }
  assert((await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
    [sourceId])).rows[0]?.md5 === sourceRow.result_md5, 'source changed')
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: sourceRow.result_md5,
    failedModelExecutionId: ledger.id, imageCount: 2, newRecordId: apply ? id : null,
    firstPendingIndex: index, preservedPrefix: index, providerCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
