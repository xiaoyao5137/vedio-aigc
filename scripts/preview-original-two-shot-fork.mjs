#!/usr/bin/env node
// Dry-run by default. A schema-171, hash-pinned --apply inserts one NEW idle
// checkpoint; it never starts a model or provider request.
// It preserves the original approved outline, first script, and character assets,
// then rebuilds all eight scene loops against the current workflow topology.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { orderRouteNodes, executionRouteEdges } from '../src/workflow-branch.ts'
import { orderLoopPlaceholders } from '../src/workflow-runner.ts'
import { scopedLoopNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const SOURCE_ID = 'record-4x5m31'
const SOURCE_MD5 = '74e5e2f8afcf8f829694aef350629950'
const CONTENT_HASHES = {
  outline: '74f1456f01fdf39d58a391e069c5e7b8f289b87ae4554c86b23acc330f13c712',
  scene1: '9aaa13bc42b7c529ae8a2b17e181bdbaac64b736651a8badafe09fcade1965bf',
  scene2: '86a2b90b3c4c6f8745eaeec9563e44b3158e03a4100cf758df13e8305892ad44',
  shot1: 'c9950ad09fb699a078d32337c81e6b632a814b71e9d8ecf140e94d4dc0cb4552',
  shot2Candidate: '6dbe6da0108dfcc1a22f74ef5556306dbc8382b185ba1d853340d7c10beb8cad',
  shot2: 'a0bd06afdcf6f8019f36c0a5d44b9209d27ec97673550090d72faea1ff31a8e3',
  firstArchive: '5ee411601f5d7311f724fbe87738c2fc864bb3d1fc7f9272731e37bbca7d68e9',
}
export { CONTENT_HASHES as ORIGINAL_TWO_SHOT_CONTENT_HASHES }
const NEW_IDS = [
  'sanguo-scene-cut-source-archive', 'sanguo-scene-cut-opening-plan',
  'sanguo-scene-cut-first-frame', 'sanguo-scene-cut-evidence-plan',
  'sanguo-scene-cut-evidence', 'sanguo-scene-cut-review', 'sanguo-scene-cut-approval',
]
const fail = message => { throw Error(`ORIGINAL_TWO_SHOT_FORK_INVALID: ${message}`) }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const outputFor = (runs, nodeId, loopIndex) => runs.find(run =>
  run.node?.id === nodeId && (loopIndex === undefined || run.loopIndex === loopIndex))?.output

function parseArguments(args) {
  const options = { id: 'record-4x5m31-original-retake-preview', apply: false, idProvided: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') {
      if (options.apply) fail('duplicate --apply')
      options.apply = true
      continue
    }
    const field = { '--id': 'id', '--expected-source-md5': 'sourceMd5',
      '--expected-nodes-md5': 'nodesMd5', '--expected-edges-md5': 'edgesMd5' }[flag]
    if (!field || (field === 'id' ? options.idProvided : options[field] !== undefined)
      || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[field] = args[++index]
    if (field === 'id') options.idProvided = true
  }
  if (!/^record-[\w-]+$/.test(options.id) || options.id === SOURCE_ID) fail('--id must be a distinct record identity')
  for (const field of ['sourceMd5', 'nodesMd5', 'edgesMd5']) {
    if (options[field] !== undefined && !/^[a-f0-9]{32}$/i.test(options[field])) fail(`${field} must be an MD5 hash`)
  }
  if (options.apply && (!options.idProvided || !options.sourceMd5 || !options.nodesMd5 || !options.edgesMd5)) {
    fail('--apply requires --id and all three reviewed source/nodes/edges MD5 hashes')
  }
  return options
}

function assertOriginalContent(runs) {
  const outline = outputFor(runs, 'sanguo-scene-outline-accept')
  const shot1 = outputFor(runs, 'sanguo-shot-script-accept', 0)
  const shot2Candidate = outputFor(runs, 'sanguo-shot-script', 1)
  const shot2 = outputFor(runs, 'sanguo-shot-script-accept', 1)
  const archive = outputFor(runs, 'sanguo-character-archive', 0)
  if (!outline || !Array.isArray(outline.scenes) || outline.scenes.length !== 8
    || !shot1?.passed || !shot2Candidate || !shot2?.passed || !archive) fail('approved original content is missing')
  const actual = {
    outline: sha256(outline), scene1: sha256(outline.scenes[0]), scene2: sha256(outline.scenes[1]),
    shot1: sha256(shot1), shot2Candidate: sha256(shot2Candidate),
    shot2: sha256(shot2), firstArchive: sha256(archive),
  }
  for (const [key, expected] of Object.entries(CONTENT_HASHES)) {
    if (actual[key] !== expected) fail(`original ${key} differs from the approved source`)
  }
  if (outline.scenes[0].id !== 'scene-01' || outline.scenes[1].id !== 'scene-02'
    || !outline.scenes[1].adaptationBoundary?.includes('由街口直接切至问讯，束缚和衣甲保持连续，不增拍无叙事增量的押送')
    || shot1.duration !== 13 || shot2.duration !== 10
    || !same(outline.scenes[0].requiredBeats[0].mustShow, [
      '张飞抬手示意军士合拢，封住严颜身前的缺口', '军士将严颜双腕缚住', '张飞走到严颜面前',
    ])
    || !same(shot1.pacing?.beats?.filter(beat => beat.kind === 'speech').map(beat => beat.textOrVocalization), [
      '刘备入益州后，转攻刘璋。', '他的部将张飞攻破江州，生擒刘璋的巴郡太守严颜。', '城破了，他会低头吗？',
    ])
    || !same(shot2.pacing?.beats?.filter(beat => beat.kind === 'speech').map(beat => beat.textOrVocalization), [
      '我们的大军已经到了，你为什么不投降，还要抵抗？',
    ])) fail('original visual, narration, or dialogue lock is incomplete')
  return actual
}

/** Pure preparation: callers may inspect the planned state before any insertion. */
export function prepareOriginalTwoShotForkPreview(source, workflow, {
  id = 'record-4x5m31-original-retake-preview', createdAt = '2026-09-29T00:00:00.000Z',
} = {}) {
  if (source?.id !== SOURCE_ID || source.workflow_id !== 'wf-sanguo-history-drama'
    || source.result_md5 !== SOURCE_MD5 || !source.result || !/^record-[\w-]+$/.test(id)
    || id === SOURCE_ID || !Number.isFinite(Date.parse(createdAt))) fail('source identity or MD5 is wrong')
  if (workflow?.id !== source.workflow_id || !Array.isArray(workflow.nodes)
    || !Array.isArray(workflow.edges) || workflow.schema_version < 169) fail('current Sanguo graph is unavailable')
  const original = decodeExecutionState(source.result)
  const runs = original.nodeRuns
  if (original.id !== SOURCE_ID || original.workflowId !== source.workflow_id
    || !Array.isArray(runs) || runs.some(run => run.status === 'running')) fail('source execution is malformed or active')
  const contentHashes = assertOriginalContent(runs)
  const graph = { id: workflow.id, schemaVersion: workflow.schema_version,
    nodes: workflow.nodes, edges: workflow.edges }
  const graphNodes = new Map(graph.nodes.map(node => [node.id, node]))
  if (graphNodes.size !== graph.nodes.length || NEW_IDS.some(nodeId => !graphNodes.has(nodeId))) fail('scene-cut gate graph is incomplete')
  const ordered = orderRouteNodes(graph)
  if (ordered.hasCycle) fail('current graph has a route cycle')
  const owner = graphNodes.get('sanguo-scene-loop')
  if (!owner?.loop?.enabled) fail('scene loop is unavailable')
  const currentChildren = scopedLoopNodes({ ...graph, edges: executionRouteEdges(graph) },
    owner.id, ordered.ordered)
  const currentIds = currentChildren.map(node => node.id)
  const staticIds = orderLoopPlaceholders(graph, ordered.ordered).map(node => node.id)
  const ownerIndex = runs.findIndex(run => run.node?.id === owner.id)
  const oldOwner = runs[ownerIndex]?.node
  const loopGroupId = runs[ownerIndex + 1]?.loopGroupId
  const sceneCount = outputFor(runs, 'sanguo-scene-outline-accept')?.scenes?.length
  const oldChildren = runs.filter(run => run.loopGroupId === loopGroupId && run.loopIndex === 0)
    .map(run => run.node.id)
  const commonChildCount = 16
  const boundary = ownerIndex + 1 + commonChildCount
  if (ownerIndex !== 8 || boundary !== 25 || !loopGroupId || sceneCount !== 8
    || runs[ownerIndex].status !== 'success' || runs[ownerIndex].output?.count !== sceneCount
    || oldChildren.length !== 49 || currentIds.length !== oldChildren.length + NEW_IDS.length
    || !same([...oldChildren].sort(), currentIds.filter(nodeId => !NEW_IDS.includes(nodeId)).sort())
    || !same(oldOwner.childIds, owner.childIds.filter(nodeId => !NEW_IDS.includes(nodeId)))
    || !same(oldChildren.slice(0, commonChildCount), currentIds.slice(0, commonChildCount))
    || !same(runs.slice(0, ownerIndex + 1).map(run => run.node.id), staticIds.slice(0, ownerIndex + 1))) {
    fail('source and current eight-round queue do not share the approved first-scene prefix')
  }
  const sourceRounds = Array.from({ length: sceneCount }, (_, loopIndex) =>
    runs.filter(run => run.loopGroupId === loopGroupId && run.loopIndex === loopIndex))
  const scenes = outputFor(runs, 'sanguo-scene-outline-accept').scenes
  if (sourceRounds.some((round, loopIndex) => round.length !== oldChildren.length
    || !isDeepStrictEqual(round[0]?.loopItem, scenes[loopIndex])
    || round.some((run, childIndex) => run.node.id !== oldChildren[childIndex]
      || run.loopGroupId !== loopGroupId || run.loopIndex !== loopIndex)
    || loopIndex > 1 && round.some(run => run.status !== 'idle'))
    || !same(runs.slice(ownerIndex + 1, ownerIndex + 1 + sceneCount * oldChildren.length)
      .map(run => run.node.id), Array.from({ length: sceneCount }, () => oldChildren).flat())) {
    fail('saved loop items, later rounds, or child order differ from the approved outline')
  }
  const oldOuter = runs.slice(ownerIndex + 1 + sceneCount * oldChildren.length)
  const newOuterIds = staticIds.slice(ownerIndex + 1 + currentIds.length)
  if (!same(oldOuter.map(run => run.node.id), newOuterIds) || oldOuter.some(run => run.status !== 'idle')) {
    fail('outer suffix is not the expected idle queue')
  }
  const sourceIds = new Set(runs.map(run => run.node.id))
  if ([...sourceIds].some(nodeId => !graphNodes.has(nodeId))
    || NEW_IDS.some(nodeId => sourceIds.has(nodeId))
    || sourceIds.size !== graphNodes.size - NEW_IDS.length) fail('source topology changed outside the scene-cut gate')
  const prefix = runs.slice(0, boundary)
  if (prefix.some((run, index) => {
    const node = graphNodes.get(run.node.id)
    if (index === 3) return !isDeepStrictEqual({ ...node, prompt: run.node.prompt }, run.node)
    if (index === ownerIndex) return !isDeepStrictEqual({ ...node, childIds: run.node.childIds }, run.node)
    return !isDeepStrictEqual(node, run.node)
      || (run.loopNode && !isDeepStrictEqual(run.loopNode, oldOwner))
  }) || prefix.some(run => !['success', 'skipped'].includes(run.status))) {
    fail('approved prefix has unreviewed node snapshot drift or unfinished work')
  }
  if (runs[boundary]?.node.id !== 'sanguo-first-frame-branch') fail('index 25 is no longer the first-frame branch')
  const preserved = prefix.map(run => ({ ...run, node: graphNodes.get(run.node.id),
    ...(run.loopNode ? { loopNode: owner } : {}) }))
  const idle = (node, loopIndex, childIndex, loopItem) => ({
    id: `${node.id}-${id}-${loopIndex}-${childIndex}`, node,
    label: `第 ${loopIndex + 1} 轮 / ${node.title} -> ${node.resultVar}`,
    output: undefined, context: {}, inputs: {}, inputContext: {}, status: 'idle', durationMs: 0,
    loopNode: owner, loopItem, loopIndex, loopPrevious: undefined, loopGroupId,
    loopIsLast: loopIndex === sceneCount - 1 && childIndex === currentChildren.length - 1,
  })
  const firstSuffix = currentChildren.slice(commonChildCount)
    .map((node, offset) => idle(node, 0, commonChildCount + offset, scenes[0]))
  const laterRounds = Array.from({ length: sceneCount - 1 }, (_, index) => index + 1)
    .flatMap(loopIndex => currentChildren.map((node, childIndex) => idle(node, loopIndex, childIndex, scenes[loopIndex])))
  const outer = oldOuter.map(run => ({ ...run, node: graphNodes.get(run.node.id) }))
  const nodeRuns = [...preserved, ...firstSuffix, ...laterRounds, ...outer]
  if (nodeRuns.length !== staticIds.length + (sceneCount - 1) * currentChildren.length
    || new Set(nodeRuns.map(run => run.id)).size !== nodeRuns.length
    || nodeRuns.findIndex(run => run.status === 'idle') !== boundary
    || nodeRuns[boundary].node.id !== 'sanguo-first-frame-branch'
    || nodeRuns.slice(boundary).some(run => run.status !== 'idle')) fail('rebuilt execution is not an idle first-frame retake')
  const prepared = prepareWorkflowRunContext(nodeRuns, boundary)
  if (prepared?.inputContext.shot_script?.id !== 'scene-01'
    || prepared.inputContext.shot_script?.passed !== true
    || sha256(prepared.inputContext.shot_script) !== CONTENT_HASHES.shot1
    || !prepared.inputContext.archived_character_assets
    || sha256(prepared.inputContext.archived_character_assets) !== CONTENT_HASHES.firstArchive
    || prepared.inputContext.video_take !== undefined
    || prepared.inputContext.scene?.id !== 'scene-01') {
    fail('retake context lost approved script/assets or retained old video')
  }
  const hash = createJsonHasher()
  const recovery = {
    version: `original-two-shot-content-lock-schema${graph.schemaVersion}-fork-v1`, sourceExecutionId: SOURCE_ID,
    sourceResultMd5: SOURCE_MD5, workflowSchemaVersion: graph.schemaVersion,
    workflowNodesMd5: workflow.nodes_md5, workflowEdgesMd5: workflow.edges_md5,
    contentHashes, preservedPrefixLength: boundary,
    preservedPrefixOutputsHash: hash(prefix.map(run => run.output ?? null)),
    secondShotCandidateRunId: runs.find(run => run.node.id === 'sanguo-shot-script' && run.loopIndex === 1)?.id,
    secondShotReferenceRunId: runs.find(run => run.node.id === 'sanguo-shot-script-accept' && run.loopIndex === 1)?.id,
    firstPendingNodeId: nodeRuns[boundary].node.id,
  }
  const state = { ...original, id, parentExecutionId: SOURCE_ID,
    requestScopeId: original.requestScopeId ?? SOURCE_ID, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns, context: runs[boundary - 1].context,
    selectedNodeId: nodeRuns[boundary].node.id, branchHistory: [],
    breakpointRollback: undefined, breakpointRollbackHistory: undefined,
    logs: [...preserved.map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `保留 ${SOURCE_ID} 的原批准内容和人物资产；首镜从 index25 重拍，次镜原脚本按 SHA 引用，原付费视频保留于父记录。`],
    originalTwoShotRepairRecovery: recovery,
    sceneCutFirstFrameRecovery: recovery,
  }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)) {
    fail('storage round-trip changed the proposed checkpoint')
  }
  return { state, proof: { ...recovery, newExecutionId: id, oldRunCount: runs.length,
    newRunCount: nodeRuns.length, sceneCount, oldChildCount: oldChildren.length,
    newChildCount: currentChildren.length, firstPendingIndex: boundary,
    preservedPrefixRunIdsHash: hash(prefix.map(run => run.id)),
    proposedPrefixRunIdsHash: hash(preserved.map(run => run.id)),
    oldPaidVideoRunId: runs.find(run => run.node.id === 'sanguo-video' && run.loopIndex === 0)?.id,
    secondPaidVideoRunId: runs.find(run => run.node.id === 'sanguo-video' && run.loopIndex === 1)?.id,
    oldPaidVideosRetainedOnlyInSource: true, modelCalls: 0,
    graphNodeIdSetMatches: true, roundTripVerified: true } }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
    const suffix = options.apply ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${suffix}`, [SOURCE_ID])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1${suffix}`, [source?.workflow_id])).rows[0]
    if (options.sourceMd5 && source?.result_md5 !== options.sourceMd5.toLowerCase()) fail('source MD5 differs from reviewed input')
    if (options.nodesMd5 && workflow?.nodes_md5 !== options.nodesMd5.toLowerCase()) fail('nodes MD5 differs from reviewed input')
    if (options.edgesMd5 && workflow?.edges_md5 !== options.edgesMd5.toLowerCase()) fail('edges MD5 differs from reviewed input')
    if (options.apply && workflow?.schema_version !== 171) fail('schema 171 must be saved before inserting an original-case checkpoint')
    if ((await db.query('SELECT 1 FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('preview record ID already exists')
    const { state, proof } = prepareOriginalTwoShotForkPreview(source, workflow, { id: options.id })
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `原双镜保真修复 · ${SOURCE_ID}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encodeExecutionState(state)),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result)) !== createJsonHasher()(state)) {
        fail('saved fork differs from the reviewed checkpoint')
      }
    }
    const sourceAfter = await db.query('SELECT md5(result::text) AS hash FROM execution_records WHERE id=$1', [SOURCE_ID])
    const workflowAfter = await db.query('SELECT schema_version,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflow.id])
    if (sourceAfter.rows[0]?.hash !== source.result_md5
      || workflowAfter.rows[0]?.schema_version !== workflow.schema_version
      || workflowAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || workflowAfter.rows[0]?.edges_md5 !== workflow.edges_md5) fail('source or workflow changed while preparing fork')
    await db.query('COMMIT')
    console.log(JSON.stringify({ ...proof, applied: options.apply, databaseWrites: options.apply ? 1 : 0,
      sourceResultMd5After: sourceAfter.rows[0].hash, workflowNodesMd5After: workflowAfter.rows[0].nodes_md5,
      workflowEdgesMd5After: workflowAfter.rows[0].edges_md5 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
