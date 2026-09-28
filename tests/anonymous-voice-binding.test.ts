import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { anonymousVoiceRoles, knownVoiceSpeakers, voiceSpeakers } from '../src/character-voice.ts'
import { voiceCharacterInputs } from '../src/voice-character-input.ts'
import { inferCharacterVoices } from '../server/voice-design-inference.ts'
import { archiveVoiceCandidates, lookupArchivedVoices } from '../server/voice-asset-archive.ts'
import { bindVideoVoices, voiceSchema } from '../server/character-voices.ts'
import { originalVoiceSchema } from '../server/original-character-voices.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { projectIndependentOffscreenDialogue } from '../server/narration-projection.ts'

const dialogue = '诸位父老乡亲,在下受大贤良师张角之命,四方传道。大贤良师以符水疗病,病者颇愈,已救活无数百姓。'
const shot = { id: 'scene-09', dramaticSceneId: 'drama-05', duration: 15, characters: [], audioType: '对白',
  audioText: `传道弟子(画外):${dialogue}`, pacing: {
    actorGroups: [{ id: 'disciples-preaching', label: '传道弟子', memberDescription: '已批准集市中的匿名传道弟子', voiceProfile: { pitch: '中低', texture: '温润' } }],
    beats: [{ id: 'speech', kind: 'speech', deliveryStyle: 'dialogue', actorIds: ['disciples-preaching'], textOrVocalization: dialogue }],
    schedule: [{ beatId: 'speech', startSecond: 1, endSecond: 14.775 }],
  } }

test('real scene-09 anonymous dialogue retains words and role with a stable scene voice instead of a portrait', () => {
  const before = structuredClone(shot)
  const voices = voiceCharacterInputs([], shot)
  assert.deepEqual(voiceSpeakers(shot), ['传道弟子'])
  assert.equal(voices.length, 1)
  assert.equal(voices[0].name, '传道弟子')
  assert.equal(voices[0].audioRole, 'offscreen-dialogue')
  assert.equal(voices[0].continuityKey, 'anonymous-voice:drama-05:%E4%BC%A0%E9%81%93%E5%BC%9F%E5%AD%90')
  const split = { ...shot, id: 'scene-09-part-2', pacing: { ...shot.pacing, actorGroups: [{ ...shot.pacing.actorGroups[0], id: 'new-local-group' }],
    beats: [{ ...shot.pacing.beats[0], actorIds: ['new-local-group'] }] } }
  assert.equal(voiceCharacterInputs([], split)[0].continuityKey, voices[0].continuityKey)
  assert.notEqual(voiceCharacterInputs([], { ...shot, dramaticSceneId: 'another-drama' })[0].continuityKey, voices[0].continuityKey)
  assert.deepEqual(knownVoiceSpeakers([shot, { audioText: '曹操：退下。' }]), ['曹操'], 'voice-only groups must not preflight against portrait manifests')
  const projected = projectIndependentOffscreenDialogue('集市听众听完后抬头。' + shot.audioText, shot)
  assert.equal(projected.audioRole, 'offscreen-dialogue')
  assert.equal(projected.speakerName, '传道弟子')
  assert.deepEqual(projected.segments.map(segment => segment.text), [dialogue])
  assert.equal(projected.segments[0].start, 1)
  assert.equal(projected.segments[0].end, 14.775)
  assert.match(projected.prompt, /集市听众听完后抬头/)
  assert.doesNotMatch(projected.prompt, /旁白|诸位父老乡亲/)
  assert.deepEqual(shot, before)
  assert.equal(anonymousVoiceRoles({ ...shot, audioText: shot.audioText.replace('(画外)', '') })[0].offscreen, false)
  assert.throws(() => voiceCharacterInputs([], { ...shot, audioText: shot.audioText.replace('(画外)', '') }), /VOICE_PROVIDER_UNSUPPORTED/)
})

