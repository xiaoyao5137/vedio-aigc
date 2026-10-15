import test from 'node:test'
import assert from 'node:assert/strict'
import { planCoverageCutAutoRetry } from '../src/coverage-cut-auto-retry.ts'

const run = (id: string, status = 'success', output?: unknown, loopIndex = 3) => ({
  id, node: { id }, status, output, loopGroupId: 'sanguo-scene-loop', loopIndex,
})

test('coverage identity rejection retries only the current first frame twice', () => {
  const runs = [run('previous-video'), run('sanguo-coverage-first-frame'),
    run('sanguo-coverage-evidence'), run('sanguo-coverage-review', 'success',
      { passed: false, issues: [{ code: 'identity_mismatch', problem: '张飞被士兵替代' }] }),
    run('sanguo-coverage-approval', 'failed')]
  const plan = planCoverageCutAutoRetry(runs, 4)!
  assert.equal(plan.imageIndex, 1)
  assert.match(plan.feedback, /张飞被士兵替代/)
  assert.equal(planCoverageCutAutoRetry(runs, 4, 1)?.count, 2)
  assert.equal(planCoverageCutAutoRetry(runs, 4, 2), undefined)
  assert.equal(planCoverageCutAutoRetry(runs.map((item, index) => index === 3
    ? { ...item, output: { passed: true, issues: [] } } : item), 4), undefined)
  assert.equal(planCoverageCutAutoRetry(runs.map((item, index) => index === 3
    ? { ...item, output: { passed: false, issues: [{ code: 'required_binding_absent',
      description: '严颜双腕没有可辨认束缚绳' }] } } : item), 4)?.imageIndex, 1)
  assert.equal(planCoverageCutAutoRetry(runs.map((item, index) => index === 1
    ? { ...item, loopIndex: 2 } : item), 4), undefined)
})
