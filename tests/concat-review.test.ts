import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateConcatReviews } from '../src/concat-review.ts'

const pending = { status: 'uncertain', method: 'manual-review-pending', speechVerified: false, lipSyncVerified: false }
const binding = { status: 'passed', method: 'automatic-binding-fallback', note: '仅输入绑定，并未听审' }
const quality = { status: 'needs_attention', canProceed: true, principleIssues: [{ problem: '群体发音待复核' }], warnings: ['可自主重拍'] }
const current = { url: '/generated/scene-15.mp4', qualityDisposition: 'manual-review-v1', voiceConsistency: pending, qualityReview: quality,
  qualityWarnings: ['画面需用户判断'], generationScopeId: 'rerun-scope', requestScopeId: 'original-voices', nativeGroupVoices: [{ name: '信众', status: 'unbound' }] }

test('legacy concat prefixes become explicitly unknown and cannot inherit a current clip voice pass', () => {
  const previousVideo = { url: '/generated/stage-14.mp4', clips: [{ url: '/generated/first.mp4' }, { url: '/generated/second.mp4' }],
    voiceConsistency: binding, qualityReview: { status: 'passed' }, qualityWarnings: ['旧前缀未定位的建议'] }
  const params = { previousVideo, currentVideo: { ...current, voiceConsistency: binding }, generationScopeId: 'new-stage' }
  const before = structuredClone(params)
  const output = aggregateConcatReviews(params, [...previousVideo.clips, { url: current.url, sha256: 'actual-hash' }])
  assert.equal(output.voiceConsistency.status, 'uncertain')
  assert.equal(output.voiceConsistency.fullVideoListened, false)
  assert.equal(output.voiceConsistency.unknownClipCount, 2)
  assert.deepEqual(output.clipReviews.slice(0, 2).map(clip => clip.voiceConsistency.status), ['uncertain', 'uncertain'])
  assert.deepEqual(output.clipReviews.slice(0, 2).map(clip => clip.qualityReview.status), ['unavailable', 'unavailable'])
  assert.deepEqual(output.clipReviews[2].voiceConsistency, binding)
  assert.equal(output.clipReviews[2].sourceSha256, 'actual-hash')
  assert.equal(output.generationScopeId, 'new-stage')
  assert.equal(output.requestScopeId, 'original-voices')
  assert.ok(output.qualityWarnings.includes('旧前缀未定位的建议'))
  assert.deepEqual(params, before)
})

test('later narrator pass preserves earlier native group uncertainty, quality advice and generation identity', () => {
  const first = aggregateConcatReviews({ currentVideo: current }, [{ url: current.url }])
  const later = { url: '/generated/scene-18.mp4', voiceConsistency: binding, qualityReview: { status: 'passed', canProceed: true, principleIssues: [], warnings: [] } }
  const result = aggregateConcatReviews({ previousVideo: { ...first, clips: [{ url: current.url }] }, currentVideo: later }, [{ url: current.url }, { url: later.url }])
  assert.equal(result.voiceConsistency.status, 'uncertain')
  assert.deepEqual(result.clipReviews[0].voiceConsistency, pending)
  assert.deepEqual(result.clipReviews[0].qualityReview, quality)
  assert.deepEqual(result.clipReviews[0].nativeGroupVoices, current.nativeGroupVoices)
  assert.equal(result.clipReviews[0].generationScopeId, current.generationScopeId)
  assert.equal(result.qualityDisposition, 'manual-review-v1')
  assert.equal(result.qualityReview.status, 'needs_attention')
  assert.equal(result.qualityReview.fullVideoWatched, false)
  assert.ok(result.qualityWarnings.length >= 2)
  let prefix = { ...result, clips: [{ url: current.url }, { url: later.url }] }
  for (let index = 0; index < 10; index++) {
    const next = { ...later, url: `/generated/extra-${index}.mp4` }
    const clips = [...prefix.clips, { url: next.url }]
    prefix = { ...aggregateConcatReviews({ previousVideo: prefix, currentVideo: next }, clips), clips }
  }
  assert.equal(prefix.qualityWarnings.length, result.qualityWarnings.length, 'prefix advice must not multiply on each later concat')
})

test('advisory duration risks stay attached to their source clip in rolling concat', () => {
  const risk = { code: 'duration_completion_unverified', beatId: 'bind', evidenceRef: '/generated/source-evidence.json' }
  const first = aggregateConcatReviews({ currentVideo: { ...current, qualityRisks: [risk] } }, [{ url: current.url }])
  const later = aggregateConcatReviews({ previousVideo: { ...first, clips: [{ url: current.url }] },
    currentVideo: { ...current, url: '/generated/later.mp4' } }, [{ url: current.url }, { url: '/generated/later.mp4' }])
  assert.deepEqual(later.clipReviews[0].qualityRisks, [risk])
  assert.equal(later.clipReviews[1].qualityRisks, undefined)
})

