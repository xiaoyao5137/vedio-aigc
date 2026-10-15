/** Pure execution-record decisions shared by the UI driver's watch and step modes. */
import { isDeepStrictEqual } from 'node:util'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { forkBreakpointRollback } from '../src/breakpoint-rollback.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'

const hex = (value, length) => typeof value === 'string'
  && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)
const recoverySummary = value => value && typeof value === 'object' ? {
  version: value.version ?? null,
  workflowSchemaVersion: value.workflowSchemaVersion ?? null,
  sourceExecutionId: value.sourceExecutionId ?? null,
  sourceResultMd5: value.sourceResultMd5 ?? null,
  workflowNodesMd5: value.workflowNodesMd5 ?? null,
  workflowEdgesMd5: value.workflowEdgesMd5 ?? null,
  preservedPrefixLength: value.preservedPrefixLength ?? null,
  preservedPrefixSha256: value.preservedPrefixSha256 ?? null,
  firstPendingIndex: value.firstPendingIndex ?? null,
  firstPendingNodeId: value.firstPendingNodeId ?? null,
  firstShotPlanId: value.firstShotPlanId ?? null,
  firstShotManifestSha256: value.firstShotManifestSha256 ?? null,
  firstShotReceiptSha256: value.firstShotReceiptSha256 ?? null,
  firstActualTailSha256: value.firstActualTailSha256 ?? null,
  preservedPrefixOutputsHash: value.preservedPrefixOutputsHash ?? null,
  failedImageFileSha256: value.failedImageFileSha256 ?? null,
  failedReviewOutputSha256: value.failedReviewOutputSha256 ?? null,
  repairPreparationSha256: value.repairPreparationSha256 ?? null,
  firstShotImageRepairPreparationSha256: value.firstShotImageRepairPreparationSha256 ?? null,
  priorRepairPreparationSha256: value.priorRepairPreparationSha256 ?? null,
  geometryGuideSourcePath: value.geometryGuideSourcePath ?? null,
  geometryGuideSourceSha256: value.geometryGuideSourceSha256 ?? null,
  geometryGuideJpegSha256: value.geometryGuideJpegSha256 ?? null,
  geometryGuideProvenancePath: value.geometryGuideProvenancePath ?? null,
  geometryGuideProvenanceSha256: value.geometryGuideProvenanceSha256 ?? null,
} : null

const repairSummary = value => value && typeof value === 'object' ? {
  version: value.version ?? null,
  sourceExecutionId: value.sourceExecutionId ?? null,
  sourceResultMd5: value.sourceResultMd5 ?? null,
  parentExecutionId: value.parentExecutionId ?? null,
  parentResultMd5: value.parentResultMd5 ?? null,
  originalExecutionId: value.originalExecutionId ?? null,
  originalResultMd5: value.originalResultMd5 ?? null,
  workflowSchemaVersion: value.workflowSchemaVersion ?? null,
  workflowNodesMd5: value.workflowNodesMd5 ?? null,
  workflowEdgesMd5: value.workflowEdgesMd5 ?? null,
  preservedPrefixLength: value.preservedPrefixLength ?? null,
  firstPendingNodeId: value.firstPendingNodeId ?? null,
  preservedPrefixOutputsHash: value.preservedPrefixOutputsHash ?? null,
  failedImageFileSha256: value.failedImageFileSha256 ?? null,
  failedReviewOutputSha256: value.failedReviewOutputSha256 ?? null,
  repairPreparationSha256: value.repairPreparationSha256 ?? null,
  priorRepairPreparationSha256: value.priorRepairPreparationSha256 ?? null,
  geometryGuideSourcePath: value.geometryGuideSourcePath ?? null,
  geometryGuideSourceSha256: value.geometryGuideSourceSha256 ?? null,
  geometryGuideJpegSha256: value.geometryGuideJpegSha256 ?? null,
  geometryGuideProvenancePath: value.geometryGuideProvenancePath ?? null,
  geometryGuideProvenanceSha256: value.geometryGuideProvenanceSha256 ?? null,
} : null

const approvalRebindSummary = value => value && typeof value === 'object' ? {
  version: value.version ?? null,
  sourceExecutionId: value.sourceExecutionId ?? null,
  sourceResultMd5: value.sourceResultMd5 ?? null,
  workflowSchemaVersion: value.workflowSchemaVersion ?? null,
  workflowNodesMd5: value.workflowNodesMd5 ?? null,
  workflowEdgesMd5: value.workflowEdgesMd5 ?? null,
  preservedPrefixLength: value.preservedPrefixLength ?? null,
  firstPendingNodeId: value.firstPendingNodeId ?? null,
  nativeSourceExecutionId: value.nativeSourceExecutionId ?? null,
  nativeSourceResultMd5: value.nativeSourceResultMd5 ?? null,
  nativeReviewExecutionId: value.nativeReviewExecutionId ?? null,
  nativeReviewResultMd5: value.nativeReviewResultMd5 ?? null,
  tailGuideUrl: value.tailGuide?.url ?? null,
  tailGuideSha256: value.tailGuide?.fileSha256 ?? null,
} : null

const a8b6ConflictReviewSummary = value => value && typeof value === 'object' ? {
  version: value.version ?? null,
  sourceExecutionId: value.sourceExecutionId ?? null,
  sourceResultMd5: value.sourceResultMd5 ?? null,
  qaPlanId: value.qaPlanId ?? null,
  workflowSchemaVersion: value.workflowSchemaVersion ?? null,
  workflowNodesMd5: value.workflowNodesMd5 ?? null,
  workflowEdgesMd5: value.workflowEdgesMd5 ?? null,
  adjudicationReceiptSha256: value.adjudicationReceiptSha256 ?? null,
  preservedPrefixLength: value.preservedPrefixLength ?? null,
  preservedPrefixSha256: value.preservedPrefixSha256 ?? null,
  firstPendingIndex: value.firstPendingIndex ?? null,
  firstPendingNodeId: value.firstPendingNodeId ?? null,
} : null

const a8b6FreshFrameSummary = value => value && typeof value === 'object' ? {
  version: value.version ?? null,
  sourceExecutionId: value.sourceExecutionId ?? null,
  sourceResultMd5: value.sourceResultMd5 ?? null,
  rejectedExecutionId: value.rejectedExecutionId ?? null,
  rejectedResultMd5: value.rejectedResultMd5 ?? null,
  priorFreshExecutionId: value.priorFreshExecutionId ?? null,
  priorFreshResultMd5: value.priorFreshResultMd5 ?? null,
  priorFreshImageSha256: value.priorFreshImageSha256 ?? null,
  priorFreshReviewSha256: value.priorFreshReviewSha256 ?? null,
  editReceiptSha256: value.editReceiptSha256 ?? null,
  qaPlanId: value.qaPlanId ?? null,
  workflowSchemaVersion: value.workflowSchemaVersion ?? null,
  workflowNodesMd5: value.workflowNodesMd5 ?? null,
  workflowEdgesMd5: value.workflowEdgesMd5 ?? null,
  adjudicationReceiptSha256: value.adjudicationReceiptSha256 ?? null,
  rejectedImageSha256: value.rejectedImageSha256 ?? null,
  firstPromptSha256: value.firstPromptSha256 ?? null,
  reviewPromptSha256: value.reviewPromptSha256 ?? null,
  preservedPrefixLength: value.preservedPrefixLength ?? null,
  preservedPrefixSha256: value.preservedPrefixSha256 ?? null,
  firstPendingIndex: value.firstPendingIndex ?? null,
  firstPendingNodeId: value.firstPendingNodeId ?? null,
} : null

const a8b6LocalFrameSummary = value => value && typeof value === 'object' ? {
  version: value.version ?? null,
  sourceExecutionId: value.sourceExecutionId ?? null,
  sourceResultMd5: value.sourceResultMd5 ?? null,
  v7ExecutionId: value.v7ExecutionId ?? null,
  v7ResultMd5: value.v7ResultMd5 ?? null,
  v4ExecutionId: value.v4ExecutionId ?? null,
  v4ResultMd5: value.v4ResultMd5 ?? null,
  v8ExecutionId: value.v8ExecutionId ?? null,
  v8ResultMd5: value.v8ResultMd5 ?? null,
  v8RejectedReviewSha256: value.v8RejectedReviewSha256 ?? null,
  priorLocalV1ExecutionId: value.priorLocalV1ExecutionId ?? null,
  priorLocalV1ResultMd5: value.priorLocalV1ResultMd5 ?? null,
  priorLocalV1RejectedReviewSha256:
    value.priorLocalV1RejectedReviewSha256 ?? null,
  imageGenRawSha256: value.imageGenRawSha256 ?? null,
  imageGenPromptSha256: value.imageGenPromptSha256 ?? null,
  priorLocalV2ExecutionId: value.priorLocalV2ExecutionId ?? null,
  priorLocalV2ResultMd5: value.priorLocalV2ResultMd5 ?? null,
  priorLocalV2RejectedReviewSha256:
    value.priorLocalV2RejectedReviewSha256 ?? null,
  priorLocalV2ReviewModelExecutionId:
    value.priorLocalV2ReviewModelExecutionId ?? null,
  priorLocalV3ExecutionId: value.priorLocalV3ExecutionId ?? null,
  priorLocalV3ResultMd5: value.priorLocalV3ResultMd5 ?? null,
  priorLocalV3RejectedReviewSha256:
    value.priorLocalV3RejectedReviewSha256 ?? null,
  priorLocalV3ReviewModelExecutionId:
    value.priorLocalV3ReviewModelExecutionId ?? null,
  priorLocalV4ExecutionId: value.priorLocalV4ExecutionId ?? null,
  priorLocalV4FailedResultMd5:
    value.priorLocalV4FailedResultMd5 ?? null,
  priorLocalV4RejectedReviewSha256:
    value.priorLocalV4RejectedReviewSha256 ?? null,
  priorLocalV4ReviewModelExecutionId:
    value.priorLocalV4ReviewModelExecutionId ?? null,
  priorLocalV5ExecutionId: value.priorLocalV5ExecutionId ?? null,
  priorLocalV5ResultMd5: value.priorLocalV5ResultMd5 ?? null,
  priorLocalV5RejectedReviewSha256:
    value.priorLocalV5RejectedReviewSha256 ?? null,
  priorLocalV5ReviewModelExecutionId:
    value.priorLocalV5ReviewModelExecutionId ?? null,
  priorLocalV6ExecutionId: value.priorLocalV6ExecutionId ?? null,
  priorLocalV6ResultMd5: value.priorLocalV6ResultMd5 ?? null,
  priorLocalV6RejectedReviewSha256:
    value.priorLocalV6RejectedReviewSha256 ?? null,
  priorLocalV6ReviewModelExecutionId:
    value.priorLocalV6ReviewModelExecutionId ?? null,
  priorLocalV7ExecutionId: value.priorLocalV7ExecutionId ?? null,
  priorLocalV7ResultMd5: value.priorLocalV7ResultMd5 ?? null,
  priorLocalV7RejectedReviewSha256:
    value.priorLocalV7RejectedReviewSha256 ?? null,
  priorLocalV7ReviewModelExecutionId:
    value.priorLocalV7ReviewModelExecutionId ?? null,
  priorLocalV8ExecutionId: value.priorLocalV8ExecutionId ?? null,
  priorLocalV8ResultMd5: value.priorLocalV8ResultMd5 ?? null,
  priorLocalV8RejectedReviewSha256:
    value.priorLocalV8RejectedReviewSha256 ?? null,
  priorLocalV8ReviewModelExecutionId:
    value.priorLocalV8ReviewModelExecutionId ?? null,
  wallImageGenRawSha256: value.wallImageGenRawSha256 ?? null,
  faceImageGenRawSha256: value.faceImageGenRawSha256 ?? null,
  gateFrameImageGenRawSha256: value.gateFrameImageGenRawSha256 ?? null,
  sourceReceiptSha256: value.sourceReceiptSha256 ?? null,
  outputUrl: value.outputUrl ?? null,
  outputSha256: value.outputSha256 ?? null,
  workflowSchemaVersion: value.workflowSchemaVersion ?? null,
  workflowNodesMd5: value.workflowNodesMd5 ?? null,
  workflowEdgesMd5: value.workflowEdgesMd5 ?? null,
  preservedPrefixLength: value.preservedPrefixLength ?? null,
  preservedPrefixSha256: value.preservedPrefixSha256 ?? null,
  firstPendingIndex: value.firstPendingIndex ?? null,
  firstPendingNodeId: value.firstPendingNodeId ?? null,
  reviewPromptSha256: value.reviewPromptSha256 ?? null,
} : null

const a8b6FreshRouterSummary = value => value && typeof value === 'object' ? {
  version: value.version ?? null,
  frameProvenanceVariant: value.frameProvenanceVariant ?? null,
  imageApprovalExecutionId: value.imageApprovalExecutionId ?? null,
  imageApprovalResultMd5: value.imageApprovalResultMd5 ?? null,
  planId: value.planId ?? null,
  workflowApprovalSha256: value.workflowApprovalSha256 ?? null,
  workflowSchemaVersion: value.workflowSchemaVersion ?? null,
  workflowNodesMd5: value.workflowNodesMd5 ?? null,
  workflowEdgesMd5: value.workflowEdgesMd5 ?? null,
  preservedPrefixLength: value.preservedPrefixLength ?? null,
  preservedPrefixSha256: value.preservedPrefixSha256 ?? null,
  firstPendingIndex: value.firstPendingIndex ?? null,
  firstPendingNodeId: value.firstPendingNodeId ?? null,
} : null

