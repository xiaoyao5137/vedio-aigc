/** The V3 candidate must preserve V2's real rejection as immutable history. */
import { createHash } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { verifyA8B6LocalCompositeSourceReceiptV2 } from
  './staged-scene-cut-a8b6-local-composite-admission-v2.mjs'
import { assertA8B6LocalFrameHopV2 } from
  '../scripts/fork-original-shot1-a8b6-local-face-v2.mjs'

export const A8B6_LOCAL_V3_REJECTED_V2 = Object.freeze({
  executionId: 'record-4x5m31-a8b6-local-face-v2',
  resultMd5: 'ab73ca2d9c995c154c064f8a1f5a85c9',
  rejectedReviewSha256:
    'd258b5995d1bbb9cfcf2972ac42432e33c56d5d5f2edbae4572b603c29738d90',
  reviewModelExecutionId: 'model-run-mumvkgzt-ucbr3si',
  imageLedgerCount: 0,
  frameApprovalStatus: 'idle',
})

const fail = reason => { throw Error(`A8B6_LOCAL_V3_ANCESTRY_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

export function assertA8B6LocalV3RejectedV2State(state, resultMd5,
  reviewLedger, imageLedgers, root = process.cwd()) {
  const rejected = A8B6_LOCAL_V3_REJECTED_V2
  const runs = state?.nodeRuns, review = runs?.[49]?.output
  if (state?.id !== rejected.executionId
    || resultMd5 !== rejected.resultMd5
    || state.sceneCutA8B6LocalFrameRecovery?.version
      !== 'scene-cut-a8b6-local-first-frame-v2'
    || runs?.[49]?.status !== 'success'
    || review?.passed !== false
    || review.hardChecks?.setting !== false
    || review.hardChecks?.castAndIdentity !== false
    || canonical(review.issues?.map(issue => issue.code))
      !== canonical(['setting_wall_material_mismatch',
        'yanyan_identity_not_confirmed'])
    || sha(canonical(review)) !== rejected.rejectedReviewSha256
    || runs?.[50]?.status !== rejected.frameApprovalStatus
    || !Array.isArray(imageLedgers)
    || imageLedgers.length !== rejected.imageLedgerCount
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
    fail('V2 rejection, model ledger or zero-image-payment state changed')
  return rejected
}

export async function verifyA8B6LocalV3RejectedV2Ancestry(
  root = process.cwd()) {
  const signedV2 = await verifyA8B6LocalCompositeSourceReceiptV2(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const ids = ['record-4x5m31-a8b6-timing-approval-v3',
      A8B6_LOCAL_V3_REJECTED_V2.executionId]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timing = byId.get(ids[0]), v2 = byId.get(ids[1])
    const state = decodeExecutionState(v2?.result)
    const reviewLedger = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=$1`, [A8B6_LOCAL_V3_REJECTED_V2.reviewModelExecutionId])).rows[0]
    const imageLedgers = (await db.query(`SELECT id FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
    if (rows.length !== 2 || rows.some(row => row.workflow_id
      !== 'wf-sanguo-history-drama') || !timing || !v2)
      fail('V2 approved timing or rejected child is missing')
    const rejected = assertA8B6LocalV3RejectedV2State(state,
      v2.result_md5, reviewLedger, imageLedgers, root)
    assertA8B6LocalFrameHopV2(decodeExecutionState(timing.result),
      state, timing.result_md5, signedV2, 'review-complete')
    await db.query('ROLLBACK')
    return { rejected, sourceReceiptSha256: signedV2.receiptSha256,
      timingResultMd5: timing.result_md5 }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}
