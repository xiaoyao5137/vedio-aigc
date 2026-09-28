import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { collectDurationCoverageDiagnostics, collectDurationSpeechBudgetDiagnostics, collectDurationVoiceLayoutDiagnostics, compileDurationSchedule, deriveDurationMediaRequest, verifyDurationSchedule } from '../src/duration-schedule.ts'
import { DURATION_POLICY_RUNTIME_CODE, durationCanonicalJson, durationContentHash, estimateSpeechDuration } from '../src/duration-policy.ts'
import { dynamicStoryboardTiming, historyTailSeconds } from '../src/history-pacing.ts'
import { appendLipSyncContract, hasExecutionPlanMismatch, isDurationPolicyTransition, refreshPendingExecutionNodes,
  collectHistoricalStoryboardDiagnostics, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { chantScene, chantShot, realSixSecondPlanning, songText } from './fixtures/duration-v2-chant.ts'
import { generateHistoricalStoryboard } from '../src/storyboard-runtime.ts'
import { enactedVisualTextCovers } from '../src/history-drama.ts'

test('real record reproduces six-second shrink, v2 preserves chant and crowd budgets for nine seconds',()=>{
  const old = dynamicStoryboardTiming(realSixSecondPlanning.audioText,realSixSecondPlanning.pacing)
  assert.equal(old.requiredDuration,6); assert.equal(old.speechSeconds,3.26)
  assert.ok(realSixSecondPlanning.asrAlignedSpan-old.speechSeconds>1.35)
  const current=compileDurationSchedule(chantShot(),{scene:chantScene})
  assert.deepEqual(current.schedule.map(row=>[row.beatId,row.startSecond,row.endSecond]),[
    ['opening',0,.8],['lead-song',.8,6.3],['crowd-response',6.3,8.1]])
  assert.equal(current.timingEstimate.safeEndBudget,8.6); assert.equal(current.timingEstimate.requiredDuration,9)
  assert.equal(current.timingEstimate.selectedDuration,9)
  assert.match(current.videoPrompt,/围观乡人点头/);assert.match(current.videoPrompt,/无词/)
  assert.match(current.videoPrompt,/哼唱歌谣，按歌谣节奏吟唱并完整唱出：天下规矩/)
  assert.equal(current.speechWindows.length,1)
  assert.equal(current.speechWindows[0].text,songText)
  assert.throws(()=>compileDurationSchedule({...chantShot(),duration:6},{scene:chantScene}),/可批准 9–10 秒/)
  assert.doesNotThrow(()=>compileDurationSchedule({...chantShot(),duration:10},{scene:chantScene}))
  assert.throws(()=>compileDurationSchedule({...chantShot(),duration:11},{scene:chantScene}),/可批准 9–10 秒/)
})

test('optional group voice profile survives compilation, participates in identity hash and leaves legacy records compatible', () => {
  const legacy = chantShot()
  const baseline = compileDurationSchedule(legacy, { scene: chantScene })
  const legacyStored = { ...legacy, ...baseline, videoPrompt: baseline.videoPrompt }
  assert.doesNotThrow(() => verifyDurationSchedule(legacyStored, { scene: chantScene }))
  const profile = { pitch: '中低', texture: '温润', delivery: '坚定清晰' }
  const configured = { ...legacy, pacing: { ...legacy.pacing, actorGroups: legacy.pacing.actorGroups.map(group => ({ ...group, voiceProfile: profile })) } }
  const compiled = compileDurationSchedule(configured, { scene: chantScene })
  assert.deepEqual(compiled.pacing.actorGroups[0].voiceProfile, profile)
  assert.notEqual(compiled.scheduleHash, baseline.scheduleHash)
  assert.equal(compileDurationSchedule(legacy, { scene: chantScene }).scheduleHash, baseline.scheduleHash)
  const stored = { ...configured, ...compiled, videoPrompt: compiled.videoPrompt }
  assert.doesNotThrow(() => verifyDurationSchedule(stored, { scene: chantScene }))
  const changed = structuredClone(stored)
  changed.pacing.actorGroups[0].voiceProfile = { ...profile, pitch: '高' }
  assert.throws(() => verifyDurationSchedule(changed, { scene: chantScene }), /排程哈希失效/)
  const invalid = { ...legacy, pacing: { ...legacy.pacing, actorGroups: legacy.pacing.actorGroups.map(group => ({ ...group, voiceProfile: { pitch: { inferred: true } } })) } }
  assert.throws(() => compileDurationSchedule(invalid, { scene: chantScene }), /voiceProfile/)
})

test('duration coverage shares bounded enacted-text matching for harmless source detail',()=>{
  const scene={cast:['饥民代表'],requiredBeats:[{id:'beat-01',description:'饥民代表扶着一个病弱的家人在空地坐下',
    mustShow:['扶着病人','坐在空地'],observable:{visual:['扶着病弱家人','坐在空地上'],audio:[]},setting:'治所外空地'}]}
  const output={pacing:{version:'duration-v2',beats:[{id:'arrival',sourceBeatId:'beat-01',kind:'action',actorIds:['饥民代表'],
    textOrVocalization:'饥民代表扶着病弱家人在治所外空地上缓慢坐下',completion:{requiredThisClip:true}}]}}
  assert.deepEqual(collectDurationCoverageDiagnostics(output,{scene}),[])
  for(const text of ['饥民代表并未扶着病弱家人坐在空地上','饥民代表准备扶着病弱家人坐在空地上',
    '饥民代表说：“扶着病弱家人坐在空地上”']){
    const rejected=structuredClone(output);rejected.pacing.beats[0].textOrVocalization=text
    assert.match(collectDurationCoverageDiagnostics(rejected,{scene}).join('\n'),/可执行正文缺少原锚点/)
  }
})

test('actorless editorial actions use an empty performer list without inventing a crowd',()=>{
  const scene={editorialRole:'episode_opening',visualTreatment:'animated_map',cast:[],requiredBeats:[{
    id:'beat-01',description:'地图高亮中原区域',mustShow:['地图高亮中原区域'],
    observable:{visual:['地图高亮中原区域'],audio:[]},setting:'东汉末年疫病流行区域地图'}]}
  const action={duration:3,coveredBeatIds:['beat-01'],characters:[],presentCharacters:[],audioType:'环境声',audioText:'',videoPrompt:'',
    pacing:{version:'duration-v2',actorGroups:[],beats:[{id:'map-display-beat',sourceBeatId:'beat-01',actorIds:[],kind:'action',
      textOrVocalization:'地图高亮中原区域',dependsOn:[],overlapAllowedWith:[],
      durationEstimate:{lower:1,expected:1.5,upper:2,source:'地图动画动作预算',confidence:'high'},
      completion:{requiredThisClip:true,finalState:'中原区域已高亮',modality:'visual',evidenceAnchor:'地图高亮中原区域'}}]}}
  const compiled=compileDurationSchedule(action,{scene})
  assert.deepEqual(compiled.schedule[0].actorIds,[])
  assert.match(compiled.videoPrompt,/地图高亮中原区域/)
  const characterScene={...scene,editorialRole:'story',visualTreatment:'live_action'}
  assert.throws(()=>compileDurationSchedule(action,{scene:characterScene}),/缺少或无效字段：actorIds/)
  const illustrationScene={...scene,visualTreatment:'animated',animationStyle:'character_illustration',cast:['张角']}
  const illustrationAction={...structuredClone(action),characters:['张角'],presentCharacters:['张角']}
  assert.doesNotThrow(()=>compileDurationSchedule(illustrationAction,{scene:illustrationScene}),
    'background motion in a named static-illustration shot must not be attributed to the character')
  const namedScene={...illustrationScene,requiredBeats:[{...scene.requiredBeats[0],description:'张角人物插画淡入',mustShow:['张角人物插画淡入'],
    observable:{visual:['张角人物插画淡入'],audio:[]}}]}
  const namedAction=structuredClone(illustrationAction);namedAction.pacing.beats[0].textOrVocalization='张角人物插画淡入'
  namedAction.pacing.beats[0].completion={...namedAction.pacing.beats[0].completion,evidenceAnchor:'张角人物插画淡入',finalState:'张角人物插画已淡入'}
  assert.throws(()=>compileDurationSchedule(namedAction,{scene:namedScene}),/缺少或无效字段：actorIds/)
  const fakeCrowd=structuredClone(action);fakeCrowd.pacing.beats[0].actorIds=['饥民群众']
  assert.throws(()=>compileDurationSchedule(fakeCrowd,{scene}),/使用未声明角色或群体/)
})

test('source-grounded natural environment retains actorless motion beside present named performers',()=>{
  const scene={cast:['守桥人'],editorialRole:'context_bridge',visualTreatment:'live_action',requiredBeats:[{
    id:'environment-source',setting:'山谷溪岸',description:'水面倒映月光；溪水流动',mustShow:['水面倒映月光','溪水流动'],
    observable:{visual:['水面倒映月光','溪水流动'],audio:['溪水流动声','远处马蹄声渐近']}}]}
  const beat={id:'water-view',sourceBeatId:'environment-source',actorIds:[] as string[],kind:'action' as const,
    textOrVocalization:'镜头缓慢上移展现水面倒映月光，溪水流动',dependsOn:[] as string[],overlapAllowedWith:[] as string[],
    timingConstraint:{mode:'reference' as const},
    durationEstimate:{lower:1,expected:1.5,upper:2,source:'已批准环境呈现预算',confidence:'high' as const},
    completion:{requiredThisClip:true,finalState:'水面倒映月光，溪水流动的画面已完整呈现',modality:'visual' as const,
      evidenceAnchor:'水面倒映月光，溪水流动'}}
  const shot={duration:3,characters:['守桥人'],presentCharacters:['守桥人'],coveredBeatIds:['environment-source'],
    audioType:'环境声',audioText:'',videoPrompt:'',pacing:{version:'duration-v2',actorGroups:[],beats:[beat]}}
  const before=structuredClone(shot),sourceBefore=structuredClone(scene)
  const compiled=compileDurationSchedule(shot,{scene})
  assert.deepEqual(compiled.pacing.beats,shot.pacing.beats)
  assert.deepEqual(compiled.schedule[0].actorIds,[])
  assert.equal(compiled.duration,3)
  assert.match(compiled.videoPrompt,/镜头缓慢上移展现水面倒映月光，溪水流动/)
  assert.deepEqual(shot,before);assert.deepEqual(scene,sourceBefore)
  const stored={...shot,...compiled}
  assert.deepEqual(stored.pacing.sourceBeatRequirements[0].environmentAnchors,
    ['水面倒映月光','溪水流动','溪水流动声','远处马蹄声渐近'])
  assert.doesNotThrow(()=>verifyDurationSchedule(stored), 'paid verification uses the same signed source facts without a scene object')
  assert.doesNotThrow(()=>verifyDurationSchedule(stored,{scene}))
  const tampered=structuredClone(stored)
  tampered.pacing.sourceBeatRequirements[0].environmentAnchors.push('天空')
  assert.throws(()=>verifyDurationSchedule(tampered),/哈希失效/)
  assert.throws(()=>verifyDurationSchedule(tampered,{scene}),/哈希失效|派生字段/)
  for(const anchor of ['士兵入场','桥板断裂','人声回应']){
    const invalidSnapshot=structuredClone(stored)
    invalidSnapshot.pacing.sourceBeatRequirements[0].environmentAnchors=[anchor]
    assert.throws(()=>verifyDurationSchedule(invalidSnapshot),/environmentAnchors/,anchor)
  }
  const injected={...shot,pacing:{...shot.pacing,sourceBeatRequirements:[{id:'environment-source',anchors:[],setting:'山谷溪岸',environmentAnchors:['水面倒映月光','溪水流动']} ]}}
  assert.throws(()=>compileDurationSchedule(injected,{scene:{...scene,requiredBeats:[{...scene.requiredBeats[0],description:'人物站立',mustShow:[],observable:{visual:[],audio:[]}}]}}),/actorIds/,
    'fresh candidate metadata cannot replace the authoritative source')
  const named={...shot,pacing:{...shot.pacing,beats:[{...beat,actorIds:['守桥人']}]}}
  const namedCompiled=compileDurationSchedule(named,{scene})
  const legacyPacing={...namedCompiled.pacing, scheduleHash:undefined,sourceBeatRequirements:namedCompiled.pacing.sourceBeatRequirements.map(row=>{
    const legacy={...row};delete legacy.environmentAnchors;return legacy
  })}
  const legacy=compileDurationSchedule({...named,pacing:legacyPacing})
  assert.doesNotThrow(()=>verifyDurationSchedule({...named,...legacy},{scene}),
    'an existing signed scene without the optional snapshot retains its original source contract')
  const sound={...beat,id:'water-sound',textOrVocalization:'溪水流动声，远处隐约传来马蹄声渐近',
    completion:{...beat.completion,modality:'audio' as const,finalState:'溪水流动声，远处隐约传来马蹄声渐近已清晰呈现',
      evidenceAnchor:'溪水流动声，远处马蹄声渐近'}}
  const soundOnly={...shot,pacing:{...shot.pacing,beats:[sound]}}
  const audioSource={...scene,requiredBeats:[{...scene.requiredBeats[0],mustShow:[]}]}
  assert.doesNotThrow(()=>compileDurationSchedule(soundOnly,{scene:audioSource}))
  for(const text of ['远处马蹄声渐远','远处传来人声','溪水流动声，士兵喊话','溪水流动声，马匹冲入画面']){
    assert.throws(()=>compileDurationSchedule({...soundOnly,pacing:{...soundOnly.pacing,beats:[{...sound,textOrVocalization:text}]}},{scene:audioSource}),/actorIds/,text)
  }
  for(const text of ['水面倒映月光，士兵走入画面','水面倒映月光，群众齐声回应','水面倒映月光，守桥人持木板',
    '水面倒映月光，桥板断裂','水面倒映月光，木架倒塌','河水流动','水面并未倒映月光','准备展现水面倒映月光']){
    const body={...beat,textOrVocalization:text}
    assert.throws(()=>compileDurationSchedule({...shot,pacing:{...shot.pacing,beats:[body]}},{scene}),/actorIds/,text)
  }
  for(const field of ['performanceInstruction','finalState','evidenceAnchor']){
    const body=structuredClone(beat)
    if(field==='performanceInstruction') Object.assign(body,{performanceInstruction:'镜头从守桥人持木板的画面上移，展现水面倒映月光'})
    else Object.assign(body.completion,{[field]:'水面倒映月光，守桥人持木板'})
    assert.throws(()=>compileDurationSchedule({...shot,pacing:{...shot.pacing,beats:[body]}},{scene}),/actorIds/,field)
  }
  assert.throws(()=>compileDurationSchedule({...shot,pacing:{...shot.pacing,beats:[{...beat,sourceBeatId:'another-source'}]}},{scene}),/sourceBeatId/)
  const props={...scene,requiredBeats:[{...scene.requiredBeats[0],mustShow:['桥板断裂'],observable:{visual:['桥板断裂'],audio:[]}}]}
  const propBeat={...beat,textOrVocalization:'桥板断裂',completion:{...beat.completion,finalState:'桥板断裂',evidenceAnchor:'桥板断裂'}}
  assert.throws(()=>compileDurationSchedule({...shot,pacing:{...shot.pacing,beats:[propBeat]}},{scene:props}),/actorIds/,
    'even an approved prop action still needs its performer binding')
})

test('historical tableau accepts reordered medium wording and compiles a frozen tail window',()=>{
  const anchor='洛阳城外荒凉田野定格画面、饥民倒卧路旁、病患躺卧呻吟'
  const scene={editorialRole:'episode_opening',visualTreatment:'animated',animationStyle:'historical_tableau',cast:[],requiredBeats:[{
    id:'beat-01',description:anchor,mustShow:[anchor],observable:{visual:[anchor],audio:[]},setting:'洛阳城外荒凉田野'}]}
  const action={duration:7,coveredBeatIds:['beat-01'],characters:[],presentCharacters:[],audioType:'环境声',audioText:'',videoPrompt:'',
    pacing:{version:'duration-v2',actorGroups:[],beats:[{id:'tableau',sourceBeatId:'beat-01',actorIds:[],kind:'action',
      textOrVocalization:'定格历史场景画面呈现洛阳城外荒凉田野，饥民倒卧路旁，病患躺卧呻吟',dependsOn:[],overlapAllowedWith:[],
      durationEstimate:{lower:4,expected:4.5,upper:5,source:'定格画展示预算',confidence:'high'},
      completion:{requiredThisClip:true,finalState:'困境已呈现',modality:'visual',evidenceAnchor:anchor}}]}}
  const compiled=compileDurationSchedule(action,{scene})
  assert.match(compiled.videoPrompt,/5-7秒：.*画中人物与物件保持定格.*整幅画保持静止/)
  assert.deepEqual(collectDurationCoverageDiagnostics(action,{scene}),[])
})

test('historical tableau accepts a frozen figure attribute after the head noun across action beats',()=>{
  const anchor='定格历史场景插画呈现干裂农田、流离饥民、躺卧病患、画面推进至张角手持符水的人物形象'
  const scene={editorialRole:'episode_opening',visualTreatment:'animated',animationStyle:'historical_tableau',cast:[],requiredBeats:[{
    id:'beat-01',description:anchor,mustShow:[anchor],observable:{visual:[anchor],audio:[]},setting:'灾荒中的村野'}]}
  const action={duration:7,coveredBeatIds:['beat-01'],characters:[],presentCharacters:[],audioType:'环境声',audioText:'',videoPrompt:'',
    pacing:{version:'duration-v2',actorGroups:[],beats:[
      {id:'tableau',sourceBeatId:'beat-01',actorIds:[],kind:'action',textOrVocalization:'定格历史场景插画呈现干裂农田、流离饥民、躺卧病患',dependsOn:[],overlapAllowedWith:[],durationEstimate:{lower:2,expected:2.5,upper:3,source:'定格展示',confidence:'high'},completion:{requiredThisClip:true,finalState:'灾荒已呈现',modality:'visual',evidenceAnchor:anchor}},
      {id:'figure',sourceBeatId:'beat-01',actorIds:[],kind:'action',textOrVocalization:'画面轻微推进至张角人物形象手持符水',dependsOn:['tableau'],overlapAllowedWith:[],durationEstimate:{lower:2,expected:2.5,upper:3,source:'二维推进',confidence:'high'},completion:{requiredThisClip:true,finalState:'张角形象已呈现',modality:'visual',evidenceAnchor:anchor}},
    ]}}
  assert.deepEqual(collectDurationCoverageDiagnostics(action,{scene}),[])
  assert.doesNotThrow(()=>compileDurationSchedule(action,{scene}))
  const missing=structuredClone(action);missing.pacing.beats[1].textOrVocalization='画面轻微推进至张角人物形象手持药碗'
  assert.match(collectDurationCoverageDiagnostics(missing,{scene}).join('\n'),/可执行正文缺少原锚点/)
})

test('an approved indefinite crowd action matches only the same positive visible subgroup action',()=>{
  assert.equal(enactedVisualTextCovers('数十名饥民中有的低声呻吟','有人呻吟'),true)
  assert.equal(enactedVisualTextCovers('数十名饥民中有人呻吟','有人呻吟'),true)
  assert.equal(enactedVisualTextCovers('数十名饥民中有的低声哭泣','有人呻吟'),false)
  assert.equal(enactedVisualTextCovers('镜头没有拍到有人呻吟','有人呻吟'),false)
})

test('full storyboard validator uses the compiled clock and keeps group voices out of lexical audioText',()=>{
  const result=validateHistoricalStructuredOutput('history.storyboard',chantShot(),{scene:chantScene,pacingVersion:'duration-v2',requireDynamicPacing:true}) as ReturnType<typeof chantShot>&{scheduleHash:string}
  assert.equal(result.duration,9);assert.equal(result.audioText,chantShot().audioText)
  assert.match(result.videoPrompt,/已声明的无词群体声部必须实际可听/)
  assert.doesNotMatch(result.videoPrompt,/仅传唱歌谣的乡人/)
  assert.equal(historyTailSeconds(result),.5)
  assert.doesNotThrow(()=>verifyDurationSchedule(result))
  const media=deriveDurationMediaRequest(result)
  assert.equal(media.speechRequired,true);assert.equal(media.nonLexicalAudioRequired,true)
  assert.equal(media.vocalizations.length,1);assert.equal(media.latestSpeechEnd,8.5)
  const failing={...chantShot(),duration:6}
  assert.ok(collectHistoricalStoryboardDiagnostics(failing,{scene:chantScene,pacingVersion:'duration-v2'}).every(error=>!error.includes('actionSeconds')))
})

test('shared speech policy budgets recital independently and is runnable in a persisted code node',()=>{
  const dialogue=estimateSpeechDuration(songText,'dialogue'),chant=estimateSpeechDuration(songText,'chant')
  assert.ok(dialogue.upper>=14/3.3+.15+.25)
  assert.ok(chant.upper>dialogue.upper)
  assert.equal(estimateSpeechDuration('先说：完整原文','dialogue').characters,6)
  const inline=new Function(`${DURATION_POLICY_RUNTIME_CODE};return estimateSpeechDuration(${JSON.stringify(songText)},'chant');`)()
  assert.deepEqual(inline,chant)
  for(const value of ['',{},'中文',{z:[1,true,songText],a:2}]) assert.equal(durationContentHash(value),createHash('sha256').update(durationCanonicalJson(value)).digest('hex'))
})

test('the one-millisecond speech budget allowance absorbs only floating-point roundoff',()=>{
  const text = '桓帝初为蠡吾侯时,曾受学于甘陵周福。延熹九年,桓帝即位,擢周福为尚书。'
  const base = estimateSpeechDuration(text, 'narration')
  assert.deepEqual([base.lower, base.expected, base.upper], [5.566, 6.123, 6.655])
  const candidate = { duration: 8, coveredBeatIds: ['beat-01'], characters: [], audioType: '旁白', audioText: text, videoPrompt: '',
    pacing: { version: 'duration-v2', beats: [{ id: 'beat-01-narration', sourceBeatId: 'beat-01', actorIds: ['旁白'],
      kind: 'speech', deliveryStyle: 'narration', textOrVocalization: text, dependsOn: [], overlapAllowedWith: [],
      durationEstimate: { lower: base.lower - .001, expected: base.expected - .001, upper: base.upper - .001, source: '实际模型预算', confidence: 'high' },
      completion: { requiredThisClip: true, finalState: '旁白完整说完', modality: 'audio', evidenceAnchor: text } }] } }
  const before = JSON.stringify(candidate)
  const compiled = compileDurationSchedule(candidate)
  assert.equal(compiled.pacing.beats[0].durationEstimate.upper, base.upper - .001, 'comparison does not rewrite the authored budget')
  assert.equal(compiled.pacing.timingPolicy.measurementToleranceSeconds, .25)
  assert.equal(JSON.stringify(candidate), before)
  for (const field of ['lower', 'expected', 'upper'] as const) {
    const boundary = structuredClone(candidate)
    boundary.pacing.beats[0].durationEstimate[field] = base[field] - .001
    assert.doesNotThrow(() => compileDurationSchedule(boundary), `${field} permits exactly the existing 1 ms allowance`)
    assert.deepEqual(collectDurationSpeechBudgetDiagnostics(boundary), [])
    boundary.pacing.beats[0].durationEstimate[field] = base[field] - .0010001
    assert.throws(() => compileDurationSchedule(boundary), /声部预算低于 narration 共享策略/, `${field} rejects a genuine shortfall greater than 1 ms`)
    assert.equal(collectDurationSpeechBudgetDiagnostics(boundary).length, 1)
  }
})

test('independent speech diagnostics report every known deficient beat despite earlier coverage and shape errors',()=>{
  const first = structuredClone(chantShot().pacing.beats[1])
  first.durationEstimate.upper = 4.4
  const second = { ...structuredClone(first), id: 'second-narration', deliveryStyle: 'narration' }
  second.durationEstimate = { ...second.durationEstimate, lower: .1, expected: .1, upper: .1 }
  const candidate = { ...chantShot(), coveredBeatIds: ['missing-source'], pacing: { version: 'duration-v2',
    beats: [null, { id: 'unknown-shape' }, first, second, { ...first, id: 'unknown-style', deliveryStyle: 'unknown' },
      { ...first, id: 'unknown-budget', durationEstimate: { lower: '3.3', expected: 4.4, upper: 4.4 } },
      { ...first, id: 'inverted-budget', durationEstimate: { lower: 4, expected: 3, upper: 2 } },
      { ...first, id: 'unsupported-language', textOrVocalization: 'Unknown English speech' }] } }
  const before = JSON.stringify(candidate)
  const freeze = (value: unknown) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } }
  freeze(candidate)
  assert.throws(() => compileDurationSchedule(candidate, { scene: chantScene }), /STORYBOARD_COVERAGE_INCOMPLETE:/)
  const diagnostics = collectDurationSpeechBudgetDiagnostics(candidate)
  assert.equal(diagnostics.length, 2)
  assert.match(diagnostics[0], /^STORYBOARD_PACING_INVALID: lead-song 声部预算低于 chant 共享策略：/)
  assert.match(diagnostics[1], /^STORYBOARD_PACING_INVALID: second-narration 声部预算低于 narration 共享策略：/)
  const compilerCandidate = chantShot(); compilerCandidate.pacing.beats[1] = first
  assert.throws(() => compileDurationSchedule(compilerCandidate, { scene: chantScene }), (error: Error) => error.message === diagnostics[0])
  assert.equal(JSON.stringify(candidate), before)
  for (const value of [null, [], {}, { pacing: null }, { pacing: { version: 'duration-v2', beats: null } }]) {
    assert.deepEqual(collectDurationSpeechBudgetDiagnostics(value), [])
  }
  assert.deepEqual(collectDurationSpeechBudgetDiagnostics(candidate, { timingPolicy: {} }), [])
})

