import test from 'node:test'
import assert from 'node:assert/strict'
import { routeBranch, type BranchRun, type RouteEdge } from '../src/workflow-branch.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'
import { migrateBranchWorkflow } from '../src/branch-migration.ts'

const node = (id: string, kind = 'text') => ({ id, kind, title: id, resultVar: id, prompt: 'Review ${candidate}', code: 'return {}', position: { x: 0, y: 0 },
  params: [] as Array<{ id: string; name: string; englishName?: string; type: string; value: string; required: boolean }> })
const groupParameter = (value: unknown = ['local-review', 'primary-review']) => ({ id: 'group-param', name: '复核组', englishName: 'reviewRetryTargets', type: 'json', value: JSON.stringify(value), required: true })
const error = 'REVIEW_RESULT_INVALID: worldState.position must use actual scene anchors'
const localReport = { items: [{ requirementId: 'r1', status: 'complete', evidence: 'actual hands in frame' }], count: 1 }
const primaryReport = { passed: false, issues: ['an unsupported refusal'], worldState: { position: 'screen center' }, raw: { preserved: 'provider response' } }

function fixture() {
  const loop = { ...node('loop', 'loop'), loop: { itemVar: 'item' }, childIds: ['paid', 'local-review', 'primary-review', 'gate', 'error-branch'] }
  const nodes = [node('paid', 'video'), node('local-review'), node('primary-review'), node('gate', 'code'), { ...node('error-branch', 'branch'), params: [groupParameter()] }, node('done', 'code')]
  const edges: RouteEdge[] = [{ id: 'rewind', from: 'error-branch', to: 'local-review', branch: 'false' }, { id: 'forward', from: 'error-branch', to: 'done', branch: 'true' }]
  const context = { candidate: { id: 'candidate-current', characters: ['Actor'] }, 'local-review': localReport, 'primary-review': primaryReport }
  const current: BranchRun[] = nodes.map((node, index) => ({ id: `${node.id}-current`, node, status: index < 4 ? 'success' : 'idle', durationMs: 1,
    context, inputContext: { candidate: context.candidate }, loopNode: loop, loopGroupId: 'L', loopIndex: 1, loopItem: { id: 'current' },
    output: index === 0 ? { url: 'paid.mp4' } : index === 1 ? localReport : index === 2 ? primaryReport : index === 3 ? { routeError: error } : undefined }))
  const earlier = { ...current[2], id: 'primary-earlier', loopIndex: 0, output: { passed: true, earlier: true } }
  const later = { ...current[2], id: 'primary-later', loopIndex: 2, status: 'idle', output: undefined }
  return { workflow: { nodes, edges }, runs: [earlier, ...current, later], context, branchIndex: 5, localIndex: 2, primaryIndex: 3 }
}

test('attributed group error reaches only its owner, with that execution report, and survives context rebuilding', () => {
  const f = fixture(), before = structuredClone(f.runs)
  const otherError = 'REVIEW_RESULT_INVALID: local frame index missing'
  const feedback = { kind: 'report-format', error: error + '\n' + otherError,
    diagnostics: [{ reportResultVar: 'primary-review', error, field: 'worldState.position' }] }
  const result = routeBranch(f.workflow, f.runs, f.branchIndex, { value: false, feedback }, f.context)
  assert.equal(result.index, f.localIndex, 'the actual edge still controls the rewind')
  assert.equal(result.runs[f.localIndex].retryFeedback, undefined, 'do not give a primary error to the local reviewer')
  const own = result.runs[f.primaryIndex].retryFeedback as Record<string, unknown>
  assert.equal(own.reportResultVar, 'primary-review')
  assert.equal(own.attribution, 'explicit')
  assert.equal(own.error, error)
  assert.doesNotMatch(JSON.stringify(own), /local frame index missing/)
  assert.deepEqual(own.previousReport, { passed: false, issues: primaryReport.issues, worldState: primaryReport.worldState })
  assert.deepEqual(own.diagnostics, feedback.diagnostics)
  assert.equal(result.runs[0].retryFeedback, undefined)
  assert.equal(result.runs.at(-1)!.retryFeedback, undefined)
  assert.equal(result.runs[1], f.runs[1], 'paid prefix is untouched')
  assert.equal(result.runs[f.primaryIndex].routeInputContext, undefined, 'no old route snapshot is restored for a group successor')
  const newLocalReport = { items: [{ status: 'complete', evidence: 'new real review' }] }
  result.runs[f.localIndex] = { ...result.runs[f.localIndex], status: 'success', output: newLocalReport, context: { candidate: f.context.candidate, 'local-review': newLocalReport } }
  const next = prepareWorkflowRunContext(result.runs, f.primaryIndex)!.inputContext
  assert.deepEqual(next['local-review'], newLocalReport)
  assert.equal((next.retry as { feedback: unknown }).feedback, own)
  assert.match(renderRetryFeedbackPrompt((next.retry as { feedback: unknown }).feedback), /worldState\.position must use actual scene anchors/)
  assert.equal(result.runs[f.branchIndex].branchState!.counts.false, 1, 'the existing retry budget is retained')
  assert.deepEqual(f.runs, before, 'original reports, raw provider response and run history are immutable')
  assert.deepEqual(result.history.scene![f.primaryIndex].output, primaryReport)
})

