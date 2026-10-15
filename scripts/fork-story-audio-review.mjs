#!/usr/bin/env node
// Bind an audio-level-only derivative of a paid story take to a NEW review-only
// execution. Default dry-run. --apply only INSERTs a checkpoint; continuing its
// video node calls story-shot-review through the same-media retry path.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { readStorySameMediaReviewRetry, storyShotIdentity, withStorySameMediaReviewRetry } from '../src/story-same-media-retry.ts'
import { renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const generated = path.resolve('public/generated')
const fail = message => { throw Error(`STORY_AUDIO_REVIEW_FORK_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')

function optionsFrom(args) {
  const options = { sourceId: 'record-story-shot1-endframe-v1',
    manifestUrl: '/generated/audio-leveled-60f9b80eaba54eab-480168d2c5be86149d41.json',
    id: `record-story-audio-review-${randomUUID().slice(0, 8)}`, apply: false }
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
    || options.id === options.sourceId) fail('source and new record IDs must differ')
  if (!/^\/generated\/[\w.-]+\.json$/.test(options.manifestUrl)) fail('manifest must be a local generated JSON file')
  for (const field of ['sourceMd5', 'workflowMd5']) if (options[field] && !/^[a-f\d]{32}$/i.test(options[field])) fail(`invalid ${field}`)
  for (const field of ['manifestSha256', 'derivedSha256']) if (options[field] && !/^[a-f\d]{64}$/i.test(options[field])) fail(`invalid ${field}`)
  if (options.apply && (!seen.has('--id') || !options.sourceMd5 || !options.workflowMd5
    || !options.manifestSha256 || !options.derivedSha256)) {
    fail('--apply requires reviewed ID, source/workflow MD5, manifest and derived SHA256')
  }
  return options
}

async function localAsset(url, extensions) {
  const filename = /^\/generated\/([\w.-]+)$/.exec(url)?.[1]
  if (!filename || !extensions.includes(path.extname(filename).toLowerCase())) fail(`invalid local asset URL: ${url}`)
  const base = await realpath(generated)
  const file = await realpath(path.join(base, filename))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail(`asset is missing or unsafe: ${url}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return { url, file, sha256: hash.digest('hex') }
}

async function validatedDerivative(manifestUrl) {
  const manifestFile = await localAsset(manifestUrl, ['.json'])
  let manifest
  try { manifest = JSON.parse(await readFile(manifestFile.file, 'utf8')) } catch { fail('manifest JSON cannot be parsed') }
  if (!object(manifest) || manifest.version !== 'audio-level-remediation-v1'
    || !/^\/generated\/[\w.-]+\.mp4$/.test(manifest.sourceUrl)
    || !/^\/generated\/[\w.-]+\.mp4$/.test(manifest.outputUrl)
    || manifest.sourceUrl === manifest.outputUrl
    || !/^[a-f\d]{64}$/i.test(String(manifest.sourceSha256))
    || !/^[a-f\d]{64}$/i.test(String(manifest.outputSha256))
    || manifest.everyDecodedVideoFrameMatched !== true
    || manifest.sourceVideoFramesSha256 !== manifest.outputVideoFramesSha256
    || !Number.isSafeInteger(manifest.videoFrameCount) || manifest.videoFrameCount < 1
    || manifest.videoCodecHandling !== 'stream-copy' || manifest.audioCodecHandling !== 'AAC re-encode'
    || manifest.originalLedgerAndExecutionUnchanged !== true
    || !(manifest.sourceAudio?.meanDbfs < -50) || !(manifest.outputAudio?.meanDbfs > -50)
    || !(manifest.sourceAudio?.maxDbfs > -40) || !(manifest.sourceAudio?.activeSecondsAboveMinus50 > 0.5)
    || !(manifest.outputAudio?.truePeakDbfs <= -1.0)
    || !(manifest.appliedGainDb > 0 && manifest.appliedGainDb <= 30)) fail('manifest does not prove a safe audible same-video derivative')
  const [source, output] = await Promise.all([
    localAsset(manifest.sourceUrl, ['.mp4']), localAsset(manifest.outputUrl, ['.mp4']),
  ])
  if (source.sha256 !== manifest.sourceSha256 || output.sha256 !== manifest.outputSha256) fail('video bytes changed since remediation')
  return { manifest, manifestUrl, manifestSha256: manifestFile.sha256, source, output }
}

/** Pure state fork. The original record and every paid prefix run remain intact. */
export function prepareStoryAudioReviewFork(source, workflow, media, id, createdAt = new Date().toISOString()) {
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
      || index < 5 && run.status !== 'success' || index === 5 && run.status !== 'failed'
      || index > 5 && run.status !== 'idle')) fail('source is not the expected first-shot review boundary')
  const video = runs[5], review = video.output?.storyMediaReview, sourceOutput = video.output
  if (!object(sourceOutput) || sourceOutput.url !== media.manifest.sourceUrl
    || review?.reviewStatus !== 'technical-failure' || review.passed !== false
    || review.videoEvidence?.sha256 !== media.source.sha256
    || !Array.isArray(review.issues) || !review.issues.some(issue => String(issue).includes('实际音轨接近静音'))
    || video.loopIndex !== 0 || !video.loopGroupId || runs[4].loopGroupId !== video.loopGroupId
    || video.loopItem?.duration !== 8 || sourceOutput.params?.duration !== 8
    || video.node.kind !== 'video' || video.node.modelId !== sourceOutput.model
    || !workflow.nodes.some(node => node.id === video.node.id && node.kind === 'video')) {
    fail('source video, low-volume review or first-shot binding differs from the manifest')
  }
  const shots = runs[2].output?.shots
  validateStoryShotTimingOutput(shots, { expectedCount: 2 })
  if (storyShotIdentity(video.loopItem) !== storyShotIdentity(shots[0])
    || !String(sourceOutput.prompt ?? '').includes(renderStoryShotTimedActions(shots[0]))) {
    fail('paid video prompt does not contain the authoritative first-shot actions')
  }
  const sourceOutputHash = hash(sourceOutput)
  const retryOutput = { url: media.output.url,
    originalUrl: sourceOutput.originalUrl ?? sourceOutput.url,
    paidSourceUrl: media.source.url, paidSourceSha256: media.source.sha256,
    model: sourceOutput.model, params: sourceOutput.params, prompt: sourceOutput.prompt,
    audioLevelRemediation: { manifestUrl: media.manifestUrl, manifestSha256: media.manifestSha256,
      sourceSha256: media.source.sha256, outputSha256: media.output.sha256,
      appliedGainDb: media.manifest.appliedGainDb,
      videoFrameCount: media.manifest.videoFrameCount,
      videoFramesSha256: media.manifest.outputVideoFramesSha256,
      everyDecodedVideoFrameMatched: true },
    paidSourceOutputSha256: sourceOutputHash, previousStoryMediaReview: review }
  const retry = { version: 'story-same-media-review-retry-v1', sourceExecutionId: source.id,
    sourceRunId: video.id, sourceLoopIndex: video.loopIndex,
    sourceShotJson: storyShotIdentity(video.loopItem), sourceUrl: media.output.url,
    sourceVideoSha256: media.output.sha256, sourceReviewStatus: 'technical-failure', sourceOutput: retryOutput }
  const nextRuns = manualRetryRuns(runs, 5).map((run, index) => index === 5
    ? { ...run, retryFeedback: withStorySameMediaReviewRetry(run.retryFeedback, retry) } : run)
  if (nextRuns.slice(0, 5).some((run, index) => hash(run) !== hash(runs[index]))
    || nextRuns[5].status !== 'idle' || nextRuns[5].output !== undefined
    || nextRuns.slice(6).some(run => run.status !== 'idle' || run.output !== undefined)
    || readStorySameMediaReviewRetry(nextRuns[5].retryFeedback, nextRuns[5])?.sourceVideoSha256 !== media.output.sha256) {
    fail('review-only retry changed the paid prefix or lost the derivative binding')
  }
  const prepared = prepareWorkflowRunContext(nextRuns, 5)
  if (!prepared || storyShotIdentity(prepared.inputContext.shot) !== retry.sourceShotJson
    || prepared.inputContext.first_frame?.url !== runs[4].output?.url) fail('review step lost its shot or original first frame')
  const recovery = { version: 'story-audio-level-review-fork-v1', createdAt, sourceExecutionId: source.id,
    sourceRunId: video.id, sourceVideoUrl: media.source.url, sourceVideoSha256: media.source.sha256,
    paidSourceOutputSha256: sourceOutputHash, sourceReviewStatus: 'technical-failure',
    derivativeVideoUrl: media.output.url, derivativeVideoSha256: media.output.sha256,
    manifestUrl: media.manifestUrl, manifestSha256: media.manifestSha256,
    sameDecodedVideoFramesSha256: media.manifest.outputVideoFramesSha256,
    videoFrameCount: media.manifest.videoFrameCount, gainDb: media.manifest.appliedGainDb,
    providerModelCalls: 0 }
  const state = { ...original, id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? source.id, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns: nextRuns,
    context: runs[4].context, selectedNodeId: 'node-video',
    logs: [...nextRuns.slice(0, 5).map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `复核同画面音轨派生片 ${media.output.url}；原付费视频及技术失败保留于父记录 ${source.id}。`],
    storyAudioReviewRecovery: recovery }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)
    || hash(original) !== originalHash) fail('storage round trip changed the fork or source')
  return { state, encoded, proof: { version: recovery.version, sourceRecordId: source.id,
    sourceResultMd5: source.result_md5, workflowNodesMd5: workflow.nodes_md5,
    newRecordId: id, createdAt, firstPendingIndex: 5, firstPendingNodeId: 'node-video',
    pendingRoute: 'same-media-review-only', sourcePaidVideoUrl: media.source.url,
    sourcePaidVideoSha256: media.source.sha256, derivativeVideoUrl: media.output.url,
    derivativeVideoSha256: media.output.sha256, manifestUrl: media.manifestUrl,
    manifestSha256: media.manifestSha256, appliedGainDb: media.manifest.appliedGainDb,
    preservedPrefixRunIds: nextRuns.slice(0, 5).map(run => run.id),
    preservedPrefixSha256: hash(nextRuns.slice(0, 5)), paidSourceOutputSha256: sourceOutputHash,
    providerModelCallsOnFork: 0, providerVideoCallsOnReview: 0, sourceUnchanged: true } }
}