test('speech diagnostics use the approved shared policy without rewriting candidate estimates',()=>{
  const candidate = chantShot()
  assert.deepEqual(collectDurationSpeechBudgetDiagnostics(candidate), [])
  const policy = structuredClone(candidate.pacing.timingPolicy)
  policy.speech.chant.startupAllowance = 1
  const diagnostics = collectDurationSpeechBudgetDiagnostics(candidate, { timingPolicy: policy })
  assert.equal(diagnostics.length, 1)
  const approved = structuredClone(candidate); approved.pacing.timingPolicy = policy
  assert.throws(() => compileDurationSchedule(approved, { scene: chantScene, timingPolicy: policy }),
    (error: Error) => error.message === diagnostics[0])
})

function twoNarrationVoices() {
  const texts = ['桓帝初为蠡吾侯时,曾受学于甘陵周福。延熹九年,桓帝即位,擢周福为尚书。', '同郡河南尹房植,字伯武,素有名望于朝中。']
  return texts.map((text, index) => ({ id: `narration-${index + 1}`, sourceBeatId: `beat-${index + 1}`, actorIds: ['旁白'],
    kind: 'speech', deliveryStyle: 'narration', textOrVocalization: text, dependsOn: [], overlapAllowedWith: [],
    durationEstimate: { lower: .5, expected: .75, upper: 1, source: '未充分预算的原候选', confidence: 'low' },
    completion: { requiredThisClip: true, finalState: '旁白完整说完', modality: 'audio', evidenceAnchor: text } }))
}

