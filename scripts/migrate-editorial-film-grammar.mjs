import fs from 'node:fs/promises'
import pg from 'pg'
import { upgradeEditorialFilmGrammar } from '../src/quality-node-presets.ts'

const apply = process.argv.includes('--apply')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
try {
  await client.query(apply ? 'begin' : 'begin read only')
  const row = (await client.query(`select * from workflow_configs where id='wf-sanguo-history-drama'${apply ? ' for update' : ''}`)).rows[0]
  if (!row) throw Error('Missing workflow wf-sanguo-history-drama')
  const before = { ...row, schemaVersion: row.schema_version }
  const after = upgradeEditorialFilmGrammar(before)
  const changedNodes = after.nodes.filter((node, index) => JSON.stringify(node) !== JSON.stringify(before.nodes[index])).map(node => node.id)
  if (apply && after !== before) {
    await fs.mkdir('logs/editorial-film-grammar', { recursive: true })
    const backup = `logs/editorial-film-grammar/workflow-backup-schema${row.schema_version}-${Date.now()}.json`
    await fs.writeFile(backup, JSON.stringify(row, null, 2))
    await client.query('update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,schema_version=$4,updated_at=now() where id=$1',
      [row.id, JSON.stringify(after.nodes), JSON.stringify(after.edges), after.schemaVersion])
    const persisted = (await client.query('select schema_version,nodes,edges from workflow_configs where id=$1', [row.id])).rows[0]
    if (persisted.schema_version !== after.schemaVersion || JSON.stringify(persisted.nodes) !== JSON.stringify(after.nodes)
      || JSON.stringify(persisted.edges) !== JSON.stringify(after.edges)) throw Error('Persisted workflow differs from schema120 candidate')
    console.log(JSON.stringify({ apply, backup, schemaBefore: row.schema_version, schemaAfter: after.schemaVersion, changedNodes,
      nodeCount: after.nodes.length, edgeCount: after.edges.length }, null, 2))
  } else {
    console.log(JSON.stringify({ apply, schemaBefore: row.schema_version, schemaAfter: after.schemaVersion, changedNodes,
      nodeCount: after.nodes.length, edgeCount: after.edges.length }, null, 2))
  }
  await client.query(apply ? 'commit' : 'rollback')
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release()
  await pool.end()
}
