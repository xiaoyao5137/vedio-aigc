#!/usr/bin/env node
// Prepare a new, unpaid wf-story video candidate after a source-bound media
// review proves an incomplete action. Default mode only reads the database and
// the already archived video. --apply inserts one new execution record.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { manualRetryRuns } from '../src/run-invalidation.ts'
import { planStoryMediaRetake } from '../src/story-media-retake.ts'
import { storyVideoModelContract } from '../src/story-media-retake-model.ts'
import { buildSourceStoryMediaRetakeWorkflow, hasCanonicalStoryMediaRetakeEdges,
  STORY_MEDIA_RETAKE_CANONICAL_EDGES } from '../src/story-media-retake-workflow.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { storyShotIdentity } from '../src/story-same-media-retry.ts'
import { firstBlockingRunIndex, hasExecutionPlanMismatch, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const defaultGeneratedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const recordId = value => typeof value === 'string' && /^record-[A-Za-z0-9_-]+$/.test(value)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw Error(`STORY_MEDIA_RETAKE_INVALID: ${message}`) }

export function parseArguments(args) {
  const options = { apply: false, sourceWorkflowSnapshot: false }
  for (let at = 0; at < args.length; at++) {
    const flag = args[at]
    if (flag === '--help') { options.help = true; continue }
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--source-workflow-snapshot') {
      if (options.sourceWorkflowSnapshot) fail('duplicate --source-workflow-snapshot')
      options.sourceWorkflowSnapshot = true
      continue
    }
    const key = { '--source': 'sourceId', '--review-index': 'reviewIndex', '--id': 'id',
      '--expected-source-md5': 'expectedSourceMd5', '--expected-workflow-md5': 'expectedWorkflowMd5',
      '--expected-workflow-edges-md5': 'expectedWorkflowEdgesMd5' }[flag]
    if (!key || options[key] !== undefined || !args[at + 1] || args[at + 1].startsWith('--')) {
      fail(`unknown, duplicate or incomplete argument ${flag}`)
    }
    options[key] = args[++at]
  }
  if (options.help) return options
  if (!recordId(options.sourceId)) fail('--source must be a record ID')
  if (options.id !== undefined && (!recordId(options.id) || options.id === options.sourceId)) {
    fail('--id must be a distinct new record ID')
  }
  if (options.reviewIndex !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/.test(options.reviewIndex)) fail('--review-index must be a nonnegative integer')
    options.reviewIndex = Number(options.reviewIndex)
    if (!Number.isSafeInteger(options.reviewIndex)) fail('--review-index is outside the supported range')
  }
  if (options.expectedSourceMd5 !== undefined && !/^[a-f\d]{32}$/i.test(options.expectedSourceMd5)) {
    fail('--expected-source-md5 must be a 32-digit MD5')
  }
  if (options.expectedWorkflowMd5 !== undefined && !/^[a-f\d]{32}$/i.test(options.expectedWorkflowMd5)) {
    fail('--expected-workflow-md5 must be a 32-digit MD5')
  }
  if (options.expectedWorkflowEdgesMd5 !== undefined && !/^[a-f\d]{32}$/i.test(options.expectedWorkflowEdgesMd5)) {
    fail('--expected-workflow-edges-md5 must be a 32-digit MD5')
  }
  if (options.apply && (!options.id || !options.expectedSourceMd5 || !options.expectedWorkflowMd5)) {
    fail('--apply requires an explicit --id, --expected-source-md5 and --expected-workflow-md5 from a reviewed dry run')
  }
  if (options.apply && options.sourceWorkflowSnapshot && !options.expectedWorkflowEdgesMd5) {
    fail('snapshot --apply also requires --expected-workflow-edges-md5 from a reviewed dry run')
  }
  return options
}

function failedReviewIndex(runs, requestedIndex) {
  if (requestedIndex !== undefined) return requestedIndex
  const indexes = runs.flatMap((run, at) => run.status === 'failed' && run.node?.operation === 'story.media-review'
    ? [at] : [])
  if (indexes.length !== 1) fail(`expected one failed story media review, found ${indexes.length}; specify --review-index`)
  return indexes[0]
}

