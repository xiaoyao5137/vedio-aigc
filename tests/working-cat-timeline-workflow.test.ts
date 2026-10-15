import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeWorkingCatTimeline, WORKING_CAT_TIMELINE_NODE_ID } from '../src/working-cat-timeline-workflow.ts'
import { aggregateLoopOutputs, scopedLoopNodes } from '../src/workflow-core.ts'

const node = (id: string, kind = 'code', resultVar = id) => ({ id, kind, title: id, resultVar, prompt: '', params: [], uploads: [],
  loop: { enabled: kind === 'loop', sourcePath: '', fallbackCount: 0, itemVar: 'shot' }, position: { x: 0, y: 0 },
  parentId: id === 'node-loop' ? undefined : 'node-loop' })

function workflow() {
  const children = ['node-video', 'node-video-review', 'node-video-review-result-branch', 'node-video-review-accepted']
  return { id: 'wf-workplace-second-trial-v1', schemaVersion: 10, nodes: [
    { ...node('node-loop', 'loop'), childIds: children },
    node('node-video', 'video', 'custom_take'),
    { ...node('node-video-review', 'validation', 'custom_review'), operation: 'story.media-review' },
    node('node-video-review-result-branch', 'branch', 'custom_decision'), node('node-video-review-accepted'),
  ], edges: [
    { id: 'video-review', from: 'node-video', to: 'node-video-review' },
    { id: 'review-branch', from: 'node-video-review', to: 'node-video-review-result-branch' },
    { id: 'branch-accepted', from: 'node-video-review-result-branch', to: 'node-video-review-accepted', branch: 'true' },
    { id: 'branch-retake', from: 'node-video-review-result-branch', to: 'node-video', branch: 'false' },
  ] }
}

test('cat timeline merges each reviewed round after the review route', () => {
  const original = workflow()
  const upgraded = upgradeWorkingCatTimeline(original)
  assert.equal(upgraded.schemaVersion, 11)
  assert.equal(original.nodes.length + 1, upgraded.nodes.length)
  const timeline = upgraded.nodes.find(item => item.id === WORKING_CAT_TIMELINE_NODE_ID)!
  assert.equal(timeline.kind, 'videoConcat')
  assert.equal(timeline.operation, 'video.concat')
  assert.equal(timeline.loopResultMode, 'latest')
  assert.deepEqual(Object.fromEntries(timeline.params.map(param => [param.englishName, param.value])), {
    previousVideo: '${loop.previous.stage_video}', currentVideo: '${custom_review}', reviewDecision: '${custom_decision}', format: 'mp4', aspectRatio: '9:16', resolution: '720p',
  })
  const loop = upgraded.nodes[0]
  assert.deepEqual(loop.childIds?.at(-1), WORKING_CAT_TIMELINE_NODE_ID)
  assert.deepEqual(scopedLoopNodes(upgraded, loop.id, upgraded.nodes).map(item => item.id), loop.childIds)
  assert.deepEqual(upgraded.edges.at(-1), { id: 'edge-cat-timeline-compose', from: 'node-video-review-accepted', to: WORKING_CAT_TIMELINE_NODE_ID })
  assert.deepEqual(upgraded.edges.slice(0, original.edges.length), original.edges)
  assert.equal(upgradeWorkingCatTimeline(upgraded), upgraded)
  const outputs = aggregateLoopOutputs([
    { stage_video: { url: '/generated/one.mp4' } },
    { stage_video: { url: '/generated/two.mp4' } },
  ], { stage_video: timeline.loopResultMode ?? 'collect' })
  assert.deepEqual(outputs.stage_video, { url: '/generated/two.mp4' })
})

test('cat timeline rejects a changed review route', () => {
  const source = workflow()
  source.edges = source.edges.filter(edge => edge.id !== 'branch-accepted')
  assert.throws(() => upgradeWorkingCatTimeline(source), /WORKING_CAT_TIMELINE_CONFLICT/)
})
