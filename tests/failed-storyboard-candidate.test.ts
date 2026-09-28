import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { durationCanonicalJson } from '../src/duration-policy.ts'
import { createDramaGenerationBudget } from '../src/drama-generation-budget.ts'
import { createFailedTextCandidateBinding, failedTextCandidateFromLedger, failedTextCandidateRequestPrefix, failedTextCandidateWriterInputs,
  isFailedTextCandidateValidationMessage, isRecoverableFailedTextNode, makeFailedTextCandidateEvidence, parseFailedTextCandidateDraft,
  readFailedTextCandidate, withFailedTextCandidate, FailedTextCandidateError } from '../src/failed-text-candidate.ts'
import { executeRecoveredHistoricalStoryboard } from '../src/failed-text-execution.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-storyboard-retry-carry.json', import.meta.url), 'utf8'))
const source = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-storyboard-recovery-source.json', import.meta.url), 'utf8'))
const last = fixture.candidates[1]
const prefix = [{ id: 'paid-prefix', status: 'success', output: { url: '/generated/verified-preserved.mp4', passed: true }, context: { saved: 'all fields retained' } }]
const inputContext = { input: { episode_number: 41 }, scene: fixture.expected.scene,
  loop: { previous: { shot_script: fixture.expected.previousShot, video_shot: source.previousVideo, last_frame: source.previousTail } } }
const inputs = source.modelParams
const bindingInput = { executionId: source.recordId, requestScopeId: 'record-57hbx6', generationScopeId: source.recordId,
  workflowId: 'wf-sanguo-history-drama', nodeId: source.node.id, runId: source.run.id, operation: source.node.operation,
  modelId: source.node.modelId, attempt: source.run.attempt ?? 1, revision: source.run.revision,
  loopGroupId: source.run.loopGroupId, loopIndex: source.run.loopIndex, sceneId: fixture.expected.scene.id,
  nodePrompt: source.node.prompt, runtimeInputs: { input: { episode_number: 41 } }, successfulPrefix: prefix, inputContext, inputs }
const binding = createFailedTextCandidateBinding(bindingInput)
const next = () => createFailedTextCandidateBinding({ ...bindingInput, executionId: 'record-bound-next', generationScopeId: 'record-bound-next', revision: 2 })
const evidence = () => makeFailedTextCandidateEvidence({ raw: last.raw, draft: last.candidate, message: source.error,
  binding, requestKey: last.requestKey, modelExecutionId: source.ledgerId, httpStatus: source.httpStatus })
const ledger = (generation = 2) => ({ id: fixture.sourceLedgerIds[generation - 1], workflowId: binding.workflowId, nodeId: binding.nodeId,
  modelId: binding.modelId, capability: 'text', status: 'succeeded', httpStatus: 200,
  requestData: { operation: binding.operation, params: inputs, requestKey: fixture.candidates[generation - 1].requestKey },
  responseData: fixture.candidates[generation - 1].raw })

