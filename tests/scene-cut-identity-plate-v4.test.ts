import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { archiveSceneCutSources, buildSceneCutIdentityPlateV3,
  buildSceneCutIdentityPlateV4 } from '../server/scene-cut-frame-storage.ts'
import { collectImageEvidence } from '../server/image-evidence.ts'
import { issueSceneCutFrameApproval, validateSceneCutVideoPayment,
  verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { validateSceneCutPaidImageRequest } from '../server/scene-cut-frame-runtime.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V172 } from '../src/scene-cut-action-visibility-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const colors = {
  face: [20, 80, 150], armor: [70, 90, 100], belt: [215, 155, 35],
  outer: [155, 108, 65], inner: [37, 47, 74], boots: [20, 20, 18],
  side: [255, 0, 160], back: [0, 255, 100],
} as const

/** Three-view source with four measured garment bands on its front panel. */
async function garmentTriptych() {
  const width = 900, height = 600
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const front = y < 180 ? colors.face : y < 216 ? colors.armor
      : y < 252 ? colors.belt : y < 432 ? colors.outer
        : y < 540 ? colors.inner : colors.boots
    for (let x = 0; x < width; x++) {
      const color = x < 300 ? front : x < 600 ? colors.side : colors.back
      const at = (y * width + x) * 3
      pixels[at] = color[0]; pixels[at + 1] = color[1]; pixels[at + 2] = color[2]
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

function closestGarment(pixel: number[]) {
  const garment = Object.entries(colors).filter(([name]) =>
    ['belt', 'outer', 'inner', 'boots'].includes(name))
  return garment.reduce((best, [name, color]) => {
    const distance = color.reduce((sum, value, index) => sum + (value - pixel[index]) ** 2, 0)
    return distance < best.distance ? { name, distance } : best
  }, { name: '', distance: Number.POSITIVE_INFINITY }).name
}

test('v4 keeps belt, outer hem, dark inner hem and boots in one measured scale', async () => {
  const source = await garmentTriptych()
  const v4 = await buildSceneCutIdentityPlateV4(source, 'horizontal-three-view')
  const v3 = await buildSceneCutIdentityPlateV3(source, 'horizontal-three-view')
  assert.equal(v4.layout, 'horizontal-three-view')
  assert.deepEqual(Object.keys(v4.partSha256s),
    ['faceAndHeadwear', 'collarAndArmor', 'waistThroughBoots'])
  for (const value of Object.values(v4.partSha256s)) assert.match(value, /^[a-f0-9]{64}$/)
  assert.deepEqual(await sharp(v4.plate).metadata().then(({ width, height }) => ({ width, height })),
    { width: 640, height: 960 })
  assert.deepEqual(await sharp(v3.plate).metadata().then(({ width, height }) => ({ width, height })),
    { width: 640, height: 640 })
  assert.notEqual(sha256(v4.plate), sha256(v3.plate))

  const { data, info } = await sharp(v4.plate).raw().toBuffer({ resolveWithObject: true })
  const labels = Array.from({ length: 640 }, (_, offset) => {
    const at = ((320 + offset) * info.width + 320) * info.channels
    return closestGarment([...data.subarray(at, at + 3)])
  })
  const counts = Object.fromEntries(['belt', 'outer', 'inner', 'boots']
    .map(name => [name, labels.filter(label => label === name).length])) as Record<string, number>
  assert.deepEqual([...new Set(labels)], ['belt', 'outer', 'inner', 'boots'])
  // Source front spans y=216..597: 36 belt, 180 outer, 108 inner, 57 boots.
  for (const [name, sourceHeight] of Object.entries({ belt: 36, outer: 180,
    inner: 108, boots: 57 }))
    assert.ok(Math.abs(counts[name] / 640 - sourceHeight / 381) < 0.025,
      `${name} changed scale: ${counts[name]} px`)
  assert.ok(Math.abs(counts.inner / counts.outer - 108 / 180) < 0.05)
})

test('schema172 paid image accepts only the archived v4 plate and original bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-plate-v4-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const source = await garmentTriptych()
    await writeFile(path.join(root, 'public/generated/triptych.png'), source)
    const shot = { id: 'scene-01', continuity: { mode: 'scene_cut' },
      visualTreatment: 'live_action', firstFrameMode: 'reference', characters: ['严颜'],
      visualPrompt: '江州院落。', camera: '正面全景。', pacing: { beats: [], schedule: [] } }
    const common = { shot, referenceBindings: [{ characterName: '严颜', assetId: 'asset-yan',
      referenceLayout: 'horizontal-three-view' }],
      referenceImages: ['/generated/triptych.png'],
      sceneCutBoundaryVersion: 'scene-cut-approved-boundary-v1',
      approvedOutline: { scenes: [{ id: shot.id }] },
      acceptedRecordBinding: { version: 'scene-cut-source-ledger-v1' } }
    const sources = await archiveSceneCutSources({ ...common,
      identityPlateVersion: 'scene-cut-identity-plate-v4' }, root)
    const binding = sources.referenceBindings[0]
    const saved = await readFile(path.join(root, 'public', binding.frontUrl))
    assert.equal(sources.identityPlateVersion, 'scene-cut-identity-plate-v4')
    assert.equal(binding.frontSha256, sha256(saved))
    assert.equal(binding.partSha256s.waistThroughBoots,
      (await buildSceneCutIdentityPlateV4(source, 'horizontal-three-view'))
        .partSha256s.waistThroughBoots)
    assert.deepEqual(await sharp(saved).metadata().then(({ width, height }) => ({ width, height })),
      { width: 640, height: 960 })
    const opening = deriveSceneCutOpeningPlan(shot, 3)
    const request = { model: { id: 'codex-gpt-image-2', provider: 'Codex',
      capability: 'image', settings: {} },
    prompt: renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V172,
      { shot_script: shot, scene_cut_sources: sources, scene_cut_opening_state: opening }),
    params: { sceneCutShot: shot, sceneCutSources: sources, sceneCutOpeningPlan: opening,
      referenceImages: sources.imageReferenceImages, singleFrame: true, size: '1536x864' },
    executionContext: { workflowId: 'wf-sanguo-history-drama',
      nodeId: 'sanguo-scene-cut-first-frame' } }
    await assert.doesNotReject(validateSceneCutPaidImageRequest(request, root, 172))
    const wrongPart = { ...binding, partSha256s: { ...binding.partSha256s,
      waistThroughBoots: '0'.repeat(64) } }
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      params: { ...request.params, sceneCutSources: { ...sources,
        referenceBindings: [wrongPart] } } }, root, 172), /SCENE_CUT_FRAME_BLOCKED/)
    const v3 = await archiveSceneCutSources({ ...common,
      identityPlateVersion: 'scene-cut-identity-plate-v3' }, root)
    await assert.rejects(validateSceneCutPaidImageRequest({ ...request,
      params: { ...request.params, sceneCutSources: v3,
        referenceImages: v3.imageReferenceImages } }, root, 172), /SCENE_CUT_FRAME_BLOCKED/)
    await assert.rejects(validateSceneCutPaidImageRequest(request, root, 171),
      /SCENE_CUT_FRAME_BLOCKED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('signed v4 approval binds archived board bytes; old approval cannot buy a v4 video', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-plate-approval-v4-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    await writeFile(path.join(root, 'public/generated/triptych.png'), await garmentTriptych())
    const candidate = await sharp({ create: { width: 640, height: 360, channels: 3,
      background: '#928778' } }).png().toBuffer()
    await writeFile(path.join(root, 'public/generated/candidate.png'), candidate)
    const shot = { id: 'scene-01', continuity: { mode: 'scene_cut' },
      visualTreatment: 'live_action', firstFrameMode: 'reference', characters: ['严颜'],
      visualPrompt: '江州院落。', camera: '正面全景。', pacing: { beats: [], schedule: [] } }
    const common = { shot, referenceBindings: [{ characterName: '严颜', assetId: 'asset-yan',
      referenceLayout: 'horizontal-three-view' }],
      referenceImages: ['/generated/triptych.png'],
      sceneCutBoundaryVersion: 'scene-cut-approved-boundary-v1',
      approvedOutline: { scenes: [{ id: shot.id }] },
      acceptedRecordBinding: { version: 'scene-cut-source-ledger-v1' } }
    const v4 = await archiveSceneCutSources({ ...common,
      identityPlateVersion: 'scene-cut-identity-plate-v4' }, root)
    const v3 = await archiveSceneCutSources({ ...common,
      identityPlateVersion: 'scene-cut-identity-plate-v3' }, root)
    const evidence = await collectImageEvidence({ items: [
      { role: 'candidate_first', url: '/generated/candidate.png' },
      { role: 'identity', url: v4.referenceBindings[0].url },
    ] }, root)
    const review = { version: 'scene-cut-first-frame-review-v1', passed: true,
      evidenceUrl: evidence.evidenceUrl,
      frame: { sourceUrl: evidence.items[0].url,
        evidenceReferenceImage: evidence.items[0].referenceImage },
      assets: [{ characterName: '严颜', assetId: 'asset-yan',
        sourceUrl: evidence.items[1].url,
        evidenceReferenceImage: evidence.items[1].referenceImage }],
      firstRequiredVisualBeatId: '', requiredVisualActionChecks: [],
      observedOpening: { setting: '江州院落', characters: '严颜',
        bodyAndProps: '完整衣装', actionStart: '静止' },
      hardChecks: { setting: true, castAndIdentity: true, wardrobeAndEquipment: true,
        bodyAndProps: true, actionStartNotCompleted: true,
        allRequiredVisualActionsOpen: true, singleFullFrame: true },
      wardrobeHemCheck: { applicable: true,
        originalHemAndFootwear: '原图外袍、内摆和靴子',
        candidateHemAndFootwear: '候选外袍、内摆和靴子', matches: true },
      issues: [] }
    const certificate = await issueSceneCutFrameApproval({ review, evidence, shot, sources: v4,
      reviewExecutionId: 'model-run-plate-v4' }, root)
    assert.equal(certificate.identityPlateVersion, 'scene-cut-identity-plate-v4')
    assert.match(certificate.sourceArchiveSha256 ?? '', /^[a-f0-9]{64}$/)
    assert.equal(certificate.identityPlateBindings?.[0].frontSha256,
      v4.referenceBindings[0].frontSha256)
    assert.equal(verifySceneCutFrameApproval(certificate, root).signature, certificate.signature)
    const params = { continuityMode: 'scene_cut', visualTreatment: 'live_action',
      sceneCutShot: shot, sceneCutSources: v4, sceneCutFrameGate: certificate,
      referenceImage: '/generated/candidate.png', referenceImages: v4.referenceImages,
      referenceBindings: v4.referenceBindings }
    assert.equal(validateSceneCutVideoPayment(params, root).signature, certificate.signature)
    assert.throws(() => validateSceneCutVideoPayment({ ...params,
      sceneCutSources: { ...v4, referenceBindings: [{ ...v4.referenceBindings[0],
        partSha256s: { ...v4.referenceBindings[0].partSha256s,
          waistThroughBoots: '0'.repeat(64) } }] } }, root), /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    const oldCertificate = await issueSceneCutFrameApproval({ review, evidence, shot, sources: v3,
      reviewExecutionId: 'model-run-plate-v3' }, root)
    assert.equal(oldCertificate.identityPlateVersion, undefined)
    assert.equal(verifySceneCutFrameApproval(oldCertificate, root).signature, oldCertificate.signature)
    assert.throws(() => validateSceneCutVideoPayment({ ...params,
      sceneCutFrameGate: oldCertificate }, root), /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    const frontPath = path.join(root, 'public', v4.referenceBindings[0].frontUrl)
    const originalFront = await readFile(frontPath)
    await writeFile(frontPath, Buffer.from('tampered board'))
    assert.throws(() => validateSceneCutVideoPayment(params, root),
      /SCENE_CUT_FRAME_APPROVAL_INVALID/)
    await writeFile(frontPath, originalFront)
    assert.equal(verifySceneCutFrameApproval(certificate, root).signature, certificate.signature)
  } finally { await rm(root, { recursive: true, force: true }) }
})
