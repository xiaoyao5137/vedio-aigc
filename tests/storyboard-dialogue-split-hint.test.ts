import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryboardRepairSuffix, storyboardDialogueScheduleHint, storyboardDialogueSplitHint } from '../src/workflow-core.ts'
import { speechBudgetSeconds } from '../src/history-pacing.ts'

const first = '当今天子为蠡吾侯时,曾受学于吾师周公。'
const second = '如今即位,擢吾师为尚书,实乃师恩之报。'
const third = '同郡河南尹房伯武,亦有名当朝。'
const audio = `周福门客：${first}${second}\n周福门客：${third}`
const pacing = { version: 'dynamic-v1', actionSeconds: 0.5, reactionSeconds: 0.5 }
const parseAudio = (hint: string): string => JSON.parse(hint.match(/audioText=("(?:[^"\\]|\\.)*")。/)![1])

test('a dynamic rejected candidate receives split-line arithmetic before any old-window schedule', () => {
  const candidate = { audioText: audio, pacing: { ...pacing,
    activityWindows: [{ kind: 'speech', startSecond: 0, endSecond: 11.77 }] } }
  const before = structuredClone(candidate)
  const hint = storyboardDialogueScheduleHint(candidate, 4.5, 'STORYBOARD_PACING_INVALID: speech activityWindows 应覆盖 11.77 秒')
  const split = parseAudio(hint)
  assert.equal(split, `周福门客：${first}\n周福门客：${second}\n周福门客：${third}`)
  assert.match(hint, /speechSeconds=11\.97/)
  assert.equal(Number(speechBudgetSeconds(split).toFixed(2)), 11.97)
  assert.doesNotMatch(hint, /speechSeconds=11\.77|已核验的活动时间预算|参考时间窗/)
  assert.match(hint, /声明数组的一项中保留.*同一角色可在自然停顿处分成相邻短行/s)
  assert.match(hint, /不指定开场、动作或反应起点/)
  assert.deepEqual(candidate, before)
})

test('splitting retains short lines, speaker identity and exact spoken bytes in order', () => {
  const candidate = { audioText: `甲：${first}${second}\n乙：已经知晓。\n甲：${third}`, pacing }
  const split = parseAudio(storyboardDialogueSplitHint(candidate))
  assert.equal(split, `甲：${first}\n甲：${second}\n乙：已经知晓。\n甲：${third}`)
  assert.equal(split.split('\n').map(line => line.slice(line.indexOf('：') + 1)).join(''),
    candidate.audioText.split('\n').map(line => line.slice(line.indexOf('：') + 1)).join(''))
})

test('already short dialogue keeps the declared window guidance', () => {
  const candidate = { audioText: `甲：${first}`, pacing }
  assert.equal(storyboardDialogueSplitHint(candidate), '')
  assert.match(storyboardDialogueScheduleHint(candidate), /程序计算的动态预算/)
})

test('unpunctuated overlong clauses and unsupported wrappers are not silently rewritten', () => {
  assert.equal(storyboardDialogueSplitHint({ audioText: '甲：' + '甲乙丙丁戊己庚辛壬癸'.repeat(4), pacing }), '')
  assert.equal(storyboardDialogueSplitHint({ audioText: audio }), '')
  assert.equal(storyboardDialogueSplitHint({ segments: [{ audioText: audio, pacing }], pacing }), '')
})

test('explicit valid windows do not lock a rejected long cue to its old line total', () => {
  const seconds = speechBudgetSeconds(audio)
  const candidate = { audioText: audio, pacing: { ...pacing, activityWindows: [
    { kind: 'action', startSecond: 0, endSecond: 0.5 },
    { kind: 'speech', startSecond: 0.5, endSecond: 0.5 + seconds },
    { kind: 'reaction', startSecond: 0.5 + seconds, endSecond: 1 + seconds },
  ] } }
  const hint = storyboardDialogueScheduleHint(candidate)
  assert.match(hint, /程序计算的无损拆行建议/)
  assert.match(hint, /speechSeconds=11\.97/)
  assert.doesNotMatch(hint, /duration须为|activityWindows=/)
})

test('already split utterances may retain a single complete dramaturgy declaration', () => {
  const candidate = { audioText: `甲：${first}\n甲：${second}\n甲：${third}`, pacing }
  const before = structuredClone(candidate)
  const suffix = buildStoryboardRepairSuffix('HISTORY_DRAMA_INVALID: beat-01 遗漏 audio 声画义务：原台词 必须原样包含在 beatDramaturgy.audio 某一条里', candidate, '修复')
  assert.match(suffix, /声明数组某一项中完整保留.*同一说话人在自然停顿处连续分行/s)
  assert.match(suffix, /不要.*必须把实际发声合成超过6秒的一行/)
  assert.deepEqual(candidate, before)
})

test('voice-over and ambient audio do not receive dialogue binding instructions', () => {
  for (const audioType of ['旁白', '环境声']) {
    assert.equal(storyboardDialogueSplitHint({ audioText: audio, pacing, audioType }), '')
  }
})

test('voice delivery annotations remain attached to every proposed and existing line', () => {
  const candidate = { audioType: '对白', audioText: `甲（画外）：${first}${second}\n乙【轻声】：知道了。`, pacing }
  assert.equal(parseAudio(storyboardDialogueSplitHint(candidate)),
    `甲（画外）：${first}\n甲（画外）：${second}\n乙【轻声】：知道了。`)
})
