import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { SCENE_OUTLINE_CAST_CONTRACT, SCENE_OUTLINE_CAST_CONTRACT_BEFORE_ACTORLESS_BRIDGE, SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT, SANGUO_SCENE_OUTLINE_PROMPT, refreshSceneOutlineAnchorPrompt, refreshSceneOutlineShotIntentPrompt } from '../src/scene-outline-prompt.ts'
import { DURATION_ACTOR_IDS_CONTRACT, DURATION_ACTOR_IDS_CONTRACT_BEFORE_ACTORLESS_EDITORIAL, DURATION_ACTOR_IDS_CONTRACT_BEFORE_SETTING_ESTABLISHMENT, DURATION_STORYBOARD_PROMPT } from '../src/duration-prompts.ts'
import { EDITORIAL_VIDEO_NEGATIVE_PROMPT, EDITORIAL_VIDEO_PROMPT, upgradeActorlessEditorialBridge, upgradeActorlessEditorialPacing, upgradeActorlessSettingEstablishment, upgradeEditorialFilmGrammar, upgradeThreeViewLayoutContract } from '../src/quality-node-presets.ts'

const state = { knowledge: [], relationships: [], choices: [] }

test('outline cast contract uses legal scene fields instead of storyboard shotIntent', () => {
  assert.doesNotMatch(SANGUO_SCENE_OUTLINE_PROMPT, /shotIntent/)
  assert.match(SANGUO_SCENE_OUTLINE_PROMPT, /scenes\[\]\.purpose 与 requiredBeats\[\]\.observable/)
  const old = SANGUO_SCENE_OUTLINE_PROMPT.replace(SCENE_OUTLINE_CAST_CONTRACT, SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT)
  assert.equal(refreshSceneOutlineShotIntentPrompt(old), SANGUO_SCENE_OUTLINE_PROMPT)
  assert.equal(refreshSceneOutlineShotIntentPrompt(SANGUO_SCENE_OUTLINE_PROMPT), SANGUO_SCENE_OUTLINE_PROMPT)
  assert.equal(refreshSceneOutlineAnchorPrompt(old), SANGUO_SCENE_OUTLINE_PROMPT)
  assert.equal(refreshSceneOutlineShotIntentPrompt(old + old), old + old, 'ambiguous duplicate clauses stay intact')
  assert.equal(refreshSceneOutlineShotIntentPrompt('user-authored shotIntent text'), 'user-authored shotIntent text')
})
const beat = (id: string, setting: string, description: string, audio: string) => ({ id, description,
  function: '信息建立', stateChange: '观众获得新的因果信息', observable: { visual: [description], audio: audio ? [audio] : [] }, setting, mustShow: [description] })
const scene = (id: string, sequence: number, dramaticSceneId: string, editorialRole: string, visualTreatment: string,
  cast: string[], requiredBeats: unknown[], contextPayload?: unknown) => ({ id, sequence, title: id, dramaticSceneId, editorialRole, visualTreatment,
  ...(contextPayload ? { contextPayload } : {}), cast, purpose: '让前后剧情具有清楚的时空和因果承接', requiredBeats,
  historicalBasis: '[史料1] 本集事实', adaptationBoundary: '只拟制镜头调度', targetDuration: 6, continuityMode: 'scene_cut',
  completionCriteria: ['规定声画已呈现'] })

