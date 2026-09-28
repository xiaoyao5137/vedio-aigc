import pg from 'pg'
import { upgradeSanguoVideoConcat } from '../src/video-concat-workflow.ts'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'
const pool = new pg.Pool({ connectionString: databaseUrl })
const client = await pool.connect()
try {
  await client.query('begin')
  const workflowRow = (await client.query("select id,name,description,nodes,edges,schema_version as \"schemaVersion\",voice_policy as \"voicePolicy\" from workflow_configs where id='wf-sanguo-history-drama' for update")).rows[0]
  if (!workflowRow) throw Error('workflow missing')
  const upgraded = upgradeSanguoVideoConcat(workflowRow)
  await client.query('update workflow_configs set nodes=$2,edges=$3,schema_version=$4,updated_at=now() where id=$1',
    [workflowRow.id, JSON.stringify(upgraded.nodes), JSON.stringify(upgraded.edges), upgraded.schemaVersion])

  const stableKey = 'voice:张角'
  let stable = (await client.query('select * from voice_characters where workflow_id=$1 and continuity_key=$2', [workflowRow.id, stableKey])).rows[0]
  if (!stable) {
    const source = (await client.query(`select c.* from voice_characters c
      where c.workflow_id=$1 and c.continuity_key='张角-eastern-han-v14' for update`, [workflowRow.id])).rows[0]
    if (!source) throw Error('canonical source voice v14 missing')
    // Re-key the already-used v14 identity instead of cloning its provider
    // voice. All historic manifests keep the same character id and binding.
    stable = (await client.query('update voice_characters set continuity_key=$2 where id=$1 returning *', [source.id, stableKey])).rows[0]
  }
  await client.query('commit')
  console.log(JSON.stringify({ workflowSchemaVersion: upgraded.schemaVersion, canonicalVoice: { id: stable.id, continuityKey: stable.continuity_key }, preservedHistoricalVoices: true }))
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release()
  await pool.end()
}
