import { storyboardContinuityModeError } from './storyboard-continuity-contract.ts'
import { animationStyleAllowsEmptyCast } from './animation-shot.ts'
import { allowsEmptyEditorialCast } from './history-drama.ts'
import { characterVisualContextFrom, characterVisualContextSignature } from './character-visual-context.ts'

type RecordValue = Record<string, unknown>

export const HISTORY_CINEMATIC_VERSION = 'cinematic-v1'
export const CINEMATIC_CONTINUITY_MODES = ['tail_continuation', 'coverage_cut', 'scene_cut'] as const

const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length
const equalNames = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

export function expectedEndPresentCharacters(shot: RecordValue) {
  const exits = record(shot.continuity).exitingCharacters
  const leaving = Array.isArray(exits) ? exits.map(entry => record(entry).name) : []
  return (Array.isArray(shot.presentCharacters) ? shot.presentCharacters as string[] : []).filter(name => !leaving.includes(name))
}

export function isCinematicShot(shot: RecordValue) { return shot.contentContractVersion === HISTORY_CINEMATIC_VERSION }

/** Anonymous live performers are approved through source beats and actorGroups,
 * not invented continuity identities. Media/replay callers only have an accepted
 * shot, whose validated beatDramaturgy retains those same visual obligations. */
export function cinematicShotAllowsEmptyCast(shot: RecordValue, scene: RecordValue = {}) {
  const requirements = record(shot.pacing).sourceBeatRequirements
  const requiredBeats = Array.isArray(shot.beatDramaturgy) ? shot.beatDramaturgy.map(value => {
    const beat = record(value)
    return { id: beat.beatId, observable: { visual: beat.visual } }
  }) : Array.isArray(requirements) ? requirements.map(value => {
    const beat = record(value)
    return { id: beat.id, mustShow: beat.anchors }
  }) : []
  const effectiveScene: RecordValue = {
    editorialRole: shot.editorialRole, visualTreatment: shot.visualTreatment,
    animationStyle: shot.animationStyle, cast: shot.characters,
    requiredBeats,
    ...scene,
  }
  if (!names(effectiveScene.cast) || effectiveScene.cast.length) return false
  // Retain compatibility with previously accepted animation styles. New
  // live-action eligibility uses the same approved contract as the outline.
  return allowsEmptyEditorialCast(effectiveScene)
    || ['animated_map', 'historical_montage'].includes(String(effectiveScene.visualTreatment))
    || (effectiveScene.visualTreatment === 'animated' && animationStyleAllowsEmptyCast(effectiveScene.animationStyle))
}

/** A historical tableau is a newly composed editorial image, not the same
 * physical/character layer continued from the prior shot. When an actorless
 * tableau follows another animation representation, it must cut to a fresh
 * reference frame; carrying the prior shot's character-layer presence into it
 * creates an impossible contract (empty cast versus inherited actor assets). */
export function isActorlessTableauRepresentationCut(scene: RecordValue, previousShot?: RecordValue) {
  return scene.continuityFromPrevious === true
    && scene.visualTreatment === 'animated'
    && scene.animationStyle === 'historical_tableau'
    && Array.isArray(scene.cast) && scene.cast.length === 0
    && Boolean(previousShot?.id)
    && previousShot?.animationStyle !== 'historical_tableau'
}

/** Routing approval does not certify every observation in the original report. */
export function principleQualityCanProceed(value: unknown) {
  const item = record(value), review = record(item.qualityReview)
  return item.qualityPolicy === 'principle-v1' && ['passed', 'needs_attention', 'unavailable'].includes(String(review.status))
    && review.canProceed === true && Array.isArray(review.principleIssues)
    && (item.qualityDisposition === 'manual-review-v1' || review.principleIssues.length === 0)
}

/** Principle review may be incomplete, but the media and its actual tail must
 * still belong to the generated take and, for v2, its approved schedule. */
