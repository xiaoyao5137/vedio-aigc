import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeIllustrationLayerLayout } from '../src/quality-node-presets.ts'

const apply = process.argv.includes('--apply')
const outputDirectory = 'logs/illustration-layer-layout'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

await fs.mkdir(outputDirectory, { recursive: true })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, ['wf-sanguo-history-drama'])).rows[0]
  assert.ok(row, 'Production workflow must exist')
  const before = { ...row, schemaVersion: row.schema_version }
  const candidate = upgradeIllustrationLayerLayout(before)
  assert.equal(candidate.schemaVersion, 132, 'Expected illustration layer-layout migration')
  assert.deepEqual(upgradeIllustrationLayerLayout(candidate), candidate, 'Migration must be idempotent')
  const video = candidate.nodes.find(node => node.id === 'sanguo-video')
  const writer = candidate.nodes.find(node => node.id === 'sanguo-shot-script')
  assert.equal(video?.params.find(param => param.englishName === 'illustrationLayers')?.value, '${shot_script.illustrationLayers}')
  assert.match(String(writer?.prompt), /illustrationLayers/)

  const executionSnapshot = async () => (await client.query(
    'SELECT count(*)::int AS count,max(created_at) AS newest FROM execution_records WHERE workflow_id=$1', [row.id])).rows[0]
  const executionsBefore = await executionSnapshot()
  const changed = hash([before.nodes, before.edges, before.schemaVersion]) !== hash([candidate.nodes, candidate.edges, candidate.schemaVersion])
  const stamp = new Date().toISOString().replaceAll(':', '-')
  if (apply && changed) {
    await fs.writeFile(`${outputDirectory}/workflow-rollback-${stamp}.json`, JSON.stringify(row, null, 2), { flag: 'wx' })
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,edges=$3::jsonb,schema_version=$4,updated_at=now() WHERE id=$1',
      [row.id, JSON.stringify(candidate.nodes), JSON.stringify(candidate.edges), candidate.schemaVersion])
  }
  const stored = (await client.query('SELECT nodes,edges,schema_version FROM workflow_configs WHERE id=$1', [row.id])).rows[0]
  if (apply) assert.deepEqual([stored.nodes, stored.edges, stored.schema_version], [candidate.nodes, candidate.edges, candidate.schemaVersion])
  const executionsAfter = await executionSnapshot()
  assert.deepEqual(executionsAfter, executionsBefore, 'Migration must not add or remove execution history')
  await client.query('COMMIT')

  const proof = { at: new Date().toISOString(), applied: apply, changed, workflowId: row.id,
    schemaBefore: row.schema_version, schemaAfter: apply ? stored.schema_version : candidate.schemaVersion,
    videoModelPreserved: video.modelId, idempotent: true, executionWrites: 0,
    configurationHash: hash([candidate.nodes, candidate.edges, candidate.schemaVersion]) }
  await fs.writeFile(`${outputDirectory}/migration-${apply ? 'applied' : 'preview'}.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
