#!/usr/bin/env node
// Preserve the approved scene-01 image and both rejected paid videos. Reissue
// index50 approval in a new record and pin index52's end_frame route to the
// first rejected video's independently sampled native last frame. Dry-run by default.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { assertSceneCutApprovalRebindHop, assertSceneCutSameMediaReviewHop,
  sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { assertSceneCutTailGuideRebindHop } from '../server/scene-cut-tail-guide-rebind.ts'
import { buildSceneCutApprovalRebindRuns } from './fork-original-shot1-approval-rebind.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const SOURCE_ID = 'record-4x5m31-original-repair-video-rebind-v1'
const NATIVE_ID = 'record-levw1e'
const REVIEW_ID = 'record-9p80o5'
const WORKFLOW_ID = 'wf-sanguo-history-drama'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const CUT = 50
const fail = message => { throw Error(`ORIGINAL_SHOT1_TAIL_GUIDE_REBIND_INVALID: ${message}`) }
const md5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const recordId = value => typeof value === 'string' && /^record-[\w-]+$/.test(value)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function bytesFor(root, url, extension) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url)
    || !extension.test(url)) fail('media URL is not an archived generated file')
  try { return readFileSync(path.join(root, 'public', url)) }
  catch { return fail('media source file is missing') }
}
function parseArgs(args) {
  const result = { apply: false }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--apply') { if (result.apply) fail('duplicate --apply'); result.apply = true; continue }
    const key = { '--source': 'sourceId', '--id': 'id',
      '--expected-source-md5': 'sourceMd5', '--expected-nodes-md5': 'nodesMd5',
      '--expected-edges-md5': 'edgesMd5' }[flag]
    if (!key || result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--'))
      fail(`unknown, duplicate or incomplete argument ${flag}`)
    result[key] = args[++i]
  }
  if (result.sourceId !== SOURCE_ID) fail('--source must be the reviewed second paid candidate')
  if (result.id !== undefined && (!recordId(result.id) || result.id === SOURCE_ID))
    fail('--id must be a new record ID')
  for (const key of ['sourceMd5', 'nodesMd5', 'edgesMd5'])
    if (result[key] !== undefined && !md5(result[key])) fail(`${key} must be an MD5`)
  if (result.apply && (!result.id || !result.sourceMd5 || !result.nodesMd5 || !result.edgesMd5))
    fail('--apply requires a new ID and all three reviewed MD5 locks')
  return result
}
const ledgerProof = row => {
  const parsed = parseStructuredJson(extractTextResponse(row?.response_data))
  return { id: row?.id, status: row?.status, modelId: row?.model_id,
    requestKey: row?.request_data?.requestKey,
    fingerprint: row?.request_data?.fingerprint, output: parsed }
}

