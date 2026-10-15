import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertFreshA8B6FrameReviewSubmitBindingV3,
  assertFreshA8B6FrameModelLedgerV3,
  assertFreshA8B6JpegReviewImagesV3,
  assertFreshA8B6PlaybackReportV3,
  buildFreshA8B6ReviewEvidenceV3,
  freshA8B6FrameChecksV3,
  freshA8B6FrameReviewPromptV3,
  freshA8B6PlaybackChecksV3,
  freshA8B6RequiredObservationsV3,
} from '../server/staged-scene-cut-a8b6-fresh-review-v3.mjs'

const planId = 'a'.repeat(64)
const videoSha256 = 'b'.repeat(64)
const evidence = { planId, phase: 'A', videoSha256,
  mediaSha256: 'c'.repeat(64),
  frames: [
    { phase: 'CERT', frameIndex: -1, sha256: 'd'.repeat(64),
      url: '/generated/compact.jpg' },
    { phase: 'A', frameIndex: 0, sha256: 'e'.repeat(64),
      url: '/generated/A-f0.jpg' },
    { phase: 'A', frameIndex: 144, sha256: '1'.repeat(64),
      url: '/generated/A-f144.jpg' },
    { phase: 'A', frameIndex: 180, sha256: '2'.repeat(64),
      url: '/generated/A-f180.jpg' },
    { phase: 'A', frameIndex: 186, sha256: '3'.repeat(64),
      url: '/generated/A-f186.jpg' },
    { phase: 'A', frameIndex: 192, sha256: 'f'.repeat(64),
      url: '/generated/A-f192.jpg' },
  ],
  reviewImages: ['/generated/compact.jpg', '/generated/A-f0.jpg',
    '/generated/A-f144.jpg', '/generated/A-f180.jpg',
    '/generated/A-f186.jpg', '/generated/A-f192.jpg'] }
const intent = { modelId: 'codex-local-vision',
  requestKey: `staged-a8b6-fresh-frame-v3:${planId}:A:${videoSha256}:uuid` }
const frameChecks = Object.fromEntries(freshA8B6FrameChecksV3('A')
  .map(name => [name, true]))
const report = { version: 'staged-a8b6-fresh-frame-review-v3',
  phase: 'A', videoSha256, decision: 'accept', checks: frameChecks,
  observations: evidence.frames.map(frame => ({ phase: frame.phase,
    frameIndex: frame.frameIndex,
    description: '样本画面可见人物站位和双腕之间的完整绳结。' })),
  issues: [] }
const row = { id: 'model-run-frame-v3', channel: 'workflow',
  workflow_id: 'wf-sanguo-history-drama',
  node_id: 'staged-a8b6-fresh-frame-review-v3',
  model_id: 'codex-local-vision', capability: 'text', provider: 'Codex',
  status: 'succeeded', request_data: {
    operation: 'history.media-review', requestKey: intent.requestKey,
    prompt: freshA8B6FrameReviewPromptV3('A', evidence),
    params: { reviewImages: evidence.reviewImages },
    reviewImageHashes: evidence.frames.map(frame => ({
      url: frame.url, sha256: frame.sha256 })) },
  response_data: JSON.stringify(report) }

test('v3 preverified intent can be reused only with its exact signed submit binding', () => {
  const intentSha256 = '6'.repeat(64)
  const submit = { version: 'staged-a8b6-fresh-frame-model-submit-v3',
    planId, phase: 'A', requestKey: intent.requestKey,
    intentSha256, createdAt: '2026-09-30T10:00:00.000Z' }
  assert.equal(assertFreshA8B6FrameReviewSubmitBindingV3(submit,
    planId, 'A', intent, intentSha256), true)
  assert.throws(() => assertFreshA8B6FrameReviewSubmitBindingV3({
    ...submit, intentSha256: '7'.repeat(64) }, planId,
  'A', intent, intentSha256), /submission changed/)
  assert.throws(() => assertFreshA8B6FrameReviewSubmitBindingV3({
    ...submit, requestKey: 'another-request' }, planId,
  'A', intent, intentSha256), /submission changed/)
})

