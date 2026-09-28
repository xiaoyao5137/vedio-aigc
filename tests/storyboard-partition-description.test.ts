import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { historicalStoryboardSegmentInputs, validateStoryboardBeatCoverage, validateNoUnallocatedSplitActions } from '../src/workflow-core.ts'
import { sceneFromStoryboardSegment } from '../src/storyboard-runtime.ts'
import { validateDramaOutline, validateDramaStoryboard, validateExpandedDramaOutline } from '../src/history-drama.ts'

type Value = ReturnType<typeof JSON.parse>

const scene = {
  id: 'scene-song', title: '低声传唱', dramaticSceneId: 'drama-song',
  requiredBeats: [{ id: 'beat-song', description: '百姓围坐，低声传唱歌谣，然后四下张望。',
    setting: '街巷', function: '呈现传唱', stateChange: '歌谣传开而百姓戒备',
    mustShow: ['百姓围坐', '低声传唱'],
    observable: { visual: ['百姓围坐', '低声传唱', '四下张望'], audio: ['朝廷之声，百姓之忧。'] },
  }],
}
const segments = [
  { id: 'song-part-1', title: '传唱', duration: 5, coveredBeatIds: ['beat-song'],
    beatCoverage: [{ beatId: 'beat-song', anchors: ['百姓围坐', '低声传唱'] }],
    beatDramaturgy: [{ beatId: 'beat-song', visual: ['百姓围坐', '低声传唱'], audio: [] }],
  },
  { id: 'song-part-2', title: '戒备', duration: 5, coveredBeatIds: ['beat-song'],
    beatCoverage: [{ beatId: 'beat-song', anchors: [] }],
    beatDramaturgy: [{ beatId: 'beat-song', visual: ['四下张望'], audio: ['朝廷之声，百姓之忧。'] }],
  },
]

test('child projections preserve observable-only actions and omit already allocated performance', () => {
  const before = structuredClone({ scene, segments })
  const inputs = historicalStoryboardSegmentInputs({ segments }, { scene })
  const runtime = segments.map((segment, index) => sceneFromStoryboardSegment(scene, segment, index, segments.length))
  assert.deepEqual(inputs.map(input => input.splitScene.requiredBeats), runtime.map(part => part.requiredBeats))
  assert.equal(runtime[0].requiredBeats[0].description, '百姓围坐；低声传唱',
    'all mustShow in one child does not make its incomplete visual/audio allocation the whole beat')
  assert.equal(runtime[1].requiredBeats[0].description, '四下张望；朝廷之声，百姓之忧。')
  assert.deepEqual(runtime[1].requiredBeats[0].mustShow, [])
  assert.deepEqual(runtime[1].requiredBeats[0].observable.visual, ['四下张望'])
  assert.match(runtime[1].purpose, /四下张望/)
  assert.ok(runtime[1].completionCriteria.includes('画面呈现：四下张望'))
  assert.doesNotMatch(runtime[1].purpose, /百姓围坐|低声传唱/)
  assert.deepEqual({ scene, segments }, before)
})

test('an observable-only visual child keeps its action description without requiring audio', () => {
  const visualOnlyScene = structuredClone(scene)
  visualOnlyScene.requiredBeats[0].observable.audio = []
  const visualOnlySegments = structuredClone(segments)
  visualOnlySegments[1].beatDramaturgy[0].audio = []
  const inputs = historicalStoryboardSegmentInputs({ segments: visualOnlySegments }, { scene: visualOnlyScene })
  assert.equal(inputs[1].splitScene.requiredBeats[0].description, '四下张望')
  assert.deepEqual(inputs[1].splitScene.requiredBeats[0].mustShow, [])
})

