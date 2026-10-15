import assert from 'node:assert/strict'
import test from 'node:test'
import { upgradeNarrationIsolationGateWorkflow } from '../src/narration-isolation-gate-workflow.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'

const oldFunction = `function assessDurationCompletion(shot,evidence,review) {
  const transfer = evidence.independentNarrationTransfer;
  const transferBound = transfer.mixerVersion === 5;
  return { passed: transferBound };
}`
const oldCode = `// PRINCIPLE_POLICY_START
if (params.qualityMode === 'principle-v1') {
// INDEPENDENT_NARRATION_TRANSFER_GATE_SCHEMA162
const completion=(${oldFunction})(context.shot_script,context.video_evidence,context.media_review);
return completion;
}
// PRINCIPLE_POLICY_END
// duration-v2-completion-gate
const completion=(${oldFunction})(context.shot_script,context.video_evidence,context.media_review);
return completion;`

const workflow = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 178, edges: [{ id: 'e', from: 'sanguo-media-review', to: 'sanguo-media-accept' }],
  nodes: [
    { id: 'sanguo-video', kind: 'video', code: '' },
    { id: 'sanguo-video-evidence', kind: 'http', code: '' },
    { id: 'sanguo-media-review', kind: 'text', code: '' },
    { id: 'sanguo-media-accept', kind: 'code', code: oldCode },
    { id: 'sanguo-last-frame', kind: 'code', code: '' },
  ] })

test('schema179 changes only active principle duration gate and keeps legacy path and graph', () => {
  const before = workflow()
  const after = upgradeNarrationIsolationGateWorkflow(before)
  assert.equal(after.schemaVersion, 179)
  assert.strictEqual(after.edges, before.edges)
  assert.strictEqual(after.nodes[0], before.nodes[0])
  assert.strictEqual(after.nodes[1], before.nodes[1])
  assert.strictEqual(after.nodes[2], before.nodes[2])
  assert.strictEqual(after.nodes[4], before.nodes[4])
  const code = after.nodes[3].code
  assert.match(code, /\[5, 6\]\.includes\(Number\(transfer\.mixerVersion\)\)/)
  assert.match(code, /sourceSpeechIsolation\.mode === 'full-source-mute'/)
  assert.equal(code.slice(code.indexOf('// duration-v2-completion-gate')), oldCode.slice(oldCode.indexOf('// duration-v2-completion-gate')))
  assert.strictEqual(upgradeNarrationIsolationGateWorkflow(after), after)
})

test('targeted review retry retains paid media and evidence while refreshing pending acceptance gate', () => {
  const before = workflow(), after = upgradeNarrationIsolationGateWorkflow(before)
  const runs = before.nodes.map((node, index) => ({ id: `${node.id}-${index}`, node,
    status: index < 4 ? 'success' : 'failed', revision: 3,
    loopGroupId: 'scene-loop-1', loopIndex: 0, output: index === 0 ? { url: '/generated/paid.mp4' }
      : index === 1 ? { url: '/generated/evidence.mp4', evidenceUrl: '/generated/evidence.json' } : { value: true } }))
  const retried = manualRetryRuns(runs, 2)
  assert.strictEqual(retried[0], runs[0])
  assert.strictEqual(retried[1], runs[1])
  assert.equal(retried[2].status, 'idle')
  assert.equal(retried[3].status, 'idle')
  const refreshed = refreshPendingExecutionNodes(after, retried)
  assert.strictEqual(refreshed[0], runs[0])
  assert.strictEqual(refreshed[1], runs[1])
  assert.equal(refreshed[3].node.code, after.nodes[3].code)
  assert.notEqual(refreshed[3].node.code, before.nodes[3].code)
})

test('migration fails closed on ambiguous or already modified schema178 gate', () => {
  const wrong = workflow()
  wrong.nodes[3].code = wrong.nodes[3].code.replace('transfer.mixerVersion === 5', 'transfer.mixerVersion === 6')
  assert.throws(() => upgradeNarrationIsolationGateWorkflow(wrong), /MIGRATION_CONFLICT/)
  const duplicate = workflow()
  duplicate.nodes[3].code = duplicate.nodes[3].code.replace('// PRINCIPLE_POLICY_END',
    `const completion=(${oldFunction})(context.shot_script,context.video_evidence,context.media_review);\n// PRINCIPLE_POLICY_END`)
  assert.throws(() => upgradeNarrationIsolationGateWorkflow(duplicate), /MIGRATION_CONFLICT/)
})
