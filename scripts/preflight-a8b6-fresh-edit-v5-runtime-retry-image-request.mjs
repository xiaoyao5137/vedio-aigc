#!/usr/bin/env node
/** Reconstruct the v5 runtime-retry browser request and prove the signed
 * third reference reaches the paid-image validator without provider/DB writes. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { hasExecutionPlanMismatch, refreshPendingExecutionNodes } from
  '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from
  '../src/workflow-template.ts'
import { A8B6_FRESH_V5_RUNTIME_RETRY_ID,
  A8B6_FRESH_V5_EDIT_FRAME_VERSION } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { validateSceneCutPaidImageRequest } from
  '../server/scene-cut-frame-runtime.ts'
import { bindA8B6FreshV5EditReference,
  verifyA8B6FreshV5EditReceipt } from '../server/staged-scene-cut-a8b6-fresh-edit-v5.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_V5_RETRY_PREFLIGHT_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const pathValue = (context, key) => key.split('.').reduce((value, part) =>
  value && typeof value === 'object' ? value[part] : undefined, context)
const paramValue = (param, context) => {
  const match = param.value.trim().match(/^\$\{([^}]+)\}$/)
  if (match) return pathValue(context, match[1].trim())
  if (param.type === 'json') {
    const json = JSON.parse(param.value)
    return resolveTemplateJsonValue(json, context)
  }
  const value = renderWorkflowTemplate(param.value, context)
  return param.type === 'number' ? Number(value)
    : param.type === 'boolean' ? value === 'true' : value
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('BEGIN READ ONLY')
  const row = (await db.query(`SELECT result,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1`, [A8B6_FRESH_V5_RUNTIME_RETRY_ID])).rows[0]
  const graph = (await db.query(`SELECT id,schema_version,nodes,edges,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
  if (!row || graph?.schema_version !== 180) fail('fresh record or graph missing')
  const state = decodeExecutionState(row.result)
  const marker = state.sceneCutA8B6FreshFrameRecovery
  if (marker?.version !== A8B6_FRESH_V5_EDIT_FRAME_VERSION
    || state.nodeRuns[45]?.status !== 'idle'
    || marker.workflowNodesMd5 !== graph.nodes_md5
    || marker.workflowEdgesMd5 !== graph.edges_md5)
    fail('source-bound checkpoint is no longer pending')
  const workflow = { id: graph.id, nodes: graph.nodes, edges: graph.edges }
  const refreshed = refreshPendingExecutionNodes(workflow, state.nodeRuns)
  if (hasExecutionPlanMismatch(workflow, refreshed)
    || refreshed[45].node.prompt !== state.nodeRuns[45].node.prompt
    || refreshed[49].node.prompt !== state.nodeRuns[49].node.prompt
    || JSON.stringify(refreshed[45].node.params)
      !== JSON.stringify(state.nodeRuns[45].node.params)
    || JSON.stringify(refreshed[49].node.params)
      !== JSON.stringify(state.nodeRuns[49].node.params))
    fail('browser schema refresh would alter fresh image or review contract')
  const prepared = prepareWorkflowRunContext(refreshed, 45)
  const run = prepared?.run, context = prepared?.inputContext
  if (run?.node.id !== 'sanguo-scene-cut-first-frame')
    fail('first pending node changed')
  const params = Object.fromEntries(run.node.params.map(param =>
    [param.englishName || param.name, paramValue(param, context)]))
  const request = { model: { id: run.node.modelId, provider: 'Codex',
    capability: 'image', settings: {} },
  prompt: renderWorkflowTemplate(run.node.prompt, context), params,
  executionContext: { workflowId: graph.id,
    nodeId: run.node.id,
    requestKey: `${state.id}:attempt-1:revision-0:${run.node.id}:0:scene-01` } }
  const signed = await verifyA8B6FreshV5EditReceipt()
  const bound = await bindA8B6FreshV5EditReference(request, process.cwd(),
    { previewOnly: true })
  if (!bound.applied || bound.receiptSha256 !== signed.receiptSha256)
    fail('signed third reference was not bound')
  await validateSceneCutPaidImageRequest(bound.request, process.cwd(), 180)
  await db.query('ROLLBACK')
  console.log(JSON.stringify({ recordId: state.id, recordMd5: row.result_md5,
    version: marker.version, node45PromptSha256: sha(run.node.prompt),
    node49PromptSha256: sha(refreshed[49].node.prompt),
    renderedRequestSha256: sha(request.prompt),
    referenceImageCount: bound.request.params.referenceImages.length,
    referenceSha256s: signed.receipt.referenceOrder.map(item =>
      item.sha256 ?? item.jpegSha256),
    editReceiptSha256: signed.receiptSha256,
    markerMatchesRequest: isDeepStrictEqual(params.sceneCutFreshImage, marker),
    schemaRefreshPreserved: true,
    providerBoundaryAcceptedShape: true, providerAuthorized: false,
    databaseWrites: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
