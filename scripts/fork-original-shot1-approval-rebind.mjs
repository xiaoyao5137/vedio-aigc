#!/usr/bin/env node
// Reissue the signed scene-01 first-frame approval in a NEW record before a
// paid video retry. The rejected video remains in its parent and is never
// copied into the new executable suffix. Dry-run is the default.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes, extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { assertSceneCutReviewLedgerRecord } from '../server/scene-cut-frame-runtime.ts'
import { verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { assertSceneCutApprovalRebindHop, assertSceneCutSameMediaReviewHop,
  sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { assertSchema179SameMediaRetryLineage } from './replay-original-second-shot-candidate.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const V8_ID = 'record-4x5m31-original-repair-v8'
const EXPECTED_NODES_MD5 = 'db1556fa6605e179a7a37e52cbbe8135'
const EXPECTED_EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const CUT = 50
const fail = message => { throw Error(`ORIGINAL_SHOT1_APPROVAL_REBIND_INVALID: ${message}`) }
const md5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const recordId = value => typeof value === 'string' && /^record-[\w-]+$/.test(value)
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex')
const generatedBytes = (root, url, extension) => {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url)
    || !extension.test(url)) fail('source media URL is not a local generated file')
  try { return readFileSync(path.join(root, 'public', url)) }
  catch { return fail('source media file is missing') }
}

function parseArguments(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    const field = { '--source': 'sourceId', '--id': 'id',
      '--expected-source-md5': 'sourceMd5', '--expected-nodes-md5': 'nodesMd5',
      '--expected-edges-md5': 'edgesMd5' }[flag]
    if (!field || options[field] !== undefined || !args[index + 1]
      || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[field] = args[++index]
  }
  if (!recordId(options.sourceId) || options.sourceId === ORIGINAL_ID
    || options.sourceId === V8_ID) fail('--source must be a failed descendant of the approved v8 image')
  if (options.id !== undefined && (!recordId(options.id) || options.id === options.sourceId))
    fail('--id must be a NEW record ID')
  for (const key of ['sourceMd5', 'nodesMd5', 'edgesMd5']) {
    if (options[key] !== undefined && !md5(options[key])) fail(`${key} must be a 32-digit MD5`)
  }
  if (options.apply && (!options.id || !options.sourceMd5 || !options.nodesMd5
    || !options.edgesMd5)) fail('--apply requires --id and all three reviewed MD5 hashes')
  return options
}

/** Strictly preserve all approved story/image/review runs, and invalidate the
 * old certificate and every downstream result, including all future loops. */
export function buildSceneCutApprovalRebindRuns(sourceRuns, workflow) {
  if (!Array.isArray(sourceRuns) || sourceRuns.length !== 464
    || sourceRuns.slice(0, CUT).some(run => !['success', 'skipped'].includes(run.status))
    || sourceRuns[CUT]?.node?.id !== 'sanguo-scene-cut-approval')
    fail('source does not have an approved prefix ending before index50')
  const graph = new Map(workflow.nodes.map(node => [node.id, node]))
  if (graph.size !== 72 || workflow.nodes.length !== 72 || workflow.edges.length !== 87
    || sourceRuns.some(run => !graph.has(run.node?.id))) fail('workflow graph is not the approved topology')
  const nodeRuns = refreshPendingExecutionNodes(workflow,
    manualRetryRuns(sourceRuns, CUT))
  if (!isDeepStrictEqual(nodeRuns.slice(0, CUT), sourceRuns.slice(0, CUT))
    || nodeRuns.slice(CUT).some(run => run.status !== 'idle'
      || !isDeepStrictEqual(run.node, graph.get(run.node.id)))
    || nodeRuns[CUT].revision !== (sourceRuns[CUT].revision ?? 0) + 1
    || nodeRuns[CUT].id !== sourceRuns[CUT].id) {
    fail('new queue changed the approved prefix or retained a paid suffix')
  }
  return nodeRuns
}

/** Pure except for read-only bytes supplied by the caller. The marker never
 * treats the rejected video as an approved output. */
