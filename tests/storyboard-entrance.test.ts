import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { validateHistoricalStructuredOutput, collectHistoricalStoryboardDiagnostics, missingIndependentOpeningIdentities } from '../src/workflow-core.ts'
import { normalizeRawStoryboardDurationCandidate } from '../src/storyboard-duration-normalization.ts'
import { compileDurationSchedule, verifyDurationSchedule } from '../src/duration-schedule.ts'
import { executableEntranceAnchor, matchingEntranceActions, normalizeStoryboardAnonymousEntranceIdentities, openingTravelVisibilityIssue, projectStoryboardEntrances } from '../src/storyboard-entrance.ts'
import { generateHistoricalStoryboard } from '../src/storyboard-runtime.ts'
import { prepareWorkflowMediaRequest, validateWorkflowMediaContract } from '../server/workflow-contracts.ts'
import { DEFAULT_DURATION_POLICY } from '../src/duration-policy.ts'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/storyboard-vv6qaz-entrance.json', import.meta.url), 'utf8'))
for (const round of fixture.rounds) round.candidate.pacing.timingPolicy = DEFAULT_DURATION_POLICY
const expected = { scene: fixture.scene, pacingVersion: 'duration-v2', qualityMode: 'principle-v1',
  requireDramaContract: true, requireContinuityContract: true, requireNarrativeClosure: true }
const candidate = () => structuredClone(fixture.rounds.at(-1).candidate)

function anonymousEntranceCandidate() {
  const raw = candidate()
  raw.pacing.actorGroups = [{ id: 'clerk-group-01', label: '属吏', memberDescription: '已批准场景中协助官员的匿名属吏' }]
  for (const beat of raw.pacing.beats) beat.actorIds = beat.actorIds.map((id: string) => id === '属吏' ? 'clerk-group-01' : id)
  return raw
}

test('source-grounded anonymous entrance metadata is audited without changing its actual group performance', () => {
  const raw = anonymousEntranceCandidate(), before = structuredClone(raw)
  const repaired = normalizeStoryboardAnonymousEntranceIdentities(raw, expected)!
  assert.ok(repaired)
  assert.deepEqual(repaired.candidate.characters, ['周福'])
  assert.deepEqual(repaired.candidate.presentCharacters, ['周福'])
  assert.deepEqual(repaired.candidate.endCharacters, ['周福'])
  assert.deepEqual(repaired.candidate.enteringCharacters, [])
  assert.deepEqual((repaired.candidate.worldState as { characters: { name: string }[] }).characters.map(row => row.name), ['周福'])
  for (const field of ['pacing', 'visualPrompt', 'videoPrompt', 'lastFramePrompt', 'audioType', 'audioText', 'beatDramaturgy', 'storyProgress']) {
    assert.deepEqual(repaired.candidate[field], raw[field])
  }
  assert.ok(repaired.changes.every(change => change.reason === 'source-grounded-anonymous-entrance-identity'
    && change.proofs[0].groupId === 'clerk-group-01' && change.proofs[0].sourceBeatId === 'beat-01'
    && change.proofs[0].beatId === raw.pacing.beats[1].id))
  assert.deepEqual(repaired.changes.find(change => change.path === 'enteringCharacters')?.before, raw.enteringCharacters)
  assert.deepEqual(raw, before)
  assert.equal(normalizeStoryboardAnonymousEntranceIdentities(repaired.candidate, expected), undefined)
  assert.equal(matchingEntranceActions(raw.enteringCharacters[0], raw.pacing.beats).length, 0, 'group IDs do not become named identity aliases')
})

test('a zero-second scene-cut travel actor must be visible at the approved first-frame origin', () => {
  const shot = { continuity: { mode: 'scene_cut' }, firstFrameMode: 'reference',
    enteringCharacters: [{ name: '严颜', startSecond: 0, endSecond: 2, path: '门外经门槛进入院内' }],
    pacing: { beats: [{ id: 'enter', kind: 'action', actorIds: ['严颜'],
      textOrVocalization: '严颜沿门外通路跨门进入院内' }],
    schedule: [{ beatId: 'enter', startSecond: 0 }] } }
  assert.equal(openingTravelVisibilityIssue(shot), '严颜')
  assert.equal(openingTravelVisibilityIssue({ ...shot, enteringCharacters: [] }), undefined)
  assert.equal(openingTravelVisibilityIssue({ ...shot, enteringCharacters: [{
    ...shot.enteringCharacters[0], startSecond: 3 }] }), undefined)
})

