import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRetryContextPatch } from '../src/retry-context.ts'
import { migrateBranchWorkflow, reportFormatRetryBranchReturn, REPORT_FORMAT_FEEDBACK_RETURN } from '../src/branch-migration.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { routeBranch, type BranchRun } from '../src/workflow-branch.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { applyNodeOutputToContext } from '../src/workflow-core.ts'

const resolvers = [resolveRetryContextPatch, new Function(`return (${resolveRetryContextPatch.toString()})`)() as typeof resolveRetryContextPatch]
const sources = { mediaSamplingRetry: ['video_shot.samplingRetryPlan', 'mediaSamplingRetry'] }
const round1 = { sourceUrl: '/paid.mp4', round: 1, sampleTimes: [0, 2, 4] }
const round2 = { sourceUrl: '/paid.mp4', round: 2, sampleTimes: [0, 1, 2, 3, 4] }

test('retry context selects the first present source, deep copies JSON and explicitly clears absent fields', () => {
  for (const resolve of resolvers) {
    const context = { video_shot: { samplingRetryPlan: round2 }, mediaSamplingRetry: round1 }
    const before = structuredClone(context), next = resolve(context, sources)
    assert.deepEqual(next, { mediaSamplingRetry: round2 })
    assert.notEqual(next.mediaSamplingRetry, round2)
    assert.notEqual((next.mediaSamplingRetry as typeof round2).sampleTimes, round2.sampleTimes)
    assert.deepEqual(resolve({ mediaSamplingRetry: round2 }, sources), { mediaSamplingRetry: round2 })
    assert.deepEqual(resolve({ video_shot: { samplingRetryPlan: null } }, sources), { mediaSamplingRetry: null })
    assert.deepEqual(resolve(context), {})
    assert.deepEqual(resolve(context, {}), {})
    assert.deepEqual(context, before)
    assert.deepEqual(resolve({ a: false, b: 0, c: '', list: [{ value: 9 }] }, { falseValue: ['missing', 'a'], zero: ['b'], empty: ['c'], arrayItem: ['list.0.value'] }),
      { falseValue: false, zero: 0, empty: '', arrayItem: 9 })
  }
})

test('retry context rejects unsafe targets, prototype paths and malformed configuration without reading inherited data', () => {
  const invalid: unknown[] = [null, [], 'source', { key: [] }, { key: 'a.b' }, { key: ['a..b'] }, { key: ['a. b'] }, { key: ['a.__proto__.b'] },
    { key: ['constructor.name'] }, { key: ['a.prototype.x'] }, { 'a.b': ['safe'] }, { ' spaced': ['safe'] }, { '': ['safe'] }, JSON.parse('{"__proto__":["safe"]}'), { prototype: ['safe'] }, { constructor: ['safe'] }]
  for (const resolve of resolvers) {
    for (const source of invalid) assert.throws(() => resolve({ safe: 1 }, source as Record<string, string[]>), /RETRY_CONTEXT_INVALID/)
    assert.deepEqual(resolve({ safe: 1 }, { out: ['toString'] }), { out: null }, 'inherited object properties are not workflow sources')
    const cyclic: Record<string, unknown> = {};cyclic.self = cyclic
    assert.throws(() => resolve({ cyclic }, { out: ['cyclic'] }), /来源值不能序列化为 JSON/)
    assert.throws(() => resolve({ big: 1n }, { out: ['big'] }), /来源值不能序列化为 JSON/)
  }
})

const node = (id: string, kind = 'code') => ({ id, kind, title: id, resultVar: id, prompt: '', code: 'return {}', position: { x: 0, y: 0 },
  params: [] as Array<{ id: string; name: string; englishName?: string; type: string; required: boolean; value: string }> })
function workflow(configured: boolean) {
  const gate = { ...node('video_shot'), errorRetry: { retryFrom: 'request', patterns: ['REVIEW_RESULT_INVALID:'], maxAttempts: 4,
    reviewRetryTargets: ['local_review', 'primary_review'], ...(configured ? { retryContextSources: sources } : {}) } }
  const nodes = [node('video_take', 'video'), node('request'), node('local_review', 'text'), node('primary_review', 'text'), gate, node('tail')]
  return migrateBranchWorkflow({ nodes, edges: nodes.slice(1).map((n, i) => ({ id: `edge-${i}`, from: nodes[i].id, to: n.id })) })
}