test('v3 model contract contains only sampled-frame facts and keeps actual tail knot hard', () => {
  assert.ok(!freshA8B6FrameChecksV3('A')
    .includes('originalSpeedContinuousBinding'))
  assert.ok(!freshA8B6FrameChecksV3('A')
    .includes('noSpeechOrSpeechMouth'))
  assert.ok(freshA8B6FrameChecksV3('A')
    .includes('frontWristKnotCompletedByNativeTail'))
  const prompt = freshA8B6FrameReviewPromptV3('A', evidence)
  assert.match(prompt, /腰部缠绳或两手分开一律/)
  assert.match(prompt, /不要判定原速连续性、全程语言口型、声音/)
  assert.match(prompt, /A:f180 或 A:f186/)
  const checked = assertFreshA8B6FrameModelLedgerV3(row,
    'A', evidence, intent)
  assert.equal(checked.accepted, true)
  const negative = { ...row, response_data: JSON.stringify({ ...report,
    decision: 'revise', checks: { ...frameChecks,
      frontWristKnotCompletedByNativeTail: false },
    issues: [{ code: 'front_wrist_knot_incomplete' }] }) }
  assert.equal(assertFreshA8B6FrameModelLedgerV3(negative,
    'A', evidence, intent).accepted, false)
  assert.throws(() => assertFreshA8B6FrameModelLedgerV3({ ...row,
    response_data: JSON.stringify({ ...report,
      checks: { ...frameChecks, originalSpeedContinuousBinding: true } }) },
  'A', evidence, intent), /only sampled-frame facts/)
})

test('v3 observations require essential frames while allowing shorter exact sample reports', () => {
  assert.deepEqual(freshA8B6RequiredObservationsV3('A', evidence), [
    ['CERT:f-1'], ['A:f0'], ['A:f144'], ['A:f180', 'A:f186'],
    ['A:f192']])
  const selected = report.observations.filter(item =>
    item.frameIndex !== 186)
  const short = { ...row, response_data: JSON.stringify({ ...report,
    observations: selected }) }
  assert.equal(assertFreshA8B6FrameModelLedgerV3(short,
    'A', evidence, intent).accepted, true)
  for (const missing of [-1, 0, 144, 192]) {
    assert.throws(() => assertFreshA8B6FrameModelLedgerV3({ ...row,
      response_data: JSON.stringify({ ...report,
        observations: selected.filter(item =>
          item.frameIndex !== missing) }) }, 'A', evidence, intent),
    /only sampled-frame facts/)
  }
  const noLate = selected.filter(item => item.frameIndex !== 180)
  assert.throws(() => assertFreshA8B6FrameModelLedgerV3({ ...row,
    response_data: JSON.stringify({ ...report,
      observations: noLate }) }, 'A', evidence, intent),
  /only sampled-frame facts/)
  assert.throws(() => assertFreshA8B6FrameModelLedgerV3({ ...row,
    response_data: JSON.stringify({ ...report,
      observations: [...selected, selected[0]] }) },
  'A', evidence, intent), /only sampled-frame facts/)
  assert.throws(() => assertFreshA8B6FrameModelLedgerV3({ ...row,
    response_data: JSON.stringify({ ...report,
      observations: [...selected, { phase: 'A', frameIndex: 181,
        description: '未随附件提供的帧不能作为模型审核事实。' }] }) },
  'A', evidence, intent), /only sampled-frame facts/)
})

test('retake A live path admits only manifest compact JPEG bound to V9 PNG', () => {
  const first = { role: 'first_frame',
    source: { url: '/generated/V9.png', sha256: '7'.repeat(64) },
    transport: { url: '/generated/V9-compact.jpg',
      sha256: '8'.repeat(64) } }
  const manifest = { source: {
    approvedFirstFrameSha256: first.source.sha256 },
  compactTransport: { entries: [first,
    { role: 'identity_1' }, { role: 'identity_2' },
    { role: 'end_frame', transport: {
      url: '/generated/target-guide.jpg', sha256: '9'.repeat(64) } }] } }
  const frames = [{ kind: 'approved-new-first-frame', phase: 'CERT',
    frameIndex: -1, url: first.transport.url,
    sha256: first.transport.sha256,
    sourceOriginal: { url: first.source.url,
      sha256: first.source.sha256 } },
  { kind: 'provider-native-frame', phase: 'A', frameIndex: 0,
    url: '/generated/new-A-f0.jpg', sha256: 'a'.repeat(64),
    sourceVideoSha256: videoSha256 }]
  const live = { phase: 'A', videoSha256,
    frames, reviewImages: frames.map(frame => frame.url) }
  assert.equal(assertFreshA8B6JpegReviewImagesV3('A', live, manifest), true)
  const signedBody = buildFreshA8B6ReviewEvidenceV3({ ...live,
    version: 'staged-a8b6-fresh-native-review-evidence-v1',
    planId, taskId: 'new-A-task', mediaSha256: 'c'.repeat(64),
    nativeFrameDigestSha256: 'd'.repeat(64) }, 'e'.repeat(64))
  assert.equal(signedBody.version,
    'staged-a8b6-fresh-native-review-evidence-v3')
  assert.equal(signedBody.priorV1EvidenceSha256, 'e'.repeat(64))
  assert.deepEqual(signedBody.reviewImages, live.reviewImages)
  assert.throws(() => assertFreshA8B6JpegReviewImagesV3('A', {
    ...live, frames: [{ ...frames[0], url: first.source.url },
      frames[1]], reviewImages: [first.source.url, frames[1].url] },
  manifest), /signed local JPEG native frames/)
  assert.throws(() => assertFreshA8B6JpegReviewImagesV3('A', {
    ...live, frames: [{ ...frames[0], url: '/generated/target-guide.jpg' },
      frames[1]], reviewImages: ['/generated/target-guide.jpg',
      frames[1].url] }, manifest), /signed compact JPEG of the V9 PNG/)
})