/** Read the exact local MP4 bound to the review. Never fetch its remote URL. */
export async function verifyArchivedVideo(evidence, generatedRoot = defaultGeneratedRoot) {
  const url = evidence?.url
  const name = typeof url === 'string' && url.match(/^\/generated\/([A-Za-z0-9_.-]+\.mp4)$/)?.[1]
  if (!name || !/^[a-f0-9]{64}$/.test(String(evidence.sha256))) fail('review has no local MP4 and SHA256 binding')
  const root = await realpath(generatedRoot)
  const filename = await realpath(path.join(root, name)).catch(() => fail('archived MP4 is missing'))
  if (!filename.startsWith(root + path.sep)) fail('archived MP4 escapes the generated directory')
  const info = await stat(filename)
  if (!info.isFile() || info.size < 1024) fail('archived MP4 is empty or not a regular file')
  const actualSha256 = digest(await readFile(filename))
  if (actualSha256 !== evidence.sha256) fail('archived MP4 bytes differ from the review SHA256')
  return { url, sha256: actualSha256, bytes: info.size }
}

/** Keep the preserved paid opening image usable by the pending video step. */
export async function verifyOpeningImage(output, generatedRoot = defaultGeneratedRoot) {
  const url = output?.url
  const name = typeof url === 'string' && url.match(/^\/generated\/([A-Za-z0-9_.-]+\.(?:png|jpg|jpeg|webp))$/i)?.[1]
  if (!name) fail('opening image is not a local generated asset')
  const root = await realpath(generatedRoot)
  const filename = await realpath(path.join(root, name)).catch(() => fail('opening image is missing'))
  if (!filename.startsWith(root + path.sep)) fail('opening image escapes the generated directory')
  const info = await stat(filename)
  if (!info.isFile() || info.size < 1024) fail('opening image is empty or not a regular file')
  const bytes = await readFile(filename)
  const actualSha256 = digest(bytes)
  try {
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 30_000_000 })
    const metadata = await image.metadata()
    if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(String(metadata.format))) {
      fail('opening image has no supported raster dimensions')
    }
    await image.raw().toBuffer()
  } catch { fail('opening image cannot be decoded') }
  const expectedSha256 = output?.raw?.raw?.image?.sha256 ?? output?.raw?.image?.sha256
  if (expectedSha256 !== undefined && expectedSha256 !== actualSha256) {
    fail('opening image bytes differ from the saved image SHA256')
  }
  return { url, sha256: actualSha256, bytes: info.size }
}

function checkedWorkflow(row, runs, original, sourceWorkflowSnapshot) {
  if (!object(row) || row.id !== 'wf-story' || ![5, 6].includes(row.schema_version)
    || !Array.isArray(row.nodes) || !Array.isArray(row.edges)) fail('current wf-story schema 5 or 6 quality workflow is unavailable')
  if (sourceWorkflowSnapshot) {
    if (row.schema_version === 5 && !hasCanonicalStoryMediaRetakeEdges(row.edges)) {
      fail('current workflow edges differ from the canonical schema-5 quality routes')
    }
    // Schema 6 contains a new decision cycle. Older executions did not save
    // their edge list, so reconstruct only the known schema-5 routes from the
    // exact saved run nodes; never splice current schema-6 prompts into them.
    const sourceEdges = row.schema_version === 5 ? row.edges : STORY_MEDIA_RETAKE_CANONICAL_EDGES
    const sourceWorkflow = buildSourceStoryMediaRetakeWorkflow(runs, sourceEdges, {
      name: original.workflowName || row.name || '分镜工作流',
      voicePolicy: original.voicePolicy,
    })
    if (!sourceWorkflow) fail('source run nodes cannot reconstruct a consistent schema-5 quality workflow')
    return sourceWorkflow
  }
  if (row.schema_version !== 5) fail('source execution and current quality workflow have different node sets; use --source-workflow-snapshot')
  const workflow = { id: row.id, schemaVersion: row.schema_version, nodes: row.nodes, edges: row.edges }
  try {
    upgradeStoryQualityWorkflow(workflow)
  } catch (error) { fail(`current workflow quality topology is invalid: ${error instanceof Error ? error.message : String(error)}`) }
  const actual = new Set(runs.map(run => run.node?.id))
  if (actual.size !== workflow.nodes.length || workflow.nodes.some(node => !actual.has(node.id))) {
    fail('source execution and current quality workflow have different node sets')
  }
  if (hasExecutionPlanMismatch(workflow, runs)) {
    fail('source execution node contracts differ from current workflow; do not attach paid prefix to changed instructions')
  }
  return workflow
}

