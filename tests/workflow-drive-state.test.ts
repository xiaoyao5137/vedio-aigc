import test from 'node:test'
import assert from 'node:assert/strict'
import { DRIVE_RECORD_PROJECTION_SQL, DRIVE_RECORD_TRIM_CHARS, completedProviderRegression, driveOutputSummary, driveRecord, failureSignature, isRetryFork, loopTargetOutcome, parseRuntimeInputs, pendingManualDecision, runtimeInputMismatch, sameExecutionScope, targetOutcome } from '../scripts/workflow-drive-state.mjs'
import { encodeExecutionState } from '../src/execution-storage.ts'
import { executeCodeNode } from '../server/code-node.ts'
import pg from 'pg'
import process from 'node:process'

const nodeRun = (output: unknown, extra = {}) => ({ id: 'accept-loop-0', node: { id: 'accept', kind: 'code' }, status: 'success', revision: 0, loopIndex: 0, output, ...extra })
const record = (runs: unknown[], extra = {}) => driveRecord({ id: 'original', workflow_id: 'workflow', created_at: '2026-09-08T00:00:00Z', result: { nodeRuns: runs }, ...extra })

test('target requires the actual first-loop output and an affirmative report', () => {
  for (const output of [undefined, null, {}, '', { routeError: 'REVIEW_RESULT_INVALID: missing observation' }, { error: 'failed' }, { passed: false }, { videoAccepted: false }, { accepted: false }, { ok: false }, { success: false }]) {
    const target = targetOutcome(record([nodeRun(output), nodeRun(undefined, { id: 'next-paid-run', node: { id: 'next-video', kind: 'video' }, status: 'idle' })]), 'accept')
    assert.equal(target.done, false, JSON.stringify(output))
    assert.equal(target.settled, true, 'a rejected target must stop the driver before any downstream branch or paid node')
  }
  for (const status of ['idle', 'running']) assert.equal(targetOutcome(record([nodeRun(undefined, { status })]), 'accept').settled, false)
  assert.equal(targetOutcome(record([nodeRun({ passed: true })]), 'accept').done, true)
  assert.equal(targetOutcome(record([nodeRun(true)]), 'accept').done, true)
  const rounds = record([nodeRun({ passed: false }), nodeRun({ passed: true }, { id: 'accept-loop-1', loopIndex: 1 })])
  assert.equal(targetOutcome(rounds, 'accept').done, false, 'later round must not hide the rejected first round')
  assert.equal(targetOutcome(rounds, 'accept', 1).done, true, 'an explicit execution slot can target a later loop round')
  assert.equal(targetOutcome(rounds, 'accept', 2).reason, 'target not scheduled')
})

test('video success requires a URL; an acceptance report may succeed without a media URL', () => {
  const video = (output: unknown) => record([nodeRun(output, { node: { id: 'video', kind: 'video' } })])
  for (const output of [{ taskId: 'paid-but-pending' }, { url: ' ' }, { url: '/generated/rejected.mp4', passed: false }]) {
    assert.equal(targetOutcome(video(output), 'video').done, false)
  }
  const result = targetOutcome(video({ url: '/generated/accepted.mp4' }), 'video')
  assert.equal(result.done, true)
  assert.equal(result.url, '/generated/accepted.mp4')
  assert.equal(targetOutcome(record([nodeRun({ passed: true })]), 'accept').done, true)
})

test('loop target verifies five actual iterations regardless of execution indices', () => {
  const rounds = Array.from({ length: 6 }, (_, loopIndex) => [
    nodeRun({ passed: true }, { id: `unrelated-${loopIndex}`, node: { id: 'other', kind: 'code' }, loopIndex }),
    nodeRun({ url: `/generated/round-${loopIndex + 1}.mp4` }, { id: `video-${loopIndex}`, node: { id: 'video', kind: 'video' }, loopIndex }),
  ]).flat()
  const result = loopTargetOutcome(record(rounds), 'video', 5)
  assert.equal(result.done, true)
  assert.equal(result.run.loopIndex, 4)
  assert.equal(result.run.index, 9)
  assert.equal(result.completed.length, 5)
  assert.equal(loopTargetOutcome(record(rounds.filter(run => run.loopIndex !== 2)), 'video', 5).done, false)
  assert.equal(loopTargetOutcome(record(rounds.map(run => run.id === 'video-1' ? { ...run, output: { passed: false } } : run)), 'video', 5).reason, 'loop 2: passed=false')
  assert.equal(loopTargetOutcome(record(rounds.map(run => run.id === 'video-4' ? { ...run, status: 'running' } : run)), 'video', 5).settled, false)
  assert.equal(loopTargetOutcome(record([...rounds, rounds[1]]), 'video', 5).settled, true, 'ambiguous same-round occurrences must not silently select a green one')
  assert.throws(() => loopTargetOutcome(record(rounds), 'video', 0), /positive integer/)
})

