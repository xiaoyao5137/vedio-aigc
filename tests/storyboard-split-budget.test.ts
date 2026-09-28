import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planDurationSourceBeatSplit, compileDurationSchedule } from '../src/duration-schedule.ts'
import { DEFAULT_DURATION_POLICY } from '../src/duration-policy.ts'
import { normalizeRawStoryboardDurationCandidate } from '../src/storyboard-duration-normalization.ts'
import { generateHistoricalStoryboard, storyboardDurationSourceSplitHint } from '../src/storyboard-runtime.ts'
import { collectHistoricalStoryboardDiagnostics, historicalStoryboardSegmentInputs } from '../src/workflow-core.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-storyboard-split-budget.json', import.meta.url), 'utf8'))
const expected = fixture.expected
const first = fixture.candidates[0].candidate
const second = fixture.candidates[1].candidate
const normalized = (candidate = first, scene = expected.scene) => normalizeRawStoryboardDurationCandidate(candidate,
  { scene, timingPolicy: expected.timingPolicy, qualityDisposition: expected.qualityDisposition })?.candidate ?? structuredClone(candidate)

test('the real full draft needs three complete source groups using the acceptance clock, without altering the draft', () => {
  const before = structuredClone(first)
  const plan = planDurationSourceBeatSplit(first, expected)!
  assert.equal(plan.minimumSegments, 3)
  assert.deepEqual(plan.groups.map(group => group.sourceBeatIds), [['beat-02'], ['beat-03'], ['beat-04', 'beat-05']])
  assert.deepEqual(plan.groups.map(group => [group.safeEndBudget, group.requiredDuration]), [[9.064, 10], [9.049, 10], [11.7, 12]])
  assert.deepEqual(plan.groups.map(group => group.completedDependencyBeatIds), [[], ['beat-02-speech'], ['beat-03-hand-bowl']])
  assert.deepEqual(plan.groups.flatMap(group => group.beatIds), first.pacing.beats.map((beat: { id: string }) => beat.id))
  assert.deepEqual(first, before)
  assert.deepEqual(planDurationSourceBeatSplit(normalized(), expected), plan)
  assert.throws(() => compileDurationSchedule(normalized(), expected), /完整节拍与可读收尾需要 29 秒/)
})

test('both real candidates retain their actual failure; the original two-part allocation is still rejected at eighteen seconds', () => {
  assert.match(collectHistoricalStoryboardDiagnostics(normalized(), expected).join('\n'), /完整节拍与可读收尾需要 29 秒/)
  const inputs = historicalStoryboardSegmentInputs(second, expected)
  const head = normalized(inputs[0].segment, inputs[0].splitScene)
  const tail = normalized(inputs[1].segment, inputs[1].splitScene)
  assert.throws(() => compileDurationSchedule(head, { ...expected, scene: inputs[0].splitScene }), /完整节拍与可读收尾需要 18 秒/)
  const accepted = compileDurationSchedule(tail, { ...expected, scene: inputs[1].splitScene })
  assert.equal(accepted.timingEstimate.requiredDuration, 12)
  assert.match(collectHistoricalStoryboardDiagnostics({ segments: [head, tail] }, expected).join('\n'), /需要 18 秒/)
  const hint = storyboardDurationSourceSplitHint({ segments: [head, tail] }, expected)
  assert.match(hint, /"segmentIndex":0/)
  assert.match(hint, /"minimumSegments":2/)
  assert.match(hint, /"sourceBeatIds":\["beat-02"\]/)
})

test('the second paid-budget request receives the complete feasible partition and keeps every real action and word', async () => {
  const prompts: string[] = []
  await assert.rejects(generateHistoricalStoryboard({ prompt: '原分镜', expected,
    generate: async prompt => { prompts.push(prompt); return structuredClone(prompts.length === 1 ? first : second) } }), /需要 18 秒/)
  assert.equal(prompts.length, 2, 'the manual writer budget remains two; the rejected real second draft is never accepted')
  assert.doesNotMatch(prompts[0], /共享排程的完整原节拍拆分方案/)
  assert.match(prompts[1], /共享排程的完整原节拍拆分方案/)
  assert.match(prompts[1], /"minimumSegments":3/)
  for (const duration of [10, 12]) assert.match(prompts[1], new RegExp(`"requiredDuration":${duration}`))
  assert.match(prompts[1], /"completedDependencyBeatIds":\["beat-02-speech"\]/)
  assert.match(prompts[1], /未实拍的前段计划不能声称observed/)
  assert.match(prompts[1], /dependsOn只能引用本段实际存在的beat.id/)
  for (const beat of first.pacing.beats) assert.ok(prompts[1].includes(beat.textOrVocalization), beat.id)
})

test('a safe shared-clock source partition compiles without changing internal actions, words or dependencies', () => {
  const draft = normalized()
  const plan = planDurationSourceBeatSplit(draft, expected)!
  for (const group of plan.groups) {
    const selected = draft.pacing.beats.filter((beat: { sourceBeatId: string }) => group.sourceBeatIds.includes(beat.sourceBeatId))
    const ids = new Set(group.beatIds)
    const local = selected.map((beat: { dependsOn: string[]; overlapAllowedWith: string[] }) => ({ ...beat,
      dependsOn: beat.dependsOn.filter(id => ids.has(id)), overlapAllowedWith: beat.overlapAllowedWith.filter(id => ids.has(id)) }))
    const shot = { ...draft, duration: group.requiredDuration, coveredBeatIds: group.sourceBeatIds,
      audioText: local.filter((beat: { kind: string }) => beat.kind === 'speech')
        .map((beat: { actorIds: string[]; textOrVocalization: string }) => `${beat.actorIds[0] === 'sick-petitioner' ? '病患' : beat.actorIds[0]}:${beat.textOrVocalization}`).join('\n'),
      pacing: { ...draft.pacing, beats: local } }
    const scene = { ...expected.scene, requiredBeats: expected.scene.requiredBeats.filter((beat: { id: string }) => group.sourceBeatIds.includes(beat.id)) }
    const compiled = compileDurationSchedule(shot, { ...expected, scene })
    assert.equal(compiled.timingEstimate.requiredDuration, group.requiredDuration)
    assert.deepEqual(compiled.schedule.map(row => row.beatId), group.beatIds)
    assert.deepEqual(local.map((beat: { textOrVocalization: string }) => beat.textOrVocalization), selected.map((beat: { textOrVocalization: string }) => beat.textOrVocalization))
    for (const [index, beat] of local.entries()) assert.deepEqual(beat.dependsOn, selected[index].dependsOn.filter((id: string) => ids.has(id)))
  }
})

