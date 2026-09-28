#!/usr/bin/env node
// One paid writer request for a bounded editorial repair of a preserved outline.
// It never writes the workflow or a UI execution record, and never auto-retries.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import pg from 'pg'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { applyScopedDramaRepair, attachDramaRepairProvenance } from '../src/drama-repair.ts'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'

const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
const episode = Number(arg('--episode'))
if (![637, 693].includes(episode)) throw Error('Use --episode=637 or --episode=693')
const execute = process.argv.includes('--run')
const sourceDir = path.resolve(`logs/episode${episode}-schema151-outline-20260928`)
const reviewDir = path.join(sourceDir, 'refreshed-text-review-post-media-cas')
const directory = path.resolve(arg('--out') ?? `logs/episode${episode}-schema152-bounded-revision-20260928-v1`)
const backupPath = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop4-media/media-review-gate-refresh-dry-20260928-v1/backup-private.json')
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: '-c default_transaction_read_only=on' })
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const load = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
const save = async (name, value) => {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 })
}
function postJson(urlString, body, timeoutMs = 960_000) {
  const url = new URL(urlString), transport = url.protocol === 'https:' ? https : http
  const serialized = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serialized) }, signal: AbortSignal.timeout(timeoutMs) }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ httpStatus: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(serialized)
  })
}
function editorialIssues(report) {
  const warning = itemId => report.warnings.find(item => item.itemId === itemId)
  if (episode === 637) return [
    { itemId: 'scene-01', code: 'editorial_map_causality', evidence: warning('scene-01'),
      problem: '原地图只有汉中到巴西箭头，未把张郃欲徙民往汉中、张飞抵拒、狭山道令前后不相救的空间因果讲清。',
      repair: '保留二维古代历史地理地图与本集信息开场；只用史源支持的汉中/巴西相对位置、迁民意图、双方大致方位与狭道制约，让地图为后续张飞选择他道邀击提供必要空间理解。不可伪造精准道路、城址坐标或现代边界；不要在张飞作决定前先演完他的改道。' },
    { itemId: 'scene-04', code: 'editorial_repeated_bridge', evidence: warning('scene-04'),
      problem: '行军旁白重复第三场已说的一万余精兵/他道/截击，且第五场又呈现侧路到场。',
      repair: '保留 scene-04 的场景 id 与简短改道行动，使狭道或接敌压力可见，避免重复口述已确立命令；其独立时长应收紧，过渡到 scene-05 不再重演同一动作。' },
    { itemId: 'scene-11', code: 'unsupported_exact_count',
      evidence: { quote: '张郃與十二名親兵沿陡坡排成短隊', sourceQuote: '郃棄馬緣山，獨與麾下十餘人從間道退' },
      problem: '候选把卷36“十餘人”写成“十二名亲兵”，把约数误作精确史载数。',
      repair: '保留弃马缘山与从间道退的动作和张郃主体，把确定数字改回十余人的史源精度；镜头可有有限群演，但不能声称历史恰好十二人。' },
  ]
  return [
    { itemId: 'scene-01', code: 'editorial_map_without_cause', evidence: warning('scene-01'),
      problem: '阆中单一城址高亮没有推动治兵因果，且人物冲突在地图和空帐两段之后才开始。',
      repair: '本集地理关系对治兵矛盾并非必要；保留本集时地、伐吴备兵和先前告诫的史实边界，从出兵前有压力/选择的张飞或刘备真人行动开场。不要为保留地图硬造线路或事件，不提前演出后集行刺。' },
    { itemId: 'scene-02', code: 'editorial_empty_flashback_bridge', evidence: warning('scene-02'),
      problem: '无人帐幕与“先回到此前”只讲回溯，未增加人物压力或行动。',
      repair: '保留 scene-02 id 与此前多次告诫、具体会面时地未载的边界；用人物可见行动或相互反应引入 scene-03 现有刘备告诫，避免独立空景及解释性旁白。不要重复 scene-03 的原对白。' },
    { itemId: 'scene-07', code: 'editorial_static_return', evidence: warning('scene-07'),
      problem: '行囊卷席静物配旁白传递返回阆中、率万人会江州的信息，下一场已经有人物行动。',
      repair: '保留 scene-07 id、当下阆中与万人将会江州且尚未出发的史实；以张飞或军士在实际备兵中面对具体任务/压力来承接时间转换，并接上 scene-08 的处罚及近身任事。避免仅靠静物和旁白，不发明后集行刺或具体涉案军士身份。' },
  ]
}

