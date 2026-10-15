#!/usr/bin/env node
/** Create one new paid-first-frame checkpoint after the two genuine same-image
 * rejections. The approved 14s script/opening and all historical rows survive. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { sceneCutShotSha256 } from '../server/scene-cut-frame-approval.ts'
import { verifyA8B6FrameConflictReceipt } from '../server/staged-scene-cut-a8b6-frame-conflict.mjs'
import { A8B6_FRESH_FRAME_ID, A8B6_FRESH_FRAME_VERSION,
  A8B6_FRESH_FRAME_PARENT_ID,
  A8B6_FRESH_FRAME_PARENT_MD5, A8B6_FRESH_REJECTED_ID,
  A8B6_FRESH_REJECTED_MD5, A8B6_FRESH_QA_PLAN, A8B6_FRESH_NODES_MD5,
  A8B6_FRESH_EDGES_MD5, A8B6_REJECTED_IMAGE_SHA,
  A8B6_FRESH_V2_RESULT_MD5, A8B6_FRESH_V2_IMAGE_SHA,
  A8B6_FRESH_V2_IMAGE_LEDGER, A8B6_FRESH_V2_REVIEW_LEDGER,
  verifyA8B6FreshV2Rejection,
  A8B6_FRESH_FIRST_FRAME_PROMPT, A8B6_FRESH_REVIEW_PROMPT,
  A8B6_FRESH_FIRST_PROMPT_SHA, A8B6_FRESH_REVIEW_PROMPT_SHA,
  assertA8B6FreshFrameHop } from '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { readA8B6HistoricQaManifest, prepareA8B6FreshRegenerationPreflight,
  A8B6_FRESH_PREFLIGHT_SOURCE_IDS } from '../server/staged-scene-cut-a8b6-fresh-preflight.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { A8B6_FRESH_V2_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'

const fail = reason => { throw Error(`A8B6_FRESH_FORK_INVALID: ${reason}`) }
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const sha = value => createHash('sha256').update(value).digest('hex')

function withParam(run, name, value) {
  const node = run.node
  if (node.params.some(param => param.name === name)) fail(`${name} already exists`)
  return { ...run, node: { ...node, params: [...node.params,
    { name, englishName: name, type: 'json', value }] } }
}

export function prepareA8B6FreshFirstFrameFork(timingRow, workflow,
  preflight, conflict, verifiedPrior) {
  if (timingRow?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || timingRow.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.id !== timingRow.workflow_id || workflow.schema_version !== 180
    || workflow.nodes_md5 !== A8B6_FRESH_NODES_MD5
    || workflow.edges_md5 !== A8B6_FRESH_EDGES_MD5
    || preflight?.status !== 'ready-for-fresh-first-frame-planning-only'
    || preflight.providerAuthorization !== false
    || preflight.source?.timingExecutionId !== timingRow.id
    || preflight.source?.timingResultMd5 !== timingRow.result_md5
    || preflight.source?.retryExecutionId !== A8B6_FRESH_REJECTED_ID
    || preflight.source?.retryResultMd5 !== A8B6_FRESH_REJECTED_MD5
    || preflight.source?.qaPlanId !== A8B6_FRESH_QA_PLAN
    || preflight.source?.conflictReceiptSha256 !== conflict?.receiptSha256
    || verifiedPrior?.state?.id !== A8B6_FRESH_V2_FRAME_ID
    || verifiedPrior.imageSha256 !== A8B6_FRESH_V2_IMAGE_SHA
    || preflight.approved14s?.shotSha256
      !== 'f5d04665f0f1be6db954de81c2748fcb41a423cac833e6b94383fad1b5d07fc0'
    || preflight.approved14s?.scheduleHash
      !== 'duration-v2-sha256-ecccd70590dab91eccf4c52d6797f57ecb961a3bb02b7922e4a66bb203b71c18')
    fail('deep fresh preflight, approved script or schema changed')
  const parent = decodeExecutionState(timingRow.result)
  const before = parent.nodeRuns
  if (parent.id !== timingRow.id || !Array.isArray(before) || before.length !== 464
    || before.slice(0, 45).some(run => !['success', 'skipped'].includes(run.status))
    || before[45]?.status !== 'failed'
    || !String(before[45].error ?? '').includes('SCENE_CUT_EDIT_BINDER_INVALID')
    || before.slice(46).some(run => run.status !== 'idle')
    || sceneCutShotSha256(before[11]?.output) !== preflight.approved14s.shotSha256
    || before[11].output.scheduleHash !== preflight.approved14s.scheduleHash)
    fail('14s parent no longer ends immediately before the image purchase')
  const marker = { version: A8B6_FRESH_FRAME_VERSION,
    sourceExecutionId: parent.id, sourceResultMd5: timingRow.result_md5,
    rejectedExecutionId: A8B6_FRESH_REJECTED_ID,
    rejectedResultMd5: A8B6_FRESH_REJECTED_MD5,
    qaPlanId: A8B6_FRESH_QA_PLAN, workflowSchemaVersion: 180,
    workflowNodesMd5: A8B6_FRESH_NODES_MD5,
    workflowEdgesMd5: A8B6_FRESH_EDGES_MD5,
    adjudicationReceiptSha256: conflict.receiptSha256,
    rejectedImageSha256: A8B6_REJECTED_IMAGE_SHA,
    priorFreshExecutionId: A8B6_FRESH_V2_FRAME_ID,
    priorFreshResultMd5: A8B6_FRESH_V2_RESULT_MD5,
    priorFreshImageSha256: A8B6_FRESH_V2_IMAGE_SHA,
    priorFreshReviewSha256: verifiedPrior.reviewSha256,
    firstPromptSha256: A8B6_FRESH_FIRST_PROMPT_SHA,
    reviewPromptSha256: A8B6_FRESH_REVIEW_PROMPT_SHA,
    preservedPrefixLength: 45,
    preservedPrefixSha256: sha(canonical(before.slice(0, 45))),
    firstPendingIndex: 45, firstPendingNodeId: before[45].node.id }
  const nodeRuns = refreshPendingExecutionNodes(workflow, manualRetryRuns(before, 45))
  const first = nodeRuns[45], review = nodeRuns[49]
  if (!isDeepStrictEqual(nodeRuns.slice(0, 45), before.slice(0, 45))
    || first?.status !== 'idle' || review?.status !== 'idle'
    || first.node.id !== 'sanguo-scene-cut-first-frame'
    || review.node.id !== 'sanguo-scene-cut-review'
    || nodeRuns.slice(45).some(run => run.status !== 'idle'
      || run.output !== undefined || Object.keys(run.context ?? {}).length !== 0))
    fail('fresh branch changed the approved prefix or retained a paid output')
  nodeRuns[45] = withParam({ ...first,
    sourceBoundNodeOverride: { version: A8B6_FRESH_FRAME_VERSION,
      nodeId: first.node.id, marker },
    node: { ...first.node, prompt: A8B6_FRESH_FIRST_FRAME_PROMPT } },
  'sceneCutFreshImage', canonical(marker))
  nodeRuns[49] = withParam({ ...review,
    sourceBoundNodeOverride: { version: A8B6_FRESH_FRAME_VERSION,
      nodeId: review.node.id, marker },
    node: { ...review.node, prompt: A8B6_FRESH_REVIEW_PROMPT } },
  'sceneCutFreshImage', canonical(marker))
  const refreshed = refreshPendingExecutionNodes(workflow, nodeRuns)
  if (!isDeepStrictEqual(refreshed[45], nodeRuns[45])
    || !isDeepStrictEqual(refreshed[49], nodeRuns[49]))
    fail('normal workflow refresh would erase managed first-frame or review contract')
  const next = prepareWorkflowRunContext(refreshed, 45)
  const input = next?.inputContext
  if (next?.run?.node?.id !== marker.firstPendingNodeId
    || sceneCutShotSha256(input?.shot_script) !== preflight.approved14s.shotSha256
    || !isDeepStrictEqual(input?.scene_cut_sources, before[41].output)
    || !isDeepStrictEqual(input?.scene_cut_opening_state, before[43].output)
    || input?.first_frame !== undefined || input?.scene_cut_repair_receipt !== undefined)
    fail('new image request would inherit old still or wrong 14s source')
  const state = { ...parent, id: A8B6_FRESH_FRAME_ID,
    parentExecutionId: parent.id, generationScopeId: A8B6_FRESH_FRAME_ID,
    requestScopeId: parent.requestScopeId, historical: false, mode: 'step',
    nodeRuns, context: before[44].context,
    selectedNodeId: marker.firstPendingNodeId,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    // The inherited image edit and certificate rebinding belong to old paid media.
    sceneCutImageRepairRecovery: undefined,
    sceneCutApprovalRebindRecovery: undefined,
    sceneCutA8B6FreshFrameRecovery: marker,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      `在 ${parent.id} 已审14秒脚本和首帧起点上独立新生图；旧同图两次身份拒绝、旧首帧和旧付费A/B保留作审计，不作为新图参考。`] }
  assertA8B6FreshFrameHop(parent, state, timingRow.result_md5, conflict,
    verifiedPrior.state,
    'pending')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('execution storage round trip changed fresh checkpoint')
  return { state, proof: { ...marker, newExecutionId: state.id,
    approved14sShotSha256: preflight.approved14s.shotSha256,
    frozenIdentityCount: preflight.frozenIdentityPlates.length,
    forbiddenSourceCount: preflight.forbiddenSources.length,
    providerCalls: 0, databaseWrites: 0, roundTripVerified: true } }
}

function parseArgs(args) {
  if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
    fail('only --apply is supported; omit it for a read-only dry run')
  return { apply: args.length === 1 }
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2))
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const qa = readA8B6HistoricQaManifest(root)
  const conflict = await verifyA8B6FrameConflictReceipt(A8B6_FRESH_QA_PLAN, root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = apply ? ' FOR SHARE' : ''
    const ids = Object.values(A8B6_FRESH_PREFLIGHT_SOURCE_IDS)
      .filter(value => typeof value === 'string' && value.startsWith('record-'))
    ids.push(A8B6_FRESH_V2_FRAME_ID)
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
    if (rows.length !== 5 || (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
      [A8B6_FRESH_FRAME_ID])).rowCount) fail('source rows changed or fresh ID exists')
    const priorLedgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=ANY($1)`, [[A8B6_FRESH_V2_IMAGE_LEDGER,
        A8B6_FRESH_V2_REVIEW_LEDGER]])).rows
    const priorById = new Map(priorLedgers.map(row => [row.id, row]))
    const verifiedPrior = await verifyA8B6FreshV2Rejection(
      byId.get(A8B6_FRESH_V2_FRAME_ID),
      priorById.get(A8B6_FRESH_V2_IMAGE_LEDGER),
      priorById.get(A8B6_FRESH_V2_REVIEW_LEDGER), root)
    const preflight = prepareA8B6FreshRegenerationPreflight({
      sourceRow: byId.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.SOURCE_ID),
      timingRow: byId.get(A8B6_FRESH_FRAME_PARENT_ID),
      rejectedRow: byId.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.REJECTED_ID),
      retryRow: byId.get(A8B6_FRESH_REJECTED_ID),
      workflowRow: workflow, qa, conflict, ledgerRows, root })
    const { state, proof } = prepareA8B6FreshFirstFrameFork(
      byId.get(A8B6_FRESH_FRAME_PARENT_ID), workflow, preflight,
      conflict, verifiedPrior)
    if (apply) {
      const source = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `首镜14秒全新首帧 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1',
        [state.id])).rows[0]
      if (hashState(saved?.result) !== hashState(encodeExecutionState(state)))
        fail('saved fresh checkpoint differs from prepared state')
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

const hashState = state => createJsonHasher()(decodeExecutionState(state))
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