// A test author response only: the runtime never creates this split locally.
// Every original performed beat remains in its source group unchanged.
function authorCompleteSplit() {
  const original = parseFailedTextCandidateDraft(last.raw, 'history.storyboard') as typeof last.candidate
  const first = { ...structuredClone(original), id: original.id + '-seg-1', duration: 11,
    coveredBeatIds: ['beat-04'], beatDramaturgy: original.beatDramaturgy.filter((beat: { beatId: string }) => beat.beatId === 'beat-04'),
    pacing: { ...structuredClone(original.pacing), beats: original.pacing.beats.filter((beat: { sourceBeatId: string }) => beat.sourceBeatId === 'beat-04') },
    lastFramePrompt: '张角站在画面左侧，病患已站立面向张角行礼，围观百姓仍在背景站立观看。',
    storyProgress: { ...original.storyProgress, actionResult: '病患饮下符水后起身向张角行礼。', response: '病患说出“多谢大贤良师”。',
      pendingActions: ['围观人群向张角靠拢', '多人跪下请求'] } }
  const second = { ...structuredClone(original), id: original.id + '-seg-2', duration: 6,
    coveredBeatIds: ['beat-05'], beatDramaturgy: original.beatDramaturgy.filter((beat: { beatId: string }) => beat.beatId === 'beat-05'),
    audioType: '环境声', audioText: '', firstFrameMode: 'reuse_previous_tail', visualPrompt: first.lastFramePrompt,
    pacing: { ...structuredClone(original.pacing), beats: original.pacing.beats.filter((beat: { sourceBeatId: string }) => beat.sourceBeatId === 'beat-05')
      .map((beat: { dependsOn: string[] }) => ({ ...beat, dependsOn: beat.dependsOn.filter(id => id !== 'beat-04-04') })) },
    continuity: { ...original.continuity, previousShotId: first.id },
    storyProgress: { ...original.storyProgress, actionResult: '围观人群向张角靠拢，多人跪下请求。', response: '更多百姓相信张角，向他靠拢跪求。' } }
  return { segments: [first, second] }
}

test('the real last storyboard supplier response can cross only the bound normal retry with the complete paid prefix preserved', () => {
  assert.equal(isRecoverableFailedTextNode(source.node, source.inputs), true)
  assert.equal(isFailedTextCandidateValidationMessage(source.error, 'history.storyboard'), true)
  assert.equal(isFailedTextCandidateValidationMessage(source.error), false, 'outline does not adopt storyboard diagnostics')
  const saved = failedTextCandidateFromLedger([ledger(1), ledger(2)], binding, source.error)!
  assert.equal(saved.source.modelExecutionId, 'model-run-muiq3wvq-4i3dwka')
  assert.equal(saved.rawSha256, createHash('sha256').update(durationCanonicalJson(last.raw)).digest('hex'))
  assert.deepEqual(saved.draft, parseFailedTextCandidateDraft(last.raw, 'history.storyboard'))
  assert.equal(readFailedTextCandidate(withFailedTextCandidate('', saved), next()), saved)
  const failed = { id: source.run.id, node: source.node, status: 'failed', error: source.error, revision: source.run.revision,
    loopIndex: source.run.loopIndex, loopGroupId: source.run.loopGroupId, inputContext, inputs, context: {}, output: { error: source.error },
    retryFeedback: withFailedTextCandidate('', saved) }
  const pending = { ...failed, id: 'downstream-media', status: 'idle', node: { ...source.node, id: 'media', kind: 'video' }, retryFeedback: undefined }
  const original = [prefix[0], failed, pending], before = structuredClone(original)
  const retry = manualRetryRuns(original, 1, undefined, binding)
  assert.equal(retry[0], prefix[0])
  assert.equal(retry[1].status, 'idle')
  assert.equal(retry[1].revision, 2)
  assert.equal(retry[2].status, 'idle')
  assert.equal(retry[2].retryFeedback, undefined)
  assert.equal(Object.hasOwn(retry[1].retryFeedback as object, 'previousCandidate'), false)
  assert.deepEqual(original, before)
  for (const changed of [{ ...failed, id: 'wrong-run' }, { ...failed, loopIndex: 4 },
    { ...failed, node: { ...source.node, operation: 'history.scene-outline' } },
    { ...failed, node: { ...source.node, mapInput: { sourcePath: 'scenes' } } }]) {
    assert.throws(() => manualRetryRuns([prefix[0], changed], 1, undefined, binding), /manual retry target/)
  }
})