test('whole allocated beats retain approved singing and performance instructions', () => {
  const completeScene = { ...scene, requiredBeats: [
    { ...scene.requiredBeats[0], description: '百姓压低声音，以无词哼唱传唱歌谣，唱毕四下张望。' },
    { id: 'beat-exit', description: '百姓起身离开街巷。', setting: '街巷', function: '结束场面', stateChange: '街巷归于寂静',
      mustShow: ['百姓起身离开'], observable: { visual: ['百姓起身离开'], audio: [] } },
  ] }
  const completeSegments = [
    { ...segments[0], beatDramaturgy: [{ beatId: 'beat-song', ...structuredClone(completeScene.requiredBeats[0].observable) }] },
    { ...segments[1], coveredBeatIds: ['beat-exit'], beatCoverage: [{ beatId: 'beat-exit', anchors: ['百姓起身离开'] }],
      beatDramaturgy: [{ beatId: 'beat-exit', visual: ['百姓起身离开'], audio: [] }] },
  ]
  const inputs = historicalStoryboardSegmentInputs({ segments: completeSegments }, { scene: completeScene })
  const child = sceneFromStoryboardSegment(completeScene, completeSegments[0], 0, 2)
  assert.equal(inputs[0].splitScene.requiredBeats[0].description, completeScene.requiredBeats[0].description)
  assert.equal(child.requiredBeats[0].description, completeScene.requiredBeats[0].description)
  assert.ok(child.completionCriteria.includes('原节拍表演：' + completeScene.requiredBeats[0].description))
})

function partitionedVoiceFixture(mode: 'musical' | 'narration', cast = ['张角', '旁听者'], nestedQuote = false) {
  const lyrics = nestedQuote ? '苍天“已死”，黄天当立。' : '苍天已死，黄天当立。'
  const pieces = nestedQuote ? ['苍天“已死”，', '黄天当立。'] : ['苍天已死，', '黄天当立。']
  const visuals = cast.length ? ['张角站立', '四下张望'] : ['火把燃烧', '烛影晃动']
  const source = { id: 'scene-voice', title: '原声部', cast, contentContractVersion: 'cinematic-v1', dramaticSceneId: 'drama-voice',
    requiredBeats: [{ id: 'beat-voice', setting: '殿堂', function: '传递原声部', stateChange: '歌词完整传出',
      description: mode === 'narration' ? '画外旁白朗读“苍天已死，黄天当立。”；随后四下张望。'
        : `${cast.length ? '张角低声' : ''}吟唱“苍天已死，黄天当立。”；随后四下张望。`,
      mustShow: [visuals[0]], observable: { visual: visuals, audio: [lyrics] } }],
  }
  const parts = pieces.map((piece, index) => ({
    id: 'voice-part-' + (index + 1), title: '原声部分段', duration: 5, characters: cast, presentCharacters: cast,
    contentContractVersion: 'cinematic-v1', dramaticSceneId: 'drama-voice', coveredBeatIds: ['beat-voice'],
    shotIntent: { viewpointCharacter: cast[0] ?? '观众', purpose: '执行本段声画', cameraReason: '原调度' },
    beatCoverage: [{ beatId: 'beat-voice', anchors: index ? [] : [visuals[0]] }],
    beatDramaturgy: [{ beatId: 'beat-voice', function: source.requiredBeats[0].function,
      stateChange: source.requiredBeats[0].stateChange, visual: [visuals[index]], audio: [piece] }],
    visualPrompt: visuals[index], videoPrompt: visuals[index], audioText: piece,
    pacing: { version: 'duration-v2', actorGroups: [] as Value[], beats: [
      { id: 'action-' + index, sourceBeatId: 'beat-voice', kind: 'action', actorIds: cast.slice(0, 1),
        textOrVocalization: visuals[index], completion: { requiredThisClip: true } },
      { id: 'voice-' + index, sourceBeatId: 'beat-voice', kind: 'speech', deliveryStyle: mode === 'narration' ? 'narration' : 'chant',
        actorIds: mode === 'narration' ? ['旁白'] : cast.length ? ['张角'] : ['anonymous-singer'], textOrVocalization: piece },
    ] },
  }))
  return { source, parts }
}