test('independent voice layout reveals mixed tracks and the natural speech-only overflow before budget or actor repairs',()=>{
  const voices = twoNarrationVoices()
  const song = { ...structuredClone(chantShot().pacing.beats[1]), sourceBeatId: 'beat-3' }
  const candidate = { audioType: '旁白+吟唱', pacing: { version: 'duration-v2', actorGroups: [{}], beats: [...voices, song] } }
  const before = JSON.stringify(candidate)
  const diagnostics = collectDurationVoiceLayoutDiagnostics(candidate)
  assert.equal(diagnostics.length, 2)
  assert.match(diagnostics[0], /^STORYBOARD_PACING_INVALID: 对白轨不能将声部伪装为画外旁白.*连续 segments/)
  assert.match(diagnostics[1], /STORYBOARD_TIMING_OVERFLOW:.*"id":"narration-1".*"upper":6.655.*"id":"narration-2".*"upper":3.891/)
  const pair = { audioType: '旁白', pacing: { version: 'duration-v2', actorGroups: [{}], beats: voices } }
  assert.equal(collectDurationVoiceLayoutDiagnostics(pair).length, 0)
  assert.equal(JSON.stringify(candidate), before)
  const conservative = structuredClone(pair); conservative.pacing.beats[0].durationEstimate.upper = 11
  assert.match(collectDurationVoiceLayoutDiagnostics(conservative)[0], /"upper":11.*声部合计 14.891 秒/)
})

