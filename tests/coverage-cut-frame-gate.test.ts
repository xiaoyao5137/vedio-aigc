import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { executeCodeNode } from '../server/code-node.ts'
import { collectImageEvidence } from '../server/image-evidence.ts'
import { archiveCoverageCutSources, persistCoverageCutFirstFrameResponse } from '../server/coverage-cut-frame-storage.ts'
import { assertCoverageCutReviewLedgerRecord } from '../server/coverage-cut-review-ledger.ts'
import { issueCoverageCutFrameApproval, validateCoverageCutVideoPayment, verifyCoverageCutFrameApproval } from '../server/coverage-cut-frame-approval.ts'
import { validateCoverageCutPaidImageRequest, validateCoverageCutPaidVideoRequest } from '../server/coverage-cut-runtime.ts'
import { buildKlingImageRequest, buildKlingVideoRequest, callKlingImage } from '../server/model-adapters.ts'
import { modelRequestFingerprint } from '../server/model-request-key.ts'
import { SANGUO_FIRST_FRAME_BRANCH_CODE } from '../src/code-node-presets.ts'
import { COVERAGE_CUT_EVIDENCE_PLAN_CODE, COVERAGE_CUT_PRECHECK_CODE,
  COVERAGE_CUT_FRAME_REVIEW_PROMPT, upgradeCoverageCutFrameWorkflow, validateCoverageCutFrameReview } from '../src/coverage-cut-frame-gate.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const shot = { id: 'scene-03', continuity: { mode: 'coverage_cut' }, firstFrameMode: 'reference',
  visualPrompt: '张飞问严颜，严颜双腕仍缚。', camera: '同侧中近景',
  characters: ['张飞', '严颜'], worldState: { boundWrists: ['严颜'] } }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

test('schema 154 or 155 graph upgrades to current schema without mutating paid history', () => {
  const common = { prompt: 'kept', params: [], uploads: [], loop: {}, position: { x: 0, y: 0 }, title: 'kept' }
  const owner = { ...common, id: 'sanguo-scene-loop', kind: 'loop', childIds: [
    'sanguo-first-frame-branch', 'sanguo-first-frame-tail', 'sanguo-animated-map-first-frame',
    'sanguo-end-frame', 'sanguo-video', 'sanguo-last-frame'] }
  const branch = { ...common, id: 'sanguo-first-frame-branch', kind: 'code', code: SANGUO_FIRST_FRAME_BRANCH_CODE }
  const video = { ...common, id: 'sanguo-video', kind: 'video', params: [
    { id: 'r1', name: 'referenceImages', englishName: 'referenceImages', type: 'images', required: false, value: '${first_frame_branch.referenceRequest.referenceImages}' },
    { id: 'r2', name: 'referenceBindings', englishName: 'referenceBindings', type: 'json', required: false, value: '${first_frame_branch.referenceRequest.referenceBindings}' },
    { id: 'r3', name: 'referenceMode', englishName: 'referenceMode', type: 'text', required: false, value: '${first_frame_branch.referenceRequest.referenceMode}' },
  ] }
  const frozenExecution = { id: 'old-paid-run', paidPrefix: ['sanguo-video'], result: '/generated/old.mp4' }
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 154, nodes: [owner, branch, video], edges: [
    { id: 'old', from: branch.id, to: video.id }], frozenExecution }
  const upgraded = upgradeCoverageCutFrameWorkflow(workflow)
  assert.equal(upgraded.schemaVersion, 157)
  assert.equal(upgraded.frozenExecution, frozenExecution)
  assert.equal(workflow.nodes.length, 3)
  assert.equal(workflow.nodes[1].code, SANGUO_FIRST_FRAME_BRANCH_CODE)
  assert.equal(upgraded.nodes.filter(item => item.id === 'sanguo-coverage-first-frame').length, 1)
  const upgradedOwner = upgraded.nodes.find(item => item.id === owner.id)!
  const order = upgradedOwner.childIds!
  assert.ok(order.indexOf('sanguo-coverage-precheck') < order.indexOf('sanguo-coverage-source-archive'))
  assert.ok(order.indexOf('sanguo-coverage-source-archive') < order.indexOf('sanguo-coverage-first-frame'))
  assert.ok(order.indexOf('sanguo-coverage-approval') < order.indexOf('sanguo-video'))
  assert.equal(upgraded.nodes.find(item => item.id === 'sanguo-coverage-first-frame')?.kind, 'image')
  assert.deepEqual(upgraded.nodes.find(item => item.id === 'sanguo-coverage-first-frame')?.runIf,
    { path: 'first_frame_branch.shouldGenerateCoverageFrame', equals: true })
  assert.equal(upgraded.nodes.find(item => item.id === 'sanguo-coverage-first-frame')?.params?.find(item => item.englishName === 'referenceImage')?.value,
    '${coverage_sources.previousTail.url}')
  assert.equal(upgraded.nodes.find(item => item.id === 'sanguo-video')?.params?.find(item => item.englishName === 'referenceImages')?.value,
    '${coverage_video_references.referenceImages}')
  assert.equal(upgraded.edges.some(edge => edge.from === branch.id && edge.to === video.id), false)
  assert.equal(upgraded.edges.some(edge => edge.from === 'sanguo-video-reference-router' && edge.to === video.id), true)
  assert.ok(upgraded.nodes.find(item => item.id === branch.id)?.code?.includes('shouldGenerateCoverageFrame'))
  assert.equal(upgradeCoverageCutFrameWorkflow(upgraded), upgraded)
  assert.equal(upgradeCoverageCutFrameWorkflow({ ...workflow, schemaVersion: 155 }).schemaVersion, 157)
  const unsupported = { ...workflow, schemaVersion: 153 }
  assert.equal(upgradeCoverageCutFrameWorkflow(unsupported), unsupported)
})

