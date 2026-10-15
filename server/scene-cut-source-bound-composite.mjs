/** Admission for a locally composed scene-01 take. The old paid take and its
 * independent rejection stay in the parent record; the child carries a signed
 * segment/composition receipt and rechecks the entire delivered shot. */
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { verifySceneCutFrameApproval, validateSceneCutVideoPayment } from './scene-cut-frame-approval.ts'
import { verifyStagedSceneCutCompositeReceiptSync } from './staged-scene-cut.mjs'
import * as a8b5 from './staged-scene-cut-a8b5.mjs'
import { principleDurationTransitionIssue } from '../src/history-cinema.ts'

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const fail = message => { throw Error(`SOURCE_BOUND_COMPOSITE_HOP_INVALID: ${message}`) }

/** Freeze the exact six paid stage receipts admitted by the composite fork. */
export function compositeStageReceiptHashes(planId, root = process.cwd(),
  stagingVariant = 'standard', manifest) {
  if (!/^[a-f0-9]{64}$/.test(String(planId))) fail('staged plan ID is invalid')
  if (stagingVariant === 'a8b5') {
    if (manifest?.version !== 'staged-scene-cut-a8b5-provisional-v1'
      || !/^[a-f0-9]{64}$/.test(String(manifest.source?.planId)))
      fail('A8+B5 signed source plan is missing')
    const original = path.join(root, '.runtime/staged-scene-cut', manifest.source.planId)
    const continuation = path.join(root, '.runtime/staged-scene-cut-a8b5', planId)
    const digestFile = (directory, filename) => createHash('sha256')
      .update(readFileSync(path.join(directory, filename))).digest('hex')
    const A = { manifest: digestFile(original, 'manifest.json'),
      task: digestFile(original, 'phase-A-task.json'),
      media: digestFile(original, 'phase-A-media.json'),
      provisionalReview: digestFile(continuation, 'provisional-A-review.json') }
    if (A.manifest !== manifest.source.manifestSha256
      || A.task !== manifest.source.taskSha256
      || A.media !== manifest.source.mediaSha256)
      fail('A8+B5 original paid A source receipts changed')
    return { A, B: { task: digestFile(continuation, 'phase-B-task.json'),
      media: digestFile(continuation, 'phase-B-media.json'),
      acceptance: digestFile(continuation, 'phase-B-acceptance.json') } }
  }
  if (stagingVariant !== 'standard') fail('unknown staged composite variant')
  return Object.fromEntries(['A', 'B'].map(phase => [phase, Object.fromEntries(
    ['task', 'media', 'acceptance'].map(kind => {
      const filename = path.join(root, '.runtime/staged-scene-cut', planId,
        `phase-${phase}-${kind}.json`)
      return [kind, createHash('sha256').update(readFileSync(filename)).digest('hex')]
    }))]))
}

/** Historical replay is synchronous, so it must independently recheck the
 * complete signed composite rather than trusting the fork's cached marker. */
export function verifyCompositeForSourceBoundLineageSync(planId,
  stagingVariant = 'standard', root = process.cwd()) {
  if (!/^[a-f0-9]{64}$/.test(String(planId))) fail('staged plan ID is invalid')
  if (stagingVariant === 'a8b5') {
    if (typeof a8b5.verifyA8B5CompositeReceiptSync !== 'function')
      fail('A8+B5 final composite verifier is not available')
    return a8b5.verifyA8B5CompositeReceiptSync(planId, root)
  }
  if (stagingVariant !== 'standard') fail('unknown staged composite variant')
  return verifyStagedSceneCutCompositeReceiptSync(planId, root)
}

/** The only admissible composite hop is a single settled child of the exact
 * rejected tail-guide-v2 record. `completed=false` checks a fresh checkpoint;
 * `completed=true` is used by second-shot replay after full-shot acceptance. */
