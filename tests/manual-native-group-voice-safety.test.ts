import test from 'node:test'
import assert from 'node:assert/strict'
import { compileKlingVoices, nativeGroupVoicePlan } from '../src/character-voice.ts'

function input() {
  return { qualityDisposition: 'manual-review-v1', audioType: '对白', sound: 'on', voiceSceneId: 'scene-current',
    audioText: '众百姓：愿闻其详！\n弟子：诸位请看这里。',
    pacing: { actorGroups: [{ id: 'crowd', label: '众百姓', memberDescription: '集市中的众百姓' }, { id: 'disciple', label: '弟子', memberDescription: '传道弟子' }], beats: [
      { id: 'speech-1', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['crowd'], textOrVocalization: '愿闻其详！' },
      { id: 'speech-2', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['disciple'], textOrVocalization: '诸位请看这里。' },
    ] } }
}

test('manual group voices preserve each complete speaker line and remain explicitly unbound and unverified', () => {
  const params = input(), before = structuredClone(params), plan = nativeGroupVoicePlan(params)
  assert.deepEqual(plan.map(role => role.name), ['众百姓', '弟子'])
  assert.deepEqual(plan.flatMap(role => role.speechBeats.map(beat => beat.text)), params.pacing.beats.map(beat => beat.textOrVocalization))
  assert.ok(plan.every(role => role.status === 'unbound' && role.method === 'provider-native' && role.speechVerified === false && role.lipSyncVerified === false))
  assert.deepEqual(compileKlingVoices(params.audioText, { ...params, nativeGroupVoices: plan }, 'kling-v3-omni', true).fields, {})
  assert.deepEqual(params, before)
})

test('strict mode, disabled audio, altered voice evidence and incomplete or swapped lines cannot enter native group routing', () => {
  const params = input(), plan = nativeGroupVoicePlan(params)
  assert.deepEqual(nativeGroupVoicePlan({ ...params, qualityDisposition: 'strict-v1' }), [])
  assert.throws(() => compileKlingVoices('', { ...params, qualityDisposition: 'strict-v1', nativeGroupVoices: plan }, 'kling-v3-omni', true), /VOICE_BINDING_INVALID/)
  assert.throws(() => compileKlingVoices('', { ...params, sound: 'off', nativeGroupVoices: plan }, 'kling-v3-omni', true), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.throws(() => compileKlingVoices('', { ...params, nativeGroupVoices: [{ ...plan[0], speechVerified: true }, plan[1]] }, 'kling-v3-omni', true), /VOICE_BINDING_INVALID/)
  for (const edit of [
    (value: ReturnType<typeof input>) => { value.audioText = '众百姓：愿闻其详！' },
    (value: ReturnType<typeof input>) => { value.audioText = '弟子：愿闻其详！\n众百姓：诸位请看这里。' },
    (value: ReturnType<typeof input>) => { value.pacing.beats[1].textOrVocalization = '诸位请看' },
    (value: ReturnType<typeof input>) => { value.pacing.beats[0].actorIds = ['crowd', 'disciple'] },
  ]) { const broken = input(); edit(broken); assert.throws(() => nativeGroupVoicePlan(broken), /VOICE_IDENTITY_AMBIGUOUS/) }
})

test('mixed named and group performances retain the named fixed voice element requirement', () => {
  const params = input()
  params.pacing.actorGroups.pop()
  params.pacing.beats[1].actorIds = ['张角']
  params.audioText = '众百姓：愿闻其详！\n张角：诸位请看这里。'
  const plan = nativeGroupVoicePlan(params)
  assert.deepEqual(plan.map(role => role.name), ['众百姓'])
  const voice = { characterId: 'zhangjiao', characterName: '张角', version: 3, modelId: 'voice', accountScope: 'account', voiceId: 'frozen-voice', voiceName: '张角原声', previewUrl: '/voice.mp3' }
  assert.throws(() => compileKlingVoices(params.audioText, { ...params, nativeGroupVoices: plan, characterVoices: [voice] }, 'kling-v3-omni', true), /VOICE_ELEMENT_MISSING/)
  const result = compileKlingVoices(params.audioText, { ...params, nativeGroupVoices: plan, characterVoices: [{ ...voice, elementId: '12345' }] }, 'kling-v3-omni', true)
  assert.deepEqual(result.fields.element_list, [{ element_id: '12345' }])
  assert.ok(result.prompt.includes(params.audioText))
})

test('the supported single offscreen role keeps its original independent-voice route', () => {
  const params = input()
  params.pacing.actorGroups.shift()
  params.pacing.beats.shift()
  params.audioText = '弟子（画外）：诸位请看这里。'
  assert.deepEqual(nativeGroupVoicePlan(params), [])
})

test('a same-name anonymous group cannot replace a frozen named speaker', () => {
  const params = input()
  params.pacing.actorGroups[0].label = '张角'
  params.audioText = params.audioText.replace('众百姓', '张角')
  for (const identity of [{ characters: ['张角'] }, { presentCharacters: ['张角'] }, { voiceAssets: [{ characterName: '张角', videoBinding: { voiceId: 'frozen' } }] }]) {
    assert.throws(() => nativeGroupVoicePlan({ ...params, ...identity }), /VOICE_IDENTITY_AMBIGUOUS/)
  }
})
