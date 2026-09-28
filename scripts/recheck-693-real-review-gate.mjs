#!/usr/bin/env node
// Recheck the one already-paid real reviewer report against the newly saved
// text accept code. Only the local code-node VM is invoked; no text or media
// supplier call, execution record, or workflow edit occurs.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'

const dir = path.resolve('logs/episode693-schema154-independent-editorial-review-20260928-v1')
const read = async name => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const [report, originalResponse, candidate, context] = await Promise.all([
  read('report.json'), read('gate-summary.json'),
  JSON.parse(await fs.readFile('logs/episode693-schema151-outline-20260928/candidate.json', 'utf8')),
  JSON.parse(await fs.readFile('logs/episode693-schema151-outline-20260928/context.json', 'utf8')),
])
if (report.decision !== 'pass' || report.warnings?.length !== 1
  || report.warnings[0]?.code !== 'unnecessary_map' || originalResponse.manualDecisionRequired !== false) {
  throw Error('Saved actual review or before-fix gate evidence drifted')
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: '-c default_transaction_read_only=on' })
try {
  const row = (await pool.query('SELECT schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  const gate = row.nodes.find(node => node.id === 'sanguo-scene-outline-accept')
  const shotGate = row.nodes.find(node => node.id === 'sanguo-shot-script-accept')
  if (row.schema_version < 154 || !gate?.code?.includes('editorialHold') || gate.code !== shotGate?.code) {
    throw Error('Current saved workflow does not contain the matching updated text accept nodes')
  }
  const payload = { code: gate.code, prompt: gate.prompt,
    params: { qualityMode: 'principle-v1', qualityDisposition: 'manual-review-v1', candidate, review: report,
      sources: context.historical_sources.citations },
    context: { historical_sources: context.historical_sources }, files: [] }
  const response = await fetch('http://127.0.0.1:5173/api/code-node-run', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) })
  const envelope = await response.json()
  const result = envelope.body
  const summary = { format: 'actual-review-saved-code-gate-recheck-v1', schema: row.schema_version,
    rowVersion: row.row_version, workflowHash: sha([row.nodes, row.edges, row.schema_version]),
    gateCodeHash: sha(gate.code), reportHash: sha(report), candidateHash: sha(candidate),
    beforeFixManualDecisionRequired: originalResponse.manualDecisionRequired,
    httpStatus: response.status, nodeStatus: envelope.status, passed: result?.passed,
    afterFixManualDecisionRequired: result?.manualDecisionRequired,
    editorialFindings: result?.qualityReview?.editorialHold?.findings ?? [],
    candidatePreserved: sha(result?.scenes) === sha(candidate.scenes),
    reportPreserved: sha(result?.qualityReview?.rawReport) === sha(report),
    providerCalls: 0, mediaGenerated: false, executionWrites: 0, workflowWrites: 0 }
  await fs.writeFile(path.join(dir, 'post-fix-gate-response.json'), JSON.stringify({ httpStatus: response.status, envelope }, null, 2))
  await fs.writeFile(path.join(dir, 'post-fix-gate-summary.json'), JSON.stringify(summary, null, 2) + '\n')
  if (response.status !== 200 || envelope.status !== 200 || result?.manualDecisionRequired !== true
    || summary.editorialFindings.length !== 1 || !summary.candidatePreserved || !summary.reportPreserved) {
    throw Error('Current saved code gate did not pause on the real grounded report')
  }
  console.log(JSON.stringify({ schema: summary.schema, before: summary.beforeFixManualDecisionRequired,
    after: summary.afterFixManualDecisionRequired, findings: summary.editorialFindings.length,
    candidatePreserved: summary.candidatePreserved, reportPreserved: summary.reportPreserved }))
} finally { await pool.end() }
