import { characterAssetEpisodeScopeMatches, characterVisualContextFrom, characterVisualContextSignature, normalizeCharacterVisualContext } from './character-visual-context.ts'
import type { CharacterVisualContext } from './character-visual-context.ts'
import { characterArtisticIdentityFrom } from './character-artistic-identity.ts'
import { textMentionsCharacterIdentity } from './character-biography.ts'
import { isPendingIdentityReview, isRejectedPortraitReview, isSupersededPortrait } from './character-portrait-lifecycle.ts'
import { SANGUO_CHARACTER_LOOKUP_CODE, SANGUO_FIRST_FRAME_BRANCH_CODE } from './code-node-presets.ts'

type Value = Record<string, unknown>
export const CHARACTER_VISUAL_CONTEXT_RUNTIME_VERSION = '2026-09-28-character-equipment-v1'

export type ResolvedCharacterVisualSelection = { name: string; assetId: string; visualContext: CharacterVisualContext }

/** An input may pin a sheet globally, or only for named episodes. Resolve the
 * latter before every downstream node so a Changban design cannot silently
 * become Zhang Fei's appearance decades later. Legacy name-to-ID inputs keep
 * their original global meaning. */
export function characterSelectionsForEpisode(value: unknown, episodeNumber: unknown): Record<string, string> {
  if (value === undefined || value === null || value === '') return {}
  let source = value
  if (typeof source === 'string') {
    try { source = JSON.parse(source) } catch { throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: 所选人物三视图必须是JSON对象') }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: 所选人物三视图必须是JSON对象')
  const activeEpisode = Number(episodeNumber)
  const selected: Record<string, string> = {}
  const ids = new Set<string>()
  for (const [name, entry] of Object.entries(source)) {
    if (!name.trim() || name !== name.trim()) throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: 人物名不能为空或带首尾空格')
    let assetId: unknown = entry
    let applies = true
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const scoped = entry as Record<string, unknown>
      if (Object.keys(scoped).some(key => !['assetId', 'episodes'].includes(key))
        || !Array.isArray(scoped.episodes) || !scoped.episodes.length
        || scoped.episodes.some(number => !Number.isSafeInteger(number) || number < 1)) {
        throw new Error(`CHARACTER_VISUAL_SELECTION_INVALID: ${name} 的按集指定须包含有效episodes数组`)
      }
      assetId = scoped.assetId
      applies = Number.isSafeInteger(activeEpisode) && scoped.episodes.includes(activeEpisode)
    }
    if (typeof assetId !== 'string' || !assetId.trim() || assetId !== assetId.trim()) {
      throw new Error(`CHARACTER_VISUAL_SELECTION_INVALID: ${name} 的三视图资产ID无效`)
    }
    if (!applies) continue
    if (ids.has(assetId)) throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: 同一三视图不可指定给多个人物')
    ids.add(assetId)
    selected[name] = assetId
  }
  return selected
}

