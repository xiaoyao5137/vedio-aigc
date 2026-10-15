#!/usr/bin/env node
/** Re-review the original paid t=0 still against the approved 14s first shot.
 * The failed 14s image attempt and the original paid request remain immutable. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { readA8B6QAPlan } from '../server/staged-scene-cut-a8b6-qa.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const SOURCE_ID = 'record-4x5m31-original-repair-tail-guide-v2'
const SOURCE_MD5 = '34abee4a7c010616b837dbc175b69c56'
const TIMING_ID = 'record-4x5m31-a8b6-timing-approval-v3'
const TIMING_MD5 = '7024e0652a9fd878ef00a5a2dcec99f8'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const IMAGE_SHA = '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
const SHA = /^[a-f0-9]{64}$/
const fail = message => { throw Error(`A8B6_IMAGE_REUSE_INVALID: ${message}`) }
const same = isDeepStrictEqual
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')

export function prepareA8B6ImageReuseFork(source, timing, workflow, qaManifest, {
  id = 'record-4x5m31-a8b6-frame-reuse-v3', root = process.cwd(),
} = {}) {
  if (source?.id !== SOURCE_ID || source.result_md5 !== SOURCE_MD5
    || timing?.id !== TIMING_ID || timing.result_md5 !== TIMING_MD5
    || timing.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.id !== timing.workflow_id || workflow.schema_version !== 180
    || workflow.nodes_md5 !== NODES_MD5 || workflow.edges_md5 !== EDGES_MD5
    || qaManifest?.version !== 'staged-scene-cut-a8b6-qa-v1'
    || !SHA.test(String(qaManifest.planId))
    || qaManifest.source?.recordId !== SOURCE_ID
    || qaManifest.source?.resultMd5 !== SOURCE_MD5
    || !/^record-[\w-]+$/.test(id) || [SOURCE_ID, TIMING_ID].includes(id))
    fail('source, timing parent, graph or QA plan changed')
  const original = decodeExecutionState(source.result)
  const parent = decodeExecutionState(timing.result)
  const sourceRuns = original.nodeRuns, before = parent.nodeRuns
  const originalCert = sourceRuns?.[50]?.output
  const signed = verifySceneCutFrameApproval(originalCert, root)
  const originalImage = sourceRuns?.[45]?.output
  const imageUrl = originalImage?.url
  if (original.id !== SOURCE_ID || parent.id !== TIMING_ID
    || parent.parentExecutionId !== SOURCE_ID
    || parent.sceneCutA8B6TimingRecovery?.qaPlanId !== qaManifest.planId
    || parent.sceneCutA8B6TimingRecovery?.sourceResultMd5 !== SOURCE_MD5
    || !Array.isArray(before) || before.length !== 464
    || before.some(run => run.status === 'running')
    || before.slice(0, 45).some(run => !['success', 'skipped'].includes(run.status))
    || before[10]?.output?.decision !== 'pass'
    || before[11]?.output?.passed !== true
    || before[11]?.output?.duration !== 14
    || before[43]?.output?.scheduleHash !== before[11].output.scheduleHash
    || before[45]?.status !== 'failed'
    || !String(before[45].error ?? '').includes('SCENE_CUT_EDIT_BINDER_INVALID')
    || before.slice(46).some(run => run.status !== 'idle')
    || signed.passed !== true
    || signed.frame?.sourceUrl !== imageUrl
    || signed.sourceSha256s?.[0] !== IMAGE_SHA
    || sourceRuns[45]?.status !== 'success'
    || originalImage?.raw?.modelExecutionId !== signed.repairBinding?.imageExecutionId
    || originalImage?.raw?.repairRequestFingerprint !== signed.repairBinding?.repairRequestFingerprint
    || qaManifest.source?.approvalSha256 !== sceneCutRebindSha256(originalCert))
    fail('14s review or original signed first image is not the exact approved source')
  if (typeof imageUrl !== 'string' || !/^\/generated\/image-[a-f0-9]{32}\.png$/.test(imageUrl)
    || hashBytes(readFileSync(path.join(root, 'public', imageUrl.slice(1)))) !== IMAGE_SHA)
    fail('original paid first-frame PNG changed')
  const prepared = prepareWorkflowRunContext(before, 45)
  const ctx = prepared?.inputContext
  if (prepared?.run?.node.id !== 'sanguo-scene-cut-first-frame'
    || sceneCutShotSha256(ctx?.shot_script) !== sceneCutShotSha256(before[11].output)
    || !same(ctx?.scene_cut_sources, before[41].output)
    || !same(ctx?.scene_cut_opening_state, before[43].output)
    || ctx?.first_frame !== undefined)
    fail('new image review context is not the approved 14s script and opening')
  const hash = createJsonHasher()
  const marker = {
    version: 'scene-cut-a8b6-image-reuse-v1',
    sourceExecutionId: SOURCE_ID, sourceResultMd5: SOURCE_MD5,
    parentExecutionId: TIMING_ID, parentResultMd5: TIMING_MD5,
    qaPlanId: qaManifest.planId,
    workflowSchemaVersion: 180, workflowNodesMd5: NODES_MD5,
    workflowEdgesMd5: EDGES_MD5,
    originalFrameCertificateSha256: sceneCutRebindSha256(originalCert),
    originalImageExecutionId: signed.repairBinding.imageExecutionId,
    originalImageUrl: imageUrl, originalImageSha256: IMAGE_SHA,
    originalImageOutputSha256: hash(originalImage),
    amendedShotSha256: sceneCutShotSha256(before[11].output),
    amendedScheduleHash: before[11].output.scheduleHash,
    sourceArchiveSha256: hash(before[41].output),
    openingPlanSha256: hash(before[43].output),
    preservedPrefixLength: 45,
    preservedPrefixSha256: hash(before.slice(0, 45)),
    firstPendingIndex: 46, firstPendingNodeId: before[46].node.id,
  }
  // The old params and raw ledger remain the *actual* paid request. The new
  // review binding is explicit metadata, never represented as a new purchase.
  const output = { ...originalImage, sourceBoundImageReuse: {
    ...marker, reviewShotSha256: marker.amendedShotSha256 } }
  const context = applyNodeOutputToContext(ctx, before[45].node.resultVar, output)
  const selected = { ...before[45], status: 'success', output, context,
    inputContext: ctx, inputs: { ...originalImage.params,
      sourceBoundImageReuse: marker },
    routeInputOverrides: undefined, error: undefined,
    startedAt: undefined, durationMs: 0,
    revision: Number(before[45].revision ?? 0) + 1 }
  const replaced = before.map((run, index) => index === 45 ? selected : run)
  const nodeRuns = refreshPendingExecutionNodes(workflow, manualRetryRuns(replaced, 46))
  if (!same(nodeRuns.slice(0, 45), before.slice(0, 45))
    || nodeRuns[45].output !== output
    || nodeRuns.slice(46).some(run => run.status !== 'idle'
      || run.output !== undefined || Object.keys(run.context ?? {}).length !== 0)
    || nodeRuns.findIndex(run => run.status === 'idle') !== 46)
    fail('image reuse altered the approved prefix or retained stale image review')
  const next = prepareWorkflowRunContext(nodeRuns, 46)
  if (next?.inputContext.first_frame?.url !== imageUrl
    || sceneCutShotSha256(next.inputContext.shot_script) !== marker.amendedShotSha256)
    fail('next node does not read original still under new 14s shot')
  const state = { ...parent, id, parentExecutionId: TIMING_ID,
    generationScopeId: id, requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns, context,
    selectedNodeId: nodeRuns[46].node.id,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutA8B6ImageReuseRecovery: marker,
    // Old repair marker described the old purchase, not this new review.
    priorSceneCutImageRepairRecovery: parent.sceneCutImageRepairRecovery,
    priorSceneCutApprovalRebindRecovery: parent.sceneCutApprovalRebindRecovery,
    sceneCutImageRepairRecovery: undefined,
    sceneCutApprovalRebindRecovery: undefined,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      `保留 ${TIMING_ID} node45 阻断与原付费首帧；本分支复用同一 PNG，重做 14 秒脚本的独立图像审核。`] }
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('execution storage round trip changed the image reuse checkpoint')
  return { state, proof: { ...marker, newExecutionId: id,
    providerCalls: 0, databaseWrites: 0, originalPaidImagePreserved: true,
    imageReviewPending: true, roundTripVerified: true } }
}

function parseArgs(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') { options.apply = true; continue }
    const field = { '--plan': 'planId', '--id': 'id',
      '--expected-parent-md5': 'parentMd5' }[args[index]]
    if (!field || options[field] !== undefined || !args[index + 1]
      || args[index + 1].startsWith('--')) fail(`invalid argument ${args[index]}`)
    options[field] = args[++index]
  }
  if (!SHA.test(String(options.planId))) fail('--plan must be a signed QA plan ID')
  if (options.parentMd5 !== undefined && options.parentMd5 !== TIMING_MD5)
    fail('parent MD5 differs from reviewed failed checkpoint')
  if (options.apply && (!options.id || !options.parentMd5))
    fail('--apply requires a new ID and expected parent MD5')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const qaManifest = await readA8B6QAPlan(options.planId)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const read = async id => (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [id])).rows[0]
    const source = await read(SOURCE_ID), timing = await read(TIMING_ID)
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${suffix}`,
    [timing?.workflow_id])).rows[0]
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
      [options.id])).rowCount) fail('new record ID already exists')
    const { state, proof } = prepareA8B6ImageReuseFork(source, timing, workflow,
      qaManifest, { id: options.id })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, timing.workflow_id, timing.workflow_name,
        `首镜14秒首帧复用重审 · ${timing.id}`,
        JSON.stringify(timing.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = await read(state.id)
      if (createJsonHasher()(decodeExecutionState(saved.result))
        !== createJsonHasher()(state)) fail('saved child differs from reviewed checkpoint')
    }
    if ((await read(SOURCE_ID)).result_md5 !== SOURCE_MD5
      || (await read(TIMING_ID)).result_md5 !== TIMING_MD5)
      fail('source or failed timing parent changed during fork')
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
