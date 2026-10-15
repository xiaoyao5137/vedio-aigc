/** Read-only preflight for a fresh scene-02 take after the actual first-shot tail
 * is accepted. This is a review contract, not a provider receipt or admission. */
import { createHash } from 'node:crypto'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from './scene-cut-frame-approval.ts'
import { inspectOriginalSecondShotSource,
  inspectNewFirstShotForHistoricalReuse } from '../scripts/audit-original-second-shot-media-reuse.mjs'
import { assertOriginalSecondShotCreativeLock } from '../scripts/replay-original-second-shot-candidate.mjs'

const SHA = /^[a-f0-9]{64}$/
const SCRIPT_SHA = 'a0bd06afdcf6f8019f36c0a5d44b9209d27ec97673550090d72faea1ff31a8e3'
const LINE = '张飞：我们的大军已经到了，你为什么不投降，还要抵抗？'
const VOICE_ID = '933124714380816393'
const fail = reason => { throw Error(`SCENE2_REGEN_PREFLIGHT_INVALID: ${reason}`) }
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value ?? null)
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')

/** The first shot must already have a saved, verified completion and actual tail.
 * The old scene-02 video is preserved as historical evidence only. */
export function buildScene2RegenerationPreflight(historical, first, approvedShot, firstCertificate) {
  const continuity = obj(approvedShot?.continuity)
  const pacing = obj(approvedShot?.pacing)
  const firstShotLineage = first?.firstShotLineage
  const a8b6 = firstShotLineage?.version === 'source-bound-composite-a8b6-first-shot-v1'
  const freshA8B6 = firstShotLineage?.version
    === 'source-bound-composite-a8b6-fresh-first-shot-v1'
  const plates = Array.isArray(firstCertificate?.identityPlateBindings)
    ? firstCertificate.identityPlateBindings : []
  if (historical?.status !== 'historical-paid-candidate-only'
    || historical.version !== 'original-scene2-historical-media-audit-v1'
    || historical.schema180DirectAdmission !== false
    || historical.originalExecutionId !== 'record-4x5m31'
    || historical.originalResultMd5 !== '74e5e2f8afcf8f829694aef350629950'
    || historical.originalAcceptedScriptSha256 !== SCRIPT_SHA
    || historical.oldProvider?.taskId !== '933544686269653023'
    || historical.oldProvider?.archivedUrl !== '/generated/verified-bb6bc95cbd10cff9b815.mp4'
    || historical.oldProvider?.archivedSha256 !== '3546388b7925d4fcade3df94e34238a8e5cc185df4fbabf4f35bc139af1fabd8'
    || historical.native?.nativeFrameCount !== 241 || historical.native?.fps !== 24
    || historical.native?.lastPts !== 10
    || !SHA.test(String(historical.native?.nativeFirstJpegSha256))
    || historical.originalSpeech?.planned !== LINE
    || historical.originalSpeech?.voiceId !== VOICE_ID
    || first?.firstShotReady !== true || first.blockers?.length !== 0
    || !SHA.test(String(first.newFirstVideoSha256))
    || !/^\/generated\/[\w.-]+\.mp4$/i.test(String(first.newFirstVideoUrl))
    || !SHA.test(String(first.newFirstActualTailSha256))
    || !SHA.test(String(first.newFirstMediaAcceptSha256))
    || !SHA.test(String(first.newFirstCertificateSha256))
    || !/^\/generated\/[\w.-]+\.jpg$/i.test(String(first.newFirstActualTailUrl))
    || !/^record-[\w-]+$/.test(String(first.sourceExecutionId))
    || !/^[a-f0-9]{32}$/.test(String(first.sourceResultMd5)))
    fail('historical source or completed first-shot actual tail is not pinned')
  if (firstShotLineage !== undefined && !a8b6 && !freshA8B6
    || a8b6 && (!SHA.test(String(firstShotLineage.planId))
      || !SHA.test(String(firstShotLineage.manifestSha256))
      || !SHA.test(String(firstShotLineage.receiptSha256))
      || !SHA.test(String(firstShotLineage.workflowApprovalSha256))
      || !SHA.test(String(firstShotLineage.amendedShotSha256))
      || firstShotLineage.nativeFrameCount !== 337
      || firstShotLineage.approvedDurationSeconds !== 14)
    || freshA8B6 && (!SHA.test(String(firstShotLineage.planId))
      || !SHA.test(String(firstShotLineage.manifestSha256))
      || !SHA.test(String(firstShotLineage.receiptSha256))
      || !SHA.test(String(firstShotLineage.workflowApprovalSha256))
      || !SHA.test(String(firstShotLineage.amendedShotSha256))
      || !Number.isInteger(firstShotLineage.nativeFrameCount)
      || firstShotLineage.nativeFrameCount < 335
      || firstShotLineage.nativeFrameCount > 339
      || firstShotLineage.approvedDurationSeconds !== 14))
    fail('new 14 second first-shot lineage is incomplete')
  if (approvedShot?.id !== 'scene-02' || approvedShot.duration !== 10
    || approvedShot.audioType !== '对白' || approvedShot.audioText !== LINE
    || continuity.mode !== 'scene_cut' || continuity.bridgeType !== 'cut'
    || continuity.previousShotId !== 'scene-01'
    || approvedShot.firstFrameMode !== 'reference'
    || pacing.version !== 'duration-v2'
    || !String(approvedShot.visualPrompt ?? '').includes('院落')
    || !String(approvedShot.lastFramePrompt ?? '').includes('严颜')
    || !String(approvedShot.videoPrompt ?? '').includes('9.261-10秒'))
    fail('approved scene-02 creative, timing, or cut contract changed')
  if (firstCertificate?.version !== 'scene-cut-frame-gate-v1'
    || firstCertificate.passed !== true
    || firstCertificate.identityPlateVersion !== 'scene-cut-identity-plate-v4'
    || sceneCutRebindSha256(firstCertificate) !== first.newFirstCertificateSha256
    || plates.length !== 2
    || plates.map(plate => plate.characterName).join(',') !== '张飞,严颜'
    || plates.some(plate => !SHA.test(String(plate.frontSha256))
      || !/^\/generated\/[\w.-]+\.jpg$/i.test(String(plate.frontUrl))))
    fail('first-shot signed character identity plates changed')
  const source = {
    originalExecutionId: historical.originalExecutionId,
    originalResultMd5: historical.originalResultMd5,
    approvedScene2ScriptSha256: SCRIPT_SHA,
    approvedScene2ShotSha256: sceneCutShotSha256(approvedShot),
    historicalScene2VideoSha256: historical.oldProvider.archivedSha256,
    historicalScene2NativeFirstJpegSha256: historical.native.nativeFirstJpegSha256,
    firstExecutionId: first.sourceExecutionId,
    firstResultMd5: first.sourceResultMd5,
    firstAcceptedVideoUrl: first.newFirstVideoUrl,
    firstAcceptedVideoSha256: first.newFirstVideoSha256,
    firstAcceptSha256: first.newFirstMediaAcceptSha256,
    firstCertificateSha256: first.newFirstCertificateSha256,
    actualFirstTailUrl: first.newFirstActualTailUrl,
    actualFirstTailSha256: first.newFirstActualTailSha256,
    ...(a8b6 || freshA8B6
      ? { firstShotLineage: { ...firstShotLineage } } : {}),
    identityPlates: plates.map(plate => ({ characterName: plate.characterName,
      assetId: plate.assetId, frontUrl: plate.frontUrl,
      frontSha256: plate.frontSha256 }))
  }
  const plan = { version: freshA8B6
    ? 'scene2-regeneration-preflight-a8b6-fresh-v1'
    : a8b6 ? 'scene2-regeneration-preflight-a8b6-v1'
      : 'scene2-regeneration-preflight-v1', source,
    sceneCut: {
      kind: 'hard-courtyard-cut', firstFrameMode: 'fresh-approved-courtyard-image',
      priorTailRole: 'continuity-reference-only', priorTailUrl: source.actualFirstTailUrl,
      oldScene2FirstRole: 'historical-comparison-only; no-identity-authority',
      mustNotUsePriorTailAsVideoFirstFrame: true,
      mustNotUseOldScene2FrameAsIdentityAuthority: true,
      firstFrameReview: [
        '张飞与严颜脸形、头饰、交领袍和甲片须与首镜实际尾帧及冻结身份板一致',
        '严颜身前双腕与结绳从零秒可见；不新增首镜尾帧没有的绕腰粗绳',
        '已切入院落：张飞在左侧低阶，严颜在右侧阶下，坐席矮案与院门、守卫同框',
        '张飞尚未俯身开口；不重演押送、缚腕或接近过程'
      ],
      signedApprovalRequired: 'scene-cut-frame-gate-v1',
      outputFirstFrameCheckRequired: 'scene-cut-output-first-frame-v1'
    },
    audio: { mode: 'fresh-native-dialogue', sound: 'on', audioType: '对白',
      text: LINE, fixedVoiceId: VOICE_ID,
      oldNativeAacRole: 'audit-reference-only; never remux to a new picture',
      review: ['同片 ASR 与实际听辨完整台词及末字',
        '核对张飞本人发声、可见口型和角色音色；ASR 不能证明这些',
        '问句须在尾部留至少 0.5 秒可读停顿，不得与首镜旁白跨镜重叠'] },
    endState: { mode: 'approved-prompt-and-actual-native-tail-review',
      approvedLastFramePromptSha256: sha(approvedShot.lastFramePrompt),
      sourcePrompt: approvedShot.lastFramePrompt,
      appearanceAuthority: 'actual-first-shot-tail-and-frozen-identity-plates',
      separateLiveActionEndImageAllowed: false,
      review: '验收第二镜真实原生末帧：张飞收住问句、口闭、仍立低阶前倾；严颜双腕保持身前束缚且未作答，衣甲头饰与首镜一致' },
    providerPreviewOnly: { durationSeconds: 10, aspectRatio: '16:9',
      referenceImage: 'pending-fresh-reviewed-courtyard-image',
      identityReferences: source.identityPlates.map(plate => plate.frontUrl),
      endImage: null,
      promptSha256: sha(approvedShot.videoPrompt),
      actualRequestNotYetCreated: true },
    status: 'await-fresh-first-image-review; no-provider-authorization' }
  return { plan, planSha256: sha(plan), providerCalls: 0, databaseWrites: 0,
    scene2Accepted: false }
}

