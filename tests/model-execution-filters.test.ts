import test from 'node:test'
import assert from 'node:assert/strict'
import { modelExecutionBindingFilters } from '../server/model-execution-filters.ts'

const query = () => new URLSearchParams({ workflowId: 'wf-history', nodeId: 'outline', operation: 'history.scene-outline',
  requestKeyPrefix: 'record-a_%:attempt-1:revision-3:outline:0::generation-' })

test('ledger prefix uses parameterized literal left equality with exact workflow/node/operation selectors', () => {
  const result = modelExecutionBindingFilters(query(), 4)
  assert.deepEqual(result.values, ['wf-history', 'outline', 'history.scene-outline', 'record-a_%:attempt-1:revision-3:outline:0::generation-'])
  assert.deepEqual(result.clauses, ['workflow_id = $5', 'node_id = $6', "request_data->>'operation' = $7", "left(request_data->>'requestKey', length($8)) = $8"])
  assert.equal(result.clauses.some(sql => /like/i.test(sql)), false)
  assert.deepEqual(modelExecutionBindingFilters(new URLSearchParams()), { values: [], clauses: [] })
})

test('partial or cross-node prefixes cannot widen the source lookup', () => {
  for (const key of ['workflowId', 'nodeId', 'operation']) {
    const params = query(); params.delete(key)
    assert.throws(() => modelExecutionBindingFilters(params), /MODEL_LEDGER_FILTER_INVALID/)
  }
  for (const prefix of ['record-a:', 'record-a:attempt-1:revision-3:other:0::generation-', 'record-a:attempt-0:revision-3:outline:0::generation-',
    'record-a:attempt-1:revision-3:outline:0::generation-2', 'record-a:attempt-1:revision-3:outline:0::generation-:evil']) {
    const params = query(); params.set('requestKeyPrefix', prefix)
    assert.throws(() => modelExecutionBindingFilters(params), /MODEL_LEDGER_FILTER_INVALID/)
  }
})

test('the actual storyboard recovery query binds its full scene and two successful supplier generations literally', () => {
  const prefix = 'record-lrjfd9:attempt-1:revision-1:sanguo-shot-script:3:scene-02-seg-3:generation-'
  const params = new URLSearchParams({ workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-shot-script',
    operation: 'history.storyboard', requestKeyPrefix: prefix })
  const result = modelExecutionBindingFilters(params)
  assert.deepEqual(result.values, ['wf-sanguo-history-drama', 'sanguo-shot-script', 'history.storyboard', prefix])
  assert.equal(result.clauses.at(-1), "left(request_data->>'requestKey', length($4)) = $4")
  for (const changed of [
    { operation: 'unknown-operation' }, { nodeId: 'other-node' },
    { requestKeyPrefix: prefix.replace('scene-02-seg-3:', ':') },
    { requestKeyPrefix: prefix.replace('scene-02-seg-3:', 'scene-02:seg-3:') },
    { requestKeyPrefix: prefix.replace('scene-02-seg-3:', ' scene-02-seg-3:') },
  ]) assert.throws(() => modelExecutionBindingFilters(new URLSearchParams({ ...Object.fromEntries(params), ...changed })), /MODEL_LEDGER_FILTER_INVALID/)
})
