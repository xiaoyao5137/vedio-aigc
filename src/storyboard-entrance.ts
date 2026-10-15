import type { DurationBeat, DurationScheduleRow } from './duration-schedule.ts'

type EntranceAction = Pick<DurationBeat, 'kind' | 'actorIds' | 'textOrVocalization' | 'performanceInstruction'>
export type StoryboardEntrance = { name: string; startSecond: number; endSecond: number; path: string }

/** A reference first frame must show the origin of an immediately starting
 * travel action. Otherwise the image gate cannot verify the actor's state. */
export function openingTravelVisibilityIssue(shot: {
  continuity?: { mode?: string }; firstFrameMode?: string;
  enteringCharacters?: StoryboardEntrance[];
  pacing?: { beats?: EntranceAction[]; schedule?: DurationScheduleRow[] }
}): string | undefined {
  if (shot.continuity?.mode !== 'scene_cut' || shot.firstFrameMode !== 'reference') return
  const beats = shot.pacing?.beats ?? []
  const schedule = shot.pacing?.schedule ?? []
  for (const entry of shot.enteringCharacters ?? []) {
    if (entry.startSecond > 0.1) continue
    const travel = beats.find(beat => beat.kind === 'action'
      && beat.actorIds?.includes(entry.name)
      && /押|跨|走|步|进入|行进|移动|靠近|抵达/.test(
        `${beat.textOrVocalization ?? ''} ${beat.performanceInstruction ?? ''}`)
      && Number(schedule.find(row => row.beatId === (beat as DurationBeat).id)?.startSecond ?? 0) <= 0.1)
    if (travel) return entry.name
  }
}
const interior = /入内|(?:走入|步入|进入)(?:室内|屋内|殿内|厅内|堂内|院内)|推门而入|掀帘而入/
const onScreen = /入画|(?:走入|步入|进入)画面/
// A directional authored path can terminate at a person, an outdoor place or
// a room. Match the Chinese locomotion family instead of maintaining a brittle
// list of whole words: record-qrk0ny used “走向”, while record-4i9zhu used the
// equally executable “走至” twenty times. Riding/driving use the same directional
// complements: an actor riding into an outdoor foreground is still entering.
// The exact path, actor binding and
// non-performance guards below still prevent plans, observations and another
// subject's movement from counting as an entrance.
const routeMotion = /(?:走|步|行|跑|奔|趋|移|骑(?:马)?|驾(?:车|舟|船)?|乘(?:马|车|舟|船))(?:来|近|向|至|入|进|到)|来到|抵达|靠近|现身/
const notPerformed = /未|没有|并不|不能|不可|不再|不要|禁止|不得|不(?:从|沿|走|步|骑|驾|乘|曾|会|能|想|肯|愿|准)|(?:不|勿|莫)$|拒绝|准备|打算|即将|等待|目送|察觉|看见|看到|注视|凝视|看着|望着|盯着|目睹|观望|目光|示意|要求|让|命令|提到|提及|转述|假装|仿佛|想象|回忆/
const prohibitedMotion = /禁止|不得|不能|不可|不要|不准|没有|并未|未|不通过/
function clausePrefix(text: string, end: number) {
  return text.slice(0, end).split(/[，,。；;\n]/).at(-1) ?? ''
}
function hasPerformedPredicate(text: string, predicate: RegExp, actor: string, inheritedActor = false) {
  return [...text.matchAll(new RegExp(predicate.source, 'g'))].some(match => {
    const prefix = clausePrefix(text, match.index!).trim()
    // Bind the entering subject in this comma clause. Mentioning the actor in
    // an earlier clause, or watching somebody else's entrance, is insufficient.
    // An actor-bound path may omit its repeated subject: "甲持简册，从门外入内".
    const coordinatedCarry = inheritedActor && /^(?:扶着|搀扶着?|牵着|携着?|带着|领着|护着).*(?:从|沿)/.test(prefix)
    return (!prefix || prefix.startsWith(actor) || /^(?:从|沿)/.test(prefix) || coordinatedCarry) && !notPerformed.test(prefix)
  })
}
function hasImpossibleMotion(text: string) {
  return [...text.matchAll(/闪现|瞬移|切镜/g)].some(match => !prohibitedMotion.test(clausePrefix(text, match.index!)))
}
function performedEntrancePath(text: string, path: string, actor: string) {
  const pathStart = text.indexOf(path)
  if (pathStart < 0) return false
  // Bind the performed predicate to this path's own comma clauses. Another
  // positive entry later in the same action cannot vindicate a negated path.
  const before = text.slice(0, pathStart)
  const start = Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1
  const afterStart = pathStart + path.length
  const nextBoundary = text.slice(afterStart).search(/[，,]/)
  const scope = text.slice(start, nextBoundary < 0 ? undefined : afterStart + nextBoundary)
  const inheritedActor = text.trim().startsWith(actor) && !notPerformed.test(text.slice(0, pathStart))
  const lead = text.slice(start, pathStart).trim()
  const coordinatedLead = inheritedActor && /^(?:扶着|搀扶着?|牵着|携着?|带着|领着|护着)/.test(lead)
  // Bind the whole exact path before inspecting its internal comma clauses.
  // Otherwise a later complement such as “，走至案前” could incorrectly
  // rescue “没有从门外……” or another subject performing the same path.
  const pathSubjectBound = lead
    ? (lead.startsWith(actor) && !notPerformed.test(lead)) || coordinatedLead
    : inheritedActor || text.trim().startsWith(path)
  if (!pathSubjectBound) return false
  return hasPerformedPredicate(scope, interior, actor) || hasPerformedPredicate(scope, onScreen, actor)
    || /^(?:从|沿)/.test(path) && hasPerformedPredicate(scope, routeMotion, actor, inheritedActor)
}

