// Real-model, one-scene planning validation. Default is a read-only dry run.
// --run permits at most three writer and three review HTTP requests. This script
// never calls an image/video node or writes an execution/workflow record.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { storyboardDramaContext } from '../src/history-drama.ts'
import { characterAppearanceContext } from '../src/history-media.ts'
import { historicalSourceReviewContext } from '../src/history-source-review.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { generateHistoricalStoryboard, STORYBOARD_SEGMENTS_KEY, cleanStoryboardForValidation,
  sceneFromStoryboardSegment, storyboardContinuityContext } from '../src/storyboard-runtime.ts'
import { verifyDurationSchedule } from '../src/duration-schedule.ts'

const execute = process.argv.includes('--run')
const writerOnly=process.argv.includes('--writer-only')
const rewriteCandidate=process.argv.includes('--rewrite-candidate')
const argument = name => {const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined}
const directory=path.resolve(argument('--out')??'logs/duration-v2-implementation/real-sample')
const snapshotPath=path.resolve(argument('--snapshot')??'logs/duration-v2-implementation/execution-baseline.json')
const candidatePath=argument('--candidate')?path.resolve(argument('--candidate')):undefined
const repairInstructionPath=argument('--repair-instruction')?path.resolve(argument('--repair-instruction')):undefined
const reviewFeedbackPath=argument('--review-feedback')?path.resolve(argument('--review-feedback')):undefined
const writerLimit=Number(argument('--writer-limit')??(candidatePath?0:3))
if(!Number.isInteger(writerLimit)||writerLimit<0||writerLimit>3)throw Error('Writer limit must be an explicitly bounded integer from 0 to 3')
const reviewLimit=Number(argument('--review-limit')??3)
if(!Number.isInteger(reviewLimit)||reviewLimit<0||reviewLimit>3)throw Error('Review limit must be an explicitly bounded integer from 0 to 3')
const base=process.env.SMOKE_BASE_URL??'http://127.0.0.1:5173'
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc',options:'-c default_transaction_read_only=on'})
const secrets=new Set()
const REVIEW_SCOPE_INSTRUCTIONS='\n本次审核对象是新duration-v2脚本，尚无对应新视频。完整核对原台词、动作及群众回应的覆盖；群体无词哼唱必须符合原跟唱义务，不能凭手工预设声部判通过。特别独立核对原批准场景“乡人边走边哼唱”与候选实际排程是否一致；若候选变成“先入场走完后唱”，应明确判断是否遗漏/改变原同时行走唱歌义务，不能因为安全片长已够或为了终止调试就放行。'
const summary={startedAt:new Date().toISOString(),scope:'real-model-duration-v2-first-scene-script-only',dryRun:!execute,
  snapshotPath,directory,...(candidatePath?{candidatePath}:{}),writerLimit,reviewLimit,writerCalls:0,reviewCalls:0,calls:[],attempts:[],
  mediaGenerated:false,executionWrites:0,workflowWrites:0,passed:false}
function collectSecrets(value){if(!value||typeof value!=='object')return
  for(const [key,item] of Object.entries(value))if(/(?:api.?key|authorization|password|secret|access.?token)/i.test(key)&&typeof item==='string'&&item)secrets.add(item);else collectSecrets(item)}
