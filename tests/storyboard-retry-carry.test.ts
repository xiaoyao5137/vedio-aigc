import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateHistoricalStoryboard, storyboardDurationSourceSplitHint, storyboardCandidate, STORYBOARD_SEGMENTS_KEY } from '../src/storyboard-runtime.ts'
import { StoryboardCandidateValidationError } from '../src/storyboard-generation-error.ts'
import { compileDurationSchedule, planDurationSourceBeatSplit } from '../src/duration-schedule.ts'
import { chantScene, chantShot } from './fixtures/duration-v2-chant.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-storyboard-retry-carry.json', import.meta.url), 'utf8'))
const expected = fixture.expected
const last = fixture.candidates[1]
const fresh = () => structuredClone(last.candidate)
const response = (draft: unknown) => ({ role: 'assistant', content: [{ type: 'text', text: '```json\n' + JSON.stringify(draft) + '\n```' }] })

/** A test author response, never a runtime transform: every original pacing
 * beat stays in its source group, and only future-state metadata is scoped. */
function authorCompleteSplit() {
  const original = fresh()
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

test('the actual final draft remains rejected at sixteen seconds and its source plan retains every word and action', async () => {
  const original = fresh(), before = JSON.stringify(original)
  const plan = planDurationSourceBeatSplit(original, expected)!
  assert.equal(plan.minimumSegments, 2)
  assert.deepEqual(plan.groups.map(group => [group.sourceBeatIds, group.requiredDuration]), [[['beat-04'], 11], [['beat-05'], 6]])
  assert.equal(plan.groups[0].safeEndBudget, 10.069)
  assert.equal(plan.groups[1].safeEndBudget, 5.5)
  assert.deepEqual(plan.groups[1].completedDependencyBeatIds, ['beat-04-04'])
  assert.throws(() => compileDurationSchedule(original, expected), /需要 16 秒，超过 15 秒/)
  await assert.rejects(generateHistoricalStoryboard({ prompt: 'readonly', expected, initialCandidate: original,
    initialRawResponse: last.raw, canGenerate: () => false, generate: async () => { throw Error('No provider') } }), error => {
    assert.ok(error instanceof StoryboardCandidateValidationError)
    assert.equal(error.generationAttempts, 0)
    assert.deepEqual(error.lastCandidate, last.candidate)
    assert.deepEqual(error.lastRawResponse, last.raw)
    assert.deepEqual(error.diagnostics.length, 1)
    assert.match(error.diagnostics[0], /STORYBOARD_TIMING_OVERFLOW/)
    return true
  })
  assert.equal(JSON.stringify(original), before)
})

test('a real carried overflow reaches the first fresh request as a full split and preserves both fresh writer opportunities', async () => {
  let calls = 0
  const prompts: string[] = []
  const output = await generateHistoricalStoryboard({ prompt: 'current authority', expected, initialCandidate: fresh(), initialRawResponse: last.raw,
    canGenerate: () => calls < 2, generate: async prompt => {
      prompts.push(prompt); calls += 1
      return response(calls === 1 ? fresh() : authorCompleteSplit())
    } })
  assert.equal(calls, 2)
  assert.match(prompts[0], /STORYBOARD_TIMING_OVERFLOW/)
  assert.match(prompts[0], /【自动拆镜】/)
  assert.match(prompts[0], /【共享排程的完整原节拍拆分方案】/)
  assert.match(prompts[0], /"sourceBeatIds":\["beat-04"\].*"requiredDuration":11/)
  assert.match(prompts[0], /"sourceBeatIds":\["beat-05"\].*"requiredDuration":6/)
  assert.match(prompts[0], /未实拍的前段计划不能声称observed/)
  const segments = output[STORYBOARD_SEGMENTS_KEY] as Array<Record<string, unknown>>
  assert.equal(segments.length, 2)
  assert.deepEqual(segments.map(segment => segment.coveredBeatIds), [['beat-04'], ['beat-05']])
  assert.deepEqual(segments.map(segment => segment.duration), [11, 6])
  const pacingBeats = segments.flatMap(segment => (segment.pacing as { beats: Array<Record<string, unknown>> }).beats)
  assert.deepEqual(pacingBeats.map(beat => beat.textOrVocalization), fresh().pacing.beats.map((beat: { textOrVocalization: string }) => beat.textOrVocalization))
  assert.equal((output.scriptValidation as Record<string, unknown>).generationAttempts, 2)
})

test('a failed recovered repair checkpoints only its last exact real supplier draft, without counting preflight as a request', async () => {
  let calls = 0
  const supplierDraft = { ...fresh(), id: 'supplier-original-id' }
  const raw = response(supplierDraft)
  await assert.rejects(generateHistoricalStoryboard({ prompt: 'authority', expected, initialCandidate: fresh(), initialRawResponse: last.raw,
    canGenerate: () => calls < 2, generate: async () => { calls += 1; return raw } }), error => {
    assert.ok(error instanceof StoryboardCandidateValidationError)
    assert.equal(calls, 2)
    assert.equal(error.generationAttempts, 2)
    assert.equal(error.attempts.length, 3)
    assert.equal(error.attempts[0].source, 'recovered-candidate')
    assert.equal(error.lastCandidate.id, 'supplier-original-id', 'local canonical id normalization must not replace raw authorship')
    assert.deepEqual(error.lastCandidate, storyboardCandidate(raw))
    assert.deepEqual(error.lastRawResponse, raw)
    assert.match(error.message, /3 次校验，2 次真实生成/)
    return true
  })
})

test('a compliant recovered candidate still passes the entire current contract before any writer request', async () => {
  const draft = chantShot()
  let calls = 0
  const output = await generateHistoricalStoryboard({ prompt: 'authority', expected: { scene: chantScene, pacingVersion: 'duration-v2', maxGenerationAttempts: 2 },
    initialCandidate: draft, initialRawResponse: response(draft), generate: async () => { calls += 1; throw Error('must not generate') } })
  assert.equal(calls, 0)
  assert.equal((output.scriptValidation as Record<string, unknown>).generationAttempts, 0)
  assert.ok(output.scheduleHash)
})

test('transport refusal after a carried draft stays a hard interruption and never becomes candidate-validation evidence', async () => {
  let calls = 0
  await assert.rejects(generateHistoricalStoryboard({ prompt: 'authority', expected, initialCandidate: fresh(), initialRawResponse: last.raw,
    canGenerate: () => calls < 2, generate: async () => { calls += 1; throw Error('MODEL_CONTENT_REJECTED: supplier safety refusal') } }), error => {
    assert.equal(error instanceof StoryboardCandidateValidationError, false)
    assert.match((error as Error).message, /MODEL_CONTENT_REJECTED/)
    assert.equal(calls, 1)
    return true
  })
})

test('a saved plan cannot bypass changed current source obligations or the accepted previous-shot binding', async () => {
  const valid = authorCompleteSplit()
  for (const changed of ['source', 'previous-shot'] as const) {
    const current = structuredClone(expected)
    current.qualityDisposition = 'strict'
    if (changed === 'source') current.scene.requiredBeats[0].observable.audio.push('还须完整说出这句原义务')
    else current.previousShot.id = 'different-accepted-shot'
    let calls = 0
    await assert.rejects(generateHistoricalStoryboard({ prompt: 'current authority', expected: current,
      initialCandidate: valid, initialRawResponse: response(valid), canGenerate: () => false,
      generate: async () => { calls += 1; throw Error('must not generate') } }),
    changed === 'source' ? /HISTORY_DRAMA_INVALID:.*还须完整说出这句原义务/ : /STORYBOARD_CONTINUITY_INVALID/)
    assert.equal(calls, 0)
  }
})

test('the exact first author candidate receives actor and narrative diagnostics together, rather than a fabricated split plan', async () => {
  let calls = 0
  const first = fixture.candidates[0]
  await assert.rejects(generateHistoricalStoryboard({ prompt: 'authority', expected, initialCandidate: first.candidate,
    initialRawResponse: first.raw, canGenerate: () => calls < 1, generate: async prompt => {
      calls += 1
      assert.match(prompt, /使用未声明角色或群体/)
      assert.match(prompt, /STORYBOARD_NARRATIVE_INCOMPLETE/)
      assert.doesNotMatch(prompt, /【共享排程的完整原节拍拆分方案】/)
      return last.raw
    } }), /STORYBOARD_TIMING_OVERFLOW/)
  assert.equal(calls, 1)
  assert.ok(storyboardDurationSourceSplitHint(fresh(), expected))
})