/** Pure fork preparation. Call verifyArchivedVideo separately before insert. */
export function prepareStoryMediaRetakeFork(source, workflowRow, id, requestedIndex,
  createdAt = new Date().toISOString(), options = {}) {
  if (!object(source) || !recordId(source.id) || source.workflow_id !== 'wf-story' || !object(source.result)) {
    fail('source must be a persisted wf-story execution')
  }
  if (!recordId(id) || id === source.id) fail('new record ID is invalid or reuses the source ID')
  const hash = createJsonHasher(), sourceHash = hash(source.result)
  const original = decodeExecutionState(source.result)
  if (original.id !== source.id || original.workflowId !== 'wf-story'
    || !Array.isArray(original.nodeRuns) || !original.nodeRuns.length) fail('source execution identity or run snapshot is invalid')
  const runs = original.nodeRuns
  const reviewIndex = failedReviewIndex(runs, requestedIndex)
  if (!Number.isSafeInteger(reviewIndex) || reviewIndex < 1 || reviewIndex >= runs.length
    || firstBlockingRunIndex(runs, reviewIndex) !== reviewIndex
    || runs.slice(reviewIndex + 1).some(run => run.status === 'success' || run.status === 'running')) {
    fail('review is not the first blocked step or later successful work would be lost')
  }
  const plan = planStoryMediaRetake(runs, reviewIndex)
  if (!plan || !Number.isSafeInteger(plan.videoIndex) || plan.videoIndex < 1 || plan.videoIndex >= reviewIndex
    || typeof plan.feedback !== 'string' || !plan.feedback.trim()) {
    fail('failed review lacks a source-bound, confirmed incomplete action')
  }
  const workflow = checkedWorkflow(workflowRow, runs, original, options.sourceWorkflowSnapshot === true)
  const videoIndex = plan.videoIndex, sourceVideoRun = runs[videoIndex], reviewRun = runs[reviewIndex]
  const targetVideoModel = storyVideoModelContract(options.model)
  if (!targetVideoModel || !sourceVideoRun.node.modelId || targetVideoModel.id !== sourceVideoRun.node.modelId) {
    fail('target video model is missing, unsafe or differs from the source video node')
  }
  const reviewOutput = reviewRun.output, review = reviewOutput.storyMediaReview
  const evidence = review.videoEvidence
  if (reviewOutput.url !== evidence.url || reviewOutput.originalUrl !== sourceVideoRun.output?.url) {
    fail('review output does not bind the archived and original video URLs')
  }
  const images = runs.slice(0, videoIndex).filter(run => run.node?.id === 'node-image' && run.status === 'success'
    && run.loopGroupId === sourceVideoRun.loopGroupId && run.loopIndex === sourceVideoRun.loopIndex
    && storyShotIdentity(run.loopItem) === storyShotIdentity(sourceVideoRun.loopItem))
  if (images.length !== 1 || typeof images[0].output?.url !== 'string') {
    fail('video has no unique successful opening image in the same loop iteration')
  }
  const prefixHash = hash(runs.slice(0, videoIndex))
  let nextRuns = manualRetryRuns(runs, videoIndex)
  nextRuns[videoIndex] = { ...nextRuns[videoIndex], retryFeedback: plan.feedback }
  nextRuns = refreshPendingExecutionNodes(workflow, nextRuns)
  if (nextRuns[videoIndex]?.status !== 'idle' || nextRuns[videoIndex]?.node?.id !== 'node-video'
    || nextRuns.slice(videoIndex).some(run => run.status !== 'idle' || run.output !== undefined)) {
    fail('fork does not start at an unpaid video node with clean downstream state')
  }
  if (hash(nextRuns.slice(0, videoIndex)) !== prefixHash) fail('successful prefix changed during retake planning')
  const prepared = prepareWorkflowRunContext(nextRuns, videoIndex)
  const params = nextRuns[videoIndex].node.params
  const reference = Array.isArray(params) ? params.find(param => (param.englishName || param.name) === 'referenceImage') : undefined
  const resolvedReference = reference ? resolveTemplateJsonValue(reference.value, prepared?.inputContext ?? {}) : undefined
  if (!prepared || storyShotIdentity(prepared.inputContext.shot) !== storyShotIdentity(reviewRun.loopItem)
    || prepared.inputContext.first_frame?.url !== images[0].output.url
    || !object(resolvedReference) || resolvedReference.url !== images[0].output.url
    || prepared.inputContext.video_shot !== undefined) {
    fail('pending video context lost its exact shot and opening-image binding')
  }
  const prefix = nextRuns.slice(0, videoIndex)
  const recovery = { version: 'story-media-retake-v1', sourceExecutionId: source.id,
    sourceReviewRunId: reviewRun.id, sourceVideoSha256: evidence.sha256,
    targetVideoRunId: sourceVideoRun.id, targetVideoModel,
    ...(options.sourceWorkflowSnapshot ? { sourceWorkflow: workflow } : {}) }
  const state = { ...original, id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? source.id, generationScopeId: id,
    historical: false, mode: 'step', nodeRuns: nextRuns,
    context: prefix.at(-1)?.context ?? {}, selectedNodeId: 'node-video',
    logs: [...prefix.map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `从 ${source.id} 创建同镜重拍待执行分支；保留原片，待显式执行视频节点。`],
    storyMediaRetake: recovery }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)) {
    fail('storage round trip changed the prepared branch')
  }
  if (createJsonHasher()(source.result) !== sourceHash) fail('fork preparation mutated the source record')
  return { state, encoded, evidence, openingImage: images[0].output, proof: { version: recovery.version,
    sourceRecordId: source.id, sourceResultMd5: source.result_md5 ?? null,
    workflowNodesMd5: workflowRow.nodes_md5 ?? null, workflowEdgesMd5: workflowRow.edges_md5 ?? null,
    sourceWorkflowSnapshot: options.sourceWorkflowSnapshot === true,
    sourceWorkflowHash: options.sourceWorkflowSnapshot ? hash(workflow) : null,
    targetVideoModelId: targetVideoModel.id, targetVideoModelProvider: targetVideoModel.provider,
    targetVideoModelCapability: targetVideoModel.capability,
    targetVideoModelHash: hash(targetVideoModel), newRecordId: id,
    reviewIndex, firstPendingIndex: videoIndex, firstPendingNodeId: 'node-video',
    loopIndex: sourceVideoRun.loopIndex, preservedPrefixRunIds: prefix.map(run => run.id),
    preservedPrefixHash: prefixHash, sourceVideoRunId: sourceVideoRun.id,
    sourceReviewRunId: reviewRun.id, archivedVideoUrl: evidence.url,
    archivedVideoSha256: evidence.sha256, sourceReviewStatus: review.reviewStatus,
    modelCalls: 0, sourceUnchanged: true } }
}