/** Resolve only persisted sheets in this workflow, never a caller-supplied design or URL. */
export function resolveCharacterVisualSelections(assets: unknown[], workflowId: string, selections: unknown): ResolvedCharacterVisualSelection[] {
  if (selections === undefined || selections === null || selections === '') return []
  let source = selections
  if (typeof source === 'string') {
    try { source = JSON.parse(source) } catch { throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: characterAssetSelections 必须是人物名到资产ID的JSON对象') }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: characterAssetSelections 必须是人物名到资产ID的JSON对象')
  const seen = new Set<string>()
  return Object.entries(source).map(([name, id]) => {
    if (!name.trim() || name !== name.trim() || typeof id !== 'string' || !id.trim() || id !== id.trim() || seen.has(id)) {
      throw new Error(`CHARACTER_VISUAL_SELECTION_INVALID: 人物名和资产ID必须是唯一的非空文字：${name}`)
    }
    seen.add(id)
    const rows = assets.filter(value => value && typeof value === 'object' && !Array.isArray(value) && (value as Value).id === id) as Value[]
    if (rows.length !== 1) throw new Error(`CHARACTER_VISUAL_SELECTION_INVALID: 所选资产不存在或ID不唯一：${name}/${id}`)
    const asset = rows[0]
    if (isRejectedPortraitReview({ metadata: asset.metadata as Record<string, unknown> })) {
      throw new Error(`CHARACTER_PORTRAIT_REVIEW_REJECTED: ${name} 所选三视图 ${id} 已被人工拒绝，不能进入工作流`)
    }
    if (isPendingIdentityReview({ metadata: asset.metadata as Record<string, unknown> })) {
      throw new Error(`CHARACTER_IDENTITY_REVIEW_REQUIRED: ${name} 所选三视图 ${id} 尚未完成审核，不能进入工作流`)
    }
    const assetName = asset.characterName ?? asset.character_name ?? asset.name
    const assetWorkflow = asset.workflowId ?? asset.workflow_id
    // The library API's threeViewUrl is already restricted to three-view rows.
    const type = asset.assetType ?? asset.asset_type
    const image = asset.threeViewUrl ?? asset.uri ?? asset.imageUrl
    if (assetWorkflow !== workflowId || assetName !== name || (type !== undefined ? type !== 'three-view' : !asset.threeViewUrl)
      || typeof image !== 'string' || !image.trim()) throw new Error(`CHARACTER_VISUAL_SELECTION_INVALID: 所选资产必须是同工作流、同人物的三视图：${name}/${id}`)
    let visualContext: CharacterVisualContext | undefined
    try { visualContext = characterVisualContextFrom({ metadata: asset.metadata }) } catch {
      throw new Error(`CHARACTER_VISUAL_SELECTION_INVALID: 所选资产年龄与造型契约无效：${name}/${id}`)
    }
    if (!visualContext) throw new Error(`CHARACTER_VISUAL_SELECTION_INVALID: 所选资产缺少已归档年龄与造型契约：${name}/${id}`)
    return { name, assetId: id, visualContext }
  })
}

/** Selected designs are binding only where that actor actually appears. */
export function assertSelectedCharacterVisuals(value: unknown, selectedCharacterVisuals: readonly ResolvedCharacterVisualSelection[] = []): void {
  if (!selectedCharacterVisuals.length) return
  const seen = new Set<string>()
  const selected = selectedCharacterVisuals.map(row => {
    const context = normalizeCharacterVisualContext(row.visualContext)
    if (!row.name || !row.assetId || seen.has(row.name) || !context) throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: 精选人物身份或造型契约无效')
    seen.add(row.name)
    return { ...row, visualContext: context }
  })
  const checkContext = (context: unknown, chosen: ResolvedCharacterVisualSelection, path: string) => {
    const actual = normalizeCharacterVisualContext(context)
    // The visible signature alone deliberately excludes age provenance. Keep
    // that provenance here too: an artistic age must never become a historical claim.
    if (!actual || characterVisualContextSignature(actual) !== characterVisualContextSignature(chosen.visualContext)
      || JSON.stringify(actual.age) !== JSON.stringify(chosen.visualContext.age)) {
      throw new Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${path} 必须原样使用用户所选三视图 ${chosen.assetId} 的人物年龄与造型，不得改用中间候选或改写艺术年龄依据；所选设计=${JSON.stringify(chosen)}`)
    }
  }
  const check = (item: unknown, path: string) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`CHARACTER_VISUAL_SELECTION_INVALID: ${path} 必须是对象`)
    const row = item as Value
    const names = [...new Set(['cast', 'characters', 'initialCharacters', 'enteringCharacters', 'endCharacters', 'presentCharacters']
      .flatMap(key => Array.isArray(row[key]) ? (row[key] as unknown[]).filter((name): name is string => typeof name === 'string') : []))]
    for (const chosen of selected.filter(selection => names.includes(selection.name))) {
      const declared = Array.isArray(row.characterVisuals) ? row.characterVisuals.filter(item => item && typeof item === 'object'
        && !Array.isArray(item) && (item as Value).name === chosen.name) as Value[] : []
      if (declared.length !== 1) throw new Error(`CHARACTER_VISUAL_SELECTION_MISMATCH: ${path}.characterVisuals 必须唯一声明所选人物 ${chosen.name}；所选设计=${JSON.stringify(chosen)}`)
      checkContext(declared[0].visualContext, chosen, `${path}.characterVisuals.${chosen.name}`)
    }
    return row
  }
  const row = check(value, 'output')
  if (row.scenes !== undefined) {
    if (!Array.isArray(row.scenes)) throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: output.scenes 必须是数组')
    row.scenes.forEach((scene, index) => check(scene, `scenes[${index}]`))
  }
  if (Array.isArray(row.characterDramas)) for (const item of row.characterDramas) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const character = item as Value, chosen = selected.find(selection => selection.name === character.name)
    if (chosen && character.visualContext !== undefined) checkContext(character.visualContext, chosen, `characterDramas.${chosen.name}.visualContext`)
  }
}

/** Bounded design catalogue for writers; image URLs and voice data never enter prompts. */
export function characterVisualCatalog(assets: unknown[], workflowId: string, relevant: unknown, selectedCharacterVisuals: readonly ResolvedCharacterVisualSelection[] = []): Value[] {
  const text = JSON.stringify(relevant) ?? ''
  const episodeNumber = relevant && typeof relevant === 'object' && !Array.isArray(relevant)
    ? (relevant as Value).input && typeof (relevant as Value).input === 'object'
      ? ((relevant as Value).input as Value).episode_number : undefined : undefined
  const seen = new Set<string>(), counts = new Map<string, number>()
  const result: Value[] = []
  let size = 0
  for (const selection of selectedCharacterVisuals) {
    if (!text.includes(selection.name)) continue
    const item = { ...selection, selected: true }
    const length = JSON.stringify(item).length
    if (size + length > 8000 || result.length >= 24) throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: 所选人物设计超过提示目录容量，请缩小本次人物范围')
    size += length; result.push(item)
  }
  for (const value of assets) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const asset = value as Value, name = String(asset.characterName ?? asset.name ?? '').trim()
    if (asset.workflowId !== workflowId || !name || !text.includes(name) || selectedCharacterVisuals.some(selection => selection.name === name)
      || !characterAssetEpisodeScopeMatches(asset, episodeNumber) || (counts.get(name) ?? 0) >= 6) continue
    const portrait = { metadata: asset.metadata as Record<string, unknown> }
    if (isSupersededPortrait(portrait) || isPendingIdentityReview(portrait)) continue
    try {
      const context = characterVisualContextFrom({ metadata: asset.metadata })
      if (!context) continue
      const key = `${name}:${characterVisualContextSignature(context)}`
      if (seen.has(key)) continue
      const item = {name, ageStage: context.age.stage, look: context.look, appearanceConstraints: context.appearanceConstraints}
      const length = JSON.stringify(item).length
      if (size + length > 8000 || result.length >= 24) continue
      seen.add(key); counts.set(name, (counts.get(name) ?? 0) + 1); size += length; result.push(item)
    } catch { /* Invalid legacy metadata cannot prescribe a new scene's design. */ }
  }
  return result
}

/** An active face direction may cross episode boundaries; the sheet's age,
 * costume, URL and scene-specific visualContext may not. */
export function characterArtisticIdentityCatalog(assets: unknown[], workflowId: string, relevant: unknown): Value[] {
  const text = JSON.stringify(relevant) ?? ''
  const result: Value[] = [], seen = new Set<string>()
  let size = 0
  for (const value of assets) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const asset = value as Value, name = String(asset.characterName ?? asset.name ?? '').trim()
    if (asset.workflowId !== workflowId || !name || !textMentionsCharacterIdentity(name, text)
      || isSupersededPortrait({ metadata: asset.metadata as Record<string, unknown> })
      || isPendingIdentityReview({ metadata: asset.metadata as Record<string, unknown> })) continue
    const identity = characterArtisticIdentityFrom(asset)
    if (!identity) continue
    if (seen.has(name)) throw Error(`CHARACTER_ARTISTIC_IDENTITY_CONFLICT: ${name} 有多个跨集当前身份图，请只保留一个`)
    const item = { name, sourceAssetId: asset.id, artisticIdentity: identity }
    const length = JSON.stringify(item).length
    if (size + length > 4000 || result.length >= 24) throw Error('CHARACTER_ARTISTIC_IDENTITY_INVALID: 本次人物身份目录超过容量')
    result.push(item); seen.add(name); size += length
  }
  return result
}

/** Keep the writer's inventory small and textual. Asset URLs never become
 * historical evidence or automatic scene requirements. */
export function characterEquipmentCatalog(equipment: unknown[], workflowId: string, relevant: unknown): Value[] {
  const text = JSON.stringify(relevant) ?? ''
  const result: Value[] = []
  let size = 0
  for (const value of equipment) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const item = value as Value
    const name = String(item.characterName ?? '').trim()
    if (item.workflowId !== workflowId || !name || !textMentionsCharacterIdentity(name, text)) continue
    const summary = { characterName: name, name: item.name, kind: item.kind,
      aliases: Array.isArray(item.aliases) ? item.aliases : [], applicability: item.applicability ?? {} }
    const length = JSON.stringify(summary).length
    if (result.length >= 40 || size + length > 6000) break
    size += length
    result.push(summary)
  }
  return result
}

/** Provider prompt text is derived from the archive lookup output. The image
 * URL stays in the execution record for review and is not passed as a person
 * reference image, where it would corrupt the three-view binding contract. */
export function characterEquipmentPrompt(bindings: unknown): string {
  if (!Array.isArray(bindings) || !bindings.length) return ''
  const rows = bindings.filter((value): value is Value => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
    .map(item => ({ characterName: item.characterName, equipmentId: item.id,
      name: item.name, kind: item.kind, description: item.description }))
  return rows.length ? `\n【人物装备资产绑定】${JSON.stringify(rows)}。每件装备只属于标注人物；按本镜已批准动作和时间使用，不换成相似兵器。装备资产编号用于追溯，人物三视图只决定脸、年龄与服饰。` : ''
}

/** A scene's authored costume and life stage are not inferred from a cached image. */
export function validatedCharacterVisuals(value: unknown, names: string[], path: string): Value[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`CHARACTER_VISUAL_CONTEXT_INVALID: ${path} 必须是数组`)
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`CHARACTER_VISUAL_CONTEXT_INVALID: ${path}[${index}] 必须是人物与造型对象`)
    const row = item as Value
    const name = String(row.name ?? '').trim()
    if (!name || !names.includes(name) || seen.has(name) || Object.keys(row).some(key => !['name', 'visualContext'].includes(key))) {
      throw new Error(`CHARACTER_VISUAL_CONTEXT_INVALID: ${path} 人物须唯一且属于当前cast：${name}`)
    }
    seen.add(name)
    const visualContext = normalizeCharacterVisualContext(row.visualContext)
    if (!visualContext) throw new Error(`CHARACTER_VISUAL_CONTEXT_INVALID: ${path}.${name} 缺少明确造型契约`)
    return { name, visualContext }
  })
}

/** Gear is an independent character asset. A scene or shot must name it
 * explicitly; prose mentioning a weapon is never treated as an asset binding. */
export function validatedCharacterEquipment(value: unknown, names: string[], path: string): Value[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`CHARACTER_EQUIPMENT_REQUIREMENT_INVALID: ${path} 必须是数组`)
  const seen = new Set<string>()
  const words = (input: unknown, key: string) => {
    if (!Array.isArray(input) || input.length > 20 || input.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim() || item.length > 120)) {
      throw new Error(`CHARACTER_EQUIPMENT_REQUIREMENT_INVALID: ${path}.${key} 必须是非空名称数组`)
    }
    const values = input as string[]
    if (new Set(values).size !== values.length) throw new Error(`CHARACTER_EQUIPMENT_REQUIREMENT_INVALID: ${path}.${key} 不得重复`)
    return values
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`CHARACTER_EQUIPMENT_REQUIREMENT_INVALID: ${path}[${index}] 必须是对象`)
    const row = item as Value, name = String(row.name ?? '')
    if (!name || name !== name.trim() || !names.includes(name) || seen.has(name)
      || Object.keys(row).some(key => !['name', 'equipmentNames', 'sceneTags'].includes(key))) {
      throw new Error(`CHARACTER_EQUIPMENT_REQUIREMENT_INVALID: ${path} 人物须唯一且属于当前cast：${name}`)
    }
    seen.add(name)
    const equipmentNames = words(row.equipmentNames, 'equipmentNames')
    const sceneTags = row.sceneTags === undefined ? undefined : words(row.sceneTags, 'sceneTags')
    return { name, equipmentNames, ...(sceneTags ? { sceneTags } : {}) }
  })
}

/** Copy approved scene requirements, refusing a writer's silent age/costume substitution. */
export function inheritShotCharacterVisuals(shot: Value, scene: Value): Value {
  const sceneNames = Array.isArray(scene.cast) ? scene.cast.filter((name): name is string => typeof name === 'string') : []
  const planned = validatedCharacterVisuals(scene.characterVisuals, sceneNames, 'scene.characterVisuals')
  const names = [...new Set(['characters', 'initialCharacters', 'enteringCharacters', 'endCharacters', 'presentCharacters']
    .flatMap(key => Array.isArray(shot[key]) ? (shot[key] as unknown[]).filter((name): name is string => typeof name === 'string') : []))]
  const declared = validatedCharacterVisuals(shot.characterVisuals, [...new Set([...sceneNames, ...names])], 'shot.characterVisuals')
  const plannedEquipment = validatedCharacterEquipment(scene.characterEquipment, sceneNames, 'scene.characterEquipment')
  const declaredEquipment = validatedCharacterEquipment(shot.characterEquipment, [...new Set([...sceneNames, ...names])], 'shot.characterEquipment')
  const equipment = plannedEquipment || declaredEquipment
    ? names.flatMap(name => {
      const authored = declaredEquipment?.find(row => row.name === name)
      const fromScene = plannedEquipment?.find(row => row.name === name)
      if (authored && plannedEquipment && (authored.equipmentNames as string[]).some(item => !(fromScene?.equipmentNames as string[] | undefined)?.includes(item))) {
        throw new Error(`CHARACTER_EQUIPMENT_REQUIREMENT_MISMATCH: ${name} 分镜新增的装备须先在已批准场景中声明`)
      }
      const selected = authored ?? fromScene
      return selected ? [selected] : []
    }) : undefined
  const withEquipment = equipment ? { ...shot, characterEquipment: equipment } : shot
  if (!planned) return declared ? { ...withEquipment, characterVisuals: declared } : withEquipment
  const relevant = planned.filter(row => names.includes(String(row.name)))
  if (declared && JSON.stringify(declared) !== JSON.stringify(relevant)) {
    throw new Error('CHARACTER_VISUAL_CONTEXT_INVALID: 分镜不得改写当前已批准人物年龄或场景造型；拆镜只继承本段人物对应项')
  }
  return { ...withEquipment, characterVisuals: relevant }
}

/** Use before lookup, so an old-age image cannot win the name-only database query. */
export function characterInputsForShot(value: unknown): Value[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const shot = value as Value
  const names = Array.isArray(shot.characters) ? [...new Set(shot.characters.filter((name): name is string => typeof name === 'string' && Boolean(name.trim())))] : []
  const visuals = validatedCharacterVisuals(shot.characterVisuals, [...new Set([...names,
    ...(Array.isArray(shot.presentCharacters) ? shot.presentCharacters.filter((name): name is string => typeof name === 'string') : [])])], 'shot.characterVisuals') ?? []
  const equipment = validatedCharacterEquipment(shot.characterEquipment, [...new Set([...names,
    ...(Array.isArray(shot.presentCharacters) ? shot.presentCharacters.filter((name): name is string => typeof name === 'string') : [])])], 'shot.characterEquipment') ?? []
  return names.map(name => ({ name, ...(visuals.find(row => row.name === name) ?? {}),
    ...(equipment.find(row => row.name === name) ?? {}) }))
}

export const CHARACTER_VISUAL_OUTLINE_PROMPT = `【人物年龄与场景造型·大纲】
每个具名人物的画面设计须参照当前史事时间，不将同一人物的少年、壮年、老年三视图混用。先核对来源支持的事件时间及年龄/生年；有可靠依据时以岁数范围记录并列sourceRefs，生年不确定则保留不确定性，不能用小说、民间生日或模型记忆冒充正史。没有年龄依据时可选择符合剧情的艺术年龄阶段，basis=artistic；也可basis=unknown、stage=unknown，不编造精确年龄。没有明确衰老依据，不因历史人物姓名或“老将”印象自动加白发白须。
在每个scenes条目新增characterVisuals数组，与本段cast中的具名人物一一对应；空cast使用[]。每项为{name,visualContext}，name保持原人物身份，不因换年龄或服装改名。visualContext严格采用：{version:'character-visual-context-v1',age:{stage:'child|adolescent|young_adult|adult|mature|elderly|unknown',basis:'documented|estimated|artistic|unknown',asOf:'当前剧情时间；不明则明确不明',years:{min:年龄下限,max:年龄上限},sourceRefs:['已有史料引用']},look:{key:'稳定造型标识',description:'服装、冠帽等本场稳定造型'},appearanceConstraints:{hair:'dark|graying|white|unknown',facialHair:'dark|graying|white|none|unknown',build:'体型与气质'}}。years仅有依据或明确艺术年龄范围时提供，不明则省略；unknown依据不填确切岁数，documented/estimated必须列来源。人物初始设计也可在characterDramas.visualContext记录，后续以当前场景版本为准。
场景造型指战场、朝服、便服、旅途等会改变服装/冠帽的稳定场合，不是把每个地名、镜头、情绪或动作做成新资产。相同年龄和服装沿用同一look.key，人物跨年或确实换装时另选对应版本。三视图仍为纯色背景横向一行三列，不将剧情地点、兵器、坐骑或动作画进资产。不同年龄保持同一人物可辨认的面部身份。
每段另写characterEquipment数组，只记录剧情文本明确要求归属该人物并需要本段呈现的装备；没有明确要求时写[]。每项为{name,equipmentNames:['剧情明确要求的装备原名'],sceneTags:['明确稳定场合标签']}，name须属于本段cast。不能从人物名、惯用武器印象或背景提示词猜测装备。已建档的人物装备目录：\${characterEquipmentCatalog}；它只帮助核对已归档名称或别名，不是史实或剧情必用清单。即使目录没有剧情明确要求的装备，也保留剧情原名，让人物召回节点明确阻断并提示补录；不得静默丢掉或改用相似武器。武器与三视图分开归档。sceneTags仅表示确有区别的战场、朝堂、旅途等稳定场合，不将地点、动作或情绪当作新标签。
本集相关人物已有造型定义：\${characterVisualCatalog}。这是可选创作资产，不是历史依据或已观察画面证据。年龄及须发要求吻合时，逐字沿用已有look.key、look.description与appearanceConstraints，不为同一体型气质换个说法新建资产；同一key下不得改写服装定义。真正换装才创建新key；年龄依据和asOf仍以本集史料及剧情时间为准。
本作当前选用的跨集人物艺术身份：\${characterArtisticIdentityCatalog}。这里只给同一人物的脸部、肤色和骨架审美方向，不含旧图的年龄、须发、衣装或剧情场景；sourceAssetId只追溯当前选用图片，不是史料或人工验收结论。遇到该人物时，在当前场景的appearanceConstraints.build中写出符合本场年龄的稳定脸部/肤色/骨架特征；hair、facialHair、age、look仍须由本集史料和当前剧情设计，不照抄身份来源图的长坂造型。人物即使换装或跨年，也保持同一张脸的可辨认骨相和好看程度，不将艺术面容冒充正史容貌。
本次用户明确选定的人物三视图与已归档设计：\${selectedCharacterVisuals}。非空时，所选人物在characterDramas初始设计和每段出镜scene.characterVisuals中必须原样使用指定visualContext，不改年龄、须发、肤色体型、服装或依据，不替换成目录里的其他候选。assetId只表示已选资产，不是史料引用，不写入characterVisuals条目；其中basis=artistic的年龄必须保持艺术设定，不能声称该数字或面容是正史复原。所选人物未出镜的纯环境段仍使用空cast和[]，不为引用所选资产强行加人。
这些字段是创作设计和召回条件，不是已观察的画面证据；史实心理与剧情边界仍按原契约执行。大纲中确证/估计年龄的sourceRefs必须使用本集已有[史料N]引用，不用未核对的生年或外部传说伪装史实年龄。
【人物年龄与场景造型·大纲结束】`

export const CHARACTER_VISUAL_STORYBOARD_PROMPT = `【人物年龄与场景造型·分镜】
继承当前scene.characterVisuals，只保留本段人物对应条目，写入characterVisuals；不得用库里最新人物图反向改写已批准的年龄阶段、须发或服装。visualPrompt/首尾画面中的人物描述要符合当前造型，明显白发白须不能替代明确的黑发黑须要求。拆镜保留对应人物版本，不用新年龄造型偷换同场身份。普通分镜动作、情绪和地点不进入三视图设计；真正跨年或换装应由上游场景明确安排。
继承当前scene.characterEquipment中本镜人物的装备需求，写入characterEquipment；只在已批准场景包含该装备时，才可按本镜实际动作选择使用，不能把已批准武器改成同类替身。没有装备需求写[]。装备是独立于人物三视图的资产，visualPrompt与videoPrompt须写明实际归属人物和装备名称；三视图不画持物动作。
用户所选人物三视图与已归档设计：\${selectedCharacterVisuals}。出镜的所选人物须原样继承指定visualContext，不能改用中间候选；艺术年龄及面容设计不冒充史实复原。assetId用于资产绑定，不新增到characterVisuals条目中。
本作跨集人物艺术身份：\${characterArtisticIdentityCatalog}。镜头描写保留对应人物的脸部骨相、肤色和骨架方向；实际年龄、须发、服饰按本段scene.characterVisuals，不借用身份源图的旧年龄和衣装。此艺术身份不是历史容貌证据。
【人物年龄与场景造型·分镜结束】`

export function refreshCharacterVisualPrompt(prompt: string, stage: 'outline' | 'storyboard') {
  const body = stage === 'outline' ? CHARACTER_VISUAL_OUTLINE_PROMPT : CHARACTER_VISUAL_STORYBOARD_PROMPT
  const section = stage === 'outline' ? /【人物年龄与场景造型·大纲】[\s\S]*?【人物年龄与场景造型·大纲结束】/g
    : /【人物年龄与场景造型·分镜】[\s\S]*?【人物年龄与场景造型·分镜结束】/g
  let found = false
  const next = prompt.replace(section, () => { if (found) return ''; found = true; return body })
  return found ? next : `${prompt}\n\n${body}`
}

function legacyManagedCodeFingerprint(code: string): string {
  let hash = 2166136261
  for (let index = 0; index < code.length; index++) hash = Math.imul(hash ^ code.charCodeAt(index), 16777619)
  return `${code.length}:${(hash >>> 0).toString(16)}`
}

export function upgradeCharacterVisualWorkflow<N extends {id: string; prompt: string; code?: string; params?: Array<{id?: string;name?: string;englishName?: string;type?: string;required?: boolean;value?: string}>}, W extends {id: string; schemaVersion?: number; nodes: N[]}>(workflow: W, knownLegacyCodeOnly = false): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 145) return workflow
  const inputParams = (params: NonNullable<N['params']>) => {
    const existing = params.find(param => (param.englishName || param.name) === 'characterAssetSelections')
    const expected = { id: 'character-asset-selections-input', name: '所选人物三视图', englishName: 'characterAssetSelections', type: 'json', required: false, value: existing?.value ?? '{}' }
    const next = existing && Object.entries(expected).every(([key, value]) => (existing as Value)[key] === value)
      ? existing : { ...existing, ...expected }
    return existing ? params.filter(param => (param.englishName || param.name) !== 'characterAssetSelections' || param === existing)
      .map(param => param === existing ? next : param) : [...params, next]
  }
  const videoParams = (params: NonNullable<N['params']>) => {
    const ensure = (current: NonNullable<N['params']>, expected: NonNullable<N['params']>[number]) => {
      const existing = current.find(param => (param.englishName || param.name) === expected.englishName)
      // PostgreSQL jsonb changes object key order; preserve equal persisted
      // params so loading an upgraded workflow creates no phantom change.
      const next = existing && Object.entries(expected).every(([key, value]) => (existing as Value)[key] === value)
        ? existing : { ...existing, ...expected }
      return existing ? current.filter(param => (param.englishName || param.name) !== expected.englishName || param === existing)
        .map(param => param === existing ? next : param) : [...current, next]
    }
    return [
      {id: 'character-visual-context-video', name: '人物年龄与场景造型', englishName: 'characterVisuals', type: 'json', required: false, value: '${shot_script.characterVisuals}'},
      {id: 'sg-v-characters', name: '本镜人物', englishName: 'characters', type: 'json', required: false, value: '${shot_script.characters}'},
      {id: 'sg-v-character-equipment', name: '本镜人物装备需求', englishName: 'characterEquipment', type: 'json', required: false, value: '${shot_script.characterEquipment}'},
      {id: 'sg-v-equipment-bindings', name: '已归档装备绑定', englishName: 'equipmentBindings', type: 'json', required: false, value: '${character_lookup.equipmentBindings}'},
    ].reduce(ensure, params)
  }
  const nodes = workflow.nodes.map(node => node.id === 'sanguo-input' ? { ...node, params: inputParams(node.params ?? []) }
    : node.id === 'sanguo-scene-outline' ? { ...node, prompt: refreshCharacterVisualPrompt(node.prompt, 'outline') }
    : node.id === 'sanguo-shot-script' ? { ...node, prompt: refreshCharacterVisualPrompt(node.prompt, 'storyboard') }
      : node.id === 'sanguo-character-lookup' && node.code?.includes('character_lookup_result')
        && (!knownLegacyCodeOnly || legacyManagedCodeFingerprint(node.code) === '5451:6bc54f3c') ? { ...node, code: SANGUO_CHARACTER_LOOKUP_CODE }
        : node.id === 'sanguo-first-frame-branch' && node.code?.includes('const referenceBindings = orderedNames.map')
          && (!knownLegacyCodeOnly || legacyManagedCodeFingerprint(node.code) === '10173:f69ad5a5') ? { ...node, code: SANGUO_FIRST_FRAME_BRANCH_CODE }
          : node.id === 'sanguo-video' && Array.isArray(node.params) ? { ...node, params: videoParams(node.params) } : node)
  return JSON.stringify(nodes) === JSON.stringify(workflow.nodes) && (workflow.schemaVersion ?? 0) >= 151 ? workflow
    : { ...workflow, nodes, schemaVersion: Math.max(151, workflow.schemaVersion ?? 0) }
}

/** Production schema 153 gets a one-time, code-fingerprint-gated asset edit.
 * A second hydration preserves editor changes and separate policy migrations. */
export function upgradePersistedSanguoCharacterWorkflow<
  N extends {id: string; prompt: string; code?: string; params?: Array<{id?: string;name?: string;englishName?: string;type?: string;required?: boolean;value?: string}>},
  W extends {id: string; schemaVersion?: number; nodes: N[]},
>(workflow: W, upgradeLegacy: (workflow: W) => W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 153) return upgradeLegacy(workflow)
  if ((workflow.schemaVersion ?? 0) >= 154) return workflow
  return { ...upgradeCharacterVisualWorkflow(workflow, true), schemaVersion: 154 }
}
