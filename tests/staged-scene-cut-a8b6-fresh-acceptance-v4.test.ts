import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { assertFreshA8B6PlaybackReportV4,
  buildFreshA8B6AcceptanceV4,
  freshA8B6PlaybackChecksV4 } from
  '../server/staged-scene-cut-a8b6-fresh-acceptance-v4.mjs'
import { assertFreshA8B6CompositeReviewChainV4 } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'
import { B3_FRAME_V4_RECOVERY,
  buildFreshA8B6ReviewEvidenceV4,
  freshA8B6FrameReviewPromptV4 } from
  '../server/staged-scene-cut-a8b6-fresh-review-v4.mjs'
import { freshA8B6FrameReviewPromptV3 } from
  '../server/staged-scene-cut-a8b6-fresh-review-v3.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const signed = (value, digest) => ({ value, sha256: digest ?? sha(JSON.stringify(value)) })
const pinned = B3_FRAME_V4_RECOVERY
const image = index => ({ kind: 'provider-native-frame', phase: 'B',
  frameIndex: index, url: `/generated/B3-f${index}.jpg`,
  sha256: sha(`B3 native ${index}`),
  sourceVideoSha256: pinned.videoSha256 })

function reviewChain() {
  const planId = pinned.planId, phase = 'B'
  const media = { taskId: 'B3-task-934096978895081552',
    videoUrl: '/generated/B3.mp4',
    videoSha256: pinned.videoSha256,
    nativeFrameDigestSha256: sha('B3 native frames'),
    nativeLastFrameIndex: 144, nativeLastPts: 6 }
  const mediaSha256 = sha('B3 media receipt')
  const source = { version: 'staged-a8b6-fresh-native-review-evidence-v3',
    planId, phase, taskId: media.taskId,
    videoSha256: media.videoSha256, mediaSha256,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    priorV1EvidenceSha256: sha('B3 v1 evidence'),
    frames: [{ kind: 'accepted-A-native-tail', phase: 'A',
      frameIndex: 192, url: '/generated/accepted-A-tail.jpg',
      sha256: sha('accepted A tail') },
    ...[0, 1, 84, 108, 120, 132, 144].map(image)] }
  source.reviewImages = source.frames.map(frame => frame.url)
  const evidence = signed({ ...source,
    version: 'staged-a8b6-fresh-native-review-evidence-v1',
    priorV1EvidenceSha256: undefined },
  source.priorV1EvidenceSha256)
  const v3Evidence = signed(source, pinned.v3EvidenceSha256)
  const priorV3 = { executionId: pinned.v3ExecutionId,
    ledgerSha256: pinned.v3LedgerSha256,
    intentSha256: pinned.v3IntentSha256,
    submitSha256: pinned.v3SubmitSha256,
    evidenceSha256: pinned.v3EvidenceSha256,
    reportSha256: sha('uncertain B3 marker report') }
  const v3Intent = signed({
    version: 'staged-a8b6-fresh-frame-model-intent-v3',
    planId, phase, videoSha256: media.videoSha256,
    evidenceSha256: v3Evidence.sha256,
    promptSha256: sha(freshA8B6FrameReviewPromptV3(phase, source)),
    requestKey: `staged-a8b6-fresh-frame-v3:${planId}:B:${media.videoSha256}:uuid`,
  }, pinned.v3IntentSha256)
  const v3Submit = signed({
    version: 'staged-a8b6-fresh-frame-model-submit-v3',
    planId, phase, intentSha256: v3Intent.sha256,
    requestKey: v3Intent.value.requestKey,
  }, pinned.v3SubmitSha256)
  const v4Evidence = signed(buildFreshA8B6ReviewEvidenceV4(
    source, priorV3))
  const v4Intent = signed({
    version: 'staged-a8b6-fresh-frame-model-intent-v4',
    planId, phase, videoSha256: media.videoSha256,
    evidenceSha256: v4Evidence.sha256, priorV3,
    promptSha256: sha(freshA8B6FrameReviewPromptV4(v4Evidence.value)),
    modelId: 'codex-local-vision',
    requestKey: `staged-a8b6-fresh-frame-v4:${planId}:B:${media.videoSha256}:uuid`,
  })
  const v4Submit = signed({
    version: 'staged-a8b6-fresh-frame-model-submit-v4',
    planId, phase, intentSha256: v4Intent.sha256,
    requestKey: v4Intent.value.requestKey,
  })
  const audio = signed({
    version: 'staged-a8b6-fresh-audio-isolation-v3',
    planId, phase, taskId: media.taskId,
    videoUrl: media.videoUrl, videoSha256: media.videoSha256,
    mediaSha256,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    status: 'no-audio-stream', witness: {
      probe: 'ffmpeg-static-all-streams-f32le-v1',
      probedStreamCount: 0, streams: [] },
  })
  const model = { row: { id: 'model-run-B3-v4' }, accepted: true,
    evidenceSha256: v4Evidence.sha256, priorV3,
    ledgerSha256: sha('B3 v4 accepted model ledger'),
    promptSha256: v4Intent.value.promptSha256,
    requestKey: v4Intent.value.requestKey }
  const direct = signed({
    version: 'staged-a8b6-fresh-playback-review-v4',
    planId, phase, videoSha256: media.videoSha256, mediaSha256,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    evidenceSha256: v4Evidence.sha256,
    frameModelExecutionId: model.row.id,
    frameModelLedgerSha256: model.ledgerSha256,
    audioIsolationSha256: audio.sha256,
    reviewMethod: 'agent-direct-normal-speed-watch',
    reviewer: 'Codex', verdict: 'accept',
    playback: { surface: 'browser-1x-session',
      sourceUrl: media.videoUrl,
      viewerUrl: `http://127.0.0.1:5173${media.videoUrl}`,
      sourceVideoSha256: media.videoSha256, rate: 1,
      startSeconds: 0, endSeconds: media.nativeLastPts,
      continuous: true, observedAt: '2026-09-30T12:00:00.000Z' },
    checks: Object.fromEntries(freshA8B6PlaybackChecksV4()
      .map(name => [name, true])),
    observations: [0, 3, 6].map(timeSeconds => ({ timeSeconds,
      description: '原速播放中逐段核对了张飞走近、停步及末秒姿态。' })),
    limitations: [], seamVerdict: 'accept',
  })
  const native = { lastFrameIndex: 144, lastPts: 6,
    frameDigestSha256: media.nativeFrameDigestSha256 }
  const seam = { phaseAFrameIndex: 192,
    phaseAFrameSha256: sha('accepted A tail'),
    phaseBFirstFrameIndex: 0,
    phaseBFirstFrameSha256: sha('B3 native 0'),
    stitchedPhaseBStartFrameIndex: 1,
    stitchedPhaseBFirstFrameSha256: sha('B3 native 1'),
    directVerdict: 'accept' }
  const acceptance = signed(buildFreshA8B6AcceptanceV4({ planId, phase,
    media, mediaSha256, native, evidenceSha256: v4Evidence.sha256,
    model, audioIsolationSha256: audio.sha256,
    reportSha256: direct.sha256,
    acceptedFrameSha256: sha('B3 native 144'), seam }))
  return { planId, phase,
    manifest: { version: 'staged-a8b6-fresh-A-plan-v3' },
    media, mediaSha256, acceptance, evidence, direct,
    v3Evidence, v3Intent, v3Submit, v4Evidence, v4Intent, v4Submit,
    audio }
}

