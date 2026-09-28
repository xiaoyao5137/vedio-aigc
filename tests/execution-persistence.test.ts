import test from 'node:test'
import assert from 'node:assert/strict'
import { createExecutionSaveQueue, ExecutionPersistenceError, requireExecutionCheckpoint } from '../src/execution-persistence.ts'
import { runWorkflowToCompletion } from '../src/workflow-runner.ts'

test('queued writes cannot persist an older checkpoint after a newer result', async () => {
  const save = createExecutionSaveQueue()
  const writes: number[] = []
  let release!: () => void
  const first = save(async () => { await new Promise<void>(resolve => { release = resolve }); writes.push(1) })
  const second = save(async () => { writes.push(2) })
  await Promise.resolve()
  assert.deepEqual(writes, [])
  release()
  await Promise.all([first, second])
  assert.deepEqual(writes, [1, 2])
})

test('serialization and storage failures propagate but do not poison subsequent save retries', async () => {
  const save = createExecutionSaveQueue()
  await assert.rejects(save(async () => { throw new Error('JSONB limit') }), /JSONB limit/)
  assert.equal(await save(async () => 'saved'), 'saved')
  await assert.rejects(requireExecutionCheckpoint(async () => ({ saved: false, error: 'disk unavailable' })), ExecutionPersistenceError)
})

test('failed post-result checkpoint retains the actual output and stops before another paid node', async () => {
  type State = { nodeRuns: Array<{ status: 'idle' | 'success'; output?: unknown }> }
  let live: State = { nodeRuns: [{ status: 'idle' }, { status: 'idle' }] }
  let calls = 0
  await runWorkflowToCompletion(live, async (index, state) => {
    await requireExecutionCheckpoint(async () => ({ saved: true }))
    calls++
    live = { nodeRuns: state.nodeRuns.map((run, i) => i === index ? { status: 'success', output: { url: '/paid-result.mp4' } } : run) }
    try {
      await requireExecutionCheckpoint(async () => ({ saved: false, error: 'storage offline' }))
      return live
    } catch (error) { if (!(error instanceof ExecutionPersistenceError)) throw error; return undefined }
  })
  assert.equal(calls, 1)
  assert.deepEqual(live.nodeRuns, [{ status: 'success', output: { url: '/paid-result.mp4' } }, { status: 'idle' }])
  // Saving the retained state succeeds without re-executing the completed model.
  await requireExecutionCheckpoint(async () => ({ saved: true }))
  await runWorkflowToCompletion(live, async (index, state) => {
    calls++
    return { nodeRuns: state.nodeRuns.map((run, i) => i === index ? { status: 'success' } : run) }
  })
  assert.equal(calls, 2)
})

test('failed pre-request checkpoint prevents a model request', async () => {
  let calls = 0
  await assert.rejects(async () => {
    await requireExecutionCheckpoint(async () => ({ saved: false, error: 'storage offline' }))
    calls++
  }, ExecutionPersistenceError)
  assert.equal(calls, 0)
})
