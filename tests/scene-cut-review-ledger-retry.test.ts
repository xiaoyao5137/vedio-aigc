import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertSceneCutApprovalRetryHop,
  assertSceneCutReviewLedgerRecord,
  completedRepairBindingForReview, usesSignedImageRepairInheritance } from '../server/scene-cut-frame-runtime.ts'
import { encodeExecutionState } from '../src/execution-storage.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from '../src/scene-cut-action-start-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

test('both recorded reapproval versions reuse the signed image ledger', () => {
  assert.equal(usesSignedImageRepairInheritance({ version: 'scene-cut-approval-rebind-v1' }), true)
  assert.equal(usesSignedImageRepairInheritance({ version: 'scene-cut-approval-rebind-v2' }), true)
  assert.equal(usesSignedImageRepairInheritance({ version: 'scene-cut-approval-rebind-v3' }), false)
  assert.equal(usesSignedImageRepairInheritance(undefined), false)
})

test('truncated review ledger binds the full archived prompt and frozen identity bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-review-ledger-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const board = Buffer.from('frozen board jpeg fixture')
    const image = Buffer.from('independent first frame attachment')
    await writeFile(path.join(root, 'public/generated/board.jpg'), board)
    await writeFile(path.join(root, 'public/generated/review.jpg'), image)
    const report = { evidenceUrl: '/generated/report.json',
      items: [{ role: 'candidate_first', url: '/generated/review.jpg',
        detail: 'x'.repeat(110000) }] }
    await writeFile(path.join(root, 'public/generated/report.json'), JSON.stringify(report))
    const evidence = { evidenceUrl: report.evidenceUrl,
      items: [{ url: '/generated/review.jpg', role: 'candidate_first',
        detail: report.items[0].detail }] }
    const uri = `data:image/jpeg;base64,${board.toString('base64')}`
    const sources = { sourceContext: { approvedOutline: { scenes: [] } },
      referenceBindings: [{ frontUrl: '/generated/board.jpg', frontSha256: sha256(board) }],
      imageReferenceImages: [uri] }
    const shot = { id: 'scene-01', continuity: { mode: 'scene_cut' },
      visualTreatment: 'live_action' }
    const plan = { version: 'scene-cut-opening-plan-v3' }
    const expected = { evidence, shot, sources, openingStatePlan: plan,
      reviewImages: ['/generated/review.jpg'] }
    const prompt = renderWorkflowTemplate(SCENE_CUT_FRAME_REVIEW_PROMPT_V174,
      { scene_cut_evidence: report, shot_script: shot,
        scene_cut_sources: sources, scene_cut_opening_state: plan })
    assert.ok(prompt.length > 100000)
    const review = { version: 'scene-cut-first-frame-review-v1', passed: true }
    const row = { id: 'model-run-archived-review', channel: 'workflow',
      workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-review',
      model_id: 'codex-local-vision', capability: 'text', provider: 'Codex',
      status: 'succeeded', request_data: { fingerprint: 'a'.repeat(64),
        params: { ...expected, sources: { ...sources,
          imageReferenceImages: [`[素材内容已隐藏，${uri.length} 字符]`] } },
        prompt: `${prompt.slice(0, 100000)}[日志截断，共${prompt.length}字符]`,
        reviewImageHashes: [{ url: '/generated/review.jpg', sha256: sha256(image) }] },
      response_data: { text: JSON.stringify(review), raw: { promptSha256: sha256(prompt) } } }
    assert.equal(assertSceneCutReviewLedgerRecord(row, { ...review, model: row.model_id },
      expected, root, 174), row.id)
    assert.throws(() => assertSceneCutReviewLedgerRecord({ ...row,
      response_data: { ...row.response_data, raw: {} } },
    { ...review, model: row.model_id }, expected, root, 174), /完整提示哈希/)
    assert.throws(() => assertSceneCutReviewLedgerRecord({ ...row,
      request_data: { ...row.request_data,
        params: { ...row.request_data.params, sources: { ...row.request_data.params.sources,
          imageReferenceImages: ['[素材内容已隐藏，123 字符]'] } } } },
    { ...review, model: row.model_id }, expected, root, 174), /当前 sources/)
    await writeFile(path.join(root, 'public/generated/board.jpg'), Buffer.from('changed board'))
    assert.throws(() => assertSceneCutReviewLedgerRecord(row,
      { ...review, model: row.model_id }, expected, root, 174), /人设板字节/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('multi-hop approval retry preserves every completed run and advances only the approval revision', () => {
  const prefix = Array.from({ length: 50 }, (_, index) => ({ id: `node-${index}`,
    status: 'success', output: { value: index } }))
  const marker = { version: 'scene-cut-image-repair-schema178-fork-v2',
    workflowSchemaVersion: 178, workflowNodesMd5: 'a'.repeat(32),
    workflowEdgesMd5: 'b'.repeat(32) }
  const base = { id: 'record-review-source', requestScopeId: 'record-scope',
    generationScopeId: 'record-review-source', workflowId: 'wf-sanguo-history-drama',
    sceneCutImageRepairRecovery: marker,
    nodeRuns: [...prefix, { id: 'approval', node: { id: 'sanguo-scene-cut-approval' },
      status: 'failed' }] }
  const retry = { ...base, id: 'record-retry-one', parentExecutionId: base.id,
    generationScopeId: 'record-retry-one', nodeRuns: [...prefix,
      { ...base.nodeRuns[50], status: 'failed', revision: 1 }] }
  const active = { ...retry, id: 'record-retry-two', parentExecutionId: retry.id,
    generationScopeId: 'record-retry-two', nodeRuns: [...prefix,
      { ...retry.nodeRuns[50], status: 'running', revision: 2 }] }
  assert.equal(assertSceneCutApprovalRetryHop(base, retry, false), true)
  assert.equal(assertSceneCutApprovalRetryHop(retry, active, true), true)
  assert.throws(() => assertSceneCutApprovalRetryHop(retry, { ...active,
    nodeRuns: [{ ...prefix[0], output: { value: -1 } }, ...active.nodeRuns.slice(1)] }, true),
  /重试分支/)
  assert.throws(() => assertSceneCutApprovalRetryHop(retry, { ...active,
    nodeRuns: [...prefix, { ...active.nodeRuns[50], revision: 3 }] }, true), /重试分支/)
  assert.throws(() => assertSceneCutApprovalRetryHop(retry, { ...active,
    sceneCutImageRepairRecovery: { ...marker, workflowSchemaVersion: 179 } }, true), /重试分支/)
  const tailMarker = { version: 'scene-cut-approval-rebind-v2',
    sourceExecutionId: 'record-source' }
  const failedTail = { ...retry, sceneCutApprovalRebindRecovery: tailMarker }
  const activeTail = { ...active, sceneCutApprovalRebindRecovery: tailMarker }
  assert.equal(assertSceneCutApprovalRetryHop(failedTail, activeTail, true), true)
  assert.throws(() => assertSceneCutApprovalRetryHop(failedTail,
    { ...activeTail, sceneCutApprovalRebindRecovery: { ...tailMarker,
      sourceExecutionId: 'record-other' } }, true), /重试分支/)
})

test('a later paid image supersedes an inherited reuse receipt only with its own ledger', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-paid-retry-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const bytes = Buffer.from('new paid scene cut image')
    const url = `/generated/image-${sha256(bytes).slice(0, 32)}.png`
    await writeFile(path.join(root, `public${url}`), bytes)
    const review = { frame: { sourceUrl: url } }
    const evidence = { items: [{ url }] }
    const shot = { id: 'scene-01' }, sources = { identityPlateVersion: 'v4' }
    const runs = Array.from({ length: 51 }, (_, index) => ({ id: `run-${index}`,
      status: index === 50 ? 'running' : 'success', output: {} }))
    runs[11].output = shot
    runs[41].output = sources
    runs[45].output = { url, model: 'paid-image-model',
      raw: { raw: { image: { sha256: sha256(bytes) } } } }
    runs[48].output = evidence
    runs[49].output = review
    const parent = { id: 'record-paid-image', workflowId: 'wf-sanguo-history-drama',
      nodeRuns: runs }
    const child = { ...parent, id: 'record-approval', parentExecutionId: parent.id,
      sceneCutApprovedImageReuse: { version: 'scene-cut-approved-image-reuse-v1',
        originalImageUrl: '/generated/image-00000000000000000000000000000000.png' } }
    const ledger = { id: 'model-run-new-image', status: 'succeeded',
      workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-first-frame',
      model_id: 'paid-image-model', request_data: { requestKey:
        'record-paid-image:attempt-1:revision-1:sanguo-scene-cut-first-frame:0:scene-01' },
      response_data: { data: [{ url }] } }
    const pool = (includeLedger: boolean) => ({ query: async (sql: string, params: unknown[]) => {
      if (sql.includes('from execution_records')) {
        const state = params[0] === child.id ? child : parent
        return { rows: [{ result: encodeExecutionState(state), result_md5: 'a'.repeat(32) }] }
      }
      if (sql.includes('from model_execution_records'))
        return { rows: includeLedger ? [ledger] : [] }
      throw Error(`Unexpected query: ${sql}`)
    } })
    const row = { request_data: { requestKey:
      'record-approval:attempt-1:revision-1:sanguo-scene-cut-review:0:scene-01' } }
    const input = { executionRecordId: child.id, review, evidence, shot, sources }
    assert.equal(await completedRepairBindingForReview(pool(true), row, input, root), undefined)
    await assert.rejects(completedRepairBindingForReview(pool(false), row, input, root),
      /新首帧缺少成功模型账本/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
