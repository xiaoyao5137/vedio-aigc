#!/usr/bin/env node
// Prepare an editor-directed first-shot timing/end-frame revision. --dry-run is
// read-only; --apply requires exact CAS locks and inserts only a NEW idle record.
// Neither mode generates media or changes the original record/workflow.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { createStoryScriptSource, renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { selectStoryInspection } from './inspect-story-generation.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GENERATED = path.join(ROOT, 'public/generated')
const jsonHash = createJsonHasher()
const sha256 = value => createHash('sha256').update(value).digest('hex')
const fail = message => { throw Error(`STORY_TIMING_RECOVERY_INVALID: ${message}`) }
const same = (a, b) => a === undefined || b === undefined ? a === b : jsonHash(a) === jsonHash(b)
const localUrl = value => typeof value === 'string' && /^\/generated\/[\w.-]+$/.test(value) ? value : null
const clean = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/gi, '[remote URL omitted]')
  .replace(/data:[^\s"'<>]+/gi, '[data omitted]').slice(0, 3000)

function parseArguments(args) {
  const options = {}
  const keys = { '--source': 'sourceId', '--id': 'id', '--out': 'out', '--duration': 'duration',
    '--beat-ends': 'beatEnds', '--end-image': 'endImage', '--expected-end-image-sha256': 'endImageSha256',
    '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5',
    '--expected-edges-md5': 'edgesMd5', '--expected-first-frame-sha256': 'firstFrameSha256',
    '--expected-source-video-sha256': 'sourceVideoSha256', '--expected-plan-sha256': 'planSha256',
    '--editor-evidence': 'editorEvidence' }
  for (let at = 0; at < args.length; at++) {
    const flag = args[at]
    if (flag === '--help') { options.help = true; continue }
    if (flag === '--apply' || flag === '--dry-run') {
      if (options.mode) fail('Choose exactly one --dry-run or --apply')
      options.mode = flag.slice(2); continue
    }
    const key = keys[flag]
    if (!key || options[key] !== undefined || !args[at + 1] || args[at + 1].startsWith('--')) fail(`Unknown, duplicate, or incomplete flag ${flag}`)
    options[key] = args[++at]
  }
  if (options.help) return options
  if (!options.mode || !options.out) fail('Explicit --dry-run/--apply and --out are required')
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '') || !/^record-[\w-]+$/.test(options.id ?? '') || options.id === options.sourceId) fail('Distinct --source and new --id are required')
  options.duration = Number(options.duration)
  options.beatEnds = String(options.beatEnds ?? '').split(',').map(Number)
  if (!Number.isInteger(options.duration) || options.duration < 3 || options.duration > 15
    || !options.beatEnds.length || options.beatEnds.some(value => !Number.isFinite(value) || value <= 0)) fail('--duration must be 3–15; --beat-ends must list positive seconds')
  for (const key of ['sourceMd5', 'workflowMd5', 'edgesMd5']) if (options[key] && !/^[a-f\d]{32}$/i.test(options[key])) fail(`${key} must be an MD5 digest`)
  for (const key of ['endImageSha256', 'firstFrameSha256', 'sourceVideoSha256', 'planSha256']) if (options[key] && !/^[a-f\d]{64}$/i.test(options[key])) fail(`${key} must be a SHA256 digest`)
  if (Boolean(options.endImage) !== Boolean(options.endImageSha256)) fail('--end-image and its expected SHA256 must be provided together')
  if (options.mode === 'apply' && ['sourceMd5', 'workflowMd5', 'edgesMd5', 'firstFrameSha256',
    'sourceVideoSha256', 'planSha256', 'endImage', 'endImageSha256'].some(key => !options[key])) fail('--apply requires all reviewed CAS hashes and an explicit end frame')
  return options
}

