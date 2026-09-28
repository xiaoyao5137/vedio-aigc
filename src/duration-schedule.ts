import { DURATION_PACING_VERSION, durationCanonicalJson, durationContentHash, estimateSpeechDuration, resolveDurationPolicy } from './duration-policy.ts'
import type { DeliveryStyle, DurationPolicy } from './duration-policy.ts'
import { executableEntranceAnchor } from './storyboard-entrance.ts'
import { executableVisualAction, readSourceVisualActions, sourceVisualActions } from './storyboard-visual-action.ts'
import type { SourceVisualAction } from './storyboard-visual-action.ts'
import { allowsEmptyEditorialCast, enactedVisualTextCovers } from './history-drama.ts'
import { isStaticIllustrationStyle, resolvedAnimationStyle } from './animation-shot.ts'
import { resolveAnonymousGroupSpeaker, scriptedGroupPerformanceCovers } from './storyboard-group-semantics.ts'
import { assertVoiceObligationCoverage } from './voice-obligation.ts'
import { isNonSpeechAudioObligation } from './outline-audio-contract.ts'

type Value = Record<string, unknown>
export type DurationBeat = {
  id: string; sourceBeatId: string; actorIds: string[]
  kind: 'action' | 'reaction' | 'speech' | 'vocalization'
  deliveryStyle?: DeliveryStyle; textOrVocalization: string
  performanceInstruction?: string
  dependsOn: string[]; overlapAllowedWith: string[]
  resources?: Array<'voice' | 'body' | 'hands' | 'attention'>
  durationEstimate: { lower: number; expected: number; upper: number; source: string; confidence: 'low' | 'medium' | 'high' }
  completion: { requiredThisClip: boolean; finalState: string; modality: 'visual' | 'audio' | 'audio-visual'; evidenceAnchor: string }
  timingConstraint?: { mode: 'reference' | 'hard'; notBeforeSecond?: number; deadlineSecond?: number }
  vocalization?: { vocalizationType: string; actorGroup: string; expectedAudibility: string; melodyRelation: string; completionCue: string }
}
export type DurationScheduleRow = {
  beatId: string; sourceBeatId: string; actorIds: string[]; kind: DurationBeat['kind']
  startSecond: number; endSecond: number; budgetSeconds: number
  timingConstraint: NonNullable<DurationBeat['timingConstraint']>
}
type Group = { id: string; label: string; memberDescription: string; voiceProfile?: string | Record<string, string> }
type SourceRequirement = { id: string; anchors: string[]; setting?: string; visualActions?: SourceVisualAction[]; environmentAnchors?: string[] }
type ExecutableBeat = Pick<DurationBeat, 'kind' | 'actorIds' | 'deliveryStyle' | 'textOrVocalization' | 'performanceInstruction' | 'vocalization'>
type CompileOptions = { scene?: Value; timingPolicy?: unknown; verifyStoredHash?: boolean; selectDuration?: boolean; qualityDisposition?: unknown }
const isRecord = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const useful = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(useful) && new Set(value).size === value.length
function invalid(message: string): never { throw new Error('STORYBOARD_PACING_INVALID: ' + message) }
function coverageInvalid(message: string): never { throw new Error('STORYBOARD_COVERAGE_INCOMPLETE: ' + message) }
function groupVoiceProfile(value: unknown): string | Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (useful(value) && Array.from(value).length <= 500) return value
  if (isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 12
    && Object.values(value).every(useful) && Array.from(JSON.stringify(value)).length <= 500) return { ...value } as Record<string, string>
  invalid('actorGroups.voiceProfile 必须为非空声音描述或不超过12项非空字符串属性、总长不超过500字符；禁止丢弃声线要求后继续生成')
}
function sourceCoverageSummary(expected: string[], actual: unknown[]) {
  const missing = expected.filter(id => !actual.includes(id))
  const unknown = [...new Set(actual.filter(id => typeof id !== 'string' || !expected.includes(id)))]
  const duplicate = [...new Set(actual.filter((id, index) => actual.indexOf(id) !== index))]
  return `expected=${JSON.stringify(expected)}；actual=${JSON.stringify(actual)}；missing=${JSON.stringify(missing)}；unknown=${JSON.stringify(unknown)}；duplicate=${JSON.stringify(duplicate)}`
}
const at = (second: number) => Math.round(second * 1000) / 1000
const spokenTokens = (text: string) => text.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '')
const voiceIdentity = (name: string) => name.replace(/（[^）]*）|\([^)]*\)/g,'').trim()
function speechBudgetBelowMinimum(actual: number, minimum: number) {
  // Keep the existing one-millisecond serialization allowance. Adding .001
  // directly turns 10.29 into 10.290999999999999 and wrongly rejects 10.291.
  // Only absorb floating-point roundoff; rounding to milliseconds would also
  // accept real shortfalls larger than one millisecond.
  const roundoff = Number.EPSILON * 4 * Math.max(1, Math.abs(actual), Math.abs(minimum))
  return minimum - actual > .001 + roundoff
}

function speechBudgetIssue(id: string, text: string, style: DeliveryStyle,
  estimate: { lower: number; expected: number; upper: number }, policy: DurationPolicy) {
  const base = estimateSpeechDuration(text, style, policy)
  return !base.characters || speechBudgetBelowMinimum(estimate.lower, base.lower)
    || speechBudgetBelowMinimum(estimate.expected, base.expected) || speechBudgetBelowMinimum(estimate.upper, base.upper)
    ? `${id} 声部预算低于 ${style} 共享策略：至少 ${base.lower}/${base.expected}/${base.upper} 秒，不能加速挤入短片` : undefined
}

/** Independent, read-only numeric diagnostics: a coverage or earlier beat
 * failure must not conceal the other known speech budgets. Unknown shapes and
 * unsupported speech remain the full compiler's responsibility. */
export function collectDurationSpeechBudgetDiagnostics(output: unknown, options: { timingPolicy?: unknown } = {}): string[] {
  if (!isRecord(output) || !isRecord(output.pacing) || output.pacing.version !== DURATION_PACING_VERSION
    || !Array.isArray(output.pacing.beats)) return []
  let policy: DurationPolicy
  try { policy = resolveDurationPolicy(options.timingPolicy ?? output.pacing.timingPolicy) } catch { return [] }
  const errors = new Set<string>()
  for (const beat of output.pacing.beats) {
    if (!isRecord(beat) || beat.kind !== 'speech' || !useful(beat.id) || !useful(beat.textOrVocalization)) continue
    const style = beat.deliveryStyle
    if (style !== 'dialogue' && style !== 'narration' && style !== 'chant' && style !== 'singing') continue
    const estimate = beat.durationEstimate
    if (!isRecord(estimate)) continue
    const { lower, expected, upper } = estimate
    if (typeof lower !== 'number' || typeof expected !== 'number' || typeof upper !== 'number'
      || ![lower, expected, upper].every(second => Number.isFinite(second) && second > 0)
      || lower > expected || expected > upper) continue
    try {
      const issue = speechBudgetIssue(beat.id, beat.textOrVocalization, style, { lower, expected, upper }, policy)
      if (issue) errors.add('STORYBOARD_PACING_INVALID: ' + issue)
    } catch { /* No language policy or usable text: do not invent a numeric diagnosis. */ }
  }
  return [...errors]
}

/** Voice-only lower bounds do not depend on character-reference or action
 * validation. Lexical speech beats cannot overlap; nonlexical vocalizations
 * can, so they are deliberately excluded from this independent sum. */
