#!/usr/bin/env node
// A separately recorded direct visual verdict can complete shot 2 while the
// automated uncertain verdict remains in the saved video output. Dry-run is
// read-only; --apply inserts one new checkpoint and never invokes a provider.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { validatedDerivative } from './fork-story-foley-review.mjs'
import { generatedAsset, loadHumanStoryReview, verifyHumanStoryReviewFrames } from './story-shot-human-review.mjs'

const fail = message => { throw Error(`STORY_SHOT2_HUMAN_FORK_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const md5 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const expectedNodes = ['node-input', 'node-model-images', 'node-script', 'node-loop',
  'node-image', 'node-video', 'node-image', 'node-video']

export function parseStoryShot2HumanForkArgs(args) {
  const options = { apply: false }
  const fields = { '--source-record': 'sourceId', '--id': 'id', '--review-file': 'reviewFile',
    '--expected-source-md5': 'sourceMd5', '--expected-parent-md5': 'parentMd5',
    '--expected-workflow-md5': 'workflowMd5', '--expected-review-sha256': 'reviewSha256',
    '--expected-manifest-sha256': 'manifestSha256', '--expected-derived-sha256': 'derivedSha256',
    '--expected-original-sha256': 'originalSha256', '--expected-first-frame-sha256': 'firstFrameSha256',
    '--expected-end-image-sha256': 'endImageSha256' }
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help') { options.help = true; continue }
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    const field = fields[flag]
    if (!field || seen.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown or incomplete ${flag}`)
    options[field] = args[++index]
    seen.add(flag)
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '') || !/^record-[\w-]+$/.test(options.id ?? '')
    || options.sourceId === options.id || !options.reviewFile) fail('source, new ID and review file are required')
  for (const field of ['sourceMd5', 'parentMd5', 'workflowMd5']) if (options[field] && !md5(options[field])) fail(`${field} is invalid`)
  for (const field of ['reviewSha256', 'manifestSha256', 'derivedSha256', 'originalSha256',
    'firstFrameSha256', 'endImageSha256']) if (options[field] && !sha(options[field])) fail(`${field} is invalid`)
  if (options.apply && (!seen.has('--id') || !options.sourceMd5 || !options.parentMd5
    || !options.workflowMd5 || !options.reviewSha256 || !options.manifestSha256
    || !options.derivedSha256 || !options.originalSha256 || !options.firstFrameSha256
    || !options.endImageSha256)) fail('--apply needs explicit ID and every dry-run source/evidence digest')
  return options
}

function matchingFrame(report, second) { return report.frames.find(frame => frame.second === second) }

/** Pure identity and semantics check. The reported visual observations remain
 * the named human reviewer's judgement, not an automated reviewer result. */
