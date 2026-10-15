import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { assertOriginalSecondShotArrivalRoute, assertSchema177ImageRepairLineage,
  assertSchema178ImageRepairLineage, assertSchema178ApprovalRetryLineage,
  storedSceneCutRepairReceiptSha256,
  secondShotCreativeProjection } from '../scripts/replay-original-second-shot-candidate.mjs'

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const v6Id = 'record-4x5m31-original-repair-v6'
const v6Md5 = '21f1f7a2131fe7c3d0e97998d16245a3'
const failedImageSha = '2592c8f00f59d4511c85bdf9bf13fc67f539eb49ea4f91ee7780704626df5f73'
const failedReviewSha = 'd4a00dbe88ea9a5dabd6cfea6be4e8a2633a3da30f162440a908ddcddf6ee7dc'
const workflow177 = { schema_version: 177, nodes_md5: '66403a851ef7b3abba0dfa836d6727c1',
  edges_md5: '1d0a75acb3d4778a122a4cfd96a23b49' }
const firstShotRouteIds = [
  'sanguo-scene-cut-first-frame', 'sanguo-map-end-accept',
  'sanguo-scene-cut-evidence-plan', 'sanguo-scene-cut-evidence',
  'sanguo-scene-cut-review', 'sanguo-scene-cut-approval',
  'sanguo-video-reference-router', 'sanguo-video', 'sanguo-media-request',
  'sanguo-video-evidence', 'sanguo-media-metrics', 'sanguo-media-observe',
  'sanguo-requirement-review', 'sanguo-media-review', 'sanguo-media-accept',
  'sanguo-duration-replan', 'sanguo-media-accept-error-branch',
  'sanguo-media-accept-accept-branch', 'sanguo-video-concat', 'sanguo-last-frame',
]

function v7RouteFixture() {
  const runs = Array.from({ length: 464 }, (_, index) => ({
    node: { id: `unused-${index}` }, status: index < 45 ? 'success' : 'idle',
    loopIndex: index < 65 ? 0 : 1, output: undefined as unknown,
    context: {} as Record<string, unknown>,
  }))
  firstShotRouteIds.forEach((id, index) => { runs[index + 45].node.id = id })
  runs[65].node.id = 'sanguo-shot-script'
  runs[66].node.id = 'sanguo-shot-script-review'
  runs[67].node.id = 'sanguo-shot-script-accept'
  return runs
}

test('second-shot replay excludes only review fields from the original creative lock', () => {
  const original = { sceneId: 'scene-02', targetDuration: 10,
    setting: '问讯院落', dialogue: '我们的大军已经到了，你为什么不投降，还要抵抗？',
    mustShow: ['张飞在低阶问责严颜'] }
  const accepted = { ...original, passed: true, issues: [], qualityReview: { passed: true } }
  assert.deepEqual(secondShotCreativeProjection(accepted), original)
  assert.notDeepEqual(secondShotCreativeProjection({ ...accepted, dialogue: '改写后的台词' }), original)
  assert.notDeepEqual(secondShotCreativeProjection({ ...accepted, setting: '北厅' }), original)
  assert.notDeepEqual(secondShotCreativeProjection({ ...accepted, unreviewedNewField: '剧情变更' }), original)
})

test('schema177 first-shot route has all admission nodes before original scene-02 at index65', () => {
  const runs = v7RouteFixture()
  assert.deepEqual(assertOriginalSecondShotArrivalRoute(runs), {
    firstImageIndex: 45, firstLastFrameIndex: 64, secondScriptIndex: 65,
    secondReviewIndex: 66, secondAcceptIndex: 67, firstShotCompleted: false,
  })
  const completed = structuredClone(runs)
  completed.slice(45, 65).forEach(run => { run.status = 'success' })
  assert.equal(assertOriginalSecondShotArrivalRoute(completed, true).secondScriptIndex, 65)
  const bypass = structuredClone(completed)
  bypass[59].status = 'idle'
  assert.throws(() => assertOriginalSecondShotArrivalRoute(bypass, true), /does not reach/)
  const shifted = structuredClone(runs)
  shifted[64].node.id = 'sanguo-shot-script'
  assert.throws(() => assertOriginalSecondShotArrivalRoute(shifted), /does not reach/)
})

