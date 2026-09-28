type Value = Record<string, unknown>
const record = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

/** Explain the exact current mismatch without changing either side or deciding
 * that similar wording means the same fact. Only explicitly rejected paths apply. */
export function outlineKnowledgeRepairInstruction(validationMessage: string, candidate: unknown) {
  const dramas = record(candidate)?.dramaticScenes
  if (!Array.isArray(dramas)) return ''
  const diagnostics: Array<{ path: string; dramaticSceneId: unknown; characterName: unknown;
    missingBeforeKnowledge: string[]; existingAfterKnowledge: string[] }> = []
  const seen = new Set<string>()
  for (const match of validationMessage.matchAll(/不得无故遗忘已知信息（字段 (dramaticScenes\[(\d+)\]\.characterStates\[(\d+)\]\.after\.knowledge)）/g)) {
    const [, path, dramaIndex, stateIndex] = match
    if (seen.has(path)) continue
    seen.add(path)
    const drama = record(dramas[Number(dramaIndex)])
    const states = drama?.characterStates
    if (!Array.isArray(states)) continue
    const change = record(states[Number(stateIndex)])
    const before = record(change?.before)?.knowledge, after = record(change?.after)?.knowledge
    if (!strings(before) || !strings(after)) continue
    const missingBeforeKnowledge = [...new Set(before.filter(fact => !after.includes(fact)))]
    if (!missingBeforeKnowledge.length) continue
    diagnostics.push({ path, dramaticSceneId: drama?.id, characterName: change?.name,
      missingBeforeKnowledge, existingAfterKnowledge: [...after] })
  }
  if (!diagnostics.length) return ''
  return '\n【已知信息原文继承对照】\n' + JSON.stringify(diagnostics)
    + '\nmissingBeforeKnowledge 是当前 before 中尚未被 after 逐字保留的原句；existingAfterKnowledge 是该字段当前完整内容。请逐条恢复列出的原句，并保留本场实际新增知识。旧知识的同义改写不能代替原文继承，不能删除或改写 before 来消除报错。只修复所列 after.knowledge 及其他已点名缺陷；未被点名的正文、台词、人物、场景和其他状态保持原样，不重写整场。程序仍按原硬约束重新验证，不以这份提示代替验收。\n'
}
