#!/usr/bin/env node
/** Freeze the independently approved V8 local first frame and run the
 * schema180 video-reference router in a separate child. No provider call. */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { verifyA8B6LocalWorkflowApprovalV8 } from
  '../server/staged-scene-cut-a8b6-local-approval-v8.mjs'
import { A8B6_LOCAL_V8_FRAME_ID, A8B6_LOCAL_V8_FRAME_VERSION } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const CHILD_ID = 'record-4x5m31-a8b6-local-v8-router-v1'
const fail = reason => { throw Error(`A8B6_LOCAL_V8_ROUTER_FORK_INVALID: ${reason}`) }
const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/

export function prepareA8B6LocalV8RouterFork(sourceRow, workflow, signed) {
  const approval = signed?.approval
  if (sourceRow?.id !== A8B6_LOCAL_V8_FRAME_ID
    || !MD5.test(String(sourceRow.result_md5))
    || sourceRow.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.id !== 'wf-sanguo-history-drama'
    || workflow.schema_version !== 180
    || workflow.nodes_md5 !== A8B6_FRESH_NODES_MD5
    || workflow.edges_md5 !== A8B6_FRESH_EDGES_MD5
    || approval?.version !== 'scene-cut-a8b6-local-workflow-approval-v8'
    || approval.approvalState !== 'approved-local-first-frame-before-A-request'
    || approval.frameProvenanceVariant !== 'a8b6-local-composite-v8'
    || approval.approvalExecutionId !== sourceRow.id
    || approval.approvalResultMd5 !== sourceRow.result_md5
    || !SHA.test(String(approval.planId))
    || !SHA.test(String(signed.approvalSha256)))
    fail('image approval, signed plan or graph changed')
  const parent = decodeExecutionState(sourceRow.result)
  const before = parent.nodeRuns
  if (parent.id !== sourceRow.id
    || parent.generationScopeId !== parent.id
    || !parent.requestScopeId
    || parent.sceneCutA8B6LocalFrameRecovery?.version
      !== A8B6_LOCAL_V8_FRAME_VERSION
    || parent.sceneCutA8B6LocalFrameRecovery.outputUrl
      !== approval.approvedFirstFrameUrl
    || parent.sceneCutA8B6LocalFrameRecovery.outputSha256
      !== approval.approvedFirstFrameSha256
    || !Array.isArray(before) || before.length !== 464
    || before[45]?.status !== 'success'
    || before[45].output?.url !== approval.approvedFirstFrameUrl
    || before[49]?.status !== 'success'
    || before[49].output?.passed !== true
    || !isDeepStrictEqual(before[49].output.issues, [])
    || before[50]?.node?.id !== 'sanguo-scene-cut-approval'
    || before[50].status !== 'success'
    || !isDeepStrictEqual(before[50].output, approval.frameCertificate)
    || before[51]?.node?.id !== 'sanguo-video-reference-router'
    || before.slice(51).some(run => run.status !== 'idle'
      || run.output !== undefined))
    fail('approved first-frame record is not frozen at node50')
  const nodeRuns = refreshPendingExecutionNodes(workflow, before)
  if (!isDeepStrictEqual(nodeRuns.slice(0, 51), before.slice(0, 51))
    || nodeRuns.slice(51).some(run => run.status !== 'idle'
      || run.output !== undefined))
    fail('refresh changed approved image or resumed a later node')
  const next = prepareWorkflowRunContext(nodeRuns, 51)
  if (next?.run?.node?.id !== 'sanguo-video-reference-router'
    || next.inputContext?.scene_cut_frame_gate?.signature
      !== approval.frameCertificate.signature
    || next.inputContext?.first_frame?.url
      !== approval.approvedFirstFrameUrl
    || next.inputContext?.shot_script?.duration !== 14)
    fail('router would not use the newly approved first frame')
  const marker = { version: 'scene-cut-a8b6-fresh-router-v1',
    frameProvenanceVariant: 'a8b6-local-composite-v8',
    imageApprovalExecutionId: parent.id,
    imageApprovalResultMd5: sourceRow.result_md5,
    planId: approval.planId,
    workflowApprovalSha256: signed.approvalSha256,
    workflowSchemaVersion: 180,
    workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5,
    preservedPrefixLength: 51,
    preservedPrefixSha256: sceneCutRebindSha256(before.slice(0, 51)),
    firstPendingIndex: 51,
    firstPendingNodeId: 'sanguo-video-reference-router' }
  const state = { ...parent, id: CHILD_ID, parentExecutionId: parent.id,
    generationScopeId: CHILD_ID, requestScopeId: parent.requestScopeId,
    historical: false, mode: 'step', nodeRuns,
    context: before[50].context,
    selectedNodeId: marker.firstPendingNodeId,
    branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    sceneCutA8B6FreshRouterRecovery: marker,
    logs: [...(Array.isArray(parent.logs) ? parent.logs : []),
      '冻结 V8 独立审核的14秒首镜首帧与签证；本地引用路由在独立子记录继续。'] }
  const hash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state)))))
      !== hash(state)) fail('router checkpoint changed during storage round trip')
  return { state, marker }
}

async function main() {
  const args = process.argv.slice(2)
  const planIndex = args.indexOf('--plan')
  const md5Index = args.indexOf('--expected-image-md5')
  const apply = args.includes('--apply')
  const planId = args[planIndex + 1]
  const expectedMd5 = args[md5Index + 1]
  if (args.length !== (apply ? 5 : 4) || planIndex < 0 || md5Index < 0
    || !SHA.test(String(planId)) || !MD5.test(String(expectedMd5))
    || args.some((arg, index) => index !== planIndex && index !== planIndex + 1
      && index !== md5Index && index !== md5Index + 1
      && arg !== '--apply'))
    fail('usage: --plan SHA --expected-image-md5 MD5 [--apply]')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const signed = await verifyA8B6LocalWorkflowApprovalV8(planId, root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = apply ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1${suffix}`,
    [A8B6_LOCAL_V8_FRAME_ID])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'${suffix}`)).rows[0]
    if (source?.result_md5 !== expectedMd5
      || (await db.query('SELECT 1 FROM execution_records WHERE id=$1',
        [CHILD_ID])).rowCount) fail('image CAS changed or router child already exists')
    const { state, marker } = prepareA8B6LocalV8RouterFork(source,
      workflow, signed)
    if (apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,
          succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `首镜14秒已审首帧引用路由 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1',
        [state.id])).rows[0]
      if (createJsonHasher()(decodeExecutionState(saved?.result))
        !== createJsonHasher()(state)) fail('saved router state differs')
    }
    const current = (await db.query(`SELECT md5(result::text) AS md5
      FROM execution_records WHERE id=$1`, [source.id])).rows[0]
    if (current?.md5 !== source.result_md5) fail('approved image source changed')
    await db.query(apply ? 'COMMIT' : 'ROLLBACK')
    console.log(JSON.stringify({ id: state.id, parent: source.id,
      parentResultMd5: source.result_md5, planId,
      workflowApprovalSha256: marker.workflowApprovalSha256,
      preservedPrefixLength: marker.preservedPrefixLength,
      firstPendingIndex: marker.firstPendingIndex,
      databaseWrites: apply ? 1 : 0, providerCalls: 0,
      applied: apply }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error
    ? error.message : String(error)); process.exitCode = 1 })