test('voice layout refuses duplicate or unknown performance data and does not serialize possibly parallel vocalizations',()=>{
  const candidate = { pacing: { version: 'duration-v2', beats: twoNarrationVoices() } }
  const unknowns = [
    { ...candidate, pacing: { ...candidate.pacing, beats: [null, ...candidate.pacing.beats] } },
    { ...candidate, pacing: { ...candidate.pacing, beats: [{ ...candidate.pacing.beats[0], deliveryStyle: 'unknown' }, candidate.pacing.beats[1]] } },
    { ...candidate, pacing: { ...candidate.pacing, beats: [{ ...candidate.pacing.beats[0], textOrVocalization: '' }, candidate.pacing.beats[1]] } },
    { ...candidate, pacing: { ...candidate.pacing, beats: [{ ...candidate.pacing.beats[0], durationEstimate: null }, candidate.pacing.beats[1]] } },
    { ...candidate, pacing: { ...candidate.pacing, beats: [...candidate.pacing.beats, candidate.pacing.beats[0]] } },
    { ...candidate, pacing: { ...candidate.pacing, beats: [...candidate.pacing.beats, { ...candidate.pacing.beats[0], id: 'duplicate-content' }] } },
  ]
  for (const value of unknowns) assert.deepEqual(collectDurationVoiceLayoutDiagnostics(value), [])
  assert.deepEqual(collectDurationVoiceLayoutDiagnostics(candidate, { timingPolicy: {} }), [])
  const chant = chantShot(); chant.pacing.beats[2].durationEstimate.upper = 20
  assert.deepEqual(collectDurationVoiceLayoutDiagnostics(chant), [], 'a potentially parallel nonlexical voice cannot be counted as serial lexical speech')
})

