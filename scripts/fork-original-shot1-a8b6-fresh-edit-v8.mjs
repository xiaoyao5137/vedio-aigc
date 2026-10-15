#!/usr/bin/env node
/** Start one V8 face edit from the approved timing prefix and signed five refs. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { A8B6_FRESH_V8_EDIT_FRAME_ID, A8B6_FRESH_V8_EDIT_FRAME_VERSION,
  A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V8_EDIT_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID } from
  '../server/staged-scene-cut-a8b6-v7-dual-output.mjs'
import { A8B6_V7_REJECTED_MD5, A8B6_V7_REVIEW_SHA,
  assertA8B6FreshV8EditHop, verifyA8B6FreshV8EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_V8_FORK_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
function withMarker(run, marker, prompt) {
  if (run.node.params.some(item => item.name === 'sceneCutFreshImage'))
    fail('fresh marker already present')
  return { ...run, sourceBoundNodeOverride: { version: marker.version,
    nodeId: run.node.id, marker },
  node: { ...run.node, prompt,
    params: [...run.node.params, { name: 'sceneCutFreshImage',
      englishName: 'sceneCutFreshImage', type: 'json',
      value: canonical(marker) }] } }
}

export function prepareA8B6FreshV8EditFork(timingRow, rejectedRow,
  workflow, signed) {
  if (timingRow?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || rejectedRow?.id !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || rejectedRow.result_md5 !== A8B6_V7_REJECTED_MD5
    || workflow?.id !== 'wf-sanguo-history-drama'
    || workflow.schema_version !== 180
    || workflow.nodes_md5 !== A8B6_FRESH_NODES_MD5
    || workflow.edges_md5 !== A8B6_FRESH_EDGES_MD5
    || signed?.receipt?.targetExecutionId !== A8B6_FRESH_V8_EDIT_FRAME_ID)
    fail('approved timing, rejected V7 or graph changed')
  const timing = decodeExecutionState(timingRow.result)
  const rejected = decodeExecutionState(rejectedRow.result)
  const before = timing.nodeRuns
  const oldMarker = rejected.sceneCutA8B6FreshFrameRecovery
  if (before?.length !== 464 || before[45]?.status !== 'failed'
    || before.slice(46).some(run => run.status !== 'idle')
    || rejected.nodeRuns[49]?.output?.passed !== false
    || oldMarker?.sourceExecutionId !== timing.id
    || oldMarker?.sourceResultMd5 !== timingRow.result_md5)
    fail('timing or rejected checkpoint no longer at exact source gate')
  const marker = { ...oldMarker,
    version: A8B6_FRESH_V8_EDIT_FRAME_VERSION,
    priorFreshExecutionId: rejected.id,
    priorFreshResultMd5: rejectedRow.result_md5,
    priorFreshImageSha256:
      signed.receipt.referenceOrder[2].sourceSha256,
    priorFreshReviewSha256: A8B6_V7_REVIEW_SHA,
    editReceiptSha256: signed.receiptSha256,
    firstPromptSha256: sha(A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT),
    reviewPromptSha256: sha(A8B6_FRESH_V8_EDIT_REVIEW_PROMPT),
    preservedPrefixLength: 45,
    preservedPrefixSha256: sha(canonical(before.slice(0, 45))),
    firstPendingIndex: 45,
    firstPendingNodeId: 'sanguo-scene-cut-first-frame' }
  const nodeRuns = refreshPendingExecutionNodes(workflow,
    manualRetryRuns(before, 45))
  if (!isDeepStrictEqual(nodeRuns.slice(0, 45), before.slice(0, 45))
    || nodeRuns.slice(45).some(run => run.status !== 'idle'
      || run.output !== undefined || Object.keys(run.context ?? {}).length !== 0))
    fail('V8 reset altered approved prefix or retained paid output')
  nodeRuns[45] = withMarker(nodeRuns[45], marker,
    A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT)
  nodeRuns[49] = withMarker(nodeRuns[49], marker,
    A8B6_FRESH_V8_EDIT_REVIEW_PROMPT)
  const refreshed = refreshPendingExecutionNodes(workflow, nodeRuns)
  if (!isDeepStrictEqual(refreshed[45], nodeRuns[45])
    || !isDeepStrictEqual(refreshed[49], nodeRuns[49]))
    fail('schema refresh removed managed V8 prompts')
  const context = prepareWorkflowRunContext(refreshed, 45)?.inputContext
  if (!isDeepStrictEqual(context?.shot_script, before[11].output)
    || !isDeepStrictEqual(context?.scene_cut_sources, before[41].output)
    || !isDeepStrictEqual(context?.scene_cut_opening_state, before[43].output)
    || context?.first_frame !== undefined)
    fail('browser input changed approved 14-second shot or opening')
  const state = { ...timing, id: A8B6_FRESH_V8_EDIT_FRAME_ID,
    parentExecutionId: timing.id,
    generationScopeId: A8B6_FRESH_V8_EDIT_FRAME_ID,
    requestScopeId: timing.requestScopeId,
    historical: false, mode: 'step', nodeRuns: refreshed,
    context: before[44].context,
    selectedNodeId: 'sanguo-scene-cut-first-frame',
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutImageRepairRecovery: undefined,
    sceneCutApprovalRebindRecovery: undefined,
    sceneCutA8B6FreshFrameRecovery: marker,
    logs: [...(Array.isArray(timing.logs) ? timing.logs : []),
      'V7独立图审只拒严颜身份；遮挡V7失败脸区，仅以冻结身份板及同源脸裁片为身份，V4脸裁片低权辅助，V8重新全项审签。'] }
  assertA8B6FreshV8EditHop(timing, state, timingRow.result_md5,
    signed, rejected, 'pending')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('execution storage round trip changed V8 fork')
  return { state, proof: { ...marker, newExecutionId: state.id,
    identityAuthorityReferences: [1, 2, 5],
    layoutOnlyReference: 3, appearanceHelperReference: 4,
    providerCalls: 0, databaseWrites: 0, roundTripVerified: true } }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
    fail('only --apply is supported')
  const apply = args.length === 1
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const signed = await verifyA8B6FreshV8EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = apply ? ' FOR SHARE' : ''
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_V7_DUAL_OUTPUT_CHILD_ID]
    const rows = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)${suffix}`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'${suffix}`)).rows[0]
    if (rows.length !== 2 || (await db.query(`SELECT 1
      FROM execution_records WHERE id=$1`, [A8B6_FRESH_V8_EDIT_FRAME_ID])).rowCount)
      fail('source rows missing or V8 ID already exists')
    const { state, proof } = prepareA8B6FreshV8EditFork(
      byId.get(A8B6_FRESH_FRAME_PARENT_ID),
      byId.get(A8B6_V7_DUAL_OUTPUT_CHILD_ID), workflow, signed)
    if (apply) {
      const parent = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, parent.workflow_id, parent.workflow_name,
        `首镜14秒第五次受管局部编辑首帧 · ${parent.id}`,
        JSON.stringify(parent.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query(`SELECT result FROM execution_records
        WHERE id=$1`, [state.id])).rows[0]
      if (createJsonHasher()(decodeExecutionState(saved?.result))
        !== createJsonHasher()(state)) fail('saved V8 checkpoint differs from prepared state')
    }
    for (const [id, row] of byId) {
      const check = (await db.query(`SELECT md5(result::text) AS md5
        FROM execution_records WHERE id=$1`, [id])).rows[0]
      if (check?.md5 !== row.result_md5) fail('historical source changed')
    }
    await db.query(apply ? 'COMMIT' : 'ROLLBACK')
    console.log(JSON.stringify({ newExecutionId: proof.newExecutionId,
      sourceExecutionId: proof.priorFreshExecutionId,
      sourceResultMd5: proof.priorFreshResultMd5,
      editReceiptSha256: proof.editReceiptSha256,
      firstPendingIndex: proof.firstPendingIndex,
      identityAuthorityReferences: proof.identityAuthorityReferences,
      providerCalls: 0, databaseWrites: apply ? 1 : 0,
      applied: apply, roundTripVerified: true }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
