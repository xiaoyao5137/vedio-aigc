import test from 'node:test'
import assert from 'node:assert/strict'
import { DRIVE_RECORD_PROJECTION_SQL, DRIVE_RECORD_TRIM_CHARS, assertSafeRestartServerTarget, completedProviderRegression, driveOutputSummary, driveRecord, failureSignature, isRetryFork, isTargetedRetryFork, loopTargetOutcome, parseRuntimeInputs, pendingManualDecision, runtimeInputMismatch, sameExecutionScope, targetOutcome, verifiedIdleContinuation, verifiedRetryTarget, verifiedSchema177IdleRecord, verifiedSchema178IdleRecord } from '../scripts/workflow-drive-state.mjs'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { encodeExecutionState } from '../src/execution-storage.ts'
import { executeCodeNode } from '../server/code-node.ts'
import pg from 'pg'
import process from 'node:process'

const nodeRun = (output: unknown, extra = {}) => ({ id: 'accept-loop-0', node: { id: 'accept', kind: 'code' }, status: 'success', revision: 0, loopIndex: 0, output, ...extra })
const record = (runs: unknown[], extra = {}) => driveRecord({ id: 'original', workflow_id: 'workflow', created_at: '2026-09-08T00:00:00Z', result: { nodeRuns: runs }, ...extra })

test('V7 router continuation requires the signed node50 parent and only node51 idle', () => {
  const parentId = 'record-4x5m31-a8b6-local-wall-v7'
  const marker = { version: 'scene-cut-a8b6-fresh-router-v1',
    imageApprovalExecutionId: parentId,
    imageApprovalResultMd5: 'a'.repeat(32),
    planId: 'b'.repeat(64), workflowApprovalSha256: 'c'.repeat(64),
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 51, preservedPrefixSha256: 'd'.repeat(64),
    firstPendingIndex: 51,
    firstPendingNodeId: 'sanguo-video-reference-router' }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 51 ? 'sanguo-video-reference-router' : `node-${index}`,
    status: index < 51 ? 'success' : 'idle', loopIndex: 0 }))
  const child = { id: 'record-4x5m31-a8b6-local-v7-router-v1',
    workflowId: 'wf-sanguo-history-drama', parentExecutionId: parentId,
    selectedNodeId: marker.firstPendingNodeId,
    sceneCutA8B6FreshRouterRecovery: marker, runs }
  for (const field of Object.keys(marker)) {
    assert.match(DRIVE_RECORD_PROJECTION_SQL, new RegExp(field))
    assert.equal(driveRecord({ id: child.id, workflow_id: child.workflowId,
      result: { sceneCutA8B6FreshRouterRecovery: marker, nodeRuns: [] } })
      .sceneCutA8B6FreshRouterRecovery[field], marker[field])
  }
  assert.equal(verifiedIdleContinuation(child, {
    workflowId: child.workflowId,
    nodeId: 'sanguo-video-reference-router' }), runs[51])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6FreshRouterRecovery: { ...marker,
      imageApprovalExecutionId: 'record-other' } }, {
    workflowId: child.workflowId,
    nodeId: 'sanguo-video-reference-router' }), /IDENTITY_MISMATCH/)
  const changed = structuredClone(child)
  changed.runs[52].status = 'success'
  assert.throws(() => verifiedIdleContinuation(changed, {
    workflowId: child.workflowId,
    nodeId: 'sanguo-video-reference-router' }), /IDENTITY_MISMATCH/)
})

test('V8 router resumes node51 only from the V8 signed image parent', () => {
  const parentId = 'record-4x5m31-a8b6-local-wall-v8'
  const marker = { version: 'scene-cut-a8b6-fresh-router-v1',
    frameProvenanceVariant: 'a8b6-local-composite-v8',
    imageApprovalExecutionId: parentId,
    imageApprovalResultMd5: 'a'.repeat(32),
    planId: 'b'.repeat(64), workflowApprovalSha256: 'c'.repeat(64),
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 51, preservedPrefixSha256: 'd'.repeat(64),
    firstPendingIndex: 51,
    firstPendingNodeId: 'sanguo-video-reference-router' }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 51 ? marker.firstPendingNodeId : `node-${index}`,
    status: index < 51 ? 'success' : 'idle', loopIndex: 0 }))
  const child = { id: 'record-4x5m31-a8b6-local-v8-router-v1',
    workflowId: 'wf-sanguo-history-drama', parentExecutionId: parentId,
    selectedNodeId: marker.firstPendingNodeId,
    sceneCutA8B6FreshRouterRecovery: marker, runs }
  for (const field of Object.keys(marker)) {
    assert.match(DRIVE_RECORD_PROJECTION_SQL, new RegExp(field))
    assert.equal(driveRecord({ id: child.id, workflow_id: child.workflowId,
      result: { sceneCutA8B6FreshRouterRecovery: marker, nodeRuns: [] } })
      .sceneCutA8B6FreshRouterRecovery[field], marker[field])
  }
  const target = { workflowId: child.workflowId,
    nodeId: marker.firstPendingNodeId }
  assert.equal(verifiedIdleContinuation(child, target), runs[51])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6FreshRouterRecovery: { ...marker,
      frameProvenanceVariant: 'a8b6-local-composite-v7' } }, target),
  /IDENTITY_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation({ ...child,
    parentExecutionId: 'record-4x5m31-a8b6-local-wall-v7' }, target),
  /IDENTITY_MISMATCH/)
  const changed = structuredClone(child)
  changed.runs[52].status = 'success'
  assert.throws(() => verifiedIdleContinuation(changed, target),
    /IDENTITY_MISMATCH/)
})

test('V9 router remains pinned to its own signed image parent', () => {
  const parentId = 'record-4x5m31-a8b6-local-wall-v9'
  const marker = { version: 'scene-cut-a8b6-fresh-router-v1',
    frameProvenanceVariant: 'a8b6-local-composite-v9',
    imageApprovalExecutionId: parentId,
    imageApprovalResultMd5: 'a'.repeat(32),
    planId: 'b'.repeat(64), workflowApprovalSha256: 'c'.repeat(64),
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 51, preservedPrefixSha256: 'd'.repeat(64),
    firstPendingIndex: 51,
    firstPendingNodeId: 'sanguo-video-reference-router' }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 51 ? marker.firstPendingNodeId : `node-${index}`,
    status: index < 51 ? 'success' : 'idle', loopIndex: 0 }))
  const child = { id: 'record-4x5m31-a8b6-local-v9-router-v1',
    workflowId: 'wf-sanguo-history-drama', parentExecutionId: parentId,
    selectedNodeId: marker.firstPendingNodeId,
    sceneCutA8B6FreshRouterRecovery: marker, runs }
  const target = { workflowId: child.workflowId,
    nodeId: marker.firstPendingNodeId }
  assert.equal(verifiedIdleContinuation(child, target), runs[51])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6FreshRouterRecovery: { ...marker,
      frameProvenanceVariant: 'a8b6-local-composite-v8' } }, target),
  /IDENTITY_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation({ ...child,
    parentExecutionId: 'record-4x5m31-a8b6-local-wall-v8' }, target),
  /IDENTITY_MISMATCH/)
})

test('fresh V9 composite checkpoint projects signed ancestry and resumes the first idle tail node', () => {
  const routerId = 'record-4x5m31-a8b6-local-v9-router-v1'
  const imageId = 'record-4x5m31-a8b6-local-wall-v9'
  const marker = { version: 'source-bound-composite-a8b6-fresh-first-shot-v1',
    stagingVariant: 'a8b6-fresh',
    frameProvenanceVariant: 'a8b6-local-composite-v9',
    sourceExecutionId: routerId, sourceResultMd5: 'a'.repeat(32),
    imageApprovalExecutionId: imageId,
    imageApprovalResultMd5: 'b'.repeat(32),
    imageApprovalPrefixLength: 51,
    imageApprovalPrefixSha256: 'c'.repeat(64),
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    originalExecutionId: 'record-4x5m31',
    planId: 'd'.repeat(64), manifestSha256: 'e'.repeat(64),
    receiptSha256: 'f'.repeat(64), workflowApprovalSha256: '1'.repeat(64),
    preservedPrefixLength: 52, preservedPrefixSha256: '2'.repeat(64),
    compositeVideoUrl: '/generated/fresh-a8b6-composed.mp4',
    compositeVideoSha256: '3'.repeat(64),
    compositeTakeSha256: '4'.repeat(64),
    firstPendingIndex: 53, firstPendingNodeId: 'sanguo-media-request' }
  const tailIds = [
    'sanguo-media-request', 'sanguo-video-evidence', 'sanguo-media-metrics',
    'sanguo-media-observe', 'sanguo-requirement-review', 'sanguo-media-review',
    'sanguo-media-accept', 'sanguo-duration-replan',
    'sanguo-media-accept-error-branch', 'sanguo-media-accept-accept-branch',
    'sanguo-video-concat', 'sanguo-last-frame',
  ]
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 52 ? 'sanguo-video'
      : tailIds[index - 53] ?? `node-${index}`,
    status: index < 53 ? 'success' : 'idle', loopIndex: 0 }))
  const child = { id: 'record-composite-v3-preview',
    workflowId: 'wf-sanguo-history-drama', parentExecutionId: routerId,
    selectedNodeId: 'sanguo-media-request',
    sceneCutCompositeRecovery: marker, runs }
  for (const field of Object.keys(marker)) {
    assert.match(DRIVE_RECORD_PROJECTION_SQL,
      new RegExp(`'${field}',result->'sceneCutCompositeRecovery'`))
    assert.equal(driveRecord({ id: child.id, workflow_id: child.workflowId,
      result: { sceneCutCompositeRecovery: marker, nodeRuns: [] } })
      .sceneCutCompositeRecovery[field], marker[field])
  }
  const target = { workflowId: child.workflowId,
    nodeId: 'sanguo-media-request' }
  assert.equal(verifiedIdleContinuation(child, target), runs[53])
  for (let nextIndex = 54; nextIndex <= 64; nextIndex++) {
    const advanced = runs.map((run, index) => index >= 53 && index < nextIndex
      ? { ...run, status: index === 55 ? 'skipped' : 'success' } : run)
    const next = { ...child, runs: advanced, selectedNodeId: advanced[nextIndex].id }
    const nextTarget = { ...target, nodeId: advanced[nextIndex].id }
    assert.equal(verifiedIdleContinuation(next, nextTarget), advanced[nextIndex])
    assert.equal(verifiedIdleContinuation({ ...next,
      selectedNodeId: advanced[nextIndex - 1].id }, nextTarget),
    advanced[nextIndex])
    assert.throws(() => verifiedIdleContinuation({ ...next,
      selectedNodeId: 'unrelated-node' }, nextTarget),
    /fresh composite continuation/)
    assert.throws(() => verifiedIdleContinuation(next, target), /fresh composite continuation/)
  }
  const at59 = { ...child,
    runs: runs.map((run, index) => index >= 53 && index < 59
      ? { ...run, status: 'success' } : run),
    selectedNodeId: tailIds[6] }
  const at59Target = { ...target, nodeId: tailIds[6] }
  for (const [index, status] of [[55, 'failed'], [57, 'running'], [58, 'idle']] as const)
    assert.throws(() => verifiedIdleContinuation({ ...at59,
      runs: at59.runs.map((run, runIndex) => runIndex === index
        ? { ...run, status } : run) }, at59Target), /fresh composite continuation/)
  assert.throws(() => verifiedIdleContinuation({ ...at59,
    runs: at59.runs.map((run, index) => index === 60
      ? { ...run, status: 'success' } : run) }, at59Target), /fresh composite continuation/)
  assert.throws(() => verifiedIdleContinuation({ ...at59,
    runs: at59.runs.map((run, index) => index === 60
      ? { ...run, id: 'changed-suffix' } : run) }, at59Target), /fresh composite continuation/)
  assert.throws(() => verifiedIdleContinuation({ ...at59,
    runs: at59.runs.map((run, index) => index === 59
      ? { ...run, id: 'wrong-target' } : run) }, at59Target), /fresh composite continuation/)
  assert.throws(() => verifiedIdleContinuation({ ...child,
    parentExecutionId: 'record-other' }, target), /fresh composite continuation/)
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutCompositeRecovery: { ...marker, receiptSha256: null } }, target),
  /fresh composite continuation/)
  assert.throws(() => verifiedIdleContinuation({ ...child,
    runs: runs.map((run, index) => index === 52
      ? { ...run, status: 'idle' } : run) }, target), /fresh composite continuation/)
  assert.throws(() => verifiedIdleContinuation({ ...child,
    runs: runs.map((run, index) => index === 54
      ? { ...run, status: 'success' } : run) }, target), /fresh composite continuation/)
})

