import test from 'node:test'
import assert from 'node:assert/strict'
import { insertMissingExecutionNodes } from '../src/execution-topology.ts'
import { migrateBranchRuns } from '../src/branch-migration.ts'
import { firstBlockingRunIndex, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { encodeExecutionState, decodeExecutionState } from '../src/execution-storage.ts'

type Node = { id: string; title: string; resultVar: string; kind: string; prompt: string; params: []; position: { x: number; y: number }; childIds?: string[]; parentId?: string }
type Run = { id: string; node: Node; status: string; durationMs: number; context: Record<string, unknown>; output?: unknown; inputs?: Record<string, unknown>; inputContext?: Record<string, unknown>; routeInputContext?: Record<string, unknown>; retryFeedback?: unknown; paramOverrides?: Record<string, string>; revision?: number; attempts?: Array<Record<string, unknown>>; branchState?: { visits: number; counts: { true: number; false: number } }; loopNode?: Node; loopGroupId?: string; loopIndex?: number; loopItem?: unknown; loopIsLast?: boolean }
const node = (id: string, kind = 'text', parentId?: string): Node => ({ id, title: id, resultVar: id, kind, parentId, prompt: 'old', params: [], position: { x: 0, y: 0 } })
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from, to })
function fixture() {
  const children = ['video', 'observe', 'review', 'gate', 'tail']
  const loop = { ...node('loop', 'loop'), childIds: children }
  const old = { nodes: [node('input', 'input'), loop, ...children.map(id => node(id, id === 'video' ? 'video' : id === 'gate' ? 'branch' : 'text', 'loop')), node('done', 'compose')], edges: ['input', 'loop', ...children, 'done'].slice(1).map((id, i) => edge(['input', 'loop', ...children][i], id)) }
  const newNode = node('requirement-review', 'text', 'loop')
  const updated = { nodes: old.nodes.flatMap(n => [{ ...n, ...(n.id === 'loop' ? { childIds: ['video', 'observe', newNode.id, 'review', 'gate', 'tail'] } : {}) }, ...(n.id === 'observe' ? [newNode] : [])]), edges: old.edges.flatMap(e => e.from === 'observe' ? [edge('observe', newNode.id), edge(newNode.id, 'review')] : [e]) }
  const make = (n: Node): Run => ({ id: `${n.id}:root`, node: n, status: 'idle', durationMs: 0, context: {}, revision: 7 })
  const runs: Run[] = [make(old.nodes[0]), make(loop)]
  for (let round = 0; round < 2; round++) for (const child of old.nodes.filter(n => n.parentId === 'loop')) {
    runs.push({ ...make(child), id: `${child.id}:round:${round}`, loopNode: loop, loopGroupId: 'expanded-group', loopIndex: round, loopItem: { id: `scene-${round}` }, loopIsLast: round === 1 && child.id === 'tail' })
  }
  runs.push(make(old.nodes.at(-1)!))
  for (const run of runs.slice(0, 4)) Object.assign(run, { status: 'success', output: { url: `paid-${run.id}`, token: 'actual-output' }, context: { prior: run.id }, durationMs: 900 })
  return { old, updated, runs }
}

test('normal migration inserts a pending non-branch node in every expanded round and preserves the paid prefix', () => {
  const { updated, runs } = fixture()
  const before = JSON.stringify(runs)
  const migrated = migrateBranchRuns(updated, runs)
  assert.equal(migrated.length, runs.length + 2)
  for (let i = 0; i < 4; i++) {
    assert.equal(migrated[i].id, runs[i].id)
    assert.equal(migrated[i].output, runs[i].output)
    assert.equal(migrated[i].context, runs[i].context)
    assert.equal(migrated[i].status, 'success')
    assert.equal(migrated[i].revision, runs[i].revision)
  }
  const inserted = migrated.filter(r => r.node.id === 'requirement-review')
  assert.deepEqual(inserted.map(r => [r.loopGroupId, r.loopIndex, r.loopItem]), [['expanded-group', 0, { id: 'scene-0' }], ['expanded-group', 1, { id: 'scene-1' }]])
  assert.ok(inserted.every(r => r.status === 'idle' && r.output === undefined && Object.keys(r.context).length === 0 && r.durationMs === 0))
  for (const run of inserted) {
    const index = migrated.indexOf(run)
    assert.equal(migrated[index - 1].node.id, 'observe')
    assert.equal(migrated[index + 1].node.id, 'review')
  }
  assert.equal(firstBlockingRunIndex(migrated as never, migrated.length - 1), 4)
  assert.equal(migrateBranchRuns(updated, migrated), migrated)
  assert.equal(refreshPendingExecutionNodes(updated, migrated), migrated)
  assert.equal(JSON.stringify(runs), before)
  const restored = decodeExecutionState<{ nodeRuns: Run[] }>(JSON.parse(JSON.stringify(encodeExecutionState({ nodeRuns: migrated }))))
  assert.deepEqual(restored.nodeRuns, JSON.parse(JSON.stringify(migrated)))
})

