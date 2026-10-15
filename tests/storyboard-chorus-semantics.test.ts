import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateHistoricalStoryboard, cleanStoryboardForValidation, storyboardContinuityContext } from '../src/storyboard-runtime.ts'
import { verifyDurationSchedule } from '../src/duration-schedule.ts'
import { validateHistoricalStructuredOutput, historicalStoryboardSegmentInputs } from '../src/workflow-core.ts'
import { resolveAnonymousGroupSpeaker, scriptedGroupPerformanceCovers, scriptedGroupAudioCovers, repairGroupSpeechPerformance } from '../src/storyboard-group-semantics.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Raw model fixtures deliberately carry heterogeneous nested contracts.
type Value = Record<string, any>
const fixture = (): { expected: Value; candidates: Value[] } => JSON.parse(readFileSync(new URL('./fixtures/storyboard-chorus-semantics.json', import.meta.url), 'utf8'))
const run = (candidate: Value, expected: Value) => generateHistoricalStoryboard({ prompt: '原场景', expected,
  initialCandidate: candidate, canGenerate: () => false, generate: async () => { throw Error('unexpected provider call') } })

test('all five real chorus candidates pass strict replay without another writer request or transcript change', async () => {
  const { expected, candidates } = fixture()
  for (const [index, candidate] of candidates.entries()) {
    const before = structuredClone(candidate), result = await run(candidate, expected)
    assert.equal(result.audioText, candidate.audioText)
    assert.equal(result.audioType, '对白')
    assert.deepEqual((result.pacing as Value).beats.map((beat: Value) => [beat.kind, beat.actorIds, beat.deliveryStyle]), candidate.pacing.beats.map((beat: Value) => [beat.kind, beat.actorIds, beat.deliveryStyle]))
    assert.deepEqual(candidate, before)
    assert.equal((result.scriptValidation as Value).attempts.length, 0)
    const replay = verifyDurationSchedule(result, { scene: expected.scene, timingPolicy: expected.timingPolicy })
    assert.equal(replay.scheduleHash, result.scheduleHash)
    if (index === 2) {
      assert.equal((result.pacing as Value).beats[1].textOrVocalization, candidate.audioText.split('\n')[1].split('：')[1])
      assert.ok(JSON.stringify((result.scriptValidation as Value).localRepairs).includes('source-backed-performance-header'))
    }
  }
})

test('anonymous speaker resolution is unique and bounded by quantity and role', () => {
  const groups = [{ id: 'crowd', label: '万余跪拜信众' }]
  assert.equal(resolveAnonymousGroupSpeaker('万余信众（画外）', groups), 'crowd')
  for (const wrong of ['千余信众', '万余士兵', '张角万余信众', '神仙万余信众', '命令万余信众', '万余妖兵']) assert.equal(resolveAnonymousGroupSpeaker(wrong, groups), undefined, wrong)
  assert.equal(resolveAnonymousGroupSpeaker('万余信众', [...groups, { id: 'other', label: '万余站立信众' }]), undefined)
})

test('collective performance cannot be claimed through wrong actors, negation, quoted speech or completion metadata', () => {
  const { candidates } = fixture(), shot = candidates[1], group = shot.pacing.actorGroups
  const beat = shot.pacing.beats[1]
  assert.equal(scriptedGroupPerformanceCovers('万人齐声应和', [beat], group), true)
  for (const performanceInstruction of ['万余信众没有齐声应和', '命令万余信众齐声应和', '回忆万余信众齐声应和', '“万余信众齐声应和”', '千余信众齐声应和', '万余士兵齐声应和', '张角万余信众齐声应和', '万余信众齐声高呼']) {
    assert.equal(scriptedGroupPerformanceCovers('万人齐声应和', [{ ...beat, performanceInstruction }], group), false, performanceInstruction)
  }
  for (const mutation of [{ actorIds: ['张角'] }, { deliveryStyle: 'narration' }, { kind: 'action' }, { kind: 'vocalization' }, { performanceInstruction: undefined }]) assert.equal(scriptedGroupPerformanceCovers('万人齐声应和', [{ ...beat, ...mutation }], group), false)
})

test('audio declaration prose stays distinct from exact lexical speech and same-source identity', () => {
  const { candidates } = fixture(), shot = candidates[4], declaration = shot.beatDramaturgy[0].audio[1]
  assert.equal(scriptedGroupAudioCovers(declaration, shot, 'beat-15'), true)
  for (const mutation of [(v: Value) => { v.pacing.beats[1].sourceBeatId = 'other' }, (v: Value) => { v.pacing.beats[1].actorIds = ['张角'] }, (v: Value) => { v.pacing.beats[1].textOrVocalization += '附加台词' }, (v: Value) => { v.audioText = v.audioText.replace('万余信众：', '张角：') }, (v: Value) => { v.pacing.beats[1].kind = 'vocalization' }]) {
    const changed = structuredClone(shot); mutation(changed)
    assert.equal(scriptedGroupAudioCovers(declaration, changed, 'beat-15'), false)
  }
})

test('performance header repair cannot trim arbitrary dialogue or change a compiled candidate', () => {
  const { expected, candidates } = fixture(), shot = candidates[2]
  assert.ok(repairGroupSpeechPerformance(shot, expected))
  for (const mutation of [(v: Value) => { v.pacing.beats[1].textOrVocalization += '额外原话' }, (v: Value) => { v.pacing.beats[1].actorIds = ['张角'] }, (v: Value) => { v.pacing.beats[1].textOrVocalization = v.pacing.beats[1].textOrVocalization.replace('万人齐声应和', '众人认为') }, (v: Value) => { v.scheduleHash = 'stored' }]) {
    const changed = structuredClone(shot); mutation(changed)
    assert.equal(repairGroupSpeechPerformance(changed, expected), undefined)
  }
})

