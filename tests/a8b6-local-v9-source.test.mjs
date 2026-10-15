import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { renderA8B6LocalFirstFrameV9 } from
  '../server/staged-scene-cut-a8b6-local-pixels-v9.mjs'
import { inspectA8B6LocalCompositePixelsV9 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v9.mjs'
import { A8B6_LOCAL_V9_REJECTED_V8,
  assertA8B6LocalV9RejectedV8State } from
  '../server/staged-scene-cut-a8b6-local-v9-rejected-ancestry.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('V9 changes only the extreme-right timber band of the rejected V8 image',
  async () => {
    const selected = await renderA8B6LocalFirstFrameV9()
    const base = await sharp(await readFile(
      'public/generated/image-8149dea0eb98744508ac0615d37d70dc.png'))
      .removeAlpha().raw().toBuffer()
    const output = await sharp(selected.pngBytes).removeAlpha().raw().toBuffer()
    assert.equal(sha(selected.pngBytes),
      '683f51931e8e02325c22d594a1af007019471bc46532d10deaba70b47d57ee04')
    assert.deepEqual(selected.pixelProof, {
      changedPixels: 11727, outsideAllowedChangedPixels: 0,
      changedBounds: { minX: 1491, minY: 0, maxX: 1535, maxY: 296 },
    })
    const basePng = await readFile(
      'public/generated/image-8149dea0eb98744508ac0615d37d70dc.png')
    assert.deepEqual(await inspectA8B6LocalCompositePixelsV9(basePng,
      selected.pngBytes, selected.allowedRegions), selected.pixelProof)
    for (let y = 0; y < 864; y++) for (let x = 0; x < 1536; x++) {
      if (x >= 1491 && y <= 296) continue
      const at = (y * 1536 + x) * 3
      assert.equal(output[at], base[at])
      assert.equal(output[at + 1], base[at + 1])
      assert.equal(output[at + 2], base[at + 2])
    }
    const tampered = Buffer.from(output)
    tampered[(500 * 1536 + 500) * 3] ^= 1
    const tamperedPng = await sharp(tampered,
      { raw: { width: 1536, height: 864, channels: 3 } }).png().toBuffer()
    await assert.rejects(() => inspectA8B6LocalCompositePixelsV9(basePng,
      tamperedPng, selected.allowedRegions),
    /pixels changed outside signed ROI/)
  })

test('V9 cannot promote V8 rejection or paid image history', async () => {
  const state = { id: A8B6_LOCAL_V9_REJECTED_V8.executionId,
    nodeRuns: Array.from({ length: 51 }, () => ({ status: 'idle' })) }
  state.nodeRuns[49] = { status: 'success', output: { passed: true } }
  state.nodeRuns[50] = { status: 'success', output: { passed: true } }
  await assert.rejects(() => assertA8B6LocalV9RejectedV8State(state,
    A8B6_LOCAL_V9_REJECTED_V8.resultMd5, {}, '', {}, [], []),
  /A8B6_LOCAL_V9_ANCESTRY_INVALID/)
})
