import test from 'node:test'
import assert from 'node:assert/strict'
import { historicalInspectorRunIndex, nextInspectorRunIndex } from '../src/debug-inspector-selection.ts'

test('debug inspector stays on the user-selected run while execution advances', () => {
  assert.equal(nextInspectorRunIndex(3, 4, false), 3)
  assert.equal(nextInspectorRunIndex(3, 12, false), 3)
})

test('debug inspector follows execution until the user pins a run', () => {
  assert.equal(nextInspectorRunIndex(-1, 0, true), 0)
  assert.equal(nextInspectorRunIndex(0, 1, true), 1)
})

test('historical loop records select the failed or pending instance instead of the first matching node', () => {
  const runs = ['success', 'success', 'failed', 'idle'].map(status => ({ status, node: { id: 'same-loop-node' } }))
  assert.equal(historicalInspectorRunIndex(runs, 'same-loop-node'), 2)
  assert.equal(historicalInspectorRunIndex(runs.map(run => ({ ...run, status: 'success' })), 'same-loop-node'), 3)
  assert.equal(historicalInspectorRunIndex(runs.map(run => ({ ...run, status: run.status === 'failed' ? 'idle' : run.status }))), 2)
})
