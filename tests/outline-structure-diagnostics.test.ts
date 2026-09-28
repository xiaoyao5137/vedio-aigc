import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSceneOutlineRepairSuffix, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { createDramaGenerationBudget } from '../src/drama-generation-budget.ts'
import { refreshSceneOutlineAnchors } from '../src/quality-node-presets.ts'
import { SCENE_OUTLINE_STRUCTURE_CONTRACT, SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER, refreshSceneOutlineAnchorPrompt } from '../src/scene-outline-prompt.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-fresh-outline-structure.json', import.meta.url), 'utf8'))
const validate = (candidate: Record<string, unknown>) => validateHistoricalStructuredOutput('history.scene-outline', candidate, fixture.expected)

test('the real first fresh outline reports missing context, wrong function and every unknown payoff ID together', () => {
  const candidate = structuredClone(fixture.candidate)
  const snapshot = JSON.stringify(candidate)
  assert.throws(() => validate(candidate), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /scenes\[10\]\.contextPayload 必须是对象/)
    assert.match(error.message, /timePlace、geographicFocus、historicalBackground、narration/)
    assert.match(error.message, /dramaticScenes\.drama-08\.function 无效：收到 "payoff"/)
    assert.match(error.message, /仅允许 conflict、setup、consequence、transition/)
    assert.match(error.message, /episodeDrama\.payoff\.beatIds 引用不存在的 beat-34/)
    assert.match(error.message, /episodeDrama\.payoff\.beatIds 引用不存在的 beat-35/)
    return true
  })
  assert.equal(JSON.stringify(candidate), snapshot)
  const normalized = normalizeDramaOutline(candidate, fixture.expected)
  assert.deepEqual(normalized.episodeDrama, candidate.episodeDrama, 'normalization never guesses a payoff binding')
  assert.equal(candidate.dramaticScenes.at(-1).function, 'payoff', 'unsupported functions require an authored correction')
  assert.equal(candidate.scenes[10].contextPayload, undefined, 'missing context is not fabricated locally')
})

test('one complete structural correction passes the same runtime contract within the two-generation budget', () => {
  const candidate = structuredClone(fixture.candidate), budget = createDramaGenerationBudget(undefined, 2)
  budget.consume()
  let message = ''
  try { validate(candidate) } catch (error) { message = (error as Error).message }
  const prompt = buildSceneOutlineRepairSuffix('approved original prompt', message, candidate)
  assert.match(prompt, /live_action 有史实旁白的 context_bridge 同样需要/)
  assert.match(prompt, /payoff 仅属于 scenes\[\]\.editorialRole/)
  assert.match(prompt, /双方一致的实际节拍为权威/)
  assert.match(prompt, /不新增、删除、重编号或改写 requiredBeats/)
  assert.deepEqual(JSON.parse(prompt.split('【上一版未通过的 JSON】\n').at(-1)!), candidate)

  // Represent the writer's complete correction, without changing any existing
  // action, dialogue, identity, scene ordering or original source boundary.
  const repaired = structuredClone(candidate), bridge = repaired.scenes[10]
  const ending = repaired.dramaticScenes.at(-1)
  repaired.episodeDrama.payoff.beatIds = [...ending.beatIds]
  ending.function = 'consequence'
  bridge.contextPayload = {
    timePlace: '十余年间，青徐幽冀荆扬兗豫八州',
    geographicFocus: ['青州', '徐州', '幽州', '冀州', '荆州', '扬州', '兗州', '豫州'],
    historicalBackground: bridge.requiredBeats[0].observable.audio[0],
    narration: bridge.requiredBeats[0].observable.audio[0],
  }
  budget.consume()
  const accepted = validate(repaired) as typeof repaired
  assert.equal(accepted.scenes.length, candidate.scenes.length)
  assert.equal(budget.used, 2)
  assert.equal(budget.canConsume(), false)
  assert.deepEqual(repaired.scenes.map((scene: { requiredBeats: unknown }) => scene.requiredBeats), candidate.scenes.map((scene: { requiredBeats: unknown }) => scene.requiredBeats))
  assert.deepEqual(repaired.historicalLocks, candidate.historicalLocks)
  assert.deepEqual(repaired.characterDramas, candidate.characterDramas)
  for (const field of ['function', 'payload', 'reference']) {
    const defective = structuredClone(repaired)
    if (field === 'function') defective.dramaticScenes.at(-1).function = 'payoff'
    if (field === 'payload') delete defective.scenes[10].contextPayload
    if (field === 'reference') defective.episodeDrama.payoff.beatIds = ['invented-beat']
    assert.throws(() => validate(defective), /HISTORY_DRAMA_INVALID/)
  }
})

test('current-schema managed prompts receive the structural contract without replacing authored configuration', () => {
  const prompt = `custom opening\n${SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER}custom ending`
  const source = { id: 'wf-sanguo-history-drama', schemaVersion: 144, edges: [{ from: 'a', to: 'b' }], nodes: [
    { id: 'sanguo-scene-outline', kind: 'text', prompt, params: [], resultVar: 'outline_candidate', modelId: 'configured-writer' },
    { id: 'custom-node', kind: 'text', prompt, params: [], resultVar: 'custom' },
  ] }
  const updated = refreshSceneOutlineAnchors(source)
  assert.equal(updated.nodes[0].prompt, `custom opening\n${SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER}${SCENE_OUTLINE_STRUCTURE_CONTRACT}custom ending`)
  assert.equal(updated.nodes[0].modelId, source.nodes[0].modelId)
  assert.equal(updated.nodes[0].params, source.nodes[0].params)
  assert.equal(updated.nodes[1], source.nodes[1])
  assert.equal(updated.edges, source.edges)
  assert.equal(updated.schemaVersion, 144)
  assert.equal(refreshSceneOutlineAnchors(updated), updated)
  assert.equal(refreshSceneOutlineAnchorPrompt('fully custom outline'), 'fully custom outline')
  assert.equal(refreshSceneOutlineAnchorPrompt(prompt + prompt), prompt + prompt, 'ambiguous duplicate insertion markers stay unchanged')
})
