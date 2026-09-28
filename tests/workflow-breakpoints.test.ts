import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_WORKFLOW_BREAKPOINTS_STORAGE_KEY, WORKFLOW_BREAKPOINTS_STORAGE_KEY, breakpointConditionMatches, createWorkflowBreakpointResolver, loadWorkflowBreakpoints, parseBreakpointValue, saveWorkflowBreakpoints, setWorkflowBreakpoint, shouldPauseAtBreakpoint, shouldPauseBeforeRun, toggleWorkflowBreakpoint } from '../src/workflow-breakpoints.ts'
import { findNextBreakpointIndex } from '../src/workflow-core.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

test('continuing past a breakpoint preserves it for the next loop and after a page remount', () => {
  const storage = memoryStorage()
  let breakpoints = toggleWorkflowBreakpoint({}, 'workflow', 'shot')
  breakpoints = toggleWorkflowBreakpoint(breakpoints, 'workflow', 'review')
  saveWorkflowBreakpoints(storage, breakpoints)
  const runs = ['input', 'shot', 'review', 'shot', 'review'].map(id => ({ node: { id } }))
  const ids = new Set(breakpoints.workflow.map((breakpoint) => breakpoint.nodeId))
  assert.equal(findNextBreakpointIndex(runs, ids, -1), 1)
  assert.equal(findNextBreakpointIndex(runs, ids, 1), 2)
  assert.equal(findNextBreakpointIndex(runs, ids, 2), 3)
  assert.deepEqual([...ids], ['shot', 'review'])
  const restored = loadWorkflowBreakpoints(storage)
  assert.deepEqual(restored, breakpoints)
  assert.equal(findNextBreakpointIndex(runs, new Set(restored.workflow.map((breakpoint) => breakpoint.nodeId)), 2), 3)
})

test('only explicitly toggling a breakpoint removes it, independently per workflow', () => {
  const original = {
    a: [{ nodeId: 'shot', enabled: true }, { nodeId: 'review', enabled: true }],
    b: [{ nodeId: 'shot', enabled: true }],
  }
  const next = toggleWorkflowBreakpoint(original, 'a', 'shot')
  assert.deepEqual(next, { a: [{ nodeId: 'review', enabled: true }], b: [{ nodeId: 'shot', enabled: true }] })
  assert.deepEqual(original, {
    a: [{ nodeId: 'shot', enabled: true }, { nodeId: 'review', enabled: true }],
    b: [{ nodeId: 'shot', enabled: true }],
  })
  const storage = memoryStorage()
  saveWorkflowBreakpoints(storage, next)
  assert.deepEqual(loadWorkflowBreakpoints(storage), next)
})

test('a running debugger resolves breakpoints enabled after continue started', () => {
  let breakpoints = {} as ReturnType<typeof loadWorkflowBreakpoints>
  const resolveBreakpoint = createWorkflowBreakpointResolver(() => breakpoints, 'workflow')

  assert.equal(resolveBreakpoint('review'), undefined)
  breakpoints = toggleWorkflowBreakpoint(breakpoints, 'workflow', 'review')
  assert.deepEqual(resolveBreakpoint('review'), { nodeId: 'review', enabled: true })
  breakpoints = toggleWorkflowBreakpoint(breakpoints, 'workflow', 'review')
  assert.equal(resolveBreakpoint('review'), undefined)
})

test('invalid and inaccessible browser storage does not prevent debugging', () => {
  for (const value of ['null', '[]', '{broken', '42']) {
    assert.deepEqual(loadWorkflowBreakpoints({ getItem: () => value }), {})
  }
  assert.deepEqual(loadWorkflowBreakpoints({ getItem: () => { throw new Error('denied') } }), {})
  assert.deepEqual(loadWorkflowBreakpoints({ getItem: () => '{"a":["shot","shot",null,42,""],"b":false}' }), { a: [{ nodeId: 'shot', enabled: true }] })
})

test('legacy node-id breakpoints migrate to enabled breakpoint objects', () => {
  const storage = memoryStorage()
  storage.setItem(LEGACY_WORKFLOW_BREAKPOINTS_STORAGE_KEY, JSON.stringify({ workflow: ['shot', 'review', 'shot'] }))
  assert.deepEqual(loadWorkflowBreakpoints(storage), { workflow: [
    { nodeId: 'shot', enabled: true },
    { nodeId: 'review', enabled: true },
  ] })
  saveWorkflowBreakpoints(storage, loadWorkflowBreakpoints(storage))
  assert.ok(storage.getItem(WORKFLOW_BREAKPOINTS_STORAGE_KEY))
})

test('loop index conditions stop only the matching concrete iteration', () => {
  const breakpoint = {
    nodeId: 'video', enabled: true,
    condition: { path: 'loop.index', operator: 'eq' as const, value: 2 },
  }
  assert.equal(shouldPauseAtBreakpoint(breakpoint, 'video', { loop: { index: 1, zeroIndex: 0 } }), false)
  assert.equal(shouldPauseAtBreakpoint(breakpoint, 'video', { loop: { index: 2, zeroIndex: 1 } }), true)
  assert.equal(shouldPauseAtBreakpoint(breakpoint, 'review', { loop: { index: 2, zeroIndex: 1 } }), false)
})

test('continuing ignores only the paused run and still stops at a later loop run of the same node', () => {
  const breakpoint = {
    nodeId: 'video', enabled: true,
    condition: { path: 'loop.index', operator: 'gte' as const, value: 2 },
  }
  const secondRound = { id: 'video-loop-1', node: { id: 'video' } }
  const thirdRound = { id: 'video-loop-2', node: { id: 'video' } }
  assert.equal(shouldPauseBeforeRun(breakpoint, secondRound, { loop: { index: 2 } }, secondRound.id), false)
  assert.equal(shouldPauseBeforeRun(breakpoint, thirdRound, { loop: { index: 3 } }, secondRound.id), true)
})

test('conditional comparison is typed and missing loop variables do not match ordered comparisons', () => {
  assert.equal(breakpointConditionMatches({ path: 'loop.index', operator: 'gte', value: 3 }, { loop: { index: 3 } }), true)
  assert.equal(breakpointConditionMatches({ path: 'loop.index', operator: 'gte', value: 3 }, {}), false)
  assert.equal(breakpointConditionMatches({ path: 'loop.index', operator: 'ne', value: 3 }, {}), false)
  assert.equal(breakpointConditionMatches({ path: 'loop.index', operator: 'eq', value: 3 }, { loop: { index: '3' } }), false)
  assert.equal(breakpointConditionMatches({ path: 'scene.id', operator: 'eq', value: 'scene-03' }, { scene: { id: 'scene-03' } }), true)
})

test('condition values parse JSON primitives and preserve plain text', () => {
  assert.equal(parseBreakpointValue('3'), 3)
  assert.equal(parseBreakpointValue('true'), true)
  assert.equal(parseBreakpointValue('scene-03'), 'scene-03')
})

test('setting a condition replaces only the matching node breakpoint', () => {
  const initial = toggleWorkflowBreakpoint({}, 'workflow', 'video')
  const next = setWorkflowBreakpoint(initial, 'workflow', {
    nodeId: 'video', enabled: true,
    condition: { path: 'loop.index', operator: 'eq', value: 3 },
  })
  assert.deepEqual(next.workflow, [{
    nodeId: 'video', enabled: true,
    condition: { path: 'loop.index', operator: 'eq', value: 3 },
  }])
})
