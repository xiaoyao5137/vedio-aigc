type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = { id: string; title: string; kind: string; resultVar: string; prompt: string; params: Param[];
  uploads: unknown[]; loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string };
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; operation?: string;
  loopResultMode?: 'collect' | 'latest' }
type Edge = { id: string; from: string; to: string; branch?: string }
type Workflow<N extends Node = Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: Edge[] }

export const WORKING_CAT_TIMELINE_NODE_ID = 'node-timeline-compose'

/** Add a rolling playable assembly after the saved cat workflow's review route. */
export function upgradeWorkingCatTimeline<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-workplace-second-trial-v1') return workflow
  if (workflow.schemaVersion === 11) return workflow
  if (workflow.schemaVersion !== 10) throw Error('WORKING_CAT_TIMELINE_CONFLICT: 工作流版本不是 10')
  const loop = workflow.nodes.find(node => node.id === 'node-loop')
  const video = workflow.nodes.find(node => node.id === 'node-video')
  const review = workflow.nodes.find(node => node.id === 'node-video-review')
  const branch = workflow.nodes.find(node => node.id === 'node-video-review-result-branch')
  const accepted = workflow.nodes.find(node => node.id === 'node-video-review-accepted')
  const ids = [video?.id, review?.id, branch?.id, accepted?.id]
  if (!loop || !video || !review || !branch || !accepted || loop.kind !== 'loop'
    || !loop.childIds || ids.some(id => !id || !loop.childIds!.includes(id))
    || !(loop.childIds.indexOf(video.id) < loop.childIds.indexOf(review.id)
      && loop.childIds.indexOf(review.id) < loop.childIds.indexOf(branch.id)
      && loop.childIds.indexOf(branch.id) < loop.childIds.indexOf(accepted.id))
    || review.operation !== 'story.media-review'
    || workflow.nodes.some(node => node.id === WORKING_CAT_TIMELINE_NODE_ID || node.resultVar === 'stage_video')
    || workflow.edges.some(edge => edge.id === 'edge-cat-timeline-compose')
    || workflow.edges.filter(edge => edge.from === branch.id && edge.to === accepted.id && edge.branch === 'true').length !== 1
    || workflow.edges.some(edge => edge.from === accepted.id)
    || workflow.edges.some(edge => edge.from === video.id && edge.to === accepted.id)) {
    throw Error('WORKING_CAT_TIMELINE_CONFLICT: 质检路由或合成输出不符合预期')
  }
  const node = {
    id: WORKING_CAT_TIMELINE_NODE_ID, title: '时间线合成', kind: 'videoConcat', operation: 'video.concat',
    resultVar: 'stage_video', loopResultMode: 'latest',
    prompt: '每轮质检完成后，将上一轮阶段视频包含的分镜与本轮已审分镜按顺序合成为可播放视频。',
    params: [
      { id: 'cat-timeline-previous', name: '上一轮阶段视频', englishName: 'previousVideo', type: 'json', required: false, value: '${loop.previous.stage_video}' },
      { id: 'cat-timeline-current', name: '本轮已审分镜', englishName: 'currentVideo', type: 'json', required: true, value: '${' + review.resultVar + '}' },
      { id: 'cat-timeline-decision', name: '本轮质检路由', englishName: 'reviewDecision', type: 'json', required: true, value: '${' + branch.resultVar + '}' },
      { id: 'cat-timeline-format', name: '格式', englishName: 'format', type: 'text', required: true, value: 'mp4' },
      { id: 'cat-timeline-aspect', name: '画幅', englishName: 'aspectRatio', type: 'text', required: true, value: '9:16' },
      { id: 'cat-timeline-resolution', name: '合成分辨率', englishName: 'resolution', type: 'text', required: true, value: '720p' },
    ],
    uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    parentId: loop.id, position: { x: accepted.position.x + 300, y: accepted.position.y },
  } as unknown as N
  return { ...workflow, schemaVersion: 11,
    nodes: workflow.nodes.flatMap(current => current.id === loop.id
      ? [{ ...current, childIds: [...loop.childIds!, node.id] } as N]
      : current.id === accepted.id ? [current, node] : [current]),
    edges: [...workflow.edges, { id: 'edge-cat-timeline-compose', from: accepted.id, to: node.id }],
  } as W
}
