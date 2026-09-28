import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { acceptPrincipleMedia, acceptPrincipleImages, PRINCIPLE_MEDIA_RUNTIME_CODE, PRINCIPLE_MEDIA_REVIEW_PROMPT, principleMediaRequest } from '../src/principle-media-quality.ts'
import { runPrincipleReview } from '../src/principle-review-runtime.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { DRAMATIC_EXPRESSION_MEDIA_REVIEW_PROMPT } from '../src/dramatic-expression.ts'
const shot = { id: 'shot-1', duration: 8, characters: ['张三'], audioType: '对白', audioText: '张三：今日告辞。', videoPrompt: '张三把信交给李四', pacing: { version: 'duration-v2', scheduleHash: 'same', speechWindows: [{ start: 0, end: 4, text: '今日告辞' }] } }
const take = { url: 'https://example.com/video.mp4', params: { scheduleHash: 'same' } }
const media = { decoded: true, originalUrl: take.url, url: '/generated/verified-test.mp4', evidenceUrl: '/generated/verified-test.json', duration: 8, width: 1920, height: 1080,
  frames: ['/generated/start.jpg', '/generated/end.jpg'], frameTimes: [0, 7.96], lastFrameUrl: '/generated/end.jpg', hasAudio: true, meanVolumeDb: -20,
  transcript: [{ start: 0, end: 4, text: '今日告辞' }], speechValidation: { phoneticErrorRate: 0, passed: true, dialogueCompletenessVerified: true,
    alignment: [{ planned: shot.pacing.speechWindows[0], actualStart: 0, actualEnd: 4, matchedStart: 0, matchedEnd: 4,
      utteranceCandidateStart: 0, utteranceCandidateEnd: 4, alignmentCoverage: 1, firstTokenMatched: true, lastTokenMatched: true,
      boundaryEvidenceVersion: 2, boundaryStatus: 'reliable', boundaryUncertaintyReasons: [] }] } }
const report = { version: 'principle-review-v1', decision: 'pass', issues: [] as Record<string, unknown>[], warnings: [] as unknown[], endingState: '张三在门前', endCharacters: ['张三'] }
const context = () => ({ shot_script: structuredClone(shot), video_take: structuredClone(take), video_evidence: structuredClone(media), media_review: structuredClone(report) })
const eraFixture = () => JSON.parse(readFileSync(new URL('./fixtures/principle-media-fuik-era.json', import.meta.url), 'utf8'))

test('dramatic media advice uses actual evidence and leaves the current take available', () => {
  const input = context()
  const warning = { code: 'dramatic_expression', problem: '现有抽帧不足以确认告辞时的温情回应',
    repair: '播放复核本段实际动作与声音，明确处再考虑局部表演调整',
    evidence: { source: 'asr', quote: '今日告辞', frameIndices: [1], finding: '实际识别到告辞，末帧仅能看清人物仍在门前' } }
  input.media_review.warnings = [warning]
  const before = structuredClone(input)
  const result = acceptPrincipleMedia(input)
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.deepEqual(result.qualityReview.principleIssues, [])
  assert.deepEqual(result.qualityReview.rawReport, input.media_review)
  assert.ok(result.warnings.some(row => typeof row === 'object' && row.code === 'dramatic_expression'))
  assert.deepEqual(input, before)
  const prompt = renderWorkflowTemplate(PRINCIPLE_MEDIA_REVIEW_PROMPT, { ...input, historical_sources: { citations: [] } })
  assert.equal(prompt.split(DRAMATIC_EXPRESSION_MEDIA_REVIEW_PROMPT).length - 1, 1)
  assert.ok(prompt.indexOf(DRAMATIC_EXPRESSION_MEDIA_REVIEW_PROMPT) < prompt.indexOf('shot：'))
  assert.ok(prompt.includes(media.evidenceUrl))
  assert.ok(prompt.includes(media.transcript[0].text))
  assert.equal(prompt.includes('${'), false)
})

