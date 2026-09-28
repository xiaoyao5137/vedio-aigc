import test from 'node:test'
import assert from 'node:assert/strict'
import { storyboardDialogueClockHint, storyboardDialogueScheduleHint, validateStoryboardSpeechActivityCoverage } from '../src/workflow-core.ts'
import { speechBudgetSeconds, unionSeconds } from '../src/history-pacing.ts'

const lines = ['甲：当今天子为蠡吾侯时,曾受学于吾师周公。', '甲：如今即位,擢吾师为尚书,实乃师恩之报。', '甲：同郡河南尹房伯武,亦有名当朝。']
const shot = { audioType: '对白', audioText: lines.join('\n'), duration: 13,
  pacing: { version: 'dynamic-v1', actionSeconds: 0, reactionSeconds: 0.3,
    activityWindows: [{kind: 'speech', startSecond: 0.8, endSecond: 4.98}, {kind: 'speech', startSecond: 5.18, endSecond: 9.29}, {kind: 'speech', startSecond: 9.49, endSecond: 12.78}] },
  videoPrompt: `0-0.8秒：甲站立。0.8-4.98秒：甲开口说出：${lines[0].slice(2)}5.18-9.29秒：甲继续说出：${lines[1].slice(2)}9.49-12.78秒：甲微微点头，说出：${lines[2].slice(2)}12.78-13秒：甲站立。` }
const error = 'STORYBOARD_PACING_INVALID: speech activityWindows 应覆盖 11.97 秒'
const parseClock = (hint: string) => JSON.parse(hint.match(/精确计算：(\[.*?\])；speech窗口并集/s)![1]) as Array<{kind: string; startSecond: number; endSecond: number; audioText: string; followingLinePauseSeconds: number}>

test('already split dialogue receives an exact clock with every pause owned by the preceding speech window', () => {
  const before = structuredClone(shot)
  const hint = storyboardDialogueScheduleHint(shot, 4.5, error)
  const clock = parseClock(hint)
  assert.deepEqual(clock.map(row => [row.startSecond, row.endSecond]), [[0.8,5.18],[5.18,9.48],[9.48,12.77]])
  assert.deepEqual(clock.map(row => row.followingLinePauseSeconds), [0.2,0.2,0])
  assert.deepEqual(clock.map(row => row.audioText), lines)
  assert.ok(Math.abs(unionSeconds(clock) - speechBudgetSeconds(shot.audioText)) < 0.01)
  assert.match(hint, /reaction窗口=.*"startSecond":12.77,"endSecond":13.07.*duration=14/)
  assert.match(hint, /不能只改pacing而保留旧起止/)
  assert.deepEqual(shot, before)
})

test('copying only proposed windows fails ownership until the authored speech timeline agrees', () => {
  const clock = parseClock(storyboardDialogueClockHint(shot, error))
  const copy = { ...shot, pacing: {...shot.pacing, activityWindows: clock} }
  assert.throws(() => validateStoryboardSpeechActivityCoverage(copy), /未被逐字绑定台词的时间段完整覆盖/)
  const ranges = clock.map((row,i) => `${row.startSecond}-${row.endSecond}秒：甲开口说出：${lines[i].slice(2)}`).join('')
  assert.doesNotThrow(() => validateStoryboardSpeechActivityCoverage({...copy, videoPrompt: `0-0.8秒：甲站立。${ranges}12.77-14秒：甲收回点头动作。`}))
})

test('valid schedules, voice-over, multi-speaker turns and ambiguous cue mappings receive no replacement clock', () => {
  assert.equal(storyboardDialogueClockHint(shot), '')
  assert.equal(storyboardDialogueClockHint({...shot,audioType:'旁白'},error), '')
  assert.equal(storyboardDialogueClockHint({...shot,audioText:shot.audioText.replace(lines[1],lines[1].replace('甲','乙'))},error), '')
  assert.equal(storyboardDialogueClockHint({...shot,videoPrompt:shot.videoPrompt + `13-14秒：甲说出：${lines[0].slice(2)}`},error), '')
})

test('the reference preserves voice annotations and refuses to assume away planned performance', () => {
  const candidate = {...shot, audioText: shot.audioText.replaceAll('甲：','甲（画外）：')}
  assert.deepEqual(parseClock(storyboardDialogueClockHint(candidate,error)).map(row => row.audioText), candidate.audioText.split('\n'))
  assert.equal(storyboardDialogueClockHint({...shot,pacing:{...shot.pacing,performanceBeats:[{id:'decision'}]}},error), '')
})

test('a new clock replaces old mathematically valid windows when their speech ownership was rejected', () => {
  const seconds = speechBudgetSeconds(shot.audioText)
  const copy = {...shot, pacing: {...shot.pacing, activityWindows: [
    {kind:'speech',startSecond:0,endSecond:seconds},
    {kind:'reaction',startSecond:seconds,endSecond:seconds + 0.3},
  ]}}
  const hint = storyboardDialogueScheduleHint(copy,4.5,'STORYBOARD_PACING_INVALID: speech activityWindows 未被逐字绑定台词的时间段完整覆盖')
  assert.match(hint,/含行间停顿的连续对白时钟/)
  assert.match(hint,/duration=14/)
  assert.doesNotMatch(hint,/duration须为13|已核验的活动时间预算/)
  assert.match(storyboardDialogueScheduleHint(copy,4.5,'STORYBOARD_PACING_INVALID: 静止保持与时间窗不符'),/旧 pacing 与时间窗已被拒绝/)
})
