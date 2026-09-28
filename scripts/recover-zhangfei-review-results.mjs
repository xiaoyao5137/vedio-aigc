#!/usr/bin/env node
// Finalize a previously submitted direct-node review from its saved response.
// This script cannot call a model or replay a request.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { acceptPrincipleTextQuality } from '../src/principle-text-quality.ts'

const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
const episode = Number(arg('--episode'))
if (![637, 693].includes(episode)) throw Error('Use --episode=637 or --episode=693')
const sourceDir = path.resolve(`logs/episode${episode}-schema151-outline-20260928`)
const directory = path.resolve(arg('--out') ?? path.join(sourceDir, 'refreshed-text-review-post-media-cas'))
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: '-c default_transaction_read_only=on' })
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const load = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
const save = async (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })

try {
  const [manifest, preflight, candidate, context, response, rawResponse, prompt, params] = await Promise.all([
    load(directory, 'manifest.json'), load(directory, 'preflight.json'), load(sourceDir, 'candidate.json'),
    load(sourceDir, 'context.json'), load(directory, 'response.json'),
    fs.readFile(path.join(directory, 'response.txt'), 'utf8'), fs.readFile(path.join(directory, 'prompt.txt'), 'utf8'),
    load(directory, 'params.json'),
  ])
  if (manifest.requestStatus !== 'submitted' && manifest.requestStatus !== 'completed') throw Error('Request was not submitted')
  if (preflight.requestKey !== manifest.requestKey || preflight.existingLedgerCount !== 0
    || preflight.workflowHash !== manifest.fingerprint.workflowHash
    || preflight.promptHash !== sha(prompt) || manifest.fingerprint.renderedPromptHash !== sha(prompt)
    || manifest.fingerprint.candidateHash !== sha(candidate) || manifest.fingerprint.sourceHash !== sha(context.historical_sources)
    || sha(params.candidate) !== sha(candidate)) throw Error('Saved submitted request evidence is inconsistent')
  const original = JSON.parse(rawResponse)
  if (response.httpStatus !== 200 || original.status !== 200 || sha(original.body) !== sha(response.body)) {
    throw Error('Saved reviewer response is incomplete or changed')
  }
  const ledger = (await pool.query(
    `SELECT id,status,http_status,capability,node_id,request_data->>'operation' AS operation,
      request_data->>'requestKey' AS request_key FROM model_execution_records
      WHERE request_data->>'requestKey'=$1 ORDER BY created_at`, [manifest.requestKey],
  )).rows
  if (ledger.length !== 1 || ledger[0].capability !== 'text' || ledger[0].node_id !== 'sanguo-scene-outline-review'
    || ledger[0].operation !== 'history.script-review' || ledger[0].http_status !== 200) {
    throw Error(`Saved request ledger is missing or ambiguous: ${ledger.length} rows`)
  }
  const report = normalizeStructuredTextOutput(response.body, extractTextResponse(response.body), 'json')
  const verdict = acceptPrincipleTextQuality({ candidate, review: report,
    citations: context.historical_sources.citations, qualityDisposition: 'manual-review-v1' })
  const current = (await pool.query('SELECT schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  const currentWorkflowHash = sha([current.nodes, current.edges, current.schema_version])
  await save('ledger.json', ledger)
  await save('report.json', report)
  await save('offline-principle-accept.json', { passed: verdict.passed, issues: verdict.issues,
    qualityReview: verdict.qualityReview,
    caveat: 'Pure-function acceptance of preserved candidate and submitted report; not a workflow execution record' })
  await save('postflight.json', { schema: current.schema_version, rowVersion: current.row_version,
    workflowHash: currentWorkflowHash, workflowUnchangedSinceSubmission: currentWorkflowHash === preflight.workflowHash,
    requestKey: manifest.requestKey, ledgerCount: ledger.length, mediaGenerated: false })
  manifest.requestStatus = 'completed'
  manifest.completedAt ??= new Date().toISOString()
  await save('manifest.json', manifest)
  console.log(JSON.stringify({ event: 'recovered', episode, directory, requestKey: manifest.requestKey,
    decision: report.decision, warningCount: report.warnings?.length,
    principleIssueCount: verdict.issues.length, workflowUnchangedSinceSubmission: currentWorkflowHash === preflight.workflowHash }))
} catch (error) {
  console.error(JSON.stringify({ event: 'failed', episode, directory, error: String(error) }))
  process.exitCode = 1
} finally { await pool.end() }
