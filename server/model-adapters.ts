import { compileKlingVoices } from '../src/character-voice.ts'
import { speechPerformanceContract } from '../src/speech-performance.ts'
import { isHistoricalSandTable } from '../src/sand-table-contract.ts'
import { assertVoiceObligationCoverage } from '../src/voice-obligation.ts'
import { pronunciationInstruction } from '../src/pronunciation-hints.ts'
import { compactManagedVideoProviderPrompt, renderVideoProviderPrompt, subtitleFreeVideoPrompt, videoSubtitleContract, VIDEO_NO_SUBTITLES_NEGATIVE } from '../src/video-provider-prompt.ts'
import { isTransientTransportError } from './transport-errors.ts'
import { MAX_NODE_ATTEMPTS } from '../src/retry-budget.ts'
import { classifyModelFailure } from '../src/model-failure.ts'
import { Readable } from 'node:stream'
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import path from 'node:path'
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
export type KlingAdapterDependencies = {
  onTaskSubmitted?: (result: ModelAdapterResult, endpoint: string) => Promise<void>
  fetch?: FetchLike
  sleep?: (milliseconds: number) => Promise<void>
  generatedAssetsDirectory?: string
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

const MODEL_HTTP_REQUEST_TIMEOUT_MS = 180_000

function requestBodyBuffer(body: unknown) {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  throw new Error('可信 DNS 模型请求仅支持字符串或二进制请求体')
}

export function fetchWithModelNetwork(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const endpoint = input instanceof Request ? new URL(input.url) : new URL(input)
  const payload = requestBodyBuffer(init?.body)
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  if (payload && !headers.has('content-length')) headers.set('content-length', String(payload.byteLength))
  const proxyUrl = configuredModelProxy(endpoint)

  return new Promise((resolve, reject) => {
    let upstreamResponse: import('node:http').IncomingMessage | undefined
    let responseResolved = false
    const abortError = () => init?.signal?.reason instanceof Error
      ? init.signal.reason
      : new DOMException('The operation was aborted', 'AbortError')
    const abortTransport = (error: Error) => {
      upstreamResponse?.destroy(error)
      request.destroy(error)
      if (!responseResolved) reject(error)
    }
    const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: Object.fromEntries(headers.entries()),
      ...(proxyUrl
        ? { agent: new HttpsProxyAgent(proxyUrl) }
        : usesTrustedModelDns(endpoint) ? { lookup: trustedModelDnsLookup } : {}),
      signal: init?.signal ?? undefined,
    }, (response) => {
      upstreamResponse = response
      responseResolved = true
      const responseHeaders = new Headers()
      Object.entries(response.headers).forEach(([key, value]) => {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item))
        else if (value !== undefined) responseHeaders.set(key, String(value))
      })
      // Resolve on headers, propagate stream errors/aborts, and keep socket timeout
      // active while the body is read. Buffering until end hid broken connections.
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }))
      response.once('close', () => init?.signal?.removeEventListener('abort', onAbort))
    })
    const onAbort = () => abortTransport(abortError())
    if (init?.signal?.aborted) return onAbort()
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    request.setTimeout(MODEL_HTTP_REQUEST_TIMEOUT_MS, () => {
      abortTransport(new Error(`模型网关请求超过 ${MODEL_HTTP_REQUEST_TIMEOUT_MS / 1000} 秒，已中止以允许安全重试`))
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

export async function parseResponseBody(response: Response) {
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

const localGeneratedImage = /^\/generated\/([^/?#]+)(?:[?#].*)?$/
const localImageMimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/**
 * Runtime tail frames are persisted under public/generated and represented in
 * workflow state by browser-relative URLs. External providers cannot fetch such
 * URLs, and Kling interprets them as raw base64. Convert them at the adapter
 * boundary so every caller sends either an HTTP(S) URL or valid base64 bytes.
 */
export async function resolveKlingLocalImage(
  value: string,
  generatedAssetsDirectory = path.resolve(process.cwd(), 'public/generated'),
) {
  const match = value.match(localGeneratedImage)
  if (!match) return value
  const filename = decodeURIComponent(match[1])
  if (filename !== path.basename(filename)) throw new Error('运行时图片路径无效')
  const mimeType = localImageMimeTypes[path.extname(filename).toLowerCase()]
  if (!mimeType) throw new Error(`运行时图片格式不受支持：${filename}`)
  let bytes: Buffer
  try {
    bytes = await readFile(path.join(generatedAssetsDirectory, filename))
  } catch {
    throw new Error(`运行时图片不存在或不可读：/generated/${filename}`)
  }
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw new Error(`运行时图片大小必须在 1B 到 20MB 之间：/generated/${filename}`)
  }
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

export async function prepareKlingImageInputs(params: Record<string, unknown>, generatedAssetsDirectory?: string) {
  const convert = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') return resolveKlingLocalImage(value, generatedAssetsDirectory)
    if (Array.isArray(value)) return Promise.all(value.map(convert))
    if (isRecord(value)) {
      const entries = await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await convert(child)] as const))
      return Object.fromEntries(entries)
    }
    return value
  }
  const prepared = { ...params }
  for (const key of [
    'input_images', 'inputImages', 'referenceImages', 'referenceImage', 'images', 'image',
    'endImage', 'imageTail', 'image_tail', 'staticMask', 'static_mask',
  ]) {
    if (key in prepared) prepared[key] = await convert(prepared[key])
  }
  return prepared
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
    if (params.imageEdit === true && /^kling-v3(?:-omni)?$/.test(String(settings.model))) {
      request.model_name = 'kling-v3-omni'
      request.image_list = [{ image: stripImageDataUrlPrefix(referenceImage) }]
      request.result_type = 'single'
    } else request.image = stripImageDataUrlPrefix(referenceImage)
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
  const identityInstruction = diagnostics.composition === 'text-only-multi-character' && names.length >= 2
    ? [`【多人物单场景】本次不使用会诱导拼版的单人人物附件。必须严格依据文字描述生成${names.join('、')}，所有人物同时处于同一空间、同一机位、同一曝光的一幅完整照片中。`]
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
  } catch (error) {
    return {
      status: 502,
      body: {
        error: `尾帧布局质量检查无法读取生成图片：${error instanceof Error ? error.message : String(error)}`,
        rejected_layout: 'unverified',
        provider_response: annotated,
      },
    }
  }
}