const a8b6CompositeSummary = value => value && typeof value === 'object' ? {
  version: value.version ?? null,
  stagingVariant: value.stagingVariant ?? null,
  frameProvenanceVariant: value.frameProvenanceVariant ?? null,
  sourceExecutionId: value.sourceExecutionId ?? null,
  sourceResultMd5: value.sourceResultMd5 ?? null,
  imageApprovalExecutionId: value.imageApprovalExecutionId ?? null,
  imageApprovalResultMd5: value.imageApprovalResultMd5 ?? null,
  imageApprovalPrefixLength: value.imageApprovalPrefixLength ?? null,
  imageApprovalPrefixSha256: value.imageApprovalPrefixSha256 ?? null,
  workflowSchemaVersion: value.workflowSchemaVersion ?? null,
  workflowNodesMd5: value.workflowNodesMd5 ?? null,
  workflowEdgesMd5: value.workflowEdgesMd5 ?? null,
  originalExecutionId: value.originalExecutionId ?? null,
  planId: value.planId ?? null,
  manifestSha256: value.manifestSha256 ?? null,
  receiptSha256: value.receiptSha256 ?? null,
  workflowApprovalSha256: value.workflowApprovalSha256 ?? null,
  preservedPrefixLength: value.preservedPrefixLength ?? null,
  preservedPrefixSha256: value.preservedPrefixSha256 ?? null,
  compositeVideoUrl: value.compositeVideoUrl ?? null,
  compositeVideoSha256: value.compositeVideoSha256 ?? null,
  compositeTakeSha256: value.compositeTakeSha256 ?? null,
  firstPendingIndex: value.firstPendingIndex ?? null,
  firstPendingNodeId: value.firstPendingNodeId ?? null,
} : null

export function driveRecord(row) {
  const runs = Array.isArray(row.result?.nodeRuns) ? row.result.nodeRuns : []
  return {
    id: row.id,
    workflowId: row.workflow_id,
    requestScopeId: row.result?.requestScopeId || row.result?.id || row.id,
    parentExecutionId: row.result?.parentExecutionId ?? null,
    selectedNodeId: row.result?.selectedNodeId ?? null,
    sceneCutAutoRetry: row.result?.sceneCutAutoRetry ?? null,
    sceneCutFirstFrameRecovery: recoverySummary(row.result?.sceneCutFirstFrameRecovery),
    sceneCutImageRepairRecovery: repairSummary(row.result?.sceneCutImageRepairRecovery),
    sceneCutApprovalRebindRecovery: approvalRebindSummary(row.result?.sceneCutApprovalRebindRecovery),
    sceneCutA8B6ConflictReviewRecovery: a8b6ConflictReviewSummary(
      row.result?.sceneCutA8B6ConflictReviewRecovery),
    sceneCutA8B6FreshFrameRecovery: a8b6FreshFrameSummary(
      row.result?.sceneCutA8B6FreshFrameRecovery),
    sceneCutA8B6LocalFrameRecovery: a8b6LocalFrameSummary(
      row.result?.sceneCutA8B6LocalFrameRecovery),
    sceneCutA8B6FreshRouterRecovery: a8b6FreshRouterSummary(
      row.result?.sceneCutA8B6FreshRouterRecovery),
    sceneCutCompositeRecovery: a8b6CompositeSummary(
      row.result?.sceneCutCompositeRecovery),
    createdAt: row.created_at,
    runtimeInputs: row.runtime_inputs ?? {},
    runs: runs.map((run, index) => ({
      index,
      key: typeof run?.id === 'string' ? run.id : '',
      id: run?.node?.id ?? '',
      title: run?.node?.title ?? '',
      kind: run?.node?.kind ?? '',
      modelId: run?.node?.modelId ?? '',
      status: run?.status ?? 'idle',
      attempt: run?.attempt ?? 1,
      revision: run?.revision ?? 0,
      loopIndex: run?.loopIndex ?? undefined,
      durationMs: run?.durationMs ?? undefined,
      error: typeof run?.error === 'string' ? run.error : '',
      outputSummary: validOutputSummary(run?._driveOutput) ? run._driveOutput : driveOutputSummary(run?.output),
    })),
  }
}

/** Only the first unstarted script of a saved wf-story rollback may be driven
 * automatically. The full source/configuration comparison happens below. */
export function verifiedStoryScriptIdleContinuation(record, { workflowId, nodeId }) {
  const runs = record?.runs
  const target = runs?.[2]
  if (workflowId !== 'wf-story' || nodeId !== 'node-script'
    || record?.workflowId !== workflowId
    || !/^record-[\w-]+$/.test(record?.id ?? '')
    || !/^record-[\w-]+$/.test(record?.parentExecutionId ?? '')
    || record.id === record.parentExecutionId
    || record.selectedNodeId !== nodeId
    || !Array.isArray(runs) || runs.length < 4
    || runs[0]?.id !== 'node-input' || runs[1]?.id !== 'node-model-images'
    || runs.slice(0, 2).some(run => run.status !== 'success')
    || target?.id !== nodeId || target.status !== 'idle'
    || runs.slice(2).some(run => run.status !== 'idle')) {
    throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: expected the untouched wf-story script rollback')
  }
  return target
}

/** Rebuild the saved rollback from its current source and workflow definition.
 * A matching result proves the paid prefix, pending node contracts and lineage
 * are still exactly the ones the fork script prepared. This performs no writes. */
export function verifiedStoryScriptBreakpointFork(sourceRow, forkRow, workflowRow, {
  projectedResultMd5, expectedSourceMd5, expectedWorkflowNodesMd5, expectedWorkflowEdgesMd5,
} = {}) {
  const hex32 = value => typeof value === 'string' && /^[a-f\d]{32}$/i.test(value)
  if (sourceRow?.workflow_id !== 'wf-story' || forkRow?.workflow_id !== 'wf-story'
    || workflowRow?.id !== 'wf-story' || !Array.isArray(workflowRow.nodes)
    || !Array.isArray(workflowRow.edges) || !hex32(sourceRow.result_md5)
    || !hex32(forkRow.result_md5) || !hex32(workflowRow.nodes_md5)
    || !hex32(workflowRow.edges_md5)
    || (projectedResultMd5 && forkRow.result_md5 !== projectedResultMd5)
    || (expectedSourceMd5 && sourceRow.result_md5 !== expectedSourceMd5.toLowerCase())
    || (expectedWorkflowNodesMd5 && workflowRow.nodes_md5 !== expectedWorkflowNodesMd5.toLowerCase())
    || (expectedWorkflowEdgesMd5 && workflowRow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase())) {
    throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: wf-story source, fork or workflow lock differs')
  }
  const source = decodeExecutionState(sourceRow.result)
  const fork = decodeExecutionState(forkRow.result)
  const marker = fork?.breakpointRollback
  if (source?.id !== sourceRow.id || fork?.id !== forkRow.id
    || source?.workflowId !== 'wf-story' || fork?.workflowId !== 'wf-story'
    || fork?.parentExecutionId !== sourceRow.id
    || marker?.sourceExecutionId !== sourceRow.id
    || marker?.targetNodeId !== 'node-script'
    || marker?.targetRunId !== source.nodeRuns?.[2]?.id
    || marker?.preservedRunCount !== 2
    || !marker.createdAt || !Number.isFinite(Date.parse(marker.createdAt))
    || marker.breakpoint?.nodeId !== 'node-script'
    || marker.breakpoint?.enabled !== true
    || !Array.isArray(source.nodeRuns) || !Array.isArray(fork.nodeRuns)
    || source.nodeRuns[0]?.node?.id !== 'node-input'
    || source.nodeRuns[1]?.node?.id !== 'node-model-images'
    || source.nodeRuns[2]?.node?.id !== 'node-script'
    || source.nodeRuns.slice(0, 3).some(run => run.status !== 'success')
    || source.nodeRuns.some(run => run.status === 'running')) {
    throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: wf-story rollback ancestry differs')
  }
  const hash = createJsonHasher()
  const reconstructed = forkBreakpointRollback(source, {
    id: fork.id, createdAt: marker.createdAt, targetRunId: marker.targetRunId,
    breakpoints: [marker.breakpoint],
  })
  if (reconstructed.plan.targetIndex !== 2
    || hash(reconstructed.state.nodeRuns.slice(0, 2)) !== hash(source.nodeRuns.slice(0, 2))) {
    throw new Error('IDLE_CHECKPOINT_PREFIX_CHANGED: wf-story completed prefix differs')
  }
  const expected = { ...reconstructed.state,
    nodeRuns: refreshPendingExecutionNodes({ id: workflowRow.id,
      nodes: workflowRow.nodes, edges: workflowRow.edges }, reconstructed.state.nodeRuns) }
  if (hash(expected) !== hash(fork)) {
    throw new Error('IDLE_CHECKPOINT_STATE_MISMATCH: wf-story fork differs from the source and current workflow')
  }
  verifiedStoryScriptIdleContinuation(driveRecord(forkRow), {
    workflowId: 'wf-story', nodeId: 'node-script',
  })
  return { sourceResultMd5: sourceRow.result_md5,
    forkResultMd5: forkRow.result_md5,
    workflowNodesMd5: workflowRow.nodes_md5,
    workflowEdgesMd5: workflowRow.edges_md5,
    preservedPrefixHash: hash(source.nodeRuns.slice(0, 2)),
    firstPendingIndex: 2, firstPendingNodeId: 'node-script' }
}

/** A manually inserted scene-cut checkpoint may only start at its recorded
 * first idle run. This is stricter than ordinary resume and never requests a
 * failed-node retry. */
