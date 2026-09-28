import { executableVisualAction, sourceVisualActions } from './storyboard-visual-action.ts'
import { ANIMATION_AESTHETICS, ANIMATION_STYLES, animationStyleAllowsEmptyCast, isAnimatedVisualTreatment, isStaticIllustrationStyle, resolvedAnimationStyle } from './animation-shot.ts'
import { isNonSpeechAudioObligation } from './outline-audio-contract.ts'
import { normalizeCharacterVisualContext } from './character-visual-context.ts'
import { assertSelectedCharacterVisuals, validatedCharacterEquipment, validatedCharacterVisuals } from './character-visual-workflow.ts'
import type { ResolvedCharacterVisualSelection } from './character-visual-workflow.ts'
import { isHistoricalSandTable, normalizeSandTableAesthetic } from './sand-table-contract.ts'
/** The approved writing contract is deliberately separate from observed media
 * state. These functions never promote planned psychology to visual evidence. */
export const HISTORY_DRAMA_VERSION = 'cinematic-v1'
type Value = Record<string, unknown>

/** Only independent defects discovered after every required container and
 * identity has been traversed safely may continue to the general schema checks.
 * Malformed shapes and ambiguous identities still throw ordinary hard errors. */
export class DramaOutlineIssuesError extends Error {
  readonly outline: Value
  readonly issues: readonly string[]

  constructor(outline: Value, issues: string[]) {
    const unique = [...new Set(issues)]
    super(`HISTORY_DRAMA_INVALID: ${unique.join('\n')}`)
    this.name = 'DramaOutlineIssuesError'
    this.outline = outline
    this.issues = unique
  }
}

const ANONYMOUS_LIVE_ACTION_SUBJECT = /(?:弟子|病[患者]|百姓|村民|群众|灾民|饥民|流民|信众|徒众|军士|士卒|宾客|门客|家属|侍从|官吏|群臣|民众|人群)/

/** The Sanguo workflow is a live-action historical drama. Its only animated
 * exception is an informational sand-table/map insert at an opening, context
 * bridge, or payoff. A payoff may need the same map grammar to show the
 * sourced geographic result established by the episode; it is still not a
 * character-animation escape hatch. Keeping this predicate shared by
 * normalization and validation prevents the two stages from disagreeing. */
export function isSandTableBackground(scene: Value) {
  return isHistoricalSandTable(scene)
}

/** Annotations are a plan for local cartographic layers, never a request to
 * draw route arrows or labels in the generated map plate. Older saved shots
 * may omit this field; the new paid-video gate requires an approved plan. */
function validateStoryboardMapAnnotations(value: unknown, scene: Value, duration: number): void {
  if (value === undefined) return
  const plan = record(value, 'shot.mapAnnotations')
  if (plan.version !== 'historical-map-annotations-v1' || plan.orientation !== 'north-up') {
    fail('shot.mapAnnotations 必须使用 historical-map-annotations-v1 且上北下南')
  }
  const sceneRefs = new Set(String(scene.historicalBasis ?? '').match(/\[史料\d+\]/g) ?? [])
  const rawRefs = list(plan.sourceRefs, 'shot.mapAnnotations.sourceRefs')
  if (!rawRefs.length || rawRefs.some(ref => typeof ref !== 'string' || !sceneRefs.has(ref))
    || new Set(rawRefs).size !== rawRefs.length) {
    fail('shot.mapAnnotations.sourceRefs 必须唯一且来自本段已批准的 historicalBasis')
  }
  const sourceRefs = new Set(rawRefs as string[])
  const sourced = (item: Value, label: string) => {
    const sourceRef = text(item.sourceRef, `${label}.sourceRef`)
    if (!sourceRefs.has(sourceRef)) fail(`${label}.sourceRef 必须来自 mapAnnotations.sourceRefs`)
  }
  const position = (item: Value, label: string, min = 0, max = 1) => {
    for (const key of ['x', 'y']) {
      const coordinate = item[key]
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < min || coordinate > max) {
        fail(`${label}.${key} 必须是 ${min}–${max} 的地图坐标`)
      }
    }
  }
  if (!Array.isArray(plan.labels) || !Array.isArray(plan.routes)) fail('shot.mapAnnotations.labels/routes 必须是数组')
  const labels = plan.labels as Value[]
  const routes = plan.routes as Value[]
  if (labels.length > 8 || routes.length > 8) fail('地图标记和路线各最多 8 个')
  const routeObligation = Array.isArray(scene.requiredBeats) && scene.requiredBeats.some(beat =>
    /(?:追[击赶逐近及上]|逃|撤[退离走]|退[兵军]|行军|进军|南下|北上|东进|西进)/.test(JSON.stringify(beat)))
  if (routeObligation && !routes.length) fail('本段已有追逃或行军路线义务，mapAnnotations.routes 不能为空')
  for (const [index, item] of labels.entries()) {
    const label = record(item, `shot.mapAnnotations.labels[${index}]`)
    const content = text(label.text, `shot.mapAnnotations.labels[${index}].text`)
    if (content.length > 16 || /[\n\r。！？:：]/.test(content)) fail('地图标记只能是简短地名或势力名，不得写字幕或句子')
    position(label, `shot.mapAnnotations.labels[${index}]`, .08, .92)
    sourced(label, `shot.mapAnnotations.labels[${index}]`)
  }
  const ids = new Set<string>()
  const routesById = new Map<string, { direction: string; start: Value; end: Value }>()
  for (const [index, item] of routes.entries()) {
    const route = record(item, `shot.mapAnnotations.routes[${index}]`)
    const id = text(route.id, `shot.mapAnnotations.routes[${index}].id`)
    if (ids.has(id)) fail('地图路线 id 不得重复')
    ids.add(id)
    text(route.party, `shot.mapAnnotations.routes[${index}].party`)
    if (!['north', 'south', 'east', 'west'].includes(String(route.direction))) fail('地图路线 direction 必须是明确的东西南北方向')
    if (!['blue', 'red', 'ochre'].includes(String(route.color))) fail('地图路线 color 只能是 blue、red 或 ochre')
    sourced(route, `shot.mapAnnotations.routes[${index}]`)
    const points = list(route.points, `shot.mapAnnotations.routes[${index}].points`) as Value[]
    if (points.length < 2 || points.length > 16) fail('地图路线必须有 2–16 个连续坐标点')
    points.forEach((point, pointIndex) => position(record(point, `shot.mapAnnotations.routes[${index}].points[${pointIndex}]`),
      `shot.mapAnnotations.routes[${index}].points[${pointIndex}]`, .02, .98))
    const axis = ['north', 'south'].includes(String(route.direction)) ? 'y' : 'x'
    const sign = ['south', 'east'].includes(String(route.direction)) ? 1 : -1
    const deltas = points.slice(1).map((point, pointIndex) => sign * (Number(point[axis]) - Number(points[pointIndex][axis])))
    if (deltas.some(delta => delta < -0.015) || deltas.reduce((sum, delta) => sum + delta, 0) < 0.12) {
      fail(`地图路线 ${id} 的坐标推进方向与 ${String(route.direction)} 不一致`)
    }
    const startSecond = route.startSecond, endSecond = route.endSecond
    if (typeof startSecond !== 'number' || typeof endSecond !== 'number' || !Number.isFinite(startSecond)
      || !Number.isFinite(endSecond) || startSecond < 0 || endSecond <= startSecond || endSecond > duration) {
      fail(`地图路线 ${id} 的出现时段必须落在分镜 duration 内`)
    }
    routesById.set(id, { direction: String(route.direction), start: points[0], end: points.at(-1)! })
  }
  if (plan.relations !== undefined && !Array.isArray(plan.relations)) fail('shot.mapAnnotations.relations 必须是数组')
  if (Array.isArray(plan.relations)) for (const [index, item] of (plan.relations as Value[]).entries()) {
    const relation = record(item, `shot.mapAnnotations.relations[${index}]`)
    if (!['follows', 'approaches'].includes(String(relation.type))) fail('地图路线关系仅支持 follows 或 approaches')
    const leader = routesById.get(text(relation.leaderRouteId, 'leaderRouteId'))
    const follower = routesById.get(text(relation.followerRouteId, 'followerRouteId'))
    if (!leader || !follower || leader === follower || leader.direction !== follower.direction
      || relation.direction !== leader.direction) fail('地图追随关系必须绑定两条同向的已声明路线')
    const axis = ['north', 'south'].includes(leader.direction) ? 'y' : 'x'
    const sign = ['south', 'east'].includes(leader.direction) ? 1 : -1
    if (sign * (Number(leader.start[axis]) - Number(follower.start[axis])) < 0.02
      || sign * (Number(leader.end[axis]) - Number(follower.end[axis])) < -0.02) {
      fail('地图追随关系中后方路线不能越过前方路线或反向行进')
    }
  }
}

function sceneAudioObligations(scene: Value): string[] {
  return Array.isArray(scene.requiredBeats) ? (scene.requiredBeats as Value[]).flatMap(beat => {
    const observable = beat?.observable && typeof beat.observable === 'object' && !Array.isArray(beat.observable)
      ? beat.observable as Value : undefined
    return Array.isArray(observable?.audio)
      ? observable.audio.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())) : []
  }) : []
}

function requiresNarratedContext(scene: Value) {
  if (scene.editorialRole === 'episode_opening') return true
  if (scene.editorialRole !== 'context_bridge') return false
  const payload = scene.contextPayload && typeof scene.contextPayload === 'object' && !Array.isArray(scene.contextPayload)
    ? scene.contextPayload as Value : undefined
  return isAnimatedVisualTreatment(scene.visualTreatment)
    || Boolean(String(payload?.narration ?? '').trim())
    || sceneAudioObligations(scene).some(audio => !isNonSpeechAudioObligation(audio))
}

function anonymousLiveActionPerformance(scene: Value) {
  if (scene.visualTreatment !== 'live_action') return false
  const visualContract = JSON.stringify(Array.isArray(scene.requiredBeats)
    ? (scene.requiredBeats as Value[]).map(beat => ({
        description: beat?.description,
        mustShow: beat?.mustShow,
        visual: beat?.observable && typeof beat.observable === 'object' && !Array.isArray(beat.observable)
          ? (beat.observable as Value).visual : undefined,
      }))
    : [])
  return ANONYMOUS_LIVE_ACTION_SUBJECT.test(visualContract)
}

/** A live-action context bridge may be an environment-only establishing shot
 * (sunset, an empty corridor, a lamp being lit). Requiring a named actor in
 * that case invents a performance that the approved beat never asked for. */
export function allowsEmptyEditorialCast(scene: Value) {
  const role = String(scene.editorialRole ?? '')
  const treatment = String(scene.visualTreatment ?? '')
  const animationStyle = resolvedAnimationStyle(treatment, scene.animationStyle)
  const visualContract = JSON.stringify(Array.isArray(scene.requiredBeats)
    ? (scene.requiredBeats as Value[]).map(beat => ({
        description: beat?.description,
        mustShow: beat?.mustShow,
        visual: beat?.observable && typeof beat.observable === 'object' && !Array.isArray(beat.observable)
          ? (beat.observable as Value).visual : undefined,
      }))
    : [])
  // An explicit empty/unmanned frame has no identity to bind. Requiring a
  // named cast here made record-9ildu8 retry the same valid "空荡殿堂无人值守"
  // scene five times and encouraged the writer to invent a historical actor.
  const explicitlyUnmannedLiveAction = treatment === 'live_action'
    && /(?:无人在场|无人值守|空无一人|不见人影|空荡[^，。；;]*(?:殿堂|房间|院落|街巷|道路|营帐|厅堂))/.test(visualContract)
  return (isSandTableBackground(scene) && animationStyleAllowsEmptyCast(animationStyle))
    || (['episode_opening', 'context_bridge'].includes(role) && treatment === 'live_action')
    || explicitlyUnmannedLiveAction
    || anonymousLiveActionPerformance(scene)
}

