import { boundaryText, canonicalJson, HISTORY_DRAMA_VERSION } from './history-drama.ts'

type Value = Record<string, unknown>
const record = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const list = (value: unknown): Value[] => Array.isArray(value) ? value.map(record) : []
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right)
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const lockRefs = (person: Value) => [...strings(person.historicalLockIds), ...strings(record(person.coreMotivation).historicalLockIds)]

function preserveApprovedBeats(candidate: Value[], original: Value[]) {
  for (const beat of original) {
    const revised = candidate.filter(item => (item.id ?? item.beatId) === (beat.id ?? beat.beatId))
    if (!revised.length) throw new Error('HISTORY_REPAIR_INVALID: 局部修复删除了已批准节拍')
    for (const channel of ['visual', 'audio']) {
      const anchors = record(beat.observable)[channel] ?? beat[channel]
      if (strings(anchors).some(anchor => !revised.some(item => strings(record(item.observable)[channel] ?? item[channel]).includes(anchor)))) {
        throw new Error('HISTORY_REPAIR_INVALID: 局部修复不得删除已批准的声画义务')
      }
    }
  }
}

/** Carry only a corrected inherited state into later scenes. Their own actions
 * and state deltas are preserved; the writer cannot use dependency maintenance
 * to rewrite a later scene's plot. */
function rebaseState(before: Value, after: Value, inherited: Value) {
  return Object.fromEntries(['knowledge', 'relationships', 'choices'].map(key => {
    const oldBefore = strings(before[key]), oldAfter = strings(after[key])
    const removed = new Set(oldBefore.filter(value => !oldAfter.includes(value)))
    const added = oldAfter.filter(value => !oldBefore.includes(value))
    return [key, [...new Set([...strings(inherited[key]).filter(value => !removed.has(value)), ...added])]]
  }))
}

function propagateCharacterState(dramaValues: Value[], people: Value[]) {
  const previous = new Map(people.map(person => [person.name, record(person.initialState)]))
  return dramaValues.map(drama => ({ ...drama, characterStates: list(drama.characterStates).map(change => {
    const inherited = previous.get(change.name)
    if (!inherited) throw new Error('HISTORY_REPAIR_SCOPE_REQUIRED: 当前局部修复不能补齐人物状态，需 episode 范围修正人物与主线引用')
    const before = record(change.before), after = record(change.after)
    const next = same(before, inherited) ? change : { ...change, before: inherited, after: rebaseState(before, after, inherited) }
    previous.set(change.name, record(next.after))
    return next
  }) }))
}

/** Locks in an unapproved draft can themselves contain the factual error. Only
 * locks referenced by affected people, explicitly named in feedback, or sharing
 * a concrete phrase with the targeted scene enter the repair scope. */
function draftHistoricalLocks(original: Value, candidate: Value, affected: Set<string>, targetScenes: Value[], people: Value[], feedback: Value) {
  const oldPeople = list(original.characterDramas), newPeople = list(candidate.characterDramas)
  const relatedRefs = new Set([...oldPeople, ...newPeople].filter(person => affected.has(String(person.name))).flatMap(lockRefs))
  const normalize = (value: unknown) => String(value ?? '').replace(/[^\p{L}\p{N}]/gu, '')
  const sceneText = normalize(JSON.stringify(targetScenes))
  const feedbackText = JSON.stringify(feedback.issues ?? [])
  const originalLocks = list(original.historicalLocks), proposed = list(candidate.historicalLocks)
  const replaceable = new Set(originalLocks.filter(lock => {
    const fact = normalize(lock.fact)
    return relatedRefs.has(String(lock.id)) || feedbackText.includes(String(lock.id))
      || [...fact].some((_, index) => index + 4 <= fact.length && sceneText.includes(fact.slice(index, index + 4)))
  }).map(lock => String(lock.id)))
  const used = new Set(people.flatMap(lockRefs))
  const result = originalLocks.flatMap(lock => {
    if (!replaceable.has(String(lock.id))) return [lock]
    const replacement = proposed.find(item => item.id === lock.id)
    return replacement ? [replacement] : used.has(String(lock.id)) ? [lock] : []
  })
  for (const lock of proposed) if (!originalLocks.some(item => item.id === lock.id) && relatedRefs.has(String(lock.id))) result.push(lock)
  if (!result.length || people.some(person => lockRefs(person).some(id => !result.some(lock => lock.id === id)))) {
    throw new Error('HISTORY_REPAIR_SCOPE_REQUIRED: 局部史实纠错缺少相关事实来源或人物引用，需 episode 范围统一本集史实')
  }
  return result
}

