import test from 'node:test'
import assert from 'node:assert/strict'
import {
  breakpointRollbackCandidates, forkBreakpointRollback, planBreakpointRollback, previousBreakpointRollbackCandidate, type BreakpointRollbackRun,
} from '../src/breakpoint-rollback.ts'
import { encodeExecutionState, decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { runWorkflowToCompletion } from '../src/workflow-runner.ts'
import { hasExecutionPlanMismatch, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import type { WorkflowBreakpoint } from '../src/workflow-breakpoints.ts'

type Run = BreakpointRollbackRun & {
  node: { id: string; title: string; kind: string; resultVar: string; childIds?: string[]; code?: string }
  output?: unknown
  inputs?: Record<string, unknown>
  durationMs: number
  attempt?: number
  errorAttempt?: number
  error?: string
  startedAt?: number
  routeInputContext?: Record<string, unknown>
  routeInputOverrides?: Record<string, unknown>
  retryFeedback?: unknown
  branchState?: { visits: number; counts: { true: number; false: number } }
  branchEntryTarget?: string
  branchCarry?: Record<string, unknown>
  storyboardSplitPlan?: unknown
  storyboardSplitCandidate?: unknown
  paramOverrides?: Record<string, string>
  loopPrevious?: Record<string, unknown>
  loopNode?: { loop: { itemVar: string } }
  loopItem?: unknown
}

const breakpoints: WorkflowBreakpoint[] = [
  { nodeId: 'outline', enabled: true },
  { nodeId: 'video', enabled: true, condition: { path: 'loop.index', operator: 'gte', value: 2 } },
  { nodeId: 'deliver', enabled: true },
]

function fixture() {
  const run = (nodeId: string, loopIndex?: number, loopGroupId = 'shots'): Run => ({
    id: `${nodeId}-${loopIndex === undefined ? 'root' : `${loopGroupId}-${loopIndex}`}`,
    node: { id: nodeId, title: nodeId, kind: nodeId === 'video' ? 'video' : 'code', resultVar: nodeId },
    status: 'success', output: { url: `/${nodeId}-${loopIndex}.mp4` },
    context: { input: { topic: 'retained' }, [nodeId]: { url: `/${nodeId}-${loopIndex}.mp4` } },
    inputContext: { input: { topic: 'retained' }, ...(loopIndex === undefined ? {} : { loop: { index: loopIndex + 1 }, scene: { id: `scene-${loopIndex}` } }) },
    revision: 4, attempt: 3, errorAttempt: 2, durationMs: 100,
    ...(loopIndex === undefined ? {} : { loopGroupId, loopIndex, loopNode: { loop: { itemVar: 'scene' } }, loopItem: { id: `scene-${loopIndex}` } }),
  })
  const runs = [run('input'), run('outline'), run('video', 0), run('review', 0), run('video', 1),
    run('review', 1), run('video', 0, 'second-shots'), run('deliver')]
  runs[4] = {
    ...runs[4], inputs: { prompt: 'old paid request' },
    routeInputContext: { stale: 'route' }, routeInputOverrides: { stale: 'override' },
    retryFeedback: { stale: 'feedback' }, branchState: { visits: 3, counts: { true: 1, false: 2 } },
    branchEntryTarget: 'old', branchCarry: {}, loopPrevious: { stale: 'previous' },
    storyboardSplitPlan: { stale: 'plan' }, storyboardSplitCandidate: { stale: 'candidate' },
    paramOverrides: { prompt: 'retained user edit' }, error: 'old error', startedAt: 50,
    attempts: [{ output: { url: '/earlier.mp4' } }],
  }
  return {
    id: 'record-original', mode: 'run' as 'run' | 'step', historical: true,
    requestScopeId: 'voice-archive', generationScopeId: 'old-generation',
    runtimeInputs: { topic: 'retained' }, nodeRuns: runs, context: { stale: 'final aggregation' },
    logs: ['original evidence'], branchHistory: [{ from: 'review', to: 'video' }],
  }
}

const options = { id: 'record-rollback', createdAt: '2026-09-27T00:00:00Z', targetRunId: 'video-shots-1', breakpoints }

test('candidates include reached non-loop and concrete conditional loop instances across groups', () => {
  const { nodeRuns } = fixture()
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, breakpoints).map(candidate => candidate.run.id),
    ['outline-root', 'video-shots-1', 'deliver-root'])
  const allRounds = [{ nodeId: 'video', enabled: true }]
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, allRounds).map(candidate => candidate.run.id),
    ['video-shots-0', 'video-shots-1', 'video-second-shots-0'])
})

