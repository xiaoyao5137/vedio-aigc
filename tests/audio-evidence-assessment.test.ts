import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptPrincipleMedia, assessPrincipleSpeechEvidence, PRINCIPLE_MEDIA_RUNTIME_CODE, PRINCIPLE_MEDIA_REVIEW_PROMPT } from '../src/principle-media-quality.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

type Value = Record<string, unknown>
const fixture = () => {
  const windows = [
    { start: 1, end: 2.713, text: '黄天当立！', beatId: 'leader', sourceBeatId: 'rally', actorIds: ['张角'], deliveryStyle: 'dialogue' },
    { start: 2.713, end: 5.213, text: '黄天当立！', beatId: 'response', sourceBeatId: 'rally', actorIds: ['crowd'], deliveryStyle: 'dialogue' },
  ]
  const segments = [{ start: 2.42, end: 3.96, text: '皇天当立' }, { start: 3.96, end: 6.24, text: '皇天当立' }]
  const shot: Value = { id: 'rally', audioType: '对白', audioText: '张角：黄天当立！\n万人齐声应和：黄天当立！', duration: 9,
    pacing: { speechWindows: windows, scheduleHash: 'rally-schedule' } }
  const evidence: Value = { originalUrl: 'https://example.com/rally.mp4', url: '/generated/rally.mp4', evidenceUrl: '/generated/rally-evidence.json',
    decoded: true, width: 1280, height: 720, duration: 9.04, hasAudio: true, meanVolumeDb: -26.6,
    frames: ['/generated/rally-first.jpg', '/generated/rally-last.jpg'], frameTimes: [0, 8.96], lastFrameUrl: '/generated/rally-last.jpg', transcript: segments,
    speechValidation: { passed: true, phoneticErrorRate: 0, dialogueCompletenessVerified: true, alignmentVersion: 2, issues: [],
      alignment: windows.map((planned, index) => ({ planned, actualStart: segments[index].start, actualEnd: segments[index].end,
        matchedStart: segments[index].start, matchedEnd: segments[index].end, utteranceCandidateStart: segments[index].start,
        utteranceCandidateEnd: segments[index].end, alignmentCoverage: 1, firstTokenMatched: true, lastTokenMatched: true,
        boundaryEvidenceVersion: 2, boundaryStatus: 'reliable', boundaryUncertaintyReasons: [] })) } }
  return { shot_script: shot, video_evidence: evidence, video_take: { url: evidence.originalUrl, params: { scheduleHash: 'rally-schedule' } },
    media_review: { version: 'principle-review-v1', decision: 'pass', issues: [], warnings: [] } }
}

test('distinct complete same-text utterances certify content but never speaker identity or lip synchronization', () => {
  const input = fixture(), before = structuredClone(input)
  const result = acceptPrincipleMedia(input)
  assert.equal(result.technicalValidation.speechVerified, true)
  assert.equal(result.technicalValidation.speakerIdentityVerified, false)
  assert.equal(result.technicalValidation.lipSyncVerified, false)
  assert.equal(result.technicalValidation.toneVerified, false)
  assert.equal(result.technicalValidation.phonemeVerified, false)
  assert.equal(result.pronunciationAssessment.status, 'unverified')
  assert.equal(result.pronunciationAssessment.evidenceLevel, 'asr-text-only')
  assert.equal(result.audioEvidenceAssessment.lineChecks.length, 2)
  assert.deepEqual(result.audioEvidenceAssessment.actualSpeechIntervals.map(row => [row.startSecond, row.endSecond]), [[2.42, 3.96], [3.96, 6.24]])
  assert.ok(Math.abs(result.audioEvidenceAssessment.secondsAfterLastRecognizedWord! - 2.8) < .001)
  assert.equal(result.audioEvidenceAssessment.tailSilenceVerified, false)
  assert.deepEqual(input, before)
})

