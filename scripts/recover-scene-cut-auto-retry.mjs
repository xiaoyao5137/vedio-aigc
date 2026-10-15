// Preserve a failed scene-cut execution and prepare its first bounded image retry.
// Dry run by default: node scripts/recover-scene-cut-auto-retry.mjs record-ID
// Persist: node scripts/recover-scene-cut-auto-retry.mjs record-ID --apply
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { planSceneCutAutoRetry } from '../src/scene-cut-auto-retry.ts'

const sourceId = process.argv[2]
const apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await db.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records
    WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
  if (!row || row.workflow_id !== 'wf-sanguo-history-drama') throw Error('Sanguo execution not found')
  const source = decodeExecutionState(row.result)
  const failedIndex = source.nodeRuns.findIndex(run => run.status === 'failed'
    && run.node.id === 'sanguo-scene-cut-approval')
  const failed = source.nodeRuns[failedIndex]
  if (failedIndex < 0 || !/^SCENE_CUT_FRAME_REJECTED:/.test(failed.error ?? ''))
    throw Error('No scene-cut frame rejection in this record')
  const prior = source.sceneCutAutoRetry
  const plan = planSceneCutAutoRetry(source.nodeRuns, failedIndex,
    prior?.loopGroupId === failed.loopGroupId && prior?.loopIndex === failed.loopIndex
      ? prior.count : 0)
  if (!plan) throw Error('No safe, bounded first-frame retry candidate')
  const id = `record-${randomBytes(5).toString('hex')}`
  const nodeRuns = manualRetryRuns(source.nodeRuns, plan.imageIndex)
  nodeRuns[plan.imageIndex] = { ...nodeRuns[plan.imageIndex], retryFeedback: plan.feedback }
  const fork = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    sceneCutImageCountRecovery: undefined,
    sceneCutAutoRetry: { sourceExecutionId: prior?.sourceExecutionId ?? source.id,
      count: plan.count, sourceReviewRunId: plan.reviewRunId,
      loopGroupId: failed.loopGroupId, loopIndex: failed.loopIndex },
    historical: false, mode: 'step', nodeRuns,
    context: nodeRuns[plan.imageIndex - 1]?.context ?? {},
    selectedNodeId: nodeRuns[plan.imageIndex].node.id,
    logs: [...source.logs, `首帧实图审核明确拒绝；创建第 ${plan.count} 次有界重试 ${id}，从换场准确首帧重新生成；原记录 ${source.id} 保留。`] }
  if (apply) {
    const encoded = encodeExecutionState(fork)
    await db.query(`INSERT INTO execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, row.workflow_id, row.workflow_name, `换场首帧自动重试 · ${source.id}`,
      JSON.stringify(row.runtime_inputs ?? {}), JSON.stringify(encoded),
      nodeRuns.filter(run => run.status === 'success').length, nodeRuns.length])
    const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [id])).rows[0]
    const restored = decodeExecutionState(saved?.result)
    if (restored.id !== id || restored.nodeRuns[plan.imageIndex]?.status !== 'idle'
      || restored.nodeRuns[plan.imageIndex]?.retryFeedback !== plan.feedback)
      throw Error('Persisted retry fork did not round-trip')
  }
  const sourceHashAfter = (await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1',
    [sourceId])).rows[0]?.hash
  if (sourceHashAfter !== row.result_md5) throw Error('Source execution changed')
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: row.result_md5,
    newRecordId: apply ? id : null, firstPendingIndex: plan.imageIndex,
    firstPendingNodeId: nodeRuns[plan.imageIndex].node.id, retryCount: plan.count,
    preservedPrefix: plan.imageIndex, invalidatedSuffix: nodeRuns.length - plan.imageIndex,
    reviewRunId: plan.reviewRunId, feedback: plan.feedback, providerCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  await db.end()
}
