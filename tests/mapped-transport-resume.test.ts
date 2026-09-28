import test from 'node:test'
import assert from 'node:assert/strict'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { mapNodeInputs, MapInputItemError } from '../src/node-map.ts'
import { modelRequestFingerprint } from '../server/model-request-key.ts'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'
import { routeBranch, type BranchRun } from '../src/workflow-branch.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'

const exhausted = 'HTTP 503: ' + JSON.stringify({ error: {
  type: 'MODEL_TRANSPORT_EXHAUSTED', message: '文本上游 HTTP 503，已尝试 3 次；可恢复当前节点继续。',
  upstream: { error: 'upstream timeout' }, retryExhausted: true,
} })
const mappedError = (cause: string) => new MapInputItemError('media_metrics.frames', 0, new Error(cause)).message
const mapInput = { sourcePath: 'media_metrics.frames', itemVar: 'frame', concurrency: 3 }
const failedRun = () => ({
  node: { id: 'observe', kind: 'text', mapInput }, status: 'failed', revision: 7, attempt: 3, errorAttempt: 2,
  error: mappedError(exhausted), output: { error: mappedError(exhausted) }, context: { obsolete: true },
  retryFeedback: { kind: 'report-format', error: 'REVIEW_RESULT_INVALID: 补充实际观察依据' },
  routeInputOverrides: { detail: 'explicit current input' }, paramOverrides: { temperature: '0' },
})

test('mapped transport resume keeps the current request and inputs while invalidating dependants', () => {
  const failed = failedRun(), original = structuredClone(failed)
  const paid = { ...failedRun(), node: { id: 'video', kind: 'video', mapInput }, status: 'success' }
  const downstream = { ...failedRun(), node: { ...failed.node, id: 'downstream' } }
  const runs = [paid, failed, downstream]
  const resumed = manualRetryRuns(runs, 1)
  assert.equal(resumed[0], paid)
  assert.equal(resumed[1].status, 'idle')
  assert.equal(resumed[1].attempt, 3)
  assert.equal(resumed[1].errorAttempt, 2)
  assert.equal(resumed[1].revision, 7)
  assert.equal(resumed[1].retryFeedback, failed.retryFeedback)
  assert.equal(resumed[1].routeInputOverrides, failed.routeInputOverrides)
  assert.equal(resumed[1].paramOverrides, failed.paramOverrides)
  assert.equal(resumed[1].output, undefined)
  assert.equal(resumed[1].error, undefined)
  assert.deepEqual(resumed[1].context, {})
  assert.equal(resumed[2].revision, 8, 'only the selected failed transport can retain its identity')
  assert.equal(resumed[2].attempt, 1)
  assert.equal(resumed[2].retryFeedback, undefined)
  assert.equal(resumed[2].routeInputOverrides, undefined)
  assert.deepEqual(failed, original, 'the original execution record remains intact')
})

test('completed siblings are reused after transport failure and changed inputs still miss the fingerprint', async () => {
  const model = { id: 'reviewer', provider: 'Custom', capability: 'text', settings: { endpoint: 'https://example.test/messages', model: 'test' } }
  const cache = new Map<string, unknown>(), calls: number[] = []
  const frames = ['/generated/a.jpg', '/generated/b.jpg', '/generated/c.jpg', '/generated/d.jpg']
  const run = failedRun()
  const execute = (current: ReturnType<typeof failedRun>, rubric = 'observe') => mapNodeInputs(mapInput, { media_metrics: { frames } }, async (context, index) => {
    // This identity is the mapped executionId + node/loop identity used by App.tsx.
    const requestKey = `scope:attempt-${current.attempt ?? 1}:revision-${current.revision ?? 0}:item-${index}:observe:0:scene`
    const fingerprint = modelRequestFingerprint({ model,
      prompt: rubric + renderRetryFeedbackPrompt(current.retryFeedback), params: { reviewImages: [context.frame] } })
    const key = requestKey + ':' + fingerprint
    if (cache.has(key)) return cache.get(key)
    calls.push(index)
    if (calls.length === 1) throw new Error(exhausted)
    const output = { index, url: context.frame }
    cache.set(key, output)
    return output
  })
  await assert.rejects(execute(run), error => error instanceof MapInputItemError && error.message === run.error)
  assert.deepEqual(calls, [0, 1, 2], 'drain already-started siblings without submitting later items')
  const resumed = manualRetryRuns([run], 0)[0]
  assert.deepEqual(await execute(resumed), { items: frames.map((url, index) => ({ index, url })), count: 4 })
  assert.deepEqual(calls, [0, 1, 2, 0, 3], 'only the failed and not-yet-submitted frames call the model')
  await execute(resumed, 'changed observation rubric')
  assert.deepEqual(calls.slice(5), [0, 1, 2, 3], 'request identity alone cannot reuse evidence under changed instructions')
})

