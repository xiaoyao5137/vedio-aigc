import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  HISTORY_DRAMA_VERSION, normalizeDramaOutline, validateDramaOutline, validateDramaStoryboard,
  storyboardDramaContext, validateDramaStoryboardAllocation, partitionDramaBeat, validateExpandedDramaOutline,
} from '../src/history-drama.ts'
import { SANGUO_SCENE_OUTLINE_PROMPT } from '../src/scene-outline-prompt.ts'
import { sceneFromStoryboardSegment } from '../src/storyboard-runtime.ts'
import { validateHistoricalProductionPlan } from '../src/history-content-guards.ts'

type Value = ReturnType<typeof JSON.parse>
const original = JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json', import.meta.url), 'utf8')) as Value
const fixture = () => structuredClone(original)
const expected = { requireDramaContract: true, input: { adaptation_policy: original.adaptationSpace.policy, source_level: '正史' }, historicalSources: { citations: [{ index: 1, id: 'source-1', content: '实际源正文' }] } }
function shotFor(scene: Value): Value {
  return {
    id: scene.id, duration: scene.targetDuration, coveredBeatIds: scene.requiredBeats.map((beat: Value) => beat.id), contentContractVersion: HISTORY_DRAMA_VERSION, dramaticSceneId: scene.dramaticSceneId,
    characters: [...scene.cast], shotIntent: { viewpointCharacter: scene.cast[0], purpose: scene.purpose, cameraReason: '在回应处观察听者是否继续交谈' },
    beatDramaturgy: scene.requiredBeats.map((beat: Value) => ({ beatId: beat.id, function: beat.function, stateChange: beat.stateChange, ...structuredClone(beat.observable) })),
    visualPrompt: '两人保持各自位置', videoPrompt: scene.requiredBeats.flatMap((beat: Value) => beat.observable.visual).join('。'),
    audioText: scene.requiredBeats.flatMap((beat: Value) => beat.observable.audio).join('。'),
    lastFramePrompt: '人物动作完成后的尾帧',
  }
}

test('historical tableau accepts a concrete frozen-frame cue without character-illustration wording', () => {
  const source = fixture().scenes[0]
  const scene = {
    ...source,
    cast: [],
    editorialRole: 'episode_opening',
    visualTreatment: 'animated',
    animationStyle: 'historical_tableau',
    animationAesthetic: 'cinematic_gongbi',
    requiredBeats: [{
      id: 'beat-tableau',
      function: '建立背景',
      stateChange: '观众知道饥疫困境',
      observable: { visual: ['历史场景定格画呈现饥民困境'], audio: ['天下饥疫，百姓困苦无依'] },
    }],
  }
  const shot = {
    ...shotFor(scene),
    editorialRole: scene.editorialRole,
    visualTreatment: scene.visualTreatment,
    animationStyle: scene.animationStyle,
    animationAesthetic: scene.animationAesthetic,
    audioType: '旁白',
    camera: '固定机位',
    shotIntent: { viewpointCharacter: '观众', purpose: '建立背景', cameraReason: '保持史料画面可读' },
    visualPrompt: '历史场景定格画呈现饥民困境',
    videoPrompt: '0-7秒：历史场景定格画呈现饥民困境，画面保持静止',
    audioText: '天下饥疫，百姓困苦无依',
    lastFramePrompt: '历史场景定格画保持不变',
  }
  assert.doesNotThrow(() => validateDramaStoryboard(shot, scene))
  assert.throws(() => validateDramaStoryboard({ ...shot, videoPrompt: '0-7秒：饥民在画面中走动' }, scene), /不得生成/)
  assert.doesNotThrow(() => validateDramaStoryboard({ ...shot, camera: '二维插画编排，无实拍机位',
    videoPrompt: '0-7秒：饥民困境的定格构图淡入，整幅画轻微缩放' }, scene))
  assert.doesNotThrow(() => validateDramaStoryboard({
    ...shot,
    videoPrompt: '0.0-5.5秒：历史场景定格画呈现饥民困境，画中人物与物件保持定格。\n5.5-7.0秒：整幅画保持静止。',
  }, scene))
})

test('generic empty-cast performers remain live action without inventing named roles', () => {
  const candidate = fixture()
  candidate.scenes[0] = {
    ...candidate.scenes[0],
    editorialRole: 'story',
    visualTreatment: 'live_action',
    animationStyle: null,
    animationAesthetic: null,
    cast: [],
    purpose: '展现消息在村中传播',
    requiredBeats: [{
      id: 'beat-generic-crowd',
      description: '村民三五成群聚集交谈',
      function: '后果呈现与扩散',
      stateChange: '消息传播至更多村民',
      observable: { visual: ['村民在街巷聚集', '互相交谈传告'], audio: [] },
      setting: '村中街巷',
      mustShow: ['村民在街巷聚集', '互相交谈传告'],
    }],
  }
  const normalized = normalizeDramaOutline(candidate) as Value
  assert.equal(normalized.scenes[0].visualTreatment, 'live_action')
  assert.equal(normalized.scenes[0].animationStyle, undefined)
  assert.equal(normalized.scenes[0].animationAesthetic, undefined)
  assert.deepEqual(normalized.scenes[0].cast, [])

  candidate.scenes[0].requiredBeats[0].observable.visual = [`${candidate.characterDramas[0].name}走入街巷`]
  candidate.scenes[0].requiredBeats[0].mustShow = [`${candidate.characterDramas[0].name}走入街巷`]
  const named = normalizeDramaOutline(candidate) as Value
  assert.equal(named.scenes[0].visualTreatment, 'live_action')
})

test('anonymous disciple scene drops an unrelated identity but remains real-person live action', () => {
  const candidate = fixture()
  candidate.scenes[0] = {
    ...candidate.scenes[0],
    id: 'scene-11',
    editorialRole: 'story',
    visualTreatment: 'live_action',
    cast: [candidate.characterDramas[0].name],
    purpose: '展现弟子在各地以符水治病的场景',
    requiredBeats: [{
      id: 'beat-12',
      description: '村落空地上，一名弟子为病患施符水，周围百姓围观',
      function: '展现弟子在各地的治病活动',
      stateChange: '观众看到弟子复制治病方法',
      observable: { visual: ['村落空地上一名弟子为病患施符水', '周围百姓围观'], audio: [] },
      setting: '各地村落与道路',
      mustShow: ['村落空地上一名弟子为病患施符水', '周围百姓围观'],
    }],
  }
  const normalized = normalizeDramaOutline(candidate) as Value
  assert.deepEqual(normalized.scenes[0].cast, [])
  assert.equal(normalized.scenes[0].visualTreatment, 'live_action')
  assert.equal(normalized.scenes[0].animationStyle, undefined)
  assert.equal(normalized.scenes[0].animationAesthetic, undefined)
  assert.doesNotThrow(() => validateHistoricalProductionPlan(normalized))
})