function actionClauses(beat: EntranceAction, actor: string) {
  if (beat.kind !== 'action' || !beat.actorIds.includes(actor)) return []
  return [beat.textOrVocalization, beat.performanceInstruction].filter((text): text is string => typeof text === 'string')
    .flatMap(text => text.split(/[。；;\n]/)).filter(text => {
      // A positive teleport/cut still contradicts continuous entry. A later
      // prohibition ("禁止闪现") or speech restriction ("尚未开口") does not
      // negate the preceding physical action.
      if (hasImpossibleMotion(text)) return false
      // An actor-bound path can omit the name. A differently named subject,
      // reaction, hypothetical event or a completion claim cannot prove entry.
      return text.includes(actor) || /^(?:从|沿|入内|入画|走入|步入|进入|推门而入|掀帘而入)/.test(text.trim())
    })
}

/** Only a simple approved actor + entrance predicate is canonicalized. Props,
 * destinations, simultaneous acts and all other source anchors stay literal. */
export function executableEntranceAnchor(anchor: string, beats: EntranceAction[]): boolean | undefined {
  const actor = [...new Set(beats.flatMap(beat => beat.actorIds))].find(name => anchor.startsWith(name)
    && /^(?:入内|入画|走入画面|步入画面|进入画面|走入室内|步入室内|进入室内)$/.test(anchor.slice(name.length)))
  if (!actor) return undefined
  const predicate = /室内|入内/.test(anchor.slice(actor.length)) ? interior : onScreen
  return beats.some(beat => actionClauses(beat, actor).some(text => hasPerformedPredicate(text, predicate, actor)))
}

/** Match authored entrance metadata to one executable action, never to the
 * discarded hand-written timeline or to completion/evidence declarations. */
export function matchingEntranceActions<T extends EntranceAction>(entry: StoryboardEntrance, beats: T[]): T[] {
  return beats.filter(beat => actionClauses(beat, entry.name).some(text => performedEntrancePath(text, entry.path, entry.name)))
}

type Value = Record<string, unknown>
const record = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** Anonymous groups are performers, not continuity-tracked character assets.
 * Remove only redundant identity metadata when its complete authored entrance
 * is independently executed by one source-grounded group action. The alias is
 * used solely for that proof; neither the original group binding nor any body,
 * voice, dependency or timing declaration is rewritten. */