export function prepareSceneCutApprovalRebind(source, original, workflow, chain,
  firstFrameReviewLedger, failedVideoReviewLedger, {
    id = 'record-original-shot1-approval-rebind-preview',
    createdAt = '2026-09-29T00:00:00.000Z', root = process.cwd(),
  } = {}) {
  if (!source?.result || !recordId(source.id) || !recordId(id) || id === source.id
    || source.workflow_id !== 'wf-sanguo-history-drama'
    || original?.id !== ORIGINAL_ID || original.result_md5 !== ORIGINAL_MD5
    || !Number.isFinite(Date.parse(createdAt))) fail('source, original, or new identity is invalid')
  if (workflow?.id !== source.workflow_id || workflow.schema_version !== 179
    || workflow.nodes_md5 !== EXPECTED_NODES_MD5
    || workflow.edges_md5 !== EXPECTED_EDGES_MD5) {
    fail('fork requires the exact schema179 managed graph')
  }
  const sourceState = decodeExecutionState(source.result)
  const ancestor = chain?.at(-2)
  const ancestorState = ancestor?.result ? decodeExecutionState(ancestor.result) : undefined
  if (sourceState.id !== source.id || sourceState.parentExecutionId !== ancestor?.id
    || !ancestorState || ancestorState.id !== ancestor.id
    || sourceState.nodeRuns?.some(run => run.status === 'running')
    || !md5(source.result_md5) || !md5(ancestor.result_md5)) {
    fail('source is not a settled direct same-media descendant')
  }
  const ancestry = assertSchema179SameMediaRetryLineage(source, workflow, chain)
  if (ancestry.sameMediaRetryLineage?.length !== 1
    || chain[0]?.id !== V8_ID || ancestor.id !== ancestry.approvalRetryLineage.at(-1)?.id) {
    fail('expected one exact approval-plus-same-media ancestry')
  }
  const runs = sourceState.nodeRuns
  const image = runs[45].output, evidence = runs[48].output
  const review = runs[49].output, oldCertificate = runs[50].output
  const video = runs[52].output, failedReview = runs[58].output
  const failedAccept = runs[59].output
  verifySceneCutFrameApproval(oldCertificate, root)
  const shot = runs[44]?.context?.shot_script
  const sources = runs[41]?.output
  const openingStatePlan = runs[43]?.output
  if (firstFrameReviewLedger?.id !== oldCertificate?.reviewExecutionId
    || assertSceneCutReviewLedgerRecord(firstFrameReviewLedger, review,
      { evidence, shot, sources, openingStatePlan,
        reviewImages: evidence?.reviewImages }, root, 179) !== firstFrameReviewLedger.id) {
    fail('original image review ledger does not match the frozen v8 candidate')
  }
  const failedRequest = failedVideoReviewLedger?.request_data
  const failedParsed = parseStructuredJson(extractTextResponse(failedVideoReviewLedger?.response_data))
  if (failedVideoReviewLedger?.status !== 'succeeded'
    || failedVideoReviewLedger.node_id !== 'sanguo-media-review'
    || failedVideoReviewLedger.workflow_id !== source.workflow_id
    || failedVideoReviewLedger.model_id !== failedReview?.model
    || !String(failedRequest?.requestKey ?? '').startsWith(`${source.id}:`)) {
    fail('failed video review is not an original model ledger result')
  }
  const imageSha = sha256Bytes(generatedBytes(root, image?.url, /\.png$/i))
  const videoSha = sha256Bytes(generatedBytes(root, video?.url, /\.mp4$/i))
  const nodeRuns = buildSceneCutApprovalRebindRuns(runs, workflow)
  const marker = {
    version: 'scene-cut-approval-rebind-v1', sourceExecutionId: source.id,
    sourceResultMd5: source.result_md5,
    sameMediaAncestorExecutionId: ancestor.id,
    sameMediaAncestorResultMd5: ancestor.result_md5,
    originalExecutionId: ORIGINAL_ID, originalResultMd5: ORIGINAL_MD5,
    reviewSourceExecutionId: V8_ID,
    workflowSchemaVersion: 179, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5,
    preservedPrefixLength: CUT, firstPendingNodeId: 'sanguo-scene-cut-approval',
    preservedPrefixSha256: sceneCutRebindSha256(runs.slice(0, CUT)),
    approvedImageUrl: image.url, approvedImageSha256: imageSha,
    imageExecutionId: image.raw?.modelExecutionId,
    repairRequestFingerprint: image.raw?.repairRequestFingerprint,
    reviewExecutionId: oldCertificate.reviewExecutionId,
    reviewOutputSha256: sceneCutRebindSha256(review),
    evidenceOutputSha256: sceneCutRebindSha256(evidence),
    approvedShotSha256: oldCertificate.shotSha256,
    oldApprovalSha256: sceneCutRebindSha256(oldCertificate),
    oldCertificateExecutionId: oldCertificate.repairBinding?.executionId,
    failedVideoUrl: video.url, failedVideoFileSha256: videoSha,
    failedVideoOutputSha256: sceneCutRebindSha256(video),
    failedVideoReviewExecutionId: failedVideoReviewLedger.id,
    failedVideoReviewRequestKey: failedRequest.requestKey,
    failedVideoReviewFingerprint: failedRequest.fingerprint,
    failedReviewOutputSha256: sceneCutRebindSha256(failedReview),
    failedMediaAcceptOutputSha256: sceneCutRebindSha256(failedAccept),
  }
  const completed = nodeRuns.slice(0, CUT)
  const nextState = { ...sourceState, id, parentExecutionId: source.id,
    generationScopeId: id,
    requestScopeId: sourceState.requestScopeId ?? source.id,
    historical: false, mode: 'step', nodeRuns,
    context: completed.at(-1)?.context ?? {},
    selectedNodeId: nodeRuns[CUT].node.id,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutApprovalRebindRecovery: marker,
    logs: [...(Array.isArray(sourceState.logs) ? sourceState.logs : []),
      `已保留 ${source.id} 的失败视频、首帧及独立审核；新分支待重新签发首帧凭证。`],
  }
  assertSceneCutSameMediaReviewHop(ancestorState, sourceState, marker,
    ancestor.result_md5, source.result_md5)
  const active = { ...nextState, nodeRuns: nextState.nodeRuns.map((run, index) => index === CUT
    ? { ...run, status: 'running' } : run) }
  assertSceneCutApprovalRebindHop(sourceState, active, source.result_md5, root, true, {
    id: failedVideoReviewLedger.id, status: failedVideoReviewLedger.status,
    modelId: failedVideoReviewLedger.model_id,
    requestKey: failedRequest.requestKey, fingerprint: failedRequest.fingerprint,
    output: failedParsed,
  })
  const pending = prepareWorkflowRunContext(nodeRuns, CUT)
  if (pending?.run?.node.id !== 'sanguo-scene-cut-approval'
    || !isDeepStrictEqual(pending.inputContext.scene_cut_review, review)
    || !isDeepStrictEqual(pending.inputContext.scene_cut_evidence, evidence)
    || !isDeepStrictEqual(pending.inputContext.first_frame, image)) {
    fail('new approval input context differs from approved image and review')
  }
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(nextState)))))
    !== hash(nextState)) fail('storage round-trip changed the checkpoint')
  return { state: nextState, proof: { ...marker, newExecutionId: id,
    firstPendingIndex: CUT, paidVideoReused: false, providerCalls: 0,
    sourceRunCount: runs.length, newRunCount: nodeRuns.length,
    priorPaidCandidatePreservedInParent: true, roundTripVerified: true } }
}

