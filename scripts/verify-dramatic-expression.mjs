// Read-only preparation by default. --run sends one current production outline
// request. Existing provider retries/failover remain governed by saved params.
// No reviewer, code gate, image, audio, video or execution-history write occurs.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { HISTORY_QUALITY_VERSION } from '../src/history-media.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { parseEpisodeBoundary, validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'
import { characterSelectionsForEpisode, resolveCharacterVisualSelections, characterVisualCatalog, characterArtisticIdentityCatalog } from '../src/character-visual-workflow.ts'

const argument = name => {
  const assigned = process.argv.find(value => value.startsWith(`${name}=`))
  if (assigned) return assigned.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const execute = process.argv.includes('--run')
const workflowId = 'wf-sanguo-history-drama'
const requestedRecord = argument('--record')
const directory = path.resolve(argument('--out') ?? `logs/dramatic-expression/${Date.now()}`)
if (execute) {
  try {
    await fs.access(path.join(directory, 'request.json'))
    throw Error('This output directory already has a submitted request. Inspect its requestKey and ledger; do not create another paid request here.')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc', options: '-c default_transaction_read_only=on' })
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const secrets = new Set()
const summary = {
  startedAt: new Date().toISOString(), directory, dryRun: !execute,
  scope: 'current-saved-production-outline-text-and-deterministic-validation',
  applicationRequests: 0, executionWrites: 0, workflowWrites: 0, mediaGenerated: false,
  reviewerCalled: false, manualAcceptancePerformed: false, emotionalEffectAccepted: false,
  structurePassed: false, productionCapacityPassed: false, historicalAgencyPassed: false, episodeBoundaryPassed: false,
}
function collectSecrets(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (/(?:api.?key|authorization|password|secret|access.?token)/i.test(key) && typeof item === 'string' && item) secrets.add(item)
    else collectSecrets(item)
  }
}
function redact(value) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    let output = value
    for (const secret of secrets) output = output.replaceAll(secret, '[REDACTED]')
    return output.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/g, 'Bearer [REDACTED]')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, /(?:api.?key|authorization|password|secret|access.?token)/i.test(key) ? '[REDACTED]' : redact(item)]))
  return value
}
async function save(name, value) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, name), typeof value === 'string' ? redact(value) : JSON.stringify(redact(value), null, 2), { mode: 0o600 })
}
// The built-in fetch dispatcher closes a request that has not received response
// headers after roughly five minutes. A legitimate local Codex outline has
// previously taken longer, so use a socket timeout beyond the provider budget.
function postLocalJson(url, payload, timeoutMs) {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw Error('Outline verification only posts to the local HTTP service')
  }
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const request = http.request(endpoint, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close',
    } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('aborted', () => reject(Error('Outline response closed before completion')))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.once('error', reject)
    request.setTimeout(timeoutMs, () => request.destroy(Error(`Local outline response exceeded ${timeoutMs}ms; inspect the same requestKey before any retry`)))
    request.end(body)
  })
}
function parameters(node, context) {
  return Object.fromEntries((node.params ?? []).map(param => {
    const template = String(param.value ?? '')
    const exact = template.trim().match(/^\$\{([^}]+)\}$/)
    let value = exact ? exact[1].trim().split('.').reduce((item, key) => item && typeof item === 'object' ? item[key] : undefined, context)
      : renderWorkflowTemplate(template, context)
    if (!exact && param.type === 'number') value = Number(value || 0)
    if (!exact && param.type === 'boolean') value = value === 'true'
    if (!exact && param.type === 'json') {
      try { value = resolveTemplateJsonValue(JSON.parse(template || '{}'), context) }
      catch { value = JSON.parse(value || '{}') }
    }
    if (param.required && (value === undefined || value === null || value === '')) throw Error(`Saved writer parameter ${param.englishName || param.name} has no source value`)
    return [param.englishName?.trim() || param.name, value]
  }))
}
async function sourceSelection() {
  const candidates = requestedRecord
    ? [{ id: requestedRecord }]
    : (await pool.query('SELECT id FROM execution_records WHERE workflow_id=$1 ORDER BY created_at DESC LIMIT 30', [workflowId])).rows
  for (const candidate of candidates) {
    const row = (await pool.query('SELECT id,workflow_id,title,mode,created_at,result,xmin::text AS row_version,ctid::text AS row_location FROM execution_records WHERE id=$1', [candidate.id])).rows[0]
    if (!row || row.workflow_id !== workflowId) {
      if (requestedRecord) throw Error('Requested source record is missing or belongs to another workflow')
      continue
    }
    const state = decodeExecutionState(row.result)
    const run = (state.nodeRuns ?? []).find(item => item.node?.id === 'sanguo-scene-outline'
      && item.inputContext?.input && item.inputContext?.historical_sources?.citations?.length)
    if (run) return { row, run }
  }
  throw Error('No source record with a saved scene-outline inputContext and historical citations was found; pass --record=<id>')
}
async function ledger(requestKey) {
  const rows = (await pool.query(`SELECT id,channel,workflow_id,node_id,model_id,provider,capability,status,http_status,task_id,duration_ms,created_at,updated_at,
    request_data->>'requestKey' AS request_key,request_data->>'operation' AS operation,request_data->>'fingerprint' AS fingerprint,
    length(request_data->>'prompt') AS prompt_chars,md5(request_data->>'prompt') AS prompt_md5,
    response_data->'transport' AS transport,response_data->'transportFailover' AS transport_failover,error
    FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at,id`, [requestKey])).rows
  await save('ledger.json', rows)
  summary.ledger = rows.map(({ error: _error, transport: _transport, ...row }) => row)
  return rows
}
function sceneExcerpt(candidate) {
  return (Array.isArray(candidate.scenes) ? candidate.scenes : []).map(scene => ({
    id: scene.id, title: scene.title, cast: scene.cast, purpose: scene.purpose, targetDuration: scene.targetDuration,
    beats: (Array.isArray(scene.requiredBeats) ? scene.requiredBeats : []).map(beat => ({
      id: beat.id, description: beat.description, visual: beat.observable?.visual, audio: beat.observable?.audio,
      function: beat.function, stateChange: beat.stateChange,
    })),
  }))
}
function consoleSummary(event) {
  const { scenes: _scenes, ledger: _ledger, ...compact } = summary
  const audioExamples = (summary.scenes ?? []).flatMap(scene => scene.beats.flatMap(beat =>
    (Array.isArray(beat.audio) ? beat.audio : []).map(audio => ({ sceneId: scene.id, beatId: beat.id, audio })))).slice(0, 8)
  console.log(JSON.stringify({ event, ...compact, audioExamples }, null, 2))
}

