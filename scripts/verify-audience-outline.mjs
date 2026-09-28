import fs from 'node:fs/promises'
import pg from 'pg'
import { upgradeAudienceSceneOutline } from '../src/quality-node-presets.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const directory=`logs/audience-outline/${Date.now()}`
try {
 const original=JSON.parse(await fs.readFile('logs/first-loop-delivery/execution.json','utf8'))
 const sourceRun=original.result.nodeRuns.find(n=>n.node.id==='sanguo-scene-outline')
 const row=(await pool.query('select * from workflow_configs where id=$1',[original.workflow_id])).rows[0]
 const workflow=upgradeAudienceSceneOutline({...row,schemaVersion:row.schema_version})
 const node=workflow.nodes.find(n=>n.id===sourceRun.node.id)
 const model=(await pool.query('select * from model_configs where id=$1',[node.modelId])).rows[0]
 const context={...sourceRun.inputContext,retry:{attempt:1,feedback:''}}
 let prompt=renderWorkflowTemplate(node.prompt,context)
 if(process.argv[2]){
  const previous=JSON.parse(await fs.readFile(process.argv[2],'utf8'))
  const diagnostics=[]
  for(const validate of [()=>validateHistoricalProductionPlan(previous),()=>validateHistoricalAgency(previous,context.historical_sources.citations),
   ()=>validateHistoricalStructuredOutput(node.operation,previous,{...sourceRun.inputs,requireBeatCoverage:true,requireNarrativeClosure:true,requireEditorialGrammar:true})]){
   try{validate()}catch(error){diagnostics.push(error instanceof Error?error.message:String(error))}
  }
  const clean=structuredClone(previous);delete clean.raw;delete clean.text;delete clean.model
  prompt+='\n【上一版实际输出需要定向修复】'+JSON.stringify(clean)+'\n【完整校验错误】'+[...new Set(diagnostics)].join('\n')+'\n只修复错误点及直接依赖；保留已通过的独立开场、承接镜头、史实、场景、人物、节拍、id和原声画义务。旁白按4.5汉字/秒以内自然语速重新拆分或精简，不得加速。只返回完整修正JSON。'
 }
 await fs.mkdir(directory,{recursive:true})
 await fs.writeFile(directory+'/workflow-before.json',JSON.stringify(row,null,2))
 await fs.writeFile(directory+'/prompt.txt',prompt)
 const response=await fetch('http://127.0.0.1:5173/api/node-run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,prompt,params:sourceRun.inputs,operation:node.operation,executionContext:{workflowId:row.id,nodeId:node.id,nodeName:node.title,requestKey:`audience-outline-${Date.now()}`}})})
 const result=await response.json()
 if(!response.ok||result.status>=400)throw Error(JSON.stringify(result))
 const output=normalizeStructuredTextOutput(result.body,extractTextResponse(result.body),'json')
 await fs.writeFile(directory+'/candidate.json',JSON.stringify(output,null,2))
 validateHistoricalProductionPlan(output)
 validateHistoricalAgency(output,context.historical_sources.citations)
 const validated=validateHistoricalStructuredOutput(node.operation,output,{...sourceRun.inputs,requireBeatCoverage:true,requireNarrativeClosure:true,requireEditorialGrammar:true})
 await fs.writeFile(directory+'/validated.json',JSON.stringify(validated,null,2))
 console.log(JSON.stringify({directory,structurePassed:true,scenes:validated.scenes?.map(s=>({id:s.id,title:s.title,purpose:s.purpose,beats:s.requiredBeats,completionCriteria:s.completionCriteria,targetDuration:s.targetDuration})).slice(0,4)},null,2))
}finally{await pool.end()}
