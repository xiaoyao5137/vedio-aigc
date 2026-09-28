import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'

const visualContext = {version:'character-visual-context-v1',age:{stage:'mature',basis:'artistic'},
  look:{key:'battle-cloak',description:'灰色战袍与黑披风'},appearanceConstraints:{hair:'dark',facialHair:'dark'}}
const picture = async () => 'data:image/png;base64,' + (await sharp({create:{width:384,height:216,channels:3,background:'#777'}}).png().toBuffer()).toString('base64')
const character = {name:'张飞',visualContext,equipmentNames:['丈八蛇矛'],sceneTags:['战场']}
const gear = (id:string, overrides:Record<string,unknown>={}) => ({id,person_id:'person-zhang',workflow_id:'wf',character_name:'张飞',
  name:'丈八蛇矛',kind:'weapon',description:'长柄蛇矛',image_url:'/equipment/spear.png',aliases:['蛇矛'],
  applicability:{ageStages:['mature'],lookKeys:['battle-cloak'],sceneTags:['战场']},...overrides})
const sheet = (id:string,url:string,equipmentIds?:string[]) => ({id,workflow_id:'wf',character_name:'张飞',asset_type:'three-view',uri:url,prompt:'张飞三视图',version:1,
  metadata:{continuityKey:id,visualContext,...(equipmentIds ? {equipmentIds} : {})}})
const pool = (images:Record<string,unknown>[], equipment:Record<string,unknown>[]) => ({query:async(sql:string) => ({rows:sql.includes('from character_equipment')?equipment:sql.includes('from character_assets')?images:[]})})

test('lookup binds an applicable weapon independently of the age-matched three-view', async () => {
  const url=await picture()
  const elder=sheet('wrong-age',url)
  elder.metadata.visualContext={...visualContext,age:{stage:'elderly',basis:'artistic'}}
  const db=pool([elder,sheet('correct',url,['unrelated-legacy-id'])],[gear('spear-mature')])
  const result=await executeBuiltinNode(db as never,{operation:'character.lookup',params:{workflowId:'wf',characters:[character],qualityDisposition:'manual-review-v1'}})
  assert.equal(result.items[0].id,'correct')
  assert.equal(result.items[0].equipment[0].id,'spear-mature')
  assert.equal(result.equipmentBindings[0].characterName,'张飞')
  assert.equal(result.equipmentBindings[0].name,'丈八蛇矛')
  assert.equal(result.equipmentBindings[0].imageUrl,'/equipment/spear.png')
  assert.equal(result.equipmentBindings[0].requirementSource,'shot_script.characterEquipment')
  assert.deepEqual(result.missingCharacters,[])
  assert.match(result.rejectedAssets[0].reason,/年龄|造型/)
})

test('missing, ambiguous and wrong-context equipment stop before any image purchase', async () => {
  const url=await picture(), image=sheet('sheet',url)
  let purchased=0
  const media=async()=>{purchased++;throw Error('should not purchase')}
  const params={workflowId:'wf',characters:[character],qualityDisposition:'manual-review-v1'}
  await assert.rejects(executeBuiltinNode(pool([image],[]) as never,{operation:'character.lookup',params}),/CHARACTER_EQUIPMENT_MISSING/)
  await assert.rejects(executeBuiltinNode(pool([image],[gear('old',{applicability:{ageStages:['elderly']}})]) as never,
    {operation:'character.ensure',params,model:{id:'image',provider:'Kling',capability:'image',settings:{}}},media),/CHARACTER_EQUIPMENT_CONTEXT_MISMATCH/)
  await assert.rejects(executeBuiltinNode(pool([image],[gear('a'),gear('b')]) as never,{operation:'character.lookup',params}),/CHARACTER_EQUIPMENT_AMBIGUOUS/)
  await assert.rejects(executeBuiltinNode(pool([image],[gear('foreign',{workflow_id:'another'})]) as never,{operation:'character.lookup',params}),/CHARACTER_EQUIPMENT_MISSING/)
  assert.equal(purchased,0)
})

test('an explicit three-view choice remains primary when equipment is independently archived', async () => {
  const url=await picture(), images=[sheet('chosen',url,['another']),sheet('alternative',url,['spear'])]
  const selected=await executeBuiltinNode(pool(images,[gear('spear')]) as never,{operation:'character.lookup',params:{workflowId:'wf',characters:[character],
    characterAssetSelections:{张飞:'chosen'},qualityDisposition:'manual-review-v1'}})
  assert.equal(selected.items[0].id,'chosen')
  assert.equal(selected.equipmentBindings[0].id,'spear')
  const legacy=await executeBuiltinNode(pool([sheet('legacy',url)],[gear('spear')]) as never,{operation:'character.lookup',params:{workflowId:'wf',characters:[character],
    qualityDisposition:'manual-review-v1'}})
  assert.equal(legacy.items[0].id,'legacy','an older sheet without equipment restrictions may serve a matching independent weapon')
})

test('equipment aliases are resolved without changing the archived name, while old records imply no weapon', async () => {
  const url=await picture(), db=pool([sheet('sheet',url)],[gear('spear')])
  const alias=await executeBuiltinNode(db as never,{operation:'character.lookup',params:{workflowId:'wf',characters:[{...character,equipmentNames:['蛇矛']}],qualityDisposition:'manual-review-v1'}})
  assert.equal(alias.equipmentBindings[0].matchedName,'蛇矛')
  assert.equal(alias.equipmentBindings[0].name,'丈八蛇矛')
  assert.equal(alias.equipmentBindings[0].matchReason,'alias')
  const old=await executeBuiltinNode(db as never,{operation:'character.lookup',params:{workflowId:'wf',characters:[{name:'张飞',visualContext}],qualityDisposition:'manual-review-v1'}})
  assert.deepEqual(old.equipmentBindings,[])
  assert.equal(old.items[0].id,'sheet')
})
