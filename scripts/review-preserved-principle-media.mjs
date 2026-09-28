// Independently recheck ONE saved principle-mode clip without changing its
// execution record, workflow, paid video, or downstream run state.
// Dry-run by default; --run makes exactly one /api/node-run request.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { nodePromptInputContext } from '../src/review-input.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { acceptPrincipleMedia, PRINCIPLE_MEDIA_REVIEW_PROMPT } from '../src/principle-media-quality.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const fail = message => { throw new Error(`PRESERVED_MEDIA_REVIEW_INVALID: ${message}`) }
const option = (args, name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node scripts/review-preserved-principle-media.mjs --record RECORD --loop 4 --out NEW_DIR [--run]\nDry-run writes a source/input proof only. --run sends one independent reviewer request, writes report and local gate verdict, and never changes execution records.')
  process.exit(0)
}
const recordId = option(args, '--record'), loop = Number(option(args, '--loop')), out = option(args, '--out')
const run = args.includes('--run')
if (!recordId || !Number.isSafeInteger(loop) || loop < 1 || !out) fail('--record, positive --loop and --out are required')
if (args.some((arg, index) => arg.startsWith('--') && !['--record', '--loop', '--out', '--run'].includes(arg))) fail('unknown option')
if (['--record', '--loop', '--out'].some(flag => args.filter(arg => arg === flag).length !== 1) || args.filter(arg => arg === '--run').length > 1) fail('duplicate or missing option')

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'
const client = new pg.Client({ connectionString })
await client.connect()
let source, state, reviewer, context, params, gateParams, model
try {
  const row = (await client.query('select id, workflow_id, result, md5(result::text) as result_md5 from execution_records where id=$1', [recordId])).rows[0]
  if (!row) fail('record not found')
  source = { id: row.id, workflowId: row.workflow_id, md5: row.result_md5 }
  state = decodeExecutionState(row.result)
  if (state.id !== recordId || state.workflowId !== row.workflow_id) fail('record/state identity mismatch')
  const matches = state.nodeRuns.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.node.id === 'sanguo-media-review' && item.loopIndex === loop - 1)
  if (matches.length !== 1) fail('expected one media-review node in requested loop')
  reviewer = matches[0]
  if (reviewer.item.status !== 'idle') fail('review node must be idle; use an explicit review-only checkpoint')
  const prefix = state.nodeRuns.slice(0, reviewer.index)
  const clip = prefix.findLast(item => item.node.id === 'sanguo-video' && item.loopIndex === loop - 1)
  const evidence = prefix.findLast(item => item.node.id === 'sanguo-video-evidence' && item.loopIndex === loop - 1)
  if (clip?.status !== 'success' || evidence?.status !== 'success') fail('paid video and actual decoded evidence must be complete')
  const prepared = prepareWorkflowRunContext(state.nodeRuns, reviewer.index)
  if (!prepared) fail('cannot rebuild reviewer context')
  context = prepared.inputContext
  if (!context.shot_script || !context.video_take || !context.video_evidence) fail('review context omits shot/video/evidence')
  if (context.video_take.url !== clip.output.url || context.video_evidence.url !== evidence.output.url) fail('rebuilt context does not bind preserved clip/evidence')
  if (!Array.isArray(context.video_evidence.frames) || context.video_evidence.frames.length < 2) fail('actual sampled frames missing')
  const param = item => {
    const key = item.englishName || item.name
    const exact = String(item.value).trim().match(/^\$\{([^}]+)\}$/)
    let value = exact ? exact[1].trim().split('.').reduce((current, part) => current?.[part], context)
      : renderWorkflowTemplate(String(item.value), context)
    if (value === undefined) fail(`unresolved parameter ${key}`)
    if (!exact && item.type === 'number') value = Number(value)
    else if (!exact && item.type === 'boolean') value = value === 'true'
    else if (!exact && item.type === 'json') value = JSON.parse(value)
    return [key, value]
  }
  params = Object.fromEntries(reviewer.item.node.params.map(param))
  if (params.qualityMode !== 'principle-v1' || params.qualityDisposition !== 'manual-review-v1') fail('this harness is for manual principle mode only')
  if (JSON.stringify(params.reviewImages) !== JSON.stringify(context.video_evidence.frames)) fail('review image list differs from preserved evidence')
  const gate = state.nodeRuns.find(item => item.node.id === 'sanguo-media-accept' && item.loopIndex === loop - 1)
  if (!gate || gate.status !== 'idle') fail('media gate must remain idle after reviewer')
  gateParams = Object.fromEntries(gate.node.params.map(param))
  model = (await client.query('select * from model_configs where id=$1', [reviewer.item.node.modelId])).rows[0]
  if (model?.capability !== 'text' || model.provider === 'Local') fail('configured real vision-capable reviewer unavailable')
} finally { await client.end() }

