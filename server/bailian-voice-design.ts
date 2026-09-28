import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExternalModelConfig } from './model-adapters.ts'
import { bailianTtsEndpoint } from './bailian-tts.ts'

export function voiceDesignEndpoint(model: ExternalModelConfig) {
  if (model.provider !== 'Bailian' || model.capability !== 'audio' || !/^qwen-audio-3\.0-tts-(plus|flash)$/.test(model.settings.model ?? '')) throw Error('VOICE_DESIGN_UNSUPPORTED: 请选择已配置的百炼 Qwen Audio TTS Plus 或 Flash')
  if (!model.settings.apiKey?.trim()) throw Error('VOICE_DESIGN_CONFIG: TTS 缺少凭据')
  const url = new URL(bailianTtsEndpoint(model.settings.endpoint))
  url.protocol = 'https:'; url.pathname = '/api/v1/services/audio/tts/customization'
  return url.toString()
}
export function originalVoiceScope(model: ExternalModelConfig) {
  return createHash('sha256').update(`${voiceDesignEndpoint(model)}:${model.settings.apiKey}`).digest('hex')
}
export function buildVoiceDesignInput(model: ExternalModelConfig, description: string, previewText: string, prefix: string) {
  voiceDesignEndpoint(model)
  if (!description.trim() || Array.from(description).length > 500) throw Error('VOICE_DESIGN_INPUT: 原创音色描述必须为 1–500 字符')
  if (Array.from(previewText).length < 15 || Array.from(previewText).length > 200) throw Error('VOICE_DESIGN_INPUT: 试听台词必须为 15–200 字符')
  if (!/^[a-zA-Z0-9]{1,10}$/.test(prefix)) throw Error('VOICE_DESIGN_INPUT: 音色前缀无效')
  return { model: 'voice-enrollment', input: { action: 'create_voice', target_model: model.settings.model, voice_prompt: description.trim(), preview_text: previewText, prefix, language_hints: ['zh'] }, parameters: { sample_rate: 24000, response_format: 'wav' } }
}
export async function callVoiceDesign(model: ExternalModelConfig, body: object, fetcher: typeof fetch = fetch) {
  const response = await fetcher(voiceDesignEndpoint(model), { method: 'POST', headers: { Authorization: `Bearer ${model.settings.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
  const result = await response.json() as Record<string, unknown>
  if (!response.ok || result.code) throw Error(`VOICE_DESIGN_PROVIDER: ${response.status} ${String(result.code ?? '')} ${String(result.message ?? '').split(model.settings.apiKey).join('[redacted]')}`)
  return result as { request_id?: string; output?: { voice_id?: string; target_model?: string; status?: string; preview_audio?: { data: string }; voice_list?: Array<{ voice_id: string; status: string }> } }
}
export async function persistVoicePreview(data: string, root = process.cwd()) {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length < 44 || bytes.length > 16 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('VOICE_DESIGN_AUDIO: 试听 WAV 无效')
  const filename = `voice-design-${createHash('sha256').update(bytes).digest('hex')}.wav`
  const directory = path.join(root, 'public/generated')
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, filename), bytes)
  return `/generated/${filename}`
}
