type ModelWithSettings = {
  id: string
  settings: Record<string, string>
}

type SharedCredentialGroup = {
  modelIds: string[]
  keys: string[]
}

const sharedCredentialGroups: SharedCredentialGroup[] = [
  { modelIds: ['gpt-image-2', 'qwen-image-3-pro'], keys: ['apiKey'] },
  { modelIds: ['keling3', 'kling-image-3'], keys: ['apiKey', 'accessKey', 'secretKey'] },
]

function credentialGroup(modelId: string) {
  return sharedCredentialGroups.find((group) => group.modelIds.includes(modelId))
}

export function sharedCredentialModelIds(modelId: string) {
  return credentialGroup(modelId)?.modelIds ?? [modelId]
}

export function isSharedCredentialKey(modelId: string, key: string) {
  return credentialGroup(modelId)?.keys.includes(key) ?? false
}

export function syncSharedModelCredentials<T extends ModelWithSettings>(models: T[], sourceModelId?: string): T[] {
  let next = models
  for (const group of sharedCredentialGroups) {
    const members = next.filter((model) => group.modelIds.includes(model.id))
    if (members.length < 2) continue
    const source = sourceModelId && group.modelIds.includes(sourceModelId)
      ? members.find((model) => model.id === sourceModelId)
      : undefined
    const sharedValues = Object.fromEntries(group.keys.map((key) => {
      const value = source ? source.settings[key] ?? '' : members.find((model) => model.settings[key])?.settings[key] ?? ''
      return [key, value]
    }))
    next = next.map((model) => group.modelIds.includes(model.id)
      ? { ...model, settings: { ...model.settings, ...sharedValues } }
      : model)
  }
  return next
}
