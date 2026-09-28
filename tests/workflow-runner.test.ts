import test from 'node:test'
import assert from 'node:assert/strict'
import { orderLoopPlaceholders, runWorkflowToCompletion, historicalVideoRetryIndexes } from '../src/workflow-runner.ts'
import type { StepRunStatus } from '../src/workflow-core.ts'

test('disconnected disabled child is deferred behind its loop, not submitted before sources', () => {
  const nodes = [{ id: 'input', kind: 'input' }, { id: 'disabled-frame', kind: 'image', parentId: 'loop' }, { id: 'sources', kind: 'internet' }, { id: 'loop', kind: 'loop', childIds: ['disabled-frame', 'video'] }, { id: 'video', kind: 'video', parentId: 'loop' }, { id: 'verify', kind: 'validation' }]
  assert.deepEqual(orderLoopPlaceholders({ nodes, edges: [] }, nodes).map(n => n.id), ['input', 'sources', 'loop', 'disabled-frame', 'video', 'verify'])
})

test('full execution consumes dynamically split rounds with the same step callback and stops on failure', async () => {
  type State = { nodeRuns: Array<{ id: string; status: StepRunStatus }> }
  const calls: string[] = []
  const state: State = { nodeRuns: ['outline', 'loop', 'verify'].map(id => ({ id, status: 'idle' })) }
  const result = await runWorkflowToCompletion(state, async (index, current) => {
    const runs = current.nodeRuns.map(r => ({ ...r }))
    const id = runs[index].id
    calls.push(id)
    runs[index].status = id === 'video-2' ? 'failed' : 'success'
    if (id === 'loop') runs.splice(index + 1, 0, ...['shot-1', 'video-1', 'shot-2', 'video-2'].map(id => ({ id, status: 'idle' as const })))
    if (id === 'shot-2') runs.splice(index + 2, 0, ...['shot-3', 'video-3'].map(id => ({ id, status: 'idle' as const })))
    return { nodeRuns: runs }
  })
  assert.deepEqual(calls, ['outline', 'loop', 'shot-1', 'video-1', 'shot-2', 'video-2'])
  assert.equal(result.nodeRuns.find(r => r.id === 'verify')?.status, 'idle')
  // Resume the persisted queue; prior paid video is not invoked again.
  result.nodeRuns.find(r => r.id === 'video-2')!.status = 'idle'
  await runWorkflowToCompletion(result, async (index, current) => {
    calls.push(current.nodeRuns[index].id)
    return { nodeRuns: current.nodeRuns.map((r, i) => i === index ? { ...r, status: 'success' } : r) }
  })
  assert.deepEqual(calls.slice(6), ['video-2', 'shot-3', 'video-3', 'verify'])
})

test('pause returns the last completed checkpoint without invoking the next paid node', async () => {
  const state = { nodeRuns: [{ status: 'idle' as StepRunStatus }, { status: 'idle' as StepRunStatus }] }
  let completed = 0
  const result = await runWorkflowToCompletion(state, async (index, current) => {
    if (completed) return undefined
    completed++
    return { nodeRuns: current.nodeRuns.map((r, i) => i === index ? { status: 'success' as const } : r) }
  })
  assert.deepEqual(result.nodeRuns.map(r => r.status), ['success', 'idle'])
})


test('a video-only retake preserves completed independent cuts and rebuilds dependent tails and final aggregation', async () => {
  const runs = [
    { node: { kind: 'text' }, loopIndex: 0 },
    { node: { kind: 'video' }, loopIndex: 0 },
    { node: { kind: 'code' }, loopIndex: 0 },
    { node: { kind: 'text' }, loopIndex: 1 },
    { node: { kind: 'video' }, loopIndex: 1 },
    { node: { kind: 'code' }, loopIndex: 1 },
    { node: { kind: 'text' }, loopIndex: 2 },
    { node: { kind: 'video' }, loopIndex: 2 },
    { node: { kind: 'code' }, loopIndex: 2, loopIsLast: true },
  ].map(r => ({ ...r, loopGroupId: 'g', loopItem: { continuityFromPrevious: r.loopIndex === 1 } }))
  const all = [...runs, { node: { kind: 'validation' } }]
  const invalidated = historicalVideoRetryIndexes(all, 1)
  assert.deepEqual([...invalidated], [1, 2, 3, 4, 5, 8, 9])
  const calls: number[] = []
  await runWorkflowToCompletion({ nodeRuns: all.map((r, i) => ({ ...r, status: invalidated.has(i) ? 'idle' as const : 'success' as StepRunStatus })) }, async (index, state) => {
    calls.push(index)
    return { nodeRuns: state.nodeRuns.map((r, i) => i === index ? { ...r, status: 'success' as const } : r) }
  })
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 8, 9])
  assert.deepEqual([...historicalVideoRetryIndexes(all, 0)], all.map((_, i) => i))
})
