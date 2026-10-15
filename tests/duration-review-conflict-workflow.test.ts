import assert from 'node:assert/strict'
import test from 'node:test'
import { durationMediaAcceptCode } from '../src/principle-workflow.ts'
import { upgradeDurationReviewConflictWorkflow } from '../src/duration-review-conflict-workflow.ts'

const newStart = durationMediaAcceptCode.indexOf('if(!completion.passed){')
const newCall = durationMediaAcceptCode.indexOf('return (function durationCompletionRecovery(', newStart)
const newEnd = durationMediaAcceptCode.indexOf(')(context,completion,params);', newCall)
  + ')(context,completion,params);'.length
const nextStatement = durationMediaAcceptCode.indexOf(
  '\nconst accepted=principleMediaQuality.acceptMedia(context,params);\nreturn {...accepted,durationCompletion:completion};',
  newEnd,
)
const oldCode = durationMediaAcceptCode.slice(0, newStart)
  + 'if(!completion.passed)' + durationMediaAcceptCode.slice(newCall, newEnd)
  + durationMediaAcceptCode.slice(nextStatement)
const workflow = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 179,
  edges: [{ id: 'e', from: 'sanguo-media-review', to: 'sanguo-media-accept' }],
  nodes: [
    { id: 'sanguo-video', code: '' },
    { id: 'sanguo-media-review', code: '' },
    { id: 'sanguo-media-accept', code: '// PRINCIPLE_POLICY_START\n' + oldCode + '\n// PRINCIPLE_POLICY_END\n// duration-v2-preserved-legacy' },
    { id: 'sanguo-video-concat', code: '' },
  ] })

test('schema180 wraps only the active schema179 duration recovery and keeps signed evidence and graph', () => {
  const before = workflow(), after = upgradeDurationReviewConflictWorkflow(before)
  assert.equal(after.schemaVersion, 180)
  assert.strictEqual(after.edges, before.edges)
  assert.strictEqual(after.nodes[0], before.nodes[0])
  assert.strictEqual(after.nodes[1], before.nodes[1])
  assert.strictEqual(after.nodes[3], before.nodes[3])
  assert.deepEqual({ ...after.nodes[2], code: before.nodes[2].code }, before.nodes[2])
  assert.equal(after.nodes[2].code,
    '// PRINCIPLE_POLICY_START\n' + durationMediaAcceptCode + '\n// PRINCIPLE_POLICY_END\n// duration-v2-preserved-legacy')
  assert.strictEqual(upgradeDurationReviewConflictWorkflow(after), after)
})

test('schema180 rejects ambiguous or modified acceptance anchors', () => {
  const duplicate = workflow()
  duplicate.nodes[2].code = duplicate.nodes[2].code.replace('// PRINCIPLE_POLICY_END',
    'if(!completion.passed)return (function durationCompletionRecovery() {})(context,completion,params);\n// PRINCIPLE_POLICY_END')
  assert.throws(() => upgradeDurationReviewConflictWorkflow(duplicate), /MIGRATION_CONFLICT/)
  const altered = workflow()
  altered.nodes[2].code = altered.nodes[2].code.replace('if(!completion.passed)return ', 'if(!completion.passed) return ')
  assert.throws(() => upgradeDurationReviewConflictWorkflow(altered), /MIGRATION_CONFLICT/)
  const already = workflow()
  already.nodes[2].code = already.nodes[2].code.replace(oldCode, durationMediaAcceptCode)
  assert.throws(() => upgradeDurationReviewConflictWorkflow(already), /MIGRATION_CONFLICT/)
})
