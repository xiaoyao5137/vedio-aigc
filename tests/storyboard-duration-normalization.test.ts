import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeRawStoryboardDurationCandidate } from '../src/storyboard-duration-normalization.ts'
import { compileDurationSchedule, verifyDurationSchedule } from '../src/duration-schedule.ts'
import { DEFAULT_DURATION_POLICY } from '../src/duration-policy.ts'
import { generateHistoricalStoryboard, repairStoryboardAnonymousActorGroups, repairStoryboardDramaturgyTypography, repairStoryboardOpeningWorldState, repairStoryboardReciprocalGroupOverlaps } from '../src/storyboard-runtime.ts'
import { chantScene, chantShot } from './fixtures/duration-v2-chant.ts'

type MutableStoryboardForTest = Record<string, unknown> & {
  characters: string[]
  presentCharacters: string[]
  pacing: { beats: Array<{ kind?: string; textOrVocalization?: string; completion: Record<string, unknown>; actorIds?: string[] }> }
}

test('accepted tail world state is copied exactly while new entrants stay unknown', () => {
  const observed = { name: '甲', position: { status: 'observed', value: '村口石旁', evidence: 'tail-2.jpg' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } }
  const candidate = { contentContractVersion: 'cinematic-v1', presentCharacters: ['甲', '乙'], enteringCharacters: [{ name: '乙' }], continuity: { mode: 'coverage_cut' },
    worldState: { settingId: 'wrong', characters: [{ ...observed, position: { status: 'unknown' } }, { name: '乙', position: { status: 'observed', value: '计划位置' } }] } }
  const result = repairStoryboardOpeningWorldState(candidate, { scene: { continuityFromPrevious: true }, previousShot: {
    id: 'previous', presentCharacters: ['甲'], worldState: { settingId: 'village', characters: [observed] },
    worldStateEvidence: { method: 'actual-tail-image', frame: 'tail-2.jpg' },
  } })!
  assert.deepEqual((result.candidate.worldState as typeof candidate.worldState), { settingId: 'village', characters: [observed, {
    name: '乙', position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' },
  }] })
  assert.deepEqual(candidate.worldState.characters[0].position, { status: 'unknown' }, 'candidate remains immutable')
  assert.equal(repairStoryboardOpeningWorldState(result.candidate, { scene: { continuityFromPrevious: true }, previousShot: {
    presentCharacters: ['甲'], worldState: { settingId: 'village', characters: [observed] }, worldStateEvidence: { method: 'actual-tail-image' },
  } }), undefined)
  assert.equal(repairStoryboardOpeningWorldState({ ...candidate, presentCharacters: ['乙'] }, { scene: { continuityFromPrevious: true }, previousShot: {
    presentCharacters: ['甲'], worldState: { settingId: 'village', characters: [observed] }, worldStateEvidence: { method: 'actual-tail-image' },
  } }), undefined, 'presence discrepancies stay visible to the validator')
})

test('approved anonymous beat actors stay groups instead of becoming continuity identities', () => {
  const candidate = { characters: ['张角', '病者', '围观饥民'], presentCharacters: ['张角', '病者', '围观饥民'],
    initialCharacters: ['张角', '病者', '围观饥民'], endCharacters: ['张角', '病者', '围观饥民'],
    worldState: { settingId: 'village', characters: [{ name: '张角' }, { name: '病者' }, { name: '围观饥民' }] },
    pacing: { actorGroups: [{ id: '围观饥民', label: '围观饥民', memberDescription: '围观者' }], beats: [
      { actorIds: ['病者'], textOrVocalization: '病者面色渐缓' }, { actorIds: ['围观饥民'], textOrVocalization: '围观饥民面露惊异' },
    ] } }
  const result = repairStoryboardAnonymousActorGroups(candidate, { scene: { cast: ['张角'], requiredBeats: [{ mustShow: ['病者面色渐缓', '围观饥民面露惊异'] }] } })!
  assert.deepEqual(result.candidate.characters, ['张角'])
  assert.deepEqual(result.candidate.presentCharacters, ['张角'])
  assert.deepEqual((result.candidate.worldState as typeof candidate.worldState).characters, [{ name: '张角' }])
  assert.deepEqual((result.candidate.pacing as typeof candidate.pacing).actorGroups.map(group => [group.id, group.label]), [['group-病者', '病者'], ['group-围观饥民', '围观饥民']])
  assert.deepEqual((result.candidate.pacing as typeof candidate.pacing).beats.map(beat => beat.actorIds), [['group-病者'], ['group-围观饥民']])
  assert.deepEqual(candidate.characters, ['张角', '病者', '围观饥民'])
})

