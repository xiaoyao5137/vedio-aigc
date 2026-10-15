import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { applyNodeOutputToContext, type StepRunStatus } from '../src/workflow-core.ts'
import { retryBranchRun, routeBranch, type BranchRun } from '../src/workflow-branch.ts'
import { acceptanceTransition } from '../src/node-retry.ts'
import { runWorkflowToCompletion } from '../src/workflow-runner.ts'
import { renderRetryFeedbackPrompt, renderWorkflowTemplate } from '../src/workflow-template.ts'

const captured = JSON.parse(readFileSync(new URL('./fixtures/stale-review-context.json', import.meta.url), 'utf8'))
const node = (id: string, kind = 'code') => ({ id, kind, resultVar: id, prompt: '${observations}', params: [] })
const loop = { ...node('loop', 'loop'), loop: { itemVar: 'item' } }
type Run = BranchRun & { status: StepRunStatus; loopNode?: typeof loop }
const run = (id: string, kind = 'code'): Run => ({ id, node: node(id, kind), status: 'success', durationMs: 1,
  loopNode: loop, loopGroupId: 'g', loopIndex: 0, loopItem: { id: 'current' }, context: {}, inputContext: {}, revision: 4 })

function fixture() {
  const input = { input: { topic: 'preserved' } }
  const video = { url: '/generated/already-paid.mp4' }
  const current = { ...input, video, observations: captured.freshObservations }
  const obsolete = { ...input, video, observations: captured.staleObservations }
  const state = { visits: 2, counts: { true: 1, false: 1 } }
  const runs: Run[] = [
    { ...run('before', 'branch'), loopNode: undefined, loopGroupId: undefined, loopIndex: undefined, branchState: state, context: input },
    { ...run('video', 'video'), output: video, context: { ...input, video } },
    { ...run('observations', 'text'), output: captured.freshObservations, context: current },
    { ...run('review', 'text'), routeInputContext: obsolete, retryFeedback: captured.reviewRetryFeedback, context: obsolete, inputContext: obsolete },
    { ...run('gate'), context: obsolete },
    { ...run('retry', 'branch'), status: 'idle', branchState: state, context: obsolete },
  ]
  return { runs, current }
}

test('manual reviewer retry uses all six current observations and drops the superseded report without buying media', () => {
  const { runs } = fixture()
  const retried = manualRetryRuns(runs, 3)
  const prepared = prepareWorkflowRunContext(retried, 3)!
  assert.deepEqual(prepared.inputContext.observations, captured.freshObservations)
  assert.equal((prepared.inputContext.observations as { items: unknown[] }).items.length, 6)
  assert.equal((prepared.inputContext.retry as { feedback: unknown }).feedback, '')
  assert.equal(retried[3].routeInputContext, undefined)
  assert.equal(retried[3].revision, runs[3].revision! + 1)
  assert.equal(retried[0], runs[0], 'earlier routing budget is not reset')
  assert.equal(retried[1], runs[1], 'paid video keeps its identity and request revision')
  assert.equal(retried[2], runs[2], 'completed observations are reused')
  const prompt = renderWorkflowTemplate('${observations}', prepared.inputContext)
    + renderRetryFeedbackPrompt((prepared.inputContext.retry as { feedback: unknown }).feedback)
  assert.deepEqual(JSON.parse(prompt), captured.freshObservations, 'the actual prompt formatter receives current evidence only')
  assert.deepEqual(runs[3].routeInputContext?.observations, captured.staleObservations, 'the original checkpoint remains immutable')
})

test('a routed loop input cannot overwrite current outputs or restore a previous iteration after replay', () => {
  const { runs } = fixture()
  runs[3].routeInputContext = { ...runs[3].routeInputContext, item: { id: 'old-item' }, loop: { zeroIndex: 8 }, gate: { passed: false } }
  const prepared = prepareWorkflowRunContext(runs, 3)!
  assert.deepEqual(prepared.inputContext.observations, captured.freshObservations)
  assert.deepEqual(prepared.inputContext.item, { id: 'current' })
  assert.equal((prepared.inputContext.loop as { zeroIndex: number }).zeroIndex, 0)
  assert.equal(prepared.inputContext.gate, undefined, 'invalidated downstream outputs are not current inputs')
})