test('dictionary-derived homophone and tone clues remain visible warnings and never become measured pronunciation or rejection', async () => {
  const input = fixture()
  const variants = [
    { code: 'asr_lexical_tone_variant', problem: '渠/去字典调值不同，不是实测声调', evidence: { source: 'asr-text-dictionary', variants: [{ expectedText: '渠', recognizedText: '去', expectedLexicalPinyin: 'qu2', recognizedLexicalPinyin: 'qu4' }] } },
    { code: 'asr_homophone_spelling_variant', problem: '黄/皇同音字转写差异', evidence: { source: 'asr-text-dictionary' } },
  ]
  Object.assign(input.video_evidence.speechValidation, { pronunciationAssessment: { status: 'passed', toneVerified: true, phonemeVerified: true, warnings: variants } })
  const before = structuredClone(input)
  const accepted = acceptPrincipleMedia(input, { speechEvidencePolicy: 'enforce-evidenced-v1' })
  assert.equal(accepted.passed, true)
  assert.equal(accepted.technicalValidation.speechVerified, true, 'lexical completeness is separate from pronunciation')
  assert.equal(accepted.pronunciationAssessment.status, 'unverified')
  assert.equal(accepted.pronunciationAssessment.toneVerified, false)
  assert.equal(accepted.pronunciationAssessment.phonemeVerified, false)
  assert.equal(accepted.pronunciationAssessment.metricKind, 'toneless-asr-text-syllable-edit-distance')
  assert.equal(accepted.pronunciationAssessment.syllableTextErrorRate, 0)
  assert.equal(accepted.qualityReview.principleIssues.length, 0)
  for (const variant of variants) assert.ok(accepted.qualityReview.warnings.some(warning => typeof warning !== 'string' && warning.code === variant.code))
  const sandbox = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input, params: { speechEvidencePolicy: 'enforce-evidenced-v1' } })
  assert.deepEqual(sandbox, { ...accepted, executionLogs: [] })
  assert.deepEqual(input, before)
})

