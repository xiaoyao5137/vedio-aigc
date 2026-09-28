import { missingRequiredParamNames } from '../src/workflow-core.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDramaturgyReview, DRAMATURGY_ACCEPT_CODE, DRAMATURGY_REVIEW_PROMPT, refreshDramaturgyReviewPrompt, refreshEmbeddedDramaturgyReviewCode, EPISODE_EVIDENCE_CODE, EPISODE_REVIEW_ACCEPT_CODE } from '../src/drama-quality-presets.ts'
import { upgradeQualityWorkflow, upgradeCinematicDramaQuality, upgradeDramaturgyReportConvergence, upgradeHistoricalAgencyConvergence, upgradeShotAnchorVerbatimCoverage, upgradeDramaturgyEvidencePathGrounding, upgradeDramaturgyCoverageChannels, upgradeFictionBoundaryReviewRules, upgradeReviewReportRecoveryBudget, upgradeReviewerCoverageChecklist, upgradeDramaturgyQuoteTypography, upgradeHistoricalAgencySourceCitation, upgradeIdleTailEditDecision, refreshScriptReviewSourceQuotes, SOURCE_QUOTE_REVIEW_PROMPT, refreshHistoricalSourceReviewGateCode, refreshHistoricalSourceReviewPrompt, refreshCinematicOpeningGateCode, refreshCinematicMediaImageReview, refreshCinematicEvidenceCertaintyCode, SOURCE_SPAN_REVIEW_PROMPT, INDEPENDENT_MEDIA_REVIEW_VIEW_CODE, REQUIREMENT_REVIEW_METRICS_CODE, COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE, SCOPED_MEDIA_DEFECT_EVIDENCE_CODE } from '../src/quality-node-presets.ts'
import { branchRunContext } from '../src/workflow-branch.ts'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { cleanStoryboardForValidation } from '../src/storyboard-runtime.ts'
import { historicalSourceReviewContext, historicalSourceSpans } from '../src/history-source-review.ts'

const candidate={contentContractVersion:'cinematic-v1',historicalLocks:[{id:'fact-1',fact:'两家宾客自发结交'}],scenes:[{id:'s1',dramaticSceneId:'d1',cast:[],purpose:'两家对立',requiredBeats:[{id:'b1',observable:{visual:['周家宾客收回招呼，转身离开'],audio:['房家宾客：乡人传唱，我只不过学了一句。']}}]}]};
const evidence={itemId:'s1',beatId:'b1',path:'scenes.0.requiredBeats.0.observable.visual.0',quote:'收回招呼，转身离开',finding:'撤回交往，关系产生实际变化'};
const check={status:'passed',reason:'具体声画已传达',evidenceRefs:[0]};
const review=()=>({version:'dramaturgy-v1',passed:true,orientation:check,dramaticProgression:check,characterDistinction:check,payoff:check,evidence:[evidence],issues:[] as Record<string,unknown>[],warnings:[],repairScope:'scene'});

test('editorial review grounds every scene in actual written beats, rejecting intent, invented quotes and wrong beat bindings',()=>{
 assert.equal(validateDramaturgyReview(candidate,review()).passed,true);
 for(const bad of [{...evidence,path:'scenes.0.purpose',quote:'两家对立'},{...evidence,quote:'拍案怒吼'},{...evidence,beatId:'other'}])assert.throws(()=>validateDramaturgyReview(candidate,{...review(),evidence:[bad]}),/REVIEW_RESULT_INVALID/);
 assert.throws(()=>validateDramaturgyReview(candidate,{...review(),payoff:{...check,evidenceRefs:[9]}}),/证据索引/);
});

test('style preferences repair the report while evidence-backed missing response can repair only its explicit scope',()=>{
 const issue={...evidence,code:'missing_response',problem:'唯一回答又重复先前表态',repair:'保留史实，在本场补出拒绝或实际选择',scope:'dramaticScene'};
 assert.equal(validateDramaturgyReview(candidate,{...review(),passed:false,issues:[issue],repairScope:'dramaticScene'}).passed,false);
 assert.throws(()=>validateDramaturgyReview(candidate,{...review(),passed:false,issues:[{...issue,code:'style_preference',problem:'没有反转不够燃'}],repairScope:'dramaticScene'}),/风格偏好/);
 const single={...candidate.scenes[0],contentContractVersion:'cinematic-v1'};
 assert.throws(()=>validateDramaturgyReview(single,{...review(),evidence:[{...evidence,path:'requiredBeats.0.observable.visual.0'}],passed:false,issues:[{...issue,path:'requiredBeats.0.observable.visual.0',scope:'episode'}],repairScope:'episode'}),/不得触发整集/);
});

const gateCode='const candidate=params.candidate,review=params.review,combinedIssues=[],accepted=true;'+DRAMATURGY_ACCEPT_CODE;
test('facts and editorial verdicts stay separate and one episode rewrite preserves candidate and immutable locks',async()=>{
 const dramaturgyReview={...review(),passed:false,issues:[{...evidence,code:'missing_payoff',problem:'开场问题没有后果',repair:'以结交同道回应开场',scope:'episode'}],repairScope:'episode'};
 const params={candidate,review:{passed:true,issues:[],dramaturgyReview}};
 const result=await executeCodeNode({code:gateCode,params});
 assert.equal(result.passed,false);assert.equal(result.factualReview.passed,true);assert.equal(result.dramaturgyReview.passed,false);
 assert.equal(result.repairContext.scope,'episode');assert.equal(result.repairContext.episodeRewriteCount,1);assert.deepEqual(result.repairContext.previousCandidate,candidate);assert.deepEqual(result.repairContext.historicalLocks,candidate.historicalLocks);
 const writerContext=branchRunContext({retryFeedback:result.repairContext,attempt:2},{});
 const gateContext=branchRunContext({attempt:2},writerContext);
 assert.equal((gateContext.retry as {feedback:unknown}).feedback,'');
 const regenerated={...candidate,repairProvenance:{episodeRewriteCount:result.repairContext.episodeRewriteCount,candidateVersion:1}};
 await assert.rejects(()=>executeCodeNode({code:gateCode,params:{...params,candidate:regenerated},context:gateContext}),/DRAMA_REPAIR_LIMIT/);
 await assert.rejects(()=>executeCodeNode({code:gateCode,params,context:{video_shot:{items:[{url:'/real.mp4'}]}}}),/DRAMA_REPAIR_AFTER_MEDIA/);
 await assert.rejects(()=>executeCodeNode({code:gateCode,params:{candidate,review:{passed:true}}}),/REVIEW_RESULT_INVALID/);
});

const evidenceContext=()=>({scene_outline:{count:2,episodeDrama:{centralQuestion:'歌谣如何扩大隔阂'}},shot_script:{items:[{id:'s1',audioType:'对白',audioText:'计划台词绝不作为证据'},{id:'s2',audioType:'环境声',audioText:''}]},episode_timeline:{clips:[{shotId:'s1',videoUrl:'/a.mp4',transcript:'计划文字'},{shotId:'s2',videoUrl:'/b.mp4'}]},video_shot:{items:[{url:'/a.mp4',decoded:true,evidenceUrl:'/a.json',hasAudio:true,duration:6,frames:['/a0.jpg','/a1.jpg'],frameTimes:[0,5.9],transcript:[{start:1,end:3,text:'乡人传唱，我只不过学了一句'}]},{url:'/b.mp4',decoded:true,evidenceUrl:'/b.json',hasAudio:true,duration:4,frames:['/b0.jpg','/b1.jpg'],frameTimes:[0,3.9]}]}});
test('episode evidence uses timeline order and actual measured ASR only, with explicit missing-media coverage',async()=>{
 const context=evidenceContext();context.video_shot.items.reverse();
 const result=await executeCodeNode({code:EPISODE_EVIDENCE_CODE,context});
 assert.equal(result.complete,true);assert.equal(result.status,'ready');assert.equal(result.segments[0].videoUrl,'/a.mp4');assert.equal(result.segments[1].startSecond,6);
 assert.equal(result.segments[0].transcript[0].text,'乡人传唱，我只不过学了一句');assert.equal(JSON.stringify(result).includes('计划台词'),false);assert.equal(result.fullVideoWatched,false);
 context.video_shot.items.pop();const partial=await executeCodeNode({code:EPISODE_EVIDENCE_CODE,context});assert.equal(partial.complete,false);assert.equal(partial.status,'incomplete');
 const empty=await executeCodeNode({code:EPISODE_EVIDENCE_CODE,context:{scene_outline:context.scene_outline}});assert.equal(empty.status,'not-generated');assert.equal(empty.shouldReview,false);
 const skipped=await executeCodeNode({code:EPISODE_REVIEW_ACCEPT_CODE,context:{episode_review_evidence:empty}});assert.equal(skipped.complete,false);assert.equal(skipped.automaticReshoot,false);
});

