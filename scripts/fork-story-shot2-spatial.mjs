#!/usr/bin/env node
// Fork an accepted first-shot candidate immediately before shot 2's first frame.
// Preview is read-only. --apply only inserts a new idle checkpoint; it never
// invokes an image or video model. Do not apply until the shot 1 film is accepted.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { createStoryScriptSource, renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { validateStoryShotAssessment } from '../server/story-media-review.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { generatedAsset, loadHumanStoryReview, validateHumanStoryReview,
  verifyHumanStoryReviewFrames } from './story-shot-human-review.mjs'

const originalId = 'record-a7c0ix'
const oldPlacement = ' 柴犬位于蓝猫身体后侧，犬口鼻正对猫背部中段，猫背中段完整无遮挡；犬下巴与猫背留有几厘米可见空隙。'
export const newPlacement = '从桌面侧前方平视：蓝猫身体横向铺在桌上，头朝画面右前，背部中段位于画面左中；柴犬在猫身左后方，头从该背段正上方探近，犬下颌距猫背3—5厘米，垂直对准背中段而非头、耳或颈；两者同一纵深，猫脸与猫背均可见。'
const generated = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const expectedNodes = ['node-input', 'node-model-images', 'node-script', 'node-loop', 'node-image', 'node-video', 'node-image', 'node-video']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw Error(`STORY_SHOT2_SPATIAL_FORK_INVALID: ${message}`) }
const hasValue = (value, key) => object(value) && Object.hasOwn(value, key) && value[key] !== undefined
const urlOf = value => typeof value === 'string' ? value : object(value) && typeof value.url === 'string' ? value.url : ''

function parseArguments(args) {
  const options = { apply: false, id: `record-story-shot2-spatial-${randomUUID().slice(0, 8)}` }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help') { options.help = true; continue }
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    const key = { '--source-record': 'sourceId', '--id': 'id', '--expected-source-md5': 'sourceMd5',
      '--expected-original-md5': 'originalMd5', '--expected-workflow-md5': 'workflowMd5',
      '--accepted-shot1-sha256': 'acceptedVideoSha256' }[flag]
    if (!key || !args[index + 1] || args[index + 1].startsWith('--') || options[`seen_${key}`]) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
    options[`seen_${key}`] = true
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '') || options.sourceId === originalId) fail('--source-record must identify an accepted first-shot fork')
  if (!/^record-[\w-]+$/.test(options.id) || [options.sourceId, originalId].includes(options.id)) fail('new record ID is invalid')
  for (const key of ['sourceMd5', 'originalMd5', 'workflowMd5']) {
    if (options[key] && !/^[a-f\d]{32}$/i.test(options[key])) fail(`${key} must be an MD5 digest`)
  }
  if (options.acceptedVideoSha256 && !/^[a-f\d]{64}$/i.test(options.acceptedVideoSha256)) fail('accepted shot 1 SHA256 is invalid')
  if (options.apply && (!options.seen_id || !options.sourceMd5 || !options.originalMd5
    || !options.workflowMd5 || !options.acceptedVideoSha256)) {
    fail('--apply requires a reviewed ID, all source/workflow MD5 values and the accepted shot 1 video SHA256')
  }
  return options
}

