#!/usr/bin/env node
/** Preserve the rejected same-pixel review and retry node49 under one signed,
 * independently adjudicated threshold conflict. No image/video provider call. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { assertA8B6ConflictReviewHop,
  verifyA8B6FrameConflictReceipt } from '../server/staged-scene-cut-a8b6-frame-conflict.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const SOURCE_ID = 'record-4x5m31-a8b6-frame-reuse-v3'
const SOURCE_MD5 = '01146ea0d4a7c0d6664f65d5eb9bc54e'
const CHILD_ID = 'record-4x5m31-a8b6-frame-conflict-review-v1'
const PLAN = 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const fail = message => { throw Error(`A8B6_FRAME_CONFLICT_RETRY_INVALID: ${message}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

export function prepareA8B6FrameConflictReviewFork(source, workflow, signed) {
  if (source?.id !== SOURCE_ID || source.result_md5 !== SOURCE_MD5
    || source.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.id !== source.workflow_id || workflow.schema_version !== 180
    || workflow.nodes_md5 !== NODES_MD5 || workflow.edges_md5 !== EDGES_MD5
    || signed.receipt?.qaPlanId !== PLAN
    || signed.receipt?.rejectedExecutionId !== SOURCE_ID
    || signed.receipt?.rejectedResultMd5 !== SOURCE_MD5)
    fail('signed adjudication, source checkpoint or schema180 graph changed')
  const parent = decodeExecutionState(source.result)
  const before = parent.nodeRuns
  if (parent.id !== SOURCE_ID || !Array.isArray(before) || before.length !== 464
    || before.slice(0, 49).some(run => !['success', 'skipped'].includes(run.status))
    || before[49]?.status !== 'success' || before[49].output?.passed !== false
    || before[49].output.issues?.length !== 1
    || before[49].output.issues[0]?.code !== 'wardrobe_hem_proportion_mismatch'
    || before.slice(50).some(run => run.status !== 'idle')
    || parent.sceneCutA8B6ImageReuseRecovery?.version !== 'scene-cut-a8b6-image-reuse-v1'
    || parent.sceneCutA8B6ImageReuseRecovery?.qaPlanId !== PLAN)
    fail('source has no exact same-pixel threshold rejection')
  const nodeRuns = refreshPendingExecutionNodes(workflow, manualRetryRuns(before, 49))
  if (!isDeepStrictEqual(nodeRuns.slice(0, 49), before.slice(0, 49))
    || !isDeepStrictEqual(nodeRuns[49]?.node, before[49]?.node)
    || nodeRuns.slice(49).some(run => run.status !== 'idle'
      || run.output !== undefined || Object.keys(run.context ?? {}).length !== 0)
    || nodeRuns.findIndex(run => run.status === 'idle') !== 49)
    fail('review retry altered original paid image, evidence or managed prompt')
  const next = prepareWorkflowRunContext(nodeRuns, 49)
  if (next?.run?.node.id !== 'sanguo-scene-cut-review'
    || !isDeepStrictEqual(next.inputContext.scene_cut_evidence, before[48].output)
    || !isDeepStrictEqual(next.inputContext.scene_cut_sources, before[41].output)
    || !isDeepStrictEqual(next.inputContext.shot_script, before[11].output)
    || !isDeepStrictEqual(next.inputContext.scene_cut_opening_state, before[43].output)
    || !isDeepStrictEqual(next.inputContext.first_frame, before[45].output))
    fail('new review would not use the exact approved image, evidence and shot')
  const marker = { version: 'scene-cut-a8b6-conflict-review-retry-v1',
    sourceExecutionId: SOURCE_ID, sourceResultMd5: SOURCE_MD5,
    qaPlanId: PLAN, workflowSchemaVersion: 180,
    workflowNodesMd5: NODES_MD5, workflowEdgesMd5: EDGES_MD5,
    adjudicationReceiptSha256: signed.receiptSha256,
    adjudicationModelExecutionId: signed.receipt.modelExecutionId,
    rejectedReviewSha256: signed.receipt.rejectedReviewSha256,
    originalImageSha256: signed.receipt.sourceImageSha256,
    preservedPrefixLength: 49,
    preservedPrefixSha256: sha(canonical(before.slice(0, 49))),
    firstPendingIndex: 49, firstPendingNodeId: before[49].node.id }
  const state = { ...parent, id: CHILD_ID, parentExecutionId: SOURCE_ID,
    generationScopeId: CHILD_ID, requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns,
    context: before[48].context, selectedNodeId: nodeRuns[49].node.id,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutA8B6ConflictReviewRecovery: marker,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      `保留 ${SOURCE_ID} 的 node49 衣摆拒绝与原图；独立冲突裁定 ${signed.receipt.modelExecutionId} 已签，仅作为复审审计线索。本分支以原三张附件、原受管提示重新执行 node49。`] }
  assertA8B6ConflictReviewHop(parent, state, source.result_md5, signed, 'pending')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('serialized review retry differs from prepared checkpoint')
  return { state, proof: { ...marker, newExecutionId: CHILD_ID,
    firstFrameUrl: before[45].output.url,
    evidenceUrl: before[48].output.evidenceUrl,
    reviewImageCount: before[48].output.reviewImages.length,
    providerCalls: 0, databaseWrites: 0, roundTripVerified: true } }
}

function parseArgs(args) {
  const options = { apply: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { options.apply = true; continue }
    const field = { '--plan': 'planId', '--expected-source-md5': 'sourceMd5' }[args[i]]
    if (!field || options[field] !== undefined || !args[i + 1]
      || args[i + 1].startsWith('--')) fail(`invalid argument ${args[i]}`)
    options[field] = args[++i]
  }
  if (options.planId !== PLAN) fail('QA plan ID differs from signed source')
  if (options.sourceMd5 !== undefined && options.sourceMd5 !== SOURCE_MD5)
    fail('source MD5 differs from reviewed rejection')
  if (options.apply && !options.sourceMd5)
    fail('--apply requires exact rejected-source MD5 CAS')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const signed = await verifyA8B6FrameConflictReceipt(options.planId)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [SOURCE_ID])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'${suffix}`)).rows[0]
    if ((await db.query('SELECT 1 FROM execution_records WHERE id=$1',
      [CHILD_ID])).rowCount) fail('new retry record already exists')
    const { state, proof } = prepareA8B6FrameConflictReviewFork(source, workflow, signed)
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `A8B6 首帧同图冲突复审 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1',
        [CHILD_ID])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result))
        !== createJsonHasher()(state)) fail('saved retry differs from prepared checkpoint')
    }
    const sourceAfter = (await db.query(`SELECT md5(result::text) AS md5
      FROM execution_records WHERE id=$1`, [SOURCE_ID])).rows[0]
    if (sourceAfter?.md5 !== SOURCE_MD5) fail('rejected source changed during fork')
    await db.query(options.apply ? 'COMMIT' : 'ROLLBACK')
    console.log(JSON.stringify({ ...proof, applied: options.apply,
      databaseWrites: options.apply ? 1 : 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
