import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { HISTORICAL_MAP_ANNOTATION_REVIEW_PROMPT, HISTORICAL_MAP_FIRST_FRAME_REVIEW_PROMPT,
  HISTORICAL_MAP_FRAME_REVIEW_PROMPT } from '../src/historical-map-frame-gate.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

/** The endpoint may sign only an actual successful independent model response.
 * The persisted request params bind that response to the exact plan or images. */
export function assertHistoricalMapReviewLedgerRecord(record: unknown, nodeId: string, review: unknown,
  expectedParams: Record<string, unknown>, root = process.cwd()): string {
  const row = object(record), request = object(row.request_data), params = object(request.params)
  if (row.channel !== 'workflow' || row.workflow_id !== 'wf-sanguo-history-drama' || row.node_id !== nodeId
    || row.capability !== 'text' || row.provider === 'Local' || row.status !== 'succeeded'
    || typeof row.id !== 'string' || !/^model-run-[\w-]+$/.test(row.id)
    || typeof request.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(request.fingerprint)) {
    throw new Error('HISTORICAL_MAP_REVIEW_UNRECORDED: 缺少独立模型成功执行记录')
  }
  for (const [key, value] of Object.entries(expectedParams)) {
    if (canonical(params[key]) !== canonical(value)) {
      throw new Error(`HISTORICAL_MAP_REVIEW_UNBOUND: 审核模型请求未绑定当前 ${key}`)
    }
  }
  if (nodeId === 'sanguo-map-first-review' || nodeId === 'sanguo-map-end-review') {
    const urls = expectedParams.reviewImages
    if (!Array.isArray(urls) || urls.length !== (nodeId === 'sanguo-map-first-review' ? 1 : 2)
      || params.reviewImageDetail !== undefined || !Array.isArray(request.reviewImageHashes)
      || request.reviewImageHashes.length !== urls.length) {
      throw new Error('HISTORICAL_MAP_REVIEW_IMAGES_UNBOUND: 模型审核附件数量或采样方式无效')
    }
    for (const [index, url] of urls.entries()) {
      if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.jpg$/.test(url)) {
        throw new Error('HISTORICAL_MAP_REVIEW_IMAGES_UNBOUND: 采证附件必须是本地 JPEG')
      }
      const stored = object(request.reviewImageHashes[index])
      let bytes: Buffer
      try { bytes = readFileSync(path.join(root, 'public', url)) }
      catch { throw new Error('HISTORICAL_MAP_REVIEW_IMAGES_UNBOUND: 模型审核附件已丢失') }
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (stored.url !== url || stored.sha256 !== actual) {
        throw new Error('HISTORICAL_MAP_REVIEW_IMAGES_UNBOUND: 当前附件字节与模型当时实际查看内容不同')
      }
    }
  }
  const expectedPrompt = nodeId === 'sanguo-map-annotation-review'
    ? renderWorkflowTemplate(HISTORICAL_MAP_ANNOTATION_REVIEW_PROMPT, {
      shot_script: { mapAnnotations: expectedParams.plan }, historical_sources: object(expectedParams.historicalSources),
      scene: expectedParams.approvedScene })
    : nodeId === 'sanguo-map-first-review'
      ? renderWorkflowTemplate(HISTORICAL_MAP_FIRST_FRAME_REVIEW_PROMPT, {
        shot_script: expectedParams.shot, map_first_evidence: expectedParams.evidence })
      : nodeId === 'sanguo-map-end-review'
        ? renderWorkflowTemplate(HISTORICAL_MAP_FRAME_REVIEW_PROMPT, {
          shot_script: expectedParams.shot, map_frame_evidence: expectedParams.evidence })
        : ''
  if (!expectedPrompt || request.prompt !== expectedPrompt) {
    throw new Error('HISTORICAL_MAP_REVIEW_PROMPT_MISMATCH: 审核模型使用的提示词不是受管理模板')
  }
  const parsed = parseStructuredJson(extractTextResponse(row.response_data))
  if (!parsed || Array.isArray(parsed)) throw new Error('HISTORICAL_MAP_REVIEW_UNRECORDED: 模型原始响应没有有效审核 JSON')
  const submitted = object(review)
  const reported = Object.fromEntries(Object.entries(submitted).filter(([key]) => key !== 'text' && key !== 'raw'))
  if (canonical(parsed) !== canonical(reported)) {
    throw new Error('HISTORICAL_MAP_REVIEW_MISMATCH: 提交的审核结论与模型原始响应不同')
  }
  return row.id
}