export function collectDurationVoiceLayoutDiagnostics(output: unknown, options: { timingPolicy?: unknown } = {}): string[] {
  if (!isRecord(output) || !isRecord(output.pacing) || output.pacing.version !== DURATION_PACING_VERSION
    || !Array.isArray(output.pacing.beats) || !output.pacing.beats.length) return []
  let policy: DurationPolicy
  try { policy = resolveDurationPolicy(options.timingPolicy ?? output.pacing.timingPolicy) } catch { return [] }
  const ids = new Set<string>(), identities = new Set<string>()
  const voices: Array<{ id: string; sourceBeatId: string; deliveryStyle: DeliveryStyle; upper: number; acceptedMinimum: number }> = []
  for (const beat of output.pacing.beats) {
    if (!isRecord(beat) || !useful(beat.id) || ids.has(beat.id)
      || !['speech', 'action', 'reaction', 'vocalization'].includes(String(beat.kind))) return []
    ids.add(beat.id)
    if (beat.kind !== 'speech') continue
    const style = beat.deliveryStyle
    if (!useful(beat.sourceBeatId) || !strings(beat.actorIds) || !beat.actorIds.length || !useful(beat.textOrVocalization)
      || (style !== 'dialogue' && style !== 'narration' && style !== 'chant' && style !== 'singing')
      || !isRecord(beat.completion) || beat.completion.requiredThisClip !== true || !isRecord(beat.durationEstimate)) return []
    const { lower, expected, upper } = beat.durationEstimate
    if (typeof lower !== 'number' || typeof expected !== 'number' || typeof upper !== 'number'
      || ![lower, expected, upper].every(second => Number.isFinite(second) && second > 0)
      || lower > expected || expected > upper) return []
    const identity = JSON.stringify([beat.sourceBeatId, [...beat.actorIds].sort(), spokenTokens(beat.textOrVocalization)])
    if (identities.has(identity)) return [] // A duplicate draft is not evidence that two performances are required.
    identities.add(identity)
    try {
      const base = estimateSpeechDuration(beat.textOrVocalization, style, policy)
      if (!base.characters) return []
      voices.push({ id: beat.id, sourceBeatId: beat.sourceBeatId, deliveryStyle: style, upper: Math.max(upper, base.upper),
        // Preserve the compiler's existing 1 ms allowance even at the 15 s boundary.
        acceptedMinimum: Math.max(upper, base.upper - .001) })
    } catch { return [] }
  }
  if (!voices.length) return []
  const errors: string[] = []
  if (voices.some(voice => voice.deliveryStyle === 'narration') && voices.some(voice => voice.deliveryStyle !== 'narration')) {
    errors.push('STORYBOARD_PACING_INVALID: 对白轨不能将声部伪装为画外旁白；当前单段同时编排 narration 与画内对白或吟唱，必须按原音轨和顺序拆成连续 segments，不能只更改 audioType、声部类型或删去旁白/台词')
  }
  const voiceSeconds = at(voices.reduce((total, voice) => total + at(voice.upper), 0))
  const safeEnd = at(voiceSeconds + policy.endingReadabilityReserve)
  const acceptedEnd = at(voices.reduce((total, voice) => total + at(voice.acceptedMinimum), 0) + policy.endingReadabilityReserve)
  if (Math.ceil(acceptedEnd - 1e-9) > policy.maximumProviderDuration) {
    const breakdown = voices.map(({ id, sourceBeatId, deliveryStyle, upper }) => ({ id, sourceBeatId, deliveryStyle, upper }))
    errors.push(`STORYBOARD_TIMING_OVERFLOW: 不可重叠的完整词汇声部安全上界=${JSON.stringify(breakdown)}；声部合计 ${voiceSeconds} 秒 + 可读收尾 ${policy.endingReadabilityReserve} 秒 = ${safeEnd} 秒，尚未计入额外动作就超过 ${policy.maximumProviderDuration} 秒上限；按原音轨分组与声部顺序拆分连续 segments，保留全部原台词，不能靠减小预算、并行独立词汇声部或删词通过`)
  }
  return errors
}

function sourceRequirements(shot: Value, pacing: Value, scene?: Value, preserveStoredContract = false, contentIssue: (message: string) => void = coverageInvalid): SourceRequirement[] {
  const source = Array.isArray(scene?.requiredBeats) ? scene.requiredBeats : undefined
  let requirements: SourceRequirement[]
  if (source) {
    requirements = source.map(row => {
      if (!isRecord(row) || !useful(row.id)) invalid('原场景 requiredBeats 缺少有效 id')
      const approved = approvedSourceRequirement(row, scene)
      // Read-only verification must preserve the contract authenticated by an
      // existing schedule. Legacy schedules have no collective-action snapshot
      // and must still satisfy their original literal anchor check. A new
      // compilation explicitly adopts the new source-backed proof instead.
      if (preserveStoredContract && Array.isArray(pacing.sourceBeatRequirements)
        && pacing.sourceBeatRequirements.some(stored => isRecord(stored) && stored.id === row.id && stored.visualActions === undefined)) {
        delete approved.visualActions
      }
      if (preserveStoredContract && Array.isArray(pacing.sourceBeatRequirements)
        && pacing.sourceBeatRequirements.some(stored => isRecord(stored) && stored.id === row.id && stored.environmentAnchors === undefined)) {
        delete approved.environmentAnchors
      }
      return approved
    })
  } else if (Array.isArray(pacing.sourceBeatRequirements)) {
    requirements = pacing.sourceBeatRequirements.map(row => {
      if (!isRecord(row) || !useful(row.id) || !Array.isArray(row.anchors) || !row.anchors.every(useful)) invalid('sourceBeatRequirements 缺少原节拍及锚点快照')
      if (row.setting!==undefined&&!useful(row.setting)) invalid('sourceBeatRequirements.setting 必须保留已批准原场景的非空空间名称')
      let visualActions: SourceVisualAction[] | undefined
      try { visualActions = readSourceVisualActions(row.visualActions, row.anchors as string[], useful(row.setting) ? row.setting : undefined) } catch (error) { invalid(String(error)) }
      if (row.environmentAnchors !== undefined && (!useful(row.setting) || !strings(row.environmentAnchors)
        || !row.environmentAnchors.length || !row.environmentAnchors.every(anchor => naturalEnvironmentVisual.test(anchor) || isNonSpeechAudioObligation(anchor)))) {
        invalid('sourceBeatRequirements.environmentAnchors 必须是同源自然环境或非人声物理音效的非空锚点快照')
      }
      return { id: row.id, anchors: row.anchors as string[],...(useful(row.setting)?{setting:row.setting}:{}),
        ...(visualActions ? { visualActions } : {}), ...(row.environmentAnchors ? { environmentAnchors: row.environmentAnchors as string[] } : {}) }
    })
  } else {
    const ids = pacing.sourceBeatIds ?? shot.coveredBeatIds
    if (!strings(ids) || !ids.length) invalid('duration-v2 必须绑定已批准 sourceBeatIds，不能从候选自行推断剧情范围')
    requirements = ids.map(id => ({ id, anchors: [] }))
  }
  if (!requirements.length || new Set(requirements.map(row => row.id)).size !== requirements.length) invalid('原节拍覆盖范围为空或重复')
  if (Array.isArray(shot.coveredBeatIds) && durationCanonicalJson([...shot.coveredBeatIds].sort()) !== durationCanonicalJson(requirements.map(row => row.id).sort())) {
    contentIssue(`coveredBeatIds 必须完整覆盖当前分段已分配的 sourceBeatIds；${sourceCoverageSummary(requirements.map(row => row.id), shot.coveredBeatIds)}。pendingActions 不能代替本段剧情覆盖；若完整内容超过 15 秒，须返回覆盖全部原节拍的 segments，不能只返回第一段或补填未实现的 id`)
  }
  return requirements
}

function beatResources(beat: DurationBeat): string[] {
  if (beat.kind === 'speech' || beat.kind === 'vocalization') return ['voice', ...(beat.resources ?? [])]
  return beat.resources ?? (beat.kind === 'action' ? ['body', 'hands'] : ['attention', 'body'])
}

/** The same dependency/resource clock serves acceptance and read-only split
 * planning. A split changes the clip origin, never the authored performance. */
