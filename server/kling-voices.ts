import { createHash } from 'node:crypto'
import { fetchModelEndpoint, klingAuthorization, type ExternalModelConfig } from './model-adapters.ts'

export class KlingAssetRejectedError extends Error {}

export function klingAssetBase(endpoint: string) {
  const url = new URL(endpoint)
  const match = url.pathname.match(/^(.*)\/v1(?:\/|$)/)
  if (!match) throw Error('VOICE_PROVIDER_UNSUPPORTED: 当前音色适配要求已配置的 Kling /v1 接口')
  return `${url.origin}${match[1]}/v1/general`
}

export function voiceAccountScope(model: ExternalModelConfig) {
  return createHash('sha256').update(JSON.stringify([klingAssetBase(model.settings.endpoint), model.settings.accessKey || model.settings.apiKey || ''])).digest('hex')
}

export async function callKlingAsset(model: ExternalModelConfig, route: string, body?: Record<string, unknown>, fetchImpl = fetchModelEndpoint) {
  if (model.provider !== 'Kling') throw Error('VOICE_PROVIDER_UNSUPPORTED: 当前已接入可灵人物音色')
  if (!/^(?:presets-voices|custom-voices|advanced-custom-elements)(?:[/?][\w?=&%-]+)?$/.test(route)) throw Error('无效的声音资产操作')
  const response = await fetchImpl(`${klingAssetBase(model.settings.endpoint)}/${route}`, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: klingAuthorization(model.settings) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000),
  })
  const raw = await response.text()
  const value = JSON.parse(raw.replace(/("element_id"\s*:\s*)(\d+)/g, '$1"$2"')) as Record<string, unknown>
  if (!response.ok || Number(value.code ?? 0) !== 0) throw new KlingAssetRejectedError(`VOICE_PROVIDER_ERROR: HTTP ${response.status}: ${String(value.message ?? '声音资产请求失败')}`)
  return value
}

export function extractKlingVoices(value: Record<string, unknown>) {
  const rows = Array.isArray(value.data) ? value.data : [value.data]
  return rows.flatMap(row => {
    const data = row as { task_status?: string; task_result?: { voices?: Array<{ voice_id: string; voice_name: string; trial_url: string; owned_by: string }> } } | undefined
    return data?.task_result?.voices ?? []
  }).filter(v => v.voice_id && v.voice_name).map(v => ({ voiceId: v.voice_id, voiceName: v.voice_name, previewUrl: v.trial_url, source: v.owned_by === 'kling' ? 'preset' : 'custom' }))
}

export function buildCustomVoiceRequest(input: { voiceName: string; voiceUrl: string; externalTaskId: string }) {
  if (!input.voiceName.trim() || Array.from(input.voiceName.trim()).length > 20) throw Error('音色名称须为 1–20 字')
  const url = new URL(input.voiceUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('参考声音须为供应商可访问的 HTTP(S) URL')
  return { voice_name: input.voiceName.trim(), voice_url: input.voiceUrl, external_task_id: input.externalTaskId }
}
