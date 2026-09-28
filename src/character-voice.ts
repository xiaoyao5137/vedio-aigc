import { isManualReview } from './quality-disposition.ts'
import { resolveAnonymousGroupSpeaker } from './storyboard-group-semantics.ts'

export const VOICE_CONTRACT_VERSION = 'character-voice-v6'

export function assertVoiceRuntime(runtime: { voiceContractVersion?: string }) {
  if (runtime.voiceContractVersion !== VOICE_CONTRACT_VERSION) throw Error('VOICE_PROVIDER_UNSUPPORTED: 当前服务尚未加载人物声音绑定功能，请更新或重启服务后再生成；已阻止未绑定音色的视频请求')
}

export type CharacterVoice = {
  characterId: string
  characterName: string
  version: number
  modelId: string
  accountScope: string
  voiceId: string
  voiceName: string
  previewUrl: string
  elementId?: string
  referenceHash?: string
}

export type VoiceManifest = { version: 'character-voice-v1'; executionId: string; characters: CharacterVoice[] }

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

export type VoiceStagingConflict = { code: 'VOICE_STAGING_CONFLICT'; paths: string[]; reason: string }
export type AnonymousVoiceRole = {
  actorGroupId: string; name: string; continuityKey: string; description: string; offscreen: boolean
  voiceProfile?: Record<string, unknown> | string
  stagingConflict?: VoiceStagingConflict
}
export type NativeGroupVoice = AnonymousVoiceRole & {
  audioRole: 'native-group-dialogue'; status: 'unbound'; method: 'provider-native'; qualityDisposition: 'manual-review-v1'
  speechVerified: false; lipSyncVerified: false
  speechBeats: Array<{ id: string; text: string; deliveryStyle: string }>
}

export function explicitlyOffscreenSpeaker(label: string) {
  const annotations = [...label.matchAll(/[（(]([^）)]*)[）)]/g)].map(match => match[1])
  if (!annotations.some(value => /画外/.test(value))) return false
  const clauses = annotations.flatMap(value => value.split(/[，,；;、]/))
  if (clauses.some(value => /(?:非|不是|不在|并非|不可|不能|不得|未|不)(?:在|处于|作为)?画外/.test(value))) return false
  return clauses.every(value => {
    const positive = value.replace(/(?:不是|不在|并非|非|不(?:必|用|需(?:要)?|得|应|能|可)?|无(?:需|须)|禁止|避免|勿)\s*(?:做|作|生成|要求|进行)?\s*(?:说话口型|同步口型|口型同步|对口型|画内|镜头内)/g, '')
    return !/(?:画内|镜头内|同步口型|口型同步|对口型)/.test(positive)
  })
}

/** A label is not permission to remove a visible performance. Inspect the
 * speaker's own obligations, never an unrelated listener's visible reaction.
 * audio-visual speech completion explicitly requires both sound and the
 * speaker's performance; an independently dubbed role must instead declare
 * audio completion and keep listener/side/back actions in separate beats. */