test('v3 direct acceptance requires genuine claimed 1x browser playback and separate audio SHA', () => {
  const model = assertFreshA8B6FrameModelLedgerV3(row,
    'A', evidence, intent)
  const media = { videoUrl: '/generated/new-A.mp4', videoSha256 }
  const native = { lastPts: 8, frameDigestSha256: '1'.repeat(64) }
  const context = { planId, phase: 'A', media,
    mediaSha256: '2'.repeat(64), native,
    evidenceSha256: '3'.repeat(64), model,
    audioIsolationSha256: '4'.repeat(64) }
  const playbackChecks = Object.fromEntries(
    freshA8B6PlaybackChecksV3('A').map(name => [name, true]))
  const direct = { version: 'staged-a8b6-fresh-playback-review-v3',
    planId, phase: 'A', videoSha256,
    mediaSha256: context.mediaSha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    evidenceSha256: context.evidenceSha256,
    frameModelExecutionId: row.id,
    frameModelLedgerSha256: model.ledgerSha256,
    audioIsolationSha256: context.audioIsolationSha256,
    reviewMethod: 'agent-direct-normal-speed-watch',
    reviewer: 'Codex', verdict: 'accept',
    playback: { surface: 'browser-1x-session',
      sourceUrl: media.videoUrl,
      viewerUrl: 'http://127.0.0.1:5173/generated/new-A.mp4',
      sourceVideoSha256: videoSha256, rate: 1,
      startSeconds: 0, endSeconds: 8, continuous: true,
      observedAt: '2026-09-30T10:00:00.000Z' },
    checks: playbackChecks,
    observations: [0, 4, 8].map(timeSeconds => ({ timeSeconds,
      description: '原速连续播放时观察到人物动作和两腕绳结位置。' })),
    limitations: [] }
  assert.equal(assertFreshA8B6PlaybackReportV3(direct, context), true)
  assert.equal(assertFreshA8B6PlaybackReportV3({ ...direct,
    limitations: ['Mac QuickTime 锁屏不可用；IAB 浏览器已在 1× 连续播放。'] },
  context), true)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    playback: { ...direct.playback, continuous: false } }, context),
  /lacks truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    playback: { ...direct.playback,
      viewerUrl: 'http://127.0.0.1:5173/generated/old-A.mp4' } }, context),
  /lacks truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    audioIsolationSha256: '0'.repeat(64) }, context),
  /lacks truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    limitations: ['Mac 锁屏，未观看原速视频。'] }, context),
  /lacks truthful full-speed watch/)
})

test('B keeps exact A tail to B frame-one and temporal seam in separate gates', () => {
  assert.deepEqual(freshA8B6FrameChecksV3('B').slice(0, 2), [
    'acceptedATailMatchesBFrame0',
    'stitchedBFrame1VisuallyContinuous'])
  assert.ok(freshA8B6PlaybackChecksV3('B')
    .includes('actualATailToBFrame1AtOriginalSpeed'))
  assert.ok(freshA8B6PlaybackChecksV3('B')
    .includes('frontWristKnotRemainsVisibleThroughout'))
  assert.ok(freshA8B6PlaybackChecksV3('B')
    .includes('stableFinalSecond'))
  assert.ok(!freshA8B6FrameChecksV3('B')
    .includes('stableFinalSecond'))
})

