import test from 'node:test'
import assert from 'node:assert/strict'
import { assertConcatCurrentBytes, requireConcatCurrentAcceptance } from '../server/video-concat-acceptance.ts'

const hash = 'a'.repeat(64)
const evidence = { url: '/generated/verified-story.mp4', decoded: true, sha256: hash,
  evidenceUrl: '/generated/story-evidence.json' }
const acceptedStory = {
  url: evidence.url,
  videoEvidence: evidence,
  storyMediaReview: { version: 'story-shot-media-review-v1', passed: true,
    reviewStatus: 'passed', issues: [], beatChecks: [{ id: 'beat-1', status: 'complete' }],
    endingHold: { status: 'complete' }, videoEvidence: evidence },
}

test('stage concat rejects a visual-only story review without same-source vocal evidence', () => {
  assert.throws(() => requireConcatCurrentAcceptance(acceptedStory, 'wf-story'), /VIDEO_CONCAT_QUALITY_REQUIRED/)
  assert.doesNotThrow(() => assertConcatCurrentBytes(hash, ['b'.repeat(64), hash]))
  assert.throws(() => assertConcatCurrentBytes(hash, ['b'.repeat(64)]), /VIDEO_CONCAT_SOURCE_CHANGED/)
  for (const changed of [
    { storyMediaReview: { ...acceptedStory.storyMediaReview, passed: false, reviewStatus: 'uncertain' } },
    { storyMediaReview: { ...acceptedStory.storyMediaReview, beatChecks: [{ status: 'uncertain' }] } },
    { storyMediaReview: { ...acceptedStory.storyMediaReview, videoEvidence: { ...evidence, sha256: 'b'.repeat(64) } } },
    { videoEvidence: { ...evidence, evidenceUrl: '/generated/other-evidence.json' } },
    { url: '/generated/another-video.mp4' },
  ]) {
    assert.throws(() => requireConcatCurrentAcceptance({ ...acceptedStory, ...changed }, 'wf-story'), /VIDEO_CONCAT_QUALITY_REQUIRED/)
  }
})

test('native sound story workflow accepts decoded source audio without a per-call vocal plan', () => {
  const originalUrl = 'https://example.com/native.mp4'
  const nativeEvidence = { ...evidence, hasAudio: true, meanVolumeDb: -26, originalUrl }
  const current = { ...acceptedStory, originalUrl,
    params: { sound: 'on', requiredSound: 'on' }, videoEvidence: nativeEvidence,
    storyMediaReview: { ...acceptedStory.storyMediaReview, videoUrl: originalUrl,
      vocalPlanRequired: false, videoEvidence: nativeEvidence } }
  assert.deepEqual(requireConcatCurrentAcceptance(current, 'wf-workplace-second-trial-v1'),
    { sourceSha256: hash })
  const uncertain = { ...current, storyMediaReview: { ...current.storyMediaReview,
    passed: false, retryable: false, reviewStatus: 'uncertain', issues: ['动作被遮挡'],
    beatChecks: [{ id: 'beat-1', status: 'uncertain' }], endingHold: { status: 'uncertain' } } }
  assert.deepEqual(requireConcatCurrentAcceptance(uncertain, 'wf-workplace-second-trial-v1'),
    { sourceSha256: hash })
  const unavailable = { ...current, videoEvidence: { ...nativeEvidence, technicalValidation: { passed: true } },
    storyMediaReview: { ...current.storyMediaReview, passed: false, retryable: false,
      reviewStatus: 'unavailable', issues: ['质检服务超时'], assessment: null, observations: null,
      videoEvidence: { ...nativeEvidence, technicalValidation: { passed: true } } } }
  const riskReminder = { sourceVideoSha256: hash, reviewStatus: 'unavailable',
    issues: ['质检服务超时'], message: '逐帧质检未能确证缺陷' }
  const decision = { value: true, passed: true, riskReminder }
  assert.deepEqual(requireConcatCurrentAcceptance(unavailable, 'wf-workplace-second-trial-v1', decision),
    { sourceSha256: hash, riskReminder })
  assert.throws(() => requireConcatCurrentAcceptance(unavailable, 'wf-workplace-second-trial-v1'), /VIDEO_CONCAT_QUALITY_REQUIRED/)
  assert.throws(() => requireConcatCurrentAcceptance(unavailable, 'wf-workplace-second-trial-v1',
    { ...decision, riskReminder: { ...riskReminder, sourceVideoSha256: 'b'.repeat(64) } }), /VIDEO_CONCAT_QUALITY_REQUIRED/)
  for (const changed of [
    { params: { sound: 'off', requiredSound: 'on' } },
    { videoEvidence: { ...nativeEvidence, hasAudio: false } },
    { videoEvidence: { ...nativeEvidence, meanVolumeDb: -90 } },
    { storyMediaReview: { ...current.storyMediaReview, vocalPlanRequired: true } },
    { storyMediaReview: { ...current.storyMediaReview, videoEvidence: { ...nativeEvidence, sha256: 'b'.repeat(64) } } },
    { originalUrl: 'https://example.com/other.mp4' },
  ]) assert.throws(() => requireConcatCurrentAcceptance({ ...current, ...changed },
    'wf-workplace-second-trial-v1'), /VIDEO_CONCAT_QUALITY_REQUIRED/)
})

test('stage concat keeps vocal-plan uncertainty behind human listening', () => {
  const uncertain = { ...acceptedStory, storyMediaReview: {
    ...acceptedStory.storyMediaReview, passed: false, retryable: false,
    reviewStatus: 'uncertain', issues: ['接触关系被遮挡'],
    beatChecks: [{ id: 'beat-1', status: 'uncertain' }], endingHold: { status: 'uncertain' },
    vocalEvidence: { acousticStatus: 'signal-present', sourceVideoSha256: hash,
      sourceVideoUrl: evidence.url },
  } }
  assert.throws(() => requireConcatCurrentAcceptance(uncertain, 'wf-story'), /VIDEO_CONCAT_QUALITY_REQUIRED/)
  assert.throws(() => requireConcatCurrentAcceptance({ ...uncertain, storyMediaReview: {
    ...uncertain.storyMediaReview, beatChecks: [{ status: 'incomplete' }],
  } }, 'wf-story'), /VIDEO_CONCAT_QUALITY_REQUIRED/)
  assert.throws(() => requireConcatCurrentAcceptance({ ...uncertain, storyMediaReview: {
    ...uncertain.storyMediaReview, vocalEvidence: { ...uncertain.storyMediaReview.vocalEvidence,
      sourceVideoSha256: 'b'.repeat(64) },
  } }, 'wf-story'), /VIDEO_CONCAT_QUALITY_REQUIRED/)
})

test('stage concat retains Sanguo quality acceptance and rejects unreviewed URLs', () => {
  assert.deepEqual(requireConcatCurrentAcceptance({ url: '/generated/sanguo.mp4', passed: true,
    qualityReview: { canProceed: true } }), {})
  assert.throws(() => requireConcatCurrentAcceptance({ url: '/generated/old-story.mp4', passed: true,
    qualityReview: { canProceed: true } }, 'wf-story'), /VIDEO_CONCAT_QUALITY_REQUIRED/)
  assert.throws(() => requireConcatCurrentAcceptance({ url: '/generated/unreviewed.mp4' }), /VIDEO_CONCAT_QUALITY_REQUIRED/)
})
