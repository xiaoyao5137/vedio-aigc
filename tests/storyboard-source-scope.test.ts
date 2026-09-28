import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDramaGenerationBudget } from '../src/drama-generation-budget.ts'
import { generateHistoricalStoryboard, sceneFromStoryboardSegment, STORYBOARD_SEGMENTS_KEY } from '../src/storyboard-runtime.ts'
import { storyboardSegmentCompletionCriteria } from '../src/workflow-core.ts'
import { chantScene, chantShot } from './fixtures/duration-v2-chant.ts'

// The production failure returned only the first of three approved source ids
// and put the other two in pendingActions. Three nine-second obligations make
// that same response-shape failure reproducible without a provider or run log.
const scene = { ...chantScene, requiredBeats: [1, 2, 3].map(index => ({
  ...chantScene.requiredBeats[0], id: `beat-0${index}`,
})) }
function segments() {
  return scene.requiredBeats.map((beat, index) => {
    const shot = chantShot()
    shot.id = `scene-01-part-${index + 1}`
    shot.coveredBeatIds = [beat.id]
    shot.pacing.beats = shot.pacing.beats.map(row => ({ ...row, sourceBeatId: beat.id }))
    if (index) {
      shot.continuity = { previousShotId: `scene-01-part-${index}`, bridgeType: 'same_frame', bridgeAnchor: '' }
      shot.firstFrameMode = 'reuse_previous_tail'
      shot.visualPrompt = shot.lastFramePrompt
    }
    return shot
  })
}
function combineSegments(parts = segments()) {
  return { ...parts[0], coveredBeatIds: scene.requiredBeats.map(beat => beat.id),
    audioText: parts.map(part => part.audioText).join('\n'),
    pacing: { ...parts[0].pacing, beats: parts.flatMap((part, index) => part.pacing.beats.map((beat, beatIndex) => ({
      ...beat, id: `${index}-${beat.id}`, dependsOn: beat.dependsOn.map(id => `${index}-${id}`)
        .concat(index && !beatIndex ? [`${index - 1}-crowd-response`] : []),
      overlapAllowedWith: beat.overlapAllowedWith.map(id => `${index}-${id}`),
    }))) },
  }
}
const expected = { qualityDisposition: 'strict-v1', maxGenerationAttempts: 5, scene, pacingVersion: 'duration-v2', requireDynamicPacing: true, requireContinuityContract: true }
function assertCompleteScope(prompt: string) {
  assert.match(prompt, /【本次分镜覆盖范围】/)
  assert.match(prompt, /完整交付 \["beat-01","beat-02","beat-03"\]/)
  assert.match(prompt, /同一次响应返回完整/)
  assert.match(prompt, /不能只返回首段.*不能以 pendingActions/)
  assert.doesNotMatch(prompt, /按自然4\.5字\/秒预算|speech\/action\/reaction 三类窗口|actionSeconds.*reactionSeconds.*duration=max/)
}

test('every production request identifies the complete approved three-beat scope', async () => {
  const prompts: string[] = []
  const result = await generateHistoricalStoryboard({ prompt: '已批准的场景', expected,
    generate: async prompt => { prompts.push(prompt); return { segments: segments() } },
  })
  assert.equal(prompts.length, 1)
  assertCompleteScope(prompts[0])
  assert.deepEqual((result[STORYBOARD_SEGMENTS_KEY] as ReturnType<typeof segments>).flatMap(part => part.coveredBeatIds), ['beat-01', 'beat-02', 'beat-03'])
})

