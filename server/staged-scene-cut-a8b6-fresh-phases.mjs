/** Source-bound paid task and native-media receipts for a NEW A8+B6 take. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inspectFreshNativeVideo, extractFreshNativeJpeg } from
  './staged-scene-cut-a8b6-fresh-native.mjs'
import { readFreshA8B6PhaseAPlan, previewFreshA8B6PhaseB,
  previewFreshA8B6PhaseBRetake,
  previewFreshA8B6PhaseBSecondRetake,
  previewFreshA8B6PhaseBThirdRetake,
  readFreshA8B6Artifact, saveFreshA8B6Artifact, saveFreshA8B6Bytes,
  freshA8B6Directory, freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'

const SHA = /^[a-f0-9]{64}$/
const TASK = /^[\w-]{8,128}$/
const invalid = reason => { throw Error(`A8B6_FRESH_PHASE_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const phaseName = phase => {
  if (phase !== 'A' && phase !== 'B') invalid('phase must be A or B')
  return phase
}
const nativeSeconds = { A: 8, B: 6 }
const intentName = phase => `phase-${phaseName(phase)}-submit-intent.json`
const artifactName = (phase, kind) => `phase-${phaseName(phase)}-${kind}.json`
async function parentAcceptedASnapshot(planId, root) {
  const filename = path.join(freshA8B6Directory(planId, root),
    'manifest.json')
  const manifest = JSON.parse(await readFile(filename, 'utf8'))
  if (manifest.version !== 'staged-a8b6-fresh-A-plan-v3')
    return undefined
  const { verifyFreshA8B6BRetakeApprovalSync } = await import(
    './staged-scene-cut-a8b6-B-retake-approval.mjs')
  verifyFreshA8B6BRetakeApprovalSync(planId, root)
  const { readFreshA8B6BRetakeParentSigned } = await import(
    './staged-scene-cut-a8b6-B-retake-parent.mjs')
  return readFreshA8B6BRetakeParentSigned(
    manifest.bRetake.parentPlanId, root)
}

/** The optional retake end guide belongs to paid A only, never to B identity. */
export function selectFreshA8B6IdentityTransportEntries(transport) {
  const entries = transport?.entries
  if (!Array.isArray(entries) || ![3, 4].includes(entries.length))
    invalid('A compact transport must contain first frame and two identities')
  const roles = entries.map(entry => entry?.role)
  const expected = entries.length === 4
    ? ['first_frame', 'identity_1', 'identity_2', 'end_frame']
    : ['first_frame', 'identity_1', 'identity_2']
  if (!isDeepStrictEqual([...roles].sort(), [...expected].sort())
    || entries.some(entry => !SHA.test(String(entry?.transport?.sha256))))
    invalid('A compact transport identity roles or hashes changed')
  return ['identity_1', 'identity_2'].map(role =>
    entries.find(entry => entry.role === role))
}

async function readFreshA8B6IdentityTransportBytes(transport, root) {
  return Promise.all(selectFreshA8B6IdentityTransportEntries(transport)
    .map(async entry => {
      const bytes = await readFile(freshA8B6GeneratedFile(
        entry.transport.url, 'image', root))
      if (sha(bytes) !== entry.transport.sha256)
        invalid(`${entry.role} compact transport changed`)
      return bytes
    }))
}

/** The exact local intent is persisted before POST; ambiguous POSTs cannot repeat. */
export async function readFreshA8B6SubmitIntent(planId, phase,
  root = process.cwd()) {
  if (phase === 'A') {
    const parent = await parentAcceptedASnapshot(planId, root)
    if (parent) return { intent: parent.A.intent,
      intentSha256: parent.A.intentSha256,
      path: path.join(freshA8B6Directory(
        parent.manifest.planId, root), intentName('A')),
      manifest: parent.manifest,
      manifestSha256: parent.manifestSha256 }
  }
  const file = path.join(freshA8B6Directory(planId, root), intentName(phase))
  const bytes = await readFile(file)
  const value = JSON.parse(bytes.toString('utf8'))
  const A = await readFreshA8B6PhaseAPlan(planId, root)
  const B = phase === 'B' ? await readFreshA8B6PhaseBPlan(planId, root) : undefined
  const expected = phase === 'A' ? A.preview.requestSha256 : B.preview.requestSha256
  if (value.version !== 'staged-a8b6-fresh-paid-intent-v1'
    || value.planId !== planId || value.phase !== phase
    || value.requestSha256 !== expected
    || value.modelId !== A.manifest.providerLock.modelId
    || value.endpointSha256 !== A.manifest.providerLock.endpointSha256
    || !SHA.test(String(value.endpointSha256))
    || typeof value.endpoint !== 'string' || !/^https:\/\//.test(value.endpoint)
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.nonce !== 'string' || value.nonce.length < 8)
    invalid('paid submit intent changed')
  return { intent: value, intentSha256: sha(bytes), path: file,
    manifest: A.manifest, manifestSha256: A.manifestSha256 }
}