test('B3 v4 acceptance binds the prior uncertain ledger and independent proofs', () => {
  const chain = reviewChain()
  assert.equal(assertFreshA8B6CompositeReviewChainV4(chain), true)
  assert.equal(chain.acceptance.value.evidenceSha256,
    chain.v4Evidence.sha256)
  assert.equal(chain.acceptance.value.priorV3.ledgerSha256,
    pinned.v3LedgerSha256)
})

test('B3 v4 watch requires guards at watch posts and rejects old withdrawal check', () => {
  const chain = reviewChain()
  const context = { planId: chain.planId, phase: 'B',
    media: chain.media, mediaSha256: chain.mediaSha256,
    native: { frameDigestSha256: chain.media.nativeFrameDigestSha256,
      lastPts: chain.media.nativeLastPts },
    evidenceSha256: chain.v4Evidence.sha256,
    model: { row: { id: chain.acceptance.value.frameModelReview.executionId },
      ledgerSha256: chain.acceptance.value.frameModelReview.ledgerSha256 },
    audioIsolationSha256: chain.audio.sha256 }
  assert.equal(assertFreshA8B6PlaybackReportV4(chain.direct.value, context), true)
  assert.throws(() => assertFreshA8B6PlaybackReportV4({
    ...chain.direct.value,
    checks: { ...chain.direct.value.checks,
      guardsContinueWithdrawalWithoutRegrab: true },
  }, context), /guards holding watch posts/)
  assert.throws(() => assertFreshA8B6PlaybackReportV4({
    ...chain.direct.value,
    checks: { ...chain.direct.value.checks,
      guardsRemainAtWatchPostsWithoutContact: false },
  }, context), /guards holding watch posts/)
  assert.throws(() => assertFreshA8B6PlaybackReportV4({
    ...chain.direct.value,
    version: 'staged-a8b6-fresh-playback-review-v3',
  }, context), /guards holding watch posts/)
})

