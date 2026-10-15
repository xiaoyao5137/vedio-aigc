#!/usr/bin/env node
// Keep the saved workflow and its unpaid recovery checkpoint's visible
// explanation aligned with the reviewed branch behavior.
import assert from 'node:assert/strict'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE, STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT } from '../src/story-quality-workflow.ts'

const apply = process.argv.includes('--apply')
assert.ok(process.argv.length === 2 || process.argv.length === 3 && apply,
  'Usage: node scripts/sync-story-uncertain-review-prompt.mjs [--apply]')
const oldPrompt = '通过则进入拼接；有同镜实测未完成证据且未达上限，沿 false 回线重拍。证据不足或执行异常暂停复核原片。'
const childId = 'record-5xo1js-uncertain-pass-v1'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await client.connect()
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  const workflow = (await client.query(`SELECT nodes,md5(nodes::text) AS md5
    FROM workflow_configs WHERE id='wf-story'${apply ? ' FOR UPDATE' : ''}`)).rows[0]
  const child = (await client.query(`SELECT result,md5(result::text) AS md5
    FROM execution_records WHERE id=$1${apply ? ' FOR UPDATE' : ''}`, [childId])).rows[0]
  assert.ok(workflow && child)
  const nodeIndex = workflow.nodes.findIndex(node => node.id === 'node-video-review-result-branch')
  assert.ok(nodeIndex >= 0)
  const node = workflow.nodes[nodeIndex]
  const state = decodeExecutionState(child.result)
  const run = state.nodeRuns[9]
  assert.equal(node.code, STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE)
  assert.equal(run.node.code, STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE)
  assert.equal(run.status, 'idle')
  assert.ok([oldPrompt, STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT].includes(node.prompt))
  assert.ok([oldPrompt, STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT].includes(run.node.prompt))
  const nextState = { ...state, nodeRuns: state.nodeRuns.map((item, index) => index === 9
    ? { ...item, node: { ...item.node, prompt: STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT } } : item) }
  if (apply) {
    if (node.prompt !== STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT) {
      const result = await client.query(`UPDATE workflow_configs
        SET nodes=jsonb_set(nodes,$1::text[],to_jsonb($2::text)),updated_at=now()
        WHERE id='wf-story' AND md5(nodes::text)=$3`,
      [[String(nodeIndex), 'prompt'], STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT, workflow.md5])
      assert.equal(result.rowCount, 1)
    }
    if (run.node.prompt !== STORY_VIDEO_REVIEW_RESULT_BRANCH_PROMPT) {
      const result = await client.query(`UPDATE execution_records SET result=$2::jsonb
        WHERE id=$1 AND md5(result::text)=$3`,
      [childId, JSON.stringify(encodeExecutionState(nextState)), child.md5])
      assert.equal(result.rowCount, 1)
    }
  }
  await client.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, childId, workflowPromptUpdated: apply,
    childPromptUpdated: apply, sourceRecordUnchanged: true }))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
