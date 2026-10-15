import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { executeCodeNode } from '../server/code-node.ts'
import { upgradePrincipleDurationWorkflow } from '../src/principle-duration-migration.ts'
import { upgradeNativeSequenceQualityWorkflow } from '../src/native-sequence-quality-migration.ts'

type Param = { id: string; englishName?: string; name: string; type: string; value: string }
type Node = { id: string; code?: string; params?: Param[]; [key: string]: unknown }
type Workflow = { id: string; schemaVersion: number; nodes: Node[];
  edges: Array<{ from: string; to: string; branch?: string }>; [key: string]: unknown }
const saved159 = () => upgradePrincipleDurationWorkflow(JSON.parse(readFileSync(
  new URL('../public/data/sanguo-default-workflow.json', import.meta.url), 'utf8')) as Workflow)
const node = (workflow: Workflow, id: string) => workflow.nodes.find(item => item.id === id)!
const count = (code: string, quality: number) => [...code.matchAll(new RegExp(`quality\\s*:\\s*${quality}\\b`, 'g'))].length

test('schema 159 native sequence migration changes exactly eight q95 literals and one managed retry limit', () => {
  const saved = saved159(), before = structuredClone(saved)
  assert.equal(saved.schemaVersion, 159)
  const migrated = upgradeNativeSequenceQualityWorkflow(saved)
  assert.equal(migrated.schemaVersion, 160)
  assert.deepEqual(saved, before)
  assert.deepEqual(migrated.nodes.filter((item, index) => JSON.stringify(item) !== JSON.stringify(saved.nodes[index])).map(item => item.id),
    ['sanguo-media-metrics', 'sanguo-media-accept', 'sanguo-media-accept-error-branch'])
  for (const id of ['sanguo-media-metrics', 'sanguo-media-accept']) {
    const oldCode = String(node(saved, id).code), newCode = String(node(migrated, id).code)
    assert.equal(count(oldCode, 95), 4)
    assert.equal(count(newCode, 95), 0)
    assert.equal(count(newCode, 90), 4)
    assert.equal(newCode.replace(/(quality\s*:\s*)90\b/g, (_, prefix: string) => `${prefix}95`), oldCode,
      'all other serialized code bytes must be preserved')
  }
  const oldBranch = node(saved, 'sanguo-media-accept-error-branch')
  const newBranch = node(migrated, oldBranch.id)
  assert.equal(newBranch.code, oldBranch.code)
  assert.deepEqual(newBranch.params?.map((param, index) => ({ ...param, value: oldBranch.params![index].value })), oldBranch.params)
  assert.equal(newBranch.params?.find(param => param.id === 'principle-maxAttempts')?.value, '2')
  assert.deepEqual(migrated.edges, saved.edges)
  assert.equal(upgradeNativeSequenceQualityWorkflow(migrated), migrated)
})

test('saved review error route allows one native same-source retry, then stops before paid video', async () => {
  const graph = upgradeNativeSequenceQualityWorkflow(saved159()), branch = node(graph, 'sanguo-media-accept-error-branch')
  const params = Object.fromEntries((branch.params ?? []).map(param => [param.englishName ?? param.name,
    param.type === 'number' ? Number(param.value) : param.type === 'json' ? JSON.parse(param.value) : param.value]))
  const falseEdges = graph.edges.filter(edge => edge.from === branch.id && edge.branch === 'false')
  assert.deepEqual(falseEdges.map(edge => edge.to), ['sanguo-media-request'])
  assert.equal(graph.edges.some(edge => edge.from === branch.id && edge.to === 'sanguo-video'), false)
  const retryPlan = { sourceUrl: '/generated/paid-source.mp4', round: 1, sampleTimes: [0, 3, 8] }
  const context = { video_shot: { routeError: 'REVIEW_RESULT_INVALID: need native process frames', samplingRetryPlan: retryPlan },
    video_take: { url: retryPlan.sourceUrl }, branch: { counts: { false: 0 } } }
  const first = await executeCodeNode({ code: branch.code!, params, context })
  assert.equal(first.value, false)
  assert.deepEqual(first.contextPatch, { mediaSamplingRetry: retryPlan })
  await assert.rejects(() => executeCodeNode({ code: branch.code!, params,
    context: { ...context, branch: { counts: { false: 1 } } } }), /异常复核达到上限 2/)
})

test('divergent q95 or retry route keeps schema 159 and user code untouched', () => {
  for (const change of [
    (graph: Workflow) => { node(graph, 'sanguo-media-metrics').code = String(node(graph, 'sanguo-media-metrics').code).replace('quality: 95', 'quality: 92') },
    (graph: Workflow) => { node(graph, 'sanguo-media-accept-error-branch').params!.find(param => param.id === 'principle-maxAttempts')!.value = '4' },
    (graph: Workflow) => { graph.edges.find(edge => edge.from === 'sanguo-media-accept-error-branch' && edge.branch === 'false')!.to = 'sanguo-video' },
  ]) {
    const graph = saved159()
    change(graph)
    assert.equal(upgradeNativeSequenceQualityWorkflow(graph), graph)
  }
})
