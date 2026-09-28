import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { storyboardDialogueScheduleHint } from '../src/workflow-core.ts'
import { dynamicStoryboardTiming, speechBudgetSeconds } from '../src/history-pacing.ts'

const actualShot = JSON.parse(readFileSync(new URL('./fixtures/storyboard-activity-window-budget.json', import.meta.url), 'utf8'))
const audioText = '甲：甲乙丙丁戊己庚辛壬'
const pacing = { version: 'dynamic-v1', actionSeconds: 1, reactionSeconds: 0.5,
  activityWindows: [
    { kind: 'action', startSecond: 0, endSecond: 1 },
    { kind: 'speech', startSecond: 1.6, endSecond: 3.6 },
    { kind: 'reaction', startSecond: 3.6, endSecond: 4.1 },
  ],
}

test('valid activity windows without beats keep their declared schedule instead of a new serial one', () => {
  const shot = { audioText, pacing }
  const before = structuredClone(shot)
  const hint = storyboardDialogueScheduleHint(shot)
  assert.match(hint, /已核验的活动时间预算/)
  assert.ok(hint.includes(`activityWindows=${JSON.stringify(pacing.activityWindows)}`))
  assert.match(hint, /activityWindows最晚结束于4\.1秒/)
  assert.match(hint, /plannedEndSecond=4\.1秒/)
  assert.match(hint, /duration须为5秒，videoPrompt 时间轴连续覆盖0到5秒/)
  assert.doesNotMatch(hint, /逐句自然语速的参考时间窗|0到1秒只安排/)
  assert.deepEqual(shot, before)
  assert.equal(storyboardDialogueScheduleHint({ ...shot, pacing: { ...pacing, performanceBeats: [] } }), hint)
})

test('a valid parallel schedule is not turned into speech starting after actionSeconds', () => {
  const parallel = { ...pacing, activityWindows: [
    { kind: 'action', startSecond: 0, endSecond: 1 },
    { kind: 'speech', startSecond: 0, endSecond: 2 },
    { kind: 'reaction', startSecond: 1.5, endSecond: 2 },
  ] }
  const hint = storyboardDialogueScheduleHint({ audioText, pacing: parallel })
  assert.ok(hint.includes(JSON.stringify(parallel.activityWindows)))
  assert.match(hint, /plannedEndSecond=2秒/)
  assert.match(hint, /duration须为3秒/)
  assert.doesNotMatch(hint, /参考时间窗|0到1秒只安排/)
})

test('arithmetic-only schedule hints permit required dialogue splitting and recomputation', () => {
  const text = '甲：甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒。'
  const seconds = speechBudgetSeconds(text)
  const shot = { audioText: text, pacing: { version: 'dynamic-v1', actionSeconds: 0, reactionSeconds: 0.5,
    activityWindows: [{ kind: 'speech', startSecond: 0, endSecond: seconds },
      { kind: 'reaction', startSecond: seconds, endSecond: seconds + 0.5 }] } }
  for (const error of ['STORYBOARD_PROMPT_OVERLOAD: 超过单条口型锚点 6 秒上限',
    'STORYBOARD_PACING_INVALID: speech activityWindows 未被逐字绑定台词的时间段完整覆盖']) {
    const hint = storyboardDialogueScheduleHint(shot, 4.5, error)
    assert.match(hint, /仅在本次audioText分行与活动排程保持不变时/)
    assert.match(hint, /若其他校验要求拆行或调整说话\/动作时间.*重新核算.*不能把旧窗口当作不可变约束/)
  }
})

