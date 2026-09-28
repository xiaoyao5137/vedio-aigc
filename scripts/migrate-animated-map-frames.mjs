import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeAnimatedMapBoundaryFrames } from '../src/animated-map-frames.ts'

const apply = process.argv.includes('--apply')
const outputDirectory = 'logs/animated-map-frames'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

await fs.mkdir(outputDirectory, { recursive: true })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, ['wf-sanguo-history-drama'])).rows[0]
  assert.ok(row, 'Production workflow must exist')
  const before = { ...row, schemaVersion: row.schema_version }
  const candidate = upgradeAnimatedMapBoundaryFrames(before)
  assert.equal(candidate.schemaVersion, 130, 'Expected animated-map boundary-frame migration')
  assert.deepEqual(upgradeAnimatedMapBoundaryFrames(candidate), candidate, 'Migration must be idempotent')
  const first = candidate.nodes.find(node => node.id === 'sanguo-animated-map-first-frame')
  const end = candidate.nodes.find(node => node.id === 'sanguo-end-frame')
  const video = candidate.nodes.find(node => node.id === 'sanguo-video')
  assert.equal(first?.modelId, 'kling-image-3')
  assert.equal(end?.modelId, 'kling-image-3')
  assert.equal(video?.params.find(param => param.englishName === 'endImage')?.value, '${end_frame.url}')
  assert.ok(candidate.edges.some(edge => edge.from === first.id && edge.to === end.id))
  assert.ok(candidate.edges.some(edge => edge.from === end.id && edge.to === video.id))

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
    imageModel: 'kling-image-3', firstFrameNode: first.id, endFrameNode: end.id, videoModelPreserved: video.modelId,
    nodes: candidate.nodes.length, edges: candidate.edges.length, idempotent: true, executionWrites: 0,
    configurationHash: hash([candidate.nodes, candidate.edges, candidate.schemaVersion]) }
  await fs.writeFile(`${outputDirectory}/migration-${apply ? 'applied' : 'preview'}.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
