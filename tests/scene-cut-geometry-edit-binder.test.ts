import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import sharp from 'sharp'
import { createJsonHasher } from '../scripts/restore-branch-checkpoint.mjs'
import { prepareRejectedSceneCutFourReferences } from '../scripts/prepare-scene-cut-rejected-image-four-reference.mjs'
import { prepareSceneCutGeometryBoundRequest, verifySceneCutRepairImageLedger,
  verifySceneCutRepairReceiptForCompletedFork } from '../server/scene-cut-rejected-edit-binder.mjs'

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const jsonSha = (value: unknown) => sha(JSON.stringify(value))

async function fixture() {
  const boards = await Promise.all(['#6d5844', '#433927'].map(color => sharp({ create: {
    width: 32, height: 32, channels: 3, background: color } }).jpeg({ quality: 90 }).toBuffer()))
  const png = await sharp({ create: { width: 64, height: 36, channels: 3,
    background: '#855c3d' } }).png().toBuffer()
  const guidePng = await sharp({ create: { width: 80, height: 45, channels: 3,
    background: '#5a6c70' } }).png().toBuffer()
  const anchor = { sourceId: 'record-rejected-v7', sourceMd5: 'a'.repeat(32),
    parentId: 'record-rejected-v6', parentMd5: 'b'.repeat(32),
    originalId: 'record-original', originalMd5: 'c'.repeat(32),
    sourceImageSha256: sha(png), sourceReviewSha256: '',
    guidePath: 'qa/record-fixture/geometry-guide-v8-12345678.png', guideSha256: sha(guidePng),
    guideJpegSha256: '', guideProvenancePath: 'qa/record-fixture/geometry-guide-v8-provenance.json',
    guideProvenanceSha256: '', guideIntermediateSha256: 'd'.repeat(64),
    guideDimensions: [80, 45], boardSha256s: boards.map(sha) }
  const shot = { id: 'scene-01', continuity: { mode: 'scene_cut' },
    visualTreatment: 'live_action', firstFrameMode: 'reference' }
  const imageUrl = `/generated/image-${anchor.sourceImageSha256.slice(0, 32)}.png`
  const sources = { version: 'scene-cut-sources-v1', shotId: shot.id,
    identityPlateVersion: 'scene-cut-identity-plate-v4',
    referenceBindings: boards.map((bytes, index) => ({ characterName: `person-${index + 1}`,
      frontUrl: `/generated/board-${index + 1}.jpg`, frontSha256: sha(bytes) })),
    imageReferenceImages: boards.map(bytes => `data:image/jpeg;base64,${bytes.toString('base64')}`) }
  const plan = { shotId: shot.id, version: 'scene-cut-opening-plan-v3' }
  const evidence = { evidenceUrl: '/generated/rejected-evidence.jpg', items: [{ url: imageUrl }] }
  const review = { passed: false, issues: [{ code: 'LEFT_GUARD_OCCLUDED' }],
    evidenceUrl: evidence.evidenceUrl, frame: { sourceUrl: imageUrl }, model: 'review-model' }
  anchor.sourceReviewSha256 = jsonSha(review)
  const priorReceipt = { version: 'scene-cut-rejected-image-edit-reference-v1',
    referenceOrder: boards.map((bytes, index) => ({ position: index + 1,
      sha256: sha(bytes), bytes: bytes.length })).concat({ position: 3,
      role: 'rejected-edit-source', jpegSha256: 'e'.repeat(64), bytes: 555 }) }
  const prior = { version: 'scene-cut-image-repair-schema177-fork-v1',
    sourceExecutionId: anchor.parentId, sourceResultMd5: anchor.parentMd5,
    repairPreparationSha256: 'd'.repeat(64), receipt: priorReceipt }
  const runs = Array.from({ length: 464 }, (_, index) => ({ id: `run-${index}`,
    node: { id: `unused-${index}` }, status: index < 45 ? 'success' : 'idle',
    loopIndex: Math.floor(Math.max(0, index - 9) / 56),
    output: undefined as unknown, inputs: undefined as unknown, context: undefined as unknown }))
  for (const index of [41, 43, 44, 45, 48, 49, 50, 52]) runs[index].loopIndex = 0
  runs[41] = { ...runs[41], node: { id: 'sanguo-scene-cut-source-archive' }, output: sources }
  runs[43] = { ...runs[43], node: { id: 'sanguo-scene-cut-opening-plan' }, output: plan }
  runs[44].context = { shot_script: shot }
  const params = { referenceImages: sources.imageReferenceImages,
    sceneCutSources: sources, sceneCutShot: shot, sceneCutOpeningPlan: plan }
  runs[45] = { ...runs[45], node: { id: 'sanguo-scene-cut-first-frame' },
    status: 'success', output: { url: imageUrl, params,
      raw: { modelExecutionId: 'model-run-prior-image',
        repairRequestFingerprint: 'f'.repeat(64), sceneCutRepairReceiptSha256: 'e'.repeat(64) } } }
  runs[48] = { ...runs[48], node: { id: 'sanguo-scene-cut-evidence' },
    status: 'success', output: evidence }
  runs[49] = { ...runs[49], node: { id: 'sanguo-scene-cut-review' },
    status: 'success', output: review }
  runs[50].node = { id: 'sanguo-scene-cut-approval' }
  runs[52].node = { id: 'sanguo-video' }
  const originalLock = { sourceExecutionId: anchor.originalId,
    sourceResultMd5: anchor.originalMd5 }
  const source = { id: anchor.sourceId, workflowId: 'wf-sanguo-history-drama',
    parentExecutionId: anchor.parentId,
    sceneCutFirstFrameRecovery: { workflowSchemaVersion: 177 },
    sceneCutImageRepairRecovery: prior, originalTwoShotRepairRecovery: originalLock,
    nodeRuns: runs }
  const prepared = await prepareRejectedSceneCutFourReferences({ source,
    sourceResultMd5: anchor.sourceMd5, expectedSourceId: anchor.sourceId,
    expectedSourceMd5: anchor.sourceMd5, expectedImageSha256: anchor.sourceImageSha256,
    expectedReviewSha256: anchor.sourceReviewSha256,
    expectedGuideSha256: anchor.guideSha256, guidePath: anchor.guidePath,
    sourcePngBytes: png, guidePngBytes: guidePng, identityBoardBytes: boards })
  anchor.guideJpegSha256 = prepared.receipt.referenceOrder[3].jpegSha256
  const provenance = { version: 'scene-cut-geometry-guide-v1', role: 'geometry-only-reference',
    approvedFirstFrame: false, sourceExecutionId: anchor.sourceId,
    sourceImageSha256: anchor.sourceImageSha256,
    identityBoardSha256: anchor.boardSha256s[1],
    intermediateImageSha256: anchor.guideIntermediateSha256,
    guideImagePath: anchor.guidePath, guideImageSha256: anchor.guideSha256,
    guideDimensions: anchor.guideDimensions,
    acceptanceStatus: 'unreviewed geometry reference only' }
  const provenanceBytes = Buffer.from(JSON.stringify(provenance))
  anchor.guideProvenanceSha256 = sha(provenanceBytes)
  const workflowNode = { id: 'sanguo-scene-cut-first-frame', prompt: 'v178 prompt' }
  const workflowRow = { id: source.workflowId, schema_version: 178, nodes: [workflowNode],
    nodes_md5: '8'.repeat(32), edges_md5: '9'.repeat(32) }
  const current = structuredClone(source) as typeof source & Record<string, unknown>
  current.id = 'record-new-v8'; current.parentExecutionId = source.id
  current.generationScopeId = current.id; current.selectedNodeId = workflowNode.id
  current.sceneCutFirstFrameRecovery = { workflowSchemaVersion: 178 }
  current.priorSceneCutImageRepairRecovery = structuredClone(prior)
  current.nodeRuns[45] = { ...current.nodeRuns[45], node: workflowNode,
    status: 'running', inputs: params, output: undefined, attempt: 1, revision: 0 }
  for (const run of current.nodeRuns.slice(46)) { run.status = 'idle'; run.output = undefined }
  current.sceneCutImageRepairRecovery = {
    version: 'scene-cut-image-repair-schema178-fork-v2',
    sourceExecutionId: anchor.sourceId, sourceResultMd5: anchor.sourceMd5,
    parentExecutionId: anchor.parentId, parentResultMd5: anchor.parentMd5,
    originalExecutionId: anchor.originalId, originalResultMd5: anchor.originalMd5,
    workflowSchemaVersion: 178, workflowNodesMd5: workflowRow.nodes_md5,
    workflowEdgesMd5: workflowRow.edges_md5,
    preservedPrefixLength: 45, firstPendingNodeId: workflowNode.id,
    failedImageFileSha256: anchor.sourceImageSha256,
    failedReviewOutputSha256: anchor.sourceReviewSha256,
    repairPreparationSha256: prepared.receiptSha256,
    priorRepairPreparationSha256: prior.repairPreparationSha256,
    geometryGuideSourcePath: anchor.guidePath,
    geometryGuideSourceSha256: anchor.guideSha256,
    geometryGuideJpegSha256: anchor.guideJpegSha256,
    geometryGuideProvenancePath: anchor.guideProvenancePath,
    geometryGuideProvenanceSha256: anchor.guideProvenanceSha256,
    preservedPrefixOutputsHash: createJsonHasher()(runs.slice(0, 45)
      .map(run => run.output ?? null)), receipt: prepared.receipt }
  const sourceImageKey = `${anchor.sourceId}:attempt-1:revision-0:sanguo-scene-cut-first-frame:0:scene-01`
  const sourceReviewKey = `${anchor.sourceId}:attempt-1:revision-0:sanguo-scene-cut-review:0:scene-01`
  const parentImageLedger = { id: 'model-run-prior-image', channel: 'workflow',
    workflow_id: source.workflowId, node_id: workflowNode.id, capability: 'image',
    provider: 'Codex', status: 'succeeded', request_data: {
      requestKey: sourceImageKey, fingerprint: 'f'.repeat(64),
      sceneCutRepairReceiptSha256: 'e'.repeat(64),
      params: { sceneCutRepairReceipt: { version: priorReceipt.version } } },
    response_data: { data: [{ url: imageUrl }], raw: {
      image: { sha256: anchor.sourceImageSha256, bytes: png.length },
      references: priorReceipt.referenceOrder.map(item => ({ index: item.position,
        bytes: item.bytes, sha256: item.sha256 ?? item.jpegSha256 })) } } }
  const parentReviewLedger = { id: 'model-run-prior-review', channel: 'workflow',
    workflow_id: source.workflowId, node_id: 'sanguo-scene-cut-review',
    capability: 'text', provider: 'Codex', status: 'succeeded', model_id: review.model,
    request_data: { requestKey: sourceReviewKey, fingerprint: 'a'.repeat(64) },
    response_data: { content: [{ type: 'text', text: JSON.stringify(Object.fromEntries(
      Object.entries(review).filter(([name]) => name !== 'model'))) }] } }
  const proof = { currentRow: { id: current.id, workflow_id: source.workflowId,
    result: current, result_md5: '7'.repeat(32) },
  parentRow: { id: source.id, workflow_id: source.workflowId,
    result: source, result_md5: anchor.sourceMd5 },
  lineageRow: { id: anchor.parentId, workflow_id: source.workflowId,
    result_md5: anchor.parentMd5 },
  originalRow: { id: anchor.originalId, workflow_id: source.workflowId,
    result_md5: anchor.originalMd5 },
  workflowRow, sourcePngBytes: png, identityBoardBytes: boards,
  guidePngBytes: guidePng, guideProvenanceBytes: provenanceBytes,
  parentImageLedgerRows: [parentImageLedger], parentReviewLedgerRows: [parentReviewLedger] }
  const request = { model: { id: 'image-model', provider: 'Codex',
    capability: 'image', settings: {} }, prompt: workflowNode.prompt,
  params, executionContext: { workflowId: source.workflowId, nodeId: workflowNode.id,
    requestKey: `${current.id}:attempt-1:revision-0:sanguo-scene-cut-first-frame:0:scene-01` } }
  return { anchor, proof, request, prepared, png, boards, guidePng, provenanceBytes }
}

