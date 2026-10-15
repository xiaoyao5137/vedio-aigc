/** New paid A8+B6 original-speed picture and original-three-TTS composite. */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { composeNarration } from './independent-narration.ts'
import { collectIndependentNarrationTransferEvidence } from
  './narration-transfer-evidence.ts'
import { inspectFreshNativeVideo, assertFreshA8B6FrameMapping } from
  './staged-scene-cut-a8b6-fresh-native.mjs'
import { readFreshA8B6PhaseAPlan, readFreshA8B6Artifact,
  saveFreshA8B6Artifact, saveFreshA8B6Bytes,
  freshA8B6GeneratedFile, assertFreshA8B6ImageReferenceProof,
  assertFreshA8B6DualOutputSource } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6Acceptance, readFreshA8B6PhaseBPlan } from
  './staged-scene-cut-a8b6-fresh-phases.mjs'
import { freshA8B6RequiredChecks } from
  './staged-scene-cut-a8b6-fresh-review.mjs'
import { assertFreshA8B6JpegReviewImagesV3,
  assertFreshA8B6PlaybackReportV3,
  freshA8B6FrameReviewPromptV3 } from
  './staged-scene-cut-a8b6-fresh-review-v3.mjs'
import { B3_FRAME_V4_RECOVERY,
  buildFreshA8B6ReviewEvidenceV4,
  freshA8B6FrameReviewPromptV4 } from
  './staged-scene-cut-a8b6-fresh-review-v4.mjs'
import { assertFreshA8B6PlaybackReportV4 } from
  './staged-scene-cut-a8b6-fresh-acceptance-v4.mjs'
import { verifyA8B6FreshWorkflowApprovalSync } from
  './staged-scene-cut-a8b6-fresh-approval.mjs'
import { verifyA8B6LocalWorkflowApprovalSync } from
  './staged-scene-cut-a8b6-local-approval.mjs'
import { verifyA8B6LocalWorkflowApprovalV2Sync } from
  './staged-scene-cut-a8b6-local-approval-v2.mjs'
import { verifyA8B6LocalWorkflowApprovalV3Sync } from
  './staged-scene-cut-a8b6-local-approval-v3.mjs'
import { verifyA8B6LocalWorkflowApprovalV5Sync } from
  './staged-scene-cut-a8b6-local-approval-v5.mjs'
import { verifyA8B6LocalWorkflowApprovalV6Sync } from
  './staged-scene-cut-a8b6-local-approval-v6.mjs'
import { verifyA8B6LocalWorkflowApprovalV7Sync } from
  './staged-scene-cut-a8b6-local-approval-v7.mjs'
import { verifyA8B6LocalWorkflowApprovalV8Sync } from
  './staged-scene-cut-a8b6-local-approval-v8.mjs'
import { verifyA8B6LocalWorkflowApprovalV9Sync } from
  './staged-scene-cut-a8b6-local-approval-v9.mjs'
import { verifyA8B6FreshARetakeApprovalSync } from
  './staged-scene-cut-a8b6-A-retake-approval.mjs'
import { verifyA8B6ARetakeTargetProvenanceAmendmentSync } from
  './staged-scene-cut-a8b6-A-retake-target-provenance-amendment.mjs'
import { verifyFreshA8B6BRetakeApprovalSync } from
  './staged-scene-cut-a8b6-B-retake-approval.mjs'
import { verifyFreshA8B6PhaseBRejectionSync } from
  './staged-scene-cut-a8b6-fresh-B-rejection.mjs'
import { assertFreshA8B6BRetakeGuideReview } from
  './staged-scene-cut-a8b6-B-retake-target.mjs'
import { assertFreshA8B6BSecondRetakeGuideReview } from
  './staged-scene-cut-a8b6-B-second-retake-target.mjs'
import { assertFreshA8B6BThirdRetakeGuideReview } from
  './staged-scene-cut-a8b6-B-third-retake-target.mjs'
import { verifyA8B6LocalCompositeSourceReceiptSync } from
  './staged-scene-cut-a8b6-local-composite-admission.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV2Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v2.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV3Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v3.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV5Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v5.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV6Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v6.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV7Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v7.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV8Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v8.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV9Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v9.mjs'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const SHA = /^[a-f0-9]{64}$/
