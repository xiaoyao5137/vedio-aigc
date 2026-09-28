import test from 'node:test'
import assert from 'node:assert/strict'
import { assessAudioVisualEventEvidence } from '../src/audio-visual-event-evidence.ts'
import { acceptPrincipleMedia, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { aggregateConcatReviews, assertConcatSpeechEvidence } from '../src/concat-review.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const media = { url: '/generated/clip.mp4', sha256: 'a'.repeat(64), duration: 10 }
const policy = { qualityDisposition: 'manual-review-v1', speechEvidencePolicy: 'enforce-evidenced-v1' }
const review = () => ({ version: 'audio-visual-event-review-v1', id: 'review-1', videoUrl: media.url, sha256: media.sha256, duration: media.duration,
  method: 'agent-continuous-review', reviewer: { kind: 'agent', id: 'actual-reviewer' }, reviewedAt: '2026-09-26T10:00:00Z', evidenceRefs: ['/audit/playback.json'],
  events: [{ id: 'event-1', code: 'unvoiced_visible_speech', status: 'confirmed', actorId: '张角', startSecond: 2, endSecond: 6,
    finding: '该区间连续语言口型但实际听到的音轨只有风声。', repair: '保留指向动作，纠正实际声画表现。',
    playback: { mode: 'continuous-audio-video', startSecond: 0, endSecond: 10, videoWatched: true, audioListened: true },
    visual: { basis: 'continuous-video', languageMouthMotion: 'observed', finding: '连续开合和发音形状变化。' },
    audio: { basis: 'direct-listening', speech: 'absent', finding: '实际连续播放此段音频，只听到环境声。' } }],
})
const reported = () => ({ ...review(), method: 'user-report', reviewer: { kind: 'user', id: 'conversation-user' },
  userReport: { reference: 'conversation:message-1', quote: '2:30张角动嘴没有配音' },
  events: [{ id: 'reported-1', code: 'unvoiced_visible_speech', status: 'reported', actorId: '张角', startSecond: 2, endSecond: 6, finding: '用户实播报告动嘴无声，尚未独立确认。' }] })
const context = (report: unknown) => ({ shot_script: { id: 'shot', audioType: '环境声', audioText: '', duration: 10 }, video_take: { url: '/take.mp4', params: {} },
  video_evidence: { ...media, originalUrl: '/take.mp4', evidenceUrl: '/evidence.json', decoded: true, width: 1280, height: 720, hasAudio: true,
    meanVolumeDb: -25, transcript: [], frames: ['/first.jpg', '/last.jpg'], lastFrameUrl: '/last.jpg' }, audio_visual_review: report,
  media_review: { reviewUnavailable: true } })

test('continuous same-clip audiovisual evidence blocks actual silent talking even without planned speech or ASR', async () => {
  const input = context(review()), before = structuredClone(input), accepted = acceptPrincipleMedia(input, policy)
  assert.equal(accepted.passed, false)
  assert.equal(accepted.blockingSpeechIssues?.[0].code, 'unvoiced_visible_speech')
  assert.equal(accepted.audioVisualEvidenceAssessment.events[0].independentlyConfirmed, true)
  assert.equal(accepted.audioVisualEvidenceAssessment.fullVideoListened, false, 'a defect window is not whole-film approval')
  const sandbox = await executeCodeNode({ code: renderWorkflowTemplate(PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', {}), context: input, params: policy })
  assert.deepEqual(sandbox, { ...accepted, executionLogs: [] })
  assert.deepEqual(input, before)
})

test('a frame, empty ASR, VAD, unknown review or stale identity cannot be promoted to continuous hearing proof', () => {
  const mutations: Array<(r: ReturnType<typeof review>) => void> = [
    r => { r.events[0].playback.audioListened = false },
    r => { r.events[0].playback.videoWatched = false },
    r => { r.events[0].playback.mode = 'frame-sampling' },
    r => { r.events[0].visual.basis = 'single-frame' },
    r => { r.events[0].audio.basis = 'asr-empty' },
    r => { r.events[0].audio.basis = 'vad-no-speech' },
    r => { r.events[0].status = 'uncertain' },
    r => { r.events[0].audio.speech = 'unknown' },
    r => { r.sha256 = 'b'.repeat(64) },
    r => { r.videoUrl = '/another.mp4' },
    r => { r.events[0].endSecond = 11 },
    r => { r.events[0].playback.endSecond = 3 },
    r => { r.evidenceRefs = [] },
  ]
  for (const mutate of mutations) {
    const r = review(); mutate(r)
    const accepted = acceptPrincipleMedia(context(r), policy)
    assert.equal(accepted.passed, true, JSON.stringify(r))
    assert.equal(accepted.audioVisualEvidenceAssessment.issues.length, 0)
    assert.ok(accepted.audioVisualEvidenceAssessment.warnings.length)
  }
  const absentHash = context(review()); delete (absentHash.video_evidence as Record<string, unknown>).sha256
  assert.equal(acceptPrincipleMedia(absentHash, policy).passed, true)
})

test('a traceable explicit user report blocks its target while staying independently unconfirmed', () => {
  const r = reported(), accepted = acceptPrincipleMedia(context(r), policy)
  assert.equal(accepted.passed, false)
  assert.equal(accepted.blockingSpeechIssues?.[0].code, 'reported_audio_visual_defect')
  assert.equal(accepted.audioVisualEvidenceAssessment.events[0].status, 'reported')
  assert.equal(accepted.audioVisualEvidenceAssessment.events[0].independentlyConfirmed, false)
  const unsupported = { ...r, method: 'agent-report', reviewer: { kind: 'agent', id: 'not-user' } }
  assert.equal(acceptPrincipleMedia(context(unsupported), policy).passed, true)
  assert.equal(acceptPrincipleMedia(context({ ...r, userReport: { quote: r.userReport.quote } }), policy).passed, true)
})

test('old user defect follows a replacement until same-media full target review establishes resolution', () => {
  const targeted = { version: 'targeted-audio-visual-repair-v1', videoUrl: media.url, sha256: media.sha256, duration: media.duration,
    targets: [{ id: 'target-1', status: 'resolved', sourceDefect: { code: 'unvoiced_visible_speech', videoUrl: '/old.mp4', sha256: 'b'.repeat(64), actorId: '张角', startSecond: 2, endSecond: 6 },
      userReport: reported().userReport, resolution: { reviewId: 'review-1', eventId: 'event-1' } }] }
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).issues[0].code, 'targeted_audio_visual_repair_unresolved')
  const resolution = review(); resolution.events[0].status = 'not-observed'; resolution.events[0].visual.languageMouthMotion = 'not-observed'
  assert.equal(assessAudioVisualEventEvidence(media, resolution, targeted).targetResults[0].status, 'unresolved', 'only observing 2–6s cannot resolve a full replacement clip')
  resolution.events[0].startSecond = 0; resolution.events[0].endSecond = 10
  const resolved = assessAudioVisualEventEvidence(media, resolution, targeted)
  assert.equal(resolved.targetResults[0].status, 'resolved')
  assert.equal(resolved.issues.length, 0)
  resolution.events[0].playback.audioListened = false
  assert.equal(assessAudioVisualEventEvidence(media, resolution, targeted).targetResults[0].status, 'unresolved')
  assert.equal(assessAudioVisualEventEvidence({ ...media, sha256: 'c'.repeat(64) }, [], targeted).targetResults[0].status, 'unresolved', 'changing media cannot erase an explicit user target')
})

test('rolling concat retains raw event provenance and blocks saved user reports; stale hashes do not certify an event', () => {
  const current = acceptPrincipleMedia(context(reported()), policy)
  const clips = [{ url: current.url, sha256: media.sha256 }]
  const previous = { ...aggregateConcatReviews({ ...policy, currentVideo: current }, clips), clips }
  assert.deepEqual(previous.clipReviews[0].audioVisualEventReviews, current.audioVisualEventReviews)
  assert.equal(previous.qualityReview.canProceed, false)
  assert.throws(() => assertConcatSpeechEvidence({ ...policy, previousVideo: previous, currentVideo: { url: '/next.mp4' } }), /VIDEO_CONCAT_SPEECH_REJECTED.*reported_audio_visual_defect/)
  assert.doesNotThrow(() => assertConcatSpeechEvidence({ ...policy, previousVideo: { ...previous, clips: [{ url: current.url, sha256: 'b'.repeat(64) }] } }))
  const targetedRepairAssessment = { version: 'targeted-audio-visual-repair-v1', videoUrl: media.url, sha256: media.sha256, duration: media.duration,
    targets: [{ id: 'user-target', status: 'unresolved', sourceDefect: { code: 'unvoiced_visible_speech', videoUrl: '/old.mp4', sha256: 'c'.repeat(64), actorId: '张角', startSecond: 1, endSecond: 2 }, userReport: reported().userReport }] }
  const targetedPrefix = { ...previous, clipReviews: [{ ...previous.clipReviews[0], targetedRepairAssessment }], clips: [{ url: current.url, sha256: 'b'.repeat(64) }] }
  assert.throws(() => assertConcatSpeechEvidence({ ...policy, previousVideo: targetedPrefix }), /targeted_audio_visual_repair_unresolved/)
  const changed = aggregateConcatReviews({ ...policy, previousVideo: { ...targetedPrefix, clips } }, targetedPrefix.clips)
  assert.equal(changed.qualityReview.canProceed, false)
  assert.deepEqual(changed.clipReviews[0].targetedRepairAssessment, targetedRepairAssessment)
})