function record(value: unknown, path: string): Value {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} 必须是对象`)
  return value as Value
}
function fail(message: string): never { throw new Error(`HISTORY_DRAMA_INVALID: ${message}`) }
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} 必须是非空字符串`)
  return value
}
function list(value: unknown, path: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) fail(`${path} 必须是${allowEmpty ? '' : '非空'}数组`)
  return value
}
function strings(value: unknown, path: string, allowEmpty = false): string[] {
  const values = list(value, path, allowEmpty).map((item, i) => text(item, `${path}[${i}]`))
  if (new Set(values).size !== values.length) fail(`${path} 不得重复`)
  return values
}
function namedRecords(value: unknown, field: string, path: string): Value[] {
  const result = list(value, path).map((item, i) => record(item, `${path}[${i}]`))
  strings(result.map(item => item[field]), `${path}.${field}`)
  return result
}
function same(a: unknown, b: unknown) { return canonicalJson(a) === canonicalJson(b) }

/** 键序和 `undefined` 字段属于序列化差异，不是内容差异：模型 echo 回已批准对象时常常重排
 * 字段，按 `JSON.stringify` 比较会把语义相同的候选当成“改写”。本函数只规范化结构，字符串
 * 一字不动，因为史料引文本身就要求逐字比对。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(structured(value))
  function structured(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(structured)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item as Value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, structured(entry)]))
    return item
  }
}

/** 用户改编边界、已批准事实这类“必须 echo”的文本常常只有全/半角标点、末尾句号或空白
 * 的差异，契约校验随后会用可信输入原样恢复。任何拿原始 JSON 字符串比较这类字段的守卫
 * 都会在语义完全相同的候选上假失败，白烧一次付费生成。本函数只统一书写形式，不改内容。 */
export const boundaryText = (value: unknown) => String(value ?? '').normalize('NFKC').trim().replace(/\s/g, '').replace(/[；;]/g, ';').replace(/[，,]/g, ',').replace(/[。.]$/, '')
function state(value: unknown, path: string): Value {
  const result = record(value, path)
  for (const key of ['knowledge', 'relationships', 'choices']) strings(result[key], `${path}.${key}`, true)
  return result
}
function sameState(a: Value, b: Value) {
  return ['knowledge', 'relationships', 'choices'].every(key => same([...(a[key] as string[])].sort(), [...(b[key] as string[])].sort()))
}

/** 抽象概括锚点（以“动作/表情/过程/画面”等元词结尾）无法被分镜原样拍出：分镜写的是
 * “抱起布匹”“开口哼唱”等具体可见短语，逐字覆盖校验会在高质量分镜上假失败。大纲必须
 * 给出可直接写入画面的具体锚点，与 beat.description 的实际用词一致。 */
const ABSTRACT_ANCHOR_SUFFIX = /(?:[動动]作|表情|[過过]程|[狀状][態态]|反[應应]|[畫画]面|[鏡镜][頭头]|[氣气][圍氛]|[氛气][围氛]|情[緒绪]|意[圖图]|[樣样]子|效果|情形|情[景景]|感[覺觉]|[氣气][勢势]|[張张]力|神[態态]|[話话][語语]|[對对]白|台[詞词]|[聲声]音|[聲声]部)$/
const CONCRETE_VISUAL_PREDICATE = /(?:抱|抬|举|放|取|拿|握|递|交|指|走|跑|踏|跨|转|回|起|坐|站|跪|拜|推|拉|打|击|穿|绕|摇|点|看|视|盯|闭|睁|张|开|飘|飞|落|升|沉|淡|移|缩|放大|铺|满|覆|遮|挡|燃|灭|亮|暗|涌|流|滴|破|裂|散|聚|定格|显现|消失|靠|贴|压|挥|舞|哼|唱|说|喊|哭|笑|微笑|皱眉|咬|拥|围|排|跪倒|跌倒|倒下|铺满|充满)/

/** A meta-word suffix is invalid only when it substitutes for the visible event.
 * Concrete subject + predicate phrases such as "黄巾布料剪影铺满整个画面" are already
 * executable and must not be rejected merely because their final noun is "画面". */
function isAbstractVisualAnchor(anchor: string) {
  const value = anchor.trim()
  if (!ABSTRACT_ANCHOR_SUFFIX.test(value)) return false
  const suffix = value.match(ABSTRACT_ANCHOR_SUFFIX)?.[0] ?? ''
  const concreteBody = value.slice(0, -suffix.length)
  return !/^[畫画]面$|^[鏡镜][頭头]$/.test(suffix) || !CONCRETE_VISUAL_PREDICATE.test(concreteBody)
}

/** Legacy snapshots are readable, but never silently upgraded. Only identifiers
 * and mechanical segment closure are derived; creative obligations stay intact. */
export function normalizeDramaOutline(output: unknown, expected: Value = {}): Value {
  const source = record(output, 'outline')
  if (source.contentContractVersion === undefined) {
    if (expected.requireDramaContract === true) fail(`缺少 ${HISTORY_DRAMA_VERSION} 内容契约，旧大纲必须重新生成及审核`)
    return { ...source }
  }
  if (source.contentContractVersion !== HISTORY_DRAMA_VERSION) fail(`不支持内容契约版本 ${String(source.contentContractVersion)}`)
  const input = expected.input && typeof expected.input === 'object' ? expected.input as Value : expected
  const adaptation = source.adaptationSpace && typeof source.adaptationSpace === 'object'
    ? { ...source.adaptationSpace as Value } : source.adaptationSpace
  // Models sometimes change a full-width semicolon or omit a terminal period.
  // Restore the exact trusted input only when every word remains identical;
  // substantive edits still fail the policy validator below.
  if (adaptation && typeof adaptation === 'object') for (const [key, inputKey] of [['policy', 'adaptation_policy'], ['sourceLevel', 'source_level']]) {
    if (typeof input[inputKey] === 'string' && String(input[inputKey]).trim()
      && boundaryText((adaptation as Value)[key]) === boundaryText(input[inputKey])) (adaptation as Value)[key] = input[inputKey]
  }
  const knownCharacterNames = Array.isArray(source.characterDramas)
    ? (source.characterDramas as unknown[]).flatMap(item => item && typeof item === 'object' && !Array.isArray(item)
      && typeof (item as Value).name === 'string' ? [String((item as Value).name)] : [])
    : []
  const removedAnonymousIdentityBindings = new Set<string>()
  const scenes = list(source.scenes, 'scenes').map((item, i) => {
    const scene = record(item, `scenes[${i}]`)
    const cast = Array.isArray(scene.cast) ? scene.cast : undefined
    const visibleContract = JSON.stringify(Array.isArray(scene.requiredBeats)
      ? (scene.requiredBeats as Value[]).map(beat => ({
          visual: beat?.observable && typeof beat.observable === 'object' && !Array.isArray(beat.observable)
            ? (beat.observable as Value).visual : undefined,
          mustShow: beat?.mustShow,
        }))
      : [])
    const visibleKnownPeople = knownCharacterNames.filter(name => visibleContract.includes(name))
    const namesKnownPerson = visibleKnownPeople.length > 0
    // For a narrated opening/bridge, contextPayload.narration and the sole
    // approved observable.audio line are the same authored fact written twice.
    // Providers occasionally fill the authoritative beat audio but leave the
    // duplicate narration slot blank. Restore only that exact, unambiguous
    // source string; multiple audio obligations still require an authored
    // ordering and remain a validation error.
    const payload = scene.contextPayload && typeof scene.contextPayload === 'object' && !Array.isArray(scene.contextPayload)
      ? scene.contextPayload as Value : undefined
    const approvedAudio = sceneAudioObligations(scene)
    let sceneWithNarration = requiresNarratedContext(scene) && payload && !String(payload.narration ?? '').trim()
      && approvedAudio.length === 1 && !isNonSpeechAudioObligation(approvedAudio[0])
      ? { ...scene, contextPayload: { ...payload, narration: approvedAudio[0] } }
      : scene
    // A valid sourced narration should not be rejected because the writer
    // underestimated its duration by one or two seconds. Duration is a
    // scheduling field, so extend it deterministically at the same 4.5 Han
    // characters/second threshold used by validation; never compress speech or
    // hide a narration that cannot fit the 15-second production ceiling.
    const normalizedPayload = sceneWithNarration.contextPayload && typeof sceneWithNarration.contextPayload === 'object'
      && !Array.isArray(sceneWithNarration.contextPayload) ? sceneWithNarration.contextPayload as Value : undefined
    const narrationLength = [...String(normalizedPayload?.narration ?? '')].filter(character => /\p{Script=Han}/u.test(character)).length
    const naturalNarrationDuration = Math.ceil(narrationLength / 4.5)
    if (narrationLength && naturalNarrationDuration <= 15 && Number.isFinite(Number(sceneWithNarration.targetDuration))
      && Number(sceneWithNarration.targetDuration) < naturalNarrationDuration) {
      sceneWithNarration = { ...sceneWithNarration, targetDuration: naturalNarrationDuration }
    }
    // The series' production contract is live action. Animation is reserved for
    // opening/context sand-table maps; portraits, tableaux, symbolic/time
    // montages and animated story scenes are projected back to real footage.
    // Remove the animation-only fields so downstream storyboard validation and
    // the video prompt cannot keep routing the shot through an illustration
    // first-frame branch.
    let productionScene = normalizeSandTableAesthetic(sceneWithNarration)
    const declaredAnimationStyle = resolvedAnimationStyle(productionScene.visualTreatment, productionScene.animationStyle)
    if (isAnimatedVisualTreatment(productionScene.visualTreatment) && declaredAnimationStyle && !isSandTableBackground(productionScene)) {
      const liveAction = { ...productionScene }
      delete liveAction.animationStyle
      delete liveAction.animationAesthetic
      productionScene = { ...liveAction, visualTreatment: 'live_action' }
    } else if (productionScene.visualTreatment === 'live_action'
      && (productionScene.animationStyle !== undefined || productionScene.animationAesthetic !== undefined)) {
      const liveAction = { ...productionScene }
      delete liveAction.animationStyle
      delete liveAction.animationAesthetic
      productionScene = liveAction
    }
    // The approved visual obligations, not a stray cast echo, decide who is
    // actually filmed. scene-11 in record-aa973z said only “一名弟子、病患、
    // 百姓” but carried cast=["张角"]. Downstream writers then had an
    // unsatisfiable choice: obey the cast and replace the disciple with Zhang
    // Jiao, or obey the beat and fail identity/viewpoint validation. Anonymous
    // ensemble action is still filmed with real performers, but anonymous
    // extras do not have reusable identity assets. Remove the unrelated named
    // binding without changing the live-action production treatment.
    if (productionScene.visualTreatment === 'live_action' && cast?.length && !namesKnownPerson
      && ANONYMOUS_LIVE_ACTION_SUBJECT.test(visibleContract)) {
      if (typeof scene.dramaticSceneId === 'string') removedAnonymousIdentityBindings.add(scene.dramaticSceneId)
      return { ...productionScene, cast: [] }
    }
    // Legacy-only fallback below remains for old snapshots that bypass the
    // current production projection. character_illustration is the named-character asset compositor: every
    // layer must correspond to a declared cast member and a cached portrait.
    // Writers nevertheless use the label for anonymous crowds, armies and
    // organisational diagrams, then keep cast=[] because inventing identities
    // would violate the source.  Those shots are accumulation/relationship
    // montages, not missing character bindings.  Project the mechanically
    // unrenderable combination to the existing empty-cast animation route so a
    // repair loop does not ask five times for fictional people.
    if (productionScene.visualTreatment === 'animated' && productionScene.animationStyle === 'character_illustration'
      && cast?.length === 0 && !namesKnownPerson) {
      return { ...productionScene, animationStyle: 'time_montage' }
    }
    // A named portrait is already an unambiguous asset binding: the visible
    // beat contract says exactly which previously declared character layers
    // must be composited.  Copy those one or two names into cast locally rather
    // than asking the writer to echo the same fact through five paid retries.
    // More than two visible people still needs an authored split.
    if (productionScene.visualTreatment === 'animated' && productionScene.animationStyle === 'character_illustration'
      && cast?.length === 0 && visibleKnownPeople.length <= 2) {
      return { ...productionScene, cast: visibleKnownPeople }
    }
    // Generic crowds do not need invented named character assets. Keep their
    // live-action treatment and allow an empty identity cast instead of asking
    // every repair round for fictional named roles. A named person mentioned only as background in purpose or
    // narration is not visually present; only approved visual obligations keep a
    // named historical person in live action and require a real cast repair.
    if (productionScene.visualTreatment === 'live_action' && cast?.length === 0
      && productionScene.editorialRole !== 'context_bridge') {
      if (!namesKnownPerson) return productionScene
      // The visible beat contract is authoritative about who must appear. An
      // empty cast is only a missing asset binding, not a creative ambiguity,
      // when one or two already-declared characters are named there. Derive the
      // binding instead of spending five paid generations asking the writer to
      // copy the same names into a second field. More than two people still
      // requires an authored split and remains a hard validation failure.
      if (visibleKnownPeople.length <= 2) return { ...productionScene, cast: visibleKnownPeople }
    }
    return productionScene
  })
  const projected = scenes.map((scene, index) => {
    const id = text(scene.dramaticSceneId, `scenes[${index}].dramaticSceneId`)
    const continuous = index > 0 && scenes[index - 1].dramaticSceneId === id
    const requestedMode = scene.continuityMode
    const mode = !continuous && [undefined, 'scene_cut', 'tail_continuation', 'coverage_cut'].includes(requestedMode as string | undefined)
      ? 'scene_cut' : requestedMode ?? 'tail_continuation'
    return { ...scene, contentContractVersion: HISTORY_DRAMA_VERSION, dramaticUnitId: id,
      settingId: id, closesUnit: scenes[index + 1]?.dramaticSceneId !== id,
      continuityFromPrevious: continuous,
      continuityMode: mode,
    }
  })
  // Who acts inside a complete scene is decided by the segments that film it, so dramaticScenes.characters
  // and the per-segment cast lists are one fact written twice. A 19-segment outline has to keep that union
  // straight by hand and routinely misses one name: record-vrwgoy spent three structurally clean outline
  // generations and died on “dramaticScenes.drama-06.characters 必须与所属拍摄段的行动人物一致”.
  // Deriving the projection costs nothing and removes no authorship - characterStates below still has to
  // be written for exactly these names, which is the part only the writer can supply.
  const casts = new Map<string, string[]>()
  projected.forEach(scene => {
    const merged = casts.get(String(scene.dramaticUnitId)) ?? []
    const cast = (scene as Value).cast
    for (const name of Array.isArray(cast) ? cast : []) {
      if (typeof name === 'string' && !merged.includes(name)) merged.push(name)
    }
    casts.set(String(scene.dramaticUnitId), merged)
  })
  let dramaticScenes = Array.isArray(source.dramaticScenes)
    ? (source.dramaticScenes as unknown[]).map((item, index) => {
      const drama = record(item, `dramaticScenes[${index}]`)
      const derived = casts.get(String(drama.id)) ?? []
      const declared = Array.isArray(drama.characters) ? drama.characters : []
      const removeStaleAnonymousStates = removedAnonymousIdentityBindings.has(String(drama.id))
      const characterStates = removeStaleAnonymousStates && Array.isArray(drama.characterStates)
        ? drama.characterStates.filter(state => state && typeof state === 'object' && !Array.isArray(state)
          && derived.includes(String((state as Value).name ?? '')))
        : drama.characterStates
      if (!derived.length && !removeStaleAnonymousStates) return drama
      if ((declared.length === derived.length && derived.every(name => declared.includes(name))) && characterStates === drama.characterStates) return drama
      return { ...drama, characters: derived, ...(characterStates !== undefined ? { characterStates } : {}) }
    })
    : source.dramaticScenes
  if (expected.deriveInheritedStates === true && Array.isArray(dramaticScenes) && Array.isArray(source.characterDramas)) {
    // `before` is not a creative choice: it is the previous accepted `after`
    // (or the character's initialState on first appearance). Requiring a text
    // model to copy this projection exactly caused multi-minute retries that
    // could not add information. Derive only this mechanical half; authored
    // `after` states, missing characters and malformed containers still fail.
    const inherited = new Map<string, Value>()
    for (const item of source.characterDramas as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const character = item as Value
      if (typeof character.name === 'string' && character.initialState && typeof character.initialState === 'object' && !Array.isArray(character.initialState)) {
        inherited.set(character.name, structuredClone(character.initialState as Value))
      }
    }
    dramaticScenes = dramaticScenes.map(drama => {
      if (!Array.isArray(drama.characterStates)) return drama
      const segments = projected.filter(scene => scene.dramaticUnitId === drama.id)
      const staticPortraitOnly = segments.length > 0 && segments.every(scene =>
        ['character_illustration', 'historical_map'].includes(
          resolvedAnimationStyle((scene as Value).visualTreatment, (scene as Value).animationStyle)))
      const states = [...drama.characterStates]
      // A static portrait layer cannot acquire knowledge, change a relationship
      // or make a choice. If its cast binding was omitted together with the
      // duplicate state row, the only truthful projection is a no-op state.
      // This is deliberately limited to all-static portrait dramas; any live
      // performance still requires the writer to author its after state.
      if (staticPortraitOnly && Array.isArray(drama.characters)) for (const name of drama.characters) {
        if (typeof name !== 'string' || states.some(item => item && typeof item === 'object' && !Array.isArray(item) && (item as Value).name === name)) continue
        const before = inherited.get(name)
        if (before) states.push({ name, before: structuredClone(before), after: structuredClone(before) })
      }
      const characterStates = states.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item
        const change = item as Value
        const name = typeof change.name === 'string' ? change.name : ''
        const before = inherited.get(name)
        if (name && change.after && typeof change.after === 'object' && !Array.isArray(change.after)) {
          inherited.set(name, structuredClone(change.after as Value))
        }
        return before ? { ...change, before: structuredClone(before) } : change
      })
      return { ...drama, characterStates }
    })
  }
  return { ...source, adaptationSpace: adaptation, scenes: projected, ...(dramaticScenes !== undefined ? { dramaticScenes } : {}) }
}