test('runtime input overrides require nested JSON and verify the exact requested subset', () => {
  const inputs = parseRuntimeInputs('{"input":{"episode_number":41},"extra":{"settings":{"b":2,"a":1}}}')
  const actual = { input: { episode_number: 41, aspect_ratio: '16:9' }, extra: { settings: { a: 1, b: 2 }, qualityDisposition: 'manual-review-v1' } }
  assert.equal(runtimeInputMismatch(actual, inputs), undefined, 'existing unrelated inputs remain valid')
  assert.match(runtimeInputMismatch({ ...actual, input: { episode_number: 43 } }, inputs), /input.episode_number: expected 41, stored 43/)
  assert.match(runtimeInputMismatch({ ...actual, input: { episode_number: '41' } }, inputs), /stored "41"/, 'a numeric input must not verify as a string')
  assert.match(runtimeInputMismatch({}, inputs), /stored undefined/)
  assert.equal(runtimeInputMismatch({ input: { list: [1, { a: 2 }], nothing: null } }, { input: { list: [1, { a: 2 }], nothing: null } }), undefined)
  assert.match(runtimeInputMismatch({ input: { list: [2, 1] } }, { input: { list: [1, 2] } }), /input.list/)
  for (const invalid of ['', '{', 'null', '[]', '{}', '{"input":41}', '{"input":{}}', '{"input":[]}']) assert.throws(() => parseRuntimeInputs(invalid), /--runtime-inputs/)
})

test('code runner logs and empty return wrappers are not a deliverable output', async () => {
  for (const code of ['console.log("ran");', 'return {};', 'return null;', 'return [];']) {
    const output = await executeCodeNode({ code })
    assert.equal(targetOutcome(record([nodeRun(output)]), 'accept').done, false, code)
  }
  const output = await executeCodeNode({ code: 'return {passed:true};' })
  assert.equal(targetOutcome(record([nodeRun(output)]), 'accept').done, true)
})

test('fork observation follows paid work while pending or failed, without claiming independent runs', () => {
  const original = record([nodeRun({ error: 'old error' }, { status: 'failed' })])
  for (const status of ['idle', 'running', 'success', 'failed']) {
    const candidate = record([], { id: `fork-${status}`, created_at: '2026-09-08T00:01:00Z', result: { requestScopeId: 'original', nodeRuns: [nodeRun({}, { status, revision: 1 })] } })
    assert.equal(isRetryFork(original, candidate), true, status)
    assert.equal(isRetryFork(original, { ...candidate, requestScopeId: 'independent' }), false)
    assert.equal(isRetryFork(original, { ...candidate, workflowId: 'another-workflow' }), false)
    assert.equal(isRetryFork(original, { ...candidate, createdAt: original.createdAt }), false)
    assert.equal(isRetryFork(original, { ...candidate, runs: [nodeRun({}, { status, revision: 1, key: 'another-loop' })] }), false)
  }
})

test('fork observation rejects an older sibling that does not preserve the failed checkpoint prefix', () => {
  const prefix = nodeRun({ passed: true }, { id: 'paid-prefix', node: { id: 'video', kind: 'video' }, revision: 4 })
  const failed = nodeRun({ error: 'late failure' }, { id: 'late-failure', status: 'failed', revision: 6, error: 'late failure' })
  const original = record([prefix, failed])
  const sibling = record([], { id: 'old-sibling', created_at: '2026-09-08T00:02:00Z', result: { requestScopeId: 'original', nodeRuns: [
    { ...prefix, status: 'idle' }, { ...failed, status: 'idle', revision: 7 },
  ] } })
  assert.equal(isRetryFork(original, sibling), false)
  const descendant = record([], { id: 'real-descendant', created_at: '2026-09-08T00:03:00Z', result: { requestScopeId: 'original', nodeRuns: [
    prefix, { ...failed, status: 'running', revision: 7 },
  ] } })
  assert.equal(isRetryFork(original, descendant), true)
})