test('reordered approved crowd label survives canonicalization beside another anonymous actor', () => {
  const candidate = { characters: ['张角'], presentCharacters: ['张角'], initialCharacters: ['张角'], endCharacters: ['张角'],
    pacing: { actorGroups: [
      { id: 'group-bystanders', label: '围观百姓', memberDescription: '十余名衣衫褴褛的饥民' },
      { id: 'group-patient', label: '病患', memberDescription: '躺卧的病患' },
    ], beats: [
      { id: 'crowd', sourceBeatId: 'beat-03', actorIds: ['group-bystanders'], kind: 'action', textOrVocalization: '周围十余名衣衫褴褛的百姓围观' },
      { id: 'patient', sourceBeatId: 'beat-03', actorIds: ['group-patient'], kind: 'action', textOrVocalization: '病患挣扎起身跪下' },
    ] } }
  const scene = { cast: ['张角'], requiredBeats: [{ id: 'beat-03',
    observable: { visual: ['周围十余名衣衫褴褛的百姓围观', '病患挣扎起身跪下'] },
    mustShow: ['周围十余名衣衫褴褛的百姓围观'] }] }
  const repaired = repairStoryboardAnonymousActorGroups(candidate, { scene })?.candidate ?? candidate
  assert.deepEqual((repaired.pacing as typeof candidate.pacing).actorGroups.map(group => group.id),
    ['group-bystanders', 'group-patient'])
  assert.deepEqual((repaired.pacing as typeof candidate.pacing).beats.map(beat => beat.actorIds),
    [['group-bystanders'], ['group-patient']])
  assert.deepEqual(candidate.pacing.actorGroups.map(group => group.id), ['group-bystanders', 'group-patient'])

  const invented = structuredClone(candidate)
  invented.pacing.actorGroups[0].label = '围观妖兵'
  const rejected = repairStoryboardAnonymousActorGroups(invented, { scene })!
  assert.deepEqual((rejected.candidate.pacing as typeof candidate.pacing).actorGroups.map(group => group.id), ['group-patient'])
})

test('one source beat can ground distinct patient and bystander groups without dropping either id', () => {
  const candidate = { characters: ['张角'], presentCharacters: ['张角'], initialCharacters: ['张角'], endCharacters: ['张角'],
    pacing: { actorGroups: [
      { id: 'sick-commoners', label: '病患百姓', memberDescription: '接受治疗后尝试起身的病患百姓' },
      { id: 'onlooking-commoners', label: '围观百姓', memberDescription: '在空地周围观看的百姓' },
    ], beats: [
      { id: 'recover', sourceBeatId: 'beat-07', actorIds: ['sick-commoners'], kind: 'action', textOrVocalization: '部分病患站起，身体直起，气色好转' },
      { id: 'react', sourceBeatId: 'beat-07', actorIds: ['onlooking-commoners'], kind: 'reaction', textOrVocalization: '周围人惊喜交谈，百姓互相转头对视' },
      { id: 'spread', sourceBeatId: 'beat-07', actorIds: ['onlooking-commoners'], kind: 'action', textOrVocalization: '有人向远处招手呼唤' },
    ] } }
  const scene = { cast: [], requiredBeats: [{ id: 'beat-07',
    description: '部分病患气色好转，能够自己站起；周围人惊喜交谈；有人转身向远处其他百姓招手呼唤',
    observable: { visual: ['部分病患站起', '周围人惊喜交谈', '有人向远处招手呼唤'], audio: [] },
    mustShow: ['部分病患站起', '百姓交谈', '向远处招手'] }] }
  const repaired = repairStoryboardAnonymousActorGroups(candidate, { scene })?.candidate ?? candidate
  assert.deepEqual((repaired.pacing as typeof candidate.pacing).actorGroups.map(group => group.id),
    ['sick-commoners', 'onlooking-commoners'])
  assert.deepEqual((repaired.pacing as typeof candidate.pacing).beats.map(beat => beat.actorIds),
    [['sick-commoners'], ['onlooking-commoners'], ['onlooking-commoners']])

  const invented = structuredClone(candidate)
  invented.pacing.actorGroups[1].label = '围观妖兵'
  const rejected = repairStoryboardAnonymousActorGroups(invented, { scene })!.candidate
  assert.deepEqual((rejected.pacing as typeof candidate.pacing).actorGroups.map(group => group.id), ['sick-commoners'])
})

