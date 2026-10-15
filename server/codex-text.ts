import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REVIEW_IMAGE_LIMITS, REVIEW_SEQUENCE_LIMITS, type LoadedReviewImage } from './review-images.ts'

type Value = Record<string, unknown>
export type CodexTextConfig = {
  executablePath: string; model?: string; reasoningEffort?: string; timeoutMs: number
  configuredExecutablePath?: string
  outputSchema?: Value; maxStdoutBytes?: number; maxStderrBytes?: number
}

/** Preserve explicit executables. Only the known obsolete app layout can move
 * to the current CLI inside that same bundle, after the old file is absent. */
export function resolveCodexExecutablePath(executablePath: string): string {
  if (!path.isAbsolute(executablePath) || !/\/(?:ChatGPT|Codex)\.app\/Contents\/Resources\/codex$/.test(executablePath)) return executablePath
  try { statSync(executablePath); return executablePath }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return executablePath }
  const resources = path.dirname(executablePath)
  const candidate = path.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
  try {
    if (!statSync(candidate).isFile()) return executablePath
    accessSync(candidate, constants.X_OK)
    const bundleRoot = realpathSync(path.resolve(resources, '..', '..'))
    if (!realpathSync(candidate).startsWith(bundleRoot + path.sep)) return executablePath
    return candidate
  } catch { return executablePath }
}
export type CodexTextDependencies = {
  spawn?: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
  env?: NodeJS.ProcessEnv
  kill?: (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) => void
  killGraceMs?: number
  /** Test seam for the OS proxy setting. Never forwards a parent proxy URL. */
  systemProxyOutput?: string
}
export const CODEX_TEXT_LIMITS = {
  stdoutBytes: 8 * 1024 * 1024, stderrBytes: 512 * 1024, finalBytes: 4 * 1024 * 1024,
  promptBytes: 2 * 1024 * 1024, promptChars: 1_000_000, schemaBytes: 256 * 1024, timeoutMs: 3_600_000,
} as const

// These are invocation overrides, not changes to the user's configuration.
const disabledFeatures = ['shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'apps', 'plugins', 'remote_plugin',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'view_image',
  'multi_agent', 'memories', 'chronicle', 'hooks', 'shell_snapshot', 'skill_search', 'skill_mcp_dependency_install',
  'workspace_dependencies', 'tool_suggest', 'sleep_tool', 'goals']
const record = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function invalid(message: string): never { throw new Error('CODEX_CONFIG_INVALID: ' + message) }

function boundedInteger(key: string, value: unknown, maximum: number): number {
  const number = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) invalid(key + ' 必须是1..' + maximum + '的整数')
  return number
}

function outputSchema(value: unknown): Value {
  let schema: unknown, text: string
  try { text = typeof value === 'string' ? value : JSON.stringify(value); schema = JSON.parse(text) }
  catch { return invalid('outputSchema 必须为可序列化的JSON Schema对象') }
  if (Buffer.byteLength(text) > CODEX_TEXT_LIMITS.schemaBytes || !record(schema) || !Object.keys(schema).length) invalid('outputSchema 必须为有内容且不超过256KiB的JSON Schema对象')
  const visit = (value: unknown, depth: number) => {
    if (typeof value === 'boolean') return
    if (!record(value) || depth > 64) invalid('outputSchema 子模式非法或嵌套过深')
    if (value.type !== undefined && !(typeof value.type === 'string' ? [value.type] : Array.isArray(value.type) ? value.type : [])
      .every(type => ['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'].includes(String(type)))) invalid('outputSchema.type 非法')
    if (value.type !== undefined && typeof value.type !== 'string' && (!Array.isArray(value.type) || !value.type.length)) invalid('outputSchema.type 非法')
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== 'string')
      || new Set(value.required).size !== value.required.length)) invalid('outputSchema.required 必须为不重复的字符串数组')
    if (value.$ref !== undefined && (typeof value.$ref !== 'string' || !value.$ref.startsWith('#'))) invalid('outputSchema.$ref 只允许本地模式引用')
    for (const key of ['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']) if (value[key] !== undefined) {
      if (!record(value[key])) invalid('outputSchema.' + key + ' 必须为对象')
      for (const child of Object.values(value[key] as Value)) visit(child, depth + 1)
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || !(value[key] as unknown[]).length) invalid('outputSchema.' + key + ' 必须为非空模式数组')
      for (const child of value[key] as unknown[]) visit(child, depth + 1)
    }
    for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']) if (value[key] !== undefined) visit(value[key], depth + 1)
  }
  visit(schema, 0)
  return schema as Value
}

