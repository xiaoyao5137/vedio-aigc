import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertFreshA8B6PhaseADirectRejection,
  assertFreshA8B6PhaseANegativeModelLedger,
  assertFreshA8B6PhaseARejectionRecovery,
  verifyFreshA8B6PhaseARejectionSync,
  REJECTED_A_PLAN_ID as planId,
  REJECTED_A_TASK_ID as taskId,
  REJECTED_A_VIDEO_SHA256 as videoSha256 } from
  '../server/staged-scene-cut-a8b6-fresh-A-rejection.mjs'
import { assertFreshA8B6JpegReviewRecovery,
  freshA8B6ReviewPrompt } from
  '../server/staged-scene-cut-a8b6-fresh-review.mjs'

const sha = (value: Buffer | string) => createHash('sha256')
  .update(value).digest('hex')
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const evidenceSha256 = 'e'.repeat(64)
const frames = [
  { kind: 'approved-new-first-frame', phase: 'CERT', frameIndex: -1,
    url: '/generated/first.jpg', sha256: 'a'.repeat(64) },
  { kind: 'provider-native-frame', phase: 'A', frameIndex: 144,
    url: '/generated/n144.jpg', sha256: 'b'.repeat(64),
    sourceVideoSha256: videoSha256 },
  { kind: 'provider-native-frame', phase: 'A', frameIndex: 192,
    url: '/generated/n192.jpg', sha256: 'c'.repeat(64),
    sourceVideoSha256: videoSha256 },
]
const evidence = { planId, phase: 'A', taskId, videoSha256,
  mediaSha256: 'd'.repeat(64), frames,
  reviewImages: frames.map(frame => frame.url) }
const direct = { version: 'staged-a8b6-fresh-native-frame-rejection-report-v1',
  planId, phase: 'A', taskId, videoSha256, evidenceSha256,
  verdict: 'reject', reviewMethod: 'native-frame-inspection',
  originalSpeedWatchPerformed: false, reviewer: 'Codex',
  reviewedAt: '2026-09-30T06:00:00.000Z',
  failedChecks: { frontWristKnotCompletedByNativeTail: false },
  observations: [
    { phase: 'A', frameIndex: 144, sha256: frames[1].sha256,
      description: '绳索横穿腹前，双腕仍在身体两侧，没有并拢。' },
    { phase: 'A', frameIndex: 192, sha256: frames[2].sha256,
      description: '双手分居两侧，身前无两腕之间可辨的完成绳结。' },
  ], limitations: ['Mac 锁屏；未进行原速视频观看。'] }

test('native A rejection is explicit about sampled frames and absent real-speed watch', () => {
  assert.equal(assertFreshA8B6PhaseADirectRejection(direct,
    evidence, evidenceSha256), true)
  assert.throws(() => assertFreshA8B6PhaseADirectRejection({ ...direct,
    reviewMethod: 'agent-direct-normal-speed-watch' }, evidence,
  evidenceSha256), /native-frame rejection evidence incomplete/)
  assert.throws(() => assertFreshA8B6PhaseADirectRejection({ ...direct,
    observations: [direct.observations[0], { ...direct.observations[1],
      sha256: '0'.repeat(64) }] }, evidence, evidenceSha256),
  /native-frame rejection evidence incomplete/)
})