/** Created by the executor, never accepted from a writer's JSON. It travels with
 * the candidate because retry feedback is intentionally local to the writer. */
export function dramaRepairProvenance(feedbackValue: unknown, attempt = 1) {
  const feedback = record(feedbackValue)
  const previous = record(record(feedback.previousCandidate).repairProvenance)
  const parent = Number(previous.candidateVersion ?? feedback.parentCandidateVersion ?? 0)
  const episodeRewriteCount = Number(feedback.episodeRewriteCount ?? previous.episodeRewriteCount ?? 0)
  if (!Number.isInteger(parent) || parent < 0 || !Number.isInteger(episodeRewriteCount) || episodeRewriteCount < 0 || episodeRewriteCount > 1) {
    throw new Error('DRAMA_REPAIR_LIMIT: 整集重构次数或候选版本无效，保留证据并停止')
  }
  return { scope: String(feedback.scope ?? feedback.repairScope ?? 'initial'), episodeRewriteCount,
    candidateVersion: parent + 1, parentCandidateVersion: parent, attempt }
}

/** adaptationSpace.policy/sourceLevel hold the user's own words, so a repair may only echo
 * them; allowed/forbidden are the writer's elaboration of that rule and legitimately grow while
 * scenes are repaired. Comparing the whole object with JSON.stringify aborted a correct repair
 * over one half-width semicolon or a reordered key (record-14lmio), and local scopes restore
 * the trusted value below anyway — the abort bought no safety, only a wasted paid generation. */
function preserveAdaptationBoundary(candidate: Value, original: Value): Value {
  const trusted = record(original.adaptationSpace), echoed = record(candidate.adaptationSpace)
  for (const key of ['policy', 'sourceLevel']) {
    if (boundaryText(trusted[key]) === boundaryText(echoed[key])) continue
    throw new Error(`HISTORY_REPAIR_INVALID: 修复不得放宽本集用户改编边界（adaptationSpace.${key} 被改写）`)
  }
  // Trivial orthographic echoes are repaired, not punished: the contract validator would
  // restore the same trusted text one step later.
  const restorations: [string, unknown][] = ['policy', 'sourceLevel']
    .filter(key => typeof trusted[key] === 'string' && String(trusted[key]).trim() && trusted[key] !== echoed[key])
    .map(key => [key, trusted[key]])
  return restorations.length ? { ...candidate, adaptationSpace: { ...echoed, ...Object.fromEntries(restorations) } } : candidate
}

/** Limit semantic rewrites before validation. Untargeted material is preserved
 * mechanically instead of trusting a model to faithfully echo a long episode. */