export function offscreenVoiceStagingConflict(params: Record<string, unknown>, actorId: string, name: string): VoiceStagingConflict | undefined {
  const pacing = object(params.pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  const paths: string[] = []
  for (const [index, beat] of beats.entries()) {
    if (!Array.isArray(beat.actorIds) || !beat.actorIds.includes(actorId) || beat.kind !== 'speech') continue
    if (object(beat.completion).modality === 'audio-visual') paths.push(`pacing.beats[${index}].completion.modality`)
    if (beat.audioPlacement === 'onscreen' || beat.lipSync === 'required') paths.push(`pacing.beats[${index}].${beat.audioPlacement === 'onscreen' ? 'audioPlacement' : 'lipSync'}`)
    const instruction = String(beat.performanceInstruction ?? '')
    const clauses = instruction.split(/[。；;，,\n]/).filter(clause => !/(?:不|禁止|无需|不得|避免|不可).{0,8}(?:开口|张口|口型|嘴|双唇|说话)|(?:口型|嘴唇|双唇).{0,4}(?:不|无需|无须).{0,8}(?:一致|同步|可见)/.test(clause))
    if (clauses.some(clause => /(?:同步口型|对口型|嘴唇.{0,6}(?:同步|可见)|双唇.{0,6}可见|可见.{0,6}开口|张口.{0,6}(?:讲述|说话|发声)|口型.{0,6}(?:台词|对白|声音).{0,6}(?:一致|同步)|正脸.{0,8}(?:讲述|说话|开口)|画内.{0,8}(?:发声|说话))/.test(clause))) paths.push(`pacing.beats[${index}].performanceInstruction`)
  }
  if (!paths.length) return undefined
  return { code: 'VOICE_STAGING_CONFLICT', paths,
    reason: `${name} 的画外标签与本人可见同期说话义务冲突（${paths.join('、')}）。保留原台词及动作；为画内说话提供同一角色的真实人物资产并使用同期声，或在原义务允许时明确安排背侧面/听众画面并把该声部设为 audio 完成，不能仅加“画外”标签后删除同期声。` }
}

/** Shared by runtime binding and provider prompt compilation, for named and
 * anonymous roles alike. Only an actual offscreen declaration can conflict. */
export function speechStagingConflict(params: Record<string, unknown>, actorId: string): VoiceStagingConflict | undefined {
  const groups = Array.isArray(object(params.pacing).actorGroups) ? (object(params.pacing).actorGroups as unknown[]).map(object) : []
  const group = groups.find(value => value.id === actorId)
  const assets = [params.voiceAssets, params.characterVoices].flatMap(value => Array.isArray(value) ? value.map(object) : [])
  const name = String(group?.label ?? assets.find(value => value.characterId === actorId)?.characterName ?? actorId)
  const labels = String(params.audioText ?? '').split(/\r?\n/).flatMap(line => {
    const label = line.match(/^\s*([^：:]+)[：:]/)?.[1]?.trim()
    if (!label) return []
    const plain = label.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
    const sameActor = group ? resolveAnonymousGroupSpeaker(label, groups) === actorId : plain === name || plain === actorId
    return sameActor ? [label] : []
  })
  return labels.some(explicitlyOffscreenSpeaker) ? offscreenVoiceStagingConflict(params, actorId, name) : undefined
}

/** Anonymous speaker IDs are local storyboard references, never portrait names.
 * Only explicit off-screen dialogue can use an independent fixed voice without
 * inventing a visual character element or changing a visible performance. */
export function anonymousVoiceRoles(params: Record<string, unknown>): AnonymousVoiceRole[] {
  const pacing = object(params.pacing)
  const groups = Array.isArray(pacing.actorGroups) ? pacing.actorGroups.map(object) : []
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object) : []
  const roles: AnonymousVoiceRole[] = []
  for (const beat of beats.filter(beat => beat.kind === 'speech' && beat.deliveryStyle !== 'narration')) {
    if (!Array.isArray(beat.actorIds) || beat.actorIds.length !== 1) continue
    const id = String(beat.actorIds[0])
    const matches = groups.filter(group => group.id === id)
    if (!matches.length) continue
    const label = String(matches[0].label ?? '').trim()
    if (matches.length !== 1 || !label || label === '旁白' || groups.filter(group => group.label === label).length !== 1) throw Error('VOICE_IDENTITY_AMBIGUOUS: 匿名说话群体必须有唯一 ID 和真实角色名称，不能冒充旁白')
    if (roles.some(role => role.actorGroupId === id)) continue
    const source = String(params.voiceSceneId ?? params.dramaticSceneId ?? params.sourceSceneId ?? object(params.storyProgress).unitId ?? params.id ?? '').trim()
    if (!source || source.includes('${')) throw Error('VOICE_IDENTITY_AMBIGUOUS: 匿名角色声音缺少稳定的源场景身份')
    const lines = String(params.audioText ?? '').split(/\r?\n/).filter(line => line.trim())
    const spoken = lines.map(line => line.match(/^\s*([^：:]+)[：:]/)?.[1]?.trim())
    const ownLines = spoken.filter(speaker => speaker && resolveAnonymousGroupSpeaker(speaker, groups) === id)
    const declaredOffscreen = ownLines.length > 0 && ownLines.every(speaker => explicitlyOffscreenSpeaker(speaker!))
    const stagingConflict = declaredOffscreen ? speechStagingConflict(params, id) : undefined
    const offscreen = declaredOffscreen && !stagingConflict
    roles.push({ actorGroupId: id, name: label, continuityKey: `anonymous-voice:${encodeURIComponent(source)}:${encodeURIComponent(label)}`,
      description: String(matches[0].memberDescription ?? `源场景中的匿名角色：${label}`), offscreen,
      ...(matches[0].voiceProfile ? { voiceProfile: matches[0].voiceProfile as Record<string, unknown> | string } : {}),
      ...(stagingConflict ? { stagingConflict } : {}) })
  }
  return roles
}

