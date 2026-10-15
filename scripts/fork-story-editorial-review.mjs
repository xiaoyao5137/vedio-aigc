#!/usr/bin/env node
// Explicit post-generation editorial contract change. Preserves original paid
// request snapshots and leaves the new media review idle. Never generates media.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { createStoryScriptSource, renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { validateStoryShotAssessment } from '../server/story-media-review.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { selectStoryInspection } from './inspect-story-generation.mjs'

const GENERATED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const hash = createJsonHasher()
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a === undefined || b === undefined ? a === b : hash(a) === hash(b)
const fail = message => { throw Error(`STORY_EDITORIAL_FORK_INVALID: ${message}`) }
const clean = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/gi, '[remote URL omitted]')
  .replace(/data:[^\s"'<>]+/gi, '[data omitted]').slice(0, 3000)

function parseArgs(args) {
  const options = {}
  const keys = { '--source': 'sourceId', '--id': 'id', '--out': 'out', '--beat-id': 'beatId', '--completion': 'completion',
    '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5', '--expected-edges-md5': 'edgesMd5',
    '--expected-assets-sha256': 'assetsSha256', '--expected-plan-sha256': 'planSha256' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { options.help = true; continue }
    if (arg === '--dry-run' || arg === '--apply') { if (options.mode) fail('Choose one explicit mode'); options.mode = arg.slice(2); continue }
    const key = keys[arg]
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail(`Unknown or duplicate flag ${arg}`)
    options[key] = args[++i]
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '') || !/^record-[\w-]+$/.test(options.id ?? '')
    || options.sourceId === options.id || !/^[\w-]+$/.test(options.beatId ?? '') || !options.completion?.trim()
    || options.completion.length > 500 || !options.out || !options.mode) fail('Require source/new ID, beat ID, completion, out and explicit mode')
  for (const key of ['sourceMd5', 'workflowMd5', 'edgesMd5']) if (options[key] && !/^[a-f\d]{32}$/i.test(options[key])) fail(`Invalid ${key}`)
  for (const key of ['assetsSha256', 'planSha256']) if (options[key] && !/^[a-f\d]{64}$/i.test(options[key])) fail(`Invalid ${key}`)
  if (options.mode === 'apply' && ['sourceMd5', 'workflowMd5', 'edgesMd5', 'assetsSha256', 'planSha256'].some(key => !options[key])) fail('--apply requires every reviewed CAS lock')
  return options
}

async function asset(url, extensions) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+$/.test(url) || !extensions.includes(path.extname(url))) fail('Expected a local immutable generated asset')
  const base = await realpath(GENERATED), file = await realpath(path.join(base, path.basename(url)))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('Unsafe or missing asset')
  return { url, sha256: sha256(await readFile(file)), file }
}

async function reviewAssets(first) {
  const evidence = first.review.output.storyMediaReview.videoEvidence
  const image = await asset(first.image.output.url, ['.png', '.jpg', '.jpeg', '.webp'])
  const video = await asset(first.video.output.url, ['.mp4'])
  const reviewedVideo = await asset(evidence.url, ['.mp4'])
  if (video.sha256 !== evidence.sha256 || reviewedVideo.sha256 !== evidence.sha256) fail('Paid/derived video bytes do not match reviewed evidence')
  const receipt = await asset(evidence.evidenceUrl, ['.json'])
  const saved = JSON.parse(await readFile(receipt.file, 'utf8'))
  if (saved.sha256 !== evidence.sha256 || saved.url !== evidence.url || !same(saved.frames, evidence.frames)
    || !same(saved.frameTimes, evidence.frameTimes)) fail('Evidence receipt differs from saved review')
  const frames = []
  for (const [index, url] of evidence.frames.entries()) {
    const checked = await asset(url, ['.jpg'])
    frames.push({ index, second: evidence.frameTimes[index], url, sha256: checked.sha256 })
  }
  const endUrl = first.video.output.params?.endImage
  const endImage = endUrl ? await asset(typeof endUrl === 'string' ? endUrl : endUrl.url, ['.png', '.jpg', '.jpeg', '.webp']) : null
  const publicAsset = item => item ? { url: item.url, sha256: item.sha256 } : null
  const bundle = { image: publicAsset(image), video: publicAsset(video), reviewedVideo: publicAsset(reviewedVideo),
    receipt: publicAsset(receipt), endImage: publicAsset(endImage), frames }
  return { ...bundle, assetsSha256: hash(bundle) }
}

