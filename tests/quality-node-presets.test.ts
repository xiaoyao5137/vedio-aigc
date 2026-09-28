import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { upgradeConfigurableQuality, upgradeIndependentScriptReviews, upgradeIndependentImageReviews, MEDIA_ACCEPT_CODE, SCRIPT_ACCEPT_CODE, VIDEO_REQUEST_CODE } from '../src/quality-node-presets.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { INDEPENDENT_MEDIA_REVIEW_VIEW_CODE, REQUIREMENT_REVIEW_METRICS_CODE, NATIVE_MEDIA_OBSERVATION_GUARD_CODE } from '../src/quality-node-presets.ts'
import { deriveMediaEvidenceViews } from '../src/media-evidence-views.ts'
import { speechMetrics } from '../server/speech-metrics.ts'
import { validateHistoricalMediaReview } from '../src/history-media.ts'

const base={id:'wf-sanguo-history-drama',schemaVersion:59,nodes:['sanguo-scene-outline','sanguo-shot-script','sanguo-character-image','sanguo-video','sanguo-last-frame','loop'].map(id=>({id,title:id,kind:id==='sanguo-video'?'video':id==='sanguo-shot-script'?'text':'code',modelId:'user-model',resultVar:id,prompt:'test',params:[],uploads:[],loop:{enabled:false,sourcePath:'',fallbackCount:1,itemVar:'item'},position:{x:0,y:0},parentId:'loop',...(id==='loop'?{childIds:['sanguo-shot-script','sanguo-character-image','sanguo-video','sanguo-last-frame']}: {})})),edges:[{id:'v-tail',from:'sanguo-video',to:'sanguo-last-frame'}]}

test('current historical writers fail over after two transport failures without changing semantic retry budgets',async()=>{
 const {upgradeHistoricalTextTransportFailover}=await import('../src/quality-node-presets.ts')
 const parameter={id:'budget',name:'maxGenerationAttempts',englishName:'maxGenerationAttempts',type:'number',required:true,value:'20'}
 const writer=(id:string)=>({...base.nodes[0],id,kind:'text',modelId:'primary-writer',params:[parameter]})
 const observer={...base.nodes[0],id:'sanguo-media-observe',kind:'text',modelId:'secondary-writer',params:[]}
 const workflow=upgradeHistoricalTextTransportFailover({...base,schemaVersion:124,nodes:[writer('sanguo-scene-outline'),writer('sanguo-shot-script'),observer]})
  assert.equal(workflow.schemaVersion,125)
 for(const id of ['sanguo-scene-outline','sanguo-shot-script']){
  const node=workflow.nodes.find(item=>item.id===id)!
  assert.equal(node.params.find(param=>param.englishName==='primaryTransportAttempts')?.value,'2')
  assert.equal(node.params.find(param=>param.englishName==='transportFallbackModelId')?.value,'secondary-writer')
  assert.equal(node.params.find(param=>param.englishName==='maxGenerationAttempts')?.value,'20')
 }
})

test('schema 126 moves historical writer fallback off the shared remote gateway',async()=>{
 const {upgradeIndependentHistoricalTextFallback}=await import('../src/quality-node-presets.ts')
 const fallback={...base.nodes[0],id:'sanguo-media-review',kind:'text',modelId:'codex-local-vision',params:[]}
 const writer=(id:string)=>({...base.nodes[0],id,kind:'text',modelId:'primary-writer',params:[
  {id:'limit',name:'主通道传输尝试',englishName:'primaryTransportAttempts',type:'number',required:true,value:'2'},
  {id:'fallback',name:'传输备用文本模型',englishName:'transportFallbackModelId',type:'text',required:true,value:'gpt-same-gateway'},
 ]})
 const workflow=upgradeIndependentHistoricalTextFallback({...base,schemaVersion:125,nodes:[writer('sanguo-scene-outline'),writer('sanguo-shot-script'),fallback]})
 assert.equal(workflow.schemaVersion,126)
 for(const id of ['sanguo-scene-outline','sanguo-shot-script']){
  const node=workflow.nodes.find(item=>item.id===id)!
  assert.equal(node.params.find(param=>param.englishName==='transportFallbackModelId')?.value,'codex-local-vision')
  assert.equal(node.params.find(param=>param.englishName==='primaryTransportAttempts')?.value,'2')
 }
})

test('schema 127 bounds the independent writer fallback separately from visual review',async()=>{
 const {upgradeBoundedIndependentHistoricalTextFallback}=await import('../src/quality-node-presets.ts')
 const writer=(id:string)=>({...base.nodes[0],id,kind:'text',modelId:'primary-writer',params:[
  {id:'fallback',name:'独立传输备用文本模型',englishName:'transportFallbackModelId',type:'text',required:true,value:'codex-local-vision'},
 ]})
 const workflow=upgradeBoundedIndependentHistoricalTextFallback({...base,schemaVersion:126,nodes:[writer('sanguo-scene-outline'),writer('sanguo-shot-script')]})
 assert.equal(workflow.schemaVersion,127)
 for(const id of ['sanguo-scene-outline','sanguo-shot-script']){
  const node=workflow.nodes.find(item=>item.id===id)!
  assert.equal(node.params.find(param=>param.englishName==='transportFallbackTimeoutMs')?.value,'240000')
  assert.equal(node.params.find(param=>param.englishName==='transportFallbackReasoningEffort')?.value,'medium')
 }
})

test('schema 128 bounds every primary writer transport attempt',async()=>{
 const {upgradeBoundedHistoricalPrimaryAttempts}=await import('../src/quality-node-presets.ts')
 const writer=(id:string)=>({...base.nodes[0],id,kind:'text',modelId:'primary-writer',params:[]})
 const workflow=upgradeBoundedHistoricalPrimaryAttempts({...base,schemaVersion:127,nodes:[writer('sanguo-scene-outline'),writer('sanguo-shot-script')]})
 assert.equal(workflow.schemaVersion,128)
 for(const id of ['sanguo-scene-outline','sanguo-shot-script']){
  const node=workflow.nodes.find(item=>item.id===id)!
  assert.equal(node.params.find(param=>param.englishName==='primaryTransportAttemptTimeoutMs')?.value,'150000')
 }
})

test('schema 129 fits the primary attempt window to observed successful writer latency without overwriting custom limits',async()=>{
 const {upgradeObservedHistoricalPrimaryAttemptWindow}=await import('../src/quality-node-presets.ts')
 const writer=(id:string,value='150000')=>({...base.nodes[0],id,kind:'text',modelId:'primary-writer',params:[
  {id:`${id}-timeout`,name:'主通道单次超时',englishName:'primaryTransportAttemptTimeoutMs',type:'number',required:true,value},
 ]})
 const workflow=upgradeObservedHistoricalPrimaryAttemptWindow({...base,schemaVersion:128,nodes:[writer('sanguo-scene-outline'),writer('sanguo-shot-script')]})
 assert.equal(workflow.schemaVersion,129)
 for(const id of ['sanguo-scene-outline','sanguo-shot-script']){
  const node=workflow.nodes.find(item=>item.id===id)!
  assert.equal(node.params.find(param=>param.englishName==='primaryTransportAttemptTimeoutMs')?.value,'240000')
 }
 const customized=upgradeObservedHistoricalPrimaryAttemptWindow({...base,schemaVersion:128,nodes:[writer('sanguo-scene-outline','180000'),writer('sanguo-shot-script','180000')]})
 assert.equal(customized.schemaVersion,128)
 assert.equal(customized.nodes[0].params[0].value,'180000')
})

