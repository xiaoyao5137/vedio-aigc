#!/usr/bin/env node
/** Source-bound 14-second storyboard amendment. A new record starts at the
 * original scene-01 script reviewer (index 10); no image/video provider is
 * called here and no old acceptance is copied into the executable suffix. */
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { applyNodeOutputToContext, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { buildA8B6TimingAmendment } from '../server/staged-scene-cut-a8b6-approval.mjs'
import { readA8B6QAPlan } from '../server/staged-scene-cut-a8b6-qa.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const SOURCE_ID = 'record-4x5m31-original-repair-tail-guide-v2'
const SOURCE_MD5 = '34abee4a7c010616b837dbc175b69c56'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const SHOT_SHA = 'cd192f86b554192ef9be23a3f34cb8e643fd6e1aa11144a7e5aa675c832947d7'
const SHA = /^[a-f0-9]{64}$/
const fail = message => { throw Error(`A8B6_TIMING_FORK_INVALID: ${message}`) }

export function prepareA8B6TimingFork(source, workflow, qaManifest, {
  id = 'record-4x5m31-a8b6-timing-approval-v1', root = process.cwd(),
} = {}) {
  if (source?.id !== SOURCE_ID || source.result_md5 !== SOURCE_MD5
    || source.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.id !== source.workflow_id || workflow.schema_version !== 180
    || workflow.nodes_md5 !== NODES_MD5 || workflow.edges_md5 !== EDGES_MD5
    || !Array.isArray(workflow.nodes) || workflow.nodes.length !== 72
    || !Array.isArray(workflow.edges) || workflow.edges.length !== 87
    || !/^record-[\w-]+$/.test(id) || id === source.id
    || qaManifest?.version !== 'staged-scene-cut-a8b6-qa-v1'
    || !SHA.test(String(qaManifest.planId))
    || qaManifest.source?.recordId !== SOURCE_ID
    || qaManifest.source?.resultMd5 !== SOURCE_MD5
    || qaManifest.source?.approvedShotSha256 !== SHOT_SHA
    || qaManifest.picture?.frameCount !== 337 || qaManifest.picture?.fps !== 24
    || qaManifest.narration?.mixerVersion !== 6
    || qaManifest.narration?.fullSourceMute !== true)
    fail('source, schema180 graph or signed QA provenance changed')
  const parent = decodeExecutionState(source.result)
  const before = parent.nodeRuns
  if (parent.id !== source.id || parent.generationScopeId !== source.id
    || before?.length !== 464 || before.some(run => run.status === 'running')
    || before.slice(0, 9).some(run => !['success', 'skipped'].includes(run.status))
    || before[9]?.node?.id !== 'sanguo-shot-script'
    || before[10]?.node?.id !== 'sanguo-shot-script-review'
    || before[11]?.node?.id !== 'sanguo-shot-script-accept'
    || before[10]?.output?.decision !== 'pass'
    || before[11]?.output?.passed !== true
    || before[50]?.node?.id !== 'sanguo-scene-cut-approval'
    || sceneCutShotSha256(before[11].output) !== SHOT_SHA
    || before[50]?.output?.shotSha256 !== SHOT_SHA)
    fail('parent is not the settled original 13-second approved source')
  verifySceneCutFrameApproval(before[50].output, root)
  if (qaManifest.source.approvalSha256 !== sceneCutRebindSha256(before[50].output))
    fail('A8+B6 QA does not bind the exact original frame approval')
  const scene = before[9].inputContext?.scene
  const proposal = buildA8B6TimingAmendment(before[11].output, scene)
  const first = prepareWorkflowRunContext(before, 9)
  if (first?.run?.node.id !== 'sanguo-shot-script'
    || !isDeepStrictEqual(first.inputContext.scene, scene))
    fail('source storyboard input context changed')
  const candidate = proposal.amendedShot
  const candidateContext = applyNodeOutputToContext(first.inputContext,
    before[9].node.resultVar, candidate)
  const selected = { ...before[9], status: 'success', output: candidate,
    context: candidateContext, inputContext: first.inputContext,
    inputs: { ...before[9].inputs,
      sourceBoundTimingAmendment: { qaPlanId: qaManifest.planId,
        sourceShotSha256: SHOT_SHA, candidateShotSha256: proposal.candidateShotSha256 } },
    routeInputOverrides: undefined,
    revision: Number(before[9].revision ?? 0) + 1,
    startedAt: undefined, durationMs: 0 }
  const replaced = before.map((run, index) => index === 9 ? selected : run)
  const nodeRuns = refreshPendingExecutionNodes(workflow,
    manualRetryRuns(replaced, 10))
  if (!isDeepStrictEqual(nodeRuns.slice(0, 9), before.slice(0, 9))
    || nodeRuns[9].output !== candidate
    || nodeRuns.slice(10).some(run => run.status !== 'idle'
      || run.output !== undefined || Object.keys(run.context ?? {}).length !== 0)
    || nodeRuns.findIndex(run => run.status === 'idle') !== 10)
    fail('timing fork changed the approved upstream prefix or kept stale reviews')
  const next = prepareWorkflowRunContext(nodeRuns, 10)
  if (next?.run?.node.id !== 'sanguo-shot-script-review'
    || !isDeepStrictEqual(next.inputContext.shot_candidate, candidate)
    || next.inputContext.shot_script !== undefined)
    fail('new script review is not bound to the amended candidate')
  const marker = { version: 'scene-cut-a8b6-timing-fork-v1',
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    qaPlanId: qaManifest.planId,
    workflowSchemaVersion: 180, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5,
    preservedPrefixLength: 9,
    preservedPrefixSha256: sceneCutRebindSha256(before.slice(0, 9)),
    originalApprovedShotSha256: SHOT_SHA,
    originalFrameCertificateSha256: sceneCutRebindSha256(before[50].output),
    candidateShotSha256: proposal.candidateShotSha256,
    amendedScheduleHash: proposal.amendedScheduleHash,
    firstPendingIndex: 10, firstPendingNodeId: 'sanguo-shot-script-review' }
  const state = { ...parent, id, parentExecutionId: source.id,
    generationScopeId: id, requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns, context: candidateContext,
    selectedNodeId: nodeRuns[10].node.id,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutA8B6TimingRecovery: marker,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      '保留旧13秒首镜及付费片；另立14秒分镜候选，等待独立脚本、首帧与整片审核。'] }
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
    !== hash(state)) fail('checkpoint storage round trip changed the amended candidate')
  return { state, proposal, proof: { ...marker, newExecutionId: id,
    providerCalls: 0, databaseWrites: 0, candidateApproved: false,
    firstShotAccepted: false, preservedPaidMedia: true, roundTripVerified: true } }
}

