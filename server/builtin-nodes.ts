import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { runLocalModel } from './local-model.ts'
import { retrieveInternetSources } from './web-sources.ts'

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

function characterIdentity(value: unknown) {
  if (typeof value === 'string') return { name: value, designPrompt: '' }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return {
      name: String(record.name ?? record.characterName ?? '').trim(),
      designPrompt: String(record.designPrompt ?? record.prompt ?? ''),
      continuityKey: String(record.continuityKey ?? ''),
    }
  }
  return { name: '', designPrompt: '' }
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
  const characters = [...new Map(identities.map((item) => [item.name, item])).values()]
  if (!characters.length) {
    return { characters: [], names: [], items: [], urls: [], byCharacter: {}, descriptions: {}, missingCharacters: [], foundCount: 0, missingCount: 0 }
  }
  const workflowId = String(params.workflowId ?? '').trim()
  const result = await pool.query(
    `select distinct on (character_name)
            id, workflow_id, character_name, asset_type, uri, prompt, version, metadata, created_at, updated_at
       from character_assets
      where character_name = any($1::text[]) and asset_type = 'three-view'
        and ($2 = '' or workflow_id = $2 or workflow_id is null)
      order by character_name, (workflow_id = $2) desc, updated_at desc`,
    [characters.map((item) => item.name), workflowId],
  )
  const byName = new Map<string, Record<string, unknown>>()
  result.rows.forEach((row) => byName.set(String(row.character_name), storedCharacterAsset(row)))
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
    byName.set(row.character_name, storedCharacterAsset(row))
  })
  const generated: Record<string, unknown>[] = []
  for (const character of characters) {
    if (byName.has(character.name)) continue
    const designPrompt = character.designPrompt || `东汉末年人物三视图，${character.name}，真人历史电影质感，正面、侧面、背面，服化道准确，纯色背景，无文字无水印。`
    let generatedBody: unknown
    if (request.model?.provider === 'Local' || !executeMediaModel || !request.model) {
      generatedBody = runLocalModel({ capability: 'image', operation: 'character.three-view', prompt: designPrompt, params: { characterName: character.name } })
    } else {
      const response = await executeMediaModel({ model: request.model, prompt: designPrompt, params: { size: '1024x1024', characterName: character.name }, operation: 'character.three-view', executionContext: request.executionContext })
      if (response.status >= 400) throw new Error(`角色 ${character.name} 三视图生成失败：${JSON.stringify(response.body)}`)
      generatedBody = response.body
    }
    const uri = firstUrl(generatedBody)
    if (!uri) throw new Error(`角色 ${character.name} 三视图未返回可用 URL`)
    const assetScope = workflowId || 'global'
    const id = `character-${createHash('sha1').update(`${assetScope}:${character.name}:three-view:v1`).digest('hex').slice(0, 16)}`
    const metadata = { continuityKey: character.continuityKey || `${character.name}-eastern-han-v1`, generatedBy: request.model?.id ?? 'local-image-simulator' }
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
    if (duration !== 5 && duration !== 10) violations.push({ shot: index + 1, message: 'duration 只能是 5 或 10 秒' })
    if (!Array.isArray(record.characters)) violations.push({ shot: index + 1, message: 'characters 必须是数组' })
    totalDuration += Number.isFinite(duration) ? duration : 0
  })
  if (!shots.length) violations.unshift({ shot: 0, message: '场景短分镜不能为空' })
  if (!citations.length) violations.unshift({ shot: 0, message: '没有挂载任何史料引用' })
  const expectedSceneCount = Number(params.expectedSceneCount ?? params.sceneCount)
  if (Number.isFinite(expectedSceneCount) && shots.length !== expectedSceneCount) violations.push({ shot: 0, message: `短分镜数量应为剧情规划的 ${expectedSceneCount} 个，实际为 ${shots.length} 个` })
  const expectedTotalDuration = Number(params.expectedTotalDuration ?? params.targetDuration)
  if (Number.isFinite(expectedTotalDuration) && totalDuration !== expectedTotalDuration) violations.push({ shot: 0, message: `整集时长应为剧情规划的 ${expectedTotalDuration} 秒，实际为 ${totalDuration} 秒` })
  return {
    passed: violations.length === 0,
    citationCount: citations.length,
    shotCount: shots.length,
    totalDuration,
    expectedSceneCount: Number.isFinite(expectedSceneCount) ? expectedSceneCount : undefined,
    expectedTotalDuration: Number.isFinite(expectedTotalDuration) ? expectedTotalDuration : undefined,
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
  if (request.operation === 'character.ensure') return ensureCharacterAssets(pool, request, executeMediaModel)
  if (request.operation === 'frame.first.resolve') return resolveFirstFrame(request, executeMediaModel)
  if (request.operation === 'frame.tail.resolve') return resolveTailFrame(request, executeMediaModel)
  if (request.operation === 'history.verify') return verifyHistoricalBoundaries(params)
  if (request.operation === 'timeline.compose') return buildTimeline(params)
  throw new Error(`不支持的内置节点操作：${request.operation}`)
}