export function klingThreeViewVideoPrompt(prompt: string, params: Record<string, unknown>) {
  const completeIdentitySheets = isRecord(params.referenceDiagnostics) && params.referenceDiagnostics.composition === 'whole-identity-sheets'
  const enteringBindings = Array.isArray(params.referenceBindings)
    ? params.referenceBindings.filter((binding) => isRecord(binding) && binding.role === 'entering')
    : []
  const entranceInstruction = enteringBindings.length
    ? `首帧人物锁定：这些附件中的入场人物在首帧不得出现。${enteringBindings.map((binding) => {
        const entrance = isRecord(binding.entrance) ? binding.entrance : {}
        const name = optionalString(binding.characterName) ?? '入场人物'
        return `${name}只能在${entrance.startSecond ?? '?'}-${entrance.endSecond ?? '?'}秒从${optionalString(entrance.path) ?? '已声明路径'}连续走入；必须先出现身体轮廓再完整入画，禁止闪现、变形生成、切镜补人或提前出现`
      }).join('；')}。`
    : ''
  const referenceIsolationInstruction = imageValue(params.referenceImage ?? params.image).length
    ? '【实际首帧优先】全画幅首帧锁定实际环境、机位、人物位置与开场姿态；多角度人物附件仅补充身份与服装细节，不重排人物、不改变首帧环境、不增加已在首帧中的人物副本。'
    : Array.isArray(params.referenceImages) && params.referenceImages.length
    ? '【参考图背景隔离】人物附件中的纯色底、摄影棚底、画布边界和三视图排版都是资产制作痕迹，不是故事场景；必须完全忽略并以文字中的“场景与开场实景”重建完整环境，不得生成幕布、棚拍、舞台布景、纯色背景或人物抠图感。'
    : ''
  const identityPoseInstruction = Array.isArray(params.referenceImages) && params.referenceImages.length
    ? params.pacingVersion === 'duration-v2'
      ? '【身份参考与动作分离】附件中性站姿、手臂姿势和朝向不是动作要求。按原节拍执行，持续动作保持至该段结束并完成结尾；禁止说话时回到附件站姿。若有实际首帧，开场以其为准，再连续执行后续动作。'
      : '【身份参考与动作分离】人物附件中的中性站姿、手臂姿势和朝向不是本镜动作要求。姿态按本镜时间轴的对应时段执行，明确要求保持的动作须持续到该时段结束，并实现文字指定的结尾状态；不要在说话过程中自动回到附件站姿。若提供了全画幅实际首帧，开场仍以该首帧为准，再连续执行后续动作。'
    : ''
  if (params.referenceMode !== 'three-view-all' || !Array.isArray(params.referenceImages) || !params.referenceImages.length) {
    const names = referenceBindingNames(params)
    const castContract = completeIdentitySheets ? [['characters', '本镜可见或行动人物'], ['initialCharacters', '开场人物'], ['presentCharacters', '场内人物（可在画外）']]
      .flatMap(([key, label]) => Array.isArray(params[key]) ? [`${label}：${JSON.stringify(params[key])}`] : []).join('；') : ''
    const sheetInstruction = completeIdentitySheets && Array.isArray(params.referenceImages) && params.referenceImages.length
      ? `人物身份参考：${params.referenceImages.map((_, index) => `${names[index] ?? `人物${index + 1}`}：@参考附件${index + 1}（完整原参考图）`).join('；')}。每张附件内出现的是该具名人物的多个视角参考，不代表多个独立真人；同一具名角色在成片中只能对应一个人，不得复制参考视图为多个同人。${castContract ? `${castContract}；成片人物数量与开场、入场和画外关系必须遵循这些分镜名单。` : ''}实际有哪些参考角度以图片为准，不假定固定正面、侧面、背面顺序。只继承同一人物的脸部、体型与服装，不复制参考图排版或增加人物。`
      : ''
    return [sheetInstruction, referenceIsolationInstruction, identityPoseInstruction, entranceInstruction, prompt].filter(Boolean).join('\n')
  }
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
    '动作和运镜过程中必须根据朝向持续匹配对应角度的人脸、发式、体型、服装、纹样与配色；衣领、衣襟和开合结构保持附件原貌，整片素布始终保持连续布面与自然褶皱。参考附件只定义人物身份，不代表分镜或画面分栏。',
    referenceIsolationInstruction,
    identityPoseInstruction,
    entranceInstruction,
    prompt,
  ].filter(Boolean).join('\n')
}

