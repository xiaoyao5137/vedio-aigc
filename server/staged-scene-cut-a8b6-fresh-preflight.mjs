/** Read-only contingency gate for a NEW 14s first image and NEW A/B paid takes.
 * This does not create a workflow fork, provider request, plan, or receipt. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from './scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'

const SOURCE_ID = 'record-4x5m31-original-repair-tail-guide-v2'
const SOURCE_MD5 = '34abee4a7c010616b837dbc175b69c56'
const TIMING_ID = 'record-4x5m31-a8b6-timing-approval-v3'
const TIMING_MD5 = '7024e0652a9fd878ef00a5a2dcec99f8'
const REJECTED_ID = 'record-4x5m31-a8b6-frame-reuse-v3'
const REJECTED_MD5 = '01146ea0d4a7c0d6664f65d5eb9bc54e'
const RETRY_ID = 'record-4x5m31-a8b6-frame-conflict-review-v1'
const RETRY_MD5 = 'de84b207979a369a455f4f2ce39c1b22'
const QA_PLAN_ID = 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'
const GRAPH_NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const GRAPH_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const APPROVED_14S_SHOT_SHA = 'f5d04665f0f1be6db954de81c2748fcb41a423cac833e6b94383fad1b5d07fc0'
const APPROVED_SCHEDULE_HASH = 'duration-v2-sha256-ecccd70590dab91eccf4c52d6797f57ecb961a3bb02b7922e4a66bb203b71c18'
const OLD_IMAGE_SHA = '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
const FINAL_REJECTION_CODES = [
  'identity_facial_hair_age_drift', 'inner_hem_proportion_mismatch']
const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_FRESH_PREFLIGHT_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

function localGenerated(root, url, extension) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url)
    || !extension.test(url)) fail('local generated asset URL invalid')
  return path.join(root, 'public', url.slice(1))
}

/** Cheap signed history read. Historical A/B media is intentionally not decoded. */
export function readA8B6HistoricQaManifest(root = process.cwd()) {
  const filename = path.join(root, '.runtime/staged-scene-cut-a8b6-qa', QA_PLAN_ID,
    'manifest.json')
  const bytes = readFileSync(filename)
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('staging signing key invalid')
  const manifest = JSON.parse(bytes.toString('utf8'))
  const { signature, planId, ...body } = manifest
  const expected = createHmac('sha256', key)
    .update(canonical({ ...body, planId })).digest('hex')
  if (!SHA.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || planId !== QA_PLAN_ID || sha(canonical(body)) !== QA_PLAN_ID
    || manifest.version !== 'staged-scene-cut-a8b6-qa-v1'
    || manifest.acceptanceState !== 'QA-only; no first-shot, seam, two-shot or workflow approval'
    || manifest.source?.recordId !== SOURCE_ID
    || manifest.source.resultMd5 !== SOURCE_MD5)
    fail('historical QA signature or source changed')
  return { manifest, manifestSha256: sha(bytes) }
}

/** The fallback is available only after the actual one-time same-pixel retry rejects. */
export function assertA8B6FreshRejectGate(parent, retry, parentMd5, conflict) {
  const before = parent?.nodeRuns, after = retry?.nodeRuns
  const marker = retry?.sceneCutA8B6ConflictReviewRecovery
  const receipt = conflict?.receipt
  if (parent?.id !== REJECTED_ID || parentMd5 !== REJECTED_MD5
    || retry?.id !== RETRY_ID || retry.parentExecutionId !== REJECTED_ID
    || retry.generationScopeId !== RETRY_ID
    || retry.requestScopeId !== parent.requestScopeId
    || retry.workflowId !== parent.workflowId
    || !Array.isArray(before) || !Array.isArray(after)
    || before.length !== 464 || after.length !== 464
    || !isDeepStrictEqual(after.slice(0, 49), before.slice(0, 49))
    || before[49]?.status !== 'success' || before[49].output?.passed !== false
    || before[49].output?.issues?.length !== 1
    || before[49].output.issues[0]?.code !== 'wardrobe_hem_proportion_mismatch'
    || after[49]?.status !== 'success' || after[49].output?.passed !== false
    || !isDeepStrictEqual(after[49].output?.issues?.map(issue => issue.code),
      FINAL_REJECTION_CODES)
    || after.slice(50).some(run => run.status !== 'idle')
    || marker?.version !== 'scene-cut-a8b6-conflict-review-retry-v1'
    || marker.qaPlanId !== QA_PLAN_ID
    || marker.sourceExecutionId !== REJECTED_ID
    || marker.sourceResultMd5 !== REJECTED_MD5
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== GRAPH_NODES_MD5
    || marker.workflowEdgesMd5 !== GRAPH_EDGES_MD5
    || marker.adjudicationReceiptSha256 !== conflict?.receiptSha256
    || marker.adjudicationModelExecutionId !== receipt?.modelExecutionId
    || marker.rejectedReviewSha256 !== receipt?.rejectedReviewSha256
    || marker.originalImageSha256 !== OLD_IMAGE_SHA
    || marker.preservedPrefixLength !== 49
    || marker.preservedPrefixSha256 !== sha(canonical(before.slice(0, 49)))
    || marker.firstPendingIndex !== 49
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-review'
    || receipt?.qaPlanId !== QA_PLAN_ID
    || receipt.rejectedExecutionId !== REJECTED_ID
    || receipt.rejectedResultMd5 !== REJECTED_MD5
    || receipt.sourceImageSha256 !== OLD_IMAGE_SHA)
    fail('same-image model retry has not produced the exact independent identity/hem rejection')
  return { rejectionIssues: FINAL_REJECTION_CODES,
    retryReviewSha256: sha(canonical(after[49].output)),
    rejectedReviewSha256: marker.rejectedReviewSha256 }
}

