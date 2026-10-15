#!/usr/bin/env node
// Bind the recovered record to its original node definitions. The current
// workflow has since changed prompts, so its paid prefix cannot be resumed
// against current definitions without an explicit source snapshot.
import assert from 'node:assert/strict'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { hasExecutionPlanMismatch } from '../src/workflow-core.ts'
import { STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE, STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT } from '../src/story-quality-workflow.ts'

const apply = process.argv.includes('--apply')
assert.ok(process.argv.length === 2 || process.argv.length === 3 && apply,
  'Usage: node scripts/attach-story-review-workflow-snapshot.mjs [--apply]')
const childId = 'record-5xo1js-uncertain-pass-v1'
const branchId = 'node-video-review-result-branch'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await client.query("SELECT * FROM workflow_configs WHERE id='wf-story'")).rows[0]
  const child = (await client.query(`SELECT result,md5(result::text) AS md5 FROM execution_records
    WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [childId])).rows[0]
  assert.ok(workflow && child)
  const state = decodeExecutionState(child.result)
  assert.equal(state.id, childId)
  assert.equal(state.nodeRuns[9].status, 'idle')
  assert.equal(state.nodeRuns[8].output.storyMediaReview.reviewStatus, 'uncertain')
  assert.ok(state.nodeRuns.slice(0, 9).every(run => run.status === 'success'))
  assert.ok(state.nodeRuns.slice(9).every(run => run.status === 'idle'))
  const branchRuns = state.nodeRuns.filter(run => run.node.id === branchId)
  assert.equal(branchRuns.length, 2)
  const runs = state.nodeRuns.map(run => run.node.id === branchId
    ? { ...run, node: { ...run.node, code: STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE,
      prompt: STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT } } : run)
  const firstById = new Map()
  for (const run of runs) if (!firstById.has(run.node.id)) firstById.set(run.node.id, run.node)
  assert.equal(firstById.size, workflow.nodes.length)
  assert.ok(workflow.nodes.every(node => firstById.has(node.id)))
  const snapshot = { id: workflow.id, name: workflow.name, description: workflow.description,
    schemaVersion: workflow.schema_version, voicePolicy: workflow.voice_policy,
    nodes: workflow.nodes.map(node => firstById.get(node.id)), edges: workflow.edges }
  assert.equal(hasExecutionPlanMismatch(snapshot, runs), false)
  const next = { ...state, nodeRuns: runs, executionWorkflowSnapshot: snapshot }
  assert.equal(JSON.stringify(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(next))))),
    JSON.stringify(next))
  if (apply) {
    const updated = await client.query(`UPDATE execution_records SET result=$2::jsonb
      WHERE id=$1 AND md5(result::text)=$3`,
    [childId, JSON.stringify(encodeExecutionState(next)), child.md5])
    assert.equal(updated.rowCount, 1)
  }
  await client.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, childId, snapshotNodes: snapshot.nodes.length,
    sourceVersionBound: true, originalRecordUnchanged: true, modelCalls: 0 }))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