function v7RepairFixture() {
  const runs = v7RouteFixture()
  const archive = { referenceBindings: [{ frontSha256: 'a'.repeat(64) },
    { frontSha256: 'b'.repeat(64) }] }
  const shot = { id: 'scene-01', action: 'approved original' }
  const plan = { shotId: 'scene-01' }
  runs[41].output = archive
  runs[43].output = plan
  runs[44].context = { shot_script: shot }
  const receipt = { version: 'scene-cut-rejected-image-edit-reference-v1',
    role: 'reference-only', sourceVerdict: 'rejected', approvedFirstFrame: false,
    requiresFreshIndependentReview: true, requiresPaidGateRevalidation: true,
    sourceExecutionId: v6Id, sourceResultMd5: v6Md5,
    sourceImageRunId: 'image-run', sourceImageUrl: '/generated/rejected.png',
    sourceImageSha256: failedImageSha, failedReviewRunId: 'review-run',
    failedReviewOutputSha256: failedReviewSha, failedReviewEvidenceUrl: '/generated/evidence.json',
    approvedShotSha256: sha256(shot), sourceArchiveSha256: sha256(archive),
    openingPlanSha256: sha256(plan), referenceOrder: [
      { position: 1, characterName: '张飞', frontUrl: '/generated/zhang.jpg',
        sha256: 'a'.repeat(64), bytes: 100 },
      { position: 2, characterName: '严颜', frontUrl: '/generated/yan.jpg',
        sha256: 'b'.repeat(64), bytes: 200 },
      { position: 3, role: 'rejected-edit-source', sourceUrl: '/generated/rejected.png',
        sourceSha256: failedImageSha, jpegSha256: 'c'.repeat(64), bytes: 300 },
    ], conversion: { version: 'rejected-png-to-jpeg-q90-444-v1', quality: 90,
      chromaSubsampling: '4:4:4', width: 64, height: 36 }, totalReferenceBytes: 600 }
  const prefixHash = createJsonHasher()(runs.slice(0, 45).map(run => run.output ?? null))
  const marker = { version: 'scene-cut-image-repair-schema177-fork-v1',
    sourceExecutionId: v6Id, sourceResultMd5: v6Md5,
    parentExecutionId: 'record-4x5m31-original-repair-v5',
    parentResultMd5: 'b5ac0f516ad8a44ca175e506aaccc67d',
    originalExecutionId: 'record-4x5m31', originalResultMd5: '74e5e2f8afcf8f829694aef350629950',
    workflowSchemaVersion: 177, workflowNodesMd5: workflow177.nodes_md5,
    workflowEdgesMd5: workflow177.edges_md5, preservedPrefixLength: 45,
    firstPendingNodeId: 'sanguo-scene-cut-first-frame',
    failedImageFileSha256: failedImageSha, failedReviewOutputSha256: failedReviewSha,
    repairPreparationSha256: sha256(receipt), preservedPrefixOutputsHash: prefixHash, receipt }
  const firstRecovery = { version: 'original-shot1-image-retry-schema177-fork-v1',
    sourceExecutionId: v6Id, sourceResultMd5: v6Md5, workflowSchemaVersion: 177,
    workflowNodesMd5: workflow177.nodes_md5, workflowEdgesMd5: workflow177.edges_md5,
    failedImageFileSha256: failedImageSha, failedReviewOutputSha256: failedReviewSha,
    repairPreparationSha256: marker.repairPreparationSha256,
    preservedPrefixOutputsHash: prefixHash }
  const state = { parentExecutionId: v6Id, nodeRuns: runs,
    sceneCutImageRepairRecovery: marker, sceneCutFirstFrameRecovery: firstRecovery,
    originalShot1ImageV7RetryRecovery: firstRecovery }
  return { state, marker, firstRecovery, runs, receipt, archive, shot, plan, prefixHash }
}

test('schema177 second-shot replay retains the signed v6 rejected-reference lineage', () => {
  const { state, marker } = v7RepairFixture()
  assert.equal(assertSchema177ImageRepairLineage(state, workflow177).repairPreparationSha256,
    marker.repairPreparationSha256)
  const tampered = structuredClone(state)
  tampered.sceneCutImageRepairRecovery.receipt.referenceOrder[1].sha256 = 'd'.repeat(64)
  assert.throws(() => assertSchema177ImageRepairLineage(tampered, workflow177), /not bound/)
  const replayRecovery = { version: 'original-second-shot-candidate-replay-schema177-fork-v1' }
  const replayed = { ...state, parentExecutionId: 'record-new-first-shot',
    secondShotReplayRecovery: replayRecovery, sceneCutFirstFrameRecovery: replayRecovery }
  assert.equal(assertSchema177ImageRepairLineage(replayed, workflow177, { replayed: true }).sourceExecutionId, v6Id)
})