test('real audible chronology contradiction requires current ASR and an exact numbered original source before blocking', async () => {
  const data = eraFixture(), input = data.context, before = structuredClone(input)
  assert.ok(input.video_evidence.transcript.some((row: { text: string }) => row.text.includes(input.media_review.issues[0].evidence.quote)))
  assert.equal(acceptPrincipleMedia(input).passed, true, 'the original report lacks sourceQuote/index and remains advisory')
  // Complete the missing proof offline; this is not a newly generated report
  // and must not overwrite the saved original issue or authored script.
  const grounded = structuredClone(input)
  Object.assign(grounded.media_review.issues[0].evidence, data.verifiedSourceProof)
  const groundedBefore = structuredClone(grounded)
  for (const code of ['historical_era', 'core_event_contradiction']) {
    grounded.media_review.issues[0].code = code
    const accepted = acceptPrincipleMedia(grounded)
    assert.equal(accepted.passed, false, code)
    assert.equal(accepted.qualityReview.status, 'rejected')
    assert.equal(accepted.qualityReview.principleIssues.length, 1)
    assert.equal(accepted.qualityReview.principleIssues[0].code, code)
    assert.deepEqual(accepted.qualityReview.principleIssues[0].evidence, grounded.media_review.issues[0].evidence)
    assert.match(String(accepted.qualityReview.principleIssues[0].repair), /大纲\/分镜.*原脚本同样有误.*不要原词重拍/)
    assert.deepEqual(accepted.qualityReview.rawReport, grounded.media_review)
    const codeOutput = await executeCodeNode({ code: renderWorkflowTemplate(PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', {}), context: grounded })
    assert.deepEqual(codeOutput, { ...accepted, executionLogs: [] })
  }
  grounded.media_review.issues[0].code = groundedBefore.media_review.issues[0].code
  assert.deepEqual(grounded, groundedBefore)
  assert.deepEqual(input, before)
})

test('bracket-indexed source paths bind core-event evidence and credible ambient speech blocks a retake', () => {
  const linked = context()
  linked.media_review = { ...report, decision: 'revise', issues: [{ code: 'core_event_contradiction', problem: '动作与完成态相反', repair: '重拍动作结尾', evidence: {
    source: 'frame', frameIndices: [1], finding: '末帧站起', path: 'pacing.beats[0].completion.finalState', quote: '张三完成交信',
  } }] }
  linked.shot_script.pacing.beats = [{ completion: { finalState: '张三完成交信' } }]
  assert.equal(acceptPrincipleMedia(linked).passed, false)

  const ambient = context()
  ambient.shot_script.audioType = '环境声'; ambient.shot_script.audioText = ''
  ambient.video_evidence.speechValidation = undefined
  ambient.video_evidence.transcript = [{ start: .5, end: 1.6, text: '你在藏礁', words: [
    { probability: .92 }, { probability: .87 }, { probability: .9 },
  ] }]
  const result = acceptPrincipleMedia(ambient)
  assert.equal(result.passed, false)
  assert.equal(result.qualityReview.principleIssues[0].code, 'unexpected_speech')
})

test('weak ambient ASR hallucinations stay visible without repeatedly purchasing video', async () => {
  const samples = [
    { start: 7.57, end: 8.23, text: '这倒是', words: [{ probability: .3103 }, { probability: .5838 }, { probability: .976 }] },
    { start: 8.78, end: 9.56, text: '舒和夏', words: [{ probability: .6219 }, { probability: .5149 }, { probability: .3241 }] },
    { start: 7.6, end: 9.24, text: '这是 这是 这是', words: [{ probability: .2299 }, { probability: .9044 }, { probability: .9227 }] },
  ]
  for (const segment of samples) {
    const ambient = context()
    ambient.shot_script.audioType = '环境声'; ambient.shot_script.audioText = ''
    ambient.video_evidence.speechValidation = undefined
    ambient.video_evidence.transcript = [segment]
    const result = acceptPrincipleMedia(ambient)
    assert.equal(result.passed, true, segment.text)
    assert.equal(result.qualityReview.principleIssues.length, 0)
    assert.ok(result.warnings.some(item => typeof item === 'string' && item.includes('不单独触发付费重拍')))
    const sandbox = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: ambient })
    assert.equal(sandbox.passed, true)
  }
})
test('record-mp0ow5 repeated weak ambient ASR cannot be laundered into a confirmed defect by a second report', async () => {
  const input = context()
  input.shot_script.audioType = '环境声'; input.shot_script.audioText = ''
  input.video_evidence.speechValidation = undefined
  input.video_evidence.transcript = [
    { start: 2.92, end: 4.76, text: '你是什么人啊', words: [.195049, .815666, .148932, .364450].map(probability => ({ probability })) },
    { start: 4.76, end: 5.04, text: '你是什么人啊', words: [.222744, .369316, .914469, .787229].map(probability => ({ probability })) },
    { start: 5.04, end: 6.30, text: '你是什么人啊', words: [.209032, .608064, .968800, .905902].map(probability => ({ probability })) },
  ]
  input.media_review = { ...report, decision: 'revise', issues: [{ code: 'missing_or_wrong_speech',
    problem: '本镜未设台词，但实际ASR在中后段连续记录新增问话，构成较大范围的语音内容错误。', repair: '去除新增问话',
    evidence: { source: 'asr', frameIndices: [], quote: '你是什么人啊', finding: '三段ASR均记录同一句问话' } }] }
  const before = structuredClone(input), accepted = acceptPrincipleMedia(input)
  assert.equal(accepted.passed, true)
  assert.equal(accepted.qualityReview.status, 'needs_attention')
  assert.equal(accepted.technicalValidation.speechVerified, false)
  assert.equal(accepted.visualReview.passed, false)
  assert.deepEqual(accepted.qualityReview.rawReport, input.media_review)
  assert.deepEqual(input, before)
  const sandbox = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input })
  assert.equal(sandbox.passed, true)
  // Independently strong ASR still rejects the same explicit unplanned speech.
  input.video_evidence.transcript[0].words = [.95, .91, .94, .92].map(probability => ({ probability }))
  const rejected = acceptPrincipleMedia(input)
  assert.equal(rejected.passed, false)
  assert.ok(rejected.qualityReview.principleIssues.some(issue => issue.code === 'unexpected_speech'))
  assert.ok(rejected.qualityReview.principleIssues.some(issue => issue.code === 'missing_or_wrong_speech'))
})

