import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { persistGeneratedImageResponse } from './generated-image-storage.ts'
import { resolveCodexExecutablePath } from './codex-text.ts'
import { loadCodexReferenceImages } from './codex-reference-images.ts'

type Value = Record<string, unknown>
export type CodexImageConfig = {
  executablePath: string
  configuredExecutablePath?: string
  model?: string // Codex agent model. The built-in image tool chooses its own GPT Image model.
  reasoningEffort?: string
  timeoutMs: number
  referenceImages?: unknown
  size?: string
  singleFrame?: boolean
}
export type CodexImageDependencies = {
  spawn?: (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
  env?: NodeJS.ProcessEnv
  codexHome?: string
  outputRoot?: string
  killGraceMs?: number
}

const LIMITS = { promptBytes: 64 * 1024, stdoutBytes: 8 * 1024 * 1024, stderrBytes: 512 * 1024,
  imageBytes: 20 * 1024 * 1024, referenceCount: 5, timeoutMs: 3_600_000 } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The built-in $imagegen skill needs the code-mode host; it is not an ordinary
// shell command. Disable independent shell tools and reject their JSONL items.
const disabledFeatures = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'multi_agent', 'memories',
  'chronicle', 'hooks', 'shell_snapshot', 'workspace_dependencies', 'tool_suggest', 'sleep_tool', 'goals']
const record = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
function invalid(message: string): never { throw new Error('CODEX_IMAGE_CONFIG_INVALID: ' + message) }

export class CodexImageError extends Error {
  readonly raw: Value
  constructor(code: string, message: string, raw: Value) {
    super(code + ': ' + message)
    this.name = 'CodexImageError'
    this.raw = raw
  }
}

/** `model` selects the Codex agent, never the image-generation model. */
export function resolveCodexImageConfig(model: { capability: string; settings: Record<string, string> }, params: Value = {}): CodexImageConfig {
  if (model.capability !== 'image' || !record(model.settings) || !record(params)) invalid('Codex 生图要求 image 能力和对象参数')
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
  const selectedModel = optionalText('model')
  if (selectedModel && /(?:^|\/)gpt-image(?:-|$)/i.test(selectedModel)) invalid('Model ID 应填写 Codex 主代理模型；内建生图工具不能通过 -m 选择 GPT Image 版本')
  const reasoningEffort = optionalText('reasoningEffort')
  if (reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) invalid('reasoningEffort 非法')
  const timeoutValue = chosen('timeoutMs') ?? 600_000
  const timeoutMs = Number(timeoutValue)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs) invalid('timeoutMs 必须是1..3600000的整数')
  const referenceImages = params.referenceImages
  if (referenceImages !== undefined && !Array.isArray(referenceImages)) invalid('referenceImages 必须是图片数组')
  if (Array.isArray(referenceImages) && referenceImages.length > LIMITS.referenceCount) invalid('referenceImages 最多支持5张')
  const size = optionalText('size')
  if (size) {
    const dimensions = size.match(/^(\d{3,4})x(\d{3,4})$/)
    const width = Number(dimensions?.[1]), height = Number(dimensions?.[2])
    if (!dimensions || width < 256 || height < 256 || width > 3840 || height > 3840
      || width * height > 8_294_400 || Math.max(width, height) / Math.min(width, height) > 3) {
      invalid('size 必须是安全范围内的 WxH 像素尺寸')
    }
  }
  const singleFrame = params.singleFrame
  if (singleFrame !== undefined && ![true, false, 'true', 'false'].includes(singleFrame as boolean)) invalid('singleFrame 必须是布尔值')
  for (const key of ['image', 'referenceImage', 'reviewImages', 'quality', 'background', 'outputFormat', 'aspectRatio', 'resolution', 'negativePrompt']) {
    const value = params[key]
    if (value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length)) invalid(key + ' 尚不支持通过 Codex CLI 生图工具精确传递')
  }
  const count = params.n
  if (count !== undefined && Number(count) !== 1) invalid('Codex CLI 生图目前每次仅支持生成1张')
  return { executablePath, ...(configuredExecutablePath !== executablePath ? { configuredExecutablePath } : {}),
    ...(selectedModel ? { model: selectedModel } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), timeoutMs,
    ...(referenceImages?.length ? { referenceImages } : {}), ...(size ? { size } : {}),
    ...(singleFrame !== undefined ? { singleFrame: singleFrame === true || singleFrame === 'true' } : {}) }
}

