type Param = { id?: string; name?: string; englishName?: string; type?: string; required?: boolean; value?: string }
type Node = { id: string; operation?: string; prompt: string; runIf?: { path: string; equals: unknown }; params?: Param[] }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[] }

export const CHARACTER_BIOGRAPHY_WORKFLOW_SCHEMA = 155
export const CHARACTER_BIOGRAPHY_SOURCE_PARAM = {
  id: 'sg-cp-historical-sources', name: '本集已检索史料', englishName: 'historicalSources',
  type: 'json', required: false, value: '${historical_sources}',
} as const satisfies Param

/** A bounded migration of the one managed portrait node. Existing image,
 * review, voice and archive routes keep their conditions and node identities. */
export function upgradeCharacterBiographyWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama'
    || (workflow.schemaVersion ?? 0) < 151
    || (workflow.schemaVersion ?? 0) >= CHARACTER_BIOGRAPHY_WORKFLOW_SCHEMA) return workflow
  let changed = false
  const nodes = workflow.nodes.map(node => {
    if (node.id !== 'sanguo-character-portrait' || node.operation !== 'character.historical-portrait') return node
    const oldGate = node.runIf?.path === 'character_lookup.shouldGenerate' && node.runIf.equals === true
    // An authored condition needs manual review; never silently erase it.
    if (node.runIf && !oldGate) return node
    const params = node.params ?? []
    const hasSourceParam = params.some(param => (param.englishName || param.name) === 'historicalSources')
    const nextParams = hasSourceParam ? params : [...params, CHARACTER_BIOGRAPHY_SOURCE_PARAM]
    const prompt = '对本镜具名人物补充可核对的正史生平与体貌资料；优先复用本集已检索史料。已有三视图也检查自动占位自传，仅替换缺证据段落；区分检索失败和确实缺载，不将小说外形或剧情造型写成正史。'
    const next = { ...node, prompt, params: nextParams }
    delete next.runIf
    changed = true
    return next as N
  })
  return changed ? { ...workflow, nodes, schemaVersion: CHARACTER_BIOGRAPHY_WORKFLOW_SCHEMA } : workflow
}
