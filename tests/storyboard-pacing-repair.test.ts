import test from 'node:test'
import assert from 'node:assert/strict'
import { repairStoryboardPacingMetadata } from '../src/storyboard-pacing-repair.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

const shot = {
  id: 's1', title: '交还竹简', duration: 3, characters: ['甲'], initialCharacters: ['甲'], enteringCharacters: [], endCharacters: ['甲'],
  visualPrompt: '甲手持竹简站在案前。', lastFramePrompt: '甲收回空手站在案前。', camera: '中景', mood: '自然', firstFrameMode: 'reference',
  videoPrompt: '0-0.7秒：甲递出竹简。0.7-1.4秒：甲开口说出“遵命”。1.4-3秒：甲收回空手。',
  audioType: '对白', audioText: '甲：遵命。', historicalBasis: '[史料1] 奉命', adaptationBoundary: '动作对白拟制',
  pacing: { version: 'dynamic-v1', actionSeconds: 1, reactionSeconds: 0.7,
    activityWindows: [{ kind: 'action', startSecond: 0, endSecond: 0.7 },
      { kind: 'speech', startSecond: 0.7, endSecond: 1.394444 }, { kind: 'reaction', startSecond: 1.4, endSecond: 1.9 }],
    performanceBeats: [{ id: 'handoff', purpose: '奉命交还', stateChange: '甲递出竹简', evidenceAnchor: '甲递出竹简',
      startSecond: 0, endSecond: 0.7, overlapWith: ['speech'] }],
  },
}
const expected = { requireDynamicPacing: true }

test('redundant budgets and intersections repair together and pass the full contract without changing the authored clock', () => {
  const before = structuredClone(shot)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', shot, expected), /activityWindows/)
  const result = repairStoryboardPacingMetadata(shot)!
  assert.deepEqual(result.changes, [
    { path: 'pacing.actionSeconds', before: 1, after: 0.7, source: 'activity-window-union' },
    { path: 'pacing.reactionSeconds', before: 0.7, after: 0.5, source: 'activity-window-union' },
    { path: 'pacing.performanceBeats[0].overlapWith', before: ['speech'], after: ['action'], source: 'activity-window-intersection' },
  ])
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', result.candidate, expected))
  assert.deepEqual(shot, before)
  for (const key of ['duration', 'videoPrompt', 'audioText', 'visualPrompt', 'lastFramePrompt']) assert.deepEqual(result.candidate[key], shot[key])
  assert.equal((result.candidate.pacing as typeof shot.pacing).activityWindows, shot.pacing.activityWindows)
  assert.equal(repairStoryboardPacingMetadata(result.candidate), undefined)
})

test('a wrong speech budget remains blocked but does not suppress independent metadata repairs', () => {
  const candidate = { ...shot, pacing: { ...shot.pacing, speechSeconds: 999,
    activityWindows: shot.pacing.activityWindows.map(window => window.kind === 'speech' ? { ...window, endSecond: 2.7 } : window) } }
  const result = repairStoryboardPacingMetadata(candidate)!
  const pacing = result.candidate.pacing as typeof candidate.pacing
  assert.equal(pacing.actionSeconds, 0.7)
  assert.equal(pacing.reactionSeconds, 0.5)
  assert.equal(pacing.speechSeconds, 999)
  assert.equal(pacing.activityWindows, candidate.pacing.activityWindows)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', result.candidate, expected), /speech activityWindows/)
})

test('same-kind overlaps are not erased or converted to an accepted budget', () => {
  const candidate = { ...shot, pacing: { ...shot.pacing,
    activityWindows: [...shot.pacing.activityWindows, { kind: 'action', startSecond: 0.2, endSecond: 0.6 }] } }
  const result = repairStoryboardPacingMetadata(candidate)!
  const pacing = result.candidate.pacing as typeof candidate.pacing
  assert.equal(pacing.actionSeconds, 1)
  assert.equal(pacing.reactionSeconds, 0.5)
  assert.equal(pacing.activityWindows, candidate.pacing.activityWindows)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', result.candidate, expected), /action activityWindows/)
})

