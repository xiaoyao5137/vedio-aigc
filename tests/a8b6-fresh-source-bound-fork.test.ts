import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { parseFreshSourceBoundForkArgs } from
  '../scripts/fork-original-shot1-a8b6-fresh-composite.mjs'
import { prepareFreshA8B6SourceBoundFork,
  expectedFreshA8B6RouterBinding } from
  '../server/staged-scene-cut-a8b6-fresh-source-bound-fork.mjs'

const plan = 'a'.repeat(64)
const manifestSha = 'b'.repeat(64)
const receiptSha = 'c'.repeat(64)
const sourceMd5 = 'd'.repeat(32)
const imageMd5 = 'e'.repeat(32)
const nodesMd5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const edgesMd5 = '1d0a75acb3d4778a122a4cfd96a23b49'

test('V9 A retake reuses only its certified parent router binding', () => {
  const parentApproval = 'f'.repeat(64)
  assert.deepEqual(expectedFreshA8B6RouterBinding({
    version: 'staged-a8b6-fresh-A-plan-v1', planId: plan,
    workflowApprovalSha256: manifestSha,
  }), { planId: plan, workflowApprovalSha256: manifestSha })
  assert.deepEqual(expectedFreshA8B6RouterBinding({
    version: 'staged-a8b6-fresh-A-plan-v2', planId: '0'.repeat(64),
    workflowApprovalSha256: manifestSha,
    source: { frameProvenanceVariant: 'a8b6-local-composite-v9' },
    retake: { parentPlanId: plan,
      parentWorkflowApprovalSha256: parentApproval },
  }), { planId: plan, workflowApprovalSha256: parentApproval })
  assert.deepEqual(expectedFreshA8B6RouterBinding({
    version: 'staged-a8b6-fresh-A-plan-v3', planId: '1'.repeat(64),
    workflowApprovalSha256: manifestSha,
    source: { frameProvenanceVariant: 'a8b6-local-composite-v9' },
    retake: { parentPlanId: plan,
      parentWorkflowApprovalSha256: parentApproval },
    bRetake: { parentPlanId: '0'.repeat(64),
      parentManifestSha256: '2'.repeat(64),
      parentAAcceptanceSha256: '3'.repeat(64),
      parentBRejectionSha256: '4'.repeat(64),
      parentWorkflowApprovalSha256: manifestSha },
  }), { planId: plan, workflowApprovalSha256: parentApproval })
  const previousChild = { planId: '5'.repeat(64),
    manifestSha256: '6'.repeat(64), approvalSha256: '7'.repeat(64),
    phaseBPlanSha256: '8'.repeat(64), requestSha256: '9'.repeat(64),
    taskId: '934079221507838016', taskSha256: 'a'.repeat(64),
    mediaSha256: 'b'.repeat(64), videoSha256: 'c'.repeat(64),
    rejectionSha256: 'd'.repeat(64) }
  const second = { version: 'staged-a8b6-fresh-A-plan-v3',
    planId: '1'.repeat(64), workflowApprovalSha256: manifestSha,
    source: { frameProvenanceVariant: 'a8b6-local-composite-v9' },
    retake: { parentPlanId: plan,
      parentWorkflowApprovalSha256: parentApproval },
    bRetake: { parentPlanId: '0'.repeat(64),
      parentManifestSha256: '2'.repeat(64),
      parentAAcceptanceSha256: '3'.repeat(64),
      parentBRejectionSha256: '4'.repeat(64),
      parentWorkflowApprovalSha256: manifestSha, previousChild } }
  assert.deepEqual(expectedFreshA8B6RouterBinding(second), {
    planId: plan, workflowApprovalSha256: parentApproval })
  const third = { ...second, planId: '6'.repeat(64),
    bRetake: { ...second.bRetake, retakeOrdinal: 3,
      previousChild: { ...previousChild, planId: '7'.repeat(64),
        rejectionSha256: '8'.repeat(64) } } }
  assert.deepEqual(expectedFreshA8B6RouterBinding(third), {
    planId: plan, workflowApprovalSha256: parentApproval })
  assert.throws(() => expectedFreshA8B6RouterBinding({ ...third,
    bRetake: { ...third.bRetake,
      previousChild: { ...third.bRetake.previousChild,
        mediaSha256: '' } } }), /previous B-only child binding missing/)
  assert.throws(() => expectedFreshA8B6RouterBinding({ ...second,
    bRetake: { ...second.bRetake,
      previousChild: { ...previousChild, rejectionSha256: '' } } }),
  /previous B-only child binding missing/)
  assert.throws(() => expectedFreshA8B6RouterBinding({
    version: 'staged-a8b6-fresh-A-plan-v3', planId: '1'.repeat(64),
    workflowApprovalSha256: manifestSha,
    source: { frameProvenanceVariant: 'a8b6-local-composite-v9' },
    retake: { parentPlanId: plan,
      parentWorkflowApprovalSha256: parentApproval },
    bRetake: { parentPlanId: '0'.repeat(64),
      parentManifestSha256: '2'.repeat(64),
      parentAAcceptanceSha256: '3'.repeat(64),
      parentBRejectionSha256: '5'.repeat(64),
      parentWorkflowApprovalSha256: '4'.repeat(64) },
  }), /B retake parent A plan/)
  assert.throws(() => expectedFreshA8B6RouterBinding({
    version: 'staged-a8b6-fresh-A-plan-v2', planId: '0'.repeat(64),
    source: { frameProvenanceVariant: 'a8b6-local-composite-v8' },
    retake: { parentPlanId: plan,
      parentWorkflowApprovalSha256: parentApproval },
  }), /V9 certified first frame/)
})

