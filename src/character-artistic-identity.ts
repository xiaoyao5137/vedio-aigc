/** A person's current artistic identity is independent of any episode's age,
 * costume and location. It is an art direction, never historical evidence. */
export type CharacterArtisticIdentity = {
  version: 'character-artistic-identity-v1'
  active: true
  face: string
  complexion?: string
  frame?: string
}

const ageOrCostume = /(?:\d{1,4}\s*(?:岁|年)|[一二三四五六七八九十百]+岁|少年|青年|壮年|老年|幼年|白发|黑发|白须|黑须|胡须|髭|发式|发型|束发|长坂|当阳|江州|建安|战袍|长袍|披风|甲胄|衣袍|冠帽|发髻|靴子|腰带)/u

export function normalizeCharacterArtisticIdentity(value: unknown): CharacterArtisticIdentity | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('CHARACTER_ARTISTIC_IDENTITY_INVALID: 身份审美必须是对象')
  const source = value as Record<string, unknown>
  if (source.version !== 'character-artistic-identity-v1' || source.active !== true
    || Object.keys(source).some(key => !['version', 'active', 'face', 'complexion', 'frame'].includes(key))) {
    throw Error('CHARACTER_ARTISTIC_IDENTITY_INVALID: 仅支持当前选用的脸部、肤色与骨架设计')
  }
  const trait = (input: unknown, name: string, required: boolean): string | undefined => {
    if ((input === undefined || input === null || input === '') && !required) return undefined
    if (typeof input !== 'string' || !input.trim() || input.trim().length > 160 || ageOrCostume.test(input)) {
      throw Error(`CHARACTER_ARTISTIC_IDENTITY_INVALID: ${name} 只写跨年龄稳定特征，不写年龄、须发颜色、服装或剧情场景`)
    }
    return input.trim()
  }
  const face = trait(source.face, 'face', true) as string
  const complexion = trait(source.complexion, 'complexion', false)
  const frame = trait(source.frame, 'frame', false)
  return { version: 'character-artistic-identity-v1', active: true, face,
    ...(complexion ? { complexion } : {}), ...(frame ? { frame } : {}) }
}

export function characterArtisticIdentityFrom(value: unknown): CharacterArtisticIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const asset = value as Record<string, unknown>
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {}
  return normalizeCharacterArtisticIdentity(asset.artisticIdentity ?? metadata.artisticIdentity)
}

export function characterArtisticIdentityDesignText(identity: CharacterArtisticIdentity | undefined): string {
  if (!identity) return ''
  return ['【同一人物的艺术身份，不是史料容貌】', `脸部骨相与气质：${identity.face}。`,
    identity.complexion ? `肤色基调：${identity.complexion}。` : '',
    identity.frame ? `骨架轮廓：${identity.frame}。` : '',
    '仅保留跨年龄可辨的脸部身份和审美方向；当前年龄、须发、体态变化与衣装服从本场 visualContext。'].filter(Boolean).join('\n')
}
