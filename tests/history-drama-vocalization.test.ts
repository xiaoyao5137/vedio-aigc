import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateDramaStoryboard } from '../src/history-drama.ts'

type Value = ReturnType<typeof JSON.parse>
const fixture = (): Value => JSON.parse(readFileSync(new URL('./fixtures/duration-v2-humming-storyboard.json', import.meta.url), 'utf8'))
const voice = (shot: Value): Value => shot.pacing.beats.find((beat: Value) => beat.kind === 'vocalization')

test('real writer-3 v2 candidate allocates source-described humming to a budgeted nonlexical voice without inventing dialogue', () => {
  const { shot, scene } = fixture(), original = structuredClone(shot)
  assert.deepEqual(scene.requiredBeats[1].observable.audio, [])
  assert.ok(scene.requiredBeats[1].description.includes('跟着哼唱'))
  assert.equal(shot.audioText.includes('跟着哼唱'), false)
  assert.doesNotThrow(() => validateDramaStoryboard(shot, scene))
  assert.deepEqual(shot, original, 'script validation must not rewrite audioText or claim observed-media acceptance')
  scene.requiredBeats[1].observable.audio = ['跟着哼唱']
  assert.doesNotThrow(() => validateDramaStoryboard(shot, scene), 'an explicit approved nonlexical audio anchor uses the same channel')
})

test('v1 behavior remains exact; duration-v2 never replaces complete source lyrics with a no-word voice', () => {
  const { shot, scene } = fixture()
  delete shot.pacing.version
  assert.throws(() => validateDramaStoryboard(shot, scene), /beat-02.audio/)
  const lexical = fixture()
  lexical.shot.audioText = ''
  const originalSong = lexical.scene.requiredBeats[0].observable.audio[0]
  voice(lexical.shot).sourceBeatId = 'beat-01'
  voice(lexical.shot).completion.evidenceAnchor = originalSong
  lexical.shot.pacing.beats = [voice(lexical.shot)]
  assert.throws(() => validateDramaStoryboard(lexical.shot, lexical.scene), /beat-01.audio/)
  const quoted = fixture()
  quoted.scene.requiredBeats[1].description = '乡人说出“跟着哼唱”这句话'
  assert.throws(() => validateDramaStoryboard(quoted.shot, quoted.scene), /beat-02.audio/)
})

test('duration-v2 recognizes an approved groan as a budgeted nonlexical voice', () => {
  const { shot, scene } = fixture()
  const beat = scene.requiredBeats[1]
  const performed = voice(shot)
  beat.description = '饥民群体中有人低声呻吟'
  beat.observable.visual.push('有人呻吟')
  beat.observable.audio = ['低声呻吟']
  shot.beatDramaturgy[1].visual.push('有人呻吟')
  shot.beatDramaturgy[1].audio = ['低声呻吟']
  shot.videoPrompt += '，数十名饥民中有的低声呻吟'
  performed.textOrVocalization = '低声呻吟'
  performed.performanceInstruction = '饥民群体中有人低声呻吟'
  performed.vocalization.vocalizationType = 'painful groan'
  performed.vocalization.expectedAudibility = 'background'
  performed.vocalization.melodyRelation = 'none'
  performed.vocalization.completionCue = '持续低沉呻吟声可听'
  performed.completion.evidenceAnchor = '低声呻吟'
  assert.doesNotThrow(() => validateDramaStoryboard(shot, scene))
  performed.vocalization.vocalizationType = 'sigh'
  assert.throws(() => validateDramaStoryboard(shot, scene), /beat-02.audio/)
})

test('humming coverage fails closed on wrong source, invented anchors, incomplete voice contracts, missing budget or visual-only completion', () => {
  for (const mutate of [
    (shot: Value) => { voice(shot).sourceBeatId = 'beat-01' },
    (shot: Value) => { voice(shot).completion.evidenceAnchor = '有人点头' },
    (shot: Value) => { voice(shot).completion.requiredThisClip = false },
    (shot: Value) => { voice(shot).completion.modality = 'visual' },
    (shot: Value) => { voice(shot).completion.finalState = '' },
    (shot: Value) => { delete voice(shot).durationEstimate },
    (shot: Value) => { voice(shot).durationEstimate.lower = 0 },
    (shot: Value) => { voice(shot).durationEstimate.expected = 0.1 },
    (shot: Value) => { voice(shot).durationEstimate.source = '' },
    (shot: Value) => { voice(shot).vocalization.expectedAudibility = 'inaudible' },
    (shot: Value) => { voice(shot).vocalization.completionCue = '' },
    (shot: Value) => { voice(shot).vocalization.melodyRelation = 'unrelated_tune' },
    (shot: Value) => { voice(shot).vocalization.vocalizationType = 'sigh' },
    (shot: Value) => { voice(shot).vocalization.actorGroup = 'different-group' },
    (shot: Value) => { shot.pacing.actorGroups = [] },
  ]) {
    const { shot, scene } = fixture(); mutate(shot)
    assert.throws(() => validateDramaStoryboard(shot, scene), /beat-02.audio/)
  }
  const unrelated = fixture()
  unrelated.scene.requiredBeats[1].description = '其他乡人只有点头回应'
  assert.throws(() => validateDramaStoryboard(unrelated.shot, unrelated.scene), /beat-02.audio/)
})
