type Value = Record<string, unknown>
const record = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

export type EditorialFeedback = {
  status: 'located' | 'unverified'
  itemId: string
  path: string
  quote: string
  problem: string
  suggestion: string
  repairNode: 'sanguo-scene-outline' | 'sanguo-shot-script'
}

/** Locate an editorial warning in the actual accepted candidate. A reviewer's
 * free-form claim stays visible, but it never becomes evidence by assertion. */
export function collectPrincipleEditorialFeedback(output: unknown): EditorialFeedback[] {
  const candidate = record(output), review = record(candidate.qualityReview)
  const scenes = Array.isArray(candidate.scenes) ? candidate.scenes.map(record) : null
  const rawWarnings = Array.isArray(review.warnings) ? review.warnings : []
  const feedback: EditorialFeedback[] = []
  for (const value of rawWarnings) {
    const warning = record(value)
    const evidenceRows = Array.isArray(warning.evidence) ? warning.evidence.map(record) : [record(warning.evidence)]
    for (const evidence of evidenceRows) {
      const path = text(evidence.path ?? warning.path).replace(/\[(\d+)\]/g, '.$1')
      const quote = text(evidence.quote ?? warning.quote)
      const itemId = text(evidence.itemId ?? warning.itemId)
      const problem = text(warning.problem)
      if (!problem || (!path && !quote && !itemId)) continue
      const suggestion = text(warning.repair ?? warning.suggestion)
      const sceneMatch = /^scenes\.(\d+)\./.exec(path)
      const scene = sceneMatch && scenes ? scenes[Number(sceneMatch[1])] : null
      const owner = scene ?? (scenes ? null : candidate)
      const ownedPath = sceneMatch ? path.slice(sceneMatch[0].length) : path
      const admissible = /^(?:requiredBeats\.\d+\.(?:observable\.(?:visual|audio)\.\d+|mustShow\.\d+)|beatDramaturgy\.\d+\.(?:visual|audio)\.\d+|audioText|videoPrompt|pacing\.beats\.\d+\.(?:textOrVocalization|performanceInstruction))$/.test(ownedPath)
      const leaf = path && !/(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/.test(path)
        ? path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, key)
          ? (current as Value)[key] : undefined, candidate) : undefined
      const located = Boolean(admissible && owner && itemId === owner.id && quote && typeof leaf === 'string' && leaf.includes(quote))
      feedback.push({ status: located ? 'located' : 'unverified', itemId, path, quote, problem, suggestion,
        repairNode: scenes ? 'sanguo-scene-outline' : 'sanguo-shot-script' })
    }
  }
  return feedback
}
