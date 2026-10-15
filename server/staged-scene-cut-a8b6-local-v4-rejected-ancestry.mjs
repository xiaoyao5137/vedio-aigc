/** V4 may reuse V3's picture only as a rejected source, never as approval. */
import { createHash } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { verifyA8B6LocalCompositeSourceReceiptV3 } from
  './staged-scene-cut-a8b6-local-composite-admission-v3.mjs'
import { assertA8B6LocalFrameHopV3 } from
  '../scripts/fork-original-shot1-a8b6-local-face-wall-v3.mjs'

export const A8B6_LOCAL_V4_REJECTED_V3 = Object.freeze({
  executionId: 'record-4x5m31-a8b6-local-face-wall-v3',
  resultMd5: '05e7d2b9df9aa48a05e5d123da405de6',
  rejectedReviewSha256:
    '3570c7f23ce35b2c60ce14ab47885970bf7a9742c6363313663b0b8afa51b1fe',
  reviewModelExecutionId: 'model-run-mumy086h-a3obbjv',
  imageLedgerCount: 0,
  frameApprovalStatus: 'idle',
  soleIssueCode: 'wall_material_requirement_not_met',
})

const fail = reason => { throw Error(`A8B6_LOCAL_V4_ANCESTRY_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

/** The pure gate is also used by focused tests; no rejected V3 result is
 * eligible for a paid video request. */
export function assertA8B6LocalV4RejectedV3State(state, resultMd5,
  reviewLedgers, imageLedgers, root = process.cwd()) {
  const rejected = A8B6_LOCAL_V4_REJECTED_V3
  const runs = state?.nodeRuns, review = runs?.[49]?.output
  const reviewLedger = reviewLedgers?.[0]
  if (state?.id !== rejected.executionId
    || resultMd5 !== rejected.resultMd5
    || state.sceneCutA8B6LocalFrameRecovery?.version
      !== 'scene-cut-a8b6-local-first-frame-v3'
    || runs?.[49]?.status !== 'success'
    || review?.passed !== false
    || review.hardChecks?.setting !== false
    || review.hardChecks?.bodyAndProps !== true
    || review.hardChecks?.castAndIdentity !== true
    || review.hardChecks?.singleFullFrame !== true
    || review.hardChecks?.wardrobeAndEquipment !== true
    || review.hardChecks?.actionStartNotCompleted !== true
    || review.hardChecks?.allRequiredVisualActionsOpen !== true
    || canonical(review.issues?.map(issue => issue.code))
      !== canonical([rejected.soleIssueCode])
    || sha(canonical(review)) !== rejected.rejectedReviewSha256
    || runs?.[50]?.status !== rejected.frameApprovalStatus
    || !Array.isArray(imageLedgers)
    || imageLedgers.length !== rejected.imageLedgerCount
    || !Array.isArray(reviewLedgers) || reviewLedgers.length !== 1
    || reviewLedger?.id !== rejected.reviewModelExecutionId
    || reviewLedger.status !== 'succeeded'
    || !String(reviewLedger.request_data?.requestKey ?? '')
      .startsWith(`${rejected.executionId}:`)
    || assertSceneCutReviewLedgerRecord(reviewLedger, review,
      { evidence: runs[48].output, shot: runs[11].output,
        sources: runs[41].output,
        reviewImages: runs[48].output.reviewImages,
        openingStatePlan: runs[43].output,
        sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery },
      root, 180) !== rejected.reviewModelExecutionId)
    fail('V3 rejection, model ledger or zero-image-payment state changed')
  return rejected
}

/** Recheck the signed V3 source and actual immutable DB/model rejection. */
export async function verifyA8B6LocalV4RejectedV3Ancestry(
  root = process.cwd()) {
  const signedV3 = await verifyA8B6LocalCompositeSourceReceiptV3(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const ids = ['record-4x5m31-a8b6-timing-approval-v3',
      A8B6_LOCAL_V4_REJECTED_V3.executionId]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timing = byId.get(ids[0]), v3 = byId.get(ids[1])
    const state = decodeExecutionState(v3?.result)
    const reviewLedgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-review'
        AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
    const imageLedgers = (await db.query(`SELECT id FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
    if (rows.length !== 2 || rows.some(row => row.workflow_id
      !== 'wf-sanguo-history-drama') || !timing || !v3)
      fail('approved timing or rejected V3 child is missing')
    const rejected = assertA8B6LocalV4RejectedV3State(state,
      v3.result_md5, reviewLedgers, imageLedgers, root)
    assertA8B6LocalFrameHopV3(decodeExecutionState(timing.result),
      state, timing.result_md5, signedV3, 'review-complete')
    await db.query('ROLLBACK')
    return { rejected, sourceReceiptSha256: signedV3.receiptSha256,
      timingResultMd5: timing.result_md5,
      rejectedImageSha256: signedV3.receipt.output.sha256 }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}
