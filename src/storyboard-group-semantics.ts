type Value = Record<string, unknown>
const object = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const tokens = (value: string) => value.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '')
const name = (value: string) => value.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
const rolePattern = '(?:信众|教众|弟子|百姓|病患|家属|士兵|军士|官员|群众|人群|众人|人们|人)'
const positions = /^(?:(?:高台)?(?:下方|上方|前方|后方|两侧|周围|外围|台下|台上)|广场上)/
function identity(value: string) {
  let label = name(value)
  while (positions.test(label)) label = label.replace(positions, '')
  const match = label.match(new RegExp(`^([零一二三四五六七八九十百千万两\\d]+(?:余|多)?|众多|一群|一众|众)?(?:跪拜|跪伏|跪地|跪着|站立|站着|围观)?(${rolePattern})$`))
  return match ? { count: (match[1] ?? '').replace(/余|多/g, ''), role: match[2] } : undefined
}
function groups(value: unknown) {
  return Array.isArray(value) ? value.filter(object).filter(group => typeof group.id === 'string' && typeof group.label === 'string') : []
}

/** A declared anonymous role may carry a posture/location adjective. Resolve
 * only one declared identity; never guess between two groups, roles or counts. */
export function resolveAnonymousGroupSpeaker(speaker: string, declarations: unknown): string | undefined {
  const available = groups(declarations), normalized = name(speaker)
  const exact = available.filter(group => group.id === normalized || name(String(group.label)) === normalized)
  if (exact.length) return exact.length === 1 ? String(exact[0].id) : undefined
  const parsed = identity(speaker)
  if (!parsed) return undefined
  const matches = available.filter(group => {
    const other = identity(String(group.label))
    return other && parsed.count === other.count && parsed.role === other.role
  })
  return matches.length === 1 ? String(matches[0].id) : undefined
}

export function parseGroupPerformance(value: string, declarations: unknown) {
  const match = value.trim().match(/^([^，。；：:!?！？\n]+?)(齐声应和|齐声高呼|齐声呼喊|齐声回应|齐声答应)$/)
  if (!match) return undefined
  let id = resolveAnonymousGroupSpeaker(match[1], declarations)
  if (!id) {
    const parsed = identity(match[1])
    if (!parsed || !['人', '人群', '众人', '人们', '群众'].includes(parsed.role)) return undefined
    const matches = groups(declarations).filter(group => {
      const other = identity(String(group.label))
      return other && parsed.count === other.count
    })
    if (matches.length !== 1) return undefined
    id = String(matches[0].id)
  }
  return { actorId: id, predicate: match[2] }
}

/** Collective performance prose is not spoken dialogue. Its explicit subject
 * must resolve to the performing group and its predicate must remain intact. */
export function scriptedGroupPerformanceCovers(anchor: string, beats: unknown, declarations: unknown): boolean | undefined {
  const approved = parseGroupPerformance(anchor, declarations)
  if (!approved) return undefined
  return Array.isArray(beats) && beats.some(raw => {
    if (!object(raw) || raw.kind !== 'speech' || raw.deliveryStyle === 'narration'
      || !Array.isArray(raw.actorIds) || raw.actorIds.length !== 1 || raw.actorIds[0] !== approved.actorId) return false
    return typeof raw.performanceInstruction === 'string' && raw.performanceInstruction.split(/[，。；;\n]/).some(clause => {
      const actual = parseGroupPerformance(clause, declarations)
      return actual?.actorId === approved.actorId && actual.predicate === approved.predicate
    })
  })
}

/** Parse a metadata audio declaration such as “群体齐声应和：原台词”.
 * Both the real audioText line and same-source speech must retain every word. */
