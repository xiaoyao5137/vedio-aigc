import test from 'node:test'
import assert from 'node:assert/strict'
import { assessAudioVisualEventEvidence, buildRequiredSpeechPresenceEvidence } from '../src/audio-visual-event-evidence.ts'
import { acceptPrincipleMedia, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { aggregateConcatReviews, assertConcatSpeechEvidence } from '../src/concat-review.ts'
import { executeCodeNode } from '../server/code-node.ts'

// Test mutations intentionally exercise malformed evidence.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Value = Record<string, any>
const policy = { qualityDisposition: 'manual-review-v1', speechEvidencePolicy: 'enforce-evidenced-v1' }
function fixture(): Value {
  const media = { url: '/new.mp4', sha256: 'a'.repeat(64), duration: 10 }
  const voice = { characterId: 'actor-1', characterName: '张角', voiceId: 'provider-voice', referenceHash: 'c'.repeat(64), version: 1, elementId: 'element' }
  const planned = { start: 2, end: 6, text: '黄天当立！', beatId: 'speech-1', actorIds: ['张角'] }
  const input = { shot_script: { id: 'shot', duration: 10, audioType: '对白', audioText: '张角：黄天当立！', pacing: { speechWindows: [planned] } },
    video_take: { url: '/take.mp4', characterVoices: [voice], voiceManifest: { characters: [voice] }, voiceConsistency: { status: 'uncertain' },
      params: { voiceAssets: [{ characterName: '张角', voiceId: 'tts-original', providerResult: { base64: 'must-never-copy' }, videoBinding: voice }] } },
    video_evidence: { ...media, originalUrl: '/take.mp4', evidenceUrl: '/actual-evidence.json', decoded: true, width: 1280, height: 720,
      frames: ['/frame1.jpg', '/last.jpg'], lastFrameUrl: '/last.jpg', hasAudio: true, meanVolumeDb: -25,
      transcript: [{ start: 2, end: 6, text: '黄天当立', words: [...'黄天当立'].map((word, i) => ({ word, start: 2 + i, end: 3 + i, probability: .95 })) }],
      speechValidation: { passed: true, dialogueCompletenessVerified: true, phoneticErrorRate: 0, issues: [],
        alignment: [{ planned, actualStart: 2, actualEnd: 6, matchedStart: 2, matchedEnd: 6, utteranceCandidateStart: 2, utteranceCandidateEnd: 6,
          alignmentCoverage: 1, firstTokenMatched: true, lastTokenMatched: true, boundaryEvidenceVersion: 2, boundaryStatus: 'reliable', boundaryUncertaintyReasons: [] }] } },
    media_review: { reviewUnavailable: true } }
  const visual = { videoUrl: media.url, sha256: media.sha256, duration: 10, method: 'agent-continuous-visual-review',
    reviewer: { kind: 'agent', id: 'reviewer' }, reviewedAt: '2026-09-26T12:00:00Z', evidenceRefs: ['/continuous-frame-proof.json'],
    actorId: '张角', completeness: 'all-visible-speech-intervals', finding: '连续复核中该演员讲话区间为2至6秒，其余时段没有可见语言口型。',
    coverage: { method: 'continuous-frame-sequence', startSecond: 0, endSecond: 10, maxFrameGapSeconds: 1 / 24 },
    speakingIntervals: [{ startSecond: 2, endSecond: 6 }] }
  const targeted = { version: 'targeted-audio-visual-repair-v1', videoUrl: media.url, sha256: media.sha256, duration: 10,
    targets: [{ id: 'missing-dub', status: 'resolved', repairScope: 'required-speech-present', sourceDefect: { code: 'unvoiced_visible_speech', videoUrl: '/old.mp4', sha256: 'b'.repeat(64), actorId: '张角', startSecond: 1, endSecond: 8 },
      userReport: { reference: 'conversation:real-report', quote: '张角动嘴没有配音' },
      resolution: { scope: 'required-speech-present', evidence: buildRequiredSpeechPresenceEvidence(input, visual) } }] }
  return { input: { ...input, targeted_repair_assessment: targeted }, media, visual, targeted }
}

test('same-clip timed speech plus frozen requested voice and continuous visual windows resolves only dubbing presence', async () => {
  const { input, targeted, media } = fixture(), before = structuredClone(input)
  const accepted = acceptPrincipleMedia(input, policy)
  assert.equal(accepted.passed, true)
  const target = accepted.audioVisualEvidenceAssessment.targetResults[0]
  assert.equal(target.status, 'resolved')
  assert.equal(target.resolutionScope, 'required-speech-present')
  assert.equal(target.fullAudioVisualRepairVerified, false)
  assert.equal(target.speakerIdentityVerified, false)
  assert.equal(target.lipSyncVerified, false)
  assert.equal(accepted.audioVisualEvidenceAssessment.fullVideoListened, false)
  assert.equal((target.technicalPresence as Value).audioListened, false)
  assert.equal(JSON.stringify(targeted).includes('must-never-copy'), false)
  const vm = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input, params: policy })
  assert.deepEqual(vm, { ...accepted, executionLogs: [] })
  const clips = [media]
  const previous = { ...aggregateConcatReviews({ ...policy, currentVideo: accepted }, clips), clips }
  assert.doesNotThrow(() => assertConcatSpeechEvidence({ ...policy, previousVideo: previous }))
  assert.equal((previous.clipReviews[0].targetedRepairAssessment as Value).targets[0].resolution.evidence.transcript[0].words.length, 4)
  assert.deepEqual(input, before)
})

