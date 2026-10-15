#!/usr/bin/env node
// Reopen an unsuccessful ORIGINAL scene-01 opening in a NEW record.
// Dry-run by default; --apply requires the exact source/config hashes.
// The old identity board, failed paid image and review remain in the parent.
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

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const CURRENT_SCHEMA = 172
const CUT = 41
const IMAGE = 45
const REVIEW = 49
const fail = message => { throw Error(`ORIGINAL_SHOT1_OPENING_RETRY_INVALID: ${message}`) }
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const md5 = value => /^[a-f0-9]{32}$/i.test(value ?? '')

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

/** Keeps the exact completed prefix and replaces all later runs with current-graph idle runs. */
export function preservePrefixBeforeOpening(sourceRuns, templateRuns, cut = CUT) {
  if (!Array.isArray(sourceRuns) || !Array.isArray(templateRuns)
    || sourceRuns.length !== templateRuns.length || !Number.isSafeInteger(cut)
    || cut < 1 || cut >= sourceRuns.length) fail('execution queue length or cut is invalid')
  for (let index = 0; index < sourceRuns.length; index++) {
    if (sourceRuns[index]?.node?.id !== templateRuns[index]?.node?.id
      || sourceRuns[index]?.loopIndex !== templateRuns[index]?.loopIndex
      || sourceRuns[index]?.loopGroupId !== templateRuns[index]?.loopGroupId) {
      fail(`execution topology differs at index ${index}`)
    }
    if (index < cut && (!['success', 'skipped'].includes(sourceRuns[index].status)
      || !isDeepStrictEqual(sourceRuns[index].node, templateRuns[index].node))) {
      fail(`completed prefix or node snapshot differs at index ${index}`)
    }
    if (index >= cut && templateRuns[index].status !== 'idle') {
      fail(`new graph suffix is not idle at index ${index}`)
    }
  }
  const merged = [...sourceRuns.slice(0, cut), ...templateRuns.slice(cut)]
  if (new Set(merged.map(run => run.id)).size !== merged.length
    || merged.findIndex(run => run.status === 'idle') !== cut
    || merged.slice(cut).some(run => run.status !== 'idle')) fail('rebuilt queue is not an idle image retry')
  return merged
}