test('nondefault app restart requires an independent explicit service label', () => {
  assert.doesNotThrow(() => assertSafeRestartServerTarget(
    'http://127.0.0.1:5174/', false, 'com.video-aigc.app', false))
  assert.doesNotThrow(() => assertSafeRestartServerTarget(
    'http://127.0.0.1:5173/', true, 'com.video-aigc.app', false))
  assert.throws(() => assertSafeRestartServerTarget(
    'http://127.0.0.1:5174/', true, 'com.video-aigc.app', false),
  /independent --service-label/)
  assert.throws(() => assertSafeRestartServerTarget(
    'http://127.0.0.1:5174/', true, 'com.video-aigc.app', true),
  /independent --service-label/)
  assert.doesNotThrow(() => assertSafeRestartServerTarget(
    'http://127.0.0.1:5174/', true, 'com.video-aigc.app-5174', true))
})

test('local V9 idle and approval gates bind the true V8 rejection', () => {
  const marker = {
    version: 'scene-cut-a8b6-local-first-frame-v9',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    priorLocalV8ExecutionId: 'record-4x5m31-a8b6-local-wall-v8',
    priorLocalV8ResultMd5: '78af4d43b6cec6f7e39f6e67122c2b87',
    priorLocalV8RejectedReviewSha256:
      'bb6825533ee8d4040edbe1ebbefde899c27b20c77e43b8c1e56ef98c90b53928',
    priorLocalV8ReviewModelExecutionId: 'model-run-mun4uzrd-fckgr7r',
    wallImageGenRawSha256: 'a'.repeat(64),
    sourceReceiptSha256: 'b'.repeat(64),
    outputSha256: 'c'.repeat(64),
    outputUrl: `/generated/image-${'c'.repeat(32)}.png`,
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 45,
    preservedPrefixSha256:
      '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00',
    firstPendingIndex: 46, firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256:
      '2bf1a767ac99e97c78ff50880aaa700f08d1eafdd842e86d4e22276bf40c7439',
  }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 46 ? 'sanguo-map-end-accept'
      : index === 50 ? 'sanguo-scene-cut-approval' : `node-${index}`,
    status: index < 46 ? 'success' : 'idle', loopIndex: 0 }))
  const child = { id: 'record-4x5m31-a8b6-local-wall-v9',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: marker.firstPendingNodeId,
    sceneCutA8B6LocalFrameRecovery: marker, runs }
  for (const field of ['priorLocalV8ExecutionId', 'priorLocalV8ResultMd5',
    'priorLocalV8RejectedReviewSha256', 'priorLocalV8ReviewModelExecutionId']) {
    assert.match(DRIVE_RECORD_PROJECTION_SQL, new RegExp(field))
    assert.equal(driveRecord({ id: child.id, workflow_id: child.workflowId,
      result: { sceneCutA8B6LocalFrameRecovery: marker, nodeRuns: [] } })
      .sceneCutA8B6LocalFrameRecovery[field], marker[field])
  }
  assert.equal(verifiedIdleContinuation(child, {
    workflowId: child.workflowId,
    nodeId: marker.firstPendingNodeId }), runs[46])
  const reviewed = runs.map((run, index) => index < 50
    ? { ...run, status: 'success', ...(index === 49
      ? { outputSummary: { hasOutput: true, rejectedFlag: null } } : {}) }
    : run)
  assert.equal(verifiedIdleContinuation({ ...child,
    selectedNodeId: 'sanguo-scene-cut-review', runs: reviewed }, {
    workflowId: child.workflowId,
    nodeId: 'sanguo-scene-cut-approval' }), reviewed[50])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6LocalFrameRecovery: { ...marker,
      priorLocalV8RejectedReviewSha256: '0'.repeat(64) } }, {
    workflowId: child.workflowId, nodeId: marker.firstPendingNodeId }),
  /IDENTITY_MISMATCH/)
})

test('local V8 idle and approval gates bind the rejected V7 review and signed wall', () => {
  const marker = {
    version: 'scene-cut-a8b6-local-first-frame-v8',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    priorLocalV7ExecutionId: 'record-4x5m31-a8b6-local-wall-v7',
    priorLocalV7ResultMd5: '1ec864753478fe0b6fbe6e2065be0835',
    priorLocalV7RejectedReviewSha256:
      'a12d43382d9800443dea140f1c0cd6102cdede9323d0a6a4ff3427a62b0f4698',
    priorLocalV7ReviewModelExecutionId: 'model-run-mun3j1q3-0x8y0hw',
    wallImageGenRawSha256:
      '3e185620ce34d0d98af75b032a1b1db9c15cd51cf649cbdcbab1ab3f180e4cc6',
    sourceReceiptSha256:
      'f8a614a81246365796f900b70dd436af7819e6b7414392e0b4fd6402e992832b',
    outputSha256:
      '8149dea0eb98744508ac0615d37d70dcede1d8859c25c0edf301909748a4fb90',
    outputUrl: '/generated/image-8149dea0eb98744508ac0615d37d70dc.png',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 45,
    preservedPrefixSha256:
      '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00',
    firstPendingIndex: 46,
    firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256:
      '142f11602d7b173385df92b08f6b9640ef2e97c9431d49a2190de4337d27a795',
  }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 46 ? 'sanguo-map-end-accept'
      : index === 50 ? 'sanguo-scene-cut-approval' : `node-${index}`,
    status: index < 46 ? 'success' : 'idle', loopIndex: 0,
  }))
  const child = { id: 'record-4x5m31-a8b6-local-wall-v8',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: 'sanguo-map-end-accept',
    sceneCutA8B6LocalFrameRecovery: marker, runs }
  for (const field of ['priorLocalV7ExecutionId', 'priorLocalV7ResultMd5',
    'priorLocalV7RejectedReviewSha256', 'priorLocalV7ReviewModelExecutionId']) {
    assert.match(DRIVE_RECORD_PROJECTION_SQL, new RegExp(field))
    assert.equal(driveRecord({ id: child.id, workflow_id: child.workflowId,
      result: { sceneCutA8B6LocalFrameRecovery: marker, nodeRuns: [] } })
      .sceneCutA8B6LocalFrameRecovery[field], marker[field])
  }
  assert.equal(verifiedIdleContinuation(child, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }), runs[46])
  const reviewed = runs.map((run, index) => index < 50
    ? { ...run, status: 'success', ...(index === 49
      ? { outputSummary: { hasOutput: true, rejectedFlag: null } } : {}) }
    : run)
  assert.equal(verifiedIdleContinuation({ ...child,
    selectedNodeId: 'sanguo-scene-cut-review', runs: reviewed }, {
    workflowId: child.workflowId,
    nodeId: 'sanguo-scene-cut-approval' }), reviewed[50])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6LocalFrameRecovery: { ...marker,
      priorLocalV7RejectedReviewSha256: '0'.repeat(64) } }, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }),
  /IDENTITY_MISMATCH/)
})

test('local V7 idle and approval gates bind the rejected V6 review and signed wall', () => {
  const marker = {
    version: 'scene-cut-a8b6-local-first-frame-v7',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    priorLocalV6ExecutionId: 'record-4x5m31-a8b6-local-wall-v6',
    priorLocalV6ResultMd5: 'dbe80e1e81015fcf6b3779aa23901261',
    priorLocalV6RejectedReviewSha256:
      'd780dbaf25f60b1596a158b5b1bb3f69f710640e17a37b42ed73d1a9dd665a76',
    priorLocalV6ReviewModelExecutionId: 'model-run-mun2bvxz-mmbkgki',
    wallImageGenRawSha256:
      '58334a7ad12d7d50ce44a2d89f0b9959e2a755c7f18ed4f18114eac51e2ab1fe',
    sourceReceiptSha256:
      '986763c1b90ec4b5482b4fa52dbadb42e825e3cf26ed5e28c0ac12a9b50c4e6d',
    outputSha256:
      '6b7e52ceccf7493bbb1a473ab4e0f68216aa65ae02c03945de5bc69fb52a6c71',
    outputUrl: '/generated/image-6b7e52ceccf7493bbb1a473ab4e0f682.png',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 45,
    preservedPrefixSha256:
      '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00',
    firstPendingIndex: 46,
    firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256:
      'd89c5588deb01c417c2af0574f0015e191ed15f50aef97e386f56d35a47f5b1f',
  }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 46 ? 'sanguo-map-end-accept'
      : index === 50 ? 'sanguo-scene-cut-approval' : `node-${index}`,
    status: index < 46 ? 'success' : 'idle', loopIndex: 0,
  }))
  const child = { id: 'record-4x5m31-a8b6-local-wall-v7',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: 'sanguo-map-end-accept',
    sceneCutA8B6LocalFrameRecovery: marker, runs }
  for (const field of ['priorLocalV6ExecutionId', 'priorLocalV6ResultMd5',
    'priorLocalV6RejectedReviewSha256', 'priorLocalV6ReviewModelExecutionId']) {
    assert.match(DRIVE_RECORD_PROJECTION_SQL, new RegExp(field))
    assert.equal(driveRecord({ id: child.id, workflow_id: child.workflowId,
      result: { sceneCutA8B6LocalFrameRecovery: marker, nodeRuns: [] } })
      .sceneCutA8B6LocalFrameRecovery[field], marker[field])
  }
  assert.equal(verifiedIdleContinuation(child, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }), runs[46])
  const reviewed = runs.map((run, index) => index < 50
    ? { ...run, status: 'success', ...(index === 49
      ? { outputSummary: { hasOutput: true, rejectedFlag: null } } : {}) }
    : run)
  assert.equal(verifiedIdleContinuation({ ...child,
    selectedNodeId: 'sanguo-scene-cut-review', runs: reviewed }, {
    workflowId: child.workflowId,
    nodeId: 'sanguo-scene-cut-approval' }), reviewed[50])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6LocalFrameRecovery: { ...marker,
      priorLocalV6RejectedReviewSha256: '0'.repeat(64) } }, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }),
  /IDENTITY_MISMATCH/)
})

