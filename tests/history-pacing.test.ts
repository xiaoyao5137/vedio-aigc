import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildStoryboardRepairSuffix, reconcileStoryboardPacingBudget, storyboardDialogueScheduleHint } from '../src/workflow-core.ts'
import { generateHistoricalStoryboard } from '../src/storyboard-runtime.ts'
import { storyboardAdvisories } from '../src/storyboard-advisories.ts'
import { dynamicStoryboardTiming, historyFrameTimes, narrativeTransitionIssue, validateNarrativeOutline } from '../src/history-pacing.ts'
import { deriveSceneOutlineMetrics, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { reviewStoryboardMotion, historicalVideoPrompt, validateHistoricalMediaReview, reviewHistoricalMedia } from '../src/history-media.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'

const scene = { id: 's1', dramaticUnitId: 'u1', closesUnit: true, completionCriteria: ['接稳印绶', '受命回应'], continuityFromPrevious: false }
const shot = { id: 's1', title: '受命', duration: 3, pacing: { version: 'dynamic-v1', actionSeconds: 0.7, reactionSeconds: 0.5 },
  completionCriteria: scene.completionCriteria,
  storyProgress: { unitId: 'u1', status: 'complete', actionResult: '周福接稳印绶', response: '周福回答遵命', pendingActions: [] },
  characters: ['桓帝', '周福'], initialCharacters: ['桓帝', '周福'], enteringCharacters: [], endCharacters: ['桓帝', '周福'],
  visualPrompt: '桓帝右侧递出印绶，周福左侧抬手', lastFramePrompt: '桓帝右侧收手，周福左侧接稳印绶',
  camera: '双人中景', mood: '自然', firstFrameMode: 'reference', continuity: {previousShotId:'',bridgeType:'opening',bridgeAnchor:''},
  videoPrompt: '0-0.7秒：桓帝递出印绶，周福接稳印绶。0.7-1.7秒：周福开口说出“遵命”。1.7-3秒：周福躬身回应，桓帝收手自然回视。',
  audioType: '对白', audioText: '周福：遵命。', historicalBasis:'[史料1] 擢福为尚书', adaptationBoundary:'动作对白拟制' }

test('actual opening hold is advisory while its overlong dialogue still gets repaired', async () => {
  const failed = JSON.parse(readFileSync(new URL('./fixtures/storyboard-pacing-hold.json', import.meta.url), 'utf8'))
  let message = ''
  try { validateHistoricalStructuredOutput('history.storyboard', failed, { requireDynamicPacing: true }) } catch (error) { message = (error as Error).message }
  assert.match(message, /超过单条口型锚点/)
  assert.doesNotMatch(message, /空等或静止保持/)
  assert.match(JSON.stringify(storyboardAdvisories(failed)), /周福保持躬身姿态/)
  assert.match(buildStoryboardRepairSuffix(message, failed, '修复'), /自然语义停顿/)
  const hint = storyboardDialogueScheduleHint(failed, 4.5, message)
  assert.match(hint, /程序计算的无损拆行建议/)
  assert.doesNotMatch(hint, /0到1.5秒|duration须为10/)
  assert.match(storyboardDialogueScheduleHint(failed, 4.5, 'STORYBOARD_PACING_INVALID: 本镜应为 10 秒，实际声明 11 秒'), /程序计算的无损拆行建议/)
  let calls = 0
  const result = await generateHistoricalStoryboard({ prompt: '保留剧情', initialCandidate: failed,
    expected: { scene: {}, requireDynamicPacing: true },
    generate: async prompt => { calls++; assert.match(prompt, /无损拆行建议/); assert.doesNotMatch(prompt, /0到1.5秒/); return shot },
  })
  assert.equal(calls, 1)
  assert.equal((result.scriptValidation as { passed: boolean }).passed, true)
})

test('posture wording cannot reject an otherwise executable clock', () => {
  const validate = (videoPrompt: string) => validateHistoricalStructuredOutput('history.storyboard', { ...shot, videoPrompt }, { scene, requireDynamicPacing: true })
  assert.doesNotThrow(() => validate(shot.videoPrompt.replace('周福躬身回应，桓帝收手自然回视', '周福保持躬身姿态，禁止走动')))
  assert.doesNotThrow(() => validate(shot.videoPrompt.replace('周福躬身回应，桓帝收手自然回视', '周福躬身回应，避免静止不动')))
  assert.doesNotThrow(() => validate(shot.videoPrompt.replace('周福躬身回应，桓帝收手自然回视', '周福双膝弯曲下跪至地面，双手向前伸展；桓帝站立不动')))
  assert.doesNotThrow(() => validate('0-0.5秒：桓帝递出印绶，周福接稳印绶。0.5-1.8秒：周福保持躬身姿态，回答“遵命”。1.8-3秒：周福保持躬身姿态。'))
  assert.doesNotThrow(() => validate('0-0.5秒：桓帝递出印绶，周福接稳印绶。0.5-1.7秒：周福回答“遵命”。1.7-3秒：周福静止不动，准备回答。'))
})

test('short complete actions remain 3 seconds and preserve their full timeline and speech', () => {
  const result = validateHistoricalStructuredOutput('history.storyboard', shot, {scene,requireDynamicPacing:true,requireNarrativeClosure:true}) as Record<string, unknown>
  assert.equal(result.duration, 3)
  assert.equal(result.audioText, shot.audioText)
  assert.doesNotMatch(historicalVideoPrompt(result), /13\.5|1\.5 秒|1\.5秒|全程闭口/)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {...shot,duration:15}, {scene,requireDynamicPacing:true}), /应为 3 秒/)
  assert.deepEqual(deriveSceneOutlineMetrics({scenes:[{targetDuration:3},{targetDuration:8}]}).totalDuration,11)
  assert.ok(historyFrameTimes(3).every(time=>time>=0&&time<3))
  const request=buildKlingVideoRequest({id:'keling3',provider:'Kling',capability:'video',settings:{model:'kling-v3'}},historicalVideoPrompt(result),{duration:3,pacingVersion:'dynamic-v1',sound:'on'})
  assert.equal(Number(request.duration),3)
  assert.doesNotMatch(String(request.prompt),/最后1\.5秒|13\.5秒至片尾/)
})

