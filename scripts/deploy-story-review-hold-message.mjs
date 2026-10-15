#!/usr/bin/env node
// Narrow CAS migration: update only the saved story branch's review-hold text.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE } from '../src/story-quality-workflow.ts'

const previous = `if (review.reviewStatus !== 'incomplete' || review.retryable !== true
  || !Array.isArray(review.issues) || !review.issues.length) {
  throw Error('STORY_MEDIA_REVIEW_REQUIRED: 当前结果为证据不足、无效或技术失败；请对同一素材复核，不能自动付费重拍');
}`
const replacement = `if (review.reviewStatus !== 'incomplete' || review.retryable !== true
  || !Array.isArray(review.issues) || !review.issues.length) {
  const status = safe(review.reviewStatus || 'unknown');
  const issues = Array.isArray(review.issues) ? review.issues.filter(nonempty).slice(0, 2).map(safe).join('；') : '';
  throw Error('STORY_MEDIA_REVIEW_REQUIRED: ' + status + '；' + (issues || '缺少可核验的通过或重拍证据')
    + '；请复核同一素材，不能自动付费重拍或拼接');
}`
assert.equal(STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE.includes(replacement), true)
const expectedOld = STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE.replace(replacement, previous)
const sha = value => createHash('sha256').update(value).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('BEGIN')
  const row = (await db.query(`SELECT schema_version,nodes,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-story' FOR UPDATE`)).rows[0]
  assert.equal(row?.schema_version, 7)
  const index = row.nodes.findIndex(node => node.id === 'node-video-review-result-branch')
  assert.ok(index >= 0)
  const oldCode = row.nodes[index].code
  if (oldCode !== STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE) {
    assert.equal(oldCode, expectedOld, 'Saved branch has changes beyond this migration')
    const updated = await db.query(`UPDATE workflow_configs
      SET nodes=jsonb_set(nodes,$1::text[],to_jsonb($2::text))
      WHERE id='wf-story' AND md5(nodes::text)=$3`, [[String(index), 'code'], STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE, row.nodes_md5])
    assert.equal(updated.rowCount, 1)
  }
  const after = (await db.query(`SELECT schema_version,nodes,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5
    FROM workflow_configs WHERE id='wf-story'`)).rows[0]
  assert.equal(after.schema_version, row.schema_version)
  assert.equal(after.edges_md5, row.edges_md5)
  assert.equal(after.nodes[index].code, STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE)
  const withoutCode = nodes => nodes.map((node, at) => at === index ? { ...node, code: null } : node)
  assert.deepEqual(withoutCode(after.nodes), withoutCode(row.nodes))
  await db.query('COMMIT')
  console.log(JSON.stringify({ workflowId: 'wf-story', schemaVersion: row.schema_version,
    changed: oldCode !== STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE, oldCodeSha256: sha(oldCode),
    newCodeSha256: sha(STORY_VIDEO_REVIEW_RESULT_BRANCH_CODE), oldNodesMd5: row.nodes_md5,
    newNodesMd5: after.nodes_md5, edgesUnchanged: true }, null, 2))
} catch (error) { await db.query('ROLLBACK'); throw error }
finally { await db.end() }
