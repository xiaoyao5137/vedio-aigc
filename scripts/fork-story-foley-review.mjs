#!/usr/bin/env node
// Fork a failed second story shot to review a disclosed same-video foley
// derivative. Default dry-run; --apply only inserts a checkpoint, never calls
// a provider. The original execution and all paid runs remain intact.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ffmpeg from 'ffmpeg-static'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { readStorySameMediaReviewRetry, storyShotIdentity, withStorySameMediaReviewRetry } from '../src/story-same-media-retry.ts'
import { renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const exec = promisify(execFile)
const fail = message => { throw Error(`STORY_FOLEY_REVIEW_FORK_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const generated = path.resolve('public/generated')

function optionsFrom(args) {
  const options = { apply: false }
  const names = { '--source': 'sourceId', '--manifest': 'manifestUrl', '--id': 'id',
    '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5',
    '--expected-manifest-sha256': 'manifestSha256', '--expected-derived-sha256': 'derivedSha256' }
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help') { options.help = true; continue }
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    const name = names[flag]
    if (!name || seen.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[name] = args[++index]
    seen.add(flag)
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.sourceId) || !/^record-[\w-]+$/.test(options.id)
    || options.id === options.sourceId || !/^\/generated\/[\w.-]+\.json$/.test(options.manifestUrl)) fail('source, id or manifest URL invalid')
  for (const name of ['sourceMd5', 'workflowMd5']) if (options[name] && !/^[\da-f]{32}$/i.test(options[name])) fail(`invalid ${name}`)
  for (const name of ['manifestSha256', 'derivedSha256']) if (options[name] && !/^[\da-f]{64}$/i.test(options[name])) fail(`invalid ${name}`)
  if (options.apply && (!options.sourceMd5 || !options.workflowMd5 || !options.manifestSha256 || !options.derivedSha256)) {
    fail('--apply requires expected source/workflow MD5 and manifest/derivative SHA256')
  }
  return options
}

async function localAsset(url, extension) {
  if (!new RegExp(`^/generated/[\\w.-]+\\${extension}$`).test(url)) fail(`invalid local asset ${url}`)
  const dir = await realpath(generated)
  const file = await realpath(path.join(dir, path.basename(url)))
  if (!file.startsWith(dir + path.sep) || !(await stat(file)).isFile()) fail(`asset missing or unsafe ${url}`)
  return { url, file, sha256: sha256(await readFile(file)) }
}

async function decodedFrameHashes(file) {
  const { stdout } = await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', file,
    '-map', '0:v:0', '-f', 'framemd5', '-'], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  const frames = stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
    .map(line => line.split(',').at(-1)?.trim() ?? '')
  if (!frames.length || frames.some(value => !/^[a-f\d]{32}$/i.test(value))) fail('video frame hashes unavailable')
  return frames
}

export async function validatedDerivative(manifestUrl) {
  const manifestAsset = await localAsset(manifestUrl, '.json')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestAsset.file, 'utf8')) } catch { fail('manifest JSON invalid') }
  if (!object(manifest) || manifest.version !== 'procedural-foley-v1'
    || manifest.sourceUrl === manifest.outputUrl || manifest.everyDecodedVideoFrameMatched !== true
    || manifest.sourceVideoFramesSha256 !== manifest.outputVideoFramesSha256
    || manifest.videoCodecHandling !== 'stream-copy'
    || !String(manifest.audioCodecHandling).startsWith('new procedural foley AAC')
    || manifest.audioSource !== 'deterministic post-production DSP synthesis; no external recording, model or provider'
    || manifest.soundContentSemanticReview !== 'pending-human-listen'
    || manifest.originalLedgerAndExecutionUnchanged !== true
    || !(manifest.sourceAudio?.meanDbfs < -50) || !(manifest.sourceAudio?.maxDbfs < -40)
    || !(manifest.outputAudio?.meanDbfs > -50) || !(manifest.outputAudio?.truePeakDbfs < -1)
    || !Number.isSafeInteger(manifest.videoFrameCount) || manifest.videoFrameCount < 1) fail('manifest does not prove disclosed same-video derivative')
  const [source, output, wav] = await Promise.all([
    localAsset(manifest.sourceUrl, '.mp4'), localAsset(manifest.outputUrl, '.mp4'), localAsset(manifest.wavUrl, '.wav'),
  ])
  if (source.sha256 !== manifest.sourceSha256 || output.sha256 !== manifest.outputSha256
    || wav.sha256 !== manifest.wavSha256) fail('source, derivative or foley WAV changed')
  const [sourceFrames, outputFrames] = await Promise.all([decodedFrameHashes(source.file), decodedFrameHashes(output.file)])
  if (sourceFrames.length !== manifest.videoFrameCount || outputFrames.length !== sourceFrames.length
    || sourceFrames.some((frame, index) => frame !== outputFrames[index])
    || sha256(sourceFrames.join('\n')) !== manifest.sourceVideoFramesSha256) fail('decoded video frames changed')
  return { manifest, manifestUrl, manifestSha256: manifestAsset.sha256, source, output, wav }
}

export function prepareStoryFoleyReviewFork(source, workflow, media, id, createdAt = new Date().toISOString()) {
  if (!object(source) || !object(source.result) || source.workflow_id !== 'wf-story'
    || !object(workflow) || workflow.id !== 'wf-story' || !Array.isArray(workflow.nodes)
    || !/^record-[\w-]+$/.test(id) || id === source.id) fail('invalid source, workflow or new record ID')
  const hash = createJsonHasher()
  const original = decodeExecutionState(source.result)
  const originalHash = hash(original)
  const runs = original.nodeRuns
  const expectedNodes = ['node-input', 'node-model-images', 'node-script', 'node-loop', 'node-image', 'node-video', 'node-image', 'node-video']
  if (original.id !== source.id || original.workflowId !== 'wf-story' || !Array.isArray(runs)
    || runs.length !== expectedNodes.length || runs.some((run, index) => run.node?.id !== expectedNodes[index]
      || index < 7 && run.status !== 'success' || index === 7 && run.status !== 'failed')) {
    fail('source is not a failed second-shot review boundary with a preserved successful prefix')
  }
  const video = runs[7], sourceOutput = video.output, review = sourceOutput?.storyMediaReview
  if (!object(sourceOutput) || sourceOutput.url !== media.manifest.sourceUrl
    || review?.reviewStatus !== 'technical-failure' || review.passed !== false
    || review.videoEvidence?.sha256 !== media.source.sha256
    || !Array.isArray(review.issues) || !review.issues.some(issue => String(issue).includes('实际音轨接近静音'))
    || video.loopIndex !== 1 || !video.loopGroupId || runs[6].loopGroupId !== video.loopGroupId
    || video.loopItem?.duration !== 8 || sourceOutput.params?.duration !== 8
    || video.node.kind !== 'video' || video.node.modelId !== sourceOutput.model
    || !workflow.nodes.some(node => node.id === video.node.id && node.kind === 'video')) {
    fail('paid video, second-shot binding or original technical failure differs from derivative')
  }
  const shots = runs[2].output?.shots
  validateStoryShotTimingOutput(shots, { expectedCount: 2 })
  if (storyShotIdentity(video.loopItem) !== storyShotIdentity(shots[1])
    || !String(sourceOutput.prompt ?? '').includes(renderStoryShotTimedActions(shots[1]))) {
    fail('paid second-shot prompt differs from authoritative timed actions')
  }
  const paidSourceOutputSha256 = hash(sourceOutput)
  const retryOutput = { url: media.output.url, originalUrl: sourceOutput.originalUrl ?? sourceOutput.url,
    paidSourceUrl: media.source.url, paidSourceSha256: media.source.sha256,
    model: sourceOutput.model, params: sourceOutput.params, prompt: sourceOutput.prompt,
    audioFoleyRemediation: { manifestUrl: media.manifestUrl, manifestSha256: media.manifestSha256,
      sourceSha256: media.source.sha256, outputSha256: media.output.sha256, wavSha256: media.wav.sha256,
      videoFrameCount: media.manifest.videoFrameCount,
      videoFramesSha256: media.manifest.outputVideoFramesSha256, everyDecodedVideoFrameMatched: true,
      audioSource: media.manifest.audioSource, soundContentSemanticReview: 'pending-human-listen' },
    paidSourceOutputSha256, previousStoryMediaReview: review }
  const retry = { version: 'story-same-media-review-retry-v1', sourceExecutionId: source.id,
    sourceRunId: video.id, sourceLoopIndex: video.loopIndex,
    sourceShotJson: storyShotIdentity(video.loopItem), sourceUrl: media.output.url,
    sourceVideoSha256: media.output.sha256, sourceReviewStatus: 'technical-failure', sourceOutput: retryOutput }
  const nextRuns = manualRetryRuns(runs, 7).map((run, index) => index === 7
    ? { ...run, retryFeedback: withStorySameMediaReviewRetry(run.retryFeedback, retry) } : run)
  if (nextRuns.slice(0, 7).some((run, index) => hash(run) !== hash(runs[index]))
    || nextRuns[7].status !== 'idle' || nextRuns[7].output !== undefined
    || readStorySameMediaReviewRetry(nextRuns[7].retryFeedback, nextRuns[7])?.sourceVideoSha256 !== media.output.sha256) {
    fail('retry changed paid prefix or lost same-video derivative binding')
  }
  const prepared = prepareWorkflowRunContext(nextRuns, 7)
  if (!prepared || storyShotIdentity(prepared.inputContext.shot) !== retry.sourceShotJson
    || prepared.inputContext.first_frame?.url !== runs[6].output?.url) fail('review step lost second-shot source context')
  const recovery = { version: 'story-foley-review-fork-v1', createdAt, sourceExecutionId: source.id,
    sourceRunId: video.id, sourceVideoUrl: media.source.url, sourceVideoSha256: media.source.sha256,
    paidSourceOutputSha256, sourceReviewStatus: 'technical-failure',
    derivativeVideoUrl: media.output.url, derivativeVideoSha256: media.output.sha256,
    foleyWavUrl: media.wav.url, foleyWavSha256: media.wav.sha256,
    manifestUrl: media.manifestUrl, manifestSha256: media.manifestSha256,
    sameDecodedVideoFramesSha256: media.manifest.outputVideoFramesSha256,
    videoFrameCount: media.manifest.videoFrameCount, audioSource: media.manifest.audioSource,
    soundContentSemanticReview: 'pending-human-listen', providerModelCalls: 0 }
  const state = { ...original, id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? source.id, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns: nextRuns,
    context: runs[6].context, selectedNodeId: 'node-video',
    logs: [...nextRuns.slice(0, 7).map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `复核同画面后期拟音片 ${media.output.url}；原付费视频及技术失败保留于父记录 ${source.id}。`],
    storyFoleyReviewRecovery: recovery }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)
    || hash(original) !== originalHash) fail('storage round trip changed fork or source')
  return { state, encoded, proof: { version: recovery.version, sourceRecordId: source.id,
    sourceResultMd5: source.result_md5, workflowNodesMd5: workflow.nodes_md5,
    newRecordId: id, createdAt, firstPendingIndex: 7, firstPendingNodeId: 'node-video',
    pendingRoute: 'same-media-review-only', sourcePaidVideoUrl: media.source.url,
    sourcePaidVideoSha256: media.source.sha256, derivativeVideoUrl: media.output.url,
    derivativeVideoSha256: media.output.sha256, foleyWavSha256: media.wav.sha256,
    manifestUrl: media.manifestUrl, manifestSha256: media.manifestSha256,
    preservedPrefixRunIds: nextRuns.slice(0, 7).map(run => run.id),
    preservedPrefixSha256: hash(nextRuns.slice(0, 7)), paidSourceOutputSha256,
    sameDecodedVideoFramesSha256: media.manifest.outputVideoFramesSha256,
    providerModelCallsOnFork: 0, providerVideoCallsOnReview: 0, sourceUnchanged: true } }
}

async function run(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`,
      [options.sourceId])).rows[0]
    if (!source) fail('source record missing')
    if (options.sourceMd5 && options.sourceMd5 !== source.result_md5) fail('source changed since dry run')
    const workflow = (await client.query(`SELECT *, md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${options.apply ? ' FOR SHARE' : ''}`)).rows[0]
    if (!workflow) fail('wf-story workflow missing')
    if (options.workflowMd5 && options.workflowMd5 !== workflow.nodes_md5) fail('workflow changed since dry run')
    const media = await validatedDerivative(options.manifestUrl)
    if (options.manifestSha256 && options.manifestSha256 !== media.manifestSha256) fail('manifest changed since dry run')
    if (options.derivedSha256 && options.derivedSha256 !== media.output.sha256) fail('derivative changed since dry run')
    const prepared = prepareStoryFoleyReviewFork(source, workflow, media, options.id)
    if (options.apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name,
        `打工猫第二镜后期拟音复核 · ${source.id}`, JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(encoded), state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) {
        fail('persisted fork differs from reviewed state')
      }
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [options.sourceId])).rows[0]?.result_md5
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]?.nodes_md5
    if (sourceAfter !== source.result_md5 || workflowAfter !== workflow.nodes_md5) fail('source or workflow changed during preparation')
    await client.query('COMMIT')
    return { ...prepared.proof, sourceResultMd5After: sourceAfter,
      workflowNodesMd5After: workflowAfter, applied: options.apply }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

async function main() {
  const options = optionsFrom(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-foley-review.mjs --source RECORD --manifest /generated/MANIFEST.json --id NEW_RECORD [--expected-source-md5 MD5 --expected-workflow-md5 MD5 --expected-manifest-sha256 SHA256 --expected-derived-sha256 SHA256 --apply]\nDefault read-only dry-run. --apply only inserts a review-only checkpoint; never calls a model.')
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
