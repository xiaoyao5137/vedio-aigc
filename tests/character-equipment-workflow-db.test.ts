import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import sharp from 'sharp'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { assertCurrentCharacterEquipmentBindings } from '../server/character-equipment-paid-gate.ts'
import { characterBiographySchema, characterEquipmentSchema, characterPersonId, createCharacterAsset, createCharacterEquipment, deleteCharacterEquipment } from '../server/character-assets.ts'
import { voiceSchema } from '../server/character-voices.ts'
import { characterEquipmentPrompt, characterInputsForShot, inheritShotCharacterVisuals } from '../src/character-visual-workflow.ts'

const databaseUrl = process.env.CHARACTER_TEST_DATABASE_URL ?? process.env.VOICE_TEST_DATABASE_URL
const workflowId = 'wf-sanguo-history-drama'
const image = async () => 'data:image/png;base64,' + (await sharp({create:{width:384,height:216,channels:3,background:'#888'}}).png().toBuffer()).toString('base64')
const context = (stage: 'mature' | 'elderly', key: string, description: string) => ({
  version:'character-visual-context-v1', age:{stage,basis:'artistic'}, look:{key,description},
  appearanceConstraints:{hair:stage === 'elderly' ? 'graying' : 'dark',facialHair:'dark'},
})

test('PostgreSQL library recalls two age and scene looks with their own equipment and blocks missing gear before media', {skip: !databaseUrl}, async () => {
  const schema = `character_equipment_workflow_${randomUUID().replaceAll('-','')}`
  const admin = new pg.Pool({connectionString:databaseUrl})
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`})
  try {
    await db.query(voiceSchema)
    await db.query(`create table character_assets (
      id text primary key, workflow_id text, character_name text not null, asset_type text not null,
      uri text not null, prompt text not null default '', version integer not null default 1,
      metadata jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`)
    await db.query(characterBiographySchema)
    await db.query(characterEquipmentSchema)
    const picture = await image()
    const battle = context('mature','battle-cloak','灰色战袍与黑披风')
    const court = context('elderly','court-robe','深青朝服与冠帽')
    const battleSheet = await createCharacterAsset(db,{workflowId,characterName:'张飞',description:'战场三视图',threeViewUrl:picture,
      metadata:{continuityKey:'battle-cloak',visualContext:battle}})
    const courtSheet = await createCharacterAsset(db,{workflowId,characterName:'张飞',description:'朝堂三视图',threeViewUrl:picture,
      metadata:{continuityKey:'court-robe',visualContext:court}})
    const personId = characterPersonId(workflowId,'张飞')
    const spear = await createCharacterEquipment(db,personId,{name:'丈八蛇矛',kind:'weapon',description:'战场长柄蛇矛',imageUrl:'/equipment/spear.png',
      applicability:{ageStages:['mature'],lookKeys:['battle-cloak'],sceneTags:['战场']}})
    const sword = await createCharacterEquipment(db,personId,{name:'佩剑',kind:'weapon',description:'朝服佩剑',imageUrl:'/equipment/sword.png',
      applicability:{ageStages:['elderly'],lookKeys:['court-robe'],sceneTags:['朝堂']}})
    const lookup = async (visualContext:typeof battle,equipmentNames:string[],sceneTags:string[]) => executeBuiltinNode(db,{
      operation:'character.lookup',params:{workflowId,qualityDisposition:'manual-review-v1',
        characters:[{name:'张飞',visualContext,equipmentNames,sceneTags}]},
    })
    const first = await lookup(battle,['丈八蛇矛'],['战场'])
    assert.equal(first.items[0].id,battleSheet.id)
    assert.equal(first.equipmentBindings[0].id,spear.id)
    assert.equal(first.equipmentBindings[0].imageUrl,'/equipment/spear.png')
    const scene={cast:['张飞'],characterVisuals:[{name:'张飞',visualContext:battle}],
      characterEquipment:[{name:'张飞',equipmentNames:['丈八蛇矛'],sceneTags:['战场']}]}
    const shot=inheritShotCharacterVisuals({characters:['张飞']},scene)
    assert.deepEqual(characterInputsForShot(shot),[{name:'张飞',visualContext:battle,equipmentNames:['丈八蛇矛'],sceneTags:['战场']}])
    const request={model:{capability:'video'},executionContext:{workflowId,nodeId:'sanguo-video'},
      prompt:'【场景与开场实景】东汉战场真人实景。\n【场景真实性硬约束】忽略人物参考图的纯色背景。'+characterEquipmentPrompt(first.equipmentBindings),
      params:{referenceImage:'/first.png',referenceImages:[picture],referenceBindings:[{characterName:'张飞',role:'entering',
        entrance:{name:'张飞',startSecond:0,endSecond:3,path:'城门'},visualContext:battle}],
        characters:['张飞'],characterVisuals:scene.characterVisuals,characterEquipment:shot.characterEquipment,
        equipmentBindings:first.equipmentBindings,duration:8,pacingVersion:'dynamic-v1',sound:'on'}}
    assert.doesNotThrow(()=>validateWorkflowMediaContract(request))
    await assertCurrentCharacterEquipmentBindings(db,request)
    assert.throws(()=>validateWorkflowMediaContract({...request,params:{...request.params,equipmentBindings:[]}}),/装备绑定/)
    const second = await lookup(court,['佩剑'],['朝堂'])
    assert.equal(second.items[0].id,courtSheet.id)
    assert.equal(second.equipmentBindings[0].id,sword.id)
    let purchased=0
    await assert.rejects(executeBuiltinNode(db,{operation:'character.ensure',model:{id:'image',provider:'Kling',capability:'image',settings:{}},
      params:{workflowId,qualityDisposition:'manual-review-v1',characters:[{name:'张飞',visualContext:battle,equipmentNames:['未归档铁枪'],sceneTags:['战场']}]}},
    async()=>{purchased++;throw Error('unexpected media purchase')}),/CHARACTER_EQUIPMENT_MISSING/)
    assert.equal(purchased,0)
    await assert.rejects(lookup(battle,['佩剑'],['战场']),/CHARACTER_EQUIPMENT_CONTEXT_MISMATCH/)
    await deleteCharacterEquipment(db,personId,spear.id)
    await assert.rejects(assertCurrentCharacterEquipmentBindings(db,request),/CHARACTER_EQUIPMENT_STALE/)
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
