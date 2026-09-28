import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { createJsonHasher, parseArguments, prepareBranchCheckpoint, restoreBranchCheckpoint } from '../scripts/restore-branch-checkpoint.mjs'

const digest = '0123456789abcdef0123456789abcdef'
const options = { sourceId: 'source', historyIndex: 0, id: 'new-checkpoint', createdAt: '2026-01-01T00:00:00.000Z' }

function fixture() {
  const budget = { visits: 2, counts: { true: 0, false: 2 } }
  const scene = Array.from({ length: 40 }, (_, index) => ({
    id: `slot-${index}`, node: { id: `node-${index}`, kind: index === 34 ? 'branch' : 'text', resultVar: `result-${index}` },
    status: index <= 34 ? 'success' : 'idle', loopGroupId: 'loop', loopIndex: 0, loopNode: { id: 'loop' },
    output: (index <= 34 ? { index, passed: false, decision: 'uncertain', raw: { content: '原文\n { "unknown": true } ' } } : undefined) as unknown,
    context: { budget: { round: 2 } }, inputs: { instruction: '原要求' }, revision: 4, attempt: 2, errorAttempt: 2,
    branchState: index === 34 ? budget : undefined,
    attempts: undefined as unknown[] | undefined,
  }))
  const nodeRuns = scene.map((run, index) => ({ ...run, ...(index >= 27 ? { status: 'idle', output: undefined, revision: 5, attempt: 3,
    attempts: [{ output: run.output, attempt: run.attempt }] } : {}) }))
  const state = { id: 'source', workflowId: 'workflow', requestScopeId: 'paid-request-scope', nodeRuns,
    context: { budget: { round: 2 }, original: 'root context' }, logs: ['原日志'], historical: true,
    branchHistory: [{ from: 'node-34', to: 'node-27', backwards: true, value: false, branchState: budget, scene }] }
  const row = () => ({ id: 'source', workflow_id: 'workflow', workflow_name: 'Workflow', mode: 'step',
    title: 'Source', result_md5: digest, runtime_inputs: { prompt: '原要求' }, result: encodeExecutionState(state) })
  return { state, scene, row }
}

test('restoration preserves raw business outputs, every original slot, history, request identity and consumed budgets', () => {
  const { state, scene, row } = fixture(), source = row(), before = structuredClone(source)
  const result = prepareBranchCheckpoint(source, options)
  const hash = createJsonHasher()
  assert.deepEqual(source, before)
  assert.equal(result.state.id, 'new-checkpoint')
  assert.equal(result.state.requestScopeId, state.requestScopeId)
  assert.equal(hash(result.state.branchHistory), hash(state.branchHistory))
  assert.equal(hash(result.state.context), hash(state.context))
  assert.equal(result.state.nodeRuns.length, 40)
  for (const [index, run] of result.state.nodeRuns.entries()) {
    assert.deepEqual(run.output, scene[index].output)
    assert.equal(run.status, scene[index].status)
    assert.deepEqual(run.inputs, scene[index].inputs)
    assert.deepEqual(run.context, scene[index].context)
    assert.ok(run.attempt >= state.nodeRuns[index].attempt)
    assert.ok(run.revision >= state.nodeRuns[index].revision)
    assert.equal(hash(run.attempts ?? null), hash(state.nodeRuns[index].attempts ?? null))
  }
  assert.deepEqual(result.state.nodeRuns[34].branchState, state.nodeRuns[34].branchState)
  assert.equal(result.state.nodeRuns[32].output.passed, false)
  assert.equal(result.state.nodeRuns[32].output.decision, 'uncertain')
  assert.equal(result.state.nodeRuns[32].output.raw.content, '原文\n { "unknown": true } ')
  assert.equal(result.proof.allOutputHashesMatch, true)
  assert.equal(result.proof.prefix0Through31HashesMatch, true)
  assert.equal(result.proof.outputHashes.length, 40)
  assert.equal(hash(decodeExecutionState(JSON.parse(JSON.stringify(result.encoded)))), hash(result.state))
})

test('recovery rejects running, incomplete, mismatched scope and incomparable branch budgets', () => {
  for (const change of [
    ({ state }: ReturnType<typeof fixture>) => { state.nodeRuns[0].status = 'running' },
    ({ scene }: ReturnType<typeof fixture>) => { scene.pop() },
    ({ scene }: ReturnType<typeof fixture>) => { scene[1].loopIndex = 1 },
    ({ scene }: ReturnType<typeof fixture>) => { scene[1].id = scene[0].id },
    ({ scene }: ReturnType<typeof fixture>) => { scene[34].branchState = { visits: 3, counts: { true: 2, false: 1 } } },
  ]) {
    const data = fixture(); change(data)
    assert.throws(() => prepareBranchCheckpoint(data.row(), options), /BRANCH_CHECKPOINT_INVALID/)
  }
  assert.throws(() => prepareBranchCheckpoint(fixture().row(), { ...options, id: 'source' }), /NEW record/)
})

test('CLI defaults to dry run and requires exact explicit apply flag', () => {
  assert.equal(parseArguments(['--source', 'source', '--history-index', '0']).apply, false)
  assert.equal(parseArguments(['--source', 'source', '--history-index', '0', '--apply']).apply, true)
  for (const args of [[], ['--source', 'source', '--history-index', '-1'], ['--source', 'source', '--history-index', '0', '--apply=true']]) {
    assert.throws(() => parseArguments(args), /BRANCH_CHECKPOINT_INVALID/)
  }
})

function fakeDatabase(changeSource = false) {
  const source = fixture().row(), statements: string[] = []
  let inserted: Record<string, unknown> | undefined
  return { statements, async query(sql: string, params: unknown[] = []) {
    statements.push(sql)
    if (sql.startsWith('SELECT *')) return { rows: [source] }
    if (sql.startsWith('INSERT INTO')) { assert.notEqual(params[0], source.id); inserted = JSON.parse(String(params[6])); return { rows: [] } }
    if (sql.startsWith('SELECT result FROM')) return { rows: [{ result: inserted }] }
    if (sql.startsWith('SELECT md5')) return { rows: [{ result_md5: changeSource ? 'changed' : digest }] }
    return { rows: [] }
  } }
}

test('dry run cannot write; apply inserts only a new record and verifies source checksum', async () => {
  const dry = fakeDatabase(), dryProof = await restoreBranchCheckpoint(dry, { ...options, apply: false })
  assert.equal(dry.statements[0], 'BEGIN READ ONLY')
  assert.ok(dry.statements.every(sql => !/INSERT|UPDATE|DELETE/.test(sql)))
  assert.equal(dryProof.applied, false)
  assert.equal(dryProof.sourceResultMd5After, digest)
  const apply = fakeDatabase(), applyProof = await restoreBranchCheckpoint(apply, { ...options, apply: true, expectedMd5: digest })
  assert.equal(apply.statements.filter(sql => sql.startsWith('INSERT INTO')).length, 1)
  assert.ok(apply.statements.every(sql => !/UPDATE|DELETE/.test(sql)))
  assert.equal(applyProof.applied, true)
  assert.equal(apply.statements.at(-1), 'COMMIT')
  const changed = fakeDatabase(true)
  await assert.rejects(restoreBranchCheckpoint(changed, { ...options, apply: true }), /source changed/)
  assert.equal(changed.statements.at(-1), 'ROLLBACK')
  const stale = fakeDatabase()
  await assert.rejects(restoreBranchCheckpoint(stale, { ...options, apply: true, expectedMd5: 'wrong' }), /source MD5 differs/)
  assert.ok(stale.statements.every(sql => !sql.startsWith('INSERT')))
})
