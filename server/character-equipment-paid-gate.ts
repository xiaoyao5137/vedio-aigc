import type { Pool } from 'pg'
import { characterPersonId, readCharacterEquipment } from './character-assets.ts'
import { validatedCharacterEquipment } from '../src/character-visual-workflow.ts'

type MediaRequest = {
  model: { capability: string }
  params?: Record<string, unknown>
  executionContext?: { workflowId?: string; nodeId?: string }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const words = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((word): word is string => typeof word === 'string' && Boolean(word.trim())) : []
const sameWord = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()

/** A saved execution may jump straight to video after the inventory changes.
 * Recheck its archived equipment IDs immediately before a new paid request. */
export async function assertCurrentCharacterEquipmentBindings(pool: Pool, request: MediaRequest): Promise<void> {
  if (request.model.capability !== 'video' || request.executionContext?.workflowId !== 'wf-sanguo-history-drama'
    || request.executionContext.nodeId !== 'sanguo-video') return
  const params = request.params ?? {}
  const bindings = Array.isArray(params.equipmentBindings) ? params.equipmentBindings.map(object) : []
  if (!bindings.length) return
  const workflowId = request.executionContext.workflowId
  const cast = [...new Set([...words(params.characters), ...words(params.presentCharacters),
    ...words(params.initialCharacters), ...words(params.enteringCharacters)])]
  const requirements = validatedCharacterEquipment(params.characterEquipment, cast, 'shot.characterEquipment') ?? []
  const visuals = Array.isArray(params.characterVisuals) ? params.characterVisuals.map(object).filter(Boolean) : []
  const inventory = await readCharacterEquipment(pool, workflowId, requirements.map(row => String(row.name)))
  for (const binding of bindings) {
    if (!binding) throw Error('CHARACTER_EQUIPMENT_STALE: 装备绑定无效；请从人物召回节点重试')
    const name = String(binding.characterName ?? '')
    const matchedName = String(binding.matchedName ?? '')
    const requirement = requirements.find(row => row.name === name && (row.equipmentNames as string[]).includes(matchedName))
    const current = inventory.find(row => row.id === binding.id && row.workflowId === workflowId
      && row.personId === characterPersonId(workflowId, name) && row.characterName === name)
    const nameStillMatches = current && (sameWord(current.name, matchedName)
      || current.aliases.some(alias => sameWord(alias, matchedName)))
    if (!requirement || !current || !nameStillMatches || current.name !== binding.name || current.kind !== binding.kind
      || current.description !== binding.description || current.imageUrl !== binding.imageUrl) {
      throw Error(`CHARACTER_EQUIPMENT_STALE: ${name || '人物'} 的装备“${matchedName}”已被删除、改归属或修订；请从人物召回节点重试，已阻止媒体付费请求`)
    }
    const visual = visuals.find(row => row?.name === name)?.visualContext
    const context = object(visual)
    const age = object(context?.age)?.stage
    const look = object(context?.look)?.key
    const rules = current.applicability
    if (rules.ageStages?.length && !rules.ageStages.some(stage => stage === age)
      || rules.lookKeys?.length && (typeof look !== 'string' || !rules.lookKeys.includes(look))
      || rules.sceneTags?.length && !words(requirement.sceneTags).some(tag => rules.sceneTags?.includes(tag))) {
      throw Error(`CHARACTER_EQUIPMENT_STALE: ${name} 的装备“${matchedName}”不再适用于本镜年龄、造型或场景；请从人物召回节点重试，已阻止媒体付费请求`)
    }
  }
}