export function applyScopedDramaRepair(candidateValue: unknown, feedbackValue: unknown, context: Value = {}) {
  const candidate = record(candidateValue), feedback = record(feedbackValue)
  const original = record(feedback.previousCandidate)
  if (candidate.contentContractVersion !== HISTORY_DRAMA_VERSION || original.contentContractVersion !== HISTORY_DRAMA_VERSION) return candidate
  const scope = String(feedback.scope ?? feedback.repairScope ?? 'scene')
  if (!['scene', 'dramaticScene', 'episode'].includes(scope)) throw new Error('HISTORY_REPAIR_INVALID: 未知修复范围')
  const approved = record(context.approved_scene_outline)
  const locked = approved.contentContractVersion === HISTORY_DRAMA_VERSION && Array.isArray(approved.scenes)
  if (!Array.isArray(candidate.scenes)) {
    const fixed = { ...candidate }
    // A shot cannot revise the approved episode or substitute another task.
    for (const key of ['id', 'dramaticSceneId', 'contentContractVersion']) fixed[key] = original[key]
    if (locked) {
      const scene = record(context.scene)
      const sourceId = scene.sourceSceneId ?? scene.id ?? original.id
      const source = list(approved.scenes).find(item => item.id === sourceId)
      if (!source) throw new Error('HISTORY_REPAIR_INVALID: 分镜修复缺少已批准场景映射')
      // Expanded scenes already contain their allocated subset; the original
      // outline remains the provenance for that allocation.
      preserveApprovedBeats(list(fixed.beatDramaturgy), list(scene.requiredBeats ?? source.requiredBeats))
    }
    return fixed
  }
  if (scope === 'episode') {
    const bounded = preserveAdaptationBoundary(candidate, original)
    dramaRepairProvenance(feedback)
    if (record(context.video_take).url || record(context.video_shot).url || list(record(context.video_shot).items).length) {
      throw new Error('DRAMA_REPAIR_AFTER_MEDIA: 已有媒体，整集重构不能自动启动')
    }
    if (locked && !same(bounded.historicalLocks, approved.historicalLocks)) {
      throw new Error('HISTORY_REPAIR_INVALID: 整集重构不得改写已锁定史实及其来源')
    }
    return bounded
  }
  const oldScenes = list(original.scenes), newScenes = list(candidate.scenes)
  const issues = list(feedback.issues)
  const targetIds = new Set(issues.map(issue => String(issue.itemId ?? '')))
  const affectedDramas = new Set(oldScenes.filter(scene => targetIds.has(String(scene.id)) || targetIds.has(String(scene.dramaticSceneId))).map(scene => scene.dramaticSceneId))
  if (!affectedDramas.size) throw new Error('HISTORY_REPAIR_INVALID: 审查没有定位当前场景，不能无目标重写')
  if (scope === 'dramaticScene') for (const scene of oldScenes) if (affectedDramas.has(scene.dramaticSceneId)) targetIds.add(String(scene.id))
  const replacements = new Map(newScenes.map(scene => [scene.id, scene]))
  const merged = oldScenes.flatMap(scene => {
    if (!targetIds.has(String(scene.id))) return [scene]
    const replacement = replacements.get(scene.id)
    if (!replacement) throw new Error(`HISTORY_REPAIR_INVALID: 修复遗漏场景 ${String(scene.id)}`)
    const parts = newScenes.filter(part => String(part.id).startsWith(`${String(scene.id)}-part-`))
    if (locked) preserveApprovedBeats([replacement, ...parts].flatMap(part => list(part.requiredBeats)), list(scene.requiredBeats))
    if ([replacement, ...parts].some(part => part.dramaticSceneId !== scene.dramaticSceneId)) throw new Error('HISTORY_REPAIR_INVALID: 局部修复不能改变完整戏归属')
    return [replacement, ...parts]
  })
  const dramas = list(original.dramaticScenes).map(drama => affectedDramas.has(drama.id)
    ? list(candidate.dramaticScenes).find(item => item.id === drama.id) ?? drama : drama)
  const targetedPart = (scene: Value) => targetIds.has(String(scene.id)) || [...targetIds].some(id => String(scene.id).startsWith(`${id}-part-`))
  const relatedCharacters = new Set([...oldScenes.filter(scene => targetIds.has(String(scene.id))), ...merged.filter(targetedPart)].flatMap(scene => strings(scene.cast)))
  const stillUsed = new Set(merged.flatMap(scene => strings(scene.cast)))
  const people = locked ? list(approved.characterDramas) : list(original.characterDramas).flatMap(person => {
    if (!relatedCharacters.has(String(person.name))) return [person]
    const replacement = list(candidate.characterDramas).find(item => item.name === person.name)
    return replacement ? [replacement] : stillUsed.has(String(person.name)) ? [person] : []
  })
  if (!locked) for (const person of list(candidate.characterDramas)) if (relatedCharacters.has(String(person.name)) && !people.some(item => item.name === person.name)) people.push(person)
  if (strings(record(original.episodeDrama).viewpointCharacters).some(name => !people.some(person => person.name === name))) {
    throw new Error('HISTORY_REPAIR_SCOPE_REQUIRED: 纠正主体需要调整本集视角人物，须用 episode 范围修复，不能继续重复局部改写')
  }
  const historicalLocks = locked ? approved.historicalLocks : draftHistoricalLocks(original, candidate, relatedCharacters, oldScenes.filter(scene => targetIds.has(String(scene.id))), people, feedback)
  return { ...candidate, episodeTitle: original.episodeTitle, historicalLocks,
    adaptationSpace: original.adaptationSpace, episodeDrama: original.episodeDrama,
    characterDramas: people, dramaticScenes: locked ? dramas : propagateCharacterState(dramas, people),
    scenes: merged.map((scene, index) => ({ ...scene, sequence: index + 1 })) }
}

export function attachDramaRepairProvenance(output: unknown, feedback: unknown, attempt = 1) {
  const candidate = record(output)
  return candidate.contentContractVersion === HISTORY_DRAMA_VERSION
    ? { ...candidate, repairProvenance: dramaRepairProvenance(feedback, attempt) } : output
}