export function validateStoryShot2HumanReview(report, source, parent, verified) {
  const hash = createJsonHasher()
  const state = decodeExecutionState(source.result)
  const paidState = decodeExecutionState(parent.result)
  const runs = state.nodeRuns, videoRun = runs?.[7], video = videoRun?.output
  const shot = runs?.[2]?.output?.shots?.[1], review = video?.storyMediaReview
  const foley = video?.audioFoleyRemediation, recovery = state.storyFoleyReviewRecovery
  const manifest = verified?.derivative?.manifest
  const paidRun = paidState.nodeRuns?.[7]
  if (!object(report) || report.version !== 'story-shot2-direct-visual-review-v1'
    || report.reviewMethod !== 'agent-direct-visual' || report.reviewer !== 'Codex'
    || report.verdict !== 'visual-pass' || !['moderate', 'high'].includes(report.confidence)
    || !Number.isFinite(Date.parse(report.reviewedAt)) || !sha(verified.reportSha256)
    || !Array.isArray(report.limitations) || !report.limitations.length
    || report.limitations.some(value => typeof value !== 'string' || value.length < 15)) fail('independent review identity, verdict or limitations invalid')
  if (report.sourceRecordId !== source.id || report.sourceResultMd5 !== source.result_md5
    || report.sourceReviewStatus !== 'uncertain' || report.sourceReviewSha256 !== hash(review)
    || report.sourceVideoOutputSha256 !== hash(video)
    || report.scriptOutputSha256 !== hash(runs[2].output) || report.shotSha256 !== hash(shot)
    || review?.reviewStatus !== 'uncertain' || review.passed !== false || review.retryable !== false
    || review.videoEvidence?.decoded !== true || review.videoEvidence?.url !== video?.url
    || review.videoEvidence?.sha256 !== verified.reviewedVideo.sha256
    || review.videoEvidence?.duration !== report.derivedVideo?.durationSeconds
    || report.derivedVideo?.durationSeconds < shot?.duration
    || report.derivedVideo?.durationSeconds > shot.duration + .25) fail('report does not bind the exact uncertain source and media review')
  if (paidState.id !== parent.id || parent.id !== recovery?.sourceExecutionId
    || paidRun?.id !== recovery.sourceRunId || paidRun.status !== 'failed'
    || paidRun.output?.storyMediaReview?.reviewStatus !== 'technical-failure'
    || hash(paidRun.output) !== recovery.paidSourceOutputSha256
    || paidRun.output.url !== verified.derivative.source.url
    || video.paidSourceOutputSha256 !== recovery.paidSourceOutputSha256
    || video.previousStoryMediaReview?.reviewStatus !== 'technical-failure') fail('original paid source and model review ledger binding changed')
  if (report.originalVideo?.url !== verified.derivative.source.url
    || report.originalVideo?.sha256 !== verified.derivative.source.sha256
    || report.derivedVideo?.url !== verified.reviewedVideo.url
    || report.derivedVideo?.sha256 !== verified.reviewedVideo.sha256
    || report.derivedVideo?.decodedFrameCount !== manifest?.videoFrameCount
    || report.foleyManifest?.url !== verified.derivative.manifestUrl
    || report.foleyManifest?.sha256 !== verified.derivative.manifestSha256
    || report.foleyManifest?.sourceSha256 !== manifest.sourceSha256
    || report.foleyManifest?.outputSha256 !== manifest.outputSha256
    || report.foleyManifest?.sourceAndOutputDecodedFrameSequenceSha256 !== manifest.outputVideoFramesSha256
    || report.foleyManifest?.everyDecodedVideoFrameMatched !== true
    || video.url !== verified.reviewedVideo.url
    || verified.reviewedVideo.sha256 !== verified.derivative.output.sha256
    || video.paidSourceUrl !== verified.derivative.source.url
    || video.paidSourceSha256 !== verified.derivative.source.sha256
    || foley?.manifestUrl !== verified.derivative.manifestUrl
    || foley?.manifestSha256 !== verified.derivative.manifestSha256
    || foley?.sourceSha256 !== verified.derivative.source.sha256
    || foley?.outputSha256 !== verified.derivative.output.sha256
    || foley?.wavSha256 !== verified.derivative.wav.sha256
    || foley?.videoFramesSha256 !== manifest.outputVideoFramesSha256
    || foley?.everyDecodedVideoFrameMatched !== true
    || recovery.manifestSha256 !== verified.derivative.manifestSha256
    || recovery.derivativeVideoSha256 !== verified.derivative.output.sha256
    || recovery.sourceVideoSha256 !== verified.derivative.source.sha256
    || recovery.foleyWavSha256 !== verified.derivative.wav.sha256
    || recovery.sameDecodedVideoFramesSha256 !== manifest.outputVideoFramesSha256
    || recovery.soundContentSemanticReview !== 'pending-human-listen') fail('foley derivative, paid video or audio provenance changed')
  const evidence = review.videoEvidence
  if (!Array.isArray(report.frames) || report.frames.length < 9
    || !report.frames.every((frame, index) => object(frame) && Number.isInteger(frame.frameIndex)
      && frame.frameIndex >= 0 && frame.frameIndex < evidence.frames?.length
      && Number.isFinite(frame.second) && frame.second >= 0 && frame.second < report.derivedVideo.durationSeconds
      && (index === 0 || frame.second > report.frames[index - 1].second
        && frame.frameIndex > report.frames[index - 1].frameIndex)
      && frame.frameUrl === evidence.frames[frame.frameIndex]
      && frame.second === evidence.frameTimes?.[frame.frameIndex]
      && /^qa\/story-shot2-gaze-v2-local-qa\/shot-2\/[\w.-]+\.jpg$/.test(frame.originalQaFile)
      && sha(frame.frameSha256) && typeof frame.observation === 'string'
      && frame.observation.length >= 16)) fail('ordered decoded frame evidence incomplete or unbound')
  for (const second of [0, 1, 2, 3, 4, 6, 7, 7.5, 7.96]) {
    if (!matchingFrame(report, second)) fail(`required action or ending hold frame ${second}s absent`)
  }
  if (!Array.isArray(report.beatChecks) || report.beatChecks.length !== shot.visualBeats?.length) fail('beat checks incomplete')
  for (const [index, beat] of shot.visualBeats.entries()) {
    const check = report.beatChecks[index], start = matchingFrame(report, check?.startSecond)
    const end = matchingFrame(report, check?.completionSecond)
    if (!object(check) || check.id !== beat.id || check.requiredCompletion !== beat.completion
      || check.status !== 'complete' || !['moderate', 'high'].includes(check.confidence)
      || !start || !end || start.second >= end.second || start.second < beat.startSecond
      || end.second > beat.endSecond + .05 || check.startFrameSha256 !== start.frameSha256
      || check.completionFrameSha256 !== end.frameSha256
      || typeof check.observation !== 'string' || check.observation.length < 24) fail(`beat ${beat.id} lacks bound before/after visual evidence`)
  }
  const hold = report.endingHold, first = matchingFrame(report, hold?.startSecond)
  const last = matchingFrame(report, hold?.endSecond)
  if (!object(hold) || hold.status !== 'complete' || !['moderate', 'high'].includes(hold.confidence)
    || hold.startSecond !== shot.visualBeats.at(-1).endSecond || hold.endSecond !== 7.96
    || !first || !last || first.second >= last.second
    || hold.lastFrameSha256 !== last.frameSha256
    || typeof hold.observation !== 'string' || hold.observation.length < 24) fail('ending hold lacks exact terminal frame evidence')
  return report
}

