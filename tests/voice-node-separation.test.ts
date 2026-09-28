import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { inferCharacterVoices } from '../server/voice-design-inference.ts'
import { archiveVoiceCandidates, lookupArchivedVoices } from '../server/voice-asset-archive.ts'
import { voiceSchema, bindVideoVoices, narratorSynthesisSeed } from '../server/character-voices.ts'
import { originalVoiceSchema } from '../server/original-character-voices.ts'
import { originalVoiceScope } from '../server/bailian-voice-design.ts'
const model = { id: 'tts', provider: 'Bailian', capability: 'audio', settings: { model: 'qwen-audio-3.0-tts-plus', apiKey: 'test', endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' } }
test('inference has no database dependency and interrupted retry does not create again', async () => {
  const source = await readFile(new URL('../server/voice-design-inference.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]pg|\.query\(|archiveVoiceCandidates|ensureOriginalCharacterVoice/)
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-infer-'))
  let creates = 0
  const call = async (_model: typeof model, body: object) => {
    const action = (body as { input: { action: string } }).input.action
    if (action === 'create_voice') { creates++; return { output: { voice_id: 'original' } } }
    return { output: { status: 'OK' } }
  }
  try {
    const params = { workflowId: 'wf', characters: [{ name: '甲', continuityKey: 'a', description: '中年男子，朴实内敛' }] }
    const first = await inferCharacterVoices(model, '自然清晰的原创声音', params, { root, call })
    const second = await inferCharacterVoices(model, '自然清晰的原创声音', params, { root, call })
    assert.equal(creates, 1)
    assert.equal(first.items[0].voiceId, second.items[0].voiceId)
    assert.equal(first.generatedCount, 1)
    assert.equal(second.generatedCount, 0)
    assert.equal(second.cachedCount, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('underspecified new role does not purchase a random voice; explicit nongendered profile is sent intact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-profile-'))
  const requests: Array<{ input: { action: string; voice_prompt?: string } }> = []
  const call = async (_model: typeof model, body: object) => {
    requests.push(body as typeof requests[number])
    return { output: (body as typeof requests[number]).input.action === 'create_voice' ? { voice_id: 'deliberate-original' } : { status: 'OK' } }
  }
  try {
    const character = { name: '传道弟子', continuityKey: 'anonymous-voice:scene:disciple', description: '张角弟子一人，身着布衣，站在集市空地上向百姓讲述' }
    const params = { workflowId: 'wf', characters: [character] }
    await assert.rejects(inferCharacterVoices(model, '根据人物资料确定年龄、音高、共鸣和质感', params, { root, call }), /VOICE_PROFILE_REQUIRED/)
    assert.equal(requests.length, 0)
    const result = await inferCharacterVoices(model, '原创自然声音', { ...params, voiceProfiles: { 传道弟子: { pitch: '中低', texture: '温润', delivery: '坚定清晰' } } }, { root, call })
    assert.equal(result.generatedCount, 1)
    assert.match(requests[0].input.voice_prompt!, /音高：中低；质感：温润；说话气质：坚定清晰/)
    assert.doesNotMatch(requests[0].input.voice_prompt!, /男性|女性|男声|女声/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('legacy underspecified paid voice receipt remains resumable without recasting or changing its request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-profile-resume-'))
  try {
    const key = 'legacy-role', workflowId = 'wf'
    const hash = createHash('sha256').update(`${workflowId}:${key}:${originalVoiceScope(model)}:${model.settings.model}`).digest('hex')
    const dir = path.join(root, '.runtime/voice-inference'); await mkdir(dir, { recursive: true })
    const original = { status: 'created', request: { input: { voice_prompt: '弟子站在集市讲述' } }, receipt: { output: { voice_id: 'already-paid' } } }
    const journal = path.join(dir, `${hash}.json`); await writeFile(journal, JSON.stringify(original))
    const actions: string[] = []
    const result = await inferCharacterVoices(model, '新规则不能改已提交音色', { workflowId, characters: [{ name: '弟子', continuityKey: key }] }, { root, call: async (_m, body) => {
      const action = (body as { input: { action: string } }).input.action; actions.push(action)
      assert.equal(action, 'query_voice'); return { output: { status: 'OK' } }
    } })
    assert.deepEqual(actions, ['query_voice'])
    assert.equal(result.items[0].voiceId, 'already-paid')
    assert.equal(result.items[0].description, original.request.input.voice_prompt)
    assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), original)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('voice archive precedes portrait archive and rejects conflicting replacement', { skip: !process.env.VOICE_TEST_DATABASE_URL }, async () => {
  const schema = `voice_separation_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-separate-'))
  try {
    await db.query(voiceSchema + originalVoiceSchema)
    const candidates = await inferCharacterVoices(model, '自然清晰的原创声音', { workflowId: 'wf', characters: [{ name: '甲', continuityKey: 'a', voiceProfile: { texture: '温润', pitch: '中低' } }] }, { root, call: async (_m, body) => ({ output: (body as { input: { action: string } }).input.action === 'create_voice' ? { voice_id: 'original' } : { status: 'OK' } }) })
    assert.equal((await db.query('select count(*) from original_character_voices')).rows[0].count, '0')
    await archiveVoiceCandidates(db, 'wf', candidates.items)
    assert.equal((await db.query('select count(*) from original_character_voices')).rows[0].count, '1')
    const recalled = await lookupArchivedVoices(db, 'wf', ['a'])
    const cached = await inferCharacterVoices(model, '', { workflowId: 'wf', characters: [{ name: '甲', continuityKey: 'a' }], existingVoices: recalled }, { root, call: async () => { throw Error('must not call provider') } })
    assert.equal(cached.cachedCount, 1)
    await assert.rejects(archiveVoiceCandidates(db, 'wf', [{ ...candidates.items[0], voiceId: 'replacement' }]), /VOICE_ARCHIVE_CONFLICT/)
    const narrator = await archiveVoiceCandidates(db, 'wf', [{ ...candidates.items[0], continuityKey: '__narrator__', characterName: '旁白', prefix: 'narrator', voiceId: 'original-narrator' }])
    const asset = { ...narrator.items[0], audioRole: 'narration' }
    const request = { model: { id: 'video', provider: 'Kling', capability: 'video', settings: {} }, params: { audioType: '旁白', audioText: '原文保持不变。', voiceAssets: [asset] }, executionContext: { voicePolicy: 'strict', voiceExecutionId: 'first-loop', workflowId: 'wf' } }
    const bound = await bindVideoVoices(db, request)
    assert.equal((bound.params as Record<string, unknown>).narrationVoice && ((bound.params as Record<string, unknown>).narrationVoice as { voiceId: string }).voiceId, 'original-narrator')
    const seed = narratorSynthesisSeed(asset.characterId, 'original-narrator')
    assert.equal(((bound.params as Record<string, unknown>).narrationVoice as { synthesisSeed: number }).synthesisSeed, seed)
    assert.equal((await db.query('select count(*) from execution_original_voice_manifests')).rows[0].count, '1')
    const repeated = await bindVideoVoices(db, request)
    assert.equal(((repeated.params as Record<string, unknown>).narrationVoice as { synthesisSeed: number }).synthesisSeed, seed)
    assert.equal((await db.query('select count(*) from execution_original_voice_manifests')).rows[0].count, '1')
    const resumed = await bindVideoVoices(db, { ...request, params: { ...request.params, voiceAssets: [{ ...asset, voiceId: 'new-library-default' }] } })
    assert.equal(((resumed.params as Record<string, unknown>).narrationVoice as { voiceId: string }).voiceId, 'original-narrator')
  } finally { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); await rm(root, { recursive: true, force: true }) }
})
