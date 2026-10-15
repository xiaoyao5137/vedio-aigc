#!/usr/bin/env node
/** Independent NEW A8/B6 paid runner. A write-once intent precedes every POST. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { fetchModelEndpoint, klingAuthorization,
  resolveKlingOmniVideoEndpoint } from '../server/model-adapters.ts'
import { readFreshA8B6PhaseAPlan, freshA8B6Directory,
  freshA8B6GeneratedFile } from '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6PhaseBPlan, readFreshA8B6TaskReceipt,
  readFreshA8B6MediaReceipt, saveFreshA8B6TaskReceipt,
  saveFreshA8B6MediaReceipt, freshA8B6MediaUrl } from
  '../server/staged-scene-cut-a8b6-fresh-phases.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_PAID_RUNNER_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const args = process.argv.slice(2), opts = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const key = { '--plan-id': 'planId', '--phase': 'phase',
    '--expected-request-sha256': 'requestSha256',
    '--expected-model-id': 'modelId',
    '--expected-endpoint-sha256': 'endpointSha256' }[args[i]]
  if (!key || opts[key] || !args[i + 1] || args[i + 1].startsWith('--'))
    fail(`invalid or repeated ${args[i]}`)
  opts[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.planId ?? '')
  || !['A', 'B'].includes(opts.phase))
  fail('signed new plan and A/B phase required')
if (opts.apply && (!/^[a-f0-9]{64}$/.test(opts.requestSha256 ?? '')
  || opts.modelId !== 'keling3'
  || !/^[a-f0-9]{64}$/.test(opts.endpointSha256 ?? '')))
  fail('--apply requires reviewed request/model/endpoint locks')

const root = process.cwd()
const candidateManifest = JSON.parse(await readFile(path.join(
  freshA8B6Directory(opts.planId, root), 'manifest.json'), 'utf8'))
async function runPaidPhase() {
const A = await readFreshA8B6PhaseAPlan(opts.planId, root)
if (A.manifest.version === 'staged-a8b6-fresh-A-plan-v3'
  && opts.phase !== 'B')
  fail('B-only child plan cannot submit or resume A')
const B = opts.phase === 'B'
  ? await readFreshA8B6PhaseBPlan(opts.planId, root) : undefined
const preview = opts.phase === 'A' ? A.preview : B.preview
const directory = freshA8B6Directory(opts.planId, root)
if (preview.requestSha256 !== (opts.requestSha256 ?? preview.requestSha256)
  || preview.request.sound !== 'off'
  || preview.request.model_name !== 'kling-v3-omni'
  || preview.request.duration !== (opts.phase === 'A' ? '8' : '6'))
  fail('paid request changed since signed preflight')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let model
try {
  await db.query('BEGIN READ ONLY')
  const source = A.manifest.source
  const rows = (await db.query(`SELECT id,md5(result::text) AS result_md5
    FROM execution_records WHERE id=ANY($1)`,
  [[source.freshFrameExecutionId, source.timingExecutionId]])).rows
  const byId = new Map(rows.map(row => [row.id, row]))
  if (byId.get(source.freshFrameExecutionId)?.result_md5
      !== source.freshFrameResultMd5
    || byId.get(source.timingExecutionId)?.result_md5
      !== source.timingResultMd5)
    fail('approved new first-frame source CAS changed')
  const graph = (await db.query(`SELECT schema_version,nodes,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
  const node = graph?.nodes?.find(item => item.id === 'sanguo-video')
  if (graph?.schema_version !== 180
    || graph.nodes_md5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
    || graph.edges_md5 !== '1d0a75acb3d4778a122a4cfd96a23b49'
    || node?.modelId !== A.manifest.providerLock.modelId)
    fail('workflow graph/provider routing changed')
  model = (await db.query(`SELECT id,provider,capability,settings
    FROM model_configs WHERE id=$1`, [node.modelId])).rows[0]
  if (model?.id !== 'keling3' || model.provider !== 'Kling'
    || model.capability !== 'video' || !model.settings?.endpoint)
    fail('configured paid video model changed')
  await db.query('ROLLBACK')
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally { await db.end() }
const endpoint = resolveKlingOmniVideoEndpoint(model.settings.endpoint)
const endpointSha256 = sha(endpoint)
if (A.manifest.providerLock.modelId !== model.id
  || A.manifest.providerLock.endpointSha256 !== endpointSha256
  || opts.modelId && opts.modelId !== model.id
  || opts.endpointSha256 && opts.endpointSha256 !== endpointSha256)
  fail('signed paid provider/endpoint lock changed')
if (!opts.apply) {
  const { request: _request, ...safePreview } = preview
  void _request
  console.log(JSON.stringify({ mode: 'read-only-fresh-paid-preflight',
    planId: opts.planId, phase: opts.phase, source: A.manifest.source,
    preview: safePreview, providerLock: A.manifest.providerLock,
    providerCalls: 0, databaseWrites: 0 }, null, 2))
  return
}

const headers = { 'content-type': 'application/json',
  authorization: klingAuthorization(model.settings) }
const intentPath = path.join(directory,
  `phase-${opts.phase}-submit-intent.json`)
let task
try { task = (await readFreshA8B6TaskReceipt(opts.planId,
  opts.phase, root)).task }
catch (error) { if (error.code !== 'ENOENT') throw error }
let intent
try { intent = JSON.parse(await readFile(intentPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (task && !intent) fail('signed paid task lacks its write-once submit intent')
if (!task && !intent) {
  intent = { version: 'staged-a8b6-fresh-paid-intent-v1',
    planId: opts.planId, phase: opts.phase,
    requestSha256: preview.requestSha256, modelId: model.id,
    endpoint, endpointSha256, createdAt: new Date().toISOString(),
    nonce: randomUUID() }
  await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  const response = await fetchModelEndpoint(endpoint, { method: 'POST', headers,
    body: JSON.stringify(preview.request), signal: AbortSignal.timeout(180000) })
  const body = await response.json()
  const taskId = body?.data?.task_id
  if (!response.ok || !/^[\w-]{8,128}$/.test(String(taskId ?? '')))
    fail(`paid POST has ambiguous task acknowledgement (HTTP ${response.status}); intent locked, no repeat POST`)
  task = (await saveFreshA8B6TaskReceipt(opts.planId, opts.phase,
    { taskId, submittedAt: new Date().toISOString() }, root)).value
} else if (!task) {
  fail('paid intent exists without a signed task; recover original provider task manually, no repeat POST')
}
let media
try { media = (await readFreshA8B6MediaReceipt(opts.planId,
  opts.phase, root)).media }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!media) {
  let result
  for (let poll = 0; poll < 600; poll++) {
    const response = await fetchModelEndpoint(
      `${endpoint}/${encodeURIComponent(task.taskId)}`,
      { method: 'GET', headers, signal: AbortSignal.timeout(180000) })
    result = await response.json()
    if (!response.ok || result?.data?.task_id !== task.taskId)
      fail('provider task query failed or returned another task; resume same task')
    if (result.data.model_name && result.data.model_name !== preview.request.model_name)
      fail('provider model differs from paid request')
    if (['succeed', 'failed'].includes(result.data.task_status)) break
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  if (result?.data?.task_status !== 'succeed')
    fail(`paid task not successful (${result?.data?.task_status ?? 'timeout'}); no new POST`)
  const url = result.data.task_result?.videos?.[0]?.url
    ?? result.data.task_result?.videos?.[0]?.video_url
  if (typeof url !== 'string' || !/^https:\/\//.test(url))
    fail('successful provider task has no HTTPS video')
  const response = await fetchModelEndpoint(url,
    { signal: AbortSignal.timeout(180000) })
  if (!response.ok) fail(`archive fetch HTTP ${response.status}; resume same task`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 10000) fail('provider video archive is too short')
  const videoUrl = freshA8B6MediaUrl(opts.planId, opts.phase, task.taskId)
  const filename = freshA8B6GeneratedFile(videoUrl, 'video', root)
  try { await writeFile(filename, bytes, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      fail('existing provider archive differs')
  }
  media = (await saveFreshA8B6MediaReceipt(opts.planId, opts.phase,
    { taskId: task.taskId, videoUrl, videoSha256: sha(bytes) }, root)).value
}
console.log(JSON.stringify({ mode: 'fresh-paid-native-archived',
  planId: opts.planId, phase: opts.phase, taskId: task.taskId,
  requestSha256: task.requestSha256, media: {
    videoUrl: media.videoUrl, videoSha256: media.videoSha256,
    nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    nativeFrameCount: media.nativeFrameCount,
    nativeLastPts: media.nativeLastPts },
  next: 'independent native-frame visual and model review; no acceptance yet',
}, null, 2))
}
if (['staged-a8b6-fresh-A-plan-v2',
  'staged-a8b6-fresh-A-plan-v3'].includes(candidateManifest.version))
  await withV9VerifiedSource(root, runPaidPhase)
else await runPaidPhase()
