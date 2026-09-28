import { storyboardTimelineConsumerCode } from '../src/storyboard-timeline.ts'
import { resolveNativeFrameDisplayInterval } from '../src/media-frame-display.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMediaRequirements } from '../src/media-requirement-coverage.ts'
import { deriveAdaptiveMediaSamplingPlan, type AdaptiveMediaSamplingPlan } from '../src/media-adaptive-sampling.ts'

const planners = [deriveAdaptiveMediaSamplingPlan,
  new Function(`const resolveNativeFrameDisplayInterval=(${resolveNativeFrameDisplayInterval.toString()});const deriveMediaRequirements=${storyboardTimelineConsumerCode(deriveMediaRequirements)};return (${deriveAdaptiveMediaSamplingPlan.toString()});`)() as typeof deriveAdaptiveMediaSamplingPlan]
const policy = { maxFrames: 24, maxRounds: 2 }
const shot = { duration: 14, visualPrompt: '人物站在门前。', lastFramePrompt: '人物恢复原姿态。',
  videoPrompt: '0-1秒：人物静立。1-5.4秒：人物作出回应。5.4-9.8秒：保持原姿态。9.8-13.1秒：人物确认许可。13.1-14秒：恢复直立。' }
const requirements = deriveMediaRequirements(shot)
const frameTimes = [0, .5, 1, 3.2, 5.4, 7.6, 9.8, 11.45, 13.1, 13.55, 13.96]
const media = (times = frameTimes, originalUrl = 'https://media.test/original.mp4') =>
  ({ duration: 14.04, originalUrl, url: '/generated/verified.mp4', frameTimes: [...times], frames: times.map((_, index) => '/frame-' + index + '.jpg') })
const report = (times = frameTimes) => ({ decision: 'uncertain', passed: false,
  requirementChecks: requirements.map(requirement => ({ requirementId: requirement.id,
    status: [1, 9.8].includes(requirement.startSecond) ? 'unobservable' : 'complete', evidence: '实际采样无法确认本项动作过程。',
    frameIndices: times.flatMap((time, index) => time >= requirement.startSecond && time <= requirement.endSecond ? [index] : []) })) })

test('explicit native fallback preserves sparse round limits and requests each complete unresolved original window once', () => {
  for (const plan of planners) {
    const first = plan(shot, media(), report(), policy)!
    const second = plan(shot, media(first.sampleTimes), report(first.sampleTimes), policy, first)!
    const config = { ...policy, nativeSequence: true, nativeReviewMaxFrames: 160 }
    const native = plan(shot, media(second.sampleTimes), report(second.sampleTimes), config, second)!
    assert.equal(native.round, 2, '原生证据是单独有界阶段，不把稀疏maxRounds提高到3')
    assert.deepEqual(native.sampleTimes, second.sampleTimes)
    assert.deepEqual(native.nativeSequence, { enabled: true, windows: [{ start: 1, end: 5.4 }, { start: 9.8, end: 13.1 }], reviewMaxFrames: 160 })
    assert.throws(() => plan(shot, media(second.sampleTimes), report(second.sampleTimes), config, native), /MEDIA_ADAPTIVE_SAMPLING_PENDING/)
    const completed = { ...media(second.sampleTimes), nativeSequence: { windows: native.nativeSequence!.windows.map(window => ({ ...window, complete: true })) } }
    assert.throws(() => plan(shot, completed, report(second.sampleTimes), config, native), /MEDIA_ADAPTIVE_SAMPLING_LIMIT:.*连续原生帧已覆盖/)
    assert.throws(() => plan(shot, { ...completed, nativeSequence: { ...completed.nativeSequence, sourceVideoSha256: 'a'.repeat(64) } }, report(second.sampleTimes), config), /MEDIA_ADAPTIVE_SAMPLING_LIMIT:.*不能重置/)
    const fresh = plan(shot, media(frameTimes, 'https://media.test/new-video.mp4'), report(), config, native)!
    assert.equal(fresh.round, 1);assert.equal(fresh.nativeSequence, undefined)
    assert.throws(() => plan(shot, media(), report(), { ...config, nativeReviewMaxFrames: 257 }), /nativeReviewMaxFrames/)
  }
})