test('activity end and the final performance end remain distinct from integer video duration', () => {
  const performance = { version: 'dynamic-v1', actionSeconds: 0, reactionSeconds: 0.3,
    activityWindows: [{ kind: 'reaction', startSecond: 0, endSecond: 0.3 }],
    performanceBeats: [{ id: 'decision', purpose: '结束交谈', stateChange: '收回招呼并移开视线',
      evidenceAnchor: '收回招呼', startSecond: 0, endSecond: 2.7, overlapWith: ['reaction'] }],
  }
  const shot = { audioText: '', pacing: performance, videoPrompt: '0-3秒：甲收回招呼并移开视线。' }
  const hint = storyboardDialogueScheduleHint(shot)
  assert.match(hint, /activityWindows最晚结束于0\.3秒/)
  assert.match(hint, /plannedEndSecond=2\.7秒/)
  assert.match(hint, /duration须为3秒/)
  assert.ok(hint.includes(`performanceBeats=${JSON.stringify(performance.performanceBeats)}`))
})

test('the real rejected shot receives calculable speech budget without reinstating its invalid windows', () => {
  const before = structuredClone(actualShot)
  assert.throws(() => dynamicStoryboardTiming(actualShot.audioText, actualShot.pacing, actualShot), /speech activityWindows/)
  const hint = storyboardDialogueScheduleHint(actualShot)
  assert.match(hint, /重新预算/)
  assert.match(hint, /speechSeconds=11\.97/)
  assert.match(hint, /duration=max\(3,ceil\(plannedEndSecond\+0\.3\)\)/)
  assert.match(hint, /活动结束时刻不等于整数片长/)
  assert.doesNotMatch(hint, /都必须落到 14 秒|已核验|逐句自然语速的参考时间窗|删除 performanceBeats/)
  assert.deepEqual(actualShot, before)
})

test('an isolated corrected timing copy of the real shot preserves its full dialogue and actual window end', () => {
  const speechEnd = 1 + speechBudgetSeconds(actualShot.audioText)
  const plannedEnd = speechEnd + 0.7
  // This only exercises timing guidance; the actual stored script is not repaired or accepted here.
  const copy = structuredClone(actualShot)
  copy.pacing.activityWindows = [
    { kind: 'action', startSecond: 0, endSecond: 1 },
    { kind: 'speech', startSecond: 1, endSecond: speechEnd },
    { kind: 'reaction', startSecond: speechEnd, endSecond: plannedEnd },
  ]
  const before = structuredClone(copy)
  const hint = storyboardDialogueScheduleHint(copy)
  assert.ok(hint.includes(`plannedEndSecond=${plannedEnd}秒`))
  assert.match(hint, /duration须为14秒/)
  assert.doesNotMatch(hint, /都必须落到|参考时间窗/)
  assert.deepEqual(copy, before)
  assert.equal(copy.audioText, actualShot.audioText)
  assert.equal(copy.videoPrompt, actualShot.videoPrompt)
})

test('a valid window plan exceeding 15 seconds asks for a preserving split, not clipping', () => {
  const overflow = { version: 'dynamic-v1', actionSeconds: 10, reactionSeconds: 1,
    activityWindows: [
      { kind: 'action', startSecond: 1, endSecond: 11 },
      { kind: 'speech', startSecond: 11, endSecond: 13 },
      { kind: 'reaction', startSecond: 14.2, endSecond: 15.2 },
    ],
  }
  const hint = storyboardDialogueScheduleHint({ audioText, pacing: overflow })
  assert.match(hint, /当前需要16秒，超过15秒上限/)
  assert.match(hint, /保留完整剧情和台词拆段后重新预算，不能裁成15秒/)
  assert.ok(hint.includes(JSON.stringify(overflow.activityWindows)))
})

test('inputs without windows retain existing dynamic scheduling and rejected holds retain the reset warning', () => {
  const ordinary = { audioText, pacing: { version: 'dynamic-v1', actionSeconds: 1, reactionSeconds: 0.5 } }
  const hint = storyboardDialogueScheduleHint(ordinary)
  assert.match(hint, /程序计算的动态预算/)
  assert.match(hint, /逐句自然语速的参考时间窗/)
  const rejected = storyboardDialogueScheduleHint(ordinary, 4.5, 'STORYBOARD_PACING_INVALID: 静止保持不能充作动作')
  assert.match(rejected, /旧 pacing 与时间窗已被拒绝，不可沿用/)
  assert.doesNotMatch(rejected, /已核验的活动时间预算|参考时间窗/)
})
