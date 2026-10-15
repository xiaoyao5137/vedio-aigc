#!/usr/bin/env node
/** Native-frame samples first; one independent text+vision call only on --apply. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { freshA8B6Directory, readFreshA8B6PhaseAPlan } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6MediaReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-phases.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'
import { saveFreshA8B6ReviewEvidence, readFreshA8B6ReviewEvidence,
  saveFreshA8B6ReviewEvidenceV2, assertFreshA8B6JpegReviewRecovery,
  saveFreshA8B6ReviewRecoveryArtifact,
  readFreshA8B6ReviewRecoveryArtifact,
  freshA8B6ReviewPrompt, verifyFreshA8B6ModelReviewLedger } from
  '../server/staged-scene-cut-a8b6-fresh-review.mjs'

const fail = message => { throw Error(`A8B6_FRESH_REVIEW_RUNNER_INVALID: ${message}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const args = process.argv.slice(2), opts = { apply: false,
  recoverJpegV2: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  if (args[i] === '--recover-jpeg-v2') {
    if (opts.recoverJpegV2) fail('duplicate --recover-jpeg-v2')
    opts.recoverJpegV2 = true
    continue
  }
  const key = { '--plan-id': 'planId', '--phase': 'phase',
    '--expected-video-sha256': 'videoSha256',
    '--expected-evidence-sha256': 'evidenceSha256',
    '--expected-intent-sha256': 'intentSha256',
    '--expected-failed-ledger-sha256': 'failedLedgerSha256' }[args[i]]
  if (!key || opts[key] || !args[i + 1] || args[i + 1].startsWith('--'))
    fail(`invalid or repeated ${args[i]}`)
  opts[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.planId ?? '')
  || !['A', 'B'].includes(opts.phase))
  fail('signed fresh plan and A/B phase required')
if (opts.apply && [opts.videoSha256, opts.evidenceSha256]
  .some(value => !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--apply requires reviewed video and native evidence hashes')
if (opts.recoverJpegV2 && opts.phase !== 'A')
  fail('JPEG v2 recovery is only available for A')
if (opts.recoverJpegV2 && opts.apply
  && [opts.intentSha256, opts.failedLedgerSha256].some(value =>
    !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('JPEG v2 --apply requires intent and failed ledger hashes')
const root = process.cwd()
await withV9VerifiedSource(root, async () => {
const APlan = await readFreshA8B6PhaseAPlan(opts.planId, root)
if (APlan.manifest.version === 'staged-a8b6-fresh-A-plan-v2')
  fail('retake A/B requires the v3 sampled-frame model review runner')
const media = await readFreshA8B6MediaReceipt(
  opts.planId, opts.phase, root)
if (opts.videoSha256 && media.media.videoSha256 !== opts.videoSha256)
  fail('archived provider video changed since review')
const evidencePath = path.join(freshA8B6Directory(opts.planId, root),
  `phase-${opts.phase}-review-evidence.json`)
try { await readFile(evidencePath) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  await saveFreshA8B6ReviewEvidence(opts.planId, opts.phase, root)
}
const { evidence, evidenceSha256 } = await readFreshA8B6ReviewEvidence(
  opts.planId, opts.phase, root)
if (!opts.recoverJpegV2 && opts.evidenceSha256
  && opts.evidenceSha256 !== evidenceSha256)
  fail('original native review samples changed')
const intentPath = path.join(freshA8B6Directory(opts.planId, root),
  `phase-${opts.phase}-model-review-intent.json`)
let intent
let intentBytes
try {
  intentBytes = await readFile(intentPath)
  intent = JSON.parse(intentBytes.toString('utf8'))
}
catch (error) { if (error.code !== 'ENOENT') throw error }
if (opts.recoverJpegV2) {
  if (!intent || !intentBytes)
    fail('JPEG v2 recovery requires preserved v1 intent')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const workflow = (await db.query(`SELECT nodes FROM workflow_configs
      WHERE id='wf-sanguo-history-drama'`)).rows[0]
    const node = workflow?.nodes?.find(item => item.id === 'sanguo-media-review')
    const model = node && (await db.query(`SELECT id,name,provider,capability,settings
      FROM model_configs WHERE id=$1`, [node.modelId])).rows[0]
    if (node?.operation !== 'history.media-review'
      || model?.provider !== 'Codex' || model.capability !== 'text')
      fail('independent review model changed')
    const prefix = `staged-a8b6-fresh:${opts.planId}:A:${evidence.videoSha256}:`
    const rows = (await db.query(`SELECT id,channel,workflow_id,node_id,
      model_id,capability,provider,status,error,request_data,response_data
      FROM model_execution_records
      WHERE request_data->>'requestKey' LIKE $1 ORDER BY created_at`,
    [`${prefix}%`])).rows
    const prior = assertFreshA8B6JpegReviewRecovery({ intent,
      intentSha256: sha(intentBytes), evidence, evidenceSha256,
      rows: rows.filter(row => !String(row.request_data?.requestKey ?? '')
        .includes(':jpeg-v2:')), modelId: model.id })
    if (rows.some(row => row.status === 'processing'
      || row.status === 'succeeded'
        && !String(row.request_data?.requestKey ?? '')
          .includes(':jpeg-v2:')))
      fail('successful or active review already exists for this video')
    await saveFreshA8B6ReviewEvidenceV2(opts.planId, root)
    const recovered = await readFreshA8B6ReviewEvidence(opts.planId,
      'A', root, 'v2')
    if (opts.evidenceSha256
      && opts.evidenceSha256 !== recovered.evidenceSha256)
      fail('JPEG v2 evidence changed since preview')
    const intentName = 'phase-A-model-review-intent-v2.json'
    let recoveredIntent, recoveredIntentSha256
    try {
      const signed = await readFreshA8B6ReviewRecoveryArtifact(
        opts.planId, intentName, root)
      recoveredIntent = signed.value
      recoveredIntentSha256 = signed.sha256
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const signed = await saveFreshA8B6ReviewRecoveryArtifact(
        opts.planId, intentName, {
          version: 'staged-a8b6-fresh-model-review-intent-v2',
          planId: opts.planId, phase: 'A',
          videoSha256: evidence.videoSha256,
          evidenceSha256: recovered.evidenceSha256,
          modelId: model.id,
          requestKey: `${prefix}jpeg-v2:${randomUUID()}`,
          priorFailure: prior, createdAt: new Date().toISOString(),
        }, root)
      recoveredIntent = signed.value
      recoveredIntentSha256 = signed.sha256
    }
    if (recoveredIntent.version !== 'staged-a8b6-fresh-model-review-intent-v2'
      || recoveredIntent.planId !== opts.planId
      || recoveredIntent.phase !== 'A'
      || recoveredIntent.videoSha256 !== evidence.videoSha256
      || recoveredIntent.evidenceSha256 !== recovered.evidenceSha256
      || recoveredIntent.modelId !== model.id
      || !String(recoveredIntent.requestKey).startsWith(`${prefix}jpeg-v2:`)
      || canonical(recoveredIntent.priorFailure) !== canonical(prior))
      fail('signed JPEG v2 intent differs from exact failed preflight')
    if (rows.some(row => String(row.request_data?.requestKey ?? '')
      .includes(':jpeg-v2:')
      && row.request_data.requestKey !== recoveredIntent.requestKey))
      fail('another JPEG v2 attempt exists for this video')
    if (!opts.apply) {
      console.log(JSON.stringify({ mode: 'jpeg-v2-recovery-preview',
        planId: opts.planId, phase: 'A',
        videoSha256: evidence.videoSha256,
        priorV1EvidenceSha256: evidenceSha256,
        priorV1IntentSha256: prior.priorV1IntentSha256,
        failedModelExecutionId: prior.failedModelExecutionId,
        failedModelLedgerSha256: prior.failedModelLedgerSha256,
        evidenceSha256: recovered.evidenceSha256,
        intentSha256: recoveredIntentSha256,
        requestKey: recoveredIntent.requestKey,
        frames: recovered.evidence.frames,
        modelCalls: 0, videoProviderCalls: 0, databaseWrites: 0 }, null, 2))
      return
    }
    if (opts.intentSha256 !== recoveredIntentSha256
      || opts.failedLedgerSha256 !== prior.failedModelLedgerSha256)
      fail('JPEG v2 intent or failed ledger changed since preview')
    const existing = rows.filter(row =>
      row.request_data?.requestKey === recoveredIntent.requestKey)
    if (existing.some(row => row.status !== 'succeeded')
      || existing.length > 1)
      fail('JPEG v2 attempt already has a non-successful or duplicate ledger')
    if (existing.length === 0) {
      const markerName = 'phase-A-model-review-submit-v2.json'
      try {
        await readFreshA8B6ReviewRecoveryArtifact(opts.planId,
          markerName, root)
        fail('JPEG v2 submission already attempted; inspect ledger')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      await saveFreshA8B6ReviewRecoveryArtifact(opts.planId,
        markerName, { version: 'staged-a8b6-fresh-model-review-submit-v2',
          planId: opts.planId, requestKey: recoveredIntent.requestKey,
          intentSha256: recoveredIntentSha256,
          createdAt: new Date().toISOString() }, root)
      const request = { model,
        prompt: freshA8B6ReviewPrompt('A', recovered.evidence),
        operation: 'history.media-review',
        params: { reviewImages: recovered.evidence.reviewImages,
          promptInputMode: 'normalized-results',
          qualityDisposition: 'manual-review-v1',
          qualityMode: 'principle-v1', maxReviewAttempts: 1,
          temperature: 0 },
        executionContext: { workflowId: 'wf-sanguo-history-drama',
          workflowName: '三国原著史料短剧（分步生成）',
          nodeId: 'staged-a8b6-fresh-phase-review',
          nodeName: '新生 A8B6 原生帧独立审核 A JPEG v2',
          requestKey: recoveredIntent.requestKey } }
      const base = process.env.APP_BASE_URL ?? 'http://127.0.0.1:5173'
      const response = await fetch(`${base}/api/node-run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(300000) })
      const envelope = await response.json()
      if (!response.ok || envelope.status !== 200)
        fail(`JPEG v2 model review HTTP ${response.status}; submission locked`)
    }
    const finalRows = (await db.query(`SELECT id,status,response_data
      FROM model_execution_records WHERE request_data->>'requestKey'=$1
      ORDER BY created_at`, [recoveredIntent.requestKey])).rows
    const succeeded = finalRows.find(row => row.status === 'succeeded')
    if (!succeeded)
      fail('JPEG v2 model ledger not successful; no automatic repeat call')
    const report = parseStructuredJson(extractTextResponse(
      succeeded.response_data))
    console.log(JSON.stringify({ mode: 'jpeg-v2-independent-model-ledger',
      planId: opts.planId, phase: 'A', executionId: succeeded.id,
      decision: report?.decision, issues: report?.issues,
      evidenceSha256: recovered.evidenceSha256,
      intentSha256: recoveredIntentSha256,
      priorFailedModelExecutionId: prior.failedModelExecutionId,
      videoProviderCalls: 0,
      next: 'negative result requires signed native A rejection' }, null, 2))
  } finally { await db.end() }
  return
}
if (!opts.apply) {
  console.log(JSON.stringify({ mode: 'local-native-review-samples-only',
    planId: opts.planId, phase: opts.phase,
    videoSha256: evidence.videoSha256, evidenceSha256,
    frames: evidence.frames, modelReviewIntent: intent?.requestKey ?? null,
    modelCalls: 0, videoProviderCalls: 0, databaseWrites: 0 }, null, 2))
  return
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const workflow = (await db.query(`SELECT nodes FROM workflow_configs
    WHERE id='wf-sanguo-history-drama'`)).rows[0]
  const node = workflow?.nodes?.find(item => item.id === 'sanguo-media-review')
  const model = node && (await db.query(`SELECT id,name,provider,capability,settings
    FROM model_configs WHERE id=$1`, [node.modelId])).rows[0]
  if (node?.operation !== 'history.media-review'
    || model?.provider !== 'Codex' || model.capability !== 'text')
    fail('independent review model changed')
  if (!intent) {
    intent = { version: 'staged-a8b6-fresh-model-review-intent-v1',
      planId: opts.planId, phase: opts.phase,
      videoSha256: evidence.videoSha256, evidenceSha256,
      modelId: model.id,
      requestKey: `staged-a8b6-fresh:${opts.planId}:${opts.phase}:${evidence.videoSha256}:${randomUUID()}`,
      createdAt: new Date().toISOString() }
    await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
    const request = { model, prompt: freshA8B6ReviewPrompt(opts.phase, evidence),
      operation: 'history.media-review',
      params: { reviewImages: evidence.reviewImages,
        promptInputMode: 'normalized-results',
        qualityDisposition: 'manual-review-v1', qualityMode: 'principle-v1',
        maxReviewAttempts: 1, temperature: 0 },
      executionContext: { workflowId: 'wf-sanguo-history-drama',
        workflowName: '三国原著史料短剧（分步生成）',
        nodeId: 'staged-a8b6-fresh-phase-review',
        nodeName: `新生 A8B6 原生帧独立审核 ${opts.phase}`,
        requestKey: intent.requestKey } }
    const base = process.env.APP_BASE_URL ?? 'http://127.0.0.1:5173'
    const response = await fetch(`${base}/api/node-run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(300000) })
    const envelope = await response.json()
    if (!response.ok || envelope.status !== 200)
      fail(`model review HTTP ${response.status}; intent locked, inspect ledger before any retry`)
  } else if (intent.version !== 'staged-a8b6-fresh-model-review-intent-v1'
    || intent.planId !== opts.planId || intent.phase !== opts.phase
    || intent.videoSha256 !== evidence.videoSha256
    || intent.evidenceSha256 !== evidenceSha256
    || intent.modelId !== model.id)
    fail('existing model-review intent differs from native evidence')
  const rows = (await db.query(`SELECT id,response_data,status
    FROM model_execution_records WHERE request_data->>'requestKey'=$1
    ORDER BY created_at`, [intent.requestKey])).rows
  const succeeded = rows.find(row => row.status === 'succeeded')
  if (!succeeded && opts.phase === 'A'
    && /\.png$/.test(evidence.frames[0]?.url ?? ''))
    fail('v1 CERT attachment is PNG; use --recover-jpeg-v2 after exact failed-ledger audit')
  if (!succeeded)
    fail('independent model ledger not successful; no automatic repeat call')
  const report = parseStructuredJson(extractTextResponse(succeeded.response_data))
  const accepted = report?.decision === 'accept'
    ? await verifyFreshA8B6ModelReviewLedger(opts.planId, opts.phase,
      succeeded.id, root, db.query.bind(db)) : undefined
  console.log(JSON.stringify({ mode: 'independent-native-frame-model-ledger',
    planId: opts.planId, phase: opts.phase,
    executionId: succeeded.id, decision: report?.decision,
    issues: report?.issues, accepted: Boolean(accepted),
    ledgerSha256: accepted?.ledgerSha256 ?? null,
    evidenceSha256,
    next: accepted ? 'direct original-speed visual report still required'
      : 'review failed or uncertain; do not advance phase' }, null, 2))
} finally { await db.end() }
})
