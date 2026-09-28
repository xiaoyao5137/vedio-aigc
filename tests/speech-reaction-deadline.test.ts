import assert from 'node:assert/strict'
import test from 'node:test'
import { executeCodeNode } from '../server/code-node.ts'
import { deriveApprovedReactionDeadline } from '../src/speech-reaction-deadline.ts'
import { acceptPrincipleMedia, principleMediaRequest, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { VIDEO_REQUEST_CODE } from '../src/quality-node-presets.ts'
import { requiresManualMediaDecision } from '../src/workflow-runner.ts'

const shot = () => ({ duration: 9, audioType: '对白', audioText: '张飞：大军已经到了，你为什么不降，还要抵抗？',
  videoPrompt: '0.5-6.149秒：张飞发问。\n6.149-7.649秒：严颜抬下颌。',
  pacing: { version: 'duration-v2', scheduleHash: 'approved-hash',
    speechWindows: [{ beatId: 'question', actorIds: ['张飞'], text: '大军已经到了，你为什么不降，还要抵抗？', start: .5, end: 6.149 }],
    beats: [{ id: 'question', kind: 'speech' }, { id: 'response', kind: 'reaction', actorIds: ['严颜'],
      dependsOn: ['question'], completion: { requiredThisClip: true, evidenceAnchor: '严颜抬起下颌' } }],
    schedule: [{ beatId: 'question', kind: 'speech', startSecond: .5, endSecond: 6.149 },
      { beatId: 'response', kind: 'reaction', startSecond: 6.149, endSecond: 7.649 }] } })

test('approved final speech dependency sets deadline and dense reaction samples in serialized production code', async () => {
  const current = shot(), context = { shot_script: current, first_frame: { url: '/generated/old.jpg' } }
  assert.deepEqual(deriveApprovedReactionDeadline(current), { speechBeatId: 'question', reactionBeatId: 'response',
    startSecond: 6.149, endSecond: 7.649, actorIds: ['严颜'], evidenceAnchor: '严颜抬起下颌' })
  const direct = principleMediaRequest(context)
  const deployed = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.mediaRequest(context);', context })
  const { executionLogs: _executionLogs, ...deployedOutput } = deployed
  void _executionLogs
  assert.deepEqual(deployedOutput, direct)
  assert.equal(direct.latestSpeechEnd, 6.149)
  assert.deepEqual(direct.speechWindows, current.pacing.speechWindows)
  assert.ok(direct.sampleTimes.includes(5.999) && direct.sampleTimes.includes(6.499)
    && direct.sampleTimes.includes(6.899) && direct.sampleTimes.includes(7.499))
  assert.ok(direct.sampleTimes.length <= 24)
  const legacy = await executeCodeNode({ code: VIDEO_REQUEST_CODE, context })
  assert.equal(legacy.latestSpeechEnd, 6.149)
  assert.deepEqual(legacy.speechWindows, current.pacing.speechWindows)
})

test('only reaction after the final spoken beat can narrow a whole-clip deadline', () => {
  const current = shot()
  current.pacing.speechWindows.push({ beatId: 'later', actorIds: ['张飞'], text: '再问一句', start: 7.7, end: 8.2 })
  assert.equal(deriveApprovedReactionDeadline(current), null)
  assert.equal(principleMediaRequest({ shot_script: current }).latestSpeechEnd, 9)
  const optional = shot()
  optional.pacing.beats[1].completion.requiredThisClip = false
  assert.equal(deriveApprovedReactionDeadline(optional), null)
})

function timingContext() {
  const current = shot(), request = principleMediaRequest({ shot_script: current })
  const frames = request.sampleTimes.map((_: number, index: number) => `/generated/current-${index}.jpg`)
  const evidence = { decoded: true, originalUrl: '/generated/scene3.mp4', url: '/generated/scene3.mp4',
    evidenceUrl: '/generated/current-evidence.json', duration: 9.04, width: 1920, height: 1080,
    frames, frameTimes: request.sampleTimes, lastFrameUrl: frames.at(-1), hasAudio: true, meanVolumeDb: -20,
    evidenceRequest: { speechWindows: request.speechWindows, latestSpeechEnd: request.latestSpeechEnd },
    transcript: [{ start: .72, end: 8.18, text: '大军已经到了你为什么不想还要抵抗' }],
    speechValidation: { passed: false, phoneticErrorRate: .063, alignment: [{ planned: request.speechWindows[0],
      matchedStart: .72, matchedEnd: 8.18, utteranceCandidateEnd: 8.18, alignmentCoverage: .9375,
      lastTokenMatched: true, boundaryEvidenceVersion: 2, endBoundaryRange: { lower: 8.18, upper: 8.18 },
      rawUtteranceCandidate: { words: [{ word: '大军已经到了你为什么不想还要' },
        { word: '抵', probability: .999 }, { word: '抗', probability: .998 }] } }] } }
  const checked = { reactionBeatId: 'response', speechBeatId: 'question', actorIds: ['严颜'], status: 'missing',
    actorVisible: true, evidenceUrl: evidence.evidenceUrl,
    frameIndices: [5.999, 6.499, 6.899, 7.499].map(second => request.sampleTimes.indexOf(second)),
    finding: '第 5.999 秒基线、6.499/6.899/7.499 秒逐帧查看，严颜下颌清晰可见但没有抬起。' }
  const report = { version: 'principle-review-v1', decision: 'pass', issues: [], warnings: [],
    dependentReactionCheck: checked, endingState: '两人仍对峙', endCharacters: ['张飞', '严颜'] }
  const raw = { type: 'message', role: 'assistant', provider: 'Codex', content: [{ type: 'text', text: JSON.stringify(report) }] }
  return { shot_script: current, video_take: { url: evidence.originalUrl }, video_evidence: evidence,
    media_review: { ...report, text: JSON.stringify(report), raw, model: 'codex-review' } }
}

test('late terminal words plus independently structured current-frame review pause manual path without repurchase', async () => {
  const context = timingContext(), params = { qualityDisposition: 'manual-review-v1' }
  const accepted = acceptPrincipleMedia(context, params)
  assert.equal(accepted.passed, true, 'manual checkpoint preserves the generated media')
  assert.equal(accepted.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.automaticRetakeAllowed, false)
  assert.equal(accepted.temporalReaction.lateWordAnchored, true)
  assert.equal(accepted.temporalReaction.visualReviewBound, true)
  assert.equal(accepted.temporalReaction.exactWordsVerified, false, 'near-homophone is not a wrong-line verdict')
  assert.equal(requiresManualMediaDecision({ id: 'accept-3', node: { id: 'sanguo-media-accept' },
    status: 'success', output: accepted }), true)
  const deployed = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);',
    context, params })
  assert.equal(deployed.manualDecisionRequired, true)

  const mutations: Array<(value: ReturnType<typeof timingContext>) => void> = [
    value => { delete (value.media_review as Record<string, unknown>).raw },
    value => { value.media_review.version = 'invented' },
    value => { value.media_review.decision = 'invented' },
    value => { value.media_review.dependentReactionCheck.actorIds = ['张飞'] },
    value => { value.media_review.dependentReactionCheck.evidenceUrl = '/generated/other.json' },
    value => { value.media_review.dependentReactionCheck.frameIndices = [0, 1, 2] },
    value => { value.video_evidence.speechValidation.alignment[0].rawUtteranceCandidate.words[2].probability = .2 },
    value => { value.video_evidence.evidenceRequest.latestSpeechEnd = 8.7 },
  ]
  for (const mutate of mutations) {
    const forged = timingContext(); mutate(forged)
    const result = acceptPrincipleMedia(forged, params)
    assert.equal(result.manualDecisionRequired, false)
    assert.equal(result.temporalReaction.status, 'unverified')
  }
})

