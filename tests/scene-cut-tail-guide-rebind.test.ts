import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertSceneCutTailGuideRebindHop } from '../server/scene-cut-tail-guide-rebind.ts'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { callKlingVideo } from '../server/model-adapters.ts'
import { validateSceneCutTailGuidePayment } from '../server/scene-cut-frame-runtime.ts'

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const frameIssue = { code: 'core_event_contradiction', evidence: { source: 'frame',
  frameIndices: [10, 20] } }
function fixture(root: string) {
  const folder = path.join(root, 'public/generated')
  mkdirSync(folder, { recursive: true })
  const write = (name: string, value: string) => {
    const bytes = Buffer.from(value)
    writeFileSync(path.join(folder, name), bytes)
    return { url: `/generated/${name}`, sha: digest(bytes) }
  }
  const imageFile = write('candidate.png', 'approved image')
  const currentVideo = write('rejected-current.mp4', 'second rejected paid video')
  const nativeVideo = write('rejected-native.mp4', 'first rejected paid video')
  const frame = write('native-tail.jpg', 'native final frame')
  const report = write('native-evidence.json', '{"native":true}')
  const makeRuns = () => Array.from({ length: 464 }, (_, index) => ({
    id: `run-${index}`, node: { id: index === 45 ? 'sanguo-scene-cut-first-frame'
      : index === 50 ? 'sanguo-scene-cut-approval'
        : index === 52 ? 'sanguo-video' : `node-${index}`,
    params: index === 52 ? [{ englishName: 'endImage', value: '${end_frame.url}' }] : [] },
    status: index < 60 ? 'success' : 'idle', revision: index === 50 || index === 52 ? 3 : 0,
    output: { value: index },
  }))
  const sourceRuns = makeRuns()
  const image = { url: imageFile.url, raw: { modelExecutionId: 'model-run-image',
    repairRequestFingerprint: '1'.repeat(64), raw: { image: { sha256: imageFile.sha } } } }
  sourceRuns[45].output = image
  sourceRuns[48].output = { reviewImages: ['frozen'] }
  sourceRuns[49].output = { passed: true }
  sourceRuns[50].output = { passed: true, reviewExecutionId: 'model-run-review',
    shotSha256: '2'.repeat(64), repairBinding: { executionId: 'record-source' } }
  sourceRuns[52].output = { url: currentVideo.url }
  sourceRuns[54].output = { url: currentVideo.url }
  sourceRuns[58].output = { model: 'vision', decision: 'revise', issues: [frameIssue] }
  sourceRuns[59].output = { passed: true, qualityDisposition: 'manual-review-v1',
    manualDecisionRequired: true, qualityReview: { manualDecisionRequired: true } }
  const source = { id: 'record-source', workflowId: 'wf-sanguo-history-drama',
    requestScopeId: 'record-4x5m31', generationScopeId: 'record-source',
    sceneCutImageRepairRecovery: { version: 'image-repair' }, nodeRuns: sourceRuns }
  const nativeRuns = makeRuns()
  nativeRuns.splice(0, 50, ...sourceRuns.slice(0, 50))
  nativeRuns[52].output = { url: nativeVideo.url }
  nativeRuns[54].output = { evidenceVersion: 2, sha256: nativeVideo.sha,
    url: nativeVideo.url, originalUrl: nativeVideo.url,
    evidenceUrl: report.url, lastFrameUrl: frame.url, frames: [frame.url] }
  const native = { id: 'record-levw1e', workflowId: 'wf-sanguo-history-drama',
    nodeRuns: nativeRuns }
  const reviewedRuns = nativeRuns.map(run => ({ ...run }))
  const nativeReview = { model: 'vision', decision: 'revise', issues: [frameIssue],
    endingState: '张飞停步，严颜身前双腕可见被缚；但中段动作冲突。' }
  reviewedRuns[58] = { ...reviewedRuns[58], output: nativeReview }
  const reviewed = { id: 'record-9p80o5', parentExecutionId: native.id,
    workflowId: native.workflowId, nodeRuns: reviewedRuns }
  const marker = { version: 'scene-cut-approval-rebind-v2',
    sourceExecutionId: source.id, sourceResultMd5: 'a'.repeat(32),
    nativeSourceExecutionId: native.id,
    nativeSourceResultMd5: 'a06fb401d4655699fce3ec69548e578c',
    nativeReviewExecutionId: reviewed.id,
    nativeReviewResultMd5: '4282a0710daef80462a46423391be68f',
    originalExecutionId: 'record-4x5m31',
    originalResultMd5: '74e5e2f8afcf8f829694aef350629950',
    reviewSourceExecutionId: 'record-4x5m31-original-repair-v8',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 50, firstPendingNodeId: 'sanguo-scene-cut-approval',
    preservedPrefixSha256: sceneCutRebindSha256(sourceRuns.slice(0, 50)),
    approvedImageUrl: imageFile.url, approvedImageSha256: imageFile.sha,
    imageExecutionId: 'model-run-image', repairRequestFingerprint: '1'.repeat(64),
    reviewExecutionId: 'model-run-review',
    reviewOutputSha256: sceneCutRebindSha256(sourceRuns[49].output),
    evidenceOutputSha256: sceneCutRebindSha256(sourceRuns[48].output),
    approvedShotSha256: '2'.repeat(64),
    oldApprovalSha256: sceneCutRebindSha256(sourceRuns[50].output),
    oldCertificateExecutionId: source.id,
    failedVideoUrl: currentVideo.url, failedVideoFileSha256: currentVideo.sha,
    failedVideoOutputSha256: sceneCutRebindSha256(sourceRuns[52].output),
    failedReviewOutputSha256: sceneCutRebindSha256(sourceRuns[58].output),
    failedMediaAcceptOutputSha256: sceneCutRebindSha256(sourceRuns[59].output),
    failedVideoReviewExecutionId: 'model-run-current-review',
    failedVideoReviewRequestKey: `${source.id}:attempt-1:revision-5:sanguo-media-review:0:scene-01:principle-review-1`,
    failedVideoReviewFingerprint: '3'.repeat(64),
    nativeReviewOutputSha256: sceneCutRebindSha256(nativeReview),
    nativeEvidenceOutputSha256: sceneCutRebindSha256(nativeRuns[54].output),
    nativeVideoReviewExecutionId: 'model-run-native-review',
    nativeVideoReviewRequestKey: `${reviewed.id}:attempt-1:revision-4:sanguo-media-review:0:scene-01:principle-review-1`,
    nativeVideoReviewFingerprint: '4'.repeat(64),
    tailGuide: { sourceExecutionId: native.id, reviewExecutionId: reviewed.id,
      sourceVideoUrl: nativeVideo.url, evidenceVideoUrl: nativeVideo.url,
      evidenceUrl: report.url, videoFileSha256: nativeVideo.sha,
      evidenceFileSha256: report.sha, url: frame.url, fileSha256: frame.sha } }
  const childRuns = sourceRuns.map((run, index) => index < 50 ? run : {
    ...run, status: 'idle', revision: index === 50 || index === 52 ? 4 : run.revision,
    output: undefined, ...(index === 52 ? { routeInputOverrides: {
      end_frame: { url: frame.url, sha256: frame.sha } } } : {}) })
  const child = { ...source, id: 'record-child', parentExecutionId: source.id,
    generationScopeId: 'record-child', sceneCutApprovalRebindRecovery: marker,
    nodeRuns: childRuns }
  const reviewProjection = (output: Record<string, unknown>) => Object.fromEntries(
    Object.entries(output).filter(([key]) => !['raw', 'text', 'model', 'reviewTransport'].includes(key)))
  const witness = {
    nativeSource: { state: native, resultMd5: marker.nativeSourceResultMd5 },
    nativeReview: { state: reviewed, resultMd5: marker.nativeReviewResultMd5 },
    nativeReviewLedger: { id: marker.nativeVideoReviewExecutionId, status: 'succeeded',
      modelId: 'vision', requestKey: marker.nativeVideoReviewRequestKey,
      fingerprint: marker.nativeVideoReviewFingerprint,
      output: reviewProjection(nativeReview) },
    currentReviewLedger: { id: marker.failedVideoReviewExecutionId, status: 'succeeded',
      modelId: 'vision', requestKey: marker.failedVideoReviewRequestKey,
      fingerprint: marker.failedVideoReviewFingerprint,
      output: reviewProjection(sourceRuns[58].output) },
  }
  return { source, child, witness, marker, frame, report, nativeVideo }
}

