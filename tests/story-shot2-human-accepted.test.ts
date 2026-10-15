import test from 'node:test'
import assert from 'node:assert/strict'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { parseStoryShot2HumanForkArgs, prepareStoryShot2HumanAcceptanceFork,
  validateStoryShot2HumanReview } from '../scripts/fork-story-shot2-human-accepted.mjs'
import { renderStoryShotTimedActions } from '../src/story-shot-timing.ts'

const hash = createJsonHasher()
const digest = (letter: string) => letter.repeat(64)
const times = Array.from({ length: 16 }, (_, index) => index * .5).concat(7.96)
const chosen = [0, 2, 4, 6, 8, 12, 14, 15, 16]

function fixture() {
  const sourceId = 'record-shot2-uncertain-fixture', parentId = 'record-shot2-paid-fixture'
  const paidUrl = '/generated/paid.mp4', reviewedUrl = '/generated/reviewed.mp4'
  const rawFoleyUrl = '/generated/foley.mp4', firstUrl = '/generated/first.png'
  const endUrl = '/generated/end.png', manifestUrl = '/generated/foley.json'
  const originalSha = digest('a'), derivedSha = digest('b'), wavSha = digest('c')
  const manifestSha = digest('d'), framesSha = digest('e')
  const shot = (name: string, number: number) => ({ title: name,
    content: '0—4秒，柴犬低头靠近蓝猫；4—7秒，蓝猫睁眼回头。',
    firstFramePrompt: '蓝猫和柴犬在办公桌旁。', camera: '固定机位', mood: '午后', duration: 8,
    visualBeats: [
      { id: `shot-${number}-beat-1`, action: '柴犬低头靠近蓝猫', completion: '犬下巴搭在猫背中段', startSecond: 0, endSecond: 4 },
      { id: `shot-${number}-beat-2`, action: '蓝猫睁眼回头', completion: '猫睁眼看向犬脸', startSecond: 4, endSecond: 7 },
    ] })
  const shots = [shot('第一镜', 1), shot('第二镜', 2)]
  const scriptOutput = { shots, items: shots }
  const image = { url: firstUrl, model: 'codex-gpt-image-2' }
  const imageNode = { id: 'node-image', kind: 'image', resultVar: 'first_frame' }
  const videoNode = { id: 'node-video', kind: 'video', resultVar: 'video_shot', modelId: 'keling3' }
  const loop = { loopGroupId: 'loop-test' }
  const paidReview = { reviewStatus: 'technical-failure', passed: false }
  const paidOutput = { url: paidUrl, model: 'keling3', storyMediaReview: paidReview }
  const evidence = { decoded: true, url: reviewedUrl, sha256: derivedSha, duration: 8.04,
    frames: times.map((_, index) => `/generated/review-frame-${index}.jpg`), frameTimes: times }
  const review = { reviewStatus: 'uncertain', passed: false, retryable: false, videoEvidence: evidence }
  const foley = { manifestUrl, manifestSha256: manifestSha, sourceSha256: originalSha,
    outputSha256: derivedSha, wavSha256: wavSha, videoFramesSha256: framesSha,
    everyDecodedVideoFrameMatched: true }
  const output = { url: reviewedUrl, model: 'keling3', params: { referenceImage: image,
    endImage: endUrl, duration: 8 }, prompt: renderStoryShotTimedActions(shots[1]),
    paidSourceUrl: paidUrl, paidSourceSha256: originalSha,
    paidSourceOutputSha256: hash(paidOutput), previousStoryMediaReview: paidReview,
    audioFoleyRemediation: foley, storyMediaReview: review }
  const nodeRuns = [
    { id: 'input', node: { id: 'node-input', resultVar: 'input' }, status: 'success', output: {}, context: {} },
    { id: 'refs', node: { id: 'node-model-images', resultVar: 'model_images' }, status: 'success', output: {}, context: {} },
    { id: 'script', node: { id: 'node-script', resultVar: 'script_generation' }, status: 'success', output: scriptOutput, context: {} },
    { id: 'loop', node: { id: 'node-loop', resultVar: 'shot_loop' }, status: 'success', output: {}, context: {} },
    { id: 'image1', node: imageNode, status: 'success', output: { url: '/generated/shot1.png' }, context: {} },
    { id: 'video1', node: videoNode, status: 'success', output: { url: '/generated/shot1.mp4' }, context: {} },
    { id: 'image2', node: imageNode, status: 'success', ...loop, loopIndex: 1, loopItem: shots[1],
      output: image, context: { first_frame: image, shot: shots[1] } },
    { id: 'video2', node: videoNode, status: 'failed', ...loop, loopIndex: 1, loopItem: shots[1],
      output, inputs: { referenceImage: image }, inputContext: { first_frame: image },
      routeInputContext: { first_frame: image, shot: shots[1] }, context: {}, error: 'uncertain' },
  ]
  const recovery = { sourceExecutionId: parentId, sourceRunId: 'video2',
    paidSourceOutputSha256: hash(paidOutput), manifestSha256: manifestSha,
    derivativeVideoSha256: derivedSha, sourceVideoSha256: originalSha,
    foleyWavSha256: wavSha, sameDecodedVideoFramesSha256: framesSha,
    soundContentSemanticReview: 'pending-human-listen' }
  const source = { id: sourceId, workflow_id: 'wf-story', result_md5: '1'.repeat(32),
    result: { id: sourceId, workflowId: 'wf-story', nodeRuns, storyFoleyReviewRecovery: recovery,
      context: {}, logs: [] } }
  const parent = { id: parentId, workflow_id: 'wf-story', result_md5: '2'.repeat(32),
    result: { id: parentId, workflowId: 'wf-story', nodeRuns: [
      ...nodeRuns.slice(0, 7), { ...nodeRuns[7], status: 'failed', output: paidOutput },
    ] } }
  const manifest = { sourceSha256: originalSha, outputSha256: derivedSha,
    outputVideoFramesSha256: framesSha, videoFrameCount: 193 }
  const verified = { reportFile: 'qa/story-shot2-gaze-v2-local-qa/direct-visual-review-foley.json',
    reportSha256: digest('f'), reviewedVideo: { url: reviewedUrl, sha256: derivedSha },
    derivative: { manifest, manifestUrl, manifestSha256: manifestSha,
      source: { url: paidUrl, sha256: originalSha }, output: { url: rawFoleyUrl, sha256: derivedSha },
      wav: { url: '/generated/foley.wav', sha256: wavSha } },
    media: { firstFrame: { url: firstUrl, sha256: digest('1') },
      endImage: { url: endUrl, sha256: digest('2') } }, report: undefined as unknown }
  const frames = chosen.map((frameIndex, index) => ({ second: times[frameIndex], frameIndex,
    frameUrl: evidence.frames[frameIndex], frameSha256: index.toString(16).repeat(64),
    originalQaFile: `qa/story-shot2-gaze-v2-local-qa/shot-2/sample-${String(frameIndex).padStart(2, '0')}.jpg`,
    observation: `第 ${frameIndex} 帧可见猫和柴犬处于连续动作，犬靠近猫背。` }))
  const frame = (second: number) => frames.find(item => item.second === second)!
  const report = { version: 'story-shot2-direct-visual-review-v1', reviewMethod: 'agent-direct-visual',
    reviewer: 'Codex', reviewedAt: '2026-09-29T00:00:00Z', verdict: 'visual-pass', confidence: 'moderate',
    sourceRecordId: sourceId, sourceResultMd5: source.result_md5,
    sourceReviewStatus: 'uncertain', sourceReviewSha256: hash(review),
    sourceVideoOutputSha256: hash(output), scriptOutputSha256: hash(scriptOutput),
    shotSha256: hash(shots[1]), originalVideo: { url: paidUrl, sha256: originalSha },
    derivedVideo: { url: reviewedUrl, sha256: derivedSha, durationSeconds: 8.04, decodedFrameCount: 193 },
    foleyManifest: { url: manifestUrl, sha256: manifestSha, sourceSha256: originalSha,
      outputSha256: derivedSha, sourceAndOutputDecodedFrameSequenceSha256: framesSha,
      everyDecodedVideoFrameMatched: true }, frames,
    beatChecks: shots[1].visualBeats.map((beat, index) => {
      const start = frame(index === 0 ? 0 : 4), end = frame(index === 0 ? 3 : 6)
      return { id: beat.id, requiredCompletion: beat.completion, status: 'complete', confidence: 'moderate',
        startSecond: start.second, completionSecond: end.second,
        startFrameSha256: start.frameSha256, completionFrameSha256: end.frameSha256,
        observation: '开始与完成两帧显示了这一项动作从未完成到完成的变化。' }
    }),
    endingHold: { status: 'complete', confidence: 'high', startSecond: 7, endSecond: 7.96,
      lastFrameSha256: frame(7.96).frameSha256,
      observation: '七秒到实际末帧持续保留犬下颌搭背及猫回望的状态。' },
    limitations: ['犬和猫之间有毛发遮挡，首次触碰的精确单帧有不确定性。'] }
  verified.report = report
  const workflow = { id: 'wf-story', nodes: [imageNode, videoNode], nodes_md5: '3'.repeat(32) }
  return { source, parent, workflow, verified, report }
}

