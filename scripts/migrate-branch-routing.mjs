import fs from 'node:fs/promises'
import pg from 'pg'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'
import { branchConfigurationErrors } from '../src/workflow-branch.ts'
const id=process.argv[2]??'wf-sanguo-history-drama'
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
const client=await pool.connect()
try {
 await client.query('begin')
 const row=(await client.query('select * from workflow_configs where id=$1 for update',[id])).rows[0]
 if(!row)throw Error('Workflow not found: '+id)
 const workflow={...row,schemaVersion:row.schema_version}
 const updated=migrateBranchWorkflow(workflow)
 const errors=branchConfigurationErrors(updated)
 if(errors.length)throw Error(errors.join('\n'))
 if(updated!==workflow){
  await fs.mkdir('logs/branch-routing',{recursive:true})
  await fs.writeFile(`logs/branch-routing/${id}-${Date.now()}.json`,JSON.stringify(row,null,2))
  await client.query('update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,updated_at=now() where id=$1',[id,JSON.stringify(updated.nodes),JSON.stringify(updated.edges)])
 }
 await client.query('commit')
 console.log(JSON.stringify({id,migrated:updated!==workflow,nodes:updated.nodes.length,branches:updated.nodes.filter(n=>n.kind==='branch').length,edges:updated.edges.length}))
}catch(error){await client.query('rollback');throw error}finally{client.release();await pool.end()}