test('out-of-range unions and missing reaction windows remain defects while independent fields still repair', () => {
  for (const [kind, endSecond] of [['action', 10.1], ['reaction', 2.7]] as const) {
    const candidate = { ...shot, pacing: { ...shot.pacing, activityWindows: shot.pacing.activityWindows.map(window => window.kind === kind
      ? { ...window, endSecond } : window) } }
    const result = repairStoryboardPacingMetadata(candidate)!
    assert.equal((result.candidate.pacing as typeof shot.pacing)[`${kind}Seconds`], shot.pacing[`${kind}Seconds`])
    assert.ok(result.changes.some(change => change.path !== `pacing.${kind}Seconds`))
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', result.candidate, expected), /activityWindows/)
  }
  const absent = { ...shot, pacing: { ...shot.pacing, reactionSeconds: undefined,
    activityWindows: shot.pacing.activityWindows.filter(window => window.kind !== 'reaction') } }
  const result = repairStoryboardPacingMetadata(absent)!
  assert.equal((result.candidate.pacing as typeof absent.pacing).reactionSeconds, undefined)
  assert.equal((result.candidate.pacing as typeof absent.pacing).activityWindows, absent.pacing.activityWindows)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', result.candidate, expected), /reactionSeconds/)
})

test('malformed or absent activities never invent a usable clock', () => {
  for (const activityWindows of [undefined, null, {}, 'windows', [null],
    [{ kind: 'speech', startSecond: '0', endSecond: 1 }], [{ kind: 'action', startSecond: 0, endSecond: Infinity }],
    [{ kind: 'pause', startSecond: 0, endSecond: 1 }], [{ kind: 'reaction', startSecond: 1, endSecond: 0 }]]) {
    assert.equal(repairStoryboardPacingMetadata({ ...shot, pacing: { ...shot.pacing, activityWindows } }), undefined)
  }
  for (const value of [null, [], {}, { ...shot, pacing: { ...shot.pacing, version: 'legacy' } }]) {
    assert.equal(repairStoryboardPacingMetadata(value), undefined)
  }
})

test('an omitted action window cannot silently zero the declared necessary action', () => {
  const candidate = { ...shot, pacing: { ...shot.pacing,
    activityWindows: shot.pacing.activityWindows.filter(window => window.kind !== 'action') } }
  const result = repairStoryboardPacingMetadata(candidate)!
  assert.equal((result.candidate.pacing as typeof shot.pacing).actionSeconds, shot.pacing.actionSeconds)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', result.candidate, expected), /action activityWindows/)
})

test('invalid performance rows do not hide independent valid intersections or manufacture performance content', () => {
  const invalid = { id: 'bad', startSecond: 2, endSecond: 1, overlapWith: [] }
  const candidate = { ...shot, pacing: { ...shot.pacing, performanceBeats: [null, invalid, shot.pacing.performanceBeats[0]] } }
  const result = repairStoryboardPacingMetadata(candidate)!
  const beats = (result.candidate.pacing as typeof candidate.pacing).performanceBeats
  assert.equal(beats[0], null)
  assert.equal(beats[1], invalid)
  assert.deepEqual(beats[2], { ...shot.pacing.performanceBeats[0], overlapWith: ['action'] })
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', result.candidate, expected), /performanceBeats/)
})

test('split repairs preserve observations and unchanged segments with precise audit paths', () => {
  const valid = repairStoryboardPacingMetadata(shot)!.candidate
  const worldState = { characters: [{ name: '甲', heldProps: { status: 'observed', value: '竹简', evidence: 'actual-frame-1' } }] }
  const second = { ...shot, worldState }
  const original = { segments: [valid, second], trace: 'preserve' }
  const before = structuredClone(original)
  const result = repairStoryboardPacingMetadata(original)!
  const segments = result.candidate.segments as Record<string, unknown>[]
  assert.equal(segments[0], valid)
  assert.equal(segments[1].worldState, worldState)
  assert.ok(result.changes.every(change => change.path.startsWith('segments[1].pacing.')))
  assert.deepEqual(original, before)
  assert.equal(result.candidate.trace, original.trace)
})

test('boundary contact is not overlap and harmless overlap list order needs no repair', () => {
  const valid = repairStoryboardPacingMetadata(shot)!.candidate
  const pacing = valid.pacing as typeof shot.pacing
  const candidate = { ...valid, pacing: { ...pacing, performanceBeats: [{ ...pacing.performanceBeats[0],
    endSecond: 1.394444, overlapWith: ['action', 'speech'] }] } }
  assert.equal(repairStoryboardPacingMetadata(candidate), undefined)
  const withoutOverlap = { ...candidate, pacing: { ...candidate.pacing, performanceBeats: [{ ...candidate.pacing.performanceBeats[0],
    overlapWith: [] }] } }
  const result = repairStoryboardPacingMetadata(withoutOverlap)!
  assert.deepEqual(result.changes[0].after, ['speech', 'action'])
})
