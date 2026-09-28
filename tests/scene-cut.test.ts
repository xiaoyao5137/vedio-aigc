import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/history-scene-cut.json', import.meta.url), 'utf8'))
test('real different-cast court scenes can use a motivated cut without inventing a shared prop', () => {
  const candidate = { ...fixture.candidate, continuity: { previousShotId: fixture.previous.id, bridgeType: 'cut', bridgeAnchor: '由皇帝授印转到房植处理公务，呈现另一个声望中心' } }
  const expected = { scene: { continuityFromPrevious: false }, previousShot: fixture.previous, requireContinuityContract: true, productionSpeechRate: 3 }
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', candidate, expected))
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', candidate, { ...expected, scene: { continuityFromPrevious: true } }), /连续镜头必须使用/)
})
