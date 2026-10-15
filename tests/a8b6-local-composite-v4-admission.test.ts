import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { inspectA8B6LocalCompositePixelsV4,
  assertA8B6LocalCompositeWorkflowResultV4 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v4.mjs'

const regions = [{ role: 'wall', polygons: [
  [[400, 100], [600, 100], [600, 300], [400, 300]],
] }]
const png = (value: Buffer) => sharp(value, { raw: {
  width: 1536, height: 864, channels: 3,
} }).png().toBuffer()

test('V4 checks the native wall ROI and rejects changes elsewhere', async () => {
  const base = Buffer.alloc(1536 * 864 * 3)
  const output = Buffer.from(base)
  output[(200 * 1536 + 500) * 3] = 25
  const basePng = await png(base)
  assert.deepEqual(await inspectA8B6LocalCompositePixelsV4(
    basePng, await png(output), regions), {
    changedPixels: 1, outsideAllowedChangedPixels: 0,
    changedBounds: { minX: 500, minY: 200, maxX: 500, maxY: 200 },
  })
  output[(500 * 1536 + 1000) * 3] = 25
  await assert.rejects(inspectA8B6LocalCompositePixelsV4(
    basePng, await png(output), regions), /outside signed ROI/)
})

test('V4 refuses paid media before its own review and certificate', () => {
  const receipt = { target: { executionId: 'record-v4' },
    output: { url: '/generated/new.png', sha256: 'a'.repeat(64) } }
  const execution = { id: 'record-v4', sceneCutA8B6LocalFrameRecovery: {
    version: 'scene-cut-a8b6-local-first-frame-v4',
    sourceReceiptSha256: 'b'.repeat(64) }, nodeRuns: Array.from(
    { length: 51 }, () => ({ status: 'idle' })) }
  execution.nodeRuns[45] = { status: 'success',
    output: { url: receipt.output.url,
      sourceBoundLocalComposite: { sourceReceiptSha256: 'b'.repeat(64) } } }
  execution.nodeRuns[48] = { status: 'success' }
  execution.nodeRuns[49] = { status: 'success',
    output: { passed: false, issues: ['wall'] } }
  assert.throws(() => assertA8B6LocalCompositeWorkflowResultV4({
    receipt, receiptSha256: 'b'.repeat(64), execution,
    imageLedgers: [], reviewLedgerCount: 1,
    frameCertificateSha256: 'c'.repeat(64) }), /independent review/)
})
