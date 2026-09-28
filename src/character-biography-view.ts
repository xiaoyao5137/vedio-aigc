/** A shared biography can be newer than an individual portrait's retrieval log.
 * Show its cited appearance passage first, while keeping the version log intact. */
export function sharedHistoricalAppearanceEvidence(biography: string): string | undefined {
  const heading = '【正史体貌记载】\n'
  const start = biography.indexOf(heading)
  if (start < 0) return undefined
  const bodyStart = start + heading.length
  const next = biography.indexOf('\n\n【', bodyStart)
  const body = biography.slice(bodyStart, next < 0 ? undefined : next).trim()
  return /^来源：[^\n]+\nhttps?:\/\/\S+/m.test(body) ? body : undefined
}
