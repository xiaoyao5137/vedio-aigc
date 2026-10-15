import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareA8B6LocalV8RouterFork } from
  '../scripts/fork-original-shot1-a8b6-local-v8-fresh-router.mjs'

const parentId = 'record-4x5m31-a8b6-local-wall-v8'
const imageUrl = '/generated/source-bound-v8.png'
const imageSha = 'a'.repeat(64)
const md5 = 'b'.repeat(32)
const certificate = { signature: 'source-bound-v8-certificate' }

function fixture() {
  const ids = Array.from({ length: 72 }, (_, index) =>
    index === 45 ? 'sanguo-scene-cut-first-frame'
      : index === 49 ? 'sanguo-scene-cut-review'
        : index === 50 ? 'sanguo-scene-cut-approval'
          : index === 51 ? 'sanguo-video-reference-router'
            : `node-${index}`)
  const nodes = ids.map(id => ({ id, kind: 'code', resultVar: id,
    params: [] }))
  const context = { scene_cut_frame_gate: { signature: certificate.signature },
    first_frame: { url: imageUrl }, shot_script: { duration: 14 } }
  const nodeRuns = Array.from({ length: 464 }, (_, index) => ({
    node: nodes[index % nodes.length],
    status: index <= 50 ? 'success' : 'idle', context, loopIndex: 0,
    ...(index === 45 ? { output: { url: imageUrl } } : {}),
    ...(index === 49 ? { output: { passed: true, issues: [] } } : {}),
    ...(index === 50 ? { output: certificate } : {}),
    ...(index === 51 ? { routeInputContext: context } : {}),
  }))
  const state = { id: parentId, generationScopeId: parentId,
    requestScopeId: 'original-shot-request',
    sceneCutA8B6LocalFrameRecovery: {
      version: 'scene-cut-a8b6-local-first-frame-v8',
      outputUrl: imageUrl, outputSha256: imageSha },
    nodeRuns, logs: [] }
  const row = { id: parentId, workflow_id: 'wf-sanguo-history-drama',
    result_md5: md5, result: state }
  const workflow = { id: row.workflow_id, schema_version: 180,
    nodes_md5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    edges_md5: '1d0a75acb3d4778a122a4cfd96a23b49',
    nodes, edges: [] }
  const signed = { approvalSha256: 'c'.repeat(64), approval: {
    version: 'scene-cut-a8b6-local-workflow-approval-v8',
    approvalState: 'approved-local-first-frame-before-A-request',
    frameProvenanceVariant: 'a8b6-local-composite-v8',
    approvalExecutionId: parentId, approvalResultMd5: md5,
    planId: 'd'.repeat(64), approvedFirstFrameUrl: imageUrl,
    approvedFirstFrameSha256: imageSha, frameCertificate: certificate } }
  return { row, workflow, signed }
}

test('V8 router forks only the signed node50 prefix and leaves node51 idle', () => {
  const { row, workflow, signed } = fixture()
  const { state, marker } = prepareA8B6LocalV8RouterFork(row, workflow,
    signed)
  assert.equal(state.id, 'record-4x5m31-a8b6-local-v8-router-v1')
  assert.equal(state.parentExecutionId, parentId)
  assert.equal(marker.frameProvenanceVariant, 'a8b6-local-composite-v8')
  assert.equal(marker.imageApprovalResultMd5, md5)
  assert.equal(marker.workflowApprovalSha256, signed.approvalSha256)
  assert.deepEqual(state.nodeRuns.slice(0, 51), row.result.nodeRuns.slice(0, 51))
  assert.equal(state.nodeRuns[51].node.id, 'sanguo-video-reference-router')
  assert.ok(state.nodeRuns.slice(51).every(run => run.status === 'idle'
    && run.output === undefined))
})

test('V8 router rejects changed approval, frame verdict or resumed downstream node', () => {
  const changedApproval = fixture()
  changedApproval.signed.approval.approvalResultMd5 = 'f'.repeat(32)
  assert.throws(() => prepareA8B6LocalV8RouterFork(
    changedApproval.row, changedApproval.workflow,
    changedApproval.signed), /ROUTER_FORK_INVALID/)

  const failedReview = fixture()
  failedReview.row.result.nodeRuns[49].output = { passed: false,
    issues: [{ code: 'face_identity_changed' }] }
  assert.throws(() => prepareA8B6LocalV8RouterFork(
    failedReview.row, failedReview.workflow,
    failedReview.signed), /frozen at node50/)

  const resumed = fixture()
  resumed.row.result.nodeRuns[52].status = 'success'
  assert.throws(() => prepareA8B6LocalV8RouterFork(
    resumed.row, resumed.workflow, resumed.signed), /frozen at node50/)
})
