import { cinematicShotAllowsEmptyCast, validateCinematicWorldState } from '../src/history-cinema.ts'
import { ANIMATION_AESTHETICS, ANIMATION_STYLES, isAnimatedVisualTreatment, isStaticIllustrationStyle } from '../src/animation-shot.ts'
import { HISTORY_PACING_VERSION } from '../src/history-pacing.ts'
import { verifyDurationSchedule } from '../src/duration-schedule.ts'
import type { DurationBeat } from '../src/duration-schedule.ts'
import { matchingEntranceActions } from '../src/storyboard-entrance.ts'
import type { StoryboardEntrance } from '../src/storyboard-entrance.ts'
import { normalizePronunciationHints } from '../src/pronunciation-hints.ts'
import { isHistoricalSandTable } from '../src/sand-table-contract.ts'
import { validateHistoricalMapFrameCertificate } from '../src/historical-map-frame-gate.ts'
import { historicalMapFrameShotSha256, verifyHistoricalMapFrameApproval } from './historical-map-frame-approval.ts'
import { historicalMapAnnotationSha256, historicalMapSceneSha256, validateHistoricalMapAnnotations } from './historical-map-annotations.ts'
import { assertHistoricalMapCleanPlatePrompt } from './historical-map-clean-plate.ts'
import { characterVisualContextCompatibility, normalizeCharacterVisualContext } from '../src/character-visual-context.ts'
import { characterEquipmentPrompt, validatedCharacterEquipment } from '../src/character-visual-workflow.ts'
type WorkflowMediaRequest = {
  model: { capability: string }
  prompt?: string
  params?: Record<string, unknown>
  executionContext?: { workflowId?: string; nodeId?: string }
}

/** Reference bindings are a projection of the approved action, not a second
 * clock. Reconcile only a uniquely identified entrance after recomputing every
 * signed schedule field; the source shot and caller's request stay untouched. */
export function prepareWorkflowMediaRequest<T extends WorkflowMediaRequest>(request: T): T {
  const params = request.params
  if (request.model.capability !== 'video' || params?.pacingVersion !== 'duration-v2'
    || !Array.isArray(params.referenceBindings)
    || !params.referenceBindings.some(binding => binding?.role === 'entering')) return request
  const verified = verifyDurationSchedule({ pacing: params.pacing, duration: params.duration, scheduleHash: params.scheduleHash,
    characters: params.characters, presentCharacters: params.presentCharacters, audioType: params.audioType,
    audioText: params.audioText, videoPrompt: params.videoTimeline }, { qualityDisposition: params.qualityDisposition })
  if (typeof params.videoTimeline !== 'string' || !request.prompt?.includes(params.videoTimeline)) {
    throw new Error('STORYBOARD_ENTRANCE_BINDING_INVALID: 实际请求未使用已编译的完整时间轴')
  }
  const fail = (name: string, detail: string): never => {
    throw new Error(`STORYBOARD_ENTRANCE_BINDING_INVALID: ${name || '入场人物'} ${detail}；不得猜测入场动作或绕过已验证排程`)
  }
  const changes: Array<{ characterName: string; beatId: string; declared: { startSecond: number; endSecond: number }; scheduled: { startSecond: number; endSecond: number } }> = []
  const referenceBindings = params.referenceBindings.map(binding => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || binding.role !== 'entering') return binding
    const name = typeof binding.characterName === 'string' ? binding.characterName : ''
    const entry = binding.entrance
    if (!name || !entry || typeof entry !== 'object' || Array.isArray(entry) || entry.name !== name
      || typeof entry.path !== 'string' || !entry.path.trim()
      || typeof entry.startSecond !== 'number' || !Number.isFinite(entry.startSecond)
      || typeof entry.endSecond !== 'number' || !Number.isFinite(entry.endSecond)
      || entry.startSecond < 0 || entry.endSecond <= entry.startSecond
      || !Array.isArray(params.presentCharacters) || !params.presentCharacters.includes(name)) {
      return fail(name, '缺少有效的原人物、入场路径或入场时间声明')
    }
    const matches = matchingEntranceActions(entry, verified.pacing.beats)
    if (matches.length !== 1) return fail(name, `入场路径匹配 ${matches.length} 个已批准动作，必须唯一匹配`)
    const windows = verified.schedule.filter(window => window.beatId === matches[0].id)
    if (windows.length !== 1) return fail(name, '入场动作缺少唯一编译窗口')
    const window = windows[0]
    if (window.endSecond > verified.duration - verified.pacing.timingPolicy.endingReadabilityReserve
      || verified.schedule.some(voice => ['speech', 'vocalization'].includes(voice.kind)
        && voice.actorIds.includes(name) && voice.startSecond < window.endSecond)) {
      return fail(name, '编译入场尚未完成本人已发声，或入场超出可执行时间')
    }
    if (entry.startSecond === window.startSecond && entry.endSecond === window.endSecond) return binding
    const scheduled = { startSecond: window.startSecond, endSecond: window.endSecond }
    changes.push({ characterName: name, beatId: window.beatId,
      declared: { startSecond: entry.startSecond, endSecond: entry.endSecond }, scheduled })
    return { ...binding, entrance: { ...entry, ...scheduled } }
  })
  return changes.length ? { ...request, params: { ...params, referenceBindings,
    referenceBindingProjection: { version: 'duration-v2-entrance-v1', scheduleHash: verified.scheduleHash, changes } } } : request
}

