#!/usr/bin/env node
// One independent text+vision review of actual A/B native seam frames.
// Does not pay for video, sign a direct verdict, or accept a shot.
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { a8b5BReviewPrompt, readA8B5BReviewEvidence, saveA8B5BReviewEvidence,
  verifyA8B5BModelReviewLedger } from '../server/staged-scene-cut-a8b5.mjs'

const INVALID = message => { throw Error(`STAGED_A8B5_B_REVIEW_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (options.apply) INVALID('duplicate --apply')
    options.apply = true
    continue
  }
  const field = { '--plan-id': 'planId',
    '--expected-video-sha256': 'expectedVideoSha256' }[args[index]]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    INVALID(`unknown, repeated, or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '')) INVALID('signed plan ID required')
if (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedVideoSha256 ?? ''))
  INVALID('--apply requires reviewed B native video SHA-256')
const root = process.cwd()
const { evidence, sha256: nativeEvidenceSha256 } =
  await saveA8B5BReviewEvidence(options.planId, root)
if (options.expectedVideoSha256 && evidence.phaseBVideoSha256 !== options.expectedVideoSha256)
  INVALID('B native video changed since review')
const checked = await readA8B5BReviewEvidence(options.planId, root)
if (checked.sha256 !== nativeEvidenceSha256) INVALID('signed native evidence changed')
const prompt = a8b5BReviewPrompt(evidence)
const intentPath = path.join(root, '.runtime/staged-scene-cut-a8b5', options.planId,
  'phase-B-model-review-intent.json')
let intent
try { intent = JSON.parse(await readFile(intentPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'native-B-review-preflight', planId: options.planId,
    videoSha256: evidence.phaseBVideoSha256, nativeEvidenceSha256,
    frames: evidence.frames.map(frame => ({ phase: frame.phase, index: frame.index,
      url: frame.url, sha256: frame.sha256 })),
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
    || node?.operation !== 'history.media-review')
    INVALID('independent model changed')
  if (!intent) {
    intent = { version: 'staged-a8b5-B-model-review-intent-v1', planId: options.planId,
      phase: 'B', videoSha256: evidence.phaseBVideoSha256,
      nativeEvidenceSha256, modelId: model.id,
      requestKey: `staged-a8b5:${options.planId}:B:${evidence.phaseBVideoSha256}:${randomUUID()}`,
      createdAt: new Date().toISOString() }
    await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
    const request = { model, prompt, operation: 'history.media-review',
      params: { reviewImages: evidence.reviewImages,
        promptInputMode: 'normalized-results', qualityDisposition: 'manual-review-v1',
        qualityMode: 'principle-v1', maxReviewAttempts: 1, temperature: 0 },
      executionContext: { workflowId: 'wf-sanguo-history-drama',
        workflowName: '三国原著史料短剧（分步生成）', nodeId: 'staged-a8b5-phase-B-review',
        nodeName: 'A8+B5 真实首尾帧接续审核', requestKey: intent.requestKey } }
    const response = await fetch('http://127.0.0.1:5173/api/node-run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(300000) })
    const envelope = await response.json()
    if (!response.ok || envelope.status !== 200)
      INVALID(`independent review HTTP ${response.status}; intent locked for ledger recovery`)
  } else if (intent.planId !== options.planId || intent.phase !== 'B'
    || intent.videoSha256 !== evidence.phaseBVideoSha256
    || intent.nativeEvidenceSha256 !== nativeEvidenceSha256
    || intent.modelId !== model.id)
    INVALID('existing independent review intent differs')
  const rows = (await db.query(`select id,response_data,status from model_execution_records
    where request_data->>'requestKey'=$1 order by created_at`, [intent.requestKey])).rows
  const succeeded = rows.find(row => row.status === 'succeeded')
  if (!succeeded) INVALID('no successful independent model ledger; no automatic repeated review')
  const report = parseStructuredJson(extractTextResponse(succeeded.response_data))
  let accepted
  if (report?.decision === 'accept')
    accepted = await verifyA8B5BModelReviewLedger(options.planId, succeeded.id, root,
      db.query.bind(db))
  console.log(JSON.stringify({ mode: 'independent-B-review-ledger', planId: options.planId,
    executionId: succeeded.id, decision: report?.decision, issues: report?.issues,
    ledgerSha256: accepted?.ledgerSha256 ?? null, nativeEvidenceSha256,
    requestKey: intent.requestKey, accepted: Boolean(accepted),
    next: accepted ? 'direct native frame and normal-speed seam review required'
      : 'B cannot be accepted; inspect actual media and do not compose' }, null, 2))
} finally { await db.end() }
