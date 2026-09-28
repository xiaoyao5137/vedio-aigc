import test from 'node:test'
import assert from 'node:assert/strict'
import { dynamicStoryboardTiming, performanceStoryboardTiming } from '../src/history-pacing.ts'

function freeze(value: unknown) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
}

test('one shaped candidate reports speech mismatch and missing reaction windows together without changing the draft', () => {
  const pacing = { actionSeconds: 0.5, reactionSeconds: 0.3, activityWindows: [
    { kind: 'speech', startSecond: 0.5, endSecond: 11.5 },
    { kind: 'action', startSecond: 0, endSecond: 0.5 },
  ] }
  const before = JSON.stringify(pacing)
  freeze(pacing)
  assert.throws(() => performanceStoryboardTiming(pacing, 11.77), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /^STORYBOARD_PACING_INVALID:/)
    assert.match(error.message, /speech activityWindows 应覆盖 11.77 秒，actual=11、expected=11.77 秒/)
    assert.match(error.message, /reaction activityWindows 应覆盖 0.3 秒，actual=0、expected=0.3 秒；窗口数=0（空窗）/)
    assert.doesNotMatch(error.message, /\baction activityWindows 应覆盖/)
    return true
  })
  assert.equal(JSON.stringify(pacing), before)
})

test('a same-kind overlap is reported with other budget failures even when its union matches the budget', () => {
  const pacing = { actionSeconds: 1, reactionSeconds: 0.3, activityWindows: [
    { kind: 'speech', startSecond: 0, endSecond: 1 },
    { kind: 'speech', startSecond: 0.5, endSecond: 1.5 },
  ] }
  assert.throws(() => performanceStoryboardTiming(pacing, 1.5), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /speech activityWindows.*actual=1.5、expected=1.5.*重复覆盖=0.5 秒/)
    assert.match(error.message, /action activityWindows.*actual=0、expected=1.*空窗/)
    assert.match(error.message, /reaction activityWindows.*actual=0、expected=0.3.*空窗/)
    return true
  })
})

test('valid cross-kind overlap and legacy aggregate budgets keep the same results and input', () => {
  const pacing = { version: 'dynamic-v1', actionSeconds: 1, reactionSeconds: 0.5, activityWindows: [
    { kind: 'speech', startSecond: 0, endSecond: 2 },
    { kind: 'action', startSecond: 0, endSecond: 1 },
    { kind: 'reaction', startSecond: 2, endSecond: 2.5 },
  ] }
  const before = JSON.stringify(pacing)
  freeze(pacing)
  assert.deepEqual(performanceStoryboardTiming(pacing, 2), {
    performanceSeconds: 0, additionalPerformanceSeconds: 0, overlapSeconds: 1, occupiedSeconds: 2.5, plannedEndSecond: 2.5,
  })
  assert.equal(JSON.stringify(pacing), before)
  assert.equal(performanceStoryboardTiming({ actionSeconds: 1, reactionSeconds: 0.5 }, 2), undefined)
  assert.equal(dynamicStoryboardTiming('甲：天地玄黄宇宙洪荒日', pacing).requiredDuration, 3)
})

test('existing mismatch and same-kind overlap tolerances stay unchanged', () => {
  const candidate = (endSecond: number) => ({ actionSeconds: 0, reactionSeconds: 0, activityWindows: [
    { kind: 'speech', startSecond: 0, endSecond },
  ] })
  assert.doesNotThrow(() => performanceStoryboardTiming(candidate(1.059), 1))
  assert.throws(() => performanceStoryboardTiming(candidate(1.061), 1), /speech activityWindows/)
  const overlapping = (secondStart: number) => ({ actionSeconds: 0, reactionSeconds: 0, activityWindows: [
    { kind: 'speech', startSecond: 0, endSecond: 1 },
    { kind: 'speech', startSecond: secondStart, endSecond: 2 },
  ] })
  assert.doesNotThrow(() => performanceStoryboardTiming(overlapping(0.991), 2))
  assert.throws(() => performanceStoryboardTiming(overlapping(0.989), 2), /重复覆盖=0.011 秒/)
})

test('invalid shapes still fail before budget arithmetic or dependent performance checks', () => {
  for (const pacing of [
    { actionSeconds: 1, reactionSeconds: 0.3, activityWindows: [null] },
    { actionSeconds: 1, reactionSeconds: 0.3, activityWindows: [{ kind: 'speech', startSecond: 1, endSecond: 0 }] },
    { actionSeconds: 1, reactionSeconds: 0.3, activityWindows: [], performanceBeats: [null] },
  ]) assert.throws(() => performanceStoryboardTiming(pacing, 4), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /^STORYBOARD_PACING_INVALID:/)
    assert.doesNotMatch(error.message, /actual=|expected=|TypeError/)
    return true
  })
})
