import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFreshScene2ForkArgs } from '../scripts/fork-a8b6-fresh-original-scene2.mjs'
import { assertFreshA8B6Scene2ReplayBoundary } from
  '../server/staged-scene-cut-a8b6-fresh-scene2-replay.mjs'
import { assertFreshA8B6ImageReferenceProof,
  assertFreshA8B6DualOutputSource } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { verifyA8B6FreshV7EditReceiptSync } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { verifyA8B6FreshV8EditReceiptSync } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { verifyA8B6V7DualOutputRecoveryReceipt,
  verifyA8B6V7DualOutputClarification } from
  '../server/staged-scene-cut-a8b6-v7-dual-output.mjs'
import { DRIVE_RECORD_PROJECTION_SQL, driveRecord,
  verifiedIdleContinuation } from '../scripts/workflow-drive-state.mjs'

test('fresh scene-02 fork requires all CAS and plan locks before a DB write', () => {
  const base = ['--source', 'record-first', '--id', 'record-second',
    '--expected-source-md5', 'a'.repeat(32),
    '--expected-nodes-md5', 'b'.repeat(32),
    '--expected-edges-md5', 'c'.repeat(32),
    '--expected-plan-sha256', 'd'.repeat(64)]
  assert.equal(parseFreshScene2ForkArgs([...base, '--apply']).apply, true)
  assert.equal(parseFreshScene2ForkArgs([]).apply, false)
  assert.throws(() => parseFreshScene2ForkArgs(['--apply', '--source',
    'record-first']), /requires a new ID/)
  assert.throws(() => parseFreshScene2ForkArgs([...base.slice(0, -2),
    '--apply']), /requires a new ID/)
  assert.throws(() => parseFreshScene2ForkArgs([...base, '--id',
    'record-third']), /unknown or incomplete/)
  assert.throws(() => parseFreshScene2ForkArgs(['--source',
    'record-first', '--id', 'record-first']), /malformed/)
})

test('scene-02 replay cannot use an unsigned or incomplete first-shot state', () => {
  const source = { id: 'record-first', result_md5: 'a'.repeat(32),
    workflow_id: 'wf-sanguo-history-drama', result: { id: 'record-first',
      nodeRuns: Array.from({ length: 464 }, () => ({ status: 'idle' })) } }
  const original = { id: 'record-4x5m31',
    result_md5: '74e5e2f8afcf8f829694aef350629950',
    workflow_id: source.workflow_id,
    result: { nodeRuns: Array.from({ length: 408 }, () => ({})) } }
  const workflow = { id: source.workflow_id, schema_version: 180,
    nodes_md5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    edges_md5: '1d0a75acb3d4778a122a4cfd96a23b49',
    nodes: [], edges: [] }
  const prepared = { status: 'ready-for-new-image-review-only',
    plan: { version: 'scene2-regeneration-preflight-a8b6-fresh-v1',
      source: { firstExecutionId: source.id,
        firstResultMd5: source.result_md5,
        firstShotLineage: { version: 'source-bound-composite-a8b6-fresh-first-shot-v1',
          planId: 'f'.repeat(64), approvedDurationSeconds: 14,
          nativeFrameCount: 337 } } } }
  assert.throws(() => assertFreshA8B6Scene2ReplayBoundary(source, original,
    workflow, prepared), /formal first shot/)
  assert.throws(() => assertFreshA8B6Scene2ReplayBoundary({ ...source,
    result_md5: 'bad' }, original, workflow, prepared), /formal first shot/)
})

