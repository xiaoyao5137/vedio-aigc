/** V7 may derive wall pixels from V6 only as an independently rejected source.
 * V6 node 49 completed normally, rejected wall continuity, and never reached
 * first-frame approval or a paid image/video request. */
import { createHash } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { verifyA8B6LocalCompositeSourceReceiptV6 } from
  './staged-scene-cut-a8b6-local-composite-admission-v6.mjs'
import { assertA8B6LocalFrameHopV6 } from
  '../scripts/fork-original-shot1-a8b6-local-wall-v6.mjs'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'

export const A8B6_LOCAL_V7_REJECTED_V6 = Object.freeze({
  executionId: 'record-4x5m31-a8b6-local-wall-v6',
  resultMd5: 'dbe80e1e81015fcf6b3779aa23901261',
  sourceReceiptSha256:
    '93d5ac1040ab17e9dd68f3b2e9b4b3eed835d4ba3461fbd3ed117fc9c725dc11',
  rejectedReviewSha256:
    'd780dbaf25f60b1596a158b5b1bb3f69f710640e17a37b42ed73d1a9dd665a76',
  reviewModelExecutionId: 'model-run-mun2bvxz-mmbkgki',
  frameApprovalStatus: 'idle',
  imageLedgerCount: 0,
  reviewLedgerCount: 1,
  issueCodes: Object.freeze(['wall_surface_continuity_unconfirmed']),
})

const fail = reason => { throw Error(`A8B6_LOCAL_V7_ANCESTRY_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

/** Fail closed on changed V6 workflow, signed source, model verdict or
 * payment history. A rejected frame is never treated as approved. */
export function assertA8B6LocalV7RejectedV6State(state, resultMd5,
  timing, timingResultMd5, signed, reviewLedgers, imageLedgers,
  root = process.cwd()) {
  const rejected = A8B6_LOCAL_V7_REJECTED_V6
  const runs = state?.nodeRuns, marker = state?.sceneCutA8B6LocalFrameRecovery
  const review = runs?.[49]?.output
  const ledger = reviewLedgers?.[0]
  const source = signed?.receipt
  if (state?.id !== rejected.executionId
    || resultMd5 !== rejected.resultMd5
    || timing?.id !== A8B6_FRESH_FRAME_PARENT_ID
    || timingResultMd5 !== A8B6_FRESH_FRAME_PARENT_MD5
    || state.parentExecutionId !== timing.id
    || signed?.receiptSha256 !== rejected.sourceReceiptSha256
    || source?.target?.executionId !== state.id
    || source.approvedFirstFrame !== false
    || source.requiresFreshIndependentReview !== true
    || marker?.version !== 'scene-cut-a8b6-local-first-frame-v6'
    || marker.sourceReceiptSha256 !== rejected.sourceReceiptSha256
    || marker.outputSha256 !== source.output?.sha256
    || marker.outputUrl !== source.output?.url
    || runs?.[45]?.status !== 'success'
    || runs[45].output?.url !== source.output.url
    || runs[45].output?.sourceBoundLocalComposite?.sourceReceiptSha256
      !== rejected.sourceReceiptSha256
    || runs[48]?.status !== 'success'
    || runs[49]?.status !== 'success'
    || runs[49].node?.id !== 'sanguo-scene-cut-review'
    || runs[49].node?.modelId !== 'codex-local-vision'
    || runs[49].attempt !== 1 || runs[49].revision !== 2
    || review?.version !== 'scene-cut-first-frame-review-v1'
    || review.passed !== false
    || review.frame?.sourceUrl !== source.output.url
    || review.hardChecks?.setting !== false
    || review.hardChecks?.castAndIdentity !== true
    || review.hardChecks?.wardrobeAndEquipment !== true
    || review.hardChecks?.bodyAndProps !== true
    || review.hardChecks?.actionStartNotCompleted !== true
    || review.hardChecks?.allRequiredVisualActionsOpen !== true
    || review.hardChecks?.singleFullFrame !== true
    || canonical(review.issues?.map(issue => issue.code))
      !== canonical(rejected.issueCodes)
    || sha(canonical(review)) !== rejected.rejectedReviewSha256
    || runs[50]?.status !== rejected.frameApprovalStatus
    || runs.slice(50).some(run => run?.status !== 'idle')
    || !Array.isArray(reviewLedgers)
    || reviewLedgers.length !== rejected.reviewLedgerCount
    || ledger?.id !== rejected.reviewModelExecutionId
    || ledger.status !== 'succeeded'
    || ledger.workflow_id !== 'wf-sanguo-history-drama'
    || ledger.node_id !== 'sanguo-scene-cut-review'
    || ledger.model_id !== runs[49].node.modelId
    || ledger.provider !== 'Codex'
    || ledger.request_data?.requestKey !== `${state.id}:attempt-1:revision-2:`
      + 'sanguo-scene-cut-review:0:scene-01'
    || !Array.isArray(imageLedgers)
    || imageLedgers.length !== rejected.imageLedgerCount)
    fail('V6 rejected review, signed first frame or zero-payment state changed')
  assertA8B6LocalFrameHopV6(timing, state, timingResultMd5,
    signed, 'review-complete')
  if (assertSceneCutReviewLedgerRecord(ledger, review,
    { evidence: runs[48].output, shot: runs[11].output,
      sources: runs[41].output,
      reviewImages: runs[48].output.reviewImages,
      openingStatePlan: runs[43].output,
      sceneCutLocalComposite: marker },
    root, 180) !== rejected.reviewModelExecutionId)
    fail('V6 review model did not inspect the signed image')
  return rejected
}

/** Verify the signed V6 picture and real DB/model rejection read-only. */
export async function verifyA8B6LocalV7RejectedV6Ancestry(
  root = process.cwd()) {
  const signed = await verifyA8B6LocalCompositeSourceReceiptV6(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_LOCAL_V7_REJECTED_V6.executionId]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timing = byId.get(ids[0]), v6 = byId.get(ids[1])
    if (rows.length !== 2 || rows.some(row => row.workflow_id
      !== 'wf-sanguo-history-drama') || !timing || !v6)
      fail('approved timing or rejected V6 child is missing')
    const reviewLedgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-review'
        AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
    const imageLedgers = (await db.query(`SELECT id FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
    const rejected = assertA8B6LocalV7RejectedV6State(
      decodeExecutionState(v6.result), v6.result_md5,
      decodeExecutionState(timing.result), timing.result_md5,
      signed, reviewLedgers, imageLedgers, root)
    await db.query('ROLLBACK')
    return { rejected, sourceReceiptSha256: signed.receiptSha256,
      timingResultMd5: timing.result_md5,
      rejectedImageSha256: signed.receipt.output.sha256 }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}
