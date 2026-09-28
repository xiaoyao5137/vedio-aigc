import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeNeutralPortraitAndIllustrationBackground, NEUTRAL_THREE_VIEW_GENERATION_TEMPLATE } from '../src/quality-node-presets.ts'

const apply = process.argv.includes('--apply')
const workflowId = 'wf-sanguo-history-drama'
const sourceRecordId = 'record-x7n2qf'
const outputDirectory = 'logs/neutral-portrait-background'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

await fs.mkdir(outputDirectory, { recursive: true })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const row = (await client.query(`SELECT * FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  assert.ok(row, 'Production workflow must exist')
  const before = { ...row, schemaVersion: row.schema_version }
  const candidate = upgradeNeutralPortraitAndIllustrationBackground(before)
  assert.equal(candidate.schemaVersion, 135, 'Expected neutral portrait/background migration')
  assert.deepEqual(upgradeNeutralPortraitAndIllustrationBackground(candidate), candidate, 'Migration must be idempotent')

  const lookup = candidate.nodes.find(node => node.id === 'sanguo-character-lookup')
  const portrait = candidate.nodes.find(node => node.id === 'sanguo-character-image')
  const review = candidate.nodes.find(node => node.id === 'sanguo-character-review')
  const branch = candidate.nodes.find(node => node.id === 'sanguo-first-frame-branch')
  const firstFrame = candidate.nodes.find(node => node.id === 'sanguo-animated-map-first-frame')
  assert.match(String(lookup?.code), /action-only clause/)
  assert.match(String(branch?.code), /backgroundOnlyPrompt/)
  assert.match(String(branch?.code), /frameReferenceImages/)
  assert.match(String(firstFrame?.prompt), /first_frame_branch\.framePrompt/)
  assert.equal(firstFrame?.params.find(param => param.englishName === 'referenceImages')?.value, '${first_frame_branch.frameReferenceImages}')
  assert.equal(portrait?.params.find(param => param.englishName === 'generationPromptTemplate')?.value, NEUTRAL_THREE_VIEW_GENERATION_TEMPLATE)
  assert.match(String(review?.prompt), /手抬到胸口以上/)

  const executionSnapshot = async () => (await client.query(
    'SELECT count(*)::int AS count,max(created_at) AS newest FROM execution_records WHERE workflow_id=$1', [workflowId])).rows[0]
  const recordSnapshot = async () => {
    const record = (await client.query('SELECT id,workflow_id,mode,title,result,created_at,succeeded_count,failed_count,total_count FROM execution_records WHERE id=$1', [sourceRecordId])).rows[0]
    assert.ok(record, `Source execution ${sourceRecordId} must remain available`)
    return { id: record.id, workflowId: record.workflow_id, mode: record.mode, title: record.title, createdAt: record.created_at,
      succeededCount: record.succeeded_count, failedCount: record.failed_count, totalCount: record.total_count, resultHash: hash(record.result) }
  }
  const executionsBefore = await executionSnapshot()
  const recordBefore = await recordSnapshot()
  const changed = hash([before.nodes, before.edges, before.schemaVersion]) !== hash([candidate.nodes, candidate.edges, candidate.schemaVersion])
  const stamp = new Date().toISOString().replaceAll(':', '-')
  if (apply && changed) {
    await fs.writeFile(`${outputDirectory}/workflow-rollback-${stamp}.json`, JSON.stringify(row, null, 2), { flag: 'wx' })
    await client.query('UPDATE workflow_configs SET nodes=$2::jsonb,edges=$3::jsonb,schema_version=$4,updated_at=now() WHERE id=$1',
      [workflowId, JSON.stringify(candidate.nodes), JSON.stringify(candidate.edges), candidate.schemaVersion])
  }
  const stored = (await client.query('SELECT nodes,edges,schema_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  if (apply) assert.deepEqual([stored.nodes, stored.edges, stored.schema_version], [candidate.nodes, candidate.edges, candidate.schemaVersion])
  const executionsAfter = await executionSnapshot()
  const recordAfter = await recordSnapshot()
  assert.deepEqual(executionsAfter, executionsBefore, 'Migration must not add or remove execution history')
  assert.deepEqual(recordAfter, recordBefore, 'Migration must not mutate the source execution')
  await client.query('COMMIT')

  const proof = {
    at: new Date().toISOString(), applied: apply, changed, workflowId, sourceRecordId,
    schemaBefore: row.schema_version, schemaAfter: apply ? stored.schema_version : candidate.schemaVersion,
    firstFrameModelPreserved: firstFrame?.modelId, identityPoseSanitized: true,
    portraitNeutralPoseRequired: true, characterIllustrationBackgroundOnly: true,
    originalRecordPreserved: true, executionWrites: 0, idempotent: true,
    sourceRecordHash: recordBefore.resultHash,
    configurationHash: hash([candidate.nodes, candidate.edges, candidate.schemaVersion]),
  }
  await fs.writeFile(`${outputDirectory}/migration-${apply ? 'applied' : 'preview'}.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