test('natural speech budget over 15 seconds requires a plot-preserving split', () => {
  assert.ok(dynamicStoryboardTiming('周福：'+'谨守职责'.repeat(20),shot.pacing).requiredDuration>15)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', {...shot,audioText:'周福：'+'谨守职责'.repeat(20)}, {scene,requireDynamicPacing:true}), /STORYBOARD_TIMING_OVERFLOW/)
})

test('an unfinished appointment cannot cut to an unrelated court scene', () => {
  const next = {...scene,id:'s2',dramaticUnitId:'u2'}
  assert.throws(()=>validateNarrativeOutline([{...scene,closesUnit:false},next]), /戏尚未结束/)
  assert.doesNotThrow(()=>validateNarrativeOutline([{...scene,closesUnit:false},{...scene,id:'s2',continuityFromPrevious:true}]))
  assert.match(narrativeTransitionIssue(next, {...shot,storyProgress:{...shot.storyProgress,status:'continuing',pendingActions:['周福受命回应']}}, {})!, /禁止换场/)
  assert.match(narrativeTransitionIssue(next,shot,{visualReview:{passed:true}})!, /尚未证明/)
  const closure={unitId:'u1',complete:true,actionEvidence:'第2帧周福接稳印绶',responseEvidence:'真实语音中周福回答遵命',unresolvedActions:[],criteriaChecks:scene.completionCriteria.map(criterion=>({criterion,status:'complete',evidence:'实际画面和台词中已完成'}))}
  assert.equal(narrativeTransitionIssue(next,shot,{visualReview:{narrativeClosure:closure}}),undefined)
  const review={passed:true,issues:[],endCharacters:shot.characters,endingState:shot.lastFramePrompt,narrativeClosure:closure,pacingReview:{passed:true,reason:'回应后切出',lastMeaningfulActionSecond:2.7}}
  assert.doesNotThrow(()=>validateHistoricalMediaReview(review,shot))
  assert.throws(()=>validateHistoricalMediaReview({...review,narrativeClosure:{...closure,complete:false,unresolvedActions:['等待回应'],criteriaChecks:closure.criteriaChecks.map(check=>check.criterion==='受命回应'?{...check,status:'incomplete',evidence:'片尾仍是桓帝说话，周福尚未回答'}:check)}},shot),/不能转场/)
  assert.throws(()=>validateHistoricalMediaReview({...review,narrativeClosure:{...closure,complete:false,unresolvedActions:['未捕捉到点头']}},shot),/VIDEO_REVIEW_INVALID: 原剧情完成条件全部满足/)
  assert.throws(()=>validateHistoricalMediaReview({...review,narrativeClosure:{...closure,criteriaChecks:closure.criteriaChecks.map(check=>({...check,status:'unobservable',evidence:'手被遮挡，不能确认是否接稳'}))}},shot),/VIDEO_REVIEW_INVALID: 剧情完成条件证据不足/)
  assert.throws(()=>validateHistoricalMediaReview({...review,narrativeClosure:{...closure,criteriaChecks:[...closure.criteriaChecks,{criterion:'尾帧低头',status:'incomplete',evidence:'没有低头'}]}},shot),/不能新增瞬间姿态/)
  assert.throws(()=>validateHistoricalMediaReview({...review,pacingReview:{...review.pacingReview,lastMeaningfulActionSecond:1}},shot),/尾部空等/)
})