export function assertSourceBoundCompositeHop(parentInput, childInput, parentResultMd5,
  root = process.cwd(), completed = true) {
  const parent = object(parentInput), child = object(childInput)
  const marker = object(child.sceneCutCompositeRecovery)
  const before = parent.nodeRuns, after = child.nodeRuns
  if (parent.id !== 'record-4x5m31-original-repair-tail-guide-v2'
    || parentResultMd5 !== '34abee4a7c010616b837dbc175b69c56'
    || !Array.isArray(before) || !Array.isArray(after)
    || before.length !== 464 || after.length !== before.length
    || marker.version !== 'source-bound-composite-first-shot-v1'
    || marker.sourceExecutionId !== parent.id || marker.sourceResultMd5 !== parentResultMd5
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
    || marker.workflowEdgesMd5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
    || marker.originalExecutionId !== 'record-4x5m31'
    || child.parentExecutionId !== parent.id || child.id === parent.id
    || child.workflowId !== parent.workflowId || child.requestScopeId !== parent.requestScopeId
    || child.generationScopeId !== child.id
    || !isDeepStrictEqual(child.sceneCutApprovalRebindRecovery, parent.sceneCutApprovalRebindRecovery)
    || !isDeepStrictEqual(child.sceneCutImageRepairRecovery, parent.sceneCutImageRepairRecovery)
    || !isDeepStrictEqual(child.originalTwoShotRepairRecovery, parent.originalTwoShotRepairRecovery)
    || !isDeepStrictEqual(after.slice(0, 52), before.slice(0, 52))
    || marker.preservedPrefixLength !== 52
    || marker.preservedPrefixSha256 !== sceneCutRebindSha256(before.slice(0, 52))
    || before[50]?.status !== 'success' || after[50]?.status !== 'success'
    || before[52]?.status !== 'success' || after[52]?.status !== 'success'
    || before[58]?.output?.decision !== 'revise'
    || before[59]?.output?.manualDecisionRequired !== true
    || marker.failedReviewSha256 !== sceneCutRebindSha256(before[58].output)
    || marker.failedAcceptSha256 !== sceneCutRebindSha256(before[59].output)
    || marker.failedParentVideoUrl !== before[52].output?.url
    || marker.inheritedCertificateExecutionId !== parent.id
    || before[50].output?.repairBinding?.executionId !== parent.id
    || marker.inheritedCertificateSha256 !== sceneCutRebindSha256(before[50].output)
    || after[52].revision !== Number(before[52].revision ?? 0) + 1
    || after[52].node?.id !== before[52].node?.id
    || !isDeepStrictEqual(after[52].node, before[52].node)
    || after[52].routeInputOverrides !== undefined
    || after[52].inputs?.endImage !== undefined
    || marker.firstPendingIndex !== 53 || marker.firstPendingNodeId !== 'sanguo-media-request')
    fail('composite hop rewrote its parent, certificate, or rejected take')

  const certificate = verifySceneCutFrameApproval(before[50].output, root)
  const stagingVariant = marker.stagingVariant ?? 'standard'
  const { manifest, receipt, manifestSha256, receiptSha256 } =
    verifyCompositeForSourceBoundLineageSync(marker.planId, stagingVariant, root)
  const source = stagingVariant === 'a8b5' ? object(manifest.source) : manifest
  const stageReceiptSha256s = compositeStageReceiptHashes(marker.planId, root,
    stagingVariant, manifest)
  const take = object(after[52].output), compact = object(take.sourceBoundComposite)
  if ((stagingVariant === 'a8b5' ? source.recordId : source.sourceRecordId) !== parent.id
    || (stagingVariant === 'a8b5' ? source.resultMd5 : source.sourceResultMd5) !== parentResultMd5
    || source.approvedShotSha256 !== certificate.shotSha256
    || source.approvalSha256 !== marker.inheritedCertificateSha256
    || stagingVariant === 'standard' && source.rejectedVideo?.url !== before[52].output.url
    || stagingVariant === 'standard' && source.rejectedVideo?.sha256 !== marker.failedParentVideoSha256
    || stagingVariant === 'a8b5' && (receipt.sources?.phaseA?.acceptedFrameIndex !== 192
      || receipt.sources?.phaseB?.acceptedFrameIndex !== 120
      || receipt.seam?.phaseAFrameIndex !== 192
      || receipt.seam?.phaseBFirstFrameIndex !== 0
      || receipt.seam?.stitchedPhaseBStartFrameIndex !== 1)
    || marker.manifestSha256 !== manifestSha256 || marker.receiptSha256 !== receiptSha256
    || !isDeepStrictEqual(marker.stageReceiptSha256s, stageReceiptSha256s)
    || !isDeepStrictEqual(compact.stageReceiptSha256s, stageReceiptSha256s)
    || receipt.planId !== marker.planId || receipt.review?.seamVerdict !== 'accept'
    || receipt.review?.wholeShot !== 'pending-node58'
    || receipt.seam?.stitchedPhaseBStartFrameIndex !== 1
    || receipt.output?.url !== receipt.narration?.url
    || receipt.output?.sha256 !== receipt.narration?.sha256
    || marker.compositeVideoUrl !== receipt.narration?.url
    || marker.compositeVideoSha256 !== receipt.narration?.sha256
    || take.url !== receipt.narration?.url
    || take.model !== 'source-bound-composite-v1'
    || object(take.raw).wholeShotProviderTask !== null
    || object(object(take.raw).data).task_id !== undefined
    || take.raw?.sourceExecutionId !== parent.id
    || take.raw?.sourceResultMd5 !== parentResultMd5
    || take.raw?.manifestSha256 !== manifestSha256
    || take.raw?.receiptSha256 !== receiptSha256
    || take.narration?.url !== receipt.narration?.url
    || take.narration?.pictureUrl !== receipt.picture?.url
    || take.narration?.route !== 'independent-narration-v1'
    || take.narration?.compositionReceiptKey !== receipt.narration?.compositionReceiptKey
    || compact.planId !== marker.planId
    || (compact.stagingVariant ?? 'standard') !== stagingVariant
    || compact.wholeShotReview !== 'pending-node58'
    || marker.compositeTakeSha256 !== sceneCutRebindSha256(take)
    || object(take.params).sourceBoundComposite?.receiptSha256 !== receiptSha256
    || object(take.params).sceneCutFrameGate?.signature !== certificate.signature
    || object(take.params).sceneCutShot?.id !== 'scene-01'
    || object(take.params).endImage !== undefined
    || after[52].context?.video_take?.url !== take.url
    || after[52].context?.video_evidence !== undefined
    || after[52].context?.media_review !== undefined)
    fail('composite take is not the signed, newly narrated whole-shot artifact')
  validateSceneCutVideoPayment(take.params, root)
  if (!isDeepStrictEqual(after[52].inputs?.sourceBoundComposite,
    { planId: marker.planId, manifestSha256, receiptSha256 }))
    fail('node52 inputs do not name the exact composite receipt')

  if (!completed) {
    if (after.slice(53).some(run => run.status !== 'idle' || run.output !== undefined)
      || child.selectedNodeId !== 'sanguo-media-request')
      fail('new composite fork did not stop before whole-shot evidence')
  } else {
    const evidence = object(after[54]?.output), review = object(after[58]?.output)
    const accept = object(after[59]?.output), last = object(after[64]?.output)
    const acceptedReview = object(accept.visualReview)
    const tailEvidence = object(acceptedReview.endingStateEvidence)
    const first = object(evidence.sceneCutOutputFirstFrame)
    const transfer = object(evidence.independentNarrationTransfer)
    const isolation = object(transfer.sourceSpeechIsolation)
    if (after.slice(53, 65).some(run => !['success', 'skipped'].includes(run.status))
      || after.slice(65).some(run => run.status !== 'idle')
      || evidence.originalUrl !== take.url || evidence.sha256 !== receipt.narration.sha256
      || evidence.decoded !== true || Math.abs(Number(evidence.duration) - 13) > .5
      || evidence.lastFrameUrl !== evidence.frames?.at(-1)
      || first.status !== 'matched' || first.approvalSignature !== certificate.signature
      || first.outputVideoSha256 !== evidence.sha256
      || transfer.outputVideoSha256 !== evidence.sha256
      || isolation.status !== 'confirmed' || isolation.mode !== 'full-source-mute'
      || review.decision !== 'pass' || typeof review.endingState !== 'string'
      || !review.endingState.includes('张飞') || !review.endingState.includes('严颜')
      || accept.passed !== true || accept.manualDecisionRequired !== false
      || accept.qualityPolicy !== 'principle-v1'
      || object(accept.qualityReview).canProceed !== true
      || acceptedReview.passed !== true
      || typeof acceptedReview.endingState !== 'string'
      || !acceptedReview.endingState.includes('张飞')
      || !acceptedReview.endingState.includes('严颜')
      || tailEvidence.method !== 'actual-tail-image'
      || tailEvidence.frame !== evidence.lastFrameUrl
      || accept.originalUrl !== take.url || accept.sha256 !== evidence.sha256
      || object(accept.raw).url !== take.url
      || object(object(accept.raw).sourceBoundComposite).receiptSha256 !== receiptSha256
      || principleDurationTransitionIssue(before[44].output, accept) !== undefined
      || last.available !== true || last.url !== evidence.lastFrameUrl
      || last.source !== 'extracted-from-video')
      fail('composite whole shot has not passed the original media and tail gates')
  }
  return { sourceExecutionId: parent.id, sourceResultMd5: parentResultMd5,
    compositeExecutionId: child.id, planId: marker.planId,
    manifestSha256, receiptSha256,
    compositeVideoSha256: receipt.narration.sha256,
    inheritedCertificateExecutionId: parent.id,
    wholeShotAccepted: completed }
}
