import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateHistoricalStoryboard, repairStoryboardAnonymousActorGroups } from '../src/storyboard-runtime.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'

type Value = Record<string, unknown>
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/storyboard-group-grounding.json', import.meta.url), 'utf8'))
const groups = (candidate: Value) => ((candidate.pacing as Value).actorGroups as Value[])

test('record-pcd2gx retains the declared onlookers and all six approved performances without a writer retry', async () => {
  const { candidate, expected } = fixture(), before = structuredClone(candidate)
  let calls = 0
  const result = await generateHistoricalStoryboard({ prompt: '执行批准的场景', expected,
    initialCandidate: candidate, canGenerate: () => false, generate: async () => { calls++; throw new Error('unexpected provider call') } })
  assert.equal(calls, 0)
  assert.equal(result.duration, 14)
  assert.deepEqual(groups(result), candidate.pacing.actorGroups)
  const actualBeats = (result.pacing as Value).beats as Value[]
  assert.equal(actualBeats.length, 6)
  for (const key of ['actorIds', 'textOrVocalization', 'kind', 'dependsOn', 'overlapAllowedWith']) {
    assert.deepEqual(actualBeats.map(beat => beat[key]), candidate.pacing.beats.map((beat: Value) => beat[key]), `${key} stays authored`)
  }
  assert.deepEqual(result.characters, [])
  assert.equal(result.audioType, candidate.audioType)
  assert.equal(result.audioText, candidate.audioText)
  assert.deepEqual(candidate, before, 'saved provider evidence remains immutable')
})

function subjectFixture() {
  return { candidate: { characters: [], presentCharacters: [], pacing: {
    actorGroups: [{ id: 'onlookers', label: '围观百姓', memberDescription: '集市围观百姓' },
      { id: 'patient', label: '病患', memberDescription: '尝试治疗的病患' }],
    beats: [{ id: 'gather', sourceBeatId: 'beat-1', kind: 'action', actorIds: ['onlookers'], textOrVocalization: '围观人群增多' },
      { id: 'step', sourceBeatId: 'beat-1', kind: 'action', actorIds: ['patient'], textOrVocalization: '病患上前' }],
  } }, scene: { cast: [], requiredBeats: [{ id: 'beat-1', function: '吸引更多百姓', stateChange: '围观人群增加',
    observable: { visual: ['围观人群增多', '病患上前'] }, mustShow: ['围观人群增多', '病患上前'] }] } }
}

test('same-beat function or state change grounds identity while concrete visual action remains required', () => {
  for (const field of ['function', 'stateChange'] as const) {
    const { candidate, scene } = subjectFixture()
    scene.requiredBeats[0].function = '推进情节'
    scene.requiredBeats[0].stateChange = '围观人群增加'
    scene.requiredBeats[0][field] = '吸引更多百姓'
    const repaired = repairStoryboardAnonymousActorGroups(candidate, { scene })?.candidate ?? candidate
    assert.deepEqual(groups(repaired), candidate.pacing.actorGroups)
    assert.deepEqual((repaired.pacing as Value).beats, candidate.pacing.beats)
  }
  const { candidate, scene } = subjectFixture()
  candidate.pacing.beats[0].textOrVocalization = '凭空举起陌生旗帜'
  const repaired = repairStoryboardAnonymousActorGroups(candidate, { scene })!.candidate
  assert.deepEqual(groups(repaired).map(group => group.id), ['patient'], 'approved identity alone cannot authorize an unrelated invented performance')
  assert.deepEqual((repaired.pacing as Value).beats, candidate.pacing.beats, 'the unsupported action stays visible for strict rejection')
})

