#!/usr/bin/env node
// Schema-5 audio-only recovery. Keeps the paid video node successful and makes
// the separate media-review node idle. --apply INSERTs one new record only.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import ffmpeg from 'ffmpeg-static'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { selectStoryInspection } from './inspect-story-generation.mjs'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const GENERATED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const hash = createJsonHasher()
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const exec = promisify(execFile)
const fail = message => { throw Error(`STORY_AUDIO_DERIVATIVE_FORK_INVALID: ${message}`) }
const same = (a, b) => a === undefined || b === undefined ? a === b : hash(a) === hash(b)
const clean = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/gi, '[remote URL omitted]')
  .replace(/data:[^\s"'<>]+/gi, '[data omitted]').slice(0, 2000)

function parseArgs(args) {
  const options = {}
  const flags = { '--source': 'sourceId', '--id': 'id', '--manifest': 'manifestUrl', '--out': 'out', '--shot-index': 'shotIndex',
    '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5', '--expected-edges-md5': 'edgesMd5',
    '--expected-manifest-sha256': 'manifestSha256', '--expected-derived-sha256': 'derivedSha256',
    '--expected-original-sha256': 'originalSha256' }
  for (let at = 0; at < args.length; at++) {
    const flag = args[at]
    if (flag === '--help') { options.help = true; continue }
    if (flag === '--dry-run' || flag === '--apply') {
      if (options.mode) fail('Choose one --dry-run or --apply')
      options.mode = flag.slice(2); continue
    }
    const key = flags[flag]
    if (!key || options[key] !== undefined || !args[at + 1] || args[at + 1].startsWith('--')) fail(`Unknown or duplicate flag ${flag}`)
    options[key] = args[++at]
  }
  if (options.help) return options
  options.shotIndex = Number(options.shotIndex ?? 0)
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '') || !/^record-[\w-]+$/.test(options.id ?? '')
    || options.id === options.sourceId || !/^\/generated\/[\w.-]+\.json$/.test(options.manifestUrl ?? '')
    || !options.mode || !options.out || !Number.isSafeInteger(options.shotIndex) || options.shotIndex < 0) fail('Require distinct --source/--id, local --manifest, valid zero-based shot-index, --out, and explicit mode')
  for (const key of ['sourceMd5', 'workflowMd5', 'edgesMd5']) if (options[key] && !/^[a-f\d]{32}$/i.test(options[key])) fail(`Invalid ${key}`)
  for (const key of ['manifestSha256', 'derivedSha256', 'originalSha256']) if (options[key] && !/^[a-f\d]{64}$/i.test(options[key])) fail(`Invalid ${key}`)
  if (options.mode === 'apply' && ['sourceMd5', 'workflowMd5', 'edgesMd5', 'manifestSha256', 'derivedSha256', 'originalSha256'].some(key => !options[key])) fail('--apply requires all reviewed source/workflow/manifest/media hashes')
  return options
}

async function localAsset(url, extension) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url) || path.extname(url) !== extension) fail('Expected a local generated asset')
  const base = await realpath(GENERATED)
  const file = await realpath(path.join(base, path.basename(url)))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('Asset path is missing or escapes generated directory')
  return { url, file, sha256: sha256(await readFile(file)) }
}