test('record-qz0e0e group response uncertainty remains visible despite zero total phonetic error', async () => {
  const input = fixture(), speech = input.video_evidence.speechValidation
  speech.passed = false; speech.dialogueCompletenessVerified = false
  speech.issues = ['台词首尾或对齐证据不确定，须复核同一素材音频：黄天当立！']
  speech.alignment[1].boundaryStatus = 'uncertain'
  speech.alignment[1].boundaryUncertaintyReasons = ['segment-word-end-disagreement']
  const before = structuredClone(input)
  for (const params of [{}, { qualityDisposition: 'manual-review-v1' }]) {
    const result = acceptPrincipleMedia(input, params)
    assert.equal(result.passed, true, 'uncertain recognition does not buy a new take')
    assert.equal(result.technicalValidation.speechVerified, false)
    assert.equal(result.audioEvidenceAssessment.contentVerified, true)
    assert.equal(result.audioEvidenceAssessment.dialogueCompletenessVerified, false)
    assert.equal(result.audioEvidenceAssessment.lineChecks[1].utteranceComplete, false)
    assert.ok(result.qualityReview.warnings.some(row => typeof row !== 'string' && row.code === 'speech_validation_unresolved'))
    assert.equal(result.qualityReview.principleIssues.length, 0)
    const sandbox = await executeCodeNode({ code: renderWorkflowTemplate(PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', {}), context: input, params })
    assert.deepEqual(sandbox, { ...result, executionLogs: [] })
  }
  assert.deepEqual(input, before)
})

test('one actual utterance cannot satisfy two same-text speakers even when both rows claim reliable', () => {
  const input = fixture(), rows = input.video_evidence.speechValidation.alignment
  Object.assign(rows[1], { ...rows[0], planned: rows[1].planned })
  const result = assessPrincipleSpeechEvidence(input.video_evidence, input.shot_script)
  assert.equal(result.speechVerified, false)
  assert.equal(result.orderVerified, false)
  assert.ok(result.lineChecks[1].reasons.includes('reused-or-out-of-order-utterance'))
  // Even very short duplicate intervals must not slip through timing tolerance.
  for (const row of rows) Object.assign(row, { actualStart: 1, actualEnd: 1.1, matchedStart: 1, matchedEnd: 1.1, utteranceCandidateStart: 1, utteranceCandidateEnd: 1.1 })
  assert.equal(assessPrincipleSpeechEvidence(input.video_evidence, input.shot_script).orderVerified, false)
})

test('unbound or swapped planned lines cannot borrow an earlier accepted speech result', () => {
  for (const change of [
    (input: ReturnType<typeof fixture>) => { input.video_evidence.speechValidation.alignment.reverse() },
    (input: ReturnType<typeof fixture>) => { input.video_evidence.speechValidation.alignment[1].planned = { ...input.shot_script.pacing.speechWindows[1], actorIds: ['wrong-speaker'] } },
    (input: ReturnType<typeof fixture>) => { input.video_evidence.speechValidation.alignment.pop() },
  ]) {
    const input = fixture(); change(input)
    assert.equal(assessPrincipleSpeechEvidence(input.video_evidence, input.shot_script).speechVerified, false)
  }
})

test('complete required words do not conceal a separate unassigned ASR utterance', () => {
  const input = fixture()
  input.video_evidence.transcript.push({ start: 7, end: 8, text: '跪下' })
  const result = acceptPrincipleMedia(input, { qualityDisposition: 'manual-review-v1' })
  assert.equal(result.audioEvidenceAssessment.dialogueCompletenessVerified, true)
  assert.equal(result.technicalValidation.speechVerified, false)
  assert.deepEqual(result.audioEvidenceAssessment.unassignedSpeechIntervals, [{ startSecond: 7, endSecond: 8, text: '跪下' }])
  assert.ok(result.warnings.some(row => typeof row !== 'string' && row.code === 'unassigned_speech_interval'))
  assert.equal(result.qualityReview.principleIssues.length, 0, 'unassigned ASR alone remains a listening question')
  assert.equal(result.passed, true)
})

test('empty ASR with audible background remains unresolved speech, while true near-silence is retained under manual policy', () => {
  const input = fixture(); input.video_evidence.transcript = []; input.video_evidence.speechValidation = {}
  let result = acceptPrincipleMedia(input, { qualityDisposition: 'manual-review-v1' })
  assert.equal(result.passed, true)
  assert.equal(result.audioEvidenceAssessment.transcriptStatus, 'empty')
  assert.equal(result.technicalValidation.speechVerified, false)
  assert.ok(result.warnings.some(row => typeof row !== 'string' && row.code === 'speech_not_recognized'))
  assert.equal(result.audioEvidenceAssessment.secondsAfterLastRecognizedWord, null)
  assert.equal(result.audioEvidenceAssessment.tailSilenceVerified, false)
  input.video_evidence.meanVolumeDb = -65
  result = acceptPrincipleMedia(input, { qualityDisposition: 'manual-review-v1' })
  assert.equal(result.passed, true)
  assert.ok(result.qualityReview.principleIssues.some(row => row.code === 'inaudible_speech'))
  assert.equal(result.qualityReview.automaticRetakeAllowed, false)
})

test('ambient empty recognition does not fabricate missing dialogue or certify stopped mouth movement', () => {
  const input = fixture(); input.shot_script.audioText = ''; input.shot_script.audioType = '环境声'; input.shot_script.pacing.speechWindows = []
  input.video_evidence.transcript = []; input.video_evidence.speechValidation = undefined
  const result = acceptPrincipleMedia(input)
  assert.equal(result.passed, true)
  assert.equal(result.audioEvidenceAssessment.speechRequired, false)
  assert.equal(result.audioEvidenceAssessment.speakerIdentityVerified, false)
  assert.equal(result.audioEvidenceAssessment.lipSyncVerified, false)
  assert.equal(result.audioEvidenceAssessment.observations.length, 0)
  assert.match(PRINCIPLE_MEDIA_REVIEW_PROMPT, /静态张口.*不足以确证/)
  assert.match(PRINCIPLE_MEDIA_REVIEW_PROMPT, /两个独立实际发声区间/)
  assert.match(PRINCIPLE_MEDIA_REVIEW_PROMPT, /audio_visual_timing_unverified/)
})
