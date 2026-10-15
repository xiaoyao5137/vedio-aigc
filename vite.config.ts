import { inferCharacterVoices } from './server/voice-design-inference.ts'
import { serveGeneratedAudio } from './server/generated-audio.ts'
import { callBailianTts } from './server/bailian-tts.ts'
import { synthesizeNarrationTracks, composeNarration, cachedNarrationPicture, composeIllustrationMotionVideo, composeHistoricalMapPortraitVideo, validateHistoricalMapPortraitInputs, projectHistoricalMapPortraitPicture } from './server/independent-narration.ts'
import { projectIndependentNarration, projectIndependentOffscreenDialogue } from './server/narration-projection.ts'
import { originalVoiceSchema, publicOriginalVoice } from './server/original-character-voices.ts'
import { readVoiceMetrics } from './server/voice-metrics.ts'
import { newExecutionVoicePolicy, type VoicePolicy } from './src/voice-policy.ts'
import { voiceSchema, assertVoiceSynthesisAllowed, setCharacterVoiceAvailability, previewVoiceUpgrade, forkVoiceUpgrade, readCharacterVoice, readCharacterVoiceImpact, listProviderVoices, createCharacterElement, refreshVoiceJob, submitVoiceJob, bindVideoVoices, readVoiceListeningReview, saveVoiceListeningReview } from './server/character-voices.ts'
import { VOICE_CONTRACT_VERSION } from './src/character-voice.ts'
import type { CharacterAsset, CharacterAssetInput, CharacterEquipmentInput } from './src/character-asset.ts'
import { characterBiographySchema, characterEquipmentSchema, readCharacterAssets as readStoredCharacterAssets, createCharacterAsset as createStoredCharacterAsset, updateCharacterAsset as updateStoredCharacterAsset, deleteCharacterAsset as deleteStoredCharacterAsset, readCharacterPeople, readCharacterEquipment, createCharacterEquipment, updateCharacterEquipment, deleteCharacterEquipment } from './server/character-assets.ts'
import { recoverPendingCharacterPortrait, reviewPendingCharacterPortrait,
  type CharacterPortraitRecoverInput, type CharacterPortraitReviewInput } from './server/character-portrait-review.ts'
import { buildCustomVoiceRequest } from './server/kling-voices.ts'
import { encodeExecutionState } from './src/execution-storage.ts'
import { collectImageEvidence } from './server/image-evidence.ts'
import { archiveCoverageCutSources, persistCoverageCutFirstFrameResponse } from './server/coverage-cut-frame-storage.ts'
import { issueRecordedCoverageCutFrameApproval, validateCoverageCutPaidImageRequest, validateCoverageCutPaidVideoRequest } from './server/coverage-cut-runtime.ts'
import { archiveSceneCutSources } from './server/scene-cut-frame-storage.ts'
import { assertSceneCutAcceptedSourceLedger, assertSceneCutAcceptedSourceRecord } from './server/scene-cut-source-ledger.ts'
import { deriveSceneCutOpeningPlan } from './server/scene-cut-opening-plan.ts'
import { issueRecordedSceneCutFrameApproval, validateSceneCutPaidImageRequest, validateSceneCutPaidVideoRequest } from './server/scene-cut-frame-runtime.ts'
import { bindSceneCutRejectedEditReference,
  readSceneCutRepairVideoContext } from './server/scene-cut-rejected-edit-binder.mjs'
import { bindA8B6FreshEditReference } from './server/staged-scene-cut-a8b6-fresh-edit.mjs'
import { bindA8B6FreshV5EditReference } from './server/staged-scene-cut-a8b6-fresh-edit-v5.mjs'
import { bindA8B6FreshV6EditReference } from './server/staged-scene-cut-a8b6-fresh-edit-v6.mjs'
import { bindA8B6FreshV7EditReference } from './server/staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { bindA8B6FreshV8EditReference } from './server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { issueHistoricalMapAnnotationApproval, composeHistoricalMapAnnotationsVideo, validateHistoricalMapAnnotations } from './server/historical-map-annotations.ts'
import { issueHistoricalMapFrameApproval } from './server/historical-map-frame-approval.ts'
import { assertHistoricalMapReviewLedgerRecord } from './server/historical-map-review-ledger.ts'
import { persistHistoricalMapFrameResponse } from './server/historical-map-frame-storage.ts'
import { assertHistoricalMapCleanPlatePrompt } from './server/historical-map-clean-plate.ts'
import { buildHistoricalMapVideoReviewPrompt, collectHistoricalMapVideoPlateEvidence,
  historicalMapVideoReviewFrames, validateHistoricalMapVideoReview } from './server/historical-map-video-gate.ts'
import { createInflightModelRequests, modelRequestFingerprint } from './server/model-request-key.ts'
import { modelExecutionBindingFilters } from './server/model-execution-filters.ts'
import { withModelRequestAdvisoryLock } from './server/model-request-lock.ts'
import { persistGeneratedImageResponse } from './server/generated-image-storage.ts'
import { callRemoteText, supportsRemoteText } from './server/remote-text.ts'
import { TEXT_CHANNEL_PROBE_LIMIT, TEXT_TRANSPORT_DEADLINE_MS } from './server/anthropic-text.ts'
import { callCodexText, resolveCodexTextConfig, CodexTextError } from './server/codex-text.ts'
import { callCodexImage, resolveCodexImageConfig, CodexImageError } from './server/codex-image.ts'
import { loadCodexTextFrames } from './server/codex-reference-images.ts'
import { HISTORY_QUALITY_VERSION } from './src/history-media.ts'
import { CHARACTER_VISUAL_CONTEXT_RUNTIME_VERSION } from './src/character-visual-workflow.ts'
import { VIDEO_OUTPUT_PROFILE_VERSION } from './src/video-output-profile.ts'
import { isStaticIllustrationStyle } from './src/animation-shot.ts'
import { isHistoricalSandTable } from './src/sand-table-contract.ts'
import { upgradeSandTableWorkflow } from './src/sand-table-workflow.ts'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pg from 'pg'
import { Readable } from 'node:stream'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { loadReviewImages, reviewImagesFingerprint, type LoadedReviewImage } from './server/review-images.ts'
import path from 'node:path'
import { executeBuiltinNode } from './server/builtin-nodes.ts'
import { assertHistoricalImageProvider } from './server/history-image-policy.ts'
import { assertWorkflowSchemaNotStale, workflowConfigContentChanged } from './server/workflow-save-policy.ts'
import { assertModelProviderAllowed } from './server/provider-policy.ts'
import { executeCodeNode } from './server/code-node.ts'
import { readKnowledgeStats } from './server/knowledge.ts'
import { type KlingAdapterDependencies, buildKlingVideoRequest, callKlingImage, callKlingVideo, callOpenAiImage, fetchModelEndpoint, klingAuthorization, parseResponseBody, prepareKlingImageInputs, resolveKlingOmniVideoEndpoint, resolveKlingVideoEndpoint } from './server/model-adapters.ts'
import { retrieveInternetSources } from './server/web-sources.ts'
import type { InternetSourceInput } from './server/web-sources.ts'
import { runLocalModel } from './server/local-model.ts'
import { readJson } from './server/request-json.ts'
import { collectVideoEvidence, inspectGeneratedVideo } from './server/video-inspection.ts'
import { reviewStoryShotVideo } from './server/story-media-review.ts'
import { validateVideoMetadata } from './server/video-inspection.ts'
import { prepareWorkflowMediaRequest, validateHistoricalMapPaidImageRequest, validateWorkflowMediaContract } from './server/workflow-contracts.ts'
import { assertCurrentCharacterEquipmentBindings } from './server/character-equipment-paid-gate.ts'
import { extractTextResponse, parseStructuredJson } from './src/workflow-core.ts'

type ModelProvider = 'Bailian' | 'Anthropic' | 'Codex' | 'OpenAI' | 'Ofox' | 'Kling' | 'Local' | 'Custom'
type ModelCapability = 'text' | 'image' | 'video' | 'audio'
type Workflow = { id: string; name: string; description: string; nodes: unknown[]; edges: unknown[]; schemaVersion?: number; voicePolicy?: VoicePolicy }
type ExecutionRecord = {
  id: string
  workflowId: string
  workflowName: string
  mode: string
  title: string
  runtimeInputs: Record<string, unknown>
  result: Record<string, unknown>
  createdAt?: string
}
type ExecutionRecordSummary = Omit<ExecutionRecord, 'runtimeInputs' | 'result'> & {
  succeededCount: number
  failedCount: number
  totalCount: number
}
type ModelConfig = {
  id: string
  name: string
  provider: ModelProvider
  capability: ModelCapability
  settings: Record<string, string>
  testInput: string
  testResult: string
}
type AppConfig = { models: ModelConfig[]; workflows: Workflow[] }
type ModelTestRequest = { model: ModelConfig; params?: Record<string, unknown> }
type ModelTestStatusRequest = ModelTestRequest & { taskId: string; queryMode?: string }
type NodeRunRequest = {
  model: ModelConfig
  prompt: string
  params: Record<string, unknown>
  operation?: string
  executionContext?: { knownVoiceSpeakers?: string[]; voiceExecutionId?: string; voicePolicy?: string; requestKey?: string; workflowId?: string; workflowName?: string; nodeId?: string; nodeName?: string }
}
type ModelExecutionChannel = 'experience' | 'workflow'
type ModelExecutionRecord = {
  id: string
  channel: ModelExecutionChannel
  modelId: string
  modelName: string
  provider: string
  capability: string
  status: string
  httpStatus?: number
  taskId?: string
  workflowId?: string
  workflowName?: string
  nodeId?: string
  nodeName?: string
  requestData: unknown
  responseData?: unknown
  error?: string
  durationMs: number
  createdAt?: string
  updatedAt?: string
}

const { Pool } = pg
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'
const pool = new Pool({ connectionString: databaseUrl })
let schemaReady: Promise<void> | undefined

function jsonResponse(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    const cause = error.cause && typeof error.cause === 'object' ? error.cause as { code?: unknown; message?: unknown } : undefined
    const causeCode = typeof cause?.code === 'string' ? cause.code : ''
    const causeMessage = typeof cause?.message === 'string' ? cause.message : ''
    if (causeMessage && causeMessage !== error.message) return `${error.message}（${causeCode ? `${causeCode}: ` : ''}${causeMessage}）`
    return error.message
  }
  if (error && typeof error === 'object') return JSON.stringify(error)
  return String(error)
}

