import assert from 'node:assert/strict'
import test from 'node:test'
import { executeCodeNode } from '../server/code-node.ts'
import { sceneCutEvidencePlanCodeInput,
  SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171,
  SCENE_CUT_VIDEO_REFERENCES_CODE } from '../src/scene-cut-ellipsis-workflow.ts'

test('later scene evidence plan omits paid image bytes and preserves ordered source URLs', async () => {
  const node = { id: 'sanguo-scene-cut-evidence-plan',
    code: SCENE_CUT_FRAME_EVIDENCE_PLAN_CODE_V171 }
  const values = { frame: { url: '/generated/image-a.png',
    raw: { referenceImages: ['x'.repeat(13 * 1024 * 1024)] } },
  sources: { version: 'scene-cut-sources-v1', imageReferenceImages: ['y'.repeat(8 * 1024 * 1024)],
    referenceBindings: [{ characterName: '张飞', assetId: 'asset-1',
      url: '/generated/identity.png', frontBase64: 'z'.repeat(8 * 1024 * 1024) }],
    approvedEllipsis: { priorTailUrl: '/generated/prior.png', extra: 'w'.repeat(8 * 1024 * 1024) } } }
  const projected = sceneCutEvidencePlanCodeInput(node, values, { previous: 'q'.repeat(13 * 1024 * 1024) })
  assert.deepEqual(projected.context, {})
  assert.ok(JSON.stringify(projected.values).length < 1000)
  const result = await executeCodeNode({ code: node.code, params: projected.values,
    context: projected.context })
  assert.deepEqual(result.items, [
    { role: 'candidate_first', url: '/generated/image-a.png' },
    { role: 'identity', characterName: '张飞', assetId: 'asset-1', url: '/generated/identity.png' },
    { role: 'prior_actual_tail', url: '/generated/prior.png' },
  ])
})

test('managed video reference router reads params without serializing the full media context', async () => {
  const references = ['data:image/png;base64,' + 'a'.repeat(100)]
  const values = { branch: { shouldGenerateSceneFrame: true },
    sceneSources: { version: 'scene-cut-sources-v1', referenceImages: references,
      referenceBindings: [{ characterName: '严颜', url: '/generated/yan.png' }] } }
  const selected = sceneCutEvidencePlanCodeInput({ id: 'sanguo-video-reference-router',
    code: SCENE_CUT_VIDEO_REFERENCES_CODE }, values,
  { previous: 'x'.repeat(13 * 1024 * 1024) })
  assert.deepEqual(selected.context, {})
  const result = await executeCodeNode({ code: SCENE_CUT_VIDEO_REFERENCES_CODE,
    params: selected.values, context: selected.context })
  assert.deepEqual(result.referenceImages, references)
})

test('managed media request keeps its sampling inputs without serializing paid video bytes', () => {
  const values = { maxSamplingFrames: 24, qualityMode: 'principle-v1' }
  const shot = { duration: 11, pacing: { version: 'duration-v2', scheduleHash: 'scheduled',
    speechWindows: [], sampleTimes: [0, 5, 10], timingPolicy: { endingReadabilityReserve: .4 } } }
  const context = { shot_script: shot, video_take: { url: '/generated/video.mp4',
    params: { referenceImage: 'x'.repeat(13 * 1024 * 1024) } },
  first_frame: { url: '/generated/first.png', bytes: 'y'.repeat(13 * 1024 * 1024) },
  mediaSamplingRetry: { sourceUrl: '/generated/video.mp4', round: 1, sampleTimes: [0, 5, 10] },
  scene_cut_sources: { references: 'z'.repeat(13 * 1024 * 1024) } }
  const managedCode = "// PRINCIPLE_POLICY_START\nif (params.qualityMode === 'principle-v1') {\n"
    + '// PRINCIPLE_DURATION_V2_GATE_SCHEMA159\nconst principleRequest=principleMediaQuality.mediaRequest(context);\n'
    + '// PRINCIPLE_POLICY_END\n// duration-v2-media-request'
  const projected = sceneCutEvidencePlanCodeInput({ id: 'sanguo-media-request', code: managedCode }, values, context)
  assert.deepEqual(projected.values, values)
  assert.ok(JSON.stringify(projected.context).length < 1000)
  assert.deepEqual(projected.context.shot_script, shot)
  assert.deepEqual(projected.context.video_take, { url: '/generated/video.mp4' })
  assert.deepEqual(projected.context.first_frame, { url: '/generated/first.png' })
  assert.deepEqual(projected.context.mediaSamplingRetry, context.mediaSamplingRetry)
  assert.equal(sceneCutEvidencePlanCodeInput({ id: 'sanguo-media-request', code: managedCode },
    { ...values, qualityMode: 'custom' }, context).context, context)
})

test('managed media metrics reads decoded evidence without paid reference bytes', () => {
  const code = "// PRINCIPLE_POLICY_START\nif (params.qualityMode === 'principle-v1') {\n"
    + '// NATIVE_PRINCIPLE_SEQUENCE_GRID_SCHEMA163\nconst metrics=principleMediaQuality.mediaMetrics(context,params);\n'
    + '// PRINCIPLE_POLICY_END'
  const values = { qualityMode: 'principle-v1' }
  const evidence = { decoded: true, frames: ['/generated/frame.png'] }
  const context = { shot_script: { id: 'scene-02' }, video_evidence: evidence,
    video_take: { params: { subtitlePolicy: 'none', referenceImage: 'x'.repeat(13 * 1024 * 1024) } },
    first_frame: { bytes: 'y'.repeat(13 * 1024 * 1024) } }
  const projected = sceneCutEvidencePlanCodeInput({ id: 'sanguo-media-metrics', code }, values, context)
  assert.deepEqual(projected.context, {
    shot_script: context.shot_script, video_evidence: evidence,
    video_take: { params: { subtitlePolicy: 'none' } },
  })
})