test('anonymous identity projection refuses missing, wrong, negated or ambiguous executable paths', () => {
  const mutations = [
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.beats[1].textOrVocalization = '属吏站在案前'; delete raw.pacing.beats[1].performanceInstruction },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.beats[1].actorIds = ['周福'] },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.beats[1].textOrVocalization = '属吏没有' + raw.enteringCharacters[0].path; delete raw.pacing.beats[1].performanceInstruction },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.beats[1].textOrVocalization = '属吏目送客人' + raw.enteringCharacters[0].path; delete raw.pacing.beats[1].performanceInstruction },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.beats[1].kind = 'reaction' },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.beats[1].sourceBeatId = 'unapproved-source' },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.beats.push({ ...raw.pacing.beats[1], id: 'another-entrance' }) },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.actorGroups.push({ ...raw.pacing.actorGroups[0], id: 'another-group' }) },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.actorGroups.push({ ...raw.pacing.actorGroups[0], label: '另一群体' }) },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.pacing.actorGroups[0].id = '属吏' },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.enteringCharacters.push({ ...raw.enteringCharacters[0] }) },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.enteringCharacters[0].unapproved = true },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.worldState.characters[1].position = { status: 'observed', value: '门外', evidence: '实测尾帧' } },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.worldState.characters[1].position = { status: 'unknown', evidence: 7 } },
    (raw: ReturnType<typeof anonymousEntranceCandidate>) => { raw.scheduleHash = 'signed-existing-schedule' },
  ]
  for (const mutate of mutations) {
    const raw = anonymousEntranceCandidate(); mutate(raw)
    const before = structuredClone(raw)
    assert.equal(normalizeStoryboardAnonymousEntranceIdentities(raw, expected), undefined)
    assert.deepEqual(raw, before)
  }
  const raw = anonymousEntranceCandidate()
  assert.equal(normalizeStoryboardAnonymousEntranceIdentities(raw, { scene: { ...fixture.scene, requiredBeats: [] } }), undefined)
  assert.equal(normalizeStoryboardAnonymousEntranceIdentities(raw, { scene: { ...fixture.scene, cast: ['周福', '属吏'] } }), undefined)
  assert.equal(normalizeStoryboardAnonymousEntranceIdentities(raw, { scene: { ...fixture.scene, cast: ['周福', '属吏李四'] } }), undefined)
  assert.equal(normalizeStoryboardAnonymousEntranceIdentities(raw, { scene: { ...fixture.scene, continuityFromPrevious: true },
    previousShot: { presentCharacters: ['周福', '属吏'] } }), undefined)
})

test('group voice retains the entrance timing gate instead of being hidden by identity cleanup', () => {
  for (const kind of ['speech', 'vocalization']) for (const actor of ['clerk-group-01', '属吏']) {
    const raw = anonymousEntranceCandidate()
    raw.pacing.beats.push({ ...raw.pacing.beats[1], id: 'group-voice', kind, actorIds: [actor], textOrVocalization: '在' })
    assert.equal(normalizeStoryboardAnonymousEntranceIdentities(raw, expected), undefined)
  }
})

test('approval and independent diagnostics share anonymous metadata projection before compiling', () => {
  const raw = anonymousEntranceCandidate(), before = structuredClone(raw)
  const scoped = { ...expected, qualityDisposition: 'manual-review-v1' }
  const approved = validateHistoricalStructuredOutput('history.storyboard', raw, scoped) as ReturnType<typeof candidate>
  assert.deepEqual(approved.characters, ['周福'])
  assert.deepEqual(approved.enteringCharacters, [])
  assert.deepEqual(approved.pacing.beats, raw.pacing.beats)
  assert.deepEqual(collectHistoricalStoryboardDiagnostics(raw, scoped), [])
  assert.ok(approved.timingEstimate.anonymousIdentityProjection.changes.some((change: { path: string }) => change.path === 'enteringCharacters'))
  assert.deepEqual(raw, before)
  raw.pacing.beats[1].textOrVocalization = '属吏站在案前'; delete raw.pacing.beats[1].performanceInstruction
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', raw, scoped), /匹配 0 个可执行入场动作/)
  assert.ok(collectHistoricalStoryboardDiagnostics(raw, scoped).some(message => /匹配 0 个可执行入场动作/.test(message)))
})

