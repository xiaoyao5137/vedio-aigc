import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import type { CharacterVoice } from '../src/character-voice.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { voiceSchema, saveNarratorVoiceVersion, setCharacterVoiceAvailability, assertVoiceSynthesisAllowed, lockExecutionVoices, characterVoiceIdentity, bindVideoVoices, refreshVoiceJob, saveVoiceListeningReview, readVoiceListeningReview, readCharacterVoiceImpact, previewVoiceUpgrade, forkVoiceUpgrade } from '../server/character-voices.ts'
import { voiceAccountScope } from '../server/kling-voices.ts'

// An isolated schema exercises PostgreSQL concurrency and version persistence.
// Opt in with VOICE_TEST_DATABASE_URL; never edit live character/execution rows.
test('voice identities, immutable execution snapshots and concurrent first requests', { skip: !process.env.VOICE_TEST_DATABASE_URL }, async () => {
  const schema = `voice_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  try {
    await db.query(voiceSchema)
    await db.query(`create table character_assets(id text primary key,asset_type text,workflow_id text,character_name text,metadata jsonb)`)
    await db.query(`insert into character_assets values('a','three-view','wf','曹操','{"continuityKey":"cao"}'),('b','three-view','wf','曹操','{"continuityKey":"cao"}'),('c','three-view','other','曹操','{"continuityKey":"cao"}')`)
    const a = await characterVoiceIdentity(db, 'a'), b = await characterVoiceIdentity(db, 'b'), c = await characterVoiceIdentity(db, 'c')
    assert.equal(a.identity.id, b.identity.id)
    assert.notEqual(a.identity.id, c.identity.id)
    const model = { id: 'kling', provider: 'Kling', capability: 'video', settings: { endpoint: 'https://example.com/v1/videos/image2video', apiKey: 'test', model: 'kling-v3' } }
    const v1 = { characterId: a.identity.id, characterName: '曹操', version: 1, voiceId: 'voice-1', elementId: '123', modelId: model.id, accountScope: voiceAccountScope(model) }
    await assert.rejects(lockExecutionVoices(db, 'missing', 'wf', ['曹操']), /VOICE_BINDING_MISSING/)
    assert.equal((await db.query('select * from execution_voice_manifests')).rowCount, 0)
    await db.query('insert into character_voice_versions values($1,1,$2,now())', [a.identity.id, v1])
    await db.query('update voice_characters set current_version=1 where id=$1', [a.identity.id])
    await db.query(`insert into character_assets values('alternate-look-a','three-view','wf','张角','{"continuityKey":"zhang-a"}'),('alternate-look-b','three-view','wf','张角','{"continuityKey":"zhang-b"}')`)
    const alternate = await characterVoiceIdentity(db, 'alternate-look-a')
    // Historical pre-stable-key records can still contain two identities for
    // the same named actor. New portraits now deliberately share one voice.
    const alternateB = { identity: { id: randomUUID() } }
    await db.query('insert into voice_characters(id,workflow_id,continuity_key,character_name) values($1,$2,$3,$4)', [alternateB.identity.id, 'wf', 'legacy-zhang-b', '张角'])
    const alternateVoice = { ...v1, characterId: alternate.identity.id, characterName: '张角', voiceId: 'voice-alternate', elementId: '456' }
    await db.query('insert into character_voice_versions values($1,1,$2,now()),($3,1,$4,now())', [alternate.identity.id, alternateVoice, alternateB.identity.id, { ...alternateVoice, characterId: alternateB.identity.id, voiceId: 'voice-alternate-b' }])
    await db.query('update voice_characters set current_version=1 where id=any($1::text[])', [[alternate.identity.id, alternateB.identity.id]])
    await assert.rejects(lockExecutionVoices(db, 'ambiguous-look', 'wf', ['张角']), /VOICE_IDENTITY_AMBIGUOUS/)
    const referencedLook = await lockExecutionVoices(db, 'referenced-look', 'wf', ['张角'], [alternate.identity.id])
    assert.equal(referencedLook.characters[0].voiceId, 'voice-alternate', 'the current shot asset disambiguates multiple visual identities with the same historical name')
    const repairedPortraitRequest = {
      model,
      params: {
        audioText: '张角：传道。',
        voiceAssets: [{ characterId: alternateB.identity.id, videoBinding: { ...alternateVoice, characterId: alternateB.identity.id, voiceId: 'voice-alternate-b', elementId: '789' } }],
      },
      executionContext: { voicePolicy: 'strict', voiceExecutionId: 'referenced-look', workflowId: 'wf' },
    }
    const repairedPortraitBound = await bindVideoVoices(db, repairedPortraitRequest)
    assert.equal((repairedPortraitBound.params as { characterVoices: CharacterVoice[] }).characterVoices[0].characterId, alternate.identity.id)
    assert.equal((repairedPortraitBound.params as { characterVoices: CharacterVoice[] }).characterVoices[0].voiceId, 'voice-alternate', 'a repaired portrait cannot replace the execution voice lock')
    assert.match(String((repairedPortraitBound.params as { voiceConsistency: { reason: string } }).voiceConsistency.reason), /视觉资产已更新/)
    await db.query("delete from execution_voice_manifests where execution_id='referenced-look'")
    const snapshots = await Promise.all(Array.from({ length: 8 }, () => lockExecutionVoices(db, 'run', 'wf', ['曹操'])))
    assert.ok(snapshots.every(m => m.characters[0].voiceId === 'voice-1'))
    assert.equal((await db.query('select * from execution_voice_manifests')).rowCount, 1)
    await db.query('insert into character_voice_versions values($1,2,$2,now())', [a.identity.id, { ...v1, voiceId: 'voice-2', version: 2 }])
    await db.query('update voice_characters set current_version=2 where id=$1', [a.identity.id])
    assert.equal((await lockExecutionVoices(db, 'run', 'wf')).characters[0].voiceId, 'voice-1')
    assert.equal((await lockExecutionVoices(db, 'new', 'wf')).characters[0].voiceId, 'voice-2')
    await assert.rejects(lockExecutionVoices(db, 'run', 'other'), /工作流不一致/)
    const request = { model, params: { audioText: '曹操：走吧。' }, executionContext: { voicePolicy: 'strict', voiceExecutionId: 'run', workflowId: 'wf' } }
    const preflightRequest = { ...request, executionContext: { ...request.executionContext, voiceExecutionId: 'preflight', knownVoiceSpeakers: ['曹操', '后镜未绑定人物'] } }
    await assert.rejects(bindVideoVoices(db, preflightRequest), /VOICE_BINDING_MISSING.*后镜未绑定人物/)
    assert.equal((await db.query("select * from execution_voice_manifests where execution_id='preflight'")).rowCount, 0)
    await assert.rejects(bindVideoVoices(db, { ...preflightRequest, params: {} }), /VOICE_BINDING_MISSING.*后镜未绑定人物/, 'even an opening silent video must preflight known later speech')
    const existingWithNewFuture = await bindVideoVoices(db, { ...request, executionContext: { ...request.executionContext, knownVoiceSpeakers: ['后镜未绑定人物'] } })
    assert.equal((existingWithNewFuture.params as { characterVoices: CharacterVoice[] }).characterVoices[0].voiceId, 'voice-1', 'future plan discovery cannot block recovery of an already locked earlier shot')
    const bound = await bindVideoVoices(db, request)
    assert.equal((bound.params as Record<string, unknown>).characterVoices instanceof Array, true)
    assert.equal((bound.params as { characterVoices?: typeof v1[] }).characterVoices?.[0].voiceId, 'voice-1')
    await db.query(`insert into character_assets values('new-actor','three-view','wf','新人物','{"continuityKey":"new"}')`)
    const newcomer = await characterVoiceIdentity(db, 'new-actor')
    await db.query('insert into character_voice_versions values($1,1,$2,now())', [newcomer.identity.id, { ...v1, characterId: newcomer.identity.id, characterName: '新人物', voiceId: 'new-voice' }])
    await db.query('update voice_characters set current_version=1 where id=$1', [newcomer.identity.id])
    const appended = await lockExecutionVoices(db, 'run', 'wf', ['新人物'])
    assert.equal(appended.characters.find(v => v.characterName === '曹操')?.voiceId, 'voice-1')
    assert.equal(appended.characters.find(v => v.characterName === '新人物')?.voiceId, 'new-voice')
    const rebound = await bindVideoVoices(db, request)
    assert.deepEqual(rebound, bound, 'new speaker must not change an older shot fingerprint or cause another paid take')

    await db.query(`create table model_execution_records(id text primary key,node_name text,status text,task_id text,created_at timestamptz default now(),workflow_id text,capability text,request_data jsonb)`)
    for (const [id, workflowId, voices] of [['take-1', 'wf', [v1]], ['take-2', 'wf', [v1]], ['different-role', 'other', [{ ...v1, characterId: c.identity.id }]], ['legacy', 'wf', []]] as const) {
      await db.query(`insert into model_execution_records(id,node_name,status,task_id,workflow_id,capability,request_data) values($1,'生成镜头','success',$1,$2,'video',$3)`, [id, workflowId, { requestKey: 'run:video:0:scene-1', params: { characterVoices: voices, voiceManifest: { executionId: 'run' } } }])
    }
    const impact = await readCharacterVoiceImpact(db, 'b')
    assert.equal(impact.executionCount, 2, 'regenerated character image finds the same logical identity')
    assert.equal(impact.requestCount, 2, 'count provider attempts honestly, not as distinct shots')
    assert.deepEqual(new Set(impact.executions.map(v => v.version)), new Set([1, 2]))
    assert.ok(impact.requests.every(v => v.version === 1 && v.executionId === 'run'))
    assert.equal((await readCharacterVoiceImpact(db, 'c')).requestCount, 1, 'same name in another workflow stays separate')
    assert.equal((await lockExecutionVoices(db, 'run', 'wf')).characters.find(v => v.characterId === a.identity.id)?.version, 1, 'impact inspection never upgrades a frozen execution')
    await setCharacterVoiceAvailability(db, 'a', 1, false, '测试停用旧版本')
    await assert.rejects(assertVoiceSynthesisAllowed(db, { characterVoices: [v1] }), /VOICE_ASSET_UNAVAILABLE/)
    await assertVoiceSynthesisAllowed(db, { characterVoices: [v1], resumeTaskId: 'already-submitted' })
    await assertVoiceSynthesisAllowed(db, { characterVoices: [{ ...v1, characterId: c.identity.id }] })
    assert.equal((await lockExecutionVoices(db, 'run', 'wf')).characters.find(v => v.characterId === a.identity.id)?.version, 1, 'stopping availability never rewrites old evidence')
    await setCharacterVoiceAvailability(db, 'b', 1, true, '测试恢复同一逻辑人物')
    await assertVoiceSynthesisAllowed(db, { characterVoices: [v1] })
    await setCharacterVoiceAvailability(db, 'a', 2, false, '停止新版本')
    await assert.rejects(previewVoiceUpgrade(db, 'run', [a.identity.id]), /VOICE_ASSET_UNAVAILABLE/)
    await setCharacterVoiceAvailability(db, 'a', 2, true, '恢复新版本')
    await assert.rejects(setCharacterVoiceAvailability(db, 'a', 99, false, '错误版本'), /版本不存在/)
    const upgradePreview = await previewVoiceUpgrade(db, 'run', [a.identity.id])
    assert.equal(upgradePreview.changes[0].from.version, 1)
    assert.equal(upgradePreview.changes[0].to.version, 2)
    await assert.rejects(forkVoiceUpgrade(db, 'run', 'stale-upgrade', [{ characterId: a.identity.id, version: 3 }]), /重新检查/)
    assert.equal((await db.query("select * from execution_voice_manifests where execution_id='stale-upgrade'")).rowCount, 0)
    await assert.rejects(forkVoiceUpgrade(db, 'run', 'run', [{ characterId: a.identity.id, version: 2 }]), /新执行/)
    const upgraded = await forkVoiceUpgrade(db, 'run', 'voice-branch', [{ characterId: a.identity.id, version: 2 }])
    assert.equal(upgraded.manifest.characters.find(v => v.characterId === a.identity.id)?.voiceId, 'voice-2')
    assert.deepEqual(upgraded.manifest.characters.find(v => v.characterId === newcomer.identity.id), appended.characters.find(v => v.characterId === newcomer.identity.id), 'unselected voice stays frozen')
    assert.equal((await lockExecutionVoices(db, 'run', 'wf')).characters.find(v => v.characterId === a.identity.id)?.voiceId, 'voice-1')
    assert.equal((await lockExecutionVoices(db, 'voice-branch', 'wf')).characters.find(v => v.characterId === a.identity.id)?.voiceId, 'voice-2')

    await assert.rejects(bindVideoVoices(db, { ...request, model: { ...model, settings: { ...model.settings, apiKey: 'another-account' } } }), /VOICE_PROVIDER_UNSUPPORTED/)
    await db.query(`insert into character_voice_jobs(id,character_asset_id,model_id,account_scope,kind,status,input)
      values('job','a',$1,$2,'element','uncertain',$3)`, [model.id, voiceAccountScope(model), { binding: v1 }])
    let calls = 0
    const query = async (_model: unknown, route: string) => {
      calls++
      assert.equal(route, 'advanced-custom-elements/job')
      return { code: 0, data: { task_status: 'succeed', task_result: { elements: [{ element_id: '893605946402811985', element_voice_info: { voice_id: v1.voiceId } }] } } }
    }
    await Promise.all([refreshVoiceJob(db, model, 'job', query), refreshVoiceJob(db, model, 'job', query)])
    assert.equal((await db.query('select current_version from voice_characters where id=$1', [a.identity.id])).rows[0].current_version, 3)
    assert.equal((await db.query('select binding from character_voice_versions where version=3')).rows[0].binding.elementId, '893605946402811985')
    const callsBefore = calls
    await refreshVoiceJob(db, model, 'job', query)
    assert.equal(calls, callsBefore)
    assert.equal((await lockExecutionVoices(db, 'run', 'wf')).characters[0].version, 1)
    const target = { videoUrl: 'https://example.com/clip.mp4', characters: [{ ...v1, voiceName: '甲', previewUrl: 'https://example.com/voice.mp3' }] as CharacterVoice[] }
    const timeline = { operation: 'timeline.compose', params: { storyboards: [{ id: 'shot-1' }], videos: [{ url: target.videoUrl, characterVoices: target.characters }] } }
    let timelineOutput = await executeBuiltinNode(db, timeline) as { status: string; clips: Array<{ voiceConsistency: { method: string } }> }
    assert.equal(timelineOutput.status, 'ready')
    assert.equal(timelineOutput.clips[0].voiceConsistency.method, 'automatic-binding-fallback')
    await saveVoiceListeningReview(db, target, 'uncertain', '短句不足以比较')
    timelineOutput = await executeBuiltinNode(db, timeline) as typeof timelineOutput
    assert.equal(timelineOutput.clips[0].voiceConsistency.method, 'automatic-binding-fallback')
    await saveVoiceListeningReview(db, target, 'failed', '人工确认音色不一致')
    await assert.rejects(executeBuiltinNode(db, timeline), /VOICE_REVIEW_REJECTED/)
    await saveVoiceListeningReview(db, target, 'passed', '测试听审记录')
    timelineOutput = await executeBuiltinNode(db, timeline) as typeof timelineOutput
    assert.equal(timelineOutput.status, 'ready')
    assert.equal(timelineOutput.clips[0].voiceConsistency.method, 'user-listening')
    assert.equal(await readVoiceListeningReview(db, { ...target, videoUrl: 'https://example.com/retake.mp4' }), null)
    assert.equal(await readVoiceListeningReview(db, { ...target, characters: target.characters.map(v => ({ ...v, version: 2 })) }), null)
    await db.query('create table workflow_configs(id text primary key)')
    await db.query("insert into workflow_configs values('wf'),('other')")
    const narrator = await characterVoiceIdentity(db, 'narrator:wf')
    assert.equal(narrator.asset.asset_type, 'narrator')
    assert.equal((await characterVoiceIdentity(db, 'narrator:wf')).identity.id, narrator.identity.id)
    assert.notEqual((await characterVoiceIdentity(db, 'narrator:other')).identity.id, narrator.identity.id)
    await assert.rejects(characterVoiceIdentity(db, 'narrator:missing'), /工作流不存在/)
    const narratorModel = { ...model, settings: { ...model.settings, model: 'kling-v2-6' } }
    const voiceChoice = { voiceId: 'narrator-v1', voiceName: '旁白样音', previewUrl: 'https://example.com/narrator.wav' }
    await saveNarratorVoiceVersion(db, narrator.identity.id, narratorModel, voiceChoice)
    const narration = await bindVideoVoices(db, { model: narratorModel, params: { audioType: '旁白', audioText: '村里传来了消息。' }, executionContext: { voicePolicy: 'strict', voiceExecutionId: 'narrator-run', workflowId: 'wf' } })
    assert.equal((narration.params as { characterVoices: CharacterVoice[] }).characterVoices[0].characterId, narrator.identity.id)
    assert.equal((narration.params as { characterVoices: CharacterVoice[] }).characterVoices[0].elementId, undefined)
    await saveNarratorVoiceVersion(db, narrator.identity.id, narratorModel, { ...voiceChoice, voiceId: 'narrator-v2' })
    assert.equal((await lockExecutionVoices(db, 'narrator-run', 'wf', ['旁白'])).characters.find(v => v.characterId === narrator.identity.id)?.voiceId, 'narrator-v1')



  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
