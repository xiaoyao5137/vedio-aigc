// Preview by default; --apply publishes the managed historical-geography map presentation.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeSandTableWorkflow } from '../src/sand-table-workflow.ts'

const apply=process.argv.includes('--apply'), workflowId='wf-sanguo-history-drama'
const outputIndex=process.argv.indexOf('--out')
const directory=path.resolve(outputIndex>=0?process.argv[outputIndex+1]:'logs/historical-map-20260928/migration')
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const client=new pg.Client({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const history=async()=>(await client.query('SELECT id,xmin::text AS revision,ctid::text AS location FROM execution_records WHERE workflow_id=$1 ORDER BY id',[workflowId])).rows
await client.connect()
try {
  await client.query(apply?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const before=(await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply?' FOR UPDATE':''}`,[workflowId])).rows[0]
  assert.ok(before?.schema_version>=147,'Production workflow must complete schema147 first')
  const after=upgradeSandTableWorkflow({...before,schemaVersion:before.schema_version})
  assert.deepEqual(upgradeSandTableWorkflow(after),after)
  assert.deepEqual(after.edges,before.edges)
  assert.equal(after.nodes.length,before.nodes.length)
  for(const [index,node] of after.nodes.entries()) {
    const old=before.nodes[index]
    const keys=['sanguo-scene-outline','sanguo-scene-outline-review','sanguo-shot-script','sanguo-shot-script-review','sanguo-animated-map-first-frame','sanguo-end-frame'].includes(node.id)?['prompt']
      :node.id==='sanguo-first-frame-branch'?['code']:[]
    const stable=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)))
    assert.deepEqual(stable(node),stable(old),`Unexpected configuration change: ${node.id}`)
  }
  const historyBefore=await history(), changed=hash([before.nodes,before.schema_version])!==hash([after.nodes,after.schemaVersion])
  await fs.mkdir(directory,{recursive:true})
  let backup
  if(apply&&changed) {
    backup=path.join(directory,`workflow-before-schema${before.schema_version}-${Date.now()}.json`)
    await fs.writeFile(backup,JSON.stringify(before,null,2),{flag:'wx',mode:0o600})
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,schema_version=$3,updated_at=now() WHERE id=$1',[workflowId,JSON.stringify(after.nodes),after.schemaVersion])
  }
  const saved=(await client.query('SELECT * FROM workflow_configs WHERE id=$1',[workflowId])).rows[0]
  const stable=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['nodes','schema_version','updated_at'].includes(key)))
  assert.deepEqual(stable(saved),stable(before))
  assert.deepEqual(saved.nodes,apply?after.nodes:before.nodes)
  assert.deepEqual(await history(),historyBefore)
  await client.query(apply?'COMMIT':'ROLLBACK')
  const proof={at:new Date().toISOString(),workflowId,name:before.name,applied:apply,changed,backup,
    schemaBefore:before.schema_version,schemaAfter:after.schemaVersion,persistedSchema:saved.schema_version,
    changedNodes:after.nodes.filter((n,i)=>JSON.stringify(n)!==JSON.stringify(before.nodes[i])).map(n=>n.id),
    nodeCount:after.nodes.length,edgeCount:after.edges.length,graphAndModelsPreserved:true,executionWrites:0,
    preservedExecutionRows:historyBefore.length,historyHash:hash(historyBefore),idempotent:true}
  await fs.writeFile(path.join(directory,`migration-${apply?'applied':'preview'}.json`),JSON.stringify(proof,null,2))
  console.log(JSON.stringify(proof,null,2))
}catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