/** Check a new paid historical-map image request even when an old execution
 * snapshot tries to jump straight to the image node without the new DAG gates. */
export function validateHistoricalMapPaidImageRequest(request: WorkflowMediaRequest): void {
  const params = request.params ?? {}
  if (request.model.capability !== 'image' || request.executionContext?.workflowId !== 'wf-sanguo-history-drama'
    || params.animationStyle !== 'historical_map' || params.resumeTaskId) return
  if (!isHistoricalSandTable({ visualTreatment: params.visualTreatment, animationStyle: params.animationStyle,
    editorialRole: params.mapEditorialRole })) {
    throw new Error('HISTORICAL_MAP_ROLE_INVALID: 历史地图仅用于已批准的开场、承接或回收信息镜头')
  }
  if (params.animationAesthetic !== 'historical_cartography') {
    throw new Error('HISTORICAL_MAP_AESTHETIC_REQUIRED: 新历史地图图片只能使用已审古代地理地图底板')
  }
  assertHistoricalMapCleanPlatePrompt(String(request.prompt ?? ''))
  if (request.executionContext.nodeId === 'sanguo-animated-map-first-frame') {
    const duration = Number(params.mapDuration)
    if (!Number.isFinite(duration) || duration < 3 || duration > 15) {
      throw new Error('MAP_ANNOTATIONS_INVALID: 首图付费前缺少本镜有效时长')
    }
    validateHistoricalMapAnnotations(params.mapAnnotations, params.mapAnnotationApproval, duration)
    const approval = params.mapAnnotationApproval as { sceneSha256?: unknown }
    if (!params.mapApprovedScene || approval.sceneSha256 !== historicalMapSceneSha256(params.mapApprovedScene)) {
      throw new Error('MAP_ANNOTATIONS_UNAPPROVED: 当前首图场景与独立标注审核场景不一致')
    }
  } else if (request.executionContext.nodeId === 'sanguo-end-frame') {
    const certificate = verifyHistoricalMapFrameApproval(params.mapFirstGate)
    if (certificate.version !== 'historical-map-first-frame-gate-v1' || certificate.frames.length !== 1
      || certificate.frames[0].sourceUrl !== params.referenceImage
      || !params.mapShot || historicalMapFrameShotSha256(params.mapShot) !== certificate.shotSha256) {
      throw new Error('HISTORICAL_MAP_FIRST_FRAME_GATE_REQUIRED: 当前首图与独立审核凭证不一致，已阻止尾帧付费请求')
    }
  }
}

