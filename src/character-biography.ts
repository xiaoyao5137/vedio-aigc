import { Converter } from 'opencc-js/t2cn'
import { CHARACTER_BIOGRAPHY_MAX_LENGTH } from './character-asset.ts'
import { characterVisualContextDesignText, normalizeCharacterVisualContext } from './character-visual-context.ts'

export { CHARACTER_BIOGRAPHY_MAX_LENGTH } from './character-asset.ts'

export type CharacterBiographySource = {
  citations: Array<{ title: string; url: string; content: string }>
}
export type CharacterBiographyInput = {
  name: string
  description?: string
  visualContext?: unknown
  historicalPortrait?: unknown
}
export type CharacterBiographyEvidence = { title: string; url: string; quote: string }

const comparable = Converter({ from: 't', to: 'cn' })
const historyTitle = /(?:三国志|后汉书|资治通鉴|汉书)/
const fictionTitle = /(?:三国演义|评话|小说)/
const subjectAliases: Record<string, string[]> = {
  刘备: ['先主', '玄德', '昭烈帝'], 刘禅: ['后主'],
  曹操: ['太祖', '武帝', '孟德'], 曹丕: ['文帝', '子桓'], 曹叡: ['明帝'],
  孙权: ['吴主', '大帝', '仲谋'], 孙坚: ['孙破虏', '文台'], 孙策: ['孙讨逆', '伯符'],
}
const shortSubjectPredicate = /^(?:字|本字|姓|諱|讳|為|为|與|与|從|从|隨|随|率|領|领|據|据|呵|怒|壯|壮|雄|愛|爱|猶|犹|所|當|当|又|遂|乃|便|即|因|以|見|见|聞|闻|奔|出|入|破|拒|守|進|进|退|拜|遷|迁|卒|死|薨|斬|斩|受|得|遣|令)/

function sourceIsHistory(title: string) {
  const normalized = comparable(title)
  return historyTitle.test(normalized) && !fictionTitle.test(normalized)
}

function sourceUrl(value: string) {
  if (value.length > 1_200) return ''
  try { return /^https?:$/.test(new URL(value).protocol) ? value : '' } catch { return '' }
}

function identityTerms(name: string) {
  const normalized = comparable(name.trim())
  return [...new Set([normalized, ...(subjectAliases[normalized] ?? [])])]
    .filter(term => term.length >= 2)
    .sort((left, right) => right.length - left.length)
}

/** Reuse the source-attribution aliases for bounded character catalogue
 * relevance. A title such as 先主 may identify 刘备 in an episode source even
 * when that source does not write his personal name. */
export function textMentionsCharacterIdentity(name: string, text: string): boolean {
  const normalized = comparable(text)
  return identityTerms(name).some(term => normalized.includes(term))
}