/** Resolve only supported provider options; never read or rewrite Codex config. */
export function resolveCodexTextConfig(model: { capability: string; settings: Record<string, string> }, params: Record<string, unknown> = {}): CodexTextConfig {
  if (model.capability !== 'text' || !record(model.settings) || !record(params)) invalid('Codex仅支持text能力和对象参数')
  const chosen = (key: string) => params[key] !== undefined ? params[key] : model.settings[key]
  const optionalText = (key: string) => {
    const value = chosen(key)
    if (value === undefined) return undefined
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) invalid(key + ' 必须为单行字符串')
    return value.trim() || undefined
  }
  const configuredExecutablePath = optionalText('executablePath') ?? process.env.VIDEO_AIGC_CODEX_CLI ?? 'codex'
  if (!configuredExecutablePath.trim() || /[\0\r\n]/.test(configuredExecutablePath)) invalid('executablePath 非法')
  const executablePath = resolveCodexExecutablePath(configuredExecutablePath)
  const selectedModel = optionalText('model'), reasoningEffort = optionalText('reasoningEffort')
  if (reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) invalid('reasoningEffort 非法')
  const schema = chosen('outputSchema')
  return { executablePath, ...(executablePath !== configuredExecutablePath ? { configuredExecutablePath } : {}),
    ...(selectedModel ? { model: selectedModel } : {}), ...(reasoningEffort ? { reasoningEffort } : {}),
    timeoutMs: boundedInteger('timeoutMs', chosen('timeoutMs') ?? 180_000, CODEX_TEXT_LIMITS.timeoutMs),
    ...(schema === undefined ? {} : { outputSchema: outputSchema(schema) }),
    maxStdoutBytes: boundedInteger('maxStdoutBytes', chosen('maxStdoutBytes') ?? CODEX_TEXT_LIMITS.stdoutBytes, CODEX_TEXT_LIMITS.stdoutBytes),
    maxStderrBytes: boundedInteger('maxStderrBytes', chosen('maxStderrBytes') ?? CODEX_TEXT_LIMITS.stderrBytes, CODEX_TEXT_LIMITS.stderrBytes) }
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+/g, '[REDACTED]')
  if (Array.isArray(value)) return value.map(redact)
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|password|secret|credentials?)$/i.test(key) ? '[REDACTED]' : redact(entry)]))
  return value
}

export class CodexTextError extends Error {
  raw: Value
  constructor(code: string, message: string, raw: Value) {
    super(code + ': ' + message)
    this.name = 'CodexTextError'; this.raw = redact(raw) as Value
  }
}

/** Inspect JSONL as it arrives. Unknown event/item kinds fail closed rather than
 * treating a newly introduced tool capability as a text-only response. */
function knownDiagnostic(value: Value): boolean {
  // CLI recovery progress is not a failed turn. Keep this allowlist narrow:
  // observed transport and workspace-routing timeouts may recover via the
  // CLI's own reconnect, but authentication and terminal errors cannot.
  const recoverableTransport = (message: string) => message === 'request timed out'
    || message === 'workspace routing discovery timed out'
    || message === 'stream disconnected before completion: Connection reset by peer (os error 54)'
  if (value.type === 'error') {
    const reconnect = typeof value.message === 'string' ? /^Reconnecting\.\.\. [1-5]\/5 \((.*)\)$/.exec(value.message) : null
    return Object.keys(value).every(key => ['type', 'message'].includes(key)) && Boolean(reconnect && recoverableTransport(reconnect[1]))
  }
  if (value.type !== 'item.completed' || !record(value.item) || value.item.type !== 'error') return false
  if (!Object.keys(value.item).every(key => ['id', 'type', 'message'].includes(key))) return false
  return value.item.message === 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'
    || (typeof value.item.message === 'string' && value.item.message.startsWith('Falling back from WebSockets to HTTPS transport. ')
      && recoverableTransport(value.item.message.slice('Falling back from WebSockets to HTTPS transport. '.length)))
}

