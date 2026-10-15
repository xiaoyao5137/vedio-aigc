import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareStoryShot2SpatialFork, newPlacement } from '../scripts/fork-story-shot2-spatial.mjs'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { renderStoryShotTimedActions } from '../src/story-shot-timing.ts'
import { validateStoryShotAssessment } from '../server/story-media-review.ts'
import { validateHumanStoryReview } from '../scripts/story-shot-human-review.mjs'
import { prepareStoryShot1HumanAcceptanceFork } from '../scripts/fork-story-shot1-human-accepted.mjs'

const hash = createJsonHasher()
const oldPlacement = ' 柴犬位于蓝猫身体后侧，犬口鼻正对猫背部中段，猫背中段完整无遮挡；犬下巴与猫背留有几厘米可见空隙。'
const imageUrl = '/generated/shot1.png'
const videoUrl = '/generated/shot1.mp4'
const media = { imageSha256: 'b'.repeat(64), videoSha256: 'a'.repeat(64) }

function sourceFixture() {
  const originalShots = [
    { title: '早餐到爪', content: '0—1秒，蓝猫推硬币；1—3秒，柴犬推纸袋。',
      firstFramePrompt: '蓝猫和柴犬在早餐柜台两侧。' },
    { title: '公司的午睡搭子', content: '0—2秒，柴犬把下巴搭在蓝猫背上；2—3秒，蓝猫睁眼侧瞥柴犬。',
      firstFramePrompt: '午后公司办公桌，蓝猫闭眼趴在键盘旁，柴犬坐在桌边椅子上，下巴悬在猫背上方。' },
  ]
  const originalOutput = { shots: originalShots, raw: { source: 'original' } }
  const originalState = { id: 'record-a7c0ix', workflowId: 'wf-story',
    nodeRuns: [null, null, { id: 'node-script-2', node: { id: 'node-script' }, output: originalOutput }] }
  const shots = [
    { title: originalShots[0].title, content: '0—4秒，蓝猫推硬币；4—7秒，柴犬推纸袋。', duration: 8,
      camera: '固定机位', mood: '清晨', firstFramePrompt: originalShots[0].firstFramePrompt,
      visualBeats: [
        { id: 'coin', action: '蓝猫推硬币', completion: '硬币停在柴犬一侧', startSecond: 0, endSecond: 4 },
        { id: 'bag', action: '柴犬推纸袋', completion: '纸袋停在蓝猫一侧', startSecond: 4, endSecond: 7 },
      ] },
    { title: originalShots[1].title, content: '0—4秒，柴犬把下巴搭在蓝猫背上；4—7秒，蓝猫睁眼侧瞥柴犬。', duration: 8,
      camera: '侧面固定机位', mood: '午后', firstFramePrompt: originalShots[1].firstFramePrompt + oldPlacement,
      visualBeats: [
        { id: 'chin', action: '柴犬把下巴搭在蓝猫背上', completion: '犬下巴接触猫背中段', startSecond: 0, endSecond: 4 },
        { id: 'look', action: '蓝猫睁眼侧瞥柴犬', completion: '猫睁眼侧瞥犬', startSecond: 4, endSecond: 7 },
      ] },
  ]
  const recovery = { version: 'story-two-shot-manual-timing-replan-v1', sourceExecutionId: 'record-a7c0ix',
    sourceRunId: 'node-script-2', sourceScriptOutputSha256: hash(originalOutput), reusedImage1Url: imageUrl }
  const output = { raw: { recovery }, text: JSON.stringify(shots, null, 2), items: shots,
    shots, model: 'manual-timing-replan-v1', recovery }
  const refs = ['/generated/cat-front.png', '/generated/cat-side.png',
    '/generated/dog-front.png', '/generated/dog-side.png'].map(url => ({ url }))
  const imageNode = { id: 'node-image', kind: 'image', modelId: 'codex-gpt-image-2', resultVar: 'first_frame',
    prompt: '首帧：${shot.firstFramePrompt}', params: [
      { englishName: 'referenceImages', value: '${model_images.items}' },
      { englishName: 'size', value: '576x1024' }, { englishName: 'singleFrame', value: 'true' },
    ] }
  const videoNode = { id: 'node-video', kind: 'video', modelId: 'keling3', resultVar: 'video_take',
    prompt: '8 秒内完成：${shotTimedActions}', params: [
      { englishName: 'referenceImage', value: '${first_frame}' },
      { englishName: 'duration', value: '${shot.duration}' }, { englishName: 'endImage', value: '' },
    ] }
  const beforeLoop = { model_images: { items: refs }, script_generation: output }
  const loopOutput = { count: 2, loopSource: 'script_generation.shots', itemVar: 'shot' }
  const loopContext = { ...beforeLoop, shot_loop: loopOutput }
  const imageOutput = { url: imageUrl, model: 'codex-gpt-image-2', prompt: shots[0].firstFramePrompt }
  const evidence = { decoded: true, sha256: media.videoSha256, evidenceUrl: '/generated/evidence.json',
    url: videoUrl, duration: 8.04, frames: Array.from({ length: 7 }, (_, index) => `/generated/frame-${index}.jpg`),
    frameTimes: [0, 2, 4, 5.5, 7, 7.5, 7.98] }
  const descriptions = ['硬币在猫爪旁，纸袋在柴犬爪旁。', '蓝猫正在推动硬币。',
    '硬币停在柴犬一侧，纸袋仍在柴犬爪旁。', '柴犬前爪接触纸袋。',
    '纸袋停在蓝猫一侧。', '纸袋停在蓝猫一侧。', '纸袋停在蓝猫一侧。']
  const observations = { version: 'story-shot-observations-v1', sourceVideoSha256: evidence.sha256,
    evidenceUrl: evidence.evidenceUrl, frames: evidence.frames.map((frameUrl, frameIndex) => ({
      frameIndex, frameUrl, second: evidence.frameTimes[frameIndex], description: descriptions[frameIndex],
    })) }
  const assessment = { version: 'story-shot-media-review-v1', sourceVideoSha256: evidence.sha256,
    evidenceUrl: evidence.evidenceUrl, passed: true, beatChecks: [
      { id: 'coin', status: 'complete', startFrameIndex: 0, completionFrameIndex: 2,
        startObservation: '硬币在猫爪旁', completionObservation: '硬币停在柴犬一侧' },
      { id: 'bag', status: 'complete', startFrameIndex: 3, completionFrameIndex: 4,
        startObservation: '柴犬前爪接触纸袋', completionObservation: '纸袋停在蓝猫一侧' },
    ], endingHold: { status: 'complete', firstFrameIndex: 4, lastFrameIndex: 6,
      firstObservation: '纸袋停在蓝猫一侧', lastObservation: '纸袋停在蓝猫一侧' }, issues: [] }
  const validated = validateStoryShotAssessment(shots[0], evidence as never, observations, assessment)
  assert.equal(validated.reviewStatus, 'passed', 'the test fixture must have a real valid review')
  const videoOutput = { url: videoUrl, model: 'keling3', prompt: renderStoryShotTimedActions(shots[0]),
    params: { referenceImage: imageOutput, duration: 8 },
    storyMediaReview: { ...validated, observations, assessment, videoEvidence: evidence } }
  const loopNode = { id: 'node-loop', loop: { itemVar: 'shot' } }
  const scope = { loopGroupId: 'loop-1', loopNode }
  const shot1Context = { ...loopContext, shot: shots[0], first_frame: imageOutput, video_take: videoOutput }
  const idle = (id: string, node: typeof imageNode | typeof videoNode) => ({ id, node, status: 'idle', ...scope,
    loopIndex: 1, loopItem: shots[1], context: {}, inputContext: {}, inputs: {}, attempt: 1, errorAttempt: 1 })
  const runs = [
    { id: 'input', node: { id: 'node-input', resultVar: 'input' }, status: 'success', output: {} },
    { id: 'refs', node: { id: 'node-model-images', resultVar: 'model_images' }, status: 'success', output: { items: refs } },
    { id: 'script', node: { id: 'node-script', resultVar: 'script_generation' }, status: 'success',
      output, context: beforeLoop },
    { id: 'loop', node: { id: 'node-loop', resultVar: 'shot_loop' }, status: 'success',
      inputContext: beforeLoop, output: loopOutput, context: loopContext },
    { id: 'image1', node: imageNode, status: 'success', ...scope, loopIndex: 0, loopItem: shots[0],
      output: imageOutput, context: { ...loopContext, shot: shots[0], first_frame: imageOutput } },
    { id: 'video1', node: videoNode, status: 'success', ...scope, loopIndex: 0, loopItem: shots[0],
      inputs: { referenceImage: imageOutput }, inputContext: { first_frame: imageOutput },
      output: videoOutput, context: shot1Context },
    idle('image2', imageNode), idle('video2', videoNode),
  ]
  const source = { id: 'record-accepted-shot1', workflow_id: 'wf-story', result_md5: '1'.repeat(32),
    result: { id: 'record-accepted-shot1', workflowId: 'wf-story', nodeRuns: runs, context: shot1Context,
      storyTwoShotRecovery: recovery, logs: [] } }
  const original = { id: 'record-a7c0ix', workflow_id: 'wf-story', result_md5: '2'.repeat(32), result: originalState }
  const workflow = { id: 'wf-story', schema_version: 3, nodes_md5: '3'.repeat(32),
    nodes: structuredClone([imageNode, videoNode]) }
  return { source, original, workflow, shots }
}

