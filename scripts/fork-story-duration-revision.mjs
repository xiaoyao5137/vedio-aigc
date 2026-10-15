#!/usr/bin/env node
// Fork a failed first-shot review into a source-bound 15-second video checkpoint.
// Preparation makes no provider request; --apply inserts one new idle record.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { buildKlingVideoRequest, prepareKlingImageInputs } from '../server/model-adapters.ts'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { renderStoryShotTimedActions, createStoryScriptSource, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { hasExecutionPlanMismatch, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const [sourceId, childId, mode = '--dry-run'] = process.argv.slice(2)
if (!/^record-[\w-]+$/.test(sourceId ?? '') || !/^record-[\w-]+$/.test(childId ?? '')
  || sourceId === childId || !['--dry-run', '--apply'].includes(mode)) {
  throw Error('Usage: node scripts/fork-story-duration-revision.mjs SOURCE NEW_RECORD [--dry-run|--apply]')
}
const hash = createJsonHasher()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const localAsset = async (url, expectedSha) => {
  assert.match(url, /^\/generated\/[\w.-]+\.(?:png|jpg|jpeg|mp4)$/)
  const bytes = await readFile(path.join('public', url.slice(1)))
  const digest = sha(bytes)
  if (expectedSha) assert.equal(digest, expectedSha)
  return { url, sha256: digest, bytes: bytes.length }
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query(mode === '--apply' ? 'BEGIN' : 'BEGIN READ ONLY')
  const source = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${mode === '--apply' ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
  const workflowRow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'${mode === '--apply' ? ' FOR SHARE' : ''}`)).rows[0]
  const model = (await db.query("SELECT id,provider,capability,settings FROM model_configs WHERE id='keling3'")).rows[0]
  assert.equal(source?.workflow_id, 'wf-story')
  assert.equal(workflowRow?.schema_version, 7)
  assert.equal(model?.provider, 'Kling')
  assert.equal(model?.capability, 'video')
  assert.equal((await db.query('SELECT 1 FROM execution_records WHERE id=$1', [childId])).rowCount, 0)
  const original = decodeExecutionState(source.result)
  const runs = original.nodeRuns
  assert.deepEqual(runs.map(run => run.node.id), ['node-input', 'node-model-images', 'node-script',
    'node-script-review', 'node-script-review-result-branch', 'node-loop',
    ...Array.from({ length: 2 }, () => ['node-image', 'node-video', 'node-video-review',
      'node-video-review-result-branch', 'node-video-concat']).flat()])
  assert.deepEqual(runs.map(run => run.status), [...Array(9).fill('success'), 'failed', ...Array(6).fill('idle')])
  assert.equal(runs[8].output.storyMediaReview.reviewStatus, 'uncertain')
  assert.equal(runs[8].output.storyMediaReview.retryable, false)
  assert.match(runs[9].error, /STORY_MEDIA_REVIEW_REQUIRED/)
  assert.equal(runs[7].loopGroupId, runs[9].loopGroupId)
  assert.equal(runs[7].loopIndex, 0)
  const oldShots = runs[3].output.shots
  assert.equal(oldShots.length, 2)
  const old = oldShots[0]
  assert.equal(old.duration, 13)
  assert.deepEqual(old.visualBeats.map(beat => beat.endSecond), [3, 7, 11])
  const sourceBinding = createStoryScriptSource({ shots: oldShots },
    { sourceExecutionId: sourceId, sourceRunId: runs[3].id })
  const ends = [4, 8, 12]
  const revised = structuredClone(old)
  revised.duration = 15
  revised.content = revised.visualBeats.map((beat, index) =>
    `${index ? ends[index - 1] : 0}–${ends[index]}秒：${beat.action}`).join('；')
  revised.visualBeats = revised.visualBeats.map((beat, index) => ({ ...beat,
    startSecond: index ? ends[index - 1] : 0, endSecond: ends[index] }))
  revised.vocalBeats = revised.vocalBeats.map(beat => beat.id === 'breakfast_woof'
    ? { ...beat, startSecond: 4.4, endSecond: 4.8 } : beat)
  revised.timedActions = renderStoryShotTimedActions(revised)
  const draftShots = [revised, structuredClone(oldShots[1])]
  validateStoryShotTimingOutput(draftShots, { expectedCount: 2, source: sourceBinding,
    requireAnimalInteraction: true })
  assert.equal(revised.timedActions.includes('12–15 秒：保持已完成状态'), true)
  const editorialScript = { shots: draftShots, items: draftShots,
    editorialOrigin: { method: 'source-bound-duration-revision', sourceRecordId: sourceId,
      sourceReviewRunId: runs[3].id, sourceShotsSha256: hash(oldShots), humanAccepted: false } }
  const reviewOutput = await executeBuiltinNode(null, { operation: 'story.script-review',
    params: { script: editorialScript, expectedCount: 2, source: sourceBinding },
    executionContext: { workflowId: 'wf-story', nodeId: 'node-script-review' } })
  assert.equal(reviewOutput.passed, true)
  assert.equal(reviewOutput.repairAttempt.attempted, false)
  assert.equal(reviewOutput.shots[0].duration, 15)
  assert.ok(reviewOutput.shots[0].timedActions.includes(revised.timedActions))
  const revisedShots = reviewOutput.shots
  const workflow = { id: 'wf-story', schemaVersion: 7, nodes: workflowRow.nodes, edges: workflowRow.edges }
  const byId = new Map(workflow.nodes.map(node => [node.id, node]))
  const opening = await localAsset(runs[6].output.url, runs[6].output.raw?.raw?.image?.sha256)
  const oldVideo = await localAsset(runs[8].output.videoEvidence.url,
    runs[8].output.videoEvidence.sha256)
  const endFrame = await localAsset(runs[8].output.videoEvidence.lastFrameUrl)
  const next = structuredClone(runs)
  const reviewInputs = { ...runs[2].context, editorialScript, storyScriptSource: sourceBinding }
  next[3] = { ...next[3], node: byId.get('node-script-review'),
    inputs: { script: editorialScript, expectedCount: 2, source: sourceBinding },
    inputContext: reviewInputs, context: { ...reviewInputs, script_review: reviewOutput },
    output: reviewOutput, durationMs: 0, startedAt: undefined,
    routeInputOverrides: { editorialScript, storyScriptSource: sourceBinding },
    paramOverrides: { 'story-review-script': '${editorialScript}' },
    editorialRevision: { sourceExecutionId: sourceId, sourceRunId: runs[3].id,
      method: 'actual-builtin-deterministic-revalidation', providerCalls: 0 } }
  next[4] = { ...next[4], node: byId.get('node-script-review-result-branch'),
    inputs: { ...next[4].inputs, report: reviewOutput }, inputContext: next[3].context,
    context: { ...next[3].context, script_review_decision: next[4].output } }
  next[5] = { ...next[5], node: byId.get('node-loop'), inputContext: next[4].context,
    context: { ...next[4].context, shot_loop: next[5].output } }
  next[6] = { ...next[6], loopNode: byId.get('node-loop'), loopItem: revisedShots[0] }
  const preparedImage = prepareWorkflowRunContext(next, 6)
  assert.equal(preparedImage.inputContext.shot.duration, 15)
  next[6] = { ...next[6], inputContext: preparedImage.inputContext,
    context: { ...preparedImage.inputContext, first_frame: next[6].output },
    reusedPaidOutput: { sourceExecutionId: sourceId, sourceRunId: runs[6].id,
      sourceOutputSha256: hash(runs[6].output), firstFramePromptUnchanged: true,
      originalInputsPreserved: true } }
  for (let index = 7; index < next.length; index++) {
    const prior = next[index]
    next[index] = { ...invalidateRunExecution(prior), node: byId.get(prior.node.id),
      loopNode: byId.get('node-loop'), loopItem: revisedShots[prior.loopIndex],
      loopPrevious: undefined, revision: (prior.revision ?? 0) + (prior.status === 'idle' ? 0 : 1),
      attempt: 1, errorAttempt: 1,
      ...(index === 7 ? { paramOverrides: { ...(prior.paramOverrides ?? {}),
        'story-optional-end-image': endFrame.url } } : {}) }
  }
  const refreshed = refreshPendingExecutionNodes(workflow, next)
  assert.equal(hasExecutionPlanMismatch(workflow, refreshed), false)
  assert.ok(refreshed.slice(7).every(run => run.status === 'idle' && run.output === undefined))
  const prepared = prepareWorkflowRunContext(refreshed, 7)
  const effective = refreshed[7]
  const params = Object.fromEntries(effective.node.params.map(param => [param.englishName || param.name,
    resolveTemplateJsonValue(effective.paramOverrides?.[param.id] ?? param.value, prepared.inputContext)]))
  const prompt = renderWorkflowTemplate(effective.node.prompt, prepared.inputContext)
  assert.equal(params.duration, 15)
  assert.equal(params.expectedDuration, 15)
  assert.equal(params.referenceImage.url, opening.url)
  assert.equal(params.endImage, endFrame.url)
  assert.equal(params.storyShot.duration, 15)
  assert.ok(prompt.includes(revisedShots[0].timedActions))
  const request = buildKlingVideoRequest(model, prompt, await prepareKlingImageInputs(params))
  assert.equal(request.duration, '15')
  assert.equal(typeof request.image_tail, 'string')
  assert.ok(String(request.image_tail).length > 1000)
  const state = { ...original, id: childId, parentExecutionId: sourceId,
    generationScopeId: childId, requestScopeId: original.requestScopeId ?? sourceId,
    historical: false, mode: 'step', nodeRuns: refreshed,
    context: refreshed[6].context, selectedNodeId: 'node-video',
    storyDurationRevision: { version: 'story-duration-revision-v1', sourceExecutionId: sourceId,
      sourceResultMd5: source.result_md5, workflowNodesMd5: workflowRow.nodes_md5,
      workflowEdgesMd5: workflowRow.edges_md5, sourceVideo: oldVideo,
      firstFrame: opening, targetEndFrame: endFrame, revisedShotSha256: hash(revisedShots[0]),
      originalReviewStatus: 'uncertain', oldVideoNotAccepted: true, providerCallsOnFork: 0 },
    logs: [...runs.slice(0, 7).map(run => run.label),
      `从 ${sourceId} 创建时长修订：首镜 15 秒，动作结束点 4/8/12 秒，末尾保持 3 秒；原视频未验收，保留旧视频与首帧。`] }
  assert.equal(hash(decodeExecutionState(JSON.parse(JSON.stringify(encodeExecutionState(state))))), hash(state))
  if (mode === '--apply') {
    await db.query(`INSERT INTO execution_records
      (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
      VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,7,0,16)`, [childId, source.workflow_id,
      source.workflow_name, `首镜15秒时长修订 · ${sourceId}`,
      JSON.stringify(source.runtime_inputs), JSON.stringify(encodeExecutionState(state))])
    const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [childId])).rows[0]
    assert.equal(hash(decodeExecutionState(saved.result)), hash(state))
  }
  const sourceAfter = (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [sourceId])).rows[0]
  const workflowAfter = (await db.query("SELECT md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]
  assert.equal(sourceAfter.md5, source.result_md5)
  assert.equal(workflowAfter.nodes_md5, workflowRow.nodes_md5)
  assert.equal(workflowAfter.edges_md5, workflowRow.edges_md5)
  await db.query('COMMIT')
  console.log(JSON.stringify({ applied: mode === '--apply', sourceRecordId: sourceId, childRecordId: childId,
    sourceResultMd5: source.result_md5, workflowNodesMd5: workflowRow.nodes_md5,
    workflowEdgesMd5: workflowRow.edges_md5, firstPendingIndex: 7, providerCalls: 0,
    duration: 15, beatEndSeconds: ends, finalHoldSeconds: 3, firstFrameSha256: opening.sha256,
    oldVideoSha256: oldVideo.sha256, endFrameSha256: endFrame.sha256,
    requestPreflightPassed: true, originalUnchanged: true }, null, 2))
} catch (error) { await db.query('ROLLBACK'); throw error }
finally { await db.end() }