test('unsafe graph, source identity or absolute clocks produce no guessed split plan', () => {
  const changes = [
    (draft: typeof first) => { draft.pacing.beats[1].id = draft.pacing.beats[0].id },
    (draft: typeof first) => { draft.pacing.beats[0].dependsOn = ['does-not-exist'] },
    (draft: typeof first) => { draft.pacing.beats[0].dependsOn = [draft.pacing.beats[1].id] },
    (draft: typeof first) => { draft.pacing.beats[0].dependsOn = [draft.pacing.beats[2].id]; draft.pacing.beats[2].dependsOn = [] },
    (draft: typeof first) => { draft.pacing.beats[0].sourceBeatId = 'unknown-source' },
    (draft: typeof first) => { draft.pacing.beats = draft.pacing.beats.filter((beat: { sourceBeatId: string }) => beat.sourceBeatId !== 'beat-05') },
    (draft: typeof first) => { draft.pacing.beats[0].timingConstraint = { mode: 'hard', deadlineSecond: 20 } },
    (draft: typeof first) => { draft.pacing.beats[0].timingConstraint = { mode: 'reference', notBeforeSecond: 2 } },
    (draft: typeof first) => { draft.pacing.beats[0].durationEstimate = { ...draft.pacing.beats[0].durationEstimate, lower: .01, expected: .01, upper: .01 } },
    (draft: typeof first) => { draft.pacing.beats[0].resources = ['imaginary-parallel-channel'] },
    (draft: typeof first) => { draft.pacing.beats[0].resources = [] },
  ]
  for (const change of changes) { const draft = structuredClone(first); change(draft); assert.equal(planDurationSourceBeatSplit(draft, expected), undefined) }
})

test('mutual safe parallel actions use the same critical path instead of summing independent subjects', () => {
  const action = (id: string, sourceBeatId: string, actor: string, overlap: string[]) => ({ id, sourceBeatId, kind: 'action', actorIds: [actor],
    textOrVocalization: `${actor}举手`, dependsOn: [], overlapAllowedWith: overlap,
    durationEstimate: { lower: 8, expected: 8, upper: 8, source: '导演估计', confidence: 'low' },
    completion: { requiredThisClip: true, finalState: `${actor}已举手`, modality: 'visual', evidenceAnchor: `${actor}举手` } })
  const scene = { cast: ['甲', '乙'], requiredBeats: [{ id: 'source-a', mustShow: ['甲举手'] }, { id: 'source-b', mustShow: ['乙举手'] }] }
  const draft = { duration: 9, characters: scene.cast, audioType: '环境声', audioText: '', coveredBeatIds: ['source-a', 'source-b'],
    pacing: { version: 'duration-v2', timingPolicy: DEFAULT_DURATION_POLICY, beats: [action('a', 'source-a', '甲', ['b']), action('b', 'source-b', '乙', ['a'])] } }
  const plan = planDurationSourceBeatSplit(draft, { scene })!
  assert.equal(plan.minimumSegments, 1)
  assert.equal(plan.groups[0].safeEndBudget, 8.5)
  assert.equal(compileDurationSchedule(draft, { scene }).timingEstimate.requiredDuration, plan.groups[0].requiredDuration)
  draft.pacing.beats[1].overlapAllowedWith = []
  assert.equal(planDurationSourceBeatSplit(draft, { scene }), undefined, 'one-sided parallelism is never treated as a safe clock')
})

test('an oversized single source asks the author to partition its obligations without fabricating accepted groups', () => {
  const draft = normalized()
  const source = draft.pacing.beats[0].sourceBeatId
  draft.pacing.beats = draft.pacing.beats.filter((beat: { sourceBeatId: string }) => beat.sourceBeatId === source)
  draft.coveredBeatIds = [source]
  draft.audioText = `张角:${draft.pacing.beats.find((beat: { kind: string }) => beat.kind === 'speech').textOrVocalization}`
  draft.pacing.beats[0].durationEstimate = { ...draft.pacing.beats[0].durationEstimate, lower: 8, expected: 8, upper: 9 }
  const scene = { ...expected.scene, requiredBeats: expected.scene.requiredBeats.filter((beat: { id: string }) => beat.id === source) }
  const plan = planDurationSourceBeatSplit(draft, { ...expected, scene })!
  assert.equal(plan.minimumSegments, undefined)
  assert.deepEqual(plan.groups, [])
  assert.deepEqual(plan.oversizedSourceBeatIds, [source])
  assert.match(storyboardDurationSourceSplitHint(draft, { ...expected, scene }), /须由作者沿其原动作\/音频义务继续拆/)
  assert.throws(() => compileDurationSchedule(draft, { ...expected, scene }), /STORYBOARD_TIMING_OVERFLOW/)
})