test('previous breakpoint follows the execution position and excludes the current concrete run', () => {
  const { nodeRuns } = fixture()
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, breakpoints, 4)?.run.id, 'outline-root',
    'a completed current breakpoint is not its own predecessor')
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, breakpoints, 5)?.run.id, 'video-shots-1')
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, breakpoints)?.run.id, 'deliver-root',
    'a completed full run uses the end of its queue as the frontier')
  const allRounds = [{ nodeId: 'video', enabled: true }]
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, allRounds, 6)?.run.id, 'video-shots-1',
    'the preceding loop instance must be chosen, not another instance of the current node')
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, allRounds)?.run.id, 'video-second-shots-0')
})

test('previous breakpoint skips a current idle or failed breakpoint and is absent without an earlier target', () => {
  const { nodeRuns } = fixture()
  for (let index = 4; index < nodeRuns.length; index++) nodeRuns[index].status = 'idle'
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, breakpoints, 4)?.run.id, 'outline-root')
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, breakpoints)?.run.id, 'outline-root')
  nodeRuns[4].status = 'failed'
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, breakpoints)?.run.id, 'outline-root')
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, breakpoints, 1), undefined)
  assert.equal(previousBreakpointRollbackCandidate(nodeRuns, [{ nodeId: 'video', enabled: true }], 2), undefined)
})

test('conditions use saved inputs and never borrow a final context or another iteration', () => {
  const { nodeRuns } = fixture()
  nodeRuns[2].context = { loop: { index: 2 } }
  nodeRuns[4].inputContext = { loop: { index: '2' } }
  nodeRuns[6].inputContext = undefined
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, breakpoints).map(candidate => candidate.run.id),
    ['outline-root', 'deliver-root'])
  const sceneBreakpoint = [{ nodeId: 'video', enabled: true, condition: { path: 'scene.id', operator: 'eq' as const, value: 'scene-1' } }]
  nodeRuns[4].inputContext = { scene: { id: 'scene-1' } }
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, sceneBreakpoint).map(candidate => candidate.run.id), ['video-shots-1'])
})

test('only the current paused idle checkpoint is reached; future and unprepared idle instances are excluded', () => {
  const { nodeRuns } = fixture()
  for (let index = 4; index < nodeRuns.length; index++) nodeRuns[index].status = 'idle'
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, breakpoints).map(candidate => candidate.run.id),
    ['outline-root', 'video-shots-1'])
  nodeRuns[4].inputContext = {}
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, breakpoints).map(candidate => candidate.run.id), ['outline-root'])
  nodeRuns[4].inputContext = { loop: { index: 1 } }
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, breakpoints).map(candidate => candidate.run.id), ['outline-root'])
})

test('skipped nodes complete the prefix but cannot be rollback targets; failed nodes block later targets', () => {
  const { nodeRuns } = fixture()
  nodeRuns[1].status = 'skipped'
  nodeRuns[4].status = 'failed'
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, breakpoints).map(candidate => candidate.run.id), ['video-shots-1'])
  assert.equal(planBreakpointRollback(nodeRuns, breakpoints, 'video-shots-1').targetIndex, 4)
  assert.throws(() => planBreakpointRollback(nodeRuns, breakpoints, 'deliver-root'), /BREAKPOINT_ROLLBACK_TARGET_INVALID/)
  nodeRuns[3].status = 'failed'
  assert.throws(() => planBreakpointRollback(nodeRuns, breakpoints, 'video-shots-1'), /BREAKPOINT_ROLLBACK_TARGET_INVALID/)
})

