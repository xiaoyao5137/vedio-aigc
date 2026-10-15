import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'

const sourceId = process.argv[2]
const apply = process.argv.includes('--apply')
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('请提供明确的来源执行记录 ID')
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
try {
  await client.query('begin')
  const source = (await client.query('select * from execution_records where id=$1 for share', [sourceId])).rows[0]
  const workflow = (await client.query('select id,nodes,schema_version from workflow_configs where id=$1 for share',
    ['wf-workplace-second-trial-v1'])).rows[0]
  if (!source || source.workflow_id !== workflow?.id || workflow.schema_version !== 6) throw Error('来源或工作流版本不符合预期')
  const state = decodeExecutionState(source.result)
  const image = workflow.nodes.find(node => node.id === 'node-image')
  if (image?.modelId !== 'codex-gpt-image-2' || image.params.find(param => param.englishName === 'size')?.value !== '576x1024'
    || state.nodeRuns[6]?.node.id !== 'node-image' || state.nodeRuns[6].loopIndex !== 0
    || state.nodeRuns[6].status !== 'success' || state.nodeRuns[7]?.status !== 'success'
    || state.nodeRuns[8]?.status !== 'failed'
    || !String(state.nodeRuns[8].error).includes('实际画幅 784×1176 与 9:16 不符')
    || state.nodeRuns.slice(0, 6).some(run => run.status !== 'success')
    || state.nodeRuns.slice(9).some(run => run.status !== 'idle')) throw Error('首帧恢复边界不符合预期')
  const id = `record-working-cat-image-${randomUUID().slice(0, 8)}`
  const prefix = JSON.stringify(state.nodeRuns.slice(0, 6))
  const runs = state.nodeRuns.map((run, index) => index < 6 ? run : {
    ...invalidateRunExecution(run),
    node: workflow.nodes.find(node => node.id === run.node.id) ?? run.node,
    revision: (run.revision ?? 0) + 1,
  })
  const fork = { ...state, id, parentExecutionId: sourceId, requestScopeId: id, generationScopeId: id,
    mode: 'step', nodeRuns: runs, context: state.nodeRuns[5].context,
    selectedNodeId: image.id,
    logs: [...(state.logs ?? []), `从 ${sourceId} 保留六镜剧本与质检，首帧改成 9:16 后重拍；原视频及失败质检留在来源记录。`] }
  if (JSON.stringify(runs.slice(0, 6)) !== prefix) throw Error('已成功的剧本前缀发生变化')
  const encoded = encodeExecutionState(fork)
  const decoded = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (JSON.stringify(decoded.nodeRuns.slice(0, 6)) !== prefix || decoded.nodeRuns[6].status !== 'idle') throw Error('执行状态存储校验失败')
  const proof = { sourceId, forkId: id, preservedRuns: 6, firstPendingIndex: 6,
    shots: state.nodeRuns[2].output?.shots?.length, loopCount: state.nodeRuns[5].output?.count,
    imageModel: image.modelId, newModelCalls: 0 }
  if (apply) {
    await client.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count,created_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,0,$9,now())`,
    [id, source.workflow_id, source.workflow_name, 'step', `打工猫六镜首帧恢复 · ${sourceId}`,
      JSON.stringify(source.runtime_inputs), JSON.stringify(encoded), 6, runs.length])
  }
  await client.query(apply ? 'commit' : 'rollback')
  console.log(JSON.stringify({ ...proof, applied: apply }, null, 2))
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release()
  await pool.end()
}
