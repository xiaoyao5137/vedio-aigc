#!/usr/bin/env node
// User-authorized, source-bound one-time duration repair budget for this take.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const assert = (value, reason) => { if (!value) throw Error(`DURATION_REPLAN_BUDGET_RECOVERY_INVALID: ${reason}`) }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await db.query(`select *,md5(result::text) as result_md5 from execution_records where id=$1${apply ? ' for share' : ''}`, [sourceId])).rows[0]
  assert(row?.workflow_id === 'wf-sanguo-history-drama', 'source not found')
  const source = decodeExecutionState(row.result), before = source.nodeRuns, index = 60
  assert(before[index]?.node.id === 'sanguo-duration-replan' && before[index].status === 'failed'
    && before[index].error?.includes('DURATION_REPLAN_LIMIT')
    && before[index - 1].output?.durationCompletion?.route === 'replan'
    && before[index - 1].output?.passed === false
    && before[index - 1].output?.manualDecisionRequired === false
    && before.slice(0, index).every(run => ['success', 'skipped'].includes(run.status)),
  'source is not a confirmed incomplete take at the manual replan limit')
  const param = before[index].node.params.find(param => (param.englishName ?? param.name) === 'maxAttempts')
  assert(param?.value === '1' && before[index].node.params.find(param => param.name === 'retryBudgetProfile')?.value === 'manual-review-v1',
    'source retry policy differs')
  const runs = manualRetryRuns(before, index)
  runs[index] = { ...runs[index], node: { ...runs[index].node,
    params: runs[index].node.params.map(item => item === param || item.id === param.id ? { ...item, value: '2' } : item) } }
  assert(runs[index].status === 'idle' && runs[index].node.params.find(item => item.id === param.id)?.value === '2'
    && runs.slice(0, index).every((run, i) => isDeepStrictEqual(run, before[i]))
    && runs.slice(index).every(run => run.status === 'idle'), 'retry boundary differs')
  const id = `record-${randomBytes(5).toString('hex')}`
  const marker = { version: 'duration-replan-budget-v1', sourceExecutionId: sourceId,
    sourceResultMd5: row.result_md5, firstPendingIndex: index, firstPendingNodeId: runs[index].node.id,
    maxAttemptsBefore: 1, maxAttemptsAfter: 2 }
  const state = { ...source, id, parentExecutionId: source.id, requestScopeId: source.requestScopeId ?? source.id,
    generationScopeId: id, durationReplanBudgetRecovery: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: runs[index - 1].context, selectedNodeId: runs[index].node.id,
    logs: [...source.logs, `从 ${sourceId} 有界重排：仅当前第 ${index} 节点 maxAttempts 从 1 改为 2；原视频和审核保留。`] }
  if (apply) {
    await db.query(`insert into execution_records (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      values ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [id,row.workflow_id,row.workflow_name,
      `有界时长重排 · ${sourceId}`,JSON.stringify(row.runtime_inputs ?? {}),JSON.stringify(encodeExecutionState(state)),index,runs.length])
    const saved = decodeExecutionState((await db.query('select result from execution_records where id=$1', [id])).rows[0]?.result)
    assert(saved.id === id && saved.nodeRuns[index].status === 'idle' && saved.nodeRuns[index].node.params.find(item => item.id === param.id)?.value === '2',
      'fork did not round trip')
  }
  assert((await db.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]?.md5 === row.result_md5,
    'source changed')
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: row.result_md5, newRecordId: apply ? id : null,
    firstPendingIndex: index, preservedPrefix: index, maxAttempts: 2, providerCalls: 0 }, null, 2))
} catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error
} finally { await db.end() }
