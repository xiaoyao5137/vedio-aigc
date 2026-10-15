#!/usr/bin/env node
// A human's separate, source-bound cat/dog listening verdict can advance a
// visually passed wf-story take. Default dry-run; --apply INSERTs one child.
// It never changes the source, its uncertain model review, or paid media.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { routeBranch } from '../src/workflow-branch.ts'
import { requireStoryVocalHumanAcceptance, assertStoryVocalHumanAssets,
  storyVocalJsonSha256 } from '../server/story-vocal-manual-acceptance.ts'
import { generatedAsset, loadHumanStoryReview } from './story-shot-human-review.mjs'
import { applyStoryVocalReviewGate, validateStoryShotAssessment } from '../server/story-media-review.ts'

const fail = message => { throw Error(`STORY_VOCAL_HUMAN_FORK_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const md5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)

export function parseStoryVocalHumanForkArgs(args) {
  const options = { apply: false, template: false }
  const fields = { '--source-record': 'sourceId', '--id': 'id', '--review-file': 'reviewFile',
    '--expected-source-md5': 'sourceMd5', '--expected-workflow-nodes-md5': 'nodesMd5',
    '--expected-workflow-edges-md5': 'edgesMd5', '--expected-review-file-sha256': 'reviewFileSha256',
    '--expected-video-sha256': 'videoSha256' }
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help') { options.help = true; continue }
    if (flag === '--template') { if (options.template) fail('duplicate --template'); options.template = true; continue }
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    const field = fields[flag]
    if (!field || seen.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown or incomplete ${flag}`)
    options[field] = args[++index]
    seen.add(flag)
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '')) fail('source record is required')
  if (options.template && options.apply) fail('--template is read-only and cannot be combined with --apply')
  if (!options.template && (!/^record-[\w-]+$/.test(options.id ?? '')
    || options.sourceId === options.id || !options.reviewFile)) fail('new ID and review file are required')
  for (const field of ['sourceMd5', 'nodesMd5', 'edgesMd5']) if (options[field] && !md5(options[field])) fail(`${field} is invalid`)
  for (const field of ['reviewFileSha256', 'videoSha256']) if (options[field] && !sha(options[field])) fail(`${field} is invalid`)
  if (options.apply && (!options.sourceMd5 || !options.nodesMd5 || !options.edgesMd5
    || !options.reviewFileSha256 || !options.videoSha256)) fail('--apply requires every reviewed source, workflow and media digest')
  return options
}

/** This is deliberately pending. Only a person who listened to the exact
 * local MP4/WAV and watched both mouths can change the verdict and booleans. */
export function storyVocalHumanReviewTemplate(source, verified) {
  const { run, shot } = targetOf(source)
  const output = run.output, review = output.storyMediaReview
  const visual = validateStoryShotAssessment(shot, review.videoEvidence,
    review.observations, review.assessment)
  const gated = applyStoryVocalReviewGate(visual, review.vocalEvidence)
  if (!visual.passed || visual.reviewStatus !== 'passed' || visual.issues.length
    || gated.reviewStatus !== review.reviewStatus || gated.passed !== review.passed
    || storyVocalJsonSha256(gated.issues) !== storyVocalJsonSha256(review.issues)
    || storyVocalJsonSha256(visual.beatChecks) !== storyVocalJsonSha256(review.beatChecks)
    || storyVocalJsonSha256(visual.endingHold) !== storyVocalJsonSha256(review.endingHold)
    || review.vocalEvidence?.acousticStatus !== 'signal-present'
    || verified.videoSha256 !== review.videoEvidence?.sha256
    || verified.audioSha256.length !== review.vocalEvidence?.windows?.length
    || review.vocalEvidence.windows.some((window, index) => window.audioSha256 !== verified.audioSha256[index])) {
    fail('source has visual defects, silent vocals or changed local media; no pending acceptance template may be issued')
  }
  return { version: 'story-vocal-human-acceptance-v1',
    reviewMethod: 'human-listening-and-mouth-sync', verdict: 'pending',
    reviewer: '', reviewedAt: '', sourceRecordId: source.id,
    sourceResultMd5: source.result_md5, sourceRunId: run.id,
    sourceVideoOutputSha256: storyVocalJsonSha256(output),
    sourceReviewSha256: storyVocalJsonSha256(review), sourceShotSha256: storyVocalJsonSha256(shot),
    sourceVideoSha256: verified.videoSha256, sourceVideoUrl: review.videoEvidence.url,
    windows: review.vocalEvidence.windows.map(window => ({ id: window.id,
      speaker: window.speaker, utterance: window.utterance,
      startSecond: window.startSecond, endSecond: window.endSecond,
      audioUrl: window.audioUrl, audioSha256: window.audioSha256,
      heardAsExpected: false, mouthSyncConfirmed: false, observation: '' })) }
}

