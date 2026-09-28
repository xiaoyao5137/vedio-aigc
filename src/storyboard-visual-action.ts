/** Conservative executable proof for approved collective visual actions. This
 * is a grammar, not semantic similarity: subjects and the complete predicate
 * stay fixed, and only source-approved neutral adjuncts may be inserted. */
export type SourceVisualAction = { anchor: string; actorIds: string[]; predicate: string; adjuncts: string[] }
type Action = { kind: string; actorIds: string[]; textOrVocalization: string; performanceInstruction?: string }
const collective = /^(两人|二人|双方)(.*?)(相遇|会面|碰面|交谈|对视|握手|拥抱|互相行礼|相向行礼|并肩行走|并肩站立)$/
const forbidden = /未|不|无|没有|禁止|不得|不能|尚待|准备|打算|即将|将要|等待|计划|约定|预定|想要|想象|回忆|曾经|梦见|如果|假如|若|仿佛|看见|看到|注视|凝视|看着|望着|目睹|目送|观望|提到|提及|转述|讲述|描述|声称|表示|证明|确认|宣告|完成|实现|形成|建立|要求|示意|命令|让|使|闪现|瞬移|切镜/
const knownPredicates = /相遇|会面|碰面|交谈|对视|握手|拥抱|行礼|行走|站立/
const plainString = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const subjectForms = (actors: string[]) => ['两人', '二人', '双方', ...['与', '和', '、', '及'].flatMap(join => [actors.join(join), [...actors].reverse().join(join)])]
function safeAdjunct(value: string, actors: string[], setting?: string) {
  const syntax = setting ? value.replaceAll(setting, '@place') : value
  return value === '' || value.length <= 40 && /^(?:在|于|从|沿|各持|手持|持着|拿着)/.test(value)
    && !/[，,。；;\n：:“”"‘’'！？!?]/.test(value) && !forbidden.test(syntax) && !knownPredicates.test(syntax)
    && !actors.some(actor => value.includes(actor))
}

/** Never infer the approved pair from candidate actorIds. With ambiguous
 * source casts, keep the original exact contract instead of guessing. */
export function sourceVisualActions(anchors: string[], cast: unknown, sourceTexts: string[], setting?: string): SourceVisualAction[] {
  if (!Array.isArray(cast) || cast.length !== 2 || !cast.every(plainString) || new Set(cast).size !== 2
    || cast.some((actor, index) => cast.some((other, otherIndex) => index !== otherIndex && actor.includes(other)))) return []
  const actors = cast as string[]
  return anchors.flatMap(anchor => {
    const parsed = anchor.match(collective)
    if (!parsed || !safeAdjunct(parsed[2], actors, setting)) return []
    const predicate = parsed[3], requiredAdjunct = parsed[2], adjuncts = new Set([requiredAdjunct])
    if (setting && !requiredAdjunct) for (const prefix of ['在', '于']) if (safeAdjunct(prefix + setting, actors, setting)) adjuncts.add(prefix + setting)
    for (const clause of sourceTexts.flatMap(text => text.split(/[，,。；;\n]/))) {
      for (const subject of subjectForms(actors)) {
        if (!clause.startsWith(subject)) continue
        const rest = clause.slice(subject.length), predicateIndex = rest.indexOf(predicate)
        if (predicateIndex < 0) continue
        const adjunct = rest.slice(0, predicateIndex)
        if (safeAdjunct(adjunct, actors, setting) && adjunct.includes(requiredAdjunct)) adjuncts.add(adjunct)
      }
    }
    return [{ anchor, actorIds: [...actors], predicate, adjuncts: [...adjuncts] }]
  })
}

/** Validate serialized source facts before the provider recomputes the same
 * schedule/hash. Source-backed compilation always regenerates these facts. */
export function readSourceVisualActions(value: unknown, anchors: string[], setting?: string): SourceVisualAction[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length) throw new Error('sourceBeatRequirements.visualActions 必须为非空批准视觉动作快照')
  const seen = new Set<string>()
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('批准视觉动作快照无效')
    const { anchor, actorIds, predicate, adjuncts } = row
    const parsed = typeof anchor === 'string' ? anchor.match(collective) : undefined
    if (!parsed || !anchors.includes(anchor) || seen.has(anchor) || predicate !== parsed[3]
      || !Array.isArray(actorIds) || actorIds.length !== 2 || !actorIds.every(plainString) || new Set(actorIds).size !== 2
      || actorIds.some((actor: string, index: number) => actorIds.some((other: string, otherIndex: number) => index !== otherIndex && actor.includes(other)))
      || !Array.isArray(adjuncts) || !adjuncts.length || !adjuncts.includes(parsed[2]) || new Set(adjuncts).size !== adjuncts.length
      || !adjuncts.every((adjunct: unknown) => typeof adjunct === 'string' && safeAdjunct(adjunct, actorIds, setting) && adjunct.includes(parsed[2]))) {
      throw new Error('批准视觉动作的原锚点、双主体、原谓词或来源修饰快照无效')
    }
    seen.add(anchor)
    return { anchor, actorIds: [...actorIds], predicate, adjuncts: [...adjuncts] }
  })
}

export function executableVisualAction(requirement: SourceVisualAction, beats: Action[]): boolean {
  const subjects = subjectForms(requirement.actorIds)
  return beats.some(beat => {
    if (beat.kind !== 'action' || beat.actorIds.length !== requirement.actorIds.length
      || !requirement.actorIds.every(actor => beat.actorIds.includes(actor))) return false
    const texts = [beat.textOrVocalization, beat.performanceInstruction].filter(plainString)
    const approvedTerms = [...requirement.actorIds, ...requirement.adjuncts.filter(Boolean)].sort((a, b) => b.length - a.length)
    const withoutNames = (text: string) => approvedTerms.reduce((value, term) => value.replaceAll(term, '@approved'), text)
    const contextForbidden = new RegExp(forbidden.source.replace('|完成|实现|形成|建立', ''))
    // A contradiction of the same event anywhere in this action, including
    // another sentence or performanceInstruction, defeats a positive copy.
    if (texts.some(text => withoutNames(text).split(/[，,。；;\n]/)
      .some(clause => clause.includes(requirement.predicate) && forbidden.test(clause)))) return false
    return texts.some(text => {
      return text.split(/[。；;\n]/).some(sentence => {
        if (/[“”"‘’'：:]/.test(sentence)) return false
        const clauses = sentence.split(/[，,]/).map(clause => clause.trim())
        if (clauses.some(clause => contextForbidden.test(withoutNames(clause))
          && !/^(?:禁止|不得)(?:闪现|瞬移|切镜补人)(?:或(?:闪现|瞬移|切镜补人))*$/.test(clause))) return false
        return clauses.some(clause => subjects.some(subject => requirement.adjuncts.some(adjunct =>
          clause === subject + adjunct + requirement.predicate)))
      })
    })
  })
}
