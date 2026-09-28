import { refreshSanguoContextBoundaryCode } from './episode-boundary.ts'

export const DEFAULT_CODE_NODE_SCRIPT = `// 可用变量：\${变量路径} 占位符、context、files，以及 context 中合法的顶层变量。
// Excel API：excel.parse(files[0], { sheetName: '工作表名', headerRow: 1, outputLimit: 500 })
// 返回对象中的 contextPatch 会合并进后续流程上下文。

return {
  message: '代码节点执行成功',
  fileNames: files.map((file) => file.name),
  contextPatch: {},
}`

export const SANGUO_CHARACTER_LOOKUP_CODE = `// 通过占位符直接读取短分镜人物和系统人物库查询结果，不配置节点入参字段。
const characters = \${shot_script.characters}
const firstFramePrompt = String(\${shot_script.firstFramePrompt} || '')
const visualPrompt = String(\${shot_script.visualPrompt} || '')
const lastFramePrompt = String(\${shot_script.lastFramePrompt} || '')
const lookupResult = \${character_lookup_result}
const names = Array.isArray(characters)
  ? [...new Set(characters.map((name) => String(name).trim()).filter(Boolean))]
  : []
const lookup = lookupResult && typeof lookupResult === 'object' ? lookupResult : {}
const existingAssets = Array.isArray(lookup.items) ? lookup.items : []
const equipmentBindings = Array.isArray(lookup.equipmentBindings) ? lookup.equipmentBindings : []
const equipmentByCharacter = lookup.equipmentByCharacter && typeof lookup.equipmentByCharacter === 'object' ? lookup.equipmentByCharacter : {}
const existingNames = new Set(existingAssets.map((item) => String(item.characterName || item.name || '')).filter(Boolean))
const existingImages = existingAssets
  .map((item) => String(item.url || item.uri || '').trim())
  .filter(Boolean)
const lookupMissing = Array.isArray(lookup.missingCharacters) ? lookup.missingCharacters : []
// 后入场人物通常不会出现在首帧描述里，必须从尾帧回收其稳定外貌；
// 否则虽然会生成三视图，提示词却只有姓名，无法锁定跨镜身份。
const promptSentences = (firstFramePrompt + '。' + visualPrompt + '。' + lastFramePrompt)
  .split(/[。！？；;\\n]+/)
  .map((item) => item.trim())
  .filter(Boolean)
const stableDescription = (name) => {
  const appearanceCue = /(?:\\d{1,3}岁|十余岁|青年|中年|老年|男子|女子|男性|女性|面色|脸|面容|五官|颧骨|肤色|发|须|体型|身形|瘦削|魁梧|衣|袍|褂|衫|短褐|麻布|头戴|冠|巾|鞋|靴)/
  const transientCue = /(?:念咒|诵咒|施术|动作|刚完成|口唇|嘴唇|开口|闭口|微合|微张|紧闭|抬手|举手|手指|手掌|双手|右手|左手|手持|握住|遮挡|挡住|靠近|贴近|跪|坐|卧|躺|行走|走入|仰起|低垂|转向|望向|看向|注视|画面|前景|背景|中景)/
  const stableOnly = (value) => value.split(/[，,]/)
    .map((part) => {
      const trimmed = part.trim()
      const transientIndex = trimmed.search(transientCue)
      return transientIndex < 0 ? trimmed : trimmed.slice(0, transientIndex).trim()
    })
    .filter((part) => appearanceCue.test(part) && !transientCue.test(part))
    .join('，')
  for (const source of [visualPrompt, firstFramePrompt, lastFramePrompt]) {
    const start = source.indexOf(name + '（')
    const end = start < 0 ? -1 : source.indexOf('）', start)
    const enclosed = end > start ? source.slice(start + name.length + 1, end).replace(/^匹配[^：]*：/, '').trim() : ''
    const stableEnclosed = stableOnly(enclosed)
    if (stableEnclosed.length >= 4) return stableEnclosed.slice(0, 220)
  }
  const matches = promptSentences.filter((sentence) => sentence.includes(name))
  if (!matches.length) return ''
  // Prefer a clause dedicated to this role. Wide visual prompts often contain
  // every actor in one long sentence; feeding that sentence into one person's
  // portrait request makes the image model reproduce the whole scene/cast.
  const isolated = matches.filter((sentence) => !names.some((other) => other !== name && sentence.includes(other)))
  const candidates = isolated.length ? isolated : matches
  const chosen = candidates.sort((left, right) => {
    const bySubjectPosition = left.indexOf(name) - right.indexOf(name)
    return bySubjectPosition || right.length - left.length
  })[0]
  // An action-only clause is not an identity fallback. Returning it used to
  // turn “口唇微合，念咒动作刚完成” into a permanent three-view pose.
  return stableOnly(chosen).slice(0, 220)
}
const missingCharacters = lookupMissing.map((item) => {
  const name = String(item.name || item.characterName || '').trim()
  const description = [stableDescription(name), String(item.visualDesignText || '')].filter(Boolean).join('。')
  return {
    ...item,
    name,
    continuityKey: String(item.continuityKey || name + '-eastern-han-v1'),
    description,
    designPrompt: [
      '东汉末年人物定妆三视图，角色：' + name,
      description ? '身份与稳定外观：' + description : '',
      '同一个人物按正面、标准90度侧面、背面顺序各出现一次，三种角度必须保持同一张脸、相同年龄、发式、体型和整套服装',
      '只输出一张16:9横向画布，只能单行三列水平排列：左侧正面、中间标准90度侧面、右侧背面；三个人物完整全身、等高等比例、互不遮挡',
      '真人历史电影质感，服饰材质考据准确，三个视角均直立且双臂自然下垂，双手低于腰部并远离脸和胸口，嘴鼻眼下巴完全无遮挡，纯色背景，无文字无水印；身份描述中的坐姿、桌案、室内陈设和镜头景别只用于辨认人物，不得带入三视图',
      '禁止念咒、指唇、掩嘴、托腮、持物、结印、挥手或任何剧情动作',
      '严禁上下结构、上下两排、2×2宫格、九宫格、分镜板、重复视角、第二个正面、半身或坐姿',
    ].filter(Boolean).join('。'),
  }
}).filter((item) => item.name)
const shouldGenerate = missingCharacters.length > 0
const imagePrompt = shouldGenerate
  ? [
      '为以下缺失人物生成可复用的东汉末年定妆三视图：',
      missingCharacters.map((item, index) => (index + 1) + '. ' + item.designPrompt).join('\\n'),
      '每个人物都必须按正面、侧面、背面顺序在一张16:9横向画布中单行三列呈现，绝不允许上下结构或宫格；三种角度保持同一身份、脸部、发式、体型和服装；保持真人历史电影质感、考据准确、纯色背景，不生成文字或水印。',
    ].join('\\n')
  : ''

return {
  characters: names.map((name) => {
    const generated = missingCharacters.find((item) => item.name === name)
    const lookedUp = Array.isArray(lookup.characters) ? lookup.characters.find((item) => String(item.name || item.characterName || '') === name) : null
    return generated || lookedUp || { name }
  }),
  names,
  existingAssets,
  equipmentBindings,
  equipmentByCharacter,
  existingVoices: Array.isArray(lookup.existingVoices) ? lookup.existingVoices : [],
  voiceCharacters: Array.isArray(lookup.voiceCharacters) ? lookup.voiceCharacters.map((item) => missingCharacters.find((generated) => generated.name === item.name) || item) : [],
  existingImages,
  existingNames: [...existingNames],
  missingCharacters,
  foundCount: existingAssets.length,
  missingCount: missingCharacters.length,
  shouldGenerate,
  imageRequest: {
    prompt: imagePrompt,
    referenceImages: [],
    size: '1792x1024',
    aspectRatio: '16:9',
    n: Math.max(1, missingCharacters.length),
    requests: missingCharacters.map((item) => ({ characterName: item.name, prompt: item.designPrompt, n: 1 })),
  },
}`

