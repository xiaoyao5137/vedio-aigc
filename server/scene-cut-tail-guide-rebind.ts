import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'

type Value = Record<string, unknown>
type Run = Value & { node?: Value; output?: Value; status?: string; revision?: number }
type State = Value & { id?: string; parentExecutionId?: string; nodeRuns?: Run[] }
type RecordWitness = { state: unknown; resultMd5: string }
type Ledger = { id?: unknown; status?: unknown; modelId?: unknown; requestKey?: unknown;
  fingerprint?: unknown; output?: unknown }
export type TailGuideWitness = {
  nativeSource: RecordWitness
  nativeReview: RecordWitness
  nativeReviewLedger: Ledger
  currentReviewLedger: Ledger
}
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Value : {}
const fail = (message: string): never => { throw Error(`SCENE_CUT_TAIL_GUIDE_INVALID: ${message}`) }
const hex = (value: unknown, length: number) => typeof value === 'string'
  && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
const recordId = (value: unknown) => typeof value === 'string' && /^record-[\w-]+$/.test(value)
const sha256Bytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const runsOf = (state: State) => Array.isArray(state.nodeRuns) ? state.nodeRuns : []
const projectedReview = (output: unknown) => Object.fromEntries(Object.entries(object(output))
  .filter(([key]) => !['raw', 'text', 'model', 'reviewTransport'].includes(key)))
const SCHEMA180_NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const SCHEMA180_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const NATIVE_SOURCE_ID = 'record-levw1e'
const NATIVE_SOURCE_MD5 = 'a06fb401d4655699fce3ec69548e578c'
const NATIVE_REVIEW_ID = 'record-9p80o5'
const NATIVE_REVIEW_MD5 = '4282a0710daef80462a46423391be68f'

function mediaBytes(root: string, url: unknown, extension: RegExp) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url)
    || !extension.test(url)) fail('media URL is not an archived generated file')
  try { return readFileSync(path.join(root, 'public', url as string)) }
  catch { return fail('archived source media file is missing') }
}
function validatedLedger(ledger: Ledger, record: State, review: Run, marker: Value,
  prefix: 'failed' | 'native') {
  const key = marker[`${prefix}VideoReviewRequestKey`]
  const modelId = marker[`${prefix}VideoReviewExecutionId`]
  const fingerprint = marker[`${prefix}VideoReviewFingerprint`]
  if (!hex(fingerprint, 64) || typeof modelId !== 'string' || !/^model-run-[\w-]+$/.test(modelId)
    || ledger.id !== modelId || ledger.status !== 'succeeded'
    || ledger.modelId !== object(review.output).model
    || ledger.requestKey !== key || ledger.fingerprint !== fingerprint
    || typeof key !== 'string'
    || !new RegExp(`^${record.id}:attempt-[1-9]\\d*:revision-(?:0|[1-9]\\d*):sanguo-media-review:0:scene-01:principle-review-[1-9]\\d*$`).test(key)
    || !isDeepStrictEqual(ledger.output, projectedReview(review.output))) {
    fail(`${prefix} independent review ledger does not match the saved decision`)
  }
}

/** This remains a rejected video. Its native last image is usable only as a
 * target-frame reference after the exact media and independent review agree. */
