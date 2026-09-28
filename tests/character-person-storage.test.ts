import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { voiceSchema } from '../server/character-voices.ts'
import { originalVoiceSchema } from '../server/original-character-voices.ts'
import {
  characterBiographySchema, characterEquipmentSchema, characterPersonId,
  createCharacterAsset, createCharacterEquipment, deleteCharacterAsset, deleteCharacterEquipment,
  readCharacterAssets, readCharacterEquipment, readCharacterPeople, updateCharacterAsset, updateCharacterEquipment,
} from '../server/character-assets.ts'

test('person keys separate workflows and normalize legacy unassigned assets', () => {
  assert.equal(characterPersonId(null, ' 曹操 '), characterPersonId('', '曹操'))
  assert.notEqual(characterPersonId('wf-1', '曹操'), characterPersonId('wf-2', '曹操'))
})

const databaseUrl = process.env.CHARACTER_TEST_DATABASE_URL ?? process.env.VOICE_TEST_DATABASE_URL
test('person view groups visual versions and retains equipment and biography after last version deletion', { skip: !databaseUrl }, async () => {
  const schema = `character_person_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: databaseUrl })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await db.query(voiceSchema)
    await db.query(originalVoiceSchema)
    await db.query(`create table character_assets (
      id text primary key, workflow_id text, character_name text not null, asset_type text not null,
      uri text not null, prompt text not null default '', version integer not null default 1,
      metadata jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`)
    await db.query(characterBiographySchema)
    await db.query(characterEquipmentSchema)
    await db.query(characterEquipmentSchema)
    await db.query(`insert into character_assets(id,workflow_id,character_name,asset_type,uri)
      values('legacy',null,'曹操','three-view','legacy.png')`)
    await db.query(`insert into character_biographies(workflow_id,character_name,biography)
      values('','曹操','未关联工作流的人物'),('wf','曹操','曹操自传')`)
    const input = { workflowId: 'wf', characterName: '曹操', description: '披甲', threeViewUrl: 'armor.png', metadata: { continuityKey: 'cao-armor' } }
    const armor = await createCharacterAsset(db, input)
    const casual = await createCharacterAsset(db, { ...input, description: '便服', threeViewUrl: 'casual.png', metadata: { continuityKey: 'cao-casual' } })
    const other = await createCharacterAsset(db, { ...input, workflowId: 'other' })
    const personId = characterPersonId('wf', '曹操')
    await db.query(`insert into voice_characters(id,workflow_id,continuity_key,character_name,current_version)
      values('voice-cao','wf','voice:曹操','曹操',1)`)
    await db.query(`insert into character_voice_versions(character_id,version,binding) values('voice-cao',1,$1::jsonb)`,
      [JSON.stringify({ characterId: 'voice-cao', characterName: '曹操', version: 1, voiceId: 'bound-cao', voiceName: '曹操声音', modelId: 'video', accountScope: 'scope', previewUrl: '/cao-voice.wav' })])
    await db.query(`insert into original_character_voices(character_id,model_id,account_scope,target_model,prefix,description,preview_text,status,voice_id,preview_url)
      values('voice-cao','tts','scope','tts-model','test-cao','中低音、沉稳','试听','ready','original-cao','/cao-original.wav')`)
    const spear = await createCharacterEquipment(db, personId, {
      name: '长枪', kind: 'weapon', description: '骑战用', imageUrl: '/generated/spear.png', aliases: ['丈八蛇矛', '长枪'],
      applicability: { ageStages: ['adult'], lookKeys: ['披甲'], sceneTags: ['战场'] },
    })
    assert.equal(spear.personId, personId)
    assert.deepEqual(spear.aliases, ['丈八蛇矛'])
    await assert.rejects(createCharacterEquipment(db, personId, { name: ' 丈八 蛇矛 ', kind: 'weapon' }), /名称或别名.*冲突/)
    const raced = await Promise.allSettled([
      createCharacterEquipment(db, personId, { name: '方天画戟', kind: 'weapon', aliases: ['画戟'] }),
      createCharacterEquipment(db, personId, { name: '画 戟', kind: 'weapon' }),
    ])
    assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1, 'concurrent alias collisions serialize per person')
    assert.equal(raced.filter(item => item.status === 'rejected').length, 1)
    const racedEquipment = raced.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof createCharacterEquipment>>>
    await deleteCharacterEquipment(db, personId, racedEquipment.value.id)
    assert.equal((await readCharacterEquipment(db, 'wf', ['曹操'])).length, 1)
    assert.equal((await readCharacterEquipment(db, 'other', ['曹操'])).length, 0)
    const grouped = await readCharacterPeople(db)
    const person = grouped.find(item => item.id === personId)
    assert.equal(person?.versions.length, 2)
    assert.equal(person?.equipment.length, 1)
    assert.equal(person?.biography, '曹操自传')
    assert.equal(person?.voice?.voiceId, 'bound-cao')
    assert.equal(person?.voiceAvailable, true)
    assert.equal(person?.originalVoice?.description, '中低音、沉稳')
    assert.equal(person?.originalVoice?.previewUrl, '/cao-original.wav')
    assert.equal(grouped.find(item => item.id === characterPersonId('', '曹操'))?.versions[0]?.id, 'legacy')
    assert.equal(grouped.find(item => item.id === characterPersonId('other', '曹操'))?.versions[0]?.id, other.id)
    assert.equal((await readCharacterPeople(db, 'wf')).length, 1)

    await assert.rejects(updateCharacterAsset(db, armor.id, { ...input, characterName: '曹孟德' }), /不能通过编辑三视图版本更换/)
    assert.equal((await readCharacterAssets(db, 'wf')).find(item => item.id === armor.id)?.characterName, '曹操')
    await assert.rejects(createCharacterEquipment(db, personId, { name: '错', kind: 'weapon', applicability: { ageStages: ['invalid'] } } as never), /年龄阶段无效/)
    await assert.rejects(updateCharacterEquipment(db, characterPersonId('other', '曹操'), spear.id, { name: '青釭剑', kind: 'weapon' }), /不属于该人物/)
    const shield = await createCharacterEquipment(db, personId, { name: '藤盾', kind: 'armor' })
    await assert.rejects(updateCharacterEquipment(db, personId, shield.id, { name: '藤盾', kind: 'armor', aliases: ['长 枪'] }), /名称或别名.*冲突/)
    await deleteCharacterEquipment(db, personId, shield.id)
    const revised = await updateCharacterEquipment(db, personId, spear.id, { name: '长枪', kind: 'weapon', description: '修订', imageUrl: '', aliases: [], applicability: {} })
    assert.equal(revised.description, '修订')
    assert.equal((await readCharacterAssets(db, 'wf')).length, 2, 'equipment writes do not touch portrait rows')

    await deleteCharacterAsset(db, armor.id)
    await deleteCharacterAsset(db, casual.id)
    const remaining = (await readCharacterPeople(db, 'wf'))[0]
    assert.equal(remaining.id, personId)
    assert.deepEqual(remaining.versions, [])
    assert.equal(remaining.equipment[0].id, spear.id)
    assert.equal(remaining.biography, '曹操自传')
    assert.equal(remaining.voice?.voiceId, 'bound-cao', 'voice remains person-owned after every portrait is deleted')
    assert.equal(remaining.originalVoice?.voiceId, 'original-cao')
    await assert.rejects(deleteCharacterEquipment(db, characterPersonId('other', '曹操'), spear.id), /不属于该人物/)
    await deleteCharacterEquipment(db, personId, spear.id)
    assert.equal((await readCharacterPeople(db, 'wf'))[0].biography, '曹操自传')
    assert.equal((await readCharacterAssets(db)).find(item => item.id === other.id)?.threeViewUrl, 'armor.png')
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