test('local V6 idle gate binds V5 rejected workflow and projected ancestry', () => {
  const marker = {
    version: 'scene-cut-a8b6-local-first-frame-v6',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    priorLocalV5ExecutionId: 'record-4x5m31-a8b6-local-wall-v5',
    priorLocalV5ResultMd5: 'b83654e5a7ecf499fd866c5fe78689e0',
    priorLocalV5RejectedReviewSha256:
      'fba0e0ade93cb6210e91f6ca73495ce947508f60549d5350cce0c8766cfe7bef',
    priorLocalV5ReviewModelExecutionId: 'model-run-mun1hnww-cv9lzdx',
    wallImageGenRawSha256:
      'd5e50f7fa2b9b6e4dcbc046ddea613af9bd3bbdca938787e178c7abbf3d53fe9',
    sourceReceiptSha256:
      '93d5ac1040ab17e9dd68f3b2e9b4b3eed835d4ba3461fbd3ed117fc9c725dc11',
    outputSha256:
      '62ffed8c2f94027ce519061bc2979c61aea1b71210d5c43763cfc96fc1c34254',
    outputUrl: '/generated/image-62ffed8c2f94027ce519061bc2979c61.png',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 45,
    preservedPrefixSha256:
      '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00',
    firstPendingIndex: 46,
    firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256:
      '95fa03dd3d7c9474203e33306284d2005c8c3cec220172ba5c9810da33a14eda',
  }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 46 ? 'sanguo-map-end-accept'
      : index === 50 ? 'sanguo-scene-cut-approval' : `node-${index}`,
    status: index < 46 ? 'success' : 'idle', loopIndex: 0,
  }))
  const child = { id: 'record-4x5m31-a8b6-local-wall-v6',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: 'sanguo-map-end-accept',
    sceneCutA8B6LocalFrameRecovery: marker, runs }
  for (const field of ['priorLocalV5ExecutionId', 'priorLocalV5ResultMd5',
    'priorLocalV5RejectedReviewSha256', 'priorLocalV5ReviewModelExecutionId']) {
    assert.match(DRIVE_RECORD_PROJECTION_SQL, new RegExp(field))
    assert.equal(driveRecord({ id: child.id, workflow_id: child.workflowId,
      result: { sceneCutA8B6LocalFrameRecovery: marker, nodeRuns: [] } })
      .sceneCutA8B6LocalFrameRecovery[field], marker[field])
  }
  assert.equal(verifiedIdleContinuation(child, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }), runs[46])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6LocalFrameRecovery: { ...marker,
      priorLocalV5RejectedReviewSha256: '0'.repeat(64) } }, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }),
  /IDENTITY_MISMATCH/)
})

test('local V5 idle gate binds V4 failed workflow and real rejected model review', () => {
  const marker = {
    version: 'scene-cut-a8b6-local-first-frame-v5',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    priorLocalV4ExecutionId: 'record-4x5m31-a8b6-local-wall-v4',
    priorLocalV4FailedResultMd5: 'ecd4fe2f2ec5809388a3365aa06523e8',
    priorLocalV4RejectedReviewSha256:
      'd60200bcba71d976ad351b38af1e472c44d81dbc6935b0969e4e7d9e83fac0ac',
    priorLocalV4ReviewModelExecutionId: 'model-run-mun0ctyo-efttaa2',
    wallImageGenRawSha256:
      '245510205d5886d1884f64396e4fa97b6c5e40f5f53a1cbef1a2704d29048dc6',
    sourceReceiptSha256:
      '6559bb5def38cf78d269d8118a2a43b38e81f115b6a6509552d901b1cdb64453',
    outputSha256:
      '46009d665c617828d2cd87542ee5032a337c4f7b0b14e1291766f8533fe24c95',
    outputUrl: '/generated/image-46009d665c617828d2cd87542ee5032a.png',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 45,
    preservedPrefixSha256:
      '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00',
    firstPendingIndex: 46,
    firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256:
      'f13538320c9d566bf01725e7e7e57be71fff43ae394f80ca9b442c4969422dff',
  }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 46 ? 'sanguo-map-end-accept'
      : index === 50 ? 'sanguo-scene-cut-approval' : `node-${index}`,
    status: index < 46 ? 'success' : 'idle', loopIndex: 0,
  }))
  const child = { id: 'record-4x5m31-a8b6-local-wall-v5',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: 'sanguo-map-end-accept',
    sceneCutA8B6LocalFrameRecovery: marker, runs }
  assert.equal(verifiedIdleContinuation(child, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }), runs[46])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6LocalFrameRecovery: { ...marker,
      priorLocalV4RejectedReviewSha256: '0'.repeat(64) } }, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }),
  /IDENTITY_MISMATCH/)
})

test('local V4 idle gate binds the sole rejected V3 review and signed wall source', () => {
  const marker = {
    version: 'scene-cut-a8b6-local-first-frame-v4',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    priorLocalV3ExecutionId: 'record-4x5m31-a8b6-local-face-wall-v3',
    priorLocalV3ResultMd5: '05e7d2b9df9aa48a05e5d123da405de6',
    priorLocalV3RejectedReviewSha256:
      '3570c7f23ce35b2c60ce14ab47885970bf7a9742c6363313663b0b8afa51b1fe',
    priorLocalV3ReviewModelExecutionId: 'model-run-mumy086h-a3obbjv',
    wallImageGenRawSha256:
      '241ff3bbb9b100385e1c2dd01dc79124523111242bf0da29660711da1e9015c3',
    sourceReceiptSha256:
      '6115e88e135054dd55e1ac96bc4ddf4ece6d260549812fd3bf009622c104df47',
    outputSha256:
      'de30188b2385c89494a294557044a0b0f7d42aefb82d090c7ab31dd7cf28861c',
    outputUrl: '/generated/image-de30188b2385c89494a294557044a0b0.png',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 45,
    preservedPrefixSha256:
      '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00',
    firstPendingIndex: 46,
    firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256:
      '0070e5bb385b26e81dc6e38da5942a4f9a6a48e9ed7995de561dffe593798c6e',
  }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 46 ? 'sanguo-map-end-accept'
      : index === 50 ? 'sanguo-scene-cut-approval' : `node-${index}`,
    status: index < 46 ? 'success' : 'idle', loopIndex: 0,
  }))
  const child = { id: 'record-4x5m31-a8b6-local-wall-v4',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: 'sanguo-map-end-accept',
    sceneCutA8B6LocalFrameRecovery: marker, runs }
  assert.equal(verifiedIdleContinuation(child, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }), runs[46])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6LocalFrameRecovery: { ...marker,
      priorLocalV3RejectedReviewSha256: '0'.repeat(64) } }, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }),
  /IDENTITY_MISMATCH/)
})

test('local V3 idle gate requires exact signed three-source marker', () => {
  assert.throws(() => verifiedIdleContinuation({
    id: 'record-4x5m31-a8b6-local-face-wall-v3',
  }, { workflowId: 'wf-sanguo-history-drama',
    nodeId: 'sanguo-map-end-accept' }), /IDENTITY_MISMATCH/)
  const marker = {
    version: 'scene-cut-a8b6-local-first-frame-v3',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    priorLocalV2ExecutionId: 'record-4x5m31-a8b6-local-face-v2',
    priorLocalV2ResultMd5: 'ab73ca2d9c995c154c064f8a1f5a85c9',
    priorLocalV2RejectedReviewSha256:
      'd258b5995d1bbb9cfcf2972ac42432e33c56d5d5f2edbae4572b603c29738d90',
    priorLocalV2ReviewModelExecutionId: 'model-run-mumvkgzt-ucbr3si',
    wallImageGenRawSha256:
      '3af90de3b8af4b87e484b7f576e4e84c22f9df4ff12de6b780ec3e35efc70f9a',
    faceImageGenRawSha256:
      'ce9820011e1df7e5380c6d9270649a0c201e8edab80c8530c0e0fda45f2b1e9d',
    gateFrameImageGenRawSha256:
      '89123113a9a0ff726542fd643c05c5b2992adcf570ba181ff58de63239338df2',
    sourceReceiptSha256:
      '4c8cb5cf603be7eea97115c1c0d499b81550a26a91ef0794a7307e55a5a50fa4',
    outputSha256:
      '7313b043adc16dc9fc7f6ee7512f2a377f8218e6e0fba11bea91ef943fc7fac7',
    outputUrl: '/generated/image-7313b043adc16dc9fc7f6ee7512f2a37.png',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 45,
    preservedPrefixSha256:
      '0da5666822b31116dc63db02a609342cb9708cc661e262fa72962210d1577c00',
    firstPendingIndex: 46,
    firstPendingNodeId: 'sanguo-map-end-accept',
    reviewPromptSha256: 'a'.repeat(64),
  }
  const runs = Array.from({ length: 464 }, (_, index) => ({
    id: index === 46 ? 'sanguo-map-end-accept'
      : index === 50 ? 'sanguo-scene-cut-approval' : `node-${index}`,
    status: index < 46 ? 'success' : 'idle', loopIndex: 0,
  }))
  const child = { id: 'record-4x5m31-a8b6-local-face-wall-v3',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: 'sanguo-map-end-accept',
    sceneCutA8B6LocalFrameRecovery: marker, runs }
  assert.equal(verifiedIdleContinuation(child, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }), runs[46])
  assert.throws(() => verifiedIdleContinuation({ ...child,
    sceneCutA8B6LocalFrameRecovery: { ...marker,
      gateFrameImageGenRawSha256: '0'.repeat(64) } }, {
    workflowId: child.workflowId, nodeId: 'sanguo-map-end-accept' }),
  /IDENTITY_MISMATCH/)
})

