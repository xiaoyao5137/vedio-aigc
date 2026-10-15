#!/usr/bin/env node
// Once the original first shot has passed on real media, copy the exact saved
// second-shot candidate into a NEW record and rerun its review and acceptance.
// Dry-run by default. No model or provider call occurs in this script.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { applyNodeOutputToContext } from '../src/workflow-core.ts'
import { sceneFromStoryboardSegment, storyboardContinuityContext } from '../src/storyboard-runtime.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { assertSceneCutApprovalRebindHop, sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { assertSceneCutTailGuideRebindHop } from '../server/scene-cut-tail-guide-rebind.ts'
import { assertSourceBoundCompositeHop } from '../server/scene-cut-source-bound-composite.mjs'
import { verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const SUPPORTED_SCHEMAS = new Set([171, 172, 173, 174, 175, 176, 177, 178, 179, 180])
const V6_ID = 'record-4x5m31-original-repair-v6'
const V6_MD5 = '21f1f7a2131fe7c3d0e97998d16245a3'
const V5_ID = 'record-4x5m31-original-repair-v5'
const V5_MD5 = 'b5ac0f516ad8a44ca175e506aaccc67d'
const V6_REJECTED_IMAGE_SHA = '2592c8f00f59d4511c85bdf9bf13fc67f539eb49ea4f91ee7780704626df5f73'
const V6_REJECTED_REVIEW_SHA = 'd4a00dbe88ea9a5dabd6cfea6be4e8a2633a3da30f162440a908ddcddf6ee7dc'
const SCHEMA177_NODES_MD5 = '66403a851ef7b3abba0dfa836d6727c1'
const SCHEMA177_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const V7_ID = 'record-4x5m31-original-repair-v7'
const V7_REJECTED_MD5 = '0c2421f0e2e33a563f73c44dea53d44f'
const V7_REJECTED_IMAGE_SHA = '4218a56c75d532f7cf629176d73b7138c05e28be656c9ff5831568dc6828fb48'
const V7_REJECTED_REVIEW_SHA = 'faad209cbc612d5eb67e2d32f2a668e0a15dc76fdb3cfa94bb4d4784902f2da2'
const V8_ID = 'record-4x5m31-original-repair-v8'
const GUIDE_PATH = 'qa/record-4x5m31/geometry-guide-v8-0d23d49f.png'
const GUIDE_SHA = '0d23d49f076dc1ce1e52a6de81f049d588499be720037755c73e3f8f9f0726b2'
const GUIDE_PROVENANCE_PATH = 'qa/record-4x5m31/geometry-guide-v8-provenance.json'
const GUIDE_PROVENANCE_SHA = '4005ced1b6d381d8c474ec2e606186394509ec9a728c70f23009f3684cf84e2d'
const SCHEMA178_NODES_MD5 = '2e68e68dea063bdb645523ef8a64ad6d'
const SCHEMA178_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const SCHEMA179_NODES_MD5 = 'db1556fa6605e179a7a37e52cbbe8135'
const SCHEMA179_OLD_ACCEPT_CODE_SHA = '6a0ddcb21226490871f5ffc269a068889fadf18b6977cc2438f1e523cb6ac446'
const SCHEMA179_NEW_ACCEPT_CODE_SHA = '1877b7dc6817ca4daa98b0215f7d9e1eb453e19c0cca27dcd043bf196c4e8b5e'
const SCHEMA180_NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const SCHEMA180_ACCEPT_CODE_SHA = 'a0d740dd68f97f55dc03dff4e6b2f5911d5a478928f0d62dd6db97012a30fbcb'
const OUTLINE_SHA = '74f1456f01fdf39d58a391e069c5e7b8f289b87ae4554c86b23acc330f13c712'
const SCENE2_SHA = '86a2b90b3c4c6f8745eaeec9563e44b3158e03a4100cf758df13e8305892ad44'
const SHOT1_SHA = 'c9950ad09fb699a078d32337c81e6b632a814b71e9d8ecf140e94d4dc0cb4552'
const CANDIDATE_SHA = '6dbe6da0108dfcc1a22f74ef5556306dbc8382b185ba1d853340d7c10beb8cad'
const ACCEPTED_SHA = 'a0bd06afdcf6f8019f36c0a5d44b9209d27ec97673550090d72faea1ff31a8e3'
const ACCEPTANCE_FIELDS = new Set(['issues', 'passed', 'executionLogs', 'qualityPolicy', 'qualityReview',
  'repairContext', 'qualityDisposition', 'manualDecisionRequired'])
const fail = message => { throw Error(`ORIGINAL_SECOND_SHOT_REPLAY_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex')
const sha256Text = value => createHash('sha256').update(value).digest('hex')
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const ordered = (value, fields) => Object.fromEntries(fields.map(field => [field, value?.[field]]))
/** JSONB reorders object keys; rebuild the original receipt field order before
 * comparing its byte-oriented preparation SHA. Deep equality rejects extras. */
export function storedSceneCutRepairReceiptSha256(receipt) {
  const v1 = receipt?.version === 'scene-cut-rejected-image-edit-reference-v1'
  const v2 = receipt?.version === 'scene-cut-rejected-image-edit-reference-v2'
  if (!v1 && !v2 || !Array.isArray(receipt.referenceOrder)
    || receipt.referenceOrder.length !== (v1 ? 3 : 4)) return undefined
  const references = receipt.referenceOrder.map((entry, index) => ordered(entry,
    index < 2 ? ['position', 'characterName', 'frontUrl', 'sha256', 'bytes']
      : index === 2 ? ['position', 'role', 'sourceUrl', 'sourceSha256', 'jpegSha256', 'bytes']
        : ['position', 'role', 'purpose', 'referenceOnly', 'sourcePath', 'sourceSha256', 'jpegSha256', 'bytes']))
  const baseFields = ['version', 'role', 'sourceVerdict', 'approvedFirstFrame',
    'requiresFreshIndependentReview', 'requiresPaidGateRevalidation',
    'sourceExecutionId', 'sourceResultMd5', 'sourceImageRunId', 'sourceImageUrl',
    'sourceImageSha256', 'failedReviewRunId', 'failedReviewOutputSha256',
    'failedReviewEvidenceUrl', 'approvedShotSha256', 'sourceArchiveSha256',
    'openingPlanSha256']
  const normalized = ordered(receipt, baseFields)
  if (v2) {
    normalized.priorRepairPreparationSha256 = receipt.priorRepairPreparationSha256
    normalized.priorRepairMarkerHash = receipt.priorRepairMarkerHash
    normalized.geometryGuide = ordered(receipt.geometryGuide,
      ['role', 'identityAuthority', 'sourcePath', 'sourceSha256'])
  }
  normalized.referenceOrder = references
  normalized.conversion = v1
    ? ordered(receipt.conversion, ['version', 'quality', 'chromaSubsampling', 'width', 'height'])
    : { ...ordered(receipt.conversion, ['version', 'quality', 'chromaSubsampling']),
      rejectedDimensions: ordered(receipt.conversion?.rejectedDimensions, ['width', 'height']),
      guideDimensions: ordered(receipt.conversion?.guideDimensions, ['width', 'height']) }
  normalized.totalReferenceBytes = receipt.totalReferenceBytes
  return isDeepStrictEqual(receipt, normalized) ? sha256(normalized) : undefined
}
const outputFor = (runs, nodeId, loopIndex) => runs.find(run =>
  run.node?.id === nodeId && (loopIndex === undefined || run.loopIndex === loopIndex))?.output
const FIRST_SHOT_SUFFIX_IDS = [
  'sanguo-scene-cut-first-frame', 'sanguo-map-end-accept',
  'sanguo-scene-cut-evidence-plan', 'sanguo-scene-cut-evidence',
  'sanguo-scene-cut-review', 'sanguo-scene-cut-approval',
  'sanguo-video-reference-router', 'sanguo-video', 'sanguo-media-request',
  'sanguo-video-evidence', 'sanguo-media-metrics', 'sanguo-media-observe',
  'sanguo-requirement-review', 'sanguo-media-review', 'sanguo-media-accept',
  'sanguo-duration-replan', 'sanguo-media-accept-error-branch',
  'sanguo-media-accept-accept-branch', 'sanguo-video-concat', 'sanguo-last-frame',
]

/** Static route admission before payment, or completed route at replay time. */
export function assertOriginalSecondShotArrivalRoute(runs, completed = false) {
  if (!Array.isArray(runs) || runs.length !== 464
    || !same(runs.slice(45, 65).map(run => run.node?.id), FIRST_SHOT_SUFFIX_IDS)
    || runs[65]?.node?.id !== 'sanguo-shot-script' || runs[65]?.loopIndex !== 1
    || runs[66]?.node?.id !== 'sanguo-shot-script-review' || runs[66]?.loopIndex !== 1
    || runs[67]?.node?.id !== 'sanguo-shot-script-accept' || runs[67]?.loopIndex !== 1
    || runs.slice(0, 45).some(run => !['success', 'skipped'].includes(run.status))
    || runs.slice(45, 65).some(run => completed
      ? !['success', 'skipped'].includes(run.status) : run.status !== 'idle')
    || runs.slice(65).some(run => run.status !== 'idle')) {
    fail('first-shot route does not reach the original scene-02 script at index65')
  }
  return { firstImageIndex: 45, firstLastFrameIndex: 64,
    secondScriptIndex: 65, secondReviewIndex: 66, secondAcceptIndex: 67,
    firstShotCompleted: completed }
}

/** Schema177 must preserve the v6 rejected image as an edit reference only. */
export function assertSchema177ImageRepairLineage(state, workflow, { replayed = false } = {}) {
  const marker = state?.sceneCutImageRepairRecovery
  const current = replayed ? state?.originalShot1ImageV7RetryRecovery
    : state?.sceneCutFirstFrameRecovery
  const receipt = marker?.receipt
  const refs = receipt?.referenceOrder
  const runs = state?.nodeRuns
  const archive = runs?.[41]?.output
  const shot = runs?.[44]?.context?.shot_script
  const plan = runs?.[43]?.output
  const hash = createJsonHasher()
  if (workflow?.schema_version !== 177
    || workflow.nodes_md5 !== SCHEMA177_NODES_MD5
    || workflow.edges_md5 !== SCHEMA177_EDGES_MD5
    || (!replayed && state.parentExecutionId !== V6_ID)
    || (replayed && (state.secondShotReplayRecovery?.version
      !== 'original-second-shot-candidate-replay-schema177-fork-v1'
      || !isDeepStrictEqual(state.sceneCutFirstFrameRecovery, state.secondShotReplayRecovery)))
    || marker?.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || marker.sourceExecutionId !== V6_ID || marker.sourceResultMd5 !== V6_MD5
    || marker.parentExecutionId !== V5_ID || marker.parentResultMd5 !== V5_MD5
    || marker.originalExecutionId !== ORIGINAL_ID || marker.originalResultMd5 !== ORIGINAL_MD5
    || marker.workflowSchemaVersion !== 177
    || marker.workflowNodesMd5 !== workflow.nodes_md5 || marker.workflowEdgesMd5 !== workflow.edges_md5
    || marker.preservedPrefixLength !== 45 || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || marker.failedImageFileSha256 !== V6_REJECTED_IMAGE_SHA
    || marker.failedReviewOutputSha256 !== V6_REJECTED_REVIEW_SHA
    || !Array.isArray(runs) || runs.length !== 464
    || marker.preservedPrefixOutputsHash !== hash(runs.slice(0, 45).map(run => run.output ?? null))
    || receipt?.version !== 'scene-cut-rejected-image-edit-reference-v1'
    || receipt.sourceExecutionId !== V6_ID || receipt.sourceResultMd5 !== V6_MD5
    || receipt.sourceVerdict !== 'rejected' || receipt.role !== 'reference-only'
    || receipt.approvedFirstFrame !== false || receipt.requiresFreshIndependentReview !== true
    || receipt.sourceImageSha256 !== V6_REJECTED_IMAGE_SHA
    || receipt.failedReviewOutputSha256 !== V6_REJECTED_REVIEW_SHA
    || receipt.approvedShotSha256 !== sha256(shot)
    || receipt.sourceArchiveSha256 !== sha256(archive)
    || receipt.openingPlanSha256 !== sha256(plan)
    || !Array.isArray(refs) || refs.length !== 3
    || refs.some((ref, index) => ref.position !== index + 1)
    || refs[0].sha256 !== archive?.referenceBindings?.[0]?.frontSha256
    || refs[1].sha256 !== archive?.referenceBindings?.[1]?.frontSha256
    || refs[2].role !== 'rejected-edit-source'
    || refs[2].sourceSha256 !== V6_REJECTED_IMAGE_SHA
    || !/^[a-f0-9]{64}$/.test(refs[2].jpegSha256 ?? '')
    || marker.repairPreparationSha256 !== storedSceneCutRepairReceiptSha256(receipt)
    || current?.version !== 'original-shot1-image-retry-schema177-fork-v1'
    || current.sourceExecutionId !== V6_ID || current.sourceResultMd5 !== V6_MD5
    || current.workflowSchemaVersion !== 177
    || current.workflowNodesMd5 !== workflow.nodes_md5
    || current.workflowEdgesMd5 !== workflow.edges_md5
    || current.failedImageFileSha256 !== V6_REJECTED_IMAGE_SHA
    || current.failedReviewOutputSha256 !== V6_REJECTED_REVIEW_SHA
    || current.repairPreparationSha256 !== marker.repairPreparationSha256
    || current.preservedPrefixOutputsHash !== marker.preservedPrefixOutputsHash
    || (!replayed && !isDeepStrictEqual(state.originalShot1ImageV7RetryRecovery, current))) {
    fail('schema177 first-shot repair marker is not bound to the rejected v6 reference')
  }
  return { sourceExecutionId: V6_ID, sourceResultMd5: V6_MD5,
    repairPreparationSha256: marker.repairPreparationSha256,
    preservedPrefixOutputsHash: marker.preservedPrefixOutputsHash }
}

/** A schema178 scene-02 replay must inherit the rejected v7 edit, the frozen
 * identity boards, and the geometry-only guide without treating either as an
 * approved first frame. */
export function assertSchema178ImageRepairLineage(state, workflow,
  { replayed = false, replaySchema = 178 } = {}) {
  const marker = state?.sceneCutImageRepairRecovery
  const prior = state?.priorSceneCutImageRepairRecovery
  const current = replayed ? state?.originalShot1ImageV8RetryRecovery
    : state?.sceneCutFirstFrameRecovery
  const receipt = marker?.receipt
  const refs = receipt?.referenceOrder
  const runs = state?.nodeRuns
  const archive = runs?.[41]?.output
  const shot = runs?.[44]?.context?.shot_script
  const plan = runs?.[43]?.output
  const hash = createJsonHasher()
  if (workflow?.schema_version !== 178 || workflow.nodes_md5 !== SCHEMA178_NODES_MD5
    || workflow.edges_md5 !== SCHEMA178_EDGES_MD5
    || (!replayed && state.parentExecutionId !== V7_ID)
    || (replayed && (state.secondShotReplayRecovery?.version
      !== `original-second-shot-candidate-replay-schema${replaySchema}-fork-v1`
      || !isDeepStrictEqual(state.sceneCutFirstFrameRecovery, state.secondShotReplayRecovery)))
    || marker?.version !== 'scene-cut-image-repair-schema178-fork-v2'
    || marker.sourceExecutionId !== V7_ID || marker.sourceResultMd5 !== V7_REJECTED_MD5
    || marker.parentExecutionId !== V6_ID || marker.parentResultMd5 !== V6_MD5
    || marker.originalExecutionId !== ORIGINAL_ID || marker.originalResultMd5 !== ORIGINAL_MD5
    || marker.workflowSchemaVersion !== 178
    || marker.workflowNodesMd5 !== workflow.nodes_md5 || marker.workflowEdgesMd5 !== workflow.edges_md5
    || marker.preservedPrefixLength !== 45 || marker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || marker.failedImageFileSha256 !== V7_REJECTED_IMAGE_SHA
    || marker.failedReviewOutputSha256 !== V7_REJECTED_REVIEW_SHA
    || marker.geometryGuideSourcePath !== GUIDE_PATH || marker.geometryGuideSourceSha256 !== GUIDE_SHA
    || marker.geometryGuideProvenancePath !== GUIDE_PROVENANCE_PATH
    || marker.geometryGuideProvenanceSha256 !== GUIDE_PROVENANCE_SHA
    || !Array.isArray(runs) || runs.length !== 464
    || marker.preservedPrefixOutputsHash !== hash(runs.slice(0, 45).map(run => run.output ?? null))
    || prior?.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || marker.priorRepairPreparationSha256 !== prior.repairPreparationSha256
    || receipt?.version !== 'scene-cut-rejected-image-edit-reference-v2'
    || receipt.sourceExecutionId !== V7_ID || receipt.sourceResultMd5 !== V7_REJECTED_MD5
    || receipt.sourceVerdict !== 'rejected' || receipt.role !== 'reference-only'
    || receipt.approvedFirstFrame !== false || receipt.requiresFreshIndependentReview !== true
    || receipt.sourceImageSha256 !== V7_REJECTED_IMAGE_SHA
    || receipt.failedReviewOutputSha256 !== V7_REJECTED_REVIEW_SHA
    || receipt.approvedShotSha256 !== sha256(shot)
    || receipt.sourceArchiveSha256 !== sha256(archive)
    || receipt.openingPlanSha256 !== sha256(plan)
    || receipt.priorRepairPreparationSha256 !== prior.repairPreparationSha256
    || receipt.priorRepairMarkerHash !== hash(prior)
    || receipt.geometryGuide?.role !== 'geometry-only'
    || receipt.geometryGuide.identityAuthority !== false
    || receipt.geometryGuide.sourcePath !== GUIDE_PATH
    || receipt.geometryGuide.sourceSha256 !== GUIDE_SHA
    || !Array.isArray(refs) || refs.length !== 4
    || refs.some((ref, index) => ref.position !== index + 1)
    || refs[0].sha256 !== archive?.referenceBindings?.[0]?.frontSha256
    || refs[1].sha256 !== archive?.referenceBindings?.[1]?.frontSha256
    || refs[2].role !== 'rejected-edit-source'
    || refs[2].sourceSha256 !== V7_REJECTED_IMAGE_SHA
    || !/^[a-f0-9]{64}$/.test(refs[2].jpegSha256 ?? '')
    || refs[3].role !== 'geometry-guide' || refs[3].purpose !== 'geometry-only'
    || refs[3].referenceOnly !== true || refs[3].sourcePath !== GUIDE_PATH
    || refs[3].sourceSha256 !== GUIDE_SHA
    || marker.geometryGuideJpegSha256 !== refs[3].jpegSha256
    || !/^[a-f0-9]{64}$/.test(refs[3].jpegSha256 ?? '')
    || marker.repairPreparationSha256 !== storedSceneCutRepairReceiptSha256(receipt)
    || current?.version !== 'original-shot1-image-retry-schema178-fork-v1'
    || current.sourceExecutionId !== V7_ID || current.sourceResultMd5 !== V7_REJECTED_MD5
    || current.workflowSchemaVersion !== 178
    || current.workflowNodesMd5 !== workflow.nodes_md5 || current.workflowEdgesMd5 !== workflow.edges_md5
    || current.failedImageFileSha256 !== V7_REJECTED_IMAGE_SHA
    || current.failedReviewOutputSha256 !== V7_REJECTED_REVIEW_SHA
    || current.repairPreparationSha256 !== marker.repairPreparationSha256
    || current.priorRepairPreparationSha256 !== marker.priorRepairPreparationSha256
    || current.geometryGuideSourceSha256 !== GUIDE_SHA
    || current.geometryGuideJpegSha256 !== marker.geometryGuideJpegSha256
    || current.geometryGuideProvenanceSha256 !== GUIDE_PROVENANCE_SHA
    || current.preservedPrefixOutputsHash !== marker.preservedPrefixOutputsHash
    || (!replayed && !isDeepStrictEqual(state.originalShot1ImageV8RetryRecovery, current))) {
    fail('schema178 four-reference first-shot repair lineage changed')
  }
  assertSchema177ImageRepairLineage({ ...state, parentExecutionId: V6_ID,
    sceneCutFirstFrameRecovery: state.originalShot1ImageV7RetryRecovery,
    sceneCutImageRepairRecovery: prior }, {
    schema_version: 177, nodes_md5: SCHEMA177_NODES_MD5,
    edges_md5: SCHEMA177_EDGES_MD5 })
  return { sourceExecutionId: V7_ID, sourceResultMd5: V7_REJECTED_MD5,
    repairPreparationSha256: marker.repairPreparationSha256,
    preservedPrefixOutputsHash: marker.preservedPrefixOutputsHash }
}

/** The first approved frame can survive failed approval retries. Admit that
 * descendant only after proving every saved retry hop from the pinned v8
 * image: the reviewed media prefix is byte-identical, no failed hop bought
 * video, and the successful signature names the descendant and v8 review. */
export function assertSchema178ApprovalRetryLineage(source, workflow, chain) {
  if (!Array.isArray(chain) || chain.length < 1 || chain.length > 9
    || chain[0]?.id !== V8_ID || chain.at(-1)?.id !== source?.id
    || chain.at(-1)?.result_md5 !== source?.result_md5
    || !isDeepStrictEqual(chain.at(-1)?.result, source?.result)
    || new Set(chain.map(row => row.id)).size !== chain.length
    || chain.some(row => row.workflow_id !== 'wf-sanguo-history-drama'
      || !/^[a-f0-9]{32}$/.test(row.result_md5 ?? ''))) {
    fail('schema178 approval retry ancestry is missing, ambiguous or changed')
  }
  const base = decodeExecutionState(chain[0].result)
  if (base.id !== V8_ID || base.parentExecutionId !== V7_ID
    || base.generationScopeId !== V8_ID || !Array.isArray(base.nodeRuns)
    || base.nodeRuns[50]?.node?.id !== 'sanguo-scene-cut-approval') {
    fail('schema178 approval retry base is not the pinned v8 image')
  }
  const imageRepair = assertSchema178ImageRepairLineage(base, workflow)
  const baseApproval = base.nodeRuns[50]
  const lineage = [{ id: chain[0].id, resultMd5: chain[0].result_md5,
    approvalRevision: baseApproval.revision ?? 0, approvalStatus: baseApproval.status }]
  for (let index = 1; index < chain.length; index++) {
    const parent = decodeExecutionState(chain[index - 1].result)
    const child = decodeExecutionState(chain[index].result)
    const previous = parent.nodeRuns?.[50], next = child.nodeRuns?.[50]
    const last = index === chain.length - 1
    if (parent.id !== chain[index - 1].id || child.id !== chain[index].id
      || child.parentExecutionId !== parent.id || child.workflowId !== parent.workflowId
      || child.requestScopeId !== parent.requestScopeId
      || child.generationScopeId !== child.id
      || !isDeepStrictEqual(child.sceneCutFirstFrameRecovery, base.sceneCutFirstFrameRecovery)
      || !isDeepStrictEqual(child.originalShot1ImageV8RetryRecovery,
        base.originalShot1ImageV8RetryRecovery)
      || !isDeepStrictEqual(child.sceneCutImageRepairRecovery, base.sceneCutImageRepairRecovery)
      || !isDeepStrictEqual(child.priorSceneCutImageRepairRecovery,
        base.priorSceneCutImageRepairRecovery)
      || !isDeepStrictEqual(child.originalTwoShotRepairRecovery,
        base.originalTwoShotRepairRecovery)
      || child.nodeRuns?.length !== base.nodeRuns.length
      || !isDeepStrictEqual(child.nodeRuns.slice(0, 50), base.nodeRuns.slice(0, 50))
      || previous?.status !== 'failed' || next?.status !== (last ? 'success' : 'failed')
      || parent.nodeRuns.slice(51).some(run => run.status !== 'idle')
      || previous.id !== next.id || !isDeepStrictEqual(previous.node, next.node)
      || (next.attempt ?? 1) !== (previous.attempt ?? 1)
      || !Number.isSafeInteger(next.revision)
      || next.revision !== (previous.revision ?? 0) + 1) {
      fail(`schema178 approval retry hop ${index} changed reviewed media or revision`)
    }
    lineage.push({ id: chain[index].id, resultMd5: chain[index].result_md5,
      approvalRevision: next.revision, approvalStatus: next.status })
  }
  const final = decodeExecutionState(chain.at(-1).result)
  const approval = final.nodeRuns[50]?.output
  if (final.nodeRuns[50]?.status !== 'success'
    || approval?.passed !== true
    || approval.repairBinding?.version !== 'scene-cut-image-repair-binding-v2'
    || approval.repairBinding.executionId !== source.id
    || approval.repairBinding.reviewSourceExecutionId !== (chain.length === 1 ? undefined : V8_ID)
    || approval.repairBinding.receipt?.preparationSha256
      !== imageRepair.repairPreparationSha256
    || approval.repairBinding.candidateImageSha256 !== approval.sourceSha256s?.[0]) {
    fail('schema178 approval retry certificate is not bound to the descendant and v8 image')
  }
  return { ...imageRepair, approvalRetryLineage: lineage }
}

/** A schema179 evidence retry keeps the purchased video and its index0–57
 * proof. The only migrated snapshot field is media-accept.code; the older
 * schema178 image/approval chain remains the immutable source of authority. */
export function assertSchema179SameMediaRetryLineage(source, workflow, chain) {
  const mediaAccept = workflow?.nodes?.find(node => node.id === 'sanguo-media-accept')
  if (workflow?.schema_version !== 179 || workflow.nodes_md5 !== SCHEMA179_NODES_MD5
    || workflow.edges_md5 !== SCHEMA178_EDGES_MD5
    || workflow.nodes?.length !== 72 || workflow.edges?.length !== 87
    || typeof mediaAccept?.code !== 'string'
    || sha256Text(mediaAccept.code) !== SCHEMA179_NEW_ACCEPT_CODE_SHA
    || !Array.isArray(chain) || chain.length < 2 || chain.length > 9
    || chain[0]?.id !== V8_ID || chain.at(-1)?.id !== source?.id
    || chain.at(-1)?.result_md5 !== source?.result_md5
    || !isDeepStrictEqual(chain.at(-1)?.result, source?.result)) {
    fail('schema179 same-media retry is not on the pinned managed graph')
  }
  const states = chain.map(row => decodeExecutionState(row.result))
  const firstMediaHop = states.findIndex((state, index) => index > 0
    && states[index - 1].nodeRuns?.[50]?.status === 'success')
  if (firstMediaHop < 2 || firstMediaHop >= states.length) {
    fail('schema179 retry lacks a completed v8 approval ancestor')
  }
  const approvalProof = assertSchema178ApprovalRetryLineage(chain[firstMediaHop - 1],
    { schema_version: 178, nodes_md5: SCHEMA178_NODES_MD5,
      edges_md5: SCHEMA178_EDGES_MD5 }, chain.slice(0, firstMediaHop))
  const graphNodes = new Map(workflow.nodes.map(node => [node.id, node]))
  if (graphNodes.size !== workflow.nodes.length) fail('schema179 managed nodes are ambiguous')
  const mediaRetryLineage = []
  for (let index = firstMediaHop; index < states.length; index++) {
    const parent = states[index - 1], child = states[index]
    const previousAccept = parent.nodeRuns?.[59], nextAccept = child.nodeRuns?.[59]
    const oldCode = previousAccept?.node?.code, newCode = nextAccept?.node?.code
    if (chain[index].workflow_id !== 'wf-sanguo-history-drama'
      || !/^[a-f0-9]{32}$/.test(chain[index].result_md5 ?? '')
      || child.id !== chain[index].id || child.parentExecutionId !== parent.id
      || child.workflowId !== parent.workflowId || child.requestScopeId !== parent.requestScopeId
      || child.generationScopeId !== child.id
      || !isDeepStrictEqual(child.sceneCutFirstFrameRecovery,
        states[0].sceneCutFirstFrameRecovery)
      || !isDeepStrictEqual(child.originalShot1ImageV8RetryRecovery,
        states[0].originalShot1ImageV8RetryRecovery)
      || !isDeepStrictEqual(child.sceneCutImageRepairRecovery,
        states[0].sceneCutImageRepairRecovery)
      || !isDeepStrictEqual(child.priorSceneCutImageRepairRecovery,
        states[0].priorSceneCutImageRepairRecovery)
      || !isDeepStrictEqual(child.originalTwoShotRepairRecovery,
        states[0].originalTwoShotRepairRecovery)
      || child.nodeRuns?.length !== 464 || parent.nodeRuns?.length !== 464
      || !isDeepStrictEqual(child.nodeRuns.slice(0, 58), parent.nodeRuns.slice(0, 58))
      || parent.nodeRuns[50]?.status !== 'success'
      || parent.nodeRuns[61]?.status !== 'failed'
      || parent.nodeRuns[59]?.output?.passed !== false
      || previousAccept?.node?.id !== 'sanguo-media-accept'
      || nextAccept?.node?.id !== 'sanguo-media-accept'
      || typeof oldCode !== 'string' || typeof newCode !== 'string'
      || ![SCHEMA179_OLD_ACCEPT_CODE_SHA, SCHEMA179_NEW_ACCEPT_CODE_SHA]
        .includes(sha256Text(oldCode))
      || sha256Text(newCode) !== SCHEMA179_NEW_ACCEPT_CODE_SHA
      || !isDeepStrictEqual(previousAccept.node, { ...nextAccept.node, code: oldCode })
      || parent.nodeRuns.some((run, runIndex) => runIndex >= 58
        && (run.node?.id === 'sanguo-media-accept'
          ? typeof run.node.code !== 'string'
            || ![SCHEMA179_OLD_ACCEPT_CODE_SHA, SCHEMA179_NEW_ACCEPT_CODE_SHA]
              .includes(sha256Text(run.node.code))
            || !isDeepStrictEqual(run.node,
              { ...child.nodeRuns[runIndex]?.node, code: run.node.code })
          : !isDeepStrictEqual(run.node, child.nodeRuns[runIndex]?.node)))
      || child.nodeRuns.some(run => !isDeepStrictEqual(run.node,
        graphNodes.get(run.node?.id)))) {
      fail(`schema179 same-media retry hop ${index} changed paid prefix or managed gate`)
    }
    mediaRetryLineage.push({ id: chain[index].id, resultMd5: chain[index].result_md5,
      parentExecutionId: parent.id, preservedPrefixLength: 58,
      mediaAcceptCodeSha256: sha256Text(newCode) })
  }
  return { ...approvalProof, sameMediaRetryLineage: mediaRetryLineage }
}

/** Schema180 changed only media-accept.code. Paid video retakes carry their
 * own index50 certificate. The single permitted composite child preserves
 * its signed parent certificate and separately proves both paid segments,
 * the delivered media, and a fresh whole-shot acceptance. */
export function assertSchema180VideoRebindLineage(source, workflow, chain,
  failedReviewLedgers, root = process.cwd()) {
  const accept = workflow?.nodes?.find(node => node.id === 'sanguo-media-accept')
  if (workflow?.schema_version !== 180 || workflow.nodes_md5 !== SCHEMA180_NODES_MD5
    || workflow.edges_md5 !== SCHEMA178_EDGES_MD5
    || workflow.nodes?.length !== 72 || workflow.edges?.length !== 87
    || sha256Text(accept?.code ?? '') !== SCHEMA180_ACCEPT_CODE_SHA
    || !Array.isArray(chain) || chain[0]?.id !== V8_ID
    || chain.at(-1)?.id !== source?.id || chain.at(-1)?.result_md5 !== source?.result_md5
    || !isDeepStrictEqual(chain.at(-1)?.result, source?.result)) {
    fail('schema180 video rebind is not on the exact one-node managed upgrade')
  }
  const firstRebind = chain.findIndex((row, index) => index > 0
    && decodeExecutionState(row.result).sceneCutApprovalRebindRecovery?.version
      === 'scene-cut-approval-rebind-v1')
  if (firstRebind < 4 || firstRebind >= chain.length) {
    fail('schema180 first-shot video lacks a versioned approval rebind descendant')
  }
  const firstParent = decodeExecutionState(chain[firstRebind - 1].result)
  const oldAccept = firstParent.nodeRuns?.[59]?.node
  const oldGraph = workflow.nodes.map(node => node.id === 'sanguo-media-accept'
    ? { ...node, code: oldAccept?.code } : node)
  if (sha256Text(oldAccept?.code ?? '') !== SCHEMA179_NEW_ACCEPT_CODE_SHA
    || !isDeepStrictEqual(oldGraph.find(node => node.id === 'sanguo-media-accept'), oldAccept)) {
    fail('schema180 changed more than the one managed media-accept code')
  }
  const base = assertSchema179SameMediaRetryLineage(chain[firstRebind - 1],
    { ...workflow, schema_version: 179, nodes_md5: SCHEMA179_NODES_MD5,
      nodes: oldGraph }, chain.slice(0, firstRebind))
  const rebindLineage = []
  const composite = decodeExecutionState(chain.at(-1).result).sceneCutCompositeRecovery?.version
    === 'source-bound-composite-first-shot-v1'
  const rebindEnd = composite ? chain.length - 1 : chain.length
  if (composite && (rebindEnd <= firstRebind || chain.at(-2)?.id !==
    'record-4x5m31-original-repair-tail-guide-v2'))
    fail('source-bound composite is not the single terminal child of tail-guide-v2')
  for (let index = firstRebind; index < rebindEnd; index++) {
    const parentRow = chain[index - 1], row = chain[index]
    const parent = decodeExecutionState(parentRow.result), child = decodeExecutionState(row.result)
    const marker = child.sceneCutApprovalRebindRecovery
    const ledger = failedReviewLedgers?.get(row.id)
    const certificate = child.nodeRuns?.[50]?.output
    if (row.workflow_id !== 'wf-sanguo-history-drama' || !/^[a-f0-9]{32}$/.test(row.result_md5 ?? '')
      || !['scene-cut-approval-rebind-v1', 'scene-cut-approval-rebind-v2'].includes(marker?.version)
      || marker.sourceExecutionId !== parentRow.id
      || marker.sourceResultMd5 !== parentRow.result_md5
      || marker.workflowSchemaVersion !== 179 && marker.workflowSchemaVersion !== 180
      || marker.workflowNodesMd5 !== (marker.workflowSchemaVersion === 179
        ? SCHEMA179_NODES_MD5 : SCHEMA180_NODES_MD5)
      || marker.workflowEdgesMd5 !== SCHEMA178_EDGES_MD5
      || !ledger || child.nodeRuns?.[50]?.status !== 'success'
      || certificate?.passed !== true
      || certificate.repairBinding?.executionId !== child.id
      || !isDeepStrictEqual(child.nodeRuns?.slice(0, 50), parent.nodeRuns?.slice(0, 50))) {
      fail(`schema180 rebind hop ${index} lost its source or current-record certificate`)
    }
    verifySceneCutFrameApproval(certificate, root)
    if (marker.version === 'scene-cut-approval-rebind-v2') {
      if (marker.workflowSchemaVersion !== 180) fail('native-tail rebind requires schema180')
      const nativeSource = chain.find(item => item.id === marker.nativeSourceExecutionId)
      const nativeReview = chain.find(item => item.id === marker.nativeReviewExecutionId)
      const nativeReviewLedger = failedReviewLedgers?.get(marker.sourceExecutionId)
      if (!nativeSource || !nativeReview || !nativeReviewLedger
        || nativeSource.result_md5 !== marker.nativeSourceResultMd5
        || nativeReview.result_md5 !== marker.nativeReviewResultMd5) {
        fail('native-tail rebind lost its first rejected video or independent review')
      }
      assertSceneCutTailGuideRebindHop(parent, child, parentRow.result_md5, {
        nativeSource: { state: decodeExecutionState(nativeSource.result),
          resultMd5: nativeSource.result_md5 },
        nativeReview: { state: decodeExecutionState(nativeReview.result),
          resultMd5: nativeReview.result_md5 },
        nativeReviewLedger, currentReviewLedger: ledger,
      }, root, 'historical')
    } else assertSceneCutApprovalRebindHop(parent, child, parentRow.result_md5,
      root, false, ledger)
    rebindLineage.push({ id: row.id, resultMd5: row.result_md5,
      parentExecutionId: parentRow.id, preservedPrefixLength: 50,
      sourceFailedVideoSha256: marker.failedVideoFileSha256,
      rebindMarkerSha256: sceneCutRebindSha256(marker),
      approvalRevision: child.nodeRuns[50].revision,
      certificateExecutionId: certificate.repairBinding.executionId })
  }
  const compositeLineage = composite ? assertSourceBoundCompositeHop(
    decodeExecutionState(chain.at(-2).result), decodeExecutionState(chain.at(-1).result),
    chain.at(-2).result_md5, root, true) : undefined
  return { ...base, videoRebindLineage: rebindLineage,
    ...(compositeLineage ? { sourceBoundCompositeLineage: compositeLineage } : {}) }
}

export function secondShotCreativeProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('second-shot output is malformed')
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ACCEPTANCE_FIELDS.has(key)))
}

export function assertOriginalSecondShotCreativeLock(candidate, accepted) {
  if (sha256(candidate) !== CANDIDATE_SHA || accepted?.passed !== true
    || accepted.manualDecisionRequired === true || !Array.isArray(accepted.issues) || accepted.issues.length > 0
    || sha256(secondShotCreativeProjection(accepted)) !== CANDIDATE_SHA
    || !same([...Object.keys(accepted).filter(key => !ACCEPTANCE_FIELDS.has(key))].sort(),
      [...Object.keys(candidate)].sort())) fail('accepted second shot rewrote the original candidate')
  return { candidateSha256: CANDIDATE_SHA, acceptedSha256: sha256(accepted),
    acceptedCreativeSha256: sha256(secondShotCreativeProjection(accepted)),
    reviewedFieldsChanged: [...ACCEPTANCE_FIELDS].filter(key => !isDeepStrictEqual(candidate[key], accepted[key])) }
}

function parseArguments(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--verify-accepted') { if (options.verifyAccepted) fail('duplicate --verify-accepted'); options.verifyAccepted = true; continue }
    const field = { '--source': 'sourceId', '--id': 'id', '--expected-source-md5': 'sourceMd5',
      '--expected-nodes-md5': 'nodesMd5', '--expected-edges-md5': 'edgesMd5' }[flag]
    if (!field || options[field] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[field] = args[++index]
  }
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '')) fail('--source must be a saved record ID')
  if (options.verifyAccepted) {
    if (options.apply || options.id || options.sourceMd5 || options.nodesMd5 || options.edgesMd5) fail('--verify-accepted uses only --source')
    return options
  }
  if (options.id !== undefined && (!/^record-[\w-]+$/.test(options.id) || options.id === options.sourceId)) fail('--id must be a NEW record ID')
  for (const key of ['sourceMd5', 'nodesMd5', 'edgesMd5']) {
    if (options[key] !== undefined && !/^[a-f0-9]{32}$/i.test(options[key])) fail(`${key} must be an MD5 hash`)
  }
  if (options.apply && (!options.id || !options.sourceMd5 || !options.nodesMd5 || !options.edgesMd5)) {
    fail('--apply requires --id and all three reviewed source/nodes/edges MD5 hashes')
  }
  return options
}

function assertOriginalReference(original) {
  if (original?.id !== ORIGINAL_ID || original.result_md5 !== ORIGINAL_MD5
    || original.workflow_id !== 'wf-sanguo-history-drama') fail('original reference changed')
  const state = decodeExecutionState(original.result)
  const runs = state.nodeRuns
  const outline = outputFor(runs, 'sanguo-scene-outline-accept')
  const candidate = outputFor(runs, 'sanguo-shot-script', 1)
  const accepted = outputFor(runs, 'sanguo-shot-script-accept', 1)
  if (sha256(outline) !== OUTLINE_SHA || sha256(outline.scenes?.[1]) !== SCENE2_SHA
    || sha256(candidate) !== CANDIDATE_SHA || sha256(accepted) !== ACCEPTED_SHA) {
    fail('original outline or second-shot script differs from the approved source')
  }
  assertOriginalSecondShotCreativeLock(candidate, accepted)
  return { state, outline, candidate, accepted }
}

function expandOriginalSecondScene(context, scene, candidate, originalOutline) {
  const outline = context.scene_outline
  const approved = context.approved_scene_outline
  if (!outline || !Array.isArray(outline.scenes) || !approved
    || !isDeepStrictEqual(approved.scenes, originalOutline.scenes)
    || !isDeepStrictEqual(scene, originalOutline.scenes[1])) {
    fail('new run lost the exact approved outline or scene')
  }
  const sourceIndex = outline.scenes.findIndex(item => item?.id === scene.id)
  if (sourceIndex !== 1 || !isDeepStrictEqual(outline.scenes[1], originalOutline.scenes[1])) {
    fail('second scene was modified before replay')
  }
  const projectedScene = sceneFromStoryboardSegment(scene, candidate, 0, 1)
  const scenes = [...outline.scenes.slice(0, sourceIndex), projectedScene, ...outline.scenes.slice(sourceIndex + 1)]
    .map((item, index) => ({ ...item, sequence: index + 1 }))
  const loop = context.scene_loop && typeof context.scene_loop === 'object' && !Array.isArray(context.scene_loop)
    ? context.scene_loop : undefined
  return {
    ...context, approved_scene_outline: approved,
    scene_outline: { ...outline, scenes, count: scenes.length,
      totalDuration: scenes.reduce((sum, item) => sum + Number(item.targetDuration), 0) },
    ...(loop ? { scene_loop: { ...loop, count: scenes.length } } : {}),
  }
}

/** Pure preparation; an apply is allowed only by the hash-pinned CLI path. */
export function prepareOriginalSecondShotReplay(source, original, workflow, {
  id = 'record-original-second-shot-replay-preview', createdAt = '2026-09-29T00:00:00.000Z',
  approvalRetryChain, videoRebindReviewLedgers, root = process.cwd(),
} = {}) {
  if (!source?.result || source.workflow_id !== 'wf-sanguo-history-drama'
    || !/^record-[\w-]+$/.test(source.id) || source.id === ORIGINAL_ID
    || !/^record-[\w-]+$/.test(id) || id === source.id
    || !Number.isFinite(Date.parse(createdAt))) fail('new first-shot record or replay identity is invalid')
  if (workflow?.id !== source.workflow_id || !SUPPORTED_SCHEMAS.has(workflow.schema_version)
    || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) fail('supported original-case workflow is required')
  const reference = assertOriginalReference(original)
  const state = decodeExecutionState(source.result)
  const runs = state.nodeRuns
  const origin = state.originalTwoShotRepairRecovery
  const current = state.sceneCutFirstFrameRecovery
  const currentVersion = current?.version
  const validCurrentVersion = currentVersion === 'original-two-shot-content-lock-schema171-fork-v1'
    || currentVersion === 'original-shot1-opening-retry-schema172-fork-v1'
    || currentVersion === 'original-shot1-image-retry-schema173-fork-v1'
    || currentVersion === 'original-shot1-image-retry-schema174-fork-v1'
    || currentVersion === 'original-shot1-image-retry-schema175-fork-v1'
    || currentVersion === 'original-shot1-image-retry-schema176-fork-v1'
    || currentVersion === 'original-shot1-image-retry-schema177-fork-v1'
    || currentVersion === 'original-shot1-image-retry-schema178-fork-v1'
  if (state.id !== source.id || state.workflowId !== source.workflow_id
    || !Array.isArray(runs) || runs.some(run => run.status === 'running')
    || origin?.sourceExecutionId !== ORIGINAL_ID || origin.sourceResultMd5 !== ORIGINAL_MD5
    || !validCurrentVersion
    || ([179, 180].includes(workflow.schema_version)
      ? current.workflowSchemaVersion !== 178
        || current.workflowNodesMd5 !== SCHEMA178_NODES_MD5
        || current.workflowEdgesMd5 !== SCHEMA178_EDGES_MD5
      : current.workflowSchemaVersion !== workflow.schema_version
        || current.workflowNodesMd5 !== workflow.nodes_md5
        || current.workflowEdgesMd5 !== workflow.edges_md5)
    || origin.contentHashes?.outline !== OUTLINE_SHA
    || origin.contentHashes?.shot1 !== SHOT1_SHA
    || origin.contentHashes?.shot2Candidate !== CANDIDATE_SHA) {
    fail('source is not the hash-pinned original-case first-shot retake')
  }
  const imageRepair = workflow.schema_version === 177
    ? assertSchema177ImageRepairLineage(state, workflow)
    : workflow.schema_version === 178
      ? assertSchema178ApprovalRetryLineage(source, workflow, approvalRetryChain)
      : workflow.schema_version === 179
        ? assertSchema179SameMediaRetryLineage(source, workflow, approvalRetryChain)
        : workflow.schema_version === 180
          ? assertSchema180VideoRebindLineage(source, workflow, approvalRetryChain,
            videoRebindReviewLedgers, root) : undefined
  const graphNodes = new Map(workflow.nodes.map(node => [node.id, node]))
  if (graphNodes.size !== workflow.nodes.length || runs.length !== 464
    || runs.some(run => !isDeepStrictEqual(run.node, graphNodes.get(run.node.id)))) {
    fail('saved runs do not match the current original-case graph')
  }
  const route = assertOriginalSecondShotArrivalRoute(runs, true)
  const scriptIndex = route.secondScriptIndex, reviewIndex = route.secondReviewIndex
  const outline = outputFor(runs, 'sanguo-scene-outline-accept')
  const shot1 = outputFor(runs, 'sanguo-shot-script-accept', 0)
  const video = outputFor(runs, 'sanguo-video', 0)
  const acceptedVideo = outputFor(runs, 'sanguo-media-accept', 0)
  const last = outputFor(runs, 'sanguo-last-frame', 0)
  const frameApproval = outputFor(runs, 'sanguo-scene-cut-approval', 0)
  const oldVideo = outputFor(reference.state.nodeRuns, 'sanguo-video', 0)
  if (sha256(outline) !== OUTLINE_SHA || sha256(outline.scenes?.[1]) !== SCENE2_SHA
    || sha256(shot1) !== SHOT1_SHA || frameApproval?.passed !== true
    || acceptedVideo?.passed !== true || typeof video?.url !== 'string'
    || !video.url || video.url === oldVideo?.url || last?.available !== true
    || typeof last.url !== 'string' || !last.url) {
    fail('new first shot lacks distinct paid media, approval, or full acceptance')
  }
  const prepared = prepareWorkflowRunContext(runs, scriptIndex)
  if (prepared?.run?.node.id !== 'sanguo-shot-script'
    || !isDeepStrictEqual(prepared.inputContext.approved_scene_outline?.scenes, reference.outline.scenes)
    || !isDeepStrictEqual(prepared.inputContext.scene, reference.outline.scenes[1])
    || sha256(prepared.inputContext.loop?.previous?.shot_script) !== SHOT1_SHA
    || !isDeepStrictEqual(prepared.inputContext.loop?.previous?.video_shot, acceptedVideo)
    || !isDeepStrictEqual(prepared.inputContext.loop?.previous?.last_frame, last)) {
    fail('second-script context does not refer to the accepted original story')
  }
  // This runs the same boundary admission as the writer, without a model call.
  storyboardContinuityContext(prepared.inputContext)
  const expanded = expandOriginalSecondScene(prepared.inputContext, outline.scenes[1], reference.candidate, reference.outline)
  const candidateContext = applyNodeOutputToContext(expanded, runs[scriptIndex].node.resultVar, reference.candidate)
  const candidateRun = { ...runs[scriptIndex], output: reference.candidate,
    context: candidateContext, inputContext: prepared.inputContext,
    status: 'success', durationMs: 1 }
  const nodeRuns = runs.map((run, index) => index === scriptIndex ? candidateRun : run)
  const ready = prepareWorkflowRunContext(nodeRuns, reviewIndex)
  if (sha256(ready?.inputContext.shot_candidate) !== CANDIDATE_SHA
    || !isDeepStrictEqual(ready.inputContext.approved_scene_outline?.scenes, reference.outline.scenes)
    || ready.inputContext.scene?.id !== 'scene-02'
    || nodeRuns.findIndex(run => run.status === 'idle') !== reviewIndex) {
    fail('new script-review context differs from the locked candidate')
  }
  const hash = createJsonHasher()
  const recovery = { version: `original-second-shot-candidate-replay-schema${workflow.schema_version}-fork-v1`,
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    workflowSchemaVersion: workflow.schema_version, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, originalExecutionId: ORIGINAL_ID,
    originalResultMd5: ORIGINAL_MD5, originalCandidateSha256: CANDIDATE_SHA,
    originalAcceptedSha256: ACCEPTED_SHA, approvedOutlineSha256: OUTLINE_SHA,
    sourceFirstVideoSha256: sha256(video), sourceFirstLastFrameSha256: sha256(last),
    preservedPrefixLength: reviewIndex, firstPendingNodeId: nodeRuns[reviewIndex].node.id,
    preservedPrefixOutputsHash: hash(nodeRuns.slice(0, reviewIndex).map(run => run.output ?? null)),
    ...(imageRepair ? { firstShotImageRepairPreparationSha256: imageRepair.repairPreparationSha256 } : {}),
    ...(imageRepair?.approvalRetryLineage
      ? { firstShotApprovalRetryLineage: imageRepair.approvalRetryLineage } : {}),
    ...(imageRepair?.sameMediaRetryLineage
      ? { firstShotSameMediaRetryLineage: imageRepair.sameMediaRetryLineage } : {}),
    ...(imageRepair?.videoRebindLineage
      ? { firstShotVideoRebindLineage: imageRepair.videoRebindLineage } : {}),
    ...(imageRepair?.sourceBoundCompositeLineage
      ? { firstShotSourceBoundCompositeLineage: imageRepair.sourceBoundCompositeLineage } : {}),
  }
  const newState = { ...state, id, parentExecutionId: source.id,
    generationScopeId: id, requestScopeId: state.requestScopeId ?? source.id,
    historical: false, mode: 'step', nodeRuns, context: candidateContext,
    selectedNodeId: nodeRuns[reviewIndex].node.id, branchHistory: [],
    breakpointRollback: undefined, breakpointRollbackHistory: undefined,
    sceneCutFirstFrameRecovery: recovery, secondShotReplayRecovery: recovery,
    logs: [...(Array.isArray(state.logs) ? state.logs : []),
      `复用 ${ORIGINAL_ID} 的原 scene-02 候选脚本；新首镜已通过，次镜从脚本质检待执行。`],
  }
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(newState))))) !== hash(newState)) {
    fail('storage round-trip changed the replay checkpoint')
  }
  return { state: newState, proof: { ...recovery, newExecutionId: id,
    secondScriptIndex: scriptIndex, firstPendingIndex: reviewIndex,
    firstShotAccepted: true, secondShotModelCalls: 0, providerCalls: 0,
    sourceRunCount: runs.length, newRunCount: nodeRuns.length,
    originalCreativeSha256: sha256(secondShotCreativeProjection(reference.accepted)),
    roundTripVerified: true } }
}

async function loadSchema178ApprovalRetryChain(db, source, suffix) {
  const chain = [source]
  const seen = new Set([source.id])
  while (chain[0].id !== V8_ID) {
    if (chain.length >= 9) fail('schema178 approval retry ancestry exceeds eight hops')
    const parentId = decodeExecutionState(chain[0].result).parentExecutionId
    if (typeof parentId !== 'string' || !/^record-[\w-]+$/.test(parentId)
      || seen.has(parentId)) fail('schema178 approval retry ancestry is missing or cyclic')
    const parent = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [parentId])).rows[0]
    if (!parent) fail('schema178 approval retry parent record is missing')
    chain.unshift(parent)
    seen.add(parentId)
  }
  return chain
}

async function loadVideoRebindReviewLedgers(db, chain, suffix) {
  const ledgers = new Map()
  for (const row of chain) {
    const state = decodeExecutionState(row.result)
    if (state.sceneCutCompositeRecovery?.version === 'source-bound-composite-first-shot-v1') continue
    const marker = state.sceneCutApprovalRebindRecovery
    if (!['scene-cut-approval-rebind-v1', 'scene-cut-approval-rebind-v2'].includes(marker?.version)) continue
    const ledger = (await db.query(`SELECT id,status,model_id,request_data,response_data
      FROM model_execution_records WHERE id=$1${suffix}`,
    [marker.failedVideoReviewExecutionId])).rows[0]
    if (!ledger) fail('video rebind failed-review ledger is missing')
    ledgers.set(row.id, { id: ledger.id, status: ledger.status,
      modelId: ledger.model_id, requestKey: ledger.request_data?.requestKey,
      fingerprint: ledger.request_data?.fingerprint,
      output: parseStructuredJson(extractTextResponse(ledger.response_data)) })
  }
  return ledgers
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const original = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${suffix}`, [ORIGINAL_ID])).rows[0]
    const reference = assertOriginalReference(original)
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${suffix}`, [options.sourceId])).rows[0]
    if (!source) fail('source record does not exist')
    if (options.verifyAccepted) {
      const saved = decodeExecutionState(source.result)
      const provenance = saved.secondShotReplayRecovery
      let ancestor = saved.parentExecutionId
      let originInAncestry = false
      for (let depth = 0; ancestor && depth < 16; depth++) {
        if (ancestor === provenance?.sourceExecutionId) { originInAncestry = true; break }
        ancestor = (await db.query('SELECT result->>\'parentExecutionId\' AS parent FROM execution_records WHERE id=$1', [ancestor])).rows[0]?.parent
      }
      if (source.id !== ORIGINAL_ID && (!SUPPORTED_SCHEMAS.has(provenance?.workflowSchemaVersion)
        || provenance.version !== `original-second-shot-candidate-replay-schema${provenance.workflowSchemaVersion}-fork-v1`
        || provenance.originalExecutionId !== ORIGINAL_ID
        || provenance.originalResultMd5 !== ORIGINAL_MD5
        || provenance.originalCandidateSha256 !== CANDIDATE_SHA
        || !originInAncestry)) {
        fail('accepted script lacks the original-candidate replay provenance')
      }
      if ([177, 178, 179, 180].includes(provenance?.workflowSchemaVersion)) {
        const schema = provenance.workflowSchemaVersion
        const marker = schema === 177
          ? assertSchema177ImageRepairLineage(saved, { schema_version: 177,
            nodes_md5: SCHEMA177_NODES_MD5, edges_md5: SCHEMA177_EDGES_MD5 }, { replayed: true })
          : assertSchema178ImageRepairLineage(saved, { schema_version: 178,
            nodes_md5: SCHEMA178_NODES_MD5, edges_md5: SCHEMA178_EDGES_MD5 },
          { replayed: true, replaySchema: schema })
        if (provenance.firstShotImageRepairPreparationSha256 !== marker.repairPreparationSha256) {
          fail('accepted second shot lost the first-shot repair source binding')
        }
        if ([178, 179, 180].includes(schema)) {
          const firstShotSource = (await db.query(`SELECT *,md5(result::text) AS result_md5
            FROM execution_records WHERE id=$1`, [provenance.sourceExecutionId])).rows[0]
          if (!firstShotSource || firstShotSource.result_md5 !== provenance.sourceResultMd5) {
            fail('accepted second shot first-scene source changed')
          }
          const chain = await loadSchema178ApprovalRetryChain(db, firstShotSource, '')
          const videoRebindReviewLedgers = schema === 180
            ? await loadVideoRebindReviewLedgers(db, chain, '') : undefined
          const reviewed = schema === 178
            ? assertSchema178ApprovalRetryLineage(firstShotSource,
              { schema_version: 178, nodes_md5: SCHEMA178_NODES_MD5,
                edges_md5: SCHEMA178_EDGES_MD5 }, chain)
            : schema === 179 ? assertSchema179SameMediaRetryLineage(firstShotSource,
              (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
                md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
              [firstShotSource.workflow_id])).rows[0], chain)
              : assertSchema180VideoRebindLineage(firstShotSource,
                (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
                  md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
                [firstShotSource.workflow_id])).rows[0], chain,
              videoRebindReviewLedgers)
          if (!isDeepStrictEqual(provenance.firstShotApprovalRetryLineage,
            reviewed.approvalRetryLineage)
            || schema === 179 && !isDeepStrictEqual(provenance.firstShotSameMediaRetryLineage,
              reviewed.sameMediaRetryLineage)
            || schema === 180 && (!isDeepStrictEqual(provenance.firstShotSameMediaRetryLineage,
              reviewed.sameMediaRetryLineage)
              || !isDeepStrictEqual(provenance.firstShotVideoRebindLineage,
                reviewed.videoRebindLineage)
              || !isDeepStrictEqual(provenance.firstShotSourceBoundCompositeLineage,
                reviewed.sourceBoundCompositeLineage))) {
            fail('accepted second shot approval ancestry changed')
          }
          const firstShot = decodeExecutionState(firstShotSource.result)
          if (saved.parentExecutionId !== firstShotSource.id
            || !isDeepStrictEqual(saved.nodeRuns?.slice(0, 65),
              firstShot.nodeRuns?.slice(0, 65))
            || !isDeepStrictEqual(saved.sceneCutImageRepairRecovery,
              firstShot.sceneCutImageRepairRecovery)) {
            fail('accepted second shot changed its first-shot media prefix')
          }
        }
      }
      const runs = saved.nodeRuns
      const accepted = outputFor(runs, 'sanguo-shot-script-accept', 1)
      const lock = assertOriginalSecondShotCreativeLock(reference.candidate, accepted)
      await db.query('ROLLBACK')
      console.log(JSON.stringify({ sourceId: source.id, ...lock, verified: true, databaseWrites: 0 }, null, 2))
      return
    }
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${suffix}`, [source.workflow_id])).rows[0]
    const approvalRetryChain = [178, 179, 180].includes(workflow?.schema_version)
      ? await loadSchema178ApprovalRetryChain(db, source, suffix) : undefined
    const videoRebindReviewLedgers = workflow?.schema_version === 180
      ? await loadVideoRebindReviewLedgers(db, approvalRetryChain, suffix) : undefined
    if ([177, 178, 179, 180].includes(workflow?.schema_version)) {
      const v6 = (await db.query(`SELECT md5(result::text) AS result_md5 FROM execution_records
        WHERE id=$1${suffix}`, [V6_ID])).rows[0]
      if (v6?.result_md5 !== V6_MD5) fail('rejected source v6 changed since the image-repair fork')
    }
    if ([178, 179, 180].includes(workflow?.schema_version)) {
      const v7 = (await db.query(`SELECT md5(result::text) AS result_md5 FROM execution_records
        WHERE id=$1${suffix}`, [V7_ID])).rows[0]
      if (v7?.result_md5 !== V7_REJECTED_MD5) fail('rejected source v7 changed since the geometry-guide fork')
    }
    if (options.sourceMd5 && source.result_md5 !== options.sourceMd5.toLowerCase()) fail('source MD5 differs from reviewed input')
    if (options.nodesMd5 && workflow?.nodes_md5 !== options.nodesMd5.toLowerCase()) fail('nodes MD5 differs from reviewed input')
    if (options.edgesMd5 && workflow?.edges_md5 !== options.edgesMd5.toLowerCase()) fail('edges MD5 differs from reviewed input')
    if (options.apply && (!SUPPORTED_SCHEMAS.has(workflow?.schema_version) || !source.result_md5)) {
      fail('a supported saved workflow and source are required')
    }
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('replay ID already exists')
    const { state, proof } = prepareOriginalSecondShotReplay(source, original, workflow,
      { id: options.id, approvalRetryChain, videoRebindReviewLedgers })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `原第二镜脚本复核 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result)) !== createJsonHasher()(state)) {
        fail('saved replay differs from reviewed candidate')
      }
    }
    const sourceAfter = await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [source.id])
    const originalAfter = await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [ORIGINAL_ID])
    const workflowAfter = await db.query('SELECT schema_version,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflow.id])
    for (const ancestor of approvalRetryChain ?? []) {
      const after = (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [ancestor.id])).rows[0]
      if (after?.md5 !== ancestor.result_md5) fail('approval retry ancestor changed during replay')
    }
    if (sourceAfter.rows[0]?.md5 !== source.result_md5 || originalAfter.rows[0]?.md5 !== ORIGINAL_MD5
      || workflowAfter.rows[0]?.schema_version !== workflow.schema_version
      || workflowAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || workflowAfter.rows[0]?.edges_md5 !== workflow.edges_md5) fail('source, original, or workflow changed')
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply, databaseWrites: options.apply ? 1 : 0,
      sourceResultMd5After: sourceAfter.rows[0].md5, originalResultMd5After: originalAfter.rows[0].md5 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
