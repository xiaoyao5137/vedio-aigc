import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { assertFreshA8B6BRetakeCompositeAncestry } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const signed = (value, name) => ({ value, sha256: hash(name) })

function ancestry() {
  const parentId = hash('parent A plan')
  const childId = hash('B-only plan')
  const parentApproval = hash('parent A approval')
  const AVideo = hash('accepted A video')
  const BVideo = hash('rejected B video')
  const targetUrl = '/generated/B-end-guide.jpg'
  const targetSha = hash('B end guide')
  const A = signed({ version: 'staged-a8b6-fresh-native-acceptance-v3',
    planId: parentId, phase: 'A', mediaSha256: hash('A media'),
    acceptedFrameSha256: hash('A actual native tail') }, 'A acceptance')
  const AMedia = signed({ videoSha256: AVideo }, 'A media')
  const parentBPlan = signed({ version: 'staged-a8b6-fresh-B-plan-v1',
    planId: parentId, manifestSha256: hash('parent manifest'),
    sourceA: { acceptanceSha256: A.sha256 },
    phaseBPreview: { requestSha256: hash('old B request') } }, 'old B plan')
  const parentBTask = signed({ planId: parentId, phase: 'B',
    taskId: 'old-B-task', requestSha256: hash('old B request') },
  'old B task')
  const parentBMedia = signed({ planId: parentId, phase: 'B',
    taskId: 'old-B-task', videoUrl: '/generated/old-B.mp4',
    videoSha256: BVideo }, 'old B media')
  const parentBRejection = { rejection: { planId: parentId,
    taskId: 'old-B-task', videoSha256: BVideo,
    failedChecks: { frontWristKnotRemainsVisibleThroughout: false },
    nextPaidPhaseBlocked: true },
  rejectionSha256: hash('old B rejection') }
  const parentManifest = signed({ version: 'staged-a8b6-fresh-A-plan-v2',
    planId: parentId, workflowApprovalSha256: parentApproval,
    source: { frameProvenanceVariant: 'a8b6-local-composite-v9' },
    narrationTracks: [], frozenIdentityPlates: [],
    imageReferenceProof: [], providerLock: {},
    compactTransport: { entries: [] }, phaseA: {},
    phaseAPreview: {}, retake: {},
    forbiddenSources: [{ kind: 'rejected-A-native-video',
      videoSha256: hash('old A video') }] }, 'parent manifest')
  const bRetake = {
    parentPlanId: parentId,
    parentManifestSha256: parentManifest.sha256,
    parentWorkflowApprovalSha256: parentApproval,
    parentAAcceptanceSha256: A.sha256,
    parentAMediaSha256: AMedia.sha256,
    parentAVideoSha256: AVideo,
    parentANativeTailSha256: A.value.acceptedFrameSha256,
    parentBPlanSha256: parentBPlan.sha256,
    parentBRequestSha256: hash('old B request'),
    parentBTaskId: parentBTask.value.taskId,
    parentBTaskSha256: parentBTask.sha256,
    parentBMediaSha256: parentBMedia.sha256,
    parentBVideoSha256: BVideo,
    parentBRejectionSha256: parentBRejection.rejectionSha256,
    targetSourceSha256: hash('B target source'),
    targetReviewSha256: hash('B target review'),
    targetEndFrameUrl: targetUrl,
    targetEndFrameSha256: targetSha,
    newBRequestSha256: hash('new B request'),
  }
  const child = { ...parentManifest.value,
    version: 'staged-a8b6-fresh-A-plan-v3', planId: childId,
    bRetake,
    forbiddenSources: [...parentManifest.value.forbiddenSources,
      { kind: 'rejected-B-native-video', url: parentBMedia.value.videoUrl,
        sha256: BVideo, taskId: parentBTask.value.taskId }],
    phaseBRetake: { providerSeconds: 6, nativeFps: 24,
      firstFrameRole: 'parent-accepted-A-native-tail',
      endFrame: { role: 'target-guide-only', url: targetUrl,
        sha256: targetSha,
        targetSourceReceiptSha256: bRetake.targetSourceSha256,
        targetReviewSha256: bRetake.targetReviewSha256 },
      sound: 'off' },
    phaseBRetakePreview: { requestSha256: bRetake.newBRequestSha256,
      imageTypes: ['reference', 'reference', 'first_frame', 'end_frame'] },
  }
  const manifest = signed(child, 'child manifest')
  const bApproval = { approval: {
    version: 'staged-a8b6-B-only-retake-approval-v1',
    planId: childId,
    parentPlanId: parentId,
    acceptedA: { acceptanceSha256: A.sha256 },
    failedB: { rejectionSha256: parentBRejection.rejectionSha256 } },
  approvalSha256: hash('B approval') }
  const targetSource = signed({
    version: 'staged-a8b6-B-retake-target-source-v1',
    parentPlanId: parentId,
    parentManifestSha256: parentManifest.sha256,
    acceptedA: { acceptanceSha256: A.sha256,
      videoSha256: AVideo },
    failedB: { planSha256: parentBPlan.sha256,
      videoSha256: BVideo },
    output: { url: targetUrl, sha256: targetSha },
    role: 'target-guide-only', nativeTailAcceptance: false,
  }, 'B target source')
  const targetReview = signed({
    version: 'staged-a8b6-B-retake-target-review-receipt-v1',
    parentPlanId: parentId,
    sourceReceiptSha256: targetSource.sha256,
    targetSha256: targetSha, verdict: 'accept',
  }, 'B target review')
  return { manifest, parentManifest, A, AMedia, parentBPlan,
    parentBTask, parentBMedia, parentBRejection, bApproval,
    targetSource, targetReview }
}

