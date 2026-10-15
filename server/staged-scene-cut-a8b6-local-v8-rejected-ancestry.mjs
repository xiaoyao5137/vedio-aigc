/** V8 may derive wall pixels from V7 only as an independently rejected source.
 * V7 node 49 completed normally, rejected wall continuity, and never reached
 * first-frame approval or a paid image/video request. */
import { createHash } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { verifyA8B6LocalCompositeSourceReceiptV7 } from
  './staged-scene-cut-a8b6-local-composite-admission-v7.mjs'
import { assertA8B6LocalFrameHopV7 } from
  '../scripts/fork-original-shot1-a8b6-local-wall-v7.mjs'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'

export const A8B6_LOCAL_V8_REJECTED_V7 = Object.freeze({
  executionId: 'record-4x5m31-a8b6-local-wall-v7',
  resultMd5: '1ec864753478fe0b6fbe6e2065be0835',
  sourceReceiptSha256:
    '986763c1b90ec4b5482b4fa52dbadb42e825e3cf26ed5e28c0ac12a9b50c4e6d',
  rejectedReviewSha256:
    'a12d43382d9800443dea140f1c0cd6102cdede9323d0a6a4ff3427a62b0f4698',
  reviewModelExecutionId: 'model-run-mun3j1q3-0x8y0hw',
  frameApprovalStatus: 'idle',
  imageLedgerCount: 0,
  reviewLedgerCount: 1,
  issueCodes: Object.freeze(['wall_material_unconfirmed', 'narrow_wall_strip_unconfirmed']),
})

const fail = reason => { throw Error(`A8B6_LOCAL_V8_ANCESTRY_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

/** Fail closed on changed V7 workflow, signed source, model verdict or
 * payment history. A rejected frame is never treated as approved. */
export function assertA8B6LocalV8RejectedV7State(state, resultMd5,
  timing, timingResultMd5, signed, reviewLedgers, imageLedgers,
  root = process.cwd()) {
  const rejected = A8B6_LOCAL_V8_REJECTED_V7
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
    || marker?.version !== 'scene-cut-a8b6-local-first-frame-v7'
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
    fail('V7 rejected review, signed first frame or zero-payment state changed')
  assertA8B6LocalFrameHopV7(timing, state, timingResultMd5,
    signed, 'review-complete')
  if (assertSceneCutReviewLedgerRecord(ledger, review,
    { evidence: runs[48].output, shot: runs[11].output,
      sources: runs[41].output,
      reviewImages: runs[48].output.reviewImages,
      openingStatePlan: runs[43].output,
      sceneCutLocalComposite: marker },
    root, 180) !== rejected.reviewModelExecutionId)
    fail('V7 review model did not inspect the signed image')
  return rejected
}

/** Verify the signed V7 picture and real DB/model rejection read-only. */
export async function verifyA8B6LocalV8RejectedV7Ancestry(
  root = process.cwd()) {
  const signed = await verifyA8B6LocalCompositeSourceReceiptV7(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_LOCAL_V8_REJECTED_V7.executionId]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timing = byId.get(ids[0]), v7 = byId.get(ids[1])
    if (rows.length !== 2 || rows.some(row => row.workflow_id
      !== 'wf-sanguo-history-drama') || !timing || !v7)
      fail('approved timing or rejected V7 child is missing')
    const reviewLedgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-review'
        AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
    const imageLedgers = (await db.query(`SELECT id FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
    const rejected = assertA8B6LocalV8RejectedV7State(
      decodeExecutionState(v7.result), v7.result_md5,
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
