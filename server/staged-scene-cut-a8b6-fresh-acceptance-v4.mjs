/** Forward-only B3 acceptance after the narrow v4 sampled-frame clarification.
 * The signed v3 uncertainty is provenance, not an accepted visual review.
 * The full 1x watch and source-audio isolation remain independent gates. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extractFreshNativeJpeg } from
  './staged-scene-cut-a8b6-fresh-native.mjs'
import { freshA8B6GeneratedFile, readFreshA8B6Artifact,
  saveFreshA8B6Artifact } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6Acceptance, readFreshA8B6MediaReceipt,
  readFreshA8B6PhaseBPlan } from
  './staged-scene-cut-a8b6-fresh-phases.mjs'
import { readFreshA8B6AudioIsolationV3 } from
  './staged-scene-cut-a8b6-fresh-audio-v3.mjs'
import { assertFreshA8B6PlaybackReportV3,
  freshA8B6PlaybackChecksV3 } from
  './staged-scene-cut-a8b6-fresh-review-v3.mjs'
import { B3_FRAME_V4_RECOVERY,
  verifyFreshA8B6FrameModelLedgerV4 } from
  './staged-scene-cut-a8b6-fresh-review-v4.mjs'

const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_FRESH_ACCEPT_V4_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

function assertB3(planId, phase) {
  if (planId !== B3_FRAME_V4_RECOVERY.planId || phase !== 'B')
    fail('v4 acceptance is limited to the exact B3 plan and phase')
}

const OLD_GUARD_CHECK = 'guardsContinueWithdrawalWithoutRegrab'
const B3_GUARD_CHECK = 'guardsRemainAtWatchPostsWithoutContact'

export function freshA8B6PlaybackChecksV4() {
  return freshA8B6PlaybackChecksV3('B').map(name =>
    name === OLD_GUARD_CHECK ? B3_GUARD_CHECK : name)
}

/** B3's request keeps the guards on watch. Reuse the unchanged v3 playback
 * structure only after replacing that single incompatible action check. */
export function assertFreshA8B6PlaybackReportV4(report, context) {
  assertB3(context?.planId, context?.phase)
  const expected = freshA8B6PlaybackChecksV4()
  const keys = Object.keys(report?.checks ?? {})
  if (report?.version !== 'staged-a8b6-fresh-playback-review-v4'
    || keys.includes(OLD_GUARD_CHECK)
    || canonical(keys.sort()) !== canonical([...expected].sort())
    || report.checks[B3_GUARD_CHECK] !== true)
    fail('B3 playback must report guards holding watch posts without contact')
  const legacyShape = { ...report,
    version: 'staged-a8b6-fresh-playback-review-v3',
    checks: { ...report.checks,
      [OLD_GUARD_CHECK]: report.checks[B3_GUARD_CHECK] } }
  delete legacyShape.checks[B3_GUARD_CHECK]
  assertFreshA8B6PlaybackReportV3(legacyShape, context)
  return true
}

async function readManualContext(planId, phase, modelExecutionId, root,
  preloadedMedia) {
  assertB3(planId, phase)
  const { media, mediaSha256, native } = preloadedMedia?.media
    ? preloadedMedia
    : await readFreshA8B6MediaReceipt(planId, phase, root)
  const model = await verifyFreshA8B6FrameModelLedgerV4(planId, phase,
    modelExecutionId, root)
  const audio = await readFreshA8B6AudioIsolationV3(planId, phase, root)
  if (media.videoSha256 !== B3_FRAME_V4_RECOVERY.videoSha256
    || model.evidenceSha256 == null
    || audio.receipt.videoSha256 !== media.videoSha256
    || audio.receipt.mediaSha256 !== mediaSha256
    || audio.receipt.nativeFrameDigestSha256
      !== native.frameDigestSha256)
    fail('v4 frame review or v3 source-audio isolation changed video')
  return { planId, phase, media, mediaSha256, native,
    evidenceSha256: model.evidenceSha256, model,
    audioIsolationSha256: audio.receiptSha256 }
}

export async function saveFreshA8B6PlaybackReviewV4(planId, phase,
  report, root = process.cwd()) {
  const context = await readManualContext(planId, phase,
    report?.frameModelExecutionId, root)
  assertFreshA8B6PlaybackReportV4(report, context)
  return saveFreshA8B6Artifact(planId, 'phase-B-manual-review.json',
    report, root)
}

export async function readFreshA8B6PlaybackReviewV4(planId, phase,
  root = process.cwd(), preloadedMedia) {
  assertB3(planId, phase)
  const { value: report, sha256: reportSha256 } =
    await readFreshA8B6Artifact(planId, 'phase-B-manual-review.json', root)
  const context = await readManualContext(planId, phase,
    report.frameModelExecutionId, root, preloadedMedia)
  assertFreshA8B6PlaybackReportV4(report, context)
  return { report, reportSha256, context }
}

async function readB3Seam(planId, report, media, root) {
  const A = await readFreshA8B6Acceptance(planId, 'A', root)
  const B = await readFreshA8B6PhaseBPlan(planId, root)
  const videoFile = freshA8B6GeneratedFile(media.videoUrl, 'video', root)
  const [zero, one] = await Promise.all([0, 1].map(index =>
    extractFreshNativeJpeg(videoFile, index)))
  if (A.acceptance.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || B.plan.sourceA.acceptanceSha256 !== A.acceptanceSha256
    || B.plan.sourceA.frameSha256 !== A.acceptance.acceptedFrameSha256
    || report.seamVerdict !== 'accept')
    fail('v4 B does not continue the original accepted A native tail')
  return { phaseAFrameIndex: A.acceptance.acceptedFrameIndex,
    phaseAFrameSha256: A.acceptance.acceptedFrameSha256,
    phaseBFirstFrameIndex: 0, phaseBFirstFrameSha256: zero.sha256,
    stitchedPhaseBStartFrameIndex: 1,
    stitchedPhaseBFirstFrameSha256: one.sha256,
    directVerdict: report.seamVerdict }
}