export function verifiedIdleContinuation(record, { workflowId, nodeId }) {
  const composite = record?.sceneCutCompositeRecovery
  if (composite?.version === 'source-bound-composite-a8b6-fresh-first-shot-v1') {
    const firstShotTailIds = [
      'sanguo-media-request', 'sanguo-video-evidence', 'sanguo-media-metrics',
      'sanguo-media-observe', 'sanguo-requirement-review', 'sanguo-media-review',
      'sanguo-media-accept', 'sanguo-duration-replan',
      'sanguo-media-accept-error-branch', 'sanguo-media-accept-accept-branch',
      'sanguo-video-concat', 'sanguo-last-frame',
    ]
    const variant = composite.frameProvenanceVariant
    const parentId = variant === 'a8b6-local-composite-v9'
      ? 'record-4x5m31-a8b6-local-v9-router-v1'
      : variant === 'a8b6-local-composite-v8'
        ? 'record-4x5m31-a8b6-local-v8-router-v1' : null
    const imageId = variant === 'a8b6-local-composite-v9'
      ? 'record-4x5m31-a8b6-local-wall-v9'
      : variant === 'a8b6-local-composite-v8'
        ? 'record-4x5m31-a8b6-local-wall-v8' : null
    const nextIndex = record?.runs?.findIndex((run, index) =>
      index >= 53 && run?.status === 'idle') ?? -1
    const run = record?.runs?.[nextIndex]
    if (record.workflowId !== workflowId
      || workflowId !== 'wf-sanguo-history-drama'
      || !/^record-[\w-]+$/.test(String(record.id))
      || record.id === parentId || record.id === imageId
      || !parentId || !imageId
      || record.parentExecutionId !== parentId
      || composite.sourceExecutionId !== parentId
      || !hex(composite.sourceResultMd5, 32)
      || composite.imageApprovalExecutionId !== imageId
      || !hex(composite.imageApprovalResultMd5, 32)
      || composite.imageApprovalPrefixLength !== 51
      || !hex(composite.imageApprovalPrefixSha256, 64)
      || composite.stagingVariant !== 'a8b6-fresh'
      || composite.originalExecutionId !== 'record-4x5m31'
      || composite.workflowSchemaVersion !== 180
      || composite.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || composite.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || !hex(composite.planId, 64)
      || !hex(composite.manifestSha256, 64)
      || !hex(composite.receiptSha256, 64)
      || !hex(composite.workflowApprovalSha256, 64)
      || composite.preservedPrefixLength !== 52
      || !hex(composite.preservedPrefixSha256, 64)
      || !/^\/generated\/[\w.-]+\.mp4$/.test(String(composite.compositeVideoUrl))
      || !hex(composite.compositeVideoSha256, 64)
      || !hex(composite.compositeTakeSha256, 64)
      || composite.firstPendingIndex !== 53
      || composite.firstPendingNodeId !== 'sanguo-media-request'
      || nextIndex < 53 || nextIndex > 64
      || ![nodeId, record.runs?.[nextIndex - 1]?.id]
        .includes(record.selectedNodeId)
      || !Array.isArray(record.runs) || record.runs.length !== 464
      || record.runs[52]?.id !== 'sanguo-video'
      || record.runs[52].status !== 'success'
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0
      || firstShotTailIds.some((id, offset) =>
        record.runs[53 + offset]?.id !== id
          || record.runs[53 + offset]?.loopIndex !== 0)
      || record.runs.slice(0, 53).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(53, nextIndex).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(nextIndex + 1).some(next => next.status !== 'idle'))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: fresh composite continuation changed')
    return run
  }
  if (['record-4x5m31-a8b6-local-v7-router-v1',
    'record-4x5m31-a8b6-local-v8-router-v1',
    'record-4x5m31-a8b6-local-v9-router-v1'].includes(record?.id)) {
    const isV9 = record.id === 'record-4x5m31-a8b6-local-v9-router-v1'
    const isV8 = record.id === 'record-4x5m31-a8b6-local-v8-router-v1'
    const marker = record.sceneCutA8B6FreshRouterRecovery
    const run = record.runs?.[51]
    if (record.workflowId !== workflowId
      || workflowId !== 'wf-sanguo-history-drama'
      || record.parentExecutionId
        !== (isV9 ? 'record-4x5m31-a8b6-local-wall-v9'
          : isV8 ? 'record-4x5m31-a8b6-local-wall-v8'
          : 'record-4x5m31-a8b6-local-wall-v7')
      || marker?.version !== 'scene-cut-a8b6-fresh-router-v1'
      || (isV9 || isV8
        ? marker.frameProvenanceVariant
          !== `a8b6-local-composite-${isV9 ? 'v9' : 'v8'}`
        : marker.frameProvenanceVariant != null)
      || marker.imageApprovalExecutionId !== record.parentExecutionId
      || !hex(marker.imageApprovalResultMd5, 32)
      || !hex(marker.planId, 64)
      || !hex(marker.workflowApprovalSha256, 64)
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 51
      || !hex(marker.preservedPrefixSha256, 64)
      || marker.firstPendingIndex !== 51
      || marker.firstPendingNodeId !== 'sanguo-video-reference-router'
      || nodeId !== marker.firstPendingNodeId
      || record.selectedNodeId !== nodeId
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 51).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(51).some(next => next.status !== 'idle'))
      throw new Error(`IDLE_CHECKPOINT_IDENTITY_MISMATCH: ${isV9 ? 'V9' : isV8 ? 'V8' : 'V7'} router changed`)
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-wall-v9') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v9'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.priorLocalV8ExecutionId
        !== 'record-4x5m31-a8b6-local-wall-v8'
      || marker.priorLocalV8ResultMd5
        !== '78af4d43b6cec6f7e39f6e67122c2b87'
      || marker.priorLocalV8RejectedReviewSha256
        !== 'bb6825533ee8d4040edbe1ebbefde899c27b20c77e43b8c1e56ef98c90b53928'
      || marker.priorLocalV8ReviewModelExecutionId
        !== 'model-run-mun4uzrd-fckgr7r'
      || !hex(marker.wallImageGenRawSha256, 64)
      || !hex(marker.sourceReceiptSha256, 64)
      || !hex(marker.outputSha256, 64)
      || !/^\/generated\/image-[a-f0-9]{32}\.png$/.test(marker.outputUrl)
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || marker.reviewPromptSha256
        !== '2bf1a767ac99e97c78ff50880aaa700f08d1eafdd842e86d4e22276bf40c7439'
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local v9 first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-wall-v8') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v8'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.priorLocalV7ExecutionId
        !== 'record-4x5m31-a8b6-local-wall-v7'
      || marker.priorLocalV7ResultMd5
        !== '1ec864753478fe0b6fbe6e2065be0835'
      || marker.priorLocalV7RejectedReviewSha256
        !== 'a12d43382d9800443dea140f1c0cd6102cdede9323d0a6a4ff3427a62b0f4698'
      || marker.priorLocalV7ReviewModelExecutionId
        !== 'model-run-mun3j1q3-0x8y0hw'
      || marker.wallImageGenRawSha256
        !== '3e185620ce34d0d98af75b032a1b1db9c15cd51cf649cbdcbab1ab3f180e4cc6'
      || marker.sourceReceiptSha256
        !== 'f8a614a81246365796f900b70dd436af7819e6b7414392e0b4fd6402e992832b'
      || marker.outputSha256
        !== '8149dea0eb98744508ac0615d37d70dcede1d8859c25c0edf301909748a4fb90'
      || marker.outputUrl
        !== '/generated/image-8149dea0eb98744508ac0615d37d70dc.png'
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || marker.reviewPromptSha256
        !== '142f11602d7b173385df92b08f6b9640ef2e97c9431d49a2190de4337d27a795'
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local v8 first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-wall-v7') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v7'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.priorLocalV6ExecutionId
        !== 'record-4x5m31-a8b6-local-wall-v6'
      || marker.priorLocalV6ResultMd5
        !== 'dbe80e1e81015fcf6b3779aa23901261'
      || marker.priorLocalV6RejectedReviewSha256
        !== 'd780dbaf25f60b1596a158b5b1bb3f69f710640e17a37b42ed73d1a9dd665a76'
      || marker.priorLocalV6ReviewModelExecutionId
        !== 'model-run-mun2bvxz-mmbkgki'
      || marker.wallImageGenRawSha256
        !== '58334a7ad12d7d50ce44a2d89f0b9959e2a755c7f18ed4f18114eac51e2ab1fe'
      || marker.sourceReceiptSha256
        !== '986763c1b90ec4b5482b4fa52dbadb42e825e3cf26ed5e28c0ac12a9b50c4e6d'
      || marker.outputSha256
        !== '6b7e52ceccf7493bbb1a473ab4e0f68216aa65ae02c03945de5bc69fb52a6c71'
      || marker.outputUrl
        !== '/generated/image-6b7e52ceccf7493bbb1a473ab4e0f682.png'
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || marker.reviewPromptSha256
        !== 'd89c5588deb01c417c2af0574f0015e191ed15f50aef97e386f56d35a47f5b1f'
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local v7 first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-wall-v6') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v6'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.priorLocalV5ExecutionId
        !== 'record-4x5m31-a8b6-local-wall-v5'
      || marker.priorLocalV5ResultMd5
        !== 'b83654e5a7ecf499fd866c5fe78689e0'
      || marker.priorLocalV5RejectedReviewSha256
        !== 'fba0e0ade93cb6210e91f6ca73495ce947508f60549d5350cce0c8766cfe7bef'
      || marker.priorLocalV5ReviewModelExecutionId
        !== 'model-run-mun1hnww-cv9lzdx'
      || marker.wallImageGenRawSha256
        !== 'd5e50f7fa2b9b6e4dcbc046ddea613af9bd3bbdca938787e178c7abbf3d53fe9'
      || marker.sourceReceiptSha256
        !== '93d5ac1040ab17e9dd68f3b2e9b4b3eed835d4ba3461fbd3ed117fc9c725dc11'
      || marker.outputSha256
        !== '62ffed8c2f94027ce519061bc2979c61aea1b71210d5c43763cfc96fc1c34254'
      || marker.outputUrl
        !== '/generated/image-62ffed8c2f94027ce519061bc2979c61.png'
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || marker.reviewPromptSha256
        !== '95fa03dd3d7c9474203e33306284d2005c8c3cec220172ba5c9810da33a14eda'
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local v6 first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-wall-v5') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v5'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.priorLocalV4ExecutionId
        !== 'record-4x5m31-a8b6-local-wall-v4'
      || marker.priorLocalV4FailedResultMd5
        !== 'ecd4fe2f2ec5809388a3365aa06523e8'
      || marker.priorLocalV4RejectedReviewSha256
        !== 'd60200bcba71d976ad351b38af1e472c44d81dbc6935b0969e4e7d9e83fac0ac'
      || marker.priorLocalV4ReviewModelExecutionId
        !== 'model-run-mun0ctyo-efttaa2'
      || marker.wallImageGenRawSha256
        !== '245510205d5886d1884f64396e4fa97b6c5e40f5f53a1cbef1a2704d29048dc6'
      || marker.sourceReceiptSha256
        !== '6559bb5def38cf78d269d8118a2a43b38e81f115b6a6509552d901b1cdb64453'
      || marker.outputSha256
        !== '46009d665c617828d2cd87542ee5032a337c4f7b0b14e1291766f8533fe24c95'
      || marker.outputUrl
        !== '/generated/image-46009d665c617828d2cd87542ee5032a.png'
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || marker.reviewPromptSha256
        !== 'f13538320c9d566bf01725e7e7e57be71fff43ae394f80ca9b442c4969422dff'
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local v5 first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-wall-v4') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v4'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.priorLocalV3ExecutionId
        !== 'record-4x5m31-a8b6-local-face-wall-v3'
      || marker.priorLocalV3ResultMd5
        !== '05e7d2b9df9aa48a05e5d123da405de6'
      || marker.priorLocalV3RejectedReviewSha256
        !== '3570c7f23ce35b2c60ce14ab47885970bf7a9742c6363313663b0b8afa51b1fe'
      || marker.priorLocalV3ReviewModelExecutionId
        !== 'model-run-mumy086h-a3obbjv'
      || marker.wallImageGenRawSha256
        !== '241ff3bbb9b100385e1c2dd01dc79124523111242bf0da29660711da1e9015c3'
      || marker.sourceReceiptSha256
        !== '6115e88e135054dd55e1ac96bc4ddf4ece6d260549812fd3bf009622c104df47'
      || marker.outputSha256
        !== 'de30188b2385c89494a294557044a0b0f7d42aefb82d090c7ab31dd7cf28861c'
      || marker.outputUrl
        !== '/generated/image-de30188b2385c89494a294557044a0b0.png'
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || marker.reviewPromptSha256
        !== '0070e5bb385b26e81dc6e38da5942a4f9a6a48e9ed7995de561dffe593798c6e'
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local v4 first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-face-wall-v3') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v3'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.priorLocalV2ExecutionId
        !== 'record-4x5m31-a8b6-local-face-v2'
      || marker.priorLocalV2ResultMd5
        !== 'ab73ca2d9c995c154c064f8a1f5a85c9'
      || marker.priorLocalV2RejectedReviewSha256
        !== 'd258b5995d1bbb9cfcf2972ac42432e33c56d5d5f2edbae4572b603c29738d90'
      || marker.priorLocalV2ReviewModelExecutionId
        !== 'model-run-mumvkgzt-ucbr3si'
      || marker.wallImageGenRawSha256
        !== '3af90de3b8af4b87e484b7f576e4e84c22f9df4ff12de6b780ec3e35efc70f9a'
      || marker.faceImageGenRawSha256
        !== 'ce9820011e1df7e5380c6d9270649a0c201e8edab80c8530c0e0fda45f2b1e9d'
      || marker.gateFrameImageGenRawSha256
        !== '89123113a9a0ff726542fd643c05c5b2992adcf570ba181ff58de63239338df2'
      || marker.sourceReceiptSha256
        !== '4c8cb5cf603be7eea97115c1c0d499b81550a26a91ef0794a7307e55a5a50fa4'
      || marker.outputSha256
        !== '7313b043adc16dc9fc7f6ee7512f2a377f8218e6e0fba11bea91ef943fc7fac7'
      || marker.outputUrl
        !== '/generated/image-7313b043adc16dc9fc7f6ee7512f2a37.png'
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || !hex(marker.reviewPromptSha256, 64)
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local v3 first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-face-v2') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record?.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId
        !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v2'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.v7ExecutionId
        !== 'record-4x5m31-a8b6-fresh-v7-dual-output-recovery'
      || marker.v7ResultMd5 !== '474085677d68cea9f0cb436e06bf71af'
      || marker.v4ExecutionId
        !== 'record-4x5m31-a8b6-fresh-first-frame-v4-edit'
      || marker.v4ResultMd5 !== 'bc5b2614194cd18fef359520bf010a11'
      || marker.v8ExecutionId
        !== 'record-4x5m31-a8b6-fresh-first-frame-v8-edit'
      || marker.v8ResultMd5 !== 'c0d9ba72214c3ba539d5957385f605a6'
      || marker.v8RejectedReviewSha256
        !== '2e92771cca94bfb59a1872a9ee127a29a23eeffad69352efc73f315ebca0be73'
      || marker.priorLocalV1ExecutionId
        !== 'record-4x5m31-a8b6-local-face-v1'
      || marker.priorLocalV1ResultMd5
        !== '43176cd739ba633eaa0568a827d9c4b4'
      || marker.priorLocalV1RejectedReviewSha256
        !== '00071a2d91b9c1fe3a917c424056ed068e552d98d04f02e6f48380ec479bce4a'
      || marker.imageGenRawSha256
        !== '1494cbd3acc592bdf181723115fdb653215c95071b35e8424f9d360c9769b4df'
      || marker.imageGenPromptSha256
        !== '9ac1398b961ee66c3dfac76f89d88c1e57962a666b78da338eb7c744dfc85f9e'
      || marker.outputSha256
        !== '63a701c1c4b38ae9fa04c450d13b8089b3220977ea2df55d86061c7a75e1d0f5'
      || marker.outputUrl
        !== '/generated/image-63a701c1c4b38ae9fa04c450d13b8089.png'
      || !hex(marker.sourceReceiptSha256, 64)
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5
        !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5
        !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || marker.reviewPromptSha256
        !== '91ce65e3582fe906549cc8011d3ad3a2948e854694c27683587818571ee2e458'
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local v2 first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-local-face-v1') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record?.runs?.[forApproval ? 50 : 46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId
        !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-local-first-frame-v1'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.v7ExecutionId
        !== 'record-4x5m31-a8b6-fresh-v7-dual-output-recovery'
      || marker.v7ResultMd5 !== '474085677d68cea9f0cb436e06bf71af'
      || marker.v4ExecutionId
        !== 'record-4x5m31-a8b6-fresh-first-frame-v4-edit'
      || marker.v4ResultMd5 !== 'bc5b2614194cd18fef359520bf010a11'
      || marker.v8ExecutionId
        !== 'record-4x5m31-a8b6-fresh-first-frame-v8-edit'
      || marker.v8ResultMd5 !== 'c0d9ba72214c3ba539d5957385f605a6'
      || marker.v8RejectedReviewSha256
        !== '2e92771cca94bfb59a1872a9ee127a29a23eeffad69352efc73f315ebca0be73'
      || marker.sourceReceiptSha256
        !== '16a0e173ddf353a5c3eb4c7440551f14109b26dea9692c4c7d600ad3d93312fa'
      || marker.outputUrl
        !== '/generated/image-f0c8fcc82fae74e8d736bb5e099471a7.png'
      || marker.outputSha256
        !== 'f0c8fcc82fae74e8d736bb5e099471a799280db5e7b9d64b4e149efc26314ba1'
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5
        !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5
        !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || marker.preservedPrefixLength !== 45
      || marker.preservedPrefixSha256
        !== '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00'
      || marker.firstPendingIndex !== 46
      || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
      || !hex(marker.reviewPromptSha256, 64)
      || ![marker.firstPendingNodeId,
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(46, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].outputSummary?.hasOutput !== true
          || record.runs[49].outputSummary?.rejectedFlag !== null
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : record.runs.slice(46).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: local first frame changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-fresh-first-frame-v8-edit') {
    const marker = record.sceneCutA8B6FreshFrameRecovery
    const afterImage = nodeId === 'sanguo-map-end-accept'
    const forApproval = nodeId === 'sanguo-scene-cut-approval'
    const run = record?.runs?.[forApproval ? 50 : afterImage ? 46 : 45]
    if (record.workflowId !== workflowId
      || record.parentExecutionId
        !== 'record-4x5m31-a8b6-timing-approval-v3'
      || marker?.version !== 'scene-cut-a8b6-fresh-first-frame-v8-edit'
      || marker.sourceExecutionId !== record.parentExecutionId
      || marker.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || marker.priorFreshExecutionId
        !== 'record-4x5m31-a8b6-fresh-v7-dual-output-recovery'
      || marker.priorFreshResultMd5 !== '474085677d68cea9f0cb436e06bf71af'
      || marker.priorFreshImageSha256
        !== 'b96d9804eb28771cbe2cc2d5d6edc532ab3275abcbc71a4155e2da6d05b782be'
      || marker.priorFreshReviewSha256
        !== 'a38fdfaf7aff5d1f9a43ac0b1b71b27141899c37fc3026d1c1f8862797eace5c'
      || marker.editReceiptSha256
        !== 'ce8f4c2186a8460f8686d0caf04d51ffd218bfa36e16596f618cf4bbfa9639e2'
      || marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || !hex(marker.firstPromptSha256, 64)
      || !hex(marker.reviewPromptSha256, 64)
      || !hex(marker.preservedPrefixSha256, 64)
      || marker.preservedPrefixLength !== 45
      || marker.firstPendingIndex !== 45
      || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
      || ![marker.firstPendingNodeId, 'sanguo-map-end-accept',
        'sanguo-scene-cut-approval'].includes(nodeId)
      || record.selectedNodeId !== (forApproval
        ? 'sanguo-scene-cut-review' : marker.firstPendingNodeId)
      || run?.id !== nodeId || run.status !== 'idle'
      || run.loopIndex !== 0 || record.runs?.length !== 464
      || record.runs.slice(0, 45).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || (forApproval
        ? record.runs.slice(45, 50).some(prior =>
            !['success', 'skipped'].includes(prior.status))
          || record.runs[49]?.status !== 'success'
          || record.runs[49].output?.passed !== true
          || !isDeepStrictEqual(record.runs[49].output?.issues, [])
          || record.runs.slice(50).some(next => next.status !== 'idle')
        : afterImage
          ? record.runs[45]?.status !== 'success'
            || record.runs.slice(46).some(next => next.status !== 'idle')
          : record.runs.slice(45).some(next => next.status !== 'idle')))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: V8 face edit changed')
    return run
  }
  if (record?.id === 'record-4x5m31-a8b6-fresh-v7-dual-output-recovery') {
    const run = record?.runs?.[46]
    if (record.workflowId !== workflowId
      || record.parentExecutionId
        !== 'record-4x5m31-a8b6-fresh-first-frame-v7-edit'
      || record.selectedNodeId !== 'sanguo-map-end-accept'
      || nodeId !== 'sanguo-map-end-accept'
      || run?.id !== nodeId || run.status !== 'idle' || run.loopIndex !== 0
      || record.runs?.length !== 464
      || record.runs.slice(0, 46).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(46).some(next => next.status !== 'idle'))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: V7 dual-output child changed')
    return run
  }
  const scene2 = record?.sceneCutFirstFrameRecovery
  if (scene2?.version === 'a8b6-fresh-scene2-script-replay-v1') {
    const run = record?.runs?.[66]
    if (record.workflowId !== workflowId
      || record.parentExecutionId !== scene2.sourceExecutionId
      || !/^record-[\w-]+$/.test(String(scene2.sourceExecutionId))
      || !hex(scene2.sourceResultMd5, 32)
      || scene2.workflowSchemaVersion !== 180
      || scene2.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || scene2.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || scene2.preservedPrefixLength !== 66
      || !hex(scene2.preservedPrefixSha256, 64)
      || scene2.firstPendingIndex !== 66
      || scene2.firstPendingNodeId !== 'sanguo-shot-script-review'
      || !hex(scene2.firstShotPlanId, 64)
      || !hex(scene2.firstShotManifestSha256, 64)
      || !hex(scene2.firstShotReceiptSha256, 64)
      || !hex(scene2.firstActualTailSha256, 64)
      || nodeId !== 'sanguo-shot-script-review'
      || record.selectedNodeId !== nodeId
      || run?.id !== nodeId || run.status !== 'idle' || run.loopIndex !== 1
      || record.runs.slice(0, 66).some(prior =>
        !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(66).some(next => next.status !== 'idle'))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: fresh 14s scene-02 replay changed')
    return run
  }
  const fresh = record?.sceneCutA8B6FreshFrameRecovery
  if (fresh?.version === 'scene-cut-a8b6-fresh-first-frame-v4-edit') {
    const run = record?.runs?.[45]
    if (record.id !== 'record-4x5m31-a8b6-fresh-first-frame-v4-edit'
      || record.workflowId !== workflowId
      || record.parentExecutionId !== fresh.sourceExecutionId
      || fresh.sourceExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || fresh.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || fresh.priorFreshExecutionId !== 'record-4x5m31-a8b6-fresh-first-frame-v3'
      || fresh.priorFreshResultMd5 !== '80d3d76fb68ef45b82f198837c8e182e'
      || fresh.priorFreshImageSha256 !== 'd8944a9e69d092a95990574615e375b0dd024cd47d8742abbb3a8f964cab9c3c'
      || fresh.priorFreshReviewSha256 !== '0c357695cf19160a60515a8b284e9f0a67a54ba6e8573eb1274f5fa7d3f117e9'
      || !hex(fresh.editReceiptSha256, 64)
      || fresh.workflowSchemaVersion !== 180
      || fresh.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || fresh.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || !hex(fresh.firstPromptSha256, 64)
      || !hex(fresh.reviewPromptSha256, 64)
      || !hex(fresh.preservedPrefixSha256, 64)
      || fresh.preservedPrefixLength !== 45
      || fresh.firstPendingIndex !== 45
      || fresh.firstPendingNodeId !== nodeId
      || nodeId !== 'sanguo-scene-cut-first-frame'
      || record.selectedNodeId !== nodeId
      || run?.id !== nodeId || run.status !== 'idle' || run.loopIndex !== 0
      || record.runs.slice(0, 45).some(prior => !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(45).some(next => next.status !== 'idle'))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: A8B6 v4 edit changed')
    return run
  }
  if (fresh?.version === 'scene-cut-a8b6-fresh-first-frame-v3') {
    const run = record?.runs?.[45]
    if (record.id !== 'record-4x5m31-a8b6-fresh-first-frame-v3'
      || record.workflowId !== workflowId
      || record.parentExecutionId !== fresh.sourceExecutionId
      || fresh.sourceExecutionId !== 'record-4x5m31-a8b6-timing-approval-v3'
      || fresh.sourceResultMd5 !== '7024e0652a9fd878ef00a5a2dcec99f8'
      || fresh.rejectedExecutionId !== 'record-4x5m31-a8b6-frame-conflict-review-v1'
      || fresh.rejectedResultMd5 !== 'de84b207979a369a455f4f2ce39c1b22'
      || fresh.priorFreshExecutionId !== 'record-4x5m31-a8b6-fresh-first-frame-v2'
      || fresh.priorFreshResultMd5 !== '078812c4cb3c830c3515e6bbc907753d'
      || fresh.priorFreshImageSha256 !== '18e4feab5da795450b653bed01967251e96427e8d88ef86527a1470b6e3c97c8'
      || !hex(fresh.priorFreshReviewSha256, 64)
      || fresh.workflowSchemaVersion !== 180
      || fresh.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || fresh.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || !hex(fresh.adjudicationReceiptSha256, 64)
      || !hex(fresh.rejectedImageSha256, 64)
      || !hex(fresh.firstPromptSha256, 64)
      || !hex(fresh.reviewPromptSha256, 64)
      || !hex(fresh.preservedPrefixSha256, 64)
      || fresh.preservedPrefixLength !== 45
      || fresh.firstPendingIndex !== 45
      || fresh.firstPendingNodeId !== nodeId
      || nodeId !== 'sanguo-scene-cut-first-frame'
      || record.selectedNodeId !== nodeId
      || run?.id !== nodeId || run.status !== 'idle' || run.loopIndex !== 0
      || record.runs.slice(0, 45).some(prior => !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(45).some(next => next.status !== 'idle'))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: A8B6 fresh first frame changed')
    return run
  }
  const conflict = record?.sceneCutA8B6ConflictReviewRecovery
  if (conflict?.version === 'scene-cut-a8b6-conflict-review-retry-v1') {
    const run = record?.runs?.[49]
    if (record.id !== 'record-4x5m31-a8b6-frame-conflict-review-v1'
      || record.workflowId !== workflowId
      || record.parentExecutionId !== conflict.sourceExecutionId
      || conflict.sourceExecutionId !== 'record-4x5m31-a8b6-frame-reuse-v3'
      || conflict.sourceResultMd5 !== '01146ea0d4a7c0d6664f65d5eb9bc54e'
      || conflict.workflowSchemaVersion !== 180
      || conflict.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || conflict.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || conflict.qaPlanId !== 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'
      || !hex(conflict.adjudicationReceiptSha256, 64)
      || !hex(conflict.preservedPrefixSha256, 64)
      || conflict.preservedPrefixLength !== 49
      || conflict.firstPendingIndex !== 49
      || conflict.firstPendingNodeId !== nodeId
      || nodeId !== 'sanguo-scene-cut-review'
      || record.selectedNodeId !== nodeId
      || run?.id !== nodeId || run.status !== 'idle' || run.loopIndex !== 0
      || record.runs.slice(0, 49).some(prior => !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(49).some(next => next.status !== 'idle'))
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: A8B6 conflict retry changed')
    return run
  }
  const approvalRebind = record?.sceneCutApprovalRebindRecovery
  if (approvalRebind?.version === 'scene-cut-approval-rebind-v2') {
    const index = approvalRebind.preservedPrefixLength
    const run = record?.runs?.[index]
    if (record.workflowId !== workflowId || record.parentExecutionId !== approvalRebind.sourceExecutionId
      || approvalRebind.workflowSchemaVersion !== 180
      || approvalRebind.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || approvalRebind.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
      || !hex(approvalRebind.sourceResultMd5, 32)
      || approvalRebind.nativeSourceExecutionId !== 'record-levw1e'
      || approvalRebind.nativeSourceResultMd5 !== 'a06fb401d4655699fce3ec69548e578c'
      || approvalRebind.nativeReviewExecutionId !== 'record-9p80o5'
      || approvalRebind.nativeReviewResultMd5 !== '4282a0710daef80462a46423391be68f'
      || approvalRebind.tailGuideUrl !== '/generated/verified-native-4d52c9bef3e2e5097d1a-7de488acbb85c4cc-frame-312.jpg'
      || approvalRebind.tailGuideSha256 !== '99fc24c072eb7e2829a1919483f5957d18de59b05b1905a7f53d4ac57e9b3aeb') {
      throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: native-tail rebind identity changed')
    }
    if (index !== 50 || approvalRebind.firstPendingNodeId !== nodeId
      || nodeId !== 'sanguo-scene-cut-approval'
      || record.selectedNodeId !== nodeId || run?.id !== nodeId
      || run.status !== 'idle' || run.loopIndex !== 0
      || record.runs.slice(0, index).some(prior => !['success', 'skipped'].includes(prior.status))
      || record.runs.slice(index).some(next => next.status !== 'idle')) {
      throw new Error('IDLE_CHECKPOINT_STATE_MISMATCH: native-tail rebind checkpoint advanced')
    }
    return run
  }
  const recovery = record?.sceneCutFirstFrameRecovery
  const supported = new Map([
    ['scene-cut-first-frame-schema165-fork-v1', 165],
    ['scene-cut-opening-state-schema166-fork-v1', 166],
    ['scene-cut-t0-image-schema167-fork-v1', 167],
    ['scene-cut-opening-plan-schema168-fork-v1', 168],
    ['scene-cut-travel-start-schema169-fork-v1', 169],
    ['scene-cut-opening-projection-schema170-fork-v1', 170],
    ['original-two-shot-content-lock-schema171-fork-v1', 171],
    ['original-second-shot-candidate-replay-schema171-fork-v1', 171],
    ['original-shot1-opening-retry-schema172-fork-v1', 172],
    ['original-second-shot-candidate-replay-schema172-fork-v1', 172],
    ['original-shot1-image-retry-schema173-fork-v1', 173],
    ['original-second-shot-candidate-replay-schema173-fork-v1', 173],
    ['original-shot1-image-retry-schema174-fork-v1', 174],
    ['original-second-shot-candidate-replay-schema174-fork-v1', 174],
    ['original-shot1-image-retry-schema175-fork-v1', 175],
    ['original-shot1-image-retry-schema176-fork-v1', 176],
    ['original-second-shot-candidate-replay-schema175-fork-v1', 175],
    ['original-second-shot-candidate-replay-schema176-fork-v1', 176],
    ['original-shot1-image-retry-schema177-fork-v1', 177],
    ['original-second-shot-candidate-replay-schema177-fork-v1', 177],
    ['original-shot1-image-retry-schema178-fork-v1', 178],
    ['original-second-shot-candidate-replay-schema178-fork-v1', 178],
  ])
  const expectedLoopIndex = /^original-second-shot-candidate-replay-schema17[12345678]-fork-v1$/.test(recovery?.version ?? '') ? 1 : 0
  if (record?.workflowId !== workflowId || !recovery
    || recovery.workflowSchemaVersion !== supported.get(recovery.version)
    || record.parentExecutionId !== recovery.sourceExecutionId
    || !/^[a-f0-9]{32}$/i.test(recovery.sourceResultMd5 ?? '')
    || !/^[a-f0-9]{32}$/i.test(recovery.workflowNodesMd5 ?? '')
    || (recovery.workflowEdgesMd5 !== null && !/^[a-f0-9]{32}$/i.test(recovery.workflowEdgesMd5 ?? ''))) {
    throw new Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: expected a reviewed opening-frame migration fork')
  }
  if ([177, 178].includes(recovery.workflowSchemaVersion)) {
    const marker = record.sceneCutImageRepairRecovery
    const schema = recovery.workflowSchemaVersion
    const first = recovery.version === `original-shot1-image-retry-schema${schema}-fork-v1`
    if (marker?.version !== (schema === 177
      ? 'scene-cut-image-repair-schema177-fork-v1' : 'scene-cut-image-repair-schema178-fork-v2')
      || marker.workflowSchemaVersion !== schema
      || marker.workflowNodesMd5 !== recovery.workflowNodesMd5
      || marker.workflowEdgesMd5 !== recovery.workflowEdgesMd5
      || marker.preservedPrefixLength !== 45
      || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
      || !/^record-[\w-]+$/.test(marker.sourceExecutionId ?? '')
      || !/^record-[\w-]+$/.test(marker.parentExecutionId ?? '')
      || !/^record-[\w-]+$/.test(marker.originalExecutionId ?? '')
      || !hex(marker.sourceResultMd5, 32) || !hex(marker.parentResultMd5, 32)
      || !hex(marker.originalResultMd5, 32) || !hex(marker.preservedPrefixOutputsHash, 64)
      || !hex(marker.failedImageFileSha256, 64) || !hex(marker.failedReviewOutputSha256, 64)
      || !hex(marker.repairPreparationSha256, 64)
      || (schema === 178 && (!hex(marker.priorRepairPreparationSha256, 64)
        || !/^qa\/record-[\w-]+\/[\w.-]+\.png$/.test(marker.geometryGuideSourcePath ?? '')
        || !hex(marker.geometryGuideSourceSha256, 64)
        || !hex(marker.geometryGuideJpegSha256, 64)
        || !/^qa\/record-[\w-]+\/[\w.-]+\.json$/.test(marker.geometryGuideProvenancePath ?? '')
        || !hex(marker.geometryGuideProvenanceSha256, 64)))
      || (first
        ? recovery.preservedPrefixLength !== 45 || recovery.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
          || marker.sourceExecutionId !== recovery.sourceExecutionId
          || marker.sourceResultMd5 !== recovery.sourceResultMd5
          || marker.preservedPrefixOutputsHash !== recovery.preservedPrefixOutputsHash
          || marker.failedImageFileSha256 !== recovery.failedImageFileSha256
          || marker.failedReviewOutputSha256 !== recovery.failedReviewOutputSha256
          || marker.repairPreparationSha256 !== recovery.repairPreparationSha256
          || (schema === 178 && (marker.priorRepairPreparationSha256 !== recovery.priorRepairPreparationSha256
            || marker.geometryGuideSourcePath !== recovery.geometryGuideSourcePath
            || marker.geometryGuideSourceSha256 !== recovery.geometryGuideSourceSha256
            || marker.geometryGuideJpegSha256 !== recovery.geometryGuideJpegSha256
            || marker.geometryGuideProvenancePath !== recovery.geometryGuideProvenancePath
            || marker.geometryGuideProvenanceSha256 !== recovery.geometryGuideProvenanceSha256))
        : recovery.preservedPrefixLength !== 66 || recovery.firstPendingNodeId !== 'sanguo-shot-script-review'
          || recovery.firstShotImageRepairPreparationSha256 !== marker.repairPreparationSha256)) {
      throw new Error(`IDLE_CHECKPOINT_IDENTITY_MISMATCH: schema${schema} repair lineage changed`)
    }
  }
  const index = recovery.preservedPrefixLength
  const run = record.runs[index]
  if (!Number.isSafeInteger(index) || index < 1 || recovery.firstPendingNodeId !== nodeId
    || record.selectedNodeId !== nodeId || run?.id !== nodeId || run.status !== 'idle'
    || run.loopIndex !== expectedLoopIndex || record.runs.slice(0, index).some(prior => !['success', 'skipped'].includes(prior.status))
    || record.runs.slice(index).some(next => next.status !== 'idle')) {
    throw new Error('IDLE_CHECKPOINT_STATE_MISMATCH: first pending run or preserved prefix changed')
  }
  return run
}

/** A nondefault app port must never restart the default 5173 launchd service. */
export function assertSafeRestartServerTarget(appUrl, restartServer,
  serviceLabel, serviceLabelExplicit) {
  if (!restartServer) return
  const url = new URL(appUrl)
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (port !== '5173' && (!serviceLabelExplicit
    || serviceLabel === 'com.video-aigc.app'))
    throw new Error('--restart-server on a nondefault app port requires an explicit independent --service-label')
}

/** The compact polling projection cannot prove preserved outputs. Decode the
 * exact saved checkpoint once more immediately before continuing schema177. */
export function verifiedSchema177IdleRecord(state, record, sourceState) {
  const recovery = state?.sceneCutFirstFrameRecovery
  const marker = state?.sceneCutImageRepairRecovery
  const first = recovery?.version === 'original-shot1-image-retry-schema177-fork-v1'
  const replay = recovery?.version === 'original-second-shot-candidate-replay-schema177-fork-v1'
  const runs = state?.nodeRuns
  const receipt = marker?.receipt
  const refs = receipt?.referenceOrder
  const bindings = runs?.[41]?.output?.referenceBindings
  const hash = createJsonHasher()
  if ((!first && !replay) || state.id !== record.id || state.workflowId !== record.workflowId
    || state.parentExecutionId !== record.parentExecutionId || state.selectedNodeId !== record.selectedNodeId
    || state.generationScopeId !== state.id || state.mode !== 'step'
    || !isDeepStrictEqual(recoverySummary(recovery), record.sceneCutFirstFrameRecovery)
    || !isDeepStrictEqual(repairSummary(marker), record.sceneCutImageRepairRecovery)
    || !Array.isArray(runs) || runs.length !== record.runs.length
    || runs.some((run, index) => run?.id !== record.runs[index].key
      || run?.node?.id !== record.runs[index].id || run?.status !== record.runs[index].status
      || run?.loopIndex !== record.runs[index].loopIndex)
    || !hex(recovery.preservedPrefixOutputsHash, 64)
    || recovery.preservedPrefixOutputsHash !== hash(runs.slice(0, recovery.preservedPrefixLength)
      .map(run => run.output ?? null))
    || marker.preservedPrefixOutputsHash !== hash(runs.slice(0, 45).map(run => run.output ?? null))
    || receipt?.version !== 'scene-cut-rejected-image-edit-reference-v1'
    || receipt.sourceExecutionId !== marker.sourceExecutionId
    || receipt.sourceResultMd5 !== marker.sourceResultMd5
    || receipt.sourceImageSha256 !== marker.failedImageFileSha256
    || receipt.failedReviewOutputSha256 !== marker.failedReviewOutputSha256
    || receipt.role !== 'reference-only' || receipt.sourceVerdict !== 'rejected'
    || receipt.approvedFirstFrame !== false || receipt.requiresFreshIndependentReview !== true
    || !Array.isArray(refs) || refs.length !== 3
    || refs.some((ref, index) => ref?.position !== index + 1)
    || !hex(refs[0].sha256, 64) || !hex(refs[1].sha256, 64)
    || refs[2].role !== 'rejected-edit-source'
    || refs[2].sourceSha256 !== marker.failedImageFileSha256
    || !hex(refs[2].jpegSha256, 64)
    || !Array.isArray(bindings) || bindings.length !== 2
    || refs[0].sha256 !== bindings[0]?.frontSha256
    || refs[1].sha256 !== bindings[1]?.frontSha256
    || sourceState?.id !== recovery.sourceExecutionId
    || sourceState.workflowId !== record.workflowId
    || !Array.isArray(sourceState.nodeRuns)
    || (first && (!isDeepStrictEqual(state.originalShot1ImageV7RetryRecovery, recovery)
      || marker.preservedPrefixOutputsHash !== hash(sourceState.nodeRuns.slice(0, 45)
        .map(run => run.output ?? null))))
    || (replay && (!isDeepStrictEqual(state.secondShotReplayRecovery, recovery)
      || state.originalShot1ImageV7RetryRecovery?.version !== 'original-shot1-image-retry-schema177-fork-v1'
      || state.originalShot1ImageV7RetryRecovery.repairPreparationSha256 !== marker.repairPreparationSha256
      || marker.preservedPrefixOutputsHash !== state.originalShot1ImageV7RetryRecovery.preservedPrefixOutputsHash
      || marker.preservedPrefixOutputsHash !== hash(sourceState.nodeRuns.slice(0, 45)
        .map(run => run.output ?? null))))) {
    throw new Error('IDLE_CHECKPOINT_PREFIX_CHANGED: schema177 record or preserved outputs differ from the fork')
  }
  return { marker, recovery }
}

/** Schema178 keeps the v7 failed-edit receipt as ancestry and adds one
 * geometry-only reference. Verify saved prefix bytes before the first click. */
export function verifiedSchema178IdleRecord(state, record, sourceState) {
  const recovery = state?.sceneCutFirstFrameRecovery
  const marker = state?.sceneCutImageRepairRecovery
  const prior = state?.priorSceneCutImageRepairRecovery
  const first = recovery?.version === 'original-shot1-image-retry-schema178-fork-v1'
  const replay = recovery?.version === 'original-second-shot-candidate-replay-schema178-fork-v1'
  const runs = state?.nodeRuns
  const receipt = marker?.receipt
  const refs = receipt?.referenceOrder
  const bindings = runs?.[41]?.output?.referenceBindings
  const hash = createJsonHasher()
  if ((!first && !replay) || state.id !== record.id || state.workflowId !== record.workflowId
    || state.parentExecutionId !== record.parentExecutionId || state.selectedNodeId !== record.selectedNodeId
    || state.generationScopeId !== state.id || state.mode !== 'step'
    || !isDeepStrictEqual(recoverySummary(recovery), record.sceneCutFirstFrameRecovery)
    || !isDeepStrictEqual(repairSummary(marker), record.sceneCutImageRepairRecovery)
    || !Array.isArray(runs) || runs.length !== record.runs.length
    || runs.some((run, index) => run?.id !== record.runs[index].key
      || run?.node?.id !== record.runs[index].id || run?.status !== record.runs[index].status
      || run?.loopIndex !== record.runs[index].loopIndex)
    || !hex(recovery.preservedPrefixOutputsHash, 64)
    || recovery.preservedPrefixOutputsHash !== hash(runs.slice(0, recovery.preservedPrefixLength)
      .map(run => run.output ?? null))
    || marker.preservedPrefixOutputsHash !== hash(runs.slice(0, 45).map(run => run.output ?? null))
    || prior?.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || marker.priorRepairPreparationSha256 !== prior.repairPreparationSha256
    || receipt?.version !== 'scene-cut-rejected-image-edit-reference-v2'
    || receipt.sourceExecutionId !== marker.sourceExecutionId
    || receipt.sourceResultMd5 !== marker.sourceResultMd5
    || receipt.sourceImageSha256 !== marker.failedImageFileSha256
    || receipt.failedReviewOutputSha256 !== marker.failedReviewOutputSha256
    || receipt.priorRepairPreparationSha256 !== prior.repairPreparationSha256
    || receipt.priorRepairMarkerHash !== hash(prior)
    || receipt.role !== 'reference-only' || receipt.sourceVerdict !== 'rejected'
    || receipt.approvedFirstFrame !== false || receipt.requiresFreshIndependentReview !== true
    || !Array.isArray(refs) || refs.length !== 4
    || refs.some((ref, index) => ref?.position !== index + 1)
    || !hex(refs[0].sha256, 64) || !hex(refs[1].sha256, 64)
    || !Array.isArray(bindings) || bindings.length !== 2
    || refs[0].sha256 !== bindings[0]?.frontSha256
    || refs[1].sha256 !== bindings[1]?.frontSha256
    || refs[2].role !== 'rejected-edit-source'
    || refs[2].sourceSha256 !== marker.failedImageFileSha256
    || !hex(refs[2].jpegSha256, 64)
    || refs[3].role !== 'geometry-guide' || refs[3].purpose !== 'geometry-only'
    || refs[3].referenceOnly !== true
    || refs[3].sourcePath !== marker.geometryGuideSourcePath
    || refs[3].sourceSha256 !== marker.geometryGuideSourceSha256
    || refs[3].jpegSha256 !== marker.geometryGuideJpegSha256
    || !hex(refs[3].jpegSha256, 64)
    || receipt.geometryGuide?.role !== 'geometry-only'
    || receipt.geometryGuide.identityAuthority !== false
    || receipt.geometryGuide.sourcePath !== marker.geometryGuideSourcePath
    || receipt.geometryGuide.sourceSha256 !== marker.geometryGuideSourceSha256
    || sourceState?.id !== recovery.sourceExecutionId
    || sourceState.workflowId !== record.workflowId
    || !Array.isArray(sourceState.nodeRuns)
    || (first && (!isDeepStrictEqual(state.originalShot1ImageV8RetryRecovery, recovery)
      || !isDeepStrictEqual(sourceState.sceneCutImageRepairRecovery, prior)
      || marker.preservedPrefixOutputsHash !== hash(sourceState.nodeRuns.slice(0, 45)
        .map(run => run.output ?? null))))
    || (replay && (!isDeepStrictEqual(state.secondShotReplayRecovery, recovery)
      || state.originalShot1ImageV8RetryRecovery?.version !== 'original-shot1-image-retry-schema178-fork-v1'
      || state.originalShot1ImageV8RetryRecovery.repairPreparationSha256 !== marker.repairPreparationSha256
      || marker.preservedPrefixOutputsHash !== state.originalShot1ImageV8RetryRecovery.preservedPrefixOutputsHash
      || !isDeepStrictEqual(sourceState.sceneCutImageRepairRecovery, marker)
      || marker.preservedPrefixOutputsHash !== hash(sourceState.nodeRuns.slice(0, 45)
        .map(run => run.output ?? null))))) {
    throw new Error('IDLE_CHECKPOINT_PREFIX_CHANGED: schema178 record or preserved outputs differ from the fork')
  }
  return { marker, recovery }
}

/** An explicit completed-node retry must leave every completed provider result
 * before it and must not discard a paid result after it. The UI click is only
 * allowed after this persisted-record check and a matching inspector check. */
export function verifiedRetryTarget(record, { workflowId, index, nodeId, loopIndex, rebuildPaidSuffix = false }) {
  if (record.workflowId !== workflowId) throw new Error(`RETRY_WORKFLOW_MISMATCH: ${record.workflowId} is not ${workflowId}`)
  const run = record.runs[index]
  if (!run || run.index !== index || run.id !== nodeId || run.loopIndex !== loopIndex || run.status !== 'success') {
    throw new Error(`RETRY_TARGET_MISMATCH: step ${index} must be successful ${nodeId} in round ${loopIndex + 1}`)
  }
  const incomplete = record.runs.slice(0, index).find(prior => !['success', 'skipped'].includes(prior.status))
  if (incomplete) throw new Error(`RETRY_PREFIX_INCOMPLETE: step ${incomplete.index} ${incomplete.id} is ${incomplete.status}`)
  const paidAfter = record.runs.slice(index).find(later => later.status === 'success' && ['image', 'video', 'audio'].includes(later.kind))
  if (paidAfter && !rebuildPaidSuffix) throw new Error(`RETRY_PAID_SUFFIX: step ${paidAfter.index} ${paidAfter.id} would be invalidated`)
  const missingPaidPrefix = record.runs.slice(0, index).find(prior => prior.status === 'success'
    && ['image', 'video', 'audio'].includes(prior.kind) && !prior.outputSummary?.hasOutput)
  if (missingPaidPrefix) throw new Error(`RETRY_PAID_PREFIX_INVALID: step ${missingPaidPrefix.index} ${missingPaidPrefix.id} has no saved output`)
  return run
}

const hasOutput = value => {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return Boolean(value.trim())
  if (typeof value !== 'object') return true
  const keys = Object.keys(value).filter(key => key !== 'executionLogs')
  if (keys.length === 1 && keys[0] === 'value') return hasOutput(value.value)
  return keys.length > 0
}

const rejectedFlags = ['passed', 'accepted', 'videoAccepted', 'ok', 'success']
const validOutputSummary = value => value && typeof value === 'object'
  && typeof value.hasOutput === 'boolean' && typeof value.url === 'string'
  && (value.errorField === null || ['routeError', 'error'].includes(value.errorField))
  && typeof value.errorMessage === 'string' && (value.rejectedFlag === null || rejectedFlags.includes(value.rejectedFlag))
  && typeof value.manualDecisionRequired === 'boolean'

/** Preserve the decisions needed by the driver without retaining provider raw
 * data, model text, frame observations or any execution context. */
export function driveOutputSummary(output) {
  const errorField = output && typeof output === 'object' ? ['routeError', 'error'].find(field => output[field]) ?? null : null
  return {
    hasOutput: hasOutput(output),
    errorField,
    errorMessage: errorField ? typeof output[errorField] === 'string' ? output[errorField] : 'non-string error value' : '',
    rejectedFlag: output && typeof output === 'object' ? rejectedFlags.find(field => output[field] === false) ?? null : null,
    url: typeof output?.url === 'string' ? output.url.trim() : '',
    manualDecisionRequired: output?.qualityDisposition === 'manual-review-v1'
      && output?.manualDecisionRequired === true && output?.qualityReview?.manualDecisionRequired === true,
  }
}

// String.trim's complete whitespace set, supplied as a query parameter so SQL
// and JavaScript agree even for empty Unicode strings and whitespace-only URLs.
export const DRIVE_RECORD_TRIM_CHARS = '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'

/** Appended to a read-only `record_row` CTE. Keeping the projection separate
 * allows fixture equivalence tests to execute the exact SQL with JSON input. */
export const DRIVE_RECORD_PROJECTION_SQL = `,
node_rows as (
  select ord, jsonb_build_object(
    'id', run->'id', 'node', jsonb_build_object('id',run->'node'->'id','kind',run->'node'->'kind','title',run->'node'->'title','modelId',run->'node'->'modelId'),
    'status',run->'status','attempt',run->'attempt','revision',run->'revision','loopIndex',run->'loopIndex',
    'durationMs',run->'durationMs','error',case when jsonb_typeof(run->'error')='string' then run->'error' end
  ) as run, run->'output' as output
  from record_row cross join lateral jsonb_array_elements(
    case when jsonb_typeof(result->'nodeRuns')='array' then result->'nodeRuns' else '[]'::jsonb end
  ) with ordinality n(run,ord)
), unwrapped(ord,output,depth) as (
  select ord,output,0 from node_rows
  union all
  select ord,output->'value',depth+1 from unwrapped
  where case when jsonb_typeof(output)='object' then output ? 'value' and output-'executionLogs'-'value'='{}'::jsonb else false end
), terminal as (
  select distinct on (ord) ord,output from unwrapped order by ord,depth desc
), projected as (
  select n.ord,n.run || jsonb_build_object('_driveOutput',jsonb_build_object(
    'hasOutput',case when t.output is null or t.output='null'::jsonb then false
      when jsonb_typeof(t.output)='string' then btrim(t.output#>>'{}',$2)<>''
      when jsonb_typeof(t.output)='array' then jsonb_array_length(t.output)>0
      when jsonb_typeof(t.output)='object' then t.output-'executionLogs'<>'{}'::jsonb else true end,
    'errorField',err.field,'errorMessage',case when err.field is null then '' when jsonb_typeof(err.value)='string' then err.value#>>'{}' else 'non-string error value' end,
    'rejectedFlag',rejected.field,
    'manualDecisionRequired',coalesce(n.output->>'qualityDisposition'='manual-review-v1'
      and n.output->'manualDecisionRequired'='true'::jsonb
      and n.output->'qualityReview'->'manualDecisionRequired'='true'::jsonb,false),
    'url',case when jsonb_typeof(n.output->'url')='string' then btrim(n.output->>'url',$2) else '' end
  )) as run
  from node_rows n join terminal t using(ord)
  left join lateral (
    select field,value from (values ('routeError',n.output->'routeError',0),('error',n.output->'error',1)) v(field,value,priority)
    where value is not null and value not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) order by priority limit 1
  ) err on true
  left join lateral (
    select field from (values ('passed',0),('accepted',1),('videoAccepted',2),('ok',3),('success',4)) v(field,priority)
    where n.output->field='false'::jsonb order by priority limit 1
  ) rejected on true
)
select id,workflow_id,created_at,runtime_inputs,md5(result::text) as result_md5,
  jsonb_build_object('id',result->'id','requestScopeId',result->'requestScopeId','parentExecutionId',result->'parentExecutionId',
  'selectedNodeId',result->'selectedNodeId',
  'sceneCutAutoRetry',case when jsonb_typeof(result->'sceneCutAutoRetry')='object' then
    jsonb_build_object('sourceExecutionId',result->'sceneCutAutoRetry'->'sourceExecutionId',
      'count',result->'sceneCutAutoRetry'->'count','loopIndex',result->'sceneCutAutoRetry'->'loopIndex') else null end,
  'sceneCutFirstFrameRecovery',case when jsonb_typeof(result->'sceneCutFirstFrameRecovery')='object' then
    jsonb_build_object('version',result->'sceneCutFirstFrameRecovery'->'version',
      'workflowSchemaVersion',result->'sceneCutFirstFrameRecovery'->'workflowSchemaVersion',
      'sourceExecutionId',result->'sceneCutFirstFrameRecovery'->'sourceExecutionId',
      'sourceResultMd5',result->'sceneCutFirstFrameRecovery'->'sourceResultMd5',
      'workflowNodesMd5',result->'sceneCutFirstFrameRecovery'->'workflowNodesMd5',
      'workflowEdgesMd5',result->'sceneCutFirstFrameRecovery'->'workflowEdgesMd5',
      'preservedPrefixLength',result->'sceneCutFirstFrameRecovery'->'preservedPrefixLength',
      'preservedPrefixSha256',result->'sceneCutFirstFrameRecovery'->'preservedPrefixSha256',
      'firstPendingIndex',result->'sceneCutFirstFrameRecovery'->'firstPendingIndex',
      'firstPendingNodeId',result->'sceneCutFirstFrameRecovery'->'firstPendingNodeId',
      'firstShotPlanId',result->'sceneCutFirstFrameRecovery'->'firstShotPlanId',
      'firstShotManifestSha256',result->'sceneCutFirstFrameRecovery'->'firstShotManifestSha256',
      'firstShotReceiptSha256',result->'sceneCutFirstFrameRecovery'->'firstShotReceiptSha256',
      'firstActualTailSha256',result->'sceneCutFirstFrameRecovery'->'firstActualTailSha256',
      'preservedPrefixOutputsHash',result->'sceneCutFirstFrameRecovery'->'preservedPrefixOutputsHash',
      'failedImageFileSha256',result->'sceneCutFirstFrameRecovery'->'failedImageFileSha256',
      'failedReviewOutputSha256',result->'sceneCutFirstFrameRecovery'->'failedReviewOutputSha256',
      'repairPreparationSha256',result->'sceneCutFirstFrameRecovery'->'repairPreparationSha256',
      'firstShotImageRepairPreparationSha256',result->'sceneCutFirstFrameRecovery'->'firstShotImageRepairPreparationSha256',
      'priorRepairPreparationSha256',result->'sceneCutFirstFrameRecovery'->'priorRepairPreparationSha256',
      'geometryGuideSourcePath',result->'sceneCutFirstFrameRecovery'->'geometryGuideSourcePath',
      'geometryGuideSourceSha256',result->'sceneCutFirstFrameRecovery'->'geometryGuideSourceSha256',
      'geometryGuideJpegSha256',result->'sceneCutFirstFrameRecovery'->'geometryGuideJpegSha256',
      'geometryGuideProvenancePath',result->'sceneCutFirstFrameRecovery'->'geometryGuideProvenancePath',
      'geometryGuideProvenanceSha256',result->'sceneCutFirstFrameRecovery'->'geometryGuideProvenanceSha256') else null end,
  'sceneCutImageRepairRecovery',case when jsonb_typeof(result->'sceneCutImageRepairRecovery')='object' then
    jsonb_build_object('version',result->'sceneCutImageRepairRecovery'->'version',
      'sourceExecutionId',result->'sceneCutImageRepairRecovery'->'sourceExecutionId',
      'sourceResultMd5',result->'sceneCutImageRepairRecovery'->'sourceResultMd5',
      'parentExecutionId',result->'sceneCutImageRepairRecovery'->'parentExecutionId',
      'parentResultMd5',result->'sceneCutImageRepairRecovery'->'parentResultMd5',
      'originalExecutionId',result->'sceneCutImageRepairRecovery'->'originalExecutionId',
      'originalResultMd5',result->'sceneCutImageRepairRecovery'->'originalResultMd5',
      'workflowSchemaVersion',result->'sceneCutImageRepairRecovery'->'workflowSchemaVersion',
      'workflowNodesMd5',result->'sceneCutImageRepairRecovery'->'workflowNodesMd5',
      'workflowEdgesMd5',result->'sceneCutImageRepairRecovery'->'workflowEdgesMd5',
      'preservedPrefixLength',result->'sceneCutImageRepairRecovery'->'preservedPrefixLength',
      'firstPendingNodeId',result->'sceneCutImageRepairRecovery'->'firstPendingNodeId',
      'preservedPrefixOutputsHash',result->'sceneCutImageRepairRecovery'->'preservedPrefixOutputsHash',
      'failedImageFileSha256',result->'sceneCutImageRepairRecovery'->'failedImageFileSha256',
      'failedReviewOutputSha256',result->'sceneCutImageRepairRecovery'->'failedReviewOutputSha256',
      'repairPreparationSha256',result->'sceneCutImageRepairRecovery'->'repairPreparationSha256',
      'priorRepairPreparationSha256',result->'sceneCutImageRepairRecovery'->'priorRepairPreparationSha256',
      'geometryGuideSourcePath',result->'sceneCutImageRepairRecovery'->'geometryGuideSourcePath',
      'geometryGuideSourceSha256',result->'sceneCutImageRepairRecovery'->'geometryGuideSourceSha256',
      'geometryGuideJpegSha256',result->'sceneCutImageRepairRecovery'->'geometryGuideJpegSha256',
      'geometryGuideProvenancePath',result->'sceneCutImageRepairRecovery'->'geometryGuideProvenancePath',
      'geometryGuideProvenanceSha256',result->'sceneCutImageRepairRecovery'->'geometryGuideProvenanceSha256') else null end,
  'sceneCutApprovalRebindRecovery',case when jsonb_typeof(result->'sceneCutApprovalRebindRecovery')='object' then
    jsonb_build_object('version',result->'sceneCutApprovalRebindRecovery'->'version',
      'sourceExecutionId',result->'sceneCutApprovalRebindRecovery'->'sourceExecutionId',
      'sourceResultMd5',result->'sceneCutApprovalRebindRecovery'->'sourceResultMd5',
      'workflowSchemaVersion',result->'sceneCutApprovalRebindRecovery'->'workflowSchemaVersion',
      'workflowNodesMd5',result->'sceneCutApprovalRebindRecovery'->'workflowNodesMd5',
      'workflowEdgesMd5',result->'sceneCutApprovalRebindRecovery'->'workflowEdgesMd5',
      'preservedPrefixLength',result->'sceneCutApprovalRebindRecovery'->'preservedPrefixLength',
      'firstPendingNodeId',result->'sceneCutApprovalRebindRecovery'->'firstPendingNodeId',
      'nativeSourceExecutionId',result->'sceneCutApprovalRebindRecovery'->'nativeSourceExecutionId',
      'nativeSourceResultMd5',result->'sceneCutApprovalRebindRecovery'->'nativeSourceResultMd5',
      'nativeReviewExecutionId',result->'sceneCutApprovalRebindRecovery'->'nativeReviewExecutionId',
      'nativeReviewResultMd5',result->'sceneCutApprovalRebindRecovery'->'nativeReviewResultMd5',
      'tailGuide',jsonb_build_object('url',result->'sceneCutApprovalRebindRecovery'->'tailGuide'->'url',
        'fileSha256',result->'sceneCutApprovalRebindRecovery'->'tailGuide'->'fileSha256')) else null end,
  'sceneCutA8B6ConflictReviewRecovery',case when jsonb_typeof(result->'sceneCutA8B6ConflictReviewRecovery')='object' then
    jsonb_build_object('version',result->'sceneCutA8B6ConflictReviewRecovery'->'version',
      'sourceExecutionId',result->'sceneCutA8B6ConflictReviewRecovery'->'sourceExecutionId',
      'sourceResultMd5',result->'sceneCutA8B6ConflictReviewRecovery'->'sourceResultMd5',
      'qaPlanId',result->'sceneCutA8B6ConflictReviewRecovery'->'qaPlanId',
      'workflowSchemaVersion',result->'sceneCutA8B6ConflictReviewRecovery'->'workflowSchemaVersion',
      'workflowNodesMd5',result->'sceneCutA8B6ConflictReviewRecovery'->'workflowNodesMd5',
      'workflowEdgesMd5',result->'sceneCutA8B6ConflictReviewRecovery'->'workflowEdgesMd5',
      'adjudicationReceiptSha256',result->'sceneCutA8B6ConflictReviewRecovery'->'adjudicationReceiptSha256',
      'preservedPrefixLength',result->'sceneCutA8B6ConflictReviewRecovery'->'preservedPrefixLength',
      'preservedPrefixSha256',result->'sceneCutA8B6ConflictReviewRecovery'->'preservedPrefixSha256',
      'firstPendingIndex',result->'sceneCutA8B6ConflictReviewRecovery'->'firstPendingIndex',
      'firstPendingNodeId',result->'sceneCutA8B6ConflictReviewRecovery'->'firstPendingNodeId') else null end,
  'sceneCutA8B6FreshFrameRecovery',case when jsonb_typeof(result->'sceneCutA8B6FreshFrameRecovery')='object' then
    jsonb_build_object('version',result->'sceneCutA8B6FreshFrameRecovery'->'version',
      'sourceExecutionId',result->'sceneCutA8B6FreshFrameRecovery'->'sourceExecutionId',
      'sourceResultMd5',result->'sceneCutA8B6FreshFrameRecovery'->'sourceResultMd5',
      'rejectedExecutionId',result->'sceneCutA8B6FreshFrameRecovery'->'rejectedExecutionId',
      'rejectedResultMd5',result->'sceneCutA8B6FreshFrameRecovery'->'rejectedResultMd5',
      'priorFreshExecutionId',result->'sceneCutA8B6FreshFrameRecovery'->'priorFreshExecutionId',
      'priorFreshResultMd5',result->'sceneCutA8B6FreshFrameRecovery'->'priorFreshResultMd5',
      'priorFreshImageSha256',result->'sceneCutA8B6FreshFrameRecovery'->'priorFreshImageSha256',
      'priorFreshReviewSha256',result->'sceneCutA8B6FreshFrameRecovery'->'priorFreshReviewSha256',
      'editReceiptSha256',result->'sceneCutA8B6FreshFrameRecovery'->'editReceiptSha256',
      'qaPlanId',result->'sceneCutA8B6FreshFrameRecovery'->'qaPlanId',
      'workflowSchemaVersion',result->'sceneCutA8B6FreshFrameRecovery'->'workflowSchemaVersion',
      'workflowNodesMd5',result->'sceneCutA8B6FreshFrameRecovery'->'workflowNodesMd5',
      'workflowEdgesMd5',result->'sceneCutA8B6FreshFrameRecovery'->'workflowEdgesMd5',
      'adjudicationReceiptSha256',result->'sceneCutA8B6FreshFrameRecovery'->'adjudicationReceiptSha256',
      'rejectedImageSha256',result->'sceneCutA8B6FreshFrameRecovery'->'rejectedImageSha256',
      'firstPromptSha256',result->'sceneCutA8B6FreshFrameRecovery'->'firstPromptSha256',
      'reviewPromptSha256',result->'sceneCutA8B6FreshFrameRecovery'->'reviewPromptSha256',
      'preservedPrefixLength',result->'sceneCutA8B6FreshFrameRecovery'->'preservedPrefixLength',
      'preservedPrefixSha256',result->'sceneCutA8B6FreshFrameRecovery'->'preservedPrefixSha256',
      'firstPendingIndex',result->'sceneCutA8B6FreshFrameRecovery'->'firstPendingIndex',
      'firstPendingNodeId',result->'sceneCutA8B6FreshFrameRecovery'->'firstPendingNodeId') else null end,
  'sceneCutA8B6LocalFrameRecovery',case when jsonb_typeof(result->'sceneCutA8B6LocalFrameRecovery')='object' then
    jsonb_build_object('version',result->'sceneCutA8B6LocalFrameRecovery'->'version',
      'sourceExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'sourceExecutionId',
      'sourceResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'sourceResultMd5',
      'v7ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'v7ExecutionId',
      'v7ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'v7ResultMd5',
      'v4ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'v4ExecutionId',
      'v4ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'v4ResultMd5',
      'v8ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'v8ExecutionId',
      'v8ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'v8ResultMd5',
      'v8RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'v8RejectedReviewSha256',
      'priorLocalV1ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV1ExecutionId',
      'priorLocalV1ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV1ResultMd5',
      'priorLocalV1RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV1RejectedReviewSha256',
      'imageGenRawSha256',result->'sceneCutA8B6LocalFrameRecovery'->'imageGenRawSha256',
      'imageGenPromptSha256',result->'sceneCutA8B6LocalFrameRecovery'->'imageGenPromptSha256',
      'priorLocalV2ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV2ExecutionId',
      'priorLocalV2ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV2ResultMd5',
      'priorLocalV2RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV2RejectedReviewSha256',
      'priorLocalV2ReviewModelExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV2ReviewModelExecutionId',
      'priorLocalV3ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV3ExecutionId',
      'priorLocalV3ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV3ResultMd5',
      'priorLocalV3RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV3RejectedReviewSha256',
      'priorLocalV3ReviewModelExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV3ReviewModelExecutionId',
      'priorLocalV4ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV4ExecutionId',
      'priorLocalV4FailedResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV4FailedResultMd5',
      'priorLocalV4RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV4RejectedReviewSha256',
      'priorLocalV4ReviewModelExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV4ReviewModelExecutionId')
    || jsonb_build_object('priorLocalV5ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV5ExecutionId',
      'priorLocalV5ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV5ResultMd5',
      'priorLocalV5RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV5RejectedReviewSha256',
      'priorLocalV5ReviewModelExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV5ReviewModelExecutionId',
      'priorLocalV6ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV6ExecutionId',
      'priorLocalV6ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV6ResultMd5',
      'priorLocalV6RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV6RejectedReviewSha256',
      'priorLocalV6ReviewModelExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV6ReviewModelExecutionId',
      'priorLocalV7ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV7ExecutionId',
      'priorLocalV7ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV7ResultMd5',
      'priorLocalV7RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV7RejectedReviewSha256',
      'priorLocalV7ReviewModelExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV7ReviewModelExecutionId',
      'priorLocalV8ExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV8ExecutionId',
      'priorLocalV8ResultMd5',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV8ResultMd5',
      'priorLocalV8RejectedReviewSha256',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV8RejectedReviewSha256',
      'priorLocalV8ReviewModelExecutionId',result->'sceneCutA8B6LocalFrameRecovery'->'priorLocalV8ReviewModelExecutionId',
      'wallImageGenRawSha256',result->'sceneCutA8B6LocalFrameRecovery'->'wallImageGenRawSha256',
      'faceImageGenRawSha256',result->'sceneCutA8B6LocalFrameRecovery'->'faceImageGenRawSha256',
      'gateFrameImageGenRawSha256',result->'sceneCutA8B6LocalFrameRecovery'->'gateFrameImageGenRawSha256',
      'sourceReceiptSha256',result->'sceneCutA8B6LocalFrameRecovery'->'sourceReceiptSha256',
      'outputUrl',result->'sceneCutA8B6LocalFrameRecovery'->'outputUrl',
      'outputSha256',result->'sceneCutA8B6LocalFrameRecovery'->'outputSha256',
      'workflowSchemaVersion',result->'sceneCutA8B6LocalFrameRecovery'->'workflowSchemaVersion',
      'workflowNodesMd5',result->'sceneCutA8B6LocalFrameRecovery'->'workflowNodesMd5',
      'workflowEdgesMd5',result->'sceneCutA8B6LocalFrameRecovery'->'workflowEdgesMd5',
      'preservedPrefixLength',result->'sceneCutA8B6LocalFrameRecovery'->'preservedPrefixLength',
      'preservedPrefixSha256',result->'sceneCutA8B6LocalFrameRecovery'->'preservedPrefixSha256',
      'firstPendingIndex',result->'sceneCutA8B6LocalFrameRecovery'->'firstPendingIndex',
      'firstPendingNodeId',result->'sceneCutA8B6LocalFrameRecovery'->'firstPendingNodeId',
      'reviewPromptSha256',result->'sceneCutA8B6LocalFrameRecovery'->'reviewPromptSha256') else null end,
  'sceneCutA8B6FreshRouterRecovery',case when jsonb_typeof(result->'sceneCutA8B6FreshRouterRecovery')='object' then
    jsonb_build_object('version',result->'sceneCutA8B6FreshRouterRecovery'->'version',
      'frameProvenanceVariant',result->'sceneCutA8B6FreshRouterRecovery'->'frameProvenanceVariant',
      'imageApprovalExecutionId',result->'sceneCutA8B6FreshRouterRecovery'->'imageApprovalExecutionId',
      'imageApprovalResultMd5',result->'sceneCutA8B6FreshRouterRecovery'->'imageApprovalResultMd5',
      'planId',result->'sceneCutA8B6FreshRouterRecovery'->'planId',
      'workflowApprovalSha256',result->'sceneCutA8B6FreshRouterRecovery'->'workflowApprovalSha256',
      'workflowSchemaVersion',result->'sceneCutA8B6FreshRouterRecovery'->'workflowSchemaVersion',
      'workflowNodesMd5',result->'sceneCutA8B6FreshRouterRecovery'->'workflowNodesMd5',
      'workflowEdgesMd5',result->'sceneCutA8B6FreshRouterRecovery'->'workflowEdgesMd5',
      'preservedPrefixLength',result->'sceneCutA8B6FreshRouterRecovery'->'preservedPrefixLength',
      'preservedPrefixSha256',result->'sceneCutA8B6FreshRouterRecovery'->'preservedPrefixSha256',
      'firstPendingIndex',result->'sceneCutA8B6FreshRouterRecovery'->'firstPendingIndex',
      'firstPendingNodeId',result->'sceneCutA8B6FreshRouterRecovery'->'firstPendingNodeId') else null end,
  'sceneCutCompositeRecovery',case when jsonb_typeof(result->'sceneCutCompositeRecovery')='object' then
    jsonb_build_object('version',result->'sceneCutCompositeRecovery'->'version',
      'stagingVariant',result->'sceneCutCompositeRecovery'->'stagingVariant',
      'frameProvenanceVariant',result->'sceneCutCompositeRecovery'->'frameProvenanceVariant',
      'sourceExecutionId',result->'sceneCutCompositeRecovery'->'sourceExecutionId',
      'sourceResultMd5',result->'sceneCutCompositeRecovery'->'sourceResultMd5',
      'imageApprovalExecutionId',result->'sceneCutCompositeRecovery'->'imageApprovalExecutionId',
      'imageApprovalResultMd5',result->'sceneCutCompositeRecovery'->'imageApprovalResultMd5',
      'imageApprovalPrefixLength',result->'sceneCutCompositeRecovery'->'imageApprovalPrefixLength',
      'imageApprovalPrefixSha256',result->'sceneCutCompositeRecovery'->'imageApprovalPrefixSha256',
      'workflowSchemaVersion',result->'sceneCutCompositeRecovery'->'workflowSchemaVersion',
      'workflowNodesMd5',result->'sceneCutCompositeRecovery'->'workflowNodesMd5',
      'workflowEdgesMd5',result->'sceneCutCompositeRecovery'->'workflowEdgesMd5',
      'originalExecutionId',result->'sceneCutCompositeRecovery'->'originalExecutionId',
      'planId',result->'sceneCutCompositeRecovery'->'planId',
      'manifestSha256',result->'sceneCutCompositeRecovery'->'manifestSha256',
      'receiptSha256',result->'sceneCutCompositeRecovery'->'receiptSha256',
      'workflowApprovalSha256',result->'sceneCutCompositeRecovery'->'workflowApprovalSha256',
      'preservedPrefixLength',result->'sceneCutCompositeRecovery'->'preservedPrefixLength',
      'preservedPrefixSha256',result->'sceneCutCompositeRecovery'->'preservedPrefixSha256',
      'compositeVideoUrl',result->'sceneCutCompositeRecovery'->'compositeVideoUrl',
      'compositeVideoSha256',result->'sceneCutCompositeRecovery'->'compositeVideoSha256',
      'compositeTakeSha256',result->'sceneCutCompositeRecovery'->'compositeTakeSha256',
      'firstPendingIndex',result->'sceneCutCompositeRecovery'->'firstPendingIndex',
      'firstPendingNodeId',result->'sceneCutCompositeRecovery'->'firstPendingNodeId') else null end,
  'nodeRuns',coalesce((select jsonb_agg(run order by ord) from projected),'[]'::jsonb)) as result
from record_row`

export const DRIVE_RECORD_SQL = `with recursive record_row as (
  select id,workflow_id,created_at,runtime_inputs,result from execution_records where id=$1
)${DRIVE_RECORD_PROJECTION_SQL}`

/** The driver's Next click is an explicit human continuation. It may not
 * approve a newly reached text, image, or media accept gate on its own. A
 * later successful run proves a person already continued that checkpoint. */
export function pendingManualDecision(record) {
  const runs = Array.isArray(record?.runs) ? record.runs : []
  const lastSuccessIndex = runs.findLastIndex(run => run.status === 'success')
  if (lastSuccessIndex < 0) return undefined
  const run = runs[lastSuccessIndex]
  if (typeof run.id !== 'string' || !run.id.endsWith('-accept') || run.outputSummary?.manualDecisionRequired !== true) return undefined
  if (runs.slice(lastSuccessIndex + 1).some(next => next.status === 'running' || next.status === 'failed')) return undefined
  return run
}

/** A successful code invocation may still return a rejected quality report or a
 * routed error. Pin the first concrete occurrence: a later loop cannot satisfy it. */
export function targetOutcome(record, nodeId, nodeIndex) {
  const run = nodeIndex === undefined
    ? record.runs.find(candidate => candidate.id === nodeId)
    : record.runs.find(candidate => candidate.index === nodeIndex && candidate.id === nodeId)
  if (!run) return { done: false, settled: false, reason: 'target not scheduled' }
  if (run.status !== 'success') return { done: false, settled: false, run, reason: `target ${run.status}` }
  const rejected = reason => ({ done: false, settled: true, run, reason })
  const output = run.outputSummary ?? driveOutputSummary(run.output)
  if (!output.hasOutput) return rejected('target returned no output')
  if (output.errorField) return rejected(`${output.errorField}: ${output.errorMessage}`)
  if (output.rejectedFlag) return rejected(`${output.rejectedFlag}=false`)
  const url = output.url
  if (run.kind === 'video' && !url) return rejected('video returned no URL')
  return { done: true, settled: true, run, url }
}

/** A one-based round target checks every preceding occurrence too. Node indices
 * change whenever the workflow is upgraded, whereas loopIndex identifies the
 * actual iteration. A success in round five cannot conceal an earlier rejection. */
export function loopTargetOutcome(record, nodeId, loopCount) {
  if (!Number.isSafeInteger(loopCount) || loopCount < 1) throw new Error('--until-loop must be a positive integer')
  const completed = []
  for (let loopIndex = 0; loopIndex < loopCount; loopIndex += 1) {
    const candidates = record.runs.filter(run => run.id === nodeId && run.loopIndex === loopIndex)
    if (candidates.length !== 1) return { done: false, settled: candidates.length > 1,
      reason: candidates.length ? `ambiguous target in loop ${loopIndex + 1}` : `target not scheduled in loop ${loopIndex + 1}` }
    const outcome = targetOutcome(record, nodeId, candidates[0].index)
    if (!outcome.done) return { ...outcome, reason: `loop ${loopIndex + 1}: ${outcome.reason}` }
    completed.push(outcome.run)
  }
  const outcome = targetOutcome(record, nodeId, completed.at(-1).index)
  return { ...outcome, completed }
}

/** Runtime input overrides mirror collectRuntimeInputs: resultVar -> params.
 * They are a subset, preserving every other configured input. */
export function parseRuntimeInputs(source) {
  let inputs
  try { inputs = JSON.parse(source) } catch { throw new Error('--runtime-inputs must be valid JSON') }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || !Object.keys(inputs).length) {
    throw new Error('--runtime-inputs must be a nonempty object of result variable names and parameter objects')
  }
  for (const [resultVar, params] of Object.entries(inputs)) {
    if (!resultVar || !params || typeof params !== 'object' || Array.isArray(params) || !Object.keys(params).length) {
      throw new Error(`--runtime-inputs ${resultVar || '(empty key)'} must contain a nonempty parameter object`)
    }
  }
  return inputs
}

const sameJsonValue = (left, right) => {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]))
}

