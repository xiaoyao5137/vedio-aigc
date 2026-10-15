#!/usr/bin/env node
/** B3 five-JPEG clarification. Preview signs its own evidence and intent;
 * --apply submits the independent model exactly once. Never calls video. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'
import { B3_FRAME_V4_RECOVERY,
  saveFreshA8B6ReviewEvidenceV4,
  readFreshA8B6ReviewEvidenceV4,
  saveFreshA8B6FrameReviewIntentV4,
  readFreshA8B6FrameReviewIntentV4,
  saveFreshA8B6FrameReviewSubmitV4,
  readFreshA8B6FrameReviewSubmitV4,
  freshA8B6FrameReviewPromptV4,
  freshA8B6FrameChecksV4,
  assertFreshA8B6FrameModelLedgerV4 } from
  '../server/staged-scene-cut-a8b6-fresh-review-v4.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_FRAME_REVIEW_V4_RUNNER_INVALID: ${reason}`) }
const SHA = /^[a-f0-9]{64}$/
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
if (opts.planId !== B3_FRAME_V4_RECOVERY.planId || opts.phase !== 'B')
  fail('signed B3 plan and B phase required')
if (opts.videoSha256 && !SHA.test(opts.videoSha256)
  || opts.evidenceSha256 && !SHA.test(opts.evidenceSha256)
  || opts.intentSha256 && !SHA.test(opts.intentSha256)
  || opts.apply && (!opts.videoSha256 || !opts.evidenceSha256
    || !opts.intentSha256))
  fail('--apply requires exact previewed video, evidence and intent hashes')

const root = process.cwd()
await withV9VerifiedSource(root, async () => {
  // Only write-once v4 files are created. The v3 uncertain attempt is read
  // and validated in the reviewer before either file can be signed.
  await saveFreshA8B6ReviewEvidenceV4(opts.planId, 'B', root)
  const { evidence, evidenceSha256, priorV3 } =
    await readFreshA8B6ReviewEvidenceV4(opts.planId, 'B', root)
  if (opts.videoSha256 && opts.videoSha256 !== evidence.videoSha256
    || opts.evidenceSha256 && opts.evidenceSha256 !== evidenceSha256)
    fail('B3 native video or five JPEG evidence changed')
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
      || model?.provider !== 'Codex' || model.capability !== 'text'
      || model.id !== 'codex-local-vision')
      fail('independent B3 review model changed')
    const intentFile = path.join(root,
      '.runtime/staged-scene-cut-a8b6-fresh', opts.planId,
      'phase-B-frame-model-intent-v4.json')
    try { await readFile(intentFile) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const requestKey = `staged-a8b6-fresh-frame-v4:${opts.planId}:B:${evidence.videoSha256}:${randomUUID()}`
      await saveFreshA8B6FrameReviewIntentV4(opts.planId,
        'B', model.id, requestKey, root)
    }
    const { intent, intentSha256 } =
      await readFreshA8B6FrameReviewIntentV4(opts.planId, 'B', root)
    if (intent.modelId !== model.id
      || opts.intentSha256 && opts.intentSha256 !== intentSha256)
      fail('signed v4 model intent changed since preview')
    const query = `SELECT id,channel,workflow_id,node_id,model_id,
      capability,provider,status,request_data,response_data
      FROM model_execution_records WHERE request_data->>'requestKey'=$1
      ORDER BY created_at`
    const rows = (await db.query(query, [intent.requestKey])).rows
    if (!opts.apply) {
      console.log(JSON.stringify({ mode: 'v4-B3-five-frame-preview',
        planId: opts.planId, videoSha256: evidence.videoSha256,
        evidenceSha256, intentSha256, requestKey: intent.requestKey,
        priorV3, frameChecks: freshA8B6FrameChecksV4(),
        frames: evidence.frames.map(frame => ({ frameIndex: frame.frameIndex,
          url: frame.url, sha256: frame.sha256 })),
        modelLedgers: rows.map(row => ({ id: row.id, status: row.status })),
        modelCalls: 0, videoProviderCalls: 0, databaseWrites: 0 }, null, 2))
      return
    }
    if (rows.length > 1 || rows.some(row => row.status !== 'succeeded'))
      fail('v4 model attempt already failed, active or duplicated')
    if (rows.length === 0) {
      const submitFile = path.join(root,
        '.runtime/staged-scene-cut-a8b6-fresh', opts.planId,
        'phase-B-frame-model-submit-v4.json')
      try { await readFile(submitFile); fail('v4 submission already attempted') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await saveFreshA8B6FrameReviewSubmitV4(opts.planId, 'B', root)
      const request = { model,
        prompt: freshA8B6FrameReviewPromptV4(evidence),
        operation: 'history.media-review',
        params: { reviewImages: evidence.reviewImages,
          promptInputMode: 'normalized-results',
          qualityDisposition: 'manual-review-v1',
          qualityMode: 'principle-v1', maxReviewAttempts: 1,
          temperature: 0 },
        executionContext: { workflowId: 'wf-sanguo-history-drama',
          workflowName: '三国原著史料短剧（分步生成）',
          nodeId: 'staged-a8b6-fresh-frame-review-v4',
          nodeName: 'B3 五帧可观察事实补审',
          requestKey: intent.requestKey } }
      const base = process.env.APP_BASE_URL ?? 'http://127.0.0.1:5173'
      const response = await fetch(`${base}/api/node-run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(300000) })
      const envelope = await response.json()
      if (!response.ok || envelope.status !== 200)
        fail(`v4 frame review HTTP ${response.status}; submission locked`)
    }
    await readFreshA8B6FrameReviewSubmitV4(opts.planId, 'B', root)
    const finalRows = (await db.query(query, [intent.requestKey])).rows
    if (finalRows.length !== 1 || finalRows[0].status !== 'succeeded')
      fail('v4 model ledger absent or unsuccessful; no automatic retry')
    const checked = assertFreshA8B6FrameModelLedgerV4(
      finalRows[0], 'B', evidence, intent)
    console.log(JSON.stringify({ mode: 'v4-B3-frame-clarification-ledger',
      planId: opts.planId, executionId: checked.row.id,
      decision: checked.report.decision,
      acceptedFrameFacts: checked.accepted,
      checks: checked.report.checks, issues: checked.report.issues,
      ledgerSha256: checked.ledgerSha256,
      priorV3LedgerSha256: priorV3.ledgerSha256,
      evidenceSha256, videoProviderCalls: 0 }, null, 2))
  } finally { await db.end() }
})