test('even individual user-listening passes do not certify the whole assembly; stale attribution remains unknown', () => {
  const passed = { status: 'passed', method: 'user-listening', note: '已听本段' }
  const result = aggregateConcatReviews({ currentVideo: { ...current, voiceConsistency: passed } }, [{ url: current.url }])
  assert.equal(result.voiceConsistency.individuallyListenedCount, 1)
  assert.equal(result.voiceConsistency.status, 'uncertain')
  const stale = aggregateConcatReviews({ previousVideo: { ...result, clips: [{ url: '/generated/replaced.mp4' }] } }, [{ url: '/generated/replaced.mp4' }])
  assert.equal(stale.voiceConsistency.unknownClipCount, 1)
  assert.equal(stale.clipReviews[0].qualityReview.status, 'unavailable')
})

test('speech failure, line attribution and original audio observations survive later rolling concats', () => {
  const audioEvidenceAssessment = { version: 'speech-evidence-assessment-v1', speechVerified: false, speakerIdentityVerified: false,
    lineChecks: [{ beatId: 'response', actorIds: ['crowd'], text: '出发', status: 'uncertain' }] }
  const source = { ...current, duration: 9.04, audioEvidenceAssessment,
    speechValidation: { passed: false, issues: ['第二句末字未确认'], dialogueCompletenessVerified: false, alignment: [{ rawUtteranceCandidate: { words: ['large raw evidence'] } }] },
    transcript: [{ start: 1, end: 2, text: '出发', words: [{ word: '出' }] }] }
  const first = aggregateConcatReviews({ currentVideo: source }, [{ url: source.url }])
  const next = { ...current, url: '/generated/next.mp4' }
  const result = aggregateConcatReviews({ previousVideo: { ...first, clips: [{ url: source.url }] }, currentVideo: next }, [{ url: source.url }, { url: next.url }])
  assert.deepEqual(result.clipReviews[0].audioEvidenceAssessment, audioEvidenceAssessment)
  assert.deepEqual(result.clipReviews[0].speechValidation, { passed: false, issues: ['第二句末字未确认'], dialogueCompletenessVerified: false })
  assert.deepEqual(result.clipReviews[0].transcript, [{ start: 1, end: 2, text: '出发' }])
  assert.equal(result.clipReviews[0].duration, 9.04)
})

test('a changed source hash cannot inherit a same-URL listening pass', () => {
  const first = aggregateConcatReviews({ currentVideo: { ...current, voiceConsistency: { method: 'user-listening', status: 'passed' } } }, [{ url: current.url, sha256: 'old' }])
  const result = aggregateConcatReviews({ previousVideo: { ...first, clips: [{ url: current.url }] } }, [{ url: current.url, sha256: 'new' }])
  assert.equal(result.clipReviews[0].voiceConsistency.method, 'not-reviewed')
  assert.equal(result.clipReviews[0].qualityReview.status, 'unavailable')
  assert.equal(result.clipReviews[0].sourceSha256, 'new')
  assert.equal(result.clipReviews[0].qualityWarnings[0].code, 'source_bytes_changed')
})

test('story beat review remains attached to its clip across staged assemblies', () => {
  const firstUrl = '/generated/story-one.mp4'
  const secondUrl = '/generated/story-two.mp4'
  const first = aggregateConcatReviews({ currentVideo: { url: firstUrl, storyMediaReview: {
    version: 'story-shot-media-review-v1', passed: true, reviewStatus: 'passed',
    videoEvidence: { url: firstUrl, sha256: 'hash-one', evidenceUrl: '/generated/first-evidence.json' },
    observations: { frames: Array(24).fill('large source observations') },
  } } }, [{ url: firstUrl, sha256: 'hash-one' }])
  const second = aggregateConcatReviews({ previousVideo: { ...first, clips: [{ url: firstUrl, sha256: 'hash-one' }] },
    currentVideo: { url: secondUrl } }, [{ url: firstUrl, sha256: 'hash-one' }, { url: secondUrl, sha256: 'hash-two' }])
  assert.deepEqual(second.clipReviews[0].storyMediaReview, {
    version: 'story-shot-media-review-v1', passed: true, reviewStatus: 'passed', issues: [],
    videoEvidence: { url: firstUrl, sha256: 'hash-one', evidenceUrl: '/generated/first-evidence.json' },
  })
  assert.equal(second.qualityReview.fullVideoWatched, false)
  assert.equal(second.voiceConsistency.fullVideoListened, false)
})

test('uncertain story review keeps its concrete doubts in the staged preview', () => {
  const url = '/generated/uncertain-story.mp4'
  const issue = '卡片接触关系被遮挡'
  const result = aggregateConcatReviews({ currentVideo: { url, storyMediaReview: {
    version: 'story-shot-media-review-v1', passed: false, reviewStatus: 'uncertain',
    issues: [issue], videoEvidence: { url, sha256: 'same', evidenceUrl: '/generated/report.json' },
  } } }, [{ url, sha256: 'same' }])
  assert.deepEqual(result.clipReviews[0].storyMediaReview.issues, [issue])
  assert.ok(result.qualityWarnings.some(warning =>
    typeof warning === 'object' && warning !== null && warning.warning?.problem === issue))
})
