import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { buildSceneOutlineRepairSuffix, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { SCENE_OUTLINE_STRUCTURE_CONTRACT, SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER, SCENE_OUTLINE_STRUCTURE_CONTRACT_V1, refreshSceneOutlineAnchorPrompt } from '../src/scene-outline-prompt.ts'
import { refreshSceneOutlineAnchors } from '../src/quality-node-presets.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-environment-bridge-candidates.json', import.meta.url), 'utf8'))
const validate = (index: number, candidate = fixture.candidates[index].candidate) =>
  validateHistoricalStructuredOutput('history.scene-outline', candidate, fixture.candidates[index].expected)

test('the second real recovery candidate passes without converting its environmental sounds into narration', () => {
  const candidate = structuredClone(fixture.candidates[1].candidate), snapshot = JSON.stringify(candidate)
  const normalized = validate(1, candidate) as typeof candidate
  assert.equal(JSON.stringify(candidate), snapshot, 'the saved provider candidate is immutable')
  assert.deepEqual(normalized.scenes[10].contextPayload, candidate.scenes[10].contextPayload)
  assert.equal(normalized.scenes[10].contextPayload.narration, '')
  assert.deepEqual(normalized.scenes.map((scene: typeof candidate.scenes[0]) => scene.requiredBeats),
    candidate.scenes.map((scene: typeof candidate.scenes[0]) => scene.requiredBeats), 'all approved beat contents remain exact')
})

test('the first real recovery candidate keeps both real structural errors and reports the authoritative beat order', () => {
  let message = ''
  try { validate(0) } catch (error) { message = (error as Error).message }
  assert.doesNotMatch(message, /contextPayload/)
  assert.match(message, /dramaticScenes\.drama-02\.beatIds/)
  assert.match(message, /权威所属 scenes\.requiredBeats\.id 顺序为 \["beat-02","beat-03","beat-03-tail"\]/)
  assert.match(message, /dramaticScenes\.drama-11\.function 无效/)
  const suffix = buildSceneOutlineRepairSuffix('原始指令', message, fixture.candidates[0].candidate)
  const instructions = suffix.split('【上一版未通过的 JSON】\n')[0]
  assert.match(instructions, /将完整有序列表同步到被点名戏的 beatIds/)
  assert.match(instructions, /不新增、删除、重编号或改写节拍内容/)
  assert.match(instructions, /只修改被点名完整戏的 function/)
  assert.doesNotMatch(instructions, /只把点名 scene 的该字段改为合法枚举|若缺陷指某锚点抽象/)
  assert.deepEqual(JSON.parse(suffix.split('【上一版未通过的 JSON】\n').at(-1)!), fixture.candidates[0].candidate)
})

test('one physical sound never fills the duplicate narration slot and static background metadata remains checked', () => {
  const candidate = structuredClone(fixture.candidates[1].candidate), bridge = candidate.scenes[10]
  bridge.requiredBeats[0].observable.audio = ['城门开启声']
  const normalized = normalizeDramaOutline(candidate, fixture.candidates[1].expected) as typeof candidate
  assert.equal(normalized.scenes[10].contextPayload.narration, '')
  assert.doesNotThrow(() => validate(1, candidate))
  delete bridge.contextPayload.geographicFocus
  assert.throws(() => validate(1, candidate), /scenes\[10\]\.contextPayload\.geographicFocus/)
  delete bridge.contextPayload
  assert.doesNotThrow(() => validate(1, candidate), 'a pure environmental bridge can omit the optional metadata object')
})

test('a real bridge with detailed footsteps and ceramic contact does not require invented narration', () => {
  const candidate = structuredClone(fixture.candidates[1].candidate), bridge = candidate.scenes[10]
  bridge.requiredBeats[0].observable.audio = [
    '军士鞋底落在廊道地面的脚步声',
    '行走时陶杯与木盘轻碰的声音',
  ]
  bridge.contextPayload.narration = ''
  assert.doesNotThrow(() => validate(1, candidate), 'complete static background may keep empty narration')
  delete bridge.contextPayload
  assert.doesNotThrow(() => validate(1, candidate), 'pure physical bridge may omit the optional payload')
  bridge.requiredBeats[0].observable.audio.push('严颜：坐下说话。')
  assert.throws(() => validate(1, candidate), /contextPayload 必须是对象/, 'actual dialogue still requires full context')
})

