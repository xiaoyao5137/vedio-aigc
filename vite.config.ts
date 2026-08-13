import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pg from 'pg'
import { Readable } from 'node:stream'
import { executeBuiltinNode } from './server/builtin-nodes.ts'
import { executeCodeNode } from './server/code-node.ts'
import { readKnowledgeStats } from './server/knowledge.ts'
import { buildKlingVideoRequest, callKlingImage, callOpenAiImage, klingAuthorization, resolveKlingOmniVideoEndpoint, resolveKlingVideoEndpoint } from './server/model-adapters.ts'
import { retrieveInternetSources } from './server/web-sources.ts'
import type { InternetSourceInput } from './server/web-sources.ts'
import { runLocalModel } from './server/local-model.ts'
import { readJson } from './server/request-json.ts'

type ModelProvider = 'Anthropic' | 'OpenAI' | 'Ofox' | 'Kling' | 'Local' | 'Custom'
type ModelCapability = 'text' | 'image' | 'video' | 'audio'
type Workflow = { id: string; name: string; description: string; nodes: unknown[]; edges: unknown[]; schemaVersion?: number }
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
type CharacterAsset = {
  id: string
  workflowId: string | null
  characterName: string
  description: string
  threeViewUrl: string
  version: number
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
type CharacterAssetInput = Omit<CharacterAsset, 'id' | 'version' | 'createdAt' | 'updatedAt'>
type NodeRunRequest = {
  model: ModelConfig
  prompt: string
  params: Record<string, unknown>
  operation?: string
  executionContext?: { workflowId?: string; workflowName?: string; nodeId?: string; nodeName?: string }
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

      create table if not exists execution_records (
        id text primary key,
        workflow_id text not null,
        workflow_name text not null,
        mode text not null,
        title text not null,
        runtime_inputs jsonb not null default '{}'::jsonb,
        result jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );

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

async function readCharacterAssets(workflowId?: string): Promise<CharacterAsset[]> {
  await ensureSchema()
  const result = workflowId
    ? await pool.query(
        `select id, workflow_id, character_name, uri, prompt, version, metadata, created_at, updated_at
           from character_assets
          where asset_type = 'three-view' and workflow_id = $1
          order by updated_at desc`,
        [workflowId],
      )
    : await pool.query(
        `select id, workflow_id, character_name, uri, prompt, version, metadata, created_at, updated_at
           from character_assets
          where asset_type = 'three-view'
          order by updated_at desc`,
      )
  return result.rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    characterName: row.character_name,
    description: row.prompt,
    threeViewUrl: row.uri,
    version: row.version,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

async function createCharacterAsset(input: CharacterAssetInput): Promise<CharacterAsset> {
  await ensureSchema()
  const name = input.characterName.trim()
  if (!name) throw new Error('角色名称不能为空')
  if (!input.workflowId) throw new Error('请选择所属工作流')
  if (!input.threeViewUrl.trim()) throw new Error('请上传或填写角色三视图')
  const id = `character-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const result = await pool.query(
    `insert into character_assets (id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, updated_at)
     values ($1, $2, $3, 'three-view', $4, $5, 1, $6::jsonb, now())
     returning id, workflow_id, character_name, uri, prompt, version, metadata, created_at, updated_at`,
    [id, input.workflowId, name, input.threeViewUrl.trim(), input.description.trim(), JSON.stringify(input.metadata ?? {})],
  )
  return (await readCharacterAssets()).find((item) => item.id === result.rows[0].id) as CharacterAsset
}

async function updateCharacterAsset(id: string, input: CharacterAssetInput): Promise<CharacterAsset> {
  await ensureSchema()
  const name = input.characterName.trim()
  if (!name) throw new Error('角色名称不能为空')
  if (!input.workflowId) throw new Error('请选择所属工作流')
  if (!input.threeViewUrl.trim()) throw new Error('请上传或填写角色三视图')
  const result = await pool.query(
    `update character_assets
        set workflow_id = $2, character_name = $3, uri = $4, prompt = $5,
            version = version + 1, metadata = $6::jsonb, updated_at = now()
      where id = $1 and asset_type = 'three-view'
      returning id`,
    [id, input.workflowId, name, input.threeViewUrl.trim(), input.description.trim(), JSON.stringify(input.metadata ?? {})],
  )
  if (!result.rowCount) throw new Error('角色不存在或已被删除')
  return (await readCharacterAssets()).find((item) => item.id === id) as CharacterAsset
}

async function deleteCharacterAsset(id: string) {
  await ensureSchema()
  const result = await pool.query("delete from character_assets where id = $1 and asset_type = 'three-view'", [id])
  if (!result.rowCount) throw new Error('角色不存在或已被删除')
}

async function readExecutionRecords(workflowId?: string): Promise<ExecutionRecord[]> {
  await ensureSchema()
  const result = workflowId
    ? await pool.query(
        'select id, workflow_id, workflow_name, mode, title, runtime_inputs, result, created_at from execution_records where workflow_id = $1 order by created_at desc limit 40',
        [workflowId],
      )
    : await pool.query('select id, workflow_id, workflow_name, mode, title, runtime_inputs, result, created_at from execution_records order by created_at desc limit 40')
  return result.rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    mode: row.mode,
    title: row.title,
    runtimeInputs: row.runtime_inputs,
    result: row.result,
    createdAt: row.created_at,
  }))
}

async function saveExecutionRecord(record: ExecutionRecord) {
  await ensureSchema()
  await pool.query(
    `
      insert into execution_records (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, created_at)
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now())
      on conflict (id) do update set
        workflow_id = excluded.workflow_id,
        workflow_name = excluded.workflow_name,
        mode = excluded.mode,
        title = excluded.title,
        runtime_inputs = excluded.runtime_inputs,
        result = excluded.result
    `,
    [record.id, record.workflowId, record.workflowName, record.mode, record.title, JSON.stringify(record.runtimeInputs), JSON.stringify(record.result)],
  )
}

function safeExecutionPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value) || value.length > 10000) return `[内容已隐藏，${value.length} 字符]`
    return value
  }
  if (Array.isArray(value)) return value.map(safeExecutionPayload)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, /apiKey|accessKey|secretKey|authorization/i.test(key) ? '[hidden]' : safeExecutionPayload(child)]))
  }
  return value
}

function executionTaskInfo(body: unknown) {
  const root = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {}
  const taskId = String(data.task_id ?? root.task_id ?? root.taskId ?? '')
  const providerStatus = String(data.task_status ?? root.task_status ?? root.status ?? '').toLowerCase()
  return { taskId, providerStatus }
}

function modelExecutionStatus(httpStatus: number, body: unknown) {
  if (httpStatus >= 400) return 'failed'
  const { providerStatus, taskId } = executionTaskInfo(body)
  if (/fail|error|cancel/.test(providerStatus)) return 'failed'
  if (/succeed|success|complete|completed/.test(providerStatus)) return 'succeeded'
  if (taskId || /submit|process|running|pending|queue|wait/.test(providerStatus)) return 'processing'
  return 'succeeded'
}

async function saveModelExecutionRecord(record: ModelExecutionRecord) {
  try {
    await ensureSchema()
    await pool.query(
      `insert into model_execution_records
        (id, channel, model_id, model_name, provider, capability, status, http_status, task_id,
         workflow_id, workflow_name, node_id, node_name, request_data, response_data, error, duration_ms, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, nullif($9, ''), $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, now())`,
      [record.id, record.channel, record.modelId, record.modelName, record.provider, record.capability, record.status,
        record.httpStatus ?? null, record.taskId ?? '', record.workflowId ?? null, record.workflowName ?? null,
        record.nodeId ?? null, record.nodeName ?? null, JSON.stringify(safeExecutionPayload(record.requestData)),
        JSON.stringify(safeExecutionPayload(record.responseData)), record.error ?? null, record.durationMs],
    )
  } catch {
    // 流水持久化失败不能阻断真实模型调用。
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
    pool.query('select id, name, description, nodes, edges, schema_version from workflow_configs order by updated_at, id'),
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
    await client.query('delete from workflow_configs where not (id = any($1::text[]))', [workflows.map((workflow) => workflow.id)])
    for (const workflow of workflows) {
      await client.query(
        `
          insert into workflow_configs (id, name, description, nodes, edges, schema_version, updated_at)
          values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
          on conflict (id) do update set
            name = excluded.name,
            description = excluded.description,
            nodes = excluded.nodes,
            edges = excluded.edges,
            schema_version = excluded.schema_version,
            updated_at = now()
        `,
        [workflow.id, workflow.name, workflow.description, JSON.stringify(workflow.nodes), JSON.stringify(workflow.edges), workflow.schemaVersion ?? 1],
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
  const settings = model.settings

  if (model.provider === 'Local') {
    return { status: 200, body: runLocalModel({ capability: model.capability, prompt: model.testInput, params: { ...settings, ...params } }) }
  }

  if (model.provider === 'Anthropic') {
    if (!settings.apiKey) throw new Error('缺少 Anthropic API Key')
    const response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: Number(params.maxTokens ?? settings.maxTokens ?? 300),
        temperature: Number(params.temperature ?? settings.temperature ?? 0.7),
        messages: [{ role: 'user', content: model.testInput }],
      }),
    })
    return { status: response.status, body: await response.json().catch(() => response.text()) }
  }

  if ((model.provider === 'OpenAI' || model.provider === 'Ofox') && model.capability === 'image') {
    return callOpenAiImage(model, model.testInput, params)
  }

  if (model.provider === 'OpenAI' && model.capability === 'audio') {
    if (!settings.apiKey) throw new Error('缺少 OpenAI API Key')
    const response = await fetch(settings.endpoint, {
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
      : await response.json().catch(() => response.text())
    return { status: response.status, body }
  }

  if (model.provider === 'Kling' && model.capability === 'image') {
    return callKlingImage(model, model.testInput, params)
  }

  if (model.provider === 'Kling') {
    const requestBody = buildKlingVideoRequest(model, model.testInput, params)
    const endpoint = Array.isArray(requestBody.image_list)
      ? resolveKlingOmniVideoEndpoint(settings.endpoint)
      : resolveKlingVideoEndpoint(settings.endpoint, Boolean(requestBody.image))
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: klingAuthorization(settings),
      },
      body: JSON.stringify(requestBody),
    })
    return { status: response.status, body: await response.json().catch(() => response.text()) }
  }

  return { status: 200, body: { ok: true, message: 'Custom 模型暂无真实适配器', params } }
}

async function queryModelTestTask({ model, taskId, queryMode }: ModelTestStatusRequest) {
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
    const response = await fetch(`${endpoint}/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: { Authorization: klingAuthorization(model.settings) },
    })
    const body = await response.json().catch(() => response.text())
    const code = body && typeof body === 'object' && 'code' in body ? Number((body as { code?: unknown }).code) : 0
    lastResult = { status: response.ok && code !== 0 ? 502 : response.status, body }
    if (response.ok && code === 0) return lastResult
  }
  return lastResult
}

