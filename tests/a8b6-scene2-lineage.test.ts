import assert from 'node:assert/strict'
import test from 'node:test'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { sceneCutShotSha256 } from '../server/scene-cut-frame-approval.ts'
import { assertA8B6FirstShotLineage,
  assertFreshA8B6FirstShotLineage } from '../scripts/audit-original-second-shot-media-reuse.mjs'

const sha = (character: string) => character.repeat(64)

function fixture() {
  const movie = '/generated/narrated-test.mp4', movieSha = sha('a')
  const planId = sha('1'), manifestSha256 = sha('2'), receiptSha256 = sha('3'),
    approvalSha256 = sha('4'), certificateSignature = sha('5')
  const shot = { id: 'scene-01', duration: 14, scheduleHash: 'schedule',
    pacing: { version: 'duration-v2', scheduleHash: 'schedule',
      beats: [{ id: 'bind', sourceBeatId: 'beat-01',
        completion: { requiredThisClip: true } }] } }
  const certificate = { signature: certificateSignature }
  const parentRuns = Array.from({ length: 464 }, (_, index) => ({
    node: { id: index === 52 ? 'sanguo-video' : 'other' },
    status: index < 52 ? 'success' : 'idle', output: undefined as unknown }))
  parentRuns[11].output = shot
  parentRuns[44].output = shot
  parentRuns[50].output = certificate
  const parent = { id: 'record-4x5m31-a8b6-frame-reuse-v3',
    workflowId: 'wf-sanguo-history-drama', requestScopeId: 'scope',
    nodeRuns: parentRuns }
  const childRuns = structuredClone(parentRuns)
  const bound = { planId, manifestSha256, receiptSha256,
    workflowApprovalSha256: approvalSha256 }
  childRuns[52] = { node: { id: 'sanguo-video' }, status: 'success',
    output: { url: movie, model: 'source-bound-composite-a8b6-v1',
      narration: { url: movie, pictureUrl: '/generated/picture.mp4' },
      sourceBoundComposite: bound,
      params: { sourceBoundComposite: bound,
        sceneCutFrameGate: { signature: certificateSignature },
        sceneCutShot: { duration: 14 } } }, inputs: { sourceBoundComposite: bound } } as never
  for (let index = 53; index <= 64; index++) childRuns[index].status = 'success'
  childRuns[54].output = { decoded: true, originalUrl: movie,
    sha256: movieSha, lastFrameUrl: '/generated/last.jpg' }
  childRuns[58].output = { decision: 'pass' }
  const accept = { passed: true, visualReview: { passed: true },
    manualDecisionRequired: false, originalUrl: movie, sha256: movieSha,
    evidenceUrl: '/generated/evidence.json', duration: 14,
    durationCompletion: { applicable: true, assessment: 'complete', passed: true,
      route: 'accept', scheduleHash: 'schedule', evidenceRef: '/generated/evidence.json',
      reasons: [], remainingMandatoryBeats: [], requiredEndSecond: 14,
      actualCompletionInterval: { lower: 13, upper: 13 },
      checks: [{ beatId: 'bind', sourceBeatId: 'beat-01', status: 'complete',
        reasons: [], observedStart: { lower: 1, upper: 1 },
        observedEnd: { lower: 13, upper: 13 } }] } }
  childRuns[59].output = accept
  childRuns[64].output = { available: true, url: '/generated/last.jpg',
    source: 'extracted-from-video' }
  const parentMd5 = 'b'.repeat(32)
  const marker = { version: 'source-bound-composite-a8b6-first-shot-v1',
    stagingVariant: 'a8b6', sourceExecutionId: parent.id,
    sourceResultMd5: parentMd5, workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    qaPlanId: planId, manifestSha256, receiptSha256,
    workflowApprovalSha256: approvalSha256,
    preservedPrefixLength: 52,
    preservedPrefixSha256: sceneCutRebindSha256(parentRuns.slice(0, 52)),
    compositeVideoUrl: movie, compositeVideoSha256: movieSha,
    firstPendingIndex: 53 }
  const child = { id: 'record-new-composite', parentExecutionId: parent.id,
    workflowId: parent.workflowId, requestScopeId: parent.requestScopeId,
    generationScopeId: 'record-new-composite',
    sceneCutCompositeRecovery: marker, nodeRuns: childRuns }
  const approval = { approval: { qaPlanId: planId,
    approvalExecutionId: parent.id, approvalResultMd5: parentMd5,
    amendedShotSha256: sceneCutShotSha256(shot),
    sceneCutFrameApprovalSignature: certificateSignature,
    sceneCutFrameCertificateSha256: sceneCutRebindSha256(certificate) },
  approvalSha256 }
  const verified = { manifest: { planId }, manifestSha256, receiptSha256,
    receipt: { output: { url: movie, sha256: movieSha, frameCount: 337,
      fps: 24, lastPts: 14 }, narration: { url: movie },
      picture: { url: '/generated/picture.mp4' },
      workflowApproval: { approvalSha256,
        amendedShotSha256: approval.approval.amendedShotSha256,
        sceneCutFrameCertificateSha256: approval.approval.sceneCutFrameCertificateSha256 } } }
  return { parent, child, parentMd5, verified, approval }
}