/** An explicit manual-review request can retain group performances that have no
 * single-person fixed-voice representation. This is not a voice binding: names,
 * full lines and on/offscreen staging stay in the original provider inputs. */
export function nativeGroupVoicePlan(params: Record<string, unknown>): NativeGroupVoice[] {
  if (!isManualReview(params)) return []
  const roles = anonymousVoiceRoles(params)
  if (!roles.length) return []
  const named = ['characters', 'presentCharacters', 'initialCharacters', 'enteringCharacters', 'endCharacters']
    .flatMap(key => Array.isArray(params[key]) ? params[key] as unknown[] : [])
    .map(value => typeof value === 'string' ? value : String(object(value).name ?? object(value).characterName ?? ''))
  if (Array.isArray(params.voiceAssets)) named.push(...params.voiceAssets.filter(value => object(value).videoBinding).map(value => String(object(value).characterName ?? object(object(value).videoBinding).characterName ?? '')))
  if (roles.some(role => named.includes(role.name))) throw Error('VOICE_IDENTITY_AMBIGUOUS: 具名人物不能通过同名匿名群体绕过固定音色')
  const speakers = voiceSpeakers(params)
  const beats = (object(params.pacing).beats as unknown[]).map(object).filter(beat => beat.kind === 'speech')
  const collectivePerformance = beats.some(beat => /齐声|合唱|传唱|众口|异口同声|chorus|chant/i.test(String(beat.performanceInstruction ?? '') + String(beat.deliveryStyle ?? '')))
  if (roles.length === 1 && roles[0].offscreen && speakers.length === 1 && !collectivePerformance) return []
  if (params.audioType !== '对白' || speakers.includes('旁白')) throw Error('VOICE_PROVIDER_UNSUPPORTED: 原生群体对白需要完整对白声轨，不能替代旁白混音')
  const groups = new Map(roles.map(role => [role.actorGroupId, role.name]))
  if (beats.some(beat => {
    const id = Array.isArray(beat.actorIds) ? String(beat.actorIds[0]) : ''
    return !groups.has(id) && roles.some(role => role.name === id)
  })) throw Error('VOICE_IDENTITY_AMBIGUOUS: 同一说话人不能同时声明为具名人物和匿名群体')
  const normalized = (value: string) => value.replace(/[\p{P}\p{Z}\s]/gu, '')
  const spoken = String(params.audioText ?? '').split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*([^：:]+)[：:]([\s\S]+)$/)
    if (!match) throw Error('VOICE_IDENTITY_AMBIGUOUS: 原生群体对白缺少明确说话人或完整台词')
    return { name: match[1].replace(/（[^）]*）|\([^)]*\)/g, '').trim(), text: match[2] }
  })
  if (spoken.length !== beats.length || beats.some((beat, index) => {
    const id = Array.isArray(beat.actorIds) && beat.actorIds.length === 1 ? String(beat.actorIds[0]) : ''
    const text = String(beat.textOrVocalization ?? '')
    const matchesSpeaker = groups.has(id)
      ? resolveAnonymousGroupSpeaker(spoken[index]?.name ?? '', object(params.pacing).actorGroups) === id
      : spoken[index]?.name === id
    return !id || !text.trim() || !matchesSpeaker || normalized(spoken[index]?.text ?? '') !== normalized(text)
  })) throw Error('VOICE_IDENTITY_AMBIGUOUS: 原生群体对白与分镜声部不完整对应，不能忽略、换人或删除台词')
  return roles.map(role => ({ ...role, audioRole: 'native-group-dialogue', status: 'unbound', method: 'provider-native', qualityDisposition: 'manual-review-v1',
    speechVerified: false, lipSyncVerified: false,
    speechBeats: beats.filter(beat => (beat.actorIds as unknown[])[0] === role.actorGroupId)
      .map(beat => ({ id: String(beat.id ?? ''), text: String(beat.textOrVocalization), deliveryStyle: String(beat.deliveryStyle ?? 'dialogue') })) }))
}