export function assertSceneCutTailGuideRebindHop(sourceInput: unknown, childInput: unknown,
  sourceResultMd5: string, witness: TailGuideWitness, root = process.cwd(),
  phase: 'preview' | 'approval' | 'failed-approval' | 'video' | 'historical' = 'approval') {
  const source = object(sourceInput) as State, child = object(childInput) as State
  const marker = object(child.sceneCutApprovalRebindRecovery)
  const before = runsOf(source), after = runsOf(child)
  const native = object(witness.nativeSource.state) as State
  const reviewed = object(witness.nativeReview.state) as State
  const nativeRuns = runsOf(native), reviewedRuns = runsOf(reviewed)
  const image = object(before[45]?.output), imageRaw = object(image.raw)
  const approval = object(before[50]?.output), binding = object(approval.repairBinding)
  const video = object(before[52]?.output), evidence = object(nativeRuns[54]?.output)
  const tail = object(marker.tailGuide)
  const currentReview = object(before[58]?.output), accept = object(before[59]?.output)
  if (!recordId(source.id) || !recordId(child.id) || child.id === source.id
    || child.parentExecutionId !== source.id
    || !hex(sourceResultMd5, 32) || marker.version !== 'scene-cut-approval-rebind-v2'
    || marker.sourceExecutionId !== source.id || marker.sourceResultMd5 !== sourceResultMd5
    || marker.originalExecutionId !== 'record-4x5m31'
    || marker.originalResultMd5 !== '74e5e2f8afcf8f829694aef350629950'
    || marker.reviewSourceExecutionId !== 'record-4x5m31-original-repair-v8'
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== SCHEMA180_NODES_MD5
    || marker.workflowEdgesMd5 !== SCHEMA180_EDGES_MD5
    || marker.preservedPrefixLength !== 50
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-approval'
    || source.workflowId !== 'wf-sanguo-history-drama'
    || child.workflowId !== source.workflowId
    || child.requestScopeId !== source.requestScopeId
    || child.generationScopeId !== child.id
    || !isDeepStrictEqual(source.sceneCutImageRepairRecovery, child.sceneCutImageRepairRecovery)
    || !isDeepStrictEqual(source.sceneCutFirstFrameRecovery, child.sceneCutFirstFrameRecovery)
    || !isDeepStrictEqual(source.originalShot1ImageV8RetryRecovery,
      child.originalShot1ImageV8RetryRecovery)
    || !isDeepStrictEqual(source.priorSceneCutImageRepairRecovery,
      child.priorSceneCutImageRepairRecovery)
    || !isDeepStrictEqual(source.originalTwoShotRepairRecovery,
      child.originalTwoShotRepairRecovery)
    || before.length !== 464 || after.length !== 464
    || !isDeepStrictEqual(before.slice(0, 50), after.slice(0, 50))
    || marker.preservedPrefixSha256 !== sceneCutRebindSha256(before.slice(0, 50))
    || before[45]?.status !== 'success' || before[48]?.status !== 'success'
    || before[49]?.status !== 'success' || object(before[49].output).passed !== true
    || before[50]?.status !== 'success' || approval.passed !== true
    || binding.executionId !== source.id
    || before[52]?.status !== 'success' || before[54]?.status !== 'success'
    || before[58]?.status !== 'success' || currentReview.decision !== 'revise'
    || !Array.isArray(currentReview.issues)
    || !(currentReview.issues as unknown[]).some(item => {
      const issue = object(item)
      return issue.code === 'core_event_contradiction'
        && object(issue.evidence).source === 'frame'
        && Array.isArray(object(issue.evidence).frameIndices)
        && (object(issue.evidence).frameIndices as unknown[]).length >= 2
    })
    || before[59]?.status !== 'success' || accept.qualityDisposition !== 'manual-review-v1'
    || accept.manualDecisionRequired !== true
    || object(accept.qualityReview).manualDecisionRequired !== true
    || before.slice(60, 65).some(run => run.status !== 'idle')
    || marker.failedReviewOutputSha256 !== sceneCutRebindSha256(currentReview)
    || marker.failedMediaAcceptOutputSha256 !== sceneCutRebindSha256(accept)
    || marker.approvedImageUrl !== image.url
    || marker.approvedImageSha256 !== object(object(imageRaw.raw).image).sha256
    || marker.imageExecutionId !== imageRaw.modelExecutionId
    || marker.repairRequestFingerprint !== imageRaw.repairRequestFingerprint
    || marker.reviewExecutionId !== approval.reviewExecutionId
    || marker.reviewOutputSha256 !== sceneCutRebindSha256(before[49].output)
    || marker.evidenceOutputSha256 !== sceneCutRebindSha256(before[48].output)
    || marker.approvedShotSha256 !== approval.shotSha256
    || marker.oldApprovalSha256 !== sceneCutRebindSha256(approval)
    || marker.oldCertificateExecutionId !== source.id
    || marker.failedVideoUrl !== video.url
    || marker.failedVideoOutputSha256 !== sceneCutRebindSha256(video)
    || native.id !== NATIVE_SOURCE_ID || witness.nativeSource.resultMd5 !== NATIVE_SOURCE_MD5
    || reviewed.id !== NATIVE_REVIEW_ID || witness.nativeReview.resultMd5 !== NATIVE_REVIEW_MD5
    || reviewed.parentExecutionId !== native.id
    || !isDeepStrictEqual(nativeRuns.slice(0, 58), reviewedRuns.slice(0, 58))
    || !isDeepStrictEqual(nativeRuns.slice(0, 50), before.slice(0, 50))
    || marker.nativeSourceExecutionId !== native.id
    || marker.nativeSourceResultMd5 !== witness.nativeSource.resultMd5
    || marker.nativeReviewExecutionId !== reviewed.id
    || marker.nativeReviewResultMd5 !== witness.nativeReview.resultMd5
    || nativeRuns[52]?.status !== 'success' || nativeRuns[54]?.status !== 'success'
    || reviewedRuns[58]?.status !== 'success'
    || object(reviewedRuns[58].output).decision !== 'revise'
    || typeof object(reviewedRuns[58].output).endingState !== 'string'
    || marker.nativeReviewOutputSha256 !== sceneCutRebindSha256(reviewedRuns[58].output)
    || evidence.evidenceVersion !== 2
    || evidence.sha256 !== tail.videoFileSha256
    || evidence.originalUrl !== object(nativeRuns[52].output).url
    || evidence.lastFrameUrl !== tail.url
    || (Array.isArray(evidence.frames) ? evidence.frames.at(-1) : null) !== tail.url
    || marker.nativeEvidenceOutputSha256 !== sceneCutRebindSha256(evidence)
    || tail.sourceExecutionId !== native.id
    || tail.reviewExecutionId !== reviewed.id
    || tail.sourceVideoUrl !== evidence.originalUrl
    || tail.evidenceVideoUrl !== evidence.url
    || tail.evidenceUrl !== evidence.evidenceUrl
    || !hex(tail.videoFileSha256, 64) || !hex(tail.fileSha256, 64)
    || !hex(tail.evidenceFileSha256, 64)
    || marker.failedVideoFileSha256 !== sha256Bytes(mediaBytes(root, video.url, /\.mp4$/i))
    || marker.approvedImageSha256 !== sha256Bytes(mediaBytes(root, image.url, /\.png$/i))
    || tail.videoFileSha256 !== sha256Bytes(mediaBytes(root, evidence.url, /\.mp4$/i))
    || tail.videoFileSha256 !== sha256Bytes(mediaBytes(root, evidence.originalUrl, /\.mp4$/i))
    || tail.fileSha256 !== sha256Bytes(mediaBytes(root, tail.url, /\.jpe?g$/i))
    || tail.evidenceFileSha256 !== sha256Bytes(mediaBytes(root, tail.evidenceUrl, /\.json$/i))) {
    fail('reapproval fork changed the reviewed image, rejected video, or native-tail witness')
  }
  validatedLedger(witness.currentReviewLedger, source, before[58], marker, 'failed')
  validatedLedger(witness.nativeReviewLedger, reviewed, reviewedRuns[58], marker, 'native')
  if (after[50]?.node?.id !== 'sanguo-scene-cut-approval'
    || before[50]?.id !== after[50]?.id
    || !isDeepStrictEqual(before[50]?.node, after[50]?.node)
    || Number(after[50]?.revision) !== Number(before[50]?.revision ?? 0) + 1
    || Number(after[52]?.revision) !== Number(before[52]?.revision ?? 0) + 1
    || after[52]?.node?.id !== 'sanguo-video'
    || !isDeepStrictEqual(after[52]?.routeInputOverrides, {
      end_frame: { url: tail.url, sha256: tail.fileSha256 } })
    || Object.keys(object(after[52]?.paramOverrides)).length !== 0
    || !Array.isArray(after[52]?.node?.params)
    || !(after[52].node.params as unknown[]).some(param => {
      const item = object(param)
      return item.englishName === 'endImage' && item.value === '${end_frame.url}'
    })) fail('new video is not pinned to the native tail through its saved route input')
  if (phase === 'preview' && after.slice(50).some(run => run.status !== 'idle'))
    fail('preview checkpoint is not idle')
  if (phase === 'approval' && (after[50].status !== 'running'
    || after.slice(51).some(run => run.status !== 'idle')))
    fail('approval checkpoint has advanced beyond its signed boundary')
  if (phase === 'failed-approval' && (after[50].status !== 'failed'
    || after.slice(51).some(run => run.status !== 'idle')))
    fail('failed approval retry ancestor changed its unpaid boundary')
  if (phase === 'video' && (after[50].status !== 'success'
    || after[51]?.status !== 'success' || after[52].status !== 'running'
    || after.slice(53).some(run => run.status !== 'idle')
    || object(after[50].output).passed !== true
    || object(object(after[50].output).repairBinding).executionId !== child.id))
    fail('video request has no current-record signed approval')
  if (phase === 'historical' && (after[50].status !== 'success'
    || after[51]?.status !== 'success' || after[52].status !== 'success'
    || object(after[50].output).passed !== true
    || object(object(after[50].output).repairBinding).executionId !== child.id
    || object(object(after[52].output).params).endImage !== tail.url))
    fail('completed video does not retain its certified native-tail request')
  return { endImage: tail.url as string, endImageSha256: tail.fileSha256 as string,
    sourceVideoSha256: tail.videoFileSha256 as string }
}
