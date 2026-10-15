import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertSceneCutApprovalRebindHop, assertSceneCutCompletedApprovalRetryHop,
  assertSceneCutSameMediaReviewHop, sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { buildSceneCutApprovalRebindRuns } from '../scripts/fork-original-shot1-approval-rebind.mjs'

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const issue = { code: 'core_event_contradiction', evidence: { source: 'frame',
  frameIndices: [152, 220] } }

function fixture(root: string) {
  mkdirSync(path.join(root, 'public/generated'), { recursive: true })
  const imageBytes = Buffer.from('candidate image bytes')
  const videoBytes = Buffer.from('paid but rejected video bytes')
  writeFileSync(path.join(root, 'public/generated/candidate.png'), imageBytes)
  writeFileSync(path.join(root, 'public/generated/rejected.mp4'), videoBytes)
  const graph = Array.from({ length: 72 }, (_, index) => ({ id: `node-${index}` }))
  for (const [index, id] of [[45, 'sanguo-scene-cut-first-frame'], [48, 'sanguo-scene-cut-evidence'],
    [49, 'sanguo-scene-cut-review'], [50, 'sanguo-scene-cut-approval'],
    [52, 'sanguo-video'], [58, 'sanguo-media-review'], [59, 'sanguo-media-accept'],
    [61, 'sanguo-media-accept-error-branch']] as const) graph[index].id = id
  const runs = Array.from({ length: 464 }, (_, index) => ({ id: `run-${index}`,
    node: graph[index % graph.length], status: index < 60 ? 'success' : 'idle',
    revision: 0, output: { value: index } }))
  const image = { url: '/generated/candidate.png', raw: { modelExecutionId: 'model-run-image',
    repairRequestFingerprint: '1'.repeat(64), raw: { image: { sha256: sha(imageBytes) } } } }
  const review = { passed: true }
  const evidence = { reviewImages: ['/generated/candidate.jpg'] }
  const binding = { executionId: 'record-ancestor',
    reviewSourceExecutionId: 'record-4x5m31-original-repair-v8' }
  const certificate = { passed: true, reviewExecutionId: 'model-run-review',
    shotSha256: '2'.repeat(64), repairBinding: binding }
  const failedReview = { model: 'codex-local-vision', decision: 'revise',
    issues: [issue], reviewTransport: { mode: 'native' } }
  runs[45].output = image
  runs[48].output = evidence
  runs[49].output = review
  runs[50].output = certificate
  runs[52].output = { url: '/generated/rejected.mp4' }
  runs[58].output = failedReview
  runs[59].output = { passed: false }
  const marker0 = { version: 'scene-cut-image-repair-schema178-fork-v2' }
  const base = { id: 'record-ancestor', workflowId: 'wf-sanguo-history-drama',
    requestScopeId: 'record-original', generationScopeId: 'record-ancestor',
    sceneCutImageRepairRecovery: marker0,
    sceneCutFirstFrameRecovery: { version: 'original-shot1-image-retry-schema178-fork-v1' },
    originalShot1ImageV8RetryRecovery: { version: 'original-shot1-image-retry-schema178-fork-v1' },
    nodeRuns: runs.map(run => ({ ...run })) }
  base.nodeRuns[59] = { ...base.nodeRuns[59], output: { passed: false } }
  base.nodeRuns[61] = { ...base.nodeRuns[61], status: 'failed' }
  const source = { ...base, id: 'record-source', parentExecutionId: base.id,
    generationScopeId: 'record-source', nodeRuns: runs }
  const marker = { version: 'scene-cut-approval-rebind-v1',
    sourceExecutionId: source.id, sourceResultMd5: 'a'.repeat(32),
    sameMediaAncestorExecutionId: base.id, sameMediaAncestorResultMd5: 'b'.repeat(32),
    workflowSchemaVersion: 179, workflowNodesMd5: 'db1556fa6605e179a7a37e52cbbe8135',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    originalExecutionId: 'record-4x5m31',
    originalResultMd5: '74e5e2f8afcf8f829694aef350629950',
    reviewSourceExecutionId: 'record-4x5m31-original-repair-v8',
    preservedPrefixLength: 50,
    firstPendingNodeId: 'sanguo-scene-cut-approval',
    preservedPrefixSha256: sceneCutRebindSha256(runs.slice(0, 50)),
    approvedImageUrl: image.url, approvedImageSha256: sha(imageBytes),
    imageExecutionId: image.raw.modelExecutionId,
    repairRequestFingerprint: image.raw.repairRequestFingerprint,
    reviewExecutionId: certificate.reviewExecutionId,
    reviewOutputSha256: sceneCutRebindSha256(review),
    evidenceOutputSha256: sceneCutRebindSha256(evidence),
    oldApprovalSha256: sceneCutRebindSha256(certificate),
    oldCertificateExecutionId: base.id,
    approvedShotSha256: certificate.shotSha256,
    failedVideoUrl: '/generated/rejected.mp4',
    failedVideoFileSha256: sha(videoBytes),
    failedVideoOutputSha256: sceneCutRebindSha256(runs[52].output),
    failedReviewOutputSha256: sceneCutRebindSha256(failedReview),
    failedMediaAcceptOutputSha256: sceneCutRebindSha256(runs[59].output),
    failedVideoReviewExecutionId: 'model-run-failed',
    failedVideoReviewRequestKey: 'record-source:attempt-1:revision-1:sanguo-media-review:0:scene-01:principle-review-1',
    failedVideoReviewFingerprint: 'e'.repeat(64) }
  const workflow = { id: 'wf-sanguo-history-drama', nodes: graph,
    edges: Array.from({ length: 87 }, (_, index) => ({ id: `edge-${index}` })) }
  const pending = buildSceneCutApprovalRebindRuns(source.nodeRuns, workflow)
  const child = { ...source, id: 'record-rebind', parentExecutionId: source.id,
    generationScopeId: 'record-rebind', sceneCutApprovalRebindRecovery: marker,
    nodeRuns: pending.map((run, index) => index === 50
      ? { ...run, status: 'running' } : run) }
  const failedLedger = { id: 'model-run-failed', status: 'succeeded',
    modelId: 'codex-local-vision', requestKey: marker.failedVideoReviewRequestKey,
    fingerprint: marker.failedVideoReviewFingerprint,
    output: { decision: 'revise', issues: [issue] } }
  return { base, source, child, marker, failedLedger, graph }
}

