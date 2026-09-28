import test from 'node:test'
import assert from 'node:assert/strict'
import { branchSceneIncludesRun, branchSceneIndicesForRun } from '../src/branch-scenes.ts'
import { routeBranch, type BranchRun } from '../src/workflow-branch.ts'
const run = (id: string, status = 'success', loopIndex?: number): BranchRun => ({
  id: `${id}-${loopIndex ?? 'root'}`, node: { id, kind: id === 'branch' ? 'branch' : 'code', resultVar: id },
  status, context: {}, durationMs: 0, ...(loopIndex !== undefined ? { loopIndex, loopGroupId: 'loop' } : {}),
})

test('rewind rounds exclude untouched predecessors and successors even though the full scene contains them', () => {
  const runs = [run('input'), run('generate'), run('review'), run('branch'), run('loop', 'idle'), run('video', 'idle')]
  const workflow = { nodes: runs.map(r => r.node), edges: [{ id: 'back', from: 'branch', to: 'generate', branch: 'false' as const }] }
  const { history } = routeBranch(workflow, runs, 3, false, {})
  const saved = JSON.parse(JSON.stringify(history))
  assert.deepEqual(runs.map(r => branchSceneIncludesRun(saved, r)), [false, true, true, true, false, false])
  assert.equal(branchSceneIncludesRun(saved, run('video', 'success', 0)), false)
})

test('independent branches and different loop iterations keep their own archived round indices', () => {
  const a = run('generate', 'success', 0), b = run('generate', 'success', 1), c = run('other')
  const scene = [a, b, c]
  const scenes = [a, c, b, a].map(r => ({ backwards: true, scene, runs: [{ id: r.id }] }))
  assert.deepEqual(branchSceneIndicesForRun(scenes, a), [0, 3])
  assert.deepEqual(branchSceneIndicesForRun(scenes, b), [2])
  assert.deepEqual(branchSceneIndicesForRun(scenes, c), [1])
  assert.deepEqual(branchSceneIndicesForRun(scenes, undefined), [])
  assert.equal(branchSceneIncludesRun({ backwards: false, scene, runs: [{ id: a.id }] }, a), false)
})