test('voice-only overflow respects the existing millisecond allowance at the provider boundary',()=>{
  const candidate = chantShot()
  candidate.duration = 15
  candidate.pacing.timingPolicy.endingReadabilityReserve = 4.201
  const first = structuredClone(candidate.pacing.beats[1]); first.dependsOn = []; first.durationEstimate.upper = 5.399
  const second = { ...structuredClone(first), id: 'second-song', sourceBeatId: 'second-source', textOrVocalization: songText.replace('仲进', '仲新') }
  candidate.pacing.beats = [first, second]
  candidate.coveredBeatIds = [first.sourceBeatId, second.sourceBeatId]
  candidate.audioText = `${candidate.characters[0]}:${first.textOrVocalization}\n${candidate.characters[0]}:${second.textOrVocalization}`
  assert.doesNotThrow(() => compileDurationSchedule(candidate))
  assert.deepEqual(collectDurationVoiceLayoutDiagnostics(candidate), [], 'natural uppers total 15.001 s but existing 1 ms per-voice allowance still permits 15 s')
  candidate.pacing.beats[1].durationEstimate.upper = 5.402
  assert.throws(() => compileDurationSchedule(candidate), /STORYBOARD_TIMING_OVERFLOW:/)
  assert.match(collectDurationVoiceLayoutDiagnostics(candidate)[0], /STORYBOARD_TIMING_OVERFLOW:/)
})

test('production minification preserves the isolated shared-policy runtime',async()=>{
  const {build}=await import('vite')
  const result=await build({configFile:false,logLevel:'silent',build:{write:false,minify:true,
    lib:{entry:'src/duration-policy.ts',formats:['iife'],name:'DurationPolicyBundle'}}})
  const output=Array.isArray(result)?result[0]:result
  const chunk=output.output.find(row=>row.type==='chunk')
  assert.ok(chunk)
  const bundled=new Function(chunk.code+';return DurationPolicyBundle;')()
  const inline=new Function(`${bundled.DURATION_POLICY_RUNTIME_CODE};return estimateSpeechDuration(${JSON.stringify(songText)},'chant');`)()
  assert.deepEqual(inline,estimateSpeechDuration(songText,'chant'))
})

test('zero-word humming cannot become zero-time or an undeclared silent crowd',()=>{
  const short=chantShot();short.pacing.beats[2].durationEstimate={lower:.1,expected:.1,upper:.1,source:'zero words',confidence:'low'}
  assert.throws(()=>compileDurationSchedule(short,{scene:chantScene}),/无词声部不能按零汉字/)
  const hidden=chantShot();hidden.pacing.actorGroups=[]
  assert.throws(()=>compileDurationSchedule(hidden,{scene:chantScene}),/未声明角色或群体/)
  const missingVoice=chantShot();missingVoice.pacing.beats[2].kind='reaction'
  assert.throws(()=>compileDurationSchedule(missingVoice,{scene:chantScene}),/实际发声义务/)
  const conflict=chantShot();conflict.videoPrompt='仅传唱歌谣的乡人在逐句时间窗内自然开口发声，其他人物倾听。'
  assert.throws(()=>compileDurationSchedule(conflict,{scene:chantScene}),/声部冲突/)
})

test('dependencies and actor resources reject invented parallelism but permit walking while speaking',()=>{
  const impossible=chantShot()
  impossible.pacing.beats[0].overlapAllowedWith=['lead-song'];impossible.pacing.beats[1].overlapAllowedWith=['opening']
  assert.throws(()=>compileDurationSchedule(impossible,{scene:chantScene}),/同时声明先后依赖和并行/)
  const walking=chantShot();walking.pacing.beats[1].dependsOn=[]
  walking.pacing.beats[0].overlapAllowedWith=['lead-song'];walking.pacing.beats[1].overlapAllowedWith=['opening']
  const parallel=compileDurationSchedule(walking,{scene:chantScene})
  assert.equal(parallel.schedule[1].startSecond,0)
  const window=parallel.pacing.timelineWindows[0]
  assert.deepEqual(window.beatIds,['opening','lead-song'])
  assert.equal(window.beatQuotes?.length,2)
  assert.ok(window.beatQuotes?.every(row=>parallel.videoPrompt.includes(row.quote)))
  assert.equal(parallel.videoPrompt.split(songText).length-1,1,'the full spoken line is emitted once instead of replayed at intermediate subwindows')
  const hands=chantShot();hands.pacing.beats[1].kind='action';delete hands.pacing.beats[1].deliveryStyle
  hands.audioType='环境声';hands.audioText='';hands.pacing.beats[1].textOrVocalization='传唱歌谣的乡人递出卷轴';hands.pacing.beats[1].dependsOn=[]
  hands.pacing.beats[0].overlapAllowedWith=['lead-song'];hands.pacing.beats[1].overlapAllowedWith=['opening']
  const freeScene={...chantScene,requiredBeats:[{...chantScene.requiredBeats[0],mustShow:[]}]}
  assert.throws(()=>compileDurationSchedule(hands,{scene:freeScene}),/抢占同一主体资源/)
})

test('real writer format mistakes identify the exact missing field for repair without inventing action content',()=>{
  const missing=chantShot()
  missing.pacing.beats[0].performanceInstruction=missing.pacing.beats[0].textOrVocalization
  delete (missing.pacing.beats[0] as Partial<typeof missing.pacing.beats[0]>).textOrVocalization
  assert.throws(()=>compileDurationSchedule(missing,{scene:chantScene}),/beats\[0\] opening.*textOrVocalization.*performanceInstruction 不能代替/)
  const resources=chantShot();resources.pacing.beats[0].resources=[]
  assert.throws(()=>compileDurationSchedule(resources,{scene:chantScene}),/resources.*须为非空.*不能填 \[\]/)
})