/** No media or model work occurs here. This function builds only a checkpoint. */
export function prepareSceneCutTailGuideRebind({ original, source, native, reviewed,
  workflow, sourceReviewLedger, nativeReviewLedger, id = 'record-original-shot1-tail-guide-preview',
  root = process.cwd() }) {
  if (original?.id !== ORIGINAL_ID || original.result_md5 !== ORIGINAL_MD5
    || source?.id !== SOURCE_ID || native?.id !== NATIVE_ID || reviewed?.id !== REVIEW_ID
    || !recordId(id) || id === source.id
    || source.workflow_id !== WORKFLOW_ID
    || workflow?.id !== WORKFLOW_ID || workflow.schema_version !== 180
    || workflow.nodes_md5 !== NODES_MD5 || workflow.edges_md5 !== EDGES_MD5)
    fail('source, original, or schema180 graph is not the reviewed one')
  const current = decodeExecutionState(source.result)
  const nativeState = decodeExecutionState(native.result)
  const reviewedState = decodeExecutionState(reviewed.result)
  const nativeRuns = nativeState.nodeRuns, reviewedRuns = reviewedState.nodeRuns
  const sourceRuns = current.nodeRuns
  if (current.id !== source.id || nativeState.id !== native.id || reviewedState.id !== reviewed.id
    || current.parentExecutionId !== reviewed.id
    || reviewedState.parentExecutionId !== native.id
    || current.nodeRuns.some(run => run.status === 'running')
    || !md5(source.result_md5) || !md5(native.result_md5) || !md5(reviewed.result_md5))
    fail('source lineage or settled state changed')
  const oldMarker = current.sceneCutApprovalRebindRecovery
  verifySceneCutFrameApproval(sourceRuns[50].output, root)
  assertSceneCutSameMediaReviewHop(nativeState, reviewedState, oldMarker,
    native.result_md5, reviewed.result_md5)
  assertSceneCutApprovalRebindHop(reviewedState, current, reviewed.result_md5,
    root, false, ledgerProof(nativeReviewLedger))
  const nativeEvidence = nativeRuns[54].output
  const tailUrl = nativeEvidence?.lastFrameUrl
  const evidenceUrl = nativeEvidence?.evidenceUrl
  const nodeRuns = buildSceneCutApprovalRebindRuns(sourceRuns, workflow)
  nodeRuns[52] = { ...nodeRuns[52], routeInputOverrides: {
    end_frame: { url: tailUrl, sha256: sha256(bytesFor(root, tailUrl, /\.jpe?g$/i)) } } }
  const marker = {
    version: 'scene-cut-approval-rebind-v2',
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    nativeSourceExecutionId: native.id, nativeSourceResultMd5: native.result_md5,
    nativeReviewExecutionId: reviewed.id, nativeReviewResultMd5: reviewed.result_md5,
    originalExecutionId: ORIGINAL_ID, originalResultMd5: ORIGINAL_MD5,
    reviewSourceExecutionId: 'record-4x5m31-original-repair-v8',
    workflowSchemaVersion: 180, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5,
    preservedPrefixLength: CUT, firstPendingNodeId: 'sanguo-scene-cut-approval',
    preservedPrefixSha256: sceneCutRebindSha256(sourceRuns.slice(0, CUT)),
    approvedImageUrl: sourceRuns[45].output.url,
    approvedImageSha256: sha256(bytesFor(root, sourceRuns[45].output.url, /\.png$/i)),
    imageExecutionId: sourceRuns[45].output.raw?.modelExecutionId,
    repairRequestFingerprint: sourceRuns[45].output.raw?.repairRequestFingerprint,
    reviewExecutionId: sourceRuns[50].output.reviewExecutionId,
    reviewOutputSha256: sceneCutRebindSha256(sourceRuns[49].output),
    evidenceOutputSha256: sceneCutRebindSha256(sourceRuns[48].output),
    approvedShotSha256: sourceRuns[50].output.shotSha256,
    oldApprovalSha256: sceneCutRebindSha256(sourceRuns[50].output),
    oldCertificateExecutionId: sourceRuns[50].output.repairBinding?.executionId,
    failedVideoUrl: sourceRuns[52].output.url,
    failedVideoFileSha256: sha256(bytesFor(root, sourceRuns[52].output.url, /\.mp4$/i)),
    failedVideoOutputSha256: sceneCutRebindSha256(sourceRuns[52].output),
    failedReviewOutputSha256: sceneCutRebindSha256(sourceRuns[58].output),
    failedMediaAcceptOutputSha256: sceneCutRebindSha256(sourceRuns[59].output),
    failedVideoReviewExecutionId: sourceReviewLedger.id,
    failedVideoReviewRequestKey: sourceReviewLedger.request_data?.requestKey,
    failedVideoReviewFingerprint: sourceReviewLedger.request_data?.fingerprint,
    nativeReviewOutputSha256: sceneCutRebindSha256(reviewedRuns[58].output),
    nativeEvidenceOutputSha256: sceneCutRebindSha256(nativeEvidence),
    nativeVideoReviewExecutionId: nativeReviewLedger.id,
    nativeVideoReviewRequestKey: nativeReviewLedger.request_data?.requestKey,
    nativeVideoReviewFingerprint: nativeReviewLedger.request_data?.fingerprint,
    tailGuide: {
      sourceExecutionId: native.id,
      reviewExecutionId: reviewed.id,
      sourceVideoUrl: nativeEvidence.originalUrl,
      evidenceVideoUrl: nativeEvidence.url,
      evidenceUrl,
      videoFileSha256: nativeEvidence.sha256,
      evidenceFileSha256: sha256(bytesFor(root, evidenceUrl, /\.json$/i)),
      url: tailUrl,
      fileSha256: sha256(bytesFor(root, tailUrl, /\.jpe?g$/i)),
    },
  }
  const state = { ...current, id, parentExecutionId: source.id,
    generationScopeId: id, requestScopeId: current.requestScopeId,
    historical: false, mode: 'step', nodeRuns,
    context: nodeRuns[CUT - 1].context ?? {},
    selectedNodeId: nodeRuns[CUT].node.id,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutApprovalRebindRecovery: marker,
    logs: [...(Array.isArray(current.logs) ? current.logs : []),
      `已保留 ${source.id} 的失败视频；新分支以 ${native.id} 的原生末帧作为未获批目标参考。`],
  }
  const witness = { nativeSource: { state: nativeState, resultMd5: native.result_md5 },
    nativeReview: { state: reviewedState, resultMd5: reviewed.result_md5 },
    nativeReviewLedger: ledgerProof(nativeReviewLedger),
    currentReviewLedger: ledgerProof(sourceReviewLedger) }
  assertSceneCutTailGuideRebindHop(current, state, source.result_md5, witness,
    root, 'preview')
  const active = { ...state, nodeRuns: nodeRuns.map((run, index) => index === CUT
    ? { ...run, status: 'running' } : run) }
  assertSceneCutTailGuideRebindHop(current, active, source.result_md5, witness,
    root, 'approval')
  const approvalContext = prepareWorkflowRunContext(nodeRuns, CUT)
  const videoContext = prepareWorkflowRunContext(nodeRuns, 52)
  if (approvalContext?.run?.node.id !== 'sanguo-scene-cut-approval'
    || !isDeepStrictEqual(approvalContext.inputContext.first_frame, sourceRuns[45].output)
    || videoContext?.run?.node.id !== 'sanguo-video'
    || videoContext.inputContext.end_frame?.url !== tailUrl
    || videoContext.inputContext.end_frame?.sha256 !== marker.tailGuide.fileSha256)
    fail('end_frame route or original approval context did not survive checkpoint rebuild')
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('storage round-trip changed the checkpoint')
  return { state, proof: { ...marker, newExecutionId: id,
    firstPendingIndex: CUT, paidVideoReused: false, providerCalls: 0,
    priorPaidCandidatesPreservedInParents: true, roundTripVerified: true,
    manualReviewIsNotAcceptance: true } }
}