function redact(value){
  if(typeof value==='string'){let text=value;for(const secret of secrets)text=text.replaceAll(secret,'[REDACTED]');return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/g,'Bearer [REDACTED]')}
  if(Array.isArray(value))return value.map(redact)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/(?:api.?key|authorization|password|secret|access.?token)/i.test(key)?'[REDACTED]':redact(item)]))
  return value
}
async function save(name,value){await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,name),JSON.stringify(redact(value),null,2))}
function values(node,context){return Object.fromEntries((node.params??[]).map(param=>{
  const template=String(param.value??''),exact=template.trim().match(/^\$\{([^}]+)\}$/)
  let value=exact?exact[1].trim().split('.').reduce((item,key)=>item&&typeof item==='object'?item[key]:undefined,context):renderWorkflowTemplate(template,context)
  if(!exact&&param.type==='json')value=JSON.parse(value||'{}')
  if(!exact&&param.type==='number')value=Number(value)
  if(!exact&&param.type==='boolean')value=value==='true'
  if(param.required&&(value===undefined||value===null||value===''))throw Error(`${node.id} 缺少原工作流必填输入 ${param.englishName??param.name}`)
  return [param.englishName?.trim()||param.name,value]
}))}
function structured(body){return normalizeStructuredTextOutput(body,extractTextResponse(body),'json')}
async function request(route,payload,name){
  if(!execute)throw Error('DRY_RUN_NO_MODEL_CALLS')
  if(route==='/api/node-run'&&payload.model?.capability!=='text')throw Error('Only the selected text writer/reviewer may be called')
  if(!['/api/node-run','/api/code-node-run'].includes(route))throw Error('Media and mutation endpoints are outside this verifier')
  await save(name+'-request.json',{url:base+route,body:payload})
  const started=Date.now()
  const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(420_000)})
  const raw=await response.text();let result
  try{result=JSON.parse(raw)}catch{result={raw}}
  summary.calls.push({name,route,httpStatus:response.status,status:result.status,elapsedMs:Date.now()-started})
  await save(name+'-response.json',result);await save('summary.json',summary)
  if(!response.ok||result.status>=400||!Object.hasOwn(result,'body'))throw Error(`${name}: HTTP ${response.status}: ${JSON.stringify(redact(result))}`)
  if(result.body?.routeError)throw Error(String(result.body.routeError))
  return result.body
}

