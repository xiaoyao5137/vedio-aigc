export type AudioSourceKind = 'native-speech' | 'native-ambient' | 'independent-narration' | 'independent-offscreen-dialogue' | 'unknown'
export type AudioSourceReference = { url: string; redacted?: boolean }
export type AudioSourceProvenance = {
  version: 'audio-source-v1'
  kind: AudioSourceKind
  evidence: 'composition-receipt' | 'provider-result' | 'unavailable'
  reason?: string
  taskId?: string
  modelId?: string
  picture?: AudioSourceReference
  tracks?: Array<AudioSourceReference & { voiceId?: string; sha256?: string; start?: number; end?: number; tempo?: number }>
  voices?: Array<{ name: string; voiceId?: string; elementId?: string; binding: 'fixed' | 'unbound' }>
}

/** Self-contained for the persisted quality-node VM. Provider/model labels and
 * voice-design assets alone never establish how a finished soundtrack was made.
 * URLs are references, not credentials: omit data URLs and strip signed queries. */
export function deriveAudioSourceProvenance(value: unknown, fallback: { audioType?: unknown; audioText?: unknown } = {}): AudioSourceProvenance {
  type Row = Record<string, unknown>
  const row = (item: unknown): Row => item && typeof item === 'object' && !Array.isArray(item) ? item as Row : {}
  const text = (item: unknown) => typeof item === 'string' && item.length <= 512 && !/[\r\n]/.test(item) && !/^data:/i.test(item) ? item.trim() : ''
  const rows = (item: unknown) => Array.isArray(item) ? item.map(row) : []
  const reference = (item: unknown): AudioSourceReference | undefined => {
    if (typeof item !== 'string' || item.length > 8192 || /[\s\\]/.test(item)) return undefined
    if (/^\/generated\/[\w.-]+$/.test(item)) return { url: item }
    const match = item.match(/^(https?:\/\/[a-z\d.-]+(?::\d+)?(?:\/[^?#]*)?)(?:[?#].*)?$/i)
    return match ? { url: match[1], ...(match[1] !== item ? { redacted: true } : {}) } : undefined
  }
  const trackRefs = (items: unknown) => rows(items).flatMap(item => {
    const ref = reference(item.url)
    if (!ref) return []
    const result: NonNullable<AudioSourceProvenance['tracks']>[number] = { ...ref, ...(item.redacted === true ? { redacted: true } : {}) }
    if (text(item.voiceId)) result.voiceId = text(item.voiceId)
    if (typeof item.sha256 === 'string' && /^[a-f\d]{64}$/i.test(item.sha256)) result.sha256 = item.sha256
    for (const key of ['start', 'end', 'tempo'] as const) if (typeof item[key] === 'number' && Number.isFinite(item[key])) result[key] = item[key]
    return [result]
  })
  const voiceRefs = (items: unknown, unbound = false) => rows(items).flatMap(item => {
    const name = text(item.characterName ?? item.name)
    if (!name) return []
    const voiceId = text(item.voiceId), elementId = text(item.elementId)
    return [{ name, ...(voiceId ? { voiceId } : {}), ...(elementId ? { elementId } : {}),
      binding: unbound || item.binding === 'unbound' || !voiceId ? 'unbound' as const : 'fixed' as const }]
  })
  const unknown = (reason: string): AudioSourceProvenance => ({ version: 'audio-source-v1', kind: 'unknown', evidence: 'unavailable', reason })
  const take = row(value), raw = row(take.raw), response = row(take.response)
  const candidates = [take, raw, row(raw.body), response, row(response.body)]
  const params = row(take.params)
  const receipt = candidates.find(item => text(row(item.data).task_id)) ?? {}
  const data = row(receipt.data), taskId = text(data.task_id), modelId = text(take.model ?? take.modelId)
  const identity = { ...(taskId ? { taskId } : {}), ...(modelId ? { modelId } : {}) }
  const mixed = candidates.flatMap(item => [row(item.narration), row(item.offscreenDialogue)]).find(item => Object.keys(item).length)
  if (mixed) {
    const kind = mixed.route === 'independent-narration-v1' ? 'independent-narration'
      : mixed.route === 'independent-offscreen-dialogue-v1' ? 'independent-offscreen-dialogue' : undefined
    if (!kind || !rows(mixed.tracks).length || typeof mixed.pictureUrl !== 'string' || !mixed.pictureUrl) return unknown('独立音轨信息不完整，不能确定最终声音来源。')
    const picture = reference(mixed.pictureUrl)
    return { version: 'audio-source-v1', kind, evidence: 'composition-receipt', ...identity,
      ...(picture ? { picture } : {}), tracks: trackRefs(mixed.tracks) }
  }
  // Accepted clips and rolling concats retain this compact snapshot. Rebuild it
  // through the whitelist so old/imported snapshots cannot expose credentials.
  const saved = row(take.audioSource)
  const kinds: AudioSourceKind[] = ['native-speech', 'native-ambient', 'independent-narration', 'independent-offscreen-dialogue', 'unknown']
  if (saved.version === 'audio-source-v1' && kinds.includes(saved.kind as AudioSourceKind)) {
    const kind = saved.kind as AudioSourceKind
    if (kind === 'unknown') return unknown(text(saved.reason) || '旧素材未保存可追踪的声音来源。')
    const evidence = kind.startsWith('independent-') ? 'composition-receipt' : 'provider-result'
    if (saved.evidence !== evidence) return unknown('保存的声音来源缺少对应生成证据。')
    const picture = reference(row(saved.picture).url)
    return { version: 'audio-source-v1', kind, evidence,
      ...(text(saved.taskId) ? { taskId: text(saved.taskId) } : {}), ...(text(saved.modelId) ? { modelId: text(saved.modelId) } : {}),
      ...(picture ? { picture: { ...picture, ...(row(saved.picture).redacted === true ? { redacted: true } : {}) } } : {}),
      ...(Array.isArray(saved.tracks) ? { tracks: trackRefs(saved.tracks) } : {}),
      ...(Array.isArray(saved.voices) ? { voices: voiceRefs(saved.voices) } : {}) }
  }
  if (params.narrationVoice || params.offscreenDialogueVoice) return unknown('输入要求独立配音，但缺少完成混音的回执。')
  const providerUrl = rows(row(data.task_result).videos)[0]?.url
  const directResult = taskId && data.task_status === 'succeed' && typeof providerUrl === 'string' && providerUrl.length > 0
    && (take.url === providerUrl || take.originalUrl === providerUrl)
  if (!directResult || params.sound !== 'on') return unknown('旧素材未保存足够的直接生成或混音来源证据。')
  const audioType = params.audioType ?? fallback.audioType, audioText = params.audioText ?? fallback.audioText
  const voices = candidates.flatMap(item => voiceRefs(item.characterVoices))
  const groups = candidates.flatMap(item => voiceRefs(item.nativeGroupVoices, true))
  const uniqueVoices = [...new Map([...voices, ...groups].map(item => [JSON.stringify(item), item])).values()]
  if (audioType === '对白' && typeof audioText === 'string' && audioText.trim()) return {
    version: 'audio-source-v1', kind: 'native-speech', evidence: 'provider-result', ...identity, ...(uniqueVoices.length ? { voices: uniqueVoices } : {}),
  }
  if (audioType === '环境声' && (audioText === '' || audioText === undefined)) return {
    version: 'audio-source-v1', kind: 'native-ambient', evidence: 'provider-result', ...identity,
  }
  return unknown('生成回执存在，但声部类型不足以区分原生人声与其他声音来源。')
}

export function audioSourceLabel(source: AudioSourceProvenance): string {
  return ({ 'native-speech': '原生同期对白', 'native-ambient': '原生环境声',
    'independent-narration': '独立 TTS 旁白', 'independent-offscreen-dialogue': '独立画外对白', unknown: '声音来源未知' })[source.kind]
}
