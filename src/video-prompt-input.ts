import { storyboardStatePrompt } from './workflow-core.ts'

type Value = Record<string, unknown>
const record = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A video prompt needs the opening/ending state, without the still-image
 * renderer's appended instructions. Structural matching supports arbitrary
 * result variables and nested candidates; all action/audio fields stay exact. */
export function videoPromptInputContext<T extends Value>(context: T, mode: unknown): T {
  if (mode !== 'motion-state') return context
  const seen = new WeakMap<object, unknown>()
  const project = (value: unknown): unknown => {
    if (!record(value) && !Array.isArray(value)) return value
    if (seen.has(value)) return seen.get(value)
    if (Array.isArray(value)) {
      const items = value.map(project)
      const result = items.some((item, index) => item !== value[index]) ? items : value
      seen.set(value, result)
      return result
    }
    const storyboard = typeof value.videoPrompt === 'string' && typeof value.lastFramePrompt === 'string'
    let changed = false
    const entries = Object.entries(value).map(([key, item]) => {
      const next = storyboard && (key === 'visualPrompt' || key === 'lastFramePrompt')
        && typeof item === 'string' && item.includes('【静态尾帧】')
        ? storyboardStatePrompt(item) : project(item)
      if (next !== item) changed = true
      return [key, next]
    })
    const result = changed ? Object.fromEntries(entries) : value
    seen.set(value, result)
    return result
  }
  return project(context) as T
}