export function normalizeStoryboardAnonymousEntranceIdentities(value: unknown, expected: Value) {
  if (!record(value) || !record(value.pacing) || value.pacing.version !== 'duration-v2'
    || value.scheduleHash !== undefined || value.pacing.scheduleHash !== undefined
    || !Array.isArray(value.pacing.actorGroups) || !Array.isArray(value.pacing.beats)
    || !Array.isArray(value.enteringCharacters) || !record(expected.scene)
    || !Array.isArray(expected.scene.cast) || !Array.isArray(expected.scene.requiredBeats)) return undefined
  const scene = expected.scene, previous = record(expected.previousShot) ? expected.previousShot : {}
  const protectedNames = new Set([...strings(scene.cast),
    ...(scene.continuityFromPrevious === true ? strings(previous.presentCharacters) : [])])
  const groups = value.pacing.actorGroups.filter(record), beats = value.pacing.beats.filter(record)
  const sourceBeats = (scene.requiredBeats as unknown[]).filter(record)
  const proofs: Array<{ groupId: string; label: string; sourceBeatId: string; beatId: string; entrance: StoryboardEntrance }> = []
  const removable = new Set<string>()
  for (const group of groups) {
    if (typeof group.id !== 'string' || !group.id.trim() || typeof group.label !== 'string' || !group.label.trim() || group.id === group.label
      || typeof group.memberDescription !== 'string' || !group.memberDescription.trim()
      || protectedNames.has(group.id) || [...protectedNames].some(name => name.includes(String(group.label)))
      || groups.some(other => other !== group && [other.id, other.label].some(alias => alias === group.id || alias === group.label))) continue
    const aliases = new Set([group.id, group.label])
    const entries = value.enteringCharacters.filter(entry => record(entry) && aliases.has(String(entry.name)))
    if (entries.length !== 1 || entries.some(entry => !record(entry)
      || Object.keys(entry).some(key => !['name', 'startSecond', 'endSecond', 'path'].includes(key))
      || typeof entry.name !== 'string' || !entry.name.trim()
      || typeof entry.path !== 'string' || !entry.path.trim()
      || typeof entry.startSecond !== 'number' || typeof entry.endSecond !== 'number'
      || !Number.isFinite(entry.startSecond) || !Number.isFinite(entry.endSecond)
      || entry.startSecond < 0 || entry.endSecond <= entry.startSecond)) continue
    // An observed group fact is more than redundant identity metadata. Leave
    // it for explicit author repair instead of losing a declared physical fact.
    const world = record(value.worldState) ? value.worldState : {}
    if (Array.isArray(world.characters) && world.characters.some(row => record(row) && aliases.has(String(row.name))
      && !['position', 'heldProps', 'pendingAction'].every(key => record(row[key]) && row[key].status === 'unknown'
        && !Object.hasOwn(row[key], 'value')
        && (row[key].evidence === undefined || row[key].evidence === null || typeof row[key].evidence === 'string')))) continue
    const groupProofs = entries.flatMap(raw => {
      const entry = raw as StoryboardEntrance
      const eligible = beats.filter(beat => beat.kind === 'action' && Array.isArray(beat.actorIds)
        && beat.actorIds.includes(group.id) && beat.actorIds.every(id => typeof id === 'string')
        && typeof beat.id === 'string' && typeof beat.sourceBeatId === 'string'
        && typeof beat.textOrVocalization === 'string'
        && (beat.performanceInstruction === undefined || typeof beat.performanceInstruction === 'string'))
      const matches = eligible.filter(beat => {
        const sources = sourceBeats.filter(source => source.id === beat.sourceBeatId)
        if (sources.length !== 1) return false
        const source = sources[0], observable = record(source.observable) ? source.observable : {}
        const approved = [source.description, source.function, source.stateChange,
          ...strings(source.mustShow), ...strings(observable.visual)].filter((text): text is string => typeof text === 'string')
        if (!approved.some(text => text.includes(group.label as string))) return false
        const proofBeat = { ...beat, actorIds: (beat.actorIds as string[]).map(id => id === group.id ? String(group.label) : id) } as EntranceAction
        return matchingEntranceActions({ ...entry, name: String(group.label) }, [proofBeat]).length === 1
      })
      return matches.length === 1 ? [{ groupId: String(group.id), label: String(group.label),
        sourceBeatId: String(matches[0].sourceBeatId), beatId: String(matches[0].id), entrance: structuredClone(entry) }] : []
    })
    if (groupProofs.length !== entries.length) continue
    // Voice-bearing entrants stay on the existing arrival/voice timing gate.
    // This narrow metadata projection never removes that protection.
    if (beats.some(beat => ['speech', 'vocalization'].includes(String(beat.kind))
      && strings(beat.actorIds).some(id => aliases.has(id)))) continue
    groupProofs.forEach(proof => proofs.push(proof))
    aliases.forEach(alias => removable.add(alias))
  }
  if (!removable.size) return undefined
  const candidate = { ...value }, changes: Array<{ path: string; before: unknown; after: unknown;
    reason: string; proofs: typeof proofs }> = []
  const project = (path: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ path, before: structuredClone(before),
      after: structuredClone(after), reason: 'source-grounded-anonymous-entrance-identity', proofs })
    return after
  }
  for (const key of ['characters', 'presentCharacters', 'initialCharacters', 'endCharacters']) {
    if (Array.isArray(value[key])) candidate[key] = project(key, value[key], value[key].filter(name => typeof name !== 'string' || !removable.has(name)))
  }
  candidate.enteringCharacters = project('enteringCharacters', value.enteringCharacters,
    value.enteringCharacters.filter(entry => !record(entry) || !removable.has(String(entry.name))))
  if (record(value.worldState) && Array.isArray(value.worldState.characters)) candidate.worldState = { ...value.worldState,
    characters: project('worldState.characters', value.worldState.characters,
      value.worldState.characters.filter(row => !record(row) || !removable.has(String(row.name)))) }
  return changes.length ? { candidate, changes } : undefined
}

