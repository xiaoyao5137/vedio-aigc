// Scene-cut repair binding. Vite adds rejected-frame and geometry references
// only after the running fork and failed parent are proven; approval rechecks.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { prepareRejectedSceneCutEditReference } from '../scripts/prepare-scene-cut-rejected-image-edit-reference.mjs'
import { prepareRejectedSceneCutFourReferences } from '../scripts/prepare-scene-cut-rejected-image-four-reference.mjs'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { modelRequestFingerprint } from './model-request-key.ts'
import { assertSceneCutApprovalRebindHop, assertSceneCutSameMediaReviewHop } from './scene-cut-approval-rebind.ts'
import { assertSceneCutTailGuideRebindHop } from './scene-cut-tail-guide-rebind.ts'

const WORKFLOW_ID = 'wf-sanguo-history-drama'
const IMAGE_NODE = 'sanguo-scene-cut-first-frame'
export const SCENE_CUT_REPAIR_ANCHOR = Object.freeze({
  sourceId: 'record-4x5m31-original-repair-v6',
  sourceMd5: '21f1f7a2131fe7c3d0e97998d16245a3',
  parentId: 'record-4x5m31-original-repair-v5',
  parentMd5: 'b5ac0f516ad8a44ca175e506aaccc67d',
  originalId: 'record-4x5m31',
  originalMd5: '74e5e2f8afcf8f829694aef350629950',
  sourceImageSha256: '2592c8f00f59d4511c85bdf9bf13fc67f539eb49ea4f91ee7780704626df5f73',
  sourceReviewSha256: 'd4a00dbe88ea9a5dabd6cfea6be4e8a2633a3da30f162440a908ddcddf6ee7dc',
  boardSha256s: [
    '23ce09a524d46ac2b48a4c96dd4cd8f497c91ed4a6c8b9dc5483377575917edc',
    '55c299bd043eb89664e44cc18e00caccd8c5ac9f61c2ea6e0eb9b463f191000c',
  ],
})
export const SCENE_CUT_GEOMETRY_ANCHOR = Object.freeze({
  sourceId: 'record-4x5m31-original-repair-v7',
  sourceMd5: '0c2421f0e2e33a563f73c44dea53d44f',
  parentId: 'record-4x5m31-original-repair-v6',
  parentMd5: '21f1f7a2131fe7c3d0e97998d16245a3',
  originalId: 'record-4x5m31',
  originalMd5: '74e5e2f8afcf8f829694aef350629950',
  sourceImageSha256: '4218a56c75d532f7cf629176d73b7138c05e28be656c9ff5831568dc6828fb48',
  sourceReviewSha256: 'faad209cbc612d5eb67e2d32f2a668e0a15dc76fdb3cfa94bb4d4784902f2da2',
  guidePath: 'qa/record-4x5m31/geometry-guide-v8-0d23d49f.png',
  guideSha256: '0d23d49f076dc1ce1e52a6de81f049d588499be720037755c73e3f8f9f0726b2',
  guideJpegSha256: '382a940c7a1cb44952796e0f710d30d77810f03ea2ea537baefbac1789480fb2',
  guideProvenancePath: 'qa/record-4x5m31/geometry-guide-v8-provenance.json',
  guideProvenanceSha256: '4005ced1b6d381d8c474ec2e606186394509ec9a728c70f23009f3684cf84e2d',
  guideIntermediateSha256: 'b406593275a459b6936b70e74fd70da822b660ac70adf71beaf9b5358b8512b5',
  guideDimensions: [1672, 941],
  boardSha256s: SCENE_CUT_REPAIR_ANCHOR.boardSha256s,
})
const fail = message => { throw Error(`SCENE_CUT_EDIT_BINDER_INVALID: ${message}`) }
const object = input => input && typeof input === 'object' && !Array.isArray(input) ? input : {}
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = input => Array.isArray(input) ? `[${input.map(canonical).join(',')}]`
  : input && typeof input === 'object'
    ? `{${Object.entries(input).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(input ?? null)
const hashJson = input => hashBytes(Buffer.from(canonical(input)))
const structuralHash = createJsonHasher()
const same = isDeepStrictEqual
const md5 = input => typeof input === 'string' && /^[a-f0-9]{32}$/.test(input)

function assertGuideProvenance(bytes, anchor = SCENE_CUT_GEOMETRY_ANCHOR) {
  if (!Buffer.isBuffer(bytes) || hashBytes(bytes) !== anchor.guideProvenanceSha256) {
    fail('geometry guide provenance bytes changed')
  }
  let proof
  try { proof = JSON.parse(bytes.toString('utf8')) } catch { fail('geometry guide provenance invalid') }
  if (proof.version !== 'scene-cut-geometry-guide-v1'
    || proof.role !== 'geometry-only-reference' || proof.approvedFirstFrame !== false
    || proof.sourceExecutionId !== anchor.sourceId
    || proof.sourceImageSha256 !== anchor.sourceImageSha256
    || proof.identityBoardSha256 !== anchor.boardSha256s[1]
    || proof.intermediateImageSha256 !== anchor.guideIntermediateSha256
    || proof.guideImagePath !== anchor.guidePath
    || proof.guideImageSha256 !== anchor.guideSha256
    || !same(proof.guideDimensions, anchor.guideDimensions)
    || proof.acceptanceStatus !== 'unreviewed geometry reference only') {
    fail('geometry guide provenance does not identify an unapproved layout reference')
  }
  return anchor.guideProvenanceSha256
}

/** A key must identify the exact in-flight first-scene image; never use includes(). */
export function parseSceneCutRepairImageRequestKey(requestKey) {
  const match = typeof requestKey === 'string' ? requestKey.match(
    /^(record-[A-Za-z0-9_-]+):attempt-([1-9]\d*):revision-(0|[1-9]\d*):sanguo-scene-cut-first-frame:0:scene-01$/) : null
  if (!match) fail('requestKey does not identify the current first-scene image')
  const attempt = Number(match[2]), revision = Number(match[3])
  if (!Number.isSafeInteger(attempt) || !Number.isSafeInteger(revision)) fail('requestKey attempt or revision overflow')
  return { executionId: match[1], attempt, revision, loopIndex: 0, sceneId: 'scene-01' }
}

/** Resolve the active video run before its paid gate, without mutating it. */
export async function readSceneCutRepairVideoContext(queryable, request, root = process.cwd()) {
  if (request?.executionContext?.workflowId !== WORKFLOW_ID
    || request.executionContext.nodeId !== 'sanguo-video'
    || request?.model?.capability !== 'video') return null
  const match = typeof request.executionContext.requestKey === 'string'
    ? request.executionContext.requestKey.match(
      /^(record-[A-Za-z0-9_-]+):attempt-([1-9]\d*):revision-(0|[1-9]\d*):sanguo-video:(0|[1-9]\d*):(scene-[0-9]+)$/)
    : null
  if (!match) fail('paid video requestKey does not identify an active run')
  const attempt = Number(match[2]), revision = Number(match[3]), loopIndex = Number(match[4])
  if (![attempt, revision, loopIndex].every(Number.isSafeInteger)) fail('paid video requestKey overflow')
  const row = (await queryable.query(`select id,workflow_id,result,md5(result::text) as result_md5
    from execution_records where id=$1`, [match[1]])).rows[0]
  const state = decodeExecutionState(row?.result ?? {})
  const matchingRuns = Array.isArray(state.nodeRuns) ? state.nodeRuns.filter(run =>
    run.node?.id === 'sanguo-video' && run.loopIndex === loopIndex
    && run.status === 'running' && (run.attempt ?? 1) === attempt
    && (run.revision ?? 0) === revision
    && run.inputs?.sceneCutShot?.id === match[5]) : []
  if (row?.workflow_id !== WORKFLOW_ID || state.id !== match[1]
    || state.workflowId !== WORKFLOW_ID || state.selectedNodeId !== 'sanguo-video'
    || matchingRuns.length !== 1
    || request.params?.sceneCutShot?.id !== match[5]
    || !same(request.params.sceneCutShot, matchingRuns[0].inputs.sceneCutShot)) {
    fail('paid video request is not bound to the persisted running node')
  }
  // The repair markers are inherited through later scene-loop rounds. Only
  // the first shot owns the rejected-image/tail-guide lineage; a later hard
  // cut must use its own signed first-frame approval and actual prior tail.
  if (loopIndex !== 0 || match[5] !== 'scene-01') {
    return { executionId: state.id, recovery: null, tailGuide: null }
  }
  const marker = state.sceneCutApprovalRebindRecovery
  if (marker?.version !== 'scene-cut-approval-rebind-v2') {
    return { executionId: state.id, recovery: state.sceneCutImageRepairRecovery ?? null }
  }
  const load = async id => {
    const found = (await queryable.query(`select id,workflow_id,result,md5(result::text) as result_md5
      from execution_records where id=$1`, [id])).rows[0]
    if (!found || found.workflow_id !== WORKFLOW_ID) fail('tail-guide ancestor record is missing')
    return { state: decodeExecutionState(found.result), resultMd5: found.result_md5 }
  }
  const ledger = async id => {
    const found = (await queryable.query(`select id,status,model_id,request_data,response_data
      from model_execution_records where id=$1`, [id])).rows[0]
    if (!found) fail('tail-guide independent review ledger is missing')
    return { id: found.id, status: found.status, modelId: found.model_id,
      requestKey: found.request_data?.requestKey,
      fingerprint: found.request_data?.fingerprint,
      output: parseStructuredJson(extractTextResponse(found.response_data)) }
  }
  const source = await load(marker.sourceExecutionId)
  const nativeSource = await load(marker.nativeSourceExecutionId)
  const nativeReview = await load(marker.nativeReviewExecutionId)
  const nativeReviewLedger = await ledger(marker.nativeVideoReviewExecutionId)
  const currentReviewLedger = await ledger(marker.failedVideoReviewExecutionId)
  if (source.state.parentExecutionId !== nativeReview.state.id
    || source.resultMd5 !== marker.sourceResultMd5
    || nativeReview.resultMd5 !== marker.nativeReviewResultMd5
    || nativeSource.resultMd5 !== marker.nativeSourceResultMd5) {
    fail('tail-guide ancestry or source MD5 changed')
  }
  const priorMarker = source.state.sceneCutApprovalRebindRecovery
  assertSceneCutSameMediaReviewHop(nativeSource.state, nativeReview.state, priorMarker,
    nativeSource.resultMd5, nativeReview.resultMd5)
  assertSceneCutApprovalRebindHop(nativeReview.state, source.state,
    nativeReview.resultMd5, root, false, nativeReviewLedger)
  const tailGuide = assertSceneCutTailGuideRebindHop(source.state, state,
    source.resultMd5, { nativeSource, nativeReview, nativeReviewLedger,
      currentReviewLedger }, root, 'video')
  return { executionId: state.id, recovery: state.sceneCutImageRepairRecovery ?? null,
    tailGuide }
}

function expectedParentKey(recordId, nodeId, run) {
  const attempt = run?.attempt ?? 1, revision = run?.revision ?? 0
  if (!Number.isSafeInteger(attempt) || attempt < 1
    || !Number.isSafeInteger(revision) || revision < 0) fail('parent run attempt/revision invalid')
  return `${recordId}:attempt-${attempt}:revision-${revision}:${nodeId}:0:scene-01`
}

function imageLedgerIdentity(rows, key, receipt, expectedReferenceOrder = receipt.referenceOrder.slice(0, -1)) {
  const candidates = rows.filter(row => row?.channel === 'workflow' && row.workflow_id === WORKFLOW_ID
    && row.node_id === IMAGE_NODE && row.capability === 'image' && row.provider === 'Codex'
    && row.status === 'succeeded' && row.request_data?.requestKey === key
    && row.response_data?.data?.[0]?.url === receipt.sourceImageUrl
    && row.response_data?.raw?.image?.sha256 === receipt.sourceImageSha256
    && row.response_data?.raw?.image?.bytes > 0
    && same(row.response_data?.raw?.references,
      expectedReferenceOrder.map(item => ({ index: item.position,
        bytes: item.bytes, sha256: item.sha256 ?? item.jpegSha256 })))
    && typeof row.request_data?.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(row.request_data.fingerprint))
  if (candidates.length !== 1 || !/^model-run-[\w-]+$/.test(candidates[0].id)) {
    fail('parent image ledger is missing or ambiguous')
  }
  return candidates[0]
}

function reviewLedgerIdentity(rows, key, review) {
  const reviewed = Object.fromEntries(Object.entries(review).filter(([name]) => !['text', 'raw', 'model'].includes(name)))
  const candidates = rows.filter(row => {
    if (row?.channel !== 'workflow' || row.workflow_id !== WORKFLOW_ID
      || row.node_id !== 'sanguo-scene-cut-review' || row.capability !== 'text'
      || row.provider === 'Local' || row.status !== 'succeeded'
      || row.request_data?.requestKey !== key || row.model_id !== review.model
      || typeof row.request_data?.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(row.request_data.fingerprint)) return false
    try { return same(parseStructuredJson(extractTextResponse(row.response_data)), reviewed) }
    catch { return false }
  })
  if (candidates.length !== 1 || !/^model-run-[\w-]+$/.test(candidates[0].id)) {
    fail('parent independent review ledger is missing or ambiguous')
  }
  return candidates[0]
}

/** Pure binding from pinned database rows and archived bytes. No provider call. */
export async function prepareSceneCutRejectedEditBoundRequest(request, proof,
  anchor = SCENE_CUT_REPAIR_ANCHOR) {
  if (request?.model?.provider !== 'Codex' || request.model.capability !== 'image'
    || request.executionContext?.workflowId !== WORKFLOW_ID
    || request.executionContext?.nodeId !== IMAGE_NODE
    || !request.params || typeof request.prompt !== 'string' || !request.prompt.trim()) {
    fail('request is not the managed Codex scene-cut image')
  }
  const identity = parseSceneCutRepairImageRequestKey(request.executionContext.requestKey)
  const currentRow = object(proof?.currentRow), originalRow = object(proof?.originalRow)
  const current = decodeExecutionState(currentRow.result)
  if (currentRow.id !== identity.executionId || currentRow.workflow_id !== WORKFLOW_ID
    || current.id !== identity.executionId || current.workflowId !== WORKFLOW_ID
    || current.generationScopeId !== current.id || current.selectedNodeId !== IMAGE_NODE) {
    fail('requestKey is not bound to the running execution')
  }
  const run = current.nodeRuns?.[45], sources = object(run?.inputs?.sceneCutSources)
  if (run?.node?.id !== IMAGE_NODE || run.status !== 'running' || run.loopIndex !== 0
    || (run.attempt ?? 1) !== identity.attempt || (run.revision ?? 0) !== identity.revision
    || run.inputs?.sceneCutShot?.id !== identity.sceneId
    || !same(request.params.referenceImages, run.inputs?.referenceImages)
    || !same(request.params.sceneCutSources, sources)
    || !same(request.params.sceneCutShot, run.inputs?.sceneCutShot)
    || !same(request.params.sceneCutOpeningPlan, run.inputs?.sceneCutOpeningPlan)
    || request.params.sceneCutRepairReceipt !== undefined) {
    fail('submitted two-board inputs differ from the persisted running node')
  }
  const recovery = current.sceneCutImageRepairRecovery
  if (!recovery) {
    if (!Array.isArray(sources.imageReferenceImages)
      || !same(request.params.referenceImages, sources.imageReferenceImages)) {
      fail('ordinary request attempted an unapproved extra reference')
    }
    return { request, applied: false, ledgerIdentity: null }
  }
  const parentRow = object(proof.parentRow), lineageRow = object(proof.lineageRow)
  const workflowRow = object(proof.workflowRow)
  if (recovery.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || recovery.sourceExecutionId !== anchor.sourceId || recovery.sourceResultMd5 !== anchor.sourceMd5
    || recovery.parentExecutionId !== anchor.parentId || recovery.parentResultMd5 !== anchor.parentMd5
    || recovery.originalExecutionId !== anchor.originalId || recovery.originalResultMd5 !== anchor.originalMd5
    || recovery.workflowSchemaVersion !== 177 || recovery.preservedPrefixLength !== 45
    || recovery.firstPendingNodeId !== IMAGE_NODE
    || recovery.failedImageFileSha256 !== anchor.sourceImageSha256
    || recovery.failedReviewOutputSha256 !== anchor.sourceReviewSha256
    || !/^[a-f0-9]{64}$/.test(recovery.repairPreparationSha256 ?? '')
    || current.parentExecutionId !== anchor.sourceId
    || parentRow.id !== anchor.sourceId || parentRow.result_md5 !== anchor.sourceMd5
    || parentRow.workflow_id !== WORKFLOW_ID
    || lineageRow.id !== anchor.parentId || lineageRow.result_md5 !== anchor.parentMd5
    || lineageRow.workflow_id !== WORKFLOW_ID
    || originalRow.id !== anchor.originalId || originalRow.result_md5 !== anchor.originalMd5
    || originalRow.workflow_id !== WORKFLOW_ID
    || workflowRow.id !== WORKFLOW_ID || workflowRow.schema_version !== 177
    || !md5(workflowRow.nodes_md5) || !md5(workflowRow.edges_md5)
    || workflowRow.nodes_md5 !== recovery.workflowNodesMd5
    || workflowRow.edges_md5 !== recovery.workflowEdgesMd5
    || !same(run.node, workflowRow.nodes?.find(node => node.id === IMAGE_NODE))) {
    fail('repair fork source/original/workflow CAS provenance changed')
  }
  const parent = decodeExecutionState(parentRow.result)
  if (parent.id !== anchor.sourceId || parent.sceneCutFirstFrameRecovery?.workflowSchemaVersion !== 176
    || parent.originalTwoShotRepairRecovery?.sourceExecutionId !== anchor.originalId
    || !same(current.originalTwoShotRepairRecovery, parent.originalTwoShotRepairRecovery)
    || current.nodeRuns?.length !== parent.nodeRuns?.length
    || !same(current.nodeRuns.slice(0, 45).map(item => item.id),
      parent.nodeRuns.slice(0, 45).map(item => item.id))
    || !same(current.nodeRuns.slice(0, 45).map(item => item.output ?? null),
      parent.nodeRuns.slice(0, 45).map(item => item.output ?? null))
    || current.nodeRuns.slice(46).some(item => item.status !== 'idle')
    || recovery.preservedPrefixOutputsHash !== structuralHash(parent.nodeRuns.slice(0, 45)
      .map(item => item.output ?? null))) {
    fail('repair fork did not preserve the approved prefix or isolate new media')
  }
  const prepared = await prepareRejectedSceneCutEditReference({ source: parent,
    sourceResultMd5: parentRow.result_md5, expectedSourceId: anchor.sourceId,
    expectedSourceMd5: anchor.sourceMd5, expectedImageSha256: anchor.sourceImageSha256,
    expectedReviewSha256: anchor.sourceReviewSha256,
    sourcePngBytes: proof.sourcePngBytes, identityBoardBytes: proof.identityBoardBytes })
  if (prepared.receiptSha256 !== recovery.repairPreparationSha256
    || !same(recovery.receipt, prepared.receipt)
    || !same(request.params.referenceImages, prepared.referenceImages.slice(0, 2))
    || !same(prepared.receipt.referenceOrder.slice(0, 2).map(item => item.sha256), anchor.boardSha256s)) {
    fail('third reference preparation differs from the fork receipt or frozen boards')
  }
  const parentImageKey = expectedParentKey(anchor.sourceId, IMAGE_NODE, parent.nodeRuns[45])
  const parentReviewKey = expectedParentKey(anchor.sourceId, 'sanguo-scene-cut-review', parent.nodeRuns[49])
  const imageLedger = imageLedgerIdentity(proof.parentImageLedgerRows ?? [], parentImageKey, prepared.receipt)
  const reviewLedger = reviewLedgerIdentity(proof.parentReviewLedgerRows ?? [], parentReviewKey,
    parent.nodeRuns[49].output)
  const receipt = { ...prepared.receipt,
    preparationSha256: prepared.receiptSha256,
    sourceImageModelExecutionId: imageLedger.id,
    failedReviewModelExecutionId: reviewLedger.id,
    sourceImageModelFingerprint: imageLedger.request_data.fingerprint,
    failedReviewModelFingerprint: reviewLedger.request_data.fingerprint }
  const receiptSha256 = hashJson(receipt)
  const nextRequest = { ...request, params: { ...request.params,
    referenceImages: prepared.referenceImages, sceneCutRepairReceipt: receipt } }
  return { request: nextRequest, applied: true,
    ledgerIdentity: { requestKey: request.executionContext.requestKey,
      requestFingerprint: modelRequestFingerprint(nextRequest),
      repairReceiptSha256: receiptSha256, preparationSha256: prepared.receiptSha256,
      sourceExecutionId: anchor.sourceId, sourceResultMd5: anchor.sourceMd5,
      sourceImageModelExecutionId: imageLedger.id,
      failedReviewModelExecutionId: reviewLedger.id,
      referenceSha256s: prepared.receipt.referenceOrder.map(item => item.sha256 ?? item.jpegSha256),
      referenceBytes: prepared.receipt.referenceOrder.map(item => item.bytes) } }
}

/** Schema178 four-reference binding. The guide is geometry only and never an
 * approved frame or identity source. `phase=completed` replays the proof at
 * signing time without issuing another provider request. */
export async function prepareSceneCutGeometryBoundRequest(request, proof,
  { anchor = SCENE_CUT_GEOMETRY_ANCHOR, phase = 'running' } = {}) {
  if (!['running', 'completed'].includes(phase)
    || request?.model?.provider !== 'Codex' || request.model.capability !== 'image'
    || request.executionContext?.workflowId !== WORKFLOW_ID
    || request.executionContext?.nodeId !== IMAGE_NODE
    || !request.params || typeof request.prompt !== 'string' || !request.prompt.trim()) {
    fail('four-reference request is not the managed Codex scene-cut image')
  }
  const identity = parseSceneCutRepairImageRequestKey(request.executionContext.requestKey)
  const currentRow = object(proof?.currentRow), sourceRow = object(proof?.parentRow)
  const lineageRow = object(proof?.lineageRow), originalRow = object(proof?.originalRow)
  const workflowRow = object(proof?.workflowRow)
  const current = decodeExecutionState(currentRow.result)
  const run = current.nodeRuns?.[45], recovery = object(current.sceneCutImageRepairRecovery)
  const sources = object(run?.inputs?.sceneCutSources)
  if (currentRow.id !== identity.executionId || currentRow.workflow_id !== WORKFLOW_ID
    || current.id !== identity.executionId || current.workflowId !== WORKFLOW_ID
    || current.generationScopeId !== current.id
    || phase === 'running' && current.selectedNodeId !== IMAGE_NODE
    || run?.node?.id !== IMAGE_NODE || run.loopIndex !== 0
    || run.status !== (phase === 'running' ? 'running' : 'success')
    || (run.attempt ?? 1) !== identity.attempt || (run.revision ?? 0) !== identity.revision
    || run.inputs?.sceneCutShot?.id !== identity.sceneId
    || !same(request.params.referenceImages, run.inputs?.referenceImages)
    || !same(request.params.sceneCutSources, sources)
    || !same(request.params.sceneCutShot, run.inputs?.sceneCutShot)
    || !same(request.params.sceneCutOpeningPlan, run.inputs?.sceneCutOpeningPlan)
    || request.params.sceneCutRepairReceipt !== undefined
    || phase === 'completed' && (!same(run.output?.params, request.params)
      || run.output?.prompt !== request.prompt || run.output?.model !== request.model.id)) {
    fail('four-reference request differs from the persisted image run')
  }
  if (recovery.version !== 'scene-cut-image-repair-schema178-fork-v2'
    || recovery.sourceExecutionId !== anchor.sourceId || recovery.sourceResultMd5 !== anchor.sourceMd5
    || recovery.parentExecutionId !== anchor.parentId || recovery.parentResultMd5 !== anchor.parentMd5
    || recovery.originalExecutionId !== anchor.originalId || recovery.originalResultMd5 !== anchor.originalMd5
    || recovery.workflowSchemaVersion !== 178 || recovery.preservedPrefixLength !== 45
    || recovery.firstPendingNodeId !== IMAGE_NODE
    || recovery.failedImageFileSha256 !== anchor.sourceImageSha256
    || recovery.failedReviewOutputSha256 !== anchor.sourceReviewSha256
    || recovery.geometryGuideSourcePath !== anchor.guidePath
    || recovery.geometryGuideSourceSha256 !== anchor.guideSha256
    || recovery.geometryGuideJpegSha256 !== anchor.guideJpegSha256
    || recovery.geometryGuideProvenancePath !== anchor.guideProvenancePath
    || recovery.geometryGuideProvenanceSha256 !== anchor.guideProvenanceSha256
    || !/^[a-f0-9]{64}$/.test(recovery.repairPreparationSha256 ?? '')
    || current.parentExecutionId !== anchor.sourceId
    || current.sceneCutFirstFrameRecovery?.workflowSchemaVersion !== 178
    || sourceRow.id !== anchor.sourceId || sourceRow.result_md5 !== anchor.sourceMd5
    || sourceRow.workflow_id !== WORKFLOW_ID
    || lineageRow.id !== anchor.parentId || lineageRow.result_md5 !== anchor.parentMd5
    || lineageRow.workflow_id !== WORKFLOW_ID
    || originalRow.id !== anchor.originalId || originalRow.result_md5 !== anchor.originalMd5
    || originalRow.workflow_id !== WORKFLOW_ID
    || workflowRow.id !== WORKFLOW_ID || workflowRow.schema_version !== 178
    || !md5(workflowRow.nodes_md5) || !md5(workflowRow.edges_md5)
    || workflowRow.nodes_md5 !== recovery.workflowNodesMd5
    || workflowRow.edges_md5 !== recovery.workflowEdgesMd5
    || !same(run.node, workflowRow.nodes?.find(node => node.id === IMAGE_NODE))) {
    fail('four-reference fork source, guide or workflow CAS provenance changed')
  }
  const source = decodeExecutionState(sourceRow.result)
  const prior = object(source.sceneCutImageRepairRecovery)
  if (source.id !== anchor.sourceId || source.parentExecutionId !== anchor.parentId
    || source.sceneCutFirstFrameRecovery?.workflowSchemaVersion !== 177
    || source.originalTwoShotRepairRecovery?.sourceExecutionId !== anchor.originalId
    || prior.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || recovery.priorRepairPreparationSha256 !== prior.repairPreparationSha256
    || !same(current.priorSceneCutImageRepairRecovery, prior)
    || !same(current.originalTwoShotRepairRecovery, source.originalTwoShotRepairRecovery)
    || current.nodeRuns?.length !== source.nodeRuns?.length
    || !same(current.nodeRuns.slice(0, 45).map(item => item.id),
      source.nodeRuns.slice(0, 45).map(item => item.id))
    || !same(current.nodeRuns.slice(0, 45).map(item => item.output ?? null),
      source.nodeRuns.slice(0, 45).map(item => item.output ?? null))
    || phase === 'running' && current.nodeRuns.slice(46).some(item => item.status !== 'idle')
    || recovery.preservedPrefixOutputsHash !== structuralHash(source.nodeRuns.slice(0, 45)
      .map(item => item.output ?? null))) {
    fail('four-reference fork changed approved prefix or prior rejected-image proof')
  }
  const guideProvenanceSha256 = assertGuideProvenance(proof.guideProvenanceBytes, anchor)
  const prepared = await prepareRejectedSceneCutFourReferences({ source,
    sourceResultMd5: sourceRow.result_md5, expectedSourceId: anchor.sourceId,
    expectedSourceMd5: anchor.sourceMd5, expectedImageSha256: anchor.sourceImageSha256,
    expectedReviewSha256: anchor.sourceReviewSha256,
    expectedGuideSha256: anchor.guideSha256, guidePath: anchor.guidePath,
    sourcePngBytes: proof.sourcePngBytes, guidePngBytes: proof.guidePngBytes,
    identityBoardBytes: proof.identityBoardBytes })
  const guide = object(prepared.receipt.referenceOrder?.[3])
  if (prepared.receiptSha256 !== recovery.repairPreparationSha256
    || !same(recovery.receipt, prepared.receipt)
    || !same(request.params.referenceImages, prepared.referenceImages.slice(0, 2))
    || !same(prepared.receipt.referenceOrder.slice(0, 2).map(item => item.sha256), anchor.boardSha256s)
    || guide.sourcePath !== anchor.guidePath || guide.sourceSha256 !== anchor.guideSha256
    || guide.jpegSha256 !== anchor.guideJpegSha256 || guide.purpose !== 'geometry-only'
    || guide.referenceOnly !== true) {
    fail('four-reference preparation differs from frozen boards, failed frame or guide')
  }
  const imageKey = expectedParentKey(anchor.sourceId, IMAGE_NODE, source.nodeRuns[45])
  const reviewKey = expectedParentKey(anchor.sourceId, 'sanguo-scene-cut-review', source.nodeRuns[49])
  const priorOrder = prior.receipt?.referenceOrder
  if (!Array.isArray(priorOrder) || priorOrder.length !== 3) fail('prior three-reference receipt missing')
  const imageLedger = imageLedgerIdentity(proof.parentImageLedgerRows ?? [], imageKey,
    prepared.receipt, priorOrder)
  const reviewLedger = reviewLedgerIdentity(proof.parentReviewLedgerRows ?? [], reviewKey,
    source.nodeRuns[49].output)
  const sourceRaw = object(source.nodeRuns[45].output?.raw)
  if (imageLedger.id !== sourceRaw.modelExecutionId
    || imageLedger.request_data.fingerprint !== sourceRaw.repairRequestFingerprint
    || imageLedger.request_data.sceneCutRepairReceiptSha256 !== sourceRaw.sceneCutRepairReceiptSha256
    || imageLedger.request_data.params?.sceneCutRepairReceipt?.version
      !== 'scene-cut-rejected-image-edit-reference-v1') {
    fail('parent three-reference image ledger is not the rejected v7 candidate')
  }
  const receipt = { ...prepared.receipt,
    preparationSha256: prepared.receiptSha256,
    guideProvenanceSha256,
    sourceImageModelExecutionId: imageLedger.id,
    failedReviewModelExecutionId: reviewLedger.id,
    sourceImageModelFingerprint: imageLedger.request_data.fingerprint,
    failedReviewModelFingerprint: reviewLedger.request_data.fingerprint }
  const nextRequest = { ...request, params: { ...request.params,
    referenceImages: prepared.referenceImages, sceneCutRepairReceipt: receipt } }
  return { request: nextRequest, applied: true,
    ledgerIdentity: phase === 'running' ? {
      requestKey: request.executionContext.requestKey,
      requestFingerprint: modelRequestFingerprint(nextRequest),
      repairReceiptSha256: hashJson(receipt), preparationSha256: prepared.receiptSha256,
      sourceExecutionId: anchor.sourceId, sourceResultMd5: anchor.sourceMd5,
      sourceImageModelExecutionId: imageLedger.id,
      failedReviewModelExecutionId: reviewLedger.id,
      referenceSha256s: prepared.receipt.referenceOrder.map(item => item.sha256 ?? item.jpegSha256),
      referenceBytes: prepared.receipt.referenceOrder.map(item => item.bytes) } : null }
}

async function generatedBytes(url, root) {
  if (typeof url !== 'string' || !/^\/generated\/[A-Za-z0-9._-]+\.(?:png|jpg)$/.test(url)) {
    fail('archived image URL is invalid')
  }
  const filename = path.join(root, 'public', url)
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 64 || stat.size > 20 * 1024 * 1024) fail('archived image file invalid')
    return await handle.readFile()
  } finally { await handle.close() }
}

async function pinnedGuideBytes(root, relativePath, maxBytes) {
  if (![SCENE_CUT_GEOMETRY_ANCHOR.guidePath,
    SCENE_CUT_GEOMETRY_ANCHOR.guideProvenancePath].includes(relativePath)) {
    fail('geometry guide path is not the pinned local artifact')
  }
  const handle = await open(path.join(root, relativePath), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 64 || stat.size > maxBytes) {
      fail('geometry guide artifact missing or oversized')
    }
    return await handle.readFile()
  } finally { await handle.close() }
}

/** A persisted provider image must attest to the exact ordered references. */
export function verifySceneCutRepairImageLedger(input) {
  const ledger = object(input?.ledger), receipt = object(input?.receipt)
  const candidateBytes = input?.candidateBytes
  const candidateSha256 = Buffer.isBuffer(candidateBytes) ? hashBytes(candidateBytes) : ''
  const receiptSha256 = hashJson(receipt)
  const expectedReferences = Array.isArray(input?.referenceOrder)
    ? input.referenceOrder.map(item => ({ index: item.position, bytes: item.bytes,
      sha256: item.sha256 ?? item.jpegSha256 })) : []
  const expectedCount = receipt.version === 'scene-cut-rejected-image-edit-reference-v2' ? 4
    : receipt.version === 'scene-cut-rejected-image-edit-reference-v1' ? 3 : 0
  const guide = object(receipt.referenceOrder?.[3])
  const guideAnchor = input?.guideAnchor ?? SCENE_CUT_GEOMETRY_ANCHOR
  if (expectedReferences.length !== expectedCount
    || expectedCount === 4 && (guide.position !== 4 || guide.role !== 'geometry-guide'
      || guide.purpose !== 'geometry-only' || guide.referenceOnly !== true
      || guide.sourcePath !== guideAnchor.guidePath
      || guide.sourceSha256 !== guideAnchor.guideSha256
      || guide.jpegSha256 !== guideAnchor.guideJpegSha256)
    || expectedReferences.some((item, index) =>
    item.index !== index + 1 || !Number.isSafeInteger(item.bytes) || item.bytes < 1
      || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ''))
    || !Buffer.isBuffer(candidateBytes)
    || !/^\/generated\/image-[a-f0-9]{32}\.png$/.test(input?.candidateUrl ?? '')
    || !/^model-run-[\w-]+$/.test(input?.imageExecutionId ?? '')
    || !/^[a-f0-9]{64}$/.test(input?.requestFingerprint ?? '')
    || ledger.id !== input.imageExecutionId || ledger.channel !== 'workflow'
    || ledger.workflow_id !== WORKFLOW_ID || ledger.node_id !== IMAGE_NODE
    || ledger.capability !== 'image' || ledger.provider !== 'Codex'
    || ledger.status !== 'succeeded' || ledger.model_id !== input.modelId
    || ledger.request_data?.requestKey !== input.requestKey
    || ledger.request_data?.fingerprint !== input.requestFingerprint
    || ledger.request_data?.sceneCutRepairReceiptSha256 !== receiptSha256
    || ledger.request_data?.prompt !== input.prompt
    || !same(ledger.request_data?.params?.sceneCutRepairReceipt, receipt)
    || !same(ledger.response_data?.raw?.references, expectedReferences)
    || ledger.response_data?.raw?.image?.sha256 !== candidateSha256
    || ledger.response_data?.raw?.image?.bytes !== candidateBytes.length
    || ledger.response_data?.data?.[0]?.url !== input.candidateUrl
    || input.candidateUrl !== `/generated/image-${candidateSha256.slice(0, 32)}.png`) {
    fail('completed image ledger or generated PNG differs from the three-reference request')
  }
  return { modelExecutionId: input.imageExecutionId,
    requestFingerprint: input.requestFingerprint, repairReceiptSha256: receiptSha256,
    candidateSha256, referenceSha256s: expectedReferences.map(item => item.sha256) }
}

/** Read-only DB/FS loader. The caller must run it before fingerprint/ledger. */
export async function bindSceneCutRejectedEditReference(queryable, request, root = process.cwd()) {
  if (request?.executionContext?.workflowId !== WORKFLOW_ID
    || request.executionContext.nodeId !== IMAGE_NODE
    || request?.model?.capability !== 'image') return { request, applied: false, ledgerIdentity: null }
  // This repair receipt belongs to the first scene of a historical fork.
  // Later loop images use the ordinary scene-cut paid-image gate below.
  const key = request.executionContext.requestKey
  const laterScene = typeof key === 'string' ? key.match(
    /^record-[A-Za-z0-9_-]+:attempt-[1-9]\d*:revision-(?:0|[1-9]\d*):sanguo-scene-cut-first-frame:([1-9]\d*):scene-(\d+)$/) : null
  if (laterScene && Number(laterScene[2]) === Number(laterScene[1]) + 1
    && request.params?.sceneCutShot?.id === `scene-${laterScene[2].padStart(2, '0')}`) {
    return { request, applied: false, ledgerIdentity: null }
  }
  const identity = parseSceneCutRepairImageRequestKey(request.executionContext.requestKey)
  const currentRow = (await queryable.query(`select id,workflow_id,result,md5(result::text) as result_md5
    from execution_records where id=$1`, [identity.executionId])).rows[0]
  if (!currentRow) fail('requestKey execution record is missing')
  const current = decodeExecutionState(currentRow.result)
  if (!current.sceneCutImageRepairRecovery) {
    // Existing image runs have their own managed two-board gate. Only a fork
    // carrying the explicit repair marker enters the three-reference path.
    return { request, applied: false, ledgerIdentity: null }
  }
  const recovery = current.sceneCutImageRepairRecovery
  const geometry = recovery.version === 'scene-cut-image-repair-schema178-fork-v2'
  if (!geometry && recovery.version !== 'scene-cut-image-repair-schema177-fork-v1') {
    fail('unsupported repair fork version')
  }
  const anchor = geometry ? SCENE_CUT_GEOMETRY_ANCHOR : SCENE_CUT_REPAIR_ANCHOR
  const parentRow = (await queryable.query(`select id,workflow_id,result,md5(result::text) as result_md5
    from execution_records where id=$1`, [recovery.sourceExecutionId])).rows[0]
  const lineageRow = (await queryable.query(`select id,workflow_id,md5(result::text) as result_md5
    from execution_records where id=$1`, [anchor.parentId])).rows[0]
  const originalRow = (await queryable.query(`select id,workflow_id,md5(result::text) as result_md5
    from execution_records where id=$1`, [anchor.originalId])).rows[0]
  const workflowRow = (await queryable.query(`select id,schema_version,nodes,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id=$1`, [WORKFLOW_ID])).rows[0]
  if (!parentRow || !lineageRow || !originalRow || !workflowRow) {
    fail('repair parent, lineage, original or workflow missing')
  }
  const parent = decodeExecutionState(parentRow.result)
  const archive = object(parent.nodeRuns?.[41]?.output)
  const imageUrl = parent.nodeRuns?.[45]?.output?.url
  const sourcePngBytes = await generatedBytes(imageUrl, root)
  const identityBoardBytes = []
  for (const binding of archive.referenceBindings ?? []) {
    identityBoardBytes.push(await generatedBytes(binding.frontUrl, root))
  }
  const guidePngBytes = geometry ? await pinnedGuideBytes(root, anchor.guidePath, 20 * 1024 * 1024) : undefined
  const guideProvenanceBytes = geometry
    ? await pinnedGuideBytes(root, anchor.guideProvenancePath, 1024 * 1024) : undefined
  const imageKey = expectedParentKey(anchor.sourceId, IMAGE_NODE, parent.nodeRuns?.[45])
  const reviewKey = expectedParentKey(anchor.sourceId,
    'sanguo-scene-cut-review', parent.nodeRuns?.[49])
  const parentImageLedgerRows = (await queryable.query(`select id,channel,workflow_id,node_id,
    model_id,capability,provider,status,request_data,response_data
    from model_execution_records where workflow_id=$1 and node_id=$2
      and request_data->>'requestKey'=$3 and status='succeeded'
    order by created_at desc limit 10`, [WORKFLOW_ID, IMAGE_NODE, imageKey])).rows
  const parentReviewLedgerRows = (await queryable.query(`select id,channel,workflow_id,node_id,
    model_id,capability,provider,status,request_data,response_data
    from model_execution_records where workflow_id=$1 and node_id=$2
      and request_data->>'requestKey'=$3 and status='succeeded'
    order by created_at desc limit 10`, [WORKFLOW_ID, 'sanguo-scene-cut-review', reviewKey])).rows
  const proof = { currentRow, parentRow, lineageRow, originalRow, workflowRow,
    sourcePngBytes, identityBoardBytes, guidePngBytes, guideProvenanceBytes,
    parentImageLedgerRows, parentReviewLedgerRows }
  const bound = geometry ? await prepareSceneCutGeometryBoundRequest(request, proof)
    : await prepareSceneCutRejectedEditBoundRequest(request, proof)
  const after = (await queryable.query(`select md5(result::text) as result_md5
    from execution_records where id=$1`, [identity.executionId])).rows[0]
  if (after?.result_md5 !== currentRow.result_md5) fail('running repair checkpoint changed during binding')
  return bound
}

/**
 * Read-only verification after the new image run has completed. The rejected
 * parent image remains a reference only; this result never approves the new
 * candidate or substitutes for its independent review.
 */
export async function verifySceneCutRepairReceiptForCompletedFork(queryable, input,
  root = process.cwd(), options = {}) {
  const anchor = options.anchor ?? SCENE_CUT_REPAIR_ANCHOR
  const readGeneratedBytes = options.readGeneratedBytes ?? generatedBytes
  const executionId = input?.executionId, receipt = object(input?.receipt)
  const candidateUrl = input?.candidateUrl, imageExecutionId = input?.imageExecutionId
  const requestFingerprint = input?.repairRequestFingerprint
  if (!/^record-[A-Za-z0-9_-]+$/.test(executionId ?? '')
    || !/^model-run-[\w-]+$/.test(imageExecutionId ?? '')
    || !/^[a-f0-9]{64}$/.test(requestFingerprint ?? '')
    || !/^\/generated\/image-[a-f0-9]{32}\.png$/.test(candidateUrl ?? '')) {
    fail('completed repair identity is incomplete')
  }
  const currentRow = (await queryable.query(`select id,workflow_id,result,md5(result::text) as result_md5
    from execution_records where id=$1`, [executionId])).rows[0]
  const current = decodeExecutionState(currentRow?.result ?? {})
  if (current.sceneCutImageRepairRecovery?.version === 'scene-cut-image-repair-schema178-fork-v2') {
    return verifySceneCutGeometryReceiptForCompletedFork(queryable, input, root,
      options, currentRow, current)
  }
  const recovery = object(current.sceneCutImageRepairRecovery)
  const run = current.nodeRuns?.[45]
  if (currentRow?.workflow_id !== WORKFLOW_ID || current.id !== executionId
    || current.parentExecutionId !== anchor.sourceId
    || recovery.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || recovery.sourceExecutionId !== anchor.sourceId
    || recovery.sourceResultMd5 !== anchor.sourceMd5
    || recovery.parentExecutionId !== anchor.parentId
    || recovery.parentResultMd5 !== anchor.parentMd5
    || recovery.originalExecutionId !== anchor.originalId
    || recovery.originalResultMd5 !== anchor.originalMd5
    || recovery.workflowSchemaVersion !== 177 || recovery.preservedPrefixLength !== 45
    || recovery.firstPendingNodeId !== IMAGE_NODE
    || recovery.failedImageFileSha256 !== anchor.sourceImageSha256
    || recovery.failedReviewOutputSha256 !== anchor.sourceReviewSha256
    || run?.node?.id !== IMAGE_NODE || run.loopIndex !== 0 || run.status !== 'success'
    || run.output?.url !== candidateUrl
    || typeof run.output?.model !== 'string' || !run.output.model
    || typeof run.output?.prompt !== 'string' || !run.output.prompt
    || !same(run.output?.params?.referenceImages, run.inputs?.referenceImages)
    || !same(run.output?.params?.sceneCutShot, run.inputs?.sceneCutShot)
    || !same(run.output?.params?.sceneCutSources, run.inputs?.sceneCutSources)
    || !same(run.output?.params?.sceneCutOpeningPlan, run.inputs?.sceneCutOpeningPlan)) {
    fail('completed image does not belong to the pinned repair fork')
  }
  const parentRow = (await queryable.query(`select id,workflow_id,result,md5(result::text) as result_md5
    from execution_records where id=$1`, [anchor.sourceId])).rows[0]
  const lineageRow = (await queryable.query(`select id,workflow_id,md5(result::text) as result_md5
    from execution_records where id=$1`, [anchor.parentId])).rows[0]
  const originalRow = (await queryable.query(`select id,workflow_id,md5(result::text) as result_md5
    from execution_records where id=$1`, [anchor.originalId])).rows[0]
  const workflowRow = (await queryable.query(`select id,schema_version,nodes,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id=$1`, [WORKFLOW_ID])).rows[0]
  if (parentRow?.workflow_id !== WORKFLOW_ID
    || parentRow.result_md5 !== anchor.sourceMd5
    || lineageRow?.workflow_id !== WORKFLOW_ID
    || lineageRow.result_md5 !== anchor.parentMd5
    || originalRow?.workflow_id !== WORKFLOW_ID
    || originalRow.result_md5 !== anchor.originalMd5
    || workflowRow?.schema_version !== 177
    || workflowRow.nodes_md5 !== recovery.workflowNodesMd5
    || workflowRow.edges_md5 !== recovery.workflowEdgesMd5
    || !same(run.node, workflowRow.nodes?.find(node => node.id === IMAGE_NODE))) {
    fail('completed repair ancestry or managed graph changed')
  }
  const parent = decodeExecutionState(parentRow.result)
  if (parent.id !== anchor.sourceId
    || current.nodeRuns?.length !== parent.nodeRuns?.length
    || !same(current.nodeRuns.slice(0, 45).map(item => item.id),
      parent.nodeRuns.slice(0, 45).map(item => item.id))
    || !same(current.nodeRuns.slice(0, 45).map(item => item.output ?? null),
      parent.nodeRuns.slice(0, 45).map(item => item.output ?? null))
    || recovery.preservedPrefixOutputsHash !== structuralHash(parent.nodeRuns.slice(0, 45)
      .map(item => item.output ?? null))) {
    fail('completed repair changed preserved prefix')
  }
  const bindings = parent.nodeRuns[41]?.output?.referenceBindings
  if (!Array.isArray(bindings) || bindings.length !== 2) fail('frozen v4 identity boards missing')
  const prepared = await prepareRejectedSceneCutEditReference({ source: parent,
    sourceResultMd5: parentRow.result_md5,
    expectedSourceId: anchor.sourceId,
    expectedSourceMd5: anchor.sourceMd5,
    expectedImageSha256: anchor.sourceImageSha256,
    expectedReviewSha256: anchor.sourceReviewSha256,
    sourcePngBytes: await readGeneratedBytes(parent.nodeRuns[45]?.output?.url, root),
    identityBoardBytes: await Promise.all(bindings.map(item => readGeneratedBytes(item.frontUrl, root))) })
  const parentImageKey = expectedParentKey(anchor.sourceId, IMAGE_NODE,
    parent.nodeRuns[45])
  const parentReviewKey = expectedParentKey(anchor.sourceId,
    'sanguo-scene-cut-review', parent.nodeRuns[49])
  const parentImageRows = (await queryable.query(`select id,channel,workflow_id,node_id,
    model_id,capability,provider,status,request_data,response_data
    from model_execution_records where workflow_id=$1 and node_id=$2
      and request_data->>'requestKey'=$3 and status='succeeded'
    order by created_at desc limit 10`, [WORKFLOW_ID, IMAGE_NODE, parentImageKey])).rows
  const parentReviewRows = (await queryable.query(`select id,channel,workflow_id,node_id,
    model_id,capability,provider,status,request_data,response_data
    from model_execution_records where workflow_id=$1 and node_id=$2
      and request_data->>'requestKey'=$3 and status='succeeded'
    order by created_at desc limit 10`, [WORKFLOW_ID, 'sanguo-scene-cut-review', parentReviewKey])).rows
  const imageLedger = imageLedgerIdentity(parentImageRows, parentImageKey, prepared.receipt)
  const reviewLedger = reviewLedgerIdentity(parentReviewRows, parentReviewKey,
    parent.nodeRuns[49].output)
  const expectedReceipt = { ...prepared.receipt,
    preparationSha256: prepared.receiptSha256,
    sourceImageModelExecutionId: imageLedger.id,
    failedReviewModelExecutionId: reviewLedger.id,
    sourceImageModelFingerprint: imageLedger.request_data.fingerprint,
    failedReviewModelFingerprint: reviewLedger.request_data.fingerprint }
  if (prepared.receiptSha256 !== recovery.repairPreparationSha256
    || !same(recovery.receipt, prepared.receipt)
    || !same(receipt, expectedReceipt)
    || !same(prepared.referenceImages.slice(0, 2), run.output.params.referenceImages)
    || !same(prepared.receipt.referenceOrder.slice(0, 2).map(item => item.sha256),
      anchor.boardSha256s)) {
    fail('completed repair receipt differs from frozen source bytes or parent ledgers')
  }
  const requestKey = expectedParentKey(executionId, IMAGE_NODE, run)
  const ledger = (await queryable.query(`select id,channel,workflow_id,node_id,
    model_id,capability,provider,status,request_data,response_data
    from model_execution_records where id=$1`, [imageExecutionId])).rows[0]
  const candidateBytes = await readGeneratedBytes(candidateUrl, root)
  const proof = verifySceneCutRepairImageLedger({ ledger, receipt, candidateBytes,
    candidateUrl, imageExecutionId, requestFingerprint, requestKey,
    referenceOrder: prepared.receipt.referenceOrder,
    modelId: run.output.model, prompt: run.output.prompt })
  const after = (await queryable.query(`select md5(result::text) as result_md5
    from execution_records where id=$1`, [executionId])).rows[0]
  if (after?.result_md5 !== currentRow.result_md5) fail('completed repair changed during verification')
  return proof
}

async function verifySceneCutGeometryReceiptForCompletedFork(queryable, input, root,
  options, currentRow, current) {
  const anchor = options.geometryAnchor ?? SCENE_CUT_GEOMETRY_ANCHOR
  const readGenerated = options.readGeneratedBytes ?? generatedBytes
  const readGuide = options.readPinnedGuideBytes ?? pinnedGuideBytes
  const run = current.nodeRuns?.[45], recovery = object(current.sceneCutImageRepairRecovery)
  if (currentRow?.workflow_id !== WORKFLOW_ID || current.id !== input.executionId
    || run?.node?.id !== IMAGE_NODE || run.status !== 'success'
    || run.output?.url !== input.candidateUrl
    || typeof run.output?.model !== 'string' || !run.output.model
    || typeof run.output?.prompt !== 'string' || !run.output.prompt
    || !same(run.output?.params?.referenceImages, run.inputs?.referenceImages)
    || !same(run.output?.params?.sceneCutShot, run.inputs?.sceneCutShot)
    || !same(run.output?.params?.sceneCutSources, run.inputs?.sceneCutSources)
    || !same(run.output?.params?.sceneCutOpeningPlan, run.inputs?.sceneCutOpeningPlan)) {
    fail('completed four-reference image does not match its saved run')
  }
  const sourceRow = (await queryable.query(`select id,workflow_id,result,md5(result::text) as result_md5
    from execution_records where id=$1`, [anchor.sourceId])).rows[0]
  const lineageRow = (await queryable.query(`select id,workflow_id,md5(result::text) as result_md5
    from execution_records where id=$1`, [anchor.parentId])).rows[0]
  const originalRow = (await queryable.query(`select id,workflow_id,md5(result::text) as result_md5
    from execution_records where id=$1`, [anchor.originalId])).rows[0]
  const workflowRow = (await queryable.query(`select id,schema_version,nodes,
    md5(nodes::text) as nodes_md5,md5(edges::text) as edges_md5
    from workflow_configs where id=$1`, [WORKFLOW_ID])).rows[0]
  const source = decodeExecutionState(sourceRow?.result ?? {})
  const bindings = source.nodeRuns?.[41]?.output?.referenceBindings
  if (!Array.isArray(bindings) || bindings.length !== 2) fail('four-reference source boards missing')
  const sourcePngBytes = await readGenerated(source.nodeRuns?.[45]?.output?.url, root)
  const identityBoardBytes = await Promise.all(bindings.map(item => readGenerated(item.frontUrl, root)))
  const guidePngBytes = await readGuide(root, anchor.guidePath, 20 * 1024 * 1024)
  const guideProvenanceBytes = await readGuide(root, anchor.guideProvenancePath, 1024 * 1024)
  const imageKey = expectedParentKey(anchor.sourceId, IMAGE_NODE, source.nodeRuns?.[45])
  const reviewKey = expectedParentKey(anchor.sourceId,
    'sanguo-scene-cut-review', source.nodeRuns?.[49])
  const parentImageLedgerRows = (await queryable.query(`select id,channel,workflow_id,node_id,
    model_id,capability,provider,status,request_data,response_data
    from model_execution_records where workflow_id=$1 and node_id=$2
      and request_data->>'requestKey'=$3 and status='succeeded'
    order by created_at desc limit 10`, [WORKFLOW_ID, IMAGE_NODE, imageKey])).rows
  const parentReviewLedgerRows = (await queryable.query(`select id,channel,workflow_id,node_id,
    model_id,capability,provider,status,request_data,response_data
    from model_execution_records where workflow_id=$1 and node_id=$2
      and request_data->>'requestKey'=$3 and status='succeeded'
    order by created_at desc limit 10`, [WORKFLOW_ID, 'sanguo-scene-cut-review', reviewKey])).rows
  const request = { model: { id: run.output.model, provider: 'Codex',
    capability: 'image', settings: {} }, prompt: run.output.prompt,
  params: run.output.params,
  executionContext: { workflowId: WORKFLOW_ID, nodeId: IMAGE_NODE,
    requestKey: expectedParentKey(current.id, IMAGE_NODE, run) } }
  const bound = await prepareSceneCutGeometryBoundRequest(request, { currentRow,
    parentRow: sourceRow, lineageRow, originalRow, workflowRow,
    sourcePngBytes, identityBoardBytes, guidePngBytes, guideProvenanceBytes,
    parentImageLedgerRows, parentReviewLedgerRows }, { anchor, phase: 'completed' })
  const receipt = object(input.receipt)
  if (!same(receipt, bound.request.params.sceneCutRepairReceipt)
    || recovery.repairPreparationSha256 !== receipt.preparationSha256
    || receipt.guideProvenanceSha256 !== anchor.guideProvenanceSha256) {
    fail('completed four-reference receipt differs from recomputed source proof')
  }
  const ledger = (await queryable.query(`select id,channel,workflow_id,node_id,
    model_id,capability,provider,status,request_data,response_data
    from model_execution_records where id=$1`, [input.imageExecutionId])).rows[0]
  const candidateBytes = await readGenerated(input.candidateUrl, root)
  const verified = verifySceneCutRepairImageLedger({ ledger, receipt,
    candidateBytes, candidateUrl: input.candidateUrl,
    imageExecutionId: input.imageExecutionId,
    requestFingerprint: input.repairRequestFingerprint,
    requestKey: request.executionContext.requestKey,
    referenceOrder: receipt.referenceOrder, modelId: run.output.model,
    prompt: run.output.prompt, guideAnchor: anchor })
  const after = (await queryable.query(`select md5(result::text) as result_md5
    from execution_records where id=$1`, [current.id])).rows[0]
  if (after?.result_md5 !== currentRow.result_md5) fail('completed four-reference fork changed during verification')
  return verified
}