test('B-only child borrows only signed accepted A and rejects old B lineage', () => {
  assert.equal(assertFreshA8B6BRetakeCompositeAncestry(ancestry()), true)
  const changedA = ancestry()
  changedA.manifest.value.bRetake.parentAAcceptanceSha256 = hash('other A')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(changedA),
    /B-only child lost accepted A/)
  const changedB = ancestry()
  changedB.parentBRejection.rejection.failedChecks
    .frontWristKnotRemainsVisibleThroughout = true
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(changedB),
    /B-only child lost accepted A/)
  const reusedB = ancestry()
  reusedB.manifest.value.forbiddenSources.pop()
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(reusedB),
    /B-only child lost accepted A/)
  const wrongGuide = ancestry()
  wrongGuide.manifest.value.phaseBRetake.endFrame.sha256 = hash('other guide')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(wrongGuide),
    /B-only child lost accepted A/)
  const wrongReview = ancestry()
  wrongReview.targetReview.value.sourceReceiptSha256 = hash('other target')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(wrongReview),
    /B-only child lost accepted A/)
})

function secondBRetake() {
  const chain = ancestry()
  const firstTargetSource = structuredClone(chain.targetSource)
  const firstTargetReview = structuredClone(chain.targetReview)
  const parentId = chain.parentManifest.value.planId
  const previousId = hash('first B-only child')
  const previousVideo = hash('second rejected B video')
  const previousRequest = hash('second rejected B request')
  const previousTaskId = 'second-rejected-B-task'
  const previousManifest = signed(structuredClone({ ...chain.manifest.value,
    planId: previousId }), 'first B-only manifest')
  const previousApproval = { approval: {
    version: 'staged-a8b6-B-only-retake-approval-v1',
    planId: previousId, parentPlanId: parentId,
    acceptedA: { acceptanceSha256: chain.A.sha256 },
    failedB: { rejectionSha256:
      chain.parentBRejection.rejectionSha256 },
  }, approvalSha256: hash('first B-only approval') }
  const BPlan = signed({ version: 'staged-a8b6-fresh-B-plan-v1',
    planId: previousId, manifestSha256: previousManifest.sha256,
    sourceA: { sourcePlanId: parentId,
      acceptanceSha256: chain.A.sha256 },
    phaseBPreview: { requestSha256: previousRequest },
  }, 'first B-only B plan')
  const BTask = signed({ planId: previousId, phase: 'B',
    taskId: previousTaskId, requestSha256: previousRequest },
  'first B-only B task')
  const BMedia = signed({ planId: previousId, phase: 'B',
    taskId: previousTaskId, taskSha256: BTask.sha256,
    videoUrl: '/generated/second-rejected-B.mp4',
    videoSha256: previousVideo }, 'first B-only B media')
  const previousRejection = { rejection: {
    version: 'staged-a8b6-fresh-native-B-rejection-v2',
    planId: previousId, parentPlanId: parentId,
    parentBRejectionSha256: chain.parentBRejection.rejectionSha256,
    manifestSha256: previousManifest.sha256,
    childApprovalSha256: previousApproval.approvalSha256,
    phaseBPlanSha256: BPlan.sha256,
    taskId: previousTaskId, taskSha256: BTask.sha256,
    mediaSha256: BMedia.sha256, videoSha256: previousVideo,
    sourceA: { sourcePlanId: parentId,
      acceptanceSha256: chain.A.sha256 },
    failedChecks: { guardsContinueWithdrawalWithoutRegrab: false },
    checks: { frontWristKnotRemainsVisibleThroughout: true },
    nextPaidPhaseBlocked: true },
  rejectionSha256: hash('first B-only B rejection') }
  const previousChild = {
    planId: previousId,
    manifestSha256: previousManifest.sha256,
    approvalSha256: previousApproval.approvalSha256,
    phaseBPlanSha256: BPlan.sha256,
    requestSha256: previousRequest,
    taskId: previousTaskId,
    taskSha256: BTask.sha256,
    mediaSha256: BMedia.sha256,
    videoSha256: previousVideo,
    rejectionSha256: previousRejection.rejectionSha256,
  }
  chain.previousChild = { manifest: previousManifest,
    approval: previousApproval, BPlan, BTask, BMedia,
    firstTargetSource, firstTargetReview,
    rejection: previousRejection }
  chain.manifest.value.planId = hash('second B-only child')
  chain.manifest.value.bRetake.previousChild = previousChild
  chain.manifest.value.forbiddenSources.push({
    kind: 'rejected-B-native-video', url: BMedia.value.videoUrl,
    sha256: previousVideo, taskId: previousTaskId })
  chain.bApproval.approval.planId = chain.manifest.value.planId
  chain.bApproval.approval.version =
    'staged-a8b6-B-only-retake-approval-v2'
  chain.bApproval.approval.previousChild = previousChild
  chain.targetSource.value.version =
    'staged-a8b6-B-second-retake-target-source-v1'
  chain.targetSource.value.previousChildPlanId = previousId
  chain.targetSource.value.parentAAcceptanceSha256 = chain.A.sha256
  chain.targetSource.value.previousChildRejectionSha256 =
    previousRejection.rejectionSha256
  chain.targetSource.value.previousChildManifestSha256 =
    previousManifest.sha256
  chain.targetSource.value.previousChildMediaSha256 = BMedia.sha256
  chain.targetSource.value.previousChildVideoSha256 = previousVideo
  chain.targetSource.value.firstTargetSourceSha256 =
    previousManifest.value.bRetake.targetSourceSha256
  chain.targetSource.value.imageEdit = { references: [{
    sha256: previousManifest.value.bRetake.targetEndFrameSha256 }] }
  chain.targetSource.value.normalization = {
    candidateSha256: chain.manifest.value.bRetake.targetEndFrameSha256 }
  chain.targetReview.value.version =
    'staged-a8b6-B-second-retake-target-review-receipt-v1'
  chain.targetReview.value.parentPlanId = parentId
  chain.targetReview.value.previousChildPlanId = previousId
  chain.targetReview.value.previousChildRejectionSha256 =
    previousRejection.rejectionSha256
  return chain
}