/** Pure fork after file hashes, frame decodes, and manifest checks. */
export function prepareStoryShot2HumanAcceptanceFork(source, parent, workflow, verified, id,
  createdAt = new Date().toISOString()) {
  if (!object(source) || source.workflow_id !== 'wf-story' || !object(parent)
    || parent.workflow_id !== 'wf-story' || !object(workflow) || workflow.id !== 'wf-story'
    || !Array.isArray(workflow.nodes) || !/^record-[\w-]+$/.test(id) || id === source.id
    || id === parent.id || !object(verified)) fail('invalid source, workflow, evidence or ID')
  const hash = createJsonHasher()
  const before = decodeExecutionState(source.result), originalHash = hash(before)
  const runs = before.nodeRuns
  if (before.id !== source.id || before.workflowId !== 'wf-story' || !Array.isArray(runs)
    || runs.length !== expectedNodes.length || runs.some((run, index) => run.node?.id !== expectedNodes[index]
      || index < 7 && run.status !== 'success' || index === 7 && run.status !== 'failed')) {
    fail('source is not an uncertain second-shot boundary with seven successful runs')
  }
  const shot = runs[2].output?.shots?.[1], image = runs[6], video = runs[7]
  validateStoryShotTimingOutput(runs[2].output?.shots, { expectedCount: 2 })
  if (shot.duration !== 8 || image.loopIndex !== 1 || video.loopIndex !== 1
    || video.loopGroupId !== image.loopGroupId || hash(video.loopItem) !== hash(shot)
    || image.output?.model !== 'codex-gpt-image-2' || video.output?.model !== 'keling3'
    || video.output?.params?.duration !== 8
    || video.output?.params?.referenceImage?.url !== image.output?.url
    || video.inputs?.referenceImage?.url !== image.output?.url
    || video.inputContext?.first_frame?.url !== image.output?.url
    || video.output?.params?.endImage !== verified.media.endImage.url
    || image.output?.url !== verified.media.firstFrame.url
    || !String(video.output?.prompt ?? '').includes(renderStoryShotTimedActions(shot))) {
    fail('saved second-shot image, target end frame or paid video bindings changed')
  }
  const human = validateStoryShot2HumanReview(verified.report, source, parent, verified)
  const preparedVideo = prepareWorkflowRunContext(runs, 7)
  if (!preparedVideo || preparedVideo.inputContext?.first_frame?.url !== image.output.url) fail('saved second-shot input context lost')
  const acceptedVideo = { ...video, status: 'success', error: undefined,
    context: { ...preparedVideo.inputContext, [video.node.resultVar]: video.output },
    revision: (video.revision ?? 0) + 1 }
  const nextRuns = [...runs.slice(0, 7), acceptedVideo]
  const recovery = { version: 'story-shot2-direct-visual-acceptance-fork-v1', method: 'direct-visual-pass',
    createdAt, sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    paidExecutionId: parent.id, paidResultMd5: parent.result_md5,
    sourceVideoRunId: video.id, sourceReviewStatus: 'uncertain',
    sourceReviewSha256: hash(video.output.storyMediaReview), sourceVideoOutputSha256: hash(video.output),
    sourcePrefixSha256: hash(runs.slice(0, 7)), reviewFile: verified.reportFile,
    reviewFileSha256: verified.reportSha256, manifestUrl: verified.derivative.manifestUrl,
    manifestSha256: verified.derivative.manifestSha256,
    originalVideoSha256: verified.derivative.source.sha256,
    derivativeVideoSha256: verified.derivative.output.sha256,
    firstFrameSha256: verified.media.firstFrame.sha256, endImageSha256: verified.media.endImage.sha256,
    frameEvidenceCount: human.frames.length,
    decodedVideoFramesSha256: verified.derivative.manifest.outputVideoFramesSha256,
    audioReviewStatus: 'pending-human-listen', providerModelCallsOnFork: 0 }
  const state = { ...before, id, parentExecutionId: source.id, generationScopeId: id,
    requestScopeId: before.requestScopeId ?? source.id, historical: false, mode: 'step',
    nodeRuns: nextRuns, context: acceptedVideo.context, selectedNodeId: 'node-video',
    storyShot2HumanReview: human, storyShot2HumanReviewRecovery: recovery,
    logs: [...(before.logs ?? []),
      `第二镜独立直接视觉复核通过；自动审核 uncertain 原样保留；音效听感仍待用户验收。`] }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)
    || hash(before) !== originalHash || hash(nextRuns.slice(0, 7)) !== hash(runs.slice(0, 7))
    || hash(acceptedVideo.output) !== hash(video.output)) fail('fork altered source media, review or saved prefix')
  return { state, encoded, proof: { version: recovery.version, method: recovery.method,
    sourceRecordId: source.id, sourceResultMd5: source.result_md5,
    parentRecordId: parent.id, parentResultMd5: parent.result_md5,
    workflowNodesMd5: workflow.nodes_md5, newRecordId: id, successfulRuns: 8,
    automatedReviewStatusPreserved: video.output.storyMediaReview.reviewStatus,
    humanVerdict: human.verdict, frameEvidenceCount: human.frames.length,
    reviewFile: verified.reportFile, reviewFileSha256: verified.reportSha256,
    manifestUrl: verified.derivative.manifestUrl,
    manifestSha256: verified.derivative.manifestSha256,
    originalVideoSha256: verified.derivative.source.sha256,
    derivativeVideoSha256: verified.derivative.output.sha256,
    firstFrameSha256: verified.media.firstFrame.sha256,
    endImageSha256: verified.media.endImage.sha256,
    prefixUnchanged: true, videoOutputUnchanged: true, sourceUnchanged: true,
    audioReviewStatus: recovery.audioReviewStatus, providerModelCallsOnFork: 0 } }
}

