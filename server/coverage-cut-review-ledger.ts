import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { COVERAGE_CUT_FRAME_REVIEW_PROMPT } from '../src/coverage-cut-frame-gate.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

/** An approval endpoint must prove a separate vision model actually saw these
 * image bytes with the managed prompt, and returned this exact report. */
export function assertCoverageCutReviewLedgerRecord(record: unknown, review: unknown,
  expectedParams: { evidence: unknown; shot: unknown; previousTail: unknown;
    referenceBindings: unknown; reviewImages: unknown }, root = process.cwd()): string {
  const row = object(record), request = object(row.request_data), params = object(request.params)
  if (row.channel !== 'workflow' || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'sanguo-coverage-review' || row.capability !== 'text'
    || row.provider === 'Local' || row.status !== 'succeeded'
    || typeof row.id !== 'string' || !/^model-run-[\w-]+$/.test(row.id)
    || typeof request.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(request.fingerprint)) {
    throw new Error('COVERAGE_REVIEW_UNRECORDED: 缺少独立视觉模型成功执行记录')
  }
  for (const [key, expected] of Object.entries(expectedParams)) {
    if (canonical(params[key]) !== canonical(expected)) {
      throw new Error(`COVERAGE_REVIEW_UNBOUND: 审核请求未绑定当前 ${key}`)
    }
  }
  const images = expectedParams.reviewImages
  if (!Array.isArray(images) || images.length < 3 || images.length > 4
    || !Array.isArray(request.reviewImageHashes) || request.reviewImageHashes.length !== images.length
    || params.reviewImageDetail !== undefined) {
    throw new Error('COVERAGE_REVIEW_IMAGES_UNBOUND: 模型实际审核图片不完整')
  }
  for (const [index, image] of images.entries()) {
    if (typeof image !== 'string' || !/^\/generated\/[\w.-]+\.jpg$/.test(image)) {
      throw new Error('COVERAGE_REVIEW_IMAGES_UNBOUND: 审核附件不是本地 JPEG')
    }
    const stored = object(request.reviewImageHashes[index])
    let bytes: Buffer
    try { bytes = readFileSync(path.join(root, 'public', image)) }
    catch { throw new Error('COVERAGE_REVIEW_IMAGES_UNBOUND: 审核附件丢失') }
    if (stored.url !== image || stored.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      throw new Error('COVERAGE_REVIEW_IMAGES_UNBOUND: 当前附件字节与模型查看时不同')
    }
  }
  const expectedPrompt = renderWorkflowTemplate(COVERAGE_CUT_FRAME_REVIEW_PROMPT, {
    coverage_evidence: expectedParams.evidence, shot_script: expectedParams.shot })
  if (request.prompt !== expectedPrompt) throw new Error('COVERAGE_REVIEW_PROMPT_MISMATCH: 使用了非受管审核提示词')
  const parsed = parseStructuredJson(extractTextResponse(row.response_data))
  if (!parsed || Array.isArray(parsed)) throw new Error('COVERAGE_REVIEW_UNRECORDED: 原始响应无有效审核 JSON')
  const submitted = Object.fromEntries(Object.entries(object(review)).filter(([key]) => key !== 'text' && key !== 'raw'))
  if (canonical(parsed) !== canonical(submitted)) throw new Error('COVERAGE_REVIEW_MISMATCH: 送签结论与模型原始响应不同')
  return row.id
}
