import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { assertFreshA8B6CompositeReviewChainV3 } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'
import { freshA8B6FrameReviewPromptV3,
  freshA8B6PlaybackChecksV3 } from
  '../server/staged-scene-cut-a8b6-fresh-review-v3.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const signed = (value, label) => ({ value, sha256: hash(label) })
const planId = hash('retake-plan')
const first = { role: 'first_frame',
  source: { url: '/generated/V9.png', sha256: hash('V9 PNG') },
  transport: { url: '/generated/V9-compact.jpg',
    sha256: hash('V9 compact JPEG') } }
const manifest = { source: {
  approvedFirstFrameSha256: first.source.sha256 },
compactTransport: { entries: [first] } }

function chain(phase) {
  const videoSha256 = hash(`native ${phase}`)
  const media = { taskId: `native-task-${phase}`,
    videoUrl: `/generated/native-${phase}.mp4`, videoSha256,
    nativeFrameDigestSha256: hash(`native digest ${phase}`),
    nativeLastPts: phase === 'A' ? 8 : 6 }
  const mediaSha256 = hash(`media receipt ${phase}`)
  const frames = phase === 'A'
    ? [{ kind: 'approved-new-first-frame', phase: 'CERT',
      frameIndex: -1, url: first.transport.url,
      sha256: first.transport.sha256,
      sourceOriginal: { url: first.source.url,
        sha256: first.source.sha256 } },
    ...[0, 144, 180, 192].map(index => ({
      kind: 'provider-native-frame', phase, frameIndex: index,
      url: `/generated/A-f${index}.jpg`, sha256: hash(`A-f${index}`),
      sourceVideoSha256: videoSha256 }))]
    : [{ kind: 'accepted-A-native-tail', phase: 'A',
      frameIndex: 192, url: '/generated/A-tail.jpg',
      sha256: hash('accepted A tail'),
      sourceVideoSha256: hash('native A') },
    ...[0, 1, 120, 144].map(index => ({
      kind: 'provider-native-frame', phase, frameIndex: index,
      url: `/generated/B-f${index}.jpg`, sha256: hash(`B-f${index}`),
      sourceVideoSha256: videoSha256 }))]
  const evidence = signed({
    version: 'staged-a8b6-fresh-native-review-evidence-v1', planId,
    phase, taskId: media.taskId, videoSha256, mediaSha256,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    frames, reviewImages: frames.map(frame => frame.url),
  }, `${phase} evidence v1`)
  const v3Evidence = signed({ ...evidence.value,
    version: 'staged-a8b6-fresh-native-review-evidence-v3',
    priorV1EvidenceSha256: evidence.sha256 }, `${phase} evidence v3`)
  const promptSha256 = hash(freshA8B6FrameReviewPromptV3(phase,
    v3Evidence.value))
  const requestKey = `staged-a8b6-fresh-frame-v3:${planId}:${phase}:${videoSha256}:uuid`
  const intent = signed({
    version: 'staged-a8b6-fresh-frame-model-intent-v3',
    planId, phase, videoSha256, evidenceSha256: v3Evidence.sha256,
    modelId: 'independent-vision-model', promptSha256, requestKey,
  }, `${phase} intent`)
  const submit = signed({
    version: 'staged-a8b6-fresh-frame-model-submit-v3',
    planId, phase, intentSha256: intent.sha256, requestKey,
  }, `${phase} submit`)
  const audio = signed({
    version: 'staged-a8b6-fresh-audio-isolation-v3',
    planId, phase, taskId: media.taskId, videoUrl: media.videoUrl,
    videoSha256, mediaSha256,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    status: 'no-audio-stream', witness: {
      probe: 'ffmpeg-static-all-streams-f32le-v1',
      probedStreamCount: 0, streams: [] },
  }, `${phase} audio`)
  const executionId = `model-run-${phase}`
  const ledgerSha256 = hash(`${phase} model ledger`)
  const direct = signed({
    version: 'staged-a8b6-fresh-playback-review-v3',
    planId, phase, videoSha256, mediaSha256,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    evidenceSha256: v3Evidence.sha256,
    frameModelExecutionId: executionId,
    frameModelLedgerSha256: ledgerSha256,
    audioIsolationSha256: audio.sha256,
    reviewMethod: 'agent-direct-normal-speed-watch',
    reviewer: 'Codex', verdict: 'accept',
    playback: { surface: 'browser-1x-session',
      sourceUrl: media.videoUrl,
      viewerUrl: `http://127.0.0.1:5173${media.videoUrl}`,
      sourceVideoSha256: videoSha256, rate: 1,
      startSeconds: 0, endSeconds: media.nativeLastPts,
      continuous: true, observedAt: '2026-09-30T12:00:00.000Z' },
    checks: Object.fromEntries(freshA8B6PlaybackChecksV3(phase)
      .map(name => [name, true])),
    observations: [0, media.nativeLastPts / 2, media.nativeLastPts]
      .map(timeSeconds => ({ timeSeconds,
        description: '连续原速播放画面中已逐段核对动作。' })),
    limitations: [], ...(phase === 'B'
      ? { seamVerdict: 'accept' } : {}),
  }, `${phase} direct`)
  const acceptance = signed({
    version: 'staged-a8b6-fresh-native-acceptance-v3',
    evidenceSha256: v3Evidence.sha256,
    directReview: { verdict: 'accept', reportSha256: direct.sha256,
      reviewerMethod: 'agent-direct-normal-speed-watch',
      playbackRate: 1 },
    frameModelReview: { verdict: 'accept', executionId,
      ledgerSha256, promptSha256, requestKey },
    audioIsolation: { verdict: 'accept', receiptSha256: audio.sha256 },
  }, `${phase} acceptance`)
  return { planId, phase, manifest, media, mediaSha256,
    acceptance, evidence, direct, v3Evidence, intent, submit, audio }
}

test('retake v3 synchronous composite lineage accepts signed A and B proof sets', () => {
  assert.equal(assertFreshA8B6CompositeReviewChainV3(chain('A')), true)
  assert.equal(assertFreshA8B6CompositeReviewChainV3(chain('B')), true)
})

test('retake v3 synchronous composite lineage rejects old image, audio and model substitutions', () => {
  const valid = chain('A')
  assert.throws(() => assertFreshA8B6CompositeReviewChainV3({
    ...valid, evidence: { ...valid.evidence,
      value: { ...valid.evidence.value,
        frames: [{ ...valid.evidence.value.frames[0],
          url: first.source.url }, ...valid.evidence.value.frames.slice(1)] } },
  }), /v3 independent proof changed/)
  assert.throws(() => assertFreshA8B6CompositeReviewChainV3({
    ...valid, audio: { ...valid.audio, sha256: hash('different audio') },
  }), /v3 independent proof changed/)
  assert.throws(() => assertFreshA8B6CompositeReviewChainV3({
    ...valid, audio: { ...valid.audio, value: { ...valid.audio.value,
      witness: { ...valid.audio.value.witness,
        probedStreamCount: 1 } } },
  }), /v3 independent proof changed/)
  assert.throws(() => assertFreshA8B6CompositeReviewChainV3({
    ...valid, submit: { ...valid.submit, value: { ...valid.submit.value,
      intentSha256: hash('old intent') } },
  }), /v3 independent proof changed/)
  assert.throws(() => assertFreshA8B6CompositeReviewChainV3({
    ...valid, direct: { ...valid.direct, value: { ...valid.direct.value,
      playback: { ...valid.direct.value.playback, continuous: false } } },
  }), /truthful full-speed watch/)
})
