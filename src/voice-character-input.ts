import { anonymousVoiceRoles, nativeGroupVoicePlan, voiceSpeakers } from './character-voice.ts'

export type VoiceCharacterInput = { name: string; continuityKey: string; voiceContinuityKey?: string; description?: string; voiceProfile?: Record<string, unknown> | string; audioRole?: 'offscreen-dialogue'; actorGroupId?: string }

const visualAgeForCasting: Record<string, string> = {
  child: '儿童感', adolescent: '少年感', young_adult: '青年感',
  adult: '成年感', mature: '成熟成年感', elderly: '年长感',
}

/** Reuse the approved character performance direction as an artistic casting
 * input for the first spoken line. A visual age stage may constrain age feel,
 * but neither age nor voice sex is inferred from a name, costume, or history.
 * Existing voice assets are still recalled before this profile can be used. */
export function withApprovedVoiceCasting<T extends { name?: unknown; voiceProfile?: unknown; visualContext?: unknown }>(
  characters: T[], shot: Record<string, unknown>, approvedOutline: unknown,
): T[] {
  const speakers = new Set(voiceSpeakers(shot))
  const outline = approvedOutline && typeof approvedOutline === 'object' && !Array.isArray(approvedOutline)
    ? approvedOutline as Record<string, unknown> : {}
  const dramas = Array.isArray(outline.characterDramas) ? outline.characterDramas.filter(value => value && typeof value === 'object' && !Array.isArray(value)) as Record<string, unknown>[] : []
  return characters.map(character => {
    const name = typeof character.name === 'string' ? character.name.trim() : ''
    if (!name || !speakers.has(name) || character.voiceProfile !== undefined) return character
    const matches = dramas.filter(row => row.name === name)
    if (matches.length > 1) throw Error(`VOICE_CASTING_DIRECTION_INVALID: 已批准大纲中 ${name} 的人物表演方向不唯一`)
    const style = typeof matches[0]?.speechStyle === 'string' ? matches[0].speechStyle.trim() : ''
    if (!style) return character // Preserve the first-create guard if casting has no evidence.
    const visualContext = character.visualContext && typeof character.visualContext === 'object' && !Array.isArray(character.visualContext)
      ? character.visualContext as Record<string, unknown> : {}
    const age = visualContext.age && typeof visualContext.age === 'object' && !Array.isArray(visualContext.age)
      ? visualContext.age as Record<string, unknown> : {}
    const ageFeel = typeof age.stage === 'string' ? visualAgeForCasting[age.stage] : undefined
    return { ...character, voiceProfile: {
      ...(ageFeel ? { age: `${ageFeel}（本作已批准的人物选角设定，不代表史实岁数）` } : {}),
      delivery: `沿用已批准的人物表演方式：${style}`,
    } } as T
  })
}

/** Compile casting information, not the instruction to invent that information.
 * No gender or preset is inferred from a role name. An intentional neutral or
 * nongendered voice profile is just as valid as any other explicit profile. */
export function characterVoiceDesignDescription(character: { name?: string; characterName?: string; description?: string; voiceProfile?: unknown }, prompt: string, options: { description?: unknown; voiceProfile?: unknown } = {}) {
  const name = String(character.name ?? character.characterName ?? '').trim()
  const override = typeof options.description === 'string' ? options.description.trim() : ''
  if (override) return override
  const profile = options.voiceProfile ?? character.voiceProfile
  let profileText = ''
  let hasCastingProfile = false
  if (typeof profile === 'string') {
    profileText = profile.trim()
    hasCastingProfile = Boolean(profileText)
  }
  else if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    const fields: Record<string, string> = { description: '声音描述', age: '年龄感', pitch: '音高', resonance: '共鸣', texture: '质感', delivery: '说话气质', genderPresentation: '声音性别表现', language: '语言' }
    profileText = Object.entries(fields).flatMap(([key, label]) => {
      const value = (profile as Record<string, unknown>)[key]
      // Language controls pronunciation; it does not choose a voice identity.
      if (key !== 'language' && typeof value === 'string' && value.trim()) hasCastingProfile = true
      return typeof value === 'string' && value.trim() ? [`${label}：${value.trim()}`] : []
    }).join('；')
  }
  const description = String(character.description ?? '').trim()
  const describedVoice = /男(?:性|子|人|声|孩)|女(?:性|子|人|声|孩)|[少青中老]年|儿童|幼童|童声|妇人|老翁|老妪|年迈|稚嫩|低沉|低音|中低|中高|高音|沙哑|浑厚|醇厚|清亮|清脆|轻柔|柔和|温润|温和|温暖|粗犷|粗哑|沉稳|厚重|尖细|冷冽|嘶哑|中性|雌雄莫辨|鼻音|气声|磁性|坚定|内敛|爽朗|克制|\b(?:male|female|child|elderly|young|baritone|bass|tenor|alto|soprano|androgynous|husky)\b/i.test(description)
  if (!hasCastingProfile && !describedVoice) throw Error(`VOICE_PROFILE_REQUIRED: ${name || '此角色'} 的资料只有身份、服饰、动作或语言，尚未提供可执行声线。请从真实角色资料补充 voiceProfile（如年龄感、音高、共鸣、质感或说话气质）或 voiceDescriptions；可以明确选择中性声线，不要求男/女标签。保留原台词与已有音色，不根据角色名随机创建声音。`)
  return [prompt.trim(), `人物：${name}。`, description ? `人物资料：${description}` : '', profileText ? `已确定的角色声线：${profileText}` : '',
    '声音必须遵循上述已确定资料，不从角色称谓、服饰或情节自行推断不同的年龄或声音性别表现。'].filter(Boolean).join('\n')
}

