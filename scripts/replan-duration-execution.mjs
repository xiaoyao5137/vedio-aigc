// Prepare a new duration-v2 execution from an approved outline. No node calls.
// Default is a read-only preview; --apply inserts one new execution record only.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { parseArguments } from './fork-execution-checkpoint.mjs'

export { parseArguments }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const fail = message => { throw new Error(`DURATION_REPLAN_INVALID: ${message}`) }
const SHOT = 'sanguo-shot-script', LOOP = 'sanguo-scene-loop', ACCEPT = 'sanguo-media-accept', REPLAN = 'sanguo-duration-replan'

/** Keep the ten approved prefix results, discard every downstream result and
 * retry budget, and rebuild pending definitions from the current workflow. */
export function prepareDurationReplan(source, workflow, { id = `record-duration-replan-${randomUUID()}`, createdAt = new Date().toISOString() } = {}) {
  if (!object(source) || !nonempty(source.id) || !nonempty(source.workflow_id) || !object(source.result)) fail('source record/result is missing')
  if (!nonempty(id) || id === source.id || id === source.result.requestScopeId) fail('a NEW record/request scope is required')
  if (!Number.isFinite(Date.parse(createdAt))) fail('invalid audit timestamp')
  const workflowSchema = workflow.schema_version ?? workflow.schemaVersion
  if (!object(workflow) || workflow.id !== source.workflow_id || !Number.isSafeInteger(workflowSchema) || workflowSchema < 115 || !Array.isArray(workflow.nodes)) fail('current duration-v2 workflow schema 115 or newer is required')
  const hash = createJsonHasher(), sourceHash = hash(source.result)
  const original = decodeExecutionState(source.result), state = structuredClone(original)
  if (state.id !== source.id || state.workflowId !== source.workflow_id || !Array.isArray(state.nodeRuns)) fail('source state identity/runs disagree')
  if (id === state.requestScopeId) fail('a NEW request scope is required')
  const byId = new Map(workflow.nodes.map(node => [node.id, node]))
  if (byId.size !== workflow.nodes.length) fail('duplicate current node IDs')
  const loop = byId.get(LOOP), replan = byId.get(REPLAN), writer = byId.get(SHOT)
  const pacingVersion = writer?.params?.find(param => (param.englishName ?? param.name) === 'pacingVersion')?.value
  if (pacingVersion !== 'duration-v2') fail('current workflow writer is not duration-v2')
  if (loop?.kind !== 'loop' || !Array.isArray(loop.childIds) || replan?.kind !== 'branch' || replan.parentId !== LOOP || !loop.childIds.includes(REPLAN)) fail('current duration replan loop topology is missing')
  const boundary = state.nodeRuns.findIndex(run => run.node?.id === SHOT)
  if (boundary !== 10) fail('expected the original ten-node approved prefix before the first shot script')
  const runIds = new Set()
  for (const [index, run] of state.nodeRuns.entries()) {
    const node = byId.get(run.node?.id)
    if (!object(run) || !nonempty(run.id) || runIds.has(run.id) || !node || node.kind !== run.node.kind) fail(`invalid/stale node identity at slot ${index}`)
    runIds.add(run.id)
    if (!['idle', 'success', 'failed', 'skipped'].includes(run.status)) fail(`active/invalid source run at slot ${index}`)
    if (index < boundary && !['success', 'skipped'].includes(run.status)) fail('approved prefix is incomplete')
    if (run.loopNode || run.loopGroupId || run.loopIndex !== undefined) {
      if (run.loopNode?.id !== LOOP || !nonempty(run.loopGroupId) || !Number.isSafeInteger(run.loopIndex) || run.loopIndex < 0 || !object(run.loopItem)) fail(`invalid loop scope at slot ${index}`)
      if (!loop.childIds.includes(run.node.id)) fail(`current loop no longer contains ${run.node.id}`)
    }
  }
  const prefix = state.nodeRuns.slice(0, boundary)
  const accepted = prefix.find(run => run.node.id === 'sanguo-scene-outline-accept')
  const approvedContext = structuredClone(prefix.filter(run => run.status === 'success').at(-1)?.context ?? {})
  if (accepted?.status !== 'success' || !object(approvedContext.approved_scene_outline) || approvedContext.approved_scene_outline.passed !== true || !Array.isArray(approvedContext.scene_outline?.scenes)) fail('approved outline evidence is missing')
  const suffixVars = new Set(workflow.nodes.filter(node => !prefix.some(run => run.node.id === node.id)).map(node => node.resultVar).filter(nonempty))
  for (const key of [...suffixVars, 'branch', 'retry', 'error', 'scene', 'loop', 'previous']) delete approvedContext[key]
  const scopes = new Map()
  for (const run of state.nodeRuns.filter(run => run.loopNode)) {
    const key = JSON.stringify([run.loopGroupId, run.loopIndex])
    const scope = scopes.get(key) ?? []
    if (scope.some(item => item.node.id === run.node.id)) fail(`duplicate loop node in iteration ${run.loopIndex}`)
    if (scope.length && hash(scope[0].loopItem) !== hash(run.loopItem)) fail(`loop story disagrees in iteration ${run.loopIndex}`)
    scope.push(run); scopes.set(key, scope)
  }
  for (const runs of scopes.values()) {
    if (runs.filter(run => run.node.id === SHOT).length !== 1 || runs.filter(run => run.node.id === ACCEPT).length !== 1) fail('every iteration needs one shot script and one media accept')
    if (hash(runs[0].loopItem) !== hash(approvedContext.scene_outline.scenes[runs[0].loopIndex] ?? null)) fail('loop story no longer matches the approved outline')
  }
  if (!scopes.size || scopes.size !== approvedContext.scene_outline.scenes.length) fail('expanded iterations do not cover the approved outline')
  // Prefix outputs/contexts stay exact. Only executable loop metadata is upgraded.
  for (const run of prefix) {
    if (run.node.id === LOOP) run.node = structuredClone(loop)
    if (run.loopNode) run.loopNode = structuredClone(loop)
  }
  let sequence = 0
  const fresh = (old, nodeId = old.node.id) => ({
    id: `${id}:run-${sequence++}`, node: structuredClone(byId.get(nodeId)),
    label: nodeId === old.node.id ? old.label ?? byId.get(nodeId).title : byId.get(nodeId).title,
    status: 'idle', durationMs: 0, context: {}, inputs: {}, inputContext: {},
    ...(old.loopNode ? { loopNode: structuredClone(loop), loopGroupId: old.loopGroupId,
      loopIndex: old.loopIndex, loopItem: structuredClone(old.loopItem), loopIsLast: old.loopIsLast === true } : {}),
  })
  const pending = []
  for (const old of state.nodeRuns.slice(boundary)) {
    // Always recreate the duration branch directly after acceptance, once.
    if (old.node.id === REPLAN) continue
    pending.push(fresh(old))
    if (old.node.id === ACCEPT) pending.push(fresh(old, REPLAN))
  }
  const newState = {
    id, workflowId: state.workflowId, workflowName: source.workflow_name ?? state.workflowName,
    mode: 'step', historical: false, requestScopeId: id, selectedNodeId: SHOT,
    runtimeInputs: structuredClone(source.runtime_inputs ?? state.runtimeInputs ?? {}),
    nodeRuns: [...prefix, ...pending], context: approvedContext, branchHistory: [],
    logs: [`从 ${source.id} 保留已批准大纲及前 ${boundary} 个节点结果；按当前时长策略 schema ${workflowSchema} 从首场分镜重新执行，旧分镜、媒体、验收及重试历史不继承。`],
    durationReplan: { sourceRecordId: source.id, sourceResultMd5: source.result_md5 ?? null, sourceResultHash: sourceHash, createdAt, workflowSchema, prefixLength: boundary },
  }
  const prefixEvidence = run => Object.fromEntries(Object.entries(run).filter(([key]) => !['node', 'loopNode'].includes(key)))
  const encoded = encodeExecutionState(newState)
  const proof = {
    format: 'duration-replan-proof-v1', sourceRecordId: source.id, newRecordId: id, createdAt,
    sourceResultMd5: source.result_md5 ?? null, sourceResultHash: sourceHash, workflowSchema,
    workflowDefinitionHash: hash(workflow.nodes), prefixLength: boundary, pendingCount: pending.length,
    runCount: newState.nodeRuns.length, iterationCount: scopes.size,
    prefixEvidencePreserved: prefix.every((run, index) => hash(prefixEvidence(run)) === hash(prefixEvidence(original.nodeRuns[index]))),
    loopStoriesPreserved: [...scopes.values()].every(runs => pending.filter(run => run.loopGroupId === runs[0].loopGroupId && run.loopIndex === runs[0].loopIndex).every(run => hash(run.loopItem) === hash(runs[0].loopItem))),
    newRequestScope: newState.requestScopeId !== (original.requestScopeId ?? original.id),
    pendingWithoutOutputOrHistory: pending.every(run => !['output', 'revision', 'attempt', 'attempts', 'branchState', 'branchCarry', 'retryFeedback', 'routeInputContext', 'loopPrevious'].some(key => Object.hasOwn(run, key))),
    insertedReplanCount: pending.filter(run => run.node.id === REPLAN).length,
    roundTripVerified: createJsonHasher()(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) === hash(newState),
    sourceUnchanged: createJsonHasher()(source.result) === sourceHash,
  }
  if (![proof.prefixEvidencePreserved, proof.loopStoriesPreserved, proof.newRequestScope, proof.pendingWithoutOutputOrHistory, proof.roundTripVerified, proof.sourceUnchanged].every(Boolean)) fail('prepared proof failed')
  return { state: newState, encoded, proof }
}