export function expectedSourceRefs(expected: Value): Set<string> | undefined {
  if (Array.isArray(expected.sourceRefs)) return new Set(expected.sourceRefs.map(String))
  const source = expected.historicalSources ?? expected.historical_sources
  const citations = source && typeof source === 'object' ? (source as Value).citations : expected.citations
  if (citations === undefined) return undefined
  if (Array.isArray(citations)) return new Set(citations.map((citation, index) => {
    const source = citation && typeof citation === 'object' ? citation as Value : {}
    return `[史料${String(source.index ?? index + 1)}]`
  }))
  const serialized = typeof citations === 'string' ? citations : JSON.stringify(citations)
  return new Set(serialized.match(/\[史料\d+\]/g) ?? [])
}

/** Checks references, inherited state and explicit obligations. Whether a scene
 * is moving or funny is an editorial judgement, never a keyword score. */
export function validateDramaOutline(output: unknown, expected: Value = {}): Value {
  const outline = normalizeDramaOutline(output, expected)
  if (expected.selectedCharacterVisuals !== undefined) {
    if (!Array.isArray(expected.selectedCharacterVisuals)) fail('selectedCharacterVisuals 必须是已解析的所选人物设计数组')
    assertSelectedCharacterVisuals(outline, expected.selectedCharacterVisuals as ResolvedCharacterVisualSelection[])
  }
  if (outline.contentContractVersion === undefined) return outline
  // Malformed containers and duplicate identities prevent a reliable walk.
  // References that do not control traversal can be reported alongside every
  // independent defect; an invalid payoff ID must not discard earlier issues.
  const issues: string[] = []
  const collectRefs = (value: unknown, allowed: Set<string>, path: string, allowEmpty = false) => {
    const values = strings(value, path, allowEmpty)
    for (const id of values) if (!allowed.has(id)) issues.push(`${path} 引用不存在的 ${id}`)
    return values
  }
  const locks = namedRecords(outline.historicalLocks, 'id', 'historicalLocks')
  const lockIds = new Set(locks.map(lock => String(lock.id)))
  const sourceRefs = expectedSourceRefs(expected)
  const validateVisualAgeSources = (value: unknown, path: string) => {
    const context = normalizeCharacterVisualContext(value)
    if (!context || !['documented', 'estimated'].includes(context.age.basis)) return
    const refs = context.age.sourceRefs ?? []
    if (refs.some(ref => !/^\[史料\d+\]$/.test(ref))) issues.push(`${path}.age.sourceRefs 必须使用已有 [史料N]，不得用未核对的生年标为正史年龄`)
    if (sourceRefs) collectRefs(refs, sourceRefs, `${path}.age.sourceRefs`)
    else issues.push(`${path}.age.sourceRefs 缺少本集已核对来源，无法验证确证/估计年龄；请提供史料或如实标为artistic/unknown`)
  }
  for (const lock of locks) {
    text(lock.fact, `historicalLocks.${String(lock.id)}.fact`)
    const citations = strings(lock.sourceRefs, `historicalLocks.${String(lock.id)}.sourceRefs`)
    if (citations.some(citation => !/^\[史料\d+\]$/.test(citation))) fail('historicalLocks.sourceRefs 必须使用 [史料N]')
    if (sourceRefs) collectRefs(citations, sourceRefs, 'historicalLocks.sourceRefs')
  }
  const adaptation = record(outline.adaptationSpace, 'adaptationSpace')
  const input = expected.input && typeof expected.input === 'object' ? expected.input as Value : expected
  for (const [key, inputKey] of [['policy', 'adaptation_policy'], ['sourceLevel', 'source_level']]) {
    text(adaptation[key], `adaptationSpace.${key}`)
    if (input[inputKey] !== undefined && String(input[inputKey]).trim()
      && String(adaptation[key]).trim() !== String(input[inputKey]).trim()) issues.push(`adaptationSpace.${key} 必须原样继承 input.${inputKey}；权威输入原文=${JSON.stringify(input[inputKey])}；当前收到=${JSON.stringify(adaptation[key])}。两项输入不可互换，只修被点名字段，不改其余剧情`)
  }
  strings(adaptation.allowed, 'adaptationSpace.allowed')
  strings(adaptation.forbidden, 'adaptationSpace.forbidden')
  const characters = namedRecords(outline.characterDramas, 'name', 'characterDramas')
  const characterNames = new Set(characters.map(character => String(character.name)))
  const lastStates = new Map<string, Value>()
  for (const character of characters) {
    const path = `characterDramas.${String(character.name)}`
    if (character.visualContext !== undefined) {
      character.visualContext = normalizeCharacterVisualContext(character.visualContext)
      validateVisualAgeSources(character.visualContext, `${path}.visualContext`)
    }
    for (const key of ['goal', 'concern', 'leverage', 'tactic', 'speechStyle']) text(character[key], `${path}.${key}`)
    if (!['historical', 'performance', 'unknown'].includes(String(character.basis))) fail(`${path}.basis 必须区分史载、表演拟制与未知`)
    collectRefs(character.historicalLockIds, lockIds, `${path}.historicalLockIds`, character.basis !== 'historical')
    const motivation = record(character.coreMotivation, `${path}.coreMotivation`)
    if (!['unknown', 'historical'].includes(String(motivation.status))) issues.push(`${path}.coreMotivation.status 未知核心动机不能作为表演拟制编造`)
    text(motivation.description, `${path}.coreMotivation.description`)
    // Unknown references and wrong source status share the same repair round;
    // malformed containers still stop before dependent checks.
    const motivationRefs = collectRefs(motivation.historicalLockIds, lockIds, `${path}.coreMotivation.historicalLockIds`, true)
    if (motivation.status === 'historical' && !motivationRefs.length) issues.push(`${path}.coreMotivation.historicalLockIds 必须是非空数组`)
    if (motivation.status === 'unknown' && motivationRefs.length) issues.push(`${path}.coreMotivation 未知动机不得伪装为史载事实`)
    lastStates.set(String(character.name), state(character.initialState, `${path}.initialState`))
  }
  const scenes = namedRecords(outline.scenes, 'id', 'scenes')
  const dramas = namedRecords(outline.dramaticScenes, 'id', 'dramaticScenes')
  const editorialContract = expected.requireEditorialGrammar === true || scenes.some(scene => scene.editorialRole !== undefined || scene.visualTreatment !== undefined)
  const dramaIds = new Set(dramas.map(drama => String(drama.id)))
  const beats = new Map<string, Value>()
  const allocation = new Map<string, string[]>()
  const firstAppearances: string[] = []
  scenes.forEach((scene, index) => {
    const path = `scenes[${index}]`
    if (expected.requireCharacterVisuals === true && scene.characterVisuals === undefined) issues.push(`${path}.characterVisuals 缺少本段人物年龄与场景造型设计；无人镜头填写[]，未知年龄如实标unknown`)
    if (expected.requireCharacterEquipment === true && scene.characterEquipment === undefined) issues.push(`${path}.characterEquipment 必须显式写[]或本段剧情明确要求的装备；缺失不能视为空需求`)
    if (scene.characterVisuals !== undefined) {
      const cast = Array.isArray(scene.cast) ? scene.cast.filter((name): name is string => typeof name === 'string') : []
      scene.characterVisuals = validatedCharacterVisuals(scene.characterVisuals, cast, `${path}.characterVisuals`)
      const designed = scene.characterVisuals as Value[]
      designed.forEach(row => validateVisualAgeSources(row.visualContext, `${path}.characterVisuals.${String(row.name)}.visualContext`))
      if (cast.some(name => !designed.some(row => row.name === name))) issues.push(`${path}.characterVisuals 必须覆盖本段cast的每个具名人物；可如实使用未知年龄，不可省略年龄与场合设计`)
    }
    if (scene.characterEquipment !== undefined) {
      const cast = Array.isArray(scene.cast) ? scene.cast.filter((name): name is string => typeof name === 'string') : []
      scene.characterEquipment = validatedCharacterEquipment(scene.characterEquipment, cast, `${path}.characterEquipment`)
    }
    const editorialRole = editorialContract ? text(scene.editorialRole, `${path}.editorialRole`) : String(scene.editorialRole ?? '')
    const visualTreatment = editorialContract ? text(scene.visualTreatment, `${path}.visualTreatment`) : String(scene.visualTreatment ?? '')
    if (editorialContract && !['episode_opening', 'story', 'context_bridge', 'payoff'].includes(editorialRole)) issues.push(
      `${path}.editorialRole 无效：收到 ${JSON.stringify(editorialRole)}；仅允许 episode_opening、story、context_bridge、payoff。普通剧情段使用 story，结尾回应开场承诺的段使用 payoff`,
    )
    if (editorialContract && !['live_action', 'animated', 'animated_map', 'historical_montage'].includes(visualTreatment)) issues.push(`${path}.visualTreatment 无效`)
    const animated = isAnimatedVisualTreatment(visualTreatment)
    const animationStyle = resolvedAnimationStyle(visualTreatment, scene.animationStyle)
    if (animated && !isSandTableBackground(scene)) issues.push(
      `${path} 动画仅允许用于 episode_opening/context_bridge/payoff 的 historical_map 历史地理地图信息背景；其余人物、环境、时间流逝与历史场景必须使用 live_action 真人实景`,
    )
    if (visualTreatment === 'animated') {
      if (!(ANIMATION_STYLES as readonly string[]).includes(String(scene.animationStyle ?? ''))) issues.push(`${path}.animationStyle 无效`)
      if (!(ANIMATION_AESTHETICS as readonly string[]).includes(String(scene.animationAesthetic ?? ''))) issues.push(`${path}.animationAesthetic 无效`)
    } else if (scene.animationStyle !== undefined || scene.animationAesthetic !== undefined) {
      issues.push(`${path} 只有 visualTreatment=animated 可声明 animationStyle/animationAesthetic；旧 animated_map/historical_montage 由系统兼容映射`)
    }
    if (animationStyle === 'character_illustration' && (!Array.isArray(scene.cast) || !scene.cast.length)) {
      issues.push(`${path}.animationStyle=character_illustration 必须声明实际出镜人物 cast，以绑定角色资产`)
    }
    // contextPayload exists to establish or re-establish time, place and causal
    // context. A payoff may use animation to show the already-established result;
    // its requiredBeats remain the authoritative sound/picture contract. Requiring
    // payoff to duplicate those facts in contextPayload caused the writer to
    // return different valid revisions while the same empty-object error stalled.
    const editorialInsert = requiresNarratedContext(scene)
    const emptyCastAllowed = allowsEmptyEditorialCast(scene)
    // Environment-only live-action bridges can retain static background
    // metadata without inventing narration. If supplied, its fields still
    // have to be complete; opening/maps and speech retain the narration gate.
    if (editorialInsert || (editorialRole === 'context_bridge' && scene.contextPayload !== undefined)) {
      const payload = scene.contextPayload && typeof scene.contextPayload === 'object' && !Array.isArray(scene.contextPayload)
        ? scene.contextPayload as Value
        : undefined
      if (!payload) issues.push(`${path}.contextPayload 必须是对象；开场、历史地图及含话语的承接镜头需一次补齐 timePlace、geographicFocus、historicalBackground、narration（场景 ${String(scene.id)}；${visualTreatment} 有旁白的承接镜头同样需要；沿用该段已有史实和 observable.audio 原文，不改声画剧情；只有已确认全为物理音效且无话语的真人承接镜头可省略此对象）`)
      else {
        for (const key of editorialInsert ? ['timePlace', 'historicalBackground', 'narration'] : ['timePlace', 'historicalBackground']) {
          if (typeof payload[key] !== 'string' || !String(payload[key]).trim()) issues.push(`${path}.contextPayload.${key} 必须是非空字符串`)
        }
        if (!Array.isArray(payload.geographicFocus) || !payload.geographicFocus.length
          || payload.geographicFocus.some(item => typeof item !== 'string' || !item.trim())) {
          issues.push(`${path}.contextPayload.geographicFocus 必须是非空字符串数组`)
        }
      }
      if (editorialInsert && Number(scene.targetDuration) < 4) issues.push(`${path} 的开场/承接信息镜头不得短于4秒，保证地图与旁白可辨识`)
      // The writing brief says 4–8 seconds is preferred, not mandatory. A
      // sourced narration may legitimately need the workflow-wide 15-second
      // ceiling; forcing it into eight seconds contradicts the natural speech
      // capacity check immediately below and creates an impossible repair.
      if (Number(scene.targetDuration) > 15) issues.push(`${path} 的开场/承接信息镜头不得超过15秒；保留必要信息并拆成连续段，不能加速朗读`)
      const narrationLength = [...String(payload?.narration ?? '')].filter(character => /\p{Script=Han}/u.test(character)).length
      if (Number.isFinite(Number(scene.targetDuration)) && narrationLength > Number(scene.targetDuration) * 4.5) {
        issues.push(`${path}.contextPayload.narration 共${narrationLength}个汉字，超过${String(scene.targetDuration)}秒自然旁白容量；拆分或精简，不能加速朗读`)
      }
    }
    const dramaId = text(scene.dramaticSceneId, `${path}.dramaticSceneId`)
    if (!dramaIds.has(dramaId)) fail(`${path}.dramaticSceneId 引用不存在的 ${dramaId}`)
    if (!allocation.has(dramaId)) { allocation.set(dramaId, []); firstAppearances.push(dramaId) }
    else if (scenes[index - 1]?.dramaticSceneId !== dramaId) issues.push(`${dramaId} 的连续拍摄段被另一场戏打断（${path}.dramaticSceneId，场景 ${String(scene.id)}）`)
    collectRefs(scene.cast, characterNames, `${path}.cast`, emptyCastAllowed)
    const continuous = scene.continuityFromPrevious === true
    if (!['tail_continuation', 'coverage_cut', 'scene_cut'].includes(String(scene.continuityMode))
      || (continuous && scene.continuityMode === 'scene_cut')
      || (!continuous && scene.continuityMode !== 'scene_cut')) issues.push(`${path}.continuityMode 与完整戏归属不一致（场景 ${String(scene.id)}）`)
    const required = namedRecords(scene.requiredBeats, 'id', `${path}.requiredBeats`)
    const drama = dramas.find(item => item.id === dramaId)!
    for (const [beatIndex, beat] of required.entries()) {
      const id = String(beat.id)
      const beatPath = `${path}.requiredBeats[${beatIndex}]`
      if (beats.has(id)) fail(`requiredBeats 存在全局重复 id ${id}`)
      for (const key of ['function', 'stateChange', 'description', 'setting']) text(beat[key], `${path}.${id}.${key}`)
      if (beat.setting !== drama.setting) issues.push(`${path}.${id}.setting 必须与完整戏 ${dramaId} 的唯一空间一致（字段 ${beatPath}.setting，场景 ${String(scene.id)}）`)
      const mustShow = strings(beat.mustShow, `${path}.${id}.mustShow`)
      const observable = record(beat.observable, `${path}.${id}.observable`)
      const visual = strings(observable.visual, `${path}.${id}.observable.visual`, true)
      const audio = strings(observable.audio, `${path}.${id}.observable.audio`, true)
      if (!visual.length && !audio.length) issues.push(`${id} 必须有实际声画义务，不能只写幕后意图（字段 ${beatPath}.observable，场景 ${String(scene.id)}）`)
      for (const [field, anchors] of [['mustShow', mustShow], ['observable.visual', visual]] as const) {
        for (const [anchorIndex, anchor] of anchors.entries()) if (isAbstractVisualAnchor(anchor)) issues.push(
          `${path}.${id} 的声画锚点“${anchor}”是抽象概括（字段 ${beatPath}.${field}[${anchorIndex}]，场景 ${String(scene.id)}；以动作/表情/过程/画面/话语等元词结尾），分镜无法原样拍出，逐字覆盖校验必然假失败；改用可直接写入画面的具体可见短语（例如把“传唱动作”写成“哼唱歌谣”）；若它只是对白/话语标签，从 mustShow 或 observable.visual 删除该标签并把完整原话保留在 observable.audio，不得重复造一条视觉台词义务。`)
      }
      beats.set(id, beat)
      allocation.get(dramaId)!.push(id)
    }
    if (isStaticIllustrationStyle(visualTreatment, animationStyle)) {
      const mustShow = required.flatMap(beat => beat.mustShow as string[])
      const visual = required.flatMap(beat => (beat.observable as Value).visual as string[])
      const audio = required.flatMap(beat => (beat.observable as Value).audio as string[])
      if (!mustShow.length || !visual.length) issues.push(`${path} 的二维插画必须声明实际背景或人物图层编排，不能只写幕后意图`)
      if (animationStyle === 'character_illustration' && [...mustShow, ...visual].some(anchor => /走|跑|转身|开口|说话|眨眼|抬手|挥手|起身|坐下/.test(anchor))) issues.push(
        `${path} 的 character_illustration 只能移动、缩放或渐变整个人物插画图层，不得安排人物走路、说话、表情或肢体动作`,
      )
      if (!audio.length) issues.push(`${path} 的静态插画必须提供史实画外旁白，不能靠画面文字或人物动作解释背景`)
    }
  })
  if (editorialContract && String(scenes[0]?.editorialRole) !== 'episode_opening') issues.push('scenes[0].editorialRole 必须为 episode_opening，先建立本集时空、局势和核心问题，再进入人物剧情')
  if (editorialContract && String(dramas[0]?.function) !== 'setup') issues.push('首个 dramaticScenes.function 必须为 setup，开场建立镜头不得直接作为主冲突回应')
  if (editorialContract && dramas.length >= 3 && !scenes.some(scene => scene.editorialRole === 'context_bridge')) {
    issues.push('跨越三个及以上完整戏时至少安排一个 context_bridge，用地图、历史蒙太奇或有因果锚点的承接镜头重建时空/势力关系，禁止全程硬切')
  }
  if (!same(firstAppearances, dramas.map(drama => drama.id))) fail('dramaticScenes 的顺序必须与 scenes 中完整戏首次出现顺序一致，且每场戏必须被拍摄')
  for (const [dramaIndex, drama] of dramas.entries()) {
    const path = `dramaticScenes.${String(drama.id)}`
    if (!['conflict', 'setup', 'consequence', 'transition'].includes(String(drama.function))) issues.push(`${path}.function 无效：收到 ${JSON.stringify(drama.function)}；仅允许 conflict、setup、consequence、transition；payoff 是 scenes[].editorialRole，不是完整戏 function（字段 dramaticScenes[${dramaIndex}].function）`)
    for (const key of ['setting', 'goal', 'obstacle', 'tactics', 'turn', 'result']) text(drama[key], `${path}.${key}`)
    const dramaSegments = scenes.filter(scene => scene.dramaticSceneId === drama.id)
    const editorialDrama = dramaSegments.length > 0 && dramaSegments.every(scene => allowsEmptyEditorialCast(scene))
    const cast = collectRefs([...new Set(dramaSegments
      // normalizeDramaOutline above already projects this union back onto drama.characters, so a
      // hand-written outline is checked against the same source of truth instead of a second opinion.
      .flatMap(scene => scene.cast as string[]))], characterNames, `${path}.characters`, editorialDrama)
    const assigned = collectRefs(drama.beatIds, new Set(beats.keys()), `${path}.beatIds`)
    if (!same(assigned, allocation.get(String(drama.id)))) issues.push(`${path}.beatIds 必须按顺序完整分配至所属短段，不得丢失反制/选择等节拍；权威所属 scenes.requiredBeats.id 顺序为 ${JSON.stringify(allocation.get(String(drama.id)))}，收到 ${JSON.stringify(assigned)}（字段 dramaticScenes[${dramaIndex}].beatIds；只同步引用，不改节拍内容或归属）`)
    // An empty array is a structurally valid container even when this drama has
    // actors. Keep walking so the diagnostic below can name every missing
    // character. The old early `list(..., false)` failure only said "must be a
    // non-empty array"; repair prompts could not tell an intentional actorless
    // editorial insert from a mixed drama that had dropped 张角, so paid retries
    // repeatedly echoed the same empty array.
    const stateValues = list(drama.characterStates, `${path}.characterStates`, true)
    const states = stateValues.map((item, index) => record(item, `${path}.characterStates[${index}]`))
    if (states.length) strings(states.map(item => item.name), `${path}.characterStates.name`)
    // Naming who is missing is the difference between a repair and a guess: an unnamed “必须覆盖全部
    // 场内人物” sends the writer hunting through every field of the drama, and each round returns a
    // different person dropped.
    const missingStates = cast.filter(name => !states.some(item => String(item.name) === name))
    const extraStates = states.map(item => String(item.name)).filter(name => !cast.includes(name))
    if (states.length !== cast.length || missingStates.length || extraStates.length) {
      // The remedy has to be stated per direction too: “不得删除已有条目” while a surplus entry is
      // precisely what must go leaves the writer no legal edit, and it burns the shared generation budget.
      const remedy = [missingStates.length ? '为被点名的缺失人物补写 before/after' : '',
        extraStates.length ? '删除被点名人物的整条 characterStates（该人不在本场任何拍摄段出场）' : '',
        '未被点名的人物条目一字不改，不得靠改名凑数'].filter(Boolean).join('；')
      issues.push(`${path}.characterStates 必须与场内人物一一对应：缺少 ${missingStates.join('、') || '无'}；不属于本场人物 ${extraStates.join('、') || '无'}。${remedy}`)
      // A missing after state makes its next inherited value unknown. Do not invent a second
      // mismatch against an older scene, or let an out-of-scene entry overwrite the true state.
      missingStates.forEach(name => lastStates.delete(name))
    }
    for (const [stateIndex, change] of states.entries()) {
      const name = String(change.name)
      if (!cast.includes(name)) continue
      const statePath = `dramaticScenes[${dramaIndex}].characterStates[${stateIndex}]`
      const before = state(change.before, `${path}.${name}.before`)
      const after = state(change.after, `${path}.${name}.after`)
      const inherited = lastStates.get(name)
      if (inherited && !sameState(before, inherited)) issues.push(`${path}.${name}.before 丢失或改写前场已知信息、选择或关系状态（字段 ${statePath}.before）`)
      if ((before.knowledge as string[]).some(fact => !(after.knowledge as string[]).includes(fact))) issues.push(`${path}.${name}.after 不得无故遗忘已知信息（字段 ${statePath}.after.knowledge）`)
      if ((before.choices as string[]).some(choice => !(after.choices as string[]).includes(choice))) issues.push(`${path}.${name}.after 必须保留已作选择；新决定应追加记录（字段 ${statePath}.after.choices）`)
      lastStates.set(name, after)
    }
  }
  const episode = record(outline.episodeDrama, 'episodeDrama')
  for (const key of ['centralQuestion', 'stakes']) text(episode[key], `episodeDrama.${key}`)
  collectRefs(episode.viewpointCharacters, characterNames, 'episodeDrama.viewpointCharacters')
  for (const key of ['openingPromise', 'payoff']) {
    const promise = record(episode[key], `episodeDrama.${key}`)
    text(promise.description, `episodeDrama.${key}.description`)
    const ids = collectRefs(promise.beatIds, new Set(beats.keys()), `episodeDrama.${key}.beatIds`)
    const boundary = key === 'openingPromise' ? dramas[0] : dramas.at(-1)!
    if (!ids.some(id => (boundary.beatIds as string[]).includes(id))) issues.push(`episodeDrama.${key} 必须落实在${key === 'openingPromise' ? '开场' : '结尾'}完整戏的实际节拍`)
  }
  if (issues.length) throw new DramaOutlineIssuesError(outline, issues)
  return outline
}

