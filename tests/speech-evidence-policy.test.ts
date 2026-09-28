import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptPrincipleMedia, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { aggregateConcatReviews, assertConcatSpeechEvidence, concatSpeechEvidenceBlockers } from '../src/concat-review.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'

const manual = { qualityDisposition: 'manual-review-v1' }
const policy = { ...manual, speechEvidencePolicy: 'enforce-evidenced-v1' }
const context = () => ({ shot_script: { id: 'shot', duration: 8, audioType: '对白', audioText: '甲：请饮符水。' },
  video_take: { url: '/take.mp4' }, video_evidence: { originalUrl: '/take.mp4', url: '/video.mp4', evidenceUrl: '/evidence.json', decoded: true,
    duration: 8, width: 1280, height: 720, frames: ['/first.jpg', '/last.jpg'], lastFrameUrl: '/last.jpg', hasAudio: true, meanVolumeDb: -25,
    transcript: [{ start: 1, end: 2, text: '请饮符水', words: [{ probability: .95 }] }], speechValidation: { phoneticErrorRate: 0 } },
  media_review: { version: 'principle-review-v1', decision: 'uncertain', issues: [], warnings: [] } })

type Value = Record<string, unknown>
const repeatedCommand = () => {
  const planned = { start: 7, end: 8.107, text: '退开！', beatId: 'command', sourceBeatId: 'bridge', actorIds: ['张飞'], deliveryStyle: 'dialogue' }
  // Sanitized observed scene-7 ASR: the first complete command has reliable
  // boundaries; the total edit metric also counts a second whole command.
  return { shot_script: { id: 'bridge', duration: 12, audioType: '对白', audioText: '张飞：退开！', pacing: { speechWindows: [planned] } },
    video_take: { url: '/take.mp4', params: {} }, video_evidence: { ...context().video_evidence, duration: 12,
      transcript: [{ start: 7.89, end: 9.45, text: '退开 退开', words: [
        { start: 7.89, end: 8.19, word: '退', probability: .548624575138092 },
        { start: 8.19, end: 8.49, word: '开', probability: .874139666557312 },
        { start: 8.95, end: 9.21, word: ' 退', probability: .9896878600120544 },
        { start: 9.21, end: 9.45, word: '开', probability: .9957436919212341 },
      ] }], speechValidation: { passed: false, phoneticErrorRate: 1, dialogueCompletenessVerified: false,
        issues: ['ASR 文本音节错误率 100.0%；非实测音素或声调错误率'], alignment: [{ planned,
          actualStart: 7.89, actualEnd: 8.49, matchedStart: 7.89, matchedEnd: 8.49, alignmentCoverage: 1,
          firstTokenMatched: true, lastTokenMatched: true, boundaryEvidenceVersion: 2, boundaryStatus: 'reliable', boundaryUncertaintyReasons: [] as string[],
          utteranceCandidateStart: 7.89, utteranceCandidateEnd: 8.49,
          rawUtteranceCandidate: { start: 7.89, end: 8.49, text: '退开', attribution: 'unverified-ASR-candidate' },
        }] } },
    media_review: { version: 'principle-review-v1', decision: 'revise', issues: [] as Value[],
      warnings: [{ code: 'repeated_command_asr', problem: '计划一次口令，ASR转写为退开 退开，须核听。' }] } }
}

