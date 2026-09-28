/** A visual variant belongs to an actor, a life stage and a stable costume occasion.
 * Dates and source notes explain the design; they do not create a new asset for
 * each shot or change that actor's independently archived voice identity. */
import { normalizeCharacterArtisticIdentity } from './character-artistic-identity.ts'
export type CharacterAgeStage = 'child' | 'adolescent' | 'young_adult' | 'adult' | 'mature' | 'elderly' | 'unknown'
export type CharacterAgeBasis = 'documented' | 'estimated' | 'artistic' | 'unknown'
export type CharacterVisualContext = {
  version: 'character-visual-context-v1'
  age: { stage: CharacterAgeStage; basis: CharacterAgeBasis; years?: { min: number; max: number }; asOf?: string; sourceRefs?: string[] }
  look: { key: string; description: string }
  appearanceConstraints?: { hair?: 'dark' | 'graying' | 'white' | 'unknown'; facialHair?: 'dark' | 'graying' | 'white' | 'none' | 'unknown'; build?: string }
}

/** Kept self-contained so the same validation can be embedded in persisted code
 * nodes. Missing legacy metadata is allowed; malformed explicit metadata is not. */
export function normalizeCharacterVisualContext(value: unknown): CharacterVisualContext | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const row = (input: unknown, label: string): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error(`CHARACTER_VISUAL_CONTEXT_INVALID: ${label} 必须是对象`)
    return input as Record<string, unknown>
  }
  const text = (input: unknown, label: string, maximum = 500): string => {
    if (typeof input !== 'string' || !input.trim() || input.trim().length > maximum) throw Error(`CHARACTER_VISUAL_CONTEXT_INVALID: ${label} 必须为1至${maximum}字的文字`)
    return input.trim()
  }
  const source = row(value, 'visualContext')
  if (source.version !== 'character-visual-context-v1') throw Error('CHARACTER_VISUAL_CONTEXT_INVALID: 不支持的visualContext版本')
  const age = row(source.age, 'age'), look = row(source.look, 'look')
  const stages = ['child', 'adolescent', 'young_adult', 'adult', 'mature', 'elderly', 'unknown']
  const bases = ['documented', 'estimated', 'artistic', 'unknown']
  if (!stages.includes(String(age.stage)) || !bases.includes(String(age.basis))) throw Error('CHARACTER_VISUAL_CONTEXT_INVALID: 年龄阶段或证据类型无效')
  if (age.basis === 'unknown' && (age.stage !== 'unknown' || age.years !== undefined)) throw Error('CHARACTER_VISUAL_CONTEXT_INVALID: 未知年龄不能同时声称确定阶段或岁数')
  const normalized: CharacterVisualContext = { version: 'character-visual-context-v1',
    age: { stage: age.stage as CharacterAgeStage, basis: age.basis as CharacterAgeBasis },
    look: { key: text(look.key, 'look.key', 120), description: text(look.description, 'look.description') } }
  if (age.years !== undefined) {
    const years = row(age.years, 'age.years'), min = years.min, max = years.max
    if (!Number.isInteger(min) || !Number.isInteger(max) || Number(min) < 0 || Number(max) > 120 || Number(min) > Number(max)) throw Error('CHARACTER_VISUAL_CONTEXT_INVALID: 年龄范围必须是0至120的有效整数区间')
    normalized.age.years = { min: Number(min), max: Number(max) }
  }
  if (age.asOf !== undefined && age.asOf !== '') normalized.age.asOf = text(age.asOf, 'age.asOf', 120)
  if (age.sourceRefs !== undefined) {
    if (!Array.isArray(age.sourceRefs) || age.sourceRefs.some(reference => typeof reference !== 'string' || !reference.trim()) || age.sourceRefs.length > 20) throw Error('CHARACTER_VISUAL_CONTEXT_INVALID: 年龄来源必须是有效引用数组')
    normalized.age.sourceRefs = [...new Set(age.sourceRefs.map(reference => String(reference).trim()))]
  }
  if ((age.basis === 'documented' || age.basis === 'estimated') && !normalized.age.sourceRefs?.length) throw Error('CHARACTER_VISUAL_CONTEXT_INVALID: 确证或估计年龄必须保留依据引用，不可用人物名推定生年；无依据的视觉年龄应标为artistic')
  if (source.appearanceConstraints !== undefined) {
    const appearance = row(source.appearanceConstraints, 'appearanceConstraints')
    const constraints: NonNullable<CharacterVisualContext['appearanceConstraints']> = {}
    for (const key of ['hair', 'facialHair'] as const) if (appearance[key] !== undefined) {
      const allowed = key === 'hair' ? ['dark', 'graying', 'white', 'unknown'] : ['dark', 'graying', 'white', 'none', 'unknown']
      if (!allowed.includes(String(appearance[key]))) throw Error(`CHARACTER_VISUAL_CONTEXT_INVALID: ${key} 无效`)
      if (key === 'hair') constraints.hair = appearance[key] as typeof constraints.hair
      else constraints.facialHair = appearance[key] as typeof constraints.facialHair
    }
    if (appearance.build !== undefined && appearance.build !== '') constraints.build = text(appearance.build, 'appearanceConstraints.build', 200)
    if (Object.keys(constraints).length) normalized.appearanceConstraints = constraints
  }
  return normalized
}

