type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = { id: string; title: string; kind: string; resultVar: string; prompt: string; params: Param[];
  uploads: unknown[]; loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string };
  position: { x: number; y: number }; childIds?: string[]; parentId?: string; modelId?: string;
  operation?: string; outputMode?: string }
type Edge = { id: string; from: string; to: string; branch?: string }
type Workflow<N extends Node = Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: Edge[] }

export const STORY_SUBTITLE_NODE_ID = 'node-shot-subtitles'

/** Add an advisory text inference step after the paid shot, before media review. */
export function upgradeWorkplaceShotSubtitles<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-workplace-second-trial-v1') return workflow
  const existing = workflow.nodes.find(node => node.id === STORY_SUBTITLE_NODE_ID)
  if (existing) {
    if (existing.operation !== 'story.subtitle-reference' || existing.resultVar !== 'shot_subtitles')
      throw Error('STORY_SUBTITLE_WORKFLOW_CONFLICT: 字幕节点已被占用')
    return workflow
  }
  const loop = workflow.nodes.find(node => node.id === 'node-loop')
  const video = workflow.nodes.find(node => node.id === 'node-video')
  const review = workflow.nodes.find(node => node.id === 'node-video-review')
  const edge = workflow.edges.find(item => item.from === video?.id && item.to === review?.id && !item.branch)
  if (!loop?.childIds || !video || !review || !edge || !video.modelId || !review.modelId
    || !loop.childIds.includes(video.id) || !loop.childIds.includes(review.id)
    || workflow.nodes.some(node => node.resultVar === 'shot_subtitles')
    || workflow.edges.some(item => item.id === 'edge-shot-subtitles-review'))
    throw Error('STORY_SUBTITLE_WORKFLOW_CONFLICT: 分镜视频与质检拓扑不符合预期')
  const subtitle: N = {
    id: STORY_SUBTITLE_NODE_ID, title: '分镜字幕生成', kind: 'text', operation: 'story.subtitle-reference',
    resultVar: 'shot_subtitles', outputMode: 'json', modelId: review.modelId,
    prompt: '根据本镜剧本与实际视频画面，推理可供用户参考的字幕；只输出变量，不修改视频。',
    params: [
      { id: 'story-subtitle-shot', name: '本镜剧本', englishName: 'shot', type: 'json', required: true, value: '${shot}' },
      { id: 'story-subtitle-video', name: '已生成分镜视频', englishName: 'video', type: 'json', required: true, value: `\${${video.resultVar}}` },
    ], uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    parentId: loop.id, position: { x: video.position.x + 300, y: video.position.y },
  } as unknown as N
  const videoIndex = workflow.nodes.indexOf(video)
  const nodes = [...workflow.nodes.slice(0, videoIndex + 1), subtitle, ...workflow.nodes.slice(videoIndex + 1)]
    .map(node => node.id === loop.id ? { ...node, childIds: [
      ...loop.childIds!.slice(0, loop.childIds!.indexOf(video.id) + 1), subtitle.id,
      ...loop.childIds!.slice(loop.childIds!.indexOf(video.id) + 1),
    ] } as N : node.id === subtitle.id || node.position.x <= video.position.x ? node
      : { ...node, position: { ...node.position, x: node.position.x + 300 } } as N)
  const edges = workflow.edges.map(item => item === edge ? { ...item, to: subtitle.id } : item)
  edges.push({ id: 'edge-shot-subtitles-review', from: subtitle.id, to: review.id })
  return { ...workflow, schemaVersion: Math.max(workflow.schemaVersion ?? 0, 12), nodes, edges } as W
}
