import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateHistoricalStoryboard, repairStoryboardSplitCoverageMetadata } from '../src/storyboard-runtime.ts'
import { validateDramaStoryboardAllocation } from '../src/history-drama.ts'

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/storyboard-observable-only-split.json', import.meta.url), 'utf8'))

test('approved observable-only visual is removed only from mustShow metadata, retaining the real authored action', () => {
  const { candidate, expected } = fixture(), before = structuredClone(candidate)
  const repaired = repairStoryboardSplitCoverageMetadata(candidate, expected)!
  assert.deepEqual(repaired.candidate.segments[0].beatCoverage[0].anchors, ['百姓围坐', '低声传唱'])
  assert.deepEqual(repaired.candidate.segments[0].beatDramaturgy, candidate.segments[0].beatDramaturgy)
  assert.deepEqual(repaired.candidate.segments[0].pacing, candidate.segments[0].pacing)
  assert.match(JSON.stringify(repaired.candidate.segments[0].pacing.beats), /四下张望/)
  assert.deepEqual(candidate, before)
  assert.throws(() => validateDramaStoryboardAllocation(repaired.candidate.segments, expected.scene), /audio.*遗漏、重复/,
    'normalization must not hide the original repeated-audio quality defect')
})

test('observable-only action segment may have empty mustShow allocation while retaining its separate visual obligation', () => {
  const { candidate, expected } = fixture()
  candidate.segments[0].beatCoverage[0].anchors = ['百姓围坐', '低声传唱']
  candidate.segments[0].beatDramaturgy[0].visual = ['百姓围坐', '低声传唱']
  candidate.segments[1].beatCoverage[0].anchors = ['四下张望']
  candidate.segments[1].beatDramaturgy[0].visual = ['有人四下张望确认安全']
  const repaired = repairStoryboardSplitCoverageMetadata(candidate, expected)!
  assert.deepEqual(repaired.candidate.segments[1].beatCoverage[0].anchors, [])
  assert.deepEqual(repaired.candidate.segments[1].beatDramaturgy, candidate.segments[1].beatDramaturgy)
})

test('metadata correction cannot discard unknown actions, wrong beat identity or undeclared visual obligations', () => {
  for (const change of ['unknown', 'wrong-beat', 'missing-declaration']) {
    const { candidate, expected } = fixture()
    if (change === 'unknown') candidate.segments[0].beatCoverage[0].anchors.push('官兵闯入')
    if (change === 'wrong-beat') candidate.segments[0].beatCoverage[0].beatId = 'already-completed-beat'
    if (change === 'missing-declaration') candidate.segments[0].beatDramaturgy[0].visual = ['百姓围坐', '低声传唱']
    assert.equal(repairStoryboardSplitCoverageMetadata(candidate, expected), undefined, change)
  }
})

test('original failed provider split passes the executable contract without another provider call and retains quality warnings', async () => {
  const { candidate, expected } = fixture(), before = structuredClone(candidate)
  const result = await generateHistoricalStoryboard({ prompt: 'saved provider replay', expected, initialCandidate: candidate,
    canGenerate: () => false, generate: async () => { assert.fail('saved candidate recovery must not buy another generation') } })
  const segments = result.__storyboardSegments as Array<Record<string, unknown>>
  assert.equal(segments.length, 2)
  assert.ok(segments.every(segment => Number(segment.duration) <= 15 && segment.scheduleHash))
  assert.ok(segments.some(segment => JSON.stringify(segment.qualityWarnings).includes('重复')))
  assert.ok(segments.some(segment => JSON.stringify(segment.beatDramaturgy).includes('四下张望')))
  assert.deepEqual(candidate, before)
})