test('disabled, removed and condition-mismatched breakpoints cannot authorize a rollback', () => {
  const { nodeRuns } = fixture()
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, []), [])
  assert.deepEqual(breakpointRollbackCandidates(nodeRuns, breakpoints.map(breakpoint => ({ ...breakpoint, enabled: false }))), [])
  assert.throws(() => planBreakpointRollback(nodeRuns, breakpoints, 'video-shots-0'), /BREAKPOINT_ROLLBACK_TARGET_INVALID/)
  assert.throws(() => planBreakpointRollback(nodeRuns, [], 'video-shots-1'), /BREAKPOINT_ROLLBACK_TARGET_INVALID/)
})

test('plan preserves the exact prefix and invalidates all future loops and downstream aggregation', () => {
  const { nodeRuns } = fixture()
  const plan = planBreakpointRollback(nodeRuns, breakpoints, options.targetRunId)
  assert.deepEqual(plan, {
    targetIndex: 4, targetRunId: options.targetRunId, targetNodeId: 'video', preservedRunCount: 4,
    invalidatedIndexes: [4, 5, 6, 7], invalidatedRunIds: nodeRuns.slice(4).map(run => run.id), completedInvalidatedCount: 4,
  })
  assert.equal(planBreakpointRollback(nodeRuns, breakpoints, 'outline-root').targetIndex, 1)
})

test('unsaved, running, duplicate-instance and invalid-fork records are rejected before any mutation', () => {
  const state = fixture(), before = structuredClone(state)
  assert.throws(() => forkBreakpointRollback({ ...state, persistenceError: 'disk full' }, options), /BREAKPOINT_ROLLBACK_UNSAVED/)
  assert.throws(() => forkBreakpointRollback(state, { ...options, id: state.id }), /BREAKPOINT_ROLLBACK_FORK_ID_INVALID/)
  assert.throws(() => forkBreakpointRollback(state, { ...options, id: ' ' }), /BREAKPOINT_ROLLBACK_FORK_ID_INVALID/)
  assert.throws(() => forkBreakpointRollback(state, { ...options, createdAt: '' }), /BREAKPOINT_ROLLBACK_TIME_INVALID/)
  assert.throws(() => forkBreakpointRollback(state, { ...options, targetRunId: 'absent' }), /BREAKPOINT_ROLLBACK_TARGET_INVALID/)
  const running = fixture()
  running.nodeRuns[7].status = 'running'
  assert.throws(() => forkBreakpointRollback(running, options), /BREAKPOINT_ROLLBACK_BUSY/)
  const duplicate = fixture()
  duplicate.nodeRuns[7].id = duplicate.nodeRuns[4].id
  assert.throws(() => forkBreakpointRollback(duplicate, options), /BREAKPOINT_ROLLBACK_IDENTITY_INVALID/)
  assert.deepEqual(state, before)
})

test('fork is pure, preserves audit evidence and user settings, and clears every derived suffix field', () => {
  const state = fixture(), before = structuredClone(state)
  const { state: fork } = forkBreakpointRollback(state, options)
  assert.deepEqual(state, before)
  for (let index = 0; index < 4; index++) assert.equal(fork.nodeRuns[index], state.nodeRuns[index])
  assert.equal(fork.runtimeInputs, state.runtimeInputs)
  assert.equal(fork.branchHistory, state.branchHistory)
  assert.equal(fork.parentExecutionId, state.id)
  assert.equal(fork.mode, 'step')
  assert.equal(fork.historical, false)
  assert.deepEqual(fork.context, state.nodeRuns[3].context)
  assert.deepEqual(fork.logs.slice(0, -1), state.logs)
  for (const run of fork.nodeRuns.slice(4)) {
    assert.equal(run.status, 'idle')
    assert.equal(run.revision, 5)
    assert.equal(run.attempt, 1)
    assert.equal(run.errorAttempt, 1)
    assert.equal(run.durationMs, 0)
    assert.deepEqual(run.context, {})
    assert.deepEqual(run.inputs, {})
    assert.deepEqual(run.inputContext, {})
    for (const key of ['output', 'routeInputContext', 'routeInputOverrides', 'retryFeedback', 'branchState', 'branchEntryTarget', 'branchCarry',
      'storyboardSplitPlan', 'storyboardSplitCandidate', 'loopPrevious', 'error', 'startedAt'] as const) assert.equal(run[key], undefined, key)
  }
  assert.deepEqual(fork.nodeRuns[4].paramOverrides, state.nodeRuns[4].paramOverrides)
  assert.equal(fork.nodeRuns[4].attempts!.length, 2)
  assert.deepEqual(fork.nodeRuns[4].attempts![1].output, state.nodeRuns[4].output)
  assert.notEqual(fork.nodeRuns[4].attempts![1].output, state.nodeRuns[4].output)
  assert.equal(fork.nodeRuns[4].attempts![1].attempts, undefined)
})

