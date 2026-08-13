import { createHash } from 'node:crypto'

export type InternetSourceInput = {
  query: string
  sourceDetail?: string
  sourceNames?: string[]
  urls?: string[]
  maxSources?: number
  maxPassages?: number
  timeoutMs?: number
}

/** @deprecated Use InternetSourceInput. */
export type HistoricalWebSourceInput = InternetSourceInput

export type InternetCitation = {
  index: number
  id: string
  title: string
  source: string
  edition: string
  url: string
  fetchedAt: string
  content: string
  retrieval: 'internet'
}

/** @deprecated Use InternetCitation. */
export type HistoricalWebCitation = InternetCitation

export type InternetSourceResult = {
  query: string
  sourceDetail: string
  count: number
  citations: InternetCitation[]
  text: string
  sourceMode: 'internet'
  fetchedAt: string
  attemptedUrls: string[]
  failures: Array<{ url: string; error: string }>
}

/** @deprecated Use InternetSourceResult. */
export type HistoricalWebSourceResult = InternetSourceResult

type Fetcher = typeof fetch

type WebDocument = {
  title: string
  source: string
  url: string
  text: string
}

const defaultWikiApi = 'https://zh.wikisource.org/w/api.php'
const maxResponseCharacters = 1_500_000
const defaultTimeoutMs = 15_000
const maxFetchAttempts = 4
const retryBackoffMs = 500

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function isPublicInternetUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    const host = url.hostname.toLowerCase()
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
    if (/^(127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.)/.test(host)) return false
    const private172 = host.match(/^172\.(\d+)\./)
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false
    return true
  } catch {
    return false
  }
}

/** @deprecated Use retrieveInternetSources. */
export const retrieveHistoricalSources = retrieveInternetSources

