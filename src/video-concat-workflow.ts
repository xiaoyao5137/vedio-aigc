type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = {
  id: string; title: string; kind: string; resultVar: string; prompt: string; params: Param[]; uploads: unknown[]
  loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string }
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; operation?: string
  loopResultMode?: 'collect' | 'latest'
}
type Edge = { id: string; from: string; to: string; branch?: string }
type Workflow<N extends Node = Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: Edge[] }

export const SANGUO_VIDEO_CONCAT_NODE_ID = 'sanguo-video-concat'

export function sanguoVideoConcatNode<N extends Node>(video: N): N {
  return {
    id: SANGUO_VIDEO_CONCAT_NODE_ID,
    title: '阶段视频拼接',
    kind: 'videoConcat',
    operation: 'video.concat',
    resultVar: 'stage_video',
    loopResultMode: 'latest',
    prompt: '仅将已通过画面质检与人物音色听审的本轮分镜按顺序拼接；未听审素材在此停止。',
    params: [
      { id: 'sg-concat-previous', name: '上一轮阶段视频', englishName: 'previousVideo', type: 'json', required: false, value: '${loop.previous.stage_video}' },
      { id: 'sg-concat-current', name: '本轮已验收分镜', englishName: 'currentVideo', type: 'json', required: true, value: '${video_shot}' },
      { id: 'sg-concat-format', name: '输出格式', englishName: 'format', type: 'text', required: true, value: 'mp4' },
      { id: 'sg-concat-aspect', name: '画幅', englishName: 'aspectRatio', type: 'text', required: true, value: '${input.aspect_ratio}' },
      { id: 'sg-concat-resolution', name: '执行分辨率', englishName: 'resolution', type: 'text', required: true, value: '720p' },
    ],
    uploads: [],
    loop: { enabled: false, sourcePath: 'script_fragments.items', fallbackCount: 8, itemVar: 'item' },
    parentId: video.parentId,
    position: { x: video.position.x + 280, y: video.position.y + 360 },
  } as unknown as N
}

/** Schema 138 adds a generic video-concat node to the loop.
 * Schema 139 repairs the original migration's stale `${video_shot}` binding by
 * deriving both rolling inputs from the actual producer/result variable names.
 * Schema 140 adds the render dimensions; execution mode still overrides the
 * persisted fallback so debug stays 720p and a formal run cannot stay there.
 * Schema 141 moves concat behind quality acceptance and the built-in voice
 * listening gate, so an unaccepted take can never enter stage_video. */