async function run(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`,
      [options.sourceId])).rows[0]
    if (!source) fail('source record is missing')
    if (options.sourceMd5 && options.sourceMd5 !== source.result_md5) fail('source changed since reviewed dry run')
    const workflow = (await client.query(`SELECT *, md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${options.apply ? ' FOR SHARE' : ''}`)).rows[0]
    if (!workflow) fail('wf-story workflow config is missing')
    if (options.workflowMd5 && options.workflowMd5 !== workflow.nodes_md5) fail('workflow changed since reviewed dry run')
    const media = await validatedDerivative(options.manifestUrl)
    if (options.manifestSha256 && options.manifestSha256 !== media.manifestSha256) fail('manifest changed since reviewed dry run')
    if (options.derivedSha256 && options.derivedSha256 !== media.output.sha256) fail('derivative changed since reviewed dry run')
    const prepared = prepareStoryAudioReviewFork(source, workflow, media, options.id)
    if (options.apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        idOrFail(state.id), source.workflow_id, source.workflow_name,
        `打工猫首镜原画面音轨复核 · ${source.id}`, JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(encoded), state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('persisted fork differs from reviewed state')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [options.sourceId])).rows[0]?.result_md5
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]?.nodes_md5
    if (sourceAfter !== source.result_md5 || workflowAfter !== workflow.nodes_md5) fail('source or workflow changed during preparation')
    await client.query('COMMIT')
    return { ...prepared.proof, sourceResultMd5After: sourceAfter, workflowNodesMd5After: workflowAfter,
      applied: options.apply }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

function idOrFail(id) { if (!/^record-[\w-]+$/.test(id)) fail('invalid fork id'); return id }

async function main() {
  const options = optionsFrom(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-audio-review.mjs [--source RECORD] [--manifest /generated/MANIFEST.json] [--id NEW_RECORD] [--expected-source-md5 MD5] [--expected-workflow-md5 MD5] [--expected-manifest-sha256 SHA256] [--expected-derived-sha256 SHA256] [--apply]\nDefault dry-run. --apply only inserts a new review-only execution checkpoint, never calls a model.')
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
