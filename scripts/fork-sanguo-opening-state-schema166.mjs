#!/usr/bin/env node
// Rebuild a rejected schema-165 opening still against the schema-166 opening-state prompt.
// Dry-run by default. --apply inserts a NEW idle record; it never submits a model request.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { upgradeSceneCutOpeningStateWorkflow } from '../src/scene-cut-first-frame-gate.ts'
import { orderRouteNodes, executionRouteEdges } from '../src/workflow-branch.ts'
import { orderLoopPlaceholders } from '../src/workflow-runner.ts'
import { scopedLoopNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = message => { throw Error(`OPENING_STATE_CHECKPOINT_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const VERSION = 'scene-cut-opening-state-schema166-fork-v1'
const FIRST = 'sanguo-scene-cut-source-archive'
const IMAGE = 'sanguo-scene-cut-first-frame'
const REVIEW = 'sanguo-scene-cut-review'
const GATE = 'sanguo-scene-cut-approval'

function parseArguments(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--source': 'sourceId', '--id': 'id', '--proof': 'proofPath',
      '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5',
      '--expected-failed-beat': 'failedBeatId' }[flag]
    if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '')) fail('--source must name a saved record')
  if (options.id !== undefined && (!/^record-[\w-]+$/.test(options.id) || options.id === options.sourceId)) fail('--id must name a NEW record')
  for (const field of ['sourceMd5', 'workflowMd5']) if (options[field] !== undefined && !/^[a-f0-9]{32}$/i.test(options[field])) fail(`${field} must be 32 hex digits`)
  if (options.failedBeatId !== undefined && !/^[\w-]+$/.test(options.failedBeatId)) fail('--expected-failed-beat is invalid')
  if (options.apply && (!options.id || !options.sourceMd5 || !options.workflowMd5 || !options.failedBeatId)) {
    fail('--apply requires reviewed --id, --expected-source-md5, --expected-workflow-md5 and --expected-failed-beat')
  }
  return options
}

function currentGraph(row, apply) {
  if (!row || row.id !== 'wf-sanguo-history-drama' || !Array.isArray(row.nodes) || !Array.isArray(row.edges)) fail('Sanguo workflow is missing or malformed')
  if (![165, 166].includes(row.schema_version)) fail(`expected schema 165 or 166, got ${row.schema_version}`)
  if (apply && row.schema_version !== 166) fail('schema 166 must be saved before inserting a migrated checkpoint')
  const graph = { id: row.id, schemaVersion: row.schema_version, nodes: row.nodes, edges: row.edges }
  const upgraded = upgradeSceneCutOpeningStateWorkflow(graph)
  if (upgraded.schemaVersion !== 166 || upgraded.nodes.length !== graph.nodes.length
    || !isDeepStrictEqual(upgraded.edges, graph.edges)) fail('schema 166 opening-state prompt upgrade is incomplete or changed topology')
  if (row.schema_version === 166 && !isDeepStrictEqual(upgraded, graph)) fail('saved schema 166 migration is not idempotent')
  const changedIds = upgraded.nodes.filter((node, index) => !isDeepStrictEqual(node, graph.nodes[index])).map(node => node.id)
  if (row.schema_version === 165 && !same(changedIds, [IMAGE, REVIEW])) fail(`unexpected schema 166 node changes: ${changedIds.join(',')}`)
  const owner = upgraded.nodes.find(node => node.id === 'sanguo-scene-loop')
  if (!owner?.loop?.enabled) fail('scene loop is missing or disabled')
  const ordered = orderRouteNodes(upgraded)
  if (ordered.hasCycle) fail('schema 166 workflow has a route cycle')
  const loopChildren = scopedLoopNodes({ ...upgraded, edges: executionRouteEdges(upgraded) }, owner.id, ordered.ordered)
  if (loopChildren.length !== new Set(loopChildren.map(node => node.id)).size
    || [FIRST, IMAGE, REVIEW, GATE].some(id => !loopChildren.some(node => node.id === id))) fail('scene-cut loop queue is incomplete')
  const staticOrder = orderLoopPlaceholders(upgraded, ordered.ordered).map(node => node.id)
  return { graph: upgraded, owner, loopChildren, staticOrder }
}

export function prepareOpeningStateFork(source, workflowRow, {
  id = `record-opening-state-${randomUUID().slice(0, 8)}`, createdAt = new Date().toISOString(),
  failedBeatId = 'action-stand', apply = false,
} = {}) {
  if (!source || !object(source.result) || source.workflow_id !== 'wf-sanguo-history-drama'
    || !/^record-[\w-]+$/.test(source.id) || !/^record-[\w-]+$/.test(id) || id === source.id
    || !Number.isFinite(Date.parse(createdAt))) fail('source or new checkpoint identity is invalid')
  const hash = createJsonHasher(), original = decodeExecutionState(source.result)
  if (original.id !== source.id || original.workflowId !== source.workflow_id
    || !Array.isArray(original.nodeRuns) || original.nodeRuns.some(run => run.status === 'running')) fail('source execution is missing, mismatched, or active')
  const oldRecovery = original.sceneCutFirstFrameRecovery
  if (oldRecovery?.version !== 'scene-cut-first-frame-schema165-fork-v1'
    || oldRecovery.workflowSchemaVersion !== 165 || oldRecovery.sourceExecutionId !== original.parentExecutionId
    || oldRecovery.firstPendingNodeId !== 'sanguo-first-frame-branch') fail('source is not an approved schema-165 first-frame checkpoint')
  const { graph, owner, loopChildren, staticOrder } = currentGraph(workflowRow, apply)
  const runs = original.nodeRuns, graphNodes = new Map(graph.nodes.map(node => [node.id, node]))
  const sourceIds = new Set(runs.map(run => run.node?.id))
  if (sourceIds.size !== graphNodes.size || [...sourceIds].some(nodeId => !graphNodes.has(nodeId))) fail('source topology differs from the schema-166 workflow')
  const ownerIndex = runs.findIndex(run => run.node?.id === owner.id)
  const sceneCount = runs.find(run => run.node?.id === 'sanguo-scene-outline-accept')?.output?.scenes?.length
  const loopGroupId = runs[ownerIndex + 1]?.loopGroupId
  const sourceChildren = runs.filter(run => run.loopGroupId === loopGroupId && run.loopIndex === 0).map(run => run.node.id)
  const loopIds = loopChildren.map(node => node.id)
  if (ownerIndex < 0 || runs[ownerIndex].status !== 'success' || !loopGroupId
    || !Number.isSafeInteger(sceneCount) || sceneCount < 1 || runs[ownerIndex].output?.count !== sceneCount
    || !same(sourceChildren, loopIds) || !same(runs.slice(0, ownerIndex + 1).map(run => run.node.id), staticOrder.slice(0, ownerIndex + 1))) {
    fail('approved outline or source loop queue differs from current graph')
  }
  const firstChildIndex = loopIds.indexOf(FIRST), boundary = ownerIndex + 1 + firstChildIndex
  const reviewIndex = ownerIndex + 1 + loopIds.indexOf(REVIEW)
  const gateIndex = ownerIndex + 1 + loopIds.indexOf(GATE)
  if (firstChildIndex < 0 || !(boundary < reviewIndex && reviewIndex < gateIndex)
    || runs[boundary]?.node.id !== FIRST || runs.slice(0, boundary).some(run => !['success', 'skipped'].includes(run.status))) {
    fail('first scene prefix does not end before the source archive')
  }
  const expectedIds = [
    ...staticOrder.slice(0, ownerIndex + 1),
    ...Array.from({ length: sceneCount }, () => loopIds).flat(),
    ...staticOrder.slice(ownerIndex + 1 + loopIds.length),
  ]
  if (!same(runs.map(run => run.node.id), expectedIds)) fail('saved eight-round queue is split or reordered')
  const roundIndexes = [...new Set(runs.filter(run => run.loopGroupId === loopGroupId && Number.isSafeInteger(run.loopIndex)).map(run => run.loopIndex))].sort((a, b) => a - b)
  if (roundIndexes.length !== sceneCount || roundIndexes.some((round, index) => round !== index)
    || runs.slice(ownerIndex + 1 + loopIds.length, ownerIndex + 1 + loopIds.length * sceneCount).some(run => run.status !== 'idle')
    || runs.slice(ownerIndex + 1 + loopIds.length * sceneCount).some(run => run.status !== 'idle')) {
    fail('later rounds or outer suffix are not pristine idle checkpoints')
  }
  const imageRun = runs[ownerIndex + 1 + loopIds.indexOf(IMAGE)]
  const reviewRun = runs[reviewIndex], gateRun = runs[gateIndex]
  const failedCheck = reviewRun?.output?.requiredVisualActionChecks?.find(check => check.beatId === failedBeatId)
  if (runs[boundary].status !== 'success' || imageRun?.status !== 'success'
    || typeof imageRun.output?.url !== 'string' || reviewRun?.status !== 'success'
    || reviewRun.output?.passed !== false || !Array.isArray(reviewRun.output?.issues)
    || !reviewRun.output.issues.some(issue => typeof issue === 'string' && issue.includes(failedBeatId))
    || failedCheck?.terminalStateAlreadyPresent !== true || failedCheck.approvedResetBeatId
    || gateRun?.status !== 'failed' || !String(gateRun.error).startsWith('SCENE_CUT_FRAME_BLOCKED')
    || runs.slice(gateIndex + 1).some(run => run.status !== 'idle')) {
    fail(`source has no blocked first-frame review for ${failedBeatId}, or later provider work already ran`)
  }
  const videoRun = runs.find(run => run.node.id === 'sanguo-video' && run.loopIndex === 0)
  if (videoRun?.status !== 'idle') fail('source video must remain unpurchased')
  const approvedShot = runs.find(run => run.node.id === 'sanguo-shot-script-accept' && run.loopIndex === 0)?.output
  if (approvedShot?.passed !== true || approvedShot.continuity?.mode !== 'scene_cut'
    || approvedShot.visualTreatment !== 'live_action' || approvedShot.firstFrameMode !== 'reference') {
    fail('first shot is not an approved live-action scene cut')
  }
  const prefix = runs.slice(0, boundary)
  const nodeRuns = runs.map((run, index) => index < boundary ? run : {
    id: `${run.node.id}-${loopGroupId}-schema166-${id}-${index}`,
    node: graphNodes.get(run.node.id), label: run.label,
    output: undefined, context: {}, inputs: {}, inputContext: {},
    status: 'idle', durationMs: 0,
    ...(run.loopGroupId ? { loopNode: owner, loopItem: run.loopItem, loopIndex: run.loopIndex,
      loopPrevious: undefined, loopGroupId: run.loopGroupId, loopIsLast: run.loopIsLast } : {}),
  })
  if (nodeRuns.length !== runs.length || new Set(nodeRuns.map(run => run.id)).size !== nodeRuns.length
    || nodeRuns.findIndex(run => run.status === 'idle') !== boundary
    || nodeRuns.slice(boundary).some(run => run.status !== 'idle')) fail('rebuilt queue is incomplete')
  const prepared = prepareWorkflowRunContext(nodeRuns, boundary)
  if (!prepared || prepared.inputContext.shot_script?.id !== approvedShot.id
    || prepared.inputContext.first_frame_branch?.shouldGenerateSceneFrame !== true
    || !object(prepared.inputContext.archived_character_assets)
    || prepared.inputContext.scene_cut_sources !== undefined
    || prepared.inputContext.first_frame !== undefined
    || prepared.inputContext.video_take !== undefined) {
    fail('rebuilt source-archive context lost approved shot/assets or retained rejected media')
  }
  const prefixOutputHash = hash(prefix.map(run => run.output ?? null))
  if (prefixOutputHash !== hash(nodeRuns.slice(0, boundary).map(run => run.output ?? null))) fail('approved prefix output changed')
  const recovery = { version: VERSION, createdAt, sourceExecutionId: source.id,
    sourceResultMd5: source.result_md5 ?? null, sourceResultHash: hash(original),
    workflowSchemaVersion: 166, workflowNodesMd5: workflowRow.nodes_md5 ?? null,
    workflowEdgesMd5: workflowRow.edges_md5 ?? null,
    previousRecoveryHash: hash(oldRecovery), previousImageUrl: imageRun.output.url,
    previousImageOutputHash: hash(imageRun.output), previousReviewOutputHash: hash(reviewRun.output),
    previousGateError: gateRun.error, failedBeatId,
    preservedPrefixLength: boundary, preservedPrefixOutputHash: prefixOutputHash,
    firstPendingNodeId: FIRST }
  const state = { ...original, id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? original.id, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns, context: runs[boundary - 1].context,
    selectedNodeId: FIRST, branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    logs: [...prefix.map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `从 ${source.id} 的首帧审核失败建立 schema166 起始状态恢复；原首帧与审核留在父记录。`],
    sceneCutFirstFrameRecovery: recovery }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)) fail('storage round-trip changed the migrated checkpoint')
  return { state, encoded, proof: { ...recovery, sourceRecordId: source.id,
    workflowNodesMd5: workflowRow.nodes_md5 ?? null, newRecordId: id,
    sourceRunCount: runs.length, newRunCount: nodeRuns.length, loopCount: sceneCount,
    loopChildCount: loopChildren.length, preservedPrefixRunIdsHash: hash(prefix.map(run => run.id)),
    newPrefixRunIdsHash: hash(nodeRuns.slice(0, boundary).map(run => run.id)),
    firstPendingIndex: boundary, sourceVideoStatus: videoRun.status, modelCalls: 0,
    sourceUnchanged: true, roundTripVerified: true } }
}

async function fork(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
    if (!source) fail('source record was not found')
    if (options.sourceMd5 && source.result_md5 !== options.sourceMd5.toLowerCase()) fail('source MD5 changed after review')
    const workflow = (await client.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [source.workflow_id])).rows[0]
    if (options.workflowMd5 && workflow?.nodes_md5 !== options.workflowMd5.toLowerCase()) fail('workflow MD5 changed after review')
    const prepared = prepareOpeningStateFork(source, workflow, { id: options.id, failedBeatId: options.failedBeatId, apply: options.apply })
    if (options.apply) {
      const state = prepared.state
      await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `换场首帧起点恢复 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(prepared.encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result)) !== createJsonHasher()(state)) fail('saved fork differs from reviewed candidate')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [source.id])).rows[0]?.hash
    const workflowAfter = (await client.query('SELECT md5(nodes::text) AS hash FROM workflow_configs WHERE id=$1', [workflow.id])).rows[0]?.hash
    if (sourceAfter !== source.result_md5 || workflowAfter !== workflow.nodes_md5) fail('source or workflow changed while preparing fork')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: options.apply, sourceResultMd5After: sourceAfter, workflowNodesMd5After: workflowAfter }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-sanguo-opening-state-schema166.mjs --source record-ID [--id record-NEW] [--expected-source-md5 MD5] [--expected-workflow-md5 MD5] [--expected-failed-beat BEAT-ID] [--proof FILE] [--apply]\nDefault is read-only. --apply requires saved schema166 and inserts only a new idle execution.')
    return
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const result = await fork(db, options)
    if (options.proofPath) await writeFile(options.proofPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify(result, null, 2))
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