test('manual review preserves runnable author content and source evidence as warnings without regeneration', async () => {
  const { expected, candidates } = fixture(), candidate = candidates[1]
  candidate.pacing.beats[1].performanceInstruction = '下方万余信众齐声高呼，声浪震撼'
  candidate.beatDramaturgy[0].function = '作者改写的功能'
  candidate.historicalBasis = '作者待确认的史实依据'
  const result = await run(candidate, { ...expected, qualityDisposition: 'manual-review-v1' })
  assert.equal(result.audioText, candidate.audioText)
  assert.equal((result.pacing as Value).beats[1].performanceInstruction, candidate.pacing.beats[1].performanceInstruction)
  assert.equal((result.beatDramaturgy as Value[])[0].function, candidate.beatDramaturgy[0].function)
  assert.ok((result.qualityWarnings as string[]).some(warning => warning.includes('原锚点')))
  assert.ok((result.qualityWarnings as string[]).some(warning => warning.includes('function')))
  assert.ok((result.qualityWarnings as string[]).some(warning => warning.includes('historicalBasis')))
  assert.equal((result.scriptValidation as Value).qualityStatus, 'needs_attention')
  assert.equal((result.scriptValidation as Value).scope, 'executable-structure')
  assert.equal((result.scriptValidation as Value).attempts.length, 0)
  verifyDurationSchedule(result, { scene: expected.scene, qualityDisposition: 'manual-review-v1' })
  assert.throws(() => verifyDurationSchedule(result, { scene: expected.scene }), /原锚点/)
  const revalidated = validateHistoricalStructuredOutput('history.storyboard', cleanStoryboardForValidation(result), { ...expected, qualityDisposition: 'manual-review-v1' }) as Value
  assert.deepEqual(revalidated.qualityWarnings, result.qualityWarnings)
})

test('manual review still rejects malformed execution, missing speech, unknown actor references and tampered schedules', async () => {
  const { expected, candidates } = fixture(), manual = { ...expected, qualityDisposition: 'manual-review-v1' }
  for (const mutation of [(v: Value) => { v.pacing.beats[1].actorIds = ['not-declared'] }, (v: Value) => { v.pacing.beats[1].textOrVocalization += '偷偷改词' }, (v: Value) => { v.pacing.beats[0].dependsOn = [v.pacing.beats[1].id] }, (v: Value) => { v.pacing.beats[1].kind = 'vocalization' }]) {
    const changed = structuredClone(candidates[1]); mutation(changed)
    await assert.rejects(() => run(changed, manual))
  }
  const result = await run(candidates[1], manual)
  const malformed = cleanStoryboardForValidation(result); delete malformed.worldState
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', malformed, manual), /WORLD_STATE_INVALID/)
  result.duration = 3
  assert.throws(() => verifyDurationSchedule(result, { scene: expected.scene, qualityDisposition: 'manual-review-v1' }))
})

test('manual continuity preflight blocks an unfinished unit before the next cut and still requires the actual tail', () => {
  const { expected } = fixture(), shot = structuredClone(expected.previousShot)
  shot.storyProgress = { ...shot.storyProgress, status: 'continuing', unitId: 'unfinished-prior-unit' }
  const video = { qualityPolicy: 'principle-v1', qualityDisposition: 'manual-review-v1',
    qualityReview: { status: 'needs_attention', canProceed: true, principleIssues: ['剧情需要用户确认'] },
    url: '/generated/actual-video.mp4', originalUrl: '/generated/provider-video.mp4', raw: { url: '/generated/provider-video.mp4' },
    decoded: true, evidenceUrl: '/generated/actual-evidence.json', duration: 12, width: 1280, height: 720,
    lastFrameUrl: '/generated/actual-tail.jpg', frames: ['/generated/actual-tail.jpg'] }
  const context = { qualityDisposition: 'manual-review-v1', scene: expected.scene,
    loop: { previous: { shot_script: shot, video_shot: video, last_frame: { available: true, url: video.lastFrameUrl } } } }
  assert.throws(() => storyboardContinuityContext(context), /NARRATIVE_INCOMPLETE/)
  assert.deepEqual(context.loop.previous.shot_script, shot)
  assert.throws(() => storyboardContinuityContext({ ...context, qualityDisposition: 'strict-v1' }), /NARRATIVE_INCOMPLETE/)
  shot.storyProgress.unitId = expected.scene.dramaticUnitId
  context.loop.previous.last_frame.url = '/generated/unrelated-planned-tail.jpg'
  assert.throws(() => storyboardContinuityContext(context), /CONTINUITY_EVIDENCE_MISSING/)
})

test('manual split allocation records repeated source performances as advice without deleting either authored segment', () => {
  const { expected, candidates } = fixture()
  const segments = [structuredClone(candidates[1]), structuredClone(candidates[1])]
  segments[0].id += '-part-1'; segments[1].id += '-part-2'
  const before = structuredClone(segments)
  assert.throws(() => historicalStoryboardSegmentInputs({ segments }, expected), /重复|恰好|跨段/)
  const allocated = historicalStoryboardSegmentInputs({ segments }, { ...expected, qualityDisposition: 'manual-review-v1' })
  assert.equal(allocated.length, 2)
  assert.ok(allocated.every(input => input.qualityWarnings.length > 0))
  assert.deepEqual(segments, before)
})