const prompt = renderWorkflowTemplate(PRINCIPLE_MEDIA_REVIEW_PROMPT,
  nodePromptInputContext({ ...context, params }, params.promptInputMode))
if (prompt.includes('${') || !prompt.includes(String(context.video_evidence.evidenceUrl))) fail('review prompt is unresolved or omits actual evidence')
const requestKey = `preserved-media-review:${recordId}:${reviewer.item.id}:${digest({ source, params, prompt }).slice(0, 16)}:${randomUUID()}`
const proof = { format: 'preserved-principle-media-review-v1', createdAt: new Date().toISOString(), source,
  loop, reviewerIndex: reviewer.index, reviewerRunId: reviewer.item.id, modelId: model.id, modelProvider: model.provider,
  shotId: context.shot_script.id, videoUrlHash: digest(context.video_take.url), evidenceUrl: context.video_evidence.evidenceUrl,
  evidenceSha256: context.video_evidence.sha256, frameCount: context.video_evidence.frames.length,
  framesHash: digest(context.video_evidence.frames), promptHash: digest(prompt), refreshedContinuityPrompt: prompt.includes('连续性专项：若shot明确'),
  sourcePrefixHash: createJsonHasher()(state.nodeRuns.slice(0, reviewer.index)), requestKey, modelRequestsAllowed: run ? 1 : 0,
  executionWritesAllowed: 0, generatedMediaAllowed: 0 }
await mkdir(out, { recursive: false })
await writeFile(`${out}/proof.json`, JSON.stringify(proof, null, 2) + '\n')
if (!run) { console.log(JSON.stringify({ ...proof, dryRun: true }, null, 2)); process.exit(0) }

// Mark submission before sending. A crash or timeout leaves this evidence in
// place and cannot silently replay the same paid reviewer operation.
await writeFile(`${out}/request-submitted.json`, JSON.stringify({ requestKey, at: new Date().toISOString(), modelId: model.id,
  promptHash: proof.promptHash, framesHash: proof.framesHash }, null, 2) + '\n')
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
let report, error
try {
  const response = await fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, params, operation: reviewer.item.node.operation,
      executionContext: { workflowId: source.workflowId, nodeId: reviewer.item.node.id, nodeName: reviewer.item.node.title, requestKey } }),
    signal: AbortSignal.timeout(420_000) })
  const payload = await response.json()
  if (!response.ok || payload.status >= 400) throw new Error(`HTTP ${response.status}: ${String(payload.body?.message ?? payload.body?.error ?? 'review request failed')}`)
  report = normalizeStructuredTextOutput(payload.body, extractTextResponse(payload.body), 'json')
  if (report?.version !== 'principle-review-v1' || !['pass', 'revise', 'uncertain'].includes(report.decision) || !Array.isArray(report.issues)) {
    throw new Error('review returned no complete principle-review-v1 report')
  }
  await writeFile(`${out}/review.json`, JSON.stringify(report, null, 2) + '\n')
} catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
const verdict = acceptPrincipleMedia({ ...context, media_review: report ?? { reviewUnavailable: true, warnings: [error] } }, gateParams)
await writeFile(`${out}/gate-verdict.json`, JSON.stringify({ reportAvailable: Boolean(report), reviewError: error,
  passed: verdict.passed, manualDecisionRequired: verdict.manualDecisionRequired,
  status: verdict.qualityReview.status, subtitleAssessment: verdict.subtitleAssessment, visualReview: verdict.visualReview,
  principleIssues: verdict.qualityReview.principleIssues, warnings: verdict.qualityReview.warnings,
  fullVideoWatched: false, fullAudioListened: false, persistedToExecution: false }, null, 2) + '\n')
const verify = new pg.Client({ connectionString })
await verify.connect()
try {
  const after = (await verify.query('select md5(result::text) as result_md5 from execution_records where id=$1', [recordId])).rows[0]
  if (after?.result_md5 !== source.md5) fail('source execution changed concurrently; report remains independent and cannot be adopted without a new binding check')
} finally { await verify.end() }
console.log(JSON.stringify({ out, requestKey, reportAvailable: Boolean(report), reviewError: error,
  decision: report?.decision, issueCodes: report?.issues?.map(item => item.code), passed: verdict.passed,
  manualDecisionRequired: verdict.manualDecisionRequired, subtitleStatus: verdict.subtitleAssessment?.status,
  sourceUnchanged: true, persistedToExecution: false }, null, 2))
if (error) process.exitCode = 1
