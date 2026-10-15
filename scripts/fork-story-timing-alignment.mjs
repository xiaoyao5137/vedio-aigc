#!/usr/bin/env node
// Explicit post-generation timing alignment of an existing reviewed take.
// Never calls a media/model provider; only the original deterministic validators.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { createStoryScriptSource, renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { validateStoryShotAssessment } from '../server/story-media-review.ts'
import { requireConcatCurrentAcceptance } from '../server/video-concat-acceptance.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const GENERATED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const hash = createJsonHasher()
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a === undefined || b === undefined ? a === b : hash(a) === hash(b)
const fail = message => { throw Error(`STORY_TIMING_ALIGNMENT_INVALID: ${message}`) }

function args() {
  const result = {}, names = { '--source': 'sourceId', '--id': 'id', '--out': 'out', '--boundary': 'boundary',
    '--shot-index': 'shotIndex', '--beat-ends': 'beatEnds',
    '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5', '--expected-edges-md5': 'edgesMd5',
    '--expected-assets-sha256': 'assetsSha256', '--expected-plan-sha256': 'planSha256' }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dry-run' || flag === '--apply') { if (result.mode) fail('Choose one mode'); result.mode = flag.slice(2); continue }
    const key = names[flag]
    if (!key || result[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Unknown/duplicate argument ${flag}`)
    result[key] = argv[++i]
  }
  result.shotIndex = Number(result.shotIndex ?? 0)
  if (result.boundary !== undefined) result.boundary = Number(result.boundary)
  if (result.beatEnds !== undefined) result.beatEnds = result.beatEnds.split(',').map(Number)
  if (!/^record-[\w-]+$/.test(result.sourceId ?? '') || !/^record-[\w-]+$/.test(result.id ?? '') || result.sourceId === result.id
    || ![0, 1].includes(result.shotIndex) || !result.out || !result.mode
    || (result.beatEnds === undefined && !Number.isFinite(result.boundary))
    || (result.beatEnds !== undefined && (result.boundary !== undefined || !result.beatEnds.length || result.beatEnds.some(n => !Number.isFinite(n) || n <= 0)))) fail('Require source/new ID, shot-index 0/1, beat-ends (or legacy boundary), out, and explicit mode')
  for (const key of ['sourceMd5', 'workflowMd5', 'edgesMd5']) if (result[key] && !/^[a-f\d]{32}$/i.test(result[key])) fail(`Invalid ${key}`)
  for (const key of ['assetsSha256', 'planSha256']) if (result[key] && !/^[a-f\d]{64}$/i.test(result[key])) fail(`Invalid ${key}`)
  if (result.mode === 'apply' && ['sourceMd5', 'workflowMd5', 'edgesMd5', 'assetsSha256', 'planSha256'].some(key => !result[key])) fail('Apply requires all five reviewed locks')
  return result
}

async function asset(url) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.(?:mp4|png|jpe?g|webp|json)$/.test(url)) fail('Expected local immutable asset')
  const base = await realpath(GENERATED), file = await realpath(path.join(base, path.basename(url)))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('Unsafe asset')
  return { url, sha256: sha256(await readFile(file)) }
}

async function evidenceAssets(runs, shotIndex = 0) {
  const imageIndex = 5 + 4 * shotIndex, videoIndex = imageIndex + 1, reviewIndex = imageIndex + 2
  const e = runs[reviewIndex].output?.storyMediaReview?.videoEvidence
  if (!e?.decoded || e.technicalValidation?.passed !== true || !e.hasAudio) fail('Source lacks passed technical media evidence')
  const urls = [runs[imageIndex].output.url, runs[videoIndex].output.url, e.url, e.evidenceUrl, ...e.frames]
  const endImage = runs[videoIndex].output.params?.endImage
  if (endImage) urls.push(typeof endImage === 'string' ? endImage : endImage.url)
  const assets = await Promise.all([...new Set(urls)].map(asset))
  if (assets.find(a => a.url === e.url)?.sha256 !== e.sha256 || assets.find(a => a.url === runs[videoIndex].output.url)?.sha256 !== e.sha256) fail('Video bytes no longer match review')
  const receipt = JSON.parse(await readFile(path.join(GENERATED, path.basename(e.evidenceUrl)), 'utf8'))
  if (receipt.sha256 !== e.sha256 || receipt.url !== e.url || !same(receipt.frames, e.frames) || !same(receipt.frameTimes, e.frameTimes)) fail('Evidence receipt changed')
  return { assets, sha256: hash(assets) }
}

async function prepare(source, workflow, assets, options) {
  const original = decodeExecutionState(source.result), runs = original.nodeRuns
  const shotIndex = options.shotIndex, imageIndex = 5 + 4 * shotIndex, videoIndex = imageIndex + 1,
    reviewIndex = imageIndex + 2, concatIndex = imageIndex + 3
  upgradeStoryQualityWorkflow({ ...workflow, schemaVersion: workflow.schema_version })
  if (source.workflow_id !== 'wf-story' || workflow.schema_version !== 5 || original.id !== source.id || runs.length !== 13
    || runs.some(r => r.status === 'running') || runs.slice(0, reviewIndex).some(r => r.status !== 'success')
    || runs[reviewIndex].status !== 'failed' || runs.slice(concatIndex).some(r => r.status !== 'idle' || r.output !== undefined)
    || runs[reviewIndex].node.operation !== 'story.media-review') fail('Require stopped schema-5 target-review failure with paid prefix and later runs idle')
  const before = runs[3].output.shots, prior = runs[reviewIndex].output.storyMediaReview
  if (runs[3].output.passed !== true || before.length !== 2 || !before[shotIndex]
    || !same(runs[reviewIndex].inputContext.shot, before[shotIndex]) || !same(runs[reviewIndex].inputContext.video_shot, runs[videoIndex].output)
    || !same(runs[reviewIndex].output.videoEvidence, prior.videoEvidence)) fail('Source review is not bound to the approved script and paid media')
  const oldValidation = validateStoryShotAssessment(before[shotIndex], prior.videoEvidence, prior.observations, prior.assessment)
  if (prior.reviewStatus !== 'invalid' || prior.passed !== false || oldValidation.reviewStatus !== 'invalid'
    || !same(oldValidation.issues, prior.issues) || prior.assessment.passed !== true
    || prior.assessment.beatChecks.some(b => b.status !== 'complete') || prior.assessment.endingHold.status !== 'complete') fail('Only a preserved invalid report with actual all-complete assessment can be aligned')
  const shots = structuredClone(before), target = shots[shotIndex]
  const oldEnds = target.visualBeats.map(b => b.endSecond)
  const newEnds = options.beatEnds ?? (oldEnds.length === 2 ? [options.boundary, oldEnds[1]] : [])
  if (newEnds.length !== oldEnds.length || newEnds.at(-1) !== oldEnds.at(-1) || same(oldEnds, newEnds)) fail('Boundary plan must preserve every beat and final hold, and change at least one boundary')
  target.visualBeats = target.visualBeats.map((b, i) => ({ ...b, startSecond: i ? newEnds[i - 1] : 0, endSecond: newEnds[i] }))
  target.content = target.visualBeats.map(b => `${b.startSecond}—${b.endSecond}秒，${b.action}`).join('；')
  target.timedActions = renderStoryShotTimedActions(target)
  const reverted = structuredClone(shots)
  reverted[shotIndex].visualBeats = reverted[shotIndex].visualBeats.map((b, i) => ({ ...b,
    startSecond: before[shotIndex].visualBeats[i].startSecond, endSecond: before[shotIndex].visualBeats[i].endSecond }))
  reverted[shotIndex].content = before[shotIndex].content
  reverted[shotIndex].timedActions = before[shotIndex].timedActions
  if (!same(reverted, before)) fail('Other action/completion/duration/shot fields changed')
  const sourceBinding = createStoryScriptSource({ shots }, { sourceExecutionId: options.id, sourceRunId: runs[2].id })
  validateStoryShotTimingOutput(shots, { expectedCount: 2, source: sourceBinding })
  const validation = validateStoryShotAssessment(target, prior.videoEvidence, prior.observations, prior.assessment)
  if (!validation.passed || validation.reviewStatus !== 'passed' || validation.issues.length) fail('Original strict media validator still rejects the aligned contract')
  const provenance = { version: 'story-post-generation-timing-alignment-v1', method: 'post-generation-timing-alignment',
    author: 'AI-editor', createdAt: new Date().toISOString(), sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    workflowNodesMd5: workflow.nodes_md5, workflowEdgesMd5: workflow.edges_md5,
    sourceReviewStatus: 'invalid', sourceInvalidPreserved: true, sourceReviewIssues: prior.issues,
    modelCalls: 0, newModelConclusion: false, humanAccepted: false, fullVideoHumanAccepted: false,
    originalPaidMediaInputsAndPromptsPreserved: true, generationPromptMatchesRevisedContract: false,
    previousEditorialRelaxationPreserved: original.storyEditorialContractRecovery ?? null,
    previousTimingAlignmentPreserved: original.storyTimingAlignmentRecovery ?? null,
    change: { shotNumber: shotIndex + 1, beatEndSeconds: { before: oldEnds, after: newEnds },
      ...(oldEnds.length === 2 ? { firstBeatEndAndSecondBeatStart: { before: oldEnds[0], after: newEnds[0] } } : {}) },
    sourceFailedReviewOutputSha256: hash(runs[reviewIndex].output), sourceAssessmentSha256: hash(prior.assessment),
    sourceObservationsSha256: hash(prior.observations), sourceVideoEvidenceSha256: hash(prior.videoEvidence),
    sourceVideoSha256: prior.videoEvidence.sha256, sourceImageRunSha256: hash(runs[imageIndex]), sourceVideoRunSha256: hash(runs[videoIndex]),
    originalShotsSha256: hash(before), revisedShotsSha256: hash(shots), sourceBindingSha256: hash(sourceBinding),
    assetsSha256: assets.sha256, deterministicValidation: validation,
    acceptanceScope: 'Existing observations and assessment revalidated against an explicitly revised post-generation timing contract; no new model or human review.',
    limitation: 'This does not prove the take met its original timing contract. Original paid prompts and invalid source remain preserved.' }
  const planSha256 = hash({ source: source.id, id: options.id, sourceMd5: source.result_md5, workflowMd5: workflow.nodes_md5,
    edgesMd5: workflow.edges_md5, assetsSha256: assets.sha256, revisedShotsSha256: hash(shots), validationSha256: hash(validation) })
  const next = structuredClone(runs), prefix = { ...next[1].context, storyScriptSource: sourceBinding }
  const script = { model: 'agent-post-generation-timing-alignment', shots, items: shots, text: JSON.stringify(shots, null, 2), timingAlignmentProvenance: provenance }
  next[2] = { ...next[2], output: script, inputContext: prefix, context: { ...prefix, [next[2].node.resultVar]: script },
    durationMs: 0, revision: (next[2].revision ?? 0) + 1, timingAlignmentProvenance: provenance }
  const builtin = await executeBuiltinNode(null, { operation: 'story.script-review', params: { script, expectedCount: 2, source: sourceBinding } })
  if (builtin.passed !== true || builtin.repairAttempt?.attempted !== false || !same(builtin.shots, shots)) fail('Actual builtin script review did not pass without models')
  next[3] = { ...next[3], output: builtin, inputContext: next[2].context, inputs: { script, expectedCount: 2, source: sourceBinding },
    context: { ...next[2].context, script_review: builtin }, durationMs: 0, revision: (next[3].revision ?? 0) + 1 }
  next[4] = { ...next[4], inputContext: next[3].context, context: { ...next[3].context, [next[4].node.resultVar]: next[4].output } }
  const route = { ...next[4].context, first_frame: next[imageIndex].output, video_shot: next[videoIndex].output }
  next[reviewIndex] = { ...invalidateRunExecution(next[reviewIndex]), loopItem: target, routeInputContext: route,
    revision: (runs[reviewIndex].revision ?? 0) + 1, timingAlignmentProvenance: provenance }
  const input = prepareWorkflowRunContext(next, reviewIndex).inputContext
  const output = { ...runs[reviewIndex].output, passed: validation.passed, issues: validation.issues,
    storyMediaReview: { ...prior, ...validation, deterministicRevalidation: provenance }, deterministicRevalidation: provenance }
  delete output.error
  if (!same(output.storyMediaReview.observations, prior.observations) || !same(output.storyMediaReview.assessment, prior.assessment)
    || !same(output.storyMediaReview.videoEvidence, prior.videoEvidence)) fail('Original model evidence changed')
  const acceptance = requireConcatCurrentAcceptance(output)
  if (acceptance.sourceSha256 !== prior.videoEvidence.sha256) fail('Native concat gate does not bind exact reviewed bytes')
  next[reviewIndex] = { ...next[reviewIndex], status: 'success', inputs: { ...runs[reviewIndex].inputs, shot: target, video: next[videoIndex].output }, inputContext: input,
    output, context: { ...input, video_review: output } }
  next[concatIndex] = { ...next[concatIndex], loopItem: target }
  const refreshed = refreshPendingExecutionNodes({ ...workflow, schemaVersion: 5 }, next)
  const concat = prepareWorkflowRunContext(refreshed, concatIndex).inputContext
  const later = prepareWorkflowRunContext(refreshed, concatIndex + 1)?.inputContext
  if (!same(concat.video_review, output) || !same(concat.shot, target) || !same(concat.script_review, builtin)
    || later && (!same(later.shot, shots[shotIndex + 1]) || later.video_review || later.video_shot || later.first_frame || later.stage_video)
    || shotIndex > 0 && !same(concat.loop.previous.stage_video, runs[concatIndex - 4].output)
    || !same(next.slice(0, 2), runs.slice(0, 2)) || !same(next.slice(5, reviewIndex), runs.slice(5, reviewIndex))
    || !same(next.slice(concatIndex + 1), runs.slice(concatIndex + 1))) fail('Paid prefix or later loop context changed')
  const state = { ...structuredClone(original), id: options.id, parentExecutionId: source.id, requestScopeId: original.requestScopeId ?? source.id,
    generationScopeId: options.id, historical: false, mode: 'step', nodeRuns: next, context: next[reviewIndex].context,
    selectedNodeId: 'node-video-concat', storyTimingAlignmentRecovery: provenance,
    logs: [...(original.logs ?? []), `从 ${source.id} 显式生成后时间轴对齐：第${shotIndex + 1}镜动作结束点 ${oldEnds.join('/')}→${newEnds.join('/')} 秒；原动作与完成文字不变。`,
      '复用原盲观察及模型assessment，实际原validator重新计算通过；零模型调用，非新模型结论或人审。原invalid记录保留。'] }
  const encoded = encodeExecutionState(state)
  if (!same(decodeExecutionState(JSON.parse(JSON.stringify(encoded))), state)) fail('Storage round-trip changed state')
  return { encoded, proof: { ...provenance, newRecordId: options.id, planSha256, assets: assets.assets,
    firstPendingIndex: concatIndex, firstPendingNodeId: 'node-video-concat', builtinScriptReviewPassed: true,
    originalStrictMediaValidatorPassed: true, nativeConcatAcceptancePassed: true, observationsAndAssessmentExactlyPreserved: true,
    originalPaidRunsExactlyPreserved: true, nonTargetShotsAndRunsExactlyPreserved: true, concatAndLaterImageContextsVerified: true,
    preservedPaidRunIndices: Array.from({ length: reviewIndex - 5 }, (_, i) => i + 5), targetShotIndex: shotIndex,
    alignedShot: { content: target.content, duration: target.duration, visualBeats: target.visualBeats, timedActions: target.timedActions } } }
}

async function main() {
  const options = args(), out = path.resolve(options.out)
  if (out === GENERATED || out.startsWith(GENERATED + path.sep)) fail('Proof must be outside media directory')
  try { if ((await readdir(out)).length) fail('Require fresh empty proof directory') } catch (e) { if (e.code !== 'ENOENT') throw e }
  await mkdir(out, { recursive: true })
  const outReal = await realpath(out), mediaReal = await realpath(GENERATED)
  if (outReal === mediaReal || outReal.startsWith(mediaReal + path.sep)) fail('Proof directory resolves into media')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const applying = options.mode === 'apply', lock = applying ? ' FOR SHARE' : ''
    await db.query(applying ? 'BEGIN' : 'BEGIN READ ONLY')
    const source = (await db.query(`SELECT *,md5(result::text) result_md5 FROM execution_records WHERE id=$1${lock}`, [options.sourceId])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !workflow || (await db.query('SELECT id FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('Source/workflow missing or destination exists')
    const runs = decodeExecutionState(source.result).nodeRuns, assets = await evidenceAssets(runs, options.shotIndex)
    const prepared = await prepare(source, workflow, assets, options)
    const locks = { sourceMd5: source.result_md5, workflowMd5: workflow.nodes_md5, edgesMd5: workflow.edges_md5,
      assetsSha256: assets.sha256, planSha256: prepared.proof.planSha256 }
    for (const [key, value] of Object.entries(locks)) if (options[key] && options[key].toLowerCase() !== value) fail(`${key} changed since dry-run`)
    if (applying) {
      await db.query(`INSERT INTO execution_records (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,13)`, [options.id, source.workflow_id, source.workflow_name,
        `打工猫第${options.shotIndex + 1}镜生成后时间轴对齐 · ${source.id}`, JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(prepared.encoded), prepared.proof.firstPendingIndex])
      if (!same((await db.query('SELECT result FROM execution_records WHERE id=$1', [options.id])).rows[0].result, prepared.encoded)) fail('Inserted fork differs')
    }
    const unchanged = (await db.query('SELECT md5(result::text) md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]
    const current = (await db.query("SELECT md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]
    if (unchanged.md5 !== source.result_md5 || current.nodes_md5 !== workflow.nodes_md5 || current.edges_md5 !== workflow.edges_md5
      || (await evidenceAssets(runs, options.shotIndex)).sha256 !== assets.sha256) fail('Source/workflow/evidence changed during preparation')
    await db.query('COMMIT')
    const file = path.join(out, 'timing-alignment-fork.json')
    await writeFile(file, JSON.stringify({ ...prepared.proof, applied: applying }, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ proof: file, applied: applying, newRecordId: options.id, firstPendingIndex: prepared.proof.firstPendingIndex,
      originalStrictMediaValidatorPassed: true, builtinScriptReviewPassed: true, nativeConcatAcceptancePassed: true,
      modelCalls: 0, humanAccepted: false, locks }, null, 2))
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { await db.end() }
}

main().catch(error => { console.error(String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/gi, '[remote omitted]').replace(/data:[^\s"'<>]+/gi, '[data omitted]').slice(0, 3000)); process.exitCode = 1 })
