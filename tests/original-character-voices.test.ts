import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { voiceSchema } from '../server/character-voices.ts'
import { ensureOriginalCharacterVoice, originalVoiceSchema } from '../server/original-character-voices.ts'
import { buildVoiceDesignInput, voiceDesignEndpoint } from '../server/bailian-voice-design.ts'
import { addOriginalVoiceNode } from '../src/original-voice-workflow.ts'

const model = { id: 'tts', provider: 'Bailian', capability: 'audio', settings: { model: 'qwen-audio-3.0-tts-plus', apiKey: 'test', endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', voice: 'preset-must-not-be-used' } }
test('voice node executes even when portrait creation is skipped and migration is idempotent', () => {
  const base = { title: 'node', prompt: '', params: [], position: { x: 0, y: 0 }, resultVar: 'result', parentId: 'loop', kind: 'asset', operation: '', childIds: [] as string[] }
  const workflow = { nodes: [{ ...base, id: 'loop', kind: 'loop', childIds: ['lookup', 'archive', 'video'] }, { ...base, id: 'lookup', operation: 'character.lookup', resultVar: 'cast' }, { ...base, id: 'archive', operation: 'character.archive', runIf: { path: 'cast.missing', equals: true } }, { ...base, id: 'video', kind: 'video' }], edges: [{ id: 'out', from: 'archive', to: 'video' }] }
  const next = addOriginalVoiceNode(workflow, 'tts')
  const voice = next.nodes.find(n => n.operation === 'character.voice-design')!
  assert.equal(voice.runIf, undefined)
  assert.equal(voice.params[0].value, '${cast.voiceCharacters}')
  const voiceArchive = next.nodes.find(n => n.operation === 'character.voice-archive')!
  assert.ok(next.edges.some(e => e.from === voice.id && e.to === voiceArchive.id))
  assert.ok(next.edges.some(e => e.from === voiceArchive.id && e.to === 'archive'))
  assert.ok(next.edges.some(e => e.from === 'archive' && e.to === 'video'))
  assert.deepEqual(next.nodes[0].childIds, ['lookup', voice.id, voiceArchive.id, 'archive', 'video'])
  assert.equal(workflow.nodes.length, 4)
  assert.equal(addOriginalVoiceNode(next, 'tts'), next)
})
test('original design uses descriptive creation API and configured workspace, never configured preset', () => {
  assert.equal(voiceDesignEndpoint(model), 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization')
  const request = buildVoiceDesignInput(model, '低沉而温和，清晰自然的中年男声', '天色渐渐暗了下来，大家先坐下来慢慢说。', 'voice123')
  assert.equal(request.model, 'voice-enrollment')
  assert.equal(request.input.action, 'create_voice')
  assert.equal(request.input.target_model, model.settings.model)
  assert.ok(!JSON.stringify(request).includes('preset-must-not-be-used'))
})
test('persistent original voice is created once, recalled after portrait change, and ambiguous creation never repeats', { skip: !process.env.VOICE_TEST_DATABASE_URL }, async () => {
  const schema = `original_voice_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  try {
    await db.query(voiceSchema + originalVoiceSchema)
    await db.query(`create table character_assets(id text primary key,asset_type text,workflow_id text,character_name text,metadata jsonb); insert into character_assets values('a','three-view','wf','甲','{"continuityKey":"same"}'),('b','three-view','wf','甲','{"continuityKey":"same"}'),('c','three-view','wf','乙','{"continuityKey":"other"}')`)
    let creates = 0
    const call = async (_model: typeof model, body: object) => {
      const input = (body as { input: { action: string } }).input
      if (input.action === 'create_voice') { creates++; return { output: { voice_id: 'original' } } }
      return { output: { voice_id: 'original', status: 'OK' } }
    }
    const first = await ensureOriginalCharacterVoice(db, 'a', model, '沉稳自然的男声', { call })
    assert.equal(first.cached, false)
    const recalled = await ensureOriginalCharacterVoice(db, 'b', model, '描述变化也不能自动换声', { call })
    assert.equal(recalled.voiceId, first.voiceId)
    assert.equal(recalled.characterId, first.characterId)
    assert.equal(recalled.cached, true)
    assert.equal(creates, 1)
    assert.equal((await ensureOriginalCharacterVoice(db, 'a', model, '后镜不应重写已有音色'.repeat(100), { call })).cached, true)
    await assert.rejects(ensureOriginalCharacterVoice(db, 'a', { ...model, settings: { ...model.settings, model: 'qwen-audio-3.0-tts-flash' } }, '男声', { call }), /VOICE_DESIGN_SCOPE/)
    let uncertainCreates = 0
    const uncertain = async (_model: typeof model, body: object) => {
      if ((body as { input: { action: string } }).input.action === 'create_voice') { uncertainCreates++; throw Error('connection lost') }
      return { output: { voice_list: [] } }
    }
    await assert.rejects(ensureOriginalCharacterVoice(db, 'c', model, '明亮青年男声', { call: uncertain }), /connection lost/)
    await assert.rejects(ensureOriginalCharacterVoice(db, 'c', model, '明亮青年男声', { call: uncertain }), /VOICE_DESIGN_UNCERTAIN/)
    assert.equal(uncertainCreates, 1)
  } finally { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() }
})
