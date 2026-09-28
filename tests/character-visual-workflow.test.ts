import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { assertSelectedCharacterVisuals, CHARACTER_VISUAL_CONTEXT_RUNTIME_VERSION, CHARACTER_VISUAL_OUTLINE_PROMPT, characterEquipmentCatalog, characterInputsForShot, characterSelectionsForEpisode, characterVisualCatalog, inheritShotCharacterVisuals, resolveCharacterVisualSelections, upgradeCharacterVisualWorkflow, upgradePersistedSanguoCharacterWorkflow, validatedCharacterEquipment, validatedCharacterVisuals } from '../src/character-visual-workflow.ts'
import { validateDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { SANGUO_CHARACTER_LOOKUP_CODE } from '../src/code-node-presets.ts'
import { chantScene, chantShot } from './fixtures/duration-v2-chant.ts'
import { characterAssetEpisodeScopeMatches } from '../src/character-visual-context.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'

const context = () => ({version:'character-visual-context-v1',age:{stage:'mature',basis:'artistic',asOf:'建安十三年（208年）'},
  look:{key:'campaign-robe',description:'深灰交领战袍与黑色披风'},appearanceConstraints:{hair:'dark',facialHair:'dark',build:'壮实威武'}})
const binding = (name='张飞') => ({name,visualContext:context()})

test('an explicitly scoped Changban selection applies to 518 but not later Zhang Fei episodes', () => {
  const configured = {张飞:{assetId:'zhang-changban',episodes:[518]},刘备:{assetId:'liu-changban',episodes:[518]}}
  assert.deepEqual(characterSelectionsForEpisode(configured,518),{张飞:'zhang-changban',刘备:'liu-changban'})
  assert.deepEqual(characterSelectionsForEpisode(JSON.stringify(configured),610),{})
  assert.deepEqual(characterSelectionsForEpisode(configured,693),{})
  assert.deepEqual(characterSelectionsForEpisode({张飞:'explicit-any-episode'},610),{张飞:'explicit-any-episode'},'legacy/manual selections retain global meaning')
  for (const invalid of [{张飞:{assetId:'sheet',episodes:[]}}, {张飞:{assetId:'sheet',episodes:['518']}},
    {张飞:{assetId:'sheet',episodes:[518],look:'other'}}, {张飞:{assetId:'same',episodes:[518]},刘备:{assetId:'same',episodes:[518]}}]) {
    assert.throws(()=>characterSelectionsForEpisode(invalid,518),/CHARACTER_VISUAL_SELECTION_INVALID/)
  }
})

test('an archived episode-scoped look is absent from another episode\'s optional writer catalogue', () => {
  const sheet={name:'张飞',workflowId:'sanguo',metadata:{visualContext:context(),episodeScope:{episodes:[518]}}}
  assert.equal(characterAssetEpisodeScopeMatches(sheet,518),true)
  assert.equal(characterAssetEpisodeScopeMatches(sheet,610),false)
  assert.deepEqual(characterVisualCatalog([sheet],'sanguo',{input:{episode_number:610,episode_title:'张飞释严颜'}}),[])
  assert.equal(characterVisualCatalog([sheet],'sanguo',{input:{episode_number:518,episode_title:'张飞据水'}}).length,1)
  assert.equal(characterVisualCatalog([sheet],'sanguo',{input:{episode_number:610,episode_title:'张飞释严颜'}},
    [{name:'张飞',assetId:'chosen',visualContext:context()}]).length,1,'a conscious explicit selection still takes precedence')
})

test('writer catalogue preserves canonical clothing without importing unrelated assets or raw media', () => {
  const asset={name:'张飞',workflowId:'sanguo',imageUrl:'https://private-image',voiceId:'private-voice',metadata:{visualContext:context()}}
  const catalog=characterVisualCatalog([asset,asset,{...asset,workflowId:'other'},{...asset,name:'曹操'},
    {...asset,metadata:{visualContext:{bad:true}}}], 'sanguo', {episode_title:'张飞据水断桥'})
  assert.equal(catalog.length,1)
  assert.deepEqual(catalog[0].look,context().look)
  assert.equal(JSON.stringify(catalog).includes('private'),false)
  assert.equal(characterVisualCatalog([{...asset,name:undefined,characterName:'张飞'}],'sanguo','张飞').length,1,'library API uses characterName, not writer name')
  const variants=Array.from({length:40},(_,index)=>({...asset,metadata:{visualContext:{...context(),look:{key:`look-${index}`,description:'完整造型定义'}}}}))
  assert.equal(characterVisualCatalog(variants,'sanguo','张飞').length,6)
})

test('approved scene stage reaches lookup before any library asset can redefine the character', () => {
  const scene={cast:['张飞','刘备'],characterVisuals:[binding(),binding('刘备')]}
  const shot=inheritShotCharacterVisuals({characters:['张飞'],presentCharacters:['张飞']},scene)
  assert.deepEqual(shot.characterVisuals,[binding()])
  assert.deepEqual(characterInputsForShot(shot),[binding()])
  assert.deepEqual(characterInputsForShot({characters:scene.cast,characterVisuals:scene.characterVisuals}),scene.characterVisuals,'pre-storyboard appearance lookup must also use current scene ages')
  assert.equal('characterVisuals' in inheritShotCharacterVisuals({characters:['张飞']},{cast:['张飞']}),false)
  assert.throws(()=>inheritShotCharacterVisuals({...shot,characterVisuals:[{name:'张飞',visualContext:{...context(),age:{stage:'elderly',basis:'artistic'}}}]},scene),/不得改写/)
  assert.throws(()=>validatedCharacterVisuals([binding(),binding()],['张飞'],'cast'),/唯一/)
  assert.throws(()=>validatedCharacterVisuals([binding('曹操')],['张飞'],'cast'),/当前cast/)
})

test('approved equipment requirements reach lookup and an empty approved list cannot be expanded by a shot', () => {
  const scene={cast:['张飞'],characterVisuals:[binding()],characterEquipment:[{name:'张飞',equipmentNames:['丈八蛇矛'],sceneTags:['战场']}]}
  const shot=inheritShotCharacterVisuals({characters:['张飞']},scene)
  assert.deepEqual(shot.characterEquipment,scene.characterEquipment)
  assert.deepEqual(characterInputsForShot(shot),[{...binding(),equipmentNames:['丈八蛇矛'],sceneTags:['战场']}])
  assert.throws(()=>inheritShotCharacterVisuals({characters:['张飞'],characterEquipment:[{name:'张飞',equipmentNames:['青龙偃月刀']}]},scene),/CHARACTER_EQUIPMENT_REQUIREMENT_MISMATCH/)
  assert.throws(()=>inheritShotCharacterVisuals({characters:['张飞'],characterEquipment:[{name:'张飞',equipmentNames:['丈八蛇矛']}]},{...scene,characterEquipment:[]}),/CHARACTER_EQUIPMENT_REQUIREMENT_MISMATCH/)
  assert.deepEqual(characterInputsForShot({characters:['张飞']}),[{name:'张飞'}], 'old checkpoints have no implied equipment')
  assert.throws(()=>validatedCharacterEquipment([{name:'曹操',equipmentNames:['长剑']}],['张飞'],'scene.characterEquipment'),/当前cast/)
  assert.throws(()=>validatedCharacterEquipment([{name:'张飞',equipmentNames:['长剑','长剑']}],['张飞'],'scene.characterEquipment'),/不得重复/)
})

test('writer equipment catalogue uses relevant archived names without media URLs', () => {
  const inventory=[{workflowId:'wf',characterName:'张飞',name:'丈八蛇矛',kind:'weapon',aliases:['蛇矛'],imageUrl:'private-image',
    applicability:{ageStages:['mature'],lookKeys:['campaign-robe'],sceneTags:['战场']}}]
  const catalog=characterEquipmentCatalog([...inventory,{...inventory,workflowId:'other'}],'wf',{episode_title:'张飞出战'})
  assert.equal(catalog.length,1)
  assert.equal(catalog[0].name,'丈八蛇矛')
  assert.equal(JSON.stringify(catalog).includes('private-image'),false)
  assert.deepEqual(characterEquipmentCatalog(inventory,'wf',{episode_title:'曹操出征'}),[])
  assert.match(CHARACTER_VISUAL_OUTLINE_PROMPT,/即使目录没有剧情明确要求的装备，也保留剧情原名/)
})

test('schema 153 hydration only upgrades character fields and preserves separately approved acceptance code', () => {
  const original={id:'wf-sanguo-history-drama',schemaVersion:153,nodes:[
    {id:'sanguo-scene-outline-accept',prompt:'',code:'// PRINCIPLE_POLICY_START\napproved editorial policy\n// PRINCIPLE_POLICY_END'},
    {id:'sanguo-shot-script-accept',prompt:'',code:'// PRINCIPLE_POLICY_START\napproved editorial policy\n// PRINCIPLE_POLICY_END'},
    {id:'sanguo-scene-outline',prompt:'旧提示'},
    {id:'sanguo-shot-script',prompt:'旧提示'},
    {id:'sanguo-character-lookup',prompt:'',code:'const character_lookup_result = customCharacterLookup()'},
    {id:'sanguo-first-frame-branch',prompt:'',code:'const referenceBindings = orderedNames.map(customBinding)'},
  ]}
  const once=upgradePersistedSanguoCharacterWorkflow(original,()=>{throw Error('legacy upgrades must not run')})
  assert.equal(once.schemaVersion,154)
  assert.equal(once.nodes[0].code,original.nodes[0].code)
  assert.equal(once.nodes[1].code,original.nodes[1].code)
  assert.equal(once.nodes[4].code,original.nodes[4].code,'custom lookup code must not be replaced by a marker match')
  assert.equal(once.nodes[5].code,original.nodes[5].code,'custom first-frame code must not be replaced by a marker match')
  assert.deepEqual(upgradePersistedSanguoCharacterWorkflow(once,()=>{throw Error('legacy upgrades must not run')}),once)
  const legacy={...original,schemaVersion:152}
  assert.equal(upgradePersistedSanguoCharacterWorkflow(legacy,workflow=>({...workflow,schemaVersion:153})).schemaVersion,153)
})

const editorialBackup = new URL('../logs/dramatic-expression/editorial-text-hold-migration/workflow-before-1790586259232.json',import.meta.url)
test('current acceptance policy survives schema 153 hydration twice', {skip: !existsSync(editorialBackup)}, () => {
  const saved=JSON.parse(readFileSync(editorialBackup,'utf8'))
  const approved=upgradePrincipleQuality({...saved,schemaVersion:saved.schema_version})
  const once=upgradePersistedSanguoCharacterWorkflow(approved,()=>{throw Error('legacy upgrades must not run')})
  const twice=upgradePersistedSanguoCharacterWorkflow(once,()=>{throw Error('legacy upgrades must not run')})
  const hash=(value:string)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
  for(const id of ['sanguo-scene-outline-accept','sanguo-shot-script-accept']) {
    const expected=hash(approved.nodes.find((node:{id:string})=>node.id===id).code)
    assert.equal(hash(once.nodes.find((node:{id:string})=>node.id===id).code),expected)
    assert.equal(hash(twice.nodes.find((node:{id:string})=>node.id===id).code),expected)
  }
  assert.deepEqual(twice,once)
})

test('real duration-v2 validation inherits age metadata while preserving its signed sound/action plan', () => {
  const raw=chantShot(), scene={...chantScene,cast:['传唱歌谣的乡人'],characterVisuals:[binding('传唱歌谣的乡人')]}
  const accepted=validateHistoricalStructuredOutput('history.storyboard',raw,{scene}) as Record<string,unknown>
  assert.deepEqual(accepted.characterVisuals,scene.characterVisuals)
  assert.deepEqual(characterInputsForShot(accepted),scene.characterVisuals)
  assert.equal(raw.audioText,accepted.audioText)
  assert.equal(raw.pacing.beats.length,(accepted.pacing as typeof raw.pacing).beats.length)
})

test('new storyboard contract requires explicit empty equipment while legacy checkpoints remain resumable', () => {
  const scene={...chantScene,cast:['传唱歌谣的乡人'],characterVisuals:[binding('传唱歌谣的乡人')],characterEquipment:[]}
  const raw=chantShot()
  assert.throws(()=>validateHistoricalStructuredOutput('history.storyboard',raw,{scene,requireCharacterEquipment:true}),/characterEquipment 必须显式/)
  const explicit=validateHistoricalStructuredOutput('history.storyboard',{...raw,characterEquipment:[]},{scene,requireCharacterEquipment:true}) as Record<string,unknown>
  assert.deepEqual(explicit.characterEquipment,[])
  assert.doesNotThrow(()=>validateHistoricalStructuredOutput('history.storyboard',raw,{scene}))
})

test('outline requires every named cast design only in the explicitly upgraded workflow', () => {
  const original=JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json',import.meta.url),'utf8'))
  assert.doesNotThrow(()=>validateDramaOutline(original,{requireDramaContract:true}))
  assert.throws(()=>validateDramaOutline(original,{requireDramaContract:true,requireCharacterVisuals:true}),/characterVisuals/)
  const candidate=structuredClone(original)
  candidate.scenes.forEach((scene:{cast:string[];characterVisuals:unknown[]})=>{scene.characterVisuals=scene.cast.map(name=>binding(name))})
  assert.doesNotThrow(()=>validateDramaOutline(candidate,{requireDramaContract:true,requireCharacterVisuals:true}))
  assert.throws(()=>validateDramaOutline(candidate,{requireDramaContract:true,requireCharacterEquipment:true}),/characterEquipment 必须显式/)
  candidate.scenes.forEach((scene:{characterEquipment?:unknown[]})=>{scene.characterEquipment=[]})
  assert.doesNotThrow(()=>validateDramaOutline(candidate,{requireDramaContract:true,requireCharacterEquipment:true}))
  assert.doesNotThrow(()=>validateHistoricalStructuredOutput('history.scene-outline',candidate,{}),
    'the real outline output whitelist must pass the structured equipment field')
  const sourced=structuredClone(candidate)
  const sourceActor=sourced.scenes.find((scene:{cast:string[]})=>scene.cast.length).characterVisuals[0]
  sourceActor.visualContext.age={stage:'mature',basis:'estimated',sourceRefs:['[史料99]']}
  assert.throws(()=>validateDramaOutline(sourced,{requireDramaContract:true,sourceRefs:['[史料1]','[史料2]']}),/age.sourceRefs 引用不存在的 \[史料99\]/)
  assert.throws(()=>validateDramaOutline(sourced,{requireDramaContract:true}),/age.sourceRefs 缺少本集已核对来源/)
  const occupied=candidate.scenes.find((scene:{cast:string[]})=>scene.cast.length)
  occupied.characterVisuals=[]
  assert.throws(()=>validateDramaOutline(candidate,{requireDramaContract:true}),/覆盖本段cast/)
})

test('generation code retains requested variant and clear design after a name-only cache miss', async () => {
  const result=await executeCodeNode({code:SANGUO_CHARACTER_LOOKUP_CODE,context:{shot_script:{characters:['张飞'],visualPrompt:'张飞勒马',firstFramePrompt:'张飞立于河岸',lastFramePrompt:'张飞留在岸边'},
    character_lookup_result:{items:[],missingCharacters:[{...binding(),continuityKey:'visual-version',visualDesignText:'成熟壮年，黑发黑须，无白发白须'}]}}}) as {missingCharacters:Array<Record<string,unknown>>}
  assert.deepEqual(result.missingCharacters[0].visualContext,context())
  assert.match(String(result.missingCharacters[0].designPrompt),/无白发白须/)
})

test('schema150 upgrade preserves models, graph, custom prompts and existing video settings', () => {
  const workflow={id:'wf-sanguo-history-drama',schemaVersion:145,edges:[{from:'a',to:'b'}],nodes:[
    {id:'sanguo-scene-outline',prompt:'原史料 ${historical_sources}',modelId:'chosen',params:[]},
    {id:'sanguo-shot-script',prompt:'用户规则 ${scene}',params:[]},
    {id:'sanguo-character-lookup',prompt:'人物库',code:'// character_lookup_result',params:[]},
    {id:'sanguo-video',prompt:'原视频',modelId:'paid-provider',params:[{name:'resolution',value:'4k'}]},
    {id:'custom',prompt:'用户自定义',params:[]},
    {id:'sanguo-input',prompt:'运行输入',params:[{name:'episode_number',type:'number',value:'518'}]},
  ]}
  const upgraded=upgradeCharacterVisualWorkflow(workflow)
  assert.equal(upgraded.schemaVersion,151)
  assert.equal(CHARACTER_VISUAL_CONTEXT_RUNTIME_VERSION,'2026-09-28-character-equipment-v1')
  assert.deepEqual(upgradeCharacterVisualWorkflow(upgraded),upgraded)
  const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,reorder(item)])):value
  const persisted=reorder(upgraded) as typeof upgraded
  assert.equal(upgradeCharacterVisualWorkflow(persisted),persisted,'jsonb key order must not trigger a phantom upgrade')
  assert.deepEqual(upgraded.edges,workflow.edges)
  assert.equal(upgraded.nodes[0].modelId,'chosen')
  assert.match(upgraded.nodes[0].prompt,/原史料 \$\{historical_sources\}/)
  assert.deepEqual(upgraded.nodes[3].params[0],workflow.nodes[3].params[0])
  assert.deepEqual(upgraded.nodes[4],workflow.nodes[4])
  assert.deepEqual(upgraded.nodes[5].params[0],workflow.nodes[5].params[0])
  assert.deepEqual(upgraded.nodes[5].params[1],{id:'character-asset-selections-input',name:'所选人物三视图',englishName:'characterAssetSelections',type:'json',required:false,value:'{}'})
  upgraded.nodes[5].params[1].value='{"张飞":"approved-sheet"}'
  assert.equal(upgradeCharacterVisualWorkflow(upgraded).nodes[5].params[1].value,'{"张飞":"approved-sheet"}','an existing explicit selection must survive upgrades')
  assert.match(upgraded.nodes[0].prompt,/\$\{selectedCharacterVisuals\}/)
  assert.match(upgraded.nodes[1].prompt,/\$\{selectedCharacterVisuals\}/)
})