export function principleMediaEvidenceIssue(video: RecordValue | undefined, shot?: RecordValue) {
  if (!principleQualityCanProceed(video)) return '原则审查未允许继续，或仍有原则性问题'
  const manual = video?.qualityDisposition === 'manual-review-v1'
  if (!text(video?.url) || video.decoded !== true || !text(video.evidenceUrl)
    || !Number.isFinite(video.duration) || Number(video.duration) <= 0
    || ((manual || video.width !== undefined) && (!Number.isFinite(video.width) || Number(video.width) <= 0))
    || ((manual || video.height !== undefined) && (!Number.isFinite(video.height) || Number(video.height) <= 0))
    || (!manual && (video.hasAudio !== true || video.audioEmbedded !== true || record(video.technicalValidation).passed !== true))) return '缺少实际可解码视频、尺寸、时长、音轨或真实采证'
  if (!text(video.lastFrameUrl) || !/^\/generated\/[\w./-]+\.(?:jpg|jpeg|png|webp)$/i.test(video.lastFrameUrl)
    || !Array.isArray(video.frames) || !video.frames.length || video.frames.at(-1) !== video.lastFrameUrl) return '缺少属于实际成片采证序列的尾帧，不能使用计划图片'
  const take = record(video.raw)
  if (!text(video.originalUrl) || video.originalUrl !== take.url) return '实际采证与生成视频的来源资产未绑定'
  const pacing = record(shot?.pacing)
  if (pacing.version === 'duration-v2' && (!text(pacing.scheduleHash) || record(take.params).scheduleHash !== pacing.scheduleHash)) return '实际视频未绑定当前已批准的 duration-v2 排程'
}

/** A new dramatic unit may start only after the preceding duration-v2 take has
 * proved every mandatory performance on that same take. A planned final frame,
 * storyProgress label or permissive quality routing is not completion evidence.
 * Legal scene cuts can use a fresh reference image after this gate passes. */
export function principleDurationTransitionIssue(shot: RecordValue, video: RecordValue): string | undefined {
  const pacing = record(shot.pacing)
  if (pacing.version !== 'duration-v2') return undefined
  const completion = record(video.durationCompletion)
  if (!text(pacing.scheduleHash) || completion.scheduleHash !== pacing.scheduleHash
    || !text(video.evidenceUrl) || completion.evidenceRef !== video.evidenceUrl) {
    return '前镜逐节拍完成验收缺失，或未绑定当前已批准排程与实际成片证据'
  }
  if (completion.applicable !== true || completion.assessment !== 'complete' || completion.passed !== true
    || completion.route !== 'accept' || !Array.isArray(completion.reasons) || completion.reasons.length
    || !Array.isArray(completion.remainingMandatoryBeats)
    || completion.remainingMandatoryBeats.length) return '前镜实际声画节拍尚未证明全部完成'
  const beats = Array.isArray(pacing.beats) ? pacing.beats.map(record) : []
  if (!beats.length || beats.some(beat => typeof record(beat.completion).requiredThisClip !== 'boolean')) {
    return '前镜已批准排程缺少明确的本镜完成义务'
  }
  const required = beats.filter(beat => record(beat.completion).requiredThisClip === true)
  if (!required.length || required.some(beat => !text(beat.id) || !text(beat.sourceBeatId))
    || new Set(required.map(beat => beat.id)).size !== required.length
    || !Array.isArray(completion.checks) || completion.checks.length !== required.length) {
    return '前镜必需节拍与逐项完成证据不对应'
  }
  const checks = completion.checks.map(record)
  if (new Set(checks.map(check => check.beatId)).size !== checks.length
    || checks.some(check => !required.some(beat => beat.id === check.beatId && beat.sourceBeatId === check.sourceBeatId)
    || check.status !== 'complete' || !Array.isArray(check.reasons) || check.reasons.length
    || !Number.isFinite(record(check.observedStart).lower) || !Number.isFinite(record(check.observedStart).upper)
    || !Number.isFinite(record(check.observedEnd).lower) || !Number.isFinite(record(check.observedEnd).upper)
    || Number(record(check.observedEnd).upper) < Number(record(check.observedStart).lower))) {
    return '前镜存在未完成、未确认或无实际起止证据的必需节拍'
  }
  const interval = record(completion.actualCompletionInterval)
  if (!Number.isFinite(interval.lower) || !Number.isFinite(interval.upper)
    || Number(interval.upper) < Number(interval.lower) || !Number.isFinite(completion.requiredEndSecond)
    || Number(completion.requiredEndSecond) < Number(interval.upper)
    || Number(completion.requiredEndSecond) > Number(video.duration) + 1e-9) {
    return '前镜必需动作或收尾可读余量尚未在实际片长内完成'
  }
}

