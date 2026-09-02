import test from 'node:test'
import assert from 'node:assert/strict'
import { APP_VIEW_STATE_STORAGE_KEY, loadAppViewState, parseAppViewState, saveAppViewState } from '../src/app-view-state.ts'

test('execution view survives a page remount through session storage', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
  const expected = { page: 'workflow' as const, workflowView: 'run' as const, activeWorkflowId: 'wf-history', runnerTab: 'execute' as const }

  saveAppViewState(storage, expected)

  assert.equal(values.has(APP_VIEW_STATE_STORAGE_KEY), true)
  assert.deepEqual(loadAppViewState(storage), expected)
})

test('invalid or stale view state cannot force an unsupported screen', () => {
  assert.deepEqual(parseAppViewState('{broken'), {})
  assert.deepEqual(parseAppViewState(JSON.stringify({
    page: 'unknown',
    workflowView: 'deleted',
    activeWorkflowId: 42,
    runnerTab: 'output',
  })), {})
})
