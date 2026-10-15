import test from 'node:test'
import assert from 'node:assert/strict'
import { assertWorkflowSchemaNotStale, workflowConfigContentChanged } from '../server/workflow-save-policy.ts'

const saved = { name: '三国', description: '短剧', voice_policy: 'strict',
  nodes: [{ id: 'video', params: [{ id: 'a', name: '画面', value: 'x' }] }],
  edges: [{ id: 'e', from: 'a', to: 'video' }] }

test('same persisted graph ignores schema-only drift and JSONB object key order', () => {
  const incoming = { name: '三国', description: '短剧', voicePolicy: 'strict', schemaVersion: 999,
    nodes: [{ params: [{ value: 'x', name: '画面', id: 'a' }], id: 'video' }],
    edges: [{ to: 'video', id: 'e', from: 'a' }] }
  assert.equal(workflowConfigContentChanged(saved, incoming), false)
  assert.equal(workflowConfigContentChanged(saved, { ...incoming, voicePolicy: undefined }), false)
})

test('a real graph, metadata or voice edit is still persisted', () => {
  const incoming = { name: '三国', description: '短剧', voicePolicy: 'strict',
    nodes: structuredClone(saved.nodes), edges: structuredClone(saved.edges) }
  assert.equal(workflowConfigContentChanged(saved, { ...incoming,
    nodes: [{ id: 'video', params: [{ id: 'a', name: '画面', value: 'new' }] }] }), true)
  assert.equal(workflowConfigContentChanged(saved, { ...incoming, description: '新说明' }), true)
  assert.equal(workflowConfigContentChanged(saved, { ...incoming, voicePolicy: 'flexible' }), true)
  assert.equal(workflowConfigContentChanged(undefined, incoming), true)
})

test('stale browser schema cannot overwrite a newer saved graph', () => {
  assert.throws(() => assertWorkflowSchemaNotStale('wf-sanguo-history-drama', 167, 168),
    /已拒绝回滚已部署的升级/)
  assert.doesNotThrow(() => assertWorkflowSchemaNotStale('wf-sanguo-history-drama', 168, 168))
  assert.doesNotThrow(() => assertWorkflowSchemaNotStale('wf-sanguo-history-drama', 169, 168))
})