test('a critic saying no contradiction cannot trigger seven pointless script rewrites', async () => {
  const checks=shot.characters.map(character=>({itemId:shot.id,character,finalActionState:'已自然收束',requestedEndState:'已自然收束',canExecuteAsWritten:true}))
  let calls=0
  const reviewed=await reviewStoryboardMotion({candidate:shot,generate:async prompt=>{
    calls++
    if(calls===1)return {passed:false,issues:[{problem:'无矛盾',repair:'无需修复'}],checks}
    assert.match(prompt,/只复核报告/)
    return {passed:true,issues:[],checks}
  }})
  assert.equal(reviewed.passed,true)
  assert.equal(calls,2)
  await assert.rejects(()=>reviewStoryboardMotion({candidate:shot,generate:async()=>({passed:false,issues:[{repair:'无需修复'}],checks})}),/HISTORY_REVIEW_INVALID/)
})

test('actual dramatic closure is judged independently of planned incidental gestures', async () => {
  const frames = Array.from({ length: 6 }, (_, index) => `/generated/actual-${index}.jpg`)
  const observations = frames.map((frame, index) => ({ index, frame, people: [], setting: '实际宫殿画面' }))
  const phases: string[] = []
  const result = await reviewHistoricalMedia({ shot, frames, observations, speechEvidence: { passed: true, lastSpeechEnd: 2.7 }, generate: async prompt => {
    if (prompt.startsWith('【独立剧情收束与节奏检查】')) {
      phases.push('closure')
      assert.ok(!prompt.includes(shot.videoPrompt))
      assert.ok(!prompt.includes(shot.lastFramePrompt))
      assert.ok(prompt.includes(JSON.stringify(shot.completionCriteria)))
      return { narrativeClosure: { unitId: 'u1', complete: true, actionEvidence: '已实际接稳', responseEvidence: '实际ASR回答遵命', unresolvedActions: [], criteriaChecks: shot.completionCriteria.map(criterion => ({ criterion, status: 'complete', evidence: '实际画面及语音已完成' })) }, pacingReview: { passed: true, reason: '实际回应后结束', lastMeaningfulActionSecond: 2.7 } }
    }
    if (prompt.startsWith('【实际尾帧状态提取】')) {
      phases.push('tail')
      return { endingState: '周福已接稳印绶，桓帝手臂放下', endCharacters: shot.characters }
    }
    phases.push('visual')
    return { passed: true, issues: [], endingState: '周福已接稳印绶，桓帝手臂放下', endCharacters: shot.characters }
  } })
  assert.deepEqual(phases, ['closure', 'visual', 'tail'])
  assert.equal(result.passed, true)
  assert.equal(result.lipSyncVerified, false)
})

// record-4li23v scene-01: 45 Han characters of 旁白 take 11.05 s at 4.5 字/秒, so the shot needed 14
// seconds. Five paid rounds each declared 9-12 seconds and answered “本镜应为 14 秒” with a new guess.
const narrationVideoPrompt = '0-1.5秒:房植门客甲行于街市,从画面右侧向左侧缓步前行,街市木质店铺和行人可见。1.5-4秒:旁白声音开口说出:桓帝建和元年,帝即位后擢其师甘陵周福为尚书,房植门客甲继续行进。4-5.8秒:旁白继续说出:同郡河南尹房植有名当朝,房植门客甲听到歌声,驻足。5.8-7.5秒:歌声响起唱出:天下规矩房伯武,因师获印周仲进,房植门客甲侧耳倾听。7.5-8.7秒:房植门客甲神色变化,若有所思,眉头微蹙。'
const narration = { ...shot, duration: 9, audioType: '旁白',
  audioText: '桓帝建和元年,帝即位后擢其师甘陵周福为尚书。同郡河南尹房植有名当朝。天下规矩房伯武,因师获印周仲进。',
  pacing: { version: 'dynamic-v1', actionSeconds: 1.5, reactionSeconds: 0.8 }, videoPrompt: narrationVideoPrompt }