export async function prepareStoryEditorialFork(source, workflowRow, assets, options, createdAt = new Date().toISOString()) {
  if (source?.id !== options.sourceId || source.workflow_id !== 'wf-story' || workflowRow?.id !== 'wf-story'
    || workflowRow.schema_version !== 5) fail('Source/current schema-5 workflow unavailable')
  const workflow = { ...workflowRow, schemaVersion: 5 }
  upgradeStoryQualityWorkflow(workflow)
  const original = decodeExecutionState(source.result), sourceHash = hash(original), runs = original.nodeRuns
  if (original.id !== source.id || runs.some(run => run.status === 'running')) fail('Source identity differs or request still running')
  const selected = selectStoryInspection(original), first = selected.selections[0]
  if (!selected.scriptPassed || !first || first.bindingIssues.length || runs.length !== 5 + selected.selections.length * 4
    || runs.slice(0, 7).some(run => run.status !== 'success') || first.review?.status !== 'failed'
    || runs.slice(8).some(run => run.status !== 'idle' || run.output !== undefined)) fail('Source must be a fully bound first-shot failure with later shots pending')
  const priorReview = first.review.output.storyMediaReview
  const validatedPrior = validateStoryShotAssessment(first.shot, priorReview.videoEvidence, priorReview.observations, priorReview.assessment)
  if (priorReview.passed !== false || priorReview.reviewStatus !== 'uncertain' || validatedPrior.reviewStatus !== 'uncertain') fail('Source uncertainty cannot be reclassified or hidden')
  const oldShots = selected.scriptReview.output.shots, shots = structuredClone(oldShots)
  const beatIndex = shots[0].visualBeats.findIndex(beat => beat.id === options.beatId)
  if (beatIndex < 0 || shots[0].visualBeats.filter(beat => beat.id === options.beatId).length !== 1) fail('Requested beat is ambiguous or absent')
  const previousCompletion = shots[0].visualBeats[beatIndex].completion
  if (previousCompletion === options.completion) fail('Completion is unchanged')
  shots[0].visualBeats[beatIndex].completion = options.completion
  shots[0].timedActions = renderStoryShotTimedActions(shots[0])
  const reverted = structuredClone(shots)
  reverted[0].visualBeats[beatIndex].completion = previousCompletion
  reverted[0].timedActions = oldShots[0].timedActions
  if (!same(reverted, oldShots)) fail('An editorial completion change modified other story fields')
  const newRootBinding = createStoryScriptSource({ shots }, { sourceExecutionId: options.id, sourceRunId: selected.script.id })
  validateStoryShotTimingOutput(shots, { expectedCount: shots.length, source: newRootBinding })
  const provenance = { version: 'story-post-generation-editorial-adjustment-v1', method: 'post-generation-editorial-adjustment',
    author: 'AI-editor', createdAt, sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    workflowNodesMd5: workflowRow.nodes_md5, workflowEdgesMd5: workflowRow.edges_md5,
    sourceScriptOutputSha256: hash(selected.script.output), sourceScriptReviewOutputSha256: hash(selected.scriptReview.output),
    sourceFailedReviewOutputSha256: hash(first.review.output), sourceUncertaintyPreserved: true, sourceReviewStatus: 'uncertain',
    humanAccepted: false, mediaAccepted: false, modelCallsOnFork: 0, videoRegeneration: false,
    change: { shotNumber: 1, beatId: options.beatId, field: 'completion', before: previousCompletion, after: options.completion },
    originalPaidPromptPreserved: true, generationPromptMatchesRevisedContract: false,
    originalPaidInputSnapshotsPreserved: true, originalPaidVideoOutputSha256: hash(first.video.output),
    originalPaidVideoInputContextSha256: hash(first.video.inputContext), originalPaidImageRunSha256: hash(first.image),
    originalPaidVideoRunSha256: hash(first.video), revisedShotsSha256: hash(shots),
    newRootSourceBinding: { sourceExecutionId: options.id, sourceRunId: selected.script.id, sha256: hash(newRootBinding) },
    assetsSha256: assets.assetsSha256,
    limitation: 'Original provider request still uses the earlier completion. This is an explicit editorial relaxation of a nonessential pose after generation; a fresh media review is required.' }
  const planSha256 = hash({ sourceId: source.id, id: options.id, sourceMd5: source.result_md5, workflowMd5: workflowRow.nodes_md5,
    edgesMd5: workflowRow.edges_md5, assetsSha256: assets.assetsSha256, revisedShotsSha256: hash(shots), change: provenance.change })
  const next = structuredClone(runs), script = next[2]
  const prefixContext = { ...next[1].context, storyScriptSource: newRootBinding }
  const output = { model: 'agent-post-generation-editorial-adjustment', shots, items: shots, text: JSON.stringify(shots, null, 2),
    editorialProvenance: provenance }
  next[2] = { ...script, output, inputContext: prefixContext,
    context: { ...prefixContext, [script.node.resultVar]: output }, startedAt: undefined, durationMs: 0,
    revision: (script.revision ?? 0) + 1, editorialProvenance: provenance }
  const builtin = await executeBuiltinNode(null, { operation: 'story.script-review',
    params: { script: output, expectedCount: shots.length, source: newRootBinding } })
  if (builtin.passed !== true || builtin.repairAttempt?.attempted !== false || !same(builtin.shots, shots)) fail('New editorial root did not pass actual builtin script review')
  const currentReviewNode = workflow.nodes.find(node => node.id === 'node-script-review')
  next[3] = { ...next[3], node: currentReviewNode, output: builtin, inputContext: next[2].context,
    inputs: { script: output, expectedCount: shots.length, source: newRootBinding },
    context: { ...next[2].context, [currentReviewNode.resultVar]: builtin }, startedAt: undefined, durationMs: 0,
    revision: (next[3].revision ?? 0) + 1, editorialProvenance: provenance }
  next[4] = { ...next[4], inputContext: next[3].context,
    context: { ...next[3].context, [next[4].node.resultVar]: next[4].output } }
  // Keep image/video runs byte-for-byte: these are evidence of the actual paid
  // request, whose original completion still says the bag hangs down.
  const routeContext = { ...next[4].context, [first.image.node.resultVar]: first.image.output,
    [first.video.node.resultVar]: first.video.output }
  next[7] = { ...invalidateRunExecution(next[7]), node: workflow.nodes.find(node => node.id === 'node-video-review'),
    loopItem: shots[0], routeInputContext: routeContext, loopPrevious: undefined,
    revision: (first.review.revision ?? 0) + 1, attempt: 1, errorAttempt: 1,
    editorialContractReview: { version: provenance.version, sourceExecutionId: source.id, change: provenance.change,
      originalPaidVideoOutputSha256: hash(first.video.output), revisedShotSha256: hash(shots[0]) } }
  const refreshed = refreshPendingExecutionNodes(workflow, next), prepared = prepareWorkflowRunContext(refreshed, 7)
  if (!prepared || !same(prepared.inputContext.shot, shots[0]) || !same(prepared.inputContext.script_review, builtin)
    || !same(prepared.inputContext.video_shot, first.video.output) || prepared.inputContext.video_review
    || prepared.inputContext.stage_video || refreshed[7].node.operation !== 'story.media-review') fail('New media review is not bound to the editorial plan and original paid media')
  if (!same(next.slice(0, 2), runs.slice(0, 2)) || !same(next.slice(5, 7), runs.slice(5, 7))
    || !same(next.slice(8), runs.slice(8)) || next[7].status !== 'idle' || next[7].output !== undefined) fail('Original paid evidence or pending later shots changed')
  const state = { ...structuredClone(original), id: options.id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? source.id, generationScopeId: options.id, historical: false, mode: 'step',
    nodeRuns: next, context: routeContext, selectedNodeId: 'node-video-review', storyEditorialContractRecovery: provenance,
    logs: [...(original.logs ?? []), `从 ${source.id} 新建生成后 AI 编辑契约修订；仅修改 ${options.beatId} 的非关键完成姿态描述。`,
      '保留原生成提示词、全部付费请求快照和原视频；原uncertain失败记录不变。',
      '新编辑根契约已通过实际内置剧本校验；媒体未获通过，等待node-video-review按新契约重新实查。'] }
  const encoded = encodeExecutionState(state)
  if (!same(decodeExecutionState(JSON.parse(JSON.stringify(encoded))), state) || hash(decodeExecutionState(source.result)) !== sourceHash) fail('Storage/source invariants changed')
  return { state, encoded, proof: { ...provenance, planSha256, newRecordId: options.id, assets,
    firstPendingIndex: 7, firstPendingNodeId: 'node-video-review', builtinScriptReviewPassed: true,
    originalImageAndVideoRunsExactlyPreserved: true, laterRunsExactlyPreserved: true,
    reviewContextVerifiedAfterRefresh: true,
    expectedStrictInspectionDifferences: ['Original image/video loopItem and inputContext retain the pre-edit contract.',
      'Original video prompt retains the old completion; it does not fully match revised timedActions.'],
    mediaReviewStillIdle: true, sourceUnchanged: true } }
}

