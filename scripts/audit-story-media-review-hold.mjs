#!/usr/bin/env node
// Replay a saved story review hold without a provider call or record mutation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { executeCodeNode } from '../server/code-node.ts'
import { collectStoryVocalEvidence } from '../server/story-vocal-evidence.ts'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE } from '../src/story-quality-workflow.ts'

const [recordId, outputFile] = process.argv.slice(2)
if (!/^record-[\w-]+$/.test(recordId ?? '') || !outputFile) {
  throw Error('Usage: node scripts/audit-story-media-review-hold.mjs record-ID OUTPUT.json')
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const row = (await db.query('SELECT id,workflow_id,result,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [recordId])).rows[0]
  assert.equal(row?.workflow_id, 'wf-story')
  const state = decodeExecutionState(row.result)
  const branchIndex = state.nodeRuns.findIndex(run => run.node?.id === 'node-video-review-result-branch' && run.status === 'failed')
  assert.ok(branchIndex > 0, 'Expected a failed story review branch')
  const branch = state.nodeRuns[branchIndex]
  const review = state.nodeRuns[branchIndex - 1]
  assert.equal(review.node.id, 'node-video-review')
  assert.equal(review.status, 'success')
  assert.equal(review.loopGroupId, branch.loopGroupId)
  assert.equal(review.loopIndex, branch.loopIndex)
  const report = review.output
  const evidence = report.storyMediaReview.videoEvidence
  assert.equal(report.storyMediaReview.reviewStatus, 'uncertain')
  assert.equal(report.storyMediaReview.retryable, false)
  assert.equal(evidence.decoded, true)
  assert.match(evidence.url, /^\/generated\/[\w.-]+\.mp4$/)
  const videoBytes = await readFile(path.join('public', evidence.url.slice(1)))
  assert.equal(createHash('sha256').update(videoBytes).digest('hex'), evidence.sha256)
  assert.equal(branch.inputs.report.videoEvidence.sha256, evidence.sha256)
  const vocal = await collectStoryVocalEvidence({ url: evidence.url, sha256: evidence.sha256,
    duration: evidence.duration }, review.inputs.shot.vocalBeats)
  let replayError = ''
  try {
    await executeCodeNode({ code: STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE,
      params: branch.inputs, context: { branch: { visits: 0, counts: { true: 0, false: 0 } } } })
  } catch (error) { replayError = error instanceof Error ? error.message : String(error) }
  assert.match(replayError, /STORY_MEDIA_REVIEW_REQUIRED: uncertain/)
  assert.match(replayError, /不能自动付费重拍或拼接/)
  const after = (await db.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [recordId])).rows[0]
  assert.equal(after.result_md5, row.result_md5)
  const audit = {
    version: 'story-media-review-hold-audit-v1', recordId, sourceResultMd5: row.result_md5,
    sourceUnchanged: true, providerCalls: 0, failedBranchRunId: branch.id,
    reviewRunId: review.id, loopIndex: branch.loopIndex, reviewStatus: report.storyMediaReview.reviewStatus,
    retryable: report.storyMediaReview.retryable, issues: report.storyMediaReview.issues,
    beatChecks: report.storyMediaReview.beatChecks,
    endingHold: report.storyMediaReview.endingHold,
    archivedVideo: { url: evidence.url, sha256: evidence.sha256, duration: evidence.duration,
      decoded: evidence.decoded, evidenceUrl: evidence.evidenceUrl },
    vocalEvidence: vocal, sourceReviewHasVocalEvidence: Boolean(report.storyMediaReview.vocalEvidence),
    replayError, downstreamVideoRunsStillIdle: state.nodeRuns.slice(branchIndex + 1)
      .filter(run => run.node.kind === 'video').every(run => run.status === 'idle'),
  }
  await mkdir(path.dirname(outputFile), { recursive: true })
  await writeFile(outputFile, JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ outputFile, recordId, sourceUnchanged: true, providerCalls: 0,
    reviewStatus: audit.reviewStatus, vocalAcousticStatus: vocal.acousticStatus,
    sourceReviewHasVocalEvidence: audit.sourceReviewHasVocalEvidence }, null, 2))
} finally { await db.end() }
