#!/usr/bin/env node
// Prepare the office-nap shot's target end frame from its actual opening frame.
// The optional gaze-v2 variant edits the saved v1 target, preserving every
// completed first-frame/video run and creating a separate image request ledger.
// `generate` submits one Codex image request only with --apply. `attach` creates
// an idle video checkpoint only with --apply. Both modes are read-only otherwise.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { createStoryScriptSource, renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { prepareKlingImageInputs, buildKlingVideoRequest } from '../server/model-adapters.ts'
import { modelRequestFingerprint } from '../server/model-request-key.ts'
import { validateStoryShotAssessment } from '../server/story-media-review.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { generatedAsset, loadHumanStoryReview, validateHumanStoryReview,
  verifyHumanStoryReviewFrames } from './story-shot-human-review.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const generated = path.join(root, 'public/generated')
const originalId = 'record-a7c0ix'
const expectedNodes = ['node-input', 'node-model-images', 'node-script', 'node-loop', 'node-image', 'node-video', 'node-image', 'node-video']
const version = 'v1'
const gazeVariant = 'gaze-v2'
const v1TargetLedgerId = 'model-run-mulmmhtz-zlllro9'
const v1TargetUrl = '/generated/image-1e1ba74ea34f38853c059cc7575f947e.png'
const v1TargetSha256 = '1e1ba74ea34f38853c059cc7575f947e2d5ae02646668c22921317fdfd70f6b2'
const fail = message => { throw Error(`STORY_SHOT2_TARGET_END_FRAME_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const urlOf = value => typeof value === 'string' ? value : object(value) && typeof value.url === 'string' ? value.url : ''

function parseArguments(args) {
  const options = { mode: args[0], variant: 'original-v1', apply: false,
    id: `record-story-shot2-endframe-${randomUUID().slice(0, 8)}` }
  if (args.includes('--help') || args.length === 0) { options.help = true; return options }
  if (!['generate', 'attach'].includes(options.mode)) fail('first argument must be generate or attach')
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    const key = { '--source-record': 'sourceId', '--variant': 'variant', '--id': 'id', '--target-url': 'targetUrl',
      '--expected-source-md5': 'sourceMd5', '--expected-original-md5': 'originalMd5',
      '--expected-workflow-md5': 'workflowMd5', '--expected-first-frame-sha256': 'firstFrameSha256',
      '--expected-target-sha256': 'targetSha256' }[flag]
    if (!key || !args[index + 1] || args[index + 1].startsWith('--') || options[`seen_${key}`]) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
    options[`seen_${key}`] = true
  }
  if (!['original-v1', gazeVariant].includes(options.variant)) fail('--variant must be original-v1 or gaze-v2')
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '') || options.sourceId === originalId) fail('--source-record is required')
  if (options.mode === 'generate' && (options.seen_id || options.targetUrl || options.targetSha256)) fail('generate does not accept attach arguments')
  if (options.mode === 'attach' && (!/^record-[\w-]+$/.test(options.id) || [options.sourceId, originalId].includes(options.id)
    || !/^\/generated\/[\w.-]+\.(?:png|jpg|jpeg|webp)$/i.test(options.targetUrl ?? ''))) {
    fail('attach requires a new record ID and a local target image URL')
  }
  for (const key of ['sourceMd5', 'originalMd5', 'workflowMd5']) if (options[key] && !/^[a-f\d]{32}$/i.test(options[key])) fail(`${key} is not an MD5 digest`)
  for (const key of ['firstFrameSha256', 'targetSha256']) if (options[key] && !/^[a-f\d]{64}$/i.test(options[key])) fail(`${key} is not a SHA256 digest`)
  if (options.apply && (!options.sourceMd5 || !options.originalMd5 || !options.workflowMd5 || !options.firstFrameSha256
    || options.mode === 'attach' && (!options.seen_id || !options.targetSha256))) {
    fail('--apply requires reviewed source/original/workflow hashes, opening-frame SHA256, and for attach an explicit new ID and target SHA256')
  }
  return options
}

async function localAsset(url, allowedExtensions) {
  const filename = /^\/generated\/([\w.-]+)$/.exec(url)?.[1]
  if (!filename || !allowedExtensions.includes(path.extname(filename).toLowerCase())) fail('media URL is not a local generated asset')
  const base = await realpath(generated)
  const file = await realpath(path.join(base, filename))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('media file is missing or escapes generated directory')
  const bytes = await readFile(file)
  return { file, bytes, sha256: sha256(bytes), url }
}

async function imageAsset(url) {
  const asset = await localAsset(url, ['.png', '.jpg', '.jpeg', '.webp'])
  if (asset.bytes.length < 1000 || asset.bytes.length > 20 * 1024 * 1024) fail('image size is outside the reviewed range')
  const raster = sharp(asset.bytes, { failOn: 'error', limitInputPixels: 30_000_000 })
  const meta = await raster.metadata()
  await raster.raw().toBuffer()
  if (meta.width !== 576 || meta.height !== 1024) fail('image must be 576x1024 to match the shot')
  return { ...asset, width: meta.width, height: meta.height }
}

/** A human visual verdict must remain distinguishable from the model's result. */
export function storyShot2AcceptanceRoute(recovery, review) {
  const method = recovery?.shot1Acceptance?.method
  if (method === 'automated-passed') {
    if (review?.reviewStatus !== 'passed' || review.passed !== true || review.issues?.length
      || !Array.isArray(review.issues) || !Array.isArray(review.beatChecks)) {
      fail('completed first shot lacks a passed automated assessment')
    }
    return method
  }
  if (method === 'direct-visual-pass') {
    if (review?.reviewStatus !== 'uncertain' || review.passed !== false || review.retryable !== false) {
      fail('direct visual acceptance must preserve the uncertain model assessment')
    }
    return method
  }
  fail('first shot has no verified automated or direct visual acceptance')
}

/** The same source boundary is checked before either a paid request or a fork. */
export async function verifyStoryShot2TargetSource(source, original, workflow, humanProvenance) {
  if (!object(source) || !object(original) || !object(workflow) || source.workflow_id !== 'wf-story'
    || original.id !== originalId || original.workflow_id !== 'wf-story' || workflow.id !== 'wf-story'
    || workflow.schema_version < 3 || !Array.isArray(workflow.nodes)) fail('story source, original or workflow is missing')
  const hash = createJsonHasher()
  const state = decodeExecutionState(source.result), originalState = decodeExecutionState(original.result)
  const runs = state.nodeRuns, originalRuns = originalState.nodeRuns
  if (state.id !== source.id || state.workflowId !== 'wf-story' || !Array.isArray(runs) || runs.length !== 8
    || runs.some((run, index) => run.node?.id !== expectedNodes[index]
      || index < 7 && run.status !== 'success' || index === 7 && run.status !== 'idle')
    || originalState.id !== originalId || originalState.workflowId !== 'wf-story'
    || originalRuns?.[2]?.node?.id !== 'node-script') fail('source must have seven successful runs and an untouched shot 2 video')
  const [input, refs, script, loop, image1, video1, image2, video2] = runs
  const recovery = state.storyShot2SpatialRecovery
  if (recovery?.version !== 'story-shot2-spatial-fork-v1' || recovery.originalExecutionId !== originalId
    || recovery.sourceExecutionId !== state.parentExecutionId || !state.parentExecutionId
    || image1.loopIndex !== 0 || video1.loopIndex !== 0 || image2.loopIndex !== 1 || video2.loopIndex !== 1
    || !image1.loopGroupId || [video1, image2, video2].some(run => run.loopGroupId !== image1.loopGroupId)
    || Object.keys(video2.paramOverrides ?? {}).length || video2.output !== undefined || video2.error !== undefined) {
    fail('source is not the reviewed spatial fork at the shot 2 video boundary')
  }
  const originalScript = originalRuns[2]
  const sourceScript = createStoryScriptSource(originalScript.output,
    { sourceExecutionId: originalId, sourceRunId: originalScript.id })
  const output = script.output, shots = output?.shots
  validateStoryShotTimingOutput(shots, { expectedCount: 2, source: sourceScript })
  if (output?.model !== 'manual-timing-replan-v1' || shots.some(shot => shot.duration !== 8)
    || hash(output.items) !== hash(shots) || hash(JSON.parse(output.text ?? 'null')) !== hash(shots)
    || output.recovery?.sourceExecutionId !== originalId || output.recovery?.sourceRunId !== originalScript.id
    || output.recovery?.sourceScriptOutputSha256 !== hash(originalScript.output)
    || hash(state.storyTwoShotRecovery) !== hash(output.recovery)
    || shots[0].firstFramePrompt !== sourceScript.shots[0].firstFramePrompt
    || shots[1].firstFramePrompt !== sourceScript.shots[1].firstFramePrompt + ' ' + recovery.placement
    || !recovery.placement || recovery.placement.length > 140
    || hash(script.context?.script_generation) !== hash(output)
    || hash(loop.context?.script_generation) !== hash(output)
    || hash(loop.inputContext?.script_generation) !== hash(output)
    || image2.loopItem?.firstFramePrompt !== shots[1].firstFramePrompt
    || video2.loopItem?.firstFramePrompt !== shots[1].firstFramePrompt) fail('source story is no longer the original two actions with reviewed timing and spatial clarification')
  if (loop.output?.count !== 2 || loop.output?.loopSource !== 'script_generation.shots'
    || !Array.isArray(refs.output?.items) || refs.output.items.length !== 4) fail('script loop or character references changed')
  const currentImage = workflow.nodes.find(node => node.id === 'node-image')
  const currentVideo = workflow.nodes.find(node => node.id === 'node-video')
  const params = Object.fromEntries((currentVideo?.params ?? []).map(param => [param.englishName, param]))
  if (!currentImage || !currentVideo || hash(currentImage) !== hash(image2.node) || hash(currentVideo) !== hash(video2.node)
    || currentImage.modelId !== 'codex-gpt-image-2' || currentVideo.modelId !== 'keling3'
    || params.duration?.value !== '${shot.duration}' || params.referenceImage?.value !== '${first_frame}'
    || params.endImage?.id !== 'story-optional-end-image' || params.endImage?.value !== '' || params.endImage.required
    || params.sound?.value !== 'on' || !currentVideo.prompt.includes('${shotTimedActions}')) {
    fail('pending nodes differ from the current reviewed image/video workflow')
  }
  const firstVideo = await localAsset(urlOf(video1.output), ['.mp4', '.mov', '.webm'])
  const firstImage = await imageAsset(urlOf(image1.output))
  const review = video1.output?.storyMediaReview, evidence = review?.videoEvidence
  if (image1.output?.model !== 'codex-gpt-image-2' || video1.output?.model !== 'keling3'
    || evidence?.decoded !== true || evidence.url !== firstVideo.url || evidence.sha256 !== firstVideo.sha256
    || recovery.acceptedShot1VideoSha256 !== firstVideo.sha256
    || recovery.acceptedShot1ImageSha256 !== firstImage.sha256
    || urlOf(video1.inputs?.referenceImage) !== firstImage.url
    || urlOf(video1.output?.params?.referenceImage) !== firstImage.url
    || Number(video1.output?.params?.duration) !== 8
    || !String(video1.output?.prompt ?? '').includes(renderStoryShotTimedActions(shots[0]))) {
    fail('completed first shot lacks bound media evidence')
  }
  const acceptanceRoute = storyShot2AcceptanceRoute(recovery, review)
  if (acceptanceRoute === 'automated-passed') {
    const accepted = validateStoryShotAssessment(shots[0], evidence, review.observations, review.assessment)
    if (!accepted.passed || accepted.reviewStatus !== 'passed' || accepted.issues.length
      || accepted.beatChecks.length !== review.beatChecks.length
      || accepted.beatChecks.some((beat, index) => beat.id !== review.beatChecks[index]?.id
        || beat.status !== review.beatChecks[index]?.status)
      || accepted.endingHold?.status !== review.endingHold?.status) fail('first shot automated review no longer revalidates')
  } else {
    const acceptedSource = humanProvenance?.acceptedSource
    const uncertainSource = humanProvenance?.uncertainSource
    const acceptedState = acceptedSource && decodeExecutionState(acceptedSource.result)
    const uncertainState = uncertainSource && decodeExecutionState(uncertainSource.result)
    const human = state.humanStoryReview, humanRecovery = state.storyShot1HumanReviewRecovery
    const acceptance = recovery.shot1Acceptance
    if (!acceptedState || !uncertainState || !human || !humanRecovery
      || recovery.sourceExecutionId !== acceptedSource.id || state.parentExecutionId !== acceptedSource.id
      || acceptedState.id !== acceptedSource.id || acceptedState.parentExecutionId !== uncertainSource.id
      || humanRecovery.sourceExecutionId !== uncertainSource.id
      || humanRecovery.sourceResultMd5 !== uncertainSource.result_md5
      || acceptedState.storyShot1HumanReviewRecovery?.sourceResultMd5 !== uncertainSource.result_md5
      || hash(acceptedState.storyShot1HumanReviewRecovery) !== hash(humanRecovery)
      || hash(acceptedState.humanStoryReview) !== hash(human)
      || acceptedState.nodeRuns?.[5]?.status !== 'success'
      || hash(acceptedState.nodeRuns[5].output) !== hash(video1.output)
      || uncertainState.nodeRuns?.[5]?.status !== 'failed'
      || hash(uncertainState.nodeRuns[5].output) !== hash(video1.output)
      || acceptance.evidenceFileSha256 !== human.evidenceFileSha256
      || acceptance.sourceReviewStatus !== 'uncertain'
      || acceptance.sourceRecordId !== uncertainSource.id
      || humanRecovery.reviewFileSha256 !== human.evidenceFileSha256
      || humanRecovery.videoSha256 !== firstVideo.sha256
      || humanRecovery.firstFrameSha256 !== firstImage.sha256) {
      fail('direct visual acceptance or its uncertain parent provenance changed')
    }
    const loaded = await loadHumanStoryReview(humanRecovery.reviewFile)
    if (loaded.sha256 !== humanRecovery.reviewFileSha256) fail('direct visual evidence file changed')
    const validated = validateHumanStoryReview(loaded.report,
      { ...uncertainSource, result: uncertainState },
      { imageSha256: firstImage.sha256, videoSha256: firstVideo.sha256 }, loaded.sha256)
    if (hash(validated) !== hash(human)) fail('direct visual report does not revalidate')
    const manifest = await generatedAsset(validated.audioLevelManifest.url, ['.json'])
    if (manifest.sha256 !== validated.audioLevelManifest.sha256) fail('first shot audio derivative manifest changed')
    await verifyHumanStoryReviewFrames(validated, firstVideo.file)
  }
  const opening = await imageAsset(urlOf(image2.output))
  if (image2.output?.model !== 'codex-gpt-image-2' || !String(image2.output?.prompt ?? '').includes(shots[1].firstFramePrompt)
    || hash(image2.loopItem) !== hash(shots[1])) {
    fail('shot 2 opening frame is not the successful Codex image for this source shot')
  }
  const prepared = prepareWorkflowRunContext(runs, 7)
  if (prepared.inputContext.shot?.duration !== 8 || urlOf(prepared.inputContext.first_frame) !== opening.url
    || hash(prepared.inputContext.model_images?.items) !== hash(refs.output.items)) {
    fail('pending video does not resolve the actual shot 2 opening frame and four references')
  }
  const refHashes = []
  for (const item of refs.output.items) {
    const url = urlOf(item)
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) fail('character reference is not a JPEG data URL')
    const bytes = Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64')
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) fail('character reference is empty or oversized')
    refHashes.push(sha256(bytes))
  }
  return { source, original, workflow, state, runs, shots, opening, firstImage, firstVideo, refHashes,
    prefixSha256: hash(runs.slice(0, 7)), currentVideo, endImageParamId: params.endImage.id,
    sourceMd5: source.result_md5, originalMd5: original.result_md5, workflowMd5: workflow.nodes_md5,
    sourceRecordId: source.id, originalRecordId: originalId, shot2Title: shots[1].title,
    openingFrameUrl: opening.url, openingFrameSha256: opening.sha256,
    acceptedShot1VideoSha256: firstVideo.sha256, shot1Acceptance: recovery.shot1Acceptance }
}

const targetPrompt = `以附件1作为同一支办公室短视频的真实开场画面，生成两个既定动作全部完成后静止的单幅目标尾帧。附件2至5仅用于锁定同一只灰蓝短腿圆脸猫与同一只黄白柴犬的外观身份，不复制参考图背景或排版。\n保持附件1的 9:16 固定平视机位、午后办公桌、键盘、显示器与椅子，以及猫犬各自的毛色、身体比例、所在桌面纵深和左右位置。蓝猫仍然趴卧，身体没有翻滚或起身；柴犬坐在原位，其下颌已经轻轻实际接触并搭在蓝猫背部中段，接触点明确是猫背的躯干中部，不是猫头、耳朵、颈部或脸部。蓝猫两眼已经睁开，头仍贴近原处，目光朝柴犬侧瞥；猫背与犬下颌的接触关系和猫的眼神必须同时清晰可见。两只动物各出现一次，不增加第三只动物、肢体、道具或动作。只改变完成这两项既定动作所需的下颌位置、猫眼及细微自然姿态；保留同一连续场景和机位。不要文字、字幕、拼图、分镜格、边框或水印。写实摄影，单幅完整画面。`

const gazeV2Prompt = `编辑附件1这张已经生成的办公室短视频目标尾帧；附件2至5仅用于锁定同一只灰蓝短腿圆脸猫与同一只黄白柴犬的身份。只修正蓝猫的头部朝向和眼睛视线，不要重新设计场景、角色或动作。\n蓝猫继续趴卧，身体和猫背位置不变。柴犬仍坐在猫身左后方，犬下颌明确接触并搭在蓝猫背部躯干中段，接触点不是猫头、耳朵或颈部。蓝猫两眼睁开，头从原先正对镜头的姿态明显向画面左后上方回转，鼻尖朝向背后柴犬的脸；两只眼睛的瞳孔都明确偏向柴犬眼睛和口鼻所在方位，让观众一眼看出猫正在回头看柴犬。猫不得直视镜头；不能只轻微移动眼珠而让猫头继续正对镜头。保留猫脸可见，同时清楚呈现猫背与犬下颌的实际接触。\n保持附件1的 9:16 固定平视机位、午后办公桌、键盘、显示器、椅子、清晰自然光、猫犬毛色体型与左右前后位置。每只动物只出现一次；不增加动物、肢体、道具、文字、字幕、拼图、分镜格、边框或水印。写实摄影，单幅完整画面。`

async function loadGazeSource(client, verified) {
  const ledger = (await client.query(`SELECT id,status,model_id,request_data,response_data
    FROM model_execution_records WHERE id=$1`, [v1TargetLedgerId])).rows[0]
  const expectedKey = `${verified.sourceRecordId}:shot2:target-end-frame-v1:${verified.opening.sha256.slice(0, 16)}`
  if (ledger?.status !== 'succeeded' || ledger.model_id !== 'codex-gpt-image-2'
    || ledger.request_data?.requestKey !== expectedKey
    || outputUrl(ledger.response_data) !== v1TargetUrl) fail('saved v1 target-frame ledger changed')
  const asset = await imageAsset(v1TargetUrl)
  if (asset.sha256 !== v1TargetSha256 || asset.sha256 === verified.opening.sha256) {
    fail('saved v1 target-frame bytes changed')
  }
  return { ...asset, ledgerId: ledger.id, requestKey: expectedKey }
}

function targetRequest(verified, model, variant = 'original-v1') {
  const sourceHash = variant === gazeVariant ? verified.gazeSource.sha256 : verified.opening.sha256
  const requestVersion = variant === gazeVariant ? 'v2' : version
  const requestKey = `${verified.sourceRecordId}:shot2:target-end-frame-${requestVersion}:${sourceHash.slice(0, 16)}`
  return { model, prompt: variant === gazeVariant ? gazeV2Prompt : targetPrompt,
    params: { referenceImages: verified.references, size: '576x1024', singleFrame: true },
    operation: 'story.target-end-frame', executionContext: { requestKey, workflowId: 'wf-story', workflowName: '打工猫短视频',
      nodeId: 'node-target-end-frame-shot2', nodeName: `${verified.shot2Title}目标尾帧` } }
}

function outputUrl(body) {
  const url = body?.data?.[0]?.url
  return typeof url === 'string' && /^\/generated\/[\w.-]+\.png$/.test(url) ? url : ''
}

export function prepareStoryShot2EndFrameFork(verified, target, id, createdAt = new Date().toISOString(), variant = 'original-v1') {
  if (!/^record-[\w-]+$/.test(id) || [verified.sourceRecordId, originalId].includes(id)
    || target.sha256 === verified.opening.sha256) fail('new record or target image is invalid')
  const hash = createJsonHasher()
  const [input, refs, script, loop, image1, video1, image2, video2] = verified.runs
  const updatedVideo = { ...invalidateRunExecution(video2), node: verified.currentVideo,
    attempt: 1, errorAttempt: 1, revision: (video2.revision ?? 0) + 1,
    paramOverrides: { [verified.endImageParamId]: target.url } }
  const runs = [input, refs, script, loop, image1, video1, image2, updatedVideo]
  const prepared = prepareWorkflowRunContext(runs, 7)
  const timedActions = renderStoryShotTimedActions(verified.shots[1])
  const prompt = renderWorkflowTemplate(verified.currentVideo.prompt,
    { ...prepared.inputContext, shotTimedActions: timedActions })
  const parameters = Object.fromEntries(verified.currentVideo.params.map(param => [param.englishName,
    resolveTemplateJsonValue(param.value, prepared.inputContext)]))
  if (parameters.duration !== 8 || parameters.sound !== 'on'
    || urlOf(parameters.referenceImage) !== verified.opening.url
    || updatedVideo.paramOverrides[verified.endImageParamId] !== target.url
    || !prompt.includes(timedActions) || prompt.includes('${') || !prompt.includes('8 秒内')) {
    fail('new video request is not bound to the unchanged 8-second plan and both still frames')
  }
  const recovery = { version: variant === gazeVariant ? 'story-shot2-target-end-frame-v2' : 'story-shot2-target-end-frame-v1', createdAt,
    sourceExecutionId: verified.sourceRecordId, originalExecutionId: originalId,
    sourcePrefixSha256: verified.prefixSha256, acceptedShot1VideoSha256: verified.firstVideo.sha256,
    shot1Acceptance: verified.shot1Acceptance,
    openingFrameUrl: verified.opening.url, openingFrameSha256: verified.opening.sha256,
    targetEndFrameUrl: target.url, targetEndFrameSha256: target.sha256,
    shot2ScriptSha256: hash(verified.shots[1]),
    ...(variant === gazeVariant ? { editedFromTargetFrameUrl: v1TargetUrl,
      editedFromTargetFrameSha256: v1TargetSha256, editedFromLedgerId: v1TargetLedgerId } : {}) }
  const state = { ...verified.state, id, parentExecutionId: verified.sourceRecordId,
    generationScopeId: id, requestScopeId: verified.state.requestScopeId ?? verified.sourceRecordId,
    historical: false, mode: 'step', nodeRuns: runs, context: image2.context,
    selectedNodeId: 'node-video', logs: [...(verified.state.logs ?? []),
      `第二镜尾帧候选已绑定 ${target.url}；第一镜与第二镜首帧保持原样，等待显式继续执行。`],
    storyShot2TargetEndFrameRecovery: recovery }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)
    || hash(runs.slice(0, 7)) !== verified.prefixSha256 || runs.findIndex(run => run.status === 'idle') !== 7
    || updatedVideo.status !== 'idle' || updatedVideo.output !== undefined || updatedVideo.error !== undefined) {
    fail('fork changed a completed run or crossed the pending video boundary')
  }
  return { state, encoded, proof: { version: recovery.version, newRecordId: id,
    sourceRecordId: verified.sourceRecordId, sourceResultMd5: verified.sourceMd5,
    originalResultMd5: verified.originalMd5, workflowNodesMd5: verified.workflowMd5,
    acceptedShot1VideoSha256: verified.firstVideo.sha256, preservedPrefixRunIds: runs.slice(0, 7).map(run => run.id),
    shot1Acceptance: verified.shot1Acceptance,
    preservedPrefixSha256: verified.prefixSha256, firstPendingIndex: 7, firstPendingNodeId: 'node-video',
    shot2OpeningFrame: { url: verified.opening.url, sha256: verified.opening.sha256 },
    shot2TargetEndFrame: { url: target.url, sha256: target.sha256 },
    resolvedDuration: parameters.duration, videoFirstFrameBound: true,
    videoTargetEndFrameBound: true, providerFieldExpected: 'image_tail', modelCalls: 0 } }
}

async function load(client, options, lock) {
  const suffix = lock ? ' FOR SHARE' : ''
  const source = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${suffix}`,
    [options.sourceId])).rows[0]
  const original = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${suffix}`,
    [originalId])).rows[0]
  const workflow = (await client.query(`SELECT *,md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${suffix}`)).rows[0]
  if (!source || !original || !workflow) fail('source, original or workflow record is missing')
  for (const [key, actual] of [['sourceMd5', source.result_md5], ['originalMd5', original.result_md5],
    ['workflowMd5', workflow.nodes_md5]]) if (options[key] && options[key].toLowerCase() !== actual) fail(`${key} differs from the reviewed preview`)
  const sourceState = decodeExecutionState(source.result)
  const spatial = sourceState.storyShot2SpatialRecovery
  let humanProvenance
  if (spatial?.shot1Acceptance?.method === 'direct-visual-pass') {
    const acceptedId = spatial.sourceExecutionId
    if (!/^record-[\w-]+$/.test(acceptedId ?? '')) fail('accepted first-shot record ID is invalid')
    const acceptedSource = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${suffix}`,
      [acceptedId])).rows[0]
    const acceptedState = acceptedSource && decodeExecutionState(acceptedSource.result)
    const uncertainId = acceptedState?.storyShot1HumanReviewRecovery?.sourceExecutionId
    if (!/^record-[\w-]+$/.test(uncertainId ?? '')) fail('uncertain first-shot record ID is invalid')
    const uncertainSource = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${suffix}`,
      [uncertainId])).rows[0]
    if (!uncertainSource) fail('uncertain first-shot record is missing')
    humanProvenance = { acceptedSource, uncertainSource }
  }
  const verified = await verifyStoryShot2TargetSource(source, original, workflow, humanProvenance)
  if (options.firstFrameSha256 && options.firstFrameSha256.toLowerCase() !== verified.opening.sha256) fail('opening image bytes changed since visual review')
  return verified
}

async function generate(client, options) {
  const verified = await load(client, options, false)
  if (options.variant === gazeVariant) verified.gazeSource = await loadGazeSource(client, verified)
  const referenceSource = verified.gazeSource ?? verified.opening
  const jpeg = await sharp(referenceSource.bytes, { failOn: 'error' }).jpeg({ quality: 94 }).toBuffer()
  if (jpeg.length > 5 * 1024 * 1024) fail('target reference JPEG exceeds provider limit')
  verified.references = [`data:image/jpeg;base64,${jpeg.toString('base64')}`]
  for (const item of verified.runs[1].output.items) verified.references.push(urlOf(item))
  const model = (await client.query('SELECT id,name,provider,capability,settings FROM model_configs WHERE id=$1',
    ['codex-gpt-image-2'])).rows[0]
  if (!model || model.provider !== 'Codex' || model.capability !== 'image') fail('configured Codex GPT Image model is unavailable')
  const request = targetRequest(verified, model, options.variant), requestKey = request.executionContext.requestKey
  const fingerprint = modelRequestFingerprint(request)
  const summary = { mode: options.apply ? 'generate' : 'dry-run', variant: options.variant,
    sourceRecordId: verified.sourceRecordId,
    sourceResultMd5: verified.sourceMd5, originalResultMd5: verified.originalMd5,
    workflowNodesMd5: verified.workflowMd5, openingFrameUrl: verified.opening.url,
    openingFrameSha256: verified.opening.sha256, acceptedShot1VideoSha256: verified.firstVideo.sha256,
    shot1Acceptance: verified.shot1Acceptance,
    ...(verified.gazeSource ? { editedFromTargetFrameUrl: verified.gazeSource.url,
      editedFromTargetFrameSha256: verified.gazeSource.sha256, editedFromLedgerId: verified.gazeSource.ledgerId } : {}),
    referenceSha256: [sha256(jpeg), ...verified.refHashes], requestKey, requestFingerprint: fingerprint,
    promptSha256: sha256(Buffer.from(request.prompt)), modelId: model.id, willSubmit: false }
  if (options.apply) {
    const locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',
      ['story-shot2-target-frame', requestKey])).rows[0]?.locked
    if (!locked) fail('target-frame request is already in progress')
  }
  const history = (await client.query(`SELECT id,status,response_data,request_data->>'fingerprint' AS fingerprint
    FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at DESC`, [requestKey])).rows
  if (history.some(saved => saved.fingerprint !== fingerprint)) fail('request key belongs to different inputs; bump script version')
  const completed = history.find(saved => saved.status === 'succeeded')
  if (completed) {
    const url = outputUrl(completed.response_data)
    if (!url) fail('saved successful ledger has no local PNG URL')
    const target = await imageAsset(url)
    return { ...summary, mode: 'reuse', ledgerId: completed.id, targetUrl: url,
      targetSha256: target.sha256, willSubmit: false }
  }
  if (history.length) fail(`request key already has a ${history[0].status} ledger entry; inspect it before another paid request`)
  if (!options.apply) return summary
  const server = process.env.STORY_SERVER_URL ?? 'http://127.0.0.1:5174'
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(server)) fail('STORY_SERVER_URL must be a local loopback HTTP server')
  // Recheck record and opening image immediately before spending. The provider
  // response is still saved in its own ledger even if source changes afterward.
  await load(client, options, false)
  const response = await fetch(`${server}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(660_000) })
  const result = await response.json()
  if (!response.ok || result?.status !== 200) fail(`image request ended with HTTP ${response.status}, model status ${String(result?.status)}`)
  const url = outputUrl(result.body)
  if (!url) fail('image request returned no saved local PNG')
  const target = await imageAsset(url)
  const saved = (await client.query(`SELECT id FROM model_execution_records WHERE request_data->>'requestKey'=$1
    AND request_data->>'fingerprint'=$2 AND status='succeeded' ORDER BY created_at DESC LIMIT 1`,
    [requestKey, fingerprint])).rows[0]
  if (!saved) fail('target image exists but the model ledger did not save success')
  return { ...summary, mode: 'generated', ledgerId: saved.id, targetUrl: url,
    targetSha256: target.sha256, willSubmit: true }
}