/** Use only frame-bound valid observations. Missing details stay unknown;
 * approved cast and setting are continuity metadata, not observed facts. */
export function principleTailWorldState(shot: RecordValue, video: RecordValue) {
  const present = expectedEndPresentCharacters(shot), review = record(video.visualReview)
  const evidence = record(review.endingStateEvidence)
  if (evidence.method === 'actual-tail-image' && evidence.frame === video.lastFrameUrl) {
    try { return validateObservedCinematicWorldState(review.worldState, shot, review.endCharacters) } catch { /* Keep unavailable observations unknown. */ }
  }
  return { settingId: record(shot.worldState).settingId, characters: present.map(name => ({ name,
    position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' },
  })) }
}

/** Detect explicit uncertainty only; absence of these words does not establish
 * that an observation is true. Self-contained for persisted review gates. */
export function hasExplicitWorldStateUncertainty(value: unknown): boolean {
  return typeof value === 'string' && /无法\s*(?:完全\s*)?(?:确认|判断|辨认|看清)|看不清|\b(?:unknown|uncertain)\b/i.test(value)
}

/** An unknown fact may explain the observation limit, but must not carry a
 * factual value. Self-contained so persisted code gates use the same contract. */
export function hasValidCinematicWorldFactShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fact = value as Record<string, unknown>
  const nonemptyText = (item: unknown) => typeof item === 'string' && Boolean(item.trim())
  if (fact.status === 'observed') return nonemptyText(fact.value) && nonemptyText(fact.evidence)
  if (fact.status !== 'unknown') return false
  const emptyValue = fact.value == null || (typeof fact.value === 'string' && !fact.value.trim())
  return emptyValue && (fact.evidence == null || typeof fact.evidence === 'string')
}

/** Opening state is either inherited observation or explicitly unknown. It is
 * never a forecast of the requested ending, and screen coordinates are not a
 * stable space when the camera cuts to a reverse angle. */
export function validateCinematicWorldState(value: unknown, cast: unknown, label = 'worldState') {
  const state = record(value)
  if (!text(state.settingId) || !names(cast) || !Array.isArray(state.characters)
    || !equalNames(state.characters.map(item => String(record(item).name ?? '')), cast)) {
    throw new Error(`STORYBOARD_WORLD_STATE_INVALID: ${label} 必须保留 settingId 与全部仍在场人物的状态`)
  }
  for (const entry of state.characters) {
    const character = record(entry)
    for (const key of ['position', 'heldProps', 'pendingAction']) {
      const fact = record(character[key])
      if (!hasValidCinematicWorldFactShape(fact)) {
        throw new Error(`STORYBOARD_WORLD_STATE_INVALID: ${label}.${character.name}.${key} 必须为有 value/evidence 的 observed 或无事实 value 的 unknown；unknown 可保留字符串 evidence 说明不可观察原因`)
      }
      if (fact.status === 'observed' && (hasExplicitWorldStateUncertainty(fact.value) || hasExplicitWorldStateUncertainty(fact.evidence))) {
        throw new Error(`STORYBOARD_WORLD_STATE_INVALID: ${label}.${character.name}.${key} 明确写明无法确认，不能声明 observed；应复核报告并标为 unknown`)
      }
      if (key === 'position' && fact.status === 'observed' && /画面|屏幕|镜头(?:左|右)|构图|screen|frame\s*(?:left|right)/i.test(String(fact.value))) {
        throw new Error(`STORYBOARD_WORLD_STATE_INVALID: ${character.name} 的 position 必须用门、案、对手等实景锚点，不能用画面坐标代替世界位置`)
      }
    }
  }
  return state
}

