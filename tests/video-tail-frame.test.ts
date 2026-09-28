import test from 'node:test'
import assert from 'node:assert/strict'
import { tailFrameSeekTime } from '../src/video-tail-frame.ts'

test('tail frame seek stays inside the final decodable portion of the video', () => {
  assert.equal(tailFrameSeekTime(15), 14.92)
  assert.equal(tailFrameSeekTime(0.1), 0.05)
  assert.throws(() => tailFrameSeekTime(0), /有效时长/)
})