test('anonymous-group cleanup preserves a named identity inherited from the accepted previous shot', () => {
  const candidate = { characters: ['张角'], presentCharacters: ['张角'], initialCharacters: ['张角'], endCharacters: ['张角'],
    worldState: { settingId: 'drama-03', characters: [{ name: '张角' }] },
    pacing: { actorGroups: [{ id: 'patients', label: '病患', memberDescription: '接受治疗的病患' }], beats: [
      { id: 'recover', sourceBeatId: 'beat-07', actorIds: ['patients'], kind: 'action', textOrVocalization: '部分病患站起' },
    ] } }
  const expected = { scene: { cast: [], continuityFromPrevious: true, requiredBeats: [{ id: 'beat-07',
    description: '部分病患站起，张角之道开始传播', observable: { visual: ['部分病患站起'], audio: [] }, mustShow: ['部分病患站起'] }] },
    previousShot: { presentCharacters: ['张角'] } }
  const repaired = repairStoryboardAnonymousActorGroups(candidate, expected)?.candidate ?? candidate
  assert.deepEqual(repaired.characters, ['张角'])
  assert.deepEqual(repaired.presentCharacters, ['张角'])
  assert.deepEqual((repaired.worldState as typeof candidate.worldState).characters, [{ name: '张角' }])
})

test('dramaturgy metadata restores authoritative punctuation without accepting rewritten meaning', () => {
  const expected = { scene: { requiredBeats: [{ id: 'beat-07', function: '呈现疗效与百姓自发传播',
    stateChange: '从病患接受治疗到部分治愈并开始自发传播,张角之道开始在百姓中扩散' }] } }
  const candidate = { beatDramaturgy: [{ beatId: 'beat-07', function: '呈现疗效与百姓自发传播',
    stateChange: '从病患接受治疗到部分治愈并开始自发传播，张角之道开始在百姓中扩散' }] }
  const repaired = repairStoryboardDramaturgyTypography(candidate, expected)!
  assert.equal((repaired.candidate.beatDramaturgy as typeof candidate.beatDramaturgy)[0].stateChange,
    expected.scene.requiredBeats[0].stateChange)
  assert.deepEqual(candidate.beatDramaturgy[0].stateChange,
    '从病患接受治疗到部分治愈并开始自发传播，张角之道开始在百姓中扩散')
  assert.equal(repairStoryboardDramaturgyTypography({ beatDramaturgy: [{ ...candidate.beatDramaturgy[0],
    stateChange: '从病患接受治疗到完全治愈' }] }, expected), undefined)
})

test('approved scene-11 crowd reaction is not deleted before duration validation', () => {
  const candidate = { characters: ['张角'], presentCharacters: ['张角'], initialCharacters: ['张角'], endCharacters: ['张角'],
    pacing: { actorGroups: [
      { id: 'group-围观百姓', label: '围观百姓', memberDescription: '已批准场景中的匿名参与者：村落空地周围围观的七八名百姓' },
      { id: 'group-病患', label: '病患', memberDescription: '已批准场景中的匿名参与者：接受符水治疗的病患' },
    ], beats: [
      { id: 'apply', sourceBeatId: 'beat-12', actorIds: ['张角'], kind: 'action', textOrVocalization: '村落空地上一名弟子为病患施符水' },
      { id: 'beat-12-crowd-watching', sourceBeatId: 'beat-12', actorIds: ['group-围观百姓'], kind: 'reaction', textOrVocalization: '周围百姓围观' },
      { id: 'patient', sourceBeatId: 'beat-12', actorIds: ['group-病患'], kind: 'reaction', textOrVocalization: '病患接受符水后身体微动' },
    ] } }
  const scene = { cast: ['张角'], requiredBeats: [{ id: 'beat-12', mustShow: ['村落空地上一名弟子为病患施符水', '周围百姓围观'],
    observable: { visual: ['村落空地上一名弟子为病患施符水', '周围百姓围观', '病患接受符水后身体微动'], audio: [] } }] }
  const repaired = repairStoryboardAnonymousActorGroups(candidate, { scene })?.candidate ?? candidate
  assert.deepEqual((repaired.pacing as typeof candidate.pacing).actorGroups.map(group => group.id), ['group-围观百姓', 'group-病患'])
  assert.deepEqual((repaired.pacing as typeof candidate.pacing).beats.map(beat => beat.actorIds),
    [['张角'], ['group-围观百姓'], ['group-病患']])
})

