import test from 'node:test'
import assert from 'node:assert/strict'
import { speechPerformanceContract } from '../src/speech-performance.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'
import { anonymousVoiceRoles, speechStagingConflict } from '../src/character-voice.ts'
import { voiceCharacterInputs } from '../src/voice-character-input.ts'

const model = { id: 'fixture', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3' } }
test('identical call and response remain separate performers; the silent reaction is not another line', () => {
  const params = { id: 'scene-any', audioType: '对白', audioText: '领队：出发！\n众人：出发！', pacing: {
    actorGroups: [{ id: 'crowd', label: '众人', memberDescription: '同行的人群' }],
    beats: [{ id: 'call', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['领队'], textOrVocalization: '出发！' },
      { id: 'response', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['crowd'], textOrVocalization: '出发！' },
      { id: 'ending', kind: 'reaction', actorIds: ['领队'], textOrVocalization: '领队颔首' }],
    schedule: [{ beatId: 'call', startSecond: 1, endSecond: 2 }, { beatId: 'response', startSecond: 2, endSecond: 4 }],
  } }
  const before = structuredClone(params)
  const contract = speechPerformanceContract(params)
  assert.match(contract, /call（1至2秒参考，领队）/)
  assert.match(contract, /response（2至4秒参考，众人）/)
  assert.match(contract, /说完即结束语言口型/)
  assert.match(contract, /不得用一次发声替代两次/)
  assert.doesNotMatch(contract, /ending（/)
  assert.deepEqual(params, before)
})
test('ambient instructions forbid invented language mouths without suppressing natural expression', () => {
  const params = { duration: 8, audioType: '环境声', audioText: '', pacingVersion: 'duration-v2', pacing: { beats: [{ kind: 'action', textOrVocalization: '指向来客' }] } }
  const request = buildKlingVideoRequest(model, '庭院里指向来客\n【同期声音与可见口型】旧版保留群体回应，不要求闭口\n渠帅躬身行礼。', params)
  assert.match(String(request.prompt), /不说话、不默念、不作连续语言口型/)
  assert.match(String(request.prompt), /自然呼吸、微笑及非语言表情照常/)
  assert.match(String(request.prompt), /渠帅躬身行礼/)
  assert.doesNotMatch(String(request.prompt), /群体回应|不要求闭口|闭口摆拍|无词声部也须真实可听/)
  assert.match(String(request.negative_prompt), /额外对白，群体喊话/)
  assert.throws(() => buildKlingVideoRequest(model, '景'.repeat(2500), params), /STORYBOARD_PROMPT_OVERLOAD/)
})

test('an authored wordless vocalization remains audible even with an empty dialogue field', () => {
  const request = buildKlingVideoRequest(model, '山野里众人欢呼。', { duration: 5, qualityDisposition: 'manual-review-v1',
    audioType: '环境声', audioText: '', pacingVersion: 'duration-v2', pacing: {
      actorGroups: [{ id: 'crowd', label: '众人', memberDescription: '同行的人群' }],
      beats: [{ id: 'cheer', kind: 'vocalization', actorIds: ['crowd'], textOrVocalization: '无词欢呼' }],
    } })
  assert.match(String(request.prompt), /无词声部也须真实可听/)
  assert.match(String(request.prompt), /表演与声音同时发生/)
  assert.doesNotMatch(String(request.prompt), /本镜没有语言声部/)
  assert.doesNotMatch(String(request.negative_prompt), /群体喊话/)
})
test('narration stays outside the visible cast, without claiming lip-sync verification', () => {
  const result = speechPerformanceContract({ audioType: '旁白', pacing: { beats: [{ id: 'n', kind: 'speech', deliveryStyle: 'narration', actorIds: [] }] } })
  assert.match(result, /旁白）：画外发声，画内不跟随口型/)
  assert.doesNotMatch(result, /已验证|已通过/)
})

test('a named actor visible speech obligation cannot be negated by an offscreen label', () => {
  const result = speechPerformanceContract({ audioType: '对白', audioText: '领队（画外）：出发！', pacing: {
    beats: [{ id: 'call', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['领队'], textOrVocalization: '出发！', lipSync: 'required', completion: { modality: 'audio-visual' } }],
  } })
  assert.match(result, /本人同期发声/)
  assert.doesNotMatch(result, /画外发声/)
})

test('independent picture projection does not reintroduce narration from its retained authored beats', () => {
  const result = speechPerformanceContract({ audioType: '环境声', audioText: '', pacingVersion: 'independent-narration-v1',
    pacing: { beats: [{ id: 'n', kind: 'speech', deliveryStyle: 'narration', actorIds: [], textOrVocalization: '原旁白' }] } })
  assert.match(result, /画外人声由独立音轨提供/)
  assert.match(result, /不生成任何配音/)
  assert.doesNotMatch(result, /n（|本人同期发声/)
})

test('replacing an old native voice guard preserves all later authored speech and actions', () => {
  for (const pacingVersion of ['duration-v2', 'dynamic-v1']) {
    const params = { duration: 6, pacingVersion, audioType: '对白', audioText: '张角：黄天当立！',
      pacing: { beats: [{ id: 'line', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['张角'], textOrVocalization: '黄天当立！' }] } }
    const request = buildKlingVideoRequest(model, '人物进门。\r\n【同期声音与可见口型】旧版约束。\r\n张角说：黄天当立！\n说完转身离开。', params)
    assert.match(String(request.prompt), /张角说：黄天当立！/)
    assert.match(String(request.prompt), /说完转身离开/)
    assert.doesNotMatch(String(request.prompt), /旧版约束/)
    assert.equal(String(request.prompt).match(/【同期声音与可见口型】/g)?.length, 1)
  }
})

test('explicit visible speech wording cannot route an offscreen-labelled actor into silent picture projection', () => {
  const makeShot = (performanceInstruction: string) => ({ id: 'scene', audioType: '对白', audioText: '弟子（画外）：请饮符水。', pacing: {
    actorGroups: [{ id: 'disciple', label: '弟子', memberDescription: '传道者' }],
    beats: [{ id: 'line', kind: 'speech', actorIds: ['disciple'], deliveryStyle: 'dialogue', textOrVocalization: '请饮符水。', performanceInstruction, completion: { modality: 'audio' } }],
  } })
  for (const instruction of ['嘴唇清晰可见。', '张口讲述。', '口型与台词一致。', '不要让听众开口，嘴唇清晰可见，张口讲述，口型与台词一致。']) {
    const shot = makeShot(instruction)
    assert.equal(speechStagingConflict(shot, 'disciple')?.code, 'VOICE_STAGING_CONFLICT', instruction)
    assert.equal(anonymousVoiceRoles(shot)[0].offscreen, false, instruction)
    assert.throws(() => voiceCharacterInputs([], shot), /VOICE_STAGING_CONFLICT/)
    assert.doesNotMatch(speechPerformanceContract(shot), /画外发声/)
  }
  const negated = makeShot('不要求嘴唇清晰可见；不要张口讲述；口型无需与台词一致。')
  assert.equal(speechStagingConflict(negated, 'disciple'), undefined)
  assert.equal(anonymousVoiceRoles(negated)[0].offscreen, true)
})