test('historical gates report every missing source item without treating dramaturgy exemptions as source evidence',async()=>{
 const {upgradeQualityWorkflow}=await import('../src/quality-node-presets.ts');
 const gate=upgradeQualityWorkflow(base).nodes.find(node=>node.id==='sanguo-scene-outline-accept')!;
 const candidate={scenes:[{id:'scene-01',cast:[]},{id:'scene-07',cast:[]},{id:'scene-09',cast:[]}]};
 const review={passed:false,issues:[{problem:'保留原结论'}],checks:[],
  evidence:[{itemId:'scene-01',citationIndex:1,quote:'二家賓客互相譏揣'}],
  dramaturgyReview:{uncovered:[{itemId:'scene-07',reason:'同场连续短段',coveredBy:'scene-01'}]}};
 const before=structuredClone(review);
 const execute=()=>executeCodeNode({code:gate.code!,params:{candidate,review},context:{historical_sources:{citations:[{content:'二家賓客互相譏揣'}]}}});
 await assert.rejects(execute,error=>{
  assert.match(String(error),/顶层 review\.evidence 缺少逐场史料引证：scene-07、scene-09/);
  assert.match(String(error),/uncovered 仅豁免声画落点，不豁免史料/);
  return true;
 });
 assert.deepEqual(review,before);
 review.evidence=[{itemIds:['scene-01','scene-07','scene-09'],citationIndex:1,quote:'二家賓客互相譏揣'}] as unknown as typeof review.evidence;
 const output=await execute();assert.equal(output.passed,false);assert.equal(output.issues[0].problem,'保留原结论');
 review.evidence[0].quote='二家主人親自授意';
 await assert.rejects(execute,/引文不在对应史料正文/);
});

test('current workflows refresh only marked historical report contracts and preserve editable settings and frozen snapshots',async()=>{
 const {upgradeQualityWorkflow,refreshHistoricalReportContracts}=await import('../src/quality-node-presets.ts');
 const current=upgradeQualityWorkflow(base);
 const oldGate=current.nodes.find(node=>node.id==='sanguo-scene-outline-accept')!;
 const oldReviewer=current.nodes.find(node=>node.id==='sanguo-scene-outline-review')!;
 const old={...current,schemaVersion:115,nodes:[
  {...oldGate,code:oldGate.code!.replace(/const missingSourceEvidence = [\s\S]*?\/\/ SOURCE_SPAN_RESOLUTION_END/,'// SOURCE_SPAN_RESOLUTION_END')
   .replace(/const dramaturgy = cinematic \? \([\s\S]*?\)\(candidate, review.dramaturgyReview\)/,'const dramaturgy = cinematic ? (function oldValidator(){throw Error("old diagnostic");})(candidate, review.dramaturgyReview)')+'\n// user gate suffix'},
  {...oldReviewer,prompt:'user prefix\n【cinematic-v1 叙事审核】old rules【cinematic-v1 叙事审核结束】\nuser suffix'},
  {...oldGate,id:'sanguo-shot-script-accept',code:'return {custom:true};'},
  {...oldReviewer,id:'sanguo-shot-script-review',prompt:'custom review instructions'},
 ]};
 const frozen=structuredClone(old),before=structuredClone(old);
 const refreshed=upgradeQualityWorkflow(old);
 assert.equal(refreshed.schemaVersion,115);
 assert.match(refreshed.nodes[0].code!,/missingSourceEvidence/);
 assert.doesNotMatch(refreshed.nodes[0].code!,/old diagnostic/);
 assert.ok(refreshed.nodes[0].code!.endsWith('// user gate suffix'));
 assert.ok(refreshed.nodes[1].prompt.startsWith('user prefix\n'));
 assert.ok(refreshed.nodes[1].prompt.endsWith('\nuser suffix'));
 assert.doesNotMatch(refreshed.nodes[1].prompt,/old rules/);
 assert.deepEqual(refreshed.nodes.slice(2),old.nodes.slice(2));
 assert.equal(refreshed.nodes[1].modelId,oldReviewer.modelId);
 assert.deepEqual(refreshed.nodes[0].params,oldGate.params);
 assert.deepEqual(refreshed.edges,old.edges);
 assert.deepEqual(old,before);assert.deepEqual(frozen,before);
 assert.equal(refreshHistoricalReportContracts(refreshed),refreshed);
});
// Reconstruct the sparse-media contract before testing an older migration;
// merely changing schemaVersion would leave incompatible schema110 anchors.
function sparseWorkflowFixture(workflow: Parameters<typeof upgradeConfigurableQuality>[0]) {
 const oldObservationGuard="if (!Array.isArray(observations?.frames) || observations.frames.length !== e.frames.length\n  || observations.frames.some((r,i) => r.index !== i || !Array.isArray(r.people) || typeof r.setting !== 'string') || !observations.tailObservation) invalid('逐帧观察不完整');";
 return {...workflow,schemaVersion:109,nodes:workflow.nodes.map(node=>({...node,
  ...(node.code?{code:node.code.replace('return { nativeSequence:samplingPlan.nativeSequence,sampleTimes:','return { sampleTimes:')
   .replace(`const evidenceViews = (${deriveMediaEvidenceViews.toString()})(evidence);\n`,'')
   .replace('return {reviewImageDetail:evidenceViews.reviewImageDetail,','return {')
   .replace('frames:evidenceViews.observerFrames,','frames:evidence.frames.map((url,index)=>({url,index,second:evidence.frameTimes[index]})),')
   .replace(NATIVE_MEDIA_OBSERVATION_GUARD_CODE,oldObservationGuard)
   .replaceAll('!Number.isInteger(index)||index<0||index>=e.frames.length','!observations.frames.some(frame=>frame.index===index)')}:{}),
  params:node.params.filter(param=>!['nativeSequence','nativeSequenceEvidence','maxNativeReviewFrames'].includes(param.englishName||param.name)
   && !(node.id==='sanguo-requirement-review'&&param.englishName==='reviewImageDetail'))
   .map(param=>node.id==='sanguo-media-review'&&param.englishName==='reviewImageDetail'
    ?{...param,value:'{"indices":[0],"columns":2,"rows":2,"overlap":0.25}'}:param)
 }))};
}
test('migration separates generator, observations, inference and bounded gates, preserving configured models and idempotence',()=>{
 const migrated=upgradeIndependentImageReviews(upgradeIndependentScriptReviews(upgradeConfigurableQuality(base)));
 assert.equal(migrated.schemaVersion,62);assert.equal(migrated.nodes.find(n=>n.id==='sanguo-video')?.modelId,'user-model');
 assert.equal(migrated.nodes.find(n=>n.id==='sanguo-video')?.resultVar,'video_take');
 assert.equal(migrated.nodes.find(n=>n.id==='sanguo-shot-script')?.resultVar,'shot_candidate');
 assert.equal(migrated.nodes.find(n=>n.id==='sanguo-shot-script-accept')?.resultVar,'shot_script');
 assert.equal(migrated.nodes.find(n=>n.id==='sanguo-media-review')?.kind,'text');
 assert.ok(migrated.nodes.find(n=>n.id==='loop')!.childIds!.includes('sanguo-media-accept'));
 assert.equal(upgradeIndependentImageReviews(upgradeIndependentScriptReviews(upgradeConfigurableQuality(migrated))),migrated);
 assert.equal(base.schemaVersion,59);
})
const params={durationTolerance:.5,aspectWidth:16,aspectHeight:9,aspectTolerance:.04,minVolumeDb:-50,maxPhoneticErrorRate:.2,tailSeconds:.3,timingTolerance:.25,maxFirstFrameDifference:.1,maxIdleTailSeconds:1.2};

