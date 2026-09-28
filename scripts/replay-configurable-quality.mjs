import { mapNodeInputs } from '../src/node-map.ts'
// Replay the exact rejected take through the persisted graph. --retake enables
// the graph's bounded generation policy; otherwise no media generation occurs.
import fs from 'node:fs/promises'
import pg from 'pg'
import { request as httpRequest } from 'node:http'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, applyNodeOutputToContext } from '../src/workflow-core.ts'
import { acceptanceTransition, errorRetryTransition } from '../src/node-retry.ts'
import { runWorkflowToCompletion } from '../src/workflow-runner.ts'
const dir='logs/quality-regression/generic-qa'
const base=process.env.SMOKE_BASE_URL??'http://127.0.0.1:5173'
const allowRetake=process.argv.includes('--retake')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const w=(await pool.query("select * from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
const models=(await pool.query('select * from model_configs')).rows;await pool.end()
const original=JSON.parse(await fs.readFile(dir+'/before-execution.json'))
const rejected=JSON.parse(await fs.readFile('public/generated/verified-2dd60ee694c27910c651-rejection.json'))
const failed=original.result.nodeRuns.find(n=>n.status==='failed')
const shot={...failed.inputContext.shot_script};delete shot.raw;delete shot.contentReview;delete shot.scriptValidation
const initialContext={...failed.inputContext,shot_script:shot,video_take:{url:rejected.url},retry:{attempt:1,feedback:''}}
const ids=['sanguo-video','sanguo-media-request','sanguo-video-evidence','sanguo-media-metrics','sanguo-media-observe','sanguo-media-review','sanguo-media-accept']
let runs=ids.map((id,i)=>({id,node:w.nodes.find(n=>n.id===id),status:i?'idle':'success',output:i?undefined:initialContext.video_take,inputContext:initialContext,context:i?{}:initialContext,durationMs:0,attempt:1,revision:0}))
let reusableObservation;
if(process.argv.includes('--resume-review')) {
 const checkpoint=JSON.parse(await fs.readFile(dir+'/replay-checkpoint.json'));
 const prior=checkpoint.nodeRuns[0];
 if(prior.status!=='success'||!prior.output?.url)throw Error('No completed candidate to review');
 const generated=prior.output;
 const observation=checkpoint.nodeRuns.find(r=>r.node.id==='sanguo-media-observe');
 const current=w.nodes.find(r=>r.id==='sanguo-media-observe');
 // A prior report-format error contains no rejected-take visual feedback.
 const formatOnly=String(observation?.retryFeedback??'').includes('剧情或节奏证据不完整');
 if(observation?.status==='success'&&(!observation.retryFeedback||formatOnly)&&observation.inputContext?.video_take?.url===generated.url
   &&JSON.stringify(observation.node)===JSON.stringify(current))reusableObservation=observation.output;
 runs=runs.map((r,i)=>({...r,attempt:prior.attempt,revision:(checkpoint.nodeRuns[i]?.revision??0)+1,attempts:checkpoint.nodeRuns[i]?.attempts??[],
   ...(i===0?{output:generated,context:{...initialContext,video_take:generated},status:'success'}:{status:'idle'})}));
}
function post(url,body){return new Promise((resolve,reject)=>{
 const req=httpRequest(base+url,{method:'POST',headers:{'content-type':'application/json'}},res=>{let txt='';res.on('data',d=>txt+=d);res.on('end',()=>{try{const out=JSON.parse(txt);if(res.statusCode>=400)reject(Error(JSON.stringify(out)));else resolve(out)}catch(e){reject(e)}});res.on('error',reject)});
 req.on('error',reject);req.end(JSON.stringify(body))
})}
const audit=[]
const result=await runWorkflowToCompletion({nodeRuns:runs},async(index,state)=>{
 const run=state.nodeRuns[index],node=run.node;
 const context={...(index?state.nodeRuns[index-1].context:initialContext),retry:{attempt:run.attempt,feedback:run.retryFeedback??''}}
 const params=Object.fromEntries(node.params.map(p=>{const v=renderWorkflowTemplate(p.value,context);return [p.englishName??p.name,p.type==='number'?Number(v):p.type==='boolean'?v==='true':['json','images'].includes(p.type)?JSON.parse(v||'null'):v]}))
 const prompt=renderWorkflowTemplate(node.prompt,{...context,params})+(run.retryFeedback?'\n【本次重试反馈】'+(typeof run.retryFeedback==='string'?run.retryFeedback:JSON.stringify(run.retryFeedback))+'\n完整保留原剧情与台词，只修正明确问题。':'')
 const started=Date.now();console.log(JSON.stringify({stage:'start',id:node.id,attempt:run.attempt,revision:run.revision}));
 let output,updated=state.nodeRuns.map((r,i)=>i===index?{...r,inputContext:context,inputs:params}:r)
 try{
  if(node.id==='sanguo-media-observe'&&reusableObservation){output=reusableObservation;reusableObservation=undefined;}
  else if(node.kind==='http')output=await post(node.request.url,params)
  else if(node.kind==='code'){
   const r=await post('/api/code-node-run',{code:node.code,params,prompt,context,files:[]});if(r.status>=400)throw Error(JSON.stringify(r));output=r.body??r
  }else{
   if(node.kind==='video'&&!allowRetake)throw Error('Retakes disabled')
   const model=models.find(m=>m.id===node.modelId);if(model.capability==='text'&&new URL(model.settings.endpoint).hostname!=='doro.lat')throw Error('Unexpected reviewer provider')
   const generate=async(itemContext,itemIndex)=>{
    const itemParams=Object.fromEntries(node.params.map(p=>{const v=renderWorkflowTemplate(p.value,itemContext);return [p.englishName??p.name,p.type==='number'?Number(v):p.type==='boolean'?v==='true':['json','images'].includes(p.type)?JSON.parse(v||'null'):v]}));
    const itemPrompt=renderWorkflowTemplate(node.prompt,{...itemContext,params:itemParams})+(run.retryFeedback?'\n【本次复核或重拍反馈】'+JSON.stringify(run.retryFeedback):'');
    const r=await post('/api/node-run',{model,prompt:itemPrompt,params:itemParams,executionContext:{workflowId:w.id,nodeId:node.id,nodeName:node.title,requestKey:`generic-qa-schema-${w.schema_version??w.schemaVersion}:${node.id}:attempt-${run.attempt}:revision-${run.revision}:item-${itemIndex}`}})
    if(r.status>=400)throw Error(JSON.stringify(r));
    if(node.kind==='text')return normalizeStructuredTextOutput(r.body,extractTextResponse(r.body),'json');
    const url=r.body.url??r.body.data?.task_result?.videos?.[0]?.url;if(!url)throw Error('Missing generated video URL');return {...r.body,url,params:itemParams};
   };
   output=node.mapInput?await mapNodeInputs(node.mapInput,context,generate):await generate(context,0);
  }
  const file=`${node.id}-attempt-${run.attempt}-revision-${run.revision}.json`;
  await fs.writeFile(dir+'/'+file,JSON.stringify(output,null,2));audit.push({id:node.id,attempt:run.attempt,revision:run.revision,file,durationMs:Date.now()-started})
  console.log(JSON.stringify({stage:'completed',id:node.id,passed:output.passed,decision:output.decision,issues:output.issues}));
  updated=updated.map((r,i)=>i===index?{...r,output,context:applyNodeOutputToContext(context,node.resultVar,output),status:'success',durationMs:Date.now()-started}:r)
  const transition=allowRetake?acceptanceTransition(updated,index,output):undefined
  if(transition){updated=transition.runs;console.log(JSON.stringify({stage:'retry',reason:transition.reason,exhausted:transition.exhausted}))}
 }catch(error){
  const message=String(error);const recovery=errorRetryTransition(updated,index,message)
  if(recovery){updated=recovery.runs;console.log(JSON.stringify({stage:'review-recovery',reason:recovery.reason,exhausted:recovery.exhausted}))}
  else updated=updated.map((r,i)=>i===index?{...r,status:'failed',error:message,output:{error:message}}:r)
 }
 const next={nodeRuns:updated};await fs.writeFile(dir+'/replay-checkpoint.json',JSON.stringify(next,null,2));return next
})
const report={scope:'exact-rejected-bytes-through-configured-quality-graph',sourceRecord:original.id,allowRetake,audit,...result,passed:result.nodeRuns.at(-1).status==='success'&&result.nodeRuns.at(-1).output?.passed===true}
await fs.writeFile(dir+'/real-replay.json',JSON.stringify(report,null,2));console.log(JSON.stringify({stage:'finished',passed:report.passed,status:result.nodeRuns.at(-1).status}));
