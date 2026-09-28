import { storyboardTimelineConsumerCode } from '../src/storyboard-timeline.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMediaRequirements } from '../src/media-requirement-coverage.ts'
import { deriveMediaSamplingPlan } from '../src/media-sampling-plan.ts'

const planners = [deriveMediaSamplingPlan,
  new Function(`const deriveMediaRequirements=${storyboardTimelineConsumerCode(deriveMediaRequirements)};return (${deriveMediaSamplingPlan.toString()});`)() as typeof deriveMediaSamplingPlan]

test('every actual requirement window receives beginning, middle and ending requests, including short final actions', () => {
  const shot = { duration: 14, visualPrompt: '人物站在门前。', lastFramePrompt: '人物恢复原姿态。',
    videoPrompt: '0-1秒：人物拱手站立。1-5.4秒：微微欠身说话。5.4-9.8秒：保持原姿态。9.8-13.1秒：继续台词。13.1-14秒：恢复直立。' }
  const original = structuredClone(shot)
  for (const plan of planners) {
    const result = plan(shot)
    assert.equal(result.duration, 14);assert.equal(result.maxFrames, 24)
    assert.equal(result.sampleTimes[0], 0);assert.equal(result.sampleTimes.at(-1), 14)
    assert.equal(result.sampleTimes.length, 11)
    for (const requirement of deriveMediaRequirements(shot).filter(item => item.scope === 'interval')) {
      const midpoint = requirement.startSecond + (requirement.endSecond - requirement.startSecond) / 2
      for (const time of [requirement.startSecond, midpoint, requirement.endSecond]) assert.ok(result.sampleTimes.includes(time))
    }
    assert.ok(result.sampleTimes.includes(3.2), '1–5.4秒不再仅有一张2.81秒旧均匀帧')
    assert.ok(result.sampleTimes.includes(13.55), '13.1–14秒具有动作中段采证，不能借用12.64秒上下文帧')
    assert.deepEqual(shot, original);assert.deepEqual(plan(shot), result)
    assert.deepEqual(plan(shot, undefined), result);assert.deepEqual(plan(shot, { maxFrames: undefined }), result)
  }
})

test('sampling follows arbitrary source windows, deduplicates shared boundaries and retains both endpoints', () => {
  const shot = { duration: 7.5, firstFramePrompt: '案前站立。', lastFramePrompt: '案旁坐下。', videoPrompt: '0至2秒：站立。2～5秒：走向案旁。5—7.5秒：坐下。' }
  for (const plan of planners) {
    assert.deepEqual(plan(shot, { maxFrames: 7 }), { duration: 7.5, maxFrames: 7, sampleTimes: [0, 1, 2, 3.5, 5, 6.25, 7.5] })
    assert.deepEqual(plan({ duration: 3.75, visualPrompt: '人物静立。', lastFramePrompt: '人物静立。' }).sampleTimes, [0, 3.75])
    assert.deepEqual(plan({ duration: 6, videoPrompt: '1-3秒：人物移动。' }).sampleTimes, [0, 1, 2, 3, 6])
  }
})

test('overlapping windows and floating arithmetic do not purchase duplicate sample requests', () => {
  const shot = { duration: .4, videoPrompt: '0.1-0.2秒：动作甲。0.15-0.3秒：动作乙。' }
  for (const plan of planners) {
    const result = plan(shot, { maxFrames: 7 })
    assert.equal(result.sampleTimes.length, 7)
    assert.equal(result.sampleTimes.filter(time => Math.abs(time - .15) < 1e-12).length, 1)
    assert.equal(result.sampleTimes[0], 0);assert.equal(result.sampleTimes.at(-1), .4)
    assert.deepEqual([...result.sampleTimes].sort((left, right) => left - right), result.sampleTimes)
  }
})

test('exceeding the configured budget fails explicitly instead of dropping later intervals', () => {
  const shot = { duration: 12, videoPrompt: Array.from({ length: 12 }, (_, index) => `${index}-${index + 1}秒：动作${index}。`).join('') }
  const original = structuredClone(shot)
  for (const plan of planners) {
    assert.throws(() => plan(shot), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^MEDIA_SAMPLING_PLAN_INVALID:.*需要 25 帧.*maxFrames=24/)
      assert.match(error.message, /未截断或忽略任何时间窗/)
      assert.ok(error.message.includes('"startSecond":11,"endSecond":12'), '末段仍在完整诊断中，不能静默漏采')
      return true
    })
    assert.throws(() => plan(shot, { maxFrames: 25 }), /maxFrames 必须是 2\.\.24/)
    const feasible = { duration: 11, videoPrompt: Array.from({ length: 11 }, (_, index) => `${index}-${index + 1}秒：动作${index}。`).join('') }
    assert.throws(() => plan(feasible, { maxFrames: 22 }), /需要 23 帧.*maxFrames=22/)
    const result = plan(feasible, { maxFrames: 23 })
    assert.equal(result.sampleTimes.length, 23)
    assert.deepEqual(result.sampleTimes.slice(-3), [10, 10.5, 11])
    assert.deepEqual(shot, original)
    assert.throws(() => plan({ duration: 4, videoPrompt: '0-4秒：动作。' }, { maxFrames: 2 }), /需要 3 帧.*maxFrames=2/)
  }
})

test('invalid durations, budgets and original bounds are surfaced as sampling configuration errors', () => {
  for (const plan of planners) {
    for (const duration of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => plan({ duration }), /MEDIA_SAMPLING_PLAN_INVALID:.*duration/)
    }
    for (const maxFrames of [0, 1, -1, 2.5, 25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => plan({ duration: 5 }, { maxFrames }), /MEDIA_SAMPLING_PLAN_INVALID:.*maxFrames/)
    }
    for (const videoPrompt of ['0-6秒：超出时长。', '2-2秒：零长动作。', '4-1秒：逆序动作。', '没有可定位的时间窗']) {
      assert.throws(() => plan({ duration: 5, videoPrompt }), /^Error: MEDIA_SAMPLING_PLAN_INVALID:/)
    }
  }
})