test('schema102 inserts independent requirement checks into the same loop and routes report repair through them',async()=>{
 const {upgradeQualityWorkflow,upgradeIndependentRequirementReview}=await import('../src/quality-node-presets.ts');
 const latest=sparseWorkflowFixture(upgradeQualityWorkflow(base)),newId='sanguo-requirement-review';
 const stale={...latest,schemaVersion:101,nodes:latest.nodes.filter(node=>node.id!==newId).map(node=>({...node,
  ...(node.code?{code:node.code.replace(INDEPENDENT_MEDIA_REVIEW_VIEW_CODE,'const e = context.video_evidence, review = context.media_review, shot = context.shot_script;')
   .replace(REQUIREMENT_REVIEW_METRICS_CODE+'\n','').replace('return {requirementReviewInputs,requirements,','return {requirements,')}:{}),
  ...(node.childIds?{childIds:node.childIds.filter(id=>id!==newId)}:{}),
  ...((node as {errorRetry?:{retryFrom:string}}).errorRetry?.retryFrom===newId?{errorRetry:{...(node as unknown as {errorRetry:Record<string,unknown>}).errorRetry,retryFrom:'sanguo-media-review'}}:{})
 })),edges:latest.edges.filter(edge=>edge.from!==newId).map(edge=>edge.to===newId?{...edge,to:'sanguo-media-review'}:edge)};
 const before=structuredClone(stale),updated=upgradeIndependentRequirementReview(stale);
 const schema102Expected={...latest,schemaVersion:102,nodes:latest.nodes.map(node=>node.id===newId?{...node,params:node.params.filter(param=>param.englishName!=='reviewPolicySource')}:node)};
 assert.deepEqual(updated,schema102Expected);assert.deepEqual(stale,before);assert.equal(upgradeIndependentRequirementReview(updated),updated);
 const newNode=updated.nodes.find(node=>node.id===newId)! as unknown as Record<string,unknown>;
 assert.equal(newNode.modelId,updated.nodes.find(node=>node.id==='sanguo-media-review')!.modelId);
 assert.deepEqual(newNode.mapInput,{sourcePath:'media_metrics.requirementReviewInputs',itemVar:'requirementInput',maxItems:24,concurrency:4});
 assert.equal(updated.nodes.find(node=>node.id==='sanguo-video'),stale.nodes.find(node=>node.id==='sanguo-video'));
 assert.deepEqual(updated.nodes.find(node=>node.id==='loop')!.childIds!.slice(-5),['sanguo-media-observe',newId,'sanguo-media-review','sanguo-media-accept','sanguo-last-frame']);
 const custom={...stale,nodes:stale.nodes.map(node=>node.id==='sanguo-media-accept'?{...node,code:'return userGate(context)'}:node)};
 assert.equal(upgradeIndependentRequirementReview(custom),custom);
});

test('schema99 refreshes the marked coverage gate and complete contract without changing paid nodes or graph', async()=>{
 const {upgradeQualityWorkflow,upgradeBoundMediaRequirements,COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base);
 const stale={...latest,schemaVersion:98,nodes:latest.nodes.map(node=>node.id==='sanguo-media-accept'?{...node,code:node.code!.replace(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE,'// media-defect-evidence-v3\nconst issues=[];const reportRepairPrompt="old unbound coverage";\n// /media-defect-evidence-v3')}:node)};
 const original=structuredClone(stale),updated=upgradeBoundMediaRequirements(stale);
 assert.deepEqual(updated,{...latest,schemaVersion:99});assert.equal(updated.edges,stale.edges);
 assert.equal(updated.nodes.find(node=>node.id==='sanguo-video'),stale.nodes.find(node=>node.id==='sanguo-video'));
 assert.deepEqual(stale,original);assert.equal(upgradeBoundMediaRequirements(updated),updated);
 const custom={...stale,nodes:stale.nodes.map(node=>node.id==='sanguo-media-accept'?{...node,code:'return customRule(context)'}:node)};
 assert.equal(upgradeBoundMediaRequirements(custom),custom);
})

test('schema101 derives bounded sampling before actual evidence and enables ordered observation concurrency',async()=>{
 const {upgradeQualityWorkflow,upgradeRequirementMediaSampling,MEDIA_SAMPLING_REQUEST_CODE,ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE}=await import('../src/quality-node-presets.ts');
 const latest=sparseWorkflowFixture(upgradeQualityWorkflow(base));
 const request=latest.nodes.find(node=>node.id==='sanguo-media-request')!;
 const shot={duration:6,contentContractVersion:'cinematic-v1',audioType:'环境声',audioText:'',videoPrompt:'0-2秒：人物走到案旁。2-6秒：人物坐下。'};
 const output=await executeCodeNode({code:request.code!,params:{maxSamplingFrames:5},context:{shot_script:shot}});
 assert.deepEqual(output.sampleTimes,[0,1,2,4,6]);assert.equal(output.speechRequired,false);
 await assert.rejects(()=>executeCodeNode({code:request.code!,params:{maxSamplingFrames:4},context:{shot_script:shot}}),/MEDIA_SAMPLING_PLAN_INVALID/);
 const stale={...latest,schemaVersion:100,nodes:latest.nodes.map(node=>node===request?{...node,
  code:node.code!.replace(ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE+'\n','').replace(MEDIA_SAMPLING_REQUEST_CODE+'\n','').replace('return { sampleTimes:samplingPlan.sampleTimes,samplingPlan,audioType:shot.audioType,speechRequired,','return { audioType:shot.audioType,speechRequired,'),
  params:node.params.filter(param=>param.englishName!=='maxSamplingFrames')}
  :node.id==='sanguo-video-evidence'?{...node,params:node.params.filter(param=>param.englishName!=='sampleTimes')}
  :node.id==='sanguo-media-observe'?{...node,mapInput:{sourcePath:'media_metrics.frames',itemVar:'frame',maxItems:24}}:node)};
 const updated=upgradeRequirementMediaSampling(stale);
 assert.deepEqual(updated,{...latest,schemaVersion:101,nodes:latest.nodes.map(node=>node===request?{...node,code:node.code!.replace(ADAPTIVE_MEDIA_SAMPLING_REQUEST_CODE,()=>MEDIA_SAMPLING_REQUEST_CODE)}:node)});assert.equal(updated.edges,stale.edges);
 for(const id of ['sanguo-video','sanguo-media-review','sanguo-media-accept'])assert.equal(updated.nodes.find(node=>node.id===id),stale.nodes.find(node=>node.id===id));
 assert.equal(upgradeRequirementMediaSampling(updated),updated);
})

async function context(){
 const shot=JSON.parse(await readFile(new URL('./fixtures/quality-rejected-shot.json',import.meta.url),'utf8'));
 const speech=JSON.parse(await readFile(new URL('./fixtures/quality-rejected-speech.json',import.meta.url),'utf8'));
 const request=await executeCodeNode({code:VIDEO_REQUEST_CODE,context:{shot_script:shot}});
 const review={decision:'accepted',passed:true,issues:[],evidence:[{source:'asr',reference:'4.41–8.47',finding:'含两个短停顿'}],endCharacters:shot.endCharacters,endingState:shot.endCharacters.join('、')+'手持诏书，站位稳定',
 narrativeClosure:{unitId:shot.storyProgress.unitId,complete:false,actionEvidence:'宣诏',responseEvidence:'静听',unresolvedActions:shot.storyProgress.pendingActions,criteriaChecks:shot.completionCriteria.map((criterion:string)=>({criterion,status:'complete',evidence:'画面及音轨'}))},pacingReview:{passed:true,reason:'正常停顿后的语速正常',lastMeaningfulActionSecond:8.47}};
 return {shot_script:shot,media_request:request,media_review:review,media_observations:{frames:[{index:0,setting:'殿内',people:[]}],tailObservation:'二人站立'},video_evidence:{decoded:true,evidenceUrl:'/generated/evidence.json',frames:['/generated/tail.jpg'],lastFrameUrl:'/generated/tail.jpg',duration:9,width:1920,height:1080,hasAudio:true,meanVolumeDb:-18,speechValidation:speech.speechValidation,speechMetrics:speechMetrics(speech.speechValidation.alignment)}};
}
test('real rejected clip 24ms boundary excess is evidence, not an embedded slow-speech veto',async()=>{
 const c=await context();const row=c.video_evidence.speechMetrics[1];assert.equal(row.characters,12);assert.equal(row.shortPauses,2);assert.ok(row.elapsed>12/3.3+.4);assert.ok(row.elapsed<12/3.3+2*.15+.25);
 const accepted=await executeCodeNode({code:MEDIA_ACCEPT_CODE,params,context:c});assert.equal(accepted.passed,true);assert.equal(accepted.technicalValidation.speechVerified,true);
 validateHistoricalMediaReview(accepted.visualReview,c.shot_script);
 c.media_review.passed=false;c.media_review.decision='rejected';c.media_review.issues.push('实际拖腔证据' as never);
 assert.equal((await executeCodeNode({code:MEDIA_ACCEPT_CODE,params,context:c})).passed,false);
})
test('uncertain, contradictory and missing reviewer evidence stops without declaring a quality rejection',async()=>{
 const c=await context();c.media_review.decision='uncertain';await assert.rejects(()=>executeCodeNode({code:MEDIA_ACCEPT_CODE,params,context:c}),/REVIEW_RESULT_INVALID/);
 c.media_review.decision='accepted';c.media_observations.frames=[];await assert.rejects(()=>executeCodeNode({code:MEDIA_ACCEPT_CODE,params,context:c}),/逐帧观察/);
})
test('content review candidate remains separate until validated, and rejects incomplete checks',async()=>{
 const candidate={id:'a',characters:['甲'],audioText:'保留台词'};
 const review={passed:true,issues:[],evidence:[{citationIndex:1}],checks:[{itemId:'a',character:'甲',canExecuteAsWritten:true,finalActionState:'站立',requestedEndState:'站立'}]};
 const accepted=await executeCodeNode({code:SCRIPT_ACCEPT_CODE,params:{candidate,review}});assert.equal(accepted.audioText,candidate.audioText);assert.equal(accepted.contentReview.passed,true);
 review.checks=[];await assert.rejects(()=>executeCodeNode({code:SCRIPT_ACCEPT_CODE,params:{candidate,review}}),/REVIEW_RESULT_INVALID/);
})