function outline() {
  const context = (narration: string) => ({ timePlace: '东汉末年，冀州', geographicFocus: ['冀州'], historicalBackground: '饥荒蔓延', narration })
  return {
    contentContractVersion: 'cinematic-v1', episodeTitle: '符水与饥民',
    episodeDrama: { centralQuestion: '符水能否救治饥民', viewpointCharacters: ['张角'], stakes: '饥民生死',
      openingPromise: { description: '冀州饥荒', beatIds: ['beat-open'] }, payoff: { description: '局势扩散', beatIds: ['beat-bridge'] } },
    historicalLocks: [{ id: 'fact-1', fact: '冀州发生饥荒', sourceRefs: ['[史料1]'] }],
    adaptationSpace: { policy: '史实主体不变', sourceLevel: '正史', allowed: ['镜头调度'], forbidden: ['改写因果'] },
    characterDramas: [{ name: '张角', goal: '救治饥民', concern: '饥民病困', leverage: '符水', tactic: '施治', speechStyle: '简短', basis: 'historical',
      historicalLockIds: ['fact-1'], coreMotivation: { status: 'historical', description: '施符水', historicalLockIds: ['fact-1'] }, initialState: state }],
    dramaticScenes: [
      { id: 'drama-open', function: 'setup', setting: '地图空间', characters: [], goal: '建立语境', obstacle: '观众未知背景', tactics: '地图与旁白', turn: '落到冀州', result: '观众理解危机', beatIds: ['beat-open'], characterStates: [] },
      { id: 'drama-story', function: 'conflict', setting: '村外', characters: ['张角'], goal: '救治', obstacle: '病困', tactics: '施符水', turn: '开始施治', result: '等待结果', beatIds: ['beat-story'], characterStates: [{ name: '张角', before: state, after: state }] },
      { id: 'drama-bridge', function: 'transition', setting: '地图空间二', characters: [], goal: '承接局势', obstacle: '地点变化', tactics: '路径动画', turn: '局势扩散', result: '交代影响', beatIds: ['beat-bridge'], characterStates: [] },
    ],
    scenes: [
      scene('scene-open', 1, 'drama-open', 'episode_opening', 'animated_map', [], [beat('beat-open', '地图空间', '冀州区域高亮', '中平元年，冀州饥荒蔓延。')], context('中平元年，冀州饥荒蔓延。')),
      scene('scene-story', 2, 'drama-story', 'story', 'live_action', ['张角'], [beat('beat-story', '村外', '张角举起符水', '')]),
      scene('scene-bridge', 3, 'drama-bridge', 'context_bridge', 'historical_montage', [], [beat('beat-bridge', '地图空间二', '人群迁徙路径显现', '饥民由四方聚集。')], context('饥民由四方聚集。')),
    ],
  }
}

test('editorial grammar requires a true opening and an inter-scene context bridge', () => {
  assert.doesNotThrow(() => validateDramaOutline(outline(), { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }))
  const source = outline(), before = structuredClone(source)
  const cartographic = validateDramaOutline(source, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }) as Value
  assert.equal(cartographic.scenes[0].animationAesthetic, 'historical_cartography')
  assert.equal(cartographic.scenes[0].animationStyle, 'historical_map')
  assert.deepEqual(cartographic.scenes[0].requiredBeats, source.scenes[0].requiredBeats)
  assert.deepEqual(cartographic.scenes[0].contextPayload, source.scenes[0].contextPayload)
  assert.deepEqual(source, before, 'new presentation normalization never rewrites the approved original object')
  const direct = outline(); direct.scenes[0].editorialRole = 'story'
  assert.throws(() => validateDramaOutline(direct, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }), /episode_opening|cast/)
  const noBridge = outline(); noBridge.scenes[2].editorialRole = 'payoff'; noBridge.scenes[2].visualTreatment = 'live_action'; noBridge.scenes[2].cast = ['张角']; delete noBridge.scenes[2].contextPayload
  noBridge.dramaticScenes[2].characters = ['张角']; noBridge.dramaticScenes[2].characterStates = [{ name: '张角', before: state, after: state }]
  assert.throws(() => validateDramaOutline(noBridge, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }), /context_bridge/)
  const rushed = outline(); rushed.scenes[0].targetDuration = 3
  assert.throws(() => validateDramaOutline(rushed, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }), /不得短于4秒/)
  const sourcedLongOpening = outline(); sourcedLongOpening.scenes[0].targetDuration = 15
  assert.doesNotThrow(() => validateDramaOutline(sourcedLongOpening, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }))
  sourcedLongOpening.scenes[0].targetDuration = 16
  assert.throws(() => validateDramaOutline(sourcedLongOpening, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }), /不得超过15秒/)
  const noGeography = outline(); noGeography.scenes[0].contextPayload.geographicFocus = []
  assert.throws(() => validateDramaOutline(noGeography, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }), /geographicFocus/)
})

test('an actorless live-action environment bridge is valid without fake character state', () => {
  const candidate = outline()
  candidate.scenes[2].visualTreatment = 'live_action'
  delete candidate.scenes[2].contextPayload
  candidate.scenes[2].requiredBeats[0].observable.audio = []
  candidate.scenes[2].historicalBasis = '无具体史料，为日落与灯火的电影转场语法'
  assert.doesNotThrow(() => validateDramaOutline(candidate, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }))
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.scene-outline', candidate,
    { requireEditorialGrammar: true, requireBeatCoverage: true, requireNarrativeClosure: true, requireDramaContract: true }))
})

