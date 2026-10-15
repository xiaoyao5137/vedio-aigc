import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { sourceVisualActions, executableVisualAction, readSourceVisualActions } from '../src/storyboard-visual-action.ts'
import { collectDurationCoverageDiagnostics, compileDurationSchedule, verifyDurationSchedule } from '../src/duration-schedule.ts'
import { validateHistoricalStructuredOutput, validateStoryboardBeatCoverage } from '../src/workflow-core.ts'
import { validateDramaStoryboard } from '../src/history-drama.ts'
import { normalizeRawStoryboardDurationCandidate } from '../src/storyboard-duration-normalization.ts'
import { prepareWorkflowMediaRequest, validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { DEFAULT_DURATION_POLICY } from '../src/duration-policy.ts'
import { assertVoiceObligationCoverage } from '../src/voice-obligation.ts'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/storyboard-d2l7fp-coverage.json', import.meta.url), 'utf8'))
const legacy = JSON.parse(fs.readFileSync(new URL('./fixtures/storyboard-v44-accepted-duration.json', import.meta.url), 'utf8'))
const scene = fixture.scene
const expected = { scene, pacingVersion: 'duration-v2', qualityMode: 'principle-v1', requireDramaContract: true,
  requireContinuityContract: true, requireNarrativeClosure: true }
const pair = ['甲', '乙']
const contract = sourceVisualActions(['两人相遇'], pair, ['两人在街市相遇'], '甘陵街市')[0]
const action = (text: string, actorIds = pair, kind = 'action') => ({ kind, actorIds, textOrVocalization: text })
function currentPolicyVariant(source: typeof scene) {
  const copy = structuredClone(source)
  copy.pacing.timingPolicy = DEFAULT_DURATION_POLICY
  return copy
}
function synchronizedVisualVariant(source: typeof scene) {
  // The historical drafts independently require retelling in action 02, yet
  // put the only spoken line after that action. Isolate visual-contract tests
  // using an explicit test-only synchronization edit, preserving every word,
  // actor and original candidate. No production normalization does this.
  const copy = currentPolicyVariant(source)
  const arrival = copy.pacing.beats.find(beat => beat.id === 'beat-001-01')
  const retelling = copy.pacing.beats.find(beat => beat.id === 'beat-001-02')
  const speech = copy.pacing.beats.find(beat => beat.id === 'beat-001-03')
  speech.dependsOn = speech.dependsOn.filter(id => id !== retelling.id)
  for (const visual of [arrival, retelling]) {
    visual.overlapAllowedWith = [...new Set([...visual.overlapAllowedWith, speech.id])]
    speech.overlapAllowedWith = [...new Set([...speech.overlapAllowedWith, visual.id])]
  }
  return normalizeRawStoryboardDurationCandidate(copy, { scene })?.candidate ?? copy
}
const candidate = () => synchronizedVisualVariant(fixture.rounds[19].candidate)
function playableVariant() {
  // Explicit test repair of unrelated metadata, never a production body rewrite.
  const raw = candidate()
  raw.initialCharacters = ['房氏宾客', '周氏门生']
  raw.enteringCharacters = []
  return raw
}

test('approved neutral adjuncts and named subjects preserve exact mutual actions', () => {
  for (const text of ['两人相遇', '两人在街市相遇', '甲与乙在街市相遇', '乙和甲在甘陵街市相遇', '双方在街市相遇，禁止闪现或切镜补人']) {
    assert.equal(executableVisualAction(contract, [action(text)]), true, text)
  }
  const holding = sourceVisualActions(['双方握手'], pair, ['两人各持木简在廊下握手'], '廊下')[0]
  assert.equal(executableVisualAction(holding, [action('甲与乙各持木简在廊下握手')]), true)
  assert.equal(executableVisualAction(holding, [action('甲与乙各持长刀在廊下握手')]), false, 'unapproved prop modifier')
  assert.equal(executableVisualAction(holding, [action('甲与乙在廊下拥抱')]), false, 'different predicate is not a synonym')
})

test('nonperformance, observation, wrong subjects and declaration-only bodies cannot prove an event', () => {
  const invalid = ['两人未相遇', '两人没有在街市相遇', '禁止两人在街市相遇', '两人准备在街市相遇', '两人计划，两人在街市相遇',
    '两人明日将在街市相遇', '两人回忆在街市相遇', '甲与乙注视丙与丁在街市相遇', '丙与丁在街市相遇',
    '两人在街市相遇的空间关系形成', '已完成两人在街市相遇', '声称两人在街市相遇', '两人在街市相遇的计划',
    '“两人在街市相遇”', '两人分别站在街市两端', '两人在街市擦肩而过', '两人在街市相遇。两人其实未相遇。',
    '两人没有相遇，两人在街市相遇', '两人在街市相遇，瞬移到室内', '两人在陌生庭院相遇']
  for (const text of invalid) assert.equal(executableVisualAction(contract, [action(text)]), false, text)
  assert.equal(executableVisualAction(contract, [action('两人在街市相遇', ['甲'])]), false)
  assert.equal(executableVisualAction(contract, [action('两人在街市相遇', ['甲', '丙'])]), false)
  assert.equal(executableVisualAction(contract, [action('两人在街市相遇', pair, 'reaction')]), false)
  assert.equal(executableVisualAction(contract, [{ ...action('两人在街市相遇'), performanceInstruction: '两人没有相遇' }]), false)
  assert.equal(executableVisualAction(contract, [action('甲与乙在街市站立')]), false)
})

test('negation characters inside approved actor names are identities, not negative assertions', () => {
  const names = ['张无忌', '王不留行']
  const rule = sourceVisualActions(['两人相遇'], names, ['两人在街市相遇'])[0]
  assert.equal(executableVisualAction(rule, [action('张无忌与王不留行在街市相遇', names)]), true)
  assert.equal(executableVisualAction(rule, [action('张无忌与王不留行未在街市相遇', names)]), false)
})

test('approved place names containing negation characters are neutral but event negation remains blocking', () => {
  for (const setting of ['未央宫', '无锡']) {
    const rule = sourceVisualActions(['两人相遇'], pair, [`两人在${setting}相遇`], setting)[0]
    assert.equal(executableVisualAction(rule, [action(`两人在${setting}相遇`)]), true)
    assert.equal(executableVisualAction(rule, [action(`两人在${setting}未相遇`)]), false)
    assert.equal(executableVisualAction(rule, [action(`两人未在${setting}相遇`)]), false)
    assert.deepEqual(readSourceVisualActions([rule], ['两人相遇'], setting), [rule])
  }
})

test('approved source identities are required and unrelated or compound anchors retain their contract', () => {
  for (const cast of [undefined, ['甲'], ['甲', '乙', '丙'], ['甲', '甲'], ['甲', '甲的门生']]) {
    assert.deepEqual(sourceVisualActions(['两人相遇'], cast, ['两人在街市相遇']), [])
  }
  assert.deepEqual(sourceVisualActions(['街市', '两人相遇并拔刀', '两人递出长剑', '局势恶化'], pair, []), [])
  const expanded = sourceVisualActions(['两人在街市相遇'], pair, ['两人在街市相遇'], '庭院')[0]
  assert.equal(executableVisualAction(expanded, [action('两人在庭院相遇')]), false)
  assert.equal(executableVisualAction(expanded, [action('两人相遇')]), false, 'approved location cannot disappear')
})

test('all 20 actual candidates distinguish absent pair action from the five later implemented actions', () => {
  const before = structuredClone(fixture)
  for (const row of fixture.rounds) {
    const current = currentPolicyVariant(row.candidate)
    const raw = normalizeRawStoryboardDurationCandidate(current, { scene })?.candidate ?? current
    const errors = collectDurationCoverageDiagnostics(raw, { scene })
    if (row.generation < 16) {
      assert.equal(errors.length, 1)
      assert.match(errors[0], /pacing\.beats\[0\]/)
      assert.match(errors[0], /批准视觉动作=.*周氏门生.*房氏宾客/)
      assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', raw, expected), /缺少原锚点 两人相遇/)
    } else {
      assert.deepEqual(errors, [])
      assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', raw, expected), /STORYBOARD_VOICE_OBLIGATION_MISSING/)
      assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', synchronizedVisualVariant(row.candidate), expected), /入场人物.*路径.*匹配 0 个可执行入场动作/)
    }
  }
  assert.deepEqual(fixture, before)
})

test('all original drafts retain their separate retelling/speech timing defect and test synchronization does not rewrite history', () => {
  const before = structuredClone(fixture)
  for (const row of fixture.rounds) {
    assert.throws(() => assertVoiceObligationCoverage(row.candidate), /"beatId":"beat-001-02".*"obligation":"复述"/)
    const synchronized = synchronizedVisualVariant(row.candidate)
    assert.doesNotThrow(() => assertVoiceObligationCoverage(synchronized))
    assert.deepEqual(synchronized.pacing.beats.map(beat => [beat.id, beat.actorIds, beat.textOrVocalization]), row.candidate.pacing.beats.map(beat => [beat.id, beat.actorIds, beat.textOrVocalization]))
    assert.equal(synchronized.audioText, row.candidate.audioText)
  }
  assert.deepEqual(fixture, before)
})

test('missing coverage diagnostics identify only the failing source and preserve original pacing indexes', () => {
  const raw = candidate()
  raw.pacing.beats.unshift({ ...raw.pacing.beats[0], id: 'unrelated', sourceBeatId: 'other-source', textOrVocalization: '不应泄漏的其他节拍' })
  raw.pacing.beats.at(-1).actorIds = ['周氏门生']
  const [error] = collectDurationCoverageDiagnostics(raw, { scene })
  assert.match(error, /pacing\.beats\[5\]/)
  assert.doesNotMatch(error, /不应泄漏的其他节拍|other-source|pacing\.beats\[0\]/)
})

test('full frontend and provider use the same source proof without rewriting authored body', () => {
  const raw = playableVariant(), before = structuredClone(raw)
  const approved = validateHistoricalStructuredOutput('history.storyboard', raw, expected) as typeof raw
  assert.deepEqual(raw, before)
  assert.deepEqual(approved.pacing.beats, raw.pacing.beats)
  assert.deepEqual(approved.beatDramaturgy, raw.beatDramaturgy)
  assert.doesNotThrow(() => verifyDurationSchedule(approved))
  assert.doesNotThrow(() => verifyDurationSchedule(approved, { scene }))
  const request = { model: { capability: 'video' }, executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' },
    prompt: '【场景与开场实景】甘陵街市房氏宾客站立，周氏门生在街市东端可见。\n【场景真实性硬约束】真实街市。\n' + approved.pacing.compiledVideoPrompt,
    params: { ...approved, pacingVersion: 'duration-v2', sound: 'on', continuityMode: 'scene_cut', videoTimeline: approved.pacing.compiledVideoPrompt,
      referenceImages: ['/fixtures/disciple.png', '/fixtures/guest.png'], referenceBindings: [
        { characterName: '房氏宾客', role: 'identity' }, { characterName: '周氏门生', role: 'identity' }] } }
  assert.doesNotThrow(() => validateWorkflowMediaContract(request))
  assert.equal(prepareWorkflowMediaRequest(request), request)
  for (const transform of [
    (value: typeof raw) => { value.pacing.beats.at(-1).actorIds = ['周氏门生'] },
    (value: typeof raw) => { value.pacing.beats.at(-1).textOrVocalization = '两人在街市相遇。两人其实未相遇。' },
    (value: typeof raw) => { value.pacing.sourceBeatRequirements[0].visualActions[0].actorIds = ['周氏门生', '路人'] },
  ]) {
    const tampered = structuredClone(approved)
    transform(tampered)
    assert.throws(() => verifyDurationSchedule(tampered), /缺少原锚点|哈希失效/)
    assert.throws(() => verifyDurationSchedule(tampered, { scene }), /缺少原锚点|哈希失效|派生字段/)
    assert.throws(() => validateWorkflowMediaContract({ ...request, params: { ...request.params, ...tampered } }), /不可篡改的时长排程/)
  }
})

test('qualified names satisfy only the corresponding approved visual alias, never all other visuals', () => {
  const raw = playableVariant()
  for (const beat of raw.pacing.beats) {
    for (const field of ['textOrVocalization']) beat[field] = beat[field].replaceAll('两人', '周氏门生与房氏宾客')
    for (const field of ['finalState', 'evidenceAnchor']) beat.completion[field] = beat.completion[field].replaceAll('两人', '周氏门生与房氏宾客')
  }
  const before = structuredClone(raw)
  const approved = validateHistoricalStructuredOutput('history.storyboard', raw, expected) as typeof raw
  assert.deepEqual(raw, before)
  assert.doesNotThrow(() => validateDramaStoryboard(approved, scene))
  const addedObligation = structuredClone(scene), claimed = structuredClone(approved)
  addedObligation.requiredBeats[0].observable.visual.push('两人握手')
  claimed.beatDramaturgy[0].visual.push('两人握手')
  assert.throws(() => validateDramaStoryboard(claimed, addedObligation), /两人握手/)
})

test('serialized snapshots are narrow and cannot invent a different predicate or unapproved source scope', () => {
  assert.deepEqual(readSourceVisualActions([contract], ['两人相遇']), [contract])
  assert.throws(() => readSourceVisualActions([{ ...contract, predicate: '拥抱' }], ['两人相遇']))
  assert.throws(() => readSourceVisualActions([{ ...contract, adjuncts: ['', '没有'] }], ['两人相遇']))
  assert.throws(() => readSourceVisualActions([contract], ['两人握手']))
  const raw = playableVariant(), compiled = compileDurationSchedule(raw, { scene, selectDuration: true })
  const stored = { ...raw, ...compiled }
  const differentScene = structuredClone(scene)
  differentScene.cast[1] = '陌生人'
  assert.throws(() => verifyDurationSchedule(stored, { scene: differentScene }), /缺少原锚点|哈希失效/)
})

test('three real v44 schedules remain immutable legacy evidence and fail closed under the current policy', () => {
  for (const row of legacy) {
    const before = structuredClone(row)
    for (const options of [{}, { scene: row.scene }]) assert.throws(() => verifyDurationSchedule(row.output, options), /未知时长策略版本/, row.recordId)
    assert.deepEqual(row, before)
  }
})

test('standalone duration coverage does not treat unknown beat shape as an empty successful diagnosis', () => {
  const raw = playableVariant()
  raw.pacing.beats = []
  assert.throws(() => validateStoryboardBeatCoverage(raw, scene), /缺少本镜结构化表演 beats/)
})
