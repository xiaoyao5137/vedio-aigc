import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

type Value = Record<string, unknown>
type Run = Value & { node?: Value; output?: Value; status?: string; revision?: number }
type State = Value & { id?: string; parentExecutionId?: string; nodeRuns?: Run[] }
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const fail = (message: string): never => { throw Error(`SCENE_CUT_APPROVAL_REBIND_INVALID: ${message}`) }
const hex = (value: unknown, length: number) => typeof value === 'string'
  && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
const recordId = (value: unknown) => typeof value === 'string' && /^record-[\w-]+$/.test(value)
const modelId = (value: unknown) => typeof value === 'string' && /^model-run-[\w-]+$/.test(value)
const SCHEMA179_NODES_MD5 = 'db1556fa6605e179a7a37e52cbbe8135'
const SCHEMA180_NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const MANAGED_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'

/** Persisted JSONB changes key order. Hash the semantic record canonically. */
export function sceneCutRebindCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sceneCutRebindCanonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${sceneCutRebindCanonical(item)}`).join(',')}}`
  return JSON.stringify(value ?? null)
}
export const sceneCutRebindSha256 = (value: unknown) => createHash('sha256')
  .update(sceneCutRebindCanonical(value)).digest('hex')
const reviewProjection = (output: unknown) => Object.fromEntries(Object.entries(object(output))
  .filter(([key]) => !['raw', 'text', 'model', 'reviewTransport'].includes(key)))

function generatedBytes(url: unknown, root: string, extension: RegExp) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url) || !extension.test(url))
    fail('asset URL is not a local generated file')
  try { return readFileSync(path.join(root, 'public', url as string)) }
  catch { return fail('signed source media file is missing') }
}
const bytesSha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const runsOf = (state: State) => Array.isArray(state.nodeRuns) ? state.nodeRuns : []
const reviewedContradiction = (run: Run) => run.status === 'success'
  && object(run.output).decision === 'revise'
  && Array.isArray(object(run.output).issues)
  && (object(run.output).issues as unknown[]).some(issue => {
    const item = object(issue)
    return item.code === 'core_event_contradiction'
      && object(item.evidence).source === 'frame'
      && Array.isArray(object(item.evidence).frameIndices)
      && (object(item.evidence).frameIndices as unknown[]).length >= 2
  })

/** The schema179 retry only regenerated review/acceptance. It cannot acquire
 * authority over the paid image, signed approval, or paid video prefix. */
export function assertSceneCutSameMediaReviewHop(parentInput: unknown, childInput: unknown,
  rebindMarkerInput: unknown, parentResultMd5: string, childResultMd5: string) {
  const parent = object(parentInput) as State, child = object(childInput) as State
  const marker = object(rebindMarkerInput)
  const before = runsOf(parent), after = runsOf(child)
  const parentApproval = object(before[50]?.output), childApproval = object(after[50]?.output)
  if (!recordId(parent.id) || !recordId(child.id) || child.parentExecutionId !== parent.id
    || marker.sameMediaAncestorExecutionId !== parent.id
    || marker.sameMediaAncestorResultMd5 !== parentResultMd5
    || marker.sourceExecutionId !== child.id || marker.sourceResultMd5 !== childResultMd5
    || !hex(parentResultMd5, 32) || !hex(childResultMd5, 32)
    || parent.workflowId !== child.workflowId
    || parent.requestScopeId !== child.requestScopeId
    || child.generationScopeId !== child.id
    || !isDeepStrictEqual(parent.sceneCutImageRepairRecovery, child.sceneCutImageRepairRecovery)
    || !isDeepStrictEqual(parent.sceneCutFirstFrameRecovery, child.sceneCutFirstFrameRecovery)
    || !isDeepStrictEqual(parent.originalTwoShotRepairRecovery, child.originalTwoShotRepairRecovery)
    || before.length !== 464 || after.length !== 464
    || !isDeepStrictEqual(before.slice(0, 58), after.slice(0, 58))
    || before[50]?.status !== 'success' || after[50]?.status !== 'success'
    || parentApproval.passed !== true || !isDeepStrictEqual(parentApproval, childApproval)
    || object(parentApproval.repairBinding).executionId !== parent.id
    || before[52]?.status !== 'success' || after[52]?.status !== 'success'
    || before[61]?.status !== 'failed' || object(before[59]?.output).passed !== false
    || !reviewedContradiction(after[58]) || object(after[59]?.output).passed !== false
    || marker.failedReviewOutputSha256 !== sceneCutRebindSha256(after[58].output)
    || marker.failedMediaAcceptOutputSha256 !== sceneCutRebindSha256(after[59].output)) {
    fail('same-media review hop changed its paid prefix or failure witness')
  }
  return true
}

