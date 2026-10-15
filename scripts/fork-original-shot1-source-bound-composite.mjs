#!/usr/bin/env node
/** Preserve the rejected tail-guide video and attach a separately receipted
 * composite as scene-01's new take. Preparation never buys provider media. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { verifySceneCutFrameApproval, validateSceneCutVideoPayment } from '../server/scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { verifyStagedSceneCutCompositeReceipt } from '../server/staged-scene-cut.mjs'
import { readStagedSceneCutManifest } from '../server/staged-scene-cut.mjs'
import * as a8b5 from '../server/staged-scene-cut-a8b5.mjs'
import { assertSourceBoundCompositeHop, compositeStageReceiptHashes } from '../server/scene-cut-source-bound-composite.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const SOURCE_ID = 'record-4x5m31-original-repair-tail-guide-v2'
const SOURCE_MD5 = '34abee4a7c010616b837dbc175b69c56'
const WORKFLOW_ID = 'wf-sanguo-history-drama'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const SHA = /^[a-f0-9]{64}$/
const ID = /^record-[\w-]+$/
const fail = message => { throw Error(`SOURCE_BOUND_COMPOSITE_FORK_INVALID: ${message}`) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const localVideo = (root, url) => {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.mp4$/i.test(url)) fail('composite is not an archived local video')
  try { return readFileSync(path.join(root, 'public', url.slice(1))) }
  catch { return fail('composite video bytes are missing') }
}

/** A provisional A8+B5 plan is never an accepted composite. Its separate
 * verifier must have admitted B, the seam, narration and the final receipt. */
export async function verifyCompositeForSourceBoundFork(planId,
  stagingVariant = 'standard', root = process.cwd()) {
  if (!SHA.test(String(planId))) fail('staged plan ID is invalid')
  if (stagingVariant === 'a8b5') {
    if (typeof a8b5.verifyA8B5CompositeReceipt !== 'function')
      fail('A8+B5 final composite verifier is not available')
    return a8b5.verifyA8B5CompositeReceipt(planId, root)
  }
  if (stagingVariant !== 'standard') fail('unknown staged composite variant')
  return verifyStagedSceneCutCompositeReceipt(planId, root)
}

/** This inserts no record. The verifier reads the signed staging receipts and
 * rechecks source files before a node52 output is constructed. */