test('transport resume retains a real branch context patch while replaying current upstream results', () => {
  const loopNode = { id: 'loop', kind: 'loop', loop: { itemVar: 'scene' } }
  const nodes = [
    { id: 'metrics', kind: 'code', resultVar: 'media_metrics' },
    { id: 'observe', kind: 'text', resultVar: 'observations', mapInput },
    { id: 'retry', kind: 'branch', resultVar: 'observation_retry' },
  ]
  const currentMetrics = { frames: ['/generated/current.jpg'] }
  const previousMetrics = { frames: ['/generated/obsolete.jpg'] }
  const base = { observationRubric: 'original instructions', media_metrics: previousMetrics }
  type Run = BranchRun & { loopNode: typeof loopNode }
  const runs: Run[] = nodes.map(node => ({ id: node.id, node, status: 'success', durationMs: 1,
    context: { ...base, media_metrics: currentMetrics }, inputContext: base,
    output: node.id === 'metrics' ? currentMetrics : { oldReport: true },
    loopGroupId: 'group', loopIndex: 0, loopNode, loopItem: { id: 'scene' }, attempt: 1, revision: 0,
  }))
  const workflow = { nodes, edges: [{ id: 'retry-observe', from: 'retry', to: 'observe', branch: 'false' as const }] }
  const transition = routeBranch(workflow, runs, 2, { value: false, feedback: 'same review feedback',
    contextPatch: { observationRubric: 'corrected explicit instructions', mediaSamplingRetry: { round: 2 } } }, base)
  const index = transition.index
  const failed = { ...transition.runs[index], status: 'failed', error: mappedError(exhausted) }
  const checkpoint = transition.runs.map((run, i) => i === index ? failed : run)
  const before = prepareWorkflowRunContext(checkpoint, index)!.inputContext
  const resumed = manualRetryRuns(checkpoint, index)
  const after = prepareWorkflowRunContext(resumed, index)!.inputContext
  assert.equal(before.observationRubric, 'corrected explicit instructions')
  assert.deepEqual(before.mediaSamplingRetry, { round: 2 })
  assert.deepEqual(before.media_metrics, currentMetrics, 'current completed metrics replace the stale route snapshot')
  assert.deepEqual(after, before, 'resuming the same request must preserve every derived prompt input')
  assert.equal(resumed[index].routeInputContext, failed.routeInputContext)
  assert.equal(resumed[index].attempt, failed.attempt)
  assert.equal(resumed[index].revision, failed.revision)
  assert.equal(resumed[index].branchState, undefined)
  assert.equal(resumed[index].branchEntryTarget, undefined)
  assert.equal(resumed[index].branchCarry, undefined)
  assert.equal(resumed[index + 1].routeInputContext, undefined, 'dependent state is still invalidated')

  const qualityFailed = checkpoint.map((run, i) => i === index ? { ...run, error: mappedError('REVIEW_RESULT_INVALID: 缺少画面依据') } : run)
  assert.equal(manualRetryRuns(qualityFailed, index)[index].routeInputContext, undefined,
    'a quality retry retains the existing fresh-run cleanup')
})

test('only recognized outer transport errors retain mapped request identity, including legacy default counters', () => {
  for (const cause of [exhausted, 'NODE_RESPONSE_INCOMPLETE: 本地服务未返回完整节点结果',
    'Failed to fetch', 'TypeError: Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.',
    'socket hang up', 'read ECONNRESET']) {
    const resumed = manualRetryRuns([{ ...failedRun(), error: mappedError(cause), attempt: undefined, revision: undefined }], 0)[0]
    assert.equal(resumed.attempt, undefined, cause)
    assert.equal(resumed.revision, undefined, cause)
  }
})

test('quality failures, invalid config, non-mapped nodes and deliberate reruns keep fresh request identities', () => {
  const failed = failedRun()
  const errors = [
    'REVIEW_RESULT_INVALID: 报告缺少字段，引用 MODEL_TRANSPORT_EXHAUSTED、Failed to fetch 不能作为证据',
    'REVIEW_IMAGES_INVALID: 审查只接受本地 JPEG 帧', 'MAP_CONFIG_INVALID: 未配置来源',
    'HTTP 503: {"error":"MODEL_TRANSPORT_EXHAUSTED"}',
    'HTTP 503: {"error":{"type":"MODEL_TRANSPORT_EXHAUSTED","retryExhausted":false}}',
    'HTTP 401: {"error":{"type":"MODEL_TRANSPORT_EXHAUSTED","retryExhausted":true}}',
    'HTTP 503: <html>upstream failed</html>', 'MODEL_RESPONSE_INVALID: Failed to fetch',
  ]
  const cases = [
    ...errors.map(error => ({ ...failed, error: mappedError(error) })),
    { ...failed, error: exhausted },
    { ...failed, status: 'success' },
    { ...failed, node: { ...failed.node, kind: 'video' } },
    { ...failed, node: { ...failed.node, mapInput: undefined } },
  ]
  for (const source of cases) {
    const resumed = manualRetryRuns([source], 0)[0]
    assert.equal(resumed.revision, 8, JSON.stringify(source))
    assert.equal(resumed.attempt, 1)
    assert.equal(resumed.retryFeedback, undefined)
    assert.equal(resumed.routeInputOverrides, undefined)
  }
})
