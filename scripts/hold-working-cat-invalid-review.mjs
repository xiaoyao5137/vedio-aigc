import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { executeCodeNode } from '../server/code-node.ts'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE, STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE } from '../src/story-quality-workflow.ts'
import { branchConfigurationErrors } from '../src/workflow-branch.ts'

const sourceId=process.argv[2]
const apply=process.argv.includes('--apply')
const workflowId='wf-workplace-second-trial-v1'
if(!/^record-[\w-]+$/.test(sourceId??'')) throw Error('请提供明确的来源记录 ID')
const pool=new Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const client=await pool.connect()
try {
  await client.query('begin')
  const source=(await client.query('select * from execution_records where id=$1 for share',[sourceId])).rows[0]
  const row=(await client.query('select * from workflow_configs where id=$1 for update',[workflowId])).rows[0]
  if(!source||source.workflow_id!==workflowId||row?.schema_version!==9)throw Error('来源或工作流版本不符')
  const state=decodeExecutionState(source.result)
  const runs=state.nodeRuns
  if(runs.length!==36||runs.slice(0,34).some(run=>run.status!=='success')
    ||runs[33].node.id!=='node-video-review'||runs[33].loopIndex!==5
    ||runs[33].output?.storyMediaReview?.reviewStatus!=='invalid'
    ||runs[34]?.node.id!=='node-video-review-result-branch'||runs[34].status!=='failed'
    ||runs[35]?.status!=='idle')throw Error('第六镜留存边界不符')
  const evidence=runs[33].output.videoEvidence
  if(!/^\/generated\/[\w.-]+\.mp4$/.test(evidence?.url??'')||!/^[a-f0-9]{64}$/.test(evidence?.sha256??''))throw Error('第六镜视频证据无效')
  const file=path.resolve('public',`.${evidence.url}`)
  if(!(await stat(file)).isFile()||createHash('sha256').update(await readFile(file)).digest('hex')!==evidence.sha256)throw Error('第六镜原片散列不一致')
  const oldBranch=row.nodes.find(node=>node.id==='node-video-review-result-branch')
  const oldAccepted=row.nodes.find(node=>node.id==='node-video-review-accepted')
  if(oldBranch?.code!==STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE||oldAccepted?.code!=='return { routed: true };')throw Error('现有质检路由不符')
  const branch={...oldBranch,code:STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE,
    prompt:'质检通过或仅待复核时继续；确证未完成时有界重拍；无效报告绑定同源原片后显式留存为人工复核，不自动重拍、不视为通过。'}
  const accepted={...oldAccepted,title:'本镜质检结果留存'}
  const nodes=row.nodes.map(node=>node.id===branch.id?branch:node.id===accepted.id?accepted:node)
  if(branchConfigurationErrors({nodes,edges:row.edges}).length)throw Error('调整后拓扑无效')
  const result=await executeCodeNode({code:branch.code,
    params:{report:runs[33].output,shot:runs[32].loopItem,video:runs[32].output,maxAttempts:2},
    context:{branch:{visits:0,counts:{true:0,false:0}}}})
  if(result.value!==true||result.manualDecisionRequired!==true||result.reviewHoldStatus!=='invalid'
    ||result.sourceVideoSha256!==evidence.sha256)throw Error('无效报告未进入显式人工复核留存路径')
  const id=`record-working-cat-hold-${randomUUID().slice(0,8)}`
  const nextRuns=runs.map((run,index)=>index<34?run:{...invalidateRunExecution(run),
    node:index===34?branch:accepted,revision:(run.revision??0)+1})
  const next={...state,id,parentExecutionId:sourceId,requestScopeId:id,generationScopeId:id,
    mode:'step',historical:false,nodeRuns:nextRuns,context:runs[33].context,selectedNodeId:branch.id,
    logs:[...(state.logs??[]),'第六镜模型质检报告无效，六段视频与同源原始报告均保留；通过显式人工复核留存路由结束循环，不表示质检通过。']}
  const encoded=encodeExecutionState(next)
  const decoded=decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if(decoded.nodeRuns.slice(0,34).some((run,index)=>run.id!==runs[index].id||run.status!=='success')
    ||decoded.nodeRuns[34].status!=='idle'||decoded.nodeRuns[34].node.code!==STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE)throw Error('存储往返校验失败')
  if(apply){
    const updated=await client.query('update workflow_configs set nodes=$2::jsonb,schema_version=10,updated_at=now() where id=$1 and schema_version=9',[workflowId,JSON.stringify(nodes)])
    if(updated.rowCount!==1)throw Error('工作流 CAS 失败')
    await client.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count,created_at)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,0,$9,now())`,
      [id,source.workflow_id,source.workflow_name,'step',`打工猫第6镜无效报告人工复核留存 · ${sourceId}`,
        JSON.stringify(source.runtime_inputs),JSON.stringify(encoded),34,nextRuns.length])
  }
  await client.query(apply?'commit':'rollback')
  console.log(JSON.stringify({sourceId,forkId:id,applied:apply,preservedRuns:34,preservedVideos:6,
    manualDecisionRequired:true,reviewPassed:false,newVideoCalls:0},null,2))
}catch(error){await client.query('rollback');throw error}finally{client.release();await pool.end()}
