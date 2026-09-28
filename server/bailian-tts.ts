import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import type { ExternalModelConfig } from './model-adapters.ts'

export function bailianTtsEndpoint(endpoint: string) {
  const url = new URL(endpoint)
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('TTS_CONFIG_INVALID: 请填写 HTTPS Base URL 或 WSS 接口地址')
  if (!['', '/', '/compatible-mode/v1', '/compatible-mode/v1/', '/api-ws/v1/inference'].includes(url.pathname)) throw Error('TTS_CONFIG_INVALID: 不支持的百炼接口路径')
  url.protocol = 'wss:'
  url.pathname = '/api-ws/v1/inference'
  return url.toString()
}

export function buildBailianTtsParameters(settings: Record<string, string>, params: Record<string, unknown>) {
  const get = (key: string, fallback: unknown) => params[key] ?? settings[key] ?? fallback
  const number = (key: string, fallback: number, min: number, max: number, integer = false) => {
    const value = Number(get(key, fallback))
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw Error(`TTS_INPUT_INVALID: ${key} 必须在 ${min}–${max} 范围内${integer ? '且为整数' : ''}`)
    return value
  }
  const voice = String(get('voice', 'longanhuan_v3.6')).trim()
  if (!voice) throw Error('TTS_INPUT_INVALID: 请选择音色')
  const sampleRate = number('sampleRate', 24000, 8000, 48000, true)
  if (![8000, 16000, 22050, 24000, 44100, 48000].includes(sampleRate)) throw Error('TTS_INPUT_INVALID: 不支持的采样率')
  const instruction = String(get('instruction', ''))
  return { text_type: 'PlainText', voice, format: 'pcm', sample_rate: sampleRate,
    volume: number('volume', 50, 0, 100, true), rate: number('rate', 1, 0.5, 2), pitch: number('pitch', 1, 0.5, 2),
    seed: number('seed', 0, 0, 65535, true), ...(instruction ? { instruction } : {}) }
}

export function pcmToWav(pcm: Buffer, sampleRate: number) {
  if (!pcm.length || pcm.length % 2) throw Error('TTS_AUDIO_INVALID: 返回音频为空或 PCM 样本不完整')
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export async function callBailianTts(model: ExternalModelConfig, text: string, params: Record<string, unknown> = {}, dependencies: { root?: string; connect?: (url: string, options: WebSocket.ClientOptions) => WebSocket } = {}) {
  if (!model.settings.apiKey?.trim() || !model.settings.model?.trim()) throw Error('TTS_CONFIG_INVALID: 请配置 API Key 和 Model ID')
  if (!text.trim() || Array.from(text).length > 20000) throw Error('TTS_INPUT_INVALID: 合成文本必须为 1–20000 字符')
  const endpoint = bailianTtsEndpoint(model.settings.endpoint)
  const parameters = buildBailianTtsParameters(model.settings, params)
  const taskId = randomUUID()
  const timeoutMs = Number(model.settings.timeoutMs ?? 120000)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw Error('TTS_CONFIG_INVALID: 超时必须为 1000–600000 毫秒')
  const startedAt = Date.now()
  const output = await new Promise<{ pcm: Buffer; events: unknown[] }>((resolve, reject) => {
    const ws = (dependencies.connect ?? ((url, options) => new WebSocket(url, options)))(endpoint, {
      headers: { Authorization: `Bearer ${model.settings.apiKey}`, 'X-DashScope-DataInspection': 'enable' },
      handshakeTimeout: Math.min(timeoutMs, 20000), maxPayload: 16 * 1024 * 1024, followRedirects: false,
    })
    const chunks: Buffer[] = [], events: unknown[] = []
    let bytes = 0, settled = false, textSent = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      ws.close()
      if (error) reject(error)
      else resolve({ pcm: Buffer.concat(chunks), events })
    }
    const timer = setTimeout(() => { finish(Error(`TTS_TIMEOUT: 任务 ${taskId} 未完整结束，不能使用部分音频`)); ws.terminate() }, timeoutMs)
    const send = (action: string, payload: Record<string, unknown>) => ws.send(JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }))
    ws.on('open', () => send('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: model.settings.model, parameters, input: {} }))
    ws.on('message', (data, binary) => {
      if (settled) return
      try {
        if (binary) {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          bytes += chunk.length
          if (bytes > 64 * 1024 * 1024) return finish(Error('TTS_AUDIO_INVALID: 音频超过 64MB'))
          chunks.push(chunk); return
        }
        const event = JSON.parse(data.toString())
        if (event.header?.task_id !== taskId) return finish(Error('TTS_PROTOCOL_INVALID: 返回任务身份不匹配'))
        if (events.length < 2000) events.push(event)
        if (event.header.event === 'task-started' && !textSent) {
          textSent = true
          send('continue-task', { input: { text } }); send('finish-task', { input: {} })
        } else if (event.header.event === 'task-failed') {
          const message = String(event.header.error_message ?? '供应商拒绝合成').split(model.settings.apiKey).join('[redacted]')
          finish(Error(`TTS_PROVIDER_FAILED: ${event.header.error_code ?? ''} ${message}（${taskId}）`))
        } else if (event.header.event === 'task-finished') finish()
      } catch (error) { finish(error instanceof Error ? error : Error(String(error))) }
    })
    ws.on('error', () => finish(Error(`TTS_CONNECTION_FAILED: 无法连接语音服务（任务 ${taskId}）`)))
    ws.on('unexpected-response', (_request, response) => { response.resume(); finish(Error(`TTS_CONNECTION_FAILED: HTTP ${response.statusCode}（任务 ${taskId}）`)); ws.terminate() })
    ws.on('close', () => { if (!settled) finish(Error(`TTS_INCOMPLETE: 连接提前关闭（任务 ${taskId}）`)) })
  })
  const wav = pcmToWav(output.pcm, parameters.sample_rate)
  const hash = createHash('sha256').update(wav).digest('hex')
  const filename = `tts-${taskId}.wav`
  const directory = path.join(dependencies.root ?? process.cwd(), 'public/generated')
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, filename), wav, { flag: 'wx' })
  return { status: 200, body: { status: 'succeeded', taskId, url: `/generated/${filename}`, duration: output.pcm.length / (parameters.sample_rate * 2),
    durationSource: 'pcm-samples', sampleRate: parameters.sample_rate, channels: 1, format: 'wav', bytes: wav.length, sha256: hash,
    model: model.settings.model, voice: parameters.voice, rate: parameters.rate, seed: parameters.seed, instruction: parameters.instruction ?? '', transcript: text, transcriptSource: 'input-text',
    characterName: String(params.characterName ?? ''), synthesisMs: Date.now() - startedAt, providerEvents: output.events } }
}