const LEGACY_FIRST_FRAME_VIDEO_SCOPE = ": [visualPrompt, videoPrompt].filter(Boolean).join('\\n')"
const STATIC_FIRST_FRAME_VISUAL_SCOPE = `: [String(\${shot_script.firstFramePrompt} || visualPrompt).trim(),
    String(\${shot_script.camera} || '').trim() ? '构图视角参考（只描述单帧视角，不生成运镜过程）：' + String(\${shot_script.camera}).trim() : '',
  ].filter(Boolean).join('\\n')`

/** Replace only the known managed expression. Custom routing, reference
 * bindings and other authored code retain their exact text. */
export function refreshFirstFramePromptScope(code: string): string {
  if (code.split(LEGACY_FIRST_FRAME_VIDEO_SCOPE).length !== 2
    || !code.includes('const framePrompt = animationStyle') || !code.includes('backgroundOnlyPrompt')) return code
  return code.replace(LEGACY_FIRST_FRAME_VIDEO_SCOPE, STATIC_FIRST_FRAME_VISUAL_SCOPE)
}

const mapPortraitSource = 'const declaredEnteringCharacters = ' + '$' + '{shot_script.enteringCharacters}'
const mapPortraitInsert = [
  'const portraitLayers = ' + '$' + '{shot_script.illustrationLayers}',
  "const mapPortraitLayers = animationStyle === 'historical_map' && Array.isArray(portraitLayers) ? portraitLayers : []",
  "const mapPortraitNames = mapPortraitLayers.map((layer) => String(layer?.characterName || '').trim())",
  "if (mapPortraitLayers.length && (mapPortraitNames.some((name) => !name) || new Set(mapPortraitNames).size !== mapPortraitNames.length)) {",
  "  throw new Error('MAP_PORTRAIT_BINDING_INVALID: 地图肖像图层须逐一绑定不同的具名人物')",
  '}',
].join('\n') + '\n'