test('legacy unassigned report errors give each reviewer its own draft without declaring either guilty', () => {
  const f = fixture()
  // The context contains a stale report; group provenance must use the matching run.
  const context = { ...f.context, 'primary-review': { passed: true, stale: true } }
  const result = routeBranch(f.workflow, f.runs, f.branchIndex, { value: false, feedback: { kind: 'report-format', error } }, context)
  const local = result.runs[f.localIndex].retryFeedback as Record<string, unknown>
  const primary = result.runs[f.primaryIndex].retryFeedback as Record<string, unknown>
  assert.equal(local.reportResultVar, 'local-review'); assert.equal(primary.reportResultVar, 'primary-review')
  assert.deepEqual(local.previousReport, localReport)
  assert.deepEqual(primary.previousReport, { passed: false, issues: primaryReport.issues, worldState: primaryReport.worldState })
  for (const feedback of [local, primary]) {
    assert.equal(feedback.attribution, 'unassigned')
    assert.match(String(feedback.instruction), /不代表本报告一定有错/)
    assert.match(String(feedback.instruction), /只核对自己负责的报告与原始证据/)
  }
  assert.notEqual(local, primary)
  assert.equal(result.runs.at(-1)!.retryFeedback, undefined)
})

test('multiple attributed errors remain scoped and an absent current report is not borrowed from context', () => {
  const f = fixture()
  f.runs[f.localIndex] = { ...f.runs[f.localIndex], status: 'idle', output: undefined }
  const feedback = { kind: 'report-format', error, diagnostics: [
    { reportResultVar: 'local-review', error: 'attachment index is invalid', requirementId: 'r1' },
    { reportResultVar: 'primary-review', error },
  ] }
  const result = routeBranch(f.workflow, f.runs, f.branchIndex, { value: false, feedback }, f.context)
  const local = result.runs[f.localIndex].retryFeedback as Record<string, unknown>
  assert.equal(local.previousReportAvailable, false)
  assert.equal(local.previousReport, undefined)
  assert.equal(local.error, 'REVIEW_RESULT_INVALID: attachment index is invalid')
  assert.doesNotMatch(JSON.stringify(local), /worldState/)
  assert.doesNotMatch(JSON.stringify(result.runs[f.primaryIndex].retryFeedback), /attachment index/)
})

test('group configuration and diagnostic ownership fail explicitly instead of falling back to a wrong reviewer', () => {
  const cases: Array<{ value?: unknown; change?: (f: ReturnType<typeof fixture>) => void; diagnostics?: unknown }> = [
    { value: [] }, { value: ['local-review', 'local-review'] }, { value: ['missing'] }, { value: ['paid'] }, { value: ['done'] },
    { value: 'local-review' }, { value: [' primary-review'] },
    { change: f => { f.runs[f.branchIndex].node.params = [{ ...groupParameter(), value: '{broken' }] } },
    { change: f => { f.runs[f.primaryIndex].loopIndex = 9 } },
    { change: f => { f.workflow.nodes[2].resultVar = f.workflow.nodes[1].resultVar } },
    { diagnostics: [] }, { diagnostics: [{ reportResultVar: 'outside', error }] }, { diagnostics: [{ reportResultVar: 'primary-review', error: '' }] },
  ]
  for (const item of cases) {
    const f = fixture()
    if (Object.hasOwn(item, 'value')) f.runs[f.branchIndex].node.params = [groupParameter(item.value)]
    item.change?.(f)
    const before = structuredClone(f.runs)
    assert.throws(() => routeBranch(f.workflow, f.runs, f.branchIndex, { value: false, feedback: { kind: 'report-format', error,
      ...(Object.hasOwn(item, 'diagnostics') ? { diagnostics: item.diagnostics } : {}) } }, f.context), /REVIEW_RETRY_CONFIG_INVALID/)
    assert.deepEqual(f.runs, before)
  }
})

test('normal forward routing does not distribute review feedback; effective branch parameters and overrides are honored', () => {
  const f = fixture()
  const forward = routeBranch(f.workflow, f.runs, f.branchIndex, { value: true }, f.context)
  assert.equal(forward.runs[f.localIndex].retryFeedback, undefined)
  assert.equal(forward.runs[f.primaryIndex].retryFeedback, undefined)
  for (const mode of ['inputs', 'override']) {
    const fresh = fixture()
    if (mode === 'inputs') fresh.runs[fresh.branchIndex].inputs = { reviewRetryTargets: ['primary-review'] }
    else fresh.runs[fresh.branchIndex].paramOverrides = { 'group-param': '["primary-review"]' }
    const result = routeBranch(fresh.workflow, fresh.runs, fresh.branchIndex, { value: false, feedback: error }, fresh.context)
    assert.equal(result.runs[fresh.localIndex].retryFeedback, undefined)
    assert.equal((result.runs[fresh.primaryIndex].retryFeedback as Record<string, unknown>).reportResultVar, 'primary-review')
  }
})

test('legacy gate migration persists the editable review group and keeps the actual back edge', () => {
  const local = node('local-review'), primary = node('primary-review')
  const gate = { ...node('gate', 'code'), errorRetry: { retryFrom: local.id, maxAttempts: 4, patterns: ['REVIEW_RESULT_INVALID:'], reviewRetryTargets: [local.id, primary.id] } }
  const workflow = { nodes: [local, primary, gate, node('done', 'code')], edges: [{ id: 'end', from: gate.id, to: 'done' }] }
  const migrated = migrateBranchWorkflow(workflow)
  const branch = migrated.nodes.find(node => node.id === 'gate-error-branch')!
  assert.deepEqual(JSON.parse(branch.params.find(param => param.englishName === 'reviewRetryTargets')!.value), [local.id, primary.id])
  assert.equal(migrated.edges.find(edge => edge.from === branch.id && edge.branch === 'false')!.to, local.id)
  assert.equal(migrateBranchWorkflow(migrated), migrated)
})
