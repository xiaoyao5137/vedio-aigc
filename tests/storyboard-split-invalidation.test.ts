import test from 'node:test'
import assert from 'node:assert/strict'
import { invalidateRunExecution, manualRetryRuns } from '../src/run-invalidation.ts'

const evidence = { version: 'storyboard-split-plan-v1', planSha256: 'a'.repeat(64), segments: [{ id: 'part-1' }, { id: 'part-2' }] }
const reference = { version: 'storyboard-split-candidate-v1', sourceRunId: 'script-source', planSha256: 'a'.repeat(64), segmentIndex: 1 }
function runs() {
  return [
    { id: 'script-source', node: { id: 'script', kind: 'text', operation: 'history.storyboard' }, status: 'success', revision: 0,
      output: { id: 'part-1' }, storyboardSplitPlan: evidence },
    { id: 'video-1', node: { id: 'video', kind: 'video' }, status: 'failed', revision: 0, output: { error: 'transport' } },
    { id: 'script-part-2', node: { id: 'script', kind: 'text', operation: 'history.storyboard' }, status: 'idle', revision: 0,
      storyboardSplitCandidate: reference },
  ]
}

test('retrying a video keeps a future split draft whose successful source is preserved in the complete prefix', () => {
  const source = runs(), snapshot = structuredClone(source)
  const retried = manualRetryRuns(source, 1)
  assert.equal(retried[0], source[0])
  assert.deepEqual(retried[2].storyboardSplitCandidate, reference)
  assert.deepEqual(source, snapshot)
  assert.equal(retried[1].status, 'idle')
})

test('rerunning the split source clears its plan and all derived future references', () => {
  const source = runs(), snapshot = structuredClone(source)
  const retried = manualRetryRuns(source, 0)
  assert.equal(retried[0].storyboardSplitPlan, undefined)
  assert.equal(retried[2].storyboardSplitCandidate, undefined)
  assert.deepEqual(source, snapshot)
})

test('failed, absent or later source runs cannot authorize retaining a future draft', () => {
  for (const source of [runs().map((run, i) => i ? run : { ...run, status: 'failed' }), runs().slice(1), [runs()[1], runs()[0], runs()[2]]]) {
    const retried = manualRetryRuns(source, 0)
    assert.equal(retried.at(-1)?.storyboardSplitCandidate, undefined)
  }
  const cleared = invalidateRunExecution({ storyboardSplitPlan: evidence, storyboardSplitCandidate: reference })
  assert.equal(cleared.storyboardSplitPlan, undefined)
  assert.equal(cleared.storyboardSplitCandidate, undefined)
})