function checkEvent(value: unknown): asserts value is Value {
  if (!record(value) || typeof value.type !== 'string') throw Error('CODEX_EVENT_INVALID')
  // Allow only these observed diagnostic forms. Success still requires exit 0,
  // a completed turn and a nonempty final file; the original events stay in raw.
  if (knownDiagnostic(value) && value.error === undefined) return
  if (value.type === 'error' || value.type === 'turn.failed' || value.error !== undefined) throw Error('CODEX_ERROR_EVENT')
  if (['thread.started', 'turn.started', 'turn.completed'].includes(value.type)) return
  if (!['item.started', 'item.updated', 'item.completed'].includes(value.type)) throw Error('CODEX_EVENT_INVALID')
  if (!record(value.item) || typeof value.item.type !== 'string') throw Error('CODEX_EVENT_INVALID')
  if (value.item.type === 'error' || value.item.error !== undefined || value.item.status === 'failed') throw Error('CODEX_ERROR_EVENT')
  if (!['agent_message', 'reasoning'].includes(value.item.type)) throw Error('CODEX_TOOL_EVENT')
}

function loopbackSystemHttpsProxy(output: string): string | undefined {
  if (!/^\s*HTTPSEnable\s*:\s*1\s*$/m.test(output)) return undefined
  const host = output.match(/^\s*HTTPSProxy\s*:\s*(\S+)\s*$/m)?.[1]
  const port = Number(output.match(/^\s*HTTPSPort\s*:\s*(\d+)\s*$/m)?.[1])
  if (!['127.0.0.1', 'localhost', '::1'].includes(host ?? '') || !Number.isSafeInteger(port)
    || port < 1 || port > 65535) return undefined
  return `http://${host === '::1' ? '[::1]' : host}:${port}`
}

function childEnvironment(source: NodeJS.ProcessEnv, systemProxyOutput?: string): NodeJS.ProcessEnv {
  // Keep OS/auth discovery, not API keys, alternate provider URLs, proxies or
  // parent-agent session identifiers. Authentication remains owned by Codex.
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'CODEX_HOME']) if (source[key] !== undefined) env[key] = source[key]
  // Codex CLI needs the same local network route as other model adapters on
  // macOS. Forward only a loopback OS proxy, never parent-provided proxy URLs.
  const proxy = systemProxyOutput === undefined ? undefined : loopbackSystemHttpsProxy(systemProxyOutput)
  if (proxy) env.HTTPS_PROXY = proxy
  return env
}

async function boundedFinalMessage(filename: string): Promise<string> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > CODEX_TEXT_LIMITS.finalBytes) throw Error('CODEX_FINAL_TOO_LARGE')
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length
      if (size > CODEX_TEXT_LIMITS.finalBytes) throw Error('CODEX_FINAL_TOO_LARGE')
      chunks.push(chunk)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally { await handle.close() }
}

/** One bounded CLI invocation. No automatic retries and no claim of API-level
 * tool_choice=none: disabled features plus observed JSONL are separate evidence. */
