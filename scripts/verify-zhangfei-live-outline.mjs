#!/usr/bin/env node
// Replays the saved Sanguo input, source and outline-writer path for one episode.
// Preparation is read-only; --run sends exactly one text request and never
// creates or changes an execution record. A submitted request cannot be replayed
// by this script: inspect its ledger before deciding whether to reattach.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import pg from 'pg'
import { executeCodeNode } from '../server/code-node.ts'
import { retrieveInternetSources } from '../server/web-sources.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { characterSelectionsForEpisode, resolveCharacterVisualSelections, characterVisualCatalog, characterArtisticIdentityCatalog, assertSelectedCharacterVisuals } from '../src/character-visual-workflow.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { parseEpisodeBoundary, validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'

const workflowId = 'wf-sanguo-history-drama'
const argument = name => {
  const direct = process.argv.find(value => value.startsWith(`${name}=`))
  if (direct) return direct.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const episode = Number(argument('--episode') ?? 610)
const directory = path.resolve(argument('--out') ?? `logs/dramatic-expression/live-20260928/episode-${episode}`)
const sourceFile = path.resolve(argument('--source') ?? `logs/zhangfei-source-${episode}.json`)
const execute = process.argv.includes('--run')
const refreshSources = process.argv.includes('--refresh-sources')
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc', options: '-c default_transaction_read_only=on' })
const sha = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const secrets = new Set()
function collectSecrets(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (/(?:api.?key|authorization|password|secret|access.?token)/i.test(key) && typeof item === 'string' && item) secrets.add(item)
    else collectSecrets(item)
  }
}
function redact(value) {
  if (typeof value === 'string') {
    let result = value
    for (const secret of secrets) result = result.replaceAll(secret, '[REDACTED]')
    return result.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED]')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /(?:api.?key|authorization|password|secret|access.?token)/i.test(key) ? '[REDACTED]' : redact(item)]))
  return value
}
const save = async (name, value) => {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, name), typeof value === 'string' ? redact(value) : JSON.stringify(redact(value), null, 2), { mode: 0o600 })
}
const readJson = async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
const resolved = (context, expression) => expression.trim().split('.').reduce((item, key) => item && typeof item === 'object' ? item[key] : undefined, context)
function paramValues(node, context) {
  return Object.fromEntries((node.params ?? []).map(param => {
    const template = String(param.value ?? '')
    const exact = template.trim().match(/^\$\{([^}]+)\}$/)
    let value = exact ? resolved(context, exact[1]) : renderWorkflowTemplate(template, context)
    if (!exact && param.type === 'number') value = Number(value || 0)
    if (!exact && param.type === 'boolean') value = value === 'true'
    if (!exact && param.type === 'json') {
      try { value = resolveTemplateJsonValue(JSON.parse(template || '{}'), context) }
      catch { try { value = JSON.parse(value || '{}') } catch { /* app retains invalid text */ } }
    }
    if (param.required && (value === undefined || value === null || value === '')) throw Error(`Missing production parameter: ${param.englishName || param.name}`)
    return [param.englishName?.trim() || param.name, value]
  }))
}
function paramAliases(node, params) {
  return Object.fromEntries((node.params ?? []).flatMap(param => {
    const key = param.englishName?.trim() || param.name
    return param.englishName && param.englishName !== param.name
      ? [[param.name, params[key]], [param.englishName, params[key]]] : [[param.name, params[key]]]
  }))
}
function inputValues(node) {
  return Object.fromEntries((node.params ?? []).map(param => {
    const key = param.englishName?.trim() || param.name
    const value = param.type === 'number' ? Number(param.value || 0)
      : param.type === 'boolean' ? param.value === 'true'
        : param.type === 'json' ? JSON.parse(param.value || '{}') : param.value
    return [key, key === 'episode_number' ? episode : value]
  }))
}
function postJson(urlString, body, timeoutMs = 960_000) {
  const url = new URL(urlString)
  const transport = url.protocol === 'https:' ? https : http
  const serialized = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) },
      signal: AbortSignal.timeout(timeoutMs) }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(serialized)
  })
}
function eventAnchor(episodeNumber, citation) {
  const pattern = {
    518: /飛據水斷橋|飞据水断桥/u,
    610: /飛壯而釋之|飞壮而释之/u,
    637: /飛率精卒萬餘人|飞率精卒万馀人|飛遂破郃|飞遂破郃/u,
    693: /卿刑殺既過差|卿刑杀既过差/u,
  }[episodeNumber]
  return Boolean(pattern && pattern.test(String(citation.content ?? '')))
}
function visualSelectionIssue(input, selection) {
  const eventYears = String(input.historical_period ?? '').match(/\d{3}/g)?.map(Number) ?? []
  const asOf = String(selection.visualContext?.age?.asOf ?? '')
  const portraitYear = asOf.match(/\d{3,4}/g)?.map(Number) ?? []
  const key = String(selection.visualContext?.look?.key ?? '')
  if (portraitYear.length && eventYears.length >= 2 && portraitYear.some(year => year < eventYears[0] || year > eventYears[1])) {
    return `${selection.name} 的所选三视图标注 ${asOf}，不在第 ${episode} 集 ${input.historical_period} 的时期内`
  }
  if (/changban/i.test(key) && !/张飞据水|断桥疑兵/u.test(String(input.episode_title))) {
    return `${selection.name} 的所选三视图 ${key} 属于长坂场景，本集为《${input.episode_title}》`
  }
  return ''
}
function excerpt(candidate) {
  return (Array.isArray(candidate.scenes) ? candidate.scenes : []).map(scene => ({
    id: scene.id, sequence: scene.sequence, title: scene.title, dramaticSceneId: scene.dramaticSceneId,
    editorialRole: scene.editorialRole, cast: scene.cast, purpose: scene.purpose, targetDuration: scene.targetDuration,
    beats: (Array.isArray(scene.requiredBeats) ? scene.requiredBeats : []).map(beat => ({ id: beat.id, function: beat.function,
      description: beat.description, stateChange: beat.stateChange, visual: beat.observable?.visual, audio: beat.observable?.audio })),
  }))
}