test('strict new 14-second first-shot lineage accepts only the exact completed prefix', () => {
  const sample = fixture()
  const inspected = assertA8B6FirstShotLineage(sample.parent, sample.child,
    sample.parentMd5, sample.verified, sample.approval)
  assert.equal(inspected.receipt.output.frameCount, 337)
  assert.equal(inspected.completion.assessment, 'complete')
  const changed = fixture()
  changed.child.nodeRuns[11].output = { changed: true }
  assert.throws(() => assertA8B6FirstShotLineage(changed.parent, changed.child,
    changed.parentMd5, changed.verified, changed.approval), /signed parent/)
  const oldTiming = fixture()
  oldTiming.verified.receipt.output.frameCount = 313
  assert.throws(() => assertA8B6FirstShotLineage(oldTiming.parent, oldTiming.child,
    oldTiming.parentMd5, oldTiming.verified, oldTiming.approval), /signed parent/)
  const incomplete = fixture()
  ;(incomplete.child.nodeRuns[59].output as { durationCompletion: { checks: Array<{ status: string }> } })
    .durationCompletion.checks[0].status = 'uncertain'
  assert.throws(() => assertA8B6FirstShotLineage(incomplete.parent, incomplete.child,
    incomplete.parentMd5, incomplete.verified, incomplete.approval), /mandatory beat/)
})