test('complete ordered command repetitions remain pending listening in manual preview, preserving raw evidence through runtime and concat', async () => {
  const input = repeatedCommand(), before = structuredClone(input)
  const accepted = acceptPrincipleMedia(input, policy)
  assert.equal(accepted.passed, true)
  assert.equal(accepted.qualityReview.status, 'needs_attention')
  assert.equal(accepted.qualityReview.manualReviewRequired, true)
  assert.deepEqual(accepted.blockingSpeechIssues, [])
  assert.equal(accepted.technicalValidation.speechVerified, false)
  assert.equal(accepted.technicalValidation.dialogueCompletenessVerified, false)
  assert.equal(accepted.technicalValidation.speakerIdentityVerified, false)
  assert.equal(accepted.technicalValidation.lipSyncVerified, false)
  assert.equal(accepted.pronunciationAssessment.syllableTextErrorRate, 1)
  assert.deepEqual(accepted.speechValidation, before.video_evidence.speechValidation)
  assert.deepEqual(accepted.transcript, before.video_evidence.transcript)
  assert.equal(accepted.audioEvidenceAssessment.lineChecks[0].utteranceComplete, true)
  const warning = accepted.warnings.find(row => typeof row !== 'string' && row.code === 'repeated_complete_line_asr') as Value
  assert.equal(warning.status, 'pending-listening')
  assert.equal(warning.automaticRetakeAllowed, false)
  assert.deepEqual((warning.evidence as Value).occurrencesPerLine, [2])
  assert.deepEqual((warning.evidence as Value).transcript, before.video_evidence.transcript)
  assert.equal(((warning.reportedIssue as Value).evidence as Value).phoneticErrorRate, 1)
  assert.equal((warning.reportedIssue as Value).code, 'wrong_speech')
  const sandbox = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input, params: policy })
  assert.deepEqual(sandbox, { ...accepted, executionLogs: [] })
  assert.doesNotThrow(() => assertConcatSpeechEvidence({ ...policy, currentVideo: accepted }))
  const prefix = aggregateConcatReviews({ ...policy, currentVideo: accepted }, [{ url: accepted.url }])
  assert.equal(prefix.qualityReview.canProceed, true)
  assert.equal(prefix.clipReviews[0].technicalValidation.speechVerified, false)
  assert.ok(prefix.qualityWarnings.some(row => (row.warning as Value).code === 'repeated_complete_line_asr'))
  assert.doesNotThrow(() => assertConcatSpeechEvidence({ ...policy, previousVideo: { ...prefix, clips: [{ url: accepted.url }] } }))
  assert.deepEqual(input, before)
})

test('strict production still blocks complete ASR repetitions', () => {
  const result = acceptPrincipleMedia(repeatedCommand(), { speechEvidencePolicy: policy.speechEvidencePolicy, qualityDisposition: 'strict-v1' })
  assert.equal(result.passed, false)
  assert.equal(result.blockingSpeechIssues?.[0].code, 'wrong_speech')
  assert.ok(!result.warnings.some(row => typeof row !== 'string' && row.code === 'repeated_complete_line_asr'))
})

test('manual repetition classification requires every distinct planned line in original order', () => {
  const input = repeatedCommand()
  const planned = { ...input.shot_script.pacing.speechWindows[0], beatId: 'follow', actorIds: ['刘备'], text: '跟上！', start: 9.8, end: 10.9 }
  input.shot_script.audioText += '\n刘备：跟上！'
  input.shot_script.pacing.speechWindows.push(planned)
  const words = [{ start: 9.8, end: 10.1, word: '跟', probability: .95 }, { start: 10.1, end: 10.4, word: '上', probability: .95 },
    { start: 11.3, end: 11.6, word: '跟', probability: .95 }, { start: 11.6, end: 11.9, word: '上', probability: .95 }]
  input.video_evidence.transcript.push({ start: 9.8, end: 11.9, text: '跟上 跟上', words })
  input.video_evidence.speechValidation.alignment.push({ ...input.video_evidence.speechValidation.alignment[0], planned,
    actualStart: 9.8, actualEnd: 10.4, matchedStart: 9.8, matchedEnd: 10.4, utteranceCandidateStart: 9.8, utteranceCandidateEnd: 10.4,
    rawUtteranceCandidate: { start: 9.8, end: 10.4, text: '跟上', attribution: 'unverified-ASR-candidate' } })
  const accepted = acceptPrincipleMedia(input, policy)
  assert.equal(accepted.passed, true)
  const warning = accepted.warnings.find(row => typeof row !== 'string' && row.code === 'repeated_complete_line_asr') as Value
  assert.deepEqual((warning.evidence as Value).occurrencesPerLine, [2, 2])
  for (const mutate of [
    (changed: typeof input) => { changed.video_evidence.transcript.pop() },
    (changed: typeof input) => { changed.video_evidence.transcript.reverse() },
    (changed: typeof input) => { changed.video_evidence.speechValidation.alignment.reverse() },
  ]) {
    const changed = structuredClone(input); mutate(changed)
    const rejected = acceptPrincipleMedia(changed, policy)
    assert.equal(rejected.passed, false)
    assert.equal(rejected.blockingSpeechIssues?.[0].code, 'wrong_speech')
  }
})

