import test from 'node:test'
import assert from 'node:assert/strict'
import { chantShot, chantScene } from './fixtures/duration-v2-chant.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { hardenKlingDialoguePrompt } from '../server/model-adapters.ts'

function request() {
  const shot = chantShot(), result = compileDurationSchedule(shot, { scene: chantScene })
  return { model: { capability: 'video' },
    executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' },
    prompt: '【场景与开场实景】甘陵街巷。\n【场景真实性硬约束】使用真实街巷。\n' + result.videoPrompt,
    params: { duration: shot.duration, pacingVersion: 'duration-v2', sound: 'on',
      pacing: result.pacing, scheduleHash: result.scheduleHash, characters: shot.characters,
      presentCharacters: shot.presentCharacters, audioType: shot.audioType, audioText: shot.audioText, videoTimeline: result.videoPrompt } }
}

/** Public semantic fixture: an empty village street, an actor entering, then
 * speaking. No private execution, media URL, or model response is copied. */
function emptyOpeningRequest(options: { omitEntryAction?: boolean; speechBeforeArrival?: boolean } = {}) {
  const shot=chantShot(), actor=shot.characters[0], path='从村口沿土路走入画面'
  shot.pacing.beats[0].textOrVocalization=actor+path
  if (options.omitEntryAction) {
    shot.pacing.beats.shift()
    shot.pacing.beats[0].dependsOn=[]
    shot.pacing.beats[0].timingConstraint={mode:'hard',notBeforeSecond:.8}
  }
  if (options.speechBeforeArrival) {
    shot.pacing.beats[1].dependsOn=[]
    shot.pacing.beats[0].overlapAllowedWith=['lead-song']
    shot.pacing.beats[1].overlapAllowedWith=['opening']
  }
  const compiled=compileDurationSchedule(shot,{scene:chantScene}), base=request()
  return {...base,prompt:'【场景与开场实景】村口土路空景，乡人尚未入画。\n【场景真实性硬约束】真实街巷与自然光。\n'+compiled.videoPrompt,
    params:{...base.params,pacing:compiled.pacing,scheduleHash:compiled.scheduleHash,videoTimeline:compiled.videoPrompt,
      contentContractVersion:'cinematic-v1',continuityMode:'scene_cut',firstFrameMode:'reference',initialCharacters:[] as string[],
      referenceImages:['/fixtures/villager-identity.png'],
      referenceBindings:[{characterName:actor,role:'entering',entrance:{name:actor,startSecond:0,endSecond:.8,path}}],
      worldState:{settingId:'village-street',characters:[{name:actor,position:{status:'unknown'},heldProps:{status:'unknown'},pendingAction:{status:'unknown'}}]}}}
}

function actorlessEditorialRequest() {
  const scene={id:'scene-map',cast:[],editorialRole:'episode_opening',visualTreatment:'animated_map',requiredBeats:[{
    id:'beat-map',description:'古地图上颍川区域亮起',observable:{visual:['颍川区域亮起'],audio:[]},mustShow:['颍川区域亮起']}]}
  const shot={id:'shot-map',characters:[],presentCharacters:[],initialCharacters:[],endCharacters:[],duration:4,
    audioType:'环境声',audioText:'',contentContractVersion:'cinematic-v1',continuity:{mode:'scene_cut'},firstFrameMode:'reference',
    pacing:{version:'duration-v2',beats:[{id:'map-action',sourceBeatId:'beat-map',actorIds:[],kind:'action',textOrVocalization:'古地图上颍川区域亮起',dependsOn:[],overlapAllowedWith:[],durationEstimate:{lower:.8,expected:1,upper:1.2,source:'地图高亮动画',confidence:'high'},completion:{requiredThisClip:true,finalState:'颍川区域已高亮',modality:'visual',evidenceAnchor:'颍川区域亮起'},timingConstraint:{mode:'reference'}}]},
    visualPrompt:'写实古地图，颍川区域待高亮',worldState:{settingId:'map-yingchuan',characters:[]}}
  const compiled=compileDurationSchedule(shot,{scene})
  return {model:{capability:'video'},executionContext:{workflowId:'wf-sanguo-history-drama',nodeId:'sanguo-video'},
    prompt:`【本镜影视处理】animated_map / episode_opening\n【场景与开场画面】${shot.visualPrompt}\n【视觉处理硬约束】写实古地图材质。\n${compiled.videoPrompt}`,
    params:{duration:shot.duration,pacingVersion:'duration-v2',sound:'on',pacing:compiled.pacing,scheduleHash:compiled.scheduleHash,
      characters:[],presentCharacters:[],initialCharacters:[],referenceImages:[],contentContractVersion:'cinematic-v1',continuityMode:'scene_cut',
      firstFrameMode:'reference',referenceImage:'/generated/map-first.png',endImage:'/generated/map-end.png',
      audioType:'环境声',audioText:'',videoTimeline:compiled.videoPrompt,worldState:shot.worldState}}
}

