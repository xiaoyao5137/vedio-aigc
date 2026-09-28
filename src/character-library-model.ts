import { characterVisualContextFrom, normalizeCharacterVisualContext } from './character-visual-context.ts'
import type { CharacterAsset } from './character-asset.ts'
import { currentPortraits } from './character-portrait-lifecycle.ts'

type VisualContext = NonNullable<ReturnType<typeof normalizeCharacterVisualContext>>
export const AGE_STAGES: Array<{ value: VisualContext['age']['stage']; label: string }> = [
  { value: 'unknown', label: '年龄阶段未知' }, { value: 'child', label: '儿童' }, { value: 'adolescent', label: '少年' },
  { value: 'young_adult', label: '青年' }, { value: 'adult', label: '成年' }, { value: 'mature', label: '成熟壮年' }, { value: 'elderly', label: '老年' },
]
export const AGE_BASES: Array<{ value: VisualContext['age']['basis']; label: string }> = [
  { value: 'unknown', label: '依据未知' }, { value: 'documented', label: '史料明确' },
  { value: 'estimated', label: '史料估计' }, { value: 'artistic', label: '艺术设定' },
]
export type VisualContextDraft = {
  enabled: boolean; stage: VisualContext['age']['stage']; basis: VisualContext['age']['basis']
  minAge: string; maxAge: string; asOf: string; sourceRefs: string; lookKey: string; lookDescription: string
  hair: NonNullable<NonNullable<VisualContext['appearanceConstraints']>['hair']>
  facialHair: NonNullable<NonNullable<VisualContext['appearanceConstraints']>['facialHair']>; build: string
}
export const emptyVisualContextDraft: VisualContextDraft = { enabled: true, stage: 'unknown', basis: 'unknown',
  minAge: '', maxAge: '', asOf: '', sourceRefs: '', lookKey: '', lookDescription: '', hair: 'unknown', facialHair: 'unknown', build: '' }

export function visualContextDraftFrom(asset: unknown): VisualContextDraft {
  const context = characterContextSummary(asset).context
  return context ? { enabled: true, stage: context.age.stage, basis: context.age.basis,
    minAge: context.age.years ? String(context.age.years.min) : '', maxAge: context.age.years ? String(context.age.years.max) : '',
    asOf: context.age.asOf ?? '', sourceRefs: (context.age.sourceRefs ?? []).join('\n'),
    lookKey: context.look.key, lookDescription: context.look.description, hair: context.appearanceConstraints?.hair ?? 'unknown',
    facialHair: context.appearanceConstraints?.facialHair ?? 'unknown', build: context.appearanceConstraints?.build ?? '' }
    : { ...emptyVisualContextDraft, enabled: false }
}

export function visualContextFromDraft(draft: VisualContextDraft) {
  if (!draft.enabled) return undefined
  const min = draft.minAge.trim(), max = draft.maxAge.trim()
  if (Boolean(min) !== Boolean(max)) throw Error('请同时填写年龄范围的起始与结束，或都留空。')
  if (min && (!/^\d+$/.test(min) || !/^\d+$/.test(max) || Number(min) > Number(max) || Number(max) > 120)) throw Error('年龄范围须为从小到大的整数，且不超过120岁。')
  if (!draft.lookKey.trim() || !draft.lookDescription.trim()) throw Error('请填写造型名称与服装、冠帽等造型描述。')
  if (['documented', 'estimated'].includes(draft.basis) && !draft.sourceRefs.trim()) throw Error('请填写年龄依据；没有可靠记载时可选择艺术设定或未知。')
  return normalizeCharacterVisualContext({ version: 'character-visual-context-v1',
    age: { stage: draft.stage, basis: draft.basis, ...(min ? { years: { min: Number(min), max: Number(max) } } : {}),
      ...(draft.asOf.trim() ? { asOf: draft.asOf.trim() } : {}),
      ...(draft.sourceRefs.trim() ? { sourceRefs: draft.sourceRefs.split(/\r?\n/).map(line => line.trim()).filter(Boolean) } : {}) },
    look: { key: draft.lookKey.trim(), description: draft.lookDescription.trim() },
    appearanceConstraints: { hair: draft.hair, facialHair: draft.facialHair, ...(draft.build.trim() ? { build: draft.build.trim() } : {}) } })
}

export function characterContextSummary(asset: unknown) {
  let context: VisualContext | undefined, invalid = false
  try { context = characterVisualContextFrom(asset) } catch { invalid = true }
  const stage = AGE_STAGES.find(option => option.value === context?.age.stage)?.label ?? '年龄阶段未标注'
  const basis = AGE_BASES.find(option => option.value === context?.age.basis)?.label ?? '依据未标注'
  const range = context?.age.years ? `${context.age.years.min}–${context.age.years.max}岁` : ''
  return { context, invalid, stage, basis, range, age: invalid ? '年龄与造型资料待校对' : [stage, range].filter(Boolean).join(' · '),
    period: context?.age.asOf || '剧情时间未标注', look: context?.look.key || '场景造型未标注',
    description: context?.look.description || '', sourceRefs: context?.age.sourceRefs ?? [] }
}

