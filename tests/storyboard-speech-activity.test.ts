import test from 'node:test'
import assert from 'node:assert/strict'
import { validateStoryboardSpeechActivityCoverage } from '../src/workflow-core.ts'

const candidate = {
  audioType: '对白', audioText: '甲：天气很好。\n甲：请到门前。',
  videoPrompt: '0-0.5秒：甲站在门前。0.5-2秒：甲开口说出：天气很好。2-3.5秒：甲开口说出：请到门前。3.5-4秒：甲抬手示意。',
  pacing: { activityWindows: [{ kind: 'speech', startSecond: 0.5, endSecond: 3.5 }] },
}

test('speech budget cannot charge the silent opening or final action interval', () => {
  for (const window of [{ startSecond: 0, endSecond: 3 }, { startSecond: 1, endSecond: 4 }]) {
    const shot = { ...candidate, pacing: { activityWindows: [{ kind: 'speech', ...window }] } }
    const before = structuredClone(shot)
    assert.throws(() => validateStoryboardSpeechActivityCoverage(shot), /STORYBOARD_PACING_INVALID: speech activityWindows\[0\].*未被逐字绑定台词的时间段完整覆盖/)
    assert.deepEqual(shot, before)
  }
})

test('adjacent speaking intervals may cover one speech budget and allow parallel action budgets', () => {
  const shot = { ...candidate, pacing: { activityWindows: [
    { kind: 'speech', startSecond: 0.5, endSecond: 3.5 },
    { kind: 'action', startSecond: 1, endSecond: 2 },
  ] } }
  assert.doesNotThrow(() => validateStoryboardSpeechActivityCoverage(shot))
  assert.doesNotThrow(() => validateStoryboardSpeechActivityCoverage({ ...shot,
    pacing: { activityWindows: [{ kind: 'speech', startSecond: 0.8, endSecond: 3.2 }] } }))
})

test('non-speaking gaps cannot disappear inside a merged speech window', () => {
  const shot = { ...candidate, videoPrompt: '0-0.5秒：甲站在门前。0.5-1.5秒：甲开口说出：天气很好。1.5-2秒：甲转身。2-3.5秒：甲开口说出：请到门前。3.5-4秒：甲抬手。' }
  assert.throws(() => validateStoryboardSpeechActivityCoverage(shot), /未被逐字绑定台词/)
  assert.doesNotThrow(() => validateStoryboardSpeechActivityCoverage({ ...shot, pacing: { activityWindows: [
    { kind: 'speech', startSecond: 0.5, endSecond: 1.5 }, { kind: 'speech', startSecond: 2, endSecond: 3.5 },
  ] } }))
})

test('coverage diagnostics do not invent speaking intervals when structural prerequisites are missing', () => {
  for (const changes of [{ audioText: '' }, { videoPrompt: '' }, { audioType: '旁白' }, { pacing: {} },
    { videoPrompt: candidate.videoPrompt.replace('请到门前。', '继续说话。') },
    { pacing: { activityWindows: [null, { kind: 'speech', startSecond: NaN, endSecond: 2 }] } }]) {
    assert.doesNotThrow(() => validateStoryboardSpeechActivityCoverage({ ...candidate, ...changes }))
  }
})