test('fork preserves accepted shot 1 and rewrites only shot 2 spatial suffix across every script copy', () => {
  const { source, original, workflow, shots } = sourceFixture()
  const sourceBefore = structuredClone(source), originalBefore = structuredClone(original)
  const prepared = prepareStoryShot2SpatialFork(source, original, workflow, media, 'record-shot2-test', '2026-09-29T00:00:00Z')
  const fork = prepared.state, next = fork.nodeRuns[2].output
  assert.equal(fork.parentExecutionId, source.id)
  assert.deepEqual(fork.nodeRuns.slice(4, 6), source.result.nodeRuns.slice(4, 6))
  assert.equal(fork.nodeRuns[6].status, 'idle')
  assert.equal(fork.nodeRuns[7].status, 'idle')
  assert.equal(fork.nodeRuns[6].routeInputContext.script_generation, next)
  assert.equal(next.shots[0].firstFramePrompt, shots[0].firstFramePrompt)
  assert.equal(next.shots[1].firstFramePrompt, shots[1].firstFramePrompt.slice(0, -oldPlacement.length) + ' ' + newPlacement)
  assert.deepEqual(next.items, next.shots)
  assert.deepEqual(JSON.parse(next.text), next.shots)
  assert.deepEqual(source, sourceBefore)
  assert.deepEqual(original, originalBefore)
  assert.equal(prepared.proof.resolvedVideoDuration, 8)
  assert.equal(prepared.proof.modelCalls, 0)
})