function targetOf(source) {
  const state = decodeExecutionState(source.result)
  const runs = state.nodeRuns
  const index = runs?.findIndex(run => run.node?.id === 'node-video-review' && run.status === 'failed'
    && run.output?.storyMediaReview?.vocalEvidence)
  if (source.workflow_id !== 'wf-story' || state.workflowId !== 'wf-story' || state.id !== source.id
    || !Array.isArray(runs) || index < 5 || index >= runs.length - 1
    || runs.slice(0, index).some(run => run.status !== 'success')
    || runs.slice(index + 1).some(run => run.status !== 'idle')
    || !(runs[index + 1].node?.id === 'node-video-concat'
      || runs[index + 1].node?.id === 'node-video-review-result-branch'
        && runs[index + 2]?.node?.id === 'node-video-concat')
    || !Number.isSafeInteger(runs[index].loopIndex) || runs[index].loopIndex < 0
    || runs[index].node?.resultVar !== 'video_review'
    || runs[index].output?.storyMediaReview?.reviewStatus !== 'uncertain') fail('source is not a single failed vocal-review boundary before concat')
  const script = runs.find(run => run.node?.id === 'node-script-review' && run.status === 'success')?.output
  const shot = script?.shots?.[runs[index].loopIndex]
  if (!object(shot)) fail('cannot bind reviewed script shot for this loop index')
  const paid = runs[index - 1], reviewed = runs[index].output
  if (paid?.node?.id !== 'node-video' || paid.status !== 'success' || paid.output?.model !== 'keling3'
    || typeof paid.output?.url !== 'string' || !paid.output.url.startsWith('https://')
    || reviewed.originalUrl !== paid.output.url
    || reviewed.storyMediaReview.videoUrl !== paid.output.url
    || reviewed.storyMediaReview.videoEvidence?.originalUrl !== paid.output.url
    || reviewed.paidSourceUrl !== undefined || reviewed.paidSourceSha256 !== undefined
    || reviewed.audioFoleyRemediation !== undefined || reviewed.audioLevelRemediation !== undefined
    || reviewed.retimedComposite !== undefined || reviewed.storyMediaReview.audioLevelRemediation !== undefined) {
    fail('this native-paid-video path cannot certify a retimed or mixed-source composite')
  }
  return { state, runs, index, run: runs[index], shot }
}

/** Builds a separate human certificate from an explicit review report. The
 * original automated output remains byte-for-byte identical beneath it. */