test('approved anonymous entrants remain executable groups without becoming continuity identities', () => {
  const candidate = { characters: ['张角', '家人', '围观百姓'], presentCharacters: ['张角', '家人', '围观百姓'],
    initialCharacters: ['张角'], enteringCharacters: [
      { name: '家人', startSecond: 0, endSecond: 2.5, path: '从画面右侧草棚附近快步走入镜头' },
      { name: '围观百姓', startSecond: 2, endSecond: 6, path: '从画面背景及两侧陆续走近，围拢到草棚前' },
    ], endCharacters: ['张角', '家人', '围观百姓'], worldState: { settingId: 'drama-02', characters: [
      { name: '张角' }, { name: '家人' }, { name: '围观百姓' },
    ] }, videoPrompt: '家人看到病患坐起，面露惊喜，从哭泣转为激动。随后家人跪拜在张角面前，周围陆续有百姓走近后围拢观看。',
    beatDramaturgy: [{ beatId: 'beat-04', visual: [
      '家人跪拜在张角面前', '看到病患坐起，面露惊喜，从哭泣转为激动', '周围陆续有百姓走近后围拢观看',
    ] }], pacing: { actorGroups: [
      { id: 'group-family', label: '家人', memberDescription: '病患的两名家属' },
      { id: 'group-crowd', label: '围观百姓', memberDescription: '周围陆续围拢的百姓' },
    ], beats: [
      { id: 'family', sourceBeatId: 'beat-04', kind: 'action', actorIds: ['group-family'], dependsOn: [], overlapAllowedWith: [], textOrVocalization: '两名家人从画面右侧草棚附近快步走入镜头，随后跪拜在张角面前' },
      { id: 'crowd', sourceBeatId: 'beat-04', kind: 'action', actorIds: ['group-crowd'], dependsOn: [], overlapAllowedWith: ['family'], textOrVocalization: '周围陆续有百姓从画面背景及两侧走近，围拢到草棚前观看' },
      { id: 'reaction', sourceBeatId: 'beat-04', kind: 'reaction', actorIds: ['group-family'], dependsOn: ['family'], overlapAllowedWith: [], textOrVocalization: '看到病患坐起，面露惊喜，从哭泣转为激动' },
    ] } }
  const scene = { cast: ['张角'], requiredBeats: [{ id: 'beat-04',
    observable: { visual: ['家人跪拜在张角面前', '周围百姓围拢观看'] },
    mustShow: ['家人跪拜', '百姓围拢'] }] }
  const repaired = repairStoryboardAnonymousActorGroups(candidate, { scene })!.candidate as typeof candidate
  assert.deepEqual(repaired.pacing.actorGroups.map(group => group.id), ['group-family', 'group-crowd'])
  assert.deepEqual(repaired.pacing.beats.map(beat => beat.actorIds), [['group-family'], ['group-crowd'], ['group-family']])
  assert.deepEqual(repaired.pacing.beats.map(beat => beat.overlapAllowedWith), [['crowd'], ['family'], []])
  assert.deepEqual(repaired.beatDramaturgy[0].visual, [
    '家人跪拜在张角面前', '周围陆续有百姓走近后围拢观看', '周围百姓围拢观看',
  ])
  assert.deepEqual(repaired.characters, ['张角'])
  assert.deepEqual(repaired.presentCharacters, ['张角'])
  assert.deepEqual(repaired.initialCharacters, ['张角'])
  assert.deepEqual(repaired.enteringCharacters, [])
  assert.deepEqual(repaired.endCharacters, ['张角'])
  assert.deepEqual(repaired.worldState.characters, [{ name: '张角' }])
  assert.equal(candidate.enteringCharacters.length, 2, 'candidate remains immutable')
})

