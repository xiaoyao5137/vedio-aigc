import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveFirstFramePrompt } from '../server/builtin-nodes.ts'

test('first-frame prompt falls back to the explicit node parameter', () => {
  assert.equal(resolveFirstFramePrompt({ prompt: '', params: { firstFramePrompt: '东汉村落稳定首帧' } }), '东汉村落稳定首帧')
  assert.equal(resolveFirstFramePrompt({ prompt: '插值后的首帧', params: { firstFramePrompt: '参数首帧' } }), '插值后的首帧')
  assert.equal(resolveFirstFramePrompt({ prompt: '', params: {} }), '')
})
