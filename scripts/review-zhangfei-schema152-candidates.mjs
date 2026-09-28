#!/usr/bin/env node
// One saved-candidate reviewer request per episode. Preparation is read-only;
// --run marks its unique key submitted before the single HTTP call, with no retry.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import pg from 'pg'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { upgradeDramaticExpression } from '../src/dramatic-expression.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { acceptPrincipleTextQuality } from '../src/principle-text-quality.ts'

const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
const episode = Number(arg('--episode'))
if (![637, 693].includes(episode)) throw Error('Use --episode=637 or --episode=693')
const run = process.argv.includes('--run')
const recover = process.argv.includes('--recover')
if (run && recover) throw Error('Use either --run or --recover, never both')
const sourceDir = path.resolve(`logs/episode${episode}-schema151-outline-20260928`)
const directory = path.resolve(arg('--out') ?? path.join(sourceDir, 'refreshed-text-review'))
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const permittedDriftBackup = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop4-media/media-review-gate-refresh-dry-20260928-v1/backup-private.json')
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: '-c default_transaction_read_only=on',
})
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const read = async name => JSON.parse(await fs.readFile(path.join(sourceDir, name), 'utf8'))
const save = async (name, value) => {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 })
}
const load = async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
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
function postJson(urlString, body, timeoutMs = 960_000) {
  const url = new URL(urlString)
  const transport = url.protocol === 'https:' ? https : http
  const serialized = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) },
      signal: AbortSignal.timeout(timeoutMs),
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ httpStatus: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(serialized)
  })
}

