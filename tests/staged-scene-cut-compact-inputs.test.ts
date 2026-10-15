import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { COMPACT_INPUT_LIMITS, deriveCompactInputs, saveCompactInputs,
  verifyCompactInputs, COMPACT_RETAKE_INPUT_LIMITS,
  deriveCompactInputsWithEndFrame, saveCompactInputsWithEndFrame,
  verifyCompactInputsWithEndFrame } from
  '../server/staged-scene-cut-compact-inputs.mjs'
import { previewFreshA8B6PhaseARetake } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { stagePrompt, stageReviewPrompt } from '../server/staged-scene-cut.mjs'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function sourcePng(width: number, height: number,
  transparent = false, seed = 0) {
  const bytes = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    bytes[offset] = (x >> 3) % 256
    bytes[offset + 1] = (y >> 2) % 256
    bytes[offset + 2] = ((x + y + seed) >> 3) % 256
    bytes[offset + 3] = transparent && x === 0 && y === 0 ? 0 : 255
  }
  return sharp(bytes, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

test('bounded JPEG transport keeps original source bytes and verifies decoded fidelity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'staged-compact-input-'))
  const generated = path.join(root, 'public/generated')
  mkdirSync(generated, { recursive: true })
  try {
    const assets = []
    for (const [role, width, height] of [
      ['first_frame', 1536, 864], ['identity_1', 1360, 768], ['identity_2', 1360, 768],
    ] as const) {
      const bytes = await sourcePng(width, height)
      const url = `/generated/${role}.png`
      writeFileSync(path.join(generated, `${role}.png`), bytes)
      assets.push({ role, url, sha256: sha256(bytes) })
    }
    const derived = await deriveCompactInputs(assets, root)
    assert.equal(derived.entries.length, 3)
    assert.ok(derived.totalBytes <= COMPACT_INPUT_LIMITS.total)
    for (const entry of derived.entries) {
      assert.equal(entry.transport.format, 'jpeg')
      assert.equal(entry.transport.width, entry.source.width)
      assert.equal(entry.transport.height, entry.source.height)
      assert.ok(entry.metrics.psnrDb >= (entry.role === 'first_frame' ? 40 : 42))
      assert.ok(entry.metrics.meanAbsoluteChannelDelta <= 2)
    }
    await saveCompactInputs(derived, derived.buffers, root)
    assert.equal(await verifyCompactInputs(derived, root), true)
    writeFileSync(path.join(generated, 'identity_1.png'), await sourcePng(1360, 768, true))
    await assert.rejects(verifyCompactInputs(derived, root), /approved source bytes changed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('compact fork keeps strict v3 action and independent review gates', () => {
  assert.equal(stagePrompt('A', 'early-binding-v3-compact1'), stagePrompt('A', 'early-binding-v3'))
  assert.equal(stagePrompt('B', 'early-binding-v3-compact1'), stagePrompt('B', 'early-binding-v3'))
  const evidence = { phase: 'A', videoSha256: 'a'.repeat(64), frames: [] }
  const prompt = stageReviewPrompt('A', evidence, 'early-binding-v3-compact1')
  assert.match(prompt, /guardsReleasedByFrame132/)
  assert.match(prompt, /stableBoundHoldFromFrame132Through180/)
  assert.match(prompt, /第192帧仅核余量，不得代替第180帧完成态/)
})

test('A retake keeps V9 first/identity JPEGs and binds a distinct end-frame JPEG', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'staged-compact-retake-'))
  const generated = path.join(root, 'public/generated')
  mkdirSync(generated, { recursive: true })
  try {
    const assets = []
    for (const [index, [role, width, height]] of ([
      ['first_frame', 1536, 864], ['identity_1', 1360, 768],
      ['identity_2', 1360, 768], ['end_frame', 1280, 720],
    ] as const).entries()) {
      const bytes = await sourcePng(width, height, false, index * 40)
      writeFileSync(path.join(generated, `${role}.png`), bytes)
      assets.push({ role, url: `/generated/${role}.png`, sha256: sha256(bytes) })
    }
    const old = await deriveCompactInputs(assets.slice(0, 3), root)
    const retake = await deriveCompactInputsWithEndFrame(assets, root)
    assert.deepEqual(retake.entries.slice(0, 3), old.entries)
    assert.equal(retake.entries[3].role, 'end_frame')
    assert.equal(retake.entries[3].source.sha256, assets[3].sha256)
    assert.ok(retake.totalBytes <= COMPACT_RETAKE_INPUT_LIMITS.total)
    await saveCompactInputsWithEndFrame(retake, retake.buffers, root)
    assert.equal(await verifyCompactInputsWithEndFrame(retake, root), true)
    const preview = previewFreshA8B6PhaseARetake(retake.buffers[0],
      retake.buffers.slice(1, 3), retake.buffers[3])
    assert.deepEqual(preview.imageTypes,
      ['reference', 'reference', 'first_frame', 'end_frame'])
    assert.equal(preview.endFrameTransportSha256,
      retake.entries[3].transport.sha256)
    assert.ok(preview.requestByteLength < 2_000_000)
    assert.equal(preview.request.sound, 'off')
    writeFileSync(path.join(generated, 'end_frame.png'),
      await sourcePng(1280, 720, true))
    await assert.rejects(verifyCompactInputsWithEndFrame(retake, root),
      /end_frame source bytes changed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