async function run(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const lock = options.apply ? ' FOR SHARE' : ''
    const source = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`,
      [options.sourceId])).rows[0]
    if (!source) fail('source record missing')
    const sourceState = decodeExecutionState(source.result)
    const parentId = sourceState.storyFoleyReviewRecovery?.sourceExecutionId
    if (!/^record-[\w-]+$/.test(parentId ?? '')) fail('paid source pointer missing')
    const parent = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`,
      [parentId])).rows[0]
    const workflow = (await client.query(`SELECT *,md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!parent || !workflow) fail('paid source or workflow missing')
    if (options.sourceMd5 && options.sourceMd5 !== source.result_md5
      || options.parentMd5 && options.parentMd5 !== parent.result_md5
      || options.workflowMd5 && options.workflowMd5 !== workflow.nodes_md5) fail('source, paid parent or workflow changed since dry-run')
    const report = await loadHumanStoryReview(options.reviewFile)
    const derivative = await validatedDerivative(sourceState.storyFoleyReviewRecovery.manifestUrl)
    const reviewedVideo = await generatedAsset(sourceState.nodeRuns?.[7]?.output?.url, ['.mp4', '.mov', '.webm'])
    const firstFrame = await generatedAsset(sourceState.nodeRuns?.[6]?.output?.url, ['.png', '.jpg', '.jpeg', '.webp'])
    const endImage = await generatedAsset(sourceState.nodeRuns?.[7]?.output?.params?.endImage,
      ['.png', '.jpg', '.jpeg', '.webp'])
    const checked = { sourceMd5: source.result_md5, parentMd5: parent.result_md5,
      workflowMd5: workflow.nodes_md5, reviewSha256: report.sha256,
      manifestSha256: derivative.manifestSha256, derivedSha256: derivative.output.sha256,
      originalSha256: derivative.source.sha256, firstFrameSha256: firstFrame.sha256,
      endImageSha256: endImage.sha256 }
    for (const [key, value] of Object.entries(checked)) {
      if (options[key] && options[key] !== value) fail(`${key} changed since dry-run`)
    }
    const verified = { report: report.report, reportFile: report.file, reportSha256: report.sha256,
      derivative, reviewedVideo, media: { firstFrame, endImage } }
    validateStoryShot2HumanReview(report.report, source, parent, verified)
    for (const frame of report.report.frames) {
      const asset = await generatedAsset(frame.frameUrl, ['.jpg'])
      if (asset.sha256 !== frame.frameSha256) fail(`generated frame at ${frame.second}s changed`)
    }
    const framesForDecode = { frames: report.report.frames.map(frame => ({
      second: frame.second, file: frame.originalQaFile.slice(3), sha256: frame.frameSha256 })) }
    const frameProof = await verifyHumanStoryReviewFrames(framesForDecode, reviewedVideo.file)
    const prepared = prepareStoryShot2HumanAcceptanceFork(source, parent, workflow, verified, options.id)
    if (options.apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,8,0,8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `打工猫第二镜独立视觉通过 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
      ])
      const inserted = (await client.query('SELECT result,succeeded_count,failed_count,total_count FROM execution_records WHERE id=$1',
        [state.id])).rows[0]
      if (!inserted || inserted.succeeded_count !== 8 || inserted.failed_count !== 0 || inserted.total_count !== 8
        || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) {
        fail('persisted acceptance differs from reviewed fork')
      }
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
      [source.id])).rows[0]?.md5
    const parentAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
      [parent.id])).rows[0]?.md5
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS md5 FROM workflow_configs WHERE id='wf-story'" )).rows[0]?.md5
    if (sourceAfter !== source.result_md5 || parentAfter !== parent.result_md5
      || workflowAfter !== workflow.nodes_md5) fail('source, paid parent or workflow changed during preparation')
    await client.query('COMMIT')
    return { ...prepared.proof, decodedFramesVerified: frameProof.decodedFramesVerified,
      sourceResultMd5After: sourceAfter, parentResultMd5After: parentAfter,
      workflowNodesMd5After: workflowAfter, applied: options.apply }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

async function main() {
  const options = parseStoryShot2HumanForkArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-shot2-human-accepted.mjs --source-record RECORD --review-file RELATIVE_TO_QA --id NEW_RECORD [--expected-source-md5 MD5 --expected-parent-md5 MD5 --expected-workflow-md5 MD5 --expected-review-sha256 SHA256 --expected-manifest-sha256 SHA256 --expected-derived-sha256 SHA256 --expected-original-sha256 SHA256 --expected-first-frame-sha256 SHA256 --expected-end-image-sha256 SHA256 --apply]\nDefault read-only dry-run. --apply inserts one new 8/8 checkpoint after verifying all identities, files, decoded frames and a separate visual-pass report.')
    return
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await client.connect()
  try { console.log(JSON.stringify(await run(client, options), null, 2)) } finally { await client.end() }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
