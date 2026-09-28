#!/usr/bin/env node
// One independent reviewer call for the new fourth-shot candidate. Reads the
// frozen shot/source context, substitutes only independently decoded evidence,
// and never changes workflow or execution rows. Default: dry-run.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { PRINCIPLE_MEDIA_REVIEW_PROMPT } from '../src/principle-media-quality.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
const sourceId = value('--source'), candidateDir = value('--candidate-dir'), out = value('--out'), run = args.includes('--run')
if (!sourceId || !candidateDir || !out || args.some(arg => arg.startsWith('--') && !['--source', '--candidate-dir', '--out', '--run'].includes(arg)))
  throw Error('Usage: node scripts/review-scene4-candidate.mjs --source REVIEW_ONLY_RECORD --candidate-dir EXISTING_DIR --out NEW_DIR [--run]')
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const candidate = JSON.parse(await readFile(`${candidateDir}/candidate-evidence.json`, 'utf8'))
const paid = JSON.parse(await readFile(`${candidateDir}/paid-result-proof.json`, 'utf8'))
const actualEvidence = JSON.parse(await readFile(`public${candidate.evidenceUrl}`, 'utf8'))
if (paid.ledgerId !== 'model-run-mukzpdnh-czi2x5i' || paid.taskId !== '933466922573271098'
  || candidate.videoUrl !== actualEvidence.url || candidate.sha256 !== actualEvidence.sha256
  || actualEvidence.frames.length !== 24 || actualEvidence.evidenceUrl !== candidate.evidenceUrl) throw Error('Candidate paid result and decoded frame evidence do not bind')
const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'
const db = new pg.Client({ connectionString })
await db.connect()
let source, state, reviewer, context, params, model
try {
  const row = (await db.query('SELECT id,workflow_id,result,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [sourceId])).rows[0]
  if (!row) throw Error('Review-only source missing')
  source = { id: row.id, workflowId: row.workflow_id, md5: row.result_md5 }
  state = decodeExecutionState(row.result)
  const matches = state.nodeRuns.map((item, index) => ({ item, index })).filter(({ item }) => item.node.id === 'sanguo-media-review' && item.loopIndex === 3)
  if (matches.length !== 1 || matches[0].item.status !== 'idle') throw Error('Expected idle fourth-shot reviewer checkpoint')
  reviewer = matches[0]
  const prepared = prepareWorkflowRunContext(state.nodeRuns, reviewer.index)
  if (!prepared?.inputContext?.shot_script || prepared.inputContext.shot_script.id !== 'scene-04') throw Error('Frozen fourth-shot context unavailable')
  context = { ...prepared.inputContext, video_evidence: actualEvidence,
    video_take: { ...prepared.inputContext.video_take, url: actualEvidence.url } }
  const param = item => {
    const key = item.englishName || item.name
    const exact = String(item.value).trim().match(/^\$\{([^}]+)\}$/)
    let result = exact ? exact[1].trim().split('.').reduce((current, part) => current?.[part], context)
      : renderWorkflowTemplate(String(item.value), context)
    if (result === undefined) throw Error(`Unresolved reviewer parameter ${key}`)
    if (!exact && item.type === 'number') result = Number(result)
    else if (!exact && item.type === 'boolean') result = result === 'true'
    else if (!exact && item.type === 'json') result = JSON.parse(result)
    return [key, result]
  }
  params = Object.fromEntries(reviewer.item.node.params.map(param))
  if (params.qualityMode !== 'principle-v1' || params.qualityDisposition !== 'manual-review-v1'
    || JSON.stringify(params.reviewImages) !== JSON.stringify(actualEvidence.frames)) throw Error('Reviewer not bound to new sampled frames')
  model = (await db.query('SELECT * FROM model_configs WHERE id=$1', [reviewer.item.node.modelId])).rows[0]
  if (model?.capability !== 'text' || model.provider === 'Local') throw Error('Expected real multimodal reviewer model')
} finally { await db.end() }
const prompt = renderWorkflowTemplate(PRINCIPLE_MEDIA_REVIEW_PROMPT,
  nodePromptInputContext({ ...context, params }, params.promptInputMode))
if (prompt.includes('${') || !prompt.includes(actualEvidence.evidenceUrl) || !prompt.includes('连续性专项：若shot明确'))
  throw Error('Refreshed reviewer prompt omits candidate evidence or continuity contract')
const requestKey = `scene4-candidate-review:${paid.taskId}:${hash({ source, prompt, frames: actualEvidence.frames }).slice(0, 16)}:${randomUUID()}`
const proof = { format: 'scene4-independent-candidate-review-v1', source, paidTaskId: paid.taskId,
  candidateVideoSha256: actualEvidence.sha256, evidenceUrl: actualEvidence.evidenceUrl, frameCount: actualEvidence.frames.length,
  framesHash: hash(actualEvidence.frames), promptHash: hash(prompt), reviewerModelId: model.id,
  reviewerRunId: reviewer.item.id, requestKey, modelReviewCallsAllowed: run ? 1 : 0,
  generatedMediaAllowed: 0, executionWritesAllowed: 0, workflowWritesAllowed: 0 }
await mkdir(out, { recursive: false, mode: 0o700 })
await writeFile(`${out}/proof.json`, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
if (!run) { console.log(JSON.stringify({ ...proof, dryRun: true }, null, 2)); process.exit(0) }
await writeFile(`${out}/request-submitted.json`, JSON.stringify({ requestKey, at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
let report, error
try {
  const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
  const response = await fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, params, operation: reviewer.item.node.operation,
      executionContext: { workflowId: source.workflowId, nodeId: reviewer.item.node.id,
        nodeName: reviewer.item.node.title, requestKey } }), signal: AbortSignal.timeout(420_000) })
  const payload = await response.json()
  if (!response.ok || payload.status >= 400) throw Error(`Reviewer HTTP ${response.status}, status ${payload.status}`)
  report = normalizeStructuredTextOutput(payload.body, extractTextResponse(payload.body), 'json')
} catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
if (!report) {
  const lookup = new pg.Client({ connectionString })
  await lookup.connect()
  try {
    const ledger = (await lookup.query("SELECT status,response_data FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at DESC LIMIT 1", [requestKey])).rows[0]
    if (ledger?.status === 'succeeded') report = normalizeStructuredTextOutput(ledger.response_data, extractTextResponse(ledger.response_data), 'json')
  } finally { await lookup.end() }
}
const complete = report?.version === 'principle-review-v1' && ['pass', 'revise', 'uncertain'].includes(report.decision)
  && Array.isArray(report.issues) && report.subtitleCheck?.evidenceUrl === actualEvidence.evidenceUrl
await writeFile(`${out}/result.json`, JSON.stringify({ proof, reportAvailable: complete, transportError: error,
  report: complete ? report : undefined, noFullWatchClaim: true, noFullListenClaim: true,
  persistedToExecution: false, modelDecisionIsNotHumanAcceptance: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const verify = new pg.Client({ connectionString })
await verify.connect()
try {
  const after = (await verify.query('SELECT md5(result::text) AS h FROM execution_records WHERE id=$1', [sourceId])).rows[0]
  if (after?.h !== source.md5) throw Error('Review-only source changed during independent review')
} finally { await verify.end() }
console.log(JSON.stringify({ out, requestKey, reportAvailable: complete,
  decision: complete ? report.decision : null, issueCodes: complete ? report.issues.map(item => item.code) : [],
  subtitleStatus: complete ? report.subtitleCheck?.status : null, transportError: error,
  sourceUnchanged: true, persistedToExecution: false }, null, 2))
if (!complete) process.exitCode = 1
