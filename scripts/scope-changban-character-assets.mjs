// A one-time, guarded provenance correction for archived Changban sheets.
// Preview by default; --apply adds only metadata.episodeScope={episodes:[518]}.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'

const apply = process.argv.includes('--apply')
const workflowId = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/portrait-upgrade-20260928')
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const client = new pg.Client({connectionString:process.env.DATABASE_URL??'postgres://postgres:postgres@localhost:5432/video_aigc'})
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const rows = (await client.query(`SELECT id,workflow_id,character_name,asset_type,uri,prompt,version,metadata,xmin::text AS row_version
    FROM character_assets WHERE workflow_id=$1 AND asset_type='three-view' AND character_name IN ('张飞','刘备')
    ORDER BY id${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows
  const scoped = rows.filter(row => {
    const visual = row.metadata?.visualContext
    return ['张飞','刘备'].includes(row.character_name)
      && typeof visual?.age?.asOf === 'string' && /当阳长坂/.test(visual.age.asOf)
      && typeof visual?.look?.key === 'string' && /changban/.test(visual.look.key)
  })
  assert.equal(scoped.length, 5, 'Expected exactly five archived Changban age-and-look sheets')
  assert.ok(scoped.every(row => row.metadata?.episodeScope === undefined), 'Do not overwrite an existing scope')
  const before = rows.map(({id,row_version,metadata}) => ({id,row_version,metadata}))
  if (apply) {
    await fs.writeFile(path.join(directory,'character-assets-before-episode-scope.json'), JSON.stringify(rows,null,2), {flag:'wx',mode:0o600})
    for (const row of scoped) {
      const next={...row.metadata,episodeScope:{episodes:[518]}}
      const result=await client.query('UPDATE character_assets SET metadata=$2::jsonb,updated_at=now() WHERE id=$1 AND xmin::text=$3',
        [row.id,JSON.stringify(next),row.row_version])
      assert.equal(result.rowCount,1,`Asset ${row.id} changed during scope update`)
    }
  }
  const after = (await client.query('SELECT id,metadata,xmin::text AS row_version FROM character_assets WHERE workflow_id=$1 AND asset_type=$2 AND character_name IN ($3,$4) ORDER BY id',
    [workflowId,'three-view','张飞','刘备'])).rows
  for (const item of after) {
    const original=before.find(row=>row.id===item.id)
    assert.ok(original)
    const expected=scoped.some(row=>row.id===item.id)&&apply
      ? {...original.metadata,episodeScope:{episodes:[518]}} : original.metadata
    assert.deepEqual(item.metadata,expected,`Unexpected asset metadata change ${item.id}`)
  }
  const proof={at:new Date().toISOString(),applied:apply,workflowId,episode:518,assetIds:scoped.map(row=>row.id),
    beforeHash:digest(before),afterHash:digest(after.map(({id,metadata})=>({id,metadata}))),
    changedField:'metadata.episodeScope',otherAssetsPreserved:true,workflowWrites:0,executionWrites:0,mediaWrites:0,
    backupFile:apply?path.join(directory,'character-assets-before-episode-scope.json'):null}
  await client.query(apply?'COMMIT':'ROLLBACK')
  if(apply)await fs.writeFile(path.join(directory,'character-assets-episode-scope.json'),JSON.stringify(proof,null,2),{flag:'wx'})
  console.log(JSON.stringify(proof,null,2))
}catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
