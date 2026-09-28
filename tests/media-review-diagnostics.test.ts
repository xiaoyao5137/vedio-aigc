import { storyboardTimelineConsumerCode } from '../src/storyboard-timeline.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveMediaRequirements } from '../src/media-requirement-coverage.ts'
import { uncertainMediaReviewDiagnostic } from '../src/media-review-diagnostics.ts'

const diagnostics = [uncertainMediaReviewDiagnostic,
  new Function(`const deriveMediaRequirements=${storyboardTimelineConsumerCode(deriveMediaRequirements)};return (${uncertainMediaReviewDiagnostic.toString()});`)() as typeof uncertainMediaReviewDiagnostic]
const generic = '证据不足，补充采证或重跑审查；不能因此购买新视频'
const shot = { duration: 4, visualPrompt: '人物站立在门前。',
  videoPrompt: '0-1秒：人物静立等待。1-3秒：人物轻微颔首作为交付许可。3-4秒：人物恢复直立。', lastFramePrompt: '人物直立，双手抱于胸前。',
  completionCriteria: ['接收者明确许可交付。'],
  storyProgress: { status: 'continuing', unitId: 'permission', actionResult: '许可已作出。', response: '递交者开始准备。', pendingActions: ['下一镜执行交付。'] },
  pacing: { performanceBeats: [{ id: 'permission', purpose: '作出是否交付的决定。', visibleStateChange: '轻微颔首明确许可。', startSecond: 1, endSecond: 3 }],
    activityWindows: [{ kind: 'reaction', startSecond: 1, endSecond: 3 }] },
}
const requirements = deriveMediaRequirements(shot)
const check = (index: number, evidence = '少量静帧无法确认原动作是否发生。', frameIndices: number[] = []) =>
  ({ requirementId: requirements[index].id, status: 'unobservable', evidence, frameIndices })

test('uncertain diagnostics bind every locatable unknown to exact source words and preserve original narrative context', () => {
  for (const diagnostic of diagnostics) {
    const report = { decision: 'uncertain', passed: false, requirementChecks: [
      { ...check(2, '采样中无法确认承担交付许可的颔首。', [2, 3]), requirementQuote: '报告自行改写的要求' },
      check(4, '末帧手部被遮挡。', [6]),
    ], raw: { content: '完整原报告' } }
    const before = structuredClone({ shot, report }), message = diagnostic(report, shot)
    for (const index of [2, 4]) {
      assert.ok(message.includes(requirements[index].id));assert.ok(message.includes(requirements[index].requirementQuote))
      assert.ok(message.includes('"scope":"' + requirements[index].scope + '"'))
    }
    assert.ok(message.includes('"startSecond":1,"endSecond":3'))
    assert.ok(message.includes('"evidence":"采样中无法确认承担交付许可的颔首。","frameIndices":[2,3]'))
    assert.ok(message.includes('"frameIndices":[6]'))
    assert.doesNotMatch(message, /报告自行改写的要求/)
    for (const [sourcePath, value] of [['completionCriteria', shot.completionCriteria], ['storyProgress', shot.storyProgress],
      ['pacing.performanceBeats', shot.pacing.performanceBeats], ['pacing.activityWindows', shot.pacing.activityWindows]]) {
      assert.ok(message.includes(JSON.stringify({ sourcePath, value })))
    }
    assert.deepEqual({ shot, report }, before, '诊断不修改原始拒绝、未知、证据或原分镜')
  }
})

test('uncertain diagnostics retain missing context and explain state versus inferred process without deciding acceptance', () => {
  for (const diagnostic of diagnostics) {
    const candidate = { duration: 2, videoPrompt: '0-2秒：人物双手抱于胸前。' }, requirement = deriveMediaRequirements(candidate)[0]
    const report = { decision: 'uncertain', passed: false, requirementChecks: [
      { requirementId: requirement.id, status: 'unobservable', evidence: '没有采到双手从下垂到胸前的形成过程。', frameIndices: [0] },
    ] }
    const before = structuredClone(report), message = diagnostic(report, candidate)
    assert.match(message, /完整原值，计划不证明实际发生）：\[\]/)
    assert.match(message, /核对原义务与未知原因是否针对同一属性/)
    assert.match(message, /未观察到额外推断的过程不构成该原要求的验收未知/)
    assert.match(message, /原文明示的动作过程仍须核对/)
    assert.match(message, /完成条件或节拍未重复某动作不代表可以忽略物件归属/)
    assert.match(message, /不能仅凭动作幅度轻微降级/)
    assert.match(message, /真实关键要求或关键性仍无法判断时保留unobservable/)
    assert.match(message, /补充同一素材的采证，不购买新视频/)
    assert.deepEqual(report, before)
  }
})

test('missing, foreign, ambiguous or malformed unknowns fall back to the existing reason', () => {
  const badRows = [
    [], [{ ...check(2), status: 'complete' }], [{ ...check(2), requirementId: 'foreign' }], [check(2), check(2)],
    [{ ...check(2), evidence: '' }], [{ ...check(2), frameIndices: undefined }], [{ ...check(2), frameIndices: [0, 0] }],
    [{ ...check(2), frameIndices: [-1] }], [{ ...check(2), frameIndices: ['0'] }], [{ ...check(2), frameIndices: [0.5] }],
    [{ ...check(2), repair: '重拍' }], [{ ...check(2), defectIndex: 0 }],
  ]
  for (const diagnostic of diagnostics) {
    for (const requirementChecks of badRows) assert.equal(diagnostic({ decision: 'uncertain', requirementChecks }, shot), generic)
    for (const report of [null, [], {}, { requirementChecks: 'invalid' }]) assert.equal(diagnostic(report, shot), generic)
    for (const candidate of [null, {}, { videoPrompt: '没有时间窗。' }, { lastFramePrompt: '没有有效时长。' }]) {
      assert.equal(diagnostic({ requirementChecks: [check(2)] }, candidate), generic)
    }
  }
})