async function localSha256(url, extensions) {
  const filename = /^\/generated\/([\w.-]+)$/.exec(url)?.[1]
  if (!filename || !extensions.includes(path.extname(filename).toLowerCase())) fail('completed shot 1 media must have a local generated URL')
  const base = await realpath(generated)
  const file = await realpath(path.join(base, filename))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('completed shot 1 media is missing or unsafe')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function verifyAcceptedReview(shot, image, video, media, sourceState, humanSource) {
  const review = video.output?.storyMediaReview
  const evidence = review?.videoEvidence
  if (image.output?.model !== 'codex-gpt-image-2' || video.output?.model !== 'keling3'
    || !/^\/generated\/[\w.-]+\.(?:png|jpg|jpeg|webp)$/i.test(urlOf(image.output))
    || !/^\/generated\/[\w.-]+\.(?:mp4|mov|webm)$/i.test(urlOf(video.output))) fail('completed first-shot media is missing or from the wrong models')
  if (media.imageSha256 === media.videoSha256 || !/^[a-f\d]{64}$/.test(media.imageSha256)
    || !/^[a-f\d]{64}$/.test(media.videoSha256)) fail('completed first-shot media hash is invalid')
  if (urlOf(video.inputs?.referenceImage) !== image.output.url
    || urlOf(video.output?.params?.referenceImage) !== image.output.url
    || urlOf(video.inputContext?.first_frame) !== image.output.url
    || Number(video.output?.params?.duration) !== shot.duration
    || !String(image.output?.prompt ?? '').includes(shot.firstFramePrompt)
    || !String(video.output?.prompt ?? '').includes(renderStoryShotTimedActions(shot))) {
    fail('completed first-shot media is not bound to its saved first frame and 8-second script')
  }
  if (evidence?.decoded !== true || evidence.sha256 !== media.videoSha256 || evidence.url !== video.output.url) {
    fail('shot 1 review does not bind the actual video bytes')
  }
  if (review?.reviewStatus === 'passed') {
    if (review.passed !== true || !Array.isArray(review.issues) || review.issues.length
      || !Array.isArray(review.beatChecks)) fail('shot 1 has no matching passed media review')
    const validated = validateStoryShotAssessment(shot, evidence, review.observations, review.assessment)
    if (!validated.passed || validated.reviewStatus !== 'passed' || validated.issues.length
      || validated.beatChecks.length !== review.beatChecks.length
      || validated.beatChecks.some((check, index) => check.id !== review.beatChecks[index]?.id
        || check.status !== review.beatChecks[index]?.status)
      || validated.endingHold?.status !== review.endingHold?.status) fail('shot 1 saved review does not revalidate against its evidence')
    return { method: 'automated-passed' }
  }
  const human = sourceState.humanStoryReview
  const recovery = sourceState.storyShot1HumanReviewRecovery
  if (review?.reviewStatus !== 'uncertain' || review.passed !== false || review.retryable !== false
    || !humanSource || !human || !recovery || recovery.sourceExecutionId !== humanSource.id
    || sourceState.parentExecutionId !== humanSource.id || recovery.sourceResultMd5 !== humanSource.result_md5
    || recovery.reviewFileSha256 !== human.evidenceFileSha256 || recovery.videoSha256 !== media.videoSha256
    || recovery.firstFrameSha256 !== media.imageSha256 || recovery.sourceVideoOutputSha256 !== createJsonHasher()(video.output)
    || humanSource.result?.nodeRuns?.[5]?.status !== 'failed'
    || createJsonHasher()(humanSource.result.nodeRuns[5].output) !== createJsonHasher()(video.output)) {
    fail('shot 1 has no matching independent visual acceptance')
  }
  const revalidated = validateHumanStoryReview(human, humanSource, media, human.evidenceFileSha256)
  if (createJsonHasher()(revalidated) !== createJsonHasher()(human)) fail('independent visual acceptance does not revalidate')
  return { method: 'direct-visual-pass', evidenceFileSha256: human.evidenceFileSha256,
    sourceReviewStatus: 'uncertain', sourceRecordId: humanSource.id }
}

function pending(run) {
  return run.status === 'idle' && !hasValue(run, 'output') && !hasValue(run, 'error')
    && !Object.keys(run.context ?? {}).length && !Object.keys(run.inputs ?? {}).length
    && !Object.keys(run.inputContext ?? {}).length && !Object.keys(run.paramOverrides ?? {}).length
}

/** Pure preparation. The caller must hash real local media and verify its DB snapshots. */
export function prepareStoryShot2SpatialFork(source, originalRow, workflow, media, id,
  createdAt = new Date().toISOString(), humanSource = undefined) {
  if (!object(source) || !object(originalRow) || !object(workflow) || !object(media)
    || source.workflow_id !== 'wf-story' || originalRow.id !== originalId || originalRow.workflow_id !== 'wf-story'
    || workflow.id !== 'wf-story' || workflow.schema_version < 3
    || !Array.isArray(workflow.nodes)) fail('source, original story or workflow is missing')
  if (!/^record-[\w-]+$/.test(id) || [source.id, originalId].includes(id)) fail('invalid fork ID')
  const hash = createJsonHasher()
  const sourceState = decodeExecutionState(source.result)
  const originalState = decodeExecutionState(originalRow.result)
  const sourceHashBefore = hash(sourceState), originalHashBefore = hash(originalState)
  const runs = sourceState.nodeRuns, originalRuns = originalState.nodeRuns
  if (sourceState.id !== source.id || sourceState.workflowId !== 'wf-story'
    || !Array.isArray(runs) || runs.length !== expectedNodes.length
    || runs.some((run, index) => run.node?.id !== expectedNodes[index]
      || index < 6 && run.status !== 'success' || index >= 6 && !pending(run))) {
    fail('source must have six successful prefix runs and two untouched idle shot 2 runs')
  }
  if (originalState.id !== originalId || originalState.workflowId !== 'wf-story'
    || !Array.isArray(originalRuns) || originalRuns[2]?.node?.id !== 'node-script') fail('original story identity is invalid')
  const [input, refs, script, loop, image1, video1, image2, video2] = runs
  const completedMediaHashBefore = hash(runs.slice(4, 6))
  if (image1.loopIndex !== 0 || video1.loopIndex !== 0 || image2.loopIndex !== 1 || video2.loopIndex !== 1
    || !image1.loopGroupId || [video1, image2, video2].some(run => run.loopGroupId !== image1.loopGroupId)) fail('two-shot loop order changed')
  const originalScript = originalRuns[2]
  const storySource = createStoryScriptSource(originalScript.output, { sourceExecutionId: originalId, sourceRunId: originalScript.id })
  const output = script.output
  const shots = output?.shots
  if (!object(output) || output.model !== 'manual-timing-replan-v1' || !Array.isArray(shots)
    || hash(output.items) !== hash(shots) || !Array.isArray(JSON.parse(output.text ?? 'null'))
    || hash(JSON.parse(output.text)) !== hash(shots)
    || output.recovery?.sourceExecutionId !== originalId || output.recovery?.sourceRunId !== originalScript.id
    || output.recovery?.sourceScriptOutputSha256 !== hash(originalScript.output)
    || hash(sourceState.storyTwoShotRecovery) !== hash(output.recovery)) fail('source script copies or original-story provenance diverged')
  validateStoryShotTimingOutput(shots, { expectedCount: 2, source: storySource })
  if (shots.some(shot => shot.duration !== 8) || shots[0].firstFramePrompt !== storySource.shots[0].firstFramePrompt
    || shots[1].firstFramePrompt !== storySource.shots[1].firstFramePrompt + oldPlacement
    || image1.loopItem?.firstFramePrompt !== shots[0].firstFramePrompt
    || video1.loopItem?.firstFramePrompt !== shots[0].firstFramePrompt
    || image2.loopItem?.firstFramePrompt !== shots[1].firstFramePrompt
    || video2.loopItem?.firstFramePrompt !== shots[1].firstFramePrompt) fail('first frame, old shot 2 placement or shot order changed')
  if (output.recovery?.reusedImage1Url !== image1.output?.url
    || !Array.isArray(refs.output?.items) || refs.output.items.length !== 4) {
    fail('completed shot 1 first frame or its four identity references differ from the reviewed recovery')
  }
  if (hash(script.context?.script_generation) !== hash(output)
    || hash(loop.inputContext?.script_generation) !== hash(output)
    || hash(loop.context?.script_generation) !== hash(output)
    || loop.output?.count !== 2 || loop.output?.loopSource !== 'script_generation.shots') fail('script and loop contexts are inconsistent')
  const acceptance = verifyAcceptedReview(shots[0], image1, video1, media, sourceState, humanSource)
  const currentImage = workflow.nodes.find(node => node.id === 'node-image')
  const currentVideo = workflow.nodes.find(node => node.id === 'node-video')
  if (!currentImage || !currentVideo || hash(currentImage) !== hash(image2.node)
    || hash(currentVideo) !== hash(video2.node)
    || currentImage.modelId !== 'codex-gpt-image-2' || currentVideo.modelId !== 'keling3') {
    fail('saved pending nodes differ from the current reviewed workflow')
  }
  if (newPlacement.length !== 101 || newPlacement.length > 140) fail('new placement exceeds the source-locked clarification budget')
  const nextShots = [shots[0], { ...shots[1], firstFramePrompt: storySource.shots[1].firstFramePrompt + ' ' + newPlacement }]
  validateStoryShotTimingOutput(nextShots, { expectedCount: 2, source: storySource })
  if (hash(nextShots[0]) !== hash(shots[0]) || hash({ ...nextShots[1], firstFramePrompt: undefined })
    !== hash({ ...shots[1], firstFramePrompt: undefined })) fail('the new script changed anything beyond shot 2 spatial text')
  const nextOutput = { ...output, shots: nextShots, items: nextShots, text: JSON.stringify(nextShots, null, 2) }
  const nextScript = { ...script, output: nextOutput, context: { ...script.context, script_generation: nextOutput },
    revision: (script.revision ?? 0) + 1 }
  const nextLoop = { ...loop, inputContext: { ...loop.inputContext, script_generation: nextOutput },
    context: { ...loop.context, script_generation: nextOutput }, revision: (loop.revision ?? 0) + 1 }
  const nextImage2 = { ...invalidateRunExecution(image2), loopItem: nextShots[1],
    routeInputContext: nextLoop.context, attempt: 1, errorAttempt: 1, revision: (image2.revision ?? 0) + 1 }
  const nextVideo2 = { ...invalidateRunExecution(video2), loopItem: nextShots[1],
    attempt: 1, errorAttempt: 1, revision: (video2.revision ?? 0) + 1 }
  const nextRuns = [input, refs, nextScript, nextLoop, image1, video1, nextImage2, nextVideo2]
  const preparedImage = prepareWorkflowRunContext(nextRuns, 6)
  if (preparedImage?.inputContext?.shot?.firstFramePrompt !== nextShots[1].firstFramePrompt
    || hash(preparedImage.inputContext.script_generation) !== hash(nextOutput)
    || hash(preparedImage.inputContext.model_images?.items) !== hash(refs.output?.items)) fail('pending shot 2 first frame has stale script or character references')
  const imagePrompt = renderWorkflowTemplate(currentImage.prompt, preparedImage.inputContext)
  const imageParams = Object.fromEntries(currentImage.params.map(param => [param.englishName,
    resolveTemplateJsonValue(param.value, preparedImage.inputContext)]))
  if (!imagePrompt.includes(nextShots[1].firstFramePrompt) || imagePrompt.includes(oldPlacement)
    || imagePrompt.includes('${') || imageParams.size !== '576x1024' || imageParams.singleFrame !== true
    && imageParams.singleFrame !== 'true' || hash(imageParams.referenceImages) !== hash(refs.output.items)) {
    fail('pending first-frame request does not bind the new placement and saved references')
  }
  // Preview video resolution with a fake future first frame, without changing
  // the fork or calling a provider. Runtime will use the actual new image.
  const previewFrame = { url: '/generated/__shot2_preview_only__.png' }
  const previewImage = { ...nextImage2, status: 'success', output: previewFrame,
    context: { ...preparedImage.inputContext, first_frame: previewFrame } }
  const previewRuns = [...nextRuns.slice(0, 6), previewImage, nextVideo2]
  const preparedVideo = prepareWorkflowRunContext(previewRuns, 7)
  const timedActions = renderStoryShotTimedActions(nextShots[1])
  const videoPrompt = renderWorkflowTemplate(currentVideo.prompt,
    { ...preparedVideo.inputContext, shotTimedActions: timedActions })
  const videoParams = Object.fromEntries(currentVideo.params.map(param => [param.englishName,
    resolveTemplateJsonValue(param.value, preparedVideo.inputContext)]))
  if (preparedVideo.inputContext.shot?.firstFramePrompt !== nextShots[1].firstFramePrompt
    || videoParams.duration !== 8 || urlOf(videoParams.referenceImage) !== previewFrame.url
    || videoParams.endImage !== '' || !videoPrompt.includes(timedActions) || videoPrompt.includes('${')) {
    fail('future shot 2 video request is not bound to the new first frame and unchanged 8-second actions')
  }
  const recovery = { version: 'story-shot2-spatial-fork-v1', createdAt,
    sourceExecutionId: source.id, originalExecutionId: originalId, acceptedShot1VideoSha256: media.videoSha256,
    acceptedShot1ImageSha256: media.imageSha256, shot1Acceptance: acceptance,
    sourceShot2PromptSha256: createHash('sha256').update(shots[1].firstFramePrompt).digest('hex'),
    placement: newPlacement }
  const state = { ...sourceState, id, parentExecutionId: source.id, generationScopeId: id,
    requestScopeId: sourceState.requestScopeId ?? source.id, historical: false, mode: 'step',
    nodeRuns: nextRuns, context: { ...sourceState.context, script_generation: nextOutput },
    selectedNodeId: 'node-image', logs: [...(sourceState.logs ?? []),
      `第一镜完成素材保留；第二镜首帧空间说明已更新，等待显式继续执行。`],
    storyShot2SpatialRecovery: recovery }
  const encoded = encodeExecutionState(state)
  const afterHash = createJsonHasher()
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)
    || afterHash(sourceState) !== sourceHashBefore || afterHash(originalState) !== originalHashBefore
    || afterHash(nextRuns.slice(4, 6)) !== completedMediaHashBefore
    || hash(nextOutput.items) !== hash(nextOutput.shots)
    || hash(JSON.parse(nextOutput.text)) !== hash(nextOutput.shots)
    || nextRuns.findIndex(run => run.status === 'idle') !== 6
    || !pending(nextImage2) || !pending(nextVideo2)) {
    fail('fork changed the original state, completed media or pending boundary')
  }
  return { state, encoded, proof: { version: recovery.version, sourceRecordId: source.id,
    sourceResultMd5: source.result_md5, originalResultMd5: originalRow.result_md5,
    workflowNodesMd5: workflow.nodes_md5, newRecordId: id, createdAt,
    firstPendingIndex: 6, firstPendingNodeId: 'node-image', pendingStatuses: nextRuns.slice(6).map(run => run.status),
    preservedMediaRunIds: [image1.id, video1.id], preservedMediaRunsSha256: completedMediaHashBefore,
    acceptedShot1VideoSha256: media.videoSha256, shot1Acceptance: acceptance,
    sourceShot2PromptSha256: recovery.sourceShot2PromptSha256,
    newShot2PromptSha256: createHash('sha256').update(nextShots[1].firstFramePrompt).digest('hex'),
    sourceLocked: true, unchangedActionsAndTiming: true, newPlacement,
    resolvedImageSize: imageParams.size, resolvedVideoDuration: videoParams.duration,
    videoFirstFrameBinding: 'new shot 2 image when generated', endImage: '',
    sourceUnchanged: true, originalUnchanged: true, modelCalls: 0 } }
}

