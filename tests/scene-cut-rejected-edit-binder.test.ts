import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { prepareRejectedSceneCutEditReference } from '../scripts/prepare-scene-cut-rejected-image-edit-reference.mjs'
import { bindSceneCutRejectedEditReference, parseSceneCutRepairImageRequestKey,
  prepareSceneCutRejectedEditBoundRequest,
  readSceneCutRepairVideoContext, verifySceneCutRepairImageLedger,
  verifySceneCutRepairReceiptForCompletedFork } from '../server/scene-cut-rejected-edit-binder.mjs'

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const jsonSha = (value: unknown) => sha(JSON.stringify(value))
const reverseObjectKeys = (value: unknown): unknown => Array.isArray(value)
  ? value.map(reverseObjectKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)])) : value

async function fixture() {
  const boards = await Promise.all(['#704b31', '#484336'].map(color => sharp({ create: {
    width: 32, height: 32, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer()))
  const png = await sharp({ create: { width: 64, height: 36, channels: 3,
    background: '#a47849' } }).png().toBuffer()
  const anchor = { sourceId: 'record-source-v6', sourceMd5: 'a'.repeat(32),
    parentId: 'record-parent-v5', parentMd5: 'b'.repeat(32),
    originalId: 'record-original', originalMd5: 'c'.repeat(32),
    sourceImageSha256: sha(png), sourceReviewSha256: '', boardSha256s: boards.map(sha) }
  const shot = { id: 'scene-01', visualTreatment: 'live_action', firstFrameMode: 'reference' }
  const imageUrl = `/generated/image-${anchor.sourceImageSha256.slice(0, 32)}.png`
  const sources = { version: 'scene-cut-sources-v1', identityPlateVersion: 'scene-cut-identity-plate-v4',
    referenceBindings: boards.map((bytes, index) => ({ characterName: `person-${index + 1}`,
      frontUrl: `/generated/board-${index + 1}.jpg`, frontSha256: sha(bytes) })),
    imageReferenceImages: boards.map(bytes => `data:image/jpeg;base64,${bytes.toString('base64')}`) }
  const plan = { shotId: 'scene-01', version: 'scene-cut-opening-plan-v3' }
  const evidence = { evidenceUrl: '/generated/evidence.jpg', items: [{ url: imageUrl }] }
  const review = { passed: false, issues: [{ code: 'SUBJECT_OCCLUDED' }],
    evidenceUrl: evidence.evidenceUrl, frame: { sourceUrl: imageUrl }, model: 'review-model' }
  anchor.sourceReviewSha256 = jsonSha(review)
  const parentRuns = Array.from({ length: 53 }, (_, index) => ({ id: `run-${index}`,
    node: { id: `unused-${index}` }, status: 'idle', loopIndex: 0,
    output: undefined as unknown, inputs: undefined as unknown, context: undefined as unknown }))
  parentRuns[41] = { ...parentRuns[41], node: { id: 'sanguo-scene-cut-source-archive' },
    status: 'success', output: sources }
  parentRuns[43] = { ...parentRuns[43], node: { id: 'sanguo-scene-cut-opening-plan' },
    status: 'success', output: plan }
  parentRuns[44].context = { shot_script: shot }
  const params = { referenceImages: sources.imageReferenceImages, sceneCutSources: sources,
    sceneCutOpeningPlan: plan, sceneCutShot: shot }
  parentRuns[45] = { ...parentRuns[45], node: { id: 'sanguo-scene-cut-first-frame' },
    status: 'success', output: { url: imageUrl, params } }
  parentRuns[48] = { ...parentRuns[48], node: { id: 'sanguo-scene-cut-evidence' },
    status: 'success', output: evidence }
  parentRuns[49] = { ...parentRuns[49], node: { id: 'sanguo-scene-cut-review' },
    status: 'success', output: review }
  parentRuns[50].node = { id: 'sanguo-scene-cut-approval' }
  parentRuns[52].node = { id: 'sanguo-video' }
  const originalLock = { sourceExecutionId: anchor.originalId, sourceResultMd5: anchor.originalMd5 }
  const parent = { id: anchor.sourceId, workflowId: 'wf-sanguo-history-drama',
    sceneCutFirstFrameRecovery: { workflowSchemaVersion: 176 },
    originalTwoShotRepairRecovery: originalLock, nodeRuns: parentRuns }
  const prepared = await prepareRejectedSceneCutEditReference({ source: parent,
    sourceResultMd5: anchor.sourceMd5, expectedSourceId: anchor.sourceId,
    expectedSourceMd5: anchor.sourceMd5, expectedImageSha256: anchor.sourceImageSha256,
    expectedReviewSha256: anchor.sourceReviewSha256,
    sourcePngBytes: png, identityBoardBytes: boards })
  const workflowNode = { id: 'sanguo-scene-cut-first-frame', prompt: 'managed edit prompt' }
  const current = structuredClone(parent) as typeof parent & Record<string, unknown>
  current.id = 'record-repair-v7'
  current.parentExecutionId = anchor.sourceId
  current.generationScopeId = current.id
  current.selectedNodeId = workflowNode.id
  current.nodeRuns[45] = { ...current.nodeRuns[45], node: workflowNode,
    status: 'running', inputs: params, output: undefined, attempt: 1, revision: 0 }
  for (const run of current.nodeRuns.slice(46)) {
    run.status = 'idle'; run.output = undefined
  }
  const workflowRow = { id: 'wf-sanguo-history-drama', schema_version: 177,
    nodes: [workflowNode], nodes_md5: 'd'.repeat(32), edges_md5: 'e'.repeat(32) }
  current.sceneCutImageRepairRecovery = { version: 'scene-cut-image-repair-schema177-fork-v1',
    sourceExecutionId: anchor.sourceId, sourceResultMd5: anchor.sourceMd5,
    parentExecutionId: anchor.parentId, parentResultMd5: anchor.parentMd5,
    originalExecutionId: anchor.originalId, originalResultMd5: anchor.originalMd5,
    workflowSchemaVersion: 177, workflowNodesMd5: workflowRow.nodes_md5,
    workflowEdgesMd5: workflowRow.edges_md5, preservedPrefixLength: 45,
    firstPendingNodeId: workflowNode.id, failedImageFileSha256: anchor.sourceImageSha256,
    failedReviewOutputSha256: anchor.sourceReviewSha256,
    repairPreparationSha256: prepared.receiptSha256,
    preservedPrefixOutputsHash: createJsonHasher()(parentRuns.slice(0, 45)
      .map(run => run.output ?? null)), receipt: prepared.receipt }
  const imageKey = `${anchor.sourceId}:attempt-1:revision-0:sanguo-scene-cut-first-frame:0:scene-01`
  const reviewKey = `${anchor.sourceId}:attempt-1:revision-0:sanguo-scene-cut-review:0:scene-01`
  const imageLedger = { id: 'model-run-parent-image', channel: 'workflow',
    workflow_id: workflowRow.id, node_id: workflowNode.id, capability: 'image',
    provider: 'Codex', status: 'succeeded', request_data: { requestKey: imageKey,
      fingerprint: 'f'.repeat(64) }, response_data: { data: [{ url: imageUrl }],
      raw: { image: { sha256: anchor.sourceImageSha256, bytes: png.length },
        references: prepared.receipt.referenceOrder.slice(0, 2).map(item => ({
          index: item.position, bytes: item.bytes, sha256: item.sha256 })) } } }
  const reviewLedger = { id: 'model-run-parent-review', channel: 'workflow',
    workflow_id: workflowRow.id, node_id: 'sanguo-scene-cut-review',
    capability: 'text', provider: 'Codex', status: 'succeeded', model_id: review.model,
    request_data: { requestKey: reviewKey, fingerprint: '1'.repeat(64) },
    response_data: { content: [{ type: 'text', text: JSON.stringify(Object.fromEntries(
      Object.entries(review).filter(([name]) => name !== 'model'))) }] } }
  const proof = { currentRow: { id: current.id, workflow_id: workflowRow.id, result: current },
    parentRow: { id: parent.id, workflow_id: workflowRow.id, result: parent,
      result_md5: anchor.sourceMd5 },
    lineageRow: { id: anchor.parentId, workflow_id: workflowRow.id,
      result_md5: anchor.parentMd5 },
    originalRow: { id: anchor.originalId, workflow_id: workflowRow.id,
      result_md5: anchor.originalMd5 }, workflowRow, sourcePngBytes: png,
    identityBoardBytes: boards, parentImageLedgerRows: [imageLedger],
    parentReviewLedgerRows: [reviewLedger] }
  const request = { model: { id: 'image-model', provider: 'Codex',
    capability: 'image', settings: {} }, prompt: 'managed edit prompt', params,
    executionContext: { workflowId: workflowRow.id, nodeId: workflowNode.id,
      requestKey: `${current.id}:attempt-1:revision-0:sanguo-scene-cut-first-frame:0:scene-01` } }
  return { anchor, proof, request, prepared, png, boards }
}

test('repair request binds three ordered, byte-pinned references and both failed parent ledgers', async () => {
  const f = await fixture()
  const bound = await prepareSceneCutRejectedEditBoundRequest(f.request, f.proof, f.anchor)
  assert.equal(bound.applied, true)
  assert.equal(bound.request.params.referenceImages.length, 3)
  assert.deepEqual(bound.request.params.referenceImages.slice(0, 2), f.request.params.referenceImages)
  assert.equal(bound.request.params.sceneCutRepairReceipt.approvedFirstFrame, false)
  assert.equal(bound.ledgerIdentity.sourceImageModelExecutionId, 'model-run-parent-image')
  assert.equal(bound.ledgerIdentity.failedReviewModelExecutionId, 'model-run-parent-review')
  assert.equal(bound.ledgerIdentity.preparationSha256, f.prepared.receiptSha256)
  assert.deepEqual(bound.ledgerIdentity.referenceSha256s.slice(0, 2), f.anchor.boardSha256s)
  assert.match(bound.ledgerIdentity.requestFingerprint, /^[a-f0-9]{64}$/)
})

test('altered recovery, frozen board, or ambiguous parent receipt blocks a provider request', async () => {
  const f = await fixture()
  f.proof.currentRow.result.sceneCutImageRepairRecovery.failedReviewOutputSha256 = '0'.repeat(64)
  await assert.rejects(prepareSceneCutRejectedEditBoundRequest(f.request, f.proof, f.anchor),
    /provenance changed/)
  const changedBoard = await fixture()
  changedBoard.proof.identityBoardBytes.reverse()
  await assert.rejects(prepareSceneCutRejectedEditBoundRequest(changedBoard.request,
    changedBoard.proof, changedBoard.anchor), /identity board 1 bytes or order changed/)
  const duplicate = await fixture()
  duplicate.proof.parentImageLedgerRows.push(duplicate.proof.parentImageLedgerRows[0])
  await assert.rejects(prepareSceneCutRejectedEditBoundRequest(duplicate.request,
    duplicate.proof, duplicate.anchor), /image ledger is missing or ambiguous/)
})

test('strict request keys reject another loop or node; ordinary image requests remain unchanged', async () => {
  assert.deepEqual(parseSceneCutRepairImageRequestKey(
    'record-repair-v7:attempt-1:revision-0:sanguo-scene-cut-first-frame:0:scene-01'),
  { executionId: 'record-repair-v7', attempt: 1, revision: 0,
    loopIndex: 0, sceneId: 'scene-01' })
  assert.throws(() => parseSceneCutRepairImageRequestKey(
    'record-repair-v7:attempt-1:revision-0:sanguo-scene-cut-first-frame:1:scene-02'),
  /requestKey does not identify/)
  const f = await fixture()
  const ordinary = { ...f.proof.currentRow.result, sceneCutImageRepairRecovery: undefined }
  const db = { query: async () => ({ rows: [{ ...f.proof.currentRow, result: ordinary }] }) }
  const bound = await bindSceneCutRejectedEditReference(db, f.request)
  assert.equal(bound.applied, false)
  assert.equal(bound.request, f.request)
  const nextScene = { ...f.request, params: { ...f.request.params,
    sceneCutShot: { ...f.request.params.sceneCutShot, id: 'scene-02' } },
  executionContext: { ...f.request.executionContext,
    requestKey: 'record-next:attempt-1:revision-0:sanguo-scene-cut-first-frame:1:scene-02' } }
  const laterBound = await bindSceneCutRejectedEditReference({ query: async () => {
    throw Error('historical first-scene binder must not read a later loop')
  } }, nextScene)
  assert.equal(laterBound.applied, false)
  assert.equal(laterBound.request, nextScene)
  await assert.rejects(bindSceneCutRejectedEditReference(db, { ...nextScene,
    params: { ...nextScene.params, sceneCutShot: { id: 'scene-03' } } }),
  /requestKey does not identify/)
})

test('paid video context reads the single persisted running loop and preserves optional recovery', async () => {
  const f = await fixture()
  const state = f.proof.currentRow.result
  state.selectedNodeId = 'sanguo-video'
  state.nodeRuns[52] = { ...state.nodeRuns[52], node: { id: 'sanguo-video' },
    status: 'running', attempt: 1, revision: 0, loopIndex: 0,
    inputs: { sceneCutShot: { id: 'scene-01' } } }
  const request = { model: { capability: 'video' }, params: { sceneCutShot: { id: 'scene-01' } },
    executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video',
      requestKey: `${state.id}:attempt-1:revision-0:sanguo-video:0:scene-01` } }
  const db = { query: async () => ({ rows: [{ id: state.id,
    workflow_id: state.workflowId, result: state }] }) }
  assert.deepEqual(await readSceneCutRepairVideoContext(db, request),
    { executionId: state.id, recovery: state.sceneCutImageRepairRecovery })
  await assert.rejects(readSceneCutRepairVideoContext(db, { ...request,
    params: { sceneCutShot: { id: 'scene-02' } } }), /not bound/)
})

test('second scene checks its own persisted run and ignores inherited first-shot tail guide markers', async () => {
  const f = await fixture()
  const state = f.proof.currentRow.result
  state.selectedNodeId = 'sanguo-video'
  state.sceneCutApprovalRebindRecovery = { version: 'scene-cut-approval-rebind-v2' }
  state.nodeRuns.push({ id: 'second-video', node: { id: 'sanguo-video' },
    status: 'running', attempt: 1, revision: 0, loopIndex: 1,
    inputs: { sceneCutShot: { id: 'scene-02' } } })
  const request = { model: { capability: 'video' }, params: { sceneCutShot: { id: 'scene-02' } },
    executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video',
      requestKey: `${state.id}:attempt-1:revision-0:sanguo-video:1:scene-02` } }
  const db = { query: async () => ({ rows: [{ id: state.id,
    workflow_id: state.workflowId, result: state }] }) }
  assert.deepEqual(await readSceneCutRepairVideoContext(db, request),
    { executionId: state.id, recovery: null, tailGuide: null })
  await assert.rejects(readSceneCutRepairVideoContext(db, { ...request,
    params: { sceneCutShot: { id: 'scene-01' } } }), /not bound/)
})

test('completed image ledger must record the three actual reference hashes and fresh candidate PNG', async () => {
  const f = await fixture()
  const bound = await prepareSceneCutRejectedEditBoundRequest(f.request, f.proof, f.anchor)
  const receipt = bound.request.params.sceneCutRepairReceipt
  const candidateBytes = await sharp({ create: { width: 64, height: 36, channels: 3,
    background: '#244a67' } }).png().toBuffer()
  const candidateUrl = `/generated/image-${sha(candidateBytes).slice(0, 32)}.png`
  const imageExecutionId = 'model-run-fresh-candidate'
  const requestKey = f.request.executionContext.requestKey
  const requestFingerprint = bound.ledgerIdentity.requestFingerprint
  const ledger = { id: imageExecutionId, channel: 'workflow',
    workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-first-frame',
    capability: 'image', provider: 'Codex', status: 'succeeded', model_id: f.request.model.id,
    request_data: { requestKey, fingerprint: requestFingerprint,
      sceneCutRepairReceiptSha256: bound.ledgerIdentity.repairReceiptSha256,
      prompt: f.request.prompt, params: { sceneCutRepairReceipt: receipt } },
    response_data: { data: [{ url: candidateUrl }], raw: {
      image: { sha256: sha(candidateBytes), bytes: candidateBytes.length },
      references: receipt.referenceOrder.map(item => ({ index: item.position,
        bytes: item.bytes, sha256: item.sha256 ?? item.jpegSha256 })) } } }
  const input = { ledger, receipt, candidateBytes, candidateUrl, imageExecutionId,
    requestFingerprint, requestKey, referenceOrder: receipt.referenceOrder,
    modelId: f.request.model.id, prompt: f.request.prompt }
  const proof = verifySceneCutRepairImageLedger(input)
  assert.equal(proof.candidateSha256, sha(candidateBytes))
  assert.deepEqual(proof.referenceSha256s, bound.ledgerIdentity.referenceSha256s)
  const jsonbReordered = reverseObjectKeys(receipt)
  assert.notEqual(JSON.stringify(jsonbReordered), JSON.stringify(receipt))
  const reorderedProof = verifySceneCutRepairImageLedger({ ...input, receipt: jsonbReordered,
    ledger: { ...ledger, request_data: { ...ledger.request_data,
      params: { sceneCutRepairReceipt: jsonbReordered } } } })
  assert.equal(reorderedProof.repairReceiptSha256, bound.ledgerIdentity.repairReceiptSha256)
  const staleThird = structuredClone(input)
  staleThird.ledger.response_data.raw.references[2].sha256 = '0'.repeat(64)
  assert.throws(() => verifySceneCutRepairImageLedger(staleThird), /three-reference request/)
  const oldImageAsCandidate = { ...input, candidateUrl: f.prepared.receipt.sourceImageUrl }
  assert.throws(() => verifySceneCutRepairImageLedger(oldImageAsCandidate), /three-reference request/)
})

test('completed fork verifier rebuilds third JPEG from the unchanged failed parent and joins fresh ledger', async () => {
  const f = await fixture()
  const bound = await prepareSceneCutRejectedEditBoundRequest(f.request, f.proof, f.anchor)
  const receipt = bound.request.params.sceneCutRepairReceipt
  const candidateBytes = await sharp({ create: { width: 64, height: 36, channels: 3,
    background: '#183858' } }).png().toBuffer()
  const candidateUrl = `/generated/image-${sha(candidateBytes).slice(0, 32)}.png`
  const imageExecutionId = 'model-run-fresh-candidate'
  const current = f.proof.currentRow.result
  current.nodeRuns[45].status = 'success'
  current.nodeRuns[45].output = { url: candidateUrl, model: f.request.model.id,
    prompt: f.request.prompt, params: f.request.params }
  const modelRow = { id: imageExecutionId, channel: 'workflow',
    workflow_id: f.proof.workflowRow.id, node_id: 'sanguo-scene-cut-first-frame',
    capability: 'image', provider: 'Codex', status: 'succeeded', model_id: f.request.model.id,
    request_data: { requestKey: f.request.executionContext.requestKey,
      fingerprint: bound.ledgerIdentity.requestFingerprint,
      sceneCutRepairReceiptSha256: bound.ledgerIdentity.repairReceiptSha256,
      prompt: f.request.prompt, params: { sceneCutRepairReceipt: receipt } },
    response_data: { data: [{ url: candidateUrl }], raw: {
      image: { sha256: sha(candidateBytes), bytes: candidateBytes.length },
      references: receipt.referenceOrder.map(item => ({ index: item.position,
        bytes: item.bytes, sha256: item.sha256 ?? item.jpegSha256 })) } } }
  const queryable = { query: async (sql: string, params: string[]) => {
    if (sql.includes('from execution_records')) {
      const rows = [f.proof.currentRow, f.proof.parentRow,
        f.proof.lineageRow, f.proof.originalRow]
      return { rows: rows.filter(row => row.id === params[0]).map(row => ({ ...row,
        result_md5: row.result_md5 ?? '9'.repeat(32) })) }
    }
    if (sql.includes('from workflow_configs')) return { rows: [f.proof.workflowRow] }
    if (sql.includes('from model_execution_records')) {
      if (params[0] === imageExecutionId) return { rows: [modelRow] }
      if (params[1] === 'sanguo-scene-cut-first-frame')
        return { rows: f.proof.parentImageLedgerRows }
      return { rows: f.proof.parentReviewLedgerRows }
    }
    throw Error(`unhandled read-only query: ${sql}`)
  } }
  const fileBytes = new Map([
    [f.proof.parentRow.result.nodeRuns[45].output.url, f.png],
    ...f.proof.parentRow.result.nodeRuns[41].output.referenceBindings.map((binding, index) =>
      [binding.frontUrl, f.boards[index]]),
    [candidateUrl, candidateBytes],
  ])
  const input = { executionId: current.id, receipt, candidateUrl, imageExecutionId,
    repairRequestFingerprint: bound.ledgerIdentity.requestFingerprint }
  const proof = await verifySceneCutRepairReceiptForCompletedFork(queryable, input, '.', {
    anchor: f.anchor,
    readGeneratedBytes: async (url: string) => {
      const bytes = fileBytes.get(url)
      if (!bytes) throw Error('fixture image missing')
      return bytes
    },
  })
  assert.equal(proof.candidateSha256, sha(candidateBytes))
  assert.equal(proof.repairReceiptSha256, bound.ledgerIdentity.repairReceiptSha256)
  modelRow.response_data.raw.references[2].sha256 = '0'.repeat(64)
  await assert.rejects(verifySceneCutRepairReceiptForCompletedFork(queryable, input, '.', {
    anchor: f.anchor,
    readGeneratedBytes: async (url: string) => fileBytes.get(url),
  }), /three-reference request/)
})
