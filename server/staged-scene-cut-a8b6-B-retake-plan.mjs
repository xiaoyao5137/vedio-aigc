/** Immutable B-only child plan. It references the parent's accepted A and
 * rejected B without copying, replacing, or charging for A again. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { previewFreshA8B6PhaseBRetake,
  previewFreshA8B6PhaseBSecondRetake,
  previewFreshA8B6PhaseBThirdRetake, readFreshA8B6PhaseAPlan,
  freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { selectFreshA8B6IdentityTransportEntries } from
  './staged-scene-cut-a8b6-fresh-phases.mjs'
import { extractFreshNativeJpeg } from
  './staged-scene-cut-a8b6-fresh-native.mjs'
import { verifyFreshA8B6BRetakeTargetSource,
  verifyFreshA8B6BRetakeTargetReview } from
  './staged-scene-cut-a8b6-B-retake-target.mjs'
import { readFreshA8B6BRetakeParentSigned } from
  './staged-scene-cut-a8b6-B-retake-parent.mjs'
import { verifyFreshA8B6PhaseBRejection } from
  './staged-scene-cut-a8b6-fresh-B-rejection.mjs'
import { verifyFreshA8B6BSecondRetakeTargetSource,
  verifyFreshA8B6BSecondRetakeTargetReview } from
  './staged-scene-cut-a8b6-B-second-retake-target.mjs'
import { verifyFreshA8B6BThirdRetakeTargetSource,
  verifyFreshA8B6BThirdRetakeTargetReview } from
  './staged-scene-cut-a8b6-B-third-retake-target.mjs'

const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_B_RETAKE_PLAN_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

export function assertFreshA8B6BRetakeAncestry({ parent, A, B, BPlan,
  BTask, rejection, guide, guideReview }) {
  if (parent?.version !== 'staged-a8b6-fresh-A-plan-v2'
    || !SHA.test(String(parent.planId))
    || A?.acceptance?.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || A.acceptance.acceptedFrameIndex !== 192
    || B?.media?.nativeLastFrameIndex !== 144
    || B.media.nativeLastPts !== 6
    || BTask?.task?.taskId !== B.media.taskId
    || BPlan?.plan?.sourceA?.acceptanceSha256 !== A.acceptanceSha256
    || BPlan.plan.sourceA.frameSha256
      !== A.acceptance.acceptedFrameSha256
    || rejection?.phase !== 'B'
    || rejection?.planId !== parent.planId
    || rejection?.taskId !== B.media.taskId
    || rejection?.videoSha256 !== B.media.videoSha256
    || rejection?.mediaSha256 !== B.mediaSha256
    || rejection?.taskSha256 !== BTask.taskSha256
    || rejection?.phaseBPlanSha256 !== BPlan.planSha256
    || rejection?.sourceA?.acceptanceSha256 !== A.acceptanceSha256
    || rejection?.failedChecks?.frontWristKnotRemainsVisibleThroughout
      !== false
    || guide?.parentPlanId !== parent.planId
    || guide.acceptedA.acceptanceSha256 !== A.acceptanceSha256
    || guide.acceptedA.nativeTailFrameSha256
      !== A.acceptance.acceptedFrameSha256
    || guide.failedB.mediaSha256 !== B.mediaSha256
    || guide.failedB.planSha256 !== BPlan.planSha256
    || guideReview?.sourceReceiptSha256 === undefined
    || guideReview.targetSha256 !== guide.output.sha256)
    fail('B-only child lacks exact accepted A, failed B or reviewed guide')
  return true
}

export async function planFreshA8B6PhaseBRetake(parentPlanId,
  root = process.cwd()) {
  if (!SHA.test(String(parentPlanId))) fail('parent plan ID invalid')
  const parentSigned = readFreshA8B6BRetakeParentSigned(parentPlanId, root)
  const { A, B, BPlan, BTask,
    rejection: rejected } = parentSigned
  const [target, targetReview] = await Promise.all([
    verifyFreshA8B6BRetakeTargetSource(parentPlanId, root),
    verifyFreshA8B6BRetakeTargetReview(parentPlanId, root),
  ])
  const parent = parentSigned.manifest
  assertFreshA8B6BRetakeAncestry({ parent, A, B, BPlan, BTask,
    rejection: rejected.rejection, guide: target.receipt,
    guideReview: targetReview.review })
  const identityEntries = selectFreshA8B6IdentityTransportEntries(
    parent.compactTransport)
  const [identity1, identity2, guideBytes] = await Promise.all([
    readFile(freshA8B6GeneratedFile(identityEntries[0].transport.url,
      'image', root)),
    readFile(freshA8B6GeneratedFile(identityEntries[1].transport.url,
      'image', root)),
    readFile(freshA8B6GeneratedFile(target.receipt.output.url,
      'image', root)),
  ])
  if (sha(identity1) !== identityEntries[0].transport.sha256
    || sha(identity2) !== identityEntries[1].transport.sha256
    || sha(guideBytes) !== target.receipt.output.sha256)
    fail('B retake identity or target guide bytes changed')
  const Afile = freshA8B6GeneratedFile(A.media.videoUrl, 'video', root)
  const tail = await extractFreshNativeJpeg(Afile,
    A.acceptance.acceptedFrameIndex)
  if (tail.sha256 !== A.acceptance.acceptedFrameSha256)
    fail('accepted A native tail changed')
  const preview = previewFreshA8B6PhaseBRetake(tail.bytes,
    [identity1, identity2], guideBytes)
  const bRetake = {
    parentPlanId, parentManifestSha256: parentSigned.manifestSha256,
    parentWorkflowApprovalSha256: parent.workflowApprovalSha256,
    parentAAcceptanceSha256: A.acceptanceSha256,
    parentAMediaSha256: A.mediaSha256,
    parentAVideoSha256: A.media.videoSha256,
    parentANativeTailSha256: A.acceptance.acceptedFrameSha256,
    parentBPlanSha256: BPlan.planSha256,
    parentBRequestSha256: BPlan.preview.requestSha256,
    parentBTaskId: B.media.taskId,
    parentBTaskSha256: BTask.taskSha256,
    parentBMediaSha256: B.mediaSha256,
    parentBVideoSha256: B.media.videoSha256,
    parentBRejectionSha256: rejected.rejectionSha256,
    targetSourceSha256: target.receiptSha256,
    targetReviewSha256: targetReview.reviewSha256,
    targetEndFrameUrl: target.receipt.output.url,
    targetEndFrameSha256: target.receipt.output.sha256,
    newBRequestSha256: preview.requestSha256,
  }
  if (parent.forbiddenSources?.some(item =>
    item.sha256 === B.media.videoSha256 || item.taskId === B.media.taskId))
    fail('failed B is already listed in parent forbidden sources')
  const body = { ...parent,
    version: 'staged-a8b6-fresh-A-plan-v3',
    forbiddenSources: [...parent.forbiddenSources,
      { kind: 'rejected-B-native-video',
        url: B.media.videoUrl,
        sha256: B.media.videoSha256,
        taskId: B.media.taskId }],
    bRetake,
    phaseBRetake: { providerSeconds: 6, nativeFps: 24,
      firstFrameRole: 'parent-accepted-A-native-tail',
      endFrame: { role: 'target-guide-only',
        url: target.receipt.output.url,
        sha256: target.receipt.output.sha256,
        targetSourceReceiptSha256: target.receiptSha256,
        targetReviewSha256: targetReview.reviewSha256 },
      sound: 'off', acceptance: 'pending-native-review' },
    phaseBRetakePreview: { ...preview, request: undefined },
    acceptanceState: 'B-retake-request-ready-only; parent A accepted; parent B rejected; new B pending',
  }
  const { signature: _signature, planId: _planId,
    workflowApprovalSha256: _approval, ...planBody } = body
  void _signature; void _planId; void _approval
  const planId = sha(canonical(planBody))
  if (isDeepStrictEqual(planId, parentPlanId)) fail('child plan identity reused')
  return { ...planBody, planId,
    workflowApprovalSha256: parent.workflowApprovalSha256 }
}

/** A second immutable B-only child after the first child was rejected. The
 * original parent A remains the sole accepted A and is never repaid. */
