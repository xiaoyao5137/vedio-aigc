import { cleanStoryboardForValidation, storyboardContinuityContext } from '../src/storyboard-runtime.ts'
// One real candidate, persisted production nodes, and no automatic retakes.
// Every paid raw response is durable before interpretation or QA. Report repair
// reuses the same decoded bytes and observations, with two total reviewer calls.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import pg from 'pg'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { normalizeStructuredTextOutput, extractTextResponse, applyNodeOutputToContext, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { validateDramaOutline } from '../src/history-drama.ts'
import { validateDramaturgyReview } from '../src/drama-quality-presets.ts'
import { mapNodeInputs } from '../src/node-map.ts'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { HISTORY_QUALITY_VERSION } from '../src/history-media.ts'
import { videoPromptInputContext } from '../src/video-prompt-input.ts'

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]};
const untilEvidence = args.includes('--until-evidence');
if(args.includes('--help')||!option('--input-dir')){
 console.log('Usage: node scripts/verify-cinematic-media.mjs --input-dir DIR [--outline FILE] [--shot FILE] [--context FILE] [--assets FILE] [--out DIR] [--previous CHECKPOINT]\nDefaults: outline-accepted.json, shot-accepted.json, context.json. Exactly one candidate; existing identity assets only. A previous accepted checkpoint permits testing a later approved shot. Report-format repairs: at most two total reviewer calls. No retakes or image generation.');
 process.exit(args.includes('--help')?0:1);
}
if(option('--count')&&Number(option('--count'))!==1)throw Error('This harness verifies one approved shot per invocation; use --previous for the next accepted shot.');
const inputDir=path.resolve(option('--input-dir')),outputDir=path.resolve(option('--out')||path.join(inputDir,'media-first-shot'));
const file=(name,fallback)=>path.resolve(option(name)||path.join(inputDir,fallback));
const read=async name=>JSON.parse(await fs.readFile(name,'utf8'));
const save=async(name,value)=>{const target=path.join(outputDir,name);await fs.writeFile(target+'.tmp',JSON.stringify(value,null,2));await fs.rename(target+'.tmp',target);};
const maybeRead=async name=>{try{return await read(name)}catch(error){if(error.code==='ENOENT')return undefined;throw error;}};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const base=process.env.SMOKE_BASE_URL||'http://127.0.0.1:5173';
function post(route,payload){return new Promise((resolve,reject)=>{const url=new URL(route,base),request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'POST',headers:{'content-type':'application/json'}},response=>{let text='';response.setEncoding('utf8');response.on('data',part=>text+=part);response.on('end',()=>{try{const body=JSON.parse(text);resolve({httpStatus:response.statusCode,...body})}catch(error){reject(error)}});response.on('error',reject)});request.on('error',reject);request.end(JSON.stringify(payload));});}
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL||'postgres://postgres:postgres@localhost:5432/video_aigc'});
let checkpoint={version:'cinematic-media-smoke-v1',passed:false,automaticRetake:false,scope:'one-actual-clip-through-persisted-quality-gate',nodes:[]};
await fs.mkdir(outputDir,{recursive:true});
try{
 const [outline,shot,initial]=await Promise.all([read(file('--outline','outline-accepted.json')),read(file('--shot','shot-accepted.json')),read(file('--context','context.json'))]);
 const previousFile=option('--previous');const prior=previousFile?await read(path.resolve(previousFile)):undefined;
 if(prior&&(!prior.passed||!prior.context?.video_shot?.passed))throw Error('Previous checkpoint must contain an accepted actual clip.');
 const previous=prior?{shot_script:prior.context.shot_script,video_shot:prior.context.video_shot,last_frame:{available:true,url:prior.context.video_shot.lastFrameUrl}}:undefined;
 validateDramaOutline(outline,{requireDramaContract:true,input:initial.input,historicalSources:initial.historical_sources});
 if(outline.factualReview?.passed!==true||validateDramaturgyReview(outline,outline.dramaturgyReview).passed!==true)throw Error('Outline must have passed separate factual/editorial review.');
 if(shot.contentContractVersion!=='cinematic-v1'||shot.factualReview?.passed!==true||validateDramaturgyReview(shot,shot.dramaturgyReview).passed!==true)throw Error('Shot must have passed the cinematic factual/editorial gate.');
 const scene=outline.scenes.find(row=>row.id===shot.sourceSceneId||row.id===shot.id);
 if(!scene)throw Error('Approved scene not found for shot.');
 const continuityContext=storyboardContinuityContext({...initial,scene,loop:{previous}});
 validateHistoricalStructuredOutput('history.storyboard',cleanStoryboardForValidation(shot),{scene,previousShot:continuityContext.loop?.previous?.shot_script,requireContinuityContract:true,requireBeatCoverage:true,requireNarrativeClosure:true});
 const workflow=(await pool.query("select * from workflow_configs where id='wf-sanguo-history-drama'")).rows[0];
 if(!workflow||Number(workflow.schema_version??workflow.schemaVersion)<78)throw Error('Persisted production workflow must first migrate to schema 78.');
 const runtime=await(await fetch(base+'/api/runtime-version')).json();
 if(runtime.historyQualityVersion!==HISTORY_QUALITY_VERSION)throw Error('Server is stale; restart before purchasing media.');
 const models=(await pool.query('select * from model_configs')).rows;
 const names=shot.characters;
 const assets=option('--assets')?await read(path.resolve(option('--assets'))):(await pool.query('select distinct on (character_name) character_name as "characterName",uri as url,metadata from character_assets where character_name=ANY($1::text[]) and asset_type=$2 order by character_name,updated_at desc',[names,'three-view'])).rows;
 if(!Array.isArray(assets)||names.some(name=>!assets.some(asset=>asset.characterName===name&&asset.url)))throw Error('Missing existing three-view assets for '+names.filter(name=>!assets.some(asset=>asset.characterName===name&&asset.url)).join('、')+'; this harness does not purchase images.');
 const manifest={outline,shot,scene,input:initial.input,historical_sources:initial.historical_sources,previous,assets,workflow:{id:workflow.id,schemaVersion:workflow.schema_version??workflow.schemaVersion,nodes:workflow.nodes}};
 const fingerprint=digest(manifest),saved=await maybeRead(path.join(outputDir,'manifest.json'));
 if(saved&&saved.fingerprint!==fingerprint)throw Error('Input or production nodes changed; use a new --out directory to preserve the existing paid take.');
 if(!saved)await save('manifest.json',{fingerprint,...manifest});
 await save('workflow-snapshot.json',{id:workflow.id,schemaVersion:manifest.workflow.schemaVersion,nodes:workflow.nodes,edges:workflow.edges});
 let context={...continuityContext,scene,scene_outline:outline,approved_scene_outline:outline,shot_script:shot,loop:{...continuityContext.loop,index:scene.sequence},character_lookup:{names,existingAssets:assets,existingImages:assets.map(asset=>asset.url)},character_assets:{items:assets,urls:assets.map(asset=>asset.url)},retry:{attempt:1,feedback:''}};
 const at=(object,key)=>key.split('.').reduce((value,name)=>value?.[name],object);
 const parameters=(node,ctx)=>Object.fromEntries(node.params.flatMap(param=>{
  const key=param.englishName||param.name,exact=param.value.trim().match(/^\$\{([^}]+)\}$/);
  // Match App.resolveParamValue: whole references retain their value/type.
  // Missing optional values are omitted; explicit null remains visible to QA.
  if(exact){const value=at(ctx,exact[1].trim());if(value===undefined){if(param.required)throw Error('Missing required parameter '+key+' from '+exact[1]);return [];}return [[key,value]];}
  const value=renderWorkflowTemplate(param.value,ctx);return [[key,param.type==='number'?Number(value):param.type==='boolean'?value==='true':['json','images'].includes(param.type)?JSON.parse(value||'null'):value]];
 }));
 const nodeFor=id=>{const node=workflow.nodes.find(item=>item.id===id);if(!node)throw Error('Missing production node '+id);return node;};
 async function paid(node,ctx,suffix){
  const params=parameters(node,ctx),prompt=renderWorkflowTemplate(node.prompt,node.kind==='video'?videoPromptInputContext({...ctx,params},params.promptInputMode):{...ctx,params})+(ctx.retry?.feedback?'\n【修复本报告，保留同一实际素材与观察】'+String(ctx.retry.feedback):'');
  const model=models.find(item=>item.id===node.modelId);if(!model||model.provider==='Local')throw Error('Actual media validation requires the configured remote model for '+node.id);
  if(node.kind==='video')validateWorkflowMediaContract({model,prompt,params,executionContext:{workflowId:workflow.id,nodeId:node.id}});
  const key=node.id+'-'+suffix,rawFile=path.join(outputDir,key+'-raw.json'),pendingFile=path.join(outputDir,key+'-submitted.json');
  let raw=await maybeRead(rawFile);
  const requestKey='cinematic-media-'+digest({outputDir,fingerprint,key}).slice(0,40);
  if(!raw&&await maybeRead(pendingFile)){
   const stored=(await pool.query("select status,http_status,response_data,error from model_execution_records where request_data->>'requestKey'=$1 order by created_at desc limit 1",[requestKey])).rows[0];
   if(['success','succeeded'].includes(stored?.status)&&stored.response_data){raw={status:stored.http_status||200,body:stored.response_data};await save(key+'-raw.json',raw);}
   else throw Error('Prior paid submission has no durable successful response; inspect model execution record '+requestKey+' before retrying. No duplicate purchase was submitted.');
  }
  if(!raw){await save(key+'-submitted.json',{requestKey,nodeId:node.id,modelId:model.id,startedAt:new Date().toISOString(),params,prompt});raw=await post('/api/node-run',{model,prompt,params,operation:node.operation,executionContext:{workflowId:workflow.id,nodeId:node.id,nodeName:node.title,requestKey}});await save(key+'-raw.json',raw);}
  if(raw.httpStatus>=400||raw.status>=400)throw Error('Model request failed: '+JSON.stringify(raw));
  if(node.kind==='text'){try{return normalizeStructuredTextOutput(raw.body,extractTextResponse(raw.body),'json');}catch(error){throw Error('REVIEW_RESULT_INVALID: 审核JSON格式无效：'+String(error));}}
  const body=raw.body,url=body?.url??body?.data?.task_result?.videos?.[0]?.url??body?.data?.videos?.[0]?.url;
  if(!url)throw Error('Paid video response is cached but has no recognized video URL; inspect '+rawFile+' without resubmitting.');
  return {...body,url,params};
 }
 async function run(id,attempt=1){
  const node=nodeFor(id),key=id+'-'+attempt;
  if(node.runIf&&at(context,node.runIf.path)!==node.runIf.equals)return;
  console.log(JSON.stringify({stage:'start',id,attempt}));
  let output=await maybeRead(path.join(outputDir,key+'.json'));
  if(output===undefined){const params=parameters(node,context);
   if(node.kind==='code')output=await executeCodeNode({code:node.code,params,context,prompt:renderWorkflowTemplate(node.prompt,{...context,params})});
   else if(node.kind==='http'){const response=await post(node.request.url,params);if(response.httpStatus>=400||response.status>=400)throw Error(JSON.stringify(response));output=response.body??response;}
   else output=node.mapInput?await mapNodeInputs(node.mapInput,context,(itemContext,itemIndex)=>paid(node,itemContext,attempt+'-frame-'+itemIndex)):await paid(node,context,String(attempt));
   await save(key+'.json',output);
  }
  context=applyNodeOutputToContext(context,node.resultVar,output);
  checkpoint={...checkpoint,context,nodes:[...checkpoint.nodes,{id,attempt,output}]};await save('checkpoint.json',checkpoint);
  console.log(JSON.stringify({stage:'completed',id,attempt,passed:output?.passed,decision:output?.decision}));return output;
 }
 for(const id of ['sanguo-first-frame-branch','sanguo-first-frame-tail','sanguo-video','sanguo-media-request','sanguo-video-evidence','sanguo-media-metrics'])await run(id);
 if(untilEvidence){
  checkpoint={...checkpoint,context,scope:'one-actual-clip-through-decoded-evidence',passed:false,mediaGenerated:true,mediaQualityVerified:false,completedAt:new Date().toISOString()};
  await save('checkpoint.json',checkpoint);await save('result.json',checkpoint);
  console.log(JSON.stringify({scope:checkpoint.scope,mediaGenerated:true,mediaQualityVerified:false,outputDir,videoUrl:context.video_evidence.url}));
 }else{
 await run('sanguo-media-observe');
 for(let attempt=1;attempt<=2;attempt++){
  try{await run('sanguo-media-review',attempt);const result=await run('sanguo-media-accept',attempt);if(result?.routeError)throw Error(result.routeError);if(result?.passed!==true)throw Error('VIDEO_QUALITY_REJECTED: '+JSON.stringify(result?.issues));checkpoint.passed=true;break;}
  catch(error){if(attempt<2&&String(error).includes('REVIEW_RESULT_INVALID:')){context={...context,retry:{attempt:1,feedback:String(error)}};await save('report-repair.json',{attempt,error:String(error),sameVideo:context.video_take.url});continue;}throw error;}
 }
 checkpoint={...checkpoint,context,completedAt:new Date().toISOString(),videoUrl:context.video_shot?.url};await save('checkpoint.json',checkpoint);await save('result.json',checkpoint);
 console.log(JSON.stringify({passed:checkpoint.passed,outputDir,videoUrl:checkpoint.videoUrl,automaticRetake:false,scope:checkpoint.scope}));
 }
}catch(error){checkpoint={...checkpoint,passed:false,error:String(error),stoppedAt:new Date().toISOString()};await save('checkpoint.json',checkpoint);console.error(String(error));process.exitCode=1;}finally{await pool.end();}
