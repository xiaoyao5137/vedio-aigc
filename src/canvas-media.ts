export type CanvasMediaKind = 'image' | 'video' | 'audio'

export type CanvasMedia = {
  url: string
  kind: CanvasMediaKind
  label: string
  source: 'output' | 'reference'
  filename?: string
}

export type CanvasMediaNode = {
  kind: string
  modelId?: string
  operation?: string
  uploads?: readonly { name?: string; dataUrl: string; mimeType?: string }[]
  params?: readonly { name?: string; englishName?: string; type?: string; value: unknown }[]
}

export type CanvasMediaRun = {
  output?: unknown
  status?: string
  inputs?: Record<string, unknown>
  inputContext?: Record<string, unknown>
}

const normalizeKey = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase()
const recordValue = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const mediaKinds: CanvasMediaKind[] = ['image', 'video', 'audio']

/** Used for an empty node's preview slot; actual assets can have a different media kind. */
export function canvasMediaKind(node: CanvasMediaNode): CanvasMediaKind | undefined {
  if (mediaKinds.includes(node.kind as CanvasMediaKind)) return node.kind as CanvasMediaKind
  if (node.kind === 'videoConcat' || node.kind === 'compose') return 'video'
  const operation = node.operation?.toLowerCase() ?? ''
  if (/^(?:audio|tts|speech|voice|narration)\.|^character\.voice-/.test(operation)) return 'audio'
  if (/^(?:video|timeline)\./.test(operation)) return 'video'
  if (/^(?:image|frame)\.|^character\.(?:ensure|lookup|archive|appearance)$/.test(operation) || node.kind === 'asset') return 'image'
  if (/(?:^|[-_.])(?:tts|audio|speech)(?:$|[-_.])/.test(node.modelId ?? '')) return 'audio'
  return undefined
}

function mimeKind(value: unknown): CanvasMediaKind | undefined {
  if (typeof value !== 'string') return undefined
  const kind = value.toLowerCase().split('/')[0]
  return mediaKinds.includes(kind as CanvasMediaKind) ? kind as CanvasMediaKind : undefined
}