async function decodedFrameHashes(file) {
  const { stdout } = await exec(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', file,
    '-map', '0:v:0', '-f', 'framemd5', 'pipe:1', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  const hashes = stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')).map(line => line.split(',').at(-1)?.trim())
  if (!hashes.length || hashes.some(value => !/^[a-f\d]{32}$/i.test(value ?? ''))) fail('Complete audiovisual decode or per-frame hashes missing')
  return { count: hashes.length, sha256: sha256(hashes.join('\n')), hashes }
}

async function validatedDerivative(url, decodeFrames = true) {
  const receipt = await localAsset(url, '.json')
  const manifest = JSON.parse(await readFile(receipt.file, 'utf8'))
  if (manifest.version !== 'audio-level-remediation-v1' || manifest.sourceUrl === manifest.outputUrl
    || manifest.everyDecodedVideoFrameMatched !== true || manifest.sourceVideoFramesSha256 !== manifest.outputVideoFramesSha256
    || !/^[a-f\d]{64}$/.test(manifest.sourceVideoFramesSha256 ?? '') || !Number.isSafeInteger(manifest.videoFrameCount)
    || manifest.videoFrameCount < 1 || manifest.videoCodecHandling !== 'stream-copy' || manifest.audioCodecHandling !== 'AAC re-encode'
    || manifest.originalLedgerAndExecutionUnchanged !== true || !(manifest.sourceAudio?.meanDbfs < -50)
    || !(manifest.sourceAudio?.maxDbfs > -40) || !(manifest.sourceAudio?.activeSecondsAboveMinus50 > .5)
    || !(manifest.outputAudio?.meanDbfs >= -50) || !(manifest.outputAudio?.truePeakDbfs <= -1)
    || !(manifest.appliedGainDb > 0 && manifest.appliedGainDb <= 30)
    || !(manifest.targetLufs >= -30 && manifest.targetLufs <= -16)
    || Math.abs(manifest.outputAudio.integratedLufs - manifest.targetLufs) > 2) fail('Manifest does not establish a safe original-audio same-video derivative')
  const source = await localAsset(manifest.sourceUrl, '.mp4')
  const output = await localAsset(manifest.outputUrl, '.mp4')
  if (source.sha256 !== manifest.sourceSha256 || output.sha256 !== manifest.outputSha256) fail('Source/derived bytes do not match the manifest')
  if (decodeFrames) {
    const decoded = await Promise.all([decodedFrameHashes(source.file), decodedFrameHashes(output.file)])
    if (decoded.some(item => item.count !== manifest.videoFrameCount || item.sha256 !== manifest.sourceVideoFramesSha256)
      || !same(decoded[0].hashes, decoded[1].hashes)) fail('Actual decoded frame hashes differ from source/manifest')
  }
  return { manifest, manifestUrl: url, manifestSha256: receipt.sha256, source, output, decodedFramesIndependentlyVerified: decodeFrames }
}

export function prepareStoryAudioDerivativeFork(source, workflowRow, media, id, createdAt = new Date().toISOString(), shotIndex = 0) {
  if (source?.workflow_id !== 'wf-story' || workflowRow?.id !== 'wf-story' || workflowRow.schema_version !== 5
    || !/^record-[\w-]+$/.test(id) || id === source.id) fail('Invalid source, workflow or new ID')
  const workflow = { ...workflowRow, schemaVersion: 5 }
  upgradeStoryQualityWorkflow(workflow)
  const original = decodeExecutionState(source.result), originalHash = hash(original)
  if (original.id !== source.id || original.nodeRuns.some(run => run.status === 'running')) fail('Source identity differs or still has an active request')
  const selected = selectStoryInspection(original), target = selected.selections[shotIndex]
  const imageIndex = 5 + shotIndex * 4, videoIndex = imageIndex + 1, reviewIndex = imageIndex + 2
  const expectedIds = ['node-input', 'node-model-images', 'node-script', 'node-script-review', 'node-loop',
    ...selected.selections.flatMap(() => ['node-image', 'node-video', 'node-video-review', 'node-video-concat'])]
  const runs = original.nodeRuns
  if (!Number.isSafeInteger(shotIndex) || shotIndex < 0 || !selected.scriptPassed || !target || runs.length !== expectedIds.length
    || runs.some((run, index) => run.node.id !== expectedIds[index]) || runs.slice(0, reviewIndex).some(run => run.status !== 'success')
    || target.review?.status !== 'failed' || runs.slice(reviewIndex + 1).some(run => run.status !== 'idle' || run.output !== undefined)
    || runs[imageIndex] !== target.image || runs[videoIndex] !== target.video || runs[reviewIndex] !== target.review) fail('Source must be a schema-5 target-video technical failure with successful prefix and later shots untouched')
  const originalImageBindingMatches = same(target.image.loopItem, target.shot) && same(target.image.inputContext?.shot, target.shot)
  const documentedPaidImageReuse = shotIndex === 1 && original.storySecondShotRetake?.preservedSecondFirstFrameRunSha256 === hash(target.image)
    && target.image.loopItem?.firstFramePrompt === target.shot.firstFramePrompt
  const reference = target.video.output.params?.referenceImage
  if ((!originalImageBindingMatches && !documentedPaidImageReuse)
    || !same(target.video.loopItem, target.shot) || !same(target.video.inputContext?.shot, target.shot)
    || !same(target.review.loopItem, target.shot) || !same(target.review.inputContext?.shot, target.shot)
    || !same(target.review.inputContext?.[target.video.node.resultVar], target.video.output)
    || new Set([target.image, target.video, target.review].map(run => run.loopGroupId)).size !== 1
    || !target.video.loopGroupId || (typeof reference === 'string' ? reference : reference?.url) !== target.image.output.url
    || Number(target.video.output.params?.duration) !== target.shot.duration || !target.video.output.prompt?.includes(target.shot.timedActions)) fail('Paid video, unchanged starting image, or current review plan binding differs')
  const review = target.review.output?.storyMediaReview
  if (review?.passed !== false || review.reviewStatus !== 'technical-failure'
    || !review.issues?.some(issue => /实际音轨接近静音|AUDIO_REMEDIATION_UNSAFE_GAIN/.test(String(issue)))
    || review.videoEvidence?.url !== media.source.url || review.videoEvidence?.sha256 !== media.source.sha256
    || review.videoUrl !== target.video.output.url || !media.decodedFramesIndependentlyVerified) fail('Manifest source is not this paid clip and independently decoded failed audio review')
  const sourceOutputHash = hash(target.video.output)
  const recovery = { version: 'story-schema5-audio-derivative-review-v1', createdAt, sourceExecutionId: source.id,
    sourceResultMd5: source.result_md5, workflowNodesMd5: workflowRow.nodes_md5, workflowEdgesMd5: workflowRow.edges_md5,
    shotIndex, sourceVideoRunId: target.video.id, sourcePaidVideoOutputSha256: sourceOutputHash,
    sourceFailedReviewRunId: target.review.id, sourceFailedReviewOutputSha256: hash(target.review.output),
    sourceVideoUrl: media.source.url, sourceVideoSha256: media.source.sha256,
    derivativeVideoUrl: media.output.url, derivativeVideoSha256: media.output.sha256,
    manifestUrl: media.manifestUrl, manifestSha256: media.manifestSha256,
    appliedGainDb: media.manifest.appliedGainDb, targetLufs: media.manifest.targetLufs,
    videoFrameCount: media.manifest.videoFrameCount, everyDecodedVideoFrameMatched: true,
    sameDecodedVideoFramesSha256: media.manifest.outputVideoFramesSha256, decodedFramesIndependentlyVerified: true,
    originalPaidImageSnapshotReused: !originalImageBindingMatches && documentedPaidImageReuse,
    expectedPaidImageContractDifference: originalImageBindingMatches ? null : 'Original paid first-frame loopItem retains its prior action plan; unchanged firstFramePrompt and exact saved run hash establish reuse.',
    transformation: 'original-audio-gain-only-no-added-sounds', humanAccepted: false,
    videoRegeneration: false, modelCallsOnFork: 0, sourceReviewStatus: 'technical-failure' }
  const derivedOutput = { ...structuredClone(target.video.output), url: media.output.url,
    originalUrl: target.video.output.originalUrl ?? target.video.output.url,
    paidSourceUrl: media.source.url, paidSourceSha256: media.source.sha256,
    paidSourceOutputSha256: sourceOutputHash,
    audioLevelRemediation: { ...media.manifest, manifestUrl: media.manifestUrl, manifestSha256: media.manifestSha256 } }
  delete derivedOutput.videoEvidence
  delete derivedOutput.storyMediaReview
  const nextRuns = structuredClone(runs)
  const videoContext = prepareWorkflowRunContext(nextRuns, videoIndex)?.inputContext
  if (!videoContext || !same(videoContext.shot, target.video.loopItem)
    || videoContext.first_frame?.url !== target.image.output.url
    || !same(videoContext.script_review, target.video.inputContext.script_review)) fail('Cannot preserve paid video source context')
  nextRuns[videoIndex] = { ...nextRuns[videoIndex], output: derivedOutput,
    context: { ...target.video.inputContext, [target.video.node.resultVar]: derivedOutput }, audioDerivativeRecovery: recovery }
  nextRuns[reviewIndex] = { ...invalidateRunExecution(nextRuns[reviewIndex]),
    node: workflow.nodes.find(node => node.id === 'node-video-review'), revision: (target.review.revision ?? 0) + 1,
    attempt: 1, errorAttempt: 1 }
  const refreshed = refreshPendingExecutionNodes(workflow, nextRuns)
  const nextReview = prepareWorkflowRunContext(refreshed, reviewIndex)
  if (!nextReview || refreshed[reviewIndex].node.kind !== 'validation' || refreshed[reviewIndex].node.operation !== 'story.media-review'
    || !same(nextReview.inputContext[target.video.node.resultVar], derivedOutput)
    || !same(nextReview.inputContext.shot, target.video.loopItem)
    || nextReview.inputContext.video_review || nextReview.inputContext.stage_video) fail('Review context lost derivative binding or retained failed output')
  if (!same(nextRuns.slice(0, videoIndex), runs.slice(0, videoIndex)) || !same(nextRuns.slice(reviewIndex + 1), runs.slice(reviewIndex + 1))
    || !same(nextRuns[videoIndex].inputs, target.video.inputs) || !same(nextRuns[videoIndex].inputContext, target.video.inputContext)
    || !same(nextRuns[videoIndex].output.params, target.video.output.params)
    || nextRuns[videoIndex].output.prompt !== target.video.output.prompt || nextRuns[videoIndex].status !== 'success'
    || nextRuns.slice(reviewIndex).some(run => run.status !== 'idle' || run.output !== undefined)) fail('Paid prefix, original request, or pending later shots changed')
  const state = { ...structuredClone(original), id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? source.id, generationScopeId: id, historical: false, mode: 'step',
    nodeRuns: nextRuns, context: nextRuns[videoIndex].context, selectedNodeId: 'node-video-review',
    storyAudioDerivativeRecovery: recovery,
    logs: [...(original.logs ?? []), `从 ${source.id} 创建原音轨增益派生复核；原视频画面逐帧保持，未新增音效、未重新购买视频。`,
      `第${shotIndex + 1}镜成片质检节点待复核；不声明原技术失败已通过，后续节点仍待执行。`] }
  const encoded = encodeExecutionState(state)
  if (!same(decodeExecutionState(JSON.parse(JSON.stringify(encoded))), state) || hash(decodeExecutionState(source.result)) !== originalHash) fail('Serialization changed source/fork')
  return { state, encoded, proof: { ...recovery, sourceRecordId: source.id, newRecordId: id,
    firstPendingIndex: reviewIndex, firstPendingNodeId: 'node-video-review', completedRuns: reviewIndex, totalRuns: nextRuns.length,
    preservedPrefixSha256: hash(nextRuns.slice(0, videoIndex)), preservedPrefixCount: videoIndex, originalPromptAndParamsPreserved: true,
    laterRunsExactlyPreserved: true, reviewContextVerifiedAfterRefresh: true,
    providerVideoCallsOnReview: 0, sourceUnchanged: true } }
}

async function run(db, options) {
  const apply = options.mode === 'apply'
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const lock = apply ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) result_md5 FROM execution_records WHERE id=$1${lock}`, [options.sourceId])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !workflow || (await db.query('SELECT id FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('Source/workflow missing or destination already exists')
    const media = await validatedDerivative(options.manifestUrl)
    const locks = { sourceMd5: source.result_md5, workflowMd5: workflow.nodes_md5, edgesMd5: workflow.edges_md5,
      manifestSha256: media.manifestSha256, derivedSha256: media.output.sha256, originalSha256: media.source.sha256 }
    for (const [key, value] of Object.entries(locks)) if (options[key] && options[key].toLowerCase() !== value) fail(`${key} differs from reviewed dry-run`)
    const prepared = prepareStoryAudioDerivativeFork(source, workflow, media, options.id, undefined, options.shotIndex)
    if (apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [options.id, source.workflow_id, source.workflow_name,
        `打工猫第${options.shotIndex + 1}镜原音轨派生复核 · ${source.id}`, JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(prepared.encoded), prepared.proof.completedRuns, prepared.state.nodeRuns.length])
      const inserted = (await db.query('SELECT result FROM execution_records WHERE id=$1', [options.id])).rows[0]
      if (!inserted || !same(decodeExecutionState(inserted.result), prepared.state)) fail('Inserted fork changed')
    }
    const sourceAfter = (await db.query('SELECT md5(result::text) md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.md5
    const workflowAfter = (await db.query("SELECT md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]
    const mediaAfter = await validatedDerivative(options.manifestUrl, false)
    if (sourceAfter !== source.result_md5 || workflowAfter.nodes_md5 !== workflow.nodes_md5 || workflowAfter.edges_md5 !== workflow.edges_md5
      || mediaAfter.manifestSha256 !== media.manifestSha256 || mediaAfter.output.sha256 !== media.output.sha256 || mediaAfter.source.sha256 !== media.source.sha256) fail('Source/workflow/media changed during preparation')
    await db.query('COMMIT')
    return { ...prepared.proof, applied: apply, sourceResultMd5After: sourceAfter }
  } catch (error) { await db.query('ROLLBACK'); throw error }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-audio-derivative-review.mjs --source record-SOURCE --id record-NEW --shot-index 0 --manifest /generated/MANIFEST.json --out FRESH_DIRECTORY --dry-run\n--shot-index is zero-based and defaults to 0. --apply requires all --expected-source-md5/workflow-md5/edges-md5/manifest-sha256/derived-sha256/original-sha256 locks. Inserts an idle media-review checkpoint only.')
    return
  }
  const out = path.resolve(options.out)
  if (out === GENERATED || out.startsWith(GENERATED + path.sep)) fail('Output must be outside generated media')
  try { if ((await readdir(out)).length) fail('Output directory must be fresh and empty') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(out, { recursive: true })
  const actualOut = await realpath(out), actualGenerated = await realpath(GENERATED)
  if (actualOut === actualGenerated || actualOut.startsWith(actualGenerated + path.sep)) fail('Output resolves into generated media')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const proof = await run(db, options)
    const file = path.join(out, 'audio-review-fork.json')
    await writeFile(file, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ proof: file, applied: proof.applied, newRecordId: proof.newRecordId,
      firstPendingIndex: proof.firstPendingIndex, firstPendingNodeId: proof.firstPendingNodeId,
      originalPromptAndParamsPreserved: proof.originalPromptAndParamsPreserved,
      laterRunsExactlyPreserved: proof.laterRunsExactlyPreserved,
      reviewContextVerifiedAfterRefresh: proof.reviewContextVerifiedAfterRefresh, providerVideoCallsOnReview: 0 }, null, 2))
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(clean(error instanceof Error ? error.message : error)); process.exitCode = 1
})
