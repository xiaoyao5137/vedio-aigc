import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { durationCanonicalJson } from '../src/duration-policy.ts'
import { validateHistoricalStructuredOutput, normalizeStructuredTextOutput, extractTextResponse } from '../src/workflow-core.ts'
import { createFailedTextCandidateBinding, failedTextCandidateRequestPrefix, makeFailedTextCandidateEvidence, readFailedTextCandidate,
  withFailedTextCandidate, withoutFailedTextCandidate, failedTextCandidateFromLedger, isFailedTextCandidateValidationMessage,
  failedTextCandidatePrefixHashAlgorithm, type FailedTextCandidateLedgerRecord } from '../src/failed-text-candidate.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-outline-echo-candidates.json', import.meta.url), 'utf8'))
const prefix = [{ id: 'input-run', node: { id: 'input' }, status: 'success', output: { episode_number: 41 }, context: { input: { episode_number: 41 } } }]
const inputs = { maxGenerationAttempts: 2, qualityDisposition: 'manual-review-v1' }
const bindingInput = { executionId: 'record-gox1q3', requestScopeId: 'record-57hbx6', generationScopeId: 'record-gox1q3', workflowId: 'wf-history',
  nodeId: 'outline', runId: 'outline-run', operation: 'history.scene-outline', modelId: 'writer', attempt: 1, revision: 3,
  nodePrompt: '原始剧情目标 ${input.episode_title}', runtimeInputs: { input: { episode_number: 41 } }, successfulPrefix: prefix,
  inputContext: { input: fixture.expected.input, historical_sources: fixture.expected.historicalSources, retry: { feedback: '' }, branch: {} }, inputs }
const binding = createFailedTextCandidateBinding(bindingInput)
const candidate = fixture.candidates[1].candidate
const raw = { content: [{ type: 'text', text: JSON.stringify(candidate) }] }
const draft = normalizeStructuredTextOutput(raw, extractTextResponse(raw), 'json')
const validationMessage = (() => { try { validateHistoricalStructuredOutput('history.scene-outline', draft, fixture.expected) } catch (error) { return (error as Error).message }; throw Error('real fixture unexpectedly passed') })()
const evidence = () => makeFailedTextCandidateEvidence({ raw, draft, message: validationMessage, binding,
  requestKey: failedTextCandidateRequestPrefix(binding) + '2', modelExecutionId: 'model-run-muin3pzt-ivaz100', httpStatus: 200 })
const next = () => createFailedTextCandidateBinding({ ...bindingInput, executionId: 'record-new', generationScopeId: 'record-new', revision: 4,
  inputContext: { ...bindingInput.inputContext, retry: { feedback: 'new execution evidence' }, branch: { visits: 1 } } })
const ledger = (generation = 2): FailedTextCandidateLedgerRecord => ({ id: `ledger-${generation}`, workflowId: binding.workflowId, nodeId: binding.nodeId,
  modelId: binding.modelId, capability: 'text', status: 'succeeded', httpStatus: 200,
  requestData: { operation: binding.operation, requestKey: failedTextCandidateRequestPrefix(binding) + generation, params: inputs }, responseData: raw })

test('actual failed outline draft/raw retain SHA-256 provenance and can cross only a bound normal retry', () => {
  const saved = evidence(), snapshot = JSON.stringify(saved)
  const feedback = withFailedTextCandidate({ issues: ['retain review report'] }, saved)
  assert.equal(readFailedTextCandidate(feedback, next()), saved)
  assert.equal(JSON.stringify(saved), snapshot)
  assert.equal(saved.rawSha256, createHash('sha256').update(durationCanonicalJson(raw)).digest('hex'))
  assert.equal(saved.draftSha256, createHash('sha256').update(durationCanonicalJson(saved.draft)).digest('hex'))
  assert.deepEqual(saved.raw, raw)
  assert.deepEqual(saved.draft.scenes, candidate.scenes)
  assert.equal(saved.source.generation, 2)
  assert.equal(saved.source.status, 'succeeded')
  assert.equal(saved.source.modelExecutionId, 'model-run-muin3pzt-ivaz100')
  assert.equal(saved.binding.nodePromptSha256, createHash('sha256').update(JSON.stringify(bindingInput.nodePrompt)).digest('hex'))
  assert.equal(Object.hasOwn(feedback, 'previousCandidate'), false)
  assert.deepEqual(withoutFailedTextCandidate(feedback), { issues: ['retain review report'] })
  assert.equal(withoutFailedTextCandidate(withFailedTextCandidate('', saved)), '')
})

test('every content and source constraint remains bound, including full successful prefix context', () => {
  const saved = evidence(), feedback = withFailedTextCandidate('', saved)
  for (const changed of [
    { ...bindingInput, requestScopeId: 'old-crr7s5-chain' }, { ...bindingInput, workflowId: 'another' }, { ...bindingInput, nodeId: 'another' },
    { ...bindingInput, runId: 'another-run' }, { ...bindingInput, modelId: 'another-model' }, { ...bindingInput, loopIndex: 1 },
    { ...bindingInput, loopGroupId: 'another-loop' }, { ...bindingInput, sceneId: 'another-scene' }, { ...bindingInput, nodePrompt: '改写目标' },
    { ...bindingInput, runtimeInputs: { input: { episode_number: 42 } } }, { ...bindingInput, inputs: { ...inputs, maxGenerationAttempts: 5 } },
    { ...bindingInput, successfulPrefix: [{ ...prefix[0], context: { input: { episode_number: 42 } } }] },
    { ...bindingInput, inputContext: { ...bindingInput.inputContext, historical_sources: [] } },
  ]) assert.throws(() => readFailedTextCandidate(feedback, createFailedTextCandidateBinding(changed)), /candidate is bound to different/)
  for (const change of [
    (value: ReturnType<typeof evidence>) => { value.raw = { text: 'different response' } },
    (value: ReturnType<typeof evidence>) => { value.draft.scenes = [] },
    (value: ReturnType<typeof evidence>) => { value.source.modelExecutionId = 'forged-ledger' },
    (value: ReturnType<typeof evidence>) => { value.source.requestKey = value.source.requestKey.replace('revision-3', 'revision-2') },
    (value: ReturnType<typeof evidence>) => { value.binding.executionId = 'forged-source' },
    (value: ReturnType<typeof evidence>) => { delete (value as Partial<typeof value>).provenanceSha256 },
  ]) {
    const altered = structuredClone(saved); change(altered)
    assert.throws(() => readFailedTextCandidate(withFailedTextCandidate('', altered), next()))
  }
  assert.throws(() => createFailedTextCandidateBinding({ ...bindingInput, successfulPrefix: [{ status: 'failed' }] }), /complete successful/)
  assert.throws(() => createFailedTextCandidateBinding({ ...bindingInput, modelId: '' }), /identity/)
})

