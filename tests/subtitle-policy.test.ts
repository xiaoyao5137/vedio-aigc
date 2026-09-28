import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptPrincipleMedia, principleMediaMetrics, PRINCIPLE_MEDIA_REVIEW_PROMPT, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

type Value = Record<string, unknown>
const policy = { qualityDisposition: 'manual-review-v1', subtitlePolicy: 'none' }
function context() {
  const frames = Array.from({ length: 8 }, (_, index) => '/generated/frame-' + index + '.jpg')
  const evidenceUrl = '/generated/verified-subtitle-proof.json'
  return { shot_script: { duration: 11, audioType: '环境声', audioText: '', pacing: { speechWindows: [] } },
    video_take: { url: '/generated/source.mp4', params: { subtitlePolicy: 'none' } },
    video_evidence: { originalUrl: '/generated/source.mp4', url: '/generated/verified-subtitle.mp4', evidenceUrl,
      decoded: true, hasAudio: true, width: 1280, height: 720, duration: 11.04, frames,
      frameTimes: [0, 1.566, 3.131, 4.697, 6.263, 7.829, 9.394, 10.96], lastFrameUrl: frames.at(-1), transcript: [] },
    media_review: { version: 'principle-review-v1', decision: 'pass', issues: [] as Value[], warnings: [] as Value[],
      subtitleCheck: { status: 'clear', evidenceUrl, frameIndices: [0, 1, 2, 3, 4, 5, 6, 7], finding: '已查看全部八张实际采样帧，均未见字幕叠加。' } } }
}