/** Only a failed paid-video descendant may rerun index50 to obtain a fresh
 * current-record certificate. It retains the exact image and review prefix. */
export function assertSceneCutApprovalRebindHop(parentInput: unknown, childInput: unknown,
  parentResultMd5: string, root = process.cwd(), activeChild = true,
  failedReviewLedgerInput?: unknown) {
  const parent = object(parentInput) as State, child = object(childInput) as State
  const marker = object(child.sceneCutApprovalRebindRecovery)
  const before = runsOf(parent), after = runsOf(child)
  const oldApproval = object(before[50]?.output)
  const oldBinding = object(oldApproval.repairBinding)
  const image = object(before[45]?.output), imageRaw = object(image.raw)
  const evidence = object(before[48]?.output), review = object(before[49]?.output)
  const video = object(before[52]?.output)
  const failedReviewLedger = object(failedReviewLedgerInput)
  const candidateUrl = image.url, videoUrl = video.url
  if (!recordId(parent.id) || !recordId(child.id) || child.id === parent.id
    || child.parentExecutionId !== parent.id || marker.version !== 'scene-cut-approval-rebind-v1'
    || marker.sourceExecutionId !== parent.id || marker.sourceResultMd5 !== parentResultMd5
    || !hex(parentResultMd5, 32)
    || marker.workflowSchemaVersion !== 179 && marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== (marker.workflowSchemaVersion === 179
      ? SCHEMA179_NODES_MD5 : SCHEMA180_NODES_MD5)
    || marker.workflowEdgesMd5 !== MANAGED_EDGES_MD5
    || marker.originalExecutionId !== 'record-4x5m31'
    || marker.originalResultMd5 !== '74e5e2f8afcf8f829694aef350629950'
    || marker.reviewSourceExecutionId !== 'record-4x5m31-original-repair-v8'
    || marker.preservedPrefixLength !== 50
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-approval'
    || parent.workflowId !== 'wf-sanguo-history-drama'
    || child.workflowId !== parent.workflowId
    || parent.requestScopeId !== child.requestScopeId
    || child.generationScopeId !== child.id
    || !isDeepStrictEqual(parent.sceneCutImageRepairRecovery, child.sceneCutImageRepairRecovery)
    || !isDeepStrictEqual(parent.sceneCutFirstFrameRecovery, child.sceneCutFirstFrameRecovery)
    || !isDeepStrictEqual(parent.originalShot1ImageV8RetryRecovery,
      child.originalShot1ImageV8RetryRecovery)
    || !isDeepStrictEqual(parent.priorSceneCutImageRepairRecovery,
      child.priorSceneCutImageRepairRecovery)
    || !isDeepStrictEqual(parent.originalTwoShotRepairRecovery,
      child.originalTwoShotRepairRecovery)
    || before.length !== 464 || after.length !== 464
    || !isDeepStrictEqual(before.slice(0, 50), after.slice(0, 50))
    || marker.preservedPrefixSha256 !== sceneCutRebindSha256(before.slice(0, 50))
    || before[45]?.status !== 'success' || before[48]?.status !== 'success'
    || before[49]?.status !== 'success' || review.passed !== true
    || before[50]?.status !== 'success' || oldApproval.passed !== true
    || before[52]?.status !== 'success' || !reviewedContradiction(before[58])
    || object(before[59]?.output).passed !== false
    || marker.failedReviewOutputSha256 !== sceneCutRebindSha256(before[58].output)
    || marker.failedMediaAcceptOutputSha256 !== sceneCutRebindSha256(before[59].output)
    || !modelId(marker.failedVideoReviewExecutionId)
    || failedReviewLedger.id !== marker.failedVideoReviewExecutionId
    || failedReviewLedger.status !== 'succeeded'
    || failedReviewLedger.modelId !== object(before[58]?.output).model
    || failedReviewLedger.requestKey !== marker.failedVideoReviewRequestKey
    || typeof failedReviewLedger.requestKey !== 'string'
    || !new RegExp(`^${parent.id}:attempt-[1-9]\\d*:revision-(?:0|[1-9]\\d*):sanguo-media-review:0:scene-01:principle-review-[1-9]\\d*$`)
      .test(failedReviewLedger.requestKey)
    || failedReviewLedger.fingerprint !== marker.failedVideoReviewFingerprint
    || !hex(marker.failedVideoReviewFingerprint, 64)
    || !isDeepStrictEqual(failedReviewLedger.output, reviewProjection(before[58].output))
    || marker.approvedImageUrl !== candidateUrl
    || marker.approvedImageSha256 !== object(object(imageRaw.raw).image).sha256
    || marker.imageExecutionId !== imageRaw.modelExecutionId
    || !modelId(marker.imageExecutionId)
    || marker.repairRequestFingerprint !== imageRaw.repairRequestFingerprint
    || !hex(marker.repairRequestFingerprint, 64)
    || marker.reviewExecutionId !== oldApproval.reviewExecutionId
    || !modelId(marker.reviewExecutionId)
    || marker.reviewOutputSha256 !== sceneCutRebindSha256(review)
    || marker.evidenceOutputSha256 !== sceneCutRebindSha256(evidence)
    || marker.oldApprovalSha256 !== sceneCutRebindSha256(oldApproval)
    || oldBinding.reviewSourceExecutionId !== 'record-4x5m31-original-repair-v8'
    || marker.oldCertificateExecutionId !== oldBinding.executionId
    || marker.oldCertificateExecutionId !== marker.sameMediaAncestorExecutionId
    || marker.approvedShotSha256 !== oldApproval.shotSha256
    || marker.failedVideoUrl !== videoUrl
    || marker.failedVideoOutputSha256 !== sceneCutRebindSha256(video)
    || after[50]?.node?.id !== 'sanguo-scene-cut-approval'
    || before[50]?.id !== after[50]?.id
    || !isDeepStrictEqual(before[50]?.node, after[50]?.node)
    || Number(after[50]?.revision) !== Number(before[50]?.revision ?? 0) + 1
    || Number(after[52]?.revision) !== Number(before[52]?.revision ?? 0) + 1
    || activeChild && after.slice(51).some(run => run.status !== 'idle')
    || after[50]?.status !== (activeChild ? 'running' : 'success')) {
    fail('reapproval fork is not bound to the rejected video and approved image')
  }
  if (bytesSha256(generatedBytes(candidateUrl, root, /\.png$/i)) !== marker.approvedImageSha256
    || bytesSha256(generatedBytes(videoUrl, root, /\.mp4$/i)) !== marker.failedVideoFileSha256)
    fail('approved image or failed video bytes changed')
  if (!activeChild) {
    const newApproval = object(after[50].output), binding = object(newApproval.repairBinding)
    if (newApproval.passed !== true || binding.executionId !== child.id
      || binding.reviewSourceExecutionId !== 'record-4x5m31-original-repair-v8'
      || binding.imageExecutionId !== marker.imageExecutionId
      || binding.candidateImageSha256 !== marker.approvedImageSha256
      || newApproval.reviewExecutionId !== marker.reviewExecutionId)
      fail('completed reapproval certificate is not bound to the new execution')
  }
  return true
}

