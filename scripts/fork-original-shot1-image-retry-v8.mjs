#!/usr/bin/env node
// Fork the rejected original scene-01 v7 image into a schema178 checkpoint.
// Dry-run by default. No provider is called; an explicit, hash-pinned --apply
// only inserts a new record and leaves the source/review/media untouched.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V178 } from '../src/scene-cut-geometry-guide-workflow.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { ORIGINAL_TWO_SHOT_CONTENT_HASHES,
  prepareOriginalTwoShotForkPreview } from './preview-original-two-shot-fork.mjs'
import { preservePrefixBeforeOpening } from './fork-original-shot1-opening-retry.mjs'
import { assertV4IdentityBoardBytes } from './fork-original-shot1-image-retry.mjs'
import { prepareRejectedSceneCutFourReferences } from './prepare-scene-cut-rejected-image-four-reference.mjs'
import { assertOriginalSecondShotArrivalRoute } from './replay-original-second-shot-candidate.mjs'

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const V6_ID = 'record-4x5m31-original-repair-v6'
const V6_MD5 = '21f1f7a2131fe7c3d0e97998d16245a3'
const SOURCE_ID = 'record-4x5m31-original-repair-v7'
const SOURCE_MD5 = '0c2421f0e2e33a563f73c44dea53d44f'
const IMAGE_SHA = '4218a56c75d532f7cf629176d73b7138c05e28be656c9ff5831568dc6828fb48'
const REVIEW_SHA = 'faad209cbc612d5eb67e2d32f2a668e0a15dc76fdb3cfa94bb4d4784902f2da2'
const GUIDE_PATH = 'qa/record-4x5m31/geometry-guide-v8-0d23d49f.png'
const GUIDE_SHA = '0d23d49f076dc1ce1e52a6de81f049d588499be720037755c73e3f8f9f0726b2'
const GUIDE_PROVENANCE_PATH = 'qa/record-4x5m31/geometry-guide-v8-provenance.json'
const GUIDE_PROVENANCE_SHA = '4005ced1b6d381d8c474ec2e606186394509ec9a728c70f23009f3684cf84e2d'
const SOURCE_NODES_MD5 = '66403a851ef7b3abba0dfa836d6727c1'
const TARGET_NODES_MD5 = '2e68e68dea063bdb645523ef8a64ad6d'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const SCHEMA = 178
const CUT = 45
const ARCHIVE = 41
const PLAN = 43
const IMAGE = 45
const REVIEW = 49
const fail = message => { throw Error(`ORIGINAL_SHOT1_IMAGE_V8_RETRY_INVALID: ${message}`) }
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256Json = value => sha256Bytes(Buffer.from(JSON.stringify(value)))
const md5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const same = isDeepStrictEqual

/** The managed schema178 graph may change only the eight image prompts. */
export function assertV8ImagePromptOnlyUpgrade(sourceRuns, targetRuns) {
  if (!Array.isArray(sourceRuns) || !Array.isArray(targetRuns)
    || sourceRuns.length !== targetRuns.length) fail('upgrade queue is invalid')
  let images = 0; let reviews = 0
  for (let index = 0; index < sourceRuns.length; index++) {
    const before = sourceRuns[index], after = targetRuns[index]
    if (before?.node?.id !== after?.node?.id || before.loopIndex !== after.loopIndex
      || before.loopGroupId !== after.loopGroupId || !same(before.loopNode, after.loopNode)) {
      fail(`schema178 topology or loop owner changed at index ${index}`)
    }
    if (before.node.id === 'sanguo-scene-cut-first-frame') {
      if (before.node.prompt === after.node.prompt
        || after.node.prompt !== SCENE_CUT_FIRST_FRAME_PROMPT_V178
        || !same(before.node, { ...after.node, prompt: before.node.prompt })) {
        fail(`image node changed beyond the managed prompt at index ${index}`)
      }
      images++
    } else {
      if (!same(before.node, after.node)) fail(`non-image node changed at index ${index}`)
      if (before.node.id === 'sanguo-scene-cut-review') reviews++
    }
  }
  if (images !== 8 || reviews !== 8) fail('all eight image prompts and reviewer snapshots must be checked')
  return { changedImagePrompts: images, unchangedReviewPrompts: reviews }
}