function compareOpeningState(shot: RecordValue, previousState: RecordValue) {
  const opening = record(shot.worldState)
  const priorNames = Array.isArray(previousState.characters)
    ? (previousState.characters as RecordValue[]).map(item => item.name).filter(text)
    : []
  const illustrationEntrants = cinematicIllustrationEntryNames(shot, priorNames)
  if (opening.settingId !== previousState.settingId) return '同场切镜不能更换 settingId'
  for (const item of (opening.characters as RecordValue[])) {
    const prior = (previousState.characters as RecordValue[]).find(entry => entry.name === item.name)
    if (!prior) {
      const entry = (Array.isArray(shot.enteringCharacters) ? shot.enteringCharacters as RecordValue[] : []).find(row => row.name === item.name)
      const composedEntry = illustrationEntrants.includes(String(item.name))
      if ((entry || composedEntry) && ['position', 'heldProps', 'pendingAction'].every(key => record(item[key]).status === 'unknown')) continue
      return `人物 ${item.name} 缺少前镜世界状态，不能无入场出现在同场切镜`
    }
    for (const key of ['position', 'heldProps', 'pendingAction']) {
      const now = record(item[key]); const before = record(prior[key])
      const difference = `；field=worldState.${item.name}.${key}；expected=${JSON.stringify(before)}；candidate=${JSON.stringify(now)}`
      if (now.status === 'observed' && (before.status !== 'observed' || now.value !== before.value || now.evidence !== before.evidence)) {
        return `${item.name}.${key} 开场状态改变或冒充已观察；必须继承前镜实际证据，不能无动作改变位置、持物或未完成动作${difference}`
      }
      if (before.status === 'observed' && now.status !== 'observed') return `${item.name}.${key} 已确认的连续状态不能因换机位丢失；不可观察的新状态应在成片审查明确标 unknown${difference}`
    }
  }
  return undefined
}

/** Portrait layers on illustrations or historical maps are composited over the
 * picture rather than physically walking into the historical location. */
function cinematicIllustrationEntryNames(shot: RecordValue, previousNames: unknown): string[] {
  if (shot.visualTreatment !== 'animated' || !['character_illustration', 'historical_map'].includes(String(shot.animationStyle))) return []
  const previous = names(previousNames) ? previousNames : []
  if (!Array.isArray(shot.illustrationLayers)) return []
  return shot.illustrationLayers.flatMap(value => {
    const layer = record(value)
    const name = layer.characterName
    const enterStart = Number(layer.enterStart), enterDuration = Number(layer.enterDuration)
    return text(name) && !previous.includes(name) && Number.isFinite(enterStart) && enterStart >= 0
      && Number.isFinite(enterDuration) && enterDuration > 0 ? [name] : []
  })
}

/** Validation during planning checks only available facts. Before rendering,
 * cinematicContinuityIssue additionally requires accepted actual media state. */