function ensureSchema() {
  schemaReady ??= (async () => {
    await pool.query(`
      ${voiceSchema}
      ${originalVoiceSchema}
      ${characterBiographySchema}
      ${characterEquipmentSchema}
      create table if not exists model_configs (
        id text primary key,
        name text not null,
        provider text not null,
        capability text not null,
        settings jsonb not null default '{}'::jsonb,
        test_input text not null default '',
        test_result text not null default '',
        updated_at timestamptz not null default now()
      );

      create table if not exists workflow_configs (
        id text primary key,
        name text not null,
        description text not null default '',
        nodes jsonb not null default '[]'::jsonb,
        edges jsonb not null default '[]'::jsonb,
        schema_version integer not null default 1,
        updated_at timestamptz not null default now()
      );

      alter table workflow_configs add column if not exists schema_version integer not null default 1;
      alter table workflow_configs add column if not exists voice_policy text;

      create table if not exists execution_records (
        id text primary key,
        workflow_id text not null,
        workflow_name text not null,
        mode text not null,
        title text not null,
        runtime_inputs jsonb not null default '{}'::jsonb,
        result jsonb not null default '{}'::jsonb,
        succeeded_count integer,
        failed_count integer,
        total_count integer,
        created_at timestamptz not null default now()
      );

      alter table execution_records add column if not exists succeeded_count integer;
      alter table execution_records add column if not exists failed_count integer;
      alter table execution_records add column if not exists total_count integer;

      update execution_records
         set succeeded_count = coalesce(succeeded_count, (
               select count(*) from jsonb_array_elements(coalesce(result -> 'nodeRuns', '[]'::jsonb)) run
                where run ->> 'status' = 'success'
             )),
             failed_count = coalesce(failed_count, (
               select count(*) from jsonb_array_elements(coalesce(result -> 'nodeRuns', '[]'::jsonb)) run
                where run ->> 'status' = 'failed'
             )),
             total_count = coalesce(total_count, jsonb_array_length(coalesce(result -> 'nodeRuns', '[]'::jsonb)))
       where succeeded_count is null or failed_count is null or total_count is null;

      alter table execution_records alter column succeeded_count set default 0;
      alter table execution_records alter column failed_count set default 0;
      alter table execution_records alter column total_count set default 0;

      create index if not exists execution_records_workflow_created_idx
        on execution_records (workflow_id, created_at desc);

      create table if not exists model_execution_records (
        id text primary key,
        channel text not null,
        model_id text not null,
        model_name text not null,
        provider text not null,
        capability text not null,
        status text not null,
        http_status integer,
        task_id text,
        workflow_id text,
        workflow_name text,
        node_id text,
        node_name text,
        request_data jsonb not null default '{}'::jsonb,
        response_data jsonb,
        error text,
        duration_ms integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists model_execution_records_created_idx
        on model_execution_records (created_at desc);
      create index if not exists model_execution_records_filters_idx
        on model_execution_records (channel, model_id, status, created_at desc);
      create index if not exists model_execution_records_task_idx
        on model_execution_records (task_id) where task_id is not null;

      create table if not exists knowledge_documents (
        id text primary key,
        title text not null,
        source text not null,
        edition text not null default '',
        url text not null default '',
        metadata jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      );

      create table if not exists knowledge_chunks (
        id text primary key,
        document_id text not null references knowledge_documents(id) on delete cascade,
        ordinal integer not null default 0,
        content text not null,
        embedding jsonb not null default '[]'::jsonb,
        metadata jsonb not null default '{}'::jsonb
      );

      create index if not exists knowledge_chunks_document_idx
        on knowledge_chunks (document_id, ordinal);

      create table if not exists character_assets (
        id text primary key,
        character_name text not null,
        asset_type text not null,
        uri text not null,
        prompt text not null default '',
        version integer not null default 1,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists character_assets_lookup_idx
        on character_assets (character_name, asset_type, updated_at desc);

      alter table character_assets add column if not exists workflow_id text;
      create index if not exists character_assets_workflow_idx
        on character_assets (workflow_id, updated_at desc);
    `)
  })()
    .catch((error) => {
      schemaReady = undefined
      throw error
    })
  return schemaReady
}

async function readCharacterAssets(workflowId?: string, includeShared = false): Promise<CharacterAsset[]> {
  await ensureSchema()
  return readStoredCharacterAssets(pool, workflowId, includeShared)
}

async function createCharacterAsset(input: CharacterAssetInput): Promise<CharacterAsset> {
  await ensureSchema()
  return createStoredCharacterAsset(pool, input)
}

async function updateCharacterAsset(id: string, input: CharacterAssetInput): Promise<CharacterAsset> {
  await ensureSchema()
  return updateStoredCharacterAsset(pool, id, input)
}

async function deleteCharacterAsset(id: string) {
  await ensureSchema()
  return deleteStoredCharacterAsset(pool, id)
}

async function readExecutionRecords(workflowId?: string): Promise<ExecutionRecordSummary[]> {
  await ensureSchema()
  const result = workflowId
    ? await pool.query(
        'select id, workflow_id, workflow_name, mode, title, succeeded_count, failed_count, total_count, created_at from execution_records where workflow_id = $1 order by created_at desc limit 40',
        [workflowId],
      )
    : await pool.query('select id, workflow_id, workflow_name, mode, title, succeeded_count, failed_count, total_count, created_at from execution_records order by created_at desc limit 40')
  return result.rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    mode: row.mode,
    title: row.title,
    succeededCount: row.succeeded_count,
    failedCount: row.failed_count,
    totalCount: row.total_count,
    createdAt: row.created_at,
  }))
}

async function readExecutionRecord(id: string): Promise<ExecutionRecord | undefined> {
  await ensureSchema()
  const result = await pool.query(
    'select id, workflow_id, workflow_name, mode, title, runtime_inputs, result, created_at from execution_records where id = $1',
    [id],
  )
  const row = result.rows[0]
  if (!row) return undefined
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    mode: row.mode,
    title: row.title,
    runtimeInputs: row.runtime_inputs,
    result: encodeExecutionState(row.result),
    createdAt: row.created_at,
  }
}

async function saveExecutionRecord(record: ExecutionRecord) {
  await ensureSchema()
  const nodeRuns = Array.isArray((record.result as { nodeRuns?: unknown[] }).nodeRuns)
    ? (record.result as { nodeRuns: Array<{ status?: string }> }).nodeRuns
    : []
  const succeededCount = nodeRuns.filter((run) => run.status === 'success').length
  const failedCount = nodeRuns.filter((run) => run.status === 'failed').length
  await pool.query(
    `
      insert into execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count, created_at)
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, now())
      on conflict (id) do update set
        workflow_id = excluded.workflow_id,
        workflow_name = excluded.workflow_name,
        mode = excluded.mode,
        title = excluded.title,
        runtime_inputs = excluded.runtime_inputs,
        result = excluded.result,
        succeeded_count = excluded.succeeded_count,
        failed_count = excluded.failed_count,
        total_count = excluded.total_count
    `,
    [record.id, record.workflowId, record.workflowName, record.mode, record.title, JSON.stringify(record.runtimeInputs), JSON.stringify(encodeExecutionState(record.result)), succeededCount, failedCount, nodeRuns.length],
  )
}

function safeExecutionPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value) || (value.length > 10000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value))) return `[素材内容已隐藏，${value.length} 字符]`
    if (value.length > 100000) return `${value.slice(0, 100000)}[日志截断，共${value.length}字符]`
    return value
  }
  if (Array.isArray(value)) return value.map(safeExecutionPayload)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, /apiKey|accessKey|secretKey|authorization/i.test(key) ? '[hidden]' : safeExecutionPayload(child)]))
  }
  return value
}

async function recordedHistoricalMapReview(nodeId: string, review: unknown, expectedParams: Record<string, unknown>) {
  await ensureSchema()
  const records = await pool.query(`select id, channel, workflow_id, node_id, capability, provider, status,
      request_data, response_data from model_execution_records
    where workflow_id='wf-sanguo-history-drama' and node_id=$1 and capability='text' and status='succeeded'
      and request_data->'params' @> $2::jsonb
    order by created_at desc limit 30`, [nodeId, JSON.stringify(expectedParams)])
  for (const record of records.rows) {
    try { return assertHistoricalMapReviewLedgerRecord(record, nodeId, review, expectedParams) } catch { /* Check the next recorded review. */ }
  }
  throw new Error('HISTORICAL_MAP_REVIEW_UNRECORDED: 服务端未找到匹配当前输入、受管理提示词和原始响应的独立审核模型执行记录')
}

async function historicalMapVideoReviewer() {
  const config = await readAppConfig()
  const workflow = config.workflows.find(item => item.id === 'wf-sanguo-history-drama')
  const reviewerNode = workflow?.nodes.find(item => item && typeof item === 'object'
    && (item as { id?: string }).id === 'sanguo-map-first-review') as { modelId?: string } | undefined
  const model = config.models.find(item => item.id === reviewerNode?.modelId)
  if (!model || model.capability !== 'text' || (model.provider !== 'Codex' && !supportsRemoteText(model))) {
    throw Error('HISTORICAL_MAP_VIDEO_REVIEW_UNAVAILABLE: 缺少已配置的独立视觉审核模型，已阻止地图视频付费请求')
  }
  return model
}