test('episode acceptance rejects planned assertions, unobserved frames and false full-coverage claims without media retries',async()=>{
 const e=await executeCodeNode({code:EPISODE_EVIDENCE_CODE,context:evidenceContext()});
 const r={version:'episode-review-v1',decision:'accepted',summary:'实际对白与撤回交往呈现关系变化',fullVideoWatched:false,scope:e.scope,evidence:[{segmentIndex:0,source:'asr',reference:0,quote:'乡人传唱',finding:'回避承担评价'},{segmentIndex:1,source:'frame',reference:1,finding:'人物转身离开'}],issues:[],warnings:[]};
 const run=(review:Record<string,unknown>,input=e)=>executeCodeNode({code:EPISODE_REVIEW_ACCEPT_CODE,context:{episode_review_evidence:input,episode_dramaturgy_review:review}});
 const result=await run(r);assert.equal(result.status,'accepted');assert.equal(result.automaticReshoot,false);assert.equal(result.fullVideoWatched,false);
 await assert.rejects(()=>run({...r,evidence:[{...r.evidence[0],quote:'计划台词'},r.evidence[1]]}),/实际ASR/);
 await assert.rejects(()=>run({...r,evidence:[r.evidence[0],{...r.evidence[1],reference:99}]}),/未采样帧/);
 await assert.rejects(()=>run(r,{...e,complete:false}),/部分素材/);
 assert.equal((await run({...r,decision:'incomplete'},{...e,complete:false})).status,'incomplete');
});

const base={id:'wf-sanguo-history-drama',schemaVersion:59,nodes:['sanguo-scene-outline','sanguo-shot-script','sanguo-character-image','sanguo-video','sanguo-last-frame','sanguo-compose','loop'].map(id=>({id,title:id,kind:id==='sanguo-video'?'video':id==='sanguo-shot-script'?'text':'code',modelId:'configured-model',resultVar:id,prompt:'custom',params:[],uploads:[],loop:{enabled:false,sourcePath:'',fallbackCount:1,itemVar:'item'},position:{x:0,y:0},...(id==='loop'?{childIds:['sanguo-shot-script','sanguo-character-image','sanguo-video','sanguo-last-frame']}: {})})),edges:[{id:'v-tail',from:'sanguo-video',to:'sanguo-last-frame'},{id:'tail-compose',from:'sanguo-last-frame',to:'sanguo-compose'}]};
test('schema88 is idempotent, preserves editable existing branches and adds only a post-media reviewer',async()=>{
 const latest=upgradeQualityWorkflow(base);assert.equal(latest.schemaVersion,113);assert.equal(upgradeCinematicDramaQuality(latest),latest);assert.equal(upgradeDramaturgyReportConvergence(latest),latest);assert.equal(upgradeHistoricalAgencyConvergence(latest),latest);assert.equal(upgradeShotAnchorVerbatimCoverage(latest),latest);assert.equal(upgradeDramaturgyEvidencePathGrounding(latest),latest);assert.equal(upgradeDramaturgyCoverageChannels(latest),latest);assert.equal(upgradeFictionBoundaryReviewRules(latest),latest);assert.equal(upgradeReviewReportRecoveryBudget(latest),latest);assert.equal(upgradeReviewerCoverageChecklist(latest),latest);assert.equal(upgradeDramaturgyQuoteTypography(latest),latest);assert.equal(upgradeHistoricalAgencySourceCitation(latest),latest);assert.equal(upgradeIdleTailEditDecision(latest),latest);
 const branched=migrateBranchWorkflow(latest);const v77={...branched,schemaVersion:77};
 const result=upgradeCinematicDramaQuality(v77);
 assert.deepEqual(result.edges,branched.edges);assert.equal(result.nodes.length,branched.nodes.length);assert.equal(result.nodes.filter(n=>n.id==='sanguo-episode-review').length,1);
 for(const node of branched.nodes.filter(n=>n.kind==='branch'))assert.deepEqual(result.nodes.find(n=>n.id===node.id),node);
 assert.equal(result.nodes.find(n=>n.id==='sanguo-video')?.modelId,'configured-model');
 const reviewNode=latest.nodes.find(n=>n.id==='sanguo-episode-review')! as unknown as Record<string,unknown>;
 assert.equal(reviewNode.operation,'history.episode-review');
 assert.deepEqual(reviewNode.runIf,{path:'episode_review_evidence.shouldReview',equals:true});
 const mediaReviewer=latest.nodes.find(n=>n.id==='sanguo-media-review')!;
 const imageParam=mediaReviewer.params.find((param:{englishName?:string})=>param.englishName==='reviewImages')! as {value:string};
 const frames=Array.from({length:8},(_,index)=>'/generated/actual-frame-'+index+'.jpg');
 assert.deepEqual(JSON.parse(renderWorkflowTemplate(imageParam.value,{video_evidence:{frames}})),frames,'成片审核收到全部原始帧，而不只收到观察摘要');
 const persisted=JSON.parse(JSON.stringify(mediaReviewer));assert.equal(refreshCinematicMediaImageReview(persisted),persisted,'已保存节点再次刷新保持原对象与参数');
 assert.equal(persisted.operation,'history.media-review');assert.match(persisted.prompt,/原图/);
 const newGate=latest.nodes.find(n=>n.id==='sanguo-episode-review-accept')! as unknown as Record<string,unknown>;assert.equal(newGate.acceptance,undefined);
 const mediaRequest=latest.nodes.find(n=>n.id==='sanguo-media-request')! as unknown as {code:string};
 const request=await executeCodeNode({code:mediaRequest.code,context:{shot_script:{contentContractVersion:'cinematic-v1',audioType:'环境声',audioText:'',duration:5}}});assert.deepEqual(request.speechWindows,[]);assert.equal(request.speechRequired,false);
});

