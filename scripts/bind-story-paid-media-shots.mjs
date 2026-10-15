#!/usr/bin/env node
// Bind wf-story's two paid media nodes to the exact reviewed loop shot.
// Dry run by default; never edits source executions or calls providers.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const binding = { id: 'story-reviewed-shot-binding', name: '已审分镜绑定',
  englishName: 'storyShot', type: 'json', required: true, value: '${shot}' }
const targetIds = ['node-image', 'node-video']
const options = { apply: false }
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--apply' && !options.apply) { options.apply = true; continue }
  const key = { '--expected-nodes-md5': 'expectedMd5', '--source-record': 'sourceId', '--proof': 'proofPath' }[arg]
  if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw Error(`Invalid argument: ${arg}`)
  }
  options[key] = args[++index]
}
if (options.apply && !/^[a-f0-9]{32}$/i.test(options.expectedMd5 ?? '')) {
  throw Error('--apply requires --expected-nodes-md5 from a reviewed dry run')
}
if (!/^record-[\w-]+$/.test(options.sourceId ?? '')) throw Error('--source-record is required')
if (options.proofPath && !options.apply) throw Error('--proof is valid only with --apply')

const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let proof
try {
  await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await db.query(`SELECT id,schema_version,nodes,md5(nodes::text) AS nodes_md5,
    md5(edges::text) AS edges_md5,xmin::text AS revision
    FROM workflow_configs WHERE id='wf-story'${options.apply ? ' FOR UPDATE' : ''}`)).rows[0]
  if (!workflow || workflow.schema_version !== 5 || !Array.isArray(workflow.nodes)) throw Error('Expected wf-story schema 5')
  if (options.expectedMd5 && options.expectedMd5 !== workflow.nodes_md5) throw Error('wf-story nodes changed since preview')
  const sourceBefore = (await db.query('SELECT md5(to_jsonb(er)::text) AS fingerprint FROM execution_records er WHERE id=$1',
    [options.sourceId])).rows[0]?.fingerprint
  if (!sourceBefore) throw Error(`Source execution ${options.sourceId} is missing`)
  for (const id of targetIds) {
    if (workflow.nodes.filter(node => node.id === id).length !== 1) throw Error(`${id} is missing or duplicated`)
  }
  const changes = []
  const nodes = workflow.nodes.map(node => {
    if (!targetIds.includes(node.id)) return node
    if (!Array.isArray(node.params)) throw Error(`${node.id} params are invalid`)
    const existing = node.params.filter(param => (param.englishName || param.name) === 'storyShot')
    if (existing.length > 1 || existing.length === 1
      && (existing[0].type !== binding.type || existing[0].required !== true
        || existing[0].value !== binding.value)) {
      throw Error(`${node.id} has a conflicting storyShot binding; manual review required`)
    }
    changes.push({ nodeId: node.id, added: existing.length === 0 })
    return existing.length ? node : { ...node, params: [...node.params, { ...binding }] }
  })
  proof = { version: 'story-paid-shot-binding-v1', applied: options.apply, workflowId: workflow.id,
    schemaVersion: workflow.schema_version, beforeNodesMd5: workflow.nodes_md5,
    edgesMd5: workflow.edges_md5, changes,
    sourceRecordId: options.sourceId, sourceRecordFingerprintBefore: sourceBefore,
    executionRecordWrites: 0, providerCalls: 0 }
  if (options.apply) {
    const saved = await db.query(`UPDATE workflow_configs SET nodes=$1::jsonb,updated_at=NOW()
      WHERE id='wf-story' AND schema_version=5 AND md5(nodes::text)=$2
        AND md5(edges::text)=$3 AND xmin::text=$4
      RETURNING md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5`,
    [JSON.stringify(nodes), workflow.nodes_md5, workflow.edges_md5, workflow.revision])
    if (saved.rowCount !== 1 || saved.rows[0].edges_md5 !== workflow.edges_md5) throw Error('Workflow CAS or edge check failed')
    proof.afterNodesMd5 = saved.rows[0].nodes_md5
    const sourceAfter = (await db.query('SELECT md5(to_jsonb(er)::text) AS fingerprint FROM execution_records er WHERE id=$1',
      [options.sourceId])).rows[0]?.fingerprint
    if (sourceAfter !== sourceBefore) throw Error('Source execution changed during binding migration')
    proof.sourceRecordFingerprintAfter = sourceAfter
  }
  await db.query('COMMIT')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
if (options.proofPath) {
  const destination = path.resolve(options.proofPath)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  proof.proofPath = destination
}
console.log(JSON.stringify(proof, null, 2))
