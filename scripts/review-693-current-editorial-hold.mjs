#!/usr/bin/env node
// One independent production-text review of the preserved original episode 693
// candidate, followed by the saved code-node accept gate on the actual report.
// The unique request key is marked submitted before HTTP dispatch and is never
// replayed. No media or workflow execution is created.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'

const run = process.argv.includes('--run')
const sourceDir = path.resolve('logs/episode693-schema151-outline-20260928')
const out = path.resolve('logs/episode693-schema154-independent-editorial-review-20260928-v1')
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const read = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
const save = async (name, value) => {
  await fs.mkdir(out, { recursive: true })
  await fs.writeFile(path.join(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: '-c default_transaction_read_only=on' })
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
async function post(url, body, timeoutMs) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  return { httpStatus: response.status, text: await response.text() }
}
try {
  const [candidate, context] = await Promise.all([read(sourceDir, 'candidate.json'), read(sourceDir, 'context.json')])
  const workflow = (await db.query(
    'SELECT id,name,schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  if (!workflow || workflow.schema_version < 153) throw Error('Current workflow lacks editorial review gate')
  const reviewer = workflow.nodes.find(node => node.id === 'sanguo-scene-outline-review')
  const gate = workflow.nodes.find(node => node.id === 'sanguo-scene-outline-accept')
  const writer = workflow.nodes.find(node => node.id === 'sanguo-scene-outline')
  if (reviewer?.operation !== 'history.script-review' || !reviewer.prompt?.includes('【文本原则审查 principle-v1】')
    || !reviewer.prompt.includes('【影视表达建议】') || !reviewer.prompt.includes('unnecessary_map')
    || !reviewer.prompt.includes('repeated_action_without_delta')
    || gate?.kind !== 'code' || !gate.code?.includes('manualDecisionRequired')
    || !gate.code.includes('editorialHold') || !writer?.resultVar) {
    throw Error('Current saved reviewer or text gate lacks evidence-bound dramaturgy checks')
  }
  const model = (await db.query('SELECT * FROM model_configs WHERE id=$1', [reviewer.modelId])).rows[0]
  if (!model || model.capability !== 'text') throw Error('Saved reviewer model is not text capable')
  const direct = context.historical_sources?.citations?.find(item => item.id === 'web-bb704118d82c7a47'
    && item.content?.includes('先主常戒之曰'))
  if (!direct || context.input?.episode_boundary?.next?.[0]?.title !== '帐下行刺') {
    throw Error('Direct Zhang Fei source or adjacent-episode boundary is absent')
  }
  const reviewContext = { input: context.input, historical_sources: context.historical_sources,
    scene: null, [writer.resultVar]: candidate }
  const params = paramsFor(reviewer, reviewContext)
  if (sha(params.candidate) !== sha(candidate)) throw Error('Reviewer candidate binding differs from preserved source')
  const prompt = renderWorkflowTemplate(reviewer.prompt, { ...reviewContext, params })
  if (!prompt.includes('张飞治兵') || !prompt.includes(direct.id)
    || !prompt.includes('帐下行刺') || !prompt.includes(candidate.scenes[0].title)) {
    throw Error('Rendered review prompt lacks episode, source, neighbor, or candidate')
  }
  const workflowHash = sha([workflow.nodes, workflow.edges, workflow.schema_version])
  const fingerprint = { schema: workflow.schema_version, workflowHash, reviewerHash: sha(reviewer), gateCodeHash: sha(gate.code),
    modelConfigHash: sha(model), candidateHash: sha(candidate), sourceHash: sha(context.historical_sources), promptHash: sha(prompt) }
  let manifest
  try { manifest = await read(out, 'manifest.json') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (manifest && sha(manifest.fingerprint) !== sha(fingerprint)) throw Error('Prepared review drifted; never replace a submitted key')
  if (!manifest) manifest = { createdAt: new Date().toISOString(),
    requestKey: `zhangfei-current-review-693-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    status: 'prepared', fingerprint }
  const ledger = (await db.query("SELECT id,status,http_status,capability,node_id,request_data->>'operation' AS operation FROM model_execution_records WHERE request_data->>'requestKey'=$1", [manifest.requestKey])).rows
  if (!run) {
    await save('manifest.json', manifest)
    await save('prompt.txt', prompt)
    await save('params.json', params)
    await save('preflight.json', { schema: workflow.schema_version, rowVersion: workflow.row_version,
      requestKey: manifest.requestKey, status: manifest.status, existingLedgerCount: ledger.length,
      sourceCitationId: direct.id, candidateHash: sha(candidate), workflowHash,
      reviewerPromptHash: sha(reviewer.prompt), gateCodeHash: sha(gate.code), mediaGenerated: false,
      workflowWrites: 0, executionWrites: 0 })
    console.log(JSON.stringify({ event: 'prepared', requestKey: manifest.requestKey, schema: workflow.schema_version,
      candidate: path.relative(process.cwd(), path.join(sourceDir, 'candidate.json')), promptChars: prompt.length }))
  } else {
    if (manifest.status !== 'prepared' || ledger.length) throw Error('Request was submitted; never resend')
    const current = (await db.query('SELECT schema_version,nodes,edges FROM workflow_configs WHERE id=$1', [workflow.id])).rows[0]
    if (sha([current.nodes, current.edges, current.schema_version]) !== workflowHash) throw Error('Workflow changed since preflight; stop before paid call')
    manifest.status = 'submitted'; manifest.submittedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'submitted', requestKey: manifest.requestKey }))
    const response = await post(base + '/api/node-run', { model, prompt, params, operation: reviewer.operation,
      executionContext: { workflowId: workflow.id, workflowName: workflow.name,
        nodeId: reviewer.id, nodeName: reviewer.title, requestKey: manifest.requestKey } }, 960_000)
    await save('response.txt', response.text)
    let parsed
    try { parsed = JSON.parse(response.text) } catch { parsed = { unparsedBody: response.text } }
    await save('response.json', { httpStatus: response.httpStatus, ...parsed })
    const finalLedger = (await db.query("SELECT id,status,http_status,capability,node_id,request_data->>'operation' AS operation FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at", [manifest.requestKey])).rows
    await save('ledger.json', finalLedger)
    if (response.httpStatus !== 200 || parsed.status !== 200 || finalLedger.length !== 1
      || finalLedger[0].capability !== 'text' || finalLedger[0].node_id !== reviewer.id
      || finalLedger[0].operation !== reviewer.operation) {
      throw Error('Reviewer response or single durable text ledger is incomplete')
    }
    const report = normalizeStructuredTextOutput(parsed.body, extractTextResponse(parsed.body), 'json')
    await save('report.json', report)
    const gateResponse = await post(base + '/api/code-node-run', { code: gate.code, prompt: gate.prompt,
      params: { qualityMode: 'principle-v1', qualityDisposition: 'manual-review-v1', candidate, review: report,
        sources: context.historical_sources.citations }, context: { historical_sources: context.historical_sources }, files: [] }, 20_000)
    let gateParsed
    try { gateParsed = JSON.parse(gateResponse.text) } catch { gateParsed = { unparsedBody: gateResponse.text } }
    await save('gate-response.json', { httpStatus: gateResponse.httpStatus, ...gateParsed })
    if (gateResponse.httpStatus !== 200 || gateParsed.status !== 200) throw Error('Saved text accept code-node failed')
    const accepted = gateParsed.body
    await save('gate-summary.json', { passed: accepted.passed, decision: report.decision,
      principleIssues: accepted.issues, warningCount: report.warnings?.length ?? 0,
      manualDecisionRequired: accepted.manualDecisionRequired,
      editorialHold: accepted.qualityReview?.editorialHold ?? null,
      rawReportPreserved: sha(accepted.qualityReview?.rawReport) === sha(report),
      scenesPreserved: sha(accepted.scenes) === sha(candidate.scenes),
      caveat: 'Real independent report and actual saved code-node VM; no workflow execution record or video was created' })
    const after = (await db.query('SELECT schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1', [workflow.id])).rows[0]
    await save('postflight.json', { schema: after.schema_version, rowVersion: after.row_version,
      workflowHash: sha([after.nodes, after.edges, after.schema_version]),
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash,
      requestKey: manifest.requestKey, ledgerCount: finalLedger.length, mediaGenerated: false })
    manifest.status = 'completed'; manifest.completedAt = new Date().toISOString(); await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'reviewed', requestKey: manifest.requestKey, decision: report.decision,
      warningCount: report.warnings?.length ?? 0, manualDecisionRequired: accepted.manualDecisionRequired,
      editorialFindingCount: accepted.qualityReview?.editorialHold?.findings?.length ?? 0,
      schemaAfter: after.schema_version }))
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'failed', error: String(error) }))
  process.exitCode = 1
} finally { await db.end() }