function scheduleDurationBeats(beats: DurationBeat[], validateOrdered?: (ordered: DurationBeat[]) => void) {
  const byId = new Map(beats.map(beat => [beat.id, beat]))
  if (byId.size !== beats.length) invalid('表演 beat.id 必须唯一')
  for (const beat of beats) for (const id of [...beat.dependsOn, ...beat.overlapAllowedWith]) if (!byId.has(id) || id === beat.id) invalid(`${beat.id} 依赖或并行目标 ${id} 不存在或指向自身`)
  const ordered: DurationBeat[] = [], visited = new Set<string>(), visiting = new Set<string>()
  const visit = (beat: DurationBeat) => {
    if (visiting.has(beat.id)) invalid(`${beat.id} 动作依赖成环`)
    if (visited.has(beat.id)) return
    visiting.add(beat.id); beat.dependsOn.forEach(id => visit(byId.get(id)!)); visiting.delete(beat.id); visited.add(beat.id); ordered.push(beat)
  }
  beats.forEach(visit)
  validateOrdered?.(ordered)
  const ancestors = (beat: DurationBeat): string[] => beat.dependsOn.flatMap(id => [id, ...ancestors(byId.get(id)!)])
  for (const beat of beats) for (const id of beat.overlapAllowedWith) {
    const other = byId.get(id)!
    if (!other.overlapAllowedWith.includes(beat.id)) invalid(`${beat.id} 与 ${id} 并行须双方显式允许`)
    if (ancestors(beat).includes(id) || ancestors(other).includes(beat.id)) invalid(`${beat.id} 与 ${id} 同时声明先后依赖和并行，不能把“说完后”排成同时`)
    if (beat.kind === 'speech' && other.kind === 'speech') invalid(`${beat.id} 与 ${id} 独立词汇声部不能竞争同一时间；合唱须共用同一群体声部`)
    if (beat.actorIds.some(actor => other.actorIds.includes(actor)) && beatResources(beat).some(resource => beatResources(other).includes(resource))) invalid(`${beat.id} 与 ${id} 抢占同一主体资源，动作不能虚假并行`)
  }
  const schedule: DurationScheduleRow[] = []
  for (const beat of ordered) {
    let start = Math.max(beat.timingConstraint?.notBeforeSecond ?? 0, 0, ...beat.dependsOn.map(id => schedule.find(row => row.beatId === id)!.endSecond))
    for (const previous of schedule) {
      if (!beat.overlapAllowedWith.includes(previous.beatId) && start < previous.endSecond) start = previous.endSecond
    }
    const end = at(start + beat.durationEstimate.upper)
    if (beat.timingConstraint?.deadlineSecond !== undefined && end > beat.timingConstraint.deadlineSecond + .001) invalid(`${beat.id} 保守完成 ${end} 秒超过硬截止 ${beat.timingConstraint.deadlineSecond} 秒，须重排或拆镜`)
    schedule.push({ beatId: beat.id, sourceBeatId: beat.sourceBeatId, actorIds: beat.actorIds, kind: beat.kind,
      startSecond: at(start), endSecond: end, budgetSeconds: at(beat.durationEstimate.upper), timingConstraint: beat.timingConstraint ?? { mode: 'reference' } })
  }
  return schedule
}

function scheduledDurationRequirement(schedule: DurationScheduleRow[], policy: DurationPolicy) {
  const contentEndBudget = Math.max(...schedule.map(row => row.endSecond))
  const safeEndBudget = at(contentEndBudget + policy.endingReadabilityReserve)
  return { contentEndBudget, safeEndBudget,
    requiredDuration: Math.max(policy.minimumProviderDuration, Math.ceil(safeEndBudget - 1e-9)) }
}

export type DurationSourceSplitGroup = {
  sourceBeatIds: string[]; beatIds: string[]; completedDependencyBeatIds: string[]
  contentEndBudget: number; safeEndBudget: number; requiredDuration: number
}

/** Advice from shaped author data only. It neither emits an accepted shot nor
 * changes actions, words, overlaps or source allocation. Hard absolute clocks,
 * unknown shapes, incomplete coverage and backwards source dependencies need
 * authored replanning rather than a guessed clip boundary. */
export function planDurationSourceBeatSplit(output: unknown, options: { scene?: unknown; timingPolicy?: unknown } = {}) {
  if (!isRecord(output) || !isRecord(output.pacing) || output.pacing.version !== DURATION_PACING_VERSION
    || !Array.isArray(output.pacing.beats) || !output.pacing.beats.length || output.pacing.beats.length > 64
    || !isRecord(options.scene) || !Array.isArray(options.scene.requiredBeats)) return undefined
  try {
    const policy = resolveDurationPolicy(options.timingPolicy ?? output.pacing.timingPolicy)
    const sourceBeatIds = options.scene.requiredBeats.map(row => isRecord(row) && useful(row.id) ? row.id : '')
    if (!sourceBeatIds.length || sourceBeatIds.some(id => !id) || new Set(sourceBeatIds).size !== sourceBeatIds.length) return undefined
    const rawBeats = output.pacing.beats
    if (!rawBeats.every(row => isRecord(row) && useful(row.id) && useful(row.sourceBeatId)
      && sourceBeatIds.includes(row.sourceBeatId) && ['action', 'reaction', 'speech', 'vocalization'].includes(String(row.kind))
      && strings(row.actorIds) && strings(row.dependsOn) && strings(row.overlapAllowedWith)
      && useful(row.textOrVocalization) && isRecord(row.durationEstimate)
      && Object.values({ lower: row.durationEstimate.lower, expected: row.durationEstimate.expected, upper: row.durationEstimate.upper })
        .every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
      && Number(row.durationEstimate.lower) <= Number(row.durationEstimate.expected)
      && Number(row.durationEstimate.expected) <= Number(row.durationEstimate.upper)
      && isRecord(row.completion) && row.completion.requiredThisClip === true
      && (row.timingConstraint === undefined || (isRecord(row.timingConstraint) && row.timingConstraint.mode === 'reference'
        && row.timingConstraint.notBeforeSecond === undefined && row.timingConstraint.deadlineSecond === undefined)))) return undefined
    const beats = structuredClone(rawBeats) as DurationBeat[]
    for (const beat of beats) {
      if (beat.resources !== undefined && (!strings(beat.resources) || !beat.resources.length || beat.resources.some(resource => !['voice', 'body', 'hands', 'attention'].includes(resource)))) return undefined
      if (beat.kind === 'speech') {
        if (!['dialogue', 'narration', 'chant', 'singing'].includes(String(beat.deliveryStyle))) return undefined
        const base = estimateSpeechDuration(beat.textOrVocalization, beat.deliveryStyle!, policy)
        if (speechBudgetBelowMinimum(beat.durationEstimate.upper, base.upper)) beat.durationEstimate.upper = base.upper
      } else if (beat.durationEstimate.lower < (beat.kind === 'vocalization' ? policy.minimumVocalizationSeconds
        : beat.kind === 'action' ? policy.minimumActionSeconds : policy.minimumReactionSeconds)) return undefined
    }
    const byId = new Map(beats.map(beat => [beat.id, beat]))
    scheduleDurationBeats(beats) // Validate the original graph before considering any cut.
    if (sourceBeatIds.some(id => !beats.some(beat => beat.sourceBeatId === id))
      || beats.some(beat => beat.dependsOn.some(id => sourceBeatIds.indexOf(byId.get(id)!.sourceBeatId) > sourceBeatIds.indexOf(beat.sourceBeatId)))) return undefined
    const group = (start: number, end: number): DurationSourceSplitGroup => {
      const sourceIds = sourceBeatIds.slice(start, end + 1), selected = beats.filter(beat => sourceIds.includes(beat.sourceBeatId))
      const selectedIds = new Set(selected.map(beat => beat.id))
      const completedDependencyBeatIds = [...new Set(selected.flatMap(beat => beat.dependsOn.filter(id => !selectedIds.has(id))))]
      // Only predecessor performances already completed in prior clips leave
      // the local clock. They remain explicit obligations in the emitted hint.
      const local = selected.map(beat => ({ ...beat, dependsOn: beat.dependsOn.filter(id => selectedIds.has(id)),
        overlapAllowedWith: beat.overlapAllowedWith.filter(id => selectedIds.has(id)) }))
      return { sourceBeatIds: sourceIds, beatIds: selected.map(beat => beat.id), completedDependencyBeatIds,
        ...scheduledDurationRequirement(scheduleDurationBeats(local), policy) }
    }
    const units = sourceBeatIds.map((_, index) => group(index, index))
    const oversizedSourceBeatIds = units.filter(unit => unit.requiredDuration > policy.maximumProviderDuration).map(unit => unit.sourceBeatIds[0])
    const count = sourceBeatIds.length, minimum = Array<number>(count + 1).fill(Infinity)
    const choices: Array<DurationSourceSplitGroup | undefined> = Array(count)
    minimum[count] = 0
    for (let start = count - 1; start >= 0; start--) for (let end = count - 1; end >= start; end--) {
      const proposed = group(start, end)
      if (proposed.requiredDuration <= policy.maximumProviderDuration && minimum[end + 1] + 1 < minimum[start]) {
        minimum[start] = minimum[end + 1] + 1; choices[start] = proposed
      }
    }
    const groups: DurationSourceSplitGroup[] = []
    if (Number.isFinite(minimum[0])) for (let index = 0; index < count;) {
      const next = choices[index]!
      groups.push(next); index += next.sourceBeatIds.length
    }
    return { policyVersion: policy.version, endingReadabilityReserve: policy.endingReadabilityReserve,
      maximumProviderDuration: policy.maximumProviderDuration, units, groups, oversizedSourceBeatIds,
      ...(Number.isFinite(minimum[0]) ? { minimumSegments: minimum[0] } : {}) }
  } catch { return undefined }
}