export function characterVisualContextFrom(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const metadata = source.metadata && typeof source.metadata === 'object' ? source.metadata as Record<string, unknown> : {}
  return normalizeCharacterVisualContext(source.visualContext ?? metadata.visualContext)
}

/** Only stable, visible requirements affect cache identity. No birth year is
 * inferred, and a changed event date alone does not force a new costume sheet. */
export function characterVisualContextSignature(context: CharacterVisualContext) {
  return JSON.stringify({ stage: context.age.stage, years: context.age.years ?? null,
    look: context.look, appearanceConstraints: context.appearanceConstraints ?? {} })
}

export function characterVisualContextDesignText(context: CharacterVisualContext | undefined) {
  if (!context) return ''
  const stages: Record<CharacterAgeStage, string> = { child: '儿童', adolescent: '少年', young_adult: '青年成年人', adult: '成年', mature: '成熟壮年', elderly: '老年', unknown: '年龄未知，不擅自推定' }
  const bases: Record<CharacterAgeBasis, string> = { documented: '有来源确证', estimated: '依据剧情时代估计，并非确切生年', artistic: '艺术年龄设定，并非史实年龄复原', unknown: '史料与设计均未确定' }
  const hair = { dark: '深色，不得出现白色或花白', graying: '花白', white: '白色', none: '不留胡须', unknown: '未确定' }
  const constraints = context.appearanceConstraints ?? {}
  const sentence = (value: string) => /[。！？!?；;]$/.test(value.trim()) ? value.trim() : `${value.trim()}。`
  return [sentence(`【剧情当时人物阶段】${stages[context.age.stage]}；${bases[context.age.basis]}${context.age.years ? `；视觉年龄范围${context.age.years.min}至${context.age.years.max}岁` : ''}${context.age.asOf ? `；剧情时间${context.age.asOf}` : ''}`),
    `${sentence(`【稳定场景造型】${context.look.key}：${context.look.description}`)}只提取服饰与稳定造型，不在三视图复现场景或剧情动作。`,
    constraints.hair && constraints.hair !== 'unknown' ? `头发：${hair[constraints.hair]}。` : '',
    constraints.facialHair && constraints.facialHair !== 'unknown' ? `面部胡须：${hair[constraints.facialHair]}。` : '',
    constraints.build ? sentence(`体型：${constraints.build}`) : '',
  ].filter(Boolean).join('\n')
}

/** Optional provenance on an archived three-view limits automatic recall to
 * the episode(s) for which its age and campaign look were approved. An explicit
 * user selection may still choose that sheet elsewhere; the caller controls
 * whether to apply this automatic-recall filter. */
export function characterAssetEpisodeScopeMatches(asset: Record<string, unknown>, episodeNumber: unknown): boolean {
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {}
  if (metadata.episodeScope === undefined) return true
  const scope = metadata.episodeScope
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false
  const episodes = (scope as Record<string, unknown>).episodes
  const active = Number(episodeNumber)
  return Array.isArray(episodes) && episodes.length > 0
    && episodes.every(value => Number.isSafeInteger(value) && value > 0)
    && Number.isSafeInteger(active) && episodes.includes(active)
}

