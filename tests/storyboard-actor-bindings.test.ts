import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { repairStoryboardAnonymousSpeakerBindings } from '../src/storyboard-actor-bindings.ts'
import { generateHistoricalStoryboard } from '../src/storyboard-runtime.ts'
import { normalizeRawStoryboardDurationCandidate } from '../src/storyboard-duration-normalization.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/anonymous-speaker-binding-storyboard.json', import.meta.url), 'utf8'))
const source = () => JSON.parse(readFileSync(new URL('./fixtures/anonymous-live-action-storyboard.json', import.meta.url), 'utf8'))

test('a real anonymous speaker owns their voice and standing action while the listening crowd stays separate', async () => {
  const candidate = fixture(), { scene, previousShot } = source()
  const before = structuredClone(candidate)
  let calls = 0
  const result = await generateHistoricalStoryboard({ prompt: '执行当前源剧情', expected: {
    scene, previousShot, pacingVersion: 'duration-v2', requireContinuityContract: true,
    requireDynamicPacing: true, requireNarrativeClosure: true, requireDramaContract: true,
  }, generate: async prompt => {
    calls++
    assert.match(prompt, /匿名发声者与听众必须分别声明 actorGroups/)
    assert.match(prompt, /原义务强制画内发声或可见口型时保留原要求/)
    return candidate
  } })
  assert.equal(calls, 1)
  assert.equal(result.audioType, before.audioType)
  assert.equal(result.audioText, before.audioText, 'screen position and spoken text are not rewritten')
  const pacing = result.pacing as typeof candidate.pacing
  assert.deepEqual(pacing.beats.map((beat: { actorIds: string[] }) => beat.actorIds), [['group-弟子'], ['group-弟子'], ['market-crowd']])
  assert.deepEqual(pacing.beats.map((beat: { textOrVocalization: string }) => beat.textOrVocalization),
    before.pacing.beats.map((beat: { textOrVocalization: string }) => beat.textOrVocalization))
  assert.deepEqual(pacing.beats.map((beat: { dependsOn: string[] }) => beat.dependsOn),
    before.pacing.beats.map((beat: { dependsOn: string[] }) => beat.dependsOn))
  assert.deepEqual(result.characters, [])
  assert.deepEqual(result.presentCharacters, [])
  assert.deepEqual(candidate, before)
})

test('anonymous speaker repair preserves explicit offscreen text and nonlexical crowd voice', () => {
  const candidate = fixture(), { scene } = source()
  candidate.audioText = candidate.audioText.replace('弟子：', '弟子（画外）：')
  const hum = { ...structuredClone(candidate.pacing.beats[2]), id: 'crowd-hum', kind: 'vocalization', textOrVocalization: '低声应和',
    vocalization: { vocalizationType: 'hum', actorGroup: 'market-crowd', expectedAudibility: '可听', melodyRelation: '无固定曲调', completionCue: '声部自然结束' } }
  candidate.pacing.beats.push(hum)
  const repaired = repairStoryboardAnonymousSpeakerBindings(candidate, { scene })!
  assert.ok(repaired)
  assert.equal(repaired.candidate.audioText, candidate.audioText)
  const pacing = repaired.candidate.pacing as typeof candidate.pacing
  assert.deepEqual(pacing.beats.at(-1), hum)
  assert.deepEqual(pacing.beats.map((beat: { kind: string }) => beat.kind), candidate.pacing.beats.map((beat: { kind: string }) => beat.kind))
  assert.equal(repairStoryboardAnonymousSpeakerBindings(repaired.candidate, { scene }), undefined, 'repair is idempotent')
})

test('unapproved, named, ambiguous or different spoken content is never silently rebound', () => {
  const { scene } = source()
  const changedText = fixture(); changedText.audioText = changedText.audioText.replace('我师', '此人')
  assert.equal(repairStoryboardAnonymousSpeakerBindings(changedText, { scene }), undefined)
  const duplicate = fixture(); duplicate.audioText += '\n' + duplicate.audioText
  assert.equal(repairStoryboardAnonymousSpeakerBindings(duplicate, { scene }), undefined)
  const named = fixture(); named.audioText = named.audioText.replace('弟子：', '张角：')
  assert.equal(repairStoryboardAnonymousSpeakerBindings(named, { scene: { ...scene, cast: ['张角'] } }), undefined)
  assert.equal(repairStoryboardAnonymousSpeakerBindings(fixture(), { scene: { ...scene, requiredBeats: [] } }), undefined)
  const objectOnly = { ...scene, requiredBeats: [{ id: 'beat-09', description: '百姓听到弟子的声音', observable: { visual: ['百姓围拢'] }, mustShow: ['百姓围拢'] }] }
  assert.equal(repairStoryboardAnonymousSpeakerBindings(fixture(), { scene: objectOnly }), undefined, 'a mentioned object does not authorize a new performing subject')
  const accepted = fixture(); accepted.pacing.scheduleHash = 'existing-schedule'
  assert.equal(repairStoryboardAnonymousSpeakerBindings(accepted, { scene }), undefined, 'compiled or accepted evidence is immutable')
})

test('unrepaired voice mismatch reports both transcript and bound performer instead of a generic retry', () => {
  const candidate = fixture(), { scene } = source()
  const normalized = normalizeRawStoryboardDurationCandidate(candidate, { scene })?.candidate ?? candidate
  assert.throws(() => compileDurationSchedule(normalized, { scene }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /expected\(audioText\)=\[\{"speaker":"弟子"/)
    assert.match(error.message, /actual\(pacing.speech\)=\[\{"speaker":"集市百姓"/)
    assert.match(error.message, /不能把发声者绑定到听众群体/)
    return true
  })
})
