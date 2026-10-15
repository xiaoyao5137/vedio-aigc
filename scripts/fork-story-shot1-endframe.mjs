#!/usr/bin/env node
// Prepare a new first-shot video candidate with a reviewed target end frame.
// Read-only by default. --apply only inserts a NEW execution checkpoint;
// model generation still happens later through the ordinary workflow runner.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { readStorySameMediaReviewRetry, storyShotIdentity } from '../src/story-same-media-retry.ts'
import { validateStoryShotTimingOutput, renderStoryShotTimedActions } from '../src/story-shot-timing.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { prepareKlingImageInputs, buildKlingVideoRequest } from '../server/model-adapters.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const expectedSource = 'record-fb7egd'
const expectedParent = 'record-story-duration-recovery-v1'
const generated = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const fail = message => { throw Error(`STORY_SHOT1_END_FRAME_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function parseArguments(args) {
  const options = { apply: false, id: `record-story-shot1-endframe-${randomUUID().slice(0, 8)}` }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--id': 'id', '--target-url': 'targetUrl', '--human-evidence-url': 'humanEvidenceUrl',
      '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5',
      '--expected-target-sha256': 'targetSha256', '--expected-human-evidence-sha256': 'humanEvidenceSha256' }[flag]
    if (!key || !args[index + 1] || args[index + 1].startsWith('--') || options[`seen_${key}`]) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
    options[`seen_${key}`] = true
  }
  if (options.help) return options
  if (!options.targetUrl || !/^\/generated\/[\w.-]+\.(?:png|jpg|jpeg|webp)$/i.test(options.targetUrl)) fail('--target-url must name a local /generated image')
  if (!/^record-[a-zA-Z0-9_-]+$/.test(options.id) || [expectedSource, expectedParent].includes(options.id)) fail('new record ID is invalid')
  for (const field of ['sourceMd5', 'workflowMd5']) if (options[field] && !/^[a-f0-9]{32}$/i.test(options[field])) fail(`${field} is not a 32-digit MD5`)
  if (options.targetSha256 && !/^[a-f0-9]{64}$/i.test(options.targetSha256)) fail('target SHA256 is invalid')
  if (options.humanEvidenceUrl && !/^\/generated\/[\w.-]+\.json$/.test(options.humanEvidenceUrl)) fail('human evidence must be a local /generated JSON file')
  if (options.humanEvidenceSha256 && !/^[a-f0-9]{64}$/i.test(options.humanEvidenceSha256)) fail('human evidence SHA256 is invalid')
  if (options.apply && (!options.seen_id || !options.sourceMd5 || !options.workflowMd5 || !options.targetSha256)) {
    fail('--apply requires a reviewed ID, source/workflow MD5 values and target SHA256')
  }
  if (options.apply && options.humanEvidenceUrl && !options.humanEvidenceSha256) fail('--apply with human evidence requires its reviewed SHA256')
  return options
}

async function localAsset(url, formats) {
  const filename = url.match(/^\/generated\/([\w.-]+)$/)?.[1]
  if (!filename || !formats.includes(path.extname(filename).toLowerCase())) fail(`invalid local media URL ${url}`)
  const base = await realpath(generated)
  const file = await realpath(path.join(base, filename))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail(`local media missing or unsafe: ${url}`)
  const bytes = await readFile(file)
  return { file, bytes, sha256: sha256(bytes) }
}

async function verifyTarget(targetUrl, firstFrameUrl, sourceVideoUrl) {
  const target = await localAsset(targetUrl, ['.png', '.jpg', '.jpeg', '.webp'])
  const first = await localAsset(firstFrameUrl, ['.png', '.jpg', '.jpeg', '.webp'])
  const video = await localAsset(sourceVideoUrl, ['.mp4', '.mov', '.webm'])
  if (target.bytes.length < 1000 || target.bytes.length > 20 * 1024 * 1024 || target.sha256 === first.sha256) fail('target end frame is missing, oversized or identical to the opening frame')
  const raster = sharp(target.bytes, { failOn: 'error', limitInputPixels: 30_000_000 })
  const info = await raster.metadata()
  await raster.raw().toBuffer()
  if (info.width !== 576 || info.height !== 1024) fail(`target frame must match the 576x1024 opening frame; received ${info.width}x${info.height}`)
  return { target: { url: targetUrl, path: target.file, bytes: target.bytes.length,
    sha256: target.sha256, width: info.width, height: info.height },
    firstFrameSha256: first.sha256, sourceVideoSha256: video.sha256 }
}

async function verifyHumanIncompleteEvidence(url, sourceState, sourceVideoSha256) {
  if (!url) return undefined
  const file = await localAsset(url, ['.json'])
  let evidence
  try { evidence = JSON.parse(file.bytes.toString('utf8')) } catch { fail('human evidence JSON is malformed') }
  const script = sourceState.nodeRuns?.[2]?.output?.shots?.[0]
  const video = sourceState.nodeRuns?.[5]
  const review = video?.output?.storyMediaReview
  const frames = review?.videoEvidence?.frames
  const times = review?.videoEvidence?.frameTimes
  const beat = script?.visualBeats?.[0]
  if (!object(evidence) || evidence.version !== 'story-shot-human-incomplete-v1'
    || evidence.sourceExecutionId !== expectedSource || evidence.sourceVideoUrl !== video?.output?.url
    || evidence.sourceVideoSha256 !== sourceVideoSha256 || evidence.sourceReviewStatus !== review?.reviewStatus
    || evidence.shotIndex !== 0 || evidence.shotIdentitySha256 !== sha256(storyShotIdentity(script))
    || evidence.beatId !== beat?.id || evidence.requiredCompletion !== beat?.completion
    || evidence.verdict !== 'incomplete' || typeof evidence.basis !== 'string' || evidence.basis.length < 30
    || typeof evidence.reason !== 'string' || evidence.reason.length < 30
    || !Array.isArray(evidence.frames) || evidence.frames.length < 2 || !Array.isArray(frames) || !Array.isArray(times)) {
    fail('human conclusion is not bound to the saved shot, review and required completion')
  }
  const seenTimes = new Set()
  for (const item of evidence.frames) {
    const index = times.findIndex(time => time === item?.second)
    if (index < 0 || seenTimes.has(item.second) || item.frameUrl !== frames[index]
      || !/^[a-f0-9]{64}$/.test(String(item.frameSha256))
      || typeof item.observation !== 'string' || item.observation.length < 25) fail('human conclusion contains an unbound or empty frame observation')
    seenTimes.add(item.second)
    const image = await localAsset(item.frameUrl, ['.jpg', '.jpeg'])
    if (image.sha256 !== item.frameSha256) fail(`human evidence frame bytes changed at ${item.second} seconds`)
  }
  if (!seenTimes.has(beat.endSecond) || !seenTimes.has(7)) fail('human conclusion must inspect the planned beat end and the later completed scene')
  return { url, sha256: file.sha256, verdict: evidence.verdict, beatId: evidence.beatId,
    requiredCompletion: evidence.requiredCompletion, reason: evidence.reason,
    frameTimes: [...seenTimes].sort((a, b) => a - b), frameCount: evidence.frames.length }
}

function currentVideoNode(workflow, sourceRun) {
  if (!workflow || workflow.id !== 'wf-story' || workflow.schema_version < 2 || !Array.isArray(workflow.nodes)) fail('current wf-story config is missing')
  const node = workflow.nodes.find(item => item.id === 'node-video')
  if (!node || node.kind !== 'video' || node.modelId !== sourceRun.node.modelId || !Array.isArray(node.params)
    || !node.prompt.includes('${shotTimedActions}') || node.prompt.includes('${shot.content}')) fail('current video node lacks the reviewed timing contract')
  const params = Object.fromEntries(node.params.map(param => [param.englishName, param]))
  if (params.duration?.value !== '${shot.duration}' || params.referenceImage?.value !== '${first_frame}'
    || params.sound?.value !== 'on' || params.camera?.value !== '${shot.camera}' || params.mood?.value !== '${shot.mood}') {
    fail('current video node duration, start frame or sound differs from the reviewed contract')
  }
  if (!params.endImage || params.endImage.type !== 'image' || params.endImage.required || params.endImage.value !== '') {
    fail('current wf-story video node needs an optional endImage parameter with an empty default; do not patch only the pending run node because UI refresh discards it')
  }
  return { node, endImageParamId: params.endImage.id }
}

/** Pure fork preparation after independently validating both source and target. */
export function prepareStoryShot1EndFrameFork(source, workflow, asset, humanEvidence, id, createdAt = new Date().toISOString()) {
  if (!source || source.id !== expectedSource || source.workflow_id !== 'wf-story' || !object(source.result)) fail('unexpected source record')
  const hasher = createJsonHasher()
  const original = decodeExecutionState(source.result)
  if (original.id !== expectedSource || original.parentExecutionId !== expectedParent || original.workflowId !== 'wf-story'
    || !Array.isArray(original.nodeRuns) || original.nodeRuns.length !== 8) fail('source is not the expected review fork')
  const ids = ['node-input', 'node-model-images', 'node-script', 'node-loop', 'node-image', 'node-video', 'node-image', 'node-video']
  if (original.nodeRuns.some((run, at) => run.node?.id !== ids[at]
    || at < 5 && run.status !== 'success' || at === 5 && run.status !== 'failed' || at > 5 && run.status !== 'idle')) {
    fail('source checkpoint order/status differs from the expected first-shot review boundary')
  }
  const [input, modelImages, script, loop, image1, video1, image2, video2] = original.nodeRuns
  const shots = script.output?.shots
  validateStoryShotTimingOutput(shots, { expectedCount: 2 })
  if (shots.some(shot => shot.duration !== 8) || script.output?.model !== 'manual-timing-replan-v1'
    || image1.output?.url !== '/generated/image-f9d550085f556e1e9b8e894f6e052fbc.png'
    || image1.loopIndex !== 0 || video1.loopIndex !== 0 || image2.loopIndex !== 1 || video2.loopIndex !== 1
    || !image1.loopGroupId || [video1, image2, video2].some(run => run.loopGroupId !== image1.loopGroupId)) fail('source story/image/loop binding differs from reviewed fork')
  const sameMedia = readStorySameMediaReviewRetry(video1.retryFeedback, video1)
  const review = video1.output?.storyMediaReview
  if (!sameMedia || sameMedia.sourceExecutionId !== expectedParent
    || sameMedia.sourceVideoSha256 !== asset.sourceVideoSha256) fail('same-media review source does not bind the saved original video bytes')
  const automaticIncomplete = review?.reviewStatus === 'incomplete' && review.retryable === true && review.passed === false
  const independentIncomplete = review?.reviewStatus === 'uncertain' && review.retryable === false && review.passed === false
    && humanEvidence?.verdict === 'incomplete' && humanEvidence.beatId === shots[0].visualBeats[0].id
    && humanEvidence.requiredCompletion === shots[0].visualBeats[0].completion
  if (!automaticIncomplete && !independentIncomplete) {
    fail(`source review is ${String(review?.reviewStatus ?? 'missing')} / retryable=${String(review?.retryable)}; a new paid candidate needs confirmed incomplete evidence or a separately documented human verdict`)
  }
  if (review.videoEvidence?.sha256 !== asset.sourceVideoSha256) fail('source video bytes differ from reviewer evidence')
  if (asset.target.url === image1.output.url || asset.target.sha256 === asset.firstFrameSha256) fail('target end frame equals the opening frame')
  if (video1.paramOverrides !== undefined && Object.keys(video1.paramOverrides).length) fail('source video has manual param overrides requiring separate review')
  const current = currentVideoNode(workflow, video1)
  const refreshed = { ...invalidateRunExecution(video1), node: current.node,
    attempt: 1, errorAttempt: 1, revision: (video1.revision ?? 0) + 1,
    paramOverrides: { [current.endImageParamId]: asset.target.url } }
  const runs = [input, modelImages, script, loop, image1, refreshed, image2, video2]
  const prepared = prepareWorkflowRunContext(runs, 5)
  if (!prepared || prepared.inputContext.shot?.duration !== 8
    || prepared.inputContext.first_frame?.url !== image1.output.url) fail('new shot 1 video context lost the script or opening frame')
  const duration = resolveTemplateJsonValue(current.node.params.find(param => param.englishName === 'duration').value, prepared.inputContext)
  const endImage = refreshed.paramOverrides[current.endImageParamId]
  const timedActions = renderStoryShotTimedActions(shots[0])
  const prompt = renderWorkflowTemplate(current.node.prompt, { ...prepared.inputContext, shotTimedActions: timedActions })
  if (duration !== 8 || endImage !== asset.target.url || !prompt.includes(timedActions)
    || prompt.includes('${') || !prompt.includes('8 秒内')) fail('new video request no longer matches the 8-second timed action plan')
  const sourceOutputHash = hasher(video1.output)
  const recovery = { version: 'story-shot1-target-end-frame-v1',
    method: independentIncomplete ? 'new-candidate-after-independent-frame-review' : 'new-candidate-after-confirmed-incomplete-review',
    createdAt, sourceExecutionId: expectedSource, sourceRunId: video1.id, sourceVideoUrl: video1.output.url,
    sourceVideoSha256: asset.sourceVideoSha256, sourceVideoOutputSha256: sourceOutputHash,
    sourceReviewStatus: review.reviewStatus, sourceReviewEvidenceUrl: review.videoEvidence?.evidenceUrl,
    ...(independentIncomplete ? { humanEvidenceUrl: humanEvidence.url, humanEvidenceSha256: humanEvidence.sha256,
      humanVerdict: humanEvidence.verdict, humanReason: humanEvidence.reason } : {}),
    targetEndFrameUrl: asset.target.url, targetEndFrameSha256: asset.target.sha256,
    openingFrameUrl: image1.output.url, openingFrameSha256: asset.firstFrameSha256 }
  const state = { ...original, id, parentExecutionId: expectedSource, generationScopeId: id,
    requestScopeId: original.requestScopeId ?? expectedSource, historical: false, mode: 'step',
    nodeRuns: runs, context: image1.context, selectedNodeId: 'node-video',
    logs: [...runs.slice(0, 5).map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `从 ${expectedSource} 保存的新候选：原片留在父记录，首镜视频绑定目标尾帧 ${asset.target.url}，等待显式继续执行。`],
    storyShot1TargetEndFrameRecovery: recovery }
  const encoded = encodeExecutionState(state)
  if (hasher(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hasher(state)) fail('fork storage round trip changed the candidate')
  return { state, encoded, proof: { version: recovery.version, sourceRecordId: expectedSource,
    sourceResultMd5: source.result_md5, workflowNodesMd5: workflow.nodes_md5,
    newRecordId: id, createdAt, firstPendingIndex: 5, firstPendingNodeId: 'node-video',
    preservedPrefixRunIds: runs.slice(0, 5).map(run => run.id),
    preservedPrefixHash: hasher(runs.slice(0, 5)),
    sourceVideoOutputSha256: sourceOutputHash, sourceReviewStatus: review.reviewStatus,
    sourceReviewRetryable: review.retryable, sourceVideoUrl: video1.output.url,
    ...(independentIncomplete ? { independentHumanEvidence: humanEvidence } : {}),
    sourceVideoSha256: asset.sourceVideoSha256, target: asset.target,
    openingFrameSha256: asset.firstFrameSha256, resolvedDuration: duration,
    endImageParamId: current.endImageParamId, endImageBinding: endImage,
    timedActions, providerFieldExpected: 'image_tail', modelCalls: 0, sourceUnchanged: true } }
}

async function run(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [expectedSource])).rows[0]
    if (!source) fail('same-media review fork is missing')
    if (options.sourceMd5 && options.sourceMd5.toLowerCase() !== source.result_md5) fail('source record changed since reviewed dry run')
    const workflow = (await client.query(`SELECT *, md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${options.apply ? ' FOR SHARE' : ''}`)).rows[0]
    if (!workflow) fail('wf-story workflow config is missing')
    if (options.workflowMd5 && options.workflowMd5.toLowerCase() !== workflow.nodes_md5) fail('workflow changed since reviewed dry run')
    const sourceState = decodeExecutionState(source.result)
    const sourceVideoUrl = sourceState.nodeRuns?.[5]?.output?.url
    const firstFrameUrl = sourceState.nodeRuns?.[4]?.output?.url
    if (typeof sourceVideoUrl !== 'string' || typeof firstFrameUrl !== 'string') fail('source video or opening frame is missing')
    const asset = await verifyTarget(options.targetUrl, firstFrameUrl, sourceVideoUrl)
    if (options.targetSha256 && options.targetSha256.toLowerCase() !== asset.target.sha256) fail('target image bytes changed since reviewed dry run')
    const humanEvidence = await verifyHumanIncompleteEvidence(options.humanEvidenceUrl, sourceState, asset.sourceVideoSha256)
    if (options.humanEvidenceSha256 && options.humanEvidenceSha256.toLowerCase() !== humanEvidence?.sha256) fail('human evidence changed since reviewed dry run')
    const prepared = prepareStoryShot1EndFrameFork(source, workflow, asset, humanEvidence, options.id)
    const localParams = await prepareKlingImageInputs({ referenceImage: firstFrameUrl, endImage: asset.target.url, duration: 8, sound: 'on' }, generated)
    const provider = buildKlingVideoRequest({ settings: { model: 'kling-v3', mode: 'std' } }, '保持开场与目标尾帧连续。', localParams)
    if (provider.duration !== '8' || typeof provider.image !== 'string' || typeof provider.image_tail !== 'string'
      || !provider.image.length || !provider.image_tail.length) fail('Kling adapter did not bind the first and target end frames')
    if (options.apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `打工猫首镜目标尾帧恢复 · ${expectedSource}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('inserted candidate differs from dry-run state')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [expectedSource])).rows[0]?.result_md5
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]?.nodes_md5
    if (sourceAfter !== source.result_md5 || workflowAfter !== workflow.nodes_md5) fail('source or workflow changed during fork')
    await client.query('COMMIT')
    return { ...prepared.proof, sourceResultMd5After: sourceAfter, workflowNodesMd5After: workflowAfter,
      providerFirstFrameBound: true, providerTargetEndFrameBound: true, applied: options.apply }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-shot1-endframe.mjs --target-url /generated/target.png [--human-evidence-url /generated/review.json] [--id NEW_ID] [--expected-source-md5 MD5] [--expected-workflow-md5 MD5] [--expected-target-sha256 SHA256] [--expected-human-evidence-sha256 SHA256] [--apply]\nDefault is read-only. --apply only inserts a new execution record; it never submits video generation.')
    return
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    const client = await pool.connect()
    try { console.log(JSON.stringify(await run(client, options), null, 2)) } finally { client.release() }
  } finally { await pool.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
