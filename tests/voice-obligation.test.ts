import test from 'node:test'
import assert from 'node:assert/strict'
import { assertVoiceObligationCoverage } from '../src/voice-obligation.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'

function shot(text: string) {
  return { id: 'scene-07', audioType: '环境声', audioText: '', duration: 5, characters: [], coveredBeatIds: ['beat-07'], videoPrompt: '',
    pacing: { version: 'duration-v2', sourceBeatIds: ['beat-07'], actorGroups: [{ id: 'villagers', label: '周围百姓', memberDescription: '围观病人的百姓' }],
      beats: [{ id: 'crowd-response', sourceBeatId: 'beat-07', kind: 'action', actorIds: ['villagers'], textOrVocalization: text,
        dependsOn: [], overlapAllowedWith: [], durationEstimate: { lower: 1, expected: 2, upper: 3, source: '动作预算', confidence: 'high' },
        completion: { requiredThisClip: true, finalState: '百姓反应完成', modality: 'visual', evidenceAnchor: '百姓反应' } }] } }
}

test('actual ambient-only scene 7 talking/calling duties are diagnosed before compile and provider without mutating the storyboard', () => {
  for (const text of ['周围人惊喜交谈，相互交谈并向外招手呼唤。', '病人讲述病情。', '房氏宾客向他人复述，做出讲述手势。', '两人进行问答。', '张角在高台宣示。', '张角高声宣布任命渠帅。', '万人齐声应和。', '张角挥臂并高声宣示。']) {
    const value = shot(text), before = structuredClone(value)
    assert.throws(() => assertVoiceObligationCoverage(value), /STORYBOARD_VOICE_OBLIGATION_MISSING/)
    assert.throws(() => compileDurationSchedule(value), /STORYBOARD_VOICE_OBLIGATION_MISSING/)
    assert.throws(() => buildKlingVideoRequest({ id: 'kling', provider: 'kling', capability: 'video', settings: {} }, '保留原动作', value), /STORYBOARD_VOICE_OBLIGATION_MISSING/)
    assert.deepEqual(value, before)
  }
})

test('a storytelling hand gesture is silent while separately authored retelling still requires synchronized speech', () => {
  for (const text of ['房氏宾客面向行人做出讲述手势。', '房氏宾客摆出讲述姿态。', '房氏宾客不再复述歌谣。']) assert.doesNotThrow(() => assertVoiceObligationCoverage(shot(text)))
  assert.throws(() => assertVoiceObligationCoverage(shot('房氏宾客向他人复述，做出讲述手势。')), /"obligation":"复述"/)
  assert.throws(() => assertVoiceObligationCoverage(shot('房氏宾客做出说话动作。')), /"obligation":"说话"/, 'the hand-gesture exception must not authorize silent language mouths')
})

test('negative, stopped, silent and listening performances do not manufacture speech obligations', () => {
  for (const text of ['无声招手，百姓不交谈。', '百姓停止讲话，闭口观察。', '百姓不再相互交谈。', '百姓听见画外旁白讲述病情。', '旁白讲述；百姓保持安静，露出惊喜表情。', '百姓无声呼唤，以招手示意。', '百姓交谈结束，转身走开。', '禁止人物交谈或呼唤。', '百姓并非交谈，只是交换眼神。', '不允许百姓相互交谈。', '张角挥臂宣示。', '张角举臂宣示。', '张角举手宣示。', '张角作宣示动作。', '张角默默挥臂宣示决心。', '张角不再高声宣布任命。', '众人听见画外张角高声宣布任命。', '禁止人物宣示或齐声应和。', '远处传来万人齐声应和，张角闭口注视。', '背景里传来张角高声宣布任命。']) {
    assert.doesNotThrow(() => assertVoiceObligationCoverage(shot(text)), text)
  }
})

test('declared actor-matched wordless calls cover calling, but cannot replace lexical conversation or another actor', () => {
  const value = shot('百姓招手呼唤。')
  value.pacing.beats[0].overlapAllowedWith = ['call', 'line']
  value.pacing.beats.push({ id: 'call', kind: 'vocalization', actorIds: ['villagers'], textOrVocalization: '无词呼声',
    overlapAllowedWith: ['crowd-response'], vocalization: { vocalizationType: '无词呼声', actorGroup: 'villagers', expectedAudibility: '清晰可听' } })
  assert.doesNotThrow(() => assertVoiceObligationCoverage(value))
  value.pacing.beats[0].textOrVocalization = '百姓相互交谈。'
  assert.throws(() => assertVoiceObligationCoverage(value), /带原台词的 speech/)
  value.pacing.beats.push({ id: 'line', kind: 'speech', actorIds: ['villagers'], deliveryStyle: 'dialogue', textOrVocalization: '他的气色好多了。', overlapAllowedWith: ['crowd-response'] })
  assert.doesNotThrow(() => assertVoiceObligationCoverage(value))
  value.pacing.beats.at(-1).actorIds = ['unrelated']
  assert.throws(() => assertVoiceObligationCoverage(value), /villagers/)
  value.pacing.beats.at(-1).actorIds = ['villagers']; value.pacing.beats.at(-1).deliveryStyle = 'narration'
  assert.throws(() => assertVoiceObligationCoverage(value), /STORYBOARD_VOICE_OBLIGATION_MISSING/)
})

