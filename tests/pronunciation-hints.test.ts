import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePronunciationHints, pronunciationInstruction, refreshPronunciationStoryboardPrompt } from '../src/pronunciation-hints.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'
import { projectIndependentNarration } from '../server/narration-projection.ts'
import { narrationSynthesisParameters } from '../server/independent-narration.ts'
import { buildBailianTtsParameters } from '../server/bailian-tts.ts'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'
import type { ExternalModelConfig } from '../server/model-adapters.ts'

const hint = { term: '银行', pinyin: ['yin2', 'hang2'], meaning: '金融机构', source: '字典中银行词条' }
const model: ExternalModelConfig = { id: 'video', name: 'video', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3-omni' } }
test('reading guides bind exact spoken characters, tones and contextual source without replacing text', () => {
  const source = [hint], body = '讲者：门前有一家银行。'
  assert.deepEqual(normalizePronunciationHints(source, body), source)
  assert.equal(pronunciationInstruction(undefined, body), '')
  for (const invalid of [[{ ...hint, term: '银杭' }], [{ ...hint, pinyin: ['yin', 'hang'] }], [{ ...hint, pinyin: ['yin2'] }], [{ ...hint, pinyin: ['abcdefg2', 'vvvv3'] }],
    [{ ...hint, source: '' }], [hint, hint], [{ ...hint, term: '讲者', pinyin: ['jiang3', 'zhe3'] }]]) {
    assert.throws(() => normalizePronunciationHints(invalid, body), /PRONUNCIATION_HINT_INVALID/)
  }
  assert.throws(() => normalizePronunciationHints([hint, { ...hint, term: '行', pinyin: ['xing2'] }], body), /冲突/)
  assert.equal(normalizePronunciationHints([hint, { ...hint, term: '行', pinyin: ['hang2'] }], body).length, 2)
})
test('Kling receives a separate guide and rejects prompt overflow instead of clipping instructions', () => {
  const params = { audioType: '旁白', audioText: '门前有一家银行。', pronunciationHints: [hint], duration: 5, sound: 'on' }
  const before = structuredClone(params), request = buildKlingVideoRequest(model, '门前有一家银行。', params)
  assert.match(String(request.prompt), /银行=yin2 hang2/)
  assert.match(String(request.prompt), /不朗读拼音/)
  assert.match(String(request.prompt), /门前有一家银行。/)
  assert.deepEqual(params, before)
  assert.throws(() => buildKlingVideoRequest(model, '景'.repeat(2490), params), /STORYBOARD_PROMPT_OVERLOAD/)
  assert.throws(() => validateWorkflowMediaContract({ model, params: { ...params, audioText: '门前有人。' } }), /PRONUNCIATION_HINT_INVALID/)
})
test('independent narration sends guidance only to TTS and keeps picture request identity unchanged', () => {
  const params = { duration: 5, audioType: '旁白', audioText: '门前有一家银行。', pacing: {
    beats: [{ id: 'n', kind: 'speech', deliveryStyle: 'narration', actorIds: ['旁白'], textOrVocalization: '门前有一家银行。' }],
    schedule: [{ beatId: 'n', startSecond: 0, endSecond: 4 }], timelineWindows: [] } }
  const original = projectIndependentNarration('银行门口', params)
  const guided = projectIndependentNarration('银行门口', { ...params, pronunciationHints: [hint] })
  assert.deepEqual(guided.params, original.params)
  assert.equal(guided.prompt, original.prompt)
  assert.equal(guided.segments[0].text, params.audioText)
  const tts: ExternalModelConfig = { id: 'tts', name: 'tts', provider: 'Bailian', capability: 'audio', settings: { model: 'tts', instruction: '语速自然。' } }
  const voice = { voiceId: 'frozen', characterId: 'narrator', modelId: 'tts', accountScope: 'account', targetModel: 'tts', synthesisSeed: 123 }
  const synthesis = narrationSynthesisParameters(tts, voice, guided.segments[0])
  assert.equal(synthesis.voice, 'frozen'); assert.equal(synthesis.seed, 123)
  assert.match(String(synthesis.instruction), /语速自然。\n【发音指导】/)
  assert.match(String(buildBailianTtsParameters(tts.settings, synthesis).instruction), /银行=yin2 hang2/)
  const split = { ...params, pronunciationHints: [hint], pacing: { ...params.pacing,
    beats: [{ id: 'a', kind: 'speech', deliveryStyle: 'narration', textOrVocalization: '门前有一家银' },
      { id: 'b', kind: 'speech', deliveryStyle: 'narration', textOrVocalization: '行。' }],
    schedule: [{ beatId: 'a', startSecond: 0, endSecond: 3 }, { beatId: 'b', startSecond: 3, endSecond: 4 }] } }
  assert.throws(() => projectIndependentNarration('银行门口', split), /跨越独立合成节拍/)
  const repeated = structuredClone(split)
  repeated.audioText = '银行就在前面。这家银行很大。'
  repeated.pacing.beats[0].textOrVocalization = '银行就在前面。这家银'
  repeated.pacing.beats[1].textOrVocalization = '行很大。'
  assert.throws(() => projectIndependentNarration('银行门口', repeated), /跨越独立合成节拍/)
})
test('managed workflow carries optional guides and refreshes writer instructions idempotently', () => {
  const node = (id: string) => ({ id, kind: 'video', params: [], prompt: '原正文', code: '' })
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 144, nodes: [node('sanguo-shot-script'), node('sanguo-video')] }
  const next = upgradePrincipleQuality(workflow)
  assert.equal(upgradePrincipleQuality(next), next)
  const binding = next.nodes[1].params.find(p => p.englishName === 'pronunciationHints')
  assert.equal(binding?.value, '${shot_script.pronunciationHints}'); assert.equal(binding?.required, false)
  assert.match(next.nodes[0].prompt, /语境读音契约/)
  assert.equal(refreshPronunciationStoryboardPrompt(next.nodes[0].prompt), next.nodes[0].prompt)
})