test('stale, missing, ambiguous and uncertain audible history proof remains advice without promoting clothing complaints', () => {
  const data = eraFixture(), baseline = data.context
  Object.assign(baseline.media_review.issues[0].evidence, data.verifiedSourceProof)
  const mutations: Array<(input: typeof baseline) => void> = [
    input => { delete input.media_review.issues[0].evidence.sourceQuote },
    input => { delete input.media_review.issues[0].evidence.sourceIndex },
    input => { input.media_review.issues[0].evidence.sourceIndex = 2 },
    input => { input.media_review.issues[0].evidence.sourceIndex = '1' },
    input => { input.media_review.issues[0].evidence.sourceQuote = '已被替换的旧版史料原文' },
    input => { input.media_review.issues[0].evidence.sourceQuote = input.historical_sources.citations[0].title },
    input => { input.historical_sources.citations[0].content = '本次已替换为其他史料。' },
    input => { input.historical_sources.citations.push(structuredClone(input.historical_sources.citations[0])) },
    input => { delete input.historical_sources },
    input => { input.media_review.issues[0].evidence.quote = '不存在于本次ASR中的台词' },
    input => { input.media_review.decision = 'uncertain' },
    input => { input.media_review.issues[0].code = 'costume_detail' },
  ]
  for (const mutate of mutations) {
    const input = structuredClone(baseline); mutate(input)
    const before = structuredClone(input), result = acceptPrincipleMedia(input)
    assert.equal(result.passed, true)
    assert.equal(result.qualityReview.status, 'needs_attention')
    assert.equal(result.qualityReview.principleIssues.length, 0)
    assert.ok(result.warnings.length > 0)
    assert.deepEqual(input, before)
    assert.deepEqual(result.qualityReview.rawReport, before.media_review)
  }
})