test('v2 direct rejection binds prior PNG and reviewed JPEG without changing native frames', () => {
  const jpeg = { ...frames[0], url: '/generated/first-compact.jpg',
    sha256: '9'.repeat(64), sourceOriginal: {
      url: frames[0].url, sha256: frames[0].sha256 } }
  const recovered = { ...evidence,
    version: 'staged-a8b6-fresh-native-review-evidence-v2',
    priorV1EvidenceSha256: '8'.repeat(64),
    frames: [jpeg, ...frames.slice(1)],
    reviewImages: [jpeg.url, ...frames.slice(1).map(frame => frame.url)] }
  const report = { ...direct, evidenceRebinding: {
    version: 'jpeg-v2-format-recovery',
    priorV1EvidenceSha256: recovered.priorV1EvidenceSha256,
    certSourcePngSha256: jpeg.sourceOriginal.sha256,
    certTransportJpegSha256: jpeg.sha256 } }
  assert.equal(assertFreshA8B6PhaseADirectRejection(report,
    recovered, evidenceSha256), true)
  assert.throws(() => assertFreshA8B6PhaseADirectRejection({ ...report,
    evidenceRebinding: { ...report.evidenceRebinding,
      certSourcePngSha256: '0'.repeat(64) } },
  recovered, evidenceSha256), /native-frame rejection evidence incomplete/)
})

test('independent negative model ledger must see native attachments and fail wrist knot', () => {
  const report = { version: 'staged-a8b6-fresh-phase-review-v1',
    phase: 'A', videoSha256, decision: 'revise',
    checks: { frontWristKnotCompletedByNativeTail: false },
    issues: [{ code: 'front_wrist_knot_incomplete' }] }
  const row = { id: 'model-run-negative-A', channel: 'workflow',
    workflow_id: 'wf-sanguo-history-drama',
    node_id: 'staged-a8b6-fresh-phase-review', capability: 'text',
    provider: 'Codex', status: 'succeeded',
    request_data: { operation: 'history.media-review',
      requestKey: `staged-a8b6-fresh:${planId}:A:${videoSha256}:once`,
      prompt: freshA8B6ReviewPrompt('A', evidence),
      params: { reviewImages: evidence.reviewImages },
      reviewImageHashes: frames.map(frame => ({ url: frame.url,
        sha256: frame.sha256 })) },
    response_data: JSON.stringify(report) }
  const verified = assertFreshA8B6PhaseANegativeModelLedger(row,
    evidence, evidenceSha256)
  assert.equal(verified.decision, 'revise')
  assert.equal(verified.reportSha256, sha(canonical(report)))
  assert.throws(() => assertFreshA8B6PhaseANegativeModelLedger({ ...row,
    response_data: JSON.stringify({ ...report,
      checks: { frontWristKnotCompletedByNativeTail: true } }) },
  evidence, evidenceSha256), /did not reject the unfinished front wrist knot/)
  assert.throws(() => assertFreshA8B6PhaseANegativeModelLedger({ ...row,
    request_data: { ...row.request_data,
      reviewImageHashes: row.request_data.reviewImageHashes.map((item, index) =>
        index === 2 ? { ...item, sha256: '0'.repeat(64) } : item) } },
  evidence, evidenceSha256), /model attachment 2 differs/)
})