export function runtimeInputMismatch(actual, requested) {
  for (const [resultVar, params] of Object.entries(requested)) {
    for (const [key, value] of Object.entries(params)) {
      if (!actual?.[resultVar] || !Object.hasOwn(actual[resultVar], key) || !sameJsonValue(actual[resultVar][key], value)) {
        return `${resultVar}.${key}: expected ${JSON.stringify(value)}, stored ${JSON.stringify(actual?.[resultVar]?.[key]) ?? 'undefined'}`
      }
    }
  }
  return undefined
}

/** App retries carry their original requestScopeId and revise the concrete run.
 * A matching success prefix alone is not ancestry: unrelated runs can share it.
 * Claim a pending/failed retry immediately so observation never retries its parent. */
export function isRetryFork(pinned, candidate) {
  if (!sameExecutionScope(pinned, candidate)
    || candidate.id === pinned.id || !(new Date(candidate.createdAt) > new Date(pinned.createdAt))) return false
  const failedIndex = pinned.runs.findIndex(run => run.status === 'failed')
  if (failedIndex < 0) return false
  const target = pinned.runs[failedIndex]
  // A signed image rejection rewinds to the first-frame node. Its completed
  // review suffix is intentionally invalidated, so generic failed-node retry
  // matching cannot identify this automatic fork.
  const marker = candidate.sceneCutAutoRetry
  if (target.id === 'sanguo-scene-cut-approval'
    && candidate.parentExecutionId === pinned.id
    && marker?.sourceExecutionId === (pinned.sceneCutAutoRetry?.sourceExecutionId ?? pinned.id)
    && Number.isInteger(marker.count) && marker.count >= 1 && marker.count <= 2
    && marker.count === (pinned.sceneCutAutoRetry?.count ?? 0) + 1
    && marker.loopIndex === target.loopIndex
    && candidate.selectedNodeId === 'sanguo-scene-cut-first-frame') {
    const imageIndex = pinned.runs.findIndex((run, index) => index < failedIndex
      && run.id === 'sanguo-scene-cut-first-frame' && run.loopIndex === target.loopIndex)
    if (imageIndex >= 0 && candidate.runs[imageIndex]?.id === 'sanguo-scene-cut-first-frame'
      && candidate.runs.slice(0, imageIndex).every((run, index) => run.key === pinned.runs[index].key
        && run.status === pinned.runs[index].status && run.revision === pinned.runs[index].revision)
      && candidate.runs.slice(imageIndex).every(run => run.status === 'idle')) return true
  }
  const current = new Map(candidate.runs.filter(run => run.key).map(run => [run.key, run]))
  // requestScopeId groups every branch descended from the original execution,
  // not only descendants of this particular failed checkpoint. Require the
  // entire settled prefix before the failed node to survive unchanged; an old
  // sibling fork that stopped earlier must never steal a later resume.
  const prefixPreserved = pinned.runs.slice(0, failedIndex)
    .filter(run => run.key && ['success', 'skipped'].includes(run.status))
    .every(run => {
      const next = current.get(run.key)
      return next?.status === run.status && next.revision === run.revision
    })
  if (!prefixPreserved || !target.key) return false
  const retried = current.get(target.key)
  return Boolean(retried && (retried.revision > target.revision
    || (retried.status !== 'failed' && retried.status !== 'skipped')))
}