test('two unresolved intervals refine 11 actual samples to 15 then 23 while preserving the actual tail and every old frame', () => {
  for (const plan of planners) {
    const evidence = media(), review = report(), before = structuredClone({ shot, evidence, review })
    const first = plan(shot, evidence, review, policy)!
    assert.equal(first.sourceUrl, evidence.originalUrl);assert.equal(first.round, 1);assert.equal(first.sampleTimes.length, 15)
    assert.deepEqual(first.requirementIds, requirements.filter(requirement => [1, 9.8].includes(requirement.startSecond)).map(requirement => requirement.id))
    for (const time of [...frameTimes, 2.1, 4.3, 10.625, 12.275]) assert.ok(first.sampleTimes.some(sample => Math.abs(sample - time) < 1e-12))
    assert.equal(first.sampleTimes.at(-1), 13.96);assert.ok(!first.sampleTimes.includes(14), '不把计划时长冒充实际尾帧')
    const second = plan(shot, media(first.sampleTimes), report(first.sampleTimes), policy, first)!
    assert.equal(second.round, 2);assert.equal(second.sampleTimes.length, 23)
    for (const time of first.sampleTimes) assert.ok(second.sampleTimes.includes(time))
    assert.equal(second.sampleTimes.at(-1), 13.96)
    assert.throws(() => plan(shot, media(second.sampleTimes), report(second.sampleTimes), policy, second), /MEDIA_ADAPTIVE_SAMPLING_LIMIT:.*maxRounds=2/)
    assert.deepEqual({ shot, evidence, review }, before)
  }
})

test('completed native windows cannot be reported as exhausting a newly unresolved interval', () => {
  for (const plan of planners) {
    const config = { ...policy, nativeSequence: true, nativeReviewMaxFrames: 160 }
    const first = plan(shot, media(), report(), policy)!
    const second = plan(shot, media(first.sampleTimes), report(first.sampleTimes), policy, first)!
    const native = plan(shot, media(second.sampleTimes), report(second.sampleTimes), config, second)!
    const completed = { ...media(second.sampleTimes), nativeSequence: {
      windows: native.nativeSequence!.windows.map(window => ({ ...window, complete: true })),
    } }
    const newlyUnknown = report(second.sampleTimes)
    const requirement = requirements.find(item => item.scope === 'interval' && item.startSecond === 5.4)!
    newlyUnknown.requirementChecks.find(item => item.requirementId === requirement.id)!.status = 'unobservable'
    const before = structuredClone({ native, completed, newlyUnknown })
    assert.throws(() => plan(shot, completed, newlyUnknown, config, native), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /MEDIA_ADAPTIVE_SAMPLING_LIMIT:.*尚未覆盖.*旧窗口完成不能证明新窗口已穷尽/)
      assert.ok(error.message.includes(requirement.id))
      assert.ok(!error.message.includes('连续原生帧已覆盖本次请求窗口'))
      return true
    })
    assert.deepEqual({ native, completed, newlyUnknown }, before)
  }
})

test('a partial bisection plan fits the budget without dropping any old sample or starving an unresolved interval', () => {
  for (const plan of planners) {
    for (const maxFrames of [13, 14]) {
      const result = plan(shot, media(), report(), { ...policy, maxFrames })!
      assert.equal(result.sampleTimes.length, maxFrames)
      for (const time of frameTimes) assert.ok(result.sampleTimes.includes(time))
      for (const requirement of requirements.filter(item => [1, 9.8].includes(item.startSecond))) {
        assert.ok(result.sampleTimes.some(time => !frameTimes.includes(time) && time >= requirement.startSecond && time <= requirement.endSecond))
      }
    }
    assert.throws(() => plan(shot, media(), report(), { ...policy, maxFrames: 12 }), error => {
      assert.ok(error instanceof Error);assert.match(error.message, /MEDIA_ADAPTIVE_SAMPLING_LIMIT:.*至少需要 13 帧.*maxFrames=12/)
      for (const requirement of requirements.filter(item => [1, 9.8].includes(item.startSecond))) assert.ok(error.message.includes(requirement.id))
      assert.match(error.message, /不截断原要求、不购买新视频/);return true
    })
    const first = plan(shot, media(), report(), policy)!
    const second = plan(shot, media(first.sampleTimes), report(first.sampleTimes), { ...policy, maxFrames: 22 }, first)!
    assert.equal(second.round, 2);assert.equal(second.sampleTimes.length, 22)
    for (const time of first.sampleTimes) assert.ok(second.sampleTimes.includes(time))
    for (const maxFrames of [1, 25, 2.5, NaN]) assert.throws(() => plan(shot, media(), report(), { ...policy, maxFrames }), /maxFrames/)
    for (const maxRounds of [0, -1, 1.5, NaN]) assert.throws(() => plan(shot, media(), report(), { ...policy, maxRounds }), /maxRounds/)
  }
})

