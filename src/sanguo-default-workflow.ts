/** The current managed graph is a cold-start resource. It is fetched only
 * when PostgreSQL has no Sanguo workflow row; saved user graphs are never
 * replaced by this snapshot. Keeping it in public/data avoids loading its
 * 1.5 MB of prompts into every normal app bundle. */
export const SANGUO_DEFAULT_WORKFLOW_URL = '/data/sanguo-default-workflow.json'

type Node = { id?: string; code?: string; prompt?: string;
  params?: Array<{ englishName?: string; value?: string }>;
  uploads?: Array<{ dataUrl?: string }> }
type Graph = { id?: string; schemaVersion?: number; nodes?: Node[]; edges?: Array<{from?: string;to?: string}> }

export function assertSanguoDefaultWorkflow(value: unknown): asserts value is Graph {
  const graph = value && typeof value === 'object' && !Array.isArray(value) ? value as Graph : {}
  if (graph.id !== 'wf-sanguo-history-drama' || graph.schemaVersion !== 158
    || !Array.isArray(graph.nodes) || graph.nodes.length !== 65
    || !Array.isArray(graph.edges) || graph.edges.length !== 80) {
    throw new Error('SANGUO_DEFAULT_INVALID: 出厂工作流不是已审核的 schema 158 图谱')
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const input = nodes.get('sanguo-input')
  const inputParam = (name: string) => input?.params?.find(param => param.englishName === name)?.value
  const uploads = graph.nodes.flatMap(node => node.uploads ?? [])
  if (nodes.size !== graph.nodes.length
    || inputParam('episode_number') !== '41'
    || inputParam('characterAssetSelections') !== '{}'
    || uploads.length !== 1
    || nodes.get('sanguo-context-init')?.uploads?.[0]?.dataUrl !== '/data/三国历史短剧1000集策划总表.xlsx'
    || uploads.some(upload => !upload.dataUrl?.startsWith('/data/'))
    || !nodes.get('sanguo-coverage-first-frame')
    || !nodes.get('sanguo-coverage-approval')
    || !nodes.get('sanguo-media-request')?.code?.includes('deriveApprovedReactionDeadline')
    || !nodes.get('sanguo-media-request')?.code?.includes('startSecond - .15')
    || !nodes.get('sanguo-media-review')?.prompt?.includes('dependentReactionCheck')
    || !nodes.get('sanguo-media-review')?.prompt?.includes('actorIds')
    || !nodes.get('sanguo-media-accept')?.code?.includes('manual-review-hold')
    || graph.edges.some(edge => edge.from === 'sanguo-first-frame-branch' && edge.to === 'sanguo-video')) {
    throw new Error('SANGUO_DEFAULT_INVALID: 出厂图谱缺少同场切镜或依赖反应人工停点')
  }
}

export async function loadSanguoDefaultWorkflow<W extends Graph>(fetcher: typeof fetch = fetch): Promise<W> {
  const response = await fetcher(SANGUO_DEFAULT_WORKFLOW_URL)
  if (!response.ok) throw new Error(`SANGUO_DEFAULT_UNAVAILABLE: HTTP ${response.status}`)
  const graph: unknown = await response.json()
  assertSanguoDefaultWorkflow(graph)
  return graph as W
}
