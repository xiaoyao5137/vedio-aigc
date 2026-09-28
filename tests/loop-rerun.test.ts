import test from 'node:test'
import assert from 'node:assert/strict'
import {
  forkLoopRerun, isLoopIterationRun, loopRerunCandidates, nextLoopIterationRunIndex,
  planLoopRerun, runWorkflowLoopIteration, type LoopRerunRun,
} from '../src/loop-rerun.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { applyNodeOutputToContext, type StepRunStatus } from '../src/workflow-core.ts'
import { encodeExecutionState, decodeExecutionState } from '../src/execution-storage.ts'

const scope = { loopGroupId: 'shots-instance-1', loopIndex: 0 }
const loopNode = { id: 'shots', kind: 'loop', loop: { itemVar: 'scene' } }
type Run = LoopRerunRun & {
  node: { id: string; kind: string; title: string; resultVar: string }
  output?: unknown
  inputs?: Record<string, unknown>
  inputContext?: Record<string, unknown>
  routeInputContext?: Record<string, unknown>
  routeInputOverrides?: Record<string, unknown>
  branchState?: { visits: number; counts: { true: number; false: number } }
  branchEntryTarget?: string
  branchCarry?: Record<string, unknown>
  retryFeedback?: unknown
  paramOverrides?: Record<string, string>
  loopNode?: typeof loopNode
  loopItem?: unknown
  error?: string
  startedAt?: number
  durationMs: number
  errorAttempt?: number
}

function fixture() {
  const run = (id: string, loopIndex?: number): Run => ({
    id: `${id}-${loopIndex ?? 'root'}`,
    node: { id, title: id, kind: id === 'video' ? 'video' : 'code', resultVar: id },
    status: 'success', output: { url: `/${id}-${loopIndex}.mp4` }, context: { input: { topic: 'retained' } },
    durationMs: 23, revision: 4, attempt: 3, errorAttempt: 2,
    ...(loopIndex !== undefined ? { loopGroupId: scope.loopGroupId, loopIndex, loopNode, loopItem: { id: `scene-${loopIndex}` } } : {}),
  })
  const runs = [run('input'), run('shots'), run('script', 0), run('video', 0), run('review', 0),
    run('script', 1), run('video', 1), run('review', 1), run('deliver')]
  runs[2].output = { script: 'unchanged' }
  runs[2].context = { input: { topic: 'retained' }, script: runs[2].output }
  runs[3] = {
    ...runs[3], inputContext: runs[2].context, inputs: { prompt: 'paid original' },
    routeInputContext: { stale: 'route' }, routeInputOverrides: { stale: 'override' },
    retryFeedback: { defect: 'old' }, branchState: { visits: 9, counts: { true: 2, false: 7 } },
    branchEntryTarget: 'old', branchCarry: {}, paramOverrides: { prompt: 'keep the user edit' },
    error: 'old error', startedAt: 50, attempts: [{ output: { url: '/earlier.mp4' } }],
  }
  const state = {
    id: 'record-original', mode: 'run' as 'run' | 'step', requestScopeId: 'record-voice-archive',
    nodeRuns: runs, logs: ['all prior evidence retained'], context: { stale: 'final aggregation' },
    historical: true, branchHistory: [{ from: 'review', to: 'video', backwards: true, scene: [{ output: 'retained' }] }],
    runtimeInputs: { topic: 'unchanged' },
  }
  return state
}

const options = { id: 'record-retake', anchorIndex: 4, targetIndex: 3, createdAt: '2026-09-26T00:00:00Z' }

test('loop candidates are exact iteration instances and exclude unexecuted/skipped nodes', () => {
  const { nodeRuns: runs } = fixture()
  runs[4].status = 'idle'
  runs[2].status = 'skipped'
  assert.deepEqual(loopRerunCandidates(runs, 4).map(candidate => candidate.index), [3])
  runs[3].status = 'failed'
  assert.equal(loopRerunCandidates(runs, 4)[0].run, runs[3], 'a failed attempted generator can be retaken')
  assert.deepEqual(loopRerunCandidates(runs, 1), [])
  assert.deepEqual(loopRerunCandidates(runs, -1), [])
  assert.deepEqual(loopRerunCandidates(runs, 2.5), [])
})