function executableBeatInstruction(beat: ExecutableBeat, groups: Group[]) {
  const names=beat.actorIds.map(actor=>groups.find(group=>group.id===actor)?.label??actor).join('、')
  const speechPerformance=beat.deliveryStyle==='narration'?'画外旁白自然朗读'
    :beat.deliveryStyle==='chant'?`${names}哼唱歌谣，按歌谣节奏吟唱并完整唱出`
      :beat.deliveryStyle==='singing'?`${names}按歌唱旋律演唱，完整唱出`:`${names}自然开口说出`
  return (beat.performanceInstruction?beat.performanceInstruction+'；':'')+(beat.kind==='speech'?`${speechPerformance}：${beat.textOrVocalization}`
    :beat.kind==='vocalization'?`${names}发出可听的无词${beat.vocalization!.vocalizationType}，${beat.textOrVocalization}；曲调关系：${beat.vocalization!.melodyRelation}`
      :beat.textOrVocalization.includes(names)?beat.textOrVocalization:`${names}${beat.textOrVocalization}`)
}

function approvedSourceRequirement(row: Value, scene?: Value): SourceRequirement {
  const anchors = Array.isArray(row.mustShow) ? row.mustShow.filter(useful) : []
  const observable = isRecord(row.observable) && Array.isArray(row.observable.visual) ? row.observable.visual.filter(useful) : []
  const setting = useful(row.setting) ? row.setting : undefined
  const visualActions = sourceVisualActions(anchors, scene?.cast, [...observable, ...(useful(row.description) ? [row.description] : [])], setting)
  const environmentAnchors = setting ? sourceEnvironmentAnchors(row) : []
  return { id: row.id as string, anchors, ...(setting ? { setting } : {}), ...(visualActions.length ? { visualActions } : {}),
    ...(environmentAnchors.length ? { environmentAnchors } : {}) }
}

/** A setting-establishment beat has no performer even when the surrounding
 * live-action scene has a cast. Keep this exception deliberately narrow: the
 * beat must repeat the approved setting and may contain only camera/environment
 * establishment wording. Character, crowd, prop and source-anchor actions still
 * require an explicit actor or actorGroup. */
