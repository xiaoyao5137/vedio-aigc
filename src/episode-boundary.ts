/** The workbook allocates a story beat to an episode. A shared historical
 * chapter can prove that beat happened without making it part of this episode.
 * Keep the adjacent rows as editorial scope, never as additional evidence. */
export type EpisodeBoundary = {
  version: 'episode-boundary-v1'
  current: { number: number; title: string }
  previous: { number: number; title: string }[]
  next: { number: number; title: string }[]
}

type Value = Record<string, unknown>
const object = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined
const meaningful = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function parseEpisodeBoundary(value: unknown, expectedNumber?: unknown, expectedTitle?: unknown): EpisodeBoundary | undefined {
  const boundary = object(value)
  const current = object(boundary?.current)
  const validNeighbor = (item: unknown): item is { number: number; title: string } => {
    const row = object(item)
    return !!row && Number.isSafeInteger(row.number) && Number(row.number) > 0 && meaningful(row.title)
  }
  if (boundary?.version !== 'episode-boundary-v1' || !current || !validNeighbor(current)
    || !Array.isArray(boundary.previous) || !boundary.previous.every(validNeighbor)
    || !Array.isArray(boundary.next) || !boundary.next.every(validNeighbor)) return undefined
  if (expectedNumber !== undefined && Number(expectedNumber) !== current.number) return undefined
  if (expectedTitle !== undefined && String(expectedTitle) !== current.title) return undefined
  if (boundary.previous.some(item => item.number >= current.number)
    || boundary.next.some(item => item.number <= current.number)) return undefined
  return boundary as EpisodeBoundary
}

export const EPISODE_BOUNDARY_PROMPT = `【策划表分集边界】
本集及邻集的策划归属：\${input.episode_boundary}。
这份邻集清单只划分剧情归属，不是史料，也不能替代历史引文。即使同一卷史书接着写了后事，本集也只拍本集标题所指事件及理解其不可缺少的前提、当场后果；留给后续集标题的决定性行动和结果不得在本集 requiredBeats、结尾 payoff 或人物终态中提前完成。可以留下仍未解决的危险和悬念，不能把后集已发生的结局当悬念来演。若一个动作同时见于本集史料与邻集标题，按本集标题所需的最小因果范围划分，不机械按相同词语删掉史实；拿不准时收在本集行动前，并在 adaptationBoundary 写清停点。
【策划表分集边界结束】`

/** Existing saved prompts may contain user edits. Replace only our own block,
 * or insert once ahead of the source evidence; runtime hydration and a saved
 * config migration use this same idempotent function. */
export function refreshEpisodeBoundaryPrompt(prompt: string): string {
  const block = /【策划表分集边界】[\s\S]*?【策划表分集边界结束】/g
  let found = false
  const refreshed = prompt.replace(block, () => {
    if (found) return ''
    found = true
    return EPISODE_BOUNDARY_PROMPT
  })
  if (found) return refreshed
  const anchor = '唯一事实依据（目录、无关篇章不算证据）：'
  const position = refreshed.indexOf(anchor)
  return position < 0 ? refreshed + '\n\n' + EPISODE_BOUNDARY_PROMPT
    : refreshed.slice(0, position) + EPISODE_BOUNDARY_PROMPT + '\n\n' + refreshed.slice(position)
}

export const EPISODE_BOUNDARY_REVIEW_PROMPT = `【策划表分集归属审查】
本集及邻集策划归属：\${input.episode_boundary}。邻集标题不是史料。仅检查候选实际 requiredBeats 声画、完整戏结果、人物终态和 episodeDrama.payoff 是否已演完邻集才拥有的决定性行动；史料原文、historicalLocks、adaptationSpace.forbidden 中如实记载后事本身不算越集。发现越集时给出当前 scene/beat/path 原句和邻集集数、标题，要求停在本集行动及尚未解决的危险，不能删去本集确需的史实。不要凭相同词语误判一件横跨两集的复合事件。
【策划表分集归属审查结束】`

export function refreshEpisodeBoundaryReviewPrompt(prompt: string): string {
  const section = /【策划表分集归属审查】[\s\S]*?【策划表分集归属审查结束】/g
  let found = false
  const refreshed = prompt.replace(section, () => {
    if (found) return ''
    found = true
    return EPISODE_BOUNDARY_REVIEW_PROMPT
  })
  if (found) return refreshed
  const candidate = refreshed.indexOf('\n【当前候选')
  const reference = candidate >= 0 ? candidate : refreshed.indexOf('\n${')
  return reference >= 0 ? refreshed.slice(0, reference) + '\n' + EPISODE_BOUNDARY_REVIEW_PROMPT + refreshed.slice(reference)
    : refreshed + '\n' + EPISODE_BOUNDARY_REVIEW_PROMPT
}

