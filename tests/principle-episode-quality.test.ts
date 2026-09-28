import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { acceptPrincipleMedia } from '../src/principle-media-quality.ts'
import { acceptPrincipleEpisodeQuality, collectPrincipleEpisodeEvidence, PRINCIPLE_EPISODE_ACCEPT_CODE, PRINCIPLE_EPISODE_EVIDENCE_CODE, PRINCIPLE_EPISODE_REVIEW_PROMPT } from '../src/principle-episode-quality.ts'
import { DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT } from '../src/dramatic-expression.ts'

const cleanReview = () => ({ version: 'principle-review-v1', decision: 'pass', issues: [] as Record<string, unknown>[], warnings: [] as unknown[] })
const context = () => {
  const shots = [0, 1].map(index => ({ id: 'shot-' + index, audioType: '对白', audioText: '今日告辞。', videoPrompt: '门生当面收回招呼，转身离开。', duration: 6, pacing: { version: 'duration-v2', scheduleHash: 'schedule-' + index } }))
  const videos = shots.map((shot, index) => {
    const take = { url: 'https://example.com/take-' + index + '.mp4', params: { scheduleHash: shot.pacing.scheduleHash } }
    const frames = Array.from({ length: 5 }, (_, frame) => '/generated/episode-' + index + '-' + frame + '.jpg')
    return acceptPrincipleMedia({ shot_script: shot, video_take: take, media_review: cleanReview(), video_evidence: { originalUrl: take.url, url: '/generated/clip-' + index + '.mp4', decoded: true, evidenceUrl: '/generated/clip-' + index + '.json',
      duration: 6, width: 1920, height: 1080, hasAudio: true, meanVolumeDb: -20, frames, frameTimes: [0, 1.5, 3, 4.5, 5.96], lastFrameUrl: frames.at(-1),
      transcript: [{ start: .3, end: 2, text: '今日告辞。' }], speechValidation: { phoneticErrorRate: 0 } } })
  })
  return { shot_script: { items: shots }, video_shot: { items: videos }, scene_outline: { count: 1 }, episode_timeline: { aspectRatio: '16:9', clips: shots.map((shot, index) => ({ shotId: shot.id, videoUrl: videos[index].url, transcript: '计划文本不能伪装实际ASR' })) }, episode_dramaturgy_review: cleanReview() }
}

test('episode emotional progression advice stays bound to sampled media without blocking or reshooting', () => {
  const input = context()
  const warning = { code: 'emotional_progression', segmentIndex: 1, problem: '相邻段实际ASR重复告辞，情绪变化需要播放复核',
    repair: '先用现有片段检查回应与情绪起伏；若源场景缺少变化，定位上游大纲调整',
    evidence: { source: 'asr', quote: '今日告辞。', finding: '两段实际识别台词相同，抽帧无法确认连续表演效果' } }
  input.episode_dramaturgy_review.warnings = [warning]
  const before = structuredClone(input)
  const result = acceptPrincipleEpisodeQuality(input)
  assert.equal(result.passed, true)
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.deepEqual(result.qualityReview.principleIssues, [])
  assert.deepEqual(result.qualityReview.rawReport, input.episode_dramaturgy_review)
  assert.equal(result.automaticReshoot, false)
  assert.equal(result.fullVideoWatched, false)
  assert.deepEqual(input, before)
  const prompt = renderWorkflowTemplate(PRINCIPLE_EPISODE_REVIEW_PROMPT, { episode_review_evidence: collectPrincipleEpisodeEvidence(input) })
  assert.equal(prompt.split(DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT).length - 1, 1)
  assert.ok(prompt.indexOf(DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT) < prompt.indexOf('本次实际素材及每片原判定：'))
  assert.ok(prompt.includes('/generated/clip-1.mp4'))
  assert.ok(prompt.includes('今日告辞'))
  assert.equal(prompt.includes('${'), false)
})