test('rollback to the first breakpoint resets global context without submitting work', () => {
  const state = fixture()
  const firstBreakpoint = [{ nodeId: 'input', enabled: true }]
  const fork = forkBreakpointRollback(state, { ...options, breakpoints: firstBreakpoint, targetRunId: 'input-root' }).state
  assert.deepEqual(fork.context, {})
  assert.equal(fork.selectedNodeId, 'input')
  assert.ok(fork.nodeRuns.every(run => run.status === 'idle'))
})

test('first-node rollback refreshes compatible definition changes without triggering the all-idle plan reset', () => {
  const original = fixture()
  original.nodeRuns[1].node = { ...original.nodeRuns[1].node, code: 'return 1;' }
  const before = structuredClone(original)
  const definitions = [...new Map(original.nodeRuns.map(run => [run.node.id, run.node])).values()]
  const workflow = { nodes: definitions.map(node => node.id === 'outline' ? { ...node, code: 'return 2;' } : node), edges: [] }
  const fork = forkBreakpointRollback(original, { ...options, targetRunId: 'input-root',
    breakpoints: [{ nodeId: 'input', enabled: true }] }).state
  assert.ok(fork.nodeRuns.every(run => run.status === 'idle'))
  assert.equal(hasExecutionPlanMismatch(workflow, fork.nodeRuns), true, 'an unrefreshed fork would enter the runner reset effect')
  const refreshed = { ...fork, nodeRuns: refreshPendingExecutionNodes(workflow, fork.nodeRuns) }
  assert.equal(hasExecutionPlanMismatch(workflow, refreshed.nodeRuns), false)
  assert.equal(refreshed.nodeRuns[1].node.code, 'return 2;')
  assert.ok(refreshed.nodeRuns.every(run => run.status === 'idle'))
  assert.equal(refreshed.id, options.id)
  assert.equal(refreshed.parentExecutionId, original.id)
  assert.equal(refreshed.breakpointRollback, fork.breakpointRollback)
  assert.equal(refreshed.breakpointRollback.targetRunId, 'input-root')
  assert.deepEqual(original, before, 'refreshing a fork must leave the source definitions and execution evidence intact')
})

test('sibling rollbacks buy distinct generations while retaining the stable voice/archive scope', () => {
  const state = fixture()
  const first = forkBreakpointRollback(state, options).state
  const sibling = forkBreakpointRollback(state, { ...options, id: 'record-sibling' }).state
  assert.equal(first.requestScopeId, state.requestScopeId)
  assert.equal(sibling.requestScopeId, state.requestScopeId)
  assert.notEqual(first.generationScopeId, sibling.generationScopeId)
  assert.equal(first.nodeRuns[3].revision, state.nodeRuns[3].revision)
  const withoutScope = { ...fixture(), requestScopeId: undefined }
  assert.equal(forkBreakpointRollback(withoutScope, options).state.requestScopeId, withoutScope.id)
})