try {
  const [candidate, context] = await Promise.all([read('candidate.json'), read('context.json')])
  const workflow = (await pool.query(
    'SELECT id,name,schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
    ['wf-sanguo-history-drama'],
  )).rows[0]
  if (workflow?.schema_version !== 152) throw Error('Saved workflow is not schema152; stop without a review call')
  const savedReviewer = workflow.nodes.find(node => node.id === 'sanguo-scene-outline-review')
  if (!savedReviewer?.prompt?.includes('【文本原则审查 principle-v1】') || !savedReviewer.prompt.includes('【影视表达建议】')
    || savedReviewer.operation !== 'history.script-review') throw Error('Saved principle reviewer is unavailable')
  const reviewer = upgradeDramaticExpression({ id: workflow.id, schemaVersion: workflow.schema_version,
    nodes: [savedReviewer] }).nodes[0]
  if (!reviewer.prompt.includes('只标一个地名、城址变色') || !reviewer.prompt.includes('连续同场问答或同状态苦情段')
    || !reviewer.prompt.includes('“十二名亲兵”') || reviewer.prompt.includes('dramaturgyReview.issues')) {
    throw Error('Refreshed managed reviewer block is missing or contradicts principle-v1')
  }
  const model = (await pool.query('SELECT * FROM model_configs WHERE id=$1', [reviewer.modelId])).rows[0]
  if (!model || model.capability !== 'text') throw Error('Configured reviewer model is not text capable')
  const writerResultVar = workflow.nodes.find(node => node.id === 'sanguo-scene-outline')?.resultVar
  const reviewContext = { input: context.input, historical_sources: context.historical_sources,
    scene: null, [writerResultVar]: candidate }
  const params = paramsFor(reviewer, reviewContext)
  if (JSON.stringify(params.candidate) !== JSON.stringify(candidate)) throw Error('Reviewer candidate binding differs from saved candidate')
  const prompt = renderWorkflowTemplate(reviewer.prompt, { ...reviewContext, params })
  const direct = context.historical_sources.citations.find(citation => decodeURI(citation.url ?? '').includes('三國志/卷36#張飛')
    && (episode === 637 ? /飛率精卒萬餘人/u : /先主常戒之曰/u).test(citation.content))
  if (!direct || !prompt.includes(direct.id) || !prompt.includes(candidate.scenes[0].title)
    || !prompt.includes(context.input.episode_boundary.next[0].title)) throw Error('Reviewer prompt lacks direct source, candidate, or adjacent boundary')
  const workflowHash = sha([workflow.nodes, workflow.edges, workflow.schema_version])
  const sourceManifest = await read('manifest.json')
  if (sourceManifest.requestStatus !== 'completed') throw Error('Saved writer candidate is not final')
  let permittedDrift = null
  if (workflowHash !== sourceManifest.fingerprint.workflowHash) {
    const backup = JSON.parse(await fs.readFile(permittedDriftBackup, 'utf8'))
    if (sha(backup.row) !== backup.hash
      || sha([backup.row.nodes, backup.row.edges, backup.row.schema_version]) !== sourceManifest.fingerprint.workflowHash
      || sha(backup.row.edges) !== sha(workflow.edges) || backup.row.schema_version !== workflow.schema_version) {
      throw Error('Workflow drift backup does not match the original writer configuration')
    }
    const oldNodes = new Map(backup.row.nodes.map(node => [node.id, node]))
    const newNodes = new Map(workflow.nodes.map(node => [node.id, node]))
    const changed = [...new Set([...oldNodes.keys(), ...newNodes.keys()])]
      .filter(id => sha(oldNodes.get(id) ?? null) !== sha(newNodes.get(id) ?? null)).sort()
    if (JSON.stringify(changed) !== JSON.stringify(['sanguo-media-accept', 'sanguo-media-review'])) {
      throw Error(`Workflow changed outside the two unrelated media nodes: ${changed.join(', ')}`)
    }
    const firstPrepare = JSON.parse(await fs.readFile(path.join(sourceDir, 'refreshed-text-review', 'preflight.json'), 'utf8'))
    if (firstPrepare.promptHash !== sha(prompt)) throw Error('Outline reviewer binding changed after media-only workflow refresh')
    permittedDrift = { oldWorkflowHash: sourceManifest.fingerprint.workflowHash, newWorkflowHash: workflowHash,
      changedNodeIds: changed, reviewerRenderedPromptUnchanged: true }
  }
  let manifest
  try { manifest = await load('manifest.json') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const fingerprint = { episode, workflowHash, reviewerPromptHash: sha(reviewer.prompt), candidateHash: sha(candidate),
    sourceHash: sha(context.historical_sources), renderedPromptHash: sha(prompt), modelConfigHash: sha(model) }
  if (manifest && sha(manifest.fingerprint) !== sha(fingerprint)) throw Error('Review preparation drifted; use a new directory')
  if (!manifest) manifest = { createdAt: new Date().toISOString(),
    requestKey: `zhangfei-refreshed-review-${episode}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    fingerprint, requestStatus: 'prepared' }
  const existing = (await pool.query(
    `SELECT id,status,http_status,capability,node_id FROM model_execution_records
       WHERE request_data->>'requestKey'=$1 ORDER BY created_at`, [manifest.requestKey],
  )).rows
  if (!recover) {
    await save('manifest.json', manifest)
    await save('prompt.txt', prompt)
    await save('params.json', params)
    await save('preflight.json', { episode, directory, savedSchema: workflow.schema_version,
      rowVersion: workflow.row_version, workflowHash, sourceCitationId: direct.id,
      permittedDrift,
      requestKey: manifest.requestKey, requestStatus: manifest.requestStatus,
      existingLedgerCount: existing.length, promptHash: sha(prompt),
      sourceCandidateHash: sha(candidate), mediaGenerated: false, executionWrites: 0, workflowWrites: 0 })
  }
  if (!run && !recover) {
    console.log(JSON.stringify({ event: 'prepared', episode, directory, requestKey: manifest.requestKey, schema: 152 }))
  } else {
    let result, response
    if (recover) {
      if (manifest.requestStatus !== 'submitted' || existing.length !== 1) {
        throw Error('Recovery needs one previously submitted request and exactly one durable ledger row')
      }
      response = await load('response.json')
      result = { httpStatus: response.httpStatus, text: await fs.readFile(path.join(directory, 'response.txt'), 'utf8') }
    } else {
      if (manifest.requestStatus !== 'prepared' || existing.length) throw Error('Review request already submitted; inspect durable ledger, do not resend')
      manifest.requestStatus = 'submitted'
      manifest.submittedAt = new Date().toISOString()
      await save('manifest.json', manifest)
      console.log(JSON.stringify({ event: 'submitted', episode, directory, requestKey: manifest.requestKey }))
      result = await postJson(base + '/api/node-run', { model, prompt, params, operation: reviewer.operation,
        executionContext: { workflowId: workflow.id, workflowName: workflow.name,
          nodeId: reviewer.id, nodeName: reviewer.title, requestKey: manifest.requestKey } })
      await save('response.txt', result.text)
      try { response = JSON.parse(result.text) } catch { response = { unparsedBody: result.text } }
      await save('response.json', { httpStatus: result.httpStatus, ...response })
    }
    const ledger = (await pool.query(
      `SELECT id,status,http_status,capability,node_id,request_data->>'operation' AS operation,request_data->>'requestKey' AS request_key
         FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at`, [manifest.requestKey],
    )).rows
    await save('ledger.json', ledger)
    if (result.httpStatus !== 200 || response.status >= 400 || response.body?.routeError || ledger.length !== 1) {
      throw Error(`Reviewer request failed or ledger is ambiguous: HTTP ${result.httpStatus}, rows ${ledger.length}`)
    }
    const report = normalizeStructuredTextOutput(response.body, extractTextResponse(response.body), 'json')
    await save('report.json', report)
    const verdict = acceptPrincipleTextQuality({ candidate, review: report,
      citations: context.historical_sources.citations, qualityDisposition: 'manual-review-v1' })
    await save('offline-principle-accept.json', { passed: verdict.passed, issues: verdict.issues,
      qualityReview: verdict.qualityReview, caveat: 'local pure-function review of preserved candidate; not a workflow execution record' })
    const after = (await pool.query(
      'SELECT schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
      [workflow.id],
    )).rows[0]
    await save('postflight.json', { schema: after.schema_version, rowVersion: after.row_version,
      workflowHash: sha([after.nodes, after.edges, after.schema_version]),
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash,
      requestKey: manifest.requestKey, ledgerCount: ledger.length, mediaGenerated: false })
    manifest.requestStatus = 'completed'
    manifest.completedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'reviewed', episode, directory, requestKey: manifest.requestKey,
      decision: report.decision, warningCount: report.warnings?.length, principleIssueCount: verdict.issues?.length,
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash }))
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'failed', episode, directory, error: String(error) }))
  process.exitCode = 1
} finally { await pool.end() }
