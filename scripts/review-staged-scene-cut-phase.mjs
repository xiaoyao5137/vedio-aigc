#!/usr/bin/env node
// One independent text+vision review of signed native provider frames.
// No video/image provider call and no execution-record writes occur here.
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { saveStageReviewEvidence, readStageReviewEvidence, stageReviewPrompt,
  verifyStageModelReviewLedger, readStagedSceneCutManifest } from '../server/staged-scene-cut.mjs'

const fail = message => { throw Error(`STAGED_PHASE_REVIEW_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') { options.apply = true; continue }
  const key = { '--plan-id': 'planId', '--phase': 'phase',
    '--expected-video-sha256': 'expectedVideoSha256' }[args[index]]
  if (!key || !args[index + 1] || options[key]) fail(`invalid or repeated ${args[index]}`)
  options[key] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '') || !['A', 'B'].includes(options.phase))
  fail('signed plan ID and phase A/B required')
if (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedVideoSha256 ?? ''))
  fail('--apply requires reviewed native video SHA-256')
const root = process.cwd()
const { evidence, sha256: nativeEvidenceSha256 } = await saveStageReviewEvidence(options.planId, options.phase, root)
if (options.expectedVideoSha256 && evidence.videoSha256 !== options.expectedVideoSha256)
  fail('archived native video changed since review approval')
const checked = await readStageReviewEvidence(options.planId, options.phase, root)
if (checked.sha256 !== nativeEvidenceSha256) fail('review evidence changed after saving')
const manifest = await readStagedSceneCutManifest(options.planId, root)
const prompt = stageReviewPrompt(options.phase, evidence, manifest.promptVersion ?? 'v1')
const intentPath = path.join(root, '.runtime/staged-scene-cut', options.planId,
  `phase-${options.phase}-model-review-intent.json`)
let intent
try { intent = JSON.parse(await readFile(intentPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'local-native-review-preflight', planId: options.planId,
    phase: options.phase, videoSha256: evidence.videoSha256, nativeEvidenceSha256,
    frames: evidence.frames.map(frame => ({ phase: frame.phase, frameIndex: frame.frameIndex,
      url: frame.url, sha256: frame.sha256 })), modelReviewIntent: intent?.requestKey ?? null,
    modelCalls: 0, videoProviderCalls: 0, databaseWrites: 0 }, null, 2))
  process.exit(0)
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const workflow = (await db.query('select nodes from workflow_configs where id=$1',
    ['wf-sanguo-history-drama'])).rows[0]
  const node = workflow?.nodes?.find(value => value.id === 'sanguo-media-review')
  const model = node && (await db.query('select id,name,provider,capability,settings from model_configs where id=$1',
    [node.modelId])).rows[0]
  if (model?.provider !== 'Codex' || model?.capability !== 'text'
    || node?.operation !== 'history.media-review') fail('independent visual review model changed')
  if (!intent) {
    intent = { version: 'staged-model-review-intent-v1', planId: options.planId,
      phase: options.phase, videoSha256: evidence.videoSha256, nativeEvidenceSha256,
      modelId: model.id, requestKey: `staged-scene-cut:${options.planId}:${options.phase}:${evidence.videoSha256}:${randomUUID()}`,
      createdAt: new Date().toISOString() }
    await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    const request = { model, prompt, operation: 'history.media-review',
      params: { reviewImages: evidence.reviewImages, promptInputMode: 'normalized-results',
        qualityDisposition: 'manual-review-v1', qualityMode: 'principle-v1',
        maxReviewAttempts: 1, temperature: 0 },
      executionContext: { workflowId: 'wf-sanguo-history-drama',
        workflowName: '三国原著史料短剧（分步生成）', nodeId: 'staged-scene-cut-phase-review',
        nodeName: `分段原生帧独立审核 ${options.phase}`, requestKey: intent.requestKey } }
    const response = await fetch('http://127.0.0.1:5173/api/node-run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(300000) })
    const envelope = await response.json()
    if (!response.ok || envelope.status !== 200)
      fail(`independent review HTTP ${response.status}; intent remains locked, inspect ledger before retry`)
  } else if (intent.planId !== options.planId || intent.phase !== options.phase
    || intent.videoSha256 !== evidence.videoSha256 || intent.nativeEvidenceSha256 !== nativeEvidenceSha256
    || intent.modelId !== model.id)
    fail('existing model-review intent does not match native evidence')
  const rows = (await db.query(`select id,response_data,status from model_execution_records
    where request_data->>'requestKey'=$1 order by created_at`, [intent.requestKey])).rows
  const succeeded = rows.find(row => row.status === 'succeeded')
  if (!succeeded) fail('no successful independent model ledger; do not repeat review call automatically')
  const report = parseStructuredJson(extractTextResponse(succeeded.response_data))
  let accepted = null
  if (report?.decision === 'accept')
    accepted = await verifyStageModelReviewLedger(options.planId, options.phase, succeeded.id, root,
      db.query.bind(db))
  console.log(JSON.stringify({ mode: 'independent-model-ledger', phase: options.phase,
    executionId: succeeded.id, decision: report?.decision, issues: report?.issues,
    ledgerSha256: accepted?.ledgerSha256 ?? null, nativeEvidenceSha256,
    requestKey: intent.requestKey, accepted: Boolean(accepted),
    next: accepted ? 'direct visual review is still required' : 'reject or acquire more evidence; do not advance phase' }, null, 2))
} finally { await db.end() }
