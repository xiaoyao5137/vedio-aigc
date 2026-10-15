/** Admit the signed fresh A8+B6 picture/narration as a new scene-01 take.
 * This checkpoint only binds existing bytes. Node53–64 still run normally. */
import { isDeepStrictEqual } from 'node:util'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { sceneCutShotSha256, validateSceneCutVideoPayment,
  verifySceneCutFrameApproval } from './scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { verifyA8B6LocalWorkflowApprovalV8Sync } from
  './staged-scene-cut-a8b6-local-approval-v8.mjs'
import { verifyA8B6LocalWorkflowApprovalV9Sync } from
  './staged-scene-cut-a8b6-local-approval-v9.mjs'
import { verifyA8B6FreshARetakeApprovalSync } from
  './staged-scene-cut-a8b6-A-retake-approval.mjs'
import { verifyFreshA8B6BRetakeApprovalSync } from
  './staged-scene-cut-a8b6-B-retake-approval.mjs'

const WORKFLOW_ID = 'wf-sanguo-history-drama'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const ID = /^record-[\w-]+$/
const MD5 = /^[a-f0-9]{32}$/
const SHA = /^[a-f0-9]{64}$/
const V8_VARIANT = 'a8b6-local-composite-v8'
const V8_IMAGE_ID = 'record-4x5m31-a8b6-local-wall-v8'
const V8_ROUTER_ID = 'record-4x5m31-a8b6-local-v8-router-v1'
const V9_VARIANT = 'a8b6-local-composite-v9'
const V9_IMAGE_ID = 'record-4x5m31-a8b6-local-wall-v9'
const V9_ROUTER_ID = 'record-4x5m31-a8b6-local-v9-router-v1'
const PREVIOUS_B_CHILD_FIELDS = ['planId', 'manifestSha256',
  'approvalSha256', 'phaseBPlanSha256', 'requestSha256', 'taskId',
  'taskSha256', 'mediaSha256', 'videoSha256', 'rejectionSha256']
const fail = reason => { throw Error(`A8B6_FRESH_SOURCE_BOUND_FORK_INVALID: ${reason}`) }
const same = (left, right) => isDeepStrictEqual(left, right)
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

function resolvePath(context, expression) {
  return expression.trim().split('.').reduce((value, key) =>
    value && typeof value === 'object' ? value[key] : undefined, context)
}

/** The saved node's exact parameter templates remain the payment contract. */
function nodeParams(node, context) {
  const params = {}
  for (const param of node.params ?? []) {
    const key = param.englishName?.trim() || param.name
    if (!key || Object.hasOwn(params, key)) fail('duplicate video parameter')
    const template = String(param.value ?? '')
    const reference = /^\$\{([^}]+)\}$/.exec(template.trim())
    let value = reference ? resolvePath(context, reference[1]) : template
    if (!reference && template.includes('${')) value = template.replace(
      /\$\{([^}]+)\}/g, (_, expression) => String(resolvePath(context, expression) ?? ''))
    if (value !== undefined && !reference) {
      if (param.type === 'number') value = Number(value)
      else if (param.type === 'boolean') value = value === 'true'
      else if (param.type === 'json') {
        try { value = JSON.parse(value) }
        catch { fail(`video JSON parameter ${key} is invalid`) }
      }
    }
    if (value === undefined && param.required) fail(`required video parameter ${key} is unresolved`)
    if (value !== undefined) params[key] = value
  }
  return params
}