export async function saveFreshA8B6TaskReceipt(planId, phase,
  { taskId, submittedAt }, root = process.cwd()) {
  const { intent, intentSha256, manifest } = await readFreshA8B6SubmitIntent(
    planId, phase, root)
  if (!TASK.test(String(taskId)) || !Number.isFinite(Date.parse(submittedAt)))
    invalid('provider task identity invalid')
  if (taskId === manifest.retake?.parentTaskId
    || manifest.forbiddenSources.some(item => item.taskId === taskId))
    invalid('retake cannot reuse a rejected paid task')
  if (phase === 'B'
    && (await readFreshA8B6TaskReceipt(planId, 'A', root)).task.taskId === taskId)
    invalid('new B provider task repeats the paid A task')
  return saveFreshA8B6Artifact(planId, artifactName(phase, 'task'), {
    version: 'staged-a8b6-fresh-task-v1', planId, phase, taskId,
    requestSha256: intent.requestSha256, modelId: intent.modelId,
    endpointSha256: intent.endpointSha256, intentSha256, submittedAt,
  }, root)
}

export async function readFreshA8B6TaskReceipt(planId, phase,
  root = process.cwd()) {
  if (phase === 'A') {
    const parent = await parentAcceptedASnapshot(planId, root)
    if (parent) return { task: parent.A.task,
      taskSha256: parent.A.taskSha256,
      intent: parent.A.intent,
      manifest: parent.manifest,
      manifestSha256: parent.manifestSha256 }
  }
  const { value: task, sha256: taskSha256 } = await readFreshA8B6Artifact(
    planId, artifactName(phase, 'task'), root)
  const { intent, intentSha256, manifest, manifestSha256 } = await readFreshA8B6SubmitIntent(
    planId, phase, root)
  if (task.version !== 'staged-a8b6-fresh-task-v1'
    || task.planId !== planId || task.phase !== phase
    || !TASK.test(String(task.taskId))
    || task.requestSha256 !== intent.requestSha256
    || task.modelId !== intent.modelId
    || task.endpointSha256 !== intent.endpointSha256
    || task.intentSha256 !== intentSha256
    || !Number.isFinite(Date.parse(task.submittedAt)))
    invalid('signed paid task/intent identity changed')
  if (task.taskId === manifest.retake?.parentTaskId
    || manifest.forbiddenSources.some(item => item.taskId === task.taskId))
    invalid('signed retake reused rejected parent task')
  if (phase === 'B'
    && (await readFreshA8B6TaskReceipt(planId, 'A', root)).task.taskId
      === task.taskId)
    invalid('new B task identity repeats paid A')
  return { task, taskSha256, intent, manifest, manifestSha256 }
}

export function freshA8B6MediaUrl(planId, phase, taskId) {
  if (!SHA.test(String(planId)) || !TASK.test(String(taskId)))
    invalid('fresh media identity invalid')
  return `/generated/fresh-a8b6-${planId.slice(0, 16)}-${phaseName(phase)}-${taskId}.mp4`
}