/** Read only canonical shot inputs supplied by the active queue/loop sources.
 * Unresolved future templates are unknown, not invented speaker names. */
export function knownVoiceSpeakers(inputs: unknown[]): string[] {
  const names = new Set<string>()
  for (const input of inputs) {
    const row = object(input)
    const audioText = typeof row.audioText === 'string' && !row.audioText.includes('${') ? row.audioText : ''
    const beats = object(row.pacing).beats
    const resolvedBeats = Array.isArray(beats) ? beats.filter(value => {
      const beat = object(value)
      return !Array.isArray(beat.actorIds) || !beat.actorIds.some(id => typeof id === 'string' && id.includes('${'))
    }) : undefined
    const shot = { ...row, ...(typeof row.audioText === 'string' && row.audioText.includes('${') ? { audioType: undefined } : {}), audioText, pacing: { ...object(row.pacing), beats: resolvedBeats } }
    const anonymous = new Set(anonymousVoiceRoles(shot).map(role => role.name))
    for (const name of voiceSpeakers(shot)) if (!anonymous.has(name)) names.add(name)
  }
  return [...names]
}

/** Validate identity and turn order at the final voice boundary. Adjacent beats
 * from one speaker may be split for timing, so compare speaker turns rather
 * than word content or an arbitrary one-line/one-beat count. */
export function assertDialogueSpeakerBindings(params: Record<string, unknown>) {
  if (params.audioType !== '对白') return
  const pacing = object(params.pacing)
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(object).filter(beat => beat.kind === 'speech') : []
  if (!beats.length) return
  const groups = Array.isArray(pacing.actorGroups) ? pacing.actorGroups.map(object) : []
  const assets = [params.voiceAssets, params.characterVoices].flatMap(value => Array.isArray(value) ? value.map(object) : [])
  const speaker = (id: string) => String(groups.find(group => group.id === id)?.label ?? assets.find(asset => asset.characterId === id)?.characterName ?? id)
  const planned = beats.map((beat, index) => {
    if (beat.deliveryStyle === 'narration' || !Array.isArray(beat.actorIds) || beat.actorIds.length !== 1) throw Error(`VOICE_IDENTITY_AMBIGUOUS: 对白 pacing.beats[${index}] 缺少唯一原角色，不能混入旁白或多人身份`)
    return speaker(String(beat.actorIds[0]))
  })
  const lines = String(params.audioText ?? '').split(/\r?\n/).filter(line => line.trim())
  const spoken = lines.map((line, index) => {
    const match = line.match(/^\s*([^：:]+)[：:]\s*(.+)$/)
    if (!match || !match[2].trim()) throw Error(`VOICE_IDENTITY_AMBIGUOUS: audioText 第 ${index + 1} 行缺少明确说话人或对白正文；保留原文并修复声部身份`)
    const groupId = resolveAnonymousGroupSpeaker(match[1], groups)
    return groupId ? speaker(groupId) : speaker(match[1].replace(/（[^）]*）|\([^)]*\)/g, '').trim())
  })
  const turns = (names: string[]) => names.filter((name, index) => index === 0 || name !== names[index - 1])
  if (JSON.stringify(turns(planned)) !== JSON.stringify(turns(spoken))) throw Error(`VOICE_IDENTITY_AMBIGUOUS: audioText 与 pacing.speech 的说话人或轮次不一致；audioText=${JSON.stringify(turns(spoken))}；pacing=${JSON.stringify(turns(planned))}。保留全部原台词，逐句修复 actorIds 与原说话人对应关系，不能漏绑、串角或改成旁白。`)
}