test('v178 binds two frozen boards, rejected v7 frame, then geometry-only guide', async () => {
  const f = await fixture()
  const bound = await prepareSceneCutGeometryBoundRequest(f.request, f.proof, { anchor: f.anchor })
  assert.equal(bound.applied, true)
  assert.equal(bound.request.params.referenceImages.length, 4)
  assert.deepEqual(bound.request.params.referenceImages.slice(0, 2), f.request.params.referenceImages)
  assert.equal(bound.request.params.sceneCutRepairReceipt.approvedFirstFrame, false)
  assert.equal(bound.request.params.sceneCutRepairReceipt.referenceOrder[3].purpose, 'geometry-only')
  assert.equal(bound.request.params.sceneCutRepairReceipt.guideProvenanceSha256,
    f.anchor.guideProvenanceSha256)
  assert.deepEqual(bound.ledgerIdentity.referenceSha256s.slice(0, 2), f.anchor.boardSha256s)
  assert.equal(bound.ledgerIdentity.referenceSha256s[3], f.anchor.guideJpegSha256)
})

test('v178 rejects altered guide provenance, parent ledger, or guide order before provider call', async () => {
  const altered = await fixture()
  altered.proof.guideProvenanceBytes = Buffer.from(altered.proof.guideProvenanceBytes)
  altered.proof.guideProvenanceBytes[30] ^= 1
  await assert.rejects(prepareSceneCutGeometryBoundRequest(altered.request, altered.proof,
    { anchor: altered.anchor }), /provenance bytes changed/)
  const changedLedger = await fixture()
  changedLedger.proof.parentImageLedgerRows[0].response_data.raw.references[2].sha256 = '0'.repeat(64)
  await assert.rejects(prepareSceneCutGeometryBoundRequest(changedLedger.request,
    changedLedger.proof, { anchor: changedLedger.anchor }), /image ledger is missing or ambiguous/)
  const changedGuide = await fixture()
  changedGuide.proof.guidePngBytes = Buffer.from(changedGuide.proof.guidePngBytes)
  changedGuide.proof.guidePngBytes[20] ^= 1
  await assert.rejects(prepareSceneCutGeometryBoundRequest(changedGuide.request,
    changedGuide.proof, { anchor: changedGuide.anchor }), /guide differs from pinned bytes/)
})

