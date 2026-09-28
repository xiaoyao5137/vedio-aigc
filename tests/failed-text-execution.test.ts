import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { executeFailedTextCandidate } from '../src/failed-text-execution.ts'
import { createFailedTextCandidateBinding, failedTextCandidateRequestPrefix, makeFailedTextCandidateEvidence, readFailedTextCandidate, withFailedTextCandidate, FailedTextCandidateError } from '../src/failed-text-candidate.ts'
import { createDramaGenerationBudget } from '../src/drama-generation-budget.ts'
import { buildSceneOutlineRepairSuffix, extractTextResponse, normalizeStructuredTextOutput, serializedValuesDiffer, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-outline-echo-candidates.json', import.meta.url), 'utf8'))
const valid = JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json', import.meta.url), 'utf8'))
const raw = (draft: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(draft) }] })
const normalizeCandidate = (value: unknown) => normalizeStructuredTextOutput(value, extractTextResponse(value), 'json')
const inputs = { maxGenerationAttempts: 2, qualityDisposition: 'manual-review-v1' }
const inputContext = { input: { episode_number: 41 } }
const prefixRun = { id: 'input-run', node: { id: 'input', resultVar: 'input', kind: 'input' }, revision: 0, status: 'success', output: inputContext.input, context: inputContext }
const bindingInput = { executionId: 'source', requestScopeId: 'source', generationScopeId: 'source', workflowId: 'workflow', nodeId: 'outline', runId: 'outline-run', operation: 'history.scene-outline', modelId: 'writer', attempt: 1, revision: 3,
  nodePrompt: 'cinematic-v1 完整剧情大纲原始目标', runtimeInputs: inputContext, successfulPrefix: [prefixRun], inputContext, inputs }
const sourceBinding = createFailedTextCandidateBinding(bindingInput)
const nextBinding = () => createFailedTextCandidateBinding({ ...bindingInput, executionId: 'retry', generationScopeId: 'retry', revision: 4 })
const validateReal = (value: unknown) => validateHistoricalStructuredOutput('history.scene-outline', normalizeCandidate(value), fixture.expected)
const realDiagnostic = (() => { try { validateReal(raw(fixture.candidates[1].candidate)) } catch (error) { return (error as Error).message }; throw Error('failure fixture must fail') })()
const evidence = (draft = fixture.candidates[1].candidate) => makeFailedTextCandidateEvidence({ raw: raw(draft), draft: normalizeCandidate(raw(draft)), message: realDiagnostic,
  binding: sourceBinding, requestKey: failedTextCandidateRequestPrefix(sourceBinding) + '2', modelExecutionId: 'paid-source-generation-2', httpStatus: 200 })
const baseOptions = () => ({ binding: nextBinding(), prompt: bindingInput.nodePrompt, maxGenerations: 2,
  normalizeCandidate, buildCorrection: buildSceneOutlineRepairSuffix, candidatesDiffer: serializedValuesDiffer })

test('a normal bound retry revalidates the paid raw before any model call and leaves downstream gates pending', async () => {
  const saved = evidence(valid), failed = { id: 'outline-run', node: { id: 'outline', kind: 'text', operation: 'history.scene-outline', resultVar: 'scene_outline' }, revision: 3, attempt: 1,
    status: 'failed', error: realDiagnostic, output: { error: realDiagnostic }, context: {}, inputContext, inputs, retryFeedback: withFailedTextCandidate('', saved) }
  const gate = { ...failed, id: 'review-run', node: { ...failed.node, id: 'review', resultVar: 'review' }, status: 'idle', retryFeedback: undefined }
  const accept = { ...gate, id: 'accept-run', node: { ...gate.node, id: 'accept', resultVar: 'approved_scene_outline' } }
  const original = [prefixRun, failed, gate, accept], before = structuredClone(original)
  const retried = manualRetryRuns(original, 1, undefined, sourceBinding)
  assert.equal(retried[0], prefixRun)
  assert.equal((retried[1] as typeof failed).revision, 4)
  const feedback = (prepareWorkflowRunContext(retried as never, 1)!.inputContext.retry as { feedback: unknown }).feedback
  assert.equal(Object.hasOwn(feedback as object, 'previousCandidate'), false)
  const budget = createDramaGenerationBudget(feedback, 2)
  const result = await executeFailedTextCandidate({ ...baseOptions(), carry: readFailedTextCandidate(feedback, nextBinding()), canGenerate: () => budget.canConsume(),
    generate: async () => { budget.consume(); throw Error('unexpected paid generation') },
    normalizeAndValidate: value => validateHistoricalStructuredOutput('history.scene-outline', normalizeCandidate(value), { requireDramaContract: true, requireBeatCoverage: true, requireNarrativeClosure: true }) })
  assert.equal(budget.used, 0)
  assert.equal(result.generations, 0)
  assert.equal(result.recovered?.source.modelExecutionId, 'paid-source-generation-2')
  assert.equal(result.recovered?.source.generation, 2)
  assert.deepEqual(result.raw, saved.raw)
  assert.ok(result.result && typeof result.result === 'object')
  assert.equal(retried[2].status, 'idle'); assert.equal(retried[3].status, 'idle')
  assert.equal(retried[2].retryFeedback, undefined)
  assert.deepEqual(original, before, 'the failed record and successful prefix remain unchanged')
  for (const changed of [{ ...failed, id: 'another-run' }, { ...failed, loopIndex: 1 }, { ...failed, node: { ...failed.node, id: 'another-node' } },
    { ...failed, node: { ...failed.node, mapInput: { sourcePath: 'scenes' } } }]) {
    assert.throws(() => manualRetryRuns([prefixRun, changed], 1, undefined, sourceBinding), /manual retry target/)
  }
})

