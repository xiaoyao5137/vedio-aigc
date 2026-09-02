import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { detectVerticalTriptych, prepareThreeViewFrontReference, prepareThreeViewVideoReferences } from './image-references.ts'

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

export const KLING_PROMPT_MAX_LENGTH = 2500
const klingPromptTruncationMarker = '\n[content shortened to fit Kling prompt limit]\n'

/**
 * Kling validates prompt length after all reference instructions have been added.
 * Keep both the opening scene/identity constraints and the ending/audio directions
 * instead of dropping the tail wholesale. Array.from avoids splitting a surrogate
 * pair when prompts contain emoji or other astral Unicode characters.
 */
export function limitKlingPrompt(prompt: string, maxLength = KLING_PROMPT_MAX_LENGTH) {
  const characters = Array.from(prompt.trim())
  if (characters.length <= maxLength) return characters.join('')
  const marker = Array.from(klingPromptTruncationMarker)
  const contentLength = Math.max(0, maxLength - marker.length)
  const headLength = Math.ceil(contentLength * 0.7)
  const tailLength = contentLength - headLength
  return [
    ...characters.slice(0, headLength),
    ...marker,
    ...(tailLength ? characters.slice(-tailLength) : []),
  ].slice(0, maxLength).join('')
}

// Some local resolvers return unrelated addresses for configured model gateways. Resolve
// only these known API hosts through trusted DNS while preserving TLS SNI/verification.
const trustedModelDnsHosts = new Set(['api.ofox.ai', 'doro.lol'])
const trustedModelDnsResolver = new Resolver()
trustedModelDnsResolver.setServers(['1.1.1.1', '8.8.8.8'])

type ProxyEnvironment = Record<string, string | undefined>
let macOsProxyCache: { expiresAt: number; url: string } | undefined

function envValue(environment: ProxyEnvironment, ...keys: string[]) {
  for (const key of keys) {
    const value = environment[key]?.trim()
    if (value) return value
  }
  return ''
}

function hostMatchesNoProxy(endpoint: URL, noProxy: string) {
  return noProxy.split(',').some((entry) => {
    const value = entry.trim().toLowerCase()
    if (!value) return false
    if (value === '*') return true
    const [host, port] = value.replace(/^\./, '').split(':')
    if (port && port !== endpoint.port && port !== (endpoint.protocol === 'https:' ? '443' : '80')) return false
    const hostname = endpoint.hostname.toLowerCase()
    return hostname === host || hostname.endsWith(`.${host}`)
  })
}

export function parseMacOsHttpsProxy(output: string) {
  const enabled = /^\s*HTTPSEnable\s*:\s*1\s*$/m.test(output)
  const host = output.match(/^\s*HTTPSProxy\s*:\s*(\S+)\s*$/m)?.[1]
  const port = output.match(/^\s*HTTPSPort\s*:\s*(\d+)\s*$/m)?.[1]
  if (!enabled || !host || !port) return ''
  return `http://${host}:${port}`
}

export function resolveModelProxyUrl(endpoint: URL, environment: ProxyEnvironment = process.env, macOsProxyOutput?: string) {
  const noProxy = envValue(environment, 'NO_PROXY', 'no_proxy')
  if (noProxy && hostMatchesNoProxy(endpoint, noProxy)) return ''
  const environmentProxy = endpoint.protocol === 'https:'
    ? envValue(environment, 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy')
    : envValue(environment, 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy')
  if (environmentProxy) return /^https?:\/\//i.test(environmentProxy) ? environmentProxy : ''
  return macOsProxyOutput ? parseMacOsHttpsProxy(macOsProxyOutput) : ''
}

function configuredModelProxy(endpoint: URL) {
  const fromEnvironment = resolveModelProxyUrl(endpoint)
  if (fromEnvironment || process.platform !== 'darwin' || endpoint.protocol !== 'https:') return fromEnvironment
  const now = Date.now()
  if (!macOsProxyCache || macOsProxyCache.expiresAt <= now) {
    let url = ''
    try {
      url = parseMacOsHttpsProxy(execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2_000 }))
    } catch {
      // A missing or unavailable system proxy should never prevent a direct request.
    }
    macOsProxyCache = { url, expiresAt: now + 30_000 }
  }
  return macOsProxyCache.url
}