test('anonymous crowd illustrations are projected to real-person live action', () => {
  const candidate = fixture()
  candidate.scenes[0] = {
    ...candidate.scenes[0],
    editorialRole: 'payoff',
    visualTreatment: 'animated',
    animationStyle: 'character_illustration',
    animationAesthetic: 'cinematic_gongbi',
    cast: [],
    purpose: '呈现信众人数不断增加',
    requiredBeats: [{
      id: 'beat-anonymous-crowd',
      description: '大量百姓剪影由疏至密渐次出现',
      function: '人数规模可见化',
      stateChange: '从少量信众变为大量信众',
      observable: { visual: ['大量百姓剪影由疏至密渐次出现'], audio: ['众徒数十万'] },
      setting: '动画历史成果呈现空间',
      mustShow: ['大量百姓剪影由疏至密渐次出现'],
    }],
  }
  const normalized = normalizeDramaOutline(candidate) as Value
  assert.equal(normalized.scenes[0].visualTreatment, 'live_action')
  assert.equal(normalized.scenes[0].animationStyle, undefined)
  assert.deepEqual(normalized.scenes[0].cast, [])
  assert.doesNotThrow(() => validateHistoricalProductionPlan(normalized))

  candidate.scenes[0].requiredBeats[0].observable.visual = [`${candidate.characterDramas[0].name}人物插画淡入`]
  candidate.scenes[0].requiredBeats[0].mustShow = [`${candidate.characterDramas[0].name}人物插画淡入`]
  const named = normalizeDramaOutline(candidate) as Value
  assert.equal(named.scenes[0].visualTreatment, 'live_action')
  assert.equal(named.scenes[0].animationStyle, undefined)
  assert.deepEqual(named.scenes[0].cast, [candidate.characterDramas[0].name])
  assert.doesNotThrow(() => validateHistoricalProductionPlan(named))
})

test('a named static portrait is projected to a live-action identity-bound shot', () => {
  const candidate = fixture()
  const name = candidate.characterDramas[0].name
  candidate.scenes = [{
    ...candidate.scenes[0],
    dramaticSceneId: 'drama-portrait-payoff',
    editorialRole: 'payoff',
    visualTreatment: 'animated',
    animationStyle: 'character_illustration',
    animationAesthetic: 'cinematic_gongbi',
    cast: [],
    requiredBeats: [{
      id: 'beat-portrait-payoff',
      description: `${name}人物插画淡入`,
      function: '回应开场人物线索',
      stateChange: '观众重新识别核心人物',
      observable: { visual: [`${name}人物插画淡入`], audio: ['旁白总结人物影响'] },
      setting: '历史地图回溯空间',
      mustShow: [`${name}人物插画淡入`],
    }],
  }]
  candidate.dramaticScenes = [{
    id: 'drama-portrait-payoff', function: 'consequence', setting: '历史地图回溯空间', characters: [],
    goal: '回应人物线索', obstacle: '无', tactics: '静态人物图层淡入', turn: '人物影响得到总结', result: '观众识别人物影响',
    beatIds: ['beat-portrait-payoff'], characterStates: [],
  }]
  const normalized = normalizeDramaOutline(candidate, { deriveInheritedStates: true }) as Value
  assert.equal(normalized.scenes[0].visualTreatment, 'live_action')
  assert.equal(normalized.scenes[0].animationStyle, undefined)
  assert.deepEqual(normalized.scenes[0].cast, [name])
  assert.deepEqual(normalized.dramaticScenes[0].characters, [name])
  assert.deepEqual(normalized.dramaticScenes[0].characterStates, [], 'normalization does not invent a live-action state change')
  assert.doesNotThrow(() => validateHistoricalProductionPlan(normalized))
})

test('opening, context, or payoff historical maps retain the animated route', () => {
  const candidate = fixture()
  candidate.scenes[0] = { ...candidate.scenes[0], editorialRole: 'episode_opening', visualTreatment: 'animated',
    animationStyle: 'historical_map', animationAesthetic: 'cinematic_gongbi', cast: [] }
  const sandTable = normalizeDramaOutline(candidate) as Value
  assert.equal(sandTable.scenes[0].visualTreatment, 'animated')
  assert.equal(sandTable.scenes[0].animationStyle, 'historical_map')

  candidate.scenes[0] = { ...candidate.scenes[0], editorialRole: 'payoff' }
  const payoffMap = normalizeDramaOutline(candidate) as Value
  assert.equal(payoffMap.scenes[0].visualTreatment, 'animated')
  assert.equal(payoffMap.scenes[0].animationStyle, 'historical_map')

  candidate.scenes[0] = { ...candidate.scenes[0], editorialRole: 'story' }
  const storyMap = normalizeDramaOutline(candidate) as Value
  assert.equal(storyMap.scenes[0].visualTreatment, 'live_action')
  assert.equal(storyMap.scenes[0].animationStyle, undefined)
})

