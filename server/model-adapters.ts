import { createHmac } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'

export type ExternalModelConfig = {
  id: string
  provider: string
  capability: string
  settings: Record<string, string>
}

export type ModelAdapterResult = { status: number; body: unknown }

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type KlingAdapterDependencies = {
  fetch?: FetchLike
  sleep?: (milliseconds: number) => Promise<void>
}

// Some local resolvers return an unrelated address for Ofox. Resolve only this known API
// host through trusted DNS while keeping the original hostname for TLS SNI/verification.
const trustedImageDnsHosts = new Set(['api.ofox.ai'])
const trustedImageDnsResolver = new Resolver()
trustedImageDnsResolver.setServers(['1.1.1.1', '8.8.8.8'])

const trustedImageDnsLookup: LookupFunction = (hostname, options, callback) => {
  trustedImageDnsResolver.resolve4(hostname).then(
    (addresses) => {
      if (!addresses.length) {
        const error = new Error(`可信 DNS 未返回 ${hostname} 的 IPv4 地址`) as NodeJS.ErrnoException
        error.code = 'ENOTFOUND'
        callback(error, '')
        return
      }
      callback(null, options.all ? addresses.map((address) => ({ address, family: 4 })) : addresses[0], 4)
    },
    (error: NodeJS.ErrnoException) => callback(error, ''),
  )
}

function requestBodyBuffer(body: unknown) {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  throw new Error('可信 DNS 图片请求仅支持字符串或二进制请求体')
}