test('loop replay rejects a completed context patch that forges validation evidence', () => {
  const runs: Run[] = [
    { ...run('quality', 'validation'), output: { passed: true } },
    { ...run('patcher', 'code'), output: { contextPatch: { quality: { passed: false } } } },
    { ...run('next', 'video'), status: 'idle' },
  ]
  assert.throws(() => prepareWorkflowRunContext(runs, 2), /VALIDATION_RESULT_CONTEXT_PATCH_CONFLICT/)
  assert.deepEqual(runs[0].output, { passed: true })
})

test('restoring a saved top-level run rejects a previously persisted forged validation patch', () => {
  const detached = (id: string, kind: string) => ({ ...run(id, kind), loopNode: undefined,
    loopGroupId: undefined, loopIndex: undefined, loopItem: undefined })
  const runs: Run[] = [
    { ...detached('quality', 'validation'), output: { passed: true }, context: { quality: { passed: true } } },
    { ...detached('patcher', 'code'), output: { contextPatch: { quality: { passed: false } } },
      context: { quality: { passed: false } } },
    { ...detached('next', 'video'), status: 'idle' },
  ]
  assert.throws(() => prepareWorkflowRunContext(runs, 2), /VALIDATION_RESULT_CONTEXT_PATCH_CONFLICT/)
})

test('rerunning the observer feeds its replacement into the actual next step context', async () => {
  const { runs } = fixture()
  let mediaPurchases = 0
  const observedInputs: Record<string, unknown>[] = []
  const state = { nodeRuns: manualRetryRuns(runs, 2) }
  await runWorkflowToCompletion(state, async (index, state) => {
    const prepared = prepareWorkflowRunContext(state.nodeRuns, index)!
    if (prepared.run.node.kind === 'video') mediaPurchases++
    if (prepared.run.node.id === 'review') observedInputs.push(prepared.inputContext)
    const output = prepared.run.node.id === 'observations' ? captured.freshObservations : { passed: true }
    const context = applyNodeOutputToContext(prepared.inputContext, prepared.run.node.resultVar, output)
    return { nodeRuns: state.nodeRuns.map((run, i) => i === index ? { ...run, output, context, inputContext: prepared.inputContext, status: 'success' as const } : run) }
  })
  assert.equal(mediaPurchases, 0)
  assert.equal(observedInputs.length, 1)
  assert.deepEqual(observedInputs[0].observations, captured.freshObservations)
  assert.equal((observedInputs[0].retry as { feedback: unknown }).feedback, '')
})

test('automatic branch rewind retains its current feedback and deciding budget while removing other stale route state', () => {
  const { runs, current } = fixture()
  runs[3].inputContext = current
  runs[3].output = { passed: false, issues: ['current defect'] }
  const workflow = { nodes: [...runs.map(run => run.node), node('done')], edges: [
    { id: 'back', from: 'retry', to: 'review', branch: 'false' as const },
    { id: 'next', from: 'retry', to: 'done', branch: 'true' as const },
  ] }
  runs.push({ ...run('done'), status: 'idle' })
  const transition = routeBranch(workflow, runs, 5, { value: false, feedback: 'current correction' }, { ...current, review: runs[3].output })
  const prepared = prepareWorkflowRunContext(transition.runs, transition.index)!
  assert.equal(transition.index, 3)
  assert.equal((prepared.inputContext.retry as { feedback: unknown }).feedback, 'current correction')
  assert.deepEqual(prepared.inputContext.observations, captured.freshObservations)
  assert.equal(transition.runs[5].branchState!.counts.false, 2)
  assert.equal(transition.runs[5].branchState!.counts.true, 1)
  assert.equal(transition.runs[4].routeInputContext, undefined)
  assert.equal(transition.runs[4].retryFeedback, undefined)
  assert.equal(transition.runs[1], runs[1])
})