test('a historical map can carry a named static portrait only as a validated postproduction layer', () => {
  const source = fixture().scenes[0]
  const scene = { ...source, editorialRole: 'episode_opening', visualTreatment: 'animated', animationStyle: 'historical_map',
    animationAesthetic: 'historical_cartography', cast: ['周家宾客'], requiredBeats: [{
      id: 'beat-map', function: '建立地理语境', stateChange: '观众理解两地关系',
      observable: { visual: ['两地山川道路和行进路线呈现'], audio: ['两地相距不远，局势迫近。'] },
      setting: '东汉历史地理地图', mustShow: ['两地山川道路和行进路线呈现'],
    }] }
  const layer = { characterName: '周家宾客', x: .72, y: .5, scale: .24, enterStart: .2, enterDuration: .5,
    enterFromX: .78, enterFromY: .5, exitStart: 7.2, exitDuration: .5 }
  const shot = { ...shotFor(scene), editorialRole: scene.editorialRole, visualTreatment: scene.visualTreatment,
    animationStyle: scene.animationStyle, animationAesthetic: scene.animationAesthetic,
    characters: ['周家宾客'], presentCharacters: ['周家宾客'], initialCharacters: [], enteringCharacters: [],
    illustrationLayers: [layer], shotIntent: { viewpointCharacter: '观众', purpose: '建立地理语境', cameraReason: '保持地图关系可读' },
    visualPrompt: '两地山川道路和行进路线呈现，古代历史地理底图没有人物。',
    videoPrompt: '0-8秒：两地山川道路和行进路线呈现，地图底图变化。',
    lastFramePrompt: '两地山川道路和行进路线呈现后的同一地理底图，没有人物。',
    audioType: '旁白', audioText: '两地相距不远，局势迫近。', camera: '固定俯视地图' }
  assert.doesNotThrow(() => validateDramaStoryboard(shot, scene))
  const historicalMapScene = { ...scene, historicalBasis: '[史料2] 曹军追及当阳长阪' }
  const mapAnnotations = { version: 'historical-map-annotations-v1', orientation: 'north-up', sourceRefs: ['[史料2]'],
    labels: [{ text: '当阳长坂', x: .55, y: .5, sourceRef: '[史料2]' }],
    routes: [
      { id: 'liu', party: '刘备', direction: 'south', color: 'blue', points: [{ x: .4, y: .55 }, { x: .4, y: .75 }], startSecond: 0, endSecond: 8, sourceRef: '[史料2]' },
      { id: 'cao', party: '曹军', direction: 'south', color: 'red', points: [{ x: .45, y: .2 }, { x: .45, y: .45 }], startSecond: 0, endSecond: 8, sourceRef: '[史料2]' },
    ],
    relations: [{ type: 'follows', leaderRouteId: 'liu', followerRouteId: 'cao', direction: 'south' }],
  }
  assert.doesNotThrow(() => validateDramaStoryboard({ ...shot, mapAnnotations }, historicalMapScene))
  assert.throws(() => validateDramaStoryboard({ ...shot, mapAnnotations: { ...mapAnnotations, routes: [] } },
    { ...historicalMapScene, requiredBeats: [{ ...historicalMapScene.requiredBeats[0],
      observable: { visual: ['曹军向南追近刘备南撤路线'], audio: ['曹军追近刘备。'] } }] }), /routes 不能为空/)
  assert.throws(() => validateDramaStoryboard({ ...shot, mapAnnotations: { ...mapAnnotations,
    routes: [mapAnnotations.routes[0], { ...mapAnnotations.routes[1], points: [{ x: .45, y: .45 }, { x: .45, y: .2 }] }],
  } }, historicalMapScene), /推进方向/)
  assert.throws(() => validateDramaStoryboard({ ...shot, mapAnnotations: { ...mapAnnotations,
    labels: [{ ...mapAnnotations.labels[0], sourceRef: '[史料9]' }],
  } }, historicalMapScene), /sourceRefs/)
  assert.throws(() => validateDramaStoryboard({ ...shot, illustrationLayers: [] }, scene), /肖像图层|illustrationLayers/)
  assert.throws(() => validateDramaStoryboard({ ...shot, illustrationLayers: [{ ...layer, characterName: '房家宾客' }] }, scene), /一一对应/)
  assert.throws(() => validateDramaStoryboard({ ...shot, initialCharacters: ['周家宾客'] }, scene), /底片人物|真人入场/)
  assert.throws(() => validateDramaStoryboard({ ...shot, audioType: '对白' }, scene), /画外旁白/)
  for (const field of ['visualPrompt', 'videoPrompt', 'lastFramePrompt'] as const) {
    assert.throws(() => validateDramaStoryboard({ ...shot, [field]: shot[field] + '周家宾客人物画像出现在地图上。' }, scene),
      /底图|肖像|人物画像/)
  }
})

test('outline normalization extends sourced narration to natural speech capacity', () => {
  const candidate = fixture()
  candidate.scenes[0].contextPayload = { narration: '东汉灵帝时期朝政日乱海内虚困天下饥疫百姓流离冀州巨鹿有张角者自称大贤良师以符水咒说为人疗病' }
  candidate.scenes[0].targetDuration = 8
  const normalized = normalizeDramaOutline(candidate) as Value
  assert.equal(normalized.scenes[0].targetDuration, 10)
})

test('complete encounter is split into four short segments while authority, promises and states survive normalization', () => {
  const candidate = fixture()
  candidate.scenes[0].dramaticUnitId = 'model-invented-unit'
  candidate.scenes[0].closesUnit = true
  const result = validateDramaOutline(candidate, expected) as Value
  assert.deepEqual(result.scenes.map((scene: Value) => scene.dramaticUnitId), ['drama-encounter', 'drama-encounter', 'drama-encounter', 'drama-consequence'])
  assert.deepEqual(result.scenes.map((scene: Value) => scene.closesUnit), [false, false, true, true])
  assert.deepEqual(result.scenes.map((scene: Value) => scene.continuityFromPrevious), [false, true, true, false])
  assert.equal(result.scenes[2].continuityMode, 'coverage_cut')
  assert.equal(result.scenes[0].settingId, 'drama-encounter')
  assert.equal(result.scenes[0].contentContractVersion, HISTORY_DRAMA_VERSION)
  assert.equal(candidate.scenes[0].dramaticUnitId, 'model-invented-unit', 'normalization must not mutate the saved candidate')
  assert.deepEqual(result.episodeDrama, original.episodeDrama)
  assert.deepEqual(result.characterDramas, original.characterDramas)
  assert.deepEqual(result.scenes[2].requiredBeats, original.scenes[2].requiredBeats)
})

