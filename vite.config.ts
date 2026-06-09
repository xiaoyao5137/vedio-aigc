import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHmac } from 'node:crypto'
import pg from 'pg'

type ModelProvider = 'Anthropic' | 'OpenAI' | 'Kling' | 'Custom'
type ModelCapability = 'text' | 'image' | 'video'
type Workflow = { id: string; name: string; description: string; nodes: unknown[]; edges: unknown[] }
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
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object') return JSON.stringify(error)
  return String(error)
}

function readJson<T>(req: import('node:http').IncomingMessage) {
  return new Promise<T>((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function base64Url(input: string) {
  return Buffer.from(input).toString('base64url')
}

function createKlingToken(accessKey: string, secretKey: string) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }))
  const signature = createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

function ensureSchema() {
  schemaReady ??= pool.query(`
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
      updated_at timestamptz not null default now()
    );
  `)
    .then(() => undefined)
    .catch((error) => {
      schemaReady = undefined
      throw error
    })
  return schemaReady
}

async function readAppConfig(): Promise<AppConfig> {
  await ensureSchema()
  const [models, workflows] = await Promise.all([
    pool.query('select id, name, provider, capability, settings, test_input, test_result from model_configs order by updated_at, id'),
    pool.query('select id, name, description, nodes, edges from workflow_configs order by updated_at, id'),
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
          insert into workflow_configs (id, name, description, nodes, edges, updated_at)
          values ($1, $2, $3, $4::jsonb, $5::jsonb, now())
          on conflict (id) do update set
            name = excluded.name,
            description = excluded.description,
            nodes = excluded.nodes,
            edges = excluded.edges,
            updated_at = now()
        `,
        [workflow.id, workflow.name, workflow.description, JSON.stringify(workflow.nodes), JSON.stringify(workflow.edges)],
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

async function callExternal(model: ModelConfig) {
  const settings = model.settings

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
        max_tokens: Number(settings.maxTokens || 300),
        temperature: Number(settings.temperature || 0.7),
        messages: [{ role: 'user', content: model.testInput }],
      }),
    })
    return { status: response.status, body: await response.json().catch(() => response.text()) }
  }

  if (model.provider === 'OpenAI' && model.capability === 'image') {
    if (!settings.apiKey) throw new Error('缺少 OpenAI API Key')
    const response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        prompt: model.testInput,
        size: settings.size,
        quality: settings.quality,
        n: Number(settings.n || 1),
      }),
    })
    return { status: response.status, body: await response.json().catch(() => response.text()) }
  }

  if (model.provider === 'Kling') {
    if (!settings.accessKey || !settings.secretKey) throw new Error('缺少 Kling Access Key 或 Secret Key')
    const endpoint = settings.endpoint.endsWith('/text2video') ? settings.endpoint : `${settings.endpoint.replace(/\/$/, '')}/text2video`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${createKlingToken(settings.accessKey, settings.secretKey)}`,
      },
      body: JSON.stringify({
        model: settings.model,
        prompt: model.testInput,
        duration: Number(settings.duration || 5),
        aspect_ratio: settings.aspectRatio,
        mode: settings.mode,
      }),
    })
    return { status: response.status, body: await response.json().catch(() => response.text()) }
  }

  return { status: 200, body: { ok: true, message: 'Custom 模型暂无真实适配器', settings } }
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
        server.middlewares.use('/api/model-test', async (req, res) => {
          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })
          try {
            const model = await readJson<ModelConfig>(req)
            const result = await callExternal(model)
            return jsonResponse(res, 200, result)
          } catch (error) {
            return jsonResponse(res, 500, { status: 500, body: { error: errorMessage(error) } })
          }
        })
      },
    },
  ],
})
