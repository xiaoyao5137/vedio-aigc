import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { compileKlingVoices, nativeGroupVoicePlan, type CharacterVoice } from '../src/character-voice.ts'
import { voiceCharacterInputs } from '../src/voice-character-input.ts'
import { resolveVoiceGateDecision, voiceReviewIdentity, voiceReviewTarget } from '../src/voice-review.ts'
import { bindVideoVoices, voiceSchema } from '../server/character-voices.ts'
import { voiceAccountScope } from '../server/kling-voices.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { acceptPrincipleMedia, PRINCIPLE_MEDIA_RUNTIME_CODE } from '../src/principle-media-quality.ts'
import { executeCodeNode } from '../server/code-node.ts'

const shot = JSON.parse(readFileSync(new URL('./fixtures/native-group-scene-15.json', import.meta.url), 'utf8'))
const manual = { ...shot, qualityDisposition: 'manual-review-v1', sound: 'on' }
const actor = { name: '张角', continuityKey: 'portrait-zhangjiao' }
const model = { id: 'kling', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3', endpoint: 'https://example.test/v1/videos/omni-video', apiKey: 'test', sound: 'on' } }

test('real scene-15 manual group route preserves both full lines and named-only original voice creation', () => {
  const before = structuredClone(manual)
  const groups = nativeGroupVoicePlan(manual)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '万余信众')
  assert.equal(groups[0].status, 'unbound')
  assert.equal(groups[0].offscreen, false)
  assert.equal(groups[0].speechVerified, false)
  assert.equal(groups[0].lipSyncVerified, false)
  assert.equal(groups[0].speechBeats[0].text, shot.pacing.beats.find((beat: { actorIds: string[] }) => beat.actorIds[0] === 'crowd-believers').textOrVocalization)
  assert.deepEqual(voiceCharacterInputs([actor], shot, { qualityDisposition: 'manual-review-v1' }), [{ ...actor, continuityKey: 'voice:张角' }])
  assert.throws(() => voiceCharacterInputs([actor], shot), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.throws(() => voiceCharacterInputs([actor], shot, { qualityDisposition: 'strict-v1' }), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.deepEqual(manual, before)
  const labelledPosture = { ...manual, pacing: { ...manual.pacing, actorGroups: [{ ...manual.pacing.actorGroups[0], label: '万余跪拜信众' }] } }
  assert.equal(nativeGroupVoicePlan(labelledPosture)[0].name, '万余跪拜信众', 'source-backed group aliases retain the declared identity')
})

test('group-only and explicit collective offscreen performances stay unbound; ordinary single offscreen role keeps fixed TTS', () => {
  const crowd = { ...manual, characters: [], audioText: manual.audioText.split('\n')[1], pacing: { ...manual.pacing, beats: manual.pacing.beats.filter((beat: { kind: string; actorIds: string[] }) => beat.kind === 'speech' && beat.actorIds[0] === 'crowd-believers') } }
  assert.deepEqual(voiceCharacterInputs([], crowd), [])
  assert.equal(nativeGroupVoicePlan(crowd).length, 1)
  const offscreen = { ...crowd, audioText: crowd.audioText.replace('万余信众：', '万余信众（画外）：') }
  assert.equal(nativeGroupVoicePlan(offscreen).length, 1, 'a collective performance must not become a single TTS voice')
  const single = { ...offscreen, pacing: { ...offscreen.pacing, beats: offscreen.pacing.beats.map((beat: object) => ({ ...beat, performanceInstruction: '平静讲述', completion: { modality: 'audio' } })) } }
  assert.deepEqual(nativeGroupVoicePlan(single), [])
  assert.equal(voiceCharacterInputs([], single)[0].audioRole, 'offscreen-dialogue')
})

test('native group review never upgrades binding, listening, transcript or lip-sync evidence', () => {
  const groups = nativeGroupVoicePlan(manual)
  const target = voiceReviewTarget({ url: '/generated/crowd.mp4', characterVoices: [], nativeGroupVoices: groups })!
  assert.deepEqual(target.characters, [])
  const pending = resolveVoiceGateDecision(target, null)
  assert.equal(pending.status, 'uncertain')
  assert.equal(pending.method, 'manual-review-pending')
  if (pending.method === 'manual-review-pending') {
    assert.equal(pending.speechVerified, false)
    assert.equal(pending.lipSyncVerified, false)
  }
  const reviewed = { status: 'passed', note: '已完整听取两段台词及群体应和', reviewedAt: new Date().toISOString(), method: 'user-listening' } as const
  assert.equal(resolveVoiceGateDecision(target, reviewed), reviewed)
  assert.throws(() => resolveVoiceGateDecision(target, { ...reviewed, status: 'failed' }), /VOICE_REVIEW_REJECTED/)
  assert.notEqual(voiceReviewIdentity(target), voiceReviewIdentity({ ...target, nativeGroupVoices: groups.map(group => ({ ...group, speechBeats: [{ ...group.speechBeats[0], text: '其他台词' }] })) }))
})

test('accepted media and serialized runtime retain group-only review identity without promoting uncertainty', async () => {
  const nativeGroupVoices = nativeGroupVoicePlan(manual)
  const take = { url: 'https://example.test/groups.mp4', params: { scheduleHash: 'current-schedule' }, nativeGroupVoices,
    voiceConsistency: { status: 'uncertain', method: 'manual-review-pending', speechVerified: false, lipSyncVerified: false } }
  const context = { shot_script: { ...manual, duration: 8, pacing: { ...manual.pacing, scheduleHash: 'current-schedule' } }, video_take: take,
    video_evidence: { url: '/generated/groups.mp4', originalUrl: take.url, decoded: true, evidenceUrl: '/generated/groups.json', duration: 8,
      width: 1920, height: 1080, hasAudio: true, meanVolumeDb: -20, frames: ['/generated/frame.jpg'], frameTimes: [0], lastFrameUrl: '/generated/frame.jpg', transcript: [] },
    media_review: { version: 'principle-review-v1', decision: 'uncertain', issues: [], warnings: [] } }
  const params = { qualityDisposition: 'manual-review-v1' }
  const accepted = acceptPrincipleMedia(context, params)
  assert.equal(accepted.passed, true)
  assert.deepEqual(accepted.nativeGroupVoices, nativeGroupVoices)
  assert.deepEqual(accepted.voiceConsistency, take.voiceConsistency)
  assert.equal(accepted.technicalValidation.speechVerified, false)
  assert.equal(accepted.visualReview.lipSyncVerified, false)
  assert.equal(voiceReviewTarget(accepted)?.nativeGroupVoices?.length, 1)
  const result = await executeCodeNode({ code: PRINCIPLE_MEDIA_RUNTIME_CODE + '\nreturn principleMediaQuality.acceptMedia(context,params);', context, params })
  assert.deepEqual(result.nativeGroupVoices, accepted.nativeGroupVoices)
  assert.deepEqual(result.voiceConsistency, accepted.voiceConsistency)
})

test('PostgreSQL binding retains frozen named voices, creates no group assets, and compiles one real Omni element', { skip: !process.env.VOICE_TEST_DATABASE_URL }, async () => {
  const schema = `native_groups_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  try {
    await db.query(voiceSchema)
    await db.query(`create table character_assets(id text,workflow_id text,character_name text,asset_type text,uri text,prompt text,version integer,metadata jsonb,created_at timestamptz,updated_at timestamptz)`)
    const voice: CharacterVoice & { originalVoiceId: string } = { characterId: 'named-zhang', characterName: '张角', voiceId: 'locked-voice', originalVoiceId: 'original-voice', voiceName: '张角原创', version: 1, elementId: '12345', modelId: model.id, accountScope: voiceAccountScope(model), previewUrl: 'https://example.test/voice.wav' }
    await db.query(`insert into voice_characters values('named-zhang','wf','voice:张角','张角',1)`)
    await db.query('insert into character_voice_versions(character_id,version,binding) values($1,1,$2)', [voice.characterId, voice])
    await db.query('insert into execution_voice_manifests(execution_id,workflow_id,manifest) values($1,$2,$3)', ['original-scope', 'wf', { version: 'character-voice-v1', executionId: 'original-scope', characters: [voice] }])
    const voiceAssets = [{ characterId: voice.characterId, voiceId: voice.originalVoiceId, videoBinding: voice }]
    const request = { model, params: { ...manual, voiceAssets }, executionContext: { voicePolicy: 'strict', workflowId: 'wf', voiceExecutionId: 'original-scope' } }
    const bound = await bindVideoVoices(db, request)
    assert.deepEqual(bound.params.characterVoices, [voice])
    assert.equal(bound.params.audioText, shot.audioText)
    assert.deepEqual(bound.params.pacing, shot.pacing)
    assert.equal(bound.params.voiceConsistency.status, 'uncertain')
    assert.equal(bound.params.voiceConsistency.bindingScope, 'named-characters-only')
    assert.equal(bound.params.nativeGroupVoices[0].status, 'unbound')
    const provider = buildKlingVideoRequest(model, shot.videoPrompt, { ...bound.params, model_name: 'kling-v3-omni' })
    assert.deepEqual(provider.element_list, [{ element_id: '12345' }])
    assert.equal(provider.sound, 'on')
    assert.equal(String(provider.prompt).includes(shot.videoPrompt), true)
    assert.match(String(provider.prompt), /万余信众/)
    assert.equal(provider.voice_list, undefined)
    const lookup = await executeBuiltinNode(db, { operation: 'character.lookup', params: { workflowId: 'wf', characters: [], shot: { ...manual, audioText: manual.audioText.split('\n')[1], pacing: { ...manual.pacing, beats: manual.pacing.beats.filter((beat: { kind: string; actorIds: string[] }) => beat.kind === 'speech' && beat.actorIds[0] === 'crowd-believers') } }, qualityDisposition: 'manual-review-v1' } }) as Record<string, unknown>
    assert.equal(lookup.missingCount, 0)
    const onlyGroup = await bindVideoVoices(db, { ...request, params: { ...request.params, audioText: manual.audioText.split('\n')[1], pacing: { ...manual.pacing, beats: manual.pacing.beats.filter((beat: { kind: string; actorIds: string[] }) => beat.kind === 'speech' && beat.actorIds[0] === 'crowd-believers') } } })
    assert.deepEqual(onlyGroup.params.characterVoices, [])
    assert.equal(onlyGroup.params.voiceConsistency.bindingScope, 'none')
    assert.deepEqual(compileKlingVoices(shot.videoPrompt, onlyGroup.params, 'kling-v3', false).fields, {})
    assert.equal((await db.query('select count(*) from voice_characters')).rows[0].count, '1')
    assert.equal((await db.query('select count(*) from character_assets')).rows[0].count, '0')
    assert.equal((await db.query('select count(*) from execution_original_voice_manifests')).rows[0].count, '0')
    await assert.rejects(bindVideoVoices(db, { ...request, params: { ...request.params, qualityDisposition: 'strict-v1' } }), /VOICE_PROVIDER_UNSUPPORTED/)
    await assert.rejects(bindVideoVoices(db, { ...request, params: { ...request.params, sound: 'off' } }), /VOICE_PROVIDER_UNSUPPORTED/)
    await assert.rejects(bindVideoVoices(db, { ...request, executionContext: { ...request.executionContext, workflowId: 'missing-wf', voiceExecutionId: 'new-scope' } }), /VOICE_BINDING_MISSING/)
    assert.throws(() => buildKlingVideoRequest(model, '甲'.repeat(2501), { ...onlyGroup.params }), /STORYBOARD_PROMPT_OVERLOAD/)
  } finally { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() }
})