test('the recovered sixteen-second draft is free-preflighted and the first of two real requests already receives the complete split feedback', async () => {
  const carry = evidence(), budget = createDramaGenerationBudget(withFailedTextCandidate('', carry), 2)
  const prompts: string[] = []
  let final: unknown
  try {
    await executeRecoveredHistoricalStoryboard({ binding: next(), carry, prompt: source.node.prompt, expected: fixture.expected,
      canGenerate: () => budget.canConsume(), generate: async prompt => {
        prompts.push(prompt); budget.consume()
        return { raw: last.raw, requestKey: failedTextCandidateRequestPrefix(next()) + budget.used, httpStatus: 200 }
      } })
  } catch (error) { final = error }
  assert.ok(final instanceof FailedTextCandidateError)
  assert.equal(budget.used, 2)
  assert.equal(prompts.length, 2)
  assert.match(prompts[0], /STORYBOARD_TIMING_OVERFLOW/)
  assert.match(prompts[0], /【自动拆镜】/)
  assert.match(prompts[0], /"sourceBeatIds":\["beat-04"\].*"requiredDuration":11/)
  assert.match(prompts[0], /"sourceBeatIds":\["beat-05"\].*"requiredDuration":6/)
  for (const beat of last.candidate.pacing.beats) assert.ok(prompts[0].includes(beat.textOrVocalization), beat.id)
  assert.match(final.message, /3 次校验，2 次真实生成/)
  assert.equal(final.evidence.source.requestKey, failedTextCandidateRequestPrefix(next()) + '2')
  assert.deepEqual(final.evidence.raw, last.raw)
  assert.deepEqual(final.evidence.draft, parseFailedTextCandidateDraft(last.raw, 'history.storyboard'), 'compiled schedules/local duration normalization are not supplier authorship')
  assert.equal(final.evidence.binding.generationScopeId, 'record-bound-next')
  assert.equal(isFailedTextCandidateValidationMessage(final.message, 'history.storyboard'), true)
  assert.equal(renderRetryFeedbackPrompt(withFailedTextCandidate('', carry)), '')
})

test('the actual accepted tail attachment remains bound along with every source, model, input and full prefix field', () => {
  // This small already projected context mirrors the writer's additional
  // attachment; the separate live replay uses the complete real context.
  assert.deepEqual(failedTextCandidateWriterInputs('history.storyboard', source.inputs, inputContext), source.modelParams)
  assert.notEqual(createHash('sha256').update(durationCanonicalJson(source.inputs)).digest('hex'), binding.inputsSha256)
  const saved = evidence(), feedback = withFailedTextCandidate('', saved)
  for (const changed of [
    { ...bindingInput, inputs: { ...inputs, reviewImages: ['/generated/different-tail.jpg'] } },
    { ...bindingInput, successfulPrefix: [{ ...prefix[0], context: { saved: 'changed paid prefix' } }] },
    { ...bindingInput, loopIndex: 4 }, { ...bindingInput, sceneId: 'different-scene' },
    { ...bindingInput, runtimeInputs: { input: { episode_number: 42 } } }, { ...bindingInput, modelId: 'another-writer' },
    { ...bindingInput, nodePrompt: source.node.prompt + '\nchanged' }, { ...bindingInput, operation: 'history.scene-outline' },
  ]) assert.throws(() => readFailedTextCandidate(feedback, createFailedTextCandidateBinding(changed)), /candidate is bound to different/)
  assert.throws(() => failedTextCandidateFromLedger([{ ...ledger(), requestData: { ...ledger().requestData, params: source.inputs } }], binding, source.error), /not bound/)
  assert.throws(() => makeFailedTextCandidateEvidence({ raw: last.raw, draft: { ...last.candidate, duration: 15 }, message: source.error,
    binding, requestKey: last.requestKey, httpStatus: 200 }), /exact parsed supplier/)
})

