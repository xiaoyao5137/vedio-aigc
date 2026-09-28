#!/usr/bin/env node
// Dry-run by default. --run submits exactly one new scene-03 video task with
// the signed, independently reviewed coverage-cut first frame. Never edits an
// execution record or retries a provider task under a different request key.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowMediaRequest, validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { validateCoverageCutPaidVideoRequest } from '../server/coverage-cut-runtime.ts'
import { verifyCoverageCutFrameApproval } from '../server/coverage-cut-frame-approval.ts'
import { prepareThreeViewVideoReferences } from '../server/image-references.ts'
import { buildKlingVideoRequest, klingThreeViewVideoPrompt } from '../server/model-adapters.ts'

const base = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media')
const input = path.join(base, 'scene3-coverage-first-frame-20260928-v1')
const old = path.join(base, 'scene3-coverage-candidate-20260928-v1')
const out = path.join(base, 'scene3-coverage-certified-video-20260928-v1')
const run = process.argv.includes('--run')
assert.deepEqual(process.argv.slice(2), run ? ['--run'] : [])
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex')
const read = async (folder, filename) => JSON.parse(await readFile(path.join(folder, filename), 'utf8'))
const [plan, image, projected, approval, frozen] = await Promise.all([
  read(input, 'plan-private.json'), read(input, 'image-result-proof.json'),
  read(input, 'review-shot.json'), read(input, 'certificate-v2.json'), read(old, 'request-private.json'),
])
assert.equal(plan.sourceMd5, 'df7ddd75cf661ae5ee5d60656854989c')
assert.equal(plan.originalVideoTaskId, '933484061220827179')
assert.equal(image.taskCount, 1)
assert.equal(image.imagePersistedLocally, true)
assert.equal(image.imageUrl, approval.frames[1].sourceUrl)
assert.equal(projected.sourceShotSha256, plan.shotSha256)
assert.equal(projected.shot.duration, 9)
assert.equal(projected.shot.audioText, '张飞：大军已经到了，你为什么不降，还要抵抗？')
assert.equal(projected.shot.pacing.scheduleHash,
  'duration-v2-sha256-90dfa908106a3816d2e4c731f27b9d1aeee3a8982ea330f79342fe42a6c7a535')
assert.deepEqual(projected.shot.pacing.schedule.map(window => [window.beatId, window.startSecond, window.endSecond]),
  [['beat-03-gaze', 0, 0.5], ['beat-03-question', 0.5, 6.149], ['beat-03-response', 6.149, 7.649]])
assert.equal(verifyCoverageCutFrameApproval(approval).signature, approval.signature)
const sources = plan.params.coverageSources
assert.equal(approval.frames[0].sourceUrl, sources.previousTail.url)
assert.deepEqual(approval.assets.map(asset => asset.assetId),
  ['character-070b25d71205797c', 'character-41953008cc8dfd45'])

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let model, source, originalVideo
try {
  source = (await db.query('select id,workflow_id,result,md5(result::text) as md5 from execution_records where id=$1',
    [plan.sourceId])).rows[0]
  assert.equal(source?.md5, plan.sourceMd5)
  const state = decodeExecutionState(source.result)
  originalVideo = state.nodeRuns.find(row => row.node.id === 'sanguo-video' && row.loopIndex === 2)
  const originalShot = state.nodeRuns.find(row => row.node.id === 'sanguo-shot-script' && row.loopIndex === 2)?.output
  assert.equal(originalVideo?.status, 'success')
  assert.equal(originalShot?.id, 'scene-03')
  assert.equal(originalShot.audioText, projected.shot.audioText)
  assert.equal(originalShot.duration, projected.shot.duration)
  assert.equal(sha(originalShot.pacing), sha(projected.shot.pacing))
  assert.equal(frozen.params.audioText, originalShot.audioText)
  assert.equal(frozen.params.videoTimeline, originalShot.videoPrompt)
  assert.equal(frozen.params.duration, originalShot.duration)
  assert.equal(frozen.params.scheduleHash, originalShot.pacing.scheduleHash)
  assert.deepEqual(frozen.params.characterVoices, originalVideo.output.characterVoices)
  assert.deepEqual(frozen.params.referenceBindings.map(binding => binding.assetId),
    sources.referenceBindings.map(binding => binding.assetId))
  model = (await db.query('select * from model_configs where id=$1', [frozen.modelId])).rows[0]
  assert.equal(model?.provider, 'Kling')
  assert.equal(model?.capability, 'video')
} finally { await db.end() }