test('validation resolves lossless action aliases and empty resource declarations without changing content or budget',()=>{
  for (const kind of ['action','reaction'] as const) {
    const candidate=chantShot()
    const beat=candidate.pacing.beats[0]
    beat.kind=kind
    beat.performanceInstruction=beat.textOrVocalization
    delete (beat as Partial<typeof beat>).textOrVocalization
    beat.resources=[]
    const before=JSON.stringify(candidate)
    const expected=structuredClone(candidate)
    expected.pacing.beats[0].textOrVocalization=beat.performanceInstruction
    expected.pacing.beats[0].resources=kind==='action'?['body','hands']:['attention','body']
    const normalized=validateHistoricalStructuredOutput('history.storyboard',candidate,{scene:chantScene,pacingVersion:'duration-v2'}) as ReturnType<typeof compileDurationSchedule>
    const explicit=validateHistoricalStructuredOutput('history.storyboard',expected,{scene:chantScene,pacingVersion:'duration-v2'}) as ReturnType<typeof compileDurationSchedule>
    assert.equal(JSON.stringify(candidate),before,'the actual model response remains immutable')
    assert.equal(normalized.pacing.beats[0].textOrVocalization,beat.performanceInstruction)
    assert.equal(normalized.pacing.beats[0].performanceInstruction,beat.performanceInstruction)
    assert.deepEqual(normalized.pacing.beats[0].durationEstimate,beat.durationEstimate)
    assert.deepEqual(normalized.pacing.schedule,explicit.pacing.schedule)
    assert.equal(normalized.pacing.scheduleHash,explicit.pacing.scheduleHash)
    assert.doesNotThrow(()=>verifyDurationSchedule(normalized))
  }
})

test('approved source settings survive compilation and hashing without letting static mentions replace actions',()=>{
  const scene=structuredClone(chantScene)
  scene.requiredBeats[0].mustShow.push('街巷')
  const candidate=chantShot()
  candidate.pacing.beats[0].textOrVocalization='传唱歌谣的乡人行走，进入人群可听见的位置'
  const compiled=compileDurationSchedule(candidate,{scene})
  assert.equal(compiled.pacing.sourceBeatRequirements[0].setting,'甘陵街巷')
  assert.match(compiled.pacing.timelineWindows[0].beatQuotes![0].quote,/场景：甘陵街巷；/)
  assert.equal(compiled.videoPrompt.split('场景：甘陵街巷').length-1,1)
  assert.doesNotThrow(()=>verifyDurationSchedule({...candidate,...compiled}))
  const tampered=structuredClone({...candidate,...compiled})
  tampered.pacing.sourceBeatRequirements[0].setting='甘陵庭院'
  assert.throws(()=>verifyDurationSchedule(tampered),/原锚点 街巷|哈希失效/)
  scene.requiredBeats[0].mustShow.push('转身递出书卷')
  candidate.visualPrompt+='。乡人转身递出书卷。'
  assert.throws(()=>compileDurationSchedule(candidate,{scene}),/可执行正文缺少原锚点 转身递出书卷/)
})

test('raw eleven-second planning selects the proved fifteen-second budget but paid verification never repairs tampering',()=>{
  const raw=chantShot();raw.duration=11
  raw.pacing.beats[0].durationEstimate={lower:3.5,expected:4.2,upper:5,source:'完整进入位置的导演预算',confidence:'low'}
  const reaction={...structuredClone(raw.pacing.beats[2]),id:'crowd-look',kind:'reaction' as const,textOrVocalization:'围观乡人侧耳并点头',
    durationEstimate:{lower:1.5,expected:2,upper:2.5,source:'先侧耳后点头',confidence:'low' as const}}
  delete reaction.vocalization
  raw.pacing.beats[2].dependsOn=['crowd-look'];raw.pacing.beats[2].durationEstimate={lower:.8,expected:1.2,upper:1.5,source:'可听短促回应',confidence:'low'}
  raw.pacing.beats.splice(2,0,reaction)
  const before=JSON.stringify(raw)
  assert.throws(()=>compileDurationSchedule(raw,{scene:chantScene}),/安全预算 15 秒/)
  const compiled=compileDurationSchedule(raw,{scene:chantScene,selectDuration:true})
  assert.equal(compiled.duration,15);assert.equal(compiled.timingEstimate.modelDuration,11)
  assert.equal(compiled.timingEstimate.durationAdjustmentReason,'increased-to-safe-budget')
  assert.deepEqual(compiled.schedule.map(row=>[row.startSecond,row.endSecond]),[[0,5],[5,10.5],[10.5,13],[13,14.5]])
  assert.equal(JSON.stringify(raw),before)
  const approved=validateHistoricalStructuredOutput('history.storyboard',raw,{scene:chantScene,pacingVersion:'duration-v2'}) as ReturnType<typeof compileDurationSchedule>
  assert.equal(approved.duration,15);assert.equal(approved.timingEstimate.modelDuration,11)
  assert.doesNotThrow(()=>verifyDurationSchedule(approved))
  assert.throws(()=>verifyDurationSchedule({...approved,duration:11}),/安全预算 15 秒/)
  assert.throws(()=>compileDurationSchedule({...approved,duration:11},{verifyStoredHash:true,selectDuration:true}),/安全预算 15 秒/)
  const overflow=structuredClone(raw);overflow.pacing.beats[0].durationEstimate.upper=5.1
  assert.throws(()=>compileDurationSchedule(overflow,{scene:chantScene,selectDuration:true}),/STORYBOARD_TIMING_OVERFLOW/)
})

test('compiled entrance accepts a complete long declared path and still forbids speaking before true arrival',()=>{
  const candidate=chantShot()
  const path='从街巷左侧沿土路向画面中央偏左位置走来'
  candidate.initialCharacters=[]
  candidate.enteringCharacters=[{name:candidate.characters[0],startSecond:0,endSecond:.8,path}] as never[]
  candidate.pacing.beats[0].textOrVocalization=path
  candidate.pacing.beats[0].performanceInstruction='乡人行走'
  assert.doesNotThrow(()=>validateHistoricalStructuredOutput('history.storyboard',candidate,{scene:chantScene,pacingVersion:'duration-v2'}))
  candidate.pacing.beats[1].dependsOn=[]
  candidate.pacing.beats[0].overlapAllowedWith=['lead-song'];candidate.pacing.beats[1].overlapAllowedWith=['opening']
  assert.throws(()=>validateHistoricalStructuredOutput('history.storyboard',candidate,{scene:chantScene,pacingVersion:'duration-v2'}),/真正入场须在 0.8 秒完成后再发声/)
})

test('punctuation-only evidence anchors do not repeat a complete lyric in the generation timeline',()=>{
  const raw=chantShot()
  raw.pacing.beats[1].textOrVocalization=songText.replace(',', '，')
  const scene=structuredClone(chantScene);scene.requiredBeats[0].mustShow[0]=songText.replace(',', '，')
  const compiled=compileDurationSchedule(raw,{scene})
  const lexical=compiled.videoPrompt.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu,'')
  assert.equal(lexical.split(songText.replace(',','')).length-1,1)
  assert.equal(compiled.pacing.beats[1].completion.evidenceAnchor,songText)
  assert.equal(compiled.pacing.beats[1].textOrVocalization,songText.replace(',', '，'))
})

