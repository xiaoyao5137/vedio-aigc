import { HISTORY_PACING_VERSION, unionSeconds } from './history-pacing.ts'

type Value = Record<string, unknown>
type ActivityKind = 'speech' | 'action' | 'reaction'
type Window = Value & { startSecond: number; endSecond: number }
type ActivityWindow = Window & { kind: ActivityKind }

export type StoryboardPacingMetadataChange = {
  path: string
  before: unknown
  after: number | ActivityKind[]
  source: 'activity-window-union' | 'activity-window-intersection'
}

export type StoryboardPacingMetadataRepair = {
  candidate: Value
  changes: StoryboardPacingMetadataChange[]
}

const kinds: ActivityKind[] = ['speech', 'action', 'reaction']
const isRecord = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const validWindow = (value: unknown): value is Window => isRecord(value)
  && typeof value.startSecond === 'number' && Number.isFinite(value.startSecond)
  && typeof value.endSecond === 'number' && Number.isFinite(value.endSecond)
  && value.startSecond >= 0 && value.endSecond > value.startSecond

function hasSameKindOverlap(windows: ActivityWindow[]) {
  const ordered = [...windows].sort((left, right) => left.startSecond - right.startSecond)
  return ordered.some((window, index) => index > 0 && window.startSecond < ordered[index - 1].endSecond)
}

/** Redundant timing metadata comes from the existing clock. This does not move a
 * window, alter a speech budget, invent a missing reaction, or accept a script.
 * Callers must run the complete storyboard validator on the returned candidate. */
export function repairStoryboardPacingMetadata(output: unknown): StoryboardPacingMetadataRepair | undefined {
  const changes: StoryboardPacingMetadataChange[] = []
  const repair = (value: unknown, prefix: string): unknown => {
    if (!isRecord(value)) return value
    if (Array.isArray(value.segments)) {
      const segments = value.segments.map((segment, index) => repair(segment, `${prefix}segments[${index}].`))
      return segments.some((segment, index) => segment !== (value.segments as unknown[])[index])
        ? { ...value, segments } : value
    }
    const pacing = value.pacing
    if (!isRecord(pacing) || pacing.version !== HISTORY_PACING_VERSION
      || !Array.isArray(pacing.activityWindows)
      || !pacing.activityWindows.every(window => validWindow(window) && kinds.includes(window.kind as ActivityKind))) return value

    const activities = pacing.activityWindows as ActivityWindow[]
    const next = { ...pacing }
    const start = changes.length
    for (const kind of ['action', 'reaction'] as const) {
      const windows = activities.filter(window => window.kind === kind)
      // A missing window cannot erase a declared action or manufacture a reaction.
      if (!windows.length || hasSameKindOverlap(windows)) continue
      const seconds = Number(unionSeconds(windows).toFixed(6))
      const minimum = kind === 'action' ? 0 : 0.3
      const maximum = kind === 'action' ? 10 : 1.2
      if (seconds < minimum || seconds > maximum) continue
      const key = `${kind}Seconds`
      if (pacing[key] === seconds) continue
      next[key] = seconds
      changes.push({ path: `${prefix}pacing.${key}`, before: pacing[key], after: seconds, source: 'activity-window-union' })
    }

    if (Array.isArray(pacing.performanceBeats)) {
      const beats = pacing.performanceBeats.map((beat, index) => {
        if (!validWindow(beat)) return beat
        const overlapWith = kinds.filter(kind => activities.some(window => window.kind === kind
          && Math.min(window.endSecond, beat.endSecond) > Math.max(window.startSecond, beat.startSecond)))
        const declared = beat.overlapWith
        if (Array.isArray(declared) && declared.length === overlapWith.length
          && new Set(declared).size === declared.length && overlapWith.every(kind => declared.includes(kind))) return beat
        changes.push({ path: `${prefix}pacing.performanceBeats[${index}].overlapWith`, before: declared,
          after: overlapWith, source: 'activity-window-intersection' })
        return { ...beat, overlapWith }
      })
      if (beats.some((beat, index) => beat !== (pacing.performanceBeats as unknown[])[index])) next.performanceBeats = beats
    }
    return changes.length > start ? { ...value, pacing: next } : value
  }
  const candidate = repair(output, '')
  return changes.length && isRecord(candidate) ? { candidate, changes } : undefined
}