test('complete ordered media keeps each actual quality verdict without certifying full episode playback', () => {
  const input = context(), before = structuredClone(input)
  input.video_shot.items[0].qualityReview.status = 'needs_attention'
  input.video_shot.items[0].qualityReview.warnings = ['短暂停顿细节未知']
  const result = acceptPrincipleEpisodeQuality(input)
  assert.equal(result.passed, true)
  assert.equal(result.complete, true)
  assert.equal(result.status, 'needs_attention')
  assert.equal(result.actualClips, 2, '真实拆分分镜数优先于旧大纲估计')
  assert.deepEqual(result.segments[0].qualityReview, input.video_shot.items[0].qualityReview)
  assert.equal(result.fullVideoWatched, false)
  assert.equal(result.renderedEpisodeVerified, false)
  assert.equal(result.automaticReshoot, false)
  assert.equal(result.reviewSummary.episodePlayback, 'not-reviewed')
  assert.equal(JSON.stringify(result).includes('计划文本不能伪装实际ASR'), false)
  assert.deepEqual(input.episode_dramaturgy_review, before.episode_dramaturgy_review)
})

test('ASR gaps and missing frame timestamps are warnings rather than missing original clips', () => {
  const input = context()
  input.video_shot.items[0].transcript = []
  input.video_shot.items[0].speechValidation = {}
  input.video_shot.items[0].frameTimes = []
  const e = collectPrincipleEpisodeEvidence(input)
  assert.equal(e.complete, true)
  assert.equal(e.missing.length, 0)
  assert.deepEqual(e.segments[0].transcript, [])
  assert.ok(e.warnings.length > 0)
  assert.equal(acceptPrincipleEpisodeQuality(input).passed, true)
})

test('missing, stale, reordered or repeated timeline assets stay blocked even if an evidence object claims complete', () => {
  const cases = [
    (value: ReturnType<typeof context>) => { value.episode_timeline.clips = [] },
    (value: ReturnType<typeof context>) => { value.video_shot.items.pop() },
    (value: ReturnType<typeof context>) => { value.episode_timeline.clips.reverse() },
    (value: ReturnType<typeof context>) => { value.episode_timeline.clips[1].videoUrl = value.episode_timeline.clips[0].videoUrl },
    (value: ReturnType<typeof context>) => { value.video_shot.items[0].decoded = false },
    (value: ReturnType<typeof context>) => { value.video_shot.items[0].originalUrl = 'https://example.com/old-take.mp4' },
    (value: ReturnType<typeof context>) => { value.shot_script.items[0].pacing.scheduleHash = 'new-schedule' },
  ]
  for (const change of cases) {
    const input = context(); change(input)
    const result = acceptPrincipleEpisodeQuality({ ...input, episode_review_evidence: { complete: true, shouldReview: true } })
    assert.equal(result.passed, false)
    assert.equal(result.status, 'blocked')
    assert.ok(result.missing.length > 0)
  }
})

test('measured unusable media and inherited principle failures remain blocking after an optimistic episode review', () => {
  const silent = context(); silent.video_shot.items[0].hasAudio = false
  const mutedResult = acceptPrincipleEpisodeQuality(silent)
  assert.equal(mutedResult.passed, false)
  assert.equal(mutedResult.status, 'rejected')
  assert.ok(mutedResult.issues.some(issue => issue.code === 'missing_audio'))
  const inherited = context()
  const issue = { code: 'wrong_character', problem: '实际人物身份错置', repair: '恢复原身份', evidence: { source: 'frame', frameIndices: [0], finding: '实际首帧人物明显不符' } }
  inherited.video_shot.items[1].qualityReview = { ...inherited.video_shot.items[1].qualityReview, status: 'rejected', canProceed: false, principleIssues: [issue] }
  const result = acceptPrincipleEpisodeQuality(inherited)
  assert.equal(result.passed, false)
  assert.ok(result.issues.some(item => item.problem === issue.problem && item.inherited === true))
  assert.deepEqual(result.segments[1].qualityReview, inherited.video_shot.items[1].qualityReview)
})