test('the first omitted source id requests a full split and repeated omissions retain the shared budget', async () => {
  const prompts: string[] = []
  const budget = createDramaGenerationBudget(undefined, 5)
  const broken = { ...segments()[0], storyProgress: { unitId: 'drama-01', status: 'continuing',
    actionResult: '第一原节拍已完成', response: '现场回应已完成', pendingActions: ['beat-02', 'beat-03'] } }
  const before = structuredClone(broken)
  const result = await generateHistoricalStoryboard({ prompt: '已批准的场景', expected,
    canGenerate: () => budget.canConsume(),
    generate: async prompt => {
      budget.consume(); prompts.push(prompt)
      return prompts.length < 3 ? structuredClone(broken) : { segments: segments() }
    },
  })
  assert.equal(budget.used, 3)
  assert.equal(prompts.length, 3)
  prompts.forEach(assertCompleteScope)
  assert.doesNotMatch(prompts[0], /【自动拆镜】/)
  assert.match(prompts[1], /【自动拆镜】/)
  assert.match(prompts[2], /【自动拆镜】/)
  assert.ok(prompts.every(prompt => !prompt.includes('【本次唯一任务】')), 'three source ids remain one complete response task')
  assert.deepEqual(broken, before, 'the rejected provider evidence stays unchanged')
  assert.equal((result[STORYBOARD_SEGMENTS_KEY] as unknown[]).length, 3)
})

test('declaring all ids cannot hide missing source performances and still triggers the first split', async () => {
  const prompts: string[] = []
  const broken = { ...segments()[0], coveredBeatIds: scene.requiredBeats.map(beat => beat.id) }
  const result = await generateHistoricalStoryboard({ prompt: '已批准的场景', expected, initialCandidate: broken,
    generate: async prompt => { prompts.push(prompt); return { segments: segments() } },
  })
  assert.equal(prompts.length, 1)
  assertCompleteScope(prompts[0])
  assert.match(prompts[0], /【自动拆镜】/)
  assert.match(prompts[0], /未分配完整声画表演/)
  assert.equal((result[STORYBOARD_SEGMENTS_KEY] as unknown[]).length, 3)
})

test('coverage recovery keeps the complete split when a later candidate exposes overflow', async () => {
  const parts = segments()
  const combined = combineSegments(parts)
  const prompts: string[] = []
  const result = await generateHistoricalStoryboard({ prompt: '已批准的场景', expected,
    generate: async prompt => {
      prompts.push(prompt)
      return prompts.length === 1 ? parts[0] : prompts.length === 2 ? combined : { segments: parts }
    },
  })
  assert.equal(prompts.length, 3)
  assert.match(prompts[2], /STORYBOARD_TIMING_OVERFLOW/)
  assert.match(prompts[2], /【自动拆镜】/)
  assert.doesNotMatch(prompts[2], /【本次唯一任务】/)
  assert.equal((result[STORYBOARD_SEGMENTS_KEY] as unknown[]).length, 3)
})

test('an initially complete but overflowing v2 scene requests the entire split before any per-beat generation', async () => {
  const combined = combineSegments()
  const prompts: string[] = []
  const result = await generateHistoricalStoryboard({ prompt: '已批准的场景', expected, initialCandidate: combined,
    generate: async prompt => { prompts.push(prompt); return { segments: segments() } },
  })
  assert.equal(prompts.length, 1)
  assertCompleteScope(prompts[0])
  assert.match(prompts[0], /STORYBOARD_TIMING_OVERFLOW.*【自动拆镜】|【自动拆镜】.*STORYBOARD_TIMING_OVERFLOW/s)
  assert.doesNotMatch(prompts[0], /【本次唯一任务】/)
  assert.equal((result[STORYBOARD_SEGMENTS_KEY] as unknown[]).length, 3)
})