const invalid = reason => { throw Error(`A8B6_FRESH_COMPOSITE_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

function v3AudioWitnessValid(audio, lastPts) {
  const witness = audio?.witness
  if (witness?.probe !== 'ffmpeg-static-all-streams-f32le-v1'
    || !Array.isArray(witness.streams)
    || !Number.isInteger(witness.probedStreamCount)
    || witness.probedStreamCount !== witness.streams.length
    || witness.probedStreamCount < 0
    || witness.probedStreamCount > 16) return false
  if (audio.status === 'no-audio-stream')
    return witness.probedStreamCount === 0
  if (audio.status !== 'decoded-silence'
    || witness.probedStreamCount === 0) return false
  return witness.streams.every((stream, index) =>
    stream.index === index
    && Number.isFinite(stream.decodedDurationSeconds)
    && stream.decodedDurationSeconds >= lastPts - 0.25
    && stream.decodedDurationSeconds <= lastPts + 0.75
    && Number.isInteger(stream.sampleCount)
    && stream.sampleCount > 0
    && SHA.test(String(stream.decodedSha256))
    && Number.isFinite(stream.maxAbsSample)
    && stream.maxAbsSample >= 0 && stream.maxAbsSample <= 1e-5)
}

/** All arguments with a `value` and `sha256` came from signed() above. The
 * async verifier additionally re-decodes the audio/video and checks DB model
 * output; this local lineage path must still bind the same v3 contracts. */
export function assertFreshA8B6CompositeReviewChainV3({ planId, phase,
  manifest, media, mediaSha256, acceptance, evidence, direct,
  v3Evidence, intent, submit, audio }) {
  const value = acceptance.value
  const original = evidence.value
  const reviewed = v3Evidence.value
  const watch = direct.value
  const model = value.frameModelReview
  const first = manifest.compactTransport?.entries?.find(entry =>
    entry.role === 'first_frame')
  const reference = original.frames?.[0]
  if (value.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || value.evidenceSha256 !== v3Evidence.sha256
    || value.directReview?.verdict !== 'accept'
    || value.directReview?.reportSha256 !== direct.sha256
    || value.directReview?.reviewerMethod
      !== 'agent-direct-normal-speed-watch'
    || value.directReview?.playbackRate !== 1
    || model?.verdict !== 'accept'
    || !/^model-run-[\w-]+$/.test(String(model.executionId))
    || !SHA.test(String(model.ledgerSha256))
    || !SHA.test(String(model.promptSha256))
    || value.audioIsolation?.verdict !== 'accept'
    || value.audioIsolation?.receiptSha256 !== audio.sha256
    || reviewed.version !== 'staged-a8b6-fresh-native-review-evidence-v3'
    || reviewed.planId !== planId || reviewed.phase !== phase
    || reviewed.taskId !== media.taskId
    || reviewed.videoSha256 !== media.videoSha256
    || reviewed.mediaSha256 !== mediaSha256
    || reviewed.nativeFrameDigestSha256
      !== media.nativeFrameDigestSha256
    || reviewed.priorV1EvidenceSha256 !== evidence.sha256
    || canonical(reviewed.frames) !== canonical(original.frames)
    || canonical(reviewed.reviewImages)
      !== canonical(original.reviewImages)
    || phase === 'A' && (reference?.kind
        !== 'approved-new-first-frame'
      || reference.phase !== 'CERT' || reference.frameIndex !== -1
      || reference.url !== first?.transport?.url
      || reference.sha256 !== first?.transport?.sha256
      || reference.sourceOriginal?.url !== first?.source?.url
      || reference.sourceOriginal?.sha256 !== first?.source?.sha256
      || reference.sourceOriginal?.sha256
        !== manifest.source.approvedFirstFrameSha256)
    || intent.value.version !== 'staged-a8b6-fresh-frame-model-intent-v3'
    || intent.value.planId !== planId || intent.value.phase !== phase
    || intent.value.videoSha256 !== media.videoSha256
    || intent.value.evidenceSha256 !== v3Evidence.sha256
    || intent.value.promptSha256 !== sha(
      freshA8B6FrameReviewPromptV3(phase, reviewed))
    || !/^[\w-]{3,128}$/.test(String(intent.value.modelId))
    || !String(intent.value.requestKey ?? '').startsWith(
      `staged-a8b6-fresh-frame-v3:${planId}:${phase}:${media.videoSha256}:`)
    || model.requestKey !== intent.value.requestKey
    || model.promptSha256 !== intent.value.promptSha256
    || submit.value.version !== 'staged-a8b6-fresh-frame-model-submit-v3'
    || submit.value.planId !== planId || submit.value.phase !== phase
    || submit.value.intentSha256 !== intent.sha256
    || submit.value.requestKey !== intent.value.requestKey
    || audio.value.version !== 'staged-a8b6-fresh-audio-isolation-v3'
    || audio.value.planId !== planId || audio.value.phase !== phase
    || audio.value.taskId !== media.taskId
    || audio.value.videoUrl !== media.videoUrl
    || audio.value.videoSha256 !== media.videoSha256
    || audio.value.mediaSha256 !== mediaSha256
    || audio.value.nativeFrameDigestSha256
      !== media.nativeFrameDigestSha256
    || !v3AudioWitnessValid(audio.value, media.nativeLastPts))
    invalid(`new paid ${phase} v3 independent proof changed`)
  assertFreshA8B6JpegReviewImagesV3(phase, reviewed, manifest)
  assertFreshA8B6PlaybackReportV3(watch, { planId, phase, media,
    mediaSha256, native: { frameDigestSha256:
      media.nativeFrameDigestSha256, lastPts: media.nativeLastPts },
    evidenceSha256: v3Evidence.sha256,
    model: { row: { id: model.executionId },
      ledgerSha256: model.ledgerSha256 },
    audioIsolationSha256: audio.sha256 })
  return true
}

/** Local-file verifier for the B3 clarification. The async acceptance reader
 * additionally rechecks both model ledgers and native bytes against the DB. */
export function assertFreshA8B6CompositeReviewChainV4({ planId, phase,
  manifest, media, mediaSha256, acceptance, evidence, direct,
  v3Evidence, v3Intent, v3Submit, v4Evidence, v4Intent, v4Submit,
  audio }) {
  const pinned = B3_FRAME_V4_RECOVERY
  const value = acceptance.value
  const prior = v4Evidence.value.priorV3
  const reviewed = v4Evidence.value
  const model = value.frameModelReview
  const audioReceipt = audio.value
  const expected = buildFreshA8B6ReviewEvidenceV4(
    v3Evidence.value, prior)
  const { signature: _signature, ...reviewBody } = reviewed
  void _signature
  if (planId !== pinned.planId || phase !== 'B'
    || manifest?.version !== 'staged-a8b6-fresh-A-plan-v3'
    || media.videoSha256 !== pinned.videoSha256
    || value.version !== 'staged-a8b6-fresh-native-acceptance-v4'
    || value.planId !== planId || value.phase !== phase
    || value.evidenceSha256 !== v4Evidence.sha256
    || canonical(value.priorV3) !== canonical(prior)
    || value.directReview?.verdict !== 'accept'
    || value.directReview?.reportSha256 !== direct.sha256
    || value.directReview?.reviewerMethod
      !== 'agent-direct-normal-speed-watch'
    || value.directReview?.playbackRate !== 1
    || model?.verdict !== 'accept'
    || !/^model-run-[\w-]+$/.test(String(model.executionId))
    || !SHA.test(String(model.ledgerSha256))
    || !SHA.test(String(model.promptSha256))
    || value.audioIsolation?.verdict !== 'accept'
    || value.audioIsolation?.receiptSha256 !== audio.sha256
    || v3Evidence.sha256 !== pinned.v3EvidenceSha256
    || v3Intent.sha256 !== pinned.v3IntentSha256
    || v3Submit.sha256 !== pinned.v3SubmitSha256
    || prior?.executionId !== pinned.v3ExecutionId
    || prior.ledgerSha256 !== pinned.v3LedgerSha256
    || prior.evidenceSha256 !== v3Evidence.sha256
    || prior.intentSha256 !== v3Intent.sha256
    || prior.submitSha256 !== v3Submit.sha256
    || !SHA.test(String(prior.reportSha256))
    || v3Evidence.value.version
      !== 'staged-a8b6-fresh-native-review-evidence-v3'
    || v3Evidence.value.planId !== planId
    || v3Evidence.value.phase !== phase
    || v3Evidence.value.priorV1EvidenceSha256 !== evidence.sha256
    || v3Evidence.value.taskId !== media.taskId
    || v3Evidence.value.mediaSha256 !== mediaSha256
    || v3Evidence.value.videoSha256 !== media.videoSha256
    || v3Evidence.value.nativeFrameDigestSha256
      !== media.nativeFrameDigestSha256
    || canonical(v3Evidence.value.frames)
      !== canonical(evidence.value.frames)
    || canonical(v3Evidence.value.reviewImages)
      !== canonical(evidence.value.reviewImages)
    || v3Intent.value.version !== 'staged-a8b6-fresh-frame-model-intent-v3'
    || v3Intent.value.planId !== planId
    || v3Intent.value.phase !== phase
    || v3Intent.value.videoSha256 !== media.videoSha256
    || v3Intent.value.evidenceSha256 !== v3Evidence.sha256
    || v3Intent.value.promptSha256
      !== sha(freshA8B6FrameReviewPromptV3(phase, v3Evidence.value))
    || !String(v3Intent.value.requestKey ?? '').startsWith(
      `staged-a8b6-fresh-frame-v3:${planId}:B:${media.videoSha256}:`)
    || v3Submit.value.version !== 'staged-a8b6-fresh-frame-model-submit-v3'
    || v3Submit.value.planId !== planId
    || v3Submit.value.phase !== phase
    || v3Submit.value.intentSha256 !== v3Intent.sha256
    || v3Submit.value.requestKey !== v3Intent.value.requestKey
    || canonical(reviewBody) !== canonical(expected)
    || v4Intent.value.version
      !== 'staged-a8b6-fresh-frame-model-intent-v4'
    || v4Intent.value.planId !== planId
    || v4Intent.value.phase !== phase
    || v4Intent.value.videoSha256 !== media.videoSha256
    || v4Intent.value.evidenceSha256 !== v4Evidence.sha256
    || canonical(v4Intent.value.priorV3) !== canonical(prior)
    || v4Intent.value.promptSha256
      !== sha(freshA8B6FrameReviewPromptV4(reviewed))
    || !/^[\w-]{3,128}$/.test(String(v4Intent.value.modelId))
    || !String(v4Intent.value.requestKey ?? '').startsWith(
      `staged-a8b6-fresh-frame-v4:${planId}:B:${media.videoSha256}:`)
    || model.requestKey !== v4Intent.value.requestKey
    || model.promptSha256 !== v4Intent.value.promptSha256
    || v4Submit.value.version
      !== 'staged-a8b6-fresh-frame-model-submit-v4'
    || v4Submit.value.planId !== planId
    || v4Submit.value.phase !== phase
    || v4Submit.value.intentSha256 !== v4Intent.sha256
    || v4Submit.value.requestKey !== v4Intent.value.requestKey
    || audioReceipt.version !== 'staged-a8b6-fresh-audio-isolation-v3'
    || audioReceipt.planId !== planId
    || audioReceipt.phase !== phase
    || audioReceipt.taskId !== media.taskId
    || audioReceipt.videoUrl !== media.videoUrl
    || audioReceipt.videoSha256 !== media.videoSha256
    || audioReceipt.mediaSha256 !== mediaSha256
    || audioReceipt.nativeFrameDigestSha256
      !== media.nativeFrameDigestSha256
    || !v3AudioWitnessValid(audioReceipt, media.nativeLastPts))
    invalid('B3 v4 native clarification, 1x watch or audio chain changed')
  assertFreshA8B6JpegReviewImagesV3(phase, v3Evidence.value, manifest)
  assertFreshA8B6PlaybackReportV4(direct.value, {
    planId, phase, media, mediaSha256,
    native: { frameDigestSha256: media.nativeFrameDigestSha256,
      lastPts: media.nativeLastPts },
    evidenceSha256: v4Evidence.sha256,
    model: { row: { id: model.executionId },
      ledgerSha256: model.ledgerSha256 },
    audioIsolationSha256: audio.sha256 })
  return true
}

const localV2Provenance = manifest => manifest?.source?.frameProvenanceVariant
  === 'a8b6-local-composite-v2'
const localV3Provenance = manifest => manifest?.source?.frameProvenanceVariant
  === 'a8b6-local-composite-v3'
const localV5Provenance = manifest => manifest?.source?.frameProvenanceVariant
  === 'a8b6-local-composite-v5'
const localV6Provenance = manifest => manifest?.source?.frameProvenanceVariant
  === 'a8b6-local-composite-v6'
const localV7Provenance = manifest => manifest?.source?.frameProvenanceVariant
  === 'a8b6-local-composite-v7'
const localV8Provenance = manifest => manifest?.source?.frameProvenanceVariant
  === 'a8b6-local-composite-v8'
const localV9Provenance = manifest => manifest?.source?.frameProvenanceVariant
  === 'a8b6-local-composite-v9'
const retakeV2Plan = manifest => manifest?.version
  === 'staged-a8b6-fresh-A-plan-v2'
const bRetakeV3Plan = manifest => manifest?.version
  === 'staged-a8b6-fresh-A-plan-v3'
const retakeAPlan = manifest => retakeV2Plan(manifest)
  || bRetakeV3Plan(manifest)
function assertBOnlyChildHasNoPaidA(planId, root) {
  const directory = path.join(root, '.runtime/staged-scene-cut-a8b6-fresh',
    planId)
  if (['phase-A-plan.json', 'phase-A-submit-intent.json',
    'phase-A-task.json', 'phase-A-media.json',
    'phase-A-review-evidence.json', 'phase-A-manual-review.json',
    'phase-A-acceptance.json'].some(name => existsSync(path.join(directory,
      name))))
    invalid('B-only child contains a second paid A artifact')
}
/** A's target image only constrains generation. It cannot certify any native
 * frame, which is always taken from the archived provider video below. */
export function assertFreshA8B6EndGuidePlan(manifest) {
  if (!retakeAPlan(manifest)) {
    if (manifest?.version !== 'staged-a8b6-fresh-A-plan-v1'
      || manifest.phaseA?.endFrame !== null)
      invalid('A plan version or end guide changed')
    return null
  }
  const guide = manifest.phaseA?.endFrame
  const entries = manifest.compactTransport?.entries
  const retake = manifest.retake
  const hashes = ['parentPlanId', 'parentManifestSha256',
    'parentWorkflowApprovalSha256', 'parentTaskSha256',
    'parentRequestSha256', 'parentVideoSha256',
    'parentMediaReceiptSha256', 'parentRejectionSha256',
    'targetSourceReceiptSha256', 'targetReviewSha256',
    'targetPromptAmendmentSha256']
  if (!localV9Provenance(manifest)
    || !retake || hashes.some(field => !SHA.test(String(retake[field])))
    || retake.parentPlanId === manifest.planId
    || !/^[\w-]{8,128}$/.test(String(retake.parentTaskId))
    || guide?.role !== 'target-guide-only'
    || !/^\/generated\/[\w.-]+\.png$/.test(String(guide.url))
    || !SHA.test(String(guide.sha256))
    || guide.targetSourceReceiptSha256
      !== retake.targetSourceReceiptSha256
    || guide.targetReviewSha256 !== retake.targetReviewSha256
    || guide.targetPromptAmendmentSha256
      !== retake.targetPromptAmendmentSha256
    || !Array.isArray(entries) || entries.length !== 4
    || entries.map(entry => entry?.role).join(',')
      !== 'first_frame,identity_1,identity_2,end_frame'
    || entries[3]?.source?.url !== guide.url
    || entries[3]?.source?.sha256 !== guide.sha256
    || !SHA.test(String(entries[3]?.transport?.sha256))
    || manifest.phaseAPreview?.endFrameTransportSha256
      !== entries[3]?.transport?.sha256
    || canonical(manifest.phaseAPreview?.imageTypes)
      !== canonical(['reference', 'reference', 'first_frame', 'end_frame'])
    || !Array.isArray(manifest.forbiddenSources)
    || !manifest.forbiddenSources.some(item =>
      item.sha256 === retake.parentVideoSha256
      && item.taskId === retake.parentTaskId
      && item.url === `/generated/fresh-a8b6-${retake.parentPlanId.slice(0, 16)}-A-${retake.parentTaskId}.mp4`))
    invalid('retake target guide, rejected parent or four-image request changed')
  return guide
}

/** A B-only child may borrow the accepted A, but its failed B remains
 * rejected. Each borrowed artifact is independently HMAC-verified upstream. */
export function assertFreshA8B6BRetakeCompositeAncestry({ manifest,
  parentManifest, A, AMedia, parentBPlan, parentBTask, parentBMedia,
  parentBRejection, previousChild, bApproval, targetSource, targetReview },
seen = new Set()) {
  const child = manifest.value, parent = parentManifest.value
  if (seen.has(child.planId)) invalid('B-only child ancestry contains a cycle')
  seen.add(child.planId)
  const b = child.bRetake, rejection = parentBRejection.rejection
  const previous = b?.previousChild
  const previousSigned = previousChild !== undefined
  const forbidden = child.forbiddenSources
  const parentForbiddenCount = parent.forbiddenSources?.length
  const thirdRetake = Boolean(previousChild?.manifest?.value?.bRetake
    ?.previousChild)
  const expectedApprovalVersion = thirdRetake
    ? 'staged-a8b6-B-only-retake-approval-v3'
    : previous ? 'staged-a8b6-B-only-retake-approval-v2'
      : 'staged-a8b6-B-only-retake-approval-v1'
  const previousNativeLastFrameSha256 = previousChild?.rejection
    ?.rejection?.nativeFrames?.find(frame => frame.frameIndex
      === previousChild?.BMedia?.value?.nativeLastFrameIndex)?.sha256
  const targetValid = previous ? targetSource?.value?.version
    === (thirdRetake
      ? 'staged-a8b6-B-third-retake-target-source-v1'
      : 'staged-a8b6-B-second-retake-target-source-v1')
      && targetSource.value.parentPlanId === parent.planId
      && targetSource.value.previousChildPlanId === previous.planId
      && targetSource.value.parentAAcceptanceSha256 === A.sha256
      && targetSource.value.previousChildRejectionSha256
        === previous.rejectionSha256
      && targetSource.value.previousChildManifestSha256
        === previous.manifestSha256
      && targetSource.value.previousChildMediaSha256
        === previous.mediaSha256
      && targetSource.value.previousChildVideoSha256
        === previous.videoSha256
      && (thirdRetake
        ? targetSource.value.previousChildTargetSourceSha256
          === previousChild?.manifest?.value?.bRetake?.targetSourceSha256
          && targetSource.value.previousChildTargetReviewSha256
            === previousChild?.manifest?.value?.bRetake?.targetReviewSha256
          && SHA.test(String(previousNativeLastFrameSha256))
          && targetSource.value.previousChildNativeLastFrameSha256
            === previousNativeLastFrameSha256
          && targetSource.value.imageEdit?.references?.[1]?.sha256
            === previousNativeLastFrameSha256
        : targetSource.value.firstTargetSourceSha256
          === previousChild?.manifest?.value?.bRetake?.targetSourceSha256
          && targetSource.value.imageEdit?.references?.[0]?.sha256
            === previousChild?.manifest?.value?.bRetake?.targetEndFrameSha256)
      && targetSource.value.normalization?.candidateSha256
        === b.targetEndFrameSha256
      && targetSource.value.output?.url === b.targetEndFrameUrl
      && targetSource.value.output.sha256 === b.targetEndFrameSha256
      && targetSource.value.role === 'target-guide-only'
      && targetSource.value.nativeTailAcceptance === false
      && targetReview?.value?.version
        === (thirdRetake
          ? 'staged-a8b6-B-third-retake-target-review-receipt-v1'
          : 'staged-a8b6-B-second-retake-target-review-receipt-v1')
      && targetReview.value.parentPlanId === parent.planId
      && targetReview.value.previousChildPlanId === previous.planId
      && targetReview.value.previousChildRejectionSha256
        === previous.rejectionSha256
      && targetReview.value.sourceReceiptSha256 === targetSource.sha256
      && targetReview.value.targetSha256 === b.targetEndFrameSha256
      && targetReview.value.verdict === 'accept'
    : targetSource?.value?.version === 'staged-a8b6-B-retake-target-source-v1'
      && targetSource.value.parentPlanId === parent.planId
      && targetSource.value.parentManifestSha256
        === parentManifest.sha256
      && targetSource.value.acceptedA?.acceptanceSha256 === A.sha256
      && targetSource.value.acceptedA.videoSha256
        === AMedia.value.videoSha256
      && targetSource.value.failedB?.planSha256 === parentBPlan.sha256
      && targetSource.value.failedB.videoSha256
        === parentBMedia.value.videoSha256
      && targetSource.value.output?.url === b.targetEndFrameUrl
      && targetSource.value.output.sha256 === b.targetEndFrameSha256
      && targetSource.value.role === 'target-guide-only'
      && targetSource.value.nativeTailAcceptance === false
      && targetReview?.value?.version
        === 'staged-a8b6-B-retake-target-review-receipt-v1'
      && targetReview.value.parentPlanId === parent.planId
      && targetReview.value.sourceReceiptSha256 === targetSource.sha256
      && targetReview.value.targetSha256 === b.targetEndFrameSha256
      && targetReview.value.verdict === 'accept'
  const sourceKeys = ['source', 'narrationTracks', 'frozenIdentityPlates',
    'imageReferenceProof', 'providerLock', 'compactTransport',
    'phaseA', 'phaseAPreview', 'retake']
  if (child.version !== 'staged-a8b6-fresh-A-plan-v3'
    || parent.version !== 'staged-a8b6-fresh-A-plan-v2'
    || !b || b.parentPlanId !== parent.planId
    || b.parentManifestSha256 !== parentManifest.sha256
    || b.parentWorkflowApprovalSha256
      !== parent.workflowApprovalSha256
    || child.workflowApprovalSha256
      !== parent.workflowApprovalSha256
    || sourceKeys.some(key => canonical(child[key])
      !== canonical(parent[key]))
    || (thirdRetake ? b.retakeOrdinal !== 3
      : b.retakeOrdinal !== undefined)
    || canonical(forbidden?.slice(0, parentForbiddenCount))
      !== canonical(parent.forbiddenSources)
    || Boolean(previous) !== previousSigned
    || forbidden?.length !== (previous
      ? previousChild.manifest?.value?.forbiddenSources?.length + 1
      : parentForbiddenCount + 1)
    || forbidden[parentForbiddenCount]?.kind
      !== 'rejected-B-native-video'
    || forbidden[parentForbiddenCount].url
      !== parentBMedia.value.videoUrl
    || forbidden[parentForbiddenCount].sha256
      !== parentBMedia.value.videoSha256
    || forbidden[parentForbiddenCount].taskId
      !== parentBTask.value.taskId
    || A.value.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || A.value.planId !== parent.planId || A.value.phase !== 'A'
    || b.parentAAcceptanceSha256 !== A.sha256
    || b.parentAMediaSha256 !== AMedia.sha256
    || b.parentAVideoSha256 !== AMedia.value.videoSha256
    || A.value.mediaSha256 !== AMedia.sha256
    || b.parentANativeTailSha256
      !== A.value.acceptedFrameSha256
    || parentBPlan.value.version !== 'staged-a8b6-fresh-B-plan-v1'
    || parentBPlan.value.planId !== parent.planId
    || parentBPlan.value.manifestSha256 !== parentManifest.sha256
    || parentBPlan.value.sourceA?.acceptanceSha256 !== A.sha256
    || b.parentBPlanSha256 !== parentBPlan.sha256
    || b.parentBRequestSha256
      !== parentBPlan.value.phaseBPreview?.requestSha256
    || parentBTask.value.planId !== parent.planId
    || parentBTask.value.phase !== 'B'
    || b.parentBTaskId !== parentBTask.value.taskId
    || b.parentBTaskSha256 !== parentBTask.sha256
    || parentBTask.value.requestSha256
      !== b.parentBRequestSha256
    || parentBMedia.value.planId !== parent.planId
    || parentBMedia.value.phase !== 'B'
    || parentBMedia.value.taskId !== parentBTask.value.taskId
    || b.parentBMediaSha256 !== parentBMedia.sha256
    || b.parentBVideoSha256 !== parentBMedia.value.videoSha256
    || b.parentBRejectionSha256
      !== parentBRejection.rejectionSha256
    || rejection.planId !== parent.planId
    || rejection.taskId !== parentBTask.value.taskId
    || rejection.videoSha256 !== parentBMedia.value.videoSha256
    || rejection.failedChecks?.frontWristKnotRemainsVisibleThroughout
      !== false
    || rejection.nextPaidPhaseBlocked !== true
    || child.phaseBRetake?.providerSeconds !== 6
    || child.phaseBRetake.nativeFps !== 24
    || child.phaseBRetake.firstFrameRole
      !== 'parent-accepted-A-native-tail'
    || child.phaseBRetake.sound !== 'off'
    || child.phaseBRetake.endFrame?.role !== 'target-guide-only'
    || child.phaseBRetake.endFrame.url
      !== b.targetEndFrameUrl
    || child.phaseBRetake.endFrame.sha256
      !== b.targetEndFrameSha256
    || child.phaseBRetake.endFrame.targetSourceReceiptSha256
      !== b.targetSourceSha256
    || child.phaseBRetake.endFrame.targetReviewSha256
      !== b.targetReviewSha256
    || child.phaseBRetakePreview?.requestSha256
      !== b.newBRequestSha256
    || canonical(child.phaseBRetakePreview?.imageTypes)
      !== canonical(['reference', 'reference', 'first_frame', 'end_frame'])
    || bApproval.approval?.planId !== child.planId
    || bApproval.approval?.version !== expectedApprovalVersion
    || (thirdRetake ? bApproval.approval.retakeOrdinal !== 3
      : bApproval.approval.retakeOrdinal !== undefined)
    || bApproval.approval?.parentPlanId !== parent.planId
    || bApproval.approval?.acceptedA?.acceptanceSha256 !== A.sha256
    || bApproval.approval?.failedB?.rejectionSha256
      !== parentBRejection.rejectionSha256
    || canonical(bApproval.approval?.previousChild ?? null)
      !== canonical(previous ?? null)
    || targetSource?.sha256 !== b.targetSourceSha256
    || targetReview?.sha256 !== b.targetReviewSha256
    || !targetValid)
    invalid('B-only child lost accepted A, rejected B or target ancestry')
  if (previous) {
    const { manifest: previousManifest, approval: previousApproval,
      BPlan, BTask, BMedia, rejection: previousRejection,
      firstTargetSource, firstTargetReview,
      previousChild: earlierChild } = previousChild
    const previousBody = previousManifest?.value
    const previousB = previousBody?.bRetake
    const rejected = previousRejection?.rejection
    if (!SHA.test(String(previous.planId))
      || previous.planId === child.planId
      || previous.planId === parent.planId
      || previousManifest?.sha256 !== previous.manifestSha256
      || previousBody?.version !== 'staged-a8b6-fresh-A-plan-v3'
      || previousBody.planId !== previous.planId
      || previousB?.parentPlanId !== parent.planId
      || previousB.parentManifestSha256 !== parentManifest.sha256
      || previousB.parentAAcceptanceSha256 !== A.sha256
      || previousB.parentBRejectionSha256
        !== parentBRejection.rejectionSha256
      || firstTargetSource?.sha256 !== previousB.targetSourceSha256
      || firstTargetSource.value.output?.sha256
        !== previousB.targetEndFrameSha256
      || sourceKeys.some(key => canonical(previousBody[key])
        !== canonical(parent[key]))
      || canonical(previousBody.forbiddenSources)
        !== canonical(forbidden.slice(0, -1))
      || previousApproval?.approvalSha256 !== previous.approvalSha256
      || previousApproval.approval?.planId !== previous.planId
      || previousApproval.approval?.parentPlanId !== parent.planId
      || previousApproval.approval?.acceptedA?.acceptanceSha256 !== A.sha256
      || previousApproval.approval?.failedB?.rejectionSha256
        !== parentBRejection.rejectionSha256
      || BPlan?.sha256 !== previous.phaseBPlanSha256
      || BPlan.value.planId !== previous.planId
      || BPlan.value.manifestSha256 !== previousManifest.sha256
      || BPlan.value.sourceA?.sourcePlanId !== parent.planId
      || BPlan.value.sourceA.acceptanceSha256 !== A.sha256
      || BPlan.value.phaseBPreview?.requestSha256
        !== previous.requestSha256
      || BTask?.sha256 !== previous.taskSha256
      || BTask.value.planId !== previous.planId
      || BTask.value.phase !== 'B'
      || BTask.value.taskId !== previous.taskId
      || BTask.value.requestSha256 !== previous.requestSha256
      || BMedia?.sha256 !== previous.mediaSha256
      || BMedia.value.planId !== previous.planId
      || BMedia.value.phase !== 'B'
      || BMedia.value.taskId !== previous.taskId
      || BMedia.value.taskSha256 !== BTask.sha256
      || BMedia.value.videoSha256 !== previous.videoSha256
      || previousRejection?.rejectionSha256 !== previous.rejectionSha256
      || rejected?.version !== 'staged-a8b6-fresh-native-B-rejection-v2'
      || rejected.planId !== previous.planId
      || rejected.parentPlanId !== parent.planId
      || rejected.parentBRejectionSha256
        !== parentBRejection.rejectionSha256
      || rejected.manifestSha256 !== previousManifest.sha256
      || rejected.childApprovalSha256 !== previousApproval.approvalSha256
      || rejected.phaseBPlanSha256 !== BPlan.sha256
      || rejected.taskId !== BTask.value.taskId
      || rejected.taskSha256 !== BTask.sha256
      || rejected.mediaSha256 !== BMedia.sha256
      || rejected.videoSha256 !== BMedia.value.videoSha256
      || rejected.sourceA?.sourcePlanId !== parent.planId
      || rejected.sourceA.acceptanceSha256 !== A.sha256
      || !Object.values(rejected.failedChecks ?? {}).includes(false)
      || rejected.nextPaidPhaseBlocked !== true
      || forbidden[forbidden.length - 1]?.kind
        !== 'rejected-B-native-video'
      || forbidden[forbidden.length - 1].url !== BMedia.value.videoUrl
      || forbidden[forbidden.length - 1].sha256
        !== BMedia.value.videoSha256
      || forbidden[forbidden.length - 1].taskId
        !== BTask.value.taskId)
      invalid('B-only child lost a previous rejected B or reused its media')
    assertFreshA8B6BRetakeCompositeAncestry({
      manifest: previousManifest, parentManifest, A, AMedia,
      parentBPlan, parentBTask, parentBMedia, parentBRejection,
      previousChild: earlierChild, bApproval: previousApproval,
      targetSource: firstTargetSource, targetReview: firstTargetReview,
    }, seen)
  }
  return true
}

function assertFreshA8B6BRetakeTargetEvidenceSync(source, review, root) {
  const contracts = {
    'staged-a8b6-B-retake-target-source-v1': {
      reviewVersion: 'staged-a8b6-B-retake-target-review-receipt-v1',
      reportPath: 'qa/staged-scene-cut/v9-B-retake-target-review.json',
      assertReview: assertFreshA8B6BRetakeGuideReview },
    'staged-a8b6-B-second-retake-target-source-v1': {
      reviewVersion: 'staged-a8b6-B-second-retake-target-review-receipt-v1',
      reportPath: 'qa/staged-scene-cut/v9-B-second-retake-target-review.json',
      assertReview: assertFreshA8B6BSecondRetakeGuideReview },
    'staged-a8b6-B-third-retake-target-source-v1': {
      reviewVersion: 'staged-a8b6-B-third-retake-target-review-receipt-v1',
      reportPath: 'qa/staged-scene-cut/v9-B-third-retake-target-review.json',
      assertReview: assertFreshA8B6BThirdRetakeGuideReview },
  }
  const contract = contracts[source.value.version]
  if (!contract || review.value.version !== contract.reviewVersion
    || review.value.reportPath !== contract.reportPath
    || review.value.sourceReceiptSha256 !== source.sha256)
    invalid('B-only target signed review contract changed')
  const reportBytes = readFileSync(path.join(root, review.value.reportPath))
  if (sha(reportBytes) !== review.value.reportSha256)
    invalid('B-only target direct review bytes changed')
  const report = JSON.parse(reportBytes.toString())
  contract.assertReview(report, source.value, source.sha256)
}
const localProvenance = manifest => [
  'a8b6-local-composite-v1', 'a8b6-local-composite-v2',
  'a8b6-local-composite-v3', 'a8b6-local-composite-v5',
  'a8b6-local-composite-v6', 'a8b6-local-composite-v7',
  'a8b6-local-composite-v8', 'a8b6-local-composite-v9',
].includes(manifest?.source?.frameProvenanceVariant)
const workflowApprovalReceipt = manifest => {
  if (manifest?.source?.frameProvenanceVariant !== undefined
    && !localProvenance(manifest))
    invalid('first-frame provenance variant is unknown')
  return localProvenance(manifest)
  ? { approvalSha256: manifest.workflowApprovalSha256,
    amendedShotSha256: manifest.source.approvedShotSha256,
    localCompositeSourceReceiptSha256:
      manifest.source.localCompositeSourceReceiptSha256,
    localCompositeAlgorithmSha256:
      manifest.source.localCompositeAlgorithmSha256,
    ...(localV2Provenance(manifest) ? {
      frameProvenanceVariant: 'a8b6-local-composite-v2',
      imageGenRawSha256: manifest.source.imageGenRawSha256,
      imageGenPromptSha256: manifest.source.imageGenPromptSha256,
      priorLocalV1RejectedReviewSha256:
        manifest.source.priorLocalV1RejectedReviewSha256,
    } : {}),
    ...(localV3Provenance(manifest) ? {
      frameProvenanceVariant: 'a8b6-local-composite-v3',
      wallImageGenRawSha256: manifest.source.wallImageGenRawSha256,
      faceImageGenRawSha256: manifest.source.faceImageGenRawSha256,
      gateFrameImageGenRawSha256:
        manifest.source.gateFrameImageGenRawSha256,
      priorLocalV2RejectedReviewSha256:
        manifest.source.priorLocalV2RejectedReviewSha256,
    } : {}),
    ...(localV5Provenance(manifest) ? {
      frameProvenanceVariant: 'a8b6-local-composite-v5',
      wallImageGenRawSha256: manifest.source.wallImageGenRawSha256,
      priorLocalV4RejectedReviewSha256:
        manifest.source.priorLocalV4RejectedReviewSha256,
    } : {}),
    ...(localV6Provenance(manifest) ? {
      frameProvenanceVariant: 'a8b6-local-composite-v6',
      wallImageGenRawSha256: manifest.source.wallImageGenRawSha256,
      priorLocalV5RejectedReviewSha256:
        manifest.source.priorLocalV5RejectedReviewSha256,
    } : {}),
    ...(localV7Provenance(manifest) ? {
      frameProvenanceVariant: 'a8b6-local-composite-v7',
      wallImageGenRawSha256: manifest.source.wallImageGenRawSha256,
      priorLocalV6RejectedReviewSha256:
        manifest.source.priorLocalV6RejectedReviewSha256,
    } : {}),
    ...(localV8Provenance(manifest) ? {
      frameProvenanceVariant: 'a8b6-local-composite-v8',
      wallImageGenRawSha256: manifest.source.wallImageGenRawSha256,
      priorLocalV7RejectedReviewSha256:
        manifest.source.priorLocalV7RejectedReviewSha256,
    } : {}),
    ...(localV9Provenance(manifest) ? {
      frameProvenanceVariant: 'a8b6-local-composite-v9',
      wallImageGenRawSha256: manifest.source.wallImageGenRawSha256,
      priorLocalV8SourceReceiptSha256:
        manifest.source.priorLocalV8SourceReceiptSha256,
      priorLocalV8RejectedReviewSha256:
        manifest.source.priorLocalV8RejectedReviewSha256,
    } : {}),
    sceneCutFrameCertificateSha256:
      manifest.source.frameCertificateSha256 }
  : { approvalSha256: manifest.workflowApprovalSha256,
    amendedShotSha256: manifest.source.approvedShotSha256,
    dualOutputClarificationSha256:
      manifest.source.dualOutputClarificationSha256,
    v8EditReceiptSha256: manifest.source.v8EditReceiptSha256,
    v8SourceSelectionClarificationSha256:
      manifest.source.v8SourceSelectionClarificationSha256,
    sceneCutFrameCertificateSha256:
      manifest.source.frameCertificateSha256 }
}

async function assertSilence(filename, minimumSeconds) {
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror',
    '-i', filename, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
    '-f', 'f32le', '-'], { encoding: 'buffer', timeout: 120000,
    maxBuffer: 12 * 1024 * 1024 })
  if (!Buffer.isBuffer(stdout) || stdout.length < 16000 * 4
    * (minimumSeconds - .1) || stdout.length % 4)
    invalid('picture silent audio is absent or truncated')
  for (let offset = 0; offset < stdout.length; offset += 4)
    if (Math.abs(stdout.readFloatLE(offset)) > .00001)
      invalid('picture contains non-silent supplier audio')
}

async function frameSsim(sourceA, sourceB, compared, mapping,
  pictureToNarrated = false) {
  const filter = pictureToNarrated
    ? '[0:v][1:v]ssim=stats_file=-'
    : `[0:v]trim=start_frame=0:end_frame=${mapping.phaseA.sourceLastFrameIndex + 1},setpts=PTS-STARTPTS[a];`
      + `[1:v]trim=start_frame=1:end_frame=${mapping.phaseB.sourceLastFrameIndex + 1},setpts=PTS-STARTPTS[b];`
      + '[a][b]concat=n=2:v=1:a=0[expected];[expected][2:v]ssim=stats_file=-'
  const input = pictureToNarrated ? ['-i', sourceA, '-i', sourceB]
    : ['-i', sourceA, '-i', sourceB, '-i', compared]
  const { stdout } = await exec(ffmpeg, ['-v', 'error', '-xerror',
    ...input, '-filter_complex', filter, '-an', '-f', 'null', '/dev/null'],
  { encoding: 'utf8', timeout: 180000, maxBuffer: 512 * 1024 })
  const lines = stdout.trim().split(/\r?\n/)
  if (lines.length !== mapping.frameCount)
    invalid('composite does not retain every original-speed source frame')
  const scores = lines.map((line, index) => {
    const match = /^n:(\d+) Y:([\d.]+) U:([\d.]+) V:([\d.]+) All:([\d.]+)/.exec(line)
    if (!match || Number(match[1]) !== index + 1)
      invalid('composite frame comparison is discontinuous')
    return Number(match[5])
  })
  const min = Math.min(...scores)
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  const minRequired = pictureToNarrated ? .985 : .975
  const meanRequired = pictureToNarrated ? .99 : .985
  if (min < minRequired || mean < meanRequired)
    invalid('picture differs from paid native frames or narration picture')
  return { frameCount: scores.length, perFrameStatsSha256: sha(stdout.trim()),
    minAll: min, meanAll: mean, minimumRequired: minRequired,
    meanRequired }
}

export async function prepareFreshA8B6Composite(planId, root = process.cwd()) {
  const APlan = await readFreshA8B6PhaseAPlan(planId, root)
  assertFreshA8B6EndGuidePlan(APlan.manifest)
  if (bRetakeV3Plan(APlan.manifest))
    assertBOnlyChildHasNoPaidA(planId, root)
  const BPlan = await readFreshA8B6PhaseBPlan(planId, root)
  const A = await readFreshA8B6Acceptance(planId, 'A', root)
  const B = await readFreshA8B6Acceptance(planId, 'B', root)
  if (BPlan.plan.sourceA.acceptanceSha256 !== A.acceptanceSha256
    || B.acceptance.seam?.phaseAFrameSha256
      !== A.acceptance.acceptedFrameSha256)
    invalid('B paid clip does not continue accepted A native tail')
  const mapping = assertFreshA8B6FrameMapping(A.native, B.native, {
    acceptedAEndFrameIndex: A.acceptance.acceptedFrameIndex,
    acceptedBEndFrameIndex: B.acceptance.acceptedFrameIndex })
  if (mapping.playbackRate !== 1 || mapping.approvedDurationSeconds !== 14)
    invalid('14s delivery would retime the approved action')
  return { manifest: APlan.manifest, manifestSha256: APlan.manifestSha256,
    BPlanSha256: BPlan.planSha256, A, B, mapping }
}

/** Runs only after both paid clips pass native model+direct review. */
export async function composeFreshA8B6(planId, root = process.cwd(),
  expectedAcceptances = {}) {
  const sources = await prepareFreshA8B6Composite(planId, root)
  const { manifest, manifestSha256, BPlanSha256, A, B, mapping } = sources
  if (expectedAcceptances.A !== A.acceptanceSha256
    || expectedAcceptances.B !== B.acceptanceSha256)
    invalid('reviewed paid A/B acceptance changed before composition')
  const pictureKey = sha(canonical({ version: 'staged-a8b6-fresh-picture-v1',
    planId, phaseA: [A.media.videoSha256, A.native.frameDigestSha256],
    phaseB: [B.media.videoSha256, B.native.frameDigestSha256], mapping }))
  const pictureUrl = `/generated/fresh-a8b6-picture-${pictureKey}.mp4`
  const pictureFile = freshA8B6GeneratedFile(pictureUrl, 'video', root)
  const Afile = freshA8B6GeneratedFile(A.media.videoUrl, 'video', root)
  const Bfile = freshA8B6GeneratedFile(B.media.videoUrl, 'video', root)
  const pictureSeconds = mapping.frameCount / 24
  if (!existsSync(pictureFile)) {
    const temporary = path.join(root, 'public/generated',
      `fresh-a8b6-picture-${pictureKey}-${randomUUID()}.mp4`)
    const filter = `[0:v]trim=start_frame=0:end_frame=${mapping.phaseA.sourceLastFrameIndex + 1},setpts=PTS-STARTPTS[a];`
      + `[1:v]trim=start_frame=1:end_frame=${mapping.phaseB.sourceLastFrameIndex + 1},setpts=PTS-STARTPTS[b];`
      + '[a][b]concat=n=2:v=1:a=0,fps=24[v];'
      + `[2:a]atrim=duration=${pictureSeconds.toFixed(9)},asetpts=PTS-STARTPTS[s]`
    await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror',
      '-i', Afile, '-i', Bfile,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex', filter, '-map', '[v]', '-map', '[s]',
      '-frames:v', String(mapping.frameCount), '-c:v', 'libx264',
      '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-movflags', '+faststart', temporary],
    { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
    try { await saveFreshA8B6Bytes(pictureFile, await readFile(temporary)) }
    finally { await unlink(temporary).catch(() => undefined) }
  }
  const pictureSha256 = sha(await readFile(pictureFile))
  const pictureNative = await inspectFreshNativeVideo(pictureFile)
  if (pictureNative.frameCount !== mapping.frameCount
    || pictureNative.lastPts !== mapping.lastPts)
    invalid('stitched picture lost original source PTS/frame count')
  await assertSilence(pictureFile, pictureSeconds)
  const sourceFrameMatch = await frameSsim(Afile, Bfile, pictureFile, mapping)
  const narration = await composeNarration(pictureUrl,
    manifest.narrationTracks, pictureSeconds, '16:9', root,
    '720p', 'narration', { detectPictureVoice: async () => {
      throw Error('fresh native A/B picture audio is fully muted')
    } })
  const outputFile = freshA8B6GeneratedFile(narration.url, 'video', root)
  const outputSha256 = sha(await readFile(outputFile))
  const outputNative = await inspectFreshNativeVideo(outputFile)
  if (outputNative.frameCount !== mapping.frameCount
    || outputNative.lastPts !== mapping.lastPts)
    invalid('narration mix changed picture frame count or PTS')
  const narratedPictureMatch = await frameSsim(pictureFile, outputFile,
    null, mapping, true)
  const compositionKey = /^\/generated\/narrated-([a-f0-9]{64})\.mp4$/.exec(
    narration.url)?.[1]
  if (!compositionKey) invalid('mixer did not return standard content-addressed video')
  const compositionBytes = await readFile(path.join(root,
    '.runtime/narration-compositions', `${compositionKey}.json`))
  const composition = JSON.parse(compositionBytes.toString('utf8'))
  if (composition.version !== 'narration-composition-v1'
    || composition.key !== compositionKey
    || composition.mixerVersion !== 6
    || composition.outputUrl !== narration.url
    || composition.audioRole !== 'narration'
    || composition.duration !== pictureSeconds
    || composition.pictureSha256 !== pictureSha256
    || composition.outputSha256 !== outputSha256
    || composition.pictureVoiceIsolation?.status !== 'fully-muted-unverified'
    || composition.pictureVoiceIsolation.sourceSha256 !== pictureSha256
    || composition.pictureVoiceIsolation.preservedOutsideWindows !== false
    || !composition.pictureVoiceIsolation.mutedWindows?.some(window =>
      window.start <= 0 && window.end >= pictureSeconds)
    || canonical(composition.tracks) !== canonical(manifest.narrationTracks))
    invalid('original three WAVs or full source mute changed in mixer6')
  const audio = await collectIndependentNarrationTransferEvidence(
    narration.url, outputFile, `fresh-a8b6:${planId}`,
    outputSha256, root)
  if (audio?.status !== 'confirmed'
    || audio.sourceSpeechIsolation?.status !== 'confirmed'
    || audio.sourceSpeechIsolation.mode !== 'full-source-mute'
    || audio.originalUrl !== narration.url
    || audio.outputVideoSha256 !== outputSha256
    || audio.pictureSha256 !== pictureSha256
    || audio.compositionReceiptSha256 !== sha(compositionBytes)
    || audio.mixerVersion !== 6
    || audio.audioRole !== 'narration'
    || audio.lines?.length !== 3
    || audio.lines.some((line, index) => line.status !== 'confirmed'
      || line.sourceWavSha256 !== manifest.narrationTracks[index].sha256
      || line.fullWindow?.passed !== true
      || line.lastWordWindow?.passed !== true))
    invalid('decoded original three-TTS transfer is not independently confirmed')
  const transfer = await saveFreshA8B6Artifact(planId,
    'narration-transfer.json', audio, root)
  const receiptBody = { version: 'staged-a8b6-fresh-composite-v1',
    planId, manifestSha256,
    workflowApprovalSha256: manifest.workflowApprovalSha256,
    workflowApproval: workflowApprovalReceipt(manifest),
    sourceRecordId: manifest.source.freshFrameExecutionId,
    sourceResultMd5: manifest.source.freshFrameResultMd5,
    approvedShotSha256: manifest.source.approvedShotSha256,
    scheduleHash: manifest.source.scheduleHash,
    firstFrameCertificateSha256: manifest.source.frameCertificateSha256,
    BPlanSha256,
    sources: { phaseA: { taskId: A.media.taskId,
      taskSha256: A.media.taskSha256,
      mediaSha256: A.mediaSha256,
      acceptanceSha256: A.acceptanceSha256,
      videoUrl: A.media.videoUrl, videoSha256: A.media.videoSha256,
      acceptedFrameIndex: A.acceptance.acceptedFrameIndex },
    phaseB: { taskId: B.media.taskId,
      taskSha256: B.media.taskSha256,
      mediaSha256: B.mediaSha256,
      acceptanceSha256: B.acceptanceSha256,
      videoUrl: B.media.videoUrl, videoSha256: B.media.videoSha256,
      acceptedFrameIndex: B.acceptance.acceptedFrameIndex } },
    mapping, seam: B.acceptance.seam,
    picture: { url: pictureUrl, sha256: pictureSha256,
      nativeFrameDigestSha256: pictureNative.frameDigestSha256,
      frameCount: mapping.frameCount, fps: 24,
      lastPts: mapping.lastPts, silentAudio: true,
      sourceFrameMatch },
    narration: { url: narration.url, sha256: outputSha256,
      compositionReceiptKey: compositionKey,
      compositionReceiptSha256: sha(compositionBytes),
      narrationTransferSha256: transfer.sha256,
      mixerVersion: 6, fullSourceMute: true,
      ttsTrackSha256s: manifest.narrationTracks.map(track => track.sha256),
      narratedPictureMatch },
    output: { url: narration.url, sha256: outputSha256,
      frameCount: mapping.frameCount, fps: 24,
      nativeFrameDigestSha256: outputNative.frameDigestSha256,
      lastPts: mapping.lastPts },
    review: { seamVerdict: 'accept', wholeShot: 'pending-node58' } }
  const signed = await saveFreshA8B6Artifact(planId,
    'composite.json', receiptBody, root)
  return { manifest, receipt: signed.value,
    manifestSha256, receiptSha256: signed.sha256 }
}

export async function verifyFreshA8B6CompositeReceipt(planId,
  root = process.cwd()) {
  const sources = await prepareFreshA8B6Composite(planId, root)
  const { manifest, manifestSha256, BPlanSha256, A, B, mapping } = sources
  const { value: receipt, sha256: receiptSha256 } =
    await readFreshA8B6Artifact(planId, 'composite.json', root)
  const pictureFile = freshA8B6GeneratedFile(receipt.picture?.url,
    'video', root)
  const outputFile = freshA8B6GeneratedFile(receipt.output?.url,
    'video', root)
  const [pictureBytes, outputBytes] = await Promise.all([
    readFile(pictureFile), readFile(outputFile)])
  const [pictureNative, outputNative] = await Promise.all([
    inspectFreshNativeVideo(pictureFile), inspectFreshNativeVideo(outputFile)])
  if (receipt.version !== 'staged-a8b6-fresh-composite-v1'
    || receipt.planId !== planId
    || receipt.manifestSha256 !== manifestSha256
    || receipt.workflowApprovalSha256 !== manifest.workflowApprovalSha256
    || canonical(receipt.workflowApproval)
      !== canonical(workflowApprovalReceipt(manifest))
    || receipt.sourceRecordId !== manifest.source.freshFrameExecutionId
    || receipt.sourceResultMd5 !== manifest.source.freshFrameResultMd5
    || receipt.approvedShotSha256 !== manifest.source.approvedShotSha256
    || receipt.scheduleHash !== manifest.source.scheduleHash
    || receipt.firstFrameCertificateSha256
      !== manifest.source.frameCertificateSha256
    || receipt.BPlanSha256 !== BPlanSha256
    || receipt.sources?.phaseA?.taskId !== A.media.taskId
    || receipt.sources.phaseA.taskSha256 !== A.media.taskSha256
    || receipt.sources.phaseA.mediaSha256 !== A.mediaSha256
    || receipt.sources.phaseA.videoSha256 !== A.media.videoSha256
    || receipt.sources.phaseA.acceptanceSha256 !== A.acceptanceSha256
    || receipt.sources.phaseA.acceptedFrameIndex
      !== A.acceptance.acceptedFrameIndex
    || receipt.sources?.phaseB?.taskId !== B.media.taskId
    || receipt.sources.phaseB.taskSha256 !== B.media.taskSha256
    || receipt.sources.phaseB.mediaSha256 !== B.mediaSha256
    || receipt.sources.phaseB.videoSha256 !== B.media.videoSha256
    || receipt.sources.phaseB.acceptanceSha256 !== B.acceptanceSha256
    || receipt.sources.phaseB.acceptedFrameIndex
      !== B.acceptance.acceptedFrameIndex
    || canonical(receipt.mapping) !== canonical(mapping)
    || canonical(receipt.seam) !== canonical(B.acceptance.seam)
    || receipt.picture?.sha256 !== sha(pictureBytes)
    || receipt.picture.frameCount !== mapping.frameCount
    || receipt.picture.lastPts !== mapping.lastPts
    || receipt.picture.fps !== 24
    || receipt.picture.silentAudio !== true
    || receipt.picture.nativeFrameDigestSha256
      !== pictureNative.frameDigestSha256
    || pictureNative.frameCount !== mapping.frameCount
    || receipt.narration?.sha256 !== sha(outputBytes)
    || receipt.narration.url !== receipt.output.url
    || receipt.output.sha256 !== sha(outputBytes)
    || receipt.output.frameCount !== mapping.frameCount
    || receipt.output.fps !== 24
    || receipt.output.nativeFrameDigestSha256
      !== outputNative.frameDigestSha256
    || receipt.output.lastPts !== mapping.lastPts
    || receipt.narration.mixerVersion !== 6
    || receipt.narration.fullSourceMute !== true
    || !SHA.test(String(receipt.narration.narrationTransferSha256))
    || canonical(receipt.narration.ttsTrackSha256s)
      !== canonical(manifest.narrationTracks.map(track => track.sha256))
    || outputNative.frameCount !== mapping.frameCount
    || outputNative.lastPts !== mapping.lastPts
    || receipt.review?.seamVerdict !== 'accept'
    || receipt.review?.wholeShot !== 'pending-node58')
    invalid('signed fresh composite source or delivered bytes changed')
  await assertSilence(pictureFile, mapping.frameCount / 24)
  const sourceFrameMatch = await frameSsim(
    freshA8B6GeneratedFile(A.media.videoUrl, 'video', root),
    freshA8B6GeneratedFile(B.media.videoUrl, 'video', root),
    pictureFile, mapping)
  const narratedPictureMatch = await frameSsim(pictureFile,
    outputFile, null, mapping, true)
  if (canonical(receipt.picture.sourceFrameMatch)
      !== canonical(sourceFrameMatch)
    || canonical(receipt.narration.narratedPictureMatch)
      !== canonical(narratedPictureMatch))
    invalid('original-speed picture mapping changed')
  const compositionKey = /^\/generated\/narrated-([a-f0-9]{64})\.mp4$/.exec(
    receipt.output.url)?.[1]
  if (!compositionKey
    || compositionKey !== receipt.narration.compositionReceiptKey)
    invalid('mixer6 composition identity missing')
  const compositionBytes = await readFile(path.join(root,
    '.runtime/narration-compositions', `${compositionKey}.json`))
  const composition = JSON.parse(compositionBytes.toString('utf8'))
  if (receipt.narration.compositionReceiptSha256 !== sha(compositionBytes)
    || composition.version !== 'narration-composition-v1'
    || composition.key !== compositionKey
    || composition.outputUrl !== receipt.output.url
    || composition.audioRole !== 'narration'
    || composition.duration !== mapping.frameCount / 24
    || composition.mixerVersion !== 6
    || composition.pictureSha256 !== receipt.picture.sha256
    || composition.outputSha256 !== receipt.output.sha256
    || composition.pictureVoiceIsolation?.status !== 'fully-muted-unverified'
    || composition.pictureVoiceIsolation.sourceSha256 !== receipt.picture.sha256
    || composition.pictureVoiceIsolation.preservedOutsideWindows !== false
    || !composition.pictureVoiceIsolation.mutedWindows?.some(window =>
      window.start <= 0 && window.end >= mapping.frameCount / 24)
    || canonical(composition.tracks) !== canonical(manifest.narrationTracks))
    invalid('standard mixer6 receipt changed')
  const transfer = await readFreshA8B6Artifact(planId,
    'narration-transfer.json', root)
  if (receipt.narration.narrationTransferSha256 !== transfer.sha256
    || transfer.value.status !== 'confirmed'
    || transfer.value.sourceSpeechIsolation?.status !== 'confirmed'
    || transfer.value.sourceSpeechIsolation.mode !== 'full-source-mute'
    || transfer.value.originalUrl !== receipt.output.url
    || transfer.value.outputVideoSha256 !== receipt.output.sha256
    || transfer.value.pictureSha256 !== receipt.picture.sha256
    || transfer.value.compositionReceiptSha256
      !== receipt.narration.compositionReceiptSha256
    || transfer.value.mixerVersion !== 6
    || transfer.value.audioRole !== 'narration'
    || transfer.value.lines?.length !== 3
    || transfer.value.lines.some((line, index) =>
      line.status !== 'confirmed'
      || line.sourceWavSha256 !== manifest.narrationTracks[index].sha256
      || line.fullWindow?.passed !== true
      || line.lastWordWindow?.passed !== true))
    invalid('original three narration WAVs lack decoded transfer evidence')
  return { manifest, receipt, manifestSha256, receiptSha256 }
}

/** Local-file variant for runner lineage; async verifier adds DB/model/PTS QA. */
export function verifyFreshA8B6CompositeReceiptSync(planId,
  root = process.cwd()) {
  if (!SHA.test(String(planId))) invalid('fresh composite plan ID invalid')
  const directory = path.join(root, '.runtime/staged-scene-cut-a8b6-fresh', planId)
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) invalid('fresh composite signing key invalid')
  const signedFile = filename => {
    const bytes = readFileSync(filename)
    const value = JSON.parse(bytes.toString('utf8'))
    const { signature, ...body } = value
    const expected = createHmac('sha256', key).update(canonical(body))
      .digest('hex')
    if (!SHA.test(String(signature)) || signature !== expected)
      invalid(`${path.basename(filename)} signature changed`)
    return { value, sha256: sha(bytes) }
  }
  const signed = (name, sourcePlanId = planId) => {
    const sourceDirectory = sourcePlanId === planId ? directory
      : path.join(root, '.runtime/staged-scene-cut-a8b6-fresh', sourcePlanId)
    return signedFile(path.join(sourceDirectory, name))
  }
  const manifest = signed('manifest.json')
  const bRetakeChild = bRetakeV3Plan(manifest.value)
  if (bRetakeChild) assertBOnlyChildHasNoPaidA(planId, root)
  const phaseAPlanId = bRetakeChild
    ? manifest.value.bRetake?.parentPlanId : planId
  if (!SHA.test(String(phaseAPlanId))
    || phaseAPlanId === planId && bRetakeChild)
    invalid('B-only child parent A plan missing')
  const receipt = signed('composite.json')
  const BPlan = signed('phase-B-plan.json')
  const ATask = signed('phase-A-task.json', phaseAPlanId)
  const BTask = signed('phase-B-task.json')
  const AMedia = signed('phase-A-media.json', phaseAPlanId)
  const BMedia = signed('phase-B-media.json')
  const AReviewEvidence = signed('phase-A-review-evidence.json',
    phaseAPlanId)
  const BReviewEvidence = signed('phase-B-review-evidence.json')
  const ADirect = signed('phase-A-manual-review.json', phaseAPlanId)
  const BDirect = signed('phase-B-manual-review.json')
  const A = signed('phase-A-acceptance.json', phaseAPlanId)
  const B = signed('phase-B-acceptance.json')
  const transfer = signed('narration-transfer.json')
  const value = receipt.value, source = manifest.value.source
  const local = localProvenance(manifest.value)
  const localV2 = localV2Provenance(manifest.value)
  const localV3 = localV3Provenance(manifest.value)
  const localV5 = localV5Provenance(manifest.value)
  const localV6 = localV6Provenance(manifest.value)
  const localV7 = localV7Provenance(manifest.value)
  const localV8 = localV8Provenance(manifest.value)
  const localV9 = localV9Provenance(manifest.value)
  const guide = assertFreshA8B6EndGuidePlan(manifest.value)
  const retake = retakeAPlan(manifest.value)
  const { approval, approvalSha256 } = retake
    ? verifyA8B6FreshARetakeApprovalSync(phaseAPlanId, root)
    : localV9
    ? verifyA8B6LocalWorkflowApprovalV9Sync(planId, root)
    : localV8 ? verifyA8B6LocalWorkflowApprovalV8Sync(planId, root)
    : localV7 ? verifyA8B6LocalWorkflowApprovalV7Sync(planId, root)
    : localV6
    ? verifyA8B6LocalWorkflowApprovalV6Sync(planId, root)
    : localV5 ? verifyA8B6LocalWorkflowApprovalV5Sync(planId, root)
    : localV3 ? verifyA8B6LocalWorkflowApprovalV3Sync(planId, root)
    : localV2 ? verifyA8B6LocalWorkflowApprovalV2Sync(planId, root)
    : local ? verifyA8B6LocalWorkflowApprovalSync(planId, root)
    : verifyA8B6FreshWorkflowApprovalSync(planId, root)
  if (retake) {
    const parentPlanId = manifest.value.retake.parentPlanId
    const parentManifest = signed('manifest.json', parentPlanId)
    const parentTask = signed('phase-A-task.json', parentPlanId)
    const parentMedia = signed('phase-A-media.json', parentPlanId)
    const provenance = verifyA8B6ARetakeTargetProvenanceAmendmentSync(root)
    if (approval.parentPlanId !== parentPlanId
      || approval.parentWorkflowApprovalSha256
        !== manifest.value.retake.parentWorkflowApprovalSha256
      || parentManifest.sha256
        !== manifest.value.retake.parentManifestSha256
      || parentManifest.value.version !== 'staged-a8b6-fresh-A-plan-v1'
      || parentManifest.value.planId !== parentPlanId
      || !localV9Provenance(parentManifest.value)
      || canonical(manifest.value.source)
        !== canonical(parentManifest.value.source)
      || canonical(manifest.value.narrationTracks)
        !== canonical(parentManifest.value.narrationTracks)
      || canonical(manifest.value.frozenIdentityPlates)
        !== canonical(parentManifest.value.frozenIdentityPlates)
      || canonical(manifest.value.imageReferenceProof)
        !== canonical(parentManifest.value.imageReferenceProof)
      || canonical(manifest.value.providerLock)
        !== canonical(parentManifest.value.providerLock)
      || canonical(manifest.value.compactTransport.entries.slice(0, 3))
        !== canonical(parentManifest.value.compactTransport?.entries)
      || parentManifest.value.workflowApprovalSha256
        !== manifest.value.retake.parentWorkflowApprovalSha256
      || parentManifest.value.phaseAPreview?.requestSha256
        !== manifest.value.retake.parentRequestSha256
      || parentTask.sha256 !== manifest.value.retake.parentTaskSha256
      || parentTask.value.planId !== parentPlanId
      || parentTask.value.phase !== 'A'
      || parentTask.value.taskId !== manifest.value.retake.parentTaskId
      || parentMedia.sha256
        !== manifest.value.retake.parentMediaReceiptSha256
      || parentMedia.value.planId !== parentPlanId
      || parentMedia.value.phase !== 'A'
      || parentMedia.value.taskId !== manifest.value.retake.parentTaskId
      || parentMedia.value.videoSha256
        !== manifest.value.retake.parentVideoSha256
      || approval.parentRejectionSha256
        !== manifest.value.retake.parentRejectionSha256
      || approval.targetSourceReceiptSha256
        !== manifest.value.retake.targetSourceReceiptSha256
      || approval.targetReviewSha256
        !== manifest.value.retake.targetReviewSha256
      || provenance.amendmentSha256
        !== manifest.value.retake.targetPromptAmendmentSha256
      || provenance.amendment.sourceReceiptSha256
        !== manifest.value.retake.targetSourceReceiptSha256
      || provenance.amendment.targetReviewSha256
        !== manifest.value.retake.targetReviewSha256
      || provenance.amendment.imageGen?.resizedCandidateSha256
        !== guide.sha256
      || provenance.amendment.actualNativeTailExtraction?.inputSha256
        !== manifest.value.retake.parentVideoSha256
      || approval.targetPromptAmendmentSha256
        !== provenance.amendmentSha256
      || approval.targetEndFrameSha256 !== guide.sha256
      || approval.targetEndFrameUrl !== guide.url
      || canonical(approval.phaseAProviderLock)
        !== canonical(manifest.value.providerLock)
      || approval.acceptedNativeTail !== false
      || sha(readFileSync(freshA8B6GeneratedFile(guide.url, 'image', root)))
        !== guide.sha256)
      invalid('retake parent approval or approved generation-only guide changed')
  }
  if (bRetakeChild) {
    const parentManifest = signed('manifest.json', phaseAPlanId)
    const parentBPlan = signed('phase-B-plan.json', phaseAPlanId)
    const parentBTask = signed('phase-B-task.json', phaseAPlanId)
    const parentBMedia = signed('phase-B-media.json', phaseAPlanId)
    const previousPlanId = manifest.value.bRetake?.previousChild?.planId
    const visitedPlans = new Set([phaseAPlanId, planId])
    const targetEvidence = sourcePlanId => {
      const targetDirectory = path.join(root,
        '.runtime/staged-scene-cut-a8b6-B-retake', sourcePlanId)
      const evidence = { source: signedFile(path.join(targetDirectory,
        'target-source.json')),
      review: signedFile(path.join(targetDirectory,
        'target-review.json')) }
      assertFreshA8B6BRetakeTargetEvidenceSync(evidence.source,
        evidence.review, root)
      return evidence
    }
    const readPreviousChild = previousId => {
      if (!SHA.test(String(previousId)) || visitedPlans.has(previousId)
        || visitedPlans.size > 32)
        invalid('previous B-only child identity or ancestry changed')
      visitedPlans.add(previousId)
      assertBOnlyChildHasNoPaidA(previousId, root)
      const previousManifest = signed('manifest.json', previousId)
      const earlierPlanId = previousManifest.value.bRetake
        ?.previousChild?.planId
      const earlierChild = earlierPlanId
        ? readPreviousChild(earlierPlanId) : undefined
      const guide = targetEvidence(earlierPlanId ?? phaseAPlanId)
      return { manifest: previousManifest,
        approval: verifyFreshA8B6BRetakeApprovalSync(previousId, root),
        firstTargetSource: guide.source,
        firstTargetReview: guide.review,
        previousChild: earlierChild,
        BPlan: signed('phase-B-plan.json', previousId),
        BTask: signed('phase-B-task.json', previousId),
        BMedia: signed('phase-B-media.json', previousId),
        rejection: verifyFreshA8B6PhaseBRejectionSync(previousId, root) }
    }
    const previousChild = previousPlanId
      ? readPreviousChild(previousPlanId) : undefined
    const targetPlanId = previousPlanId ?? phaseAPlanId
    const target = targetEvidence(targetPlanId)
    const targetSource = target.source
    const targetReview = target.review
    assertFreshA8B6BRetakeCompositeAncestry({ manifest,
      parentManifest, A, AMedia, parentBPlan, parentBTask, parentBMedia,
      parentBRejection: verifyFreshA8B6PhaseBRejectionSync(
        phaseAPlanId, root),
      previousChild,
      bApproval: verifyFreshA8B6BRetakeApprovalSync(planId, root),
      targetSource, targetReview })
  }
  const localSource = localV9
    ? verifyA8B6LocalCompositeSourceReceiptV9Sync(root)
    : localV8 ? verifyA8B6LocalCompositeSourceReceiptV8Sync(root)
    : localV7 ? verifyA8B6LocalCompositeSourceReceiptV7Sync(root)
    : localV6
    ? verifyA8B6LocalCompositeSourceReceiptV6Sync(root)
    : localV5 ? verifyA8B6LocalCompositeSourceReceiptV5Sync(root)
    : localV3 ? verifyA8B6LocalCompositeSourceReceiptV3Sync(root)
    : localV2 ? verifyA8B6LocalCompositeSourceReceiptV2Sync(root)
    : local ? verifyA8B6LocalCompositeSourceReceiptSync(root) : undefined
  const { signature: _manifestSignature, planId: _manifestPlanId,
    workflowApprovalSha256: _manifestApprovalSha, ...planBody } = manifest.value
  void _manifestSignature; void _manifestPlanId; void _manifestApprovalSha
  if (manifest.value.planId !== planId
    || sha(canonical(planBody)) !== planId
    || !SHA.test(String(manifest.value.workflowApprovalSha256))
    || manifest.value.workflowApprovalSha256 !== approvalSha256
    || source?.freshFrameExecutionId !== approval.approvalExecutionId
    || source?.freshFrameResultMd5 !== approval.approvalResultMd5
    || source?.approvedShotSha256 !== approval.approvedShotSha256
    || source?.frameCertificateSha256
      !== approval.sceneCutFrameCertificateSha256
    || source?.approvedFirstFrameSha256
      !== approval.approvedFirstFrameSha256
    || source?.approvedFirstFrameUrl !== approval.approvedFirstFrameUrl
    || source?.freshFrameMarkerSha256 !== approval.freshFrameMarkerSha256
    || source?.imageModelExecutionId !== approval.imageModelExecutionId
    || source?.frameReviewModelExecutionId
      !== approval.frameReviewExecutionId
    || (local ? (
      source?.localCompositeSourceReceiptSha256
        !== localSource.receiptSha256
      || source.localCompositeSourceReceiptSha256
        !== approval.localCompositeSourceReceiptSha256
      || source.localCompositeAlgorithmSha256
        !== localSource.receipt.algorithm.implementationSha256
      || source.localCompositeAlgorithmSha256
        !== approval.localCompositeAlgorithmSha256
      || (localV2 && (
        source.imageGenRawSha256 !== localSource.receipt.sources[1].sha256
        || source.imageGenRawSha256 !== approval.imageGenRawSha256
        || source.imageGenPromptSha256
          !== localSource.receipt.imageGen.promptSha256
        || source.imageGenPromptSha256 !== approval.imageGenPromptSha256
        || source.priorLocalV1RejectedReviewSha256
          !== localSource.receipt.priorLocalV1.rejectedReviewSha256
        || source.priorLocalV1RejectedReviewSha256
          !== approval.priorLocalV1RejectedReviewSha256))
      || (localV3 && (
        source.wallImageGenRawSha256
          !== localSource.receipt.sources[1].sha256
        || source.faceImageGenRawSha256
          !== localSource.receipt.sources[2].sha256
        || source.gateFrameImageGenRawSha256
          !== localSource.receipt.sources[3].sha256
        || source.priorLocalV2RejectedReviewSha256
          !== localSource.receipt.priorLocalV2.rejectedReviewSha256
        || source.wallImageGenRawSha256
          !== approval.wallImageGenRawSha256
        || source.faceImageGenRawSha256
          !== approval.faceImageGenRawSha256
        || source.gateFrameImageGenRawSha256
          !== approval.gateFrameImageGenRawSha256
        || source.priorLocalV2RejectedReviewSha256
          !== approval.priorLocalV2RejectedReviewSha256))
      || (localV5 && (
        source.wallImageGenRawSha256
          !== localSource.receipt.sources[1].sha256
        || source.priorLocalV4RejectedReviewSha256
          !== localSource.receipt.priorLocalV4.rejectedReviewSha256
        || source.wallImageGenRawSha256
          !== approval.wallImageGenRawSha256
        || source.priorLocalV4RejectedReviewSha256
          !== approval.priorLocalV4RejectedReviewSha256))
      || (localV6 && (
        source.wallImageGenRawSha256
          !== localSource.receipt.sources[1].sha256
        || source.priorLocalV5RejectedReviewSha256
          !== localSource.receipt.priorLocalV5.rejectedReviewSha256
        || source.wallImageGenRawSha256
          !== approval.wallImageGenRawSha256
        || source.priorLocalV5RejectedReviewSha256
          !== approval.priorLocalV5RejectedReviewSha256))
      || (localV7 && (
        source.wallImageGenRawSha256
          !== localSource.receipt.sources[1].sha256
        || source.priorLocalV6RejectedReviewSha256
          !== localSource.receipt.priorLocalV6.rejectedReviewSha256
        || source.wallImageGenRawSha256
          !== approval.wallImageGenRawSha256
        || source.priorLocalV6RejectedReviewSha256
          !== approval.priorLocalV6RejectedReviewSha256))
      || (localV8 && (
        source.wallImageGenRawSha256
          !== localSource.receipt.sources[1].sha256
        || source.priorLocalV7RejectedReviewSha256
          !== localSource.receipt.priorLocalV7.rejectedReviewSha256
        || source.wallImageGenRawSha256
          !== approval.wallImageGenRawSha256
        || source.priorLocalV7RejectedReviewSha256
          !== approval.priorLocalV7RejectedReviewSha256))
      || (localV9 && (
        source.wallImageGenRawSha256
          !== localSource.receipt.sources[1].sha256
        || source.priorLocalV8SourceReceiptSha256
          !== localSource.receipt.priorLocalV8.sourceReceiptSha256
        || source.priorLocalV8RejectedReviewSha256
          !== localSource.receipt.priorLocalV8.rejectedReviewSha256
        || source.wallImageGenRawSha256
          !== approval.wallImageGenRawSha256
        || source.priorLocalV8SourceReceiptSha256
          !== approval.priorLocalV8SourceReceiptSha256
        || source.priorLocalV8RejectedReviewSha256
          !== approval.priorLocalV8RejectedReviewSha256))
      || source.imagePaymentExecutionId !== null
      || source.imageModelExecutionId !== null
      || source.imageRequestFingerprint !== null
      || !Array.isArray(manifest.value.imageReferenceProof)
      || manifest.value.imageReferenceProof.length !== 0
    ) : (
      source?.freshEditReceiptSha256 !== approval.editReceiptSha256
      || source?.v8EditReceiptSha256 !== approval.v8EditReceiptSha256
      || source?.maskedLayoutSourceSha256
        !== approval.maskedLayoutSourceSha256
      || source?.maskedLayoutTransportSha256
        !== approval.maskedLayoutTransportSha256
      || source?.v4FaceHelperSourceSha256
        !== approval.v4FaceHelperSourceSha256
      || source?.v4FaceHelperTransportSha256
        !== approval.v4FaceHelperTransportSha256
      || source?.frozenFaceCropSourceSha256
        !== approval.frozenFaceCropSourceSha256
      || source?.frozenFaceCropJpegSha256
        !== approval.frozenFaceCropJpegSha256
      || canonical(source?.frozenFaceCropBox)
        !== canonical(approval.frozenFaceCropBox)
      || source?.v8SourceSelectionClarificationSha256
        !== approval.v8SourceSelectionClarificationSha256
      || source?.rejectedLayoutImageSha256
        !== approval.rejectedLayoutImageSha256
      || source?.rejectedLayoutTransportSha256
        !== approval.rejectedLayoutTransportSha256
      || source?.imagePaymentExecutionId
        !== approval.imagePaymentExecutionId
      || source?.dualOutputRecoveryReceiptSha256
        !== approval.dualOutputRecoveryReceiptSha256
      || source?.dualOutputClarificationSha256
        !== approval.dualOutputClarificationSha256
      || source?.dualOutputSelectedSha256
        !== approval.dualOutputSelectedSha256
      || source?.dualOutputUnselectedSha256
        !== approval.dualOutputUnselectedSha256
      || source?.dualOutputThreadId
        !== approval.dualOutputThreadId
      || !Array.isArray(manifest.value.imageReferenceProof)
      || manifest.value.imageReferenceProof.length
        !== (source.v8EditReceiptSha256 ? 5 : 4)
      || manifest.value.imageReferenceProof.some((item, index) =>
        item.index !== index + 1 || !Number.isInteger(item.bytes)
        || item.bytes <= 0 || !SHA.test(String(item.sha256)))
      || !isDeepStrictEqual(
        manifest.value.imageReferenceProof.slice(0, 2)
          .map(item => item.sha256),
        manifest.value.frozenIdentityPlates.map(plate => plate.frontSha256))
      || manifest.value.imageReferenceProof[2].sha256
        !== source.rejectedLayoutTransportSha256
    ))
    || manifest.value.phaseAPreview?.requestSha256
      !== approval.phaseARequestSha256
    || !/^record-[\w-]+$/.test(String(source?.freshFrameExecutionId))
    || !/^[a-f0-9]{32}$/.test(String(source?.freshFrameResultMd5))
    || !SHA.test(String(source?.approvedShotSha256))
    || !SHA.test(String(source?.frameCertificateSha256))
    || !SHA.test(String(source?.approvedFirstFrameSha256))
    || source?.scheduleHash !== 'duration-v2-sha256-ecccd70590dab91eccf4c52d6797f57ecb961a3bb02b7922e4a66bb203b71c18'
    || manifest.value.phaseA?.providerSeconds !== 8
    || ATask.value.taskId === manifest.value.retake?.parentTaskId
    || AMedia.value.videoSha256
      === manifest.value.retake?.parentVideoSha256
    || manifest.value.providerLock?.modelId !== 'keling3'
    || !SHA.test(String(manifest.value.providerLock.endpointSha256))
    || !SHA.test(String(manifest.value.phaseAPreview?.requestSha256))
    || !Array.isArray(manifest.value.narrationTracks)
    || manifest.value.narrationTracks.length !== 3
    || canonical(manifest.value.narrationTracks.map(track => track.start))
      !== canonical([0, 2.5, 9.5])
    || manifest.value.narrationTracks[2].end !== 11.75
    || !Array.isArray(manifest.value.forbiddenSources)
    || ATask.value.taskId === BTask.value.taskId
    || AMedia.value.videoSha256 === BMedia.value.videoSha256
    || value.planId !== planId
    || value.version !== 'staged-a8b6-fresh-composite-v1'
    || value.manifestSha256 !== manifest.sha256
    || value.workflowApprovalSha256
      !== manifest.value.workflowApprovalSha256
    || canonical(value.workflowApproval)
      !== canonical(workflowApprovalReceipt(manifest.value))
    || value.sourceRecordId !== source.freshFrameExecutionId
    || value.sourceResultMd5 !== source.freshFrameResultMd5
    || value.approvedShotSha256 !== source.approvedShotSha256
    || value.scheduleHash !== source.scheduleHash
    || value.firstFrameCertificateSha256 !== source.frameCertificateSha256
    || value.BPlanSha256 !== BPlan.sha256
    || value.sources?.phaseA?.acceptanceSha256 !== A.sha256
    || value.sources?.phaseB?.acceptanceSha256 !== B.sha256
    || value.narration?.narrationTransferSha256 !== transfer.sha256
    || value.mapping?.version !== 'a8b6-fresh-original-speed-mapping-v1'
    || value.mapping.fps !== 24
    || value.mapping.approvedDurationSeconds !== 14
    || value.mapping.playbackRate !== 1
    || value.mapping.phaseA?.sourceFirstFrameIndex !== 0
    || value.mapping.phaseA.sourceLastFrameIndex !== A.value.acceptedFrameIndex
    || value.mapping.phaseA.outputFirstFrameIndex !== 0
    || value.mapping.phaseA.outputLastFrameIndex !== A.value.acceptedFrameIndex
    || value.mapping.phaseA.acceptedTailPts
      !== A.value.acceptedFrameIndex / 24
    || value.mapping.phaseB?.sourceFirstFrameIndex !== 1
    || value.mapping.phaseB.sourceLastFrameIndex !== B.value.acceptedFrameIndex
    || value.mapping.phaseB.outputFirstFrameIndex !== A.value.acceptedFrameIndex + 1
    || value.mapping.phaseB.outputLastFrameIndex
      !== A.value.acceptedFrameIndex + B.value.acceptedFrameIndex
    || value.mapping.phaseB.requestedFirstFrameIndex !== 0
    || value.mapping.phaseB.acceptedTailPts
      !== B.value.acceptedFrameIndex / 24
    || value.mapping.frameCount
      !== A.value.acceptedFrameIndex + B.value.acceptedFrameIndex + 1
    || value.mapping.frameCount < 335 || value.mapping.frameCount > 339
    || value.mapping.firstPts !== 0
    || value.mapping.lastPts
      !== (value.mapping.frameCount - 1) / 24
    || value.picture?.frameCount !== value.mapping.frameCount
    || value.picture?.fps !== 24
    || value.picture?.lastPts !== value.mapping.lastPts
    || value.picture?.silentAudio !== true
    || value.picture?.sourceFrameMatch?.frameCount !== value.mapping.frameCount
    || !Number.isFinite(value.picture.sourceFrameMatch.minAll)
    || !Number.isFinite(value.picture.sourceFrameMatch.meanAll)
    || value.picture.sourceFrameMatch.minAll < .975
    || value.picture.sourceFrameMatch.meanAll < .985
    || value.narration?.mixerVersion !== 6
    || value.narration?.fullSourceMute !== true
    || canonical(value.narration?.ttsTrackSha256s)
      !== canonical(manifest.value.narrationTracks.map(track => track.sha256))
    || value.narration?.narratedPictureMatch?.frameCount
      !== value.mapping.frameCount
    || !Number.isFinite(value.narration.narratedPictureMatch.minAll)
    || !Number.isFinite(value.narration.narratedPictureMatch.meanAll)
    || value.narration.narratedPictureMatch.minAll < .985
    || value.narration.narratedPictureMatch.meanAll < .99
    || value.narration.url !== value.output?.url
    || value.narration.sha256 !== value.output.sha256
    || value.output.frameCount !== value.mapping.frameCount
    || value.output.fps !== 24
    || !SHA.test(String(value.output.nativeFrameDigestSha256))
    || value.output.lastPts !== value.mapping.lastPts
    || canonical(value.seam) !== canonical(B.value.seam)
    || value.review?.seamVerdict !== 'accept'
    || value.review?.wholeShot !== 'pending-node58')
    invalid('synchronous fresh composite lineage incomplete')
  if (!local) {
    assertFreshA8B6ImageReferenceProof(manifest.value.imageReferenceProof,
      source, manifest.value.frozenIdentityPlates, root)
    assertFreshA8B6DualOutputSource(source, root)
  }
  for (const [phase, task, media, acceptance] of [
    ['A', ATask, AMedia, A], ['B', BTask, BMedia, B]]) {
    const phasePlanId = phase === 'A' ? phaseAPlanId : planId
    const phaseDirectory = phasePlanId === planId ? directory
      : path.join(root, '.runtime/staged-scene-cut-a8b6-fresh',
        phasePlanId)
    const intentBytes = readFileSync(path.join(phaseDirectory,
      `phase-${phase}-submit-intent.json`))
    const intent = JSON.parse(intentBytes.toString('utf8'))
    const requestSha256 = phase === 'A'
      ? manifest.value.phaseAPreview.requestSha256
      : BPlan.value.phaseBPreview?.requestSha256
    if (intent.version !== 'staged-a8b6-fresh-paid-intent-v1'
      || intent.planId !== phasePlanId || intent.phase !== phase
      || intent.requestSha256 !== requestSha256
      || intent.modelId !== manifest.value.providerLock.modelId
      || intent.endpointSha256 !== manifest.value.providerLock.endpointSha256
      || !/^https:\/\//.test(String(intent.endpoint))
      || sha(intent.endpoint) !== intent.endpointSha256
      || task.value.version !== 'staged-a8b6-fresh-task-v1'
      || task.value.planId !== phasePlanId || task.value.phase !== phase
      || !/^[\w-]{8,128}$/.test(String(task.value.taskId))
      || task.value.requestSha256 !== requestSha256
      || task.value.modelId !== intent.modelId
      || task.value.endpointSha256 !== intent.endpointSha256
      || task.value.intentSha256 !== sha(intentBytes)
      || media.value.version !== 'staged-a8b6-fresh-native-media-v1'
      || media.value.planId !== phasePlanId || media.value.phase !== phase
      || media.value.taskId !== task.value.taskId
      || media.value.taskSha256 !== task.sha256
      || media.value.videoUrl !== `/generated/fresh-a8b6-${phasePlanId.slice(0, 16)}-${phase}-${task.value.taskId}.mp4`
      || media.value.nativeFps !== 24
      || !SHA.test(String(media.value.nativeFrameDigestSha256))
      || !Number.isInteger(media.value.nativeLastFrameIndex)
      || media.value.nativeFrameCount !== media.value.nativeLastFrameIndex + 1
      || media.value.nativeLastPts !== media.value.nativeLastFrameIndex / 24
      || Math.abs(media.value.nativeLastPts - (phase === 'A' ? 8 : 6))
        > 1 / 24 + 1e-8
      || acceptance.value.version !== (retake
        ? phase === 'B' && planId === B3_FRAME_V4_RECOVERY.planId
          ? 'staged-a8b6-fresh-native-acceptance-v4'
          : 'staged-a8b6-fresh-native-acceptance-v3'
        : 'staged-a8b6-fresh-native-acceptance-v1')
      || acceptance.value.planId !== phasePlanId
      || acceptance.value.phase !== phase
      || acceptance.value.taskId !== task.value.taskId
      || acceptance.value.videoSha256 !== media.value.videoSha256
      || acceptance.value.mediaSha256 !== media.sha256
      || acceptance.value.nativeFrameDigestSha256
        !== media.value.nativeFrameDigestSha256
      || acceptance.value.acceptedFrameIndex
        !== media.value.nativeLastFrameIndex
      || !Number.isInteger(acceptance.value.acceptedFrameIndex)
      || Math.abs(acceptance.value.acceptedFrameIndex / 24
        - (phase === 'A' ? 8 : 6)) > 1 / 24 + 1e-8
      || !SHA.test(String(acceptance.value.acceptedFrameSha256))
      || acceptance.value.directReview?.verdict !== 'accept'
      || acceptance.value.directReview?.reviewerMethod
        !== 'agent-direct-normal-speed-watch'
      || !retake && (acceptance.value.directReview?.audioEvidence
        !== 'provider-sound-off; final-narration-checked-separately'
        || acceptance.value.modelReview?.verdict !== 'accept'
        || !/^model-run-[\w-]+$/.test(String(
          acceptance.value.modelReview?.executionId))
        || !SHA.test(String(
          acceptance.value.modelReview?.ledgerSha256))))
      invalid(`new paid ${phase} task/native review chain changed`)
    const evidence = phase === 'A' ? AReviewEvidence : BReviewEvidence
    const direct = phase === 'A' ? ADirect : BDirect
    const frames = evidence.value.frames
    const reference = frames?.[0], nativeTail = frames?.at(-1)
    if (evidence.value.version
        !== 'staged-a8b6-fresh-native-review-evidence-v1'
      || evidence.value.planId !== phasePlanId
      || evidence.value.phase !== phase
      || evidence.value.taskId !== task.value.taskId
      || evidence.value.videoSha256 !== media.value.videoSha256
      || evidence.value.mediaSha256 !== media.sha256
      || evidence.value.nativeFrameDigestSha256
        !== media.value.nativeFrameDigestSha256
      || !Array.isArray(frames) || frames.length < 2
      || canonical(evidence.value.reviewImages)
        !== canonical(frames.map(frame => frame.url))
      || (phase === 'A'
        ? reference?.kind !== 'approved-new-first-frame'
          || reference.phase !== 'CERT' || reference.frameIndex !== -1
          || (retake
            ? reference.url !== manifest.value.compactTransport.entries
              .find(entry => entry.role === 'first_frame')?.transport?.url
              || reference.sha256
                !== manifest.value.compactTransport.entries
                  .find(entry => entry.role === 'first_frame')
                  ?.transport?.sha256
            : reference.url !== manifest.value.source.approvedFirstFrameUrl
              || reference.sha256
                !== manifest.value.source.approvedFirstFrameSha256)
        : reference?.kind !== 'accepted-A-native-tail'
          || reference.phase !== 'A'
          || reference.frameIndex !== A.value.acceptedFrameIndex
          || reference.url !== BPlan.value.sourceA?.firstFrameUrl
          || reference.sha256 !== A.value.acceptedFrameSha256
          || reference.sourceVideoSha256 !== AMedia.value.videoSha256)
      || nativeTail?.kind !== 'provider-native-frame'
      || nativeTail.phase !== phase
      || nativeTail.frameIndex !== acceptance.value.acceptedFrameIndex
      || nativeTail.sha256 !== acceptance.value.acceptedFrameSha256
      || nativeTail.sourceVideoSha256 !== media.value.videoSha256
      || !retake && (direct.value.version
          !== 'staged-a8b6-fresh-direct-review-v1'
        || direct.value.planId !== phasePlanId
        || direct.value.phase !== phase
        || direct.value.videoSha256 !== media.value.videoSha256
        || direct.value.evidenceSha256 !== evidence.sha256
        || direct.value.reviewMethod !== 'agent-direct-normal-speed-watch'
        || direct.value.reviewer !== 'Codex'
        || !Number.isFinite(Date.parse(direct.value.reviewedAt))
        || direct.value.verdict !== 'accept'
        || freshA8B6RequiredChecks(phase).some(name =>
          direct.value.checks?.[name] !== true)
        || !Array.isArray(direct.value.observations)
        || direct.value.observations.length !== frames.length
        || direct.value.observations.some((item, index) =>
          item.phase !== frames[index].phase
          || item.frameIndex !== frames[index].frameIndex
          || item.sha256 !== frames[index].sha256
          || typeof item.description !== 'string'
          || item.description.length < 12)
        || acceptance.value.evidenceSha256 !== evidence.sha256
        || acceptance.value.directReview.reportSha256 !== direct.sha256)
      || phase === 'B' && direct.value.seamVerdict !== 'accept')
      invalid(`new paid ${phase} visual review changed`)
    if (retake) {
      const v3Evidence = signed(`phase-${phase}-review-evidence-v3.json`,
        phasePlanId)
      const v3Intent = signed(`phase-${phase}-frame-model-intent-v3.json`,
        phasePlanId)
      const v3Submit = signed(`phase-${phase}-frame-model-submit-v3.json`,
        phasePlanId)
      const audio = signed(`phase-${phase}-audio-isolation-v3.json`,
        phasePlanId)
      if (phase === 'B' && planId === B3_FRAME_V4_RECOVERY.planId) {
        assertFreshA8B6CompositeReviewChainV4({ planId: phasePlanId,
          phase, manifest: manifest.value, media: media.value,
          mediaSha256: media.sha256, acceptance, evidence, direct,
          v3Evidence, v3Intent, v3Submit,
          v4Evidence: signed('phase-B-review-evidence-v4.json'),
          v4Intent: signed('phase-B-frame-model-intent-v4.json'),
          v4Submit: signed('phase-B-frame-model-submit-v4.json'),
          audio })
      } else {
        assertFreshA8B6CompositeReviewChainV3({ planId: phasePlanId,
          phase, manifest: manifest.value, media: media.value,
          mediaSha256: media.sha256, acceptance, evidence, direct,
          v3Evidence, intent: v3Intent, submit: v3Submit, audio })
      }
      for (const frame of v3Evidence.value.frames) {
        const bytes = readFileSync(freshA8B6GeneratedFile(frame.url,
          'image', root))
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8
          || sha(bytes) !== frame.sha256)
          invalid(`new paid ${phase} signed review JPEG bytes changed`)
      }
    }
    const source = value.sources[`phase${phase}`]
    if (source.taskId !== task.value.taskId
      || source.taskSha256 !== task.sha256
      || source.mediaSha256 !== media.sha256
      || source.acceptanceSha256 !== acceptance.sha256
      || source.videoUrl !== media.value.videoUrl
      || source.videoSha256 !== media.value.videoSha256
      || source.acceptedFrameIndex !== acceptance.value.acceptedFrameIndex
      || manifest.value.forbiddenSources.some(item =>
        item.sha256 === media.value.videoSha256
        || item.url === media.value.videoUrl
        || item.taskId === task.value.taskId))
      invalid(`composite ${phase} differs from new paid source`)
  }
  if (ATask.value.taskId === BTask.value.taskId
    || AMedia.value.videoSha256 === BMedia.value.videoSha256
    || BPlan.value.version !== 'staged-a8b6-fresh-B-plan-v1'
    || BPlan.value.planId !== planId
    || BPlan.value.manifestSha256 !== manifest.sha256
    || BPlan.value.sourceA?.taskId !== ATask.value.taskId
    || BPlan.value.sourceA.videoSha256 !== AMedia.value.videoSha256
    || BPlan.value.sourceA.mediaSha256 !== AMedia.sha256
    || BPlan.value.sourceA.acceptanceSha256 !== A.sha256
    || (bRetakeChild
      ? BPlan.value.sourceA.sourcePlanId !== phaseAPlanId
      : BPlan.value.sourceA.sourcePlanId !== undefined)
    || BPlan.value.sourceA.frameIndex !== A.value.acceptedFrameIndex
    || BPlan.value.sourceA.frameSha256 !== A.value.acceptedFrameSha256
    || BPlan.value.sourceA.nativeFrameDigestSha256
      !== AMedia.value.nativeFrameDigestSha256
    || BPlan.value.phaseB?.providerSeconds !== 6
    || BPlan.value.phaseB.firstFrameRole !== (bRetakeChild
      ? 'parent-accepted-A-native-tail' : 'accepted-new-A-native-tail')
    || (bRetakeChild
      ? canonical(BPlan.value.phaseB?.endFrame)
        !== canonical(manifest.value.phaseBRetake?.endFrame)
      : BPlan.value.phaseB?.endFrame !== null)
    || BPlan.value.phaseB.sound !== 'off'
    || BPlan.value.phaseBPreview?.duration !== 6
    || BPlan.value.phaseBPreview.firstFrameTransportSha256
      !== A.value.acceptedFrameSha256
    || canonical(BPlan.value.phaseBPreview.identityTransportSha256s)
      !== canonical(manifest.value.compactTransport.entries.slice(1, 3)
        .map(entry => entry.transport.sha256))
    || canonical(BPlan.value.phaseBPreview.imageTypes)
      !== canonical(bRetakeChild
        ? ['reference', 'reference', 'first_frame', 'end_frame']
        : ['reference', 'reference', 'first_frame'])
    || bRetakeChild && (BPlan.value.phaseBPreview.requestSha256
        !== manifest.value.bRetake.newBRequestSha256
      || canonical(BPlan.value.phaseBPreview)
        !== canonical(manifest.value.phaseBRetakePreview))
    || B.value.seam?.phaseAFrameIndex !== A.value.acceptedFrameIndex
    || B.value.seam.phaseAFrameSha256 !== A.value.acceptedFrameSha256
    || B.value.seam.phaseBFirstFrameIndex !== 0
    || !SHA.test(String(B.value.seam.phaseBFirstFrameSha256))
    || B.value.seam.stitchedPhaseBStartFrameIndex !== 1
    || !SHA.test(String(B.value.seam.stitchedPhaseBFirstFrameSha256))
    || B.value.seam.directVerdict !== 'accept')
    invalid('B first frame did not derive from accepted A native tail')
  const compositionKey = /^\/generated\/narrated-([a-f0-9]{64})\.mp4$/.exec(
    value.output.url)?.[1]
  if (!compositionKey
    || compositionKey !== value.narration.compositionReceiptKey)
    invalid('standard mixer6 output identity missing')
  const compositionBytes = readFileSync(path.join(root,
    '.runtime/narration-compositions', `${compositionKey}.json`))
  const composition = JSON.parse(compositionBytes.toString('utf8'))
  if (value.narration.compositionReceiptSha256 !== sha(compositionBytes)
    || composition.version !== 'narration-composition-v1'
    || composition.key !== compositionKey
    || composition.outputUrl !== value.output.url
    || composition.pictureSha256 !== value.picture.sha256
    || composition.outputSha256 !== value.output.sha256
    || composition.duration !== value.mapping.frameCount / 24
    || composition.audioRole !== 'narration'
    || composition.mixerVersion !== 6
    || canonical(composition.tracks)
      !== canonical(manifest.value.narrationTracks)
    || composition.pictureVoiceIsolation?.status
      !== 'fully-muted-unverified'
    || composition.pictureVoiceIsolation.sourceSha256
      !== value.picture.sha256
    || composition.pictureVoiceIsolation.preservedOutsideWindows !== false
    || !composition.pictureVoiceIsolation.mutedWindows?.some(window =>
      window.start <= 0 && window.end >= composition.duration))
    invalid('signed output changed its mixer6 original TTS or source mute')
  if (transfer.value.version !== 'independent-track-transfer-v1'
    || transfer.value.status !== 'confirmed'
    || transfer.value.originalUrl !== value.output.url
    || transfer.value.outputVideoSha256 !== value.output.sha256
    || transfer.value.compositionReceiptSha256 !== sha(compositionBytes)
    || transfer.value.pictureSha256 !== value.picture.sha256
    || transfer.value.mixerVersion !== 6
    || transfer.value.audioRole !== 'narration'
    || transfer.value.sourceSpeechIsolation?.status !== 'confirmed'
    || transfer.value.sourceSpeechIsolation.mode !== 'full-source-mute'
    || transfer.value.lines?.length !== 3
    || transfer.value.lines.some((line, index) =>
      line.status !== 'confirmed'
      || line.sourceWavSha256
        !== manifest.value.narrationTracks[index].sha256
      || line.fullWindow?.passed !== true
      || line.lastWordWindow?.passed !== true))
    invalid('signed decoded narration transfer changed')
  for (const item of [
    [AMedia.value.videoUrl, AMedia.value.videoSha256],
    [BMedia.value.videoUrl, BMedia.value.videoSha256],
    [BPlan.value.sourceA.firstFrameUrl,
      BPlan.value.sourceA.frameSha256],
    [value.picture.url, value.picture.sha256],
    [value.output.url, value.output.sha256],
    [manifest.value.source.approvedFirstFrameUrl,
      manifest.value.source.approvedFirstFrameSha256],
    ...(bRetakeChild ? [[manifest.value.phaseBRetake.endFrame.url,
      manifest.value.phaseBRetake.endFrame.sha256]] : []),
    ...manifest.value.narrationTracks.map(track => [track.url, track.sha256]),
  ]) {
    const file = freshA8B6GeneratedFile(item[0],
      item[0].endsWith('.mp4') ? 'video'
        : item[0].endsWith('.wav') ? 'audio' : 'image', root)
    if (sha(readFileSync(file)) !== item[1])
      invalid('fresh composite source asset bytes changed')
  }
  return { manifest: manifest.value, receipt: value,
    manifestSha256: manifest.sha256, receiptSha256: receipt.sha256 }
}
