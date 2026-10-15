#!/usr/bin/env node
/** Retry only the pre-provider V5 gate failure after loading the signed binder.
 * The failed node and its model ledger remain in the parent record. */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { A8B6_FRESH_EDIT_FRAME_ID, A8B6_FRESH_V4_REVIEW_RETRY_ID,
  A8B6_FRESH_V5_EDIT_FRAME_ID, A8B6_FRESH_V5_RUNTIME_RETRY_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_V4_IMAGE_MD5, A8B6_FRESH_V4_REVIEW_MD5,
  A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5,
  A8B6_FRESH_V5_PRE_PROVIDER_LEDGER,
  assertA8B6FreshV5EditHop, assertA8B6FreshV5RuntimeRetryHop,
  verifyA8B6FreshV5EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v5.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_V5_RUNTIME_RETRY_INVALID: ${reason}`) }

export function prepareA8B6FreshV5RuntimeRetry(parentRow, timingRow,
  rejectedImageRow, rejectedReviewRow, graph, signed, failedLedger) {
  if (parentRow?.id !== A8B6_FRESH_V5_EDIT_FRAME_ID
    || parentRow.result_md5 !== A8B6_FRESH_V5_PRE_PROVIDER_FAILED_MD5
    || timingRow?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || rejectedImageRow?.id !== A8B6_FRESH_EDIT_FRAME_ID
    || rejectedImageRow.result_md5 !== A8B6_FRESH_V4_IMAGE_MD5
    || rejectedReviewRow?.id !== A8B6_FRESH_V4_REVIEW_RETRY_ID
    || rejectedReviewRow.result_md5 !== A8B6_FRESH_V4_REVIEW_MD5
    || graph?.id !== 'wf-sanguo-history-drama'
    || graph.schema_version !== 180
    || failedLedger?.id !== A8B6_FRESH_V5_PRE_PROVIDER_LEDGER
    || failedLedger.status !== 'failed' || failedLedger.task_id !== null
    || failedLedger.response_data?.task_id)
    fail('exact failed-image gate and source ancestry changed')
  const parent = decodeExecutionState(parentRow.result)
  const timing = decodeExecutionState(timingRow.result)
  const rejectedImage = decodeExecutionState(rejectedImageRow.result)
  const rejectedReview = decodeExecutionState(rejectedReviewRow.result)
  if (!String(failedLedger.request_data?.requestKey ?? '')
    .startsWith(`${parent.id}:`)
    || failedLedger.request_data?.params?.referenceImages?.length !== 2)
    fail('prior request may have reached the paid image provider')
  assertA8B6FreshV5EditHop(timing, parent, timingRow.result_md5,
    signed, rejectedImage, rejectedReview, 'pre-provider-failed')
  const nodeRuns = refreshPendingExecutionNodes(graph,
    manualRetryRuns(parent.nodeRuns, 45))
  if (!isDeepStrictEqual(nodeRuns.slice(0, 45), parent.nodeRuns.slice(0, 45))
    || !isDeepStrictEqual(nodeRuns[45].node, parent.nodeRuns[45].node)
    || !isDeepStrictEqual(nodeRuns[49].node, parent.nodeRuns[49].node)
    || nodeRuns.slice(45).some(run => run.status !== 'idle'))
    fail('retry changed prefix, managed prompt or pending status')
  const state = { ...parent, id: A8B6_FRESH_V5_RUNTIME_RETRY_ID,
    parentExecutionId: parent.id,
    generationScopeId: A8B6_FRESH_V5_RUNTIME_RETRY_ID,
    requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns,
    selectedNodeId: 'sanguo-scene-cut-first-frame',
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      'V5第一次请求被旧孤儿服务的付款前门禁拦截，task_id为空；保留失败账本，仅在加载V5签名binder的新服务中重试同一受管请求。'] }
  assertA8B6FreshV5RuntimeRetryHop(parent, state,
    parentRow.result_md5, 'pending')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('execution storage round trip changed retry')
  return { state, proof: { newExecutionId: state.id,
    parentExecutionId: parent.id, parentResultMd5: parentRow.result_md5,
    editReceiptSha256: signed.receiptSha256,
    failedLedgerId: failedLedger.id, paidProviderTaskId: null,
    preservedPrefixLength: 45, firstPendingIndex: 45,
    databaseWrites: 0, providerCalls: 0, roundTripVerified: true } }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length > 1 || argv.length === 1 && argv[0] !== '--apply')
    fail('only --apply is supported')
  const apply = argv.length === 1
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const signed = await verifyA8B6FreshV5EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = apply ? ' FOR SHARE' : ''
    const ids = [A8B6_FRESH_V5_EDIT_FRAME_ID, A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_FRESH_EDIT_FRAME_ID, A8B6_FRESH_V4_REVIEW_RETRY_ID]
    const rows = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)${suffix}`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const graph = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'${suffix}`)).rows[0]
    const failed = (await db.query(`SELECT id,status,task_id,request_data,
      response_data FROM model_execution_records WHERE id=$1`,
    [A8B6_FRESH_V5_PRE_PROVIDER_LEDGER])).rows[0]
    if (rows.length !== ids.length
      || (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
        [A8B6_FRESH_V5_RUNTIME_RETRY_ID])).rowCount)
      fail('source rows changed or retry ID already exists')
    const { state, proof } = prepareA8B6FreshV5RuntimeRetry(
      byId.get(A8B6_FRESH_V5_EDIT_FRAME_ID),
      byId.get(A8B6_FRESH_FRAME_PARENT_ID),
      byId.get(A8B6_FRESH_EDIT_FRAME_ID),
      byId.get(A8B6_FRESH_V4_REVIEW_RETRY_ID), graph, signed, failed)
    if (apply) {
      const parent = byId.get(A8B6_FRESH_V5_EDIT_FRAME_ID)
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, parent.workflow_id, parent.workflow_name,
        `首镜14秒 V5 付款前阻断恢复 · ${parent.id}`,
        JSON.stringify(parent.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1',
        [state.id])).rows[0]
      if (createJsonHasher()(decodeExecutionState(saved?.result))
        !== createJsonHasher()(state)) fail('saved retry checkpoint changed')
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