async function run(db, options) {
  const applying = options.mode === 'apply'
  await db.query(applying ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const lock = applying ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) result_md5 FROM execution_records WHERE id=$1${lock}`, [options.sourceId])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !workflow || (await db.query('SELECT id FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('Source/workflow missing or destination exists')
    const selected = selectStoryInspection(decodeExecutionState(source.result))
    const assets = await reviewAssets(selected.selections[0])
    const prepared = await prepareStoryEditorialFork(source, workflow, assets, options)
    const locks = { sourceMd5: source.result_md5, workflowMd5: workflow.nodes_md5, edgesMd5: workflow.edges_md5,
      assetsSha256: assets.assetsSha256, planSha256: prepared.proof.planSha256 }
    for (const [key, value] of Object.entries(locks)) if (options[key] && options[key].toLowerCase() !== value) fail(`${key} changed since dry-run`)
    if (applying) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,7,0,$7)`, [options.id, source.workflow_id, source.workflow_name,
        `打工猫生成后编辑契约复核 · ${source.id}`, JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(prepared.encoded), prepared.state.nodeRuns.length])
      const inserted = (await db.query('SELECT result FROM execution_records WHERE id=$1', [options.id])).rows[0]
      if (!inserted || !same(decodeExecutionState(inserted.result), prepared.state)) fail('Inserted fork changed')
    }
    const afterSource = (await db.query('SELECT md5(result::text) md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.md5
    const afterWorkflow = (await db.query("SELECT md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]
    const afterAssets = await reviewAssets(selected.selections[0])
    if (afterSource !== source.result_md5 || afterWorkflow.nodes_md5 !== workflow.nodes_md5 || afterWorkflow.edges_md5 !== workflow.edges_md5
      || afterAssets.assetsSha256 !== assets.assetsSha256) fail('Source/workflow/frame assets changed during preparation')
    await db.query('COMMIT')
    return { ...prepared.proof, applied: applying, sourceResultMd5After: afterSource }
  } catch (error) { await db.query('ROLLBACK'); throw error }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-editorial-review.mjs --source record-SOURCE --id record-NEW --beat-id BEAT --completion TEXT --out FRESH_DIRECTORY --dry-run\n--apply additionally requires --expected-source-md5/workflow-md5/edges-md5/assets-sha256/plan-sha256. No media generation; original paid inputs remain unchanged.')
    return
  }
  const out = path.resolve(options.out)
  if (out === GENERATED || out.startsWith(GENERATED + path.sep)) fail('Output must be outside generated media')
  try { if ((await readdir(out)).length) fail('Output must be fresh and empty') } catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(out, { recursive: true })
  const outReal = await realpath(out), mediaReal = await realpath(GENERATED)
  if (outReal === mediaReal || outReal.startsWith(mediaReal + path.sep)) fail('Output resolves into generated media')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const proof = await run(db, options), file = path.join(out, 'editorial-review-fork.json')
    await writeFile(file, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ proof: file, applied: proof.applied, newRecordId: proof.newRecordId,
      firstPendingNodeId: proof.firstPendingNodeId, builtinScriptReviewPassed: proof.builtinScriptReviewPassed,
      originalImageAndVideoRunsExactlyPreserved: proof.originalImageAndVideoRunsExactlyPreserved,
      reviewContextVerifiedAfterRefresh: proof.reviewContextVerifiedAfterRefresh,
      generationPromptMatchesRevisedContract: false, mediaReviewStillIdle: true }, null, 2))
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(clean(error instanceof Error ? error.message : error)); process.exitCode = 1
})