// Put the time contract in a short, early sentence so that provider prompt
// compaction cannot hide it behind the already-approved compiled timeline.
const timingLine = '【本镜节奏硬边界】0.5秒张飞开始原问句，6.149秒前完整问完并闭口；6.149—7.649秒严颜才略抬下颌、双腕仍缚且不答；7.649—9秒留无词反应。不得把发问拖到片尾。'
const prompt = frozen.prompt.replace('【本镜影视处理】live_action / story',
  `【本镜影视处理】live_action / story\n${timingLine}`)
assert.notEqual(prompt, frozen.prompt)
assert.ok(prompt.includes(frozen.params.videoTimeline))
assert.equal((prompt.match(/【本镜节奏硬边界】/g) ?? []).length, 1)
const params = { ...frozen.params,
  referenceImage: image.imageUrl, referenceImages: sources.referenceImages,
  referenceBindings: sources.referenceBindings, coveragePreviousTail: sources.previousTail,
  coverageShot: projected.shot, coverageCutFrameGate: approval,
  continuityMode: 'coverage_cut', firstFrameMode: 'reference' }
const context = { workflowId: source.workflow_id,
  workflowName: '三国原著史料短剧（分步生成）', nodeId: 'sanguo-video', nodeName: '第三镜同场新机位候选' }
const candidate = prepareWorkflowMediaRequest({ model, prompt, params, executionContext: context })
validateWorkflowMediaContract(candidate)
assert.equal(validateCoverageCutPaidVideoRequest(candidate), 'new-purchase')
const preparedRefs = await prepareThreeViewVideoReferences(candidate.params)
const provider = buildKlingVideoRequest(model, klingThreeViewVideoPrompt(prompt, preparedRefs), preparedRefs)
const chars = Array.from(provider.prompt).length
assert.ok(chars <= 2500)
for (const token of ['0.5', '6.149', '7.649', '9秒', '张飞', '严颜', '大军已经到了，你为什么不降，还要抵抗？',
  '双腕', '不得把发问拖到片尾']) assert.ok(provider.prompt.includes(token), `Provider prompt lost ${token}`)
assert.equal(provider.duration, '9')
assert.equal(provider.sound, 'on')
assert.equal(provider.model_name, 'kling-v3-omni')
assert.equal(provider.mode, 'std')
assert.equal(provider.image_list.length, 3)
assert.deepEqual(provider.image_list.map(item => item.type ?? 'identity'), ['identity', 'identity', 'first_frame'])
assert.deepEqual(provider.element_list.map(item => String(item.element_id)),
  params.characterVoices.map(voice => String(voice.elementId)))
const publicProof = { format: 'scene3-certified-coverage-video-preflight-v1', at: new Date().toISOString(),
  sourceId: plan.sourceId, sourceMd5: plan.sourceMd5, shotId: projected.shot.id,
  shotSha256: approval.shotSha256, duration: 9, audioTextSha256: sha(params.audioText),
  timelineSha256: sha(params.videoTimeline), scheduleHash: params.scheduleHash,
  voiceElementIds: provider.element_list.map(item => String(item.element_id)),
  selectedAssetIds: sources.referenceBindings.map(binding => binding.assetId),
  firstFrameUrl: image.imageUrl, firstFrameSha256: image.imageSha256,
  actualTailSha256: sources.previousTail.sha256, certificateSha256: sha(approval),
  providerPromptSha256: sha(provider.prompt), providerPromptChars: chars,
  providerImageListTypes: provider.image_list.map(item => item.type ?? 'identity'),
  providerModel: provider.model_name, providerMode: provider.mode,
  videoPaidGate: 'passed', oldVideoTaskPreserved: plan.originalVideoTaskId,
  maxNewVideoTasks: 1, sourceExecutionWriteAllowed: false, concatAllowedBeforeQA: false }