/** Kept for compatibility. Declared entrants retain their identity references. */
export function omitGenericCrowdVideoReferences(params: Record<string, unknown>) {
  return params
}

/**
 * Applies a final provider-side guard after workflow interpolation. This is
 * deliberately repeated here (rather than relying only on storyboard
 * validation) because a user may retry a video node whose saved storyboard was
 * produced by an older workflow schema.
 */
export function hardenKlingDialoguePrompt(prompt: string, dynamicPacing: boolean | string = false) {
  if (dynamicPacing === 'duration-v2') {
    // Replace the owned guard line without deleting later authored dialogue.
    prompt = prompt.replace(/【同期声音与可见口型】[^\r\n]*/g, '').trim()
    // Only the complete compiler-owned block already carries these voice and
    // ending guarantees. A marker alone must not weaken the provider guard.
    const compiled = prompt.match(/^【声部与收束】按共享策略 \S+ 和已编译节拍分别完成下列声部：(\[[^\n]*\])。对白按角色绑定嘴唇，画外旁白不绑定画内口型；歌谣、吟诵和歌唱遵循各自表演节奏，不强制改成每秒4\.5字的对话。已声明的无词群体声部必须实际可听，不能因不在audioText中而静音；未声明声部不得新增可辨语言。完整保留每句台词及原动作先后关系，动作与必需回应完成后保留 \d+(?:\.\d+)? 秒可读收尾，允许自然呼吸微动，不新增剧情动作或以静帧补齐缺失动作。导演参考窗口用于定位表演，硬边界和前置依赖必须遵守。$/m)
    if (compiled) {
      try {
        const voices: unknown = JSON.parse(compiled[1])
        if (Array.isArray(voices) && voices.every(voice => isRecord(voice) && typeof voice.beatId === 'string'
          && Array.isArray(voice.actorIds) && ['speech', 'vocalization'].includes(String(voice.kind)) && typeof voice.textOrVocalization === 'string')) {
          return `${prompt}\n【同期声音与可见口型】画内声部匹配自然口型，旁白不绑定画内口型；无词声部须可听。完整执行原节拍与收尾余量。`
        }
      } catch { /* Malformed compiler metadata retains the full guard below. */ }
    }
    return `${prompt}\n【同期声音与可见口型】按已声明的对白、吟诵、歌唱及无词声部各自表演，不套统一语速。完整保留台词、声部、动作先后及群体回应；无词声部也须真实可听。仅当前声明发声者自然开口，其他人物可按已声明声部回应。必需动作和回应完成后保留可读余量，允许自然呼吸微动，不要求静止、闭口摆拍或转向镜头。`
  }
  if (dynamicPacing) {
    prompt = prompt.replace(/【同期声音与可见口型】[^\r\n]*/g, '').trim()
    return `${prompt}\n【同期声音与可见口型】自然语速约每秒4.5汉字，不逐字拖慢或延长停顿。按原时间轴完整说完，再完成对手回应即结束；仅留0.3秒剪辑余量，允许自然呼吸和微动，不要求静止闭口或面向镜头站定。说话人的脸部和嘴唇清晰可见，道具不遮嘴，不增加无声语言口型。`
  }
  if (!/(?:【同期对白硬约束】|【必须生成的同期人声原文】)/.test(prompt)) return prompt
  const guard = '【同期声音与可见口型】严格按原时间段发声，说话人的脸部和双唇须可见，道具不得遮嘴；其他人物闭口。保留原动作、人物相互视线、道具归属、机位和结尾情绪，不得统一改为面向镜头站定。最后1.5秒无对白，保持分镜规定的最终构图。'
  return prompt.includes('【同期声音与可见口型】') ? prompt : `${prompt}\n${guard}`
}