test('media principle prompt receives current original citations and distinguishes source repair from identical retakes', () => {
  const data = eraFixture(), input = data.context
  const prompt = renderWorkflowTemplate(PRINCIPLE_MEDIA_REVIEW_PROMPT, input)
  assert.ok(prompt.includes(JSON.stringify(input.historical_sources.citations)))
  assert.ok(prompt.includes(input.media_review.issues[0].evidence.quote))
  assert.match(prompt, /sourceIndex和sourceQuote/)
  assert.match(prompt, /没有本次原文支持.*warnings\/uncertain/)
  assert.match(prompt, /原批准脚本也写错.*定位回大纲\/分镜/)
  assert.equal(prompt.includes('${'), false)
})

test('principle policy permits suggestions/unknown without claiming detailed visual review passed', () => {
  const input = context(); input.media_review.decision = 'uncertain'; input.media_review.warnings = ['手指姿势看不清'];
  const result = acceptPrincipleMedia(input)
  assert.equal(result.passed, true); assert.equal(result.qualityReview.status, 'needs_attention')
  assert.equal(result.visualReview.passed, false); assert.equal(result.visualReview.lipSyncVerified, false)
  assert.equal(result.qualityReview.rawReport.decision, 'uncertain'); assert.equal(input.media_review.decision, 'uncertain')
  const unavailable = acceptPrincipleMedia({ ...input, media_review: { reviewUnavailable: true } })
  assert.equal(unavailable.passed, true); assert.equal(unavailable.qualityReview.status, 'unavailable'); assert.equal(unavailable.visualReview.passed, false)
})
test('confirmed principle defects and unusable technical media remain blocked', () => {
  const input = context(); input.media_review.decision = 'revise'; input.media_review.issues = [{ code: 'wrong_character', problem: '主演变为儿童', repair: '恢复成年主演', evidence: { source: 'frame', frameIndices: [0], finding: '首帧明确为儿童' } }]
  assert.equal(acceptPrincipleMedia(input).passed, false)
  const muted = context(); muted.video_evidence.hasAudio = false
  assert.equal(acceptPrincipleMedia(muted).passed, false)
  const portrait = context(); portrait.video_evidence.width = 1080; portrait.video_evidence.height = 1920
  assert.equal(acceptPrincipleMedia(portrait).passed, false)
  for (const patch of [{ decoded: false }, { originalUrl: 'https://example.com/other.mp4' }, { frames: [] }, { lastFrameUrl: '/other.jpg' }]) {
    assert.throws(() => acceptPrincipleMedia({ ...context(), video_evidence: { ...media, ...patch } }), /MEDIA_EVIDENCE_MISSING/)
  }
})
test('uncertain or invalid visual reports cannot turn their speculative issue arrays into paid retakes', () => {
  const issue = { code: 'wrong_character', problem: '可能为儿童', repair: '换成年人物', evidence: { source: 'frame', frameIndices: [0], finding: '看不清年龄' } }
  for (const review of [{ ...report, decision: 'uncertain', issues: [issue] }, { issues: [issue], decision: 'revise' }]) {
    const input = { ...context(), media_review: review }, before = structuredClone(input)
    const accepted = acceptPrincipleMedia(input)
    assert.equal(accepted.passed, true)
    assert.equal(accepted.visualReview.passed, false)
    assert.deepEqual(accepted.qualityReview.rawReport, review)
    assert.ok(accepted.warnings.length > 0)
    assert.deepEqual(input, before)
    assert.equal(acceptPrincipleMedia({ ...input, video_evidence: { ...media, hasAudio: false } }).passed, false, 'deterministic defects remain blocking')
  }
})
test('image review unknowns and coerced indices preserve assets for review without approving or repurchasing them', () => {
  const base = { character_candidates: { items: [{ characterName: '张三', url: '/generated/person.png' }] },
    character_image_evidence: { items: [{ characterName: '张三', url: '/generated/person.png', decoded: true, referenceImage: '/generated/person-evidence.jpg' }] } }
  const issue = { code: 'wrong_character', characterName: '张三', problem: '疑似年龄错误', repair: '恢复原人物', evidence: { imageIndex: 0, finding: '年龄看不清' } }
  for (const review of [{ ...report, decision: 'uncertain', issues: [issue] }, { issues: [issue] },
    { ...report, decision: 'revise', issues: [{ ...issue, evidence: { ...issue.evidence, imageIndex: null } }] }]) {
    const accepted = acceptPrincipleImages({ ...base, character_image_review: review })
    assert.equal(accepted.passed, true)
    assert.notEqual(accepted.qualityReview.status, 'passed')
    assert.deepEqual(accepted.qualityReview.rawReport, review)
  }
  assert.equal(acceptPrincipleImages({ ...base, character_image_review: { ...report, decision: 'revise', issues: [issue] } }).passed, false)
})
test('wrong paths, frame indices and style complaints cannot trigger a paid retake', () => {
  const input = context(); input.media_review.decision = 'revise'; input.media_review.issues = [
    { code: 'core_event_contradiction', problem: '缺少递信', repair: '重拍', evidence: { source: 'frame', frameIndices: [0], path: 'videoPrompt', quote: '臆造动作', finding: '没看到' } },
    { code: 'wrong_character', problem: '主演不符', repair: '重拍', evidence: { source: 'frame', frameIndices: [20], finding: '旧图' } },
    { code: 'slow_pacing', problem: '不够精彩', repair: '重拍', evidence: { source: 'frame', frameIndices: [0], finding: '节奏慢' } },
  ]
  const result = acceptPrincipleMedia(input); assert.equal(result.passed, true); assert.equal(result.qualityReview.principleIssues.length, 0); assert.ok(result.warnings.length >= 3)
})
test('sampler has fixed bounded cost and preserves the entire compiled speech windows', () => {
  const result = principleMediaRequest(context()); assert.equal(result.sampleTimes.length, 8); assert.equal(result.sampleTimes[0], 0); assert.ok(result.sampleTimes.at(-1)! < 8)
  assert.deepEqual(result.speechWindows, shot.pacing.speechWindows); assert.equal(result.scheduleHash, shot.pacing.scheduleHash)
})
test('image gate requires matching decoded assets but treats ordinary layout suggestions as advisory', () => {
  const input = { character_candidates: { items: [{ characterName: '张三', url: '/generated/person.png' }] },
    character_image_evidence: { items: [{ characterName: '张三', url: '/generated/person.png', decoded: true, referenceImage: '/generated/person-evidence.jpg' }] },
    character_image_review: { version: 'principle-review-v1', decision: 'uncertain', issues: [{ code: 'layout', problem: '侧面角度略有偏差' }], warnings: [], items: [{ characterName: '张三', appearance: '黑衣青年男子' }] } }
  const result = acceptPrincipleImages(input); assert.equal(result.passed, true); assert.equal(result.qualityReview.status, 'needs_attention')
  assert.throws(() => acceptPrincipleImages({ ...input, character_image_evidence: { items: [] } }), /IMAGE_EVIDENCE_MISSING/)
})
test('actual structured image warnings retain attribution and attention in accepted assets without changing the raw report', () => {
  const warnings = [
    { problem: '画面共四个人物视图，中间两个侧面视角重复，未按单行三列呈现；属于布局问题，不阻断。', imageIndex: 0, characterName: '乡人张三' },
    { problem: '实际穿着为灰褐色较长上衣叠穿深灰色无袖外衣，与文本中的灰色短襦存在服饰细节差异，不阻断。', imageIndex: 1, characterName: '乡人李四' },
  ]
  const items = warnings.map((warning, index) => ({ characterName: warning.characterName, url: '/generated/person-' + index + '.png' }))
  const input = { character_candidates: { items }, character_image_evidence: { items: items.map(item => ({ ...item, decoded: true, referenceImage: item.url })) },
    character_image_review: { version: 'principle-review-v1', decision: 'pass', issues: [], warnings, items: [] } }
  const before = structuredClone(input), result = acceptPrincipleImages(input)
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.deepEqual(result.warnings, warnings)
  assert.deepEqual(result.qualityReview.warnings, warnings)
  for (const item of result.items) {
    const quality = (item.metadata as Record<string, unknown>).quality as Record<string, unknown>
    assert.equal(quality.status, 'needs_attention')
    assert.deepEqual(quality.warnings, warnings)
  }
  assert.deepEqual(result.qualityReview.rawReport, input.character_image_review)
  assert.deepEqual(input, before)
})
test('media keeps object and text advice through sandbox acceptance while confirmed principle issues still reject', async () => {
  const warnings = [{ code: 'NARRATION_STYLE_ADVICE', message: '旁白风格可按需调整', scope: 'adaptation_boundary' }, { segmentIndex: 0, warning: '尾帧表情细节未确认' }, '普通文字建议']
  const input = { ...context(), media_review: { ...report, warnings: [...warnings, null, [], {}] } }
  const before = structuredClone(input), result = acceptPrincipleMedia(input)
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.deepEqual(result.warnings.slice(0, warnings.length), warnings)
  assert.equal((result.warnings.at(-1) as Record<string, unknown>).code, 'pronunciation_not_measured')
  assert.deepEqual(result.visualReview.warnings, result.warnings)
  assert.deepEqual(result.qualityReview.rawReport, before.media_review)
  assert.deepEqual(input, before)
  const output = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input })
  assert.deepEqual(output, { ...result, executionLogs: [] })
  const issue = { code: 'wrong_character', problem: '主演明显变为儿童', repair: '恢复成年主演', evidence: { source: 'frame', frameIndices: [0], finding: '首帧明确为儿童' } }
  const rejected = acceptPrincipleMedia({ ...input, media_review: { ...input.media_review, decision: 'revise', issues: [issue] } })
  assert.equal(rejected.passed, false)
  assert.equal(rejected.qualityReview.status, 'rejected')
  assert.deepEqual(rejected.warnings, result.warnings)
})
test('actual code-node interpolation and sandbox preserve principle media decisions', async () => {
  const code = renderWorkflowTemplate(PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', {})
  const output = await executeCodeNode({ code, context: context(), params: {} })
  assert.deepEqual(output, { ...acceptPrincipleMedia(context()), executionLogs: [] })
})
test('review runtime recovers malformed JSON and transport errors with fresh bounded attempts', async () => {
  const calls: number[] = []
  const result = await runPrincipleReview({ maxAttempts: 3, generate: async attempt => { calls.push(attempt); if (attempt === 1) throw Error('temporary transport'); return attempt === 2 ? 'bad json' : JSON.stringify(report) }, normalize: value => JSON.parse(String(value)) })
  assert.deepEqual(calls, [1, 2, 3]); assert.equal(result.reviewTransport.recovered, true); assert.equal(result.decision, 'pass')
  for (let repeat = 0; repeat < 2; repeat++) {
    const failed = await runPrincipleReview({ maxAttempts: 2, generate: async () => 'not-json', normalize: value => JSON.parse(String(value)) })
    assert.equal(failed.reviewUnavailable, true); assert.equal(failed.reviewTransport.attempts.length, 2); assert.equal(failed.decision, undefined)
  }
})
