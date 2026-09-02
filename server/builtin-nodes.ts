import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { runLocalModel } from './local-model.ts'
import { retrieveInternetSources } from './web-sources.ts'
import type { InternetSourceResult } from './web-sources.ts'
import { validateThreeViewReference } from './image-references.ts'

export type BuiltinNodeRequest = {
  operation: string
  prompt?: string
  params?: Record<string, unknown>
  model?: {
    id: string
    provider: string
    capability: string
    settings: Record<string, string>
  }
  executionContext?: { workflowId?: string; workflowName?: string; nodeId?: string; nodeName?: string }
}

type MediaExecutor = (request: {
  model: NonNullable<BuiltinNodeRequest['model']>
  prompt: string
  params: Record<string, unknown>
  operation?: string
  executionContext?: BuiltinNodeRequest['executionContext']
}) => Promise<{ status: number; body: unknown }>

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && 'items' in value) return toArray((value as Record<string, unknown>).items)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch {
      return value.split(/[、，,\n]/).map((item) => item.trim()).filter(Boolean)
    }
  }
  return value === undefined || value === null || value === '' ? [] : [value]
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string' && (/^https?:\/\//.test(value) || value.startsWith('data:') || value.startsWith('/'))) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item)
      if (found) return found
    }
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = firstUrl(item)
      if (found) return found
    }
  }
  return ''
}

function mediaUrls(value: unknown): string[] {
  const urls: string[] = []
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      if (/^https?:\/\//.test(current) || current.startsWith('data:') || current.startsWith('/')) urls.push(current)
      return
    }
    if (Array.isArray(current)) return current.forEach(visit)
    if (current && typeof current === 'object') Object.values(current as Record<string, unknown>).forEach(visit)
  }
  visit(value)
  return [...new Set(urls)]
}

function characterIdentity(value: unknown) {
  if (typeof value === 'string') return { name: value, designPrompt: '' }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return {
      name: String(record.name ?? record.characterName ?? '').trim(),
      designPrompt: String(record.designPrompt ?? record.prompt ?? ''),
      continuityKey: String(record.continuityKey ?? ''),
      description: String(record.description ?? ''),
      historicalPortrait: record.historicalPortrait && typeof record.historicalPortrait === 'object'
        ? record.historicalPortrait as Record<string, unknown>
        : undefined,
    }
  }
  return { name: '', designPrompt: '' }
}

function isGenericCharacterName(name: string) {
  return /(?:无名|某人|众人|众将|百姓|饥民|村民|流民|难民|路人|士兵|兵士|军士|官军|汉军|黄巾军|亲兵|护卫|侍卫|仆从|随从|侍从|仆人|家丁|门客|弟子|信徒|使者|信使|官员|小吏|吏员|郡守|县令|族长|士人|商贩|医者|求评者|老者|老妇|妇人|孩童|少年|少女|农夫|农妇)$/.test(name)
}

export function shouldRetrieveHistoricalPortrait(name: string) {
  const normalized = name.trim()
  return Boolean(normalized)
    && normalized.length <= 12
    && !isGenericCharacterName(normalized)
    && !/^(?:一名|两名|几名|数名|多名|若干|一群|众|某)/.test(normalized)
}

const authoritativeHistoryTitle = /(?:三[國国]志|後漢書|后汉书|資治通鑑|资治通鉴|漢書|汉书)/
const nonHistoricalTitle = /(?:三[國国]演義|三国演义|評話|评话|小說|小说)/
const appearanceEvidence = /(?:身長|身长|長[七八九一二三四五六十百尺]|长[七八九一二三四五六十百尺]|容貌|姿貌|狀貌|状貌|形貌|體貌|体貌|美姿|雄姿|有姿儀|有姿仪|儀表|仪表|鬚髯|须髯|美髯|髯長|髯长|耳垂|耳大|目能自顧其耳|目能自顾其耳|垂手下膝|異相|异相|骨相|肥白|魁梧|雄壯|雄壮|短小|瘦弱)/

