import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { executeRecoveredHistoricalStoryboard } from '../src/failed-text-execution.ts'
import { cleanStoryboardForValidation, sceneFromStoryboardSegment } from '../src/storyboard-runtime.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/crr7s5-successful-split-plan.json', import.meta.url), 'utf8'))

test('the execution adapter validates only the selected future segment, even though its provenance raw contains the complete earlier split', async () => {
  const draft = cleanStoryboardForValidation(fixture.validatedSegments[1])
  let calls = 0
  const execution = await executeRecoveredHistoricalStoryboard({ prompt: fixture.node.prompt,
    expected: { ...fixture.expected, scene: sceneFromStoryboardSegment(fixture.expected.scene, draft, 1, 3),
      previousShot: fixture.validatedSegments[0] },
    plannedCandidate: { draft, raw: fixture.raw }, canGenerate: () => false,
    generate: async () => { calls++; throw Error('provider forbidden') } })
  assert.equal(calls, 0)
  assert.equal(execution.generations, 0)
  assert.equal(execution.source, undefined, 'plan reuse must not claim a newly bought supplier response')
  assert.equal(execution.recovered, undefined, 'successful plans are separate from failed paid evidence')
  assert.equal(execution.result.id, draft.id)
  assert.deepEqual(execution.result.coveredBeatIds, draft.coveredBeatIds)
  assert.equal(execution.result.duration, draft.duration)
  assert.equal(Object.hasOwn(execution.result, '__storyboardSegments'), false)
  assert.equal(Object.hasOwn(execution.result, 'raw'), false)
  assert.equal(Object.hasOwn(execution.result, 'mediaAcceptance'), false)
})

test('a saved successful plan cannot pass the execution adapter when current source obligations change', async () => {
  const draft = cleanStoryboardForValidation(fixture.validatedSegments[1])
  const scene = structuredClone(sceneFromStoryboardSegment(fixture.expected.scene, draft, 1, 3))
  scene.requiredBeats[0].observable.audio.push('新增的完整原词义务')
  let calls = 0
  await assert.rejects(executeRecoveredHistoricalStoryboard({ prompt: fixture.node.prompt,
    expected: { ...fixture.expected, qualityDisposition: 'strict', scene, previousShot: fixture.validatedSegments[0] },
    plannedCandidate: { draft, raw: fixture.raw }, canGenerate: () => false,
    generate: async () => { calls++; throw Error('provider forbidden') } }), /HISTORY_DRAMA_INVALID: beat-03 遗漏 audio 声画义务/)
  assert.equal(calls, 0)
})