function fetchWithTrustedImageDns(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const endpoint = input instanceof Request ? new URL(input.url) : new URL(input)
  const payload = requestBodyBuffer(init?.body)
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  if (payload && !headers.has('content-length')) headers.set('content-length', String(payload.byteLength))

  return new Promise((resolve, reject) => {
    const request = httpsRequest(endpoint, {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: Object.fromEntries(headers.entries()),
      lookup: trustedImageDnsLookup,
      signal: init?.signal ?? undefined,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => {
        const responseHeaders = new Headers()
        Object.entries(response.headers).forEach(([key, value]) => {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item))
          else if (value !== undefined) responseHeaders.set(key, String(value))
        })
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }))
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

function fetchImageEndpoint(input: string | URL | Request, init?: RequestInit) {
  const endpoint = input instanceof Request ? new URL(input.url) : new URL(input)
  return trustedImageDnsHosts.has(endpoint.hostname)
    ? fetchWithTrustedImageDns(input, init)
    : fetch(input, init)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function numericValue(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function optionalString(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

function optionalBoolean(value: unknown) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

function optionalNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function jsonValue(value: unknown) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function parseResponseBody(response: Response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function providerResultStatus(response: Response, body: unknown) {
  if (!response.ok) return response.status
  if (isRecord(body) && typeof body.code === 'number' && body.code !== 0) return 502
  return response.status
}

function imageValue(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.flatMap(imageValue)
  if (!isRecord(value)) return []
  for (const key of ['url', 'image_url', 'dataUrl', 'data_url']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return [candidate.trim()]
  }
  return imageValue(value.items)
}

export function collectReferenceImages(params: Record<string, unknown>) {
  const values = [
    params.input_images,
    params.inputImages,
    params.referenceImages,
    params.referenceImage,
    params.images,
    params.image,
  ].flatMap(imageValue)
  return [...new Set(values)]
}

export function stripImageDataUrlPrefix(value: string) {
  return value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
}

function imageMimeType(outputFormat: string) {
  if (outputFormat === 'jpg' || outputFormat === 'jpeg') return 'image/jpeg'
  if (outputFormat === 'webp') return 'image/webp'
  return 'image/png'
}

export function normalizeBase64ImageResponse(body: unknown, outputFormat = 'png') {
  if (!isRecord(body) || !Array.isArray(body.data)) return body
  const mimeType = imageMimeType(outputFormat)
  return {
    ...body,
    data: body.data.map((item) => {
      if (!isRecord(item) || typeof item.b64_json !== 'string' || !item.b64_json) return item
      return {
        ...item,
        b64_json: '[base64 converted to data URL]',
        url: `data:${mimeType};base64,${item.b64_json}`,
      }
    }),
  }
}

export function buildOpenAiImageRequest(model: ExternalModelConfig, prompt: string, params: Record<string, unknown>) {
  const settings = model.settings
  const outputFormat = String(params.outputFormat ?? params.output_format ?? settings.outputFormat ?? settings.output_format ?? 'png')
  const request: Record<string, unknown> = {
    model: settings.model,
    prompt,
    size: String(params.size ?? settings.size ?? '1024x1024'),
    quality: String(params.quality ?? settings.quality ?? 'high'),
    n: numericValue(params.n ?? settings.n, 1),
    output_format: outputFormat,
  }
  const background = optionalString(params.background ?? settings.background)
  if (background) request.background = background
  if (model.provider === 'Ofox') {
    const references = collectReferenceImages(params).slice(0, 3).map(stripImageDataUrlPrefix)
    if (references.length) request.input_images = references
  }
  return request
}

export async function callOpenAiImage(
  model: ExternalModelConfig,
  prompt: string,
  params: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<ModelAdapterResult> {
  const settings = model.settings
  if (!settings.apiKey) throw new Error(`缺少 ${model.provider} API Key`)
  if (!settings.endpoint) throw new Error(`缺少 ${model.provider} 图片生成 Endpoint`)
  const requestBody = buildOpenAiImageRequest(model, prompt, params)
  const response = await (fetchImpl ?? fetchImageEndpoint)(settings.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  })
  const body = await parseResponseBody(response)
  return {
    status: providerResultStatus(response, body),
    body: normalizeBase64ImageResponse(body, String(requestBody.output_format ?? 'png')),
  }
}

function base64Url(input: string) {
  return Buffer.from(input).toString('base64url')
}

export function createKlingToken(accessKey: string, secretKey: string, now = Date.now()) {
  const timestamp = Math.floor(now / 1000)
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ iss: accessKey, exp: timestamp + 1800, nbf: timestamp - 5 }))
  const signature = createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

export function klingAuthorization(settings: Record<string, string>) {
  if (settings.apiKey) return `Bearer ${settings.apiKey}`
  if (settings.accessKey && settings.secretKey) return `Bearer ${createKlingToken(settings.accessKey, settings.secretKey)}`
  throw new Error('缺少 Kling API Key，或 Access Key / Secret Key')
}

export function buildKlingImageRequest(model: ExternalModelConfig, prompt: string, params: Record<string, unknown>) {
  const settings = model.settings
  const referenceImage = collectReferenceImages(params)[0]
  const request: Record<string, unknown> = {
    model_name: settings.model || 'kling-v3',
    prompt,
    resolution: String(params.resolution ?? settings.resolution ?? '1k'),
    n: Math.min(9, Math.max(1, numericValue(params.n ?? settings.n, 1))),
    aspect_ratio: String(params.aspectRatio ?? params.aspect_ratio ?? settings.aspectRatio ?? settings.aspect_ratio ?? '9:16'),
  }
  if (referenceImage) {
    request.image = stripImageDataUrlPrefix(referenceImage)
  } else {
    const negativePrompt = optionalString(params.negativePrompt ?? params.negative_prompt ?? settings.negativePrompt ?? settings.negative_prompt)
    if (negativePrompt) request.negative_prompt = negativePrompt
  }
  const watermarkEnabled = optionalBoolean(params.watermarkEnabled ?? settings.watermarkEnabled)
  if (watermarkEnabled !== undefined) request.watermark_info = { enabled: watermarkEnabled }
  return request
}

export function buildKlingVideoRequest(model: ExternalModelConfig, prompt: string, params: Record<string, unknown>) {
  const settings = model.settings
  const image = imageValue(params.referenceImage ?? params.image)[0]
  const referenceImages = [...new Set(imageValue(params.referenceImages))].slice(0, 7)
  const useOmni = referenceImages.length > 0
  const endImage = optionalString(params.endImage ?? params.imageTail ?? params.image_tail)
  const configuredModelName = String(params.model_name ?? params.modelName ?? settings.model ?? 'kling-v3')
  const modelName = useOmni && !configuredModelName.includes('omni') ? 'kling-v3-omni' : configuredModelName
  const requestedDuration = optionalNumber(params.duration ?? settings.duration) ?? 5
  const duration = modelName.startsWith('kling-v3')
    ? Math.min(15, Math.max(3, requestedDuration))
    : requestedDuration
  const request: Record<string, unknown> = {
    model_name: modelName,
    prompt: referenceImages.reduce(
      (text, _, index) => text.replaceAll(`@参考附件${index + 1}`, `<<<image_${index + 1}>>>`),
      optionalString(prompt) ?? '让画面自然运动。',
    ),
    duration: String(duration),
    mode: String(params.mode ?? settings.mode ?? 'std'),
  }
  const sound = optionalString(params.sound ?? settings.sound)
  if (sound) request.sound = sound
  const negativePrompt = optionalString(params.negative_prompt ?? params.negativePrompt ?? settings.negative_prompt ?? settings.negativePrompt)
  if (negativePrompt) request.negative_prompt = negativePrompt
  const cfgScale = optionalNumber(params.cfg_scale ?? params.cfgScale ?? settings.cfg_scale ?? settings.cfgScale)
  if (cfgScale !== undefined) request.cfg_scale = Math.min(1, Math.max(0, cfgScale))
  if (useOmni) {
    request.image_list = [
      ...referenceImages.map((reference) => ({ image_url: stripImageDataUrlPrefix(reference) })),
      ...(image ? [{ image_url: stripImageDataUrlPrefix(image), type: 'first_frame' }] : []),
      ...(image && endImage ? [{ image_url: stripImageDataUrlPrefix(endImage), type: 'end_frame' }] : []),
    ]
    if (!image) request.aspect_ratio = String(params.aspect_ratio ?? params.aspectRatio ?? settings.aspect_ratio ?? settings.aspectRatio ?? '16:9')
  } else if (image) {
    request.image = stripImageDataUrlPrefix(image)
    if (endImage) request.image_tail = stripImageDataUrlPrefix(endImage)
    const staticMask = optionalString(params.static_mask ?? params.staticMask)
    if (staticMask) request.static_mask = stripImageDataUrlPrefix(staticMask)
    const dynamicMasks = jsonValue(params.dynamic_masks ?? params.dynamicMasks)
    if (Array.isArray(dynamicMasks) && dynamicMasks.length) request.dynamic_masks = dynamicMasks
  } else {
    request.aspect_ratio = String(params.aspect_ratio ?? params.aspectRatio ?? settings.aspect_ratio ?? settings.aspectRatio ?? '16:9')
  }
  const multiShot = optionalBoolean(params.multi_shot ?? params.multiShot)
  if (multiShot !== undefined) request.multi_shot = multiShot
  if (multiShot) {
    const shotType = optionalString(params.shot_type ?? params.shotType) ?? 'intelligence'
    request.shot_type = shotType
    const multiPrompt = jsonValue(params.multi_prompt ?? params.multiPrompt)
    if (shotType === 'customize' && Array.isArray(multiPrompt) && multiPrompt.length) request.multi_prompt = multiPrompt
  }
  const cameraControl = jsonValue(params.camera_control ?? params.cameraControl)
  if (isRecord(cameraControl) && Object.keys(cameraControl).length) request.camera_control = cameraControl
  const callbackUrl = optionalString(params.callback_url ?? params.callbackUrl)
  if (callbackUrl) request.callback_url = callbackUrl
  const externalTaskId = optionalString(params.external_task_id ?? params.externalTaskId)
  if (externalTaskId) request.external_task_id = externalTaskId
  return request
}

export function resolveKlingVideoEndpoint(endpoint: string, hasImage: boolean) {
  const route = hasImage ? 'image2video' : 'text2video'
  const normalized = endpoint.replace(/\/$/, '')
  return /\/(text2video|image2video|omni-video)$/.test(normalized)
    ? normalized.replace(/\/(text2video|image2video|omni-video)$/, `/${route}`)
    : `${normalized}/${route}`
}

export function resolveKlingOmniVideoEndpoint(endpoint: string) {
  const normalized = endpoint.replace(/\/$/, '')
  return /\/(text2video|image2video|omni-video)$/.test(normalized)
    ? normalized.replace(/\/(text2video|image2video|omni-video)$/, '/omni-video')
    : `${normalized}/omni-video`
}

function klingTask(body: unknown) {
  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined
  return {
    id: typeof data?.task_id === 'string' ? data.task_id : '',
    status: typeof data?.task_status === 'string' ? data.task_status : '',
    message: typeof data?.task_status_msg === 'string' ? data.task_status_msg : '',
  }
}

export async function callKlingImage(
  model: ExternalModelConfig,
  prompt: string,
  params: Record<string, unknown>,
  dependencies: KlingAdapterDependencies = {},
): Promise<ModelAdapterResult> {
  const settings = model.settings
  if (!settings.endpoint) throw new Error('缺少 Kling 图片生成 Endpoint')
  const fetchImpl = dependencies.fetch ?? fetch
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const headers = {
    'Content-Type': 'application/json',
    Authorization: klingAuthorization(settings),
  }
  const endpoint = settings.endpoint.replace(/\/$/, '')
  const createResponse = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildKlingImageRequest(model, prompt, params)),
  })
  let body = await parseResponseBody(createResponse)
  let status = providerResultStatus(createResponse, body)
  if (status >= 400) return { status, body }

  let task = klingTask(body)
  if (!task.id || task.status === 'succeed') return { status, body }
  if (task.status === 'failed') return { status: 502, body }

  const pollIntervalMs = Math.max(100, numericValue(settings.pollIntervalMs, 3000))
  const timeoutMs = Math.max(pollIntervalMs, numericValue(settings.taskTimeoutMs, 180000))
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs)
    const queryResponse = await fetchImpl(`${endpoint}/${encodeURIComponent(task.id)}`, { method: 'GET', headers })
    body = await parseResponseBody(queryResponse)
    status = providerResultStatus(queryResponse, body)
    if (status >= 400) return { status, body }
    task = klingTask(body)
    if (task.status === 'succeed') return { status, body }
    if (task.status === 'failed') return { status: 502, body }
  }

  return {
    status: 504,
    body: {
      error: `Kling 图片生成任务等待超时（task_id: ${task.id}）`,
      task_id: task.id,
      task_status: task.status,
      task_status_msg: task.message,
    },
  }
}
