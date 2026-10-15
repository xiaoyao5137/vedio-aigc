#!/usr/bin/env node
// Preserve an approved first-shot prefix and identity plate, then insert the
// schema-168 opening plan before rebuilding every later loop run as idle.
// Dry-run by default. --apply inserts a NEW idle record; it never submits a model request.
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V168, SCENE_CUT_FRAME_REVIEW_PROMPT_V168,
  upgradeSceneCutOpeningPlanWorkflow } from '../src/scene-cut-opening-plan-workflow.ts'
import { orderRouteNodes, executionRouteEdges } from '../src/workflow-branch.ts'
import { orderLoopPlaceholders } from '../src/workflow-runner.ts'
import { scopedLoopNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const fail = message => { throw Error(`OPENING_PLAN_CHECKPOINT_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const VERSION = 'scene-cut-opening-plan-schema168-fork-v1'
const ownerId = 'sanguo-scene-loop'
const FIRST = 'sanguo-scene-cut-source-archive'
const PLAN = 'sanguo-scene-cut-opening-plan'
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
      '--expected-workflow-edges-md5': 'workflowEdgesMd5',
      '--expected-failed-beat': 'failedBeatId' }[flag]
    if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '')) fail('--source must name a saved record')
  if (options.id !== undefined && (!/^record-[\w-]+$/.test(options.id) || options.id === options.sourceId)) fail('--id must name a NEW record')
  for (const field of ['sourceMd5', 'workflowMd5', 'workflowEdgesMd5']) if (options[field] !== undefined && !/^[a-f0-9]{32}$/i.test(options[field])) fail(`${field} must be 32 hex digits`)
  if (options.failedBeatId !== undefined && !/^[\w-]+$/.test(options.failedBeatId)) fail('--expected-failed-beat is invalid')
  if (options.apply && (!options.id || !options.sourceMd5 || !options.workflowMd5 || !options.workflowEdgesMd5 || !options.failedBeatId)) {
    fail('--apply requires reviewed --id, --expected-source-md5, --expected-workflow-md5, --expected-workflow-edges-md5 and --expected-failed-beat')
  }
  return options
}

function currentGraph(row, apply) {
  if (!row || row.id !== 'wf-sanguo-history-drama' || !Array.isArray(row.nodes) || !Array.isArray(row.edges)) fail('Sanguo workflow is missing or malformed')
  if (![167, 168].includes(row.schema_version)) fail(`expected schema 167 or 168, got ${row.schema_version}`)
  if (apply && row.schema_version !== 168) fail('schema 168 must be saved before inserting a migrated checkpoint')
  const graph = { id: row.id, schemaVersion: row.schema_version, nodes: row.nodes, edges: row.edges }
  const upgraded = upgradeSceneCutOpeningPlanWorkflow(graph)
  if (upgraded.schemaVersion !== 168 || upgraded.nodes.filter(node => node.id === PLAN).length !== 1) fail('schema 168 opening plan upgrade is incomplete')
  if (row.schema_version === 168 && !isDeepStrictEqual(upgraded, graph)) fail('saved schema 168 migration is not idempotent')
  if (row.schema_version === 167) {
    if (upgraded.nodes.length !== graph.nodes.length + 1 || upgraded.edges.length !== graph.edges.length + 1
      || graph.nodes.some(node => node.id === PLAN)
      || upgraded.nodes.some(node => node.id !== PLAN && !graph.nodes.some(prior => prior.id === node.id))) fail('unexpected schema 168 node or edge count')
    const changedIds = upgraded.nodes.filter(node => !isDeepStrictEqual(node,
      graph.nodes.find(previous => previous.id === node.id))).map(node => node.id)
    if (!same([...changedIds].sort(), [ownerId, IMAGE, REVIEW, GATE, PLAN].sort())) {
      fail(`unexpected schema 168 node changes: ${changedIds.join(',')}`)
    }
    const oldLink = graph.edges.filter(edge => edge.from === FIRST && edge.to === IMAGE)
    const newIntoPlan = upgraded.edges.filter(edge => edge.from === FIRST && edge.to === PLAN)
    const newOutOfPlan = upgraded.edges.filter(edge => edge.from === PLAN && edge.to === IMAGE)
    if (oldLink.length !== 1 || newIntoPlan.length !== 1 || newOutOfPlan.length !== 1
      || !isDeepStrictEqual(graph.edges.filter(edge => edge !== oldLink[0]),
        upgraded.edges.filter(edge => edge !== newIntoPlan[0] && edge !== newOutOfPlan[0]))) {
      fail('schema 168 changed edges outside the opening plan')
    }
    const originalOwner = graph.nodes.find(node => node.id === ownerId)
    const newOwner = upgraded.nodes.find(node => node.id === ownerId)
    if (!Array.isArray(originalOwner?.childIds) || !Array.isArray(newOwner?.childIds)
      || newOwner.childIds.length !== originalOwner.childIds.length + 1
      || newOwner.childIds.indexOf(PLAN) !== originalOwner.childIds.indexOf(FIRST) + 1
      || !same(newOwner.childIds.filter(id => id !== PLAN), originalOwner.childIds)) {
      fail('schema 168 opening plan is not inserted after source archive')
    }
  }
  const owner = upgraded.nodes.find(node => node.id === ownerId)
  if (!owner?.loop?.enabled) fail('scene loop is missing or disabled')
  const plan = upgraded.nodes.find(node => node.id === PLAN)
  const image = upgraded.nodes.find(node => node.id === IMAGE)
  const review = upgraded.nodes.find(node => node.id === REVIEW)
  const approval = upgraded.nodes.find(node => node.id === GATE)
  const hasPlanParam = (node, id, name) => node?.params?.filter(param => param.id === id).length === 1
    && node.params.some(param => param.id === id && param.englishName === name
      && param.type === 'json' && param.value === '${scene_cut_opening_state}')
  if (plan?.kind !== 'http' || plan.resultVar !== 'scene_cut_opening_state'
    || plan.parentId !== ownerId || plan.request?.url !== '/api/scene-cut-opening-plan'
    || plan.request?.method !== 'POST'
    || plan.runIf?.path !== 'first_frame_branch.shouldGenerateSceneFrame'
    || plan.runIf?.equals !== true
    || plan.params?.filter(param => param.id === 'sc-plan-shot').length !== 1
    || !plan.params.some(param => param.id === 'sc-plan-shot' && param.englishName === 'shot'
      && param.type === 'json' && param.value === '${shot_script}')
    || owner.childIds?.filter(id => id === PLAN).length !== 1
    || owner.childIds.indexOf(PLAN) !== owner.childIds.indexOf(IMAGE) - 1
    || image?.prompt !== SCENE_CUT_FIRST_FRAME_PROMPT_V168
    || review?.prompt !== SCENE_CUT_FRAME_REVIEW_PROMPT_V168
    || !hasPlanParam(image, 'sc-image-opening-plan', 'sceneCutOpeningPlan')
    || !hasPlanParam(review, 'sc-review-opening-plan', 'openingStatePlan')
    || !hasPlanParam(approval, 'sc-approval-opening-plan', 'openingStatePlan')
    || upgraded.edges.filter(edge => edge.from === FIRST && edge.to === PLAN).length !== 1
    || upgraded.edges.filter(edge => edge.from === PLAN && edge.to === IMAGE).length !== 1
    || upgraded.edges.some(edge => edge.from === FIRST && edge.to === IMAGE)) {
    fail('schema 168 opening-plan node, bindings or route are incomplete')
  }
  const ordered = orderRouteNodes(upgraded)
  if (ordered.hasCycle) fail('schema 167 workflow has a route cycle')
  const loopChildren = scopedLoopNodes({ ...upgraded, edges: executionRouteEdges(upgraded) }, owner.id, ordered.ordered)
  if (loopChildren.length !== new Set(loopChildren.map(node => node.id)).size
    || [FIRST, PLAN, IMAGE, REVIEW, GATE].some(id => !loopChildren.some(node => node.id === id))
    || !(loopChildren.findIndex(node => node.id === FIRST) < loopChildren.findIndex(node => node.id === PLAN)
      && loopChildren.findIndex(node => node.id === PLAN) < loopChildren.findIndex(node => node.id === IMAGE))) {
    fail('scene-cut loop queue is incomplete or reordered')
  }
  const staticOrder = orderLoopPlaceholders(upgraded, ordered.ordered).map(node => node.id)
  return { graph: upgraded, owner, loopChildren, staticOrder }
}

export function prepareOpeningPlanFork(source, workflowRow, {
  id = `record-opening-plan-${randomUUID().slice(0, 8)}`, createdAt = new Date().toISOString(),
  failedBeatId = 'action-bind', apply = false,
} = {}) {
  if (!source || !object(source.result) || source.workflow_id !== 'wf-sanguo-history-drama'
    || !/^record-[\w-]+$/.test(source.id) || !/^record-[\w-]+$/.test(id) || id === source.id
    || !Number.isFinite(Date.parse(createdAt))) fail('source or new checkpoint identity is invalid')
  const hash = createJsonHasher(), original = decodeExecutionState(source.result)
  if (original.id !== source.id || original.workflowId !== source.workflow_id
    || !Array.isArray(original.nodeRuns) || original.nodeRuns.some(run => run.status === 'running')) fail('source execution is missing, mismatched, or active')
  const oldRecovery = original.sceneCutFirstFrameRecovery
  if (oldRecovery?.version !== 'scene-cut-t0-image-schema167-fork-v1'
    || oldRecovery.workflowSchemaVersion !== 167 || oldRecovery.sourceExecutionId !== original.parentExecutionId
    || oldRecovery.firstPendingNodeId !== FIRST) fail('source is not a schema-167 source-archive checkpoint')
  const { graph, owner, loopChildren, staticOrder } = currentGraph(workflowRow, apply)
  const runs = original.nodeRuns, graphNodes = new Map(graph.nodes.map(node => [node.id, node]))
  const sourceIds = new Set(runs.map(run => run.node?.id))
  if (sourceIds.size !== graphNodes.size - 1 || sourceIds.has(PLAN)
    || [...sourceIds].some(nodeId => !graphNodes.has(nodeId))) fail('source topology differs from the schema-168 workflow by more than the opening plan')
  const ownerIndex = runs.findIndex(run => run.node?.id === owner.id)
  const sceneCount = runs.find(run => run.node?.id === 'sanguo-scene-outline-accept')?.output?.scenes?.length
  const loopGroupId = runs[ownerIndex + 1]?.loopGroupId
  const sourceChildren = runs.filter(run => run.loopGroupId === loopGroupId && run.loopIndex === 0).map(run => run.node.id)
  const loopIds = loopChildren.map(node => node.id)
  const oldLoopIds = sourceChildren
  if (ownerIndex < 0 || runs[ownerIndex].status !== 'success' || !loopGroupId
    || !Number.isSafeInteger(sceneCount) || sceneCount < 1 || runs[ownerIndex].output?.count !== sceneCount
    || oldLoopIds.length !== loopIds.length - 1
    || !same([...oldLoopIds].sort(), loopIds.filter(id => id !== PLAN).sort())
    || !same(runs.slice(0, ownerIndex + 1).map(run => run.node.id), staticOrder.slice(0, ownerIndex + 1))) {
    fail('approved outline or source loop queue differs from current graph')
  }
  const firstChildIndex = oldLoopIds.indexOf(FIRST)
  const commonChildCount = loopIds.findIndex((nodeId, index) => nodeId !== oldLoopIds[index])
  const boundary = ownerIndex + 1 + commonChildCount
  const reviewIndex = ownerIndex + 1 + oldLoopIds.indexOf(REVIEW)
  const gateIndex = ownerIndex + 1 + oldLoopIds.indexOf(GATE)
  const sourceArchiveIndex = ownerIndex + 1 + firstChildIndex
  if (firstChildIndex < 0 || commonChildCount <= firstChildIndex || loopIds[commonChildCount] !== PLAN
    || !(boundary < reviewIndex && reviewIndex < gateIndex)
    || runs[sourceArchiveIndex]?.node.id !== FIRST
    || !same(runs.slice(ownerIndex + 1, boundary).map(run => run.node.id), loopIds.slice(0, commonChildCount))
    || runs.slice(0, boundary).some(run => !['success', 'skipped'].includes(run.status))) {
    fail('first scene prefix does not end at the opening-plan insertion')
  }
  const expectedIds = [
    ...staticOrder.slice(0, ownerIndex + 1),
    ...Array.from({ length: sceneCount }, () => oldLoopIds).flat(),
    ...staticOrder.slice(ownerIndex + 1 + loopIds.length),
  ]
  if (!same(runs.map(run => run.node.id), expectedIds)) fail('saved eight-round queue is split or reordered')
  const roundIndexes = [...new Set(runs.filter(run => run.loopGroupId === loopGroupId && Number.isSafeInteger(run.loopIndex)).map(run => run.loopIndex))].sort((a, b) => a - b)
  if (roundIndexes.length !== sceneCount || roundIndexes.some((round, index) => round !== index)
    || runs.slice(ownerIndex + 1 + oldLoopIds.length, ownerIndex + 1 + oldLoopIds.length * sceneCount).some(run => run.status !== 'idle')
    || runs.slice(ownerIndex + 1 + oldLoopIds.length * sceneCount).some(run => run.status !== 'idle')) {
    fail('later rounds or outer suffix are not pristine idle checkpoints')
  }
  const imageRun = runs[ownerIndex + 1 + oldLoopIds.indexOf(IMAGE)]
  const reviewRun = runs[reviewIndex], gateRun = runs[gateIndex]
  const failedCheck = reviewRun?.output?.requiredVisualActionChecks?.find(check => check.beatId === failedBeatId)
  if (runs[sourceArchiveIndex].status !== 'success' || imageRun?.status !== 'success'
    || typeof imageRun.output?.url !== 'string' || reviewRun?.status !== 'success'
    || reviewRun.output?.passed !== false || !Array.isArray(reviewRun.output?.issues)
    || !reviewRun.output.issues.some(issue => typeof issue === 'string' && issue.includes(failedBeatId))
    || failedCheck?.terminalStateAlreadyPresent !== true || failedCheck.actionStillPossible !== false
    || failedCheck.approvedResetBeatId || reviewRun.output?.hardChecks?.actionStartNotCompleted !== false
    || gateRun?.status !== 'idle' || runs.slice(gateIndex).some(run => run.status !== 'idle')) {
    fail(`source has no blocked first-frame review for ${failedBeatId}, or later provider work already ran`)
  }
  const sourceArchive = runs[sourceArchiveIndex].output
  if (sourceArchive?.version !== 'scene-cut-sources-v1'
    || sourceArchive.identityPlateVersion !== 'scene-cut-identity-plate-v2'
    || !Array.isArray(sourceArchive.referenceBindings) || !sourceArchive.referenceBindings.length
    || !Array.isArray(sourceArchive.imageReferenceImages)
    || sourceArchive.imageReferenceImages.length !== sourceArchive.referenceBindings.length
    || sourceArchive.referenceBindings.some((binding, index) => typeof binding.frontUrl !== 'string'
      || !/^\/generated\/scene-cut-front-[a-f0-9]{64}\.jpg$/.test(binding.frontUrl)
      || binding.identityPlateVersion !== 'scene-cut-identity-plate-v2'
      || !/^[a-f0-9]{64}$/.test(binding.upperSha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(binding.lowerSha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(binding.frontSha256 ?? '')
      || !binding.frontUrl.includes(binding.frontSha256)
      || typeof sourceArchive.imageReferenceImages[index] !== 'string'
      || !sourceArchive.imageReferenceImages[index].startsWith('data:image/jpeg;base64,')
      || createHash('sha256').update(Buffer.from(sourceArchive.imageReferenceImages[index].split(',')[1], 'base64'))
        .digest('hex') !== binding.frontSha256)) {
    fail('source archive is not the verified two-region identity reference')
  }
  const videoRun = runs.find(run => run.node.id === 'sanguo-video' && run.loopIndex === 0)
  if (videoRun?.status !== 'idle') fail('source video must remain unpurchased')
  const approvedShot = runs.find(run => run.node.id === 'sanguo-shot-script-accept' && run.loopIndex === 0)?.output
  if (approvedShot?.passed !== true || approvedShot.continuity?.mode !== 'scene_cut'
    || approvedShot.visualTreatment !== 'live_action' || approvedShot.firstFrameMode !== 'reference') {
    fail('first shot is not an approved live-action scene cut')
  }
  const prefix = runs.slice(0, boundary)
  const sourceOwner = runs[ownerIndex].node
  if (!same({ ...owner, childIds: sourceOwner.childIds }, sourceOwner)
    || !same(owner.childIds.filter(childId => childId !== PLAN), sourceOwner.childIds)
    || prefix.some(run => (run.node.id !== owner.id && !isDeepStrictEqual(run.node, graphNodes.get(run.node.id)))
      || (run.loopNode && !isDeepStrictEqual(run.loopNode, sourceOwner)))) {
    fail('approved prefix node snapshots differ outside the one-node loop insertion')
  }
  const sourceRounds = Array.from({ length: sceneCount }, (_, loopIndex) =>
    runs.slice(ownerIndex + 1 + loopIndex * oldLoopIds.length, ownerIndex + 1 + (loopIndex + 1) * oldLoopIds.length))
  const scenes = runs.find(run => run.node.id === 'sanguo-scene-outline-accept').output.scenes
  if (sourceRounds.some((round, loopIndex) => round.length !== oldLoopIds.length
    || round[0]?.loopItem?.id !== scenes[loopIndex]?.id
    || round.some((run, childIndex) => run.node.id !== oldLoopIds[childIndex]
      || run.loopGroupId !== loopGroupId || run.loopIndex !== loopIndex))) {
    fail('source loop items or child order differ from the approved outline')
  }
  const preserved = prefix.map(run => ({ ...run, node: graphNodes.get(run.node.id),
    ...(run.loopNode ? { loopNode: owner } : {}) }))
  const makeIdle = (node, loopIndex, childIndex) => ({
    id: `${node.id}-${loopGroupId}-schema168-${id}-${loopIndex}-${childIndex}`,
    node, label: `第 ${loopIndex + 1} 轮 / ${node.title} -> ${node.resultVar}`,
    output: undefined, context: {}, inputs: {}, inputContext: {},
    status: 'idle', durationMs: 0, loopNode: owner,
    loopItem: sourceRounds[loopIndex][0].loopItem, loopIndex,
    loopPrevious: undefined, loopGroupId,
    loopIsLast: loopIndex === sceneCount - 1 && childIndex === loopChildren.length - 1,
  })
  const newFirstSuffix = loopChildren.slice(commonChildCount)
    .map((node, offset) => makeIdle(node, 0, commonChildCount + offset))
  const laterRounds = Array.from({ length: sceneCount - 1 }, (_, index) => index + 1)
    .flatMap(loopIndex => loopChildren.map((node, childIndex) => makeIdle(node, loopIndex, childIndex)))
  const oldOuterSuffix = runs.slice(ownerIndex + 1 + oldLoopIds.length * sceneCount)
  if (oldOuterSuffix.some(run => run.output !== undefined || Object.keys(run.context ?? {}).length
    || Object.keys(run.inputs ?? {}).length || Object.keys(run.inputContext ?? {}).length)) {
    fail('outer idle suffix carries stale output or inputs')
  }
  const outerSuffix = oldOuterSuffix.map((run, index) => ({
    id: `${run.node.id}-schema168-${id}-outer-${index}`,
    node: graphNodes.get(run.node.id), label: run.label,
    output: undefined, context: {}, inputs: {}, inputContext: {},
    status: 'idle', durationMs: 0,
  }))
  const nodeRuns = [...preserved, ...newFirstSuffix, ...laterRounds, ...outerSuffix]
  const newIds = [
    ...staticOrder.slice(0, ownerIndex + 1),
    ...Array.from({ length: sceneCount }, () => loopIds).flat(),
    ...staticOrder.slice(ownerIndex + 1 + loopIds.length),
  ]
  if (nodeRuns.length !== runs.length + sceneCount
    || !same(nodeRuns.map(run => run.node.id), newIds)
    || new Set(nodeRuns.map(run => run.id)).size !== nodeRuns.length
    || nodeRuns.findIndex(run => run.status === 'idle') !== boundary
    || nodeRuns.slice(boundary).some(run => run.status !== 'idle')
    || nodeRuns.some(run => !isDeepStrictEqual(run.node, graphNodes.get(run.node.id))
      || (run.loopNode && !isDeepStrictEqual(run.loopNode, owner)))) fail('rebuilt queue or node snapshots are incomplete')
  const firstPendingNodeId = nodeRuns[boundary].node.id
  const prepared = prepareWorkflowRunContext(nodeRuns, boundary)
  if (!prepared || hash(prepared.inputContext.shot_script) !== hash(approvedShot)
    || prepared.inputContext.first_frame_branch?.shouldGenerateSceneFrame !== true
    || !object(prepared.inputContext.archived_character_assets)
    || hash(prepared.inputContext.scene_cut_sources) !== hash(sourceArchive)
    || prepared.inputContext.scene_cut_opening_state !== undefined
    || prepared.inputContext.first_frame !== undefined
    || prepared.inputContext.video_take !== undefined) {
    fail('rebuilt opening-plan context lost approved shot/assets or retained rejected media')
  }
  const prefixOutputHash = hash(prefix.map(run => run.output ?? null))
  if (prefixOutputHash !== hash(nodeRuns.slice(0, boundary).map(run => run.output ?? null))) fail('approved prefix output changed')
  const withoutSnapshots = run => ({ ...run, node: undefined, loopNode: undefined })
  const prefixRunDataHash = hash(prefix.map(withoutSnapshots))
  if (prefixRunDataHash !== hash(nodeRuns.slice(0, boundary).map(withoutSnapshots))) {
    fail('approved prefix status, context or inputs changed')
  }
  const recovery = { version: VERSION, createdAt, sourceExecutionId: source.id,
    sourceResultMd5: source.result_md5 ?? null, sourceResultHash: hash(original),
    workflowSchemaVersion: 168, workflowNodesMd5: workflowRow.nodes_md5 ?? null,
    workflowEdgesMd5: workflowRow.edges_md5 ?? null,
    preservedArchiveOutputHash: hash(sourceArchive),
    previousRecoveryHash: hash(oldRecovery), previousImageUrl: imageRun.output.url,
    previousImageOutputHash: hash(imageRun.output), previousReviewOutputHash: hash(reviewRun.output),
    previousGateStatus: gateRun.status, failedBeatId,
    preservedPrefixLength: boundary, preservedPrefixOutputHash: prefixOutputHash,
    preservedPrefixRunDataHash: prefixRunDataHash,
    firstPendingNodeId }
  const state = { ...original, id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? original.id, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns, context: runs[boundary - 1].context,
    selectedNodeId: firstPendingNodeId, branchHistory: [], breakpointRollback: undefined,
    breakpointRollbackHistory: undefined,
    logs: [...prefix.map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `从 ${source.id} 的首帧审核失败建立 schema168 起点规划恢复；已批准前缀和双区域人设板保留，失败首帧及审核留在父记录。`],
    sceneCutFirstFrameRecovery: recovery }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)) fail('storage round-trip changed the migrated checkpoint')
  return { state, encoded, proof: { ...recovery, sourceRecordId: source.id,
    workflowNodesMd5: workflowRow.nodes_md5 ?? null, newRecordId: id,
    sourceRunCount: runs.length, newRunCount: nodeRuns.length, loopCount: sceneCount,
    oldLoopChildCount: oldLoopIds.length, newLoopChildCount: loopChildren.length,
    preservedPrefixRunIdsHash: hash(prefix.map(run => run.id)),
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
    if (options.workflowEdgesMd5 && workflow?.edges_md5 !== options.workflowEdgesMd5.toLowerCase()) fail('workflow edges MD5 changed after review')
    const prepared = prepareOpeningPlanFork(source, workflow, { id: options.id, failedBeatId: options.failedBeatId, apply: options.apply })
    if (options.apply) {
      const state = prepared.state
      await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `换场零秒动作计划恢复 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(prepared.encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result)) !== createJsonHasher()(state)) fail('saved fork differs from reviewed candidate')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [source.id])).rows[0]?.hash
    const workflowAfter = (await client.query('SELECT md5(nodes::text) AS hash FROM workflow_configs WHERE id=$1', [workflow.id])).rows[0]?.hash
    const edgesAfter = (await client.query('SELECT md5(edges::text) AS hash FROM workflow_configs WHERE id=$1', [workflow.id])).rows[0]?.hash
    if (sourceAfter !== source.result_md5 || workflowAfter !== workflow.nodes_md5
      || edgesAfter !== workflow.edges_md5) fail('source or workflow changed while preparing fork')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: options.apply, sourceResultMd5After: sourceAfter,
      workflowNodesMd5After: workflowAfter, workflowEdgesMd5After: edgesAfter }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-sanguo-opening-plan-schema168.mjs --source record-ID [--id record-NEW] [--expected-source-md5 MD5] [--expected-workflow-md5 MD5] [--expected-workflow-edges-md5 MD5] [--expected-failed-beat BEAT-ID] [--proof FILE] [--apply]\nDefault is read-only. --apply requires saved schema168 and inserts only a new idle execution.')
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
