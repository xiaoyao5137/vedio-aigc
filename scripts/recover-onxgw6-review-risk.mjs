#!/usr/bin/env node
// Recover this saved review branch after a reviewer transport failure.
// Dry-run by default; --apply changes only the saved workflow branch and this record.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_CODE as branchCode,
  STORY_VISUAL_ONLY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT as branchPrompt } from '../src/story-quality-workflow.ts'

const recordId = 'record-onxgw6-review-retry'
const workflowId = 'wf-workplace-second-trial-v1'
const branchId = 'node-video-review-result-branch'
const branchIndex = 21
const expectedVideoSha = '0889f3f37d97cf74a6f1a18942b1758c73794ce801bb5e63ddaa2e20266777a7'
const apply = process.argv.length === 3 && process.argv[2] === '--apply'
assert.ok(process.argv.length === 2 || apply, 'Usage: node scripts/recover-onxgw6-review-risk.mjs [--apply]')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await db.query(`SELECT nodes,edges,md5(nodes::text) nodes_md5,
    md5(edges::text) edges_md5 FROM workflow_configs WHERE id=$1${apply ? ' FOR UPDATE' : ''}`,
  [workflowId])).rows[0]
  const row = (await db.query(`SELECT *,md5(result::text) result_md5 FROM execution_records
    WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [recordId])).rows[0]
  assert.ok(workflow && row && row.workflow_id === workflowId, 'saved workflow or execution missing')
  const state = decodeExecutionState(row.result)
  const runs = state.nodeRuns
  assert.equal(state.id, recordId)
  assert.equal(runs.length, 42)
  assert.ok(runs.slice(0, branchIndex).every(run => run.status === 'success'))
  assert.equal(runs[branchIndex].node.id, branchId)
  assert.equal(runs[branchIndex].loopIndex, 2)
  assert.equal(runs[branchIndex].status, 'failed')
  assert.match(runs[branchIndex].error, /STORY_MEDIA_REVIEW_REQUIRED: unavailable/)
  assert.ok(runs.slice(branchIndex + 1).every(run => run.status === 'idle'))
  const review = runs[20].output
  const evidence = review.videoEvidence
  const video = runs[19].output
  assert.equal(review.storyMediaReview.reviewStatus, 'unavailable')
  assert.equal(review.storyMediaReview.retryable, false)
  assert.equal(review.storyMediaReview.assessment, null)
  assert.equal(review.storyMediaReview.observations, null)
  assert.equal(evidence.technicalValidation.passed, true)
  assert.equal(evidence.sha256, expectedVideoSha)
  assert.equal(evidence.originalUrl, video.url)
  assert.equal(review.storyMediaReview.videoUrl, video.url)
  assert.equal(review.storyMediaReview.videoEvidence.sha256, expectedVideoSha)
  const mediaFile = new URL(`../public${evidence.url}`, import.meta.url)
  assert.equal(createHash('sha256').update(await readFile(mediaFile)).digest('hex'), expectedVideoSha)
  const workflowBranchIndex = workflow.nodes.findIndex(node => node.id === branchId)
  assert.ok(workflowBranchIndex >= 0)
  const savedBranch = workflow.nodes[workflowBranchIndex]
  assert.equal(savedBranch.code, runs[branchIndex].node.code)
  assert.ok(savedBranch.code.includes("reviewHoldStatus: 'invalid'"), 'old branch contract changed')
  assert.deepEqual(workflow.edges.filter(edge => edge.from === branchId && edge.branch === 'false')
    .map(edge => edge.to), ['node-video'])
  const decision = new Function('params', 'branch', branchCode)({
    report: review, shot: runs[branchIndex].loopItem, video, maxAttempts: 2,
  }, { counts: { false: 0 } })
  assert.equal(decision.value, true)
  assert.equal(decision.riskReminder.sourceVideoSha256, expectedVideoSha)
  assert.equal(decision.riskReminder.reviewStatus, 'unavailable')
  assert.equal(decision.manualDecisionRequired, undefined)
  const nextRuns = manualRetryRuns(runs, branchIndex)
  nextRuns[branchIndex] = { ...nextRuns[branchIndex], node: {
    ...nextRuns[branchIndex].node, code: branchCode, prompt: branchPrompt } }
  for (let i = branchIndex + 1; i < nextRuns.length; i++) {
    if (nextRuns[i].node.id === branchId) nextRuns[i] = { ...nextRuns[i], node: {
      ...nextRuns[i].node, code: branchCode, prompt: branchPrompt } }
  }
  const next = { ...state, nodeRuns: nextRuns,
    logs: [...state.logs, `第 3 镜质检 CLI 超时；同源原片 ${expectedVideoSha} 技术校验通过，无确证缺陷。重试结果分支按通过连线并输出 riskReminder，原质检报告与付费前缀保留。`] }
  assert.deepEqual(nextRuns.slice(0, branchIndex), runs.slice(0, branchIndex))
  assert.equal(nextRuns[branchIndex].status, 'idle')
  assert.ok(nextRuns.slice(branchIndex + 1).every(run => run.status === 'idle'))
  const encoded = encodeExecutionState(next)
  assert.equal(decodeExecutionState(JSON.parse(JSON.stringify(encoded))).nodeRuns[20].output.videoEvidence.sha256,
    expectedVideoSha)
  if (apply) {
    const backup = new URL('../.runtime/onxgw6-review-risk-before.json.gz', import.meta.url)
    await writeFile(backup, gzipSync(JSON.stringify({ workflow, row })), { flag: 'wx', mode: 0o600 })
    const nodes = workflow.nodes.map((node, index) => index === workflowBranchIndex
      ? { ...node, code: branchCode, prompt: branchPrompt } : node)
    const updatedWorkflow = await db.query(`UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now()
      WHERE id=$1 AND md5(nodes::text)=$3`, [workflowId, JSON.stringify(nodes), workflow.nodes_md5])
    assert.equal(updatedWorkflow.rowCount, 1)
    const updatedRecord = await db.query(`UPDATE execution_records SET result=$2::jsonb,
      succeeded_count=$3,failed_count=0,total_count=$4 WHERE id=$1 AND md5(result::text)=$5`,
    [recordId, JSON.stringify(encoded), nextRuns.filter(run => run.status === 'success').length,
      nextRuns.length, row.result_md5])
    assert.equal(updatedRecord.rowCount, 1)
    const verified = (await db.query(`SELECT result FROM execution_records WHERE id=$1`, [recordId])).rows[0]
    assert.equal(decodeExecutionState(verified.result).nodeRuns[branchIndex].status, 'idle')
  }
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, recordId, sourceMd5: row.result_md5,
    firstPendingIndex: branchIndex, riskReminder: decision.riskReminder, modelCalls: 0,
    videoCalls: 0, originalVideoSha256: expectedVideoSha }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  await db.end()
}