test('interior lexical uncertainty may establish presence without upgrading exact speech or clearing its warnings', () => {
  const { input, visual } = fixture(), speech = input.video_evidence.speechValidation
  speech.passed = false; speech.dialogueCompletenessVerified = false; speech.phoneticErrorRate = .1
  speech.issues = ['部分字识别不确定']
  Object.assign(speech.alignment[0], { alignmentCoverage: .9, boundaryStatus: 'uncertain', boundaryUncertaintyReasons: ['partial-phonetic-alignment'] })
  input.targeted_repair_assessment.targets[0].resolution.evidence = buildRequiredSpeechPresenceEvidence(input, visual)
  const accepted = acceptPrincipleMedia(input, policy)
  assert.equal(accepted.passed, true)
  assert.equal(accepted.technicalValidation.speechVerified, false)
  assert.equal(accepted.technicalValidation.dialogueCompletenessVerified, false)
  assert.equal((accepted.audioVisualEvidenceAssessment.targetResults[0].technicalPresence as Value).exactSpeechVerified, false)
  assert.ok(accepted.audioEvidenceAssessment.observations.some(row => row.code === 'speech_line_unverified'))
  assert.ok(accepted.audioVisualEvidenceAssessment.warnings.some(row => row.code === 'speech_presence_only'))
})

test('empty or low-confidence ASR, stale binding, missing tail and single frames never resolve the user defect', () => {
  const changes: Array<(e: Value) => void> = [
    e => { e.transcript = [] },
    e => { e.transcript[0].words = [] },
    e => { e.transcript[0].words[0].probability = .1 },
    e => { e.meanVolumeDb = -60 },
    e => { e.originalUrl = '/another-take.mp4' },
    e => { e.sha256 = 'd'.repeat(64) },
    e => { e.characterVoices[0].voiceId = 'wrong-voice' },
    e => { e.requestVoiceAssets[0].videoBinding.referenceHash = 'd'.repeat(64) },
    e => { e.speechValidation.alignment[0].lastTokenMatched = false },
    e => { e.speechValidation.alignment[0].boundaryStatus = 'uncertain'; e.speechValidation.alignment[0].boundaryUncertaintyReasons = ['low-confidence-boundary'] },
    e => { e.speechValidation.phoneticErrorRate = .6 },
    e => { e.speechValidation.alignment[0].utteranceCandidateEnd = 8 },
    e => { e.visualReview.coverage.method = 'single-frame' },
    e => { e.visualReview.coverage.maxFrameGapSeconds = 2 },
    e => { e.visualReview.coverage.endSecond = 6 },
    e => { e.visualReview.actorId = 'another-actor' },
    e => { e.visualReview.speakingIntervals.push({ startSecond: 8, endSecond: 9 }) },
  ]
  for (const change of changes) {
    const { media, targeted } = fixture(); change(targeted.targets[0].resolution.evidence)
    const result = assessAudioVisualEventEvidence(media, [], targeted)
    assert.equal(result.targetResults[0].status, 'unresolved', change.toString())
    assert.ok(result.issues.some(issue => issue.code === 'targeted_audio_visual_repair_unresolved'))
  }
})