test('an under-length narration gets its clock derived instead of another guess', () => {
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', narration, { scene, requireDynamicPacing: true }), /应为 14 秒，实际声明 9 秒/)
  const repaired = reconcileStoryboardPacingBudget(narration)
  assert.equal(repaired.duration, 14)
  assert.match(String(repaired.videoPrompt), /12\.1-14秒:/)
  assert.deepEqual(repaired.pacing.activityWindows, [{ kind: 'action', startSecond: 0, endSecond: 1.5 },
    { kind: 'speech', startSecond: 1.5, endSecond: 12.55 }, { kind: 'reaction', startSecond: 12.55, endSecond: 13.35 }])
  const validated = validateHistoricalStructuredOutput('history.storyboard', repaired, { scene, requireDynamicPacing: true }) as Record<string, unknown>
  assert.equal(validated.duration, 14)
  assert.equal(validated.audioText, narration.audioText)
  assert.ok(String(validated.videoPrompt).includes('旁白继续说出:同郡河南尹房植有名当朝'))
})

test('the derived clock heals an under-length shot without spending a repair round', async () => {
  let calls = 0
  const result = await generateHistoricalStoryboard({ prompt: '保留剧情', initialCandidate: narration,
    expected: { scene, requireDynamicPacing: true }, generate: async () => { calls += 1; return shot } })
  assert.equal(calls, 0)
  assert.equal(result.duration, 14)
  assert.equal((result.scriptValidation as { localRepair: boolean }).localRepair, true)
})

test('padding is never stretched away and a hold that only grows dead air is refused', () => {
  // A shot longer than its own audio is exactly what this budget exists to reject; the writer still
  // has to fix it, so the reconciler must stay out of the way.
  assert.equal(reconcileStoryboardPacingBudget({ ...narration, duration: 15 }), undefined)
  const heldTail = { ...narration, videoPrompt: narration.videoPrompt.replace('眉头微蹙。', '眉头微蹙,保持静立姿态。') }
  assert.equal(reconcileStoryboardPacingBudget(heldTail), undefined)
})

test('a silent performance claim that buys no screen time stops blocking the clock', () => {
  const crowded = { ...narration, pacing: { ...narration.pacing,
    activityWindows: [{ kind: 'action', startSecond: 0, endSecond: 1.5 }, { kind: 'speech', startSecond: 1.5, endSecond: 8 },
      { kind: 'reaction', startSecond: 8, endSecond: 8.7 }],
    performanceBeats: [{ id: 'perf-01', purpose: '听闻歌谣', stateChange: '从听到歌声到驻足倾听', evidenceAnchor: '房植门客甲神色变化',
      startSecond: 8, endSecond: 8.7, overlapWith: ['reaction'] }] } }
  const repaired = reconcileStoryboardPacingBudget(crowded)
  assert.equal(repaired.duration, 14)
  assert.deepEqual(repaired.pacing.performanceBeats, [])
  // A beat that really extends the picture adds screen time and cannot be deleted by arithmetic.
  assert.equal(reconcileStoryboardPacingBudget({ ...crowded, pacing: { ...crowded.pacing,
    performanceBeats: [{ ...crowded.pacing.performanceBeats[0], startSecond: 8.7, endSecond: 12 }] } }), undefined)
  const hint = storyboardDialogueScheduleHint(crowded, 4.5, 'STORYBOARD_PACING_INVALID: speech activityWindows 应覆盖 11.49 秒，不能重复计时或拉长自然语速')
  assert.match(hint, /speechSeconds=11\.05/)
  assert.match(hint, /duration=max\(3,ceil\(plannedEndSecond\+0\.3\)\)/)
  assert.doesNotMatch(hint, /都必须落到 14 秒/)
})