// Reduced from the real wf-sanguo-history-drama run: scene-01 beat-01 mustShow “传唱动作” and
// observable.visual “百姓整理货物”. “传唱动作” ends in the meta-noun 动作, so a concrete storyboard
// (开口哼唱) can never contain it literally and all three substring coverage checks假失败 on a shot
// that actually filmed everything. The guard forces the outline to name a filmable phrase instead.
test('an anchor that names an abstract category cannot be filmed verbatim and is rejected', () => {
  const mustShowCase = fixture()
  mustShowCase.scenes[0].requiredBeats[0].mustShow = ['周家宾客停步', '传唱动作']
  assert.throws(() => validateDramaOutline(mustShowCase, expected), /抽象概括/)
  const observableCase = fixture()
  observableCase.scenes[0].requiredBeats[0].observable.visual = ['周家宾客停步', '街市画面']
  assert.throws(() => validateDramaOutline(observableCase, expected), /抽象概括/)
  const audioProxyCase = fixture()
  audioProxyCase.scenes[0].requiredBeats[0].mustShow = ['周家宾客停步', '恳求话语']
  audioProxyCase.scenes[0].requiredBeats[0].observable.audio = ['周家宾客：请留步。']
  assert.throws(() => validateDramaOutline(audioProxyCase, expected), error => error instanceof Error
    && /恳求话语/.test(error.message) && /observable\.audio/.test(error.message))
  // Concrete filmable anchors (停步 is a real visible action, not a meta-noun) still pass.
  assert.doesNotThrow(() => validateDramaOutline(fixture(), expected))
})

test('a concrete visible predicate is not rejected only because the phrase ends in 画面', () => {
  const candidate = fixture()
  candidate.scenes[0].requiredBeats[0].mustShow = ['黄巾布料剪影铺满整个画面']
  candidate.scenes[0].requiredBeats[0].observable.visual = ['黄巾布料剪影铺满整个画面']
  assert.doesNotThrow(() => validateDramaOutline(candidate, expected))
})

// record-vrwgoy: each complete scene has to echo the running union of its segments' cast. The writer
// shipped [陈谌,张季] for drama-06 while its segments also film 宾客丙 and 门生丁, and that one
// bookkeeping slip killed an outline whose three other generations had validated cleanly.
// The roster is a projection, so the program derives it; the authored half stays under the same rule.
test('a complete scene acting roster is projected from its segments while characterStates stay authored', () => {
 const drift = fixture()
 drift.dramaticScenes[0].characters = ['周家宾客']
 const result = validateDramaOutline(drift, expected) as Value
 assert.deepEqual(result.dramaticScenes[0].characters, ['周家宾客', '房家宾客'])
 assert.deepEqual(drift.dramaticScenes[0].characters, ['周家宾客'], '规范化不得原地改写候选')
 const missingState = fixture()
 missingState.dramaticScenes[0].characterStates = [missingState.dramaticScenes[0].characterStates[0]]
 assert.throws(() => validateDramaOutline(missingState, expected), /characterStates 必须与场内人物一一对应：缺少 房家宾客[\s\S]*为被点名的缺失人物补写 before\/after/)
 const allStatesMissing = fixture()
 allStatesMissing.dramaticScenes[0].characterStates = []
 assert.throws(() => validateDramaOutline(allStatesMissing, expected), error => error instanceof Error
   && /characterStates 必须与场内人物一一对应：缺少 周家宾客、房家宾客/.test(error.message)
   && /为被点名的缺失人物补写 before\/after/.test(error.message))
 // Someone removed from every segment loses their seat, and the message says to delete that one entry
 // instead of the old “不得删除已有条目”, which left the writer no legal edit at all.
 const dropped = fixture()
 dropped.scenes.forEach((scene: Value) => { if (scene.dramaticSceneId === 'drama-encounter') scene.cast = ['周家宾客'] })
 dropped.dramaticScenes[0].characters = ['周家宾客']
 assert.throws(() => validateDramaOutline(dropped, expected), /不属于本场人物 房家宾客[\s\S]*删除被点名人物的整条 characterStates/)
});

test('invalid editorial roles report the received value and complete allowed enum', () => {
 const invalid = fixture()
 invalid.scenes.forEach((scene: Value, index: number) => {
   scene.editorialRole = index === 0 ? 'episode_opening' : index === invalid.scenes.length - 1 ? 'payoff' : 'story'
   scene.visualTreatment = 'live_action'
 })
 invalid.scenes[1].editorialRole = 'story_action'
 assert.throws(
   () => validateDramaOutline(invalid, { ...expected, requireEditorialGrammar: true }),
   /scenes\[1\]\.editorialRole 无效：收到 "story_action"；仅允许 episode_opening、story、context_bridge、payoff。普通剧情段使用 story，结尾回应开场承诺的段使用 payoff/,
 )
})

test('legacy snapshots remain legacy and cannot satisfy a requested cinematic contract; unknown versions fail closed', () => {
  const legacy = { episodeTitle: '旧稿', scenes: [{ id: 'old' }] }
  assert.deepEqual(validateDramaOutline(legacy), legacy)
  assert.throws(() => validateDramaOutline(legacy, { requireDramaContract: true }), /旧大纲必须重新生成及审核/)
  assert.throws(() => normalizeDramaOutline({ ...legacy, contentContractVersion: 'future-v2' }), /不支持内容契约版本/)
  assert.deepEqual(validateDramaStoryboard({ id: 'old' }, {}), { id: 'old' })
})

test('the exact episode policy and actual numbered sources constrain the writing contract', () => {
  const candidate = fixture()
  assert.doesNotThrow(() => validateDramaOutline(candidate, expected))
  assert.throws(() => validateDramaOutline(candidate, { ...expected, input: { ...expected.input, adaptation_policy: '不可虚构任何对白' } }), /原样继承 input.adaptation_policy/)
  assert.throws(() => validateDramaOutline(candidate, { ...expected, input: { ...expected.input, source_level: '来源有争议' } }), /原样继承 input.source_level/)
  candidate.historicalLocks[0].sourceRefs = ['[史料2]']
  assert.throws(() => validateDramaOutline(candidate, expected), /引用不存在的 \[史料2\]/)
  assert.throws(() => validateDramaOutline(candidate, { ...expected, historicalSources: { citations: [{ index: 1, content: '不能因正文碰巧包含[史料2]就批准伪造来源' }] } }), /引用不存在的 \[史料2\]/)
  candidate.historicalLocks[0].sourceRefs = ['[史料1]']
  assert.doesNotThrow(() => validateDramaOutline(candidate, { ...expected, historicalSources: { citations: [{ id: 'unindexed', content: '按数组位置编号' }] } }))
})

