#!/usr/bin/env node
// Update only the saved writer prompt. Existing executions and paid media stay intact.
import { createHash } from 'node:crypto'
import pg from 'pg'
import { WORKPLACE_IMMERSION_PROMPT } from '../src/story-workplace-immersion.ts'

const workflowId = 'wf-workplace-second-trial-v1'
const sourceId = 'record-onxgw6-review-retry'
const expected = process.argv[2] === '--apply' ? process.argv[3] : undefined
if (process.argv.length !== (expected ? 4 : 2) || (process.argv.length === 4 && !/^[a-f0-9]{32}$/i.test(expected))) {
  throw Error('Usage: node scripts/sync-workplace-immersion-prompt.mjs [--apply EXPECTED_NODES_MD5]')
}
const sha = value => createHash('sha256').update(value).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(expected ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await db.query(`SELECT id,schema_version,nodes,edges,md5(nodes::text) nodes_md5,
    md5(edges::text) edges_md5 FROM workflow_configs WHERE id=$1${expected ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  const source = (await db.query('SELECT md5(result::text) result_md5 FROM execution_records WHERE id=$1', [sourceId])).rows[0]
  if (!workflow || workflow.schema_version !== 11 || !source || (expected && workflow.nodes_md5 !== expected))
    throw Error('workflow, source execution or reviewed nodes MD5 changed')
  if (workflow.nodes.filter(node => node.id === 'node-script').length !== 1) throw Error('writer node is missing or duplicated')
  const writer = workflow.nodes.find(node => node.id === 'node-script')
  if (writer.kind !== 'text' || writer.modelId !== 'codex-local-vision') throw Error('writer contract changed')
  const nodes = workflow.nodes.map(node => node.id === 'node-script'
    ? { ...node, prompt: WORKPLACE_IMMERSION_PROMPT } : node)
  const receipt = { workflowId, sourceId, applied: Boolean(expected), schemaVersion: workflow.schema_version,
    beforeNodesMd5: workflow.nodes_md5, edgesMd5: workflow.edges_md5,
    beforePromptSha256: sha(writer.prompt ?? ''), afterPromptSha256: sha(WORKPLACE_IMMERSION_PROMPT),
    changed: writer.prompt !== WORKPLACE_IMMERSION_PROMPT, sourceResultMd5: source.result_md5 }
  if (expected) {
    const update = await db.query(`UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now()
      WHERE id=$1 AND md5(nodes::text)=$3 RETURNING md5(nodes::text) nodes_md5,
      md5(edges::text) edges_md5`, [workflowId, JSON.stringify(nodes), expected])
    if (update.rowCount !== 1 || update.rows[0].edges_md5 !== workflow.edges_md5) throw Error('workflow CAS or edges changed')
    const after = (await db.query('SELECT md5(result::text) result_md5 FROM execution_records WHERE id=$1', [sourceId])).rows[0]
    if (after?.result_md5 !== source.result_md5) throw Error('source execution changed')
    receipt.afterNodesMd5 = update.rows[0].nodes_md5
  }
  await db.query('COMMIT')
  console.log(JSON.stringify(receipt, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