test('repetition preview exception cannot hide new words, missing lines, incomplete boundaries or explicit wrong-speaker evidence', () => {
  const cases: Array<[string, (input: ReturnType<typeof repeatedCommand>) => void]> = [
    ['wrong words', input => { input.video_evidence.transcript[0].text = '退开 跪下' }],
    ['new language', input => { input.video_evidence.transcript[0].text = '退开 go away' }],
    ['partial repeat', input => { input.video_evidence.transcript[0].text = '退开 退'; input.video_evidence.transcript[0].words.forEach(word => { word.probability = .95 }) }],
    ['ASR words disagree with displayed text', input => { input.video_evidence.transcript[0].words[3].word = '去' }],
    ['unrepresented original line', input => { input.shot_script.audioText += '\n刘备：跟上！' }],
    ['missing planned line', input => { input.shot_script.pacing.speechWindows.push({ ...input.shot_script.pacing.speechWindows[0], text: '跟上！' }); input.shot_script.audioText += '\n刘备：跟上！' }],
    ['partial recognized line', input => { input.video_evidence.speechValidation.alignment[0].alignmentCoverage = .5 }],
    ['uncertain utterance boundary', input => { input.video_evidence.speechValidation.alignment[0].boundaryStatus = 'uncertain' }],
    ['rebound actor', input => { input.video_evidence.speechValidation.alignment[0].planned = { ...input.shot_script.pacing.speechWindows[0], actorIds: ['刘备'] } }],
    ['explicit speaker mismatch', input => { Object.assign(input.video_evidence.speechValidation.alignment[0], { speakerMatches: false }) }],
    ['verified actual actor reversal', input => { Object.assign(input.video_evidence.speechValidation.alignment[0], { speakerIdentityVerified: true, actualActorIds: ['刘备'] }) }],
    ['reviewer contrary speech evidence', input => { input.media_review.issues.push({ code: 'missing_or_wrong_speech', problem: '刘备说了张飞口令', repair: '复核说话人', evidence: { source: 'asr', quote: '退开', finding: '口令明确属于刘备' } }) }],
    ['explicit actor reversal retained as review warning', input => { input.media_review.warnings.push({ code: 'speaker_reversal', problem: '有明确证据显示口令由其他人物说出' }) }],
  ]
  for (const [label, mutate] of cases) {
    const input = repeatedCommand(); mutate(input)
    const accepted = acceptPrincipleMedia(input, policy)
    assert.equal(accepted.passed, false, label)
    assert.equal(accepted.blockingSpeechIssues?.[0].code, 'wrong_speech', label)
    assert.ok(!accepted.warnings.some(row => typeof row !== 'string' && row.code === 'repeated_complete_line_asr'), label)
  }
})

test('explicit speech policy blocks four evidenced technical defects even in manual mode; legacy manual remains compatible', async () => {
  for (const [code, mutate] of [
    ['missing_audio', (c: ReturnType<typeof context>) => { c.video_evidence.hasAudio = false }],
    ['wrong_speech', (c: ReturnType<typeof context>) => { c.video_evidence.speechValidation.phoneticErrorRate = .9 }],
    ['inaudible_speech', (c: ReturnType<typeof context>) => { c.video_evidence.meanVolumeDb = -70; c.video_evidence.transcript = [] }],
    ['unexpected_speech', (c: ReturnType<typeof context>) => { c.shot_script.audioType = '环境声'; c.shot_script.audioText = '' }],
  ] as const) {
    const input = context(); mutate(input)
    assert.equal(acceptPrincipleMedia(input, manual).passed, true, code)
    const accepted = acceptPrincipleMedia(input, policy)
    assert.equal(accepted.passed, false, code)
    assert.equal(accepted.qualityReview.canProceed, false)
    assert.equal(accepted.speechEvidencePolicy, policy.speechEvidencePolicy)
    assert.equal(accepted.qualityReview.blockingSpeechIssues?.[0].code, code)
    assert.equal(accepted.technicalValidation.issues[0].code, code)
    const sandbox = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context: input, params: policy })
    assert.equal(sandbox.passed, false)
  }
})

