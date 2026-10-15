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
  if (!source || source.workflow_id !== workflowId || workflow?.schema_version !== 8) throw Error('来源或工作流版本不符')
  const state = decodeExecutionState(source.result)
  const runs = state.nodeRuns
  if (runs.length !== 36 || runs.slice(0, 28).some(run => run.status !== 'success')
    || runs[27]?.node.id !== 'node-video' || runs[27].loopIndex !== 4
    || runs[28]?.node.id !== 'node-video-review' || runs[28].loopIndex !== 4
    || runs[28].output?.storyMediaReview?.reviewStatus !== 'technical-failure'
    || !String(runs[28].output?.storyMediaReview?.issues?.[0]).includes('实际音轨接近静音')
    || runs[29]?.node.id !== 'node-video-review-result-branch' || runs[29].status !== 'failed'
    || runs.slice(30).some(run => run.status !== 'idle')) throw Error('第五镜恢复边界不符')
  const shot = runs[2].output?.shots?.[4]
  if (!shot || shot.vocalBeats !== undefined || shot.audioContractVersion !== undefined
    || runs[27].loopItem?.topic !== shot.topic) throw Error('第五镜并非无音频契约的分镜')
  const evidence = runs[28].output.videoEvidence
  if (!/^\/generated\/[\w.-]+\.mp4$/.test(evidence?.url ?? '') || !/^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '')) throw Error('第五镜本地视频证据无效')
  const file = path.resolve('public', `.${evidence.url}`)
  if (!(await stat(file)).isFile() || createHash('sha256').update(await readFile(file)).digest('hex') !== evidence.sha256) throw Error('第五镜原片散列不一致')
  const oldReview = workflow.nodes.find(node => node.id === 'node-video-review')
  if (!oldReview || oldReview.params.some(param => param.englishName === 'requireAudio')) throw Error('质检参数已被更改')
  const review = { ...oldReview, params: [...oldReview.params, { id:'cat-review-require-audio', name:'需要音轨',
    englishName:'requireAudio', type:'boolean', required:true, value:'false' }] }
  const nodes = workflow.nodes.map(node => node.id === review.id ? review : node)
  const id = `record-working-cat-audio-${randomUUID().slice(0, 8)}`
  const nextRuns = runs.map((run, index) => index < 28 ? run : {
    ...invalidateRunExecution(run),
    node: nodes.find(node => node.id === run.node.id) ?? run.node,
    revision: (run.revision ?? 0) + 1,
  })
  const next = { ...state, id, parentExecutionId: sourceId, requestScopeId:id, generationScopeId:id,
    mode:'step', nodeRuns:nextRuns, context:runs[27].context, selectedNodeId:review.id,
    logs:[...(state.logs ?? []), '本工作流剧本未要求音轨；保留第五镜已生成原片，仅以显式可选音频契约重做同源成片质检。'] }
  if (nextRuns.slice(0, 28).some((run, index) => run !== runs[index])) throw Error('已成功前缀改变')
  const encoded = encodeExecutionState(next)
  const decoded = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (decoded.nodeRuns.slice(0, 28).some((run, index) => run.id !== runs[index].id || run.status !== 'success'
    || run.revision !== runs[index].revision)
    || decoded.nodeRuns[27].output?.url !== runs[27].output?.url
    || decoded.nodeRuns[28].status !== 'idle'
    || decoded.nodeRuns[28].node.params.find(param => param.englishName === 'requireAudio')?.value !== 'false') throw Error('存储往返校验失败')
  if (apply) {
    const updated = await client.query('update workflow_configs set nodes=$2::jsonb,schema_version=9,updated_at=now() where id=$1 and schema_version=8',
      [workflowId, JSON.stringify(nodes)])
    if (updated.rowCount !== 1) throw Error('工作流 CAS 失败')
    await client.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count,created_at)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,0,$9,now())`,
    [id,source.workflow_id,source.workflow_name,'step',`打工猫第5镜原片可选音轨质检恢复 · ${sourceId}`,
      JSON.stringify(source.runtime_inputs),JSON.stringify(encoded),28,nextRuns.length])
  }
  await client.query(apply?'commit':'rollback')
  console.log(JSON.stringify({sourceId,forkId:id,applied:apply,preservedRuns:28,preservedVideos:5,
    firstPendingIndex:28,requireAudio:false,newVideoCalls:0},null,2))
} catch(error) { await client.query('rollback'); throw error } finally { client.release(); await pool.end() }
