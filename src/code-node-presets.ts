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
const lookupResult = \${character_lookup_result}
const names = Array.isArray(characters)
  ? [...new Set(characters.map((name) => String(name).trim()).filter(Boolean))]
  : []
const lookup = lookupResult && typeof lookupResult === 'object' ? lookupResult : {}
const existingAssets = Array.isArray(lookup.items) ? lookup.items : []
const existingNames = new Set(existingAssets.map((item) => String(item.characterName || item.name || '')).filter(Boolean))
const existingImages = existingAssets
  .map((item) => String(item.url || item.uri || '').trim())
  .filter(Boolean)
const lookupMissing = Array.isArray(lookup.missingCharacters) ? lookup.missingCharacters : []
const promptSentences = (firstFramePrompt + '。' + visualPrompt).split(/[。！？\\n]+/).map((item) => item.trim()).filter(Boolean)
const stableDescription = (name) => {
  const index = promptSentences.findIndex((sentence) => sentence.includes(name))
  if (index < 0) return ''
  return promptSentences.slice(index, index + 2).join('；').slice(0, 320)
}
const missingCharacters = lookupMissing.map((item) => {
  const name = String(item.name || item.characterName || '').trim()
  const description = stableDescription(name)
  return {
    name,
    continuityKey: String(item.continuityKey || name + '-eastern-han-v1'),
    description,
    designPrompt: [
      '东汉末年人物定妆三视图，角色：' + name,
      description ? '身份与稳定外观：' + description : '',
      '同一个人物按正面、标准90度侧面、背面顺序各出现一次，三种角度必须保持同一张脸、相同年龄、发式、体型和整套服装',
      '只输出一张16:9横向画布，只能单行三列水平排列：左侧正面、中间标准90度侧面、右侧背面；三个人物完整全身、等高等比例、互不遮挡',
      '真人历史电影质感，服饰材质考据准确，中性站姿，纯色背景，无文字无水印；身份描述中的坐姿、桌案、室内陈设和镜头景别只用于辨认人物，不得带入三视图',
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

export const SANGUO_FIRST_FRAME_BRANCH_CODE = `// 普通镜头使用人物资产参考；仅在续接未完成镜头时复用前镜尾帧。
const requestedMode = String(\${shot_script.firstFrameMode} || 'reference')
const previousLastFrame = String(\${loop.previous.last_frame.url} || '').trim()
const characterNames = \${character_lookup.names}
const existingAssets = \${character_lookup.existingAssets}
const existingImages = \${character_lookup.existingImages}
const generatedImages = \${character_assets}
const shouldReusePreviousTail = requestedMode === 'reuse_previous_tail' && Boolean(previousLastFrame)
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
  const asset = byCharacter.get(name)
  const url = collectImageUrls(asset)[0] || ''
  return url ? { characterName: name, url, continuityKey: String(asset.metadata?.continuityKey || '') } : null
}).filter(Boolean)
const fallbackReferenceImages = [...new Set([
  ...collectImageUrls(existingImages),
  ...collectImageUrls(generatedImages),
])]
const referenceImages = referenceBindings.length
  ? referenceBindings.map((binding) => binding.url)
  : fallbackReferenceImages
return {
  requestedMode,
  previousLastFrame,
  shouldGenerate: false,
  shouldReusePreviousTail,
  route: shouldReusePreviousTail ? 'reuse_previous_tail' : 'reference',
  fallbackReason: requestedMode === 'reuse_previous_tail' && !previousLastFrame
    ? '前一镜没有可用尾帧，回退为人物资产参考生视频'
    : '',
  referenceRequest: {
    referenceImages,
    referenceBindings: referenceBindings.map(({ characterName, continuityKey }) => ({ characterName, continuityKey })),
    referenceMode: referenceImages.length ? 'three-view-all' : '',
  },
}`

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

export const SANGUO_TAIL_FRAME_CODE = `// 优先使用视频模型的实际尾帧；未返回时使用视频生成时传入的目标尾帧。
const videoResult = \${video_shot}
const video = videoResult && typeof videoResult === 'object' ? videoResult : {}
const targetEndFrame = String(\${end_frame.url} || '').trim()
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
const url = modelTail || targetEndFrame
return {
  url,
  available: Boolean(url),
  source: modelTail ? 'video-model-output' : targetEndFrame ? 'target-end-frame' : 'unavailable',
  warning: url ? '' : '视频模型未返回独立尾帧，且目标尾帧不可用；下一镜将使用人物资产参考图自由生成开场。',
}`

export const SANGUO_CONTEXT_INIT_CODE = `// 1. 解析附件。excel.parse 是同步 API，不需要 await。
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
  aspect_ratio: '9:16',
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
}`
