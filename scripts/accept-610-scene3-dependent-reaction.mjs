#!/usr/bin/env node
// Same paid media, real video evidence, recorded independent review, saved
// schema-158 accept code. Runs the API code node and in-memory checkpoint only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { acceptPrincipleMedia } from '../src/principle-media-quality.ts'
import { requiresManualMediaDecision, runWorkflowToCompletion } from '../src/workflow-runner.ts'

assert.deepEqual(process.argv.slice(2), ['--run'])
const out = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-speech-reaction-replay-20260928-v1')
const shotPath = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-first-frame-20260928-v1/review-shot.json')
const read = name => readFile(path.join(out, name), 'utf8').then(JSON.parse)
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const [prior, reviewed, projected] = await Promise.all([
  read('evidence-result.json'), read('review-result-private.json'), readFile(shotPath, 'utf8').then(JSON.parse),
])
assert.equal(reviewed.ledgerBoundToCurrentFrames, true)
assert.equal(reviewed.report.dependentReactionCheck.status, 'uncertain')
assert.equal(reviewed.report.dependentReactionCheck.evidenceUrl, prior.evidenceUrl)
assert.equal(reviewed.newImageOrVideoProviderRequests, 0)
const evidence = JSON.parse(await readFile(path.resolve('public', prior.evidenceUrl.slice(1)), 'utf8'))
const context = { shot_script: projected.shot, video_take: { url: evidence.originalUrl,
  params: { scheduleHash: projected.shot.pacing.scheduleHash } },
  video_evidence: evidence, media_review: reviewed.normalizedReview,
  historical_sources: prior.historicSources }
const params = { qualityMode: 'principle-v1', qualityDisposition: 'manual-review-v1',
  speechEvidencePolicy: 'enforce-evidenced-v1', subtitlePolicy: 'none', aspectWidth: 16, aspectHeight: 9 }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const sourceBefore = (await db.query(`select md5(result::text) as content_md5,xmin::text as revision,
    ctid::text as location from execution_records where id=$1`,
  ['record-610-scene4-voice-repair-20260928-v1'])).rows[0]
  assert.equal(sourceBefore.content_md5, 'df7ddd75cf661ae5ee5d60656854989c')
  const mediaBefore = Number((await db.query(`select count(*)::int as count from model_execution_records
    where workflow_id='wf-sanguo-history-drama' and capability in ('image','video')`)).rows[0].count)
  const graph = (await db.query(`select schema_version,nodes from workflow_configs where id='wf-sanguo-history-drama'`)).rows[0]
  assert.equal(graph.schema_version, 158)
  const node = graph.nodes.find(item => item.id === 'sanguo-media-accept')
  assert.ok(node.code.includes('manual-review-hold'))
  const direct = acceptPrincipleMedia(context, params)
  const summary = output => ({ passed: output.passed, status: output.qualityReview?.status,
    canProceed: output.qualityReview?.canProceed, manualDecisionRequired: output.manualDecisionRequired,
    automaticRetakeAllowed: output.qualityReview?.automaticRetakeAllowed,
    temporalReaction: output.temporalReaction, technicalValidation: output.technicalValidation,
    visualReviewPassed: output.visualReview?.passed,
    rawReviewDecision: output.qualityReview?.rawReport?.decision,
    rawReviewReactionStatus: output.qualityReview?.rawReport?.dependentReactionCheck?.status })
  const directSummary = summary(direct)
  assert.equal(directSummary.manualDecisionRequired, true)
  assert.equal(directSummary.temporalReaction.status, 'manual-review-hold')
  assert.equal(directSummary.technicalValidation.passed, true)
  assert.equal(directSummary.visualReviewPassed, false)
  await writeFile(path.join(out, 'source-accept-replay.json'), JSON.stringify({
    format: 'scene3-source-accept-replay-v1', at: new Date().toISOString(),
    sourceExecutionId: 'record-610-scene4-voice-repair-20260928-v1', sourceBefore,
    evidenceUrl: evidence.evidenceUrl, reviewLedgerId: reviewed.ledger.find(row => row.status === 'succeeded')?.id,
    modelReviewDecision: reviewed.report.decision, modelReactionStatus: reviewed.report.dependentReactionCheck.status,
    output: directSummary, newImageOrVideoProviderRequests: 0, sourceExecutionWrites: 0,
    runnerScope: 'source function only', concatRan: false,
  }, null, 2) + '\n', { flag: 'wx' })
  const response = await fetch('http://127.0.0.1:5173/api/code-node-run', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: node.code, context, params }),
    signal: AbortSignal.timeout(30_000) })
  const envelope = await response.json()
  assert.equal(response.status, 200)
  assert.equal(envelope.status, 200)
  const apiSummary = summary(envelope.body)
  assert.deepEqual(apiSummary, directSummary)
  const beforeRuns = { nodeRuns: [
    { id: 'scene3-video', node: { id: 'sanguo-video' }, status: 'success', output: context.video_take },
    { id: 'scene3-accept', node: { id: 'sanguo-media-accept' }, status: 'idle', output: undefined },
    { id: 'scene3-concat', node: { id: 'sanguo-video-concat' }, status: 'idle', output: undefined },
  ] }
  const called = []
  const paused = await runWorkflowToCompletion(beforeRuns, async (index, state) => {
    called.push(state.nodeRuns[index].node.id)
    return { nodeRuns: state.nodeRuns.map((run, at) => at === index ? { ...run, status: 'success',
      output: envelope.body } : run) }
  })
  assert.deepEqual(called, ['sanguo-media-accept'])
  assert.equal(paused.nodeRuns[2].status, 'idle')
  assert.equal(requiresManualMediaDecision(paused.nodeRuns[1]), true)
  const sourceAfter = (await db.query(`select md5(result::text) as content_md5,xmin::text as revision,
    ctid::text as location from execution_records where id=$1`,
  ['record-610-scene4-voice-repair-20260928-v1'])).rows[0]
  const mediaAfter = Number((await db.query(`select count(*)::int as count from model_execution_records
    where workflow_id='wf-sanguo-history-drama' and capability in ('image','video')`)).rows[0].count)
  assert.deepEqual(sourceAfter, sourceBefore)
  assert.equal(mediaAfter, mediaBefore)
  const proof = { format: 'scene3-saved-accept-api-replay-v1', at: new Date().toISOString(),
    schemaVersion: graph.schema_version, savedCodeSha256: sha(node.code), httpStatus: response.status,
    evidenceUrl: evidence.evidenceUrl, reviewLedgerId: reviewed.ledger.find(row => row.status === 'succeeded')?.id,
    output: apiSummary, runner: { mode: 'in-memory checkpoint replay with actual API output',
      executedNodeIds: called, manualCheckpointRequired: requiresManualMediaDecision(paused.nodeRuns[1]),
      concatStatus: paused.nodeRuns[2].status, persistedExecutionCreated: false },
    sourceExecutionId: 'record-610-scene4-voice-repair-20260928-v1', sourceBefore, sourceAfter,
    mediaLedgerCountBefore: mediaBefore, mediaLedgerCountAfter: mediaAfter,
    newImageOrVideoProviderRequests: 0, sourceExecutionWrites: 0, concatRan: false }
  await writeFile(path.join(out, 'saved-accept-api-replay.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(proof, null, 2))
} finally { await db.end() }
