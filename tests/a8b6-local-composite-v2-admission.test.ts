import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { inspectA8B6LocalCompositePixelsV2,
  assertA8B6LocalCompositeWorkflowResultV2 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v2.mjs'

const root = new URL('../', import.meta.url)
const asset = (name: string) => readFileSync(new URL(name, root))

test('v2 imagegen face preview changes only signed face polygons', async () => {
  const report = JSON.parse(asset(
    'qa/staged-scene-cut/yan-local-face-v2-preview.json').toString('utf8'))
  const base = asset('public/generated/image-b96d9804eb28771cbe2cc2d5d6edc532.png')
  const output = asset('qa/staged-scene-cut/yan-local-face-v2-preview.png')
  const observed = await inspectA8B6LocalCompositePixelsV2(base,
    output, report.polygons)
  assert.deepEqual(observed, { changedPixels: 13206,
    outsideAllowedChangedPixels: 0,
    changedBounds: { minX: 1009, minY: 104, maxX: 1143, maxY: 248 } })
  const raw = await sharp(output).removeAlpha().raw().toBuffer()
  const tampered = Buffer.from(raw)
  tampered[(400 * 1536 + 400) * 3] ^= 1
  const bytes = await sharp(tampered, { raw: { width: 1536,
    height: 864, channels: 3 } }).png().toBuffer()
  await assert.rejects(inspectA8B6LocalCompositePixelsV2(base,
    bytes, report.polygons), /outside the face polygons/)
})

test('v2 local child cannot enter paid A while independent review rejects', () => {
  const receipt = { target: { executionId: 'record-v2' },
    output: { url: '/generated/new.png', sha256: 'a'.repeat(64) } }
  const execution = { id: 'record-v2', sceneCutA8B6LocalFrameRecovery: {
    version: 'scene-cut-a8b6-local-first-frame-v2',
    sourceReceiptSha256: 'b'.repeat(64) }, nodeRuns: Array.from(
    { length: 51 }, () => ({ status: 'idle' })) }
  execution.nodeRuns[45] = { status: 'success',
    output: { url: receipt.output.url,
      sourceBoundLocalComposite: { sourceReceiptSha256: 'b'.repeat(64) } } }
  execution.nodeRuns[48] = { status: 'success' }
  execution.nodeRuns[49] = { status: 'success',
    output: { passed: false, issues: ['identity'] } }
  assert.throws(() => assertA8B6LocalCompositeWorkflowResultV2({
    receipt, receiptSha256: 'b'.repeat(64), execution,
    imageLedgers: [], reviewLedgerCount: 1,
    frameCertificateSha256: 'c'.repeat(64) }), /independent review/)
})