test('latest persisted blueprint keeps source quote verification and individual frame maps configurable',async()=>{
 const {upgradeQualityWorkflow}=await import('../src/quality-node-presets.ts');const workflow=upgradeQualityWorkflow(base);
 const observer=workflow.nodes.find(n=>n.id==='sanguo-media-observe')! as unknown as Record<string,unknown>;
 assert.deepEqual(observer.mapInput,{sourcePath:'media_metrics.frames',itemVar:'frame',maxItems:24,concurrency:4});
 assert.equal((workflow.nodes.find(n=>n.id==='sanguo-media-accept') as unknown as {errorRetry:{retryFrom:string}}).errorRetry.retryFrom,'sanguo-media-request');
 const gate=workflow.nodes.find(n=>n.id==='sanguo-shot-script-accept')! as unknown as {code:string};
 const candidate={id:'a',characters:['甲']};const review={passed:true,issues:[],evidence:[{itemId:'a',citationIndex:1,quote:'真实引文'}],checks:[{itemId:'a',character:'甲',canExecuteAsWritten:true,finalActionState:'站立',requestedEndState:'站立'}]};
 const accepted=await executeCodeNode({code:gate.code,params:{candidate,review},context:{historical_sources:{citations:[{content:'原文包含真实引文。'}]}}});assert.equal(accepted.passed,true);
 review.evidence[0].quote='虚构引文';await assert.rejects(()=>executeCodeNode({code:gate.code,params:{candidate,review},context:{historical_sources:{citations:[{content:'原文包含真实引文。'}]}}}),/引文不在/);
})

test('configured tail timing accepts sub-frame rounding and rejects genuinely long idle tails',async()=>{
 const {TAIL_TIMING_CODE}=await import('../src/quality-node-presets.ts');
 const code='const evidence=context.evidence,policy=params;'+TAIL_TIMING_CODE+'return tailTiming;';
 const policy={tailSeconds:.3,timingToleranceSeconds:.25,maxIdleTailSeconds:1.2};
 const check=(duration:number,end:number)=>executeCodeNode({code,params:policy,context:{evidence:{duration,speechValidation:{lastSpeechEnd:end}}}});
 assert.equal((await check(8.96,8.6)).assessment,'within-allowance');
 assert.equal((await check(9,6)).assessment,'outside-allowance');
 assert.equal((await check(9,8.99)).assessment,'outside-allowance');
})

test('accepted configured gate preserves generation references and publishes its own speech decision for downstream continuity',async()=>{
 const {upgradeQualityWorkflow,COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE,SCOPED_MEDIA_DEFECT_EVIDENCE_CODE}=await import('../src/quality-node-presets.ts');
 // This recorded one-frame fixture tests the pre-coverage speech/reference contract.
 const current=upgradeQualityWorkflow(base);
 const workflow={...current,nodes:current.nodes.map(node=>node.code?{...node,code:node.code.replace(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE,SCOPED_MEDIA_DEFECT_EVIDENCE_CODE).replace(INDEPENDENT_MEDIA_REVIEW_VIEW_CODE,'const e = context.video_evidence, review = context.media_review, shot = context.shot_script;').replace(REQUIREMENT_REVIEW_METRICS_CODE,'').replace('requirementReviewInputs,requirements,','requirements,')}:node)}; const c=await context();
 const metric=workflow.nodes.find(n=>n.id==='sanguo-media-metrics')! as unknown as {code:string};
 const gate=workflow.nodes.find(n=>n.id==='sanguo-media-accept')! as unknown as {code:string};
 const evidence={...c.video_evidence,frameTimes:[8.92],speechValidation:{...c.video_evidence.speechValidation,passed:false}};
 const metrics=await executeCodeNode({code:metric.code,params:{minSpeechRate:3.3,shortPauseSeconds:.15,sentencePauseSeconds:.25,timingToleranceSeconds:.25,tailSeconds:.3,maxIdleTailSeconds:1.2},context:{...c,video_evidence:evidence}});
 const review={...c.media_review,tailTimingCheck:{assessment:metrics.tailTiming.assessment,reason:'使用已计算区间'},speechChecks:metrics.speech.map((r:{text:string})=>({text:r.text,assessment:'natural',reason:'实际跨度在含停顿预算内'})),visualChecks:c.shot_script.characters.map((character:string)=>({character,consistent:true,expectedObjects:'按分镜',actualObjectsByFrame:[{index:0,objects:'按分镜'}],evidence:'具名实际观察'}))};
 const output=await executeCodeNode({code:gate.code,params:{...params,maxRepairChars:350},context:{...c,video_evidence:evidence,media_metrics:metrics,media_review:review,video_take:{params:{referenceImage:'/generated/prior.jpg'}}}});
 assert.equal(output.passed,true);assert.equal(output.params.referenceImage,'/generated/prior.jpg');assert.equal(output.speechValidation.passed,true);assert.equal(output.speechValidation.acceptanceSource,'configured-gate');
})

test('source orthography migration handles branch-wrapped gates without accepting invented or wrong-source quotes', async()=>{
 const {upgradeQualityWorkflow,upgradeSourceOrthography}=await import('../src/quality-node-presets.ts');
 const workflow=upgradeQualityWorkflow(base);
 const gate=workflow.nodes.find(n=>n.id==='sanguo-scene-outline-accept')! as unknown as {code:string};
 const candidate={scenes:[{id:'scene-02',cast:[]}]};
 const review={passed:false,issues:[{problem:'保留真实内容问题'}],checks:[],evidence:[{itemId:'scene-02',citationIndex:2,quote:'时同郡河南尹房植有名当朝'}]};
 const context={historical_sources:{citations:[{content:'另一篇史料正文'}, {content:'時同郡河南尹房植有名當朝，鄉人爲之謠曰。'}]}};
 const run=()=>executeCodeNode({code:gate.code,params:{candidate,review},context});
 const accepted=await run();assert.equal(accepted.passed,false);assert.equal(accepted.issues[0].problem,'保留真实内容问题');
 review.evidence[0].quote='时同郡河南尹周福有名当朝';await assert.rejects(run,/引文不在/);
 review.evidence[0].quote='时同郡河南尹房植有名当朝';review.evidence[0].citationIndex=1;await assert.rejects(run,/引文不在/);
 assert.equal(upgradeSourceOrthography(workflow),workflow);
 const legacy={...base,schemaVersion:72,nodes:[{...workflow.nodes.find(n=>n.id==='sanguo-scene-outline-accept')!,code:'try {\n'+gate.code.replace(/const sourceCharacterMap=.*;\n/,'').replace("[...String(value||'')].map(c=>sourceCharacterMap[c]||c).join('')","String(value||'')")+'\n} catch(e) {return {routeError:e.message}}'}]};
 const migrated=upgradeSourceOrthography(legacy);review.evidence[0].citationIndex=2;
 const output=await executeCodeNode({code:migrated.nodes[0].code!,params:{candidate,review},context});
 assert.equal(output.routeError,undefined);assert.equal(output.passed,false);
});

