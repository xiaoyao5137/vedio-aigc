#!/usr/bin/env node
// Sync the three managed wf-story prompts without changing inputs, models,
// references, links, or saved executions. Dry run unless --apply is supplied.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { STORY_SCRIPT_PROMPT } from '../src/story-script-prompt.ts'
import { STORY_SHOT_IMAGE_PROMPT, STORY_SHOT_VIDEO_PROMPT } from '../src/story-video-prompt.ts'

const prompts = {
  'node-script': STORY_SCRIPT_PROMPT,
  'node-image': STORY_SHOT_IMAGE_PROMPT,
  'node-video': STORY_SHOT_VIDEO_PROMPT,
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const args = process.argv.slice(2)
const options = { apply: false }
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
if (options.sourceId && !/^record-[\w-]+$/.test(options.sourceId)) throw Error('Invalid --source-record')
if (options.proofPath && !options.apply) throw Error('--proof is valid only with --apply')

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let proof
try {
  await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await db.query(`SELECT id,schema_version,nodes,md5(nodes::text) AS nodes_md5,
    md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'${options.apply ? ' FOR UPDATE' : ''}`)).rows[0]
  if (!workflow || workflow.schema_version !== 7 || !Array.isArray(workflow.nodes)) throw Error('Expected wf-story schema 7')
  if (options.expectedMd5 && options.expectedMd5 !== workflow.nodes_md5) throw Error('wf-story nodes changed since preview')
  if (Object.keys(prompts).some(id => workflow.nodes.filter(node => node.id === id).length !== 1)) {
    throw Error('Managed story node identity is missing or duplicated')
  }
  const sourceBefore = options.sourceId
    ? (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [options.sourceId])).rows[0]?.md5
    : undefined
  if (options.sourceId && !sourceBefore) throw Error('Source execution is missing')
  const changes = Object.entries(prompts).map(([id, prompt]) => {
    const node = workflow.nodes.find(candidate => candidate.id === id)
    return { nodeId: id, beforeSha256: sha256(node.prompt ?? ''), afterSha256: sha256(prompt), changed: node.prompt !== prompt }
  })
  const nodes = workflow.nodes.map(node => Object.hasOwn(prompts, node.id) ? { ...node, prompt: prompts[node.id] } : node)
  proof = {
    version: 'managed-story-prompt-sync-v1', applied: options.apply,
    workflowId: workflow.id, schemaVersion: workflow.schema_version,
    beforeNodesMd5: workflow.nodes_md5, edgesMd5: workflow.edges_md5,
    changes, sourceRecordId: options.sourceId ?? null, sourceResultMd5Before: sourceBefore ?? null,
  }
  if (options.apply) {
    const result = await db.query(`UPDATE workflow_configs SET nodes=$1::jsonb,updated_at=NOW()
      WHERE id='wf-story' AND md5(nodes::text)=$2 RETURNING md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5`, [JSON.stringify(nodes), workflow.nodes_md5])
    if (result.rowCount !== 1 || result.rows[0].edges_md5 !== workflow.edges_md5) throw Error('Workflow CAS or edge check failed')
    proof.afterNodesMd5 = result.rows[0].nodes_md5
    const sourceAfter = options.sourceId
      ? (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [options.sourceId])).rows[0]?.md5
      : undefined
    if (sourceAfter !== sourceBefore) throw Error('Source execution changed during prompt sync')
    proof.sourceResultMd5After = sourceAfter ?? null
  }
  await db.query('COMMIT')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  await db.end()
}
if (options.proofPath) {
  const destination = path.resolve(options.proofPath)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  proof.proofPath = destination
}
console.log(JSON.stringify(proof, null, 2))