test('episode report issues use the segment media policy and only current supplied frame or ASR evidence', () => {
  const issue = { segmentIndex: 0, code: 'wrong_character', problem: '主演明显变成儿童', repair: '恢复成人主演', evidence: { source: 'frame', frameIndices: [0], finding: '首帧实际为儿童' } }
  const input = context(); input.episode_dramaturgy_review = { ...cleanReview(), decision: 'revise', issues: [issue] }
  assert.equal(acceptPrincipleEpisodeQuality(input).passed, false)
  for (const row of [
    { ...issue, code: 'slow_pacing' },
    { ...issue, segmentIndex: 7 },
    { ...issue, evidence: { ...issue.evidence, frameIndices: [1] } },
    { ...issue, code: 'missing_or_wrong_speech', evidence: { source: 'asr', quote: '原片不存在的台词', finding: '台词不符' } },
    { ...issue, code: 'core_event_contradiction', evidence: { ...issue.evidence, path: 'videoPrompt', quote: '原计划不存在的动作' } },
  ]) {
    input.episode_dramaturgy_review.issues = [row]
    const result = acceptPrincipleEpisodeQuality(input)
    assert.equal(result.passed, true)
    assert.equal(result.status, 'needs_attention')
  }
  input.episode_dramaturgy_review.issues = [{ ...issue, code: 'missing_or_wrong_speech', evidence: { source: 'asr', quote: '今日告辞', finding: '实际说出错误核心人物台词' } }]
  assert.equal(acceptPrincipleEpisodeQuality(input).passed, false)
})

test('missing or malformed episode reports and unsupported viewing claims do not trigger report loops', () => {
  for (const review of [null, 'bad-json', { reviewUnavailable: true }, { ...cleanReview(), decision: 'uncertain' }, { ...cleanReview(), fullVideoWatched: true, scope: 'watched-every-frame' }]) {
    const result = acceptPrincipleEpisodeQuality({ ...context(), episode_dramaturgy_review: review })
    assert.equal(result.passed, true)
    assert.ok(['unavailable', 'needs_attention'].includes(result.status))
    assert.equal(result.fullVideoWatched, false)
    assert.equal(result.renderedEpisodeVerified, false)
    assert.deepEqual(result.qualityReview.rawReport, review)
  }
})

test('old episode evidence cannot apply its frame-index critique to replacement media', () => {
  const input = context(), oldEvidence = collectPrincipleEpisodeEvidence(input)
  input.episode_dramaturgy_review = { ...cleanReview(), decision: 'revise', issues: [{ segmentIndex: 0, code: 'wrong_character', problem: '旧原片主演身份错置', repair: '恢复主演', evidence: { source: 'frame', frameIndices: [0], finding: '旧原片首帧身份不符' } }] }
  input.video_shot.items[0].url = '/generated/new-clip.mp4'
  input.episode_timeline.clips[0].videoUrl = '/generated/new-clip.mp4'
  const result = acceptPrincipleEpisodeQuality({ ...input, episode_review_evidence: oldEvidence })
  assert.equal(result.passed, true)
  assert.equal(result.status, 'needs_attention')
  assert.equal(result.issues.length, 0)
  assert.deepEqual(result.qualityReview.rawReport, input.episode_dramaturgy_review)
  input.video_shot.items.shift()
  const partial = collectPrincipleEpisodeEvidence(input)
  assert.equal(partial.complete, false)
  assert.equal(partial.segments[0].startSecond, null, '缺前片时不把后片冒充从整集零秒开始')
})

test('persisted code runs isolated and only substantive blocking outputs routeError', async () => {
  const input = context()
  const e = await executeCodeNode({ code: PRINCIPLE_EPISODE_EVIDENCE_CODE, context: input })
  assert.deepEqual(e, { ...collectPrincipleEpisodeEvidence(input), executionLogs: [] })
  const accepted = await executeCodeNode({ code: PRINCIPLE_EPISODE_ACCEPT_CODE, context: input })
  assert.deepEqual(accepted, { ...acceptPrincipleEpisodeQuality(input), executionLogs: [] })
  const bad = context(); bad.video_shot.items = []
  const blocked = await executeCodeNode({ code: PRINCIPLE_EPISODE_ACCEPT_CODE, context: bad })
  assert.equal(blocked.passed, false)
  assert.match(String(blocked.routeError), /^EPISODE_PRINCIPLE_BLOCKED:/)
  assert.equal(blocked.qualityReview.canProceed, false)
  const prompt = renderWorkflowTemplate(PRINCIPLE_EPISODE_REVIEW_PROMPT, { episode_review_evidence: e })
  assert.ok(prompt.includes('/generated/clip-0.mp4'))
  assert.ok(prompt.includes('今日告辞'))
  assert.ok(prompt.includes('qualityReview'))
  assert.equal(prompt.includes('${'), false)
})
