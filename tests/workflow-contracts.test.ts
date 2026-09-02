import test from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'

const request = {
  model: { capability: 'video' },
  executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' },
  params: { referenceImage: '/first.png', endImage: '/end.png', duration: 15 },
}

test('Sanguo paid video calls require the target end frame and exactly 15 seconds', () => {
  assert.doesNotThrow(() => validateWorkflowMediaContract(request))
  assert.doesNotThrow(() => validateWorkflowMediaContract({ ...request, params: { ...request.params, referenceImage: undefined } }))
  assert.throws(() => validateWorkflowMediaContract({ ...request, params: { ...request.params, endImage: undefined } }), /目标尾帧 endImage/)
  assert.throws(() => validateWorkflowMediaContract({ ...request, params: { ...request.params, duration: 14 } }), /duration=15/)
})

test('the boundary-frame contract does not affect unrelated video workflows', () => {
  assert.doesNotThrow(() => validateWorkflowMediaContract({
    model: { capability: 'video' },
    executionContext: { workflowId: 'wf-story', nodeId: 'node-video' },
    params: { duration: 3 },
  }))
})
