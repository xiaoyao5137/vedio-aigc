import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isAnimatedVisualTreatment } from '../src/animation-shot.ts'
import { issueCoverageCutFrameApproval, validateCoverageCutVideoPayment } from './coverage-cut-frame-approval.ts'
import { assertCoverageCutReviewLedgerRecord } from './coverage-cut-review-ledger.ts'
import { modelRequestFingerprint } from './model-request-key.ts'

type Value = Record<string, unknown>
type MediaRequest = { model: { id: string; provider?: string; capability?: string; settings: Record<string, string> };
  prompt: string; params: Value; operation?: string;
  executionContext?: { workflowId?: string; nodeId?: string; requestKey?: string } }
type Queryable = { query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }> }
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const fail = (reason: string): never => { throw new Error(`COVERAGE_PAYMENT_BLOCKED: ${reason}`) }
function localImageBytes(url: unknown, root: string) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(url)) {
    fail('原图不是本地已归档图片')
  }
  try { return readFileSync(path.join(root, 'public', String(url))) }
  catch { return fail('已归档原图丢失') }
}

/** Paid image node must edit the archived actual tail, not merely mention it. */
export function validateCoverageCutPaidImageRequest(request: MediaRequest, root = process.cwd()) {
  if (request.model.capability !== 'image' || request.executionContext?.workflowId !== 'wf-sanguo-history-drama'
    || request.executionContext?.nodeId !== 'sanguo-coverage-first-frame') return
  const params = request.params, sources = object(params.coverageSources), tail = object(sources.previousTail)
  const bindings = Array.isArray(sources.referenceBindings) ? sources.referenceBindings.map(object) : []
  if (sources.version !== 'coverage-cut-sources-v1' || params.imageEdit !== true
    || params.referenceImage !== tail.url || tail.source !== 'extracted-from-video'
    || tail.available !== true || tail.sourceUrl !== tail.videoTailUrl
    || typeof tail.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tail.sha256)
    || bindings.length < 1 || bindings.length > 2
    || bindings.some(binding => !binding.assetId || !binding.characterName || !binding.url
      || typeof binding.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256))) {
    fail('新机位首帧没有绑定归档的真实尾帧和已选人物资产')
  }
  if (sha256(localImageBytes(tail.url, root)) !== tail.sha256) fail('前镜尾帧原图已改变')
  for (const binding of bindings) {
    if (sha256(localImageBytes(binding.url, root)) !== binding.sha256) fail('人物三视图原图已改变')
  }
}

/** A client-supplied resumeTaskId alone grants no bypass. The server must read
 * the matching task ledger row, including the original request fingerprint. */
export function validateCoverageCutPaidResume(record: unknown, request: MediaRequest) {
  const row = object(record), data = object(row.request_data)
  const params = { ...request.params }
  delete params.resumeTaskId
  delete params.resumeQueryMode
  const original = { ...request, params }
  if (!request.params.resumeTaskId || row.task_id !== request.params.resumeTaskId
    || row.workflow_id !== 'wf-sanguo-history-drama' || row.node_id !== 'sanguo-video'
    || row.model_id !== request.model.id || row.provider !== request.model.provider
    || row.capability !== request.model.capability || !['processing', 'succeeded'].includes(String(row.status))
    || !request.executionContext?.requestKey || data.requestKey !== request.executionContext.requestKey
    || data.prompt !== request.prompt
    || data.fingerprint !== modelRequestFingerprint(original)) {
    fail('恢复任务没有相同 request key、内容哈希和已购供应商账本')
  }
}

/** Call immediately before callNodeExternalUntracked; this is the only bypass
 * for a previously submitted provider task. New purchases always require the
 * signed actual-image certificate. */
export function validateCoverageCutPaidVideoRequest(request: MediaRequest, paidResumeRecord?: unknown,
root = process.cwd()) {
  const shot = object(request.params.coverageShot)
  const isCoverageCut = request.params.continuityMode === 'coverage_cut'
    || object(shot.continuity).mode === 'coverage_cut'
  if (request.model.capability !== 'video' || request.executionContext?.workflowId !== 'wf-sanguo-history-drama'
    || request.executionContext?.nodeId !== 'sanguo-video'
    || !isCoverageCut
    || isAnimatedVisualTreatment(request.params.visualTreatment)) return 'unrelated'
  if (request.params.resumeTaskId) {
    validateCoverageCutPaidResume(paidResumeRecord, request)
    return 'paid-reattach'
  }
  validateCoverageCutVideoPayment(request.params, root)
  return 'new-purchase'
}

/** Database lookup for the approval HTTP route. The ledger validator checks
 * the managed prompt, exact image attachment hashes and original model JSON. */
export async function issueRecordedCoverageCutFrameApproval(pool: Queryable,
  input: { review: unknown; evidence: { reviewImages?: unknown }; shot: unknown;
    previousTail: unknown; referenceBindings: unknown }, root = process.cwd()) {
  const expected = { evidence: input.evidence, shot: input.shot,
    previousTail: input.previousTail, referenceBindings: input.referenceBindings,
    reviewImages: input.evidence.reviewImages }
  const records = await pool.query(`select id,channel,workflow_id,node_id,capability,provider,status,
      request_data,response_data from model_execution_records
    where workflow_id='wf-sanguo-history-drama' and node_id='sanguo-coverage-review'
      and capability='text' and status='succeeded' and request_data->'params' @> $1::jsonb
    order by created_at desc limit 30`, [JSON.stringify(expected)])
  let reviewExecutionId = ''
  for (const row of records.rows) {
    try { reviewExecutionId = assertCoverageCutReviewLedgerRecord(row, input.review, expected, root); break }
    catch { /* The next candidate may be the one actually bound to these bytes. */ }
  }
  if (!reviewExecutionId) fail('没有与本次实图、受管提示及审核原始响应一致的独立视觉模型账本')
  return issueCoverageCutFrameApproval({ ...input, reviewExecutionId }, root)
}
