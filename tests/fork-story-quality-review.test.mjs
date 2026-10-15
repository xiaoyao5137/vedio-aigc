import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareStoryQualityReviewFork, targetStoryQualityWorkflow } from '../scripts/fork-story-quality-review.mjs'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'

const node = (id, kind, resultVar = id) => ({ id, kind, title: id, resultVar, prompt: '', params: [], uploads: [],
  loop: { enabled: kind === 'loop', sourcePath: '', fallbackCount: 0, itemVar: 'shot' }, position: { x: 0, y: 0 } })

function workflow() {
  const input = node('node-input', 'input', 'input')
  const model = node('node-model-images', 'image', 'model_images')
  const script = node('node-script', 'text', 'script_generation')
  const loop = node('node-loop', 'loop', 'shot_loop')
  loop.childIds = ['node-image', 'node-video', 'node-video-concat']
  loop.loop.sourcePath = 'script_generation.shots'
  const image = node('node-image', 'image', 'first_frame')
  const video = node('node-video', 'video', 'video_shot')
  video.prompt = '${shotTimedActions}'
  const concat = node('node-video-concat', 'videoConcat', 'stage_video')
  concat.params = [{ id: 'current', name: '本轮视频', englishName: 'currentVideo', type: 'json', required: true, value: '${video_shot}' }]
  const schema4 = { id: 'wf-story', schemaVersion: 4, nodes: [input, model, script, loop, image, video, concat],
    edges: [
      { id: 'input-model', from: input.id, to: model.id }, { id: 'model-script', from: model.id, to: script.id },
      { id: 'script-loop', from: script.id, to: loop.id }, { id: 'loop-image', from: loop.id, to: image.id },
      { id: 'image-video', from: image.id, to: video.id }, { id: 'video-concat', from: video.id, to: concat.id },
    ] }
  const upgraded = upgradeStoryQualityWorkflow(schema4)
  return { id: 'wf-story', schema_version: 5, nodes: upgraded.nodes, edges: upgraded.edges, nodes_md5: 'workflow-md5' }
}

function shot(title) {
  return { title, content: '猫推硬币；狗递纸袋。', duration: 5, camera: '固定', mood: '轻松', firstFramePrompt: '猫狗在柜台两侧',
    visualBeats: [
      { id: `${title}-coin`, action: '猫推硬币', completion: '硬币到狗面前', startSecond: 0, endSecond: 2 },
      { id: `${title}-bag`, action: '狗递纸袋', completion: '纸袋到猫面前', startSecond: 2, endSecond: 4 },
    ] }
}

function source() {
  const shots = [shot('早餐'), shot('午睡')]
  const scriptOutput = { shots, items: shots }
  const media = { url: '/generated/existing.mp4', sha256: 'a'.repeat(64) }
  const clip = { url: media.url, videoEvidence: { sha256: media.sha256 },
    storyMediaReview: { reviewStatus: 'uncertain', passed: false } }
  const definitions = workflow().nodes
  const byId = new Map(definitions.map(item => [item.id, item]))
  const originalLoop = { ...byId.get('node-loop'), childIds: ['node-image', 'node-video'],
    loop: { ...byId.get('node-loop').loop, sourcePath: 'script_generation.shots' } }
  const group = 'loop-old-1'
  const run = (id, status, output, context, loopIndex) => ({
    id: `${id}-${loopIndex ?? 0}`, node: id === 'node-loop' ? originalLoop : byId.get(id),
    status, output, context, inputs: {}, inputContext: {}, durationMs: 1,
    ...(loopIndex === undefined ? {} : { loopNode: originalLoop, loopIndex, loopGroupId: group,
      loopItem: shots[loopIndex], loopIsLast: loopIndex === 1 && id === 'node-video' }),
  })
  const root = { input: { vedio_count: 2 }, script_generation: scriptOutput, shot: shots[0], video_shot: clip }
  const runs = [run('node-input', 'success', { vedio_count: 2 }, { input: { vedio_count: 2 } }),
    run('node-model-images', 'success', { urls: [] }, { input: { vedio_count: 2 }, model_images: { urls: [] } }),
    run('node-script', 'success', scriptOutput, { input: { vedio_count: 2 }, script_generation: scriptOutput }),
    run('node-loop', 'success', { count: 2 }, { input: { vedio_count: 2 }, script_generation: scriptOutput, shot_loop: { count: 2 } }),
    run('node-image', 'success', { url: '/generated/first.png' }, { ...root, first_frame: { url: '/generated/first.png' } }, 0),
    run('node-video', 'success', clip, root, 0),
    run('node-image', 'idle', undefined, {}, 1), run('node-video', 'idle', undefined, {}, 1)]
  return { id: 'record-story-shot1-visual-v1', workflow_id: 'wf-story', result_md5: 'source-md5',
    runtime_inputs: { input: { vedio_count: 2 } }, result: { id: 'record-story-shot1-visual-v1', workflowId: 'wf-story',
      runtimeInputs: { input: { vedio_count: 2 } }, nodeRuns: runs, logs: [], context: root,
      humanStoryReview: { verdict: 'pass', video: media } }, media }
}

test('fork inserts explicit review runs while preserving the existing paid clip exactly', async () => {
  const prior = source(), savedBefore = structuredClone(prior)
  const prepared = await prepareStoryQualityReviewFork(prior, workflow(), prior.media, 'record-story-quality-test')
  assert.deepEqual(prior, savedBefore)
  assert.equal(prepared.state.nodeRuns.length, 13)
  assert.deepEqual(prepared.state.nodeRuns.map(run => run.node.id), [
    'node-input', 'node-model-images', 'node-script', 'node-script-review', 'node-loop',
    'node-image', 'node-video', 'node-video-review', 'node-video-concat',
    'node-image', 'node-video', 'node-video-review', 'node-video-concat',
  ])
  assert.equal(prepared.state.nodeRuns[3].output.passed, true)
  assert.equal(prepared.state.nodeRuns[6].output, prior.result.nodeRuns[5].output)
  assert.equal(prepared.state.nodeRuns[7].status, 'idle')
  assert.equal(prepared.state.nodeRuns[10].status, 'idle')
  const reviewInput = prepareWorkflowRunContext(prepared.state.nodeRuns, 7).inputContext
  assert.equal(reviewInput.video_shot, prepared.state.nodeRuns[6].output)
  assert.equal(reviewInput.script_review.passed, true)
  assert.equal(typeof reviewInput.shot.timedActions, 'string')
  assert.equal(prepared.state.nodeRuns[12].loopIsLast, true)
  assert.equal(prepared.state.nodeRuns.filter(run => run.loopIsLast).length, 1)
  assert.equal(prepared.proof.modelCalls, 0)
  assert.equal(prepared.proof.firstPendingIndex, 7)
  assert.equal(prepared.state.storyQualityVisibleFork.scriptReviewMode, 'retroactive-deterministic-check')
})

test('fork rejects changed clip evidence and review bypasses', async () => {
  const prior = source()
  prior.result.nodeRuns[5].output.videoEvidence.sha256 = 'b'.repeat(64)
  await assert.rejects(prepareStoryQualityReviewFork(prior, workflow(), prior.media, 'record-story-quality-test'),
    /source clip or existing review evidence differs/)
  const target = workflow()
  target.edges.push({ id: 'bypass', from: 'node-video', to: 'node-video-concat' })
  assert.throws(() => targetStoryQualityWorkflow(target), /quality review can be bypassed/)
})
