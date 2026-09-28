import { createHash } from 'node:crypto'
import { resolveCodexExecutablePath } from './codex-text.ts'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
  return value
}

/** Preserve equality without retaining credentials or huge base64 inputs in logs. */
export function modelRequestFingerprint(request: { model: { id: string; provider?: string; capability?: string; settings: Record<string, string> }; prompt: string; params: Record<string, unknown>; operation?: string }) {
  const settings = request.model.settings
  const configuredExecutable = request.params.executablePath !== undefined ? request.params.executablePath : settings.executablePath
  // Match the Codex adapter's per-call/config/environment precedence without
  // mutating the submitted configuration or binding another provider to it.
  const executablePath = request.model.provider === 'Codex'
    ? resolveCodexExecutablePath(typeof configuredExecutable === 'string' && configuredExecutable.trim() ? configuredExecutable.trim() : process.env.VIDEO_AIGC_CODEX_CLI ?? 'codex')
    : settings.executablePath
  // Keep credentials out of the identity. A saved model ID can be edited to
  // point at another provider or executable, so it is not sufficient alone.
  // Per-call overrides are already included in params without rewriting them.
  return createHash('sha256').update(JSON.stringify(canonical({ modelId: request.model.id,
    provider: request.model.provider, capability: request.model.capability,
    endpoint: settings.endpoint, model: settings.model, transport: settings.transport, apiProtocol: settings.apiProtocol, executablePath,
    temperature: settings.temperature, maxTokens: settings.maxTokens, stream: settings.stream,
    reasoning: settings.reasoning, reasoningEffort: settings.reasoningEffort, reasoning_effort: settings.reasoning_effort,
    model_reasoning_effort: settings.model_reasoning_effort,
    timeoutMs: settings.timeoutMs, taskTimeoutMs: settings.taskTimeoutMs, pollIntervalMs: settings.pollIntervalMs,
    outputSchema: settings.outputSchema, maxStdoutBytes: settings.maxStdoutBytes, maxStderrBytes: settings.maxStderrBytes,
    prompt: request.prompt, params: request.params, operation: request.operation }))).digest('hex')
}

export function createInflightModelRequests() {
  const pending = new Map<string, Promise<unknown>>()
  return async function share<T>(key: string | undefined, execute: () => Promise<T>): Promise<T> {
    if (!key) return execute()
    const existing = pending.get(key)
    if (existing) return existing as Promise<T>
    const request = execute()
    pending.set(key, request)
    try { return await request } finally { pending.delete(key) }
  }
}