test('plan preserves the prefix and invalidates the entire current and dependent future suffix', () => {
  const { nodeRuns: runs } = fixture()
  const plan = planLoopRerun(runs, options)
  assert.equal(plan.targetIndex, 3)
  assert.equal(plan.anchorIndex, 4)
  assert.equal(plan.roundEndIndex, 4)
  assert.equal(plan.preservedRunCount, 3)
  assert.equal(plan.currentRoundInvalidatedCount, 2)
  assert.equal(plan.downstreamInvalidatedCount, 4)
  assert.equal(plan.completedInvalidatedCount, 6)
  assert.deepEqual(plan.invalidatedIndexes, [3, 4, 5, 6, 7, 8])
  assert.deepEqual(plan.laterLoopIndexes, [1])
  assert.deepEqual(plan.invalidatedRunIds, runs.slice(3).map(run => run.id))
})

test('selection rejects another round or another expanded loop even when the node ID matches', () => {
  const { nodeRuns: runs } = fixture()
  assert.throws(() => planLoopRerun(runs, { anchorIndex: 4, targetIndex: 6 }), /LOOP_RERUN_TARGET_INVALID/)
  runs[3].loopGroupId = 'another-shots-expansion'
  assert.throws(() => planLoopRerun(runs, options), /LOOP_RERUN_TARGET_INVALID/)
  assert.throws(() => planLoopRerun(runs, { anchorIndex: 1, targetIndex: 3 }), /LOOP_RERUN_SCOPE_INVALID/)
  assert.throws(() => planLoopRerun(runs, { anchorIndex: 4, targetIndex: 3.5 }), /LOOP_RERUN_TARGET_INVALID/)
})

test('running, duplicate identity, unexecuted target and blocked prefix cannot create a fork', () => {
  for (const status of ['idle', 'skipped'] as const) {
    const state = fixture()
    state.nodeRuns[3].status = status
    assert.throws(() => forkLoopRerun(state, options), /LOOP_RERUN_TARGET_NOT_EXECUTED/)
  }
  const running = fixture()
  running.nodeRuns[7].status = 'running'
  assert.throws(() => forkLoopRerun(running, options), /LOOP_RERUN_BUSY/)
  const blocked = fixture()
  blocked.nodeRuns[2].status = 'failed'
  assert.throws(() => forkLoopRerun(blocked, options), /LOOP_RERUN_PREFIX_BLOCKED/)
  assert.throws(() => forkLoopRerun({ ...fixture(), persistenceError: 'disk full' }, options), /LOOP_RERUN_UNSAVED/)
  assert.throws(() => forkLoopRerun(fixture(), { ...options, id: 'record-original' }), /LOOP_RERUN_FORK_ID_INVALID/)
  const duplicate = fixture()
  duplicate.nodeRuns[7].id = duplicate.nodeRuns[4].id
  assert.throws(() => forkLoopRerun(duplicate, options), /LOOP_RERUN_IDENTITY_INVALID/)
})

