import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'

const directory=path.resolve('logs/character-visual-context-20260927'), workflowId='wf-sanguo-history-drama'
const client=new pg.Client({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const post=async(operation,params,model)=>{
  const response=await fetch('http://127.0.0.1:5173/api/builtin-node-run',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({operation,params,model,executionContext:{workflowId,nodeId:'character-visual-context-live',requestKey:`character-visual-${operation}-${Date.now()}`}})})
  const result=await response.json()
  if(!response.ok||result.status>=400)throw Error(`${operation}: ${JSON.stringify(result.body).slice(0,1200)}`)
  return result.body
}
await client.connect()
try{
  await fs.mkdir(directory,{recursive:true})
  await fs.writeFile(path.join(directory,'live-acceptance.json'),JSON.stringify({at:new Date().toISOString(),workflowId,status:'pending'},null,2))
  const historyBefore=(await client.query('SELECT id,xmin::text AS revision FROM execution_records WHERE workflow_id=$1 ORDER BY id',[workflowId])).rows
  const imageBefore=Number((await client.query("SELECT count(*) FROM model_execution_records WHERE workflow_id=$1 AND capability='image'",[workflowId])).rows[0].count)
  const voicesBefore=(await client.query('SELECT id,character_name,continuity_key FROM voice_characters WHERE workflow_id=$1 ORDER BY id',[workflowId])).rows
  const base=(await client.query("SELECT id,uri,metadata FROM character_assets WHERE workflow_id=$1 AND character_name='张飞' AND asset_type='three-view' ORDER BY created_at LIMIT 1",[workflowId])).rows[0]
  assert.ok(base,'Original Zhang Fei asset is missing')
  const workflow=(await client.query('SELECT nodes FROM workflow_configs WHERE id=$1',[workflowId])).rows[0]
  const reviewId=workflow.nodes.find(node=>node.id==='sanguo-character-review')?.modelId
  const reviewModel=(await client.query("SELECT * FROM model_configs WHERE id=$1 AND capability='text'",[reviewId])).rows[0]
  assert.ok(reviewModel&&reviewModel.provider!=='Local','An actual configured visual observer is required')
  const visualContext={version:'character-visual-context-v1',age:{stage:'mature',basis:'artistic',years:{min:32,max:40},asOf:'建安十三年（208年）当阳长坂；确切生年未知'},
    look:{key:'changban-campaign-robe-cloak',description:'东汉末年深灰交领战袍、黑色披风、深色腰封与护腕、黑靴；黑发束髻'},
    appearanceConstraints:{hair:'dark',facialHair:'dark',build:'艺术视觉年龄32至40岁的成熟壮年武将，健康白皙且带自然红润血色，面容英俊利落，宽肩厚背、粗壮有力的臂膀，腰腹结实有力量且不鼓腹，威武壮实；不稚嫩、不衰老'}}
  const actor={name:'张飞',visualContext,...(base.metadata.voiceContinuityKey?{voiceContinuityKey:base.metadata.voiceContinuityKey}:{}),
    description:'张飞，艺术视觉年龄32至40岁的成熟壮年男性，英俊好看、健康白皙带自然红润血色、眉目有威势，宽肩厚背、粗壮臂膀、结实腰腹，有武将力量。汉式黑色长发在头顶束成清晰高髻，发髻高出头顶并用木簪固定；整齐全黑短须，无白发或花白须发；深灰交领战袍、黑披风。',
    designPrompt:'高清真人演员历史电影定妆摄影，真实摄影棚柔光、正常彩色色温，真人皮肤毛孔、唇色和面颊自然血色，禁止黑白片、灰白皮肤、白粉妆、塑料人偶或游戏建模质感。局部灰度附件仅用于眉眼鼻几何身份，绝对不要复制附件灰度色调；整张输出必须自然全彩。发型是东汉男性黑色长发束高髻：头顶明确凸出圆柱状高发髻，用深色发带和横向木簪固定，正侧背三个角度均可清楚看见高髻；不能变为短发背梳。艺术视觉年龄32至40岁，英俊利落、成熟且相对年轻，健康白皙肤色带自然淡粉与暖色血色，脸和双手都用真实人类肤色，不苍白、不漂白、不灰白，也不使用深棕或古铜肤色。浓眉、沉稳威武目光，正常自然表情，眉心不过度深刻皱纹。宽肩厚背、粗壮臂膀，腰腹结实收紧，壮实有力量而不鼓腹。黑色整齐短髭与下巴短须，不出现白色须丝。深灰交领战袍、黑色披风、深色腰封与护腕、黑靴，面料与皮革有真实纹理。纯色背景，完整全身正面、90度侧面、背面横向一行三列，不持兵器。'}
  await fs.writeFile(path.join(directory,'zhangfei-design.json'),JSON.stringify(actor,null,2))
  const miss=await post('character.lookup',{workflowId,characters:[actor],qualityDisposition:'manual-review-v1'})
  await fs.writeFile(path.join(directory,'lookup-before.json'),JSON.stringify(miss,null,2))
  let asset=miss.items[0], generationCount=0
  if(!asset){
    assert.ok(process.argv.includes('--generate'),'New variant is missing; pass --generate to make the authorized portrait')
    console.log('Reviewing original actor identity without changing old image or execution records')
    await post('character.appearance',{workflowId,characters:['张飞'],qualityDisposition:'manual-review-v1'},reviewModel)
    const imageModel=(await client.query('SELECT * FROM model_configs WHERE id=$1',['kling-image-3'])).rows[0]
    console.log('Generating one current-age Zhang Fei triptych through configured production image model')
    const candidate=await post('character.ensure',{workflowId,characters:[actor],allCharacters:[actor],existingAssets:[],deferArchive:true,
      validateThreeView:true,qualityDisposition:'manual-review-v1',maxGenerationAttempts:1,identityReferenceAssetId:base.id},imageModel)
    await fs.writeFile(path.join(directory,'generated-candidate.json'),JSON.stringify(candidate,null,2))
    generationCount=candidate.generatedCount
    console.log('Independently observing actual new image, including hair, beard and age class')
    const observation=await post('character.appearance',{workflowId,assets:candidate.items,qualityDisposition:'manual-review-v1'},reviewModel)
    await fs.writeFile(path.join(directory,'actual-appearance.json'),JSON.stringify(observation,null,2))
    const archived=await post('character.archive',{workflowId,characters:[actor],generatedAssets:{items:observation.items},qualityDisposition:'manual-review-v1'})
    await fs.writeFile(path.join(directory,'archive.json'),JSON.stringify(archived,null,2))
    asset=archived.items[0]
  }
  const same=await post('character.lookup',{workflowId,characters:[actor],qualityDisposition:'manual-review-v1'})
  assert.equal(same.missingCount,0)
  assert.equal(same.items[0].id,asset.id)
  const otherAge=await post('character.lookup',{workflowId,characters:[{...actor,visualContext:{...visualContext,age:{stage:'elderly',basis:'artistic',asOf:'对照检查，非张飞史实年龄'}}}],qualityDisposition:'manual-review-v1'})
  assert.equal(otherAge.missingCount,1)
  const otherLook=await post('character.lookup',{workflowId,characters:[{...actor,visualContext:{...visualContext,look:{key:'court-robes',description:'朝服对照'}}}],qualityDisposition:'manual-review-v1'})
  assert.equal(otherLook.missingCount,1)
  const reuse=await post('character.ensure',{workflowId,characters:[actor],allCharacters:[actor],qualityDisposition:'manual-review-v1',validateThreeView:true},
    (await client.query('SELECT * FROM model_configs WHERE id=$1',['kling-image-3'])).rows[0])
  assert.equal(reuse.generatedCount,0)
  const historyAfter=(await client.query('SELECT id,xmin::text AS revision FROM execution_records WHERE workflow_id=$1 ORDER BY id',[workflowId])).rows
  assert.deepEqual(historyAfter,historyBefore,'Historical execution records must be unchanged')
  const imageAfter=Number((await client.query("SELECT count(*) FROM model_execution_records WHERE workflow_id=$1 AND capability='image'",[workflowId])).rows[0].count)
  const imageLedger=(await client.query("SELECT id,model_id,status,task_id,response_data->'data'->>'final_unit_deduction' AS deducted_units,response_data->'data'->>'task_status_msg' AS provider_message FROM model_execution_records WHERE workflow_id=$1 AND node_id='character-visual-context-live' AND capability='image' ORDER BY created_at",[workflowId])).rows
  assert.deepEqual((await client.query('SELECT id,character_name,continuity_key FROM voice_characters WHERE workflow_id=$1 ORDER BY id',[workflowId])).rows,voicesBefore,'Age/costume variants must not create new voice identities')
  const originalVoices=voicesBefore.filter(voice=>voice.character_name==='张飞')
  if(originalVoices.length)assert.ok(originalVoices.some(voice=>voice.continuity_key===asset.metadata?.voiceContinuityKey),'The new portrait must retain an existing voice identity')
  const old=(await client.query('SELECT id,uri FROM character_assets WHERE id=$1',[base.id])).rows[0]
  assert.equal(old?.uri,base.uri,'Original portrait URL must remain unchanged')
  const proof={at:new Date().toISOString(),workflowId,status:'complete',baseAssetId:base.id,newAssetId:asset.id,generationCount,imageRequestsAdded:imageAfter-imageBefore,
    sameVariantRecalled:true,repeatedEnsureGeneratedCount:reuse.generatedCount,otherAgeMissing:true,otherCostumeMissing:true,
    oldAssetPreserved:Boolean(old),voiceIdentitiesUnchanged:true,existingZhangFeiVoiceCount:originalVoices.length,imageRequestLedger:imageLedger,
    preservedExecutionRows:historyBefore.length,historyHash:hash(historyBefore),referenceImage:asset.metadata?.visualProfile?.referenceImage,
    visualContext:asset.metadata?.visualContext,voiceContinuityKey:asset.metadata?.voiceContinuityKey}
  await fs.writeFile(path.join(directory,'live-acceptance.json'),JSON.stringify(proof,null,2))
  console.log(JSON.stringify(proof,null,2))
}catch(error){
  await fs.writeFile(path.join(directory,'live-acceptance.json'),JSON.stringify({at:new Date().toISOString(),workflowId,status:'failed',error:String(error)},null,2))
  throw error
}finally{await client.end()}