const selectedAsset = () => ({id:'approved-sheet',workflowId:'sanguo',characterName:'张飞',threeViewUrl:'https://private-sheet',
  metadata:{visualContext:context()},visualContext:{...context(),age:{stage:'elderly',basis:'artistic'}}})

test('explicit selection resolves actual archived context and rejects wrong identity, type or ambiguity before media', () => {
  const asset=selectedAsset()
  const resolved=resolveCharacterVisualSelections([asset],'sanguo','{"张飞":"approved-sheet"}')
  assert.deepEqual(resolved,[{name:'张飞',assetId:'approved-sheet',visualContext:context()}],'only archived metadata is authoritative, not a top-level caller design')
  assert.deepEqual(resolveCharacterVisualSelections([asset],'sanguo',undefined),[])
  assert.deepEqual(resolveCharacterVisualSelections([asset],'sanguo',{}),[])
  assert.deepEqual(resolveCharacterVisualSelections([{id:asset.id,workflow_id:'sanguo',character_name:'张飞',asset_type:'three-view',uri:'local-sheet',metadata:asset.metadata}],
    'sanguo',{'张飞':asset.id}),resolved,'database rows and library API shapes both resolve')
  for (const candidate of [{...asset,workflowId:'other'},{...asset,characterName:'曹操'},{...asset,assetType:'portrait'},
    {...asset,threeViewUrl:''},{...asset,metadata:{}},{...asset,metadata:{visualContext:{bad:true}}}]) {
    assert.throws(()=>resolveCharacterVisualSelections([candidate],'sanguo',{'张飞':asset.id}),/CHARACTER_VISUAL_SELECTION_INVALID/)
  }
  assert.throws(()=>resolveCharacterVisualSelections([asset,asset],'sanguo',{'张飞':asset.id}),/ID不唯一/)
  assert.throws(()=>resolveCharacterVisualSelections([asset],'sanguo',{'张飞':'missing'}),/不存在/)
  assert.throws(()=>resolveCharacterVisualSelections([asset],'sanguo',{'张飞':asset.id,'曹操':asset.id}),/唯一|同人物/)
  for (const input of ['bad-json','[]','null',[],{'张飞':{}},{' 张飞':asset.id}]) {
    assert.throws(()=>resolveCharacterVisualSelections([asset],'sanguo',input),/CHARACTER_VISUAL_SELECTION_INVALID/)
  }
})

