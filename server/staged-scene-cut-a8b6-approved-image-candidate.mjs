/** Read-only gate for the one newly paid, independently approved first frame.
 * The media plan consumes this certificate rather than naming a static v4/v5
 * source record. No plan is saved while node49/50 are incomplete. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { A8B6_FRESH_V8_EDIT_FRAME_ID } from
  '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { verifySceneCutFrameApproval, sceneCutShotSha256 } from
  './scene-cut-frame-approval.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { assertSceneCutReviewLedgerRecord } from './scene-cut-frame-runtime.ts'
import { A8B6_FRESH_FRAME_PARENT_ID, A8B6_FRESH_FRAME_PARENT_MD5,
  A8B6_FRESH_NODES_MD5, A8B6_FRESH_EDGES_MD5 } from
  './staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID } from
  './staged-scene-cut-a8b6-v7-dual-output.mjs'
import { A8B6_V7_REJECTED_MD5, assertA8B6FreshV8EditHop,
  verifyA8B6FreshV8EditReceipt } from
  './staged-scene-cut-a8b6-fresh-edit-v8.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_CANDIDATE_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

export async function prepareA8B6FreshApprovedImageCandidate(root = process.cwd()) {
  const edit = await verifyA8B6FreshV8EditReceipt(root)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const ids = [A8B6_FRESH_FRAME_PARENT_ID,
      A8B6_V7_DUAL_OUTPUT_CHILD_ID, A8B6_FRESH_V8_EDIT_FRAME_ID]
    const rows = (await db.query(`SELECT id,workflow_id,result,
      md5(result::text) AS result_md5 FROM execution_records
      WHERE id=ANY($1)`, [ids])).rows
    const byId = new Map(rows.map(row => [row.id, row]))
    const timingRow = byId.get(A8B6_FRESH_FRAME_PARENT_ID)
    const rejectedRow = byId.get(A8B6_V7_DUAL_OUTPUT_CHILD_ID)
    const sourceRow = byId.get(A8B6_FRESH_V8_EDIT_FRAME_ID)
    const graph = (await db.query(`SELECT schema_version,
      md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
      FROM workflow_configs WHERE id='wf-sanguo-history-drama'`)).rows[0]
    if (rows.length !== ids.length
      || rows.some(row => row.workflow_id !== 'wf-sanguo-history-drama')
      || timingRow?.result_md5 !== A8B6_FRESH_FRAME_PARENT_MD5
      || rejectedRow?.result_md5 !== A8B6_V7_REJECTED_MD5
      || graph?.schema_version !== 180
      || graph.nodes_md5 !== A8B6_FRESH_NODES_MD5
      || graph.edges_md5 !== A8B6_FRESH_EDGES_MD5)
      fail('signed timing, rejected history or current graph changed')
    const timing = decodeExecutionState(timingRow.result)
    const rejected = decodeExecutionState(rejectedRow.result)
    const state = decodeExecutionState(sourceRow.result)
    assertA8B6FreshV8EditHop(timing, state, timingRow.result_md5,
      edit, rejected, 'approved')
    const runs = state.nodeRuns
    if (runs[10]?.status !== 'success'
      || runs[10].output?.decision !== 'pass'
      || !isDeepStrictEqual(runs[10].output?.issues, [])
      || !isDeepStrictEqual(runs[10].output?.warnings, [])
      || runs[11]?.status !== 'success' || runs[11].output?.passed !== true
      || runs[11].output?.manualDecisionRequired !== false
      || !isDeepStrictEqual(runs[11].output?.issues, [])
      || !isDeepStrictEqual(runs[11].output?.qualityReview?.warnings
        ?.map(item => item.code), ['manual_review_required'])
      || runs[43]?.status !== 'success'
      || runs[43].output?.shotSha256 !== sceneCutShotSha256(runs[11].output)
      || runs[45]?.status !== 'success'
      || runs[47]?.status !== 'success'
      || runs[48]?.status !== 'success'
      || runs[49]?.status !== 'success'
      || runs[49].output?.passed !== true
      || !isDeepStrictEqual(runs[49].output?.issues, [])
      || runs[50]?.status !== 'success'
      || runs.slice(51).some(run => run.status !== 'idle'))
      fail('new 14s script, image evidence, independent review or certificate missing')
    const certificate = verifySceneCutFrameApproval(runs[50].output, root)
    const url = runs[45].output?.url
    if (certificate.passed !== true || certificate.repairBinding !== undefined
      || certificate.shotSha256 !== sceneCutShotSha256(runs[11].output)
      || certificate.frame?.sourceUrl !== url
      || typeof url !== 'string'
      || !/^\/generated\/[\w.-]+\.png$/.test(url)
      || certificate.sourceSha256s?.[0]
        !== sha(readFileSync(path.join(root, 'public', url.slice(1))))
      || certificate.sourceSha256s[0]
        === edit.receipt.referenceOrder[2].sourceSha256)
      fail('new paid image bytes or frame certificate changed')
    const imageRows = (await db.query(`SELECT * FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`,
    [`${A8B6_FRESH_V8_EDIT_FRAME_ID}:%`])).rows
    if (imageRows.length !== 1) fail('new image lacks one unique payment ledger')
    const imageLedger = imageRows[0]
    const refs = edit.referenceImages
    const referenceProof = refs.map((value, index) => {
      const bytes = Buffer.from(value.slice('data:image/jpeg;base64,'.length),
        'base64')
      return { index: index + 1, bytes: bytes.length, sha256: sha(bytes) }
    })
    if (imageLedger.status !== 'succeeded'
      || imageLedger.provider !== 'Codex'
      || imageLedger.capability !== 'image'
      || imageLedger.response_data?.raw?.image?.sha256
        !== certificate.sourceSha256s[0]
      || imageLedger.response_data?.data?.[0]?.url !== url
      || !isDeepStrictEqual(imageLedger.request_data?.params
        ?.sceneCutFreshEditReceipt, edit.receipt)
      || !isDeepStrictEqual(imageLedger.request_data?.params
        ?.sceneCutFreshImage, state.sceneCutA8B6FreshFrameRecovery)
      || !isDeepStrictEqual(imageLedger.request_data?.params?.referenceImages,
        refs.map(value => `[素材内容已隐藏，${value.length} 字符]`))
      || !isDeepStrictEqual(imageLedger.response_data?.raw?.references,
        referenceProof))
      fail('approved image is not bound to the unique five-reference payment')
    const reviewLedger = (await db.query(`SELECT * FROM model_execution_records
      WHERE id=$1`, [certificate.reviewExecutionId])).rows[0]
    if (certificate.reviewExecutionId !== assertSceneCutReviewLedgerRecord(
      reviewLedger, runs[49].output,
      { evidence: runs[48].output, shot: runs[11].output,
        sources: runs[41].output,
        reviewImages: runs[48].output.reviewImages,
        openingStatePlan: runs[43].output,
        sceneCutFreshImage: state.sceneCutA8B6FreshFrameRecovery }, root, 180)
      || !String(reviewLedger.request_data?.requestKey ?? '')
        .startsWith(`${A8B6_FRESH_V8_EDIT_FRAME_ID}:`))
      fail('fresh first-frame review differs from exact model ledger')
    await db.query('ROLLBACK')
    return { sourceRow, timingRow, imageLedger,
      editReceiptSha256: edit.receiptSha256,
      v8EditReceiptSha256: edit.receiptSha256,
      referenceProof,
      rejectedLayoutImageSha256: edit.receipt.referenceOrder[2].sourceSha256,
      rejectedLayoutTransportSha256:
        edit.receipt.referenceOrder[2].jpegSha256,
      maskedLayoutSourceSha256: edit.receipt.referenceOrder[2].sourceSha256,
      maskedLayoutTransportSha256: edit.receipt.referenceOrder[2].jpegSha256,
      v4FaceHelperSourceSha256: edit.receipt.referenceOrder[3].sourceSha256,
      v4FaceHelperTransportSha256: edit.receipt.referenceOrder[3].jpegSha256,
      frozenFaceCropSourceSha256:
        edit.receipt.referenceOrder[4].sourceSha256,
      frozenFaceCropJpegSha256:
        edit.receipt.referenceOrder[4].jpegSha256,
      frozenFaceCropBox: edit.receipt.referenceOrder[4].crop,
      approvedFirstFrameUrl: url,
      approvedFirstFrameSha256: certificate.sourceSha256s[0],
      frameCertificateSha256: sceneCutRebindSha256(certificate),
      frameCertificate: certificate,
      imagePaymentExecutionId: sourceRow.id,
      approvedShotSha256: certificate.shotSha256,
      approvedScheduleHash: runs[11].output.scheduleHash,
      frameReviewExecutionId: certificate.reviewExecutionId,
      markerSha256: sha(canonical(state.sceneCutA8B6FreshFrameRecovery)) }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}
