import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { branchConfigurationErrors } from '../src/workflow-branch.ts'
import { STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE, STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID } from '../src/story-quality-workflow.ts'
import { executeCodeNode } from '../server/code-node.ts'

const sourceId = 'record-working-cat-image-f3074a01'
const workflowId = 'wf-workplace-second-trial-v1'
const apply = process.argv.includes('--apply')
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
try {
  await client.query('begin')
  const source = (await client.query('select * from execution_records where id=$1 for share', [sourceId])).rows[0]
  const row = (await client.query('select * from workflow_configs where id=$1 for update', [workflowId])).rows[0]
  if (!source || source.workflow_id !== workflowId || row?.schema_version !== 6) throw Error('来源记录或工作流版本已改变')
  const old = decodeExecutionState(source.result)
  const runs = old.nodeRuns
  if (runs.length !== 24 || runs.slice(0, 8).some(run => run.status !== 'success')
    || runs[8]?.node.id !== 'node-video-review' || runs[8].status !== 'failed'
    || runs[8].output?.storyMediaReview?.reviewStatus !== 'uncertain'
    || runs.slice(9).some(run => run.status !== 'idle')) throw Error('当前质检恢复边界不符合预期')
  const evidence = runs[8].output?.videoEvidence
  if (!/^\/generated\/[\w.-]+\.mp4$/.test(evidence?.url ?? '') || !/^[a-f0-9]{64}$/.test(evidence?.sha256 ?? '')) throw Error('首镜本地证据无效')
  const file = path.resolve('public', `.${evidence.url}`)
  if (!(await stat(file)).isFile() || createHash('sha256').update(await readFile(file)).digest('hex') !== evidence.sha256) throw Error('首镜视频字节与质检散列不一致')
  const loop = row.nodes.find(node => node.id === 'node-loop')
  const review = row.nodes.find(node => node.id === 'node-video-review')
  const video = row.nodes.find(node => node.id === 'node-video')
  if (!loop || !review || !video || JSON.stringify(loop.childIds) !== JSON.stringify(['node-image','node-video','node-video-review'])
    || row.edges.filter(edge => edge.from === review.id).length !== 0) throw Error('现有循环拓扑不符合预期')
  const branch = {
    id: STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, title: '成片质检结果与重拍回退',
    kind: 'branch', resultVar: 'video_review_decision', code: STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE,
    prompt: '通过或证据未定时保留报告并继续；只有同源实测确证未完成才在预算内重拍。',
    params: [
      { id: 'cat-video-report', name: '成片质检报告', englishName: 'report', type: 'json', required: true, value: '${video_review}' },
      { id: 'cat-video-shot', name: '本镜剧本', englishName: 'shot', type: 'json', required: true, value: '${shot}' },
      { id: 'cat-video-source', name: '本镜原视频', englishName: 'video', type: 'json', required: true, value: '${video_shot}' },
      { id: 'cat-video-attempts', name: '总尝试次数', englishName: 'maxAttempts', type: 'number', required: true, value: '2' },
    ],
    uploads: [], loop: { enabled:false, sourcePath:'', fallbackCount:0, itemVar:'shot' }, parentId:loop.id,
    position: { x: review.position.x+300, y: review.position.y },
  }
  const accepted = {
    id: 'node-video-review-accepted', title: '本镜质检路由完成', kind: 'code', resultVar: 'video_review_route_complete',
    code: 'return { routed: true };', prompt: '记录本镜质检路由已完成，报告仍保留在分镜成片质检节点。',
    params: [], uploads: [], loop: { enabled:false, sourcePath:'', fallbackCount:0, itemVar:'shot' }, parentId:loop.id,
    position: { x: review.position.x+600, y: review.position.y },
  }
  loop.childIds = [...loop.childIds, branch.id, accepted.id]
  const nodes = row.nodes.flatMap(node => node.id === review.id ? [node, branch, accepted] : [node])
  const edges = [...row.edges,
    { id:'edge-cat-media-review-branch', from:review.id, to:branch.id },
    { id:'edge-cat-media-pass', from:branch.id, to:accepted.id, branch:'true' },
    { id:'edge-cat-media-retake', from:branch.id, to:video.id, branch:'false' }]
  if (branchConfigurationErrors({nodes,edges}).length) throw Error('质检分支拓扑无效')
  const decision = await executeCodeNode({code:branch.code,params:{report:runs[8].output,shot:runs[6].loopItem,video:runs[7].output,maxAttempts:2},
    context:{branch:{visits:0,counts:{true:0,false:0}}}})
  if (decision.value !== true) throw Error('原报告未能按证据规则进入保留疑点的继续路径')
  const id = `record-working-cat-media-${randomUUID().slice(0,8)}`
  const updated = runs.slice(0,6).map(run => run.node.id === loop.id ? {...run,node:loop} : run)
  const groupId = runs[6].loopGroupId
  for (let round=0; round<6; round++) {
    const oldRound = runs.slice(6+round*3,9+round*3)
    for (const [index,run] of oldRound.entries()) {
      const next = {...run,loopNode:loop,loopIsLast:false}
      if (round===0 && index===2) {
        next.status='success'
        next.error=undefined
        next.context={...run.inputContext,video_review:run.output}
      }
      updated.push(next)
    }
    const base = oldRound[2]
    for (const [offset,node] of [branch,accepted].entries()) updated.push({
      id:`${node.id}-${groupId}-${round}-${offset+3}`,node,output:undefined,context:{},inputs:{},inputContext:{},
      label:`第 ${round+1} 轮 / ${node.title} -> ${node.resultVar}`,status:'idle',durationMs:0,
      loopNode:loop,loopGroupId:groupId,loopIndex:round,loopItem:base.loopItem,loopPrevious:base.loopPrevious,
      loopIsLast:round===5 && node.id===accepted.id,
    })
  }
  const state={...old,id,parentExecutionId:sourceId,requestScopeId:id,generationScopeId:id,mode:'step',
    nodeRuns:updated,context:updated[8].context,selectedNodeId:branch.id,
    logs:[...(old.logs??[]),`从 ${sourceId} 保留首镜视频和同源质检疑点；由显式分支决定继续，未伪造质检通过。`]}
  const encoded=encodeExecutionState(state)
  const decoded=decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (decoded.nodeRuns.length!==36 || decoded.nodeRuns[8].output?.storyMediaReview?.reviewStatus!=='uncertain'
    || decoded.nodeRuns[9].status!=='idle') throw Error('恢复记录序列化校验失败')
  if (apply) {
    await client.query('update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,schema_version=7,updated_at=now() where id=$1 and schema_version=6',
      [workflowId,JSON.stringify(nodes),JSON.stringify(edges)])
    await client.query(`insert into execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count,created_at)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,0,$9,now())`,
      [id,source.workflow_id,source.workflow_name,'step',`打工猫首镜质检疑点路由 · ${sourceId}`,
        JSON.stringify(source.runtime_inputs),JSON.stringify(encoded),9,updated.length])
  }
  await client.query(apply?'commit':'rollback')
  console.log(JSON.stringify({sourceId,forkId:id,applied:apply,reviewStatus:'uncertain',reviewPassed:false,
    branchDecision:decision.value,preservedVideo:true,firstPendingIndex:9,loopRounds:6,totalRuns:updated.length,newModelCalls:0},null,2))
} catch(error) { await client.query('rollback'); throw error } finally {client.release(); await pool.end()}