test('bound uncertain reaction and late terminal word require human review without claiming a missing action', () => {
  const context = timingContext()
  context.media_review.dependentReactionCheck.status = 'uncertain'
  context.media_review.dependentReactionCheck.finding = '基线及窗内帧中，未能可靠辨认独立的下颌上提动作。'
  const original = { version: context.media_review.version, decision: context.media_review.decision,
    issues: context.media_review.issues, warnings: context.media_review.warnings,
    dependentReactionCheck: context.media_review.dependentReactionCheck,
    endingState: context.media_review.endingState, endCharacters: context.media_review.endCharacters }
  context.media_review.text = JSON.stringify(original)
  context.media_review.raw.content[0].text = context.media_review.text
  const accepted = acceptPrincipleMedia(context, { qualityDisposition: 'manual-review-v1' })
  assert.equal(accepted.passed, true)
  assert.equal(accepted.qualityReview.status, 'needs_attention')
  assert.equal(accepted.manualDecisionRequired, true)
  assert.equal(accepted.qualityReview.automaticRetakeAllowed, false)
  assert.equal(accepted.temporalReaction.status, 'manual-review-hold')
  assert.equal(accepted.technicalValidation.passed, true)
  assert.equal(accepted.visualReview.passed, false)
  assert.equal(accepted.qualityReview.principleIssues.length, 0)
  assert.ok(accepted.warnings.some(item => typeof item === 'object' && String(item.problem).includes('不认定动作缺失')))

  const vague = structuredClone(context)
  vague.media_review.dependentReactionCheck.finding = '人物站在画面中。'
  vague.media_review.text = JSON.stringify({ ...original, dependentReactionCheck: vague.media_review.dependentReactionCheck })
  vague.media_review.raw.content[0].text = vague.media_review.text
  assert.equal(acceptPrincipleMedia(vague, { qualityDisposition: 'manual-review-v1' }).manualDecisionRequired, false)
})