let summary = { episode, directory, sourceProvenance: refreshSources ? 'fresh-saved-node-retrieval' : 'prior-saved-node-retrieval',
  sourceFileUsed: refreshSources ? null : sourceFile, startedAt: new Date().toISOString(),
  scope: 'saved-production-input-and-outline-writer-one-real-text-call', requestCount: 0,
  executionWrites: 0, workflowWrites: 0, mediaGenerated: false, reviewerCalled: false,
  manualFilmAcceptance: false, aestheticAcceptance: false, dryRun: !execute }
try {
  if (!Number.isInteger(episode) || episode < 1 || episode > 1000) throw Error('Episode must be 1–1000')
  const workflow = (await pool.query('SELECT id,name,schema_version,nodes,edges,xmin::text as row_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  if (!workflow) throw Error('Production Sanguo workflow not found')
  const inputNode = workflow.nodes.find(node => node.id === 'sanguo-input')
  const initNode = workflow.nodes.find(node => node.id === 'sanguo-context-init')
  const writer = workflow.nodes.find(node => node.id === 'sanguo-scene-outline')
  if (!inputNode || initNode?.kind !== 'code' || writer?.operation !== 'history.scene-outline') throw Error('Saved input, context or writer node is missing')
  const model = (await pool.query('SELECT * FROM model_configs WHERE id=$1', [writer.modelId])).rows[0]
  if (model?.capability !== 'text') throw Error('Writer model has no text capability')
  collectSecrets(model)
  const upload = initNode.uploads?.find(item => item.name === '三国历史短剧1000集策划总表.xlsx')
  if (!upload) throw Error('Saved production workbook is missing')
  const attached = Buffer.from(String(upload.dataUrl).split(',')[1] ?? '', 'base64')
  const local = await fs.readFile(new URL('../public/data/三国历史短剧1000集策划总表.xlsx', import.meta.url))
  // A workbook edit is not deployed until the node's saved upload is updated.
  // Exercise that exact upload and expose drift instead of silently using a
  // newer local file or blocking unrelated episodes.
  const workbookDrift = sha(attached) !== sha(local)
  const inputDefaults = inputValues(inputNode)
  // Match App.runNode's activeInput projection. The saved node can hold
  // episode-scoped assets; only the IDs selected for this episode reach the
  // context initializer, writer, and subsequent media nodes.
  const input = { ...inputDefaults,
    characterAssetSelections: characterSelectionsForEpisode(inputDefaults.characterAssetSelections, episode) }
  const init = await executeCodeNode({ code: initNode.code, prompt: initNode.prompt, context: { input }, params: paramValues(initNode, { input }), files: [upload] })
  if (init.fields?.episode_number !== episode || init.contextPatch?.input?.episode_title !== init.fields?.episode_title) throw Error('Production context-init selected wrong episode')
  const mergedInput = { ...input, ...init.contextPatch.input }
  const episodeBoundary = parseEpisodeBoundary(mergedInput.episode_boundary, episode, mergedInput.episode_title)
  if (workflow.schema_version < 150 || !episodeBoundary || !initNode.code.includes('episode-boundary-v1')) {
    throw Error('Saved schema150 context-init lacks a verified adjacent-episode boundary')
  }
  let sources
  if (refreshSources) {
    // Keep the exact fetched-at citation bytes after a prepare/run split.
    // A second network fetch can otherwise change the prompt and accidentally
    // turn a single logical validation attempt into a new paid request.
    try { sources = (await readJson('context.json')).historical_sources } catch { /* first preparation */ }
    if (!sources) sources = await retrieveInternetSources(init.internetRequest)
  } else {
    const saved = JSON.parse(await fs.readFile(sourceFile, 'utf8'))
    if (saved.episode !== episode || Object.entries(init.fields).filter(([key]) => key !== 'episode_boundary')
      .some(([key, value]) => JSON.stringify(saved.input?.[key]) !== JSON.stringify(value))) {
      throw Error('Saved source snapshot belongs to a different production workbook row')
    }
    sources = saved.historical_sources
  }
  const eventCitations = (sources.citations ?? []).filter(citation => eventAnchor(episode, citation))
  if (!eventCitations.length) throw Error(`Historical source has no exact event anchor for episode ${episode}`)
  const context = { input: mergedInput, episode_context: init, historical_sources: sources, retry: { attempt: 1, feedback: '' }, branch: {} }
  let params = paramValues(writer, context)
  params = { ...params, qualityDisposition: mergedInput.qualityDisposition ?? params.qualityDisposition }
  const response = await fetch(base + '/api/characters', { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw Error(`Character catalogue HTTP ${response.status}`)
  const libraryAssets = (await response.json()).characters
  if (!Array.isArray(libraryAssets)) throw Error('Character catalogue is malformed')
  const selectedCharacterVisuals = resolveCharacterVisualSelections(libraryAssets, workflowId, mergedInput.characterAssetSelections)
  const visualSelectionIssues = selectedCharacterVisuals.map(selected => visualSelectionIssue(mergedInput, selected)).filter(Boolean)
  if (selectedCharacterVisuals.length) params.selectedCharacterVisuals = selectedCharacterVisuals
  const catalog = characterVisualCatalog(libraryAssets, workflowId,
    { input: mergedInput, historicalSources: sources }, selectedCharacterVisuals)
  const artisticIdentityCatalog = characterArtisticIdentityCatalog(libraryAssets, workflowId,
    { input: mergedInput, historicalSources: sources })
  if (!artisticIdentityCatalog.some(item => item.name === '张飞')
    || artisticIdentityCatalog.some(item => /208年|长坂|changban|"age"|"look"|generated\//i.test(JSON.stringify(item)))) {
    throw Error('Current artistic identity catalogue is missing Zhang Fei or leaks Changban age/costume')
  }
  const catalogSceneWarnings = catalog.filter(item => /changban/i.test(String(item.look?.key ?? ''))
    && !/张飞据水|断桥疑兵/u.test(String(mergedInput.episode_title)))
    .map(item => `${item.name} 的可选造型 ${item.look.key} 属于长坂场景，需在本集年龄和场景召回前复核`)
  const promptContext = { ...context, ...paramAliases(writer, params), params, qualityDisposition: params.qualityDisposition,
    characterVisualCatalog: catalog, characterArtisticIdentityCatalog: artisticIdentityCatalog,
    selectedCharacterVisuals, uploads: (writer.uploads ?? []).map(asset => asset.name) }
  const prompt = renderWorkflowTemplate(writer.prompt, nodePromptInputContext(promptContext, params.promptInputMode))
  if (!prompt.trim() || prompt.includes('[object Object]') || !eventCitations.some(citation => prompt.includes(citation.id))) throw Error('Current production prompt lacks bound event source')
  if (!writer.prompt.includes('${characterArtisticIdentityCatalog}')
    || !episodeBoundary.next.every(item => prompt.includes(item.title))) throw Error('Current writer lacks artistic identity or adjacent-episode boundary')
  const workflowHash = sha([workflow.nodes, workflow.edges, workflow.schema_version])
  const manifestPath = path.join(directory, 'manifest.json')
  let manifest
  try { manifest = await readJson('manifest.json') } catch { manifest = null }
  const fingerprint = { episode, workflowHash, workbookHash: sha(attached), sourceHash: sha(sources), promptHash: sha(prompt),
    paramsHash: sha(params), modelId: writer.modelId, modelConfigHash: sha(model) }
  if (manifest && sha(manifest.fingerprint) !== sha(fingerprint)) throw Error('Prepared request differs from current production state; use a new --out directory')
  if (!manifest) manifest = { createdAt: new Date().toISOString(), requestKey: `zhangfei-outline-${episode}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, fingerprint, requestStatus: 'prepared' }
  Object.assign(summary, { title: mergedInput.episode_title, historicalPeriod: mergedInput.historical_period,
    attachedWorkbookSha256: sha(attached), localWorkbookSha256: sha(local), workbookDrift,
    eventCitationIds: eventCitations.map(citation => citation.id), sourceUrls: [...new Set(sources.citations.map(citation => citation.url))],
    sourceCount: sources.count, sourceFailures: sources.failures,
    selectedCharacterVisuals: selectedCharacterVisuals.map(selected => ({ name: selected.name, assetId: selected.assetId, age: selected.visualContext.age, look: selected.visualContext.look })),
    artisticIdentityNames: artisticIdentityCatalog.map(item => item.name), artisticIdentitySourceIds: artisticIdentityCatalog.map(item => item.sourceAssetId),
    episodeBoundary: { current: episodeBoundary.current, next: episodeBoundary.next },
    visualSelectionIssues, catalogSceneWarnings, workflowSchema: workflow.schema_version, workflowHash, writerModelId: writer.modelId,
    promptHash: sha(prompt), promptChars: prompt.length, modelConfigHash: sha(model), requestKey: manifest.requestKey,
    savedPromptHasDramaticExpression: writer.prompt.includes('【影视表达与现代汉语·大纲】') })
  await save('context.json', { input: mergedInput, episode_context: init, historical_sources: sources })
  await save('character-catalog.json', { selectedCharacterVisuals, visualCatalog: catalog, artisticIdentityCatalog })
  await save('prompt.txt', prompt)
  await save('params.json', params)
  await save('manifest.json', manifest)
  await save('summary.json', summary)
  if (!execute) {
    console.log(JSON.stringify({ event: 'prepared', directory, episode, title: summary.title,
      eventCitationIds: summary.eventCitationIds, visualSelectionIssues, promptChars: prompt.length, requestKey: manifest.requestKey }))
  } else {
    if (manifest.requestStatus !== 'prepared') throw Error(`Request ${manifest.requestKey} is ${manifest.requestStatus}; inspect ledger and result before any retry`)
    if (visualSelectionIssues.length) throw Error(`Selected character visuals are episode-incompatible: ${visualSelectionIssues.join('；')}`)
    if (!summary.savedPromptHasDramaticExpression) throw Error('Dramatic expression prompt has not been deployed')
    const runtime = await fetch(base + '/api/runtime-version', { signal: AbortSignal.timeout(10_000) }).then(item => item.json())
    if (!runtime.historyQualityVersion) throw Error('Runtime version probe failed')
    const existing = (await pool.query("SELECT id,status,http_status FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at", [manifest.requestKey])).rows
    if (existing.length) throw Error('Request key already has a ledger row; inspect before reusing')
    manifest.requestStatus = 'submitted'
    manifest.submittedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    summary.requestCount = 1
    await save('summary.json', summary)
    console.log(JSON.stringify({ event: 'submitted', directory, episode, requestKey: manifest.requestKey }))
    const payload = { model, prompt, params, operation: writer.operation,
      executionContext: { workflowId, workflowName: workflow.name, nodeId: writer.id, nodeName: writer.title, requestKey: manifest.requestKey } }
    const started = Date.now()
    const result = await postJson(base + '/api/node-run', payload)
    await save('response.txt', result.text)
    let responseBody
    try { responseBody = JSON.parse(result.text) } catch { responseBody = { unparsedBody: result.text } }
    await save('response.json', responseBody)
    Object.assign(summary, { httpStatus: result.status, elapsedMs: Date.now() - started, providerStatus: responseBody.status })
    const ledger = (await pool.query(`SELECT id,channel,workflow_id,node_id,model_id,provider,capability,status,http_status,task_id,duration_ms,created_at,updated_at,
      request_data->>'requestKey' as request_key,request_data->>'operation' as operation,error
      FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at`, [manifest.requestKey])).rows
    await save('ledger.json', ledger)
    summary.ledgerCount = ledger.length
    if (result.status >= 400 || responseBody.status >= 400 || !Object.hasOwn(responseBody, 'body')) throw Error(`Outline HTTP ${result.status}, provider ${responseBody.status ?? 'unknown'}`)
    const candidate = normalizeStructuredTextOutput(responseBody.body, extractTextResponse(responseBody.body), 'json')
    await save('candidate.json', candidate)
    await save('scene-excerpts.json', excerpt(candidate))
    const expected = { ...params, requireBeatCoverage: true, requireNarrativeClosure: true,
      requireDramaContract: writer.prompt.includes('cinematic-v1'), requireEditorialGrammar: writer.prompt.includes('editorialRole'),
      requireCharacterVisuals: writer.prompt.includes('【人物年龄与场景造型·大纲】'), deriveInheritedStates: true,
      input: mergedInput, historicalSources: sources }
    const validationIssues = []
    let normalized
    try { normalized = normalizeDramaOutline(candidate, expected) } catch (error) { validationIssues.push({ check: 'normalizeDramaOutline', issue: String(error) }) }
    if (normalized) for (const [name, check] of [
      ['productionCapacity', () => validateHistoricalProductionPlan(normalized)],
      ['historicalAgency', () => validateHistoricalAgency(normalized, sources.citations)],
      ['episodeBoundary', () => validateEpisodeNarrativeBoundary(normalized, mergedInput, true)],
      ['selectedCharacterVisuals', () => assertSelectedCharacterVisuals(normalized, selectedCharacterVisuals)],
    ]) try { check() } catch (error) { validationIssues.push({ check: name, issue: String(error) }) }
    try { await save('validated.json', validateHistoricalStructuredOutput(writer.operation, candidate, expected)) }
    catch (error) { validationIssues.push({ check: 'validateHistoricalStructuredOutput', issue: String(error) }) }
    await save('validation.json', { passed: validationIssues.length === 0, issues: validationIssues,
      manualFilmAcceptance: false, aestheticAcceptance: false })
    Object.assign(summary, { validationPassed: validationIssues.length === 0, validationIssues,
      sceneCount: candidate.scenes?.length, totalDuration: candidate.totalDuration,
      dramaEvidence: { characterDramas: candidate.characterDramas, dramaticScenes: candidate.dramaticScenes, scenes: excerpt(candidate) },
      ledgerMatchesTextScope: ledger.length > 0 && ledger.every(row => row.capability === 'text' && row.node_id === writer.id && row.operation === writer.operation) })
    manifest.requestStatus = validationIssues.length ? 'completed-with-validation-issues' : 'completed'
    manifest.completedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    await save('summary.json', summary)
    if (!summary.ledgerMatchesTextScope || validationIssues.length) throw Error('Writer returned a candidate, but source/structural validation did not pass; inspect saved evidence')
    console.log(JSON.stringify({ event: 'validated', episode, directory, sceneCount: summary.sceneCount, totalDuration: summary.totalDuration,
      validationPassed: true, manualFilmAcceptance: false }))
  }
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error)
  await save('summary.json', summary)
  console.error(JSON.stringify({ event: 'failed', directory, episode, error: summary.error }))
  process.exitCode = 1
} finally { await pool.end() }
