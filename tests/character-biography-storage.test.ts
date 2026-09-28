import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { CHARACTER_BIOGRAPHY_MAX_LENGTH, normalizeCharacterBiography } from '../src/character-asset.ts'
import type { CharacterAssetInput } from '../src/character-asset.ts'
import { characterBiographySchema, createCharacterAsset, updateCharacterAsset, readCharacterAssets, deleteCharacterAsset } from '../server/character-assets.ts'
import { characterVoiceIdentity, voiceSchema } from '../server/character-voices.ts'

test('biographies distinguish omission from clearing and reject malformed or oversized text', () => {
  assert.equal(normalizeCharacterBiography(undefined), undefined)
  assert.equal(normalizeCharacterBiography(''), '')
  assert.equal(normalizeCharacterBiography('  第一段。\n第二段。  '), '第一段。\n第二段。')
  assert.equal(normalizeCharacterBiography('传'.repeat(CHARACTER_BIOGRAPHY_MAX_LENGTH))?.length, CHARACTER_BIOGRAPHY_MAX_LENGTH)
  for (const value of [null, {}, [], 12, false]) assert.throws(() => normalizeCharacterBiography(value), /须为文本/)
  assert.throws(() => normalizeCharacterBiography('传'.repeat(CHARACTER_BIOGRAPHY_MAX_LENGTH + 1)), /不能超过 10000 字/)
})

