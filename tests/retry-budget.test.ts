import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_NODE_ATTEMPTS, resolveRetryAttemptLimit, upgradeWorkflowRetryAttempts } from '../src/retry-budget.ts'
import { createDramaGenerationBudget } from '../src/drama-generation-budget.ts'
import { runPrincipleReview } from '../src/principle-review-runtime.ts'
import { acceptanceTransition, errorRetryTransition, type RetryRun } from '../src/node-retry.ts'
import { durationCompletionRecovery } from '../src/duration-workflow.ts'

test('configured retries stay finite while new structural repair defaults use two attempts', () => {
  assert.equal(MAX_NODE_ATTEMPTS, 5)
  for (const value of [undefined, null, '', 'bad', -1, 0, 1.5, NaN, Infinity, 5, '5', 6, 20, 99]) assert.equal(resolveRetryAttemptLimit(value), 5)
  assert.equal(resolveRetryAttemptLimit(4), 4)
  assert.equal(resolveRetryAttemptLimit(undefined, 4), 4)
  assert.equal(resolveRetryAttemptLimit(undefined, 7), 5)
  assert.equal(resolveRetryAttemptLimit(undefined, Infinity), 5)
  const budget = createDramaGenerationBudget(undefined)
  for (let attempt = 0; attempt < 2; attempt++) { assert.equal(budget.canConsume(), true); budget.consume() }
  assert.equal(budget.canConsume(), false)
  assert.throws(() => budget.consume(), /已达 2 次/)
  const resumed = createDramaGenerationBudget({ previousCandidate: { repairProvenance: { generationAttempts: 5 } } })
  assert.equal(resumed.canConsume(), false)
})

test('explicit retry upgrade covers arbitrary configured nodes without touching contracts or histories', () => {
  const param = (name: string, value: string) => ({ id: 'saved-' + name, name, englishName: name, type: 'number', required: true, value })
  const workflow = { id: 'not-a-business-specific-id', nodes: [
    { id: 'writer', params: [param('maxGenerationAttempts', '5'), param('maxReviewAttempts', '6'), param('maxAttempts', 'bad'),
      param('maxSamplingRounds', '2'), param('maxAdaptiveSamplingRounds', '2'), param('primaryTransportAttempts', '2'), param('pollIntervalMs', '100'), param('maxSamplingFrames', '24')],
      acceptance: { passedPath: 'passed', retryFrom: 'source', maxAttempts: 4, feedbackPath: 'issues' },
      errorRetry: { retryFrom: 'review', maxAttempts: 2, patterns: ['REVIEW_RESULT_INVALID:'] },
      prompt: 'immutable source prompt', code: 'return false;' },
    { id: 'unchanged', params: [param('duration', '15')], prompt: 'another prompt' },
  ], history: { nodeRuns: [{ node: { id: 'writer', params: [param('maxGenerationAttempts', '5')] }, status: 'failed', error: 'original error' }] } }
  const before = structuredClone(workflow), upgraded = upgradeWorkflowRetryAttempts(workflow)
  assert.deepEqual(workflow, before)
  assert.equal(upgraded.history, workflow.history)
  assert.equal(upgraded.nodes[1], workflow.nodes[1])
  for (const p of upgraded.nodes[0].params.slice(0, 6)) { assert.equal(p.value, '5'); assert.equal(p.id, 'saved-' + p.name) }
  assert.deepEqual(upgraded.nodes[0].params.slice(6), workflow.nodes[0].params.slice(6))
  assert.deepEqual(upgraded.nodes[0].acceptance, { ...workflow.nodes[0].acceptance, maxAttempts: 5 })
  assert.deepEqual(upgraded.nodes[0].errorRetry, { ...workflow.nodes[0].errorRetry, maxAttempts: 5 })
  assert.equal(upgradeWorkflowRetryAttempts(upgraded), upgraded)
})

test('principle reviewer honors explicit five attempts while default report recovery stops after one', async () => {
  const report = { version: 'principle-review-v1', decision: 'uncertain', issues: [] }
  let calls = 0
  const recovered = await runPrincipleReview({ maxAttempts: 20, generate: async (attempt, correction) => {
    calls++
    if (attempt > 1) assert.match(correction, /报告纠错/)
    return attempt < 5 ? 'bad JSON' : JSON.stringify(report)
  }, normalize: raw => JSON.parse(String(raw)) })
  assert.equal(calls, 5)
  assert.equal(recovered.reviewTransport.attempts.length, 5)
  assert.equal(recovered.reviewTransport.recovered, true)
  calls = 0
  const exhausted = await runPrincipleReview({ generate: async () => { calls++; throw Error('upstream unavailable') }, normalize: raw => raw })
  assert.equal(calls, 1)
  assert.equal(exhausted.reviewUnavailable, true)
  assert.equal(exhausted.reviewTransport.exhausted, true)
  assert.equal(exhausted.reviewTransport.attempts.length, 1)
  assert.equal(exhausted.reviewTransport.attempts[0].error, 'upstream unavailable')
})

test('acceptance and error recovery use all five attempts while preserving final errors', () => {
  const runs: RetryRun[] = ['generate', 'gate'].map(id => ({ node: { id, kind: 'code', resultVar: id }, status: 'success', durationMs: 1, context: {}, inputContext: { source: 'original' } }))
  runs[1].node.acceptance = { passedPath: 'passed', retryFrom: 'generate', maxAttempts: 5 }
  const penultimate = acceptanceTransition(runs.map(r => ({ ...r, attempt: 4 })), 1, { passed: false, issues: ['still invalid'] })!
  assert.equal(penultimate.exhausted, false)
  assert.equal(penultimate.runs[1].attempt, 5)
  const last = acceptanceTransition(penultimate.runs, 1, { passed: false, issues: ['still invalid'] })!
  assert.equal(last.exhausted, true)
  assert.match(last.reason, /5\/5/)
  const errors = runs.map(r => ({ ...r, node: { ...r.node, errorRetry: { retryFrom: 'generate', maxAttempts: 5, patterns: ['NETWORK:'] } }, errorAttempt: 4 }))
  const retry = errorRetryTransition(errors, 1, 'NETWORK: temporary')!
  assert.equal(retry.exhausted, false)
  assert.equal(retry.runs[1].errorAttempt, 5)
  assert.equal(errorRetryTransition(retry.runs, 1, 'NETWORK: unresolved')!.exhausted, true)
})

test('serialized same-media sampling recovery has a five-round default and retains its terminal evidence guard', () => {
  const completion = { evidenceRequests: [{ kind: 'native-sequence', startSecond: 0, endSecond: 1 }], remainingMandatoryBeats: ['b1'] }
  const context = { video_evidence: { url: '/same.mp4', duration: 5, frameTimes: [0, 5] }, video_take: { url: '/same.mp4' }, mediaSamplingRetry: { sourceUrl: '/same.mp4', round: 4 } }
  for (const recover of [durationCompletionRecovery, new Function('return (' + durationCompletionRecovery.toString() + ')')() as typeof durationCompletionRecovery]) {
    const twentieth = recover(context, completion, {})
    assert.equal((twentieth.samplingRetryPlan as { round: number }).round, 5)
    const exhausted = recover({ ...context, mediaSamplingRetry: { ...context.mediaSamplingRetry, round: 5 } }, completion, {})
    assert.match(exhausted.routeError, /DURATION_EVIDENCE_EXHAUSTED/)
    assert.match(recover({ ...context, video_evidence: { ...context.video_evidence, nativeSequence: {} } }, completion, {}).routeError, /DURATION_EVIDENCE_EXHAUSTED/)
  }
})