test('configured media gate accepts a reverse reaction and observed silent decision, while retaining props, real-state and idle-tail failures',async()=>{
 // These minimal fixtures exercise the schema97 continuity and defect contract;
 // full original-requirement coverage is exercised separately through schema98.
 const current=upgradeQualityWorkflow(base);
 const workflow={...current,nodes:current.nodes.map(node=>node.code?{...node,code:node.code.replace(COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE,SCOPED_MEDIA_DEFECT_EVIDENCE_CODE).replace(INDEPENDENT_MEDIA_REVIEW_VIEW_CODE,'const e = context.video_evidence, review = context.media_review, shot = context.shot_script;').replace(REQUIREMENT_REVIEW_METRICS_CODE,'').replace('requirementReviewInputs,requirements,','requirements,')}:node)};
 const gate=workflow.nodes.find(n=>n.id==='sanguo-media-accept')! as unknown as {code:string};
 const params={durationTolerance:.5,aspectWidth:16,aspectHeight:9,aspectTolerance:.04,minVolumeDb:-50,maxPhoneticErrorRate:.2,tailSeconds:.3,timingTolerance:.25,maxFirstFrameDifference:.1,maxIdleTailSeconds:1.2,maxRepairChars:350};
 const observed=(value:string)=>({status:'observed',value,evidence:'实际帧0与1'}),unknown={status:'unknown'};
 const state={settingId:'courtyard',characters:[{name:'房家宾客',position:observed('门旁'),heldProps:observed('空手'),pendingAction:unknown},{name:'周家宾客',position:unknown,heldProps:unknown,pendingAction:unknown}]};
 const shot={contentContractVersion:'cinematic-v1',audioType:'环境声',audioText:'',duration:4,characters:['房家宾客'],initialCharacters:['房家宾客'],endCharacters:['房家宾客'],presentCharacters:['房家宾客','周家宾客'],worldState:state,continuity:{mode:'coverage_cut'},storyProgress:{unitId:'d1',status:'continuing'},completionCriteria:['转身离开'],pacing:{performanceBeats:[{id:'choice-1'}]}};
 const review={decision:'accepted',passed:true,issues:[],evidence:[{source:'frame',reference:1,finding:'转身后离开门边'}],endCharacters:['房家宾客'],endingState:'房家宾客转身',worldState:state,continuityReview:{mode:'coverage_cut',passed:true,checks:['position','heldProps'].map(field=>({character:'房家宾客',field,status:'observed',evidence:'首帧继承同一位置与持物',frameIndices:[0]}))},narrativeClosure:{unitId:'d1',complete:false,actionEvidence:'帧0到帧1由招呼改为离开',responseEvidence:'当前完成离开，后续反应待下一镜',unresolvedActions:[],criteriaChecks:[{criterion:'转身离开',status:'complete',evidence:'实际帧1'}]},pacingReview:{passed:true,reason:'用选择推进关系',lastMeaningfulActionSecond:3.7,performanceChecks:[{beatId:'choice-1',status:'observed',evidence:'帧0面向来客，帧1转身离开',observedStateChange:'由招呼转为拒绝交往',startSecond:.5,endSecond:3.7,frameIndices:[0,1]}]},tailTimingCheck:{assessment:'not-applicable',reason:'环境声没有人声余量，仍按实际动作检查空等'},speechChecks:[],visualChecks:[{character:'房家宾客',consistent:true,expectedObjects:'空手',actualObjectsByFrame:[{index:0,objects:'空手'},{index:1,objects:'空手'}],evidence:'两帧可见双手空'}],retryPrompt:'保留全部剧情，修复已定位状态'};
 const context={shot_script:shot,media_review:review,media_request:{speechWindows:[]},media_metrics:{speech:[],tailTiming:{assessment:'not-applicable'}},media_observations:{frames:[{index:0,setting:'院内',people:[]},{index:1,setting:'院内',people:[]}],tailObservation:'一人转身，另一人在画外'},video_evidence:{decoded:true,evidenceUrl:'/real.json',duration:4,width:1920,height:1080,hasAudio:true,meanVolumeDb:-24,frames:['/0.jpg','/1.jpg'],frameTimes:[0,3.7],lastFrameUrl:'/1.jpg',firstFrameDifference:.8},video_take:{params:{}}};
 const run=()=>executeCodeNode({code:gate.code,params,context});
 const accepted=await run();assert.equal(accepted.passed,true);assert.equal(accepted.audioMode,'ambient');assert.equal(accepted.speechValidation,undefined);assert.equal(accepted.technicalValidation.speechVerified,false);assert.deepEqual(accepted.worldState,state);
 // record-5i523a was stopped solely because a correctly unknown tail state kept
 // the reason it could not be observed. Preserve that reason and status verbatim.
 const uncertainTail=structuredClone(context);
 const unknownHeldProps={status:'unknown',evidence:'帧5双手因袍服遮挡及拍摄距离无法确认持物状态'};
 uncertainTail.media_review.worldState={...structuredClone(state),characters:state.characters.map(character=>({...character,heldProps:unknownHeldProps}))};
 const beforeUncertainTail=structuredClone(uncertainTail.media_review);
 const acceptedUnknown=await executeCodeNode({code:gate.code,params,context:uncertainTail});
 assert.equal(acceptedUnknown.passed,true);
 assert.deepEqual(acceptedUnknown.worldState,uncertainTail.media_review.worldState,'发布的尾帧状态保留unknown与原因，不能升级为observed');
 assert.deepEqual(uncertainTail.media_review,beforeUncertainTail,'不得静默删除报告中的证据原因');
 for(const value of ['双手空置',0,false,{},[]]){
  const bad=structuredClone(uncertainTail);
  Object.assign(bad.media_review.worldState.characters[0].heldProps,{value});
  await assert.rejects(()=>executeCodeNode({code:gate.code,params,context:bad}),/REVIEW_RESULT_INVALID.*无事实value/);
 }
 const promoted=structuredClone(uncertainTail);
 Object.assign(promoted.media_review.worldState.characters[0].heldProps,{status:'observed',value:'双手空置'});
 await assert.rejects(()=>executeCodeNode({code:gate.code,params,context:promoted}),/observed与明确不确定/);
 const originalStateEvidence=state.characters[0].heldProps.evidence;
 state.characters[0].heldProps.evidence='帧1右手因模糊无法完全确认';
 const uncertainReport=JSON.stringify(review);await assert.rejects(run,/observed与明确不确定/);assert.equal(JSON.stringify(review),uncertainReport);
 state.characters[0].heldProps.evidence=originalStateEvidence;
 const originalOpeningEvidence=review.continuityReview.checks[0].evidence;
 review.continuityReview.checks[0].evidence='首帧看不清位置';await assert.rejects(run,/首帧observed与明确不确定/);
 review.continuityReview.checks[0].evidence=originalOpeningEvidence;
 const oldCertaintyCode=gate.code.replace(/ \/\/ cinematic-evidence-certainty-v1[\s\S]*? \/\/ \/cinematic-evidence-certainty-v1/,'');
 assert.notEqual(oldCertaintyCode,gate.code);const refreshedCertainty=refreshCinematicEvidenceCertaintyCode(oldCertaintyCode);
 assert.equal(refreshCinematicEvidenceCertaintyCode(refreshedCertainty),refreshedCertainty);
 assert.equal((await executeCodeNode({code:refreshedCertainty,params,context})).passed,true);
 // The real coverage take had an unknown prior position alongside observed empty hands.
 const opening=structuredClone(context);
 opening.shot_script.worldState.characters[0].position={status:'unknown'};
 opening.media_review.continuityReview.checks=[
  {...review.continuityReview.checks[1]},
  {character:'房家宾客',field:'position',status:'unobservable',evidence:'前镜没有已核实的世界位置，不能比较',frameIndices:[0]},
  {character:'周家宾客',field:'pendingAction',status:'unobservable',evidence:'仍在场但位于画外，待接动作未知',frameIndices:[0]},
 ];
 const beforeOpening=structuredClone(opening.media_review);
 const runOpening=(ctx=opening,code=gate.code)=>executeCodeNode({code,params,context:ctx});
 const openingAccepted=await runOpening();assert.equal(openingAccepted.passed,true);
 assert.deepEqual(opening.media_review,beforeOpening,'额外未知状态不得改写原报告');
 assert.deepEqual(openingAccepted.visualReview.continuityReview,beforeOpening.continuityReview,'接受结果须保留原始逐项观察');
 const withChecks=(checks:unknown[])=>{
  const value=structuredClone(opening);
  value.media_review.continuityReview.checks=checks as typeof value.media_review.continuityReview.checks;
  return value;
 };
 const openingChecks=opening.media_review.continuityReview.checks;
 await assert.rejects(runOpening(withChecks(openingChecks.slice(1))),/缺少首帧逐项世界状态/);
 await assert.rejects(runOpening(withChecks([{...openingChecks[0],status:'unobservable'},...openingChecks.slice(1)])),/关键状态不可观察/);
 const mismatch=await runOpening(withChecks([{...openingChecks[0],status:'mismatch',evidence:'实际首帧手持扇子，与前镜空手不一致'},...openingChecks.slice(1)]));
 assert.equal(mismatch.passed,false);assert.ok(mismatch.issues.some((issue:string)=>issue.includes('同场切镜改变实际连续状态')));
 for(const rowIndex of [1,2])for(const status of ['observed','mismatch']){
  const checks=openingChecks.map((row,index)=>index===rowIndex?{...row,status}:row);
  await assert.rejects(runOpening(withChecks(checks)),/未知状态不能冒充/);
 }
 for(const extra of [
  {...openingChecks[1],character:'不在场的陌生人'},
  {...openingChecks[1],field:'screenPosition'},
  {...openingChecks[1]},
  {...openingChecks[0]},
  null,
 ])await assert.rejects(runOpening(withChecks([...openingChecks,extra])),/非法重复项目/);
 const falseFailure=structuredClone(opening);falseFailure.media_review.continuityReview.passed=false;
 await assert.rejects(runOpening(falseFailure),/各状态一致却报告失败/);

 // Refresh the persisted pre-fix gate, including custom wrappers, without replacing its other checks.
 const extraUnknownGuard="   if(!required.some(r=>r.character===row.character&&r.field===row.field)){if(row.status!=='unobservable')invalid('前镜未知状态不能冒充可核对的一致或不一致事实');continue;}\n";
 assert.ok(gate.code.includes(extraUnknownGuard));
 const oldGate=gate.code.replace(extraUnknownGuard,'');
 await assert.rejects(runOpening(opening,oldGate),/关键状态不可观察/);
 const wrapped='// preserved user prefix\n'+oldGate+'\n// preserved user suffix';
 const refreshed=refreshCinematicOpeningGateCode(wrapped);
 assert.equal(refreshed,'// preserved user prefix\n'+gate.code+'\n// preserved user suffix');
 assert.equal(refreshCinematicOpeningGateCode(refreshed),refreshed);
 assert.equal((await runOpening(opening,refreshed)).passed,true);
 await assert.rejects(runOpening(withChecks([{...openingChecks[0],status:'unobservable'},...openingChecks.slice(1)]),refreshed),/关键状态不可观察/);
 assert.throws(()=>refreshCinematicOpeningGateCode('return params.review;'),/preserve custom code/);
 assert.deepEqual(opening.media_review,beforeOpening);
 review.pacingReview.performanceChecks[0].frameIndices=[1];await assert.rejects(run,/单一静帧/);review.pacingReview.performanceChecks[0].frameIndices=[0,1];
 review.pacingReview.performanceChecks[0].status='unobservable';await assert.rejects(run,/复核同一素材/);review.pacingReview.performanceChecks[0].status='observed';
 // The scalar endpoint must not cut off a performance independently observed to 3.7s.
 review.pacingReview.lastMeaningfulActionSecond=1;
 const performanceProtected=await run();
 assert.equal(performanceProtected.passed,true);
 assert.equal(performanceProtected.tailTrim,null,'不得把已证实到3.7秒的动作剪到1.3秒');
 review.pacingReview.performanceChecks[0].endSecond=1;
 Object.assign(context.video_evidence,{url:'/generated/original.mp4',originalUrl:'https://example.com/original.mp4'});
 const uneditedReport=structuredClone(review);
 await assert.rejects(run,(error:Error)=>{
  assert.match(error.message,/MEDIA_EDIT_REQUIRED:/);
  const proposal=JSON.parse(error.message.split('MEDIA_EDIT_REQUIRED: ')[1]);
  assert.equal(proposal.trimIn,0);assert.equal(proposal.trimOut,1.3);assert.equal(proposal.sourceDuration,4);
  assert.equal(proposal.sourceUrl,'/generated/original.mp4');assert.equal(proposal.evidenceUrl,'/real.json');
  assert.equal(proposal.status,'required');assert.ok(proposal.removedSeconds>0);
  return true;
 });
 assert.deepEqual(review,uneditedReport,'待实施剪辑不得更改原报告或伪造passed');
 const routed=migrateBranchWorkflow(workflow);
 const routedGate=routed.nodes.find(node=>node.id==='sanguo-media-accept')!;
 const editRequired=await executeCodeNode({code:routedGate.code!,params,context});
 assert.equal(editRequired.passed,undefined);assert.match(editRequired.routeError,/^MEDIA_EDIT_REQUIRED:/);
 const errorBranch=routed.nodes.find(node=>node.id==='sanguo-media-accept-error-branch')!;
 await assert.rejects(()=>executeCodeNode({code:errorBranch.code!,params:{patterns:['REVIEW_RESULT_INVALID:'],maxAttempts:2},
  context:{video_shot:editRequired,branch:{counts:{false:0}}}}),/MEDIA_EDIT_REQUIRED:/,'实际异常分支停在原素材，不走购买视频的结果分支');
 // Unknown and missing performance evidence keep their original same-media review routes.
 review.pacingReview.performanceChecks[0].status='unobservable';
 await assert.rejects(run,/REVIEW_RESULT_INVALID:.*复核同一素材/);
 review.pacingReview.performanceChecks[0].status='observed';
 review.pacingReview.performanceChecks[0].frameIndices=[1];
 await assert.rejects(run,/REVIEW_RESULT_INVALID:.*单一静帧/);
 review.pacingReview.performanceChecks[0].frameIndices=[0,1];
 // The same idle ending stays a re-shoot while a sentence is genuinely outside its measured span.
 context.media_metrics.speech=[{text:'乡人传唱',elapsed:6,allowedSpan:4,timingAssessment:'outside-allowance'}];
 review.speechChecks=[{text:'乡人传唱',assessment:'slow',reason:'实际6秒超出含容差上限4秒'}];
 const slowTail=await run();
 assert.equal(slowTail.passed,false,'语速真的拖慢时仍须重拍');
 assert.equal(slowTail.tailTrim,null);
 assert.ok(slowTail.issues.some((issue:string)=>issue.includes('节奏未通过')));
 context.media_metrics.speech=[];review.speechChecks=[];
 // No natural-language issue can be erased by mentioning the tail, including defects
 // that were absent from schema89's list of protected keywords.
 const tailReport=structuredClone(review) as Record<string,unknown>;
 tailReport.decision='rejected';tailReport.passed=false;
 Object.assign(shot,{lastFramePrompt:'房家宾客双手空置'});
 for(const [complaint,requirement] of [
  ['尾部帧人物手持扇子，与计划空手不符',{category:'script',requirementPath:'lastFramePrompt',requirementQuote:'房家宾客双手空置',scope:'ending'}],
  ['尾部突然变黑',{category:'visual-artifact',rule:'black-frame'}],
  ['尾部画面变形',{category:'visual-artifact',rule:'visual-deformation'}],
 ] as const){
  tailReport.issues=[complaint];tailReport.defectEvidence=[{issueIndex:0,status:'confirmed',source:'frame',frameIndices:[1],finding:complaint,repair:'保留剧情，只修复'+complaint,...requirement}];context.media_review=tailReport;
  const failed=await run();
  assert.equal(failed.passed,false,'任何已明确列出的质量问题都保留');
  assert.ok(failed.issues.includes(complaint));assert.equal(failed.tailTrim,null);
 }
 context.media_review=review;
 review.pacingReview.performanceChecks[0].endSecond=3.7;
 review.pacingReview.lastMeaningfulActionSecond=3.7;
 // record-1zesjb: a possible prop is a same-material report defect, never a retake.
 const uncertainProp=structuredClone(context);
 uncertainProp.media_review.passed=false;uncertainProp.media_review.decision='rejected';
 uncertainProp.media_review.issues=['空间归属不明确，可能手持物，需确认是否计划外道具'];
 uncertainProp.media_review.visualChecks[0].consistent=false;
 uncertainProp.media_review.visualChecks[0].evidence='当前证据不足以排除计划外道具可能性';
 Object.assign(uncertainProp.media_review,{defectEvidence:[{issueIndex:0,visualCheckIndex:0,status:'uncertain',source:'frame',frameIndices:[0],finding:'当前证据不足以排除计划外道具可能性'}]});
 await assert.rejects(()=>executeCodeNode({code:gate.code,params,context:uncertainProp}),/REVIEW_RESULT_INVALID:.*全部拒绝项仍为 uncertain/);
 const uncertainRouted=await executeCodeNode({code:routedGate.code!,params,context:uncertainProp});
 assert.equal(uncertainRouted.passed,undefined);assert.match(uncertainRouted.routeError,/^REVIEW_RESULT_INVALID:/);
 const uncertainRoute=await executeCodeNode({code:errorBranch.code!,params:{patterns:['REVIEW_RESULT_INVALID:'],maxAttempts:2},
  context:{video_shot:uncertainRouted,branch:{counts:{false:0}}}});
 assert.equal(uncertainRoute.value,false);
 assert.equal(routed.edges.find(edge=>edge.from===errorBranch.id&&edge.branch==='false')?.to,'sanguo-media-request','未确证拒绝回到同素材采证与审核，不能回到视频生成');
 const mixedProp=structuredClone(uncertainProp);
 mixedProp.media_review.issues.push('帧1画面突然变黑');
 Object.assign(mixedProp.media_review,{retryPrompt:'去掉疑似道具并修复黑帧',defectEvidence:[
  {issueIndex:0,visualCheckIndex:0,status:'uncertain',finding:'当前证据不足以排除计划外道具可能性'},
  {issueIndex:1,status:'confirmed',source:'frame',category:'visual-artifact',rule:'black-frame',frameIndices:[1],finding:'实际帧1整幅画面突然变黑',repair:'保留全部角色、道具和剧情，仅修复帧1黑屏'},
 ]});
 const mixedRefusal=await executeCodeNode({code:gate.code,params,context:mixedProp});
 assert.equal(mixedRefusal.passed,false);assert.deepEqual(mixedRefusal.issues,['帧1画面突然变黑']);
 assert.equal(mixedRefusal.retryPrompt,'保留全部角色、道具和剧情，仅修复帧1黑屏','不确定道具不得污染针对确证黑帧的生成修复意见');
 review.continuityReview.checks[0].status='mismatch';assert.equal((await run()).passed,false);review.continuityReview.checks[0].status='observed';
 state.characters[1].heldProps=observed('突然持扇');await assert.rejects(run,/画外人物状态/);state.characters[1].heldProps=unknown;
 shot.continuity.mode='tail_continuation';assert.equal((await run()).passed,false);
 shot.continuity.mode='coverage_cut';(shot.continuity as Record<string,unknown>).exitingCharacters=[{name:'周家宾客'}];
 const presentReview=review as unknown as Record<string,unknown>;
 presentReview.presentCharacters=['房家宾客','周家宾客'];
 presentReview.presenceChecks=[{character:'周家宾客',status:'incomplete',evidence:'实际仍停在门外，没有离场',frameIndices:[0,1]}];
 assert.equal((await run()).passed,false,'实际未离场应明确拒绝，不误当报告格式失败');
 presentReview.presentCharacters=['房家宾客'];presentReview.presenceChecks=[{character:'周家宾客',status:'observed',evidence:'帧0走向出口，帧1已走出现场',frameIndices:[0,1]}];
 state.characters=state.characters.filter(character=>character.name!=='周家宾客');
 assert.equal((await run()).passed,true);
 presentReview.presenceChecks=[{character:'周家宾客',status:'unobservable',evidence:'只知画外，不能证明离场',frameIndices:[0,1]}];
 await assert.rejects(run,/复核同一素材/);

});


