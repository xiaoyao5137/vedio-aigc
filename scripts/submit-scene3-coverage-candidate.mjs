#!/usr/bin/env node
// One standalone scene-03 coverage-cut candidate. Dry-run freezes the exact
// request; --run submits that request once without changing workflow records.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { videoPromptInputContext } from '../src/video-prompt-input.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { buildKlingVideoRequest, klingThreeViewVideoPrompt } from '../server/model-adapters.ts'
import { prepareThreeViewVideoReferences } from '../server/image-references.ts'
import { prepareWorkflowMediaRequest, validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const sourceId = 'record-610-scene4-voice-repair-20260928-v1'
const sourceMd5 = 'df7ddd75cf661ae5ee5d60656854989c'
const sourceThirdClip = '/generated/verified-5e8e7e84ea39567a15a4.mp4'
const sourceFourthClip = '/generated/verified-38ddc16e7d67eb4f8a77.mp4'
const sourceText = '张飞：大军已经到了，你为什么不降，还要抵抗？'
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const jsonHash = createJsonHasher()
const fail = message => { throw new Error(`SCENE3_COVERAGE_PREFLIGHT: ${message}`) }
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = outIndex < 0 ? undefined : args[outIndex + 1]
const run = args.includes('--run')
if (!out || args.some(arg => arg.startsWith('--') && !['--out', '--run'].includes(arg))
  || args.filter(arg => arg === '--out').length !== 1 || args.filter(arg => arg === '--run').length > 1) {
  fail('usage: node scripts/submit-scene3-coverage-candidate.mjs --out NEW_OR_EXISTING_DIR [--run]')
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let source, state, shot, videoRun, model
try {
  const row = (await db.query('select id, workflow_id, result, md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  if (!row || row.md5 !== sourceMd5) fail('preserved source execution changed')
  source = { id: row.id, workflowId: row.workflow_id, md5: row.md5 }
  state = decodeExecutionState(row.result)
  if (state.id !== row.id || state.workflowId !== row.workflow_id) fail('source identity mismatch')
  const shotRuns = state.nodeRuns.filter(item => item.node.id === 'sanguo-shot-script' && item.loopIndex === 2)
  const videoRuns = state.nodeRuns.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.node.id === 'sanguo-video' && item.loopIndex === 2)
  if (shotRuns.length !== 1 || videoRuns.length !== 1 || videoRuns[0].item.status !== 'success') fail('source scene-03 missing')
  shot = shotRuns[0].output
  videoRun = videoRuns[0]
  if (shot?.id !== 'scene-03' || shot.duration !== 9 || shot.continuity?.mode !== 'tail_continuation'
    || shot.firstFrameMode !== 'reuse_previous_tail' || shot.audioText !== sourceText) fail('original shot changed')
  const original = videoRun.item.inputs
  if (original.audioText !== sourceText || original.videoTimeline !== shot.videoPrompt || original.duration !== 9
    || original.referenceImages?.length !== 2 || original.referenceBindings?.map(item => item.characterName).join(',') !== '张飞,严颜') {
    fail('approved timeline, dialogue, duration or identity references changed')
  }
  if (videoRun.item.output?.characterVoices?.length !== 1
    || videoRun.item.output.characterVoices[0]?.characterName !== '张飞'
    || !videoRun.item.output.characterVoices[0]?.voiceId
    || !videoRun.item.output.characterVoices[0]?.elementId) fail('saved Zhang Fei voice element missing')
  const thirdEvidence = JSON.parse(await readFile('public/generated/verified-5e8e7e84ea39567a15a4-sampling-708d1e132e74a31c-evidence.json', 'utf8'))
  if (thirdEvidence.url !== sourceThirdClip || thirdEvidence.originalUrl !== videoRun.item.output.url) fail('source clip/evidence mismatch')
  const fourthEvidence = JSON.parse(await readFile('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop4-media/scene4-retake-live-20260928-v1/candidate-evidence.json', 'utf8'))
  if (fourthEvidence.videoUrl !== sourceFourthClip) fail('fourth candidate identity changed')
  model = (await db.query('select * from model_configs where id=$1', [videoRun.item.node.modelId])).rows[0]
  if (model?.id !== 'keling3' || model.provider !== 'Kling' || model.capability !== 'video') fail('provider model changed')
} finally { await db.end() }

const priorTail = await readFile('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/three-shot-audit-20260928/frames/frame-00361.jpg')
const fourthFirst = await readFile('public/generated/verified-38ddc16e7d67eb4f8a77-sampling-abb408692ce8273f-frame-0.jpg')
const frameHash = { scene2Tail: sha(priorTail), scene4First: sha(fourthFirst) }
const prepared = prepareWorkflowRunContext(state.nodeRuns, videoRun.index)
if (!prepared?.inputContext?.shot_script) fail('original prompt context unavailable')
const originalParams = videoRun.item.inputs
const originalPrompt = renderWorkflowTemplate(videoRun.item.node.prompt,
  videoPromptInputContext({ ...prepared.inputContext, params: originalParams }, originalParams.promptInputMode))
if (originalPrompt !== videoRun.item.output.prompt) fail('saved original prompt does not reconstruct')

const opening = '16:9真人实景，东汉江州临时驻所前院，同一土墙、木柱和自然侧光。张飞已站稳在严颜面前，人物世界位置不变；在既有视线轴线的院门一侧切近为平视双人中近景。张飞在左、严颜在右，张飞英俊而壮健，白净暖肤，黑发黑须、黑色军冠、深褐战袍和暗色札甲；严颜黑发黑须，灰褐战袍和旧甲，双腕始终由同一根绳索一起缚在身前。张飞的脸和口型清楚，严颜的脸与双腕同框可见。两名原有军士仍在院内看守，仅因取景画外；无新人、新道具、字幕、水印。'
const ending = '同一江州前院，张飞仍在左侧面向严颜，问完闭口，目光不移；严颜在右侧略抬下颌直视张飞，双腕始终由同一根绳索一起缚于身前，尚未开口。人物未换位、未解绳、未下令；原军士仍在场外看守。自然光与原衣甲不变，无字幕、水印。'
const camera = '同一视线轴线院门侧作 coverage_cut，不锁前镜尾帧。由前镜两人全身对立切至张飞左、严颜右的平视双人中近景；发问期间以张飞面部和自然口型为视觉重心，缓慢向严颜侧微移焦；问句结束后保留严颜抬下颌、双腕仍缚的可见反应。机位不越轴，严颜不走位、不答话，下一镜可在同侧切向严颜。'
let prompt = originalPrompt
const replaceOnce = (expression, replacement) => {
  const count = [...prompt.matchAll(expression)].length
  if (count !== 1) fail(`expected one prompt section, found ${count}`)
  prompt = prompt.replace(expression, replacement)
}
replaceOnce(/【场景与开场画面】[^\n]+/g, `【场景与开场画面】${opening}`)
replaceOnce(/【本镜结束时的自然动作结果】[^\n]+/g, `【本镜结束时的自然动作结果】${ending}`)
replaceOnce(/运镜：[^\n]+/g, `运镜：${camera}`)
if (!prompt.includes(originalParams.videoTimeline) || !prompt.includes(`【音轨文本；环境声模式为空且禁止人声】${sourceText}`)) fail('source timeline/dialogue changed')
const params = { ...originalParams, referenceImage: undefined, endImage: undefined,
  continuityMode: 'coverage_cut', firstFrameMode: 'reference',
  characterVoices: videoRun.item.output.characterVoices,
  voiceManifest: videoRun.item.output.voiceManifest,
  voiceConsistency: videoRun.item.output.voiceConsistency,
  negativePrompt: `${originalParams.negativePrompt}，双腕分开，单腕绳圈，擅自松绑，人物换边，重复双人宽景` }
const candidate = { model, prompt, params, executionContext: { requestKey: '', workflowId: source.workflowId,
  workflowName: state.workflowName, nodeId: 'sanguo-video', nodeName: '第三镜同场切镜独立候选' } }
const effective = prepareWorkflowMediaRequest(candidate)
validateWorkflowMediaContract(effective)
const preparedRefs = await prepareThreeViewVideoReferences(effective.params)
const provider = buildKlingVideoRequest(model, klingThreeViewVideoPrompt(prompt, preparedRefs), preparedRefs)
const elementIds = provider.element_list?.map(value => String(value.element_id)) ?? []
if (elementIds.join(',') !== params.characterVoices.map(value => String(value.elementId)).join(',')) fail('Zhang Fei voice element not preserved')
if (provider.model_name !== 'kling-v3-omni' || provider.mode !== 'std' || provider.duration !== '9' || provider.sound !== 'on') fail('provider mode/duration changed')
if (provider.image_list?.length !== 2 || provider.image_list.some(item => item.type === 'first_frame' || item.type === 'end_frame')) fail('coverage cut requires two character refs and no pixel-locked frame')
if (Array.from(provider.prompt).length > 2500 || !provider.prompt.includes('双腕始终由同一根绳索一起缚')) fail('bounded provider prompt missing continuity')
if (params.audioText !== originalParams.audioText || params.videoTimeline !== originalParams.videoTimeline || params.duration !== originalParams.duration) fail('approved time/audio changed')

const proofBase = { format: 'scene3-coverage-cut-local-video-preflight-v1', createdAt: new Date().toISOString(), source,
  videoRunIndex: videoRun.index, videoRunId: videoRun.item.id, originalShotId: shot.id,
  originalContinuityMode: shot.continuity.mode, candidateContinuityMode: params.continuityMode,
  originalFirstFrameMode: shot.firstFrameMode, candidateFirstFrameMode: params.firstFrameMode,
  originalVideoSha256: sha(await readFile('public' + sourceThirdClip)),
  adjacentFrameSha256: frameHash,
  originalDialogueSha256: sha(shot.audioText), candidateDialogueSha256: sha(params.audioText),
  originalTimelineSha256: sha(shot.videoPrompt), candidateTimelineSha256: sha(params.videoTimeline),
  originalScheduleHash: originalParams.scheduleHash, candidateScheduleHash: params.scheduleHash,
  characterReferenceCount: params.referenceImages.length, characterReferenceHashes: params.referenceImages.map(sha),
  referenceBindings: params.referenceBindings.map(x => x.characterName), voiceElementIds: elementIds,
  providerPromptHash: sha(provider.prompt), providerPromptChars: Array.from(provider.prompt).length,
  providerImageListTypes: provider.image_list.map(item => item.type ?? 'reference'),
  providerModel: provider.model_name, providerMode: provider.mode, duration: provider.duration, sound: provider.sound,
  sourceExecutionWriteAllowed: false, workflowWriteAllowed: false, maxNewVideoTasks: 1,
  directorFrameUsedByProvider: false, directorFrameReason: 'coverage_cut paid gate forbids pixel-locked first frame; only preserved character identity sheets are bound' }

if (!run) {
  const requestKey = `scene3-coverage-candidate:${sha({ source, prompt, params: jsonHash(params) }).slice(0, 20)}:${randomUUID()}`
  await mkdir(out, { recursive: false, mode: 0o700 })
  await writeFile(`${out}/preflight.json`, JSON.stringify({ ...proofBase, requestKey, dryRun: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await writeFile(`${out}/request-private.json`, JSON.stringify({ modelId: model.id, prompt, params, requestKey,
    providerPrompt: provider.prompt, providerImageListTypes: proofBase.providerImageListTypes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ ...proofBase, requestKey, dryRun: true }, null, 2))
  process.exit(0)
}

const savedProof = JSON.parse(await readFile(`${out}/preflight.json`, 'utf8'))
const savedRequest = JSON.parse(await readFile(`${out}/request-private.json`, 'utf8'))
if (!savedProof.dryRun || savedProof.source?.md5 !== source.md5 || savedProof.requestKey !== savedRequest.requestKey
  || savedProof.providerPromptHash !== sha(provider.prompt) || savedProof.providerPromptChars !== Array.from(provider.prompt).length
  || savedRequest.prompt !== prompt || jsonHash(savedRequest.params) !== jsonHash(params)
  || savedRequest.providerPrompt !== provider.prompt) fail('frozen dry-run request differs from current preflight')
try { await stat(`${out}/request-submitted.json`); fail('this frozen candidate was already submitted; inspect its task instead of resending') }
catch (error) { if (error?.code !== 'ENOENT') throw error }
const check = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await check.connect()
try {
  const current = (await check.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  const previous = (await check.query("select count(*)::int as n from model_execution_records where request_data->>'requestKey'=$1", [savedProof.requestKey])).rows[0]
  if (current?.md5 !== source.md5 || previous?.n !== 0) fail('source changed or paid task already exists')
} finally { await check.end() }
await writeFile(`${out}/request-submitted.json`, JSON.stringify({ at: new Date().toISOString(), requestKey: savedProof.requestKey,
  providerPromptHash: savedProof.providerPromptHash }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
let response, result, error
try {
  response = await fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, params, executionContext: { ...candidate.executionContext, requestKey: savedProof.requestKey } }),
    signal: AbortSignal.timeout(1_200_000) })
  result = await response.json()
  await writeFile(`${out}/response-private.json`, JSON.stringify({ httpStatus: response.status, result }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  if (!response.ok || result.status >= 400 || !result.body?.data?.task_result?.videos?.[0]?.url) {
    throw new Error(`request did not return a finished video: HTTP ${response.status}, status ${result.status}`)
  }
} catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
const audit = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await audit.connect()
try {
  const rows = (await audit.query("select id,status,http_status,task_id,duration_ms,request_data,response_data from model_execution_records where request_data->>'requestKey'=$1 order by created_at", [savedProof.requestKey])).rows
  const current = (await audit.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  const ledger = rows.map(row => ({ id: row.id, status: row.status, httpStatus: row.http_status, taskId: row.task_id,
    durationMs: row.duration_ms, requestHash: jsonHash(row.request_data), finalUnitDeduction: row.response_data?.data?.final_unit_deduction }))
  const summary = { format: 'scene3-coverage-cut-provider-task-proof-v1', requestKey: savedProof.requestKey,
    requestCount: rows.length, ledger, responseHttpStatus: response?.status ?? null, responseStatus: result?.status ?? null,
    responseVideoUrlHash: result?.body?.data?.task_result?.videos?.[0]?.url ? sha(result.body.data.task_result.videos[0].url) : null,
    error, sourceExecutionUnchanged: current?.md5 === source.md5, executionWrites: 0, workflowWrites: 0 }
  await writeFile(`${out}/provider-task-proof.json`, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
  if (error || !summary.sourceExecutionUnchanged || rows.length !== 1) process.exitCode = 1
} finally { await audit.end() }
