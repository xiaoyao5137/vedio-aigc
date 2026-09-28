#!/usr/bin/env node
// Bounded saved-code refresh only. Default is a read-only DB dry-run with a
// guarded backup; --apply performs one compare-and-swap workflow row update.
// Existing execution records, model ledgers, media and edges are untouched.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

const workflowId = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/dramatic-expression/live-20260928/manual-media-decision-migration')
const backupFile = path.join(directory, 'workflow-before.json')
const proofFile = path.join(directory, 'dry-run.json')
const apply = process.argv.includes('--apply')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const beforeClause = 'const manualDecisionRequired = manual && review.decision === "revise" && problems.some((row) =>'
const afterClause = 'const manualDecisionRequired = manual && problems.some((row) =>'
const count = (text, fragment) => text.split(fragment).length - 1
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

try {
  const row = (await pool.query('SELECT *, xmin::text AS row_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  if (!row || row.schema_version !== 150) throw Error('Expected schema150 Sanguo workflow; no changes made')
  const matches = row.nodes.filter(node => node.id === 'sanguo-media-accept')
  if (matches.length !== 1 || matches[0].kind !== 'code' || typeof matches[0].code !== 'string') throw Error('Expected one media accept code node')
  const gate = matches[0]
  if (count(gate.code, beforeClause) !== 1 || count(gate.code, afterClause) !== 0
    || !gate.code.includes('row.code === "core_event_contradiction" && obj(row.evidence).source === "frame"')) {
    throw Error('Saved media decision condition differs from guarded source; refuse overwrite')
  }
  const nodes = row.nodes.map(node => node === gate ? { ...node, code: node.code.replace(beforeClause, afterClause) } : node)
  const restored = nodes.map(node => node.id === gate.id ? { ...node, code: node.code.replace(afterClause, beforeClause) } : node)
  if (hash(restored) !== hash(row.nodes)) throw Error('Migration diff exceeds one manual decision clause')
  const proof = { workflowId, schemaVersion: row.schema_version, rowVersion: row.row_version,
    changedNodes: [{ id: gate.id, changedKeys: ['code'], changedClause: { before: beforeClause, after: afterClause } }],
    beforeNodesSha256: hash(row.nodes), afterNodesSha256: hash(nodes), edgesSha256: hash(row.edges),
    oldCodeSha256: hash(gate.code), newCodeSha256: hash(nodes.find(node => node.id === gate.id).code),
    executionRecordsChanged: false, providerCalls: 0 }
  if (!apply) {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(backupFile, JSON.stringify({ row, hash: hash(row) }, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.writeFile(proofFile, JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ mode: 'dry-run', backupFile, proofFile, ...proof }))
  } else {
    const backup = JSON.parse(await fs.readFile(backupFile, 'utf8'))
    const reviewed = JSON.parse(await fs.readFile(proofFile, 'utf8'))
    if (hash(backup.row) !== backup.hash || backup.row.row_version !== row.row_version
      || hash(backup.row.nodes) !== hash(row.nodes) || reviewed.beforeNodesSha256 !== hash(row.nodes)
      || reviewed.afterNodesSha256 !== hash(nodes) || reviewed.edgesSha256 !== hash(row.edges)) {
      throw Error('Saved workflow differs from reviewed dry-run; refuse overwrite')
    }
    const updated = await pool.query('UPDATE workflow_configs SET nodes=$2::jsonb, updated_at=now() WHERE id=$1 AND xmin::text=$3 RETURNING id',
      [workflowId, JSON.stringify(nodes), row.row_version])
    if (updated.rowCount !== 1) throw Error('Concurrent workflow change; refuse overwrite')
    console.log(JSON.stringify({ mode: 'applied', workflowId, changedNodes: proof.changedNodes, beforeNodesSha256: proof.beforeNodesSha256,
      afterNodesSha256: proof.afterNodesSha256 }))
  }
} finally { await pool.end() }