/** Re-run source checks from saved records. An incomplete first shot is a
 * blocked preflight, never a reason to fabricate its final frame. */
export function prepareScene2RegenerationPreflight(originalRow, firstRow, parentRow,
  root = process.cwd(), imageApprovalRow) {
  const historical = inspectOriginalSecondShotSource(originalRow, root)
  const originalRuns = decodeExecutionState(originalRow.result).nodeRuns
  const creative = assertOriginalSecondShotCreativeLock(originalRuns[58].output,
    originalRuns[60].output)
  if (creative.acceptedSha256 !== historical.originalAcceptedScriptSha256)
    fail('original approved scene-02 script changed')
  if (!firstRow) return { status: 'blocked-first-shot-actual-tail-missing',
    historicalSourceSha256: historical.oldProvider.archivedSha256,
    approvedScene2ScriptSha256: creative.acceptedSha256,
    providerCalls: 0, databaseWrites: 0, scene2Accepted: false }
  const first = inspectNewFirstShotForHistoricalReuse(firstRow, originalRow,
    parentRow, root, imageApprovalRow)
  if (!first.firstShotReady) return { status: 'blocked-first-shot-unaccepted',
    firstShot: first, historicalSourceSha256: historical.oldProvider.archivedSha256,
    approvedScene2ScriptSha256: creative.acceptedSha256,
    providerCalls: 0, databaseWrites: 0, scene2Accepted: false }
  const firstCertificate = decodeExecutionState(firstRow.result).nodeRuns[50].output
  verifySceneCutFrameApproval(firstCertificate, root)
  return { status: 'ready-for-new-image-review-only', ...buildScene2RegenerationPreflight(
    historical, first, originalRuns[60].output, firstCertificate) }
}