test('v2 rebind pins a rejected native frame without treating either paid video as accepted', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tail-guide-rebind-'))
  try {
    const { source, child, witness, marker, frame, nativeVideo } = fixture(root)
    assert.deepEqual(assertSceneCutTailGuideRebindHop(source, child, 'a'.repeat(32),
      witness, root, 'preview').endImage, frame.url)
    const active = { ...child, nodeRuns: child.nodeRuns.map((run, index) => index === 50
      ? { ...run, status: 'running' } : run) }
    assert.equal(assertSceneCutTailGuideRebindHop(source, active, 'a'.repeat(32),
      witness, root, 'approval').endImageSha256, frame.sha)
    const failedApproval = { ...child, nodeRuns: child.nodeRuns.map((run, index) => index === 50
      ? { ...run, status: 'failed' } : run) }
    assert.equal(assertSceneCutTailGuideRebindHop(source, failedApproval, 'a'.repeat(32),
      witness, root, 'failed-approval').endImageSha256, frame.sha)
    assert.throws(() => assertSceneCutTailGuideRebindHop(source,
      { ...failedApproval, nodeRuns: failedApproval.nodeRuns.map((run, index) => index === 51
        ? { ...run, status: 'success' } : run) }, 'a'.repeat(32), witness,
      root, 'failed-approval'), /failed approval retry ancestor/)
    const paid = { ...child, nodeRuns: child.nodeRuns.map((run, index) => index === 50
      ? { ...run, status: 'success', output: { passed: true,
        repairBinding: { executionId: child.id } } }
      : index === 51 ? { ...run, status: 'success' }
        : index === 52 ? { ...run, status: 'running' } : run) }
    assert.equal(assertSceneCutTailGuideRebindHop(source, paid, 'a'.repeat(32),
      witness, root, 'video').sourceVideoSha256, marker.tailGuide.videoFileSha256)
    assert.throws(() => assertSceneCutTailGuideRebindHop(source,
      { ...child, parentExecutionId: 'record-other' }, 'a'.repeat(32), witness, root,
      'preview'), /TAIL_GUIDE_INVALID/)
    assert.throws(() => assertSceneCutTailGuideRebindHop(source,
      { ...child, nodeRuns: child.nodeRuns.map((run, index) => index === 52
        ? { ...run, routeInputOverrides: { end_frame: { url: '/generated/other.jpg' } } }
        : run) }, 'a'.repeat(32), witness, root, 'preview'), /route input/)
    assert.throws(() => assertSceneCutTailGuideRebindHop(source,
      { ...child, sceneCutApprovalRebindRecovery: { ...marker,
        nativeReviewOutputSha256: '0'.repeat(64) } }, 'a'.repeat(32), witness,
      root, 'preview'), /TAIL_GUIDE_INVALID/)
    assert.throws(() => assertSceneCutTailGuideRebindHop(source, child,
      '0'.repeat(32), witness, root, 'preview'), /TAIL_GUIDE_INVALID/)
    assert.throws(() => assertSceneCutTailGuideRebindHop(source, child,
      'a'.repeat(32), { ...witness, nativeReviewLedger: {
        ...witness.nativeReviewLedger, output: { decision: 'pass' } } },
    root, 'preview'), /TAIL_GUIDE_INVALID/)
    assert.throws(() => assertSceneCutTailGuideRebindHop(source,
      { ...child, nodeRuns: child.nodeRuns.map((run, index) => index === 45
        ? { ...run, output: { url: '/generated/other.png' } } : run) },
    'a'.repeat(32), witness, root, 'preview'), /TAIL_GUIDE_INVALID/)
    assert.throws(() => assertSceneCutTailGuideRebindHop({ ...source,
      nodeRuns: source.nodeRuns.map((run, index) => index === 59
        ? { ...run, output: { passed: true } } : run) }, child,
    'a'.repeat(32), witness, root, 'preview'), /TAIL_GUIDE_INVALID/)
    writeFileSync(path.join(root, 'public', nativeVideo.url), 'tampered paid video')
    assert.throws(() => assertSceneCutTailGuideRebindHop(source, child,
      'a'.repeat(32), witness, root, 'preview'), /TAIL_GUIDE_INVALID/)
    writeFileSync(path.join(root, 'public', nativeVideo.url), 'first rejected paid video')
    writeFileSync(path.join(root, 'public', frame.url), 'tampered target frame')
    assert.throws(() => assertSceneCutTailGuideRebindHop(source, child,
      'a'.repeat(32), witness, root, 'preview'), /TAIL_GUIDE_INVALID/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('direct Kling purchase refuses an unverified live-action target frame', async () => {
  await assert.rejects(callKlingVideo({ id: 'kling', provider: 'Kling',
    capability: 'video', settings: { endpoint: 'https://example.com/generations',
      apiKey: 'test-only' } },
  '街口单镜头动作', { continuityMode: 'scene_cut', visualTreatment: 'live_action',
    endImage: '/generated/native-tail.jpg' }, { fetch: async () => {
    throw Error('provider must not be called')
  } }), /SCENE_CUT_TAIL_GUIDE_INVALID/)
})

test('payment boundary requires the exact persisted native end-frame identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tail-guide-payment-'))
  try {
    const { frame } = fixture(root)
    const id = 'record-child'
    const request = { model: { id: 'kling', capability: 'video', settings: {} },
      prompt: 'single take', executionContext: { workflowId: 'wf-sanguo-history-drama',
        nodeId: 'sanguo-video', requestKey: `${id}:attempt-1:revision-4:sanguo-video:0:scene-01` },
      params: { endImage: frame.url } }
    const context = { executionId: id, recovery: {}, tailGuide: {
      endImage: frame.url, endImageSha256: frame.sha,
      sourceVideoSha256: 'a'.repeat(64) } }
    assert.equal(validateSceneCutTailGuidePayment(request, context, root), true)
    assert.throws(() => validateSceneCutTailGuidePayment(request,
      { ...context, tailGuide: null }, root), /SCENE_CUT_FRAME_BLOCKED/)
    assert.throws(() => validateSceneCutTailGuidePayment({ ...request,
      params: { endImage: '/generated/other.jpg' } }, context, root), /SCENE_CUT_FRAME_BLOCKED/)
    assert.throws(() => validateSceneCutTailGuidePayment(request,
      { ...context, executionId: 'record-other' }, root), /SCENE_CUT_FRAME_BLOCKED/)
    writeFileSync(path.join(root, 'public', frame.url), 'tampered frame')
    assert.throws(() => validateSceneCutTailGuidePayment(request, context, root),
      /SCENE_CUT_FRAME_BLOCKED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
