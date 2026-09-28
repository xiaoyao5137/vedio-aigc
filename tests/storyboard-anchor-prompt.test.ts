import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildStoryboardRepairSuffix, collectHistoricalStoryboardDiagnostics, validateStoryboardBeatCoverage } from '../src/workflow-core.ts'
import { generateHistoricalStoryboard } from '../src/storyboard-runtime.ts'
import { compileDurationSchedule } from '../src/duration-schedule.ts'
import { chantScene, chantShot } from './fixtures/duration-v2-chant.ts'

// Source and action excerpts from record-d2l7fp, generation 20. The approved
// short/expanded anchors describe one action; neither declaration is rewritten.
const scene = { id: 'scene-01', cast: ['周氏门生', '房氏宾客'], closesUnit: false, requiredBeats: [{
  id: 'beat-01', setting: '甘陵街市', mustShow: ['两人相遇', '复述歌谣', '街市'],
  observable: { visual: ['两人在街市相遇', '房氏宾客向他人复述'], audio: ['天下规矩房伯武,因师获印周仲进'] },
}] }
const candidate = { pacing: { version: 'duration-v2', beats: [{ id: 'beat-001-05', sourceBeatId: 'beat-01',
  actorIds: ['周氏门生', '房氏宾客'], kind: 'action',
  textOrVocalization: '两人在街市相遇,周氏门生与房氏宾客面对面近距离站立',
  completion: { finalState: '两人在街市相遇,面对面站位关系建立', evidenceAnchor: '两人在街市相遇' },
}] }, beatDramaturgy: [{ beatId: 'beat-01', visual: ['两人在街市相遇', '房氏宾客向他人复述'] }] }
const error = 'STORYBOARD_COVERAGE_INCOMPLETE: 原节拍 beat-01 的可执行正文缺少原锚点 两人相遇；不能只在完成声明中声称覆盖'
const live = JSON.parse(readFileSync(new URL('./fixtures/storyboard-d2l7fp-generation-20.json', import.meta.url), 'utf8'))

test('duration repair distinguishes preserved declarations from bounded executable refinements without editing the rejected candidate', () => {
  const before = structuredClone(candidate)
  const prompt = buildStoryboardRepairSuffix(error, candidate, '本轮定点修复', 'duration-v2')
  const instruction = prompt.split('【定点修复要求】')[1].split('【上一版未通过的 JSON')[0]
  assert.match(instruction, /声明层保留已批准原锚点/)
  assert.match(instruction, /同一 kind=action 的 actorIds 恰为这两名角色/)
  assert.match(instruction, /保留动作谓词原字、主体身份与对象，不换动作同义词/)
  assert.match(instruction, /批准场地或同节拍来源原文已有的地点\/持物修饰/)
  assert.match(instruction, /mustShow 与 observable\.visual.*共同满足，无需再演一次或堆砌短句/)
  assert.match(instruction, /未被上述有限规则识别的复合锚点仍须连续原文/)
  assert.match(instruction, /否定、计划、回忆、旁观、命令和完成声明都不能代替当场动作/)
  assert.match(instruction, /仅放在 completion\.evidenceAnchor\/finalState.*不会进入程序编译的动作正文/)
  assert.doesNotMatch(instruction, /原锚点必须作为连续原文/)
  assert.ok(prompt.includes(error), 'retain the actual rejection instead of replacing it with a success claim')
  assert.ok(prompt.endsWith(JSON.stringify(candidate)), 'repair receives the unchanged authored candidate')
  assert.deepEqual(candidate, before)
})

test('the canonical execution rule reaches initial, repair and repeated requests after stale saved wording', async () => {
  const saved = '旧保存模板：所有原声画锚点必须在 textOrVocalization/performanceInstruction/evidenceAnchor 中原样出现；actorIds 用全名。'
  const before = structuredClone(scene), prompts: string[] = []
  await assert.rejects(generateHistoricalStoryboard({ prompt: saved,
    expected: { scene, pacingVersion: 'duration-v2', maxGenerationAttempts: 3 },
    generate: async prompt => { prompts.push(prompt); return {} },
  }))
  assert.equal(prompts.length, 3)
  assert.match(prompts[2], /相同缺陷已连续出现/)
  for (const prompt of prompts) {
    assert.ok(prompt.startsWith(saved))
    const canonical = prompt.slice(prompt.lastIndexOf('【声画锚点执行契约】'))
    assert.match(canonical, /声明层保留已批准 requiredBeats 原锚点/)
    assert.match(canonical, /不把“两人\/二人\/双方”填入 actorIds 或人物名单；已批准原锚点中的代称不因此改写/)
    assert.match(canonical, /同一 kind=action 的 actorIds 恰为这两名角色/)
    assert.match(canonical, /动作谓词保留原字，主体身份与对象不变/)
    assert.match(canonical, /未知或未被上述有限规则识别的复合锚点仍须连续原文，不允许任意同义改写/)
    assert.match(canonical, /旧模板把 evidenceAnchor 与动作正文并列的概括，以本条为准/)
    assert.match(canonical, /台词、说话人和声部仍按原契约保留/)
    assert.ok(prompt.includes(JSON.stringify(scene.requiredBeats)))
  }
  assert.deepEqual(scene, before)
})

