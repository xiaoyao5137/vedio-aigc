import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V177 } from '../src/scene-cut-controlled-edit-prompt.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V178 } from '../src/scene-cut-geometry-guide-workflow.ts'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { prepareRejectedSceneCutFourReferences } from '../scripts/prepare-scene-cut-rejected-image-four-reference.mjs'
import { assertV8ImagePromptOnlyUpgrade, buildV8ImageRetryQueue,
  sceneCutFourReferenceRepairMarker } from '../scripts/fork-original-shot1-image-retry-v8.mjs'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const jsonSha = (value: unknown) => sha(JSON.stringify(value))
const sourceId = 'record-4x5m31-original-repair-v7'
const sourceMd5 = '0c2421f0e2e33a563f73c44dea53d44f'
const imageSha = '4218a56c75d532f7cf629176d73b7138c05e28be656c9ff5831568dc6828fb48'
const reviewSha = 'faad209cbc612d5eb67e2d32f2a668e0a15dc76fdb3cfa94bb4d4784902f2da2'
const guidePath = 'qa/record-4x5m31/geometry-guide-v8-0d23d49f.png'
const guideSha = '0d23d49f076dc1ce1e52a6de81f049d588499be720037755c73e3f8f9f0726b2'

test('schema178 changes only all eight image prompts and starts at the frozen index45', () => {
  const prefix = Array.from({ length: 45 }, (_, index) => ({ id: `old-${index}`,
    node: { id: `node-${index}`, prompt: 'frozen' }, status: 'success', loopIndex: 0,
    loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' }, output: { index } }))
  const suffix = Array.from({ length: 8 }, (_, loopIndex) => [
    { id: `image-${loopIndex}`, node: { id: 'sanguo-scene-cut-first-frame',
      prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V177, params: [{ id: 'frozen-ref' }] },
    status: loopIndex === 0 ? 'success' : 'idle', loopIndex,
    loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } },
    { id: `review-${loopIndex}`, node: { id: 'sanguo-scene-cut-review', prompt: 'frozen-review' },
    status: loopIndex === 0 ? 'success' : 'idle', loopIndex,
    loopGroupId: 'scene-loop', loopNode: { id: 'scene-loop' } },
  ]).flat()
  const source = [...prefix, ...suffix], target = structuredClone(source)
  for (const run of target.slice(45)) {
    run.status = 'idle'
    if (run.node.id === 'sanguo-scene-cut-first-frame') run.node.prompt = SCENE_CUT_FIRST_FRAME_PROMPT_V178
  }
  assert.deepEqual(assertV8ImagePromptOnlyUpgrade(source, target),
    { changedImagePrompts: 8, unchangedReviewPrompts: 8 })
  const { nodeRuns } = buildV8ImageRetryQueue(source, target)
  assert.deepEqual(nodeRuns.slice(0, 45), source.slice(0, 45))
  assert.equal(nodeRuns[45].status, 'idle')
  assert.ok(nodeRuns.slice(45).every(run => run.status === 'idle'))
  const reviewerTamper = structuredClone(target)
  reviewerTamper[46].node.prompt = 'changed-reviewer'
  assert.throws(() => buildV8ImageRetryQueue(source, reviewerTamper), /non-image node changed/)
  const promptTamper = structuredClone(target)
  promptTamper[45].node.prompt = 'wrong-prompt'
  assert.throws(() => buildV8ImageRetryQueue(source, promptTamper), /beyond the managed prompt/)
})

test('v8 marker binds all four JPEGs, guide provenance and the v7 failed-edit receipt', () => {
  const third = Buffer.from('third-reference'), fourth = Buffer.from('fourth-reference')
  const prior = { version: 'scene-cut-image-repair-schema177-fork-v1',
    sourceExecutionId: 'record-4x5m31-original-repair-v6',
    sourceResultMd5: '21f1f7a2131fe7c3d0e97998d16245a3',
    repairPreparationSha256: 'e'.repeat(64) }
  const receipt = { version: 'scene-cut-rejected-image-edit-reference-v2',
    role: 'reference-only', sourceVerdict: 'rejected', approvedFirstFrame: false,
    requiresFreshIndependentReview: true, sourceExecutionId: sourceId,
    sourceResultMd5: sourceMd5, sourceImageSha256: imageSha,
    failedReviewOutputSha256: reviewSha,
    priorRepairPreparationSha256: prior.repairPreparationSha256,
    priorRepairMarkerHash: createJsonHasher()(prior),
    geometryGuide: { sourcePath: guidePath, sourceSha256: guideSha },
    referenceOrder: [{ position: 1 }, { position: 2 },
      { position: 3, role: 'rejected-edit-source', sourceSha256: imageSha,
        jpegSha256: sha(third), bytes: third.length },
      { position: 4, role: 'geometry-guide', purpose: 'geometry-only', referenceOnly: true,
        sourcePath: guidePath, sourceSha256: guideSha,
        jpegSha256: sha(fourth), bytes: fourth.length }] }
  const prepared = { receipt, receiptSha256: jsonSha(receipt),
    referenceImages: ['board1', 'board2',
      `data:image/jpeg;base64,${third.toString('base64')}`,
      `data:image/jpeg;base64,${fourth.toString('base64')}`] }
  const input = { sourceId, sourceMd5, parentId: 'record-4x5m31-original-repair-v6',
    parentMd5: '21f1f7a2131fe7c3d0e97998d16245a3',
    originalId: 'record-4x5m31', originalMd5: '74e5e2f8afcf8f829694aef350629950',
    workflow: { schema_version: 178, nodes_md5: '2e68e68dea063bdb645523ef8a64ad6d',
      edges_md5: '1d0a75acb3d4778a122a4cfd96a23b49' },
    prefixOutputsHash: 'a'.repeat(64), prepared, prior }
  const marker = sceneCutFourReferenceRepairMarker(input)
  assert.equal(marker.version, 'scene-cut-image-repair-schema178-fork-v2')
  assert.equal(marker.repairPreparationSha256, prepared.receiptSha256)
  assert.equal(marker.geometryGuideJpegSha256, sha(fourth))
  assert.equal(marker.geometryGuideProvenanceSha256,
    '4005ced1b6d381d8c474ec2e606186394509ec9a728c70f23009f3684cf84e2d')
  const changedGuide = structuredClone(prepared)
  changedGuide.referenceImages[3] = `data:image/jpeg;base64,${Buffer.from('changed').toString('base64')}`
  assert.throws(() => sceneCutFourReferenceRepairMarker({ ...input, prepared: changedGuide }),
    /reference 4 JPEG differs/)
  const changedPrior = { ...prior, repairPreparationSha256: 'f'.repeat(64) }
  assert.throws(() => sceneCutFourReferenceRepairMarker({ ...input, prior: changedPrior }),
    /receipt or parent chain changed/)
})

test('four-reference preparation keeps frozen boards first and never approves rejected media', async () => {
  const boards = await Promise.all(['#704b31', '#484336'].map(color =>
    sharp({ create: { width: 32, height: 32, channels: 3, background: color } })
      .jpeg({ quality: 90 }).toBuffer()))
  const sourcePngBytes = await sharp({ create: { width: 64, height: 36, channels: 3,
    background: '#a47849' } }).png().toBuffer()
  const guidePngBytes = await sharp({ create: { width: 64, height: 36, channels: 3,
    background: '#d1b193' } }).png().toBuffer()
  const shot = { id: 'scene-01', visualTreatment: 'live_action' }
  const imageUrl = `/generated/image-${sha(sourcePngBytes).slice(0, 32)}.png`
  const bindings = boards.map((bytes, index) => ({ characterName: ['张飞', '严颜'][index],
    frontUrl: `/generated/board-${index + 1}.jpg`, frontSha256: sha(bytes) }))
  const archive = { identityPlateVersion: 'scene-cut-identity-plate-v4',
    referenceBindings: bindings, imageReferenceImages: boards.map(bytes =>
      `data:image/jpeg;base64,${bytes.toString('base64')}`) }
  const plan = { shotId: shot.id }
  const evidence = { evidenceUrl: '/generated/evidence.json', items: [{ url: imageUrl }] }
  const review = { passed: false, issues: [{ code: 'GUARD_START_STATE_UNCONFIRMED' }],
    evidenceUrl: evidence.evidenceUrl, frame: { sourceUrl: imageUrl } }
  const runs = Array.from({ length: 464 }, (_, index) => ({ id: `run-${index}`,
    node: { id: `unused-${index}` }, status: index < 45 ? 'success' : 'idle', loopIndex: 0 }))
  runs[41] = { ...runs[41], node: { id: 'sanguo-scene-cut-source-archive' }, output: archive }
  runs[43] = { ...runs[43], node: { id: 'sanguo-scene-cut-opening-plan' }, output: plan }
  runs[44] = { ...runs[44], context: { shot_script: shot } }
  runs[45] = { ...runs[45], node: { id: 'sanguo-scene-cut-first-frame' }, status: 'success',
    output: { url: imageUrl, params: { sceneCutShot: shot, sceneCutSources: archive,
      sceneCutOpeningPlan: plan, referenceImages: archive.imageReferenceImages } } }
  runs[48] = { ...runs[48], node: { id: 'sanguo-scene-cut-evidence' }, status: 'success', output: evidence }
  runs[49] = { ...runs[49], node: { id: 'sanguo-scene-cut-review' }, status: 'success', output: review }
  runs[50] = { ...runs[50], node: { id: 'sanguo-scene-cut-approval' } }
  runs[52] = { ...runs[52], node: { id: 'sanguo-video' } }
  const prior = { version: 'scene-cut-image-repair-schema177-fork-v1',
    repairPreparationSha256: 'd'.repeat(64) }
  const source = { id: 'record-rejected-v7',
    sceneCutFirstFrameRecovery: { workflowSchemaVersion: 177 },
    sceneCutImageRepairRecovery: prior, nodeRuns: runs }
  const input = { source, sourceResultMd5: 'a'.repeat(32),
    expectedSourceId: source.id, expectedSourceMd5: 'a'.repeat(32),
    expectedImageSha256: sha(sourcePngBytes), expectedReviewSha256: jsonSha(review),
    expectedGuideSha256: sha(guidePngBytes), guidePath,
    sourcePngBytes, guidePngBytes, identityBoardBytes: boards }
  const prepared = await prepareRejectedSceneCutFourReferences(input)
  assert.deepEqual(prepared.referenceImages.slice(0, 2), archive.imageReferenceImages)
  assert.deepEqual(prepared.receipt.referenceOrder.map(item => item.position), [1, 2, 3, 4])
  assert.equal(prepared.receipt.referenceOrder[3].role, 'geometry-guide')
  assert.equal(prepared.receipt.referenceOrder[3].referenceOnly, true)
  assert.equal(prepared.receipt.approvedFirstFrame, false)
  assert.equal(prepared.receipt.priorRepairPreparationSha256, prior.repairPreparationSha256)
  await assert.rejects(prepareRejectedSceneCutFourReferences({ ...input, guidePngBytes: sourcePngBytes }),
    /failed frame\/review or geometry guide differs/)
  const progressed = structuredClone(source)
  progressed.nodeRuns[50].status = 'success'
  await assert.rejects(prepareRejectedSceneCutFourReferences({ ...input, source: progressed }),
    /saved shot, original boards, or rejected review route changed/)
})
