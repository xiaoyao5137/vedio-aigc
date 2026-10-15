import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { inspectA8B6LocalCompositePixelsV3,
  assertA8B6LocalCompositeWorkflowResultV3 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v3.mjs'

const regions = [
  { role: 'wall', polygons: [[[199, 199], [202, 199],
    [202, 202], [199, 202]]] },
  { role: 'gate-frame', polygons: [[[699, 399], [702, 399],
    [702, 402], [699, 402]], [[201, 199], [203, 199],
    [203, 202], [201, 202]]] },
  { role: 'yan-face', polygons: [[[999, 99], [1002, 99],
    [1002, 102], [999, 102]]] },
]

test('V3 checks wall, gate frame and Yan face independently at native resolution',
  async () => {
    const base = Buffer.alloc(1536 * 864 * 3)
    const output = Buffer.from(base)
    output[(200 * 1536 + 200) * 3] = 25
    output[(200 * 1536 + 201) * 3] = 25
    output[(100 * 1536 + 1000) * 3 + 1] = 25
    const png = async value => sharp(value, { raw: { width: 1536,
      height: 864, channels: 3 } }).png().toBuffer()
    const basePng = await png(base)
    const report = await inspectA8B6LocalCompositePixelsV3(basePng,
      await png(output), regions)
    assert.deepEqual(report, { changedPixels: 3,
      outsideAllowedChangedPixels: 0,
      changedBounds: { minX: 200, minY: 100, maxX: 1000, maxY: 200 } })
    output[(500 * 1536 + 500) * 3] = 1
    await assert.rejects(inspectA8B6LocalCompositePixelsV3(basePng,
      await png(output), regions), /outside signed ROI/)
  })

test('V3 cannot enter paid media before independent review and certificate', () => {
  const receipt = { target: { executionId: 'record-v3' },
    output: { url: '/generated/new.png', sha256: 'a'.repeat(64) } }
  const execution = { id: 'record-v3', sceneCutA8B6LocalFrameRecovery: {
    version: 'scene-cut-a8b6-local-first-frame-v3',
    sourceReceiptSha256: 'b'.repeat(64) }, nodeRuns: Array.from(
    { length: 51 }, () => ({ status: 'idle' })) }
  execution.nodeRuns[45] = { status: 'success',
    output: { url: receipt.output.url,
      sourceBoundLocalComposite: { sourceReceiptSha256: 'b'.repeat(64) } } }
  execution.nodeRuns[48] = { status: 'success' }
  execution.nodeRuns[49] = { status: 'success',
    output: { passed: false, issues: ['identity'] } }
  assert.throws(() => assertA8B6LocalCompositeWorkflowResultV3({
    receipt, receiptSha256: 'b'.repeat(64), execution,
    imageLedgers: [], reviewLedgerCount: 1,
    frameCertificateSha256: 'c'.repeat(64) }), /independent review/)
})
