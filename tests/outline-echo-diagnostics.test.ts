import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DramaOutlineIssuesError, normalizeDramaOutline, validateDramaOutline } from '../src/history-drama.ts'
import { buildSceneOutlineRepairSuffix, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-outline-echo-candidates.json', import.meta.url), 'utf8'))
const validFixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-environment-bridge-candidates.json', import.meta.url), 'utf8'))
const validate = (candidate: Record<string, unknown>, expected = fixture.expected) =>
  validateHistoricalStructuredOutput('history.scene-outline', candidate, expected)

test('the first real v56 candidate reports incorrect input echo and all independent drama/schema defects together', () => {
  const candidate = structuredClone(fixture.candidates[0].candidate), snapshot = JSON.stringify(candidate)
  assert.throws(() => validate(candidate), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /adaptationSpace\.policy 必须原样继承 input\.adaptation_policy/)
    assert.ok(error.message.includes(`权威输入原文=${JSON.stringify(fixture.expected.input.adaptation_policy)}`))
    assert.match(error.message, /scenes\[0\]\.contextPayload\.narration 共70个汉字/)
    assert.match(error.message, /scenes\[2\]\.beat-06\.setting/)
    for (const id of ['02', '03', '04', '05', '06']) assert.ok(error.message.includes(`dramaticScenes.drama-${id}.beatIds`), id)
    assert.match(error.message, /episodeDrama\.payoff 必须落实在结尾完整戏/)
    assert.match(error.message, /scenes\[2\]\.continuityFromPrevious/)
    const instructions = buildSceneOutlineRepairSuffix('原始指令', error.message, candidate)
      .split('【上一版未通过的 JSON】\n')[0]
    assert.match(instructions, /两项不能互换、概括或自行润色/)
    assert.match(instructions, /所有未被点名的 scene、完整戏、人物、节拍、历史锁和声画正文必须从上一版 JSON 原样保留/)
    assert.match(instructions, /先确认仍是同一连续时空/)
    assert.match(instructions, /不能仅机械替换为完整戏 setting/)
    return true
  })
  assert.equal(JSON.stringify(candidate), snapshot)
  const normalized = normalizeDramaOutline(candidate, fixture.expected)
  assert.deepEqual(normalized.adaptationSpace, candidate.adaptationSpace, 'non-equivalent input echo never gets silently overwritten')
})

test('the actual second candidate keeps rejecting the remaining capacity, setting, allocation and continuity gaps', () => {
  assert.throws(() => validate(fixture.candidates[1].candidate), error => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /adaptationSpace\.policy/)
    assert.match(error.message, /contextPayload\.narration 共70个汉字/)
    assert.match(error.message, /scenes\[2\]\.beat-06\.setting/)
    assert.match(error.message, /dramaticScenes\.drama-02\.beatIds/)
    assert.match(error.message, /dramaticScenes\.drama-03\.beatIds/)
    assert.match(error.message, /scenes\[2\]\.continuityFromPrevious/)
    return true
  })
})

test('both input echoes use their separate trusted originals and repair neither story nor provenance automatically', () => {
  const expected = validFixture.candidates[1].expected
  const candidate = structuredClone(validFixture.candidates[1].candidate)
  candidate.adaptationSpace.policy = expected.input.source_level
  candidate.adaptationSpace.sourceLevel = expected.input.adaptation_policy
  const snapshot = JSON.stringify(candidate)
  assert.throws(() => validate(candidate, expected), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /adaptationSpace\.policy 必须原样继承 input\.adaptation_policy/)
    assert.match(error.message, /adaptationSpace\.sourceLevel 必须原样继承 input\.source_level/)
    const prompt = buildSceneOutlineRepairSuffix('原始指令', error.message, candidate)
    assert.ok(prompt.includes(`权威输入原文=${JSON.stringify(expected.input.adaptation_policy)}`))
    assert.ok(prompt.includes(`权威输入原文=${JSON.stringify(expected.input.source_level)}`))
    assert.deepEqual(JSON.parse(prompt.split('【上一版未通过的 JSON】\n').at(-1)!), candidate)
    return true
  })
  assert.equal(JSON.stringify(candidate), snapshot)
  candidate.adaptationSpace.policy = expected.input.adaptation_policy
  candidate.adaptationSpace.sourceLevel = expected.input.source_level
  assert.doesNotThrow(() => validate(candidate, expected))
})

test('input echo aggregation still stops at malformed containers or mandatory empty strings', () => {
  for (const adaptationSpace of [null, [], { ...fixture.candidates[0].candidate.adaptationSpace, policy: '' }]) {
    const candidate = structuredClone(fixture.candidates[0].candidate)
    candidate.adaptationSpace = adaptationSpace
    assert.throws(() => validateDramaOutline(candidate, fixture.expected), error => {
      assert.ok(error instanceof Error)
      assert.ok(!(error instanceof DramaOutlineIssuesError))
      assert.doesNotMatch(error.message, /contextPayload\.narration/)
      return true
    })
  }
})
