import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { storyboardContinuityContract } from '../src/storyboard-continuity-contract.ts'
import { generateHistoricalStoryboard, storyboardDiagnostics } from '../src/storyboard-runtime.ts'
import { buildStoryboardRepairSuffix, storyboardDialogueScheduleHint } from '../src/workflow-core.ts'
import { DEFAULT_DURATION_POLICY } from '../src/duration-policy.ts'

const fixture = () => {
  const value = JSON.parse(readFileSync(new URL('./fixtures/storyboard-scene-boundary-failure.json', import.meta.url), 'utf8'))
  value.candidate.pacing.timingPolicy = DEFAULT_DURATION_POLICY
  value.params.timingPolicy = DEFAULT_DURATION_POLICY
  return value
}
const expectedFor = (data: ReturnType<typeof fixture>) => ({ ...data.params, scene: data.scene, previousShot: data.previous,
  requireContinuityContract: true, requireDynamicPacing: true, requireNarrativeClosure: true, requireDramaContract: true, productionSpeechRate: 4.5 })

test('actual sixth scene is a satisfiable new unit, not an upstream conflict requiring old media regeneration', () => {
  const data = fixture(), before = structuredClone(data)
  const contract = storyboardContinuityContract(data.scene, data.previous)
  assert.deepEqual(contract.allowedModes, ['scene_cut'])
  assert.equal(contract.firstFrameModes.scene_cut, 'reference')
  assert.equal(contract.bridgeTypes.scene_cut, 'cut')
  assert.equal(contract.openingEvidence, 'unknown-only')
  assert.deepEqual(data, before)
  const errors = storyboardDiagnostics(data.candidate, expectedFor(data))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /field=continuity.mode；expected=\["scene_cut"\]；candidate="coverage_cut"/)
  const corrected = structuredClone(data.candidate)
  corrected.continuity = { mode: 'scene_cut', previousShotId: data.previous.id, bridgeType: 'cut', bridgeAnchor: '承接前镜的认可，转入共同品评的邀请' }
  assert.deepEqual(storyboardDiagnostics(corrected, expectedFor(data)), [])
  assert.deepEqual(data, before, 'test repair must not change its immutable failure fixture')
})

test('first generation and every repair receive the approved source boundary, with no pacing-only repair for continuity', async () => {
  const data = fixture(), before = structuredClone(data)
  let calls = 0
  const result = await generateHistoricalStoryboard({ prompt: 'An old saved prompt with previous scene context', expected: expectedFor(data),
    generate: async prompt => {
      calls++
      assert.match(prompt, /本次权威连续性契约/)
      assert.match(prompt, /"allowedModes":\["scene_cut"\]/)
      assert.match(prompt, /修复范围包含候选continuity、firstFrameMode及开场状态/)
      assert.doesNotMatch(prompt, /【duration-v2 结构化重排】/)
      if (calls === 1) return structuredClone(data.candidate)
      assert.match(prompt, /scope=current-candidate/)
      const repaired = structuredClone(data.candidate)
      repaired.continuity = { mode: 'scene_cut', previousShotId: data.previous.id, bridgeType: 'cut', bridgeAnchor: '承接认可，转入共同品评的邀请' }
      return repaired
    },
  })
  assert.equal(calls, 2)
  assert.equal((result.continuity as { mode: string }).mode, 'scene_cut')
  assert.deepEqual(data, before)
})

test('contradictory approved upstream fields stop before any candidate request', async () => {
  const data = fixture()
  for (const scene of [
    { ...data.scene, continuityFromPrevious: false, continuityMode: 'coverage_cut' },
    { ...data.scene, continuityFromPrevious: true, continuityMode: 'scene_cut' },
    { ...data.scene, continuityFromPrevious: true, continuityMode: 'tail_continuation' },
  ]) {
    let calls = 0
    await assert.rejects(generateHistoricalStoryboard({ prompt: 'original', expected: { ...expectedFor(data), scene }, generate: async () => { calls++; return data.candidate } }), /STORYBOARD_INPUT_CONFLICT:.*scope=upstream/)
    assert.equal(calls, 0)
  }
})

test('same-unit continuation retains both allowed camera modes and legacy non-cinematic generation is unaffected', () => {
  const previous = { id: 'p', storyProgress: { unitId: 'u' }, worldState: { settingId: 's' } }
  const contract = storyboardContinuityContract({ id: 'next', continuityFromPrevious: true, continuityMode: 'coverage_cut', dramaticUnitId: 'u', settingId: 's' }, previous)
  assert.deepEqual(contract.allowedModes, ['tail_continuation', 'coverage_cut'])
  assert.equal(contract.openingEvidence, 'inherit-verified-tail-or-unknown')
  assert.throws(() => storyboardContinuityContract({ continuityFromPrevious: true, continuityMode: 'coverage_cut' }), /缺少 previousShot.id/)
})

test('continuity-only failures never request beat-only repair; actual pacing errors still receive timing guidance', () => {
  const data = fixture()
  const error = storyboardDiagnostics(data.candidate, expectedFor(data)).join('\n')
  const guidance = storyboardDialogueScheduleHint(data.candidate, 4.5, error)
  assert.ok(guidance.includes(error))
  assert.doesNotMatch(guidance, /duration-v2 结构化重排/)
  assert.match(storyboardDialogueScheduleHint(data.candidate, 4.5, 'STORYBOARD_PACING_INVALID: 时间窗超出预算'), /duration-v2 结构化重排/)
  assert.match(buildStoryboardRepairSuffix(error, data.candidate, 'repair', 'duration-v2'), /上一版未通过的 JSON/)
})
