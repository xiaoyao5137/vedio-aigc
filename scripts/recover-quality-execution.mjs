// Create a reviewable recovery record. Never overwrite the original failed run.
import fs from 'node:fs/promises'
import pg from 'pg'
import { applyNodeOutputToContext } from '../src/workflow-core.ts'
const dir='logs/quality-regression/generic-qa'
const original=JSON.parse(await fs.readFile(dir+'/before-execution.json'))
const replay=JSON.parse(await fs.readFile(dir+'/real-replay.json'))
if(replay.sourceRecord!==original.id || !replay.audit?.some(r=>r.id==='sanguo-media-accept') || !replay.nodeRuns?.find(r=>r.node.id==='sanguo-media-observe')?.node.mapInput)throw Error('Missing completed real QA replay')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
try {
 const w=(await pool.query('select * from workflow_configs where id=$1',[original.result.workflowId])).rows[0]
 const old=original.result.nodeRuns,failed=old.find(r=>r.status==='failed')
 const loop=w.nodes.find(n=>n.kind==='loop'),children=w.nodes.filter(n=>n.parentId===loop.id)
 const reviewParents={'sanguo-scene-outline-review':'sanguo-scene-outline','sanguo-scene-outline-accept':'sanguo-scene-outline','sanguo-shot-script-review':'sanguo-shot-script','sanguo-shot-script-accept':'sanguo-shot-script'}
 const imageChildren=new Set(['sanguo-character-evidence','sanguo-character-review','sanguo-character-accept'])
 const recovered=[];let context={};
 function append(node,source,scope={}){
  let status=source?.status??'idle',output=source?.output;
  let adoption;
  if(!source && reviewParents[node.id]){
   const parent=old.find(r=>r.node.id===reviewParents[node.id]&&r.loopIndex===scope.loopIndex)
   if(parent?.status==='success'&&parent.output?.contentReview?.passed){status='success';output=node.id.endsWith('-accept')?{...parent.output,passed:true}:parent.output.contentReview;adoption={method:'inherited-previous-embedded-review',recordId:original.id,nodeRunId:parent.id};}
  }
  if(!source && imageChildren.has(node.id)){
   const image=old.find(r=>r.node.id==='sanguo-character-image'&&r.loopIndex===scope.loopIndex)
   if(image?.status==='skipped'){status='skipped';output={skipped:true,reason:'既有人物资产已复用'};}
  }
  if(status==='success'||status==='skipped'){
   if(source?.context)context={...context,...source.context};
   context=applyNodeOutputToContext(context,node.resultVar,output)
  }
  const item={...source,...scope,id:`recovery-${node.id}-${scope.loopIndex??'root'}`,node,output,status,context:status==='idle'?{}:context,
    inputContext:source?.inputContext??context,inputs:source?.inputs??{},durationMs:source?.durationMs??0,
    ...(source?.node?{migratedFrom:{recordId:original.id,nodeRunId:source.id,definition:source.node,status:source.status}}:{}),...(adoption?{adoption}:{}),
    label:(scope.loopIndex===undefined?'':`第 ${scope.loopIndex+1} 轮 / `)+node.title};
  if(status!=='failed')delete item.error;
  recovered.push(item)
 }
 for(const node of w.nodes.filter(n=>!n.parentId)){
  append(node,old.find(r=>r.node.id===node.id&&!r.loopGroupId));
  if(node.id!==loop.id)continue;
  const rounds=[...new Set(old.filter(r=>r.loopGroupId).map(r=>r.loopIndex))].sort((a,b)=>a-b)
  for(const index of rounds){
   const group=old.filter(r=>r.loopIndex===index&&r.loopGroupId),sample=group[0]
   for(const [i,child] of children.entries()){
    const scope={loopNode:loop,loopIndex:index,loopGroupId:sample.loopGroupId,loopItem:sample.loopItem,loopPrevious:sample.loopPrevious,loopIsLast:index===rounds.at(-1)&&i===children.length-1}
    const real=index===failed.loopIndex?replay.nodeRuns.find(r=>r.node.id===child.id):undefined;
    append(child,real??group.find(r=>r.node.id===child.id),scope)
   }
  }
 }
 const next=recovered.findIndex(r=>r.status==='idle'||r.status==='failed')
 const id='record-quality-recovery-'+Date.now().toString(36)
 const state={...original.result,id,requestScopeId:id,nodeRuns:recovered,context:next>0?recovered[next-1].context:context,selectedNodeId:recovered[next]?.node.id,
   logs:[`从 ${original.id} 恢复；原记录保持不变。已完成的内容沿用原始通过证据，成片采用独立采证与模型复核结果。`,...replay.audit.map(r=>`${r.id} 第${r.attempt}次 / 复核${r.revision}`)],historical:false}
 const counts=[recovered.filter(r=>r.status==='success').length,recovered.filter(r=>r.status==='failed').length,recovered.length]
 await pool.query('insert into execution_records(id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)',[id,w.id,w.name,'step','质量节点升级恢复 · '+original.id,JSON.stringify(original.result.runtimeInputs),JSON.stringify(state),...counts])
 await fs.writeFile(dir+'/recovered-execution.json',JSON.stringify({id,sourceRecord:original.id,passed:replay.passed,nextNode:recovered[next]?.node.title,counts},null,2));console.log({id,sourceRecord:original.id,nextNode:recovered[next]?.node.title,counts})
}finally{await pool.end()}