try {
  const [candidate, context, sourceManifest, sourceParams, originalPrompt, review, reviewManifest, backup] = await Promise.all([
    load(sourceDir, 'candidate.json'), load(sourceDir, 'context.json'), load(sourceDir, 'manifest.json'),
    load(sourceDir, 'params.json'), fs.readFile(path.join(sourceDir, 'prompt.txt'), 'utf8'),
    load(reviewDir, 'report.json'), load(reviewDir, 'manifest.json'), load(path.dirname(backupPath), path.basename(backupPath)),
  ])
  if (sourceManifest.requestStatus !== 'completed' || reviewManifest.requestStatus !== 'completed'
    || review.decision !== 'pass' || !Array.isArray(review.warnings) || sha(backup.row) !== backup.hash
    || sha([backup.row.nodes, backup.row.edges, backup.row.schema_version]) !== sourceManifest.fingerprint.workflowHash
    || sha(originalPrompt) !== sourceManifest.fingerprint.promptHash || sha(sourceParams) !== sourceManifest.fingerprint.paramsHash) {
    throw Error('Original writer or reviewer evidence is incomplete or changed')
  }
  const workflow = (await pool.query('SELECT id,name,schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  if (workflow.schema_version !== 152) throw Error('Saved workflow is no longer schema152; re-preflight in a fresh output directory')
  const writer = workflow.nodes.find(node => node.id === 'sanguo-scene-outline')
  const oldWriter = backup.row.nodes.find(node => node.id === writer?.id)
  if (!writer || sha(writer) !== sha(oldWriter) || writer.operation !== 'history.scene-outline') {
    throw Error('Production outline writer changed since preserved candidate')
  }
  const model = (await pool.query('SELECT * FROM model_configs WHERE id=$1', [writer.modelId])).rows[0]
  if (model?.capability !== 'text' || sha(model) !== sourceManifest.fingerprint.modelConfigHash) {
    throw Error('Production outline writer model changed since preserved candidate')
  }
  const compactCandidate = Object.fromEntries(Object.entries(candidate).filter(([key]) => !['raw', 'text', 'model', 'count'].includes(key)))
  const issues = editorialIssues(review)
  if (issues.some(item => !candidate.scenes.some(scene => scene.id === item.itemId) || (item.code !== 'unsupported_exact_count' && !item.evidence))) {
    throw Error('Editorial repair issue does not bind the preserved candidate/review')
  }
  const feedback = { scope: 'scene', repairScope: 'scene', previousCandidate: compactCandidate,
    historicalLocks: candidate.historicalLocks, episodeRewriteCount: 0, issues,
    instruction: '只改 issues 点名的场景及其直接因果承接；其余场景的 id、声画义务、人物关系、历史结果与分集边界保持原样。输出完整 cinematic-v1 JSON，不修改后集剧情。' }
  const prompt = originalPrompt + renderRetryFeedbackPrompt(feedback)
  const workflowHash = sha([workflow.nodes, workflow.edges, workflow.schema_version])
  const fingerprint = { episode, workflowHash, writerNodeHash: sha(writer), modelConfigHash: sha(model),
    sourceCandidateHash: sha(candidate), sourceHash: sha(context.historical_sources), sourcePromptHash: sha(originalPrompt),
    reviewHash: sha(review), repairPromptHash: sha(prompt), paramsHash: sha(sourceParams), feedbackHash: sha(feedback) }
  let manifest
  try { manifest = await load(directory, 'manifest.json') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (manifest && sha(manifest.fingerprint) !== sha(fingerprint)) throw Error('Prepared repair drifted; use a new output directory')
  if (!manifest) manifest = { createdAt: new Date().toISOString(),
    requestKey: `zhangfei-bounded-repair-${episode}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    requestStatus: 'prepared', fingerprint }
  const existing = (await pool.query("SELECT id,status,http_status FROM model_execution_records WHERE request_data->>'requestKey'=$1", [manifest.requestKey])).rows
  await save('manifest.json', manifest)
  await save('repair-feedback.json', feedback)
  await save('prompt.txt', prompt)
  await save('preflight.json', { episode, sourceCandidateHash: sha(candidate), sourceReviewHash: sha(review),
    sourceCitationIds: context.historical_sources.citations.map(item => item.id),
    adjacentTitles: context.input.episode_boundary.next.map(item => item.title),
    schema: workflow.schema_version, rowVersion: workflow.row_version, workflowHash, writerNodeHash: sha(writer),
    requestKey: manifest.requestKey, requestStatus: manifest.requestStatus, existingLedgerCount: existing.length,
    targetSceneIds: issues.map(item => item.itemId), promptHash: sha(prompt), mediaGenerated: false,
    executionWrites: 0, workflowWrites: 0 })
  if (!execute) {
    console.log(JSON.stringify({ event: 'prepared', episode, directory, requestKey: manifest.requestKey,
      schema: workflow.schema_version, targetSceneIds: issues.map(item => item.itemId), promptChars: prompt.length }))
  } else {
    if (manifest.requestStatus !== 'prepared' || existing.length) throw Error('Repair already submitted; inspect ledger, never auto-retry')
    manifest.requestStatus = 'submitted'
    manifest.submittedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'submitted', episode, directory, requestKey: manifest.requestKey }))
    const result = await postJson(base + '/api/node-run', { model, prompt, params: sourceParams, operation: writer.operation,
      executionContext: { workflowId: workflow.id, workflowName: workflow.name,
        nodeId: writer.id, nodeName: writer.title, requestKey: manifest.requestKey } })
    await save('response.txt', result.text)
    let response
    try { response = JSON.parse(result.text) } catch { response = { unparsedBody: result.text } }
    await save('response.json', { httpStatus: result.httpStatus, ...response })
    const ledger = (await pool.query("SELECT id,status,http_status,capability,node_id,request_data->>'operation' AS operation,request_data->>'requestKey' AS request_key FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at", [manifest.requestKey])).rows
    await save('ledger.json', ledger)
    if (result.httpStatus !== 200 || response.status !== 200 || ledger.length !== 1
      || ledger[0].capability !== 'text' || ledger[0].node_id !== writer.id) throw Error('Writer response or ledger is incomplete')
    const rawCandidate = normalizeStructuredTextOutput(response.body, extractTextResponse(response.body), 'json')
    await save('raw-candidate.json', rawCandidate)
    const scoped = attachDramaRepairProvenance(applyScopedDramaRepair(rawCandidate, feedback, {}), feedback, 2)
    await save('scoped-candidate.json', scoped)
    const expected = { ...sourceParams, requireBeatCoverage: true, requireNarrativeClosure: true,
      requireDramaContract: writer.prompt.includes('cinematic-v1'), requireEditorialGrammar: writer.prompt.includes('editorialRole'),
      requireCharacterVisuals: writer.prompt.includes('【人物年龄与场景造型·大纲】'), deriveInheritedStates: true,
      input: context.input, historicalSources: context.historical_sources }
    const checks = []
    const collect = (name, check) => { try { check() } catch (error) { checks.push({ name, error: String(error) }) } }
    let normalized
    collect('normalizeDramaOutline', () => { normalized = normalizeDramaOutline(scoped, expected) })
    if (normalized) {
      collect('productionCapacity', () => validateHistoricalProductionPlan(normalized))
      collect('historicalAgency', () => validateHistoricalAgency(normalized, context.historical_sources.citations))
      collect('episodeBoundary', () => validateEpisodeNarrativeBoundary(normalized, context.input, true))
    }
    collect('structuredOutput', () => validateHistoricalStructuredOutput(writer.operation, scoped, expected))
    const targetIds = new Set(issues.map(item => item.itemId))
    const originalScenes = new Map(candidate.scenes.map(scene => [scene.id, scene]))
    const untouchedChanged = scoped.scenes.filter(scene => !targetIds.has(scene.id)
      && sha(scene) !== sha(originalScenes.get(scene.id)))
    const targetChanges = scoped.scenes.filter(scene => targetIds.has(scene.id)
      && sha(scene) !== sha(originalScenes.get(scene.id))).map(scene => scene.id)
    await save('validation.json', { passed: checks.length === 0 && untouchedChanged.length === 0,
      checks, originalSceneCount: candidate.scenes.length, scopedSceneCount: scoped.scenes.length,
      targetChanges, untouchedChanged: untouchedChanged.map(scene => scene.id),
      automaticMediaAcceptance: false, humanDramaticAcceptance: false })
    const after = (await pool.query('SELECT schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
      [workflow.id])).rows[0]
    await save('postflight.json', { schema: after.schema_version, rowVersion: after.row_version,
      workflowHash: sha([after.nodes, after.edges, after.schema_version]),
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash,
      requestKey: manifest.requestKey, ledgerCount: ledger.length, mediaGenerated: false })
    manifest.requestStatus = 'completed'
    manifest.completedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'revised', episode, directory, requestKey: manifest.requestKey,
      validationPassed: checks.length === 0 && untouchedChanged.length === 0,
      targetChanges, untouchedChanged: untouchedChanged.map(scene => scene.id),
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash }))
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'failed', episode, directory, error: String(error) }))
  process.exitCode = 1
} finally { await pool.end() }