export async function forkStoryMediaRetake(client, options, generatedRoot = defaultGeneratedRoot) {
  if (options.apply && (!recordId(options.id) || options.id === options.sourceId
    || !/^[a-f\d]{32}$/i.test(options.expectedSourceMd5 ?? '')
    || !/^[a-f\d]{32}$/i.test(options.expectedWorkflowMd5 ?? '')
    || options.sourceWorkflowSnapshot && !/^[a-f\d]{32}$/i.test(options.expectedWorkflowEdgesMd5 ?? ''))) {
    fail('apply requires a distinct new ID and reviewed source/workflow hashes; snapshot mode also requires edges MD5')
  }
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records
      WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
    if (!source) fail('source execution record was not found')
    if (options.expectedSourceMd5 && source.result_md5 !== options.expectedSourceMd5.toLowerCase()) {
      fail('source MD5 differs from the reviewed dry run')
    }
    const workflow = (await client.query(`SELECT *, md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs
      WHERE id='wf-story'${options.apply ? ' FOR SHARE' : ''}`)).rows[0]
    if (!workflow) fail('wf-story workflow configuration was not found')
    if (options.expectedWorkflowMd5 && workflow.nodes_md5 !== options.expectedWorkflowMd5.toLowerCase()) {
      fail('workflow MD5 differs from the reviewed dry run')
    }
    if (options.expectedWorkflowEdgesMd5
      && workflow.edges_md5 !== options.expectedWorkflowEdgesMd5.toLowerCase()) {
      fail('workflow edges MD5 differs from the reviewed dry run')
    }
    const sourceRuns = decodeExecutionState(source.result)?.nodeRuns
    if (!Array.isArray(sourceRuns)) fail('source has no saved node runs')
    const reviewIndex = failedReviewIndex(sourceRuns, options.reviewIndex)
    const sourcePlan = planStoryMediaRetake(sourceRuns, reviewIndex)
    const modelId = sourcePlan && sourceRuns[sourcePlan.videoIndex]?.node?.modelId
    if (typeof modelId !== 'string' || !modelId) fail('source video has no model ID')
    const model = (await client.query(`SELECT id,provider,capability,settings FROM model_configs
      WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [modelId])).rows[0]
    const modelContract = storyVideoModelContract(model)
    if (!modelContract || modelContract.id !== modelId) fail('source video model is unavailable or unsafe')
    const id = options.id ?? `record-story-media-retake-${randomUUID().slice(0, 8)}`
    const prepared = prepareStoryMediaRetakeFork(source, workflow, id, options.reviewIndex,
      new Date().toISOString(), { sourceWorkflowSnapshot: options.sourceWorkflowSnapshot, model })
    const archived = await verifyArchivedVideo(prepared.evidence, generatedRoot)
    const opening = await verifyOpeningImage(prepared.openingImage, generatedRoot)
    if (options.apply) {
      const { state, encoded } = prepared
      const inserted = await client.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)
        ON CONFLICT (id) DO NOTHING RETURNING id`, [state.id, source.workflow_id, source.workflow_name,
        `分镜成片质检重拍待执行 · ${source.id}`, JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(encoded), state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length])
      if (inserted.rowCount !== 1) fail('new record ID already exists')
      const stored = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!stored || createJsonHasher()(decodeExecutionState(stored.result)) !== createJsonHasher()(state)) {
        fail('inserted branch differs from the reviewed preparation')
      }
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
      [source.id])).rows[0]?.result_md5
    const workflowAfter = (await client.query(`SELECT md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'`)).rows[0]
    const modelAfter = (await client.query('SELECT id,provider,capability,settings FROM model_configs WHERE id=$1',
      [modelId])).rows[0]
    if (sourceAfter !== source.result_md5 || workflowAfter?.nodes_md5 !== workflow.nodes_md5
      || workflowAfter.edges_md5 !== workflow.edges_md5
      || createJsonHasher()(storyVideoModelContract(modelAfter)) !== createJsonHasher()(modelContract)) {
      fail('source record, workflow or video model changed during branch preparation')
    }
    await client.query('COMMIT')
    return { ...prepared.proof, archivedVideoBytes: archived.bytes,
      openingImageUrl: opening.url, openingImageSha256: opening.sha256, openingImageBytes: opening.bytes,
      sourceResultMd5After: sourceAfter, workflowNodesMd5After: workflowAfter.nodes_md5,
      workflowEdgesMd5After: workflowAfter.edges_md5,
      applied: Boolean(options.apply) }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-media-retake.mjs --source RECORD [--review-index INDEX] [--source-workflow-snapshot] [--id NEW_RECORD] [--expected-source-md5 MD5] [--expected-workflow-md5 MD5] [--expected-workflow-edges-md5 MD5] [--apply]\nDefault: read-only preview using the current compatible workflow. Snapshot mode freezes the source run nodes and canonical quality edges. --apply requires reviewed MD5 values and an explicit new ID; snapshot apply also requires the edges MD5. It only inserts a pending branch and never calls a provider.')
    return
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    await db.connect()
    console.log(JSON.stringify(await forkStoryMediaRetake(db, options), null, 2))
  } finally { await db.end().catch(() => undefined) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