test('typographic-only policy drift is restored from trusted input, never rewritten semantically', () => {
  const candidate = fixture()
  const policy = '史事据史；对白可拟制。'
  const input = { ...expected.input, adaptation_policy: policy }
  candidate.adaptationSpace.policy = '史事据史;对白可拟制'
  candidate.adaptationSpace.sourceLevel = 'A/B|正史直载或多源互证'
  input.source_level = 'A/B｜正史直载或多源互证'
  assert.equal((validateDramaOutline(candidate, { ...expected, input }).adaptationSpace as Value).policy, policy)
  assert.equal((validateDramaOutline(candidate, { ...expected, input }).adaptationSpace as Value).sourceLevel, input.source_level)
  assert.equal(candidate.adaptationSpace.policy, '史事据史;对白可拟制', 'raw candidate remains evidence')
  candidate.adaptationSpace.policy = '史事据史；对白不可拟制。'
  assert.throws(() => validateDramaOutline(candidate, { ...expected, input }), /原样继承 input.adaptation_policy/)
})

test('unknown core motivations cannot be promoted to fictional political motives or unsourced history', () => {
  const candidate = fixture()
  candidate.characterDramas[0].coreMotivation = { status: 'performance', description: '暗中策划政治阴谋', historicalLockIds: [] }
  assert.throws(() => validateDramaOutline(candidate, expected), /未知核心动机不能作为表演拟制编造/)
  candidate.characterDramas[0].coreMotivation.status = 'historical'
  assert.throws(() => validateDramaOutline(candidate, expected), /historicalLockIds 必须是非空数组/)
  candidate.characterDramas[0].coreMotivation.historicalLockIds = ['invented-fact']
  assert.throws(() => validateDramaOutline(candidate, expected), /引用不存在的 invented-fact/)
})

test('real lm6wks first outline reports both motivation errors and all independent scene defects together', () => {
  // Exact authored JSON from model-run-mtt1ag40-igk3erq; only duplicate transport
  // fields were removed. Its second paid generation changed four motivation
  // fields and only then revealed the three pre-existing scene/state errors.
  const candidate = JSON.parse(readFileSync(new URL('./fixtures/scene-outline-lm6wks-first.json', import.meta.url), 'utf8')) as Value
  const before = structuredClone(candidate)
  assert.throws(() => validateDramaOutline(candidate, { requireDramaContract: true }), (error: unknown) => {
    assert.ok(error instanceof Error)
    for (const defect of [
      'characterDramas.房植门生.coreMotivation.status',
      'characterDramas.周福门生.coreMotivation.status',
      'scenes[13].continuityMode',
      'dramaticScenes.drama-01.characterStates',
      'dramaticScenes.drama-02.周福门生.before',
    ]) assert.ok(error.message.includes(defect), defect)
    assert.equal(error.message.split('\n').length, 5)
    return true
  })
  assert.deepEqual(candidate, before)
  assert.equal(candidate.scenes[13].continuityMode, 'scene_cut')
  assert.match(candidate.scenes[13].requiredBeats[0].description, /另一处院落/)
})

test('motivation source-status and unresolved-reference mismatches aggregate while broken containers stay fatal', () => {
  const candidate = fixture()
  candidate.characterDramas[0].coreMotivation = { status: 'historical', description: '未经来源支持的动机', historicalLockIds: [] }
  candidate.characterDramas[1].coreMotivation = { status: 'unknown', description: '来源未说明动机', historicalLockIds: [candidate.historicalLocks[0].id] }
  candidate.scenes[1].continuityMode = 'scene_cut'
  assert.throws(() => validateDramaOutline(candidate, expected), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /coreMotivation.historicalLockIds 必须是非空数组/)
    assert.match(error.message, /未知动机不得伪装为史载事实/)
    assert.match(error.message, /scenes\[1\].continuityMode/)
    return true
  })
  candidate.characterDramas[0].coreMotivation.historicalLockIds = ['invented-fact']
  assert.throws(() => validateDramaOutline(candidate, expected), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /characterDramas\.[^.]+\.coreMotivation.historicalLockIds 引用不存在的 invented-fact/)
    assert.match(error.message, /未知动机不得伪装为史载事实/)
    assert.match(error.message, /continuityMode 与完整戏归属不一致/)
    return true
  })
  candidate.characterDramas[0].coreMotivation = null
  assert.throws(() => validateDramaOutline(candidate, expected), /^Error: HISTORY_DRAMA_INVALID: characterDramas\.[^.]+\.coreMotivation 必须是对象$/)
})

test('references cannot drop the counter-response, duplicate a beat, invent payoff or interrupt a full drama', () => {
  const removed = fixture()
  removed.scenes[1].requiredBeats.pop()
  assert.throws(() => validateDramaOutline(removed, expected), /引用不存在的 beat-counter/)
  const duplicate = fixture()
  duplicate.scenes[2].requiredBeats[0].id = 'beat-probe'
  assert.throws(() => validateDramaOutline(duplicate, expected), /全局重复 id/)
  const payoff = fixture()
  payoff.episodeDrama.payoff.beatIds = ['beat-probe']
  assert.throws(() => validateDramaOutline(payoff, expected), /必须落实在结尾完整戏/)
  const interrupted = fixture()
  interrupted.scenes.splice(1, 0, interrupted.scenes.pop())
  assert.throws(() => validateDramaOutline(interrupted, expected), /被另一场戏打断/)
})

test('same drama cannot cross location or declare a scene cut to bypass unfinished responses', () => {
  const candidate = fixture()
  candidate.scenes[1].requiredBeats[0].setting = '周府书房'
  assert.throws(() => validateDramaOutline(candidate, expected), /唯一空间一致/)
  candidate.scenes[1].requiredBeats[0].setting = '甘陵街口'
  candidate.scenes[1].continuityMode = 'scene_cut'
  assert.throws(() => validateDramaOutline(candidate, expected), /与完整戏归属不一致/)
  const newScene = fixture()
  newScene.scenes[3].continuityMode = 'tail_continuation'
  assert.equal((validateDramaOutline(newScene, expected).scenes as Value[])[3].continuityMode, 'scene_cut', 'authoritative new space cannot reuse the prior scene tail')
  newScene.scenes[3].continuityMode = 'invented-mode'
  assert.throws(() => validateDramaOutline(newScene, expected), /与完整戏归属不一致/)
})