test('fork refuses unpaid or unaccepted first shot and any unexpected source-story change', () => {
  const fixture = sourceFixture()
  fixture.source.result.nodeRuns[5].status = 'idle'
  assert.throws(() => prepareStoryShot2SpatialFork(fixture.source, fixture.original, fixture.workflow,
    media, 'record-shot2-test'), /six successful prefix runs/)
  const badReview = sourceFixture()
  badReview.source.result.nodeRuns[5].output.storyMediaReview.passed = false
  assert.throws(() => prepareStoryShot2SpatialFork(badReview.source, badReview.original, badReview.workflow,
    media, 'record-shot2-test'), /no matching passed media review/)
  const changedPrompt = sourceFixture()
  changedPrompt.source.result.nodeRuns[2].output.shots[1].firstFramePrompt += '额外改动'
  changedPrompt.source.result.nodeRuns[2].output.text = JSON.stringify(
    changedPrompt.source.result.nodeRuns[2].output.shots, null, 2)
  assert.throws(() => prepareStoryShot2SpatialFork(changedPrompt.source, changedPrompt.original,
    changedPrompt.workflow, media, 'record-shot2-test'), /old shot 2 placement/)
  const wrongMedia = sourceFixture()
  assert.throws(() => prepareStoryShot2SpatialFork(wrongMedia.source, wrongMedia.original,
    wrongMedia.workflow, { ...media, videoSha256: 'c'.repeat(64) }, 'record-shot2-test'),
  /review does not bind the actual video bytes/)
  const driftedWorkflow = sourceFixture()
  driftedWorkflow.workflow.nodes[0].prompt += '新规则'
  assert.throws(() => prepareStoryShot2SpatialFork(driftedWorkflow.source, driftedWorkflow.original,
    driftedWorkflow.workflow, media, 'record-shot2-test'), /saved pending nodes differ/)
})