test('a recovered anonymous entrance passes runtime with an explicit audit and no writer request', async () => {
  const raw = anonymousEntranceCandidate(), before = structuredClone(raw)
  let generated = 0
  const approved = await generateHistoricalStoryboard({ prompt: '保留全部已批准动作', initialCandidate: raw,
    expected: { ...expected, qualityDisposition: 'manual-review-v1' }, canGenerate: () => false,
    generate: async () => { generated += 1; throw new Error('must not generate') } })
  assert.equal(generated, 0)
  assert.deepEqual(approved.characters, ['周福'])
  assert.deepEqual(approved.pacing.beats, raw.pacing.beats)
  assert.deepEqual(approved.pacing.actorGroups, raw.pacing.actorGroups)
  assert.doesNotThrow(() => verifyDurationSchedule(approved))
  assert.equal(approved.scriptValidation.recoveredCandidate, true)
  assert.equal(approved.scriptValidation.generationAttempts, 0)
  assert.ok(approved.scriptValidation.localRepairs.some((change: { path: string; reason: string }) => change.path === 'enteringCharacters'
    && change.reason === 'source-grounded-anonymous-entrance-identity'))
  assert.deepEqual(raw, before)
})

test('latest real repair passes without changing authored entrance, body, source anchors or estimates', () => {
  const original = candidate(), before = structuredClone(original), sceneBefore = structuredClone(fixture.scene)
  const approved = validateHistoricalStructuredOutput('history.storyboard', original, expected) as ReturnType<typeof candidate>
  assert.deepEqual(original, before)
  assert.deepEqual(fixture.scene, sceneBefore)
  for (const field of ['audioText', 'visualPrompt', 'beatDramaturgy']) assert.deepEqual(approved[field], original[field])
  assert.deepEqual(approved.pacing.beats, original.pacing.beats)
  assert.equal(approved.duration, 9)
  assert.deepEqual(approved.enteringCharacters, [{ ...original.enteringCharacters[0], startSecond: 3.5, endSecond: 7.5 }])
  assert.deepEqual(approved.timingEstimate.entranceProjection, { version: 'duration-v2-entrance-v1', scheduleHash: approved.scheduleHash,
    changes: [{ characterName: '属吏', beatId: 'beat-01-action-2', path: original.enteringCharacters[0].path,
      declared: { startSecond: 3, endSecond: 6.5 }, scheduled: { startSecond: 3.5, endSecond: 7.5 } }] })
  assert.match(approved.videoPrompt, /3.5-7.5秒：.*属吏持简册从门外穿过门廊进入室内，走至周福案前/)
  assert.doesNotThrow(() => verifyDurationSchedule(approved))
})

test('storyboard approval rejects abbreviated opening identities before character assets and paid video', () => {
  const raw = candidate()
  raw.visualPrompt = raw.visualPrompt.replaceAll('周福', '官员')
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', raw, expected), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /visualPrompt 开场静态实景必须逐字声明 initialCharacters 的汉字全名/)
    assert.match(error.message, /缺少：周福/)
    return true
  })
})

test('opening identity validation does not count a short name embedded only in a longer role name', () => {
  assert.deepEqual(missingIndependentOpeningIdentities('病患家属蹲守在一旁', ['病患', '病患家属']), ['病患'])
  assert.deepEqual(missingIndependentOpeningIdentities('病患躺卧，病患家属蹲守在一旁', ['病患', '病患家属']), [])
})

