import test from 'node:test'
import assert from 'node:assert/strict'
import { verifiedStoryScriptBreakpointFork,
  verifiedStoryScriptIdleContinuation, driveRecord } from '../scripts/workflow-drive-state.mjs'
import { forkBreakpointRollback } from '../src/breakpoint-rollback.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { encodeExecutionState } from '../src/execution-storage.ts'

const sourceMd5 = 'a'.repeat(32)
const forkMd5 = 'b'.repeat(32)
const nodesMd5 = 'c'.repeat(32)
const edgesMd5 = 'd'.repeat(32)

function fixture() {
  const ids = ['node-input', 'node-model-images', 'node-script', 'node-script-review']
  const oldNodes = ids.map(id => ({ id, title: id, kind: id === 'node-script' ? 'text' : 'validation',
    resultVar: id.replaceAll('-', '_'), ...(id === 'node-script' ? { prompt: 'old persona' } : {}) }))
  const newNodes = oldNodes.map(node => node.id === 'node-script'
    ? { ...node, prompt: 'cat works; dog is a housemate; both speak' } : node)
  const runs = oldNodes.map((node, index) => ({ id: `${node.id}-${index}`, node,
    status: index < 3 ? 'success' : 'failed', context: { step: index },
    inputContext: { step: index }, output: { step: index }, durationMs: 1, revision: 0 }))
  const source = { id: 'record-story-source', workflowId: 'wf-story', mode: 'step',
    nodeRuns: runs, context: { step: 2 }, logs: [], selectedNodeId: 'node-script-review' }
  const workflow = { id: 'wf-story', nodes: newNodes, edges: [], nodes_md5: nodesMd5,
    edges_md5: edgesMd5, schema_version: 5 }
  const { state } = forkBreakpointRollback(source, { id: 'record-story-fork',
    createdAt: '2026-09-30T08:00:00.000Z', targetRunId: runs[2].id,
    breakpoints: [{ nodeId: 'node-script', enabled: true }] })
  const fork = { ...state,
    nodeRuns: refreshPendingExecutionNodes(workflow, state.nodeRuns) }
  const sourceRow = { id: source.id, workflow_id: 'wf-story', result_md5: sourceMd5,
    result: encodeExecutionState(source) }
  const forkRow = { id: fork.id, workflow_id: 'wf-story', result_md5: forkMd5,
    result: encodeExecutionState(fork) }
  const locks = { projectedResultMd5: forkMd5, expectedSourceMd5: sourceMd5,
    expectedWorkflowNodesMd5: nodesMd5, expectedWorkflowEdgesMd5: edgesMd5 }
  return { sourceRow, forkRow, workflow, locks }
}

test('wf-story script rollback only continues its exact first idle script', () => {
  const { forkRow } = fixture()
  const projected = driveRecord(forkRow)
  const target = verifiedStoryScriptIdleContinuation(projected, {
    workflowId: 'wf-story', nodeId: 'node-script' })
  assert.equal(target.index, 2)
  assert.equal(target.status, 'idle')
  assert.throws(() => verifiedStoryScriptIdleContinuation({ ...projected,
    runs: projected.runs.map((run, index) => index === 3 ? { ...run, status: 'success' } : run) },
  { workflowId: 'wf-story', nodeId: 'node-script' }), /IDENTITY_MISMATCH/)
  assert.throws(() => verifiedStoryScriptIdleContinuation(projected,
    { workflowId: 'wf-story', nodeId: 'node-video' }), /IDENTITY_MISMATCH/)
})

test('wf-story script checkpoint rebuild checks source, prefix, current prompts and MD5 locks', () => {
  const { sourceRow, forkRow, workflow, locks } = fixture()
  const proof = verifiedStoryScriptBreakpointFork(sourceRow, forkRow, workflow, locks)
  assert.equal(proof.firstPendingIndex, 2)
  assert.equal(proof.firstPendingNodeId, 'node-script')
  assert.equal(proof.sourceResultMd5, sourceMd5)
  assert.throws(() => verifiedStoryScriptBreakpointFork(sourceRow, forkRow,
    workflow, { ...locks, expectedSourceMd5: 'e'.repeat(32) }), /SOURCE_CHANGED/)
  assert.throws(() => verifiedStoryScriptBreakpointFork(sourceRow, forkRow,
    { ...workflow, nodes: workflow.nodes.map(node => node.id === 'node-script'
      ? { ...node, prompt: 'drifted' } : node) }, locks), /STATE_MISMATCH/)
  const changedPrefix = structuredClone(forkRow)
  changedPrefix.result.nodeRuns[1].output = { step: 999 }
  assert.throws(() => verifiedStoryScriptBreakpointFork(sourceRow,
    changedPrefix, workflow, locks), /STATE_MISMATCH/)
  const advanced = structuredClone(forkRow)
  advanced.result.nodeRuns[3].status = 'success'
  assert.throws(() => verifiedStoryScriptBreakpointFork(sourceRow,
    advanced, workflow, locks), /STATE_MISMATCH|IDENTITY_MISMATCH/)
})
