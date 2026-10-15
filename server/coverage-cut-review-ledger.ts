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

function jsonSpan(text: string, start: number) {
  const open = text[start], close = open === '[' ? ']' : open === '{' ? '}' : ''
  if (!close) return undefined
  let depth = 0, quoted = false, escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === open) depth++
    else if (char === close && --depth === 0) return index + 1
  }
  return undefined
}

/** JSONB may reorder keys on a persisted retry; parse only the two templated JSON slots. */
function semanticallyBoundExactPrompt(prompt: string, evidence: unknown, shot: unknown) {
  const [prefix, remainder] = COVERAGE_CUT_FRAME_REVIEW_PROMPT.split('${coverage_evidence.evidenceUrl}')
  const [betweenEvidence, afterEvidence] = remainder.split('${coverage_evidence.items}')
  const [betweenItems, suffix] = afterEvidence.split('${shot_script}')
  const start = prefix + String(object(evidence).evidenceUrl) + betweenEvidence
  if (!prompt.startsWith(start)) return false
  const itemsEnd = jsonSpan(prompt, start.length)
  if (itemsEnd === undefined || !prompt.startsWith(betweenItems, itemsEnd)) return false
  const shotStart = itemsEnd + betweenItems.length
  const shotEnd = jsonSpan(prompt, shotStart)
  if (shotEnd === undefined || prompt.slice(shotEnd) !== suffix) return false
  try {
    return canonical(JSON.parse(prompt.slice(start.length, itemsEnd))) === canonical(object(evidence).items)
      && canonical(JSON.parse(prompt.slice(shotStart, shotEnd))) === canonical(shot)
  } catch { return false }
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
  const archivedPrompt = expectedPrompt.length > 100000
    ? `${expectedPrompt.slice(0, 100000)}[日志截断，共${expectedPrompt.length}字符]` : expectedPrompt
  const recordedPrompt = String(request.prompt ?? '')
  const semanticallyBoundTruncation = expectedPrompt.length > 100000
    && recordedPrompt.startsWith(COVERAGE_CUT_FRAME_REVIEW_PROMPT.split('${coverage_evidence.evidenceUrl}')[0]
      + String(object(expectedParams.evidence).evidenceUrl) + '；采证：')
    && recordedPrompt.includes('。本镜已批准分镜：')
    && recordedPrompt.endsWith(`[日志截断，共${expectedPrompt.length}字符]`)
    && /^[a-f0-9]{64}$/.test(String(object(object(row.response_data).raw).promptSha256 ?? ''))
  // JSONB reorders keys on retrieval, while the model's >100k prompt is
  // archived only as a prefix. The bound params and recorded prefix establish
  // the same content for that legacy case without claiming byte reconstruction.
  if (request.prompt === archivedPrompt && expectedPrompt.length > 100000
    && object(object(row.response_data).raw).promptSha256 !== createHash('sha256').update(expectedPrompt).digest('hex')
    || request.prompt !== archivedPrompt && !semanticallyBoundTruncation
      && !semanticallyBoundExactPrompt(recordedPrompt, expectedParams.evidence, expectedParams.shot)) {
    throw new Error('COVERAGE_REVIEW_PROMPT_MISMATCH: 使用了非受管审核提示词')
  }
  const parsed = parseStructuredJson(extractTextResponse(row.response_data))
  if (!parsed || Array.isArray(parsed)) throw new Error('COVERAGE_REVIEW_UNRECORDED: 原始响应无有效审核 JSON')
  const reviewed = object(review)
  if (typeof row.model_id !== 'string' || reviewed.model !== row.model_id) {
    throw new Error('COVERAGE_REVIEW_MISMATCH: 送签结论的审核模型与成功执行记录不同')
  }
  const submitted = Object.fromEntries(Object.entries(reviewed)
    .filter(([key]) => !['text', 'raw', 'model'].includes(key)))
  if (canonical(parsed) !== canonical(submitted)) throw new Error('COVERAGE_REVIEW_MISMATCH: 送签结论与模型原始响应不同')
  return row.id
}