function coverageText(value: unknown) { return String(value ?? '').replace(/[\s，,。；;：:'"“”‘’（）()【】\-—]/g, '') }
function narrationText(value: unknown) { return String(value ?? '').trim().replace(/^(?:旁白|画外旁白|画外音|解说)[：:]\s*/, '') }
function audioText(value: unknown) { return coverageText(narrationText(value)) }
function audioFragment(value: string, source: string) {
  const expected = narrationText(source), actual = narrationText(value)
  const speaker = expected.match(/^([^：:\n]{1,20})[：:]/)?.[1]
  const actualSpeaker = actual.match(/^([^：:\n]{1,20})[：:]/)?.[1]
  if (speaker && actualSpeaker && speaker !== actualSpeaker) return { whole: '', part: '' }
  const whole = coverageText(speaker ? expected.replace(/^[^：:\n]+[：:]\s*/, '') : expected)
  const part = coverageText(speaker && actualSpeaker === speaker ? actual.replace(/^[^：:\n]+[：:]\s*/, '') : actual)
  return { whole, part }
}

/** Only explicit, current performances immediately introducing the approved
 * quoted words establish a voice contract. Mentioning a song, remembering a
 * singer, or an unbound bare audio string does not imply an on-camera song. */
function sourceVoiceContract(obligation: Value, scene: Value, anchor: string) {
  const description = String(obligation.description ?? '')
  const anchorBody = audioFragment(anchor, anchor).whole
  if (!anchorBody) return undefined
  const cast = Array.isArray(scene.cast) ? scene.cast.filter((name): name is string => typeof name === 'string' && !!name.trim()) : []
  let previousQuoteEnd = 0
  for (const quote of description.matchAll(/["“‘「『']([^"”’」』']+)["”’」』']/g)) {
    const before = description.slice(previousQuoteEnd, quote.index).split(/[。；;\n]/).at(-1)!.trim()
    previousQuoteEnd = quote.index! + quote[0].length
    if (!audioFragment(quote[1], quote[1]).whole.includes(anchorBody)) continue
    // A reported or negated performance does not bind the present speaker.
    if (/转述|提到|谈及|回忆|曾经|曾[唱说]|听说|听见|听到|据说|想象|模仿|没有|并未|未曾|尚未|停止|禁止|不得|不要|不(?:再|会|肯|愿)?(?:传唱|吟唱|哼唱|唱出|演唱|歌唱)/.test(before)) continue
    if (/(?:画外旁白|画外音|旁白|解说)(?:说出|朗读|说|道)?\s*[：:]?\s*$/.test(before)) return { mode: 'narration' as const, actors: ['旁白'] }
    const musical = before.match(/(?:传唱|吟唱|哼唱|唱出|演唱|歌唱)(?:歌谣|歌词|原文|这句|一句|道|出)*\s*[：:]?\s*$/)
    if (!musical) continue
    const lead = before.slice(0, musical.index)
    // A preceding action can carry the subject: “乡人驻足，开始传唱”。
    // Resolve a shortened role only when exactly one approved cast name fits;
    // ambiguous prose keeps actor choice open instead of inventing a binding.
    let actors: string[] | undefined
    for (const clause of lead.split(/[，,]/).reverse()) {
      const subject = clause.trim().match(/^([\p{Script=Han}]{1,16}?)(?=驻足|停步|开始|继续|开口|正|低声|高声|轻声|边|向|对|$)/u)?.[1]
      if (!subject || /^(?:开始|继续|开口)$/.test(subject)) continue
      const exact = cast.filter(name => subject === name)
      const matches = exact.length ? exact : cast.filter(name => name.endsWith(subject))
      if (matches.length === 1) actors = matches
      break
    }
    return { mode: 'musical' as const, actors }
  }
  return undefined
}

function validateSourceVoicePerformance(shot: Value, scene: Value, obligation: Value) {
  const pacing = shot.pacing as Value | undefined
  if (pacing?.version !== 'duration-v2' || !Array.isArray(pacing.beats)) return
  const observable = obligation.observable as Value
  const groups = Array.isArray(pacing.actorGroups) ? pacing.actorGroups as Value[] : []
  for (const anchor of strings(observable.audio, 'observable.audio', true)) {
    const contract = sourceVoiceContract(obligation, scene, anchor)
    if (!contract) continue
    const whole = audioFragment(anchor, anchor).whole
    const voices = pacing.beats.filter((value): value is Value => !!value && typeof value === 'object' && !Array.isArray(value))
      .filter(beat => beat.sourceBeatId === obligation.id && beat.kind === 'speech')
      .map(beat => ({ beat, body: audioFragment(String(beat.textOrVocalization ?? ''), anchor).part }))
      .filter(({ body }) => body && (whole.includes(body) || body.includes(whole)))
    const matching = voices.filter(({ beat }) => {
      if (contract.mode === 'narration' ? beat.deliveryStyle !== 'narration' : !['chant', 'singing'].includes(String(beat.deliveryStyle))) return false
      if (!contract.actors) return true
      const actors = Array.isArray(beat.actorIds) ? beat.actorIds.map(id => groups.find(group => group.id === id)?.label ?? id) : []
      return same(actors, contract.actors)
    })
    if (matching.length !== voices.length || !matching.map(({ body }) => body).join('').includes(whole)) {
      fail(`${String(obligation.id)} 原声部“${anchor}”必须继承 description 明示的${contract.mode === 'narration' ? '画外旁白 narration' : '传唱/吟唱 chant 或 singing'}${contract.actors ? `及原发声主体 ${contract.actors.join('、')}` : ''}；不能用同文本改换音轨、演员或普通对白，跨段只执行本段已分配的原音频片段`)
    }
  }
}

/** A duration-v2 vocalization is a scripted audio channel, not observed-media
 * evidence. Only an original nonlexical obligation can use it instead of the
 * dialogue transcript; quoted or explicitly lexical material never can. */
function scriptedVocalizationCovers(shot: Value, scene: Value, obligation: Value, anchor: string): boolean {
  const optionalRecord = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
  const useful = (value: unknown) => typeof value === 'string' && !!value.trim() && !/^(?:none|unknown|n\/a|无|未知|待定)$/i.test(value.trim())
  const pacing = optionalRecord(shot.pacing)
  if (pacing.version !== 'duration-v2' || !Array.isArray(pacing.beats)) return false
  // This intentionally recognizes vocal actions conservatively. Ambiguous
  // singing/lyrics remain on the lexical path, even when labelled vocalization.
  if (/[：:'"“”‘’「」『』]|台词|对白|歌词|原文|全文|逐字|唱出|说出|念出|歌谣/.test(anchor)) return false
  const categories = [
    { action: /(?:哼唱|哼鸣|哼声)$/, type: /hum|哼/i, melodic: true },
    { action: /(?:笑声|轻笑|大笑|窃笑)$/, type: /laugh|chuckle|笑/i, melodic: false },
    { action: /(?:叹息|叹气|叹息声)$/, type: /sigh|叹/i, melodic: false },
    { action: /(?:抽泣|啜泣|哭声)$/, type: /sob|cry|泣|哭/i, melodic: false },
    { action: /(?:呻吟|呻吟声)$/, type: /groan|moan|呻吟/i, melodic: false },
    { action: /(?:喘息|喘气|喘息声|呼吸声)$/, type: /breath|pant|gasp|喘|呼吸/i, melodic: false },
  ]
  const normalized = audioText(anchor), category = categories.find(item => item.action.test(normalized))
  if (!category || normalized.length > 40) return false
  const observable = optionalRecord(obligation.observable)
  const originalAudio = Array.isArray(observable.audio) ? observable.audio.filter((value): value is string => typeof value === 'string') : []
  const sourceTexts = [...originalAudio, String(obligation.description ?? '')]
  if (!sourceTexts.some(source => audioText(source).includes(normalized))) return false
  // Do not classify a line quoted by the original obligation as a vocal action.
  const quotedSource = sourceTexts.flatMap(source => [...source.matchAll(/["“‘「『']([^"”’」』']+)["”’」』']/g)].map(match => audioText(match[1])))
  if (quotedSource.some(quote => quote.includes(normalized))) return false
  const actors = new Set([...(Array.isArray(scene.cast) ? scene.cast : []), ...(Array.isArray(shot.presentCharacters) ? shot.presentCharacters : [])])
  for (const group of Array.isArray(pacing.actorGroups) ? pacing.actorGroups : []) {
    const row = optionalRecord(group)
    if (useful(row.id) && useful(row.label) && useful(row.memberDescription)) actors.add(row.id)
  }
  return pacing.beats.some(value => {
    const beat = optionalRecord(value), completion = optionalRecord(beat.completion), voice = optionalRecord(beat.vocalization), estimate = optionalRecord(beat.durationEstimate)
    if (beat.kind !== 'vocalization' || beat.sourceBeatId !== obligation.id || !useful(beat.id) || !useful(beat.textOrVocalization)) return false
    if (!Array.isArray(beat.actorIds) || !beat.actorIds.length || beat.actorIds.some(id => !actors.has(id)) || !beat.actorIds.includes(voice.actorGroup)) return false
    const melodyRelation = String(voice.melodyRelation ?? '').trim()
    if (!category.type.test(String(voice.vocalizationType ?? '')) || !useful(voice.completionCue)
      || (category.melodic ? !useful(melodyRelation) : !melodyRelation)) return false
    const audibility = String(voice.expectedAudibility ?? '')
    const completionCue = String(voice.completionCue ?? '')
    const audibleLevel = /audible|可听|听见|清晰/i.test(audibility)
      || (/^(?:background|foreground|背景|前景)$/i.test(audibility) && /audible|可听|听见|清晰/i.test(completionCue))
    if (!audibleLevel || /inaudible|silent|mute|不可听|无声/i.test(`${audibility} ${completionCue}`)) return false
    if (/跟着|跟随|同调/.test(anchor) && !/same|follow|同|跟随/i.test(String(voice.melodyRelation))) return false
    if (![estimate.lower, estimate.expected, estimate.upper].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
      || Number(estimate.lower) > Number(estimate.expected) || Number(estimate.expected) > Number(estimate.upper)
      || !useful(estimate.source) || !['low', 'medium', 'high'].includes(String(estimate.confidence))) return false
    return completion.requiredThisClip === true && ['audio', 'audio-visual'].includes(String(completion.modality))
      && useful(completion.finalState) && audioText(completion.evidenceAnchor).includes(normalized)
  })
}
/** A declared anchor is evidence that the beat was enacted, not a string the prose has to repeat
 * byte for byte. A writer who inserts a modifier inside the phrase (“尚书台木质梁柱可见” →
 * “身后尚书台木质梁柱清晰可见”) really did film the obligation, yet the contiguous-substring rule
 * rejected it and every repair rephrased it the same way, so scene-01 burned all three storyboard
 * attempts on record-ap4bsu. In-order matching inside a bounded window still refuses anchors that
 * only exist in the declaration, in quoted speech, in a negation or in an appended note, because
 * enactedVisual has already removed those channels before this runs. */
function scriptedVisualActionCovers(shot: Value, scene: Value, obligation: Value, anchor: string): boolean | undefined {
  const pacing = shot.pacing as Value | undefined
  if (pacing?.version !== 'duration-v2' || !Array.isArray(pacing.beats)
    || !Array.isArray(obligation.mustShow) || !obligation.mustShow.every(anchor => typeof anchor === 'string')) return undefined
  const groupPerformance = scriptedGroupPerformanceCovers(anchor, pacing.beats.filter(value => value && typeof value === 'object'
    && value.sourceBeatId === obligation.id && value.completion?.requiredThisClip === true), pacing.actorGroups)
  if (groupPerformance !== undefined) return groupPerformance
  const observable = obligation.observable as Value
  const sourceTexts = [...strings(observable.visual, 'observable.visual', true), String(obligation.description ?? '')]
  const setting = typeof obligation.setting === 'string' ? obligation.setting : undefined
  const contract = sourceVisualActions([anchor], scene.cast, sourceTexts, setting)[0]
  const approved = sourceVisualActions(strings(obligation.mustShow, 'mustShow', true), scene.cast, sourceTexts, setting)
  // Only the approved visual spelling of the same original mustShow action
  // shares this proof. Another visual predicate/prop obligation stays separate.
  if (!contract || !approved.some(action => action.predicate === contract.predicate
    && contract.adjuncts.some(adjunct => action.adjuncts.includes(adjunct)))) return undefined
  const beats = pacing.beats.filter((value): value is Value => !!value && typeof value === 'object' && !Array.isArray(value))
    .filter(beat => beat.sourceBeatId === obligation.id && (beat.completion as Value | undefined)?.requiredThisClip === true
      && Array.isArray(beat.actorIds) && beat.actorIds.every(actor => typeof actor === 'string') && typeof beat.textOrVocalization === 'string')
    .map(beat => ({ kind: String(beat.kind), actorIds: beat.actorIds as string[], textOrVocalization: beat.textOrVocalization as string,
      ...(typeof beat.performanceInstruction === 'string' ? { performanceInstruction: beat.performanceInstruction } : {}) }))
  return executableVisualAction(contract, beats)
}

function enactsAnchor(actual: string, anchor: string) {
  if (!anchor) return true
  if (actual.includes(anchor)) return true
  const window = anchor.length * 3 + 30
  for (let start = 0; start + anchor.length <= actual.length; start += 1) {
    let cursor = 0
    for (const char of actual.slice(start, start + window)) if (char === anchor[cursor]) cursor += 1
    if (cursor === anchor.length) return true
  }
  return false
}

function regexpLiteral(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Chinese location phrases commonly alternate between "坐在空地" and
 * "在治所外空地上坐下". Keep this a small positive grammar instead of fuzzy
 * similarity: the same place token and a matching completed posture verb must
 * occur in one already-filtered enacted clause. */
function enactsLocativePosture(actual: string, anchor: string) {
  const match = anchor.match(/^(坐|站|跪|躺)在(.+?)(?:上|中|内)?$/)
  if (!match || match[2].length < 2) return false
  const completed: Record<string, string> = { 坐: '坐(?:下|着)?', 站: '站(?:立|定|着)?', 跪: '跪(?:下|着)?', 躺: '躺(?:下|卧|着)?' }
  return new RegExp(`在[^\n]{0,24}${regexpLiteral(match[2])}(?:上|中|内)?[^\n]{0,12}${completed[match[1]]}`).test(actual)
}

/** Approved crowd actions often use the indefinite subject "有人", while the
 * executable prompt naturally renders the same visible subgroup as "有的…".
 * Accept only that explicit subject alternation and keep the predicate in one
 * positive enacted clause; this does not introduce general synonym matching. */
function enactsIndefiniteActorAction(actual: string, anchor: string) {
  const match = anchor.match(/^有人(.{2,16})$/)
  if (!match) return false
  const predicate = regexpLiteral(match[1])
  return new RegExp(`(?:有人|有的(?:人)?)\\S{0,8}${predicate}`).test(actual)
}

/** Static-tableau prompts may place the medium before the location ("定格历史
 * 场景画面呈现洛阳城外…") while the approved anchor places it after the
 * location ("洛阳城外…定格画面"). For this one production grammar, require
 * every concrete comma-delimited subject/action fragment and the same frozen
 * tableau medium; do not introduce general fuzzy matching. */
function enactsStaticTableau(actual: string, anchor: string) {
  const frozenMedium = /(?:定格(?:历史场景)?(?:插?画(?:面)?)|(?:插?画(?:面)?).{0,6}定格)/
  if (!frozenMedium.test(actual) || !frozenMedium.test(anchor)) return false
  const concrete = String(anchor).split(/[、，,；;]/).map(part => coverageText(part)
    .replace(/历史场景|定格|画面|呈现|展示|整体|缓慢|推进/g, '')).filter(part => part.length >= 2)
  const coversFigureAttribute = (part: string) => {
    // Models commonly move a frozen figure's attribute behind the head noun:
    // “张角手持符水的人物形象” -> “张角人物形象手持符水”.  This is the
    // same positive tableau content, not a synonym or inferred action.  Keep
    // the grammar deliberately narrow: the same named figure, the literal
    // 手持 predicate and the same object must remain in one enacted image.
    const match = part.match(/^(?:至)?(.{1,12})手持(.{1,16})的人物形象$/)
    if (!match) return false
    const [, name, object] = match
    return new RegExp(`${regexpLiteral(name)}(?:的)?人物形象[^。；;\\n]{0,24}手持${regexpLiteral(object)}`).test(actual)
  }
  return concrete.length > 0 && concrete.every(part => enactsAnchor(actual, part) || coversFigureAttribute(part))
}

function enactedVisual(value: unknown) {
  // Quoted speech, prohibitions and appended reminders are not enacted images.
  // This is an evidence-channel check, not a dramatic-quality keyword score.
  return coverageText(String(value ?? '').split(/【(?!\s*(?:第\s*)?\d)|(?:备注|说明|约束)[：:]/)[0]
    .replace(/[「“"『][^」”"』]*[」”"』]/g, '')
    .split(/[，,。；;\n]/).filter(clause => !/(?:禁止|不得|避免|不能|不要|没有|尚未|未曾|未发生|并未|准备|打算|即将|计划|想象|回忆|目送|看见|看到|注视|凝视|看着|望着|目睹|观望|提到|谈及|要求|命令)/.test(clause)).join('\n'))
}

/** Share the drama gate's bounded, positive visual proof with the duration
 * compiler. This deliberately accepts harmless inserted detail (for example
 * "扶着病人" -> "扶着病弱家人") while keeping declarations, quoted text,
 * negation and planning language outside the evidence channel. */
export function enactedVisualTextCovers(value: unknown, anchor: string) {
  const actual = enactedVisual(value), expected = coverageText(anchor)
  return enactsAnchor(actual, expected) || enactsLocativePosture(actual, expected)
    || enactsIndefiniteActorAction(actual, expected) || enactsStaticTableau(actual, expected)
}

/** Verify the complete allocation before projecting an obligation into one
 * generated segment. A repeated complex beat may divide its anchors, but may
 * never duplicate or drop approved dialogue/action across segments. */
export function validateDramaStoryboardAllocation(segments: unknown[], sceneValue: unknown): void {
  const scene = record(sceneValue, 'scene')
  if (!scene.dramaticSceneId && scene.contentContractVersion === undefined) return
  const obligations = namedRecords(scene.requiredBeats, 'id', 'scene.requiredBeats')
  const all = segments.flatMap((segment, index) => namedRecords(record(segment, `segments[${index}]`).beatDramaturgy, 'beatId', `segments[${index}].beatDramaturgy`))
  for (const item of all) if (!obligations.some(beat => beat.id === item.beatId)) fail(`beatDramaturgy 分配了未知节拍 ${String(item.beatId)}`)
  for (const obligation of obligations) {
    const allocated = all.filter(item => item.beatId === obligation.id)
    if (!allocated.length) fail(`拆段丢失节拍 ${String(obligation.id)}`)
    const observable = record(obligation.observable, `requiredBeats.${String(obligation.id)}.observable`)
    for (const anchor of strings(observable.visual, 'observable.visual', true)) {
      const count = allocated.reduce((total, beat) => total + strings(beat.visual, 'beatDramaturgy.visual', true)
        .filter(value => coverageText(value).includes(coverageText(anchor))).length, 0)
      if (count !== 1) fail(`拆段 ${String(obligation.id)}.visual 义务“${anchor}”必须恰好分配一次，实际 ${count} 次`)
    }
    const expectedAudio = strings(observable.audio, 'observable.audio', true)
    const allocatedAudio = allocated.flatMap(beat => strings(beat.audio, 'beatDramaturgy.audio', true))
    for (const value of allocatedAudio) if (!expectedAudio.some(anchor => {
      const { whole, part } = audioFragment(value, anchor)
      return whole && part && whole.includes(part)
    })) fail(`拆段 ${String(obligation.id)}.audio 出现未批准、重复或换说话人的音频片段`)
    for (const anchor of expectedAudio) {
      const pieces = allocatedAudio.map(value => audioFragment(value, anchor))
        .filter(({ whole, part }) => whole && part && whole.includes(part))
      const whole = audioFragment(anchor, anchor).whole
      const joined = pieces.map(piece => piece.part).join('')
      if (!whole || joined !== whole) fail(`拆段 ${String(obligation.id)}.audio 义务“${anchor}”必须按顺序逐字完整覆盖一次；存在遗漏、重复、换说话人或乱序`)
    }
  }
}

/** Only call after validateDramaStoryboardAllocation has passed for the whole
 * candidate. The projection cannot itself prove complete scene coverage. */
export function partitionDramaBeat(beatValue: unknown, segmentValue: unknown): Value {
  const beat = record(beatValue, 'beat')
  const segment = record(segmentValue, 'segment')
  if (!beat.observable) return beat
  const implemented = list(segment.beatDramaturgy, 'segment.beatDramaturgy')
    .map(item => record(item, 'beatDramaturgy')).find(item => item.beatId === beat.id)
  if (!implemented) fail(`分段缺少 ${String(beat.id)} 的叙事继承`)
  const observable = record(beat.observable, 'beat.observable')
  const partition: Value = {}
  for (const channel of ['visual', 'audio']) {
    const actual = strings(implemented[channel], `beatDramaturgy.${channel}`, true)
    partition[channel] = [...new Set(strings(observable[channel], `observable.${channel}`, true).flatMap(anchor => {
      if (channel === 'visual') return actual.some(value => coverageText(value).includes(coverageText(anchor))) ? [anchor] : []
      return actual.flatMap(value => {
        const { whole, part } = audioFragment(value, anchor)
        if (!whole || !part) return []
        if (part === whole) return [anchor]
        return whole.includes(part) ? [value] : []
      })
    }))]
  }
  if (!(partition.visual as unknown[]).length && !(partition.audio as unknown[]).length) fail(`分段 ${String(beat.id)} 未承担任何批准的声画义务`)
  return { ...beat, observable: partition }
}

/** A complete beat keeps its approved performance description. A partial
 * beat describes only its allocated original actions and voices, including
 * visual obligations that are not duplicated in mustShow. Sharing this
 * projection keeps child retries and expanded-outline validation aligned. */
export function projectedDramaBeatDescription(source: Value, partitioned: Value, anchors: string[], scene: Value) {
  const sourceObservable = source.observable && typeof source.observable === 'object' && !Array.isArray(source.observable)
    ? source.observable as Value : {}
  const projectedObservable = partitioned.observable && typeof partitioned.observable === 'object' && !Array.isArray(partitioned.observable)
    ? partitioned.observable as Value : {}
  const values = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
  const visual = values(projectedObservable.visual), audio = values(projectedObservable.audio)
  const complete = same(anchors, values(source.mustShow))
    && same(visual, values(sourceObservable.visual)) && same(audio, values(sourceObservable.audio))
  if (complete) return source.description
  // The approved description can carry the singer/narrator contract while
  // audio contains only the words. Persist that contract for each allocated
  // fragment without restoring the unallocated lyric or visual action.
  const audioPerformance = audio.map(fragment => {
    const original = values(sourceObservable.audio).find(anchor => {
      const { whole, part } = audioFragment(fragment, anchor)
      return whole && part && whole.includes(part)
    })
    const contract = original && sourceVoiceContract(source, scene, original)
    if (!contract) return fragment
    // Existing audio comparison ignores these quote marks. Strip them only
    // inside the derived prose quote so nested punctuation cannot terminate
    // its sourceVoiceContract early; approved audio and execution stay intact.
    const quoteBody = fragment.replace(/["“”‘’']/g, '')
    return contract.mode === 'narration' ? `画外旁白朗读“${quoteBody}”`
      : `${contract.actors?.join('、') ?? ''}吟唱“${quoteBody}”`
  })
  const allocated = [...new Set([...anchors, ...visual, ...audioPerformance])]
  return allocated.length ? allocated.join('；') : source.description
}

/** Runtime expansion is checked against an independently saved approved
 * outline. A writer cannot opt into duplicate IDs by claiming runtime metadata.
 * The original outline remains the authority for episode review and state. */
export function validateExpandedDramaOutline(expandedValue: unknown, approvedValue: unknown, shotValues: unknown[]): Value {
  const approved = validateDramaOutline(approvedValue, { requireDramaContract: true })
  const expanded = normalizeDramaOutline(expandedValue, { requireDramaContract: true })
  for (const key of ['episodeTitle', 'episodeDrama', 'historicalLocks', 'adaptationSpace', 'characterDramas', 'dramaticScenes']) {
    if (!same(expanded[key], approved[key])) fail(`运行时拆段不得改写已批准 ${key}`)
  }
  const sourceScenes = namedRecords(approved.scenes, 'id', 'approved.scenes')
  const scenes = namedRecords(expanded.scenes, 'id', 'expanded.scenes')
  const shots = namedRecords(shotValues, 'id', 'shots')
  if (shots.length !== scenes.length || shots.some((shot, index) => scenes[index].id !== shot.id)) fail('实际分镜必须与展开拍摄段按时间线顺序逐一对应')
  const sourceIds = new Set(sourceScenes.map(scene => String(scene.id)))
  const sourceOrder: string[] = []
  scenes.forEach((scene, index) => {
    const sourceId = String(scene.sourceSceneId ?? scene.id)
    if (!sourceIds.has(sourceId)) fail(`展开段 ${String(scene.id)} 缺少有效的已批准 sourceSceneId`)
    if (Number(scene.sequence) !== index + 1) fail('展开拍摄段 sequence 必须连续递增')
    if (sourceOrder.at(-1) !== sourceId) sourceOrder.push(sourceId)
    const source = sourceScenes.find(item => item.id === sourceId)!
    if (scene.dramaticSceneId !== source.dramaticSceneId) fail('运行时拆段不能改变完整戏归属')
    const shot = shots.find(item => item.id === scene.id)!
    if (Number(scene.targetDuration) !== Number(shot.duration)) fail(`展开段 ${String(scene.id)} 时长必须对应实际分镜预算`)
  })
  if (!same(sourceOrder, sourceScenes.map(scene => scene.id))) fail('运行时拆段不得丢失、重排或穿插原拍摄段')
  for (const source of sourceScenes) {
    const parts = scenes.filter(scene => (scene.sourceSceneId ?? scene.id) === source.id)
    const scripts = parts.map(scene => shots.find(shot => shot.id === scene.id)!)
    validateDramaStoryboardAllocation(scripts, source)
    const required = namedRecords(source.requiredBeats, 'id', 'source.requiredBeats')
    const beatOrder: string[] = []
    for (const [index, part] of parts.entries()) {
      const shot = scripts[index]
      const partBeats = namedRecords(part.requiredBeats, 'id', 'expanded.requiredBeats')
      for (const beat of partBeats) {
        const sourceBeat = required.find(original => original.id === beat.id)
        if (!sourceBeat) fail('展开拍摄段新增了未批准节拍')
        if (beatOrder.at(-1) !== beat.id) beatOrder.push(String(beat.id))
        const partitioned = partitionDramaBeat(sourceBeat, shot)
        const projectedAnchors = strings(beat.mustShow, 'expanded.requiredBeats.mustShow', true)
        const projected: Value = {
          ...partitioned,
          description: projectedDramaBeatDescription(sourceBeat, partitioned, projectedAnchors, source),
        }
        for (const key of ['description', 'function', 'stateChange', 'setting', 'observable']) {
          if (!same(beat[key], projected[key])) fail(`${String(beat.id)} 拆段丢失或改写已批准 ${key}`)
        }
        const anchors = projectedAnchors
        if (anchors.some(anchor => !(sourceBeat.mustShow as string[]).includes(anchor))) fail('拆段引入未批准的动作锚点')
      }
      validateDramaStoryboard(shot, part)
    }
    if (!same(beatOrder, required.map(beat => beat.id))) fail('拆段改变节拍顺序或重复已完成节拍')
    for (const beat of required) for (const anchor of beat.mustShow as string[]) {
      const count = parts.flatMap(part => part.requiredBeats as Value[]).filter(part => part.id === beat.id)
        .reduce((total, part) => total + (part.mustShow as string[]).filter(item => item === anchor).length, 0)
      if (count !== 1) fail(`${String(beat.id)} 拆段动作锚点“${anchor}”必须恰好覆盖一次，实际 ${count} 次`)
    }
  }
  if (Number(expanded.count) !== scenes.length || Number(expanded.totalDuration) !== shots.reduce((sum, shot) => sum + Number(shot.duration), 0)) fail('展开大纲统计必须对应实际拍摄段与分镜时长')
  return expanded
}

/** Beat IDs alone cannot prove execution: each approved visual/audio anchor
 * must be allocated to the same beat and appear in the actual script channel. */
export function validateDramaStoryboard(output: unknown, sceneValue: unknown): Value {
  const shot = normalizeSandTableAesthetic(record(output, 'shot'))
  const scene = normalizeSandTableAesthetic(record(sceneValue, 'scene'))
  if (!scene.dramaticSceneId && scene.contentContractVersion === undefined && shot.contentContractVersion === undefined) return shot
  if (scene.contentContractVersion !== undefined && scene.contentContractVersion !== HISTORY_DRAMA_VERSION) fail('scene 内容契约版本不受支持')
  if (shot.contentContractVersion !== HISTORY_DRAMA_VERSION) fail('分镜缺少 cinematic-v1 内容契约')
  if (shot.dramaticSceneId !== scene.dramaticSceneId) fail('分镜 dramaticSceneId 必须继承当前完整戏')
  if (scene.editorialRole !== undefined && shot.editorialRole !== scene.editorialRole) fail('分镜 editorialRole 必须原样继承当前场景')
  if (scene.visualTreatment !== undefined && shot.visualTreatment !== scene.visualTreatment) fail('分镜 visualTreatment 必须原样继承当前场景')
  if (scene.visualTreatment === 'animated') {
    if (shot.animationStyle !== scene.animationStyle) fail('分镜 animationStyle 必须原样继承当前场景')
    if (shot.animationAesthetic !== scene.animationAesthetic) fail('分镜 animationAesthetic 必须原样继承当前场景')
  }
  const staticIllustration = isStaticIllustrationStyle(scene.visualTreatment, scene.animationStyle)
  if (staticIllustration) {
    if (shot.audioType !== '旁白') fail('静态人物/历史插画只能使用画外旁白，不得承载人物对白或口型表演')
    const camera = String(shot.camera ?? '')
    if (!camera.startsWith('固定机位') && !camera.includes('无实拍机位')) fail('静态人物/历史插画 camera 必须说明“固定机位”或“无实拍机位”；二维整幅画或人物图层运动写在其后')
    if (!String(shot.visualPrompt ?? '').trim() || !String(shot.lastFramePrompt ?? '').trim()) fail('二维插画必须说明背景底板以及人物图层编排后的末帧构图')
    const videoPrompt = String(shot.videoPrompt ?? '')
    // Do not split a decimal timestamp at its fractional digit (for example,
    // `0.0-8.0秒` used to become the bogus windows `0.` and `0-8.0秒...`).
    // Slice only at complete timeline headers so the static-cue check applies
    // to real windows rather than numeric fragments.
    const markers = [...videoPrompt.matchAll(/(?<![\d.])\d+(?:\.\d+)?\s*(?:秒\s*)?[-–—~～至到]\s*\d+(?:\.\d+)?\s*秒\s*[:：]/g)]
    const windows = markers.map((marker, index) => videoPrompt.slice(marker.index!, markers[index + 1]?.index ?? videoPrompt.length))
    const characterIllustration = resolvedAnimationStyle(scene.visualTreatment, scene.animationStyle) === 'character_illustration'
    if (!windows.length) fail('二维插画 videoPrompt 必须提供完整时间段')
    // The renderer already locks character/tableau pixels from animationStyle;
    // repeating the same static sentence in every interval is presentation
    // wording, not an independent quality guarantee. Keep the real safety gate:
    // explicit intrinsic human motion remains forbidden.
    const intrinsicMotion = /(人物|画中人物|饥民|病者|流民|士兵|官吏|百姓).{0,12}(走动|行走|跑|转身|开口|说话|眨眼|抬手|挥手|起身|坐下)/
    if (windows.some(window => intrinsicMotion.test(window))) fail('二维插画只能编排整个人物图层，不得生成人物走路、口型、表情或肢体动作')
    if (characterIllustration) {
      const characters = strings(shot.characters, 'shot.characters')
      const backgroundPrompt = String(shot.visualPrompt ?? '')
      const bakedCharacters = characters.filter(name => backgroundPrompt.includes(name))
      if (bakedCharacters.length) fail('character_illustration 的 visualPrompt 只能描述不含具名人物的历史背景底板；人物 ' + bakedCharacters.join('、') + ' 必须只通过 illustrationLayers 编排，不能烘焙进背景')
      const layers = list(shot.illustrationLayers, 'shot.illustrationLayers') as Value[]
      if (layers.length !== characters.length) fail('character_illustration 必须为每个 characters 人物提供且仅提供一个 illustrationLayers 编排')
      const names = layers.map((layer, index) => text(record(layer, `shot.illustrationLayers[${index}]`).characterName, `shot.illustrationLayers[${index}].characterName`))
      if (!same([...names].sort(), [...characters].sort())) fail('illustrationLayers.characterName 必须与 characters 一一对应，不能遗漏、重复或绑定其他人物')
      layers.forEach((item, index) => {
        const layer = record(item, `shot.illustrationLayers[${index}]`)
        const number = (key: string, min: number, max: number) => {
          const value = Number(layer[key])
          if (!Number.isFinite(value) || value < min || value > max) fail(`shot.illustrationLayers[${index}].${key} 必须在 ${min}–${max} 范围内`)
          return value
        }
        number('x', 0, 1); number('y', 0, 1); number('scale', .1, .46)
        number('enterFromX', 0, 1); number('enterFromY', 0, 1)
        const enterStart = number('enterStart', 0, Number(shot.duration))
        const enterDuration = number('enterDuration', .2, 1.5)
        const exitStart = number('exitStart', 0, Number(shot.duration))
        const exitDuration = number('exitDuration', .2, 1.5)
        if (enterStart + enterDuration > exitStart || exitStart + exitDuration > Number(shot.duration) + .001) fail(
          `shot.illustrationLayers[${index}] 的淡入、停留、淡出时间必须顺序完整且不超过 duration`,
        )
      })
    }
  }
  const mapPortraitLayers = isHistoricalSandTable(scene) && Array.isArray(shot.illustrationLayers)
    ? shot.illustrationLayers as unknown[] : []
  if (isHistoricalSandTable(scene) && !mapPortraitLayers.length
    && (Array.isArray(scene.cast) && scene.cast.length > 0 || Array.isArray(shot.characters) && shot.characters.length > 0)) {
    fail('历史地理地图已声明具名人物时必须用 illustrationLayers 叠加静态肖像，不能把人物烘焙进地图底片')
  }
  if (mapPortraitLayers.length) {
    if (shot.audioType !== '旁白') fail('历史地理地图上的静态人物肖像只能配画外旁白，不承载人物对白或口型')
    const characters = strings(shot.characters, 'shot.characters')
    const cast = strings(scene.cast, 'scene.cast')
    const layerNames = mapPortraitLayers.map((item, index) => text(record(item, `shot.illustrationLayers[${index}]`).characterName,
      `shot.illustrationLayers[${index}].characterName`))
    if (!same([...layerNames].sort(), [...characters].sort()) || !same([...cast].sort(), [...characters].sort())) {
      fail('历史地理地图肖像图层必须与本镜 characters 和已批准 scene.cast 一一对应，不能新增或遗漏人物')
    }
    if (!Array.isArray(shot.initialCharacters) || shot.initialCharacters.length
      || !Array.isArray(shot.enteringCharacters) || shot.enteringCharacters.length) {
      fail('历史地理地图肖像须由 illustrationLayers 叠加，不得作为地图底片人物或真人入场')
    }
    const pictureWords = /(?:肖像|画像|人像|人物卡片|人物图层|人物静态图)/
    const bakedInPicture = [shot.visualPrompt, shot.lastFramePrompt]
      .some(value => characters.some(name => String(value ?? '').includes(name)) || pictureWords.test(String(value ?? '')))
      || pictureWords.test(String(shot.videoPrompt ?? ''))
    if (bakedInPicture) fail('历史地理地图的首尾底片和视频提示只写地图；人物肖像姓名与动作仅写 illustrationLayers，由后期叠加')
    mapPortraitLayers.forEach((item, index) => {
      const layer = record(item, `shot.illustrationLayers[${index}]`)
      const number = (key: string, min: number, max: number) => {
        const value = Number(layer[key])
        if (!Number.isFinite(value) || value < min || value > max) fail(`shot.illustrationLayers[${index}].${key} 必须在 ${min}–${max} 范围内`)
        return value
      }
      number('x', 0, 1); number('y', 0, 1); number('scale', .1, .46)
      number('enterFromX', 0, 1); number('enterFromY', 0, 1)
      const enterStart = number('enterStart', 0, Number(shot.duration))
      const enterDuration = number('enterDuration', .2, 1.5)
      const exitStart = number('exitStart', 0, Number(shot.duration))
      const exitDuration = number('exitDuration', .2, 1.5)
      if (enterStart + enterDuration > exitStart || exitStart + exitDuration > Number(shot.duration) + .001) fail(
        `shot.illustrationLayers[${index}] 的淡入、停留、淡出时间必须顺序完整且不超过 duration`,
      )
    })
  }
  if (isHistoricalSandTable(scene)) validateStoryboardMapAnnotations(shot.mapAnnotations, scene, Number(shot.duration))
  else if (shot.mapAnnotations !== undefined) fail('mapAnnotations 只能用于已批准的 historical_map 信息镜头')
  const animated = isAnimatedVisualTreatment(scene.visualTreatment)
  const actorlessAnimation = animated && (!Array.isArray(scene.cast) || scene.cast.length === 0)
  const actorlessLiveAction = !animated && Array.isArray(scene.cast) && scene.cast.length === 0
  const intent = record(shot.shotIntent, 'shot.shotIntent')
  const viewpoint = text(intent.viewpointCharacter, 'shot.shotIntent.viewpointCharacter')
  const allowedCast = [...(Array.isArray(scene.cast) ? scene.cast : []), ...(Array.isArray(shot.presentCharacters) ? shot.presentCharacters : [])]
  if (actorlessAnimation || actorlessLiveAction ? viewpoint !== '观众' : animated ? viewpoint !== '观众' && !allowedCast.includes(viewpoint) : !allowedCast.includes(viewpoint)) fail(actorlessAnimation
    ? '无人动画镜头 shotIntent.viewpointCharacter 必须为“观众”' : animated
      ? '人物动画镜头 shotIntent.viewpointCharacter 必须是“观众”或当前戏人物' : actorlessLiveAction
        ? '匿名真人群演镜头 shotIntent.viewpointCharacter 必须为“观众”' : 'shotIntent.viewpointCharacter 必须是当前戏人物')
  text(intent.purpose, 'shot.shotIntent.purpose')
  text(intent.cameraReason, 'shot.shotIntent.cameraReason')
  const obligations = namedRecords(scene.requiredBeats, 'id', 'scene.requiredBeats')
  const implemented = namedRecords(shot.beatDramaturgy, 'beatId', 'shot.beatDramaturgy')
  if (!same(implemented.map(beat => beat.beatId), obligations.map(beat => beat.id))) fail('beatDramaturgy 必须按顺序继承当前短段的全部节拍')
  const actualVisual = [enactedVisual(shot.visualPrompt), enactedVisual(shot.videoPrompt)].join('')
  const actualAudio = audioText(shot.audioText)
  for (const [index, beat] of implemented.entries()) {
    const obligation = obligations[index]
    for (const key of ['function', 'stateChange']) if (beat[key] !== obligation[key]) fail(`${String(beat.beatId)}.${key} 必须原样继承大纲，不得静默改写叙事义务`)
    const observable = record(obligation.observable, `requiredBeats.${String(beat.beatId)}.observable`)
    for (const channel of ['visual', 'audio']) {
      const anchors = strings(beat[channel], `beatDramaturgy.${String(beat.beatId)}.${channel}`, true)
      const required = strings(observable[channel], `requiredBeats.${String(beat.beatId)}.${channel}`, true)
      const normalize = channel === 'visual' ? coverageText : audioText
      const uncovered = required.filter(need => !anchors.some(declared => normalize(declared).includes(normalize(need))))
      if (uncovered.length) fail(`${String(beat.beatId)} 遗漏 ${channel} 声画义务：${uncovered.map(need => `“${need}”`).join('、')} 必须原样包含在 beatDramaturgy.${channel} 某一条里，只能在前后补充细节`)
      const actual = channel === 'visual' ? actualVisual : actualAudio
      const unenacted = anchors.filter(anchor => {
        const performed = channel === 'visual' ? scriptedVisualActionCovers(shot, scene, obligation, anchor) : scriptedGroupAudioCovers(anchor, shot, obligation.id)
        return performed === undefined ? channel === 'visual' ? !enactedVisualTextCovers(actual, anchor) : !enactsAnchor(actual, normalize(anchor))
          && !(channel === 'audio' && scriptedVocalizationCovers(shot, scene, obligation, anchor)) : !performed
      })
      if (unenacted.length) fail(`${String(beat.beatId)}.${channel} 仅声明完成，却未落在实际${channel === 'visual' ? '画面动作' : (shot.pacing as Value | undefined)?.version === 'duration-v2' ? '可听对白/旁白或同源且有预算与完成态的无词声部' : '可听对白/旁白'}中：${unenacted.map(anchor => `“${anchor}”`).join('、')}`)
    }
    validateSourceVoicePerformance(shot, scene, obligation)
  }
  return shot
}

/** A writer receives the current drama and people only. Prior states remain
 * labelled script plans; accepted video world-state evidence travels separately. */
export function storyboardDramaContext(context: Value): Value {
  const source = context.scene_outline ?? context.sceneOutline ?? context.outline
  if (!source || typeof source !== 'object') return context
  const outline = source as Value
  if (outline.contentContractVersion === undefined) return context
  if (outline.contentContractVersion !== HISTORY_DRAMA_VERSION) fail('分镜上下文的内容契约版本不受支持')
  const scene = record(context.scene, 'scene')
  const dramas = list(outline.dramaticScenes, 'dramaticScenes') as Value[]
  const index = dramas.findIndex(drama => drama.id === scene.dramaticSceneId)
  if (index < 0) fail('分镜上下文缺少当前完整戏')
  const drama = dramas[index]
  const cast = new Set(drama.characters as string[])
  const people = (outline.characterDramas as Value[]).filter(character => cast.has(String(character.name)))
  const priorStates = new Map(people.map(person => [String(person.name), person.initialState]))
  for (const previous of dramas.slice(0, index)) for (const change of previous.characterStates as Value[]) {
    if (cast.has(String(change.name))) priorStates.set(String(change.name), change.after)
  }
  const loop = context.loop as Value | undefined
  const previous = loop?.previous as Value | undefined
  const previousShot = previous?.shot_script as Value | undefined
  return { ...context, dramaContext: {
    contentContractVersion: HISTORY_DRAMA_VERSION,
    episodeQuestion: (outline.episodeDrama as Value).centralQuestion,
    adaptationSpace: outline.adaptationSpace,
    dramaticScene: drama,
    characterDramas: people,
    plannedPriorCharacterStates: [...priorStates].map(([name, value]) => ({ name, state: value })),
    requiredBeats: scene.requiredBeats,
    remainingBeatIds: (drama.beatIds as string[]).slice((drama.beatIds as string[]).indexOf(String((scene.requiredBeats as Value[])[0]?.id))),
    ...(previousShot && previousShot.dramaticSceneId === drama.id ? { previousScriptBeatDramaturgy: previousShot.beatDramaturgy ?? [] } : {}),
    stateEvidenceScope: 'script-plan-only; actual media world state is supplied separately',
  } }
}
import { scriptedGroupAudioCovers, scriptedGroupPerformanceCovers } from './storyboard-group-semantics.ts'
