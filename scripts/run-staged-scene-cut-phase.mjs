#!/usr/bin/env node
// A paid POST is explicit. A local submit intent is written first; if its
// acknowledgement is lost, retries refuse to POST and require task recovery.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { fetchModelEndpoint, klingAuthorization, resolveKlingOmniVideoEndpoint } from '../server/model-adapters.ts'
import { previewStageARequest, previewStageBRequest, readStagedSceneCutManifest,
  readStageTaskReceipt, readStageMediaReceipt, saveStageTaskReceipt,
  saveStageMediaReceipt } from '../server/staged-scene-cut.mjs'

const fail = message => { throw Error(`STAGED_PHASE_RUNNER_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') { options.apply = true; continue }
  const key = { '--plan-id': 'planId', '--phase': 'phase', '--expected-request-sha256': 'expectedRequestSha256',
    '--expected-model-id': 'expectedModelId', '--expected-endpoint-sha256': 'expectedEndpointSha256' }[args[i]]
  if (!key || !args[i + 1] || options[key]) fail(`invalid or repeated ${args[i]}`)
  options[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '') || !['A', 'B'].includes(options.phase))
  fail('signed plan ID and phase A/B required')
if (options.expectedRequestSha256 && !/^[a-f0-9]{64}$/.test(options.expectedRequestSha256))
  fail('expected request SHA-256 invalid')
if (options.apply && (!options.expectedRequestSha256 || !options.expectedModelId
  || !/^[a-f0-9]{64}$/.test(options.expectedEndpointSha256 ?? '')))
  fail('--apply requires reviewed request SHA-256, model ID and endpoint SHA-256')
const root = process.cwd(), directory = path.join(root, '.runtime/staged-scene-cut', options.planId)
if (options.phase === 'A' && existsSync(path.join(directory, 'phase-A-failure.json')))
  fail('this paid A task has a signed terminal failure; only its single source-bound retry fork may submit again')
const manifest = await readStagedSceneCutManifest(options.planId, root)
const { phaseAPreview: _preview, signature: _signature, ...binding } = manifest
void _preview; void _signature
const firstGuide = manifest.guides[String(manifest.phases[0].guideFrame)].url
const secondGuide = manifest.guides['312'].url
const stagedGuideBytes = await Promise.all([firstGuide, secondGuide].map(url =>
  readFile(path.join(root, 'public', url.slice(1)))))
const plan = { ...binding, stagedGuideBytes }
const preview = options.phase === 'A'
  ? await previewStageARequest(plan, root, true)
  : await previewStageBRequest(options.planId, root, true)
if (preview.requestSha256 !== (options.expectedRequestSha256 ?? preview.requestSha256))
  fail('request changed since reviewed preflight')
if (options.phase === 'A' && preview.requestSha256 !== manifest.phaseAPreview?.requestSha256)
  fail('phase A request differs from immutable signed manifest')
const { request, ...safePreview } = preview
if (request.model_name !== 'kling-v3-omni' || request.sound !== 'off')
  fail('paid request model or source-audio policy changed')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let model
try {
  const result = await db.query('select result,md5(result::text) as result_md5 from execution_records where id=$1',
    [manifest.sourceRecordId])
  if (result.rows.length !== 1 || result.rows[0].result_md5 !== manifest.sourceResultMd5)
    fail('source execution changed')
  const state = decodeExecutionState(result.rows[0].result)
  if (state.nodeRuns?.[50]?.output?.shotSha256 !== manifest.approvedShotSha256
    || state.nodeRuns?.[52]?.status !== 'success'
    || state.nodeRuns?.[58]?.output?.decision !== 'revise')
    fail('source approval/rejected-video state changed')
  const workflow = (await db.query('select nodes from workflow_configs where id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  const node = workflow?.nodes?.find(value => value.id === 'sanguo-video')
  model = node && (await db.query('select id,provider,capability,settings from model_configs where id=$1',
    [node.modelId])).rows[0]
  if (model?.provider !== 'Kling' || model?.capability !== 'video'
    || !model.settings?.endpoint || options.apply && model.id !== options.expectedModelId)
    fail('configured paid video model changed')
} finally { await db.end() }

const endpoint = resolveKlingOmniVideoEndpoint(model.settings.endpoint)
const endpointSha256 = createHash('sha256').update(endpoint).digest('hex')
if (manifest.providerLock && (model.id !== manifest.providerLock.modelId
  || endpointSha256 !== manifest.providerLock.endpointSha256))
  fail('configured provider differs from signed plan model/endpoint lock')
if (options.apply && endpointSha256 !== options.expectedEndpointSha256)
  fail('paid provider endpoint changed since reviewed preflight')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only', planId: options.planId,
    sourceRecordId: manifest.sourceRecordId, sourceResultMd5: manifest.sourceResultMd5,
    ...safePreview, modelId: model.id, endpointSha256,
    providerCalls: 0, databaseWrites: 0 }, null, 2))
  process.exit(0)
}
const headers = { 'content-type': 'application/json', authorization: klingAuthorization(model.settings) }
const intentPath = path.join(directory, `phase-${options.phase}-submit-intent.json`)
let task
try { task = await readStageTaskReceipt(options.planId, options.phase, root) }
catch (error) { if (error.code !== 'ENOENT') throw error }
let intent
try { intent = JSON.parse(await readFile(intentPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (task && intent && (intent.planId !== options.planId || intent.phase !== options.phase
  || intent.requestSha256 !== task.requestSha256 || intent.endpoint !== endpoint
  || intent.modelId && intent.modelId !== model.id
  || task.providerModelId && task.providerModelId !== model.id
  || task.endpointSha256 && task.endpointSha256 !== endpointSha256))
  fail('existing paid submit intent and task receipt disagree')
if (!task && !intent) {
  intent = { version: 'staged-paid-submit-intent-v1', planId: options.planId, phase: options.phase,
    requestSha256: preview.requestSha256, modelId: model.id, endpoint,
    endpointSha256, createdAt: new Date().toISOString(), nonce: randomUUID() }
  await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const response = await fetchModelEndpoint(endpoint, { method: 'POST', headers,
    body: JSON.stringify(request), signal: AbortSignal.timeout(180000) })
  const body = await response.json()
  const taskId = body?.data?.task_id
  if (!response.ok || !/^[\w-]{8,128}$/.test(String(taskId ?? '')))
    fail(`paid POST did not yield a recoverable task ID; intent is locked (HTTP ${response.status})`)
  task = await saveStageTaskReceipt(options.planId, { phase: options.phase, taskId,
    requestSha256: preview.requestSha256, providerModelId: model.id,
    endpointSha256, submittedAt: new Date().toISOString() }, root)
} else if (!task) {
  if (intent.planId !== options.planId || intent.phase !== options.phase
    || intent.requestSha256 !== preview.requestSha256 || intent.endpoint !== endpoint)
    fail('existing paid submit intent differs; no second POST allowed')
  fail('paid POST may have succeeded without an archived task ID; automatic recovery is blocked pending provider request-account proof')
}

let media
try { media = await readStageMediaReceipt(options.planId, options.phase, root) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!media) {
  let result
  for (let poll = 0; poll < 600; poll++) {
    const response = await fetchModelEndpoint(`${endpoint}/${encodeURIComponent(task.taskId)}`,
      { method: 'GET', headers, signal: AbortSignal.timeout(180000) })
    result = await response.json()
    if (!response.ok) fail(`task ${task.taskId} query HTTP ${response.status}; resume same task later`)
    if (result?.data?.task_id !== task.taskId)
      fail(`task ${task.taskId} query returned a different provider task ID`)
    if (result?.data?.model_name && result.data.model_name !== request.model_name)
      fail(`task ${task.taskId} result model differs from paid request`)
    if (result?.data?.task_status === 'succeed' || result?.data?.task_status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  if (result?.data?.task_status !== 'succeed')
    fail(`task ${task.taskId} not successful (${result?.data?.task_status ?? 'timeout'}); no second POST allowed`)
  const remoteUrl = result.data.task_result?.videos?.[0]?.url
    ?? result.data.task_result?.videos?.[0]?.video_url
  if (typeof remoteUrl !== 'string' || !/^https:\/\//.test(remoteUrl)) fail('successful provider task lacks HTTPS video')
  const response = await fetchModelEndpoint(remoteUrl, { signal: AbortSignal.timeout(180000) })
  if (!response.ok) fail(`video archive fetch HTTP ${response.status}; resume same task later`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 10000) fail('provider video archive too short')
  const videoUrl = `/generated/staged-phase-${options.phase}-${task.taskId}.mp4`
  const filename = path.join(root, 'public', videoUrl.slice(1))
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      fail('existing archived task video differs')
  }
  const videoSha256 = createHash('sha256').update(bytes).digest('hex')
  media = await saveStageMediaReceipt(options.planId, options.phase,
    { taskId: task.taskId, videoUrl, videoSha256 }, root)
}
console.log(JSON.stringify({ mode: 'paid-task-archived', planId: options.planId, phase: options.phase,
  taskId: task.taskId, requestSha256: task.requestSha256, media,
  next: 'native-frame and independent visual review required before stage acceptance' }, null, 2))
