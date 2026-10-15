import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { A8B6_LOCAL_COMPOSITE_MARKER_VERSION,
  assertA8B6LocalCompositeWorkflowResult,
  inspectA8B6LocalCompositePixels,
  verifyA8B6LocalCompositeSourceReceipt } from
  '../server/staged-scene-cut-a8b6-local-composite-admission.mjs'
import { verifiedIdleContinuation } from '../scripts/workflow-drive-state.mjs'

const png = async (changes: Array<{ x: number; y: number; r: number }>,
  alpha = 255) => {
  const pixels = Buffer.alloc(1536 * 864 * 4, 255)
  for (const { x, y, r } of changes) {
    const i = (y * 1536 + x) * 4
    pixels[i] = r
  }
  if (alpha !== 255) pixels[(10 * 1536 + 10) * 4 + 3] = alpha
  return sharp(pixels, { raw: { width: 1536, height: 864, channels: 4 } })
    .png().toBuffer()
}

test('local first-frame proof checks every visible pixel outside the signed ROI', async () => {
  const base = await png([])
  const inside = await png([{ x: 1082, y: 165, r: 80 }])
  const proof = await inspectA8B6LocalCompositePixels(base, inside,
    [{ type: 'ellipse', centerX: 1082, centerY: 165,
      radiusX: 69, radiusY: 73 }])
  assert.deepEqual(proof, { changedPixels: 1, outsideAllowedChangedPixels: 0,
    changedBounds: { minX: 1082, minY: 165, maxX: 1082, maxY: 165 } })
  const outside = await png([{ x: 1082, y: 165, r: 80 },
    { x: 400, y: 400, r: 80 }])
  await assert.rejects(inspectA8B6LocalCompositePixels(base, outside,
    [{ type: 'ellipse', centerX: 1082, centerY: 165,
      radiusX: 69, radiusY: 73 }]), /outside signed ROI/)
})

test('transparent pixels and invalid secondary ROI cannot hide a full-frame change',
  async () => {
    const base = await png([])
    const transparent = await png([{ x: 1082, y: 165, r: 80 }], 0)
    await assert.rejects(inspectA8B6LocalCompositePixels(base, transparent,
      [{ type: 'rect', left: 1000, top: 100, width: 150, height: 140 }]),
    /transparent pixels/)
    const valid = await png([{ x: 1082, y: 165, r: 80 }])
    await assert.rejects(inspectA8B6LocalCompositePixels(base, valid,
      [{ type: 'rect', left: 1000, top: 100, width: 150, height: 140 },
        { type: 'rect', left: 1535, top: 0, width: 2, height: 1 }]),
    /invalid rectangular/)
  })

test('formal local result requires new model review, certificate and no image payment', () => {
  const imageSha = createHash('sha256').update('first-frame').digest('hex')
  const receiptSha = createHash('sha256').update('source-receipt').digest('hex')
  const url = `/generated/image-${imageSha.slice(0, 32)}.png`
  const receipt = { target: { executionId: 'record-local-new' },
    output: { url, sha256: imageSha } }
  const execution = { id: 'record-local-new',
    sceneCutA8B6LocalFrameRecovery: {
      version: A8B6_LOCAL_COMPOSITE_MARKER_VERSION,
      sourceReceiptSha256: receiptSha },
    nodeRuns: Array.from({ length: 51 }, () => ({ status: 'idle' })) }
  execution.nodeRuns[45] = { status: 'success', output: { url,
    sourceBoundLocalComposite: { sourceReceiptSha256: receiptSha } } }
  execution.nodeRuns[48] = { status: 'success' }
  execution.nodeRuns[49] = { status: 'success',
    output: { passed: true, issues: [] } }
  execution.nodeRuns[50] = { status: 'success',
    output: { passed: true, frame: { sourceUrl: url },
      sourceSha256s: [imageSha] } }
  const args = { receipt, receiptSha256: receiptSha, execution,
    imageLedgers: [], reviewLedgerCount: 1,
    frameCertificateSha256: imageSha }
  assert.deepEqual(assertA8B6LocalCompositeWorkflowResult(args), {
    approvedFirstFrameUrl: url, approvedFirstFrameSha256: imageSha,
    frameCertificateSha256: imageSha })
  assert.throws(() => assertA8B6LocalCompositeWorkflowResult({
    ...args, imageLedgers: [{ status: 'succeeded' }],
  }), /zero-payment proof/)
  execution.nodeRuns[49].output.passed = false
  assert.throws(() => assertA8B6LocalCompositeWorkflowResult(args),
    /fresh review/)
})

test('local receipt cannot be admitted before a signed receipt and algorithm exist',
  async () => {
    await assert.rejects(verifyA8B6LocalCompositeSourceReceipt(
      '/definitely-no-a8b6-local-composite'), /ENOENT/)
  })

test('local child driver admits only its exact node46 read-only checkpoint', () => {
  const marker = {
    version: 'scene-cut-a8b6-local-first-frame-v1',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    v7ExecutionId: 'record-4x5m31-a8b6-fresh-v7-dual-output-recovery',
    v7ResultMd5: '474085677d68cea9f0cb436e06bf71af',
    v4ExecutionId: 'record-4x5m31-a8b6-fresh-first-frame-v4-edit',
    v4ResultMd5: 'bc5b2614194cd18fef359520bf010a11',
    v8ExecutionId: 'record-4x5m31-a8b6-fresh-first-frame-v8-edit',
    v8ResultMd5: 'c0d9ba72214c3ba539d5957385f605a6',
    v8RejectedReviewSha256:
      '2e92771cca94bfb59a1872a9ee127a29a23eeffad69352efc73f315ebca0be73',
    sourceReceiptSha256:
      '16a0e173ddf353a5c3eb4c7440551f14109b26dea9692c4c7d600ad3d93312fa',
    outputUrl: '/generated/image-f0c8fcc82fae74e8d736bb5e099471a7.png',
    outputSha256:
      'f0c8fcc82fae74e8d736bb5e099471a799280db5e7b9d64b4e149efc26314ba1',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 45,
    preservedPrefixSha256:
      '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00',
    firstPendingIndex: 46, firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256: '5fa24ee11248983728229176410ea971c38df6ba834ea76a976073810ed33328',
  }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 46 ? 'sanguo-map-end-accept' : `node-${index}`,
    status: index < 46 ? 'success' : 'idle', loopIndex: 0 }))
  const record = { id: 'record-4x5m31-a8b6-local-face-v1',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: 'sanguo-map-end-accept',
    sceneCutA8B6LocalFrameRecovery: marker, runs }
  const options = { workflowId: record.workflowId,
    nodeId: 'sanguo-map-end-accept' }
  assert.equal(verifiedIdleContinuation(record, options), runs[46])
  assert.throws(() => verifiedIdleContinuation({ ...record,
    sceneCutA8B6LocalFrameRecovery: { ...marker,
      outputSha256: '0'.repeat(64) } }, options), /IDENTITY_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation({ ...record,
    runs: runs.map((run, index) => index === 47
      ? { ...run, status: 'success' } : run) }, options), /IDENTITY_MISMATCH/)
})