test('partial child singing and narration keep original delivery and exact source actors on both projection paths', () => {
  for (const mode of ['musical', 'narration'] as const) {
    const { source, parts } = partitionedVoiceFixture(mode)
    const before = structuredClone({ source, parts })
    const immediate = historicalStoryboardSegmentInputs({ segments: parts }, { scene: source })
    const runtime = parts.map((part, index) => sceneFromStoryboardSegment(source, part, index, 2))
    assert.deepEqual(immediate.map(input => input.splitScene.requiredBeats), runtime.map(child => child.requiredBeats))
    for (const [index, part] of parts.entries()) for (const child of [immediate[index].splitScene, runtime[index]]) {
      assert.equal(validateDramaStoryboard(part, child), part)
      const description = child.requiredBeats[0].description
      assert.match(description, mode === 'musical' ? /张角吟唱/ : /画外旁白朗读/)
      assert.doesNotMatch(description, index ? /苍天已死|张角站立/ : /黄天当立|四下张望/)
      const dialogue = structuredClone(part)
      dialogue.pacing.beats[1].deliveryStyle = 'dialogue'
      assert.throws(() => validateDramaStoryboard(dialogue, child), /原声部.*继承 description 明示/)
      const otherActor = structuredClone(part)
      otherActor.pacing.beats[1].actorIds = ['旁听者']
      assert.throws(() => validateDramaStoryboard(otherActor, child), /原发声主体/)
    }
    assert.deepEqual({ source, parts }, before)
  }
})

test('partial unbound singing preserves its delivery without inventing a cast binding', () => {
  const { source, parts } = partitionedVoiceFixture('musical', [])
  const children = parts.map((part, index) => sceneFromStoryboardSegment(source, part, index, 2))
  for (const [index, part] of parts.entries()) {
    assert.equal(validateDramaStoryboard(part, children[index]), part)
    assert.match(children[index].requiredBeats[0].description, /(?:^|；)吟唱“/)
    const otherSinger = structuredClone(part)
    otherSinger.pacing.beats[1].actorIds = ['another-anonymous-singer']
    assert.equal(validateDramaStoryboard(otherSinger, children[index]), otherSinger,
      'the source declared no exact cast identity for this voice')
    otherSinger.pacing.beats[1].deliveryStyle = 'dialogue'
    assert.throws(() => validateDramaStoryboard(otherSinger, children[index]), /原声部.*传唱\/吟唱/)
  }
})

test('nested ignored quote punctuation cannot erase a derived partial voice contract', () => {
  const { source, parts } = partitionedVoiceFixture('musical', ['张角', '旁听者'], true)
  const child = sceneFromStoryboardSegment(source, parts[0], 0, 2)
  assert.match(child.requiredBeats[0].description, /张角吟唱“苍天已死，”/)
  assert.deepEqual(child.requiredBeats[0].observable.audio, ['苍天“已死”，'])
  assert.equal(validateDramaStoryboard(parts[0], child), parts[0])
  const dialogue = structuredClone(parts[0])
  dialogue.pacing.beats[1].deliveryStyle = 'dialogue'
  assert.throws(() => validateDramaStoryboard(dialogue, child), /原声部.*传唱\/吟唱/)
})

