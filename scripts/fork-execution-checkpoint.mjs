// Fork a complete execution checkpoint without rerunning or adopting any work.
// Default: read-only preview. Only --apply inserts one NEW record.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const own = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined
const fail = message => { throw new Error(`EXECUTION_CHECKPOINT_INVALID: ${message}`) }

function validateRuns(runs) {
  if (!Array.isArray(runs) || !runs.length) fail('source has no complete run array')
  const ids = new Set()
  for (const [index, run] of runs.entries()) {
    if (!object(run) || !nonempty(run.id) || !object(run.node) || !nonempty(run.node.id) || !nonempty(run.node.kind)) fail(`slot ${index} has no stable node/run identity`)
    if (ids.has(run.id)) fail(`duplicate run ID at slot ${index}`)
    ids.add(run.id)
    if (!['idle', 'success', 'failed', 'skipped'].includes(run.status)) fail(`slot ${index} is running or has an invalid status`)
    for (const key of ['revision', 'attempt', 'errorAttempt', 'loopIndex']) {
      if (run[key] !== undefined && (!Number.isSafeInteger(run[key]) || run[key] < 0)) fail(`slot ${index} has invalid ${key}`)
    }
    if (run.loopGroupId !== undefined && !nonempty(run.loopGroupId)) fail(`slot ${index} has invalid loopGroupId`)
    if (run.loopNode !== undefined && (!object(run.loopNode) || !nonempty(run.loopNode.id))) fail(`slot ${index} has invalid loopNode`)
    if (run.attempts !== undefined && !Array.isArray(run.attempts)) fail(`slot ${index} has invalid attempt evidence`)
    for (const key of ['context', 'inputs', 'inputContext', 'routeInputContext', 'routeInputOverrides', 'branchState', 'branchCarry']) {
      if (run[key] !== undefined && !object(run[key])) fail(`slot ${index} has invalid ${key}`)
    }
  }
}

/** Pure preparation. All node definitions, outputs, contexts, history, budgets
 * and attempt evidence remain exact. The normal UI refreshes idle definitions
 * from its active workflow when it resumes; this helper never edits workflows. */