export function assertA8B6OriginalNarration(tracks, qaTracks, speechWindows, root,
  digestFile = filename => sha(readFileSync(filename))) {
  const windows = [[0, 2.5], [2.5, 7.1], [9.5, 11.75]]
  if (!Array.isArray(tracks) || tracks.length !== 3
    || !isDeepStrictEqual(tracks, qaTracks)
    || !isDeepStrictEqual(speechWindows?.map(track => [track.start, track.end]), windows))
    fail('original narration recipe differs from approved 14s windows')
  for (const [index, track] of tracks.entries()) {
    if (track.beatId !== `b01-narration-${index + 1}`
      || track.start !== windows[index][0] || track.end !== windows[index][1]
      || !SHA.test(String(track.sha256))
      || digestFile(localGenerated(root, track.url, /\.wav$/i)) !== track.sha256)
      fail(`original narration ${index + 1} WAV/text/window changed`)
  }
  return tracks
}

/** Future fresh runners must call this again before authorizing any POST. */
export function assertA8B6FreshCandidateNotHistorical(preflight, candidate) {
  const forbidden = preflight?.forbiddenSources
  if (!Array.isArray(forbidden) || forbidden.length < 5
    || !SHA.test(String(candidate?.firstFrameSha256))
    || !SHA.test(String(candidate?.phaseA?.videoSha256))
    || !SHA.test(String(candidate?.phaseB?.videoSha256))
    || !String(candidate.phaseA.taskId ?? '').trim()
    || !String(candidate.phaseB.taskId ?? '').trim())
    fail('new first image and both paid task/media identities are required')
  const oldShas = new Set(forbidden.map(item => item.sha256))
  const oldUrls = new Set(forbidden.map(item => item.url))
  const oldTaskIds = new Set(forbidden.map(item => item.taskId).filter(Boolean))
  for (const value of [candidate.firstFrameSha256,
    candidate.phaseA.videoSha256, candidate.phaseB.videoSha256])
    if (oldShas.has(value)) fail('fresh candidate reuses historical image/video bytes')
  for (const phase of [candidate.phaseA, candidate.phaseB])
    if (oldTaskIds.has(phase.taskId) || oldUrls.has(phase.videoUrl))
      fail('fresh candidate reuses a historical provider task or video URL')
  if (candidate.phaseA.taskId === candidate.phaseB.taskId
    || candidate.phaseA.videoSha256 === candidate.phaseB.videoSha256)
    fail('new A and B must be distinct paid tasks and native media')
  return true
}

