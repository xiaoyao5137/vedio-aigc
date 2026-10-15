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
  const workflow = (await client.query('select * from workflow_configs where id=$1 for share', [workflowId])).rows[0]
  if (!source || source.workflow_id !== workflowId || workflow?.schema_version !== 9) throw Error('来源或工作流版本不符')
  const state = decodeExecutionState(source.result)
  const runs = state.nodeRuns
  if (runs.length !== 36 || runs.slice(0, 33).some(run => run.status !== 'success')
    || runs[32]?.node.id !== 'node-video' || runs[32].loopIndex !== 5
    || runs[33]?.node.id !== 'node-video-review' || runs[33].loopIndex !== 5
    || runs[33].output?.storyMediaReview?.reviewStatus !== 'invalid'
    || runs[34]?.node.id !== 'node-video-review-result-branch' || runs[34].status !== 'failed'
    || runs[35]?.status !== 'idle') throw Error('第六镜同片复核边界不符')
  const evidence = runs[33].output.videoEvidence
  if (!/^\/generated\/[\w.-]+\.mp4$/.test(evidence?.url ?? '') || !/^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '')) throw Error('第六镜本地视频证据无效')
  const file = path.resolve('public', `.${evidence.url}`)
  if (!(await stat(file)).isFile() || createHash('sha256').update(await readFile(file)).digest('hex') !== evidence.sha256) throw Error('第六镜原片散列不一致')
  const id = `record-working-cat-sixth-review-${randomUUID().slice(0, 8)}`
  const nextRuns = runs.map((run,index) => index < 33 ? run : {
    ...invalidateRunExecution(run), revision:(run.revision ?? 0) + 1,
  })
  const next = { ...state, id, parentExecutionId:sourceId, requestScopeId:id, generationScopeId:id,
    mode:'step', historical:false, nodeRuns:nextRuns, context:runs[32].context, selectedNodeId:runs[33].node.id,
    logs:[...(state.logs ?? []), '第六镜质检报告引用格式不一致；保留六段已生成视频，从同一原片重做第六镜逐帧质检。'] }
  if (nextRuns.slice(0,33).some((run,index)=>run!==runs[index])) throw Error('六镜成功前缀改变')
  const encoded=encodeExecutionState(next)
  const decoded=decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (decoded.nodeRuns.slice(0,33).some((run,index)=>run.id!==runs[index].id || run.status!=='success')
    || decoded.nodeRuns[32].output?.url!==runs[32].output?.url || decoded.nodeRuns[33].status!=='idle') throw Error('存储往返校验失败')
  if (apply) await client.query(`insert into execution_records
    (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count,created_at)
    values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,0,$9,now())`,
    [id,source.workflow_id,source.workflow_name,'step',`打工猫第6镜同原片复核 · ${sourceId}`,
      JSON.stringify(source.runtime_inputs),JSON.stringify(encoded),33,nextRuns.length])
  await client.query(apply?'commit':'rollback')
  console.log(JSON.stringify({sourceId,forkId:id,applied:apply,preservedRuns:33,preservedVideos:6,
    firstPendingIndex:33,newVideoCalls:0},null,2))
} catch(error) { await client.query('rollback'); throw error } finally { client.release(); await pool.end() }