test('schema178 replay binds four references through JSONB key reorder and rejects guide or prior edits', () => {
  const old = v7RepairFixture()
  const guidePath = 'qa/record-4x5m31/geometry-guide-v8-0d23d49f.png'
  const guideSha = '0d23d49f076dc1ce1e52a6de81f049d588499be720037755c73e3f8f9f0726b2'
  const guideProvenancePath = 'qa/record-4x5m31/geometry-guide-v8-provenance.json'
  const guideProvenanceSha = '4005ced1b6d381d8c474ec2e606186394509ec9a728c70f23009f3684cf84e2d'
  const sourceId = 'record-4x5m31-original-repair-v7'
  const sourceMd5 = '0c2421f0e2e33a563f73c44dea53d44f'
  const failedImage = '4218a56c75d532f7cf629176d73b7138c05e28be656c9ff5831568dc6828fb48'
  const failedReview = 'faad209cbc612d5eb67e2d32f2a668e0a15dc76fdb3cfa94bb4d4784902f2da2'
  const workflow178 = { schema_version: 178, nodes_md5: '2e68e68dea063bdb645523ef8a64ad6d',
    edges_md5: '1d0a75acb3d4778a122a4cfd96a23b49' }
  const receipt = { version: 'scene-cut-rejected-image-edit-reference-v2',
    role: 'reference-only', sourceVerdict: 'rejected', approvedFirstFrame: false,
    requiresFreshIndependentReview: true, requiresPaidGateRevalidation: true,
    sourceExecutionId: sourceId, sourceResultMd5: sourceMd5,
    sourceImageRunId: 'v7-image-run', sourceImageUrl: '/generated/v7-rejected.png',
    sourceImageSha256: failedImage, failedReviewRunId: 'v7-review-run',
    failedReviewOutputSha256: failedReview, failedReviewEvidenceUrl: '/generated/v7-evidence.json',
    approvedShotSha256: sha256(old.shot), sourceArchiveSha256: sha256(old.archive),
    openingPlanSha256: sha256(old.plan),
    priorRepairPreparationSha256: old.marker.repairPreparationSha256,
    priorRepairMarkerHash: createJsonHasher()(old.marker),
    geometryGuide: { role: 'geometry-only', identityAuthority: false,
      sourcePath: guidePath, sourceSha256: guideSha },
    referenceOrder: [
      ...old.receipt.referenceOrder.slice(0, 2),
      { position: 3, role: 'rejected-edit-source', sourceUrl: '/generated/v7-rejected.png',
        sourceSha256: failedImage, jpegSha256: '3'.repeat(64), bytes: 300 },
      { position: 4, role: 'geometry-guide', purpose: 'geometry-only', referenceOnly: true,
        sourcePath: guidePath, sourceSha256: guideSha, jpegSha256: '4'.repeat(64), bytes: 400 },
    ], conversion: { version: 'png-to-jpeg-q90-444-v1', quality: 90,
      chromaSubsampling: '4:4:4', rejectedDimensions: { width: 64, height: 36 },
      guideDimensions: { width: 80, height: 45 } }, totalReferenceBytes: 1000 }
  const sorted = (value: unknown): unknown => Array.isArray(value)
    ? value.map(sorted) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]))
      : value
  assert.equal(storedSceneCutRepairReceiptSha256(sorted(old.receipt)), old.marker.repairPreparationSha256)
  assert.equal(storedSceneCutRepairReceiptSha256(sorted(receipt)), sha256(receipt))
  const marker = { version: 'scene-cut-image-repair-schema178-fork-v2',
    sourceExecutionId: sourceId, sourceResultMd5: sourceMd5,
    parentExecutionId: v6Id, parentResultMd5: v6Md5,
    originalExecutionId: 'record-4x5m31', originalResultMd5: '74e5e2f8afcf8f829694aef350629950',
    workflowSchemaVersion: 178, workflowNodesMd5: workflow178.nodes_md5,
    workflowEdgesMd5: workflow178.edges_md5,
    preservedPrefixLength: 45, firstPendingNodeId: 'sanguo-scene-cut-first-frame',
    failedImageFileSha256: failedImage, failedReviewOutputSha256: failedReview,
    repairPreparationSha256: sha256(receipt),
    priorRepairPreparationSha256: old.marker.repairPreparationSha256,
    geometryGuideSourcePath: guidePath, geometryGuideSourceSha256: guideSha,
    geometryGuideJpegSha256: '4'.repeat(64),
    geometryGuideProvenancePath: guideProvenancePath,
    geometryGuideProvenanceSha256: guideProvenanceSha,
    preservedPrefixOutputsHash: old.prefixHash, receipt }
  const firstRecovery = { version: 'original-shot1-image-retry-schema178-fork-v1',
    sourceExecutionId: sourceId, sourceResultMd5: sourceMd5,
    workflowSchemaVersion: 178, workflowNodesMd5: workflow178.nodes_md5,
    workflowEdgesMd5: workflow178.edges_md5,
    failedImageFileSha256: failedImage, failedReviewOutputSha256: failedReview,
    repairPreparationSha256: marker.repairPreparationSha256,
    priorRepairPreparationSha256: marker.priorRepairPreparationSha256,
    geometryGuideSourceSha256: guideSha, geometryGuideJpegSha256: marker.geometryGuideJpegSha256,
    geometryGuideProvenanceSha256: guideProvenanceSha,
    preservedPrefixOutputsHash: old.prefixHash }
  const state = { ...old.state, parentExecutionId: sourceId,
    sceneCutFirstFrameRecovery: firstRecovery, originalShot1ImageV8RetryRecovery: firstRecovery,
    priorSceneCutImageRepairRecovery: old.marker, sceneCutImageRepairRecovery: marker }
  assert.equal(assertSchema178ImageRepairLineage(state, workflow178).repairPreparationSha256,
    marker.repairPreparationSha256)
  const tampered = structuredClone(state)
  tampered.sceneCutImageRepairRecovery.receipt.referenceOrder[3].sourceSha256 = '9'.repeat(64)
  assert.throws(() => assertSchema178ImageRepairLineage(tampered, workflow178), /lineage changed/)
  const replayRecovery = { version: 'original-second-shot-candidate-replay-schema178-fork-v1' }
  const replayed = { ...state, parentExecutionId: 'record-first-shot-v8',
    secondShotReplayRecovery: replayRecovery, sceneCutFirstFrameRecovery: replayRecovery }
  assert.equal(assertSchema178ImageRepairLineage(replayed, workflow178, { replayed: true }).sourceExecutionId,
    sourceId)

  const base = structuredClone(state)
  base.id = 'record-4x5m31-original-repair-v8'
  base.workflowId = 'wf-sanguo-history-drama'
  base.requestScopeId = 'record-4x5m31'
  base.generationScopeId = base.id
  base.nodeRuns[50].id = 'approval-run-0'
  base.nodeRuns[50].status = 'failed'
  const firstRetry = structuredClone(base)
  firstRetry.id = 'record-approval-retry-1'
  firstRetry.parentExecutionId = base.id
  firstRetry.generationScopeId = firstRetry.id
  firstRetry.nodeRuns[50] = { ...firstRetry.nodeRuns[50], status: 'failed', attempt: 1, revision: 1 }
  const final = structuredClone(firstRetry)
  final.id = 'record-approval-retry-2'
  final.parentExecutionId = firstRetry.id
  final.generationScopeId = final.id
  final.nodeRuns[50] = { ...final.nodeRuns[50], status: 'success', revision: 2,
    output: { passed: true, sourceSha256s: ['a'.repeat(64)],
      repairBinding: { version: 'scene-cut-image-repair-binding-v2',
        executionId: final.id, reviewSourceExecutionId: base.id,
        receipt: { preparationSha256: marker.repairPreparationSha256 },
        candidateImageSha256: 'a'.repeat(64) } } }
  const record = (value: typeof base, resultMd5: string) => ({ id: value.id,
    workflow_id: value.workflowId, result: value, result_md5: resultMd5 })
  const chain = [record(base, '1'.repeat(32)), record(firstRetry, '2'.repeat(32)),
    record(final, '3'.repeat(32))]
  const result = assertSchema178ApprovalRetryLineage(chain[2], workflow178, chain)
  assert.deepEqual(result.approvalRetryLineage.map(item => item.approvalRevision), [0, 1, 2])
  const changedPrefix = structuredClone(chain)
  changedPrefix[2].result.nodeRuns[45].output = { changed: true }
  assert.throws(() => assertSchema178ApprovalRetryLineage(changedPrefix[2], workflow178,
    changedPrefix), /changed reviewed media or revision/)
  const skippedRevision = structuredClone(chain)
  skippedRevision[2].result.nodeRuns[50].revision = 3
  assert.throws(() => assertSchema178ApprovalRetryLineage(skippedRevision[2], workflow178,
    skippedRevision), /changed reviewed media or revision/)
  const changedRepair = structuredClone(chain)
  changedRepair[1].result.sceneCutImageRepairRecovery.receipt.referenceOrder[3].sha256 = '0'.repeat(64)
  assert.throws(() => assertSchema178ApprovalRetryLineage(changedRepair[2], workflow178,
    changedRepair), /changed reviewed media or revision/)
  const wrongCertificate = structuredClone(chain)
  wrongCertificate[2].result.nodeRuns[50].output.repairBinding.reviewSourceExecutionId = firstRetry.id
  assert.throws(() => assertSchema178ApprovalRetryLineage(wrongCertificate[2], workflow178,
    wrongCertificate), /not bound to the descendant/)
})