test('all five real repair candidates retain their evidence and real unexecuted-path failures', () => {
  const before = structuredClone(fixture)
  for (const [index, round] of fixture.rounds.entries()) {
    const normalized = normalizeRawStoryboardDurationCandidate(round.candidate, { scene: fixture.scene })?.candidate ?? round.candidate
    const errors = collectHistoricalStoryboardDiagnostics(normalized, expected)
    if (index === 0) {
      assert.ok(errors.some(error => /path 须写在该人物 action 的 textOrVocalization 或 performanceInstruction/.test(error)))
      assert.ok(errors.some(error => /STORYBOARD_WORLD_STATE_INVALID/.test(error)))
    } else if (index < 4) {
      assert.equal(errors.length, 1)
      assert.match(errors[0], /path 须写在该人物 action 的 textOrVocalization 或 performanceInstruction/)
      assert.doesNotMatch(errors[0], /没有落入一个完整时间段|缺少原锚点 属吏入内/)
    } else assert.deepEqual(errors, [])
  }
  assert.deepEqual(fixture, before)
})

test('simple entrance anchors accept actor-bound performed modifiers and keep other source obligations literal', () => {
  const action = { kind: 'action' as const, actorIds: ['信使'], textOrVocalization: '信使双手持书卷缓步入内' }
  assert.equal(executableEntranceAnchor('信使入内', [action]), true)
  assert.equal(executableEntranceAnchor('信使入内', [{ ...action, textOrVocalization: '信使持书卷从门外进入室内' }]), true)
  assert.equal(executableEntranceAnchor('信使入画', [{ ...action, textOrVocalization: '从门外走入画面中央' }]), true)
  assert.equal(executableEntranceAnchor('信使持书卷入内', [action]), undefined)
  assert.equal(executableEntranceAnchor('信使边走边唱', [action]), undefined)
  for (const text of ['信使未入内', '信使没有入内', '信使不入内', '禁止信使入内', '信使准备入内', '信使等待入内',
    '信使目送客人入内', '信使让客人入内', '信使转述客人入内', '信使瞬移入内', '切镜后信使入内']) {
    assert.equal(executableEntranceAnchor('信使入内', [{ ...action, textOrVocalization: text }]), false, text)
  }
  assert.equal(executableEntranceAnchor('信使入内', [{ ...action, kind: 'reaction' }]), false)
  const wrongActor = [{ ...action, actorIds: ['客人'] }]
  assert.equal(executableEntranceAnchor('信使入内', wrongActor), undefined)
  const missing = candidate()
  missing.pacing.beats[1].textOrVocalization = '属吏没有入内'
  missing.pacing.beats[1].performanceInstruction = '禁止属吏入内'
  assert.throws(() => compileDurationSchedule(missing, { scene: fixture.scene, selectDuration: true }), /缺少原锚点 属吏入内/)
})

test('projection rejects absent or ambiguous actions and speech before actual arrival', () => {
  const raw = candidate(), compiled = compileDurationSchedule(raw, { scene: fixture.scene, selectDuration: true }), entry = raw.enteringCharacters[0]
  assert.equal(matchingEntranceActions(entry, compiled.pacing.beats).length, 1)
  assert.equal(matchingEntranceActions({ ...entry, path: '从另一侧院门推门而入' }, compiled.pacing.beats).length, 0)
  const entrance = compiled.pacing.beats[1]
  for (const text of ['属吏没有' + entry.path, '禁止属吏' + entry.path, '属吏瞬移后' + entry.path]) {
    assert.equal(matchingEntranceActions(entry, [{ ...entrance, textOrVocalization: text, performanceInstruction: undefined }]).length, 0)
  }
  assert.throws(() => projectStoryboardEntrances([entry], { ...compiled, pacing: { ...compiled.pacing,
    beats: [...compiled.pacing.beats, { ...entrance, id: 'another-entrance' }] } }), /匹配 2 个可执行入场动作/)
  for (const kind of ['speech', 'vocalization'] as const) {
    assert.throws(() => projectStoryboardEntrances([entry], { ...compiled, schedule: [...compiled.schedule,
      { ...compiled.schedule[1], beatId: 'premature-voice', kind, startSecond: 4 }] }), /真正入场须在 7.5 秒完成后再发声/)
  }
})

