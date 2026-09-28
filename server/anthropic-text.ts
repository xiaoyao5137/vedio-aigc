import { isTransientTransportError } from './transport-errors.ts'
import { MAX_NODE_ATTEMPTS } from '../src/retry-budget.ts'
import { classifyModelFailure } from '../src/model-failure.ts'
import { fetchModelEndpoint, parseResponseBody, type ExternalModelConfig, type ModelAdapterResult } from './model-adapters.ts'

type Value = Record<string, unknown>
type Attempt = { attempt: number; status: number; durationMs: number; error?: string; failureKind?: string }
export const TEXT_TRANSPORT_DEADLINE_MS = 10 * 60_000
export const TEXT_CHANNEL_PROBE_LIMIT = 3

class AnthropicStreamError extends Error {
  readonly detail: unknown
  constructor(detail: unknown) { super(`ANTHROPIC_STREAM_ERROR: ${JSON.stringify(detail)}`); this.detail = detail }
}

function upstreamErrorStatus(error: unknown): number {
  const type = error && typeof error === 'object' ? String((error as Value).type ?? '') : ''
  return type === 'authentication_error' ? 401 : type === 'permission_error' ? 403
    : type === 'invalid_request_error' ? 400 : type === 'rate_limit_error' ? 429 : type === 'overloaded_error' ? 529 : 502
}

function textConfigNumber(key: 'maxTokens' | 'temperature', value: unknown): number {
  const number = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN
  const valid = key === 'maxTokens'
    ? Number.isSafeInteger(number) && number > 0
    : Number.isFinite(number) && number >= 0 && number <= 1
  if (!valid) throw new Error(`ANTHROPIC_CONFIG_INVALID: ${key} ${key === 'maxTokens' ? '必须是正整数' : '必须是 0 到 1 之间的有限数值'}`)
  return number
}

function textConfigStream(value: unknown): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new Error('ANTHROPIC_CONFIG_INVALID: stream 必须是 true 或 false')
}

/** Node parameters override model settings without mutating either input. */
export function resolveAnthropicTextConfig<M extends ExternalModelConfig>(model: M, params: Record<string, unknown> = {}): M {
  const settings = { ...model.settings }
  for (const key of ['maxTokens', 'temperature'] as const) {
    if (params[key] !== undefined) settings[key] = String(textConfigNumber(key, params[key]))
  }
  if (params.stream !== undefined) settings.stream = String(textConfigStream(params.stream))
  // Keep the existing defaults (including an empty maxTokens setting) while
  // rejecting invalid configuration before transport can submit a request.
  textConfigNumber('maxTokens', settings.maxTokens || 1200)
  textConfigNumber('temperature', settings.temperature ?? 0.7)
  if (settings.stream !== undefined) textConfigStream(settings.stream)
  return { ...model, settings }
}

/** A partial SSE response is never a completed model answer. */
export async function readAnthropicMessage(response: Response): Promise<ModelAdapterResult> {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const body = await parseResponseBody(response)
    if (response.ok && body && typeof body === 'object') {
      const value = body as Value
      if (value.type === 'error' || value.error) {
        const error = value.error as Value | undefined
        return { status: upstreamErrorStatus(error), body }
      }
      if (value.stop_reason === 'max_tokens') return truncatedOutput()
    }
    const embeddedStatus = typeof body === 'string' ? body.match(/^\s*error code:\s*(5\d\d)\s*$/i) : null
    if (response.ok && embeddedStatus) return { status: Number(embeddedStatus[1]), body }
    if (response.ok && !hasUsableText(body)) return invalidModelResponse(body, false)
    return { status: response.status, body }
  }
  let message: Value | undefined
  const blocks: Value[] = []
  let stopped = false
  let pending = ''
  let bytes = 0
  const decoder = new TextDecoder()
  const consume = (event: string) => {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return
    const value = JSON.parse(data) as Value
    if (value.type === 'error') {
      const error = value.error as Value
      throw new AnthropicStreamError(error)
    }
    if (value.type === 'message_start') message = value.message as Value
    if (value.type === 'content_block_start') blocks[Number(value.index)] = { ...value.content_block as Value }
    if (value.type === 'content_block_delta') {
      const block = blocks[Number(value.index)]
      if (!block) throw new Error('ANTHROPIC_STREAM_INCOMPLETE: content delta without block')
      const delta = value.delta as Value
      if (delta.type === 'text_delta') block.text = String(block.text ?? '') + String(delta.text ?? '')
      if (delta.type === 'thinking_delta') block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '')
      if (delta.type === 'signature_delta') block.signature = String(block.signature ?? '') + String(delta.signature ?? '')
    }
    if (value.type === 'message_delta' && message) {
      Object.assign(message, value.delta)
      message.usage = { ...message.usage as Value, ...value.usage as Value }
    }
    if (value.type === 'message_stop') stopped = true
  }
  if (!response.body) throw new Error('ANTHROPIC_STREAM_INCOMPLETE: empty body')
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > 8 * 1024 * 1024) throw new Error('ANTHROPIC_RESPONSE_TOO_LARGE')
    pending += decoder.decode(chunk, { stream: true })
    // Normalize only complete line endings, preserving CR split across chunks.
    pending = pending.replace(/\r\n/g, '\n')
    let boundary: number
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      consume(pending.slice(0, boundary))
      pending = pending.slice(boundary + 2)
    }
  }
  pending += decoder.decode()
  if (pending.trim()) consume(pending)
  if (!message || !stopped) throw new Error('ANTHROPIC_STREAM_INCOMPLETE: connection ended before message_stop')
  if (message.stop_reason === 'max_tokens') return truncatedOutput()
  const body = { ...message, content: blocks }
  if (!hasUsableText(body)) return invalidModelResponse(body, true)
  return { status: 200, body }
}

