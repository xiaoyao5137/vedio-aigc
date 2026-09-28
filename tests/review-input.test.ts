import test from 'node:test'
import assert from 'node:assert/strict'
import { compactHistoricalReviewContext, compactNodeResultValue, compactReviewReport, nodePromptInputContext } from '../src/review-input.ts'
import { reportFormatRetryFeedback } from '../src/review-retry.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

// Reduced from controlled-20260906-coverage-spans-v1/shot-script-review-2:
// the old action appeared in seven nested report/snapshot locations despite
// the top-level previous videoPrompt already containing actual tail state.
const oldAction = '周家宾客甲原本抬起准备招呼的右手缓缓落下'
const currentAction = '0.0-0.6秒：周家宾客甲吸一口气，右手从身侧抬至腰前，空手掌心略向对方打开'
const observed = { status: 'observed', value: '双手空置', evidence: '帧5双手自然下垂于身侧,无持物' }
const actualState = { settingId: 'drama-encounter', characters: [{ name: '周家宾客甲', position: { status: 'unknown' }, heldProps: observed, pendingAction: { status: 'unknown' } }] }
const duplicateReview = { evidence: [{ quote: oldAction }], text: oldAction, raw: { content: [{ text: oldAction }] } }
const candidate = { id: 'scene-02', videoPrompt: currentAction, characters: ['周家宾客甲'], worldState: actualState }
const previous = {
  id: 'scene-01', contentContractVersion: 'cinematic-v1', characters: ['周家宾客甲'], endCharacters: ['周家宾客甲'], presentCharacters: ['周家宾客甲', '房家宾客甲'],
  videoPrompt: '上一镜已经完成的台词：周福曾教授桓帝。下一镜开始前的实际状态：停步站稳面向对方。不得重演前镜已完成动作。',
  lastFramePrompt: '周家宾客甲停步站稳面向房家宾客甲，双手空置', worldState: actualState,
  worldStateEvidence: { method: 'actual-tail-image', frame: '/generated/verified-frame-5.jpg' },
  storyProgress: { status: 'continuing', pendingActions: ['等待对方回应'] }, completionCriteria: ['听完回答后选择是否离开'],
  contentReview: duplicateReview,
  factualReview: { text: oldAction, raw: { content: [{ text: oldAction }] } },
  dramaturgyReview: { evidence: [{ quote: oldAction }] },
  repairContext: { previousCandidate: { videoPrompt: oldAction } },
  repairProvenance: { generationAttempts: 2 }, scriptValidation: { passed: true }, passed: true, issues: [], timingEstimate: { requiredDuration: 6 },
}

test('real seven-copy noise pattern disappears without losing actual state, open obligations or the current action', () => {
  const context = { params: { candidate }, loop: { index: 2, previous: { shot_script: previous, actualTailEvidence: { worldState: actualState } } } }
  const before = JSON.stringify(context)
  const compact = compactHistoricalReviewContext(context)
  const template = '候选：${params.candidate}\n前镜：${loop.previous.shot_script}\n实际尾帧：${loop.previous.actualTailEvidence}'
  const originalPrompt = renderWorkflowTemplate(template, context), prompt = renderWorkflowTemplate(template, compact)
  assert.equal(originalPrompt.split(oldAction).length - 1, 7)
  assert.equal(prompt.includes(oldAction), false)
  assert.equal(prompt.includes(currentAction), true)
  assert.equal(compact.params, context.params)
  assert.equal(JSON.stringify(compact.params.candidate), JSON.stringify(candidate))
  for (const field of ['lastFramePrompt', 'videoPrompt', 'worldState', 'worldStateEvidence', 'characters', 'endCharacters', 'presentCharacters', 'storyProgress', 'completionCriteria'] as const) {
    assert.equal(compact.loop.previous.shot_script[field], previous[field])
  }
  assert.equal(JSON.stringify(context), before, 'durable execution evidence is unchanged')
  assert.equal(compactHistoricalReviewContext(compact), compact)
})

test('report compaction removes only transport fields at the report root, retaining nested ASR and issue text', () => {
  const report = { passed: false, issues: [{ text: '实际问题', evidence: { text: '逐字引文' } }], transcript: [{ text: '实际ASR台词' }],
    text: 'duplicate report', raw: { content: [{ text: 'duplicate report' }] }, model: 'provider', executionLogs: ['transport'] }
  const compact = compactReviewReport(report)
  assert.deepEqual(compact, { passed: false, issues: report.issues, transcript: report.transcript })
  assert.equal(compact.issues, report.issues)
  assert.equal(compact.transcript, report.transcript)
  assert.equal(report.text, 'duplicate report')
  assert.equal(compactReviewReport('malformed raw report'), 'malformed raw report')
})