test('a performed entrance tolerates later speech and anti-teleport restrictions without allowing negated movement', () => {
  const entry = { name: '信使', path: '从门外进入室内', startSecond: 0, endSecond: 2 }
  const action = { kind: 'action' as const, actorIds: ['信使'], textOrVocalization: '' }
  for (const text of ['信使从门外进入室内，进入后尚未开口', '信使从门外进入室内，禁止闪现或切镜补人',
    '信使从门外进入室内，站定后不再走动', '信使从门外进入室内，不通过切镜补人']) {
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 1, text)
    assert.equal(executableEntranceAnchor('信使入内', [{ ...action, textOrVocalization: text }]), true, text)
  }
  for (const text of ['信使未从门外进入室内', '信使没有从门外进入室内', '禁止信使从门外进入室内',
    '信使不从门外进入室内', '信使准备从门外进入室内', '信使从门外进入室内，瞬移到案前',
    '信使未从门外进入室内，转身进入屋内']) {
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 0, text)
  }
})

test('crossing a courtyard gate into its interior is a performed entrance', () => {
  const path = '由院门外通路跨过院门门槛进入院内通道'
  const entry = { name: '严颜', path, startSecond: 0, endSecond: 2 }
  const action = { kind: 'action' as const, actorIds: ['严颜', 'escort_soldiers'],
    textOrVocalization: `严颜${path}，两名军士随行入画` }
  assert.equal(matchingEntranceActions(entry, [action]).length, 1)
  assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: `严颜准备${path}` }]).length, 0)
})

test('real external approach wording stays a performed actor-bound entrance', () => {
  const entry = { name: '乡人李四', path: '从街市另一侧走近张三', startSecond: 0, endSecond: 2 }
  const action = { kind: 'action' as const, actorIds: ['乡人李四'], textOrVocalization: '乡人李四从街市另一侧走近张三' }
  assert.equal(matchingEntranceActions(entry, [action]).length, 1)
  for (const text of ['乡人李四没有从街市另一侧走近张三', '乡人李四准备从街市另一侧走近张三',
    '禁止乡人李四从街市另一侧走近张三']) {
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 0)
  }
  assert.equal(matchingEntranceActions(entry, [{ ...action, actorIds: ['乡人张三'] }]).length, 0)
})

test('an exact directional walk toward an on-screen character is a performed entrance', () => {
  const entry = { name: '饥民甲', path: '从画面左侧前方人群中走向骞硕', startSecond: 0, endSecond: 3 }
  const action = { kind: 'action' as const, actorIds: ['饥民甲'], textOrVocalization: '' }
  for (const text of [
    '饥民甲从画面左侧前方人群中走向骞硕',
    '饥民甲向前，从画面左侧前方人群中走向骞硕',
    '饥民甲向前',
  ]) {
    const beat = text === '饥民甲向前'
      ? { ...action, textOrVocalization: text, performanceInstruction: entry.path }
      : { ...action, textOrVocalization: text }
    assert.equal(matchingEntranceActions(entry, [beat]).length, 1, text)
  }
  for (const text of [
    '饥民甲准备从画面左侧前方人群中走向骞硕',
    '饥民甲看着乙从画面左侧前方人群中走向骞硕',
    '饥民甲站在原地，乙从画面左侧前方人群中走向骞硕',
  ]) assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 0, text)
})

test('directional entrance matching covers locomotion complements without per-word patches', () => {
  const action = { kind: 'action' as const, actorIds: ['张角'], textOrVocalization: '' }
  for (const path of [
    '从画面左侧缓步走至病患前方',
    '从土路行至病患前方',
    '沿人群间隙走到病患前方',
    '从远处来到病患前方',
    '沿土路抵达病患前方',
  ]) {
    const entry = { name: '张角', path, startSecond: 0, endSecond: 3 }
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: `张角持符水${path}` }]).length, 1, path)
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: `张角准备${path}` }]).length, 0, path)
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: `张角看着病患${path}` }]).length, 0, path)
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: `张角站定，病患${path}` }]).length, 0, path)
  }
})