test('the actual scene 15 arm declaration remains a silent action before its separately declared call and response', () => {
  // Compact transcription from logs/record-qz0e0e-audit/loop-15.json .s;
  // no generated images, provider credentials or runtime record dependencies.
  const value = { audioType: '对白', audioText: '张角：黄天当立！\n万人齐声应和：黄天当立！', pacing: { beats: [
    { id: 'beat-15-a', kind: 'action', actorIds: ['张角'], textOrVocalization: '张角在高台宣示，缓缓举起右臂至肩上水平', dependsOn: [], overlapAllowedWith: [] },
    { id: 'beat-15-b', kind: 'speech', actorIds: ['张角'], textOrVocalization: '黄天当立！', deliveryStyle: 'dialogue', dependsOn: ['beat-15-a'], overlapAllowedWith: [] },
    { id: 'beat-15-c', kind: 'speech', actorIds: ['crowd-responding'], textOrVocalization: '黄天当立！', performanceInstruction: '万人齐声应和，声浪震撼', deliveryStyle: 'dialogue', dependsOn: ['beat-15-b'], overlapAllowedWith: [] },
    { id: 'beat-15-d', kind: 'reaction', actorIds: ['张角'], textOrVocalization: '张角环视下方万人，微微颔首', dependsOn: ['beat-15-c'], overlapAllowedWith: [] },
  ] } }
  assert.doesNotThrow(() => assertVoiceObligationCoverage(value))
  value.pacing.beats[0].textOrVocalization = '张角在高台高声宣示，缓缓举起右臂至肩上水平'
  assert.throws(() => assertVoiceObligationCoverage(value), /STORYBOARD_VOICE_OBLIGATION_MISSING/, 'a later line cannot cover an explicitly voiced opening action')
})

test('an earlier line from the same actor or a dependency chain cannot authorize later talking', () => {
  const value = shot('百姓继续讲话。'), action = value.pacing.beats[0]
  const voice = { id: 'earlier-line', sourceBeatId: action.sourceBeatId, kind: 'speech', actorIds: ['villagers'], deliveryStyle: 'dialogue', textOrVocalization: '他的气色好多了。', overlapAllowedWith: [] }
  value.pacing.beats.unshift(voice)
  assert.throws(() => assertVoiceObligationCoverage(value), /不能用同角色此前说过的一句/)
  action.overlapAllowedWith = [voice.id]
  assert.throws(() => assertVoiceObligationCoverage(value), /STORYBOARD_VOICE_OBLIGATION_MISSING/, 'one-sided overlap is not a synchronized declaration')
  voice.overlapAllowedWith = [action.id]
  assert.doesNotThrow(() => assertVoiceObligationCoverage(value))
  action.dependsOn = ['turn-around']
  value.pacing.beats.push({ id: 'turn-around', kind: 'action', actorIds: ['villagers'], textOrVocalization: '转身', dependsOn: [voice.id] })
  assert.throws(() => assertVoiceObligationCoverage(value), /STORYBOARD_VOICE_OBLIGATION_MISSING/, 'transitive after-speech dependency defeats declared overlap')
})

test('compiled synchronization must cover the actual talking window rather than an earlier line or a short overlap', () => {
  const value = shot('百姓继续讲话。'), action = value.pacing.beats[0]
  action.overlapAllowedWith = ['line']
  value.pacing.beats.push({ id: 'line', kind: 'speech', actorIds: ['villagers'], deliveryStyle: 'dialogue', textOrVocalization: '他的气色好多了。', overlapAllowedWith: [action.id] })
  value.pacing.schedule = [{ beatId: action.id, startSecond: 3, endSecond: 5 }, { beatId: 'line', startSecond: 0, endSecond: 2 }]
  assert.throws(() => assertVoiceObligationCoverage(value), /时间窗须覆盖/)
  assert.doesNotThrow(() => assertVoiceObligationCoverage(value, value.pacing.beats), 'author compilation does not validate a stale previous schedule against new beats')
  value.pacing.schedule[1] = { beatId: 'line', startSecond: 2, endSecond: 3.2 }
  assert.throws(() => assertVoiceObligationCoverage(value), /时间窗须覆盖/, 'a brief overlap must not hide a silent talking tail')
  value.pacing.schedule[1] = { beatId: 'line', startSecond: 3, endSecond: 5 }
  assert.doesNotThrow(() => assertVoiceObligationCoverage(value))
  value.pacing.schedule[1] = { beatId: 'line', startSecond: 3, endSecond: 4 }
  action.overlapAllowedWith.push('line-two')
  value.pacing.beats.push({ id: 'line-two', kind: 'speech', actorIds: ['villagers'], deliveryStyle: 'dialogue', textOrVocalization: '快去告诉乡亲。', overlapAllowedWith: [action.id] })
  value.pacing.schedule.push({ beatId: 'line-two', startSecond: 4, endSecond: 5 })
  assert.doesNotThrow(() => assertVoiceObligationCoverage(value), 'adjacent explicitly synchronized lines may jointly cover one talking action')
})
