import test from 'node:test'
import assert from 'node:assert/strict'
import { newExecutionVoicePolicy, voicePolicyLabel } from '../src/voice-policy.ts'

test('new workflows default to strict; only explicit preview permits unlocked generation', () => {
  assert.equal(newExecutionVoicePolicy(undefined), 'strict')
  assert.equal(newExecutionVoicePolicy(null), 'strict')
  assert.equal(newExecutionVoicePolicy('preview'), 'preview')
  for (const value of ['', 'off', false, 'legacy', {}]) assert.throws(() => newExecutionVoicePolicy(value), /VOICE_BINDING_INVALID/)
  assert.match(voicePolicyLabel(undefined), /历史.*未锁定/)
  assert.match(voicePolicyLabel('preview'), /预览.*未锁定/)
  assert.match(voicePolicyLabel('strict'), /待听审/)
})