/** Last line of defence before a paid Sanguo video request leaves the server. */
export function validateWorkflowMediaContract(request: WorkflowMediaRequest) {
  if (request.model.capability === 'video') normalizePronunciationHints(request.params?.pronunciationHints, request.params?.audioText)
  if (request.executionContext?.workflowId !== 'wf-sanguo-history-drama'
    || request.executionContext?.nodeId !== 'sanguo-video'
    || request.model.capability !== 'video') return
  const params = request.params ?? {}
  const missing: string[] = []
  let verifiedDurationV2 = false
  const prompt = typeof request.prompt === 'string' ? request.prompt : ''
  const editorialHeader = prompt.match(/【本镜影视处理】\s*([^/\n]+?)\s*\/\s*([^\n]+)/)
  const visualTreatment = String(params.visualTreatment ?? editorialHeader?.[1] ?? '').trim()
  const editorialRole = String(params.editorialRole ?? editorialHeader?.[2] ?? '').trim()
  const animationStyle = String(params.animationStyle ?? '').trim()
  const animationAesthetic = String(params.animationAesthetic ?? '').trim()
  const staticIllustration = isStaticIllustrationStyle(visualTreatment, animationStyle)
  if ((editorialRole || visualTreatment) && !['episode_opening', 'story', 'context_bridge', 'payoff'].includes(editorialRole)) missing.push('有效的 editorialRole 剪辑角色')
  const emptyEditorialCast = Array.isArray(params.characters) && params.characters.length === 0
    && Array.isArray(params.presentCharacters) && params.presentCharacters.length === 0
    // sourceBeatRequirements belongs to the approved schedule and is verified
    // below. It keeps anonymous live-action performances eligible here without
    // adding fake named portraits just to cross the paid-provider boundary.
    && cinematicShotAllowsEmptyCast(params, { cast: [], visualTreatment, editorialRole, animationStyle })
  const duration = Number(params.duration)
  if (!Number.isInteger(duration) || duration < 3 || duration > 15) missing.push('动态时长 duration 为 3–15 秒整数')
  if (![HISTORY_PACING_VERSION, 'duration-v2'].includes(String(params.pacingVersion))) missing.push('有效的动态时长规划版本 dynamic-v1 或 duration-v2；旧固定15秒分镜须重新规划')
  if (params.pacingVersion === 'duration-v2') {
    try {
      // Legacy animated_map has an implicit historical_map style. Passing an
      // absent style as "" would mask that approved fallback at the paid gate.
      const scheduleScene = staticIllustration
        ? { cast: Array.isArray(params.characters) ? params.characters : [], visualTreatment, editorialRole,
          ...(animationStyle ? { animationStyle } : {}) }
        : emptyEditorialCast ? { cast: [], visualTreatment, editorialRole,
          ...(animationStyle ? { animationStyle } : {}) } : undefined
      verifyDurationSchedule({ pacing: params.pacing, duration: params.duration, scheduleHash: params.scheduleHash,
        characters: params.characters, presentCharacters: params.presentCharacters, audioType: params.audioType,
        audioText: params.audioText, videoPrompt: params.videoTimeline }, { ...(scheduleScene ? { scene: scheduleScene } : {}), qualityDisposition: params.qualityDisposition })
      if (typeof params.videoTimeline !== 'string' || !request.prompt?.includes(params.videoTimeline)) throw Error('实际请求未使用已编译的完整时间轴')
      verifiedDurationV2 = true
    } catch (error) { missing.push('不可篡改的时长排程：' + (error instanceof Error ? error.message : String(error))) }
  }
  if (params.sound !== 'on') missing.push('原生同期声 sound=on')
  // The editorial-film workflow renamed these two sections while preserving
  // their contract semantics. Parse the governed section family instead of
  // coupling the paid-request boundary to one historical display label.
  const scenePrompt = prompt.match(/【场景与开场(?:实景|画面)】([^\n]+)/)?.[1]?.trim() ?? ''
  if (!scenePrompt) missing.push('完整的场景与开场实景提示')
  if (!/【(?:场景真实性|视觉处理)硬约束】/.test(prompt)) missing.push('禁止继承人物资产背景的真实性约束')
  const hasFirstFrame = typeof params.referenceImage === 'string' && params.referenceImage.trim().length > 0
  const hasEndFrame = typeof params.endImage === 'string' && params.endImage.trim().length > 0
  const animatedShot = isAnimatedVisualTreatment(visualTreatment)
  if (visualTreatment === 'animated' && !(ANIMATION_STYLES as readonly string[]).includes(animationStyle)) missing.push('有效的 animationStyle 动画叙事类型')
  if (visualTreatment === 'animated' && !(ANIMATION_AESTHETICS as readonly string[]).includes(animationAesthetic)) missing.push('有效的 animationAesthetic 动画美术风格')
  if (animatedShot && (!hasFirstFrame || (!staticIllustration && !hasEndFrame))) missing.push(staticIllustration
    ? '二维插画背景底板（系统编排不变形人物图层，禁止调用视频模型补肢体运动）'
    : '动画镜头可灵首帧与目标尾帧（禁止退回文生视频）')
  if (animationStyle === 'historical_map'
    && !isHistoricalSandTable({ visualTreatment, animationStyle, editorialRole })) {
    throw new Error('HISTORICAL_MAP_ROLE_INVALID: 历史地图仅用于已批准的开场、承接或回收信息镜头')
  }
  if (isHistoricalSandTable({ visualTreatment, animationStyle, editorialRole })) {
    if (animationAesthetic !== 'historical_cartography') {
      throw new Error('HISTORICAL_MAP_AESTHETIC_REQUIRED: 新历史地图视频只能使用已审古代地理地图底板')
    }
    const signedFrameGate = verifyHistoricalMapFrameApproval(params.mapFrameGate)
    validateHistoricalMapFrameCertificate(params.mapFrameGate, params.referenceImage, params.endImage)
    const certificate = params.mapFrameGate as { frames: Array<{ sourceUrl: string; fingerprint: string }> }
    for (const frame of certificate.frames) {
      const imageUrl = frame.sourceUrl
      if (!/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(imageUrl)) {
        throw new Error('HISTORICAL_MAP_FRAME_GATE_MISMATCH: 地图帧须是本地不可变的已采证图片')
      }
      let bytes: Buffer
      try { bytes = readFileSync(path.join(process.cwd(), 'public', imageUrl)) }
      catch { throw new Error('HISTORICAL_MAP_FRAME_GATE_MISMATCH: 当前地图帧原图无法读取') }
      const actual = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
      if (actual !== frame.fingerprint) throw new Error('HISTORICAL_MAP_FRAME_GATE_MISMATCH: 当前地图帧内容已改变，须重新采证审核')
    }
    const mapShot = params.mapShot && typeof params.mapShot === 'object' && !Array.isArray(params.mapShot)
      ? params.mapShot as Record<string, unknown> : {}
    if (!['visualPrompt', 'lastFramePrompt', 'videoPrompt'].every(key =>
      typeof mapShot[key] === 'string' && String(mapShot[key]).trim())
      || mapShot.animationStyle !== 'historical_map' || mapShot.animationAesthetic !== 'historical_cartography'
      || Number(mapShot.duration) !== duration
      || !mapShot.mapAnnotations || !params.mapAnnotations
      || historicalMapFrameShotSha256(mapShot) !== signedFrameGate.shotSha256
      || historicalMapAnnotationSha256(mapShot.mapAnnotations) !== historicalMapAnnotationSha256(params.mapAnnotations)) {
      throw new Error('HISTORICAL_MAP_SHOT_REQUIRED: 视频付费前须绑定同一已审分镜的完整地图底片描述和标注计划')
    }
    validateHistoricalMapAnnotations(params.mapAnnotations, params.mapAnnotationApproval, duration)
  }
  const referenceImages = Array.isArray(params.referenceImages) ? params.referenceImages.filter(Boolean) : []
  const version = String(params.contentContractVersion ?? '')
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const rows = (value: unknown) => Array.isArray(value) ? value.map(object) : []
  const characterNames = Array.isArray(params.characters) ? params.characters.filter(name => typeof name === 'string' && name.trim()) : []
  // The lookup supplies one archived binding for each explicitly authored
  // gear requirement. Check it at the paid boundary, including saved retries.
  const equipmentValue = params.characterEquipment
  const equipmentDeclared = equipmentValue !== undefined && equipmentValue !== ''
    && equipmentValue !== '${shot_script.characterEquipment}'
  const equipmentBindings = rows(params.equipmentBindings)
  if (equipmentDeclared || equipmentBindings.length) {
    try {
      const allowedNames = [...new Set([...characterNames,
        ...['presentCharacters', 'initialCharacters', 'enteringCharacters'].flatMap(key => Array.isArray(params[key])
          ? (params[key] as unknown[]).filter((name): name is string => typeof name === 'string') : [])])]
      const requirements = validatedCharacterEquipment(equipmentDeclared ? equipmentValue : [], allowedNames, 'shot.characterEquipment') ?? []
      const required = requirements.flatMap(row => (row.equipmentNames as string[]).map(name => ({ characterName: row.name, name })))
      const seen = new Set<string>()
      for (const binding of equipmentBindings) {
        const key = `${String(binding.characterName)}\u0000${String(binding.matchedName)}`
        if (typeof binding.id !== 'string' || !binding.id.trim()
          || typeof binding.characterName !== 'string' || typeof binding.name !== 'string' || !binding.name.trim()
          || typeof binding.kind !== 'string' || !binding.kind.trim()
          || typeof binding.matchedName !== 'string' || !binding.matchedName.trim()
          || binding.requirementSource !== 'shot_script.characterEquipment'
          || !required.some(row => row.characterName === binding.characterName && row.name === binding.matchedName)
          || seen.has(key)) missing.push('本镜装备绑定必须唯一对应同人物已归档装备与原需求')
        seen.add(key)
      }
      if (required.length !== equipmentBindings.length
        || required.some(row => !equipmentBindings.some(binding => binding.characterName === row.characterName && binding.matchedName === row.name))) {
        missing.push('本镜每项人物装备需求都须有一条同人物已归档装备绑定')
      }
      const equipmentInstruction = characterEquipmentPrompt(equipmentBindings).trim()
      if (equipmentBindings.length && (!equipmentInstruction || !prompt.includes(equipmentInstruction))) {
        missing.push('视频提示须携带同人物装备名称、描述与资产编号')
      }
    } catch (error) { missing.push(error instanceof Error ? error.message : String(error)) }
  }
  if (params.characterVisuals !== undefined && params.characterVisuals !== '' && params.characterVisuals !== '${shot_script.characterVisuals}') {
    if (!Array.isArray(params.characterVisuals)) missing.push('有效的人物年龄与场景造型列表')
    else {
      const seen = new Set<string>()
      const requiredNames = [...new Set([...characterNames,
        ...['initialCharacters', 'enteringCharacters'].flatMap(key => Array.isArray(params[key]) ? (params[key] as unknown[]).filter((name): name is string => typeof name === 'string') : []),
        ...rows(params.referenceBindings).map(binding => binding.characterName).filter((name): name is string => typeof name === 'string')])]
      const allowedNames = [...new Set([...requiredNames, ...(Array.isArray(params.presentCharacters) ? params.presentCharacters.filter((name): name is string => typeof name === 'string') : [])])]
      for (const visual of rows(params.characterVisuals)) {
      try {
        if (typeof visual.name !== 'string' || !visual.name.trim() || seen.has(visual.name) || !allowedNames.includes(visual.name)) throw new Error('人物年龄与场景造型须绑定本镜唯一具名人物')
        seen.add(visual.name)
        const wanted = normalizeCharacterVisualContext(visual.visualContext)
        if (!wanted) throw new Error(`${visual.name}缺少年龄与场景造型契约`)
        const binding = rows(params.referenceBindings).find(row => row.characterName === visual.name)
        // Tail-bound actors use the preceding accepted shot. Supplied identity
        // images, including entrants, must satisfy this scene's current design.
        if (binding) {
          const result = characterVisualContextCompatibility(wanted, binding)
          if (!result.matches) missing.push(`${String(visual.name)}人物参考年龄/造型：${result.reason}`)
        }
      } catch (error) { missing.push(error instanceof Error ? error.message : String(error)) }
      }
      if (requiredNames.some(name => !seen.has(name))) missing.push('人物年龄与场景造型必须覆盖本镜全部具名人物，不得用空列表或另一人物绕过参考匹配')
    }
  }
  const illustrationLayers = rows(params.illustrationLayers)
  const layerNames = illustrationLayers.map(layer => layer.characterName).filter(name => typeof name === 'string')
  const mapPortraitLayers = isHistoricalSandTable({ visualTreatment, animationStyle, editorialRole }) && illustrationLayers.length > 0
  if (animationStyle === 'historical_map' && illustrationLayers.length > 0 && !mapPortraitLayers) {
    missing.push('静态人物叠层仅适用于已批准的 historical_map 开场、承接或收束信息镜头')
  }
  const completeIllustrationLayers = (staticIllustration || mapPortraitLayers) && characterNames.length > 0
    && layerNames.length === characterNames.length
    && new Set(layerNames).size === layerNames.length
    && characterNames.every(name => layerNames.filter(layerName => layerName === name).length === 1)
    && illustrationLayers.every(layer => {
      const enterStart = Number(layer.enterStart), enterDuration = Number(layer.enterDuration)
      const exitStart = Number(layer.exitStart), exitDuration = Number(layer.exitDuration)
      return [['x', 0, 1], ['y', 0, 1], ['scale', .1, .46], ['enterFromX', 0, 1], ['enterFromY', 0, 1]]
        .every(([key, min, max]) => Number.isFinite(Number(layer[key])) && Number(layer[key]) >= Number(min) && Number(layer[key]) <= Number(max))
        && Number.isFinite(enterStart) && enterStart >= 0 && Number.isFinite(enterDuration) && enterDuration >= .2
        && Number.isFinite(exitStart) && exitStart >= enterStart + enterDuration
        && Number.isFinite(exitDuration) && exitDuration >= .2 && exitStart + exitDuration <= duration + .001
    })
  if (animationStyle === 'historical_map' && characterNames.length > 0 && !mapPortraitLayers) missing.push('历史地图中具名人物须通过静态人物图层呈现')
  if (mapPortraitLayers) {
    if (!completeIllustrationLayers) missing.push('历史地图人物图层必须与本镜具名人物一一对应，且布局与时间合法')
    const bindings = rows(params.referenceBindings)
    if (referenceImages.length !== layerNames.length || bindings.length !== layerNames.length
      || bindings.some((binding, index) => typeof binding.characterName !== 'string' || !layerNames.includes(binding.characterName) || binding.role !== 'identity'
        || bindings.filter(row => row.characterName === binding.characterName).length !== 1
        || typeof referenceImages[index] !== 'string' || !String(referenceImages[index]).trim())) {
      missing.push('历史地图人物图层必须逐一绑定同名已归档人物图片，不能缺失或使用替身')
    }
    if (params.audioType !== '旁白' || !params.narrationVoice || typeof params.narrationVoice !== 'object') {
      missing.push('历史地图静态人物图层必须使用独立画外旁白')
    }
  }
  const pacing = object(params.pacing)
  const entryMatchesVerifiedSchedule = (binding: Record<string, unknown>) => {
    if (!verifiedDurationV2 || binding.role !== 'entering' || typeof binding.characterName !== 'string') return false
    const entry = object(binding.entrance), name = binding.characterName
    if (entry.name !== name || typeof entry.path !== 'string' || !entry.path.trim()
      || !Array.isArray(params.presentCharacters) || !params.presentCharacters.includes(name)) return false
    const schedule = rows(pacing.schedule)
    const matches = matchingEntranceActions(entry as StoryboardEntrance, rows(pacing.beats) as DurationBeat[])
    const entryBeat = matches.length === 1 && matches[0]
    return Boolean(entryBeat) && schedule.some(window => window.beatId === (entryBeat as DurationBeat).id
      && Number(window.startSecond) === Number(entry.startSecond) && Number(window.endSecond) === Number(entry.endSecond))
      && schedule.filter(window => ['speech', 'vocalization'].includes(String(window.kind))
      && Array.isArray(window.actorIds) && window.actorIds.includes(name)).every(window => Number(window.startSecond) >= Number(entry.endSecond))
  }
  if (version && version !== 'cinematic-v1') missing.push('已知内容契约 cinematic-v1，未知版本需重新审核')
  if (version === 'cinematic-v1') {
    const continuityMode = String(params.continuityMode ?? '')
    if (!['tail_continuation', 'coverage_cut', 'scene_cut'].includes(continuityMode)) missing.push('明确三种 continuityMode')
    const expectedFrameMode = continuityMode === 'tail_continuation' ? 'reuse_previous_tail' : 'reference'
    if (params.firstFrameMode !== expectedFrameMode) missing.push('机位模式与 firstFrameMode 一致')
    if (continuityMode === 'tail_continuation' && !hasFirstFrame) missing.push('长镜续拍所需的前镜实际尾帧')
    if (continuityMode === 'coverage_cut' && hasFirstFrame && !animatedShot && !params.coverageCutFrameGate)
      missing.push('同场切镜新机位首帧缺少实际图片验收凭证')
    if (!referenceImages.length && !emptyEditorialCast) missing.push('本镜人物身份参考')
    const emptyInitialWithVerifiedEntrances = verifiedDurationV2 && Array.isArray(params.presentCharacters) && params.presentCharacters.length > 0
      && params.presentCharacters.every(name => rows(params.referenceBindings).some(binding => binding.characterName === name && entryMatchesVerifiedSchedule(binding)))
    if (!Array.isArray(params.initialCharacters) || (!params.initialCharacters.length && !emptyInitialWithVerifiedEntrances && !emptyEditorialCast && !completeIllustrationLayers) || !Array.isArray(params.presentCharacters)
      || params.initialCharacters.some(name => !(params.presentCharacters as unknown[]).includes(name))) missing.push('本镜首帧可见人物与仍在场人物的明确区分')
    try { validateCinematicWorldState(params.worldState, params.presentCharacters) } catch { missing.push('有证据或明确 unknown 的世界状态') }
    if (!['旁白', '对白', '环境声'].includes(String(params.audioType))) missing.push('明确音轨类型')
    if (params.audioType === '环境声' ? params.audioText !== '' : typeof params.audioText !== 'string' || !params.audioText.trim()) missing.push('环境声空台词或实际需要说出的完整台词')
    if (staticIllustration && params.audioType !== '旁白') missing.push('静态插画只使用画外旁白，不得生成人物对白或口型')
    if (staticIllustration && (!params.narrationVoice || typeof params.narrationVoice !== 'object')) missing.push('静态插画独立旁白音色；禁止退回视频模型原生人声')
  } else if (params.audioType === '环境声') missing.push('环境声表演需使用 cinematic-v1 内容契约')
  if ((hasFirstFrame || version === 'cinematic-v1') && referenceImages.length) {
    const bindings = Array.isArray(params.referenceBindings) ? params.referenceBindings : []
    const initialCharacters = Array.isArray(params.initialCharacters) ? params.initialCharacters : []
    const validBindings = bindings.length === referenceImages.length && bindings.every((binding) => {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false
      const record = binding as Record<string, unknown>
      if (record.role === 'identity') return typeof record.characterName === 'string'
        && (initialCharacters.includes(record.characterName) && scenePrompt.includes(record.characterName)
          // Character illustrations and map portraits deliberately keep named
          // people out of the background plate. Their identity is bound by a
          // timed local layer and verified full video timeline instead.
          || completeIllustrationLayers && characterNames.includes(record.characterName)
            && typeof params.videoTimeline === 'string' && params.videoTimeline.includes(record.characterName))
      const entrance = record.entrance
      if (record.role !== 'entering'
        || typeof record.characterName !== 'string'
        || entrance === null
        || typeof entrance !== 'object'
        || Array.isArray(entrance)) return false
      const entry = entrance as Record<string, unknown>
      const startSecond = Number(entry.startSecond)
      const endSecond = Number(entry.endSecond)
      return entry.name === record.characterName
        && typeof entry.path === 'string'
        && entry.path.trim().length > 0
        && Number.isFinite(startSecond)
        && Number.isFinite(endSecond)
        && startSecond >= 0
        && endSecond > startSecond
        && endSecond <= duration - (verifiedDurationV2 ? Number(object(pacing.timingPolicy).endingReadabilityReserve) : 0.3)
        && (!verifiedDurationV2 || entryMatchesVerifiedSchedule(record))
    })
    if (!validBindings) missing.push('续接参考必须为开场已声明的 identity 人物、已编排淡入的插画 identity 人物，或带入场时间与路径的 entering 人物')
  }
  if (missing.length) {
    throw new Error(`三国短剧视频请求不完整：缺少 ${missing.join('、')}；已阻止无真实音轨或不符合内容、镜头和动态时长契约的请求`)
  }
}
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