/** This gate is intentionally narrower than a paid request validator. It
 * verifies a new signed image against the actual tail and same identity plates;
 * provider request, output zero frame and full-media review still follow. */
export function verifyScene2RegenerationImageGate(prepared, approval, currentShot,
  root = process.cwd()) {
  const plan = prepared?.plan
  if (!['scene2-regeneration-preflight-v1',
    'scene2-regeneration-preflight-a8b6-v1',
    'scene2-regeneration-preflight-a8b6-fresh-v1'].includes(plan?.version)
    || sha(plan) !== prepared.planSha256
    || plan.status !== 'await-fresh-first-image-review; no-provider-authorization'
    || sceneCutShotSha256(currentShot) !== plan.source.approvedScene2ShotSha256)
    fail('preflight or current approved shot changed')
  if (plan.version === 'scene2-regeneration-preflight-a8b6-v1'
    && (plan.source.firstShotLineage?.version !== 'source-bound-composite-a8b6-first-shot-v1'
      || plan.source.firstShotLineage.nativeFrameCount !== 337
      || plan.source.firstShotLineage.approvedDurationSeconds !== 14))
    fail('new 14 second first-shot lineage missing from image gate')
  if (plan.version === 'scene2-regeneration-preflight-a8b6-fresh-v1'
    && (plan.source.firstShotLineage?.version
      !== 'source-bound-composite-a8b6-fresh-first-shot-v1'
      || !Number.isInteger(plan.source.firstShotLineage.nativeFrameCount)
      || plan.source.firstShotLineage.nativeFrameCount < 335
      || plan.source.firstShotLineage.nativeFrameCount > 339
      || plan.source.firstShotLineage.approvedDurationSeconds !== 14))
    fail('fresh paid 14 second first-shot lineage missing from image gate')
  const signed = verifySceneCutFrameApproval(approval, root)
  const sourceHashes = signed.sourceSha256s ?? []
  const priorTail = obj(signed.priorTail), frame = obj(signed.frame)
  const ellipsis = obj(signed.approvedEllipsis)
  const plates = signed.identityPlateBindings ?? []
  if (signed.shotSha256 !== plan.source.approvedScene2ShotSha256
    || priorTail.sourceUrl !== plan.source.actualFirstTailUrl
    || sourceHashes.at(-1) !== plan.source.actualFirstTailSha256
    || ellipsis.priorVideoUrl !== plan.source.firstAcceptedVideoUrl
    || ellipsis.priorVideoSha256 !== plan.source.firstAcceptedVideoSha256
    || ellipsis.priorTailUrl !== plan.source.actualFirstTailUrl
    || ellipsis.priorTailSha256 !== plan.source.actualFirstTailSha256
    || frame.sourceUrl === plan.source.actualFirstTailUrl
    || sourceHashes[0] === plan.source.actualFirstTailSha256
    || sourceHashes[0] === plan.source.historicalScene2NativeFirstJpegSha256
    || plates.length !== 2
    || plates.some((plate, index) => plate.characterName !== plan.source.identityPlates[index].characterName
      || plate.assetId !== plan.source.identityPlates[index].assetId
      || plate.frontUrl !== plan.source.identityPlates[index].frontUrl
      || plate.frontSha256 !== plan.source.identityPlates[index].frontSha256))
    fail('new courtyard first frame is not bound to the accepted tail and frozen identities')
  return { status: 'new-first-image-signed; media-not-yet-generated',
    candidateUrl: frame.sourceUrl, candidateSha256: sourceHashes[0],
    approvalSignature: signed.signature, firstTailSha256: sourceHashes.at(-1),
    scene2Accepted: false }
}
