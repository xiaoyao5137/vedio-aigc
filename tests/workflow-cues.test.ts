import assert from 'node:assert/strict'
import test from 'node:test'
import { WORKFLOW_CUES_STORAGE_KEY, loadWorkflowCuesEnabled, workflowTerminalCue } from '../src/workflow-cues.ts'

test('notification is enabled by default and honors a saved off switch', () => {
  assert.equal(loadWorkflowCuesEnabled({ getItem: () => null }), true)
  assert.equal(loadWorkflowCuesEnabled({ getItem: key => key === WORKFLOW_CUES_STORAGE_KEY ? 'false' : null }), false)
})

test('terminal sounds fire only when a run enters failure or all work completes', () => {
  const idle = [{ id: 'a', status: 'success' }, { id: 'b', status: 'idle' }]
  const running = [{ id: 'a', status: 'success' }, { id: 'b', status: 'running' }]
  const failed = [{ id: 'a', status: 'success' }, { id: 'b', status: 'failed' }]
  const completed = [{ id: 'a', status: 'success' }, { id: 'b', status: 'skipped' }]
  assert.equal(workflowTerminalCue(idle, running), undefined)
  assert.equal(workflowTerminalCue(running, failed), 'failed')
  assert.equal(workflowTerminalCue(failed, failed), undefined)
  assert.equal(workflowTerminalCue(running, completed), 'completed')
  assert.equal(workflowTerminalCue(completed, completed), undefined)
  assert.equal(workflowTerminalCue([], []), undefined)
})