function hasUsableText(body: unknown): boolean {
  const content = body && typeof body === 'object' ? (body as Value).content : undefined
  return Array.isArray(content) && content.some(block => block && typeof block === 'object'
    && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
}

function invalidModelResponse(body: unknown, streaming: boolean): ModelAdapterResult {
  const content = body && typeof body === 'object' ? (body as Value).content : undefined
  // Report only structural diagnostics. Gateway error pages and malformed
  // messages can contain huge bodies, echoed credentials or private prompts.
  return { status: 422, body: { error: { type: 'MODEL_RESPONSE_INVALID', message: '文本接口未返回非空文本内容，不能作为完整模型结果',
    diagnostics: { streaming, bodyType: body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body,
      contentBlockCount: Array.isArray(content) ? content.length : 0,
      textBlockCount: Array.isArray(content) ? content.filter(block => block && typeof block === 'object' && block.type === 'text').length : 0 } } } }
}

function truncatedOutput(): ModelAdapterResult {
  return { status: 422, body: { error: { type: 'MODEL_OUTPUT_TRUNCATED', message: '文本达到输出上限，不能把截断内容当作完整结果' } } }
}

/** Retry text transport here, once for every entry point (outline, repair and review).
 * This function is deliberately not used for image/video task submission. */
export async function callAnthropicText(model: ExternalModelConfig, content: unknown, operation?: string, dependencies: {
  fetch?: typeof fetchModelEndpoint; sleep?: (ms: number) => Promise<void>; onAttempt?: (attempt: Attempt) => Promise<void>; now?: () => number
  maxAttemptsBeforeFailover?: number; attemptTimeoutMs?: number
} = {}): Promise<ModelAdapterResult & { transport: { streaming: boolean; attempts: Attempt[] } }> {
  const settings = resolveAnthropicTextConfig(model).settings
  const streaming = settings.stream === undefined ? true : textConfigStream(settings.stream)
  if (!settings.apiKey) throw new Error('缺少 Anthropic API Key')
  const attempts: Attempt[] = []
  const failoverLimit = dependencies.maxAttemptsBeforeFailover ?? MAX_NODE_ATTEMPTS
  if (!Number.isSafeInteger(failoverLimit) || failoverLimit < 1 || failoverLimit > MAX_NODE_ATTEMPTS) {
    throw new Error(`ANTHROPIC_CONFIG_INVALID: primaryTransportAttempts 必须为 1–${MAX_NODE_ATTEMPTS} 的整数`)
  }
  const attemptTimeoutMs = dependencies.attemptTimeoutMs ?? TEXT_TRANSPORT_DEADLINE_MS
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1_000 || attemptTimeoutMs > TEXT_TRANSPORT_DEADLINE_MS) {
    throw new Error(`ANTHROPIC_CONFIG_INVALID: primaryTransportAttemptTimeoutMs 必须为 1000–${TEXT_TRANSPORT_DEADLINE_MS} 的整数`)
  }
  const now = dependencies.now ?? Date.now
  const deadline = now() + TEXT_TRANSPORT_DEADLINE_MS
  let channelFailures = 0
  const stop = (result: ModelAdapterResult, type: string, message: string) => ({
    status: result.status,
    body: { error: { type, message, upstream: result.body, retryable: false } },
    transport: { streaming, attempts },
  })
  for (let attempt = 1; ; attempt += 1) {
    const started = now()
    let result: ModelAdapterResult
    let retryAfter = 0
    const remainingMs = Math.max(1, Math.min(attemptTimeoutMs, Math.ceil(deadline - now())))
    const controller = new AbortController()
    const timeoutError = Object.assign(new Error(`MODEL_TRANSPORT_ATTEMPT_TIMEOUT: 单次文本请求超过 ${remainingMs}ms`), { code: 'ETIMEDOUT' })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      // Do not rely on a transport honoring AbortSignal. Some proxy/Readable
      // combinations can acknowledge abort yet leave response-body iteration
      // pending forever. The outer race is the authoritative attempt boundary;
      // abort is still sent so sockets and provider work are released promptly.
      const exchange = (async () => {
        const response = await (dependencies.fetch ?? fetchModelEndpoint)(settings.endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', Accept: streaming ? 'text/event-stream' : 'application/json' },
          body: JSON.stringify({ model: settings.model, stream: streaming,
            max_tokens: operation?.startsWith('history.') ? Math.max(8192, Number(settings.maxTokens || 0)) : Number(settings.maxTokens || 1200),
            temperature: /(?:review|appearance)/.test(operation ?? '') ? 0 : Number(settings.temperature ?? 0.7), messages: [{ role: 'user', content }] }),
        })
        const header = response.headers.get('retry-after')
        retryAfter = header ? Math.min(60_000, Math.max(0, Number(header) * 1000 || Date.parse(header) - Date.now() || 0)) : 0
        return readAnthropicMessage(response)
      })()
      result = await Promise.race([
        exchange,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort(timeoutError)
            reject(timeoutError)
          }, remainingMs)
        }),
      ])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retryable = isTransientTransportError(error) || /STREAM_INCOMPLETE|overloaded_error|api_error/i.test(message)
      result = { status: error instanceof AnthropicStreamError ? upstreamErrorStatus(error.detail) : retryable ? 502 : 422,
        body: { error: error instanceof AnthropicStreamError ? error.detail : { message } } }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    const kind = classifyModelFailure(result.status, result.body)
    const entry = { attempt, status: result.status, durationMs: now() - started, ...(result.status >= 400 ? { failureKind: kind, error: typeof result.body === 'string' ? result.body : JSON.stringify(result.body) } : {}) }
    attempts.push(entry)
    await dependencies.onAttempt?.(entry)
    if (kind === 'content_rejected') return stop(result, 'MODEL_CONTENT_REJECTED', `供应商内容安全审核拒绝了当前请求（已请求 ${attempt} 次）；请检查上游原因并调整内容后恢复。`)
    if (kind === 'access_denied') return stop(result, 'MODEL_ACCESS_DENIED', `模型访问被拒绝（已请求 ${attempt} 次）；请检查 API 凭据、订阅权限及网关模型映射，修正后从当前节点恢复。`)
    if (kind === 'quota_exhausted') return stop(result, 'MODEL_QUOTA_EXHAUSTED', `模型余额或配额不足（已请求 ${attempt} 次）；恢复额度后从当前节点继续。`)
    if (kind === 'invalid_request') return stop(result, 'MODEL_REQUEST_INVALID', `模型请求或配置不受支持（已请求 ${attempt} 次）；请按上游错误修正配置后恢复。`)
    if (kind === 'channel_unavailable' && ++channelFailures >= TEXT_CHANNEL_PROBE_LIMIT) {
      return stop(result, 'MODEL_CHANNEL_UNAVAILABLE', `当前模型通道不可用，已探测 ${channelFailures} 次（共 ${attempt} 次请求）；等待通道恢复或修正模型配置后从当前节点继续。`)
    }
    const retryable = kind === 'transient' || kind === 'channel_unavailable'
    if (retryable && attempt >= failoverLimit && failoverLimit < MAX_NODE_ATTEMPTS) {
      return stop(result, 'MODEL_TRANSPORT_FAILOVER_READY', `主文本通道连续失败 ${attempt} 次，已停止同通道盲重试并准备切换显式备用模型。`)
    }
    if (!retryable || attempt >= MAX_NODE_ATTEMPTS) {
      return { ...result, ...(retryable ? { body: { error: { type: 'MODEL_TRANSPORT_EXHAUSTED', message: `文本上游 HTTP ${result.status}，已尝试 ${attempt} 次；可恢复当前节点继续。`, upstream: result.body, retryExhausted: true } } } : {}), transport: { streaming, attempts } }
    }
    // Allow a rate-limit window to expire while bounding every individual wait.
    const backoff = result.status === 429 ? 30_000 * attempt : 1500 * 2 ** (attempt - 1)
    const delay = Math.min(60_000, Math.max(retryAfter, backoff))
    if (now() + delay >= deadline) return stop(result, 'MODEL_TRANSPORT_DEADLINE', `模型请求达到 ${TEXT_TRANSPORT_DEADLINE_MS / 60_000} 分钟总时间预算，已尝试 ${attempt} 次；保留当前节点，待服务恢复后继续。`)
    await (dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay)
    if (now() >= deadline) return stop(result, 'MODEL_TRANSPORT_DEADLINE', `模型请求达到 ${TEXT_TRANSPORT_DEADLINE_MS / 60_000} 分钟总时间预算，已尝试 ${attempt} 次；保留当前节点，待服务恢复后继续。`)
  }
}