test('v2 rejection requires signed intent, one-shot submit and exact failed PNG ledger', () => {
  const legacyFrames = [{ ...frames[0], url: '/generated/first.png' },
    ...frames.slice(1)]
  const legacyEvidence = { ...evidence,
    version: 'staged-a8b6-fresh-native-review-evidence-v1',
    frames: legacyFrames, reviewImages: legacyFrames.map(frame => frame.url) }
  const oldIntent = { version: 'staged-a8b6-fresh-model-review-intent-v1',
    planId, phase: 'A', videoSha256, evidenceSha256,
    modelId: 'codex-local-vision',
    requestKey: `staged-a8b6-fresh:${planId}:A:${videoSha256}:old` }
  const oldRow = { id: 'model-run-format-fail', channel: 'workflow',
    workflow_id: 'wf-sanguo-history-drama',
    node_id: 'staged-a8b6-fresh-phase-review',
    model_id: 'codex-local-vision', capability: 'text', provider: 'Codex',
    status: 'failed',
    error: 'REVIEW_IMAGES_INVALID: 审查只接受 /generated/ 下的本地 JPEG 帧',
    request_data: { operation: 'history.media-review',
      requestKey: oldIntent.requestKey,
      prompt: `计划=${planId}，阶段=A，视频SHA256=${videoSha256}。CERT:f-1:${legacyFrames[0].sha256}`,
      params: { reviewImages: legacyEvidence.reviewImages } },
    response_data: {} }
  const oldIntentSha256 = '1'.repeat(64)
  const priorFailure = assertFreshA8B6JpegReviewRecovery({
    intent: oldIntent, intentSha256: oldIntentSha256,
    evidence: legacyEvidence, evidenceSha256,
    rows: [oldRow], modelId: 'codex-local-vision' })
  const modelRow = { ...oldRow, id: 'model-run-negative-v2',
    status: 'succeeded', error: null,
    request_data: { ...oldRow.request_data,
      requestKey: `staged-a8b6-fresh:${planId}:A:${videoSha256}:jpeg-v2:new` } }
  const recoveredEvidence = { ...legacyEvidence,
    version: 'staged-a8b6-fresh-native-review-evidence-v2',
    priorV1EvidenceSha256: evidenceSha256 }
  const recoveredEvidenceSha256 = '2'.repeat(64)
  const recoveredIntentSha256 = '3'.repeat(64)
  const submitSha256 = '4'.repeat(64)
  const recoveredIntent = {
    version: 'staged-a8b6-fresh-model-review-intent-v2',
    planId, phase: 'A', videoSha256,
    evidenceSha256: recoveredEvidenceSha256,
    modelId: 'codex-local-vision',
    requestKey: modelRow.request_data.requestKey,
    priorFailure, createdAt: '2026-09-30T00:00:00.000Z' }
  const submit = { version: 'staged-a8b6-fresh-model-review-submit-v2',
    planId, requestKey: recoveredIntent.requestKey,
    intentSha256: recoveredIntentSha256,
    createdAt: '2026-09-30T00:01:00.000Z' }
  const input = { priorEvidence: legacyEvidence, priorEvidenceSha256: evidenceSha256,
    priorIntent: oldIntent, priorIntentSha256: oldIntentSha256,
    recoveredEvidence, recoveredEvidenceSha256,
    recoveredIntent, recoveredIntentSha256, submit, submitSha256,
    modelRow, rows: [oldRow, modelRow] }
  assert.deepEqual(assertFreshA8B6PhaseARejectionRecovery(input), {
    intentSha256: recoveredIntentSha256, submitSha256, priorFailure })
  assert.throws(() => assertFreshA8B6PhaseARejectionRecovery({ ...input,
    rows: [oldRow, modelRow, { ...modelRow, id: 'another-success' }] }),
  /signed intent or one-shot submission/)
  assert.throws(() => assertFreshA8B6PhaseARejectionRecovery({ ...input,
    submit: { ...submit, requestKey: 'another-key' } }),
  /signed intent or one-shot submission/)
  assert.throws(() => assertFreshA8B6PhaseARejectionRecovery({ ...input,
    recoveredIntent: { ...recoveredIntent,
      priorFailure: { ...priorFailure,
        failedModelLedgerSha256: '0'.repeat(64) } } }),
  /lost exact failed-ledger ancestry/)
})