test('UI continuation admits only exact schema180 scene-02 review checkpoint', () => {
  const marker = { version: 'a8b6-fresh-scene2-script-replay-v1',
    sourceExecutionId: 'record-first', sourceResultMd5: 'a'.repeat(32),
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    preservedPrefixLength: 66, preservedPrefixSha256: 'b'.repeat(64),
    firstPendingIndex: 66,
    firstShotPlanId: 'c'.repeat(64),
    firstShotManifestSha256: 'd'.repeat(64),
    firstShotReceiptSha256: 'e'.repeat(64),
    firstActualTailSha256: 'f'.repeat(64),
    firstPendingNodeId: 'sanguo-shot-script-review' }
  const record = { workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: 'record-first',
    selectedNodeId: 'sanguo-shot-script-review',
    sceneCutFirstFrameRecovery: marker,
    runs: Array.from({ length: 464 }, (_, index) => ({
      id: index === 66 ? 'sanguo-shot-script-review' : `step-${index}`,
      status: index < 66 ? 'success' : 'idle',
      loopIndex: index < 65 ? 0 : 1,
    })) }
  const target = { workflowId: record.workflowId,
    nodeId: 'sanguo-shot-script-review' }
  for (const field of ['preservedPrefixSha256', 'firstPendingIndex',
    'firstShotPlanId', 'firstShotManifestSha256', 'firstShotReceiptSha256',
    'firstActualTailSha256']) {
    assert.match(DRIVE_RECORD_PROJECTION_SQL,
      new RegExp(`'${field}',result->'sceneCutFirstFrameRecovery'`))
    assert.equal(driveRecord({ id: 'record-scene2-preview',
      workflow_id: record.workflowId,
      result: { sceneCutFirstFrameRecovery: marker, nodeRuns: [] } })
      .sceneCutFirstFrameRecovery[field], marker[field])
  }
  assert.equal(verifiedIdleContinuation(record, target), record.runs[66])
  assert.throws(() => verifiedIdleContinuation({ ...record,
    sceneCutFirstFrameRecovery: { ...marker,
      firstActualTailSha256: null } }, target), /fresh 14s scene-02/)
  assert.throws(() => verifiedIdleContinuation({ ...record,
    parentExecutionId: 'record-other' }, target), /fresh 14s scene-02/)
  assert.throws(() => verifiedIdleContinuation({ ...record,
    runs: record.runs.map((run, index) => index === 65
      ? { ...run, status: 'idle' } : run) }, target), /fresh 14s scene-02/)
  assert.throws(() => verifiedIdleContinuation({ ...record,
    runs: record.runs.map((run, index) => index === 66
      ? { ...run, loopIndex: 0 } : run) }, target), /fresh 14s scene-02/)
})

test('V7 dual-output child resumes at node46 only while its saved prefix is intact', () => {
  const record = { id: 'record-4x5m31-a8b6-fresh-v7-dual-output-recovery',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: 'record-4x5m31-a8b6-fresh-first-frame-v7-edit',
    selectedNodeId: 'sanguo-map-end-accept',
    runs: Array.from({ length: 464 }, (_, index) => ({
      id: index === 46 ? 'sanguo-map-end-accept' : `step-${index}`,
      status: index < 46 ? 'success' : 'idle', loopIndex: 0,
    })) }
  const target = { workflowId: record.workflowId,
    nodeId: 'sanguo-map-end-accept' }
  assert.equal(verifiedIdleContinuation(record, target), record.runs[46])
  assert.throws(() => verifiedIdleContinuation({ ...record,
    parentExecutionId: 'record-unrelated' }, target), /V7 dual-output child/)
  assert.throws(() => verifiedIdleContinuation({ ...record,
    runs: record.runs.map((run, index) => index === 45
      ? { ...run, status: 'failed' } : run) }, target), /V7 dual-output child/)
})