test('complete current subtitle review passes without widening other manual quality gates', async () => {
  const input = context()
  input.media_review.warnings.push({ code: 'audio_visual_timing_unverified', problem: '口型未测' })
  input.media_review.issues.push({ code: 'wrong_character', problem: '主演明显错误', repair: '核对人物', evidence: { source: 'frame', frameIndices: [0], finding: '首帧人物不符' } })
  const before = structuredClone(input), result = acceptPrincipleMedia(input, policy)
  assert.equal(result.passed, true)
  assert.equal(result.subtitleAssessment?.status, 'clear')
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.deepEqual(result.qualityReview.rawReport, before.media_review)
  assert.deepEqual(result.warnings.slice(0, 1), before.media_review.warnings)
  assert.deepEqual(input, before)
  const output = await executeCodeNode({ code: renderWorkflowTemplate(PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', {}), context: input, params: policy })
  assert.deepEqual(output, { ...result, executionLogs: [] })
})

test('real fourth and fifth clip subtitle warnings override a clear label and retain original evidence', async () => {
  const actualWarnings = [
    { code: 'unexpected_subtitle', problem: '末帧底部出现字形异常的白色描边字幕样文字，与本镜禁止字幕的要求不符，属于非阻断画面问题。',
      evidence: { finding: '画面下方中央可见一行字幕样文字；不能用这些异常字形反推实际配音错误。', frameTimes: [10.96], frameIndices: [7] }, suggestion: '后期清除该文字，保留人物动作与原对白。' },
    { code: 'unexpected_onscreen_text', problem: '帧0底部出现一行字形异常的字幕样文字，影响画面整洁，但不构成原则阻断。',
      frameTimes: [0], frameIndices: [0], suggestion: '后期局部清除该行文字，保留现有剧情和动作。' },
  ]
  for (const warning of actualWarnings) {
    const input = context(); input.media_review.warnings.push(warning)
    const before = structuredClone(input), result = acceptPrincipleMedia(input, policy)
    assert.equal(result.passed, false)
    assert.equal(result.qualityReview.canProceed, false)
    assert.equal(result.subtitleAssessment?.status, 'present')
    assert.equal(result.subtitleAssessment?.action, 'same-media-cleanup-and-review')
    assert.equal(result.qualityReview.automaticRetakeAllowed, true)
    assert.ok(result.qualityReview.principleIssues.some(row => row.code === 'unexpected_subtitle'))
    assert.deepEqual(result.qualityReview.rawReport, before.media_review)
    assert.deepEqual(result.warnings[0], warning)
    assert.deepEqual(input, before)
    const output = await executeCodeNode({ code: renderWorkflowTemplate(PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', {}), context: input, params: policy })
    assert.deepEqual(output, { ...result, executionLogs: [] })
  }
})

test('dedicated present review blocks even manual acceptance and retains the raw subtitle conclusion', () => {
  const input = context()
  input.media_review.subtitleCheck = { ...input.media_review.subtitleCheck, status: 'present', finding: '末帧7可见白色描边字幕，字形异常。' }
  const result = acceptPrincipleMedia(input, policy)
  assert.equal(result.passed, false)
  assert.equal(result.visualReview.passed, false)
  assert.equal(result.qualityReview.rawReport.subtitleCheck.status, 'present')
})

test('contradictory or uncertain dedicated findings cannot create a clear or confirmed paid-retake claim', () => {
  for (const check of [{ status: 'present', finding: '全部采样帧均未见字幕。' },
    { status: 'clear', finding: '底部可见字幕。' }, { status: 'clear', finding: '字幕看不清，无法确认。' }]) {
    const input = context(); Object.assign(input.media_review.subtitleCheck, check)
    const result = acceptPrincipleMedia(input, policy)
    assert.equal(result.passed, false)
    assert.equal(result.subtitleAssessment?.status, 'unverified')
    assert.equal(result.qualityReview.automaticRetakeAllowed, false)
  }
})

test('unknown or unavailable subtitle review requires the same media and cannot trigger automatic paid retakes', () => {
  for (const review of [ { reviewUnavailable: true }, { ...context().media_review, subtitleCheck: undefined },
    { ...context().media_review, subtitleCheck: { ...context().media_review.subtitleCheck, status: 'unverified', finding: '底部看不清，尚未完整查看。' } } ]) {
    const result = acceptPrincipleMedia({ ...context(), media_review: review }, policy)
    assert.equal(result.passed, false)
    assert.equal(result.subtitleAssessment?.status, 'unverified')
    assert.equal(result.subtitleAssessment?.action, 'same-media-review')
    assert.equal(result.qualityReview.automaticRetakeAllowed, false)
    assert.deepEqual(result.qualityReview.rawReport, review)
    assert.ok(result.qualityReview.principleIssues.some(row => row.code === 'subtitle_review_required'))
  }
})

test('clear requires exact current evidence binding and complete unique actual frame indices', () => {
  const badChecks = [{ evidenceUrl: '/generated/old-proof.json' }, { frameIndices: [0, 7] }, { frameIndices: [0, 1, 2, 3, 4, 5, 6, 8] },
    { frameIndices: [0, 1, 2, 3, 4, 5, 6, 6] }, { frameIndices: ['0', 1, 2, 3, 4, 5, 6, 7] }, { frameIndices: [0, 1, 2, 3, 4, 5, 6, -1] },
    { finding: '' }, { status: 'passed' }, { frameIndices: null }]
  for (const patch of badChecks) {
    const input = context()
    const result = acceptPrincipleMedia({ ...input, media_review: { ...input.media_review, subtitleCheck: { ...input.media_review.subtitleCheck, ...patch } } }, policy)
    assert.equal(result.passed, false, JSON.stringify(patch))
    assert.equal(result.subtitleAssessment?.status, 'unverified')
    assert.equal(result.qualityReview.automaticRetakeAllowed, false)
  }
  for (const patch of [{ frameTimes: [] }, { frameTimes: [0, 1, 2, 3, 4, 5, 6, 20] }, { frames: ['', ...context().video_evidence.frames.slice(1)] }]) {
    const input = context(), result = acceptPrincipleMedia({ ...input, video_evidence: { ...input.video_evidence, ...patch } }, policy)
    assert.equal(result.passed, false)
    assert.equal(result.subtitleAssessment?.status, 'unverified')
  }
})

test('unbound, negative, uncertain, authentic prop and unrelated findings cannot masquerade as confirmed subtitles', () => {
  const warnings = [
    { code: 'unexpected_subtitle', evidence: { frameIndices: [8], finding: '底部可见字幕。' } },
    { code: 'unexpected_subtitle', evidence: { frameIndices: ['0'], finding: '底部可见字幕。' } },
    { code: 'unexpected_subtitle', evidence: { frameIndices: [0], source: 'asr', finding: '底部可见字幕。' } },
    { code: 'unexpected_subtitle', evidence: { frameIndices: [0], finding: '画面未见字幕，其他细节可见。' } },
    { code: 'unexpected_subtitle', evidence: { frameIndices: [0], finding: '可能出现字幕，底部看不清。' } },
    { code: 'unexpected_onscreen_text', evidence: { frameIndices: [0], finding: '真实场景牌匾上可见汉字。' } },
    { code: 'audio_visual_timing_unverified', evidence: { frameIndices: [0], finding: '可见人物嘴部，字幕样文字不用于声纹判断。' } },
  ]
  for (const warning of warnings) {
    const input = context(); input.media_review.warnings.push(warning)
    const result = acceptPrincipleMedia(input, policy)
    assert.equal(result.passed, true, JSON.stringify(warning))
    assert.equal(result.subtitleAssessment?.status, 'clear')
    assert.deepEqual(result.warnings[0], warning)
  }
})

test('allow and absent legacy policies retain existing acceptance while explicit unknown policy fails configuration', () => {
  const input = context(); input.media_review.subtitleCheck = undefined
  const legacy = { ...input, video_take: { ...input.video_take, params: {} } }
  assert.equal(acceptPrincipleMedia(legacy, { qualityDisposition: 'manual-review-v1' }).passed, true)
  assert.equal(acceptPrincipleMedia(input, { ...policy, subtitlePolicy: 'allow' }).passed, true)
  for (const value of ['unknown', '', null, undefined, true]) {
    assert.throws(() => acceptPrincipleMedia(input, { ...policy, subtitlePolicy: value }), /SUBTITLE_POLICY_INVALID/)
  }
})

test('review metrics and managed prompt supply the exact evidence URL, policy and all actual sampled frames', () => {
  const input = context(), metrics = principleMediaMetrics(input, policy)
  assert.equal(metrics.subtitlePolicy, 'none')
  assert.deepEqual(metrics.subtitleReviewBinding, { evidenceUrl: input.video_evidence.evidenceUrl, frameIndices: [0, 1, 2, 3, 4, 5, 6, 7] })
  const prompt = renderWorkflowTemplate(PRINCIPLE_MEDIA_REVIEW_PROMPT, { ...input, subtitlePolicy: 'none' })
  assert.ok(prompt.includes(input.video_evidence.evidenceUrl))
  assert.match(prompt, /本次 subtitlePolicy=none/)
  assert.match(prompt, /伪字或乱码/)
  assert.match(prompt, /复核同一素材/)
})

test('same-schema managed migration inserts only missing subtitle policies and preserves explicit custom values', () => {
  const makeNode = (id: string, value?: string) => ({ id, kind: id === 'sanguo-video' ? 'video' : 'text', prompt: 'custom video words', modelId: 'custom-model',
    params: value === undefined ? [] : [{ id: 'custom-policy', name: '字幕策略', englishName: 'subtitlePolicy', type: 'text', required: false, value }] })
  const input = { id: 'wf-sanguo-history-drama', schemaVersion: 144, nodes: [makeNode('sanguo-video'), makeNode('sanguo-media-review'), makeNode('sanguo-media-accept'), makeNode('unrelated-video')] }
  const before = structuredClone(input), migrated = upgradePrincipleQuality(input)
  for (const node of migrated.nodes.slice(0, 3)) assert.equal(node.params.find(param => param.englishName === 'subtitlePolicy')?.value, 'none')
  assert.equal(migrated.nodes[0].prompt, input.nodes[0].prompt)
  assert.equal(migrated.nodes[0].modelId, 'custom-model')
  assert.deepEqual(migrated.nodes.at(-1), input.nodes.at(-1))
  assert.deepEqual(input, before)
  assert.equal(upgradePrincipleQuality(migrated), migrated)
  for (const value of ['allow', 'none', 'custom-policy', '']) {
    const node = makeNode('sanguo-media-accept', value), result = upgradePrincipleQuality({ ...input, nodes: [node] })
    assert.deepEqual(result.nodes[0].params.find(param => param.englishName === 'subtitlePolicy'), node.params[0])
    assert.equal(upgradePrincipleQuality(result), result)
  }
})
