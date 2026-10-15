#!/usr/bin/env node
// Rebase a saved Sanguo first scene onto the schema-165 opening-frame gate.
// Dry-run by default. --apply inserts one NEW idle checkpoint; it never runs a model.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { upgradeSceneCutFirstFrameWorkflow } from '../src/scene-cut-first-frame-gate.ts'
import { orderRouteNodes, executionRouteEdges } from '../src/workflow-branch.ts'
import { orderLoopPlaceholders } from '../src/workflow-runner.ts'
import { scopedLoopNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = message => { throw Error(`SCENE_CUT_CHECKPOINT_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const NEW_IDS = [
  'sanguo-scene-cut-source-archive', 'sanguo-scene-cut-first-frame',
  'sanguo-scene-cut-evidence-plan', 'sanguo-scene-cut-evidence',
  'sanguo-scene-cut-review', 'sanguo-scene-cut-approval',
]

function parseArguments(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--source': 'sourceId', '--id': 'id', '--proof': 'proofPath',
      '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5',
      '--expected-defect-code': 'defectCode' }[flag]
    if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '')) fail('--source must name a saved record')
  if (options.id !== undefined && (!/^record-[\w-]+$/.test(options.id) || options.id === options.sourceId)) fail('--id must name a NEW record')
  for (const field of ['sourceMd5', 'workflowMd5']) if (options[field] !== undefined && !/^[a-f0-9]{32}$/i.test(options[field])) fail(`${field} must be 32 hex digits`)
  if (options.defectCode !== undefined && !/^[a-z][a-z0-9_-]+$/.test(options.defectCode)) fail('--expected-defect-code is invalid')
  if (options.apply && (!options.id || !options.sourceMd5 || !options.workflowMd5 || !options.defectCode)) {
    fail('--apply requires reviewed --id, --expected-source-md5, --expected-workflow-md5 and --expected-defect-code')
  }
  return options
}

function currentGraph(row, apply) {
  if (!row || row.id !== 'wf-sanguo-history-drama' || !Array.isArray(row.nodes) || !Array.isArray(row.edges)) fail('Sanguo workflow is missing or malformed')
  if (![164, 165].includes(row.schema_version)) fail(`expected schema 164 or 165, got ${row.schema_version}`)
  if (apply && row.schema_version !== 165) fail('schema 165 must be saved before inserting a migrated checkpoint')
  const graph = { id: row.id, schemaVersion: row.schema_version, nodes: row.nodes, edges: row.edges }
  const upgraded = upgradeSceneCutFirstFrameWorkflow(graph)
  if (upgraded.schemaVersion !== 165 || NEW_IDS.some(id => upgraded.nodes.filter(node => node.id === id).length !== 1)) fail('schema 165 first-frame gate is incomplete')
  if (row.schema_version === 165 && !isDeepStrictEqual(upgraded, graph)) fail('saved schema 165 migration is not idempotent')
  const owner = upgraded.nodes.find(node => node.id === 'sanguo-scene-loop')
  if (!owner?.loop?.enabled) fail('schema 165 scene loop is missing or disabled')
  const ordered = orderRouteNodes(upgraded)
  if (ordered.hasCycle) fail('schema 165 workflow has a route cycle')
  const loopChildren = scopedLoopNodes({ ...upgraded, edges: executionRouteEdges(upgraded) }, owner.id, ordered.ordered)
  if (loopChildren.length !== new Set(loopChildren.map(node => node.id)).size
    || NEW_IDS.some(id => !loopChildren.some(node => node.id === id))) fail('schema 165 loop child queue is incomplete')
  const staticOrder = orderLoopPlaceholders(upgraded, ordered.ordered).map(node => node.id)
  return { graph: upgraded, owner, loopChildren, staticOrder }
}

export function prepareSceneCutFirstFrameFork(source, workflowRow, {
  id = `record-scene-cut-frame-${randomUUID().slice(0, 8)}`, createdAt = new Date().toISOString(),
  defectCode = 'core_event_contradiction', apply = false,
} = {}) {
  if (!source || !object(source.result) || source.workflow_id !== 'wf-sanguo-history-drama'
    || !/^record-[\w-]+$/.test(source.id) || !/^record-[\w-]+$/.test(id) || id === source.id
    || !Number.isFinite(Date.parse(createdAt))) fail('source or new checkpoint identity is invalid')
  const hash = createJsonHasher(), original = decodeExecutionState(source.result)
  if (original.id !== source.id || original.workflowId !== source.workflow_id
    || !Array.isArray(original.nodeRuns) || original.nodeRuns.some(run => run.status === 'running')) fail('source execution is missing, mismatched, or active')
  const { graph, owner, loopChildren, staticOrder } = currentGraph(workflowRow, apply)
  const runs = original.nodeRuns
  const sourceIds = new Set(runs.map(run => run.node?.id))
  const graphIds = new Set(graph.nodes.map(node => node.id))
  if (sourceIds.size !== graphIds.size - NEW_IDS.length
    || [...sourceIds].some(nodeId => !graphIds.has(nodeId))
    || NEW_IDS.some(nodeId => sourceIds.has(nodeId))) fail('source is not the pre-gate workflow topology')
  const ownerIndex = runs.findIndex(run => run.node.id === owner.id)
  if (ownerIndex < 0 || runs[ownerIndex].status !== 'success'
    || !same(runs.slice(0, ownerIndex + 1).map(run => run.node.id), staticOrder.slice(0, ownerIndex + 1))) fail('approved outline and expanded loop prefix are not stable')
  const ownerRun = runs[ownerIndex], loopGroupId = runs[ownerIndex + 1]?.loopGroupId
  const roundIndexes = [...new Set(runs.filter(run => run.loopGroupId === loopGroupId && Number.isSafeInteger(run.loopIndex)).map(run => run.loopIndex))].sort((a, b) => a - b)
  const sceneCount = original.nodeRuns.find(run => run.node.id === 'sanguo-scene-outline-accept')?.output?.scenes?.length
  if (!loopGroupId || !Array.isArray(ownerRun.node.childIds) || ownerRun.output?.count !== sceneCount
    || roundIndexes.length !== sceneCount || roundIndexes.some((round, index) => round !== index)) fail('loop rounds do not match the approved outline')
  const sourceChildren = runs.filter(run => run.loopGroupId === loopGroupId && run.loopIndex === 0).map(run => run.node.id)
  if (!sourceChildren.length || sourceChildren.length !== ownerRun.node.childIds.length
    || loopChildren.length !== sourceChildren.length + NEW_IDS.length
    || loopChildren.slice(0, 16).some((node, index) => node.id !== sourceChildren[index])) fail('first-scene saved queue does not match the migration prefix')
  const sourceRounds = roundIndexes.map(loopIndex => runs.filter(run => run.loopGroupId === loopGroupId && run.loopIndex === loopIndex))
  if (sourceRounds.some((round, index) => round.length !== sourceChildren.length
    || round.some((run, at) => run.node.id !== sourceChildren[at] || run.loopGroupId !== loopGroupId || run.loopIndex !== index)
    || index > 0 && round.some(run => run.status !== 'idle'))) fail('source loop queue was split, reordered, or already executed in a later round')
  const boundary = ownerIndex + 1 + 16
  if (runs[boundary]?.node.id !== 'sanguo-first-frame-branch'
    || runs.slice(0, boundary).some(run => !['success', 'skipped'].includes(run.status))) fail('first-frame branch is not the first pending repair point')
  const acceptedShot = runs.find(run => run.node.id === 'sanguo-shot-script-accept' && run.loopIndex === 0)?.output
  if (acceptedShot?.passed !== true || acceptedShot.continuity?.mode !== 'scene_cut'
    || acceptedShot.visualTreatment !== 'live_action' || acceptedShot.firstFrameMode !== 'reference') fail('first shot is not an approved live-action scene cut')
  const reviewRun = runs.find(run => run.node.id === 'sanguo-media-review' && run.loopIndex === 0)
  const latestReview = reviewRun?.output
  const defect = latestReview?.decision === 'revise' && Array.isArray(latestReview.issues)
    ? latestReview.issues.find(issue => issue.code === defectCode)
    : undefined
  const accepted = runs.find(run => run.node.id === 'sanguo-media-accept' && run.loopIndex === 0)?.output
  if (!defect || !object(accepted) || accepted.passed !== false) fail(`source has no rejected first-shot ${defectCode} defect`)
  const oldVideo = runs.find(run => run.node.id === 'sanguo-video' && run.loopIndex === 0)
  if (oldVideo?.status !== 'success' || typeof oldVideo.output?.url !== 'string') fail('replaced candidate video is not preserved in source')

  const newOwnerRun = { ...ownerRun, node: owner }
  const prefix = runs.slice(0, ownerIndex).concat(newOwnerRun)
  const newLoopRuns = sourceRounds.flatMap((round, loopIndex) => {
    const loopItem = round[0].loopItem
    if (!object(loopItem) || loopItem.id !== original.nodeRuns.find(run => run.node.id === 'sanguo-scene-outline-accept')?.output?.scenes?.[loopIndex]?.id) {
      fail(`round ${loopIndex + 1} item differs from approved outline`)
    }
    return loopChildren.map((node, childIndex) => loopIndex === 0 && childIndex < 16
      ? { ...round[childIndex], loopNode: owner }
      : {
          id: `${node.id}-${loopGroupId}-schema165-${loopIndex}-${childIndex}`, node,
          label: `第 ${loopIndex + 1} 轮 / ${node.title} -> ${node.resultVar}`,
          output: undefined, context: {}, inputs: {}, inputContext: {},
          status: 'idle', durationMs: 0, loopNode: owner, loopItem, loopIndex,
          loopPrevious: undefined, loopGroupId,
          loopIsLast: loopIndex === roundIndexes.length - 1 && childIndex === loopChildren.length - 1,
        })
  })
  const oldSuffix = runs.slice(ownerIndex + 1 + sourceRounds.length * sourceChildren.length)
  const suffixIds = staticOrder.slice(ownerIndex + 1 + loopChildren.length)
  if (!same(oldSuffix.map(run => run.node.id), suffixIds) || oldSuffix.some(run => run.status !== 'idle')) fail('outer workflow suffix is not an idle static queue')
  const suffix = oldSuffix.map((run, index) => ({ ...run, node: graph.nodes.find(node => node.id === suffixIds[index]) }))
  const nodeRuns = [...prefix, ...newLoopRuns, ...suffix]
  if (nodeRuns.length !== staticOrder.length + (roundIndexes.length - 1) * loopChildren.length
    || new Set(nodeRuns.map(run => run.id)).size !== nodeRuns.length
    || new Set(nodeRuns.map(run => run.node.id)).size !== graphIds.size
    || nodeRuns.some(run => !graphIds.has(run.node.id))) fail('rebuilt execution queue does not cover the new workflow exactly')
  const firstPending = nodeRuns.findIndex(run => run.status === 'idle')
  if (firstPending !== boundary || nodeRuns[firstPending].node.id !== 'sanguo-first-frame-branch') fail('new first pending node is not the opening-frame branch')
  const context = runs[boundary - 1].context
  const prepared = prepareWorkflowRunContext(nodeRuns, firstPending)
  if (!prepared || prepared.inputContext.shot_script?.id !== acceptedShot.id
    || !object(prepared.inputContext.archived_character_assets)
    || prepared.inputContext.video_take !== undefined) fail('rebuilt first-frame context lost approved shot/assets or retained rejected video')
  const prefixOutputs = runs.slice(0, boundary).map(run => run.output ?? null)
  if (hash(prefixOutputs) !== hash(nodeRuns.slice(0, boundary).map(run => run.output ?? null))) fail('approved prefix output changed')
  const sourceResultHash = hash(original), sourceBranchHistoryHash = hash(original.branchHistory ?? [])
  const recovery = { version: 'scene-cut-first-frame-schema165-fork-v1', createdAt,
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5 ?? null,
    sourceResultHash, sourceBranchHistoryHash, sourceVideoRunId: oldVideo.id,
    sourceVideoUrl: oldVideo.output.url, sourceVideoOutputHash: hash(oldVideo.output),
    reportedDefectCode: defectCode, reportedDefectHash: hash(defect),
    preservedPrefixLength: boundary, preservedPrefixOutputHash: hash(prefixOutputs),
    firstPendingNodeId: 'sanguo-first-frame-branch', workflowSchemaVersion: 165,
    workflowNodesMd5: workflowRow.nodes_md5 ?? null,
    workflowEdgesMd5: workflowRow.edges_md5 ?? null }
  const state = { ...original, id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? original.id, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns, context,
    selectedNodeId: nodeRuns[firstPending].node.id,
    branchHistory: [], breakpointRollback: undefined, breakpointRollbackHistory: undefined,
    logs: [...nodeRuns.slice(0, boundary).map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `从 ${source.id} 迁移至 schema165 首帧验收；原付费视频和质检保留在父记录，首镜从首帧分支待执行。`],
    sceneCutFirstFrameRecovery: recovery }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)) fail('storage round-trip changed the migrated checkpoint')
  return { state, encoded, proof: { ...recovery, sourceRecordId: source.id,
    workflowNodesMd5: workflowRow.nodes_md5 ?? null, newRecordId: id,
    sourceRunCount: runs.length, newRunCount: nodeRuns.length, loopCount: roundIndexes.length,
    oldLoopChildCount: sourceChildren.length, newLoopChildCount: loopChildren.length,
    preservedPrefixRunIdsHash: hash(runs.slice(0, boundary).map(run => run.id)),
    newPrefixRunIdsHash: hash(nodeRuns.slice(0, boundary).map(run => run.id)),
    firstPendingIndex: firstPending, paidVideoRetainedInSource: true,
    modelCalls: 0, sourceUnchanged: true, roundTripVerified: true } }
}

async function fork(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
    if (!source) fail('source record was not found')
    if (options.sourceMd5 && source.result_md5 !== options.sourceMd5.toLowerCase()) fail('source MD5 changed after review')
    const workflow = (await client.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [source.workflow_id])).rows[0]
    if (options.workflowMd5 && workflow?.nodes_md5 !== options.workflowMd5.toLowerCase()) fail('workflow MD5 changed after review')
    const prepared = prepareSceneCutFirstFrameFork(source, workflow, { id: options.id,
      defectCode: options.defectCode, apply: options.apply })
    if (options.apply) {
      const state = prepared.state
      await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `换场首帧验收恢复 · ${source.id}`,
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
    console.log('node scripts/fork-sanguo-scene-cut-first-frame.mjs --source record-ID [--id record-NEW] [--expected-source-md5 MD5] [--expected-workflow-md5 MD5] [--expected-defect-code CODE] [--proof FILE] [--apply]\nDefault is read-only. --apply requires saved schema165 and inserts only a new idle execution.')
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