test('identity evidence from another source beat and invented group names cannot authorize the current performance', () => {
  const { candidate, scene } = subjectFixture()
  scene.requiredBeats[0].function = '推进情节'
  scene.requiredBeats.push({ id: 'beat-2', function: '吸引更多百姓', stateChange: '新场景', observable: { visual: ['另一动作'] }, mustShow: ['另一动作'] })
  assert.deepEqual(groups(repairStoryboardAnonymousActorGroups(candidate, { scene })!.candidate).map(group => group.id), ['patient'])
  const invented = subjectFixture()
  invented.candidate.pacing.actorGroups[0].label = '围观妖兵'
  assert.deepEqual(groups(repairStoryboardAnonymousActorGroups(invented.candidate, { scene: invented.scene })!.candidate).map(group => group.id), ['patient'])
  const namedObject = subjectFixture()
  namedObject.candidate.pacing.actorGroups[0].label = '围观张角'
  namedObject.scene.requiredBeats[0].function = '传播张角之道'
  assert.deepEqual(groups(repairStoryboardAnonymousActorGroups(namedObject.candidate, { scene: namedObject.scene })!.candidate).map(group => group.id), ['patient'],
    'function metadata may ground explicit anonymous roles, not a named person mentioned as an object')
  for (const label of ['张角围观百姓', '神仙围观百姓']) {
    const qualified = subjectFixture(); qualified.candidate.pacing.actorGroups[0].label = label
    assert.deepEqual(groups(repairStoryboardAnonymousActorGroups(qualified.candidate, { scene: qualified.scene })!.candidate).map(group => group.id), ['patient'], label)
  }
  const peripheral = subjectFixture(); peripheral.candidate.pacing.actorGroups[0].label = '外围围观百姓'
  const retained = repairStoryboardAnonymousActorGroups(peripheral.candidate, { scene: peripheral.scene })?.candidate ?? peripheral.candidate
  assert.deepEqual(groups(retained), peripheral.candidate.pacing.actorGroups, 'ordinary position qualifiers do not invent identity')
})

test('unknown lexical and nonlexical voices keep the explicit sound binding rejection', () => {
  for (const kind of ['speech', 'vocalization']) {
    const { candidate, expected } = fixture()
    candidate.pacing.actorGroups = candidate.pacing.actorGroups.filter((group: Value) => group.id !== 'onlooker-group')
    candidate.pacing.beats[5].kind = kind
    assert.throws(() => compileDurationSchedule(candidate, { scene: expected.scene }), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /unknown=\["onlooker-group"\]/)
      assert.match(error.message, /不能把群众声部藏在正文/)
      assert.doesNotMatch(error.message, /视觉动作必须绑定/)
      return true
    })
  }
})

test('contextual crowd identity never borrows another actor action or an object mention of the crowd', () => {
  for (const text of ['弟子取出符水', '病患上前', '弟子施符水', '弟子向围观人群示意']) {
    const { candidate, expected } = fixture()
    candidate.pacing.beats[5].textOrVocalization = text
    if (text === '弟子向围观人群示意') expected.scene.requiredBeats[0].observable.visual.push(text)
    const repaired = repairStoryboardAnonymousActorGroups(candidate, expected)?.candidate ?? candidate
    assert.ok(!groups(repaired).some(group => group.id === 'onlooker-group'), text)
    assert.equal(((repaired.pacing as Value).beats as Value[])[5].textOrVocalization, text, 'unsupported content is not silently rewritten')
  }
})

test('unknown group diagnostics name the missing id and the exact surviving declarations', () => {
  const { candidate, expected } = fixture()
  candidate.pacing.actorGroups = candidate.pacing.actorGroups.filter((group: Value) => group.id !== 'onlooker-group')
  assert.throws(() => compileDurationSchedule(candidate, { scene: expected.scene }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /field=pacing.beats\[5\].actorIds/)
    assert.match(error.message, /unknown=\["onlooker-group"\]/)
    assert.match(error.message, /declaredActorGroups=\[\{"id":"disciple-group","label":"传道弟子"\},\{"id":"sick-person-group","label":"病患"\}\]/)
    assert.match(error.message, /保留原动作和有词\/无词声部/)
    assert.match(error.message, /视觉动作必须绑定已声明人物或群体/)
    assert.doesNotMatch(error.message, /不能把群众声部藏在正文/)
    return true
  })
})