/** Actor names are legacy labels. Resolve once, then retain stable identities. */
export function voiceSpeakers(params: Record<string, unknown>): string[] {
  assertDialogueSpeakerBindings(params)
  const beats = object(params.pacing).beats
  const groups = object(params.pacing).actorGroups
  const names: string[] = []
  if (Array.isArray(beats)) {
    for (const value of beats) {
      const beat = object(value)
      if (!['speech', 'vocalization'].includes(String(beat.kind))) continue
      if (beat.kind === 'vocalization') continue // Group/nonlexical audio stays in the original sound contract.
      if (beat.deliveryStyle === 'narration') { names.push('旁白'); continue }
      if (!Array.isArray(beat.actorIds) || beat.actorIds.length !== 1) throw Error('VOICE_IDENTITY_AMBIGUOUS: 有词声部必须有唯一说话人；合唱尚未验证')
      const id = String(beat.actorIds[0])
      const matches = Array.isArray(groups) ? groups.map(object).filter(group => group.id === id) : []
      if (matches.length > 1 || matches.length === 1 && !String(matches[0].label ?? '').trim()) throw Error('VOICE_IDENTITY_AMBIGUOUS: 匿名说话群体缺少唯一真实名称')
      names.push(matches.length ? String(matches[0].label).trim() : id)
    }
  }
  if (!names.length && String(params.audioText ?? '').trim()) {
    if (params.audioType === '旁白') names.push('旁白')
    else for (const line of String(params.audioText).split('\n').filter(line => line.trim())) {
      const match = line.match(/^\s*([^：:]+)[：:]/)
      if (!match) throw Error('VOICE_IDENTITY_AMBIGUOUS: 台词缺少明确说话人')
      names.push(match[1].replace(/（[^）]*）|\([^)]*\)/g, '').trim())
    }
  }
  return [...new Set(names)]
}

export function resolveShotVoices(manifest: VoiceManifest, names: string[]): CharacterVoice[] {
  return names.map(name => {
    const matches = manifest.characters.filter(v => v.characterName === name || v.characterId === name)
    if (matches.length !== 1) throw Error(`${matches.length ? 'VOICE_IDENTITY_AMBIGUOUS' : 'VOICE_BINDING_MISSING'}: ${name}`)
    if (!matches[0].voiceId || !matches[0].version) throw Error(`VOICE_BINDING_MISSING: ${name} 尚未确认音色`)
    return matches[0]
  })
}

