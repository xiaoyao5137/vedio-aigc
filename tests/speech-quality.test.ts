import test from 'node:test'
import assert from 'node:assert/strict'
import { enforceSceneCutDialogueTail, validateSpeechEvidence } from '../server/speech-quality.ts'
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

test('scene-cut dialogue requires the full scripted 0.5 second tail using every ASR end bound', () => {
  const speech = { passed: true, dialogueCompletenessVerified: true, issues: [], lastSpeechEnd: 9.48,
    alignment: [{ actualEnd: 9.48, matchedEnd: 9.49, utteranceCandidateEnd: 9.49,
      endBoundaryRange: { upper: 9.51 } }] }
  const short = enforceSceneCutDialogueTail(speech, 9.5)
  assert.equal(short.passed, false)
  assert.equal(short.dialogueCompletenessVerified, false)
  assert.equal(short.sceneCutDialogueTail.observedEndUpper, 9.51)
  assert.match(short.issues.at(-1)!, /超过脚本最晚发声/)
  const complete = enforceSceneCutDialogueTail({ ...speech,
    alignment: [{ ...speech.alignment[0], endBoundaryRange: { upper: 9.5 } }] }, 9.5)
  assert.equal(complete.passed, true)
  assert.equal(complete.sceneCutDialogueTail.observedEndUpper, 9.5)
  assert.equal(complete.sceneCutDialogueTail.withinReserve, true)
  const missing = enforceSceneCutDialogueTail({ ...speech,
    alignment: [{ ...speech.alignment[0], endBoundaryRange: undefined }] }, 9.5)
  assert.equal(missing.passed, false)
  assert.match(missing.issues.at(-1)!, /缺少可靠证据/)
})