// record-vn75ae reached its fourth writer call before the four abstract anchors were reported:
// earlier rounds stopped at setting/continuity defects in the very same outline.
test('one outline repair receives continuity, setting, all abstract anchors and state defects together', () => {
  const candidate = fixture()
  candidate.scenes[1].continuityMode = 'scene_cut'
  candidate.scenes[1].requiredBeats[1].setting = '周府书房'
  candidate.scenes[0].requiredBeats[0].mustShow = ['追问动作']
  candidate.scenes[1].requiredBeats[0].mustShow = ['逼视动作']
  candidate.scenes[2].requiredBeats[0].mustShow = ['商议神态']
  candidate.scenes[3].requiredBeats[0].observable.visual = ['商议神态']
  candidate.dramaticScenes[1].characterStates[0].before.knowledge.pop()
  candidate.dramaticScenes[1].characterStates[1].after.choices.shift()
  const snapshot = structuredClone(candidate)
  assert.throws(() => validateDramaOutline(candidate, expected), error => {
    assert.ok(error instanceof Error)
    const message = error.message
    assert.match(message, /^HISTORY_DRAMA_INVALID:/)
    for (const fragment of [
      'scenes[1].continuityMode 与完整戏归属不一致',
      'scenes[1].requiredBeats[1].setting',
      'beat-counter.setting 必须与完整戏 drama-encounter 的唯一空间一致',
      'scenes[0].requiredBeats[0].mustShow[0]',
      'scenes[1].requiredBeats[0].mustShow[0]',
      'scenes[2].requiredBeats[0].mustShow[0]',
      'scenes[3].requiredBeats[0].observable.visual[0]',
      '周家宾客.before 丢失或改写前场',
      '房家宾客.after 必须保留已作选择',
      'dramaticScenes[1].characterStates[0].before',
      'dramaticScenes[1].characterStates[1].after.choices',
    ]) assert.ok(message.includes(fragment), fragment)
    assert.equal(message.match(/的声画锚点“/g)?.length, 4)
    return true
  })
  assert.deepEqual(candidate, snapshot, 'reporting every defect must preserve the raw candidate')
})

test('invalid state coverage does not hide anchors or fabricate a later inherited-state mismatch', () => {
  const candidate = fixture()
  candidate.dramaticScenes[0].characterStates[1].name = '没有小传的旁观者'
  candidate.scenes[3].requiredBeats[0].mustShow = ['商议神态']
  assert.throws(() => validateDramaOutline(candidate, expected), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /缺少 房家宾客；不属于本场人物 没有小传的旁观者/)
    assert.match(error.message, /scenes\[3\]\.requiredBeats\[0\]\.mustShow\[0\]/)
    assert.doesNotMatch(error.message, /drama-consequence\.房家宾客\.before|TypeError/)
    return true
  })
})

test('aggregation still stops at malformed containers and unknown scene identities', () => {
  const malformed = fixture()
  malformed.scenes[1].requiredBeats = { id: 'not-an-array' }
  assert.throws(() => validateDramaOutline(malformed, expected), /HISTORY_DRAMA_INVALID: scenes\[1\]\.requiredBeats 必须是非空数组/)
  const unknown = fixture()
  unknown.scenes[1].dramaticSceneId = 'unregistered-drama'
  assert.throws(() => validateDramaOutline(unknown, expected), /HISTORY_DRAMA_INVALID: scenes\[1\]\.dramaticSceneId 引用不存在的 unregistered-drama/)
})

test('characters carry knowledge, prior choices and relationships into the next scene', () => {
  const candidate = fixture()
  candidate.dramaticScenes[1].characterStates[0].before.knowledge = ['周福曾为帝师']
  assert.throws(() => validateDramaOutline(candidate, expected), /丢失或改写前场/)
  const forget = fixture()
  forget.dramaticScenes[1].characterStates[0].after.knowledge.pop()
  assert.throws(() => validateDramaOutline(forget, expected), /不得无故遗忘/)
  const undo = fixture()
  undo.dramaticScenes[1].characterStates[0].after.choices.shift()
  assert.throws(() => validateDramaOutline(undo, expected), /必须保留已作选择/)
  undo.dramaticScenes[1].characterStates[1].after.choices.shift()
  assert.throws(() => validateDramaOutline(undo, expected), error => error instanceof Error
    && error.message.includes('周家宾客.after') && error.message.includes('房家宾客.after'), 'one repair receives every lost character-state obligation')
})

test('runtime derives inherited before state while keeping authored after state', () => {
  const candidate = fixture()
  const first = candidate.dramaticScenes[0].characterStates.find((item: Value) => item.name === '周家宾客')
  const later = candidate.dramaticScenes[1].characterStates.find((item: Value) => item.name === '周家宾客')
  later.before = { knowledge: ['模型误抄'], relationships: [], choices: [] }
  const normalized = validateDramaOutline(candidate, { ...expected, deriveInheritedStates: true }) as Value
  const repaired = normalized.dramaticScenes[1].characterStates.find((item: Value) => item.name === '周家宾客')
  assert.deepEqual(repaired.before, first.after)
  assert.deepEqual(repaired.after, later.after, 'creative after state remains authored')
  assert.deepEqual(later.before, { knowledge: ['模型误抄'], relationships: [], choices: [] }, 'candidate evidence is not mutated')
})

test('intent without actual visual or audio obligations cannot pass, while purposeful silence can', () => {
  const candidate = fixture()
  candidate.scenes[2].requiredBeats[0].observable.visual = []
  assert.throws(() => validateDramaOutline(candidate, expected), /不能只写幕后意图/)
  const scene = (validateDramaOutline(fixture(), expected).scenes as Value[])[2]
  const shot = shotFor(scene)
  assert.equal(shot.audioText, '')
  assert.doesNotThrow(() => validateDramaStoryboard(shot, scene))
})

