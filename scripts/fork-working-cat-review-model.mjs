import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'

const sourceId = process.argv[2]
const apply = process.argv.includes('--apply')
const workflowId = 'wf-workplace-second-trial-v1'
if (!/^record-[\w-]+$/.test(sourceId ?? '')) throw Error('请提供明确的来源记录 ID')
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
try {
  await client.query('begin')
  const source = (await client.query('select * from execution_records where id=$1 for share', [sourceId])).rows[0]
  const workflow = (await client.query('select * from workflow_configs where id=$1 for update', [workflowId])).rows[0]
  if (!source || source.workflow_id !== workflowId || workflow?.schema_version !== 7) throw Error('来源或工作流版本不符')
  const state = decodeExecutionState(source.result)
  const runs = state.nodeRuns
  if (runs.length !== 36 || runs.slice(0, 13).some(run => run.status !== 'success')
    || runs[13]?.node.id !== 'node-video-review' || runs[13].loopIndex !== 1
    || runs[13].output?.storyMediaReview?.reviewStatus !== 'unavailable'
    || runs[14]?.node.id !== 'node-video-review-result-branch' || runs[14].status !== 'failed'
    || !String(runs[14].error).includes('STORY_MEDIA_REVIEW_REQUIRED: unavailable')
    || runs.slice(15).some(run => run.status !== 'idle')) throw Error('第二镜质检恢复边界不符')
  const evidence = runs[13].output.videoEvidence
  if (!/^\/generated\/[\w.-]+\.mp4$/.test(evidence?.url ?? '') || !/^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '')) throw Error('第二镜本地证据无效')
  const file = path.resolve('public', `.${evidence.url}`)
  if (!(await stat(file)).isFile() || createHash('sha256').update(await readFile(file)).digest('hex') !== evidence.sha256) throw Error('第二镜视频字节与质检散列不一致')
  const oldReview = workflow.nodes.find(node => node.id === 'node-video-review')
  if (oldReview?.modelId !== 'gpt-5.6-sol') throw Error('当前质检模型不符')
  const review = { ...oldReview, modelId: 'codex-local-vision' }
  const nodes = workflow.nodes.map(node => node.id === review.id ? review : node)
  const id = `record-working-cat-review-${randomUUID().slice(0, 8)}`
  const prefix = JSON.stringify(runs.slice(0, 13))
  const nextRuns = runs.map((run, index) => index < 13 ? run : {
    ...invalidateRunExecution(run),
    node: nodes.find(node => node.id === run.node.id) ?? run.node,
    revision: (run.revision ?? 0) + 1,
  })
  const next = { ...state, id, parentExecutionId: sourceId, requestScopeId: id, generationScopeId: id,
    mode: 'step', nodeRuns: nextRuns, context: runs[12].context, selectedNodeId: review.id,
    logs: [...(state.logs ?? []), `保留前两镜视频及前13项成功记录；第2镜质检由本地抽帧验证的视觉模型重新执行。`] }
  if (JSON.stringify(nextRuns.slice(0, 13)) !== prefix) throw Error('成功前缀变化')
  const encoded = encodeExecutionState(next)
  const decoded = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (JSON.stringify(decoded.nodeRuns.slice(0, 13)) !== prefix || decoded.nodeRuns[13].status !== 'idle'
    || decoded.nodeRuns[13].node.modelId !== 'codex-local-vision') throw Error('存储往返校验失败')
  if (apply) {
    const updated = await client.query('update workflow_configs set nodes=$2::jsonb,schema_version=8,updated_at=now() where id=$1 and schema_version=7',
      [workflowId, JSON.stringify(nodes)])
    if (updated.rowCount !== 1) throw Error('工作流 CAS 失败')
    await client.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count,created_at)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,0,$9,now())`,
    [id, source.workflow_id, source.workflow_name, 'step', `打工猫第2镜同视频质检恢复 · ${sourceId}`,
      JSON.stringify(source.runtime_inputs), JSON.stringify(encoded), 13, nextRuns.length])
  }
  await client.query(apply ? 'commit' : 'rollback')
  console.log(JSON.stringify({sourceId, forkId:id, applied:apply, preservedRuns:13, preservedVideos:2,
    firstPendingIndex:13, model:review.modelId, newVideoCalls:0},null,2))
} catch(error) { await client.query('rollback'); throw error } finally { client.release(); await pool.end() }
