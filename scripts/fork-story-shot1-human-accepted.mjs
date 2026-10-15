#!/usr/bin/env node
// An explicitly attributed, direct visual verdict can advance a source whose
// automated reviewer stayed uncertain. Default dry-run; --apply INSERTs a NEW
// checkpoint only. It never edits the source, changes storyMediaReview, or
// invokes a model.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { generatedAsset, loadHumanStoryReview, validateHumanStoryReview,
  verifyHumanStoryReviewFrames } from './story-shot-human-review.mjs'

const fail = message => { throw Error(`STORY_SHOT1_HUMAN_FORK_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const expectedNodes = ['node-input', 'node-model-images', 'node-script', 'node-loop', 'node-image', 'node-video', 'node-image', 'node-video']

function parseArgs(args) {
  const options = { apply: false, id: `record-story-shot1-visual-${randomUUID().slice(0, 8)}` }
  const fields = { '--source-record': 'sourceId', '--id': 'id', '--review-file': 'reviewFile',
    '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5',
    '--expected-review-sha256': 'reviewSha256', '--expected-video-sha256': 'videoSha256' }
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
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '') || !/^record-[\w-]+$/.test(options.id)
    || options.sourceId === options.id || !options.reviewFile) fail('source, new ID and review file are required')
  for (const field of ['sourceMd5', 'workflowMd5']) if (options[field] && !/^[a-f0-9]{32}$/i.test(options[field])) fail(`${field} is invalid`)
  for (const field of ['reviewSha256', 'videoSha256']) if (options[field] && !/^[a-f0-9]{64}$/i.test(options[field])) fail(`${field} is invalid`)
  if (options.apply && (!seen.has('--id') || !options.sourceMd5 || !options.workflowMd5
    || !options.reviewSha256 || !options.videoSha256)) fail('--apply needs the reviewed ID and all source/evidence digests')
  return options
}

/** Pure fork after external file and decoded-frame verification. */
export function prepareStoryShot1HumanAcceptanceFork(source, workflow, verified, id,
  createdAt = new Date().toISOString()) {
  if (!object(source) || source.workflow_id !== 'wf-story' || !object(workflow) || workflow.id !== 'wf-story'
    || !Array.isArray(workflow.nodes) || !object(verified) || !/^record-[\w-]+$/.test(id)
    || id === source.id) fail('invalid source, workflow, evidence or ID')
  const hash = createJsonHasher()
  const before = decodeExecutionState(source.result)
  const originalHash = hash(before)
  const runs = before.nodeRuns
  if (before.id !== source.id || before.workflowId !== 'wf-story' || !Array.isArray(runs)
    || runs.length !== expectedNodes.length || runs.some((run, index) => run.node?.id !== expectedNodes[index]
      || index < 5 && run.status !== 'success' || index === 5 && run.status !== 'failed'
      || index > 5 && run.status !== 'idle')) fail('source is not an uncertain first-shot review boundary')
  const shot = runs[2].output?.shots?.[0], image = runs[4], video = runs[5]
  validateStoryShotTimingOutput(runs[2].output?.shots, { expectedCount: 2 })
  if (shot.duration !== 8 || image.output?.model !== 'codex-gpt-image-2'
    || video.output?.model !== 'keling3' || video.output?.params?.duration !== 8
    || video.output?.params?.referenceImage?.url !== image.output?.url
    || video.inputs?.referenceImage?.url !== image.output?.url
    || video.inputContext?.first_frame?.url !== image.output?.url
    || !String(video.output?.prompt ?? '').includes(renderStoryShotTimedActions(shot))
    || hash(video.loopItem) !== hash(shot)
    || verified.media?.imageSha256 !== verified.review?.firstFrame?.sha256
    || verified.media?.videoSha256 !== verified.review?.video?.sha256) fail('paid video and original first-frame/script bindings changed')
  const human = validateHumanStoryReview(verified.review, { ...source, result: before }, verified.media,
    verified.fileSha256)
  const audio = video.output.audioLevelRemediation
  if (verified.manifest?.sha256 !== audio?.manifestSha256
    || verified.manifest?.url !== audio.manifestUrl
    || verified.manifest?.data?.outputSha256 !== verified.media.videoSha256
    || verified.manifest?.data?.sourceSha256 !== audio.sourceSha256
    || verified.manifest?.data?.everyDecodedVideoFrameMatched !== true
    || verified.manifest?.data?.videoFrameCount !== before.storyAudioReviewRecovery?.videoFrameCount) {
    fail('audio-only derivative manifest is missing or changed')
  }
  const preparedVideo = prepareWorkflowRunContext(runs, 5)
  if (!preparedVideo || preparedVideo.inputContext?.first_frame?.url !== image.output.url) fail('video context lost its saved image')
  const acceptedVideo = { ...video, status: 'success', error: undefined,
    context: { ...preparedVideo.inputContext, [video.node.resultVar]: video.output },
    revision: (video.revision ?? 0) + 1 }
  const nextRuns = [...runs.slice(0, 5), acceptedVideo, ...runs.slice(6)]
  const nextImage = prepareWorkflowRunContext(nextRuns, 6)
  if (!nextImage || nextImage.inputContext?.script_generation?.shots?.[1]?.title !== runs[2].output.shots[1].title
    || nextImage.inputContext?.loop?.previous?.[video.node.resultVar]?.url !== video.output.url) fail('new fork cannot resume exactly at shot 2 image')
  const recovery = { version: 'story-shot1-direct-visual-acceptance-fork-v1', createdAt,
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    sourceVideoRunId: video.id, sourceReviewStatus: 'uncertain',
    videoSha256: verified.media.videoSha256, firstFrameSha256: verified.media.imageSha256,
    reviewFile: verified.file, reviewFileSha256: verified.fileSha256,
    sourceVideoOutputSha256: human.sourceVideoOutputSha256, modelCalls: 0 }
  const state = { ...before, id, parentExecutionId: source.id, generationScopeId: id,
    requestScopeId: before.requestScopeId ?? source.id, historical: false, mode: 'step',
    nodeRuns: nextRuns, context: acceptedVideo.context, selectedNodeId: 'node-image',
    humanStoryReview: human, storyShot1HumanReviewRecovery: recovery,
    logs: [...(before.logs ?? []), `独立直接视觉复核通过第一镜；自动审核 uncertain 保留；第二镜待显式启动。`] }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)
    || hash(before) !== originalHash || hash(nextRuns.slice(0, 5)) !== hash(runs.slice(0, 5))
    || hash(acceptedVideo.output) !== hash(video.output)
    || hash(nextRuns.slice(6)) !== hash(runs.slice(6))) fail('fork altered source media, automated review or untouched shot 2')
  return { state, encoded, proof: { version: recovery.version, sourceRecordId: source.id,
    sourceResultMd5: source.result_md5, workflowNodesMd5: workflow.nodes_md5,
    newRecordId: id, firstPendingIndex: 6, firstPendingNodeId: 'node-image',
    originalAutomatedReviewStatus: video.output.storyMediaReview.reviewStatus,
    separateHumanVerdict: human.verdict, reviewerMethod: human.reviewMethod,
    frameCount: human.frames.length, videoSha256: verified.media.videoSha256,
    reviewFile: verified.file, reviewFileSha256: verified.fileSha256,
    acceptedVideoOutputUnchanged: true, sourceUnchanged: true, modelCalls: 0 } }
}

async function run(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const lock = options.apply ? ' FOR SHARE' : ''
    const source = (await client.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`,
      [options.sourceId])).rows[0]
    const workflow = (await client.query(`SELECT *,md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !workflow) fail('source or workflow is missing')
    if (options.sourceMd5 && options.sourceMd5 !== source.result_md5
      || options.workflowMd5 && options.workflowMd5 !== workflow.nodes_md5) fail('source/workflow changed since dry run')
    const state = decodeExecutionState(source.result)
    const image = await generatedAsset(state.nodeRuns?.[4]?.output?.url, ['.png', '.jpg', '.jpeg', '.webp'])
    const video = await generatedAsset(state.nodeRuns?.[5]?.output?.url, ['.mp4', '.mov', '.webm'])
    if (options.videoSha256 && options.videoSha256 !== video.sha256) fail('video bytes changed since dry run')
    const loaded = await loadHumanStoryReview(options.reviewFile)
    if (options.reviewSha256 && options.reviewSha256 !== loaded.sha256) fail('review file changed since dry run')
    const manifestUrl = state.nodeRuns[5].output?.audioLevelRemediation?.manifestUrl
    const manifestFile = await generatedAsset(manifestUrl, ['.json'])
    const manifestData = JSON.parse(await readFile(manifestFile.file, 'utf8'))
    const media = { imageSha256: image.sha256, videoSha256: video.sha256 }
    validateHumanStoryReview(loaded.report, { ...source, result: state }, media, loaded.sha256)
    const frameProof = await verifyHumanStoryReviewFrames(loaded.report, video.file)
    const verified = { review: loaded.report, file: loaded.file, fileSha256: loaded.sha256, media,
      manifest: { url: manifestUrl, sha256: manifestFile.sha256, data: manifestData }, frameProof }
    const prepared = prepareStoryShot1HumanAcceptanceFork(source, workflow, verified, options.id)
    if (options.apply) {
      const { state: fork, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        fork.id, source.workflow_id, source.workflow_name, `打工猫第一镜独立视觉通过 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded), 6, fork.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [fork.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(fork)) {
        fail('persisted human acceptance differs from reviewed fork')
      }
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.md5
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]?.md5
    if (sourceAfter !== source.result_md5 || workflowAfter !== workflow.nodes_md5) fail('source/workflow changed during preview')
    await client.query('COMMIT')
    return { ...prepared.proof, decodedFramesVerified: frameProof.decodedFramesVerified,
      sourceResultMd5After: sourceAfter, workflowNodesMd5After: workflowAfter, applied: options.apply }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-shot1-human-accepted.mjs --source-record RECORD --review-file RELATIVE_TO_QA [--id RECORD] [--expected-source-md5 MD5] [--expected-workflow-md5 MD5] [--expected-review-sha256 SHA256] [--expected-video-sha256 SHA256] [--apply]')
    return
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try { console.log(JSON.stringify(await run(db, options), null, 2)) } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