test('precheck rejects a planned/stale tail before an image purchase', async () => {
  const binding = { characterName: '张飞', assetId: 'asset-zhang' }
  const previousLastFrame = { url: '/generated/tail.png', available: true, source: 'extracted-from-video' }
  const video = { lastFrameUrl: previousLastFrame.url, extractedLastFrameUrl: previousLastFrame.url,
    frames: [previousLastFrame.url], decoded: true }
  const passed = await executeCodeNode({ code: COVERAGE_CUT_PRECHECK_CODE,
    params: { previousLastFrame, previousVideoShot: video, referenceBindings: [binding], referenceImages: ['/generated/zhang.png'] } })
  assert.equal((passed.previousTail as { url: string }).url, previousLastFrame.url)
  await assert.rejects(executeCodeNode({ code: COVERAGE_CUT_PRECHECK_CODE,
    params: { previousLastFrame, previousVideoShot: { ...video, lastFrameUrl: '/generated/stale.png' },
      referenceBindings: [binding], referenceImages: ['/generated/zhang.png'] } }),
  /COVERAGE_SOURCE_INVALID/)
  await assert.rejects(executeCodeNode({ code: COVERAGE_CUT_PRECHECK_CODE,
    params: { previousLastFrame: { ...previousLastFrame, source: 'planned' }, previousVideoShot: video,
      referenceBindings: [binding], referenceImages: ['/generated/zhang.png'] } }),
  /COVERAGE_SOURCE_INVALID/)
})

