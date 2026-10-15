import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { firstBlockingRunIndex, refreshPendingExecutionNodes, scopedLoopNodes } from '../src/workflow-core.ts'
import { orderRouteNodes } from '../src/workflow-branch.ts'
import { orderLoopPlaceholders, runWorkflowToCompletion } from '../src/workflow-runner.ts'

test('wf-story adds an optional end frame and preserves a pending run override on refresh', async () => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const { normalizeWorkflow } = await vite.ssrLoadModule('/src/App.tsx')
    const node = (id: string, kind: string, resultVar = id) => ({ id, title: id, kind, resultVar, prompt: '', params: [], uploads: [],
      loop: { enabled: kind === 'loop', sourcePath: kind === 'loop' ? 'script_generation.shots' : '',
        itemVar: 'shot', fallbackCount: kind === 'loop' ? 8 : 0 }, position: { x: 0, y: 0 } })
    const legacyVideo = { ...node('node-video', 'video'), modelId: 'keling3', prompt: '${shot.content}',
      params: [{ id: 'duration', name: '时长', englishName: 'duration', type: 'number', required: true, value: '3' }] }
    const legacy = { id: 'wf-story', name: 'Story', schemaVersion: 2,
      nodes: [node('node-input', 'input'), node('node-script', 'text', 'script_generation'), node('node-loop', 'loop'),
        node('node-image', 'image'), legacyVideo], edges: [
          { id: 'input-script', from: 'node-input', to: 'node-script' },
          { id: 'script-loop', from: 'node-script', to: 'node-loop' },
          { id: 'loop-image', from: 'node-loop', to: 'node-image' },
          { id: 'image-video', from: 'node-image', to: 'node-video' },
        ] }
    const migrated = normalizeWorkflow(legacy)
    const video = migrated.nodes.find((item: { id: string }) => item.id === 'node-video')
    assert.match(video.prompt, /\$\{shot\.timedActions\}/)
    const markedOnly = normalizeWorkflow({ ...legacy, nodes: legacy.nodes.map(current => current.id === 'node-video'
      ? { ...legacyVideo, prompt: '【节拍完成】保持氛围，不写动作变量。' } : current) })
    assert.match(markedOnly.nodes.find((item: { id: string }) => item.id === 'node-video').prompt, /\$\{shot\.timedActions\}/)
    const endImage = video.params.find((param: { englishName: string }) => param.englishName === 'endImage')
    assert.deepEqual(endImage, { id: 'story-optional-end-image', name: '目标尾帧（可选）', englishName: 'endImage',
      type: 'image', required: false, value: '' })
    assert.equal(migrated.schemaVersion, 6)
    assert.equal(migrated.nodes.find((item: { id: string }) => item.id === 'node-script-review').kind, 'validation')
    assert.equal(migrated.nodes.find((item: { id: string }) => item.id === 'node-video-review').kind, 'validation')
    assert.equal(migrated.nodes.find((item: { id: string }) => item.id === 'node-video-review-result-branch').kind, 'branch')
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkflow(migrated))), JSON.parse(JSON.stringify(migrated)))

    const pending = migrated.nodes.map((current: { id: string }) => ({
      node: current.id === 'node-video' ? legacyVideo : current,
      status: current.id === 'node-video' ? 'idle' : 'success',
      ...(current.id === 'node-video' ? { paramOverrides: { [endImage.id]: '/generated/target.png' } } : {}),
    }))
    const refreshed = refreshPendingExecutionNodes(migrated, pending).find(run => run.node.id === 'node-video')!
    assert.equal(refreshed.node.params.find((param: { englishName: string }) => param.englishName === 'endImage')?.id, endImage.id)
    assert.equal(refreshed.paramOverrides[endImage.id], '/generated/target.png')
  } finally {
    await vite.close()
  }
})