test('expanded-outline validation shares projection and still rejects lost or duplicated observable-only actions', () => {
  const approved: Value = JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json', import.meta.url), 'utf8'))
  validateDramaOutline(approved, { requireDramaContract: true,
    input: { adaptation_policy: approved.adaptationSpace.policy, source_level: '正史' },
    historicalSources: { citations: [{ index: 1, id: 'source-1', content: '实际源正文' }] },
  })
  const originalShots = approved.scenes.map((source: Value) => ({
    id: source.id, duration: source.targetDuration, coveredBeatIds: source.requiredBeats.map((beat: Value) => beat.id),
    contentContractVersion: approved.contentContractVersion, dramaticSceneId: source.dramaticSceneId,
    characters: [...source.cast], shotIntent: { viewpointCharacter: source.cast[0], purpose: source.purpose, cameraReason: '观察听者反应' },
    beatDramaturgy: source.requiredBeats.map((beat: Value) => ({ beatId: beat.id, function: beat.function,
      stateChange: beat.stateChange, ...structuredClone(beat.observable) })),
    visualPrompt: '两人保持各自位置', videoPrompt: source.requiredBeats.flatMap((beat: Value) => beat.observable.visual).join('。'),
    audioText: source.requiredBeats.flatMap((beat: Value) => beat.observable.audio).join('。'), lastFramePrompt: '动作完成后的尾帧',
  }))
  const first = structuredClone(originalShots[2]), second = structuredClone(originalShots[2])
  first.id += '-part-1'; second.id += '-part-2'
  for (const part of [first, second]) {
    part.duration = 3; part.continuity = { mode: 'coverage_cut' }; part.worldState = { settingId: 'drama-encounter' }
  }
  first.beatDramaturgy[0].visual = ['周家宾客撤回招呼', '周家宾客转身离开']
  second.beatDramaturgy[0].visual = ['房家宾客移开视线']
  first.beatCoverage = [{ beatId: 'beat-choice', anchors: ['撤回招呼', '转身离开'] }]
  second.beatCoverage = [{ beatId: 'beat-choice', anchors: [] }]
  first.videoPrompt = first.beatDramaturgy[0].visual.join('。')
  second.videoPrompt = second.beatDramaturgy[0].visual.join('。')
  const scenes = approved.scenes.flatMap((source: Value, index: number) => index === 2
    ? [sceneFromStoryboardSegment(source, first, 0, 2), sceneFromStoryboardSegment(source, second, 1, 2)] : [source])
    .map((part: Value, index: number) => ({ ...part, sequence: index + 1 }))
  const shots = [...originalShots.slice(0, 2), first, second, originalShots[3]]
  const expanded = { ...approved, scenes, count: scenes.length, totalDuration: shots.reduce((sum, shot) => sum + shot.duration, 0) }
  assert.equal(scenes[3].requiredBeats[0].description, '房家宾客移开视线')
  assert.doesNotThrow(() => validateExpandedDramaOutline(expanded, approved, shots))
  assert.doesNotThrow(() => validateStoryboardBeatCoverage(second, scenes[3]),
    'a cinematic runtime child may allocate only observable visual obligations')
  const inputs = historicalStoryboardSegmentInputs({ segments: [first, second] }, { scene: approved.scenes[2] })
  assert.equal(inputs[1].splitScene.sourceSceneId, approved.scenes[2].id)
  assert.doesNotThrow(() => validateStoryboardBeatCoverage(second, inputs[1].splitScene),
    'the immediate validation child retains the same runtime provenance')
  const rootWithoutAnchors = { ...scenes[3] }
  delete rootWithoutAnchors.sourceSceneId
  assert.throws(() => validateStoryboardBeatCoverage(second, rootWithoutAnchors), /mustShow 必须是非空字符串数组/)
  const noObligations = structuredClone(scenes[3])
  noObligations.requiredBeats[0].observable = { visual: [], audio: [] }
  assert.throws(() => validateStoryboardBeatCoverage(second, noObligations), /mustShow 必须是非空字符串数组/)
  const inventedAction = { ...second, pacing: { beats: [{ sourceBeatId: 'beat-choice', kind: 'action', textOrVocalization: '房家宾客拔剑' }] } }
  assert.throws(() => validateNoUnallocatedSplitActions(inventedAction, scenes[3]), /未分配动作/)
  const changed = structuredClone(expanded)
  changed.scenes[3].requiredBeats[0].description = '待后续完成'
  assert.throws(() => validateExpandedDramaOutline(changed, approved, shots), /丢失或改写已批准 description/)
  const lost = structuredClone(shots)
  lost[3].beatDramaturgy[0].visual = []
  assert.throws(() => validateExpandedDramaOutline(expanded, approved, lost), /实际 0 次/)
  const repeated = structuredClone(shots)
  repeated[2].beatDramaturgy[0].visual.push('房家宾客移开视线')
  assert.throws(() => validateExpandedDramaOutline(expanded, approved, repeated), /实际 2 次/)
})