test('signed A rejection gate binds report, native frames, video and model failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'a8b6-A-reject-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = path.join(root, '.runtime/staged-scene-cut-a8b6-fresh', planId)
  await mkdir(folder, { recursive: true })
  await mkdir(path.join(root, 'public/generated'), { recursive: true })
  await mkdir(path.join(root, 'qa'), { recursive: true })
  const key = Buffer.alloc(32, 17)
  await writeFile(path.join(root, '.runtime/staged-scene-cut.key'), key)
  const signed = async (name: string, body: Record<string, unknown>) => {
    const signature = createHmac('sha256', key)
      .update(canonical(body)).digest('hex')
    const bytes = Buffer.from(JSON.stringify({ ...body, signature }, null, 2) + '\n')
    await writeFile(path.join(folder, name), bytes)
    return sha(bytes)
  }
  const manifestSha256 = await signed('manifest.json', { planId })
  const taskSha256 = await signed('phase-A-task.json', { taskId })
  const videoUrl = '/generated/old-A.mp4'
  const video = Buffer.from('paid archived source video')
  await writeFile(path.join(root, 'public', videoUrl.slice(1)), video)
  const nativeDigest = 'f'.repeat(64)
  const mediaSha256 = await signed('phase-A-media.json', { taskId,
    taskSha256, videoUrl, videoSha256,
    nativeFrameDigestSha256: nativeDigest,
    nativeFrameCount: 193, nativeLastFrameIndex: 192, nativeLastPts: 8 })
  const nativeFrames = frames.map(frame => frame.frameIndex < 0 ? frame : {
    ...frame, sha256: sha(Buffer.from(`native frame ${frame.frameIndex}`)) })
  const evidenceBody = { ...evidence, mediaSha256,
    nativeFrameDigestSha256: nativeDigest, frames: nativeFrames }
  const signedEvidenceSha256 = await signed('phase-A-review-evidence.json',
    evidenceBody)
  for (const frame of nativeFrames.slice(1)) await writeFile(
    path.join(root, 'public', frame.url.slice(1)),
    Buffer.from(`native frame ${frame.frameIndex}`))
  const reportFile = 'qa/old-A-rejection.json'
  const directReport = { ...direct, evidenceSha256: signedEvidenceSha256,
    observations: direct.observations.map(item => ({ ...item,
      sha256: nativeFrames.find(frame => frame.frameIndex
        === item.frameIndex)!.sha256 })) }
  const reportBytes = Buffer.from(JSON.stringify(directReport, null, 2) + '\n')
  await writeFile(path.join(root, reportFile), reportBytes)
  const modelReport = { version: 'staged-a8b6-fresh-phase-review-v1',
    decision: 'revise', checks: { frontWristKnotCompletedByNativeTail: false } }
  const rejection = { version: 'staged-a8b6-fresh-native-rejection-v1',
    planId, phase: 'A', taskId, videoUrl, videoSha256,
    mediaSha256, nativeFrameDigestSha256: nativeDigest,
    nativeFrameCount: 193, nativeLastFrameIndex: 192, nativeLastPts: 8,
    planManifestSha256: manifestSha256,
    evidenceSha256: signedEvidenceSha256,
    reportFile, reportSha256: sha(reportBytes),
    directReview: { verdict: 'reject', method: 'native-frame-inspection',
      originalSpeedWatchPerformed: false, reportSha256: sha(reportBytes),
      frameIndices: [144, 192] },
    modelReview: { executionId: 'model-run-negative-A',
      requestKey: `staged-a8b6-fresh:${planId}:A:${videoSha256}:once`,
      decision: 'revise', report: modelReport,
      reportSha256: sha(canonical(modelReport)),
      ledgerSha256: '1'.repeat(64), promptSha256: '2'.repeat(64) },
    failedChecks: { frontWristKnotCompletedByNativeTail: false },
    acceptanceState: 'rejected-native-A; no A tail may seed B' }
  await signed('phase-A-rejection.json', rejection)
  assert.throws(() => verifyFreshA8B6PhaseARejectionSync(planId, root),
    /rejected paid video bytes changed/)
  assert.notEqual(sha(video), videoSha256,
    'fixture cannot manufacture the production media hash')
  // Rebind a fixture-sized video to the production SHA is impossible; the
  // failed read proves the signed gate checks bytes rather than metadata.
  const certificateFile = path.join(folder, 'phase-A-rejection.json')
  const tampered = JSON.parse((await readFile(certificateFile)).toString('utf8'))
  tampered.failedChecks.frontWristKnotCompletedByNativeTail = true
  await writeFile(certificateFile, JSON.stringify(tampered, null, 2) + '\n')
  assert.throws(() => verifyFreshA8B6PhaseARejectionSync(planId, root),
    /phase-A-rejection.json signature changed/)
})