function normalizeHistoricalCharacters(value: string) {
  return value.replace(/[劉張關備紹許趙雲諸孫權馬義禮體長鬚顧見]/g, (character) => ({
    劉: '刘', 張: '张', 關: '关', 備: '备', 紹: '绍', 許: '许', 趙: '赵', 雲: '云', 諸: '诸', 孫: '孙', 權: '权', 馬: '马', 義: '义', 禮: '礼', 體: '体', 長: '长', 鬚: '须', 顧: '顾', 見: '见',
  }[character] ?? character))
}

function traditionalHistoricalName(value: string) {
  return value.replace(/[刘张关备绍许赵云诸孙权马义礼体长须顾见]/g, (character) => ({
    刘: '劉', 张: '張', 关: '關', 备: '備', 绍: '紹', 许: '許', 赵: '趙', 云: '雲', 诸: '諸', 孙: '孫', 权: '權', 马: '馬', 义: '義', 礼: '禮', 体: '體', 长: '長', 须: '鬚', 顾: '顧', 见: '見',
  }[character] ?? character))
}

const historicalSubjectAliases: Record<string, string[]> = {
  刘备: ['先主', '玄德', '昭烈帝'],
  刘禅: ['后主', '後主'],
  曹操: ['太祖', '武帝', '孟德'],
  曹丕: ['文帝', '子桓'],
  曹叡: ['明帝'],
  孙权: ['吳主', '吴主', '大帝', '仲謀', '仲谋'],
  孙坚: ['孫破虜', '孙破虏', '文臺', '文台'],
  孙策: ['孫討逆', '孙讨逆', '伯符'],
}

function mentionsHistoricalName(text: string, name: string) {
  const normalizedText = normalizeHistoricalCharacters(text)
  const normalizedName = normalizeHistoricalCharacters(name)
  if (normalizedText.includes(normalizedName)) return true
  if ((historicalSubjectAliases[name] ?? []).some((alias) => normalizedText.includes(normalizeHistoricalCharacters(alias)))) return true
  if (normalizedName.length < 2) return false
  return new RegExp([...normalizedName].join('.{0,8}')).test(normalizedText)
}

function portraitEvidenceFromSources(name: string, results: InternetSourceResult[]) {
  const citations = results.flatMap((result) => result.citations)
    .filter((citation) => authoritativeHistoryTitle.test(citation.title) && !nonHistoricalTitle.test(citation.title))
  const evidence: Array<{ title: string; url: string; quote: string }> = []
  for (const citation of citations) {
    const sentences = citation.content.split(/(?<=[。！？；])/).map((item) => item.trim()).filter(Boolean)
    sentences.forEach((sentence, index) => {
      if (!appearanceEvidence.test(sentence)) return
      const previous = sentences[index - 1] ?? ''
      if (!mentionsHistoricalName(sentence, name) && !mentionsHistoricalName(previous, name)) return
      const quote = sentence.slice(0, 240)
      if (!evidence.some((item) => item.quote === quote)) evidence.push({ title: citation.title, url: citation.url, quote })
    })
  }
  return evidence.slice(0, 4)
}

type PortraitRetriever = (input: Parameters<typeof retrieveInternetSources>[0]) => Promise<InternetSourceResult>

