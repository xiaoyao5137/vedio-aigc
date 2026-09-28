export const CHARACTER_BIOGRAPHY_MAX_LENGTH = 10000

export type CharacterAsset = {
  voiceAvailable?: boolean
  voice?: import('./character-voice.ts').CharacterVoice
  id: string
  workflowId: string | null
  characterName: string
  description: string
  biography?: string
  threeViewUrl: string
  version: number
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type CharacterAssetInput = Omit<CharacterAsset, 'id' | 'version' | 'createdAt' | 'updatedAt'>

export type CharacterEquipmentKind = 'weapon' | 'armor' | 'prop' | 'accessory' | 'other'

/** Empty applicability lists mean that the item can be used in any such context. */
export type CharacterEquipmentApplicability = {
  ageStages?: import('./character-visual-context.ts').CharacterAgeStage[]
  lookKeys?: string[]
  sceneTags?: string[]
}

export type CharacterEquipment = {
  id: string
  personId: string
  workflowId: string | null
  characterName: string
  name: string
  kind: CharacterEquipmentKind
  description: string
  imageUrl: string
  aliases: string[]
  applicability: CharacterEquipmentApplicability
  createdAt: string
  updatedAt: string
}

export type CharacterEquipmentInput = Pick<CharacterEquipment, 'name' | 'kind'> & Partial<Pick<CharacterEquipment, 'description' | 'imageUrl' | 'aliases' | 'applicability'>>

export type OriginalCharacterVoice = {
  voiceId: string | null
  description: string
  previewUrl: string | null
  targetModel: string
  status: string
}

export type CharacterPerson = {
  id: string
  workflowId: string | null
  characterName: string
  biography: string
  versions: CharacterAsset[]
  equipment: CharacterEquipment[]
  /** Voice identity is owned by the person, not by an age or costume sheet. */
  voice?: import('./character-voice.ts').CharacterVoice
  voiceAvailable?: boolean
  originalVoice?: OriginalCharacterVoice
  voiceAmbiguous?: boolean
  updatedAt: string
}

/** An omitted biography preserves the shared profile; an empty string clears it. */
export function normalizeCharacterBiography(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw Error('人物自传描述须为文本')
  if (value.length > CHARACTER_BIOGRAPHY_MAX_LENGTH) throw Error(`人物自传描述不能超过 ${CHARACTER_BIOGRAPHY_MAX_LENGTH} 字`)
  return value.trim()
}
