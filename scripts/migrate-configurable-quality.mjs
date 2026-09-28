import fs from 'node:fs/promises'
import pg from 'pg'
import { upgradeQualityWorkflow } from '../src/quality-node-presets.ts'
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const client=await pool.connect()
try {
 await client.query('begin')
 const row=(await client.query("select * from workflow_configs where id='wf-sanguo-history-drama' for update")).rows[0]
 if(!row)throw Error('Missing workflow')
 const workflow={...row,schemaVersion:row.schema_version}
 const upgraded=upgradeQualityWorkflow(workflow)
 if(upgraded!==workflow){
  await fs.mkdir('logs/quality-regression/generic-qa',{recursive:true})
  await fs.writeFile(`logs/quality-regression/generic-qa/workflow-backup-${Date.now()}.json`,JSON.stringify(row,null,2))
  await client.query('update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,schema_version=$4,updated_at=now() where id=$1',[row.id,JSON.stringify(upgraded.nodes),JSON.stringify(upgraded.edges),upgraded.schemaVersion])
 }
 await client.query('commit')
 console.log(JSON.stringify({schemaVersion:upgraded.schemaVersion,nodes:upgraded.nodes.map(n=>({id:n.id,kind:n.kind,resultVar:n.resultVar,acceptance:n.acceptance})),migrated:upgraded!==workflow},null,2))
} catch(e){await client.query('rollback');throw e}finally{client.release();await pool.end()}