const trustedModelDnsLookup: LookupFunction = (hostname, options, callback) => {
  trustedModelDnsResolver.resolve4(hostname).then(
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
  throw new Error('可信 DNS 模型请求仅支持字符串或二进制请求体')
}

function fetchWithModelNetwork(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const endpoint = input instanceof Request ? new URL(input.url) : new URL(input)
  const payload = requestBodyBuffer(init?.body)
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  if (payload && !headers.has('content-length')) headers.set('content-length', String(payload.byteLength))
  const proxyUrl = configuredModelProxy(endpoint)

  return new Promise((resolve, reject) => {
    const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: Object.fromEntries(headers.entries()),
      ...(proxyUrl
        ? { agent: new HttpsProxyAgent(proxyUrl) }
        : usesTrustedModelDns(endpoint) ? { lookup: trustedModelDnsLookup } : {}),
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

export function usesTrustedModelDns(input: string | URL | Request) {
  const endpoint = input instanceof Request ? new URL(input.url) : new URL(input)
  return trustedModelDnsHosts.has(endpoint.hostname)
}

export function fetchModelEndpoint(input: string | URL | Request, init?: RequestInit) {
  const endpoint = input instanceof Request ? new URL(input.url) : new URL(input)
  return configuredModelProxy(endpoint) || usesTrustedModelDns(endpoint)
    ? fetchWithModelNetwork(input, init)
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

export function imageSizeToAspectRatio(value: unknown) {
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return undefined
  const divisor = (left: number, right: number): number => right ? divisor(right, left % right) : left
  const common = divisor(width, height)
  return `${width / common}:${height / common}`
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
  const response = await (fetchImpl ?? fetchModelEndpoint)(settings.endpoint, {
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
  const requestedAspectRatio = optionalString(params.aspectRatio ?? params.aspect_ratio)
    ?? imageSizeToAspectRatio(params.size)
    ?? optionalString(settings.aspectRatio ?? settings.aspect_ratio)
    ?? imageSizeToAspectRatio(settings.size)
    ?? '9:16'
  const request: Record<string, unknown> = {
    model_name: settings.model || 'kling-v3',
    prompt: limitKlingPrompt(prompt),
    resolution: String(params.resolution ?? settings.resolution ?? '1k'),
    n: Math.min(9, Math.max(1, numericValue(params.n ?? settings.n, 1))),
    aspect_ratio: requestedAspectRatio,
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

function referenceBindingNames(params: Record<string, unknown>) {
  if (!Array.isArray(params.referenceBindings)) return []
  return params.referenceBindings.map((binding, index) => {
    if (typeof binding === 'string') return binding.trim() || `人物${index + 1}`
    if (isRecord(binding)) return optionalString(binding.characterName ?? binding.name) ?? `人物${index + 1}`
    return `人物${index + 1}`
  })
}

export function klingIdentityReferencePrompt(prompt: string, params: Record<string, unknown>) {
  const diagnostics = isRecord(params.referenceDiagnostics) ? params.referenceDiagnostics : {}
  const names = referenceBindingNames(params)
  const identityInstruction = diagnostics.composition === 'primary-panel' && names.length >= 2
    ? [`【主角身份参考】附件只包含${names[0]}的单人正面参考，只约束${names[0]}的身份，不代表构图；${names.slice(1).join('、')}必须与其共同出现在同一个连续场景内。`]
    : diagnostics.composition === 'single-panel'
      ? ['【人物身份参考】附件是从三视图中裁出的单个人物正面身份参考，只约束人物脸部、年龄、发式、体型和服装。']
      : []
  if (!identityInstruction.length) return prompt
  return [
    ...identityInstruction,
    '参考附件不代表输出构图。只生成一个单一时间点、一幅无边框全画幅连续场景；严禁分镜、拼贴、分栏、上下三段、连环画、画中画或重复人物。画面内严禁字幕、水印、标题、标签及任何可读文字；带文字的道具必须虚焦、背向镜头或仅呈现不可辨纹理。若场景描述含动作过程，只表现动作完成后的最终状态。',
    prompt,
  ].join('\n')
}

function klingImageUrl(body: unknown) {
  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined
  const taskResult = isRecord(data?.task_result) ? data.task_result : undefined
  const images = Array.isArray(taskResult?.images) ? taskResult.images : []
  return images
    .map((image) => isRecord(image) ? optionalString(image.url ?? image.image_url) : undefined)
    .find(Boolean)
}

async function verifyKlingImageLayout(
  status: number,
  body: unknown,
  fetchImpl: FetchLike,
  annotate: (value: unknown) => unknown,
): Promise<ModelAdapterResult> {
  const annotated = annotate(body)
  const imageUrl = klingImageUrl(body)
  if (!imageUrl) return { status, body: annotated }
  try {
    const layout = await detectVerticalTriptych(imageUrl, fetchImpl as typeof fetch)
    if (!layout.detected) return { status, body: annotated }
    return {
      status: 502,
      body: {
        error: 'Kling 返回了纵向三段式拼贴图，已被尾帧质量检查拒绝；请重试该节点',
        rejected_layout: 'vertical-triptych',
        layout_diagnostics: layout,
        provider_response: annotated,
      },
    }
  } catch {
    // A temporary CDN read failure must not discard an otherwise valid provider
    // result. The prevention path above already avoids sending identity boards.
    return { status, body: annotated }
  }
}

export function klingThreeViewVideoPrompt(prompt: string, params: Record<string, unknown>) {
  if (params.referenceMode !== 'three-view-all' || !Array.isArray(params.referenceImages) || !params.referenceImages.length) return prompt
  const viewNames = ['正面', '侧面', '背面']
  const bindingNames = referenceBindingNames(params)
  const groups: string[] = []
  for (let offset = 0; offset < params.referenceImages.length; offset += 3) {
    const references = params.referenceImages.slice(offset, offset + 3)
      .map((_, index) => `@参考附件${offset + index + 1}${viewNames[index]}`)
      .join('、')
    const characterIndex = Math.floor(offset / 3)
    groups.push(`${bindingNames[characterIndex] ?? `人物${characterIndex + 1}`}：${references}`)
  }
  return [
    `人物元素参考（每组三张为同一人物的不同角度）：${groups.join('；')}。`,
    '动作和运镜过程中必须根据朝向持续匹配对应角度的人脸、发式、体型、服装、纹样与配色；参考附件只定义人物身份，不代表分镜或画面分栏。',
    prompt,
  ].join('\n')
}

export function buildKlingVideoRequest(model: ExternalModelConfig, prompt: string, params: Record<string, unknown>) {
  const settings = model.settings
  const image = imageValue(params.referenceImage ?? params.image)[0]
  const referenceImages = [...new Set(imageValue(params.referenceImages))].slice(0, 7)
  const endImage = optionalString(params.endImage ?? params.imageTail ?? params.image_tail)
  const useOmni = referenceImages.length > 0
  const configuredModelName = String(params.model_name ?? params.modelName ?? settings.model ?? 'kling-v3')
  const modelName = useOmni && !configuredModelName.includes('omni') ? 'kling-v3-omni' : configuredModelName
  const requestedDuration = optionalNumber(params.duration ?? settings.duration) ?? 5
  const duration = modelName.startsWith('kling-v3')
    ? Math.min(15, Math.max(3, requestedDuration))
    : requestedDuration
  const referencedPrompt = referenceImages.reduce(
    (text, _, index) => text.replaceAll(`@参考附件${index + 1}`, `<<<image_${index + 1}>>>`),
    optionalString(prompt) ?? '让画面自然运动。',
  )
  const request: Record<string, unknown> = {
    model_name: modelName,
    prompt: limitKlingPrompt(referencedPrompt),
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
      // Kling rejects an end_frame unless the same request also contains a
      // first_frame (code 1201). Character references do not count as one.
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

function klingVideoUrl(body: unknown) {
  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined
  const taskResult = isRecord(data?.task_result) ? data.task_result : undefined
  const videos = Array.isArray(taskResult?.videos) ? taskResult.videos : []
  return videos
    .map((video) => isRecord(video) ? optionalString(video.url ?? video.video_url) : undefined)
    .find(Boolean)
}

function klingVideoFailure(message: string, body: unknown, taskId = ''): ModelAdapterResult {
  return {
    status: 502,
    body: {
      error: message,
      ...(taskId ? { task_id: taskId } : {}),
      provider_response: body,
    },
  }
}

/**
 * Workflow video nodes need a finished media result, not merely an accepted async
 * task. Model Experience intentionally keeps its create/query flow separate so it
 * can show task progress interactively.
 */
export async function callKlingVideo(
  model: ExternalModelConfig,
  prompt: string,
  params: Record<string, unknown>,
  dependencies: KlingAdapterDependencies = {},
): Promise<ModelAdapterResult> {
  const settings = model.settings
  if (!settings.endpoint) throw new Error('缺少 Kling 视频生成 Endpoint')
  const fetchImpl = dependencies.fetch ?? fetchModelEndpoint
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const headers = {
    'Content-Type': 'application/json',
    Authorization: klingAuthorization(settings),
  }
  const preparedParams = await prepareThreeViewVideoReferences(params, fetchImpl as typeof fetch)
  const preparedPrompt = klingThreeViewVideoPrompt(prompt, preparedParams)
  const requestBody = buildKlingVideoRequest(model, preparedPrompt, preparedParams)
  const endpoint = Array.isArray(requestBody.image_list)
    ? resolveKlingOmniVideoEndpoint(settings.endpoint)
    : resolveKlingVideoEndpoint(settings.endpoint, Boolean(requestBody.image))
  const createResponse = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  })
  let body = await parseResponseBody(createResponse)
  let status = providerResultStatus(createResponse, body)
  if (status >= 400) return { status, body }

  let task = klingTask(body)
  if (task.status === 'succeed') {
    return klingVideoUrl(body)
      ? { status, body }
      : klingVideoFailure(`Kling 视频任务已完成，但结果中没有视频 URL（task_id: ${task.id || '未知'}）`, body, task.id)
  }
  if (task.status === 'failed') return klingVideoFailure(`Kling 视频生成失败：${task.message || '供应商未提供原因'}`, body, task.id)
  if (!task.id) return klingVideoFailure('Kling 视频接口未返回 task_id 或视频结果', body)

  const pollIntervalMs = Math.max(100, numericValue(settings.pollIntervalMs, 3000))
  const timeoutMs = Math.max(pollIntervalMs, numericValue(settings.taskTimeoutMs, 900000))
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs)
    const queryResponse = await fetchImpl(`${endpoint}/${encodeURIComponent(task.id)}`, { method: 'GET', headers })
    body = await parseResponseBody(queryResponse)
    status = providerResultStatus(queryResponse, body)
    if (status >= 400) return { status, body }
    task = klingTask(body)
    if (task.status === 'succeed') {
      return klingVideoUrl(body)
        ? { status, body }
        : klingVideoFailure(`Kling 视频任务已完成，但结果中没有视频 URL（task_id: ${task.id}）`, body, task.id)
    }
    if (task.status === 'failed') return klingVideoFailure(`Kling 视频生成失败：${task.message || '供应商未提供原因'}`, body, task.id)
  }

  return {
    status: 504,
    body: {
      error: `Kling 视频生成任务等待超时（task_id: ${task.id}）`,
      task_id: task.id,
      task_status: task.status,
      task_status_msg: task.message,
    },
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
  const fetchImpl = dependencies.fetch ?? fetchModelEndpoint
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const headers = {
    'Content-Type': 'application/json',
    Authorization: klingAuthorization(settings),
  }
  const endpoint = settings.endpoint.replace(/\/$/, '')
  const preparedParams = await prepareThreeViewFrontReference(params, fetchImpl as typeof fetch)
  const preparedPrompt = klingIdentityReferencePrompt(prompt, preparedParams)
  const diagnostics = isRecord(preparedParams.referenceDiagnostics) ? preparedParams.referenceDiagnostics : undefined
  const annotate = (value: unknown) => diagnostics && isRecord(value)
    ? { ...value, app_reference_diagnostics: diagnostics }
    : value
  const acceptSucceededImage = (succeededStatus: number, succeededBody: unknown) => preparedParams.referenceMode === 'three-view-front'
    ? verifyKlingImageLayout(succeededStatus, succeededBody, fetchImpl, annotate)
    : Promise.resolve({ status: succeededStatus, body: annotate(succeededBody) })
  const createResponse = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildKlingImageRequest(model, preparedPrompt, preparedParams)),
  })
  let body = await parseResponseBody(createResponse)
  let status = providerResultStatus(createResponse, body)
  if (status >= 400) return { status, body: annotate(body) }

  let task = klingTask(body)
  if (!task.id || task.status === 'succeed') return acceptSucceededImage(status, body)
  if (task.status === 'failed') return { status: 502, body: annotate(body) }

  const pollIntervalMs = Math.max(100, numericValue(settings.pollIntervalMs, 3000))
  const timeoutMs = Math.max(pollIntervalMs, numericValue(settings.taskTimeoutMs, 180000))
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs)
    const queryResponse = await fetchImpl(`${endpoint}/${encodeURIComponent(task.id)}`, { method: 'GET', headers })
    body = await parseResponseBody(queryResponse)
    status = providerResultStatus(queryResponse, body)
    if (status >= 400) return { status, body: annotate(body) }
    task = klingTask(body)
    if (task.status === 'succeed') return acceptSucceededImage(status, body)
    if (task.status === 'failed') return { status: 502, body: annotate(body) }
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