test('legacy acceptance and manual invalidation share cleanup while preserving bounded retry feedback', () => {
  const { runs } = fixture()
  const legacy = runs.slice(1, 5).map(run => ({ ...run, node: { ...run.node, acceptance: undefined as { passedPath: string; retryFrom: string; maxAttempts: number } | undefined } }))
  legacy[3].node.acceptance = { passedPath: 'passed', retryFrom: 'review', maxAttempts: 2 }
  const transition = acceptanceTransition(legacy, 3, { passed: false, issues: ['new correction'] })!
  assert.deepEqual(transition.runs[2].retryFeedback, ['new correction'])
  assert.equal(transition.runs[2].routeInputContext, undefined)
  assert.equal(transition.runs[2].attempt, 2)
  assert.equal(transition.runs[0], legacy[0])
  const exhausted = acceptanceTransition(transition.runs, 3, { passed: false, issues: ['still rejected'] })!
  assert.equal(exhausted.exhausted, true)
  assert.equal(exhausted.runs[3].status, 'failed')
})

test('manual invalidation removes transient loop entry state but keeps parameter edits, evidence and independent cuts', () => {
  const { runs } = fixture()
  runs[3] = { ...runs[3], branchEntryTarget: 'old-target', branchCarry: {}, paramOverrides: { limit: '4' }, attempts: [{ output: 'saved evidence' }] }
  const revised = manualRetryRuns(runs, 3, new Set([3, 4]))
  assert.equal(revised[3].branchEntryTarget, undefined)
  assert.equal(revised[3].branchCarry, undefined)
  assert.deepEqual(revised[3].paramOverrides, { limit: '4' })
  assert.deepEqual(revised[3].attempts, [{ output: 'saved evidence' }])
  assert.equal(revised[5], runs[5], 'explicitly retained independent cut remains untouched')
})

test('explicit branch input edits survive branch-only retry without restoring its other stale snapshot fields', () => {
  const { runs } = fixture()
  runs[5] = { ...runs[5], status: 'failed', routeInputContext: { observations: captured.staleObservations },
    routeInputOverrides: { gate: { passed: true, reason: 'explicit debug edit' } } }
  const retried = retryBranchRun(runs, 5)
  const prepared = prepareWorkflowRunContext(retried, 5)!
  assert.deepEqual(prepared.inputContext.observations, captured.freshObservations)
  assert.deepEqual(prepared.inputContext.gate, { passed: true, reason: 'explicit debug edit' })
  assert.equal(retried[5].branchState, runs[5].branchState)
  assert.equal(manualRetryRuns(runs, 2)[5].routeInputOverrides, undefined, 'regenerating the inputs invalidates their old explicit override')
})

test('manual route input edits cannot replace validation evidence but can still update ordinary variables', () => {
  const { runs } = fixture()
  runs.splice(3, 0, { ...run('quality', 'validation'), output: { passed: true },
    context: { quality: { passed: true }, observations: captured.freshObservations } })
  const target = runs.findIndex(item => item.node.id === 'retry')
  runs[target] = { ...runs[target], routeInputOverrides: {
    quality: { passed: false }, input: { note: 'manual correction' },
  } }
  assert.throws(() => prepareWorkflowRunContext(runs, target), /VALIDATION_RESULT_ROUTE_OVERRIDE_CONFLICT/)
  runs[target] = { ...runs[target], routeInputOverrides: { input: { note: 'manual correction' } } }
  const prepared = prepareWorkflowRunContext(runs, target)!
  assert.deepEqual((prepared.inputContext.input as Record<string, unknown>).note, 'manual correction')
  assert.deepEqual(prepared.inputContext.quality, { passed: true })
})