if (!run) {
  const requestKey = `scene3-coverage-certified-video:${randomUUID()}`
  await mkdir(out, { recursive: false, mode: 0o700 })
  await writeFile(path.join(out, 'preflight.json'), JSON.stringify({ ...publicProof, requestKey, dryRun: true }, null, 2) + '\n',
    { flag: 'wx' })
  await writeFile(path.join(out, 'request-private.json'), JSON.stringify({ prompt, params, requestKey,
    modelId: model.id, providerPrompt: provider.prompt }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ ...publicProof, requestKey, dryRun: true }, null, 2))
  process.exit(0)
}

const [saved, request] = await Promise.all([read(out, 'preflight.json'), read(out, 'request-private.json')])
assert.equal(saved.dryRun, true)
assert.equal(saved.sourceMd5, publicProof.sourceMd5)
assert.equal(saved.providerPromptSha256, publicProof.providerPromptSha256)
assert.equal(saved.certificateSha256, publicProof.certificateSha256)
assert.equal(request.prompt, prompt)
assert.equal(sha(request.params), sha(params))
assert.equal(request.providerPrompt, provider.prompt)
try { await stat(path.join(out, 'request-submitted.json')); throw new Error('This video request was already submitted') }
catch (error) { if (error?.code !== 'ENOENT') throw error }
const audit = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await audit.connect()
try {
  assert.equal((await audit.query('select md5(result::text) as md5 from execution_records where id=$1', [plan.sourceId])).rows[0]?.md5,
    plan.sourceMd5)
  const previous = (await audit.query("select count(*)::int as n from model_execution_records where request_data->>'requestKey'=$1",
    [saved.requestKey])).rows[0]
  assert.equal(previous.n, 0)
} finally { await audit.end() }
await writeFile(path.join(out, 'request-submitted.json'), JSON.stringify({ at: new Date().toISOString(),
  requestKey: saved.requestKey, providerPromptSha256: saved.providerPromptSha256 }, null, 2) + '\n',
{ flag: 'wx', mode: 0o600 })
let response, result, error
try {
  response = await fetch('http://127.0.0.1:5173/api/node-run', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, params, executionContext: { ...context, requestKey: saved.requestKey } }),
    signal: AbortSignal.timeout(1_200_000) })
  result = await response.json()
  await writeFile(path.join(out, 'response-private.json'), JSON.stringify({ httpStatus: response.status, result }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  if (!response.ok || result.status >= 400 || !result.body?.data?.task_result?.videos?.[0]?.url) {
    throw new Error(`Video request did not return completed media: HTTP ${response.status}, status ${result.status}`)
  }
} catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
const final = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await final.connect()
try {
  const rows = (await final.query("select id,status,http_status,task_id,duration_ms,request_data,response_data from model_execution_records where request_data->>'requestKey'=$1 order by created_at",
    [saved.requestKey])).rows
  const sourceMd5 = (await final.query('select md5(result::text) as md5 from execution_records where id=$1',
    [plan.sourceId])).rows[0]?.md5
  const proof = { format: 'scene3-certified-coverage-video-provider-result-v1', at: new Date().toISOString(),
    requestKey: saved.requestKey, requestCount: rows.length, httpStatus: response?.status ?? null,
    nodeStatus: result?.status ?? null, videoUrl: result?.body?.data?.task_result?.videos?.[0]?.url ?? null,
    ledger: rows.map(row => ({ id: row.id, status: row.status, httpStatus: row.http_status,
      taskId: row.task_id, durationMs: row.duration_ms,
      finalUnitDeduction: row.response_data?.data?.final_unit_deduction ?? null })),
    error: error ?? null, sourceExecutionUnchanged: sourceMd5 === plan.sourceMd5,
    sourceExecutionWrites: 0, concatAttempted: false, automaticRetry: false }
  await writeFile(path.join(out, 'provider-result.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(proof, null, 2))
  if (error || rows.length !== 1 || !proof.sourceExecutionUnchanged) process.exitCode = 1
} finally { await final.end() }
