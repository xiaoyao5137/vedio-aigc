import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { durationCanonicalJson, durationContentHash } from '../src/duration-policy.ts'
import { cleanStoryboardForValidation, generateHistoricalStoryboard, sceneFromStoryboardSegment } from '../src/storyboard-runtime.ts'
import { createStoryboardSplitPlan, readStoryboardSplitCandidate, storyboardSplitCandidateRef, isManagedStoryboardSplitNode } from '../src/storyboard-split-candidate.ts'
import { STRUCTURAL_JSON_HASH_ALGORITHM } from '../src/structural-json-hash.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-successful-split-plan.json', import.meta.url), 'utf8'))
const hash = durationContentHash
const model = { id: fixture.node.modelId, capability: 'text', provider: 'test-writer', settings: { privateCredential: 'do-not-save-model-config' } }
const prefix = [{ id: 'completed-input', status: 'success', node: fixture.node,
  context: { input: { episode_number: 41 } }, output: { episode_number: 41 } }]
const sourceRun = { id: fixture.source.runId, status: 'success', node: fixture.node, loopGroupId: fixture.source.loopGroupId,
  loopIndex: fixture.source.loopIndex, revision: fixture.source.revision, attempt: fixture.source.attempt,
  inputContext: { scene: fixture.expected.scene }, inputs: fixture.params,
  loopItem: sceneFromStoryboardSegment(fixture.expected.scene, fixture.validatedSegments[0], 0, 3),
  output: fixture.validatedSegments[0], context: { shot_script: fixture.validatedSegments[0] } }
const createOptions = () => ({ source: fixture.source, raw: fixture.raw, validatedSegments: fixture.validatedSegments,
  sourceRun, sourcePrefix: prefix, runtimeInputs: fixture.runtimeInputs, sourceParams: fixture.params, model,
  originalScene: fixture.expected.scene, timingPolicy: fixture.expected.timingPolicy, expected: fixture.expected })
async function readOptions(index = 1) {
  const plan = await createStoryboardSplitPlan(createOptions())
  return { reference: storyboardSplitCandidateRef(plan, index), currentPrefix: [...prefix, { ...sourceRun, storyboardSplitPlan: plan }],
    runtimeInputs: fixture.runtimeInputs, currentNode: fixture.node, currentRun: { id: 'future-split-run', loopGroupId: fixture.source.loopGroupId, loopIndex: fixture.source.loopIndex + index },
    model, params: { ...fixture.params, reviewImages: ['/generated/current-actual-tail.jpg'] },
    actualTailUrl: '/generated/current-actual-tail.jpg', scene: sceneFromStoryboardSegment(fixture.expected.scene, fixture.validatedSegments[index], index, 3),
    timingPolicy: fixture.expected.timingPolicy, executionIdentity: { executionId: 'record-normal-ui-fork', requestScopeId: fixture.source.requestScopeId, workflowId: fixture.source.workflowId } }
}

test('the real complete successful split preserves exact supplier provenance and each normalized planned body', async () => {
  const original = JSON.stringify(fixture)
  const options = await readOptions(), plan = options.currentPrefix.at(-1)!.storyboardSplitPlan!
  assert.deepEqual(plan.segments.map(segment => [segment.id, segment.duration]), [['scene-02-seg-1', 10], ['scene-02-seg-2', 12], ['scene-02-seg-3', 11]])
  assert.equal(plan.source.requestKey, 'record-ditpm6:attempt-1:revision-1:sanguo-shot-script:1:scene-02:generation-2')
  assert.equal(plan.source.modelExecutionId, 'model-run-muiozusz-n0g82fg')
  assert.equal(plan.binding.rawSha256, '89d362d162c0cc99036a92a897ab28cb9e3c3d8e3d6ef3918628e8344203a250')
  assert.equal(plan.binding.rawSha256, createHash('sha256').update(durationCanonicalJson(fixture.raw)).digest('hex'))
  assert.equal(JSON.stringify(plan).includes('do-not-save-model-config'), false)
  assert.equal(Object.hasOwn(plan, 'model'), false)
  const selected = readStoryboardSplitCandidate(options)!
  assert.deepEqual(selected.draft, cleanStoryboardForValidation(fixture.validatedSegments[1]))
  assert.deepEqual(selected.raw, fixture.raw)
  assert.equal(selected.provenance.currentValidationRequired, true)
  assert.equal(selected.provenance.mediaAcceptance, 'unverified')
  assert.equal(Object.hasOwn(selected.draft, 'scriptValidation'), false)
  assert.equal(Object.hasOwn(selected.draft, 'worldStateEvidence'), false)
  assert.equal(JSON.stringify(fixture), original)
  assert.equal(readStoryboardSplitCandidate({ ...options, reference: undefined }), undefined)
})

