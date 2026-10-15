type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = {
  id: string; title: string; kind: string; resultVar: string; prompt: string; params: Param[]; uploads: unknown[]
  loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string }
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; operation?: string
  loopResultMode?: 'collect' | 'latest'
}
type Edge = { id: string; from: string; to: string; branch?: string }
type Workflow<N extends Node = Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: Edge[] }

export const STORY_VIDEO_CONCAT_NODE_ID = 'node-video-concat'

/** Keep the staged assembly separate from the original clips and their review records. */
export function storyVideoConcatNode<N extends Node>(video: N): N {
  return {
    id: STORY_VIDEO_CONCAT_NODE_ID,
    title: '阶段视频拼接',
    kind: 'videoConcat',
    operation: 'video.concat',
    resultVar: 'stage_video',
    loopResultMode: 'latest',
    prompt: '按分镜顺序拼接当前视频与上一轮阶段视频，供阶段预览；拼接结果不代表整段内容或声音验收。',
    params: [
      { id: 'story-concat-previous', name: '上一轮阶段视频', englishName: 'previousVideo', type: 'json', required: false, value: '${loop.previous.stage_video}' },
      { id: 'story-concat-current', name: '本轮分镜视频', englishName: 'currentVideo', type: 'json', required: true, value: '${' + video.resultVar + '}' },
      { id: 'story-concat-format', name: '输出格式', englishName: 'format', type: 'text', required: true, value: 'mp4' },
      { id: 'story-concat-aspect', name: '画幅', englishName: 'aspectRatio', type: 'text', required: true, value: '9:16' },
      { id: 'story-concat-resolution', name: '预览分辨率', englishName: 'resolution', type: 'text', required: true, value: '720p' },
    ],
    uploads: [],
    loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    parentId: 'node-loop',
    position: { x: video.position.x + 300, y: video.position.y },
  } as unknown as N
}

function legacyLoopChildren<N extends Node>(workflow: Workflow<N>, loopId: string): string[] {
  const reachable = new Set<string>()
  const visit = (id: string) => {
    for (const edge of workflow.edges) {
      if (edge.from !== id || reachable.has(edge.to) || edge.to === loopId) continue
      reachable.add(edge.to)
      visit(edge.to)
    }
  }
  visit(loopId)
  return workflow.nodes.filter(node => reachable.has(node.id)).map(node => node.id)
}

/** Schema 4 adds a rolling, previewable video assembly after each story shot.
 * The old story loop has no childIds/parentId, so make its complete legacy
 * membership explicit before assigning a parent to the new concat node. */
export function upgradeStoryVideoConcat<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-story' || (workflow.schemaVersion ?? 0) !== 3) return workflow
  const loop = workflow.nodes.find(node => node.id === 'node-loop')
  const video = workflow.nodes.find(node => node.id === 'node-video')
  if (!loop || !video || !video.resultVar?.trim()) return workflow
  const oldChildren = loop.childIds ?? legacyLoopChildren(workflow, loop.id)
  if (!oldChildren.includes(video.id)) return workflow
  if (workflow.nodes.some(node => node.id !== STORY_VIDEO_CONCAT_NODE_ID && node.resultVar === 'stage_video')) {
    throw new Error('STORY_VIDEO_CONCAT_CONFLICT: stage_video 已被其他节点使用')
  }

  const existing = workflow.nodes.find(node => node.id === STORY_VIDEO_CONCAT_NODE_ID)
  const canonical = storyVideoConcatNode(video)
  const concat = existing ? { ...existing, kind: canonical.kind, operation: canonical.operation,
    resultVar: canonical.resultVar, loopResultMode: canonical.loopResultMode,
    parentId: loop.id, params: canonical.params } as N : canonical
  const videoIndex = workflow.nodes.indexOf(video)
  const nodes = existing ? workflow.nodes.map(node => node === existing ? concat : node)
    : [...workflow.nodes.slice(0, videoIndex + 1), concat, ...workflow.nodes.slice(videoIndex + 1)]
  const childIds = oldChildren.includes(concat.id) ? oldChildren
    : [...oldChildren.slice(0, oldChildren.indexOf(video.id) + 1), concat.id,
      ...oldChildren.slice(oldChildren.indexOf(video.id) + 1)]
  const updatedNodes = nodes.map(node => node === loop ? { ...node, childIds } as N : node)

  const outgoing = workflow.edges.filter(edge => edge.from === video.id && edge.to !== concat.id && edge.branch === undefined)
  const edges = workflow.edges.map(edge => outgoing.includes(edge) ? { ...edge, from: concat.id } : edge)
  if (!edges.some(edge => edge.from === video.id && edge.to === concat.id && edge.branch === undefined)) {
    edges.push({ id: 'edge-video-concat', from: video.id, to: concat.id })
  }
  return { ...workflow, schemaVersion: 4, nodes: updatedNodes, edges } as W
}