test('presence-only edge allowance is bounded and reported without changing visual or word evidence', () => {
  const { media, targeted } = fixture(), e = targeted.targets[0].resolution.evidence
  e.visualReview.speakingIntervals = [{ startSecond: 1.94, endSecond: 6.201667 }]
  const before = structuredClone(targeted), assessment = assessAudioVisualEventEvidence(media, [], targeted)
  assert.equal(assessment.targetResults[0].status, 'resolved')
  const measured = assessment.targetResults[0].technicalPresence as Value
  assert.equal(measured.maximumEdgeUncertaintySeconds, .25)
  assert.equal(measured.minimumSpeechOverlap, .8)
  assert.ok(Math.abs(measured.visualSpeechCoverage[0].trailingUncoveredSeconds - .201667) < 1e-6)
  assert.deepEqual(measured.visualSpeechCoverage[0].edgeUncoveredIntervals, [
    { startSecond: 1.94, endSecond: 2, edge: 'leading' }, { startSecond: 6, endSecond: 6.201667, edge: 'trailing' },
  ])
  assert.equal(measured.lipSyncVerified, false)
  assert.ok(assessment.warnings.some(warning => warning.code === 'speech_presence_edge_timing_uncertain'))
  assert.deepEqual(targeted, before)
  e.visualReview.speakingIntervals[0].endSecond = 6.25
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).targetResults[0].status, 'resolved')
  e.visualReview.speakingIntervals[0].endSecond = 6.25001
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).targetResults[0].status, 'unresolved')
  e.visualReview.speakingIntervals = [{ startSecond: 1.8, endSecond: 2.1 }]
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).targetResults[0].status, 'unresolved', 'short isolated unvoiced movement cannot pass from a nearby word')
})

test('speech presence cannot downgrade an unscoped or precise-sync target, or erase current independently confirmed silent speech', () => {
  const { input, targeted, media } = fixture()
  delete targeted.targets[0].repairScope
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).targetResults[0].status, 'unresolved')
  targeted.targets[0].repairScope = 'precise-visible-speech-coverage'
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).targetResults[0].status, 'unresolved')
  targeted.targets[0].repairScope = 'required-speech-present'
  input.audio_visual_review = { version: 'audio-visual-event-review-v1', id: 'confirmed-current-defect', videoUrl: media.url, sha256: media.sha256,
    duration: 10, method: 'agent-continuous-review', reviewer: { kind: 'agent', id: 'actual-listener' }, reviewedAt: '2026-09-26T12:00:00Z', evidenceRefs: ['/real-playback.json'],
    events: [{ id: 'silent-tail', code: 'unvoiced_visible_speech', status: 'confirmed', actorId: '张角', startSecond: 6, endSecond: 6.2,
      finding: '独立真实连续听审确认仍有无声讲话', playback: { mode: 'continuous-audio-video', startSecond: 0, endSecond: 10, videoWatched: true, audioListened: true },
      visual: { basis: 'continuous-video', languageMouthMotion: 'observed', finding: '连续发音口型' }, audio: { basis: 'direct-listening', speech: 'absent', finding: '实际听审此段无语音' } }] }
  const accepted = acceptPrincipleMedia(input, policy)
  assert.equal(accepted.passed, false)
  assert.equal(accepted.audioVisualEvidenceAssessment.targetResults[0].status, 'unresolved')
  assert.ok(accepted.blockingSpeechIssues?.some(issue => issue.code === 'unvoiced_visible_speech'))
  assert.ok((accepted.audioVisualEvidenceAssessment.targetResults[0].technicalPresence as Value).reasons.includes('current-media-has-confirmed-unvoiced-visible-speech'))
  assert.throws(() => assertConcatSpeechEvidence({ ...policy, currentVideo: accepted }), /unvoiced_visible_speech/)
})

test('a long pause cannot be bridged by utterance endpoints or by the presence-only edge allowance', () => {
  const { media, targeted } = fixture(), e = targeted.targets[0].resolution.evidence
  e.transcript[0].words[1].end = 3.5
  e.transcript[0].words[2].start = 4.2
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).targetResults[0].status, 'unresolved', 'continuous speaking spans the long gap')
  e.visualReview.speakingIntervals = [{ startSecond: 2, endSecond: 3.5 }, { startSecond: 4.2, endSecond: 6 }]
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).targetResults[0].status, 'resolved', 'actual visual silence between two phrases is respected')
  e.visualReview.speakingIntervals.push({ startSecond: 3.55, endSecond: 4.1 })
  assert.equal(assessAudioVisualEventEvidence(media, [], targeted).targetResults[0].status, 'unresolved', 'additional visible speaking in the pause remains a target')
})
