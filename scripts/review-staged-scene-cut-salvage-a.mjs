#!/usr/bin/env node
// Independently review the derived A frames. --apply calls the existing Codex
// media-review model once; an intent prevents duplicate calls on retries.
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { saveSalvageAReviewEvidence, readSalvageAReviewEvidence,
  salvageAReviewPrompt, verifySalvageAModelLedger } from '../server/staged-scene-cut-salvage.mjs'

const fail = message => { throw Error(`STAGED_SALVAGE_REVIEW_INVALID: ${message}`) }
const options = { apply: false }, args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') { options.apply = true; continue }
  const key = { '--plan-id': 'planId', '--expected-video-sha256': 'expectedVideoSha256' }[args[index]]
  if (!key || !args[index + 1] || options[key]) fail(`invalid or repeated ${args[index]}`)
  options[key] = args[++index]
}
const SHA = /^[a-f0-9]{64}$/
if (!SHA.test(options.planId ?? '') || options.apply && !SHA.test(options.expectedVideoSha256 ?? ''))
  fail('signed salvage plan ID and, for --apply, exact derived video SHA-256 required')
const root = process.cwd()
const { evidence, sha256: nativeEvidenceSha256 } = await saveSalvageAReviewEvidence(options.planId, root)
if (options.expectedVideoSha256 && evidence.videoSha256 !== options.expectedVideoSha256)
  fail('derived video changed since approval')
const checked = await readSalvageAReviewEvidence(options.planId, root)
if (checked.sha256 !== nativeEvidenceSha256) fail('signed review evidence changed')
const prompt = salvageAReviewPrompt(evidence)
const intentPath = path.join(root, '.runtime/staged-scene-cut', options.planId,
  'phase-A-model-review-intent.json')
let intent
try { intent = JSON.parse(await readFile(intentPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'local-derived-review-preflight', planId: options.planId,
    videoSha256: evidence.videoSha256, nativeEvidenceSha256,
    frames: evidence.frames.map(frame => ({ kind: frame.kind, frameIndex: frame.frameIndex,
      sourceFrameIndex: frame.sourceFrameIndex, url: frame.url, sha256: frame.sha256 })),
    modelReviewIntent: intent?.requestKey ?? null,
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
    intent = { version: 'staged-salvage-model-review-intent-v1', planId: options.planId,
      phase: 'A', videoSha256: evidence.videoSha256, nativeEvidenceSha256,
      modelId: model.id,
      requestKey: `staged-salvage:${options.planId}:A:${evidence.videoSha256}:${randomUUID()}`,
      createdAt: new Date().toISOString() }
    await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    const request = { model, prompt, operation: 'history.media-review',
      params: { reviewImages: evidence.reviewImages, promptInputMode: 'normalized-results',
        qualityDisposition: 'manual-review-v1', qualityMode: 'principle-v1',
        maxReviewAttempts: 1, temperature: 0 },
      executionContext: { workflowId: 'wf-sanguo-history-drama',
        workflowName: '三国原著史料短剧（分步生成）', nodeId: 'staged-salvage-a-review',
        nodeName: '衍生 A 段逐帧独立审核', requestKey: intent.requestKey } }
    const response = await fetch('http://127.0.0.1:5173/api/node-run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(300000) })
    const envelope = await response.json()
    if (!response.ok || envelope.status !== 200)
      fail(`independent review HTTP ${response.status}; intent remains locked, inspect ledger before retry`)
  } else if (intent.planId !== options.planId || intent.phase !== 'A'
    || intent.videoSha256 !== evidence.videoSha256 || intent.nativeEvidenceSha256 !== nativeEvidenceSha256
    || intent.modelId !== model.id)
    fail('existing model-review intent does not match derived evidence')
  const rows = (await db.query(`select id,response_data,status from model_execution_records
    where request_data->>'requestKey'=$1 order by created_at`, [intent.requestKey])).rows
  const succeeded = rows.find(row => row.status === 'succeeded')
  if (!succeeded) fail('no successful independent model ledger; do not repeat review call automatically')
  const report = parseStructuredJson(extractTextResponse(succeeded.response_data))
  let accepted = null
  if (report?.decision === 'accept')
    accepted = await verifySalvageAModelLedger(options.planId, succeeded.id, root, db.query.bind(db))
  console.log(JSON.stringify({ mode: 'independent-salvage-model-ledger', phase: 'A',
    executionId: succeeded.id, decision: report?.decision, issues: report?.issues,
    ledgerSha256: accepted?.ledgerSha256 ?? null, nativeEvidenceSha256,
    requestKey: intent.requestKey, accepted: Boolean(accepted),
    next: accepted ? 'direct visual review is still required' : 'reject or acquire more evidence; do not advance to B' }, null, 2))
} finally { await db.end() }
