// A reversible route for a preview through an already configured text model.
// Model credentials are not changed or written to this proof. Restore patches
// only the selected model IDs, retaining any unrelated workflow edits.
import fs from 'node:fs/promises'
import pg from 'pg'
import { isDeepStrictEqual } from 'node:util'

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]}
const proofPath=option('--proof'),restore=args.includes('--restore'),apply=args.includes('--apply')
const requestedEffort=option('--reasoning-effort')
if(!proofPath)throw Error('--proof is required')
if(requestedEffort&&!['minimal','low','medium','high','xhigh','max','ultra'].includes(requestedEffort))throw Error('Invalid reasoning effort')
if(apply&&!restore){try{await fs.access(proofPath);throw Error('Route proof already exists; refusing to overwrite restore data')}catch(error){if(error.code!=='ENOENT')throw error}}
const client=new pg.Client({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
await client.connect()
try{
  await client.query(apply?'BEGIN':'BEGIN READ ONLY')
  const saved=restore?JSON.parse(await fs.readFile(proofPath,'utf8')):undefined
  const workflowId=saved?.workflowId??option('--workflow'),modelId=saved?.modelId??option('--model')
  if(!workflowId||!modelId)throw Error('--workflow and --model are required')
  const workflow=(await client.query(`SELECT id,nodes,schema_version,md5(nodes::text) AS nodes_hash FROM workflow_configs WHERE id=$1${apply?' FOR UPDATE':''}`,[workflowId])).rows[0]
  if(!workflow)throw Error('Workflow is missing')
  const model=(await client.query('SELECT id,capability,provider FROM model_configs WHERE id=$1',[modelId])).rows[0]
  if(model?.capability!=='text'||model.provider==='Local')throw Error('A configured actual text model is required')
  const ids=restore?saved.changes.map(row=>row.id):(option('--nodes')??'').split(',').filter(Boolean)
  if(!ids.length||new Set(ids).size!==ids.length)throw Error('Select unique explicit text node IDs')
  const changes=ids.map(id=>{
    const node=workflow.nodes.find(row=>row.id===id)
    if(node?.kind!=='text')throw Error('Selected node is missing or is not text: '+id)
    const effortParams=(node.params??[]).filter(p=>(p.englishName||p.name)==='reasoningEffort')
    if(effortParams.length>1)throw Error('Duplicate effort parameter: '+id)
    if(restore){
      const original=saved.changes.find(row=>row.id===id)
      if(node.modelId!==modelId)throw Error('Selected model changed concurrently; refusing restore: '+id)
      if(original.effort&&!isDeepStrictEqual(effortParams[0],original.effort.after))throw Error('Selected effort changed concurrently; refusing restore: '+id)
      return{id,from:node.modelId,to:original.from,...(original.effort?{effort:{before:original.effort.after,after:original.effort.before}}:{})}
    }
    return{id,from:node.modelId,to:modelId,...(requestedEffort?{effort:{before:effortParams[0]??null,after:{...effortParams[0],id:effortParams[0]?.id??'preview-text-reasoning-effort',name:effortParams[0]?.name??'本次预览文本推理强度',englishName:'reasoningEffort',type:'text',required:false,value:requestedEffort}}}:{})}
  }).filter(row=>row.from!==row.to||row.effort&&!isDeepStrictEqual(row.effort.before,row.effort.after))
  const next=workflow.nodes.map(node=>{
    const change=changes.find(row=>row.id===node.id)
    if(!change)return node
    const params=change.effort?[...(node.params??[]).filter(p=>(p.englishName||p.name)!=='reasoningEffort'),...(change.effort.after?[change.effort.after]:[])]:node.params
    return{...node,modelId:change.to,...(change.effort?{params}:{})}
  })
  const planned={at:new Date().toISOString(),workflowId,modelId,modelProvider:model.provider,schema:workflow.schema_version,changes,applied:false,restored:restore,beforeHash:workflow.nodes_hash,executionWrites:0,credentialWrites:0}
  if(apply&&!restore)await fs.writeFile(proofPath,JSON.stringify(planned,null,2),{flag:'wx',mode:0o600})
  if(apply&&changes.length)await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now() WHERE id=$1',[workflowId,JSON.stringify(next)])
  const after=(await client.query('SELECT md5(nodes::text) AS nodes_hash FROM workflow_configs WHERE id=$1',[workflowId])).rows[0]
  await client.query('COMMIT')
  const proof={at:new Date().toISOString(),workflowId,modelId,modelProvider:model.provider,schema:workflow.schema_version,changes,applied:apply,restored:restore,beforeHash:workflow.nodes_hash,afterHash:after.nodes_hash,executionWrites:0,credentialWrites:0}
  if(apply)await fs.writeFile(restore?proofPath+'.restored.json':proofPath,JSON.stringify(proof,null,2),{mode:0o600})
  console.log(JSON.stringify(proof,null,2))
}catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
