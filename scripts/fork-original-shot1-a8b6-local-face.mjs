#!/usr/bin/env node
/** Fork the approved 14s script with a signed, deterministic local t=0 image. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from
  '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from
  '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { A8B6_LOCAL_FRAME_ID, A8B6_LOCAL_FRAME_VERSION,
  A8B6_LOCAL_FRAME_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_EDIT_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_V4_IMAGE_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v5.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID } from
  '../server/staged-scene-cut-a8b6-v7-dual-output.mjs'
import { A8B6_V7_REJECTED_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { A8B6_LOCAL_COMPOSITE_PRIOR_V8,
  verifyA8B6LocalCompositeSourceReceipt } from
  '../server/staged-scene-cut-a8b6-local-composite-admission.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_FRAME_FORK_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

export function assertA8B6LocalFrameHop(timing, current, timingMd5,
  signed, phase = 'pending') {
  const marker = current?.sceneCutA8B6LocalFrameRecovery
  const runs = current?.nodeRuns, original = timing?.nodeRuns
  const source = signed?.receipt
  const review = runs?.[49]
  const statuses = phase === 'pending'
    ? { review: 'idle', approval: 'idle' }
    : phase === 'review-running'
      ? { review: 'running', approval: 'idle' }
      : phase === 'review-complete'
        ? { review: 'success', approval: 'idle' }
        : phase === 'approval-running'
          ? { review: 'success', approval: 'running' }
          : phase === 'approved'
            ? { review: 'success', approval: 'success' } : undefined
  if (!statuses || timing?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || current?.id !== A8B6_LOCAL_FRAME_ID
    || current.parentExecutionId !== timing.id
    || source?.target?.executionId !== current.id
    || source.target.markerVersion !== A8B6_LOCAL_FRAME_VERSION
    || source.approvedFirstFrame !== false
    || source.requiresFreshIndependentReview !== true
    || marker?.version !== A8B6_LOCAL_FRAME_VERSION
    || marker.sourceExecutionId !== timing.id
    || marker.sourceResultMd5 !== timingMd5
    || marker.v7ExecutionId !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || marker.v7ResultMd5 !== A8B6_V7_REJECTED_MD5
    || marker.v4ExecutionId !== A8B6_FRESH_EDIT_FRAME_ID
    || marker.v4ResultMd5 !== A8B6_FRESH_V4_IMAGE_MD5
    || marker.v8ExecutionId !== A8B6_LOCAL_COMPOSITE_PRIOR_V8.executionId
    || marker.v8ResultMd5 !== A8B6_LOCAL_COMPOSITE_PRIOR_V8.resultMd5
    || marker.v8RejectedReviewSha256
      !== A8B6_LOCAL_COMPOSITE_PRIOR_V8.rejectedReviewSha256
    || marker.sourceReceiptSha256 !== signed.receiptSha256
    || marker.outputUrl !== source.output.url
    || marker.outputSha256 !== source.output.sha256
    || marker.workflowSchemaVersion !== 180
    || marker.workflowNodesMd5 !== A8B6_FRESH_NODES_MD5
    || marker.workflowEdgesMd5 !== A8B6_FRESH_EDGES_MD5
    || marker.preservedPrefixLength !== 45
    || marker.preservedPrefixSha256 !== sha(canonical(original?.slice(0, 45)))
    || marker.firstPendingIndex !== 46
    || marker.firstPendingNodeId !== 'sanguo-map-end-accept'
    || marker.reviewPromptSha256 !== sha(A8B6_LOCAL_FRAME_REVIEW_PROMPT)
    || !Array.isArray(runs) || runs.length !== original?.length
    || !isDeepStrictEqual(runs.slice(0, 45), original.slice(0, 45))
    || runs[45]?.status !== 'success'
    || runs[45].output?.url !== source.output.url
    || runs[45].output?.sourceBoundLocalComposite?.sourceReceiptSha256
      !== signed.receiptSha256
    || runs[45].output?.sourceBoundLocalComposite?.outputSha256
      !== source.output.sha256
    || runs[45].output?.sourceBoundLocalComposite?.approvedFirstFrame !== false
    || review?.node?.prompt !== A8B6_LOCAL_FRAME_REVIEW_PROMPT
    || review.sourceBoundNodeOverride?.version !== A8B6_LOCAL_FRAME_VERSION
    || review.sourceBoundNodeOverride?.nodeId !== review.node.id
    || !isDeepStrictEqual(review.sourceBoundNodeOverride?.marker, marker)
    || review.node.params?.filter(param =>
      param.name === 'sceneCutLocalComposite').length !== 1
    || review.node.params?.find(param =>
      param.name === 'sceneCutLocalComposite')?.value !== canonical(marker)
    || review.status !== statuses.review
    || runs[50]?.status !== statuses.approval)
    fail('local child changed timing prefix, source, managed review or approval boundary')
  if (phase === 'pending' && runs.slice(46).some(run => run.status !== 'idle'))
    fail('new local child has started before explicit review continuation')
  return marker
}

export function prepareA8B6LocalFrameFork(timingRow, v7Row, v4Row,
  v8Row, workflow, signed) {
  const prior = A8B6_LOCAL_COMPOSITE_PRIOR_V8
  if (timingRow?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || v7Row?.id !== A8B6_V7_DUAL_OUTPUT_CHILD_ID
    || v7Row.result_md5 !== A8B6_V7_REJECTED_MD5
    || v4Row?.id !== A8B6_FRESH_EDIT_FRAME_ID
    || v4Row.result_md5 !== A8B6_FRESH_V4_IMAGE_MD5
    || v8Row?.id !== prior.executionId
    || v8Row.result_md5 !== prior.resultMd5
    || workflow?.id !== 'wf-sanguo-history-drama'
    || workflow.schema_version !== 180
    || workflow.nodes_md5 !== A8B6_FRESH_NODES_MD5
    || workflow.edges_md5 !== A8B6_FRESH_EDGES_MD5)
    fail('approved timing, three source records or schema180 graph changed')
  const timing = decodeExecutionState(timingRow.result)
  const v7 = decodeExecutionState(v7Row.result)
  const v4 = decodeExecutionState(v4Row.result)
  const v8 = decodeExecutionState(v8Row.result)
  const before = timing.nodeRuns
  if (before?.length !== 464 || before[45]?.status !== 'failed'
    || before.slice(46).some(run => run.status !== 'idle')
    || v7.nodeRuns[49]?.output?.passed !== false
    || v4.nodeRuns[49]?.status !== 'failed'
    || v8.nodeRuns[49]?.output?.passed !== false
    || sha(canonical(v8.nodeRuns[49].output))
      !== prior.rejectedReviewSha256)
    fail('rejected histories or exact timing fork point changed')
  const source = signed.receipt
  if (source.target?.executionId !== A8B6_LOCAL_FRAME_ID
    || source.sources[0].executionId !== v7.id
    || source.sources[1].executionId !== v4.id)
    fail('signed local output is not bound to these records')
  const marker = {
    version: A8B6_LOCAL_FRAME_VERSION,
    sourceExecutionId: timing.id,
    sourceResultMd5: timingRow.result_md5,
    v7ExecutionId: v7.id, v7ResultMd5: v7Row.result_md5,
    v4ExecutionId: v4.id, v4ResultMd5: v4Row.result_md5,
    v8ExecutionId: v8.id, v8ResultMd5: v8Row.result_md5,
    v8RejectedReviewSha256: prior.rejectedReviewSha256,
    sourceReceiptSha256: signed.receiptSha256,
    outputUrl: source.output.url, outputSha256: source.output.sha256,
    workflowSchemaVersion: 180,
    workflowNodesMd5: A8B6_FRESH_NODES_MD5,
    workflowEdgesMd5: A8B6_FRESH_EDGES_MD5,
    preservedPrefixLength: 45,
    preservedPrefixSha256: sha(canonical(before.slice(0, 45))),
    firstPendingIndex: 46,
    firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256: sha(A8B6_LOCAL_FRAME_REVIEW_PROMPT),
  }
  const nodeRuns = refreshPendingExecutionNodes(workflow,
    manualRetryRuns(before, 45))
  if (!isDeepStrictEqual(nodeRuns.slice(0, 45), before.slice(0, 45))
    || nodeRuns.slice(45).some(run => run.status !== 'idle'))
    fail('local fork invalidated approved timing prefix or retained old media')
  const inputContext = prepareWorkflowRunContext(nodeRuns, 45)?.inputContext
  if (!isDeepStrictEqual(inputContext?.shot_script, before[11].output)
    || !isDeepStrictEqual(inputContext?.scene_cut_sources, before[41].output)
    || !isDeepStrictEqual(inputContext?.scene_cut_opening_state, before[43].output)
    || inputContext?.first_frame !== undefined)
    fail('local source cannot inherit the approved 14-second opening inputs')
  const local = { version: A8B6_LOCAL_FRAME_VERSION,
    sourceReceiptSha256: signed.receiptSha256,
    outputSha256: source.output.sha256,
    algorithmId: source.algorithm.id,
    implementationSha256: source.algorithm.implementationSha256,
    approvedFirstFrame: false }
  const output = { url: source.output.url,
    urls: [source.output.url], items: [{ url: source.output.url }],
    model: 'source-bound-local-composite-v1',
    sourceBoundLocalComposite: local,
    raw: { provider: 'Local', data: [{ url: source.output.url }],
      sourceReceiptSha256: signed.receiptSha256,
      sha256: source.output.sha256 } }
  const nextContext = applyNodeOutputToContext(inputContext,
    nodeRuns[45].node.resultVar, output)
  nodeRuns[45] = { ...nodeRuns[45], status: 'success',
    inputs: { sourceBoundLocalComposite: local }, inputContext,
    output, context: nextContext, error: undefined }
  nodeRuns[49] = { ...nodeRuns[49],
    sourceBoundNodeOverride: { version: A8B6_LOCAL_FRAME_VERSION,
      nodeId: nodeRuns[49].node.id, marker },
    node: { ...nodeRuns[49].node,
      prompt: A8B6_LOCAL_FRAME_REVIEW_PROMPT,
      params: [...nodeRuns[49].node.params,
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite',
          type: 'json', value: canonical(marker) }] } }
  const refreshed = refreshPendingExecutionNodes(workflow, nodeRuns)
  if (!isDeepStrictEqual(refreshed[49], nodeRuns[49])
    || !isDeepStrictEqual(refreshed.slice(0, 46), nodeRuns.slice(0, 46)))
    fail('browser/schema refresh removed local source or managed review')
  const nextInput = prepareWorkflowRunContext(refreshed, 46)?.inputContext
  if (!isDeepStrictEqual(nextInput?.first_frame, output)
    || !isDeepStrictEqual(nextInput?.shot_script, before[11].output)
    || !isDeepStrictEqual(nextInput?.scene_cut_sources, before[41].output))
    fail('next node cannot read new local first frame')
  const state = { ...timing, id: A8B6_LOCAL_FRAME_ID,
    parentExecutionId: timing.id, generationScopeId: A8B6_LOCAL_FRAME_ID,
    requestScopeId: timing.requestScopeId,
    historical: false, mode: 'step', nodeRuns: refreshed,
    context: nextContext, selectedNodeId: refreshed[46].node.id,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutImageRepairRecovery: undefined,
    sceneCutApprovalRebindRecovery: undefined,
    sceneCutA8B6FreshFrameRecovery: undefined,
    sceneCutA8B6LocalFrameRecovery: marker,
    logs: [...(Array.isArray(timing.logs) ? timing.logs : []),
      '首镜14秒本地确定性脸区派生图已锁源；仅首帧采证、独立模型审图和签证通过后方可作为媒体首帧。'] }
  assertA8B6LocalFrameHop(timing, state, timingRow.result_md5,
    signed, 'pending')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('execution storage round trip changed local child')
  return { state, proof: { childExecutionId: state.id,
    parentExecutionId: timing.id,
    parentResultMd5: timingRow.result_md5,
    sourceReceiptSha256: signed.receiptSha256,
    outputSha256: source.output.sha256,
    firstPendingIndex: 46, firstPendingNodeId: marker.firstPendingNodeId,
    preservedPrefixSha256: marker.preservedPrefixSha256,
    reviewPromptSha256: marker.reviewPromptSha256,
    providerCalls: 0, databaseWrites: 0,
    roundTripVerified: true } }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
    fail('only --apply is supported')
  const apply = args.length === 1
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const signed = await verifyA8B6LocalCompositeSourceReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = apply ? ' FOR SHARE' : ''
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_V7_DUAL_OUTPUT_CHILD_ID, A8B6_FRESH_EDIT_FRAME_ID,
      A8B6_LOCAL_COMPOSITE_PRIOR_V8.executionId]
    const rows = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)${suffix}`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'${suffix}`)).rows[0]
    if (rows.length !== ids.length || (await db.query(`SELECT 1
      FROM execution_records WHERE id=$1`, [A8B6_LOCAL_FRAME_ID])).rowCount)
      fail('source rows missing or local child ID already exists')
    const { state, proof } = prepareA8B6LocalFrameFork(
      byId.get(A8B6_FRESH_FRAME_PARENT_ID),
      byId.get(A8B6_V7_DUAL_OUTPUT_CHILD_ID),
      byId.get(A8B6_FRESH_EDIT_FRAME_ID),
      byId.get(A8B6_LOCAL_COMPOSITE_PRIOR_V8.executionId),
      workflow, signed)
    if (apply) {
      const parent = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, parent.workflow_id, parent.workflow_name,
        `首镜14秒本地脸区派生首帧复审 · ${parent.id}`,
        JSON.stringify(parent.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query(`SELECT result FROM execution_records
        WHERE id=$1`, [state.id])).rows[0]
      if (createJsonHasher()(decodeExecutionState(saved?.result))
        !== createJsonHasher()(state))
        fail('saved local child differs from prepared checkpoint')
    }
    for (const [id, row] of byId) {
      const check = (await db.query(`SELECT md5(result::text) AS md5
        FROM execution_records WHERE id=$1`, [id])).rows[0]
      if (check?.md5 !== row.result_md5) fail('historical source changed')
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
  main().catch(error => { console.error(error instanceof Error
    ? error.message : String(error)); process.exitCode = 1 })