/** Applies to the existing code node without replacing any hand-edited source
 * request or workbook attachment. The returned fields flow into context.input. */
export function refreshSanguoContextBoundaryCode(code: string): string {
  if (code.includes('episode-boundary-v1')) return code
  const rowAnchor = 'const row = parsed.rows[matchedIndex]'
  const titleAnchor = "  episode_title: row['集名'],"
  if (code.split(rowAnchor).length !== 2 || code.split(titleAnchor).length !== 2) return code
  const neighborCode = `const neighboringEpisodes = parsed.rows
  .map((item) => ({ number: Number(item['集数']), title: String(item['集名'] || '').trim() }))
  .filter((item) => Number.isSafeInteger(item.number) && item.title)
const episodeBoundary = {
  version: 'episode-boundary-v1',
  current: { number: episodeNumber, title: String(row['集名'] || '').trim() },
  previous: neighboringEpisodes.filter((item) => item.number < episodeNumber).slice(-1),
  next: neighboringEpisodes.filter((item) => item.number > episodeNumber).slice(0, 3),
}`
  return code.replace(rowAnchor, rowAnchor + '\n' + neighborCode)
    .replace(titleAnchor, titleAnchor + '\n  episode_boundary: episodeBoundary,')
}

export function upgradeEpisodeBoundary<N extends { id: string; prompt: string; code?: string },
  W extends { id: string; schemaVersion?: number; nodes: N[] }>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 148) return workflow
  let changed = false
  const nodes = workflow.nodes.map(node => {
    const next = node.id === 'sanguo-context-init' && typeof node.code === 'string'
      ? { ...node, code: refreshSanguoContextBoundaryCode(node.code) }
      : node.id === 'sanguo-scene-outline' ? { ...node, prompt: refreshEpisodeBoundaryPrompt(node.prompt) }
        : node.id === 'sanguo-scene-outline-review' ? { ...node, prompt: refreshEpisodeBoundaryReviewPrompt(node.prompt) } : node
    if (next !== node && (next.prompt !== node.prompt || next.code !== node.code)) changed = true
    return next
  })
  return changed || (workflow.schemaVersion ?? 0) < 149
    ? { ...workflow, schemaVersion: Math.max(149, workflow.schemaVersion ?? 0), nodes } : workflow
}

// Conservative action families. A title reserves an action, not every word it
// contains. High-confidence visualized outcomes are blocked; incidental source
// facts and editorial "forbidden" notes are not treated as staged action.
const futureActions = [
  { title: /行刺|刺杀|暗杀|遇害|被刺/u, action: /行刺|刺杀|暗杀|谋杀|遇害|被刺|被害|行凶|携首|持首/u, victimBound: /杀死|杀害|害死|身亡|被杀/u },
  { title: /归降|投降|请降/u, action: /归降|投降|请降|献城投降/u },
  { title: /处死|就戮|斩首/u, action: /处死|就戮|斩首|砍头处决/u },
  { title: /火攻|焚烧|纵火/u, action: /火攻|焚烧|纵火|放火烧/u },
  { title: /被俘|生擒|擒获/u, action: /被俘|生擒|擒获|活捉/u },
]

function protagonistNames(outline: Value, title: string): string[] {
  const dramas = Array.isArray(outline.characterDramas) ? outline.characterDramas : []
  return dramas.map(object).filter((item): item is Value => !!item).map(item => item.name)
    .filter((name): name is string => meaningful(name) && name.length >= 2 && title.includes(name))
}

function stagedText(beat: Value): string {
  const observable = object(beat.observable)
  const visual = Array.isArray(observable?.visual) ? observable.visual.filter(meaningful) : []
  const audio = Array.isArray(observable?.audio) ? observable.audio.filter(meaningful) : []
  return [beat.description, beat.stateChange, ...visual, ...audio].filter(meaningful).join(' ')
}