function layeredIllustrationRequest() {
  const scene={id:'scene-portrait',cast:['张角'],editorialRole:'episode_opening',visualTreatment:'animated',animationStyle:'character_illustration',requiredBeats:[{
    id:'beat-portrait',description:'历史地图背景淡入，张角人物插画淡入',observable:{visual:['张角人物插画淡入'],audio:['张角以符水治病']},mustShow:['张角人物插画淡入']}]}
  const shot={id:'shot-portrait',characters:['张角'],presentCharacters:['张角'],initialCharacters:[],endCharacters:['张角'],duration:6,
    audioType:'旁白',audioText:'旁白：张角以符水治病',contentContractVersion:'cinematic-v1',continuity:{mode:'scene_cut'},firstFrameMode:'reference',
    pacing:{version:'duration-v2',beats:[
      {id:'background',sourceBeatId:'beat-portrait',actorIds:[],kind:'action',textOrVocalization:'历史地图背景淡入',dependsOn:[],overlapAllowedWith:[],durationEstimate:{lower:.5,expected:.8,upper:1,source:'背景淡入',confidence:'high'},completion:{requiredThisClip:true,finalState:'历史地图背景可见',modality:'visual',evidenceAnchor:'历史地图背景淡入'},timingConstraint:{mode:'reference'}},
      {id:'portrait',sourceBeatId:'beat-portrait',actorIds:['张角'],kind:'action',textOrVocalization:'张角人物插画淡入',dependsOn:['background'],overlapAllowedWith:[],durationEstimate:{lower:.5,expected:.8,upper:1,source:'人物图层淡入',confidence:'high'},completion:{requiredThisClip:true,finalState:'张角人物插画可见',modality:'visual',evidenceAnchor:'张角人物插画淡入'},timingConstraint:{mode:'reference'}},
      {id:'narration',sourceBeatId:'beat-portrait',actorIds:['旁白'],kind:'speech',deliveryStyle:'narration',textOrVocalization:'张角以符水治病',dependsOn:['portrait'],overlapAllowedWith:[],resources:['voice'],durationEstimate:{lower:1.45,expected:1.8,upper:2.5,source:'自然旁白',confidence:'high'},completion:{requiredThisClip:true,finalState:'史实旁白已说完',modality:'audio',evidenceAnchor:'张角以符水治病'},timingConstraint:{mode:'reference'}},
    ]},visualPrompt:'历史地图背景，人物图层尚未淡入',worldState:{settingId:'map',characters:[{name:'张角',position:{status:'unknown'},heldProps:{status:'unknown'},pendingAction:{status:'unknown'}}]}}
  const compiled=compileDurationSchedule(shot,{scene})
  return {model:{capability:'video'},executionContext:{workflowId:'wf-sanguo-history-drama',nodeId:'sanguo-video'},
    prompt:`【本镜影视处理】animated / episode_opening\n【动画叙事类型与美术风格】character_illustration / cinematic_gongbi\n【场景与开场画面】${shot.visualPrompt}\n【视觉处理硬约束】静态人物图层。\n${compiled.videoPrompt}`,
    params:{duration:shot.duration,pacingVersion:'duration-v2',sound:'on',pacing:compiled.pacing,scheduleHash:compiled.scheduleHash,
      characters:shot.characters,presentCharacters:shot.presentCharacters,initialCharacters:[],referenceImages:['/fixtures/zhang-jue.png'],
      referenceBindings:[{characterName:'张角',role:'identity'}],illustrationLayers:[{characterName:'张角',x:.5,y:.5,scale:.3,enterStart:1,enterDuration:.5,enterFromX:.6,enterFromY:.5,exitStart:5.5,exitDuration:.5}],
      contentContractVersion:'cinematic-v1',continuityMode:'scene_cut',firstFrameMode:'reference',referenceImage:'/generated/background.png',
      visualTreatment:'animated',editorialRole:'episode_opening',animationStyle:'character_illustration',animationAesthetic:'cinematic_gongbi',narrationVoice:{voiceId:'narrator'},
      audioType:shot.audioType,audioText:shot.audioText,videoTimeline:compiled.videoPrompt,worldState:shot.worldState}}
}

