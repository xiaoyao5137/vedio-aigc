import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  assertFailedReviewReceipt,
  assertImageBytes,
} from '../scripts/fork-original-shot1-image-retry-v4.mjs'

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const byteSha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

test('new-image retry retains a rejected review with an exact image and output digest', () => {
  const url = '/generated/original-v3.png'
  const output = { passed: false, issues: [{ code: 'WARDROBE_HEM_MISMATCH' }],
    frame: { sourceUrl: url }, raw: { decision: 'revise' } }
  const run = { node: { id: 'sanguo-scene-cut-review' }, status: 'success', output }
  assert.equal(assertFailedReviewReceipt(run, url, sha256(output)), sha256(output))
  assert.throws(() => assertFailedReviewReceipt({ ...run, output: { ...output, passed: true } }, url, sha256(output)), /review receipt changed/)
  assert.throws(() => assertFailedReviewReceipt({ ...run, output: { ...output, raw: { decision: 'pass' } } }, url, sha256(output)), /review receipt changed/)
  assert.throws(() => assertFailedReviewReceipt(run, '/generated/other.png', sha256(output)), /review receipt changed/)
})

test('new-image retry checks the failed parent image bytes before making a new record', () => {
  const image = Buffer.from('existing paid image bytes')
  assert.equal(assertImageBytes(image, byteSha256(image)), byteSha256(image))
  assert.throws(() => assertImageBytes(Buffer.from('different'), byteSha256(image)), /image bytes differ/)
  assert.throws(() => assertImageBytes(Buffer.alloc(0), byteSha256(image)), /image bytes differ/)
})