test('duration guidance does not widen legacy repair or silently approve an unknown compound anchor', async () => {
  const legacy = buildStoryboardRepairSuffix(error, {}, '旧版修复', 'dynamic-v1')
  assert.doesNotMatch(legacy, /双主体互动|声明层保留已批准原锚点/)
  const current = chantShot(), before = structuredClone(current)
  const source = { ...chantScene, requiredBeats: chantScene.requiredBeats.map(beat => ({ ...beat,
    mustShow: ['相遇之后交还书简并约定明日来访'],
  })) }
  assert.throws(() => compileDurationSchedule(current, { scene: source }), /可执行正文缺少原锚点.*相遇之后交还书简并约定明日来访/)
  assert.deepEqual(current, before)
  const prompts: string[] = []
  await assert.rejects(generateHistoricalStoryboard({ prompt: '旧版请求',
    expected: { scene, pacingVersion: 'dynamic-v1', maxGenerationAttempts: 1 },
    generate: async prompt => { prompts.push(prompt); return {} },
  }))
  assert.doesNotMatch(prompts[0], /【声画锚点执行契约】/)
})

test('the actual rejected candidate reports its unexecuted entrance path alongside an independent coverage failure without altering it', () => {
  const current = structuredClone(live.candidate), before = structuredClone(current)
  const source = structuredClone(live.scene)
  source.requiredBeats[0].mustShow.push('刻有绳纹的竹匣')
  const sourceBefore = structuredClone(source)
  const errors = collectHistoricalStoryboardDiagnostics(current, { scene: source, pacingVersion: 'duration-v2' })
  assert.ok(errors.some(error => /可执行正文缺少原锚点.*刻有绳纹的竹匣/.test(error)))
  const entrance = errors.filter(error => /入场人物.*路径.*匹配/.test(error))
  assert.equal(entrance.length, 1)
  assert.match(entrance[0], /从街市东端沿青石板路走入画面.*匹配 0 个可执行入场动作/)
  assert.match(entrance[0], /"source":"enteringCharacters\[0\]\.path"/)
  assert.match(entrance[0], /"field":"pacing\.beats\[0\]"/)
  assert.match(entrance[0], /"actorIds":\["周氏门生"\]/)
  assert.match(entrance[0], /从街市东端沿青石板路走来/)
  assert.match(entrance[0], /不使用尚未编译的时间窗口/)
  assert.doesNotMatch(entrance[0], /必须在 \d.*秒|窗口缺口/)
  const repair = buildStoryboardRepairSuffix(errors.join('\n'), current, '同时修复全部问题', 'duration-v2')
  assert.match(repair, /保留该声明的完整 path.*actorIds 绑定该入场人物/)
  assert.match(repair, /不能缩短或改写 path 来迁就缺失动作/)
  assert.match(repair, /先修复动作、完整路径和原有依赖，再由程序统一投影 startSecond\/endSecond/)
  assert.deepEqual(current, before)
  assert.deepEqual(source, sourceBefore)
})

test('raw entrance diagnostics remain conditional on known shapes and do not treat plans or duplicate actions as unique entry', () => {
  for (const malformed of [null, {}, [{ kind: 'action', actorIds: null, textOrVocalization: '入画' }]]) {
    const current = structuredClone(live.candidate)
    current.pacing.beats = malformed
    const errors = collectHistoricalStoryboardDiagnostics(current, { scene: live.scene, pacingVersion: 'duration-v2' })
    assert.ok(errors.length > 0)
    assert.ok(errors.every(error => !error.includes('原候选定位=')), 'unknown shapes retain their actual schema error')
  }
  const current = structuredClone(live.candidate)
  const path = current.enteringCharacters[0].path
  current.pacing.beats[0].textOrVocalization = `周氏门生${path}`
  let errors = collectHistoricalStoryboardDiagnostics(current, { scene: live.scene, pacingVersion: 'duration-v2' })
  assert.ok(errors.every(error => !/入场人物.*路径.*匹配/.test(error)), 'a unique performed exact path needs no guessed-window repair')
  current.pacing.beats[0].textOrVocalization = `周氏门生准备${path}`
  errors = collectHistoricalStoryboardDiagnostics(current, { scene: live.scene, pacingVersion: 'duration-v2' })
  assert.ok(errors.some(error => /入场人物.*匹配 0 个可执行入场动作/.test(error)))
  current.pacing.beats[0].textOrVocalization = `周氏门生${path}`
  current.pacing.beats.push({ ...current.pacing.beats[0], id: 'duplicate-entry' })
  errors = collectHistoricalStoryboardDiagnostics(current, { scene: live.scene, pacingVersion: 'duration-v2' })
  assert.ok(errors.some(error => /入场人物.*匹配 2 个可执行入场动作/.test(error)))
})

test('the duration coverage gate uses strict executable proof instead of a second static substring gate', () => {
  const current = chantShot(), before = structuredClone(current)
  assert.equal(current.videoPrompt, '')
  assert.doesNotThrow(() => validateStoryboardBeatCoverage(current, chantScene))
  assert.deepEqual(current, before)
  const malformed = { ...current, pacing: { ...current.pacing, beats: [] } }
  assert.throws(() => validateStoryboardBeatCoverage(malformed, chantScene), /STORYBOARD_/)
  assert.throws(() => validateStoryboardBeatCoverage({ ...current, coveredBeatIds: [] }, chantScene), /必须按顺序完整覆盖剧情节拍/)
  const missing = { ...current, pacing: { ...current.pacing, beats: current.pacing.beats.filter(beat => beat.id !== 'crowd-response') },
    visualPrompt: '围观乡人点头', videoPrompt: '0-9秒：围观乡人点头。', lastFramePrompt: '围观乡人点头' }
  assert.throws(() => validateStoryboardBeatCoverage(missing, chantScene), /可执行正文缺少原锚点.*围观乡人点头/)
})