export async function saveFreshA8B6MediaReceipt(planId, phase,
  { taskId, videoUrl, videoSha256 }, root = process.cwd()) {
  const { task, taskSha256, manifest, manifestSha256 } = await readFreshA8B6TaskReceipt(
    planId, phase, root)
  if (taskId !== task.taskId
    || videoUrl !== freshA8B6MediaUrl(planId, phase, taskId)
    || !SHA.test(String(videoSha256))) invalid('media is not new paid task output')
  const file = freshA8B6GeneratedFile(videoUrl, 'video', root)
  if (sha(await readFile(file)) !== videoSha256)
    invalid('archived provider video bytes changed')
  if (manifest.forbiddenSources.some(item => item.sha256 === videoSha256
    || item.url === videoUrl || item.taskId === taskId))
    invalid('old paid video cannot be used in fresh plan')
  if (phase === 'B') {
    const prior = await readFreshA8B6MediaReceipt(planId, 'A', root)
    if (prior.media.taskId === taskId
      || prior.media.videoSha256 === videoSha256)
      invalid('new B cannot reuse the paid A task or video bytes')
  }
  const native = await inspectFreshNativeVideo(file)
  if (Math.abs(native.lastPts - nativeSeconds[phase]) > 1 / 24 + 1e-8)
    invalid('native provider clip does not cover approved phase duration')
  return saveFreshA8B6Artifact(planId, artifactName(phase, 'media'), {
    version: 'staged-a8b6-fresh-native-media-v1', planId, phase, taskId,
    taskSha256, videoUrl, videoSha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    nativeFrameCount: native.frameCount, nativeLastFrameIndex: native.lastFrameIndex,
    nativeLastPts: native.lastPts, nativeFps: 24,
  }, root)
}

export async function readFreshA8B6MediaReceipt(planId, phase,
  root = process.cwd()) {
  if (phase === 'A') {
    const parent = await parentAcceptedASnapshot(planId, root)
    if (parent) return { media: parent.A.media,
      mediaSha256: parent.A.mediaSha256,
      native: parent.A.native,
      manifest: parent.manifest,
      manifestSha256: parent.manifestSha256 }
  }
  const { task, taskSha256, manifest, manifestSha256 } = await readFreshA8B6TaskReceipt(
    planId, phase, root)
  const { value: media, sha256: mediaSha256 } = await readFreshA8B6Artifact(
    planId, artifactName(phase, 'media'), root)
  if (media.version !== 'staged-a8b6-fresh-native-media-v1'
    || media.planId !== planId || media.phase !== phase
    || media.taskId !== task.taskId || media.taskSha256 !== taskSha256
    || media.videoUrl !== freshA8B6MediaUrl(planId, phase, task.taskId)
    || !SHA.test(String(media.videoSha256)))
    invalid('signed native media identity changed')
  const file = freshA8B6GeneratedFile(media.videoUrl, 'video', root)
  if (sha(await readFile(file)) !== media.videoSha256)
    invalid('archived native video changed')
  if (manifest.forbiddenSources.some(item => item.sha256 === media.videoSha256
    || item.url === media.videoUrl || item.taskId === media.taskId))
    invalid('historical A/B footage was reused')
  if (phase === 'B') {
    const prior = await readFreshA8B6MediaReceipt(planId, 'A', root)
    if (prior.media.taskId === media.taskId
      || prior.media.videoSha256 === media.videoSha256)
      invalid('new B reused the paid A task or video bytes')
  }
  const native = await inspectFreshNativeVideo(file)
  if (Math.abs(native.lastPts - nativeSeconds[phase]) > 1 / 24 + 1e-8
    || media.nativeFps !== 24
    || media.nativeFrameDigestSha256 !== native.frameDigestSha256
    || media.nativeFrameCount !== native.frameCount
    || media.nativeLastFrameIndex !== native.lastFrameIndex
    || media.nativeLastPts !== native.lastPts)
    invalid('native source frames or PTS changed')
  return { media, mediaSha256, native, manifest, manifestSha256 }
}

