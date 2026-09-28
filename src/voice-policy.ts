export type VoicePolicy = 'strict' | 'preview'

export function newExecutionVoicePolicy(value: unknown): VoicePolicy {
  if (value === undefined || value === null) return 'strict'
  if (value === 'strict' || value === 'preview') return value
  throw Error('VOICE_BINDING_INVALID: 声音策略无效，不能自动降级为预览')
}

export function voicePolicyLabel(value: VoicePolicy | undefined) {
  return value === 'strict' ? '人物音色锁定 · 成片待听审' : value === 'preview' ? '预览声音策略 · 音色未锁定' : '历史声音策略 · 音色未锁定'
}