function uncertainSourceFixture() {
  const { source, original, workflow } = sourceFixture()
  const parent = structuredClone(source)
  parent.id = 'record-first-shot-uncertain'
  parent.result.id = parent.id
  const video = parent.result.nodeRuns[5] as never as Record<string, unknown> & { output: Record<string, unknown> & {
    storyMediaReview: unknown; audioLevelRemediation?: unknown } }
  video.status = 'failed'
  video.output.storyMediaReview = {
    passed: false, retryable: false, reviewStatus: 'uncertain', issues: ['硬币短暂遮挡，自动审核无法判断'],
    videoEvidence: { decoded: true, url: video.output.url, sha256: media.videoSha256, duration: 8.04 },
  }
  video.output.audioLevelRemediation = {
    manifestUrl: '/generated/audio.json', manifestSha256: 'd'.repeat(64),
    sourceSha256: 'c'.repeat(64), outputSha256: media.videoSha256,
  }
  video.output.sameMediaReviewRetry = { sourceVideoSha256: media.videoSha256 }
  parent.result.storyAudioReviewRecovery = {
    derivativeVideoSha256: media.videoSha256, derivativeVideoUrl: video.output.url,
    manifestUrl: '/generated/audio.json', manifestSha256: 'd'.repeat(64),
    sourceVideoSha256: 'c'.repeat(64), sameDecodedVideoFramesSha256: 'e'.repeat(64),
    videoFrameCount: 193,
  }
  const times = [0, 1.5, 2.5, 3.5, 4, 4.5, 5.5, 6, 7, 7.5, 7.96]
  const frames = times.map((second, index) => ({ second,
    file: `story-shot1-endframe-local-qa-v2/shot-1/sample-${String(index).padStart(2, '0')}.jpg`,
    sha256: index.toString(16).repeat(64), observation: `实际解码画面 ${second} 秒，可见猫犬、硬币与装包子的纸袋位置。` }))
  const shot = parent.result.nodeRuns[2].output.shots[0]
  const report = {
    version: 'story-shot-direct-visual-review-v1', reviewMethod: 'agent-direct-visual',
    reviewer: 'Codex', reviewedAt: '2026-09-29T02:00:00Z', verdict: 'pass', confidence: 'moderate',
    limitations: ['逐帧视觉判断不等于用户对成片的主观验收。'],
    sourceRecordId: parent.id, sourceResultMd5: parent.result_md5, sourceReviewStatus: 'uncertain',
    sourceReviewSha256: hash(video.output.storyMediaReview), sourceVideoOutputSha256: hash(video.output),
    sourceScriptOutputSha256: hash(parent.result.nodeRuns[2].output), sourceShotSha256: hash(shot),
    firstFrame: { url: imageUrl, sha256: media.imageSha256 },
    video: { url: videoUrl, sha256: media.videoSha256, durationSeconds: 8.04 },
    audioLevelManifest: { url: '/generated/audio.json', sha256: 'd'.repeat(64),
      sourceVideoSha256: 'c'.repeat(64), sameDecodedVideoFramesSha256: 'e'.repeat(64) },
    frames,
    beatChecks: [
      { id: shot.visualBeats[0].id, action: shot.visualBeats[0].action,
        requiredCompletion: shot.visualBeats[0].completion, status: 'complete', confidence: 'moderate',
        startSecond: 0, completionSecond: 3.5, startFrameSha256: frames[0].sha256,
        completionFrameSha256: frames[3].sha256,
        observation: '猫爪先接触硬币并前伸，硬币随后停在犬前爪可以触及的位置。' },
      { id: shot.visualBeats[1].id, action: shot.visualBeats[1].action,
        requiredCompletion: shot.visualBeats[1].completion, status: 'complete', confidence: 'high',
        startSecond: 4, completionSecond: 6, startFrameSha256: frames[4].sha256,
        completionFrameSha256: frames[7].sha256,
        observation: '犬爪先搭住纸袋并把纸袋推向左侧，纸袋及包子到达猫前爪边。' },
    ],
    endingHold: { status: 'complete', confidence: 'high', startSecond: 7, endSecond: 7.96,
      firstFrameSha256: frames[8].sha256, lastFrameSha256: frames[10].sha256,
      observation: '包子纸袋留在猫爪边，硬币留在犬爪边，两个终态持续到末帧。' },
  }
  const review = validateHumanStoryReview(report, parent, media, 'f'.repeat(64))
  const verified = { review: report, file: 'qa/story-shot1-endframe-local-qa-v2/human-review.json',
    fileSha256: 'f'.repeat(64), media, manifest: { url: '/generated/audio.json', sha256: 'd'.repeat(64),
      data: { sourceSha256: 'c'.repeat(64), outputSha256: media.videoSha256,
        everyDecodedVideoFrameMatched: true, videoFrameCount: 193 } } }
  return { parent, source, original, workflow, report, review, verified }
}

