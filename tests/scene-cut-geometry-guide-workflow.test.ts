import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { archiveSceneCutSources } from '../server/scene-cut-frame-storage.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { validateSceneCutPaidImageRequest,
  validateSceneCutRepairPaymentContext } from '../server/scene-cut-frame-runtime.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V177 } from '../src/scene-cut-controlled-edit-prompt.ts'
import { buildSceneCutGeometryGuidePrompt, SCENE_CUT_FIRST_FRAME_PROMPT_V178,
  upgradeSceneCutGeometryGuideWorkflow } from '../src/scene-cut-geometry-guide-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V176 } from '../src/scene-cut-closure-start-layout-workflow.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from '../src/scene-cut-action-start-workflow.ts'

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

test('v178 gives frozen boards identity authority and guides only geometry, with ordinary-shot fallback', () => {
  const prompt = SCENE_CUT_FIRST_FRAME_PROMPT_V178
  assert.match(prompt, /参考图共 4 张.*第 1 至 2 张.*冻结身份板.*第 3 张.*审核未通过.*第 4 张.*几何目标示意/s)
  assert.match(prompt, /第 4 张可能含身份、服装、背景细节的漂移.*不得用它复制脸、甲片、旗幡/s)
  assert.match(prompt, /普通镜头若只有冻结身份板，跳过本节/)
  assert.match(prompt, /完整髋、双膝、两条腿、双靴和各自接地点须有像素可见/)
  assert.match(prompt, /腰带上沿为纵向 0、双靴鞋底为 1.*外袍摆和深色内摆/s)
  assert.match(prompt, /分镜并未要求的旗幡.*去掉/)
  assert.match(prompt, /真实可辨自由端.*不得把自由端画成闭环/s)
  assert.match(prompt, /持绳者整只外侧靴.*右画边留可见背景间隙.*不能复制第 4 张可能出现的右边裁切/s)
  assert.ok(prompt.endsWith(SCENE_CUT_FIRST_FRAME_PROMPT_V176))
  assert.doesNotMatch(prompt, /张飞|严颜|record-4x5m31/)
  const threeBoards = buildSceneCutGeometryGuidePrompt(3, '已批起点')
  assert.match(threeBoards, /参考图共 5 张.*第 4 张.*第 5 张/s)
  for (const count of [0, 4, 1.5]) assert.throws(() =>
    buildSceneCutGeometryGuidePrompt(count, '已批起点'), /SCENE_CUT_GEOMETRY_GUIDE_INVALID/)
})

test('schema178 upgrades only managed image prompt and remains idempotent', () => {
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V177 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V174 }
  const custom = { id: 'user-node', prompt: 'do not overwrite' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 177,
    nodes: [image, review, custom], edges: [{ id: 'edge', from: image.id, to: review.id }] }
  const next = upgradeSceneCutGeometryGuideWorkflow(graph)
  assert.equal(next.schemaVersion, 178)
  assert.equal(next.edges, graph.edges)
  assert.equal(next.nodes[0].prompt, SCENE_CUT_FIRST_FRAME_PROMPT_V178)
  assert.equal(next.nodes[1], review)
  assert.equal(next.nodes[2], custom)
  assert.equal(upgradeSceneCutGeometryGuideWorkflow(next), next)
  assert.equal(upgradeSceneCutGeometryGuideWorkflow({ ...next, schemaVersion: 179 }).schemaVersion, 179)
  assert.equal(upgradeSceneCutGeometryGuideWorkflow({ ...graph,
    nodes: [{ ...image, prompt: 'manual edit' }, review, custom] }).schemaVersion, 177)
})