test('B direct watch binds the new silent child video, exact duration and knot continuity', () => {
  const childPlanId = 'e'.repeat(64)
  const childVideoSha256 = 'f'.repeat(64)
  const media = { videoUrl: '/generated/new-child-B.mp4',
    videoSha256: childVideoSha256 }
  const native = { lastPts: 6, frameDigestSha256: '1'.repeat(64) }
  const context = { planId: childPlanId, phase: 'B', media,
    mediaSha256: '2'.repeat(64), native,
    evidenceSha256: '3'.repeat(64),
    model: { row: { id: 'model-run-child-B' },
      ledgerSha256: '4'.repeat(64) },
    audioIsolationSha256: '5'.repeat(64) }
  const checks = Object.fromEntries(freshA8B6PlaybackChecksV3('B')
    .map(name => [name, true]))
  const direct = { version: 'staged-a8b6-fresh-playback-review-v3',
    planId: childPlanId, phase: 'B', videoSha256: childVideoSha256,
    mediaSha256: context.mediaSha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    evidenceSha256: context.evidenceSha256,
    frameModelExecutionId: context.model.row.id,
    frameModelLedgerSha256: context.model.ledgerSha256,
    audioIsolationSha256: context.audioIsolationSha256,
    reviewMethod: 'agent-direct-normal-speed-watch',
    reviewer: 'Codex', verdict: 'accept',
    playback: { surface: 'browser-1x-session',
      viewerUrl: 'http://127.0.0.1:5174/generated/new-child-B.mp4',
      sourceUrl: media.videoUrl,
      sourceVideoSha256: childVideoSha256,
      rate: 1, startSeconds: 0, endSeconds: 6,
      continuous: true, observedAt: '2026-09-30T10:00:00.000Z' },
    checks, seamVerdict: 'accept',
    observations: [0, 3, 6].map(timeSeconds => ({ timeSeconds,
      description: '在原速连播时看见严颜两腕的绳结持续保留。' })),
    limitations: [] }
  assert.equal(assertFreshA8B6PlaybackReportV3(direct, context), true)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    checks: { ...checks, frontWristKnotRemainsVisibleThroughout: false } },
  context), /lacks truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    checks: { ...checks, guardsContinueWithdrawalWithoutRegrab: false } },
  context), /lacks truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    seamVerdict: 'revise' }, context), /lacks truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    playback: { ...direct.playback, endSeconds: 5.96 } }, context),
  /lacks truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    playback: { ...direct.playback,
      viewerUrl: 'http://127.0.0.1:5174/generated/failed-parent-B.mp4' } },
  context), /lacks truthful full-speed watch/)
  assert.throws(() => assertFreshA8B6PlaybackReportV3({ ...direct,
    audioIsolationSha256: '6'.repeat(64) }, context),
  /lacks truthful full-speed watch/)
})

test('B model observations cover A tail, seam, frame 120 and actual B tail', () => {
  const B = { ...evidence, phase: 'B', frames: [
    { phase: 'A', frameIndex: 192, sha256: '0'.repeat(64),
      url: '/generated/A-tail.jpg' },
    ...[0, 1, 48, 120, 144].map(index => ({ phase: 'B',
      frameIndex: index, sha256: `${index}`.padStart(64, '0'),
      url: `/generated/B-f${index}.jpg` })),
  ] }
  B.reviewImages = B.frames.map(frame => frame.url)
  const BIntent = { ...intent,
    requestKey: `staged-a8b6-fresh-frame-v3:${planId}:B:${videoSha256}:uuid` }
  const required = freshA8B6RequiredObservationsV3('B', B)
  assert.deepEqual(required, [['A:f192'], ['B:f0'], ['B:f1'],
    ['B:f120'], ['B:f144']])
  const observations = B.frames.filter(frame => frame.frameIndex !== 48)
    .map(frame => ({ phase: frame.phase, frameIndex: frame.frameIndex,
      description: '该附件可见人物与绳结的准确位置。' }))
  const BReport = { ...report, phase: 'B',
    checks: Object.fromEntries(freshA8B6FrameChecksV3('B')
      .map(name => [name, true])), observations }
  const BRow = { ...row, request_data: { ...row.request_data,
    requestKey: BIntent.requestKey,
    prompt: freshA8B6FrameReviewPromptV3('B', B),
    params: { reviewImages: B.reviewImages },
    reviewImageHashes: B.frames.map(frame => ({
      url: frame.url, sha256: frame.sha256 })) },
  response_data: JSON.stringify(BReport) }
  assert.equal(assertFreshA8B6FrameModelLedgerV3(BRow,
    'B', B, BIntent).accepted, true)
  assert.equal(assertFreshA8B6FrameModelLedgerV3({ ...BRow,
    response_data: JSON.stringify({ ...BReport, decision: 'revise',
      checks: { ...BReport.checks,
        frontWristKnotVisibleInAllSamples: false },
      issues: [{ code: 'front_wrist_knot_vanished' }] }) },
  'B', B, BIntent).accepted, false)
  assert.throws(() => assertFreshA8B6FrameModelLedgerV3({ ...BRow,
    response_data: JSON.stringify({ ...BReport,
      observations: observations.filter(item => item.frameIndex !== 1) }) },
  'B', B, BIntent), /only sampled-frame facts/)
})