test('V8 paid image resumes only at its signed idle node45 checkpoint', () => {
  const marker = { version: 'scene-cut-a8b6-fresh-first-frame-v8-edit',
    sourceExecutionId: 'record-4x5m31-a8b6-timing-approval-v3',
    sourceResultMd5: '7024e0652a9fd878ef00a5a2dcec99f8',
    priorFreshExecutionId:
      'record-4x5m31-a8b6-fresh-v7-dual-output-recovery',
    priorFreshResultMd5: '474085677d68cea9f0cb436e06bf71af',
    priorFreshImageSha256:
      'b96d9804eb28771cbe2cc2d5d6edc532ab3275abcbc71a4155e2da6d05b782be',
    priorFreshReviewSha256:
      'a38fdfaf7aff5d1f9a43ac0b1b71b27141899c37fc3026d1c1f8862797eace5c',
    editReceiptSha256:
      'ce8f4c2186a8460f8686d0caf04d51ffd218bfa36e16596f618cf4bbfa9639e2',
    workflowSchemaVersion: 180,
    workflowNodesMd5: '3ed9cf16e56b311458f4c6fa7e7f1e2e',
    workflowEdgesMd5: '1d0a75acb3d4778a122a4cfd96a23b49',
    firstPromptSha256: 'a'.repeat(64),
    reviewPromptSha256: 'b'.repeat(64),
    preservedPrefixLength: 45,
    preservedPrefixSha256: 'c'.repeat(64),
    firstPendingIndex: 45,
    firstPendingNodeId: 'sanguo-scene-cut-first-frame' }
  const record = { id: 'record-4x5m31-a8b6-fresh-first-frame-v8-edit',
    workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: marker.sourceExecutionId,
    selectedNodeId: marker.firstPendingNodeId,
    sceneCutA8B6FreshFrameRecovery: marker,
    runs: Array.from({ length: 464 }, (_, index) => ({
      id: index === 45 ? marker.firstPendingNodeId : `step-${index}`,
      status: index < 45 ? 'success' : 'idle', loopIndex: 0 })) }
  const target = { workflowId: record.workflowId,
    nodeId: marker.firstPendingNodeId }
  assert.equal(verifiedIdleContinuation(record, target), record.runs[45])
  assert.throws(() => verifiedIdleContinuation({ ...record,
    sceneCutA8B6FreshFrameRecovery: { ...marker,
      editReceiptSha256: '0'.repeat(64) } }, target), /V8 face edit/)
  assert.throws(() => verifiedIdleContinuation({ ...record,
    runs: record.runs.map((run, index) => index === 45
      ? { ...run, status: 'running' } : run) }, target), /V8 face edit/)
  const afterImage = { ...record,
    runs: record.runs.map((run, index) => index === 45
      ? { ...run, status: 'success' }
      : index === 46 ? { ...run, id: 'sanguo-map-end-accept' } : run) }
  const next = { workflowId: record.workflowId,
    nodeId: 'sanguo-map-end-accept' }
  assert.equal(verifiedIdleContinuation(afterImage, next), afterImage.runs[46])
  assert.throws(() => verifiedIdleContinuation({ ...afterImage,
    runs: afterImage.runs.map((run, index) => index === 47
      ? { ...run, status: 'success' } : run) }, next), /V8 face edit/)
  const reviewed = { ...afterImage,
    selectedNodeId: 'sanguo-scene-cut-review',
    runs: afterImage.runs.map((run, index) => index === 46
      ? { ...run, status: 'skipped' }
      : index === 47 || index === 48
        ? { ...run, status: 'success' }
        : index === 49
          ? { ...run, id: 'sanguo-scene-cut-review', status: 'success',
            output: { passed: true, issues: [] } }
          : index === 50
            ? { ...run, id: 'sanguo-scene-cut-approval' } : run) }
  const approval = { workflowId: record.workflowId,
    nodeId: 'sanguo-scene-cut-approval' }
  assert.equal(verifiedIdleContinuation(reviewed, approval), reviewed.runs[50])
  assert.throws(() => verifiedIdleContinuation({ ...reviewed,
    runs: reviewed.runs.map((run, index) => index === 49
      ? { ...run, output: { passed: false, issues: ['identity'] } } : run) },
  approval), /V8 face edit/)
})

test('V7 four image references preserve frozen identity and rejected layout roles', () => {
  const edit = verifyA8B6FreshV7EditReceiptSync()
  const refs = edit.receipt.referenceOrder as Array<{ bytes: number;
    sha256?: string; jpegSha256?: string }>
  const proof = refs.map((ref, index) => ({ index: index + 1,
    bytes: ref.bytes, sha256: index < 2 ? ref.sha256 : ref.jpegSha256 }))
  const source = { freshEditReceiptSha256: edit.receiptSha256,
    rejectedLayoutImageSha256: edit.receipt.sourceImageSha256,
    rejectedLayoutTransportSha256: refs[2].jpegSha256 }
  const plates = refs.slice(0, 2).map(ref => ({ frontSha256: ref.sha256 }))
  assert.equal(assertFreshA8B6ImageReferenceProof(proof, source, plates)
    .frozenFaceCropTransportSha256, refs[3].jpegSha256)
  assert.throws(() => assertFreshA8B6ImageReferenceProof(proof.slice(0, 3),
    source, plates), /signed image references/)
  assert.throws(() => assertFreshA8B6ImageReferenceProof(proof.map((item,
    index) => index === 3 ? { ...item, sha256: '0'.repeat(64) } : item),
  source, plates), /signed image references/)
  assert.throws(() => assertFreshA8B6ImageReferenceProof(proof,
    { ...source, rejectedLayoutTransportSha256: refs[3].jpegSha256 },
    plates), /signed image references/)
})