test('selected catalogue suppresses every alternate candidate without leaking images or voices', () => {
  const selected=resolveCharacterVisualSelections([selectedAsset()],'sanguo',{'张飞':'approved-sheet'})
  const competing={...selectedAsset(),id:'intermediate',metadata:{visualContext:{...context(),appearanceConstraints:{hair:'dark',facialHair:'dark',build:'不同体型'}}}}
  const catalog=characterVisualCatalog([competing,selectedAsset(),{...competing,characterName:'刘备'}],'sanguo','张飞与刘备',selected)
  assert.deepEqual(catalog.filter(row=>row.name==='张飞'),[{...selected[0],selected:true}])
  assert.equal(catalog.filter(row=>row.name==='刘备').length,1)
  assert.equal(JSON.stringify(catalog).includes('private-sheet'),false)
  assert.equal(JSON.stringify(catalog).includes('不同体型'),true,'unselected actors retain their ordinary catalogue')
  assert.deepEqual(characterVisualCatalog([competing],'sanguo','无人环境',selected),[])
})

test('writer catalogue excludes historical and review-pending portraits; pending cannot be selected into workflow', () => {
  const base = selectedAsset()
  const history = { ...base, id: 'history', metadata: { ...base.metadata, portraitLifecycle: { status: 'superseded' } } }
  const pending = { ...base, id: 'pending', metadata: { ...base.metadata, identityConsistency: { status: 'needs_manual_review' } } }
  const preservedPaid = { ...base, id: 'paid', metadata: { ...base.metadata, portraitLifecycle: { status: 'pending-review' } } }
  assert.deepEqual(characterVisualCatalog([history, pending, preservedPaid], 'sanguo', '张飞据水'), [])
  assert.throws(() => resolveCharacterVisualSelections([pending], 'sanguo', { 张飞: 'pending' }), /CHARACTER_IDENTITY_REVIEW_REQUIRED/)
  assert.throws(() => resolveCharacterVisualSelections([preservedPaid], 'sanguo', { 张飞: 'paid' }), /CHARACTER_IDENTITY_REVIEW_REQUIRED/)
  assert.equal(characterVisualCatalog([base, history, pending, preservedPaid], 'sanguo', '张飞据水').length, 1)
})