function isActorlessSettingEstablishment(beat: DurationBeat, scene: Value | undefined) {
  if (beat.kind !== 'action' || beat.actorIds.length || !Array.isArray(scene?.requiredBeats)) return false
  const source = scene.requiredBeats.find(row => isRecord(row) && row.id === beat.sourceBeatId)
  if (!isRecord(source) || !useful(source.setting)) return false
  const fields = [beat.textOrVocalization, beat.performanceInstruction,
    beat.completion?.finalState, beat.completion?.evidenceAnchor].filter(useful)
  if (!fields.length || !fields.every(text => text.includes(source.setting as string))) return false
  const allowed = /(?:场景|环境|空间|外景|内景|全景|远景|空镜|镜头|画面|定场|建立|已建立|呈现|已呈现|交代|展示|淡入|显现|可见)/g
  return fields.every(text => text.replaceAll(source.setting as string, '').replace(allowed, '').replace(/[\s，。；：、,.!！?？“”"'（）()【】\-—]/g, '') === '')
}

/** Natural environment actions may use the approved visual/sound anchors
 * rather than repeat the location name in every field. Keep each source
 * literal and permit only camera/display wrappers around it: an approved
 * river view cannot authorize a crowd, held prop or a newly breaking bridge. */
const naturalEnvironmentVisual = /^(?:(?:断|木|石)?桥(?:边|旁|下)?的?|近岸|远处|近处)?(?:河面|水面|湖面|江面|海面|河水|溪水|江水|流水|水流|天空|云层|树叶|草木|树林)(?:倒映|反射|映照|流动|荡漾|波动|起伏|飘动|浮动|摇曳)?(?:天光|日光|月光|天空|云影|草木)?$/u
// Distance/visibility qualifiers do not change a proven sound's physical
// source. Direction/level changes (渐近/渐远 etc.) remain source literals.
const environmentSoundText = (text: string) => text.replace(/(?:远处|近处|隐约|传来)/gu, '')
function sourceEnvironmentAnchors(source: Value) {
  const observable = isRecord(source.observable) ? source.observable : {}
  const visuals = [...(Array.isArray(source.mustShow) ? source.mustShow : []),
    ...(Array.isArray(observable.visual) ? observable.visual : []),
    ...(useful(source.description) ? source.description.split(/[，,。；;\n]/) : [])].filter(useful)
  const visualAnchors = visuals.map(text => text.trim()).filter(text => naturalEnvironmentVisual.test(text))
  const audioAnchors = (Array.isArray(observable.audio) ? observable.audio : []).filter(useful)
    .filter(isNonSpeechAudioObligation)
  return [...new Set([...visualAnchors, ...audioAnchors])]
}

function isActorlessNaturalEnvironment(beat: DurationBeat, requirements: SourceRequirement[]) {
  if (beat.kind !== 'action' || beat.actorIds.length) return false
  const source = requirements.find(row => row.id === beat.sourceBeatId)
  const anchors = [...(source?.environmentAnchors ?? [])].map(environmentSoundText).sort((left, right) => right.length - left.length)
  if (!anchors.length) return false
  const fields = [beat.textOrVocalization, beat.performanceInstruction,
    beat.completion?.finalState, beat.completion?.evidenceAnchor].filter(useful)
  const wrappers = /镜头|画面|环境音|环境声|全景|远景|中景|空镜|缓慢|逐渐|向上|向下|上移|下移|平移|推近|拉远|展现|展示|呈现|完整|清晰|可见|已|的|与|和|从|过渡到/gu
  return fields.length > 0 && fields.every(text => {
    const body = environmentSoundText(text)
    if (!anchors.some(anchor => body.includes(anchor))) return false
    return anchors.reduce((remaining, anchor) => remaining.replaceAll(anchor, ''), body)
      .replace(wrappers, '').replace(/[\s，。；：、,.!！?？（）()【】\-—]/gu, '') === ''
  })
}

function sourceAnchorIssue(requirement: SourceRequirement, assigned: ExecutableBeat[], groups: Group[], candidates: unknown[]) {
  // An approved setting is context; only executable beat text can prove actions.
  const body = (requirement.setting ? `场景：${requirement.setting}\n` : '')
    + assigned.map(beat => executableBeatInstruction(beat, groups)).join('\n')
  const missing = requirement.anchors.filter(anchor => {
    const action = requirement.visualActions?.find(action => action.anchor === anchor)
    return !(action ? executableVisualAction(action, assigned) : scriptedGroupPerformanceCovers(anchor, assigned, groups) ?? executableEntranceAnchor(anchor, assigned) ?? enactedVisualTextCovers(body, anchor))
  })
  if (!missing.length) return undefined
  const evidence = candidates.flatMap((beat, index) => isRecord(beat) && beat.sourceBeatId === requirement.id ? [{
    path: `pacing.beats[${index}]`, id: beat.id, kind: beat.kind, actorIds: beat.actorIds,
    textOrVocalization: beat.textOrVocalization, performanceInstruction: beat.performanceInstruction,
    requiredThisClip: isRecord(beat.completion) ? beat.completion.requiredThisClip : undefined,
  }] : [])
  const expectedActions = requirement.visualActions?.filter(action => missing.includes(action.anchor)) ?? []
  return `原节拍 ${requirement.id} 的可执行正文缺少原锚点 ${missing.join('、')}；不能只在完成声明中声称覆盖；实际动作=${JSON.stringify(evidence)}；批准视觉动作=${JSON.stringify(expectedActions)}${expectedActions.length ? '；须在同一 action 绑定全部批准 actorIds 并正向执行原谓词，只允许快照所列修饰；单人 reaction/action、否定/计划/回忆/旁观或完成声明不证明多人动作' : ''}`
}

function executableCandidate(value: Value): ExecutableBeat | undefined {
  const { kind, actorIds, textOrVocalization, performanceInstruction, deliveryStyle } = value
  if (!strings(actorIds) || (!actorIds.length && kind !== 'action' && kind !== 'reaction') || !useful(textOrVocalization)
    || (performanceInstruction !== undefined && !useful(performanceInstruction))) return undefined
  if (kind !== 'speech' && kind !== 'action' && kind !== 'reaction' && kind !== 'vocalization') return undefined
  const beat: ExecutableBeat = { kind, actorIds, textOrVocalization,
    ...(typeof performanceInstruction === 'string' ? { performanceInstruction } : {}) }
  if (kind === 'speech') {
    if (deliveryStyle !== 'dialogue' && deliveryStyle !== 'narration' && deliveryStyle !== 'chant' && deliveryStyle !== 'singing') return undefined
    beat.deliveryStyle = deliveryStyle
  }
  if (kind === 'vocalization') {
    const voice = value.vocalization
    if (!isRecord(voice)) return undefined
    const { vocalizationType, actorGroup, expectedAudibility, melodyRelation, completionCue } = voice
    if (!useful(vocalizationType) || !useful(actorGroup) || !useful(expectedAudibility) || !useful(melodyRelation) || !useful(completionCue)) return undefined
    beat.vocalization = { vocalizationType, actorGroup, expectedAudibility, melodyRelation, completionCue }
  }
  return beat
}

/** Gather each known source-anchor failure even when an earlier voice budget
 * prevents compilation. Candidate metadata never defines or satisfies scope. */
export function collectDurationCoverageDiagnostics(output: unknown, options: { scene?: unknown } = {}): string[] {
  if (!isRecord(output) || !isRecord(output.pacing) || output.pacing.version !== DURATION_PACING_VERSION
    || !Array.isArray(output.pacing.beats) || !isRecord(options.scene) || !Array.isArray(options.scene.requiredBeats)) return []
  const groups: Group[] = []
  for (const group of Array.isArray(output.pacing.actorGroups) ? output.pacing.actorGroups : []) {
    if (!isRecord(group) || !useful(group.id) || !useful(group.label) || !useful(group.memberDescription)) return []
    const voiceProfile = groupVoiceProfile(group.voiceProfile)
    groups.push({ id: group.id, label: group.label, memberDescription: group.memberDescription, ...(voiceProfile !== undefined ? { voiceProfile } : {}) })
  }
  const errors = new Set<string>()
  for (const source of options.scene.requiredBeats) {
    if (!isRecord(source) || !useful(source.id) || !Array.isArray(source.mustShow) || !source.mustShow.every(useful)) continue
    const assigned = output.pacing.beats.filter(beat => isRecord(beat) && beat.sourceBeatId === source.id)
    if (!assigned.length) continue
    const executable: ExecutableBeat[] = []
    let known = true
    for (const beat of assigned) {
      if (!isRecord(beat) || !isRecord(beat.completion) || typeof beat.completion.requiredThisClip !== 'boolean') { known = false; break }
      if (!beat.completion.requiredThisClip) continue
      const body = executableCandidate(beat)
      if (!body) { known = false; break }
      executable.push(body)
    }
    if (!known || !executable.length) continue
    const requirement = approvedSourceRequirement(source, options.scene)
    const issue = sourceAnchorIssue(requirement, executable, groups, output.pacing.beats)
    if (issue) errors.add('STORYBOARD_COVERAGE_INCOMPLETE: ' + issue)
  }
  return [...errors]
}

function validateVoices(shot: Value, beats: DurationBeat[], groups: Group[]) {
  assertVoiceObligationCoverage(shot, beats)
  if (typeof shot.audioText !== 'string') invalid('audioText 必须保留完整实际发声原文')
  const speech = beats.filter(beat => beat.kind === 'speech')
  const actualLines = shot.audioText.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*([^：:]+)[：:]\s*(.+)$/)
    return { speaker: match ? match[1].trim() : '', text: match ? match[2].trim() : line.trim() }
  })
  if (shot.audioType === '环境声' && (speech.length || actualLines.length)) invalid('环境声镜头不得藏入词汇台词；无词声部须用 vocalization')
  if (shot.audioType === '旁白') {
    if (speech.some(beat => beat.deliveryStyle !== 'narration') || spokenTokens(speech.map(beat => beat.textOrVocalization).join('')) !== spokenTokens(actualLines.map(line => line.text).join(''))) invalid('旁白声部须逐字覆盖 audioText，不能遗漏、重复或改成画内发声')
  } else if (shot.audioType === '对白') {
    if (!actualLines.length || actualLines.some(line => !line.speaker)) invalid('对白 audioText 每行必须带已声明说话人')
    const orderedLines = (lines:Array<{speaker:string;text:string}>) => {
      const result:Array<{speaker:string;text:string}>=[]
      for(const line of lines){const groupId=resolveAnonymousGroupSpeaker(line.speaker,groups),speaker=groups.find(group=>group.id===groupId)?.label??voiceIdentity(line.speaker),text=spokenTokens(line.text),last=result.at(-1)
        if(last?.speaker===speaker)last.text+=text;else result.push({speaker,text})}
      return result
    }
    const plannedLines:Array<{speaker:string;text:string}>=[]
    for (const beat of speech) {
      if (beat.deliveryStyle === 'narration') invalid('对白轨不能将声部伪装为画外旁白')
      const names = beat.actorIds.map(id => groups.find(group => group.id === id)?.label ?? id)
      // A chorus is one shared text and one declared group, not several
      // independently competing dialogue tracks.
      if (names.length !== 1) invalid('同词合唱请声明 actorGroup 并在 audioText 用群体名称绑定，不能复制多人的独立台词')
      plannedLines.push({speaker:names[0],text:beat.textOrVocalization})
    }
    if (durationCanonicalJson(orderedLines(actualLines)) !== durationCanonicalJson(orderedLines(plannedLines))) invalid(
      '声部与 audioText 的说话人、完整文字或顺序不一致，禁止漏词、重复和串角；expected(audioText)='
      + JSON.stringify(orderedLines(actualLines)) + '；actual(pacing.speech)=' + JSON.stringify(orderedLines(plannedLines))
      + '；逐条按原 audioText 说话人核对 speech.actorIds。匿名说话人与听众分别声明 actorGroups，不能把发声者绑定到听众群体，不能把对白改旁白、删词或删除无词声部来通过')
  } else if (shot.audioType !== '环境声') invalid('duration-v2 需要明确 对白/旁白/环境声 音轨类型')
  const allVoices = beats.filter(beat => beat.kind === 'speech' || beat.kind === 'vocalization')
  const exclusive = typeof shot.videoPrompt === 'string' ? [...shot.videoPrompt.matchAll(/仅([^。\n]{1,100}?)(?:在[^。\n]{0,30})?(?:开口发声|发声|说话|开口)/g)] : []
  for (const match of exclusive) {
    const omitted = allVoices.flatMap(beat => beat.actorIds).filter(id => !match[1].includes(id) && !match[1].includes(groups.find(group => group.id === id)?.label ?? id))
    if (omitted.length) invalid(`声部冲突：时间轴限制“${match[0]}”，却另要求 ${[...new Set(omitted)].join('、')} 发声；须按原剧情明确全部声部`)
  }
}