test('archived originals, signed visual evidence and paid gate bind exact bytes and reject old-tail substitution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coverage-frame-'))
  try {
    const dir = path.join(root, 'public/generated'); await mkdir(dir, { recursive: true })
    const pixels = async (r: number, g: number, b: number) => sharp({ create: { width: 160, height: 90,
      channels: 3, background: { r, g, b } } }).png().toBuffer()
    await writeFile(path.join(dir, 'previous.png'), await pixels(60, 50, 40))
    await writeFile(path.join(dir, 'zhang.png'), await pixels(20, 30, 40))
    await writeFile(path.join(dir, 'yan.png'), await pixels(90, 80, 70))
    const input = { previousTail: { url: '/generated/previous.png', videoTailUrl: '/generated/previous.png',
      available: true as const, source: 'extracted-from-video' as const }, referenceBindings: [
      { characterName: '张飞', assetId: 'asset-zhang', url: '/generated/zhang.png' },
      { characterName: '严颜', assetId: 'asset-yan', url: '/generated/yan.png' },
    ] }
    const sources = await archiveCoverageCutSources(input, root)
    assert.equal(sources.referenceImages.length, 2)
    assert.ok(sources.referenceImages.every(url => url.startsWith('/generated/coverage-source-')))
    const candidate = await pixels(50, 40, 30)
    const persisted = await persistCoverageCutFirstFrameResponse({ data: { task_result: { images: [{ url: '/generated/candidate.png' }] } } }, root)
      .catch(() => null)
    assert.equal(persisted, null, 'missing provider image must fail without silent fallback')
    await writeFile(path.join(dir, 'candidate.png'), candidate)
    let imageSubmissionSeen = false
    const imageResponse = await callKlingImage({ id: 'kling-image-3', name: 'Kling Image 3', provider: 'Kling',
      capability: 'image', settings: { model: 'kling-v3', apiKey: 'fixture-key',
        endpoint: 'https://api.example.test/v1/images/generations', pollIntervalMs: '100' } },
    '同侧新机位', { referenceImage: sources.previousTail.url, imageEdit: true, aspectRatio: '16:9' }, {
      generatedAssetsDirectory: dir,
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          assert.match(String(url), /\/omni-image$/)
          assert.equal((JSON.parse(String(init.body)) as { image_list: unknown[] }).image_list.length, 1)
          return new Response(JSON.stringify({ code: 0, data: { task_id: 'paid-image-fixture', task_status: 'submitted' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        assert.match(String(url), /\/omni-image\/paid-image-fixture$/)
        return new Response(JSON.stringify({ code: 0, data: { task_id: 'paid-image-fixture', task_status: 'succeed',
          task_result: { images: [{ index: 0, url: '/generated/candidate.png' }] } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
      sleep: async () => {},
      onTaskSubmitted: async (submitted) => {
        assert.equal((submitted.body as { data: { task_status: string } }).data.task_status, 'submitted')
        imageSubmissionSeen = true
      },
    })
    assert.equal(imageSubmissionSeen, true)
    assert.equal(imageResponse.status, 200)
    const response = await persistCoverageCutFirstFrameResponse(imageResponse.body, root)
    const frameUrl = (response as { data: { task_result: { images: Array<{ url: string }> } } }).data.task_result.images[0].url
    const planned = await executeCodeNode({ code: COVERAGE_CUT_EVIDENCE_PLAN_CODE,
      params: { sources, frame: { url: frameUrl } } })
    const evidence = await collectImageEvidence({ items: planned.items as Record<string, unknown>[] }, root)
    const report = { version: 'coverage-cut-frame-review-v1', passed: true, evidenceUrl: evidence.evidenceUrl,
      frames: evidence.items.slice(0, 2).map((item) => ({ role: item.role, sourceUrl: item.url,
        evidenceReferenceImage: item.referenceImage })),
      assets: evidence.items.slice(2).map((item) => ({ characterName: item.characterName, assetId: item.assetId,
        sourceUrl: item.url, evidenceReferenceImage: item.referenceImage })),
      hardChecks: { newCameraPosition: true, sameAxis: true, leftRightConsistent: true,
        identityConsistent: true, wardrobeConsistent: true, worldStateConsistent: true,
        boundAndPropsConsistent: true, allRequiredVisible: true },
      offscreenNotes: ['两名获准处于画外的军士未在新画面核实，不声称其实际可见。'], issues: [] }
    assert.match(COVERAGE_CUT_FRAME_REVIEW_PROMPT, /画外的既有配角，不要求其在新画面中可见/)
    assert.match(COVERAGE_CUT_FRAME_REVIEW_PROMPT, /绝不能声称已从像素证实其仍在场/)
    assert.ok(renderWorkflowTemplate(COVERAGE_CUT_FRAME_REVIEW_PROMPT, { coverage_evidence: evidence, shot_script: shot })
      .includes(`采证报告地址：${evidence.evidenceUrl}`))
    const accepted = validateCoverageCutFrameReview(report, evidence, shot, sources.previousTail, sources.referenceBindings)
    assert.equal(accepted.frames[1].sourceUrl, frameUrl)
    assert.deepEqual(accepted.offscreenNotes, report.offscreenNotes)
    assert.throws(() => validateCoverageCutFrameReview({ ...report, offscreenNotes: undefined },
      evidence, shot, sources.previousTail, sources.referenceBindings), /COVERAGE_CUT_FRAME_REJECTED/)
    const record = { id: 'model-run-offline-fixture', channel: 'workflow', workflow_id: 'wf-sanguo-history-drama',
      node_id: 'sanguo-coverage-review', capability: 'text', provider: 'Codex', status: 'succeeded',
      request_data: { fingerprint: 'a'.repeat(64),
        prompt: renderWorkflowTemplate(COVERAGE_CUT_FRAME_REVIEW_PROMPT, { coverage_evidence: evidence, shot_script: shot }),
        params: { evidence, shot, previousTail: sources.previousTail, referenceBindings: sources.referenceBindings,
          reviewImages: evidence.reviewImages },
        reviewImageHashes: await Promise.all(evidence.reviewImages.map(async url => ({ url,
          sha256: hash(await readFile(path.join(root, 'public', url))) }))) },
      response_data: { text: JSON.stringify(report) } }
    const reviewExecutionId = assertCoverageCutReviewLedgerRecord(record, report, { evidence, shot,
      previousTail: sources.previousTail, referenceBindings: sources.referenceBindings,
      reviewImages: evidence.reviewImages }, root)
    const certificate = await issueCoverageCutFrameApproval({ review: report, evidence, shot,
      previousTail: sources.previousTail, referenceBindings: sources.referenceBindings,
      reviewExecutionId }, root)
    assert.equal(verifyCoverageCutFrameApproval(certificate, root).signature, certificate.signature)
    const videoParams = { continuityMode: 'coverage_cut', coverageCutFrameGate: certificate, coveragePreviousTail: sources.previousTail,
      coverageShot: shot, referenceImage: frameUrl, referenceImages: sources.referenceImages,
      referenceBindings: sources.referenceBindings }
    assert.doesNotThrow(() => validateCoverageCutVideoPayment(videoParams, root))
    assert.throws(() => validateCoverageCutVideoPayment({ ...videoParams, continuityMode: 'scene_cut' }, root),
      /COVERAGE_FRAME_APPROVAL_INVALID/)
    const paidRequest = { model: { id: 'v', provider: 'Kling', capability: 'video', settings: { model: 'kling-v3' } },
      prompt: '张飞对严颜发问。', params: { ...videoParams, continuityMode: 'coverage_cut', visualTreatment: 'live_action' },
      executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video', requestKey: 'coverage-test' } }
    assert.equal(validateCoverageCutPaidVideoRequest({ ...paidRequest, executionContext: undefined }, undefined, root), 'unrelated')
    assert.equal(validateCoverageCutPaidVideoRequest(paidRequest, undefined, root), 'new-purchase')
    assert.throws(() => validateCoverageCutPaidVideoRequest({ ...paidRequest,
      params: { ...paidRequest.params, continuityMode: 'scene_cut' } }, undefined, root),
    /COVERAGE_FRAME_APPROVAL_INVALID/, 'a coverage shot cannot declare itself a scene cut to skip payment review')
    assert.throws(() => validateCoverageCutPaidVideoRequest({ ...paidRequest,
      params: { ...paidRequest.params, coverageCutFrameGate: undefined } }, undefined, root), /COVERAGE_FRAME_APPROVAL_INVALID/)
    const imageNodeRequest = { model: { id: 'i', provider: 'Kling', capability: 'image', settings: { model: 'kling-v3' } },
      prompt: '同轴新机位', params: { coverageSources: sources, referenceImage: sources.previousTail.url, imageEdit: true },
      executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-coverage-first-frame' } }
    assert.doesNotThrow(() => validateCoverageCutPaidImageRequest({ ...imageNodeRequest, executionContext: undefined }, root))
    assert.doesNotThrow(() => validateCoverageCutPaidImageRequest(imageNodeRequest, root))
    assert.throws(() => validateCoverageCutPaidImageRequest({ ...imageNodeRequest,
      params: { ...imageNodeRequest.params, referenceImage: '/generated/another.png' } }, root), /COVERAGE_PAYMENT_BLOCKED/)
    const resumeRequest = { ...paidRequest, params: { continuityMode: 'coverage_cut', visualTreatment: 'live_action',
      resumeTaskId: 'task-already-bought' } }
    assert.throws(() => validateCoverageCutPaidVideoRequest(resumeRequest, undefined, root), /COVERAGE_PAYMENT_BLOCKED/,
      'a caller-supplied task ID is never a bypass')
    const originalResumeParams = { continuityMode: 'coverage_cut', visualTreatment: 'live_action' }
    const resumeRecord = { task_id: 'task-already-bought', workflow_id: 'wf-sanguo-history-drama',
      node_id: 'sanguo-video', model_id: 'v', provider: 'Kling', capability: 'video', status: 'processing', request_data: {
        requestKey: 'coverage-test', prompt: resumeRequest.prompt, params: originalResumeParams,
        fingerprint: modelRequestFingerprint({ ...resumeRequest, params: originalResumeParams }),
      } }
    assert.equal(validateCoverageCutPaidVideoRequest(resumeRequest, resumeRecord, root), 'paid-reattach')
    assert.throws(() => validateCoverageCutPaidVideoRequest(resumeRequest, { ...resumeRecord, task_id: 'other-task' }, root),
      /COVERAGE_PAYMENT_BLOCKED/)
    const provider = buildKlingVideoRequest({ id: 'v', name: 'Kling video', provider: 'Kling', capability: 'video',
      settings: { model: 'kling-v3', endpoint: 'https://api-singapore.klingai.com/v1/videos' } },
    '张飞对严颜发问。', { ...videoParams, duration: 9 })
    assert.deepEqual((provider.image_list as Array<{ type?: string }>).map(item => item.type ?? 'reference'),
      ['reference', 'reference', 'first_frame'])
    assert.throws(() => validateCoverageCutVideoPayment({ ...videoParams, referenceImage: sources.previousTail.url }, root),
      /COVERAGE_FRAME_APPROVAL_INVALID/)
    assert.throws(() => validateCoverageCutVideoPayment({ ...videoParams, referenceImages: [sources.referenceImages[1], sources.referenceImages[0]] }, root),
      /COVERAGE_FRAME_APPROVAL_INVALID/)
    assert.throws(() => validateCoverageCutFrameReview(report, { ...evidence, items: [evidence.items[0], evidence.items[0], ...evidence.items.slice(2)] },
      shot, sources.previousTail, sources.referenceBindings), /COVERAGE_CUT_FRAME_REJECTED/)
    assert.throws(() => validateCoverageCutFrameReview({ ...report, hardChecks: { ...report.hardChecks, wardrobeConsistent: false } },
      evidence, shot, sources.previousTail, sources.referenceBindings), /COVERAGE_CUT_FRAME_REJECTED/)
    await writeFile(path.join(root, 'public', frameUrl), await pixels(0, 0, 0))
    assert.throws(() => validateCoverageCutVideoPayment(videoParams, root), /COVERAGE_FRAME_APPROVAL_INVALID/)
    const imageRequest = buildKlingImageRequest({ id: 'i', name: 'Kling image', provider: 'Kling', capability: 'image',
      settings: { model: 'kling-v3' } }, '同轴新机位', { referenceImage: sources.previousTail.url, imageEdit: true, aspectRatio: '16:9' })
    assert.equal(imageRequest.model_name, 'kling-v3-omni')
    assert.equal((imageRequest.image_list as unknown[]).length, 1, 'image edit uses one real tail; sheets are independently reviewed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