/** A precise age range supersedes the stage-only label for the same stage.
 * Distinct ranges remain visible because they may represent different periods. */
export function characterPersonAgeLabels(versions: unknown[]): string[] {
  const summaries = versions.map(characterContextSummary)
  const preciseStages = new Set(summaries.filter(item => item.context && !item.invalid && item.range).map(item => item.stage))
  return [...new Set(summaries
    .filter(item => !(item.context && !item.invalid && !item.range && preciseStages.has(item.stage)))
    .map(item => item.age))]
}

export function characterContextSearchText(asset: unknown) {
  const summary = characterContextSummary(asset)
  return [summary.age, summary.basis, summary.period, summary.look, summary.description,
    ...summary.sourceRefs, summary.context?.appearanceConstraints?.build ?? ''].join(' ')
}

export type CharacterPersonGroup = {
  key: string
  workflowId: string | null
  characterName: string
  biography?: string
  versions: CharacterAsset[]
  latest: CharacterAsset
}

/** Keep persisted portrait IDs intact while showing one row per workflow/person. */
export function groupCharacterAssets(assets: CharacterAsset[]): CharacterPersonGroup[] {
  const groups = new Map<string, CharacterPersonGroup>()
  for (const asset of assets) {
    const key = JSON.stringify([asset.workflowId ?? '', asset.characterName.trim()])
    const group = groups.get(key)
    if (group) group.versions.push(asset)
    else groups.set(key, { key, workflowId: asset.workflowId, characterName: asset.characterName.trim(),
      biography: asset.biography, versions: [asset], latest: asset })
  }
  return [...groups.values()].map(group => {
    group.versions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
    group.latest = group.versions[0]
    return group
  }).sort((a, b) => Date.parse(b.latest.updatedAt) - Date.parse(a.latest.updatedAt) || a.key.localeCompare(b.key))
}

export function personMatchesContext(group: Pick<CharacterPersonGroup, 'characterName' | 'versions' | 'biography'>, filters: {
  age?: string; basis?: string; look?: string; period?: string; keyword?: string; workflowName?: string; equipmentText?: string
}) {
  const keyword = filters.keyword?.trim().toLocaleLowerCase() ?? ''
  const activeVersions = currentPortraits(group.versions)
  const noContextFilter = ['age', 'basis', 'look', 'period'].every(key => {
    const value = filters[key as keyof typeof filters]
    return !value || value === 'all'
  })
  const contextMatches = (activeVersions.length === 0 && noContextFilter) || activeVersions.some(version => {
    const context = characterContextSummary(version).context
    return (filters.age === 'all' || !filters.age || (filters.age === 'unmarked' ? !context : context?.age.stage === filters.age))
      && (filters.basis === 'all' || !filters.basis || (filters.basis === 'unmarked' ? !context : context?.age.basis === filters.basis))
      && (filters.look === 'all' || !filters.look || context?.look.key === filters.look)
      && (filters.period === 'all' || !filters.period || context?.age.asOf === filters.period)
  })
  if (!contextMatches) return false
  if (!keyword) return true
  return [group.characterName, group.biography ?? '', filters.workflowName ?? '', filters.equipmentText ?? '',
    ...activeVersions.flatMap(version => [version.biography ?? '', version.description, characterContextSearchText(version)])]
    .some(value => value.toLocaleLowerCase().includes(keyword))
}

/** New costume/age sheets inherit person-level facts and sound, never the
 * prior sheet's pixel observations, generated-media origin or active anchor. */
export function characterVersionMetadata(base: { id: string; metadata: Record<string, unknown> } | undefined,
  name: string, draft: VisualContextDraft, options: { newVersion?: boolean; versionId?: string } = {}) {
  const context = visualContextFromDraft(draft)
  const inherited = base?.metadata ?? {}
  const continuityKey = options.newVersion
    ? `${name.trim()}-library-${options.versionId ?? globalThis.crypto.randomUUID()}`
    : String(inherited.continuityKey || base?.id || `${name.trim()}-v1`)
  return {
    continuityKey,
    ...(typeof inherited.voiceContinuityKey === 'string' ? { voiceContinuityKey: inherited.voiceContinuityKey } : {}),
    ...(inherited.originalVoice && typeof inherited.originalVoice === 'object' ? { originalVoice: inherited.originalVoice } : {}),
    ...(context ? { visualContext: context } : {}),
    source: 'character-library',
  }
}