test('spoken or uncertain audio still requires complete context and cannot escape through a sound label', () => {
  for (const audio of [
    '张角组织扩张，朝廷开始察觉。', '旁白：洛阳城门开启，朝廷开始察觉。',
    '官员：城门开启了。', '“朝廷已经察觉”', '音效：车马声，旁白说朝廷开始察觉',
    '神秘声音', '人声', '同期声',
  ]) {
    const candidate = structuredClone(fixture.candidates[1].candidate)
    candidate.scenes[10].requiredBeats[0].observable.audio = [audio]
    delete candidate.scenes[10].contextPayload
    assert.throws(() => validate(1, candidate), /scenes\[10\]\.contextPayload 必须是对象/, audio)
  }
  const candidate = structuredClone(fixture.candidates[1].candidate)
  candidate.scenes[10].requiredBeats[0].observable.audio = ['朝廷开始察觉。', '各地百姓仍在聚集。']
  assert.throws(() => validate(1, candidate), /scenes\[10\]\.contextPayload\.narration/, 'multiple spoken obligations require an authored narration order')
})

test('declared narration still checks context even if beat audio only lists physical effects', () => {
  const candidate = structuredClone(fixture.candidates[1].candidate)
  candidate.scenes[10].contextPayload.narration = '张角组织扩张，朝廷开始察觉。'
  delete candidate.scenes[10].contextPayload.historicalBackground
  assert.throws(() => validate(1, candidate), /scenes\[10\]\.contextPayload\.historicalBackground/)
})

test('context diagnostics mentioning audio do not select an unrelated visual-anchor or editorial-role repair', () => {
  const message = 'HISTORY_DRAMA_INVALID: scenes[10].contextPayload 必须是对象（沿用 observable.audio 原文，不改 editorialRole）'
  const instructions = buildSceneOutlineRepairSuffix('原始指令', message, fixture.candidates[1].candidate)
    .split('【上一版未通过的 JSON】\n')[0]
  assert.match(instructions, /不能将音效名称转为朗读台词/)
  assert.match(instructions, /全部音频都是明确物理来源的音效/)
  assert.match(instructions, /不要因空 narration 就删掉其他已有效的背景字段/)
  assert.doesNotMatch(instructions, /若缺陷指某锚点抽象|只把点名 scene 的该字段改为合法枚举/)
})

test('current-schema managed refresh replaces the prior context clause once and preserves custom configuration', () => {
  const prompt = `自定义开头${SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER}${SCENE_OUTLINE_STRUCTURE_CONTRACT_V1}自定义结尾`
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 144, edges: [{ from: 'a', to: 'b' }], nodes: [
    { id: 'sanguo-scene-outline', kind: 'text', prompt, params: [{ key: 'custom', value: '保留' }], modelId: 'configured-writer', resultVar: 'outline_candidate' },
  ] }
  const snapshot = JSON.stringify(workflow), updated = refreshSceneOutlineAnchors(workflow)
  assert.equal(updated.nodes[0].prompt, `自定义开头${SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER}${SCENE_OUTLINE_STRUCTURE_CONTRACT}自定义结尾`)
  assert.equal(updated.nodes[0].params, workflow.nodes[0].params)
  assert.equal(updated.nodes[0].modelId, workflow.nodes[0].modelId)
  assert.equal(updated.edges, workflow.edges)
  assert.equal(updated.schemaVersion, 144)
  assert.equal(refreshSceneOutlineAnchors(updated), updated)
  assert.equal(JSON.stringify(workflow), snapshot)
  const ambiguous = `${SCENE_OUTLINE_STRUCTURE_CONTRACT_V1}${SCENE_OUTLINE_STRUCTURE_CONTRACT_V1}`
  assert.equal(refreshSceneOutlineAnchorPrompt(ambiguous), ambiguous)
})