/** A completed approval retry is historical evidence while reissuing index50.
 * Ordinary active retries still use the existing failed-to-running policy. */
export function assertSceneCutCompletedApprovalRetryHop(parentInput: unknown, childInput: unknown) {
  const parent = object(parentInput) as State, child = object(childInput) as State
  const before = runsOf(parent), after = runsOf(child)
  const prior = before[50], next = after[50]
  const certificate = object(next?.output), binding = object(certificate.repairBinding)
  if (!recordId(parent.id) || !recordId(child.id) || child.parentExecutionId !== parent.id
    || parent.workflowId !== child.workflowId || parent.requestScopeId !== child.requestScopeId
    || child.generationScopeId !== child.id
    || !isDeepStrictEqual(parent.sceneCutImageRepairRecovery, child.sceneCutImageRepairRecovery)
    || before.length !== 464 || after.length !== 464
    || !isDeepStrictEqual(before.slice(0, 50), after.slice(0, 50))
    || prior?.status !== 'failed' || next?.status !== 'success'
    || before.slice(51).some(run => run.status !== 'idle')
    || prior.id !== next.id || !isDeepStrictEqual(prior.node, next.node)
    || Number(next.revision) !== Number(prior.revision ?? 0) + 1
    || certificate.passed !== true || binding.executionId !== child.id
    || binding.reviewSourceExecutionId !== 'record-4x5m31-original-repair-v8'
    || !modelId(certificate.reviewExecutionId)) {
    fail('historical approval retry changed reviewed media or signed ownership')
  }
  return true
}
