import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSpeechEvidence } from '../server/speech-quality.ts'
const actual = { passed: false, phoneticErrorRate: 0, lastSpeechEnd: 11.96, alignment: [{ planned: { start: 2, end: 8, text: '朕即位以来，常念蠡吾受学之恩，今擢卿为尚书。' }, actualStart: 4.18, actualEnd: 11.96 }] }
test('real intact slower delivery proceeds to visual review with timing warnings', () => {
  const result = validateSpeechEvidence(actual, 1, 13.5)
  assert.equal(result.passed, true)
  assert.equal(result.warnings.length, 1)
  assert.equal(result.lipSyncVerified, false)
})
test('missing words, unreliable alignment, reversed dialogue and speech in tail still reject', () => {
  assert.equal(validateSpeechEvidence({ ...actual, phoneticErrorRate: 0.4 }, 1, 13.5).passed, false)
  assert.equal(validateSpeechEvidence(actual, 2, 13.5).passed, false)
  assert.equal(validateSpeechEvidence({ ...actual, lastSpeechEnd: 14.1 }, 1, 13.5).passed, false)
  assert.equal(validateSpeechEvidence({ ...actual, alignment: [...actual.alignment, { actualStart: 3, actualEnd: 5 }] }, 2, 13.5).passed, false)
})
