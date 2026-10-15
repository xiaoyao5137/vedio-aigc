import test from 'node:test'
import assert from 'node:assert/strict'
import { checkedStoryMediaRetakeWorkflow,
  STORY_MEDIA_RETAKE_CANONICAL_EDGES } from '../src/story-media-retake-workflow.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'

type Node = { id: string; title: string; kind: string; resultVar: string; prompt: string;
  params: Array<{ id: string; name: string; englishName?: string; type: string; required: boolean; value: string }>;
  uploads: unknown[]; loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string };
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; operation?: string }
type Workflow = { id: string; name: string; description: string; schemaVersion: number; nodes: Node[];
  edges: Array<{ id: string; from: string; to: string; branch?: string }> }

function node(id: string, kind: string, resultVar = id): Node {
  return { id, title: id, kind, resultVar, prompt: '', params: [], uploads: [],
    loop: { enabled: kind === 'loop', sourcePath: '', fallbackCount: 0, itemVar: 'shot' },
    position: { x: 0, y: 100 } }
}

function reviewedWorkflow(): Workflow {
  const loop = node('node-loop', 'loop', 'shot_loop')
  loop.childIds = ['node-image', 'node-video', 'node-video-concat']
  loop.loop = { enabled: true, sourcePath: 'script_generation.shots', fallbackCount: 8, itemVar: 'shot' }
  const video = node('node-video', 'video', 'video_shot')
  video.prompt = '逐项完成 ${shotTimedActions}'
  const concat = node('node-video-concat', 'videoConcat', 'stage_video')
  concat.operation = 'video.concat'
  concat.parentId = loop.id
  concat.params = [
    { id: 'previous', name: '上一轮', englishName: 'previousVideo', type: 'json', required: false, value: '${loop.previous.stage_video}' },
    { id: 'current', name: '本轮', englishName: 'currentVideo', type: 'json', required: true, value: '${video_shot}' },
  ]
  const before: Workflow = { id: 'wf-story', name: 'story', description: 'story quality', schemaVersion: 4,
    nodes: [node('node-input', 'input', 'input'), node('node-model-images', 'image', 'model_images'),
      node('node-script', 'text', 'script_generation'), loop, node('node-image', 'image', 'first_frame'), video, concat],
    edges: [
      { id: 'input-model', from: 'node-input', to: 'node-model-images' },
      { id: 'model-script', from: 'node-model-images', to: 'node-script' },
      { id: 'script-loop', from: 'node-script', to: 'node-loop' },
      { id: 'loop-image', from: 'node-loop', to: 'node-image' },
      { id: 'image-video', from: 'node-image', to: 'node-video' },
      { id: 'video-concat', from: 'node-video', to: 'node-video-concat' },
    ] }
  const upgraded = upgradeStoryQualityWorkflow(before)
  return { ...upgraded, edges: STORY_MEDIA_RETAKE_CANONICAL_EDGES.map(edge => ({ ...edge })) }
}

test('media retake accepts an exact saved schema-5 story quality snapshot', () => {
  const workflow = reviewedWorkflow()
  const runs = workflow.nodes.map(node => ({ node: structuredClone(node) }))
  assert.equal(checkedStoryMediaRetakeWorkflow(workflow, runs), true)
})

test('media retake rejects changed video instructions and a route bypassing review', () => {
  const workflow = reviewedWorkflow()
  const runs = workflow.nodes.map(node => ({ node: structuredClone(node) }))
  const changedPrompt = { ...workflow, nodes: workflow.nodes.map(node => node.id === 'node-video'
    ? { ...node, prompt: `${node.prompt} extra` } : node) }
  assert.equal(checkedStoryMediaRetakeWorkflow(changedPrompt, runs), false)
  const bypass = { ...workflow, edges: [...workflow.edges,
    { id: 'bypass-review', from: 'node-video', to: 'node-video-concat' }] }
  assert.equal(checkedStoryMediaRetakeWorkflow(bypass, runs), false)
  const changedLoop = runs.map(run => run.node.id === 'node-loop' ? { node: {
    ...run.node, loop: { ...run.node.loop, sourcePath: 'script_generation.shots' },
  } } : run)
  assert.equal(checkedStoryMediaRetakeWorkflow(workflow, changedLoop), false)
})

test('media retake validates old captured nodes without silently adding a paid shot binding', () => {
  const workflow = reviewedWorkflow()
  const missingBinding = { ...workflow, nodes: workflow.nodes.map(node => ['node-image', 'node-video'].includes(node.id)
    ? { ...node, params: node.params.filter(param => param.englishName !== 'storyShot') } : node) }
  const runs = missingBinding.nodes.map(node => ({ node: structuredClone(node) }))
  assert.equal(checkedStoryMediaRetakeWorkflow(missingBinding, runs), true)
  assert.equal(missingBinding.nodes.find(node => node.id === 'node-video')?.params
    .some(param => param.englishName === 'storyShot'), false)
  assert.equal(checkedStoryMediaRetakeWorkflow(workflow, runs), false)
  assert.equal(checkedStoryMediaRetakeWorkflow({ ...workflow, schemaVersion: 4 }, runs), false)
})
