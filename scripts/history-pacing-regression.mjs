// Reproduce the user's first two actual scenes with the current production
// writer, pacing, transition and media checks. This is NOT a full-episode pass.
import fs from 'node:fs/promises'
import pg from 'pg'
import { request as httpRequest } from 'node:http'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { generateHistoricalStoryboard, storyboardContinuityContext } from '../src/storyboard-runtime.ts'
import { characterAppearanceContext, historicalVideoPrompt, reviewStoryboardMotion, reviewHistoricalMedia, HISTORY_QUALITY_VERSION } from '../src/history-media.ts'
import { reviewHistoricalContent } from '../src/history-review.ts'
import { inspectGeneratedVideo } from '../server/video-inspection.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { SANGUO_FIRST_FRAME_BRANCH_CODE } from '../src/code-node-presets.ts'

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const directory = 'logs/quality-regression/dynamic-first-pair'
await fs.mkdir(directory,{recursive:true})
const runtime=await (await fetch(`${base}/api/runtime-version`)).json()
if(runtime.historyQualityVersion!==HISTORY_QUALITY_VERSION)throw Error('Restart server before running current pacing acceptance')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const state=(await pool.query("select result from execution_records where id='record-5l9z51'")).rows[0].result
const models=(await pool.query("select * from model_configs where id=any($1::text[])",[['claude-opus-4-8','keling3']])).rows
const textModel=models.find(model=>model.id==='claude-opus-4-8')
const videoModel=models.find(model=>model.id==='keling3')
if(new URL(textModel.settings.endpoint).hostname!=='doro.lat')throw Error('Only user-authorized Doro reviewer is allowed')
const original=state.nodeRuns.filter(run=>run.node.id==='sanguo-shot-script'&&run.loopIndex<2)
const names=[...new Set(original.flatMap(run=>run.output.characters))]
const assets=(await pool.query('select distinct on (character_name) character_name as "characterName",uri as url,metadata from character_assets where character_name=any($1::text[]) and workflow_id=$2 order by character_name,updated_at desc',[names,'wf-sanguo-history-drama'])).rows
await pool.end()
if(assets.length!==names.length)throw Error('Missing existing character references; this replay never generates images')
const sources=state.nodeRuns.find(run=>run.node.id==='sanguo-knowledge').output
const app=await fs.readFile('src/App.tsx','utf8')
const template=app.match(/const SANGUO_STORYBOARD_PROMPT = `([\s\S]*?)`\n/)[1].replace(/\\\$/g,'$')
const report={scope:'actual-first-pair-pacing-and-closure-regression-not-full-episode',runtime:HISTORY_QUALITY_VERSION,clips:[],passed:false}
async function saved(file,create){
  try{return JSON.parse(await fs.readFile(`${directory}/${file}.json`,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  const value=await create();await fs.writeFile(`${directory}/${file}.json`,JSON.stringify(value,null,2));return value
}
async function call(model,prompt,params,operation,nodeId){
  const result=await new Promise((resolve,reject)=>{
    const req=httpRequest(`${base}/api/node-run`,{method:'POST',headers:{'content-type':'application/json'}},response=>{
      let body='';response.setEncoding('utf8');response.on('data',part=>{body+=part});response.on('end',()=>{try{resolve(JSON.parse(body))}catch(error){reject(error)}});response.on('error',reject)
    });req.on('error',reject);req.end(JSON.stringify({model,prompt,params,operation,executionContext:{workflowId:'wf-sanguo-history-drama',nodeId,requestKey:`dynamic-first-pair-v1:${nodeId}`}}))
  })
  if(result.status>=400)throw Error(JSON.stringify(result))
  return result.body
}
let previous
for(const [index,old] of original.entries()){
  const scene={...old.inputContext.scene,dramaticUnitId:`dynamic-unit-${index+1}`,closesUnit:true,targetDuration:index?7:10,
    completionCriteria:index?['房植提出议事意见','朝臣明确回应']:['周福接稳印绶','周福口头受命回应']}
  const castAssets=assets.filter(asset=>scene.cast.includes(asset.characterName))
  const designs=characterAppearanceContext(castAssets)
  const context=storyboardContinuityContext({scene,loop:{previous},input:{episode_title:'甘陵党议',aspect_ratio:'16:9'},historical_sources:sources})
  const shot=await saved(`shot-${index}`,()=>generateHistoricalStoryboard({
    prompt:renderWorkflowTemplate(template,context)+`\n【本次修复重点】原15秒素材全部因拖慢及尾部站桩被用户拒绝。保留原史实动作，补全对手明确回应，不要加入无用空等。已有身份：${JSON.stringify(designs)}。${index?'房植说明议事意见后朝臣明确应答，收束后切出。':'授官动作必须接稳印绶，未回应不能结束这场戏。台词只用两句：桓帝：念卿授学之恩，今擢卿为尚书。周福：臣领命，定不负陛下。二人自然简练问答，不增加辅佐朝政等重复赘述。递印接稳可与宣告同时进行，不必先用三秒无声递盒。'}不要套用任何旧15秒排程。`,
    expected:{scene,previousShot:previous?.shot_script,requireContinuityContract:true,requireDynamicPacing:true,requireNarrativeClosure:true,productionSpeechRate:4.5,aspectRatio:'16:9'},
    generate:prompt=>call(textModel,prompt,{},'history.storyboard',`script-${index}`),
    review:async candidate=>{
      const motionReview=await reviewStoryboardMotion({candidate,generate:prompt=>call(textModel,prompt,{},'history.media-review',`motion-${index}`)})
      const review=await reviewHistoricalContent({candidate,scene,characterDesigns:designs,previousShot:previous?.shot_script,citations:sources.citations,generate:prompt=>call(textModel,prompt,{},'history.review',`content-${index}`)})
      return {...review,motionReview}
    },onAttempt:attempt=>console.log(JSON.stringify({stage:'script-repair',index,...attempt})),
  }))
  if(shot.__storyboardSegments)throw Error('Pair replay expanded: inspect the plan before purchasing additional clips')
  console.log(JSON.stringify({stage:'script-ready',index,duration:shot.duration,audioText:shot.audioText}))
  const branch=await executeCodeNode({code:SANGUO_FIRST_FRAME_BRANCH_CODE,context:{shot_script:shot,loop:{previous},character_lookup:{names:scene.cast,existingAssets:castAssets}}})
  const params={...branch.referenceRequest,duration:shot.duration,pacingVersion:shot.pacing.version,aspectRatio:'16:9',sound:'on',mode:'std',multiShot:false}
  // One take per scene. A failed review cannot silently purchase a retake.
  const video=await saved(`video-${index}`,()=>call(videoModel,historicalVideoPrompt(shot),params,undefined,'sanguo-video'))
  const inspection=await saved(`inspection-${index}`,()=>inspectGeneratedVideo({url:video.url??video.data?.task_result?.videos?.[0]?.url,duration:shot.duration,aspectRatio:'16:9',audioText:shot.audioText,audioType:shot.audioType,videoPrompt:shot.videoPrompt,pacing:shot.pacing}))
  // A changed quality policy must re-review existing bytes, never silently
  // accept an old verdict or purchase a replacement video.
  let observations
  try { observations=JSON.parse(await fs.readFile(`${directory}/observations-${index}.json`,'utf8')) } catch(error) { if(error.code!=='ENOENT')throw error }
  if(observations && observations.some((row,frame)=>row.frame!==inspection.frames[frame]))throw Error('Observation cache does not match actual clip frames')
  const visualReview=await saved(`review-${index}-${HISTORY_QUALITY_VERSION}`,()=>reviewHistoricalMedia({shot,frames:inspection.frames,observations,speechEvidence:inspection.speechValidation,generate:(prompt,frames)=>call(textModel,prompt,{reviewImages:frames},'history.media-review',`visual-${index}-${HISTORY_QUALITY_VERSION}`)}))
  previous={shot_script:shot,video_shot:{...inspection,visualReview},last_frame:{available:true,url:inspection.lastFrameUrl}}
  report.clips.push({scene:index+1,...previous})
  await fs.writeFile(`${directory}/report.json`,JSON.stringify(report,null,2))
  console.log(JSON.stringify({stage:'clip-accepted',scene:index+1,url:inspection.url,duration:inspection.duration}))
}
report.passed=true
await fs.writeFile(`${directory}/report.json`,JSON.stringify(report,null,2))
console.log(JSON.stringify({stage:'pair-passed',clips:report.clips.map(clip=>({scene:clip.scene,url:clip.video_shot.url,duration:clip.video_shot.duration}))}))