test('paid v2 request verifies the actual compiled schedule and all timing-bearing fields', () => {
  const valid = request()
  assert.doesNotThrow(() => validateWorkflowMediaContract(valid))
  for (const mutation of [
    { duration: 6 }, { scheduleHash: 'duration-v2-stale' }, { audioText: '删减的台词' },
    { videoTimeline: '0–9秒：只看镜头' }, { characters: ['另一个人'] },
    { pacing: { ...valid.params.pacing, schedule: [] } },
  ]) assert.throws(() => validateWorkflowMediaContract({ ...valid, params: { ...valid.params, ...mutation } }), /不可篡改的时长排程/)
  assert.throws(() => validateWorkflowMediaContract({ ...valid, prompt: valid.prompt.replace(valid.params.videoTimeline, '') }), /实际请求未使用/)
})

test('v2 provider instructions retain declared song and crowd voice budgets without a second fixed clock', () => {
  const prompt = hardenKlingDialoguePrompt(request().prompt, 'duration-v2')
  assert.match(prompt, /声部|群众|哼唱/)
  assert.doesNotMatch(prompt, /每秒4\.5|最后0\.3|固定0\.3/)
})

test('a complete cinematic v2 empty opening reaches the paid boundary with a timed entering identity reference',()=>{
  const valid=emptyOpeningRequest()
  assert.equal(valid.params.contentContractVersion,'cinematic-v1')
  assert.deepEqual(valid.params.initialCharacters,[])
  assert.equal(valid.params.referenceBindings[0].role,'entering')
  assert.equal(valid.params.pacing.schedule[0].startSecond,0)
  assert.equal(valid.params.pacing.schedule[0].endSecond,.8)
  assert.equal(valid.params.pacing.speechWindows[0].start,.8,'speaking starts at the completed entrance boundary')
  assert.match(valid.params.videoTimeline,/传唱歌谣的乡人从村口沿土路走入画面/)
  assert.doesNotThrow(()=>validateWorkflowMediaContract(valid))
})

test('an approved actorless editorial map reaches the paid boundary without invented identity assets',()=>{
  const valid=actorlessEditorialRequest()
  assert.doesNotThrow(()=>validateWorkflowMediaContract(valid))
  assert.throws(()=>validateWorkflowMediaContract({...valid,prompt:valid.prompt.replace('episode_opening','setup')}),/editorialRole|actorIds|人物身份参考|首帧可见人物/)
  assert.throws(()=>validateWorkflowMediaContract({...valid,params:{...valid.params,animationStyle:'character_illustration'}}),
    /排程哈希失效|静态插画|人物身份参考|首帧可见人物/,'an explicit character style cannot inherit the actorless historical-map exception')
})

test('a live-action setting establishment may be actorless without exempting character action',()=>{
  const scene={id:'scene-02',cast:['张角'],editorialRole:'story',visualTreatment:'live_action',requiredBeats:[{
    id:'beat-02',setting:'乡野简陋草棚外',description:'乡野简陋草棚外，张角持碗符水走近',observable:{visual:[],audio:[]},mustShow:[],
  }]}
  const beat={id:'beat-02-setup',sourceBeatId:'beat-02',actorIds:[] as string[],kind:'action' as const,
    textOrVocalization:'乡野简陋草棚外场景建立',dependsOn:[] as string[],overlapAllowedWith:[] as string[],
    durationEstimate:{lower:.5,expected:.8,upper:1,source:'建立场景环境的基础时间',confidence:'medium' as const},
    completion:{requiredThisClip:true,finalState:'乡野简陋草棚外场景已建立',modality:'visual' as const,evidenceAnchor:'乡野简陋草棚外全景'},
    timingConstraint:{mode:'reference' as const}}
  const shot={id:'scene-02',characters:['张角'],presentCharacters:['张角'],duration:3,audioType:'环境声',audioText:'',
    coveredBeatIds:['beat-02'],pacing:{version:'duration-v2',beats:[beat]}}
  assert.doesNotThrow(()=>compileDurationSchedule(shot,{scene}))
  const characterAction={...beat,textOrVocalization:'乡野简陋草棚外张角持碗符水走近',
    completion:{...beat.completion,finalState:'乡野简陋草棚外张角已经走近',evidenceAnchor:'乡野简陋草棚外张角持碗符水走近'}}
  assert.throws(()=>compileDurationSchedule({...shot,pacing:{...shot.pacing,beats:[characterAction]}},{scene}),/actorIds/)
})