test('an invalid carried draft spends two actual repairs with complete current diagnostics and retains the final rejected response', async () => {
  const saved = evidence(), feedback = withFailedTextCandidate('', saved), budget = createDramaGenerationBudget(feedback, 2)
  assert.equal(budget.used, 0, 'failed generation 2 is source evidence, not an approved previousCandidate budget')
  const requests: string[] = []
  const nextRaw = raw(fixture.candidates[0].candidate)
  let caught: unknown
  try {
    await executeFailedTextCandidate({ ...baseOptions(), carry: saved, canGenerate: () => budget.canConsume(), normalizeAndValidate: validateReal,
      generate: async prompt => { requests.push(prompt); budget.consume(); return { raw: nextRaw, requestKey: failedTextCandidateRequestPrefix(nextBinding()) + budget.used, httpStatus: 200 } } })
  } catch (error) { caught = error }
  assert.ok(caught instanceof FailedTextCandidateError)
  assert.equal(budget.used, 2); assert.equal(requests.length, 2)
  assert.ok(requests[0].includes(realDiagnostic), 'first new request is already a concrete repair of the carried candidate')
  for (const scene of saved.draft.scenes as Array<{ id: string }>) assert.ok(requests[0].includes(scene.id), 'the complete rejected draft survives correction')
  assert.equal(caught.evidence.source.requestKey, failedTextCandidateRequestPrefix(nextBinding()) + '2')
  assert.deepEqual(caught.evidence.raw, nextRaw)
  assert.equal(caught.evidence.message, caught.message)
  assert.doesNotMatch(caught.message, /DRAMA_GENERATION_LIMIT|quota/, 'the budget boundary preserves actual business diagnostics')
})

test('fresh and mapped outline paths keep two generations while mapped errors never claim whole-node evidence', async () => {
  for (const binding of [nextBinding(), undefined]) {
    const budget = createDramaGenerationBudget(undefined, 2), prompts: string[] = []
    await assert.rejects(executeFailedTextCandidate({ ...baseOptions(), binding, canGenerate: () => budget.canConsume(), normalizeAndValidate: validateReal,
      generate: async prompt => { prompts.push(prompt); budget.consume(); return { raw: raw(fixture.candidates[1].candidate),
        requestKey: binding ? failedTextCandidateRequestPrefix(binding) + budget.used : `mapped:item-0:generation-${budget.used}`, httpStatus: 200 } } }),
      error => { assert.equal(error instanceof FailedTextCandidateError, Boolean(binding)); assert.equal((error as Error).message, realDiagnostic); return true })
    assert.equal(prompts.length, 2); assert.equal(prompts[0], bindingInput.nodePrompt); assert.ok(prompts[1].includes(realDiagnostic))
  }
})

test('unsafe validation and mismatched or tampered carry stop before a paid request', async () => {
  for (const options of [
    { binding: createFailedTextCandidateBinding({ ...bindingInput, runtimeInputs: { input: { episode_number: 42 } } }), carry: evidence() },
    { binding: nextBinding(), carry: { ...evidence(), rawSha256: '0'.repeat(64) } },
  ]) await assert.rejects(executeFailedTextCandidate({ ...baseOptions(), ...options, canGenerate: () => true, normalizeAndValidate: validateReal,
    generate: async () => { throw Error('a request must never be submitted') } }), /FAILED_TEXT_CANDIDATE_INVALID/)
  await assert.rejects(executeFailedTextCandidate({ ...baseOptions(), carry: evidence(), canGenerate: () => true,
    normalizeAndValidate: () => { throw Error('HISTORY_REPAIR_SCOPE_REQUIRED: must escalate') }, generate: async () => { throw Error('a request must never be submitted') } }), /HISTORY_REPAIR_SCOPE_REQUIRED/)
})

test('ordinary retry rendering excludes supplier raw and draft while preserving review and targeted repair advice', () => {
  const saved = evidence(), feedback = withFailedTextCandidate({ issues: ['current validator issue'], repairContext: { targetedMediaRepair: { userReport: 'visible speech is unvoiced' } } }, saved)
  const before = structuredClone(feedback), prompt = renderRetryFeedbackPrompt(feedback)
  assert.match(prompt, /current validator issue/); assert.match(prompt, /visible speech is unvoiced/)
  assert.doesNotMatch(prompt, /failedCandidate|paid-source-generation-2|"scenes"|"content"|rawSha256|draftSha256/)
  assert.deepEqual(feedback, before)
  assert.equal(renderRetryFeedbackPrompt(withFailedTextCandidate('', saved)), '')
})
