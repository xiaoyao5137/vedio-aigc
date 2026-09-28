#!/usr/bin/env node
// One independent current saved-workflow text review of the bounded 637 v2
// candidate. Prepare first; --run submits once and never retries the key.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import pg from 'pg'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { acceptPrincipleTextQuality } from '../src/principle-text-quality.ts'

const run = process.argv.includes('--run')
const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const originalDir = path.resolve('logs/episode637-schema151-outline-20260928')
const revisedDir = path.resolve('logs/episode637-schema152-bounded-revision-20260928-v1')
const directory = path.resolve(arg('--out') ?? 'logs/episode637-schema153-map-v2-review-20260928-v1')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: '-c default_transaction_read_only=on' })
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex')
const read = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
const save = async (name, value) => {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 })
}
function paramsFor(node, context) {
  return Object.fromEntries((node.params ?? []).map(param => {
    const template = String(param.value ?? '')
    const exact = template.match(/^\$\{([^}]+)\}$/)
    let value = exact ? exact[1].split('.').reduce((current, key) => current?.[key], context)
      : renderWorkflowTemplate(template, context)
    if (!exact && param.type === 'number') value = Number(value || 0)
    if (!exact && param.type === 'boolean') value = value === 'true'
    if (!exact && param.type === 'json') value = JSON.parse(value || '{}')
    return [param.englishName?.trim() || param.name, value]
  }))
}
function postJson(urlString, body) {
  const url = new URL(urlString), transport = url.protocol === 'https:' ? https : http
  const serialized = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serialized) }, signal: AbortSignal.timeout(960_000) }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ httpStatus: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(serialized)
  })
}

try {
  const [candidate, context, alignment] = await Promise.all([
    read(revisedDir, 'candidate-map-annotations-aligned-v2.json'), read(originalDir, 'context.json'),
    read(revisedDir, 'map-annotations-alignment-proof-v2.json'),
  ])
  if (alignment.outputCandidateHash !== sha(candidate) || !alignment.staticPassed) throw Error('637 v2 candidate provenance invalid')
  const workflow = (await pool.query('SELECT id,name,schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  const reviewer = workflow?.nodes.find(node => node.id === 'sanguo-scene-outline-review')
  const writer = workflow?.nodes.find(node => node.id === 'sanguo-scene-outline')
  const model = reviewer && (await pool.query('SELECT * FROM model_configs WHERE id=$1', [reviewer.modelId])).rows[0]
  if (workflow.schema_version !== 153 || reviewer?.operation !== 'history.script-review' || model?.capability !== 'text'
    || !reviewer.prompt.includes('unnecessary_map') || !reviewer.prompt.includes('repeated_action_without_delta')) {
    throw Error('Current saved schema153 structured reviewer is unavailable')
  }
  const reviewContext = { input: context.input, historical_sources: context.historical_sources,
    scene: null, [writer.resultVar]: candidate }
  const params = paramsFor(reviewer, reviewContext)
  if (sha(params.candidate) !== sha(candidate)) throw Error('Saved reviewer does not bind the exact 637 v2 candidate')
  const prompt = renderWorkflowTemplate(reviewer.prompt, { ...reviewContext, params })
  const source = context.historical_sources.citations.find(citation => decodeURI(citation.url ?? '').includes('三國志/卷36#張飛')
    && /飛率精卒萬餘人/u.test(citation.content))
  if (!source || !prompt.includes(source.id) || !prompt.includes(candidate.scenes[0].title)
    || !prompt.includes(context.input.episode_boundary.next[0].title)) {
    throw Error('Rendered reviewer prompt lacks direct source, candidate, or 638 boundary')
  }
  const workflowHash = sha([workflow.nodes, workflow.edges, workflow.schema_version])
  const fingerprint = { workflowHash, reviewerHash: sha(reviewer), modelHash: sha(model), candidateHash: sha(candidate),
    sourceHash: sha(context.historical_sources), promptHash: sha(prompt), paramsHash: sha(params) }
  let manifest
  try { manifest = await read(directory, 'manifest.json') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (manifest && sha(manifest.fingerprint) !== sha(fingerprint)) throw Error('637 review preflight drifted; use a new directory')
  if (!manifest) manifest = { createdAt: new Date().toISOString(),
    requestKey: `zhangfei-map-v2-review-637-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    requestStatus: 'prepared', fingerprint }
  const existing = (await pool.query("SELECT id,status,http_status,capability,node_id FROM model_execution_records WHERE request_data->>'requestKey'=$1", [manifest.requestKey])).rows
  await save('manifest.json', manifest)
  await save('preflight.json', { schema: workflow.schema_version, rowVersion: workflow.row_version, workflowHash,
    requestKey: manifest.requestKey, existingLedgerCount: existing.length, candidateHash: sha(candidate),
    sourceId: source.id, promptHash: sha(prompt), mediaGenerated: false, executionWrites: 0, workflowWrites: 0 })
  await save('prompt.txt', prompt)
  await save('params.json', params)
  if (!run) {
    console.log(JSON.stringify({ event: 'prepared', directory, requestKey: manifest.requestKey, schema: workflow.schema_version }))
  } else {
    if (manifest.requestStatus !== 'prepared' || existing.length) throw Error('637 reviewer already submitted; never auto-retry')
    manifest.requestStatus = 'submitted'
    manifest.submittedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'submitted', directory, requestKey: manifest.requestKey }))
    const result = await postJson(base + '/api/node-run', { model, prompt, params, operation: reviewer.operation,
      executionContext: { workflowId: workflow.id, workflowName: workflow.name, nodeId: reviewer.id,
        nodeName: reviewer.title, requestKey: manifest.requestKey } })
    await save('response.txt', result.text)
    let response
    try { response = JSON.parse(result.text) } catch { response = { unparsedBody: result.text } }
    await save('response.json', { httpStatus: result.httpStatus, ...response })
    const ledger = (await pool.query("SELECT id,status,http_status,capability,node_id,request_data->>'requestKey' AS request_key FROM model_execution_records WHERE request_data->>'requestKey'=$1", [manifest.requestKey])).rows
    await save('ledger.json', ledger)
    if (result.httpStatus !== 200 || response.status >= 400 || response.body?.routeError || ledger.length !== 1
      || ledger[0].capability !== 'text' || ledger[0].node_id !== reviewer.id) throw Error('637 reviewer response/ledger invalid')
    const report = normalizeStructuredTextOutput(response.body, extractTextResponse(response.body), 'json')
    await save('report.json', report)
    const verdict = acceptPrincipleTextQuality({ candidate, review: report, citations: context.historical_sources.citations,
      qualityDisposition: 'manual-review-v1' })
    await save('offline-principle-accept.json', { passed: verdict.passed, issues: verdict.issues,
      qualityReview: verdict.qualityReview, caveat: 'Pure-function check only, not a workflow execution record' })
    const after = (await pool.query('SELECT schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
      [workflow.id])).rows[0]
    await save('postflight.json', { schema: after.schema_version, rowVersion: after.row_version,
      workflowHash: sha([after.nodes, after.edges, after.schema_version]),
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash,
      ledgerCount: ledger.length, mediaGenerated: false })
    manifest.requestStatus = 'completed'
    manifest.completedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'reviewed', directory, requestKey: manifest.requestKey,
      decision: report.decision, warnings: report.warnings?.length, principleIssues: verdict.issues?.length,
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash }))
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'failed', directory, error: String(error) }))
  process.exitCode = 1
} finally { await pool.end() }