function urlKind(url: string): CanvasMediaKind | undefined {
  if (/^data:/i.test(url)) return mimeKind(url.slice(5))
  const path = url.split(/[?#]/)[0]
  if (/\.(?:png|jpe?g|webp|gif|avif|bmp|svg|ico)$/i.test(path)) return 'image'
  if (/\.(?:mp4|webm|mov|m4v|mkv|ogv)$/i.test(path)) return 'video'
  if (/\.(?:mp3|wav|aac|flac|opus|m4a|ogg|aiff?)$/i.test(path)) return 'audio'
  const routeKind = path.match(/\/api\/generated-(images?|video|audio)(?:[/.-]|$)/i)?.[1]?.toLowerCase()
  if (routeKind) return routeKind.startsWith('image') ? 'image' : routeKind as CanvasMediaKind
  return undefined
}

function safeMediaUrl(value: string) {
  const url = value.trim()
  if (!url || /[\p{Cc}\\]/u.test(url) || url.includes('${')) return undefined
  if (/^data:/i.test(url)) return /^data:(?:image|video|audio)\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(url) ? url : undefined
  if (/^https?:\/\//i.test(url) || /^blob:https?:\/\//i.test(url)) {
    try { new URL(url); return url } catch { return undefined }
  }
  // Browser-served local media is a relative URL, never a filesystem or executable scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || /^\/\//.test(url) || /\s/.test(url)) return undefined
  return /^(?:\/|\.\.?\/)/.test(url) || urlKind(url) ? url : undefined
}

function keyKind(key: string): CanvasMediaKind | undefined {
  const normalized = normalizeKey(key)
  if (/^(?:images?|pictures?)references?$/.test(normalized)) return 'image'
  if (/^(?:(?:reference|input|output|source|generated|original|start|end|first|last|tail|cover|preview|thumbnail|review|previous|anchor|frontal|threeview)*)(?:images?|pictures?|photos?|frames?)(?:urls?|uris?|list|clips)?$/.test(normalized)
    || /^(?:previouslastframe|firstframeurl|lastframeurl|tailframeurl|poster|staticmask)$/.test(normalized)) return 'image'
  if (/^(?:(?:reference|input|output|source|generated|original|preview)*)(?:videos?)(?:urls?|uris?|list|clips)?$/.test(normalized)) return 'video'
  if (/^(?:(?:reference|input|output|source|generated|original|preview|sample|demo)*)(?:audios?|speech|voices?|soundtracks?)(?:urls?|uris?|list|clips)?$/.test(normalized)) return 'audio'
  return undefined
}

const urlKeys = new Set(['url', 'urls', 'uri', 'src', 'dataurl', 'dataurls', 'mediaurl', 'mediaurls', 'downloadurl', 'localurl', 'originalurl', 'outputurl', 'previewurl', 'sampleurl'])
const containers = new Set(['data', 'body', 'raw', 'response', 'providerresponse', 'providerresult', 'result', 'results', 'output', 'outputs', 'taskresult', 'items', 'media', 'assets', 'files', 'clips', 'tracks', 'bycharacter'])
const ignoredKeys = /^(?:prompt|negativeprompt|request|params|parameters|inputcontext|context|metadata|debug|diagnostics|providerevents|events|logs|error|message|description|transcript|text|callback|endpoint|documentation|referencebindings|equipmentbindings)/
const outputReferenceKeys = /^(?:reference|input|source|identityreference|originalreference|previous)/

function resultKeyPriority(key: string) {
  const normalized = normalizeKey(key)
  if (normalized === 'url') return 0
  if (urlKeys.has(normalized)) return 1
  if (normalized === 'items') return 2
  if (['raw', 'providerresponse', 'providerresult', 'response'].includes(normalized)) return 4
  return 3
}

function filenameFor(url: string): string | undefined {
  if (url.startsWith('data:') || url.startsWith('blob:')) return undefined
  const filename = url.split(/[?#]/)[0].split('/').pop()
  if (!filename || !/\.[a-z0-9]{2,5}$/i.test(filename)) return undefined
  try { return decodeURIComponent(filename) } catch { return filename }
}

function mediaCollector(result: CanvasMedia[], source: CanvasMedia['source']) {
  const seenUrls = new Set<string>()
  const seenObjects = new WeakSet<object>()
  let visits = 0
  const add = (value: string, hint: CanvasMediaKind | undefined, label: string) => {
    const url = safeMediaUrl(value)
    const kind = url && (urlKind(url) ?? hint)
    if (!url || !kind || seenUrls.has(url) || seenUrls.size >= 96) return
    seenUrls.add(url)
    result.push({ url, kind, label, source, ...(filenameFor(url) ? { filename: filenameFor(url) } : {}) })
  }
  const visit = (value: unknown, hint: CanvasMediaKind | undefined, label: string, depth = 0, direct = true, map = false) => {
    if (++visits > 1200 || depth > 10 || seenUrls.size >= 96) return
    if (typeof value === 'string') {
      if (direct) add(value, hint, label)
      return
    }
    if (!value || typeof value !== 'object' || seenObjects.has(value)) return
    seenObjects.add(value)
    if (Array.isArray(value)) {
      value.slice(0, 160).forEach(item => visit(item, hint, label, depth + 1, direct, map))
      return
    }
    const record = value as Record<string, unknown>
    const objectKind = mimeKind(record.mimeType ?? record.mime_type ?? record.contentType ?? record.content_type)
      ?? mimeKind(record.kind ?? record.type) ?? hint
    const objectLabel = [record.name, record.characterName, record.title, record.filename].find(item => typeof item === 'string' && item.trim())
    const nextLabel = typeof objectLabel === 'string' ? objectLabel : label
    // Persisted records may insert raw provider data before the final narrated/composited URL.
    // Canonical result slots must lead the carousel regardless of JSON property order.
    const entries = Object.entries(record).sort(([left], [right]) => resultKeyPriority(left) - resultKeyPriority(right))
    for (const [key, child] of entries.slice(0, 160)) {
      const normalized = normalizeKey(key)
      if (ignoredKeys.test(normalized) || (source === 'output' && (outputReferenceKeys.test(normalized) || /references?(?:urls?)?$/.test(normalized)))) continue
      const fieldKind = keyKind(key)
      const urlField = urlKeys.has(normalized)
      const container = containers.has(normalized)
      // Node type supplies a fallback only inside actual result/media slots. It must not turn
      // an arbitrary nested API URL (or a prompt containing a URL) into generated footage.
      const childHint = fieldKind ?? ((urlField || container || map) ? objectKind : undefined)
      const childDirect = Boolean(fieldKind || urlField || container || map)
      visit(child, childHint, nextLabel, depth + 1, childDirect, normalized === 'bycharacter' || Boolean(fieldKind && recordValue(child)) || (map && !urlField))
    }
  }
  return visit
}

function ownPath(context: Record<string, unknown>, path: string): unknown {
  return path.trim().split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(key)) return undefined
    return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
  }, context)
}

/** Pure placeholder resolution; never evaluates node code or JavaScript expressions. */
function resolveReference(value: unknown, context: Record<string, unknown>, depth = 0): unknown {
  if (depth > 10) return undefined
  if (typeof value === 'string') {
    const exact = value.trim().match(/^\$\{([^}]+)\}$/)
    if (exact) return ownPath(context, exact[1])
    if ('[{'.includes(value.trim()[0] ?? '\0')) {
      try { return resolveReference(JSON.parse(value), context, depth + 1) } catch { /* Bare template splices need interpolation before JSON parsing. */ }
    }
    const rendered = value.replace(/\$\{([^}]+)\}/g, (original, path: string) => {
      const resolved = ownPath(context, path)
      return resolved === undefined || resolved === null ? original : typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)
    })
    if ('[{"'.includes(rendered.trim()[0] ?? '\0')) {
      try { return resolveReference(JSON.parse(rendered), context, depth + 1) } catch { /* A URL or unresolved input is not JSON. */ }
    }
    return rendered
  }
  if (Array.isArray(value)) return value.slice(0, 160).map(item => resolveReference(item, context, depth + 1))
  if (recordValue(value)) return Object.fromEntries(Object.entries(value).slice(0, 160).map(([key, item]) => [key, resolveReference(item, context, depth + 1)]))
  return value
}

