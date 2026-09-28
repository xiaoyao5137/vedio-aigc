import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { forkExecutionCheckpoint, parseArguments, prepareExecutionCheckpoint } from '../scripts/fork-execution-checkpoint.mjs'

const digest = '0123456789abcdef0123456789abcdef'
const options = { sourceId: 'source', id: 'new-checkpoint', createdAt: '2026-09-08T00:00:00.000Z' }

// JSON fields deliberately accept malformed values in the rejection fixtures;
// only the nested objects accessed by those mutations need a fixed shape.
type CheckpointFixture = Record<string, unknown> & {
  nodeRuns: Array<Record<string, unknown> & { node: Record<string, unknown> }>
}

function fixture() {
  const context = { video_take: { url: '/generated/paid.mp4', raw: '原结果\n' }, budget: { visits: 3 } }
  const nodeRuns = Array.from({ length: 7 }, (_, index) => ({
    id: `run-${index}`, node: { id: `node-${index}`, kind: index === 0 ? 'image' : index === 1 ? 'video' : 'text', modelId: 'original-model' },
    status: index < 3 ? 'success' : index === 3 ? 'skipped' : 'idle',
    context, inputs: { original: '原请求' }, inputContext: context,
    output: index < 4 ? { index, ...context.video_take, passed: false, decision: 'uncertain' } : undefined,
    revision: 4, attempt: 3, errorAttempt: 2,
    attempts: [{ status: 'failed', output: { accepted: false }, attempt: 2 }],
    branchState: { visits: 3, counts: { true: 1, false: 2 } },
    branchCarry: { gate: { state: { visits: 2, counts: { true: 0, false: 2 } }, loopIndex: 0 } },
    loopNode: { id: 'loop' }, loopGroupId: 'group', loopIndex: 0,
  }))
  const state: CheckpointFixture = { id: 'source', workflowId: 'workflow', mode: 'auto', historical: true,
    requestScopeId: 'paid-request-scope', nodeRuns, context, logs: ['保留原日志'],
    branchHistory: [{ from: 'node-3', to: 'node-1', backwards: true, scene: nodeRuns }], customAudit: { retained: true } }
  const row = () => ({ id: 'source', workflow_id: 'workflow', workflow_name: 'Workflow', result_md5: digest,
    runtime_inputs: { input: { prompt: '保留输入' } }, result: encodeExecutionState(state) })
  return { state, row }
}

test('fork preserves every run, paid output, rejection, context, history and consumed counter with a lossless round trip', () => {
  const { state, row } = fixture(), source = row(), before = structuredClone(source)
  const prepared = prepareExecutionCheckpoint(source, options), hash = createJsonHasher()
  assert.deepEqual(source, before)
  assert.equal(prepared.state.id, options.id)
  assert.equal(prepared.state.mode, 'step')
  assert.equal(prepared.state.historical, false)
  assert.equal(prepared.state.requestScopeId, state.requestScopeId)
  for (const key of ['nodeRuns', 'context', 'branchHistory', 'customAudit']) assert.equal(hash(prepared.state[key]), hash(state[key]))
  assert.deepEqual(prepared.state.logs.slice(0, -1), state.logs)
  assert.equal(prepared.state.nodeRuns[1].output.passed, false)
  assert.equal(prepared.state.nodeRuns[1].output.decision, 'uncertain')
  assert.equal(prepared.proof.sourceResultHash, hash(source.result))
  assert.equal(prepared.proof.completedPrefixLength, 4)
  assert.deepEqual(prepared.proof.paidPrefixIndexes, [0, 1])
  assert.equal(prepared.proof.paidPrefixHashesMatch, true)
  assert.equal(prepared.proof.completedPrefixHashesMatch, true)
  assert.equal(prepared.proof.allOutputHashesMatch, true)
  assert.equal(prepared.proof.roundTripVerified, true)
  assert.equal(prepared.proof.outputHashes.length, state.nodeRuns.length)
  assert.equal(hash(decodeExecutionState(JSON.parse(JSON.stringify(prepared.encoded)))), hash(prepared.state))
})

test('legacy unencoded checkpoints keep missing output distinct from null and fall back to the original request scope', () => {
  const { state, row } = fixture()
  delete state.requestScopeId
  state.nodeRuns[4].output = null
  delete state.nodeRuns[5].output
  const prepared = prepareExecutionCheckpoint({ ...row(), result: state }, options)
  assert.equal(prepared.state.requestScopeId, 'source')
  assert.equal(prepared.state.nodeRuns[4].output, null)
  assert.equal(Object.hasOwn(prepared.state.nodeRuns[5], 'output'), false)
  assert.notEqual(prepared.proof.outputHashes[4].source, prepared.proof.outputHashes[5].source)
})