export function prepareStoryVocalHumanFork(source, workflow, loaded, verified, id,
  createdAt = new Date().toISOString()) {
  if (!object(source) || !object(workflow) || workflow.id !== 'wf-story'
    || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)
    || !object(loaded) || !object(loaded.report) || !sha(loaded.sha256)
    || !/^record-[\w-]+$/.test(id) || id === source.id) fail('invalid source, workflow, report or new ID')
  const { state, runs, index, run, shot } = targetOf(source)
  const report = loaded.report, output = run.output, review = output.storyMediaReview
  const evidence = review.videoEvidence, vocal = review.vocalEvidence
  const videoHash = storyVocalJsonSha256(output), reviewHash = storyVocalJsonSha256(review)
  const shotHash = storyVocalJsonSha256(shot)
  if (report.version !== 'story-vocal-human-acceptance-v1'
    || report.reviewMethod !== 'human-listening-and-mouth-sync' || report.verdict !== 'pass'
    || report.sourceRecordId !== source.id || report.sourceResultMd5 !== source.result_md5
    || report.sourceRunId !== run.id || report.sourceVideoOutputSha256 !== videoHash
    || report.sourceReviewSha256 !== reviewHash || report.sourceShotSha256 !== shotHash
    || report.sourceVideoUrl !== evidence?.url
    || report.sourceVideoSha256 !== evidence?.sha256 || report.sourceVideoSha256 !== verified.videoSha256
    || !Array.isArray(report.windows) || !Array.isArray(vocal?.windows)
    || report.windows.length !== vocal.windows.length) fail('report does not bind the exact source, review, shot and saved video')
  const windows = vocal.windows.map((window, position) => {
    const judged = report.windows[position]
    if (!object(judged) || judged.id !== window.id || judged.speaker !== window.speaker
      || judged.utterance !== window.utterance || judged.startSecond !== window.startSecond
      || judged.endSecond !== window.endSecond || judged.audioUrl !== window.audioUrl
      || judged.audioSha256 !== window.audioSha256
      || verified.audioSha256[position] !== window.audioSha256) fail(`review window ${position} does not bind its archived WAV`)
    return { id: window.id, speaker: window.speaker, utterance: window.utterance,
      startSecond: window.startSecond, endSecond: window.endSecond, visualBeatId: window.visualBeatId,
      responseTo: window.responseTo, audioUrl: window.audioUrl, audioSha256: window.audioSha256,
      heardAsExpected: judged.heardAsExpected, mouthSyncConfirmed: judged.mouthSyncConfirmed,
      observation: judged.observation }
  })
  const humanVocalAcceptance = { version: report.version, reviewMethod: report.reviewMethod,
    verdict: report.verdict, reviewer: report.reviewer, reviewedAt: report.reviewedAt,
    sourceRecordId: source.id, sourceResultMd5: source.result_md5, sourceRunId: run.id,
    sourceVideoOutputSha256: videoHash, sourceShotSha256: shotHash, sourceReviewSha256: reviewHash,
    sourceVideoSha256: verified.videoSha256, sourceVideoUrl: evidence.url,
    sourceEvidenceUrl: evidence.evidenceUrl, reviewFile: loaded.file,
    reviewFileSha256: loaded.sha256, shot, windows }
  const acceptedOutput = { ...output, humanVocalAcceptance }
  requireStoryVocalHumanAcceptance(acceptedOutput)
  const prepared = prepareWorkflowRunContext(runs, index)
  if (!prepared || prepared.run.node.id !== run.node.id) fail('cannot restore failed review input context')
  const acceptedRun = { ...run, status: 'success', error: undefined, output: acceptedOutput,
    context: { ...prepared.inputContext, [run.node.resultVar]: acceptedOutput },
    revision: (run.revision ?? 0) + 1 }
  let nextRuns = [...runs.slice(0, index), acceptedRun, ...runs.slice(index + 1)]
  let pendingIndex = index + 1, context = acceptedRun.context, branchHistory = state.branchHistory
  const next = prepareWorkflowRunContext(nextRuns, pendingIndex)
  if (!next || storyVocalJsonSha256(next.inputContext.video_review) !== storyVocalJsonSha256(acceptedOutput)) {
    fail('accepted same-video result cannot reach the next workflow node')
  }
  if (next.run.node.id === 'node-video-review-result-branch') {
    // The stored automatic branch rejects uncertain model reports. Record a
    // separate human route decision in the child instead of mislabelling the
    // original model report passed or re-running provider/branch code.
    const manualRoute = { value: true, method: 'source-bound-human-vocal-acceptance',
      sourceReviewSha256: reviewHash, reviewFileSha256: loaded.sha256,
      sourceVideoSha256: verified.videoSha256 }
    const transition = routeBranch(workflow, nextRuns, pendingIndex, manualRoute, next.inputContext)
    nextRuns = transition.runs
    pendingIndex = transition.index
    context = transition.context
    branchHistory = [...(state.branchHistory ?? []), transition.history]
  }
  if (nextRuns[pendingIndex]?.node?.id !== 'node-video-concat'
    || storyVocalJsonSha256(context.video_review) !== storyVocalJsonSha256(acceptedOutput)) {
    fail('manual same-video decision did not route to waiting concat')
  }
  const recovery = { version: 'story-vocal-human-fork-v1', createdAt,
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    sourceRunId: run.id, sourceReviewStatus: 'uncertain', sourceVideoOutputSha256: videoHash,
    sourceReviewSha256: reviewHash, sourceShotSha256: shotHash,
    sourceVideoSha256: verified.videoSha256, audioSha256: verified.audioSha256,
    reviewFile: loaded.file, reviewFileSha256: loaded.sha256, modelCalls: 0 }
  const fork = { ...state, id, parentExecutionId: source.id, generationScopeId: id,
    requestScopeId: state.requestScopeId ?? source.id, historical: false, mode: 'step',
    nodeRuns: nextRuns, context, selectedNodeId: 'node-video-concat', branchHistory,
    storyVocalHumanReviewRecovery: recovery,
    logs: [...(state.logs ?? []), '同一素材已记录逐声人工听审与口型确认；原自动声音 uncertain 保留；待阶段拼接。'] }
  const encoded = encodeExecutionState(fork)
  if (storyVocalJsonSha256(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== storyVocalJsonSha256(fork)
    || storyVocalJsonSha256(runs.slice(0, index)) !== storyVocalJsonSha256(nextRuns.slice(0, index))
    || storyVocalJsonSha256(runs.slice(pendingIndex).map(item => ({ id: item.id, node: item.node,
      status: item.status, output: item.output }))) !== storyVocalJsonSha256(nextRuns.slice(pendingIndex)
      .map(item => ({ id: item.id, node: item.node, status: item.status, output: item.output })))
    || storyVocalJsonSha256(output) !== storyVocalJsonSha256(
      Object.fromEntries(Object.entries(acceptedOutput).filter(([key]) => key !== 'humanVocalAcceptance')))) {
    fail('fork changed the original review, paid prefix or waiting suffix')
  }
  return { state: fork, encoded, proof: { version: recovery.version, sourceRecordId: source.id,
    sourceResultMd5: source.result_md5, workflowNodesMd5: workflow.nodes_md5,
    workflowEdgesMd5: workflow.edges_md5, newRecordId: id, failedReviewIndex: index,
    firstPendingIndex: pendingIndex, firstPendingNodeId: 'node-video-concat',
    manualBranchRouted: pendingIndex === index + 2,
    originalAutomatedReviewStatus: 'uncertain', humanVerdict: report.verdict,
    reviewerMethod: report.reviewMethod, videoSha256: verified.videoSha256,
    audioSha256: verified.audioSha256, reviewFileSha256: loaded.sha256,
    visualRevalidated: true, originalReviewUnchanged: true, sourceUnchanged: true, modelCalls: 0 } }
}