test('character illustration requests are projected to identity-bound live action', () => {
  const candidate = outline()
  Object.assign(candidate.scenes[1], { visualTreatment: 'animated', animationStyle: 'character_illustration', animationAesthetic: 'ink_wash' })
  candidate.scenes[1].requiredBeats[0].observable.audio = ['旁白交代人物所处的史实背景。']
  const normalized = validateDramaOutline(candidate, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }) as Value
  assert.equal(normalized.scenes[1].visualTreatment, 'live_action')
  assert.equal(normalized.scenes[1].animationStyle, undefined)
  const missingCast = structuredClone(candidate); missingCast.scenes[1].cast = []
  const repaired = validateDramaOutline(missingCast, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }) as Value
  assert.deepEqual(repaired.scenes[1].cast, candidate.scenes[1].cast)
  const badStyle = structuredClone(candidate); badStyle.scenes[1].animationStyle = 'map_everywhere'
  assert.throws(() => validateDramaOutline(badStyle, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }), /animationStyle/)
})

test('an animated payoff uses requiredBeats and does not duplicate established contextPayload', () => {
  const candidate = outline()
  const payoff = structuredClone(candidate.scenes[2])
  Object.assign(payoff, { id: 'scene-payoff', sequence: 4, dramaticSceneId: 'drama-payoff', editorialRole: 'payoff' })
  delete payoff.contextPayload
  payoff.requiredBeats[0].id = 'beat-payoff'
  candidate.scenes.push(payoff)
  candidate.dramaticScenes.push({ ...structuredClone(candidate.dramaticScenes[2]), id: 'drama-payoff', function: 'consequence', beatIds: ['beat-payoff'] })
  candidate.episodeDrama.payoff.beatIds = ['beat-payoff']
  assert.doesNotThrow(() => validateDramaOutline(candidate, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }))

  const opening = structuredClone(candidate)
  delete opening.scenes[0].contextPayload
  assert.throws(() => validateDramaOutline(opening, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }), /scenes\[0\]\.contextPayload/)
})

test('historical illustration requests are projected to a live-action historical scene', () => {
  const candidate = outline()
  Object.assign(candidate.scenes[0], { visualTreatment: 'animated', animationStyle: 'historical_tableau', animationAesthetic: 'cinematic_gongbi' })
  candidate.scenes[0].requiredBeats[0].mustShow.push('灾荒定格插画整体缓慢放大')
  candidate.scenes[0].requiredBeats[0].observable.visual.push('灾荒定格插画整体缓慢放大')
  const normalized = validateDramaOutline(candidate, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }) as Value
  assert.equal(normalized.scenes[0].visualTreatment, 'live_action')
  assert.equal(normalized.scenes[0].animationStyle, undefined)
})

test('missing editorial context payloads aggregate across scenes in one repair round', () => {
  const candidate = outline()
  delete candidate.scenes[0].contextPayload
  delete candidate.scenes[2].contextPayload
  assert.throws(
    () => validateDramaOutline(candidate, { requireEditorialGrammar: true, sourceRefs: ['[史料1]'] }),
    error => error instanceof Error
      && /scenes\[0\]\.contextPayload 必须是对象/.test(error.message)
      && /scenes\[2\]\.contextPayload 必须是对象/.test(error.message),
  )
})

test('schema120 updates the two existing writers and video treatment without changing topology or models', () => {
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 117, edges: [{ id: 'a', from: 'x', to: 'y' }], nodes: [
    { id: 'sanguo-scene-outline', kind: 'text', modelId: 'writer', prompt: 'old', params: [] },
    { id: 'sanguo-shot-script', kind: 'text', modelId: 'writer', prompt: DURATION_STORYBOARD_PROMPT, params: [] },
    { id: 'sanguo-video', kind: 'video', modelId: 'video', prompt: 'old video', params: [{ id: 'negative', name: 'negativePrompt', englishName: 'negativePrompt', type: 'text', required: false, value: '动漫' }] },
  ] }
  const migrated = upgradeEditorialFilmGrammar(workflow)
  assert.equal(migrated.schemaVersion, 120)
  assert.equal(migrated.nodes[0].prompt, SANGUO_SCENE_OUTLINE_PROMPT)
  assert.match(migrated.nodes[1].prompt, /duration-v2/)
  assert.match(migrated.nodes[1].prompt, /editorialRole/)
  assert.equal(migrated.nodes[2].prompt, EDITORIAL_VIDEO_PROMPT)
  assert.equal(migrated.nodes[2].params[0].value, EDITORIAL_VIDEO_NEGATIVE_PROMPT)
  assert.equal(migrated.nodes[0].modelId, 'writer'); assert.equal(migrated.nodes[2].modelId, 'video')
  assert.equal(migrated.edges, workflow.edges)
  assert.equal(upgradeEditorialFilmGrammar(migrated), migrated)
})