test('completed downstream verdicts are archived and invalidated while branch budget remains bounded', () => {
  const { updated, runs } = fixture()
  const review = runs.find(r => r.node.id === 'review')!
  Object.assign(review, { status: 'success', output: { passed: true }, context: { obsolete: true }, routeInputContext: { obsolete: true }, retryFeedback: { previousReport: 'stale' } })
  const gate = runs.find(r => r.node.id === 'gate')!
  Object.assign(gate, { status: 'failed', output: { error: 'budget' }, branchState: { visits: 4, counts: { true: 1, false: 3 } }, paramOverrides: { maxAttempts: '4' } })
  const migrated = insertMissingExecutionNodes(updated, runs)
  const nextReview = migrated.find(r => r.id === review.id)!
  assert.equal(nextReview.status, 'idle')
  assert.equal(nextReview.output, undefined)
  assert.deepEqual(nextReview.context, {})
  assert.equal(nextReview.routeInputContext, undefined)
  assert.equal(nextReview.retryFeedback, undefined)
  assert.equal(nextReview.revision, 8)
  assert.deepEqual(nextReview.attempts?.[0].output, { passed: true })
  assert.deepEqual(nextReview.attempts?.[0].node, review.node)
  const nextGate = migrated.find(r => r.id === gate.id)!
  assert.equal(nextGate.status, 'idle')
  assert.deepEqual(nextGate.branchState, gate.branchState)
  assert.deepEqual(nextGate.paramOverrides, gate.paramOverrides)
  assert.ok(migrated.slice(4).every(r => r.status === 'idle' && r.output === undefined))
})

test('new final child receives final-iteration aggregation marker exactly once', () => {
  const { old, runs } = fixture()
  const newNode = node('new-tail', 'code', 'loop')
  const workflow = { nodes: [...old.nodes.map(n => n.id === 'loop' ? { ...n, childIds: [...n.childIds!, newNode.id] } : n), newNode], edges: old.edges.flatMap(e => e.from === 'tail' ? [edge('tail', newNode.id), edge(newNode.id, 'done')] : [e]) }
  const result = insertMissingExecutionNodes(workflow, runs)
  assert.deepEqual(result.filter(r => r.loopIsLast).map(r => [r.node.id, r.loopIndex]), [['new-tail', 1]])
  assert.equal(result.filter(r => r.node.id === newNode.id).length, 2)
  assert.equal(result.at(-1)?.node.id, 'done')
})

test('unexpanded loops gain placeholders and expanded empty loops do not execute children at root scope', () => {
  const { old, updated } = fixture()
  const staticRuns: Run[] = old.nodes.map(n => ({ id: n.id, node: n, status: 'idle', durationMs: 0, context: {} }))
  const migrated = insertMissingExecutionNodes(updated, staticRuns)
  assert.equal(migrated.filter(r => r.node.id === 'requirement-review').length, 1)
  assert.equal(migrated.find(r => r.node.id === 'requirement-review')?.loopGroupId, undefined)
  assert.ok(migrated.find(r => r.node.id === 'loop')?.node.childIds?.includes('requirement-review'))
  const empty = staticRuns.filter(r => !r.node.parentId).map(r => ({ ...r, status: r.node.kind === 'loop' ? 'success' : r.status }))
  const emptyResult = insertMissingExecutionNodes(updated, empty)
  assert.equal(emptyResult.length, empty.length)
  assert.ok(emptyResult.find(r => r.node.id === 'loop')?.node.childIds?.includes('requirement-review'))
  assert.equal(insertMissingExecutionNodes(updated, emptyResult), emptyResult)
})

test('additions after an expanded loop are placed after every iteration', () => {
  const { old, runs } = fixture()
  const newNode = node('join', 'code')
  const workflow = { nodes: [...old.nodes, newNode], edges: old.edges.flatMap(e => e.to === 'done' ? [edge(e.from, 'join'), edge('join', 'done')] : [e]) }
  const result = insertMissingExecutionNodes(workflow, runs)
  assert.equal(result.at(-2)?.node.id, 'join')
  assert.equal(result.at(-3)?.node.id, 'tail')
  assert.equal(result.at(-3)?.loopIndex, 1)
})

test('active requests, deletion, moving existing nodes, reordering and added loops are never implicitly rewritten', () => {
  const { old, updated, runs } = fixture()
  const running = runs.map((r, i) => i === 2 ? { ...r, status: 'running' } : r)
  assert.equal(insertMissingExecutionNodes(updated, running), running)
  assert.equal(insertMissingExecutionNodes({ ...updated, nodes: updated.nodes.filter(n => n.id !== 'observe') }, runs), runs)
  const moved = { ...updated, nodes: updated.nodes.map(n => n.id === 'loop' ? { ...n, childIds: n.childIds!.filter(id => id !== 'observe') } : n.id === 'observe' ? { ...n, parentId: undefined } : n) }
  assert.equal(insertMissingExecutionNodes(moved, runs), runs)
  const reordered = { ...old, edges: [edge('input', 'loop'), edge('loop', 'video'), edge('video', 'review'), edge('review', 'observe'), edge('observe', 'gate'), edge('gate', 'tail'), edge('tail', 'done')] }
  assert.equal(insertMissingExecutionNodes(reordered, runs), runs)
  const addedLoop = { ...old, nodes: [...old.nodes, { ...node('new-loop', 'loop'), childIds: [] }] }
  assert.equal(insertMissingExecutionNodes(addedLoop, runs), runs)
  assert.equal(insertMissingExecutionNodes(old, runs), runs)
})