function decodeHtml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&(nbsp|ensp|emsp);/gi, ' ')
    .replace(/&(quot|ldquo|rdquo);/gi, '"')
    .replace(/&(apos|lsquo|rsquo);/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function extractTitle(html: string, fallback: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return decodeHtml(match?.[1] ?? fallback).replace(/\s*[-—｜].*$/, '').replace(/<[^>]+>/g, '').trim() || fallback
}

function htmlToText(html: string) {
  return decodeHtml(
    html
      .replace(/<!--([\s\S]*?)-->/g, '')
      .replace(/<(script|style|noscript|svg|nav|footer|form)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[\t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sourceNameFromUrl(value: string) {
  const host = new URL(value).hostname.toLowerCase()
  if (host.endsWith('wikisource.org')) return '维基文库'
  if (host === 'ctext.org' || host.endsWith('.ctext.org')) return '中国哲学书电子化计划'
  return host
}

function textBlocks(text: string) {
  const sentences = text
    .split(/\n+|(?<=[。！？；])/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 12)
  const blocks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > 1_600 && current) {
      blocks.push(current)
      current = sentence
    } else current = `${current}${current ? '\n' : ''}${sentence}`
  }
  if (current) blocks.push(current)
  return blocks.length ? blocks : [text.slice(0, 1_600)]
}

function queryTerms(input: InternetSourceInput) {
  const sourceNames = input.sourceNames ?? []
  const raw = `${input.query} ${input.sourceDetail ?? ''} ${sourceNames.join(' ')}`
  const phrases = raw.match(/[\u3400-\u9fff]{2,}|[a-z\d]{3,}/gi) ?? []
  const fragments = phrases.flatMap((phrase) => {
    if (phrase.length <= 8) return [phrase]
    return [phrase, ...Array.from({ length: phrase.length - 3 }, (_, index) => phrase.slice(index, index + 4))]
  })
  return unique(fragments).filter((term) => term.length >= 2)
}

function selectPassages(text: string, input: InternetSourceInput) {
  const maxPassages = boundedNumber(input.maxPassages, 4, 1, 8)
  const terms = queryTerms(input)
  return textBlocks(text)
    .map((content, index) => ({
      content,
      index,
      score: terms.reduce((score, term) => score + (content.includes(term) ? Math.max(1, Math.min(4, term.length - 1)) : 0), 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxPassages)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.content)
}

function errorChain(error: unknown) {
  const chain: Array<{ name: string; message: string; code?: string }> = []
  const visited = new Set<unknown>()
  let current = error
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    const code = 'code' in current && typeof current.code === 'string' ? current.code : undefined
    chain.push({ name: current.name, message: current.message, code })
    current = current.cause
  }
  return chain
}

function isTransientFetchFailure(error: unknown) {
  return errorChain(error).some((item) => item.name === 'AbortError'
    || item.name === 'TimeoutError'
    || /(?:fetch failed|network|socket|timed?\s*out|aborted|ECONN|EAI_AGAIN|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|HTTP (?:408|425|429|5\d\d))/i.test(`${item.code ?? ''} ${item.message}`))
}

function fetchAttemptLimit(error: unknown) {
  const isConnectionReset = errorChain(error).some((item) => /ECONNRESET|UND_ERR_SOCKET|socket hang up|other side closed/i.test(`${item.code ?? ''} ${item.message}`))
  return isConnectionReset ? maxFetchAttempts : 2
}

function readableFetchFailure(error: unknown, timeoutMs: number, attempts: number) {
  const chain = errorChain(error)
  if (chain.some((item) => item.name === 'AbortError' || item.name === 'TimeoutError' || /aborted/i.test(item.message))) {
    return new Error(`抓取超时（单次 ${timeoutMs}ms${attempts > 1 ? `，已重试 ${attempts - 1} 次` : ''}）`, { cause: error })
  }
  const connectionTimeout = chain.find((item) => item.code === 'UND_ERR_CONNECT_TIMEOUT' || /connect(?:ion)? timeout|ETIMEDOUT/i.test(`${item.code ?? ''} ${item.message}`))
  if (connectionTimeout) {
    return new Error(`连接超时（已尝试 ${attempts} 次${connectionTimeout.code ? `，${connectionTimeout.code}` : ''}）`, { cause: error })
  }
  const rootCause = chain.at(-1)
  if (chain.length > 1 && rootCause) {
    return new Error(`网络请求失败（已尝试 ${attempts} 次：${rootCause.code ? `${rootCause.code} ` : ''}${rootCause.message}）`, { cause: error })
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function waitBeforeRetry(attempt: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, retryBackoffMs * attempt))
}

async function fetchText(url: string, fetcher: Fetcher, timeoutMs: number, attemptLimit = maxFetchAttempts) {
  if (!isPublicInternetUrl(url)) throw new Error('仅允许抓取公开 http/https URL')
  let lastError: unknown
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(url, {
        headers: {
          Accept: 'text/html,application/json;q=0.9,text/plain;q=0.8',
          'User-Agent': 'video-aigc-historical-retriever/1.0 (+https://localhost)',
        },
        signal: controller.signal,
        redirect: 'follow',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const finalUrl = response.url || url
      if (!isPublicInternetUrl(finalUrl)) throw new Error('跳转后的地址不是公开互联网 URL')
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(contentLength) && contentLength > maxResponseCharacters) throw new Error('网页正文超过抓取大小上限')
      const text = await response.text()
      if (text.length > maxResponseCharacters) throw new Error('网页正文超过抓取大小上限')
      return { text, url: finalUrl }
    } catch (error) {
      lastError = error
      const effectiveAttemptLimit = Math.min(attemptLimit, fetchAttemptLimit(error))
      if (attempt >= effectiveAttemptLimit || !isTransientFetchFailure(error)) throw readableFetchFailure(error, timeoutMs, attempt)
      await waitBeforeRetry(attempt)
    } finally {
      clearTimeout(timer)
    }
  }
  throw readableFetchFailure(lastError, timeoutMs, attemptLimit)
}

function mediaWikiApiFor(url: string) {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.host}/w/api.php`
}

function isMediaWikiSource(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('wikisource.org')
  } catch {
    return false
  }
}

function sourceDetailQueries(input: InternetSourceInput) {
  const sourceNames = unique(input.sourceNames ?? [])
  const detail = (input.sourceDetail ?? '').trim()
  const searchableDetail = detail || input.query
  const focused: string[] = []
  let inheritedSource = sourceNames[0] ?? ''

  // Long workflow queries contain episode titles, several books, volume numbers and
  // verification notes. MediaWiki treats that whole string as an AND-like query and
  // commonly returns zero hits, so turn each "book + volume + chapter" into a search.
  for (const section of searchableDetail.split(/[；;。\n]+/)) {
    const firstVolumeIndex = section.search(/卷[〇零一二三四五六七八九十百千两\d]+/)
    const leadingBook = section.match(/《([^》]{2,32})》(?=\s*卷)/)?.[1]
    if (leadingBook) inheritedSource = leadingBook
    else if (firstVolumeIndex > 0) {
      const prefixTerms = section.slice(0, firstVolumeIndex).match(/[\u3400-\u9fff]{2,16}/g) ?? []
      const possibleBook = prefixTerms.at(-1)
      if (possibleBook) inheritedSource = possibleBook
    }
    const volumeChapters = [...section.matchAll(/(卷[〇零一二三四五六七八九十百千两\d]+)\s*《([^》]{2,32})》/g)]
    for (const match of volumeChapters) focused.push([inheritedSource, match[1], match[2]].filter(Boolean).join(' '))
  }

  const quotedTitles = [...searchableDetail.matchAll(/《([^》]{2,32})》/g)].map((match) => match[1])
  const pairedTitles = sourceNames.flatMap((source) => quotedTitles.map((title) => `${source} ${title}`))
  return unique([...focused, ...pairedTitles, ...quotedTitles, detail, input.query]).slice(0, 6)
}

async function searchMediaWiki(api: string, input: InternetSourceInput, fetcher: Fetcher, timeoutMs: number) {
  const queries = sourceDetailQueries(input)
  const pageTitles: string[] = []
  const failedSearches: string[] = []
  let consecutiveNetworkFailures = 0
  for (const search of queries) {
    const url = new URL(api)
    url.searchParams.set('action', 'query')
    url.searchParams.set('list', 'search')
    url.searchParams.set('format', 'json')
    url.searchParams.set('srnamespace', '0')
    url.searchParams.set('srlimit', '2')
    url.searchParams.set('srsearch', search)
    try {
      // A fallback host that cannot be reached should not multiply one connection
      // timeout by every decomposed query. Try each query once and stop after two
      // consecutive transport failures; successful empty searches may continue.
      const response = await fetchText(url.toString(), fetcher, timeoutMs, 1)
      const body = JSON.parse(response.text) as { query?: { search?: Array<{ title?: string }> } }
      pageTitles.push(...(body.query?.search?.map((item) => String(item.title ?? '')).filter(Boolean) ?? []))
      consecutiveNetworkFailures = 0
      if (unique(pageTitles).length >= boundedNumber(input.maxSources, 3, 1, 4)) break
    } catch (error) {
      failedSearches.push(`${search}: ${error instanceof Error ? error.message : String(error)}`)
      consecutiveNetworkFailures += 1
      if (consecutiveNetworkFailures >= 2) break
    }
  }
  const uniquePageTitles = unique(pageTitles).slice(0, boundedNumber(input.maxSources, 3, 1, 4))
  if (!uniquePageTitles.length) {
    throw new Error(failedSearches.length ? `MediaWiki 检索失败（${failedSearches.join('；')}）` : `MediaWiki 未找到匹配页面（检索词：${queries.join('；')}）`)
  }
  const pages = await Promise.allSettled(uniquePageTitles.map(async (title) => {
    const url = new URL(api)
    url.searchParams.set('action', 'parse')
    url.searchParams.set('format', 'json')
    url.searchParams.set('prop', 'text|displaytitle')
    url.searchParams.set('page', title)
    const response = await fetchText(url.toString(), fetcher, timeoutMs)
    const body = JSON.parse(response.text) as { parse?: { displaytitle?: string; text?: { '*'?: string } } }
    const html = body.parse?.text?.['*']
    if (!html) throw new Error('MediaWiki 未返回页面正文')
    return {
      title: htmlToText(body.parse?.displaytitle ?? title),
      source: sourceNameFromUrl(api),
      url: response.url,
      text: htmlToText(html),
    } satisfies WebDocument
  }))
  const documents = pages.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  if (!documents.length) {
    const failures = pages
      .map((result, index) => result.status === 'rejected' ? `${uniquePageTitles[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` : '')
      .filter(Boolean)
    throw new Error(`MediaWiki 页面正文抓取失败${failures.length ? `（${failures.join('；')}）` : ''}`)
  }
  return documents
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback
}

export async function retrieveInternetSources(input: InternetSourceInput, fetcher: Fetcher = fetch): Promise<InternetSourceResult> {
  const urls = unique(input.urls ?? []).filter(isPublicInternetUrl)
  const timeoutMs = boundedNumber(input.timeoutMs, defaultTimeoutMs, 1_000, 30_000)
  const maxSources = boundedNumber(input.maxSources, 3, 1, 4)
  const attemptedUrls = [...urls]
  const failures: Array<{ url: string; error: string }> = []
  const directUrls = urls.filter((url) => !isMediaWikiSource(url)).slice(0, maxSources)
  const wikiApis = unique([
    ...urls.filter(isMediaWikiSource).map(mediaWikiApiFor),
    defaultWikiApi,
  ])

  const directResults = await Promise.allSettled(directUrls.map(async (url) => {
    const response = await fetchText(url, fetcher, timeoutMs)
    return {
      title: extractTitle(response.text, sourceNameFromUrl(response.url)),
      source: sourceNameFromUrl(response.url),
      url: response.url,
      text: htmlToText(response.text),
    } satisfies WebDocument
  }))

  const documents: WebDocument[] = []
  directResults.forEach((result, index) => {
    if (result.status === 'fulfilled') documents.push(result.value)
    else failures.push({ url: directUrls[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
  })

  // MediaWiki is a fallback for unavailable direct source pages. Avoid making an
  // already successful lookup wait on a second host that may be blocked locally.
  if (!documents.length) {
    const wikiResults = await Promise.allSettled(wikiApis.map((api) => {
      attemptedUrls.push(api)
      return searchMediaWiki(api, input, fetcher, timeoutMs)
    }))
    wikiResults.forEach((result, index) => {
      if (result.status === 'fulfilled') documents.push(...result.value)
      else failures.push({ url: wikiApis[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
    })
  }

  const fetchedAt = new Date().toISOString()
  const citations = documents
    .flatMap((document) => selectPassages(document.text, input).map((content) => ({ document, content })))
    .filter((item) => item.content.trim().length >= 30)
    .slice(0, boundedNumber(input.maxPassages, 6, 1, 12))
    .map((item, index) => ({
      index: index + 1,
      id: `web-${createHash('sha1').update(`${item.document.url}:${index}:${item.content}`).digest('hex').slice(0, 16)}`,
      title: item.document.title,
      source: item.document.source,
      edition: input.sourceDetail ?? '',
      url: item.document.url,
      fetchedAt,
      content: item.content,
      retrieval: 'internet' as const,
    }))
  if (!citations.length) {
    const detail = failures.map((failure) => `${failure.url}: ${failure.error}`).join('；')
    throw new Error(`未能从互联网取得可用史料原文${detail ? `（${detail}）` : ''}`)
  }
  return {
    query: input.query,
    sourceDetail: input.sourceDetail ?? '',
    count: citations.length,
    citations,
    text: citations.map((item) => `[史料${item.index}] ${item.title}\n来源：${item.url}\n抓取时间：${item.fetchedAt}\n${item.content}`).join('\n\n'),
    sourceMode: 'internet',
    fetchedAt,
    attemptedUrls,
    failures,
  }
}
