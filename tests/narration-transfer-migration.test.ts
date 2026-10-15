import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeNarrationTransferWorkflow } from '../src/narration-transfer-migration.ts'

function savedWorkflow() {
  return { id: 'wf-sanguo-history-drama', schemaVersion: 161, nodes: [
    { id: 'sanguo-media-request', code: 'leave request untouched' },
    { id: 'sanguo-media-accept', code: `before\n// PRINCIPLE_POLICY_START\n// PRINCIPLE_DURATION_V2_GATE_SCHEMA159\nif(context.shot_script?.pacing?.version==='duration-v2') {\nconst completion=(function assessDurationCompletion(shot, evidence, review) { return { passed: false }; })(context.shot_script,context.video_evidence,context.media_review);\nreturn completion;\n}\n// PRINCIPLE_POLICY_END\nafter` },
    { id: 'sanguo-media-review', prompt: `before\n【duration-v2逐节拍完成证据】\naudio.evidenceIds只引用真实video_evidence.audioObservations.id或可靠speechValidation.alignment的speech-0等编号。\n【duration-v2逐节拍完成证据结束】\nafter` },
    { id: 'sanguo-scene-outline', prompt: 'user owned outline prompt' },
  ], edges: [{ from: 'sanguo-media-accept', to: 'next' }] }
}

test('schema 162 adds final-track transfer proof to only the managed accept function and review contract', () => {
  const source = savedWorkflow(), upgraded = upgradeNarrationTransferWorkflow(source)
  assert.equal(upgraded.schemaVersion, 162)
  assert.equal(upgraded.nodes[0], source.nodes[0])
  assert.equal(upgraded.nodes[3], source.nodes[3])
  assert.equal(upgraded.edges, source.edges)
  assert.match(upgraded.nodes[1].code!, /INDEPENDENT_NARRATION_TRANSFER_GATE_SCHEMA162/)
  assert.match(upgraded.nodes[1].code!, /independent-track-transfer-v1/)
  assert.match(upgraded.nodes[1].code!, /before\n\/\/ PRINCIPLE_POLICY_START/)
  assert.match(upgraded.nodes[1].code!, /\/\/ PRINCIPLE_POLICY_END\nafter$/)
  assert.match(upgraded.nodes[2].prompt!, /independent-track-0/)
  assert.match(upgraded.nodes[2].prompt!, /before\n【duration-v2逐节拍完成证据】/)
  assert.match(upgraded.nodes[2].prompt!, /【duration-v2逐节拍完成证据结束】\nafter$/)
  assert.equal(upgradeNarrationTransferWorkflow(upgraded), upgraded)
  assert.equal(source.schemaVersion, 161)
})

test('ambiguous or edited saved policy is left for explicit review', () => {
  const source = savedWorkflow()
  for (const mutate of [
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.nodes[1].code = workflow.nodes[1].code!.replace('PRINCIPLE_DURATION_V2_GATE_SCHEMA159', 'custom gate') },
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.nodes[1].code = workflow.nodes[1].code!.replace('return completion;', 'const completion=(function assessDurationCompletion() {})();\nreturn completion;') },
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.nodes[2].prompt = workflow.nodes[2].prompt!.replace('audio.evidenceIds只引用真实video_evidence.audioObservations.id或可靠speechValidation.alignment的speech-0等编号。', 'custom review') },
  ]) {
    const candidate = structuredClone(source)
    mutate(candidate)
    assert.equal(upgradeNarrationTransferWorkflow(candidate), candidate)
  }
})
