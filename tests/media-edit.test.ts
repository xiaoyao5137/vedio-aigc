import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveIdleTailEdit } from '../src/media-edit.ts'

test('idle-tail proposals retain every observed endpoint and distinguish pending edits from actual media', () => {
  const embedded = new Function(`return (${deriveIdleTailEdit.toString()})`)() as typeof deriveIdleTailEdit
  for (const derive of [deriveIdleTailEdit, embedded]) {
    const base = { duration: 14.04, lastMeaningfulActionSecond: 10, maxIdleTailSeconds: 1.2, tailSeconds: .3 }
    const current = derive({ ...base, lastSpeechEnd: 13.39 })
    assert.equal(current.idleSeconds, .65);assert.equal(current.edit, null, '本次素材0.65秒余量不触发剪辑')
    const protectedAction = derive({ ...base, duration: 4, lastMeaningfulActionSecond: 1,
      performanceChecks: [{ status: 'observed', endSecond: 3.7 }] })
    assert.equal(protectedAction.lastRequiredSecond, 3.7);assert.equal(protectedAction.edit, null)
    const pending = derive({ ...base, lastSpeechEnd: 12, performanceChecks: [{ status: 'observed', endSecond: 12.2 }] })
    assert.equal(pending.lastRequiredSecond, 12.2);assert.equal(pending.edit?.trimOut, 12.5)
    assert.equal(pending.edit?.removedSeconds, 1.54);assert.equal(pending.edit?.status, 'required')
    assert.equal(pending.edit?.sourceDuration, 14.04)
    assert.throws(() => derive({ ...base, tailSeconds: 10 }), /MEDIA_EDIT_CONFIG_INVALID:.*净裁切/)
    assert.throws(() => derive({ ...base, performanceChecks: [{ status: 'observed', endSecond: 15 }] }), /REVIEW_RESULT_INVALID/)
    assert.throws(() => derive({ ...base, performanceChecks: [{ status: 'observed', endSecond: '12' }] }), /REVIEW_RESULT_INVALID/)
  }
})

test('duration-v2 trim protects the validated completion upper bound and original readability reserve', () => {
  const embedded = new Function(`return (${deriveIdleTailEdit.toString()})`)() as typeof deriveIdleTailEdit
  for (const derive of [deriveIdleTailEdit, embedded]) {
    const base = { duration: 10, lastMeaningfulActionSecond: 4, lastSpeechEnd: 4.5, maxIdleTailSeconds: 1.2, tailSeconds: .3,
      durationCompletion: { applicable: true, assessment: 'complete', passed: true,
        actualCompletionInterval: { lower: 7.8, upper: 8 }, requiredEndSecond: 8.5 } }
    const result = derive(base)
    assert.equal(result.lastRequiredSecond, 8); assert.equal(result.edit?.trimOut, 8.5)
    assert.equal(result.edit?.removedSeconds, 1.5); assert.equal(result.edit?.status, 'required')
    assert.equal(derive({ ...base, duration: 9 }).edit, null, '群众已结束后的合理呼吸余量不因较早ASR而被裁掉')
    for (const completion of [ { ...base.durationCompletion, passed: false }, { ...base.durationCompletion, assessment: 'uncertain' },
      { ...base.durationCompletion, assessment: 'incomplete' }, { ...base.durationCompletion, requiredEndSecond: 7.9 },
      { ...base.durationCompletion, actualCompletionInterval: null }, { ...base.durationCompletion, requiredEndSecond: 10.1 } ]) {
      assert.throws(() => derive({ ...base, durationCompletion: completion }), /duration-v2裁剪缺少/)
    }
  }
})