test('a static character layer may enter after an empty first frame and keeps its identity reference',()=>{
  const valid=layeredIllustrationRequest()
  assert.doesNotThrow(()=>validateWorkflowMediaContract(valid))
  assert.doesNotMatch(valid.prompt.match(/【场景与开场画面】([^\n]+)/)?.[1]??'',/张角/,'the background plate must not bake the named illustration character')
  const continued={...valid,params:{...valid.params,continuityMode:'tail_continuation',firstFrameMode:'reuse_previous_tail',referenceImage:'/generated/actual-map-tail.jpg'}}
  assert.doesNotThrow(()=>validateWorkflowMediaContract(continued),'an actual prior tail and a timed identity layer are a valid continuation')
  assert.throws(()=>validateWorkflowMediaContract({...valid,params:{...valid.params,illustrationLayers:[]}}),/首帧可见人物/)
  assert.throws(()=>validateWorkflowMediaContract({...valid,params:{...valid.params,illustrationLayers:[{...valid.params.illustrationLayers[0],enterDuration:0}]}}),/首帧可见人物|续接参考/)
  assert.throws(()=>validateWorkflowMediaContract({...valid,params:{...valid.params,referenceBindings:[{characterName:'另一人',role:'identity'}]}}),/续接参考/)
})

test('empty v2 openings reject undeclared, missing, mistimed, or wrong-actor entrance bindings',()=>{
  const valid=emptyOpeningRequest(), binding=valid.params.referenceBindings[0]
  const mutations:Array<[string,Record<string,unknown>]>=[
    ['initial cast was never declared',{initialCharacters:undefined}],
    ['missing entry binding',{referenceBindings:[]}],
    ['missing entrance contract',{referenceBindings:[{characterName:binding.characterName,role:'entering'}]}],
    ['identity reference cannot substitute for an entering actor',{referenceBindings:[{characterName:binding.characterName,role:'identity'}]}],
    ['missing entrance path',{referenceBindings:[{...binding,entrance:{...binding.entrance,path:''}}]}],
    ['path differs from the compiled action',{referenceBindings:[{...binding,entrance:{...binding.entrance,path:'从另一侧院门推门而入'}}]}],
    ['entry starts outside its compiled window',{referenceBindings:[{...binding,entrance:{...binding.entrance,startSecond:.1}}]}],
    ['entry ends earlier than its compiled action',{referenceBindings:[{...binding,entrance:{...binding.entrance,endSecond:.7}}]}],
    ['entry ends after the actor has begun speech',{referenceBindings:[{...binding,entrance:{...binding.entrance,endSecond:1}}]}],
    ['reference belongs to another actor',{referenceBindings:[{...binding,characterName:'另一位乡人',entrance:{...binding.entrance,name:'另一位乡人'}}]}],
    ['reference and entrance names disagree',{referenceBindings:[{...binding,entrance:{...binding.entrance,name:'另一位乡人'}}]}],
    ['missing identity asset',{referenceImages:[]}],
  ]
  for(const [reason,params] of mutations) assert.throws(()=>validateWorkflowMediaContract({...valid,params:{...valid.params,...params}}),/首帧|入场|人物身份参考|entering/,reason)
  assert.throws(()=>validateWorkflowMediaContract(emptyOpeningRequest({omitEntryAction:true})),/首帧|入场|entering/,'a silent opening gap is not an executed entrance action')
  assert.throws(()=>validateWorkflowMediaContract(emptyOpeningRequest({speechBeforeArrival:true})),/首帧|入场|entering/,'a correctly hashed but premature voice must still be rejected')
})

test('legacy cinematic v1 keeps its previous nonempty opening-cast requirement',()=>{
  const valid=emptyOpeningRequest()
  assert.throws(()=>validateWorkflowMediaContract({...valid,params:{...valid.params,pacingVersion:'dynamic-v1',
    pacing:{version:'dynamic-v1',actionSeconds:.8,reactionSeconds:.7},scheduleHash:undefined}}),/首帧可见人物/)
})