test('a one-sided overlap between a named actor and approved group is completed locally', () => {
  const candidate = { pacing: { actorGroups: [{ id: 'family', label: '病患家属', memberDescription: '病患家属' }], beats: [
    { id: 'observe', kind: 'reaction', actorIds: ['张角'], dependsOn: ['recover'], overlapAllowedWith: [] },
    { id: 'kneel', kind: 'action', actorIds: ['family'], dependsOn: ['recover'], overlapAllowedWith: ['observe'] },
  ] } }
  const repaired = repairStoryboardReciprocalGroupOverlaps(candidate, { scene: { cast: ['张角'] } })!.candidate as typeof candidate
  assert.deepEqual(repaired.pacing.beats.map(beat => beat.overlapAllowedWith), [['kneel'], ['observe']])
  assert.deepEqual(candidate.pacing.beats[0].overlapAllowedWith, [], 'candidate remains immutable')
})

test('silent writer label is normalized to the canonical ambient track without inventing voice', () => {
  const candidate = { audioType: '无声', audioText: '', pacing: { version: 'duration-v2', beats: [
    { id: 'action', kind: 'action', actorIds: ['甲'], textOrVocalization: '甲抬手' },
  ] } }
  const result = normalizeRawStoryboardDurationCandidate(candidate)!
  assert.equal(result.candidate.audioType, '环境声')
  assert.deepEqual(result.changes.filter(change => change.path === 'audioType'), [
    { path: 'audioType', before: '无声', after: '环境声', source: 'audio-track-format' },
  ])
  assert.equal(candidate.audioType, '无声')
})

test('ambient sound aliases preserve content and cannot normalize over written or structured voice', () => {
  for (const audioType of ['环境音', '纯环境音']) {
    const candidate = { audioType, audioText: '', pacing: { version: 'duration-v2', beats: [
      { id: 'river', kind: 'action', actorIds: [], textOrVocalization: '河水流动', resources: ['body'], performanceInstruction: '河水流动' },
    ] } }
    const result = normalizeRawStoryboardDurationCandidate(candidate)!
    assert.equal(result.candidate.audioType, '环境声')
    assert.equal(result.candidate.audioText, '')
    assert.deepEqual((result.candidate.pacing as typeof candidate.pacing).beats, candidate.pacing.beats)
    assert.equal(candidate.audioType, audioType)
    assert.deepEqual(result.changes.filter(change => change.path === 'audioType'), [
      { path: 'audioType', before: audioType, after: '环境声', source: 'audio-track-format' },
    ])
    for (const voiced of [
      { ...candidate, audioText: '张飞：我来断后！' },
      { ...candidate, pacing: { ...candidate.pacing, beats: [{ ...candidate.pacing.beats[0], kind: 'speech' }] } },
      { ...candidate, pacing: { ...candidate.pacing, beats: [{ ...candidate.pacing.beats[0], kind: 'vocalization' }] } },
    ]) assert.equal(normalizeRawStoryboardDurationCandidate(voiced)?.candidate.audioType ?? voiced.audioType, audioType)
  }
})

test('canonical anonymous group ids are also excluded from continuity identity fields', () => {
  const candidate = { characters: ['张角', 'group-家属'], presentCharacters: ['张角', 'group-家属'],
    initialCharacters: ['张角', 'group-家属'], endCharacters: ['张角', 'group-家属'],
    worldState: { settingId: 'village', characters: [{ name: '张角' }, { name: 'group-家属' }] },
    pacing: { actorGroups: [{ id: 'group-家属', label: '家属' }], beats: [{ actorIds: ['group-家属'], textOrVocalization: '家属跪在一旁' }] } }
  const result = repairStoryboardAnonymousActorGroups(candidate, { scene: { cast: ['张角'], requiredBeats: [{ mustShow: ['家属跪在一旁'] }] } })!
  assert.deepEqual(result.candidate.characters, ['张角'])
  assert.deepEqual(result.candidate.presentCharacters, ['张角'])
  assert.deepEqual(result.candidate.initialCharacters, ['张角'])
  assert.deepEqual(result.candidate.endCharacters, ['张角'])
  assert.deepEqual((result.candidate.worldState as typeof candidate.worldState).characters, [{ name: '张角' }])
})