test('selected cast must explicitly preserve full design and artistic age provenance in outline and shot', () => {
  const selected=resolveCharacterVisualSelections([selectedAsset()],'sanguo',{'张飞':'approved-sheet'})
  const shot={characters:['张飞'],characterVisuals:[binding()]}
  assert.doesNotThrow(()=>assertSelectedCharacterVisuals(shot,selected))
  assert.doesNotThrow(()=>assertSelectedCharacterVisuals({cast:[],characterVisuals:[]},selected))
  assert.doesNotThrow(()=>assertSelectedCharacterVisuals({scenes:[{cast:['张飞'],characterVisuals:[binding()]}],characterDramas:[binding()]},selected))
  for (const visualContext of [{...context(),age:{stage:'elderly',basis:'artistic'}},
    {...context(),look:{key:'campaign-robe',description:'红袍白披风'}},
    {...context(),appearanceConstraints:{hair:'dark',facialHair:'dark',build:'中间候选体型'}},
    {...context(),age:{...context().age,basis:'documented',sourceRefs:['[史料1]']}},
    {...context(),age:{...context().age,asOf:'另一个时代'}}]) {
    assert.throws(()=>assertSelectedCharacterVisuals({...shot,characterVisuals:[{name:'张飞',visualContext}]},selected),/CHARACTER_VISUAL_SELECTION_MISMATCH[\s\S]*approved-sheet/)
  }
  assert.throws(()=>assertSelectedCharacterVisuals({characters:['张飞']},selected),/必须唯一声明/)
  assert.throws(()=>assertSelectedCharacterVisuals({...shot,characterVisuals:[binding(),binding()]},selected),/必须唯一声明/)
  assert.throws(()=>assertSelectedCharacterVisuals({presentCharacters:['张飞'],characterVisuals:[]},selected),/必须唯一声明/)
  assert.throws(()=>assertSelectedCharacterVisuals({scenes:[{cast:['张飞'],characterVisuals:[]}]},selected),/scenes\[0\]/)
  assert.throws(()=>assertSelectedCharacterVisuals({scenes:[{cast:[],characterVisuals:[]}],characterDramas:[{name:'张飞',visualContext:{...context(),age:{stage:'elderly',basis:'artistic'}}}]},selected),/characterDramas.张飞/)
})