/** Duration-v2 owns the only clock. Keep the actual action/path and project its
 * unique verified window instead of making a writer copy compiler estimates. */
export function projectStoryboardEntrances(entries: StoryboardEntrance[], compiled: {
  pacing: { beats: DurationBeat[]; timingPolicy: { endingReadabilityReserve: number } }
  schedule: DurationScheduleRow[]; duration: number; scheduleHash: string
}) {
  const changes: Array<{ characterName: string; beatId: string; path: string;
    declared: { startSecond: number; endSecond: number }; scheduled: { startSecond: number; endSecond: number } }> = []
  const enteringCharacters = entries.map(entry => {
    const matches = matchingEntranceActions(entry, compiled.pacing.beats)
    if (matches.length !== 1) throw new Error(`STORYBOARD_PROMPT_OVERLOAD: 入场人物“${entry.name}”的路径“${entry.path}”匹配 ${matches.length} 个可执行入场动作，必须唯一匹配；完整 path 须写在该人物 action 的 textOrVocalization 或 performanceInstruction，不能只写在手工 videoPrompt 或完成声明中`)
    const windows = compiled.schedule.filter(row => row.beatId === matches[0].id)
    if (windows.length !== 1) throw new Error(`STORYBOARD_PROMPT_OVERLOAD: 入场人物“${entry.name}”缺少唯一编译入场窗口`)
    const window = windows[0]
    const premature = compiled.schedule.find(row => ['speech', 'vocalization'].includes(row.kind)
      && row.actorIds.includes(entry.name) && row.startSecond < window.endSecond - .001)
    if (premature) throw new Error(`STORYBOARD_PACING_INVALID: ${entry.name} 真正入场须在 ${window.endSecond} 秒完成后再发声，${premature.beatId} 却从 ${premature.startSecond} 秒开始；保留原动作并修复入场与声部依赖`)
    if (window.endSecond > compiled.duration - compiled.pacing.timingPolicy.endingReadabilityReserve + .001) {
      throw new Error(`STORYBOARD_PROMPT_OVERLOAD: 入场人物“${entry.name}”的实际入场动作超出本镜可执行时间`)
    }
    const scheduled = { startSecond: window.startSecond, endSecond: window.endSecond }
    if (entry.startSecond !== scheduled.startSecond || entry.endSecond !== scheduled.endSecond) changes.push({
      characterName: entry.name, beatId: window.beatId, path: entry.path,
      declared: { startSecond: entry.startSecond, endSecond: entry.endSecond }, scheduled,
    })
    return { ...entry, ...scheduled }
  })
  return { enteringCharacters, ...(changes.length ? { projection: { version: 'duration-v2-entrance-v1', scheduleHash: compiled.scheduleHash, changes } } : {}) }
}
