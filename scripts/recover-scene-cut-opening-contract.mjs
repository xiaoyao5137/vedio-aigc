// Recompute a saved opening plan after the visual reaction/static setup repair.
// Dry run: node scripts/recover-scene-cut-opening-contract.mjs record-ID
// Persist: node scripts/recover-scene-cut-opening-contract.mjs record-ID --apply
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'

const sourceId = process.argv[2], apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('Provide a source record ID')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const sourceRow = (await db.query(`SELECT *,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
  if (sourceRow?.workflow_id !== 'wf-sanguo-history-drama') throw Error('Sanguo source not found')
  const source = decodeExecutionState(sourceRow.result)
  const index = source.nodeRuns.findIndex(run => run.node.id === 'sanguo-scene-cut-opening-plan'
    && run.loopIndex === 0 && run.status === 'success')
  const planRun = source.nodeRuns[index], failed = source.nodeRuns.find(run => run.node.id === 'sanguo-scene-cut-approval'
    && run.loopGroupId === planRun?.loopGroupId && run.loopIndex === planRun.loopIndex)
  if (index < 1 || failed?.status !== 'failed' || source.sceneCutAutoRetry?.count !== 2
    || source.nodeRuns.slice(0, index).some(run => !['success', 'skipped'].includes(run.status)))
    throw Error('Opening repair requires the bounded failed scene-cut prefix')
  const priorPlan = planRun.output, nextPlan = deriveSceneCutOpeningPlan(planRun.inputs?.shot, 3)
  const oldIds = priorPlan?.requiredVisualActions?.map(item => item.beatId)
  const newIds = nextPlan.requiredVisualActions.map(item => item.beatId)
  if (nextPlan.shotSha256 !== priorPlan?.shotSha256
    || JSON.stringify(oldIds) !== JSON.stringify(['action-knot', 'action-approach'])
    || JSON.stringify(newIds) !== JSON.stringify(['action-knot', 'action-straighten', 'action-approach'])
    || !String(priorPlan.openingVisualContext?.staticScene).includes('双腕已缚于身前')
    || !nextPlan.openingVisualContext.staticScene.includes('双腕并置于身前'))
    throw Error('Source does not match the reviewed opening contract defect')
  const id = `record-${randomBytes(5).toString('hex')}`
  const runs = manualRetryRuns(source.nodeRuns, index)
  const marker = { version: 'scene-cut-opening-contract-repair-v1', sourceExecutionId: source.id,
    sourceResultMd5: sourceRow.result_md5, firstPendingIndex: index,
    firstPendingNodeId: planRun.node.id, shotSha256: nextPlan.shotSha256 }
  const state = { ...source, id, parentExecutionId: source.id,
    requestScopeId: source.requestScopeId ?? source.id, generationScopeId: id,
    sceneCutOpeningContractRepair: marker, historical: false, mode: 'step',
    nodeRuns: runs, context: runs[index - 1].context, selectedNodeId: runs[index].node.id,
    logs: [...source.logs, `从 ${source.id} 修复零秒起点计划契约；原分镜、人物资产与所有旧候选保留，节点 ${index} 起重新执行。`] }
  if (apply) {
    await db.query(`INSERT INTO execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      id, sourceRow.workflow_id, sourceRow.workflow_name, `换场零秒计划契约修复 · ${source.id}`,
      JSON.stringify(sourceRow.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
      runs.filter(run => run.status === 'success').length, runs.length])
    const saved = decodeExecutionState((await db.query('SELECT result FROM execution_records WHERE id=$1', [id])).rows[0]?.result)
    if (saved.id !== id || saved.nodeRuns[index].status !== 'idle'
      || saved.sceneCutOpeningContractRepair.sourceResultMd5 !== sourceRow.result_md5)
      throw Error('Opening contract fork did not round-trip')
  }
  if ((await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1',
    [sourceId])).rows[0]?.hash !== sourceRow.result_md5) throw Error('Source changed')
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, sourceId, sourceMd5: sourceRow.result_md5,
    newRecordId: apply ? id : null, firstPendingIndex: index,
    oldRequiredVisualBeats: oldIds, newRequiredVisualBeats: newIds,
    shotSha256: nextPlan.shotSha256, preservedPrefix: index,
    invalidatedSuffix: runs.length - index, providerCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