test('a supported rejection routes to candidate repair without inventing checks for props; acceptance stays strict',async()=>{
 const {upgradeQualityWorkflow}=await import('../src/quality-node-presets.ts');
 const gate=upgradeQualityWorkflow(base).nodes.find(n=>n.id==='sanguo-scene-outline-accept')! as unknown as {code:string};
 const candidate={scenes:[{id:'scene-10',cast:['史官','卷宗']}]};
 const review={passed:false,issues:[{itemId:'scene-10',problem:'卷宗被列为人物',repair:'从cast移到道具'}],evidence:[{itemId:'scene-10',citationIndex:1,quote:'党人之议自此始矣'}],checks:[{itemId:'scene-10',character:'史官',canExecuteAsWritten:true,finalActionState:'写毕',requestedEndState:'写毕'}]};
 const run=()=>executeCodeNode({code:gate.code,params:{candidate,review},context:{historical_sources:{citations:[{content:'黨人之議，自此始矣。'}]}}});
 const rejected=await run();assert.equal(rejected.passed,false);assert.equal(rejected.repairContext.issues[0].repair,'从cast移到道具');
 review.passed=true;review.issues=[];await assert.rejects(run,/scene-10 \/ 卷宗/);
 review.passed=false;await assert.rejects(run,/未给出局部修复问题/);
});

test('already migrated image branches skip with cached assets while custom conditions are preserved',async()=>{
 const {upgradeConditionalReviewBranches}=await import('../src/quality-node-presets.ts');
 const gate={...base.nodes[0],id:'gate',runIf:{path:'lookup.shouldGenerate',equals:true}};
 const legacy={...base,schemaVersion:75,nodes:[gate,{...gate,id:'gate-error-branch',kind:'branch',runIf:undefined},{...gate,id:'gate-accept-branch',kind:'branch',runIf:undefined},{...gate,id:'custom',kind:'branch',runIf:{path:'custom',equals:true}}]};
 const updated=upgradeConditionalReviewBranches(legacy);
 assert.deepEqual(updated.nodes[1].runIf,gate.runIf);assert.deepEqual(updated.nodes[2].runIf,gate.runIf);
 assert.deepEqual(updated.nodes[3].runIf,{path:'custom',equals:true});assert.equal(upgradeConditionalReviewBranches(updated),updated);
});

test('audience-first outline upgrade changes only the existing outline prompt and preserves routing and configured models', async()=>{
 const {upgradeAudienceSceneOutline,upgradeQualityWorkflow}=await import('../src/quality-node-presets.ts');
 const {SANGUO_SCENE_OUTLINE_PROMPT}=await import('../src/scene-outline-prompt.ts');
 const latest=upgradeQualityWorkflow(base);
 const previous={...latest,schemaVersion:76,nodes:latest.nodes.map(n=>n.id==='sanguo-scene-outline'?{...n,prompt:'old',modelId:'user-configured-model'}:n)};
 const updated=upgradeAudienceSceneOutline(previous);
 assert.equal(updated.nodes.length,previous.nodes.length);assert.equal(updated.edges,previous.edges);
 for(let i=0;i<updated.nodes.length;i++){
  const before=previous.nodes[i],after=updated.nodes[i];
  if(before.id==='sanguo-scene-outline'){assert.deepEqual(after,{...before,prompt:SANGUO_SCENE_OUTLINE_PROMPT});}
  else assert.equal(after,before);
 }
 assert.equal(upgradeAudienceSceneOutline(updated),updated);
 const unrelated={...previous,id:'another-workflow'};assert.equal(upgradeAudienceSceneOutline(unrelated),unrelated);
});

test('schema83 rewrites only reviewer prompt and embedded gate text, leaving budgets and routing alone',async()=>{
 const {upgradeQualityWorkflow,upgradeDramaturgyCoverageChannels}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base);
 assert.equal(latest.schemaVersion,113);
 const reviewers=['sanguo-scene-outline-review','sanguo-shot-script-review'],gates=['sanguo-scene-outline-accept','sanguo-shot-script-accept'];
 const stale={...latest,schemaVersion:82,nodes:latest.nodes.map(node=>{
  if(reviewers.includes(node.id))return {...node,prompt:node.prompt.replace('【cinematic-v1 叙事审核】','【cinematic-v1 叙事审核】\n旧规则占位')};
  if(gates.includes(node.id)&&node.code)return {...node,code:node.code.replace('const cited = new Set','const citedLegacy = new Set')};
  return node;
 })};
 assert.ok(stale.nodes.find(node=>node.id==='sanguo-scene-outline-review')!.prompt.includes('旧规则占位'));
 assert.ok(stale.nodes.find(node=>node.id==='sanguo-scene-outline-accept')!.code!.includes('citedLegacy'));
 const updated=upgradeDramaturgyCoverageChannels(stale);
 assert.equal(updated.schemaVersion,83);assert.equal(updated.edges,stale.edges);assert.equal(updated.nodes.length,stale.nodes.length);
 for(let index=0;index<updated.nodes.length;index++){
  const before=stale.nodes[index],after=updated.nodes[index] as unknown as Record<string,unknown>;
  if(reviewers.includes(before.id)){
   assert.ok(before.prompt.includes('旧规则占位'));assert.ok(!String(after.prompt).includes('旧规则占位'),'失效口径必须被替掉');
   assert.ok(String(after.prompt).includes('uncovered:[{itemId,reason,coveredBy}]'));
   assert.equal(after.modelId,before.modelId);assert.equal(after.kind,before.kind);assert.deepEqual(after.params,before.params);
  } else if(gates.includes(before.id)&&before.code){
   assert.ok(!String(after.code).includes('citedLegacy'));
   assert.ok(String(after.code).includes('uncovered 免证只适用于多场大纲'));
   assert.deepEqual(after.errorRetry,before.errorRetry,'分支预算不变');assert.equal(after.maxAttempts,undefined);
   assert.equal(after.resultVar,before.resultVar);assert.equal(after.kind,before.kind);
  } else assert.equal(after,before,'其他节点零改动');
 }
 assert.equal(upgradeDramaturgyCoverageChannels(updated),updated);
 const unrelated={...stale,id:'another-workflow'};assert.equal(upgradeDramaturgyCoverageChannels(unrelated),unrelated);
});

