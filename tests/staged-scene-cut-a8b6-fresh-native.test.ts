import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertFreshA8B6FrameMapping,
  parseFreshNativeFrameMd5 } from '../server/staged-scene-cut-a8b6-fresh-native.mjs'

function sample(count: number) {
  return [
    '#format: frame checksums', '#version: 2', '#hash: MD5',
    '#tb 0: 1/24', '#media_type 0: video', '#dimensions 0: 1280x720',
    ...Array.from({ length: count }, (_, index) =>
      `0, ${index}, ${index}, 1, 1382400, ${index.toString(16).padStart(32, '0')}`),
  ].join('\n')
}

test('native parser retains every original-speed PTS and rejects a missing frame', () => {
  const a = parseFreshNativeFrameMd5(sample(193))
  assert.equal(a.frameCount, 193)
  assert.equal(a.lastPts, 8)
  assert.equal(a.lastFrameIndex, 192)
  assert.throws(() => parseFreshNativeFrameMd5(sample(4).replace('0, 2, 2,', '0, 2, 4,')),
    /discontinuous/)
})

test('frame mapping derives actual 14s count and forbids shortened or retimed cut', () => {
  const a = parseFreshNativeFrameMd5(sample(193))
  const b = parseFreshNativeFrameMd5(sample(145))
  const mapping = assertFreshA8B6FrameMapping(a, b,
    { acceptedAEndFrameIndex: 192, acceptedBEndFrameIndex: 144 })
  assert.equal(mapping.frameCount, 337)
  assert.equal(mapping.lastPts, 14)
  assert.equal(mapping.phaseB.outputFirstFrameIndex, 193)
  assert.throws(() => assertFreshA8B6FrameMapping(a, b,
    { acceptedAEndFrameIndex: 180, acceptedBEndFrameIndex: 144 }),
  /absent or out of range/)
  assert.throws(() => assertFreshA8B6FrameMapping(
    parseFreshNativeFrameMd5(sample(194)), b,
    { acceptedAEndFrameIndex: 192, acceptedBEndFrameIndex: 144 }),
  /absent or out of range/)
})

test('one-frame native variation derives a 338-frame cut from actual PTS', () => {
  const a = parseFreshNativeFrameMd5(sample(193))
  const b = parseFreshNativeFrameMd5(sample(146))
  const mapping = assertFreshA8B6FrameMapping(a, b,
    { acceptedAEndFrameIndex: 192, acceptedBEndFrameIndex: 145 })
  assert.equal(mapping.frameCount, 338)
  assert.equal(mapping.phaseA.acceptedTailPts, 8)
  assert.equal(mapping.phaseB.acceptedTailPts, 145 / 24)
  assert.equal(mapping.lastPts, 337 / 24)
})

test('two one-frame-short native takes keep every frame at original speed', () => {
  const a = parseFreshNativeFrameMd5(sample(192))
  const b = parseFreshNativeFrameMd5(sample(144))
  const mapping = assertFreshA8B6FrameMapping(a, b,
    { acceptedAEndFrameIndex: 191, acceptedBEndFrameIndex: 143 })
  assert.equal(mapping.frameCount, 335)
  assert.equal(mapping.lastPts, 334 / 24)
  assert.equal(mapping.phaseB.outputFirstFrameIndex, 192)
  assert.equal(mapping.phaseB.outputLastFrameIndex, 334)
})

test('two one-frame-long native takes keep every frame at original speed', () => {
  const a = parseFreshNativeFrameMd5(sample(194))
  const b = parseFreshNativeFrameMd5(sample(146))
  const mapping = assertFreshA8B6FrameMapping(a, b,
    { acceptedAEndFrameIndex: 193, acceptedBEndFrameIndex: 145 })
  assert.equal(mapping.frameCount, 339)
  assert.equal(mapping.lastPts, 338 / 24)
})