test('a newly unresolved ending interval shares the second-round budget with both prior unknown intervals', () => {
  const times = [0, .5, 1, 2.1, 3.2, 4.3, 5.4, 7.6, 9.8, 10.625, 11.45, 12.275, 13.1, 13.55, 13.96]
  for (const plan of planners) {
    const first = plan(shot, media(), report(), policy)!
    const evidence = media(times), review = report(times)
    const ending = requirements.find(requirement => requirement.scope === 'interval' && requirement.startSecond === 13.1)!
    review.requirementChecks.find(check => check.requirementId === ending.id)!.status = 'unobservable'
    const before = structuredClone({ shot, evidence, review, first })
    const result = plan(shot, evidence, review, policy, first)!
    assert.equal(result.round, 2);assert.equal(result.sampleTimes.length, 24)
    assert.equal(result.sampleTimes.at(-1), 13.96);assert.ok(!result.sampleTimes.includes(14))
    for (const time of times) assert.ok(result.sampleTimes.includes(time))
    const unresolved = requirements.filter(requirement => requirement.scope === 'interval' && [1, 9.8, 13.1].includes(requirement.startSecond))
    assert.deepEqual(result.requirementIds, unresolved.map(requirement => requirement.id))
    for (const requirement of unresolved) assert.ok(result.sampleTimes.some(time => !times.includes(time)
      && time > requirement.startSecond && time < Math.min(requirement.endSecond, 13.96)), requirement.id + ' 必须得到新增内部样本')
    assert.deepEqual({ shot, evidence, review, first }, before)
  }
})

test('a narrow tail interval receives evidence before a long interval consumes the remaining budget', () => {
  const candidate = { duration: 10, videoPrompt: '0-9.5秒：持续过程。9.9-10秒：短促回应。' }
  const times = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 9.75, 9.9, 9.96]
  const evidence = { duration: 10.04, url: '/unequal.mp4', frameTimes: times }
  const review = { requirementChecks: deriveMediaRequirements(candidate).map(requirement => ({ requirementId: requirement.id, status: 'unobservable', evidence: '动作过程未确认。', frameIndices: [] })) }
  for (const plan of planners) {
    const result = plan(candidate, evidence, review, { ...policy, maxFrames: 16 })!
    assert.equal(result.sampleTimes.length, 16)
    for (const time of times) assert.ok(result.sampleTimes.includes(time))
    assert.ok(result.sampleTimes.some(time => !times.includes(time) && time > 0 && time < 9.5))
    assert.ok(result.sampleTimes.some(time => !times.includes(time) && time > 9.9 && time < 9.96))
    assert.equal(result.sampleTimes.at(-1), 9.96)
    assert.throws(() => plan(candidate, evidence, review, { ...policy, maxFrames: 15 }), /MEDIA_ADAPTIVE_SAMPLING_LIMIT:.*至少需要 16 帧.*maxFrames=15/)
    const more = plan(candidate, evidence, review, { ...policy, maxFrames: 18 })!
    assert.ok(more.sampleTimes.includes(.5));assert.ok(more.sampleTimes.includes(1.5));assert.ok(more.sampleTimes.includes(2.5))
    assert.ok(!more.sampleTimes.includes(9.25), '余量优先细化较宽间隔')
  }
})

