import { allowsEmptyEditorialCast } from './history-drama.ts'

type RecordValue = Record<string, unknown>

export function mergeOutlineContentRepairs(original: RecordValue, repaired: RecordValue, feedback: string) {
  if (!Array.isArray(original.scenes) || !Array.isArray(repaired.scenes)) throw new Error('HISTORY_REPAIR_INVALID: 修复大纲缺少scenes')
  const scenes = original.scenes as RecordValue[]
  const targeted = new Set([...feedback.matchAll(/"itemId"\s*:\s*"([^"]+)"/g)].map(match => match[1]))
  if (!targeted.size) for (const scene of scenes) if (feedback.includes(String(scene.id))) targeted.add(String(scene.id))
  if (!targeted.size) throw new Error('HISTORY_REPAIR_INVALID: 审查没有指出具体场景，不能无目标重写整集')
  const replacements = new Map((repaired.scenes as RecordValue[]).map(scene => [String(scene.id), scene]))
  const merged = scenes.flatMap(scene => {
    if (!targeted.has(String(scene.id))) return [scene]
    const replacement = replacements.get(String(scene.id))
    if (!replacement) throw new Error(`HISTORY_REPAIR_INVALID: 修复遗漏原场景${String(scene.id)}，禁止删剧情`)
    // Additional parts must explicitly belong to the flagged scene. Unrelated
    // additions or rewrites never leak into the accepted episode.
    const parts = (repaired.scenes as RecordValue[]).filter(part => String(part.id).startsWith(`${String(scene.id)}-part-`))
    if (parts.length) {
      const beats = [replacement, ...parts].flatMap(part => Array.isArray(part.requiredBeats) ? part.requiredBeats as RecordValue[] : [])
      for (const beat of Array.isArray(scene.requiredBeats) ? scene.requiredBeats as RecordValue[] : []) {
        if (!beats.some(part => part.id === beat.id)) throw new Error(`HISTORY_REPAIR_INVALID: 拆段遗漏${String(beat.id)}`)
      }
    }
    return [replacement, ...parts]
  })
  return { ...original, scenes: merged.length === scenes.length ? merged : merged.map((scene, i) => ({ ...scene, sequence: i + 1 })) }
}

/** Report every violation in one pass. The writer shares a three-generation budget between
 * structural correction and editorial rewrite, so one defect per round could never converge:
 * each round fixed the reported scene and only then revealed the next one. Lines keep their
 * original `PREFIX: <sceneId> …` shape because callers match that prefix and extract the id.
 * Both guards stay self-contained on purpose: `validateHistoricalAgency.toString()` is embedded
 * into persisted gate code and runs in a sandbox, so it cannot close over module scope. */
export function validateHistoricalProductionPlan(candidate: RecordValue) {
  if (!Array.isArray(candidate?.scenes) || !candidate.scenes.length) throw new Error('HISTORY_PLAN_INVALID: 大纲缺少 scenes')
  const problems: string[] = []
  for (const scene of candidate.scenes as RecordValue[]) {
    const emptyCastAllowed = allowsEmptyEditorialCast(scene)
    if (!Array.isArray(scene.cast) || (!emptyCastAllowed && !scene.cast.length) || scene.cast.length > 2
      || scene.cast.some(name => typeof name !== 'string' || !name.trim()) || new Set(scene.cast).size !== scene.cast.length) {
      problems.push(`HISTORY_PLAN_CAST_OVERFLOW: ${String(scene.id)} 人物实景必须列出1–2位具名行动人物cast；动画地图、历史蒙太奇及不含人物表演的live_action环境承接镜头可使用空cast，更多人物要完整拆为连续段。`)
    }
  }
  if (problems.length) throw new Error([...new Set(problems)].join('\n'))
}

/** Regression guard for an observed causal fabrication that the model critic
 * incorrectly approved. Scope it to the actual source passage, not every story. */
export function validateHistoricalAgency(candidate: RecordValue, citations: RecordValue[]) {
  const source = citations.map(c => String(c.content ?? '')).join('\n').replace(/〈[^〉]*〉/g, '')
  if (!/二家[賓宾]客[，,、\s]*互相[譏讥譥]揣[，,、\s]*遂各[樹树]朋徒/.test(source)) return
  const scenes = Array.isArray(candidate.scenes) ? candidate.scenes as RecordValue[]
    : Array.isArray(candidate.__storyboardSegments) ? candidate.__storyboardSegments as RecordValue[] : [candidate]
  const problems: string[] = []
  for (const scene of scenes) {
    const beats = Array.isArray(scene.requiredBeats) ? scene.requiredBeats as RecordValue[] : []
    // Keep the field each scanned sentence came from. A rejection that quotes no field told the writer
    // nothing about what to edit, so record-vrwgoy resubmitted the identical
    // requiredBeats[2].function “呈现房植的矜持和内心波动,暗示其默许宾客行动” in all four paid outline
    // attempts and died with a clean scene list. Names and sentences are cited,剧情 is not rewritten.
    const fragments: { path: string; text: string }[] = []
    const push = (path: string, value: unknown) => { if (typeof value === 'string' && value.trim()) fragments.push({ path, text: value }) }
    push('title', scene.title)
    push('purpose', scene.purpose)
    beats.forEach((beat, beatIndex) => {
      const at = `requiredBeats[${beatIndex}]`
      push(`${at}.description`, beat.description)
      push(`${at}.function`, beat.function)
      push(`${at}.stateChange`, beat.stateChange)
      const observable = (beat.observable ?? {}) as RecordValue
      if (Array.isArray(observable.visual)) observable.visual.forEach((value, index) => push(`${at}.observable.visual[${index}]`, value))
      if (Array.isArray(observable.audio)) observable.audio.forEach((value, index) => push(`${at}.observable.audio[${index}]`, value))
    })
    push('videoPrompt', scene.videoPrompt)
    push('audioText', scene.audioText)
    const action = fragments.map(fragment => fragment.text).join('。')
    const cited = (pattern: RegExp, extra?: { path: string; text: string }[]) => {
      const hits = [...new Set((extra ?? fragments).filter(fragment => pattern.test(fragment.text))
        .map(fragment => `${fragment.path}「${fragment.text.length > 60 ? `${fragment.text.slice(0, 60)}…` : fragment.text}」`))]
      if (!hits.length) return ''
      return `触发原文：${hits.slice(0, 3).join('；')}。只改写被点名句子里的行动主体与时代提法，该场其余描述、台词与锚点逐字保留。`
    }
    if (/科[舉举](?:取士|制|考試|考试)?/.test(action)) problems.push(`HISTORY_CONTENT_REJECTED: ${String(scene.id)} 将科举取士写入东汉甘陵党议，制度年代不符。删除这一错误比拟，用本集有据的举荐、声望或授学关系表达人物交锋。${cited(/科[舉举](?:取士|制|考試|考试)?/)}`)
    // 门下/门徒 与 门客/门生/宾客 同指主家的追随者群体，绝不能算作周福、房植本人；
    // 且不满/召集等谓语只在其归属主体紧邻时才算数，跨度不得越过另一位主体，
    // 否则“擢升周福为尚书…引出房植门下的不满”会被错误锚定到周福本人。
    const indirectAuthority = /(?:周福|房植)(?![賓宾]客|[門门][生客下徒]|[氏家][賓宾]客)(?:(?!周福|房植)[^。；\n]){0,18}(?:间接默许|默[許许]|自行[處处]置|自己看[著着][辦办])/
    if (indirectAuthority.test(action) && /[賓宾]客|[門门][生客下徒]/.test(action)) problems.push(`HISTORY_CONTENT_REJECTED: ${String(scene.id)} 以主人默许或让宾客自行处置来间接授权党议，仍改变史料记载的宾客自主行动。改由宾客之间做出应对，不编造主人接报、请示与授权的因果。${cited(indirectAuthority)}`)
    // “门客对歌谣暗示周福因师恩得官的理解与不满”：周福只是“对”字宾语从句里被谈论的人，
    // 不满是门客的反应，不能锚定到周福本人。只有本人直接作主语（房植面露不悦、房植的不满）才算，
    // “对…周福/房植…的…不满/嫉妒”这一名物化表达不能作为本人不满的依据。
    const principalResentmentPattern = /(?<![對对])(?:周福|房植)(?![賓宾]客|[門门][生客下徒]|一方|派|[的之](?:[賓宾]客|[門门][生客下徒]))(?:(?!周福|房植)[^。；\n]){0,20}(?:不[滿满悦悅]|嫉[妒忌]|怨[憤愤恨])/
    const principalResentmentFragments = fragments.filter(fragment => [...fragment.text.matchAll(new RegExp(principalResentmentPattern.source, 'g'))].some(match => {
      const prefix = fragment.text.slice(0, match.index!).split(/[，,。；;\n]/).at(-1) ?? ''
      const afterName = match[0].slice(2)
      // A principal inside what the retainer describes is not the speaker:
      // "陈述房植功绩并表达对谣谚的不满" belongs to the retainer. Restrict
      // this exemption to concrete attributes, never reported emotions or
      // explicit attribution such as "陈述房植本人对歌谣的不满".
      const describedAttribute = /(?:[陳陈]述|[講讲]述|[轉转]述|介[紹绍]|提及|[稱称][讚赞]|[敘叙]述)$/.test(prefix)
        && /^(?:[的之])?(?:功[績绩]|政[績绩]|[師师]道|德|[聲声]望|[學学][問问]|官[職职])/.test(afterName)
        && !/(?:本人|自己|其|他)/.test(afterName)
      // Apply the existing "对...principal...的理解与不满" object rule
      // per matched clause. An unrelated retainer complaint must not hide a
      // separate, explicit statement of the principal's own resentment.
      const directedAtPrincipal = /[對对][^，,。；;\n]*$/.test(prefix) && /的[^。；\n]*(?:不[滿满悦悅]|嫉[妒忌]|怨[憤愤恨])/.test(afterName)
      return !describedAttribute && !directedAtPrincipal
    }))
    if (principalResentmentFragments.length && /升[遷迁]|擢升|[謠谣]|[譏讥]揣|因[師师][獲获]印/.test(action)) {
      problems.push(`HISTORY_CONTENT_REJECTED: ${String(scene.id)} 把宾客之间的讥揣归因于周福或房植本人嫉妒、不满，原文没有支持两位本人的政治动机。由宾客承担接报与不满反应，保留矛盾升级，不得借拟制改变历史人物核心立场。${cited(principalResentmentPattern, principalResentmentFragments)}`)
    }
    const eraInPrompt = { path: 'visualPrompt', text: String(scene.visualPrompt ?? '') }
    if (/(?:蠡吾侯|拜[師师]|受[學学]|求[學学]|授[業业])/.test([scene.title, action].join('。')) && /延熹|永康/.test(eraInPrompt.text)) {
      problems.push(`HISTORY_CONTENT_REJECTED: ${String(scene.id)} 把即位前受学写入桓帝即位后的年号；依据“初…为蠡吾侯…受学…及即帝位”的先后关系，删除无依据年号并保留受学动作。${cited(/延熹|永康/, [eraInPrompt])}`)
    }
    const wrongEra = /建[寧宁](?:元|[一二三四五六七八九十]+)年[，,\s]*(?:漢|汉)?桓帝(?:即|登)位/
    if (wrongEra.test(action)) problems.push(`HISTORY_CONTENT_REJECTED: ${String(scene.id)} 把桓帝即位写入建宁年间，年代不符。不要把本集概括时段套在回溯背景上；删除无依据年月并保留先后关系。${cited(wrongEra)}`)
    const actualLeaderPattern = /(?:周福|房植)(?![賓宾]客|[門门][生客下徒]|一方|派|[與与]|[的之](?:[賓宾]客|[門门][生客下徒]))(?:(?!周福|房植)[^。；\n]){0,35}(?:召集|授意|[吩咐]{2}|[號号]令|[組组][織织]|[領领]命|[聯联][絡络]同道|[結结]交朋徒|默[許许]|[準准][許许]|同意)/
    const actualLeader = actualLeaderPattern.test(action)
    if (actualLeader && /[陣阵][營营]|朋徒|同道|[黨党][爭争]|聚[眾众]|[勢势]力|[對对]抗|[結结][黨党]/.test(action)) {
      problems.push(`HISTORY_CONTENT_REJECTED: ${String(scene.id)} 将二家宾客“互相讥揣，遂各树朋徒”改成周福或房植本人召集授意，改变了史料行动主体。由宾客承担原有结交、对抗动作，保留阵营形成的剧情；不得用拟制边界掩盖这一主体替换。${cited(actualLeaderPattern)}`)
    }
  }
  if (problems.length) throw new Error([...new Set(problems)].join('\n'))
}

/** Refresh only the embedded agency guard, preserving all editable gate logic. */
export function refreshEmbeddedHistoricalAgencyCode(code: string) {
  const start = code.indexOf('(function validateHistoricalAgency')
  const end = start < 0 ? -1 : code.indexOf(')(candidate, sources);', start)
  return start < 0 || end < 0 ? code : code.slice(0, start) + '(' + validateHistoricalAgency.toString() + code.slice(end)
}