/** New episode-bound sheets must carry their origin into the archive. The
 * stable look key still decides whether a costume can be reused within that
 * episode; this scope prevents that look from being offered to later episodes. */
export function generatedCharacterEpisodeScope(workflowId: string, episodeNumber: unknown): { episodes: number[] } | undefined {
  if (episodeNumber === undefined || episodeNumber === null || episodeNumber === '') {
    if (workflowId === 'wf-sanguo-history-drama') throw Error('CHARACTER_EPISODE_SCOPE_MISSING: 三国新三视图缺少当前集数，禁止生成或归档为全剧通用造型')
    return undefined
  }
  const episode = typeof episodeNumber === 'number' ? episodeNumber
    : typeof episodeNumber === 'string' && /^\d+$/.test(episodeNumber.trim()) ? Number(episodeNumber.trim()) : NaN
  if (!Number.isSafeInteger(episode) || episode < 1) throw Error('CHARACTER_EPISODE_SCOPE_INVALID: 新三视图的集数必须是正整数')
  return { episodes: [episode] }
}

export function characterVisualContextCompatibility(requested: CharacterVisualContext | undefined, asset: Record<string, unknown>) {
  if (!requested) return { matches: true, reason: '' }
  let stored: CharacterVisualContext | undefined
  try { stored = characterVisualContextFrom(asset) } catch { return { matches: false, reason: 'CHARACTER_VISUAL_CONTEXT_MISMATCH: 已归档年龄/造型资料无效' } }
  if (!stored) return { matches: false, reason: 'CHARACTER_VISUAL_CONTEXT_MISSING: 旧资产没有年龄与场景造型标注，不能自动匹配明确的新要求' }
  if (requested.age.stage !== 'unknown' && requested.age.stage !== stored.age.stage) return { matches: false, reason: 'CHARACTER_VISUAL_CONTEXT_MISMATCH: 资产年龄阶段与剧情当时要求不符' }
  if (requested.age.years && (!stored.age.years || stored.age.years.max < requested.age.years.min || stored.age.years.min > requested.age.years.max)) return { matches: false, reason: 'CHARACTER_VISUAL_CONTEXT_MISMATCH: 资产年龄范围与本次要求不符或未记录' }
  if (requested.look.key !== stored.look.key) return { matches: false, reason: 'CHARACTER_VISUAL_CONTEXT_MISMATCH: 稳定服装/造型场合与本次要求不符；核心换装须使用新的look.key' }
  if (requested.look.description !== stored.look.description) return { matches: false, reason: 'CHARACTER_VISUAL_LOOK_DEFINITION_CONFLICT: 同一look.key的稳定造型定义发生变化；请原样复用已归档定义，或确认换装后使用新的look.key，不自动购买新图' }
  for (const key of ['hair', 'facialHair', 'build'] as const) {
    const wanted = requested.appearanceConstraints?.[key]
    if (wanted && wanted !== 'unknown' && wanted !== stored.appearanceConstraints?.[key]) return { matches: false, reason: `CHARACTER_VISUAL_CONTEXT_MISMATCH: 资产${key}与本次明确外观要求不符或未记录` }
  }
  const metadata = asset.metadata && typeof asset.metadata === 'object' ? asset.metadata as Record<string, unknown> : {}
  const profile = metadata.visualProfile && typeof metadata.visualProfile === 'object' ? metadata.visualProfile as Record<string, unknown> : {}
  const observed = profile.visualContextEvidence && typeof profile.visualContextEvidence === 'object' ? profile.visualContextEvidence as Record<string, unknown> : {}
  const ageCategory = (stage: unknown) => ['young_adult', 'adult', 'mature'].includes(String(stage)) ? 'adult' : stage
  if (observed.ageStage && observed.ageStage !== 'unknown' && requested.age.stage !== 'unknown' && ageCategory(observed.ageStage) !== ageCategory(requested.age.stage)) return { matches: false, reason: 'CHARACTER_VISUAL_APPEARANCE_MISMATCH: 实际图片观察的年龄大类与要求相反' }
  for (const key of ['hair', 'facialHair'] as const) if (requested.appearanceConstraints?.[key] && requested.appearanceConstraints[key] !== 'unknown'
    && observed[key] && observed[key] !== 'unknown' && observed[key] !== requested.appearanceConstraints[key]) return { matches: false, reason: `CHARACTER_VISUAL_APPEARANCE_MISMATCH: 实际图片观察的${key}与要求相反` }
  return { matches: true, reason: '' }
}