/** Upgrade only known branch code. The map plate must not bake in portrait
 * figures; the selected still artwork is added after the map video is made. */
export function refreshMapPortraitBackgroundCode(code: string): string {
  const frameReferences = 'const frameReferenceImages = isStaticIllustration ? [] : referenceImages'
  const oldBranch = "  ? [backgroundOnlyPrompt || '符合当前时代与地点的历史环境背景', '只生成历史环境背景底板，不画具名人物，不画人物卡片，不画三视图，不预留巨型人像'].join('。')\n  "
  if (!code.includes("const framePrompt = animationStyle === 'character_illustration'") || !code.includes(frameReferences)
    || code.split(mapPortraitSource).length !== 2 || code.split(oldBranch).length !== 2) return code
  return code.replace(mapPortraitSource, mapPortraitInsert + mapPortraitSource)
    .replace(frameReferences, 'const frameReferenceImages = isStaticIllustration || mapPortraitLayers.length ? [] : referenceImages')
    .replace(oldBranch, oldBranch + ": mapPortraitLayers.length\n    ? [backgroundOnlyPrompt || '符合本镜已批准地理范围的古代历史地理地图', '只生成古代历史地理地图底板及获批准的山川、城址、边界与路线，不画任何人物、人物卡片或肖像；后期叠加已绑定的静态人物图层'].join('。')\n  ")
}

const MAP_PORTRAIT_FRAME_BRANCH = ": mapPortraitLayers.length\n    ? [backgroundOnlyPrompt || '符合本镜已批准地理范围的古代历史地理地图', '只生成古代历史地理地图底板及获批准的山川、城址、边界与路线，不画任何人物、人物卡片或肖像；后期叠加已绑定的静态人物图层'].join('。')\n  "
const MAP_BARE_PLATE_FRAME_BRANCH = ": animationStyle === 'historical_map'\n    ? historicalMapPlatePrompt\n  "
const MAP_BARE_PLATE_PROMPT_CODE = [
  "const mapGeographyPrompt = [String(" + '$' + "{shot_script.firstFramePrompt} || ''), visualPrompt]",
  '  .flatMap((part) => part.split(/[。！？；;\\n]+/))',
  '  .map((part) => part.trim())',
  "  .filter((part) => part && !characterNames.some((name) => part.includes(name))",
  '    && !/沙盘|盘框|棋子|玩具|微缩|模型|桌面|三维|肖像|人物|头像|兵偶|军|兵|部队|人马|追|逃|撤|退|攻|战|对峙|奔赴|抵达|箭头|路线|路径|轨迹|标记|标注|文字|字幕|标题|水印|伪字|乱码|旗帜|势力/.test(part))',
  "  .join('。')",
  "const historicalMapPlatePrompt = [mapGeographyPrompt || '本镜已批准地理范围内的古代历史地理地图',",
  "  '二维手绘古代历史地理地图，全画幅宣纸墨线设色，北向稳定；清楚绘制山川、水系、道路、城址和地域边界',",
  "  '只生成无字、无箭头、无人物的地形底图；不得烘焙地名、伪字、字幕、路线线条、势力标记、头像、肖像、盘框、微缩兵偶或玩具城堡；获批准的路线、标记及静态肖像由后期叠加'].join('。')",
].join('\n') + '\n'