test('approved anonymous participants collapsed with a conjunction are removed from identity fields', () => {
  const candidate = { characters: ['张角', '病患与家属'], presentCharacters: ['张角', '病患与家属'],
    initialCharacters: ['病患与家属'], endCharacters: ['张角', '病患与家属'],
    worldState: { settingId: 'village', characters: [{ name: '张角' }, { name: '病患与家属' }] },
    pacing: { actorGroups: [], beats: [{ actorIds: ['张角'], textOrVocalization: '张角持木碗走近' }] } }
  const result = repairStoryboardAnonymousActorGroups(candidate, { scene: { cast: ['张角'], requiredBeats: [{
    observable: { visual: ['病患躺在茅席上', '家属跪在一旁'] }, mustShow: ['病患躺在茅席上'],
  }] } })!
  assert.deepEqual(result.candidate.characters, ['张角'])
  assert.deepEqual(result.candidate.presentCharacters, ['张角'])
  assert.deepEqual(result.candidate.initialCharacters, [])
  assert.deepEqual(result.candidate.endCharacters, ['张角'])
  assert.deepEqual((result.candidate.worldState as typeof candidate.worldState).characters, [{ name: '张角' }])
})

test('raw duration metadata uses the shared speech floor and approved duration range without rewriting content', () => {
  const candidate = { ...chantShot(), duration: 11, worldState: { settingId: 'street', characters: [{ name: '传唱歌谣的乡人',
    position: { status: 'unknown', value: '计划在街中', evidence: '尚未实拍' }, heldProps: { status: 'unknown', value: [] },
    pendingAction: { status: 'observed', value: '已放下手', evidence: '实际前镜尾帧' } }] } }
  candidate.pacing.beats[1].durationEstimate = { lower: 2, expected: 3, upper: 4, source: '原模型估计', confidence: 'low' }
  const before = structuredClone(candidate)
  const repaired = normalizeRawStoryboardDurationCandidate(candidate, { scene: chantScene })!
  assert.ok(repaired)
  assert.equal(repaired.candidate.duration, 10)
  const pacing = repaired.candidate.pacing as typeof candidate.pacing
  assert.deepEqual(pacing.beats[1].durationEstimate, { ...before.pacing.beats[1].durationEstimate, lower: 3.262, expected: 4.393, upper: 5.4 })
  for (const key of ['audioText', 'audioType', 'characters', 'presentCharacters', 'coveredBeatIds', 'visualPrompt', 'lastFramePrompt', 'videoPrompt']) {
    assert.deepEqual(repaired.candidate[key], before[key as keyof typeof before])
  }
  for (const [index, beat] of pacing.beats.entries()) {
    for (const key of ['sourceBeatId', 'actorIds', 'textOrVocalization', 'deliveryStyle', 'dependsOn', 'overlapAllowedWith', 'completion'] as const) {
      assert.deepEqual(beat[key], before.pacing.beats[index][key])
    }
  }
  const world = repaired.candidate.worldState as typeof candidate.worldState
  assert.deepEqual(world.characters[0].position, { status: 'unknown', evidence: '尚未实拍' })
  assert.deepEqual(world.characters[0].heldProps, { status: 'unknown' })
  assert.deepEqual(world.characters[0].pendingAction, before.worldState.characters[0].pendingAction)
  assert.ok(repaired.changes.some(change => change.path === 'duration' && change.before === 11 && change.after === 10))
  assert.deepEqual(candidate, before)
  assert.equal(normalizeRawStoryboardDurationCandidate(repaired.candidate, { scene: chantScene }), undefined)
})

test('metadata normalization cannot bypass source allocation, real timing overflow or unilateral parallelism', () => {
  const unknown = chantShot(); unknown.duration = 15; unknown.pacing.beats[0].sourceBeatId = 'invented'
  const normalizedUnknown = normalizeRawStoryboardDurationCandidate(unknown, { scene: chantScene })?.candidate ?? unknown
  assert.equal(normalizedUnknown.duration, 15)
  assert.throws(() => compileDurationSchedule(normalizedUnknown, { scene: chantScene }), /STORYBOARD_COVERAGE_INCOMPLETE:/)
  const long = chantShot(); long.pacing.beats[1].durationEstimate.upper = 14
  const normalizedLong = normalizeRawStoryboardDurationCandidate(long, { scene: chantScene })?.candidate ?? long
  assert.equal((normalizedLong.pacing as typeof long.pacing).beats[1].durationEstimate.upper, 14)
  assert.throws(() => compileDurationSchedule(normalizedLong, { scene: chantScene }), /STORYBOARD_TIMING_OVERFLOW:/)
  const unilateral = chantShot(); unilateral.pacing.beats[1].dependsOn = []; unilateral.pacing.beats[0].overlapAllowedWith = ['lead-song']
  const normalizedUnilateral = normalizeRawStoryboardDurationCandidate(unilateral, { scene: chantScene })?.candidate ?? unilateral
  assert.deepEqual((normalizedUnilateral.pacing as typeof unilateral.pacing).beats[1].overlapAllowedWith, [])
  assert.throws(() => compileDurationSchedule(normalizedUnilateral, { scene: chantScene }), /并行须双方显式允许/)
})