/** The built-in image tool fixes size=auto. Keep the whole scene while making
 * the saved frame match the dimensions required by downstream video models. */
export async function normalizeOutputSize(bytes: Buffer, requested: string | undefined, raw: Value) {
  const metadata = await sharp(bytes).metadata()
  if (!metadata.width || !metadata.height) throw new CodexImageError('CODEX_IMAGE_INVALID', '生图缺少有效尺寸', raw)
  const source = { width: metadata.width, height: metadata.height }
  if (!requested) {
    raw.outputSize = { source, result: source, method: 'original' }
    return bytes
  }
  const [width, height] = requested.split('x').map(Number)
  if (width === metadata.width && height === metadata.height) {
    raw.outputSize = { source, result: { width, height }, method: 'original' }
    return bytes
  }
  let result: Buffer
  let method: string
  if (metadata.width * height === metadata.height * width) {
    result = await sharp(bytes).resize(width, height, { fit: 'fill' }).png().toBuffer()
    method = 'proportional-resize'
  } else {
    // A center crop could discard one of the two characters in this workflow.
    // A blurred full-bleed background fills the canvas while the complete
    // generated image remains sharp and undistorted in front.
    const background = await sharp(bytes).resize(width, height, { fit: 'cover' }).blur(35).png().toBuffer()
    const foreground = await sharp(bytes).resize(width, height, { fit: 'inside' }).png().toBuffer()
    const front = await sharp(foreground).metadata()
    result = await sharp(background).composite([{ input: foreground,
      left: Math.floor((width - (front.width ?? width)) / 2),
      top: Math.floor((height - (front.height ?? height)) / 2) }]).png().toBuffer()
    method = 'contain-over-blurred-background'
  }
  if (result.length > LIMITS.imageBytes) throw new CodexImageError('CODEX_IMAGE_TOO_LARGE', '规范尺寸后的图片超过20MiB', raw)
  const final = await sharp(result).metadata()
  if (final.width !== width || final.height !== height) throw new CodexImageError('CODEX_IMAGE_SIZE_MISMATCH', '规范尺寸后图片尺寸不符', raw)
  raw.outputSize = { requested, source, result: { width, height }, method }
  return result
}

function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'CODEX_HOME']) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  return env
}

