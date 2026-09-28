type Value = Record<string, unknown>
const record = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const rows = (value: unknown): Value[] => Array.isArray(value) ? value.flatMap(item => record(item) ? [record(item)!] : []) : []
const speakerName = (value: string) => value.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
const anonymousRole = /弟子|病患|病者|百姓|村民|群众|灾民|饥民|流民|信众|徒众|军士|士卒|宾客|门客|家属|侍从|官吏|群臣|民众|人群/
const subjectIs = (text: string, name: string) => {
  const start = text.trim().replace(/^(?:一名|一位|一个|数名|多名|部分|有些|众多|一|有)/, '')
  return start.startsWith(name) && !/^[的之]/.test(start.slice(name.length))
}

/** Restore an anonymous speaker's binding only when the unmodified transcript
 * has one unique matching voice line and the same approved source beat names
 * that role as a visual subject. A crowd addressed by the speaker cannot own
 * their voice or their body. Neither words nor authored actions are rewritten. */
export function repairStoryboardAnonymousSpeakerBindings(value: unknown, expected: Value) {
  const shot = record(value), scene = record(expected.scene), pacing = record(shot?.pacing)
  if (!shot || !scene || !pacing || shot.audioType !== '对白' || typeof shot.audioText !== 'string'
    || pacing.version !== 'duration-v2' || pacing.scheduleHash !== undefined || shot.scheduleHash !== undefined
    || !Array.isArray(scene.cast) || !Array.isArray(pacing.beats) || !Array.isArray(pacing.actorGroups)) return undefined
  const named = new Set([...strings(scene.cast), ...strings(shot.characters), ...strings(shot.presentCharacters),
    ...(scene.continuityFromPrevious === true ? strings(record(expected.previousShot)?.presentCharacters) : [])])
  const originalGroups = rows(pacing.actorGroups), groups = [...originalGroups]
  if (originalGroups.length !== pacing.actorGroups.length || rows(pacing.beats).length !== pacing.beats.length) return undefined
  const source = new Map(rows(scene.requiredBeats).map(beat => [String(beat.id), beat]))
  const transcript = shot.audioText.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*([^：:]+)[：:]\s*(.+)$/)
    return match ? [{ speaker: speakerName(match[1]), text: match[2].trim() }] : []
  })
  const bindings: Array<{ beatId: unknown; sourceBeatId: unknown; from: string; to: string; speaker: string }> = []
  const beats = rows(pacing.beats)
  for (const beat of beats) {
    if (beat.kind !== 'speech' || beat.deliveryStyle === 'narration' || typeof beat.textOrVocalization !== 'string') continue
    const matches = transcript.filter(line => line.text === String(beat.textOrVocalization).trim())
    if (matches.length !== 1 || beats.filter(other => other.kind === 'speech' && other.textOrVocalization === beat.textOrVocalization).length !== 1) continue
    const name = matches[0].speaker, approved = source.get(String(beat.sourceBeatId))
    if (!name || named.has(name) || !anonymousRole.test(name) || !approved) continue
    const visuals = [...strings(record(approved.observable)?.visual), ...strings(approved.mustShow),
      ...(typeof approved.description === 'string' ? approved.description.split(/[，,；;。]/) : [])]
    if (!visuals.some(anchor => subjectIs(anchor, name))) continue
    const actorIds = strings(beat.actorIds)
    if (actorIds.length !== 1 || named.has(actorIds[0])) continue
    const current = originalGroups.find(group => group.id === actorIds[0])
    if (!current) continue
    // Do not merge two differently qualified roles (for example 两名弟子
    // versus 传道弟子). Only a clearly different anonymous subject is rebound.
    if (typeof current.label !== 'string' || current.label.includes(name) && current.label !== name) continue
    let group = groups.find(group => group.label === name)
    if (!group) {
      let id = `group-${name}`, suffix = 2
      while (groups.some(group => group.id === id) || named.has(id)) id = `group-${name}-${suffix++}`
      group = { id, label: name, memberDescription: `已批准场景中的匿名发声者：${name}` }
      groups.push(group)
    }
    bindings.push({ beatId: beat.id, sourceBeatId: beat.sourceBeatId, from: actorIds[0], to: String(group.id), speaker: name })
  }
  const changes: Array<{ path: string; reason: string; before: string[]; after: string[]; sourceBeatId: unknown }> = []
  const nextBeats = pacing.beats.map((value, index) => {
    const beat = record(value)
    if (!beat) return value
    const actorIds = strings(beat.actorIds)
    if (actorIds.length !== 1) return value
    const matches = bindings.filter(binding => beat.sourceBeatId === binding.sourceBeatId && actorIds[0] === binding.from
      && (beat.id === binding.beatId || ['action', 'reaction'].includes(String(beat.kind))
        && typeof beat.textOrVocalization === 'string' && subjectIs(beat.textOrVocalization, binding.speaker)))
    if (matches.length !== 1 || actorIds[0] === matches[0].to) return value
    const after = [matches[0].to]
    changes.push({ path: `pacing.beats[${index}].actorIds`, reason: 'restored-source-grounded-anonymous-speaker',
      before: actorIds, after, sourceBeatId: beat.sourceBeatId })
    return { ...beat, actorIds: after }
  })
  if (!changes.length) return undefined
  return { candidate: { ...shot, pacing: { ...pacing, actorGroups: groups, beats: nextBeats } }, changes }
}