test('v178 completed proof replays source and four-reference ledger without approving new frame', async () => {
  const f = await fixture()
  const bound = await prepareSceneCutGeometryBoundRequest(f.request, f.proof, { anchor: f.anchor })
  const current = f.proof.currentRow.result
  const candidateBytes = await sharp({ create: { width: 64, height: 36, channels: 3,
    background: '#476879' } }).png().toBuffer()
  const candidateUrl = `/generated/image-${sha(candidateBytes).slice(0, 32)}.png`
  current.nodeRuns[45].status = 'success'
  current.nodeRuns[45].output = { url: candidateUrl, model: f.request.model.id,
    prompt: f.request.prompt, params: f.request.params }
  const receipt = bound.request.params.sceneCutRepairReceipt
  const imageExecutionId = 'model-run-new-v8'
  const modelLedger = { id: imageExecutionId, channel: 'workflow',
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
  const reads = { query: async (sql: string, params: string[]) => {
    if (sql.includes('from execution_records')) return { rows: [f.proof.currentRow,
      f.proof.parentRow, f.proof.lineageRow, f.proof.originalRow]
      .filter(item => item.id === params[0]) }
    if (sql.includes('from workflow_configs')) return { rows: [f.proof.workflowRow] }
    if (sql.includes('from model_execution_records')) {
      if (params[0] === imageExecutionId) return { rows: [modelLedger] }
      if (params[1] === 'sanguo-scene-cut-first-frame')
        return { rows: f.proof.parentImageLedgerRows }
      return { rows: f.proof.parentReviewLedgerRows }
    }
    throw Error(`unexpected read-only SQL ${sql}`)
  } }
  const files = new Map<string, Buffer>([
    [f.proof.parentRow.result.nodeRuns[45].output.url, f.png],
    ...f.proof.parentRow.result.nodeRuns[41].output.referenceBindings.map((item, index) =>
      [item.frontUrl, f.boards[index]] as [string, Buffer]),
    [candidateUrl, candidateBytes],
  ])
  const guideFiles = new Map([[f.anchor.guidePath, f.guidePng],
    [f.anchor.guideProvenancePath, f.provenanceBytes]])
  const input = { executionId: current.id, receipt, candidateUrl, imageExecutionId,
    repairRequestFingerprint: bound.ledgerIdentity.requestFingerprint }
  const options = { geometryAnchor: f.anchor,
    readGeneratedBytes: async (url: string) => {
      const bytes = files.get(url)
      if (!bytes) throw Error('generated fixture missing')
      return bytes
    },
    readPinnedGuideBytes: async (_root: string, relativePath: string) => {
      const bytes = guideFiles.get(relativePath)
      if (!bytes) throw Error('guide fixture missing')
      return bytes
    },
  }
  const verified = await verifySceneCutRepairReceiptForCompletedFork(reads, input, '.', options)
  assert.equal(verified.candidateSha256, sha(candidateBytes))
  assert.deepEqual(verified.referenceSha256s, bound.ledgerIdentity.referenceSha256s)
  assert.equal('approvedFirstFrame' in verified, false)
  modelLedger.response_data.raw.references[3].sha256 = '0'.repeat(64)
  assert.throws(() => verifySceneCutRepairImageLedger({ ledger: modelLedger, receipt,
    candidateBytes, candidateUrl, imageExecutionId,
    requestFingerprint: input.repairRequestFingerprint,
    requestKey: f.request.executionContext.requestKey,
    referenceOrder: receipt.referenceOrder, modelId: f.request.model.id,
    prompt: f.request.prompt, guideAnchor: f.anchor }), /three-reference request/)
})
