import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { archiveSceneCutSources } from '../server/scene-cut-frame-storage.ts'
import { collectImageEvidence } from '../server/image-evidence.ts'
import { issueSceneCutFrameApproval, validateSceneCutVideoPayment,
  verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

test('schema177 signed repair certificate binds two identity boards, rejected PNG and new candidate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-repair-certificate-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const triptych = await sharp({ create: { width: 900, height: 600, channels: 3,
      background: '#755d45' } }).png().toBuffer()
    await writeFile(path.join(root, 'public/generated/source-a.png'), triptych)
    await writeFile(path.join(root, 'public/generated/source-b.png'), triptych)
    const candidate = await sharp({ create: { width: 640, height: 360, channels: 3,
      background: '#927856' } }).png().toBuffer()
    await writeFile(path.join(root, 'public/generated/candidate.png'), candidate)
    const failed = await sharp({ create: { width: 640, height: 360, channels: 3,
      background: '#786a55' } }).png().toBuffer()
    const failedSha = sha256(failed)
    const failedUrl = `/generated/image-${failedSha.slice(0, 32)}.png`
    await writeFile(path.join(root, 'public', failedUrl), failed)
    const shot = { id: 'scene-01', continuity: { mode: 'scene_cut' },
      visualTreatment: 'live_action', firstFrameMode: 'reference',
      characters: ['主将', '俘虏'], visualPrompt: '已批准的街口起点。',
      camera: '侧前方全景。', pacing: { beats: [], schedule: [] } }
    const sources = await archiveSceneCutSources({ shot, referenceBindings: [
      { characterName: '主将', assetId: 'asset-general',
        referenceLayout: 'horizontal-three-view' },
      { characterName: '俘虏', assetId: 'asset-captive',
        referenceLayout: 'horizontal-three-view' },
    ], referenceImages: ['/generated/source-a.png', '/generated/source-b.png'],
    identityPlateVersion: 'scene-cut-identity-plate-v4',
    sceneCutBoundaryVersion: 'scene-cut-approved-boundary-v1',
    approvedOutline: { scenes: [{ id: shot.id }] },
    acceptedRecordBinding: { version: 'scene-cut-source-ledger-v1' } }, root)
    const evidence = await collectImageEvidence({ items: [
      { role: 'candidate_first', url: '/generated/candidate.png' },
      ...sources.referenceBindings.map(binding => ({ role: 'identity', url: binding.url })),
    ] }, root)
    const review = { version: 'scene-cut-first-frame-review-v1', passed: true,
      evidenceUrl: evidence.evidenceUrl,
      frame: { sourceUrl: evidence.items[0].url,
        evidenceReferenceImage: evidence.items[0].referenceImage },
      assets: sources.referenceBindings.map((binding, index) => ({
        characterName: binding.characterName, assetId: binding.assetId,
        sourceUrl: evidence.items[index + 1].url,
        evidenceReferenceImage: evidence.items[index + 1].referenceImage })),
      firstRequiredVisualBeatId: '', requiredVisualActionChecks: [],
      observedOpening: { setting: '街口', characters: '主将与俘虏',
        bodyAndProps: '原衣装', actionStart: '静止' },
      hardChecks: { setting: true, castAndIdentity: true, wardrobeAndEquipment: true,
        bodyAndProps: true, actionStartNotCompleted: true,
        allRequiredVisualActionsOpen: true, singleFullFrame: true },
      wardrobeHemCheck: { applicable: true,
        originalHemAndFootwear: '原衣摆和靴', candidateHemAndFootwear: '候选衣摆和靴',
        matches: true }, issues: [] }
    const sourceOrder = await Promise.all(sources.referenceBindings.map(async (binding, index) => ({
      position: index + 1, characterName: binding.characterName,
      frontUrl: binding.frontUrl, sha256: binding.frontSha256,
      bytes: (await readFile(path.join(root, 'public', binding.frontUrl))).length })))
    const receipt = { version: 'scene-cut-rejected-image-edit-reference-v1',
      role: 'reference-only', sourceVerdict: 'rejected', approvedFirstFrame: false,
      requiresFreshIndependentReview: true, requiresPaidGateRevalidation: true,
      sourceExecutionId: 'record-parent-v6', sourceResultMd5: 'a'.repeat(32),
      sourceImageUrl: failedUrl, sourceImageSha256: failedSha,
      failedReviewOutputSha256: 'b'.repeat(64), preparationSha256: 'c'.repeat(64),
      approvedShotSha256: sha256(JSON.stringify(shot)),
      sourceArchiveSha256: sha256(JSON.stringify(sources)),
      referenceOrder: [...sourceOrder, { position: 3, role: 'rejected-edit-source',
        sourceUrl: failedUrl, sourceSha256: failedSha,
        jpegSha256: 'd'.repeat(64), bytes: 100 }] }
    const repairBinding = { version: 'scene-cut-image-repair-binding-v1' as const,
      executionId: 'record-repair-v7', imageExecutionId: 'model-run-new-image',
      repairRequestFingerprint: 'e'.repeat(64),
      repairReceiptSha256: sha256(canonical(receipt)),
      candidateImageSha256: sha256(candidate), receipt }
    const certificate = await issueSceneCutFrameApproval({ review, evidence, shot, sources,
      reviewExecutionId: 'model-run-new-review', imageRepairBinding: repairBinding }, root)
    assert.equal(certificate.repairBinding?.imageExecutionId, repairBinding.imageExecutionId)
    assert.equal(verifySceneCutFrameApproval(certificate, root).signature, certificate.signature)
    const params = { continuityMode: 'scene_cut', visualTreatment: 'live_action',
      sceneCutShot: shot, sceneCutSources: sources, sceneCutFrameGate: certificate,
      referenceImage: '/generated/candidate.png',
      referenceImages: sources.referenceImages,
      referenceBindings: sources.referenceBindings }
    assert.equal(validateSceneCutVideoPayment(params, root).signature, certificate.signature)
    assert.throws(() => verifySceneCutFrameApproval({ ...certificate,
      repairBinding: { ...repairBinding, imageExecutionId: 'model-run-tampered' } }, root),
    /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    assert.throws(() => validateSceneCutVideoPayment({ ...params,
      referenceImage: failedUrl }, root), /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    await mkdir(path.join(root, 'qa/record-test'), { recursive: true })
    const guide = await sharp({ create: { width: 640, height: 360, channels: 3,
      background: '#568682' } }).png().toBuffer()
    const guidePath = 'qa/record-test/geometry-guide-v8-12345678.png'
    await writeFile(path.join(root, guidePath), guide)
    const guideJpeg = await sharp(guide).jpeg({ quality: 90,
      chromaSubsampling: '4:4:4' }).toBuffer()
    const receiptV2 = { ...receipt, version: 'scene-cut-rejected-image-edit-reference-v2',
      guideProvenanceSha256: 'a'.repeat(64),
      geometryGuide: { role: 'geometry-only', identityAuthority: false,
        sourcePath: guidePath, sourceSha256: sha256(guide) },
      referenceOrder: [...receipt.referenceOrder, { position: 4, role: 'geometry-guide',
        purpose: 'geometry-only', referenceOnly: true, sourcePath: guidePath,
        sourceSha256: sha256(guide), jpegSha256: sha256(guideJpeg),
        bytes: guideJpeg.length }] }
    const bindingV2 = { ...repairBinding,
      version: 'scene-cut-image-repair-binding-v2' as const,
      repairReceiptSha256: sha256(canonical(receiptV2)), receipt: receiptV2 }
    const certificateV2 = await issueSceneCutFrameApproval({ review, evidence, shot, sources,
      reviewExecutionId: 'model-run-fresh-review-v8', imageRepairBinding: bindingV2 }, root)
    assert.equal(certificateV2.repairBinding?.version, 'scene-cut-image-repair-binding-v2')
    assert.equal(verifySceneCutFrameApproval(certificateV2, root).signature,
      certificateV2.signature)
    assert.equal(validateSceneCutVideoPayment({ ...params, sceneCutFrameGate: certificateV2 }, root)
      .signature, certificateV2.signature)
    assert.throws(() => verifySceneCutFrameApproval({ ...certificateV2,
      repairBinding: { ...bindingV2, receipt: { ...receiptV2,
        referenceOrder: [...receiptV2.referenceOrder.slice(0, 3),
          { ...receiptV2.referenceOrder[3], purpose: 'identity' }] } } }, root),
    /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    await writeFile(path.join(root, guidePath), Buffer.from('tampered guide'))
    assert.throws(() => verifySceneCutFrameApproval(certificateV2, root),
      /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    assert.equal(verifySceneCutFrameApproval(certificate, root).signature, certificate.signature)
    await writeFile(path.join(root, 'public', failedUrl), Buffer.from('tampered parent'))
    assert.throws(() => verifySceneCutFrameApproval(certificate, root),
      /SCENE_CUT_FRAME_APPROVAL_INVALID/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