export async function enrichCharactersWithHistoricalPortraits(
  values: unknown[],
  retriever: PortraitRetriever = retrieveInternetSources,
  limits: { maxSources?: number; maxPassages?: number } = {},
) {
  const characters = values.map(characterIdentity).filter((item) => item.name)
  const enriched = await Promise.all(characters.map(async (character) => {
    if (!shouldRetrieveHistoricalPortrait(character.name)) {
      return { ...character, historicalPortrait: { status: 'skipped', reason: '群演或职能型小人物，不进行互联网体貌检索', citations: [] } }
    }
    const results: InternetSourceResult[] = []
    const failures: string[] = []
    for (const source of ['三國志', '後漢書']) {
      try {
        results.push(await retriever({
          query: traditionalHistoricalName(character.name),
          sourceNames: [source],
          titlePrefixes: [`${source}/`],
          maxSources: limits.maxSources ?? 2,
          maxPassages: limits.maxPassages ?? 4,
        }))
      } catch (error) {
        failures.push(`${source}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const citations = portraitEvidenceFromSources(character.name, results)
    const historicalPortrait = citations.length
      ? { status: 'found', description: citations.map((item) => item.quote).join('；'), citations, failures }
      : { status: 'not_found', description: '', citations: [], failures, reason: '未检索到可归属于该人物的可靠正史体貌记载' }
    const historicalInstruction = citations.length
      ? `正史体貌依据（仅采用下列有来源记载）：${historicalPortrait.description}`
      : '正史未检索到可靠体貌记载；按其时代、身份与年龄作克制的写实设计，不套用《三国演义》脸谱，不把艺术设定表述为史实'
    return {
      ...character,
      historicalPortrait,
      designPrompt: [character.designPrompt, historicalInstruction].filter(Boolean).join('。'),
    }
  }))
  return {
    characters: enriched,
    byCharacter: Object.fromEntries(enriched.map((item) => [item.name, item.historicalPortrait])),
    requestedCount: characters.length,
    retrievedCount: enriched.filter((item) => item.historicalPortrait.status !== 'skipped').length,
    foundCount: enriched.filter((item) => item.historicalPortrait.status === 'found').length,
    skippedCount: enriched.filter((item) => item.historicalPortrait.status === 'skipped').length,
  }
}

function requestedContinuityKey(character: ReturnType<typeof characterIdentity>, params: Record<string, unknown>) {
  if (character.continuityKey) return character.continuityKey
  if (!isGenericCharacterName(character.name)) return `${character.name}-eastern-han-v1`
  const episode = String(params.episodeNumber ?? params.episode_number ?? 'unknown').padStart(3, '0')
  const scene = String(params.sceneId ?? params.scene_id ?? 'scene')
  return `ep${episode}-${scene}-${character.name}-v2`
}

export function buildThreeViewGenerationPrompt(character: ReturnType<typeof characterIdentity>, retryReason = '') {
  const identityDescription = character.designPrompt
    || `东汉末年人物定妆三视图，${character.name}，真人历史电影质感，服化道准确。`
  return [
    identityDescription,
    '【三视图输出硬性版式】只输出一张 16:9 横向人物设定图。画布内必须恰好出现同一个人物三次，并且只能排成从左到右的单行三列：左列正面，中列标准90度侧面，右列背面。三个人物必须完整全身、头脚不裁切、等高等比例、互不遮挡，脸、年龄、体型、发式、冠帽和整套服装完全一致。',
    '身份描述中如果含有坐姿、桌案、房间、灯具、窗户或镜头景别，只提取人物身份与稳定外观，禁止复现这些场景、动作和道具；统一改为纯色摄影棚背景与中性站姿。',
    '禁止上下结构、上下两排、2×2宫格、九宫格、分镜板、重复视角、第二个正面、半身像、坐姿、环境场景、文字、标签、边框和水印。',
    retryReason ? `【上一次结果已被程序拒绝，必须纠正】${retryReason}` : '',
  ].filter(Boolean).join('\n')
}

function storedCharacterAsset(row: Record<string, unknown>) {
  return {
    id: row.id,
    workflowId: row.workflow_id ?? null,
    characterName: row.character_name,
    assetType: row.asset_type,
    url: row.uri,
    prompt: row.prompt,
    description: row.prompt,
    version: row.version,
    metadata: row.metadata,
    cached: true,
  }
}

async function lookupCharacterAssets(pool: Pool, request: BuiltinNodeRequest) {
  const params = request.params ?? {}
  const identities = toArray(params.characters ?? params.names).map(characterIdentity).filter((item) => item.name)
  const characters = [...new Map(identities.map((item) => [item.name, {
    ...item,
    continuityKey: requestedContinuityKey(item, params),
  }])).values()]
  if (!characters.length) {
    return { characters: [], names: [], items: [], urls: [], byCharacter: {}, descriptions: {}, missingCharacters: [], foundCount: 0, missingCount: 0 }
  }
  const workflowId = String(params.workflowId ?? '').trim()
  const result = await pool.query(
    `select id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, created_at, updated_at
       from character_assets
      where character_name = any($1::text[]) and asset_type = 'three-view'
        and ($2 = '' or workflow_id = $2 or workflow_id is null)
      order by character_name, (workflow_id = $2) desc, updated_at desc`,
    [characters.map((item) => item.name), workflowId],
  )
  const candidatesByName = new Map<string, Record<string, unknown>[]>()
  result.rows.forEach((row) => {
    const name = String(row.character_name)
    candidatesByName.set(name, [...(candidatesByName.get(name) ?? []), storedCharacterAsset(row)])
  })
  const byName = new Map<string, Record<string, unknown>>()
  characters.forEach((character) => {
    const candidates = candidatesByName.get(character.name) ?? []
    const exact = candidates.find((candidate) => {
      const metadata = candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata as Record<string, unknown> : {}
      return metadata.continuityKey === character.continuityKey
    })
    const selected = exact ?? (!isGenericCharacterName(character.name) ? candidates[0] : undefined)
    if (selected) byName.set(character.name, selected)
  })
  const items = characters.map((character) => byName.get(character.name)).filter(Boolean)
  const missingCharacters = characters.filter((character) => !byName.has(character.name))
  return {
    characters,
    names: characters.map((item) => item.name),
    items,
    urls: items.map((item) => String(item?.url ?? '')).filter(Boolean),
    byCharacter: Object.fromEntries(items.map((item) => [String(item?.characterName), item])),
    descriptions: Object.fromEntries(items.map((item) => [String(item?.characterName), String(item?.description ?? item?.prompt ?? '')])),
    missingCharacters,
    foundCount: items.length,
    missingCount: missingCharacters.length,
  }
}

async function ensureCharacterAssets(pool: Pool, request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor) {
  const params = request.params ?? {}
  const characters = toArray(params.characters ?? params.names).map(characterIdentity).filter((item) => item.name)
  const allCharacters = toArray(params.allCharacters).map(characterIdentity).filter((item) => item.name)
  const existingAssets = toArray(params.existingAssets).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
  const suppliedByName = new Map<string, Record<string, unknown>>()
  existingAssets.forEach((item) => {
    const name = String(item.characterName ?? item.name ?? '')
    if (name) suppliedByName.set(name, item)
  })
  if (!characters.length) {
    if (params.allowEmpty === true || params.allowEmpty === 'true') {
      const items = (allCharacters.length ? allCharacters : []).map((character) => suppliedByName.get(character.name)).filter(Boolean)
      return {
        items,
        urls: items.map((item) => String(item?.url ?? '')).filter(Boolean),
        byCharacter: Object.fromEntries(items.map((item) => [String(item?.characterName ?? item?.name), item])),
        generated: [],
        generatedCount: 0,
        cachedCount: items.length,
        count: items.length,
      }
    }
    throw new Error('角色资产节点未收到 characters/names')
  }
  const names = characters.map((item) => item.name)
  const workflowId = String(params.workflowId ?? '').trim()
  const stored = await pool.query(
    `select id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, created_at, updated_at
       from character_assets
      where character_name = any($1::text[]) and asset_type = 'three-view'
        and ($2 = '' or workflow_id = $2 or workflow_id is null)
      order by (workflow_id = $2) desc, updated_at desc`,
    [names, workflowId],
  )
  const byName = new Map<string, Record<string, unknown>>(suppliedByName)
  stored.rows.forEach((row) => {
    if (byName.has(row.character_name)) return
    const character = characters.find((item) => item.name === row.character_name)
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {}
    const requestedKey = character ? requestedContinuityKey(character, params) : ''
    if (requestedKey && metadata.continuityKey !== requestedKey) return
    byName.set(row.character_name, storedCharacterAsset(row))
  })
  const generated: Record<string, unknown>[] = []
  for (const character of characters) {
    if (byName.has(character.name)) continue
    const designPrompt = character.designPrompt || `东汉末年人物三视图，${character.name}，真人历史电影质感，正面、侧面、背面，服化道准确，纯色背景，无文字无水印。`
    let generatedBody: unknown
    let uri = ''
    let quality: unknown
    const shouldValidate = params.validateThreeView === true || params.validateThreeView === 'true'
    const maxAttempts = shouldValidate ? Math.max(1, Number(params.maxGenerationAttempts ?? 2)) : 1
    let lastValidationError = ''
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const generationPrompt = buildThreeViewGenerationPrompt(character, lastValidationError)
      if (request.model?.provider === 'Local' || !executeMediaModel || !request.model) {
        generatedBody = runLocalModel({ capability: 'image', operation: 'character.three-view', prompt: generationPrompt, params: { characterName: character.name } })
      } else {
        const response = await executeMediaModel({
          model: request.model,
          prompt: generationPrompt,
          params: {
            aspectRatio: '16:9',
            n: 1,
            characterName: character.name,
            negativePrompt: '正方形画布，竖版画布，上下结构，上下两排，2x2宫格，九宫格，分镜板，重复人物，重复视角，坐姿，半身，裁切，桌案，室内场景，文字，标签，水印',
          },
          operation: 'character.three-view',
          executionContext: request.executionContext,
        })
        if (response.status >= 400) throw new Error(`角色 ${character.name} 三视图生成失败：${JSON.stringify(response.body)}`)
        generatedBody = response.body
      }
      uri = firstUrl(generatedBody)
      if (!uri) throw new Error(`角色 ${character.name} 三视图未返回可用 URL`)
      if (!shouldValidate || request.model?.provider === 'Local') break
      try {
        quality = await validateThreeViewReference(uri)
        lastValidationError = ''
        break
      } catch (error) {
        lastValidationError = error instanceof Error ? error.message : String(error)
        uri = ''
      }
    }
    if (!uri && lastValidationError) throw new Error(`角色 ${character.name} 三视图质量检查失败：${lastValidationError}`)
    if (!uri) throw new Error(`角色 ${character.name} 三视图未返回可用 URL`)
    const assetScope = workflowId || 'global'
    const continuityKey = character.continuityKey || `${character.name}-eastern-han-v1`
    const id = `character-${createHash('sha1').update(`${assetScope}:${continuityKey}:three-view`).digest('hex').slice(0, 16)}`
    const metadata = {
      continuityKey,
      generatedBy: request.model?.id ?? 'local-image-simulator',
      quality,
      description: character.description,
      historicalPortrait: character.historicalPortrait,
    }
    await pool.query(
      `
        insert into character_assets (id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, updated_at)
        values ($1, $2, $3, 'three-view', $4, $5, 1, $6::jsonb, now())
        on conflict (id) do update set workflow_id = excluded.workflow_id, uri = excluded.uri, prompt = excluded.prompt, metadata = excluded.metadata, updated_at = now()
      `,
      [id, workflowId || null, character.name, uri, designPrompt, JSON.stringify(metadata)],
    )
    const item = { id, workflowId: workflowId || null, characterName: character.name, assetType: 'three-view', url: uri, prompt: designPrompt, version: 1, metadata, cached: false }
    byName.set(character.name, item)
    generated.push(item)
  }
  const requestedOrder = allCharacters.length ? allCharacters : characters
  const items = requestedOrder.map((character) => byName.get(character.name)).filter(Boolean)
  return {
    items,
    urls: items.map((item) => String(item?.url ?? '')).filter(Boolean),
    byCharacter: Object.fromEntries(items.map((item) => [String(item?.characterName), item])),
    generated,
    generatedCount: generated.length,
    cachedCount: items.length - generated.length,
    count: items.length,
  }
}

async function archiveCharacterAssets(pool: Pool, request: BuiltinNodeRequest) {
  const params = request.params ?? {}
  const characters = toArray(params.characters).map(characterIdentity).filter((item) => item.name)
  if (!characters.length) throw new Error('人物资产归档节点未收到 characters')
  const generatedValue = params.generatedAssets ?? params.images
  const structuredItems = toArray(generatedValue).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
  const structuredByName = new Map(structuredItems
    .map((item) => [String(item.characterName ?? item.name ?? ''), item] as const)
    .filter(([name]) => Boolean(name)))
  const legacyUrls = structuredByName.size ? [] : mediaUrls(generatedValue)
  const workflowId = String(params.workflowId ?? '').trim()
  if (!workflowId) throw new Error('人物资产归档缺少 workflowId')
  const items: Record<string, unknown>[] = []
  for (const [index, character] of characters.entries()) {
    const generated = structuredByName.get(character.name)
    const uri = generated ? firstUrl(generated) : legacyUrls[index]
    if (!uri) throw new Error(`人物资产归档缺少“${character.name}”的具名生成结果`)
    const designPrompt = character.designPrompt || `东汉末年人物三视图，${character.name}，真人历史电影质感，正面、侧面、背面，服化道准确，纯色背景，无文字无水印。`
    const continuityKey = character.continuityKey || `${character.name}-eastern-han-v1`
    const id = `character-${createHash('sha1').update(`${workflowId}:${continuityKey}:three-view`).digest('hex').slice(0, 16)}`
    const metadata = {
      continuityKey,
      generatedBy: String(params.generatedBy ?? 'workflow-image-node'),
      archivedFromNodeId: request.executionContext?.nodeId ?? null,
      description: character.description,
      historicalPortrait: character.historicalPortrait,
      quality: generated?.metadata && typeof generated.metadata === 'object'
        ? (generated.metadata as Record<string, unknown>).quality
        : undefined,
    }
    await pool.query(
      `
        insert into character_assets (id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, updated_at)
        values ($1, $2, $3, 'three-view', $4, $5, 1, $6::jsonb, now())
        on conflict (id) do update set workflow_id = excluded.workflow_id, uri = excluded.uri, prompt = excluded.prompt, metadata = excluded.metadata, updated_at = now()
      `,
      [id, workflowId, character.name, uri, designPrompt, JSON.stringify(metadata)],
    )
    items.push({ id, workflowId, characterName: character.name, assetType: 'three-view', url: uri, prompt: designPrompt, version: 1, metadata, cached: false })
  }
  return {
    items,
    urls: items.map((item) => item.url),
    byCharacter: Object.fromEntries(items.map((item) => [String(item.characterName), item])),
    archivedCount: items.length,
    count: items.length,
  }
}

async function generateFrameImage(request: BuiltinNodeRequest, prompt: string, params: Record<string, unknown>, executeMediaModel?: MediaExecutor) {
  let body: unknown
  if (request.model?.provider === 'Local' || !executeMediaModel || !request.model) {
    body = runLocalModel({ capability: 'image', prompt, params })
  } else {
    const response = await executeMediaModel({ model: request.model, prompt, params, executionContext: request.executionContext })
    if (response.status >= 400) throw new Error(`帧图生成失败：${JSON.stringify(response.body)}`)
    body = response.body
  }
  const url = firstUrl(body)
  if (!url) throw new Error('帧图生成未返回可用 URL')
  return { url, body }
}

export function resolveFirstFramePrompt(request: Pick<BuiltinNodeRequest, 'prompt' | 'params'>) {
  const params = request.params ?? {}
  return String(request.prompt ?? '').trim() || String(params.firstFramePrompt ?? params.prompt ?? '').trim()
}

async function resolveFirstFrame(request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor) {
  const params = request.params ?? {}
  const requestedMode = String(params.mode ?? 'generate')
  const previousLastFrame = firstUrl(params.previousLastFrame)
  if (requestedMode === 'reuse_previous_tail' && previousLastFrame) {
    return {
      url: previousLastFrame,
      requestedMode,
      resolvedMode: 'reuse_previous_tail',
      generated: false,
      source: 'previous-shot-tail',
    }
  }
  const prompt = resolveFirstFramePrompt(request)
  if (!prompt) throw new Error('首帧生成缺少 firstFramePrompt')
  const generated = await generateFrameImage(request, prompt, params, executeMediaModel)
  return {
    url: generated.url,
    requestedMode,
    resolvedMode: 'generate',
    generated: true,
    source: 'image-model',
    fallbackReason: requestedMode === 'reuse_previous_tail' ? '前一镜没有可用尾帧，已回退为生成新首帧' : undefined,
  }
}

async function resolveTailFrame(request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor) {
  const params = request.params ?? {}
  const videoLastFrame = firstUrl(params.videoLastFrame)
  if (videoLastFrame) {
    return { url: videoLastFrame, generated: false, source: 'video-output-tail' }
  }
  const prompt = String(request.prompt ?? params.prompt ?? '')
  if (!prompt.trim()) throw new Error('视频未返回尾帧，且节点缺少 lastFramePrompt，无法建立下一镜衔接锚点')
  const generated = await generateFrameImage(request, prompt, params, executeMediaModel)
  return { url: generated.url, generated: true, source: 'image-model-fallback' }
}

function buildTimeline(params: Record<string, unknown>) {
  const storyboards = toArray(params.storyboards ?? params.shots)
  const videos = toArray(params.videos ?? params.videoClips)
  const audios = toArray(params.audios ?? params.audioClips)
  const clips = storyboards.map((storyboard, index) => {
    const shot = storyboard && typeof storyboard === 'object' ? storyboard as Record<string, unknown> : {}
    const video = videos[index] && typeof videos[index] === 'object' ? videos[index] as Record<string, unknown> : {}
    const audio = audios[index] && typeof audios[index] === 'object' ? audios[index] as Record<string, unknown> : {}
    const audioUrl = String(audio.url ?? '')
    const hasEmbeddedAudio = video.audioEmbedded === true || video.sound === 'on'
    return {
      index: index + 1,
      shotId: shot.id ?? `shot-${index + 1}`,
      title: shot.title ?? `镜头 ${index + 1}`,
      duration: Number(shot.duration ?? video.duration ?? 5),
      videoUrl: video.url ?? '',
      audioUrl,
      audioSource: audioUrl ? 'external' : hasEmbeddedAudio ? 'video-native' : 'unspecified',
      transcript: shot.audioText ?? audio.transcript ?? '',
    }
  })
  return {
    status: 'ready',
    format: String(params.format ?? 'mp4'),
    aspectRatio: String(params.aspectRatio ?? '9:16'),
    resolution: String(params.resolution ?? '1080x1920'),
    clips,
    clipCount: clips.length,
    totalDuration: clips.reduce((total, clip) => total + clip.duration, 0),
    note: '已生成可交给媒体渲染器的时间线清单；远程视频任务完成后可用同一清单替换 URL 并合成。',
  }
}

function verifyHistoricalBoundaries(params: Record<string, unknown>) {
  const citations = toArray(params.citations)
  const shots = toArray(params.shots ?? params.storyboards)
  const violations: Array<{ shot: number; message: string }> = []
  let totalDuration = 0
  shots.forEach((shot, index) => {
    const record = shot && typeof shot === 'object' ? shot as Record<string, unknown> : {}
    const historicalBasis = String(record.historicalBasis ?? '')
    const citationIndexes = [...historicalBasis.matchAll(/\[史料(\d+)\]/g)].map((match) => Number(match[1]))
    if (!citationIndexes.length) violations.push({ shot: index + 1, message: 'historicalBasis 缺少 [史料N] 引用' })
    if (citationIndexes.some((citationIndex) => citationIndex < 1 || citationIndex > citations.length)) violations.push({ shot: index + 1, message: 'historicalBasis 引用了不存在的史料编号' })
    if (!record.adaptationBoundary) violations.push({ shot: index + 1, message: '缺少 adaptationBoundary' })
    const duration = Number(record.duration)
    if (duration !== 15) violations.push({ shot: index + 1, message: 'duration 必须固定为 15 秒' })
    if (!Array.isArray(record.characters)) violations.push({ shot: index + 1, message: 'characters 必须是数组' })
    totalDuration += Number.isFinite(duration) ? duration : 0
  })
  if (!shots.length) violations.unshift({ shot: 0, message: '场景短分镜不能为空' })
  if (!citations.length) violations.unshift({ shot: 0, message: '没有挂载任何史料引用' })
  const expectedSceneCount = Number(params.expectedSceneCount ?? params.sceneCount)
  if (Number.isFinite(expectedSceneCount) && shots.length !== expectedSceneCount) violations.push({ shot: 0, message: `短分镜数量应为剧情规划的 ${expectedSceneCount} 个，实际为 ${shots.length} 个` })
  const expectedTotalDuration = Number(params.expectedTotalDuration ?? params.targetDuration)
  return {
    passed: violations.length === 0,
    citationCount: citations.length,
    shotCount: shots.length,
    totalDuration,
    expectedSceneCount: Number.isFinite(expectedSceneCount) ? expectedSceneCount : undefined,
    expectedTotalDuration: Number.isFinite(expectedTotalDuration) ? expectedTotalDuration : undefined,
    durationDelta: Number.isFinite(expectedTotalDuration) ? totalDuration - expectedTotalDuration : undefined,
    violations,
    policy: String(params.policy ?? '史事节点需有来源；对白、微动作和场面调度作为合理拟制。'),
  }
}

export async function executeBuiltinNode(pool: Pool, request: BuiltinNodeRequest, executeMediaModel?: MediaExecutor) {
  const params = request.params ?? {}
  if (request.operation === 'internet.retrieve' || request.operation === 'historical.web.retrieve') {
    return retrieveInternetSources({
      query: String(params.query ?? request.prompt ?? ''),
      sourceDetail: String(params.sourceDetail ?? ''),
      sourceNames: toArray(params.sourceNames).map(String),
      urls: toArray(params.urls).map(String),
      maxSources: Number(params.maxSources ?? 3),
      maxPassages: Number(params.maxPassages ?? 6),
    })
  }
  if (request.operation === 'character.lookup') return lookupCharacterAssets(pool, request)
  if (request.operation === 'character.historical-portrait') {
    const portraitResult = await enrichCharactersWithHistoricalPortraits(toArray(params.characters ?? params.names), retrieveInternetSources, {
      maxSources: Number(params.maxSources ?? 2),
      maxPassages: Number(params.maxPassages ?? 4),
    })
    const allCharacters = toArray(params.allCharacters).map(characterIdentity).filter((item) => item.name)
    const enrichedByName = new Map(portraitResult.characters.map((item) => [item.name, item]))
    return {
      ...portraitResult,
      allCharacters: allCharacters.map((item) => enrichedByName.get(item.name) ?? item),
    }
  }
  if (request.operation === 'character.ensure') return ensureCharacterAssets(pool, request, executeMediaModel)
  if (request.operation === 'character.archive') return archiveCharacterAssets(pool, request)
  if (request.operation === 'frame.first.resolve') return resolveFirstFrame(request, executeMediaModel)
  if (request.operation === 'frame.tail.resolve') return resolveTailFrame(request, executeMediaModel)
  if (request.operation === 'history.verify') return verifyHistoricalBoundaries(params)
  if (request.operation === 'timeline.compose') return buildTimeline(params)
  throw new Error(`不支持的内置节点操作：${request.operation}`)
}