test('compiled evidence and unsupported data are never normalized as a fresh draft', () => {
  const original = chantShot(), compiled = { ...original, ...compileDurationSchedule(original, { scene: chantScene }) }
  const before = structuredClone(compiled)
  assert.equal(normalizeRawStoryboardDurationCandidate(compiled, { scene: chantScene }), undefined)
  assert.doesNotThrow(() => verifyDurationSchedule(compiled))
  assert.deepEqual(compiled, before)
  const tampered = { ...compiled, duration: 15 }
  assert.equal(normalizeRawStoryboardDurationCandidate(tampered, { scene: chantScene }), undefined)
  assert.throws(() => verifyDurationSchedule(tampered), /可批准/)
  for (const value of [null, [], {}, { pacing: { version: 'dynamic-v1' } }]) assert.equal(normalizeRawStoryboardDurationCandidate(value), undefined)
  const unscoped = chantShot(); unscoped.duration = 15
  assert.equal(normalizeRawStoryboardDurationCandidate(unscoped), undefined, 'without an approved scope, a raw duration cannot be shortened')
})

test('actorless sand-table action omission is filled locally but character shots stay strict', () => {
  const candidate = chantShot() as unknown as MutableStoryboardForTest
  candidate.characters = []
  candidate.presentCharacters = []
  candidate.pacing.beats = [structuredClone(candidate.pacing.beats[0])]
  candidate.pacing.beats[0].kind = 'action'
  candidate.pacing.beats[0].textOrVocalization = '冀州区域在历史地图沙盘上高亮'
  candidate.pacing.beats[0].completion.modality = 'visual'
  delete candidate.pacing.beats[0].actorIds
  const scene = { editorialRole: 'episode_opening', visualTreatment: 'animated', animationStyle: 'historical_map', cast: [] }
  const normalized = normalizeRawStoryboardDurationCandidate(candidate, { scene })!
  assert.deepEqual((normalized.candidate.pacing as MutableStoryboardForTest['pacing']).beats[0].actorIds, [])
  assert.ok(normalized.changes.some(change => change.path === 'pacing.beats[0].actorIds'
    && change.source === 'actorless-editorial-format'))
  assert.equal(candidate.pacing.beats[0].actorIds, undefined)
  assert.equal(normalizeRawStoryboardDurationCandidate(candidate, {
    scene: { editorialRole: 'story', visualTreatment: 'live_action', cast: ['张角'] },
  }), undefined)
})

test('a named static illustration layer binds its explicit character while background beats remain actorless', () => {
  const candidate = chantShot() as unknown as MutableStoryboardForTest
  candidate.characters = ['张角']
  candidate.presentCharacters = ['张角']
  candidate.pacing.beats = [structuredClone(candidate.pacing.beats[0]), structuredClone(candidate.pacing.beats[0])]
  candidate.pacing.beats[0].kind = 'action'
  candidate.pacing.beats[0].actorIds = []
  candidate.pacing.beats[0].textOrVocalization = '饥荒场景插画淡入'
  candidate.pacing.beats[0].completion.evidenceAnchor = '饥荒场景插画淡入'
  candidate.pacing.beats[1].kind = 'action'
  candidate.pacing.beats[1].actorIds = []
  candidate.pacing.beats[1].textOrVocalization = '张角人物插画淡入居中'
  candidate.pacing.beats[1].completion.evidenceAnchor = '张角人物插画淡入居中'
  const scene = { editorialRole: 'episode_opening', visualTreatment: 'animated', animationStyle: 'character_illustration', cast: ['张角'] }
  const normalized = normalizeRawStoryboardDurationCandidate(candidate, { scene })!
  const beats = (normalized.candidate.pacing as MutableStoryboardForTest['pacing']).beats
  assert.deepEqual(beats[0].actorIds, [])
  assert.deepEqual(beats[1].actorIds, ['张角'])
  assert.ok(normalized.changes.some(change => change.path === 'pacing.beats[1].actorIds'
    && change.source === 'static-illustration-actor-binding'))
})