async function reviewHistoricalMapSupplierVideo(videoUrl: string, shot: unknown, duration: number, aspectRatio: string,
  reviewer: ModelConfig, workflowName = '三国历史剧情') {
  const evidence = await collectHistoricalMapVideoPlateEvidence(videoUrl)
  validateVideoMetadata({ format: { duration: evidence.duration }, streams: [
    { codec_type: 'video', width: evidence.width, height: evidence.height, duration: evidence.duration },
    ...(evidence.hasAudio ? [{ codec_type: 'audio' }] : []),
  ] }, duration, aspectRatio, true)
  const references = historicalMapVideoReviewFrames(evidence)
  const reviewImages = references.map(item => String(item.url))
  const reviewFrames = await loadReviewImages(reviewImages)
  const prompt = buildHistoricalMapVideoReviewPrompt(evidence, shot)
  const reviewRequest: NodeRunRequest = { model: reviewer, prompt, params: { reviewImages, temperature: 0 },
    operation: 'history.map-video-review' }
  const fingerprint = reviewImagesFingerprint(modelRequestFingerprint(reviewRequest), reviewFrames)
  await ensureSchema()
  const previous = await pool.query(`select id,response_data from model_execution_records
    where workflow_id='wf-sanguo-history-drama' and node_id='sanguo-map-video-review' and status='succeeded'
      and request_data->>'fingerprint'=$1 and request_data->>'sourceVideoSha256'=$2
    order by created_at desc limit 1`, [fingerprint, evidence.sha256])
  let reviewBody = previous.rows[0]?.response_data
  let reviewExecutionId = previous.rows[0]?.id as string | undefined
  if (!reviewBody) {
    const startedAt = Date.now()
    reviewExecutionId = `model-run-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
    const response = await callNodeExternalUntracked(reviewRequest, {}, reviewFrames).catch(error => {
      throw Error(`HISTORICAL_MAP_VIDEO_REVIEW_FAILED: ${errorMessage(error)}；付费原片已保存 ${evidence.url}，采证 ${evidence.evidenceUrl}`)
    })
    reviewBody = response.body
    const reviewImageHashes = reviewFrames.map(frame => ({ url: frame.url, sha256: createHash('sha256').update(frame.bytes).digest('hex') }))
    await pool.query(`insert into model_execution_records
      (id,channel,model_id,model_name,provider,capability,status,http_status,workflow_id,workflow_name,node_id,node_name,
       request_data,response_data,error,duration_ms)
      values ($1,'workflow',$2,$3,$4,'text',$5,$6,'wf-sanguo-history-drama',$7,'sanguo-map-video-review',
       '历史地图供应商原片中间帧审核',$8::jsonb,$9::jsonb,$10,$11)`,
    [reviewExecutionId, reviewer.id, reviewer.name, reviewer.provider,
      response.status < 400 ? 'succeeded' : 'failed', response.status, workflowName,
      JSON.stringify(safeExecutionPayload({ operation: reviewRequest.operation, fingerprint, prompt, params: reviewRequest.params,
        evidenceUrl: evidence.evidenceUrl, sourceVideoSha256: evidence.sha256, reviewImageHashes })),
      JSON.stringify(safeExecutionPayload(reviewBody)), response.status >= 400 ? JSON.stringify(reviewBody).slice(0, 1000) : null,
      Date.now() - startedAt])
    if (response.status >= 400) throw Error(`HISTORICAL_MAP_VIDEO_REVIEW_FAILED: 独立视觉模型 HTTP ${response.status}；付费原片已保存 ${evidence.url}，采证 ${evidence.evidenceUrl}`)
  }
  const review = parseStructuredJson(extractTextResponse(reviewBody))
  let acceptance: ReturnType<typeof validateHistoricalMapVideoReview>
  try { acceptance = validateHistoricalMapVideoReview(review, evidence) }
  catch (error) { throw Error(`${errorMessage(error)}；付费原片已保存 ${evidence.url}，采证 ${evidence.evidenceUrl}`, { cause: error }) }
  return { ...acceptance, reviewExecutionId, sourceVideoUrl: evidence.url, evidence,
    originalSupplierUrl: videoUrl }
}

function executionTaskInfo(body: unknown) {
  const root = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {}
  const taskId = String(data.task_id ?? root.task_id ?? root.taskId ?? '')
  const providerStatus = String(data.task_status ?? root.task_status ?? root.status ?? '').toLowerCase()
  return { taskId, providerStatus }
}

function modelExecutionStatus(httpStatus: number, body: unknown) {
  const { providerStatus, taskId } = executionTaskInfo(body)
  if (httpStatus === 504 && taskId && /submit|process|running|pending|queue|wait/.test(providerStatus)) return 'processing'
  if (httpStatus >= 400) return 'failed'
  if (/fail|error|cancel/.test(providerStatus)) return 'failed'
  if (/succeed|success|complete|completed/.test(providerStatus)) return 'succeeded'
  if (taskId || /submit|process|running|pending|queue|wait/.test(providerStatus)) return 'processing'
  return 'succeeded'
}

async function saveModelExecutionRecord(record: ModelExecutionRecord): Promise<boolean> {
  try {
    await ensureSchema()
    await pool.query(
      `insert into model_execution_records
        (id, channel, model_id, model_name, provider, capability, status, http_status, task_id,
         workflow_id, workflow_name, node_id, node_name, request_data, response_data, error, duration_ms, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, nullif($9, ''), $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, now())
       on conflict (id) do update set status=excluded.status, http_status=excluded.http_status,
         task_id=coalesce(excluded.task_id,model_execution_records.task_id), response_data=excluded.response_data,
         error=excluded.error,duration_ms=excluded.duration_ms,updated_at=now()`,
      [record.id, record.channel, record.modelId, record.modelName, record.provider, record.capability, record.status,
        record.httpStatus ?? null, record.taskId ?? '', record.workflowId ?? null, record.workflowName ?? null,
        record.nodeId ?? null, record.nodeName ?? null, JSON.stringify(safeExecutionPayload(record.requestData)),
        JSON.stringify(safeExecutionPayload(record.responseData)), record.error ?? null, record.durationMs],
    )
    return true
  } catch {
    // 流水持久化失败不能阻断真实模型调用。
    return false
  }
}

async function updateModelExecutionByTask(taskId: string, httpStatus: number, body: unknown, durationMs: number) {
  if (!taskId) return
  try {
    await ensureSchema()
    const status = modelExecutionStatus(httpStatus, body)
    const error = status === 'failed' ? JSON.stringify(safeExecutionPayload(body)).slice(0, 1000) : null
    await pool.query(
      `update model_execution_records
          set status = $2, http_status = $3, response_data = $4::jsonb, error = $5,
              duration_ms = greatest(duration_ms, $6), updated_at = now()
        where id = (select id from model_execution_records where task_id = $1 order by created_at desc limit 1)`,
      [taskId, status, httpStatus, JSON.stringify(safeExecutionPayload(body)), error, durationMs],
    )
  } catch {
    // 查询结果正常返回优先于流水更新。
  }
}

async function readModelExecutionRecords(url: URL): Promise<ModelExecutionRecord[]> {
  await ensureSchema()
  const clauses: string[] = []
  const values: unknown[] = []
  const addFilter = (column: string, value: string | null) => {
    if (!value) return
    values.push(value)
    clauses.push(`${column} = $${values.length}`)
  }
  addFilter('channel', url.searchParams.get('channel'))
  addFilter('model_id', url.searchParams.get('modelId'))
  addFilter('status', url.searchParams.get('status'))
  addFilter('capability', url.searchParams.get('capability'))
  const bindingFilters = modelExecutionBindingFilters(url.searchParams, values.length)
  clauses.push(...bindingFilters.clauses)
  values.push(...bindingFilters.values)
  const keyword = url.searchParams.get('keyword')?.trim()
  if (keyword) {
    values.push(`%${keyword}%`)
    clauses.push(`(model_name ilike $${values.length} or task_id ilike $${values.length} or workflow_name ilike $${values.length} or node_name ilike $${values.length} or id ilike $${values.length})`)
  }
  values.push(Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200)))
  const result = await pool.query(
    `select id, channel, model_id, model_name, provider, capability, status, http_status, task_id,
            workflow_id, workflow_name, node_id, node_name, request_data, response_data, error,
            duration_ms, created_at, updated_at
       from model_execution_records
       ${clauses.length ? `where ${clauses.join(' and ')}` : ''}
      order by created_at desc limit $${values.length}`,
    values,
  )
  return result.rows.map((row) => ({
    id: row.id, channel: row.channel, modelId: row.model_id, modelName: row.model_name,
    provider: row.provider, capability: row.capability, status: row.status, httpStatus: row.http_status,
    taskId: row.task_id, workflowId: row.workflow_id, workflowName: row.workflow_name,
    nodeId: row.node_id, nodeName: row.node_name, requestData: row.request_data,
    responseData: row.response_data, error: row.error, durationMs: row.duration_ms,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }))
}

async function readAppConfig(): Promise<AppConfig> {
  await ensureSchema()
  const [models, workflows] = await Promise.all([
    pool.query('select id, name, provider, capability, settings, test_input, test_result from model_configs order by updated_at, id'),
    pool.query('select id, name, description, nodes, edges, schema_version, voice_policy from workflow_configs order by updated_at, id'),
  ])
  return {
    models: models.rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      capability: row.capability,
      settings: row.settings,
      testInput: row.test_input,
      testResult: row.test_result,
    })),
    workflows: workflows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      nodes: row.nodes,
      edges: row.edges,
      schemaVersion: row.schema_version,
      voicePolicy: newExecutionVoicePolicy(row.voice_policy),
    })),
  }
}

async function saveModels(models: ModelConfig[]) {
  await ensureSchema()
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('delete from model_configs where not (id = any($1::text[]))', [models.map((model) => model.id)])
    for (const model of models) {
      await client.query(
        `
          insert into model_configs (id, name, provider, capability, settings, test_input, test_result, updated_at)
          values ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
          on conflict (id) do update set
            name = excluded.name,
            provider = excluded.provider,
            capability = excluded.capability,
            settings = excluded.settings,
            test_input = excluded.test_input,
            test_result = excluded.test_result,
            updated_at = now()
        `,
        [model.id, model.name, model.provider, model.capability, JSON.stringify(model.settings), model.testInput, model.testResult],
      )
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function saveWorkflows(workflows: Workflow[]) {
  await ensureSchema()
  const client = await pool.connect()
  try {
    await client.query('begin')
    // A tab opened before a migration still holds the older workflow in memory and re-saves the
    // whole array on every change, which silently reverted an already-deployed schema upgrade and
    // undid the fix it carried. Never move a workflow backwards; the tab must reload to pick up
    // the newer persisted state. User edits keep or raise schemaVersion, so they are unaffected.
    const stored = await client.query(`select id,name,description,nodes,edges,schema_version,voice_policy
      from workflow_configs where id = any($1::text[]) for update`, [workflows.map((workflow) => workflow.id)])
    const storedById = new Map(stored.rows.map((row) => [String(row.id), row]))
    for (const workflow of workflows) {
      if (workflow.voicePolicy !== undefined) newExecutionVoicePolicy(workflow.voicePolicy)
      const persisted = Number(storedById.get(workflow.id)?.schema_version ?? 0)
      const incoming = workflow.schemaVersion ?? 1
      assertWorkflowSchemaNotStale(workflow.id, incoming, persisted)
    }
    // A same-version tab may still lack newly managed map gate parameters.
    // Reapply the narrowly scoped migration after the downgrade check so a
    // stale save cannot erase the paid-request safeguards at schema 154.
    const normalizedWorkflows = workflows.map(workflow => upgradeSandTableWorkflow(workflow as never) as Workflow)
    await client.query('delete from workflow_configs where not (id = any($1::text[]))', [normalizedWorkflows.map((workflow) => workflow.id)])
    for (const workflow of normalizedWorkflows) {
      if (!workflowConfigContentChanged(storedById.get(workflow.id), workflow)) continue
      await client.query(
        `
          insert into workflow_configs (id, name, description, nodes, edges, schema_version, voice_policy, updated_at)
          values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, now())
          on conflict (id) do update set
            name = excluded.name,
            description = excluded.description,
            nodes = excluded.nodes,
            edges = excluded.edges,
            schema_version = excluded.schema_version,
            voice_policy = coalesce(excluded.voice_policy, workflow_configs.voice_policy),
            updated_at = now()
          where workflow_configs.name is distinct from excluded.name
            or workflow_configs.description is distinct from excluded.description
            or workflow_configs.nodes is distinct from excluded.nodes
            or workflow_configs.edges is distinct from excluded.edges
            or workflow_configs.voice_policy is distinct from coalesce(excluded.voice_policy, workflow_configs.voice_policy)
        `,
        [workflow.id, workflow.name, workflow.description, JSON.stringify(workflow.nodes), JSON.stringify(workflow.edges), workflow.schemaVersion ?? 1, workflow.voicePolicy ?? null],
      )
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function callExternal(model: ModelConfig, params: Record<string, unknown> = {}) {
  assertModelProviderAllowed(model)
  const settings = model.settings

  if (model.provider === 'Local') {
    return { status: 200, body: runLocalModel({ capability: model.capability, prompt: model.testInput, params: { ...settings, ...params } }) }
  }

  if (supportsRemoteText(model)) {
    return callRemoteText(model, model.testInput, params)
  }

  if (model.provider === 'Codex') {
    if (model.capability === 'image') return callCodexImage(resolveCodexImageConfig(model, params), model.testInput)
    const config = resolveCodexTextConfig(model, params)
    const frames = await loadCodexTextFrames(params)
    return callCodexText(config, model.testInput, frames)
  }

  if ((model.provider === 'OpenAI' || model.provider === 'Ofox') && model.capability === 'image') {
    return callOpenAiImage(model, model.testInput, params)
  }

  if (model.provider === 'Bailian' && model.capability === 'audio') return callBailianTts(model, model.testInput, params)

  if (model.provider === 'OpenAI' && model.capability === 'audio') {
    if (!settings.apiKey) throw new Error('缺少 OpenAI API Key')
    const response = await fetchModelEndpoint(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        input: model.testInput,
        voice: String(params.voice ?? settings.voice ?? 'alloy'),
        response_format: String(params.responseFormat ?? settings.responseFormat ?? 'mp3'),
        speed: Number(params.speed ?? settings.speed ?? 1),
      }),
    })
    const contentType = response.headers.get('content-type') || 'audio/mpeg'
    const body = response.ok
      ? { url: `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}` }
      : await parseResponseBody(response)
    return { status: response.status, body }
  }

  if (model.provider === 'Kling' && model.capability === 'image') {
    return callKlingImage(model, model.testInput, params)
  }

  if (model.provider === 'Kling') {
    const preparedParams = await prepareKlingImageInputs(params)
    const requestBody = buildKlingVideoRequest(model, model.testInput, preparedParams)
    const endpoint = Array.isArray(requestBody.image_list)
      ? resolveKlingOmniVideoEndpoint(settings.endpoint)
      : resolveKlingVideoEndpoint(settings.endpoint, Boolean(requestBody.image))
    const response = await fetchModelEndpoint(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: klingAuthorization(settings),
      },
      body: JSON.stringify(requestBody),
    })
    return { status: response.status, body: await parseResponseBody(response) }
  }

  throw new Error(`${model.provider} ${model.capability} 暂无真实模型适配器`)
}

async function queryModelTestTask({ model, taskId, queryMode }: ModelTestStatusRequest) {
  assertModelProviderAllowed(model)
  if (model.provider !== 'Kling') throw new Error(`${model.provider} 暂不支持异步任务查询`)
  if (!taskId.trim()) throw new Error('缺少任务 ID')
  const baseEndpoint = model.settings.endpoint
  const endpoints = model.capability === 'video'
    ? {
        text2video: resolveKlingVideoEndpoint(baseEndpoint, false),
        image2video: resolveKlingVideoEndpoint(baseEndpoint, true),
        'omni-video': resolveKlingOmniVideoEndpoint(baseEndpoint),
      }
    : { image: baseEndpoint.replace(/\/$/, '') }
  const preferred = queryMode && queryMode in endpoints ? queryMode as keyof typeof endpoints : undefined
  const orderedEndpoints = [...new Set([
    ...(preferred ? [endpoints[preferred]] : []),
    ...Object.values(endpoints),
  ])]
  let lastResult: { status: number; body: unknown } = { status: 404, body: { error: '未找到任务' } }
  for (const endpoint of orderedEndpoints) {
    const response = await fetchModelEndpoint(`${endpoint}/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: { Authorization: klingAuthorization(model.settings) },
    })
    const body = await parseResponseBody(response)
    const code = body && typeof body === 'object' && 'code' in body ? Number((body as { code?: unknown }).code) : 0
    lastResult = { status: response.ok && code !== 0 ? 502 : response.status, body }
    if (response.ok && code === 0) return lastResult
  }
  return lastResult
}

