import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryboardRepairSuffix, collectHistoricalStoryboardDiagnostics, storyboardDialogueScheduleHint, storyboardSegmentCompletionCriteria, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { chantScene, chantShot } from './fixtures/duration-v2-chant.ts'

test('v2 source coverage repairs complete the actual scope without prescribing the forbidden legacy clock', () => {
  const candidate = chantShot()
  const diagnostic = 'STORYBOARD_COVERAGE_INCOMPLETE: coveredBeatIds 必须完整覆盖当前分段已分配的 sourceBeatIds；期望 [beat-01,beat-02,beat-03]，实际 [beat-01]，缺失 [beat-02,beat-03]'
  const suffix = buildStoryboardRepairSuffix(diagnostic, candidate, '修复全部问题')
  assert.match(suffix, /pacing\.beats 中真正编排/)
  assert.match(suffix, /不能只补 ID/)
  assert.match(suffix, /本次返回完整/)
  assert.doesNotMatch(suffix, /重算pacing\.actionSeconds|同步重算 speech\/action\/reaction/)
  const mixed = buildStoryboardRepairSuffix(diagnostic + '\nSTORYBOARD_PACING_INVALID: 声部预算低于共享策略', candidate, '全部')
  assert.match(mixed, /源剧情覆盖缺失/)
  assert.match(mixed, /各声部 deliveryStyle/)
  assert.match(mixed, /不要增加旧 actionSeconds/)
  assert.doesNotMatch(mixed, /重算pacing\.actionSeconds/)
})

test('v2 timing advice retains the scoped diagnosis instead of deriving a different candidate-only failure', () => {
  const candidate = chantShot()
  candidate.pacing.beats[0].performanceInstruction = ''
  const message = 'STORYBOARD_COVERAGE_INCOMPLETE: coveredBeatIds 缺失 beat-02、beat-03'
  const hint = storyboardDialogueScheduleHint(candidate, 4.5, message)
  assert.ok(hint.includes(message))
  assert.doesNotMatch(hint, /performanceInstruction 须为|timingEstimate|selectedDuration/)
})

test('v2 mixed audio repair preserves original narration and in-picture chant through complete segments', () => {
  const suffix = buildStoryboardRepairSuffix('STORYBOARD_PACING_INVALID: 对白轨不能将声部伪装为画外旁白', chantShot(), '修复')
  assert.match(suffix, /每个分段仅有一个 audioType/)
  assert.match(suffix, /覆盖全部原节拍的完整/)
  assert.match(suffix, /不能把唱谣改成旁白/)
  assert.match(suffix, /旁白段 audioType=旁白/)
  assert.match(suffix, /唱谣段 audioType=对白/)
  assert.doesNotMatch(suffix, /同步重算pacing\.actionSeconds/)
})

test('v2 split repair resolves an offscreen reveal without demanding a duplicate entrance', () => {
  const diagnostic = [
    'STORYBOARD_CONTINUITY_INVALID: 反打不等于离场，前镜 seg-1 在场 presentCharacters=["骞硕","饥民甲"]；本镜 seg-2 enteringCharacters=["饥民甲"]；expected=["骞硕","饥民甲","饥民甲"]；actual=["骞硕","饥民甲"]',
    'STORYBOARD_PROMPT_OVERLOAD: 入场人物“饥民甲”的路径“从画面左侧前方人群中走向骞硕”匹配 0 个可执行入场动作，必须唯一匹配',
  ].join('\n')
  const suffix = buildStoryboardRepairSuffix(diagnostic, { segments: [chantShot(), chantShot()] }, '修复', 'duration-v2')
  assert.match(suffix, /画外人物显露不是再次入场/)
  assert.match(suffix, /从本段 enteringCharacters 删除该人物/)
  assert.match(suffix, /continuity\.mode=coverage_cut/)
  assert.match(suffix, /initialCharacters、presentCharacters 与 worldState 保留该人物/)
  assert.match(suffix, /“走向”另一人的动作继续作为普通 kind=action 保留/)
  assert.doesNotMatch(suffix, /保留该声明的完整 path/)
  assert.match(suffix, /不得改写前段、删除人物或改成 tail_continuation/)
})

test('empty optional performance instructions normalize without changing authored actions or accepting empty required text', () => {
  const candidate = chantShot()
  for (const beat of candidate.pacing.beats) beat.performanceInstruction = '  '
  const before = structuredClone(candidate)
  const output = validateHistoricalStructuredOutput('history.storyboard', candidate, { scene: chantScene, pacingVersion: 'duration-v2' }) as ReturnType<typeof chantShot>
  assert.deepEqual(candidate, before)
  assert.equal(output.audioText, candidate.audioText)
  assert.deepEqual(output.pacing.beats.map(beat => beat.textOrVocalization), candidate.pacing.beats.map(beat => beat.textOrVocalization))
  assert.ok(output.pacing.beats.every(beat => beat.performanceInstruction === undefined))
  candidate.pacing.beats[0].textOrVocalization = ''
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', candidate, { scene: chantScene }), /textOrVocalization/)
})