test('the real mounted entrance matches its exact actor-bound path with anonymous riders alongside', () => {
  const entry = { name: '张飞', path: '从远景道路快速骑马进入河岸近景', startSecond: 0, endSecond: 2.2 }
  const action = { kind: 'action' as const, actorIds: ['张飞', 'twenty-cavalry'], textOrVocalization: '' }
  for (const text of [
    '张飞从远景道路快速骑马进入河岸近景，骑马在前，身后二十骑紧随；张飞勒马在河岸边停下',
    '张飞骑马在前，身后二十骑紧随，从远景道路快速骑马进入河岸近景，张飞勒马在河岸',
    entry.path,
  ]) assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 1, text)
  assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: '张飞骑马在前',
    performanceInstruction: entry.path }]).length, 1)
  const raw = candidate(), compiled = compileDurationSchedule(raw, { scene: fixture.scene, selectDuration: true })
  const entrance = compiled.pacing.beats[1]
  const projected = projectStoryboardEntrances([entry], { ...compiled, pacing: { ...compiled.pacing,
    beats: compiled.pacing.beats.map(beat => beat.id === entrance.id
      ? { ...beat, ...action, textOrVocalization: `张飞${entry.path}`, performanceInstruction: undefined } : beat) } })
  assert.deepEqual(projected.enteringCharacters, [{ ...entry, startSecond: 3.5, endSecond: 7.5 }])
})

test('directional riding and driving still require an exact performed action by the entering actor', () => {
  const action = { kind: 'action' as const, actorIds: ['信使'], textOrVocalization: '' }
  for (const path of ['从道路骑入院落', '从道路骑马进入院落', '沿官道驾车进入营地', '从江面乘舟进入渡口']) {
    const entry = { name: '信使', path, startSecond: 0, endSecond: 3 }
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: `信使${path}` }]).length, 1, path)
    for (const text of [
      `信使没有${path}`, `信使不${path}`, `信使准备${path}`, `信使等待${path}`,
      `禁止信使${path}`, `信使看着客人${path}`, `信使站定，客人${path}`, `信使瞬移后${path}`,
    ]) assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 0, text)
    assert.equal(matchingEntranceActions(entry, [{ ...action, kind: 'reaction', textOrVocalization: `信使${path}` }]).length, 0)
    assert.equal(matchingEntranceActions(entry, [{ ...action, actorIds: ['客人'], textOrVocalization: `信使${path}` }]).length, 0)
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: '信使站在院落中',
      completion: { finalState: `信使${path}` } }]).length, 0, 'completion metadata cannot supply an absent action')
  }
})

test('an actor-bound route may walk into a named outdoor destination', () => {
  const entry = { name: '饥民代表', path: '从画面左侧缓慢走入琅邪郡治所外空地', startSecond: 0, endSecond: 3 }
  const action = { kind: 'action' as const, actorIds: ['饥民代表'], textOrVocalization: '' }
  assert.equal(matchingEntranceActions(entry, [{ ...action,
    textOrVocalization: '饥民代表面色憔悴，扶着病弱家人从画面左侧缓慢走入琅邪郡治所外空地' }]).length, 1)
  for (const text of [
    '饥民代表准备从画面左侧缓慢走入琅邪郡治所外空地',
    '饥民代表看着病人从画面左侧缓慢走入琅邪郡治所外空地',
    '饥民代表站在原地，病人从画面左侧缓慢走入琅邪郡治所外空地',
  ]) assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 0, text)
})

test('watching another entrant never proves the named actor entered, including across comma clauses', () => {
  const entry = { name: '甲', path: '从门外进入室内', startSecond: 0, endSecond: 2 }
  const action = { kind: 'action' as const, actorIds: ['甲'], textOrVocalization: '' }
  for (const text of ['甲注视乙入内', '甲看着乙入内', '甲站在门旁，乙入内',
    '甲注视乙从门外进入室内', '甲看着乙从门外进入室内', '甲站在门旁，乙从门外进入室内']) {
    assert.equal(executableEntranceAnchor('甲入内', [{ ...action, textOrVocalization: text }]), false, text)
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 0, text)
  }
  for (const text of ['甲持简册从门外进入室内', '甲持简册，从门外进入室内',
    '甲持简册，从门外进入室内，禁止闪现或切镜补人']) {
    assert.equal(executableEntranceAnchor('甲入内', [{ ...action, textOrVocalization: text }]), true, text)
    assert.equal(matchingEntranceActions(entry, [{ ...action, textOrVocalization: text }]).length, 1, text)
  }
  assert.equal(executableEntranceAnchor('甲入内', [{ ...action, textOrVocalization: '入内' }]), true,
    'a bare actor-bound action has an unambiguous implicit subject')
})