export async function planFreshA8B6PhaseBSecondRetake(
  previousChildPlanId, root = process.cwd()) {
  if (!SHA.test(String(previousChildPlanId)))
    fail('previous rejected B-only child ID invalid')
  const rejected = await verifyFreshA8B6PhaseBRejection(
    previousChildPlanId, root)
  const previous = rejected.rejection
  if (previous.version !== 'staged-a8b6-fresh-native-B-rejection-v2'
    || previous.failedChecks?.guardsContinueWithdrawalWithoutRegrab
      !== false
    || previous.checks?.frontWristKnotRemainsVisibleThroughout !== true
    || previous.nextPaidPhaseBlocked !== true)
    fail('previous child lacks signed guard-regrab rejection')
  const parentPlanId = previous.parentPlanId
  const signed = readFreshA8B6BRetakeParentSigned(parentPlanId, root)
  const { A, B, BPlan, BTask, manifest: parent,
    rejection: parentRejected } = signed
  const [target, targetReview] = await Promise.all([
    verifyFreshA8B6BSecondRetakeTargetSource(previousChildPlanId, root),
    verifyFreshA8B6BSecondRetakeTargetReview(previousChildPlanId, root),
  ])
  if (previous.sourceA?.acceptanceSha256 !== A.acceptanceSha256
    || previous.sourceA.frameSha256
      !== A.acceptance.acceptedFrameSha256
    || previous.parentBRejectionSha256
      !== parentRejected.rejectionSha256
    || target.receipt.parentPlanId !== parentPlanId
    || target.receipt.previousChildPlanId !== previousChildPlanId
    || target.receipt.previousChildRejectionSha256
      !== rejected.rejectionSha256
    || target.receipt.parentAAcceptanceSha256 !== A.acceptanceSha256
    || targetReview.review.sourceReceiptSha256 !== target.receiptSha256
    || targetReview.review.targetSha256 !== target.receipt.output.sha256)
    fail('second child lost accepted A, two rejected B takes or guide')
  const identityEntries = selectFreshA8B6IdentityTransportEntries(
    parent.compactTransport)
  const [identity1, identity2, guide] = await Promise.all([
    readFile(freshA8B6GeneratedFile(identityEntries[0].transport.url,
      'image', root)),
    readFile(freshA8B6GeneratedFile(identityEntries[1].transport.url,
      'image', root)),
    readFile(freshA8B6GeneratedFile(target.receipt.output.url,
      'image', root)),
  ])
  if (sha(identity1) !== identityEntries[0].transport.sha256
    || sha(identity2) !== identityEntries[1].transport.sha256
    || sha(guide) !== target.receipt.output.sha256)
    fail('second B request identity or new guide bytes changed')
  const tail = await extractFreshNativeJpeg(freshA8B6GeneratedFile(
    A.media.videoUrl, 'video', root),
  A.acceptance.acceptedFrameIndex)
  if (tail.sha256 !== A.acceptance.acceptedFrameSha256)
    fail('accepted A actual native tail changed')
  const preview = previewFreshA8B6PhaseBSecondRetake(tail.bytes,
    [identity1, identity2], guide)
  const previousChild = {
    planId: previousChildPlanId,
    manifestSha256: previous.manifestSha256,
    approvalSha256: previous.childApprovalSha256,
    phaseBPlanSha256: previous.phaseBPlanSha256,
    requestSha256: previous.requestSha256,
    taskId: previous.taskId,
    taskSha256: previous.taskSha256,
    mediaSha256: previous.mediaSha256,
    videoSha256: previous.videoSha256,
    rejectionSha256: rejected.rejectionSha256,
  }
  const bRetake = {
    parentPlanId, parentManifestSha256: signed.manifestSha256,
    parentWorkflowApprovalSha256: parent.workflowApprovalSha256,
    parentAAcceptanceSha256: A.acceptanceSha256,
    parentAMediaSha256: A.mediaSha256,
    parentAVideoSha256: A.media.videoSha256,
    parentANativeTailSha256: A.acceptance.acceptedFrameSha256,
    parentBPlanSha256: BPlan.planSha256,
    parentBRequestSha256: BPlan.preview.requestSha256,
    parentBTaskId: B.media.taskId,
    parentBTaskSha256: BTask.taskSha256,
    parentBMediaSha256: B.mediaSha256,
    parentBVideoSha256: B.media.videoSha256,
    parentBRejectionSha256: parentRejected.rejectionSha256,
    previousChild,
    targetSourceSha256: target.receiptSha256,
    targetReviewSha256: targetReview.reviewSha256,
    targetEndFrameUrl: target.receipt.output.url,
    targetEndFrameSha256: target.receipt.output.sha256,
    newBRequestSha256: preview.requestSha256,
  }
  const failedVideos = [
    { kind: 'rejected-B-native-video', url: B.media.videoUrl,
      sha256: B.media.videoSha256, taskId: B.media.taskId },
    { kind: 'rejected-B-native-video', url: previous.videoUrl,
      sha256: previous.videoSha256, taskId: previous.taskId },
  ]
  if (parent.forbiddenSources?.some(item => failedVideos.some(failed =>
    item.url === failed.url || item.sha256 === failed.sha256
      || item.taskId === failed.taskId)))
    fail('rejected B media unexpectedly already forbidden by parent')
  const body = { ...parent,
    version: 'staged-a8b6-fresh-A-plan-v3',
    forbiddenSources: [...parent.forbiddenSources, ...failedVideos],
    bRetake,
    phaseBRetake: { providerSeconds: 6, nativeFps: 24,
      firstFrameRole: 'parent-accepted-A-native-tail',
      endFrame: { role: 'target-guide-only',
        url: target.receipt.output.url,
        sha256: target.receipt.output.sha256,
        targetSourceReceiptSha256: target.receiptSha256,
        targetReviewSha256: targetReview.reviewSha256 },
      sound: 'off', acceptance: 'pending-native-review' },
    phaseBRetakePreview: { ...preview, request: undefined },
    acceptanceState: 'B-second-retake-request-ready-only; original A accepted; both prior B takes rejected; new B pending',
  }
  const { signature: _signature, planId: _planId,
    workflowApprovalSha256: _approval, ...planBody } = body
  void _signature; void _planId; void _approval
  const planId = sha(canonical(planBody))
  if (planId === previousChildPlanId || planId === parentPlanId)
    fail('second child reused a paid plan identity')
  return { ...planBody, planId,
    workflowApprovalSha256: parent.workflowApprovalSha256 }
}