export async function prepareOriginalShot1SourceBoundCompositeFork(source, workflow, {
  planId, id = 'record-original-shot1-source-bound-composite-preview',
  stagingVariant = 'standard',
  root = process.cwd(),
} = {}) {
  if (source?.id !== SOURCE_ID || source.result_md5 !== SOURCE_MD5
    || source.workflow_id !== WORKFLOW_ID || !ID.test(id) || id === source.id
    || workflow?.id !== WORKFLOW_ID || workflow.schema_version !== 180
    || workflow.nodes_md5 !== NODES_MD5 || workflow.edges_md5 !== EDGES_MD5
    || !Array.isArray(workflow.nodes) || workflow.nodes.length !== 72
    || !Array.isArray(workflow.edges) || workflow.edges.length !== 87
    || !SHA.test(String(planId)) || !['standard', 'a8b5'].includes(stagingVariant))
    fail('source identity, manifest, or schema180 graph changed')

  const parent = decodeExecutionState(source.result)
  const before = parent.nodeRuns
  const certificate = before?.[50]?.output
  const oldTake = before?.[52]?.output
  const oldReview = before?.[58]?.output
  const oldAccept = before?.[59]?.output
  if (parent.id !== source.id || parent.workflowId !== WORKFLOW_ID
    || parent.generationScopeId !== source.id || !parent.requestScopeId
    || parent.sceneCutApprovalRebindRecovery?.version !== 'scene-cut-approval-rebind-v2'
    || !Array.isArray(before) || before.length !== 464
    || before.some(run => run.status === 'running')
    || before.slice(0, 53).some(run => !['success', 'skipped'].includes(run.status))
    || before[50]?.node?.id !== 'sanguo-scene-cut-approval'
    || before[51]?.node?.id !== 'sanguo-video-reference-router'
    || before[52]?.node?.id !== 'sanguo-video'
    || before[53]?.node?.id !== 'sanguo-media-request'
    || before[58]?.node?.id !== 'sanguo-media-review'
    || before[59]?.node?.id !== 'sanguo-media-accept'
    || before[64]?.node?.id !== 'sanguo-last-frame'
    || before[65]?.node?.id !== 'sanguo-shot-script'
    || before.slice(53, 60).some(run => !['success', 'skipped'].includes(run.status))
    || before.slice(60).some(run => run.status !== 'idle')
    || certificate?.passed !== true || certificate.repairBinding?.executionId !== source.id
    || oldReview?.decision !== 'revise' || !Array.isArray(oldReview.issues)
    || !oldReview.issues.some(item => item?.code === 'core_event_contradiction')
    || oldAccept?.manualDecisionRequired !== true
    || oldAccept?.qualityDisposition !== 'manual-review-v1'
    || typeof oldTake?.url !== 'string') {
    fail('parent is not the settled, independently rejected tail-guide-v2 take')
  }
  verifySceneCutFrameApproval(certificate, root)
  validateSceneCutVideoPayment(oldTake.params, root)
  if (oldTake.params?.sceneCutFrameGate?.signature !== certificate.signature
    || oldTake.params?.sceneCutShot?.id !== 'scene-01'
    || oldTake.params.sceneCutShot.duration !== 13
    || oldTake.params.referenceImage !== certificate.frame.sourceUrl
    || sceneCutRebindSha256(oldTake.params.sceneCutShot) !== certificate.shotSha256)
    fail('parent take lost its signed original thirteen-second shot')

  const verified = await verifyCompositeForSourceBoundFork(planId, stagingVariant, root)
  const { manifest, receipt, manifestSha256, receiptSha256 } = verified ?? {}
  const a8b5Variant = stagingVariant === 'a8b5'
  const sourceManifest = a8b5Variant
    ? await readStagedSceneCutManifest(manifest?.source?.planId, root) : manifest
  const sourceBinding = a8b5Variant ? manifest?.source : manifest
  const phaseAEnd = a8b5Variant ? 192 : 180
  const phaseBEnd = a8b5Variant ? 120 : 132
  if ((a8b5Variant
    ? manifest?.version !== 'staged-scene-cut-a8b5-provisional-v1'
      || sourceManifest?.version !== 'staged-scene-cut-shot1-v3-compact1'
    : !['staged-scene-cut-shot1-v1',
      'staged-scene-cut-shot1-v3-compact1'].includes(manifest?.version))
    || manifest.planId !== planId
    || (a8b5Variant ? sourceBinding.recordId : sourceBinding.sourceRecordId) !== source.id
    || (a8b5Variant ? sourceBinding.resultMd5 : sourceBinding.sourceResultMd5) !== source.result_md5
    || sourceBinding.approvedShotSha256 !== certificate.shotSha256
    || sourceBinding.approvalSha256 !== sceneCutRebindSha256(certificate)
    || sourceManifest.first?.url !== certificate.frame.sourceUrl
    || sourceManifest.first?.sha256 !== certificate.sourceSha256s?.[0]
    || !Array.isArray(sourceManifest.identities)
    || sourceManifest.identities.length !== certificate.assets.length
    || sourceManifest.identities.some((item, index) => item.url !== certificate.assets[index].sourceUrl
      || item.sha256 !== certificate.sourceSha256s[index + 1])
    || sourceManifest.rejectedVideo?.url !== oldTake.url
    || sourceManifest.rejectedVideo?.sha256 !== sha256(localVideo(root, oldTake.url))
    || receipt?.planId !== planId || receipt.review?.seamVerdict !== 'accept'
    || receipt.review?.wholeShot !== 'pending-node58'
    || receipt.sources?.phaseA?.acceptedFrameIndex !== phaseAEnd
    || receipt.sources?.phaseB?.acceptedFrameIndex !== phaseBEnd
    || receipt.seam?.phaseAFrameIndex !== phaseAEnd
    || receipt.seam?.phaseBFirstFrameIndex !== 0
    || receipt.seam?.stitchedPhaseBStartFrameIndex !== 1
    || receipt.picture?.frameCount !== 313 || receipt.picture?.fps !== 24
    || receipt.picture?.silentAudio !== true
    || typeof receipt.picture?.url !== 'string' || !SHA.test(String(receipt.picture?.sha256))
    || typeof receipt.narration?.url !== 'string'
    || !/^\/generated\/narrated-[a-f0-9]{64}\.mp4$/.test(receipt.narration.url)
    || !SHA.test(String(receipt.narration?.sha256))
    || receipt.output?.url !== receipt.narration.url
    || receipt.output?.sha256 !== receipt.narration.sha256
    || receipt.narration?.fullSourceMute !== true
    || receipt.narration?.mixerVersion !== 6
    || !Array.isArray(receipt.narration?.ttsTrackSha256s)
    || !isDeepStrictEqual(receipt.narration.ttsTrackSha256s,
      sourceManifest.narrationTracks?.map(track => track.sha256))
    || a8b5Variant && !isDeepStrictEqual(manifest.narrationTracks,
      sourceManifest.narrationTracks)
    || !SHA.test(String(manifestSha256)) || !SHA.test(String(receiptSha256))
    || sha256(localVideo(root, receipt.picture.url)) !== receipt.picture.sha256
    || sha256(localVideo(root, receipt.narration.url)) !== receipt.narration.sha256
    || receipt.narration.url === oldTake.url) {
    fail('signed segment/composite receipt is not bound to the rejected parent and approved shot')
  }
  const sourceTracks = oldTake.narration?.tracks
  if (!Array.isArray(sourceTracks) || sourceTracks.length !== 3
    || !isDeepStrictEqual(sourceTracks, sourceManifest.narrationTracks))
    fail('composite narration did not retain the original three TTS sources and timing')
  const stageReceiptSha256s = compositeStageReceiptHashes(planId, root,
    stagingVariant, manifest)

  const compactReceipt = { version: 'source-bound-composite-take-v1', planId,
    stagingVariant,
    manifestSha256, receiptSha256, stageReceiptSha256s,
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    sourceVideoUrl: oldTake.url, sourceVideoSha256: sourceManifest.rejectedVideo.sha256,
    pictureUrl: receipt.picture.url, pictureSha256: receipt.picture.sha256,
    narratedUrl: receipt.narration.url, narratedSha256: receipt.narration.sha256,
    segmentTasks: [receipt.sources.phaseA.taskId, receipt.sources.phaseB.taskId],
    seamVerdict: receipt.review.seamVerdict, wholeShotReview: 'pending-node58',
    wholeShotProviderTask: null }
  const { endImage: _oldEndImage, ...baseParams } = oldTake.params
  void _oldEndImage
  const output = {
    raw: compactReceipt,
    url: receipt.narration.url,
    model: 'source-bound-composite-v1',
    params: { ...baseParams, productionMode: 'source-bound-composite-v1',
      sourceBoundComposite: { planId, manifestSha256, receiptSha256 } },
    narration: { route: 'independent-narration-v1', url: receipt.narration.url,
      pictureUrl: receipt.picture.url, tracks: sourceTracks,
      audioRole: 'narration', compositionReceiptKey: receipt.narration.compositionReceiptKey },
    voiceManifest: oldTake.voiceManifest,
    voiceConsistency: { status: 'uncertain', reason: '分段合成后须重新听审整镜旁白、环境音和画内口型' },
    qualityDisposition: oldTake.qualityDisposition,
    sourceBoundComposite: compactReceipt,
  }
  const prepared = prepareWorkflowRunContext(before, 52)
  if (prepared?.run?.node.id !== 'sanguo-video'
    || prepared.inputContext.scene_cut_frame_gate?.signature !== certificate.signature)
    fail('source video context does not carry the signed first-frame approval')
  const { end_frame: _oldTargetGuide, ...inputContext } = prepared.inputContext
  void _oldTargetGuide
  const takeContext = applyNodeOutputToContext(inputContext, before[52].node.resultVar, output)
  const selected = { ...before[52], output, context: takeContext, inputContext,
    inputs: { ...before[52].inputs, endImage: undefined,
      sourceBoundComposite: { planId, manifestSha256, receiptSha256 } },
    routeInputOverrides: undefined,
    status: 'success', revision: Number(before[52].revision ?? 0) + 1,
    startedAt: undefined, durationMs: 0 }
  const replaced = before.map((run, index) => index === 52 ? selected : run)
  const nodeRuns = refreshPendingExecutionNodes(workflow, manualRetryRuns(replaced, 53))
  if (!isDeepStrictEqual(nodeRuns.slice(0, 52), before.slice(0, 52))
    || nodeRuns[52].output !== output || nodeRuns.slice(53).some(run => run.status !== 'idle'
      || run.output !== undefined || Object.keys(run.context ?? {}).length !== 0)
    || nodeRuns.findIndex(run => run.status === 'idle') !== 53)
    fail('fork changed the signed prefix or retained parent media reviews')
  const next = prepareWorkflowRunContext(nodeRuns, 53)
  if (next?.run?.node.id !== 'sanguo-media-request'
    || next.inputContext.video_take?.url !== receipt.narration.url
    || next.inputContext.media_review !== undefined
    || next.inputContext.video_evidence !== undefined)
    fail('node53 would not re-evaluate the exact new whole-shot composite')
  const marker = { version: 'source-bound-composite-first-shot-v1',
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    workflowSchemaVersion: 180, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5,
    originalExecutionId: 'record-4x5m31',
    preservedPrefixLength: 52, preservedPrefixSha256: sceneCutRebindSha256(before.slice(0, 52)),
    inheritedCertificateExecutionId: source.id,
    inheritedCertificateSha256: sceneCutRebindSha256(certificate),
    failedParentVideoUrl: oldTake.url, failedParentVideoSha256: sourceManifest.rejectedVideo.sha256,
    failedReviewSha256: sceneCutRebindSha256(oldReview),
    failedAcceptSha256: sceneCutRebindSha256(oldAccept),
    planId, stagingVariant, manifestSha256, receiptSha256, stageReceiptSha256s,
    compositeVideoUrl: receipt.narration.url, compositeVideoSha256: receipt.narration.sha256,
    compositeTakeSha256: sceneCutRebindSha256(output),
    firstPendingIndex: 53, firstPendingNodeId: nodeRuns[53].node.id,
    wholeShotReview: 'pending-node58' }
  const state = { ...parent, id, parentExecutionId: source.id,
    generationScopeId: id, requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns, context: takeContext,
    selectedNodeId: nodeRuns[53].node.id,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutCompositeRecovery: marker,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      `保留 ${source.id} 已否定的付费视频；本分支从有独立分段及拼接收据的复合首镜重新采证。`] }
  assertSourceBoundCompositeHop(parent, state, source.result_md5, root, false)
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state))))) !== hash(state))
    fail('execution storage round trip changed the composite checkpoint')
  return { state, proof: { ...marker, newExecutionId: id,
    providerCalls: 0, databaseWrites: 0, firstShotAccepted: false,
    segmentReceiptsPreserved: true, parentRecordPreserved: true,
    node52ProviderTaskCount: 0, roundTripVerified: true } }
}