function assertActualRetryReviewLedger(row, runs, workflowRow, root) {
  const request = row?.request_data, params = request?.params
  const node = workflowRow?.nodes?.find(value => value.id === 'sanguo-scene-cut-review')
  const sources = runs[41].output
  const bindings = sources?.referenceBindings
  const imageRefs = sources?.imageReferenceImages
  if (!node || !Array.isArray(bindings) || bindings.length !== 2
    || !Array.isArray(imageRefs) || imageRefs.length !== 2) return false
  const loggedSources = { ...sources, imageReferenceImages: imageRefs.map((value, index) => {
    const bytes = readFileSync(localGenerated(root, bindings[index].frontUrl, /\.jpg$/i))
    if (sha(bytes) !== bindings[index].frontSha256
      || value !== `data:image/jpeg;base64,${bytes.toString('base64')}`)
      fail('retry model identity references differ from frozen plate bytes')
    return `[素材内容已隐藏，${value.length} 字符]`
  }) }
  const images = runs[48].output?.reviewImages
  const hashes = request?.reviewImageHashes
  const reviewed = runs[49].output
  const submitted = Object.fromEntries(Object.entries(reviewed ?? {})
    .filter(([key]) => !['text', 'raw', 'model'].includes(key)))
  const rendered = renderWorkflowTemplate(node.prompt, runs[49].inputContext)
  const stored = rendered.length > 100000
    ? `${rendered.slice(0, 100000)}[日志截断，共${rendered.length}字符]`
    : rendered
  if (row.channel !== 'workflow' || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'sanguo-scene-cut-review' || row.capability !== 'text'
    || row.provider === 'Local' || row.status !== 'succeeded'
    || !/^model-run-[\w-]+$/.test(String(row.id))
    || !String(request?.requestKey ?? '').startsWith(`${RETRY_ID}:`)
    || !SHA.test(String(request?.fingerprint))
    || request.prompt !== stored || params?.qualityDisposition !== 'manual-review-v1'
    || !isDeepStrictEqual(params.shot, runs[11].output)
    || !isDeepStrictEqual(params.evidence, runs[48].output)
    || !isDeepStrictEqual(params.openingStatePlan, runs[43].output)
    || !isDeepStrictEqual(params.reviewImages, images)
    || !isDeepStrictEqual(params.sources, loggedSources)
    || !Array.isArray(images) || images.length !== 3
    || !Array.isArray(hashes) || hashes.length !== images.length
    || images.some((url, index) => hashes[index]?.url !== url
      || hashes[index]?.sha256 !== sha(readFileSync(localGenerated(root, url, /\.jpg$/i))))
    || reviewed?.model !== row.model_id
    || !isDeepStrictEqual(parseStructuredJson(extractTextResponse(row.response_data)),
      submitted)) return false
  return true
}