test('schema78 refreshes embedded factual agency guard and localizes source rejections to the exact scene',async()=>{
 const latest=upgradeQualityWorkflow(base);
 const gate=latest.nodes.find(n=>n.id==='sanguo-scene-outline-accept')! as unknown as {code:string};
 const oldCode=gate.code.replace('[譏讥譥]','[譏讥]');assert.notEqual(oldCode,gate.code);
 const legacy={...latest,schemaVersion:77,nodes:latest.nodes.map(node=>node.id==='sanguo-scene-outline-accept'?{...node,code:oldCode}:node)};
 const candidate={scenes:[{id:'scene-target',cast:[],purpose:'周福联络同道，各树朋徒。'}]};
 const review={passed:true,issues:[],checks:[],evidence:[{itemId:'scene-target',citationIndex:1,quote:'二家宾客互相譥揣'}]};
 const context={historical_sources:{citations:[{content:'二家宾客互相譥揣，遂各树朋徒。'}]}};
 assert.equal((await executeCodeNode({code:oldCode,params:{candidate,review},context})).passed,true);
 const updated=upgradeCinematicDramaQuality(legacy).nodes.find(node=>node.id==='sanguo-scene-outline-accept')! as unknown as {code:string};
 const rejected=await executeCodeNode({code:updated.code,params:{candidate,review},context});
 assert.equal(rejected.passed,false);assert.equal(rejected.issues[0].itemId,'scene-target');assert.equal(rejected.repairContext.scope,'scene');
});


test('ambient media traverses the actual migrated App required-parameter check with empty text and speech windows',async()=>{
 const workflow=upgradeQualityWorkflow(base);
 const unknown={status:'unknown'};
 const shot={contentContractVersion:'cinematic-v1',audioType:'环境声',audioText:'',duration:4,firstFrameMode:'reference',continuity:{mode:'coverage_cut'},characters:['甲'],initialCharacters:['甲'],presentCharacters:['甲'],worldState:{settingId:'courtyard',characters:[{name:'甲',position:unknown,heldProps:unknown,pendingAction:unknown}]}};
 const request=workflow.nodes.find(node=>node.id==='sanguo-media-request')! as unknown as {code:string};
 const mediaRequest=await executeCodeNode({code:request.code,context:{shot_script:shot}});
 const context={shot_script:shot,media_request:mediaRequest,video_take:{url:'/generated/actual.mp4'}};
 const valuesFor=(node:typeof workflow.nodes[number])=>Object.fromEntries(node.params.map(param=>{
  const rendered=renderWorkflowTemplate(param.value,context);
  return [param.englishName||param.name,param.type==='boolean'?rendered==='true':param.type==='number'?Number(rendered):['json','images'].includes(param.type)?JSON.parse(rendered||'null'):rendered];
 }));
 const video=workflow.nodes.find(node=>node.id==='sanguo-video')!;
 const evidence=workflow.nodes.find(node=>node.id==='sanguo-video-evidence')!;
 const videoValues=valuesFor(video),evidenceValues=valuesFor(evidence);
 assert.equal(videoValues.audioText,'');assert.equal(evidenceValues.audioText,'');assert.deepEqual(evidenceValues.speechWindows,[]);
 assert.deepEqual(missingRequiredParamNames(video.params,videoValues),[]);
 assert.deepEqual(missingRequiredParamNames(evidence.params,evidenceValues),[]);
 assert.ok(missingRequiredParamNames(video.params,{...videoValues,audioType:undefined}).includes('audioType'));
 assert.ok(missingRequiredParamNames(evidence.params,{...evidenceValues,url:undefined}).includes('url'));
 const boundary={model:{capability:'video'},executionContext:{workflowId:'wf-sanguo-history-drama',nodeId:'sanguo-video'},prompt:'【场景与开场实景】甲在东汉院门旁。\n【场景真实性硬约束】人物资产只作身份参考。',params:{...videoValues,duration:4,pacingVersion:'dynamic-v1',sound:'on',referenceImages:['/portrait.png'],referenceBindings:[{characterName:'甲',role:'identity'}]}};
 assert.doesNotThrow(()=>validateWorkflowMediaContract(boundary));
 assert.throws(()=>validateWorkflowMediaContract({...boundary,params:{...boundary.params,audioType:'对白'}}),/完整台词/);
});


