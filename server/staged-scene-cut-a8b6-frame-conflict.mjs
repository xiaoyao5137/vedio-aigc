/** Signed, source-bound threshold adjudication. It never substitutes for node49. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'

const PLAN = 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'
const SOURCE = 'record-4x5m31-original-repair-tail-guide-v2'
const FAILED = 'record-4x5m31-a8b6-frame-reuse-v1'
const REJECTED = 'record-4x5m31-a8b6-frame-reuse-v3'
const REJECTED_MD5 = '01146ea0d4a7c0d6664f65d5eb9bc54e'
const IMAGE_SHA = '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
const SHA = /^[a-f0-9]{64}$/
const fail = message => { throw Error(`A8B6_FRAME_CONFLICT_INVALID: ${message}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

export function verifyA8B6FrameConflictReceiptSync(planId, root = process.cwd()) {
  if (planId !== PLAN) fail('QA plan changed')
  const filename = path.join(root, '.runtime/staged-scene-cut-a8b6-approval',
    planId, 'frame-conflict-adjudication.json')
  const bytes = readFileSync(filename)
  const receipt = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = receipt
  const key = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  const expected = createHmac('sha256', key).update(canonical(body)).digest('hex')
  if (key.length !== 32 || !SHA.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
    fail('conflict adjudication signature invalid')
  if (receipt.version !== 'a8b6-frame-conflict-adjudication-receipt-v1'
    || receipt.qaPlanId !== PLAN || receipt.sourceExecutionId !== SOURCE
    || receipt.firstRejectedExecutionId !== FAILED
    || receipt.rejectedExecutionId !== REJECTED
    || receipt.rejectedResultMd5 !== REJECTED_MD5
    || receipt.sourceImageSha256 !== IMAGE_SHA
    || receipt.sourceImageUrl !== '/generated/image-1d400ca2ab2b74b93fae1dd100d5aa1a.png'
    || !/^\/generated\/[\w.-]+\.jpg$/.test(String(receipt.sourceIdentityUrl))
    || !/^\/generated\/[\w.-]+\.jpg$/.test(String(receipt.comparisonUrl))
    || !SHA.test(String(receipt.sourceIdentitySha256))
    || !SHA.test(String(receipt.comparisonSha256))
    || !SHA.test(String(receipt.oldReviewSha256))
    || !SHA.test(String(receipt.firstRejectedReviewSha256))
    || !SHA.test(String(receipt.rejectedReviewSha256))
    || !SHA.test(String(receipt.modelPromptSha256))
    || !SHA.test(String(receipt.modelResponseSha256))
    || receipt.modelId !== 'codex-local-vision'
    || !/^model-run-[\w-]+$/.test(String(receipt.modelExecutionId))
    || !String(receipt.modelRequestKey).startsWith(`a8b6-frame-conflict:${PLAN}:`)
    || receipt.decision !== 'accept'
    || receipt.report?.version !== 'a8b6-frame-conflict-adjudication-v1'
    || receipt.report.decision !== 'accept'
    || receipt.report.priorConflictResolved !== true
    || receipt.report.outerHemStable !== true
    || receipt.report.innerHemDifferenceVisible !== true)
    fail('conflict adjudication source or accepted findings invalid')
  for (const [url, digest] of [
    [receipt.sourceImageUrl, receipt.sourceImageSha256],
    [receipt.sourceIdentityUrl, receipt.sourceIdentitySha256],
    [receipt.comparisonUrl, receipt.comparisonSha256],
  ]) {
    const local = path.join(root, 'public', url.slice(1))
    if (sha(readFileSync(local)) !== digest) fail('conflict source pixels changed')
  }
  return { receipt, receiptSha256: sha(bytes) }
}

/** Same-pixel review fork: original node48 report and managed node49 inputs
 * remain byte-for-byte inherited. The independent adjudication is provenance,
 * never a substitute for a fresh passing workflow review. */