export async function replanDurationExecution(client, options) {
  if (!nonempty(options?.sourceId) || options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid source/apply options')
  const apply = options.apply === true
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
    if (!source) fail('source was not found')
    if (options.expectedMd5 && source.result_md5 !== options.expectedMd5.toLowerCase()) fail('source MD5 differs from the reviewed record')
    const workflow = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [source.workflow_id])).rows[0]
    const prepared = prepareDurationReplan(source, workflow, options)
    if (apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`, [state.id, source.workflow_id, state.workflowName,
        'step', `时长策略升级重排 · ${source.id}`, JSON.stringify(state.runtimeInputs), JSON.stringify(encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, 0, state.nodeRuns.length])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('inserted record differs from the preparation')
    }
    const md5After = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.result_md5
    if (md5After !== source.result_md5) fail('source changed during preparation')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: apply, sourceResultMd5After: md5After, sourceUnchanged: true }
  } catch (error) { await client.query('ROLLBACK'); throw error }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) { console.log('node scripts/replan-duration-execution.mjs --source RECORD [--id NEW_ID] [--proof FILE] [--expected-source-md5 MD5] [--apply]\nDefault is a read-only preview. --apply inserts one new record for UI resumption at the first shot script; no model calls, source changes, or workflow changes.'); return }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    const client = await pool.connect()
    let proof
    try { proof = await replanDurationExecution(client, options) } finally { client.release() }
    if (options.proofPath) await writeFile(options.proofPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify(proof, null, 2))
  } finally { await pool.end() }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