async function callNodeExternalUntracked({ model, prompt, params, operation, executionContext }: NodeRunRequest, klingDependencies: KlingAdapterDependencies = {}, reviewFrames?: readonly LoadedReviewImage[]) {
  const settings = model.settings
  if (operation === 'character.voice-design') return { status: 200, body: await inferCharacterVoices(model, prompt, params) }

  if (model.provider === 'Local') {
    return { status: 200, body: runLocalModel({ capability: model.capability, operation, prompt, params }) }
  }

  if (supportsRemoteText(model)) {
    return callRemoteText(model, prompt, params, operation, reviewFrames)
  }

  if (model.provider === 'Codex') {
    if (model.capability === 'image') return callCodexImage(resolveCodexImageConfig(model, params), prompt)
    const config = resolveCodexTextConfig(model, params)
    const frames = reviewFrames ?? await loadCodexTextFrames(params)
    return callCodexText(config, prompt, frames)
  }

  if ((model.provider === 'OpenAI' || model.provider === 'Ofox') && model.capability === 'image') {
    return callOpenAiImage(model, prompt, params)
  }

  if (model.provider === 'Bailian' && model.capability === 'audio') return callBailianTts(model, prompt, params)

  if (model.provider === 'OpenAI' && model.capability === 'audio') {
    if (!settings.apiKey) throw new Error('缺少 OpenAI API Key')
    const response = await fetchModelEndpoint(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        input: prompt,
        voice: String(params.voice ?? settings.voice ?? 'alloy'),
        response_format: String(params.responseFormat ?? settings.responseFormat ?? 'mp3'),
        speed: Number(params.speed ?? settings.speed ?? 1),
      }),
    })
    const contentType = response.headers.get('content-type') || 'audio/mpeg'
    const body = response.ok
      ? { url: `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}` }
      : await parseResponseBody(response)
    return { status: response.status, body }
  }

  if (model.provider === 'Kling' && model.capability === 'image') {
    return callKlingImage(model, prompt, params, klingDependencies)
  }

  if (model.provider === 'Kling') {
    const historicalMapLayers = isHistoricalSandTable(params) && params.animationAesthetic === 'historical_cartography'
    if (historicalMapLayers) validateHistoricalMapAnnotations(params.mapAnnotations, params.mapAnnotationApproval, Number(params.duration))
    if (historicalMapLayers && (!params.narrationVoice || params.offscreenDialogueVoice || params.audioType !== '旁白')) {
      throw Error('HISTORICAL_MAP_NARRATION_REQUIRED: 历史地图只接受独立画外旁白，禁止回退到视频模型人声或无审核直出')
    }
    const historicalMapReviewer = historicalMapLayers ? await historicalMapVideoReviewer() : undefined
    const hasMapPortraitLayers = params.animationStyle === 'historical_map' && Array.isArray(params.illustrationLayers) && params.illustrationLayers.length > 0
    if (hasMapPortraitLayers && !isHistoricalSandTable(params)) throw Error('MAP_PORTRAIT_INVALID: 静态人物叠层仅适用于已批准的历史地图信息镜头')
    if (hasMapPortraitLayers && (!params.narrationVoice || params.offscreenDialogueVoice || params.audioType !== '旁白')) {
      throw Error('MAP_PORTRAIT_INVALID: 地图人物静态图层只能使用独立画外旁白，禁止回退到视频模型直出')
    }
    if (params.narrationVoice || params.offscreenDialogueVoice) {
      const dialogue = Boolean(params.offscreenDialogueVoice)
      if (dialogue && isStaticIllustrationStyle(params.visualTreatment, params.animationStyle)) throw Error('VOICE_PROVIDER_UNSUPPORTED: 静态插画的匿名角色对白尚未支持，禁止改为旁白或伪造口型证据')
      const mapPortraits = hasMapPortraitLayers
      if (mapPortraits) {
        await validateHistoricalMapPortraitInputs(params.referenceImages, params.referenceBindings, params.illustrationLayers,
          Number(params.duration), process.cwd())
      }
      const voice = (params.offscreenDialogueVoice ?? params.narrationVoice) as Parameters<typeof synthesizeNarrationTracks>[1]
      const tts = (await pool.query('select id,name,provider,capability,settings from model_configs where id=$1', [voice.modelId])).rows[0]
      if (!tts) throw Error('VOICE_PROVIDER_UNSUPPORTED: 旁白 TTS 模型配置不存在')
      const projection = dialogue ? projectIndependentOffscreenDialogue(prompt, params) : projectIndependentNarration(prompt, params)
      let tracks = historicalMapLayers ? [] : await synthesizeNarrationTracks(tts, voice, projection.segments)
      if (isStaticIllustrationStyle(params.visualTreatment, params.animationStyle)) {
        const referenceImage = String(params.referenceImage ?? '').trim()
        if (!referenceImage) throw Error('STATIC_ILLUSTRATION_INVALID: 静态插画缺少已生成首图')
        const illustration = await composeIllustrationMotionVideo(referenceImage,
          Array.isArray(params.referenceImages) ? params.referenceImages.filter((value): value is string => typeof value === 'string') : [],
          projection.duration, String(params.aspectRatio ?? '16:9'), process.cwd(),
          Array.isArray(params.referenceBindings) ? params.referenceBindings : [], params.illustrationLayers)
        const narration = await composeNarration(illustration.url, tracks, projection.duration, String(params.aspectRatio ?? '16:9'))
        return { status: 200, body: { code: 0, data: { task_status: 'succeed', task_result: { videos: [{ url: narration.url, duration: String(narration.metadata.duration) }] } },
          message: 'SUCCEED', staticIllustration: illustration, narration, voiceManifest: params.voiceManifest,
          voiceConsistency: { status: 'locked', reason: '人物插画内部无动作和口型；仅将完整人物图层做淡入、平移、缩放编排并叠加独立画外旁白' } } }
      }
      // Portrait references belong to local postproduction, never to the map
      // supplier: otherwise the model may bake them into geography or animate
      // their faces. Keep the approved map first/end frames and route motion.
      const mapPicture = historicalMapLayers || mapPortraits
        ? projectHistoricalMapPortraitPicture(projection.prompt, projection.params) : projection
      const picturePrompt = mapPicture.prompt
      const pictureParams = historicalMapLayers
        ? { ...mapPicture.params, mapAnnotations: undefined, mapAnnotationApproval: undefined,
          mapFrameGate: undefined, mapShot: undefined }
        : mapPicture.params
      if (historicalMapLayers) {
        const supplierRequest = buildKlingVideoRequest(model, picturePrompt, pictureParams)
        assertHistoricalMapCleanPlatePrompt(String(supplierRequest.prompt ?? ''))
      }
      const pictureIdentity = { modelId: model.id, requestKey: executionContext?.requestKey, voiceManifest: params.voiceManifest, prompt: picturePrompt, params: { ...pictureParams, resumeTaskId: undefined, resumeQueryMode: undefined } }
      const result = await cachedNarrationPicture(pictureIdentity, () => callKlingVideo(model, picturePrompt, pictureParams, klingDependencies))
      const body = result.body as { data?: { task_status?: string; task_result?: { videos?: Array<{ url?: string }> } } }
      const videos = body?.data?.task_result?.videos
      if (result.status < 400 && body?.data?.task_status === 'succeed' && videos?.[0]?.url) {
        const mapVideoGate = historicalMapLayers
          ? await reviewHistoricalMapSupplierVideo(videos[0].url, params.mapShot, projection.duration,
            String(params.aspectRatio ?? '16:9'), historicalMapReviewer!, executionContext?.workflowName)
          : undefined
        const annotationOverlay = historicalMapLayers
          ? await composeHistoricalMapAnnotationsVideo(mapVideoGate!.sourceVideoUrl, params.mapAnnotations, params.mapAnnotationApproval,
            projection.duration, String(params.aspectRatio ?? '16:9'), process.cwd(), params.resolution === '4k' ? '4k' : '720p')
          : undefined
        const mapPortraitOverlay = mapPortraits
          ? await composeHistoricalMapPortraitVideo(annotationOverlay?.url ?? videos[0].url,
            params.referenceImages as string[], projection.duration, String(params.aspectRatio ?? '16:9'), process.cwd(),
            params.referenceBindings as Parameters<typeof composeHistoricalMapPortraitVideo>[5], params.illustrationLayers,
            params.resolution === '4k' ? '4k' : '720p')
          : undefined
        if (historicalMapLayers) tracks = await synthesizeNarrationTracks(tts, voice, projection.segments)
        const narration = await composeNarration(mapPortraitOverlay?.url ?? annotationOverlay?.url ?? videos[0].url, tracks, projection.duration,
          String(params.aspectRatio ?? '16:9'), process.cwd(), params.resolution === '4k' ? '4k' : '720p',
          dialogue ? 'offscreen-dialogue' : 'narration')
        return { ...result, body: { ...body, data: { ...body.data, task_result: { ...body.data.task_result, videos: videos.map((video, i) => i === 0 ? { ...video, url: narration.url } : video) } },
          ...(dialogue ? { offscreenDialogue: { ...narration, characterName: voice.characterName }, characterVoices: [{ ...voice, version: 1 }] } : { narration }),
          ...(annotationOverlay ? { mapAnnotationOverlay: annotationOverlay } : {}),
          ...(mapPortraitOverlay ? { mapPortraitOverlay } : {}),
          ...(mapVideoGate ? { mapVideoGate } : {}),
          voiceManifest: params.voiceManifest, voiceConsistency: narration.voiceConsistency } }
      }
      return result
    }
    return callKlingVideo(model, prompt, params, klingDependencies)
  }

  throw new Error(`${model.provider} ${model.capability} 暂无真实节点适配器`)
}