test('fresh composite fork apply needs reviewed router, image, signed receipt and graph CAS', () => {
  const base = ['--source', 'record-router', '--plan', plan]
  assert.equal(parseFreshSourceBoundForkArgs(base).apply, false)
  assert.throws(() => parseFreshSourceBoundForkArgs([...base, '--apply']),
    /requires child ID, router\/image CAS, receipt and graph hashes/)
  const pinned = [...base, '--id', 'record-composite',
    '--expected-source-md5', sourceMd5,
    '--expected-image-md5', imageMd5,
    '--expected-manifest-sha256', manifestSha,
    '--expected-receipt-sha256', receiptSha,
    '--expected-nodes-md5', nodesMd5,
    '--expected-edges-md5', edgesMd5, '--apply']
  assert.equal(parseFreshSourceBoundForkArgs(pinned).receiptSha256,
    receiptSha)
  assert.throws(() => parseFreshSourceBoundForkArgs([...pinned,
    '--expected-receipt-sha256', receiptSha]), /duplicate/)
  assert.throws(() => parseFreshSourceBoundForkArgs(pinned.map(value =>
    value === nodesMd5 ? 'f'.repeat(32) : value)), /malformed/)
})

test('fresh composite checkpoint refuses absent receipt before touching a record', () => {
  assert.throws(() => prepareFreshA8B6SourceBoundFork(null, null,
    null, null), /record identity, signed receipt or schema180 graph changed/)
  const source = { id: 'record-router', result_md5: sourceMd5,
    workflow_id: 'wf-sanguo-history-drama' }
  const image = { id: 'record-image', result_md5: imageMd5,
    workflow_id: 'wf-sanguo-history-drama' }
  const workflow = { id: 'wf-sanguo-history-drama', schema_version: 180,
    nodes_md5: nodesMd5, edges_md5: edgesMd5,
    nodes: Array.from({ length: 72 }), edges: Array.from({ length: 87 }) }
  assert.throws(() => prepareFreshA8B6SourceBoundFork(source, image,
    workflow, { manifestSha256: manifestSha }),
  /record identity, signed receipt or schema180 graph changed/)
})

test('V8 composite checkpoint refuses a router outside its signed V8 frame lineage', () => {
  const source = { id: 'record-router', result_md5: sourceMd5,
    workflow_id: 'wf-sanguo-history-drama',
    result: { id: 'record-router', sceneCutA8B6FreshRouterRecovery: {} } }
  const image = { id: 'record-image', result_md5: imageMd5,
    workflow_id: 'wf-sanguo-history-drama', result: { id: 'record-image' } }
  const workflow = { id: 'wf-sanguo-history-drama', schema_version: 180,
    nodes_md5: nodesMd5, edges_md5: edgesMd5,
    nodes: Array.from({ length: 72 }), edges: Array.from({ length: 87 }) }
  const verified = { manifestSha256: manifestSha, receiptSha256: receiptSha,
    manifest: { planId: plan, workflowApprovalSha256: manifestSha,
      source: { frameProvenanceVariant: 'a8b6-local-composite-v8' } },
    receipt: {} }
  assert.throws(() => prepareFreshA8B6SourceBoundFork(source, image,
    workflow, verified), /V8 approved frame and router provenance changed/)
})

test('V9 composite checkpoint refuses a router outside its signed V9 frame lineage', () => {
  const source = { id: 'record-router', result_md5: sourceMd5,
    workflow_id: 'wf-sanguo-history-drama',
    result: { id: 'record-router', sceneCutA8B6FreshRouterRecovery: {} } }
  const image = { id: 'record-image', result_md5: imageMd5,
    workflow_id: 'wf-sanguo-history-drama', result: { id: 'record-image' } }
  const workflow = { id: 'wf-sanguo-history-drama', schema_version: 180,
    nodes_md5: nodesMd5, edges_md5: edgesMd5,
    nodes: Array.from({ length: 72 }), edges: Array.from({ length: 87 }) }
  const verified = { manifestSha256: manifestSha, receiptSha256: receiptSha,
    manifest: { planId: plan, workflowApprovalSha256: manifestSha,
      source: { frameProvenanceVariant: 'a8b6-local-composite-v9' } },
    receipt: {} }
  assert.throws(() => prepareFreshA8B6SourceBoundFork(source, image,
    workflow, verified), /V9 approved frame and router provenance changed/)
})

test('missing signed A/B receipt stops V8 fork CLI before database access', () => {
  const command = new URL('../scripts/fork-original-shot1-a8b6-fresh-composite.mjs',
    import.meta.url)
  const result = spawnSync(process.execPath, [command.pathname,
    '--source', 'record-4x5m31-a8b6-local-v8-router-v1',
    '--plan', 'f'.repeat(64)], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /signed A\/B composite receipt unavailable or invalid/)
})

test('missing signed A/B receipt stops V9 fork CLI before database access', () => {
  const command = new URL('../scripts/fork-original-shot1-a8b6-fresh-composite.mjs',
    import.meta.url)
  const result = spawnSync(process.execPath, [command.pathname,
    '--source', 'record-4x5m31-a8b6-local-v9-router-v1',
    '--plan', 'f'.repeat(64)], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /signed A\/B composite receipt unavailable or invalid/)
})
