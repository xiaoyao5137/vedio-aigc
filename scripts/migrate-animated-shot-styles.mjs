import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeAnimatedShotStyleContract } from '../src/quality-node-presets.ts'

const apply = process.argv.includes('--apply')
const repairArgument = process.argv.find(value => value.startsWith('--repair-from='))
const repairPath = repairArgument?.slice('--repair-from='.length)
const outputDirectory = 'logs/animated-shot-styles'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

await fs.mkdir(outputDirectory, { recursive: true })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, ['wf-sanguo-history-drama'])).rows[0]
  assert.ok(row, 'Production workflow must exist')
  const repairSnapshot = repairPath ? JSON.parse(await fs.readFile(repairPath, 'utf8')) : null
  if (repairSnapshot) {
    assert.equal(repairSnapshot.id, row.id, 'Repair snapshot must belong to the production workflow')
    assert.equal(repairSnapshot.schema_version, 130, 'Repair snapshot must be the immediately preceding schema 130')
  }
  const source = repairSnapshot ?? row
  const before = { ...source, schemaVersion: source.schema_version }
  const candidate = upgradeAnimatedShotStyleContract(before)
  assert.equal(candidate.schemaVersion, 131, 'Expected generic animated-shot style migration')
  assert.deepEqual(upgradeAnimatedShotStyleContract(candidate), candidate, 'Migration must be idempotent')
  const first = candidate.nodes.find(node => node.id === 'sanguo-animated-map-first-frame')
  const end = candidate.nodes.find(node => node.id === 'sanguo-end-frame')
  const video = candidate.nodes.find(node => node.id === 'sanguo-video')
  assert.deepEqual(first?.runIf, { path: 'first_frame_branch.shouldGenerateAnimatedFirstFrame', equals: true })
  assert.deepEqual(end?.runIf, { path: 'first_frame_branch.shouldGenerateAnimatedEndFrame', equals: true })
  assert.equal(first?.modelId, 'kling-image-3')
  assert.equal(end?.modelId, 'kling-image-3')
  assert.equal(video?.params.find(param => param.englishName === 'animationStyle')?.value, '${shot_script.animationStyle}')

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
    schemaBefore: row.schema_version, migrationBaseSchema: source.schema_version, schemaAfter: apply ? stored.schema_version : candidate.schemaVersion,
    imageModel: 'kling-image-3', videoModelPreserved: video.modelId, idempotent: true, executionWrites: 0,
    configurationHash: hash([candidate.nodes, candidate.edges, candidate.schemaVersion]) }
  await fs.writeFile(`${outputDirectory}/migration-${apply ? 'applied' : 'preview'}.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