test('B3 v4 composite rejects missing v3 provenance or changed sampled facts', () => {
  const chain = reviewChain()
  assert.throws(() => assertFreshA8B6CompositeReviewChainV4({
    ...chain, v3Submit: { ...chain.v3Submit,
      sha256: sha('another v3 submit') } }), /v4.*chain changed/)
  assert.throws(() => assertFreshA8B6CompositeReviewChainV4({
    ...chain, v4Evidence: { ...chain.v4Evidence,
      value: { ...chain.v4Evidence.value,
        frames: chain.v4Evidence.value.frames.slice(1) } } }),
  /five native JPEG|v4.*chain changed/)
})

test('B3 v4 composite still requires a continuous 1x watch and source mute', () => {
  const chain = reviewChain()
  assert.throws(() => assertFreshA8B6CompositeReviewChainV4({
    ...chain, direct: { ...chain.direct,
      value: { ...chain.direct.value,
        playback: { ...chain.direct.value.playback, continuous: false } } },
  }), /truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6CompositeReviewChainV4({
    ...chain, audio: { ...chain.audio,
      value: { ...chain.audio.value,
        status: 'decoded-silence' } } }), /v4.*chain changed/)
})

test('v4 acceptance builder rejects another plan and a rejected clarification', () => {
  const chain = reviewChain()
  assert.throws(() => buildFreshA8B6AcceptanceV4({
    planId: sha('other plan'), phase: 'B', media: chain.media,
  }), /exact B3 plan/)
  const context = { planId: chain.planId, phase: 'B',
    media: chain.media, mediaSha256: chain.mediaSha256,
    native: { lastFrameIndex: 144, lastPts: 6,
      frameDigestSha256: chain.media.nativeFrameDigestSha256 },
    evidenceSha256: chain.v4Evidence.sha256,
    model: { row: { id: 'model-run-rejected' }, accepted: false,
      evidenceSha256: chain.v4Evidence.sha256,
      priorV3: chain.v4Evidence.value.priorV3,
      ledgerSha256: sha('rejected'),
      promptSha256: chain.v4Intent.value.promptSha256,
      requestKey: chain.v4Intent.value.requestKey },
    audioIsolationSha256: chain.audio.sha256,
    reportSha256: chain.direct.sha256,
    acceptedFrameSha256: sha('B3 native 144'),
    seam: chain.acceptance.value.seam }
  assert.throws(() => buildFreshA8B6AcceptanceV4(context),
    /lacks exact B3 native/)
})