test('source coverage, order, natural lower bounds, and over-fifteen split signal cannot be bypassed',()=>{
  const missing=chantShot();missing.pacing.beats.pop()
  assert.throws(()=>compileDurationSchedule(missing,{scene:chantScene}),/可执行正文缺少原锚点/)
  assert.throws(()=>compileDurationSchedule(chantShot(),{scene:{...chantScene,requiredBeats:[...chantScene.requiredBeats,{id:'omitted',mustShow:[]}]}}),/完整覆盖/)
  const fast=chantShot();fast.pacing.beats[1].durationEstimate.upper=4.4
  assert.throws(()=>compileDurationSchedule(fast,{scene:chantScene}),/共享策略/)
  const long=chantShot();long.pacing.beats[1].durationEstimate.upper=14
  assert.throws(()=>compileDurationSchedule(long,{scene:chantScene}),/STORYBOARD_TIMING_OVERFLOW/)
  const cycle=chantShot();cycle.pacing.beats[0].dependsOn=['crowd-response']
  assert.throws(()=>compileDurationSchedule(cycle,{scene:chantScene}),/依赖成环/)
  const hard=chantShot();hard.pacing.beats[1].timingConstraint={mode:'hard',deadlineSecond:4}
  assert.throws(()=>compileDurationSchedule(hard,{scene:chantScene}),/超过硬截止/)
  const deferred=chantShot();deferred.pacing.beats[1].completion.requiredThisClip=false
  assert.throws(()=>compileDurationSchedule(deferred,{scene:chantScene}),/本镜已编排的声部必须/)
})

const threeBeatScene = { id: 'scene-01', requiredBeats: [
  { id: 'beat-01', description: '乡人行走于街市', setting: '甘陵街市', mustShow: ['乡人行走', '街市景象'] },
  { id: 'beat-02', description: '乡人继续行走', setting: '甘陵街市', mustShow: ['乡人继续行走'] },
  { id: 'beat-03', description: '乡人驻足', setting: '甘陵街市', mustShow: ['乡人驻足'] },
] }
function sourceBeatShot(index = 0) {
  const source = threeBeatScene.requiredBeats[index]
  return { duration: 3, coveredBeatIds: [source.id], characters: ['传谣乡人'], audioType: '环境声', audioText: '', videoPrompt: '',
    pacing: { version: 'duration-v2', beats: [{ id: `${source.id}-action`, sourceBeatId: source.id, actorIds: ['传谣乡人'], kind: 'action',
      textOrVocalization: source.mustShow.join('，'), dependsOn: [], overlapAllowedWith: [],
      durationEstimate: { lower: 1, expected: 1.5, upper: 2, source: '原动作导演预算', confidence: 'medium' },
      completion: { requiredThisClip: true, finalState: source.description, modality: 'visual', evidenceAnchor: source.mustShow[0] } }] } }
}

test('independent source diagnostics collect all executable anchor gaps without accepting metadata or another source beat',()=>{
  const first = sourceBeatShot(0).pacing.beats[0]
  first.textOrVocalization = '乡人行走'
  const second = sourceBeatShot(1).pacing.beats[0]
  second.textOrVocalization = '传谣乡人向前走，街市景象'
  const shortVoice = { ...structuredClone(chantShot().pacing.beats[1]), sourceBeatId: 'beat-01', actorIds: ['旁白'], deliveryStyle: 'narration' }
  shortVoice.durationEstimate = { ...shortVoice.durationEstimate, lower: .1, expected: .1, upper: .1 }
  const candidate = { ...sourceBeatShot(0), coveredBeatIds: ['beat-01', 'beat-02'],
    visualPrompt: '街市景象；乡人继续行走', pacing: { version: 'duration-v2', beats: [first, shortVoice, second] } }
  const scene = { ...threeBeatScene, requiredBeats: threeBeatScene.requiredBeats.slice(0, 2) }
  const before = JSON.stringify(candidate)
  assert.throws(() => compileDurationSchedule(candidate, { scene }), /声部预算低于 narration 共享策略/)
  const errors = collectDurationCoverageDiagnostics(candidate, { scene })
  assert.equal(errors.length, 2)
  assert.match(errors[0], /STORYBOARD_COVERAGE_INCOMPLETE: 原节拍 beat-01.*原锚点 街市景象/)
  assert.match(errors[1], /STORYBOARD_COVERAGE_INCOMPLETE: 原节拍 beat-02.*原锚点 乡人继续行走/)
  assert.equal(JSON.stringify(candidate), before)
  const unknown = structuredClone(candidate)
  delete (unknown.pacing.beats[2] as Partial<typeof second>).textOrVocalization
  assert.deepEqual(collectDurationCoverageDiagnostics(unknown, { scene }), [errors[0]], 'unknown executable content cannot establish a missing-anchor diagnosis')
  assert.deepEqual(collectDurationCoverageDiagnostics(candidate), [], 'candidate-declared scope is not authoritative')
  assert.deepEqual(collectDurationCoverageDiagnostics(candidate, { scene: { requiredBeats: [null, {}] } }), [])
})

test('source diagnostics use compiler executable wording, approved settings, and only the assigned partition',()=>{
  const candidate = chantShot()
  assert.deepEqual(collectDurationCoverageDiagnostics(candidate, { scene: chantScene }), [])
  const scopedScene = { ...chantScene, requiredBeats: [{ ...chantScene.requiredBeats[0], mustShow: ['甘陵街巷', '哼唱歌谣', '围观乡人点头'] }] }
  assert.deepEqual(collectDurationCoverageDiagnostics(candidate, { scene: scopedScene }), [])
  const missing = structuredClone(candidate); missing.pacing.beats.pop()
  const errors = collectDurationCoverageDiagnostics(missing, { scene: scopedScene })
  assert.equal(errors.length, 1)
  assert.throws(() => compileDurationSchedule(missing, { scene: scopedScene }), (error: Error) => error.message === errors[0])
  const partition = sourceBeatShot(1)
  assert.deepEqual(collectDurationCoverageDiagnostics(partition, { scene: { ...threeBeatScene, requiredBeats: [threeBeatScene.requiredBeats[1]] } }), [])
})

test('a partial first shot reports the exact missing source beats as coverage rather than a pacing repair',()=>{
  const candidate = { ...sourceBeatShot(), storyProgress: { status: 'continuing', pendingActions: ['beat-02', 'beat-03'] } }
  const before = JSON.stringify(candidate)
  assert.throws(() => compileDurationSchedule(candidate, { scene: threeBeatScene }), (error: Error) => {
    assert.match(error.message, /^STORYBOARD_COVERAGE_INCOMPLETE:/)
    assert.match(error.message, /expected=\["beat-01","beat-02","beat-03"\]/)
    assert.match(error.message, /actual=\["beat-01"\]/)
    assert.match(error.message, /missing=\["beat-02","beat-03"\]/)
    assert.match(error.message, /unknown=\[\]；duplicate=\[\]/)
    assert.match(error.message, /pendingActions 不能代替/)
    return true
  })
  assert.equal(JSON.stringify(candidate), before)
  const malformed = { ...candidate, coveredBeatIds: ['beat-01', 'beat-01', 'invented'] }
  assert.throws(() => compileDurationSchedule(malformed, { scene: threeBeatScene }), /unknown=\["invented"\]；duplicate=\["beat-01"\]/)
})

