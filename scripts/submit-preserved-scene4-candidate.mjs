// One controlled, standalone scene-04 video candidate. Default is dry-run.
// --run submits one provider request; it never rewrites an execution or workflow.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { videoPromptInputContext } from '../src/video-prompt-input.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { buildKlingVideoRequest } from '../server/model-adapters.ts'
import { prepareWorkflowMediaRequest, validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const fail = message => { throw new Error(`SCENE4_CANDIDATE_INVALID: ${message}`) }
const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
if (args.includes('--help')) {
  console.log('node scripts/submit-preserved-scene4-candidate.mjs --source RECORD --expected-md5 HASH --out NEW_DIR [--run]\nDry-run preflights the exact prompt, voice element, visual references and frame bindings. --run makes one media request; it does not edit execution/workflow records or concatenate video.')
  process.exit(0)
}
const sourceId = value('--source'), expectedMd5 = value('--expected-md5'), out = value('--out'), run = args.includes('--run')
if (!sourceId || !/^[a-f\d]{32}$/i.test(expectedMd5 ?? '') || !out) fail('--source, --expected-md5 and --out are required')
if (args.some(arg => arg.startsWith('--') && !['--source', '--expected-md5', '--out', '--run'].includes(arg))) fail('unknown argument')
if (['--source', '--expected-md5', '--out'].some(flag => args.filter(arg => arg === flag).length !== 1) || args.filter(arg => arg === '--run').length > 1) fail('duplicate argument')
const firstUrl = '/generated/verified-c5d31fc2d8c8e3736d69-sampling-d6a2d41ebd9fe335-frame-0.jpg'
const tailUrl = '/generated/scene4-tail-bound-wrists-20260928-v1.png'
const imageInfo = async url => {
  const bytes = await readFile('public' + url)
  return { url, sha256: hash(bytes), bytes: bytes.length }
}
const first = await imageInfo(firstUrl), tail = await imageInfo(tailUrl)
if (first.sha256 !== '2773ab1541fa97bd4345a302291ee9aca28d16d43ee3e84cd28415dae1757ffd'
  || tail.sha256 !== '49627e5f8191f73c987355f8065bd07721d6ce19012d4cd95d5e5edbaa68626b') fail('reviewed first/end image bytes changed')

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'
const db = new pg.Client({ connectionString })
await db.connect()
let source, state, videoRun, model
try {
  const row = (await db.query('select id, workflow_id, result, md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  if (!row || row.md5 !== expectedMd5.toLowerCase()) fail('source record changed or missing')
  source = { id: row.id, workflowId: row.workflow_id, md5: row.md5 }
  state = decodeExecutionState(row.result)
  if (state.id !== row.id || state.workflowId !== row.workflow_id) fail('source identity mismatch')
  const videos = state.nodeRuns.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.node.id === 'sanguo-video' && item.loopIndex === 3)
  if (videos.length !== 1 || videos[0].item.status !== 'success') fail('expected one completed scene-04 video')
  videoRun = videos[0]
  const shot = state.nodeRuns.find(item => item.node.id === 'sanguo-shot-script' && item.loopIndex === 3)?.output
  if (shot?.id !== 'scene-04' || shot.duration !== 12) fail('approved scene or duration changed')
  if (videoRun.item.inputs.audioText !== shot.audioText || videoRun.item.inputs.videoTimeline !== shot.videoPrompt) fail('video request differs from approved dialogue or timeline')
  if (videoRun.item.inputs.referenceImages?.length !== 2 || videoRun.item.inputs.referenceBindings?.map(item => item.characterName).join(',') !== '张飞,严颜') fail('two approved three-view references are missing')
  const voices = videoRun.item.output?.characterVoices
  if (!Array.isArray(voices) || voices.length !== 1 || voices[0].characterName !== '严颜' || !voices[0].voiceId || !voices[0].elementId) fail('saved Yan Yan voice element is missing')
  model = (await db.query('select * from model_configs where id=$1', [videoRun.item.node.modelId])).rows[0]
  if (model?.id !== 'keling3' || model.provider !== 'Kling' || model.capability !== 'video') fail('configured provider changed')
} finally { await db.end() }

const prepared = prepareWorkflowRunContext(state.nodeRuns, videoRun.index)
if (!prepared?.inputContext?.shot_script) fail('cannot rebuild original video context')
const originalParams = videoRun.item.inputs
const promptContext = videoPromptInputContext({ ...prepared.inputContext, params: originalParams }, originalParams.promptInputMode)
const originalPrompt = renderWorkflowTemplate(videoRun.item.node.prompt, promptContext)
if (originalPrompt !== videoRun.item.output.prompt) fail('rendered original request does not match saved provider input')
// Keep the authored visual line byte-for-byte, so the provider compiler can
// safely compact its owned contracts without touching the authored timeline.
let prompt = originalPrompt
const continuity = '【双腕硬约束】严颜双腕从首帧到末帧始终在身前由同一根绳索共同捆缚；不分开、不下垂、不变单腕绳圈、不松绑或释放。说话时双腕不动。'
prompt = prompt.replace('0-0.7秒：', `${continuity}\n0-0.7秒：`)
if (!prompt.includes(continuity) || prompt.includes('${')) fail('continuity constraint insertion failed')
const params = { ...originalParams, image: firstUrl, endImage: tailUrl,
  characterVoices: videoRun.item.output.characterVoices, voiceManifest: videoRun.item.output.voiceManifest,
  voiceConsistency: videoRun.item.output.voiceConsistency,
  negativePrompt: `${originalParams.negativePrompt}，单腕绳圈，双手分开，腕部解绳` }
// Deliberately omit voicePolicy/voiceExecutionId: this independent candidate
// uses the exact saved element binding and must not mutate voice manifests.
const requestKey = `scene4-bound-wrists-candidate:${hash({ source, first, tail, prompt, voice: params.characterVoices }).slice(0, 20)}:${randomUUID()}`
const request = { model, prompt, params, executionContext: { requestKey, workflowId: source.workflowId,
  workflowName: state.workflowName, nodeId: 'sanguo-video', nodeName: '第四镜局部视频候选' } }
const effective = prepareWorkflowMediaRequest(request)
validateWorkflowMediaContract(effective)
if (process.env.SCENE4_DEBUG_LENGTHS === '1') console.log(JSON.stringify({ originalPromptChars: Array.from(originalPrompt).length,
  candidatePromptChars: Array.from(prompt).length, originalLines: originalPrompt.split('\n').map(line => ({ chars: Array.from(line).length, start: line.slice(0, 48) })),
  candidateLines: prompt.split('\n').map(line => ({ chars: Array.from(line).length, start: line.slice(0, 48) })) }, null, 2))
const provider = buildKlingVideoRequest(model, effective.prompt, effective.params)
const elementIds = provider.element_list?.map(value => String(value.element_id)) ?? []
if (elementIds.join(',') !== params.characterVoices.map(value => String(value.elementId)).join(',')) fail('saved original voice element changed')
if (provider.model_name !== 'kling-v3-omni' || provider.mode !== 'std' || provider.duration !== '12' || provider.sound !== 'on') fail('provider/model/duration/audio mode changed')
if (provider.image_list?.length !== 4 || provider.image_list[2]?.type !== 'first_frame' || provider.image_list[3]?.type !== 'end_frame') fail('three-view and first/end-frame bindings incomplete')
if (Array.from(provider.prompt).length > 2500 || !provider.prompt.includes('同一根绳索共同捆缚')) fail('continuity is absent from the bounded provider prompt')
if (params.audioText !== originalParams.audioText || params.videoTimeline !== originalParams.videoTimeline || params.duration !== originalParams.duration) fail('approved audio/timeline/duration changed')
const proof = { format: 'scene4-local-video-candidate-preflight-v1', createdAt: new Date().toISOString(), source,
  videoRunIndex: videoRun.index, videoRunId: videoRun.item.id, originalPaidVideoHash: hash(videoRun.item.output.url),
  first, tail, originalPromptChars: Array.from(originalPrompt).length, candidateInputPromptChars: Array.from(prompt).length,
  candidateProviderPromptChars: Array.from(provider.prompt).length, candidatePromptHash: hash(prompt), providerPromptHash: hash(provider.prompt),
  originalParamsHash: createJsonHasher()(originalParams), candidateParamsHash: createJsonHasher()(params),
  threeViewReferenceHashes: originalParams.referenceImages.map(hash), referenceBindingNames: originalParams.referenceBindings.map(item => item.characterName),
  originalVoiceElementIds: elementIds, originalVoiceIdsHash: params.characterVoices.map(item => hash(item.voiceId)),
  audioTextHash: hash(params.audioText), videoTimelineHash: hash(params.videoTimeline), requestKey,
  providerModel: provider.model_name, providerMode: provider.mode, duration: provider.duration, sound: provider.sound,
  imageListTypes: provider.image_list.map(item => item.type ?? 'reference'), generatedMediaAllowed: run ? 1 : 0,
  executionWritesAllowed: 0, workflowWritesAllowed: 0, concatAllowed: false }
await mkdir(out, { recursive: false, mode: 0o700 })
await writeFile(`${out}/preflight.json`, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
await writeFile(`${out}/request-private.json`, JSON.stringify({ modelId: model.id, prompt, params, providerPrompt: provider.prompt,
  providerFields: Object.fromEntries(Object.entries(provider).filter(([key]) => !['image_list', 'prompt'].includes(key))),
  requestKey }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
if (!run) { console.log(JSON.stringify({ ...proof, dryRun: true }, null, 2)); process.exit(0) }

const check = new pg.Client({ connectionString })
await check.connect()
try {
  const current = (await check.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  if (current?.md5 !== source.md5) fail('source changed between preflight and submission')
  const duplicate = (await check.query("select count(*)::int as n from model_execution_records where request_data->>'requestKey'=$1", [requestKey])).rows[0]
  if (duplicate.n !== 0) fail('request identity already exists')
} finally { await check.end() }
await writeFile(`${out}/request-submitted.json`, JSON.stringify({ at: new Date().toISOString(), requestKey,
  candidatePromptHash: proof.candidatePromptHash, candidateParamsHash: proof.candidateParamsHash }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
let response, result, error
try {
  response = await fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(1_200_000) })
  result = await response.json()
  await writeFile(`${out}/response-private.json`, JSON.stringify({ httpStatus: response.status, result }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  if (!response.ok || result.status >= 400 || !result.body?.data?.task_result?.videos?.[0]?.url) {
    throw new Error(`provider request did not return a finished video: HTTP ${response.status}, status ${result.status}`)
  }
} catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
const audit = new pg.Client({ connectionString })
await audit.connect()
try {
  const rows = (await audit.query("select id,status,http_status,task_id,duration_ms,request_data,response_data from model_execution_records where request_data->>'requestKey'=$1 order by created_at", [requestKey])).rows
  const current = (await audit.query('select md5(result::text) as md5 from execution_records where id=$1', [sourceId])).rows[0]
  const ledger = rows.map(row => ({ id: row.id, status: row.status, httpStatus: row.http_status, taskId: row.task_id,
    durationMs: row.duration_ms, requestHash: createJsonHasher()(row.request_data),
    finalUnitDeduction: row.response_data?.data?.final_unit_deduction,
    finalBalanceDeduction: row.response_data?.data?.final_balance_deduction }))
  const summary = { format: 'scene4-provider-task-proof-v1', requestKey, submittedAt: proof.createdAt, requestCount: rows.length,
    ledger, responseHttpStatus: response?.status ?? null, responseStatus: result?.status ?? null,
    responseVideoUrlHash: result?.body?.data?.task_result?.videos?.[0]?.url ? hash(result.body.data.task_result.videos[0].url) : null,
    error, sourceExecutionUnchanged: current?.md5 === source.md5, executionWrites: 0, workflowWrites: 0, concatRan: false }
  await writeFile(`${out}/provider-task-proof.json`, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
  if (error || !summary.sourceExecutionUnchanged || rows.length !== 1) process.exitCode = 1
} finally { await audit.end() }