let requestKey, source, workflowHash
try {
  const row = (await pool.query('SELECT * FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  if (!row) throw Error('Current production workflow is missing')
  const writer = row.nodes.find(node => node.id === 'sanguo-scene-outline')
  if (writer?.kind !== 'text' || writer.operation !== 'history.scene-outline') throw Error('Current saved scene-outline writer must be a text node with history.scene-outline operation')
  const model = (await pool.query('SELECT * FROM model_configs WHERE id=$1', [writer.modelId])).rows[0]
  if (!model || model.capability !== 'text') throw Error('Current selected outline model must have text capability')
  collectSecrets(row); collectSecrets(model)
  source = await sourceSelection()
  collectSecrets(source.run.inputContext)
  const context = { ...structuredClone(source.run.inputContext), retry: { attempt: 1, feedback: '' }, branch: {} }
  const init = row.nodes.find(node => node.id === 'sanguo-context-init')
  const workbook = init?.uploads?.find(item => item.name === '三国历史短剧1000集策划总表.xlsx')
  if (!init?.code?.includes('episode-boundary-v1') || !workbook) {
    throw Error('Saved context-init code or attached workbook lacks the episode boundary; migrate the saved workflow before another paid writer request')
  }
  const selectedEpisode = Number(context.input?.episode_number)
  const inputReplay = await executeCodeNode({ code: init.code, prompt: init.prompt,
    context: { input: { episode_number: selectedEpisode } }, params: {}, files: [workbook] })
  const episodeBoundary = inputReplay.contextPatch?.input?.episode_boundary
  if (!parseEpisodeBoundary(episodeBoundary, selectedEpisode, context.input?.episode_title)) {
    throw Error('Saved workbook adjacent-episode boundary does not match the original source episode; stop before paid writer request')
  }
  context.input = { ...context.input, episode_boundary: episodeBoundary }
  await save('boundary-replay.json', { scope: 'read-only-saved-context-init-replay', selectedEpisode,
    sourceRecordId: source.row.id, matchedRow: inputReplay.matchedBy?.rowNumber,
    workbookFile: workbook.name, episodeBoundary, sourceRecordUntouched: true })
  // These values belong to previous drafts, not the upstream story/source task.
  // nodePromptInputContext only compacts result envelopes; it does not remove
  // failed candidates. Preserve their source snapshot in source.json instead.
  const removedDraftKeys = [writer.resultVar, 'outline_candidate', 'scene_outline', 'scene_outline_review',
    'scene_outline_accept_branch', 'approved_scene_outline'].filter(key => key && Object.hasOwn(context, key))
  for (const key of removedDraftKeys) delete context[key]
  const params = parameters(writer, context)
  const assetsResponse = await fetch(base + '/api/characters', { signal: AbortSignal.timeout(10_000) })
  if (!assetsResponse.ok) throw Error(`人物资产目录读取失败 HTTP ${assetsResponse.status}`)
  const libraryAssets = (await assetsResponse.json()).characters
  if (!Array.isArray(libraryAssets)) throw Error('人物资产目录不是数组')
  const selections = characterSelectionsForEpisode(context.input?.characterAssetSelections, selectedEpisode)
  const selectedCharacterVisuals = resolveCharacterVisualSelections(libraryAssets, workflowId, selections)
  if (selectedCharacterVisuals.length) params.selectedCharacterVisuals = selectedCharacterVisuals
  const relevantCharacters = { input: context.input, historicalSources: context.historical_sources }
  const visualCatalog = characterVisualCatalog(libraryAssets, workflowId, relevantCharacters, selectedCharacterVisuals)
  const artisticIdentityCatalog = characterArtisticIdentityCatalog(libraryAssets, workflowId, relevantCharacters)
  await save('character-catalog.json', { selectedCharacterVisuals, visualCatalog, artisticIdentityCatalog })
  const disposition = row.nodes.flatMap(node => (node.params ?? []).filter(param => (param.englishName || param.name) === 'qualityDisposition').map(param => param.value))
    .find(value => ['manual-review-v1', 'strict-v1'].includes(value))
  if (disposition) params.qualityDisposition = disposition
  const aliases = Object.fromEntries((writer.params ?? []).flatMap(param => {
    const value = params[param.englishName?.trim() || param.name]
    return param.englishName && param.englishName !== param.name ? [[param.name, value], [param.englishName, value]] : [[param.name, value]]
  }))
  const prompt = renderWorkflowTemplate(writer.prompt, nodePromptInputContext({ ...context, ...aliases, params,
    qualityDisposition: params.qualityDisposition, characterVisualCatalog: visualCatalog,
    characterArtisticIdentityCatalog: artisticIdentityCatalog, selectedCharacterVisuals,
    uploads: (writer.uploads ?? []).map(asset => asset.name) }, params.promptInputMode))
  if (!prompt.trim() || prompt.includes('[object Object]')) throw Error('Current saved outline prompt did not render correctly')
  if (row.schema_version < 149 || !writer.prompt.includes('【策划表分集边界】')
    || !context.input.episode_boundary.next.every(item => prompt.includes(item.title))) {
    throw Error('Saved outline prompt does not bind this episode and its next-row titles; stop before paid writer request')
  }
  if (row.schema_version >= 150 && !writer.prompt.includes('${characterArtisticIdentityCatalog}')) {
    throw Error('Saved schema150 outline prompt does not bind the cross-episode artistic identity catalogue')
  }
  requestKey = `dramatic-expression-outline-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  workflowHash = hash([row.nodes, row.edges, row.schema_version])
  Object.assign(summary, { sourceRecordId: source.row.id, sourceRunId: source.run.id, sourceRunStatus: source.run.status,
    workflowSchema: row.schema_version, workflowHash, writerModelId: writer.modelId,
    promptHash: hash(prompt), promptChars: prompt.length, citations: context.historical_sources.citations.length,
    selectedVisualCount: selectedCharacterVisuals.length, optionalVisualCatalogCount: visualCatalog.length,
    artisticIdentityNames: artisticIdentityCatalog.map(item => item.name),
    requestKey, qualityMode: params.qualityMode, qualityDisposition: params.qualityDisposition,
    savedPromptHasDramaticExpression: writer.prompt.includes('【影视表达与现代汉语·大纲】') })
  const { result: _result, ...sourceMetadata } = source.row
  await save('source.json', { ...sourceMetadata, sourceRunId: source.run.id, sourceRunStatus: source.run.status,
    originalInputContext: source.run.inputContext, originalInputs: source.run.inputs,
    usedInputContext: context, removedDraftKeys,
    resetRetryReason: 'A fresh outline uses saved upstream story/source context without old failure feedback, branches or downstream drafts' })
  await save('workflow-selection.json', { id: row.id, name: row.name, schemaVersion: row.schema_version, workflowHash, writer, model })
  await save('prompt.txt', prompt)
  await save('params.json', params)
  let runtime
  try {
    const response = await fetch(base + '/api/runtime-version', { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw Error(`Runtime probe HTTP ${response.status}`)
    runtime = await response.json()
  } catch (error) { runtime = { unavailable: true, error: String(error) } }
  await save('runtime.json', { expectedHistoryQualityVersion: HISTORY_QUALITY_VERSION, actual: runtime })
  summary.runtimeMatches = runtime.historyQualityVersion === HISTORY_QUALITY_VERSION
  await save('summary.json', summary)
  if (!execute) {
    consoleSummary('dry-run-ready')
  } else {
    if (!summary.runtimeMatches) throw Error('Running backend does not match current source; restart the local service before --run')
    if (!summary.savedPromptHasDramaticExpression) throw Error('Deploy the dramatic-expression prompt to the saved production workflow before --run')
    const payload = { model, prompt, params, operation: writer.operation,
      executionContext: { workflowId, workflowName: row.name, nodeId: writer.id, nodeName: writer.title, requestKey } }
    await save('request.json', { url: base + '/api/node-run', method: 'POST', body: payload })
    summary.applicationRequests = 1
    await save('summary.json', summary)
    console.log(JSON.stringify({ event: 'outline-request-started', directory, sourceRecordId: source.row.id, workflowSchema: row.schema_version, requestKey }))
    const started = Date.now()
    const providerTimeoutMs = Number(params.timeoutMs ?? model.settings?.timeoutMs ?? 180_000)
    const responseTimeoutMs = Math.max(180_000, Math.min(Number.isFinite(providerTimeoutMs) ? providerTimeoutMs : 180_000, 3_600_000)) + 120_000
    const response = await postLocalJson(base + '/api/node-run', payload, responseTimeoutMs)
    const raw = response.text
    await save('response.txt', raw)
    let result
    try { result = JSON.parse(raw) } catch { result = { unparsedBody: raw } }
    await save('response.json', result)
    Object.assign(summary, { elapsedMs: Date.now() - started, httpStatus: response.status, providerStatus: result.status })
    const rows = await ledger(requestKey)
    if (response.status < 200 || response.status >= 300 || result.status >= 400 || !Object.hasOwn(result, 'body')) {
      const failure = result.body?.error
      throw Error(`Outline request failed: HTTP ${response.status}, provider ${result.status ?? 'unknown'}`
        + (failure?.type ? `, ${failure.type}` : '') + (failure?.message ? `: ${failure.message}` : '; inspect preserved response and ledger'))
    }
    if (result.body?.routeError) throw Error(String(result.body.routeError))
    const candidate = normalizeStructuredTextOutput(result.body, extractTextResponse(result.body), 'json')
    await save('candidate.json', candidate)
    await save('scene-excerpts.json', sceneExcerpt(candidate))
    const validationIssues = []
    let validated
    const expected = { ...params, requireBeatCoverage: true, requireNarrativeClosure: true,
      requireDramaContract: writer.prompt.includes('cinematic-v1'), requireEditorialGrammar: writer.prompt.includes('editorialRole'),
      deriveInheritedStates: true, requireEpisodeBoundary: true, input: context.input, historicalSources: context.historical_sources }
    for (const [name, check] of [
      ['productionCapacityPassed', () => validateHistoricalProductionPlan(normalizeDramaOutline(candidate, expected))],
      ['historicalAgencyPassed', () => validateHistoricalAgency(normalizeDramaOutline(candidate, expected), context.historical_sources.citations)],
      ['episodeBoundaryPassed', () => validateEpisodeNarrativeBoundary(normalizeDramaOutline(candidate, expected), context.input, true)],
      ['structurePassed', () => { validated = validateHistoricalStructuredOutput(writer.operation, candidate, expected) }],
    ]) {
      try { check(); summary[name] = true } catch (error) { validationIssues.push({ check: name, issue: error instanceof Error ? error.message : String(error) }) }
    }
    await save('validation.json', { checks: { structurePassed: summary.structurePassed, productionCapacityPassed: summary.productionCapacityPassed,
      historicalAgencyPassed: summary.historicalAgencyPassed, episodeBoundaryPassed: summary.episodeBoundaryPassed }, issues: validationIssues, reviewerCalled: false, manualAcceptancePerformed: false, mediaGenerated: false })
    if (validated) await save('validated.json', validated)
    summary.validationIssues = validationIssues
    summary.sceneCount = candidate.scenes?.length
    summary.totalDuration = candidate.totalDuration
    summary.scenes = sceneExcerpt(candidate)
    summary.ledgerMatchesTextScope = rows.length > 0 && rows.every(entry => entry.capability === 'text' && entry.operation === writer.operation && entry.node_id === writer.id)
    const after = (await pool.query('SELECT nodes,edges,schema_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
    summary.workflowSnapshotUnchanged = workflowHash === hash([after.nodes, after.edges, after.schema_version])
    const afterSource = (await pool.query('SELECT xmin::text AS row_version,ctid::text AS row_location FROM execution_records WHERE id=$1', [source.row.id])).rows[0]
    summary.sourceRecordVersionUnchanged = afterSource?.row_version === source.row.row_version && afterSource?.row_location === source.row.row_location
    await save('summary.json', summary)
    if (!summary.ledgerMatchesTextScope) throw Error('No matching real text request ledger was found or an unexpected operation appeared')
    if (validationIssues.length) throw Error('New outline has deterministic validation issues; original model candidate and diagnostics are preserved')
    consoleSummary('outline-validation-completed')
  }
} catch (error) {
  summary.error = redact(error instanceof Error ? error.message : String(error))
  if (requestKey && summary.applicationRequests) {
    try { await ledger(requestKey) } catch (ledgerError) { summary.ledgerError = redact(String(ledgerError)) }
  }
  await save('summary.json', summary)
  console.error(JSON.stringify({ event: 'failed', directory, error: summary.error }))
  process.exitCode = 1
} finally { await pool.end() }