test('unique array-level editorial citations receive deterministic addresses without mutating the raw report',()=>{
 const raw={...review(),repairScope:'none',evidence:[{...evidence,path:'scenes.0.requiredBeats.0.observable.visual'}]};
 const before=structuredClone(raw);const result=validateDramaturgyReview(candidate,raw);
 assert.equal(result.evidence[0].path,'scenes.0.requiredBeats.0.observable.visual.0');assert.equal(result.repairScope,'scene');assert.equal(result.passed,true);assert.deepEqual(raw,before);
 const duplicate=structuredClone(candidate);duplicate.scenes[0].requiredBeats[0].observable.visual.push('再次收回招呼，转身离开');
 assert.throws(()=>validateDramaturgyReview(duplicate,raw),/唯一匹配/);
 assert.throws(()=>validateDramaturgyReview(candidate,{...raw,evidence:[{...raw.evidence[0],quote:'不存在的动作'}]}),/唯一匹配/);
 // repairScope is derived from issues[] and the gate reads that derived value, so an echoed
 // mismatch is bookkeeping: correcting it must not bounce the whole paid report back.
 assert.equal(validateDramaturgyReview(candidate,{...raw,repairScope:'unknown'}).repairScope,'scene');
 const rejected={...raw,passed:false,repairScope:'scene',issues:[{...raw.evidence[0],code:'missing_response',problem:'缺少具体回应',repair:'补入原义务回应',scope:'scene'}]};
 assert.equal(validateDramaturgyReview(candidate,{...rejected,repairScope:'episode'}).repairScope,'scene');
 // A mislabeled itemId is corrected from the grounded path (the quote is verified there), so a
 // reviewer citing scene-03's line under scene-05 no longer stalls; the same repair covers an
 // out-of-range path, because the quote still grounds exactly one candidate string.
 const relabeled=validateDramaturgyReview(candidate,{...raw,evidence:[{...raw.evidence[0],itemId:'wrong-scene'}]});
 assert.equal(relabeled.evidence[0].itemId,'s1');assert.equal(relabeled.evidence[0].path,'scenes.0.requiredBeats.0.observable.visual.0');
 const relocated=validateDramaturgyReview(candidate,{...raw,evidence:[{...raw.evidence[0],path:'scenes.9.requiredBeats.0.observable.visual',itemId:'wrong-scene'}]});
 assert.equal(relocated.evidence[0].itemId,'s1');assert.equal(relocated.evidence[0].path,'scenes.0.requiredBeats.0.observable.visual.0');
 // Nothing grounds a quote that does not exist, so the locator defect is still reported.
 assert.throws(()=>validateDramaturgyReview(candidate,{...raw,evidence:[{...raw.evidence[0],path:'scenes.9.requiredBeats.0.observable.visual',itemId:'wrong-scene',quote:'不存在的动作'}]}),/定位字段缺失/);
 const issueBefore=structuredClone(rejected);const resolved=validateDramaturgyReview(candidate,rejected);assert.equal(resolved.issues[0].path,'scenes.0.requiredBeats.0.observable.visual.0');assert.equal(resolved.passed,false);assert.deepEqual(rejected,issueBefore);
});

test('editorial quotes permit typography only and not-applicable checks default empty indexes without changing the raw report',()=>{
 const c=structuredClone(candidate);c.scenes[0].requiredBeats[0].observable.visual=['甲说“退一步”，乙答‘好’'];
 const raw={...review(),evidence:[{...evidence,path:'scenes.0.requiredBeats.0.observable.visual',quote:'甲说"退一步"，乙答\'好\''}],payoff:{status:'not_applicable',reason:'本镜只建立处境'}};
 const before=structuredClone(raw);const result=validateDramaturgyReview(c,raw);
 assert.deepEqual(raw,before);assert.equal(result.evidence[0].quote,raw.evidence[0].quote);assert.equal(c.scenes[0].requiredBeats[0].observable.visual[0],'甲说“退一步”，乙答‘好’');
 assert.equal(result.evidence[0].path,'scenes.0.requiredBeats.0.observable.visual.0');assert.deepEqual((result.payoff as Record<string,unknown>).evidenceRefs,[]);
 const asciiComma={...raw,evidence:[{...raw.evidence[0],quote:'甲说"退一步",乙答\'好\''}]},commaBefore=structuredClone(asciiComma);
 const commaResult=validateDramaturgyReview(c,asciiComma);assert.equal(commaResult.passed,true);assert.equal(commaResult.evidence[0].quote,asciiComma.evidence[0].quote);assert.deepEqual(asciiComma,commaBefore);
 for(const quote of ['甲说"退一步"乙答\'好\'','甲说"退,一步"乙答\'好\''])assert.throws(()=>validateDramaturgyReview(c,{...raw,evidence:[{...raw.evidence[0],quote}]}),/唯一匹配/);
 for(const quote of ['甲说"退两步"，乙答\'好\'','甲说"退一步"， 乙答\'好\'','甲说"退1步"，乙答\'好\''])assert.throws(()=>validateDramaturgyReview(c,{...raw,evidence:[{...raw.evidence[0],quote}]}),/唯一匹配/);
 const ambiguous=structuredClone(c);ambiguous.scenes[0].requiredBeats[0].observable.visual.push('甲说"退一步"，乙答\'好\'');assert.throws(()=>validateDramaturgyReview(ambiguous,raw),/歧义/);
 assert.throws(()=>validateDramaturgyReview(c,{...raw,orientation:{status:'passed',reason:'可认清'}}),/orientation/);
 assert.throws(()=>validateDramaturgyReview(c,{...raw,payoff:{status:'not_applicable',reason:'无',evidenceRefs:null}}),/payoff/);
 assert.throws(()=>validateDramaturgyReview(c,{...raw,payoff:{status:'failed',reason:'未回应'}}),/payoff/);
});

// record-l2t6gi: the outline emits “一句歌谣,便能断人高下?” with half-width punctuation and the reviewer
// transcribes that exact sentence with “，”“？”. Byte comparison grounded three of its four citations
// nowhere, so four paid re-reviews resubmitted an identical defect list that named nothing to correct.
// The fourth citation was a genuine restatement, which must stay a defect and now prints both texts.
test('a citation grounds through a punctuation glyph change, and a restated line names the sentence it should copy',()=>{
 const half=structuredClone(candidate);half.scenes[0].requiredBeats[0].observable.audio=['一句歌谣,便能断人高下?','乡人所传,可曾道出周尚书如何得官?'];
 const quoted={itemId:'s1',beatId:'b1',path:'scenes.0.requiredBeats.0.observable.audio.0',quote:'一句歌谣，便能断人高下？',finding:'宾客把歌谣当成评判依据'};
 const healed=validateDramaturgyReview(half,{...review(),evidence:[quoted]});
 assert.equal(healed.passed,true);assert.equal(healed.evidence[0].quote,'一句歌谣，便能断人高下？');
 // Pointing at the neighbouring line is still bookkeeping the gate can correct from the quote.
 assert.equal(validateDramaturgyReview(half,{...review(),evidence:[{...quoted,path:'scenes.0.requiredBeats.0.observable.audio.1'}]}).evidence[0].path,'scenes.0.requiredBeats.0.observable.audio.0');
 let restated='';
 try{validateDramaturgyReview(candidate,{...review(),evidence:[{...evidence,quote:'周家宾客收回招呼并肩转身离开'}]})}catch(error){restated=String((error as Error).message)}
 for(const fragment of ['引文不在候选声画原文中：scenes.0.requiredBeats.0.observable.visual.0','该处实际原文是 "周家宾客收回招呼，转身离开"','报告引用了 "周家宾客收回招呼并肩转身离开"','不得增字、减字、换词或补写同义词'])assert.ok(restated.includes(fragment),fragment);
});