const shareModelRequest = createInflightModelRequests()
function modelFailureType(body: unknown) {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? String((body as { error?: { type?: unknown } }).error?.type ?? '') : ''
}

async function callNodeExternal(request: NodeRunRequest) {
  assertModelProviderAllowed(request.model)
  assertHistoricalImageProvider(request)
  const key = request.executionContext?.requestKey
  const requestIdentity = key ? `${key}:${modelRequestFingerprint(request)}` : undefined
  return shareModelRequest(requestIdentity, () => withModelRequestAdvisoryLock(pool,
    request.model.capability === 'text' ? requestIdentity : undefined, async () => {
    const primary = await callNodeExternalOnce(request)
    if (modelFailureType(primary.body) !== 'MODEL_TRANSPORT_FAILOVER_READY') return primary
    const fallbackId = String(request.params.transportFallbackModelId ?? '').trim()
    if (!fallbackId || fallbackId === request.model.id || request.model.capability !== 'text') return primary
    const fallback = (await readAppConfig()).models.find(model => model.id === fallbackId && model.capability === 'text')
    const supportedFallback = fallback && (supportsRemoteText(fallback) || fallback.provider === 'Codex')
    if (!fallback || !supportedFallback) {
      return { status: 422, body: { error: { type: 'MODEL_TRANSPORT_FALLBACK_INVALID',
        message: `显式备用文本模型 ${fallbackId} 不存在或协议不受支持，未继续盲重试。`, retryable: false } } }
    }
    const fallbackParams = { ...request.params }
    // A fallback is a different recovery dimension, not a fresh ten-minute blind-retry budget.
    // Reuse the explicit transport cap so a degraded gateway cannot multiply the delay again.
    fallbackParams.primaryTransportAttempts = request.params.primaryTransportAttempts
    if (request.params.transportFallbackTimeoutMs !== undefined) fallbackParams.timeoutMs = request.params.transportFallbackTimeoutMs
    if (request.params.transportFallbackReasoningEffort !== undefined) fallbackParams.reasoningEffort = request.params.transportFallbackReasoningEffort
    const recovered = await callNodeExternalOnce({ ...request, model: fallback, params: fallbackParams })
    const transportFailover = { version: 'text-transport-failover-v1', fromModelId: request.model.id,
      toModelId: fallback.id, reason: 'MODEL_TRANSPORT_FAILOVER_READY', primaryAttempts: (primary as { transport?: { attempts?: unknown[] } }).transport?.attempts?.length }
    return recovered.body && typeof recovered.body === 'object' && !Array.isArray(recovered.body)
      ? { ...recovered, body: { ...recovered.body, transportFailover } }
      : recovered
  }))
}

function reusableMediaReview(body: unknown) {
  try {
    const content = (body as { content?: Array<{ type?: string; text?: string }> })?.content
    const text = content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    return Array.isArray(value.people) && typeof value.setting === 'string'
      && value.people.every((person: Record<string, unknown>) => ['position', 'clothing', 'headwear', 'pose'].every(key => typeof person[key] === 'string'))
  } catch { return false }
}

