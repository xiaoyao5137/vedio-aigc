#!/usr/bin/env node
/** Fork the approved 14s prefix for one signed V7 local image edit. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { A8B6_FRESH_V7_EDIT_FRAME_ID, A8B6_FRESH_V7_EDIT_FRAME_VERSION,
  A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V7_EDIT_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_REJECTED_ID, A8B6_FRESH_REJECTED_MD5,
  A8B6_FRESH_QA_PLAN, A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5,
  A8B6_REJECTED_IMAGE_SHA } from '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_V6_REJECTED_MD5, A8B6_FRESH_V6_IMAGE_SHA,
  A8B6_FRESH_V6_REVIEW_SHA, assertA8B6FreshV7EditHop,
  verifyA8B6FreshV7EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { A8B6_FRESH_V6_EDIT_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { verifyA8B6FrameConflictReceipt } from
  '../server/staged-scene-cut-a8b6-frame-conflict.mjs'
import { A8B6_FRESH_PREFLIGHT_SOURCE_IDS, readA8B6HistoricQaManifest,
  prepareA8B6FreshRegenerationPreflight } from
  '../server/staged-scene-cut-a8b6-fresh-preflight.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_V7_FORK_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
function withMarker(run, marker, prompt) {
  if (run.node.params.some(item => item.name === 'sceneCutFreshImage'))
    fail('fresh marker already present')
  return { ...run,
    sourceBoundNodeOverride: { version: marker.version,
      nodeId: run.node.id, marker },
    node: { ...run.node, prompt,
      params: [...run.node.params, { name: 'sceneCutFreshImage',
        englishName: 'sceneCutFreshImage', type: 'json',
        value: canonical(marker) }] } }
}

export function prepareA8B6FreshV7EditFork(timingRow, workflow, preflight,
  conflict, signedEdit, rejectedRow) {
  if (timingRow?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || workflow?.id !== 'wf-sanguo-history-drama'
    || workflow.schema_version !== 180
    || workflow.nodes_md5 !== A8B6_FRESH_NODES_MD5
    || workflow.edges_md5 !== A8B6_FRESH_EDGES_MD5
    || preflight?.status !== 'ready-for-fresh-first-frame-planning-only'
    || preflight.providerAuthorization !== false
    || preflight.source?.timingExecutionId !== timingRow.id
    || preflight.source?.retryExecutionId !== A8B6_FRESH_REJECTED_ID
    || preflight.source?.retryResultMd5 !== A8B6_FRESH_REJECTED_MD5
    || preflight.source?.qaPlanId !== A8B6_FRESH_QA_PLAN
    || preflight.source?.conflictReceiptSha256 !== conflict?.receiptSha256
    || signedEdit?.receipt?.targetExecutionId !== A8B6_FRESH_V7_EDIT_FRAME_ID
    || rejectedRow?.id !== A8B6_FRESH_V6_EDIT_FRAME_ID
    || rejectedRow.result_md5 !== A8B6_FRESH_V6_REJECTED_MD5)
    fail('approved timing, signed V6 rejection, or graph changed')
  const parent = decodeExecutionState(timingRow.result)
  const rejected = decodeExecutionState(rejectedRow.result)
  const before = parent.nodeRuns
  if (before?.length !== 464 || before[45]?.status !== 'failed'
    || !String(before[45].error ?? '').includes('SCENE_CUT_EDIT_BINDER_INVALID')
    || before.slice(46).some(run => run.status !== 'idle')
    || rejected.nodeRuns[49]?.output?.passed !== false)
    fail('parent or rejected checkpoint no longer at source gate')
  const marker = { version: A8B6_FRESH_V7_EDIT_FRAME_VERSION,
    sourceExecutionId: parent.id, sourceResultMd5: timingRow.result_md5,
    rejectedExecutionId: A8B6_FRESH_REJECTED_ID,
    rejectedResultMd5: A8B6_FRESH_REJECTED_MD5,
    qaPlanId: A8B6_FRESH_QA_PLAN,
    workflowSchemaVersion: 180,
    workflowNodesMd5: A8B6_FRESH_NODES_MD5,
    workflowEdgesMd5: A8B6_FRESH_EDGES_MD5,
    adjudicationReceiptSha256: conflict.receiptSha256,
    rejectedImageSha256: A8B6_REJECTED_IMAGE_SHA,
    priorFreshExecutionId: A8B6_FRESH_V6_EDIT_FRAME_ID,
    priorFreshResultMd5: A8B6_FRESH_V6_REJECTED_MD5,
    priorFreshImageSha256: A8B6_FRESH_V6_IMAGE_SHA,
    priorFreshReviewSha256: A8B6_FRESH_V6_REVIEW_SHA,
    editReceiptSha256: signedEdit.receiptSha256,
    firstPromptSha256: sha(A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT),
    reviewPromptSha256: sha(A8B6_FRESH_V7_EDIT_REVIEW_PROMPT),
    preservedPrefixLength: 45,
    preservedPrefixSha256: sha(canonical(before.slice(0, 45))),
    firstPendingIndex: 45,
    firstPendingNodeId: 'sanguo-scene-cut-first-frame' }
  const nodeRuns = refreshPendingExecutionNodes(workflow,
    manualRetryRuns(before, 45))
  if (!isDeepStrictEqual(nodeRuns.slice(0, 45), before.slice(0, 45))
    || nodeRuns.slice(45).some(run => run.status !== 'idle'
      || run.output !== undefined || Object.keys(run.context ?? {}).length !== 0))
    fail('V7 reset altered approved prefix or retained paid output')
  nodeRuns[45] = withMarker(nodeRuns[45], marker,
    A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT)
  nodeRuns[49] = withMarker(nodeRuns[49], marker,
    A8B6_FRESH_V7_EDIT_REVIEW_PROMPT)
  const refreshed = refreshPendingExecutionNodes(workflow, nodeRuns)
  if (!isDeepStrictEqual(refreshed[45], nodeRuns[45])
    || !isDeepStrictEqual(refreshed[49], nodeRuns[49]))
    fail('schema refresh removed managed V7 prompts')
  const context = prepareWorkflowRunContext(refreshed, 45)?.inputContext
  if (!isDeepStrictEqual(context?.shot_script, before[11].output)
    || !isDeepStrictEqual(context?.scene_cut_sources, before[41].output)
    || !isDeepStrictEqual(context?.scene_cut_opening_state, before[43].output)
    || context?.first_frame !== undefined
    || context?.scene_cut_repair_receipt !== undefined)
    fail('browser input changed approved shot or opening state')
  const state = { ...parent, id: A8B6_FRESH_V7_EDIT_FRAME_ID,
    parentExecutionId: parent.id,
    generationScopeId: A8B6_FRESH_V7_EDIT_FRAME_ID,
    requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns: refreshed,
    context: before[44].context,
    selectedNodeId: 'sanguo-scene-cut-first-frame',
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutImageRepairRecovery: undefined,
    sceneCutApprovalRebindRecovery: undefined,
    sceneCutA8B6FreshFrameRecovery: marker,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      'V6真审只拒严颜脸须年龄；以严颜冻结板同源原像素脸部裁片增强身份约束，V6拒图仅供布局，V7重新全项独立审签。'] }
  assertA8B6FreshV7EditHop(parent, state, timingRow.result_md5,
    signedEdit, rejected, 'pending')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('execution storage round trip changed V7 fork')
  return { state, proof: { ...marker, newExecutionId: state.id,
    frozenIdentityCount: 2, layoutReferenceCount: 1,
    providerCalls: 0, databaseWrites: 0, roundTripVerified: true } }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length > 1 || argv.length === 1 && argv[0] !== '--apply')
    fail('only --apply is supported')
  const apply = argv.length === 1
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const qa = readA8B6HistoricQaManifest(root)
  const conflict = await verifyA8B6FrameConflictReceipt(A8B6_FRESH_QA_PLAN, root)
  const signedEdit = await verifyA8B6FreshV7EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = apply ? ' FOR SHARE' : ''
    const ids = Object.values(A8B6_FRESH_PREFLIGHT_SOURCE_IDS)
      .filter(value => typeof value === 'string' && value.startsWith('record-'))
    ids.push(A8B6_FRESH_V6_EDIT_FRAME_ID)
    const rows = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)${suffix}`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'${suffix}`)).rows[0]
    const ledgerRows = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-review' AND status='succeeded'
        AND request_data->>'requestKey' LIKE $1
      ORDER BY created_at DESC LIMIT 20`, [`${A8B6_FRESH_REJECTED_ID}:%`])).rows
    if (rows.length !== ids.length
      || (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
        [A8B6_FRESH_V7_EDIT_FRAME_ID])).rowCount)
      fail('source rows changed or V7 ID already exists')
    const preflight = prepareA8B6FreshRegenerationPreflight({
      sourceRow: byId.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.SOURCE_ID),
      timingRow: byId.get(A8B6_FRESH_FRAME_PARENT_ID),
      rejectedRow: byId.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.REJECTED_ID),
      retryRow: byId.get(A8B6_FRESH_REJECTED_ID),
      workflowRow: workflow, qa, conflict, ledgerRows, root })
    const { state, proof } = prepareA8B6FreshV7EditFork(
      byId.get(A8B6_FRESH_FRAME_PARENT_ID), workflow, preflight,
      conflict, signedEdit, byId.get(A8B6_FRESH_V6_EDIT_FRAME_ID))
    if (apply) {
      const parent = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, parent.workflow_id, parent.workflow_name,
        `首镜14秒第三次受管局部编辑首帧 · ${parent.id}`,
        JSON.stringify(parent.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1',
        [state.id])).rows[0]
      const hash = createJsonHasher()
      if (hash(decodeExecutionState(saved?.result)) !== hash(state))
        fail('saved V7 checkpoint differs from prepared state')
    }
    for (const [id, row] of byId) {
      const check = (await db.query(`SELECT md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [id])).rows[0]
      if (check?.result_md5 !== row.result_md5) fail('historical source changed')
    }
    await db.query(apply ? 'COMMIT' : 'ROLLBACK')
    console.log(JSON.stringify({ ...proof, applied: apply,
      databaseWrites: apply ? 1 : 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