test('complete storyboard and paid preflight independently reject assigning another persons entrance', () => {
  for (const subject of ['属吏注视周福', '属吏看着周福', '属吏站在门旁，周福']) {
    const raw = candidate(), entry = raw.enteringCharacters[0], path = entry.path
    raw.pacing.beats[1].textOrVocalization = subject + path
    delete raw.pacing.beats[1].performanceInstruction
    const before = structuredClone(raw)
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', raw, expected), /缺少原锚点 属吏入内/)
    // A valid hash authenticates a schedule, not its compatibility with an
    // entrance binding. Isolate the paid-boundary guard with a source scope
    // that does not itself require this actor to enter.
    const scene = structuredClone(fixture.scene)
    scene.requiredBeats[0].mustShow = scene.requiredBeats[0].mustShow.filter((anchor: string) => anchor !== '属吏入内')
    const compiled = compileDurationSchedule(raw, { scene, selectDuration: true })
    const window = compiled.schedule.find(row => row.beatId === raw.pacing.beats[1].id)!
    const request = { model: { capability: 'video' }, executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' },
      prompt: '【场景与开场实景】周福坐于尚书台内室案前。\n【场景真实性硬约束】真实室内。\n' + compiled.videoPrompt,
      params: { ...raw, ...compiled, pacingVersion: 'duration-v2', sound: 'on', continuityMode: 'scene_cut',
        videoTimeline: compiled.videoPrompt, referenceImages: ['/fixtures/official.png', '/fixtures/clerk.png'],
        referenceBindings: [{ characterName: '周福', role: 'identity' }, { characterName: '属吏', role: 'entering',
          entrance: { ...entry, startSecond: window.startSecond, endSecond: window.endSecond } }] } }
    assert.doesNotThrow(() => verifyDurationSchedule({ ...raw, ...compiled }))
    assert.throws(() => prepareWorkflowMediaRequest(request), /匹配 0 个已批准动作/)
    assert.throws(() => validateWorkflowMediaContract(request), /续接参考必须为开场已声明/)
    assert.deepEqual(raw, before)
  }
})

test('the actual repaired storyboard also reaches provider preflight with the same canonical entrance', () => {
  const raw = candidate(), approved = validateHistoricalStructuredOutput('history.storyboard', raw, expected) as ReturnType<typeof candidate>
  const request = { model: { capability: 'video' }, executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video' },
    prompt: '【场景与开场实景】周福坐于尚书台内室案前。\n【场景真实性硬约束】真实室内。\n' + approved.pacing.compiledVideoPrompt,
    params: { ...approved, pacingVersion: 'duration-v2', sound: 'on', continuityMode: 'scene_cut',
      videoTimeline: approved.pacing.compiledVideoPrompt, referenceImages: ['/fixtures/official.png', '/fixtures/clerk.png'],
      referenceBindings: [{ characterName: '周福', role: 'identity' }, { characterName: '属吏', role: 'entering', entrance: approved.enteringCharacters[0] }] } }
  assert.doesNotThrow(() => validateWorkflowMediaContract(request))
  assert.equal(prepareWorkflowMediaRequest(request), request, 'front and back end agree without a second adjustment')
  const oldMetadata = structuredClone(request)
  oldMetadata.params.referenceBindings[1].entrance = raw.enteringCharacters[0]
  const prepared = prepareWorkflowMediaRequest(oldMetadata)
  assert.deepEqual(prepared.params.referenceBindings[1].entrance, approved.enteringCharacters[0])
  assert.deepEqual(oldMetadata.params.referenceBindings[1].entrance, raw.enteringCharacters[0])
  assert.doesNotThrow(() => validateWorkflowMediaContract(prepared))
})