export function assertA8B6ConflictReviewHop(parent, child, parentMd5,
  signedReceipt, phase = 'pending') {
  const prior = parent?.nodeRuns, next = child?.nodeRuns
  const marker = child?.sceneCutA8B6ConflictReviewRecovery
  if (!['pending', 'running', 'completed'].includes(phase)) fail('review phase invalid')
  const approvalStatus = phase === 'completed' ? 'success' : phase
  if (parent?.id !== REJECTED || parentMd5 !== REJECTED_MD5
    || !Array.isArray(prior) || !Array.isArray(next)
    || prior.length !== 464 || next.length !== 464
    || child.id !== 'record-4x5m31-a8b6-frame-conflict-review-v1'
    || child.parentExecutionId !== parent.id
    || child.generationScopeId !== child.id
    || child.requestScopeId !== parent.requestScopeId
    || child.workflowId !== parent.workflowId
    || !isDeepStrictEqual(child.sceneCutA8B6ImageReuseRecovery,
      parent.sceneCutA8B6ImageReuseRecovery)
    || marker?.version !== 'scene-cut-a8b6-conflict-review-retry-v1'
    || marker.sourceExecutionId !== parent.id
    || marker.sourceResultMd5 !== parentMd5
    || marker.qaPlanId !== PLAN
    || marker.adjudicationReceiptSha256 !== signedReceipt.receiptSha256
    || marker.adjudicationModelExecutionId !== signedReceipt.receipt.modelExecutionId
    || marker.rejectedReviewSha256 !== signedReceipt.receipt.rejectedReviewSha256
    || marker.preservedPrefixLength !== 49
    || marker.preservedPrefixSha256 !== sha(canonical(prior.slice(0, 49)))
    || marker.firstPendingIndex !== 49
    || marker.firstPendingNodeId !== 'sanguo-scene-cut-review'
    || !isDeepStrictEqual(next.slice(0, 49), prior.slice(0, 49))
    || !isDeepStrictEqual(next[49].node, prior[49].node)
    || prior[49]?.status !== 'success' || prior[49].output?.passed !== false
    || prior[49].output?.issues?.length !== 1
    || prior[49].output.issues[0]?.code !== 'wardrobe_hem_proportion_mismatch'
    || prior[50]?.status !== 'idle'
    || next[49]?.status !== (phase === 'pending' ? 'idle' : 'success')
    || next[50]?.status !== (phase === 'pending' ? 'idle' : approvalStatus)
    || next.slice(51).some(run => run.status !== 'idle'))
    fail('same-pixel review fork altered its paid/evidence prefix or source lineage')
  if (phase !== 'pending' && (next[49].output?.passed !== true
    || !isDeepStrictEqual(next[49].output?.issues, [])))
    fail('same-pixel workflow re-review is not independently passing')
  return true
}

export async function verifyA8B6FrameConflictReceipt(planId, root = process.cwd()) {
  const verified = verifyA8B6FrameConflictReceiptSync(planId, root)
  const { receipt } = verified
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const records = (await db.query(`SELECT id,result,md5(result::text) AS result_md5
      FROM execution_records WHERE id = ANY($1)`, [[SOURCE, FAILED, REJECTED]])).rows
    const byId = new Map(records.map(row => [row.id, row]))
    const old = byId.get(SOURCE), first = byId.get(FAILED), latest = byId.get(REJECTED)
    if (!old || !first || latest?.result_md5 !== REJECTED_MD5)
      fail('recorded conflicting reviews changed')
    const oldRuns = decodeExecutionState(old.result).nodeRuns
    const firstRuns = decodeExecutionState(first.result).nodeRuns
    const latestRuns = decodeExecutionState(latest.result).nodeRuns
    if (sha(canonical(oldRuns[49].output)) !== receipt.oldReviewSha256
      || sha(canonical(firstRuns[49].output)) !== receipt.firstRejectedReviewSha256
      || sha(canonical(latestRuns[49].output)) !== receipt.rejectedReviewSha256
      || oldRuns[49].output?.passed !== true
      || firstRuns[49].output?.passed !== false
      || latestRuns[49].output?.passed !== false
      || oldRuns[45].output?.url !== receipt.sourceImageUrl
      || latestRuns[45].output?.url !== receipt.sourceImageUrl)
      fail('conflicting reviews are not the exact saved source')
    const row = (await db.query(`SELECT * FROM model_execution_records WHERE id=$1`,
      [receipt.modelExecutionId])).rows[0]
    const request = row?.request_data, response = row?.response_data
    const parsed = row && parseStructuredJson(extractTextResponse(response))
    if (row?.status !== 'succeeded' || row.model_id !== receipt.modelId
      || row.provider === 'Local' || row.node_id !== 'a8b6-frame-conflict-adjudication'
      || request?.requestKey !== receipt.modelRequestKey
      || sha(request.prompt) !== receipt.modelPromptSha256
      || sha(canonical(response)) !== receipt.modelResponseSha256
      || canonical(parsed) !== canonical(receipt.report)
      || !Array.isArray(request.reviewImageHashes)
      || request.reviewImageHashes.length !== 3
      || request.reviewImageHashes[1]?.url !== receipt.sourceIdentityUrl
      || request.reviewImageHashes[1]?.sha256 !== receipt.sourceIdentitySha256
      || request.reviewImageHashes[2]?.url !== receipt.comparisonUrl
      || request.reviewImageHashes[2]?.sha256 !== receipt.comparisonSha256)
      fail('conflict receipt does not match actual successful image model ledger')
    await db.query('COMMIT')
    return verified
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}