test('failure signatures distinguish the exact record, round, and revision', () => {
  const original = record([nodeRun({ error: 'x' }, { status: 'failed', error: 'x' })])
  assert.notEqual(failureSignature(original), failureSignature({ ...original, id: 'fork' }))
  assert.notEqual(failureSignature(original), failureSignature({ ...original, runs: original.runs.map(run => ({ ...run, key: 'accept-loop-1' })) }))
  assert.notEqual(failureSignature(original), failureSignature({ ...original, runs: original.runs.map(run => ({ ...run, revision: 1 })) }))
})

test('a visible migrated recovery is related by scope even without a new run revision', () => {
  const original = record([nodeRun({ passed: true })])
  const migrated = record([], { id: 'migrated', result: { requestScopeId: original.id, nodeRuns: [] } })
  assert.equal(sameExecutionScope(original, migrated), true)
  assert.equal(sameExecutionScope(original, { ...migrated, requestScopeId: 'independent' }), false)
  assert.equal(sameExecutionScope(original, { ...migrated, workflowId: 'different-workflow' }), false)
  assert.equal(sameExecutionScope(original, undefined), false)
})

test('reload migration cannot make previously completed media or model text payable again', () => {
  const paid = nodeRun({ url: '/generated/preserved.mp4' }, { id: 'video-loop-0',
    node: { id: 'video', kind: 'video' }, status: 'success' })
  const source = record([paid, nodeRun(undefined, { id: 'review', status: 'idle' })])
  const openingReset = record([], { id: 'migrated', result: { requestScopeId: source.id, nodeRuns: [
    { ...paid, status: 'idle', output: undefined }, nodeRun(undefined, { id: 'new-gate', status: 'idle' }),
  ] } })
  assert.deepEqual(completedProviderRegression(source, openingReset).map(item => item.key), ['video-loop-0'])
  const safe = record([], { id: 'migrated-safe', result: { requestScopeId: source.id, nodeRuns: [
    paid, nodeRun(undefined, { id: 'new-gate', status: 'idle' }),
  ] } })
  assert.deepEqual(completedProviderRegression(source, safe), [])
  const writer = nodeRun({ text: 'paid draft' }, { id: 'writer-loop-0',
    node: { id: 'writer', kind: 'text', modelId: 'configured-writer' }, status: 'success' })
  const resetWriter = record([], { id: 'migrated-text', result: { requestScopeId: source.id, nodeRuns: [
    { ...writer, status: 'idle', output: undefined },
  ] } })
  assert.deepEqual(completedProviderRegression(record([writer]), resetWriter).map(item => item.key), ['writer-loop-0'])
})

test('driver records retain only decision summaries, and malformed summaries fall back to the actual output', () => {
  const big = 'PRIVATE_LARGE_PROVIDER_PAYLOAD'.repeat(1000)
  const output = { passed: false, url: ' /generated/output.mp4 ', raw: { content: big }, text: big }
  const normalized = record([nodeRun(output, { context: { big }, inputContext: { big }, _driveOutput: { hasOutput: false } })])
  assert.deepEqual(normalized.runs[0].outputSummary, driveOutputSummary(output))
  assert.equal(targetOutcome(normalized, 'accept').reason, 'passed=false')
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_LARGE_PROVIDER_PAYLOAD/)
})

