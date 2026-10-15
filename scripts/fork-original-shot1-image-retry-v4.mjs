#!/usr/bin/env node
// Reopen the unsuccessful original scene-01 v3 image in a NEW v4 record.
// Dry-run by default; --apply requires the exact source/config hashes.
// Reuses the archived v4 identity board and opening plan; the failed v3 image
// and review remain in their parent record.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import {
  ORIGINAL_TWO_SHOT_CONTENT_HASHES,
  prepareOriginalTwoShotForkPreview,
} from './preview-original-two-shot-fork.mjs'
import { preservePrefixBeforeOpening } from './fork-original-shot1-opening-retry.mjs'
import { assertImageReviewPromptOnlyUpgrade, assertV4IdentityBoardBytes } from './fork-original-shot1-image-retry.mjs'

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const V1_ID = 'record-4x5m31-original-repair-v1'
const V1_MD5 = 'e348789b50525a544547f7a26eb9786a'
const V2_ID = 'record-4x5m31-original-repair-v2'
const V2_MD5 = 'ef6806cb653c388a2cab9e33e7796da8'
const V3_ID = 'record-4x5m31-original-repair-v3'
const V3_MD5 = 'd4c36b22371daed22da3b9982134463d'
const CURRENT_SCHEMA = 174
const SOURCE_SCHEMA = 173
const SOURCE_NODES_MD5 = 'f688326f4892aaba0c1bf884ca5fc9f9'
const V3_IMAGE_SHA = 'e746a9299c4db51a855b878011959e22ef1787193b3df373a96956efe90a4e11'
const V3_FAILED_REVIEW_SHA = 'f7521ecc6739347e6cd74869dcfc4c2bb2f1ce9e063babacec843cfdc70ae1df'
const CUT = 45
const ARCHIVE = 41
const PLAN = 43
const IMAGE = 45
const REVIEW = 49
const fail = message => { throw Error(`ORIGINAL_SHOT1_IMAGE_V4_RETRY_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha256Bytes = value => createHash('sha256').update(value).digest('hex')
const md5 = value => /^[a-f0-9]{32}$/i.test(value ?? '')

export function assertFailedReviewReceipt(run, imageUrl, expectedSha256 = V3_FAILED_REVIEW_SHA) {
  if (run?.node?.id !== 'sanguo-scene-cut-review' || run.status !== 'success'
    || run.output?.passed !== false || !Array.isArray(run.output.issues)
    || run.output.issues.length === 0 || run.output.frame?.sourceUrl !== imageUrl
    || sha256(run.output) !== expectedSha256) fail('failed v3 review receipt changed')
  return expectedSha256
}

export function assertImageBytes(bytes, expectedSha256 = V3_IMAGE_SHA) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || sha256Bytes(bytes) !== expectedSha256) {
    fail('failed v3 image bytes differ from the review lineage')
  }
  return expectedSha256
}

function argsFor(argv) {
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
  if (options.sourceId !== V3_ID) {
    fail(`--source must be ${V3_ID}`)
  }
  if (options.id !== undefined && (!/^record-[\w-]+$/.test(options.id)
    || [options.sourceId, ORIGINAL_ID, V1_ID, V2_ID].includes(options.id))) fail('--id must be a new record')
  for (const key of ['sourceMd5', 'nodesMd5', 'edgesMd5']) {
    if (options[key] !== undefined && !md5(options[key])) fail(`${key} must be a 32-digit MD5`)
  }
  if (options.apply && (!options.id || !options.sourceMd5 || !options.nodesMd5 || !options.edgesMd5)) {
    fail('--apply requires --id and all three reviewed MD5 hashes')
  }
  return options
}

/** Pure preparation; reading the DB and optional INSERT are kept in main. */
export function prepareOriginalShot1ImageV4Retry(source, original, v1, v2, workflow, {
  id = 'record-4x5m31-original-shot1-image-v4-preview',
  createdAt = '2026-09-29T00:00:00.000Z',
} = {}) {
  if (!source?.result || source.id !== V3_ID || source.result_md5 !== V3_MD5
    || !/^record-[\w-]+$/.test(id) || [source.id, ORIGINAL_ID, V1_ID, V2_ID].includes(id)
    || !Number.isFinite(Date.parse(createdAt))) fail('source or new execution identity is invalid')
  if (original?.id !== ORIGINAL_ID || original.result_md5 !== ORIGINAL_MD5
    || v1?.id !== V1_ID || v1.result_md5 !== V1_MD5
    || v2?.id !== V2_ID || v2.result_md5 !== V2_MD5
    || source.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.id !== source.workflow_id || workflow.schema_version !== CURRENT_SCHEMA
    || !md5(workflow.nodes_md5) || !md5(workflow.edges_md5)) {
    fail('lineage or exact schema-174 workflow is unavailable')
  }
  const state = decodeExecutionState(source.result)
  const firstRetry = decodeExecutionState(v1.result)
  const secondRetry = decodeExecutionState(v2.result)
  const runs = state.nodeRuns
  const origin = state.originalTwoShotRepairRecovery
  const current = state.sceneCutFirstFrameRecovery
  if (state.id !== source.id || state.workflowId !== source.workflow_id
    || !Array.isArray(runs) || runs.some(run => run.status === 'running')
    || origin?.sourceExecutionId !== ORIGINAL_ID || origin.sourceResultMd5 !== ORIGINAL_MD5
    || !isDeepStrictEqual(origin.contentHashes, ORIGINAL_TWO_SHOT_CONTENT_HASHES)
    || !current || current.version !== 'original-shot1-image-retry-schema173-fork-v1'
    || state.parentExecutionId !== V2_ID || current.sourceExecutionId !== V2_ID
    || current.sourceResultMd5 !== V2_MD5
    || firstRetry.parentExecutionId !== ORIGINAL_ID
    || firstRetry.sceneCutFirstFrameRecovery?.sourceExecutionId !== ORIGINAL_ID
    || firstRetry.sceneCutFirstFrameRecovery?.sourceResultMd5 !== ORIGINAL_MD5
    || secondRetry.parentExecutionId !== V1_ID
    || secondRetry.sceneCutFirstFrameRecovery?.sourceExecutionId !== V1_ID
    || secondRetry.sceneCutFirstFrameRecovery?.sourceResultMd5 !== V1_MD5
    || secondRetry.sceneCutFirstFrameRecovery?.workflowNodesMd5 !== '18fe4299708a89b5d4871ae8c7ecb6df'
    || !md5(current.sourceResultMd5) || !md5(current.workflowNodesMd5)
    || current.workflowNodesMd5 !== SOURCE_NODES_MD5
    || current.workflowEdgesMd5 !== workflow.edges_md5
    || current.workflowSchemaVersion !== SOURCE_SCHEMA || current.preservedPrefixLength !== CUT
    || current.firstPendingNodeId !== 'sanguo-scene-cut-first-frame') {
    fail('source is not a completed prior original-case first-frame branch')
  }
  const oldArchive = runs[ARCHIVE]
  const oldPlan = runs[PLAN]
  const oldImage = runs[IMAGE]
  const oldReview = runs[REVIEW]
  const boardReceipts = assertV4IdentityBoardBytes(oldArchive?.output)
  const previousRuns = secondRetry.nodeRuns
  if (runs.length !== 464 || oldArchive?.node?.id !== 'sanguo-scene-cut-source-archive'
    || oldArchive.loopIndex !== 0 || oldArchive.status !== 'success'
    || oldArchive.output?.shotId !== 'scene-01'
    || oldArchive.output?.identityPlateVersion !== 'scene-cut-identity-plate-v4'
    || oldPlan?.node?.id !== 'sanguo-scene-cut-opening-plan'
    || oldPlan.loopIndex !== 0 || oldPlan.status !== 'success'
    || oldPlan.output?.shotId !== 'scene-01'
    || oldImage?.node?.id !== 'sanguo-scene-cut-first-frame'
    || oldImage.loopIndex !== 0 || oldImage.status !== 'success'
    || typeof oldImage.output?.url !== 'string' || !oldImage.output.url.startsWith('/generated/')
    || oldReview?.node?.id !== 'sanguo-scene-cut-review' || oldReview.loopIndex !== 0
    || oldImage.output.url !== '/generated/image-e746a9299c4db51a855b878011959e22.png'
    || !isDeepStrictEqual(runs.slice(0, CUT).map(run => run.output ?? null),
      previousRuns.slice(0, CUT).map(run => run.output ?? null))
    || !isDeepStrictEqual(runs.slice(0, CUT).map(run => run.id),
      previousRuns.slice(0, CUT).map(run => run.id))
    || !isDeepStrictEqual(oldImage.output.params?.referenceImages, oldArchive.output.imageReferenceImages)
    || !isDeepStrictEqual(oldImage.output.params?.sceneCutSources, oldArchive.output)
    || !isDeepStrictEqual(oldImage.output.params?.sceneCutOpeningPlan, oldPlan.output)
    || runs.slice(REVIEW + 1).some(run => run.status !== 'idle')
    || runs.slice(CUT, REVIEW + 1).some(run => run.node.kind === 'video')) {
    fail('source has no rejected original opening or its suffix already advanced')
  }
  assertFailedReviewReceipt(oldReview, oldImage.output.url)
  const template = prepareOriginalTwoShotForkPreview(original, workflow, { id, createdAt }).state
  const promptUpgrade = assertImageReviewPromptOnlyUpgrade(runs, template.nodeRuns)
  const nodeRuns = preservePrefixBeforeOpening(runs, template.nodeRuns, CUT)
  const prepared = prepareWorkflowRunContext(nodeRuns, CUT)
  const context = prepared?.inputContext
  if (prepared?.run?.node.id !== 'sanguo-scene-cut-first-frame'
    || context?.shot_script?.id !== 'scene-01'
    || sha256(context.shot_script) !== ORIGINAL_TWO_SHOT_CONTENT_HASHES.shot1
    || sha256(context.archived_character_assets) !== ORIGINAL_TWO_SHOT_CONTENT_HASHES.firstArchive
    || !isDeepStrictEqual(context.scene_cut_sources, oldArchive.output)
    || !isDeepStrictEqual(context.scene_cut_opening_state, oldPlan.output)
    || context.scene_cut_sources.identityPlateVersion !== 'scene-cut-identity-plate-v4'
    || context.first_frame?.url || context.video_take !== undefined) {
    fail('new first-image context changed the approved shot/v4 board or retained old media')
  }
  const hash = createJsonHasher()
  const prefixOutputsHash = hash(runs.slice(0, CUT).map(run => run.output ?? null))
  if (hash(nodeRuns.slice(0, CUT).map(run => run.output ?? null)) !== prefixOutputsHash) {
    fail('completed prefix output changed while building the image retry')
  }
  const recovery = {
    version: 'original-shot1-image-retry-schema174-fork-v1',
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    workflowSchemaVersion: CURRENT_SCHEMA, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, originalExecutionId: ORIGINAL_ID,
    originalResultMd5: ORIGINAL_MD5, originalContentHashes: ORIGINAL_TWO_SHOT_CONTENT_HASHES,
    ancestorResultMd5s: { [V1_ID]: V1_MD5, [V2_ID]: V2_MD5, [V3_ID]: V3_MD5 },
    preservedPrefixLength: CUT, firstPendingNodeId: nodeRuns[CUT].node.id,
    preservedPrefixOutputsHash: prefixOutputsHash,
    reusedArchiveRunId: oldArchive.id, reusedArchiveOutputSha256: sha256(oldArchive.output),
    reusedOpeningPlanRunId: oldPlan.id, reusedOpeningPlanOutputSha256: sha256(oldPlan.output),
    reusedV4IdentityBoardReceipts: boardReceipts,
    failedImageRunId: oldImage.id, failedImageOutputSha256: sha256(oldImage.output),
    failedImageFileSha256: V3_IMAGE_SHA,
    failedReviewRunId: oldReview.id, failedReviewOutputSha256: sha256(oldReview.output),
  }
  const retry = { ...state, id, parentExecutionId: source.id,
    generationScopeId: id, requestScopeId: state.requestScopeId ?? source.id,
    historical: false, mode: 'step', nodeRuns, context: nodeRuns[CUT - 1].context,
    selectedNodeId: nodeRuns[CUT].node.id, branchHistory: [],
    breakpointRollback: undefined, breakpointRollbackHistory: undefined,
    sceneCutFirstFrameRecovery: recovery, originalShot1ImageV4RetryRecovery: recovery,
    logs: [...(Array.isArray(state.logs) ? state.logs : []),
      `保留 ${source.id} 的首帧审核失败证据；原内容、v4人设板及 index0–44 已冻结，新分支从 index45 重生图。`],
  }
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(retry))))) !== hash(retry)) {
    fail('checkpoint storage round-trip changed the proposed retry')
  }
  return { state: retry, proof: { ...recovery, newExecutionId: id,
    oldRunCount: runs.length, newRunCount: nodeRuns.length,
    promptUpgrade,
    sourceImageUrl: oldImage.output.url, sourceReviewIssues: oldReview.output.issues,
    prefixRunIdsHash: hash(runs.slice(0, CUT).map(run => run.id)),
    newPrefixRunIdsHash: hash(nodeRuns.slice(0, CUT).map(run => run.id)),
    newPrefixOutputsHash: hash(nodeRuns.slice(0, CUT).map(run => run.output ?? null)),
    firstPendingIndex: CUT, paidVideoRetainedOnlyInEarlierRecords: true,
    providerCalls: 0, roundTripVerified: true } }
}

async function main() {
  const options = argsFor(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const lock = options.apply ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`, [options.sourceId])).rows[0]
    const original = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`, [ORIGINAL_ID])).rows[0]
    const v1 = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`, [V1_ID])).rows[0]
    const v2 = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`, [V2_ID])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${lock}`, [source?.workflow_id])).rows[0]
    if (options.sourceMd5 && source?.result_md5 !== options.sourceMd5.toLowerCase()) fail('source MD5 differs from reviewed input')
    if (options.nodesMd5 && workflow?.nodes_md5 !== options.nodesMd5.toLowerCase()) fail('nodes MD5 differs from reviewed input')
    if (options.edgesMd5 && workflow?.edges_md5 !== options.edgesMd5.toLowerCase()) fail('edges MD5 differs from reviewed input')
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('new record ID already exists')
    const { state, proof } = prepareOriginalShot1ImageV4Retry(source, original, v1, v2, workflow, { id: options.id })
    const imagePath = path.join(process.cwd(), 'public', proof.sourceImageUrl.slice(1))
    assertImageBytes(await readFile(imagePath))
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `原首镜新图重审 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result)) !== createJsonHasher()(state)) {
        fail('saved retry differs from the reviewed checkpoint')
      }
    }
    // pg.Client has a single connection; dispatching concurrent queries on it
    // triggers a deprecation warning and obscures the transaction order.
    const sourceAfter = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [source.id])
    const originalAfter = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [ORIGINAL_ID])
    const v1After = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [V1_ID])
    const v2After = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [V2_ID])
    const workflowAfter = await db.query('SELECT schema_version,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflow.id])
    const imageShaAfter = assertImageBytes(await readFile(imagePath))
    if (sourceAfter.rows[0]?.hash !== source.result_md5
      || originalAfter.rows[0]?.hash !== ORIGINAL_MD5
      || v1After.rows[0]?.hash !== V1_MD5
      || v2After.rows[0]?.hash !== V2_MD5
      || workflowAfter.rows[0]?.schema_version !== CURRENT_SCHEMA
      || workflowAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || workflowAfter.rows[0]?.edges_md5 !== workflow.edges_md5) fail('source, original, or workflow changed')
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply, databaseWrites: options.apply ? 1 : 0,
      sourceResultMd5After: sourceAfter.rows[0].hash, originalResultMd5After: originalAfter.rows[0].hash,
      v1ResultMd5After: v1After.rows[0].hash, v2ResultMd5After: v2After.rows[0].hash,
      failedImageFileSha256After: imageShaAfter,
      workflowNodesMd5After: workflowAfter.rows[0].nodes_md5,
      workflowEdgesMd5After: workflowAfter.rows[0].edges_md5 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