test('fork retains original evidence and user settings, archives flat attempts, and clears all derived suffix state', () => {
  const original = fixture()
  const before = structuredClone(original)
  const { state: fork } = forkLoopRerun(original, options)
  assert.deepEqual(original, before, 'pure transition must not modify the loaded historical record')
  assert.equal(fork.id, options.id)
  assert.equal(fork.parentExecutionId, original.id)
  assert.equal(fork.mode, 'step')
  assert.equal(fork.historical, false)
  assert.equal(fork.branchHistory, original.branchHistory)
  assert.equal(fork.runtimeInputs, original.runtimeInputs)
  assert.deepEqual(fork.logs.slice(0, -1), original.logs)
  for (let index = 0; index < 3; index++) assert.equal(fork.nodeRuns[index], original.nodeRuns[index])
  assert.deepEqual(fork.context, original.nodeRuns[2].context)
  for (const run of fork.nodeRuns.slice(3)) {
    assert.equal(run.status, 'idle')
    assert.equal(run.revision, 5)
    assert.equal(run.attempt, 1)
    assert.equal(run.errorAttempt, 1)
    assert.deepEqual(run.context, {})
    assert.deepEqual(run.inputs, {})
    assert.deepEqual(run.inputContext, {})
    for (const key of ['output', 'routeInputContext', 'routeInputOverrides', 'retryFeedback', 'branchState', 'branchEntryTarget', 'branchCarry', 'error', 'startedAt'] as const) {
      assert.equal(run[key], undefined, `${key} must not survive invalidation`)
    }
    assert.equal(run.durationMs, 0)
  }
  assert.deepEqual(fork.nodeRuns[3].paramOverrides, original.nodeRuns[3].paramOverrides)
  const attempts = fork.nodeRuns[3].attempts!
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[1].output, original.nodeRuns[3].output)
  assert.deepEqual(attempts[1].inputs, original.nodeRuns[3].inputs)
  assert.equal(attempts[1].attempts, undefined, 'snapshot must not recursively duplicate attempt histories')
  assert.notEqual(attempts[1].output, original.nodeRuns[3].output)
  assert.equal(fork.loopRerun.sourceExecutionId, original.id)
  assert.deepEqual(fork.loopRerunHistory, [fork.loopRerun])
  const roundtrip = decodeExecutionState<typeof fork>(JSON.parse(JSON.stringify(encodeExecutionState(fork))))
  assert.deepEqual(roundtrip.nodeRuns[3].attempts, fork.nodeRuns[3].attempts)
  assert.deepEqual(roundtrip.loopRerun, fork.loopRerun)
})

test('sibling forks purchase distinct generations while preserving the fixed original voice archive', () => {
  const original = fixture()
  const first = forkLoopRerun(original, options).state
  const sibling = forkLoopRerun(original, { ...options, id: 'record-second-retake' }).state
  const request = (state: typeof first) => `${state.generationScopeId ?? state.requestScopeId ?? state.id}:attempt-${state.nodeRuns[3].attempt}:revision-${state.nodeRuns[3].revision}:video:0`
  assert.equal(first.requestScopeId, original.requestScopeId)
  assert.equal(sibling.requestScopeId, original.requestScopeId)
  assert.notEqual(request(first), request(sibling))
  assert.equal(first.nodeRuns[2].revision, original.nodeRuns[2].revision, 'paid retained prefix keeps its request revision')
  first.nodeRuns[3].status = 'failed'
  const second = forkLoopRerun(first, { ...options, id: 'record-third-retake' }).state
  assert.equal(second.nodeRuns[3].revision, 6)
  assert.deepEqual(second.loopRerunHistory.map(item => item.sourceExecutionId), [original.id, first.id])
  assert.equal(second.requestScopeId, original.requestScopeId)
})

test('paused current-round retake reuses earlier paid rounds and rebuilds loop.previous from new outputs', () => {
  const original = fixture()
  original.nodeRuns[7].status = 'idle'
  const fork = forkLoopRerun(original, { ...options, anchorIndex: 7, targetIndex: 6 }).state
  assert.equal(fork.nodeRuns[3], original.nodeRuns[3], 'previous-round paid video remains authoritative')
  const prepared = prepareWorkflowRunContext(fork.nodeRuns, 6)!
  assert.deepEqual(prepared.previousLoopResult?.video, original.nodeRuns[3].output)
  assert.equal(prepared.inputContext.video, undefined, 'invalidated current video must not leak through an old route')
  assert.deepEqual(prepared.inputContext.script, original.nodeRuns[5].output)
})

