import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DramaOutlineIssuesError, validateDramaOutline } from '../src/history-drama.ts'
import { buildSceneOutlineRepairSuffix, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-cross-stage-outline-candidates.json', import.meta.url), 'utf8'))
const validate = (candidate: Record<string, unknown>, expected = fixture.expected) =>
  validateHistoricalStructuredOutput('history.scene-outline', candidate, expected)
const candidate = (index = 0) => structuredClone(fixture.candidates[index].candidate)
const missingSource = /scenes\[6\]\.historicalBasis 必须包含 \[史料N\] 引用/

function sourceBackedCorrection() {
  const repaired = candidate(1)
  repaired.scenes[6].historicalBasis = '[史料2] 支持张角以符水疗病及遣八弟子；行走、路线与傍晚调度为拟制，不冒充史载细节。'
  return repaired
}

test('the real first candidate reports drama and previously hidden citation defects in one repair round', () => {
  const first = candidate(), snapshot = JSON.stringify(first)
  assert.throws(() => validate(first), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /scenes\[0\]\.contextPayload\.narration 共71个汉字/)
    assert.match(error.message, /episodeDrama\.payoff\.beatIds 引用不存在的 beat-31/)
    assert.match(error.message, /episodeDrama\.payoff 必须落实在结尾完整戏/)
    assert.match(error.message, missingSource)
    const instructions = buildSceneOutlineRepairSuffix('原始指令', error.message, first)
      .split('【上一版未通过的 JSON】\n')[0]
    assert.match(instructions, /historicalLocks\[\]\.fact\/sourceRefs 及提供的史料正文/)
    assert.match(instructions, /不能复制其他场景引用来凑格式/)
    assert.match(instructions, /不能把拟制行走、调度细节谎称史载/)
    assert.match(instructions, /有实际史事却缺依据时保留缺陷/)
    return true
  })
  assert.equal(JSON.stringify(first), snapshot)
  assert.equal(first.scenes[6].historicalBasis, candidate(1).scenes[6].historicalBasis,
    'the second candidate did not introduce the hidden source defect')
})

test('the actual second candidate still rejects its source gap while an existing source-backed correction passes', () => {
  assert.throws(() => validate(candidate(1)), missingSource)
  const repaired = sourceBackedCorrection(), snapshot = JSON.stringify(repaired)
  const accepted = validate(repaired) as typeof repaired
  assert.equal(JSON.stringify(repaired), snapshot)
  assert.deepEqual(accepted.scenes.map((scene: typeof repaired.scenes[0]) => scene.requiredBeats),
    repaired.scenes.map((scene: typeof repaired.scenes[0]) => scene.requiredBeats))
  assert.equal(accepted.scenes[6].historicalBasis, repaired.scenes[6].historicalBasis)
  assert.deepEqual(validate(accepted), accepted, 'a valid normalized outline is stable on repeated validation')
})

test('multiple missing source and independent schema fields remain visible beside drama defects', () => {
  const first = candidate()
  first.scenes[1].historicalBasis = ''
  delete first.scenes[2].historicalBasis
  first.scenes[3].historicalBasis = '尚无依据的史事'
  first.scenes[4].title = ''
  first.scenes[5].adaptationBoundary = ''
  assert.throws(() => validate(first), error => {
    assert.ok(error instanceof Error)
    for (const path of ['scenes[1].historicalBasis', 'scenes[2].historicalBasis', 'scenes[3].historicalBasis',
      'scenes[6].historicalBasis', 'scenes[4].title', 'scenes[5].adaptationBoundary']) assert.ok(error.message.includes(path), path)
    assert.match(error.message, /episodeDrama\.payoff\.beatIds 引用不存在的 beat-31/)
    return true
  })
})

test('formatted but nonexistent source references fail with trusted sources and aggregate with drama defects', () => {
  const first = candidate()
  first.scenes[6].historicalBasis = '[史料999] 调度为拟制'
  assert.throws(() => validate(first), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /scenes\[6\]\.historicalBasis 引用不存在的 \[史料999\]/)
    assert.match(error.message, /episodeDrama\.payoff\.beatIds 引用不存在的 beat-31/)
    return true
  })
  const corrected = sourceBackedCorrection()
  assert.doesNotThrow(() => validate(corrected))
  corrected.scenes[6].historicalBasis = '[史料999] 调度为拟制'
  const withoutSources = { ...fixture.expected }
  delete withoutSources.historicalSources
  assert.doesNotThrow(() => validate(corrected, withoutSources), 'calls without trusted sources retain the prior compatible behavior')
  assert.throws(() => validate(corrected, { ...withoutSources, sourceRefs: ['[史料1]', '[史料2]', '[史料3]', '[史料4]', '[史料5]', '[史料6]'] }),
    /historicalBasis 引用不存在的 \[史料999\]/)
})

test('malformed containers, duplicate identities and unknown drama ownership still stop the safe traversal', () => {
  const changes = [
    (outline: ReturnType<typeof candidate>) => { outline.scenes = null },
    (outline: ReturnType<typeof candidate>) => { outline.scenes[1] = null },
    (outline: ReturnType<typeof candidate>) => { outline.scenes[1].requiredBeats = null },
    (outline: ReturnType<typeof candidate>) => { outline.scenes[1].requiredBeats[0].observable = [] },
    (outline: ReturnType<typeof candidate>) => { outline.scenes[1].id = outline.scenes[0].id },
    (outline: ReturnType<typeof candidate>) => { outline.scenes[1].requiredBeats[0].id = outline.scenes[0].requiredBeats[0].id },
    (outline: ReturnType<typeof candidate>) => { outline.scenes[1].dramaticSceneId = 'missing-drama' },
  ]
  for (const change of changes) {
    const first = candidate(); change(first)
    for (const check of [() => validateDramaOutline(first, fixture.expected), () => validate(first)]) assert.throws(check, error => {
      assert.ok(error instanceof Error)
      assert.ok(!(error instanceof DramaOutlineIssuesError), 'fatal traversal errors cannot expose a normalized candidate for further checks')
      assert.doesNotMatch(error.message, missingSource, 'no fabricated placeholder permits later source traversal')
      return true
    })
  }
  const extra = candidate(); extra.scenes[1].requiredBeats[0].undeclared = true
  assert.throws(() => validate(extra), /requiredBeats\[0\].*包含未声明字段/)
})

test('the pure environmental transition exception retains its original conditions', () => {
  const corrected = sourceBackedCorrection()
  corrected.scenes[6].historicalBasis = '无具体史料，为电影转场语法'
  assert.doesNotThrow(() => validate(corrected))
  for (const role of ['story', 'episode_opening']) {
    const first = structuredClone(corrected); first.scenes[6].editorialRole = role
    assert.throws(() => validate(first), missingSource)
  }
  corrected.scenes[6].historicalBasis = '尚无依据的史事'
  assert.throws(() => validate(corrected), missingSource)
})