async function generatedAsset(url, extensions, image = false) {
  if (!localUrl(url) || !extensions.includes(path.extname(url).toLowerCase())) fail('Expected a local generated asset')
  const base = await realpath(GENERATED)
  const file = await realpath(path.join(base, url.slice('/generated/'.length)))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('Generated asset path escapes its root or is missing')
  const bytes = await readFile(file)
  const result = { url, sha256: sha256(bytes), bytes: bytes.length }
  if (image) {
    const decoded = sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 })
    const metadata = await decoded.metadata(); await decoded.raw().toBuffer()
    if (!metadata.width || !metadata.height || Math.abs(metadata.width / metadata.height - 9 / 16) > .04) fail('Recovery image must be a decoded 9:16 frame')
    Object.assign(result, { width: metadata.width, height: metadata.height })
  }
  return result
}

function effectiveNode(run) {
  return { ...run.node, params: run.node.params.map(param => ({ ...param, value: run.paramOverrides?.[param.id] ?? param.value })) }
}

/** Uses the real builtin script-review deterministically; no model is supplied. */
export async function prepareStoryTimingRecovery(source, workflowRow, media, options, createdAt = new Date().toISOString()) {
  if (source?.id !== options.sourceId || source.workflow_id !== 'wf-story' || workflowRow?.id !== 'wf-story'
    || workflowRow.schema_version !== 5) fail('Source or current schema-5 workflow is unavailable')
  const workflow = { ...workflowRow, schemaVersion: workflowRow.schema_version }
  upgradeStoryQualityWorkflow(workflow) // Validate original review topology; do not deploy a migration.
  const original = decodeExecutionState(source.result)
  const sourceStateHash = jsonHash(original)
  if (original.id !== source.id || original.nodeRuns.some(run => run.status === 'running')) fail('Source has a running request or mismatched identity')
  const selected = selectStoryInspection(original)
  const first = selected.selections[0]
  if (!selected.scriptPassed || !first || first.bindingIssues.length || first.image?.status !== 'success'
    || first.video?.status !== 'success' || first.review?.status !== 'failed'
    || first.review.output?.storyMediaReview?.passed !== false) fail('First shot must have a completed failed media review with valid original bindings')
  if (!['uncertain', 'incomplete'].includes(first.review.output.storyMediaReview.reviewStatus)) fail('Only explicit content evidence failures are eligible for this editorial revision')
  const originalRuns = original.nodeRuns
  const expectedIds = ['node-input', 'node-model-images', 'node-script', 'node-script-review', 'node-loop',
    ...selected.selections.flatMap(() => ['node-image', 'node-video', 'node-video-review', 'node-video-concat'])]
  if (originalRuns.length !== expectedIds.length || originalRuns.some((run, index) => run.node?.id !== expectedIds[index])
    || originalRuns.slice(0, 7).some(run => run.status !== 'success')
    || originalRuns.slice(8).some(run => run.status !== 'idle' || run.output !== undefined)
    || selected.selections.some((item, index) => [item.image, item.video, item.review, item.concat]
      .some(run => !run || run.loopIndex !== index || run.loopGroupId !== first.image.loopGroupId))) fail('Source is not a first-shot failure followed by untouched pending shots')
  if (media.firstFrame.url !== first.image.output.url
    || media.sourceVideo.url !== first.review.output.storyMediaReview.videoEvidence?.url
    || media.sourceVideo.sha256 !== first.review.output.storyMediaReview.videoEvidence?.sha256) fail('Source bytes do not match saved first-frame/rejected-video evidence')
  const byId = new Map(workflow.nodes.map(node => [node.id, node]))
  const imageNode = byId.get('node-image'), videoNode = byId.get('node-video'), loopNode = byId.get('node-loop')
  for (const field of ['kind', 'modelId', 'prompt', 'params', 'uploads']) if (!same(imageNode[field], first.image.node[field])) fail('First-frame generation contract changed; cannot silently reuse it')
  const oldShots = selected.scriptReview.output.shots
  const sourceBinding = createStoryScriptSource({ shots: oldShots }, { sourceExecutionId: source.id, sourceRunId: selected.scriptReview.id })
  if (options.beatEnds.length !== oldShots[0].visualBeats.length || options.duration <= oldShots[0].duration) fail('Timing plan must preserve every beat and increase first-shot duration')
  const shots = structuredClone(oldShots)
  shots[0] = { ...shots[0], duration: options.duration,
    content: sourceBinding.shots[0].requiredActions.map((action, index) => `${index ? options.beatEnds[index - 1] : 0}—${options.beatEnds[index]}秒，${action}`).join('；'),
    visualBeats: shots[0].visualBeats.map((beat, index) => ({ ...beat, startSecond: index ? options.beatEnds[index - 1] : 0, endSecond: options.beatEnds[index] })) }
  shots[0].timedActions = renderStoryShotTimedActions(shots[0])
  validateStoryShotTimingOutput(shots, { expectedCount: shots.length, source: sourceBinding })
  if (options.duration - options.beatEnds.at(-1) < 2 || shots.slice(1).some((shot, index) => !same(shot, oldShots[index + 1]))) fail('Require at least two seconds of final hold and preserve every later shot exactly')
  const endParam = videoNode.params.filter(param => (param.englishName || param.name) === 'endImage')
  if (endParam.length !== 1 || endParam[0].value !== '' || endParam[0].required) fail('Saved video node needs one optional empty endImage parameter')
  if (Object.entries(first.video.paramOverrides ?? {}).some(([key, value]) => key !== endParam[0].id || value !== '')) fail('Existing first-video parameter overrides require explicit reconciliation')
  if (media.endImage && (media.endImage.sha256 !== options.endImageSha256 || media.endImage.sha256 === media.firstFrame.sha256)) fail('Target end frame has wrong bytes or is merely the original first frame')
  const recipe = { sourceId: source.id, id: options.id, duration: options.duration, beatEnds: options.beatEnds,
    sourceResultMd5: source.result_md5, workflowNodesMd5: workflowRow.nodes_md5, workflowEdgesMd5: workflowRow.edges_md5,
    firstFrame: media.firstFrame, rejectedVideo: media.sourceVideo, endImage: media.endImage ?? null,
    editorEvidence: media.editorEvidence ?? null, revisedShotsSha256: jsonHash(shots) }
  const recovery = { version: 'story-timing-endframe-recovery-v1', method: 'AI-editor-directed-timing-and-endframe-revision',
    authoredBy: 'agent', modelCalls: 0, createdAt, sourceExecutionId: source.id,
    sourceResultMd5: source.result_md5, sourceScriptRunId: selected.script.id,
    sourceScriptOutputSha256: jsonHash(selected.script.output), sourceScriptReviewRunId: selected.scriptReview.id,
    sourceScriptReviewOutputSha256: jsonHash(selected.scriptReview.output), sourceFailedReviewRunId: first.review.id,
    sourceFailedReviewOutputSha256: jsonHash(first.review.output), sourceReviewStatus: first.review.output.storyMediaReview.reviewStatus,
    uncertaintyReclassifiedAsIncomplete: false, humanAccepted: false,
    workflowNodesMd5: workflowRow.nodes_md5, workflowEdgesMd5: workflowRow.edges_md5,
    planSha256: jsonHash(recipe), sourceBindingSha256: jsonHash(sourceBinding),
    firstFrame: media.firstFrame, rejectedVideo: media.sourceVideo, endImage: media.endImage ?? null,
    editorEvidence: media.editorEvidence ?? null,
    scope: 'Revise first-shot timings and target frame; retain original actions, completion text, identity, first-frame output, and all later shot plans.' }
  const revisedOutput = { text: JSON.stringify(shots, null, 2), shots, items: shots,
    model: 'agent-timing-replan', authorship: recovery }
  const [input, refs, script, scriptReview, loop] = structuredClone(originalRuns)
  const prefixContext = { ...refs.context, storyScriptSource: sourceBinding }
  const revisedScript = { ...script, output: revisedOutput, inputContext: prefixContext,
    context: { ...prefixContext, [script.node.resultVar]: revisedOutput }, durationMs: 0, startedAt: undefined,
    revision: (script.revision ?? 0) + 1, editorialRevision: recovery }
  const actualReview = await executeBuiltinNode(null, { operation: 'story.script-review',
    params: { script: revisedOutput, expectedCount: shots.length, source: sourceBinding } })
  if (actualReview?.passed !== true || actualReview.repairAttempt?.attempted !== false
    || !same(actualReview.shots, shots)) fail('Original builtin script-review did not deterministically accept the source-bound timing plan')
  const revisedReview = { ...scriptReview, node: byId.get('node-script-review'), output: actualReview,
    inputContext: revisedScript.context, inputs: { script: revisedOutput, expectedCount: shots.length, source: sourceBinding },
    context: { ...revisedScript.context, script_review: actualReview }, durationMs: 0, startedAt: undefined,
    revision: (scriptReview.revision ?? 0) + 1,
    reviewMigration: { method: 'actual-builtin-deterministic-revalidation', modelCalls: 0, sourceExecutionId: source.id } }
  const revisedLoop = { ...loop, node: loopNode, inputContext: revisedReview.context,
    context: { ...revisedReview.context, [loop.node.resultVar]: loop.output }, durationMs: 0, startedAt: undefined,
    revision: (loop.revision ?? 0) + 1 }
  const reusedImage = { ...structuredClone(first.image), loopNode, loopItem: actualReview.shots[0], loopPrevious: undefined }
  let runs = [input, refs, revisedScript, revisedReview, revisedLoop, reusedImage]
  const imageContext = prepareWorkflowRunContext(runs, 5)?.inputContext
  if (!imageContext) fail('Cannot reconstruct first-frame reuse context')
  runs[5] = { ...reusedImage, inputContext: imageContext, context: { ...imageContext, [reusedImage.node.resultVar]: reusedImage.output },
    reusedPaidOutput: { sourceExecutionId: source.id, sourceRunId: first.image.id, outputSha256: jsonHash(first.image.output), reason: 'Identical starting state; only later timings changed' } }
  runs.push(...originalRuns.slice(6).map((oldRun, index) => {
    const target = index === 0
    const node = byId.get(oldRun.node.id)
    const selectedNode = target && media.endImage ? { ...node, params: node.params.map(param =>
      param.id === endParam[0].id ? { ...param, value: media.endImage.url } : param) } : node
    return { ...invalidateRunExecution(structuredClone(oldRun)), node: selectedNode, loopNode,
      loopItem: actualReview.shots[oldRun.loopIndex], loopPrevious: undefined,
      revision: oldRun.status === 'idle' ? oldRun.revision : (oldRun.revision ?? 0) + 1,
      attempt: 1, errorAttempt: 1,
      ...(target && media.endImage ? { paramOverrides: { ...(oldRun.paramOverrides ?? {}), [endParam[0].id]: media.endImage.url } } : {}) }
  }))
  const preparedVideo = prepareWorkflowRunContext(runs, 6)
  const effective = effectiveNode(runs[6])
  const durationParam = effective.params.find(param => (param.englishName || param.name) === 'duration')
  const actualDuration = resolveTemplateJsonValue(durationParam.value, preparedVideo.inputContext)
  const prompt = renderWorkflowTemplate(effective.prompt, preparedVideo.inputContext)
  if (actualDuration !== options.duration || !prompt.includes(shots[0].timedActions)
    || preparedVideo.inputContext.first_frame?.url !== media.firstFrame.url) fail('Future paid request does not bind revised timing and preserved first frame')
  const refreshed = refreshPendingExecutionNodes(workflow, runs)
  if (media.endImage && effectiveNode(refreshed[6]).params.find(param => param.id === endParam[0].id)?.value !== media.endImage.url) fail('UI node refresh loses first-shot endImage override')
  for (let at = 9; at < runs.length; at++) {
    if (!same(runs[at].loopItem, originalRuns[at].loopItem)
      || !same(runs[at].paramOverrides, originalRuns[at].paramOverrides)) fail('Later-shot plan or parameter overrides changed')
  }
  if (!same(runs[5].output, first.image.output) || !same(runs[5].inputs, first.image.inputs)
    || runs.slice(6).some(run => run.status !== 'idle' || run.output !== undefined || Object.keys(run.context).length)) fail('Paid first-frame preservation or pending-output invalidation failed')
  const state = { ...structuredClone(original), id: options.id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? source.id, generationScopeId: options.id,
    historical: false, mode: 'step', nodeRuns: runs, context: runs[5].context, selectedNodeId: 'node-video',
    storyTimingRecovery: recovery,
    logs: [...(original.logs ?? []), `从 ${source.id} 新建 AI 编辑指导的时长与目标尾帧修订；首镜剧本由 agent 重排，原动作和首帧保留。`,
      '原成片审核未通过状态保持在来源记录；未将 uncertain 改判为 incomplete，未声明人工接受。',
      '已调用原 story.script-review 内置确定性校验；新视频、成片质检和拼接尚未执行。'] }
  const encoded = encodeExecutionState(state)
  if (!same(decodeExecutionState(JSON.parse(JSON.stringify(encoded))), state) || jsonHash(decodeExecutionState(source.result)) !== sourceStateHash) fail('Serialization or preparation changed source/fork data')
  return { state, encoded, proof: { ...recovery, sourceRecordId: source.id, newRecordId: options.id,
    firstPendingIndex: 6, firstPendingNodeId: 'node-video', completedRuns: 6, totalRuns: runs.length,
    sourceUnchanged: true, workflowUnchanged: true, paidFirstFrameOutputPreserved: true,
    builtinScriptReviewPassed: true, laterShotsUnchanged: true, endImageSurvivesNodeRefresh: Boolean(media.endImage),
    allMediaStillRequiresReview: true, sourceVideoNotAccepted: true, readyForApply: Boolean(media.endImage),
    applyBlockers: media.endImage ? [] : ['Target end frame and its reviewed SHA256 are not yet specified'],
    recipe, shots: shots.map(shot => ({ title: shot.title, duration: shot.duration, content: shot.content,
      visualBeats: shot.visualBeats, timedActions: shot.timedActions })) } }
}

