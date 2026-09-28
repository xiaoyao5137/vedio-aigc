#!/usr/bin/env node
// Read-only preview by default. --apply requires an explicit --proof=<path>
// from a matching preview and changes only two managed text reviewer sections
// and two text acceptance policy blocks. Execution history and paid media are
// never updated by this migration.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import pg from 'pg'
import { upgradeDramaticExpression } from '../src/dramatic-expression.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'

const workflowId = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/dramatic-expression/editorial-text-hold-migration')
const apply = process.argv.includes('--apply')
const proofPath = process.argv.find(arg => arg.startsWith('--proof='))?.slice('--proof='.length)
if (apply && !proofPath) throw Error('EDITORIAL_TEXT_HOLD_PROOF_REQUIRED: run a read-only preview and pass its --proof path')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const count = (value, token) => value.split(token).length - 1
const REVIEW_START = '【影视表达建议】', REVIEW_END = '【影视表达建议结束】'
const CODE_START = '// PRINCIPLE_POLICY_START', CODE_END = '// PRINCIPLE_POLICY_END'
const reviewerIds = ['sanguo-scene-outline-review', 'sanguo-shot-script-review']
const acceptIds = ['sanguo-scene-outline-accept', 'sanguo-shot-script-accept']
const expectedIds = [...reviewerIds, ...acceptIds]
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const executionSnapshot = async () => (await db.query(
  'SELECT id,xmin::text AS row_version,ctid::text AS row_location FROM execution_records WHERE workflow_id=$1 ORDER BY id', [workflowId])).rows

function refreshNodes(row) {
  assert.ok(Number(row.schema_version) >= 145, 'Expected Sanguo workflow through the dramatic-expression baseline')
  const current = { ...row, schemaVersion: row.schema_version }
  const prompted = upgradeDramaticExpression(current)
  const coded = upgradePrincipleQuality(current)
  const nodeById = workflow => new Map(workflow.nodes.map(node => [node.id, node]))
  const promptNodes = nodeById(prompted), codeNodes = nodeById(coded)
  const seen = new Set()
  const changes = []
  const nodes = row.nodes.map(node => {
    if (!expectedIds.includes(node.id)) return node
    assert.ok(!seen.has(node.id), `Duplicate managed node: ${node.id}`)
    seen.add(node.id)
    if (reviewerIds.includes(node.id)) {
      const next = promptNodes.get(node.id)
      assert.equal(typeof node.prompt, 'string')
      assert.equal(typeof next?.prompt, 'string')
      assert.equal(count(node.prompt, REVIEW_START), 1, `Expected one existing review section on ${node.id}`)
      assert.equal(count(node.prompt, REVIEW_END), 1, `Expected one existing review section end on ${node.id}`)
      assert.equal(count(next.prompt, REVIEW_START), 1)
      assert.equal(count(next.prompt, REVIEW_END), 1)
      const outside = value => value.replace(/【影视表达建议】[\s\S]*?【影视表达建议结束】/, '<MANAGED_REVIEW>')
      assert.equal(outside(next.prompt), outside(node.prompt), `Refuse non-managed prompt edit on ${node.id}`)
      if (next.prompt === node.prompt) return node
      changes.push({ id: node.id, field: 'prompt', beforeSha256: hash(node.prompt), afterSha256: hash(next.prompt) })
      return { ...node, prompt: next.prompt }
    }
    const next = codeNodes.get(node.id)
    assert.equal(typeof node.code, 'string')
    assert.equal(typeof next?.code, 'string')
    assert.equal(count(node.code, CODE_START), 1, `Expected one owned policy block on ${node.id}`)
    assert.equal(count(node.code, CODE_END), 1, `Expected one owned policy block end on ${node.id}`)
    assert.equal(count(next.code, CODE_START), 1)
    assert.equal(count(next.code, CODE_END), 1)
    const outside = value => value.replace(/\/\/ PRINCIPLE_POLICY_START[\s\S]*?\/\/ PRINCIPLE_POLICY_END/, '<MANAGED_POLICY>')
    assert.equal(outside(next.code), outside(node.code), `Refuse non-managed code edit on ${node.id}`)
    if (next.code === node.code) return node
    changes.push({ id: node.id, field: 'code', beforeSha256: hash(node.code), afterSha256: hash(next.code) })
    return { ...node, code: next.code }
  })
  assert.deepEqual([...seen].sort(), expectedIds.sort(), 'Missing managed reviewer or accept node')
  assert.equal(nodes.length, row.nodes.length)
  assert.deepEqual(nodes.map(node => node.id), row.nodes.map(node => node.id))
  for (const [index, after] of nodes.entries()) {
    const before = row.nodes[index]
    const field = reviewerIds.includes(after.id) ? 'prompt' : acceptIds.includes(after.id) ? 'code' : undefined
    const without = node => Object.fromEntries(Object.entries(node).filter(([key]) => key !== field))
    assert.deepEqual(without(after), without(before), `Refuse non-${field ?? 'managed'} node edit on ${after.id}`)
  }
  return { nodes, changes }
}