test('large split repair baselines stay complete JSON with the last assigned beat retained', () => {
  const segments = Array.from({ length: 3 }, (_, i) => ({ ...chantShot(), id: `part-${i + 1}`, title: '长分段'.repeat(2500) }))
  assert.ok(JSON.stringify({ segments }).length > 20_000)
  const prompt = buildStoryboardRepairSuffix('STORYBOARD_COVERAGE_INCOMPLETE: 缺失原节拍', { segments }, '修复')
  const baseline = JSON.parse(prompt.split('【上一版未通过的 JSON；请在此基础上修正并返回完整结果】\n').at(-1)!)
  assert.deepEqual(baseline.segments, segments)
})

test('partition completion criteria come only from allocated original visual and audio obligations', () => {
  const beat = { mustShow: ['乡人驻足', '原歌谣'], observable: { visual: ['乡人驻足'], audio: ['原歌谣'] } }
  assert.deepEqual(storyboardSegmentCompletionCriteria([beat]), ['画面呈现：乡人驻足', '完整听到：原歌谣'])
  assert.deepEqual(storyboardSegmentCompletionCriteria([{ mustShow: ['未区分声画的原锚点'] }]), ['原锚点已呈现：未区分声画的原锚点'])
})

test('expected v2 policy controls repairs even when the rejected draft uses a legacy or missing clock', () => {
  for (const candidate of [{}, { pacing: { version: 'dynamic-v1' } }]) {
    const suffix = buildStoryboardRepairSuffix('STORYBOARD_PACING_INVALID: 缺少正确 pacing', candidate, '修复', 'duration-v2')
    assert.match(suffix, /不要增加旧 actionSeconds/)
    assert.doesNotMatch(suffix, /同步重算pacing\.actionSeconds/)
  }
})

test('invalid split envelopes report their structure error without assigning the whole scene to each part', () => {
  const errors = collectHistoricalStoryboardDiagnostics({ id: 'invalid-wrapper', segments: [chantShot(), chantShot()] }, { scene: chantScene, pacingVersion: 'duration-v2' })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /split 包含未声明字段/)
  assert.doesNotMatch(errors.join('\n'), /coveredBeatIds|sourceBeatIds/)
})

test('complete allocated beats preserve their original performance while partial beats do not repeat the whole action', () => {
  const beat = { id: 'b1', description: '乡人驻足，开始传唱原歌谣', mustShow: ['乡人驻足'], observable: { visual: ['乡人驻足'], audio: ['原歌谣'] } }
  assert.ok(storyboardSegmentCompletionCriteria([beat], [beat]).includes('原节拍表演：' + beat.description))
  const partial = { ...beat, observable: { visual: [], audio: ['原歌谣'] }, mustShow: [] }
  assert.deepEqual(storyboardSegmentCompletionCriteria([partial], [beat]), ['完整听到：原歌谣'])
})

test('v2 diagnostics reveal all speech budgets and independent world-state failures in the same repair', () => {
  const shot = chantShot()
  shot.pacing.beats[1].durationEstimate = { lower: 1, expected: 1, upper: 1, source: '错误估计', confidence: 'low' }
  const secondVoice = structuredClone(shot.pacing.beats[1])
  secondVoice.id = 'second-voice'
  shot.pacing.beats.push(secondVoice)
  const candidate = { ...shot, contentContractVersion: 'cinematic-v1', continuity: { ...shot.continuity, mode: 'scene_cut' },
    worldState: { settingId: 'street', characters: [] } }
  const before = structuredClone(candidate)
  const errors = collectHistoricalStoryboardDiagnostics(candidate, { scene: chantScene, pacingVersion: 'duration-v2' }).join('\n')
  assert.match(errors, /lead-song 声部预算低于/)
  assert.match(errors, /second-voice 声部预算低于/)
  assert.match(errors, /STORYBOARD_WORLD_STATE_INVALID:/)
  assert.deepEqual(candidate, before)
})

test('v2 actor-group errors explain identity references instead of giving only timing arithmetic', () => {
  const suffix = buildStoryboardRepairSuffix('STORYBOARD_PACING_INVALID: actorGroups 标识不能重复或冒用角色身份', chantShot(), '修复')
  assert.match(suffix, /id 只用于 pacing\.beats\.actorIds/)
  assert.match(suffix, /不能放进 characters、presentCharacters/)
  assert.match(suffix, /不把已有身份重命名/)
})

test('a bad early speech budget cannot conceal incompatible tracks under the brisk narration policy', () => {
  const shot = chantShot()
  const narration = structuredClone(shot.pacing.beats[1])
  narration.id = 'long-narration'
  narration.deliveryStyle = 'narration'
  narration.actorIds = ['旁白']
  narration.textOrVocalization = '旁白需要完整介绍先前已经批准的背景事实，保留原来全部信息，不省略任何关键人物和先后发生的行动。'
  narration.durationEstimate = { lower: 1, expected: 1, upper: 1, source: '错误估计', confidence: 'low' }
  shot.pacing.beats.unshift(narration)
  const errors = collectHistoricalStoryboardDiagnostics(shot, { scene: chantScene, pacingVersion: 'duration-v2' }).join('\n')
  assert.match(errors, /long-narration 声部预算低于/)
  assert.match(errors, /当前单段同时编排 narration/)
  assert.doesNotMatch(errors, /STORYBOARD_TIMING_OVERFLOW:/)
})
