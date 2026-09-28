/** Browser→local-server transport for workflow nodes, kept separate from App.tsx so the
 *  recovery behaviour that decides whether a paid run survives a dropped socket is testable. */
import { MAX_NODE_ATTEMPTS } from './retry-budget.ts'
import { modelRetryStopped } from './model-failure.ts'

async function requestJsonOnce<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const body = (data as { body?: unknown }).body
    const nestedError = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
    const errors = [(data as { error?: unknown }).error, nestedError]
    // Structured provider errors carry the stop decision and task provenance.
    // Reducing one to "HTTP 422" lets workflow error patterns retry it blindly.
    if (errors.some(value => value && typeof value === 'object') || modelRetryStopped(JSON.stringify(data))) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`)
    }
    const message = errors.find(value => typeof value === 'string' && value.trim())
    throw new Error(typeof message === 'string' ? message : `HTTP ${response.status}`)
  }
  return data as T
}

/** Plain JSON call for config and record endpoints, which never buy model output. */
export function requestJson<T>(url: string, init?: RequestInit) {
  return requestJsonOnce<T>(url, init)
}

// A dropped connection is not a failed generation. The server shares one in-flight paid request per
// requestKey+fingerprint and replays a persisted successful result, so re-issuing the identical node
// request re-attaches to the work already bought instead of paying twice (record-6afp8q lost a
// finished 284-second outline to a killed socket and the whole run stopped red). A truncated 200 body
// counts as the same event. Requests without a requestKey stay single-shot because nothing there
// would deduplicate a second purchase.
// Public dependency overrides remain extra retries, not total attempts.
export const NODE_REQUEST_RETRIES = MAX_NODE_ATTEMPTS - 1

export function droppedNodeRequest(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (modelRetryStopped(message)) return false
  return /Failed to fetch|Load failed|NetworkError|socket hang up|ECONNRESET|NODE_RESPONSE_INCOMPLETE/i.test(message)
}

type NodeRequestDeps = {
  send?: (url: string, payload: unknown) => Promise<unknown>
  wait?: (ms: number) => Promise<void>
  retries?: number
}

/** POST one node request and wait for the response body to be a complete node result. */
export async function requestNodeJson<T>(url: string, payload: unknown, requestKey: string | undefined, deps: NodeRequestDeps = {}) {
  const send = deps.send ?? ((target: string, body: unknown) => requestJsonOnce<unknown>(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const configuredRetries = Number(deps.retries ?? NODE_REQUEST_RETRIES)
  const retries = Number.isNaN(configuredRetries) ? NODE_REQUEST_RETRIES
    : Math.min(NODE_REQUEST_RETRIES, Math.max(0, Math.floor(configuredRetries)))
  const once = async () => {
    const result = await send(url, payload)
    // A 200 that is missing the status never carries the node output, and the caller would then
    // mark a node finished with nothing to hand downstream.
    if (!result || typeof (result as { status?: unknown }).status !== 'number') {
      throw new Error('NODE_RESPONSE_INCOMPLETE: 本地服务未返回完整节点结果，连接可能被中断')
    }
    return result as T
  }
  if (!requestKey?.trim()) return once()
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once()
    } catch (error) {
      if (!droppedNodeRequest(error) || attempt >= retries) throw error
      await wait(Math.min(60_000, 3000 * (attempt + 1)))
    }
  }
}