function parseArgs(args) {
  const options = { apply: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') {
      if (options.apply) fail('duplicate --apply')
      options.apply = true
      continue
    }
    const field = { '--plan': 'planId', '--id': 'id',
      '--staging-variant': 'stagingVariant',
      '--expected-source-md5': 'sourceMd5', '--expected-nodes-md5': 'nodesMd5',
      '--expected-edges-md5': 'edgesMd5' }[args[i]]
    if (!field || options[field] !== undefined || !args[i + 1] || args[i + 1].startsWith('--'))
      fail(`unknown, duplicate, or incomplete argument ${args[i]}`)
    options[field] = args[++i]
  }
  if (!SHA.test(String(options.planId))) fail('--plan must be the saved staging plan SHA-256')
  if (options.stagingVariant !== undefined
    && !['standard', 'a8b5'].includes(options.stagingVariant))
    fail('--staging-variant must be standard or a8b5')
  if (options.id !== undefined && (!ID.test(options.id) || options.id === SOURCE_ID))
    fail('--id must name a new record')
  if (options.sourceMd5 !== undefined && options.sourceMd5 !== SOURCE_MD5)
    fail('source MD5 lock differs from the reviewed rejected record')
  if (options.nodesMd5 !== undefined && options.nodesMd5 !== NODES_MD5)
    fail('nodes MD5 lock differs from schema180')
  if (options.edgesMd5 !== undefined && options.edgesMd5 !== EDGES_MD5)
    fail('edges MD5 lock differs from schema180')
  if (options.apply && (!options.id || !options.sourceMd5
    || !options.nodesMd5 || !options.edgesMd5))
    fail('--apply requires a new ID and all three reviewed database MD5 locks')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${suffix}`,
      [SOURCE_ID])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${suffix}`,
      [WORKFLOW_ID])).rows[0]
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1', [options.id])).rowCount)
      fail('new record ID already exists')
    const { state, proof } = await prepareOriginalShot1SourceBoundCompositeFork(source, workflow, options)
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `原首镜分段合成再采证 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result)) !== createJsonHasher()(state))
        fail('saved fork differs from source-bound checkpoint')
    }
    const parentAfter = (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
      [SOURCE_ID])).rows[0]
    const graphAfter = (await db.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [WORKFLOW_ID])).rows[0]
    if (parentAfter?.md5 !== source.result_md5
      || graphAfter?.schema_version !== workflow.schema_version
      || graphAfter?.nodes_md5 !== workflow.nodes_md5
      || graphAfter?.edges_md5 !== workflow.edges_md5)
      fail('parent record or workflow changed while preparing the fork')
    await db.query(options.apply ? 'COMMIT' : 'ROLLBACK')
    console.log(JSON.stringify({ ...proof, applied: options.apply,
      databaseWrites: options.apply ? 1 : 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
