#!/usr/bin/env node
/** Sign a new 14s workflow approval only after real schema180 node10/49 model
 * ledgers, node11 acceptance, node50 certificate and QA review are complete. */
import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { sceneCutShotSha256, verifySceneCutFrameApproval } from '../server/scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from '../server/scene-cut-approval-rebind.ts'
import { verifyA8B6WorkflowApproval } from '../server/staged-scene-cut-a8b6-approval.mjs'
import { assertA8B6ConflictReviewHop,
  verifyA8B6FrameConflictReceipt } from '../server/staged-scene-cut-a8b6-frame-conflict.mjs'
import { readA8B6QAPlan, readA8B6WholeShotReview } from '../server/staged-scene-cut-a8b6-qa.mjs'

const PLAN = 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'
const SOURCE_ID = 'record-4x5m31-original-repair-tail-guide-v2'
const SOURCE_MD5 = '34abee4a7c010616b837dbc175b69c56'
const TIMING_ID = 'record-4x5m31-a8b6-timing-approval-v3'
const REJECTED_FRAME_ID = 'record-4x5m31-a8b6-frame-reuse-v3'
const REJECTED_FRAME_MD5 = '01146ea0d4a7c0d6664f65d5eb9bc54e'
const FRAME_ID = 'record-4x5m31-a8b6-frame-conflict-review-v1'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const ORIGINAL_SHOT_SHA = 'cd192f86b554192ef9be23a3f34cb8e643fd6e1aa11144a7e5aa675c832947d7'
const fail = message => { throw Error(`A8B6_WORKFLOW_APPROVAL_INVALID: ${message}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

export async function prepareA8B6WorkflowApproval(db, planId, root = process.cwd()) {
  if (planId !== PLAN) fail('QA plan identity changed')
  const manifest = await readA8B6QAPlan(planId, root)
  const whole = await readA8B6WholeShotReview(planId, root)
  const conflict = await verifyA8B6FrameConflictReceipt(planId, root)
  if (whole.review?.verdict !== 'accept'
    || whole.review.normalSpeedPlaybackReviewed !== true
    || manifest?.source?.recordId !== SOURCE_ID
    || manifest.source.resultMd5 !== SOURCE_MD5)
    fail('signed direct whole-shot review or QA source is not accepted')
  const get = async id => (await db.query(`SELECT id,workflow_id,result,
    md5(result::text) AS result_md5 FROM execution_records WHERE id=$1`, [id])).rows[0]
  const source = await get(SOURCE_ID), timing = await get(TIMING_ID)
  const rejected = await get(REJECTED_FRAME_ID)
  const current = await get(FRAME_ID)
  const workflow = (await db.query(`SELECT schema_version,
    md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
  if (source?.result_md5 !== SOURCE_MD5
    || !timing?.result_md5 || rejected?.result_md5 !== REJECTED_FRAME_MD5
    || !current?.result_md5
    || current.workflow_id !== 'wf-sanguo-history-drama'
    || workflow?.schema_version !== 180 || workflow.nodes_md5 !== NODES_MD5
    || workflow.edges_md5 !== EDGES_MD5)
    fail('source records or schema180 graph changed')
  const timingState = decodeExecutionState(timing.result)
  const rejectedState = decodeExecutionState(rejected.result)
  const state = decodeExecutionState(current.result)
  assertA8B6ConflictReviewHop(rejectedState, state,
    rejected.result_md5, conflict, 'completed')
  const runs = state.nodeRuns, marker = state.sceneCutA8B6ImageReuseRecovery
  const scriptReview = runs?.[10]?.output, shot = runs?.[11]?.output
  const frameReview = runs?.[49]?.output, certificate = runs?.[50]?.output
  const originalAudioText = [manifest.narration.tracks?.[0]?.text,
    ...(manifest.narration.tracks?.slice(1).map(track => `旁白：${track.text}`) ?? [])]
    .join('\n')
  if (state.id !== FRAME_ID || state.parentExecutionId !== REJECTED_FRAME_ID
    || timingState.id !== TIMING_ID || timingState.parentExecutionId !== SOURCE_ID
    || marker?.version !== 'scene-cut-a8b6-image-reuse-v1'
    || marker.parentExecutionId !== TIMING_ID
    || marker.parentResultMd5 !== timing.result_md5
    || !isDeepStrictEqual(runs.slice(0, 49), rejectedState.nodeRuns.slice(0, 49))
    || marker.qaPlanId !== planId
    || runs[10]?.status !== 'success' || scriptReview?.decision !== 'pass'
    || !isDeepStrictEqual(scriptReview.issues, [])
    || !isDeepStrictEqual(scriptReview.warnings, [])
    || runs[11]?.status !== 'success' || shot?.passed !== true
    || shot.manualDecisionRequired !== false
    || !isDeepStrictEqual(shot.issues, [])
    || !isDeepStrictEqual(shot.qualityReview?.warnings?.map(w => w.code),
      ['manual_review_required'])
    || shot.duration !== 14 || shot.audioText !== originalAudioText
    || runs[43]?.status !== 'success'
    || runs[43].output?.shotSha256 !== sceneCutShotSha256(shot)
    || runs[45]?.status !== 'success' || runs[48]?.status !== 'success'
    || runs[49]?.status !== 'success' || frameReview?.passed !== true
    || !isDeepStrictEqual(frameReview.issues, [])
    || runs[50]?.status !== 'success'
    || runs[51]?.status !== 'idle' || runs[52]?.status !== 'idle'
    || certificate?.shotSha256 !== sceneCutShotSha256(shot)
    || certificate?.repairBinding !== undefined)
    fail('independent 14s creative/image workflow is not fully approved')
  verifySceneCutFrameApproval(certificate, root)
  const storyboardRows = (await db.query(`SELECT id,status,model_id,provider,
    workflow_id,node_id,capability,request_data,response_data
    FROM model_execution_records
    WHERE workflow_id='wf-sanguo-history-drama'
      AND node_id='sanguo-shot-script-review' AND status='succeeded'
      AND request_data->>'requestKey' LIKE $1 ORDER BY created_at DESC LIMIT 20`,
  [`${TIMING_ID}:%`])).rows
  const storyboardLedger = storyboardRows.find(row => row.model_id === scriptReview.model
    && row.provider !== 'Local'
    && isDeepStrictEqual(row.response_data, scriptReview.raw)
    && isDeepStrictEqual(row.request_data?.params?.candidate, runs[9].output))
  if (!storyboardLedger) fail('new script model review ledger missing')
  const frameLedger = (await db.query(`SELECT id,status FROM model_execution_records
    WHERE id=$1`, [certificate.reviewExecutionId])).rows[0]
  if (frameLedger?.status !== 'succeeded') fail('new first-frame model review ledger missing')
  const qaDir = path.join(root, '.runtime/staged-scene-cut-a8b6-qa', planId)
  const body = { version: 'scene-cut-a8b6-workflow-approval-v1',
    qaPlanId: planId,
    qaManifestSha256: sha(await readFile(path.join(qaDir, 'manifest.json'))),
    wholeShotReviewSha256: whole.sha256,
    sourceExecutionId: SOURCE_ID, sourceResultMd5: SOURCE_MD5,
    originalShotSha256: ORIGINAL_SHOT_SHA,
    timingExecutionId: TIMING_ID, timingResultMd5: timing.result_md5,
    reviewRetrySourceExecutionId: REJECTED_FRAME_ID,
    reviewRetrySourceResultMd5: REJECTED_FRAME_MD5,
    conflictAdjudicationReceiptSha256: conflict.receiptSha256,
    conflictReviewMarkerSha256: sceneCutRebindSha256(
      state.sceneCutA8B6ConflictReviewRecovery),
    approvalExecutionId: FRAME_ID, approvalResultMd5: current.result_md5,
    workflowSchemaVersion: 180, workflowNodesMd5: NODES_MD5,
    workflowEdgesMd5: EDGES_MD5,
    storyboardReviewExecutionId: storyboardLedger.id,
    frameReviewExecutionId: certificate.reviewExecutionId,
    imageReuseMarkerSha256: sceneCutRebindSha256(marker),
    amendedShot: shot, amendedShotSha256: sceneCutShotSha256(shot),
    amendedScheduleHash: shot.scheduleHash,
    frameCertificate: certificate,
    sceneCutFrameCertificateSha256: sha(canonical(certificate)),
    sceneCutFrameApprovalSignature: certificate.signature,
    approvalState: 'approved-in-new-schema180-branch' }
  return { body, sourceMd5: source.result_md5,
    timingMd5: timing.result_md5, currentMd5: current.result_md5 }
}

function parseArgs(args) {
  const options = { apply: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { options.apply = true; continue }
    const field = { '--plan': 'planId', '--expected-record-md5': 'recordMd5' }[args[i]]
    if (!field || options[field] !== undefined || !args[i + 1]
      || args[i + 1].startsWith('--')) fail(`invalid argument ${args[i]}`)
    options[field] = args[++i]
  }
  if (options.planId !== PLAN) fail('--plan differs from signed QA plan')
  if (options.apply && !/^[a-f0-9]{32}$/.test(String(options.recordMd5)))
    fail('--apply requires exact record MD5 CAS')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const { body, currentMd5 } = await prepareA8B6WorkflowApproval(db, options.planId)
    if (options.recordMd5 && options.recordMd5 !== currentMd5)
      fail('approved record changed since the reviewed checkpoint')
    await db.query('COMMIT')
    if (!options.apply) {
      console.log(JSON.stringify({ readyToSign: true, recordId: FRAME_ID,
        recordMd5: currentMd5, amendedShotSha256: body.amendedShotSha256,
        amendedScheduleHash: body.amendedScheduleHash,
        storyboardReviewExecutionId: body.storyboardReviewExecutionId,
        frameReviewExecutionId: body.frameReviewExecutionId,
        certificateSha256: body.sceneCutFrameCertificateSha256,
        databaseWrites: 0 }, null, 2))
      return
    }
    const key = await readFile('.runtime/staged-scene-cut.key')
    if (key.length !== 32) fail('staged source signing key invalid')
    const value = { ...body, signature: createHmac('sha256', key)
      .update(canonical(body)).digest('hex') }
    const directory = path.join('.runtime/staged-scene-cut-a8b6-approval', options.planId)
    await mkdir(directory, { recursive: true })
    const filename = path.join(directory, 'approval.json')
    await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    const verified = await verifyA8B6WorkflowApproval(options.planId)
    console.log(JSON.stringify({ path: filename, approvalSha256: verified.approvalSha256,
      recordId: FRAME_ID, recordMd5: currentMd5,
      amendedShotSha256: body.amendedShotSha256,
      certificateSha256: body.sceneCutFrameCertificateSha256,
      storyboardReviewExecutionId: body.storyboardReviewExecutionId,
      frameReviewExecutionId: body.frameReviewExecutionId,
      databaseWrites: 0 }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1]?.endsWith('issue-staged-scene-cut-a8b6-workflow-approval.mjs'))
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