/** A requested retry of a successful node invalidates the suffix before the
 * old failed node. Bind the fork to that explicit target and direct parent. */
export function isTargetedRetryFork(pinned, candidate, retryIndex) {
  if (!sameExecutionScope(pinned, candidate) || candidate.parentExecutionId !== pinned.id
    || candidate.id === pinned.id || !(new Date(candidate.createdAt) > new Date(pinned.createdAt))) return false
  const target = pinned.runs[retryIndex]
  if (!target?.key || target.status !== 'success') return false
  const current = new Map(candidate.runs.filter(run => run.key).map(run => [run.key, run]))
  const prefixPreserved = pinned.runs.slice(0, retryIndex).every(run => {
    const next = current.get(run.key)
    return next?.status === run.status && next.revision === run.revision
  })
  const retried = current.get(target.key)
  return prefixPreserved && Boolean(retried && retried.id === target.id && retried.loopIndex === target.loopIndex
    && retried.revision > target.revision && retried.status !== 'skipped')
}

export function sameExecutionScope(left, right) {
  return Boolean(left?.workflowId && left?.requestScopeId && right?.workflowId === left.workflowId
    && right?.requestScopeId === left.requestScopeId)
}

/** A page reload may silently create a topology-migration fork. The UI driver
 * must not adopt one that made an already paid provider step runnable again. */
export function completedProviderRegression(source, candidate) {
  const next = new Map((candidate?.runs ?? []).filter(run => run.key).map(run => [run.key, run]))
  return (source?.runs ?? []).filter(run => run.key && run.status === 'success'
    && (['image', 'video', 'audio'].includes(run.kind) || Boolean(run.modelId))).flatMap(run => {
    const migrated = next.get(run.key)
    const beforeUrl = run.outputSummary?.url ?? ''
    const afterUrl = migrated?.outputSummary?.url ?? ''
    return migrated?.status === 'success' && (!beforeUrl || afterUrl === beforeUrl)
      ? [] : [{ key: run.key, nodeId: run.id, beforeStatus: run.status,
        afterStatus: migrated?.status ?? 'missing', beforeUrl, afterUrl }]
  })
}

export const failureSignature = record => `${record.id}:` + record.runs
  .filter(run => run.status === 'failed')
  .map(run => `${run.key || run.id}#${run.revision}:${run.error}`).join(' | ')