test('only configured legacy error branches gain the context parameter and self-contained code return', async () => {
  assert.equal(reportFormatRetryBranchReturn(), REPORT_FORMAT_FEEDBACK_RETURN)
  const ordinary = workflow(false).nodes.find(node => node.id === 'video_shot-error-branch')!
  const configured = workflow(true).nodes.find(node => node.id === 'video_shot-error-branch')!
  assert.ok(ordinary.code.endsWith(REPORT_FORMAT_FEEDBACK_RETURN))
  assert.equal(ordinary.code.includes('resolveRetryContextPatch'), false)
  assert.equal(ordinary.params.some(param => param.englishName === 'retryContextSources'), false)
  assert.equal(configured.code, ordinary.code.replace(REPORT_FORMAT_FEEDBACK_RETURN, reportFormatRetryBranchReturn(true)))
  assert.deepEqual(JSON.parse(configured.params.find(param => param.englishName === 'retryContextSources')!.value), sources)
  const context = { video_shot: { routeError: 'REVIEW_RESULT_INVALID: need more evidence', samplingRetryPlan: round2 }, mediaSamplingRetry: round1, branch: { counts: { false: 0 } } }
  const params = { maxAttempts: 4, patterns: ['REVIEW_RESULT_INVALID:'], retryContextSources: sources }
  const output = await executeCodeNode({ code: configured.code, context, params })
  assert.deepEqual(output.contextPatch, { mediaSamplingRetry: round2 })
  assert.deepEqual(output.feedback, { kind: 'report-format', error: context.video_shot.routeError })
  assert.equal((await executeCodeNode({ code: ordinary.code, context, params })).contextPatch, undefined)
})

test('real generated branch preserves the newest sampling plan through an older request snapshot and keeps paid output and budget', async () => {
  const w = workflow(true), branchIndex = w.nodes.findIndex(node => node.id === 'video_shot-error-branch')
  const branch = w.nodes[branchIndex], loop = { id: 'loop', kind: 'loop', loop: { itemVar: 'shot' } }
  const seed = { mediaSamplingRetry: round2 }, paid = { url: '/paid.mp4' }
  let context: Record<string, unknown> = seed
  const runs: BranchRun[] = w.nodes.map((node, index) => {
    const inputContext = node.id === 'request' ? { mediaSamplingRetry: round1 } : context
    const output = node.id === 'video_take' ? paid : node.id === 'video_shot' ? { routeError: 'REVIEW_RESULT_INVALID: fix report' }
      : node.kind === 'text' ? { passed: true, issues: [], original: node.id } : {}
    context = applyNodeOutputToContext(context, node.resultVar, output)
    return { id: node.id, node, inputContext, context, output, status: index < branchIndex ? 'success' : 'idle', durationMs: 1,
      loopNode: loop, loopGroupId: 'same-loop', loopIndex: 0, loopItem: { id: 'shot' }, ...(index === branchIndex ? { branchState: { visits: 2, counts: { true: 1, false: 1 } } } : {}) }
  })
  const prepared = prepareWorkflowRunContext(runs, branchIndex)!
  const output = await executeCodeNode({ code: branch.code, context: prepared.inputContext, params: { maxAttempts: 4, patterns: ['REVIEW_RESULT_INVALID:'], retryContextSources: sources } })
  const result = routeBranch(w, runs, branchIndex, output, prepared.inputContext)
  const request = prepareWorkflowRunContext(result.runs, result.index)!
  assert.equal(request.run.node.id, 'request')
  assert.deepEqual(request.inputContext.mediaSamplingRetry, round2)
  assert.equal(result.runs[0], runs[0])
  assert.equal(request.inputContext.video_take, paid)
  assert.equal(result.runs[branchIndex].branchState!.counts.false, 2)
  for (const id of ['local_review', 'primary_review']) {
    const review = result.runs.find(run => run.node.id === id)!
    assert.equal((review.retryFeedback as { previousReport: { original: string } }).previousReport.original, id)
  }
})