/** Only the selected run contributes outputs. Context is used exclusively to resolve references.
 * A recorded run's captured inputs/context are authoritative, including empty snapshots; falling
 * back to a global latest context here would show another iteration's assets on an idle node. */
export function resolveCanvasMedia(node: CanvasMediaNode, options: { run?: CanvasMediaRun; context?: Record<string, unknown> } = {}): CanvasMedia[] {
  const result: CanvasMedia[] = []
  const run = options.run
  if (run && run.status !== 'idle' && run.status !== 'skipped') {
    mediaCollector(result, 'output')(run.output, canvasMediaKind(node), '生成结果')
  }
  const references = mediaCollector(result, 'reference')
  for (const upload of node.uploads ?? []) references(upload.dataUrl, mimeKind(upload.mimeType) ?? urlKind(upload.name ?? ''), upload.name || '上传素材')
  const context = run ? run.inputContext ?? {} : options.context ?? {}
  const captured = run?.inputs
  const paramKeys = new Set<string>()
  for (const param of node.params ?? []) {
    const key = param.englishName || param.name || ''
    paramKeys.add(key)
    if (param.name) paramKeys.add(param.name)
    const hint = keyKind(param.type ?? '') ?? keyKind(key)
    const label = param.name || key || '引用素材'
    if (ignoredKeys.test(normalizeKey(key))) continue
    const value = captured
      ? Object.hasOwn(captured, key) ? captured[key] : param.name && Object.hasOwn(captured, param.name) ? captured[param.name] : undefined
      : resolveReference(param.value, context)
    references(value, hint, label, 0, Boolean(hint) || !recordValue(value))
  }
  // Some operations add media inputs at runtime without declaring editable parameters.
  for (const [key, value] of Object.entries(captured ?? {})) {
    if (paramKeys.has(key) || ignoredKeys.test(normalizeKey(key))) continue
    const hint = keyKind(key)
    if (hint) references(value, hint, '引用素材')
  }
  return result
}