async function callNodeExternalOnce(request: NodeRunRequest) {
  const startedAt = Date.now()
  const id = `model-run-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  let submittedTaskId = ''
  let resumeQueryMode = ''
  let voicePreparationMs: number | undefined
  let fingerprint = modelRequestFingerprint(request)
  let sceneCutRepairBinding: Awaited<ReturnType<typeof bindSceneCutRejectedEditReference>> | undefined
  let freshEditBinding: Awaited<ReturnType<typeof bindA8B6FreshEditReference>> | undefined
  try {
    if (request.operation?.startsWith('history.') && request.prompt.includes('[object Object]')) throw new Error('HISTORY_INPUT_SERIALIZATION: 历史资料被错误转成 [object Object]，已阻止缺失正文的模型请求')
    if (request.model.capability === 'video' && request.executionContext?.voicePolicy === 'strict') {
      const preparingAt = Date.now()
      try { await ensureSchema(); request = await bindVideoVoices(pool, request) }
      finally { voicePreparationMs = Date.now() - preparingAt }
    }
    request = prepareWorkflowMediaRequest(request)
    sceneCutRepairBinding = await bindSceneCutRejectedEditReference(pool, request)
    request = sceneCutRepairBinding.request as NodeRunRequest
    freshEditBinding = await bindA8B6FreshEditReference(request)
    request = freshEditBinding.request as NodeRunRequest
    const v5EditBinding = await bindA8B6FreshV5EditReference(request)
    request = v5EditBinding.request as NodeRunRequest
    if (v5EditBinding.applied) freshEditBinding = v5EditBinding
    const v6EditBinding = await bindA8B6FreshV6EditReference(request)
    request = v6EditBinding.request as NodeRunRequest
    if (v6EditBinding.applied) freshEditBinding = v6EditBinding
    const v7EditBinding = await bindA8B6FreshV7EditReference(request)
    request = v7EditBinding.request as NodeRunRequest
    if (v7EditBinding.applied) freshEditBinding = v7EditBinding
    const v8EditBinding = await bindA8B6FreshV8EditReference(request)
    request = v8EditBinding.request as NodeRunRequest
    if (v8EditBinding.applied) freshEditBinding = v8EditBinding
    fingerprint = modelRequestFingerprint(request)
    validateWorkflowMediaContract(request)
    if (request.model.capability === 'video' && Array.isArray(request.params.equipmentBindings)
      && request.params.equipmentBindings.length) {
      await ensureSchema()
      await assertCurrentCharacterEquipmentBindings(pool, request)
    }
    const reviewFrames = request.model.provider === 'Codex'
      ? request.model.capability === 'text' ? await loadCodexTextFrames(request.params) : []
      : await loadReviewImages(request.params.reviewImages, process.cwd(), request.params.reviewImageDetail)
    const reviewImageHashes = reviewFrames.map(frame => ({ url: frame.url, sha256: createHash('sha256').update(frame.bytes).digest('hex') }))
    fingerprint = reviewImagesFingerprint(fingerprint, reviewFrames)
    if (request.model.capability === 'text' && request.executionContext?.requestKey) {
      await ensureSchema()
      const checkpoint = await pool.query(`select response_data,http_status from model_execution_records
        where request_data->>'requestKey'=$1 and request_data->>'fingerprint'=$2 and status='succeeded'
          and coalesce(request_data->>'operation','')=$3
          and ($4::boolean = false or request_data ? 'reviewImageHashes') order by created_at desc limit 1`,
      [request.executionContext.requestKey, fingerprint, request.operation ?? '',
        ['sanguo-map-first-review', 'sanguo-map-end-review'].includes(request.executionContext.nodeId ?? '')])
      if (checkpoint.rows[0] && (request.operation !== 'history.media-review' || reusableMediaReview(checkpoint.rows[0].response_data))) return { status: checkpoint.rows[0].http_status ?? 200, body: checkpoint.rows[0].response_data }
    }
    let effectiveRequest = request
    if (request.operation === 'character.three-view' && request.model.capability === 'image' && request.executionContext?.requestKey) {
      await ensureSchema()
      const completedImage = await pool.query(`select response_data,http_status from model_execution_records
        where request_data->>'requestKey'=$1 and request_data->>'fingerprint'=$2 and status='succeeded'
          and request_data->>'operation'='character.three-view' and coalesce(response_data->>'qualityRejected','false') <> 'true'
        order by created_at desc limit 1`, [request.executionContext.requestKey, modelRequestFingerprint(request)])
      if (completedImage.rows[0]) return { status: completedImage.rows[0].http_status ?? 200, body: completedImage.rows[0].response_data }
      if (request.model.provider === 'Kling' && !request.params.resumeTaskId) {
        const pendingImage = await pool.query(`select task_id from model_execution_records
          where request_data->>'requestKey'=$1 and request_data->>'fingerprint'=$2 and status='processing'
            and request_data->>'operation'='character.three-view' and task_id is not null
          order by created_at desc limit 1`, [request.executionContext.requestKey, modelRequestFingerprint(request)])
        if (pendingImage.rows[0]) effectiveRequest = { ...request, params: { ...request.params, resumeTaskId: pendingImage.rows[0].task_id } }
      }
    }
    if (request.model.provider === 'Kling' && request.model.capability === 'image'
      && request.executionContext?.workflowId === 'wf-sanguo-history-drama'
      && ['sanguo-animated-map-first-frame', 'sanguo-end-frame', 'sanguo-coverage-first-frame'].includes(request.executionContext?.nodeId ?? '')
      && (request.params.animationStyle === 'historical_map' || request.executionContext?.nodeId === 'sanguo-coverage-first-frame') && !request.params.resumeTaskId
      && request.executionContext.requestKey) {
      await ensureSchema()
      const prior = await pool.query(`select status,task_id,response_data,http_status from model_execution_records
        where model_id=$1 and workflow_id=$2 and node_id=$3 and request_data->>'requestKey'=$4
          and request_data->>'fingerprint'=$5 and status in ('processing','succeeded')
        order by created_at desc limit 1`, [request.model.id, request.executionContext.workflowId,
        request.executionContext.nodeId, request.executionContext.requestKey, modelRequestFingerprint(request)])
      if (prior.rows[0]?.status === 'succeeded') {
        const body = request.executionContext?.nodeId === 'sanguo-coverage-first-frame'
          ? await persistCoverageCutFirstFrameResponse(prior.rows[0].response_data)
          : request.params.animationAesthetic === 'historical_cartography'
            ? await persistHistoricalMapFrameResponse(prior.rows[0].response_data) : prior.rows[0].response_data
        return { status: prior.rows[0].http_status ?? 200, body }
      }
      if (prior.rows[0]?.task_id) effectiveRequest = { ...request, params: { ...request.params,
        resumeTaskId: prior.rows[0].task_id, resumeQueryMode: prior.rows[0].response_data?.resumeQueryMode ?? 'image' } }
    }
    validateHistoricalMapPaidImageRequest(effectiveRequest)
    validateCoverageCutPaidImageRequest(effectiveRequest)
    let sceneCutSchemaVersion = 167
    if (effectiveRequest.executionContext?.workflowId === 'wf-sanguo-history-drama'
      && (effectiveRequest.model.capability === 'image'
        && effectiveRequest.executionContext.nodeId === 'sanguo-scene-cut-first-frame'
        || effectiveRequest.model.capability === 'video'
        && effectiveRequest.executionContext.nodeId === 'sanguo-video')) {
      await ensureSchema()
      const saved = await pool.query(`select schema_version from workflow_configs
        where id='wf-sanguo-history-drama'`)
      sceneCutSchemaVersion = Number(saved.rows[0]?.schema_version ?? 0)
      if (sceneCutSchemaVersion < 165) throw Error('SCENE_CUT_FRAME_BLOCKED: 当前工作流版本无法核对')
    }
    await validateSceneCutPaidImageRequest(effectiveRequest, process.cwd(), sceneCutSchemaVersion)
    if (sceneCutSchemaVersion >= 171 && effectiveRequest.model.capability === 'image'
      && effectiveRequest.executionContext?.workflowId === 'wf-sanguo-history-drama'
      && effectiveRequest.executionContext.nodeId === 'sanguo-scene-cut-first-frame')
      await assertSceneCutAcceptedSourceLedger(pool, effectiveRequest.params.sceneCutShot,
        effectiveRequest.params.sceneCutSources)
    let reusedVideoResult: { status: number; body: unknown } | undefined
    if (request.model.provider === 'Kling' && request.model.capability === 'video' && !request.params.resumeTaskId && request.executionContext?.workflowId && request.executionContext.nodeId) {
      await ensureSchema()
      const pending = await pool.query(`select task_id, response_data, status, http_status from model_execution_records
        where model_id=$1 and workflow_id=$2 and node_id=$3 and task_id is not null
          and (status='processing' or status='succeeded')
          and ($6::text is null or request_data->>'requestKey'=$6)
          and (request_data->>'fingerprint'=$7 or (request_data->>'prompt'=$4 and request_data->'params'=$5::jsonb))
          and created_at > now() - interval '1 day' order by created_at desc limit 1`,
        [request.model.id, request.executionContext.workflowId, request.executionContext.nodeId, request.prompt, JSON.stringify(request.params), request.executionContext.requestKey ?? null, modelRequestFingerprint(request)])
      if (pending.rows[0]?.status === 'succeeded') reusedVideoResult = { status: pending.rows[0].http_status ?? 200, body: pending.rows[0].response_data }
      if (pending.rows[0]) effectiveRequest = { ...request, params: { ...request.params, resumeTaskId: pending.rows[0].task_id,
        resumeQueryMode: pending.rows[0].response_data?.resumeQueryMode ?? (Array.isArray(request.params.referenceImages) && request.params.referenceImages.length ? 'omni' : request.params.referenceImage ? 'image2video' : 'text2video') } }
    }
    let sceneCutTailGuideValidated = false
    if (effectiveRequest.model.capability === 'video'
      && effectiveRequest.executionContext?.workflowId === 'wf-sanguo-history-drama'
      && effectiveRequest.executionContext?.nodeId === 'sanguo-video') {
      let paidResumeRecord: unknown
      if (effectiveRequest.params.resumeTaskId) {
        await ensureSchema()
        const paid = await pool.query(`select task_id,workflow_id,node_id,model_id,provider,capability,status,request_data
          from model_execution_records where task_id=$1 and workflow_id=$2 and node_id=$3
            and model_id=$4 and status in ('processing','succeeded')
          order by created_at desc limit 1`, [effectiveRequest.params.resumeTaskId,
          effectiveRequest.executionContext.workflowId, effectiveRequest.executionContext.nodeId, effectiveRequest.model.id])
        paidResumeRecord = paid.rows[0]
      }
      validateCoverageCutPaidVideoRequest(effectiveRequest, paidResumeRecord)
      const sceneCutRepairContext = sceneCutSchemaVersion >= 177
        ? await readSceneCutRepairVideoContext(pool, effectiveRequest) : undefined
      validateSceneCutPaidVideoRequest(effectiveRequest, paidResumeRecord,
        process.cwd(), sceneCutSchemaVersion, sceneCutRepairContext ?? undefined)
      sceneCutTailGuideValidated = !effectiveRequest.params.resumeTaskId
        && Boolean(sceneCutRepairContext?.tailGuide)
      if (sceneCutSchemaVersion >= 171 && !effectiveRequest.params.resumeTaskId
        && effectiveRequest.params.continuityMode === 'scene_cut'
        && effectiveRequest.params.visualTreatment === 'live_action')
        await assertSceneCutAcceptedSourceLedger(pool, effectiveRequest.params.sceneCutShot,
          effectiveRequest.params.sceneCutSources)
    }
    if (reusedVideoResult) return reusedVideoResult
    if (effectiveRequest.model.capability === 'video' && Array.isArray(effectiveRequest.params.characterVoices)) {
      await ensureSchema()
      await assertVoiceSynthesisAllowed(pool, effectiveRequest.params)
    }
    const result = await callNodeExternalUntracked(effectiveRequest, {
      sceneCutTailGuideValidated,
      onTaskSubmitted: async (submitted, endpoint) => {
        submittedTaskId = executionTaskInfo(submitted.body).taskId
        resumeQueryMode = request.model.capability === 'image' ? (endpoint.includes('/omni-image') ? 'omni-image' : 'image')
          : endpoint.includes('/omni-video') ? 'omni' : endpoint.includes('/text2video') ? 'text2video' : 'image2video'
        await saveModelExecutionRecord({ id, channel: 'workflow', modelId: request.model.id, modelName: request.model.name,
          provider: request.model.provider, capability: request.model.capability, status: 'processing', httpStatus: submitted.status,
          taskId: submittedTaskId, workflowId: request.executionContext?.workflowId, workflowName: request.executionContext?.workflowName,
          nodeId: request.executionContext?.nodeId, nodeName: request.executionContext?.nodeName,
          requestData: { voicePolicy: request.executionContext?.voicePolicy, voicePreparationMs, fingerprint, requestKey: request.executionContext?.requestKey, prompt: request.prompt, promptSha256: createHash('sha256').update(request.prompt).digest('hex'), params: request.params, operation: request.operation, reviewImageHashes },
          responseData: { ...(submitted.body as object), resumeQueryMode }, durationMs: Date.now() - startedAt })
      },
    }, reviewFrames)
    if ((request.params.characterVoices || request.params.nativeGroupVoices) && result.body && typeof result.body === 'object') {
      result.body = { ...result.body, characterVoices: request.params.characterVoices, voiceManifest: request.params.voiceManifest, voiceConsistency: request.params.voiceConsistency,
        ...(request.params.nativeGroupVoices ? { nativeGroupVoices: request.params.nativeGroupVoices, qualityDisposition: request.params.qualityDisposition } : {}) }
    }
    if (request.params.referenceBindingProjection && result.body && typeof result.body === 'object' && !Array.isArray(result.body)) {
      result.body = { ...result.body, referenceBindingProjection: request.params.referenceBindingProjection }
    }
    if (request.operation === 'character.three-view' && request.model.capability === 'image' && result.status < 400) {
      result.body = await persistGeneratedImageResponse(result.body)
    }
    if (request.model.capability === 'image' && result.status < 400
      && request.executionContext?.workflowId === 'wf-sanguo-history-drama'
      && ['sanguo-animated-map-first-frame', 'sanguo-end-frame'].includes(request.executionContext?.nodeId ?? '')
      && request.params.animationStyle === 'historical_map'
      && request.params.animationAesthetic === 'historical_cartography') {
      result.body = await persistHistoricalMapFrameResponse(result.body)
    }
    if (request.model.capability === 'image' && result.status < 400
      && request.executionContext?.workflowId === 'wf-sanguo-history-drama'
      && request.executionContext?.nodeId === 'sanguo-coverage-first-frame') {
      result.body = await persistCoverageCutFirstFrameResponse(result.body)
    }
    if (submittedTaskId && result.body && typeof result.body === 'object') result.body = { ...result.body, resumeQueryMode }
    if (sceneCutRepairBinding?.applied && result.status < 400
      && result.body && typeof result.body === 'object' && !Array.isArray(result.body)) {
      result.body = { ...result.body, modelExecutionId: id,
        repairRequestFingerprint: fingerprint,
        sceneCutRepairReceiptSha256: sceneCutRepairBinding.ledgerIdentity?.repairReceiptSha256 }
    }
    const task = executionTaskInfo(result.body)
    const modelLedgerSaved = await saveModelExecutionRecord({
      id,
      channel: 'workflow',
      modelId: request.model.id,
      modelName: request.model.name,
      provider: request.model.provider,
      capability: request.model.capability,
      status: modelExecutionStatus(result.status, result.body),
      httpStatus: result.status,
      taskId: task.taskId,
      workflowId: request.executionContext?.workflowId,
      workflowName: request.executionContext?.workflowName,
      nodeId: request.executionContext?.nodeId,
      nodeName: request.executionContext?.nodeName,
      requestData: { voicePolicy: request.executionContext?.voicePolicy, voicePreparationMs, fingerprint, requestKey: request.executionContext?.requestKey, prompt: request.prompt, promptSha256: createHash('sha256').update(request.prompt).digest('hex'), params: request.params, operation: request.operation, reviewImageHashes,
        ...(sceneCutRepairBinding?.applied ? { sceneCutRepairReceiptSha256: sceneCutRepairBinding.ledgerIdentity?.repairReceiptSha256 } : {}),
        ...(freshEditBinding?.applied ? { sceneCutFreshEditReceiptSha256: freshEditBinding.receiptSha256 } : {}) },
      responseData: submittedTaskId ? { ...(result.body as object), resumeQueryMode } : 'transport' in result ? { ...(typeof result.body === 'object' && result.body ? result.body : { upstream: result.body }), transport: result.transport } : result.body,
      error: result.status >= 400 ? `HTTP ${result.status}: ${typeof result.body === 'string' ? result.body : JSON.stringify(result.body)}` : undefined,
      durationMs: Date.now() - startedAt,
    })
    if (sceneCutRepairBinding?.applied && !modelLedgerSaved
      && result.body && typeof result.body === 'object' && !Array.isArray(result.body)) {
      // Keep the paid image in the execution; approval remains closed until
      // its model ledger is recovered, so a retry need not buy the image again.
      result.body = { ...result.body, modelLedgerPending: true }
    }
    return result
  } catch (error) {
    const message = `${errorMessage(error)}${submittedTaskId ? `（已提交 task_id: ${submittedTaskId}，使用 resumeTaskId 和 resumeQueryMode=${resumeQueryMode} 恢复查询，勿重复提交）` : ''}`
    await saveModelExecutionRecord({
      id,
      channel: 'workflow',
      modelId: request.model.id,
      modelName: request.model.name,
      provider: request.model.provider,
      capability: request.model.capability,
      status: submittedTaskId ? 'processing' : 'failed',
      taskId: submittedTaskId,
      responseData: { task_id: submittedTaskId, resumeQueryMode, ...((error instanceof CodexTextError || error instanceof CodexImageError) ? { provider: 'Codex', raw: error.raw } : {}) },
      workflowId: request.executionContext?.workflowId,
      workflowName: request.executionContext?.workflowName,
      nodeId: request.executionContext?.nodeId,
      nodeName: request.executionContext?.nodeName,
      requestData: { voicePolicy: request.executionContext?.voicePolicy, voicePreparationMs, fingerprint, requestKey: request.executionContext?.requestKey, prompt: request.prompt, params: request.params, operation: request.operation },
      error: message,
      durationMs: Date.now() - startedAt,
    })
    throw new Error(message, { cause: error })
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'postgres-config-api',
      configureServer(server) {
        server.middlewares.use('/api/runtime-version', (_req, res) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ historyQualityVersion: HISTORY_QUALITY_VERSION, voiceContractVersion: VOICE_CONTRACT_VERSION, videoOutputProfileVersion: VIDEO_OUTPUT_PROFILE_VERSION,
            characterVisualContextVersion: CHARACTER_VISUAL_CONTEXT_RUNTIME_VERSION,
            textTransportPolicy: { version: '2026-09-10-cause-aware-v1', channelProbeLimit: TEXT_CHANNEL_PROBE_LIMIT, deadlineMs: TEXT_TRANSPORT_DEADLINE_MS } }))
        })
        server.middlewares.use('/api/config', async (req, res) => {
          try {
            if (req.method === 'GET') return jsonResponse(res, 200, await readAppConfig())
            if (req.method === 'PUT' && req.url === '/models') {
              const body = await readJson<{ models: ModelConfig[] }>(req)
              await saveModels(body.models)
              return jsonResponse(res, 200, { ok: true, models: body.models.length })
            }
            if (req.method === 'PUT' && req.url === '/workflows') {
              const body = await readJson<{ workflows: Workflow[] }>(req)
              await saveWorkflows(body.workflows)
              return jsonResponse(res, 200, { ok: true, workflows: body.workflows.length })
            }
            return jsonResponse(res, 405, { error: 'Method not allowed' })
          } catch (error) {
            return jsonResponse(res, 422, { error: errorMessage(error) })
          }
        })
        server.middlewares.use('/api/character-voices', async (req, res) => {
          try {
            await ensureSchema()
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (req.method === 'GET' && url.pathname === '/models') {
              const config = await readAppConfig()
              return jsonResponse(res, 200, { models: config.models.filter(m => m.provider === 'Kling' && m.capability === 'video').map(m => ({ id: m.id, name: m.name, modelName: m.settings.model ?? '' })) })
            }
            if (req.method === 'GET' && url.pathname === '/metrics') return jsonResponse(res, 200, await readVoiceMetrics(pool, url.searchParams.get('workflowId') ?? ''))
            if (req.method === 'GET' && url.pathname === '/character') {
              const state = await readCharacterVoice(pool, url.searchParams.get('id') ?? '')
              const original = await pool.query('select * from original_character_voices where character_id=$1', [state.characterId])
              return jsonResponse(res, 200, { ...state, originalVoice: original.rows[0] ? publicOriginalVoice(original.rows[0]) : null })
            }
            if (req.method === 'GET' && url.pathname === '/impact') return jsonResponse(res, 200, await readCharacterVoiceImpact(pool, url.searchParams.get('id') ?? ''))
            const body = req.method === 'POST' ? await readJson<Record<string, string>>(req) : {}
            if (req.method === 'POST' && ['/review-read','/review'].includes(url.pathname)) {
              const target = body.target as unknown as import('./src/voice-review.ts').VoiceReviewTarget
              const review = url.pathname === '/review' ? await saveVoiceListeningReview(pool, target, body.status, body.note) : await readVoiceListeningReview(pool, target)
              return jsonResponse(res, 200, { review })
            }
            if (req.method === 'POST' && url.pathname === '/upgrade-preview') return jsonResponse(res, 200, await previewVoiceUpgrade(pool, body.sourceId, body.characterIds as unknown as string[]))
            if (req.method === 'POST' && url.pathname === '/upgrade') return jsonResponse(res, 201, await forkVoiceUpgrade(pool, body.sourceId, body.targetId, body.expected as unknown as Array<{ characterId: string; version: number }>))
            if (req.method === 'POST' && url.pathname === '/availability') return jsonResponse(res, 200, await setCharacterVoiceAvailability(pool, body.characterId, body.version as unknown as number, body.enabled as unknown as boolean, body.reason))
            const modelId = body.modelId ?? url.searchParams.get('modelId')
            const model = (await readAppConfig()).models.find(m => m.id === modelId && m.provider === 'Kling' && m.capability === 'video')
            if (!model) throw Error('请先配置可灵视频模型及凭证')
            if (req.method === 'GET' && url.pathname === '/catalog') return jsonResponse(res, 200, { voices: await listProviderVoices(model, Math.max(1, Math.min(1000, Number(url.searchParams.get('page') ?? 1)))) })
            if (req.method === 'POST' && url.pathname === '/custom') {
              const input = buildCustomVoiceRequest({ voiceName: body.voiceName ?? '', voiceUrl: body.voiceUrl ?? '', externalTaskId: '' })
              return jsonResponse(res, 202, await submitVoiceJob(pool, model, body.characterId || null, 'custom', input))
            }
            if (req.method === 'POST' && url.pathname === '/bind') return jsonResponse(res, 202, await createCharacterElement(pool, model, body.characterId, { voiceId: body.voiceId, voiceName: body.voiceName, previewUrl: body.previewUrl }))
            if (req.method === 'POST' && url.pathname === '/refresh') return jsonResponse(res, 200, await refreshVoiceJob(pool, model, body.id))
            return jsonResponse(res, 405, { error: 'Method not allowed' })
          } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/character-people', async (req, res) => {
          try {
            await ensureSchema()
            const url = new URL(req.url ?? '', 'http://localhost')
            const segments = url.pathname.split('/').filter(Boolean)
            if (req.method === 'GET' && segments.length === 0) {
              return jsonResponse(res, 200, { people: await readCharacterPeople(pool, url.searchParams.get('workflowId') ?? undefined, url.searchParams.get('includeShared') === 'true') })
            }
            if (req.method === 'GET' && segments.length === 1) {
              const person = (await readCharacterPeople(pool)).find(item => item.id === segments[0])
              if (!person) return jsonResponse(res, 404, { error: '人物不存在或已被删除' })
              return jsonResponse(res, 200, { person })
            }
            if (segments.length === 2 && segments[1] === 'equipment' && req.method === 'POST') {
              const body = await readJson<CharacterEquipmentInput>(req)
              return jsonResponse(res, 201, { equipment: await createCharacterEquipment(pool, segments[0], body) })
            }
            if (segments.length === 3 && segments[1] === 'equipment' && req.method === 'PUT') {
              const body = await readJson<CharacterEquipmentInput>(req)
              return jsonResponse(res, 200, { equipment: await updateCharacterEquipment(pool, segments[0], segments[2], body) })
            }
            if (segments.length === 3 && segments[1] === 'equipment' && req.method === 'DELETE') {
              await deleteCharacterEquipment(pool, segments[0], segments[2])
              return jsonResponse(res, 200, { ok: true })
            }
            return jsonResponse(res, 405, { error: 'Method not allowed' })
          } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/character-equipment', async (req, res) => {
          try {
            if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'Method not allowed' })
            await ensureSchema()
            const url = new URL(req.url ?? '', 'http://localhost')
            const names = url.searchParams.getAll('name')
            return jsonResponse(res, 200, { equipment: await readCharacterEquipment(pool, url.searchParams.get('workflowId') ?? undefined, names.length ? names : undefined) })
          } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/characters', async (req, res) => {
          try {
            const url = new URL(req.url ?? '', 'http://localhost')
            const segments = url.pathname.split('/').filter(Boolean)
            const id = segments[0]
            if (req.method === 'GET' && !id) {
              return jsonResponse(res, 200, { characters: await readCharacterAssets(url.searchParams.get('workflowId') ?? undefined, url.searchParams.get('includeShared') === 'true') })
            }
            if (req.method === 'POST' && !id) {
              const body = await readJson<CharacterAssetInput>(req)
              return jsonResponse(res, 201, { character: await createCharacterAsset(body) })
            }
            if (req.method === 'POST' && id && segments.length === 2 && segments[1] === 'portrait-review') {
              try {
                await ensureSchema()
                const body = await readJson<CharacterPortraitReviewInput>(req)
                const review = await reviewPendingCharacterPortrait(pool, id, body)
                const character = (await readCharacterAssets()).find(item => item.id === id)
                return jsonResponse(res, 200, { review, character })
              } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
            }
            if (req.method === 'POST' && id && segments.length === 2 && segments[1] === 'portrait-recover') {
              try {
                await ensureSchema()
                const body = await readJson<CharacterPortraitRecoverInput>(req)
                const recovery = await recoverPendingCharacterPortrait(pool, id, body)
                const character = (await readCharacterAssets()).find(item => item.id === id)
                return jsonResponse(res, 200, { recovery, character })
              } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
            }
            if (req.method === 'PUT' && id) {
              const body = await readJson<CharacterAssetInput>(req)
              return jsonResponse(res, 200, { character: await updateCharacterAsset(id, body) })
            }
            if (req.method === 'DELETE' && id) {
              await deleteCharacterAsset(id)
              return jsonResponse(res, 200, { ok: true })
            }
            return jsonResponse(res, 405, { error: 'Method not allowed' })
          } catch (error) {
            return jsonResponse(res, 500, { error: errorMessage(error), databaseUrl })
          }
        })
        server.middlewares.use('/generated', (req, res, next) => { void serveGeneratedAudio(req, res, next) })
        server.middlewares.use('/api/model-test', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const request = await readJson<ModelTestRequest | ModelTestStatusRequest>(req)
            const startedAt = Date.now()
            if (req.url === '/status') {
              const statusRequest = request as ModelTestStatusRequest
              const result = await queryModelTestTask(statusRequest)
              await updateModelExecutionByTask(statusRequest.taskId, result.status, result.body, Date.now() - startedAt)
              return jsonResponse(res, 200, result)
            }
            const id = `model-run-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
            let result: { status: number; body: unknown }
            try {
              result = await callExternal(request.model, request.params)
            } catch (error) {
              await saveModelExecutionRecord({
                id, channel: 'experience', modelId: request.model.id, modelName: request.model.name,
                provider: request.model.provider, capability: request.model.capability, status: 'failed',
                requestData: { prompt: request.model.testInput, params: request.params ?? {} },
                ...((error instanceof CodexTextError || error instanceof CodexImageError) ? { responseData: { provider: 'Codex', raw: error.raw } } : {}),
                error: errorMessage(error), durationMs: Date.now() - startedAt,
              })
              throw error
            }
            const task = executionTaskInfo(result.body)
            await saveModelExecutionRecord({
              id, channel: 'experience', modelId: request.model.id, modelName: request.model.name,
              provider: request.model.provider, capability: request.model.capability,
              status: modelExecutionStatus(result.status, result.body), httpStatus: result.status,
              taskId: task.taskId, requestData: { prompt: request.model.testInput, params: request.params ?? {} },
              responseData: result.body, durationMs: Date.now() - startedAt,
            })
            return jsonResponse(res, 200, result)
          } catch (error) {
            return jsonResponse(res, 500, { status: 500, body: { error: errorMessage(error) } })
          }
        })
        server.middlewares.use('/api/model-executions', async (req, res) => {
          try {
            if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'Method not allowed' })
            const url = new URL(req.url ?? '', 'http://localhost')
            return jsonResponse(res, 200, { records: await readModelExecutionRecords(url) })
          } catch (error) {
            return jsonResponse(res, 500, { error: errorMessage(error), databaseUrl })
          }
        })
        server.middlewares.use('/api/media-download', async (req, res) => {
          if (req.method !== 'GET') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const requestUrl = new URL(req.url ?? '', 'http://localhost')
            const source = new URL(requestUrl.searchParams.get('url') ?? '')
            if (source.protocol !== 'https:' && source.protocol !== 'http:') throw new Error('只支持下载 HTTP(S) 结果')
            const upstream = await fetch(source)
            if (!upstream.ok || !upstream.body) throw new Error(`结果文件下载失败：HTTP ${upstream.status}`)
            const requestedName = requestUrl.searchParams.get('filename') || source.pathname.split('/').pop() || 'model-result'
            const filename = requestedName.replace(/[^\w.\-\u4e00-\u9fff]/g, '_')
            res.statusCode = 200
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream')
            const length = upstream.headers.get('content-length')
            if (length) res.setHeader('Content-Length', length)
            res.setHeader('Content-Disposition', `${requestUrl.searchParams.get('inline') === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`)
            Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res)
          } catch (error) {
            return jsonResponse(res, 502, { error: errorMessage(error) })
          }
        })
        server.middlewares.use('/api/image-evidence', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try { return jsonResponse(res, 200, await collectImageEvidence(await readJson<Parameters<typeof collectImageEvidence>[0]>(req))) }
          catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/coverage-cut-source-archive', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try { return jsonResponse(res, 200, await archiveCoverageCutSources(await readJson<Parameters<typeof archiveCoverageCutSources>[0]>(req))) }
          catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/coverage-cut-frame-approval', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try { return jsonResponse(res, 200, await issueRecordedCoverageCutFrameApproval(pool,
            await readJson<Parameters<typeof issueRecordedCoverageCutFrameApproval>[1]>(req))) }
          catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/scene-cut-source-archive', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const input = await readJson<Parameters<typeof archiveSceneCutSources>[0] & { executionRecordId?: unknown }>(req)
            if (input.sceneCutBoundaryVersion === 'scene-cut-approved-boundary-v1') {
              if (typeof input.executionRecordId !== 'string' || !/^record-[\w-]+$/.test(input.executionRecordId))
                throw Error('SCENE_CUT_SOURCE_LEDGER_INVALID: 缺少当前持久化执行记录身份')
              const rows = await pool.query(`select id,workflow_id,result from execution_records
                where id=$1 and workflow_id='wf-sanguo-history-drama'`, [input.executionRecordId])
              if (rows.rows.length !== 1) throw Error('SCENE_CUT_SOURCE_LEDGER_INVALID: 执行记录不存在')
              const acceptedRecordBinding = assertSceneCutAcceptedSourceRecord(rows.rows[0],
                { executionRecordId: input.executionRecordId,
                  approvedOutline: input.approvedOutline, shot: input.shot,
                  previous: input.previous })
              return jsonResponse(res, 200, await archiveSceneCutSources({ ...input, acceptedRecordBinding }))
            }
            return jsonResponse(res, 200, await archiveSceneCutSources(input))
          }
          catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/scene-cut-opening-plan', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try { const input = await readJson<{ shot: unknown }>(req)
            await ensureSchema()
            const saved = await pool.query(`select schema_version from workflow_configs
              where id='wf-sanguo-history-drama'`)
            const schemaVersion = Number(saved.rows[0]?.schema_version ?? 0)
            if (schemaVersion < 168) throw Error('SCENE_CUT_OPENING_PLAN_INVALID: 当前工作流版本不可核对')
            return jsonResponse(res, 200, deriveSceneCutOpeningPlan(input.shot,
              schemaVersion >= 195 ? 4 : schemaVersion >= 170 ? 3 : schemaVersion >= 169 ? 2 : 1)) }
          catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/scene-cut-frame-approval', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try { return jsonResponse(res, 200, await issueRecordedSceneCutFrameApproval(pool,
            await readJson<Parameters<typeof issueRecordedSceneCutFrameApproval>[1]>(req))) }
          catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/historical-map-annotation-approval', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const input = await readJson<{ plan: unknown; review: unknown; historicalSources: unknown; approvedScene: unknown }>(req)
            const reviewExecutionId = await recordedHistoricalMapReview('sanguo-map-annotation-review', input.review,
              { plan: input.plan, historicalSources: input.historicalSources, approvedScene: input.approvedScene })
            return jsonResponse(res, 200, await issueHistoricalMapAnnotationApproval({ ...input, reviewExecutionId }))
          } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/historical-map-frame-approval', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const input = await readJson<{ review: unknown; evidence: { items?: unknown[]; reviewImages?: unknown[] };
              shot: unknown; prior?: unknown }>(req)
            const count = Array.isArray(input.evidence?.items) ? input.evidence.items.length : 0
            const nodeId = count === 1 ? 'sanguo-map-first-review' : count === 2 ? 'sanguo-map-end-review' : ''
            if (!nodeId) throw Error('HISTORICAL_MAP_FRAME_APPROVAL_INVALID: 只接受首帧或首尾两帧采证')
            const expectedParams = { evidence: input.evidence, shot: input.shot, reviewImages: input.evidence.reviewImages,
              ...(count === 2 ? { prior: input.prior } : {}) }
            const reviewExecutionId = await recordedHistoricalMapReview(nodeId, input.review, expectedParams)
            return jsonResponse(res, 200, await issueHistoricalMapFrameApproval({ ...input, reviewExecutionId }))
          } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/video-evidence', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const request = await readJson<Parameters<typeof collectVideoEvidence>[0]>(req)
            return jsonResponse(res, 200, await collectVideoEvidence(request))
          } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/video-inspect', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const request = await readJson<Parameters<typeof inspectGeneratedVideo>[0]>(req)
            return jsonResponse(res, 200, await inspectGeneratedVideo(request))
          } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/story-shot-review', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const request = await readJson<{ shot: unknown; videoUrl: string; reviewerModelId: string; executionContext?: NodeRunRequest['executionContext'] }>(req)
            if (request.executionContext?.workflowId !== 'wf-story') throw new Error('STORY_REVIEW_SCOPE_INVALID: 仅接受打工猫分镜工作流的当前视频')
            const configured = (await readAppConfig()).models.find(item => item.id === request.reviewerModelId)
            const model = configured ?? { id: '', name: '', provider: 'Local' as const, capability: 'text' as const,
              settings: {}, testInput: '' }
            const result = await reviewStoryShotVideo({ shot: request.shot, videoUrl: request.videoUrl, model,
              execute: input => callNodeExternal(input as NodeRunRequest), executionContext: request.executionContext })
            return jsonResponse(res, 200, result)
          } catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }
        })
        server.middlewares.use('/api/runtime-assets', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const body = await readJson<{ dataUrl?: string; prefix?: string }>(req)
            const match = String(body.dataUrl ?? '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/)
            if (!match) throw new Error('运行时尾帧不是有效的 JPEG、PNG 或 WebP data URL')
            const bytes = Buffer.from(match[2], 'base64')
            if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('运行时尾帧大小必须在 1B 到 10MB 之间')
            const extension = match[1] === 'jpeg' ? 'jpg' : match[1]
            const prefix = String(body.prefix ?? 'video-tail').replace(/[^\w-]/g, '-').slice(0, 80) || 'video-tail'
            const directory = path.resolve(process.cwd(), 'public/generated')
            await mkdir(directory, { recursive: true })
            const filename = `${prefix}-${randomUUID()}.${extension}`
            await writeFile(path.join(directory, filename), bytes)
            return jsonResponse(res, 201, { url: `/generated/${filename}` })
          } catch (error) {
            return jsonResponse(res, 400, { error: errorMessage(error) })
          }
        })
        server.middlewares.use('/api/node-run', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const request = await readJson<NodeRunRequest>(req)
            const result = await callNodeExternal(request)
            return jsonResponse(res, 200, result)
          } catch (error) {
            return jsonResponse(res, 500, { status: 500, body: { error: errorMessage(error) } })
          }
        })
        server.middlewares.use('/api/builtin-node-run', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            await ensureSchema()
            const request = await readJson<Parameters<typeof executeBuiltinNode>[1]>(req)
            const body = await executeBuiltinNode(pool, request, (mediaRequest) => callNodeExternal(mediaRequest as NodeRunRequest))
            return jsonResponse(res, 200, { status: 200, body })
          } catch (error) {
            return jsonResponse(res, 500, { status: 500, body: { error: errorMessage(error) } })
          }
        })
        server.middlewares.use('/api/code-node-run', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const request = await readJson<Parameters<typeof executeCodeNode>[0]>(req)
            const body = await executeCodeNode(request)
            return jsonResponse(res, 200, { status: 200, body })
          } catch (error) {
            return jsonResponse(res, 500, { status: 500, body: { error: errorMessage(error) } })
          }
        })
        server.middlewares.use('/api/internet', async (req, res) => {
          try {
            if (req.method === 'POST' && req.url === '/search') {
              const body = await readJson<InternetSourceInput>(req)
              return jsonResponse(res, 200, await retrieveInternetSources(body))
            }
            return jsonResponse(res, 405, { error: 'Method not allowed' })
          } catch (error) {
            return jsonResponse(res, 500, { error: errorMessage(error) })
          }
        })
        server.middlewares.use('/api/knowledge', async (req, res) => {
          try {
            await ensureSchema()
            if (req.method === 'GET' && req.url === '/stats') return jsonResponse(res, 200, await readKnowledgeStats(pool))
            if (req.method === 'POST' && req.url === '/search') {
              const body = await readJson<InternetSourceInput>(req)
              return jsonResponse(res, 200, await retrieveInternetSources(body))
            }
            if (req.method === 'POST' && req.url === '/ingest') {
              return jsonResponse(res, 410, { error: '互联网检索不写入本地知识库；请使用 /api/internet/search 运行时查询。' })
            }
            return jsonResponse(res, 405, { error: 'Method not allowed' })
          } catch (error) {
            return jsonResponse(res, 500, { error: errorMessage(error), databaseUrl })
          }
        })
        server.middlewares.use('/api/execution-records', async (req, res) => {
          try {
            if (req.method === 'GET') {
              const url = new URL(req.url ?? '', 'http://localhost')
              const id = url.pathname.split('/').filter(Boolean)[0]
              if (id) {
                const record = await readExecutionRecord(id)
                return record ? jsonResponse(res, 200, { record }) : jsonResponse(res, 404, { error: '执行记录不存在' })
              }
              return jsonResponse(res, 200, { records: await readExecutionRecords(url.searchParams.get('workflowId') ?? undefined) })
            }
            if (req.method === 'POST') {
              const body = await readJson<{ record: ExecutionRecord }>(req)
              await saveExecutionRecord(body.record)
              return jsonResponse(res, 200, { ok: true, id: body.record.id })
            }
            return jsonResponse(res, 405, { error: 'Method not allowed' })
          } catch (error) {
            return jsonResponse(res, 500, { error: errorMessage(error), databaseUrl })
          }
        })
      },
    },
  ],
})