/** Called after visual reference compilation, so neither compiler can discard the other. */
export function compileKlingVoices(prompt: string, params: Record<string, unknown>, modelName: string, omni: boolean) {
  assertDialogueSpeakerBindings(params)
  if (params.nativeGroupVoices !== undefined) {
    const groups = nativeGroupVoicePlan(params)
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value
    if (!groups.length || JSON.stringify(canonical(params.nativeGroupVoices)) !== JSON.stringify(canonical(groups))) throw Error('VOICE_BINDING_INVALID: 原生群体声部必须来自明确人工复核策略和完整原台词')
    if (params.sound !== 'on' || !/^kling-v3(?:$|-)/.test(modelName)) throw Error('VOICE_PROVIDER_UNSUPPORTED: 原生群体对白需要开启 Kling 3 原生声音')
    prompt += `\n【群体原声】${groups.map(group => group.name).join('、')}按原台词、顺序及群体表演由原生声音演绎，不套用具名人物的单人音色，不改变画内或画外安排。`
    const conflicts = groups.filter(group => group.stagingConflict)
    if (conflicts.length) prompt += `\n【画内同期声优先】${conflicts.map(group => group.name).join('、')}的原始“画外”标签与本人可见说话义务冲突；本次按该演员的已声明可见表演生成全部同期对白和匹配口型，不删除台词或把声音交给其他人物。`
  }
  const raw = params.characterVoices
  if (raw === undefined) return { prompt, fields: {} as Record<string, unknown> }
  if (!Array.isArray(raw)) throw Error('VOICE_BINDING_INVALID: 人物声音映射必须为数组')
  const voices = raw as CharacterVoice[]
  if (!voices.length) return { prompt, fields: {} as Record<string, unknown> }
  const standaloneVoice = modelName === 'kling-v2-6' && !omni
  if (!standaloneVoice && !/^kling-v3(?:$|-)/.test(modelName)) throw Error('VOICE_PROVIDER_UNSUPPORTED: 当前视频模型未验证固定音色能力')
  if (params.sound !== 'on') throw Error('VOICE_PROVIDER_UNSUPPORTED: 绑定声音需要开启原生声音')
  if (params.multi_shot === true || params.multiShot === true) throw Error('VOICE_PROVIDER_UNSUPPORTED: 人物音色暂不支持供应商自动多镜头，请逐分镜执行')
  if (voices.some(v => !v.characterId || !v.characterName || !v.voiceId || !Number.isInteger(v.version))) throw Error('VOICE_BINDING_INVALID: 人物声音版本不完整')
  if (new Set(voices.map(v => v.characterId)).size !== voices.length) throw Error('VOICE_IDENTITY_AMBIGUOUS: 人物声音重复绑定')
  if (standaloneVoice) {
    if (!(params.referenceImage ?? params.image) || params.mode !== 'pro' || ![5, 10].includes(Number(params.duration)) || params.endImage || params.imageTail || params.image_tail) throw Error('VOICE_PROVIDER_UNSUPPORTED: Kling 2.6 固定音色要求首帧图生视频、pro 1080P、5 或 10 秒，不能搭配尾帧')
    if (voices.length > 2) throw Error('VOICE_PROVIDER_UNSUPPORTED: 每个镜头最多绑定两种独立音色')
    return { prompt: `${prompt}\n【人物声音绑定】${voices.map((v, i) => `${v.characterName}使用<<<voice_${i + 1}>>>演绎本人全部台词${v.characterName === '旁白' ? '，仅作为画外声音，不得让画内人物开口或新增旁白人物' : ''}`).join('；')}。保留各句原文、顺序和表演情绪，不得串角。`, fields: { voice_list: voices.map(v => ({ voice_id: v.voiceId })) } as Record<string, unknown> }
  }
  if (omni) {
    if (voices.some(v => v.characterName === '旁白')) throw Error('VOICE_PROVIDER_UNSUPPORTED: 画外旁白的固定音色路径尚未验证，不能将旁白作为画内人物主体发送；需接入独立配音或验证专用旁白接口')
    if (voices.some(v => !v.elementId || !/^\d+$/.test(v.elementId))) throw Error('VOICE_ELEMENT_MISSING: Omni 需要已绑定音色的人物主体，请在人物库完成绑定')
    const references = Array.isArray(params.referenceImages) ? new Set(params.referenceImages).size : 0
    const hasFirst = Boolean(params.referenceImage ?? params.image)
    if (voices.length + references > 7 || (hasFirst && voices.length > 3)) throw Error('VOICE_PROVIDER_UNSUPPORTED: 人物主体与图片参考超出 Omni 容量，需要调整分镜参考')
    return { prompt: `${prompt}\n【人物声音绑定】${voices.map((v, i) => `${v.characterName}对应<<<element_${i + 1}>>>，使用该主体绑定的声音演绎本人全部台词`).join('；')}。保留各句原文、顺序和表演情绪，不得串角。`,
      fields: { element_list: voices.map(v => ({ element_id: v.elementId })) } as Record<string, unknown> }
  }
  // The v3 documentation lists a shared voice_list field, but its capability
  // matrix limits standalone voice control to v2.6 image-to-video (1080p).
  // The current v3 endpoint also rejected this exact path with code 1201.
  throw Error('VOICE_PROVIDER_UNSUPPORTED: Kling 3 标准图/文生视频不支持独立 voice_list 音色控制；请使用已验证的 Omni 人物主体绑定路径，不能仅开启 sound 代替固定音色')
}
