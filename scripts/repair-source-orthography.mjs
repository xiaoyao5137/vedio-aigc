import fs from 'node:fs/promises'
import pg from 'pg'
import { upgradeQualityWorkflow } from '../src/quality-node-presets.ts'
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const recordId=process.argv[2]??'record-fxpbwb'
const dir=`logs/source-orthography/${Date.now()}`
const client=await pool.connect()
try {
 await client.query('begin')
 const record=(await client.query('select * from execution_records where id=$1',[recordId])).rows[0]
 if(!record)throw Error('Execution not found')
 const row=(await client.query('select * from workflow_configs where id=$1 for update',[record.workflow_id])).rows[0]
 const workflow=upgradeQualityWorkflow({...row,schemaVersion:row.schema_version})
 const run=record.result.nodeRuns.find(n=>n.node.id==='sanguo-scene-outline-accept')
 const code=workflow.nodes.find(n=>n.id===run.node.id).code
 const replay=async(code)=>{
  const response=await fetch('http://127.0.0.1:5173/api/code-node-run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,params:run.inputs,context:run.inputContext})})
  const body=await response.json();if(!response.ok)throw Error(JSON.stringify(body));return body.body
 }
 const before=await replay(run.node.code)
 const after=await replay(code)
 if(after.routeError)throw Error(after.routeError)
 if(after.passed!==run.inputs.review.passed)throw Error('Review decision was changed')
 await fs.mkdir(dir,{recursive:true})
 await fs.writeFile(`${dir}/workflow-before.json`,JSON.stringify(row,null,2))
 const report={recordId,beforeError:before.routeError,afterError:after.routeError??null,passed:after.passed,issues:after.issues,schemaVersion:workflow.schemaVersion}
 await fs.writeFile(`${dir}/replay.json`,JSON.stringify(report,null,2))
 await client.query('update workflow_configs set nodes=$2::jsonb,schema_version=$3,updated_at=now() where id=$1',[row.id,JSON.stringify(workflow.nodes),workflow.schemaVersion])
 await client.query('commit')
 console.log(JSON.stringify({...report,backupDirectory:dir},null,2))
}catch(error){await client.query('rollback');throw error}finally{client.release();await pool.end()}
