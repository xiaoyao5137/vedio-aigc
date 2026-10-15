#!/usr/bin/env node
/** Retake A/B JPEG facts only. Preview signs intent; --apply submits once. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { readFreshA8B6PhaseAPlan, freshA8B6Directory } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'
import { readFreshA8B6MediaReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-phases.mjs'
import { saveFreshA8B6ReviewEvidence } from
  '../server/staged-scene-cut-a8b6-fresh-review.mjs'
import { freshA8B6FrameChecksV3, freshA8B6FrameReviewPromptV3,
  saveFreshA8B6ReviewEvidenceV3,
  saveFreshA8B6FrameReviewIntentV3,
  readFreshA8B6FrameReviewIntentV3,
  saveFreshA8B6FrameReviewSubmitV3,
  readFreshA8B6FrameReviewSubmitV3,
  assertFreshA8B6FrameModelLedgerV3 } from
  '../server/staged-scene-cut-a8b6-fresh-review-v3.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_FRAME_REVIEW_V3_RUNNER_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const field = { '--plan-id': 'planId', '--phase': 'phase',
    '--expected-video-sha256': 'videoSha256',
    '--expected-evidence-sha256': 'evidenceSha256',
    '--expected-intent-sha256': 'intentSha256' }[args[index]]
  if (!field || opts[field] || !args[index + 1]
    || args[index + 1].startsWith('--'))
    fail(`invalid or repeated ${args[index]}`)
  opts[field] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(opts.planId ?? '')
  || !['A', 'B'].includes(opts.phase))
  fail('signed retake plan and A/B phase required')
if (opts.apply && [opts.videoSha256, opts.evidenceSha256,
  opts.intentSha256].some(value => !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--apply requires previewed video, evidence and intent hashes')

const root = process.cwd()
await withV9VerifiedSource(root, async () => {
  const A = await readFreshA8B6PhaseAPlan(opts.planId, root)
  if (!['staged-a8b6-fresh-A-plan-v2',
    'staged-a8b6-fresh-A-plan-v3'].includes(A.manifest.version)
    || A.manifest.version === 'staged-a8b6-fresh-A-plan-v3'
      && opts.phase !== 'B')
    fail('v3 frame review is only for the signed retake plan')
  const { media } = await readFreshA8B6MediaReceipt(opts.planId,
    opts.phase, root)
  if (opts.videoSha256 && opts.videoSha256 !== media.videoSha256)
    fail('provider video changed since preview')
  const evidencePath = path.join(freshA8B6Directory(opts.planId, root),
    `phase-${opts.phase}-review-evidence.json`)
  try { await readFile(evidencePath) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    await saveFreshA8B6ReviewEvidence(opts.planId, opts.phase, root)
  }
  // The v3 evidence is signed only after every attachment passes the live
  // JPEG-only endpoint preflight and its V9 PNG/JPEG ancestry checks.
  await saveFreshA8B6ReviewEvidenceV3(opts.planId, opts.phase, root)
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
    let intentState
    try { intentState = await readFreshA8B6FrameReviewIntentV3(
      opts.planId, opts.phase, root) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const key = `staged-a8b6-fresh-frame-v3:${opts.planId}:${opts.phase}:${media.videoSha256}:${randomUUID()}`
      await saveFreshA8B6FrameReviewIntentV3(opts.planId,
        opts.phase, model.id, key, root)
      intentState = await readFreshA8B6FrameReviewIntentV3(
        opts.planId, opts.phase, root)
    }
    const { intent, intentSha256, evidence,
      evidenceSha256 } = intentState
    if (intent.modelId !== model.id
      || opts.evidenceSha256 && opts.evidenceSha256 !== evidenceSha256
      || opts.intentSha256 && opts.intentSha256 !== intentSha256)
      fail('v3 signed model intent or native samples changed')
    const rows = (await db.query(`SELECT id,channel,workflow_id,node_id,
      model_id,capability,provider,status,request_data,response_data
      FROM model_execution_records WHERE request_data->>'requestKey'=$1
      ORDER BY created_at`, [intent.requestKey])).rows
    if (!opts.apply) {
      console.log(JSON.stringify({ mode: 'v3-frame-review-preview',
        planId: opts.planId, phase: opts.phase,
        videoSha256: media.videoSha256, evidenceSha256,
        intentSha256, requestKey: intent.requestKey,
        frameChecks: freshA8B6FrameChecksV3(opts.phase),
        frames: evidence.frames, modelLedgers: rows.map(row => ({
          id: row.id, status: row.status })),
        modelCalls: 0, videoProviderCalls: 0, databaseWrites: 0 }, null, 2))
      return
    }
    if (rows.length > 1 || rows.some(row => row.status !== 'succeeded'))
      fail('v3 model attempt already failed, is active or duplicated')
    if (rows.length === 0) {
      try {
        await readFreshA8B6FrameReviewSubmitV3(opts.planId,
          opts.phase, root)
        fail('v3 model submission was already attempted; inspect ledger')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      await saveFreshA8B6FrameReviewSubmitV3(opts.planId,
        opts.phase, root)
      const request = { model,
        prompt: freshA8B6FrameReviewPromptV3(opts.phase, evidence),
        operation: 'history.media-review',
        params: { reviewImages: evidence.reviewImages,
          promptInputMode: 'normalized-results',
          qualityDisposition: 'manual-review-v1',
          qualityMode: 'principle-v1', maxReviewAttempts: 1,
          temperature: 0 },
        executionContext: { workflowId: 'wf-sanguo-history-drama',
          workflowName: '三国原著史料短剧（分步生成）',
          nodeId: 'staged-a8b6-fresh-frame-review-v3',
          nodeName: `新生 A8B6 JPEG 帧事实审核 ${opts.phase}`,
          requestKey: intent.requestKey } }
      const base = process.env.APP_BASE_URL ?? 'http://127.0.0.1:5173'
      const response = await fetch(`${base}/api/node-run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(300000) })
      const envelope = await response.json()
      if (!response.ok || envelope.status !== 200)
        fail(`v3 frame review HTTP ${response.status}; submission locked`)
    }
    const finalRows = (await db.query(`SELECT id,channel,workflow_id,node_id,
      model_id,capability,provider,status,request_data,response_data
      FROM model_execution_records WHERE request_data->>'requestKey'=$1
      ORDER BY created_at`, [intent.requestKey])).rows
    if (finalRows.length !== 1 || finalRows[0].status !== 'succeeded')
      fail('v3 model ledger absent or unsuccessful; no automatic retry')
    const checked = assertFreshA8B6FrameModelLedgerV3(
      finalRows[0], opts.phase, evidence, intent)
    console.log(JSON.stringify({ mode: 'v3-frame-model-ledger',
      planId: opts.planId, phase: opts.phase,
      executionId: checked.row.id, decision: checked.report.decision,
      acceptedFrameFacts: checked.accepted,
      issues: checked.report.issues,
      ledgerSha256: checked.ledgerSha256, evidenceSha256,
      next: checked.accepted
        ? 'actual full-speed watch and separate audio isolation still required'
        : 'frame facts rejected or uncertain; do not accept this phase',
      videoProviderCalls: 0 }, null, 2))
  } finally { await db.end() }
})
