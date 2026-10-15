#!/usr/bin/env node
/** Read-only preflight for reusing the original paid scene-02 video as a
 * historical source. This never turns the legacy take into a schema180 pass. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { principleDurationTransitionIssue } from '../src/history-cinema.ts'
import { assertOriginalSecondShotCreativeLock } from './replay-original-second-shot-candidate.mjs'
import { assertSourceBoundCompositeHop } from '../server/scene-cut-source-bound-composite.mjs'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { sceneCutShotSha256 } from '../server/scene-cut-frame-approval.ts'
import { verifyA8B6CompositeReceiptSync } from '../server/staged-scene-cut-a8b6-qa.mjs'
import { verifyFreshA8B6CompositeReceiptSync } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'
import { expectedFreshA8B6RouterBinding } from
  '../server/staged-scene-cut-a8b6-fresh-source-bound-fork.mjs'
import { verifyA8B6WorkflowApprovalSync } from '../server/staged-scene-cut-a8b6-approval.mjs'
import { assertA8B6ShotCompletion } from '../server/sanguo-a8b6-two-shot-qa.mjs'

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const VIDEO_SHA = '3546388b7925d4fcade3df94e34238a8e5cc185df4fbabf4f35bc139af1fabd8'
const TASK_ID = '933544686269653023'
const ARCHIVE_URL = '/generated/verified-bb6bc95cbd10cff9b815.mp4'
const A8B6_VARIANT = 'source-bound-composite-a8b6-first-shot-v1'
const FRESH_A8B6_VARIANT = 'source-bound-composite-a8b6-fresh-first-shot-v1'
const A8B6_NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const A8B6_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/
const fail = message => { throw Error(`ORIGINAL_SCENE2_MEDIA_REUSE_INVALID: ${message}`) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

function localAsset(root, url, extension) {
  if (typeof url !== 'string' || !new RegExp(`^/generated/[\\w.-]+\\.${extension}$`, 'i').test(url))
    fail('media is not an archived local asset')
  return path.join(root, 'public', url.slice(1))
}

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { maxBuffer: 24 * 1024 * 1024, timeout: 120000 })
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout))
    fail(`native media decode failed (${result.error?.message ?? result.status})`)
  return result.stdout
}

/** SHA of every decoded native video frame, independent of old sparse JPGs. */
export function inspectOriginalSecondShotNativeMedia(filename) {
  const frameText = runFfmpeg(['-hide_banner', '-v', 'error', '-xerror', '-i', filename,
    '-map', '0:v:0', '-an', '-f', 'framemd5', '-']).toString('utf8')
  const timeBase = /^#tb 0: (\d+)\/(\d+)$/m.exec(frameText)
  const frameRows = frameText.split('\n').filter(line => /^0,/.test(line)).map(line => line.split(',').map(item => item.trim()))
  const pts = frameRows.map(row => Number(row[2]))
  if (timeBase?.[1] !== '1' || timeBase[2] !== '24' || frameRows.length !== 241
    || pts.some((value, index) => value !== index))
    fail('historical video is not its archived 241-frame 24fps native sequence')
  const jpeg = index => runFfmpeg(['-hide_banner', '-v', 'error', '-xerror', '-i', filename,
    '-map', '0:v:0', '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'])
  const firstJpeg = jpeg(0), lastJpeg = jpeg(240)
  if (firstJpeg.length < 10000 || lastJpeg.length < 10000) fail('native first/last frame decode failed')
  const pcm = runFfmpeg(['-hide_banner', '-v', 'error', '-xerror', '-i', filename,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'])
  if (pcm.length < 300000 || pcm.length % 2) fail('historical speech audio is absent or truncated')
  return { fps: 24, nativeFrameCount: 241, firstPts: 0, lastPts: 10,
    nativeFrameDigestSha256: hash(Buffer.from(frameText)),
    nativeFirstJpegSha256: hash(firstJpeg), nativeLastJpegSha256: hash(lastJpeg),
    decodedAudioPcmSha256: hash(pcm), decodedAudioSamples: pcm.length / 2,
    decodedAudioSampleRate: 16000 }
}

/** Historical provenance only. The original approval cannot certify a later
 * first-shot tail, and the old provider request had no scene-cut first frame. */
export function inspectOriginalSecondShotSource(original, root = process.cwd()) {
  if (original?.id !== ORIGINAL_ID || original.result_md5 !== ORIGINAL_MD5
    || original.workflow_id !== 'wf-sanguo-history-drama')
    fail('original execution changed')
  const state = decodeExecutionState(original.result), runs = state.nodeRuns
  const candidate = runs?.[58]?.output, acceptedScript = runs?.[60]?.output
  const take = object(runs?.[94]?.output), evidence = object(runs?.[96]?.output)
  const review = object(runs?.[100]?.output), acceptedMedia = object(runs?.[101]?.output)
  const creative = assertOriginalSecondShotCreativeLock(candidate, acceptedScript)
  if (runs.length !== 408 || runs[58]?.node?.id !== 'sanguo-shot-script'
    || runs[60]?.node?.id !== 'sanguo-shot-script-accept'
    || runs[94]?.node?.id !== 'sanguo-video' || runs[94].status !== 'success'
    || runs[96]?.node?.id !== 'sanguo-video-evidence' || runs[96].status !== 'success'
    || runs[100]?.node?.id !== 'sanguo-media-review' || runs[100].status !== 'success'
    || runs[101]?.node?.id !== 'sanguo-media-accept' || runs[101].status !== 'success'
    || runs[105]?.node?.id !== 'sanguo-video-concat' || runs[105].status !== 'success'
    || runs[106]?.node?.id !== 'sanguo-last-frame' || runs[106].status !== 'idle'
    || take.raw?.data?.task_id !== TASK_ID
    || take.raw?.data?.task_status !== 'succeed'
    || take.raw?.data?.task_result?.videos?.[0]?.url !== take.url
    || take.model !== 'keling3'
    || take.params?.duration !== 10 || take.params?.sound !== 'on'
    || take.params?.audioType !== '对白' || take.params?.audioText !== candidate.audioText
    || evidence.originalUrl !== take.url || evidence.url !== ARCHIVE_URL
    || evidence.sha256 !== VIDEO_SHA || evidence.decoded !== true
    || Math.abs(Number(evidence.duration) - 10.04) > .01
    || review.decision !== 'pass' || acceptedMedia.passed !== true
    || acceptedMedia.visualReview?.passed !== true
    || acceptedMedia.originalUrl !== take.url || acceptedMedia.sha256 !== VIDEO_SHA
    || acceptedMedia.audioSource?.taskId !== TASK_ID
    || acceptedMedia.audioSource?.kind !== 'native-speech')
    fail('historical paid take, media, or creative lock changed')
  const filename = localAsset(root, ARCHIVE_URL, 'mp4')
  if (hash(readFileSync(filename)) !== VIDEO_SHA)
    fail('historical archived video bytes changed')
  const native = inspectOriginalSecondShotNativeMedia(filename)
  const sourceParams = object(take.params)
  if (sourceParams.sceneCutFrameGate !== undefined || sourceParams.sceneCutShot !== undefined
    || sourceParams.sceneCutSources !== undefined || sourceParams.referenceImage !== undefined
    || evidence.sceneCutOutputFirstFrame !== undefined
    || acceptedMedia.durationCompletion !== undefined)
    fail('legacy take unexpectedly carries a schema180 scene-cut admission field')
  return { version: 'original-scene2-historical-media-audit-v1',
    originalExecutionId: original.id, originalResultMd5: original.result_md5,
    originalCandidateSha256: creative.candidateSha256,
    originalAcceptedScriptSha256: creative.acceptedSha256,
    oldProvider: { modelId: take.model, taskId: TASK_ID,
      remoteUrlSha256: hash(Buffer.from(take.url)), remoteHost: new URL(take.url).host,
      archivedUrl: ARCHIVE_URL, archivedSha256: VIDEO_SHA }, native,
    originalSpeech: { planned: candidate.audioText,
      alignedStart: evidence.speechValidation?.alignment?.[0]?.actualStart ?? null,
      alignedEnd: evidence.speechValidation?.alignment?.[0]?.actualEnd ?? null,
      completenessClaim: evidence.speechValidation?.dialogueCompletenessVerified === true,
      lipSyncVerified: evidence.speechValidation?.lipSyncVerified === true,
      speakerIdentityVerified: acceptedMedia.technicalValidation?.speakerIdentityVerified === true,
      voiceId: acceptedMedia.audioSource?.voices?.find(item => item.name === '张飞')?.voiceId ?? null },
    historicalReview: { decision: review.decision, mediaPassed: acceptedMedia.passed,
      finalTailRunStatus: runs[106].status },
    schema180DirectAdmission: false,
    missingSchema180Fields: ['sceneCutFrameGate', 'sceneCutShot', 'sceneCutSources',
      'referenceImage', 'sceneCutOutputFirstFrame', 'durationCompletion'],
    oldRequestUsedNewSceneCutReference: false,
    status: 'historical-paid-candidate-only' }
}

/** This separate 14 s branch is checked against the new approved prefix and
 * its own formal receipt. It never widens the legacy 13 s hop. */
export function assertA8B6FirstShotLineage(parent, child, parentResultMd5,
  verified, workflowApproval) {
  const before = parent?.nodeRuns, after = child?.nodeRuns
  const marker = child?.sceneCutCompositeRecovery
  const receipt = verified?.receipt, manifest = verified?.manifest
  const approval = workflowApproval?.approval
  const take = after?.[52]?.output
  const compact = take?.sourceBoundComposite
  const bound = { planId: marker?.qaPlanId,
    manifestSha256: verified?.manifestSha256,
    receiptSha256: verified?.receiptSha256,
    workflowApprovalSha256: workflowApproval?.approvalSha256 }
  if (!/^record-[\w-]+$/.test(String(parent?.id))
    || parent.id !== approval?.approvalExecutionId
    || !MD5.test(String(parentResultMd5))
    || !Array.isArray(before) || before.length !== 464
    || !Array.isArray(after) || after.length !== 464
    || child.id === parent.id || child.parentExecutionId !== parent.id
    || child.workflowId !== parent.workflowId
    || child.requestScopeId !== parent.requestScopeId
    || child.generationScopeId !== child.id
    || marker?.version !== A8B6_VARIANT || marker.stagingVariant !== 'a8b6'
    || marker.sourceExecutionId !== parent.id
    || marker.sourceResultMd5 !== parentResultMd5
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_EDGES_MD5
    || marker.qaPlanId !== manifest?.planId
    || approval?.qaPlanId !== marker.qaPlanId
    || approval.approvalExecutionId !== parent.id
    || approval.approvalResultMd5 !== parentResultMd5
    || marker.manifestSha256 !== verified.manifestSha256
    || marker.receiptSha256 !== verified.receiptSha256
    || marker.workflowApprovalSha256 !== workflowApproval.approvalSha256
    || marker.preservedPrefixLength !== 52
    || marker.preservedPrefixSha256 !== sceneCutRebindSha256(before.slice(0, 52))
    || !isDeepStrictEqual(after.slice(0, 52), before.slice(0, 52))
    || before.slice(0, 52).some(run => !['success', 'skipped'].includes(run.status))
    || before[11]?.output?.id !== 'scene-01'
    || before[11].output.duration !== 14
    || sceneCutShotSha256(before[11].output) !== approval?.amendedShotSha256
    || before[50]?.status !== 'success'
    || before[50].output?.signature !== approval.sceneCutFrameApprovalSignature
    || sceneCutRebindSha256(before[50].output) !== approval.sceneCutFrameCertificateSha256
    || before[52]?.status !== 'idle' || after[52]?.status !== 'success'
    || after[52].node?.id !== 'sanguo-video'
    || take?.url !== receipt?.output?.url
    || take?.model !== 'source-bound-composite-a8b6-v1'
    || take?.narration?.url !== receipt.narration?.url
    || take.narration?.pictureUrl !== receipt.picture?.url
    || receipt?.workflowApproval?.approvalSha256 !== workflowApproval.approvalSha256
    || receipt.workflowApproval.amendedShotSha256 !== approval.amendedShotSha256
    || receipt.workflowApproval.sceneCutFrameCertificateSha256 !== approval.sceneCutFrameCertificateSha256
    || receipt.output?.frameCount !== 337 || receipt.output?.fps !== 24
    || receipt.output?.lastPts !== 14
    || marker.compositeVideoUrl !== receipt.output.url
    || marker.compositeVideoSha256 !== receipt.output.sha256
    || marker.firstPendingIndex !== 53
    || !isDeepStrictEqual(after[52].inputs?.sourceBoundComposite, bound)
    || !isDeepStrictEqual(take.params?.sourceBoundComposite, bound)
    || compact?.planId !== marker.qaPlanId
    || compact?.manifestSha256 !== verified.manifestSha256
    || compact?.receiptSha256 !== verified.receiptSha256
    || compact?.workflowApprovalSha256 !== workflowApproval.approvalSha256
    || take.params?.sceneCutFrameGate?.signature !== approval.sceneCutFrameApprovalSignature
    || take.params?.sceneCutShot?.duration !== 14
    || after.slice(53, 65).some(run => !['success', 'skipped'].includes(run.status))
    || after.slice(65).some(run => run.status !== 'idle'))
    fail('new 14 second composite child lost its signed parent, prefix, receipt or completed first shot')
  const evidence = after[54]?.output, review = after[58]?.output,
    accept = after[59]?.output, last = after[64]?.output
  const completion = assertA8B6ShotCompletion(before[11].output, accept)
  if (after[54]?.status !== 'success' || after[58]?.status !== 'success'
    || after[59]?.status !== 'success' || after[64]?.status !== 'success'
    || evidence?.decoded !== true || evidence.originalUrl !== receipt.output.url
    || evidence.sha256 !== receipt.output.sha256
    || review?.decision !== 'pass'
    || accept?.originalUrl !== receipt.output.url
    || accept?.sha256 !== receipt.output.sha256
    || last?.available !== true || last.url !== evidence.lastFrameUrl
    || last.source !== 'extracted-from-video'
    || principleDurationTransitionIssue(before[44].output, accept))
    fail('new 14 second composite media or actual tail has not passed')
  return { marker, manifest, receipt, completion,
    workflowApprovalSha256: workflowApproval.approvalSha256 }
}

/** The newly paid A/B plan has its own marker, task receipts and dynamic PTS. */
export function assertFreshA8B6FirstShotLineage(parent, child,
  parentResultMd5, verified, imageApproval, imageApprovalResultMd5) {
  const before = parent?.nodeRuns, after = child?.nodeRuns
  const approved = imageApproval?.nodeRuns
  const marker = child?.sceneCutCompositeRecovery
  const router = parent?.sceneCutA8B6FreshRouterRecovery
  const manifest = verified?.manifest, receipt = verified?.receipt
  const routerBinding = expectedFreshA8B6RouterBinding(manifest)
  const take = after?.[52]?.output
  const bound = { planId: marker?.planId,
    manifestSha256: verified?.manifestSha256,
    receiptSha256: verified?.receiptSha256,
    workflowApprovalSha256: manifest?.workflowApprovalSha256 }
  const approvedFrames = receipt?.mapping?.frameCount
  if (!/^record-[\w-]+$/.test(String(parent?.id))
    || !MD5.test(String(parentResultMd5))
    || !/^record-[\w-]+$/.test(String(imageApproval?.id))
    || !MD5.test(String(imageApprovalResultMd5))
    || imageApproval.id !== manifest?.source?.freshFrameExecutionId
    || imageApprovalResultMd5 !== manifest.source.freshFrameResultMd5
    || parent.parentExecutionId !== imageApproval.id
    || parent.workflowId !== imageApproval.workflowId
    || parent.requestScopeId !== imageApproval.requestScopeId
    || parent.generationScopeId !== parent.id
    || !Array.isArray(approved) || approved.length !== 464
    || router?.version !== 'scene-cut-a8b6-fresh-router-v1'
    || router.imageApprovalExecutionId !== imageApproval.id
    || router.imageApprovalResultMd5 !== imageApprovalResultMd5
    || router.planId !== routerBinding.planId
    || router.workflowApprovalSha256
      !== routerBinding.workflowApprovalSha256
    || router.preservedPrefixLength !== 51
    || router.preservedPrefixSha256
      !== sceneCutRebindSha256(approved.slice(0, 51))
    || router.firstPendingIndex !== 51
    || !isDeepStrictEqual(before?.slice(0, 51), approved.slice(0, 51))
    || approved[50]?.status !== 'success'
    || approved.slice(51).some(run => run.status !== 'idle')
    || before?.[51]?.node?.id !== 'sanguo-video-reference-router'
    || before[51].status !== 'success'
    || before[41]?.output?.version !== 'scene-cut-sources-v1'
    || before[51].output?.referenceMode !== 'three-view-all'
    || !isDeepStrictEqual(before[51].output.referenceImages,
      before[41].output.referenceImages)
    || !isDeepStrictEqual(before[51].output.referenceBindings,
      before[41].output.referenceBindings)
    || before.slice(52).some(run => run.status !== 'idle')
    || !Array.isArray(before) || before.length !== 464
    || !Array.isArray(after) || after.length !== 464
    || child.id === parent.id || child.parentExecutionId !== parent.id
    || child.workflowId !== parent.workflowId
    || child.requestScopeId !== parent.requestScopeId
    || child.generationScopeId !== child.id
    || marker?.version !== FRESH_A8B6_VARIANT
    || marker.stagingVariant !== 'a8b6-fresh'
    || marker.sourceExecutionId !== parent.id
    || marker.sourceResultMd5 !== parentResultMd5
    || marker.imageApprovalExecutionId !== imageApproval.id
    || marker.imageApprovalResultMd5 !== imageApprovalResultMd5
    || marker.imageApprovalPrefixLength !== 51
    || marker.imageApprovalPrefixSha256
      !== sceneCutRebindSha256(approved.slice(0, 51))
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_EDGES_MD5
    || marker.planId !== manifest?.planId
    || receipt?.sourceRecordId !== imageApproval.id
    || receipt.sourceResultMd5 !== imageApprovalResultMd5
    || marker.manifestSha256 !== verified.manifestSha256
    || marker.receiptSha256 !== verified.receiptSha256
    || marker.workflowApprovalSha256 !== manifest.workflowApprovalSha256
    || marker.preservedPrefixLength !== 52
    || marker.preservedPrefixSha256
      !== sceneCutRebindSha256(before.slice(0, 52))
    || !isDeepStrictEqual(after.slice(0, 52), before.slice(0, 52))
    || before.slice(0, 52).some(run =>
      !['success', 'skipped'].includes(run.status))
    || before[11]?.output?.id !== 'scene-01'
    || before[11].output.duration !== 14
    || sceneCutShotSha256(before[11].output)
      !== manifest.source.approvedShotSha256
    || before[11].output.scheduleHash !== manifest.source.scheduleHash
    || before[50]?.status !== 'success'
    || sceneCutRebindSha256(approved[50].output)
      !== manifest.source.frameCertificateSha256
    || sceneCutRebindSha256(before[50].output)
      !== manifest.source.frameCertificateSha256
    || before[52]?.status !== 'idle'
    || after[52]?.status !== 'success'
    || after[52].node?.id !== 'sanguo-video'
    || take?.model !== 'source-bound-composite-a8b6-fresh-v1'
    || take.url !== receipt?.output?.url
    || take.narration?.url !== receipt.narration?.url
    || take.narration?.pictureUrl !== receipt.picture?.url
    || !isDeepStrictEqual(after[52].inputs?.sourceBoundComposite, bound)
    || !isDeepStrictEqual(take.params?.sourceBoundComposite, bound)
    || take.sourceBoundComposite?.planId !== marker.planId
    || take.sourceBoundComposite?.manifestSha256
      !== verified.manifestSha256
    || take.sourceBoundComposite?.receiptSha256
      !== verified.receiptSha256
    || take.sourceBoundComposite?.workflowApprovalSha256
      !== manifest.workflowApprovalSha256
    || take.params?.sceneCutFrameGate?.signature
      !== before[50].output?.signature
    || take.params?.sceneCutShot?.duration !== 14
    || receipt.workflowApproval?.approvalSha256
      !== manifest.workflowApprovalSha256
    || receipt.workflowApproval.amendedShotSha256
      !== manifest.source.approvedShotSha256
    || receipt.workflowApproval.sceneCutFrameCertificateSha256
      !== manifest.source.frameCertificateSha256
    || !Number.isInteger(approvedFrames)
    || approvedFrames < 335 || approvedFrames > 339
    || receipt.output?.frameCount !== approvedFrames
    || receipt.output?.fps !== 24
    || Math.abs(receipt.output.lastPts - 14) > 2 / 24 + 1e-8
    || marker.compositeVideoUrl !== receipt.output.url
    || marker.compositeVideoSha256 !== receipt.output.sha256
    || marker.firstPendingIndex !== 53
    || after.slice(53, 65).some(run =>
      !['success', 'skipped'].includes(run.status))
    || after.slice(65).some(run => run.status !== 'idle'))
    fail('fresh 14s composite child lost approved source, true paid A/B or completed first shot')
  const evidence = after[54]?.output, review = after[58]?.output,
    accept = after[59]?.output, last = after[64]?.output
  const completion = assertA8B6ShotCompletion(before[11].output, accept)
  if (after[54]?.status !== 'success' || after[58]?.status !== 'success'
    || after[59]?.status !== 'success' || after[64]?.status !== 'success'
    || evidence?.decoded !== true
    || evidence.originalUrl !== receipt.output.url
    || evidence.sha256 !== receipt.output.sha256
    || review?.decision !== 'pass'
    || accept?.originalUrl !== receipt.output.url
    || accept?.sha256 !== receipt.output.sha256
    || last?.available !== true
    || last.url !== evidence.lastFrameUrl
    || last.source !== 'extracted-from-video'
    || principleDurationTransitionIssue(before[44].output, accept))
    fail('fresh composite node54–64 actual media or first-shot action incomplete')
  return { marker, manifest, receipt, completion,
    workflowApprovalSha256: manifest.workflowApprovalSha256 }
}

/** Boundary readiness is calculated from the new first take, never from the
 * historical first shot or the old second-shot reviewer decision. */
export function inspectNewFirstShotForHistoricalReuse(source, original, parent,
  root = process.cwd(), imageApprovalRow) {
  const state = decodeExecutionState(source.result), runs = state.nodeRuns
  if (state.sceneCutCompositeRecovery?.version === FRESH_A8B6_VARIANT) {
    if (source.workflow_id !== 'wf-sanguo-history-drama'
      || state.id !== source.id || !MD5.test(String(source.result_md5))
      || original?.id !== ORIGINAL_ID || !parent || !imageApprovalRow
      || !SHA.test(String(state.sceneCutCompositeRecovery.planId)))
      fail('fresh A8+B6 source record or parent missing')
    const planId = state.sceneCutCompositeRecovery.planId
    const verified = verifyFreshA8B6CompositeReceiptSync(planId, root)
    const lineage = assertFreshA8B6FirstShotLineage(
      decodeExecutionState(parent.result), state, parent.result_md5, verified,
      decodeExecutionState(imageApprovalRow.result),
      imageApprovalRow.result_md5)
    const evidence = runs[54].output, accept = runs[59].output,
      last = runs[64].output
    const tailSha256 = hash(readFileSync(localAsset(root, last.url, 'jpe?g')))
    return { sourceExecutionId: source.id,
      sourceResultMd5: source.result_md5,
      firstShotReady: true, blockers: [],
      newFirstActualTailUrl: last.url,
      newFirstActualTailSha256: tailSha256,
      newFirstVideoUrl: evidence.originalUrl,
      newFirstVideoSha256: evidence.sha256,
      newFirstMediaAcceptSha256: sceneCutRebindSha256(accept),
      newFirstCertificateSha256: sceneCutRebindSha256(runs[50].output),
      firstShotLineage: { version: FRESH_A8B6_VARIANT, planId,
        manifestSha256: verified.manifestSha256,
        receiptSha256: verified.receiptSha256,
        workflowApprovalSha256: lineage.workflowApprovalSha256,
        amendedShotSha256: verified.manifest.source.approvedShotSha256,
        nativeFrameCount: verified.receipt.output.frameCount,
        approvedDurationSeconds: 14 },
      oldFirstTailIsNotTheBoundary: original.id === ORIGINAL_ID,
      next: 'independent-native-boundary-and-audio-review-required' }
  }
  if (state.sceneCutCompositeRecovery?.version === A8B6_VARIANT) {
    if (source.workflow_id !== 'wf-sanguo-history-drama'
      || state.id !== source.id || !MD5.test(String(source.result_md5))
      || original?.id !== ORIGINAL_ID || !parent
      || !/^record-[\w-]+$/.test(source.id)
      || !SHA.test(String(state.sceneCutCompositeRecovery.qaPlanId)))
      fail('A8+B6 source record or parent missing')
    const planId = state.sceneCutCompositeRecovery.qaPlanId
    const verified = verifyA8B6CompositeReceiptSync(planId, root)
    const workflowApproval = verifyA8B6WorkflowApprovalSync(planId, root)
    const lineage = assertA8B6FirstShotLineage(
      decodeExecutionState(parent.result), state, parent.result_md5,
      verified, workflowApproval)
    const evidence = runs[54].output, accept = runs[59].output,
      last = runs[64].output
    const tailFile = localAsset(root, last.url, 'jpe?g')
    const tailSha256 = hash(readFileSync(tailFile))
    return { sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
      firstShotReady: true, blockers: [],
      newFirstActualTailUrl: last.url, newFirstActualTailSha256: tailSha256,
      newFirstVideoUrl: evidence.originalUrl,
      newFirstVideoSha256: evidence.sha256,
      newFirstMediaAcceptSha256: sceneCutRebindSha256(accept),
      newFirstCertificateSha256: sceneCutRebindSha256(runs[50].output),
      firstShotLineage: { version: A8B6_VARIANT, planId,
        manifestSha256: verified.manifestSha256,
        receiptSha256: verified.receiptSha256,
        workflowApprovalSha256: lineage.workflowApprovalSha256,
        amendedShotSha256: workflowApproval.approval.amendedShotSha256,
        nativeFrameCount: 337, approvedDurationSeconds: 14 },
      oldFirstTailIsNotTheBoundary: original.id === ORIGINAL_ID,
      next: 'independent-native-boundary-and-audio-review-required' }
  }
  const accept = object(runs?.[59]?.output), evidence = object(runs?.[54]?.output)
  const last = object(runs?.[64]?.output), review = object(accept.visualReview)
  const block = []
  if (source.workflow_id !== 'wf-sanguo-history-drama' || runs?.length !== 464
    || runs?.[65]?.node?.id !== 'sanguo-shot-script') block.push('schema180-source-route')
  if (runs?.slice(0, 65).some(run => !['success', 'skipped'].includes(run.status)))
    block.push('first-shot-0-through-64-incomplete')
  if (accept.passed !== true || accept.manualDecisionRequired !== false
    || review.passed !== true || principleDurationTransitionIssue(runs?.[44]?.output, accept))
    block.push('first-shot-whole-media-or-duration-unaccepted')
  if (evidence.decoded !== true || evidence.originalUrl !== runs?.[52]?.output?.url
    || accept.originalUrl !== evidence.originalUrl || accept.sha256 !== evidence.sha256
    || last.available !== true || last.url !== evidence.lastFrameUrl
    || last.source !== 'extracted-from-video')
    block.push('new-first-shot-actual-tail-unverified')
  if (state.sceneCutCompositeRecovery?.version !== 'source-bound-composite-first-shot-v1')
    block.push('source-bound-first-shot-lineage-missing')
  const tailFile = typeof last.url === 'string' ? localAsset(root, last.url, 'jpe?g') : null
  const tailSha256 = tailFile ? hash(readFileSync(tailFile)) : null
  if (!block.length) {
    if (!parent) block.push('composite-parent-missing')
    else assertSourceBoundCompositeHop(decodeExecutionState(parent.result), state,
      parent.result_md5, root, true)
  }
  const ready = block.length === 0
  return { sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    firstShotReady: ready, blockers: block,
    ...(tailSha256 ? { newFirstActualTailUrl: last.url, newFirstActualTailSha256: tailSha256 } : {}),
    ...(ready ? { newFirstVideoUrl: evidence.originalUrl,
      newFirstVideoSha256: evidence.sha256,
      newFirstMediaAcceptSha256: sceneCutRebindSha256(accept),
      newFirstCertificateSha256: sceneCutRebindSha256(runs[50].output) } : {}),
    oldFirstTailIsNotTheBoundary: original.id === ORIGINAL_ID,
    next: block.length ? 'wait-for-new-first-shot-acceptance'
      : 'independent-native-boundary-and-audio-review-required' }
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name !== '--source' && name !== '--expected-source-md5' || !args[index + 1]
      || options[name] !== undefined) fail(`invalid or repeated argument ${name}`)
    options[name] = args[++index]
  }
  if (options['--source'] && !/^record-[\w-]+$/.test(options['--source'])) fail('source ID invalid')
  if (options['--expected-source-md5'] && !/^[a-f0-9]{32}$/.test(options['--expected-source-md5']))
    fail('source MD5 lock invalid')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const row = id => db.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [id])
    const original = (await row(ORIGINAL_ID)).rows[0]
    const historical = inspectOriginalSecondShotSource(original)
    let newFirst
    if (options['--source']) {
      const source = (await row(options['--source'])).rows[0]
      if (!source || options['--expected-source-md5'] && source.result_md5 !== options['--expected-source-md5'])
        fail('new first-shot source missing or differs from reviewed MD5')
      const state = decodeExecutionState(source.result)
      const composite = state.sceneCutCompositeRecovery
      const parent = composite?.sourceExecutionId
        ? (await row(composite.sourceExecutionId)).rows[0] : undefined
      const imageApproval = composite?.version === FRESH_A8B6_VARIANT
        && composite.imageApprovalExecutionId
        ? (await row(composite.imageApprovalExecutionId)).rows[0]
        : undefined
      newFirst = inspectNewFirstShotForHistoricalReuse(source, original,
        parent, process.cwd(), imageApproval)
    }
    await db.query('ROLLBACK')
    console.log(JSON.stringify({ mode: 'read-only', providerCalls: 0, databaseWrites: 0,
      historical, ...(newFirst ? { newFirst } : {}),
      nextAcceptanceGates: {
        boundary: 'compare new first native final frame, new approved courtyard first image and new paid scene-02 native frame0: Zhang/Yan faces, armor, front wrist binding and rope state must continue; the historical scene-02 frame0 is comparison evidence only',
        scene2Native: 'derive the new paid 10-second take frame count and final PTS from its decoded sequence; inspect f0 through native last frame for tied wrists, guards, seat/low step, Zhang lean and camera axis; historical 241 frames are only a comparison',
        dialogue: 'on the new paid take, independently verify the full Zhang line, actual speaker/voice and visible mouth motion, no extra speech and a readable ending; historical 3.05–9.51 s alignment is not the new take timing',
        audioSeam: 'compare first-shot mixed narration tail and new scene-02 native dialogue head for voice overlap, clipping and ambience; inspect the final two-shot concat packets and original-speed cut',
        policy: 'a new explicit historical-media admission contract and fresh schema180-compatible evidence/review are required; never backfill the old provider request with a newly approved referenceImage' } }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