async function attach(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const verified = await load(client, options, options.apply)
    const target = await imageAsset(options.targetUrl)
    if (options.variant === gazeVariant) {
      const generated = await generate(client, { ...options, mode: 'generate', apply: false })
      if (generated.mode !== 'reuse' || generated.targetUrl !== target.url || generated.targetSha256 !== target.sha256) {
        fail('gaze-v2 target is not the saved successful Codex image request')
      }
    }
    if (options.targetSha256 && options.targetSha256.toLowerCase() !== target.sha256) fail('target image bytes changed since visual review')
    if (target.sha256 === verified.opening.sha256) fail('target frame equals the opening frame')
    const prepared = prepareStoryShot2EndFrameFork(verified, target, options.id, new Date().toISOString(), options.variant)
    const localParams = await prepareKlingImageInputs({ referenceImage: verified.opening.url,
      endImage: target.url, duration: 8, sound: 'on' }, generated)
    const provider = buildKlingVideoRequest({ settings: { model: 'kling-v3', mode: 'std' } },
      '保持开场与目标尾帧连续。', localParams)
    if (provider.duration !== '8' || typeof provider.image !== 'string' || !provider.image.length
      || typeof provider.image_tail !== 'string' || !provider.image_tail.length) {
      fail('Kling adapter did not bind both still frames')
    }
    if (options.apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, verified.source.workflow_id, verified.source.workflow_name,
        `打工猫第二镜目标尾帧恢复 · ${verified.sourceRecordId}`,
        JSON.stringify(verified.source.runtime_inputs ?? {}), JSON.stringify(encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const stored = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!stored || createJsonHasher()(decodeExecutionState(stored.result)) !== createJsonHasher()(state)) fail('inserted fork differs from reviewed preparation')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
      [verified.sourceRecordId])).rows[0]?.md5
    const originalAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
      [originalId])).rows[0]?.md5
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]?.md5
    if (sourceAfter !== verified.sourceMd5 || originalAfter !== verified.originalMd5 || workflowAfter !== verified.workflowMd5) {
      fail('source, original or workflow changed during fork')
    }
    await client.query('COMMIT')
    return { ...prepared.proof, sourceResultMd5After: sourceAfter,
      originalResultMd5After: originalAfter, workflowNodesMd5After: workflowAfter,
      providerFirstFrameBound: true, providerTargetEndFrameBound: true,
      applied: options.apply, humanReviewBoundary: 'Visually inspect the actual opening and target stills before --apply.' }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/story-shot2-target-endframe.mjs generate --source-record RECORD [--variant gaze-v2] [--expected-source-md5 MD5] [--expected-original-md5 MD5] [--expected-workflow-md5 MD5] [--expected-first-frame-sha256 SHA256] [--apply]\nnode scripts/story-shot2-target-endframe.mjs attach --source-record RECORD --target-url /generated/target.png [--variant gaze-v2] [--id NEW_RECORD] [same expected hashes] [--expected-target-sha256 SHA256] [--apply]\nBoth modes are read-only by default. Generate --apply buys one image; attach --apply inserts an idle video fork but calls no model.')
    return
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await client.connect()
  try { console.log(JSON.stringify(options.mode === 'generate' ? await generate(client, options)
    : await attach(client, options), null, 2)) } finally { await client.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
