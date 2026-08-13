import pg from 'pg'
import { callKlingImage, callOpenAiImage } from '../server/model-adapters.ts'

const target = process.env.IMAGE_MODEL_SMOKE_TARGET ?? 'all'
const selectedTargets = target === 'all' ? ['qwen', 'kling'] : target.split(',').map((item) => item.trim()).filter(Boolean)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

function firstUrl(value) {
  if (typeof value === 'string' && (value.startsWith('data:image/') || /^https?:\/\//.test(value))) return value
  if (Array.isArray(value)) return value.map(firstUrl).find(Boolean) || ''
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      const found = firstUrl(child)
      if (found) return found
    }
  }
  return ''
}

function safeResult(name, result) {
  const url = firstUrl(result.body)
  return {
    model: name,
    status: result.status,
    imageReady: Boolean(url),
    imageTransport: url.startsWith('data:') ? 'data-url' : url ? 'https-url' : 'none',
    imagePayloadLength: url.length,
  }
}

async function storedModel(id) {
  const result = await pool.query('select id, provider, capability, settings from model_configs where id = $1', [id])
  return result.rows[0]
}

async function smokeQwen() {
  const gptImage = await storedModel('gpt-image-2')
  if (!gptImage?.settings?.apiKey) throw new Error('gpt-image-2 未配置 API Key，无法验证共享凭据')
  const model = {
    id: 'qwen-image-3-pro',
    provider: 'Ofox',
    capability: 'image',
    settings: {
      endpoint: 'https://api.ofox.ai/v1/images/generations',
      apiKey: gptImage.settings.apiKey,
      model: 'bailian/qwen-image-3.0-pro:free',
      size: '1024x1024',
      quality: 'high',
      outputFormat: 'png',
      n: '1',
    },
  }
  return safeResult('qwen-image-3-pro', await callOpenAiImage(model, '极简白色背景上的一只青瓷茶杯，柔和棚拍光线，无文字', {}))
}

async function smokeKling() {
  const klingVideo = await storedModel('keling3')
  const settings = klingVideo?.settings ?? {}
  if (!settings.apiKey && (!settings.accessKey || !settings.secretKey)) throw new Error('keling3 未配置可用凭据，无法验证共享凭据')
  const region = String(settings.endpoint ?? '').includes('api-beijing.') ? 'beijing' : 'singapore'
  const model = {
    id: 'kling-image-3',
    provider: 'Kling',
    capability: 'image',
    settings: {
      endpoint: `https://api-${region}.klingai.com/v1/images/generations`,
      apiKey: settings.apiKey ?? '',
      accessKey: settings.accessKey ?? '',
      secretKey: settings.secretKey ?? '',
      model: 'kling-v3',
      resolution: '1k',
      aspectRatio: '1:1',
      n: '1',
      pollIntervalMs: '3000',
      taskTimeoutMs: '300000',
    },
  }
  return safeResult('kling-image-3', await callKlingImage(model, '极简白色背景上的一只青瓷茶杯，柔和棚拍光线，无文字', {}))
}

const runners = { qwen: smokeQwen, kling: smokeKling }
const results = []
try {
  for (const name of selectedTargets) {
    const runner = runners[name]
    if (!runner) throw new Error(`未知测试目标：${name}`)
    const result = await runner()
    results.push(result)
    if (result.status >= 400 || !result.imageReady) throw new Error(`${result.model} 未返回可用图片（HTTP ${result.status}）`)
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ ok: false, results, error: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exitCode = 1
} finally {
  await pool.end()
}