test('rollback provenance survives storage and accumulates across repeated forks', () => {
  const original = fixture()
  const first = forkBreakpointRollback(original, options).state
  first.nodeRuns[4] = { ...first.nodeRuns[4], status: 'success', inputContext: { loop: { index: 2 } } }
  const second = forkBreakpointRollback(first, { ...options, id: 'record-second' }).state
  assert.deepEqual(second.breakpointRollbackHistory.map(item => item.sourceExecutionId), [original.id, first.id])
  assert.equal(second.breakpointRollback.targetRunId, options.targetRunId)
  assert.equal(second.breakpointRollback.loopGroupId, 'shots')
  assert.equal(second.breakpointRollback.loopIndex, 1)
  assert.deepEqual(second.breakpointRollback.breakpoint, breakpoints[1])
  assert.notEqual(second.breakpointRollback.breakpoint, breakpoints[1])
  const decoded = decodeExecutionState<typeof second>(JSON.parse(JSON.stringify(encodeExecutionState(second))))
  assert.deepEqual(decoded.breakpointRollbackHistory, second.breakpointRollbackHistory)
  assert.deepEqual(decoded.nodeRuns[4].attempts, JSON.parse(JSON.stringify(second.nodeRuns[4].attempts)))
})

test('loop context rebuild reuses retained paid previous rounds without resurrecting old routes or outputs', () => {
  const original = fixture()
  const fork = forkBreakpointRollback(original, options).state
  const prepared = prepareWorkflowRunContext(fork.nodeRuns, 4)!
  assert.deepEqual(prepared.previousLoopResult?.video, original.nodeRuns[2].output)
  assert.equal(prepared.inputContext.video, undefined)
  assert.equal(prepared.inputContext.stale, undefined)
  assert.equal((prepared.inputContext.loop as { index: number }).index, 2)
})

test('rolling back a loop owner retains its queue for topology checks and standard execution replaces old instances once', async () => {
  const original = fixture()
  original.nodeRuns = original.nodeRuns.filter(run => run.loopGroupId !== 'second-shots')
  original.nodeRuns[1] = { ...original.nodeRuns[1], id: 'shots-root',
    node: { id: 'shots', title: 'shots', kind: 'loop', resultVar: 'shots', childIds: ['video', 'review'] } }
  const before = structuredClone(original)
  const fork = forkBreakpointRollback(original, { ...options, targetRunId: 'shots-root',
    breakpoints: [{ nodeId: 'shots', enabled: true }] }).state
  assert.deepEqual(fork.nodeRuns.map(run => run.node.id), original.nodeRuns.map(run => run.node.id))
  assert.deepEqual(fork.nodeRuns.slice(2, 6).map(run => run.id), original.nodeRuns.slice(2, 6).map(run => run.id))
  assert.ok(fork.nodeRuns.slice(1).every(run => run.status === 'idle' && run.output === undefined))
  const calls: string[] = []
  const completed = await runWorkflowToCompletion(fork, async (index, state) => {
    const current = state.nodeRuns[index]
    calls.push(current.id)
    const output = { generated: current.id }
    let nodeRuns = state.nodeRuns.map((run, at) => at === index
      ? { ...run, status: 'success' as const, output, context: { [run.node.resultVar!]: output } } : run)
    if (current.node.kind === 'loop') {
      const expanded = state.nodeRuns.filter(run => run.loopGroupId === 'shots').map(run => ({
        ...run, id: `${run.node.id}-fresh-${run.loopIndex}`, loopGroupId: 'fresh-shots',
      }))
      // This is the queue replacement contract used by executeStepIndex when an
      // owner runs: old child instances are removed before the fresh expansion.
      nodeRuns = [...nodeRuns.slice(0, index + 1), ...expanded,
        ...nodeRuns.slice(index + 1).filter(run => !current.node.childIds!.includes(run.node.id))]
    }
    return { ...state, nodeRuns }
  })
  assert.deepEqual(calls, ['shots-root', 'video-fresh-0', 'review-fresh-0', 'video-fresh-1', 'review-fresh-1', 'deliver-root'])
  assert.ok(completed.nodeRuns.every(run => run.status === 'success'))
  assert.equal(completed.nodeRuns.filter(run => run.node.id === 'video').length, 2)
  assert.ok(completed.nodeRuns.every(run => run.loopGroupId !== 'shots'))
  assert.deepEqual(original, before)
})