test('unparsed bad JSON and unknown objects keep their original repair material', () => {
  const malformed = { text: '{"passed":tru', raw: { content: [{ text: '{"passed":tru' }] }, model: 'provider' }
  for (const value of [malformed, { raw: '{"issues":[' }, { text: 'malformed report', status: 'unknown' }, { passed: 'true', text: '{broken' }]) {
    assert.equal(compactReviewReport(value), value)
  }
  const context = { retry: { feedback: { kind: 'report-format', previousReport: malformed } } }
  assert.equal(compactHistoricalReviewContext(context), context)
  const feedback = reportFormatRetryFeedback({ kind: 'text', resultVar: 'review' }, { review: malformed }, 'REVIEW_RESULT_INVALID: JSON截断') as Record<string, unknown>
  assert.deepEqual(feedback.previousReport, malformed)
})

test('both runtime retry feedback and already-wrapped CLI retry input remove duplicate report envelopes', () => {
  const report = { passed: false, issues: [{ text: '保留具体问题' }], evidence: [], text: 'duplicate', raw: { text: 'duplicate' } }
  const target = { kind: 'text', resultVar: 'review', params: [{ englishName: 'candidate', value: '${candidate}' }] }
  const feedback = reportFormatRetryFeedback(target, { candidate, review: report }, 'REVIEW_RESULT_INVALID: 引文格式错误') as Record<string, unknown>
  assert.deepEqual(feedback.previousReport, { passed: false, issues: report.issues, evidence: [] })
  const context = { params: { candidate }, retry: { attempt: 2, previousReport: report, feedback: { kind: 'report-format', previousReport: report, error: 'REVIEW_RESULT_INVALID: 缺项' } } }
  const compact = compactHistoricalReviewContext(context)
  assert.deepEqual(compact.retry.previousReport, feedback.previousReport)
  assert.deepEqual(compact.retry.feedback.previousReport, feedback.previousReport)
  assert.equal(context.retry.feedback.previousReport.text, 'duplicate')
  assert.equal(compact.params.candidate, candidate)
  assert.equal(compact.retry.feedback.error, context.retry.feedback.error)
  assert.equal(compactHistoricalReviewContext(compact), compact)
})

const normalizedResult = <T extends Record<string, unknown>>(payload: T) => {
  const text = JSON.stringify(payload)
  return { ...payload, text, raw: { content: [{ type: 'text', text }], usage: { output_tokens: 2048 } }, model: 'vision-model', executionLogs: ['provider transport'] }
}

test('normalized input mode removes duplicate mapped model envelopes without sampling or rewriting uncertain evidence', () => {
  const items = Array.from({ length: 6 }, (_, index) => normalizedResult({
    index, second: [0, 1.6, 3.6, 5.6, 7.2, 7.92][index], setting: '门前',
    people: [{ clothing: '深色衣服', position: '画面左侧', pose: '右手被袖口遮挡', heldObjects: 'unknown',
      handEvidence: { left: '完整可见且空手', right: 'unknown：袖口遮挡', nearbyShapes: '线条与门框连接，不能断言持物' } }],
    evidence: { status: 'unobservable', text: `帧${index}右手不可见`, data: { text: '实际观察原文', raw: '业务证据原始记录' } },
    tailObservation: index === 5 ? '末帧右手不可见，持物unknown，不补造抬手' : `帧${index}实际状态`,
  }))
  const context = {
    media_observations: { items, count: items.length },
    video_evidence: { decoded: true, frames: items.map(item => `/generated/frame-${item.index}.jpg`), frameTimes: items.map(item => item.second),
      lastFrameUrl: '/generated/frame-5.jpg', transcript: [{ start: .4, end: 3.8, text: '实际台词不得删除' }] },
    media_metrics: { speech: [{ text: '计划原句', timingAssessment: 'within-allowance' }] },
  }
  const before = JSON.stringify(context)
  const compact = nodePromptInputContext(context, 'normalized-results')
  assert.equal(compact.media_observations.count, 6)
  assert.deepEqual(compact.media_observations.items.map(item => item.index), [0, 1, 2, 3, 4, 5])
  for (const [index, item] of compact.media_observations.items.entries()) {
    for (const key of ['raw', 'text', 'model', 'executionLogs']) assert.equal(Object.hasOwn(item, key), false)
    assert.equal(item.people, items[index].people)
    assert.equal(item.evidence, items[index].evidence)
    assert.equal(item.second, items[index].second)
    assert.equal(item.tailObservation, items[index].tailObservation)
  }
  assert.equal(compact.video_evidence, context.video_evidence)
  assert.equal(compact.media_metrics, context.media_metrics)
  assert.equal(JSON.stringify(context), before)
  const prompt = renderWorkflowTemplate('${media_observations}\n${video_evidence}\n${media_metrics}', compact)
  assert.equal(prompt.split('末帧右手不可见，持物unknown，不补造抬手').length - 1, 1)
  assert.equal(prompt.includes('实际台词不得删除'), true)
  assert.equal(prompt.includes('计划原句'), true)
  assert.equal(compactNodeResultValue(compact), compact)
})