test('initial mixed narration and chant split in one response without changing the approved voice types or words', async () => {
  const parts = segments()
  for (const part of parts.slice(0, 2)) {
    part.audioType = '旁白'
    part.audioText = part.pacing.beats[1].textOrVocalization
    part.pacing.beats[1].deliveryStyle = 'narration'
    part.pacing.beats[1].actorIds = ['旁白']
  }
  for (const audioType of ['对白', '旁白']) {
    const combined = combineSegments(parts)
    combined.audioType = audioType
    combined.audioText = parts.map(part => part.audioType === '旁白' ? `旁白:${part.audioText}` : part.audioText).join('\n')
    const before = structuredClone(combined)
    const prompts: string[] = []
    const budget = createDramaGenerationBudget({ previousCandidate: { repairProvenance: { generationAttempts: 3 } } }, 5)
    const result = await generateHistoricalStoryboard({ prompt: '已批准的场景', expected, initialCandidate: combined,
      canGenerate: () => budget.canConsume(),
      generate: async prompt => { budget.consume(); prompts.push(prompt); return { segments: structuredClone(parts) } },
    })
    assert.equal(prompts.length, 1)
    assert.equal(budget.used, 4)
    assertCompleteScope(prompts[0])
    assert.match(prompts[0], /【自动拆镜】/)
    assert.match(prompts[0], /每段只能使用一种音轨类型.*保留已批准的原台词、说话人和 deliveryStyle/)
    assert.doesNotMatch(prompts[0], /【本次唯一任务】/)
    assert.deepEqual(combined, before)
    const actual = result[STORYBOARD_SEGMENTS_KEY] as ReturnType<typeof segments>
    assert.deepEqual(actual.map(part => part.audioType), ['旁白', '旁白', '对白'])
    assert.deepEqual(actual.flatMap(part => part.pacing.beats.filter(beat => beat.kind === 'speech')
      .map(beat => [beat.sourceBeatId, beat.actorIds, beat.deliveryStyle, beat.textOrVocalization])),
    parts.flatMap(part => part.pacing.beats.filter(beat => beat.kind === 'speech')
      .map(beat => [beat.sourceBeatId, beat.actorIds, beat.deliveryStyle, beat.textOrVocalization])))
  }
})

test('a narration text mismatch remains a local repair when all original voices are narration', async () => {
  // Two narration voices fit the independent voice-only budget. Three copies
  // also have a real overflow, which must now be reported alongside bad text.
  const parts = segments().slice(0, 2)
  const localExpected = { ...expected, scene: { ...scene, requiredBeats: scene.requiredBeats.slice(0, 2) } }
  for (const part of parts) {
    part.audioType = '旁白'
    part.audioText = part.pacing.beats[1].textOrVocalization
    part.pacing.beats[1].deliveryStyle = 'narration'
    part.pacing.beats[1].actorIds = ['旁白']
  }
  const combined = combineSegments(parts)
  combined.coveredBeatIds = localExpected.scene.requiredBeats.map(beat => beat.id)
  combined.audioText = combined.audioText.slice(1)
  const prompts: string[] = []
  await generateHistoricalStoryboard({ prompt: '已批准的场景', expected: localExpected, initialCandidate: combined,
    generate: async prompt => { prompts.push(prompt); return { segments: parts } },
  })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /旁白声部须逐字覆盖 audioText/)
  assert.doesNotMatch(prompts[0], /【自动拆镜】/)
})

test('a shared budget already spent by earlier review cannot be reset during coverage recovery', async () => {
  const budget = createDramaGenerationBudget({ previousCandidate: { repairProvenance: { generationAttempts: 3 } } }, 5)
  const prompts: string[] = []
  await assert.rejects(() => generateHistoricalStoryboard({ prompt: '已批准的场景', expected,
    canGenerate: () => budget.canConsume(),
    generate: async prompt => { budget.consume(); prompts.push(prompt); return segments()[0] },
  }), /STORYBOARD_COVERAGE_INCOMPLETE.*beat-02.*beat-03/)
  assert.equal(budget.used, 5)
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /【自动拆镜】/)
})

test('an enacted-anchor omission keeps its local repair and the duration-v2 clock', async () => {
  const broken = chantShot()
  broken.pacing.beats[2].textOrVocalization = '围观乡人作一次短促无词哼唱回应'
  const prompts: string[] = []
  const result = await generateHistoricalStoryboard({ prompt: '已批准的场景', initialCandidate: broken,
    expected: { scene: chantScene, pacingVersion: 'duration-v2', requireDynamicPacing: true },
    generate: async prompt => { prompts.push(prompt); return chantShot() },
  })
  assert.equal(prompts.length, 1)
  assert.doesNotMatch(prompts[0], /【自动拆镜】|speech\/action\/reaction 三类窗口/)
  assert.match(prompts[0], /原锚点 围观乡人点头/)
  assert.equal(result.duration, 9)
})

