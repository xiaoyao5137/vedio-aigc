import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { loadCodexReferenceImages } from '../server/codex-reference-images.ts'
import { prepareRejectedSceneCutEditReference } from '../scripts/prepare-scene-cut-rejected-image-edit-reference.mjs'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const jsonSha = (input: unknown) => sha(Buffer.from(JSON.stringify(input)))

async function rejectedFixture() {
  const boards = [await sharp({ create: { width: 32, height: 32, channels: 3,
    background: '#704b31' } }).jpeg({ quality: 90 }).toBuffer(),
  await sharp({ create: { width: 32, height: 32, channels: 3,
    background: '#484336' } }).jpeg({ quality: 90 }).toBuffer()]
  const sourcePngBytes = await sharp({ create: { width: 64, height: 36, channels: 3,
    background: '#a47849' } }).png().toBuffer()
  const imageSha = sha(sourcePngBytes)
  const imageUrl = `/generated/image-${imageSha.slice(0, 32)}.png`
  const sourceId = 'record-rejected-v6'
  const shot = { id: 'scene-01', visualTreatment: 'live_action', continuity: { mode: 'scene_cut' } }
  const bindings = boards.map((bytes, index) => ({ characterName: ['张飞', '严颜'][index],
    frontUrl: `/generated/board-${index + 1}.jpg`, frontSha256: sha(bytes) }))
  const archive = { version: 'scene-cut-sources-v1', identityPlateVersion: 'scene-cut-identity-plate-v4',
    shotId: shot.id, referenceBindings: bindings,
    imageReferenceImages: boards.map(bytes => `data:image/jpeg;base64,${bytes.toString('base64')}`) }
  const plan = { shotId: shot.id, version: 'scene-cut-opening-plan-v3' }
  const evidence = { evidenceUrl: '/generated/image-evidence-aaaaaaaaaaaaaaaaaaaaaaaa.json',
    items: [{ url: imageUrl }] }
  const review = { passed: false, issues: [{ code: 'CLOSURE_PERFORMER_ORIGINS_NOT_ESTABLISHED' }],
    evidenceUrl: evidence.evidenceUrl, frame: { sourceUrl: imageUrl } }
  const runs = Array.from({ length: 53 }, (_, index) => ({ id: `run-${index}`,
    node: { id: `unused-${index}` }, status: 'idle', loopIndex: 0 }))
  runs[41] = { ...runs[41], node: { id: 'sanguo-scene-cut-source-archive' },
    status: 'success', output: archive }
  runs[43] = { ...runs[43], node: { id: 'sanguo-scene-cut-opening-plan' },
    status: 'success', output: plan }
  runs[44] = { ...runs[44], context: { shot_script: shot } }
  runs[45] = { ...runs[45], node: { id: 'sanguo-scene-cut-first-frame' },
    status: 'success', output: { url: imageUrl,
      params: { sceneCutShot: shot, sceneCutSources: archive, sceneCutOpeningPlan: plan,
        referenceImages: archive.imageReferenceImages } } }
  runs[48] = { ...runs[48], node: { id: 'sanguo-scene-cut-evidence' },
    status: 'success', output: evidence }
  runs[49] = { ...runs[49], node: { id: 'sanguo-scene-cut-review' },
    status: 'success', output: review }
  runs[50] = { ...runs[50], node: { id: 'sanguo-scene-cut-approval' } }
  runs[52] = { ...runs[52], node: { id: 'sanguo-video' } }
  const source = { id: sourceId, sceneCutFirstFrameRecovery: { workflowSchemaVersion: 176 },
    nodeRuns: runs }
  return { source, sourceResultMd5: 'a'.repeat(32), expectedSourceId: sourceId,
    expectedSourceMd5: 'a'.repeat(32), expectedImageSha256: imageSha,
    expectedReviewSha256: jsonSha(review), sourcePngBytes, identityBoardBytes: boards }
}

test('a rejected image becomes only the third ordered JPEG reference, never an approved first frame', async () => {
  const fixture = await rejectedFixture()
  const prepared = await prepareRejectedSceneCutEditReference(fixture)
  assert.equal(prepared.referenceImages.length, 3)
  assert.deepEqual(prepared.referenceImages.slice(0, 2),
    fixture.source.nodeRuns[41].output.imageReferenceImages)
  assert.equal(prepared.receipt.role, 'reference-only')
  assert.equal(prepared.receipt.sourceVerdict, 'rejected')
  assert.equal(prepared.receipt.approvedFirstFrame, false)
  assert.equal('url' in prepared, false)
  assert.equal('certificate' in prepared, false)
  assert.equal(prepared.receipt.failedReviewOutputSha256, fixture.expectedReviewSha256)
  assert.equal(prepared.receipt.sourceImageSha256, fixture.expectedImageSha256)
  assert.deepEqual(prepared.receipt.referenceOrder.map(item => item.position), [1, 2, 3])
  const loaded = await loadCodexReferenceImages(prepared.referenceImages)
  assert.equal(loaded.length, 3)
  assert.equal(sha(loaded[2].bytes), prepared.receipt.referenceOrder[2].jpegSha256)
  assert.equal(loaded[2].bytes.length, prepared.receipt.referenceOrder[2].bytes)
  assert.ok(prepared.receipt.totalReferenceBytes < 24 * 1024 * 1024)
})

test('a passed review, progressed payment gate, or altered failure receipt cannot create an edit reference', async () => {
  const passed = await rejectedFixture()
  passed.source.nodeRuns[49].output = { ...passed.source.nodeRuns[49].output, passed: true }
  await assert.rejects(prepareRejectedSceneCutEditReference(passed), /independently rejected/)

  const progressed = await rejectedFixture()
  progressed.source.nodeRuns[50].status = 'success'
  await assert.rejects(prepareRejectedSceneCutEditReference(progressed), /already advanced/)

  const changedReview = await rejectedFixture()
  changedReview.source.nodeRuns[49].output.issues[0].code = 'REWRITTEN_VERDICT'
  await assert.rejects(prepareRejectedSceneCutEditReference(changedReview), /independently rejected/)
})

test('source PNG, identity board bytes and their order remain byte locked', async () => {
  const changedPng = await rejectedFixture()
  changedPng.sourcePngBytes = Buffer.from(changedPng.sourcePngBytes)
  changedPng.sourcePngBytes[20] ^= 1
  await assert.rejects(prepareRejectedSceneCutEditReference(changedPng), /PNG bytes differ/)

  const switchedBoards = await rejectedFixture()
  switchedBoards.identityBoardBytes = [...switchedBoards.identityBoardBytes].reverse()
  await assert.rejects(prepareRejectedSceneCutEditReference(switchedBoards), /identity board 1 bytes or order changed/)

  const changedShot = await rejectedFixture()
  changedShot.source.nodeRuns[45].output.params.sceneCutShot = { id: 'scene-02' }
  await assert.rejects(prepareRejectedSceneCutEditReference(changedShot), /approved shot/)
})
