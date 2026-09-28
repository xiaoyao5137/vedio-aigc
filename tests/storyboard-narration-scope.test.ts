import test from 'node:test'
import assert from 'node:assert/strict'
import { generateHistoricalStoryboard } from '../src/storyboard-runtime.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'
import { DEFAULT_DURATION_POLICY, estimateSpeechDuration } from '../src/duration-policy.ts'

// The saved record-2fpd3t writer still supplied a dialogue template and described
// actorIds as on-screen character names even though scene-01 starts with narration.
const savedPrompt = '旧保存模板："audioType":"对白"；actorIds 用 characters/presentCharacters 全名。'
const scene = { id: 'scene-01', cast: ['传谣者'], closesUnit: false, requiredBeats: [
  { id: 'beat-01', description: '传谣者在街市行走。旁白：桓帝为蠡吾侯时，曾受学于甘陵周福。', mustShow: ['传谣者在街市行走'] },
  { id: 'beat-02', description: '传谣者继续说话。传谣者：时同郡河南尹房植，亦有名当朝。', mustShow: ['传谣者继续说话'] },
] }

test('each duration-v2 request overrides the saved actor-name shorthand with the narrator exception and full split contract', async () => {
  const before = structuredClone(scene), prompts: string[] = []
  await assert.rejects(generateHistoricalStoryboard({ prompt: savedPrompt,
    expected: { scene, pacingVersion: 'duration-v2', maxGenerationAttempts: 2 },
    generate: async prompt => { prompts.push(prompt); return {} },
  }))
  assert.equal(prompts.length, 2)
  for (const prompt of prompts) {
    assert.ok(prompt.startsWith(savedPrompt), 'retain the original saved prompt for inspection')
    const canonical = prompt.slice(prompt.indexOf('【本次分镜覆盖范围】'))
    assert.match(canonical, /kind=speech、deliveryStyle=narration、actorIds=\["旁白"\]/)
    assert.match(canonical, /audioType=旁白/)
    assert.match(canonical, /不加入 characters、presentCharacters、initialCharacters、endCharacters 或 worldState\.characters/)
    assert.match(canonical, /场内动作仍绑定其实际人物，不能把旁白台词挂到出镜角色名下/)
    assert.match(canonical, /每段只能使用一种音轨类型/)
    assert.match(canonical, /保留已批准的原台词、说话人和 deliveryStyle/)
    assert.match(canonical, /若 15 秒放不下，同一次响应返回完整 \{"segments":\[\.\.\.\]\}/)
    assert.match(canonical, /所有分段合计覆盖全部原节拍，不能只返回首段/)
    assert.ok(canonical.includes(JSON.stringify(scene.requiredBeats)))
  }
  assert.deepEqual(scene, before)
})

test('the narrator exception is already executable without adding a narrator to character or world-state lists', () => {
  const text = '桓帝为蠡吾侯时，曾受学于甘陵周福。'
  const candidate = { duration: 4, characters: ['传谣者'], presentCharacters: ['传谣者'],
    initialCharacters: ['传谣者'], endCharacters: ['传谣者'], worldState: { settingId: 'drama-01', characters: [{ name: '传谣者' }] },
    audioType: '旁白', audioText: text, videoPrompt: '', coveredBeatIds: ['beat-01'],
    pacing: { version: 'duration-v2', timingPolicy: DEFAULT_DURATION_POLICY, beats: [{ id: 'narration-01', sourceBeatId: 'beat-01', actorIds: ['旁白'],
      kind: 'speech', deliveryStyle: 'narration', textOrVocalization: text,
      dependsOn: [], overlapAllowedWith: [], resources: ['voice'], durationEstimate: estimateSpeechDuration(text, 'narration'),
      completion: { requiredThisClip: true, finalState: '原旁白完整说完', modality: 'audio', evidenceAnchor: text } }] } }
  const before = structuredClone(candidate)
  const compiled = compileDurationSchedule(candidate, { scene: { requiredBeats: [{ id: 'beat-01', mustShow: [] }] } })
  assert.deepEqual(compiled.schedule[0].actorIds, ['旁白'])
  assert.match(compiled.videoPrompt, /画外旁白自然朗读/)
  assert.deepEqual(candidate, before)
  assert.throws(() => compileDurationSchedule({ ...candidate, pacing: { ...candidate.pacing,
    beats: [{ ...candidate.pacing.beats[0], deliveryStyle: 'dialogue' }] } }, { scene: { requiredBeats: [{ id: 'beat-01', mustShow: [] }] } }),
  /未声明角色|旁白声部/)
})