/** A review receipt is deliberately separate from model/provider success. */
export async function readFreshA8B6Acceptance(planId, phase,
  root = process.cwd()) {
  if (phase === 'A') {
    const parent = await parentAcceptedASnapshot(planId, root)
    if (parent) return parent.A
  }
  const { media, mediaSha256, native } = await readFreshA8B6MediaReceipt(
    planId, phase, root)
  const { value: acceptance, sha256: acceptanceSha256 } =
    await readFreshA8B6Artifact(planId, artifactName(phase, 'acceptance'), root)
  if (acceptance.version === 'staged-a8b6-fresh-native-acceptance-v4') {
    const review = await import('./staged-scene-cut-a8b6-fresh-acceptance-v4.mjs')
    return review.readFreshA8B6AcceptanceV4(planId, phase, root,
      { media, mediaSha256, native, acceptance, acceptanceSha256 })
  }
  if (acceptance.version === 'staged-a8b6-fresh-native-acceptance-v3') {
    const review = await import('./staged-scene-cut-a8b6-fresh-review-v3.mjs')
    return review.readFreshA8B6AcceptanceV3(planId, phase, root,
      { media, mediaSha256, native, acceptance, acceptanceSha256 })
  }
  const index = acceptance.acceptedFrameIndex
  if (acceptance.version !== 'staged-a8b6-fresh-native-acceptance-v1'
    || acceptance.planId !== planId || acceptance.phase !== phase
    || acceptance.taskId !== media.taskId
    || acceptance.videoSha256 !== media.videoSha256
    || acceptance.mediaSha256 !== mediaSha256
    || acceptance.nativeFrameDigestSha256 !== native.frameDigestSha256
    || !Number.isInteger(index)
    || index !== native.lastFrameIndex
    || Math.abs(index / 24 - nativeSeconds[phase]) > 1 / 24 + 1e-8
    || acceptance.directReview?.verdict !== 'accept'
    || acceptance.modelReview?.verdict !== 'accept'
    || acceptance.directReview?.reviewerMethod
      !== 'agent-direct-normal-speed-watch'
    || acceptance.directReview?.audioEvidence
      !== 'provider-sound-off; final-narration-checked-separately'
    || !SHA.test(String(acceptance.directReview?.reportSha256))
    || !SHA.test(String(acceptance.modelReview?.ledgerSha256)))
    invalid('native A/B review acceptance is absent or not source-bound')
  const frame = await extractFreshNativeJpeg(
    freshA8B6GeneratedFile(media.videoUrl, 'video', root), index)
  if (acceptance.acceptedFrameSha256 !== frame.sha256)
    invalid('accepted native tail frame changed')
  const review = await import('./staged-scene-cut-a8b6-fresh-review.mjs')
  const [evidence, direct, model] = await Promise.all([
    review.readFreshA8B6ReviewEvidence(planId, phase, root),
    review.readFreshA8B6ManualReview(planId, phase, root),
    review.verifyFreshA8B6ModelReviewLedger(planId, phase,
      acceptance.modelReview?.executionId, root),
  ])
  if (acceptance.evidenceSha256 !== evidence.evidenceSha256
    || acceptance.directReview.reportSha256 !== direct.reportSha256
    || acceptance.modelReview.ledgerSha256 !== model.ledgerSha256
    || acceptance.modelReview.promptSha256 !== model.promptSha256
    || acceptance.modelReview.requestKey !== model.requestKey)
    invalid('accepted native source lost direct or independent model review')
  if (phase === 'B') {
    const A = await readFreshA8B6Acceptance(planId, 'A', root)
    const B = await readFreshA8B6PhaseBPlan(planId, root)
    const zero = await extractFreshNativeJpeg(
      freshA8B6GeneratedFile(media.videoUrl, 'video', root), 0)
    const one = await extractFreshNativeJpeg(
      freshA8B6GeneratedFile(media.videoUrl, 'video', root), 1)
    if (B.plan.sourceA.acceptanceSha256 !== A.acceptanceSha256
      || acceptance.seam?.phaseAFrameIndex !== A.acceptance.acceptedFrameIndex
      || acceptance.seam.phaseAFrameSha256 !== A.acceptance.acceptedFrameSha256
      || acceptance.seam.phaseBFirstFrameIndex !== 0
      || acceptance.seam.phaseBFirstFrameSha256 !== zero.sha256
      || acceptance.seam.stitchedPhaseBStartFrameIndex !== 1
      || acceptance.seam.stitchedPhaseBFirstFrameSha256 !== one.sha256
      || acceptance.seam.directVerdict !== 'accept'
      || direct.report.seamVerdict !== 'accept')
      invalid('signed native A→B seam did not preserve actual accepted frames')
  }
  return { acceptance, acceptanceSha256, media, mediaSha256, native }
}