export function prepareExecutionCheckpoint(source, { id = `record-checkpoint-fork-${randomUUID()}`, createdAt = new Date().toISOString() } = {}) {
  if (!object(source) || !nonempty(source.id) || !nonempty(source.workflow_id) || !object(source.result)) fail('source record/result is missing')
  if (!nonempty(id) || id === source.id) fail('fork requires a NEW record ID')
  if (!nonempty(createdAt) || !Number.isFinite(Date.parse(createdAt))) fail('invalid audit timestamp')
  const hash = createJsonHasher(), sourceResultHash = hash(source.result)
  const state = decodeExecutionState(source.result)
  if (!object(state) || state.id !== source.id || state.workflowId !== source.workflow_id) fail('source record/state identity disagrees')
  if (state.requestScopeId !== undefined && !nonempty(state.requestScopeId)) fail('invalid requestScopeId')
  if (state.context !== undefined && !object(state.context)) fail('invalid root context')
  if (state.branchHistory !== undefined && !Array.isArray(state.branchHistory)) fail('invalid branch history')
  if (state.logs !== undefined && (!Array.isArray(state.logs) || state.logs.some(line => typeof line !== 'string'))) fail('invalid audit logs')
  validateRuns(state.nodeRuns)
  const forked = {
    ...state, id, mode: 'step', historical: false,
    requestScopeId: state.requestScopeId ?? state.id,
    logs: [...(state.logs ?? []), `从 ${source.id} 创建完整执行检查点副本；全部原始输出、分支历史及已用预算保持，等待继续执行。`],
  }
  const outputDigest = run => hash({ present: own(run, 'output'), ...(own(run, 'output') ? { output: run.output } : {}) })
  const outputHashes = state.nodeRuns.map((run, index) => ({ index, runId: run.id, nodeId: run.node.id,
    source: outputDigest(run), forked: outputDigest(forked.nodeRuns[index]) }))
  const firstPending = state.nodeRuns.findIndex(run => !['success', 'skipped'].includes(run.status))
  const completedPrefixLength = firstPending < 0 ? state.nodeRuns.length : firstPending
  const paidPrefixIndexes = state.nodeRuns.slice(0, completedPrefixLength).flatMap((run, index) =>
    run.status === 'success' && ['image', 'video'].includes(run.node.kind) ? [index] : [])
  const proof = {
    format: 'execution-checkpoint-fork-proof-v1', hashAlgorithm: 'sha256-merkle-json-v1', createdAt,
    sourceRecordId: source.id, sourceResultMd5: source.result_md5 ?? null, sourceResultHash,
    newRecordId: id, runCount: state.nodeRuns.length, completedPrefixLength, paidPrefixIndexes,
    sourceNodeRunsHash: hash(state.nodeRuns), forkedNodeRunsHash: hash(forked.nodeRuns),
    sourceContextHash: hash(state.context ?? null), forkedContextHash: hash(forked.context ?? null),
    sourceBranchHistoryHash: hash(state.branchHistory ?? null), forkedBranchHistoryHash: hash(forked.branchHistory ?? null),
    branchHistoryCount: state.branchHistory?.length ?? 0,
    requestScopeIdPreserved: forked.requestScopeId === (state.requestScopeId ?? state.id),
    allOutputHashesMatch: outputHashes.every(item => item.source === item.forked),
    completedPrefixHashesMatch: hash(state.nodeRuns.slice(0, completedPrefixLength)) === hash(forked.nodeRuns.slice(0, completedPrefixLength)),
    paidPrefixHashesMatch: paidPrefixIndexes.every(index => hash(state.nodeRuns[index]) === hash(forked.nodeRuns[index])),
    outputHashes,
  }
  forked.checkpointFork = proof
  const encoded = encodeExecutionState(forked)
  const roundTrip = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (createJsonHasher()(roundTrip) !== hash(forked)) fail('serialization changed the prepared checkpoint')
  if (createJsonHasher()(source.result) !== sourceResultHash) fail('preparation mutated the source')
  return { state: forked, encoded, proof: { ...proof, roundTripVerified: true, sourceUnchanged: true } }
}

export function parseArguments(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--source': 'sourceId', '--proof': 'proofPath', '--id': 'id', '--expected-source-md5': 'expectedMd5' }[flag]
    if (!key || options[key] !== undefined || !nonempty(args[index + 1]) || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (options.help) return options
  if (!options.sourceId) fail('--source is required')
  if (options.expectedMd5 !== undefined && !/^[a-f\d]{32}$/i.test(options.expectedMd5)) fail('--expected-source-md5 must be a 32-digit MD5')
  return options
}

export async function forkExecutionCheckpoint(client, options) {
  if (!nonempty(options?.sourceId) || options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid source/apply options')
  const apply = options.apply === true
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
    if (!source) fail('source record was not found')
    if (options.expectedMd5 && source.result_md5 !== options.expectedMd5.toLowerCase()) fail('source MD5 differs from the reviewed checkpoint')
    const prepared = prepareExecutionCheckpoint(source, options)
    if (apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`, [
        state.id, source.workflow_id, source.workflow_name, 'step', `执行检查点副本 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.filter(run => run.status === 'failed').length, state.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('inserted record does not match the prepared checkpoint')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.result_md5
    if (sourceAfter !== source.result_md5) fail('source changed during fork')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: apply, sourceResultMd5After: sourceAfter, sourceUnchanged: true }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-execution-checkpoint.mjs --source RECORD [--id NEW_ID] [--proof FILE] [--expected-source-md5 MD5] [--apply]\nDefault is a read-only preview. --apply inserts one new record; it never executes nodes or updates the source/workflow.')
    return
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    const client = await pool.connect()
    let proof
    try { proof = await forkExecutionCheckpoint(client, options) } finally { client.release() }
    if (options.proofPath) await writeFile(options.proofPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    const { outputHashes, ...summary } = proof
    console.log(JSON.stringify({ ...summary, outputHashCount: outputHashes.length,
      ...(options.proofPath ? { proofPath: options.proofPath } : { outputHashes }) }, null, 2))
  } finally { await pool.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
