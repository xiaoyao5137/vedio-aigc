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
import { buildSceneCutControlledEditPrompt,
  SCENE_CUT_FIRST_FRAME_PROMPT_V177,
  upgradeSceneCutControlledEditWorkflow } from '../src/scene-cut-controlled-edit-prompt.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V176 } from '../src/scene-cut-closure-start-layout-workflow.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from '../src/scene-cut-action-start-workflow.ts'

test('v177 uses two frozen identity boards and a third rejected frame for composition only', () => {
  assert.ok(SCENE_CUT_FIRST_FRAME_PROMPT_V177.startsWith('【真人换场首帧·受控局部改图·v177】'))
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V177,
    /附图共 3 张.*第 1 至 2 张是.*冻结身份参考板.*第 3 张是上一次审核未通过的完整首帧/s)
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V177,
    /若没有这张额外失败图.*跳过本节改图.*不得把身份板误当失败图/s)
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V177,
    /最后一张不能作为人物身份或衣摆长度的依据.*以前面的身份板为准/s)
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V177,
    /旧审核结论不得继承；新画面必须重新独立审查/)
  assert.match(SCENE_CUT_FIRST_FRAME_PROMPT_V177,
    /下方是同一正面原图从腰带连续到外袍摆、内层下摆和鞋靴的一整块/)
  assert.doesNotMatch(SCENE_CUT_FIRST_FRAME_PROMPT_V177, /2×2 局部参考板/)
  assert.ok(SCENE_CUT_FIRST_FRAME_PROMPT_V177.endsWith(SCENE_CUT_FIRST_FRAME_PROMPT_V176))
})

test('v177 limits image corrections to the occluded closer and the target garment landmarks', () => {
  const prompt = SCENE_CUT_FIRST_FRAME_PROMPT_V177
  assert.match(prompt,
    /只把这位获批执行者整体向画面左方横移少量.*保持其原本侧后方景深和静止站位/s)
  assert.match(prompt,
    /整副髋部、双膝、两条腿、两只靴及各自接触地面的点均清楚入画/)
  assert.match(prompt, /不得挪到发令者与目标之间的开放缺口/)
  assert.match(prompt, /腰带上沿为纵向 0、双靴鞋底为 1.*外袍摆、深色内层摆.*相对高度与宽度/s)
  assert.match(prompt, /只把错误下延的外摆和内摆收至原板地标/)
  assert.match(prompt, /不能只缩外层而让内层继续盖住靴筒/)
  assert.match(prompt, /同一根松绳的工作段.*已经清晰露出的真实自由端/s)
  assert.match(prompt, /不得把真实自由端改成闭合绳环、藏入手中或移出画幅/)
  assert.match(prompt, /不重排整场、不变更动作或台词/)
  assert.doesNotMatch(prompt, /张飞|严颜|record-4x5m31|0\.6[89]|0\.8[345]/)
})

test('v177 reference order is explicit for any supported identity plate count', () => {
  const prompt = buildSceneCutControlledEditPrompt({ identityPlateCount: 4,
    approvedOpeningPrompt: '受管零秒起点' })
  assert.match(prompt, /共附 5 张参考图.*第 1 至 4 张是.*第 5 张是/s)
  assert.ok(prompt.endsWith('受管零秒起点'))
  for (const identityPlateCount of [0, -1, 1.5, 5]) {
    assert.throws(() => buildSceneCutControlledEditPrompt({ identityPlateCount,
      approvedOpeningPrompt: '受管零秒起点' }), /SCENE_CUT_EDIT_REFERENCE_INVALID/)
  }
  assert.throws(() => buildSceneCutControlledEditPrompt({ identityPlateCount: 2,
    approvedOpeningPrompt: ' ' }), /SCENE_CUT_EDIT_REFERENCE_INVALID/)
})