test('a metadata issue names same-scene body locators without deleting factual or dramatic coverage',async()=>{
 // record-08xr1d alternated between this cast citation and removal of scene-07
 // from both evidence arrays. An invalid issue is neither permission to drop a
 // scene nor evidence that the issue's substantive conclusion is correct.
 const c={...candidate,scenes:Array.from({length:8},(_,index)=>({id:'scene-'+String(index+1).padStart(2,'0'),
  dramaticSceneId:'drama-01',cast:['周福门生','房植门生'],requiredBeats:[{id:'beat-'+index,
   observable:{visual:[index===6?'周福门生拱手，房植门生侧身回礼':'本场'+index+'的原动作'],audio:[index===6?'房植门生：此事请先说明。':'本场'+index+'的原台词']}}]}))};
 const rows=c.scenes.map((scene,index)=>({itemId:scene.id,path:'scenes.'+index+'.requiredBeats.0.observable.visual.0',quote:scene.requiredBeats[0].observable.visual[0],finding:'当前场实际行动'}));
 const bad={...review(),passed:false,evidence:rows,issues:[{code:'indistinct_character_action',itemId:'scene-07',path:'scenes.6.cast',
  quote:"['周福门生','房植门生']",problem:'仅由人物名单推断表演缺少区分',repair:'按该场实际表演核对',scope:'scene'}]};
 const factual={passed:true,issues:[],evidence:c.scenes.map(scene=>({itemId:scene.id,citationIndex:1,quote:'原史料完整片段',supports:'当前场史实依据'})),dramaturgyReview:bad};
 const before=structuredClone({c,factual});
 const checkError=(error:unknown)=>{
  const message=String((error as Error).message);
  for(const part of ['scenes.6.cast','所属场景 scene-07','dramaturgyReview.issues[0]',
   'scenes.6.requiredBeats.0.observable.visual.0','周福门生拱手，房植门生侧身回礼',
   'scenes.6.requiredBeats.0.observable.audio.0','房植门生：此事请先说明。',
   '定位候选不自动证明当前 problem','推测移入 warnings','保留未被否定的最外层 review.evidence',
   '与 dramaturgyReview.evidence','不能替代最外层逐场史料引证'])assert.ok(message.includes(part),part);
  assert.ok(!message.includes('本场5的原动作'),'repair suggestions stay inside scene-07');
  return true;
 };
 assert.throws(()=>validateDramaturgyReview(c,bad),checkError);
 const stale=gateCode.replace(/\(function validateDramaturgyReview[\s\S]*?\)\(candidate, review\.dramaturgyReview\)/,
  '(function oldGate(){throw Error("old metadata error")})(candidate, review.dramaturgyReview)');
 assert.notEqual(stale,gateCode);
 const refreshed=refreshEmbeddedDramaturgyReviewCode(stale);
 await assert.rejects(()=>executeCodeNode({code:refreshed,params:{candidate:c,review:factual}}),checkError);
 assert.deepEqual({c,factual},before,'neither the candidate nor either evidence array is rewritten');
 const grounded={...bad,issues:[{...bad.issues[0],path:rows[6].path,quote:rows[6].quote,problem:'原动作尚未给出已批准的明确回应'}]};
 assert.equal(validateDramaturgyReview(c,grounded).passed,false,'legal grounding retains a reported substantive refusal');
});

// Reduced from the real wf-sanguo-history-drama failure: attempt 1 was rejected for a bad
// quote, attempt 2 for `orientation` passed with empty evidenceRefs, and maxAttempts=2 ran
// out before any attempt could fix the second defect. Both must now surface together.
const messageOf=(value:unknown)=>{try{validateDramaturgyReview(candidate,value);return ''}catch(error){return String((error as Error).message)}};
test('one attempt reports every dramaturgy defect so the existing maxAttempts=2 budget can converge',()=>{
 const broken={...review(),orientation:{status:'passed',reason:'处境清楚'},payoff:{status:'passed',reason:'结尾有回应'},evidence:[{...evidence,quote:'不存在的动作'}]};
 const message=messageOf(broken);
 assert.match(message,/^REVIEW_RESULT_INVALID: 叙事报告 共 3 项独立缺陷/);
 for(const fragment of ['一次性全部修复','(1) evidence[0] 引文不在候选声画原文中','(2) orientation缺少声画证据索引','(3) payoff缺少声画证据索引'])assert.ok(message.includes(fragment),fragment);
 // One defect keeps the plain single message and still names both legal remedies.
 const single=messageOf({...review(),payoff:{status:'passed',reason:'有回应',evidenceRefs:[]}});
 assert.match(single,/^REVIEW_RESULT_INVALID: 叙事报告 payoff缺少声画证据索引：判 passed 时 evidenceRefs 必须是非空数组/);
 assert.ok(!single.includes('共 1 项'));assert.match(single,/not_applicable/);assert.match(single,/复用/);
});

test('each dimension failure names its own cause instead of sharing one ambiguous sentence',()=>{
 const probe=(payoff:Record<string,unknown>)=>messageOf({...review(),payoff});
 assert.match(probe({status:'passed',reason:'有回应',evidenceRefs:[9]}),/payoff缺少声画证据索引：\[9] 不是有效证据索引[\s\S]*0\.\.0/);
 assert.match(probe({status:'passed',reason:'有回应',evidenceRefs:[1]}),/\[1] 不是有效证据索引/);
 assert.match(probe({status:'ok',reason:'有回应',evidenceRefs:[0]}),/payoff\.status 必须是 passed\/failed\/not_applicable/);
 assert.match(probe({status:'passed',evidenceRefs:[0]}),/payoff\.reason 必须是非空字符串/);
 assert.match(probe({status:'not_applicable',reason:'本镜无此义务',evidenceRefs:null}),/只能整个省略或写 \[\]，当前是 null/);
 assert.match(probe({status:'failed',reason:'未回应',evidenceRefs:[0]}),/判 failed 却没有具体问题/);
 // Sharing one evidence row across all four dimensions is legal and must stay legal.
 assert.equal(validateDramaturgyReview(candidate,review()).passed,true);
});