async function freshOutput(directory) {
  const out = path.resolve(directory)
  const generated = await realpath(GENERATED)
  let parent = out; const parts = []
  for (;;) {
    try { parent = path.join(await realpath(parent), ...parts); break }
    catch (error) { if (error.code !== 'ENOENT') throw error; parts.unshift(path.basename(parent)); parent = path.dirname(parent) }
  }
  if (parent === generated || parent.startsWith(generated + path.sep)) fail('Output must be outside public/generated')
  try { if ((await readdir(out)).length) fail('Output directory must be fresh and empty') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(out, { recursive: true })
  return out
}

async function run(db, options) {
  const applying = options.mode === 'apply'
  await db.query(applying ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const lock = applying ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${lock}`, [options.sourceId])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !workflow) fail('Source/workflow missing')
    const existing = (await db.query('SELECT id FROM execution_records WHERE id=$1', [options.id])).rows[0]
    if (existing) fail('Destination record already exists; refusing overwrite')
    const state = decodeExecutionState(source.result)
    if (state.nodeRuns?.some(item => item.status === 'running')) fail('Source still has a running request; wait for the original review to finish')
    const selected = selectStoryInspection(state).selections[0]
    if (selected?.review?.status !== 'failed') fail('Source media review is not failed')
    const media = { firstFrame: await generatedAsset(selected.image?.output?.url, ['.jpg', '.jpeg', '.png', '.webp'], true),
      sourceVideo: await generatedAsset(selected.review.output?.storyMediaReview?.videoEvidence?.url, ['.mp4', '.mov', '.webm']) }
    if (options.endImage) media.endImage = await generatedAsset(options.endImage, ['.jpg', '.jpeg', '.png', '.webp'], true)
    if (options.editorEvidence) {
      const file = await realpath(options.editorEvidence)
      const bytes = await readFile(file)
      await sharp(bytes, { failOn: 'error', limitInputPixels: 100_000_000 }).raw().toBuffer()
      media.editorEvidence = { file, sha256: sha256(bytes), role: 'AI-editor-visual-inspection-not-human-acceptance' }
    }
    const checked = { sourceMd5: source.result_md5, workflowMd5: workflow.nodes_md5, edgesMd5: workflow.edges_md5,
      firstFrameSha256: media.firstFrame.sha256, sourceVideoSha256: media.sourceVideo.sha256, endImageSha256: media.endImage?.sha256 }
    for (const [key, value] of Object.entries(checked)) if (options[key] && options[key].toLowerCase() !== value) fail(`${key} changed since reviewed dry-run`)
    const prepared = await prepareStoryTimingRecovery(source, workflow, media, options)
    if (options.planSha256 && prepared.proof.planSha256 !== options.planSha256.toLowerCase()) fail('Timing/end-frame recipe differs from reviewed dry-run')
    if (applying) {
      if (!prepared.proof.readyForApply) fail('Target end frame is missing')
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [options.id, source.workflow_id, source.workflow_name,
        `打工猫编辑时长与尾帧修订 · ${source.id}`, JSON.stringify(source.runtime_inputs ?? {}),
        JSON.stringify(prepared.encoded), prepared.proof.completedRuns, prepared.proof.totalRuns])
      const saved = (await db.query('SELECT result FROM execution_records WHERE id=$1', [options.id])).rows[0]
      if (!saved || !same(decodeExecutionState(saved.result), prepared.state)) fail('Inserted fork differs from prepared state')
    }
    const sourceAfter = (await db.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.md5
    const workflowAfter = (await db.query("SELECT md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]
    const mediaAfter = await generatedAsset(media.firstFrame.url, ['.jpg', '.jpeg', '.png', '.webp'], true)
    const videoAfter = await generatedAsset(media.sourceVideo.url, ['.mp4', '.mov', '.webm'])
    const endAfter = media.endImage ? await generatedAsset(media.endImage.url, ['.jpg', '.jpeg', '.png', '.webp'], true) : null
    if (sourceAfter !== source.result_md5 || workflowAfter.nodes_md5 !== workflow.nodes_md5 || workflowAfter.edges_md5 !== workflow.edges_md5
      || mediaAfter.sha256 !== media.firstFrame.sha256 || videoAfter.sha256 !== media.sourceVideo.sha256
      || media.endImage && endAfter.sha256 !== media.endImage.sha256) fail('Source, workflow, or media changed while preparing recovery')
    await db.query('COMMIT')
    return { ...prepared.proof, applied: applying, providerCalls: 0, sourceResultMd5After: sourceAfter }
  } catch (error) { await db.query('ROLLBACK'); throw error }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-timing-recovery.mjs --source record-SOURCE --id record-NEW --out FRESH_DIRECTORY --duration 10 --beat-ends 4,8 --dry-run [--end-image /generated/end.png --expected-end-image-sha256 SHA256] [--editor-evidence LOCAL_IMAGE]\n--apply additionally requires --expected-source-md5, --expected-workflow-md5, --expected-edges-md5, --expected-first-frame-sha256, --expected-source-video-sha256 and --expected-plan-sha256 from the reviewed dry run. Source must have a failed first-shot media review, no running requests, and later shots still idle. Apply inserts one idle fork only; no generation.')
    return
  }
  const out = await freshOutput(options.out)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const proof = await run(db, options)
    const destination = path.join(out, 'recovery-plan.json')
    await writeFile(destination, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ plan: destination, applied: proof.applied, sourceRecordId: proof.sourceRecordId,
      newRecordId: proof.newRecordId, planSha256: proof.planSha256, readyForApply: proof.readyForApply,
      applyBlockers: proof.applyBlockers, firstPendingNodeId: proof.firstPendingNodeId,
      builtinScriptReviewPassed: proof.builtinScriptReviewPassed, paidFirstFrameOutputPreserved: proof.paidFirstFrameOutputPreserved,
      laterShotsUnchanged: proof.laterShotsUnchanged, providerCalls: 0 }, null, 2))
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(clean(error instanceof Error ? error.message : error)); process.exitCode = 1
})