/** B starts from accepted A's exact native tail, with no original end-frame. */
async function prepareFreshA8B6PhaseB(planId, root) {
  const A = await readFreshA8B6PhaseAPlan(planId, root)
  const bRetake = A.manifest.version === 'staged-a8b6-fresh-A-plan-v3'
  const accepted = await readFreshA8B6Acceptance(planId, 'A', root)
  const Afile = freshA8B6GeneratedFile(accepted.media.videoUrl, 'video', root)
  const tail = await extractFreshNativeJpeg(Afile,
    accepted.acceptance.acceptedFrameIndex)
  const url = `/generated/fresh-a8b6-${planId.slice(0, 16)}-A-f${accepted.acceptance.acceptedFrameIndex}-${tail.sha256.slice(0, 16)}.jpg`
  const identity = await readFreshA8B6IdentityTransportBytes(
    A.manifest.compactTransport, root)
  let guide
  if (bRetake) {
    guide = await readFile(freshA8B6GeneratedFile(
      A.manifest.phaseBRetake.endFrame.url, 'image', root))
    if (sha(guide) !== A.manifest.phaseBRetake.endFrame.sha256)
      invalid('B retake target guide changed')
  }
  const preview = bRetake
    ? A.manifest.bRetake.retakeOrdinal === 3
      ? previewFreshA8B6PhaseBThirdRetake(tail.bytes, identity, guide)
      : A.manifest.bRetake.previousChild
        ? previewFreshA8B6PhaseBSecondRetake(tail.bytes, identity, guide)
        : previewFreshA8B6PhaseBRetake(tail.bytes, identity, guide)
    : previewFreshA8B6PhaseB(tail.bytes, identity)
  if (bRetake && preview.requestSha256
    !== A.manifest.bRetake.newBRequestSha256)
    invalid('signed B-only retake request changed')
  const plan = { version: 'staged-a8b6-fresh-B-plan-v1', planId,
    manifestSha256: A.manifestSha256,
    sourceA: { taskId: accepted.media.taskId,
      videoSha256: accepted.media.videoSha256,
      mediaSha256: accepted.mediaSha256,
      acceptanceSha256: accepted.acceptanceSha256,
      frameIndex: accepted.acceptance.acceptedFrameIndex,
      frameSha256: tail.sha256, nativeFrameDigestSha256:
        accepted.native.frameDigestSha256,
      firstFrameUrl: url,
      ...(bRetake ? { sourcePlanId: A.manifest.bRetake.parentPlanId }
        : {}) },
    phaseB: { providerSeconds: 6, nativeFps: 24,
      firstFrameRole: bRetake ? 'parent-accepted-A-native-tail'
        : 'accepted-new-A-native-tail',
      endFrame: bRetake ? A.manifest.phaseBRetake.endFrame : null,
      sound: 'off', acceptance: 'pending-native-review' },
    phaseBPreview: { ...preview, request: undefined },
    acceptanceState: 'B-request-ready-only; no provider task or media accepted',
    sourceAFrameBytes: tail.bytes }
  return { plan, preview }
}

export async function planFreshA8B6PhaseB(planId, root = process.cwd()) {
  return (await prepareFreshA8B6PhaseB(planId, root)).plan
}

export async function saveFreshA8B6PhaseBPlan(planId, plan,
  root = process.cwd()) {
  if (plan?.planId !== planId || !Buffer.isBuffer(plan.sourceAFrameBytes))
    invalid('B plan or accepted native A frame missing')
  const { sourceAFrameBytes, ...body } = plan
  const current = await planFreshA8B6PhaseB(planId, root)
  const { sourceAFrameBytes: currentBytes, ...expected } = current
  if (!isDeepStrictEqual(body, expected)
    || !sourceAFrameBytes.equals(currentBytes))
    invalid('B plan differs from accepted original-speed A tail')
  await saveFreshA8B6Bytes(freshA8B6GeneratedFile(body.sourceA.firstFrameUrl,
    'image', root), sourceAFrameBytes)
  return saveFreshA8B6Artifact(planId, 'phase-B-plan.json', body, root)
}

export async function readFreshA8B6PhaseBPlan(planId, root = process.cwd()) {
  const { value: plan, sha256: planSha256 } = await readFreshA8B6Artifact(
    planId, 'phase-B-plan.json', root)
  const { plan: current, preview } = await prepareFreshA8B6PhaseB(
    planId, root)
  const { sourceAFrameBytes, ...expected } = current
  if (canonical({ ...plan, signature: undefined }) !== canonical(expected)
    || sha(await readFile(freshA8B6GeneratedFile(plan.sourceA.firstFrameUrl,
      'image', root))) !== sha(sourceAFrameBytes))
    invalid('signed B request or exact native A first frame changed')
  return { plan, planSha256, preview }
}
