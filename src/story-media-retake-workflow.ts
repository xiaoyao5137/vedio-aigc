import { upgradeStoryQualityWorkflow } from './story-quality-workflow.ts'

type Value = Record<string, unknown>
type SourceNode = Value & {
  id: string
  kind: string
  title: string
  resultVar: string
  prompt: string
  params: Array<{ id: string; name: string; type: string; required: boolean; value: string }>
  uploads: unknown[]
  loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string }
  position: { x: number; y: number }
}
type StoryEdge = { id: string; from: string; to: string }

export type StoryMediaRetakeSourceWorkflow = {
  id: 'wf-story'
  name: string
  description: string
  schemaVersion: 5
  nodes: SourceNode[]
  edges: StoryEdge[]
  voicePolicy?: unknown
}

export const STORY_MEDIA_RETAKE_NODE_ORDER = [
  'node-input', 'node-model-images', 'node-script', 'node-script-review',
  'node-loop', 'node-image', 'node-video', 'node-video-review', 'node-video-concat',
] as const

/** Exact eight saved schema-5 routes. Extra branches or changed endpoints
 * cannot accompany a preserved paid prefix. */
export const STORY_MEDIA_RETAKE_CANONICAL_EDGES: ReadonlyArray<Readonly<StoryEdge>> = [
  { id: 'edge-script-loop', from: 'node-script', to: 'node-script-review' },
  { id: 'edge-loop-image', from: 'node-loop', to: 'node-image' },
  { id: 'edge-image-video', from: 'node-image', to: 'node-video' },
  { id: 'edge-input-model-images', from: 'node-input', to: 'node-model-images' },
  { id: 'edge-model-images-script', from: 'node-model-images', to: 'node-script' },
  { id: 'edge-video-concat', from: 'node-video', to: 'node-video-review' },
  { id: 'edge-script-review-loop', from: 'node-script-review', to: 'node-loop' },
  { id: 'edge-video-review-concat', from: 'node-video-review', to: 'node-video-concat' },
]

const record = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value)

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function hasCanonicalStoryMediaRetakeEdges(edges: unknown): edges is StoryEdge[] {
  if (!Array.isArray(edges) || edges.length !== STORY_MEDIA_RETAKE_CANONICAL_EDGES.length) return false
  const expected = new Map(STORY_MEDIA_RETAKE_CANONICAL_EDGES.map(edge => [edge.id, edge]))
  const seen = new Set<string>()
  return edges.every(candidate => {
    if (!record(candidate) || typeof candidate.id !== 'string' || seen.has(candidate.id)
      || Object.keys(candidate).some(key => !['id', 'from', 'to'].includes(key))) return false
    const edge = expected.get(candidate.id)
    seen.add(candidate.id)
    return !!edge && candidate.from === edge.from && candidate.to === edge.to
  })
}

/** Validate the original node snapshots. The quality upgrader checks topology
 * but its returned nodes are discarded: it may add a storyShot parameter that
 * did not exist in the source's paid run and must not rewrite that evidence. */
export function checkedStoryMediaRetakeWorkflow(
  workflow: unknown,
  runs: ReadonlyArray<{ node: unknown }>,
): workflow is StoryMediaRetakeSourceWorkflow {
  if (!record(workflow) || workflow.id !== 'wf-story' || workflow.schemaVersion !== 5
    || typeof workflow.name !== 'string' || typeof workflow.description !== 'string'
    || !Array.isArray(workflow.nodes) || workflow.nodes.length !== STORY_MEDIA_RETAKE_NODE_ORDER.length
    || !hasCanonicalStoryMediaRetakeEdges(workflow.edges) || !Array.isArray(runs)) return false
  const expectedIds = new Set<string>(STORY_MEDIA_RETAKE_NODE_ORDER)
  const snapshotById = new Map<string, string>()
  for (const run of runs) {
    const node = run?.node
    if (!record(node) || typeof node.id !== 'string' || !expectedIds.has(node.id)) return false
    const serialized = canonical(node)
    if (snapshotById.has(node.id) && snapshotById.get(node.id) !== serialized) return false
    snapshotById.set(node.id, serialized)
  }
  if (snapshotById.size !== expectedIds.size) return false
  const workflowIds = new Set<string>()
  for (const node of workflow.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !expectedIds.has(node.id)
      || workflowIds.has(node.id) || snapshotById.get(node.id) !== canonical(node)) return false
    workflowIds.add(node.id)
  }
  try {
    upgradeStoryQualityWorkflow(workflow as StoryMediaRetakeSourceWorkflow)
    return true
  } catch { return false }
}

/** Reconstruct only from consistent saved node snapshots and a verified edge
 * set. The copy is persisted as sourceWorkflow, independent of live wf-story. */
export function buildSourceStoryMediaRetakeWorkflow(
  runs: ReadonlyArray<{ node: unknown }>,
  edges: unknown,
  options: { name: string; description?: string; voicePolicy?: unknown },
): StoryMediaRetakeSourceWorkflow | undefined {
  if (!Array.isArray(runs) || !hasCanonicalStoryMediaRetakeEdges(edges)
    || typeof options.name !== 'string' || !options.name.trim()) return undefined
  const nodes = new Map<string, SourceNode>()
  for (const run of runs) {
    const node = run?.node
    if (record(node) && typeof node.id === 'string' && !nodes.has(node.id)) nodes.set(node.id, node as SourceNode)
  }
  if (nodes.size !== STORY_MEDIA_RETAKE_NODE_ORDER.length) return undefined
  const workflow: StoryMediaRetakeSourceWorkflow = {
    id: 'wf-story', name: options.name,
    description: options.description ?? '从源执行的节点快照恢复的分镜工作流',
    schemaVersion: 5,
    nodes: STORY_MEDIA_RETAKE_NODE_ORDER.map(id => structuredClone(nodes.get(id)!)),
    edges: structuredClone(edges),
    ...(options.voicePolicy === undefined ? {} : { voicePolicy: structuredClone(options.voicePolicy) }),
  }
  return checkedStoryMediaRetakeWorkflow(workflow, runs) ? workflow : undefined
}