export function buildKlingVideoRequest(model: ExternalModelConfig, prompt: string, params: Record<string, unknown>) {
  assertVoiceObligationCoverage(params)
  const settings = model.settings
  const image = imageValue(params.referenceImage ?? params.image)[0]
  const referenceImages = [...new Set(imageValue(params.referenceImages))].slice(0, 7)
  const endImage = optionalString(params.endImage ?? params.imageTail ?? params.image_tail)
  const configuredModelName = String(params.model_name ?? params.modelName ?? settings.model ?? 'kling-v3')
  // Model records are shared with Kling image generation, where `resolution`
  // may legitimately be `1k`. Video resolution is an execution parameter.
  const resolution = optionalString(params.resolution)?.toLowerCase()
  if (resolution && !['720p', '1080p', '4k'].includes(resolution)) throw new Error(`KLING_RESOLUTION_INVALID: 不支持 ${resolution}`)
  const useOmni = referenceImages.length > 0 || configuredModelName.includes('omni') || resolution === '4k'
  const modelName = useOmni && !configuredModelName.includes('omni') ? 'kling-v3-omni' : configuredModelName
  const requestedDuration = optionalNumber(params.duration ?? settings.duration) ?? 5
  const duration = modelName.startsWith('kling-v3')
    ? Math.min(15, Math.max(3, requestedDuration))
    : requestedDuration
  const performanceContract = speechPerformanceContract(params)
  const authoredBeats = isRecord(params.pacing) && Array.isArray(params.pacing.beats) ? params.pacing.beats : undefined
  const pictureOnly = params.pacingVersion === 'independent-narration-v1' && params.audioType === '环境声' && params.audioText === ''
  const noNativeVoice = pictureOnly || authoredBeats !== undefined && !String(params.audioText ?? '').trim()
    && !authoredBeats.some(beat => isRecord(beat) && ['speech', 'vocalization'].includes(String(beat.kind)))
  const subtitleContract = videoSubtitleContract(params)
  const basePrompt = subtitleFreeVideoPrompt(renderVideoProviderPrompt(optionalString(prompt) ?? '让画面自然运动。', params), params)
  // A generic dialogue guard used to tell ambient-only clips to preserve
  // chorus responses and avoid closed-mouth staging. Do not send competing
  // speech instructions for a timeline with no audible performers. Remove
  // only the owned guard line, never the authored content following it.
  const guardedPrompt = noNativeVoice
    ? basePrompt.replace(/【同期声音与可见口型】[^\n]*/g, '').trim()
    : hardenKlingDialoguePrompt(basePrompt, params.pacingVersion === 'duration-v2' ? 'duration-v2' : params.pacingVersion === 'dynamic-v1')
  const readingInstruction = pronunciationInstruction(params.pronunciationHints, params.audioText)
  const hardenedPrompt = [guardedPrompt, performanceContract, readingInstruction].filter(Boolean).join('\n')
  const visualPrompt = referenceImages.reduce(
    (text, _, index) => text.replaceAll(`@参考附件${index + 1}`, `<<<image_${index + 1}>>>`),
    hardenedPrompt,
  )
  const voiceCompilation = compileKlingVoices(visualPrompt, { ...params, duration, mode: params.mode ?? settings.mode ?? 'std', sound: params.sound ?? settings.sound }, modelName, useOmni)
  const referencedPrompt = Array.from(voiceCompilation.prompt).length > KLING_PROMPT_MAX_LENGTH
    ? compactManagedVideoProviderPrompt(voiceCompilation.prompt, params) : voiceCompilation.prompt
  if ((subtitleContract || readingInstruction || performanceContract || isHistoricalSandTable(params) || referencedPrompt.includes('【场景与开场实景】') || Array.isArray(params.characterVoices) && params.characterVoices.length > 0 || Array.isArray(params.nativeGroupVoices) && params.nativeGroupVoices.length > 0) && Array.from(referencedPrompt).length > KLING_PROMPT_MAX_LENGTH) {
    throw new Error('STORYBOARD_PROMPT_OVERLOAD: 完整视频提示超过2500字符；已阻止截断剧情后付费生成，请精简静态布景和重复约束')
  }
  const request: Record<string, unknown> = {
    ...voiceCompilation.fields,
    model_name: modelName,
    prompt: limitKlingPrompt(referencedPrompt),
    duration: String(duration),
    mode: String(params.mode ?? settings.mode ?? 'std'),
  }
  // std already denotes the low-cost 720p path. Only transmit the new native
  // 4K field so older debug endpoints keep their established request contract.
  if (resolution === '4k') request.resolution = '4k'
  const sound = optionalString(params.sound ?? settings.sound)
  if (sound) request.sound = sound
  const negativePrompt = optionalString(params.negative_prompt ?? params.negativePrompt ?? settings.negative_prompt ?? settings.negativePrompt)
  const dialogueNegative = noNativeVoice ? '额外对白，群体喊话，吟诵，歌唱，无声语言口型'
    : hardenedPrompt.includes('【同期声音与可见口型】')
    ? '无头，断头，头部缺失，面部遮挡，嘴部遮挡，无声张嘴，口型不同步，人物变形'
    : ''
  const subtitleNegative = subtitleContract ? VIDEO_NO_SUBTITLES_NEGATIVE : ''
  if (negativePrompt || dialogueNegative || subtitleNegative) request.negative_prompt = [negativePrompt, dialogueNegative, subtitleNegative].filter(Boolean).join('，')
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
  const rejection = klingContentRejection(502, body, taskId)
  if (rejection) return rejection
  return {
    status: 502,
    body: {
      error: message,
      ...(taskId ? { task_id: taskId } : {}),
      provider_response: body,
    },
  }
}