test('the last successful text, character or media accept requires a human before any automated Next', () => {
  const accepted = { passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true,
    qualityReview: { manualDecisionRequired: true, editorialHold: { findings: [{ problem: 'PRIVATE_REVIEW_TEXT' }] } } }
  for (const id of ['sanguo-scene-outline-accept', 'sanguo-shot-script-accept', 'sanguo-character-accept', 'sanguo-media-accept']) {
    const prefix = nodeRun({ url: '/generated/preserved.mp4' }, { id: 'paid-prefix', node: { id: 'sanguo-video', kind: 'video' } })
    const gate = nodeRun(accepted, { id: `gate-${id}`, node: { id, kind: 'code' } })
    const next = nodeRun(undefined, { id: 'next-paid', node: { id: 'next-video', kind: 'video' }, status: 'idle' })
    const paused = record([prefix, gate, next])
    assert.equal(pendingManualDecision(paused)?.id, id)
    assert.equal(paused.runs[1].outputSummary.manualDecisionRequired, true)
    assert.doesNotMatch(JSON.stringify(paused), /PRIVATE_REVIEW_TEXT/, 'the compact driver must not copy reviewer prose')
    assert.equal(pendingManualDecision(record([prefix, gate, { ...next, status: 'skipped' }]))?.id, id)
    assert.equal(pendingManualDecision(record([prefix, gate, { ...next, status: 'success', output: { url: '/generated/continued.mp4' } }])), undefined,
      'a later successful node proves the human already continued')
    assert.equal(pendingManualDecision(record([prefix, gate, { ...next, status: 'running' }])), undefined,
      'a downstream running node has already been submitted')
  }
})

test('manual pause ignores incomplete, strict, unsuccessful or non-accept markers', () => {
  const correct = { passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true,
    qualityReview: { manualDecisionRequired: true } }
  const cases = [
    { ...correct, manualDecisionRequired: false },
    { ...correct, qualityReview: { manualDecisionRequired: false } },
    { ...correct, qualityDisposition: 'strict-v1' },
    { passed: true, qualityDisposition: 'manual-review-v1', qualityReview: { manualDecisionRequired: true } },
  ]
  for (const output of cases) assert.equal(pendingManualDecision(record([nodeRun(output,
    { node: { id: 'sanguo-media-accept', kind: 'code' } })])), undefined)
  assert.equal(pendingManualDecision(record([nodeRun(correct,
    { node: { id: 'sanguo-media-accept', kind: 'code' }, status: 'idle' })])), undefined)
  assert.equal(pendingManualDecision(record([nodeRun(correct,
    { node: { id: 'sanguo-video', kind: 'video' } })])), undefined)
  assert.equal(pendingManualDecision(record([nodeRun(correct,
    { node: { id: 'sanguo-media-accept', kind: 'code' } }), nodeRun({}, { id: 'failed-next', status: 'failed' })])), undefined)
  assert.equal(driveOutputSummary(correct).manualDecisionRequired, true)
})

const fixtureProjectionSql = `with recursive record_row as (
  select * from jsonb_to_record($1::jsonb) as row(id text,workflow_id text,created_at timestamptz,runtime_inputs jsonb,result jsonb)
)${DRIVE_RECORD_PROJECTION_SQL}`

