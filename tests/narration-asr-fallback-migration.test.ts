import test from 'node:test'
import assert from 'node:assert/strict'
import { assessDurationCompletion } from '../src/duration-completion.ts'
import { previousNarrationAsrCompletionSource, upgradeNarrationAsrFallbackWorkflow } from '../src/narration-asr-fallback-migration.ts'

const CALL = ')(context.shot_script,context.video_evidence,context.media_review);'

function savedWorkflow() {
  const prior = previousNarrationAsrCompletionSource()
  assert.ok(prior)
  return { id: 'wf-sanguo-history-drama', schemaVersion: 163, nodes: [
    { id: 'sanguo-media-accept', code: `outside-before\n// PRINCIPLE_POLICY_START\n// INDEPENDENT_NARRATION_TRANSFER_GATE_SCHEMA162\nconst completion=(${prior}${CALL}\nreturn completion;\n// PRINCIPLE_POLICY_END\noutside-after` },
    { id: 'sanguo-media-review', prompt: 'review prompt is owned elsewhere' },
    { id: 'sanguo-video', code: 'paid media adapter stays unchanged' },
  ], edges: [{ from: 'sanguo-media-accept', to: 'next' }] }
}

test('schema 164 changes only the exact managed duration completion function', () => {
  const source = savedWorkflow(), upgraded = upgradeNarrationAsrFallbackWorkflow(source)
  assert.equal(upgraded.schemaVersion, 164)
  assert.equal(upgraded.nodes[1], source.nodes[1])
  assert.equal(upgraded.nodes[2], source.nodes[2])
  assert.equal(upgraded.edges, source.edges)
  const before = source.nodes[0].code!, after = upgraded.nodes[0].code!
  const prefix = before.slice(0, before.indexOf('const completion=(') + 'const completion=('.length)
  const suffix = before.slice(before.indexOf(CALL))
  assert.equal(after, prefix + assessDurationCompletion.toString() + suffix)
  assert.match(after, /isolated-source-asr-v3/)
  assert.match(after, /outside-before\n\/\/ PRINCIPLE_POLICY_START/)
  assert.match(after, /\/\/ PRINCIPLE_POLICY_END\noutside-after$/)
  assert.equal(upgradeNarrationAsrFallbackWorkflow(upgraded), upgraded)
  assert.equal(source.schemaVersion, 163)
})

test('schema 164 refuses a custom, duplicate, missing or out-of-scope saved function', () => {
  const source = savedWorkflow()
  for (const mutate of [
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.schemaVersion = 162 },
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.id = 'other-workflow' },
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.nodes[0].code = workflow.nodes[0].code!.replace("sourceAsr.method === 'isolated-source-asr-v2'", "sourceAsr.method === 'custom'") },
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.nodes[0].code = workflow.nodes[0].code!.replace('// INDEPENDENT_NARRATION_TRANSFER_GATE_SCHEMA162', '// custom marker') },
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.nodes[0].code = workflow.nodes[0].code!.replace('// PRINCIPLE_POLICY_END', 'const completion=(function assessDurationCompletion() {})(context.shot_script,context.video_evidence,context.media_review);\n// PRINCIPLE_POLICY_END') },
    (workflow: ReturnType<typeof savedWorkflow>) => { workflow.nodes[0].code = workflow.nodes[0].code!.replace('// PRINCIPLE_POLICY_END', '// missing end') },
  ]) {
    const candidate = structuredClone(source)
    mutate(candidate)
    assert.equal(upgradeNarrationAsrFallbackWorkflow(candidate), candidate)
  }
})

test('a separate legacy assessor outside the managed block is preserved byte for byte', () => {
  const source = savedWorkflow()
  source.nodes[0].code += '\nconst completion=(function assessDurationCompletion() { return { legacy: true }; })(context.shot_script,context.video_evidence,context.media_review);'
  const upgraded = upgradeNarrationAsrFallbackWorkflow(source)
  assert.equal(upgraded.schemaVersion, 164)
  assert.ok(upgraded.nodes[0].code!.endsWith('const completion=(function assessDurationCompletion() { return { legacy: true }; })(context.shot_script,context.video_evidence,context.media_review);'))
})
