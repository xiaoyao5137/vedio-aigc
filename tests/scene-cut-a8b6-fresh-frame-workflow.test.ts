import assert from 'node:assert/strict'
import test from 'node:test'
import { hasExecutionPlanMismatch, refreshPendingExecutionNodes } from
  '../src/workflow-core.ts'
import { A8B6_FRESH_FRAME_VERSION, A8B6_FRESH_FIRST_FRAME_PROMPT,
  A8B6_FRESH_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'

const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

function fixture() {
  const nodes = [
    { id: 'sanguo-scene-cut-first-frame', kind: 'image', prompt: 'base first',
      params: [{ name: 'referenceImages', type: 'images', value: '${refs}' }] },
    { id: 'sanguo-scene-cut-review', kind: 'text', prompt: 'base review',
      params: [{ name: 'reviewImages', type: 'json', value: '${evidence.reviewImages}' }] },
    { id: 'ordinary-after', kind: 'http', prompt: 'new base', params: [] },
  ]
  const marker = { version: A8B6_FRESH_FRAME_VERSION,
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    rejectedExecutionId: 'record-4x5m31-a8b6-frame-conflict-review-v1',
    priorFreshExecutionId: 'record-4x5m31-a8b6-fresh-first-frame-v2',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49' }
  const locked = (node: typeof nodes[number], prompt: string) => ({
    node: { ...node, prompt, params: [...node.params,
      { name: 'sceneCutFreshImage', englishName: 'sceneCutFreshImage',
        type: 'json', value: canonical(marker) }] },
    status: 'idle', sourceBoundNodeOverride: {
      version: A8B6_FRESH_FRAME_VERSION, nodeId: node.id, marker },
  })
  const runs = [locked(nodes[0], A8B6_FRESH_FIRST_FRAME_PROMPT),
    locked(nodes[1], A8B6_FRESH_REVIEW_PROMPT),
    { node: { ...nodes[2], prompt: 'stale base' }, status: 'idle' }]
  return { workflow: { id: 'wf-sanguo-history-drama', nodes, edges: [] }, runs }
}

test('refresh retains only the exact two source-bound managed node contracts', () => {
  const { workflow, runs } = fixture()
  assert.equal(hasExecutionPlanMismatch(workflow, runs), true)
  const refreshed = refreshPendingExecutionNodes(workflow, runs)
  assert.equal(refreshed[0], runs[0])
  assert.equal(refreshed[1], runs[1])
  assert.equal(refreshed[2].node.prompt, 'new base')
  assert.equal(hasExecutionPlanMismatch(workflow, refreshed), false)
})

test('tampered prompt, marker, base params and unrelated override all refresh', () => {
  const { workflow, runs } = fixture()
  const tampered = [
    { ...runs[0], node: { ...runs[0].node, prompt: 'spoof' } },
    { ...runs[0], sourceBoundNodeOverride: undefined },
    { ...runs[0], node: { ...runs[0].node,
      params: runs[0].node.params.map((param, i) =>
        i === 0 ? { ...param, value: 'wrong refs' } : param) } },
  ]
  for (const run of tampered) {
    const current = refreshPendingExecutionNodes(workflow, [run, runs[1], runs[2]])
    assert.equal(current[0].node.prompt, 'base first')
    assert.deepEqual(current[0].node.params, workflow.nodes[0].params)
  }
  const ordinary = { ...runs[2], sourceBoundNodeOverride: runs[0].sourceBoundNodeOverride }
  const current = refreshPendingExecutionNodes(workflow, [runs[0], runs[1], ordinary])
  assert.equal(current[2].node.prompt, 'new base')
})