/** A/B retakes reuse the certified V9 router of the original frame plan. */
export function expectedFreshA8B6RouterBinding(manifest) {
  const retake = ['staged-a8b6-fresh-A-plan-v2',
    'staged-a8b6-fresh-A-plan-v3'].includes(manifest?.version)
  const previous = manifest?.bRetake?.previousChild
  if (retake && manifest.source?.frameProvenanceVariant !== V9_VARIANT)
    fail('A retake must keep the V9 certified first frame')
  if (manifest?.version === 'staged-a8b6-fresh-A-plan-v3'
    && (!SHA.test(String(manifest.bRetake?.parentPlanId))
      || !SHA.test(String(manifest.bRetake?.parentManifestSha256))
      || !SHA.test(String(manifest.bRetake?.parentAAcceptanceSha256))
      || !SHA.test(String(manifest.bRetake?.parentBRejectionSha256))
      || manifest.bRetake.parentWorkflowApprovalSha256
        !== manifest.workflowApprovalSha256))
    fail('B retake parent A plan or acceptance binding missing')
  if (previous && (PREVIOUS_B_CHILD_FIELDS.some(field => field === 'taskId'
    ? !/^[\w-]{8,128}$/.test(String(previous[field]))
    : !SHA.test(String(previous[field])))
    || Object.keys(previous).length !== PREVIOUS_B_CHILD_FIELDS.length
    || previous.planId === manifest.planId
    || previous.planId === manifest.bRetake.parentPlanId))
    fail('previous B-only child binding missing')
  const planId = retake ? manifest.retake?.parentPlanId : manifest?.planId
  const workflowApprovalSha256 = retake
    ? manifest.retake?.parentWorkflowApprovalSha256
    : manifest?.workflowApprovalSha256
  if (!SHA.test(String(planId))
    || !SHA.test(String(workflowApprovalSha256)))
    fail('router plan or approval binding missing')
  return { planId, workflowApprovalSha256 }
}

