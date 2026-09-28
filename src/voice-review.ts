import type { CharacterVoice, NativeGroupVoice } from './character-voice.ts'

export type VoiceReviewTarget = { videoUrl: string; characters: CharacterVoice[]; nativeGroupVoices?: NativeGroupVoice[] }
export type VoiceListeningReview = { status: 'passed' | 'failed' | 'uncertain'; note: string; reviewedAt: string; method: 'user-listening' }
export type AutomaticVoiceBindingReview = {
  status: 'passed'
  note: string
  method: 'automatic-binding-fallback'
  automated: true
  recognitionCapability: 'unavailable'
  evidence: {
    videoUrl: string
    characters: Array<Pick<CharacterVoice, 'characterId' | 'voiceId' | 'version' | 'accountScope' | 'elementId'>>
  }
  priorReview?: VoiceListeningReview
}
export type ManualGroupVoiceReview = {
  status: 'uncertain'; method: 'manual-review-pending'; qualityDisposition: 'manual-review-v1'
  note: string; recognitionCapability: 'unavailable'; speechVerified: false; lipSyncVerified: false
  evidence: VoiceReviewTarget; priorReview?: VoiceListeningReview
}
export type VoiceGateDecision = VoiceListeningReview | AutomaticVoiceBindingReview | ManualGroupVoiceReview
export function voiceReviewTarget(output: unknown): VoiceReviewTarget | null {
  let row = output as Record<string, unknown> | undefined
  const seen = new Set<unknown>()
  while (row && typeof row === 'object' && !seen.has(row)) {
    seen.add(row)
    const raw = row.raw && typeof row.raw === 'object' ? row.raw as Record<string, unknown> : undefined
    const groups = row.nativeGroupVoices ?? raw?.nativeGroupVoices
    if (typeof row.url === 'string' && (Array.isArray(row.characterVoices) && row.characterVoices.length || Array.isArray(groups) && groups.length)) return {
      videoUrl: typeof row.originalUrl === 'string' ? row.originalUrl : row.url,
      characters: Array.isArray(row.characterVoices) ? row.characterVoices as CharacterVoice[] : [],
      ...(Array.isArray(groups) && groups.length ? { nativeGroupVoices: groups as NativeGroupVoice[] } : {}),
    }
    row = row.raw as Record<string, unknown> | undefined
  }
  return null
}

/** Resolve the media behind a review gate. A failed concat node has no media
 * output of its own, so its accepted `currentVideo` input must remain
 * reviewable without making the user navigate back to a different node. */
export function voiceReviewSource(...candidates: unknown[]): unknown | null {
  return candidates.find(candidate => voiceReviewTarget(candidate) !== null) ?? null
}

export function voiceReviewIdentity(target: VoiceReviewTarget) {
  if (!target || typeof target.videoUrl !== 'string' || !(/^(?:https?:\/\/|\/generated\/[\w.-]+\.mp4$)/.test(target.videoUrl)) || !Array.isArray(target.characters) || !target.characters.length && !target.nativeGroupVoices?.length) throw Error('VOICE_REVIEW_INVALID: 缺少实际视频或音色版本')
  if (target.nativeGroupVoices && (!Array.isArray(target.nativeGroupVoices) || target.nativeGroupVoices.some(group =>
    !group || group.qualityDisposition !== 'manual-review-v1' || group.audioRole !== 'native-group-dialogue' || group.status !== 'unbound'
    || group.method !== 'provider-native' || !group.continuityKey?.startsWith('anonymous-voice:') || !group.actorGroupId || !group.name
    || group.speechVerified !== false || group.lipSyncVerified !== false || !Array.isArray(group.speechBeats) || !group.speechBeats.length
    || group.speechBeats.some(beat => !beat.text?.trim())))) throw Error('VOICE_REVIEW_INVALID: 原生群体声音缺少明确人工复核身份和原台词')
  const characters = target.characters.map(v => {
    if (!v.characterId || !v.voiceId || !Number.isInteger(v.version) || v.version < 1 || !v.accountScope) throw Error('VOICE_REVIEW_INVALID: 人物音色版本不完整')
    return { characterId: v.characterId, voiceId: v.voiceId, version: v.version, accountScope: v.accountScope, elementId: v.elementId ?? '' }
  }).sort((a,b) => a.characterId.localeCompare(b.characterId))
  return JSON.stringify({ videoUrl: target.videoUrl, characters,
    ...(target.nativeGroupVoices?.length ? { nativeGroupVoices: [...target.nativeGroupVoices].sort((a,b) => a.continuityKey.localeCompare(b.continuityKey)) } : {}) })
}

/**
 * A listening review is optional until an automatic speaker-recognition
 * capability exists. The fallback proves that the rendered clip still carries
 * the locked character/voice/version/provider binding; it deliberately does
 * not claim that anybody (or any model) listened to the result.
 */
export function resolveVoiceGateDecision(target: VoiceReviewTarget, review: VoiceListeningReview | null): VoiceGateDecision {
  voiceReviewIdentity(target)
  if (review?.status === 'failed') throw Error('VOICE_REVIEW_REJECTED: 本镜已有音色不一致结论，禁止自动放行')
  if (review?.status === 'passed') return review
  if (target.nativeGroupVoices?.length) return {
    status: 'uncertain', method: 'manual-review-pending', qualityDisposition: 'manual-review-v1', recognitionCapability: 'unavailable',
    speechVerified: false, lipSyncVerified: false,
    note: `群体${target.nativeGroupVoices.map(group => group.name).join('、')}由供应商原生声音生成，未锁定音色、未听审；原台词和画内或画外安排保持不变，交由用户复核。`,
    evidence: target, ...(review ? { priorReview: review } : {}),
  }
  return {
    status: 'passed',
    method: 'automatic-binding-fallback',
    automated: true,
    recognitionCapability: 'unavailable',
    note: '当前未配置自动声纹识别；已基于锁定的人物、音色、版本、账户与供应商主体自动放行，未声称完成人工听审或听觉识别。',
    evidence: {
      videoUrl: target.videoUrl,
      characters: target.characters.map(character => ({
        characterId: character.characterId,
        voiceId: character.voiceId,
        version: character.version,
        accountScope: character.accountScope,
        elementId: character.elementId,
      })),
    },
    ...(review ? { priorReview: review } : {}),
  }
}