export function upgradeSanguoVideoConcat<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 137 || (workflow.schemaVersion ?? 0) >= 141) return workflow
  let upgraded = workflow
  if ((upgraded.schemaVersion ?? 0) < 138) {
    const video = upgraded.nodes.find(node => node.id === 'sanguo-video')
    const loop = upgraded.nodes.find(node => node.id === 'sanguo-scene-loop')
    if (!video || !loop || !loop.childIds?.includes(video.id)) return workflow
    const existing = upgraded.nodes.find(node => node.id === SANGUO_VIDEO_CONCAT_NODE_ID)
    const canonical = sanguoVideoConcatNode(video)
    const concat = existing ? { ...canonical, ...existing, kind: 'videoConcat', operation: 'video.concat', loopResultMode: 'latest', parentId: video.parentId } as N : canonical
    const videoIndex = upgraded.nodes.indexOf(video)
    const nodes = existing ? upgraded.nodes : [
      ...upgraded.nodes.slice(0, videoIndex + 1), concat, ...upgraded.nodes.slice(videoIndex + 1),
    ]
    const childIds = loop.childIds.includes(concat.id) ? loop.childIds : [
      ...loop.childIds.slice(0, loop.childIds.indexOf(video.id) + 1), concat.id,
      ...loop.childIds.slice(loop.childIds.indexOf(video.id) + 1),
    ]
    const updatedNodes = nodes.map(node => node === loop ? { ...node, childIds } as N : node)
    const outgoing = upgraded.edges.filter(edge => edge.from === video.id && !edge.branch)
    const migratedEdges = upgraded.edges.map(edge => outgoing.includes(edge) && edge.to !== concat.id ? { ...edge, from: concat.id } : edge)
    const edges = migratedEdges.some(edge => edge.from === video.id && edge.to === concat.id)
      ? migratedEdges : [...migratedEdges, { id: 'sg-e-video-concat', from: video.id, to: concat.id }]
    upgraded = { ...upgraded, schemaVersion: 138, nodes: updatedNodes, edges } as W
  }
  const video = upgraded.nodes.find(node => node.id === 'sanguo-video')
  const concat = upgraded.nodes.find(node => node.id === SANGUO_VIDEO_CONCAT_NODE_ID)
  if (!video || !concat || !video.resultVar || !concat.resultVar) return upgraded
  const canonical = sanguoVideoConcatNode(video)
  const canonicalParams = new Map(canonical.params.map(param => [param.englishName ?? param.name, param]))
  const params = concat.params.map(param => {
    const key = param.englishName ?? param.name
    if (key === 'previousVideo') return { ...param, value: '${loop.previous.' + concat.resultVar + '}', required: false }
    if (key === 'currentVideo') return { ...param, value: '${video_shot}', required: true }
    return param
  })
  for (const key of ['previousVideo', 'currentVideo', 'format', 'aspectRatio', 'resolution']) {
    if (!params.some(param => (param.englishName ?? param.name) === key)) params.push(canonicalParams.get(key)!)
  }
  const acceptBranch = upgraded.nodes.find(node => node.id === 'sanguo-media-accept-accept-branch')
  const lastFrame = upgraded.nodes.find(node => node.id === 'sanguo-last-frame')
  let edges = upgraded.edges.filter(edge => !(edge.from === video.id && edge.to === concat.id)
    && !(edge.from === concat.id && edge.to === 'sanguo-media-request'))
  if (acceptBranch && lastFrame) {
    edges = edges.map(edge => edge.from === acceptBranch.id && edge.to === lastFrame.id && edge.branch === 'true'
      ? { ...edge, to: concat.id } : edge)
    if (!edges.some(edge => edge.from === concat.id && edge.to === lastFrame.id)) {
      edges.push({ id: 'sg-e-concat-last-frame', from: concat.id, to: lastFrame.id })
    }
  }
  return { ...upgraded, schemaVersion: 141, edges, nodes: upgraded.nodes.map(node => node === concat
    ? { ...node, kind: 'videoConcat', operation: 'video.concat', loopResultMode: 'latest', params,
      prompt: canonical.prompt } as N : node) } as W
}

/** Schema 143 repairs the production route left disconnected by schema 141.
 *
 * Schema 138 temporarily placed concat immediately after the paid video and
 * moved the video's outgoing media-evidence edge onto concat. Schema 141 then
 * correctly moved concat behind acceptance, but removing concat -> media request
 * without restoring video -> media request made the evidence chain a separate
 * graph root. The runner could therefore execute evidence before storyboard and
 * video generation. Keep concat after acceptance and restore the paid video's
 * direct route into same-material evidence collection. */
export function repairSanguoVideoMediaRoute<N extends Node, W extends Workflow<N>>(workflow: W): W {
  const version = workflow.schemaVersion ?? 0
  if (workflow.id !== 'wf-sanguo-history-drama' || version < 141 || version >= 143) return workflow
  const video = workflow.nodes.find(node => node.id === 'sanguo-video')
  const concat = workflow.nodes.find(node => node.id === SANGUO_VIDEO_CONCAT_NODE_ID)
  const mediaRequest = workflow.nodes.find(node => node.id === 'sanguo-media-request')
  if (!video || !concat || !mediaRequest) return workflow

  const edges = workflow.edges.filter(edge => !(edge.from === video.id && edge.to === concat.id)
    && !(edge.from === concat.id && edge.to === mediaRequest.id))
  if (!edges.some(edge => edge.from === video.id && edge.to === mediaRequest.id && edge.branch === undefined)) {
    edges.push({ id: 'sg-e-video-media-request', from: video.id, to: mediaRequest.id })
  }
  return { ...workflow, schemaVersion: 143, edges } as W
}