test('projection retains current candidate and historical business contents while removing only normalized nested envelopes', () => {
  const report = normalizedResult({ decision: 'rejected', issues: [{ text: '旧候选的问题原文' }], data: { text: '业务data必须保留' } })
  const historicalCandidate = normalizedResult({ id: 'old', videoPrompt: oldAction })
  const shot = normalizedResult({ ...candidate, repairContext: { previousCandidate: historicalCandidate, previousReport: report }, contentReview: report })
  // Accepted/grounded values can legitimately differ from their earlier raw JSON.
  shot.worldState = { ...actualState, settingId: 'grounded-setting' }
  const context = { params: { candidate: shot }, shot_script: shot, loop: { previous: { shot_script: historicalCandidate } }, retry: { feedback: { previousReport: report } } }
  const before = JSON.stringify(context)
  const compact = nodePromptInputContext(context, 'normalized-results')
  assert.equal(compact.shot_script, compact.params.candidate, 'shared result references share one projected value')
  assert.equal(compact.shot_script.videoPrompt, currentAction)
  assert.equal(compact.shot_script.worldState, shot.worldState)
  assert.equal(compact.shot_script.repairContext.previousCandidate.videoPrompt, oldAction)
  assert.equal(compact.shot_script.repairContext.previousReport.issues, report.issues)
  assert.equal(compact.shot_script.contentReview.data, report.data)
  assert.equal(compact.loop.previous.shot_script.videoPrompt, oldAction)
  assert.equal(compact.retry.feedback.previousReport.issues, report.issues)
  assert.equal(Object.hasOwn(compact.shot_script.repairContext.previousCandidate, 'raw'), false)
  assert.equal(JSON.stringify(context), before, 'candidate and historical execution records stay intact')
})

test('pure text, failed parsing, metadata-only and ordinary nested text are never emptied', () => {
  for (const value of [
    { text: '普通纯文本回复', raw: { content: [{ text: '普通纯文本回复' }] }, model: 'model' },
    { text: '{"index":', raw: { content: [{ text: '{"index":' }] }, model: 'model', status: 'failed' },
    { raw: { error: 'failed' }, model: 'model', status: 'failed', executionLogs: ['diagnostic'] },
    { text: '{"missing":1}', raw: { content: [] }, status: 'unknown' },
    { text: '{"raw":"business"}', raw: { content: [] } },
    { url: '/generated/evidence.jpg', raw: '业务原图数据', data: { text: '图像业务证据' } },
    { data: { text: '业务文本', raw: '业务原文', model: '人物模型' }, transcript: [{ text: 'ASR原句' }] },
  ]) assert.equal(compactNodeResultValue(value), value)
  const context = { result: normalizedResult({ answer: '结构化回复' }) }
  for (const mode of [undefined, null, '', 'raw', 'typo']) assert.equal(nodePromptInputContext(context, mode), context)
})

test('structured arrays and normalized media keep their usable data while provider wrappers disappear', () => {
  const rows = [{ text: '每项业务text', data: { text: '原始依据' } }]
  const arrayResult = { items: rows, shots: rows, text: '```json\n' + JSON.stringify(rows) + '\n```', raw: { content: [] }, model: 'model' }
  assert.deepEqual(compactNodeResultValue(arrayResult), { items: rows, shots: rows })
  const media = { url: '/generated/clip.mp4', data: { text: '解码证据' }, model: 'video-model', raw: { data: { task_id: 'provider-task' } }, executionLogs: ['transport'] }
  assert.deepEqual(compactNodeResultValue(media), { url: media.url, data: media.data })
})