/** A named actor's voice is a casting decision, not a portrait revision. */
export function stableVoiceContinuityKey(character: VoiceCharacterInput): string {
  if (character.name === '旁白') return '__narrator__'
  if (character.voiceContinuityKey?.trim()) return character.voiceContinuityKey.trim()
  if (character.continuityKey.startsWith('anonymous-voice:')) return character.continuityKey
  if (/(?:病患|百姓|村民|乡人|官员|士兵|侍卫|仆从|弟子|信徒|使者|求评者|老者|妇人|孩童|农夫|路人|众人)[甲乙丙丁一二三四五六七八九十0-9]*$/.test(character.name)) return character.continuityKey
  return `voice:${character.name}`
}

export function voiceCandidateOutput(value: unknown): Record<string, unknown> & { items: Record<string, unknown>[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('VOICE_CANDIDATE_INVALID: 音色创建没有返回候选对象')
  const body = value as Record<string, unknown>
  if (!Array.isArray(body.items) || body.items.some(item => !item || item.contract !== 'voice-candidate-v2' || !item.voiceId || !item.continuityKey)) throw Error('VOICE_CANDIDATE_INVALID: 音色候选列表缺少稳定声音身份')
  return body as Record<string, unknown> & { items: Record<string, unknown>[] }
}

/** Voice-only roles never become portrait requests. Their identity belongs to the workflow. */
export function voiceCharacterInputs(characters: VoiceCharacterInput[], shot: Record<string, unknown>, options: { qualityDisposition?: unknown } = {}): VoiceCharacterInput[] {
  const speakers = voiceSpeakers(shot)
  const anonymous = anonymousVoiceRoles(shot)
  const nativeGroups = nativeGroupVoicePlan({ ...shot, qualityDisposition: options.qualityDisposition ?? shot.qualityDisposition })
  if (anonymous.some(role => characters.some(character => character.name === role.name))) throw Error('VOICE_IDENTITY_AMBIGUOUS: 同一说话人不能同时声明为具名人物和匿名群体')
  if (!nativeGroups.length && anonymous.length && (anonymous.length !== 1 || speakers.length !== 1 || speakers[0] !== anonymous[0].name)) throw Error('VOICE_PROVIDER_UNSUPPORTED: 匿名画外角色与其他有词声部混合尚未支持，请保留原文并拆分声部，禁止改为旁白')
  const result = characters
    .filter(character => character.name !== '旁白' && speakers.includes(character.name))
    .map(character => ({ ...character, continuityKey: stableVoiceContinuityKey(character) }))
  for (const role of nativeGroups.length ? [] : anonymous) {
    if (role.stagingConflict) throw Error(`${role.stagingConflict.code}: ${role.stagingConflict.reason}`)
    if (!role.offscreen) throw Error(`VOICE_PROVIDER_UNSUPPORTED: 匿名角色“${role.name}”的画内固定音色缺少真实人物主体；请保留原镜，另行生成明确画外角色对白或提供可绑定的真实人物资产，禁止自动改为旁白`)
    if (result.some(character => character.name === role.name)) throw Error(`VOICE_IDENTITY_AMBIGUOUS: ${role.name} 同时声明为具名人物和匿名群体`)
    result.push({ name: role.name, continuityKey: role.continuityKey, description: role.description,
      ...(role.voiceProfile ? { voiceProfile: role.voiceProfile } : {}),
      audioRole: 'offscreen-dialogue', actorGroupId: role.actorGroupId })
  }
  if (speakers.includes('旁白')) result.push({
    name: '旁白', continuityKey: '__narrator__',
    description: '画外历史叙事者，中年男性，音高中低，温润沉稳，吐字清晰自然，克制而有叙事感；独立于画面人物，不模仿具体演员。',
  })
  return result
}