const databaseUrl = process.env.CHARACTER_TEST_DATABASE_URL ?? process.env.VOICE_TEST_DATABASE_URL
test('shared biographies persist across visual versions without changing images, voice identities or other workflows', { skip: !databaseUrl }, async () => {
  const schema = `biography_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: databaseUrl })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await db.query(voiceSchema)
    await db.query(`create table character_assets (
      id text primary key, workflow_id text, character_name text not null, asset_type text not null,
      uri text not null, prompt text not null default '', version integer not null default 1,
      metadata jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`)
    await db.query(`insert into character_assets(id,workflow_id,character_name,asset_type,uri,prompt)
      values('legacy',null,'曹操','three-view','legacy.png','旧外观')`)
    await db.query(characterBiographySchema)
    await db.query(characterBiographySchema)
    await db.query(`insert into character_biographies(workflow_id,character_name,biography) values('','曹操','未分组人物资料')`)
    assert.equal((await readCharacterAssets(db))[0].biography, '未分组人物资料')
    const input: CharacterAssetInput = {
      workflowId: 'wf', characterName: ' 曹操 ', description: '黑发黑须，深色甲胄', threeViewUrl: 'portrait.png',
      metadata: { continuityKey: 'cao-armor' },
    }
    const firstCreated = await createCharacterAsset(db, { ...input, biography: '我生于沛国谯县。\n少时喜读兵书。' })
    await db.query(`update character_assets set metadata=metadata || $2::jsonb where id=$1`,
      [firstCreated.id, JSON.stringify({ visualProfile: { version: 'actual-reference-v1' }, quality: { status: 'passed' } })])
    const first = (await readCharacterAssets(db)).find(asset => asset.id === firstCreated.id)!
    await assert.rejects(createCharacterAsset(db, { ...input, threeViewUrl: 'new-upload.png',
      metadata: { continuityKey: 'cao-new', identityConsistency: { status: 'passed', distance: 0.2 },
        sourceMediaProvenance: { contentSha256: 'old-image' } } }), /CHARACTER_NEW_PORTRAIT_EVIDENCE_INVALID/)
    await assert.rejects(createCharacterAsset(db, { ...input, threeViewUrl: 'fake-reviewed.png',
      metadata: { continuityKey: 'cao-fake', portraitReviewDecision: { decision: 'accept' } } }), /CHARACTER_NEW_PORTRAIT_EVIDENCE_INVALID/)
    assert.equal(first.characterName, '曹操')
    assert.equal(first.biography, '我生于沛国谯县。\n少时喜读兵书。')
    const identity = await characterVoiceIdentity(db, first.id)
    const voice = { characterId: identity.identity.id, characterName: '曹操', version: 1, voiceId: 'fixed-voice', modelId: 'model', accountScope: 'account' }
    await db.query('insert into character_voice_versions(character_id,version,binding) values($1,1,$2)', [identity.identity.id, voice])
    await db.query('update voice_characters set current_version=1 where id=$1', [identity.identity.id])
    const second = await createCharacterAsset(db, { ...input, metadata: { continuityKey: 'cao-casual' }, threeViewUrl: 'casual.png', description: '便服' })
    assert.equal(second.biography, first.biography, 'omitting biography on a new visual version inherits the person profile')
    assert.equal(second.voice?.voiceId, 'fixed-voice')
    const other = await createCharacterAsset(db, { ...input, workflowId: 'other', biography: '另一剧本的人物自传' })
    assert.equal(other.biography, '另一剧本的人物自传')
    await createCharacterAsset(db, { ...input, characterName: '刘备', biography: '刘备的人物资料' })

    const edited = await updateCharacterAsset(db, first.id, { ...input, biography: '新的自传。\n保留换行。' })
    assert.equal(edited.description, first.description)
    assert.equal(edited.threeViewUrl, first.threeViewUrl)
    assert.deepEqual(edited.metadata.visualProfile, first.metadata.visualProfile)
    assert.deepEqual(edited.metadata.quality, first.metadata.quality)
    assert.deepEqual(edited.voice, voice)
    assert.equal(edited.version, first.version + 1)
    await assert.rejects(updateCharacterAsset(db, first.id, { ...input,
      metadata: { continuityKey: 'cao-armor', portraitReviewDecision: { version: 'manual-portrait-review-v1', decision: 'accept' },
        portraitLifecycle: { status: 'active' }, identityConsistency: { status: 'passed' } } }), /CHARACTER_PORTRAIT_EVIDENCE_IMMUTABLE/)
    await assert.rejects(updateCharacterAsset(db, first.id, { ...input, threeViewUrl: 'replacement.png' }), /CHARACTER_REVIEWED_PORTRAIT_IMMUTABLE/)
    const preservedReviewed = (await readCharacterAssets(db)).find(asset => asset.id === first.id)
    assert.equal(preservedReviewed?.threeViewUrl, 'portrait.png')
    assert.deepEqual(preservedReviewed?.metadata.visualProfile, first.metadata.visualProfile)
    assert.ok((await readCharacterAssets(db, 'wf')).filter(asset => asset.characterName === '曹操').every(asset => asset.biography === edited.biography))
    assert.equal((await readCharacterAssets(db, 'other'))[0].biography, other.biography)
    assert.equal((await readCharacterAssets(db, 'wf')).find(asset => asset.characterName === '刘备')?.biography, '刘备的人物资料')
    assert.ok((await readCharacterAssets(db, 'wf')).every(asset => asset.workflowId === 'wf'))
    assert.equal((await readCharacterAssets(db, 'wf', true)).find(asset => asset.id === 'legacy')?.biography, '未分组人物资料')

    const preserved = await updateCharacterAsset(db, second.id, { ...input, metadata: second.metadata, threeViewUrl: 'new-casual.png' })
    assert.equal(preserved.biography, edited.biography, 'older clients can save image edits without a biography field')
    await db.query(`update character_assets set metadata=jsonb_set(metadata,'{artisticIdentity}',
      '{"version":"character-artistic-identity-v1","active":true,"face":"端正五官"}'::jsonb) where id=$1`, [second.id])
    await assert.rejects(updateCharacterAsset(db, second.id, { ...input, metadata: second.metadata,
      threeViewUrl: 'replace-approved.png' }), /CHARACTER_REVIEWED_PORTRAIT_IMMUTABLE/)
    assert.equal((await readCharacterAssets(db)).find(asset => asset.id === second.id)?.threeViewUrl, 'new-casual.png')
    const historical = await createCharacterAsset(db, { ...input, threeViewUrl: 'historical.png',
      metadata: { continuityKey: 'cao-history' } })
    await db.query(`update character_assets set metadata=jsonb_set(metadata,'{portraitLifecycle}',
      '{"status":"superseded","reason":"older-candidate"}'::jsonb) where id=$1`, [historical.id])
    await assert.rejects(updateCharacterAsset(db, historical.id, { ...input, threeViewUrl: 'replace-history.png' }), /CHARACTER_REVIEWED_PORTRAIT_IMMUTABLE/)
    assert.equal((await readCharacterAssets(db)).find(asset => asset.id === historical.id)?.threeViewUrl, 'historical.png')
    // Existing workflow archives write only visual assets and therefore retain the shared profile.
    await db.query(`insert into character_assets(id,workflow_id,character_name,asset_type,uri) values('archive','wf','曹操','three-view','archived.png')`)
    assert.equal((await readCharacterAssets(db, 'wf')).find(asset => asset.id === 'archive')?.biography, edited.biography)
    await updateCharacterAsset(db, first.id, { ...input, biography: '' })
    assert.ok((await readCharacterAssets(db, 'wf')).filter(asset => asset.characterName === '曹操').every(asset => asset.biography === ''))
    assert.equal((await createCharacterAsset(db, input)).biography, '', 'cleared biographies are not restored by creating a version')

    const count = (await db.query('select count(*)::int as total from character_assets')).rows[0].total
    await assert.rejects(createCharacterAsset(db, { ...input, biography: '长'.repeat(10001) }), /不能超过/)
    await assert.rejects(updateCharacterAsset(db, first.id, { ...input, biography: null } as unknown as CharacterAssetInput), /须为文本/)
    assert.equal((await db.query('select count(*)::int as total from character_assets')).rows[0].total, count)

    await db.query(`create function reject_test_biography() returns trigger language plpgsql as $$
      begin if new.biography='拒绝写入' then raise exception '拒绝写入'; end if; return new; end $$;
      create trigger reject_test_biography before insert or update on character_biographies for each row execute function reject_test_biography()`)
    const before = (await readCharacterAssets(db)).find(asset => asset.id === first.id)
    await assert.rejects(createCharacterAsset(db, { ...input, biography: '拒绝写入' }), /拒绝写入/)
    await assert.rejects(updateCharacterAsset(db, first.id, { ...input, biography: '拒绝写入' }), /拒绝写入/)
    assert.equal((await db.query('select count(*)::int as total from character_assets')).rows[0].total, count)
    assert.deepEqual((await readCharacterAssets(db)).find(asset => asset.id === first.id), before, 'a failed biography write rolls back the visual update')

    for (const asset of (await readCharacterAssets(db, 'wf')).filter(asset => asset.characterName === '曹操')) await deleteCharacterAsset(db, asset.id)
    const recreated = await createCharacterAsset(db, input)
    assert.equal(recreated.biography, '', 'removing visual versions does not delete a retained person profile')
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