async function callNodeExternalUntracked({ model, prompt, params, operation }: NodeRunRequest) {
  const settings = model.settings

  if (model.provider === 'Local') {
    return { status: 200, body: runLocalModel({ capability: model.capability, operation, prompt, params }) }
  }

  if (model.provider === 'Anthropic') {
    if (!settings.apiKey) throw new Error('缺少 Anthropic API Key')
    const response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: operation?.startsWith('history.')
          ? Math.max(4096, Number(settings.maxTokens || 0))
          : Number(settings.maxTokens || 1200),
        temperature: Number(settings.temperature || 0.7),
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const body = await response.json().catch(() => response.text())
    return { status: response.status, body }
  }

  if ((model.provider === 'OpenAI' || model.provider === 'Ofox') && model.capability === 'image') {
    return callOpenAiImage(model, prompt, params)
  }

  if (model.provider === 'OpenAI' && model.capability === 'audio') {
    if (!settings.apiKey) throw new Error('缺少 OpenAI API Key')
    const response = await fetch(settings.endpoint, {
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
      : await response.json().catch(() => response.text())
    return { status: response.status, body }
  }

  if (model.provider === 'Kling' && model.capability === 'image') {
    return callKlingImage(model, prompt, params)
  }

  if (model.provider === 'Kling') {
    const requestBody = buildKlingVideoRequest(model, prompt, params)
    const endpoint = Array.isArray(requestBody.image_list)
      ? resolveKlingOmniVideoEndpoint(settings.endpoint)
      : resolveKlingVideoEndpoint(settings.endpoint, Boolean(requestBody.image))
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: klingAuthorization(settings),
      },
      body: JSON.stringify(requestBody),
    })
    const body = await response.json().catch(() => response.text())
    return { status: response.status, body }
  }

  throw new Error(`${model.provider} ${model.capability} 暂无真实节点适配器`)
}