/** Reuse each completed run verbatim; only the target-graph suffix is idle. */
export function buildV8ImageRetryQueue(sourceRuns, targetRuns) {
  const promptUpgrade = assertV8ImagePromptOnlyUpgrade(sourceRuns, targetRuns)
  const nodeRuns = preservePrefixBeforeOpening(sourceRuns, targetRuns, CUT)
  if (!same(nodeRuns.slice(0, CUT), sourceRuns.slice(0, CUT))
    || nodeRuns[CUT]?.node?.id !== 'sanguo-scene-cut-first-frame'
    || nodeRuns[CUT].status !== 'idle'
    || nodeRuns.slice(CUT).some(run => run.status !== 'idle')) {
    fail('completed prefix changed or new image/suffix is not idle')
  }
  return { nodeRuns, promptUpgrade }
}

/** Preserve the helper's exact byte-derived receipt and prior failed edit. */
export function sceneCutFourReferenceRepairMarker({ sourceId, sourceMd5, parentId, parentMd5,
  originalId, originalMd5, workflow, prefixOutputsHash, prepared, prior }) {
  const receipt = prepared?.receipt
  const order = receipt?.referenceOrder
  if (sourceId !== SOURCE_ID || sourceMd5 !== SOURCE_MD5
    || parentId !== V6_ID || parentMd5 !== V6_MD5
    || originalId !== ORIGINAL_ID || originalMd5 !== ORIGINAL_MD5
    || workflow?.schema_version !== SCHEMA || workflow.nodes_md5 !== TARGET_NODES_MD5
    || workflow.edges_md5 !== EDGES_MD5 || !/^[a-f0-9]{64}$/.test(prefixOutputsHash ?? '')
    || prior?.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || prior.sourceExecutionId !== V6_ID || prior.sourceResultMd5 !== V6_MD5
    || !/^[a-f0-9]{64}$/.test(prior.repairPreparationSha256 ?? '')
    || receipt?.version !== 'scene-cut-rejected-image-edit-reference-v2'
    || receipt.role !== 'reference-only' || receipt.sourceVerdict !== 'rejected'
    || receipt.approvedFirstFrame !== false || receipt.requiresFreshIndependentReview !== true
    || receipt.sourceExecutionId !== SOURCE_ID || receipt.sourceResultMd5 !== SOURCE_MD5
    || receipt.sourceImageSha256 !== IMAGE_SHA || receipt.failedReviewOutputSha256 !== REVIEW_SHA
    || receipt.priorRepairPreparationSha256 !== prior.repairPreparationSha256
    || receipt.priorRepairMarkerHash !== createJsonHasher()(prior)
    || receipt.geometryGuide?.sourcePath !== GUIDE_PATH
    || receipt.geometryGuide.sourceSha256 !== GUIDE_SHA
    || !Array.isArray(order) || order.length !== 4
    || order.some((entry, index) => entry.position !== index + 1)
    || order[2].role !== 'rejected-edit-source' || order[2].sourceSha256 !== IMAGE_SHA
    || order[3].role !== 'geometry-guide' || order[3].purpose !== 'geometry-only'
    || order[3].referenceOnly !== true || order[3].sourcePath !== GUIDE_PATH
    || order[3].sourceSha256 !== GUIDE_SHA
    || !Array.isArray(prepared.referenceImages) || prepared.referenceImages.length !== 4
    || prepared.receiptSha256 !== sha256Json(receipt)) {
    fail('rejected image preparation receipt or parent chain changed')
  }
  for (const index of [2, 3]) {
    const uri = prepared.referenceImages[index]
    const encoded = typeof uri === 'string' && uri.startsWith('data:image/jpeg;base64,')
      ? uri.slice('data:image/jpeg;base64,'.length) : ''
    const bytes = encoded && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
    if (!bytes.length || bytes.toString('base64') !== encoded
      || sha256Bytes(bytes) !== order[index].jpegSha256
      || bytes.length !== order[index].bytes) fail(`reference ${index + 1} JPEG differs from its receipt`)
  }
  return {
    version: 'scene-cut-image-repair-schema178-fork-v2',
    sourceExecutionId: sourceId, sourceResultMd5: sourceMd5,
    parentExecutionId: parentId, parentResultMd5: parentMd5,
    originalExecutionId: originalId, originalResultMd5: originalMd5,
    workflowSchemaVersion: SCHEMA, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5,
    preservedPrefixLength: CUT, firstPendingNodeId: 'sanguo-scene-cut-first-frame',
    failedImageFileSha256: IMAGE_SHA, failedReviewOutputSha256: REVIEW_SHA,
    repairPreparationSha256: prepared.receiptSha256,
    priorRepairPreparationSha256: prior.repairPreparationSha256,
    geometryGuideSourcePath: GUIDE_PATH, geometryGuideSourceSha256: GUIDE_SHA,
    geometryGuideJpegSha256: order[3].jpegSha256,
    geometryGuideProvenancePath: GUIDE_PROVENANCE_PATH,
    geometryGuideProvenanceSha256: GUIDE_PROVENANCE_SHA,
    preservedPrefixOutputsHash: prefixOutputsHash,
    receipt,
  }
}