test('v178 paid image requires four ordered byte-matched references and cannot weaken v177', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-geometry-v178-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    await mkdir(path.join(root, 'qa/record-test'), { recursive: true })
    const triptych = await sharp({ create: { width: 900, height: 600, channels: 3,
      background: '#665847' } }).png().toBuffer()
    await writeFile(path.join(root, 'public/generated/a.png'), triptych)
    await writeFile(path.join(root, 'public/generated/b.png'), triptych)
    const failed = await sharp({ create: { width: 960, height: 540, channels: 3,
      background: '#ab8660' } }).png().toBuffer()
    const failedSha = sha256(failed)
    const failedUrl = `/generated/image-${failedSha.slice(0, 32)}.png`
    await writeFile(path.join(root, 'public', failedUrl), failed)
    const guide = await sharp({ create: { width: 960, height: 540, channels: 3,
      background: '#63958f' } }).png().toBuffer()
    const guidePath = 'qa/record-test/geometry-guide-v8-12345678.png'
    await writeFile(path.join(root, guidePath), guide)
    const failedJpeg = await sharp(failed).jpeg({ quality: 90,
      chromaSubsampling: '4:4:4' }).toBuffer()
    const guideJpeg = await sharp(guide).jpeg({ quality: 90,
      chromaSubsampling: '4:4:4' }).toBuffer()
    const shot = { id: 'scene-01', firstFrameMode: 'reference',
      continuity: { mode: 'scene_cut' }, visualTreatment: 'live_action',
      characters: ['甲', '乙'], visualPrompt: '批准街口起点。',
      camera: '侧前全景。', pacing: { beats: [], schedule: [] } }
    const sources = await archiveSceneCutSources({ shot, referenceBindings: [
      { characterName: '甲', assetId: 'a', referenceLayout: 'horizontal-three-view' },
      { characterName: '乙', assetId: 'b', referenceLayout: 'horizontal-three-view' },
    ], referenceImages: ['/generated/a.png', '/generated/b.png'],
    identityPlateVersion: 'scene-cut-identity-plate-v4',
    sceneCutBoundaryVersion: 'scene-cut-approved-boundary-v1',
    approvedOutline: { scenes: [{ id: shot.id }] },
    acceptedRecordBinding: { version: 'scene-cut-source-ledger-v1' } }, root)
    const opening = deriveSceneCutOpeningPlan(shot, 3)
    const referenceOrder = sources.referenceBindings.map((binding, index) => ({
      position: index + 1, characterName: binding.characterName,
      frontUrl: binding.frontUrl, sha256: binding.frontSha256 }))
    const receipt = { version: 'scene-cut-rejected-image-edit-reference-v2',
      role: 'reference-only', sourceVerdict: 'rejected', approvedFirstFrame: false,
      requiresFreshIndependentReview: true, requiresPaidGateRevalidation: true,
      sourceImageUrl: failedUrl, sourceImageSha256: failedSha,
      geometryGuide: { role: 'geometry-only', identityAuthority: false,
        sourcePath: guidePath, sourceSha256: sha256(guide) },
      referenceOrder: [...referenceOrder, { position: 3, role: 'rejected-edit-source',
        sourceUrl: failedUrl, sourceSha256: failedSha,
        jpegSha256: sha256(failedJpeg), bytes: failedJpeg.length },
      { position: 4, role: 'geometry-guide', purpose: 'geometry-only',
        referenceOnly: true, sourcePath: guidePath, sourceSha256: sha256(guide),
        jpegSha256: sha256(guideJpeg), bytes: guideJpeg.length }] }
    const request = { model: { id: 'codex-image', provider: 'Codex',
      capability: 'image', settings: {} },
    prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V178,
      { shot_script: shot, scene_cut_sources: sources, scene_cut_opening_state: opening }),
    params: { sceneCutShot: shot, sceneCutSources: sources, sceneCutOpeningPlan: opening,
      referenceImages: [...sources.imageReferenceImages,
        `data:image/jpeg;base64,${failedJpeg.toString('base64')}`,
        `data:image/jpeg;base64,${guideJpeg.toString('base64')}`],
      sceneCutRepairReceipt: receipt, singleFrame: true, size: '1536x864' },
    executionContext: { workflowId: 'wf-sanguo-history-drama',
      nodeId: 'sanguo-scene-cut-first-frame' } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(request, root, 178))
    await assert.rejects(validateSceneCutPaidImageRequest(request, root, 177), /SCENE_CUT_FRAME_BLOCKED/)
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      params: { ...request.params, referenceImages: [...request.params.referenceImages.slice(0, 2),
        request.params.referenceImages[3], request.params.referenceImages[2]] } }, root, 178),
    /SCENE_CUT_FRAME_BLOCKED/)
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      params: { ...request.params, sceneCutRepairReceipt: { ...receipt,
        referenceOrder: [...receipt.referenceOrder.slice(0, 3), { ...receipt.referenceOrder[3],
          sourceSha256: '0'.repeat(64) }] } } }, root, 178), /SCENE_CUT_FRAME_BLOCKED/)
    await writeFile(path.join(root, guidePath), Buffer.from('tampered guide'))
    await assert.rejects(validateSceneCutPaidImageRequest(request, root, 178), /SCENE_CUT_FRAME_BLOCKED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('v178 video payment accepts only matching four-reference fork and signed guide anchor', () => {
  const executionId = 'record-repair-v8'
  const guidePath = 'qa/record-test/geometry-guide-v8-12345678.png'
  const requestKey = `${executionId}:attempt-1:revision-0:sanguo-video:0:scene-01`
  const recovery = { version: 'scene-cut-image-repair-schema178-fork-v2',
    workflowSchemaVersion: 178, sourceExecutionId: 'record-parent-v7',
    sourceResultMd5: 'a'.repeat(32), failedImageFileSha256: 'b'.repeat(64),
    failedReviewOutputSha256: 'c'.repeat(64), repairPreparationSha256: 'd'.repeat(64),
    geometryGuideSourcePath: guidePath, geometryGuideSourceSha256: 'e'.repeat(64),
    geometryGuideJpegSha256: 'f'.repeat(64),
    geometryGuideProvenanceSha256: 'a'.repeat(64) }
  const receipt = { version: 'scene-cut-rejected-image-edit-reference-v2',
    sourceExecutionId: recovery.sourceExecutionId, sourceResultMd5: recovery.sourceResultMd5,
    sourceImageSha256: recovery.failedImageFileSha256,
    failedReviewOutputSha256: recovery.failedReviewOutputSha256,
    preparationSha256: recovery.repairPreparationSha256,
    guideProvenanceSha256: recovery.geometryGuideProvenanceSha256,
    geometryGuide: { role: 'geometry-only', identityAuthority: false,
      sourcePath: guidePath, sourceSha256: recovery.geometryGuideSourceSha256 },
    referenceOrder: [{}, {}, {}, { position: 4, role: 'geometry-guide',
      purpose: 'geometry-only', referenceOnly: true, sourcePath: guidePath,
      sourceSha256: recovery.geometryGuideSourceSha256,
      jpegSha256: recovery.geometryGuideJpegSha256 }] }
  const binding = { version: 'scene-cut-image-repair-binding-v2', executionId,
    imageExecutionId: 'model-run-new', repairRequestFingerprint: '1'.repeat(64),
    repairReceiptSha256: '2'.repeat(64), candidateImageSha256: '3'.repeat(64), receipt }
  const certificate = { frame: { sourceUrl: '/generated/new.png' },
    sourceSha256s: ['3'.repeat(64)], repairBinding: binding }
  const context = { executionId, recovery }
  assert.equal(validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', certificate, context, 178), true)
  assert.throws(() => validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', { ...certificate, repairBinding: { ...binding,
      version: 'scene-cut-image-repair-binding-v1' } }, context, 178), /SCENE_CUT_FRAME_BLOCKED/)
  assert.throws(() => validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', { ...certificate, repairBinding: { ...binding,
      receipt: { ...receipt, referenceOrder: [...receipt.referenceOrder.slice(0, 3),
        { ...receipt.referenceOrder[3], sourceSha256: '0'.repeat(64) }] } } },
  context, 178), /SCENE_CUT_FRAME_BLOCKED/)
  assert.throws(() => validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', certificate, context, 177), /SCENE_CUT_FRAME_BLOCKED/)
})
