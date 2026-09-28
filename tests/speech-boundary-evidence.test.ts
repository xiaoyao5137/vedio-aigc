import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { speechMetrics } from '../server/speech-metrics.ts'
import { validateSpeechEvidence } from '../server/speech-quality.ts'

const complete = { planned: { text: '甲乙丙', start: 0, end: 3 }, actualStart: 0, actualEnd: 3,
  matchedStart: 0, matchedEnd: 3, firstTokenMatched: true, lastTokenMatched: true,
  boundaryEvidenceVersion: 2, boundaryStatus: 'reliable', boundaryUncertaintyReasons: [],
  utteranceCandidateStart: 0, utteranceCandidateEnd: 3, alignmentCoverage: 1 }
const evidence = { alignmentVersion: 2, phoneticErrorRate: 0, lastSpeechEnd: 3, alignment: [complete] }

test('pure Python boundary regressions run without loading Whisper', () => {
  const result = spawnSync('python3', [new URL('./speech_boundaries_test.py', import.meta.url).pathname], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
})

test('pure Python pronunciation metadata never equates dictionary text tones with measured audio', () => {
  const result = spawnSync('python3', [new URL('./speech_pronunciation_test.py', import.meta.url).pathname], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
})

test('complete matched boundaries support duration observations and dialogue verification', () => {
  const [metric] = speechMetrics([complete])
  assert.equal(metric.timingReliable, true)
  assert.equal(metric.charactersPerSecond, 1)
  const validation = validateSpeechEvidence(evidence, 1, 4)
  assert.equal(validation.passed, true)
  assert.equal(validation.dialogueCompletenessVerified, true)
})

test('unmatched final phoneme cannot establish a natural full-utterance rate', () => {
  const row = { ...complete, actualEnd: 2, matchedEnd: 2, lastTokenMatched: false, alignmentCoverage: 2 / 3,
    boundaryStatus: 'uncertain', endBoundaryRange: { lower: 2, upper: 3 }, boundaryUncertaintyReasons: ['last-token-unmatched'],
    rawUtteranceCandidate: { text: '甲乙错', end: 3, attribution: 'unverified-ASR-candidate' } }
  const [metric] = speechMetrics([row])
  assert.equal(metric.elapsed, 2)
  assert.equal(metric.utteranceCandidateEnd, 3)
  assert.equal(metric.charactersPerSecond, null)
  assert.equal(metric.timingAssessment, 'uncertain')
  assert.equal(metric.timingReliable, false)
  assert.deepEqual(metric.rawUtteranceCandidate, row.rawUtteranceCandidate)
  const validation = validateSpeechEvidence({ ...evidence, alignment: [row] }, 1, 4)
  assert.equal(validation.passed, false)
  assert.equal(validation.dialogueCompletenessVerified, false)
  assert.match(validation.issues.join(' '), /复核同一素材/)
})

test('legacy actual 4.99 end stays readable but cannot prove reliable completion under v2', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/speech-latest-boundaries.json', import.meta.url), 'utf8'))
  const old = fixture.legacySpeechValidation
  const [metric] = speechMetrics(old.alignment)
  assert.equal(metric.actualEnd, 4.99)
  assert.equal(metric.elapsed, 4.62)
  assert.equal(metric.timingAssessment, 'uncertain')
  assert.equal(metric.charactersPerSecond, null)
  const validation = validateSpeechEvidence(old, 1, 5.7, { requireReliableBoundaries: true })
  assert.equal(validation.passed, false)
  assert.equal(validation.dialogueCompletenessVerified, false)
})

test('a reliable label cannot override absent edge matches or invalid timestamps', () => {
  for (const row of [{ ...complete, lastTokenMatched: false }, { ...complete, actualEnd: null, matchedEnd: null },
    { ...complete, boundaryUncertaintyReasons: ['segment-word-end-disagreement'] }]) {
    assert.equal(speechMetrics([row])[0].timingReliable, false)
    assert.equal(validateSpeechEvidence({ ...evidence, alignment: [row] }, 1, 4).passed, false)
  }
})
