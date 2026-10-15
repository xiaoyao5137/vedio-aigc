import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeNativePrincipleReviewWorkflow } from '../src/native-principle-review-migration.ts'

const oldCode = `// PRINCIPLE_POLICY_START
if (params.qualityMode === 'principle-v1') {
try {
return principleMediaQuality.mediaMetrics(context,params);
} catch (error) { return {passed:false,routeError:error.message}; }
}
// PRINCIPLE_POLICY_END`
const saved = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 162, nodes: [
  { id: 'sanguo-media-metrics', code: oldCode, params: [] },
  { id: 'sanguo-media-review', params: [
    { id: 'review-images', name: 'reviewImages', englishName: 'reviewImages', type: 'json', value: '${video_evidence.frames}', required: true },
    { id: 'user-option', name: 'temperature', englishName: 'temperature', type: 'number', value: '0', required: true },
  ] },
  { id: 'unrelated', code: 'return 1', params: [] },
] })

test('schema 163 binds the principle native-frame sequence to a complete 2x2 review transport', () => {
  const source = saved(), next = upgradeNativePrincipleReviewWorkflow(source)
  assert.equal(next.schemaVersion, 163)
  assert.deepEqual(source, saved(), 'source configuration remains untouched')
  assert.equal(next.nodes[2], source.nodes[2], 'unrelated node is preserved by identity')
  const metrics = next.nodes[0].code!, review = next.nodes[1]
  assert.match(metrics, /NATIVE_PRINCIPLE_SEQUENCE_GRID_SCHEMA163/)
  assert.deepEqual(review.params?.slice(0, 2), source.nodes[1].params)
  assert.deepEqual(review.params?.at(-1), { id: 'native-principle-reviewImageDetail', name: 'reviewImageDetail',
    englishName: 'reviewImageDetail', type: 'json', value: '${media_metrics.nativeReviewImageDetail}', required: false })
  const frames = Array.from({ length: 4 }, (_, index) => `/generated/native-${index}.jpg`)
  const refs = frames.map((url, index) => ({ evidenceIndex: index, nativeFrameIndex: index,
    url, second: index / 24, pts: index, timeBase: '1/24' }))
  const context = { shot_script: { pacing: { version: 'duration-v2' } }, video_evidence: {
    frames, frameTimes: refs.map(ref => ref.second), frameReferences: refs,
    nativeSequence: { preservedSamples: [{ evidenceIndex: 0, nativeFrameIndex: 0 }] },
  } }
  const run = new Function('context', 'params', 'principleMediaQuality', metrics) as (
    context: unknown, params: unknown, runtime: { mediaMetrics: () => object }) => Record<string, unknown>
  const output = run(context, { qualityMode: 'principle-v1' }, { mediaMetrics: () => ({ reviewImageDetail: 'original', policy: 'kept' }) })
  const detail = output.nativeReviewImageDetail as { transport: { mode: string }; frameMetadata: unknown[] }
  assert.equal(output.policy, 'kept')
  assert.equal(output.reviewImageDetail, 'original', 'legacy field is not repurposed')
  assert.equal(detail.transport.mode, 'sequence-grid')
  assert.equal(detail.frameMetadata.length, 4)
  assert.equal(run({ ...context, video_evidence: { frames, frameTimes: refs.map(ref => ref.second) } },
    { qualityMode: 'principle-v1' }, { mediaMetrics: () => ({ reviewImageDetail: 'original' }) }).nativeReviewImageDetail, undefined)
  assert.equal(upgradeNativePrincipleReviewWorkflow(next), next)
})

test('divergent review code or parameters remain untouched', () => {
  for (const edit of [
    (graph: ReturnType<typeof saved>) => { graph.nodes[0].code = 'return userCode(context)' },
    (graph: ReturnType<typeof saved>) => { graph.nodes[1].params = [] },
    (graph: ReturnType<typeof saved>) => { graph.nodes[1].params![0].value = '${my.frames}' },
    (graph: ReturnType<typeof saved>) => { graph.nodes[1].params!.push({ id: 'my-detail', name: 'reviewImageDetail', englishName: 'reviewImageDetail', type: 'json', value: '${custom.detail}', required: false }) },
  ]) {
    const graph = saved()
    edit(graph)
    assert.equal(upgradeNativePrincipleReviewWorkflow(graph), graph)
  }
})