test('storyboard must preserve every beat function/state change and actually speak the approved audio', () => {
  const scene = (validateDramaOutline(fixture(), expected).scenes as Value[])[1]
  const shot = shotFor(scene)
  assert.doesNotThrow(() => validateDramaStoryboard(shot, scene))
  const missing = structuredClone(shot)
  missing.beatDramaturgy.pop()
  assert.throws(() => validateDramaStoryboard(missing, scene), /全部节拍/)
  const changed = structuredClone(shot)
  changed.beatDramaturgy[1].stateChange = '对方欣然同意'
  assert.throws(() => validateDramaStoryboard(changed, scene), /不得静默改写叙事义务/)
  const unsaid = structuredClone(shot)
  unsaid.audioText = '一句歌谣，便能断人高下'
  unsaid.videoPrompt += '。乡人传唱，我只不过学了一句'
  assert.throws(() => validateDramaStoryboard(unsaid, scene), /未落在实际可听对白/)
})

test('declaring a beat in metadata, planned tail, prohibition, quoted speech or reminder is not its execution', () => {
  const scene = (validateDramaOutline(fixture(), expected).scenes as Value[])[2]
  const shot = shotFor(scene)
  const originals = shot.videoPrompt
  for (const fake of ['', `备注：${originals}`, '禁止周家宾客撤回招呼。不得周家宾客转身离开。避免房家宾客移开视线', `并未发生${originals}`, `房家宾客说：“${originals}”`]) {
    const candidate = { ...shot, videoPrompt: fake, lastFramePrompt: originals }
    assert.throws(() => validateDramaStoryboard(candidate, scene), /未落在实际画面动作/)
  }
})

test('an anchor stays valid evidence when the shot adds detail inside it, and a real gap names the anchor', () => {
  const scene = (validateDramaOutline(fixture(), expected).scenes as Value[])[2]
  const shot = shotFor(scene)
  const anchors = scene.requiredBeats.flatMap((beat: Value) => beat.observable.visual) as string[]
  // record-ap4bsu lost all three storyboard attempts on 尚书台木质梁柱可见 versus 身后尚书台木质梁柱清晰
  // 可见: the obligation was filmed, only a modifier slid into the middle of the phrase.
  const decorated = { ...shot, videoPrompt: anchors.map(anchor => `${anchor.slice(0, 3)}缓缓${anchor.slice(3)}`).join('。') }
  assert.doesNotThrow(() => validateDramaStoryboard(decorated, scene))
  const dropped = { ...shot, videoPrompt: anchors.map((anchor, index) => (index ? anchor : anchor.slice(0, 4))).join('。') }
  assert.throws(() => validateDramaStoryboard(dropped, scene), (error: Error) => /仅声明完成/.test(error.message)
    && error.message.includes(anchors[0]) && !error.message.includes(anchors[1]), 'a repair can only act on the named anchor')
})

test('a complex beat may divide its obligations over segments only after complete unique allocation is proven', () => {
  const scene = (validateDramaOutline(fixture(), expected).scenes as Value[])[2]
  const originalShot = shotFor(scene)
  const first = structuredClone(originalShot)
  const second = structuredClone(originalShot)
  first.id += '-a'; second.id += '-b'
  first.beatDramaturgy[0].visual = ['周家宾客撤回招呼']
  second.beatDramaturgy[0].visual = ['周家宾客转身离开', '房家宾客移开视线']
  assert.doesNotThrow(() => validateDramaStoryboardAllocation([first, second], scene))
  const firstScene = { ...scene, requiredBeats: [partitionDramaBeat(scene.requiredBeats[0], first)] }
  const secondScene = { ...scene, requiredBeats: [partitionDramaBeat(scene.requiredBeats[0], second)] }
  assert.deepEqual(firstScene.requiredBeats[0].observable, { visual: ['周家宾客撤回招呼'], audio: [] })
  assert.doesNotThrow(() => validateDramaStoryboard(first, firstScene))
  assert.doesNotThrow(() => validateDramaStoryboard(second, secondScene))
  const lost = structuredClone(second)
  lost.beatDramaturgy[0].visual.pop()
  assert.throws(() => validateDramaStoryboardAllocation([first, lost], scene), /实际 0 次/)
  const replay = structuredClone(second)
  replay.beatDramaturgy[0].visual.push('周家宾客撤回招呼')
  assert.throws(() => validateDramaStoryboardAllocation([first, replay], scene), /实际 2 次/)
})

test('long narration can split without losing words, changing speakers or treating the narration label as spoken words', () => {
  const scene = (validateDramaOutline(fixture(), expected).scenes as Value[])[0]
  scene.requiredBeats[0].observable = { visual: ['周家宾客停步'], audio: ['旁白：桓帝即位后擢周福为尚书，房植有名当朝。'] }
  const first = shotFor(scene), second = shotFor(scene)
  first.beatDramaturgy[0].audio = ['旁白：桓帝即位后擢周福为尚书']
  first.audioText = '桓帝即位后擢周福为尚书。'
  second.beatDramaturgy[0].audio = ['房植有名当朝']
  second.audioText = '房植有名当朝。'
  second.beatDramaturgy[0].visual = []
  assert.doesNotThrow(() => validateDramaStoryboardAllocation([first, second], scene))
  const firstScene = { ...scene, requiredBeats: [partitionDramaBeat(scene.requiredBeats[0], first)] }
  const secondScene = { ...scene, requiredBeats: [partitionDramaBeat(scene.requiredBeats[0], second)] }
  assert.doesNotThrow(() => validateDramaStoryboard(first, firstScene))
  assert.doesNotThrow(() => validateDramaStoryboard(second, secondScene))
  assert.throws(() => validateDramaStoryboardAllocation([second, first], scene), /audio.*乱序/)
  const missing = structuredClone(second)
  missing.beatDramaturgy[0].audio = ['房植有名']
  assert.throws(() => validateDramaStoryboardAllocation([first, missing], scene), /audio.*遗漏/)
  const duplicate = structuredClone(second)
  duplicate.beatDramaturgy[0].audio = ['桓帝即位后擢周福为尚书', '房植有名当朝']
  assert.throws(() => validateDramaStoryboardAllocation([first, duplicate], scene), /audio.*重复/)
  const repeatedInsideOneAnchor = structuredClone(first)
  repeatedInsideOneAnchor.beatDramaturgy[0].audio = ['旁白：桓帝即位后擢周福为尚书，房植有名当朝。桓帝即位后擢周福为尚书，房植有名当朝。']
  assert.throws(() => validateDramaStoryboardAllocation([repeatedInsideOneAnchor], scene), /audio.*重复/)
  const extra = structuredClone(second)
  extra.beatDramaturgy[0].audio.push('凭空补出的新断言')
  assert.throws(() => validateDramaStoryboardAllocation([first, extra], scene), /audio.*未批准/)
  const dialogueScene = structuredClone(scene)
  dialogueScene.requiredBeats[0].observable.audio = ['周家宾客：一句歌谣便能断人高下']
  const a = shotFor(dialogueScene), b = shotFor(dialogueScene)
  a.beatDramaturgy[0].audio = ['周家宾客：一句歌谣']
  b.beatDramaturgy[0].audio = ['周家宾客：便能断人高下']; b.beatDramaturgy[0].visual = []
  assert.doesNotThrow(() => validateDramaStoryboardAllocation([a, b], dialogueScene))
  b.beatDramaturgy[0].audio = ['房家宾客：便能断人高下']
  assert.throws(() => validateDramaStoryboardAllocation([a, b], dialogueScene), /换说话人/)
})