test('wf-story normalization upgrades the saved loop to a visible staged concat', async () => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const { normalizeWorkflow } = await vite.ssrLoadModule('/src/App.tsx')
    const node = (id: string, kind: string, resultVar = id) => ({ id, title: id, kind, resultVar, prompt: '', params: [], uploads: [],
      loop: { enabled: kind === 'loop', sourcePath: 'script_generation.shots', itemVar: 'shot', fallbackCount: 2 },
      position: { x: 0, y: 0 } })
    const saved = { id: 'wf-story', name: '打工猫短视频分镜生成', schemaVersion: 3,
      nodes: [node('node-input', 'input'), node('node-model-images', 'image'), node('node-script', 'text', 'script_generation'),
        node('node-loop', 'loop'), node('node-image', 'image'), node('node-video', 'video', 'actual_take')],
      edges: [
        { id: 'input-model', from: 'node-input', to: 'node-model-images' },
        { id: 'model-script', from: 'node-model-images', to: 'node-script' },
        { id: 'script-loop', from: 'node-script', to: 'node-loop' },
        { id: 'loop-image', from: 'node-loop', to: 'node-image' },
        { id: 'image-video', from: 'node-image', to: 'node-video' },
      ] }
    const normalized = normalizeWorkflow(saved)
    assert.equal(normalized.schemaVersion, 6)
    assert.deepEqual(normalized.nodes.find((item: { id: string }) => item.id === 'node-loop').childIds,
      ['node-image', 'node-video', 'node-video-review', 'node-video-review-result-branch', 'node-video-concat'])
    assert.equal(normalized.nodes.find((item: { id: string }) => item.id === 'node-video-concat')
      .params.find((param: { englishName: string }) => param.englishName === 'currentVideo').value, '${video_review}')
    assert.equal(normalized.nodes.find((item: { id: string }) => item.id === 'node-script-review').operation, 'story.script-review')
    assert.equal(normalized.nodes.find((item: { id: string }) => item.id === 'node-video-review').operation, 'story.media-review')
    const videoParams = normalized.nodes.find((item: { id: string }) => item.id === 'node-video').params
    const paramValue = (name: string) => videoParams.find((param: { englishName: string }) => param.englishName === name)?.value
    assert.equal(paramValue('requiredPromptText'), '${shot.timedActions}')
    assert.equal(paramValue('expectedDuration'), '${shot.duration}')
    assert.equal(paramValue('requiredSound'), 'on')

    const route = orderRouteNodes(normalized)
    assert.equal(route.hasCycle, false)
    const ordered = orderLoopPlaceholders(normalized, route.ordered).map((item: { id: string }) => item.id)
    assert.deepEqual(ordered, ['node-input', 'node-model-images', 'node-script', 'node-script-review',
      'node-loop', 'node-image', 'node-video', 'node-video-review', 'node-video-review-result-branch', 'node-video-concat'])
    assert.deepEqual(scopedLoopNodes(normalized, 'node-loop', route.ordered).map((item: { id: string }) => item.id),
      ['node-image', 'node-video', 'node-video-review', 'node-video-review-result-branch', 'node-video-concat'])
    const scriptReviewIndex = ordered.indexOf('node-script-review')
    const videoIndex = ordered.indexOf('node-video')
    const mediaReviewIndex = ordered.indexOf('node-video-review')
    const concatIndex = ordered.indexOf('node-video-concat')
    const scriptFailureRuns = ordered.map((_, index) => ({ status: index < scriptReviewIndex ? 'success'
      : index === scriptReviewIndex ? 'failed' : 'idle' }))
    assert.equal(firstBlockingRunIndex(scriptFailureRuns, videoIndex), scriptReviewIndex)
    const mediaFailureRuns = ordered.map((_, index) => ({ status: index < mediaReviewIndex ? 'success'
      : index === mediaReviewIndex ? 'failed' : 'idle' }))
    assert.equal(firstBlockingRunIndex(mediaFailureRuns, concatIndex), mediaReviewIndex)
    const attempted: string[] = []
    const stopped = await runWorkflowToCompletion({ nodeRuns: ordered.map(id => ({ id, status: 'idle' as const })) },
      async (index, state) => {
        attempted.push(state.nodeRuns[index].id)
        return { nodeRuns: state.nodeRuns.map((run, at) => at === index
          ? { ...run, status: run.id === 'node-script-review' ? 'failed' as const : 'success' as const } : run) }
      })
    assert.equal(stopped.nodeRuns[scriptReviewIndex].status, 'failed')
    assert.deepEqual(attempted, ordered.slice(0, scriptReviewIndex + 1))
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkflow(normalized))), JSON.parse(JSON.stringify(normalized)))
  } finally {
    await vite.close()
  }
})