test('PostgreSQL compact SELECT preserves malformed-output, failure, fork and first-occurrence decisions', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const client = await pool.connect()
  try {
    await client.query('begin read only')
    const project = async (row: Record<string, unknown>) => (await client.query(fixtureProjectionSql, [JSON.stringify(row), DRIVE_RECORD_TRIM_CHARS])).rows[0]
    const outputs = [undefined, null, {}, [], [null], true, false, 0, 1, '', DRIVE_RECORD_TRIM_CHARS, 'real output',
      { executionLogs: [] }, { executionLogs: ['ran'] }, { value: null }, { value: '' }, { value: { value: { value: [] } } },
      { value: { executionLogs: ['only logs'] } }, { value: false }, { value: { passed: false } },
      { routeError: 'REVIEW_RESULT_INVALID: missing evidence' }, { routeError: ' ', error: 'secondary' },
      { routeError: '', error: 'fallback' }, { routeError: false }, { routeError: 0 }, { routeError: null },
      { routeError: [] }, { error: {} }, { error: 1 }, { error: true },
      { passed: false }, { accepted: false }, { videoAccepted: false }, { ok: false }, { success: false },
      { passed: true }, { passed: 'false' }, { passed: [] }, { url: DRIVE_RECORD_TRIM_CHARS },
      { passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true, qualityReview: { manualDecisionRequired: true } },
      { passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true, qualityReview: { manualDecisionRequired: false } },
      { url: `${DRIVE_RECORD_TRIM_CHARS}/generated/clip.mp4${DRIVE_RECORD_TRIM_CHARS}` }, { url: 1 },
      { raw: { text: 'PRIVATE_LARGE_PROVIDER_PAYLOAD'.repeat(10000) }, text: 'PRIVATE_LARGE_PROVIDER_PAYLOAD'.repeat(1000), passed: false },
    ]
    const row = {
      id: 'original', workflow_id: 'workflow', created_at: new Date('2026-09-08T00:00:00Z'), runtime_inputs: { input: { episode_number: 41, qualityDisposition: 'manual-review-v1' } },
      result: { id: 'original', nodeRuns: [
        ...outputs.map((output, index) => nodeRun(output, { id: `key-${index}`, node: { id: `target-${index}`, kind: index % 2 ? 'video' : 'code', title: `node ${index}` }, context: { payload: 'PRIVATE_CONTEXT'.repeat(1000) } })),
        nodeRun({ passed: false }, { id: 'first', node: { id: 'loop-target', kind: 'code' } }),
        nodeRun({ passed: true }, { id: 'second', node: { id: 'loop-target', kind: 'code' }, loopIndex: 1 }),
        nodeRun({ error: 'failed' }, { status: 'failed', error: 'failed', id: 'failed', revision: 3, loopIndex: null }),
        null, 7, 'malformed run', {},
      ] },
    }
    const rawNormalized = driveRecord(row)
    const compact = await project(row)
    const projected = driveRecord(compact)
    assert.deepEqual(projected, rawNormalized)
    const packedProjection = driveRecord(await project({ ...row, result: encodeExecutionState(row.result) }))
    assert.deepEqual(packedProjection, rawNormalized)
    const pendingGate = { ...row, result: { id: row.id, nodeRuns: [
      nodeRun({ passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true,
        qualityReview: { manualDecisionRequired: true } }, { id: 'manual-gate', node: { id: 'sanguo-scene-outline-accept', kind: 'code' } }),
      nodeRun(undefined, { id: 'paid-next', node: { id: 'sanguo-video', kind: 'video' }, status: 'idle' }),
    ] } }
    assert.equal(pendingManualDecision(driveRecord(await project(pendingGate)))?.id, 'sanguo-scene-outline-accept',
      'the compact SQL projection must retain the dual manual marker')
    for (let index = 0; index < outputs.length; index++) {
      assert.deepEqual(targetOutcome(projected, `target-${index}`), targetOutcome(rawNormalized, `target-${index}`), `output case ${index}`)
    }
    assert.equal(targetOutcome(projected, 'loop-target').done, false)
    assert.equal(failureSignature(projected), failureSignature(rawNormalized))
    const serialized = JSON.stringify(compact)
    assert.doesNotMatch(serialized, /PRIVATE_LARGE_PROVIDER_PAYLOAD|PRIVATE_CONTEXT/)
    assert.ok(serialized.length < JSON.stringify(row).length / 10)

    for (const status of ['idle', 'running', 'success', 'failed']) {
      const forkRow = { ...row, id: `fork-${status}`, created_at: new Date('2026-09-08T00:01:00Z'), result: {
        ...row.result, requestScopeId: row.id, nodeRuns: row.result.nodeRuns.map(run => run && typeof run === 'object' && run.id === 'failed'
          ? nodeRun({}, { id: 'failed', revision: 4, status }) : run),
      } }
      const fork = driveRecord(await project(forkRow))
      assert.equal(isRetryFork(projected, fork), isRetryFork(rawNormalized, driveRecord(forkRow)), status)
      assert.equal(isRetryFork(projected, fork), true, status)
      const independent = driveRecord(await project({ ...forkRow, result: { ...forkRow.result, requestScopeId: 'unrelated' } }))
      assert.equal(isRetryFork(projected, independent), false)
    }
    for (const nodeRuns of [undefined, null, 'not an array', {}]) {
      const malformed = { ...row, result: { nodeRuns } }
      assert.deepEqual(driveRecord(await project(malformed)), driveRecord(malformed))
    }
  } finally {
    await client.query('rollback')
    client.release()
    await pool.end()
  }
})