test('fork rejects active or invalid runs, identities and malformed evidence without changing the source', () => {
  for (const change of [
    (s: CheckpointFixture) => { s.nodeRuns[4].status = 'running' },
    (s: CheckpointFixture) => { s.nodeRuns[4].status = 'accepted' },
    (s: CheckpointFixture) => { s.nodeRuns[4].id = s.nodeRuns[0].id },
    (s: CheckpointFixture) => { s.nodeRuns[4].node.kind = '' },
    (s: CheckpointFixture) => { s.nodeRuns[4].attempt = -1 },
    (s: CheckpointFixture) => { s.nodeRuns[4].revision = 1.5 },
    (s: CheckpointFixture) => { s.nodeRuns[4].loopIndex = -1 },
    (s: CheckpointFixture) => { s.nodeRuns[4].attempts = {} },
    (s: CheckpointFixture) => { s.nodeRuns[4].branchCarry = [] },
    (s: CheckpointFixture) => { s.nodeRuns = [] },
    (s: CheckpointFixture) => { s.id = 'different' },
    (s: CheckpointFixture) => { s.workflowId = 'different' },
    (s: CheckpointFixture) => { s.requestScopeId = '' },
    (s: CheckpointFixture) => { s.branchHistory = {} },
    (s: CheckpointFixture) => { s.context = [] },
    (s: CheckpointFixture) => { s.logs = [{}] },
  ]) {
    const { state, row } = fixture(); change(state)
    const source = row(), before = structuredClone(source)
    assert.throws(() => prepareExecutionCheckpoint(source, options), /EXECUTION_CHECKPOINT_INVALID/)
    assert.deepEqual(source, before)
  }
  assert.throws(() => prepareExecutionCheckpoint(fixture().row(), { ...options, id: 'source' }), /NEW record/)
})

test('CLI requires exact explicit apply and validates every argument', () => {
  assert.equal(parseArguments(['--source', 'source']).apply, false)
  assert.equal(parseArguments(['--source', 'source', '--apply']).apply, true)
  assert.equal(parseArguments(['--source', 'source', '--proof', 'proof.json', '--id', 'fork', '--expected-source-md5', digest]).id, 'fork')
  for (const args of [[], ['--apply'], ['--source'], ['--source', 'source', '--apply=true'], ['--source', 'source', '--apply', '--apply'],
    ['--source', 'source', '--source', 'again'], ['--source', 'source', '--id'], ['--source', 'source', '--expected-source-md5', 'bad']]) {
    assert.throws(() => parseArguments(args), /EXECUTION_CHECKPOINT_INVALID/)
  }
})

function fakeDatabase({ changed = false, corruptInsert = false, missing = false } = {}) {
  const source = fixture().row(), statements: string[] = []
  let inserted: Record<string, unknown> | undefined
  return { statements, async query(sql: string, params: unknown[] = []) {
    statements.push(sql)
    if (sql.startsWith('SELECT *')) return { rows: missing ? [] : [source] }
    if (sql.startsWith('INSERT INTO')) {
      assert.notEqual(params[0], source.id)
      assert.deepEqual(JSON.parse(String(params[5])), source.runtime_inputs)
      inserted = JSON.parse(String(params[6]))
      if (corruptInsert) inserted!.id = 'corrupted'
      return { rows: [] }
    }
    if (sql.startsWith('SELECT result FROM')) return { rows: [{ result: inserted }] }
    if (sql.startsWith('SELECT md5')) return { rows: [{ result_md5: changed ? 'changed' : digest }] }
    return { rows: [] }
  } }
}

test('default database preview is read-only; apply inserts exactly one new record with preserved runtime inputs', async () => {
  const dry = fakeDatabase(), preview = await forkExecutionCheckpoint(dry, options)
  assert.equal(dry.statements[0], 'BEGIN READ ONLY')
  assert.ok(dry.statements.every(sql => !/INSERT|UPDATE|DELETE/.test(sql)))
  assert.equal(preview.applied, false)
  assert.equal(preview.sourceResultMd5After, digest)
  const apply = fakeDatabase(), proof = await forkExecutionCheckpoint(apply, { ...options, apply: true, expectedMd5: digest })
  assert.equal(apply.statements.filter(sql => sql.startsWith('INSERT INTO')).length, 1)
  assert.ok(apply.statements.every(sql => !/UPDATE|DELETE/.test(sql)))
  assert.ok(apply.statements[1].endsWith('FOR SHARE'))
  assert.equal(apply.statements.at(-1), 'COMMIT')
  assert.equal(proof.applied, true)
  assert.equal(proof.sourceUnchanged, true)
})

test('stale sources and bad readback roll back; missing or active sources never insert', async () => {
  for (const [db, overrides, error] of [
    [fakeDatabase({ changed: true }), {}, /source changed/],
    [fakeDatabase({ corruptInsert: true }), {}, /inserted record/],
    [fakeDatabase({ missing: true }), {}, /not found/],
    [fakeDatabase(), { expectedMd5: 'ffffffffffffffffffffffffffffffff' }, /source MD5 differs/],
  ] as const) {
    await assert.rejects(forkExecutionCheckpoint(db, { ...options, apply: true, ...overrides }), error)
    assert.equal(db.statements.at(-1), 'ROLLBACK')
    if (/not found|MD5/.test(error.source)) assert.ok(db.statements.every(sql => !sql.startsWith('INSERT')))
  }
  await assert.rejects(forkExecutionCheckpoint(fakeDatabase(), { ...options, apply: 'true' }), /invalid source\/apply/)
})
