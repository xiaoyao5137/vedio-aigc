import { assessAudioVisualEventEvidence } from './audio-visual-event-evidence.ts'

type Value = Record<string, unknown>
type Run = { id?: string; output?: unknown; retryFeedback?: unknown; loopGroupId?: string; loopIndex?: number }
const obj = (v: unknown): Value => v && typeof v === 'object' && !Array.isArray(v) ? v as Value : {}
const rows = (v: unknown): Value[] => Array.isArray(v) ? v.map(obj) : []
const key = (target: Value) => JSON.stringify([target.id, target.sourceDefect, target.userReport])

/** Capture only the live retry interval in the same execution iteration. Never
 * scan prior loop results, global context, attempts or branch history. */
export function collectTargetedRepairRetry(runs: Run[], start: number, end: number) {
  const owner = runs[end]
  if (!owner || start < 0 || start > end || runs[start].loopGroupId !== owner.loopGroupId || runs[start].loopIndex !== owner.loopIndex) return undefined
  const targets = new Map<string, Value>()
  for (const run of runs.slice(start, end + 1)) {
    if (run.loopGroupId !== owner.loopGroupId || run.loopIndex !== owner.loopIndex) continue
    const prior = obj(obj(obj(run.retryFeedback).repairContext).targetedMediaRepair)
    if (prior.version === 'targeted-media-repair-retry-v1' && obj(prior.scope).loopGroupId === (owner.loopGroupId ?? null)
      && obj(prior.scope).loopIndex === (owner.loopIndex ?? null)) {
      for (const target of rows(prior.targets)) targets.set(key(target), target)
    }
    const output = obj(run.output), assessment = assessAudioVisualEventEvidence(output, output.audioVisualEventReviews, output.targetedRepairAssessment)
    const declared = rows(obj(output.targetedRepairAssessment).targets)
    for (const result of assessment.targetResults) {
      const target = declared.find(target => target.id === result.targetId)
      if (!target) continue
      if (result.status === 'resolved') targets.delete(key(target))
      else targets.set(key(target), { id: target.id, sourceDefect: target.sourceDefect, userReport: target.userReport,
        ...(target.repairScope ? { repairScope: target.repairScope } : {}) })
    }
    for (const issue of assessment.issues.filter(issue => issue.code === 'reported_audio_visual_defect')) {
      const e = obj(issue.evidence)
      const target = { id: String(e.reviewId) + ':' + String(e.eventId), sourceDefect: { code: 'unvoiced_visible_speech', videoUrl: e.videoUrl,
        sha256: e.sha256, actorId: e.actorId, startSecond: e.startSecond, endSecond: e.endSecond }, userReport: e.userReport }
      targets.set(key(target), target)
    }
  }
  if (!targets.size) return undefined
  return { version: 'targeted-media-repair-retry-v1', scope: { loopGroupId: owner.loopGroupId ?? null, loopIndex: owner.loopIndex ?? null },
    sourceRunId: owner.id ?? null, retryFromRunId: runs[start].id ?? null, targets: [...targets.values()] }
}

export function withTargetedRepairRetry(feedback: unknown, carry: ReturnType<typeof collectTargetedRepairRetry>) {
  if (!carry) return feedback
  const original = obj(feedback)
  return { ...(Object.keys(original).length ? original : { feedback: feedback ?? '' }),
    repairContext: { ...obj(original.repairContext), targetedMediaRepair: carry } }
}
