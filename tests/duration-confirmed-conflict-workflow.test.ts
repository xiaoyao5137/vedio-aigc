import assert from 'node:assert/strict'
import test from 'node:test'
import { upgradeDurationConfirmedConflictWorkflow } from '../src/duration-confirmed-conflict-workflow.ts'

const old = "const confirmedConflict=accepted.qualityReview?.principleIssues?.some(row=>row?.code==='core_event_contradiction'&&row?.evidence?.source==='frame');\nif(confirmedConflict)return {...accepted,durationCompletion:completion};"
const workflow = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 180,
  nodes: [{ id: 'sanguo-media-accept', code: `// PRINCIPLE_POLICY_START\n${old}\n// PRINCIPLE_POLICY_END` },
    { id: 'sanguo-video-concat', code: 'unchanged' }], edges: [{ from: 'sanguo-media-accept', to: 'sanguo-video-concat' }] })

test('confirmed frame contradiction routes back to duration replan and preserves graph', () => {
  const before = workflow(), after = upgradeDurationConfirmedConflictWorkflow(before)
  assert.equal(after.schemaVersion, 181)
  assert.strictEqual(after.edges, before.edges)
  assert.strictEqual(after.nodes[1], before.nodes[1])
  assert.match(after.nodes[0].code, /passed:false,durationCompletion:replanned,routeError:'DURATION_REPLAN_REQUIRED/)
  assert.match(after.nodes[0].code, /sourceVideo:context.video_evidence.url/)
  assert.doesNotMatch(after.nodes[0].code, /if\(confirmedConflict\)return \{\.\.\.accepted,durationCompletion:completion\}/)
  assert.strictEqual(upgradeDurationConfirmedConflictWorkflow(after), after)
})

test('ambiguous or edited gate is refused', () => {
  const before = workflow()
  before.nodes[0].code = before.nodes[0].code.replace('// PRINCIPLE_POLICY_END', `${old}\n// PRINCIPLE_POLICY_END`)
  assert.throws(() => upgradeDurationConfirmedConflictWorkflow(before), /MIGRATION_CONFLICT/)
})