test('fresh paid A8+B6 lineage uses its own signed marker and actual native frame count', () => {
  const sample = fixture()
  const { parent, child, verified, parentMd5 } = sample
  const refs = { version: 'scene-cut-sources-v1',
    referenceImages: ['/generated/Zhang.png', '/generated/Yan.png'],
    referenceBindings: [{ characterName: '张飞' }, { characterName: '严颜' }] }
  parent.nodeRuns[41].output = refs
  child.nodeRuns[41].output = structuredClone(refs)
  const imageApproval = structuredClone(parent)
  const imageApprovalMd5 = 'c'.repeat(32)
  imageApproval.nodeRuns[51].status = 'idle'
  parent.id = 'record-fresh-router-child'
  parent.parentExecutionId = imageApproval.id
  parent.generationScopeId = parent.id
  parent.nodeRuns[51] = { node: { id: 'sanguo-video-reference-router' },
    status: 'success', output: { referenceMode: 'three-view-all',
      referenceImages: refs.referenceImages,
      referenceBindings: refs.referenceBindings } } as never
  parent.sceneCutA8B6FreshRouterRecovery = {
    version: 'scene-cut-a8b6-fresh-router-v1',
    imageApprovalExecutionId: imageApproval.id,
    imageApprovalResultMd5: imageApprovalMd5,
    planId: sha('1'), workflowApprovalSha256: sample.approval.approvalSha256,
    preservedPrefixLength: 51,
    preservedPrefixSha256: sceneCutRebindSha256(imageApproval.nodeRuns.slice(0, 51)),
    firstPendingIndex: 51 } as never
  child.parentExecutionId = parent.id
  child.nodeRuns[51] = structuredClone(parent.nodeRuns[51])
  const manifest = verified.manifest as Record<string, unknown>
  manifest.workflowApprovalSha256 = sample.approval.approvalSha256
  manifest.source = { freshFrameExecutionId: imageApproval.id,
    freshFrameResultMd5: imageApprovalMd5,
    approvedShotSha256: sceneCutShotSha256(parent.nodeRuns[11].output),
    scheduleHash: 'schedule',
    frameCertificateSha256: sceneCutRebindSha256(parent.nodeRuns[50].output) }
  const receipt = verified.receipt as Record<string, unknown>
  receipt.version = 'staged-a8b6-fresh-composite-v1'
  receipt.sourceRecordId = imageApproval.id
  receipt.sourceResultMd5 = imageApprovalMd5
  receipt.mapping = { frameCount: 336 }
  receipt.workflowApproval = { approvalSha256: sample.approval.approvalSha256,
    amendedShotSha256: (manifest.source as { approvedShotSha256: string }).approvedShotSha256,
    sceneCutFrameCertificateSha256:
      (manifest.source as { frameCertificateSha256: string }).frameCertificateSha256 }
  receipt.output = { url: '/generated/narrated-test.mp4', sha256: sha('a'),
    frameCount: 336, fps: 24, lastPts: 335 / 24 }
  const marker = child.sceneCutCompositeRecovery as Record<string, unknown>
  marker.version = 'source-bound-composite-a8b6-fresh-first-shot-v1'
  marker.stagingVariant = 'a8b6-fresh'
  marker.sourceExecutionId = parent.id
  marker.imageApprovalExecutionId = imageApproval.id
  marker.imageApprovalResultMd5 = imageApprovalMd5
  marker.imageApprovalPrefixLength = 51
  marker.imageApprovalPrefixSha256 =
    sceneCutRebindSha256(imageApproval.nodeRuns.slice(0, 51))
  marker.preservedPrefixSha256 = sceneCutRebindSha256(parent.nodeRuns.slice(0, 52))
  marker.planId = marker.qaPlanId
  delete marker.qaPlanId
  ;(child.nodeRuns[52].output as { model: string }).model =
    'source-bound-composite-a8b6-fresh-v1'
  assert.equal(assertFreshA8B6FirstShotLineage(parent, child,
    parentMd5, verified, imageApproval, imageApprovalMd5)
    .receipt.output.frameCount, 336)
  const wrongTask = structuredClone(child)
  ;(wrongTask.sceneCutCompositeRecovery as Record<string, unknown>)
    .workflowApprovalSha256 = sha('f')
  assert.throws(() => assertFreshA8B6FirstShotLineage(parent,
    wrongTask, parentMd5, verified, imageApproval, imageApprovalMd5),
  /fresh 14s composite child/)
  const wrongCount = structuredClone(verified)
  wrongCount.receipt.output.frameCount = 313
  assert.throws(() => assertFreshA8B6FirstShotLineage(parent,
    child, parentMd5, wrongCount, imageApproval, imageApprovalMd5),
  /fresh 14s composite child/)
  const alteredRouter = structuredClone(parent)
  alteredRouter.nodeRuns[51].status = 'idle'
  assert.throws(() => assertFreshA8B6FirstShotLineage(alteredRouter,
    child, parentMd5, verified, imageApproval, imageApprovalMd5),
  /fresh 14s composite child/)

  const retakeParent = structuredClone(parent)
  const retakeChild = structuredClone(child)
  const retakeVerified = structuredClone(verified)
  const retakeManifest = retakeVerified.manifest as Record<string, unknown>
  const retakePlanId = sha('8'), retakeApprovalSha256 = sha('9')
  retakeManifest.version = 'staged-a8b6-fresh-A-plan-v2'
  retakeManifest.planId = retakePlanId
  ;(retakeManifest.source as Record<string, unknown>)
    .frameProvenanceVariant = 'a8b6-local-composite-v9'
  retakeManifest.retake = { parentPlanId: sha('1'),
    parentWorkflowApprovalSha256: sample.approval.approvalSha256 }
  retakeManifest.workflowApprovalSha256 = retakeApprovalSha256
  ;(retakeVerified.receipt.workflowApproval as Record<string, unknown>)
    .approvalSha256 = retakeApprovalSha256
  const retakeMarker = retakeChild.sceneCutCompositeRecovery as
    Record<string, unknown>
  retakeMarker.planId = retakePlanId
  retakeMarker.workflowApprovalSha256 = retakeApprovalSha256
  const retakeBound = { planId: retakePlanId,
    manifestSha256: retakeVerified.manifestSha256,
    receiptSha256: retakeVerified.receiptSha256,
    workflowApprovalSha256: retakeApprovalSha256 }
  const retakeTake = retakeChild.nodeRuns[52] as {
    output: { sourceBoundComposite: unknown,
      params: { sourceBoundComposite: unknown } },
    inputs: { sourceBoundComposite: unknown } }
  retakeTake.inputs.sourceBoundComposite = retakeBound
  retakeTake.output.sourceBoundComposite = retakeBound
  retakeTake.output.params.sourceBoundComposite = retakeBound
  assert.equal(assertFreshA8B6FirstShotLineage(retakeParent,
    retakeChild, parentMd5, retakeVerified, imageApproval,
    imageApprovalMd5).manifest.planId, retakePlanId)
  const wrongRetakeRouter = structuredClone(retakeParent)
  wrongRetakeRouter.sceneCutA8B6FreshRouterRecovery.planId = retakePlanId
  assert.throws(() => assertFreshA8B6FirstShotLineage(wrongRetakeRouter,
    retakeChild, parentMd5, retakeVerified, imageApproval,
    imageApprovalMd5), /fresh 14s composite child/)
  const wrongRetakeApproval = structuredClone(retakeVerified)
  ;(wrongRetakeApproval.manifest.retake as Record<string, unknown>)
    .parentWorkflowApprovalSha256 = sha('f')
  assert.throws(() => assertFreshA8B6FirstShotLineage(retakeParent,
    retakeChild, parentMd5, wrongRetakeApproval, imageApproval,
    imageApprovalMd5), /fresh 14s composite child/)

  const bRetakeVerified = structuredClone(retakeVerified)
  const bRetakeChild = structuredClone(retakeChild)
  const bRetakePlanId = sha('7')
  const bRetakeManifest = bRetakeVerified.manifest as Record<string, unknown>
  bRetakeManifest.version = 'staged-a8b6-fresh-A-plan-v3'
  bRetakeManifest.planId = bRetakePlanId
  bRetakeManifest.bRetake = { parentPlanId: retakePlanId,
    parentManifestSha256: sha('2'),
    parentAAcceptanceSha256: sha('3'),
    parentBRejectionSha256: sha('4'),
    parentWorkflowApprovalSha256: retakeApprovalSha256 }
  const bRetakeMarker = bRetakeChild.sceneCutCompositeRecovery as
    Record<string, unknown>
  bRetakeMarker.planId = bRetakePlanId
  const bRetakeBound = { ...retakeBound, planId: bRetakePlanId }
  const bRetakeTake = bRetakeChild.nodeRuns[52] as {
    output: { sourceBoundComposite: unknown,
      params: { sourceBoundComposite: unknown } },
    inputs: { sourceBoundComposite: unknown } }
  bRetakeTake.inputs.sourceBoundComposite = bRetakeBound
  bRetakeTake.output.sourceBoundComposite = bRetakeBound
  bRetakeTake.output.params.sourceBoundComposite = bRetakeBound
  assert.equal(assertFreshA8B6FirstShotLineage(retakeParent,
    bRetakeChild, parentMd5, bRetakeVerified, imageApproval,
    imageApprovalMd5).manifest.planId, bRetakePlanId)
})