test('unknown, mixed, malformed, upstream and provider diagnostics stay stopped even inside a storyboard attempts wrapper', async () => {
  const wrap = (errors: unknown[]) => '分镜修复未通过（1 次校验，0 次真实生成，已阻止媒体生成）：' + JSON.stringify([{ attempt: 1, mode: 'repair', source: 'recovered-candidate', errors }])
  for (const message of [
    wrap(['STORYBOARD_TIMING_OVERFLOW: 16 seconds', 'HTTP 502: provider failed']), wrap(['unexpected internal failure']),
    wrap(['MODEL_CONTENT_REJECTED: supplier refusal']), wrap(['STORYBOARD_TIMING_OVERFLOW: scope=upstream']),
    wrap(['STORYBOARD_CONTINUITY_EVIDENCE_MISSING: tail unavailable']), wrap([{}]), wrap([]),
    '分镜修复未通过（2 次，已阻止媒体生成）：[]', '分镜修复未通过（1 次，已阻止媒体生成）：bad JSON',
  ]) {
    assert.equal(isFailedTextCandidateValidationMessage(message, 'history.storyboard'), false, message)
    assert.equal(failedTextCandidateFromLedger([ledger()], binding, message), undefined)
  }
  for (const node of [{ ...source.node, mapInput: {} }, { ...source.node, prompt: 'legacy custom' },
    { ...source.node, operation: 'history.unrecognized' }]) assert.equal(isRecoverableFailedTextNode(node, source.inputs), false)
  assert.equal(isRecoverableFailedTextNode(source.node, { ...source.inputs, pacingVersion: 'dynamic-v1' }), false)
  let calls = 0
  await assert.rejects(executeRecoveredHistoricalStoryboard({ binding: next(), carry: evidence(), prompt: source.node.prompt, expected: fixture.expected,
    generate: async () => { calls += 1; throw Error('MODEL_CONTENT_REJECTED: supplier refusal') } }), error => {
    assert.equal(error instanceof FailedTextCandidateError, false)
    assert.match((error as Error).message, /MODEL_CONTENT_REJECTED/)
    return true
  })
  assert.equal(calls, 1)
  await assert.rejects(executeRecoveredHistoricalStoryboard({ binding: next(), carry: { ...evidence(), rawSha256: '0'.repeat(64) },
    prompt: source.node.prompt, expected: fixture.expected, generate: async () => { throw Error('must not generate') } }), /FAILED_TEXT_CANDIDATE_INVALID/)
})

test('complete current preflight can reuse a compliant carried split without buying a request while exposing only private source evidence', async () => {
  const authored = authorCompleteSplit(), raw = { content: [{ type: 'text', text: JSON.stringify(authored) }] }
  const saved = makeFailedTextCandidateEvidence({ raw, draft: authored, message: source.error, binding,
    requestKey: last.requestKey, httpStatus: 200 })
  const output = await executeRecoveredHistoricalStoryboard({ binding: next(), carry: saved, prompt: source.node.prompt, expected: fixture.expected,
    generate: async () => { throw Error('a compliant raw must be fully validated before any paid request') } })
  assert.equal(output.generations, 0)
  assert.equal(output.recovered, saved)
  assert.equal(output.source?.binding, saved.binding)
  assert.deepEqual(output.source?.raw, raw)
  assert.equal(output.source?.requestKey, last.requestKey)
  assert.equal(Object.hasOwn(output.result, 'failedCandidate'), false)
  assert.equal(Object.hasOwn(output.result, 'source'), false)
  assert.deepEqual((output.result.__storyboardSegments as Array<{ duration: number }>).map(segment => segment.duration), [11, 6])
})

test('a repaired success exposes the current complete supplier source separately from its approved business result', async () => {
  const authored = authorCompleteSplit(), raw = { content: [{ type: 'text', text: JSON.stringify(authored) }] }
  let calls = 0
  const output = await executeRecoveredHistoricalStoryboard({ binding: next(), carry: evidence(), prompt: source.node.prompt, expected: fixture.expected,
    generate: async () => { calls += 1; return { raw, requestKey: failedTextCandidateRequestPrefix(next()) + '1', httpStatus: 200 } } })
  assert.equal(calls, 1)
  assert.equal(output.generations, 1)
  assert.deepEqual(output.source?.raw, raw)
  assert.equal(output.source?.binding?.executionId, 'record-bound-next')
  assert.equal(output.source?.requestKey, failedTextCandidateRequestPrefix(next()) + '1')
  assert.equal(Object.hasOwn(output.result, 'source'), false)
})
