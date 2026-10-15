import test from 'node:test'
import assert from 'node:assert/strict'
import { planSceneCutAutoRetry } from '../src/scene-cut-auto-retry.ts'

const runs = [
  { id: 'plan', node: { id: 'sanguo-scene-cut-opening-plan' }, status: 'success', loopGroupId: 'g', loopIndex: 0 },
  { id: 'image', node: { id: 'sanguo-scene-cut-first-frame' }, status: 'success', loopGroupId: 'g', loopIndex: 0 },
  { id: 'evidence', node: { id: 'sanguo-scene-cut-evidence' }, status: 'success', loopGroupId: 'g', loopIndex: 0 },
  { id: 'review', node: { id: 'sanguo-scene-cut-review' }, status: 'success', loopGroupId: 'g', loopIndex: 0,
    output: { passed: false, issues: [{ code: 'ACTION_START', beatId: 'action-knot', problem: '腕圈已收紧' }] } },
  { id: 'gate', node: { id: 'sanguo-scene-cut-approval' }, status: 'failed', loopGroupId: 'g', loopIndex: 0 },
]

test('real frame rejection retries only the same shot image, with bounded feedback', () => {
  const plan = planSceneCutAutoRetry(runs, 4)
  assert.equal(plan?.imageIndex, 1)
  assert.equal(plan?.reviewRunId, 'review')
  assert.match(plan?.feedback ?? '', /腕圈已收紧/)
  assert.equal(planSceneCutAutoRetry(runs, 4, 2)?.count, 3)
  assert.equal(planSceneCutAutoRetry(runs, 4, 5), undefined)
})

test('never retries missing evidence, ambiguous review or another loop', () => {
  assert.equal(planSceneCutAutoRetry(runs.map((run, at) => at === 3
    ? { ...run, output: { passed: false, issues: [] } } : run), 4), undefined)
  assert.equal(planSceneCutAutoRetry(runs.map((run, at) => at === 1
    ? { ...run, loopIndex: 1 } : run), 4), undefined)
  assert.equal(planSceneCutAutoRetry(runs.map((run, at) => at === 4
    ? { ...run, status: 'success' } : run), 4), undefined)
})

test('accepts the persisted vision report detail field', () => {
  const changed = runs.map((run, at) => at === 3 ? { ...run,
    output: { passed: false, issues: [{ code: 'TIGHTENING_START_NOT_VISIBLE',
      detail: '束腕绳圈贴紧，起点未出现' }] } } : run)
  assert.match(planSceneCutAutoRetry(changed, 4, 1)?.feedback ?? '', /束腕绳圈贴紧/)
})

test('accepts source-image evidence text when the reviewer omits problem and detail', () => {
  const changed = runs.map((run, at) => at === 3 ? { ...run,
    output: { passed: false, issues: [{ code: 'EXTRA_PROMINENT_CHARACTER',
      evidence: '画面左侧多出未批准的第四人' }] } } : run)
  assert.match(planSceneCutAutoRetry(changed, 4, 1)?.feedback ?? '', /画面左侧多出未批准的第四人/)
})

test('retries a beat-bound pixel rejection when vision omits issue code', () => {
  const changed = runs.map((run, at) => at === 3 ? { ...run,
    output: { passed: false, issues: [{ beatId: 'action-bind',
      problem: '收紧动作的零秒起点不合格。', pixelEvidence: '腕绳已经贴腕，结扣闭合。' }] } } : run)
  const plan = planSceneCutAutoRetry(changed, 4)
  assert.equal(plan?.imageIndex, 1)
  assert.match(plan?.feedback ?? '', /VISUAL_ACTION_REJECTED/)
  assert.match(plan?.feedback ?? '', /腕绳已经贴腕/)
  const vague = runs.map((run, at) => at === 3 ? { ...run,
    output: { passed: false, issues: [{ beatId: 'action-bind', problem: '可能有问题' }] } } : run)
  assert.equal(planSceneCutAutoRetry(vague, 4), undefined)
})

test('retains a beat-bound string rejection as concrete image retry feedback', () => {
  const changed = runs.map((run, at) => at === 3 ? { ...run,
    output: { passed: false, issues: ['action-enter-courtyard：三人已经跨过门槛，首帧缺少门外起点'] } } : run)
  assert.match(planSceneCutAutoRetry(changed, 4, 3)?.feedback ?? '', /三人已经跨过门槛/)
  assert.equal(planSceneCutAutoRetry(runs.map((run, at) => at === 3 ? { ...run,
    output: { passed: false, issues: ['看着不太对'] } } : run), 4), undefined)
})