/** Upgrade the managed branch to a bare geography plate for every historical
 * map, including maps with no portraits. Authored custom code is untouched. */
export function refreshHistoricalMapBarePlateCode(code: string): string {
  const oldReferences = 'const frameReferenceImages = isStaticIllustration || mapPortraitLayers.length ? [] : referenceImages'
  if (code.split(MAP_PORTRAIT_FRAME_BRANCH).length !== 2
    || code.split('const framePrompt = animationStyle === \'character_illustration\'').length !== 2
    || code.split(oldReferences).length !== 2) return code
  return code
    .replace(oldReferences, "const frameReferenceImages = isStaticIllustration || animationStyle === 'historical_map' ? [] : referenceImages")
    .replace(MAP_PORTRAIT_FRAME_BRANCH, MAP_BARE_PLATE_FRAME_BRANCH)
    .replace("const framePrompt = animationStyle === 'character_illustration'", MAP_BARE_PLATE_PROMPT_CODE + "const framePrompt = animationStyle === 'character_illustration'")
}

export const SANGUO_FIRST_FRAME_BRANCH_CODE = refreshHistoricalMapBarePlateCode(refreshMapPortraitBackgroundCode(`// 动态动画生成稳定首尾帧；人物插画生成背景底板，由系统编排静态人物图层。
const requestedMode = String(\${shot_script.firstFrameMode} || 'reference')
const visualTreatment = String(\${shot_script.visualTreatment} || '')
const animationStyle = String(\${shot_script.animationStyle} || (visualTreatment === 'animated_map' ? 'historical_map' : visualTreatment === 'historical_montage' ? 'historical_tableau' : ''))
const visualPrompt = String(\${shot_script.visualPrompt} || '').trim()
const videoPrompt = String(\${shot_script.videoPrompt} || '').trim()
const declaredEnteringCharacters = \${shot_script.enteringCharacters}
const previousLastFrame = String(\${loop.previous.last_frame.url} || '').trim()
const characterNames = \${character_lookup.names}
const existingAssets = \${character_lookup.existingAssets}
const existingImages = \${character_lookup.existingImages}
const generatedImages = \${character_assets}
const equipmentBindings = \${character_lookup.equipmentBindings}
const rawAssetSelections = \${input.characterAssetSelections}
let assetSelections = rawAssetSelections == null || rawAssetSelections === '' ? {} : rawAssetSelections
if (typeof assetSelections === 'string') {
  try { assetSelections = JSON.parse(assetSelections) }
  catch { throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: characterAssetSelections 必须是人物名到资产ID的JSON对象') }
}
if (!assetSelections || typeof assetSelections !== 'object' || Array.isArray(assetSelections)
  || Object.entries(assetSelections).some(([name, id]) => !name.trim() || name !== name.trim() || typeof id !== 'string' || !id.trim() || id !== id.trim())) {
  throw new Error('CHARACTER_VISUAL_SELECTION_INVALID: characterAssetSelections 必须是人物名到资产ID的JSON对象')
}
const shouldReusePreviousTail = requestedMode === 'reuse_previous_tail' && Boolean(previousLastFrame)
const isAnimatedShot = ['animated', 'animated_map', 'historical_montage'].includes(visualTreatment)
const isStaticIllustration = ['character_illustration', 'historical_tableau'].includes(animationStyle)
const shouldGenerateAnimatedFirstFrame = isAnimatedShot && requestedMode === 'reference'
const shouldGenerateAnimatedEndFrame = isAnimatedShot && !isStaticIllustration
const shouldGenerateAnimatedMapFrames = shouldGenerateAnimatedFirstFrame && animationStyle === 'historical_map'
if (requestedMode === 'reuse_previous_tail' && !previousLastFrame) {
  throw new Error('连续镜头缺少前一镜实际尾帧，已阻止静默降级；请从前一镜视频节点重试以重新提取尾帧')
}
const collectImageUrls = (value) => {
  if (typeof value === 'string') {
    const url = value.trim()
    return url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('/')) ? [url] : []
  }
  if (Array.isArray(value)) return value.flatMap(collectImageUrls)
  if (!value || typeof value !== 'object') return []
  const direct = ['url', 'image_url', 'dataUrl', 'data_url'].flatMap((key) => collectImageUrls(value[key]))
  const nested = ['items', 'urls', 'images'].flatMap((key) => collectImageUrls(value[key]))
  return [...direct, ...nested]
}
const assetItems = [
  ...(Array.isArray(existingAssets) ? existingAssets : []),
  ...(generatedImages && Array.isArray(generatedImages.items) ? generatedImages.items : []),
]
const byCharacter = new Map(assetItems.map((item) => [String(item.characterName || item.name || ''), item]))
const orderedNames = Array.isArray(characterNames) ? characterNames.map(String) : []
const referenceBindings = orderedNames.map((name) => {
  const selectedId = Object.prototype.hasOwnProperty.call(assetSelections, name) ? assetSelections[name] : ''
  // Loop archive items may contain a later same-name candidate. A selection
  // binds the exact sheet, so that candidate can never overwrite the lookup.
  const matching = selectedId ? assetItems.filter((item) => String(item.characterName || item.name || '') === name && item.id === selectedId) : []
  const asset = selectedId ? matching[0] : byCharacter.get(name)
  const url = collectImageUrls(asset)[0] || ''
  if (selectedId && (!asset || !url || new Set(matching.map((item) => collectImageUrls(item)[0] || '')).size !== 1)) {
    throw new Error('CHARACTER_VISUAL_SELECTION_MISMATCH: 所选人物三视图缺失、无可用图片或同ID图片冲突：' + name + '/' + selectedId + '；已阻止换用其他候选及付费生成')
  }
  return url ? { characterName: name, url, continuityKey: String(asset.metadata?.continuityKey || ''),
    ...(asset.id ? { assetId: String(asset.id) } : {}),
    equipment: Array.isArray(equipmentBindings) ? equipmentBindings.filter((item) => item && item.characterName === name) : [],
    ...(asset.visualContext || asset.metadata?.visualContext ? { visualContext: asset.visualContext || asset.metadata.visualContext, visualProfile: asset.metadata?.visualProfile } : {}) } : null
}).filter(Boolean)
const fallbackReferenceImages = [...new Set([
  ...collectImageUrls(existingImages),
  ...collectImageUrls(generatedImages),
])]
const resolvedReferenceImages = referenceBindings.length
  ? referenceBindings.map((binding) => binding.url)
  : fallbackReferenceImages
const enteringCharacters = Array.isArray(declaredEnteringCharacters) ? declaredEnteringCharacters : []
const enteringByName = new Map(enteringCharacters
  .filter((item) => item && typeof item === 'object')
  .map((item) => [String(item.name || ''), item]))
const enteringNames = new Set([...enteringByName.keys()].filter(Boolean))
// Keep the real first frame for layout and full-view identities for clothing
// during turns. Entrants have priority within the two-sheet / six-image budget.
const selectedBindings = shouldReusePreviousTail
  ? [...referenceBindings.filter((binding) => enteringNames.has(binding.characterName)),
      ...referenceBindings.filter((binding) => !enteringNames.has(binding.characterName))].slice(0, 2)
  : referenceBindings
for (const name of orderedNames.filter((name) => Object.prototype.hasOwnProperty.call(assetSelections, name))) {
  if (!selectedBindings.some((binding) => binding.characterName === name && binding.assetId === assetSelections[name])) {
    throw new Error('CHARACTER_VISUAL_SELECTION_MISMATCH: 所选人物 ' + name + ' 超出当前身份参考容量；请拆分镜头，不能静默丢弃指定三视图')
  }
}
if (shouldReusePreviousTail && selectedBindings.filter((binding) => enteringNames.has(binding.characterName)).length !== enteringNames.size) {
  const available = new Set(selectedBindings.map((binding) => binding.characterName))
  const missing = [...enteringNames].filter((name) => !available.has(name))
  throw new Error('入场人物缺少三视图资产：' + missing.join('、') + '；已阻止无身份参考的视频生成')
}
const referenceImages = selectedBindings.length
  ? selectedBindings.map((binding) => binding.url)
  : shouldReusePreviousTail ? [] : resolvedReferenceImages
// Kling can expand at most two complete three-view sheets (six angle images).
// Larger casts retain one frontal identity image derived from every master sheet,
// so no character—especially a later entrant—is silently dropped.
const referenceMode = referenceImages.length
  ? referenceImages.length <= 2 ? 'three-view-all' : 'three-view-front'
  : ''
const frameReferenceImages = isStaticIllustration ? [] : referenceImages
// A character-illustration first frame is only a background plate. Keep
// generic crowds and historical scenery, but remove sentences that describe a
// named character or layer motion so old accepted shots cannot bake the same
// identity into the background before the compositor adds its card.
const backgroundOnlyPrompt = visualPrompt.split(/[。！？；;]+/)
  .flatMap((sentence) => sentence.split(String.fromCharCode(10)))
  .map((sentence) => sentence.trim())
  .filter((sentence) => sentence
    && !characterNames.some((name) => sentence.includes(name))
    && !/^(?:身穿|穿着|穿|头戴|戴着|留有|留着|黑发|白发|灰发|面容|脸部|五官|腰束|脚穿)/.test(sentence))
  .map((sentence) => sentence.replace(/人物插画/g, '背景画面'))
  .join('。')
const framePrompt = animationStyle === 'character_illustration'
  ? [backgroundOnlyPrompt || '符合当前时代与地点的历史环境背景', '只生成历史环境背景底板，不画具名人物，不画人物卡片，不画三视图，不预留巨型人像'].join('。')
  ${STATIC_FIRST_FRAME_VISUAL_SCOPE}
return {
  requestedMode,
  visualTreatment,
  animationStyle,
  previousLastFrame,
  shouldGenerate: shouldGenerateAnimatedFirstFrame,
  isAnimatedShot,
  isStaticIllustration,
  shouldGenerateAnimatedFirstFrame,
  shouldGenerateAnimatedEndFrame,
  shouldGenerateAnimatedMapFrames,
  shouldReusePreviousTail,
  route: shouldReusePreviousTail ? 'reuse_previous_tail' : shouldGenerateAnimatedFirstFrame ? 'animated_boundary_frames' : 'reference',
  fallbackReason: '',
  referenceRequest: {
    referenceImages,
    referenceBindings: selectedBindings.map(({ characterName, assetId, continuityKey, visualContext, visualProfile, equipment }) => ({
      characterName,
      ...(assetId ? { assetId } : {}),
      continuityKey,
      ...(visualContext ? { visualContext, metadata: { visualContext, visualProfile } } : {}),
      ...(equipment?.length ? { equipment } : {}),
      role: enteringByName.has(characterName) ? 'entering' : 'identity',
      ...(enteringByName.has(characterName) ? { entrance: enteringByName.get(characterName) } : {}),
    })),
    referenceMode,
  },
  frameReferenceImages,
  framePrompt,
}`))

