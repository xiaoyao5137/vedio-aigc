import test from 'node:test'
import assert from 'node:assert/strict'
import { storyShot2AcceptanceRoute } from '../scripts/story-shot2-target-endframe.mjs'

test('target end-frame permits direct visual acceptance only with the original uncertain model result', () => {
  const recovery = { shot1Acceptance: { method: 'direct-visual-pass' } }
  const uncertain = { reviewStatus: 'uncertain', passed: false, retryable: false }
  assert.equal(storyShot2AcceptanceRoute(recovery, uncertain), 'direct-visual-pass')
  assert.throws(() => storyShot2AcceptanceRoute(recovery, { ...uncertain, reviewStatus: 'passed' }),
    /must preserve the uncertain model assessment/)
  assert.throws(() => storyShot2AcceptanceRoute(recovery, { ...uncertain, passed: true }),
    /must preserve the uncertain model assessment/)
  assert.throws(() => storyShot2AcceptanceRoute(recovery, { ...uncertain, retryable: true }),
    /must preserve the uncertain model assessment/)
})

test('target end-frame keeps automated and direct visual acceptance methods separate', () => {
  const passed = { reviewStatus: 'passed', passed: true, issues: [], beatChecks: [] }
  assert.equal(storyShot2AcceptanceRoute({ shot1Acceptance: { method: 'automated-passed' } }, passed),
    'automated-passed')
  assert.throws(() => storyShot2AcceptanceRoute({ shot1Acceptance: { method: 'automated-passed' } },
    { reviewStatus: 'uncertain', passed: false, retryable: false }), /lacks a passed automated assessment/)
  assert.throws(() => storyShot2AcceptanceRoute({ shot1Acceptance: { method: 'unverified' } }, passed),
    /no verified automated or direct visual acceptance/)
  assert.throws(() => storyShot2AcceptanceRoute({}, passed), /no verified automated or direct visual acceptance/)
})