test('shot 2 visual-pass fork preserves seven runs and the unchanged uncertain model output', () => {
  const { source, parent, workflow, verified, report } = fixture()
  const original = structuredClone(source)
  assert.equal(validateStoryShot2HumanReview(report, source, parent, verified), report)
  const prepared = prepareStoryShot2HumanAcceptanceFork(source, parent, workflow, verified,
    'record-shot2-human-pass-test', '2026-09-29T00:00:00Z')
  assert.equal(prepared.state.nodeRuns.filter((run: { status: string }) => run.status === 'success').length, 8)
  assert.deepEqual(prepared.state.nodeRuns.slice(0, 7), source.result.nodeRuns.slice(0, 7))
  assert.deepEqual(prepared.state.nodeRuns[7].output, source.result.nodeRuns[7].output)
  assert.equal(prepared.state.nodeRuns[7].output.storyMediaReview.reviewStatus, 'uncertain')
  assert.equal(prepared.state.storyShot2HumanReviewRecovery.method, 'direct-visual-pass')
  assert.equal(prepared.state.storyShot2HumanReviewRecovery.audioReviewStatus, 'pending-human-listen')
  assert.deepEqual(source, original)
})

test('shot 2 visual fork refuses altered verdict, beat, frame and paid source', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.report.verdict = 'fail' },
    (f: ReturnType<typeof fixture>) => { f.report.beatChecks[1].completionFrameSha256 = digest('0') },
    (f: ReturnType<typeof fixture>) => { f.report.frames[5].frameUrl = '/generated/other.jpg' },
    (f: ReturnType<typeof fixture>) => { f.parent.result.nodeRuns[7].output.url = '/generated/changed.mp4' },
    (f: ReturnType<typeof fixture>) => { f.verified.derivative.manifest.outputSha256 = digest('0') },
  ]) {
    const f = fixture()
    mutate(f)
    assert.throws(() => prepareStoryShot2HumanAcceptanceFork(f.source, f.parent, f.workflow,
      f.verified, 'record-shot2-human-pass-test'))
  }
})

test('apply requires explicit fixed IDs and every reviewed digest', () => {
  const base = ['--source-record', 'record-source', '--id', 'record-new',
    '--review-file', 'story-shot2-gaze-v2-local-qa/direct-visual-review-foley.json']
  assert.equal(parseStoryShot2HumanForkArgs(base).apply, false)
  assert.throws(() => parseStoryShot2HumanForkArgs([...base, '--apply']), /every dry-run source\/evidence digest/)
  assert.throws(() => parseStoryShot2HumanForkArgs([...base, '--expected-review-sha256', 'bad']), /reviewSha256 is invalid/)
})