function parseArgs(argv) {
  const options = { apply: false }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--apply') {
      if (options.apply) fail('duplicate --apply')
      options.apply = true
      continue
    }
    const key = { '--source': 'sourceId', '--id': 'id',
      '--expected-source-md5': 'sourceMd5', '--expected-nodes-md5': 'nodesMd5',
      '--expected-edges-md5': 'edgesMd5' }[flag]
    if (!key || options[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      fail(`unknown, duplicate or incomplete argument ${flag}`)
    }
    options[key] = argv[++index]
  }
  if (options.sourceId !== SOURCE_ID) fail(`--source must be ${SOURCE_ID}`)
  if (options.id !== undefined && (!/^record-[\w-]+$/.test(options.id)
    || [SOURCE_ID, V6_ID, ORIGINAL_ID].includes(options.id))) fail('--id must be a new record')
  for (const key of ['sourceMd5', 'nodesMd5', 'edgesMd5']) {
    if (options[key] !== undefined && !md5(options[key])) fail(`${key} must be a 32-digit MD5`)
  }
  if (options.apply && (!options.id || !options.sourceMd5 || !options.nodesMd5 || !options.edgesMd5)) {
    fail('--apply requires --id and all three reviewed MD5 hashes')
  }
  return options
}

/** Pure apart from deterministic JPEG conversion; DB and files are supplied. */
export async function prepareOriginalShot1ImageV8Retry(source, original, parent, workflow, {
  id = 'record-4x5m31-original-shot1-image-v8-preview',
  createdAt = '2026-09-29T00:00:00.000Z', sourcePngBytes, identityBoardBytes,
  guidePngBytes, guideProvenanceBytes,
} = {}) {
  let guideProvenance
  try { guideProvenance = JSON.parse(guideProvenanceBytes?.toString('utf8') ?? '') } catch { /* rejected below */ }
  if (!source?.result || source.id !== SOURCE_ID || source.result_md5 !== SOURCE_MD5
    || !/^record-[\w-]+$/.test(id) || [SOURCE_ID, V6_ID, ORIGINAL_ID].includes(id)
    || !Number.isFinite(Date.parse(createdAt))
    || original?.id !== ORIGINAL_ID || original.result_md5 !== ORIGINAL_MD5
    || parent?.id !== V6_ID || parent.result_md5 !== V6_MD5
    || !Buffer.isBuffer(guideProvenanceBytes) || sha256Bytes(guideProvenanceBytes) !== GUIDE_PROVENANCE_SHA
    || guideProvenance?.version !== 'scene-cut-geometry-guide-v1'
    || guideProvenance.role !== 'geometry-only-reference' || guideProvenance.approvedFirstFrame !== false
    || guideProvenance.sourceExecutionId !== SOURCE_ID
    || guideProvenance.sourceImageSha256 !== IMAGE_SHA
    || guideProvenance.guideImagePath !== GUIDE_PATH || guideProvenance.guideImageSha256 !== GUIDE_SHA
    || source.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.id !== source.workflow_id || workflow.schema_version !== SCHEMA
    || workflow.nodes_md5 !== TARGET_NODES_MD5 || workflow.edges_md5 !== EDGES_MD5) {
    fail('source, original, parent, or schema178 graph does not match the pinned lineage')
  }
  const state = decodeExecutionState(source.result)
  const runs = state.nodeRuns
  const current = state.sceneCutFirstFrameRecovery
  const prior = state.sceneCutImageRepairRecovery
  const originalLock = state.originalTwoShotRepairRecovery
  if (state.id !== source.id || state.workflowId !== source.workflow_id
    || !Array.isArray(runs) || runs.length !== 464 || runs.some(run => run.status === 'running')
    || state.parentExecutionId !== V6_ID
    || originalLock?.sourceExecutionId !== ORIGINAL_ID
    || originalLock.sourceResultMd5 !== ORIGINAL_MD5
    || !same(originalLock.contentHashes, ORIGINAL_TWO_SHOT_CONTENT_HASHES)
    || current?.version !== 'original-shot1-image-retry-schema177-fork-v1'
    || current.sourceExecutionId !== V6_ID || current.sourceResultMd5 !== V6_MD5
    || current.workflowSchemaVersion !== 177
    || current.workflowNodesMd5 !== SOURCE_NODES_MD5
    || current.workflowEdgesMd5 !== workflow.edges_md5
    || current.ancestorResultMd5s?.[V6_ID] !== V6_MD5
    || current.preservedPrefixLength !== CUT
    || current.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
    || current.failedImageFileSha256 !== '2592c8f00f59d4511c85bdf9bf13fc67f539eb49ea4f91ee7780704626df5f73'
    || current.failedReviewOutputSha256 !== 'd4a00dbe88ea9a5dabd6cfea6be4e8a2633a3da30f162440a908ddcddf6ee7dc'
    || !same(state.originalShot1ImageV7RetryRecovery, current)
    || prior?.version !== 'scene-cut-image-repair-schema177-fork-v1'
    || prior.sourceExecutionId !== V6_ID || prior.sourceResultMd5 !== V6_MD5
    || prior.repairPreparationSha256 !== current.repairPreparationSha256) {
    fail('source is not the rejected schema177 three-reference parent')
  }
  const archive = runs[ARCHIVE], plan = runs[PLAN], image = runs[IMAGE], review = runs[REVIEW]
  if (archive?.node?.id !== 'sanguo-scene-cut-source-archive'
    || archive.status !== 'success' || archive.loopIndex !== 0
    || plan?.node?.id !== 'sanguo-scene-cut-opening-plan'
    || plan.status !== 'success' || plan.loopIndex !== 0
    || image?.node?.id !== 'sanguo-scene-cut-first-frame'
    || image.status !== 'success' || image.loopIndex !== 0
    || review?.node?.id !== 'sanguo-scene-cut-review'
    || review.status !== 'success' || review.loopIndex !== 0
    || review.output?.passed !== false || !Array.isArray(review.output?.issues)
    || review.output.issues.length < 1 || sha256Json(review.output) !== REVIEW_SHA
    || image.output?.url !== `/generated/image-${IMAGE_SHA.slice(0, 32)}.png`
    || runs.slice(REVIEW + 1).some(run => run.status !== 'idle')
    || runs.slice(CUT, REVIEW + 1).some(run => run.node.kind === 'video')) {
    fail('first scene image/review is not the pinned failed candidate')
  }
  const boards = assertV4IdentityBoardBytes(archive.output)
  const preparedEdit = await prepareRejectedSceneCutFourReferences({
    source: state, sourceResultMd5: source.result_md5,
    expectedSourceId: SOURCE_ID, expectedSourceMd5: SOURCE_MD5,
    expectedImageSha256: IMAGE_SHA, expectedReviewSha256: REVIEW_SHA,
    expectedGuideSha256: GUIDE_SHA, guidePath: GUIDE_PATH,
    sourcePngBytes, identityBoardBytes, guidePngBytes,
  })
  if (!same(preparedEdit.referenceImages.slice(0, 2), archive.output.imageReferenceImages)) {
    fail('repair helper changed the frozen identity board order')
  }
  const template = prepareOriginalTwoShotForkPreview(original, workflow, { id, createdAt }).state
  const { nodeRuns, promptUpgrade } = buildV8ImageRetryQueue(runs, template.nodeRuns)
  const secondShotRoute = assertOriginalSecondShotArrivalRoute(nodeRuns)
  const preparedRun = prepareWorkflowRunContext(nodeRuns, CUT)
  const context = preparedRun?.inputContext
  if (preparedRun?.run?.node.id !== 'sanguo-scene-cut-first-frame'
    || context?.shot_script?.id !== 'scene-01'
    || sha256Json(context.shot_script) !== ORIGINAL_TWO_SHOT_CONTENT_HASHES.shot1
    || sha256Json(context.archived_character_assets) !== ORIGINAL_TWO_SHOT_CONTENT_HASHES.firstArchive
    || !same(context.scene_cut_sources, archive.output)
    || !same(context.scene_cut_opening_state, plan.output)
    || context.first_frame?.url || context.video_take !== undefined) {
    fail('new first-image context changed approved content/boards or retained rejected media')
  }
  const hash = createJsonHasher()
  const prefixOutputsHash = hash(runs.slice(0, CUT).map(run => run.output ?? null))
  const marker = sceneCutFourReferenceRepairMarker({ sourceId: SOURCE_ID, sourceMd5: SOURCE_MD5,
    parentId: V6_ID, parentMd5: V6_MD5, originalId: ORIGINAL_ID, originalMd5: ORIGINAL_MD5,
    workflow, prefixOutputsHash, prepared: preparedEdit, prior })
  const recovery = {
    version: 'original-shot1-image-retry-schema178-fork-v1',
    sourceExecutionId: SOURCE_ID, sourceResultMd5: SOURCE_MD5,
    workflowSchemaVersion: SCHEMA, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5,
    originalExecutionId: ORIGINAL_ID, originalResultMd5: ORIGINAL_MD5,
    originalContentHashes: ORIGINAL_TWO_SHOT_CONTENT_HASHES,
    ancestorResultMd5s: { ...current.ancestorResultMd5s, [SOURCE_ID]: SOURCE_MD5 },
    preservedPrefixLength: CUT, firstPendingNodeId: 'sanguo-scene-cut-first-frame',
    preservedPrefixOutputsHash: prefixOutputsHash,
    reusedArchiveRunId: archive.id, reusedArchiveOutputSha256: sha256Json(archive.output),
    reusedOpeningPlanRunId: plan.id, reusedOpeningPlanOutputSha256: sha256Json(plan.output),
    reusedV4IdentityBoardReceipts: boards,
    failedImageRunId: image.id, failedImageOutputSha256: sha256Json(image.output),
    failedImageFileSha256: IMAGE_SHA,
    failedReviewRunId: review.id, failedReviewOutputSha256: REVIEW_SHA,
    repairPreparationSha256: preparedEdit.receiptSha256,
    priorRepairPreparationSha256: prior.repairPreparationSha256,
    geometryGuideSourcePath: GUIDE_PATH, geometryGuideSourceSha256: GUIDE_SHA,
    geometryGuideJpegSha256: marker.geometryGuideJpegSha256,
    geometryGuideProvenancePath: GUIDE_PROVENANCE_PATH,
    geometryGuideProvenanceSha256: GUIDE_PROVENANCE_SHA,
  }
  const retry = { ...state, id, parentExecutionId: SOURCE_ID,
    generationScopeId: id, requestScopeId: state.requestScopeId ?? source.id,
    historical: false, mode: 'step', nodeRuns, context: nodeRuns[CUT - 1].context,
    selectedNodeId: nodeRuns[CUT].node.id, branchHistory: [],
    breakpointRollback: undefined, breakpointRollbackHistory: undefined,
    sceneCutFirstFrameRecovery: recovery, originalShot1ImageV8RetryRecovery: recovery,
    priorSceneCutImageRepairRecovery: prior,
    sceneCutImageRepairRecovery: marker,
    logs: [...(Array.isArray(state.logs) ? state.logs : []),
      `保留 ${SOURCE_ID} 的失败首帧与独立审核；原案内容及 index0–44 冻结，新分支从 index45 使用四图受控参考重新生图。`],
  }
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(retry))))) !== hash(retry)) {
    fail('checkpoint storage round-trip changed the proposed retry')
  }
  return { state: retry, proof: { ...recovery, newExecutionId: id,
    sceneCutImageRepairRecovery: marker,
    oldRunCount: runs.length, newRunCount: nodeRuns.length, promptUpgrade,
    sourceImageUrl: image.output.url, sourceReviewIssues: review.output.issues,
    prefixRunIdsHash: hash(runs.slice(0, CUT).map(run => run.id)),
    newPrefixRunIdsHash: hash(nodeRuns.slice(0, CUT).map(run => run.id)),
    firstPendingIndex: CUT, paidVideoRetainedOnlyInEarlierRecords: true,
    secondShotRoute, providerCalls: 0, roundTripVerified: true } }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const lock = options.apply ? ' FOR SHARE' : ''
    const readRecord = async id => (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${lock}`, [id])).rows[0]
    const source = await readRecord(SOURCE_ID)
    const original = await readRecord(ORIGINAL_ID)
    const parent = await readRecord(V6_ID)
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${lock}`,
    [source?.workflow_id])).rows[0]
    if (options.sourceMd5 && source?.result_md5 !== options.sourceMd5) fail('source MD5 differs from reviewed input')
    if (options.nodesMd5 && workflow?.nodes_md5 !== options.nodesMd5) fail('nodes MD5 differs from reviewed input')
    if (options.edgesMd5 && workflow?.edges_md5 !== options.edgesMd5) fail('edges MD5 differs from reviewed input')
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1', [options.id])).rowCount) {
      fail('new record ID already exists')
    }
    const state = decodeExecutionState(source?.result ?? {})
    const imageUrl = state.nodeRuns?.[IMAGE]?.output?.url
    const bindings = state.nodeRuns?.[ARCHIVE]?.output?.referenceBindings
    if (imageUrl !== `/generated/image-${IMAGE_SHA.slice(0, 32)}.png`
      || !Array.isArray(bindings) || bindings.length !== 2
      || !bindings.every(binding => /^\/generated\/[\w.-]+\.jpg$/.test(binding.frontUrl ?? ''))) {
      fail('pinned v7 image or identity board paths unavailable')
    }
    const sourcePngBytes = await readFile(path.join(process.cwd(), 'public', imageUrl.slice(1)))
    const guidePngBytes = await readFile(path.join(process.cwd(), GUIDE_PATH))
    const guideProvenanceBytes = await readFile(path.join(process.cwd(), GUIDE_PROVENANCE_PATH))
    const identityBoardBytes = []
    for (const binding of bindings) identityBoardBytes.push(await readFile(path.join(process.cwd(), 'public', binding.frontUrl.slice(1))))
    const { state: retry, proof } = await prepareOriginalShot1ImageV8Retry(
      source, original, parent, workflow, { id: options.id, sourcePngBytes,
        identityBoardBytes, guidePngBytes, guideProvenanceBytes })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        retry.id, source.workflow_id, source.workflow_name, `原首镜四参考几何修复重审 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(retry)),
        retry.nodeRuns.filter(run => run.status === 'success').length, retry.nodeRuns.length,
      ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [retry.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result)) !== createJsonHasher()(retry)) {
        fail('saved retry differs from the reviewed checkpoint')
      }
    }
    const sourceAfter = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [SOURCE_ID])
    const originalAfter = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [ORIGINAL_ID])
    const parentAfter = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [V6_ID])
    const graphAfter = (await db.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [workflow.id])).rows[0]
    let boardsUnchanged = true
    for (let index = 0; index < bindings.length; index++) {
      const bytes = await readFile(path.join(process.cwd(), 'public', bindings[index].frontUrl.slice(1)))
      if (sha256Bytes(bytes) !== sha256Bytes(identityBoardBytes[index])) boardsUnchanged = false
    }
    if (sourceAfter.rows[0]?.hash !== SOURCE_MD5 || originalAfter.rows[0]?.hash !== ORIGINAL_MD5
      || parentAfter.rows[0]?.hash !== V6_MD5 || graphAfter?.schema_version !== SCHEMA
      || graphAfter.nodes_md5 !== workflow.nodes_md5 || graphAfter.edges_md5 !== workflow.edges_md5
      || sha256Bytes(await readFile(path.join(process.cwd(), 'public', imageUrl.slice(1)))) !== IMAGE_SHA
      || sha256Bytes(await readFile(path.join(process.cwd(), GUIDE_PATH))) !== GUIDE_SHA
      || sha256Bytes(await readFile(path.join(process.cwd(), GUIDE_PROVENANCE_PATH))) !== GUIDE_PROVENANCE_SHA
      || !boardsUnchanged) {
      fail('source record, graph, or rejected PNG changed during fork preparation')
    }
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply,
      databaseWrites: options.apply ? 1 : 0, sourceResultMd5After: sourceAfter.rows[0].hash,
      workflowNodesMd5After: graphAfter.nodes_md5, workflowEdgesMd5After: graphAfter.edges_md5 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
