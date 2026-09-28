// Restore an archived full branch scene into a NEW record. Default: read-only.
// node scripts/restore-branch-checkpoint.mjs --source RECORD --history-index INDEX
// Add --proof FILE to save the full hash proof; only --apply permits an INSERT.
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'

const own = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined
const fail = message => { throw new Error(`BRANCH_CHECKPOINT_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** JSON-value Merkle SHA-256: key-order independent, string bytes and array
 * order significant. Memoization avoids expanding shared historical graphs. */
export function createJsonHasher() {
  const cached = new WeakMap(), visiting = new WeakSet()
  const digest = text => createHash('sha256').update(text).digest('hex')
  const hash = value => {
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
      if (typeof value === 'number' && !Number.isFinite(value)) fail('non-finite JSON number')
      return digest(JSON.stringify(value))
    }
    if (!object(value) && !Array.isArray(value)) fail('non-JSON value')
    if (cached.has(value)) return cached.get(value)
    if (visiting.has(value)) fail('cyclic JSON value')
    visiting.add(value)
    const result = digest(Array.isArray(value)
      ? JSON.stringify(['array', value.map(item => hash(item === undefined ? null : item))])
      : JSON.stringify(['object', Object.keys(value).filter(key => own(value, key)).sort().map(key => [key, hash(value[key])])]))
    visiting.delete(value)
    cached.set(value, result)
    return result
  }
  return hash
}

function validateRuns(runs, label) {
  if (!Array.isArray(runs) || !runs.length) fail(`${label} has no complete run array`)
  const ids = new Set()
  for (const [index, run] of runs.entries()) {
    if (!object(run) || typeof run.id !== 'string' || !run.id || !object(run.node) || typeof run.node.id !== 'string' || !run.node.id) fail(`${label}[${index}] has no stable identity`)
    if (ids.has(run.id)) fail(`${label} contains duplicate run ID ${run.id}`)
    ids.add(run.id)
    if (!['idle', 'success', 'failed', 'skipped'].includes(run.status)) fail(`${label}[${index}] is running or has an invalid status`)
  }
}

function slotIdentity(run) {
  return [run.id, run.node.id, run.loopGroupId ?? null, run.loopIndex ?? null, run.loopNode?.id ?? null]
}

function preserveBranchBudget(current, archived, label) {
  const valid = state => {
    if (!object(state) || !object(state.counts) || [state.visits, state.counts.true, state.counts.false].some(value => !Number.isSafeInteger(value) || value < 0)) fail(`${label} has an invalid branch budget`)
    return state
  }
  if (current === undefined) return archived === undefined ? undefined : valid(archived)
  if (archived === undefined) return valid(current)
  valid(current); valid(archived)
  const dominates = (a, b) => a.visits >= b.visits && a.counts.true >= b.counts.true && a.counts.false >= b.counts.false
  // Select a real recorded state, never invent combined visit counts.
  if (dominates(current, archived)) return current
  if (dominates(archived, current)) return archived
  fail(`${label} contains incomparable branch budgets`)
}

function preserveCarry(current, archived, label, hash) {
  if (current !== undefined && !object(current) || archived !== undefined && !object(archived)) fail(`${label} has invalid branch carry`)
  if (current === undefined && archived === undefined) return undefined
  const result = { ...archived }
  for (const [id, value] of Object.entries(current ?? {})) {
    const old = result[id]
    if (!object(value) || old !== undefined && !object(old)) fail(`${label}.${id} has invalid branch carry`)
    if (old && (value.loopIndex !== old.loopIndex || hash(value.paramOverrides ?? {}) !== hash(old.paramOverrides ?? {}))) fail(`${label}.${id} has incompatible carry scope or parameters`)
    result[id] = { ...value, state: preserveBranchBudget(value.state, old?.state, `${label}.${id}`) }
  }
  for (const [id, value] of Object.entries(result)) {
    if (!object(value) || value.state === undefined) fail(`${label}.${id} has no carry budget`)
    preserveBranchBudget(value.state, undefined, `${label}.${id}`)
  }
  return result
}

function restoredRun(current, archived, index, hash) {
  if (hash(slotIdentity(current)) !== hash(slotIdentity(archived))) fail(`slot ${index} topology/scope does not match the source`)
  const run = { ...archived }
  for (const key of ['revision', 'attempt', 'errorAttempt']) {
    const values = [current[key], archived[key]].filter(value => value !== undefined)
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) fail(`slot ${index} has invalid ${key}`)
    if (values.length) run[key] = Math.max(...values)
  }
  for (const candidate of [current.attempts, archived.attempts]) if (candidate !== undefined && !Array.isArray(candidate)) fail(`slot ${index} has invalid attempt evidence`)
  if (current.attempts !== undefined || archived.attempts !== undefined) {
    const attempts = [...(current.attempts ?? [])], known = new Set(attempts.map(hash))
    for (const attempt of archived.attempts ?? []) if (!known.has(hash(attempt))) { attempts.push(attempt); known.add(hash(attempt)) }
    run.attempts = attempts
  }
  const branchState = preserveBranchBudget(current.branchState, archived.branchState, `slot ${index}`)
  const branchCarry = preserveCarry(current.branchCarry, archived.branchCarry, `slot ${index}`, hash)
  if (branchState !== undefined) run.branchState = branchState
  if (branchCarry !== undefined) run.branchCarry = branchCarry
  return run
}

/** Pure preparation. Neither the source row nor any business output is edited.
 * Full current root context retains policy budgets; each restored run keeps its
 * original scene inputs/context. This does not run, retry, normalize or accept. */
export function prepareBranchCheckpoint(source, { historyIndex, id = `record-branch-restore-${randomUUID()}`, createdAt = new Date().toISOString() }) {
  if (!object(source) || !object(source.result)) fail('source record/result is missing')
  if (!Number.isSafeInteger(historyIndex) || historyIndex < 0) fail('history index must be a nonnegative integer')
  if (typeof id !== 'string' || !id || id === source.id) fail('recovery requires a NEW record ID')
  const hash = createJsonHasher(), originalHash = hash(source.result)
  const state = decodeExecutionState(source.result)
  if (state.id !== source.id || state.workflowId !== source.workflow_id) fail('source record/state identity disagrees')
  validateRuns(state.nodeRuns, 'source')
  const history = state.branchHistory?.[historyIndex]
  if (!object(history) || history.backwards !== true || !Array.isArray(history.scene)) fail('selected history has no complete backward-branch scene')
  validateRuns(history.scene, 'history scene')
  if (history.scene.length !== state.nodeRuns.length) fail('selected scene does not contain every source slot')
  if (!history.scene.some(run => run.node.id === history.from) || !history.scene.some(run => run.node.id === history.to)) fail('selected branch endpoints do not exist in the scene')
  const nodeRuns = history.scene.map((run, index) => restoredRun(state.nodeRuns[index], run, index, hash))
  const recovered = {
    ...state, id, mode: 'step', historical: false, nodeRuns,
    requestScopeId: state.requestScopeId ?? state.id,
    selectedNodeId: history.from,
    logs: [...(state.logs ?? []), `从 ${source.id} 的分支历史 ${historyIndex} 恢复完整快照；原始输出和判定保持，等待人工选择重试节点。`],
  }
  const outputDigest = run => hash({ present: own(run, 'output'), ...(own(run, 'output') ? { output: run.output } : {}) })
  const outputHashes = nodeRuns.map((run, index) => ({ index, runId: run.id, nodeId: run.node.id,
    sourceScene: outputDigest(history.scene[index]), restored: outputDigest(run) }))
  const proof = {
    format: 'branch-checkpoint-proof-v1', hashAlgorithm: 'sha256-merkle-json-v1', createdAt,
    sourceRecordId: source.id, sourceResultMd5: source.result_md5 ?? null,
    newRecordId: id, historyIndex, from: history.from, to: history.to,
    runCount: nodeRuns.length, branchHistoryCount: state.branchHistory.length,
    sourceBranchHistoryHash: hash(state.branchHistory), restoredBranchHistoryHash: hash(recovered.branchHistory),
    sourceContextHash: hash(state.context ?? null), restoredContextHash: hash(recovered.context ?? null),
    requestScopeIdPreserved: recovered.requestScopeId === (state.requestScopeId ?? state.id),
    allOutputHashesMatch: outputHashes.every(item => item.sourceScene === item.restored),
    prefix0Through31HashesMatch: outputHashes.slice(0, 32).every(item => item.sourceScene === item.restored),
    outputHashes,
    counterChanges: nodeRuns.flatMap((run, index) => ['revision', 'attempt', 'errorAttempt', 'branchState', 'branchCarry'].flatMap(key =>
      hash(run[key] ?? null) === hash(history.scene[index][key] ?? null) ? [] : [{ index, field: key, sourceScene: history.scene[index][key] ?? null, restored: run[key] ?? null }])),
  }
  recovered.branchCheckpointRecovery = proof
  const encoded = encodeExecutionState(recovered)
  const roundTrip = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (roundTrip.nodeRuns.some((run, index) => outputDigest(run) !== outputHashes[index].sourceScene || run.status !== history.scene[index].status)) fail('serialization changed a business output or execution status')
  if (hash(roundTrip.branchHistory) !== proof.sourceBranchHistoryHash || hash(roundTrip.context ?? null) !== proof.sourceContextHash) fail('serialization changed source history or root context')
  // A fresh hasher catches unintended mutation even if prior identities were memoized.
  if (createJsonHasher()(source.result) !== originalHash) fail('preparation mutated the source')
  return { state: recovered, encoded, proof }
}

export function parseArguments(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--source': 'sourceId', '--history-index': 'historyIndex', '--proof': 'proofPath', '--expected-source-md5': 'expectedMd5', '--id': 'id' }[flag]
    if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (options.help) return options
  if (!options.sourceId || !/^\d+$/.test(options.historyIndex ?? '')) fail('--source and --history-index are required')
  options.historyIndex = Number(options.historyIndex)
  if (!Number.isSafeInteger(options.historyIndex)) fail('history index is outside the supported range')
  if (options.expectedMd5 !== undefined && !/^[a-f\d]{32}$/i.test(options.expectedMd5)) fail('--expected-source-md5 must be a 32-digit MD5')
  return options
}

export async function restoreBranchCheckpoint(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const sourceQuery = `SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`
    const source = (await client.query(sourceQuery, [options.sourceId])).rows[0]
    if (!source) fail('source record was not found')
    if (options.expectedMd5 && source.result_md5 !== options.expectedMd5.toLowerCase()) fail('source MD5 differs from the reviewed checkpoint')
    const prepared = prepareBranchCheckpoint(source, options)
    if (options.apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`, [
        state.id, source.workflow_id, source.workflow_name, 'step', `分支快照恢复 · ${source.id} · 历史 ${options.historyIndex}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.filter(run => run.status === 'failed').length, state.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('inserted record does not match the prepared checkpoint')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.result_md5
    if (sourceAfter !== source.result_md5) fail('source changed during recovery')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: options.apply === true, sourceResultMd5After: sourceAfter, sourceUnchanged: true }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/restore-branch-checkpoint.mjs --source RECORD --history-index INDEX [--proof FILE] [--id NEW_ID] [--expected-source-md5 MD5] [--apply]\nDefault is a read-only dry run. --apply inserts one new record and never updates the source.')
    return
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    const client = await pool.connect()
    let proof
    try { proof = await restoreBranchCheckpoint(client, options) } finally { client.release() }
    if (options.proofPath) await writeFile(options.proofPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    const { outputHashes, counterChanges, ...summary } = proof
    console.log(JSON.stringify({ ...summary, changedCounterFields: counterChanges.length, outputHashCount: outputHashes.length,
      ...(options.proofPath ? { proofPath: options.proofPath } : { outputHashes, counterChanges }) }, null, 2))
  } finally { await pool.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
