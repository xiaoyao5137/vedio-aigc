/** Source-bound, read-only proposal for reusing the original paid scene-02
 * video. It never treats an old provider request as if it used a new first
 * frame, and never grants schema180 media acceptance by itself. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { inspectOriginalSecondShotSource,
  inspectNewFirstShotForHistoricalReuse } from '../scripts/audit-original-second-shot-media-reuse.mjs'

const SHA = /^[a-f0-9]{64}$/
const fail = message => { throw Error(`ORIGINAL_SCENE2_HISTORICAL_ADMISSION_INVALID: ${message}`) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
const digest = value => hash(Buffer.from(JSON.stringify(ordered(value))))
const assertHash = (value, label) => { if (!SHA.test(String(value))) fail(`${label} is not SHA-256`) }
const local = (root, url, extension) => {
  if (typeof url !== 'string' || !new RegExp(`^/generated/[\\w.-]+\\.${extension}$`, 'i').test(url))
    fail('admission asset is not local generated media')
  return path.join(root, 'public', url.slice(1))
}

/** Pure projection from independently audited records. The returned status is
 * pending even if a caller later supplies positive review text. */
export function buildOriginalScene2HistoricalReviewProposal(historical, first) {
  if (historical?.version !== 'original-scene2-historical-media-audit-v1'
    || historical.status !== 'historical-paid-candidate-only'
    || historical.schema180DirectAdmission !== false
    || historical.originalExecutionId !== 'record-4x5m31'
    || historical.originalResultMd5 !== '74e5e2f8afcf8f829694aef350629950'
    || historical.originalCandidateSha256 !== '6dbe6da0108dfcc1a22f74ef5556306dbc8382b185ba1d853340d7c10beb8cad'
    || historical.originalAcceptedScriptSha256 !== 'a0bd06afdcf6f8019f36c0a5d44b9209d27ec97673550090d72faea1ff31a8e3'
    || historical.oldProvider?.modelId !== 'keling3'
    || historical.oldProvider?.taskId !== '933544686269653023'
    || historical.oldProvider?.archivedUrl !== '/generated/verified-bb6bc95cbd10cff9b815.mp4'
    || historical.oldProvider?.archivedSha256 !== '3546388b7925d4fcade3df94e34238a8e5cc185df4fbabf4f35bc139af1fabd8'
    || historical.native?.fps !== 24 || historical.native?.nativeFrameCount !== 241
    || historical.native?.firstPts !== 0 || historical.native?.lastPts !== 10
    || first?.firstShotReady !== true || first.blockers?.length !== 0
    || !/^record-[\w-]+$/.test(String(first.sourceExecutionId))
    || !/^[a-f0-9]{32}$/.test(String(first.sourceResultMd5))
    || !/^\/generated\/[\w.-]+\.jpg$/i.test(String(first.newFirstActualTailUrl)))
    fail('historical video or new first-shot acceptance is not pinned')
  for (const [label, value] of Object.entries({
    remoteUrl: historical.oldProvider.remoteUrlSha256,
    nativeFrames: historical.native.nativeFrameDigestSha256,
    nativeFirst: historical.native.nativeFirstJpegSha256,
    nativeLast: historical.native.nativeLastJpegSha256,
    nativeAudio: historical.native.decodedAudioPcmSha256,
    firstTail: first.newFirstActualTailSha256,
    firstVideo: first.newFirstVideoSha256,
    firstAcceptance: first.newFirstMediaAcceptSha256,
    firstCertificate: first.newFirstCertificateSha256,
  })) assertHash(value, label)
  if (historical.originalSpeech?.planned !== '张飞：我们的大军已经到了，你为什么不投降，还要抵抗？'
    || historical.originalSpeech?.voiceId !== '933124714380816393'
    || historical.originalSpeech?.alignedStart !== 3.05
    || historical.originalSpeech?.alignedEnd !== 9.51
    || historical.originalSpeech?.lipSyncVerified !== false
    || historical.originalSpeech?.speakerIdentityVerified !== false)
    fail('original dialogue evidence changed or was overstated')

  const source = { originalExecutionId: historical.originalExecutionId,
    originalResultMd5: historical.originalResultMd5,
    originalCandidateSha256: historical.originalCandidateSha256,
    originalAcceptedScriptSha256: historical.originalAcceptedScriptSha256,
    originalPaidTask: { providerModelId: historical.oldProvider.modelId,
      taskId: historical.oldProvider.taskId,
      remoteUrlSha256: historical.oldProvider.remoteUrlSha256,
      archivedUrl: historical.oldProvider.archivedUrl,
      archivedSha256: historical.oldProvider.archivedSha256 },
    oldNative: { ...historical.native },
    newFirst: { executionId: first.sourceExecutionId,
      resultMd5: first.sourceResultMd5,
      acceptedVideoUrl: first.newFirstVideoUrl,
      acceptedVideoSha256: first.newFirstVideoSha256,
      mediaAcceptSha256: first.newFirstMediaAcceptSha256,
      certificateSha256: first.newFirstCertificateSha256,
      actualTailUrl: first.newFirstActualTailUrl,
      actualTailSha256: first.newFirstActualTailSha256 },
    originalVoiceId: historical.originalSpeech.voiceId }
  const sourceSha256 = digest(source)
  const hooks = {
    boundaryVisual: { version: 'historical-scene2-review-hook-v1', sourceSha256,
      kind: 'native-boundary-visual',
      firstTailSha256: source.newFirst.actualTailSha256,
      secondNativeFirstJpegSha256: source.oldNative.nativeFirstJpegSha256,
      secondNativeFrameDigestSha256: source.oldNative.nativeFrameDigestSha256,
      requiredAttachmentSha256s: [source.newFirst.actualTailSha256,
        source.oldNative.nativeFirstJpegSha256],
      requiredFindings: ['same-two-characters-and-costumes', 'front-wrists-remain-bound',
        'no-new-binding-or-escort-action', 'courtyard-cut-matches-approved-ellipsis'] },
    wholeVisual: { version: 'historical-scene2-review-hook-v1', sourceSha256,
      kind: 'whole-native-sequence-visual',
      secondNativeFrameDigestSha256: source.oldNative.nativeFrameDigestSha256,
      nativeFrameCount: 241,
      requiredAttachmentSha256s: [source.oldNative.nativeFrameDigestSha256,
        source.oldNative.nativeFirstJpegSha256, source.oldNative.nativeLastJpegSha256],
      requiredNativeFrameIndices: [0, 12, 36, 58, 72, 180, 222, 229, 238, 240],
      requiredFindings: ['guards-seat-low-step-courtyard', 'zhang-lean-and-eye-line',
        'wrists-stay-bound', 'same-side-camera-no-reverse-cut', 'actual-tail-state'] },
    dialogueAudio: { version: 'historical-scene2-review-hook-v1', sourceSha256,
      kind: 'native-dialogue-and-seam-audio',
      secondDecodedAudioPcmSha256: source.oldNative.decodedAudioPcmSha256,
      firstAcceptedVideoSha256: source.newFirst.acceptedVideoSha256,
      requiredAttachmentSha256s: [source.oldNative.decodedAudioPcmSha256,
        source.newFirst.acceptedVideoSha256],
      plannedLine: historical.originalSpeech.planned, voiceId: source.originalVoiceId,
      historicalAsrWindow: { start: 3.05, end: 9.51 },
      requiredFindings: ['zhang-is-actual-speaker', 'complete-words-and-pronunciation',
        'visible-mouth-timing', 'no-extra-speech', 'half-second-readable-tail',
        'first-to-second-cut-no-audio-overlap-or-clipping'] },
  }
  const reviewBindings = Object.fromEntries(Object.entries(hooks).map(([key, hook]) => [key, digest(hook)]))
  const proposal = { version: 'original-scene2-historical-admission-proposal-v1', source,
    sourceSha256, reviewHooks: hooks, reviewBindingSha256s: reviewBindings,
    workflow: { currentSchema: 180, directSchema180Admission: false,
      requiresManagedHistoricalImportPolicy: true,
      oldProviderRequestUsedNewFirstFrame: false,
      freshEvidenceStartsAtNode: 109,
      requiresManagedPolicyBeforeNode115: true,
      newScene2ScriptMustPassNodes: [65, 66, 67],
      historicalMediaWouldReplaceNode: 108,
      freshMediaReviewNodes: [109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120] },
    status: 'pending-independent-review-and-policy-admission' }
  return { proposal, proposalSha256: digest(proposal), providerCalls: 0,
    databaseWrites: 0, historicalVideoAccepted: false }
}