test('dramaturgy prompt refresh upgrades the deployed unbounded block and is idempotent',async()=>{
 const custom='用户既有审核规则\n候选：${params.candidate}',block=DRAMATURGY_REVIEW_PROMPT.trim();
 const appended=refreshDramaturgyReviewPrompt(custom);
 assert.equal(appended,custom+'\n'+block);assert.equal(refreshDramaturgyReviewPrompt(appended),appended);
 const legacy=custom+'\n'+block.replace('【cinematic-v1 叙事审核结束】','')+'\n'+SOURCE_QUOTE_REVIEW_PROMPT;
 const upgraded=refreshDramaturgyReviewPrompt(legacy);
 assert.equal(upgraded,custom+'\n'+block+'\n'+SOURCE_QUOTE_REVIEW_PROMPT);assert.equal(refreshDramaturgyReviewPrompt(upgraded),upgraded);
 assert.equal(upgraded.split('【史料引文复制规则 v1】').length,2,'不得复制既有引文规则块');
 assert.throws(()=>refreshDramaturgyReviewPrompt(custom+'\n'+block.replace('【cinematic-v1 叙事审核结束】','')),/preserve custom reviewer prompt/);
 const latest=upgradeQualityWorkflow(base);
 for(const node of latest.nodes.filter(n=>['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(n.id))){
   assert.equal(node.prompt.split('【cinematic-v1 叙事审核】').length,2);assert.equal(node.prompt.split('【cinematic-v1 叙事审核结束】').length,2);
   assert.equal(refreshDramaturgyReviewPrompt(node.prompt),node.prompt);assert.equal(refreshHistoricalSourceReviewPrompt(node.prompt),node.prompt);
   assert.ok(node.prompt.includes('四个分项的 status 与 evidenceRefs 硬规则'));
   assert.ok(node.prompt.includes('payoff、dramaticProgression、characterDistinction 同理'));
   assert.ok(node.prompt.includes('同一条声画引文可以被多个分项同时复用'));
   assert.ok(node.prompt.includes('禁止用 passed 配空 evidenceRefs'));
 }
 const gate=latest.nodes.find(n=>n.id==='sanguo-shot-script-accept')! as unknown as {code:string};
 assert.ok(gate.code.includes('一次性全部修复'),'已持久化验收门必须嵌入新校验器');
 assert.ok(gate.code.includes('同一条 evidence 允许被多个分项同时复用'));
 // End to end through the sandboxed gate: the real production failure shape is rejected
 // with an actionable message rather than dying on an unrelated earlier defect.
 const replay=executeCodeNode({code:gateCode,params:{candidate,review:{passed:true,issues:[],dramaturgyReview:{...review(),payoff:{status:'passed',reason:'结尾有回应',evidenceRefs:[]},evidence:[{...evidence,quote:'不存在的动作'}]}}}});
 await assert.rejects(replay,/共 2 项独立缺陷[\s\S]*payoff缺少声画证据索引/);
});

test('sandbox execution logs do not re-enter strict storyboard validation from accepted gate output',async()=>{
 const shot={id:'scene-01',contentContractVersion:'cinematic-v1',worldState:{settingId:'courtyard',characters:[]}};
 const accepted=await executeCodeNode({code:'console.log("gate evaluated"); return {...params.candidate,passed:true,factualReview:{passed:true},dramaturgyReview:{passed:true}};',params:{candidate:shot}});
 assert.ok(Array.isArray(accepted.executionLogs));assert.ok(accepted.executionLogs.length);
 assert.deepEqual(cleanStoryboardForValidation(accepted),shot);
 assert.ok(accepted.executionLogs.length);
});

test('source-quote prompt refresh is bounded and idempotent while the production gate still rejects rewritten source text',async()=>{
 const custom='用户既有审核规则\n候选：${params.candidate}';const refreshed=refreshScriptReviewSourceQuotes(custom);
 assert.equal(refreshed,custom+'\n'+SOURCE_QUOTE_REVIEW_PROMPT);assert.equal(refreshScriptReviewSourceQuotes(refreshed),refreshed);
 assert.equal(refreshScriptReviewSourceQuotes('前言\n【史料引文复制规则 v1】旧规则【史料引文复制规则结束】\n后记'),'前言\n'+SOURCE_QUOTE_REVIEW_PROMPT+'\n后记');
 assert.throws(()=>refreshScriptReviewSourceQuotes(custom+'【史料引文复制规则 v1】'),/incomplete/);
 const latest=upgradeQualityWorkflow(base);for(const node of latest.nodes.filter(n=>['sanguo-scene-outline-review','sanguo-shot-script-review'].includes(n.id))){assert.equal(node.prompt.split('【史料引文复制规则 v1】').length,2);assert.equal(refreshScriptReviewSourceQuotes(node.prompt),node.prompt);}
 const gate=latest.nodes.find(n=>n.id==='sanguo-scene-outline-accept')! as unknown as {code:string};const source={content:'桓帝爲蠡吾侯，受學於甘陵周福，及即帝位，擢福爲尚書。'};
 const c={id:'s',characters:[],historicalBasis:'[史料1]'};const report={passed:true,issues:[],checks:[],evidence:[{itemId:'s',citationIndex:1,quote:'受學於甘陵周福',supports:'曾受教于周福'}]};
 const accepted=await executeCodeNode({code:gate.code,params:{candidate:c,review:report},context:{historical_sources:{citations:[source]}}});assert.equal(accepted.passed,true);
 await assert.rejects(executeCodeNode({code:gate.code,params:{candidate:c,review:{...report,evidence:[{...report.evidence[0],quote:'桓帝为蠡吾侯时受学于甘陵周福,即位后擢福为尚书'}]}},context:{historical_sources:{citations:[source]}}}),/引文不在对应史料正文/);
});

test('persisted source-span gate derives quotes from current sources and retains exact scene and character coverage',async()=>{
 const workflow=upgradeQualityWorkflow(base),gate=workflow.nodes.find(n=>n.id==='sanguo-scene-outline-accept')! as unknown as {code:string};
 const sources=[{content:'桓帝爲蠡吾侯，受學於甘陵周福。'}],span=historicalSourceSpans(sources)[0];
 const c={scenes:[{id:'scene-01',cast:['甲','乙']},{id:'scene-02',cast:['甲','乙']}]};
 const r={passed:true,issues:[],evidence:[{itemIds:['scene-01','scene-02'],sourceSpanId:span.id,supports:'原文提供人物师生身份背景'}],checks:c.scenes.flatMap(scene=>scene.cast.map(character=>({itemId:scene.id,character,startingState:'相对站立',finalActionState:'倾听',requestedEndState:'倾听',canExecuteAsWritten:true})))};
 const before=structuredClone(r),context={historical_sources:{citations:sources},history_source_review:{sourceSpans:[{id:span.id,quote:'模型伪造的目录不能覆盖原文'}]}};
 const accepted=await executeCodeNode({code:gate.code,params:{candidate:c,review:r},context});
 assert.equal(accepted.passed,true);assert.deepEqual(r,before);assert.equal(accepted.factualReview.evidence.length,2);
 for(const row of accepted.factualReview.evidence){assert.equal(row.quote,span.quote);assert.equal(row.citationIndex,1);assert.equal(row.sourceSpan.id,span.id);}
 const invoke=(report:Record<string,unknown>,ctx:Record<string,unknown>=context)=>executeCodeNode({code:gate.code,params:{candidate:c,review:report},context:ctx});
 await assert.rejects(invoke({...r,evidence:[{itemId:'scene-01',sourceSpanId:span.id,supports:'单场依据'}]}),/顶层 review\.evidence 缺少逐场史料引证：scene-02/);
 await assert.rejects(invoke({...r,checks:r.checks.slice(1)}),/scene-01 \/ 甲/);
 await assert.rejects(invoke({...r,evidence:[{...r.evidence[0],sourceSpanId:'forged'}]}),/编号不存在/);
 await assert.rejects(invoke({...r,evidence:[{...r.evidence[0],quote:'教授过皇帝'}]}),/附带引文冲突/);
 await assert.rejects(invoke(r,{historical_sources:{citations:[{content:'另一个来源，不能借用过期编号。'}]},history_source_review:{sourceSpans:[span]}}),/编号不存在/);
 await assert.rejects(invoke({...r,evidence:[{...r.evidence[0],itemIds:['scene-01','scene-02','forged-scene']}]}),/不属于当前候选/);
 const reviewer=workflow.nodes.find(n=>n.id==='sanguo-scene-outline-review')!;
 assert.equal((reviewer as unknown as Record<string,unknown>).operation,'history.script-review');
 const rendered=renderWorkflowTemplate(reviewer.prompt,historicalSourceReviewContext({...context,params:{candidate:c}}));assert.ok(rendered.includes(span.id));assert.ok(rendered.includes('"characters":["甲","乙"]'));assert.equal(refreshHistoricalSourceReviewPrompt(reviewer.prompt),reviewer.prompt);
 const wrapped='// custom before\ntry { return (()=>{'+gate.code+'})(); } catch(error) { return {routeError:String(error)}; }';
 const refreshed=refreshHistoricalSourceReviewGateCode(wrapped);assert.equal(refreshed,wrapped);assert.equal(refreshHistoricalSourceReviewGateCode(refreshed),refreshed);
 assert.equal((await executeCodeNode({code:refreshed,params:{candidate:c,review:r},context})).passed,true);
 assert.throws(()=>refreshHistoricalSourceReviewGateCode('return params.review;'),/preserve custom gate/);
});

test('source-span reviewer refresh renders every source once with lossless numbered text and explicit continuation rules',()=>{
 const custom='保留用户审核规则\n史料：${historical_sources.citations}\n候选：${params.candidate}\n保留附加规则';
 const prompt=refreshHistoricalSourceReviewPrompt(custom);
 assert.equal(refreshHistoricalSourceReviewPrompt(prompt),prompt);assert.ok(prompt.startsWith('保留用户审核规则\n'));
 assert.ok(prompt.includes('候选：${params.candidate}\n保留附加规则'));
 assert.ok(!prompt.includes('${historical_sources.citations}'));assert.ok(prompt.includes('sources[].numberedText'));
 assert.ok(prompt.includes('重新抬起已放下的手'));assert.ok(prompt.includes('orientation 可如实给 not_applicable'));
 assert.ok(prompt.includes('如判 passed，仍必须给当前候选中真实有效的 evidenceRefs'));
 const sources=[{title:'甲史料',url:'https://example.test/1',content:'否。\n周福受命授学。\n不。'},{title:'乙史料',url:'https://example.test/2',content:'另传记载不同处，须并读。'}];
 const c={id:'scene-02',characters:['甲','乙'],videoPrompt:'从身侧明确抬起空手。'};
 const context={params:{candidate:c},historical_sources:{citations:sources}};const before=structuredClone(context);
 const renderContext=historicalSourceReviewContext(context), rendered=renderWorkflowTemplate(prompt,renderContext);
 assert.deepEqual(context,before);assert.deepEqual(renderContext.params.candidate,c);
 assert.ok(!('sourceSpans' in renderContext.history_source_review));
 for(const [i,source] of sources.entries()){
   const numbered=renderContext.history_source_review.sources[i];
   assert.equal(numbered.numberedText.replace(/⟦[^⟧]*⟧/g,''),source.content);
   assert.equal(rendered.split(source.title).length,2);assert.equal(rendered.split(source.url).length,2);
   for(const span of historicalSourceSpans([source]))assert.equal(rendered.split(span.quote).length,2);
 }
 assert.ok(rendered.includes('否。\\n'));assert.ok(rendered.includes('\\n不。'));
});

// A 21-segment outline could never converge under maxAttempts=2: 逐场必证 was the only legal
// answer, so the wordless transition beats a reviewer cannot honestly quote failed the whole
// report (verified on record-r93dr0: 18~19 grounded rows covering 13~14 segments, end_turn).
// The schema-83 exit keeps the accountant's rule and adds the second legal answer.
const outlineScenes=[
 {id:'s1',dramaticSceneId:'d1',requiredBeats:[{id:'b1',observable:{visual:['周家宾客收回招呼'],audio:['周家宾客：乡人传唱，我只不过学了一句。']}}]},
 {id:'s2',dramaticSceneId:'d1',requiredBeats:[{id:'b2',observable:{visual:['房家宾客按住院门'],audio:['房家宾客：我没有学。']}}]},
 {id:'s3',dramaticSceneId:'d2',requiredBeats:[{id:'b3',observable:{visual:['巷口空无一人'],audio:['远处更鼓两响']}}]},
 {id:'s4',dramaticSceneId:'d2',requiredBeats:[{id:'b4',observable:{visual:['周家宾客点头'],audio:['周家宾客：如此更好。']}}]},
];
const outlineCandidate=(episodeDrama:Record<string,unknown>={openingPromise:{beatIds:['b1']},payoff:{beatIds:['b4']}})=>({contentContractVersion:'cinematic-v1',episodeDrama,scenes:structuredClone(outlineScenes)});
const cite=(index:number,kind:'visual'|'audio',quote:string)=>({itemId:'s'+(index+1),beatId:'b'+(index+1),path:`scenes.${index}.requiredBeats.0.observable.${kind}.0`,quote,finding:'本场有可拍声画落点'});
const outlineReview=(extra:Record<string,unknown>={},evidence=[cite(0,'audio','乡人传唱'),cite(1,'audio','我没有学'),cite(3,'audio','如此更好')])=>({version:'dramaturgy-v1',passed:true,orientation:check,dramaticProgression:check,characterDistinction:check,payoff:check,evidence,issues:[] as Record<string,unknown>[],warnings:[],repairScope:'scene',...extra});
const serves=(extra:Record<string,unknown>={})=>({itemId:'s3',reason:'巷口空镜无台词，其声画义务由同一场完整戏内已引证的 s4 承担',coveredBy:'s4',...extra});

test('multi-scene outline answers each segment with its own citation or an explicit same-scene carrier',()=>{
 const c=outlineCandidate();
 assert.throws(()=>validateDramaturgyReview(c,outlineReview()),/s3缺少声画覆盖/,'既无落点又无声明仍是缺陷');
 const result=validateDramaturgyReview(c,outlineReview({uncovered:[serves()]})) as Record<string,unknown>;
 assert.equal(result.passed,true);assert.deepEqual(result.uncovered,[serves()],'免证声明随报告存档可见');
 const judge=(review:Record<string,unknown>,candidate=c)=>validateDramaturgyReview(candidate,review);
 assert.throws(()=>judge(outlineReview({uncovered:[serves({coveredBy:'s2'})]})),/同一完整戏/,'承担者必须落在同一场完整戏内');
 assert.throws(()=>judge(outlineReview({uncovered:[serves({coveredBy:'s3'})]})),/不能指向本场自身/);
 assert.throws(()=>judge(outlineReview({uncovered:[serves(),serves()]})),/不得重复声明免证/);
 assert.throws(()=>judge(outlineReview({uncovered:[serves(),{itemId:'s1',reason:'已有落点仍想免证',coveredBy:'s2'}]})),/不能再声明免证/,'与证据清单矛盾的声明被拒');
 assert.throws(()=>judge(outlineReview({uncovered:[serves(),{itemId:'s2',reason:'x',coveredBy:'s3'}]},[cite(0,'audio','乡人传唱'),cite(3,'audio','如此更好')])),/没有被本报告 evidence 引用/,'未证实的短段不能承担别场义务');
 assert.throws(()=>judge(outlineReview({uncovered:[{itemId:'s9',reason:'x',coveredBy:'s4'}]})),/必须是当前候选中的场景/);
 assert.throws(()=>judge(outlineReview({uncovered:[serves({reason:'  '})]})),/reason 必须是非空字符串/);
 assert.throws(()=>judge(outlineReview({uncovered:'s3' as unknown as []})),/uncovered 必须是数组/);
 assert.throws(()=>judge(outlineReview({uncovered:[{itemId:'s1',reason:'开场就要免证',coveredBy:'s2'}]},[cite(1,'audio','我没有学'),cite(3,'audio','如此更好')])),/不得免证/,'候选首场不可免证');
 assert.throws(()=>judge(outlineReview({uncovered:[{itemId:'s4',reason:'木然点头无需独立交代',coveredBy:'s3'}]},[cite(0,'audio','乡人传唱'),cite(1,'audio','我没有学'),cite(2,'audio','远处更鼓两响')])),/不得免证/,'候选末场不可免证');
 assert.throws(()=>validateDramaturgyReview(outlineCandidate({openingPromise:{beatIds:['b1']},payoff:{beatIds:['b3']}}),outlineReview({uncovered:[serves()]})),/不得免证/,'结尾回应节拍所属场次即使居中也不可免证');
 assert.throws(()=>judge(outlineReview({uncovered:[{itemId:'s3',reason:'借别场短段承担',coveredBy:'s1'}]},[cite(0,'audio','乡人传唱'),cite(1,'audio','我没有学')])),/d2 整场戏没有任何声画 evidence 落点/,'整场戏不得全部免证');
 assert.throws(()=>judge(outlineReview({uncovered:[serves()]},[cite(0,'audio','乡人传唱'),cite(1,'audio','我没有学')])),/d2 整场戏没有任何声画 evidence 落点/);
 assert.throws(()=>validateDramaturgyReview(candidate,{...review(),uncovered:[{itemId:'s1',reason:'单镜也想免证',coveredBy:'s1'}]}),/单场候选/,'分镜复核行为不变');
});

test('narrative prompt states both coverage channels and the deployed gate keeps an exemption visible',async()=>{
 assert.ok(DRAMATURGY_REVIEW_PROMPT.includes('uncovered:[{itemId,reason,coveredBy}]'));
 assert.ok(DRAMATURGY_REVIEW_PROMPT.includes('声画证据不接受 itemIds 共享'));
 assert.ok(DRAMATURGY_REVIEW_PROMPT.includes('每个 dramaticSceneId 至少要有一条 dramaturgyReview.evidence 落点'));
 assert.ok(DRAMATURGY_REVIEW_PROMPT.includes('最外层 review.evidence 是史料引证，每个候选场景都必须覆盖'));
 assert.ok(DRAMATURGY_REVIEW_PROMPT.includes('itemIds 共享只允许用于最外层 review.evidence'));
 assert.ok(DRAMATURGY_REVIEW_PROMPT.includes('dramaturgyReview.uncovered 只声明叙事承担关系，不替代最外层 review.evidence'));
 assert.ok(DRAMATURGY_REVIEW_PROMPT.includes('dramaturgyReview.evidence 与 dramaturgyReview.issues 必须逐字引用'));
 assert.doesNotMatch(DRAMATURGY_REVIEW_PROMPT,/所有 evidence 与 issues|0 到 evidence\.length|repairScope为issues/);
 const c=outlineCandidate();
 const accepted=await executeCodeNode({code:gateCode,params:{candidate:c,review:{passed:true,issues:[],dramaturgyReview:outlineReview({uncovered:[serves()]})}}}) as Record<string,unknown>;
 const dramaturgy=accepted.dramaturgyReview as Record<string,unknown>;
 assert.equal(accepted.passed,true);assert.equal(dramaturgy.passed,true);
 assert.deepEqual((dramaturgy.uncovered as Record<string,unknown>[]).map(row=>row.itemId),['s3']);
 await assert.rejects(executeCodeNode({code:gateCode,params:{candidate:c,review:{passed:true,issues:[],dramaturgyReview:outlineReview()}}}),/s3缺少声画覆盖/);
});

test('schema83 refreshes reviewer prompts and embedded gates without touching user text or budgets',()=>{
 const latest=upgradeQualityWorkflow(base);
 const deployed=DRAMATURGY_REVIEW_PROMPT.trim()
  .replace('uncovered:[{itemId,reason,coveredBy}]?,','')
  .replace('逐场覆盖是二选一','旧口径：每个场至少一项声画evidence');
 assert.notEqual(deployed,DRAMATURGY_REVIEW_PROMPT.trim());
 const previous={...latest,schemaVersion:82,nodes:latest.nodes.map(node=>node.id==='sanguo-scene-outline-review'
  ? {...node,prompt:'用户自定义审核规则\n候选：${params.candidate}\n'+deployed}
  : node)};
 const upgraded=upgradeDramaturgyCoverageChannels(previous);
 assert.equal(upgraded.schemaVersion,83);assert.equal(upgradeDramaturgyCoverageChannels(upgraded),upgraded);
 const already={...latest,schemaVersion:83};assert.equal(upgradeDramaturgyCoverageChannels(already),already);
 const other={...base,id:'other-workflow',schemaVersion:82};assert.equal(upgradeDramaturgyCoverageChannels(other),other);
 const refreshed=upgraded.nodes.find(node=>node.id==='sanguo-scene-outline-review')!;
 assert.ok(refreshed.prompt.startsWith('用户自定义审核规则\n候选：${params.candidate}\n'),'只替换标记区间');
 assert.ok(!refreshed.prompt.includes('旧口径'));
 assert.equal(refreshDramaturgyReviewPrompt(refreshed.prompt),refreshed.prompt);
 assert.equal(refreshed.prompt.split('【cinematic-v1 叙事审核】').length,2);
 assert.ok(refreshed.prompt.includes('uncovered:[{itemId,reason,coveredBy}]'));
 assert.ok(refreshed.prompt.includes('每个 dramaticSceneId 至少要有一条 dramaturgyReview.evidence 落点'));
 assert.ok(refreshed.prompt.includes('dramaturgyReview.uncovered 显式声明承担者'),'史料覆盖块同步说明两条通道');
 const gate=upgraded.nodes.find(node=>node.id==='sanguo-shot-script-accept')! as unknown as {code:string};
 assert.ok(gate.code.includes('免证声明必须落在同一完整戏内'),'已持久化验收门必须嵌入新校验器');
 assert.ok(gate.code.includes('整场戏没有任何声画 evidence 落点'));
 const codeless={...latest,schemaVersion:82,nodes:latest.nodes.map(node=>node.id==='sanguo-shot-script-accept'?{...node,code:undefined}:node)};
 assert.equal(upgradeDramaturgyCoverageChannels(codeless).nodes.find(node=>node.id==='sanguo-shot-script-accept')?.code,undefined);
 // The other reviewer blocks must never quote the dramaturgy markers, or the bounded refresh
 // would mistake that reference for the block itself and refuse a deployed prompt.
 assert.equal(refreshDramaturgyReviewPrompt('用户规则\n'+SOURCE_SPAN_REVIEW_PROMPT),'用户规则\n'+SOURCE_SPAN_REVIEW_PROMPT+'\n'+DRAMATURGY_REVIEW_PROMPT.trim());
});