/** An image can be retained for manual review even when a clearly observed
 * hair/beard mismatch prevents automatic reuse. This exception never turns
 * the asset into a matching variant and never covers age, identity or costume. */
export function reviewedHairMismatchCanArchive(asset: Record<string, unknown>, reason: string) {
  if (!reason.startsWith('CHARACTER_VISUAL_APPEARANCE_MISMATCH:')) return false
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown> : {}
  const quality = metadata.quality && typeof metadata.quality === 'object' && !Array.isArray(metadata.quality)
    ? metadata.quality as Record<string, unknown> : {}
  const assessment = metadata.visualContextAssessment && typeof metadata.visualContextAssessment === 'object' && !Array.isArray(metadata.visualContextAssessment)
    ? metadata.visualContextAssessment as Record<string, unknown> : {}
  const conflicts = Array.isArray(assessment.conflicts) ? assessment.conflicts : []
  return quality.policy === 'principle-v1' && quality.assetDecision === 'revise' && quality.automaticRetakeAllowed === false
    && Array.isArray(quality.blockingProblems) && quality.blockingProblems.length === 0
    && assessment.decision === 'revise' && typeof assessment.finding === 'string' && assessment.finding.trim().length >= 8
    && conflicts.length > 0 && conflicts.every(row => row && typeof row === 'object'
      && ['hair', 'facialHair'].includes(String((row as Record<string, unknown>).field)))
}

/** User edits preserve unrelated metadata and sound identities. Image/visual
 * design changes invalidate observations of the previous image, not voices. */
export function mergeCharacterVisualMetadata(input: unknown, previous: Record<string, unknown> = {}, options: { imageChanged?: boolean; descriptionChanged?: boolean } = {}) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) throw Error('CHARACTER_VISUAL_CONTEXT_INVALID: 角色metadata必须是对象')
  const supplied = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const metadata: Record<string, unknown> = { ...previous, ...supplied }
  const artisticIdentity = normalizeCharacterArtisticIdentity(metadata.artisticIdentity)
  if (artisticIdentity) metadata.artisticIdentity = artisticIdentity
  else delete metadata.artisticIdentity
  const context = normalizeCharacterVisualContext(metadata.visualContext)
  if (context) { metadata.visualContext = context; metadata.visualContextSignature = characterVisualContextSignature(context) }
  else { delete metadata.visualContext; delete metadata.visualContextSignature }
  const prior = previous.visualContext ? normalizeCharacterVisualContext(previous.visualContext) : undefined
  if (options.imageChanged || options.descriptionChanged || (context ? characterVisualContextSignature(context) : '') !== (prior ? characterVisualContextSignature(prior) : '')) {
    delete metadata.visualProfile
    delete metadata.quality
  }
  // Pixel evidence and provider origin belong to the old image. A replacement
  // of a reviewed sheet waits for a new review instead of inheriting its pass.
  if (options.imageChanged) {
    const boundKeys = ['identityVisualProfile', 'identityConsistency', 'sourceMediaProvenance',
      'visualContextAssessment', 'visualContextSource', 'visualContextRequestSignature', 'visualContextImageFingerprint',
      'identityReferenceAssetId', 'identityReferenceUrl', 'identityReferenceTransportUrl', 'identityReferenceAnchor']
    const hadPixelEvidence = [...boundKeys, 'visualProfile'].some(key => key in previous || key in supplied)
      || (previous.artisticIdentity && typeof previous.artisticIdentity === 'object'
        && (previous.artisticIdentity as Record<string, unknown>).active === true)
    for (const key of boundKeys) delete metadata[key]
    delete metadata.artisticIdentity
    const lifecycle = metadata.portraitLifecycle && typeof metadata.portraitLifecycle === 'object'
      ? metadata.portraitLifecycle as Record<string, unknown> : {}
    if (hadPixelEvidence && lifecycle.status !== 'superseded') {
      metadata.portraitLifecycle = { status: 'pending-review', reason: 'image-replaced-awaiting-review', at: new Date().toISOString() }
    }
  }
  return metadata
}