await db.connect()
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const row = (await db.query(`SELECT *,xmin::text AS row_version FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  assert.ok(row, `Missing workflow ${workflowId}`)
  const { nodes, changes } = refreshNodes(row)
  const originalConfigHash = hash([row.nodes, row.edges, row.schema_version])
  const targetConfigHash = hash([nodes, row.edges, row.schema_version])
  const beforeHistory = await executionSnapshot()
  const executionRowsHash = hash(beforeHistory)
  let backupPath
  if (apply) {
    const reviewed = JSON.parse(await fs.readFile(path.resolve(proofPath), 'utf8'))
    assert.equal(reviewed.mode, 'dry-run')
    assert.equal(reviewed.workflowId, workflowId)
    assert.equal(reviewed.rowVersion, row.row_version, 'Workflow row changed since reviewed preview; redo dry-run')
    assert.equal(reviewed.schemaVersion, row.schema_version, 'Workflow schema changed since reviewed preview; redo dry-run')
    assert.equal(reviewed.originalConfigHash, originalConfigHash, 'Workflow config changed since reviewed preview; redo dry-run')
    assert.equal(reviewed.targetConfigHash, targetConfigHash, 'Target source or prompt changed since reviewed preview; redo dry-run')
    assert.deepEqual(reviewed.changes, changes, 'Managed diff changed since reviewed preview; redo dry-run')
    assert.equal(reviewed.executionRowsHash, executionRowsHash, 'Execution prefix changed since reviewed preview; redo dry-run')
    await fs.mkdir(directory, { recursive: true })
    backupPath = path.join(directory, `workflow-before-${Date.now()}.json`)
    await fs.writeFile(backupPath, JSON.stringify(row, null, 2), { flag: 'wx', mode: 0o600 })
    if (changes.length) {
      const updated = await db.query('UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now() WHERE id=$1 AND xmin::text=$3 AND schema_version=$4 RETURNING id',
        [workflowId, JSON.stringify(nodes), row.row_version, row.schema_version])
      assert.equal(updated.rowCount, 1, 'Concurrent workflow change; no migration applied')
    }
    const after = (await db.query('SELECT * FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
    assert.deepEqual(after.nodes, nodes)
    assert.deepEqual(after.edges, row.edges)
    assert.equal(after.schema_version, row.schema_version)
    const unchanged = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['nodes', 'updated_at', 'row_version'].includes(key)))
    assert.deepEqual(unchanged(after), unchanged(row), 'Other workflow settings changed')
    assert.deepEqual(await executionSnapshot(), beforeHistory, 'Execution history changed in migration transaction')
    await db.query('COMMIT')
  } else {
    await db.query('ROLLBACK')
  }
  const proof = { mode: apply ? 'applied' : 'dry-run', workflowId, schemaVersion: row.schema_version,
    rowVersion: row.row_version, changes, originalConfigHash, targetConfigHash,
    edgesSha256: hash(row.edges), executionRowsHash, executionRows: beforeHistory.length,
    backupPath, executionWrites: 0, providerCalls: 0 }
  if (!apply) {
    await fs.mkdir(directory, { recursive: true })
    const generatedProof = path.join(directory, `preview-${Date.now()}.json`)
    await fs.writeFile(generatedProof, JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ ...proof, proofPath: generatedProof }, null, 2))
  } else console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await db.query('ROLLBACK')
  throw error
} finally { await db.end() }