async function row(db, id, suffix) {
  return (await db.query(`SELECT *,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1${suffix}`, [id])).rows[0]
}
async function reviewLedger(db, executionId, suffix) {
  const rows = (await db.query(`SELECT * FROM model_execution_records
    WHERE workflow_id=$1 AND node_id='sanguo-media-review' AND status='succeeded'
    AND request_data->>'requestKey' LIKE $2
    ORDER BY created_at DESC LIMIT 12${suffix}`, [WORKFLOW_ID, `${executionId}:%`])).rows
  const result = rows.filter(item => parseStructuredJson(extractTextResponse(item.response_data))?.decision === 'revise')
  if (result.length !== 1) fail('independent failed-review ledger is missing or ambiguous')
  return result[0]
}
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const original = await row(db, ORIGINAL_ID, suffix)
    const source = await row(db, SOURCE_ID, suffix)
    const native = await row(db, NATIVE_ID, suffix)
    const reviewed = await row(db, REVIEW_ID, suffix)
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${suffix}`,
    [WORKFLOW_ID])).rows[0]
    if (!source || !native || !reviewed || !workflow) fail('source or workflow is missing')
    if (options.sourceMd5 && source.result_md5 !== options.sourceMd5) fail('source MD5 changed')
    if (options.nodesMd5 && workflow.nodes_md5 !== options.nodesMd5) fail('nodes MD5 changed')
    if (options.edgesMd5 && workflow.edges_md5 !== options.edgesMd5) fail('edges MD5 changed')
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
      [options.id])).rowCount) fail('new record ID already exists')
    const sourceReviewLedger = await reviewLedger(db, SOURCE_ID, suffix)
    const nativeReviewLedger = await reviewLedger(db, REVIEW_ID, suffix)
    const { state, proof } = prepareSceneCutTailGuideRebind({ original, source, native,
      reviewed, workflow, sourceReviewLedger, nativeReviewLedger, id: options.id })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `原首镜尾帧引导重签 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = await row(db, state.id, '')
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result))
        !== createJsonHasher()(state)) fail('saved fork differs from reviewed checkpoint')
    }
    for (const item of [original, source, native, reviewed]) {
      const after = await row(db, item.id, '')
      if (after?.result_md5 !== item.result_md5) fail('source record changed during dry-run')
    }
    const afterGraph = (await db.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [WORKFLOW_ID])).rows[0]
    if (afterGraph?.schema_version !== workflow.schema_version
      || afterGraph?.nodes_md5 !== workflow.nodes_md5
      || afterGraph?.edges_md5 !== workflow.edges_md5) fail('workflow changed during dry-run')
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply,
      databaseWrites: options.apply ? 1 : 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