export const SANGUO_REUSE_TAIL_CODE = `// 通过占位符直接读取首帧分支选定的前镜尾帧。
const url = String(\${first_frame_branch.previousLastFrame} || '').trim()
if (!url) throw new Error('首帧图截取尾帧节点未收到可用的前镜尾帧')
return {
  url,
  requestedMode: 'reuse_previous_tail',
  resolvedMode: 'reuse_previous_tail',
  generated: false,
  source: 'previous-shot-tail',
}`

export const SANGUO_TAIL_FRAME_CODE = `// 使用视频模型返回或系统从成片提取的实际尾帧，供下一镜复用。
const videoResult = \${video_shot}
const video = videoResult && typeof videoResult === 'object' ? videoResult : {}
const imageUrl = (value) => {
  if (typeof value === 'string') {
    const url = value.trim()
    return url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/') || url.startsWith('/')) ? url : ''
  }
  if (Array.isArray(value)) return value.map(imageUrl).find(Boolean) || ''
  if (!value || typeof value !== 'object') return ''
  for (const key of ['url', 'image_url', 'imageUrl', 'dataUrl', 'data_url']) {
    const found = imageUrl(value[key])
    if (found) return found
  }
  return ''
}
const tailKeys = new Set([
  'lastFrameUrl', 'last_frame_url', 'lastFrame', 'last_frame',
  'extractedLastFrameUrl', 'extracted_last_frame_url',
  'tailFrameUrl', 'tail_frame_url', 'tailFrame', 'tail_frame',
])
const findTail = (value) => {
  if (!value || typeof value !== 'object') return ''
  for (const [key, child] of Object.entries(value)) {
    if (tailKeys.has(key)) {
      const found = imageUrl(child)
      if (found) return found
    }
  }
  for (const child of Object.values(value)) {
    const found = findTail(child)
    if (found) return found
  }
  return ''
}
const modelTail = findTail(video)
return {
  url: modelTail,
  available: Boolean(modelTail),
  source: modelTail ? (video.extractedLastFrameUrl ? 'extracted-from-video' : 'video-model-output') : 'unavailable',
  warning: modelTail ? '' : '视频模型未返回尾帧且系统未能从成片提取；连续下一镜将被阻止，禁止静默自由开场。',
}`

