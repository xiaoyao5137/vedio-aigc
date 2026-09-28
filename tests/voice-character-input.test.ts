import test from 'node:test'
import assert from 'node:assert/strict'
import { voiceCharacterInputs, voiceCandidateOutput, characterVoiceDesignDescription, withApprovedVoiceCasting } from '../src/voice-character-input.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'

test('voice creation returns candidates to downstream archive instead of reducing output to a preview URL', () => {
  const output = { items: [{ contract: 'voice-candidate-v2', voiceId: 'original', continuityKey: 'actor', previewUrl: '/generated/sample.wav' }], cachedCount: 0 }
  assert.equal(voiceCandidateOutput(output), output)
  assert.equal(voiceCandidateOutput(output).items[0].voiceId, 'original')
  assert.throws(() => voiceCandidateOutput({ url: '/generated/sample.wav' }), /VOICE_CANDIDATE_INVALID/)
})

test('off-screen narrator joins voice candidates without mutating portrait identities', () => {
  const visual = [{ name: '郭泰', continuityKey: 'guotai', description: '青年男子' }]
  const first = voiceCharacterInputs(visual, { audioType: '旁白', audioText: '郭泰前来求见。' })
  const later = voiceCharacterInputs([], { pacing: { beats: [{ kind: 'speech', deliveryStyle: 'narration', actorIds: ['旁白'], text: '稍后。' }] } })
  assert.deepEqual(visual, [{ name: '郭泰', continuityKey: 'guotai', description: '青年男子' }])
  assert.equal(first.length, 1)
  assert.deepEqual(first[0], later[0])
  assert.equal(first[0].continuityKey, '__narrator__')
  assert.equal(voiceCharacterInputs(visual, { audioType: '对白', audioText: '郭泰：在下告辞。' })[0].continuityKey, 'voice:郭泰')
  assert.deepEqual(voiceCharacterInputs(visual, { audioType: '环境声', audioText: '' }), [])
})

test('voice casting uses explicit profiles or descriptive evidence without assigning a default gender', () => {
  const instruction = '按人物资料描述年龄感、音高、共鸣、质感和说话气质，创建原创音色。'
  const character = { name: '传道弟子', description: '张角弟子一人，身着布衣，站在集市空地上向百姓讲述' }
  assert.throws(() => characterVoiceDesignDescription(character, instruction), /VOICE_PROFILE_REQUIRED/)
  const neutral = characterVoiceDesignDescription({ ...character, voiceProfile: { pitch: '中低', texture: '温润', genderPresentation: '中性' } }, instruction)
  assert.match(neutral, /音高：中低；质感：温润；声音性别表现：中性/)
  assert.doesNotMatch(neutral, /男性|女性|男声|女声/)
  const source = characterVoiceDesignDescription({ name: '角色乙', description: '青年女子，身着布衣' }, instruction)
  assert.match(source, /青年女子/)
  assert.equal(characterVoiceDesignDescription(character, instruction, { description: '轻柔而清晰的声音' }), '轻柔而清晰的声音')
  assert.match(characterVoiceDesignDescription(character, instruction, { voiceProfile: { resonance: '胸腔共鸣明显' } }), /共鸣：胸腔共鸣明显/)
})

test('language-only structured profiles cannot authorize unspecified voice casting', () => {
  const character = { name: '传道弟子', description: '持符水向百姓传道的弟子', voiceProfile: { language: '普通话' } }
  assert.throws(() => characterVoiceDesignDescription(character, '按角色资料生成原创声音'), /VOICE_PROFILE_REQUIRED/)
  assert.throws(() => characterVoiceDesignDescription(character, '', { voiceProfile: { language: '普通话', pitch: '  ' } }), /VOICE_PROFILE_REQUIRED/)
  const neutral = characterVoiceDesignDescription(character, '', { voiceProfile: { language: '普通话', genderPresentation: '中性' } })
  assert.match(neutral, /声音性别表现：中性；语言：普通话/)
  assert.doesNotMatch(neutral, /男性|女性|男声|女声/)
  assert.match(characterVoiceDesignDescription({ ...character, description: '中低音，温润声线' }, ''), /语言：普通话/)
})

test('approved portrayal gives a named first-time speaker a grounded artistic voice direction', async () => {
  const shot = { audioType: '对白', audioText: '严颜：只有断头将军，没有投降将军。',
    characters: ['张飞', '严颜'], pacing: { beats: [{ kind: 'speech', actorIds: ['严颜'], deliveryStyle: 'dialogue' }] } }
  const characters = [
    { name: '张飞', description: '军中主将' },
    { name: '严颜', description: '黑发黑须，灰褐战袍', visualContext: {
      version: 'character-visual-context-v1', age: { stage: 'mature', basis: 'artistic', asOf: '江州之战；具体年岁未载' },
      look: { key: 'jiangzhou-campaign', description: '灰褐战袍与旧色札甲' },
    } },
  ]
  const outline = { characterDramas: [
    { name: '张飞', speechStyle: '短句直问' },
    { name: '严颜', speechStyle: '主语清楚，语速平稳；拒绝说完整，临刑反问简短，不求饶。' },
  ] }
  const cast = withApprovedVoiceCasting(characters, shot, outline)
  assert.equal(cast[0], characters[0], 'silent listener receives no speculative voice')
  assert.match(String((cast[1] as typeof characters[1] & {voiceProfile: {age: string}}).voiceProfile.age), /成熟成年感.*选角设定.*不代表史实岁数/)
  assert.match(characterVoiceDesignDescription(cast[1], '原创自然声线'), /语速平稳.*不求饶/)
  assert.doesNotMatch(JSON.stringify((cast[1] as {voiceProfile?: unknown}).voiceProfile), /男性|女性|男声|女声|genderPresentation/)
  const pool = { async query(sql: string) {
    if (sql.includes('from character_assets') || sql.includes('from original_character_voices') || sql.includes('from voice_characters')) return { rows: [] }
    throw Error(`unexpected query: ${sql}`)
  } }
  const lookup = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: {
    workflowId: 'wf', characters: cast, includeVoices: true, shot,
  } }) as {voiceCharacters: Array<{name: string; voiceProfile?: unknown}>; existingVoices: unknown[]}
  assert.equal(lookup.voiceCharacters.length, 1)
  assert.equal(lookup.voiceCharacters[0].name, '严颜')
  assert.deepEqual(lookup.voiceCharacters[0].voiceProfile, (cast[1] as {voiceProfile?: unknown}).voiceProfile)
  assert.deepEqual(lookup.existingVoices, [])
})

test('missing or conflicting approved voice direction cannot silently manufacture a casting profile', () => {
  const shot = { audioType: '对白', audioText: '甲：等一等。' }
  const characters = [{ name: '甲', description: '身着布衣' }]
  assert.equal(withApprovedVoiceCasting(characters, shot, {})[0], characters[0])
  assert.throws(() => characterVoiceDesignDescription(withApprovedVoiceCasting(characters, shot, {})[0], ''), /VOICE_PROFILE_REQUIRED/)
  assert.throws(() => withApprovedVoiceCasting(characters, shot, { characterDramas: [
    { name: '甲', speechStyle: '清晰' }, { name: '甲', speechStyle: '粗哑' },
  ] }), /VOICE_CASTING_DIRECTION_INVALID/)
  const explicit = [{ ...characters[0], voiceProfile: { texture: '温润' } }]
  assert.equal(withApprovedVoiceCasting(explicit, shot, { characterDramas: [{ name: '甲', speechStyle: '粗哑' }] })[0], explicit[0],
    'explicit character casting is never replaced by a scene direction')
})