function klingContentRejection(status: number, body: unknown, taskId = klingTask(body).id): ModelAdapterResult | undefined {
  if (classifyModelFailure(status, body) !== 'content_rejected') return undefined
  const message = klingTask(body).message
  return {
    status: 422,
    body: {
      ...(isRecord(body) ? body : {}),
      error: {
        type: 'MODEL_CONTENT_REJECTED',
        message: `Kling 内容安全审核未通过${message ? `：${message}` : ''}；请检查供应商原因并调整内容后恢复。`,
        retryable: false,
        provider: 'Kling',
      },
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
  const resumeTaskId = optionalString(params.resumeTaskId)
  let endpoint: string
  let body: unknown
  let status: number
  if (resumeTaskId) {
    // Resume only a known endpoint on this configured provider, never POST again.
    endpoint = params.resumeQueryMode === 'omni'
      ? resolveKlingOmniVideoEndpoint(settings.endpoint)
      : resolveKlingVideoEndpoint(settings.endpoint, params.resumeQueryMode !== 'text2video')
    await dependencies.onTaskSubmitted?.({ status: 202, body: { code: 0, data: { task_id: resumeTaskId, task_status: 'processing' } } }, endpoint)
    const queried = await queryKlingTask(`${endpoint}/${encodeURIComponent(resumeTaskId)}`, headers, fetchImpl, sleep)
    body = queried.body
    status = queried.status
  } else {
    const localImageParams = omitGenericCrowdVideoReferences(await prepareKlingImageInputs(params, dependencies.generatedAssetsDirectory))
    const preparedParams = await prepareThreeViewVideoReferences(localImageParams, fetchImpl as typeof fetch)
    const preparedPrompt = klingThreeViewVideoPrompt(prompt, preparedParams)
    const requestBody = buildKlingVideoRequest(model, preparedPrompt, preparedParams)
    endpoint = Array.isArray(requestBody.image_list) || String(requestBody.model_name).includes('omni')
      ? resolveKlingOmniVideoEndpoint(settings.endpoint)
      : resolveKlingVideoEndpoint(settings.endpoint, Boolean(requestBody.image))
    const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody) })
    body = await parseResponseBody(response)
    status = providerResultStatus(response, body)
  }
  if (status >= 400) return klingContentRejection(status, body, resumeTaskId) ?? { status, body }
  if (klingTask(body).id) await dependencies.onTaskSubmitted?.({ status, body }, endpoint)

  let task = klingTask(body)
  if (task.status === 'succeed') {
    return klingVideoUrl(body)
      ? { status, body }
      : klingVideoFailure(`Kling 视频任务已完成，但结果中没有视频 URL（task_id: ${task.id || '未知'}）`, body, task.id)
  }
  if (task.status === 'failed') return klingVideoFailure(`Kling 视频生成失败：${task.message || '供应商未提供原因'}`, body, task.id)
  if (!task.id) return klingVideoFailure('Kling 视频接口未返回 task_id 或视频结果', body)

  const pollIntervalMs = Math.max(100, numericValue(settings.pollIntervalMs, 3000))
  // Provider queues can exceed 15 minutes during peak periods. Keep polling the
  // accepted task instead of abandoning it and creating a duplicate charge.
  const timeoutMs = Math.max(pollIntervalMs, numericValue(settings.taskTimeoutMs, 1_800_000))
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs)
    const queried = await queryKlingTask(`${endpoint}/${encodeURIComponent(task.id)}`, headers, fetchImpl, sleep)
    body = queried.body
    status = queried.status
    if (status >= 400) {
      const rejection = klingContentRejection(status, body, task.id)
      if (rejection) return rejection
      throw new Error(`Kling 任务查询 HTTP ${status}（task_id: ${task.id}）；任务已接受，可恢复查询` )
    }
    task = { ...klingTask(body), id: klingTask(body).id || task.id }
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