/** A structurally filled report is still only a report. Independent model
 * ledger IDs and human review hashes must be verified by a later read-only
 * ledger adapter before any managed workflow migration can admit this media. */
export function inspectOriginalScene2ReviewEnvelope(prepared, reports) {
  const { proposal, proposalSha256 } = prepared ?? {}
  if (proposal?.version !== 'original-scene2-historical-admission-proposal-v1'
    || digest(proposal) !== proposalSha256 || proposal.status !== 'pending-independent-review-and-policy-admission')
    fail('source-bound proposal was changed')
  const missing = []
  for (const [key, expected] of Object.entries(proposal.reviewHooks)) {
    const report = reports?.[key]
    if (report?.version !== 'historical-scene2-independent-review-v1'
      || report.kind !== expected.kind
      || report.proposalSha256 !== proposalSha256
      || report.reviewBindingSha256 !== proposal.reviewBindingSha256s[key]
      || report.verdict !== 'accept' || report.manualVerdict !== 'accept'
      || JSON.stringify(report.reviewedAttachmentSha256s)
        !== JSON.stringify(expected.requiredAttachmentSha256s)
      || expected.requiredNativeFrameIndices
        && expected.requiredNativeFrameIndices.some(index =>
          !report.reviewedNativeFrameIndices?.includes(index))
      || key === 'dialogueAudio'
        && (!Number.isFinite(report.observedSpeechEnd)
          || report.observedSpeechEnd > 9.54 || report.observedSpeechEnd < 0)
      || !/^model-run-[\w-]+$/.test(String(report.modelExecutionId))
      || !SHA.test(String(report.modelLedgerSha256))
      || !SHA.test(String(report.manualReportSha256))
      || !Array.isArray(report.findings)
      || expected.requiredFindings.some(name => !report.findings.some(item => item.name === name
        && item.result === 'confirmed' && typeof item.evidence === 'string' && item.evidence.trim())))
      missing.push(key)
  }
  return { version: 'original-scene2-historical-review-envelope-v1', proposalSha256,
    reviewEnvelopeComplete: missing.length === 0, missingReviewHooks: missing,
    modelLedgersIndependentlyVerified: false, manualReportsIndependentlyVerified: false,
    schema180DirectAdmission: false, historicalVideoAccepted: false,
    next: missing.length ? 'complete-native-boundary-visual-audio-reviews'
      : 'verify-independent-ledgers-then-add-managed-historical-import-policy' }
}

