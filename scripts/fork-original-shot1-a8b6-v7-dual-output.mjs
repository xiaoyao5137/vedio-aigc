#!/usr/bin/env node
/** Continue the selected image from V7's completed two-PNG CLI turn, without a provider call. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from
  '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { A8B6_FRESH_V7_EDIT_FRAME_ID,
  A8B6_FRESH_V6_EDIT_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_V6_REJECTED_MD5, assertA8B6FreshV7EditHop,
  verifyA8B6FreshV7EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID,
  A8B6_V7_DUAL_OUTPUT_VERSION, A8B6_V7_FAILED_MD5,
  A8B6_V7_FAILED_IMAGE_LEDGER, assertA8B6V7DualOutputRecoveryHop,
  verifyA8B6V7DualOutputRecoveryReceiptAsync } from
  '../server/staged-scene-cut-a8b6-v7-dual-output.mjs'

const fail = reason => { throw Error(`A8B6_V7_DUAL_OUTPUT_FORK_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

export function prepareA8B6V7DualOutputFork(timingRow, rejectedRow,
  failedRow, workflow, ledger, edit, signed) {
  if (timingRow?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingRow.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || rejectedRow?.id !== A8B6_FRESH_V6_EDIT_FRAME_ID
    || rejectedRow.result_md5 !== A8B6_FRESH_V6_REJECTED_MD5
    || failedRow?.id !== A8B6_FRESH_V7_EDIT_FRAME_ID
    || failedRow.result_md5 !== A8B6_V7_FAILED_MD5
    || workflow?.schema_version !== 180
    || workflow.nodes_md5 !== A8B6_FRESH_NODES_MD5
    || workflow.edges_md5 !== A8B6_FRESH_EDGES_MD5
    || ledger?.id !== A8B6_V7_FAILED_IMAGE_LEDGER
    || ledger.status !== 'failed'
    || signed?.receipt?.failedImageModelExecutionId !== ledger.id)
    fail('source CAS, graph, failed payment or signed selection changed')
  const timing = decodeExecutionState(timingRow.result)
  const rejected = decodeExecutionState(rejectedRow.result)
  const parent = decodeExecutionState(failedRow.result)
  assertA8B6FreshV7EditHop(timing, parent, timingRow.result_md5,
    edit, rejected, 'dual-output-failed')
  const before = parent.nodeRuns, original = before[45], receipt = signed.receipt
  const image = { url: receipt.imageUrl,
    urls: [receipt.imageUrl], items: [{ url: receipt.imageUrl }],
    model: 'codex-gpt-image-2',
    prompt: original.node.prompt,
    params: { ...original.inputs, qualityDisposition: 'manual-review-v1' },
    qualityDisposition: 'manual-review-v1',
    raw: { provider: 'Codex', data: [{ url: receipt.imageUrl }],
      raw: { ...ledger.response_data.raw,
        image: { sha256: receipt.normalizedImageSha256,
          bytes: receipt.normalizedImageBytes, url: receipt.imageUrl },
        outputSize: receipt.outputSize,
        recovery: { version: A8B6_V7_DUAL_OUTPUT_VERSION,
          originalLedgerStatus: 'failed',
          failedImageModelExecutionId: ledger.id,
          receiptSha256: signed.receiptSha256 } } },
    sourceBoundDualOutput: { version: A8B6_V7_DUAL_OUTPUT_VERSION,
      receiptSha256: signed.receiptSha256,
      failedImageModelExecutionId: ledger.id,
      selectedSourceSha256: receipt.selectedSourceSha256,
      unselectedSourceSha256: receipt.unselectedSourceSha256,
      normalizedImageSha256: receipt.normalizedImageSha256 } }
  const nextContext = applyNodeOutputToContext(original.inputContext,
    original.node.resultVar, image)
  const nodeRuns = before.map((run, index) => index === 45
    ? { ...run, status: 'success', output: image, context: nextContext,
      error: undefined }
    : run)
  const refreshed = refreshPendingExecutionNodes(workflow, nodeRuns)
  if (!isDeepStrictEqual(refreshed.slice(0, 46), nodeRuns.slice(0, 46))
    || !isDeepStrictEqual(refreshed[49], nodeRuns[49])
    || refreshed.slice(46).some(run => run.status !== 'idle'))
    fail('refresh changed approved V7 prefix, review prompt or pending boundary')
  const nextInput = prepareWorkflowRunContext(refreshed, 46)?.inputContext
  if (!isDeepStrictEqual(nextInput?.first_frame, image)
    || !isDeepStrictEqual(nextInput?.shot_script, before[11].output)
    || !isDeepStrictEqual(nextInput?.scene_cut_sources, before[41].output))
    fail('next local node cannot read selected frame and approved sources')
  const marker = { version: A8B6_V7_DUAL_OUTPUT_VERSION,
    parentExecutionId: parent.id,
    parentResultMd5: failedRow.result_md5,
    failedImageModelExecutionId: ledger.id,
    receiptSha256: signed.receiptSha256,
    selectedSourceSha256: receipt.selectedSourceSha256,
    normalizedImageSha256: receipt.normalizedImageSha256,
    imageUrl: receipt.imageUrl,
    preservedPrefixLength: 45,
    preservedPrefixSha256: sha(canonical(before.slice(0, 45))),
    firstPendingIndex: 46 }
  const state = { ...parent, id: A8B6_V7_DUAL_OUTPUT_CHILD_ID,
    parentExecutionId: parent.id,
    generationScopeId: A8B6_V7_DUAL_OUTPUT_CHILD_ID,
    requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns: refreshed,
    context: nextContext, selectedNodeId: refreshed[46].node.id,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutA8B6V7DualOutputRecovery: marker,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      'V7同一CLI完成轮次保存两张完整PNG；保留失败账本与双图，签名选图后仅从node46继续独立审图，未重新付款。'] }
  assertA8B6V7DualOutputRecoveryHop(parent, state,
    failedRow.result_md5, signed, 'image-complete')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('execution storage round trip changed recovery child')
  return { state, proof: { childExecutionId: state.id,
    failedExecutionId: parent.id,
    failedResultMd5: failedRow.result_md5,
    receiptSha256: signed.receiptSha256,
    selectedSourceSha256: receipt.selectedSourceSha256,
    normalizedImageSha256: receipt.normalizedImageSha256,
    imageUrl: receipt.imageUrl,
    firstPendingIndex: 46,
    providerCalls: 0, databaseWrites: 0, roundTripVerified: true } }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
    fail('only --apply is supported')
  const apply = args.length === 1
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const edit = await verifyA8B6FreshV7EditReceipt(root)
  const signed = await verifyA8B6V7DualOutputRecoveryReceiptAsync(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = apply ? ' FOR SHARE' : ''
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_FRESH_V6_EDIT_FRAME_ID, A8B6_FRESH_V7_EDIT_FRAME_ID]
    const rows = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1)${suffix}`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'${suffix}`)).rows[0]
    const ledger = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=$1`, [A8B6_V7_FAILED_IMAGE_LEDGER])).rows[0]
    if (rows.length !== ids.length || (await db.query(`SELECT 1
      FROM execution_records WHERE id=$1`, [A8B6_V7_DUAL_OUTPUT_CHILD_ID])).rowCount)
      fail('source rows missing or recovery child already exists')
    const { state, proof } = prepareA8B6V7DualOutputFork(
      byId.get(A8B6_FRESH_FRAME_PARENT_ID),
      byId.get(A8B6_FRESH_V6_EDIT_FRAME_ID),
      byId.get(A8B6_FRESH_V7_EDIT_FRAME_ID),
      workflow, ledger, edit, signed)
    if (apply) {
      const parent = byId.get(A8B6_FRESH_V7_EDIT_FRAME_ID)
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, parent.workflow_id, parent.workflow_name,
        `首镜14秒 V7 双输出选图复审 · ${parent.id}`,
        JSON.stringify(parent.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query(`SELECT result FROM execution_records
        WHERE id=$1`, [state.id])).rows[0]
      if (createJsonHasher()(decodeExecutionState(saved?.result))
        !== createJsonHasher()(state))
        fail('saved child differs from reviewed recovery checkpoint')
    }
    for (const [id, row] of byId) {
      const check = (await db.query(`SELECT md5(result::text) AS md5
        FROM execution_records WHERE id=$1`, [id])).rows[0]
      if (check?.md5 !== row.result_md5) fail('source changed during fork')
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