async function callNodeExternal(request: NodeRunRequest) {
  const startedAt = Date.now()
  const id = `model-run-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  try {
    const result = await callNodeExternalUntracked(request)
    const task = executionTaskInfo(result.body)
    await saveModelExecutionRecord({
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
      requestData: { prompt: request.prompt, params: request.params, operation: request.operation },
      responseData: result.body,
      durationMs: Date.now() - startedAt,
    })
    return result
  } catch (error) {
    const message = errorMessage(error)
    await saveModelExecutionRecord({
      id,
      channel: 'workflow',
      modelId: request.model.id,
      modelName: request.model.name,
      provider: request.model.provider,
      capability: request.model.capability,
      status: 'failed',
      workflowId: request.executionContext?.workflowId,
      workflowName: request.executionContext?.workflowName,
      nodeId: request.executionContext?.nodeId,
      nodeName: request.executionContext?.nodeName,
      requestData: { prompt: request.prompt, params: request.params, operation: request.operation },
      error: message,
      durationMs: Date.now() - startedAt,
    })
    throw error
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'postgres-config-api',
      configureServer(server) {
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
            return jsonResponse(res, 500, { error: errorMessage(error), databaseUrl })
          }
        })
        server.middlewares.use('/api/characters', async (req, res) => {
          try {
            const url = new URL(req.url ?? '', 'http://localhost')
            const id = url.pathname.split('/').filter(Boolean)[0]
            if (req.method === 'GET' && !id) {
              return jsonResponse(res, 200, { characters: await readCharacterAssets(url.searchParams.get('workflowId') ?? undefined) })
            }
            if (req.method === 'POST' && !id) {
              const body = await readJson<CharacterAssetInput>(req)
              return jsonResponse(res, 201, { character: await createCharacterAsset(body) })
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
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
            Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res)
          } catch (error) {
            return jsonResponse(res, 502, { error: errorMessage(error) })
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
