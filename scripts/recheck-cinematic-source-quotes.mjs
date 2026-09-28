// Recheck one existing automatic outline with the persisted reviewer only.
// Two requests at most for the source-span round. Prior rounds remain separate;
// uncertain requests stop without repurchase.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { historicalSourceReviewContext } from '../src/history-source-review.ts'

const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
if (args.includes('--help')) { console.log('Usage: node scripts/recheck-cinematic-source-quotes.mjs [--input-dir DIR] [--candidate FILE] [--out DIR]. No writer or media calls. At most two source-span reviewer requests; reuse --out for cached responses.'); process.exit(0) }
const inputDir = path.resolve(option('--input-dir') ?? 'logs/cinematic-drama/1788690738163')
const directory = path.resolve(option('--out') ?? `logs/cinematic-drama/source-span-recheck-${Date.now()}`)
const candidateFile = path.resolve(option('--candidate') ?? path.join(inputDir, 'attempt-3-validated.json'))
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const maybe = async file => { try { return await read(file) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const secrets = new Set()
function collectSecrets(value) { if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (/(?:api.?key|authorization|password|secret|access.?token)/i.test(key) && typeof item === 'string' && item) secrets.add(item); else collectSecrets(item) } }
function redact(value) {
  if (typeof value === 'string') { for (const secret of secrets) value = value.replaceAll(secret, '[REDACTED]'); return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/g, 'Bearer [REDACTED]') }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:api.?key|authorization|password|secret|access.?token)/i.test(key) ? '[REDACTED]' : redact(item)]))
  return value
}
async function save(name, value) { await fs.writeFile(path.join(directory, name), JSON.stringify(redact(value), null, 2)) }
function parameters(node, context) { return Object.fromEntries((node.params ?? []).map(param => {
  const exact = String(param.value).trim().match(/^\$\{([^}]+)\}$/)
  let value = exact ? exact[1].trim().split('.').reduce((current, key) => current?.[key], context) : renderWorkflowTemplate(String(param.value), context)
  if (!exact && param.type === 'number') value = Number(value || 0)
  if (!exact && param.type === 'boolean') value = value === 'true'
  if (!exact && param.type === 'json') value = JSON.parse(value || '{}')
  return [param.englishName?.trim() || param.name, value]
})) }
async function post(route, payload, name) {
  await save(`${name}-request.json`, { url: base + route, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(420_000) })
  const body = await response.text()
  let raw
  try { raw = JSON.parse(body) } catch { raw = { unparsedBody: body } }
  raw = { httpStatus: response.status, ...raw }
  await save(`${name}-raw.json`, raw)
  return raw
}
function unwrap(raw) {
  if (raw.httpStatus >= 400 || raw.status >= 400 || !Object.hasOwn(raw, 'body')) throw Error(`Request failed: ${JSON.stringify(redact(raw))}`)
  if (raw.body?.routeError) throw Error(String(raw.body.routeError))
  return raw.body
}
const status = { scope: 'source-spans-v1-existing-automatic-outline-review-only', candidateFile, directory, writerCalls: 0, mediaGenerated: false, databaseMutated: false, maximumReviewRequests: 2, passed: false, attempts: [] }
await fs.mkdir(directory, { recursive: true })
try {
  const [source, savedContext] = await Promise.all([read(candidateFile), read(path.join(inputDir, 'context.json'))])
  const context = { input: savedContext.input, historical_sources: savedContext.historical_sources }
  const workflow = (await pool.query('select * from workflow_configs where id=$1', ['wf-sanguo-history-drama'])).rows[0]
  const writerResultVar = workflow?.nodes.find(node => node.id === 'sanguo-scene-outline')?.resultVar
  const reviewer = workflow?.nodes.find(node => node.id === 'sanguo-scene-outline-review')
  const gate = workflow?.nodes.find(node => node.id === 'sanguo-scene-outline-accept')
  if (!reviewer?.prompt?.includes('${history_source_review}') || !gate?.code?.includes('resolveHistoricalReviewSourceSpans')) throw Error('The source-span prompt and gate are not deployed; no model request was submitted')
  const model = (await pool.query('select * from model_configs where id=$1', [reviewer.modelId])).rows[0]
  if (model?.capability !== 'text') throw Error('The configured reviewer is not a text model')
  collectSecrets(model)
  validateHistoricalProductionPlan(source)
  validateHistoricalAgency(source, context.historical_sources.citations)
  // repairProvenance was attached after the original validator; check the
  // writing payload without that runtime envelope, then review the exact saved
  // candidate. No dialogue, source quotation or prior model judgement is edited.
  validateHistoricalStructuredOutput('history.scene-outline', Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'repairProvenance')), { requireDramaContract: true, requireBeatCoverage: true, requireNarrativeClosure: true, input: context.input, historicalSources: context.historical_sources })
  const candidate = source
  const fingerprint = hash({ candidate, context, reviewer, gate, modelId: model.id })
  const existingManifest = await maybe(path.join(directory, 'manifest.json'))
  if (existingManifest && existingManifest.fingerprint !== fingerprint) throw Error('Candidate or configuration changed; preserve this directory and choose a new --out')
  await save('manifest.json', { fingerprint, candidateFile, reviewer, gate, workflowId: workflow.id, workflowSchema: workflow.schema_version, modelId: model.id })
  await save('candidate.json', candidate)
  await save('context.json', context)
  let correction = ''
  let correctReviews = 0
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reviewContext = { ...context, [writerResultVar]: candidate }
    const params = parameters(reviewer, reviewContext)
    if (JSON.stringify(params.candidate) !== JSON.stringify(candidate)) throw Error('Configured reviewer parameter did not receive the exact saved candidate; no request was submitted')
    const renderContext = historicalSourceReviewContext({ ...reviewContext, params })
    const prompt = renderWorkflowTemplate(reviewer.prompt, renderContext) + correction
    await save(`review-${attempt}-source-packet.json`, renderContext.history_source_review)
    const requiredContent = candidate.scenes.flatMap(scene => [scene.id, ...scene.requiredBeats.flatMap(beat => [...beat.observable.visual, ...beat.observable.audio])])
    if (requiredContent.some(value => !prompt.includes(value) && !prompt.includes(JSON.stringify(value).slice(1, -1)))) throw Error('Rendered reviewer prompt omitted a candidate scene id or approved visual/audio anchor; no request was submitted')
    const name = `review-${attempt}`
    const requestKey = `cinematic-source-quote-${hash({ directory, fingerprint, attempt }).slice(0, 36)}`
    let raw = await maybe(path.join(directory, `${name}-raw.json`))
    const priorRequest = await maybe(path.join(directory, `${name}-request.json`))
    if (raw && priorRequest && JSON.stringify(priorRequest.body?.params?.candidate) !== JSON.stringify(candidate)) {
      const issue = 'REVIEW_HARNESS_INVALID_REQUEST: prior submitted request omitted the saved candidate; its response is unrelated and cannot validate this outline'
      status.attempts.push({ attempt, reportStructurallyValid: false, issue })
      await save(`${name}-invalid-request.json`, { issue, countsAgainstTotalRequestLimit: true, rawPreserved: true })
      continue
    }
    correctReviews++
    if (correctReviews > 2) throw Error('Two correct-candidate review requests have been exhausted')
    if (!raw && await maybe(path.join(directory, `${name}-submitted.json`))) {
      const cached = (await pool.query("select status,http_status,response_data,error from model_execution_records where request_data->>'requestKey'=$1 order by created_at desc limit 1", [requestKey])).rows[0]
      if (cached?.status !== 'success' || !cached.response_data) throw Error(`Prior review ${requestKey} has no durable successful response; stopped without duplicate request`)
      raw = { httpStatus: cached.http_status || 200, status: cached.http_status || 200, body: cached.response_data }
      await save(`${name}-raw.json`, raw)
    }
    if (!raw) {
      await save(`${name}-submitted.json`, { requestKey, startedAt: new Date().toISOString(), modelId: model.id })
      console.log(JSON.stringify({ event: 'review-started', attempt, directory, requestKey }))
      raw = await post('/api/node-run', { model, prompt, params, operation: reviewer.operation, executionContext: { workflowId: workflow.id, nodeId: reviewer.id, nodeName: reviewer.title, requestKey } }, name)
    }
    try {
      const body = unwrap(raw)
      const report = normalizeStructuredTextOutput(body, extractTextResponse(body), 'json')
      await save(`${name}-report.json`, report)
      const gateContext = { ...reviewContext, [reviewer.resultVar]: report }
      const accepted = unwrap(await post('/api/code-node-run', { code: gate.code, prompt: gate.prompt, params: parameters(gate, gateContext), context: gateContext, files: [] }, `gate-${attempt}`))
      await save(`gate-${attempt}-result.json`, accepted)
      status.attempts.push({ attempt, reportStructurallyValid: true, passed: accepted.passed, factualPassed: accepted.factualReview?.passed, dramaturgyPassed: accepted.dramaturgyReview?.passed, issues: accepted.issues })
      if (accepted.passed === true && accepted.factualReview?.passed === true && accepted.dramaturgyReview?.passed === true && accepted.reviewVersion === 'cinematic-review-v1') { status.passed = true; await save('accepted.json', accepted) }
      break
    } catch (error) {
      const issue = String(error)
      status.attempts.push({ attempt, reportStructurallyValid: false, issue })
      await save(`review-${attempt}-error.json`, { issue })
      if (!issue.includes('REVIEW_RESULT_INVALID:') || attempt === 2 || correctReviews === 2) throw error
      correction = '\n【仅修复完整审核报告的证据格式，不改候选、不强迫通过】\n' + issue + '\n事实证据从当前history_source_review.sources的numberedText内⟦sourceSpanId⟧原文⟦/⟧标签选择真实sourceSpanId，不重打quote；按expectedCoverage完整覆盖每场，不只修报错的第一场。必须独立判断；若内容存在问题，照常拒绝。'
    }
    await save('status.json', status)
  }
  if (!status.passed) throw Error('Existing automatic candidate was not accepted within the bounded reviewer budget')
} catch (error) { status.error = String(error); process.exitCode = 1 }
finally { await save('status.json', status); await pool.end(); console.log(JSON.stringify(redact(status))) }