test('schema84 appends the fiction-boundary rules to reviewers only, preserving custom text and other nodes',async()=>{
 const {upgradeQualityWorkflow,upgradeFictionBoundaryReviewRules,refreshFictionBoundaryReviewPrompt,FICTION_BOUNDARY_REVIEW_PROMPT}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base);
 assert.equal(latest.nodes.filter(node=>node.id==='sanguo-scene-outline-review').length,1);
 for(const node of latest.nodes.filter(node=>['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(node.id))){
  assert.ok(node.prompt.includes(FICTION_BOUNDARY_REVIEW_PROMPT));
  assert.equal(node.prompt.split('【拟制边界与修复建议规则 v1】').length,2,'不得重复追加');
 }
 // A stale reviewer keeps its own rules and only gains the bounded block once.
 const stale={...latest,schemaVersion:83,nodes:latest.nodes.map(node=>node.id==='sanguo-scene-outline-review'
  ? {...node,prompt:'用户自定义审稿规则\n'+node.prompt.replace(FICTION_BOUNDARY_REVIEW_PROMPT,'')}
  : node)};
 const updated=upgradeFictionBoundaryReviewRules(stale);
 assert.equal(updated.schemaVersion,84);assert.equal(updated.edges,stale.edges);assert.equal(updated.nodes.length,stale.nodes.length);
 const reviewers=['sanguo-scene-outline-review','sanguo-shot-script-review'];
 for(let index=0;index<updated.nodes.length;index++){
  const before=stale.nodes[index],after=updated.nodes[index];
  if(before.id==='sanguo-scene-outline-review'){
   assert.ok(after.prompt.startsWith('用户自定义审稿规则\n'),'只追加标记块');
   assert.ok(after.prompt.includes(FICTION_BOUNDARY_REVIEW_PROMPT));
   assert.deepEqual(after.params,before.params);assert.equal(after.modelId,before.modelId);
  } else if(reviewers.includes(before.id)){
   assert.equal(after.prompt,before.prompt,'已带最新块的审稿人不被重写');
  } else assert.equal(after,before,'其他节点零改动');
 }
 assert.equal(upgradeFictionBoundaryReviewRules(updated),updated);
 const current={...latest,schemaVersion:84};assert.equal(upgradeFictionBoundaryReviewRules(current),current);
 const other={...base,id:'another-workflow',schemaVersion:83};assert.equal(upgradeFictionBoundaryReviewRules(other),other);
 // The block is delimited, so refreshing the other reviewer blocks cannot mistake it for their own.
 assert.equal(refreshFictionBoundaryReviewPrompt('无标记的自定义审稿提示词'),'无标记的自定义审稿提示词\n'+FICTION_BOUNDARY_REVIEW_PROMPT);
 assert.throws(()=>refreshFictionBoundaryReviewPrompt('【拟制边界与修复建议规则 v1】半截块'),/incomplete fiction-boundary/);
 assert.equal(refreshFictionBoundaryReviewPrompt(FICTION_BOUNDARY_REVIEW_PROMPT),FICTION_BOUNDARY_REVIEW_PROMPT);
});

test('schema85 raises only the shipped report-format budget and re-embeds the corrected gate validator',async()=>{
 const {upgradeQualityWorkflow,upgradeReviewReportRecoveryBudget}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base);
 const node=latest.nodes[0];
 const branch=(id:string,value:string,patterns:string|null)=>({ ...node,id,kind:'branch',code:'x',
  params:[{id:id+'-limit',name:'maxAttempts',englishName:'maxAttempts',type:'number',required:true,value},
   ...(patterns?[{id:id+'-patterns',name:'patterns',englishName:'patterns',type:'json',required:true,value:patterns}]:[])]});
 const withBranches={...latest,schemaVersion:84,nodes:[...latest.nodes.map(gate=>gate.id==='sanguo-scene-outline-accept'&&gate.code
   ? {...gate,code:gate.code.replace('const cited = new Set','const citedLegacy = new Set')}:gate),
  branch('sanguo-scene-outline-accept-error-branch','2','["REVIEW_RESULT_INVALID:"]'),
  branch('sanguo-shot-script-accept-error-branch','2','["REVIEW_RESULT_INVALID:"]'),
  branch('sanguo-scene-loop-branch','2',null),
  branch('sanguo-media-accept-error-branch','6','["REVIEW_RESULT_INVALID:"]')]};
 const updated=upgradeReviewReportRecoveryBudget(withBranches);
 assert.equal(updated.schemaVersion,85);assert.equal(updated.edges,withBranches.edges);
 const gate=updated.nodes.find(item=>item.id==='sanguo-scene-outline-accept')!;
 assert.ok(!gate.code!.includes('citedLegacy'));
 assert.ok(gate.code!.includes('normalizeLocator'),'验收门必须内嵌可自我修正定位的报告校验器');
 assert.equal(updated.nodes.find(item=>item.id==='sanguo-scene-outline-accept-error-branch')!.params[0].value,'4');
 assert.equal(updated.nodes.find(item=>item.id==='sanguo-shot-script-accept-error-branch')!.params[0].value,'4');
 assert.equal(updated.nodes.find(item=>item.id==='sanguo-scene-loop-branch')!.params[0].value,'2','非报告类分支预算不动');
 assert.equal(updated.nodes.find(item=>item.id==='sanguo-media-accept-error-branch')!.params[0].value,'6','手工调过的预算不被覆盖');
 assert.equal(upgradeReviewReportRecoveryBudget(updated),updated);
 const other={...base,id:'another-workflow',schemaVersion:84};assert.equal(upgradeReviewReportRecoveryBudget(other),other);
});

test('schema86 only rewrites the dramaturgy block of the two reviewers, keeping custom rules and everything else',async()=>{
 const {upgradeQualityWorkflow,upgradeReviewerCoverageChecklist}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base);
 const reviewers=['sanguo-scene-outline-review','sanguo-shot-script-review'];
 const shipped=latest.nodes.filter(node=>reviewers.includes(node.id));
 assert.equal(shipped.length,2);assert.ok(shipped.every(node=>node.prompt.includes('一条先服务一场')),'出厂审稿口径必须教审稿人按场次顺序逐场落证据');
 const stale={...latest,schemaVersion:85,nodes:latest.nodes.map(node=>reviewers.includes(node.id)
  ? {...node,prompt:'用户自定义审稿规则\n'+node.prompt.replace(/【cinematic-v1 叙事审核】[\s\S]*?【cinematic-v1 叙事审核结束】/,'【cinematic-v1 叙事审核】旧口径只能逐场凭记忆补\n【cinematic-v1 叙事审核结束】')}
  : node)};
 assert.ok(!stale.nodes.find(node=>node.id==='sanguo-scene-outline-review')!.prompt.includes('一条先服务一场'));
 const updated=upgradeReviewerCoverageChecklist(stale);
 assert.equal(updated.schemaVersion,86);assert.equal(updated.edges,stale.edges);assert.equal(updated.nodes.length,stale.nodes.length);
 for(let index=0;index<updated.nodes.length;index+=1){
  const before=stale.nodes[index],after=updated.nodes[index];
  if(reviewers.includes(before.id)){
   assert.ok(after.prompt.startsWith('用户自定义审稿规则\n'),'块外自定义文字不动');
   assert.ok(after.prompt.includes('一条先服务一场'));assert.ok(!after.prompt.includes('旧口径'),'旧口径必须被替掉');
   assert.equal(after.prompt.split('【cinematic-v1 叙事审核】').length-1,1,'标记块不得重复追加');
   assert.deepEqual(after.params,before.params);assert.equal(after.modelId,before.modelId);assert.equal(after.kind,before.kind);
  } else assert.equal(after,before,'其他节点零改动');
 }
 assert.equal(upgradeReviewerCoverageChecklist(updated),updated);
 const other={...base,id:'another-workflow',schemaVersion:85};assert.equal(upgradeReviewerCoverageChecklist(other),other);
});

// The deployed gate carries its own copy of the report validator, so fixing citation grounding only
// reaches production through the re-embedding upgrade — the route schemas 82/83/85 already used.
test('schema87 re-embeds the citation gate in both accept nodes and leaves every other node alone',async()=>{
 const {upgradeQualityWorkflow,upgradeDramaturgyQuoteTypography}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base);
 const gates=['sanguo-scene-outline-accept','sanguo-shot-script-accept'];
 assert.ok(gates.every(id=>latest.nodes.find(node=>node.id===id)!.code!.includes("normalize('NFKC')")),'出厂门里必须带上折叠标点的引文比对');
 const stale={...latest,schemaVersion:86,nodes:latest.nodes.map(node=>gates.includes(node.id)&&node.code
  ? {...node,code:node.code.replace('const cited = new Set','const citedLegacy = new Set').replace('normalize(\'NFKC\')','')}
  : node)};
 assert.ok(stale.nodes.find(node=>node.id==='sanguo-scene-outline-accept')!.code!.includes('citedLegacy'));
 const updated=upgradeDramaturgyQuoteTypography(stale);
 assert.equal(updated.schemaVersion,87);assert.equal(updated.edges,stale.edges);assert.equal(updated.nodes.length,stale.nodes.length);
 for(let index=0;index<updated.nodes.length;index+=1){
  const before=stale.nodes[index],after=updated.nodes[index] as unknown as Record<string,unknown>;
  if(gates.includes(before.id)&&before.code){
   assert.ok(!String(after.code).includes('citedLegacy'),'旧副本必须被整体替掉');
   assert.ok(String(after.code).includes("normalize('NFKC')"),'全/半角标点不得再烧一次付费审稿');
   assert.ok(String(after.code).includes('该处实际原文是'),'驳回必须点名两边原文');
   assert.deepEqual(after.errorRetry,before.errorRetry);assert.equal(after.resultVar,before.resultVar);assert.equal(after.kind,before.kind);
  } else assert.equal(after,before,'其他节点零改动');
 }
 assert.equal(upgradeDramaturgyQuoteTypography(updated),updated);
 const other={...base,id:'another-workflow',schemaVersion:86};assert.equal(upgradeDramaturgyQuoteTypography(other),other);
});