export function validateCinematicShot(shot: RecordValue, scene: RecordValue, previousShot?: RecordValue) {
  if (!isCinematicShot(shot)) return
  // Planning has the approved scene object, while paid-media and replay gates
  // intentionally receive only the accepted shot. Reconstruct immutable
  // editorial fields from that shot so both gates classify actorless animation
  // identically instead of treating it as live action downstream.
  const effectiveScene: RecordValue = {
    editorialRole: shot.editorialRole,
    visualTreatment: shot.visualTreatment,
    animationStyle: shot.animationStyle,
    cast: shot.characters,
    ...scene,
  }
  const continuity = record(shot.continuity)
  const mode = String(continuity.mode)
  if (previousShot && ['tail_continuation', 'coverage_cut'].includes(mode) && Array.isArray(shot.characterVisuals) && Array.isArray(previousShot.characterVisuals)) {
    for (const value of shot.characterVisuals) {
      const visual = record(value), prior = previousShot.characterVisuals.map(record).find(row => row.name === visual.name)
      const current = characterVisualContextFrom(visual), previous = characterVisualContextFrom(prior)
      if (current && previous && characterVisualContextSignature(current) !== characterVisualContextSignature(previous)) {
        throw new Error(`STORYBOARD_CONTINUITY_INVALID: ${String(visual.name)}同场连续镜头不得突变年龄或稳定服装造型；跨年/换装须上游明确安排并使用真实换场`)
      }
    }
  }
  const emptyCastAllowed = cinematicShotAllowsEmptyCast(shot, scene)
  const tableauRepresentationCut = isActorlessTableauRepresentationCut(effectiveScene, previousShot)
  if (!(CINEMATIC_CONTINUITY_MODES as readonly string[]).includes(mode)) throw new Error('STORYBOARD_CONTINUITY_INVALID: cinematic-v1 必须明确 tail_continuation、coverage_cut 或 scene_cut')
  if (tableauRepresentationCut && mode !== 'coverage_cut') {
    throw new Error('STORYBOARD_CONTINUITY_INVALID: 空演员 historical_tableau 切换动画表现形式时必须使用 coverage_cut/reference 生成新的定格画面；不能复用前镜尾帧或继承前镜人物图层')
  }
  if (!names(shot.presentCharacters) || (!emptyCastAllowed && !shot.presentCharacters.length) || !names(shot.characters)
    || shot.characters.some(name => !(shot.presentCharacters as string[]).includes(name))) {
    throw new Error('STORYBOARD_CONTINUITY_INVALID: presentCharacters 必须保留仍在场的具名人物；已批准的匿名真人群演、无人实景或无人物动画可使用空人物数组，匿名群体通过 pacing.actorGroups 绑定，不能虚构具名身份')
  }
  let world: ReturnType<typeof validateCinematicWorldState>
  try { world = validateCinematicWorldState(shot.worldState, shot.presentCharacters) } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('STORYBOARD_WORLD_STATE_INVALID:')) throw error
    const evidenceRule = mode === 'scene_cut' || record(previousShot?.worldStateEvidence).method !== 'actual-tail-image'
      ? '本次规划尚无可继承的实测状态，所有开场事实须保持 unknown 且不填事实 value；不能为修复字段格式而改成 observed。计划位置与动作写入画面正文'
      : '已有实测前镜的事实必须逐字段继承；格式修复不得改变其观察状态或编造新事实，未知项保持 unknown 且不填事实 value'
    const currentRows = record(shot.worldState).characters, priorRows = record(previousShot?.worldState).characters
    const malformed = (Array.isArray(currentRows) ? currentRows : []).flatMap(value => {
      const item = record(value)
      const prior = (Array.isArray(priorRows) ? priorRows : []).map(record).find(entry => entry.name === item.name)
      return ['position', 'heldProps', 'pendingAction'].filter(key => !hasValidCinematicWorldFactShape(item[key])).map(key =>
        `field=worldState.${item.name}.${key}；expected=${JSON.stringify(mode !== 'scene_cut' && record(previousShot?.worldStateEvidence).method === 'actual-tail-image' ? prior?.[key] ?? null : { status: 'unknown' })}；candidate=${JSON.stringify(item[key] ?? null)}`)
    })
    throw new Error(`${error.message}；${evidenceRule}${malformed.length ? '；' + malformed.join('；') : ''}`, { cause: error })
  }
  const exits = continuity.exitingCharacters ?? []
  if (!Array.isArray(exits) || exits.some(value => {
    const exit = record(value)
    return !text(exit.name) || !(shot.characters as string[]).includes(exit.name) || !text(exit.path) || !text(exit.evidenceAnchor)
      || !Number.isFinite(exit.startSecond) || !Number.isFinite(exit.endSecond) || Number(exit.startSecond) < 0
      || Number(exit.endSecond) <= Number(exit.startSecond) || Number(exit.endSecond) > Number(shot.duration) - 0.3
      || !String(shot.videoPrompt ?? '').includes(String(exit.evidenceAnchor))
      || !/(?:离场|离开|走出|退出|退场)/.test(String(exit.evidenceAnchor))
      || /(?:离开|走出|退出)(?:画面|画框|构图)|切出|机位|裁切/.test(String(exit.evidenceAnchor))
      || (Array.isArray(shot.endCharacters) && shot.endCharacters.includes(exit.name))
  }) || new Set(exits.map(value => record(value).name)).size !== exits.length) {
    throw new Error('STORYBOARD_CONTINUITY_INVALID: exitingCharacters 必须有本镜人物、真实离场路径、时间及时间轴动作锚点；裁切出画不等于离场，离场者不能又列为尾帧可见')
  }
  if (text(effectiveScene.settingId) && world.settingId !== effectiveScene.settingId) throw new Error('STORYBOARD_WORLD_STATE_INVALID: 开场 settingId 必须匹配批准的场景')
  const expectedFrameMode = mode === 'tail_continuation' ? 'reuse_previous_tail' : 'reference'
  if (shot.firstFrameMode !== expectedFrameMode) throw new Error(`STORYBOARD_CONTINUITY_INVALID: ${mode} 必须使用 firstFrameMode=${expectedFrameMode}`)
  if (mode === 'scene_cut') {
    if (effectiveScene.continuityFromPrevious === true) throw new Error('STORYBOARD_CONTINUITY_INVALID: 同一场戏不能以 scene_cut 跳过尚未完成动作')
    if (!previousShot && continuity.bridgeType !== 'opening') throw new Error('STORYBOARD_CONTINUITY_INVALID: 首镜 scene_cut 必须为 opening')
    if ((world.characters as RecordValue[]).some(character => ['position', 'heldProps', 'pendingAction'].some(key => record(character[key]).status === 'observed'))) {
      throw new Error('STORYBOARD_WORLD_STATE_INVALID: 新场景尚未采证，开场世界状态必须为 unknown；计划构图写入 visualPrompt，不能冒充 observed')
    }
    return
  }
  if (effectiveScene.continuityFromPrevious !== true || !previousShot || continuity.previousShotId !== previousShot.id) {
    throw new Error(storyboardContinuityModeError(shot, effectiveScene, previousShot)
      ?? `STORYBOARD_CONTINUITY_INVALID: scope=current-candidate；field=continuity.previousShotId；expected=${JSON.stringify(previousShot?.id ?? null)}；candidate=${JSON.stringify(continuity.previousShotId ?? null)}；连续模式必须指向前镜并保持 continuityFromPrevious=true，禁止改写前镜id。`)
  }
  if (record(shot.storyProgress).unitId !== record(previousShot.storyProgress).unitId) throw new Error('STORYBOARD_CONTINUITY_INVALID: 同场切镜必须继续相同剧情单元')
  const previousWorld = record(previousShot.worldState)
  if (previousWorld.settingId !== world.settingId) throw new Error('STORYBOARD_CONTINUITY_INVALID: 连续模式必须保持同一 settingId')
  if (record(previousShot.worldStateEvidence).method === 'actual-tail-image') {
    const issue = compareOpeningState(shot, previousWorld)
    if (issue) throw new Error(`STORYBOARD_WORLD_STATE_INVALID: ${issue}`)
  } else if ((world.characters as RecordValue[]).some(character => ['position', 'heldProps', 'pendingAction'].some(key => record(character[key]).status === 'observed'))) {
    throw new Error('STORYBOARD_WORLD_STATE_INVALID: 预规划分段的前镜未提供实测结尾，不能把计划状态声明为 observed')
  }
  const entrants = (Array.isArray(shot.enteringCharacters) ? shot.enteringCharacters as RecordValue[] : []).map(entrant => String(entrant.name))
  const previousPresent = tableauRepresentationCut ? [] : expectedEndPresentCharacters(previousShot)
  const illustrationEntrants = cinematicIllustrationEntryNames(shot, previousPresent)
  const expectedPresent = [...new Set([...previousPresent, ...entrants, ...illustrationEntrants])]
  if (!names(previousShot.presentCharacters) || !equalNames(expectedPresent, shot.presentCharacters)) {
    const actual = shot.presentCharacters as string[]
    const missing = expectedPresent.filter(name => !actual.includes(name))
    const unexpected = actual.filter(name => !expectedPresent.includes(name))
    const repairScope = record(previousShot.worldStateEvidence).method === 'actual-tail-image'
      ? '前镜已有实测验收证据，须回查原证据确认真实在场关系，不能为通过校验改写已验收的前镜或实测 worldState'
      : '前镜仍为预规划时，应修复前镜 presentCharacters 及对应 worldState 中遗漏的实际在场声明，再重验全部连续分段'
    throw new Error(`STORYBOARD_CONTINUITY_INVALID: 反打不等于离场，尾帧续拍也必须以 presentCharacters 继承实际仍在场人物；只有明确真人入场、合法人物插画图层淡入及已验收离场可变更名单。前镜 ${String(previousShot.id)} 在场 presentCharacters=${JSON.stringify(previousShot.presentCharacters ?? null)}；本镜 ${String(shot.id)} enteringCharacters=${JSON.stringify(entrants)}；illustrationLayerEntries=${JSON.stringify(illustrationEntrants)}；本镜 expected=${JSON.stringify(expectedPresent)}；actual=${JSON.stringify(actual)}；missing=${JSON.stringify(missing)}；unexpected=${JSON.stringify(unexpected)}。若人物原本就在同一现场，不得伪造 enteringCharacters 入场动作，也不得删除本镜实际行动人物来消除 unexpected；${repairScope}`)
  }
  if (mode === 'coverage_cut' && (continuity.bridgeType !== 'cut' || !text(continuity.bridgeAnchor))) throw new Error('STORYBOARD_CONTINUITY_INVALID: coverage_cut 必须用 cut 与具体的反应、视线或动作联系')
}