/** GET is safe to retry; creating the paid task is deliberately outside this loop. */
async function queryKlingTask(url: string, headers: Record<string, string>, fetchImpl: FetchLike, sleep: (ms: number) => Promise<void>): Promise<ModelAdapterResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(180_000) })
      const body = await parseResponseBody(response)
      const status = providerResultStatus(response, body)
      if (classifyModelFailure(status, body) === 'content_rejected') return { status, body }
      if (attempt + 1 < MAX_NODE_ATTEMPTS && [408, 429, 500, 502, 503, 504, 520, 522, 523, 524, 529].includes(status)) {
        await sleep(Math.min(30_000, 1500 * 2 ** attempt))
        continue
      }
      return { status, body }
    } catch (error) {
      if (attempt + 1 >= MAX_NODE_ATTEMPTS || !isTransientTransportError(error)) throw error
      await sleep(Math.min(30_000, 1500 * 2 ** attempt))
    }
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
  const localImageParams = await prepareKlingImageInputs(params, dependencies.generatedAssetsDirectory)
  const preparedParams = await prepareThreeViewFrontReference(localImageParams, fetchImpl as typeof fetch)
  const preparedPrompt = klingIdentityReferencePrompt(prompt, preparedParams)
  const requestBody = buildKlingImageRequest(model, preparedPrompt, preparedParams)
  const configuredEndpoint = settings.endpoint.replace(/\/$/, '')
  const endpoint = Array.isArray(requestBody.image_list) ? configuredEndpoint.replace(/\/generations$/, '/omni-image') : configuredEndpoint
  const diagnostics = isRecord(preparedParams.referenceDiagnostics) ? preparedParams.referenceDiagnostics : undefined
  const annotate = (value: unknown) => diagnostics && isRecord(value)
    ? { ...value, app_reference_diagnostics: diagnostics }
    : value
  const acceptSucceededImage = (succeededStatus: number, succeededBody: unknown) => preparedParams.referenceMode === 'three-view-front'
    ? verifyKlingImageLayout(succeededStatus, succeededBody, fetchImpl, annotate)
    : Promise.resolve({ status: succeededStatus, body: annotate(succeededBody) })
  const resumeTaskId = optionalString(params.resumeTaskId)
  let body: unknown
  let status: number
  if (resumeTaskId) {
    await dependencies.onTaskSubmitted?.({ status: 202, body: { code: 0, data: { task_id: resumeTaskId, task_status: 'processing' } } }, endpoint)
    const queried = await queryKlingTask(`${endpoint}/${encodeURIComponent(resumeTaskId)}`, headers, fetchImpl, sleep)
    body = queried.body
    status = queried.status
  } else {
    const createResponse = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody) })
    body = await parseResponseBody(createResponse)
    status = providerResultStatus(createResponse, body)
  }
  if (status >= 400) {
    const rejection = klingContentRejection(status, body, resumeTaskId)
    return rejection ? { ...rejection, body: annotate(rejection.body) } : { status, body: annotate(body) }
  }
  if (klingTask(body).id) await dependencies.onTaskSubmitted?.({ status, body }, endpoint)

  let task = klingTask(body)
  if (task.status === 'failed') {
    const rejection = klingContentRejection(502, body, task.id)
    return rejection ? { ...rejection, body: annotate(rejection.body) } : { status: 502, body: annotate(body) }
  }
  if (!task.id || task.status === 'succeed') return acceptSucceededImage(status, body)

  const pollIntervalMs = Math.max(100, numericValue(settings.pollIntervalMs, 3000))
  const timeoutMs = Math.max(pollIntervalMs, numericValue(settings.taskTimeoutMs, 180000))
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs)
    const queried = await queryKlingTask(`${endpoint}/${encodeURIComponent(task.id)}`, headers, fetchImpl, sleep)
    body = queried.body
    status = queried.status
    if (status >= 400) {
      const rejection = klingContentRejection(status, body, task.id)
      if (rejection) return { ...rejection, body: annotate(rejection.body) }
      throw new Error(`Kling 图片任务查询 HTTP ${status}（task_id: ${task.id}）；任务已接受，可恢复查询`)
    }
    task = { ...klingTask(body), id: klingTask(body).id || task.id }
    if (task.status === 'succeed') return acceptSucceededImage(status, body)
    if (task.status === 'failed') {
      const rejection = klingContentRejection(502, body, task.id)
      return rejection ? { ...rejection, body: annotate(rejection.body) } : { status: 502, body: annotate(body) }
    }
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