async function loadChain(db, source, suffix) {
  const chain = [source]
  const seen = new Set([source.id])
  while (chain[0].id !== V8_ID) {
    if (chain.length >= 9) fail('ancestry exceeds eight hops')
    const parentId = decodeExecutionState(chain[0].result).parentExecutionId
    if (!recordId(parentId) || seen.has(parentId)) fail('ancestry is missing or cyclic')
    const row = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [parentId])).rows[0]
    if (!row) fail('ancestry parent is missing')
    chain.unshift(row)
    seen.add(parentId)
  }
  return chain
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const original = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [ORIGINAL_ID])).rows[0]
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [options.sourceId])).rows[0]
    if (!source) fail('source record does not exist')
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${suffix}`,
    [source.workflow_id])).rows[0]
    if (options.sourceMd5 && source.result_md5 !== options.sourceMd5) fail('source MD5 changed')
    if (options.nodesMd5 && workflow?.nodes_md5 !== options.nodesMd5) fail('nodes MD5 changed')
    if (options.edgesMd5 && workflow?.edges_md5 !== options.edgesMd5) fail('edges MD5 changed')
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
      [options.id])).rowCount) fail('new record ID already exists')
    const chain = await loadChain(db, source, suffix)
    const sourceState = decodeExecutionState(source.result)
    const cert = sourceState.nodeRuns?.[CUT]?.output
    const firstFrameReviewLedger = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=$1${suffix}`, [cert?.reviewExecutionId])).rows[0]
    const failedLedger = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama' AND node_id='sanguo-media-review'
      AND status='succeeded' AND request_data->>'requestKey' LIKE $1
      ORDER BY created_at DESC LIMIT 10${suffix}`, [`${source.id}:%`])).rows
      .find(row => parseStructuredJson(extractTextResponse(row.response_data))?.decision === 'revise')
    if (!firstFrameReviewLedger || !failedLedger) fail('source model review ledgers are missing')
    const { state, proof } = prepareSceneCutApprovalRebind(source, original, workflow,
      chain, firstFrameReviewLedger, failedLedger, { id: options.id })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `原首镜视频重拍前首帧重签 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result))
        !== createJsonHasher()(state)) fail('saved fork differs from reviewed checkpoint')
    }
    for (const ancestor of chain) {
      const after = (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [ancestor.id])).rows[0]
      if (after?.md5 !== ancestor.result_md5) fail('ancestor changed during rebind')
    }
    const originalAfter = (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
      [ORIGINAL_ID])).rows[0]
    const workflowAfter = (await db.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [workflow.id])).rows[0]
    if (originalAfter?.md5 !== ORIGINAL_MD5
      || workflowAfter?.schema_version !== workflow.schema_version
      || workflowAfter?.nodes_md5 !== workflow.nodes_md5
      || workflowAfter?.edges_md5 !== workflow.edges_md5) fail('original or workflow changed')
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply,
      databaseWrites: options.apply ? 1 : 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