test('schema177 updates only the managed image prompt and never rewrites review or user nodes', () => {
  const archive = { id: 'sanguo-scene-cut-source-archive', params: [{ value: 'v4' }] }
  const plan = { id: 'sanguo-scene-cut-opening-plan', code: 'preserve' }
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V176 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V174 }
  const custom = { id: 'user-node', prompt: 'keep this edit' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 176,
    nodes: [archive, plan, image, review, custom], edges: [{ id: 'e', from: plan.id,
      to: image.id }] }
  const next = upgradeSceneCutControlledEditWorkflow(graph)
  assert.equal(next.schemaVersion, 177)
  assert.equal(next.edges, graph.edges)
  assert.deepEqual(next.nodes.filter((node, index) => node !== graph.nodes[index])
    .map(node => node.id), [image.id])
  assert.equal(next.nodes[2].prompt, SCENE_CUT_FIRST_FRAME_PROMPT_V177)
  assert.equal(next.nodes[0], archive)
  assert.equal(next.nodes[1], plan)
  assert.equal(next.nodes[3], review)
  assert.equal(next.nodes[4], custom)
  assert.equal(upgradeSceneCutControlledEditWorkflow(next), next)
  assert.equal(upgradeSceneCutControlledEditWorkflow({ ...next, schemaVersion: 178 })
    .schemaVersion, 178)
  assert.equal(upgradeSceneCutControlledEditWorkflow({ ...graph,
    nodes: [archive, plan, { ...image, prompt: 'user prompt' }, review, custom] }).schemaVersion, 176)
})

