#!/usr/bin/env node
// Update the saved decision code and create a no-request checkpoint for one
// uncertain review. The original record and paid media remain untouched.
import assert from 'node:assert/strict'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE } from '../src/story-quality-workflow.ts'

const sourceId = 'record-5xo1js'
const childId = 'record-5xo1js-uncertain-pass-v1'
const branchId = 'node-video-review-result-branch'
const reviewId = 'node-video-review'
const apply = process.argv.includes('--apply')
assert.ok(process.argv.length === 2 || process.argv.length === 3 && apply,
  'Usage: node scripts/recover-story-uncertain-review.mjs [--apply]')

const added = STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE.slice(
  STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE.indexOf('// Uncertain observations are advisory:'),
  STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE.indexOf('if (report.passed) {'))
assert.ok(added.startsWith('// Uncertain observations are advisory:'))
const previousCode = STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE.replace(added, '')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await client.query(`SELECT schema_version,nodes,md5(nodes::text) AS nodes_md5,
    md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'${apply ? ' FOR UPDATE' : ''}`)).rows[0]
  const source = (await client.query(`SELECT *,md5(result::text) AS result_md5
    FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
  assert.equal(workflow?.schema_version, 7)
  assert.ok(source)
  const branchNodeIndex = workflow.nodes.findIndex(node => node.id === branchId)
  assert.ok(branchNodeIndex >= 0)
  assert.ok([previousCode, STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE].includes(workflow.nodes[branchNodeIndex].code),
    'saved branch code differs from the reviewed change')
  const sourceState = decodeExecutionState(source.result)
  assert.equal(sourceState.id, sourceId)
  const reviewIndex = sourceState.nodeRuns.findIndex(run => run.node.id === reviewId && run.loopIndex === 0)
  const branchIndex = sourceState.nodeRuns.findIndex(run => run.node.id === branchId && run.loopIndex === 0)
  assert.equal(branchIndex, reviewIndex + 1)
  const review = sourceState.nodeRuns[reviewIndex]
  const branch = sourceState.nodeRuns[branchIndex]
  assert.equal(review.status, 'success')
  assert.equal(review.output.storyMediaReview.reviewStatus, 'uncertain')
  assert.equal(branch.status, 'failed')
  assert.match(branch.error, /STORY_MEDIA_REVIEW_REQUIRED: uncertain/)
  assert.ok(sourceState.nodeRuns.slice(branchIndex + 1).every(run => run.status === 'idle'))
  assert.equal(branch.node.code, previousCode)
  const decide = new Function('params', 'branch', STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE)
  const video = sourceState.nodeRuns[reviewIndex - 1]
  assert.equal(decide({ report: review.output, shot: branch.loopItem, video: video.output,
    maxAttempts: 2 }, { counts: { false: 0 } }), true)

  const runs = manualRetryRuns(sourceState.nodeRuns, branchIndex)
  runs[branchIndex] = { ...runs[branchIndex], node: {
    ...runs[branchIndex].node, code: STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE } }
  const state = { ...sourceState, id: childId, parentExecutionId: sourceId,
    requestScopeId: sourceState.requestScopeId ?? sourceId, generationScopeId: childId,
    mode: 'step', historical: false, selectedNodeId: branchId,
    nodeRuns: runs, context: review.context,
    logs: [...sourceState.logs, `从 ${sourceId} 的第 1 轮待复核结果创建放行检查点；原质检疑点、原片及付费前缀保留，等待显式继续。`] }
  assert.ok(runs.slice(0, branchIndex).every((run, index) =>
    JSON.stringify(run) === JSON.stringify(sourceState.nodeRuns[index])))
  assert.equal(runs[branchIndex].status, 'idle')
  assert.ok(runs.slice(branchIndex + 1).every(run => run.status === 'idle'))
  const encoded = encodeExecutionState(state)
  assert.ok(JSON.stringify(decodeExecutionState(JSON.parse(JSON.stringify(encoded))))
    === JSON.stringify(state), 'storage round trip changed the checkpoint')
  if (apply) {
    if (workflow.nodes[branchNodeIndex].code !== STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE) {
      const updated = await client.query(`UPDATE workflow_configs
        SET nodes=jsonb_set(nodes,$1::text[],to_jsonb($2::text)),updated_at=now()
        WHERE id='wf-story' AND md5(nodes::text)=$3`,
      [[String(branchNodeIndex), 'code'], STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE, workflow.nodes_md5])
      assert.equal(updated.rowCount, 1)
    }
    assert.equal((await client.query('SELECT 1 FROM execution_records WHERE id=$1', [childId])).rowCount, 0)
    await client.query(`INSERT INTO execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
      childId, source.workflow_id, source.workflow_name, `待复核放行检查点 · ${sourceId}`,
      JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
      runs.filter(run => run.status === 'success').length, runs.length,
    ])
  }
  const afterWorkflow = (await client.query(`SELECT nodes,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-story'`)).rows[0]
  const sourceAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
    [sourceId])).rows[0]
  assert.equal(sourceAfter.md5, source.result_md5)
  assert.equal(afterWorkflow.edges_md5, workflow.edges_md5)
  if (apply) assert.equal(afterWorkflow.nodes[branchNodeIndex].code, STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE)
  await client.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, sourceId, childId, sourceUnchanged: true,
    paidPrefixRunCount: branchIndex, firstPendingIndex: branchIndex,
    savedWorkflowUpdated: apply, modelCalls: 0 }))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