export function cinematicContinuityIssue(shot: RecordValue, previousShot: RecordValue | undefined, previousVideo?: RecordValue) {
  if (!isCinematicShot(shot) || !['coverage_cut', 'tail_continuation'].includes(String(record(shot.continuity).mode))) return undefined
  try {
    if (previousVideo?.qualityPolicy === 'principle-v1') {
      const issue = principleMediaEvidenceIssue(previousVideo, previousShot)
      if (issue || !previousShot) return issue ?? '连续镜头缺少前镜分镜来源'
      const state = principleTailWorldState(previousShot, previousVideo)
      validateCinematicShot(shot, { continuityFromPrevious: true }, { ...previousShot,
        presentCharacters: expectedEndPresentCharacters(previousShot), worldState: state,
        worldStateEvidence: { method: 'actual-tail-image', frame: previousVideo.lastFrameUrl, qualityPolicy: 'principle-v1' } })
      return compareOpeningState(shot, state)
    }
    const review = record(previousVideo?.visualReview)
    if (previousShot) validateCinematicPresenceReview(previousShot, review)
    const present = previousShot ? expectedEndPresentCharacters(previousShot) : undefined
    const state = validateCinematicWorldState(review.worldState, present, '前镜实测 worldState')
    const evidence = record(review.endingStateEvidence)
    if (!previousShot || record(previousVideo?.technicalValidation).passed !== true
      || !(record(previousVideo?.speechValidation).passed === true || (previousVideo?.audioMode === 'ambient' && previousVideo?.hasAudio === true))
      || review.passed !== true || !Array.isArray(review.issues) || review.issues.length || evidence.method !== 'actual-tail-image'
      || !text(previousVideo?.lastFrameUrl) || evidence.frame !== previousVideo.lastFrameUrl
      || !Array.isArray(previousVideo.frames) || previousVideo.frames.at(-1) !== evidence.frame) {
      return '连续镜头需要前镜已验收成片的实际世界状态与尾帧证据，不能用计划状态替代'
    }
    validateCinematicShot(shot, { continuityFromPrevious: true }, { ...previousShot, presentCharacters: present, worldState: state, worldStateEvidence: evidence })
    return compareOpeningState(shot, state)
  } catch (error) { return error instanceof Error ? error.message : String(error) }
}