function safeDiagnosticMessage(value: unknown): string {
  if (typeof value !== 'string') return '[no message]'
  return value.replace(/[\r\n\t]+/g, ' ')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s"']+/gi, '[REDACTED]')
    .replace(/data:image\/[^\s"']+/gi, '[IMAGE_DATA_REDACTED]')
    .replace(/https?:\/\/[^\s"']+/gi, '[URL_REDACTED]')
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/)[^\s"']+/g, '[PATH_REDACTED]')
    .replace(/[A-Za-z0-9+/_-]{80,}={0,2}/g, '[OPAQUE_REDACTED]')
    .slice(0, 300)
}

function knownRecoverableDiagnostic(event: Value): boolean {
  const transport = (message: string) => message === 'request timed out'
    || message === 'workspace routing discovery timed out'
    || message === 'stream disconnected before completion: Connection reset by peer (os error 54)'
  if (event.type === 'error') {
    const reconnect = typeof event.message === 'string' ? /^Reconnecting\.\.\. [1-5]\/5 \((.*)\)$/.exec(event.message) : null
    return Object.keys(event).every(key => ['type', 'message'].includes(key)) && Boolean(reconnect && transport(reconnect[1]))
  }
  if (event.type !== 'item.completed' || !record(event.item) || event.item.type !== 'error'
    || !Object.keys(event.item).every(key => ['id', 'type', 'message'].includes(key))) return false
  return event.item.message === 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'
    || typeof event.item.message === 'string' && event.item.message.startsWith('Falling back from WebSockets to HTTPS transport. ')
      && transport(event.item.message.slice('Falling back from WebSockets to HTTPS transport. '.length))
}

function inspectEvents(stdout: Buffer, raw: Value) {
  let events: unknown[]
  try { events = new TextDecoder('utf-8', { fatal: true }).decode(stdout).trim().split('\n').map(line => JSON.parse(line)) }
  catch { throw new CodexImageError('CODEX_IMAGE_JSONL_INVALID', 'CLI 未返回有效的 JSONL 事件', raw) }
  const started = events.filter(event => record(event) && event.type === 'thread.started') as Value[]
  const threadId = started.length === 1 && typeof started[0].thread_id === 'string' ? started[0].thread_id : ''
  if (!UUID.test(threadId)) throw new CodexImageError('CODEX_IMAGE_THREAD_INVALID', '无法确定本次生图的独立线程', raw)
  raw.threadId = threadId
  raw.eventTypes = events.map(event => record(event) ? [event.type, record(event.item) ? event.item.type : undefined] : ['invalid'])
  const diagnostics = events.filter((event): event is Value => record(event) && (event.type === 'error' || event.type === 'turn.failed'
    || event.error !== undefined || record(event.item) && (event.item.type === 'error' || event.item.error !== undefined)))
  raw.eventDiagnostics = diagnostics.slice(0, 8).map(event => {
      const item = record(event.item) ? event.item : undefined
      const eventError = record(event.error) ? event.error : undefined
      return { type: event.type, ...(item ? { itemType: item.type } : {}),
        recoverable: knownRecoverableDiagnostic(event),
        message: safeDiagnosticMessage(item?.message ?? eventError?.message ?? event.message ?? event.error ?? item?.error) }
    })
  for (const event of events) {
    if (!record(event) || typeof event.type !== 'string'
      || (event.type === 'error' || event.type === 'turn.failed' || event.error !== undefined)
      && !knownRecoverableDiagnostic(event)) {
      throw new CodexImageError('CODEX_IMAGE_EVENT_FAILED', 'CLI 返回错误事件', raw)
    }
    if (knownRecoverableDiagnostic(event)) continue
    if (event.type.startsWith('item.')) {
      if (!record(event.item) || !['agent_message', 'reasoning', 'image_generation'].includes(String(event.item.type))
        || event.item.error !== undefined || event.item.status === 'failed') {
        throw new CodexImageError('CODEX_IMAGE_UNEXPECTED_TOOL', 'CLI 使用了未允许的工具或返回失败事件', raw)
      }
    } else if (!['thread.started', 'turn.started', 'turn.completed'].includes(event.type)) {
      throw new CodexImageError('CODEX_IMAGE_EVENT_INVALID', 'CLI 返回未知事件', raw)
    }
  }
  if (events.filter(event => record(event) && event.type === 'turn.started').length !== 1
    || events.filter(event => record(event) && event.type === 'turn.completed').length !== 1) {
    throw new CodexImageError('CODEX_IMAGE_INCOMPLETE', 'CLI 没有完成唯一的一轮生图', raw)
  }
  return threadId
}

async function generatedImage(codexHome: string, threadId: string, raw: Value): Promise<Buffer> {
  const folder = path.join(codexHome, 'generated_images', threadId)
  let pictures: string[]
  try { pictures = (await readdir(folder, { withFileTypes: true, encoding: 'utf8' }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.png')).map(entry => entry.name) }
  catch { throw new CodexImageError('CODEX_IMAGE_MISSING', 'CLI 已结束但没有保存本次线程的图片', raw) }
  if (pictures.length !== 1) throw new CodexImageError('CODEX_IMAGE_COUNT_INVALID', '本次线程必须恰好保存1张 PNG 图片', { ...raw, imageCount: pictures.length })
  const filename = path.join(folder, pictures[0])
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size < 64 || info.size > LIMITS.imageBytes) throw Error('size')
    const bytes = await handle.readFile()
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw Error('header')
    // Metadata alone can succeed on a truncated file. Decode the complete
    // raster before recording a successful model response.
    await sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 }).raw().toBuffer()
    return bytes
  } catch { throw new CodexImageError('CODEX_IMAGE_INVALID', '生图文件缺失、超限或不是有效 PNG', raw) }
  finally { await handle?.close() }
}

/** Run one isolated Codex agent turn; only a complete turn with one decoded file succeeds. */
export async function callCodexImage(config: CodexImageConfig, prompt: string, dependencies: CodexImageDependencies = {}) {
  const effective = resolveCodexImageConfig({ capability: 'image', settings: {} }, config)
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > LIMITS.promptBytes) invalid('prompt 必须为非空且不超过64KiB的文本')
  const env = childEnvironment(dependencies.env ?? process.env)
  const codexHome = dependencies.codexHome ?? env.CODEX_HOME ?? (env.HOME ? path.join(env.HOME, '.codex') : '')
  if (!path.isAbsolute(codexHome)) invalid('CODEX_HOME 必须是绝对路径')
  const raw: Value = { provider: 'Codex', tool: 'image_generation', agentModel: effective.model ?? 'Codex CLI default',
    appliedConfig: { executablePath: effective.executablePath, configuredExecutablePath: config.configuredExecutablePath ?? config.executablePath,
      timeoutMs: effective.timeoutMs, sandbox: 'workspace-write', ephemeral: true, ignoreUserConfig: true, ignoreRules: true },
    promptSha256: sha256(prompt) }
  const startedAt = Date.now()
  let directory: string | undefined
  try {
    let references: Awaited<ReturnType<typeof loadCodexReferenceImages>>
    try { references = await loadCodexReferenceImages(effective.referenceImages) }
    catch { throw new CodexImageError('CODEX_IMAGE_REFERENCE_INVALID', '参考图必须是最多5张可完整解码的 JPEG 上传图片', raw) }
    if (references.length > LIMITS.referenceCount) throw new CodexImageError('CODEX_IMAGE_REFERENCE_COUNT', '内建生图工具最多接受5张参考图', raw)
    directory = await mkdtemp(path.join(tmpdir(), 'video-aigc-codex-image-'))
    const referencePaths: string[] = []
    for (const [index, reference] of references.entries()) {
      const filename = path.join(directory, `reference-${String(index + 1).padStart(2, '0')}.jpg`)
      await writeFile(filename, reference.bytes, { flag: 'wx', mode: 0o600 })
      referencePaths.push(filename)
    }
    raw.references = references.map((reference, index) => ({ index: index + 1,
      sha256: sha256(reference.bytes), bytes: reference.bytes.length }))
    const args = ['-a', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'workspace-write', '-C', directory, '-c', 'model_provider="openai"', '-c', 'web_search="disabled"',
      '-c', 'project_doc_max_bytes=0', '--json', '--color', 'never', '--enable', 'image_generation',
      ...disabledFeatures.flatMap(name => ['--disable', name])]
    if (effective.model) args.push('-m', effective.model)
    if (effective.reasoningEffort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(effective.reasoningEffort))
    for (const filename of referencePaths) args.push('-i', filename)
    args.push('--', '-')
    const referenceInstruction = referencePaths.length
      ? `\n以下${referencePaths.length}张图片按顺序作为角色/场景参考，已附在本条消息中。调用 image_gen.imagegen 时必须将这组绝对路径原样放入 referenced_image_paths：${JSON.stringify(referencePaths)}；不要传 num_last_images_to_include。按图中身份和顺序理解角色，不要把同一角色的多张视角参考画成多个角色，也不要复制参考图排版。`
      : ''
    const sizeInstruction = effective.size
      ? `\n目标交付尺寸为 ${effective.size} 像素；请按此宽高比构图。内建生图工具的 size 是 auto，交付前会在不拉伸主体的前提下规范到该像素尺寸。`
      : ''
    const frameInstruction = effective.singleFrame
      ? '\n只生成单幅完整画面，同一角色在画面中只出现一次；不要拼贴、分镜格、重复角色、边框或文字。'
      : ''
    const request = '$imagegen\n请仅使用 Codex 内建生图工具，根据以下提示生成一张图片。不要调用命令、编程或其他工具，也不要创建替代图片。内建工具完成后立即结束本轮。'
      + referenceInstruction + sizeInstruction + frameInstruction + '\n\n' + prompt
    let child: ChildProcessWithoutNullStreams
    try { child = (dependencies.spawn ?? spawn)(effective.executablePath, args, { cwd: directory, shell: false,
      detached: process.platform !== 'win32', env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams }
    catch { throw new CodexImageError('CODEX_IMAGE_SPAWN_FAILED', 'CLI 未能启动', raw) }
    const stdout = await new Promise<Buffer>((resolve, reject) => {
      let output: Buffer[] = [], outputBytes = 0, stderr = '', stderrBytes = 0, failure = '', closed = false
      let escalation: ReturnType<typeof setTimeout> | undefined
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch { try { child.kill(signal) } catch { /* Preserve the original error. */ } }
      }
      const fail = (code: string) => {
        if (failure || closed) return
        failure = code; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), dependencies.killGraceMs ?? 1000)
      }
      const timeout = setTimeout(() => fail('CODEX_IMAGE_TIMEOUT'), effective.timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > LIMITS.stdoutBytes) return fail('CODEX_IMAGE_STDOUT_TOO_LARGE')
        output.push(Buffer.from(chunk))
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > LIMITS.stderrBytes) return fail('CODEX_IMAGE_STDERR_TOO_LARGE')
        stderr += chunk.toString('utf8')
      })
      child.on('error', () => fail('CODEX_IMAGE_SPAWN_FAILED'))
      child.on('close', (code, signal) => {
        closed = true; clearTimeout(timeout); clearTimeout(escalation)
        raw.exitCode = code; raw.exitSignal = signal; raw.stdoutBytes = outputBytes; raw.stderrBytes = stderrBytes
        raw.stderr = stderr.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]').slice(0, 2000)
        if (failure || code !== 0) reject(new CodexImageError(failure || 'CODEX_IMAGE_EXIT_FAILED', 'CLI 生图未完整结束', raw))
        else resolve(Buffer.concat(output))
        output = []
      })
      child.stdin.on('error', () => fail('CODEX_IMAGE_STDIN_FAILED'))
      try { child.stdin.end(request) } catch { fail('CODEX_IMAGE_STDIN_FAILED') }
    })
    const threadId = inspectEvents(stdout, raw)
    const sourceBytes = await generatedImage(codexHome, threadId, raw)
    const bytes = await normalizeOutputSize(sourceBytes, effective.size, raw)
    let url: unknown
    try { url = await persistGeneratedImageResponse('data:image/png;base64,' + bytes.toString('base64'), dependencies.outputRoot ?? process.cwd()) }
    catch { throw new CodexImageError('CODEX_IMAGE_DECODE_FAILED', '图片无法解码或保存', raw) }
    if (typeof url !== 'string' || !url.startsWith('/generated/')) throw new CodexImageError('CODEX_IMAGE_SAVE_FAILED', '图片未保存到生成媒体目录', raw)
    raw.image = { sha256: sha256(bytes), bytes: bytes.length, url,
      sourceSha256: sha256(sourceBytes), sourceBytes: sourceBytes.length }
    raw.durationMs = Date.now() - startedAt
    return { status: 200 as const, body: { data: [{ url }], provider: 'Codex' as const, raw } }
  } catch (error) {
    if (error instanceof CodexImageError) { error.raw.durationMs = Date.now() - startedAt; throw error }
    throw new CodexImageError('CODEX_IMAGE_IO_FAILED', 'Codex 生图调用或文件处理失败', { ...raw, durationMs: Date.now() - startedAt })
  } finally { if (directory) await rm(directory, { recursive: true, force: true }) }
}
