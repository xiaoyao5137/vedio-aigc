import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSceneOutlineRepairSuffix, extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { SCENE_OUTLINE_ANCHOR_RULE, SCENE_OUTLINE_ANCHOR_RULE_BEFORE, SCENE_OUTLINE_ANCHOR_RULE_V1, SCENE_OUTLINE_EDITORIAL_ROLE_CONTRACT, SCENE_OUTLINE_EDITORIAL_ROLE_INSERT_AFTER, refreshSceneOutlineAnchorPrompt } from '../src/scene-outline-prompt.ts'
import { refreshSceneOutlineAnchors } from '../src/quality-node-presets.ts'

test('outline repair preserves a complete long candidate without duplicate provider drafts', () => {
  // Same envelope as record-vn75ae. The old 20k cut produced invalid JSON;
  // putting transport fields first also excluded every authored scene.
  const authored = { episodeTitle: '长篇场景大纲', scenes: Array.from({ length: 18 }, (_, i) => ({
    id: `scene-${i + 1}`, requiredBeats: [{ id: `beat-${i + 1}`, description: '人物向前一步。'.repeat(180),
      mustShow: ['向前一步'], observable: { visual: ['向前一步'], audio: ['甲：请留步。'] },
      annotation: { text: '剧情中的 text 字段须保留', raw: '嵌套创作字段须保留' } }],
  })) }
  assert.ok(JSON.stringify(authored).length > 20_000)
  const body = { content: [{ type: 'text', text: JSON.stringify(authored) }] }
  const normalized = normalizeStructuredTextOutput(body, extractTextResponse(body), 'json')
  const candidate = { raw: body, text: JSON.stringify(authored), model: 'configured-writer', ...normalized }
  const snapshot = JSON.stringify(candidate)
  const prompt = buildSceneOutlineRepairSuffix('原始指令', 'scenes[17] 的 mustShow 锚点抽象', candidate)
  const baseline = JSON.parse(prompt.split('【上一版未通过的 JSON】\n').at(-1)!)
  assert.deepEqual(baseline.scenes, authored.scenes)
  assert.equal(baseline.episodeTitle, authored.episodeTitle)
  assert.equal(baseline.raw, undefined)
  assert.equal(baseline.text, undefined)
  assert.equal(baseline.model, undefined)
  assert.equal(JSON.stringify(candidate), snapshot, 'durable provider evidence is unchanged')
  assert.match(prompt, /不要只修第一项/)
})

test('an unchanged outline retry gets a distinct escalated instruction instead of replaying the same prompt', () => {
  const candidate = { dramaticScenes: [{ id: 'drama-01', characters: ['张角'], characterStates: [] }], scenes: [] }
  const first = buildSceneOutlineRepairSuffix('原始指令', 'dramaticScenes.drama-01.characterStates 缺少 张角', candidate, 1, false)
  const second = buildSceneOutlineRepairSuffix('原始指令', 'dramaticScenes.drama-01.characterStates 缺少 张角', candidate, 2, true)
  assert.match(first, /第 1 轮/)
  assert.doesNotMatch(first, /上一轮未执行修复/)
  assert.match(second, /第 2 轮/)
  assert.match(second, /上一轮未执行修复/)
  assert.match(second, /不能再次照抄/)
  assert.notEqual(first, second)
})

test('outline repair maps invented editorial role synonyms to the closed enum', () => {
  const candidate = { scenes: [{ id: 'scene-02', editorialRole: 'story_action' }] }
  const prompt = buildSceneOutlineRepairSuffix(
    '原始指令',
    'scenes[1].editorialRole 无效：收到 "story_action"；仅允许 episode_opening、story、context_bridge、payoff',
    candidate,
  )
  assert.match(prompt, /普通人物剧情或叙事推进用 story/)
  assert.match(prompt, /不得另造 main_action、story_action、narrative_action/)
  assert.match(prompt, /不改画面、台词、节拍或场景归属/)
})

