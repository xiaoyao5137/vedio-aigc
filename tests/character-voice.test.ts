import test from 'node:test'
import assert from 'node:assert/strict'
import { compileKlingVoices, knownVoiceSpeakers, resolveShotVoices, voiceSpeakers, type CharacterVoice, type VoiceManifest } from '../src/character-voice.ts'
import { buildKlingVideoRequest, callKlingVideo } from '../server/model-adapters.ts'
import { buildCustomVoiceRequest, callKlingAsset, extractKlingVoices, klingAssetBase } from '../server/kling-voices.ts'
import { bindVideoVoices } from '../server/character-voices.ts'

const voice: CharacterVoice = { characterId: 'cao', characterName: '曹操', voiceId: 'v1', voiceName: '沉稳', version: 1, accountScope: 'account', modelId: 'kling', previewUrl: 'https://example.com/voice.mp3', elementId: '893605946402811985' }
const manifest: VoiceManifest = { version: 'character-voice-v1', executionId: 'run', characters: [voice] }
const model = { id: 'kling', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3', endpoint: 'https://api-beijing.klingai.com/v1/videos/image2video', apiKey: 'test' } }

test('same character is resolved across shots without modifying the saved version', () => {
  for (const line of ['曹操：走吧。', '曹操（低语）：停下。']) {
    assert.deepEqual(resolveShotVoices(manifest, voiceSpeakers({ audioText: line })), [voice])
  }
  assert.throws(() => resolveShotVoices(manifest, ['刘备']), /VOICE_BINDING_MISSING/)
  assert.throws(() => resolveShotVoices({ ...manifest, characters: [voice, { ...voice, characterId: 'other' }] }, ['曹操']), /VOICE_IDENTITY_AMBIGUOUS/)
})
test('speech beats include offscreen narration and do not clone group vocals as a person', () => {
  assert.deepEqual(voiceSpeakers({ pacing: { beats: [
    { kind: 'speech', actorIds: ['曹操'], deliveryStyle: 'dialogue' },
    { kind: 'speech', actorIds: ['narrator'], deliveryStyle: 'narration' },
    { kind: 'vocalization', actorIds: ['crowd'] },
  ] } }), ['曹操', '旁白'])
  assert.throws(() => voiceSpeakers({ pacing: { beats: [{ kind: 'speech', actorIds: ['a', 'b'] }] } }), /VOICE_IDENTITY_AMBIGUOUS/)
})
test('dialogue identity and speaker turns cannot diverge between text and compiled beats', () => {
  const params = { audioType: '对白', audioText: '曹操（低语）：走吧。\n刘备：遵命。', pacing: { version: 'duration-v2', beats: [
    { id: 'cao-1', kind: 'speech', actorIds: ['曹操'], deliveryStyle: 'dialogue' },
    { id: 'liu-1', kind: 'speech', actorIds: ['刘备'], deliveryStyle: 'dialogue' },
  ] } }
  assert.deepEqual(voiceSpeakers(params), ['曹操', '刘备'])
  for (const audioText of ['曹操：走吧。\n张飞：遵命。', '刘备：遵命。\n曹操：走吧。', '曹操：走吧。', '', '曹操：走吧。\n没有说话人']) {
    assert.throws(() => voiceSpeakers({ ...params, audioText }), /VOICE_IDENTITY_AMBIGUOUS/)
    assert.throws(() => compileKlingVoices('', { ...params, audioText }, 'kling-v3-omni', true), /VOICE_IDENTITY_AMBIGUOUS/)
  }
  const split = { ...params, audioText: '曹操：换成不同措辞。\n曹操：继续同一轮。\n刘备：回答。', pacing: { ...params.pacing,
    beats: [params.pacing.beats[0], { ...params.pacing.beats[0], id: 'cao-2' }, params.pacing.beats[1]] } }
  assert.deepEqual(voiceSpeakers(split), ['曹操', '刘备'], 'identity validation does not add a word-content quality gate')
  assert.deepEqual(voiceSpeakers({ ...params, audioType: '旁白', audioText: '无需说话人标签的旁白。\n下一行旁白。', pacing: { beats: [
    { kind: 'speech', actorIds: ['旁白'], deliveryStyle: 'narration' },
  ] } }), ['旁白'])
})
test('named route rejects actor/text mismatch and visible-offscreen conflicts before accessing bindings', async () => {
  let queries = 0
  const db = { query: async () => { queries++; throw Error('must reject before voice lookup') } }
  const params = { audioType: '对白', audioText: '曹操（画外）：出发。', pacing: { beats: [
    { kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['曹操'], lipSync: 'required' },
  ] } }
  const request = { model, params, executionContext: { voicePolicy: 'strict', voiceExecutionId: 'run', workflowId: 'wf' } }
  await assert.rejects(bindVideoVoices(db as never, request), /VOICE_STAGING_CONFLICT/)
  await assert.rejects(bindVideoVoices(db as never, { ...request, params: { ...params, audioText: '刘备：出发。' } }), /VOICE_IDENTITY_AMBIGUOUS/)
  assert.equal(queries, 0)
})
test('standard v3 voice control is blocked before a provider POST, matching real code 1201 rejection', async () => {
  let calls = 0
  await assert.rejects(callKlingVideo(model, '曹操说：走吧。', { sound: 'on', characterVoices: [voice] }, { fetch: async () => { calls++; return new Response('{}') } }), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.equal(calls, 0)
  assert.throws(() => buildKlingVideoRequest(model, '旁白', { sound: 'on', referenceImage: 'https://example.com/frame.jpg', characterVoices: [{ ...voice, characterName: '旁白' }] }), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.throws(() => compileKlingVoices('旁白', { sound: 'on', characterVoices: [{ ...voice, characterName: '旁白' }] }, 'kling-v3-omni', true), /画外旁白/)
})
test('Omni keeps image references and uses voice-bound elements, preserving 64-bit IDs', () => {
  const result = buildKlingVideoRequest(model, '曹操说：走吧。@参考附件1', { sound: 'on', referenceImages: ['https://example.com/a.png'], characterVoices: [voice] })
  assert.deepEqual(result.element_list, [{ element_id: '893605946402811985' }])
  assert.match(String(result.prompt), /<<<image_1>>>/)
  assert.match(String(result.prompt), /曹操对应<<<element_1>>>/)
  assert.equal(result.voice_list, undefined)
})
test('standalone voice control is restricted to documented v2.6 image pro 5 or 10 second requests', () => {
  const v26 = { ...model, settings: { ...model.settings, model: 'kling-v2-6', mode: 'pro', sound: 'on', duration: '5' } }
  const params = { referenceImage: 'https://example.com/a.jpg', characterVoices: [{ ...voice, characterName: '旁白', elementId: undefined }] }
  const result = buildKlingVideoRequest(v26, '空镜头，画外旁白', params)
  assert.deepEqual(result.voice_list, [{ voice_id: 'v1' }])
  assert.match(String(result.prompt), /仅作为画外声音/)
  assert.equal(result.model_name, 'kling-v2-6')
  for (const invalid of [{ mode: 'std' }, { duration: 6 }, { endImage: 'https://example.com/end.jpg' }, { referenceImage: '' }]) assert.throws(() => buildKlingVideoRequest(v26, '旁白', { ...params, ...invalid }), /VOICE_PROVIDER_UNSUPPORTED/)
})
test('binding cannot disappear through model downgrade, truncation or reference capacity', () => {
  assert.throws(() => compileKlingVoices('', { sound: 'on', characterVoices: [voice] }, 'kling-v2', false), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.throws(() => compileKlingVoices('', { sound: 'off', characterVoices: [voice] }, 'kling-v3', false), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.throws(() => compileKlingVoices('', { sound: 'on', characterVoices: [{ ...voice, elementId: undefined }] }, 'kling-v3-omni', true), /VOICE_ELEMENT_MISSING/)
  assert.throws(() => buildKlingVideoRequest(model, '长'.repeat(2490), { sound: 'on', referenceImages: ['https://example.com/a.png'], characterVoices: [voice] }), /STORYBOARD_PROMPT_OVERLOAD/)
  assert.throws(() => compileKlingVoices('', { sound: 'on', referenceImages: Array.from({ length: 7 }, (_,i) => String(i)), characterVoices: [voice] }, 'kling-v3-omni', true), /VOICE_PROVIDER_UNSUPPORTED/)
})
test('asset routing preserves configured account host and gateway prefix', () => {
  assert.equal(klingAssetBase(model.settings.endpoint), 'https://api-beijing.klingai.com/v1/general')
  assert.equal(klingAssetBase('https://example.com/kling/v1/videos/omni-video'), 'https://example.com/kling/v1/general')
  assert.throws(() => klingAssetBase('https://example.com/new-api'), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.throws(() => buildCustomVoiceRequest({ voiceName: '声音', voiceUrl: 'file:///tmp/a', externalTaskId: 'x' }), /HTTP/)
})
test('provider application errors do not count as successful assets', async () => {
  await assert.rejects(callKlingAsset(model, 'presets-voices', undefined, async () => new Response(JSON.stringify({ code: 1002, message: 'invalid credentials' }), { status: 200 })), /VOICE_PROVIDER_ERROR/)
  const data = await callKlingAsset(model, 'advanced-custom-elements/1', undefined, async () => new Response('{"code":0,"data":{"element_id":893605946402811985}}'))
  assert.equal((data.data as {element_id: string}).element_id, '893605946402811985')
  assert.deepEqual(extractKlingVoices({ data: [{ task_result: { voices: [{ voice_id: '1', voice_name: '甲', trial_url: 'https://example.com/a', owned_by: 'kling' }] } }] }), [{ voiceId: '1', voiceName: '甲', previewUrl: 'https://example.com/a', source: 'preset' }])
})

test('known speaker preflight reads explicit active shot inputs without traversing historical evidence', () => {
  const names = knownVoiceSpeakers([
    { audioText: '曹操：出发。' },
    { pacing: { beats: [{ kind: 'speech', actorIds: ['刘备'] }] } },
    { audioType: '旁白', audioText: '天色已晚。' },
    { audioText: '${future.audioText}', pacing: { beats: [{ kind: 'speech', actorIds: ['${future.actor}'] }] } },
    { raw: { audioText: '旧人物：旧台词。' }, previous: { audioText: '历史人物：旧台词。' } },
  ])
  assert.deepEqual(names, ['曹操', '刘备', '旁白'])
  assert.throws(() => knownVoiceSpeakers([{ audioText: '没有明确说话人的已知对白' }]), /VOICE_IDENTITY_AMBIGUOUS/)
})
