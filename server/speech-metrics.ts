type Value = Record<string, unknown>

const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Saved v1 spans remain readable, but cannot prove that either utterance edge
 * matched. A candidate ASR end is possible evidence, never a confirmed end. */
export function speechBoundaryEvidence(row: Value) {
  const matchedStart = row.matchedStart ?? row.actualStart
  const matchedEnd = row.matchedEnd ?? row.actualEnd
  const reasons = Array.isArray(row.boundaryUncertaintyReasons) ? row.boundaryUncertaintyReasons.map(String) : []
  if (row.boundaryEvidenceVersion !== 2) reasons.push('legacy-boundary-evidence-missing')
  if (row.firstTokenMatched !== true) reasons.push('first-token-unmatched-or-unverified')
  if (row.lastTokenMatched !== true) reasons.push('last-token-unmatched-or-unverified')
  if (row.alignmentCoverage !== 1) reasons.push('partial-or-unverified-phonetic-alignment')
  if (!finiteTime(matchedStart) || !finiteTime(matchedEnd) || matchedStart < 0 || matchedEnd <= matchedStart) reasons.push('invalid-matched-boundaries')
  if (!finiteTime(row.utteranceCandidateStart) || !finiteTime(row.utteranceCandidateEnd) || row.utteranceCandidateStart < 0 || row.utteranceCandidateEnd <= row.utteranceCandidateStart) reasons.push('missing-or-invalid-candidate-boundaries')
  if (finiteTime(matchedStart) && finiteTime(row.utteranceCandidateStart) && Math.abs(matchedStart - row.utteranceCandidateStart) > .15 ||
      finiteTime(matchedEnd) && finiteTime(row.utteranceCandidateEnd) && Math.abs(matchedEnd - row.utteranceCandidateEnd) > .15) reasons.push('candidate-matched-boundary-disagreement')
  if (row.boundaryStatus !== 'reliable') reasons.push('boundary-not-verified')
  const timingReliable = reasons.length === 0
  return { boundaryEvidenceVersion: row.boundaryEvidenceVersion ?? 1,
    matchedStart, matchedEnd, firstTokenMatched: row.firstTokenMatched ?? null, lastTokenMatched: row.lastTokenMatched ?? null,
    utteranceCandidateStart: row.utteranceCandidateStart ?? null, utteranceCandidateEnd: row.utteranceCandidateEnd ?? null,
    startBoundaryRange: row.startBoundaryRange ?? null, endBoundaryRange: row.endBoundaryRange ?? null,
    rawUtteranceCandidate: row.rawUtteranceCandidate ?? null,
    boundaryStatus: timingReliable ? 'reliable' : 'uncertain', boundaryUncertaintyReasons: [...new Set(reasons)], timingReliable }
}

/** Observations only. Pause/rate policy belongs to the workflow's review config. */
export function speechMetrics(alignment: Value[]) {
  return alignment.map(row => {
    const planned = row.planned as Value | undefined
    const text = String(planned?.text ?? '')
    const characters = [...text].filter(c => /\p{Script=Han}/u.test(c)).length
    const boundaries = speechBoundaryEvidence(row)
    const elapsed = finiteTime(boundaries.matchedEnd) && finiteTime(boundaries.matchedStart) ? boundaries.matchedEnd - boundaries.matchedStart : null
    return { text, characters, actualStart: row.actualStart, actualEnd: row.actualEnd, elapsed, ...boundaries,
      ...(boundaries.timingReliable ? {} : { timingAssessment: 'uncertain' }),
      charactersPerSecond: boundaries.timingReliable && elapsed != null && elapsed > 0 ? characters / elapsed : null,
      shortPauses: (text.match(/[，,；;、：:]/g) ?? []).length,
      sentencePauses: (text.match(/[。！？!?]/g) ?? []).length,
      alignmentCoverage: row.alignmentCoverage ?? null, timingSource: 'matched ASR word boundaries; uncertain edges are not complete utterance duration' }
  })
}
