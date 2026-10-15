import test from 'node:test'
import assert from 'node:assert/strict'
import { STORY_VIDEO_CONCAT_NODE_ID, upgradeStoryVideoConcat } from '../src/story-video-concat-workflow.ts'
import { aggregateLoopOutputs, scopedLoopNodes } from '../src/workflow-core.ts'

type TestNode = { id: string; title: string; kind: string; resultVar: string; prompt: string;
  params: Array<{ id: string; name: string; englishName?: string; type: string; required: boolean; value: string }>;
  uploads: unknown[]; loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string };
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; operation?: string;
  loopResultMode?: 'collect' | 'latest' }

const baseNode = (id: string, kind = 'code', resultVar = id): TestNode => ({ id, title: id, kind, resultVar, prompt: '', params: [], uploads: [],
  loop: { enabled: kind === 'loop', sourcePath: 'script_generation.shots', fallbackCount: 2, itemVar: 'shot' },
  position: { x: 0, y: 0 } })

test('schema 3 story loop gains a rolling 9:16 stage immediately after its actual video output', () => {
  const workflow = { id: 'wf-story', schemaVersion: 3, nodes: [
    baseNode('node-input', 'input'), baseNode('node-loop', 'loop'), baseNode('node-image', 'image', 'first_frame'),
    baseNode('node-video', 'video', 'cat_take'), baseNode('node-script', 'text'),
  ], edges: [
    { id: 'input-script', from: 'node-input', to: 'node-script' },
    { id: 'script-loop', from: 'node-script', to: 'node-loop' },
    { id: 'loop-image', from: 'node-loop', to: 'node-image' },
    { id: 'image-video', from: 'node-image', to: 'node-video' },
  ] }
  const upgraded = upgradeStoryVideoConcat(workflow)
  assert.equal(upgraded.schemaVersion, 4)
  assert.deepEqual(upgraded.nodes.map(node => node.id), ['node-input', 'node-loop', 'node-image', 'node-video', STORY_VIDEO_CONCAT_NODE_ID, 'node-script'])
  const loop = upgraded.nodes.find(node => node.id === 'node-loop')!
  const concat = upgraded.nodes.find(node => node.id === STORY_VIDEO_CONCAT_NODE_ID)!
  assert.deepEqual(loop.childIds, ['node-image', 'node-video', STORY_VIDEO_CONCAT_NODE_ID])
  assert.deepEqual(scopedLoopNodes(upgraded, loop.id, upgraded.nodes).map(node => node.id), loop.childIds)
  assert.equal(concat.parentId, loop.id)
  assert.equal(concat.kind, 'videoConcat')
  assert.equal(concat.operation, 'video.concat')
  assert.equal(concat.resultVar, 'stage_video')
  assert.equal(concat.loopResultMode, 'latest')
  assert.deepEqual(Object.fromEntries(concat.params.map(param => [param.englishName, param.value])), {
    previousVideo: '${loop.previous.stage_video}', currentVideo: '${cat_take}', format: 'mp4', aspectRatio: '9:16', resolution: '720p',
  })
  assert.ok(upgraded.edges.some(edge => edge.from === 'node-video' && edge.to === STORY_VIDEO_CONCAT_NODE_ID))
  assert.equal(upgradeStoryVideoConcat(upgraded), upgraded)
  const rounds = [
    { cat_take: { url: '/generated/1.mp4' }, stage_video: { url: '/generated/stage-1.mp4' } },
    { cat_take: { url: '/generated/2.mp4' }, stage_video: { url: '/generated/stage-2.mp4' } },
  ]
  const outputs = aggregateLoopOutputs(rounds, { stage_video: concat.loopResultMode ?? 'collect' })
  assert.deepEqual(outputs.stage_video, rounds[1].stage_video)
  assert.deepEqual(outputs.cat_take, { items: rounds.map(round => round.cat_take), count: 2 })
})

test('migration preserves explicit loop members and routes existing downstream work through concat', () => {
  const workflow = { id: 'wf-story', schemaVersion: 3, nodes: [
    { ...baseNode('node-loop', 'loop'), childIds: ['node-image', 'node-video', 'after-video'] },
    baseNode('node-image', 'image'), baseNode('node-video', 'video', 'video_shot'), baseNode('after-video'),
  ], edges: [
    { id: 'loop-image', from: 'node-loop', to: 'node-image' },
    { id: 'image-video', from: 'node-image', to: 'node-video' },
    { id: 'video-after', from: 'node-video', to: 'after-video' },
  ] }
  const upgraded = upgradeStoryVideoConcat(workflow)
  assert.deepEqual(upgraded.nodes[0].childIds, ['node-image', 'node-video', STORY_VIDEO_CONCAT_NODE_ID, 'after-video'])
  assert.ok(upgraded.edges.some(edge => edge.id === 'video-after' && edge.from === STORY_VIDEO_CONCAT_NODE_ID && edge.to === 'after-video'))
  assert.ok(upgraded.edges.some(edge => edge.from === 'node-video' && edge.to === STORY_VIDEO_CONCAT_NODE_ID))
  assert.equal(workflow.nodes.length, 4)
  assert.equal(workflow.edges[2].from, 'node-video')
})

test('other workflows and missing video contracts remain unchanged', () => {
  const workflow = { id: 'wf-other', schemaVersion: 3, nodes: [baseNode('node-loop', 'loop'), baseNode('node-video', 'video')], edges: [] }
  assert.equal(upgradeStoryVideoConcat(workflow), workflow)
  const disconnected = { ...workflow, id: 'wf-story' }
  assert.equal(upgradeStoryVideoConcat(disconnected), disconnected)
  const missing = { ...workflow, id: 'wf-story', nodes: [baseNode('node-loop', 'loop')] }
  assert.equal(upgradeStoryVideoConcat(missing), missing)
})
