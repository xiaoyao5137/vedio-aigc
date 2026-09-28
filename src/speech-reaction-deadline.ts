/** Find a required visual reaction whose approved schedule begins after the
 * final spoken beat. Earlier reactions cannot set a whole-clip speech deadline. */
export function deriveApprovedReactionDeadline(shotInput: unknown) {
  const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const rows = (value: unknown) => Array.isArray(value) ? value.map(obj) : []
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  const shot = obj(shotInput), pacing = obj(shot.pacing), speech = rows(pacing.speechWindows)
  if (pacing.version !== 'duration-v2' || !speech.length || !finite(shot.duration)) return null
  const finalSpeech = speech.filter(row => typeof row.beatId === 'string' && finite(row.end))
    .sort((left, right) => Number(right.end) - Number(left.end))[0]
  if (!finalSpeech) return null
  const schedule = rows(pacing.schedule), beats = rows(pacing.beats)
  const candidates = beats.filter(beat => beat.kind === 'reaction'
    && obj(beat.completion).requiredThisClip === true
    && Array.isArray(beat.dependsOn) && beat.dependsOn.includes(finalSpeech.beatId))
    .flatMap(beat => schedule.filter(window => window.kind === 'reaction' && window.beatId === beat.id
      && finite(window.startSecond) && finite(window.endSecond)
      && window.startSecond >= Number(finalSpeech.end) - 0.001
      && window.endSecond > window.startSecond && window.endSecond <= Number(shot.duration) + 0.001)
      .map(window => ({ speechBeatId: String(finalSpeech.beatId), reactionBeatId: String(beat.id),
        startSecond: Number(window.startSecond), endSecond: Number(window.endSecond),
        actorIds: Array.isArray(beat.actorIds) ? beat.actorIds.filter((name): name is string => typeof name === 'string') : [],
        evidenceAnchor: typeof obj(beat.completion).evidenceAnchor === 'string'
          ? String(obj(beat.completion).evidenceAnchor) : '' })))
    .sort((left, right) => left.startSecond - right.startSecond)
  return candidates[0] ?? null
}
