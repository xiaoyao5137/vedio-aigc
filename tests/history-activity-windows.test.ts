import test from 'node:test'
import assert from 'node:assert/strict'
import { dynamicStoryboardTiming, performanceStoryboardTiming, speechBudgetSeconds } from '../src/history-pacing.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

const audioText = '甲：甲乙丙丁戊己庚辛壬'
const pacing = {
  version: 'dynamic-v1', actionSeconds: 1, reactionSeconds: 0.5,
  activityWindows: [
    { kind: 'action', startSecond: 0, endSecond: 1 },
    { kind: 'speech', startSecond: 1.6, endSecond: 3.6 },
    { kind: 'reaction', startSecond: 3.6, endSecond: 4.1 },
  ],
}

test('explicit activity windows without beats determine duration from their actual end', () => {
  assert.equal(speechBudgetSeconds(audioText), 2)
  const before = structuredClone(pacing)
  const timing = dynamicStoryboardTiming(audioText, pacing)
  assert.equal(timing.plannedEndSecond, 4.1)
  assert.equal(timing.rawRequiredSeconds, 4.4)
  assert.equal(timing.requiredDuration, 5)
  assert.equal(timing.occupiedSeconds, 3.5)
  assert.equal(timing.performanceSeconds, 0)
  assert.equal(timing.additionalPerformanceSeconds, 0)
  assert.deepEqual(pacing, before)
  assert.equal(Object.hasOwn(pacing, 'performanceBeats'), false)
  assert.equal(Object.hasOwn(timing, 'observed'), false)
  assert.equal(Object.hasOwn(timing, 'critical'), false)
  assert.deepEqual(dynamicStoryboardTiming(audioText, { ...pacing, performanceBeats: [] }), timing)
})

test('missing windows retain the legacy aggregate budget with absent or empty beats', () => {
  const legacy = { version: 'dynamic-v1', actionSeconds: 1, reactionSeconds: 0.5 }
  assert.equal(performanceStoryboardTiming(legacy, 2), undefined)
  assert.equal(performanceStoryboardTiming({ ...legacy, performanceBeats: [] }, 2), undefined)
  const timing = dynamicStoryboardTiming(audioText, legacy)
  assert.equal(timing.rawRequiredSeconds, 3.8)
  assert.equal(timing.requiredDuration, 4)
  assert.deepEqual(dynamicStoryboardTiming(audioText, { ...legacy, performanceBeats: [] }), timing)
  assert.throws(() => dynamicStoryboardTiming(audioText, { ...legacy, performanceBeats: null }), /performanceBeats/)
})

test('provided windows are validated even without performance beats', () => {
  const badRows = [
    null, {}, [], 'action',
    { kind: 'pause', startSecond: 0, endSecond: 1 },
    { kind: 'action', startSecond: -0.1, endSecond: 1 },
    { kind: 'action', startSecond: 1, endSecond: 1 },
    { kind: 'action', startSecond: 2, endSecond: 1 },
    { kind: 'action', startSecond: 0, endSecond: Infinity },
    { kind: 'action', startSecond: NaN, endSecond: 1 },
    { kind: 'action', startSecond: '0', endSecond: 1 },
  ]
  for (const row of badRows) {
    assert.throws(() => dynamicStoryboardTiming(audioText, {
      ...pacing, activityWindows: [row, ...pacing.activityWindows.slice(1)],
    }), /STORYBOARD_PACING_INVALID.*activityWindows/)
  }
  for (const activityWindows of [null, {}, '', 0]) {
    assert.throws(() => dynamicStoryboardTiming(audioText, { ...pacing, activityWindows }), /STORYBOARD_PACING_INVALID.*activityWindows/)
  }
  assert.throws(() => dynamicStoryboardTiming(audioText, { ...pacing, activityWindows: [] }), /STORYBOARD_PACING_INVALID/)
})

test('speech, action, and reaction totals must each match their explicit budget without beats', () => {
  for (const kind of ['speech', 'action', 'reaction']) {
    const activityWindows = pacing.activityWindows.map(window => window.kind === kind
      ? { ...window, endSecond: window.endSecond + 0.2 } : window)
    assert.throws(() => dynamicStoryboardTiming(audioText, { ...pacing, activityWindows }),
      new RegExp(`STORYBOARD_PACING_INVALID: ${kind} activityWindows`))
  }
  assert.throws(() => performanceStoryboardTiming({ ...pacing, actionSeconds: undefined }, 2), /action activityWindows/)
  assert.throws(() => performanceStoryboardTiming(pacing, NaN), /speech activityWindows/)
})

test('same-kind duplicate windows cannot spend the same time twice without beats', () => {
  assert.throws(() => dynamicStoryboardTiming(audioText, {
    ...pacing, activityWindows: [...pacing.activityWindows, { ...pacing.activityWindows[0] }],
  }), /action activityWindows.*不能重复计时/)
  assert.throws(() => dynamicStoryboardTiming(audioText, {
    ...pacing, activityWindows: [
      { kind: 'action', startSecond: 0, endSecond: 0.6 },
      { kind: 'action', startSecond: 0.5, endSecond: 1 },
      ...pacing.activityWindows.slice(1),
    ],
  }), /action activityWindows.*不能重复计时/)
})