test('same-video rounds require actual execution of the preceding plan and never consume old-video rounds or times', () => {
  for (const plan of planners) {
    const first = plan(shot, media(), report(), policy)!
    assert.throws(() => plan(shot, media(), report(), policy, first), /MEDIA_ADAPTIVE_SAMPLING_PENDING:.*相同旧帧/)
    const changed = media(frameTimes, 'https://media.test/new.mp4'), previous = { ...first, round: 2, sampleTimes: [0, 6.666, 13.96] }
    const reset = plan(shot, changed, report(), policy, previous)!
    assert.equal(reset.round, 1);assert.equal(reset.sourceUrl, changed.originalUrl)
    assert.ok(!reset.sampleTimes.includes(6.666), '其他视频的计划不能污染当前素材')
    const fallback = { ...media(), originalUrl: undefined }
    assert.equal(plan(shot, fallback, report(), policy)!.sourceUrl, fallback.url)
    assert.throws(() => plan(shot, { ...fallback, url: '' }, report(), policy), /缺少同素材来源 URL/)
  }
})

test('overlapping unresolved intervals share gaps and duplicate boundaries without dropping original samples', () => {
  const candidate = { duration: 4, videoPrompt: '0-2秒：动作甲。0-2秒：动作乙。1-3秒：动作丙。' }
  const times = [0, 1, 2, 3, 3.96], evidence = { duration: 4.04, url: '/same.mp4', frameTimes: times }
  const review = { requirementChecks: deriveMediaRequirements(candidate).map(requirement => ({ requirementId: requirement.id, status: 'unobservable', evidence: '过程尚不可确认。', frameIndices: [] })) }
  for (const plan of planners) {
    const result = plan(candidate, evidence, review, policy)!
    assert.deepEqual(result.sampleTimes, [0, .5, 1, 1.5, 2, 2.5, 3, 3.96]);assert.equal(result.requirementIds.length, 3)
    const limited = plan(candidate, evidence, review, { ...policy, maxFrames: 6 })!
    assert.deepEqual(limited.sampleTimes, [0, 1, 1.5, 2, 3, 3.96], '一个共享新增点即可覆盖三个重叠要求，不按要求数虚报预算不足')
  }
})

test('endpoint-only unknowns or no effective new samples return null and never imply acceptance', () => {
  for (const plan of planners) {
    const endpoints = { requirementChecks: requirements.filter(requirement => requirement.scope !== 'interval')
      .map(requirement => ({ requirementId: requirement.id, status: 'unobservable', evidence: '关键状态被遮挡。', frameIndices: [] })) }
    const before = structuredClone(endpoints)
    assert.equal(plan(shot, media(), endpoints, policy), null);assert.deepEqual(endpoints, before)
    assert.equal(plan(shot, media(), { requirementChecks: [] }, policy), null)
    const tiny = { duration: 2, videoPrompt: '1-1.0000000000000002秒：短过程。' }, item = deriveMediaRequirements(tiny)[0]
    assert.equal(plan(tiny, { duration: 2.04, url: '/tiny.mp4', frameTimes: [0, 1, 1.96] },
      { requirementChecks: [{ requirementId: item.id, status: 'unobservable', evidence: '采样分辨率不足。', frameIndices: [1] }] }, policy), null)
  }
})

test('server sampling receipts recognize normalized applied requests and prevent repeating an unchanged plan', () => {
  const candidate = { duration: 2, videoPrompt: '0-2秒：持续过程。' }, times = [0, 1, 1.96]
  const review = { requirementChecks: [{ requirementId: deriveMediaRequirements(candidate)[0].id, status: 'unobservable', evidence: '过程未确认。', frameIndices: [] }] }
  for (const plan of planners) {
    const base = { duration: 2.04, url: '/clip.mp4', frameTimes: times }, first = plan(candidate, base, review, policy)!
    const normalized = first.sampleTimes.map(time => Math.min(time, 1.96)).filter((time, index, all) => all.indexOf(time) === index)
    const applied = { ...base, frameTimes: normalized, samplingPlan: { mode: 'sample-times', requested: first.sampleTimes, times: normalized } }
    assert.equal(plan(candidate, applied, review, policy, first)!.round, 2)
    const unchangedReceipt = { ...base, samplingPlan: { mode: 'sample-times', requested: first.sampleTimes, times } }
    assert.equal(plan(candidate, unchangedReceipt, review, policy, first), null, '采证已执行但未得到新时刻时，不重复原计划递增轮数')
    assert.throws(() => plan(candidate, { ...unchangedReceipt, samplingPlan: { ...unchangedReceipt.samplingPlan, times: [0, .5, 1.96] } }, review, policy, first), /MEDIA_ADAPTIVE_SAMPLING_PENDING/)
  }
})