// Same route as schemas 80/81/87: the gate carries its own copy of the agency guard, so a fix that
// only lands in src/history-content-guards.ts never reaches a run. record-vrwgoy scanned
// requiredBeats[].function while quoting nothing, and the writer repeated the same sentence four times.
test('schema88 re-embeds the agency guard that names the offending field, touching only the two gates',async()=>{
 const {upgradeQualityWorkflow,upgradeHistoricalAgencySourceCitation}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base);
 const gates=['sanguo-scene-outline-accept','sanguo-shot-script-accept'];
 assert.ok(gates.every(id=>latest.nodes.find(node=>node.id===id)!.code!.includes('触发原文')),'出厂门里的史料主体驳回必须点名触发字段');
 const stale={...latest,schemaVersion:87,nodes:latest.nodes.map(node=>gates.includes(node.id)&&node.code
  ? {...node,code:node.code.replace('const fragments','const fragmentsLegacy')}
  : node)};
 assert.ok(stale.nodes.find(node=>node.id==='sanguo-scene-outline-accept')!.code!.includes('fragmentsLegacy'));
 const updated=upgradeHistoricalAgencySourceCitation(stale);
 assert.equal(updated.schemaVersion,88);assert.equal(updated.edges,stale.edges);assert.equal(updated.nodes.length,stale.nodes.length);
 for(let index=0;index<updated.nodes.length;index+=1){
  const before=stale.nodes[index],after=updated.nodes[index] as unknown as Record<string,unknown>;
  if(gates.includes(before.id)&&before.code){
   assert.ok(!String(after.code).includes('fragmentsLegacy'),'旧副本必须被整体替掉');
   assert.ok(String(after.code).includes('触发原文'),'驳回必须点名 path 与原句');
   assert.ok(String(after.code).includes('只改写被点名句子里的行动主体'),'点名必须同时给出改写边界');
   assert.deepEqual(after.errorRetry,before.errorRetry,'分支预算不变');assert.equal(after.resultVar,before.resultVar);assert.equal(after.kind,before.kind);
  } else assert.equal(after,before,'其他节点零改动');
 }
 assert.equal(upgradeHistoricalAgencySourceCitation(updated),updated);
 const other={...base,id:'another-workflow',schemaVersion:87};assert.equal(upgradeHistoricalAgencySourceCitation(other),other);
});

// record-5i523a 重拍了一整条 14 秒素材，只为台词结束后多出的 0.6 秒空镜；重拍改不动台词结束时刻，
// 而 maxAttempts=4 意味着同一缺陷会被反复付费。schema89 把这类尾部空等派生成剪辑裁切点。
test('schema89 installation now proposes a local edit without accepting an unedited clip',async()=>{
 const {upgradeQualityWorkflow,upgradeIdleTailEditDecision,IDLE_TAIL_EDIT_CODE,IDLE_TAIL_FINAL_DECISION_CODE}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base);
 const gate=latest.nodes.find(node=>node.id==='sanguo-media-accept')!;
 const currentReviewer=latest.nodes.find(node=>node.id==='sanguo-media-review')!;
 const reviewer={...currentReviewer,prompt:'禁止擅自建立更严格的阈值。尾部空等属于剪辑裁尾缺陷：逐句都在程序派生 allowedSpan 内时，只写进 pacingReview 与 tailTimingCheck，不要把同一件事重复列进 issues 来要求重拍整镜。'};
 assert.ok(gate.code!.includes('pendingMediaEdit'),'出厂门必须把尾部空等派生成待实施剪辑');
 assert.ok(gate.code!.includes('warnings, tailTrim, technicalValidation'),'裁尾结论必须随成片证据一起发布');
 assert.ok(reviewer.prompt.includes('不要把同一件事重复列进 issues'),'审稿提示必须停止把空等重复写成重拍理由');
 const staleGate={...gate,code:gate.code!.replace(IDLE_TAIL_EDIT_CODE.trim(),
   "if (!pacing.passed || e.duration - pacing.lastMeaningfulActionSecond > params.maxIdleTailSeconds) issues.push('节奏未通过或尾部空等');")
   .replace(IDLE_TAIL_FINAL_DECISION_CODE,'const passed = review.passed && issues.length === 0;')
   .replace('warnings, tailTrim, technicalValidation: {passed,','technicalValidation: {passed,')};
 assert.ok(!staleGate.code!.includes('pendingMediaEdit'),'还原后的旧门必须真的没有新规则');
 const staleReviewer={...reviewer,prompt:reviewer.prompt.replace(/尾部空等属于剪辑裁尾缺陷[^\n]*/,'')};
 const stale={...latest,schemaVersion:88,nodes:latest.nodes.map(node=>node.id===gate.id?staleGate:node.id===reviewer.id?staleReviewer:node)};
 const updated=upgradeIdleTailEditDecision(stale);
 assert.equal(updated.schemaVersion,89);assert.equal(updated.edges,stale.edges);assert.equal(updated.nodes.length,stale.nodes.length);
 for(let index=0;index<updated.nodes.length;index+=1){
  const before=stale.nodes[index],after=updated.nodes[index] as unknown as Record<string,unknown>;
  if(before.id===gate.id){
   assert.equal(after.code,gate.code,'升级结果必须逐字回到出厂门，不留双份空等规则');
   assert.deepEqual(after.acceptance,before.acceptance,'重拍预算与回退节点不变，其他缺陷照旧重拍');
   assert.equal(after.resultVar,before.resultVar);assert.equal(after.kind,before.kind);
  }
  else if(before.id===reviewer.id)assert.equal(after.prompt,reviewer.prompt);
  else assert.equal(after,before,'其他节点零改动');
 }
 assert.equal(upgradeIdleTailEditDecision(updated),updated);
 const handEdited={...latest,schemaVersion:88,nodes:latest.nodes.map(node=>node.id===gate.id
  ? {...node,code:node.code!.replace(IDLE_TAIL_EDIT_CODE.trim(),'const userPacingRule = issues.length > 0;')}
  : node)};
 assert.equal(upgradeIdleTailEditDecision(handEdited),handEdited,'用户换掉这条规则的门不得声称自己已升级到 89');
 const other={...base,id:'another-workflow',schemaVersion:88};assert.equal(upgradeIdleTailEditDecision(other),other);
});

test('schema90 retains unknown observation reasons in the persisted gate without changing custom rules or review nodes',async()=>{
 const {upgradeQualityWorkflow,upgradeUnknownWorldStateEvidence,CINEMATIC_WORLD_FACT_GUARD_CODE}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base),gate=latest.nodes.find(node=>node.id==='sanguo-media-accept')!;
 const oldGuard="if(!fact||!['observed','unknown'].includes(fact.status)||(fact.status==='observed'&&(!fact.value?.trim()||!fact.evidence?.trim()))||(fact.status==='unknown'&&(fact.value||fact.evidence)))invalid('实际尾帧状态必须有采证或明确unknown');";
 assert.ok(gate.code!.includes(CINEMATIC_WORLD_FACT_GUARD_CODE));
 const stale={...latest,schemaVersion:89,nodes:latest.nodes.map(node=>node===gate?{...node,
  code:'// user gate prefix\n'+node.code!.replace(CINEMATIC_WORLD_FACT_GUARD_CODE,oldGuard)+'\n// user gate suffix'}:node)};
 const updated=upgradeUnknownWorldStateEvidence(stale);
 assert.equal(updated.schemaVersion,90);assert.equal(updated.edges,stale.edges);
 for(let index=0;index<stale.nodes.length;index+=1){
  const before=stale.nodes[index],after=updated.nodes[index];
  if(before.id===gate.id){
   assert.equal(after.code,'// user gate prefix\n'+gate.code+'\n// user gate suffix');
   assert.deepEqual({...after,code:before.code},before,'只有目标判定行可更新');
  }else assert.equal(after,before,'观察与审核提示词以及全部其他节点不变');
 }
 assert.equal(upgradeUnknownWorldStateEvidence(updated),updated);
 const custom={...stale,nodes:stale.nodes.map(node=>node.id===gate.id?{...node,code:node.code!.replace(oldGuard,'customWorldStateRule(fact);')}:node)};
 assert.equal(upgradeUnknownWorldStateEvidence(custom),custom,'自定义门无法安全定位时保留原schema');
 const other={...stale,id:'custom-workflow'};assert.equal(upgradeUnknownWorldStateEvidence(other),other);
});