test('schema177 paid image accepts exactly two frozen boards plus bound rejected-frame JPEG', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-edit-v177-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const triptych = await sharp({ create: { width: 900, height: 600, channels: 3,
      background: '#755d45' } }).png().toBuffer()
    await writeFile(path.join(root, 'public/generated/triptych-a.png'), triptych)
    await writeFile(path.join(root, 'public/generated/triptych-b.png'), triptych)
    const failed = await sharp({ create: { width: 960, height: 540, channels: 3,
      background: '#aa8855' } }).png().toBuffer()
    const failedSha = createHash('sha256').update(failed).digest('hex')
    const failedUrl = `/generated/image-${failedSha.slice(0, 32)}.png`
    await writeFile(path.join(root, 'public', failedUrl), failed)
    const jpeg = await sharp(failed).jpeg({ quality: 90,
      chromaSubsampling: '4:4:4' }).toBuffer()
    const jpegSha = createHash('sha256').update(jpeg).digest('hex')
    const shot = { id: 'scene-01', firstFrameMode: 'reference',
      continuity: { mode: 'scene_cut' }, visualTreatment: 'live_action',
      characters: ['主将', '俘虏'], visualPrompt: '批准的街口斜侧全景。',
      camera: '同一侧 35 毫米全景。', pacing: { beats: [], schedule: [] } }
    const sources = await archiveSceneCutSources({ shot, referenceBindings: [
      { characterName: '主将', assetId: 'asset-general',
        referenceLayout: 'horizontal-three-view' },
      { characterName: '俘虏', assetId: 'asset-captive',
        referenceLayout: 'horizontal-three-view' },
    ], referenceImages: ['/generated/triptych-a.png', '/generated/triptych-b.png'],
    identityPlateVersion: 'scene-cut-identity-plate-v4',
    sceneCutBoundaryVersion: 'scene-cut-approved-boundary-v1',
    approvedOutline: { scenes: [{ id: shot.id }] },
    acceptedRecordBinding: { version: 'scene-cut-source-ledger-v1' } }, root)
    const opening = deriveSceneCutOpeningPlan(shot, 3)
    const referenceOrder = sources.referenceBindings.map((binding, index) => ({
      position: index + 1, frontUrl: binding.frontUrl,
      sha256: binding.frontSha256 }))
    const receipt = { version: 'scene-cut-rejected-image-edit-reference-v1',
      role: 'reference-only', sourceVerdict: 'rejected', approvedFirstFrame: false,
      requiresFreshIndependentReview: true, requiresPaidGateRevalidation: true,
      sourceImageUrl: failedUrl, sourceImageSha256: failedSha,
      referenceOrder: [...referenceOrder, { position: 3, role: 'rejected-edit-source',
        sourceUrl: failedUrl, sourceSha256: failedSha, jpegSha256: jpegSha,
        bytes: jpeg.length }] }
    const request = { model: { id: 'codex-gpt-image-2', provider: 'Codex',
      capability: 'image', settings: {} },
    prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V177,
      { shot_script: shot, scene_cut_sources: sources, scene_cut_opening_state: opening }),
    params: { sceneCutShot: shot, sceneCutSources: sources, sceneCutOpeningPlan: opening,
      referenceImages: [...sources.imageReferenceImages,
        `data:image/jpeg;base64,${jpeg.toString('base64')}`],
      sceneCutRepairReceipt: receipt, singleFrame: true, size: '1536x864' },
    executionContext: { workflowId: 'wf-sanguo-history-drama',
      nodeId: 'sanguo-scene-cut-first-frame' } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(request, root, 177))
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      params: { ...request.params, sceneCutRepairReceipt: undefined } }, root, 177),
    /SCENE_CUT_FRAME_BLOCKED/)
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      params: { ...request.params, referenceImages: [request.params.referenceImages[2],
        ...sources.imageReferenceImages] } }, root, 177), /SCENE_CUT_FRAME_BLOCKED/)
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      params: { ...request.params, sceneCutRepairReceipt: { ...receipt,
        referenceOrder: [...referenceOrder, { ...receipt.referenceOrder[2],
          jpegSha256: '0'.repeat(64) }] } } }, root, 177), /SCENE_CUT_FRAME_BLOCKED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('schema177 repair payment requires a current-fork signed candidate binding', () => {
  const executionId = 'record-repair-v7'
  const requestKey = `${executionId}:attempt-1:revision-0:sanguo-video:0:scene-01`
  const recovery = { version: 'scene-cut-image-repair-schema177-fork-v1',
    workflowSchemaVersion: 177, sourceExecutionId: 'record-parent-v6',
    sourceResultMd5: 'a'.repeat(32), failedImageFileSha256: 'b'.repeat(64),
    failedReviewOutputSha256: 'c'.repeat(64), repairPreparationSha256: 'd'.repeat(64) }
  const receipt = { version: 'scene-cut-rejected-image-edit-reference-v1',
    referenceOrder: [{ position: 1 }, { position: 2 },
      { position: 3, role: 'rejected-edit-source' }],
    sourceExecutionId: recovery.sourceExecutionId,
    sourceResultMd5: recovery.sourceResultMd5,
    sourceImageSha256: recovery.failedImageFileSha256,
    failedReviewOutputSha256: recovery.failedReviewOutputSha256,
    preparationSha256: recovery.repairPreparationSha256 }
  const binding = { version: 'scene-cut-image-repair-binding-v1', executionId,
    imageExecutionId: 'model-run-new-image', repairRequestFingerprint: 'e'.repeat(64),
    repairReceiptSha256: 'f'.repeat(64), candidateImageSha256: '1'.repeat(64), receipt }
  const certificate = { frame: { sourceUrl: '/generated/new.png' },
    sourceSha256s: ['1'.repeat(64)], repairBinding: binding }
  const context = { executionId, recovery }
  assert.equal(validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', certificate, context), true)
  assert.throws(() => validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', { ...certificate, repairBinding: undefined }, context),
  /SCENE_CUT_FRAME_BLOCKED/)
  assert.throws(() => validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', { ...certificate, repairBinding: { ...binding,
      receipt: { ...receipt, sourceImageSha256: '0'.repeat(64) } } }, context),
  /SCENE_CUT_FRAME_BLOCKED/)
  assert.throws(() => validateSceneCutRepairPaymentContext(requestKey,
    '/generated/old.png', certificate, context), /SCENE_CUT_FRAME_BLOCKED/)
  assert.throws(() => validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', certificate, undefined), /SCENE_CUT_FRAME_BLOCKED/)
  assert.throws(() => validateSceneCutRepairPaymentContext(requestKey,
    '/generated/new.png', certificate, { executionId: 'record-other', recovery }),
  /SCENE_CUT_FRAME_BLOCKED/)
  assert.equal(validateSceneCutRepairPaymentContext(
    `${executionId}:attempt-1:revision-0:sanguo-video:1:scene-02`,
    '/generated/shot2.png', { frame: { sourceUrl: '/generated/shot2.png' } }, context), true)
  assert.throws(() => validateSceneCutRepairPaymentContext(
    `${executionId}:attempt-1:revision-0:sanguo-video:1:scene-02`,
    '/generated/new.png', certificate, context), /SCENE_CUT_FRAME_BLOCKED/)
})