export async function callCodexText(config: CodexTextConfig, prompt: string, frames: readonly LoadedReviewImage[] = [], dependencies: CodexTextDependencies = {}) {
  const effective = resolveCodexTextConfig({ capability: 'text', settings: {} }, config)
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > CODEX_TEXT_LIMITS.promptBytes
    || prompt.length > CODEX_TEXT_LIMITS.promptChars) invalid('prompt须为非空且不超过2MiB、100万字符的文本')
  if (!Array.isArray(frames) || frames.length > REVIEW_IMAGE_LIMITS.count) invalid('frames超出已加载图片数量上限')
  const nativeSequencePages = frames.length > 0 && frames.every(frame => frame.kind === 'sequence-grid'
    && frame.detailConfig && 'transport' in frame.detailConfig && frame.detailConfig.transport.mode === 'sequence-grid'
    && Array.isArray(frame.cells) && frame.cells.length > 0 && frame.cells.length <= 4)
  const frameByteLimit = nativeSequencePages ? REVIEW_SEQUENCE_LIMITS.transportBytes : REVIEW_IMAGE_LIMITS.totalBytes
  let totalBytes = 0
  // Capture all buffers and provenance synchronously, before the first await.
  const snapshots = frames.map((frame, index) => {
    if (!Buffer.isBuffer(frame.bytes) || !frame.bytes.length || frame.bytes.length > REVIEW_IMAGE_LIMITS.fileBytes) invalid('frames[' + index + ']缺少有效已加载bytes')
    totalBytes += frame.bytes.length
    if (totalBytes > frameByteLimit) invalid('frames超出已加载图片总字节上限')
    const bytes = Buffer.from(frame.bytes)
    return { bytes, catalog: { attachmentIndex: index, fileName: 'image-' + index + (frame.mimeType === 'image/png' ? '.png' : '.jpg'), url: frame.url,
      kind: frame.kind ?? 'original', ...(frame.kind === 'sequence-grid' ? { cells: structuredClone(frame.cells) } : { frameIndex: frame.frameIndex ?? index }),
      ...(frame.label === undefined ? {} : { label: frame.label }),
      ...(frame.sourceRect === undefined ? {} : { sourceRect: { ...frame.sourceRect } }),
      ...(frame.encoding === undefined ? {} : { encoding: structuredClone(frame.encoding) }),
      ...(frame.mimeType === undefined ? {} : { mimeType: frame.mimeType }),
      sha256: digest(bytes), byteLength: bytes.length } }
  })
  const catalog = snapshots.map(item => item.catalog)
  const submittedPrompt = '仅根据本次文本及附件作答，不调用工具、读取其他文件或访问外部信息。\n\n' + prompt
    + (catalog.length ? '\n\n【按实际传入顺序排列的图片附件，编号从0开始】\n' + JSON.stringify(catalog)
      + '\n原像素局部图仅为对应frameIndex的裁剪，不能替代原始全图或充当新的时间点；结合原图判断空间归属。sequence-grid是顺序原帧的无缩放拼图：逐格查看，报告引用cells.evidenceIndex，时刻取cells.time；attachmentIndex是传输附件号，不能当作帧号。nativeFrameIndex追溯视频解码序列，拼图本身不是新时间点。' : '')
  // The CLI rejects inputs above 1,048,576 characters; count UTF-16 units
  // conservatively and leave room for its own request framing.
  if (Buffer.byteLength(submittedPrompt) > CODEX_TEXT_LIMITS.promptBytes
    || submittedPrompt.length > CODEX_TEXT_LIMITS.promptChars) invalid('包含附件目录的prompt超过2MiB或100万字符上限')
  const started = Date.now(), events: Value[] = []
  const configuredExecutablePath = config.configuredExecutablePath ?? config.executablePath
  const raw: Value = { provider: 'Codex', appliedConfig: { executablePath: effective.executablePath,
    configuredExecutablePath, executableResolution: configuredExecutablePath === effective.executablePath ? 'configured' : 'legacy-app-bundle',
    ...(effective.model ? { model: effective.model } : {}), ...(effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}),
    timeoutMs: effective.timeoutMs, maxStdoutBytes: effective.maxStdoutBytes, maxStderrBytes: effective.maxStderrBytes },
    promptSha256: digest(prompt), submittedPromptSha256: digest(submittedPrompt), attachments: catalog,
    isolation: { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, ignoreUserConfig: true, ignoreRules: true,
      webSearch: 'disabled', disabledFeatures: [...disabledFeatures], toolIsolationEvidence: 'feature-overrides-and-observed-events', apiToolChoiceNone: false }, events }
  let directory: string | undefined
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'video-aigc-codex-'))
    await Promise.all(snapshots.map(item => writeFile(path.join(directory!, item.catalog.fileName), item.bytes, { flag: 'wx', mode: 0o600 })))
    const lastMessagePath = path.join(directory, 'last-message.txt')
    const args = ['-a', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'read-only', '-C', directory, '-c', 'model_provider="openai"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
      '--json', '--color', 'never', '--output-last-message', lastMessagePath,
      ...disabledFeatures.flatMap(name => ['--disable', name])]
    if (effective.model) args.push('-m', effective.model)
    if (effective.reasoningEffort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(effective.reasoningEffort))
    if (effective.outputSchema) {
      const schemaText = JSON.stringify(effective.outputSchema), schemaPath = path.join(directory, 'output-schema.json')
      await writeFile(schemaPath, schemaText, { flag: 'wx', mode: 0o600 }); args.push('--output-schema', schemaPath); raw.outputSchemaSha256 = digest(schemaText)
    }
    args.push(...catalog.flatMap(item => ['-i', path.join(directory!, item.fileName)]), '--', '-')
    let child: ChildProcessWithoutNullStreams
    try { child = (dependencies.spawn ?? spawn)(effective.executablePath, args, { cwd: directory, shell: false, detached: process.platform !== 'win32',
      env: childEnvironment(dependencies.env ?? process.env, dependencies.systemProxyOutput
        ?? (dependencies.env === undefined && process.platform === 'darwin'
          ? (() => { try { return execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2_000 }) }
            catch { return '' } })() : '')), stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams }
    catch { throw new CodexTextError('CODEX_SPAWN_FAILED', 'CLI未能启动', raw) }
    await new Promise<void>((resolve, reject) => {
      let failure: string | undefined, settled = false, pending = '', stderr = '', stdoutBytes = 0, stderrBytes = 0
      let escalation: ReturnType<typeof setTimeout> | undefined, exitWait: ReturnType<typeof setTimeout> | undefined
      const decoder = new TextDecoder('utf-8', { fatal: true }), stdoutHash = createHash('sha256')
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (dependencies.kill) dependencies.kill(child, signal)
          else if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch { try { child.kill(signal) } catch { /* Retain the original failure. */ } }
      }
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true; clearTimeout(timeout); clearTimeout(escalation); clearTimeout(exitWait)
        try { if (!failure) { pending += decoder.decode(); consume(true) } }
        catch (error) { failure ??= error instanceof Error && /^CODEX_/.test(error.message) ? error.message : 'CODEX_JSONL_INVALID' }
        Object.assign(raw, { exitCode: code, exitSignal: signal, stdoutBytes, stderrBytes, stdoutSha256: stdoutHash.digest('hex'), stderr: redact(stderr) })
        if (failure || code !== 0) reject(new CodexTextError(failure ?? 'CODEX_EXIT_FAILED', 'CLI未产生可验收的完整文本；本次不自动重试', raw))
        else resolve()
      }
      const abort = (code: string) => {
        if (failure || settled) return
        failure = code
        const grace = dependencies.killGraceMs ?? 1000
        escalation = setTimeout(() => {
          kill('SIGKILL')
          if (!settled) exitWait = setTimeout(() => finish(null, 'SIGKILL'), grace)
        }, grace)
        kill('SIGTERM')
      }
      const consume = (last: boolean) => {
        let end: number
        while ((end = pending.indexOf('\n')) >= 0 || (last && pending.trim())) {
          if (end < 0) end = pending.length
          const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1)
          if (!line) continue
          let value: unknown
          try { value = JSON.parse(line) } catch { throw Error('CODEX_JSONL_INVALID') }
          if (record(value)) events.push(redact(value) as Value)
          checkEvent(value)
        }
      }
      const timeout = setTimeout(() => abort('CODEX_TIMEOUT'), effective.timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled || failure) return
        stdoutBytes += chunk.length; stdoutHash.update(chunk)
        if (stdoutBytes > effective.maxStdoutBytes!) return abort('CODEX_STDOUT_TOO_LARGE')
        try { pending += decoder.decode(chunk, { stream: true }); consume(false) }
        catch (error) { abort(error instanceof Error && /^CODEX_/.test(error.message) ? error.message : 'CODEX_JSONL_INVALID') }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled || failure) return
        stderrBytes += chunk.length
        if (stderrBytes > effective.maxStderrBytes!) return abort('CODEX_STDERR_TOO_LARGE')
        stderr += chunk.toString('utf8')
      })
      child.once('error', () => { failure = 'CODEX_SPAWN_FAILED'; finish(null, null) })
      child.once('close', finish)
      child.stdin.on('error', () => abort('CODEX_STDIN_FAILED'))
      try { child.stdin.end(submittedPrompt) } catch { abort('CODEX_STDIN_FAILED') }
    })
    if (events.filter(event => event.type === 'turn.completed').length !== 1 || !events.some(event => event.type === 'turn.started')) {
      throw new CodexTextError('CODEX_TURN_INCOMPLETE', '缺少唯一完整回合结束事件', raw)
    }
    let finalText: string
    try { finalText = await boundedFinalMessage(lastMessagePath) }
    catch (error) { throw new CodexTextError(error instanceof Error && error.message === 'CODEX_FINAL_TOO_LARGE' ? error.message : 'CODEX_FINAL_INVALID', '最终消息文件缺失、超限或不可读取', raw) }
    if (!finalText.trim()) throw new CodexTextError('CODEX_EMPTY_FINAL', '最终消息为空', raw)
    const completed = events.find(event => event.type === 'turn.completed')!
    Object.assign(raw, { durationMs: Date.now() - started, finalMessageSha256: digest(finalText), toolEventsObserved: 0,
      recoveredDiagnostics: events.filter(knownDiagnostic),
      ...(completed.usage === undefined ? {} : { usage: completed.usage }) })
    return { status: 200 as const, body: { type: 'message' as const, role: 'assistant' as const,
      content: [{ type: 'text' as const, text: finalText }], provider: 'Codex' as const, raw } }
  } catch (error) {
    if (error instanceof CodexTextError) { error.raw.durationMs = Date.now() - started; throw error }
    throw new CodexTextError('CODEX_IO_FAILED', '准备或读取临时调用文件失败', { ...raw, durationMs: Date.now() - started })
  } finally { if (directory) await rm(directory, { recursive: true, force: true }) }
}
