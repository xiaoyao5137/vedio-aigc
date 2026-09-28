import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveNodePolicy } from '../src/node-policy-input.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

test('review policy reads selected fields from the effective gate, including changed runtime values', () => {
  const source = { nodeId: 'any-quality-gate', fields: ['maxPhoneticErrorRate', 'timingTolerance'] }
  const nodes = [{ id: 'any-quality-gate', values: { maxPhoneticErrorRate: .2, timingTolerance: .25, unrelated: 'do not expose' } }]
  const original = structuredClone(nodes)
  const policy = resolveNodePolicy(source, nodes, node => node.values)
  assert.deepEqual(policy, { maxPhoneticErrorRate: .2, timingTolerance: .25 })
  assert.deepEqual(nodes, original)
  const request = renderWorkflowTemplate('实际阈值：${params.reviewPolicy}', { params: { reviewPolicy: policy } })
  assert.ok(request.includes('0.2'));assert.ok(!request.includes('unrelated'))
  const overridden = nodes.map(node => ({ ...node, values: { ...node.values, maxPhoneticErrorRate: .13 } }))
  assert.equal(resolveNodePolicy(source, overridden, node => node.values)?.maxPhoneticErrorRate, .13)
})

test('missing, ambiguous or unresolved policy fails before review instead of inventing a default threshold', () => {
  const source = { nodeId: 'gate', fields: ['threshold'] }
  const node = { id: 'gate' }, resolve = () => ({ threshold: .2 })
  assert.equal(resolveNodePolicy(undefined, [], resolve), undefined)
  for (const nodes of [[], [node, node]]) assert.throws(() => resolveNodePolicy(source, nodes, resolve), /必须唯一找到/)
  for (const value of [undefined, null, NaN, '${unresolved}']) assert.throws(() => resolveNodePolicy(source, [node], () => ({ threshold: value })), /未解析/)
  for (const fields of [[], ['threshold', 'threshold'], ['__proto__'], [3]]) assert.throws(() => resolveNodePolicy({ ...source, fields }, [node], resolve), /列表无效/)
})