test('round runner executes only the chosen round and stops before the next paid round', async () => {
  const fork = forkLoopRerun(fixture(), options).state
  const calls: string[] = []
  const completed = await runWorkflowLoopIteration(fork, scope, async (index, state) => {
    calls.push(state.nodeRuns[index].id)
    const prepared = prepareWorkflowRunContext(state.nodeRuns, index)!
    const output = { url: '/new-retake.mp4' }
    const context = applyNodeOutputToContext(prepared.inputContext, prepared.run.node.resultVar, output)
    return { ...state, nodeRuns: state.nodeRuns.map((run, i) => i === index ? { ...run, output, context, status: 'success' as const } : run) }
  })
  assert.deepEqual(calls, ['video-0', 'review-0'])
  assert.equal(completed.nodeRuns[5].status, 'idle')
  assert.equal(completed.nodeRuns[8].status, 'idle')
  const next = prepareWorkflowRunContext(completed.nodeRuns, 5)!
  assert.deepEqual(next.previousLoopResult?.video, { url: '/new-retake.mp4' })
})

test('round runner stops for failures and paused idle checkpoints without spinning', async () => {
  const fork = forkLoopRerun(fixture(), options).state
  let calls = 0
  const paused = await runWorkflowLoopIteration(fork, scope, async (_index, state) => {
    calls++
    return { ...state, logs: [...state.logs, 'paused at breakpoint'] }
  })
  assert.equal(calls, 1)
  assert.equal(paused.nodeRuns[3].status, 'idle')
  calls = 0
  const failed = await runWorkflowLoopIteration(fork, scope, async (index, state) => {
    calls++
    return { ...state, nodeRuns: state.nodeRuns.map((run, i) => i === index ? { ...run, status: 'failed' as const } : run) }
  })
  assert.equal(calls, 1)
  assert.equal(failed.nodeRuns[4].status, 'idle')
})

test('round scope also guards conditional skip execution at the final node', async () => {
  const fork = forkLoopRerun(fixture(), options).state
  const calls: number[] = []
  const paid: number[] = []
  const completed = await runWorkflowLoopIteration(fork, scope, async (index, state) => {
    calls.push(index)
    const next = { ...state, nodeRuns: state.nodeRuns.map(run => ({ ...run })) }
    // Models executeStepIndex's internal skip loop with the same stop predicate.
    while (next.nodeRuns[index] && isLoopIterationRun(next.nodeRuns[index], scope) && index <= 4) {
      next.nodeRuns[index].status = 'skipped'
      index++
    }
    if (next.nodeRuns[index] && isLoopIterationRun(next.nodeRuns[index], scope)) paid.push(index)
    return next
  })
  assert.deepEqual(calls, [3])
  assert.deepEqual(paid, [])
  assert.equal(completed.nodeRuns[5].status, 'idle')
  assert.equal(nextLoopIterationRunIndex(completed.nodeRuns, scope), -1)
})

test('round runner follows newly expanded queues and branch revision progress within the same scope', async () => {
  const base = forkLoopRerun(fixture(), options).state
  const calls: string[] = []
  let rewound = false
  const completed = await runWorkflowLoopIteration(base, scope, async (index, state) => {
    const run = state.nodeRuns[index]
    calls.push(run.id)
    if (!rewound) {
      rewound = true
      return { ...state, nodeRuns: state.nodeRuns.map((item, i) => i === index ? { ...item, revision: item.revision! + 1 } : item) }
    }
    const runs = state.nodeRuns.map((item, i) => i === index ? { ...item, status: 'success' as const } : item)
    if (run.id === 'video-0') runs.splice(index + 1, 0, { ...run, id: 'dynamic-review', status: 'idle' as StepRunStatus })
    return { ...state, nodeRuns: runs }
  })
  assert.deepEqual(calls, ['video-0', 'video-0', 'dynamic-review', 'review-0'])
  assert.equal(completed.nodeRuns.find(run => run.id === 'script-1')?.status, 'idle')
})

test('round runner refuses to bypass an earlier unfinished round', async () => {
  const fork = forkLoopRerun(fixture(), options).state
  let calls = 0
  await runWorkflowLoopIteration(fork, { ...scope, loopIndex: 1 }, async () => { calls++; return undefined })
  assert.equal(calls, 0)
})
