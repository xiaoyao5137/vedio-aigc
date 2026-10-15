#!/usr/bin/env node
/** New schema180 child: signed V9 local image, then independent node49/50. */
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
import { A8B6_LOCAL_V9_FRAME_ID, A8B6_LOCAL_V9_FRAME_VERSION,
  A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL } from
  '../src/scene-cut-a8b6-local-detail-review.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV9 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v9.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_V9_FRAME_FORK_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

export function assertA8B6LocalFrameHopV9(timing, current, timingMd5,
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
    || current?.id !== A8B6_LOCAL_V9_FRAME_ID
    || current.parentExecutionId !== timing.id
    || source?.target?.executionId !== current.id
    || source.target.markerVersion !== A8B6_LOCAL_V9_FRAME_VERSION
    || source.approvedFirstFrame !== false
    || source.requiresFreshIndependentReview !== true
    || marker?.version !== A8B6_LOCAL_V9_FRAME_VERSION
    || marker.sourceExecutionId !== timing.id
    || marker.sourceResultMd5 !== timingMd5
    || marker.priorLocalV8ExecutionId !== source.priorLocalV8?.executionId
    || marker.priorLocalV8ResultMd5
      !== source.priorLocalV8?.resultMd5
    || marker.priorLocalV8RejectedReviewSha256
      !== source.priorLocalV8?.rejectedReviewSha256
    || marker.priorLocalV8ReviewModelExecutionId
      !== source.priorLocalV8?.reviewModelExecutionId
    || marker.wallImageGenRawSha256 !== source.sources?.[1]?.sha256
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
    || marker.reviewPromptSha256 !== sha(A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT)
    || !Array.isArray(runs) || runs.length !== original?.length
    || !isDeepStrictEqual(runs.slice(0, 45), original.slice(0, 45))
    || runs[45]?.status !== 'success'
    || runs[45].output?.url !== source.output.url
    || runs[45].output?.sourceBoundLocalComposite?.version
      !== A8B6_LOCAL_V9_FRAME_VERSION
    || runs[45].output?.sourceBoundLocalComposite?.sourceReceiptSha256
      !== signed.receiptSha256
    || runs[45].output?.sourceBoundLocalComposite?.outputSha256
      !== source.output.sha256
    || runs[45].output?.sourceBoundLocalComposite?.approvedFirstFrame !== false
    || review?.node?.prompt !== A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT
    || review.sourceBoundNodeOverride?.version !== A8B6_LOCAL_V9_FRAME_VERSION
    || review.sourceBoundNodeOverride?.nodeId !== review.node.id
    || !isDeepStrictEqual(review.sourceBoundNodeOverride?.marker, marker)
    || review.node.params?.filter(param =>
      param.name === 'sceneCutLocalComposite').length !== 1
    || review.node.params?.find(param =>
      param.name === 'sceneCutLocalComposite')?.value !== canonical(marker)
    || review.node.params?.filter(param =>
      param.name === 'reviewImageDetail').length !== 1
    || review.node.params?.find(param =>
      param.name === 'reviewImageDetail')?.value
      !== canonical(A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL)
    || review.status !== statuses.review
    || runs[50]?.status !== statuses.approval)
    fail('V9 child changed approved prefix, source, review or approval boundary')
  if (phase === 'pending' && runs.slice(46).some(run => run.status !== 'idle'))
    fail('V9 child started before explicit review continuation')
  return marker
}