test('selected planned scripts still pass the complete current validator, without a writer call or media approval', async () => {
  for (const index of [1, 2]) {
    const options = await readOptions(index), selected = readStoryboardSplitCandidate(options)!
    let calls = 0
    const result = await generateHistoricalStoryboard({ prompt: fixture.node.prompt,
      expected: { ...fixture.expected, scene: options.scene, previousShot: fixture.validatedSegments[index - 1] },
      initialCandidate: selected.draft, initialRawResponse: selected.raw, canGenerate: () => false,
      generate: async () => { calls++; throw Error('provider forbidden') } })
    assert.equal(calls, 0)
    assert.equal((result.scriptValidation as Record<string, unknown>).generationAttempts, 0)
    assert.deepEqual(result.coveredBeatIds, fixture.validatedSegments[index].coveredBeatIds)
    assert.equal(result.duration, fixture.validatedSegments[index].duration)
    assert.equal(Object.hasOwn(result, 'mediaAcceptance'), false)
  }
  const options = await readOptions(), selected = readStoryboardSplitCandidate(options)!
  await assert.rejects(generateHistoricalStoryboard({ prompt: fixture.node.prompt,
    expected: { ...fixture.expected, scene: options.scene, previousShot: undefined },
    initialCandidate: selected.draft, canGenerate: () => false, generate: async () => { throw Error('provider forbidden') } }), /上一镜|前镜|previousShot|连续/)
})

test('only the actual approved source in an unchanged complete prefix can yield the corresponding segment', async () => {
  const options = await readOptions()
  const mutations: Array<(value: typeof options) => void> = [
    value => { value.currentPrefix[0].context = { input: { episode_number: 42 } } },
    value => { value.currentPrefix[1].status = 'failed' },
    value => { value.currentPrefix[1].output = { ...fixture.validatedSegments[0], duration: 15 } },
    value => { value.currentPrefix.reverse() },
    value => { value.currentPrefix.pop() },
    value => { value.currentPrefix.push(value.currentPrefix[1]) },
    value => { value.reference.segmentIndex = 0 },
    value => { value.reference.segmentIndex = 3 },
    value => { value.reference.sourceRunId = 'unknown-sibling' },
    value => { value.reference.planSha256 = '0'.repeat(64) },
    value => { value.currentRun.loopIndex++ },
    value => { value.currentRun.loopGroupId = 'other-loop' },
    value => { value.currentRun.id = fixture.source.runId },
    value => { value.executionIdentity.requestScopeId = 'record-crr7s5' },
    value => { value.executionIdentity.workflowId = 'another-workflow' },
    value => { value.runtimeInputs = { input: { episode_number: 42 } } },
    value => { value.currentNode.prompt += '\ncustom changed instruction' },
    value => { value.currentNode.mapInput = 'custom-mapped-executor' },
    value => { value.model.settings.privateCredential = 'different model configuration' },
    value => { value.params.unknownOption = true },
    value => { value.params.maxGenerationAttempts = 5 },
    value => { value.params.reviewImages = ['/generated/arbitrary.jpg'] },
    value => { value.params.reviewImages = [] },
    value => { value.actualTailUrl = '' },
    value => { value.scene.sequence++ },
    value => { value.scene.requiredBeats[0].description += '额外动作' },
    value => { value.timingPolicy.maximumProviderDuration = 16 },
  ]
  for (const mutate of mutations) { const changed = structuredClone(options); mutate(changed); assert.throws(() => readStoryboardSplitCandidate(changed), /STORYBOARD_SPLIT_CANDIDATE_INVALID/) }
})