test('second B-only child requires both signed rejections and both forbidden B videos', () => {
  assert.equal(assertFreshA8B6BRetakeCompositeAncestry(secondBRetake()), true)
  const missingPriorVideo = secondBRetake()
  missingPriorVideo.manifest.value.forbiddenSources.pop()
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(
    missingPriorVideo), /B-only child lost accepted A/)
  const unboundRejection = secondBRetake()
  unboundRejection.manifest.value.bRetake.previousChild.rejectionSha256 =
    hash('forged previous rejection')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(
    unboundRejection), /B-only child lost accepted A|previous rejected B/)
  const noRegrabFailure = secondBRetake()
  noRegrabFailure.previousChild.rejection.rejection.failedChecks
    .guardsContinueWithdrawalWithoutRegrab = true
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(
    noRegrabFailure), /previous rejected B/)
  const changedA = secondBRetake()
  changedA.previousChild.BPlan.value.sourceA.acceptanceSha256 = hash('new A')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(changedA),
    /previous rejected B/)
  const wrongTarget = secondBRetake()
  wrongTarget.targetSource.value.previousChildVideoSha256 =
    hash('old first B')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(wrongTarget),
    /B-only child lost accepted A/)
})

function thirdBRetake() {
  const chain = secondBRetake()
  const parentId = chain.parentManifest.value.planId
  const previousId = chain.manifest.value.planId
  const previousManifest = signed(structuredClone(chain.manifest.value),
    'second B-only manifest')
  const previousApproval = structuredClone(chain.bApproval)
  const previousRequest = hash('third rejected B request')
  const previousTaskId = 'third-rejected-B-task'
  const previousVideo = hash('third rejected B video')
  const lastFrameSha256 = hash('third rejected B native n144')
  const BPlan = signed({ version: 'staged-a8b6-fresh-B-plan-v1',
    planId: previousId, manifestSha256: previousManifest.sha256,
    sourceA: { sourcePlanId: parentId,
      acceptanceSha256: chain.A.sha256 },
    phaseBPreview: { requestSha256: previousRequest },
  }, 'second B-only B plan')
  const BTask = signed({ planId: previousId, phase: 'B',
    taskId: previousTaskId, requestSha256: previousRequest },
  'second B-only B task')
  const BMedia = signed({ planId: previousId, phase: 'B',
    taskId: previousTaskId, taskSha256: BTask.sha256,
    videoUrl: '/generated/third-rejected-B.mp4',
    videoSha256: previousVideo, nativeLastFrameIndex: 144 },
  'second B-only B media')
  const previousRejection = { rejection: {
    version: 'staged-a8b6-fresh-native-B-rejection-v2',
    planId: previousId, parentPlanId: parentId,
    parentBRejectionSha256: chain.parentBRejection.rejectionSha256,
    manifestSha256: previousManifest.sha256,
    childApprovalSha256: previousApproval.approvalSha256,
    phaseBPlanSha256: BPlan.sha256,
    taskId: previousTaskId, taskSha256: BTask.sha256,
    mediaSha256: BMedia.sha256, videoSha256: previousVideo,
    sourceA: { sourcePlanId: parentId,
      acceptanceSha256: chain.A.sha256 },
    failedChecks: { guardsContinueWithdrawalWithoutRegrab: false },
    checks: { frontWristKnotRemainsVisibleThroughout: true },
    nativeFrames: [{ frameIndex: 144, sha256: lastFrameSha256 }],
    nextPaidPhaseBlocked: true },
  rejectionSha256: hash('second B-only B rejection') }
  const previousChild = {
    planId: previousId,
    manifestSha256: previousManifest.sha256,
    approvalSha256: previousApproval.approvalSha256,
    phaseBPlanSha256: BPlan.sha256,
    requestSha256: previousRequest,
    taskId: previousTaskId,
    taskSha256: BTask.sha256,
    mediaSha256: BMedia.sha256,
    videoSha256: previousVideo,
    rejectionSha256: previousRejection.rejectionSha256,
  }
  chain.previousChild = { manifest: previousManifest,
    approval: previousApproval, BPlan, BTask, BMedia,
    firstTargetSource: structuredClone(chain.targetSource),
    firstTargetReview: structuredClone(chain.targetReview),
    previousChild: chain.previousChild,
    rejection: previousRejection }
  chain.manifest.value.planId = hash('third B-only child')
  chain.manifest.value.bRetake.previousChild = previousChild
  chain.manifest.value.bRetake.retakeOrdinal = 3
  chain.manifest.value.forbiddenSources.push({
    kind: 'rejected-B-native-video', url: BMedia.value.videoUrl,
    sha256: previousVideo, taskId: previousTaskId })
  chain.bApproval.approval.planId = chain.manifest.value.planId
  chain.bApproval.approval.version =
    'staged-a8b6-B-only-retake-approval-v3'
  chain.bApproval.approval.retakeOrdinal = 3
  chain.bApproval.approval.previousChild = previousChild
  chain.targetSource.value.version =
    'staged-a8b6-B-third-retake-target-source-v1'
  chain.targetSource.value.previousChildPlanId = previousId
  chain.targetSource.value.previousChildRejectionSha256 =
    previousRejection.rejectionSha256
  chain.targetSource.value.previousChildManifestSha256 =
    previousManifest.sha256
  chain.targetSource.value.previousChildMediaSha256 = BMedia.sha256
  chain.targetSource.value.previousChildVideoSha256 = previousVideo
  chain.targetSource.value.previousChildTargetSourceSha256 =
    previousManifest.value.bRetake.targetSourceSha256
  chain.targetSource.value.previousChildTargetReviewSha256 =
    previousManifest.value.bRetake.targetReviewSha256
  chain.targetSource.value.previousChildNativeLastFrameSha256 =
    lastFrameSha256
  chain.targetSource.value.imageEdit.references[1] = {
    sha256: lastFrameSha256 }
  chain.targetReview.value.version =
    'staged-a8b6-B-third-retake-target-review-receipt-v1'
  chain.targetReview.value.previousChildPlanId = previousId
  chain.targetReview.value.previousChildRejectionSha256 =
    previousRejection.rejectionSha256
  return chain
}