test('declaring all source ids cannot conceal missing performance beats or anchors',()=>{
  const candidate = { ...sourceBeatShot(), coveredBeatIds: threeBeatScene.requiredBeats.map(beat => beat.id) }
  assert.throws(() => compileDurationSchedule(candidate, { scene: threeBeatScene }), (error: Error) => {
    assert.match(error.message, /^STORYBOARD_COVERAGE_INCOMPLETE: 原节拍未分配完整声画表演/)
    assert.match(error.message, /missing=\["beat-02","beat-03"\]/)
    return true
  })
  const unknown = sourceBeatShot(); unknown.pacing.beats[0].sourceBeatId = 'invented'
  assert.throws(() => compileDurationSchedule(unknown, { scene: { ...threeBeatScene, requiredBeats: [threeBeatScene.requiredBeats[0]] } }), /^Error: STORYBOARD_COVERAGE_INCOMPLETE:.*sourceBeatId/)
  const missingAnchor = sourceBeatShot(); missingAnchor.pacing.beats[0].textOrVocalization = '乡人行走'
  assert.throws(() => compileDurationSchedule(missingAnchor, { scene: { ...threeBeatScene, requiredBeats: [threeBeatScene.requiredBeats[0]] } }), /STORYBOARD_COVERAGE_INCOMPLETE:.*原锚点 街市景象/)
})

test('a validated scene partition binds its own source scope and retains a verifiable compiled schedule',()=>{
  for (const [index, beat] of threeBeatScene.requiredBeats.entries()) {
    const candidate = sourceBeatShot(index)
    const scene = { ...threeBeatScene, requiredBeats: [beat] }
    const compiled = compileDurationSchedule(candidate, { scene })
    assert.deepEqual(compiled.pacing.sourceBeatIds, [beat.id])
    assert.deepEqual(compiled.pacing.sourceBeatRequirements.map(source => source.id), [beat.id])
    assert.doesNotThrow(() => verifyDurationSchedule({ ...candidate, ...compiled }))
    assert.throws(() => compileDurationSchedule(candidate, { scene: threeBeatScene }), /STORYBOARD_COVERAGE_INCOMPLETE:/)
  }
})

test('a dependency cannot reorder interleaved speakers while retaining per-speaker word counts',()=>{
  const make=(id:string,actor:string,text:string,dependsOn:string[])=>({id,sourceBeatId:'exchange',actorIds:[actor],kind:'speech' as const,deliveryStyle:'dialogue' as const,
    textOrVocalization:text,dependsOn,overlapAllowedWith:[],durationEstimate:{lower:.5,expected:.5,upper:1,source:'shared dialogue baseline',confidence:'low' as const},
    completion:{requiredThisClip:true,finalState:'完整说完',modality:'audio' as const,evidenceAnchor:text}})
  const shot={duration:4,characters:['甲','乙'],coveredBeatIds:['exchange'],audioType:'对白',audioText:'甲：是。\n乙：可。\n甲：走。',videoPrompt:'',
    pacing:{version:'duration-v2',beats:[make('a1','甲','是。',[]),make('b1','乙','可。',['a1']),make('a2','甲','走。',['b1'])]}}
  assert.doesNotThrow(()=>compileDurationSchedule(shot))
  shot.pacing.beats[1].dependsOn=['a2'];shot.pacing.beats[2].dependsOn=['a1']
  assert.throws(()=>compileDurationSchedule(shot),/说话人、完整文字或顺序不一致/)
})

test('content or dependency changes invalidate hashes and every derived transport field',()=>{
  const raw=chantShot(), compiled=compileDurationSchedule(raw,{scene:chantScene})
  const stored={...raw,...compiled}
  assert.doesNotThrow(()=>verifyDurationSchedule(stored))
  const text=structuredClone(stored);text.pacing.beats[1].textOrVocalization+='。';text.audioText+='。'
  text.pacing.beats[1].durationEstimate={lower:3.6,expected:4.7,upper:5.8,source:'updated punctuation',confidence:'low'}
  assert.throws(()=>verifyDurationSchedule(text),/哈希失效/)
  const recompiled=compileDurationSchedule(text,{scene:chantScene})
  assert.notEqual(recompiled.scheduleHash,compiled.scheduleHash)
  assert.notDeepEqual(recompiled.sampleTimes,compiled.sampleTimes)
  const depends=structuredClone(stored);depends.pacing.beats[2].dependsOn=['opening']
  assert.throws(()=>verifyDurationSchedule(depends),/哈希失效/)
  const window=structuredClone(stored);window.pacing.speechWindows[0].end=3
  assert.throws(()=>verifyDurationSchedule(window),/speechWindows/)
  const prompt=structuredClone(stored);prompt.videoPrompt=prompt.videoPrompt.replace('围观乡人点头','围观乡人转身')
  assert.throws(()=>verifyDurationSchedule(prompt),/视频时间轴/)
})

test('old v1 execution stays readable but cannot enter a v2 workflow or refresh its pending nodes',()=>{
  assert.equal(dynamicStoryboardTiming(realSixSecondPlanning.audioText,realSixSecondPlanning.pacing).requiredDuration,6)
  assert.equal(historyTailSeconds(realSixSecondPlanning),.3)
  assert.match(appendLipSyncContract('0-6秒：旧镜头','对白',realSixSecondPlanning.audioText,['传唱歌谣的乡人'],realSixSecondPlanning),/每秒4.5/)
  assert.throws(()=>validateHistoricalStructuredOutput('history.storyboard',{...chantShot(),pacing:realSixSecondPlanning.pacing},{pacingVersion:'duration-v2'}),/旧分镜须显式重新规划/)
  const old={id:'sanguo-shot-script',kind:'text',prompt:'dynamic-v1',params:[]}
  const current={...old,prompt:'duration-v2',params:[{englishName:'pacingVersion',value:'duration-v2'}]}
  const runs=[{node:old,status:'idle'}],workflow={nodes:[current],edges:[]}
  assert.equal(isDurationPolicyTransition(workflow,runs),true)
  assert.equal(hasExecutionPlanMismatch(workflow,runs),true)
  assert.equal(refreshPendingExecutionNodes(workflow,runs),runs)
})

test('real generation and overflow repair prompts do not reinject the legacy v1 clock',async()=>{
  const prompts:string[]=[]
  const result=await generateHistoricalStoryboard({prompt:'按原义务创作',expected:{scene:chantScene,pacingVersion:'duration-v2',requireDynamicPacing:true},
    generate:async prompt=>{prompts.push(prompt);return chantShot()}})
  assert.equal(result.duration,9);assert.match(prompts[0],/duration-v2 分镜执行规则/)
  assert.doesNotMatch(prompts[0],/按自然4.5字\/秒预算|action\/reaction预算及overlapWith可由/)
  const long=chantShot();long.pacing.beats[1].durationEstimate.upper=14
  const splitPrompts:string[]=[]
  await assert.rejects(()=>generateHistoricalStoryboard({prompt:'按原义务创作',initialCandidate:long,
    expected:{scene:chantScene,pacingVersion:'duration-v2',requireDynamicPacing:true},canGenerate:()=>splitPrompts.length<1,
    generate:async prompt=>{splitPrompts.push(prompt);throw Error('OFFLINE_STOP_BEFORE_PAID_CALL')}}),/OFFLINE_STOP_BEFORE_PAID_CALL/)
  assert.match(splitPrompts[0],/自动拆镜/)
  assert.match(splitPrompts[0],/各声部deliveryStyle/)
  assert.doesNotMatch(splitPrompts[0],/按自然4.5字\/秒预算|action\/reaction预算及overlapWith可由/)
})