/** The model supplies content and estimates; only this function assigns clocks.
 * Default serialization is conservative. Parallelism needs mutual permission
 * and compatible actor resources, in addition to a valid dependency graph. */
export function compileDurationSchedule(shot: Value, options: CompileOptions = {}) {
  const qualityWarnings: string[] = []
  const contentIssue = (message: string) => { if (options.qualityDisposition === 'manual-review-v1') qualityWarnings.push('STORYBOARD_COVERAGE_INCOMPLETE: ' + message); else coverageInvalid(message) }
  if (!isRecord(shot.pacing) || shot.pacing.version !== DURATION_PACING_VERSION) invalid('需要 duration-v2 pacing；旧执行必须显式重新规划')
  const original = shot.pacing
  if (['activityWindows','performanceBeats','actionSeconds','reactionSeconds'].some(key=>original[key]!==undefined)) invalid('duration-v2 只使用结构化 beats，不能沿用旧活动窗口或第二套时长预算')
  const policy = resolveDurationPolicy(options.timingPolicy ?? original.timingPolicy)
  if (options.timingPolicy && original.timingPolicy && durationCanonicalJson(policy) !== durationCanonicalJson(resolveDurationPolicy(original.timingPolicy))) invalid('候选 timingPolicy 与当前工作流批准策略不一致')
  const requirements = sourceRequirements(shot, original, options.scene, options.verifyStoredHash, contentIssue)
  const sourceIds = requirements.map(row => row.id)
  const groups: Group[] = Array.isArray(original.actorGroups) ? original.actorGroups.map(row => {
    if (!isRecord(row) || !['id','label','memberDescription'].every(key => useful(row[key]))) invalid('actorGroups 必须提供唯一 id、名称及群体成员说明')
    const voiceProfile = groupVoiceProfile(row.voiceProfile)
    return { id: row.id as string, label: row.label as string, memberDescription: row.memberDescription as string, ...(voiceProfile !== undefined ? { voiceProfile } : {}) }
  }) : []
  const characters = Array.isArray(shot.characters) ? shot.characters.filter(useful) : []
  const presentCharacters = Array.isArray(shot.presentCharacters) ? shot.presentCharacters.filter(useful) : characters
  const actorlessEditorial = isRecord(options.scene) && allowsEmptyEditorialCast(options.scene)
    && characters.length === 0 && presentCharacters.length === 0
  const staticIllustration = isRecord(options.scene)
    && isStaticIllustrationStyle(options.scene.visualTreatment, options.scene.animationStyle)
  if (new Set(groups.map(group => group.id)).size !== groups.length || new Set(groups.map(group => group.label)).size !== groups.length
    || groups.some(group => presentCharacters.includes(group.id) || characters.includes(group.id))) invalid('actorGroups 标识不能重复或冒用角色身份')
  const actors = new Set([...characters, ...presentCharacters, ...groups.map(group => group.id)])
  if (!Array.isArray(original.beats) || !original.beats.length || original.beats.length>64) invalid('缺少本镜结构化表演 beats 或数量超过64，须保留剧情拆分')
  const declaredSourceIds = [...new Set(original.beats.filter(isRecord).map(beat => beat.sourceBeatId))]
  const beats: DurationBeat[] = original.beats.map((value, index) => {
    if (!isRecord(value)) invalid(`beats[${index}] 无效`)
    const beat = JSON.parse(JSON.stringify(value)) as DurationBeat
    const beatText = [beat.textOrVocalization, beat.performanceInstruction,
      beat.completion?.evidenceAnchor, beat.completion?.finalState].filter(useful).join('；')
    // A static illustration may combine a named character layer with an
    // actorless background/tableau transition. Requiring the named character
    // to "perform" the background fade invents an action; only an empty-actor
    // beat that does not name any present character receives this exemption.
    const staticBackgroundBeat = staticIllustration && (beat.kind === 'action' || beat.kind === 'reaction')
      && characters.every(name => !beatText.includes(name))
    const actorlessAction = (actorlessEditorial || staticBackgroundBeat || isActorlessSettingEstablishment(beat, options.scene)
      || isActorlessNaturalEnvironment(beat, requirements))
      && (beat.kind === 'action' || beat.kind === 'reaction')
    const actorIdsIssue = !strings(beat.actorIds)
      ? 'actorIds（必须是无重复的非空字符串数组）'
      : !beat.actorIds.length && !actorlessAction
        ? 'actorIds（空数组仅用于批准 setting 的纯环境建立；人物、病患、家属、群众、持物或回应动作必须绑定人物或 actorGroup）'
        : ''
    if (!sourceIds.includes(beat.sourceBeatId)) coverageInvalid(`beats[${index}]${useful(beat.id)?' '+beat.id:''} 的 sourceBeatId 须属于本段原节拍；${sourceCoverageSummary(sourceIds, declaredSourceIds)}`)
    const missingFields=[
      !useful(beat.id)&&'id',
      actorIdsIssue,
      !['action','reaction','speech','vocalization'].includes(beat.kind)&&'kind',
      !useful(beat.textOrVocalization)&&'textOrVocalization（所有 kind 均必填实际正文，performanceInstruction 不能代替该字段）',
      !strings(beat.dependsOn)&&'dependsOn',!strings(beat.overlapAllowedWith)&&'overlapAllowedWith',
    ].filter(Boolean)
    if (missingFields.length) invalid(`beats[${index}]${useful(beat.id)?' '+beat.id:''} 缺少或无效字段：${missingFields.join('、')}`)
    const unknownActors = beat.actorIds.filter(id => !actors.has(id) && !(beat.kind === 'speech' && beat.deliveryStyle === 'narration' && id === '旁白'))
    if (unknownActors.length) invalid(`${beat.id} 使用未声明角色或群体，${['speech', 'vocalization'].includes(beat.kind) ? '不能把群众声部藏在正文' : '视觉动作必须绑定已声明人物或群体'}；field=pacing.beats[${index}].actorIds；unknown=${JSON.stringify(unknownActors)}；candidate=${JSON.stringify(beat.actorIds)}；declaredCharacters=${JSON.stringify([...new Set([...characters, ...presentCharacters])])}；declaredActorGroups=${JSON.stringify(groups.map(group => ({ id: group.id, label: group.label })))}；保留原动作和有词/无词声部，给已批准的匿名参与者补齐 actorGroups 的 id/label/memberDescription，并让 actorIds 引用同一 id；不得虚构具名人物、改变原说话人或删除源剧情来消除未知引用`)
    if (value.startSecond !== undefined || value.endSecond !== undefined) invalid(`${beat.id} 起止时刻由排程器生成，不能给 beat 填入另一套时钟`)
    if (beat.performanceInstruction!==undefined && !useful(beat.performanceInstruction)) invalid(`${beat.id} performanceInstruction 须为实际执行的表演动作正文`)
    const estimate = beat.durationEstimate
    if (!estimate || ![estimate.lower, estimate.expected, estimate.upper].every(second => Number.isFinite(second) && second > 0)
      || estimate.lower > estimate.expected || estimate.expected > estimate.upper || !useful(estimate.source)
      || !['low','medium','high'].includes(estimate.confidence)) invalid(`${beat.id} 需要有序正数 lower/expected/upper、预算来源与置信度`)
    if (!beat.completion || typeof beat.completion.requiredThisClip !== 'boolean' || !useful(beat.completion.finalState)
      || !['visual','audio','audio-visual'].includes(beat.completion.modality) || !useful(beat.completion.evidenceAnchor)) invalid(`${beat.id} 缺少本镜完成态、证据通道或原动作锚点`)
    if (beat.resources !== undefined && (!strings(beat.resources) || !beat.resources.length || beat.resources.some(resource => !['voice','body','hands','attention'].includes(resource)))) invalid(`${beat.id} resources 主体资源声明无效：可省略以采用默认资源，显式提供时须为非空 voice/body/hands/attention 数组，不能填 [] 取消资源占用`)
    if (beat.kind === 'speech') {
      const issue = speechBudgetIssue(beat.id, beat.textOrVocalization, beat.deliveryStyle!, estimate, policy)
      if (issue) invalid(issue)
      if (!['audio','audio-visual'].includes(beat.completion.modality)) invalid(`${beat.id} 发声完成必须有实际音频证据，画面姿态不能证明台词完成`)
    } else if (beat.kind === 'vocalization') {
      const voice = beat.vocalization
      if (!voice || !['vocalizationType','actorGroup','expectedAudibility','melodyRelation','completionCue'].every(key => useful(voice[key as keyof typeof voice]))
        || !groups.some(group => group.id === voice.actorGroup) || !beat.actorIds.includes(voice.actorGroup)
        || !['audio','audio-visual'].includes(beat.completion.modality)) invalid(`${beat.id} 无词声部必须声明群体、可听性、曲调关系和实际音频完成依据`)
      if (estimate.lower < policy.minimumVocalizationSeconds) invalid(`${beat.id} 无词声部不能按零汉字计零秒；至少 ${policy.minimumVocalizationSeconds} 秒`)
    } else if (estimate.lower < (beat.kind === 'action' ? policy.minimumActionSeconds : policy.minimumReactionSeconds)) invalid(`${beat.id} 动作/反应预算低于共享策略下界，须拆清动作并提供可解释预算`)
    if (['action','reaction'].includes(beat.kind) && /哼唱|跟唱|唱出|开口说|说出[：:]|朗诵|吟唱/.test(beat.textOrVocalization)) invalid(`${beat.id} 包含实际发声义务，必须另声明 speech/vocalization 声部及预算，不能藏进无声动作`)
    if (['speech','vocalization'].includes(beat.kind) && !beat.completion.requiredThisClip) invalid(`${beat.id} 本镜已编排的声部必须在本镜完整完成；跨镜台词须先沿原义务拆段`)
    const constraint = beat.timingConstraint ?? { mode: 'reference' }
    if (!['reference','hard'].includes(constraint.mode)
      || [constraint.notBeforeSecond,constraint.deadlineSecond].some(second => second !== undefined && (!Number.isFinite(second) || second < 0))
      || (constraint.mode === 'reference' && (constraint.notBeforeSecond !== undefined || constraint.deadlineSecond !== undefined))
      || (constraint.deadlineSecond !== undefined && constraint.deadlineSecond <= (constraint.notBeforeSecond ?? 0))) invalid(`${beat.id} timingConstraint 必须区分导演参考与有效硬边界`)
    beat.timingConstraint = constraint
    return beat
  })
  const byId = new Map(beats.map(beat => [beat.id, beat]))
  if (byId.size !== beats.length) invalid('表演 beat.id 必须唯一')
  const implementedSourceIds = [...new Set(beats.map(beat => beat.sourceBeatId))]
  if (sourceIds.some(id => !implementedSourceIds.includes(id))) contentIssue(`原节拍未分配完整声画表演，禁止遗漏剧情或仅补填 coveredBeatIds；${sourceCoverageSummary(sourceIds, implementedSourceIds)}`)
  for (const requirement of requirements) {
    const assigned = beats.filter(beat => beat.sourceBeatId === requirement.id)
    if (!assigned.some(beat=>beat.completion.requiredThisClip)) contentIssue(`原节拍 ${requirement.id} 不能全部标为本镜非必需；后续义务必须通过原分段分配移交`)
    const issue = sourceAnchorIssue(requirement, assigned.filter(beat => beat.completion.requiredThisClip), groups, beats)
    if (issue) contentIssue(issue)
  }
  const schedule = scheduleDurationBeats(beats, ordered => validateVoices(shot, ordered, groups))
  const { contentEndBudget, safeEndBudget, requiredDuration } = scheduledDurationRequirement(schedule, policy)
  if (requiredDuration > policy.maximumProviderDuration) throw new Error(`STORYBOARD_TIMING_OVERFLOW: 完整节拍与可读收尾需要 ${requiredDuration} 秒，超过 15 秒；沿 sourceBeatId 完整边界拆分，保留全部台词和原动作，禁止钳到 15 秒`)
  const maximumDuration = Math.min(policy.maximumProviderDuration, requiredDuration + policy.maxConservativeExtraSeconds)
  const declaredDuration = Number(shot.duration)
  const duration = options.selectDuration && !options.verifyStoredHash && Number.isInteger(declaredDuration) && declaredDuration>=policy.minimumProviderDuration
    && declaredDuration<requiredDuration ? requiredDuration:declaredDuration
  if (!Number.isInteger(duration) || duration < requiredDuration || duration > maximumDuration) invalid(`duration-v2 本镜安全预算 ${safeEndBudget} 秒，可批准 ${requiredDuration}–${maximumDuration} 秒；实际 ${duration} 秒。修复节拍预算或选择合理保守整数时长，不能删除剧情或借用测量容差`)
  const previousSelection=original.durationSelection
  if (previousSelection!==undefined && (!isRecord(previousSelection)||!Number.isInteger(previousSelection.modelDuration)
    || Number(previousSelection.modelDuration)<policy.minimumProviderDuration||Number(previousSelection.modelDuration)>=requiredDuration
    || previousSelection.selectedDuration!==duration||duration!==requiredDuration||previousSelection.reason!=='increased-to-safe-budget')) invalid('durationSelection 必须如实记录原模型整数与共享安全下界，不能改写已批准时长')
  const durationSelection=declaredDuration!==duration?{modelDuration:declaredDuration,selectedDuration:duration,reason:'increased-to-safe-budget'}
    :previousSelection as {modelDuration:number;selectedDuration:number;reason:string}|undefined
  const timelineWindows: Array<{startSecond:number;endSecond:number;beatIds:string[];beatQuotes?:Array<{beatId:string;quote:string}>}> = []
  for (const row of [...schedule].sort((a,b) => a.startSecond-b.startSecond || a.endSecond-b.endSecond)) {
    const last = timelineWindows.at(-1)
    if (last && row.startSecond < last.endSecond - .001) { last.endSecond = Math.max(last.endSecond,row.endSecond); last.beatIds.push(row.beatId) }
    else timelineWindows.push({startSecond:row.startSecond,endSecond:row.endSecond,beatIds:[row.beatId]})
  }
  const completeWindows: typeof timelineWindows = []
  let cursor = 0
  for (const window of timelineWindows) {
    if (window.startSecond > cursor) completeWindows.push({startSecond:cursor,endSecond:window.startSecond,beatIds:[]})
    completeWindows.push(window); cursor = window.endSecond
  }
  if (cursor < duration) completeWindows.push({startSecond:cursor,endSecond:duration,beatIds:[]})
  const settingsEmitted=new Set<string>()
  const sceneStyle = resolvedAnimationStyle(options.scene?.visualTreatment, options.scene?.animationStyle)
  const staticTail = isStaticIllustrationStyle(options.scene?.visualTreatment, options.scene?.animationStyle)
    ? sceneStyle === 'character_illustration'
      ? '保留前述已完成构图供观众看清，人物插画内部保持静止，仅保持已声明的整个人物图层位置，不引入新动作或人声。'
      : '保留前述已完成构图供观众看清，画中人物与物件保持定格，整幅画保持静止，不引入新动作或人声。'
    : undefined
  const videoPrompt = completeWindows.map(window => {
    window.beatQuotes = []
    const body = window.beatIds.length ? window.beatIds.map(id => {
      const beat = byId.get(id)!, row = schedule.find(item => item.beatId === id)!
      const setting=requirements.find(requirement=>requirement.id===beat.sourceBeatId)?.setting
      const sourceSetting=setting&&!settingsEmitted.has(beat.sourceBeatId)?`场景：${setting}；`:''
      settingsEmitted.add(beat.sourceBeatId)
      const instruction = sourceSetting+executableBeatInstruction(beat,groups)
      const anchorAlreadyPresent=instruction.includes(beat.completion.evidenceAnchor)
        || Boolean(spokenTokens(beat.completion.evidenceAnchor))&&spokenTokens(instruction).includes(spokenTokens(beat.completion.evidenceAnchor))
      const quote = `（节拍 ${id}，${row.startSecond}至${row.endSecond}秒${beat.timingConstraint!.mode === 'hard' ? '，遵守已声明硬边界' : '，导演参考'}）${instruction}；完成态：${beat.completion.finalState}${anchorAlreadyPresent?'':`；动作依据：${beat.completion.evidenceAnchor}`}。`
      window.beatQuotes!.push({beatId:id,quote})
      return quote
    }).join('同时，') : window.startSecond >= contentEndBudget ? staticTail ?? '保留前述已完成动作的自然结果供观众看清，允许呼吸与微动，不引入新的剧情动作或人声。' : '依已声明硬时间要求保留真实环境与当前状态，不提前执行后续动作，不新增人声。'
    return `${window.startSecond}-${window.endSecond}秒：${body}`
  }).join('\n')
  const speechWindows = schedule.filter(row => row.kind === 'speech').map(row => ({ start:row.startSecond,end:row.endSecond,
    text:byId.get(row.beatId)!.textOrVocalization,beatId:row.beatId,sourceBeatId:row.sourceBeatId,actorIds:row.actorIds,deliveryStyle:byId.get(row.beatId)!.deliveryStyle }))
  const sampleTimes = [...new Set([0,...schedule.flatMap(row => [row.startSecond,at((row.startSecond+row.endSecond)/2),row.endSecond]),Math.max(0,at(duration-.08))])].sort((a,b)=>a-b)
  const pacing = {...original,version:DURATION_PACING_VERSION,timingPolicy:policy,beats,actorGroups:groups,
    sourceBeatIds:sourceIds,sourceBeatRequirements:requirements,schedule,timelineWindows:completeWindows,speechWindows,sampleTimes,compiledVideoPrompt:videoPrompt,
    ...(durationSelection?{durationSelection}:{})}
  const scheduleHash = durationScheduleHash({ characters,presentCharacters,audioType:shot.audioType,audioText:shot.audioText,duration,
    timingPolicy:policy,beats,actorGroups:groups,sourceBeatRequirements:requirements,schedule,timelineWindows:completeWindows,videoPrompt,
    ...(durationSelection?{durationSelection}:{}) })
  const timingEstimate = { version:DURATION_PACING_VERSION, policyVersion:policy.version, speechSeconds:at(speechWindows.reduce((sum,row)=>sum+row.end-row.start,0)),
    contentEndBudget,safeEndBudget,endingReadabilityReserve:policy.endingReadabilityReserve,tailSeconds:policy.endingReadabilityReserve,
    requiredDuration,maximumDuration,selectedDuration:duration,modelDuration:durationSelection?.modelDuration??duration,rawRequiredSeconds:safeEndBudget,
    ...(durationSelection?{durationAdjustmentReason:durationSelection.reason}:{}),
    conservativeExtraSeconds:at(duration-safeEndBudget),plannedDuration:options.scene?.targetDuration,
    budgetBasis:'sum-of-constrained-upper-estimates',confidence:beats.some(beat=>beat.durationEstimate.confidence==='low')?'low':'medium',scheduleHash }
  if (options.verifyStoredHash) {
    if (!useful(original.scheduleHash) || original.scheduleHash !== scheduleHash || (shot.scheduleHash !== undefined && shot.scheduleHash !== scheduleHash)) invalid('排程哈希失效：内容、依赖、时长或策略已变化，旧视频及审核不得复用')
    for (const [key,value] of Object.entries({timingPolicy:policy,beats,actorGroups:groups,sourceBeatIds:sourceIds,sourceBeatRequirements:requirements,schedule,timelineWindows:completeWindows,speechWindows,sampleTimes,compiledVideoPrompt:videoPrompt,durationSelection})) if (durationCanonicalJson(original[key]) !== durationCanonicalJson(value)) invalid(`排程派生字段 ${key} 与完整重算不符，禁止付费请求`)
    if (typeof shot.videoPrompt !== 'string' || shot.videoPrompt.split(/【(?:同期对白硬约束|口型同步|旁白时间硬约束|声部与收束)】/)[0].trim() !== videoPrompt) invalid('视频时间轴与已批准排程不一致，必须重新编译而非沿用旧窗口')
  }
  return {pacing:{...pacing,scheduleHash},timingEstimate,scheduleHash,videoPrompt,speechWindows,sampleTimes,schedule,duration,qualityWarnings}
}

