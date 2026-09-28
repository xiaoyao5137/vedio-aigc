type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = { id: string; kind: string; operation?: string; resultVar: string; title: string; prompt: string; modelId?: string; parentId?: string; childIds?: string[]; runIf?: unknown; code?: string; position: { x: number; y: number }; params: Param[] }
export function addOriginalVoiceNode<N extends Node, W extends { nodes: N[]; edges: Array<{ id: string; from: string; to: string }> }>(workflow: W, modelId: string): W {
  const archive = workflow.nodes.find(n => n.operation === 'character.archive')
  const lookup = workflow.nodes.find(n => n.operation === 'character.lookup' && n.parentId === archive?.parentId)
  if (!archive || !lookup) return workflow
  const existing = workflow.nodes.find(n => n.operation === 'character.voice-design')
  const existingArchive = workflow.nodes.find(n => n.operation === 'character.voice-archive')
  const patchLookup = (code: string) => {
    let next = code
    if (!next.includes('existingVoices:')) next = next.replace('  existingAssets,', '  existingAssets,\n  existingVoices: Array.isArray(lookup.existingVoices) ? lookup.existingVoices : [],')
    if (!next.includes('voiceCharacters:')) next = next.replace('  existingAssets,', '  existingAssets,\n  voiceCharacters: Array.isArray(lookup.voiceCharacters) ? lookup.voiceCharacters.map((item) => missingCharacters.find((generated) => generated.name === item.name) || item) : [],')
    return next
  }
  if (existingArchive && archive.params.some(p => p.englishName === 'voiceAssets')) {
    const nodes = workflow.nodes.map(n => {
      if (n.id === lookup.id && n.code && patchLookup(n.code) !== n.code) return { ...n, code: patchLookup(n.code) }
      if (n.id === existing?.id && n.params.some(p => p.englishName === 'characters' && p.value === '${' + lookup.resultVar + '.characters}')) return { ...n, params: n.params.map(p => p.englishName === 'characters' && p.value === '${' + lookup.resultVar + '.characters}' ? { ...p, value: '${' + lookup.resultVar + '.voiceCharacters}' } : p) }
      return n
    })
    return nodes.some((node, i) => node !== workflow.nodes[i]) ? { ...workflow, nodes } : workflow
  }
  const video = workflow.nodes.find(n => n.kind === 'video' && n.parentId === archive.parentId)
  const id = existing?.id ?? `${archive.id}-voice-design`, archiveId = `${archive.id}-voice-archive`
  const param = (key: string, name: string, value: string, type = 'json', required = true): Param => ({ id: `${id}-${key}`, name, englishName: key, type, required, value })
  const ref = (name: string) => '${' + name + '}'
  const design = { ...archive, ...existing, id, title: '人物原创音色创建', kind: 'audio', operation: 'character.voice-design', modelId: existing?.modelId ?? modelId, resultVar: 'character_voice_candidates', runIf: undefined,
    prompt: existing?.prompt ?? '依据人物资料设计原创自然声音，确定年龄感、音高、共鸣、质感和说话气质，普通话清晰，不模仿具体演员。',
    position: { x: archive.position.x - 360, y: archive.position.y + 180 },
    params: [param('characters', '人物及画外声音角色', ref(lookup.resultVar + '.voiceCharacters')), param('existingVoices', '已归档人物音色', ref(lookup.resultVar + '.existingVoices'), 'json', false),
      existing?.params.find(p => p.englishName === 'voiceDescriptions') ?? param('voiceDescriptions', '人物音色描述（按姓名覆盖）', '{}', 'json', false)],
  } as N
  const voiceArchive = { ...archive, id: archiveId, title: '人物音色资产归档', kind: 'asset', operation: 'character.voice-archive', modelId: undefined, resultVar: 'archived_voice_assets', runIf: undefined,
    prompt: '将上游音色候选保存为人物音色资产，不进行模型推理；已归档音色保持原身份。',
    position: { x: archive.position.x - 180, y: archive.position.y + 180 }, params: [param('candidates', '音色候选', ref('character_voice_candidates.items'))],
  } as N
  const personArchive = { ...archive, runIf: undefined, params: [
    ...archive.params.filter(p => !['characters', 'voiceAssets', 'videoModelId'].includes(p.englishName ?? '')), param('characters', '全部出场人物', ref(lookup.resultVar + '.characters')),
    param('voiceAssets', '已归档音色资产', ref('archived_voice_assets.items')), param('videoModelId', '视频声音映射模型', video?.modelId ?? '', 'text', false),
  ].map(p => p.englishName === 'generatedAssets' ? { ...p, required: false } : p) } as N
  const oldIds = new Set([id, archiveId])
  // Remove the old post-archive combined node and restore its outgoing links first.
  const baseEdges = workflow.edges.filter(e => !oldIds.has(e.to) && !oldIds.has(e.from))
  if (existing) for (const e of workflow.edges.filter(e => e.from === id && !oldIds.has(e.to) && e.to !== archive.id)) baseEdges.push({ ...e, from: archive.id })
  const nodes = workflow.nodes.filter(n => !oldIds.has(n.id)).flatMap(n => {
    if (n.id === archive.id) return [design, voiceArchive, personArchive]
    let next = { ...n }
    if (n.childIds?.includes(archive.id)) next = { ...next, childIds: n.childIds.filter(child => !oldIds.has(child)).flatMap(child => child === archive.id ? [id, archiveId, child] : [child]) }
    if (n.id === lookup.id && n.code) next.code = patchLookup(n.code)
    if (n.kind === 'video' && n.parentId === archive.parentId) next.params = [...n.params.filter(p => p.englishName !== 'voiceAssets'), param('voiceAssets', '人物音色资产参考', ref(archive.resultVar + '.voiceAssets'))]
    return [next]
  })
  const edges = [...baseEdges.map(e => e.to === archive.id ? { ...e, to: id } : e), { id: `${id}-to-archive`, from: id, to: archiveId }, { id: `${archiveId}-to-person`, from: archiveId, to: archive.id }]
  return { ...workflow, nodes, edges }
}