/** Exact signed body; extra fields or a substituted earlier uncertain ledger
 * cannot become an acceptance when the reader recomputes this object. */
export function buildFreshA8B6AcceptanceV4({ planId, phase, media,
  mediaSha256, native, evidenceSha256, model, audioIsolationSha256,
  reportSha256, acceptedFrameSha256, seam }) {
  assertB3(planId, phase)
  if (media?.videoSha256 !== B3_FRAME_V4_RECOVERY.videoSha256
    || !SHA.test(String(mediaSha256))
    || !SHA.test(String(evidenceSha256))
    || !SHA.test(String(audioIsolationSha256))
    || !SHA.test(String(reportSha256))
    || !SHA.test(String(acceptedFrameSha256))
    || native?.lastFrameIndex !== media.nativeLastFrameIndex
    || Math.abs(native.lastPts - 6) > 1 / 24 + 1e-8
    || model?.accepted !== true
    || model?.evidenceSha256 !== evidenceSha256
    || model?.priorV3?.executionId !== B3_FRAME_V4_RECOVERY.v3ExecutionId
    || model.priorV3.ledgerSha256
      !== B3_FRAME_V4_RECOVERY.v3LedgerSha256
    || model.priorV3.evidenceSha256
      !== B3_FRAME_V4_RECOVERY.v3EvidenceSha256
    || !/^model-run-[\w-]+$/.test(String(model.row?.id))
    || !SHA.test(String(model.ledgerSha256))
    || !SHA.test(String(model.promptSha256))
    || typeof model.requestKey !== 'string'
    || !model.requestKey.startsWith(
      `staged-a8b6-fresh-frame-v4:${planId}:B:${media.videoSha256}:`)
    || seam?.directVerdict !== 'accept')
    fail('v4 acceptance lacks exact B3 native, model, watch or audio proof')
  return { version: 'staged-a8b6-fresh-native-acceptance-v4',
    planId, phase, taskId: media.taskId,
    videoSha256: media.videoSha256, mediaSha256,
    nativeFrameDigestSha256: native.frameDigestSha256,
    acceptedFrameIndex: native.lastFrameIndex,
    acceptedFrameSha256, evidenceSha256,
    priorV3: model.priorV3,
    directReview: { verdict: 'accept', reportSha256,
      reviewerMethod: 'agent-direct-normal-speed-watch', playbackRate: 1 },
    frameModelReview: { verdict: 'accept', executionId: model.row.id,
      ledgerSha256: model.ledgerSha256,
      promptSha256: model.promptSha256,
      requestKey: model.requestKey },
    audioIsolation: { verdict: 'accept',
      receiptSha256: audioIsolationSha256 }, seam }
}

export async function saveFreshA8B6AcceptanceV4(planId, phase,
  { frameModelExecutionId, reportSha256, acceptedFrameIndex },
  root = process.cwd()) {
  assertB3(planId, phase)
  const { report, reportSha256: savedReportSha256, context } =
    await readFreshA8B6PlaybackReviewV4(planId, phase, root)
  const { media, native, model } = context
  if (frameModelExecutionId !== model.row.id
    || reportSha256 !== savedReportSha256
    || acceptedFrameIndex !== native.lastFrameIndex)
    fail('v4 acceptance requires exact original native tail and 1x watch')
  const tail = await extractFreshNativeJpeg(freshA8B6GeneratedFile(
    media.videoUrl, 'video', root), acceptedFrameIndex)
  const seam = await readB3Seam(planId, report, media, root)
  const body = buildFreshA8B6AcceptanceV4({ ...context,
    reportSha256, acceptedFrameSha256: tail.sha256, seam })
  return saveFreshA8B6Artifact(planId, 'phase-B-acceptance.json', body, root)
}

export async function readFreshA8B6AcceptanceV4(planId, phase,
  root = process.cwd(), preloaded) {
  assertB3(planId, phase)
  const { media, mediaSha256, native } = preloaded?.media
    ? preloaded : await readFreshA8B6MediaReceipt(planId, phase, root)
  const { value: acceptance, sha256: acceptanceSha256 } =
    preloaded?.acceptance ? { value: preloaded.acceptance,
      sha256: preloaded.acceptanceSha256 }
      : await readFreshA8B6Artifact(planId,
        'phase-B-acceptance.json', root)
  const manual = await readFreshA8B6PlaybackReviewV4(planId, phase,
    root, { media, mediaSha256, native })
  const videoFile = freshA8B6GeneratedFile(media.videoUrl, 'video', root)
  const [tail, videoBytes, seam] = await Promise.all([
    extractFreshNativeJpeg(videoFile, native.lastFrameIndex),
    readFile(videoFile),
    readB3Seam(planId, manual.report, media, root),
  ])
  const expected = buildFreshA8B6AcceptanceV4({ ...manual.context,
    reportSha256: manual.reportSha256,
    acceptedFrameSha256: tail.sha256, seam })
  const { signature: _signature, ...body } = acceptance
  void _signature
  if (canonical(body) !== canonical(expected)
    || sha(videoBytes) !== media.videoSha256)
    fail('signed v4 acceptance lost native video, watch, model or audio proof')
  return { acceptance, acceptanceSha256, media, mediaSha256, native }
}