test('explicit completed-node retry preserves paid prefix and rejects wrong identity or a paid suffix', () => {
  const runs = [
    { id: 'video-0', node: { id: 'video', title: 'Video', kind: 'video' }, status: 'success', loopIndex: 0, output: { url: '/generated/video.mp4' } },
    { id: 'evidence-0', node: { id: 'evidence', title: 'Evidence', kind: 'code' }, status: 'success', loopIndex: 0, output: { url: '/generated/evidence.mp4' } },
    { id: 'metrics-0', node: { id: 'metrics', title: 'Metrics', kind: 'code' }, status: 'success', loopIndex: 0, output: { reviewImageDetail: 'original' } },
    { id: 'review-0', node: { id: 'review', title: 'Review', kind: 'text' }, status: 'success', loopIndex: 0, output: { reviewUnavailable: true } },
    { id: 'branch-0', node: { id: 'branch', title: 'Branch', kind: 'branch' }, status: 'failed', loopIndex: 0, error: 'review failed' },
  ]
  const source = record(runs)
  const target = { workflowId: 'workflow', index: 2, nodeId: 'metrics', loopIndex: 0 }
  assert.equal(verifiedRetryTarget(source, target).key, 'metrics-0')
  assert.throws(() => verifiedRetryTarget(source, { ...target, workflowId: 'other' }), /RETRY_WORKFLOW_MISMATCH/)
  assert.throws(() => verifiedRetryTarget(source, { ...target, nodeId: 'video' }), /RETRY_TARGET_MISMATCH/)
  assert.throws(() => verifiedRetryTarget(source, { ...target, loopIndex: 1 }), /RETRY_TARGET_MISMATCH/)
  assert.throws(() => verifiedRetryTarget(record(runs.map((run, index) => index === 1 ? { ...run, status: 'running' } : run)), target), /RETRY_PREFIX_INCOMPLETE/)
  assert.throws(() => verifiedRetryTarget(record(runs.map((run, index) => index === 0 ? { ...run, output: undefined } : run)), target), /RETRY_PAID_PREFIX_INVALID/)
  const withPaidSuffix = record([...runs, { id: 'video-1', node: { id: 'video', title: 'Video', kind: 'video' }, status: 'success', loopIndex: 1, output: { url: '/generated/second.mp4' } }])
  assert.throws(() => verifiedRetryTarget(withPaidSuffix, target), /RETRY_PAID_SUFFIX/)
})

test('completed-node retry follows only its direct child with the paid prefix intact', () => {
  const raw = [
    { id: 'video-0', node: { id: 'video', kind: 'video' }, status: 'success', revision: 1, loopIndex: 0, output: { url: '/generated/video.mp4' } },
    { id: 'metrics-0', node: { id: 'metrics', kind: 'code' }, status: 'success', revision: 2, loopIndex: 0, output: { reviewImageDetail: 'original' } },
    { id: 'branch-0', node: { id: 'branch', kind: 'branch' }, status: 'failed', revision: 2, loopIndex: 0 },
  ]
  const pinned = record(raw)
  const child = record(raw.map((run, index) => index === 1 ? { ...run, status: 'running', revision: 3 } : index === 2 ? { ...run, status: 'idle', revision: 3 } : run), {
    id: 'child', created_at: '2026-09-08T00:01:00Z', result: { parentExecutionId: 'original', requestScopeId: 'original', nodeRuns: raw.map((run, index) => index === 1 ? { ...run, status: 'running', revision: 3 } : index === 2 ? { ...run, status: 'idle', revision: 3 } : run) },
  })
  assert.equal(isRetryFork(pinned, child), false, 'failed-node ancestry cannot recognize a completed-node retry')
  assert.equal(isTargetedRetryFork(pinned, child, 1), true)
  assert.equal(isTargetedRetryFork(pinned, { ...child, parentExecutionId: 'sibling' }, 1), false)
  assert.equal(isTargetedRetryFork(pinned, { ...child, runs: child.runs.map((run, index) => index === 0 ? { ...run, revision: 2 } : run) }, 1), false)
  assert.equal(isTargetedRetryFork(pinned, { ...child, runs: child.runs.map((run, index) => index === 1 ? { ...run, revision: 2 } : run) }, 1), false)
})