test('writer context contains current people, remaining obligations and inherited plans without future or false observed state', () => {
  const outline = validateDramaOutline(fixture(), expected) as Value
  outline.characterDramas.push({ name: '不在本场的旁观者', initialState: { knowledge: ['未来信息'], relationships: [], choices: [] } })
  const context = { scene_outline: outline, scene: outline.scenes[3], loop: { previous: { shot_script: shotFor(outline.scenes[2]) } } }
  const result = storyboardDramaContext(context) as Value
  assert.equal(result.dramaContext.dramaticScene.id, 'drama-consequence')
  assert.deepEqual(result.dramaContext.characterDramas.map((person: Value) => person.name), ['周家宾客', '房家宾客'])
  assert.doesNotMatch(JSON.stringify(result.dramaContext), /不在本场的旁观者|未来信息/)
  assert.deepEqual(result.dramaContext.plannedPriorCharacterStates[0].state, outline.dramaticScenes[0].characterStates[0].after)
  assert.deepEqual(result.dramaContext.requiredBeats, outline.scenes[3].requiredBeats)
  assert.equal(result.dramaContext.previousScriptBeatDramaturgy, undefined)
  assert.match(result.dramaContext.stateEvidenceScope, /script-plan-only/)
  const continuous = storyboardDramaContext({ ...context, scene: outline.scenes[2], loop: { previous: { shot_script: shotFor(outline.scenes[1]) } } }) as Value
  assert.deepEqual(continuous.dramaContext.remainingBeatIds, ['beat-choice'])
  assert.equal(continuous.dramaContext.previousScriptBeatDramaturgy[1].beatId, 'beat-counter')
  assert.equal(context.scene, outline.scenes[3], 'context remains immutable')
})

test('approved outline -> complex beat split -> runtime expanded outline -> final validation preserves one authority', () => {
  const approved = validateDramaOutline(fixture(), expected) as Value
  const originalShots = approved.scenes.map(shotFor)
  const first = structuredClone(originalShots[2]), second = structuredClone(originalShots[2])
  first.id += '-part-1'; second.id += '-part-2'
  first.duration = 3; second.duration = 3
  first.continuity = { mode: 'coverage_cut' }; second.continuity = { mode: 'coverage_cut' }
  first.worldState = { settingId: 'drama-encounter' }; second.worldState = { settingId: 'drama-encounter' }
  first.beatDramaturgy[0].visual = ['周家宾客撤回招呼']
  second.beatDramaturgy[0].visual = ['周家宾客转身离开', '房家宾客移开视线']
  first.beatCoverage = [{ beatId: 'beat-choice', anchors: ['撤回招呼'] }]
  second.beatCoverage = [{ beatId: 'beat-choice', anchors: ['转身离开'] }]
  validateDramaStoryboardAllocation([first, second], approved.scenes[2])
  const scenes = approved.scenes.flatMap((scene: Value, index: number) => index === 2
    ? [sceneFromStoryboardSegment(scene, first, 0, 2), sceneFromStoryboardSegment(scene, second, 1, 2)] : [scene])
    .map((scene: Value, index: number) => ({ ...scene, sequence: index + 1 }))
  const shots = [...originalShots.slice(0, 2), first, second, originalShots[3]]
  const expanded = { ...approved, scenes, count: scenes.length, totalDuration: shots.reduce((sum, shot) => sum + shot.duration, 0) }
  assert.doesNotThrow(() => validateExpandedDramaOutline(expanded, approved, shots))
  assert.throws(() => validateExpandedDramaOutline(expanded, approved, [shots[1], shots[0], ...shots.slice(2)]), /按时间线顺序逐一对应/)
  assert.throws(() => validateDramaOutline(expanded, expected), /全局重复 id/, 'writers still cannot claim arbitrary duplicate beats')
  const changed = structuredClone(expanded)
  changed.scenes[3].requiredBeats[0].stateChange = '对方欣然同意'
  assert.throws(() => validateExpandedDramaOutline(changed, approved, shots), /改写已批准 stateChange/)
  const lost = structuredClone(shots)
  lost[3].beatDramaturgy[0].visual.pop()
  assert.throws(() => validateExpandedDramaOutline(expanded, approved, lost), /实际 0 次/)
  const replay = structuredClone(shots)
  replay[3].beatDramaturgy[0].visual.push('周家宾客撤回招呼')
  assert.throws(() => validateExpandedDramaOutline(expanded, approved, replay), /实际 2 次/)
  const forged = structuredClone(expanded)
  forged.historicalLocks[0].fact = '伪造史实'
  assert.throws(() => validateExpandedDramaOutline(forged, approved, shots), /不得改写已批准 historicalLocks/)
})

test('the actual production outline prompt consumes episode rules and exports executable dramatic obligations', () => {
  for (const marker of ['${input.adaptation_policy}', '${input.source_level}', 'cinematic-v1', 'episodeDrama', 'coreMotivation', 'characterStates', 'dramaticSceneId', 'observable', 'coverage_cut']) assert.ok(SANGUO_SCENE_OUTLINE_PROMPT.includes(marker), marker)
  assert.doesNotMatch(SANGUO_SCENE_OUTLINE_PROMPT, /只输出以下已有结构/)
})