/** Deep local audit. All DB rows come from the caller; this module performs no
 * query, provider request, filesystem write, or workflow mutation. */
export function prepareOriginalScene2HistoricalAdmission(originalRow, newFirstRow, parentRow,
  root = process.cwd()) {
  const historical = inspectOriginalSecondShotSource(originalRow, root)
  const first = inspectNewFirstShotForHistoricalReuse(newFirstRow, originalRow, parentRow, root)
  if (!first.firstShotReady) return { status: 'blocked-first-shot', historical,
    firstShot: first, providerCalls: 0, databaseWrites: 0,
    schema180DirectAdmission: false, historicalVideoAccepted: false }
  const result = buildOriginalScene2HistoricalReviewProposal(historical, first)
  const sourceState = decodeExecutionState(newFirstRow.result)
  const certificateSha = sceneCutRebindSha256(sourceState.nodeRuns[50].output)
  if (result.proposal.source.newFirst.certificateSha256 !== certificateSha)
    fail('new first-shot signed certificate changed')
  const archiveFile = local(root, result.proposal.source.originalPaidTask.archivedUrl, 'mp4')
  const tailFile = local(root, result.proposal.source.newFirst.actualTailUrl, 'jpe?g')
  if (hash(readFileSync(archiveFile)) !== result.proposal.source.originalPaidTask.archivedSha256
    || hash(readFileSync(tailFile)) !== result.proposal.source.newFirst.actualTailSha256)
    fail('local source media changed after deep audit')
  return { status: 'pending-independent-review-and-policy-admission', ...result }
}
