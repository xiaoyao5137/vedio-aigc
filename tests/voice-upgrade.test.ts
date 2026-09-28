import test from 'node:test'
import assert from 'node:assert/strict'
import { voiceUpgradeIndexes } from '../src/voice-upgrade.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { assertVoiceRuntime, VOICE_CONTRACT_VERSION } from '../src/character-voice.ts'

test('strict voice clients reject a running older service before video submission', () => {
  assert.throws(() => assertVoiceRuntime({}), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.throws(() => assertVoiceRuntime({ voiceContractVersion: 'older' }), /VOICE_PROVIDER_UNSUPPORTED/)
  assert.doesNotThrow(() => assertVoiceRuntime({ voiceContractVersion: VOICE_CONTRACT_VERSION }))
})

test('voice upgrade resets all selected-character shots and their continuity dependants, preserving independent cuts', () => {
  const video = (index: number, characterId: string) => ({ id: `v${index}`, node: { kind: 'video' }, status: 'success', loopGroupId: 'scenes', loopIndex: index, loopItem: { continuityFromPrevious: false }, output: { url: `https://example.com/${index}.mp4`, characterVoices: [{ characterId, version: 1 }] }, revision: 0 })
  const runs = [video(0, 'a'), video(1, 'b'), video(2, 'a'), { id: 'compose', node: { kind: 'code' }, status: 'success', output: { url: 'old-composition' } }]
  const original = structuredClone(runs)
  const impact = voiceUpgradeIndexes(runs, ['a'], true)
  assert.deepEqual(impact.direct, [0, 2])
  assert.deepEqual(impact.invalidated, [0, 2, 3])
  const next = manualRetryRuns(runs, 0, new Set(impact.invalidated))
  assert.equal(next[1], runs[1])
  assert.equal(next[0].output, undefined)
  assert.equal(next[3].status, 'idle')
  assert.deepEqual(runs, original, 'source execution and video evidence remain intact')
  assert.deepEqual(voiceUpgradeIndexes(runs, ['a'], false).invalidated, [0, 1, 2, 3], 'unknown workflow dependencies conservatively reset downstream')
})

test('unproven media is explicitly invalidated and empty or unrelated selections fail closed', () => {
  const runs = [{ node: { kind: 'video' } }, { node: { kind: 'video' }, output: { url: 'https://example.com/a.mp4', characterVoices: [{ characterId: 'a' }] } }]
  const impact = voiceUpgradeIndexes(runs, ['a'], true)
  assert.deepEqual(impact.unknown, [0])
  assert.deepEqual(impact.invalidated, [0, 1])
  assert.throws(() => voiceUpgradeIndexes(runs, [], true), /请选择/)
  assert.throws(() => voiceUpgradeIndexes(runs, ['b'], true), /没有找到/)
})