// Require a subject at the start of a sentence/clause. Merely mentioning Liu Bei
// in another person's biography does not make that passage his life history.
function startsWithSubject(text: string, identities: string[], sectionShortName = '') {
  const unprefixed = text.replace(/^[\s「『“"【[（(]+/, '')
  if (identities.some(identity => unprefixed.startsWith(identity))) return true
  const head = unprefixed
    .replace(/^(?:初|后|后遂|及|时|是时|其后|既而)[，,]?/, '')
    .replace(/^(?:[\u3400-\u9fff]{1,8}(?:元|[一二三四五六七八九十百\d]+)年)[，,]?/, '')
  return identities.some(identity => head.startsWith(identity))
    || Boolean(sectionShortName && head.startsWith(sectionShortName)
      && shortSubjectPredicate.test(head.slice(sectionShortName.length)))
}

const appearanceBeginning = /^(?:身长|长[七八九一二三四五六十百尺]|容貌|姿貌|状貌|形貌|体貌|美姿|雄姿|有姿仪|仪表|须髯|美髯|髯长|耳垂|耳大|目能自顾其耳|垂手下膝|异相|骨相|肥白|魁梧|雄壮|瞋目|短小|瘦弱)/
const appearanceCue = /(?:身长|长[七八九一二三四五六十百尺]|容貌|姿貌|状貌|形貌|体貌|美姿|雄姿|有姿仪|仪表|须髯|美髯|髯长|耳垂|耳大|目能自顾其耳|垂手下膝|异相|骨相|肥白|魁梧|雄壮|瞋目|短小|瘦弱)/
const namedBiographicalHead = new RegExp(`^([\\u3400-\\u9fff]{1,4})(?:[，,])?(?:字|本字|号|姓|生于|生年|卒于|${appearanceCue.source})`)

function anotherBiographicalHead(text: string, identities: string[], sectionShortName = '') {
  if (appearanceBeginning.test(text) || startsWithSubject(text, identities, sectionShortName)) return false
  const match = text.match(namedBiographicalHead)
  return Boolean(match && !identities.includes(match[1]))
}

// These are only explicit omitted-subject continuations. An arbitrary next
// sentence may describe a different actor, so it never inherits attribution.
const omittedSubject = /^(?:少(?:孤|贫|有|好|善|与|从|学|仕)|年(?:少|[一二三四五六七八九十百\d]+)|性(?:宽|仁|急|刚|深|寡|好|嗜)|为人|不甚|喜(?:怒|结|读)|好(?:读|交|结|音|狗|美)|(?:常|尝|曾)(?:与|为|从|有|言|说|使|学|读|闻|在|率|亲)|拜|迁|累迁|入|出|从(?:军|事|征|学|游|讨)|随(?:军|征)|领|率|起兵|举兵|讨|破|败|卒|死|薨|身长|容貌|姿貌|垂手|顾自|有姿仪|美姿|髯长)/

function ownSentencePart(sentence: string, identities: string[], sectionShortName = '') {
  const clauses = [...sentence.matchAll(/[^，,]+[，,]?/g)]
  for (let index = 1; index < clauses.length; index += 1) {
    const clause = comparable(clauses[index][0]).replace(/[，,]$/, '').trim()
    if (anotherBiographicalHead(clause, identities, sectionShortName)) {
      return { quote: sentence.slice(0, clauses[index].index).replace(/[，,]$/, '').trim(), ended: true }
    }
  }
  return { quote: sentence, ended: false }
}

/** A one-character given-name reference is admissible only inside an exact
 * named section of a historical source, never in a whole multi-person volume. */
function citationSection(title: string, url: string): { section: string; conflict: boolean } {
  let fragment = ''
  try { fragment = decodeURIComponent(new URL(url).hash.slice(1)) } catch { /* Invalid URLs are rejected separately. */ }
  const titleFragment = title.includes('#') ? comparable(title.split('#').at(-1)?.trim() ?? '') : ''
  const urlFragment = comparable(fragment.trim())
  return { section: urlFragment || titleFragment, conflict: Boolean(titleFragment && urlFragment && titleFragment !== urlFragment) }
}

function sectionShortName(name: string, title: string, url: string): string {
  const normalized = comparable(name.trim())
  if (normalized.length < 2) return ''
  const { section, conflict } = citationSection(title, url)
  if (conflict) return ''
  return section === normalized ? normalized.at(-1) ?? '' : ''
}

function sourceSentences(content: string): string[] {
  const sentences: string[] = []
  const lines: string[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const previous = lines.at(-1)
    // Historical source clipping can break a quoted exclamation just before
    // its closing bracket. Join only that narrow, verifiable boundary; a
    // genuinely truncated quotation must not swallow later independent lines.
    if (previous && /^[」』”]/.test(line) && /[。！？；]$/.test(previous)
      && (previous.match(/[「『“]/g) ?? []).length > (previous.match(/[」』”]/g) ?? []).length) {
      lines[lines.length - 1] += line
    } else lines.push(line)
  }
  for (const line of lines) {
    let current = ''
    let quoteDepth = 0
    const flush = () => {
      if (current.trim()) sentences.push(current.trim())
      current = ''
    }
    for (const char of line) {
      if (char === '「' || char === '『' || char === '“') quoteDepth += 1
      if (char === '」' || char === '』' || char === '”') quoteDepth = Math.max(0, quoteDepth - 1)
      current += char
      if (quoteDepth === 0 && (/[。！？；]/.test(char)
        || (/[」』”]/.test(char) && /[。！？；][」』”]$/.test(current)))) flush()
    }
    flush()
  }
  return sentences
}

/** Select attributable original passages from an already completed lookup.
 * This function performs no retrieval, summarization, or model inference. */
export function extractCharacterBiographicalEvidence(name: string, sources: CharacterBiographySource[]): CharacterBiographyEvidence[] {
  const identities = identityTerms(name)
  if (!identities.length) return []
  const evidence: CharacterBiographyEvidence[] = []
  const seen = new Set<string>()
  for (const source of sources) for (const citation of source.citations) {
    const url = sourceUrl(citation.url)
    if (!url || !sourceIsHistory(citation.title) || citationSection(citation.title, url).conflict) continue
    const shortName = sectionShortName(name, citation.title, url)
    const sentences = sourceSentences(citation.content)
    let active = false
    let pending = ''
    const flush = () => {
      if (!pending) return
      const normalized = comparable(pending).replace(/\s+/g, '')
      if (!seen.has(normalized)) {
        seen.add(normalized)
        evidence.push({ title: citation.title.slice(0, 200), url, quote: pending })
      }
      pending = ''
    }
    for (const sentence of sentences) {
      const normalized = comparable(sentence)
      const explicit = startsWithSubject(normalized, identities, shortName)
      const continuation = active && (omittedSubject.test(normalized) || appearanceBeginning.test(normalized)) && !anotherBiographicalHead(normalized, identities, shortName)
      if (!explicit && !continuation) { active = false; flush(); continue }
      const part = ownSentencePart(sentence, identities, shortName)
      if (!part.quote) { active = false; flush(); continue }
      const addition = part.quote.length > 800 ? `${part.quote.slice(0, 799)}…` : part.quote
      if (pending && pending.length + addition.length > 800) flush()
      pending += addition
      active = !part.ended && part.quote.length <= 800
      if (!active) flush()
    }
    flush()
  }
  return evidence.slice(0, 8)
}

function portraitEvidence(value: unknown, name: string): { evidence: CharacterBiographyEvidence[]; unverified: string } {
  const identities = identityTerms(name)
  const portrait = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rows = Array.isArray(portrait.citations) ? portrait.citations : []
  const seen = new Set<string>()
  const evidence: CharacterBiographyEvidence[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    if (typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.quote !== 'string') continue
    const url = sourceUrl(item.url)
    const shortName = sectionShortName(name, item.title, url)
    const sentences = sourceSentences(item.quote)
    let active = true // A legacy, already extracted quote may omit its subject.
    const parts: string[] = []
    for (const sentence of sentences) {
      const normalized = comparable(sentence)
      const explicit = startsWithSubject(normalized, identities, shortName)
      if (!explicit && !(active && appearanceBeginning.test(normalized))) { active = false; continue }
      const part = ownSentencePart(sentence, identities, shortName)
      active = !part.ended
      if (appearanceCue.test(comparable(part.quote))) parts.push(part.quote)
    }
    const quote = parts.join('')
    const key = comparable(quote).replace(/\s+/g, '')
    if (!url || !quote || !sourceIsHistory(item.title) || citationSection(item.title, url).conflict || seen.has(key)) continue
    seen.add(key)
    evidence.push({ title: item.title.slice(0, 200), url, quote: quote.length > 600 ? `${quote.slice(0, 599)}…` : quote })
  }
  return { evidence: evidence.slice(0, 4), unverified: !rows.length && typeof portrait.description === 'string' ? portrait.description.trim().slice(0, 600) : '' }
}

function evidenceText(evidence: CharacterBiographyEvidence[], budget: number) {
  const entries: string[] = []
  let length = 0
  for (const item of evidence) {
    const entry = `“${item.quote}”\n来源：${item.title}\n${item.url}`
    if (length + entry.length + 2 > budget) continue
    entries.push(entry)
    length += entry.length + 2
  }
  return entries.join('\n\n')
}

/** Compose library biography notes from existing historical and design data.
 * Quotes stay in their original wording; visual choices are labelled separately.
 * Section budgets keep source links intact and the persisted text below 10,000. */
export function buildCharacterBiography(character: CharacterBiographyInput, sources: CharacterBiographySource[]): string {
  const life = evidenceText(extractCharacterBiographicalEvidence(character.name, sources), Math.floor(CHARACTER_BIOGRAPHY_MAX_LENGTH * 0.46))
  const portrait = portraitEvidence(character.historicalPortrait, character.name)
  const retrievalFailed = Boolean(character.historicalPortrait && typeof character.historicalPortrait === 'object'
    && (character.historicalPortrait as Record<string, unknown>).status === 'retrieval_failed')
  const appearance = evidenceText(portrait.evidence, Math.floor(CHARACTER_BIOGRAPHY_MAX_LENGTH * 0.26))
  let visualText = ''
  try { visualText = characterVisualContextDesignText(normalizeCharacterVisualContext(character.visualContext)) } catch { /* Existing malformed design data is not historical evidence. */ }
  const design = [character.description?.trim().slice(0, 1_000), visualText.slice(0, 1_000)].filter(Boolean).join('\n')
  return [
    `${character.name.trim().slice(0, 100)}的人物自传资料（复用已有检索结果整理，保留原文）`,
    `【正史生平原文】\n${life || (retrievalFailed ? missingLifeDueFailure : missingLife)}`,
    `【正史体貌记载】\n${appearance ? `以下引文仅证明其中记载的体格、威仪或事件神态；不能据此推定具体身高、脸型、肤色及须发。\n${appearance}` : retrievalFailed ? missingAppearanceDueFailure : missingAppearance}${portrait.unverified ? `\n已有体貌资料（缺少可核对的来源，暂不作为史实）：${portrait.unverified}` : ''}`,
    `【当前剧作外观设定】\n以下为当前剧情的年龄、服饰与造型设定，不作为正史体貌记载。\n${design || '暂无已填写的外观与造型设定。'}`,
  ].join('\n\n')
}

const generatedBiographyHeader = /的人物自传资料（复用已有检索结果整理，保留原文）/
const missingLife = '本次已有检索结果中暂无可明确归属于该人物的可靠生平原文；不据其他人物的记载推写。'
const missingAppearance = '本次已有检索结果中暂无可靠正史体貌记载。'
const missingLifeDueFailure = '本次正史生平检索失败，暂不能判定有无相关记载。'
const missingAppearanceDueFailure = '本次正史体貌检索失败，暂不能判定有无相关记载。'
const historicalSections = [
  { heading: '【正史生平原文】', placeholders: [missingLife, missingLifeDueFailure] },
  { heading: '【正史体貌记载】', placeholders: [missingAppearance, missingAppearanceDueFailure] },
]

function sectionBody(biography: string, heading: string): string | undefined {
  const start = biography.indexOf(`${heading}\n`)
  if (start < 0) return undefined
  const bodyStart = start + heading.length + 1
  const next = biography.indexOf('\n\n【', bodyStart)
  return biography.slice(bodyStart, next < 0 ? undefined : next)
}

/** Manual text and explicit clearing are authoritative. Only the exact
 * machine-generated no-evidence phrases are eligible for source backfill. */
export function biographyNeedsEvidenceCompletion(biography: string | undefined): boolean {
  if (biography === undefined) return true
  if (!generatedBiographyHeader.test(biography)) return false
  return historicalSections.some(({ heading, placeholders }) => placeholders.some(placeholder => sectionBody(biography, heading)?.includes(placeholder)))
}

export function mergeCharacterBiographyEvidence(current: string | undefined, sourced: string): string | undefined {
  if (current === undefined) return sourced
  if (!biographyNeedsEvidenceCompletion(current)) return undefined
  let merged = current
  for (const { heading, placeholders } of historicalSections) {
    const oldBody = sectionBody(merged, heading)
    const newBody = sectionBody(sourced, heading)
    if (!oldBody || !newBody) continue
    const oldPlaceholder = placeholders.find(placeholder => oldBody.includes(placeholder))
    if (!oldPlaceholder || newBody.includes(oldPlaceholder)) continue
    const start = merged.indexOf(`${heading}\n`) + heading.length + 1
    const placeholderAt = oldBody.indexOf(oldPlaceholder)
    const preservedBody = oldBody.slice(0, placeholderAt) + newBody + oldBody.slice(placeholderAt + oldPlaceholder.length)
    merged = merged.slice(0, start) + preservedBody + merged.slice(start + oldBody.length)
  }
  return merged === current ? undefined : merged
}