/** A single tail image cannot establish a hidden character's current pose or
 * props. Keep presence, mark unobserved facts unknown and retain provenance on
 * facts that the actual image can establish. */
export function validateObservedCinematicWorldState(value: unknown, shot: RecordValue, visibleCast: unknown) {
  let state: RecordValue
  try { state = validateCinematicWorldState(value, expectedEndPresentCharacters(shot), '实测尾帧 worldState') }
  catch (error) { throw new Error(`VIDEO_REVIEW_INVALID: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
  if (state.settingId !== record(shot.worldState).settingId) throw new Error('VIDEO_REVIEW_INVALID: 实测世界状态不能擅自更换场所标识')
  if (!names(visibleCast)) throw new Error('VIDEO_REVIEW_INVALID: 缺少实际可见人物')
  for (const item of state.characters as RecordValue[]) {
    if (!visibleCast.includes(String(item.name)) && ['position', 'heldProps', 'pendingAction'].some(key => record(item[key]).status === 'observed')) {
      throw new Error(`VIDEO_REVIEW_INVALID: ${item.name} 在尾帧画外，不能把其姿态和持物冒充尾帧实测；应标 unknown`)
    }
  }
  return state
}

export function validateCinematicPresenceReview(shot: RecordValue, review: RecordValue) {
  if (!isCinematicShot(shot)) return
  const exits = record(shot.continuity).exitingCharacters
  const expected = expectedEndPresentCharacters(shot)
  if (!Array.isArray(exits) || !exits.length) {
    if (review.presentCharacters !== undefined && (!names(review.presentCharacters) || !equalNames(review.presentCharacters, expected))) throw new Error('VIDEO_REVIEW_INVALID: 实际末尾在场名单不完整，画外不能冒充离场')
    return
  }
  if (!names(review.presentCharacters)) throw new Error('VIDEO_REVIEW_INVALID: 明确离场后必须记录实测末尾在场名单')
  const checks = review.presenceChecks
  if (!Array.isArray(checks) || exits.some(exit => checks.filter(check => record(check).character === record(exit).name).length !== 1)
    || checks.some(value => {
      const check = record(value)
      return !['observed', 'incomplete', 'unobservable'].includes(String(check.status)) || !text(check.evidence)
        || !Array.isArray(check.frameIndices) || new Set(check.frameIndices).size < 2
        || check.frameIndices.some(index => !Number.isInteger(index) || index < 0 || index > 5)
    })) throw new Error('VIDEO_REVIEW_INVALID: 离场必须逐人提供至少两个实际帧的动作过程证据')
  if (checks.some(check => record(check).status === 'unobservable')) throw new Error('VIDEO_REVIEW_INVALID: 离场过程不可观察，应补充采证，不能把裁切出画当离场')
  if (checks.some(check => record(check).status === 'incomplete')) throw new Error('VIDEO_QUALITY_REJECTED: 必要离场动作实际未完成')
  if (!equalNames(review.presentCharacters, expected)) throw new Error('VIDEO_REVIEW_INVALID: 离场报告全部已完成但末尾在场名单未相应改变，应复核报告')
}

export function validateCinematicOpeningReview(shot: RecordValue, review: RecordValue) {
  if (!isCinematicShot(shot) || record(shot.continuity).mode !== 'coverage_cut') return
  const continuity = record(review.continuityReview)
  const world = validateCinematicWorldState(shot.worldState, shot.presentCharacters)
  const initial = Array.isArray(shot.initialCharacters) ? shot.initialCharacters : shot.characters as unknown[]
  const required = (world.characters as RecordValue[]).flatMap(character => initial.includes(character.name)
    ? ['position', 'heldProps', 'pendingAction'].filter(field => record(character[field]).status === 'observed').map(field => ({ character: character.name, field })) : [])
  const isRequired = (check: RecordValue) => required.some(expected => check.character === expected.character && check.field === expected.field)
  const characterNames = (world.characters as RecordValue[]).map(character => character.name)
  const seen = new Set<string>()
  if (continuity.mode !== 'coverage_cut' || typeof continuity.passed !== 'boolean' || !Array.isArray(continuity.checks)
    || required.some(expected => (continuity.checks as RecordValue[]).filter(check => record(check).character === expected.character && record(check).field === expected.field).length !== 1)
    || continuity.checks.some(item => {
      const check = record(item)
      const key = JSON.stringify([check.character, check.field])
      const duplicate = seen.has(key)
      seen.add(key)
      return duplicate || !characterNames.includes(check.character) || !['position', 'heldProps', 'pendingAction'].includes(String(check.field))
        || !['observed', 'mismatch', 'unobservable'].includes(String(check.status)) || !text(check.evidence)
        || !Array.isArray(check.frameIndices) || !check.frameIndices.includes(0)
    })) throw new Error('VIDEO_REVIEW_INVALID: 同场切镜缺少首帧逐项世界状态的观察证据')
  const checks = continuity.checks as RecordValue[]
  if (checks.some(check => !isRequired(check) && check.status !== 'unobservable')) throw new Error('VIDEO_REVIEW_INVALID: 没有可用开场观测基准的附加项只能说明不确定，不能断言连续状态一致或改变')
  const requiredChecks = checks.filter(isRequired)
  if (requiredChecks.some(check => check.status === 'observed' && hasExplicitWorldStateUncertainty(check.evidence))) throw new Error('VIDEO_REVIEW_INVALID: 同场切镜关键开场状态证据明确不确定，不能声明 observed；应复核报告并补充采证，不能购买重拍')
  if (requiredChecks.some(check => check.status === 'unobservable')) throw new Error('VIDEO_REVIEW_INVALID: 同场切镜关键开场状态不可观察，应补充采证，不能购买重拍')
  if (requiredChecks.some(check => check.status === 'mismatch')) throw new Error(`VIDEO_QUALITY_REJECTED: 同场切镜改变了关键连续状态 ${JSON.stringify(requiredChecks.filter(check => check.status === 'mismatch'))}`)
  if (!continuity.passed) throw new Error('VIDEO_REVIEW_INVALID: 同场切镜各状态一致却报告失败，应复核报告')
}
