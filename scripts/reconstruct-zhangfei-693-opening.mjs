#!/usr/bin/env node
// One broader, bounded opening-stanza text repair. The original and failed
// scene-scoped drafts remain immutable; this cannot submit a second request key.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import pg from 'pg'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { applyScopedDramaRepair } from '../src/drama-repair.ts'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'

const arg = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
const run = process.argv.includes('--run')
const originalDir = path.resolve('logs/episode693-schema151-outline-20260928')
const failedDir = path.resolve('logs/episode693-schema152-bounded-revision-20260928-v1')
const currentDir = path.resolve('logs/episode693-schema153-open-revision-preflight-20260928')
const directory = path.resolve(arg('--out') ?? 'logs/episode693-schema153-opening-reconstruction-20260928-v1')
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

try {
  const [original, failed, currentContext, currentPrompt, currentParams, currentManifest,
    originalManifest, failedManifest] = await Promise.all([
    load(originalDir, 'candidate.json'), load(failedDir, 'raw-candidate.json'), load(currentDir, 'context.json'),
    fs.readFile(path.join(currentDir, 'prompt.txt'), 'utf8'), load(currentDir, 'params.json'),
    load(currentDir, 'manifest.json'), load(originalDir, 'manifest.json'), load(failedDir, 'manifest.json'),
  ])
  // The failed draft is provenance only; the original is the sole trusted base.
  if (originalManifest.requestStatus !== 'completed' || failedManifest.requestStatus !== 'submitted'
    || currentManifest.requestStatus !== 'prepared') {
    throw Error('Prior drafts or current preflight are incomplete')
  }
  const originalCitation = originalManifest.fingerprint.sourceHash
  if (!originalCitation || currentContext.historical_sources.citations.length !== 1
    || currentContext.historical_sources.citations[0].id !== 'web-bb704118d82c7a47'
    || !/先主常戒之曰/u.test(currentContext.historical_sources.citations[0].content)
    || !/帳下將張達、范彊殺飛/u.test(currentContext.historical_sources.citations[0].content)
    || currentContext.input.episode_boundary.next[0]?.title !== '帐下行刺') {
    throw Error('Current direct source or adjacent-episode boundary is missing')
  }
  const workflow = (await pool.query('SELECT id,name,schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  const workflowHash = sha([workflow.nodes, workflow.edges, workflow.schema_version])
  const writer = workflow.nodes.find(node => node.id === 'sanguo-scene-outline')
  const model = writer && (await pool.query('SELECT * FROM model_configs WHERE id=$1', [writer.modelId])).rows[0]
  if (workflowHash !== currentManifest.fingerprint.workflowHash || workflow.schema_version !== 153
    || writer?.operation !== 'history.scene-outline' || model?.capability !== 'text'
    || sha(model) !== currentManifest.fingerprint.modelConfigHash
    || sha(currentPrompt) !== currentManifest.fingerprint.promptHash || sha(currentParams) !== currentManifest.fingerprint.paramsHash) {
    throw Error('Current saved schema153 writer/configuration differs from exact preflight; stop before paid call')
  }
  const originalCompact = Object.fromEntries(Object.entries(original).filter(([key]) => !['raw', 'text', 'model', 'count'].includes(key)))
  const feedback = { scope: 'episode', repairScope: 'episode', episodeRewriteCount: 1,
    previousCandidate: originalCompact, historicalLocks: original.historicalLocks,
    failedAttempt: { requestKey: failedManifest.requestKey, lesson: '先前只改局部场景时模型把 scene-02 从 drama-02 改进 drama-03，越过既定 scene scope；又以松散行囊起头，人物冲突依然迟到。该稿仅作失败证据，不作为新稿基础。' },
    issues: [
      { itemId: 'scene-01', code: 'opening_dramatic_cause',
        problem: '原稿先用城址高亮，新失败稿改成扎行囊，仍没有让观众立即看见严刑与受罚者近身任事的真实矛盾。',
        repair: '从历史来源允许的先前不定时告诫场合切入：刘备当场看见受罚军士仍在张飞左右任事，或张飞正在坚持这一做法；用受罚者的身体处境与刘备的可见顾虑提出冲突，尽早让张飞实际回应。不得把匿名军士命名或指认成后集刺客，不虚构确证会面年月地点；不从搬行囊、空帐、形式地图开场。' },
      { itemId: 'scene-02', code: 'opening_progression',
        problem: '开场之后若仍只是说明“此前”或重复站位，人物戏没有新增压力、选择或回应。',
        repair: '让 scene-02 承接 scene-01 的具体顾虑并产生新反应，可与 scene-01 或 scene-03 在同一完整戏组重新归属；时间转场用当事人的动作与必要一句标明，不单独拍空景。' },
      { itemId: 'scene-03', code: 'opening_confrontation',
        problem: '原告诫问答到第三场才开始，须把开场目击的问题接成明确对质，不能让第三场重复前两场说过的句子。',
        repair: '允许调整 scene-01–03 的完整戏归属、人物状态与相邻承接，保留刘备告诫张飞刑罚过重、鞭打军士且让受罚者近身的实质；scene-04 的追问及 scene-05–06 的回应必须顺着前面新压力继续成立，不重演已完成的劝诫。' },
    ],
    instruction: '仅重构 scene-01、scene-02、scene-03 三个已命名场景及其必要的开场元数据；三个 id 均保留。scene-04 到 scene-11 的每个场景对象逐字保持原候选，不改时长、对白、声画、人物、归属或序号；drama-04、drama-05 的原有终态与史实/分集边界也保持。其他情节尤其后集行刺不得出现。输出完整 cinematic-v1 JSON。' }
  const prompt = currentPrompt + renderRetryFeedbackPrompt(feedback)
  if (!prompt.includes('本作当前选用的跨集人物艺术身份') || prompt.toLowerCase().includes('changban')
    || !currentContext.input.episode_boundary.next.every(item => prompt.includes(item.title))) {
    throw Error('Rendered repair prompt lacks artistic identity, age scope, or adjacent boundary')
  }
  const fingerprint = { workflowHash, writerHash: sha(writer), modelConfigHash: sha(model), currentPromptHash: sha(currentPrompt),
    originalCandidateHash: sha(original), failedCandidateHash: sha(failed), sourceHash: sha(currentContext.historical_sources),
    feedbackHash: sha(feedback), repairPromptHash: sha(prompt), paramsHash: sha(currentParams) }
  let manifest
  try { manifest = await load(directory, 'manifest.json') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (manifest && sha(manifest.fingerprint) !== sha(fingerprint)) throw Error('Opening reconstruction preflight drifted; use a new directory')
  if (!manifest) manifest = { createdAt: new Date().toISOString(),
    requestKey: `zhangfei-opening-repair-693-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    requestStatus: 'prepared', fingerprint }
  const existing = (await pool.query("SELECT id,status,http_status FROM model_execution_records WHERE request_data->>'requestKey'=$1", [manifest.requestKey])).rows
  await save('manifest.json', manifest)
  await save('feedback.json', feedback)
  await save('prompt.txt', prompt)
  await save('preflight.json', { schema: workflow.schema_version, rowVersion: workflow.row_version, workflowHash,
    requestKey: manifest.requestKey, existingLedgerCount: existing.length, requestStatus: manifest.requestStatus,
    originalCandidateHash: sha(original), failedCandidateHash: sha(failed), sourceCitationId: currentContext.historical_sources.citations[0].id,
    targetSceneIds: ['scene-01', 'scene-02', 'scene-03'], preservedSceneIds: original.scenes.slice(3).map(scene => scene.id),
    promptHash: sha(prompt), mediaGenerated: false, workflowWrites: 0, executionWrites: 0 })
  if (!run) {
    console.log(JSON.stringify({ event: 'prepared', directory, requestKey: manifest.requestKey,
      schema: workflow.schema_version, promptChars: prompt.length }))
  } else {
    if (manifest.requestStatus !== 'prepared' || existing.length) throw Error('Opening repair already submitted; never auto-retry')
    manifest.requestStatus = 'submitted'
    manifest.submittedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'submitted', directory, requestKey: manifest.requestKey }))
    const result = await postJson(base + '/api/node-run', { model, prompt, params: currentParams, operation: writer.operation,
      executionContext: { workflowId: workflow.id, workflowName: workflow.name,
        nodeId: writer.id, nodeName: writer.title, requestKey: manifest.requestKey } })
    await save('response.txt', result.text)
    let response
    try { response = JSON.parse(result.text) } catch { response = { unparsedBody: result.text } }
    await save('response.json', { httpStatus: result.httpStatus, ...response })
    const ledger = (await pool.query("SELECT id,status,http_status,capability,node_id,request_data->>'operation' AS operation,request_data->>'requestKey' AS request_key FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at", [manifest.requestKey])).rows
    await save('ledger.json', ledger)
    if (result.httpStatus !== 200 || response.status !== 200 || ledger.length !== 1 || ledger[0].capability !== 'text'
      || ledger[0].node_id !== writer.id) throw Error('Opening writer response or ledger is incomplete')
    const rawCandidate = normalizeStructuredTextOutput(response.body, extractTextResponse(response.body), 'json')
    await save('raw-candidate.json', rawCandidate)
    const candidate = applyScopedDramaRepair(rawCandidate, feedback, {})
    await save('candidate.json', candidate)
    const expected = { ...currentParams, requireBeatCoverage: true, requireNarrativeClosure: true,
      requireDramaContract: true, requireEditorialGrammar: true, requireCharacterVisuals: true, deriveInheritedStates: true,
      input: currentContext.input, historicalSources: currentContext.historical_sources }
    const checks = []
    const collect = (name, check) => { try { check() } catch (error) { checks.push({ name, error: String(error) }) } }
    let normalized
    collect('normalizeDramaOutline', () => { normalized = normalizeDramaOutline(candidate, expected) })
    if (normalized) {
      collect('productionCapacity', () => validateHistoricalProductionPlan(normalized))
      collect('historicalAgency', () => validateHistoricalAgency(normalized, currentContext.historical_sources.citations))
      collect('episodeBoundary', () => validateEpisodeNarrativeBoundary(normalized, currentContext.input, true))
    }
    collect('structuredOutput', () => validateHistoricalStructuredOutput(writer.operation, candidate, expected))
    const oldScenes = new Map(original.scenes.map(scene => [scene.id, scene]))
    const changedSceneIds = candidate.scenes.filter(scene => sha(scene) !== sha(oldScenes.get(scene.id))).map(scene => scene.id)
    const sceneIdsPreserved = candidate.scenes.length === original.scenes.length
      && candidate.scenes.every((scene, index) => scene.id === original.scenes[index].id)
    const laterScenesUnchanged = candidate.scenes.slice(3).every((scene, index) => sha(scene) === sha(original.scenes[index + 3]))
    const laterDramasUnchanged = ['drama-04', 'drama-05'].every(id => sha(candidate.dramaticScenes.find(item => item.id === id))
      === sha(original.dramaticScenes.find(item => item.id === id)))
    const sourceBoundsUnchanged = sha(candidate.historicalLocks) === sha(original.historicalLocks)
      && sha(candidate.adaptationSpace) === sha(original.adaptationSpace)
      && sha(candidate.episodeDrama.payoff) === sha(original.episodeDrama.payoff)
    const boundedPassed = sceneIdsPreserved && laterScenesUnchanged && laterDramasUnchanged && sourceBoundsUnchanged
    await save('validation.json', { staticPassed: checks.length === 0, checks, boundedPassed, sceneIdsPreserved,
      laterScenesUnchanged, laterDramasUnchanged, sourceBoundsUnchanged, changedSceneIds,
      expectedChangedSceneIds: ['scene-01', 'scene-02', 'scene-03'], mediaGenerated: false, humanDramaticAcceptance: false })
    const after = (await pool.query('SELECT schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1',
      [workflow.id])).rows[0]
    await save('postflight.json', { schema: after.schema_version, rowVersion: after.row_version,
      workflowHash: sha([after.nodes, after.edges, after.schema_version]),
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash,
      requestKey: manifest.requestKey, ledgerCount: ledger.length, mediaGenerated: false })
    manifest.requestStatus = 'completed'
    manifest.completedAt = new Date().toISOString()
    await save('manifest.json', manifest)
    console.log(JSON.stringify({ event: 'reconstructed', directory, requestKey: manifest.requestKey,
      staticPassed: checks.length === 0, boundedPassed, changedSceneIds,
      workflowUnchanged: sha([after.nodes, after.edges, after.schema_version]) === workflowHash }))
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'failed', directory, error: String(error) }))
  process.exitCode = 1
} finally { await pool.end() }