let executionId,recordHashBefore,snapshotHashBefore
try{
  const snapshotText=await fs.readFile(snapshotPath,'utf8'),snapshot=JSON.parse(snapshotText)
  snapshotHashBefore=hash(snapshotText);executionId=snapshot.id
  if(executionId!=='record-80xvpe'&&!argument('--snapshot'))throw Error('Expected the explicitly reviewed record-80xvpe snapshot')
  const state=decodeExecutionState(snapshot.result)
  const runs=state.nodeRuns??[]
  const firstRun=id=>runs.find(run=>run.node?.id===id&&run.status==='success')
  const writerRun=firstRun('sanguo-shot-script'),outlineRun=firstRun('sanguo-scene-outline-accept'),videoRun=firstRun('sanguo-video')
  if(!writerRun?.inputContext?.scene||!outlineRun?.output)throw Error('Saved execution lacks the approved first-scene context')
  const outline=outlineRun.output,scene=writerRun.inputContext.scene
  if(outline.passed!==true||outline.factualReview?.passed!==true||outline.dramaturgyReview?.passed!==true)throw Error('The saved source outline has not passed factual and dramaturgy review')
  if(scene.id!=='scene-01'||scene.continuityFromPrevious===true)throw Error('This verifier only replans the first independent shooting scene')
  if(!outline.scenes?.some(row=>row.id===scene.id))throw Error('Selected scene is not in the approved source outline')
  const context={...structuredClone(writerRun.inputContext),...structuredClone(videoRun?.inputContext??{}),
    scene:structuredClone(scene),scene_outline:structuredClone(outline),approved_scene_outline:structuredClone(writerRun.inputContext.approved_scene_outline??outline),
    retry:{},branch:{},loop:{...(writerRun.inputContext.loop??{}),previous:{}},planningOnly:true}
  for(const key of ['shot_candidate','shot_script','shot_script_review','video_take','video_shot','video_evidence','media_metrics','media_review','media_observations','last_frame'])delete context[key]
  const assets=firstRun('sanguo-character-accept')?.output
  if(assets)context.character_assets=structuredClone(assets)
  const row=(await pool.query('SELECT * FROM workflow_configs WHERE id=$1',['wf-sanguo-history-drama'])).rows[0]
  if(!row)throw Error('Current production workflow missing')
  const workflow={...row,schemaVersion:row.schema_version}
  const writer=workflow.nodes.find(node=>node.id==='sanguo-shot-script')
  const reviewer=workflow.nodes.find(node=>node.id==='sanguo-shot-script-review')
  const gate=workflow.nodes.find(node=>node.id==='sanguo-shot-script-accept')
  if(!writer||!reviewer||!gate)throw Error('Current production writer/reviewer/gate are missing')
  const writerParams=values(writer,context)
  if(writerParams.pacingVersion!=='duration-v2'||!writerParams.timingPolicy)throw Error('Deploy the duration-v2 workflow before this verifier runs')
  const localContext=storyboardDramaContext(storyboardContinuityContext({...context,params:writerParams}))
  const reviewFeedback=reviewFeedbackPath?await fs.readFile(reviewFeedbackPath,'utf8'):''
  if(reviewFeedbackPath)summary.reviewFeedback={path:reviewFeedbackPath,sha256:hash(reviewFeedback)}
  const prepareReview=(current,segment)=>{
    const params=values(reviewer,current)
    if(JSON.stringify(params.candidate)!==JSON.stringify(segment))throw Error('HISTORY_REVIEW_INPUT_INVALID: Review must receive the actual compiled candidate')
    if(params.promptInputMode!=='normalized-results')throw Error('VERIFY_REVIEW_PROJECTION_MISSING: deploy normalized-results on the actual selected storyboard reviewer')
    const view=nodePromptInputContext(historicalSourceReviewContext({...current,params}),params.promptInputMode)
    const projected=view.params.candidate
    if(Object.hasOwn(projected,'raw')||Object.hasOwn(projected,'text'))throw Error('VERIFY_REVIEW_STALE_DRAFT: reviewer projection still exposes a superseded raw model draft')
    if(projected.videoPrompt!==segment.videoPrompt||JSON.stringify(projected.pacing)!==JSON.stringify(segment.pacing))throw Error('VERIFY_REVIEW_CANDIDATE_CHANGED: prompt projection must preserve current compiled timing and obligations')
    const prompt=renderWorkflowTemplate(reviewer.prompt,view)+REVIEW_SCOPE_INSTRUCTIONS
      +(reviewFeedback?'\n【本次同一候选的审核复核反馈】\n'+reviewFeedback:'')
    if(!prompt.includes('【duration-v2分镜审核契约】')||!prompt.includes('不能要求把无词哼唱硬塞进汉字对白 audioText'))throw Error('VERIFY_REVIEW_V2_CONTRACT_MISSING: deploy explicit independent vocalization and current-timeline review instructions')
    return {params,prompt}
  }
  const productionTimingPrompt='本轮使用duration-v2共享策略，按声明的表演类型、完整节拍依赖与可读收尾排程；不套4.5字/秒，不强制缩为最短整数，15秒放不下则按原节拍连续拆段。本轮pacing.timingPolicy必须原样使用以下完整对象：'+JSON.stringify(writerParams.timingPolicy)
  const repairInstruction=repairInstructionPath?await fs.readFile(repairInstructionPath,'utf8'):''
  const importedCandidate=candidatePath?JSON.parse(await fs.readFile(candidatePath,'utf8')):undefined
  const prompt=renderWorkflowTemplate(writer.prompt,nodePromptInputContext(localContext,writerParams.promptInputMode))
    +'\n【实际生产语速预算】'+productionTimingPrompt
    +'\n【既有角色定妆，必须沿用】'+JSON.stringify(characterAppearanceContext(assets?.items??[]))+'。仅沿用身份、脸部和服装，不沿用旧站位或动作。没有既有资产的角色才可设计新外观。'
    +'\n【本次真实模型验证范围】只重新规划原已批准scene-01，保留全部史料、原歌谣文字和群众知晓回应义务。这是尚未生成的新duration-v2镜头；旧6秒视频不作为新镜已完成证据。按共享策略分配主唱与可听群众声部、动作先后和收尾，不强制指定9秒；以完整义务与可信预算选择实际秒数。群众短促无词回应是否完整覆盖原跟唱义务必须交由内容审核确认。不得新增实际观测声明。'
    +(repairInstruction?'\n【本次已确认候选调度问题】\n'+repairInstruction:'')
    +(rewriteCandidate&&importedCandidate?'\n【本次待修的真实模型原候选，按上述问题重新创作，不得直接回传旧稿】\n'+JSON.stringify(cleanStoryboardForValidation(importedCandidate)):'')
  const models=new Map()
  for(const id of new Set([writer.modelId,reviewer.modelId])){
    const model=(await pool.query('SELECT * FROM model_configs WHERE id=$1',[id])).rows[0]
    if(!model||model.capability!=='text')throw Error('Current selected writer/reviewer must be text models')
    collectSecrets(model);models.set(id,model)
  }
  recordHashBefore=(await pool.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1',[executionId])).rows[0]?.hash
  Object.assign(summary,{executionId,sourceSnapshotHash:snapshotHashBefore,sourceSceneId:scene.id,
    workflowSchema:workflow.schemaVersion,workflowHash:hash([workflow.nodes,workflow.edges,workflow.schemaVersion]),
    writerModelId:writer.modelId,reviewerModelId:reviewer.modelId,sourceSceneHash:hash(scene),sourceOutlineHash:hash(outline),
    existingCharacterAssets:assets?.items?.length??0,existingFirstFrameAvailable:Boolean(context.first_frame?.url),
    requestScope:`duration-v2-real-${Date.now()}-${snapshotHashBefore.slice(0,10)}`})
  await save('source-scene.json',scene);await save('source-approved-outline.json',outline)
  await save('source-provenance.json',{executionId,snapshotPath,snapshotHash:snapshotHashBefore,sourceSceneHash:hash(scene),
    outlineAcceptanceNodeId:outlineRun.node.id,outlineFactualReview:outline.factualReview,outlineDramaturgyReview:outline.dramaturgyReview,
    sourceWriterNodeId:writerRun.node.id,sourceVideoNodeId:videoRun?.node.id,readOnly:true})
  await save('context.json',context);await save('workflow-selection.json',{schemaVersion:workflow.schemaVersion,writer,reviewer,gate})
  await save('writer-prompt.json',{prompt,params:writerParams});await save('summary.json',summary)
  const expected={...writerParams,scene,previousShot:undefined,pacingVersion:'duration-v2',timingPolicy:writerParams.timingPolicy,
    requireDramaContract:true,requireContinuityContract:true,requireDynamicPacing:true,requireNarrativeClosure:true,aspectRatio:context.input?.aspect_ratio}
  const initialCandidate=rewriteCandidate?undefined:importedCandidate
  if(candidatePath){summary.importedRealCandidate={path:candidatePath,sha256:hash(await fs.readFile(candidatePath,'utf8')),writerCallsAllowed:writerLimit,rewriteCandidate};await save('imported-real-candidate.json',importedCandidate)}
  if(initialCandidate&&writerLimit===0){
    const compiled=validateHistoricalStructuredOutput('history.storyboard',initialCandidate,expected)
    verifyDurationSchedule(compiled,{scene,timingPolicy:writerParams.timingPolicy})
    await save('imported-compiled-preflight.json',compiled)
    summary.importedCandidatePreflight={fullScriptContract:true,serverHashRecomputed:true,duration:compiled.duration,modelDuration:compiled.timingEstimate.modelDuration}
    if(!writerOnly&&reviewLimit>0){
      const prepared=prepareReview({...context,[writer.resultVar]:compiled},compiled)
      await save('review-prompt-preflight.json',prepared)
      summary.reviewPreflight={normalizedResults:true,independentVocalizationContract:true,currentTimelinePreserved:true,staleRawDraftExcluded:true}
    }
  }
  const assertWriterPrompt=nextPrompt=>{
    if(!nextPrompt.includes(JSON.stringify(writerParams.timingPolicy)))throw Error('VERIFY_PROMPT_POLICY_MISSING: actual writer prompt must contain the complete production timingPolicy JSON')
    if(!nextPrompt.includes('beats 格式：')||!nextPrompt.includes('durationEstimate:{lower,expected,upper,source,confidence:'))throw Error('VERIFY_PROMPT_BEATS_MISSING: actual writer prompt must contain the structured beat contract')
    if(!nextPrompt.includes('【duration-v2 分镜执行规则】'))throw Error('VERIFY_PROMPT_RUNTIME_MISSING: actual writer prompt must include the v2 runtime contract')
    if(repairInstruction&&(!nextPrompt.includes(repairInstruction)||!nextPrompt.includes('textOrVocalization')||!nextPrompt.includes('resources')))throw Error('VERIFY_PROMPT_REPAIR_MISSING: explicit repair and current field/resource rules must reach the actual writer')
  }
  // Exercise the exact runtime prompt builder without dispatching any request.
  const preflightStop=new Error('READ_ONLY_WRITER_PREFLIGHT_COMPLETE')
  try{await generateHistoricalStoryboard({prompt,expected,generate:async nextPrompt=>{
    assertWriterPrompt(nextPrompt);await save('writer-final-prompt-preflight.json',{prompt:nextPrompt,params:writerParams});throw preflightStop
  }})}catch(error){if(error!==preflightStop)throw error}
  summary.promptPreflight={completePolicyJson:true,structuredBeatContract:true,durationV2RuntimeContract:true,existingCharacterDesignsIncluded:true}
  await save('summary.json',summary)
  console.log(JSON.stringify({event:execute?'real-storyboard-started':'dry-run-ready',executionId,directory,workflowSchema:workflow.schemaVersion,sceneId:scene.id,writerModelId:writer.modelId,reviewerModelId:reviewer.modelId,modelCalls:0}))
  if(execute){
    const result=await generateHistoricalStoryboard({prompt,expected,initialCandidate,
      canGenerate:()=>summary.writerCalls<summary.writerLimit,
      onAttempt:event=>{summary.attempts.push(event);console.log(JSON.stringify({event:'storyboard-repair',...event}))},
      generate:async nextPrompt=>{
        assertWriterPrompt(nextPrompt)
        if(summary.writerCalls>=summary.writerLimit)throw Error(`REAL_STORYBOARD_BUDGET: ${summary.writerLimit} writer requests exhausted`)
        const index=++summary.writerCalls
        const raw=await request('/api/node-run',{model:models.get(writer.modelId),prompt:nextPrompt,params:writerParams,operation:writer.operation,
          executionContext:{workflowId:workflow.id,nodeId:writer.id,nodeName:writer.title,requestKey:`${summary.requestScope}:writer:${index}`}},`writer-${index}`)
        try{await save(`writer-${index}-candidate.json`,structured(raw))}catch{/* Preserve raw response when the model did not return parseable JSON. */}
        return raw
      },
      review:writerOnly?undefined:async candidate=>{
        const segments=candidate[STORYBOARD_SEGMENTS_KEY]??[candidate],reviews=[]
        for(const [index,segment]of segments.entries()){
          const partScene=segments.length>1?sceneFromStoryboardSegment(scene,segment,index,segments.length):scene
          const current={...context,scene:partScene,[writer.resultVar]:segment,loop:{...context.loop,previous:index?{shot_script:segments[index-1]}:{}}}
          let correction=''
          for(;;){
            if(summary.reviewCalls>=summary.reviewLimit)throw Error('REAL_STORYBOARD_BUDGET: three review requests exhausted')
            const prepared=prepareReview(current,segment)
            const reviewIndex=++summary.reviewCalls,reviewParams=prepared.params
            const reviewPrompt=prepared.prompt+correction
            const report=structured(await request('/api/node-run',{model:models.get(reviewer.modelId),prompt:reviewPrompt,params:reviewParams,operation:reviewer.operation,
              executionContext:{workflowId:workflow.id,nodeId:reviewer.id,nodeName:reviewer.title,requestKey:`${summary.requestScope}:review:${reviewIndex}`}},`review-${reviewIndex}`))
            const gateContext={...current,[reviewer.resultVar]:report}
            let accepted
            try{accepted=await request('/api/code-node-run',{code:gate.code,prompt:gate.prompt,params:values(gate,gateContext),context:gateContext,files:[]},`gate-${reviewIndex}`)}
            catch(error){if(summary.reviewCalls>=summary.reviewLimit||!String(error).includes('REVIEW_RESULT_INVALID:'))throw error
              correction='\n【只复核同一候选的报告格式】'+String(error)+'\n上一报告：'+JSON.stringify(report);continue}
            if(accepted.passed!==true)throw Error('HISTORY_CONTENT_REJECTED: '+JSON.stringify(accepted.issues??accepted))
            verifyDurationSchedule(accepted,{scene:partScene,timingPolicy:writerParams.timingPolicy})
            reviews.push(accepted);break
          }
        }
        return {passed:true,scope:'real-model-script-source-and-dramaturgy-review',mediaQualityVerified:false,segmentReviews:reviews}
      },
    })
    const segments=result[STORYBOARD_SEGMENTS_KEY]??[result]
    if(segments.length!==1)throw Error('REAL_STORYBOARD_SPLIT_REQUIRED: Validated scene requires multiple shots; stop before the separately authorized one-video validation')
    if(writerOnly){
      const planned={...cleanStoryboardForValidation(result),scriptValidation:result.scriptValidation,timingEstimate:result.timingEstimate}
      verifyDurationSchedule(planned,{scene,timingPolicy:writerParams.timingPolicy})
      await save('planned-shot.json',planned)
      summary.planned={file:'planned-shot.json',duration:planned.duration,scheduleHash:planned.pacing.scheduleHash,scriptContractPassed:true,contentReviewPassed:false,mediaQualityVerified:false}
      summary.outcome='awaiting-content-review'
      console.log(JSON.stringify({event:'real-storyboard-planned',...summary.planned,writerCalls:summary.writerCalls,reviewCalls:summary.reviewCalls,directory}))
    }else{
    const reviewed=result.contentReview?.segmentReviews?.[0]
    const accepted={...cleanStoryboardForValidation(result),scriptValidation:result.scriptValidation,timingEstimate:result.timingEstimate,
      ...(reviewed?{factualReview:reviewed.factualReview,dramaturgyReview:reviewed.dramaturgyReview,contentReview:{passed:true,scope:'real-model-script-only'},passed:true}:{})}
    verifyDurationSchedule(accepted,{scene,timingPolicy:writerParams.timingPolicy})
    await save('accepted-shot.json',accepted)
    await save('context.json',{...context,[writer.resultVar]:accepted,[gate.resultVar]:accepted,shot_script:accepted,planningOnly:false})
    summary.passed=true;summary.accepted={file:'accepted-shot.json',shotId:accepted.id,duration:accepted.duration,scheduleHash:accepted.pacing.scheduleHash,
      contentEndBudget:accepted.timingEstimate.contentEndBudget,safeEndBudget:accepted.timingEstimate.safeEndBudget,realModelGenerated:true,scriptReviewed:true,mediaQualityVerified:false}
    console.log(JSON.stringify({event:'real-storyboard-passed',...summary.accepted,writerCalls:summary.writerCalls,reviewCalls:summary.reviewCalls,directory}))
    }
  }
}catch(error){summary.error=redact(error instanceof Error?error.message:String(error));process.exitCode=1;console.error(JSON.stringify({event:'verification-failed',directory,error:summary.error}))}
finally{
  try{
    if(executionId){const after=(await pool.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1',[executionId])).rows[0]?.hash
      summary.originalExecutionHashBefore=recordHashBefore;summary.originalExecutionHashAfter=after;summary.concurrentExecutionChanged=recordHashBefore!==undefined&&recordHashBefore!==after}
    if(snapshotHashBefore)summary.originalSnapshotUnchanged=hash(await fs.readFile(snapshotPath,'utf8'))===snapshotHashBefore
  }catch(error){summary.proofError=String(error)}
  summary.finishedAt=new Date().toISOString();await save('summary.json',summary);await pool.end()
}