test('a local duration-v2 anchor defect never discards the rest of the scene into per-beat recovery', async () => {
  const localScene={...chantScene,requiredBeats:[...chantScene.requiredBeats,{id:'arrival',mustShow:['扶着病人'],
    description:'饥民代表扶病人坐下',setting:'甘陵街巷'}]}
  const broken=chantShot()
  broken.coveredBeatIds=['song-spreads','arrival']
  broken.pacing.beats.push({id:'arrival-action',sourceBeatId:'arrival',actorIds:['饥民代表'],kind:'action',
    textOrVocalization:'饥民代表向病人挥手',dependsOn:['crowd-response'],overlapAllowedWith:[],
    durationEstimate:{lower:.3,expected:.4,upper:.5,source:'导演动作估计',confidence:'low'},
    completion:{requiredThisClip:true,finalState:'饥民代表挥手',modality:'visual',evidenceAnchor:'挥手'}})
  const prompts:string[]=[]
  await assert.rejects(generateHistoricalStoryboard({prompt:'已批准的完整场景',expected:{scene:localScene,pacingVersion:'duration-v2',maxGenerationAttempts:4},
    generate:async prompt=>{prompts.push(prompt);return structuredClone(broken)}}),/4 次/)
  assert.equal(prompts.length,4)
  for(const prompt of prompts){
    assert.match(prompt,/完整交付 \["song-spreads","arrival"\]/)
    assert.doesNotMatch(prompt,/【原场景分段关系】|当前场景 scene-01-beat-/)
  }
})

test('ordered recovery keeps later shots continuous and gives each shot only its own approved completion conditions', async () => {
  const original = JSON.parse(readFileSync(new URL('./fixtures/storyboard-coverage-failure.json', import.meta.url), 'utf8'))
  const repaired = JSON.parse(readFileSync(new URL('./fixtures/storyboard-coverage-repaired.json', import.meta.url), 'utf8'))
  const source = { ...original.scene, continuityMode: 'scene_cut', completionCriteria: ['全场三个节拍已完成'] }
  const prompts: string[] = []
  const result = await generateHistoricalStoryboard({ prompt: `上一镜承接信息（第一镜为空）：{}\n\n当前场景：${JSON.stringify(source)}\n\n史料原文：保留史料`,
    expected: { scene: source, requireContinuityContract: true, aspectRatio: '16:9' }, initialCandidate: original.candidate,
    generate: async prompt => { prompts.push(prompt); return repaired.segments[prompts.length - 1] },
  })
  assert.equal(prompts.length, 3)
  for (const [index, prompt] of prompts.entries()) {
    const current = JSON.parse(prompt.match(/当前场景：(.*?)\n\n史料原文：/)![1])
    assert.equal(current.continuityMode, index ? 'tail_continuation' : 'scene_cut')
    assert.equal(current.continuityFromPrevious, index > 0)
    assert.deepEqual(current.requiredBeats, [source.requiredBeats[index]])
    assert.deepEqual(current.completionCriteria, storyboardSegmentCompletionCriteria(current.requiredBeats))
    assert.ok(!current.completionCriteria.includes('全场三个节拍已完成'))
    assert.match(prompt, /全场完成条件=\["全场三个节拍已完成"\]，由全部分段共同实现/)
    assert.match(prompt, /没有实际尾帧证据时，开场 worldState 事实保持 unknown/)
  }
  const outputs = result[STORYBOARD_SEGMENTS_KEY] as Record<string, unknown>[]
  const retryScene = sceneFromStoryboardSegment(source, outputs[1], 1, 3)
  assert.deepEqual(retryScene.completionCriteria, storyboardSegmentCompletionCriteria([source.requiredBeats[1]]))
  assert.deepEqual(retryScene.requiredBeats, [source.requiredBeats[1]])
})
