import { createHash } from 'node:crypto'
import { Converter } from 'opencc-js/t2cn'

export type InternetSourceInput = {
  query: string
  sourceDetail?: string
  sourceNames?: string[]
  urls?: string[]
  maxSources?: number
  maxPassages?: number
  timeoutMs?: number
  /** Restrict MediaWiki fallback results to canonical page prefixes such as 三國志/. */
  titlePrefixes?: string[]
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
  request?: InternetSourceInput
  cacheRecovery?: {
    executionRecordId: string
    recoveredAt: string
    onlineError: string
  }
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
      // Inline markup (names, dates, annotation spans) must not insert spaces
      // into continuous classical prose: 張飛所拒 is one quoted source phrase.
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[\t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function assertUsableSourcePage(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const challengeSignals = [
    /please confirm that you are human/i,
    /checking the security of your connection/i,
    /attention (?:llms|robots|scrapers)/i,
    /web scraping of this site is in violation/i,
    /intentionally return corrupted data/i,
    /not an automated (?:program|programme)/i,
    /请输入.{0,12}(?:认证图案|驗證碼|验证码)/i,
    /確認您是?真人/i,
    /captcha/i,
    /access denied/i,
  ]
  if (challengeSignals.some((pattern) => pattern.test(normalized))) {
    throw new Error('页面返回人机验证或访问拦截，未取得史料正文')
  }
}

/** A catalogue is a navigation aid, never evidence for a historical event. */
export function isSourceCatalogue(text: string) {
  if ((text.match(/Show source information/gi) ?? []).length >= 6) return true
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  const entries = lines.filter((line) => /(?:^\d+[.、]|卷[一二三四五六七八九十百\d]+|列[傳传]|Annals of|Biographies of)/i.test(line)
    && (line.match(/[。！？；]/g) ?? []).length < 2)
  const prose = lines.filter((line) => (line.match(/[。！？；]/g) ?? []).length >= 2).join('')
  return entries.length >= 6 && prose.length < text.length / 3
}

const searchComparable = Converter({ from: 't', to: 'cn' })

function catalogueLinks(html: string, base: string, input: InternetSourceInput) {
  const query = searchComparable(`${input.query} ${input.sourceDetail ?? ''}`)
  const declaredBase = html.match(/<base\b[^>]*href=["']([^"']+)["']/i)?.[1]
  let linkBase = base
  if (declaredBase) {
    try { linkBase = new URL(decodeHtml(declaredBase), base).href } catch { /* use the document URL */ }
  }
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ label: searchComparable(htmlToText(match[2])), href: new URL(decodeHtml(match[1]), linkBase).href }))
    .filter(({ label, href }) => label.length >= 3 && isPublicInternetUrl(href)
      && new URL(href).origin === new URL(base).origin && href !== base
      && (query.includes(label) || (() => {
        // Episode topics often name a person/event rather than the catalogue's
        // biography title. Match its complete subject, never a partial name.
        const subject = label.match(/^([\p{Script=Han}]{2,}?)(?:列传|本纪|传|纪)$/u)?.[1]
        return Boolean(subject && query.includes(subject))
      })()))
    .sort((a, b) => b.label.length - a.label.length)
    .filter((item, i, all) => all.findIndex((other) => other.href === item.href) === i)
    .slice(0, 2)
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
    // Classical source pages can contain a whole chapter without Chinese full
    // stops. Split those physical lines as well, otherwise one "sentence" can
    // silently bypass the 1,600-character passage budget and multiply every
    // downstream writer/reviewer prompt.
    .flatMap((item) => Array.from({ length: Math.ceil(item.length / 1_600) }, (_, index) => item.slice(index * 1_600, (index + 1) * 1_600)))
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
  const terms = unique(queryTerms(input).map(searchComparable))
  const topic = searchComparable(input.query.split(/\s+/)[0] ?? '')
  const topicTerms = topic.length >= 4 && topic.length <= 12 ? Array.from({ length: topic.length - 1 }, (_, i) => topic.slice(i, i + 2)) : []
  return textBlocks(text)
    .map((content, index) => ({
      content,
      index,
      score: terms.reduce((score, term) => score + (searchComparable(content).includes(term) ? Math.max(1, Math.min(4, term.length - 1)) : 0), 0)
        + topicTerms.reduce((score, term) => score + (searchComparable(content).includes(term) ? 8 : 0), 0),
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

function chineseVolumeNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
  const units: Record<string, number> = { '十': 10, '百': 100, '千': 1000 }
  let total = 0
  let current = 0
  for (const char of value) {
    if (char in digits) current = digits[char]
    else if (char in units) {
      total += (current || 1) * units[char]
      current = 0
    } else return null
  }
  return total + current
}

function canonicalMediaWikiTitles(input: InternetSourceInput) {
  const bookAliases: Record<string, string> = {
    '后汉书': '後漢書',
    '後漢書': '後漢書',
    '三国志': '三國志',
    '三國志': '三國志',
    '资治通鉴': '資治通鑑',
    '資治通鑑': '資治通鑑',
  }
  const titles: string[] = []
  let inheritedBook = unique(input.sourceNames ?? [])[0] ?? ''
  const searchableDetail = (input.sourceDetail ?? '').trim() || input.query
  for (const section of searchableDetail.split(/[；;。\n]+/)) {
    const firstVolumeIndex = section.search(/卷[〇零一二三四五六七八九十百千两\d]+/)
    const leadingBook = section.match(/《([^》]{2,32})》(?=\s*卷)/)?.[1]
    const plainBook = firstVolumeIndex > 0
      ? Object.keys(bookAliases)
          .filter((book) => section.lastIndexOf(book, firstVolumeIndex) >= 0)
          .sort((left, right) => section.lastIndexOf(right, firstVolumeIndex) - section.lastIndexOf(left, firstVolumeIndex))[0]
      : undefined
    if (leadingBook || plainBook) inheritedBook = leadingBook ?? plainBook ?? inheritedBook
    for (const match of section.matchAll(/卷([〇零一二三四五六七八九十百千两\d]+)/g)) {
      const volume = chineseVolumeNumber(match[1])
      const canonicalBook = bookAliases[inheritedBook]
      if (canonicalBook && volume !== null) {
        const formattedVolume = canonicalBook === '三國志'
          ? String(volume).padStart(2, '0')
          : canonicalBook === '資治通鑑'
            ? String(volume).padStart(3, '0')
            : String(volume)
        titles.push(`${canonicalBook}/卷${formattedVolume}`)
        if (formattedVolume !== String(volume)) titles.push(`${canonicalBook}/卷${volume}`)
      }
    }
  }
  return unique(titles)
}

/** Fetch the public article itself when the workbook names an exact volume.
 * The MediaWiki API can be rate limited while the article remains available.
 * Require a matching article title and a substantive prose body: a book index,
 * error page or JSON response must never become a historical citation.
 */
function relevantWikiSection(html: string, query: string) {
  const heading = /<div\b[^>]*class=["'][^"']*\bmw-heading2\b[^"']*["'][^>]*>\s*<h2\b[^>]*id=["']([^"']+)["']/gi
  const headings = [...html.matchAll(heading)]
    .map((match) => ({ at: match.index, title: decodeHtml(match[1]) }))
  const normalizedQuery = searchComparable(query)
  const relevant = headings
    .filter((item) => item.title.length >= 2 && normalizedQuery.includes(searchComparable(item.title)))
    .sort((left, right) => right.title.length - left.title.length || left.at - right.at)[0]
  if (!relevant) return { html, section: '' }
  const next = headings.find((item) => item.at > relevant.at)
  return { html: html.slice(relevant.at, next?.at), section: relevant.title }
}

async function fetchCanonicalMediaWikiArticle(api: string, title: string, input: InternetSourceInput, fetcher: Fetcher, timeoutMs: number) {
  const base = new URL(api)
  const articleUrl = new URL(`/wiki/${title.split('/').map(encodeURIComponent).join('/')}`, base.origin).toString()
  const response = await fetchText(articleUrl, fetcher, timeoutMs, 2)
  const html = response.text
  const contentStart = html.search(/<div\b[^>]*\bid=["']mw-content-text["']/i)
  const proseStart = contentStart < 0 ? -1 : html.indexOf('mw-parser-output', contentStart)
  const footerStart = proseStart < 0 ? -1 : html.search(/<div\b[^>]*\bclass=["'][^"']*\bprintfooter\b/i)
  if (proseStart < 0 || footerStart <= proseStart) throw new Error('维基文库直达页未返回可定位的正文区域')
  const actualTitle = extractTitle(html, '')
  if (searchComparable(actualTitle) !== searchComparable(title)) throw new Error(`维基文库直达页标题不符：${actualTitle || '空标题'}`)
  const focused = relevantWikiSection(html.slice(contentStart, footerStart), input.query)
  const articleHtml = focused.html
  const text = htmlToText(articleHtml)
  assertUsableSourcePage(text)
  if (isSourceCatalogue(text) || (text.match(/[\u3400-\u9fff]/g) ?? []).length < 80 || !/<p\b/i.test(articleHtml)) {
    throw new Error('维基文库直达页只有目录或缺少足量篇章正文')
  }
  const citeUrl = focused.section ? `${response.url}#${encodeURIComponent(focused.section)}` : response.url
  return { title: focused.section ? `${actualTitle}#${focused.section}` : actualTitle, source: sourceNameFromUrl(response.url), url: citeUrl, text } satisfies WebDocument
}

async function searchMediaWiki(api: string, input: InternetSourceInput, fetcher: Fetcher, timeoutMs: number, attemptedUrls: string[]) {
  const queries = sourceDetailQueries(input)
  const titlePrefixes = unique(input.titlePrefixes ?? [])
  // Exact book/volume article pages carry traceable source text and avoid the
  // search/parse API rate limit. Use API search only for a missing article.
  const canonicalTitles = canonicalMediaWikiTitles(input)
    .filter((title) => !titlePrefixes.length || titlePrefixes.some((prefix) => title.startsWith(prefix)))
  const maxSources = boundedNumber(input.maxSources, 3, 1, 4)
  const titleGroups = new Map<string, string[]>()
  for (const title of canonicalTitles) {
    const key = title.replace(/\/卷0*(\d+)$/, (_, volume: string) => `/卷${Number(volume)}`)
    titleGroups.set(key, [...(titleGroups.get(key) ?? []), title])
  }
  const canonicalDocuments: WebDocument[] = []
  const missingTitles: string[] = []
  const articleFailures: string[] = []
  for (const variants of titleGroups.values()) {
    let found = false
    for (const title of variants) {
      attemptedUrls.push(new URL(`/wiki/${title.split('/').map(encodeURIComponent).join('/')}`, new URL(api).origin).toString())
      try {
        canonicalDocuments.push(await fetchCanonicalMediaWikiArticle(api, title, input, fetcher, timeoutMs))
        found = true
        break
      } catch (error) {
        articleFailures.push(`${title}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!found) missingTitles.push(...variants)
    if (canonicalDocuments.length >= maxSources) break
  }
  if (canonicalDocuments.length >= maxSources || (titleGroups.size && !missingTitles.length)) {
    return canonicalDocuments.slice(0, maxSources)
  }
  attemptedUrls.push(api)
  const pageTitles: string[] = [...missingTitles]
  const failedSearches: string[] = []
  let consecutiveNetworkFailures = 0
  for (const search of queries) {
    const url = new URL(api)
    url.searchParams.set('action', 'query')
    url.searchParams.set('list', 'search')
    url.searchParams.set('format', 'json')
    url.searchParams.set('srnamespace', '0')
    url.searchParams.set('srlimit', titlePrefixes.length ? '50' : '2')
    url.searchParams.set('srsearch', search)
    try {
      // A fallback host that cannot be reached should not multiply one connection
      // timeout by every decomposed query. Try each query once and stop after two
      // consecutive transport failures; successful empty searches may continue.
      const response = await fetchText(url.toString(), fetcher, timeoutMs, 1)
      const body = JSON.parse(response.text) as { query?: { search?: Array<{ title?: string }> } }
      const matchedTitles = body.query?.search?.map((item) => String(item.title ?? '')).filter(Boolean) ?? []
      pageTitles.push(...matchedTitles.filter((title) => !titlePrefixes.length || titlePrefixes.some((prefix) => title.startsWith(prefix))))
      consecutiveNetworkFailures = 0
      if (canonicalDocuments.length + unique(pageTitles).length >= maxSources) break
    } catch (error) {
      failedSearches.push(`${search}: ${error instanceof Error ? error.message : String(error)}`)
      consecutiveNetworkFailures += 1
      if (consecutiveNetworkFailures >= 2) break
    }
  }
  const uniquePageTitles = unique(pageTitles).slice(0, Math.max(maxSources, canonicalTitles.length + maxSources))
  if (!uniquePageTitles.length) {
    if (canonicalDocuments.length) return canonicalDocuments.slice(0, maxSources)
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
    const text = htmlToText(html)
    assertUsableSourcePage(text)
    if (isSourceCatalogue(text)) throw new Error('页面仅为目录，缺少史料正文')
    return {
      title: htmlToText(body.parse?.displaytitle ?? title),
      source: sourceNameFromUrl(api),
      url: response.url,
      text,
    } satisfies WebDocument
  }))
  const documents = [...canonicalDocuments, ...pages.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])].slice(0, maxSources)
  if (!documents.length) {
    const failures = pages
      .map((result, index) => result.status === 'rejected' ? `${uniquePageTitles[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` : '')
      .filter(Boolean)
    throw new Error(`MediaWiki 页面正文抓取失败${articleFailures.length + failures.length ? `（${[...articleFailures, ...failures].join('；')}）` : ''}`)
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
    let response = await fetchText(url, fetcher, timeoutMs)
    let text = htmlToText(response.text)
    assertUsableSourcePage(text)
    const finalUrl = new URL(response.url)
    if (finalUrl.hostname === 'ctext.org' && /^\/(?:zh|zhs|zht)?\/?$/.test(finalUrl.pathname)) throw new Error('史料页面重定向到网站首页，没有取得篇章正文')
    if (isSourceCatalogue(text)) {
      const links = catalogueLinks(response.text, response.url, input)
      let chapterFound = false
      for (const link of links) {
        attemptedUrls.push(link.href)
        try {
          const chapter = await fetchText(link.href, fetcher, timeoutMs)
          const chapterText = htmlToText(chapter.text)
          assertUsableSourcePage(chapterText)
          if (isSourceCatalogue(chapterText) || chapterText.length < 30) continue
          response = chapter
          text = chapterText
          chapterFound = true
          break
        } catch (error) {
          failures.push({ url: link.href, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (!chapterFound) throw new Error('页面仅为目录，未取得匹配篇章正文；不能作为史料引用')
    }
    if (text.trim().length < 30) throw new Error('页面正文不足 30 字符，不能作为有效来源')
    return {
      title: extractTitle(response.text, sourceNameFromUrl(response.url)),
      source: sourceNameFromUrl(response.url),
      url: response.url,
      text,
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
      return searchMediaWiki(api, input, fetcher, timeoutMs, attemptedUrls)
    }))
    wikiResults.forEach((result, index) => {
      if (result.status === 'fulfilled') documents.push(...result.value)
      else failures.push({ url: wikiApis[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
    })
  }

  const fetchedAt = new Date().toISOString()
  const passageGroups = documents.map((document) => selectPassages(document.text, input).map((content) => ({ document, content })))
  const balancedPassages = Array.from({ length: Math.max(0, ...passageGroups.map((group) => group.length)) })
    .flatMap((_, passageIndex) => passageGroups.flatMap((group) => group[passageIndex] ? [group[passageIndex]] : []))
  const citations = balancedPassages
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
    request: {
      query: input.query,
      sourceDetail: input.sourceDetail ?? '',
      sourceNames: input.sourceNames ?? [],
      urls: input.urls ?? [],
      maxSources,
      maxPassages: boundedNumber(input.maxPassages, 6, 1, 12),
      timeoutMs,
      titlePrefixes: input.titlePrefixes ?? [],
    },
  }
}
