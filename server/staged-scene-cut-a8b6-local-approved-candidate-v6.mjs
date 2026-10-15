/** Read-only admission of the V6 frame after its own model review and certificate. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { A8B6_LOCAL_V6_FRAME_ID } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { verifySceneCutFrameApproval, sceneCutShotSha256 } from
  './scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { assertA8B6LocalCompositeWorkflowResultV6,
  verifyA8B6LocalCompositeSourceReceiptV6 } from
  './staged-scene-cut-a8b6-local-composite-admission-v6.mjs'
import { assertA8B6LocalFrameHopV6 } from
  '../scripts/fork-original-shot1-a8b6-local-wall-v6.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_V6_CANDIDATE_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

export async function prepareA8B6LocalApprovedImageCandidateV6(root = process.cwd()) {
  const signed = await verifyA8B6LocalCompositeSourceReceiptV6(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [[A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_LOCAL_V6_FRAME_ID]])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timingRow = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const sourceRow = byId.get(A8B6_LOCAL_V6_FRAME_ID)
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    if (rows.length !== 2
      || rows.some(row => row.workflow_id !== 'wf-sanguo-history-drama')
      || timingRow?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5)
      fail('approved timing or graph changed')
    const timing = decodeExecutionState(timingRow.result)
    const state = decodeExecutionState(sourceRow.result)
    assertA8B6LocalFrameHopV6(timing, state, timingRow.result_md5,
      signed, 'approved')
    const runs = state.nodeRuns
    if (runs[10]?.status !== 'success'
      || runs[10].output?.decision !== 'pass'
      || !isDeepStrictEqual(runs[10].output?.issues, [])
      || !isDeepStrictEqual(runs[10].output?.warnings, [])
      || runs[11]?.status !== 'success'
      || runs[11].output?.passed !== true
      || runs[11].output?.manualDecisionRequired !== false
      || !isDeepStrictEqual(runs[11].output?.issues, [])
      || !isDeepStrictEqual(runs[11].output?.qualityReview?.warnings
        ?.map(item => item.code), ['manual_review_required'])
      || runs[43]?.status !== 'success'
      || runs[43].output?.shotSha256 !== sceneCutShotSha256(runs[11].output)
      || runs[47]?.status !== 'success'
      || runs[48]?.status !== 'success'
      || runs[49]?.status !== 'success'
      || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])
      || runs[50]?.status !== 'success'
      || runs.slice(51).some(run => run.status !== 'idle'))
      fail('14-second script, V6 real image review or frame certificate missing')
    const certificate = verifySceneCutFrameApproval(runs[50].output, root)
    if (certificate.passed !== true
      || certificate.repairBinding !== undefined
      || certificate.shotSha256 !== sceneCutShotSha256(runs[11].output)
      || certificate.frame?.sourceUrl !== signed.receipt.output.url
      || certificate.sourceSha256s?.[0] !== signed.receipt.output.sha256)
      fail('V6 certificate is not bound to actual signed pixels')
    const imageLedgers = (await db.query(`SELECT id FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`,
    [`${A8B6_LOCAL_V6_FRAME_ID}:%`])).rows
    if (imageLedgers.length !== 0)
      fail('V6 local child unexpectedly made a paid image request')
    const reviewLedgers = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=$1`, [certificate.reviewExecutionId])).rows
    const reviewLedger = reviewLedgers[0]
    if (reviewLedgers.length !== 1
      || !String(reviewLedger.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_LOCAL_V6_FRAME_ID}:`)
      || certificate.reviewExecutionId !== assertSceneCutReviewLedgerRecord(
        reviewLedger, runs[49].output,
        { evidence: runs[48].output, shot: runs[11].output,
          sources: runs[41].output,
          reviewImages: runs[48].output.reviewImages,
          openingStatePlan: runs[43].output,
          sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery },
        root, 180))
      fail('V6 approval lacks its exact independent model ledger')
    const certificateSha256 = sceneCutRebindSha256(certificate)
    assertA8B6LocalCompositeWorkflowResultV6({
      receipt: signed.receipt, receiptSha256: signed.receiptSha256,
      execution: state, imageLedgers, reviewLedgerCount: reviewLedgers.length,
      frameCertificateSha256: certificateSha256 })
    await db.query('ROLLBACK')
    return { sourceRow, timingRow,
      frameProvenanceVariant: 'a8b6-local-composite-v6',
      approvedFirstFrameUrl: signed.receipt.output.url,
      approvedFirstFrameSha256: signed.receipt.output.sha256,
      frameCertificateSha256: certificateSha256,
      frameCertificate: certificate,
      localCompositeSourceReceiptSha256: signed.receiptSha256,
      localCompositeAlgorithmSha256:
        signed.receipt.algorithm.implementationSha256,
      wallImageGenRawSha256: signed.receipt.sources[1].sha256,
      priorLocalV5RejectedReviewSha256:
        signed.receipt.priorLocalV5.rejectedReviewSha256,
      imageLedgers: [], reviewLedger,
      approvedShotSha256: certificate.shotSha256,
      approvedScheduleHash: runs[11].output.scheduleHash,
      frameReviewExecutionId: certificate.reviewExecutionId,
      markerSha256: sha(canonical(state.sceneCutA8B6LocalFrameRecovery)) }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}
