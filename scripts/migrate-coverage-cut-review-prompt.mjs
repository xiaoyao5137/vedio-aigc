#!/usr/bin/env node
// Preview by default; --apply CAS-updates only the managed schema-156 review
// prompt. All images, model ledgers, execution records and paid media remain.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { COVERAGE_CUT_FRAME_REVIEW_PROMPT } from '../src/coverage-cut-frame-gate.ts'

const apply = process.argv.includes('--apply')
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] ?? '' }
const directory = path.resolve(option('--out') || 'logs/dramatic-expression/live-20260928/coverage-cut-review-prompt-cas-v2')
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex')
const workflowId = 'wf-sanguo-history-drama'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const histories = async () => (await client.query(`select id,xmin::text as revision,ctid::text as location,
  pg_column_size(result) as stored_bytes from execution_records where workflow_id=$1 order by id`, [workflowId])).rows
const imageAndReviewLedgers = async () => (await client.query(`select id,status,task_id,request_data->>'requestKey' as request_key,
  request_data->>'fingerprint' as fingerprint,xmin::text as revision,ctid::text as location
  from model_execution_records where task_id='933499044201512998'
    or id='model-run-mul4ddgf-bkqb7rx' order by id`)).rows
await client.connect()
let committed = false
try {
  await client.query(apply ? 'begin isolation level repeatable read' : 'begin isolation level repeatable read read only')
  const current = (await client.query(`select id,nodes,edges,schema_version,updated_at,xmin::text as row_revision
    from workflow_configs where id=$1${apply ? ' for update' : ''}`, [workflowId])).rows[0]
  assert.equal(current?.schema_version, 156)
  const indexes = current.nodes.flatMap((node, index) => node.id === 'sanguo-coverage-review' ? [index] : [])
  assert.equal(indexes.length, 1)
  const index = indexes[0], old = current.nodes[index]
  assert.equal(old.kind, 'text')
  assert.ok(old.prompt.includes('任何裁切导致无法核实的人物或束缚均不能判通过')
    || old.prompt === COVERAGE_CUT_FRAME_REVIEW_PROMPT, 'Review prompt was manually edited; stop')
  const changed = old.prompt !== COVERAGE_CUT_FRAME_REVIEW_PROMPT
  const beforeSha256 = sha([current.schema_version, current.nodes, current.edges, current.updated_at, current.row_revision])
  const executionBefore = await histories(), ledgersBefore = await imageAndReviewLedgers()
  assert.equal(ledgersBefore.length, 2)
  const nextNodes = current.nodes.map((node, at) => at === index
    ? { ...node, prompt: COVERAGE_CUT_FRAME_REVIEW_PROMPT } : node)
  assert.equal(nextNodes.length, current.nodes.length)
  assert.equal(nextNodes.every((node, at) => at === index || JSON.stringify(node) === JSON.stringify(current.nodes[at])), true)
  let backupPath
  if (apply && changed) {
    assert.equal(option('--expected-before-sha256'), beforeSha256, 'Workflow row differs from reviewed preview')
    await mkdir(directory, { recursive: true })
    backupPath = path.join(directory, `before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(current, null, 2), { flag: 'wx', mode: 0o600 })
    const updated = await client.query(`update workflow_configs set nodes=$2::jsonb,updated_at=now()
      where id=$1 and schema_version=156 and nodes=$3::jsonb and edges=$4::jsonb and xmin::text=$5 returning id`,
    [workflowId, JSON.stringify(nextNodes), JSON.stringify(current.nodes), JSON.stringify(current.edges), current.row_revision])
    assert.equal(updated.rowCount, 1, 'Workflow prompt CAS failed')
  }
  const saved = (await client.query('select nodes,edges,schema_version from workflow_configs where id=$1', [workflowId])).rows[0]
  assert.equal(saved.schema_version, 156)
  assert.equal(saved.nodes[index].prompt, apply ? COVERAGE_CUT_FRAME_REVIEW_PROMPT : old.prompt)
  assert.equal(sha(saved.edges), sha(current.edges))
  assert.deepEqual(await histories(), executionBefore)
  assert.deepEqual(await imageAndReviewLedgers(), ledgersBefore)
  if (apply) { await client.query('commit'); committed = true }
  else await client.query('rollback')
  const proof = { format: 'coverage-cut-review-prompt-cas-v2', at: new Date().toISOString(),
    applied: apply, changed, schemaVersion: 156, nodeId: old.id, beforeSha256,
    oldPromptSha256: sha(old.prompt), newPromptSha256: sha(COVERAGE_CUT_FRAME_REVIEW_PROMPT),
    savedPromptSha256: sha(saved.nodes[index].prompt), nodeCount: saved.nodes.length,
    edgeCount: saved.edges.length, executionRecordCount: executionBefore.length,
    executionVersionsSha256: sha(executionBefore), protectedPaidLedgerRows: ledgersBefore.length,
    protectedPaidLedgerSha256: sha(ledgersBefore), executionWrites: 0, mediaRequests: 0, backupPath }
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `migration-${apply ? 'applied' : 'preview'}.json`), JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  if (!committed) await client.query('rollback').catch(() => {})
  throw error
} finally { await client.end() }