test('unknown transcript, speaker identity and lip sync, and weak ambient candidates remain nonblocking', () => {
  const unknown = context(); unknown.video_evidence.transcript = []
  const accepted = acceptPrincipleMedia(unknown, policy)
  assert.equal(accepted.passed, true)
  assert.equal(accepted.technicalValidation.speechVerified, false)
  assert.equal(accepted.technicalValidation.speakerIdentityVerified, false)
  assert.equal(accepted.technicalValidation.lipSyncVerified, false)
  const weak = context(); weak.shot_script.audioType = '环境声'; weak.shot_script.audioText = ''
  weak.video_evidence.transcript[0].words[0].probability = .2
  assert.equal(acceptPrincipleMedia(weak, policy).passed, true)
  const uncertainWrong = context(); uncertainWrong.video_evidence.speechValidation.phoneticErrorRate = .9
  uncertainWrong.video_evidence.transcript[0].words[0].probability = .2
  const uncertainAccepted = acceptPrincipleMedia(uncertainWrong, policy)
  assert.equal(uncertainAccepted.passed, true)
  assert.equal(uncertainAccepted.technicalValidation.passed, false, 'an unresolved ASR report stays visible')
  assert.doesNotThrow(() => assertConcatSpeechEvidence({ ...policy, currentVideo: uncertainAccepted }))
})

test('a saved failed prefix blocks before concatenation even when current manual media passes', async () => {
  const bad = context(); bad.video_evidence.hasAudio = false
  const oldManual = acceptPrincipleMedia(bad, manual)
  const prefix = aggregateConcatReviews({ currentVideo: oldManual }, [{ url: oldManual.url }])
  const current = { ...acceptPrincipleMedia(context(), policy), url: '/next.mp4' }
  const params = { ...policy, previousVideo: { ...prefix, clips: [{ url: '/unknown.mp4' }, { url: oldManual.url }],
    clipReviews: [{ videoUrl: '/unknown.mp4' }, prefix.clipReviews[0]] }, currentVideo: current }
  assert.equal(concatSpeechEvidenceBlockers(params)[0].segmentIndex, 1)
  assert.throws(() => assertConcatSpeechEvidence(params), /VIDEO_CONCAT_SPEECH_REJECTED:.*第2片 missing_audio/)
  await assert.rejects(executeBuiltinNode({} as Parameters<typeof executeBuiltinNode>[0], { operation: 'video.concat', params }), /VIDEO_CONCAT_SPEECH_REJECTED/)
  const report = aggregateConcatReviews(params, params.previousVideo.clips.concat({ url: current.url }))
  assert.equal(report.qualityReview.canProceed, false)
  assert.equal(report.qualityReview.blockingSpeechIssues?.length, 1)
  assert.doesNotThrow(() => assertConcatSpeechEvidence({ ...policy, previousVideo: { clips: [{ url: '/unknown.mp4' }] }, currentVideo: current }))
})

test('workflow explicitly configures speech enforcement without changing other manual choices', () => {
  const nodes = ['sanguo-media-accept', 'sanguo-video-concat', 'sanguo-character-accept'].map(id => ({ id, kind: 'code', code: 'return {};', prompt: '', params: [
    { id: 'manual', name: 'qualityDisposition', englishName: 'qualityDisposition', type: 'text', value: 'manual-review-v1', required: true },
  ] }))
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 117, nodes }, before = structuredClone(source)
  const upgraded = upgradePrincipleQuality(source)
  assert.deepEqual(source, before)
  assert.equal(upgraded.nodes[0].params.find(p => p.name === 'speechEvidencePolicy')?.value, 'enforce-evidenced-v1')
  assert.equal(upgraded.nodes[1].params.find(p => p.name === 'speechEvidencePolicy')?.value, 'enforce-evidenced-v1')
  assert.equal(upgraded.nodes[2].params.find(p => p.name === 'speechEvidencePolicy'), undefined)
  assert.ok(upgraded.nodes.every(node => node.params.find(p => p.name === 'qualityDisposition')?.value === 'manual-review-v1'))
  assert.equal(upgradePrincipleQuality(upgraded), upgraded)
})