export function durationScheduleHash(value: unknown) { return 'duration-v2-sha256-' + durationContentHash(value) }
export function verifyDurationSchedule(shot: Value, options: Omit<CompileOptions,'verifyStoredHash'|'selectDuration'> = {}) { return compileDurationSchedule(shot,{...options,selectDuration:false,verifyStoredHash:true}) }

/** Self-contained for persisted code nodes. The paid server boundary separately
 * recomputes the full schedule; this projection never trusts a second clock. */
export function deriveDurationMediaRequest(shot: Record<string, unknown>) {
  const pacing = shot.pacing as Record<string, unknown> | undefined
  if (!pacing || pacing.version !== 'duration-v2' || typeof pacing.scheduleHash !== 'string'
    || !Array.isArray(pacing.speechWindows) || !Array.isArray(pacing.sampleTimes) || !Array.isArray(pacing.schedule)
    || !Array.isArray(pacing.beats) || !pacing.timingPolicy) throw new Error('STORYBOARD_PACING_INVALID: 缺少已编译 duration-v2 采证参数')
  const policy = pacing.timingPolicy as DurationPolicy
  const vocalizations = (pacing.beats as DurationBeat[]).filter(beat => beat.kind === 'vocalization').map(beat => ({...beat,
    scheduled:(pacing.schedule as DurationScheduleRow[]).find(row=>row.beatId===beat.id)}))
  return {audioType:shot.audioType,audioText:shot.audioText,speechRequired:pacing.speechWindows.length>0,
    speechWindows:pacing.speechWindows,sampleTimes:pacing.sampleTimes,
    latestSpeechEnd:Number(shot.duration)-policy.endingReadabilityReserve,
    vocalizations,nonLexicalAudioRequired:vocalizations.length>0,scheduleHash:pacing.scheduleHash,timingPolicy:pacing.timingPolicy}
}
