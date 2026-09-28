import test from 'node:test'
import assert from 'node:assert/strict'
import { repairStoryboardAnonymousActorGroups, repairStoryboardSplitContinuityMetadata, repairStoryboardSplitCoverageMetadata } from '../src/storyboard-runtime.ts'

const scene = { requiredBeats: [{ id: 'beat-01', mustShow: ['灵帝登基殿堂', '党人被押', '灾民逃难', '张角持符水'],
  observable: { visual: ['灵帝登基殿堂', '党人被押场景', '灾民扶老携幼逃难', '张角手持符水'],
    audio: ['建宁元年，灵帝即位。党人下狱。', '建宁四年，大疫。张角以符水疗病。'] } }] }

test('split coverage drops only approved narration copied into mustShow allocation metadata', () => {
  const candidate = { segments: [
    { coveredBeatIds: ['beat-01'], beatCoverage: [{ beatId: 'beat-01', anchors: ['灵帝登基殿堂', '党人被押场景', '建宁元年，灵帝即位。党人下狱。'] }] },
    { coveredBeatIds: ['beat-01'], beatCoverage: [{ beatId: 'beat-01', anchors: ['灾民扶老携幼逃难', '灾民逃难', '张角手持符水', '张角持符水', '建宁四年，大疫。'] }] },
  ] }
  const before = structuredClone(candidate)
  const repaired = repairStoryboardSplitCoverageMetadata(candidate, { scene })!
  assert.deepEqual(repaired.candidate.segments.map(segment => segment.beatCoverage[0].anchors),
    [['灵帝登基殿堂', '党人被押'], ['灾民逃难', '张角持符水']])
  assert.equal(repaired.changes[0].source, 'approved-beat-coverage')
  assert.deepEqual(candidate, before)
})

test('split coverage rejoins partial visual labels and permits an audio-only continuation allocation', () => {
  const combinedScene = { requiredBeats: [{ id: 'beat-01',
    mustShow: ['张角人物插画在华北地图背景上淡入、人物图层向周边州郡扩散移动'],
    observable: {
      visual: ['张角人物插画在华北地图背景上淡入、人物图层向周边州郡扩散移动'],
      audio: ['朝廷遣使致医药，然民间病者众多，此时张角以符水疗病。'],
    },
  }] }
  const candidate = { segments: [
    { coveredBeatIds: ['beat-01'], beatDramaturgy: [{ beatId: 'beat-01',
      visual: ['张角人物插画在华北地图背景上淡入、人物图层向周边州郡扩散移动'],
      audio: ['朝廷遣使致医药，然民间病者众多，'] }], beatCoverage: [{ beatId: 'beat-01',
      anchors: ['张角人物插画在华北地图背景上淡入', '人物图层向周边州郡扩散移动'] }] },
    { coveredBeatIds: ['beat-01'], beatDramaturgy: [{ beatId: 'beat-01', visual: [],
      audio: ['此时张角以符水疗病。'] }], beatCoverage: [{ beatId: 'beat-01', anchors: ['此时张角以符水疗病。'] }] },
  ] }
  const repaired = repairStoryboardSplitCoverageMetadata(candidate, { scene: combinedScene })!
  assert.deepEqual(repaired.candidate.segments.map(segment => segment.beatCoverage[0].anchors),
    [['张角人物插画在华北地图背景上淡入、人物图层向周边州郡扩散移动'], []])
})

test('split coverage repair cannot hide invented or still-missing visual anchors', () => {
  const invented = { segments: [
    { coveredBeatIds: ['beat-01'], beatCoverage: [{ beatId: 'beat-01', anchors: ['灵帝登基殿堂', '党人被押', '虚构宫门'] }] },
    { coveredBeatIds: ['beat-01'], beatCoverage: [{ beatId: 'beat-01', anchors: ['灾民逃难', '张角持符水'] }] },
  ] }
  assert.equal(repairStoryboardSplitCoverageMetadata(invented, { scene }), undefined)
  const missing = structuredClone(invented)
  missing.segments[0].beatCoverage[0].anchors[2] = '建宁元年，灵帝即位。党人下狱。'
  missing.segments[1].beatCoverage[0].anchors = ['灾民逃难']
  assert.equal(repairStoryboardSplitCoverageMetadata(missing, { scene }), undefined)
})

test('later split scene_cut is projected from the authored previous tail without overriding coverage_cut', () => {
  const first = { id: 'part-1', lastFramePrompt: '宫门阴影落在石阶。', endCharacters: [] }
  const wrong = { id: 'part-2', visualPrompt: '重新自由构图', initialCharacters: [], firstFrameMode: 'reference',
    continuity: { mode: 'scene_cut', previousShotId: '', bridgeType: 'cut', bridgeAnchor: '转场' } }
  const repaired = repairStoryboardSplitContinuityMetadata({ segments: [first, wrong] })!
  assert.deepEqual(repaired.candidate.segments[1], { ...wrong, visualPrompt: first.lastFramePrompt,
    firstFrameMode: 'reuse_previous_tail', continuity: { mode: 'tail_continuation', previousShotId: first.id, bridgeType: 'same_frame', bridgeAnchor: '' } })
  const coverage = { ...wrong, continuity: { mode: 'coverage_cut', previousShotId: first.id, bridgeType: 'cut', bridgeAnchor: '视线反应' } }
  assert.equal(repairStoryboardSplitContinuityMetadata({ segments: [first, coverage] }), undefined)
})

test('anonymous-group repair removes only an invented decorative crowd reaction', () => {
  const candidate = {
    characters: ['张角'], presentCharacters: ['张角'], initialCharacters: ['张角'], endCharacters: ['张角'],
    pacing: {
      actorGroups: [
        { id: 'group-patient', label: '病患', memberDescription: '跪地服用符水的病患' },
        { id: 'group-villagers', label: '围观百姓', memberDescription: '十余名围观百姓' },
      ],
      beats: [
        { id: 'pour', sourceBeatId: 'beat-04', actorIds: ['张角'], kind: 'action', textOrVocalization: '张角从竹筒中倒出符水递给病患' },
        { id: 'drink', sourceBeatId: 'beat-04', actorIds: ['group-patient'], kind: 'action', textOrVocalization: '病患接过饮下' },
        { id: 'extra', sourceBeatId: 'beat-04', actorIds: ['group-villagers'], kind: 'reaction', textOrVocalization: '围观百姓注视病患饮水' },
      ],
    },
  }
  const repaired = repairStoryboardAnonymousActorGroups(candidate, { scene: { cast: ['张角'], requiredBeats: [{ id: 'beat-04',
    mustShow: ['张角从竹筒中倒出符水递给病患', '病患接过饮下'], observable: { visual: ['张角从竹筒中倒出符水递给病患', '病患接过饮下'] } }] } })!
  assert.deepEqual(repaired.candidate.pacing.beats.map((beat: { id: string }) => beat.id), ['pour', 'drink'])
  assert.deepEqual(repaired.candidate.pacing.actorGroups.map((group: { label: string }) => group.label), ['病患'])
  assert.equal(repaired.changes.at(-1)?.reason, 'removed-unapproved-anonymous-reaction')
})
