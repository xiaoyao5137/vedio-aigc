#!/usr/bin/env node
// Add the branch decision as a timeline input and recover the failed local concat.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { requireConcatCurrentAcceptance } from '../server/video-concat-acceptance.ts'

const recordId = 'record-onxgw6-review-retry'
const workflowId = 'wf-workplace-second-trial-v1'
const timelineId = 'node-timeline-compose'
const timelineIndex = 23
const expectedSha = '0889f3f37d97cf74a6f1a18942b1758c73794ce801bb5e63ddaa2e20266777a7'
const decisionParam = { id: 'cat-timeline-decision', name: '本轮质检路由', englishName: 'reviewDecision',
  type: 'json', required: true, value: '${video_review_decision}' }
const apply = process.argv.length === 3 && process.argv[2] === '--apply'
assert.ok(process.argv.length === 2 || apply, 'Usage: node scripts/recover-onxgw6-concat-risk.mjs [--apply]')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await db.query(`SELECT nodes,md5(nodes::text) nodes_md5 FROM workflow_configs
    WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [workflowId])).rows[0]
  const row = (await db.query(`SELECT *,md5(result::text) result_md5 FROM execution_records
    WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [recordId])).rows[0]
  assert.ok(workflow && row && row.workflow_id === workflowId)
  const state = decodeExecutionState(row.result)
  const runs = state.nodeRuns
  assert.equal(runs.length, 42)
  assert.ok(runs.slice(0, timelineIndex).every(run => run.status === 'success'))
  assert.equal(runs[timelineIndex].node.id, timelineId)
  assert.equal(runs[timelineIndex].loopIndex, 2)
  assert.equal(runs[timelineIndex].status, 'failed')
  assert.match(runs[timelineIndex].error, /VIDEO_CONCAT_QUALITY_REQUIRED/)
  assert.ok(runs.slice(timelineIndex + 1).every(run => run.status === 'idle'))
  const decision = runs[21].output
  const review = runs[20].output
  assert.equal(decision.value, true)
  assert.equal(decision.passed, true)
  assert.equal(decision.riskReminder.sourceVideoSha256, expectedSha)
  assert.equal(requireConcatCurrentAcceptance(review, workflowId, decision).sourceSha256, expectedSha)
  const workflowIndex = workflow.nodes.findIndex(node => node.id === timelineId)
  assert.ok(workflowIndex >= 0)
  const savedTimeline = workflow.nodes[workflowIndex]
  assert.deepEqual(savedTimeline.params.map(param => param.englishName),
    ['previousVideo', 'currentVideo', 'format', 'aspectRatio', 'resolution'])
  assert.deepEqual(runs[timelineIndex].node.params, savedTimeline.params)
  const timeline = { ...savedTimeline, params: [
    ...savedTimeline.params.slice(0, 2), decisionParam, ...savedTimeline.params.slice(2),
  ] }
  const nextRuns = manualRetryRuns(runs, timelineIndex)
  for (let i = timelineIndex; i < nextRuns.length; i++) {
    if (nextRuns[i].node.id === timelineId) nextRuns[i] = { ...nextRuns[i], node: {
      ...nextRuns[i].node, params: timeline.params } }
  }
  const next = { ...state, nodeRuns: nextRuns, logs: [...state.logs,
    '第 3 镜结果分支已风险放行；时间线合成现读取同源 reviewDecision.riskReminder，恢复本地合成检查点。'] }
  assert.deepEqual(nextRuns.slice(0, timelineIndex), runs.slice(0, timelineIndex))
  assert.equal(nextRuns[timelineIndex].status, 'idle')
  assert.ok(nextRuns.slice(timelineIndex + 1).every(run => run.status === 'idle'))
  const encoded = encodeExecutionState(next)
  assert.equal(decodeExecutionState(JSON.parse(JSON.stringify(encoded))).nodeRuns[21].output.riskReminder.sourceVideoSha256,
    expectedSha)
  if (apply) {
    await writeFile(new URL(`../.runtime/onxgw6-concat-risk-before-${row.result_md5}.json.gz`, import.meta.url),
      gzipSync(JSON.stringify({ workflow, row })), { flag: 'wx', mode: 0o600 })
    const nodes = workflow.nodes.map((node, index) => index === workflowIndex ? timeline : node)
    assert.equal((await db.query(`UPDATE workflow_configs SET nodes=$2::jsonb,updated_at=now()
      WHERE id=$1 AND md5(nodes::text)=$3`, [workflowId, JSON.stringify(nodes), workflow.nodes_md5])).rowCount, 1)
    assert.equal((await db.query(`UPDATE execution_records SET result=$2::jsonb,
      succeeded_count=$3,failed_count=0,total_count=$4 WHERE id=$1 AND md5(result::text)=$5`,
    [recordId, JSON.stringify(encoded), timelineIndex, runs.length, row.result_md5])).rowCount, 1)
    const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [recordId])).rows[0]
    assert.equal(decodeExecutionState(saved.result).nodeRuns[timelineIndex].status, 'idle')
  }
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, recordId, sourceMd5: row.result_md5,
    firstPendingIndex: timelineIndex, originalVideoSha256: expectedSha, modelCalls: 0, videoCalls: 0 }, null, 2))
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  await db.end()
}
