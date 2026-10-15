import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOriginalScene2HistoricalReviewProposal,
  inspectOriginalScene2ReviewEnvelope } from '../server/original-scene2-historical-admission.mjs'

const sha = (letter: string) => letter.repeat(64)
const fixture = () => ({
  historical: {
    version: 'original-scene2-historical-media-audit-v1', status: 'historical-paid-candidate-only',
    schema180DirectAdmission: false, originalExecutionId: 'record-4x5m31',
    originalResultMd5: '74e5e2f8afcf8f829694aef350629950',
    originalCandidateSha256: '6dbe6da0108dfcc1a22f74ef5556306dbc8382b185ba1d853340d7c10beb8cad',
    originalAcceptedScriptSha256: 'a0bd06afdcf6f8019f36c0a5d44b9209d27ec97673550090d72faea1ff31a8e3',
    oldProvider: { modelId: 'keling3', taskId: '933544686269653023', remoteUrlSha256: sha('a'),
      archivedUrl: '/generated/verified-bb6bc95cbd10cff9b815.mp4',
      archivedSha256: '3546388b7925d4fcade3df94e34238a8e5cc185df4fbabf4f35bc139af1fabd8' },
    native: { fps: 24, nativeFrameCount: 241, firstPts: 0, lastPts: 10,
      nativeFrameDigestSha256: sha('b'), nativeFirstJpegSha256: sha('c'),
      nativeLastJpegSha256: sha('d'), decodedAudioPcmSha256: sha('e') },
    originalSpeech: { planned: '张飞：我们的大军已经到了，你为什么不投降，还要抵抗？',
      voiceId: '933124714380816393', alignedStart: 3.05, alignedEnd: 9.51,
      lipSyncVerified: false, speakerIdentityVerified: false },
  },
  first: { firstShotReady: true, blockers: [],
    sourceExecutionId: 'record-original-shot1-source-bound-composite-test',
    sourceResultMd5: 'f'.repeat(32), newFirstActualTailUrl: '/generated/actual-tail.jpg',
    newFirstActualTailSha256: sha('1'), newFirstVideoUrl: '/generated/narrated-test.mp4',
    newFirstVideoSha256: sha('2'), newFirstMediaAcceptSha256: sha('3'),
    newFirstCertificateSha256: sha('4') },
})

test('historical paid video remains a pending candidate even with bound positive review text', () => {
  const { historical, first } = fixture()
  const prepared = buildOriginalScene2HistoricalReviewProposal(historical, first)
  assert.equal(prepared.historicalVideoAccepted, false)
  assert.equal(prepared.proposal.workflow.directSchema180Admission, false)
  assert.equal(prepared.proposal.workflow.oldProviderRequestUsedNewFirstFrame, false)
  assert.equal(prepared.proposal.source.newFirst.actualTailSha256, first.newFirstActualTailSha256)
  const reports = Object.fromEntries(Object.entries(prepared.proposal.reviewHooks).map(([name, hook]) => [name, {
    version: 'historical-scene2-independent-review-v1', kind: hook.kind,
    proposalSha256: prepared.proposalSha256,
    reviewBindingSha256: prepared.proposal.reviewBindingSha256s[name],
    verdict: 'accept', manualVerdict: 'accept', modelExecutionId: `model-run-${name}`,
    modelLedgerSha256: sha('5'), manualReportSha256: sha('6'),
    reviewedAttachmentSha256s: hook.requiredAttachmentSha256s,
    ...(hook.requiredNativeFrameIndices ? { reviewedNativeFrameIndices: hook.requiredNativeFrameIndices } : {}),
    ...(name === 'dialogueAudio' ? { observedSpeechEnd: 9.51 } : {}),
    findings: hook.requiredFindings.map((finding: string) => ({ name: finding, result: 'confirmed', evidence: 'actual native material' })),
  }]))
  const envelope = inspectOriginalScene2ReviewEnvelope(prepared, reports)
  assert.equal(envelope.reviewEnvelopeComplete, true)
  assert.equal(envelope.historicalVideoAccepted, false)
  assert.equal(envelope.modelLedgersIndependentlyVerified, false)
  assert.equal(envelope.next, 'verify-independent-ledgers-then-add-managed-historical-import-policy')
})

test('proposal refuses payment-task drift, missing first-shot acceptance, and changed review binding', () => {
  const { historical, first } = fixture()
  assert.throws(() => buildOriginalScene2HistoricalReviewProposal(
    { ...historical, oldProvider: { ...historical.oldProvider, taskId: 'different' } }, first),
  /HISTORICAL_ADMISSION_INVALID/)
  assert.throws(() => buildOriginalScene2HistoricalReviewProposal(historical,
    { ...first, firstShotReady: false }), /HISTORICAL_ADMISSION_INVALID/)
  const prepared = buildOriginalScene2HistoricalReviewProposal(historical, first)
  const altered = { ...prepared, proposal: { ...prepared.proposal,
    source: { ...prepared.proposal.source, originalVoiceId: 'wrong' } } }
  assert.throws(() => inspectOriginalScene2ReviewEnvelope(altered, {}), /proposal was changed/)
})