test('V8 five references keep the masked layout and V4 helper below frozen identity', () => {
  const edit = verifyA8B6FreshV8EditReceiptSync()
  const v7 = verifyA8B6FreshV7EditReceiptSync()
  const refs = edit.receipt.referenceOrder as Array<{ sha256?: string;
    sourceSha256?: string; jpegSha256?: string; jpegBytes?: number }>
  const oldRefs = v7.receipt.referenceOrder as Array<{ bytes: number }>
  const proof = refs.map((ref, index) => ({ index: index + 1,
    bytes: index < 2 ? oldRefs[index].bytes : index === 4
      ? oldRefs[3].bytes : ref.jpegBytes,
    sha256: index < 2 ? ref.sha256 : ref.jpegSha256 }))
  const source = { freshEditReceiptSha256: edit.receiptSha256,
    v8EditReceiptSha256: edit.receiptSha256,
    rejectedLayoutImageSha256: refs[2].sourceSha256,
    rejectedLayoutTransportSha256: refs[2].jpegSha256,
    maskedLayoutSourceSha256: refs[2].sourceSha256,
    maskedLayoutTransportSha256: refs[2].jpegSha256,
    v4FaceHelperSourceSha256: refs[3].sourceSha256,
    v4FaceHelperTransportSha256: refs[3].jpegSha256,
    frozenFaceCropSourceSha256: refs[4].sourceSha256,
    frozenFaceCropJpegSha256: refs[4].jpegSha256,
    frozenFaceCropBox: edit.receipt.referenceOrder[4].crop,
    v8SourceSelectionClarificationSha256:
      edit.receipt.sourceSelectionClarificationSha256 }
  const plates = refs.slice(0, 2).map(ref => ({ frontSha256: ref.sha256 }))
  assert.equal(assertFreshA8B6ImageReferenceProof(proof, source, plates)
    .referenceVariant, 'v8-five-reference')
  assert.throws(() => assertFreshA8B6ImageReferenceProof(proof,
    { ...source, v4FaceHelperTransportSha256: '0'.repeat(64) }, plates),
  /signed image references/)
  assert.throws(() => assertFreshA8B6ImageReferenceProof(proof,
    { ...source, v8SourceSelectionClarificationSha256: '0'.repeat(64) },
    plates), /signed image references/)
})

test('V7 paid-image recovery retains failed ledger and exact selected source', () => {
  const signed = verifyA8B6V7DualOutputRecoveryReceipt()
  const clarification = verifyA8B6V7DualOutputClarification()
  const receipt = signed.receipt
  const source = { dualOutputRecoveryReceiptSha256: signed.receiptSha256,
    dualOutputClarificationSha256: clarification.clarificationSha256,
    dualOutputSelectedSha256: receipt.selectedSourceSha256,
    dualOutputUnselectedSha256: receipt.unselectedSourceSha256,
    dualOutputThreadId: receipt.threadId,
    freshFrameExecutionId: receipt.targetExecutionId,
    imagePaymentExecutionId: receipt.failedExecutionId,
    imageModelExecutionId: receipt.failedImageModelExecutionId,
    approvedFirstFrameUrl: receipt.imageUrl,
    approvedFirstFrameSha256: receipt.normalizedImageSha256,
    freshEditReceiptSha256: receipt.editReceiptSha256 }
  assert.equal(assertFreshA8B6DualOutputSource(source)?.receiptSha256,
    signed.receiptSha256)
  assert.throws(() => assertFreshA8B6DualOutputSource({ ...source,
    imageModelExecutionId: 'model-run-false' }), /failed-ledger selection/)
  assert.throws(() => assertFreshA8B6DualOutputSource({ ...source,
    dualOutputSelectedSha256: receipt.unselectedSourceSha256 }),
  /failed-ledger selection/)
  assert.throws(() => assertFreshA8B6DualOutputSource({ ...source,
    dualOutputClarificationSha256: '0'.repeat(64) }),
  /failed-ledger selection/)
})
