import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectHistoricalStoryboardDiagnostics, validateHistoricalStructuredOutput, buildStoryboardRepairSuffix, reconcileStoryboardPacingBudget } from '../src/workflow-core.ts'
import { generateHistoricalStoryboard } from '../src/storyboard-runtime.ts'
import { StoryboardCandidateValidationError } from '../src/storyboard-generation-error.ts'
import { parseStoryboardTimeline } from '../src/storyboard-timeline.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/storyboard-psw369.json', import.meta.url), 'utf8'))
const expected = fixture.expected
const repairedGap = () => ({ ...structuredClone(fixture.candidates[4]),
  videoPrompt: fixture.candidates[4].videoPrompt.replace('0.0-1.0秒:', '0.0-1.5秒:') })

test('the five archived candidates expose the actual gap instead of asking the writer to reformat valid time units', () => {
  const before = JSON.stringify(fixture)
  for (const candidate of fixture.candidates) {
    const errors = collectHistoricalStoryboardDiagnostics(candidate, expected).join('\n')
    assert.match(errors, /1–1.5秒缺口（0.5秒）/)
    assert.doesNotMatch(errors, /识别到 0 段/)
  }
  assert.equal(JSON.stringify(fixture), before)
})

test('closing the archived gap accepts the complete narration without purchasing a posture rewrite', async () => {
  const candidate = repairedGap()
  const before = JSON.stringify(candidate)
  let calls = 0
  const result = await generateHistoricalStoryboard({ prompt: '保留原剧情', initialCandidate: candidate, expected,
    generate: async () => { calls++; throw Error('should not generate') } })
  assert.equal(calls, 0)
  assert.equal(result.audioText, fixture.candidates[4].audioText)
  assert.deepEqual(result.worldState, candidate.worldState)
  assert.deepEqual(result.beatDramaturgy, candidate.beatDramaturgy)
  assert.deepEqual(collectHistoricalStoryboardDiagnostics(candidate, expected), [])
  const audit = result.scriptValidation as { passed: boolean; warnings: Array<{code: string}> }
  assert.equal(audit.passed, true)
  assert.ok(audit.warnings.some(item => item.code === 'STORYBOARD_HOLD_ADVICE'))
  assert.equal(JSON.stringify(candidate), before)
})

test('segment count and the 650 character preference are recorded without becoming rejection reasons', async () => {
  const candidate = repairedGap()
  const bodies = parseStoryboardTimeline(candidate.videoPrompt).map(range => range.body).join('')
  candidate.videoPrompt = `0秒-9秒：${bodies}${'自然光照在厅堂木柱上。'.repeat(65)}`
  const result = await generateHistoricalStoryboard({ prompt: '保留正文', initialCandidate: candidate, expected,
    generate: async () => { throw Error('advice must not trigger generation') } })
  const audit = result.scriptValidation as { passed: boolean; warnings: Array<{code: string}> }
  assert.equal(audit.passed, true)
  for (const code of ['STORYBOARD_PROMPT_LENGTH_ADVICE', 'STORYBOARD_SEGMENT_COUNT_ADVICE']) assert.ok(audit.warnings.some(row => row.code === code))
  assert.equal(result.audioText, candidate.audioText)
})

test('hard obligations still reject missing story, fabricated observations, overlap and excessive duration', () => {
  const candidate = repairedGap()
  const invalid = [
    { ...candidate, audioText: '' },
    { ...candidate, coveredBeatIds: [] },
    { ...candidate, worldState: fixture.candidates[0].worldState },
    { ...candidate, videoPrompt: candidate.videoPrompt.replace('1.5-7.38秒', '1.4-7.38秒') },
    { ...candidate, duration: 16 },
  ]
  for (const value of invalid) assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', value, expected))
})

test('window arithmetic and timeline defects receive independent repair instructions without invented dead air', () => {
  const errors = collectHistoricalStoryboardDiagnostics(fixture.candidates[1], expected).join('\n')
  const suffix = buildStoryboardRepairSuffix(errors, fixture.candidates[1], '修复')
  assert.match(suffix, /时间预算：/)
  assert.match(suffix, /时间轴：/)
  assert.match(suffix, /1–1.5秒缺口/)
  assert.doesNotMatch(suffix.split('【上一版')[0], /缩短无对白的空等/)
})

test('the shared writer budget stops with actual diagnostics before another call is purchased', async () => {
  let calls = 0
  await assert.rejects(generateHistoricalStoryboard({ prompt: '保留原文', expected,
    initialCandidate: fixture.candidates[4], canGenerate: () => false,
    generate: async () => { calls++; throw Error('budget should stop before generate') } }), /1–1.5秒缺口/)
  assert.equal(calls, 0)
})

test('an exhausted split budget retains the parent overflow instead of reporting an empty child failure', async () => {
  const candidate = repairedGap()
  candidate.audioText = candidate.audioText.repeat(4)
  candidate.pacing = { version: 'dynamic-v1', actionSeconds: 1, reactionSeconds: 0.7 }
  await assert.rejects(generateHistoricalStoryboard({ prompt: '保留原文', expected, initialCandidate: candidate,
    canGenerate: () => false, generate: async () => { throw Error('must not generate') } }), error => {
    assert.ok(error instanceof StoryboardCandidateValidationError)
    assert.match(String(error), /STORYBOARD_TIMING_OVERFLOW/)
    assert.equal(error.attempts.length, 1, 'the complete parent candidate must be checked even with no paid budget')
    assert.equal(error.generationAttempts, 0, 'preflight does not buy a writer request')
    assert.doesNotMatch(String(error), /分镜分段修复未通过/)
    return true
  })
})

test('a transport failure on the last generation retains both the HTTP error and previous timeline defect', async () => {
  let calls = 0
  await assert.rejects(generateHistoricalStoryboard({ prompt: '保留原文', expected, initialCandidate: fixture.candidates[4],
    canGenerate: () => calls < 1,
    generate: async () => { calls++; throw Error('HTTP 503 upstream overloaded') } }), error => {
    assert.match(String(error), /HTTP 503/)
    assert.match(String(error), /1–1.5秒缺口/)
    assert.doesNotMatch(String(error), /DRAMA_GENERATION_LIMIT/)
    return true
  })
  assert.equal(calls, 1)
})

test('clock stretching cannot erase an original timeline gap', () => {
  const candidate = structuredClone(fixture.candidates[1])
  candidate.duration = 7
  assert.equal(reconcileStoryboardPacingBudget(candidate), undefined)
})

test('bracketed timeline headers retain editorial advice', async () => {
  const candidate = repairedGap()
  candidate.videoPrompt = candidate.videoPrompt.replace('0.0-1.5秒:', '【0.0秒-1.5秒】：')
  const result = await generateHistoricalStoryboard({ prompt: '保留原文', expected, initialCandidate: candidate,
    generate: async () => { throw Error('should not generate') } })
  assert.ok((result.scriptValidation as { warnings: Array<{code: string}> }).warnings.some(row => row.code === 'STORYBOARD_HOLD_ADVICE'))
})