test('schema-165 idle migration requires the exact first pending node and saved ancestry', () => {
  const recovery = { version: 'scene-cut-first-frame-schema165-fork-v1', workflowSchemaVersion: 165,
    sourceExecutionId: 'record-parent', sourceResultMd5: 'a'.repeat(32), workflowNodesMd5: 'b'.repeat(32),
    workflowEdgesMd5: 'c'.repeat(32),
    preservedPrefixLength: 1, firstPendingNodeId: 'sanguo-first-frame-branch' }
  const runs = [
    { id: 'approved', node: { id: 'sanguo-shot-script-accept', kind: 'code' }, status: 'success', output: { passed: true } },
    { id: 'pending', node: { id: 'sanguo-first-frame-branch', kind: 'code' }, loopIndex: 0, status: 'idle' },
    { id: 'later', node: { id: 'sanguo-scene-cut-approval', kind: 'http' }, loopIndex: 0, status: 'idle' },
  ]
  const make = (changes = {}) => record([], { id: 'record-child', workflow_id: 'wf-sanguo-history-drama',
    result: { parentExecutionId: 'record-parent', selectedNodeId: 'sanguo-first-frame-branch',
      sceneCutFirstFrameRecovery: recovery, nodeRuns: runs, ...changes } })
  const options = { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-first-frame-branch' }
  assert.equal(verifiedIdleContinuation(make(), options).key, 'pending')
  assert.throws(() => verifiedIdleContinuation(make(), { ...options, nodeId: 'other' }), /IDLE_CHECKPOINT_STATE_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ parentExecutionId: 'other' }), options), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ selectedNodeId: 'other' }), options), /IDLE_CHECKPOINT_STATE_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ nodeRuns: runs.map((run, index) => index === 0 ? { ...run, status: 'failed' } : run) }), options), /IDLE_CHECKPOINT_STATE_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ nodeRuns: runs.map((run, index) => index === 2 ? { ...run, status: 'running' } : run) }), options), /IDLE_CHECKPOINT_STATE_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ sceneCutFirstFrameRecovery: { ...recovery, workflowNodesMd5: '' } }), options), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ sceneCutFirstFrameRecovery: { ...recovery, workflowEdgesMd5: '' } }), options), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
  const opening = make({ selectedNodeId: 'sanguo-scene-cut-source-archive',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'scene-cut-opening-state-schema166-fork-v1',
      workflowSchemaVersion: 166, firstPendingNodeId: 'sanguo-scene-cut-source-archive' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-source-archive', kind: 'http' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(opening, { ...options, nodeId: 'sanguo-scene-cut-source-archive' }).key, 'pending')
  const t0Image = make({ selectedNodeId: 'sanguo-scene-cut-source-archive',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'scene-cut-t0-image-schema167-fork-v1',
      workflowSchemaVersion: 167, firstPendingNodeId: 'sanguo-scene-cut-source-archive' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-source-archive', kind: 'http' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(t0Image, { ...options, nodeId: 'sanguo-scene-cut-source-archive' }).key, 'pending')
  const openingPlan = make({ selectedNodeId: 'sanguo-scene-cut-opening-plan',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'scene-cut-opening-plan-schema168-fork-v1',
      workflowSchemaVersion: 168, firstPendingNodeId: 'sanguo-scene-cut-opening-plan' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-opening-plan', kind: 'http' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(openingPlan, { ...options, nodeId: 'sanguo-scene-cut-opening-plan' }).key, 'pending')
  const travelStart = make({ selectedNodeId: 'sanguo-scene-cut-opening-plan',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'scene-cut-travel-start-schema169-fork-v1',
      workflowSchemaVersion: 169, firstPendingNodeId: 'sanguo-scene-cut-opening-plan' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-opening-plan', kind: 'http' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(travelStart, { ...options, nodeId: 'sanguo-scene-cut-opening-plan' }).key, 'pending')
  const openingProjection = make({ selectedNodeId: 'sanguo-scene-cut-source-archive',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'scene-cut-opening-projection-schema170-fork-v1',
      workflowSchemaVersion: 170, firstPendingNodeId: 'sanguo-scene-cut-source-archive' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-source-archive', kind: 'http' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(openingProjection, { ...options, nodeId: 'sanguo-scene-cut-source-archive' }).key, 'pending')
  const originalContentLock = make({ sceneCutFirstFrameRecovery: { ...recovery,
    version: 'original-two-shot-content-lock-schema171-fork-v1', workflowSchemaVersion: 171 } })
  assert.equal(verifiedIdleContinuation(originalContentLock, options).key, 'pending')
  const originalOpeningRetry = make({ selectedNodeId: 'sanguo-scene-cut-source-archive',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-shot1-opening-retry-schema172-fork-v1',
      workflowSchemaVersion: 172, firstPendingNodeId: 'sanguo-scene-cut-source-archive' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-source-archive', kind: 'http' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalOpeningRetry,
    { ...options, nodeId: 'sanguo-scene-cut-source-archive' }).key, 'pending')
  const originalImageRetry173 = make({ selectedNodeId: 'sanguo-scene-cut-first-frame',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-shot1-image-retry-schema173-fork-v1',
      workflowSchemaVersion: 173, firstPendingNodeId: 'sanguo-scene-cut-first-frame' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-first-frame', kind: 'image' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalImageRetry173,
    { ...options, nodeId: 'sanguo-scene-cut-first-frame' }).key, 'pending')
  const originalImageRetry174 = make({ selectedNodeId: 'sanguo-scene-cut-first-frame',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-shot1-image-retry-schema174-fork-v1',
      workflowSchemaVersion: 174, firstPendingNodeId: 'sanguo-scene-cut-first-frame' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-first-frame', kind: 'image' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalImageRetry174,
    { ...options, nodeId: 'sanguo-scene-cut-first-frame' }).key, 'pending')
  const originalImageRetry175 = make({ selectedNodeId: 'sanguo-scene-cut-first-frame',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-shot1-image-retry-schema175-fork-v1',
      workflowSchemaVersion: 175, firstPendingNodeId: 'sanguo-scene-cut-first-frame' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-first-frame', kind: 'image' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalImageRetry175,
    { ...options, nodeId: 'sanguo-scene-cut-first-frame' }).key, 'pending')
  const originalImageRetry176 = make({ selectedNodeId: 'sanguo-scene-cut-first-frame',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-shot1-image-retry-schema176-fork-v1',
      workflowSchemaVersion: 176, firstPendingNodeId: 'sanguo-scene-cut-first-frame' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-scene-cut-first-frame', kind: 'image' } }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalImageRetry176,
    { ...options, nodeId: 'sanguo-scene-cut-first-frame' }).key, 'pending')
  const originalSecondShot = make({ selectedNodeId: 'sanguo-shot-script-review',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-second-shot-candidate-replay-schema171-fork-v1',
      workflowSchemaVersion: 171, firstPendingNodeId: 'sanguo-shot-script-review' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-shot-script-review', kind: 'text' }, loopIndex: 1 }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalSecondShot, { ...options, nodeId: 'sanguo-shot-script-review' }).key, 'pending')
  const originalSecondShot172 = make({ selectedNodeId: 'sanguo-shot-script-review',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-second-shot-candidate-replay-schema172-fork-v1',
      workflowSchemaVersion: 172, firstPendingNodeId: 'sanguo-shot-script-review' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-shot-script-review', kind: 'text' }, loopIndex: 1 }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalSecondShot172,
    { ...options, nodeId: 'sanguo-shot-script-review' }).key, 'pending')
  const originalSecondShot173 = make({ selectedNodeId: 'sanguo-shot-script-review',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-second-shot-candidate-replay-schema173-fork-v1',
      workflowSchemaVersion: 173, firstPendingNodeId: 'sanguo-shot-script-review' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-shot-script-review', kind: 'text' }, loopIndex: 1 }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalSecondShot173,
    { ...options, nodeId: 'sanguo-shot-script-review' }).key, 'pending')
  const originalSecondShot174 = make({ selectedNodeId: 'sanguo-shot-script-review',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-second-shot-candidate-replay-schema174-fork-v1',
      workflowSchemaVersion: 174, firstPendingNodeId: 'sanguo-shot-script-review' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-shot-script-review', kind: 'text' }, loopIndex: 1 }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalSecondShot174,
    { ...options, nodeId: 'sanguo-shot-script-review' }).key, 'pending')
  const originalSecondShot175 = make({ selectedNodeId: 'sanguo-shot-script-review',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-second-shot-candidate-replay-schema175-fork-v1',
      workflowSchemaVersion: 175, firstPendingNodeId: 'sanguo-shot-script-review' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-shot-script-review', kind: 'text' }, loopIndex: 1 }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalSecondShot175,
    { ...options, nodeId: 'sanguo-shot-script-review' }).key, 'pending')
  const originalSecondShot176 = make({ selectedNodeId: 'sanguo-shot-script-review',
    sceneCutFirstFrameRecovery: { ...recovery, version: 'original-second-shot-candidate-replay-schema176-fork-v1',
      workflowSchemaVersion: 176, firstPendingNodeId: 'sanguo-shot-script-review' },
    nodeRuns: [{ ...runs[0] }, { ...runs[1], node: { id: 'sanguo-shot-script-review', kind: 'text' }, loopIndex: 1 }, runs[2]] })
  assert.equal(verifiedIdleContinuation(originalSecondShot176,
    { ...options, nodeId: 'sanguo-shot-script-review' }).key, 'pending')
  assert.throws(() => verifiedIdleContinuation(make({ sceneCutFirstFrameRecovery: {
    ...recovery, version: 'scene-cut-t0-image-schema167-fork-v1', workflowSchemaVersion: 166,
  } }), options), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ sceneCutFirstFrameRecovery: { ...recovery, version: 'unknown' } }), options), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
})

test('schema180 native-tail rebind starts only at its saved index50 approval', () => {
  const marker = { version: 'scene-cut-approval-rebind-v2',
    sourceExecutionId: 'record-source', sourceResultMd5: 'a'.repeat(32),
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 50, firstPendingNodeId: 'sanguo-scene-cut-approval',
    nativeSourceExecutionId: 'record-levw1e',
    nativeSourceResultMd5: 'a06fb401d4655699fce3ec69548e578c',
    nativeReviewExecutionId: 'record-9p80o5',
    nativeReviewResultMd5: '4282a0710daef80462a46423391be68f',
    tailGuide: { url: '/generated/verified-native-4d52c9bef3e2e5097d1a-7de488acbb85c4cc-frame-312.jpg',
      fileSha256: '99fc24c072eb7e2829a1919483f5957d18de59b05b1905a7f53d4ac57e9b3aeb' } }
  const runs = Array.from({ length: 464 }, (_, index) => ({ id: `run-${index}`,
    node: { id: index === 50 ? 'sanguo-scene-cut-approval' : `node-${index}` },
    status: index < 50 ? 'success' : 'idle', loopIndex: Math.floor(Math.max(0, index - 25) / 56) }))
  const make = (changes = {}) => record([], { id: 'record-child',
    workflow_id: 'wf-sanguo-history-drama', result: { id: 'record-child',
      parentExecutionId: 'record-source', selectedNodeId: 'sanguo-scene-cut-approval',
      sceneCutApprovalRebindRecovery: marker, nodeRuns: runs, ...changes } })
  const options = { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-scene-cut-approval' }
  assert.equal(verifiedIdleContinuation(make(), options).index, 50)
  assert.throws(() => verifiedIdleContinuation(make({ sceneCutApprovalRebindRecovery: {
    ...marker, tailGuide: { ...marker.tailGuide, fileSha256: '0'.repeat(64) } } }),
  options), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ nodeRuns: runs.map((run, index) =>
    index === 52 ? { ...run, status: 'success' } : run) }), options),
  /IDLE_CHECKPOINT_STATE_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation(make({ parentExecutionId: 'record-other' }),
    options), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
})

test('schema177 image-repair idle continuation binds its record, graph, receipt and preserved prefix', () => {
  const hash = createJsonHasher()
  const prefix = Array.from({ length: 45 }, (_, index) => ({ id: `done-${index}`,
    node: { id: index === 41 ? 'sanguo-scene-cut-source-archive' : `node-${index}`, kind: 'code' },
    loopIndex: 0, status: 'success', output: index === 41
      ? { referenceBindings: [{ frontSha256: '1'.repeat(64) }, { frontSha256: '2'.repeat(64) }] }
      : { index } }))
  const prefixHash = hash(prefix.map(run => run.output))
  const marker = { version: 'scene-cut-image-repair-schema177-fork-v1',
    sourceExecutionId: 'record-v6', sourceResultMd5: 'a'.repeat(32),
    parentExecutionId: 'record-v5', parentResultMd5: 'b'.repeat(32),
    originalExecutionId: 'record-original', originalResultMd5: 'c'.repeat(32),
    workflowSchemaVersion: 177, workflowNodesMd5: 'd'.repeat(32), workflowEdgesMd5: 'e'.repeat(32),
    preservedPrefixLength: 45, firstPendingNodeId: 'sanguo-scene-cut-first-frame',
    preservedPrefixOutputsHash: prefixHash, failedImageFileSha256: 'f'.repeat(64),
    failedReviewOutputSha256: '0'.repeat(64), repairPreparationSha256: '3'.repeat(64),
    receipt: { version: 'scene-cut-rejected-image-edit-reference-v1', role: 'reference-only',
      sourceVerdict: 'rejected', approvedFirstFrame: false, requiresFreshIndependentReview: true,
      sourceExecutionId: 'record-v6', sourceResultMd5: 'a'.repeat(32), sourceImageSha256: 'f'.repeat(64),
      failedReviewOutputSha256: '0'.repeat(64), referenceOrder: [
        { position: 1, sha256: '1'.repeat(64) }, { position: 2, sha256: '2'.repeat(64) },
        { position: 3, role: 'rejected-edit-source', sourceSha256: 'f'.repeat(64), jpegSha256: '4'.repeat(64) },
      ] } }
  const firstRecovery = { version: 'original-shot1-image-retry-schema177-fork-v1',
    sourceExecutionId: marker.sourceExecutionId, sourceResultMd5: marker.sourceResultMd5,
    workflowSchemaVersion: 177, workflowNodesMd5: marker.workflowNodesMd5,
    workflowEdgesMd5: marker.workflowEdgesMd5, preservedPrefixLength: 45,
    firstPendingNodeId: marker.firstPendingNodeId, preservedPrefixOutputsHash: prefixHash,
    failedImageFileSha256: marker.failedImageFileSha256,
    failedReviewOutputSha256: marker.failedReviewOutputSha256,
    repairPreparationSha256: marker.repairPreparationSha256 }
  const first = { id: 'record-v7', workflowId: 'wf-sanguo-history-drama', mode: 'step',
    generationScopeId: 'record-v7', parentExecutionId: 'record-v6',
    selectedNodeId: 'sanguo-scene-cut-first-frame', nodeRuns: [...prefix,
      { id: 'image', node: { id: 'sanguo-scene-cut-first-frame', kind: 'image' }, status: 'idle', loopIndex: 0 },
      { id: 'later', node: { id: 'later', kind: 'code' }, status: 'idle', loopIndex: 0 }],
    sceneCutFirstFrameRecovery: firstRecovery, originalShot1ImageV7RetryRecovery: firstRecovery,
    sceneCutImageRepairRecovery: marker }
  const source = { id: 'record-v6', workflowId: first.workflowId, nodeRuns: prefix }
  const normalize = (state: typeof first) => driveRecord({ id: state.id, workflow_id: state.workflowId,
    created_at: '2026-09-29T00:00:00Z', result: state })
  const compact = normalize(first)
  const options = { workflowId: first.workflowId, nodeId: first.selectedNodeId }
  assert.equal(verifiedIdleContinuation(compact, options).key, 'image')
  assert.equal(verifiedSchema177IdleRecord(first, compact, source).marker, marker)
  assert.throws(() => verifiedIdleContinuation({ ...compact, sceneCutImageRepairRecovery: null }, options),
    /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
  assert.throws(() => verifiedIdleContinuation({ ...compact, sceneCutImageRepairRecovery: {
    ...compact.sceneCutImageRepairRecovery, workflowNodesMd5: '9'.repeat(32) } }, options), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
  assert.throws(() => verifiedSchema177IdleRecord({ ...first, nodeRuns: first.nodeRuns.map((run, index) => index === 4
    ? { ...run, output: { index: 400 } } : run) }, compact, source), /IDLE_CHECKPOINT_PREFIX_CHANGED/)
  assert.throws(() => verifiedSchema177IdleRecord({ ...first, sceneCutImageRepairRecovery: {
    ...marker, receipt: { ...marker.receipt, referenceOrder: marker.receipt.referenceOrder.slice(0, 2) } } },
  compact, source), /IDLE_CHECKPOINT_PREFIX_CHANGED/)
  assert.throws(() => verifiedSchema177IdleRecord(first, compact, { ...source, nodeRuns: source.nodeRuns.map((run, index) => index === 9
    ? { ...run, output: { index: 900 } } : run) }), /IDLE_CHECKPOINT_PREFIX_CHANGED/)

  const replayPrefix = [...prefix, ...Array.from({ length: 21 }, (_, offset) => ({
    id: `shot1-${offset}`, node: { id: `shot1-node-${offset}`, kind: 'code' },
    loopIndex: offset === 20 ? 1 : 0, status: 'success', output: { offset },
  }))]
  const replayRecovery = { version: 'original-second-shot-candidate-replay-schema177-fork-v1',
    sourceExecutionId: first.id, sourceResultMd5: '5'.repeat(32), workflowSchemaVersion: 177,
    workflowNodesMd5: marker.workflowNodesMd5, workflowEdgesMd5: marker.workflowEdgesMd5,
    preservedPrefixLength: 66, firstPendingNodeId: 'sanguo-shot-script-review',
    preservedPrefixOutputsHash: hash(replayPrefix.map(run => run.output)),
    firstShotImageRepairPreparationSha256: marker.repairPreparationSha256 }
  const replay = { ...first, id: 'record-shot2', generationScopeId: 'record-shot2',
    parentExecutionId: first.id, selectedNodeId: 'sanguo-shot-script-review',
    nodeRuns: [...replayPrefix, { id: 'review', node: { id: 'sanguo-shot-script-review', kind: 'text' },
      status: 'idle', loopIndex: 1 }], sceneCutFirstFrameRecovery: replayRecovery,
    secondShotReplayRecovery: replayRecovery }
  const replayCompact = normalize(replay)
  assert.equal(verifiedIdleContinuation(replayCompact,
    { workflowId: first.workflowId, nodeId: 'sanguo-shot-script-review' }).key, 'review')
  const replaySource = { ...first, nodeRuns: replayPrefix }
  assert.equal(verifiedSchema177IdleRecord(replay, replayCompact, replaySource).marker, marker)
  assert.throws(() => verifiedIdleContinuation({ ...replayCompact, sceneCutFirstFrameRecovery: {
    ...replayCompact.sceneCutFirstFrameRecovery, firstShotImageRepairPreparationSha256: '9'.repeat(64) } },
  { workflowId: first.workflowId, nodeId: 'sanguo-shot-script-review' }), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
})

test('schema178 continue-idle requires four-reference guide, prior v7 marker and exact first/second prefixes', () => {
  const hash = createJsonHasher()
  const prefix = Array.from({ length: 45 }, (_, index) => ({ id: `done-${index}`,
    node: { id: `node-${index}`, kind: 'code' }, status: 'success', loopIndex: 0,
    output: index === 41 ? { referenceBindings: [
      { frontSha256: '1'.repeat(64) }, { frontSha256: '2'.repeat(64) }] } : { index } }))
  const prefixHash = hash(prefix.map(run => run.output))
  const prior = { version: 'scene-cut-image-repair-schema177-fork-v1',
    repairPreparationSha256: '3'.repeat(64) }
  const guidePath = 'qa/record-4x5m31/geometry-guide-v8-0d23d49f.png'
  const provenancePath = 'qa/record-4x5m31/geometry-guide-v8-provenance.json'
  const source = { id: 'record-v7', workflowId: 'wf-sanguo-history-drama',
    sceneCutImageRepairRecovery: prior, nodeRuns: prefix }
  const marker = { version: 'scene-cut-image-repair-schema178-fork-v2',
    sourceExecutionId: source.id, sourceResultMd5: 'a'.repeat(32),
    parentExecutionId: 'record-v6', parentResultMd5: 'b'.repeat(32),
    originalExecutionId: 'record-original', originalResultMd5: 'c'.repeat(32),
    workflowSchemaVersion: 178, workflowNodesMd5: 'd'.repeat(32), workflowEdgesMd5: 'e'.repeat(32),
    preservedPrefixLength: 45, firstPendingNodeId: 'sanguo-scene-cut-first-frame',
    preservedPrefixOutputsHash: prefixHash, failedImageFileSha256: 'f'.repeat(64),
    failedReviewOutputSha256: '0'.repeat(64), repairPreparationSha256: '4'.repeat(64),
    priorRepairPreparationSha256: prior.repairPreparationSha256,
    geometryGuideSourcePath: guidePath, geometryGuideSourceSha256: '5'.repeat(64),
    geometryGuideJpegSha256: '6'.repeat(64),
    geometryGuideProvenancePath: provenancePath, geometryGuideProvenanceSha256: '7'.repeat(64),
    receipt: { version: 'scene-cut-rejected-image-edit-reference-v2', role: 'reference-only',
      sourceVerdict: 'rejected', approvedFirstFrame: false,
      requiresFreshIndependentReview: true, sourceExecutionId: source.id,
      sourceResultMd5: 'a'.repeat(32), sourceImageSha256: 'f'.repeat(64),
      failedReviewOutputSha256: '0'.repeat(64),
      priorRepairPreparationSha256: prior.repairPreparationSha256,
      priorRepairMarkerHash: hash(prior),
      geometryGuide: { role: 'geometry-only', identityAuthority: false,
        sourcePath: guidePath, sourceSha256: '5'.repeat(64) },
      referenceOrder: [{ position: 1, sha256: '1'.repeat(64) },
        { position: 2, sha256: '2'.repeat(64) },
        { position: 3, role: 'rejected-edit-source', sourceSha256: 'f'.repeat(64),
          jpegSha256: '8'.repeat(64) },
        { position: 4, role: 'geometry-guide', purpose: 'geometry-only', referenceOnly: true,
          sourcePath: guidePath, sourceSha256: '5'.repeat(64), jpegSha256: '6'.repeat(64) }] } }
  const firstRecovery = { version: 'original-shot1-image-retry-schema178-fork-v1',
    sourceExecutionId: source.id, sourceResultMd5: marker.sourceResultMd5,
    workflowSchemaVersion: 178, workflowNodesMd5: marker.workflowNodesMd5,
    workflowEdgesMd5: marker.workflowEdgesMd5, preservedPrefixLength: 45,
    firstPendingNodeId: marker.firstPendingNodeId, preservedPrefixOutputsHash: prefixHash,
    failedImageFileSha256: marker.failedImageFileSha256,
    failedReviewOutputSha256: marker.failedReviewOutputSha256,
    repairPreparationSha256: marker.repairPreparationSha256,
    priorRepairPreparationSha256: marker.priorRepairPreparationSha256,
    geometryGuideSourcePath: guidePath, geometryGuideSourceSha256: marker.geometryGuideSourceSha256,
    geometryGuideJpegSha256: marker.geometryGuideJpegSha256,
    geometryGuideProvenancePath: provenancePath,
    geometryGuideProvenanceSha256: marker.geometryGuideProvenanceSha256 }
  const first = { id: 'record-v8', workflowId: source.workflowId, mode: 'step',
    generationScopeId: 'record-v8', parentExecutionId: source.id,
    selectedNodeId: 'sanguo-scene-cut-first-frame', nodeRuns: [...prefix,
      { id: 'image', node: { id: 'sanguo-scene-cut-first-frame', kind: 'image' }, status: 'idle', loopIndex: 0 },
      { id: 'later', node: { id: 'later', kind: 'code' }, status: 'idle', loopIndex: 0 }],
    sceneCutFirstFrameRecovery: firstRecovery,
    originalShot1ImageV8RetryRecovery: firstRecovery,
    priorSceneCutImageRepairRecovery: prior, sceneCutImageRepairRecovery: marker }
  const normalize = (state: typeof first) => driveRecord({ id: state.id, workflow_id: state.workflowId,
    created_at: '2026-09-29T00:00:00Z', result: state })
  const compact = normalize(first)
  assert.equal(verifiedIdleContinuation(compact,
    { workflowId: first.workflowId, nodeId: first.selectedNodeId }).key, 'image')
  assert.equal(verifiedSchema178IdleRecord(first, compact, source).marker, marker)
  assert.throws(() => verifiedIdleContinuation({ ...compact, sceneCutImageRepairRecovery: {
    ...compact.sceneCutImageRepairRecovery, geometryGuideJpegSha256: '9'.repeat(64) } },
  { workflowId: first.workflowId, nodeId: first.selectedNodeId }), /IDLE_CHECKPOINT_IDENTITY_MISMATCH/)
  assert.throws(() => verifiedSchema178IdleRecord({ ...first, priorSceneCutImageRepairRecovery: {
    ...prior, repairPreparationSha256: '9'.repeat(64) } }, compact, source), /IDLE_CHECKPOINT_PREFIX_CHANGED/)
  assert.throws(() => verifiedSchema178IdleRecord({ ...first, nodeRuns: first.nodeRuns.map((run, index) => index === 2
    ? { ...run, output: { index: 200 } } : run) }, compact, source), /IDLE_CHECKPOINT_PREFIX_CHANGED/)

  const replayPrefix = [...prefix, ...Array.from({ length: 21 }, (_, offset) => ({
    id: `shot1-${offset}`, node: { id: `shot1-${offset}`, kind: 'code' },
    status: 'success', loopIndex: offset === 20 ? 1 : 0, output: { offset },
  }))]
  const replayRecovery = { version: 'original-second-shot-candidate-replay-schema178-fork-v1',
    sourceExecutionId: first.id, sourceResultMd5: '9'.repeat(32),
    workflowSchemaVersion: 178, workflowNodesMd5: marker.workflowNodesMd5,
    workflowEdgesMd5: marker.workflowEdgesMd5, preservedPrefixLength: 66,
    firstPendingNodeId: 'sanguo-shot-script-review',
    preservedPrefixOutputsHash: hash(replayPrefix.map(run => run.output)),
    firstShotImageRepairPreparationSha256: marker.repairPreparationSha256 }
  const replay = { ...first, id: 'record-replay', generationScopeId: 'record-replay',
    parentExecutionId: first.id, selectedNodeId: 'sanguo-shot-script-review',
    nodeRuns: [...replayPrefix, { id: 'review', node: { id: 'sanguo-shot-script-review', kind: 'text' },
      status: 'idle', loopIndex: 1 }],
    sceneCutFirstFrameRecovery: replayRecovery, secondShotReplayRecovery: replayRecovery }
  const replaySource = { ...first, nodeRuns: replayPrefix }
  assert.equal(verifiedIdleContinuation(normalize(replay),
    { workflowId: first.workflowId, nodeId: 'sanguo-shot-script-review' }).key, 'review')
  assert.equal(verifiedSchema178IdleRecord(replay, normalize(replay), replaySource).marker, marker)
})

test('target requires the actual first-loop output and an affirmative report', () => {
  for (const output of [undefined, null, {}, '', { routeError: 'REVIEW_RESULT_INVALID: missing observation' }, { error: 'failed' }, { passed: false }, { videoAccepted: false }, { accepted: false }, { ok: false }, { success: false }]) {
    const target = targetOutcome(record([nodeRun(output), nodeRun(undefined, { id: 'next-paid-run', node: { id: 'next-video', kind: 'video' }, status: 'idle' })]), 'accept')
    assert.equal(target.done, false, JSON.stringify(output))
    assert.equal(target.settled, true, 'a rejected target must stop the driver before any downstream branch or paid node')
  }
  for (const status of ['idle', 'running']) assert.equal(targetOutcome(record([nodeRun(undefined, { status })]), 'accept').settled, false)
  assert.equal(targetOutcome(record([nodeRun({ passed: true })]), 'accept').done, true)
  assert.equal(targetOutcome(record([nodeRun(true)]), 'accept').done, true)
  const rounds = record([nodeRun({ passed: false }), nodeRun({ passed: true }, { id: 'accept-loop-1', loopIndex: 1 })])
  assert.equal(targetOutcome(rounds, 'accept').done, false, 'later round must not hide the rejected first round')
  assert.equal(targetOutcome(rounds, 'accept', 1).done, true, 'an explicit execution slot can target a later loop round')
  assert.equal(targetOutcome(rounds, 'accept', 2).reason, 'target not scheduled')
})

test('video success requires a URL; an acceptance report may succeed without a media URL', () => {
  const video = (output: unknown) => record([nodeRun(output, { node: { id: 'video', kind: 'video' } })])
  for (const output of [{ taskId: 'paid-but-pending' }, { url: ' ' }, { url: '/generated/rejected.mp4', passed: false }]) {
    assert.equal(targetOutcome(video(output), 'video').done, false)
  }
  const result = targetOutcome(video({ url: '/generated/accepted.mp4' }), 'video')
  assert.equal(result.done, true)
  assert.equal(result.url, '/generated/accepted.mp4')
  assert.equal(targetOutcome(record([nodeRun({ passed: true })]), 'accept').done, true)
})

test('loop target verifies five actual iterations regardless of execution indices', () => {
  const rounds = Array.from({ length: 6 }, (_, loopIndex) => [
    nodeRun({ passed: true }, { id: `unrelated-${loopIndex}`, node: { id: 'other', kind: 'code' }, loopIndex }),
    nodeRun({ url: `/generated/round-${loopIndex + 1}.mp4` }, { id: `video-${loopIndex}`, node: { id: 'video', kind: 'video' }, loopIndex }),
  ]).flat()
  const result = loopTargetOutcome(record(rounds), 'video', 5)
  assert.equal(result.done, true)
  assert.equal(result.run.loopIndex, 4)
  assert.equal(result.run.index, 9)
  assert.equal(result.completed.length, 5)
  assert.equal(loopTargetOutcome(record(rounds.filter(run => run.loopIndex !== 2)), 'video', 5).done, false)
  assert.equal(loopTargetOutcome(record(rounds.map(run => run.id === 'video-1' ? { ...run, output: { passed: false } } : run)), 'video', 5).reason, 'loop 2: passed=false')
  assert.equal(loopTargetOutcome(record(rounds.map(run => run.id === 'video-4' ? { ...run, status: 'running' } : run)), 'video', 5).settled, false)
  assert.equal(loopTargetOutcome(record([...rounds, rounds[1]]), 'video', 5).settled, true, 'ambiguous same-round occurrences must not silently select a green one')
  assert.throws(() => loopTargetOutcome(record(rounds), 'video', 0), /positive integer/)
})

test('runtime input overrides require nested JSON and verify the exact requested subset', () => {
  const inputs = parseRuntimeInputs('{"input":{"episode_number":41},"extra":{"settings":{"b":2,"a":1}}}')
  const actual = { input: { episode_number: 41, aspect_ratio: '16:9' }, extra: { settings: { a: 1, b: 2 }, qualityDisposition: 'manual-review-v1' } }
  assert.equal(runtimeInputMismatch(actual, inputs), undefined, 'existing unrelated inputs remain valid')
  assert.match(runtimeInputMismatch({ ...actual, input: { episode_number: 43 } }, inputs), /input.episode_number: expected 41, stored 43/)
  assert.match(runtimeInputMismatch({ ...actual, input: { episode_number: '41' } }, inputs), /stored "41"/, 'a numeric input must not verify as a string')
  assert.match(runtimeInputMismatch({}, inputs), /stored undefined/)
  assert.equal(runtimeInputMismatch({ input: { list: [1, { a: 2 }], nothing: null } }, { input: { list: [1, { a: 2 }], nothing: null } }), undefined)
  assert.match(runtimeInputMismatch({ input: { list: [2, 1] } }, { input: { list: [1, 2] } }), /input.list/)
  for (const invalid of ['', '{', 'null', '[]', '{}', '{"input":41}', '{"input":{}}', '{"input":[]}']) assert.throws(() => parseRuntimeInputs(invalid), /--runtime-inputs/)
})

test('code runner logs and empty return wrappers are not a deliverable output', async () => {
  for (const code of ['console.log("ran");', 'return {};', 'return null;', 'return [];']) {
    const output = await executeCodeNode({ code })
    assert.equal(targetOutcome(record([nodeRun(output)]), 'accept').done, false, code)
  }
  const output = await executeCodeNode({ code: 'return {passed:true};' })
  assert.equal(targetOutcome(record([nodeRun(output)]), 'accept').done, true)
})

test('fork observation follows paid work while pending or failed, without claiming independent runs', () => {
  const original = record([nodeRun({ error: 'old error' }, { status: 'failed' })])
  for (const status of ['idle', 'running', 'success', 'failed']) {
    const candidate = record([], { id: `fork-${status}`, created_at: '2026-09-08T00:01:00Z', result: { requestScopeId: 'original', nodeRuns: [nodeRun({}, { status, revision: 1 })] } })
    assert.equal(isRetryFork(original, candidate), true, status)
    assert.equal(isRetryFork(original, { ...candidate, requestScopeId: 'independent' }), false)
    assert.equal(isRetryFork(original, { ...candidate, workflowId: 'another-workflow' }), false)
    assert.equal(isRetryFork(original, { ...candidate, createdAt: original.createdAt }), false)
    assert.equal(isRetryFork(original, { ...candidate, runs: [nodeRun({}, { status, revision: 1, key: 'another-loop' })] }), false)
  }
})

test('automatic scene-cut image retry is followed at its earlier image node', () => {
  const prefix = { key: 'source-prefix', id: 'sanguo-shot-script', status: 'success', revision: 4, loopIndex: 0 }
  const image = { key: 'source-image', id: 'sanguo-scene-cut-first-frame', status: 'success', revision: 2, loopIndex: 0 }
  const review = { key: 'source-review', id: 'sanguo-scene-cut-review', status: 'success', revision: 2, loopIndex: 0 }
  const failed = { key: 'source-approval', id: 'sanguo-scene-cut-approval', status: 'failed', revision: 2, loopIndex: 0 }
  const original = { id: 'record-parent', workflowId: 'wf-sanguo-history-drama', requestScopeId: 'record-root',
    createdAt: '2026-10-07T04:00:00Z', runs: [prefix, image, review, failed] }
  const child = { ...original, id: 'record-child', parentExecutionId: original.id,
    createdAt: '2026-10-07T04:01:00Z', selectedNodeId: image.id,
    sceneCutAutoRetry: { sourceExecutionId: original.id, count: 1, loopIndex: 0 },
    runs: [prefix, ...[image, review, failed].map(run => ({ ...run, status: 'idle' }))] }
  assert.equal(isRetryFork(original, child), true)
  assert.equal(isRetryFork(original, { ...child, parentExecutionId: 'unrelated' }), false)
  assert.equal(isRetryFork(original, { ...child, runs: [{ ...prefix, status: 'idle' }, ...child.runs.slice(1)] }), false)
  assert.equal(isRetryFork(original, { ...child, sceneCutAutoRetry: { ...child.sceneCutAutoRetry, count: 3 } }), false)
  const second = { ...child, id: 'record-second', parentExecutionId: child.id,
    createdAt: '2026-10-07T04:02:00Z', sceneCutAutoRetry: { ...child.sceneCutAutoRetry, count: 2 } }
  assert.equal(isRetryFork({ ...child, runs: [prefix, image, review, failed] }, second), true)
})

test('fork observation rejects an older sibling that does not preserve the failed checkpoint prefix', () => {
  const prefix = nodeRun({ passed: true }, { id: 'paid-prefix', node: { id: 'video', kind: 'video' }, revision: 4 })
  const failed = nodeRun({ error: 'late failure' }, { id: 'late-failure', status: 'failed', revision: 6, error: 'late failure' })
  const original = record([prefix, failed])
  const sibling = record([], { id: 'old-sibling', created_at: '2026-09-08T00:02:00Z', result: { requestScopeId: 'original', nodeRuns: [
    { ...prefix, status: 'idle' }, { ...failed, status: 'idle', revision: 7 },
  ] } })
  assert.equal(isRetryFork(original, sibling), false)
  const descendant = record([], { id: 'real-descendant', created_at: '2026-09-08T00:03:00Z', result: { requestScopeId: 'original', nodeRuns: [
    prefix, { ...failed, status: 'running', revision: 7 },
  ] } })
  assert.equal(isRetryFork(original, descendant), true)
})

test('failure signatures distinguish the exact record, round, and revision', () => {
  const original = record([nodeRun({ error: 'x' }, { status: 'failed', error: 'x' })])
  assert.notEqual(failureSignature(original), failureSignature({ ...original, id: 'fork' }))
  assert.notEqual(failureSignature(original), failureSignature({ ...original, runs: original.runs.map(run => ({ ...run, key: 'accept-loop-1' })) }))
  assert.notEqual(failureSignature(original), failureSignature({ ...original, runs: original.runs.map(run => ({ ...run, revision: 1 })) }))
})

test('a visible migrated recovery is related by scope even without a new run revision', () => {
  const original = record([nodeRun({ passed: true })])
  const migrated = record([], { id: 'migrated', result: { requestScopeId: original.id, nodeRuns: [] } })
  assert.equal(sameExecutionScope(original, migrated), true)
  assert.equal(sameExecutionScope(original, { ...migrated, requestScopeId: 'independent' }), false)
  assert.equal(sameExecutionScope(original, { ...migrated, workflowId: 'different-workflow' }), false)
  assert.equal(sameExecutionScope(original, undefined), false)
})

test('reload migration cannot make previously completed media or model text payable again', () => {
  const paid = nodeRun({ url: '/generated/preserved.mp4' }, { id: 'video-loop-0',
    node: { id: 'video', kind: 'video' }, status: 'success' })
  const source = record([paid, nodeRun(undefined, { id: 'review', status: 'idle' })])
  const openingReset = record([], { id: 'migrated', result: { requestScopeId: source.id, nodeRuns: [
    { ...paid, status: 'idle', output: undefined }, nodeRun(undefined, { id: 'new-gate', status: 'idle' }),
  ] } })
  assert.deepEqual(completedProviderRegression(source, openingReset).map(item => item.key), ['video-loop-0'])
  const safe = record([], { id: 'migrated-safe', result: { requestScopeId: source.id, nodeRuns: [
    paid, nodeRun(undefined, { id: 'new-gate', status: 'idle' }),
  ] } })
  assert.deepEqual(completedProviderRegression(source, safe), [])
  const writer = nodeRun({ text: 'paid draft' }, { id: 'writer-loop-0',
    node: { id: 'writer', kind: 'text', modelId: 'configured-writer' }, status: 'success' })
  const resetWriter = record([], { id: 'migrated-text', result: { requestScopeId: source.id, nodeRuns: [
    { ...writer, status: 'idle', output: undefined },
  ] } })
  assert.deepEqual(completedProviderRegression(record([writer]), resetWriter).map(item => item.key), ['writer-loop-0'])
})

test('driver records retain only decision summaries, and malformed summaries fall back to the actual output', () => {
  const big = 'PRIVATE_LARGE_PROVIDER_PAYLOAD'.repeat(1000)
  const output = { passed: false, url: ' /generated/output.mp4 ', raw: { content: big }, text: big }
  const normalized = record([nodeRun(output, { context: { big }, inputContext: { big }, _driveOutput: { hasOutput: false } })])
  assert.deepEqual(normalized.runs[0].outputSummary, driveOutputSummary(output))
  assert.equal(targetOutcome(normalized, 'accept').reason, 'passed=false')
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_LARGE_PROVIDER_PAYLOAD/)
})

test('the last successful text, character or media accept requires a human before any automated Next', () => {
  const accepted = { passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true,
    qualityReview: { manualDecisionRequired: true, editorialHold: { findings: [{ problem: 'PRIVATE_REVIEW_TEXT' }] } } }
  for (const id of ['sanguo-scene-outline-accept', 'sanguo-shot-script-accept', 'sanguo-character-accept', 'sanguo-media-accept']) {
    const prefix = nodeRun({ url: '/generated/preserved.mp4' }, { id: 'paid-prefix', node: { id: 'sanguo-video', kind: 'video' } })
    const gate = nodeRun(accepted, { id: `gate-${id}`, node: { id, kind: 'code' } })
    const next = nodeRun(undefined, { id: 'next-paid', node: { id: 'next-video', kind: 'video' }, status: 'idle' })
    const paused = record([prefix, gate, next])
    assert.equal(pendingManualDecision(paused)?.id, id)
    assert.equal(paused.runs[1].outputSummary.manualDecisionRequired, true)
    assert.doesNotMatch(JSON.stringify(paused), /PRIVATE_REVIEW_TEXT/, 'the compact driver must not copy reviewer prose')
    assert.equal(pendingManualDecision(record([prefix, gate, { ...next, status: 'skipped' }]))?.id, id)
    assert.equal(pendingManualDecision(record([prefix, gate, { ...next, status: 'success', output: { url: '/generated/continued.mp4' } }])), undefined,
      'a later successful node proves the human already continued')
    assert.equal(pendingManualDecision(record([prefix, gate, { ...next, status: 'running' }])), undefined,
      'a downstream running node has already been submitted')
  }
})

test('manual pause ignores incomplete, strict, unsuccessful or non-accept markers', () => {
  const correct = { passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true,
    qualityReview: { manualDecisionRequired: true } }
  const cases = [
    { ...correct, manualDecisionRequired: false },
    { ...correct, qualityReview: { manualDecisionRequired: false } },
    { ...correct, qualityDisposition: 'strict-v1' },
    { passed: true, qualityDisposition: 'manual-review-v1', qualityReview: { manualDecisionRequired: true } },
  ]
  for (const output of cases) assert.equal(pendingManualDecision(record([nodeRun(output,
    { node: { id: 'sanguo-media-accept', kind: 'code' } })])), undefined)
  assert.equal(pendingManualDecision(record([nodeRun(correct,
    { node: { id: 'sanguo-media-accept', kind: 'code' }, status: 'idle' })])), undefined)
  assert.equal(pendingManualDecision(record([nodeRun(correct,
    { node: { id: 'sanguo-video', kind: 'video' } })])), undefined)
  assert.equal(pendingManualDecision(record([nodeRun(correct,
    { node: { id: 'sanguo-media-accept', kind: 'code' } }), nodeRun({}, { id: 'failed-next', status: 'failed' })])), undefined)
  assert.equal(driveOutputSummary(correct).manualDecisionRequired, true)
})

const fixtureProjectionSql = `with recursive record_row as (
  select * from jsonb_to_record($1::jsonb) as row(id text,workflow_id text,created_at timestamptz,runtime_inputs jsonb,result jsonb)
)${DRIVE_RECORD_PROJECTION_SQL}`

test('PostgreSQL compact SELECT preserves malformed-output, failure, fork and first-occurrence decisions', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const client = await pool.connect()
  try {
    await client.query('begin read only')
    const project = async (row: Record<string, unknown>) => (await client.query(fixtureProjectionSql, [JSON.stringify(row), DRIVE_RECORD_TRIM_CHARS])).rows[0]
    const outputs = [undefined, null, {}, [], [null], true, false, 0, 1, '', DRIVE_RECORD_TRIM_CHARS, 'real output',
      { executionLogs: [] }, { executionLogs: ['ran'] }, { value: null }, { value: '' }, { value: { value: { value: [] } } },
      { value: { executionLogs: ['only logs'] } }, { value: false }, { value: { passed: false } },
      { routeError: 'REVIEW_RESULT_INVALID: missing evidence' }, { routeError: ' ', error: 'secondary' },
      { routeError: '', error: 'fallback' }, { routeError: false }, { routeError: 0 }, { routeError: null },
      { routeError: [] }, { error: {} }, { error: 1 }, { error: true },
      { passed: false }, { accepted: false }, { videoAccepted: false }, { ok: false }, { success: false },
      { passed: true }, { passed: 'false' }, { passed: [] }, { url: DRIVE_RECORD_TRIM_CHARS },
      { passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true, qualityReview: { manualDecisionRequired: true } },
      { passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true, qualityReview: { manualDecisionRequired: false } },
      { url: `${DRIVE_RECORD_TRIM_CHARS}/generated/clip.mp4${DRIVE_RECORD_TRIM_CHARS}` }, { url: 1 },
      { raw: { text: 'PRIVATE_LARGE_PROVIDER_PAYLOAD'.repeat(10000) }, text: 'PRIVATE_LARGE_PROVIDER_PAYLOAD'.repeat(1000), passed: false },
    ]
    const row = {
      id: 'original', workflow_id: 'workflow', created_at: new Date('2026-09-08T00:00:00Z'), runtime_inputs: { input: { episode_number: 41, qualityDisposition: 'manual-review-v1' } },
      result: { id: 'original', nodeRuns: [
        ...outputs.map((output, index) => nodeRun(output, { id: `key-${index}`, node: { id: `target-${index}`, kind: index % 2 ? 'video' : 'code', title: `node ${index}` }, context: { payload: 'PRIVATE_CONTEXT'.repeat(1000) } })),
        nodeRun({ passed: false }, { id: 'first', node: { id: 'loop-target', kind: 'code' } }),
        nodeRun({ passed: true }, { id: 'second', node: { id: 'loop-target', kind: 'code' }, loopIndex: 1 }),
        nodeRun({ error: 'failed' }, { status: 'failed', error: 'failed', id: 'failed', revision: 3, loopIndex: null }),
        null, 7, 'malformed run', {},
      ] },
    }
    const rawNormalized = driveRecord(row)
    const compact = await project(row)
    const projected = driveRecord(compact)
    const recovery = { version: 'scene-cut-first-frame-schema165-fork-v1', workflowSchemaVersion: 165,
      sourceExecutionId: 'record-parent', sourceResultMd5: 'a'.repeat(32), workflowNodesMd5: 'b'.repeat(32),
      workflowEdgesMd5: 'c'.repeat(32),
      preservedPrefixLength: 1, firstPendingNodeId: 'sanguo-first-frame-branch', ignoredPrivateField: 'HIDDEN' }
    const recoveryRow = { ...row, result: { ...row.result, selectedNodeId: 'sanguo-first-frame-branch',
      sceneCutFirstFrameRecovery: recovery } }
    assert.deepEqual(driveRecord(await project(recoveryRow)), driveRecord(recoveryRow))
    assert.doesNotMatch(JSON.stringify(driveRecord(recoveryRow)), /HIDDEN/)
    const localV8 = { version: 'scene-cut-a8b6-local-first-frame-v8',
      sourceExecutionId: 'record-parent',
      priorLocalV7ExecutionId: 'record-rejected-v7',
      priorLocalV7ResultMd5: 'a'.repeat(32),
      priorLocalV7RejectedReviewSha256: 'b'.repeat(64),
      priorLocalV7ReviewModelExecutionId: 'model-run-example',
      wallImageGenRawSha256: 'c'.repeat(64),
      sourceReceiptSha256: 'd'.repeat(64),
      outputSha256: 'e'.repeat(64), ignoredPrivateField: 'HIDDEN' }
    const localV8Row = { ...row, result: { ...row.result,
      sceneCutA8B6LocalFrameRecovery: localV8 } }
    assert.deepEqual(driveRecord(await project(localV8Row)),
      driveRecord(localV8Row))
    assert.doesNotMatch(JSON.stringify(driveRecord(localV8Row)), /HIDDEN/)
    const compositeRow = { ...row, result: { ...row.result,
      sceneCutCompositeRecovery: {
        version: 'source-bound-composite-a8b6-fresh-first-shot-v1',
        sourceExecutionId: 'record-parent',
        imageApprovalExecutionId: 'record-approved-image',
        planId: 'a'.repeat(64), receiptSha256: 'b'.repeat(64),
        compositeVideoSha256: 'c'.repeat(64),
        firstPendingIndex: 53, firstPendingNodeId: 'sanguo-media-request',
        ignoredPrivateField: 'HIDDEN' } } }
    assert.deepEqual(driveRecord(await project(compositeRow)),
      driveRecord(compositeRow))
    assert.doesNotMatch(JSON.stringify(driveRecord(compositeRow)), /HIDDEN/)
    const freshScene2Row = { ...row, result: { ...row.result,
      sceneCutFirstFrameRecovery: {
        version: 'a8b6-fresh-scene2-script-replay-v1',
        firstShotPlanId: 'd'.repeat(64),
        firstShotManifestSha256: 'e'.repeat(64),
        firstShotReceiptSha256: 'f'.repeat(64),
        firstActualTailSha256: '1'.repeat(64),
        preservedPrefixSha256: '2'.repeat(64),
        firstPendingIndex: 66, firstPendingNodeId: 'sanguo-shot-script-review',
        ignoredPrivateField: 'HIDDEN' } } }
    assert.deepEqual(driveRecord(await project(freshScene2Row)),
      driveRecord(freshScene2Row))
    assert.doesNotMatch(JSON.stringify(driveRecord(freshScene2Row)), /HIDDEN/)
    assert.deepEqual(projected, rawNormalized)
    const packedProjection = driveRecord(await project({ ...row, result: encodeExecutionState(row.result) }))
    assert.deepEqual(packedProjection, rawNormalized)
    const pendingGate = { ...row, result: { id: row.id, nodeRuns: [
      nodeRun({ passed: true, qualityDisposition: 'manual-review-v1', manualDecisionRequired: true,
        qualityReview: { manualDecisionRequired: true } }, { id: 'manual-gate', node: { id: 'sanguo-scene-outline-accept', kind: 'code' } }),
      nodeRun(undefined, { id: 'paid-next', node: { id: 'sanguo-video', kind: 'video' }, status: 'idle' }),
    ] } }
    assert.equal(pendingManualDecision(driveRecord(await project(pendingGate)))?.id, 'sanguo-scene-outline-accept',
      'the compact SQL projection must retain the dual manual marker')
    for (let index = 0; index < outputs.length; index++) {
      assert.deepEqual(targetOutcome(projected, `target-${index}`), targetOutcome(rawNormalized, `target-${index}`), `output case ${index}`)
    }
    assert.equal(targetOutcome(projected, 'loop-target').done, false)
    assert.equal(failureSignature(projected), failureSignature(rawNormalized))
    const serialized = JSON.stringify(compact)
    assert.doesNotMatch(serialized, /PRIVATE_LARGE_PROVIDER_PAYLOAD|PRIVATE_CONTEXT/)
    assert.ok(serialized.length < JSON.stringify(row).length / 10)

    for (const status of ['idle', 'running', 'success', 'failed']) {
      const forkRow = { ...row, id: `fork-${status}`, created_at: new Date('2026-09-08T00:01:00Z'), result: {
        ...row.result, requestScopeId: row.id, nodeRuns: row.result.nodeRuns.map(run => run && typeof run === 'object' && run.id === 'failed'
          ? nodeRun({}, { id: 'failed', revision: 4, status }) : run),
      } }
      const fork = driveRecord(await project(forkRow))
      assert.equal(isRetryFork(projected, fork), isRetryFork(rawNormalized, driveRecord(forkRow)), status)
      assert.equal(isRetryFork(projected, fork), true, status)
      const independent = driveRecord(await project({ ...forkRow, result: { ...forkRow.result, requestScopeId: 'unrelated' } }))
      assert.equal(isRetryFork(projected, independent), false)
    }
    for (const nodeRuns of [undefined, null, 'not an array', {}]) {
      const malformed = { ...row, result: { nodeRuns } }
      assert.deepEqual(driveRecord(await project(malformed)), driveRecord(malformed))
    }
  } finally {
    await client.query('rollback')
    client.release()
    await pool.end()
  }
})