/** A third B-only child. B2 remains rejected, B1 and the original B remain
 * forbidden, and the sole accepted A is reused by exact native-tail bytes. */
export async function planFreshA8B6PhaseBThirdRetake(
  previousChildPlanId, root = process.cwd()) {
  if (!SHA.test(String(previousChildPlanId)))
    fail('previous rejected B-only child ID invalid')
  const rejected = await verifyFreshA8B6PhaseBRejection(
    previousChildPlanId, root)
  const previous = rejected.rejection
  if (previous.version !== 'staged-a8b6-fresh-native-B-rejection-v2'
    || previous.failedChecks?.guardsContinueWithdrawalWithoutRegrab
      !== false
    || previous.checks?.frontWristKnotRemainsVisibleThroughout !== true
    || previous.nextPaidPhaseBlocked !== true)
    fail('B2 lacks signed guard-contact rejection')
  const { manifest: previousManifest,
    manifestSha256: previousManifestSha256 } =
    await readFreshA8B6PhaseAPlan(previousChildPlanId, root)
  if (previousManifest.version !== 'staged-a8b6-fresh-A-plan-v3'
    || !SHA.test(String(previousManifest.bRetake?.previousChild?.planId))
    || previousManifestSha256 !== previous.manifestSha256
    || previousManifest.bRetake.parentPlanId !== previous.parentPlanId)
    fail('previous child is not signed B2 ancestry')
  const parentPlanId = previous.parentPlanId
  const signed = readFreshA8B6BRetakeParentSigned(parentPlanId, root)
  const { A, B, BPlan, BTask, manifest: parent,
    rejection: parentRejected } = signed
  const [target, targetReview] = await Promise.all([
    verifyFreshA8B6BThirdRetakeTargetSource(previousChildPlanId, root),
    verifyFreshA8B6BThirdRetakeTargetReview(previousChildPlanId, root),
  ])
  if (previous.sourceA?.acceptanceSha256 !== A.acceptanceSha256
    || previous.sourceA.frameSha256
      !== A.acceptance.acceptedFrameSha256
    || previous.parentBRejectionSha256
      !== parentRejected.rejectionSha256
    || target.receipt.parentPlanId !== parentPlanId
    || target.receipt.previousChildPlanId !== previousChildPlanId
    || target.receipt.previousChildRejectionSha256
      !== rejected.rejectionSha256
    || target.receipt.previousChildManifestSha256
      !== previousManifestSha256
    || target.receipt.previousChildMediaSha256 !== previous.mediaSha256
    || target.receipt.previousChildVideoSha256 !== previous.videoSha256
    || target.receipt.previousChildTargetSourceSha256
      !== previousManifest.bRetake.targetSourceSha256
    || target.receipt.previousChildTargetReviewSha256
      !== previousManifest.bRetake.targetReviewSha256
    || target.receipt.parentAAcceptanceSha256 !== A.acceptanceSha256
    || targetReview.review.sourceReceiptSha256 !== target.receiptSha256
    || targetReview.review.targetSha256 !== target.receipt.output.sha256)
    fail('third child lost accepted A, rejected B2 or reviewed guide')
  const identityEntries = selectFreshA8B6IdentityTransportEntries(
    parent.compactTransport)
  const [identity1, identity2, guide] = await Promise.all([
    readFile(freshA8B6GeneratedFile(identityEntries[0].transport.url,
      'image', root)),
    readFile(freshA8B6GeneratedFile(identityEntries[1].transport.url,
      'image', root)),
    readFile(freshA8B6GeneratedFile(target.receipt.output.url,
      'image', root)),
  ])
  if (sha(identity1) !== identityEntries[0].transport.sha256
    || sha(identity2) !== identityEntries[1].transport.sha256
    || sha(guide) !== target.receipt.output.sha256)
    fail('third B request identity or new guide bytes changed')
  const tail = await extractFreshNativeJpeg(freshA8B6GeneratedFile(
    A.media.videoUrl, 'video', root), A.acceptance.acceptedFrameIndex)
  if (tail.sha256 !== A.acceptance.acceptedFrameSha256)
    fail('accepted A actual native tail changed')
  const preview = previewFreshA8B6PhaseBThirdRetake(tail.bytes,
    [identity1, identity2], guide)
  const previousChild = {
    planId: previousChildPlanId,
    manifestSha256: previous.manifestSha256,
    approvalSha256: previous.childApprovalSha256,
    phaseBPlanSha256: previous.phaseBPlanSha256,
    requestSha256: previous.requestSha256,
    taskId: previous.taskId,
    taskSha256: previous.taskSha256,
    mediaSha256: previous.mediaSha256,
    videoSha256: previous.videoSha256,
    rejectionSha256: rejected.rejectionSha256,
  }
  const bRetake = {
    retakeOrdinal: 3,
    parentPlanId, parentManifestSha256: signed.manifestSha256,
    parentWorkflowApprovalSha256: parent.workflowApprovalSha256,
    parentAAcceptanceSha256: A.acceptanceSha256,
    parentAMediaSha256: A.mediaSha256,
    parentAVideoSha256: A.media.videoSha256,
    parentANativeTailSha256: A.acceptance.acceptedFrameSha256,
    parentBPlanSha256: BPlan.planSha256,
    parentBRequestSha256: BPlan.preview.requestSha256,
    parentBTaskId: B.media.taskId,
    parentBTaskSha256: BTask.taskSha256,
    parentBMediaSha256: B.mediaSha256,
    parentBVideoSha256: B.media.videoSha256,
    parentBRejectionSha256: parentRejected.rejectionSha256,
    previousChild,
    targetSourceSha256: target.receiptSha256,
    targetReviewSha256: targetReview.reviewSha256,
    targetEndFrameUrl: target.receipt.output.url,
    targetEndFrameSha256: target.receipt.output.sha256,
    newBRequestSha256: preview.requestSha256,
  }
  const priorForbidden = previousManifest.forbiddenSources
  const rejectedVideo = { kind: 'rejected-B-native-video',
    url: previous.videoUrl, sha256: previous.videoSha256,
    taskId: previous.taskId }
  if (!Array.isArray(priorForbidden)
    || priorForbidden.length < 2
    || priorForbidden.some(item => item.url === rejectedVideo.url
      || item.sha256 === rejectedVideo.sha256
      || item.taskId === rejectedVideo.taskId))
    fail('B2 source is not uniquely pending in forbidden ancestry')
  const body = { ...previousManifest,
    forbiddenSources: [...priorForbidden, rejectedVideo],
    bRetake,
    phaseBRetake: { providerSeconds: 6, nativeFps: 24,
      firstFrameRole: 'parent-accepted-A-native-tail',
      endFrame: { role: 'target-guide-only',
        url: target.receipt.output.url,
        sha256: target.receipt.output.sha256,
        targetSourceReceiptSha256: target.receiptSha256,
        targetReviewSha256: targetReview.reviewSha256 },
      sound: 'off', acceptance: 'pending-native-review' },
    phaseBRetakePreview: { ...preview, request: undefined },
    acceptanceState: 'B-third-retake-request-ready-only; original A accepted; three prior B takes rejected; new B pending',
  }
  const { signature: _signature, planId: _planId,
    workflowApprovalSha256: _approval, ...planBody } = body
  void _signature; void _planId; void _approval
  const planId = sha(canonical(planBody))
  if (planId === previousChildPlanId || planId === parentPlanId)
    fail('third child reused a paid plan identity')
  return { ...planBody, planId,
    workflowApprovalSha256: parent.workflowApprovalSha256 }
}
