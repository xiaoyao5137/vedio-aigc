#!/usr/bin/env node
// Continue an independently reviewed two-shot preview after a held first shot.
// This fork never marks the held shot accepted and never enters either concat.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const [sourceId, childId, mode = '--dry-run'] = process.argv.slice(2)
assert.match(sourceId ?? '', /^record-[\w-]+$/)
assert.match(childId ?? '', /^record-[\w-]+$/)
assert.notEqual(sourceId, childId)
assert.ok(['--dry-run', '--apply'].includes(mode))
const hash = createJsonHasher()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(mode === '--apply' ? 'BEGIN' : 'BEGIN READ ONLY')
  const source = (await db.query(`SELECT *,md5(result::text) AS md5 FROM execution_records WHERE id=$1${mode === '--apply' ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
  const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'${mode === '--apply' ? ' FOR SHARE' : ''}`)).rows[0]
  assert.equal(source?.workflow_id, 'wf-story')
  assert.equal(workflow?.schema_version, 7)
  assert.equal((await db.query('SELECT 1 FROM execution_records WHERE id=$1', [childId])).rowCount, 0)
  const prior = decodeExecutionState(source.result), runs = prior.nodeRuns
  assert.equal(prior.id, sourceId)
  assert.equal(runs.length, 16)
  assert.deepEqual(runs.map(r => r.node.id), ['node-input', 'node-model-images', 'node-script',
    'node-script-review', 'node-script-review-result-branch', 'node-loop',
    ...Array.from({ length: 2 }, () => ['node-image', 'node-video', 'node-video-review',
      'node-video-review-result-branch', 'node-video-concat']).flat()])
  assert.ok(runs.slice(0, 9).every(r => r.status === 'success'))
  assert.ok(runs.slice(9).every(r => r.status === 'idle'))
  assert.equal(runs[3].output?.shots?.length, 2)
  assert.equal(runs[8].output?.storyMediaReview?.passed, false)
  assert.ok(['uncertain', 'incomplete', 'technical-failure', 'unavailable', 'invalid'].includes(runs[8].output.storyMediaReview.reviewStatus))
  assert.equal(runs[8].output.storyMediaReview.videoEvidence?.decoded, true)
  assert.equal(runs[8].loopIndex, 0)
  assert.equal(runs[11].loopIndex, 1)
  assert.equal(runs[8].loopGroupId, runs[11].loopGroupId)
  const firstVideo = runs[8].output.storyMediaReview.videoEvidence
  const localVideo = path.join('public', firstVideo.url.slice(1))
  assert.match(firstVideo.url, /^\/generated\/[\w.-]+\.mp4$/)
  assert.equal(sha(await readFile(localVideo)), firstVideo.sha256)
  assert.match(runs[6].output?.url ?? '', /^\/generated\/[\w.-]+\.png$/)
  const next = structuredClone(runs)
  const previewOnly = { skipped: true, reason: 'independent-two-shot-preview',
    firstShotReviewStatus: runs[8].output.storyMediaReview.reviewStatus,
    accepted: false, concatAllowed: false }
  for (const index of [9, 10, 14, 15]) {
    next[index] = { ...next[index], status: 'skipped', output: previewOnly,
      context: index < 11 ? { ...runs[8].context } : {}, durationMs: 0,
      revision: (next[index].revision ?? 0) + 1 }
  }
  const prepared = prepareWorkflowRunContext(next, 11)
  assert.equal(prepared.inputContext.shot?.title, runs[3].output.shots[1].title)
  assert.equal(prepared.inputContext.loop?.zeroIndex, 1)
  assert.ok(Array.isArray(prepared.inputContext.model_images?.items))
  assert.equal(prepared.inputContext.model_images.items.length, runs[1].output.items.length)
  const provenance = { version: 'story-independent-two-shot-preview-v1', sourceExecutionId: sourceId,
    sourceResultMd5: source.md5, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, firstVideoSha256: firstVideo.sha256,
    firstReviewStatus: runs[8].output.storyMediaReview.reviewStatus,
    firstReviewPreserved: true, firstConcatSkipped: true, secondConcatSkipped: true,
    secondReviewRequired: true, humanAccepted: false, providerCallsOnFork: 0 }
  const state = { ...structuredClone(prior), id: childId, parentExecutionId: sourceId,
    requestScopeId: prior.requestScopeId ?? sourceId, generationScopeId: childId,
    historical: false, mode: 'step', nodeRuns: next, context: prepared.inputContext,
    selectedNodeId: 'node-image', storyIndependentPreview: provenance,
    logs: [...(prior.logs ?? []), '首镜审核未通过；仅继续生成第二镜预览，两镜拼接均跳过，原素材和审核结论保留。'] }
  assert.equal(hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state))))), hash(state))
  if (mode === '--apply') {
    await db.query(`INSERT INTO execution_records (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [childId, source.workflow_id,
      source.workflow_name, `打工猫两镜独立预览 · ${sourceId}`, JSON.stringify(source.runtime_inputs ?? {}),
      JSON.stringify(encodeExecutionState(state)), 9, 16])
    assert.equal(hash(decodeExecutionState((await db.query('SELECT result FROM execution_records WHERE id=$1', [childId])).rows[0].result)), hash(state))
  }
  assert.equal((await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [sourceId])).rows[0].md5, source.md5)
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: mode === '--apply', childId, firstPendingIndex: 11,
    firstPendingNodeId: 'node-image', firstVideoUrl: firstVideo.url, ...provenance }, null, 2))
} catch (error) { await db.query('ROLLBACK'); throw error } finally { await db.end() }