test('different activity kinds may overlap and count their occupied time only once', () => {
  const parallel = { ...pacing, activityWindows: [
    { kind: 'action', startSecond: 0, endSecond: 1 },
    { kind: 'speech', startSecond: 0, endSecond: 2 },
    { kind: 'reaction', startSecond: 1.5, endSecond: 2 },
  ] }
  const timing = dynamicStoryboardTiming(audioText, parallel)
  assert.equal(timing.occupiedSeconds, 2)
  assert.equal(timing.overlapSeconds, 1.5)
  assert.equal(timing.plannedEndSecond, 2)
  assert.equal(timing.rawRequiredSeconds, 2.3)
  assert.equal(timing.requiredDuration, 3)
})

test('chronology is validated by timestamps and large unexplained gaps still fail without beats', () => {
  const reversed = { ...pacing, activityWindows: [...pacing.activityWindows].reverse() }
  const before = structuredClone(reversed)
  assert.deepEqual(dynamicStoryboardTiming(audioText, reversed), dynamicStoryboardTiming(audioText, pacing))
  assert.deepEqual(reversed, before)
  const delayed = { ...pacing, activityWindows: [pacing.activityWindows[0],
    { kind: 'speech', startSecond: 2.3, endSecond: 4.3 },
    { kind: 'reaction', startSecond: 4.3, endSecond: 4.8 },
  ] }
  assert.throws(() => dynamicStoryboardTiming(audioText, delayed), /超过 1.2 秒的未解释空等/)
})

test('nonempty performance beats keep overlap accounting and visible-action validation', () => {
  const performance = { version: 'dynamic-v1', actionSeconds: 0, reactionSeconds: 0.3,
    activityWindows: [{ kind: 'reaction', startSecond: 0, endSecond: 0.3 }],
    performanceBeats: [{ id: 'decision', purpose: '结束交谈', stateChange: '收回招呼并移开视线',
      evidenceAnchor: '收回招呼', startSecond: 0, endSecond: 2.7, overlapWith: ['reaction'] }],
  }
  const shot = { videoPrompt: '0-3秒：甲收回招呼并移开视线。' }
  const timing = dynamicStoryboardTiming('', performance, shot)
  assert.equal(timing.requiredDuration, 3)
  assert.equal(timing.additionalPerformanceSeconds, 2.4)
  assert.equal(timing.overlapSeconds, 0.3)
  assert.throws(() => dynamicStoryboardTiming('', { ...performance, activityWindows: undefined }, shot), /activityWindows/)
  assert.throws(() => dynamicStoryboardTiming('', { ...performance,
    performanceBeats: [{ ...performance.performanceBeats[0], overlapWith: [] }],
  }, shot), /overlapWith/)
  assert.throws(() => dynamicStoryboardTiming('', { ...performance,
    performanceBeats: [{ ...performance.performanceBeats[0], stateChange: '保持静止' }],
  }, shot), /不能用心理标签或保持静帧/)
})

test('window end beyond the short-clip limit remains an explicit overflow instead of truncation', () => {
  const overflow = { version: 'dynamic-v1', actionSeconds: 10, reactionSeconds: 1,
    activityWindows: [
      { kind: 'action', startSecond: 1, endSecond: 11 },
      { kind: 'speech', startSecond: 11, endSecond: 13 },
      { kind: 'reaction', startSecond: 14.2, endSecond: 15.2 },
    ],
  }
  const timing = dynamicStoryboardTiming(audioText, overflow)
  assert.equal(timing.plannedEndSecond, 15.2)
  assert.equal(timing.requiredDuration, 16)
  const shot = { id: 's1', title: '回应', duration: 14, pacing: overflow,
    characters: ['甲'], initialCharacters: ['甲'], enteringCharacters: [], endCharacters: ['甲'],
    visualPrompt: '甲抬手', lastFramePrompt: '甲收手', camera: '中景', mood: '自然',
    firstFrameMode: 'reference', continuity: { previousShotId: '', bridgeType: 'opening', bridgeAnchor: '' },
    videoPrompt: '0-11秒：甲抬手。11-13秒：甲说出“甲乙丙丁戊己庚辛壬”。13-14秒：甲收手。',
    audioType: '对白', audioText, historicalBasis: '[史料1] 人物应答', adaptationBoundary: '动作对白拟制',
  }
  const before = structuredClone(shot)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', shot, { requireDynamicPacing: true }),
    /STORYBOARD_TIMING_OVERFLOW:.*16 秒.*超过 15 秒上限/)
  assert.deepEqual(shot, before)
})

test('rounded aggregate duration cannot hide an overstated speech window and later reaction', () => {
  const speech = 11.972222222222221
  const candidate = { version: 'dynamic-v1', actionSeconds: 1, reactionSeconds: 0.7,
    activityWindows: [
      { kind: 'action', startSecond: 0, endSecond: 1 },
      { kind: 'speech', startSecond: 1, endSecond: 13.1 },
      { kind: 'reaction', startSecond: 13.1, endSecond: 13.8 },
    ],
  }
  assert.equal(Math.ceil(speech + candidate.actionSeconds + candidate.reactionSeconds + 0.3), 14)
  assert.equal(Math.ceil(13.8 + 0.3), 15)
  assert.throws(() => performanceStoryboardTiming(candidate, speech), /speech activityWindows.*拉长自然语速/)
  assert.throws(() => performanceStoryboardTiming({ ...candidate, performanceBeats: [] }, speech), /speech activityWindows/)
})