function parseArgs(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') {
      if (options.apply) fail('duplicate --apply')
      options.apply = true
      continue
    }
    const field = { '--plan': 'planId', '--id': 'id',
      '--expected-source-md5': 'sourceMd5',
      '--expected-nodes-md5': 'nodesMd5',
      '--expected-edges-md5': 'edgesMd5' }[args[index]]
    if (!field || options[field] !== undefined || !args[index + 1]
      || args[index + 1].startsWith('--'))
      fail(`unknown, duplicate or incomplete argument ${args[index]}`)
    options[field] = args[++index]
  }
  if (!SHA.test(String(options.planId))) fail('--plan must be the signed QA plan ID')
  if (options.id !== undefined && (!/^record-[\w-]+$/.test(options.id)
    || options.id === SOURCE_ID)) fail('--id must be a new record ID')
  if (options.sourceMd5 !== undefined && options.sourceMd5 !== SOURCE_MD5)
    fail('source MD5 lock differs from reviewed record')
  if (options.nodesMd5 !== undefined && options.nodesMd5 !== NODES_MD5)
    fail('nodes MD5 lock differs from schema180')
  if (options.edgesMd5 !== undefined && options.edgesMd5 !== EDGES_MD5)
    fail('edges MD5 lock differs from schema180')
  if (options.apply && (!options.id || !options.sourceMd5
    || !options.nodesMd5 || !options.edgesMd5))
    fail('--apply requires new ID and source/graph MD5 locks')
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
    const source = (await db.query(`SELECT *, md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`, [SOURCE_ID])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${suffix}`,
    [source?.workflow_id])).rows[0]
    if (source?.result_md5 !== SOURCE_MD5
      || workflow?.nodes_md5 !== NODES_MD5 || workflow.edges_md5 !== EDGES_MD5)
      fail('source record or workflow graph changed')
    if (options.id && (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
      [options.id])).rowCount) fail('new record ID already exists')
    const { state, proof } = prepareA8B6TimingFork(source, workflow,
      qaManifest, { id: options.id })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `首镜14秒时序修订 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1',
        [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result))
        !== createJsonHasher()(state)) fail('saved timing fork differs from reviewed checkpoint')
    }
    const unchanged = (await db.query(`SELECT md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1`, [SOURCE_ID])).rows[0]
    if (unchanged?.result_md5 !== SOURCE_MD5)
      fail('source record changed during timing fork')
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply,
      databaseWrites: options.apply ? 1 : 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
