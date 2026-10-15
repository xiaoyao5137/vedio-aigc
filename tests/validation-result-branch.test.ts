import test from 'node:test'
import assert from 'node:assert/strict'
import { validationResultBranch } from '../src/workflow-branch.ts'

const node = (id: string, kind: string) => ({ id, kind })
const edge = (id: string, from: string, to: string, branch?: 'true' | 'false') => ({ id, from, to, ...(branch ? { branch } : {}) })

test('validation rejection reaches a decision only with one successor and both explicit exits', () => {
  const graph = {
    nodes: [node('video', 'video'), node('review', 'validation'), node('decision', 'branch'), node('concat', 'videoConcat')],
    edges: [edge('review-decision', 'review', 'decision'), edge('pass', 'decision', 'concat', 'true'),
      edge('retake', 'decision', 'video', 'false')],
  }
  assert.equal(validationResultBranch(graph, 'review'), true)
  assert.equal(validationResultBranch(graph, 'video'), false)
  assert.equal(validationResultBranch({ ...graph, edges: graph.edges.filter(item => item.id !== 'retake') }, 'review'), false)
  assert.equal(validationResultBranch({ ...graph, edges: [...graph.edges, edge('bypass', 'review', 'concat')] }, 'review'), false)
  assert.equal(validationResultBranch({ ...graph, edges: graph.edges.map(item => item.id === 'pass'
    ? edge('pass', 'decision', 'missing', 'true') : item) }, 'review'), false)
})