test('schema121 restores deterministic layout validation for deferred three-view generation', () => {
  const validate = { id: 'validate', name: '三视图质量检查', englishName: 'validateThreeView', type: 'boolean', required: true, value: 'false' }
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 120, edges: [], nodes: [{
    id: 'sanguo-character-image', kind: 'image', operation: 'character.ensure', prompt: '',
    params: [validate, { id: 'defer', name: '延迟归档', englishName: 'deferArchive', type: 'boolean', required: true, value: 'true' }],
  }] }
  const migrated = upgradeThreeViewLayoutContract(workflow)
  assert.equal(migrated.schemaVersion, 121)
  assert.equal(migrated.nodes[0].params[0].value, 'true')
  assert.equal(upgradeThreeViewLayoutContract(migrated), migrated)
})

test('schema122 refreshes only the managed cast clause for actorless live-action bridges', () => {
  const oldPrompt = SANGUO_SCENE_OUTLINE_PROMPT.replace(SCENE_OUTLINE_CAST_CONTRACT, SCENE_OUTLINE_CAST_CONTRACT_BEFORE_ACTORLESS_BRIDGE)
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 121, edges: [{ id: 'e', from: 'a', to: 'b' }], nodes: [
    { id: 'sanguo-scene-outline', kind: 'text', modelId: 'writer', prompt: oldPrompt, params: [] },
  ] }
  const migrated = upgradeActorlessEditorialBridge(workflow)
  assert.equal(migrated.schemaVersion, 122)
  assert.equal(migrated.nodes[0].prompt, SANGUO_SCENE_OUTLINE_PROMPT)
  assert.equal(migrated.nodes[0].modelId, 'writer')
  assert.equal(migrated.edges, workflow.edges)
  assert.equal(upgradeActorlessEditorialBridge(migrated), migrated)
  const custom = { ...workflow, nodes: [{ ...workflow.nodes[0], prompt: 'custom prompt' }] }
  assert.equal(upgradeActorlessEditorialBridge(custom), custom)
})

test('schema123 refreshes only the duration actor contract for actorless editorial actions', () => {
  const oldPrompt = DURATION_STORYBOARD_PROMPT.replace(DURATION_ACTOR_IDS_CONTRACT, DURATION_ACTOR_IDS_CONTRACT_BEFORE_ACTORLESS_EDITORIAL)
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 122, edges: [{ id: 'e', from: 'a', to: 'b' }], nodes: [
    { id: 'sanguo-shot-script', kind: 'text', modelId: 'writer', prompt: oldPrompt, params: [] },
  ] }
  const migrated = upgradeActorlessEditorialPacing(workflow)
  assert.equal(migrated.schemaVersion, 123)
  assert.equal(migrated.nodes[0].prompt, DURATION_STORYBOARD_PROMPT)
  assert.equal(migrated.nodes[0].modelId, 'writer')
  assert.equal(migrated.edges, workflow.edges)
  assert.equal(upgradeActorlessEditorialPacing(migrated), migrated)
  const custom = { ...workflow, nodes: [{ ...workflow.nodes[0], prompt: 'custom prompt' }] }
  assert.equal(upgradeActorlessEditorialPacing(custom), custom)
})

test('schema144 refreshes only the managed actorless setting-establishment clause', () => {
  const oldPrompt = DURATION_STORYBOARD_PROMPT.replace(DURATION_ACTOR_IDS_CONTRACT, DURATION_ACTOR_IDS_CONTRACT_BEFORE_SETTING_ESTABLISHMENT)
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 143, edges: [{ id: 'e', from: 'a', to: 'b' }], nodes: [
    { id: 'sanguo-shot-script', kind: 'text', modelId: 'writer', prompt: oldPrompt, params: [] },
  ] }
  const migrated = upgradeActorlessSettingEstablishment(workflow)
  assert.equal(migrated.schemaVersion, 144)
  assert.equal(migrated.nodes[0].prompt, DURATION_STORYBOARD_PROMPT)
  assert.equal(migrated.nodes[0].modelId, 'writer')
  assert.equal(migrated.edges, workflow.edges)
  assert.equal(upgradeActorlessSettingEstablishment(migrated), migrated)
  const custom = { ...workflow, nodes: [{ ...workflow.nodes[0], prompt: 'custom prompt' }] }
  assert.equal(upgradeActorlessSettingEstablishment(custom), custom)
})