test('separate visual fork keeps automated uncertain review and video bytes unchanged', () => {
  const fixture = uncertainSourceFixture()
  const prepared = prepareStoryShot1HumanAcceptanceFork(fixture.parent, fixture.workflow,
    fixture.verified, 'record-visual-test', '2026-09-29T02:00:00Z')
  assert.equal(fixture.parent.result.nodeRuns[5].status, 'failed')
  assert.equal(prepared.state.nodeRuns[5].status, 'success')
  assert.equal(prepared.state.nodeRuns[5].output.storyMediaReview.reviewStatus, 'uncertain')
  assert.deepEqual(prepared.state.nodeRuns[5].output, fixture.parent.result.nodeRuns[5].output)
  assert.equal(prepared.state.humanStoryReview.verdict, 'pass')
  assert.equal(prepared.state.nodeRuns[6].status, 'idle')
  fixture.source.result = prepared.state
  fixture.source.id = prepared.state.id
  const second = prepareStoryShot2SpatialFork(fixture.source, fixture.original, fixture.workflow,
    media, 'record-shot2-human-test', '2026-09-29T02:00:00Z', fixture.parent)
  assert.equal(second.proof.shot1Acceptance.method, 'direct-visual-pass')
  assert.equal(second.state.nodeRuns[5].output.storyMediaReview.reviewStatus, 'uncertain')
  assert.equal(second.state.nodeRuns[6].status, 'idle')
})

test('direct visual fallback rejects altered review, media and parent provenance', () => {
  const fixture = uncertainSourceFixture()
  const prepared = prepareStoryShot1HumanAcceptanceFork(fixture.parent, fixture.workflow,
    fixture.verified, 'record-visual-test', '2026-09-29T02:00:00Z')
  fixture.source.result = prepared.state
  fixture.source.id = prepared.state.id
  fixture.source.result.humanStoryReview.frames[3].sha256 = 'f'.repeat(64)
  assert.throws(() => prepareStoryShot2SpatialFork(fixture.source, fixture.original,
    fixture.workflow, media, 'record-shot2-human-test', undefined, fixture.parent),
  /independent visual acceptance does not revalidate|no matching independent visual acceptance|lacks bound before\/after visual evidence/)
  const other = uncertainSourceFixture()
  const changed = { ...other.verified, review: { ...other.report, sourceReviewStatus: 'passed' } }
  assert.throws(() => prepareStoryShot1HumanAcceptanceFork(other.parent, other.workflow,
    changed, 'record-visual-test'), /review does not bind/)
})