function victimOutcome(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:杀死|杀害|害死|刺杀|暗杀).{0,12}${escaped}|${escaped}.{0,24}(?:遇害|身亡|被杀|被害|被刺|被.{0,12}杀死|被.{0,12}杀害)`, 'u').test(text)
}

function isUnfinishedDanger(clause: string): boolean {
  // Conditional speech and a character's fear are part of the present story;
  // they do not establish the next episode's actual outcome. A draft may also
  // explicitly say it does *not* depict that outcome; that editorial exclusion
  // must not be mistaken for a staged event simply because it names the event.
  const editorialExclusion = /(?:不|未|没有|尚未|并未|不曾|不得|不能|不要)(?:(?:在本集|于本集|在此处|在结尾|在画面中|提前|实际|直接|当场)){0,2}(?:呈现|展示|表现|拍出|拍摄|演出|上演|写出|发生|出现|展开)/u
  return (/(?:担心|担忧|恐怕|恐会|可能|也许|若|如果|假如|预感|警告|提醒|劝诫|风险|隐患|防止|避免|尚未|未曾|没有|拒绝|不愿|不许|不让|险些|差点|会被|会遭|将被)/u.test(clause)
    || editorialExclusion.test(clause))
    && !/(?:已经|已然|最终|终于|确认|确已|事实|身亡|遗体|凶手|后果得到|真的发生)/u.test(clause)
}

function enactsFutureAction(text: string, family: typeof futureActions[number], protagonists: string[], subject?: string): boolean {
  if (subject && !text.includes(subject)) return false
  // Contrasting actions can occur without punctuation; a negated warning
  // before "而/但/却" must not mask a real later action. Keep temporal words
  // with their subjects so "张飞最终被杀" remains detectable.
  return text.split(/[，。；\n]|(?:但|却|而)/u).some(clause => {
    if (isUnfinishedDanger(clause)) return false
    return family.action.test(clause)
      || Boolean(family.victimBound?.test(clause) && protagonists.some(name => victimOutcome(clause, name)))
  })
}

function namedFutureSubject(title: string, family: typeof futureActions[number]): string | undefined {
  const match = title.match(family.title)
  const prefix = match ? title.slice(0, match.index).trim() : ''
  if (!/^[\p{Script=Han}]{2,3}$/u.test(prefix) || /^(?:帐下|營中|营中|军中|宮中|宫中|夜半|临行|臨行|江上|城中|城外)$/u.test(prefix)) return undefined
  return prefix
}

export function validateEpisodeNarrativeBoundary(outlineValue: unknown, inputValue: unknown, required = false): void {
  const outline = object(outlineValue)
  const input = object(inputValue)
  const boundary = parseEpisodeBoundary(input?.episode_boundary, input?.episode_number, input?.episode_title)
  if (!boundary) {
    if (required) throw new Error('EPISODE_BOUNDARY_MISSING: 当前大纲缺少与策划表当前集匹配的邻集边界；请从「策划表输入整理」节点重跑，勿先请求付费文本模型')
    return
  }
  if (!outline || !Array.isArray(outline.scenes)) return
  const currentTitle = boundary.current.title
  const protagonists = protagonistNames(outline, currentTitle)
  const issues: string[] = []
  for (const later of boundary.next) {
    const family = futureActions.find(item => item.title.test(later.title) && !item.title.test(currentTitle))
    if (!family) continue
    const subject = namedFutureSubject(later.title, family)
    const report = (path: string, text: string) => {
      if (enactsFutureAction(text, family, protagonists, subject)) issues.push(
        `EPISODE_BOUNDARY_SPILL: 第${boundary.current.number}集《${currentTitle}》${path} 已拍出或宣称完成第${later.number}集《${later.title}》的决定性行动/结果（${text.slice(0, 72)}）；请停在本集当场变化，后集事件留待后集`)
    }
    const payoff = object(object(outline.episodeDrama)?.payoff)
    if (meaningful(payoff?.description)) report('episodeDrama.payoff.description', payoff.description)
    if (Array.isArray(outline.dramaticScenes)) outline.dramaticScenes.forEach((value, index) => {
      const scene = object(value)
      if (meaningful(scene?.result)) report(`dramaticScenes[${index}].result`, scene.result)
      if (Array.isArray(scene?.characterStates)) scene.characterStates.forEach((stateValue, stateIndex) => {
        const after = object(object(stateValue)?.after)
        for (const key of ['knowledge', 'relationships', 'choices']) {
          const entries = after?.[key]
          if (Array.isArray(entries)) entries.filter(meaningful).forEach((entry, entryIndex) =>
            report(`dramaticScenes[${index}].characterStates[${stateIndex}].after.${key}[${entryIndex}]`, entry))
        }
      })
    })
    outline.scenes.forEach((sceneValue, sceneIndex) => {
      const scene = object(sceneValue)
      if (!scene || !Array.isArray(scene.requiredBeats)) return
      scene.requiredBeats.forEach((beatValue, beatIndex) => {
        const beat = object(beatValue)
        if (!beat) return
        const text = stagedText(beat)
        if (!text) return
        report(`scenes[${sceneIndex}].requiredBeats[${beatIndex}]`, text)
      })
    })
  }
  if (issues.length) throw new Error([...new Set(issues)].join('\n'))
}