test('legacy receipts with clamped tail requests remain valid without scheduling an undecodable endpoint again', () => {
  const candidate = { duration: 2, videoPrompt: '0-2秒：持续过程。' }, times = [0, .5, 1, 1.48, 1.96]
  const requirementId = deriveMediaRequirements(candidate)[0].id
  const review = { requirementChecks: [{ requirementId, status: 'unobservable', evidence: '过程未确认。', frameIndices: [] }] }
  const previous = { sourceUrl: '/legacy.mp4', round: 1, sampleTimes: [0, .5, 1, 1.48, 1.96, 1.98, 2], requirementIds: [requirementId] }
  for (const plan of planners) {
    const evidence = { duration: 2.04, url: previous.sourceUrl, frameTimes: times,
      samplingPlan: { mode: 'sample-times', requested: previous.sampleTimes, times } }
    const before = structuredClone({ candidate, evidence, review, previous })
    const result = plan(candidate, evidence, review, policy, previous)!
    assert.equal(result.round, 2);assert.equal(result.sampleTimes.at(-1), 1.96)
    for (const time of times) assert.ok(result.sampleTimes.includes(time))
    assert.ok(result.sampleTimes.every(time => time <= 1.96))
    const unchanged = { ...evidence, frameTimes: [0, 1, 1.96], samplingPlan: { ...evidence.samplingPlan, times: [0, 1, 1.96] } }
    assert.equal(plan(candidate, unchanged, review, policy, previous), null, '已经请求但未产生新实际帧的旧候选不能冒充新一轮补证')
    assert.throws(() => plan(candidate, { ...evidence, samplingPlan: { ...evidence.samplingPlan, requested: [0, 1, 1.96] } }, review, policy, previous), /MEDIA_ADAPTIVE_SAMPLING_PENDING/)
    assert.deepEqual({ candidate, evidence, review, previous }, before)
  }
})

test('foreign or invalid unknown references and malformed actual evidence cannot schedule sampling', () => {
  for (const plan of planners) {
    const valid = report(), unknown = valid.requirementChecks.find(check => check.status === 'unobservable')!
    for (const broken of [{ ...unknown, requirementId: 'foreign' }, { ...unknown, frameIndices: [0] }, { ...unknown, frameIndices: [999] },
      { ...unknown, frameIndices: [-1] }, { ...unknown, evidence: '' }, { ...unknown, repair: '重拍' }, { ...unknown, defectIndex: 0 }]) {
      assert.throws(() => plan(shot, media(), { requirementChecks: [broken] }, policy), /MEDIA_ADAPTIVE_SAMPLING_INVALID/)
    }
    assert.throws(() => plan(shot, media(), { requirementChecks: [unknown, unknown] }, policy), /恰好有一份审核/)
    for (const broken of [{ ...media(), frameTimes: [1, 2] }, { ...media(), frameTimes: [0, 1, 1] }, { ...media(), frameTimes: [0, NaN] },
      { ...media(), duration: 0 }, { ...media(), frames: [] }]) assert.throws(() => plan(shot, broken, valid, policy), /MEDIA_ADAPTIVE_SAMPLING_INVALID/)
    const first = plan(shot, media(), valid, policy)!
    assert.throws(() => plan(shot, media(first.sampleTimes), report(first.sampleTimes), policy, { ...first, round: 0 } as AdaptiveMediaSamplingPlan), /previousPlan/)
  }
})