test('historical outline acceptance applies expected selected designs rather than accepting another valid candidate', () => {
  const original=JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json',import.meta.url),'utf8'))
  const name=original.scenes.find((scene:{cast:string[]})=>scene.cast.length).cast[0]
  const selected=resolveCharacterVisualSelections([{...selectedAsset(),characterName:name}],'sanguo',{[name]:'approved-sheet'})
  original.scenes.forEach((scene:{cast:string[];characterVisuals:unknown[]})=>{scene.characterVisuals=scene.cast.map(actor=>binding(actor))})
  assert.doesNotThrow(()=>validateDramaOutline(original,{requireDramaContract:true,selectedCharacterVisuals:selected}))
  const changed=structuredClone(original)
  const scene=changed.scenes.find((scene:{cast:string[]})=>scene.cast.includes(name))
  scene.characterVisuals.find((row:{name:string})=>row.name===name).visualContext.appearanceConstraints.build='中间候选体型'
  assert.throws(()=>validateDramaOutline(changed,{requireDramaContract:true,selectedCharacterVisuals:selected}),/CHARACTER_VISUAL_SELECTION_MISMATCH/)
  delete scene.characterVisuals
  assert.throws(()=>validateDramaOutline(changed,{requireDramaContract:true,selectedCharacterVisuals:selected}),/必须唯一声明/)
})
