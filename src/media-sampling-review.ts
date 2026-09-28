import { deriveMediaRequirements, validateMediaRequirementChecks } from './media-requirement-coverage.ts'
import { resolveNativeFrameDisplayInterval } from './media-frame-display.ts'

export type MediaSamplingReview = {
  decision: 'uncertain'
  passed: false
  requirementChecks: Array<{ requirementId: string; status: 'unobservable'; evidence: string; frameIndices: number[] }>
}

/** A sampling-only union of independently validated blocking unknowns. It
 * never replaces either report or derives an acceptance decision. For VM
 * embedding bind deriveMediaRequirements and validateMediaRequirementChecks;
 * the latter also needs its explicit validateMediaEvidenceGaps binding. */
export function deriveMediaSamplingReview(primaryReview: Record<string, unknown>, combinedReview: Record<string, unknown>,
  shot: Record<string, unknown>, evidence: Record<string, unknown>, policy: Record<string, unknown> = {}): MediaSamplingReview {
  const requirements = deriveMediaRequirements(shot)
  const sources = [
    { name: 'primary原报告', coverage: validateMediaRequirementChecks(primaryReview, shot, evidence, policy) },
    { name: 'combined派生报告', coverage: validateMediaRequirementChecks(combinedReview, shot, evidence, policy) },
  ]
  const times = Array.isArray(evidence.frameTimes) ? evidence.frameTimes : []
  const frameCount = Array.isArray(evidence.frames) ? evidence.frames.length : 0
  const displays = Array.from({ length: frameCount }, (_, index) => resolveNativeFrameDisplayInterval(evidence, index))
  const near = (left: number, right: number) => Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right))
  const requirementChecks: MediaSamplingReview['requirementChecks'] = []
  for (const requirement of requirements) {
    const records = sources.flatMap(source => source.coverage.blockingUnobservableRequirements
      .filter(row => row.requirementId === requirement.id).map(row => ({ source: source.name, row })))
    if (!records.length) continue
    // A review may legitimately cite the configured timing tolerance. The
    // adaptive planner must receive only this requirement's exact window;
    // keep all in-window references and leave the authored bounds untouched.
    const frameIndices = [...new Set(records.flatMap(({ row }) => row.frameIndices))].filter(index => {
      if (requirement.scope === 'opening') return index === 0
      if (requirement.scope === 'ending') return index === frameCount - 1
      const second = Number(times[index])
      return (second >= requirement.startSecond || near(second, requirement.startSecond))
        && (second <= requirement.endSecond || near(second, requirement.endSecond))
        || Boolean(displays[index] && displays[index]!.startSecond <= requirement.endSecond && displays[index]!.endSecond > requirement.startSecond)
    }).sort((left, right) => left - right)
    requirementChecks.push({ requirementId: requirement.id, status: 'unobservable', frameIndices,
      evidence: records.map(({ source, row }) => source + '：' + row.evidence).join('\n') })
  }
  return { decision: 'uncertain', passed: false, requirementChecks }
}