/** All inputs are read from saved rows and signed local evidence by the CLI. */
export function prepareA8B6FreshRegenerationPreflight({ sourceRow, timingRow,
  rejectedRow, retryRow, workflowRow, qa, conflict, ledgerRows, root = process.cwd() }) {
  if (sourceRow?.id !== SOURCE_ID || sourceRow.result_md5 !== SOURCE_MD5
    || timingRow?.id !== TIMING_ID || timingRow.result_md5 !== TIMING_MD5
    || rejectedRow?.id !== REJECTED_ID || rejectedRow.result_md5 !== REJECTED_MD5
    || retryRow?.id !== RETRY_ID || retryRow.result_md5 !== RETRY_MD5
    || sourceRow.workflow_id !== 'wf-sanguo-history-drama'
    || [timingRow, rejectedRow, retryRow].some(row => row.workflow_id !== sourceRow.workflow_id)
    || workflowRow?.schema_version !== 180
    || workflowRow.nodes_md5 !== GRAPH_NODES_MD5
    || workflowRow.edges_md5 !== GRAPH_EDGES_MD5)
    fail('source history, current retry or schema180 graph changed')
  const source = decodeExecutionState(sourceRow.result)
  const timing = decodeExecutionState(timingRow.result)
  const rejected = decodeExecutionState(rejectedRow.result)
  const retry = decodeExecutionState(retryRow.result)
  const oldRuns = source.nodeRuns, timed = timing.nodeRuns, before = rejected.nodeRuns
  if (source.id !== SOURCE_ID || timing.id !== TIMING_ID
    || timing.parentExecutionId !== SOURCE_ID
    || rejected.parentExecutionId !== TIMING_ID
    || !Array.isArray(oldRuns) || oldRuns.length !== 464
    || !Array.isArray(timed) || timed.length !== 464
    || !isDeepStrictEqual(timed.slice(0, 9), oldRuns.slice(0, 9))
    || !isDeepStrictEqual(before.slice(0, 45), timed.slice(0, 45))
    || timed[10]?.status !== 'success' || timed[10].output?.decision !== 'pass'
    || !isDeepStrictEqual(timed[10].output?.warnings, [])
    || !isDeepStrictEqual(timed[10].output?.issues, [])
    || timed[11]?.status !== 'success' || timed[11].output?.passed !== true
    || timed[11].output?.manualDecisionRequired !== false
    || timed[11].output?.duration !== 14
    || sceneCutShotSha256(timed[11].output) !== APPROVED_14S_SHOT_SHA
    || timed[11].output.scheduleHash !== APPROVED_SCHEDULE_HASH
    || timed[11].output.pacing?.scheduleHash !== APPROVED_SCHEDULE_HASH
    || timed[11].output.audioText !== oldRuns[11]?.output?.audioText
    || timed[43]?.status !== 'success'
    || timed[43].output?.shotSha256 !== APPROVED_14S_SHOT_SHA
    || timed[45]?.status !== 'failed'
    || !String(timed[45].error ?? '').includes('SCENE_CUT_EDIT_BINDER_INVALID')
    || timed.slice(46).some(run => run.status !== 'idle')
    || oldRuns[50]?.status !== 'success'
    || oldRuns[52]?.status !== 'success'
    || qa?.manifest?.planId !== QA_PLAN_ID
    || qa.manifest.source?.recordId !== SOURCE_ID
    || qa.manifest.source?.resultMd5 !== SOURCE_MD5)
    fail('approved timing, opening, narration or original source lineage changed')
  const timingMarker = timing.sceneCutA8B6TimingRecovery
  if (timingMarker?.version !== 'scene-cut-a8b6-timing-fork-v1'
    || timingMarker.sourceExecutionId !== SOURCE_ID
    || timingMarker.sourceResultMd5 !== SOURCE_MD5
    || timingMarker.qaPlanId !== QA_PLAN_ID
    || timingMarker.amendedScheduleHash !== APPROVED_SCHEDULE_HASH
    || timingMarker.workflowSchemaVersion !== 180
    || timingMarker.workflowNodesMd5 !== GRAPH_NODES_MD5
    || timingMarker.workflowEdgesMd5 !== GRAPH_EDGES_MD5)
    fail('signed 14s storyboard fork ancestry changed')
  const oldCertificate = verifySceneCutFrameApproval(oldRuns[50].output, root)
  const plates = oldCertificate.identityPlateBindings
  const references = oldRuns[41]?.output?.referenceBindings
  if (oldRuns[41]?.output?.identityPlateVersion !== 'scene-cut-identity-plate-v4'
    || !Array.isArray(plates) || plates.length !== 2
    || !Array.isArray(references) || references.length !== 2
    || plates.map(item => item.characterName).join(',') !== '张飞,严颜'
    || plates.some((plate, index) => plate.frontUrl !== references[index].frontUrl
      || plate.frontSha256 !== references[index].frontSha256
      || plate.sourceSha256 !== references[index].sha256
      || sha(readFileSync(localGenerated(root, plate.frontUrl, /\.jpg$/i)))
        !== plate.frontSha256)
    || timed[41]?.output?.version !== 'scene-cut-sources-v1'
    || timed[41].output.identityPlateVersion !== 'scene-cut-identity-plate-v4'
    || !isDeepStrictEqual(timed[41].output.referenceBindings, references)
    || !isDeepStrictEqual(timed[41].output.imageReferenceImages,
      oldRuns[41].output.imageReferenceImages)
    || !isDeepStrictEqual(timed[41].output.referenceImages,
      oldRuns[41].output.referenceImages)
    || oldCertificate.shotSha256 !== qa.manifest.source.approvedShotSha256
    || sceneCutRebindSha256(oldCertificate) !== qa.manifest.source.approvalSha256)
    fail('frozen identity plates or original frame certificate changed')
  const rejectedResult = assertA8B6FreshRejectGate(rejected, retry,
    rejectedRow.result_md5, conflict)
  const reviewer = Array.isArray(ledgerRows) ? ledgerRows.find(row => {
    try {
      return assertActualRetryReviewLedger(row, retry.nodeRuns, workflowRow, root)
    } catch { return false }
  }) : undefined
  if (!reviewer) fail('same-image second rejection lacks an exact managed model ledger')
  const tracks = assertA8B6OriginalNarration(oldRuns[52].output?.raw?.narration?.tracks,
    qa.manifest.narration?.tracks, timed[11].output.pacing?.speechWindows, root)
  const oldVideo = oldRuns[52].output
  const forbiddenSources = [
    { kind: 'old-first-image', url: oldRuns[45].output.url,
      sha256: oldCertificate.sourceSha256s[0] },
    { kind: 'old-rejected-fresh-v2-image',
      url: '/generated/image-18e4feab5da795450b653bed01967251.png',
      sha256: '18e4feab5da795450b653bed01967251e96427e8d88ef86527a1470b6e3c97c8' },
    { kind: 'old-rejected-fresh-v3-image',
      url: '/generated/image-d8944a9e69d092a95990574615e375b0.png',
      sha256: 'd8944a9e69d092a95990574615e375b0dd024cd47d8742abbb3a8f964cab9c3c' },
    { kind: 'old-thirteen-second-take', url: oldVideo.url,
      sha256: sha(readFileSync(localGenerated(root, oldVideo.url, /\.mp4$/i))) },
    { kind: 'old-A', url: qa.manifest.source.originalAVideoUrl,
      sha256: qa.manifest.source.originalAVideoSha256,
      taskId: qa.manifest.source.originalATaskId },
    { kind: 'old-B', url: qa.manifest.source.BVideoUrl,
      sha256: qa.manifest.source.BVideoSha256,
      taskId: qa.manifest.source.BTaskId },
    // Earlier rejected paid takes remain in the same case history. The QA
    // manifest names the latest A/B only, so bind their exact task/media IDs
    // here as exclusions as well.
    { kind: 'old-earlier-A-1',
      url: '/generated/staged-phase-A-933777146047647765.mp4',
      sha256: 'a12c80f5b6742c61e12c23d33b67549e664f859aa063ea80b6fca4e2fbb19580',
      taskId: '933777146047647765' },
    { kind: 'old-earlier-A-2',
      url: '/generated/staged-phase-A-933780648094494775.mp4',
      sha256: '84e9ecfccacef6b2fb98b616fe2f8f2ad5da28b221c79ff9f983200f0019f96e',
      taskId: '933780648094494775' },
    { kind: 'old-earlier-B',
      url: '/generated/staged-a8b5-phase-B-933813742730084445.mp4',
      sha256: '11dec8fb80b62d4d70eec2bfdcb9e03a370990a365259ddccd809d15d7a35eba',
      taskId: '933813742730084445' },
    { kind: 'old-QA-picture', url: qa.manifest.picture?.url,
      sha256: qa.manifest.picture?.sha256 },
    { kind: 'old-QA-narrated', url: qa.manifest.narration?.qaUrl,
      sha256: qa.manifest.narration?.qaSha256 },
  ]
  if (forbiddenSources.some(item => !/^\/generated\/[\w.-]+$/.test(String(item.url))
    || !SHA.test(String(item.sha256))))
    fail('historical media exclusion list lacks exact asset bytes')
  const oldComposite = path.join(root, '.runtime/staged-scene-cut-a8b6-qa',
    QA_PLAN_ID, 'composite-receipt.json')
  if (existsSync(oldComposite)) fail('old QA plan has a formal composite receipt; fallback would branch from stale status')
  return { version: 'a8b6-fresh-regeneration-preflight-v1',
    status: 'ready-for-fresh-first-frame-planning-only',
    source: { executionId: SOURCE_ID, resultMd5: SOURCE_MD5,
      timingExecutionId: TIMING_ID, timingResultMd5: TIMING_MD5,
      rejectedExecutionId: REJECTED_ID, rejectedResultMd5: REJECTED_MD5,
      retryExecutionId: RETRY_ID, retryResultMd5: retryRow.result_md5,
      qaPlanId: QA_PLAN_ID, qaManifestSha256: qa.manifestSha256,
      conflictReceiptSha256: conflict.receiptSha256,
      retryReviewSha256: rejectedResult.retryReviewSha256,
      retryReviewModelExecutionId: reviewer.id,
      sourceFrameCertificateSha256: sceneCutRebindSha256(oldCertificate) },
    approved14s: { shotSha256: APPROVED_14S_SHOT_SHA,
      scheduleHash: APPROVED_SCHEDULE_HASH, durationSeconds: 14,
      openingPlanSha256: sha(canonical(timed[43].output)),
      fullSourceMuteRequired: true,
      narrationTracks: tracks.map(track => ({ ...track })) },
    frozenIdentityPlates: plates.map(plate => ({ characterName: plate.characterName,
      assetId: plate.assetId, sourceUrl: plate.sourceUrl,
      sourceSha256: plate.sourceSha256,
      frontUrl: plate.frontUrl, frontSha256: plate.frontSha256,
      partSha256s: plate.partSha256s })),
    forbiddenSources,
    nextGates: ['new first-frame model generation/review/certificate under approved14s',
      'new paid A8 native task, frame-by-frame completion and tail approval',
      'new paid B6 from exact A actual tail, native seam and closing review',
      'new 14s original-speed picture, mixer6 original WAV transfer and direct review',
      'new workflow approval/composite receipt; then fresh scene-02 image/video'],
    providerAuthorization: false, firstShotAccepted: false,
    providerCalls: 0, databaseWrites: 0, mediaWrites: 0 }
}

export const A8B6_FRESH_PREFLIGHT_SOURCE_IDS = Object.freeze({ SOURCE_ID,
  TIMING_ID, REJECTED_ID, RETRY_ID, RETRY_MD5, QA_PLAN_ID })