test('the actual writer runtime accepts deterministic metadata repairs before spending a model retry', async () => {
  const candidate = chantShot(); candidate.duration = 11; candidate.pacing.beats[1].durationEstimate.upper = 4.4
  const before = structuredClone(candidate)
  let requests = 0
  const result = await generateHistoricalStoryboard({ prompt: '保留原歌谣及群体回应', initialCandidate: candidate,
    expected: { scene: chantScene, pacingVersion: 'duration-v2', requireDynamicPacing: true },
    generate: async () => { requests += 1; throw new Error('不应为纯派生元数据购买修复') } })
  assert.equal(requests, 0)
  assert.equal(result.duration, 10)
  const audit = result.scriptValidation as { passed: boolean; localRepair: boolean; localRepairs: Array<{ source: string }> }
  assert.equal(audit.passed, true)
  assert.equal(audit.localRepair, true)
  assert.ok(audit.localRepairs.some(change => change.source === 'shared-speech-policy'))
  assert.ok(audit.localRepairs.some(change => change.source === 'compiled-duration-range'))
  assert.deepEqual(candidate, before)
})

test('writer attempt limits honor the same explicit node budget while preserving defaults and shared exhaustion', async () => {
  const run = async (maxGenerationAttempts: unknown, sharedLimit = 12) => {
    let requests = 0
    const result = generateHistoricalStoryboard({ prompt: '完整保留原节拍',
      expected: { scene: chantScene, pacingVersion: 'duration-v2', requireDynamicPacing: true, maxGenerationAttempts },
      canGenerate: () => requests < sharedLimit,
      generate: async () => {
        requests += 1
        const candidate = chantShot()
        candidate.pacing.beats[0].sourceBeatId = `unknown-source-${requests}`
        return candidate
      } })
    await assert.rejects(result, /分镜修复未通过/)
    return requests
  }
  assert.equal(await run(8), 5)
  assert.equal(await run(8, 3), 3, 'the runtime cannot exceed the shared writer budget')
  assert.equal(await run(1), 1)
  assert.equal(await run(13), 5, 'an oversized configured limit clamps to the workflow retry ceiling')
  assert.equal(await run('8'), 5, 'numeric node configuration uses the same limit as accounting')
  for (const unsupported of [undefined, 0, 5.5]) assert.equal(await run(unsupported), 2, 'the default uses two structural attempts; explicit strict budgets remain available')
})

test('the two final production failures compile as complete scoped segments without another model call', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/storyboard-duration-metadata-failure.json', import.meta.url), 'utf8'))
  for (const row of fixture.candidates) {
    const candidate = structuredClone(row.candidate)
    for (const segment of candidate.segments) segment.pacing.timingPolicy = DEFAULT_DURATION_POLICY
    const before = structuredClone(candidate)
    const result = await generateHistoricalStoryboard({ prompt: '原执行完整声画分镜', initialCandidate: candidate,
      expected: { scene: fixture.scene, timingPolicy: DEFAULT_DURATION_POLICY, pacingVersion: 'duration-v2',
        requireDynamicPacing: true, requireDramaContract: true, requireContinuityContract: true, requireNarrativeClosure: true },
      canGenerate: () => false, generate: async () => { throw new Error('离线回放不得调用模型') } })
    const segments = result.__storyboardSegments as Array<Record<string, unknown>>
    assert.deepEqual(segments.map(part => part.duration), [8, 11])
    assert.deepEqual(segments.flatMap(part => part.coveredBeatIds), ['beat-01', 'beat-02'])
    for (const [index, part] of segments.entries()) {
      assert.equal(part.audioText, before.segments[index].audioText)
      assert.deepEqual(part.characters, before.segments[index].characters)
      const beats = (part.pacing as { beats: Array<Record<string, unknown>> }).beats
      for (const [beatIndex, beat] of beats.entries()) {
        for (const key of ['sourceBeatId', 'actorIds', 'textOrVocalization', 'deliveryStyle', 'dependsOn', 'overlapAllowedWith', 'completion']) {
          assert.deepEqual(beat[key], before.segments[index].pacing.beats[beatIndex][key])
        }
      }
      assert.doesNotThrow(() => verifyDurationSchedule(part))
    }
    assert.deepEqual(candidate, before)
  }
})