export function prepareA8B6LocalFrameForkV9(timingRow, rejectedV8Row,
  workflow, signed) {
  const source = signed?.receipt
  if (timingRow?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || rejectedV8Row?.id !== source?.priorLocalV8?.executionId
    || rejectedV8Row.result_md5 !== source.priorLocalV8.resultMd5
    || workflow?.id !== 'wf-sanguo-history-drama'
    || workflow.schema_version !== 180
    || workflow.nodes_md5 !== A8B6_FRESH_NODES_MD5
    || workflow.edges_md5 !== A8B6_FRESH_EDGES_MD5)
    fail('timing, rejected V8 or schema180 graph changed')
  const timing = decodeExecutionState(timingRow.result)
  const rejectedV8 = decodeExecutionState(rejectedV8Row.result)
  const before = timing.nodeRuns
  const v8Runs = rejectedV8.nodeRuns
  if (before?.length !== 464 || before[45]?.status !== 'failed'
    || before.slice(46).some(run => run.status !== 'idle')
    || v8Runs?.[45]?.status !== 'success'
    || v8Runs[45].output?.url !== source.sources?.[0]?.url
    || v8Runs[48]?.status !== 'success'
    || v8Runs[49]?.status !== 'success'
    || v8Runs[49].output?.passed !== false
    || sha(canonical(v8Runs[49].output))
      !== source.priorLocalV8.rejectedReviewSha256
    || v8Runs[50]?.status !== 'idle'
    || source.target?.executionId !== A8B6_LOCAL_V9_FRAME_ID
    || source.sources?.[0]?.executionId !== rejectedV8.id
    || source.sources?.[1]?.role !== 'wall-imagegen'
    || source.sources.length !== 2)
    fail('V8 true rejection or source-bound V9 fork point changed')
  const marker = {
    version: A8B6_LOCAL_V9_FRAME_VERSION,
    sourceExecutionId: timing.id, sourceResultMd5: timingRow.result_md5,
    priorLocalV8ExecutionId: rejectedV8.id,
    priorLocalV8ResultMd5: rejectedV8Row.result_md5,
    priorLocalV8RejectedReviewSha256:
      source.priorLocalV8.rejectedReviewSha256,
    priorLocalV8ReviewModelExecutionId:
      source.priorLocalV8.reviewModelExecutionId,
    wallImageGenRawSha256: source.sources[1].sha256,
    sourceReceiptSha256: signed.receiptSha256,
    outputUrl: source.output.url, outputSha256: source.output.sha256,
    workflowSchemaVersion: 180,
    workflowNodesMd5: A8B6_FRESH_NODES_MD5,
    workflowEdgesMd5: A8B6_FRESH_EDGES_MD5,
    preservedPrefixLength: 45,
    preservedPrefixSha256: sha(canonical(before.slice(0, 45))),
    firstPendingIndex: 46,
    firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256: sha(A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT),
  }
  const nodeRuns = refreshPendingExecutionNodes(workflow,
    manualRetryRuns(before, 45))
  if (!isDeepStrictEqual(nodeRuns.slice(0, 45), before.slice(0, 45))
    || nodeRuns.slice(45).some(run => run.status !== 'idle'))
    fail('V9 fork invalidated approved timing prefix or inherited old media')
  const inputContext = prepareWorkflowRunContext(nodeRuns, 45)?.inputContext
  if (!isDeepStrictEqual(inputContext?.shot_script, before[11].output)
    || !isDeepStrictEqual(inputContext?.scene_cut_sources, before[41].output)
    || !isDeepStrictEqual(inputContext?.scene_cut_opening_state, before[43].output)
    || inputContext?.first_frame !== undefined)
    fail('V9 source cannot inherit approved 14-second opening inputs')
  const local = { version: A8B6_LOCAL_V9_FRAME_VERSION,
    sourceReceiptSha256: signed.receiptSha256,
    outputSha256: source.output.sha256,
    wallImageGenRawSha256: source.sources[1].sha256,
    algorithmId: source.algorithm.id,
    implementationSha256: source.algorithm.implementationSha256,
    approvedFirstFrame: false }
  const output = { url: source.output.url,
    urls: [source.output.url], items: [{ url: source.output.url }],
    model: 'source-bound-local-composite-v9',
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
    sourceBoundNodeOverride: { version: A8B6_LOCAL_V9_FRAME_VERSION,
      nodeId: nodeRuns[49].node.id, marker },
    node: { ...nodeRuns[49].node,
      prompt: A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT,
      params: [...nodeRuns[49].node.params,
        { name: 'sceneCutLocalComposite',
          englishName: 'sceneCutLocalComposite',
          type: 'json', value: canonical(marker) },
        { name: 'reviewImageDetail',
          englishName: 'reviewImageDetail', type: 'json',
          value: canonical(A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL) }] } }
  const refreshed = refreshPendingExecutionNodes(workflow, nodeRuns)
  if (!isDeepStrictEqual(refreshed[49], nodeRuns[49])
    || !isDeepStrictEqual(refreshed.slice(0, 46), nodeRuns.slice(0, 46)))
    fail('browser/schema refresh removed V9 source or managed review')
  const nextInput = prepareWorkflowRunContext(refreshed, 46)?.inputContext
  if (!isDeepStrictEqual(nextInput?.first_frame, output)
    || !isDeepStrictEqual(nextInput?.shot_script, before[11].output)
    || !isDeepStrictEqual(nextInput?.scene_cut_sources, before[41].output))
    fail('next node cannot read V9 local first frame')
  const state = { ...timing, id: A8B6_LOCAL_V9_FRAME_ID,
    parentExecutionId: timing.id,
    generationScopeId: A8B6_LOCAL_V9_FRAME_ID,
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
      '首镜14秒 V9 最右侧木柱材质确定性派生首帧已锁源；需本次采证、独立模型审图和签证。'] }
  assertA8B6LocalFrameHopV9(timing, state, timingRow.result_md5,
    signed, 'pending')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(
    encodeExecutionState(state))))) !== hash(state))
    fail('execution storage round trip changed V9 child')
  return { state, proof: { childExecutionId: state.id,
    parentExecutionId: timing.id, parentResultMd5: timingRow.result_md5,
    sourceReceiptSha256: signed.receiptSha256,
    outputSha256: source.output.sha256,
    firstPendingIndex: 46, firstPendingNodeId: marker.firstPendingNodeId,
    preservedPrefixSha256: marker.preservedPrefixSha256,
    reviewPromptSha256: marker.reviewPromptSha256,
    providerCalls: 0, databaseWrites: 0, roundTripVerified: true } }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
    fail('only --apply is supported')
  const apply = args.length === 1
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const signed = await verifyA8B6LocalCompositeSourceReceiptV9(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = apply ? ' FOR SHARE' : ''
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      signed.receipt.priorLocalV8.executionId]
    const rows = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)${suffix}`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'${suffix}`)).rows[0]
    if (rows.length !== ids.length || (await db.query(`SELECT 1
      FROM execution_records WHERE id=$1`, [A8B6_LOCAL_V9_FRAME_ID])).rowCount)
      fail('source rows missing or V9 child ID already exists')
    const { state, proof } = prepareA8B6LocalFrameForkV9(
      byId.get(A8B6_FRESH_FRAME_PARENT_ID),
      byId.get(signed.receipt.priorLocalV8.executionId), workflow, signed)
    if (apply) {
      const parent = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, parent.workflow_id, parent.workflow_name,
        `首镜14秒本地墙面派生首帧复审 · ${parent.id}`,
        JSON.stringify(parent.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query(`SELECT result FROM execution_records
        WHERE id=$1`, [state.id])).rows[0]
      if (createJsonHasher()(decodeExecutionState(saved?.result))
        !== createJsonHasher()(state))
        fail('saved V9 child differs from prepared checkpoint')
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