test('third B-only child preserves accepted A and all three rejected B sources', () => {
  assert.equal(assertFreshA8B6BRetakeCompositeAncestry(thirdBRetake()), true)
  const missingMiddle = thirdBRetake()
  missingMiddle.previousChild.previousChild.rejection.rejection
    .failedChecks.guardsContinueWithdrawalWithoutRegrab = true
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(missingMiddle),
    /previous rejected B/)
  const omittedVideo = thirdBRetake()
  omittedVideo.manifest.value.forbiddenSources.splice(-2, 1)
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(omittedVideo),
    /B-only child lost accepted A|previous rejected B/)
  const wrongLastFrame = thirdBRetake()
  wrongLastFrame.targetSource.value.previousChildNativeLastFrameSha256 =
    hash('wrong B2 tail')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(wrongLastFrame),
    /B-only child lost accepted A/)
  const wrongReference = thirdBRetake()
  wrongReference.targetSource.value.imageEdit.references[1].sha256 =
    hash('other source frame')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(wrongReference),
    /B-only child lost accepted A/)
  const changedA = thirdBRetake()
  changedA.previousChild.BPlan.value.sourceA.acceptanceSha256 = hash('new A')
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(changedA),
    /previous rejected B/)
  const wrongOrdinal = thirdBRetake()
  wrongOrdinal.bApproval.approval.retakeOrdinal = 2
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(wrongOrdinal),
    /B-only child lost accepted A/)
  const cycle = thirdBRetake()
  cycle.previousChild.previousChild = cycle.previousChild
  assert.throws(() => assertFreshA8B6BRetakeCompositeAncestry(cycle),
    /cycle|previous rejected B|B-only child lost accepted A/)
})
