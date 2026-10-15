#!/usr/bin/env node
// Reopen an unsuccessful ORIGINAL scene-01 image in a NEW record.
// Dry-run by default; --apply requires the exact source/config hashes.
// Reuses the approved schema-172 v4 identity board and opening plan verbatim.
import { createHash } from 'node:crypto'
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

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const CURRENT_SCHEMA = 173
const SOURCE_SCHEMA = 172
const SOURCE_NODES_MD5 = '18fe4299708a89b5d4871ae8c7ecb6df'
const CUT = 45
const ARCHIVE = 41
const PLAN = 43
const IMAGE = 45
const REVIEW = 49
const fail = message => { throw Error(`ORIGINAL_SHOT1_IMAGE_RETRY_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha256Bytes = value => createHash('sha256').update(value).digest('hex')
const md5 = value => /^[a-f0-9]{32}$/i.test(value ?? '')

/** A same-board retry is safe only when image and review prompt text changed. */
export function assertImageReviewPromptOnlyUpgrade(sourceRuns, targetRuns, cut = CUT) {
  if (!Array.isArray(sourceRuns) || !Array.isArray(targetRuns)
    || sourceRuns.length !== targetRuns.length || cut < 1) fail('upgrade queue is invalid')
  let changedImagePrompts = 0
  let changedReviewPrompts = 0
  for (let index = 0; index < sourceRuns.length; index++) {
    const source = sourceRuns[index]
    const target = targetRuns[index]
    if (source?.node?.id !== target?.node?.id || source.loopIndex !== target.loopIndex
      || source.loopGroupId !== target.loopGroupId
      || !isDeepStrictEqual(source.loopNode, target.loopNode)) {
      fail(`prompt-only retry topology or loop owner changed at index ${index}`)
    }
    const id = source.node.id
    if (id !== 'sanguo-scene-cut-first-frame' && id !== 'sanguo-scene-cut-review') {
      if (!isDeepStrictEqual(source.node, target.node)) fail(`unexpected node change at index ${index}`)
      continue
    }
    if (typeof source.node.prompt !== 'string' || !source.node.prompt
      || typeof target.node.prompt !== 'string' || !target.node.prompt
      || !isDeepStrictEqual(source.node, { ...target.node, prompt: source.node.prompt })) {
      fail(`prompt-only retry changed more than the ${id} prompt at index ${index}`)
    }
    if (source.node.prompt === target.node.prompt) fail(`${id} prompt did not change at index ${index}`)
    if (id === 'sanguo-scene-cut-first-frame') changedImagePrompts++
    else changedReviewPrompts++
  }
  if (changedImagePrompts !== 8 || changedReviewPrompts !== 8) {
    fail('prompt-only retry did not update both prompts in all eight scene rounds')
  }
  return { changedImagePrompts, changedReviewPrompts }
}

/** Verify the archived data URI bytes against their signed per-character receipts. */
export function assertV4IdentityBoardBytes(archive) {
  const bindings = archive?.referenceBindings
  const images = archive?.imageReferenceImages
  if (archive?.identityPlateVersion !== 'scene-cut-identity-plate-v4'
    || !Array.isArray(bindings) || !Array.isArray(images)
    || bindings.length !== 2 || images.length !== bindings.length) {
    fail('the archived v4 identity board is missing or has a different cast')
  }
  return images.map((uri, index) => {
    const binding = bindings[index]
    const encoded = typeof uri === 'string' && uri.startsWith('data:image/jpeg;base64,')
      ? uri.slice('data:image/jpeg;base64,'.length) : ''
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail(`invalid board data URI ${index}`)
    const bytes = Buffer.from(encoded, 'base64')
    const byteSha256 = sha256Bytes(bytes)
    if (!bytes.length || bytes.toString('base64') !== encoded
      || binding?.identityPlateVersion !== 'scene-cut-identity-plate-v4'
      || binding.frontSha256 !== byteSha256
      || binding.frontUrl !== `/generated/scene-cut-front-${byteSha256}.jpg`) {
      fail(`v4 board byte receipt differs at character ${index}`)
    }
    return { frontSha256: byteSha256, bytes: bytes.length }
  })
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
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '') || options.sourceId === ORIGINAL_ID) {
    fail('--source must be an original-case retry record')
  }
  if (options.id !== undefined && (!/^record-[\w-]+$/.test(options.id)
    || options.id === options.sourceId || options.id === ORIGINAL_ID)) fail('--id must be a new record')
  for (const key of ['sourceMd5', 'nodesMd5', 'edgesMd5']) {
    if (options[key] !== undefined && !md5(options[key])) fail(`${key} must be a 32-digit MD5`)
  }
  if (options.apply && (!options.id || !options.sourceMd5 || !options.nodesMd5 || !options.edgesMd5)) {
    fail('--apply requires --id and all three reviewed MD5 hashes')
  }
  return options
}

/** Pure preparation; reading the DB and optional INSERT are kept in main. */
export function prepareOriginalShot1ImageRetry(source, original, workflow, {
  id = 'record-4x5m31-original-shot1-image-preview',
  createdAt = '2026-09-29T00:00:00.000Z',
} = {}) {
  if (!source?.result || !md5(source.result_md5)
    || !/^record-[\w-]+$/.test(source.id ?? '') || source.id === ORIGINAL_ID
    || !/^record-[\w-]+$/.test(id) || id === source.id || id === ORIGINAL_ID
    || !Number.isFinite(Date.parse(createdAt))) fail('source or new execution identity is invalid')
  if (original?.id !== ORIGINAL_ID || original.result_md5 !== ORIGINAL_MD5
    || source.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.id !== source.workflow_id || workflow.schema_version !== CURRENT_SCHEMA
    || !md5(workflow.nodes_md5) || !md5(workflow.edges_md5)) {
    fail('original source or exact schema-173 workflow is unavailable')
  }
  const state = decodeExecutionState(source.result)
  const runs = state.nodeRuns
  const origin = state.originalTwoShotRepairRecovery
  const current = state.sceneCutFirstFrameRecovery
  if (state.id !== source.id || state.workflowId !== source.workflow_id
    || !Array.isArray(runs) || runs.some(run => run.status === 'running')
    || origin?.sourceExecutionId !== ORIGINAL_ID || origin.sourceResultMd5 !== ORIGINAL_MD5
    || !isDeepStrictEqual(origin.contentHashes, ORIGINAL_TWO_SHOT_CONTENT_HASHES)
    || !current || current.version !== 'original-shot1-opening-retry-schema172-fork-v1'
    || state.parentExecutionId !== current.sourceExecutionId
    || !md5(current.sourceResultMd5) || !md5(current.workflowNodesMd5)
    || current.workflowNodesMd5 !== SOURCE_NODES_MD5
    || current.workflowEdgesMd5 !== workflow.edges_md5
    || current.workflowSchemaVersion !== SOURCE_SCHEMA || current.preservedPrefixLength !== ARCHIVE
    || current.firstPendingNodeId !== 'sanguo-scene-cut-source-archive') {
    fail('source is not a completed prior original-case first-frame branch')
  }
  const oldArchive = runs[ARCHIVE]
  const oldPlan = runs[PLAN]
  const oldImage = runs[IMAGE]
  const oldReview = runs[REVIEW]
  const boardReceipts = assertV4IdentityBoardBytes(oldArchive?.output)
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
    || oldReview.status !== 'success' || oldReview.output?.passed !== false
    || !Array.isArray(oldReview.output.issues) || oldReview.output.issues.length === 0
    || oldReview.output.frame?.sourceUrl !== oldImage.output.url
    || !isDeepStrictEqual(oldImage.output.params?.referenceImages, oldArchive.output.imageReferenceImages)
    || !isDeepStrictEqual(oldImage.output.params?.sceneCutSources, oldArchive.output)
    || !isDeepStrictEqual(oldImage.output.params?.sceneCutOpeningPlan, oldPlan.output)
    || runs.slice(REVIEW + 1).some(run => run.status !== 'idle')
    || runs.slice(CUT, REVIEW + 1).some(run => run.node.kind === 'video')) {
    fail('source has no rejected original opening or its suffix already advanced')
  }
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
    version: 'original-shot1-image-retry-schema173-fork-v1',
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    workflowSchemaVersion: CURRENT_SCHEMA, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, originalExecutionId: ORIGINAL_ID,
    originalResultMd5: ORIGINAL_MD5, originalContentHashes: ORIGINAL_TWO_SHOT_CONTENT_HASHES,
    preservedPrefixLength: CUT, firstPendingNodeId: nodeRuns[CUT].node.id,
    preservedPrefixOutputsHash: prefixOutputsHash,
    failedArchiveRunId: oldArchive.id, failedArchiveOutputSha256: sha256(oldArchive.output),
    reusedOpeningPlanRunId: oldPlan.id, reusedOpeningPlanOutputSha256: sha256(oldPlan.output),
    reusedV4IdentityBoardReceipts: boardReceipts,
    failedImageRunId: oldImage.id, failedImageOutputSha256: sha256(oldImage.output),
    failedReviewRunId: oldReview.id, failedReviewOutputSha256: sha256(oldReview.output),
  }
  const retry = { ...state, id, parentExecutionId: source.id,
    generationScopeId: id, requestScopeId: state.requestScopeId ?? source.id,
    historical: false, mode: 'step', nodeRuns, context: nodeRuns[CUT - 1].context,
    selectedNodeId: nodeRuns[CUT].node.id, branchHistory: [],
    breakpointRollback: undefined, breakpointRollbackHistory: undefined,
    sceneCutFirstFrameRecovery: recovery, originalShot1ImageRetryRecovery: recovery,
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
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${lock}`, [source?.workflow_id])).rows[0]
    if (options.sourceMd5 && source?.result_md5 !== options.sourceMd5.toLowerCase()) fail('source MD5 differs from reviewed input')
    if (options.nodesMd5 && workflow?.nodes_md5 !== options.nodesMd5.toLowerCase()) fail('nodes MD5 differs from reviewed input')
    if (options.edgesMd5 && workflow?.edges_md5 !== options.edgesMd5.toLowerCase()) fail('edges MD5 differs from reviewed input')
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('new record ID already exists')
    const { state, proof } = prepareOriginalShot1ImageRetry(source, original, workflow, { id: options.id })
    const parentReceipt = decodeExecutionState(source.result).sceneCutFirstFrameRecovery
    const failedParentId = parentReceipt.sourceExecutionId
    const failedParent = (await db.query(`SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`, [failedParentId])).rows[0]
    if (failedParent?.result_md5 !== parentReceipt.sourceResultMd5) {
      fail('earlier failed parent result differs from the lineage receipt')
    }
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `原首镜首帧重审 · ${source.id}`,
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
    const failedParentAfter = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [failedParentId])
    const workflowAfter = await db.query('SELECT schema_version,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflow.id])
    if (sourceAfter.rows[0]?.hash !== source.result_md5
      || originalAfter.rows[0]?.hash !== ORIGINAL_MD5
      || failedParentAfter.rows[0]?.hash !== failedParent.result_md5
      || workflowAfter.rows[0]?.schema_version !== CURRENT_SCHEMA
      || workflowAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || workflowAfter.rows[0]?.edges_md5 !== workflow.edges_md5) fail('source, original, or workflow changed')
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply, databaseWrites: options.apply ? 1 : 0,
      sourceResultMd5After: sourceAfter.rows[0].hash, originalResultMd5After: originalAfter.rows[0].hash,
      failedParentResultMd5After: failedParentAfter.rows[0].hash,
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
