import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { migrateBranchRuns } from '../src/branch-migration.ts'
import { insertMissingExecutionNodes } from '../src/execution-topology.ts'
import { firstBlockingRunIndex } from '../src/workflow-core.ts'

type Node = {
  id: string; title: string; resultVar: string; kind: string; prompt: string; params: []
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; modelId?: string
}
type Run = {
  id: string; node: Node; status: string; durationMs: number; context: Record<string, unknown>
  output?: unknown; revision?: number; loopNode?: Node; loopGroupId?: string
  loopIndex?: number; loopItem?: unknown; loopIsLast?: boolean
}

const fixturePath = new URL('./fixtures/episode610-schema152-resume.json', import.meta.url)

test('610 review-only rollback keeps its paid four-shot prefix across the six-gate map migration', () => {
  const saved = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
    sourceExecutionId: string; schemaVersion: number
    workflow: { id: string; nodes: Node[]; edges: Array<{ id: string; from: string; to: string; branch?: string }> }
    runs: Array<{ id: string; nodeId: string; status: string; output?: unknown; revision?: number
      loopNodeId?: string; loopGroupId?: string; loopIndex?: number; loopItem?: unknown; loopIsLast?: boolean }>
    oldLoopChildren: string[]; expectedFirstPendingIndex: number; expectedFirstPendingNodeId: string
  }
  assert.equal(saved.sourceExecutionId, 'record-610-scene4-review-retry-20260928-v1')
  assert.equal(saved.schemaVersion, 152)
  const byId = new Map(saved.workflow.nodes.map(node => [node.id, node]))
  const oldLoop = { ...byId.get('sanguo-scene-loop')!, childIds: saved.oldLoopChildren }
  const runs: Run[] = saved.runs.map(row => ({ id: row.id,
    node: row.nodeId === oldLoop.id ? oldLoop : byId.get(row.nodeId)!,
    status: row.status, durationMs: 0, context: {}, output: row.output, revision: row.revision,
    ...(row.loopNodeId ? { loopNode: oldLoop } : {}),
    loopGroupId: row.loopGroupId, loopIndex: row.loopIndex,
    loopItem: row.loopItem, loopIsLast: row.loopIsLast }))
  assert.equal(runs.length, 346)
  assert.equal(firstBlockingRunIndex(runs, runs.length - 1), saved.expectedFirstPendingIndex)

  const migrated = migrateBranchRuns(saved.workflow, runs)
  assert.notEqual(migrated, runs)
  assert.equal(migrated.length, 382)
  assert.equal(firstBlockingRunIndex(migrated, migrated.length - 1), saved.expectedFirstPendingIndex)
  assert.equal(migrated[saved.expectedFirstPendingIndex].node.id, saved.expectedFirstPendingNodeId)
  assert.equal(migrated[saved.expectedFirstPendingIndex].loopIndex, 3)
  assert.equal(migrated.filter(run => run.id.startsWith('recovery:')).length, 36)
  const afterById = new Map(migrated.map(run => [run.id, run]))
  for (const original of runs) {
    if (original.status !== 'success' && original.status !== 'skipped') continue
    const after = afterById.get(original.id)
    assert.ok(after, `completed run ${original.id} stays present`)
    assert.equal(after.status, original.status, `completed run ${original.id} stays completed`)
    assert.equal(after.output, original.output, `completed run ${original.id} keeps its output`)
  }
  assert.equal(migrated.filter(run => run.node.id === 'sanguo-video' && run.status === 'success').length, 4)
  assert.equal(migrateBranchRuns(saved.workflow, migrated), migrated, 'migration is idempotent')
})

test('an unrelated inserted gate cannot turn completed media or model text into a new charge', () => {
  for (const kind of ['video', 'image', 'audio', 'text']) {
    const node = (id: string, nodeKind = 'code'): Node => ({ id, title: id, resultVar: id, kind: nodeKind,
      prompt: '', params: [], position: { x: 0, y: 0 } })
    const input = node('input', 'input'), provider = { ...node('provider', kind), ...(kind === 'text' ? { modelId: 'paid-writer' } : {}) }, end = node('end')
    const newGate = node('new-gate')
    const workflow = { id: 'other-workflow', nodes: [input, newGate, provider, end], edges: [
      { id: 'input-gate', from: input.id, to: newGate.id },
      { id: 'gate-provider', from: newGate.id, to: provider.id },
      { id: 'provider-end', from: provider.id, to: end.id },
    ] }
    const paidOutput = { assetId: `already-paid-${kind}` }
    const runs: Run[] = [input, provider, end].map((item, index) => ({ id: `${item.id}-${index}`,
      node: item, status: index < 2 ? 'success' : 'idle', durationMs: 0, context: {},
      output: index === 1 ? paidOutput : undefined }))
    const result = insertMissingExecutionNodes(workflow, runs)
    assert.equal(result, runs, `${kind}: incompatible recovery fails closed`)
    assert.equal(runs[1].status, 'success')
    assert.equal(runs[1].output, paidOutput)
  }
})