export function prepareFreshA8B6SourceBoundFork(sourceRow, imageRow,
  workflow, verified, { id = 'record-a8b6-fresh-composite-preview',
    root = process.cwd() } = {}) {
  const sourceMd5 = sourceRow?.result_md5
  const imageMd5 = imageRow?.result_md5
  const { manifest, receipt, manifestSha256, receiptSha256 } = verified ?? {}
  if (!ID.test(String(id)) || !ID.test(String(sourceRow?.id))
    || !ID.test(String(imageRow?.id)) || id === sourceRow.id
    || id === imageRow.id || !MD5.test(String(sourceMd5))
    || !MD5.test(String(imageMd5))
    || sourceRow.workflow_id !== WORKFLOW_ID
    || imageRow.workflow_id !== WORKFLOW_ID
    || workflow?.id !== WORKFLOW_ID || workflow.schema_version !== 180
    || workflow.nodes_md5 !== NODES_MD5 || workflow.edges_md5 !== EDGES_MD5
    || !Array.isArray(workflow.nodes) || workflow.nodes.length !== 72
    || !Array.isArray(workflow.edges) || workflow.edges.length !== 87
    || !SHA.test(String(manifestSha256)) || !SHA.test(String(receiptSha256)))
    fail('record identity, signed receipt or schema180 graph changed')

  const parent = decodeExecutionState(sourceRow.result)
  const approved = decodeExecutionState(imageRow.result)
  const before = parent.nodeRuns, approvedRuns = approved.nodeRuns
  const router = parent.sceneCutA8B6FreshRouterRecovery
  const certificate = before?.[50]?.output
  const v8 = manifest?.source?.frameProvenanceVariant === V8_VARIANT
  const v9 = manifest?.source?.frameProvenanceVariant === V9_VARIANT
  const bRetake = manifest?.version === 'staged-a8b6-fresh-A-plan-v3'
  const retake = manifest?.version === 'staged-a8b6-fresh-A-plan-v2'
    || bRetake
  const approvalPlanId = bRetake
    ? manifest.bRetake?.parentPlanId : manifest?.planId
  const routerBinding = expectedFreshA8B6RouterBinding(manifest)
  if (v9) {
    if (sourceRow.id !== V9_ROUTER_ID || imageRow.id !== V9_IMAGE_ID
      || router?.frameProvenanceVariant !== V9_VARIANT)
      fail('V9 approved frame and router provenance changed')
    const signedApproval = retake
      ? verifyA8B6FreshARetakeApprovalSync(approvalPlanId, root)
      : verifyA8B6LocalWorkflowApprovalV9Sync(manifest.planId, root)
    if (signedApproval.approvalSha256 !== manifest.workflowApprovalSha256
      || signedApproval.approval.approvalExecutionId !== imageRow.id
      || signedApproval.approval.approvalResultMd5 !== imageMd5
      || signedApproval.approval.planId !== approvalPlanId
      || (retake && (signedApproval.approval.parentPlanId
          !== manifest.retake.parentPlanId
        || signedApproval.approval.parentWorkflowApprovalSha256
          !== manifest.retake.parentWorkflowApprovalSha256
        || signedApproval.approval.parentRejectionSha256
          !== manifest.retake.parentRejectionSha256
        || signedApproval.approval.targetSourceReceiptSha256
          !== manifest.retake.targetSourceReceiptSha256
        || signedApproval.approval.targetReviewSha256
          !== manifest.retake.targetReviewSha256
        || signedApproval.approval.targetPromptAmendmentSha256
          !== manifest.retake.targetPromptAmendmentSha256
        || manifest.phaseA?.endFrame?.targetPromptAmendmentSha256
          !== manifest.retake.targetPromptAmendmentSha256
        || signedApproval.approval.targetEndFrameSha256
          !== manifest.phaseA?.endFrame?.sha256
        || signedApproval.approval.targetEndFrameUrl
          !== manifest.phaseA?.endFrame?.url
        || signedApproval.approval.acceptedNativeTail !== false))
      || signedApproval.approval.sceneCutFrameCertificateSha256
        !== manifest.source.frameCertificateSha256
      || signedApproval.approval.localCompositeSourceReceiptSha256
        !== manifest.source.localCompositeSourceReceiptSha256
      || signedApproval.approval.wallImageGenRawSha256
        !== manifest.source.wallImageGenRawSha256
      || signedApproval.approval.priorLocalV8SourceReceiptSha256
        !== manifest.source.priorLocalV8SourceReceiptSha256
      || signedApproval.approval.priorLocalV8RejectedReviewSha256
        !== manifest.source.priorLocalV8RejectedReviewSha256
      || receipt?.workflowApproval?.frameProvenanceVariant !== V9_VARIANT
      || receipt.workflowApproval.approvalSha256
        !== signedApproval.approvalSha256)
      fail('V9 approved frame, router, plan or signed workflow approval changed')
    if (bRetake) {
      const { approval: childApproval } =
        verifyFreshA8B6BRetakeApprovalSync(manifest.planId, root)
      if (childApproval.parentPlanId !== approvalPlanId
        || childApproval.parentWorkflowApprovalSha256
          !== manifest.workflowApprovalSha256
        || childApproval.acceptedA?.acceptanceSha256
          !== manifest.bRetake.parentAAcceptanceSha256
        || childApproval.failedB?.rejectionSha256
          !== manifest.bRetake.parentBRejectionSha256
        || !same(childApproval.previousChild ?? null,
          manifest.bRetake.previousChild ?? null))
        fail('B-only child approval lost parent A or rejected B')
    }
  } else if (router?.frameProvenanceVariant === V9_VARIANT)
    fail('V9 router cannot bind a prior-frame composite plan')
  if (v8) {
    if (sourceRow.id !== V8_ROUTER_ID || imageRow.id !== V8_IMAGE_ID
      || router?.frameProvenanceVariant !== V8_VARIANT)
      fail('V8 approved frame and router provenance changed')
    const signedApproval = verifyA8B6LocalWorkflowApprovalV8Sync(
      manifest.planId, root)
    if (signedApproval.approvalSha256 !== manifest.workflowApprovalSha256
      || signedApproval.approval.approvalExecutionId !== imageRow.id
      || signedApproval.approval.approvalResultMd5 !== imageMd5
      || signedApproval.approval.planId !== manifest.planId
      || signedApproval.approval.sceneCutFrameCertificateSha256
        !== manifest.source.frameCertificateSha256
      || signedApproval.approval.localCompositeSourceReceiptSha256
        !== manifest.source.localCompositeSourceReceiptSha256
      || signedApproval.approval.wallImageGenRawSha256
        !== manifest.source.wallImageGenRawSha256
      || signedApproval.approval.priorLocalV7RejectedReviewSha256
        !== manifest.source.priorLocalV7RejectedReviewSha256
      || receipt?.workflowApproval?.frameProvenanceVariant !== V8_VARIANT
      || receipt.workflowApproval.approvalSha256
        !== signedApproval.approvalSha256)
      fail('V8 approved frame, router, plan or signed workflow approval changed')
  } else if (router?.frameProvenanceVariant === V8_VARIANT)
    fail('V8 router cannot bind a prior-frame composite plan')
  if (parent.id !== sourceRow.id || approved.id !== imageRow.id
    || parent.parentExecutionId !== approved.id
    || parent.workflowId !== WORKFLOW_ID || approved.workflowId !== WORKFLOW_ID
    || parent.requestScopeId !== approved.requestScopeId
    || !parent.requestScopeId || parent.generationScopeId !== parent.id
    || !Array.isArray(before) || before.length !== 464
    || !Array.isArray(approvedRuns) || approvedRuns.length !== 464
    || router?.version !== 'scene-cut-a8b6-fresh-router-v1'
    || router.imageApprovalExecutionId !== imageRow.id
    || router.imageApprovalResultMd5 !== imageMd5
    || router.planId !== routerBinding.planId
    || router.workflowApprovalSha256
      !== routerBinding.workflowApprovalSha256
    || router.workflowSchemaVersion !== 180
    || router.workflowNodesMd5 !== NODES_MD5
    || router.workflowEdgesMd5 !== EDGES_MD5
    || router.preservedPrefixLength !== 51
    || router.preservedPrefixSha256 !== sceneCutRebindSha256(approvedRuns.slice(0, 51))
    || router.firstPendingIndex !== 51
    || router.firstPendingNodeId !== 'sanguo-video-reference-router'
    || !same(before.slice(0, 51), approvedRuns.slice(0, 51))
    || approvedRuns[50]?.status !== 'success'
    || approvedRuns.slice(51).some(run => run.status !== 'idle'
      || run.output !== undefined)
    || before.slice(0, 52).some(run => !['success', 'skipped'].includes(run.status))
    || before[51]?.node?.id !== 'sanguo-video-reference-router'
    || before[51].status !== 'success'
    || before[52]?.node?.id !== 'sanguo-video'
    || before[53]?.node?.id !== 'sanguo-media-request'
    || before[54]?.node?.id !== 'sanguo-video-evidence'
    || before[59]?.node?.id !== 'sanguo-media-accept'
    || before[64]?.node?.id !== 'sanguo-last-frame'
    || before[65]?.node?.id !== 'sanguo-shot-script'
    || before.slice(52).some(run => run.status !== 'idle'
      || run.output !== undefined)
    || before[41]?.output?.version !== 'scene-cut-sources-v1'
    || before[51].output?.referenceMode !== 'three-view-all'
    || !same(before[51].output.referenceImages,
      before[41].output.referenceImages)
    || !same(before[51].output.referenceBindings,
      before[41].output.referenceBindings))
    fail('router parent did not preserve and settle the approved paid prefix')

  verifySceneCutFrameApproval(certificate, root)
  const shot = before[11]?.output
  if (shot?.id !== 'scene-01' || shot.duration !== 14
    || sceneCutShotSha256(shot) !== manifest?.source?.approvedShotSha256
    || shot.scheduleHash !== manifest.source.scheduleHash
    || sceneCutRebindSha256(certificate)
      !== manifest.source.frameCertificateSha256
    || !same(certificate, approvedRuns[50].output)
    || manifest.source.freshFrameExecutionId !== imageRow.id
    || manifest.source.freshFrameResultMd5 !== imageMd5
    || receipt?.version !== 'staged-a8b6-fresh-composite-v1'
    || receipt.planId !== manifest.planId
    || receipt.sourceRecordId !== imageRow.id
    || receipt.sourceResultMd5 !== imageMd5
    || receipt.manifestSha256 !== manifestSha256
    || receipt.workflowApprovalSha256 !== manifest.workflowApprovalSha256
    || receipt.approvedShotSha256 !== manifest.source.approvedShotSha256
    || receipt.firstFrameCertificateSha256
      !== manifest.source.frameCertificateSha256
    || receipt.picture?.silentAudio !== true
    || receipt.narration?.fullSourceMute !== true
    || receipt.narration.mixerVersion !== 6
    || receipt.output?.url !== receipt.narration.url
    || receipt.output.sha256 !== receipt.narration.sha256
    || receipt.output.frameCount !== receipt.mapping?.frameCount
    || receipt.output.frameCount < 335 || receipt.output.frameCount > 339
    || receipt.output.fps !== 24
    || Math.abs(Number(receipt.output.lastPts) - 14) > 2 / 24 + 1e-8
    || receipt.review?.seamVerdict !== 'accept'
    || receipt.review.wholeShot !== 'pending-node58'
    || !Array.isArray(manifest.narrationTracks)
    || manifest.narrationTracks.length !== 3
    || !same(receipt.narration.ttsTrackSha256s,
      manifest.narrationTracks.map(track => track.sha256)))
    fail('fresh paid A/B, original three WAVs or signed 14s output changed')

  const prepared = prepareWorkflowRunContext(before, 52)
  const inputContext = prepared?.inputContext
  if (prepared?.run?.node.id !== 'sanguo-video'
    || inputContext?.scene_cut_frame_gate?.signature !== certificate.signature
    || !same(inputContext?.shot_script, shot)
    || !same(inputContext?.coverage_video_references,
      before[51].output))
    fail('node52 would not use the exact signed first frame and router references')
  const bound = { planId: manifest.planId, manifestSha256, receiptSha256,
    workflowApprovalSha256: manifest.workflowApprovalSha256 }
  const params = { ...nodeParams(before[52].node, inputContext),
    sound: 'off', productionMode: 'source-bound-composite-a8b6-fresh-v1',
    sourceBoundComposite: bound }
  if (params.endImage !== undefined || params.duration !== 14
    || params.referenceImage !== certificate.frame?.sourceUrl
    || !same(params.referenceImages,
      certificate.assets?.map(asset => asset.sourceUrl))
    || !same(params.sceneCutShot, shot)
    || !same(params.sceneCutFrameGate, certificate))
    fail('source-bound take would change the approved payment parameters')
  validateSceneCutVideoPayment(params, root)

  const take = { raw: { version: 'source-bound-composite-a8b6-fresh-v1',
    sourceExecutionId: sourceRow.id, sourceResultMd5: sourceMd5,
    imageApprovalExecutionId: imageRow.id,
    imageApprovalResultMd5: imageMd5,
    ...bound, providerTask: null },
    url: receipt.output.url, model: 'source-bound-composite-a8b6-fresh-v1',
    params,
    narration: { route: 'independent-narration-v1',
      audioRole: 'narration', url: receipt.narration.url,
      pictureUrl: receipt.picture.url,
      tracks: manifest.narrationTracks,
      compositionReceiptKey: receipt.narration.compositionReceiptKey,
      fullSourceMute: true, mixerVersion: 6 },
    voiceConsistency: { status: 'uncertain',
      reason: '整镜仍须按真实音画采证和人工听辨重新审核' },
    qualityDisposition: 'manual-review-v1',
    sourceBoundComposite: { version: 'source-bound-composite-a8b6-fresh-v1',
      ...bound, sourceExecutionId: sourceRow.id,
      sourceResultMd5: sourceMd5,
      imageApprovalExecutionId: imageRow.id,
      imageApprovalResultMd5: imageMd5,
      outputSha256: receipt.output.sha256,
      pictureSha256: receipt.picture.sha256,
      phaseAAcceptanceSha256: receipt.sources.phaseA.acceptanceSha256,
      phaseBAcceptanceSha256: receipt.sources.phaseB.acceptanceSha256,
      wholeShotReview: 'pending-node58' } }
  const takeContext = applyNodeOutputToContext(inputContext,
    before[52].node.resultVar, take)
  const selected = { ...before[52], output: take, context: takeContext,
    inputContext, inputs: { ...params }, routeInputOverrides: undefined,
    status: 'success', revision: Number(before[52].revision ?? 0) + 1,
    startedAt: undefined, durationMs: 0 }
  const replaced = before.map((run, index) => index === 52 ? selected : run)
  const nodeRuns = refreshPendingExecutionNodes(workflow, replaced)
  if (!same(nodeRuns.slice(0, 52), before.slice(0, 52))
    || !same(nodeRuns[52], selected)
    || nodeRuns.slice(53).some(run => run.status !== 'idle'
      || run.output !== undefined || Object.keys(run.context ?? {}).length)
    || nodeRuns.findIndex(run => run.status === 'idle') !== 53)
    fail('fork changed the approved prefix or retained later review state')
  const next = prepareWorkflowRunContext(nodeRuns, 53)
  if (next?.run?.node.id !== 'sanguo-media-request'
    || next.inputContext?.video_take?.url !== receipt.output.url
    || next.inputContext?.media_review !== undefined
    || next.inputContext?.video_evidence !== undefined)
    fail('new whole-shot review would not start from the signed composite')

  const marker = { version: 'source-bound-composite-a8b6-fresh-first-shot-v1',
    stagingVariant: 'a8b6-fresh',
    ...(v8 ? { frameProvenanceVariant: V8_VARIANT,
      localCompositeSourceReceiptSha256:
        manifest.source.localCompositeSourceReceiptSha256,
      approvedFirstFrameSha256: manifest.source.approvedFirstFrameSha256,
      priorLocalV7RejectedReviewSha256:
        manifest.source.priorLocalV7RejectedReviewSha256 } : {}),
    ...(v9 ? { frameProvenanceVariant: V9_VARIANT,
      localCompositeSourceReceiptSha256:
        manifest.source.localCompositeSourceReceiptSha256,
      approvedFirstFrameSha256: manifest.source.approvedFirstFrameSha256,
      priorLocalV8SourceReceiptSha256:
        manifest.source.priorLocalV8SourceReceiptSha256,
      priorLocalV8RejectedReviewSha256:
        manifest.source.priorLocalV8RejectedReviewSha256 } : {}),
    sourceExecutionId: sourceRow.id, sourceResultMd5: sourceMd5,
    imageApprovalExecutionId: imageRow.id,
    imageApprovalResultMd5: imageMd5,
    imageApprovalPrefixLength: 51,
    imageApprovalPrefixSha256: sceneCutRebindSha256(approvedRuns.slice(0, 51)),
    workflowSchemaVersion: 180, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5,
    originalExecutionId: 'record-4x5m31',
    planId: manifest.planId, manifestSha256, receiptSha256,
    workflowApprovalSha256: manifest.workflowApprovalSha256,
    preservedPrefixLength: 52,
    preservedPrefixSha256: sceneCutRebindSha256(before.slice(0, 52)),
    compositeVideoUrl: receipt.output.url,
    compositeVideoSha256: receipt.output.sha256,
    compositeTakeSha256: sceneCutRebindSha256(take),
    firstPendingIndex: 53, firstPendingNodeId: 'sanguo-media-request',
    wholeShotReview: 'pending-node58' }
  const state = { ...parent, id, parentExecutionId: sourceRow.id,
    generationScopeId: id, requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns, context: takeContext,
    selectedNodeId: marker.firstPendingNodeId,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutCompositeRecovery: marker,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      `保留 ${sourceRow.id} 已签首帧与引用路由；从真正验收的 A8+B6 原生镜头、三句原始旁白及签名成片收据进入整镜采证。`] }
  if (sceneCutRebindSha256(decodeExecutionState(JSON.parse(JSON.stringify(
    encodeExecutionState(state))))) !== sceneCutRebindSha256(state))
    fail('execution storage round trip changed source-bound checkpoint')
  return { state, proof: { ...marker, newExecutionId: id,
    frameCount: receipt.output.frameCount,
    sourceVideoUrl: receipt.output.url,
    originalNarrationTrackSha256s:
      manifest.narrationTracks.map(track => track.sha256),
    providerCalls: 0, databaseWrites: 0, firstShotAccepted: false,
    roundTripVerified: true } }
}