export function scriptedGroupAudioCovers(anchor: string, shot: Value, sourceBeatId: unknown): boolean | undefined {
  const pacing = object(shot.pacing) ? shot.pacing : {}, match = anchor.match(/^([^：:]+)[：:]\s*(.+)$/)
  if (!match || !Array.isArray(pacing.beats) || typeof shot.audioText !== 'string') return undefined
  const performance = parseGroupPerformance(match[1], pacing.actorGroups)
  const actorId = performance?.actorId ?? resolveAnonymousGroupSpeaker(match[1], pacing.actorGroups)
  if (!actorId) return undefined
  const transcript = shot.audioText.split(/\r?\n/).some(line => {
    const actual = line.match(/^([^：:]+)[：:]\s*(.+)$/)
    return actual && resolveAnonymousGroupSpeaker(actual[1], pacing.actorGroups) === actorId && tokens(actual[2]) === tokens(match[2])
  })
  const assigned = pacing.beats.filter(object).filter(beat => beat.sourceBeatId === sourceBeatId && object(beat.completion) && beat.completion.requiredThisClip === true)
  return transcript && assigned.some(beat => beat.kind === 'speech' && beat.deliveryStyle !== 'narration'
    && Array.isArray(beat.actorIds) && beat.actorIds.length === 1 && beat.actorIds[0] === actorId
    && typeof beat.textOrVocalization === 'string' && tokens(beat.textOrVocalization) === tokens(match[2])
    && (!performance || scriptedGroupPerformanceCovers(match[1], [beat], pacing.actorGroups) === true))
}

/** A writer occasionally copies an approved performance header into speech.
 * Separate it only when the original transcript independently fixes both the
 * same group's complete words and the source's performance. No text is lost. */
export function repairGroupSpeechPerformance(value: unknown, expected: Value) {
  if (!object(value) || !object(value.pacing) || value.scheduleHash || value.pacing.scheduleHash
    || !Array.isArray(value.pacing.beats) || typeof value.audioText !== 'string' || !object(expected.scene)
    || !Array.isArray(expected.scene.requiredBeats)) return undefined
  const candidate = structuredClone(value), pacing = candidate.pacing as Value
  const changes: Value[] = [], declarations = pacing.actorGroups
  for (const [index, beat] of (pacing.beats as Value[]).entries()) {
    if (!object(beat) || beat.kind !== 'speech' || beat.deliveryStyle === 'narration' || typeof beat.textOrVocalization !== 'string'
      || !Array.isArray(beat.actorIds) || beat.actorIds.length !== 1) continue
    const match = beat.textOrVocalization.match(/^([^：:]+)[：:]\s*(.+)$/)
    const performance = match && parseGroupPerformance(match[1], declarations)
    if (!match || !performance || performance.actorId !== beat.actorIds[0]) continue
    const source = expected.scene.requiredBeats.find(raw => object(raw) && raw.id === beat.sourceBeatId)
    if (!object(source) || !Array.isArray(source.mustShow) || !source.mustShow.some(anchor => {
      const approved = typeof anchor === 'string' ? parseGroupPerformance(anchor, declarations) : undefined
      return approved?.actorId === performance.actorId && approved.predicate === performance.predicate
    })) continue
    const lines = value.audioText.split(/\r?\n/).map(line => line.match(/^([^：:]+)[：:]\s*(.+)$/))
      .filter(line => line && resolveAnonymousGroupSpeaker(line[1], declarations) === performance.actorId)
    if (lines.length !== 1 || tokens(lines[0]![2]) !== tokens(match[2])) continue
    const before = { textOrVocalization: beat.textOrVocalization, performanceInstruction: beat.performanceInstruction }
    beat.textOrVocalization = match[2]
    if (scriptedGroupPerformanceCovers(match[1], [beat], declarations) !== true) beat.performanceInstruction = [beat.performanceInstruction, match[1]].filter(Boolean).join('；')
    changes.push({ path: `pacing.beats[${index}]`, before, after: { textOrVocalization: beat.textOrVocalization, performanceInstruction: beat.performanceInstruction }, source: 'source-backed-performance-header' })
  }
  return changes.length ? { candidate, changes } : undefined
}