test('continuity repair preserves authored space changes instead of coercing a scene cut into tail reuse', () => {
  const candidate = { scenes: [{ id: 'scene-14', dramaticSceneId: 'drama-05', continuityMode: 'scene_cut',
    requiredBeats: [{ id: 'beat-16', description: '周福门生在另一处院落内与数位同门围坐交谈,神色严肃' }] }] }
  const prompt = buildSceneOutlineRepairSuffix('原始指令', 'scenes[13].continuityMode 与完整戏归属不一致', candidate)
  assert.match(prompt, /保留全部原动作、台词、地点及时间描述/)
  assert.match(prompt, /拆分对应 dramaticSceneId\/完整戏归属/)
  assert.match(prompt, /新时空首段保留 scene_cut/)
  assert.doesNotMatch(prompt, /只改该 scene 的 continuityMode/)
  assert.deepEqual(JSON.parse(prompt.split('【上一版未通过的 JSON】\n').at(-1)!), candidate)
})

test('the managed anchor clause refresh preserves custom text, models and topology idempotently', () => {
  const prompt = '自定义开头\n' + SCENE_OUTLINE_ANCHOR_RULE_BEFORE + '\n自定义结尾'
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 115, edges: [{ from: 'a', to: 'b' }], nodes: [
    { id: 'sanguo-scene-outline', kind: 'text', prompt, params: [], resultVar: 'outline_candidate', modelId: 'configured-writer' },
    { id: 'custom', kind: 'text', prompt, params: [], resultVar: 'custom' },
  ] }
  const snapshot = JSON.stringify(workflow)
  const updated = refreshSceneOutlineAnchors(workflow)
  assert.equal(updated.nodes[0].prompt, '自定义开头\n' + SCENE_OUTLINE_ANCHOR_RULE + '\n自定义结尾')
  assert.equal(updated.nodes[0].modelId, 'configured-writer')
  assert.equal(updated.nodes[1], workflow.nodes[1])
  assert.equal(updated.edges, workflow.edges)
  assert.equal(updated.schemaVersion, 115)
  assert.equal(refreshSceneOutlineAnchors(updated), updated)
  assert.equal(JSON.stringify(workflow), snapshot)
  assert.equal(refreshSceneOutlineAnchorPrompt('完全自定义的大纲'), '完全自定义的大纲')
  assert.equal(refreshSceneOutlineAnchorPrompt(prompt + prompt), prompt + prompt, 'ambiguous duplicate clauses stay intact')
  const other = { ...workflow, id: 'unrelated' }
  assert.equal(refreshSceneOutlineAnchors(other), other)
})

test('managed outline refresh adds the closed editorialRole enum without replacing user edits', () => {
  const prompt = `自定义开头\n${SCENE_OUTLINE_EDITORIAL_ROLE_INSERT_AFTER}继续自定义\n自定义结尾`
  const refreshed = refreshSceneOutlineAnchorPrompt(prompt)
  assert.equal(refreshed, `自定义开头\n${SCENE_OUTLINE_EDITORIAL_ROLE_INSERT_AFTER}${SCENE_OUTLINE_EDITORIAL_ROLE_CONTRACT}继续自定义\n自定义结尾`)
  assert.equal(refreshSceneOutlineAnchorPrompt(refreshed), refreshed)
  assert.match(refreshed, /只允许 episode_opening、story、context_bridge、payoff/)
  assert.match(refreshed, /不得另造 main_action、story_action、primary_action、narrative_action/)
})

test('managed outline refresh replaces the over-strict v1 anchor clause', () => {
  const prompt = `自定义开头\n${SCENE_OUTLINE_ANCHOR_RULE_V1}\n自定义结尾`
  const refreshed = refreshSceneOutlineAnchorPrompt(prompt)
  assert.equal(refreshed, `自定义开头\n${SCENE_OUTLINE_ANCHOR_RULE}\n自定义结尾`)
  assert.equal(refreshSceneOutlineAnchorPrompt(refreshed), refreshed)
})