test('anonymous voice creates, archives, recalls and freezes a real PostgreSQL identity with zero portrait writes', { skip: !process.env.VOICE_TEST_DATABASE_URL }, async () => {
  const schema = `anonymous_voice_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const root = await mkdtemp(path.join(os.tmpdir(), 'anonymous-voice-'))
  const model = { id: 'tts', provider: 'Bailian', capability: 'audio', settings: { model: 'qwen-audio-3.0-tts-plus', apiKey: 'test', endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' } }
  try {
    await db.query(voiceSchema + originalVoiceSchema)
    await db.query(`create table character_assets(id text,workflow_id text,character_name text,asset_type text,uri text,prompt text,version integer,metadata jsonb,created_at timestamptz,updated_at timestamptz)`)
    const lookup = await executeBuiltinNode(db, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [], shot, includeVoices: true } }) as { voiceCharacters: ReturnType<typeof voiceCharacterInputs>; missingCount: number }
    assert.equal(lookup.missingCount, 0)
    assert.equal(lookup.voiceCharacters[0].name, '传道弟子')
    let creates = 0
    const candidates = await inferCharacterVoices(model, '自然清晰的原创角色声音', { workflowId: 'wf', characters: lookup.voiceCharacters }, { root,
      call: async (_model, request) => {
        if (request.input.action === 'create_voice') { creates++; return { output: { voice_id: 'original-disciple' } } }
        return { output: { status: 'OK' } }
      } })
    const archived = await archiveVoiceCandidates(db, 'wf', candidates.items)
    const recalled = await lookupArchivedVoices(db, 'wf', [lookup.voiceCharacters[0].continuityKey])
    const cached = await inferCharacterVoices(model, '', { workflowId: 'wf', characters: lookup.voiceCharacters, existingVoices: recalled }, { root, call: async () => { throw Error('must reuse original voice') } })
    assert.equal(creates, 1)
    assert.equal(cached.items[0].audioRole, 'offscreen-dialogue')
    assert.equal(cached.items[0].actorGroupId, 'disciples-preaching')
    const assets = await executeBuiltinNode(db, { operation: 'character.archive', params: { workflowId: 'wf', characters: [], voiceAssets: archived.items } }) as { voiceAssets: Array<Record<string, unknown>>; items: unknown[] }
    assert.deepEqual(assets.items, [])
    assert.equal(assets.voiceAssets[0].characterName, '传道弟子')
    assert.equal(assets.voiceAssets[0].audioRole, 'offscreen-dialogue')
    assert.equal((await db.query('select count(*) from character_assets')).rows[0].count, '0')
    const request = { model: { id: 'video', provider: 'Kling', capability: 'video', settings: {} }, params: { ...shot, voiceSceneId: shot.dramaticSceneId, voiceAssets: assets.voiceAssets },
      executionContext: { voicePolicy: 'strict', voiceExecutionId: 'original-voice-scope', workflowId: 'wf' } }
    const bound = await bindVideoVoices(db, request)
    const voice = (bound.params as Record<string, unknown>).offscreenDialogueVoice as Record<string, unknown>
    assert.equal(voice.characterName, '传道弟子')
    assert.equal(voice.voiceId, 'original-disciple')
    assert.equal(voice.audioRole, 'offscreen-dialogue')
    assert.equal(voice.elementId, undefined)
    assert.equal(bound.params.audioType, '对白')
    assert.equal(bound.params.audioText, shot.audioText)
    assert.equal((bound.params as Record<string, unknown>).narrationVoice, undefined)
    const resumed = await bindVideoVoices(db, { ...request, params: { ...request.params, voiceAssets: assets.voiceAssets.map(asset => ({ ...asset, voiceId: 'changed-library-default' })) } })
    assert.deepEqual((resumed.params as Record<string, unknown>).offscreenDialogueVoice, voice)
    assert.equal((await db.query('select count(*) from execution_original_voice_manifests')).rows[0].count, '1')
    await assert.rejects(bindVideoVoices(db, { ...request, params: { ...request.params, voiceSceneId: 'wrong-source-scene' } }), /VOICE_BINDING_MISSING/)
    await assert.rejects(bindVideoVoices(db, { ...request, params: { ...request.params, audioText: shot.audioText.replace('(画外)', '') } }), /VOICE_PROVIDER_UNSUPPORTED/)
  } finally { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); await rm(root, { recursive: true, force: true }) }
})
