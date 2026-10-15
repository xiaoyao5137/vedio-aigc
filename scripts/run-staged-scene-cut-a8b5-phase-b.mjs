#!/usr/bin/env node
// Guarded B-only provider runner. It cannot submit A, accept either stage,
// compose the shot, or issue a second POST after a write-once intent.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { fetchModelEndpoint, klingAuthorization, resolveKlingOmniVideoEndpoint } from '../server/model-adapters.ts'
import { previewA8B5PhaseB, readA8B5Plan, readA8B5ProvisionalReview,
  readA8B5BRejection, readA8B5BTask, readA8B5BMedia, saveA8B5BTask, saveA8B5BMedia,
  saveA8B5TerminalFailure } from '../server/staged-scene-cut-a8b5.mjs'
import { previewA8B5RetryRequestFromSignedManifest } from
  '../server/staged-scene-cut-a8b5-retry.mjs'

const INVALID = message => { throw Error(`STAGED_A8B5_B_RUNNER_INVALID: ${message}`) }
const SHA = /^[a-f0-9]{64}$/
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (options.apply) INVALID('duplicate --apply')
    options.apply = true
    continue
  }
  const field = { '--plan-id': 'planId', '--expected-request-sha256': 'expectedRequestSha256',
    '--expected-model-id': 'expectedModelId',
    '--expected-endpoint-sha256': 'expectedEndpointSha256' }[args[index]]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    INVALID(`unknown, repeated, or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!SHA.test(options.planId ?? '')) INVALID('signed A8B5 plan ID required')
if (options.expectedRequestSha256 && !SHA.test(options.expectedRequestSha256))
  INVALID('expected B request SHA-256 invalid')
if (options.apply && (!options.expectedRequestSha256 || !options.expectedModelId
  || !SHA.test(options.expectedEndpointSha256 ?? '')))
  INVALID('--apply requires reviewed request, model, and endpoint hashes')

const root = process.cwd()
const directory = path.join(root, '.runtime/staged-scene-cut-a8b5', options.planId)
const manifest = await readA8B5Plan(options.planId, root)
const retry = manifest.version === 'staged-scene-cut-a8b5-retry-b-v1'
const intentVersion = retry ? 'staged-a8b5-retry-B-submit-intent-v1'
  : 'staged-a8b5-B-submit-intent-v1'
const { request, ...preview } = retry
  ? await previewA8B5RetryRequestFromSignedManifest(manifest, root, true)
  : await previewA8B5PhaseB(options.planId, root, true)
if (preview.requestSha256 !== manifest.phaseBPreview.requestSha256
  || options.expectedRequestSha256 && preview.requestSha256 !== options.expectedRequestSha256
  || request.model_name !== 'kling-v3-omni' || request.sound !== 'off')
  INVALID('B request differs from signed plan or reviewed request')

const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let model
try {
  const result = await db.query('select result,md5(result::text) as result_md5 from execution_records where id=$1',
    [manifest.source.recordId])
  if (result.rows.length !== 1 || result.rows[0].result_md5 !== manifest.source.resultMd5)
    INVALID('source record changed')
  const state = decodeExecutionState(result.rows[0].result)
  if (state.nodeRuns?.[50]?.output?.shotSha256 !== manifest.source.approvedShotSha256
    || state.nodeRuns?.[52]?.status !== 'success'
    || state.nodeRuns?.[58]?.output?.decision !== 'revise')
    INVALID('source approval/rejected-video state changed')
  const workflow = (await db.query('select nodes from workflow_configs where id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  const node = workflow?.nodes?.find(value => value.id === 'sanguo-video')
  model = node && (await db.query('select id,provider,capability,settings from model_configs where id=$1',
    [node.modelId])).rows[0]
  if (model?.provider !== 'Kling' || model?.capability !== 'video'
    || !model.settings?.endpoint || model.id !== manifest.providerLock.modelId)
    INVALID('configured video model differs from signed A8B5 plan')
} finally { await db.end() }
const endpoint = resolveKlingOmniVideoEndpoint(model.settings.endpoint)
const endpointSha256 = createHash('sha256').update(endpoint).digest('hex')
if (endpointSha256 !== manifest.providerLock.endpointSha256
  || options.apply && (model.id !== options.expectedModelId
    || endpointSha256 !== options.expectedEndpointSha256))
  INVALID('configured endpoint differs from signed/reviewed lock')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-B-preflight', planId: options.planId,
    sourceAStatus: manifest.source.oldPlanAStatus,
    sourceAFrameSha256: manifest.sourceAFrame.sha256,
    ...preview, modelId: model.id, endpointSha256,
    sourceReviewRequiredBeforeApply: retry
      ? 'signed original A rejection, provisional A review, and previous B rejection'
      : 'signed original A rejection and provisional A review',
    providerCalls: 0, databaseWrites: 0 }, null, 2))
  process.exit(0)
}

if (retry) await readA8B5BRejection(manifest.source.previousPlanId, root)
else await readA8B5ProvisionalReview(options.planId, root)
if (existsSync(path.join(directory, 'phase-B-rejection.json')))
  INVALID('B media already rejected; a new source-bound plan is required')
if (existsSync(path.join(directory, 'phase-B-failure.json')))
  INVALID('B task has terminal failure; no automatic retry')
const intentPath = path.join(directory, 'phase-B-submit-intent.json')
let task
try { task = await readA8B5BTask(options.planId, root) }
catch (error) { if (error.code !== 'ENOENT') throw error }
let intent
try { intent = JSON.parse(await readFile(intentPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (task && !intent) INVALID('B task lacks pre-POST write-once intent')
if (intent && (intent.version !== intentVersion
  || intent.planId !== options.planId || intent.phase !== 'B'
  || intent.requestSha256 !== preview.requestSha256
  || intent.modelId !== model.id || intent.endpointSha256 !== endpointSha256
  || intent.endpoint !== endpoint))
  INVALID('existing B submit intent differs; no POST allowed')
if (task && (task.requestSha256 !== intent.requestSha256
  || task.providerModelId !== intent.modelId
  || task.endpointSha256 !== intent.endpointSha256))
  INVALID('signed B task and write-once intent disagree')

const headers = { 'content-type': 'application/json', authorization: klingAuthorization(model.settings) }
if (!task && !intent) {
  intent = { version: intentVersion, planId: options.planId,
    phase: 'B', requestSha256: preview.requestSha256, modelId: model.id,
    endpoint, endpointSha256, createdAt: new Date().toISOString(), nonce: randomUUID() }
  await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const response = await fetchModelEndpoint(endpoint, { method: 'POST', headers,
    body: JSON.stringify(request), signal: AbortSignal.timeout(180000) })
  let body
  try { body = await response.json() }
  catch { INVALID(`B paid POST response was not JSON (HTTP ${response.status}); intent locked`) }
  const taskId = body?.data?.task_id
  if (!response.ok || !/^[\w-]{8,128}$/.test(String(taskId ?? '')))
    INVALID(`B paid POST yielded no recoverable task ID (HTTP ${response.status}); intent locked`)
  task = await saveA8B5BTask(options.planId, { planId: options.planId, phase: 'B',
    taskId, requestSha256: preview.requestSha256,
    providerModelId: model.id, endpointSha256, submittedAt: new Date().toISOString() }, root)
} else if (!task) {
  INVALID('B POST acknowledgement may be lost; existing intent forbids another POST')
}

let media
try { media = await readA8B5BMedia(options.planId, root) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!media) {
  let result
  for (let poll = 0; poll < 600; poll++) {
    const response = await fetchModelEndpoint(`${endpoint}/${encodeURIComponent(task.taskId)}`,
      { method: 'GET', headers, signal: AbortSignal.timeout(180000) })
    result = await response.json()
    if (!response.ok || result?.data?.task_id !== task.taskId)
      INVALID(`B task ${task.taskId} query failed; resume same task later`)
    if (result.data.model_name && result.data.model_name !== request.model_name)
      INVALID('B provider result model differs from paid request')
    if (['succeed', 'failed'].includes(result.data.task_status)) break
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  if (result?.data?.task_status === 'failed') {
    await writeFile(path.join(directory, 'phase-B-provider-terminal.json'),
      JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    await saveA8B5TerminalFailure(options.planId, { taskId: task.taskId,
      requestSha256: task.requestSha256, status: 'failed',
      observedAt: new Date().toISOString(),
      providerMessage: result.data.task_status_msg ?? '' }, root)
    INVALID(`B provider task ${task.taskId} failed; no automatic retry`)
  }
  if (result?.data?.task_status !== 'succeed')
    INVALID(`B task ${task.taskId} pending/timeout; resume same task later`)
  const remoteUrl = result.data.task_result?.videos?.[0]?.url
    ?? result.data.task_result?.videos?.[0]?.video_url
  if (typeof remoteUrl !== 'string' || !/^https:\/\//.test(remoteUrl))
    INVALID('B successful task lacks HTTPS media URL')
  const response = await fetchModelEndpoint(remoteUrl, { signal: AbortSignal.timeout(180000) })
  if (!response.ok) INVALID(`B archive fetch HTTP ${response.status}; resume same task`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 10000) INVALID('B provider media too short')
  const videoUrl = `/generated/staged-a8b5-phase-B-${task.taskId}.mp4`
  const filename = path.join(root, 'public', videoUrl.slice(1))
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      INVALID('existing B archived video bytes differ')
  }
  media = await saveA8B5BMedia(options.planId, { taskId: task.taskId,
    videoUrl, videoSha256: createHash('sha256').update(bytes).digest('hex') }, root)
}
console.log(JSON.stringify({ mode: 'B-paid-media-archived-unreviewed', planId: options.planId,
  taskId: task.taskId, media, sourceAStatus: manifest.source.oldPlanAStatus,
  firstShotAccepted: false, twoShotsAccepted: false,
  next: 'independent native B and A f192 to B f0/f1 seam review required' }, null, 2))
