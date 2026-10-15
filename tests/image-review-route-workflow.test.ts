import test from 'node:test'
import assert from 'node:assert/strict'
import { executeCodeNode } from '../server/code-node.ts'
import { refreshPendingImageReviewRouteRuns, upgradeImageReviewRouteWorkflow } from '../src/image-review-route-workflow.ts'
import { branchConfigurationErrors, routeBranch } from '../src/workflow-branch.ts'
import { renderRetryFeedbackPrompt } from '../src/workflow-template.ts'

test('failed image reviews route back to their own generator and retain feedback', async () => {
  const ids = ['sanguo-coverage-first-frame', 'sanguo-coverage-review', 'sanguo-coverage-approval',
    'sanguo-scene-cut-first-frame', 'sanguo-scene-cut-review', 'sanguo-scene-cut-approval']
  const nodes = [{ id: 'sanguo-scene-loop', kind: 'loop', childIds: ids, resultVar: 'scenes' },
    ...ids.map(id => ({ id, kind: id.endsWith('first-frame') ? 'image' : id.endsWith('review') ? 'text' : 'http',
      title: id, resultVar: id === 'sanguo-coverage-review' ? 'coverage_review' : id === 'sanguo-scene-cut-review' ? 'scene_cut_review' : id,
      position: { x: 0, y: 0 }, acceptance: id === 'sanguo-coverage-review' ? { maxAttempts: 3 } : undefined }))]
  const original = { id: 'wf-sanguo-history-drama', schemaVersion: 190, nodes, edges: [
    { id: 'c0', from: ids[0], to: ids[1] }, { id: 'c1', from: ids[1], to: ids[2] },
    { id: 's0', from: ids[3], to: ids[4] }, { id: 's1', from: ids[4], to: ids[5] },
  ] }
  const workflow = upgradeImageReviewRouteWorkflow(original)
  assert.equal(workflow.schemaVersion, 192)
  assert.equal(upgradeImageReviewRouteWorkflow(workflow), workflow)
  assert.deepEqual(branchConfigurationErrors(workflow), [])
  assert.equal(workflow.nodes.find(node => node.id === ids[1])?.acceptance, undefined)
  const managed = workflow.nodes.find(node => node.id === 'sanguo-coverage-review-route')!
  const oldCode = managed.code!.replace(/if \(context\.input\?\.qualityDisposition[\s\S]*?retryCount: branch\.counts\.false \+ 1 };\n/, '')
  const pending = [{ node: { ...managed, code: oldCode }, status: 'idle' },
    { node: { ...managed, code: oldCode }, status: 'success' },
    { node: { id: 'sanguo-coverage-approval', kind: 'http', params: [] }, status: 'failed' }]
  const refreshed = refreshPendingImageReviewRouteRuns(workflow, pending)
  assert.equal(refreshed[0].node.code, managed.code)
  assert.equal(refreshed[1].node.code, oldCode)
  assert.equal(refreshed[2].node.params?.length, 1)
  for (const [imageId, reviewId, approvalId, resultVar] of [
    [ids[0], ids[1], ids[2], 'coverage_review'], [ids[3], ids[4], ids[5], 'scene_cut_review'],
  ]) {
    const decision = workflow.nodes.find(node => node.id === `${reviewId}-route`)!
    assert.equal(workflow.edges.find(edge => edge.from === decision.id && edge.branch === 'false')?.to, imageId)
    assert.equal(workflow.edges.find(edge => edge.from === decision.id && edge.branch === 'true')?.to, approvalId)
    const report = { passed: false, issues: ['人物身份不符'], hardChecks: { identityConsistent: false }, version: 'review-v1' }
    const output = await executeCodeNode({ code: decision.code!, context: { [resultVar]: report,
      branch: { visits: 0, counts: { true: 0, false: 0 } } } })
    const image = workflow.nodes.find(node => node.id === imageId)!
    const review = workflow.nodes.find(node => node.id === reviewId)!
    const approval = workflow.nodes.find(node => node.id === approvalId)!
    const run = (node: typeof image, status: string, output?: unknown) => ({ id: node.id, node,
      status, output, context: {}, inputContext: {}, durationMs: 1, loopGroupId: 'scene-loop-1', loopIndex: 3 })
    const runs = [run(image, 'success', { url: '/generated/old.png' }), run(review, 'success', report),
      run(decision, 'running'), run(approval, 'idle')]
    const routed = routeBranch(workflow, runs, 2, output, { [resultVar]: report })
    assert.equal(routed.index, 0)
    assert.equal(routed.runs[0].status, 'idle')
    assert.deepEqual((routed.runs[0].retryFeedback as { issues: string[] }).issues, report.issues)
    const prompt = renderRetryFeedbackPrompt(routed.runs[0].retryFeedback)
    assert.match(prompt, /具名人物的脸、发须、衣甲以各自已标明人物姓名的三视图为准/)
    assert.match(prompt, /人物身份不符/)
    assert.equal(routed.runs[3].status, 'idle')
    assert.equal(routed.history.to, imageId)
    let repeated = routed
    for (let attempt = 2; attempt <= 5; attempt++) {
      const retryRuns = repeated.runs.map((item, at) => ({ ...item,
        status: at < 2 ? 'success' : at === 2 ? 'running' : 'idle',
        output: at === 1 ? report : item.output }))
      const retryOutput = await executeCodeNode({ code: decision.code!, context: { [resultVar]: report,
        branch: retryRuns[2].branchState } })
      repeated = routeBranch(workflow, retryRuns, 2, retryOutput, { [resultVar]: report })
      assert.equal(repeated.index, 0)
      assert.equal(repeated.runs[2].branchState?.counts.false, attempt)
      assert.equal(repeated.runs[3].status, 'idle')
    }
    assert.equal((await executeCodeNode({ code: decision.code!, context: { [resultVar]: { ...report, passed: true, issues: [] },
      branch: { visits: 1, counts: { true: 0, false: 1 } } } }) as { value: boolean }).value, true)
    if (reviewId === 'sanguo-coverage-review') {
      const advisory = await executeCodeNode({ code: decision.code!, context: { [resultVar]: report,
        input: { qualityDisposition: 'manual-review-v1' }, branch: { visits: 7, counts: { true: 0, false: 6 } } } }) as { advisory: boolean; retryCount: number; qualityRisks: unknown[] }
      assert.equal(advisory.advisory, true)
      assert.equal(advisory.retryCount, 7)
      assert.deepEqual(advisory.qualityRisks, report.issues)
    }
  }
})
