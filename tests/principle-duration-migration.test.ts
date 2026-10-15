import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { upgradePrincipleDurationWorkflow } from '../src/principle-duration-migration.ts'

type Node = { id: string; code?: string; prompt?: string; [key: string]: unknown }
type Workflow = { id: string; schemaVersion: number; nodes: Node[]; [key: string]: unknown }
const savedGraph = () => JSON.parse(readFileSync(new URL('../public/data/sanguo-default-workflow.json', import.meta.url), 'utf8')) as Workflow
const node = (workflow: Workflow, id: string) => workflow.nodes.find(item => item.id === id)!
const end = '// PRINCIPLE_POLICY_END'

test('schema 158 graph upgrades only principle duration returns and review contract, preserving saved policy', () => {
  const saved = savedGraph(), original = structuredClone(saved)
  assert.equal(saved.schemaVersion, 158)
  const migrated = upgradePrincipleDurationWorkflow(saved)
  assert.equal(migrated.schemaVersion, 159)
  assert.deepEqual(saved, original, 'normalization must not mutate the persisted graph')
  assert.deepEqual(migrated.nodes.filter((item, index) => JSON.stringify(item) !== JSON.stringify(saved.nodes[index])).map(item => item.id),
    ['sanguo-media-request', 'sanguo-media-review', 'sanguo-media-accept'])
  for (const [id, anchor] of [
    ['sanguo-media-request', 'return principleMediaQuality.mediaRequest(context);'],
    ['sanguo-media-accept', 'return principleMediaQuality.acceptMedia(context,params);'],
  ]) {
    const before = String(node(saved, id).code), after = String(node(migrated, id).code)
    assert.equal(after.slice(0, after.indexOf('// PRINCIPLE_DURATION_V2_GATE_SCHEMA159')),
      before.slice(0, before.indexOf(anchor)), 'lean/manual policy before the final return must remain byte-identical')
    assert.equal(after.slice(after.indexOf(end)), before.slice(before.indexOf(end)), 'legacy code after managed END is untouched')
    assert.equal(after.split('// PRINCIPLE_DURATION_V2_GATE_SCHEMA159').length, 2)
  }
  const request = String(node(migrated, 'sanguo-media-request').code)
  const accept = String(node(migrated, 'sanguo-media-accept').code)
  assert.match(request.slice(0, request.indexOf(end)), /const durationRequest=/)
  assert.match(accept.slice(0, accept.indexOf(end)), /const completion=.*assessDurationCompletion/)
  assert.match(accept.slice(0, accept.indexOf(end)), /return \{\.\.\.accepted,durationCompletion:completion\}/)
  const prompt = String(node(migrated, 'sanguo-media-review').prompt)
  assert.equal(prompt.split('【duration-v2逐节拍完成证据】').length, 2)
  assert.equal(prompt.split('【duration-v2时间解释】').length, 2)
  assert.match(prompt, /duration-v2的必需节拍、先后顺序与收尾余量须另按完成证据契约评估/)
  assert.doesNotMatch(prompt, /小道具细节、节奏、尾部空等、剪辑余量、镜头美感都写warnings/)
  assert.deepEqual(upgradePrincipleDurationWorkflow(migrated), migrated)
})

test('existing completion section is refreshed once and custom legacy text is retained', () => {
  const graph = savedGraph(), review = node(graph, 'sanguo-media-review')
  review.prompt = String(review.prompt).replace('【原则质检结束】',
    '【duration-v2逐节拍完成证据】旧条款【duration-v2逐节拍完成证据结束】\n【duration-v2时间解释】旧解释\n编辑者附注\n【原则质检结束】')
  const migrated = upgradePrincipleDurationWorkflow(graph), prompt = String(node(migrated, 'sanguo-media-review').prompt)
  assert.equal(prompt.split('【duration-v2逐节拍完成证据】').length, 2)
  assert.equal(prompt.split('【duration-v2时间解释】').length, 2)
  assert.doesNotMatch(prompt, /旧条款|旧解释/)
  assert.match(prompt, /编辑者附注/)
})

test('unknown custom managed return is preserved without claiming schema 159', () => {
  const graph = savedGraph(), request = node(graph, 'sanguo-media-request')
  request.code = String(request.code).replace('return principleMediaQuality.mediaRequest(context);', 'return customMediaRequest(context);')
  assert.equal(upgradePrincipleDurationWorkflow(graph), graph)
})

test('coverage topology may have raised schema to 159 before the principle gate runs', () => {
  const graph = savedGraph()
  graph.schemaVersion = 159
  const migrated = upgradePrincipleDurationWorkflow(graph)
  assert.notEqual(migrated, graph)
  assert.equal(migrated.schemaVersion, 159)
  assert.match(String(node(migrated, 'sanguo-media-accept').code), /PRINCIPLE_DURATION_V2_GATE_SCHEMA159/)
  assert.equal(upgradePrincipleDurationWorkflow(migrated), migrated)
})