async function run(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const lock = options.apply ? ' FOR SHARE' : ''
    const source = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`,
      [options.sourceId])).rows[0]
    const original = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`,
      [originalId])).rows[0]
    const workflow = (await client.query(`SELECT *,md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !original || !workflow) fail('source, original or workflow was not found')
    for (const [key, actual] of [['sourceMd5', source.result_md5], ['originalMd5', original.result_md5],
      ['workflowMd5', workflow.nodes_md5]]) if (options[key] && options[key].toLowerCase() !== actual) fail(`${key} differs from the reviewed preview`)
    const state = decodeExecutionState(source.result)
    const imageUrl = urlOf(state.nodeRuns?.[4]?.output), videoUrl = urlOf(state.nodeRuns?.[5]?.output)
    const media = { imageSha256: await localSha256(imageUrl, ['.png', '.jpg', '.jpeg', '.webp']),
      videoSha256: await localSha256(videoUrl, ['.mp4', '.mov', '.webm']) }
    if (options.acceptedVideoSha256 && options.acceptedVideoSha256.toLowerCase() !== media.videoSha256) {
      fail('accepted shot 1 video bytes changed since review')
    }
    let humanSource
    if (state.humanStoryReview) {
      const recovery = state.storyShot1HumanReviewRecovery
      if (!/^record-[\w-]+$/.test(recovery?.sourceExecutionId ?? '')) fail('human review source ID is missing')
      const parent = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`,
        [recovery.sourceExecutionId])).rows[0]
      if (!parent || parent.result_md5 !== recovery.sourceResultMd5) fail('uncertain parent record changed or is missing')
      humanSource = { ...parent, result: decodeExecutionState(parent.result) }
      const loaded = await loadHumanStoryReview(recovery.reviewFile)
      if (loaded.sha256 !== recovery.reviewFileSha256) fail('direct visual report changed')
      const expected = validateHumanStoryReview(loaded.report, humanSource, media, loaded.sha256)
      if (createJsonHasher()(expected) !== createJsonHasher()(state.humanStoryReview)) fail('saved direct visual report differs from its file')
      const manifest = await generatedAsset(expected.audioLevelManifest.url, ['.json'])
      if (manifest.sha256 !== expected.audioLevelManifest.sha256) fail('audio derivative manifest changed')
      const video = await generatedAsset(videoUrl, ['.mp4', '.mov', '.webm'])
      await verifyHumanStoryReviewFrames(expected, video.file)
    }
    const prepared = prepareStoryShot2SpatialFork(source, original, workflow, media, options.id,
      new Date().toISOString(), humanSource)
    if (options.apply) {
      const { state: fork, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        fork.id, source.workflow_id, source.workflow_name, `打工猫第二镜空间修正 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
        fork.nodeRuns.filter(item => item.status === 'success').length, fork.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [fork.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(fork)) {
        fail('inserted fork differs from reviewed preparation')
      }
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.md5
    const originalAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [originalId])).rows[0]?.md5
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]?.md5
    const humanSourceAfter = humanSource
      ? (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [humanSource.id])).rows[0]?.md5
      : undefined
    if (sourceAfter !== source.result_md5 || originalAfter !== original.result_md5 || workflowAfter !== workflow.nodes_md5) {
      fail('source, original or workflow changed during preparation')
    }
    if (humanSource && humanSourceAfter !== humanSource.result_md5) fail('uncertain parent changed during preparation')
    await client.query('COMMIT')
    return { ...prepared.proof, sourceResultMd5After: sourceAfter, originalResultMd5After: originalAfter,
      workflowNodesMd5After: workflowAfter, applied: options.apply,
      humanReviewBoundary: 'The supplied accepted shot 1 SHA256 must identify the film the user reviewed.' }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-shot2-spatial.mjs --source-record RECORD [--id NEW_RECORD] [--expected-source-md5 MD5] [--expected-original-md5 MD5] [--expected-workflow-md5 MD5] [--accepted-shot1-sha256 SHA256] [--apply]\nDefault is read-only. --apply inserts an idle fork only after independent shot 1 acceptance; it never calls a model.')
    return
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try { console.log(JSON.stringify(await run(db, options), null, 2)) } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