test('schema92 replaces only the shipped premature acceptance pair and preserves custom code and retry branches',async()=>{
 const {upgradeQualityWorkflow,upgradePendingMediaEditGate,IDLE_TAIL_EDIT_CODE,IDLE_TAIL_FINAL_DECISION_CODE,LEGACY_IDLE_TAIL_EDIT_CODE}=await import('../src/quality-node-presets.ts');
 const latest=upgradeQualityWorkflow(base),gate=latest.nodes.find(node=>node.id==='sanguo-media-accept')!;
 const oldDecision='const passed = (review.passed || trimmableIdleTail) && issues.length === 0;';
 assert.ok(gate.code!.includes('MEDIA_EDIT_REQUIRED:'));assert.ok(!gate.code!.includes('tailOnlyComplaint'));
 const stale={...latest,schemaVersion:91,nodes:latest.nodes.map(node=>node===gate?{...node,code:'// user prefix\n'+node.code!
  .replace(IDLE_TAIL_EDIT_CODE.trim(),LEGACY_IDLE_TAIL_EDIT_CODE.trim()).replace(IDLE_TAIL_FINAL_DECISION_CODE,oldDecision)+'\n// user suffix'}:node)};
 const updated=upgradePendingMediaEditGate(stale);
 assert.equal(updated.schemaVersion,92);assert.equal(updated.edges,stale.edges);
 for(let index=0;index<stale.nodes.length;index+=1){
  const before=stale.nodes[index],after=updated.nodes[index];
  if(before.id===gate.id){
   assert.equal(after.code,'// user prefix\n'+gate.code+'\n// user suffix');
   assert.deepEqual({...after,code:before.code},before,'只更新验收代码，所有回退预算不变');
  }else assert.equal(after,before);
 }
 assert.equal(upgradePendingMediaEditGate(updated),updated);
 for(const fragment of [LEGACY_IDLE_TAIL_EDIT_CODE.trim(),oldDecision]){
  const custom={...stale,nodes:stale.nodes.map(node=>node.id===gate.id?{...node,code:node.code!.replace(fragment,'customRule();')}:node)};
  assert.equal(upgradePendingMediaEditGate(custom),custom,'无法同时定位原成对规则时保持自定义门');
 }
 const other={...stale,id:'another-workflow'};assert.equal(upgradePendingMediaEditGate(other),other);
});

test('schema93 binds refusals and repair feedback without replacing custom gate logic, prompts or budgets',async()=>{
 const {upgradeQualityWorkflow,upgradeConfirmedMediaDefects,MEDIA_DEFECT_EVIDENCE_CODE,SCOPED_MEDIA_DEFECT_EVIDENCE_CODE,COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE}=await import('../src/quality-node-presets.ts');
 const {MEDIA_DEFECT_EVIDENCE_PROMPT}=await import('../src/media-defect-evidence.ts');
 const current=upgradeQualityWorkflow(base);
 const latest={...current,nodes:current.nodes.map(node=>node.id==='sanguo-media-accept'?{...node,code:node.code!.replace(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE,MEDIA_DEFECT_EVIDENCE_CODE).replace(SCOPED_MEDIA_DEFECT_EVIDENCE_CODE,MEDIA_DEFECT_EVIDENCE_CODE)}:node)};
 const gate=latest.nodes.find(node=>node.id==='sanguo-media-accept')!;
 const legacy="const issues = [...review.issues, ...review.visualChecks.filter(c=>!c.consistent).map(c=>c.character+'道具不符：'+c.evidence)];";
 const stale={...latest,schemaVersion:92,nodes:latest.nodes.map(node=>node===gate?{...node,code:'// user prefix\n'+node.code!
  .replace(MEDIA_DEFECT_EVIDENCE_CODE,legacy)
  .replace('!reportRepairPrompt?.trim() || reportRepairPrompt.length > params.maxRepairChars','!review.retryPrompt?.trim() || review.retryPrompt.length > params.maxRepairChars')
  .replace('retryPrompt: reportRepairPrompt','retryPrompt: review.retryPrompt')+'\n// user suffix'}
  :node.id==='sanguo-media-review'?{...node,prompt:'user prompt\n'+node.prompt.replace(MEDIA_DEFECT_EVIDENCE_PROMPT,'')}:node)};
 const updated=upgradeConfirmedMediaDefects(stale);
 assert.equal(updated.schemaVersion,93);assert.equal(updated.edges,stale.edges);
 for(let index=0;index<stale.nodes.length;index+=1){
  const before=stale.nodes[index],after=updated.nodes[index];
  if(before.id===gate.id){
   assert.equal(after.code,'// user prefix\n'+gate.code+'\n// user suffix');
   assert.deepEqual({...after,code:before.code},before);
  }else if(before.id==='sanguo-media-review'){
   assert.ok(after.prompt.startsWith('user prompt\n'));assert.ok(after.prompt.includes('允许第一帧已经成立'));
   assert.deepEqual({...after,prompt:before.prompt},before);
  }else assert.equal(after,before);
 }
 assert.equal(upgradeConfirmedMediaDefects(updated),updated);
 const custom={...stale,nodes:stale.nodes.map(node=>node.id===gate.id?{...node,code:node.code!.replace(legacy,'userOwnDefectAssembly();')}:node)};
 assert.equal(upgradeConfirmedMediaDefects(custom),custom,'用户替换过原缺陷组装逻辑的门不被覆盖');
 const other={...stale,id:'another-workflow'};assert.equal(upgradeConfirmedMediaDefects(other),other);
});

test('schema91 publishes neutral observations and normalized review input without resetting generation or custom prompts',async()=>{
 const {upgradeQualityWorkflow,upgradeGroundedMediaObservation,FRAME_OBSERVATION_PROMPT}=await import('../src/quality-node-presets.ts');
 const {GROUNDED_FRAME_OBSERVATION_PROMPT}=await import('../src/media-observation.ts');
 const latest=upgradeQualityWorkflow(base);
 const stale={...latest,schemaVersion:90,nodes:latest.nodes.map(node=>node.id==='sanguo-media-observe'
  ? {...node,prompt:FRAME_OBSERVATION_PROMPT}
  :node.id==='sanguo-media-review'?{...node,params:node.params.filter(p=>p.englishName!=='promptInputMode')}:node)};
 const updated=upgradeGroundedMediaObservation(stale);
 assert.equal(updated.schemaVersion,91);assert.equal(updated.edges,stale.edges);
 assert.equal(updated.nodes.find(node=>node.id==='sanguo-media-observe')!.prompt,GROUNDED_FRAME_OBSERVATION_PROMPT);
 assert.equal(updated.nodes.find(node=>node.id==='sanguo-media-review')!.params.find(p=>p.englishName==='promptInputMode')!.value,'normalized-results');
 for(let index=0;index<stale.nodes.length;index++)if(!['sanguo-media-observe','sanguo-media-review'].includes(stale.nodes[index].id))assert.equal(updated.nodes[index],stale.nodes[index]);
 assert.equal(upgradeGroundedMediaObservation(updated),updated);
 const custom={...stale,nodes:stale.nodes.map(node=>node.id==='sanguo-media-observe'?{...node,prompt:'用户自定义观察协议'}:node)};
 assert.equal(upgradeGroundedMediaObservation(custom).nodes.find(node=>node.id==='sanguo-media-observe')!.prompt,'用户自定义观察协议');
});

test('schema142 refreshes only the managed outline with the live-action-except-sand-table policy',async()=>{
 const {SANGUO_SCENE_OUTLINE_PROMPT}=await import('../src/scene-outline-prompt.ts');
 const {upgradeLiveActionExceptSandTable}=await import('../src/quality-node-presets.ts');
 const workflow={id:'wf-sanguo-history-drama',schemaVersion:141,edges:[{id:'e',from:'a',to:'b'}],nodes:[
  {id:'sanguo-scene-outline',kind:'text',modelId:'configured-writer',prompt:'旧动画范围',params:[]},
  {id:'custom',kind:'text',modelId:'custom-model',prompt:'保留',params:[]},
 ]};
 const migrated=upgradeLiveActionExceptSandTable(workflow);
 assert.equal(migrated.schemaVersion,142);
 assert.equal(migrated.nodes[0].prompt,SANGUO_SCENE_OUTLINE_PROMPT);
 assert.equal(migrated.nodes[0].modelId,'configured-writer');
 assert.equal(migrated.nodes[1],workflow.nodes[1]);
 assert.equal(migrated.edges,workflow.edges);
 assert.equal(upgradeLiveActionExceptSandTable(migrated),migrated);
});