async function run(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const lock = options.apply ? ' FOR SHARE' : ''
    const source = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`,
      [options.sourceId])).rows[0]
    const workflow = (await client.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !workflow) fail('source or workflow is missing')
    if (options.sourceMd5 && options.sourceMd5 !== source.result_md5
      || options.nodesMd5 && options.nodesMd5 !== workflow.nodes_md5
      || options.edgesMd5 && options.edgesMd5 !== workflow.edges_md5) fail('source or workflow changed since dry run')
    if ((await client.query('SELECT 1 FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('destination ID already exists')
    const { run } = targetOf(source)
    const loaded = await loadHumanStoryReview(options.reviewFile)
    const video = await generatedAsset(run.output.storyMediaReview.videoEvidence.url, ['.mp4'])
    const audio = []
    for (const window of run.output.storyMediaReview.vocalEvidence.windows) {
      audio.push(await generatedAsset(window.audioUrl, ['.wav']))
    }
    if (options.reviewFileSha256 && options.reviewFileSha256 !== loaded.sha256
      || options.videoSha256 && options.videoSha256 !== video.sha256) fail('report or video bytes changed since dry run')
    const verified = { videoSha256: video.sha256, audioSha256: audio.map(item => item.sha256) }
    const prepared = prepareStoryVocalHumanFork(source, workflow, loaded, verified, options.id)
    await assertStoryVocalHumanAssets(prepared.state.nodeRuns[prepared.proof.failedReviewIndex].output)
    if (options.apply) {
      const fork = prepared.state
      const succeeded = fork.nodeRuns.filter(item => item.status === 'success').length
      await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        fork.id, source.workflow_id, source.workflow_name, `同源逐声人工验收 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(prepared.encoded), succeeded, fork.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [fork.id])).rows[0]
      if (!inserted || storyVocalJsonSha256(decodeExecutionState(inserted.result)) !== storyVocalJsonSha256(fork)) fail('persisted child differs from reviewed fork')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.md5
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]
    if (sourceAfter !== source.result_md5 || workflowAfter.nodes_md5 !== workflow.nodes_md5
      || workflowAfter.edges_md5 !== workflow.edges_md5) fail('source or workflow changed during preparation')
    await client.query('COMMIT')
    return { ...prepared.proof, sourceResultMd5After: sourceAfter, applied: options.apply }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

async function printTemplate(client, options) {
  await client.query('BEGIN READ ONLY')
  try {
    const source = (await client.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
      [options.sourceId])).rows[0]
    if (!source) fail('source is missing')
    const { run } = targetOf(source), review = run.output.storyMediaReview
    const video = await generatedAsset(review.videoEvidence.url, ['.mp4'])
    const audio = []
    for (const window of review.vocalEvidence.windows) audio.push(await generatedAsset(window.audioUrl, ['.wav']))
    const report = storyVocalHumanReviewTemplate(source, { videoSha256: video.sha256,
      audioSha256: audio.map(item => item.sha256) })
    await client.query('COMMIT')
    return report
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

async function main() {
  const options = parseStoryVocalHumanForkArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Read-only pending report: node scripts/fork-story-vocal-human-accepted.mjs --source-record RECORD --template\nDry run: node scripts/fork-story-vocal-human-accepted.mjs --source-record RECORD --id NEW_RECORD --review-file qa/REPORT.json\nApply only after dry-run: add --expected-source-md5 MD5 --expected-workflow-nodes-md5 MD5 --expected-workflow-edges-md5 MD5 --expected-review-file-sha256 SHA256 --expected-video-sha256 SHA256 --apply')
    return
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try { console.log(JSON.stringify(options.template ? await printTemplate(db, options) : await run(db, options), null, 2)) }
  finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