export const SANGUO_CONTEXT_INIT_CODE = refreshSanguoContextBoundaryCode(`// 1. 解析附件。excel.parse 是同步 API，不需要 await。
const parsed = excel.parse(files[0], {
  sheetName: '1000集总表',
  headerRow: 1,
  outputLimit: 5000,
})

// 2. 用输入节点的集数匹配 Excel “集数”列。
const episodeNumber = Number(input.episode_number)
const matchedIndex = parsed.rows.findIndex((item) => Number(item['集数']) === episodeNumber)
if (matchedIndex < 0) {
  throw new Error('Excel 中未找到第 ' + episodeNumber + ' 集')
}
const row = parsed.rows[matchedIndex]

// 3. 字段转换、默认值和派生字段都在这里配置。
const sourceText = String(row['主史料'] || '')
const sourceCatalog = [
  '后汉书', '三国志', '裴松之注', '晋书', '资治通鉴', '后汉纪', '华阳国志',
  '英雄记', '献帝春秋', '魏略', '魏书', '吴书', '江表传', '吴录', '曹瞒传',
  '山阳公载记', '汉晋春秋', '襄阳记', '云别传', '世说新语',
]
const sourceTitles = sourceCatalog.filter((title) => sourceText.includes('《' + title + '》') || sourceText.includes(title))
const verificationUrls = String(row['在线核查'] || '')
  .split(/[|｜\\n]+/)
  .map((url) => url.trim())
  .filter(Boolean)

const fields = {
  episode_number: Number(row['集数']),
  volume: row['分卷'],
  historical_period: row['历史时段'],
  episode_title: row['集名'],
  source_titles: sourceTitles,
  source_detail: row['具体篇目／卷次'],
  source_level: row['史料层级'],
  cross_reference: row['互证建议'],
  adaptation_policy: row['改编边界'],
  verification_urls: verificationUrls,
  aspect_ratio: '16:9',
}
const internetRequest = {
  query: [fields.episode_title, ...fields.source_titles, fields.source_detail, fields.cross_reference]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' '),
  urls: fields.verification_urls,
  maxSources: 3,
  maxPassages: 6,
}

console.info('已匹配第 ' + episodeNumber + ' 集：' + fields.episode_title)

// 4. contextPatch 控制写入流程实例上下文的位置。
return {
  workbook: parsed.workbook,
  sheet: parsed.sheet,
  matchedBy: {
    column: '集数',
    value: episodeNumber,
    rowNumber: parsed.rowNumbers[matchedIndex],
  },
  row,
  fields,
  internetRequest,
  contextPatch: {
    input: {
      ...input,
      ...fields,
    },
  },
}`)