test('legacy lookup selects the final exact successful request and rejects mismatched, ambiguous or non-2xx evidence', () => {
  const irrelevant = ledger(); irrelevant.requestData = { ...(irrelevant.requestData as object), requestKey: 'old-record:attempt-1:revision-3:outline:0::generation-2' }
  const saved = failedTextCandidateFromLedger([ledger(1), irrelevant, ledger(2)], binding, validationMessage)!
  assert.equal(saved.source.modelExecutionId, 'ledger-2')
  assert.equal(readFailedTextCandidate(withFailedTextCandidate('', saved), next()), saved)
  assert.equal(failedTextCandidateFromLedger([irrelevant], binding, validationMessage), undefined)
  for (const changed of [
    { ...ledger(), workflowId: 'another' }, { ...ledger(), nodeId: 'another' }, { ...ledger(), modelId: 'another' },
    { ...ledger(), capability: 'image' }, { ...ledger(), status: 'failed' }, { ...ledger(), httpStatus: 502 }, { ...ledger(), httpStatus: undefined },
    { ...ledger(), requestData: { ...(ledger().requestData as object), operation: 'history.storyboard' } },
    { ...ledger(), requestData: { ...(ledger().requestData as object), params: { ...inputs, maxGenerationAttempts: 5 } } },
    { ...ledger(), requestData: { ...(ledger().requestData as object), requestKey: failedTextCandidateRequestPrefix(binding) + '2:unrelated' } },
  ]) assert.throws(() => failedTextCandidateFromLedger([changed], binding, validationMessage))
  assert.throws(() => failedTextCandidateFromLedger([ledger(), ledger()], binding, validationMessage), /ambiguous/)
})

test('provider refusal, transport, scope escalation and unknown mixed diagnostics cannot become a reusable candidate', () => {
  assert.equal(isFailedTextCandidateValidationMessage(validationMessage), true)
  for (const message of ['HTTP 502: supplier task failed', 'MODEL_TRANSPORT_EXHAUSTED: failed', 'Failure to pass the risk control system',
    'Failed to fetch', 'HISTORY_REPAIR_SCOPE_REQUIRED: use episode', 'DRAMA_GENERATION_LIMIT: 2', 'unexpected implementation error',
    validationMessage + '\nHTTP 502: real provider failure', validationMessage + '\nunexpected implementation error']) {
    assert.equal(isFailedTextCandidateValidationMessage(message), false, message)
    assert.equal(failedTextCandidateFromLedger([ledger()], binding, message), undefined)
  }
  assert.throws(() => makeFailedTextCandidateEvidence({ raw, draft: { ...candidate, episodeTitle: 'invented title' }, message: validationMessage,
    binding, requestKey: failedTextCandidateRequestPrefix(binding) + '2', httpStatus: 200 }), /exact parsed supplier/)
  assert.throws(() => makeFailedTextCandidateEvidence({ raw, draft, message: validationMessage, binding,
    requestKey: failedTextCandidateRequestPrefix(binding) + '2', httpStatus: 403 }), /successful provider/)
})

test('legacy outline evidence keeps its canonical prefix hash contract across a new normal retry', () => {
  const legacyBinding = createFailedTextCandidateBinding({ ...bindingInput, successfulPrefixHashAlgorithm: 'canonical-json-sha256' })
  delete legacyBinding.successfulPrefixHashAlgorithm
  const saved = makeFailedTextCandidateEvidence({ raw, draft, message: validationMessage, binding: legacyBinding,
    requestKey: failedTextCandidateRequestPrefix(legacyBinding) + '2', httpStatus: 200 })
  const feedback = withFailedTextCandidate('', saved)
  assert.equal(failedTextCandidatePrefixHashAlgorithm(feedback), 'canonical-json-sha256')
  const current = createFailedTextCandidateBinding({ ...bindingInput, executionId: 'legacy-bound-fork', generationScopeId: 'legacy-bound-fork', revision: 4,
    successfulPrefixHashAlgorithm: failedTextCandidatePrefixHashAlgorithm(feedback) })
  assert.equal(readFailedTextCandidate(feedback, current), saved)
  assert.throws(() => readFailedTextCandidate(feedback, next()), /different successfulPrefixHashAlgorithm/)
  assert.equal(failedTextCandidatePrefixHashAlgorithm(undefined), 'merkle-json-sha256-v1')
  assert.throws(() => failedTextCandidatePrefixHashAlgorithm({ repairContext: { failedCandidate: { binding: { successfulPrefixHashAlgorithm: 'unknown' } } } }), /unknown successful prefix/)
})