/** Pure preparation; reading the DB and optional INSERT are kept in main. */
export function prepareOriginalShot1OpeningRetry(source, original, workflow, {
  id = 'record-4x5m31-original-shot1-opening-preview',
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
    fail('original source or exact schema-172 workflow is unavailable')
  }
  const state = decodeExecutionState(source.result)
  const runs = state.nodeRuns
  const origin = state.originalTwoShotRepairRecovery
  const current = state.sceneCutFirstFrameRecovery
  if (state.id !== source.id || state.workflowId !== source.workflow_id
    || !Array.isArray(runs) || runs.some(run => run.status === 'running')
    || origin?.sourceExecutionId !== ORIGINAL_ID || origin.sourceResultMd5 !== ORIGINAL_MD5
    || !isDeepStrictEqual(origin.contentHashes, ORIGINAL_TWO_SHOT_CONTENT_HASHES)
    || !current || state.parentExecutionId !== current.sourceExecutionId
    || !md5(current.sourceResultMd5) || !md5(current.workflowNodesMd5)
    || current.workflowEdgesMd5 !== workflow.edges_md5
    || !(current.workflowSchemaVersion < CURRENT_SCHEMA)
    || current.preservedPrefixLength > CUT || current.firstPendingNodeId === undefined) {
    fail('source is not a completed prior original-case first-frame branch')
  }
  const oldArchive = runs[CUT]
  const oldImage = runs[IMAGE]
  const oldReview = runs[REVIEW]
  if (runs.length !== 464 || oldArchive?.node?.id !== 'sanguo-scene-cut-source-archive'
    || oldArchive.loopIndex !== 0 || oldArchive.status !== 'success'
    || oldArchive.output?.shotId !== 'scene-01'
    || oldArchive.output?.identityPlateVersion !== 'scene-cut-identity-plate-v3'
    || oldImage?.node?.id !== 'sanguo-scene-cut-first-frame'
    || oldImage.loopIndex !== 0 || oldImage.status !== 'success'
    || typeof oldImage.output?.url !== 'string' || !oldImage.output.url.startsWith('/generated/')
    || oldReview?.node?.id !== 'sanguo-scene-cut-review' || oldReview.loopIndex !== 0
    || oldReview.status !== 'success' || oldReview.output?.passed !== false
    || !Array.isArray(oldReview.output.issues) || oldReview.output.issues.length === 0
    || oldReview.output.frame?.sourceUrl !== oldImage.output.url
    || runs.slice(REVIEW + 1).some(run => run.status !== 'idle')
    || runs.slice(CUT, REVIEW + 1).some(run => run.node.kind === 'video')) {
    fail('source has no rejected original opening or its suffix already advanced')
  }
  const template = prepareOriginalTwoShotForkPreview(original, workflow, { id, createdAt }).state
  const nodeRuns = preservePrefixBeforeOpening(runs, template.nodeRuns)
  const prepared = prepareWorkflowRunContext(nodeRuns, CUT)
  const context = prepared?.inputContext
  if (prepared?.run?.node.id !== 'sanguo-scene-cut-source-archive'
    || context?.shot_script?.id !== 'scene-01'
    || sha256(context.shot_script) !== ORIGINAL_TWO_SHOT_CONTENT_HASHES.shot1
    || sha256(context.archived_character_assets) !== ORIGINAL_TWO_SHOT_CONTENT_HASHES.firstArchive
    || context.scene_cut_sources !== undefined
    || context.scene_cut_opening_state !== undefined
    || context.first_frame?.url || context.video_take !== undefined) {
    fail('new source-archive context changed the approved shot or retained old media')
  }
  const hash = createJsonHasher()
  const recovery = {
    version: 'original-shot1-opening-retry-schema172-fork-v1',
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    workflowSchemaVersion: CURRENT_SCHEMA, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, originalExecutionId: ORIGINAL_ID,
    originalResultMd5: ORIGINAL_MD5, originalContentHashes: ORIGINAL_TWO_SHOT_CONTENT_HASHES,
    preservedPrefixLength: CUT, firstPendingNodeId: nodeRuns[CUT].node.id,
    preservedPrefixOutputsHash: hash(nodeRuns.slice(0, CUT).map(run => run.output ?? null)),
    failedArchiveRunId: oldArchive.id, failedArchiveOutputSha256: sha256(oldArchive.output),
    failedImageRunId: oldImage.id, failedImageOutputSha256: sha256(oldImage.output),
    failedReviewRunId: oldReview.id, failedReviewOutputSha256: sha256(oldReview.output),
  }
  const retry = { ...state, id, parentExecutionId: source.id,
    generationScopeId: id, requestScopeId: state.requestScopeId ?? source.id,
    historical: false, mode: 'step', nodeRuns, context: nodeRuns[CUT - 1].context,
    selectedNodeId: nodeRuns[CUT].node.id, branchHistory: [],
    breakpointRollback: undefined, breakpointRollbackHistory: undefined,
    sceneCutFirstFrameRecovery: recovery, originalShot1FirstFrameRetryRecovery: recovery,
    logs: [...(Array.isArray(state.logs) ? state.logs : []),
      `保留 ${source.id} 的首帧审核失败证据；原内容及 index0–40 已冻结，新分支从 index41 重归档。`],
  }
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(retry))))) !== hash(retry)) {
    fail('checkpoint storage round-trip changed the proposed retry')
  }
  return { state: retry, proof: { ...recovery, newExecutionId: id,
    oldRunCount: runs.length, newRunCount: nodeRuns.length,
    sourceImageUrl: oldImage.output.url, sourceReviewIssues: oldReview.output.issues,
    prefixRunIdsHash: hash(runs.slice(0, CUT).map(run => run.id)),
    newPrefixRunIdsHash: hash(nodeRuns.slice(0, CUT).map(run => run.id)),
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
    const { state, proof } = prepareOriginalShot1OpeningRetry(source, original, workflow, { id: options.id })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `原首镜归档及首帧重审 · ${source.id}`,
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
    const workflowAfter = await db.query('SELECT schema_version,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflow.id])
    if (sourceAfter.rows[0]?.hash !== source.result_md5
      || originalAfter.rows[0]?.hash !== ORIGINAL_MD5
      || workflowAfter.rows[0]?.schema_version !== CURRENT_SCHEMA
      || workflowAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || workflowAfter.rows[0]?.edges_md5 !== workflow.edges_md5) fail('source, original, or workflow changed')
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply, databaseWrites: options.apply ? 1 : 0,
      sourceResultMd5After: sourceAfter.rows[0].hash, originalResultMd5After: originalAfter.rows[0].hash,
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