test('versioned index50 rebind retains exact first-frame prefix, failed video and model result', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scene-cut-rebind-'))
  try {
    const { base, source, child, marker, failedLedger, graph } = fixture(root)
    assert.equal(assertSceneCutSameMediaReviewHop(base, source, marker,
      'b'.repeat(32), 'a'.repeat(32)), true)
    assert.equal(assertSceneCutApprovalRebindHop(source, child, 'a'.repeat(32), root,
      true, failedLedger), true)
    const workflow = { id: 'wf-sanguo-history-drama', nodes: graph,
      edges: Array.from({ length: 87 }, (_, index) => ({ id: `edge-${index}` })) }
    const pending = buildSceneCutApprovalRebindRuns(source.nodeRuns, workflow)
    assert.deepEqual(pending.slice(0, 50), source.nodeRuns.slice(0, 50))
    assert.equal(pending[50].status, 'idle')
    assert.equal(pending[50].revision, 1)
    assert.ok(pending.slice(50).every(run => run.status === 'idle'))
    assert.throws(() => assertSceneCutApprovalRebindHop(source,
      { ...child, parentExecutionId: 'record-other' }, 'a'.repeat(32), root,
      true, failedLedger), /REBIN[D_]/i)
    assert.throws(() => assertSceneCutApprovalRebindHop(source,
      { ...child, nodeRuns: [{ ...child.nodeRuns[0], output: { changed: true } },
        ...child.nodeRuns.slice(1)] }, 'a'.repeat(32), root,
      true, failedLedger), /REBIN[D_]/i)
    assert.throws(() => assertSceneCutApprovalRebindHop(source,
      { ...child, sceneCutApprovalRebindRecovery: { ...marker,
        reviewExecutionId: 'model-run-other' } }, 'a'.repeat(32), root,
      true, failedLedger), /REBIN[D_]/i)
    assert.throws(() => assertSceneCutApprovalRebindHop(source,
      { ...child, sceneCutApprovalRebindRecovery: { ...marker,
        sourceResultMd5: '0'.repeat(32) } }, 'a'.repeat(32), root,
      true, failedLedger), /REBIN[D_]/i)
    assert.throws(() => assertSceneCutApprovalRebindHop(source, child,
      'a'.repeat(32), root, true, { ...failedLedger, output: { decision: 'pass' } }), /REBIN[D_]/i)
    writeFileSync(path.join(root, 'public/generated/candidate.png'), 'modified candidate')
    assert.throws(() => assertSceneCutApprovalRebindHop(source, child,
      'a'.repeat(32), root, true, failedLedger), /bytes changed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('historical approval success is a narrow signed-owner hop, not an ordinary retry', () => {
  const prefix = Array.from({ length: 50 }, (_, index) => ({ id: `run-${index}`,
    node: { id: `node-${index}` }, status: 'success', output: { value: index } }))
  const marker = { version: 'scene-cut-image-repair-schema178-fork-v2' }
  const failed = { id: 'record-approval-failed', workflowId: 'wf-sanguo-history-drama',
    requestScopeId: 'record-original', generationScopeId: 'record-approval-failed',
    sceneCutImageRepairRecovery: marker,
    nodeRuns: [...prefix, { id: 'approval', node: { id: 'sanguo-scene-cut-approval' },
      status: 'failed', revision: 1 }] }
  const succeeded = { ...failed, id: 'record-approval-success', parentExecutionId: failed.id,
    generationScopeId: 'record-approval-success', nodeRuns: [...prefix,
      { ...failed.nodeRuns[50], status: 'success', revision: 2,
        output: { passed: true, reviewExecutionId: 'model-run-review',
          repairBinding: { executionId: 'record-approval-success',
            reviewSourceExecutionId: 'record-4x5m31-original-repair-v8' } } }] }
  // Production records have the full expanded queue.
  failed.nodeRuns.push(...Array.from({ length: 413 }, () => ({ status: 'idle' })))
  succeeded.nodeRuns.push(...Array.from({ length: 413 }, () => ({ status: 'idle' })))
  assert.equal(assertSceneCutCompletedApprovalRetryHop(failed, succeeded), true)
  assert.throws(() => assertSceneCutCompletedApprovalRetryHop(failed,
    { ...succeeded, nodeRuns: [...succeeded.nodeRuns.slice(0, 50),
      { ...succeeded.nodeRuns[50], output: { passed: true,
        repairBinding: { executionId: 'record-other' } } },
      ...succeeded.nodeRuns.slice(51)] }), /REBIN[D_]/i)
})