test('raw, segments and metadata tampering fail, while the own plan field does not cause a hash cycle', async () => {
  const options = await readOptions()
  for (const change of [
    (plan: typeof options.currentPrefix[1]['storyboardSplitPlan']) => { plan!.raw = { content: [{ type: 'text', text: 'changed' }] } },
    (plan: typeof options.currentPrefix[1]['storyboardSplitPlan']) => { plan!.segments[1].audioText = 'changed words' },
    (plan: typeof options.currentPrefix[1]['storyboardSplitPlan']) => { plan!.source.requestKey += ':unknown' },
    (plan: typeof options.currentPrefix[1]['storyboardSplitPlan']) => { plan!.source.modelExecutionId = 'forged-ledger' },
    (plan: typeof options.currentPrefix[1]['storyboardSplitPlan']) => { plan!.binding.sourceIndex = 0 },
  ]) { const changed = structuredClone(options); change(changed.currentPrefix[1].storyboardSplitPlan); assert.throws(() => readStoryboardSplitCandidate(changed)) }
  const saved = options.currentPrefix[1].storyboardSplitPlan!
  const recreated = await createStoryboardSplitPlan({ ...createOptions(), sourceRun: options.currentPrefix[1] })
  assert.equal(recreated.planSha256, saved.planSha256)
  const nested = structuredClone(options); nested.currentPrefix[1].storyboardSplitPlan!.segments[1].duration = 15
  const plan = nested.currentPrefix[1].storyboardSplitPlan!, { planSha256: _hash, ...payload } = plan
  void _hash
  plan.planSha256 = hash(payload); nested.reference.planSha256 = plan.planSha256
  assert.throws(() => readStoryboardSplitCandidate(nested), /plan content or metadata hash changed|candidate or scoped scene differs/)
})

test('a successful HTTP response alone, a partial supplier body, changed authorship and custom contracts cannot create a plan', async () => {
  for (const change of [
    { source: { ...fixture.source, httpStatus: 502 } },
    { source: { ...fixture.source, requestKey: fixture.source.requestKey.replace('record-ditpm6:', 'record-crr7s5:') } },
    { source: { ...fixture.source, generationScopeId: 'unknown-scope' } },
    { source: { ...fixture.source, status: 'rejected' } },
    { raw: { segments: [fixture.validatedSegments[0]] } },
    { validatedSegments: fixture.validatedSegments.map((segment: Record<string, unknown>, index: number) => index === 1 ? { ...segment, audioText: 'changed original words' } : segment) },
    { sourceRun: { ...sourceRun, status: 'failed' } },
    { sourceRun: { ...sourceRun, node: { ...fixture.node, prompt: 'custom cinematic-v1 duration-v2 prompt' } } },
    { sourceParams: { ...fixture.params, pacingVersion: 'unknown-v3' } },
  ]) await assert.rejects(createStoryboardSplitPlan({ ...createOptions(), ...change }))
  assert.equal(isManagedStoryboardSplitNode(fixture.node, fixture.params), true)
  assert.equal(isManagedStoryboardSplitNode({ ...fixture.node, prompt: 'cinematic-v1 duration-v2' }, fixture.params), false)
})

test('shared execution snapshots hash all fields without expanding the complete prefix into a giant JSON string', async () => {
  let shared: Record<string, unknown> = { leaf: 'exact complete field' }
  for (let depth = 0; depth < 31; depth++) shared = { first: shared, second: shared }
  const deepPrefix = [{ ...prefix[0], context: shared }]
  const plan = await createStoryboardSplitPlan({ ...createOptions(), sourcePrefix: deepPrefix })
  assert.equal(plan.binding.prefixHashAlgorithm, STRUCTURAL_JSON_HASH_ALGORITHM)
  assert.equal(plan.binding.sourceRunHashAlgorithm, STRUCTURAL_JSON_HASH_ALGORITHM)
  const options = await readOptions()
  options.currentPrefix = [...deepPrefix, { ...sourceRun, storyboardSplitPlan: plan }]
  options.reference = storyboardSplitCandidateRef(plan, 1)
  assert.ok(readStoryboardSplitCandidate(options))
  options.currentPrefix[0] = { ...deepPrefix[0], context: { ...shared, additionalField: 'must remain bound' } }
  assert.throws(() => readStoryboardSplitCandidate(options), /complete successful prefix changed/)
})
