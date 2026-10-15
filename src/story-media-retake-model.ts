type Value = Record<string, unknown>

export type StoryVideoModelContract = {
  id: string
  provider: string
  capability: 'video'
  settings: Record<string, string>
}

const generationKeys = [
  'model', 'mode', 'resolution', 'aspectRatio', 'aspect_ratio', 'duration',
  'cfgScale', 'cfg_scale', 'negativePrompt', 'negative_prompt', 'sound', 'size',
] as const
const transportKeys = new Set([
  'apiKey', 'accessKey', 'secretKey', 'pollIntervalMs', 'taskTimeoutMs',
])
// The Kling video adapter reads these only from node params. Older shared
// model configs may contain a signed demo image URL, which must never be
// copied into a branch record or a printable contract.
const ignoredLegacyKeys = new Set(['image', 'imageTail', 'externalTaskId'])
const record = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Keep only the video target and non-secret request defaults. Unknown settings
 * fail closed because their effect on paid generation cannot be established. */
export function storyVideoModelContract(model: unknown): StoryVideoModelContract | undefined {
  if (!record(model) || typeof model.id !== 'string' || !model.id.trim()
    || typeof model.provider !== 'string' || !model.provider.trim()
    || model.capability !== 'video' || !record(model.settings)) return undefined
  const settings: Record<string, string> = {}
  for (const [key, value] of Object.entries(model.settings)) {
    if (transportKeys.has(key) || ignoredLegacyKeys.has(key)) continue
    if (key === 'endpoint') {
      if (typeof value !== 'string' || !value.trim()) return undefined
      let endpoint: URL
      try { endpoint = new URL(value) } catch { return undefined }
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash || endpoint.href !== value) return undefined
      settings.endpoint = value
      continue
    }
    if (!(generationKeys as readonly string[]).includes(key) || typeof value !== 'string'
      || value.length > 2000 || /\b(?:https?:\/\/|bearer\s+|(?:api|access|secret)[-_]?key\s*[:=])/i.test(value)) return undefined
    settings[key] = value
  }
  return { id: model.id, provider: model.provider, capability: 'video',
    settings: Object.fromEntries(Object.entries(settings).sort(([left], [right]) => left.localeCompare(right))) }
}

export function matchesStoryVideoModelContract(model: unknown, pinned: unknown): boolean {
  const current = storyVideoModelContract(model)
  if (!current || !record(pinned) || Object.keys(pinned).sort().join(',') !== 'capability,id,provider,settings'
    || !record(pinned.settings)) return false
  const expected = storyVideoModelContract(pinned)
  if (!expected || Object.keys(pinned.settings).length !== Object.keys(expected.settings).length
    || current.id !== expected.id || current.provider !== expected.provider
    || current.capability !== expected.capability) return false
  const currentKeys = Object.keys(current.settings)
  const expectedKeys = Object.keys(expected.settings)
  return currentKeys.length === expectedKeys.length && currentKeys.every(key =>
    Object.hasOwn(expected.settings, key) && current.settings[key] === expected.settings[key])
}
