import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { A8B6_QA_MAPPING, mapA8B6QAFrame,
  readA8B6QAPlan, verifyA8B6CompositeReceiptSync } from
  '../server/staged-scene-cut-a8b6-qa.mjs'

const qaPlanId = 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'

test('14 second QA frame mapping preserves native source order without duplicate seam', () => {
  assert.deepEqual(A8B6_QA_MAPPING.phaseA,
    { sourceStartFrame: 0, sourceEndFrame: 192, outputStartFrame: 0, outputEndFrame: 192 })
  assert.deepEqual(A8B6_QA_MAPPING.phaseB,
    { sourceStartFrame: 1, sourceEndFrame: 144, outputStartFrame: 193, outputEndFrame: 336 })
  assert.deepEqual(mapA8B6QAFrame(192),
    { phase: 'A', sourceFrameIndex: 192, outputFrameIndex: 192 })
  assert.deepEqual(mapA8B6QAFrame(193),
    { phase: 'B', sourceFrameIndex: 1, outputFrameIndex: 193 })
  assert.deepEqual(mapA8B6QAFrame(336),
    { phase: 'B', sourceFrameIndex: 144, outputFrameIndex: 336 })
  assert.throws(() => mapA8B6QAFrame(337), /outside 14 second range/)
  assert.throws(() => mapA8B6QAFrame(-1), /outside 14 second range/)
})

test('a non-existent 14 second QA plan never admits a shot', async () => {
  await assert.rejects(
    readA8B6QAPlan('a'.repeat(64), path.join(process.cwd(), 'invalid-qa-root')),
    /ENOENT/)
})

test('signed QA source alone cannot admit a 14 second first shot',
  { skip: !existsSync(path.join(process.cwd(), '.runtime/staged-scene-cut-a8b6-qa',
    qaPlanId, 'manifest.json')) }, () => {
    const directory = path.join(process.cwd(), '.runtime/staged-scene-cut-a8b6-qa', qaPlanId)
    if (existsSync(path.join(directory, 'composite-receipt.json'))) {
      const verified = verifyA8B6CompositeReceiptSync(qaPlanId, process.cwd())
      assert.equal(verified.receipt.picture.frameCount, 337)
      assert.equal(verified.receipt.sources.phaseB.acceptedFrameIndex, 144)
    } else {
      assert.throws(() => verifyA8B6CompositeReceiptSync(qaPlanId, process.cwd()),
        /ENOENT|approval|review/)
    }
  })
