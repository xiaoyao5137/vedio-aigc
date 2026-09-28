import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveVoiceGateDecision, voiceReviewSource, voiceReviewTarget } from '../src/voice-review.ts'

const acceptedVideo = {
  url: '/generated/accepted.mp4',
  originalUrl: 'https://example.test/provider.mp4',
  characterVoices: [{
    characterId: 'actor-1', characterName: '张角', voiceId: 'voice-1', voiceName: '张角原创',
    version: 1, accountScope: 'account', previewUrl: 'https://example.test/voice.wav',
  }],
}

test('failed concat exposes its accepted current video as the listening-review source', () => {
  const failedOutput = { error: 'VOICE_REVIEW_REQUIRED' }
  const source = voiceReviewSource(failedOutput, acceptedVideo)
  assert.equal(source, acceptedVideo)
  assert.deepEqual(voiceReviewTarget(source), {
    videoUrl: 'https://example.test/provider.mp4',
    characters: acceptedVideo.characterVoices,
  })
})

test('a direct video output remains the preferred listening-review source', () => {
  assert.equal(voiceReviewSource(acceptedVideo, { url: '/generated/other.mp4' }), acceptedVideo)
  assert.equal(voiceReviewSource({ error: 'VOICE_REVIEW_REQUIRED' }, undefined), null)
})

test('missing recognition capability automatically passes a complete locked voice binding without pretending it was listened to', () => {
  const target = voiceReviewTarget(acceptedVideo)!
  const decision = resolveVoiceGateDecision(target, null)
  assert.equal(decision.status, 'passed')
  assert.equal(decision.method, 'automatic-binding-fallback')
  if (decision.method === 'automatic-binding-fallback') {
    assert.equal(decision.recognitionCapability, 'unavailable')
    assert.equal(decision.evidence.characters[0].voiceId, 'voice-1')
    assert.doesNotMatch(decision.note, /已听审通过/)
  }
})

test('an uncertain listening result becomes non-blocking fallback evidence, while an explicit rejection still blocks', () => {
  const target = voiceReviewTarget(acceptedVideo)!
  const uncertain = { status: 'uncertain', note: '短句不足以比较', reviewedAt: '2026-09-25T00:00:00.000Z', method: 'user-listening' } as const
  const decision = resolveVoiceGateDecision(target, uncertain)
  assert.equal(decision.status, 'passed')
  assert.equal(decision.method, 'automatic-binding-fallback')
  if (decision.method === 'automatic-binding-fallback') assert.equal(decision.priorReview?.status, 'uncertain')
  assert.throws(() => resolveVoiceGateDecision(target, { ...uncertain, status: 'failed' }), /VOICE_REVIEW_REJECTED/)
})

test('a passed human listening review is preserved as stronger evidence', () => {
  const target = voiceReviewTarget(acceptedVideo)!
  const passed = { status: 'passed', note: '音色一致', reviewedAt: '2026-09-25T00:00:00.000Z', method: 'user-listening' } as const
  assert.equal(resolveVoiceGateDecision(target, passed), passed)
})
