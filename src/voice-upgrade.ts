import { historicalVideoRetryIndexes } from './workflow-runner.ts'
import { voiceReviewTarget } from './voice-review.ts'

export type VoiceUpgradeRun = { node: { kind: string }; output?: unknown; loopGroupId?: string; loopIndex?: number; loopItem?: unknown; loopIsLast?: boolean }

/** A character upgrade covers every occurrence, plus the same continuity
 * dependants as a video retake. Unknown old media cannot be silently retained. */
export function voiceUpgradeIndexes(runs: VoiceUpgradeRun[], characterIds: string[], historical: boolean) {
  if (!characterIds.length) throw Error('请选择需要升级声音的人物')
  const selected = new Set(characterIds)
  const direct: number[] = [], unknown: number[] = []
  runs.forEach((run, index) => {
    if (run.node.kind !== 'video') return
    const target = voiceReviewTarget(run.output)
    if (!target) unknown.push(index)
    else if (target.characters.some(v => selected.has(v.characterId))) direct.push(index)
  })
  if (!direct.length) throw Error('当前执行没有找到所选人物的声音证据')
  const invalidated = new Set<number>()
  for (const index of [...direct, ...unknown]) {
    const affected = historical ? historicalVideoRetryIndexes(runs, index) : new Set(runs.map((_, i) => i).filter(i => i >= index))
    affected.forEach(i => invalidated.add(i))
  }
  return { direct, unknown, invalidated: [...invalidated].sort((a, b) => a - b) }
}
