#!/usr/bin/env node
// New editorial action plan for the second shot; preserve all paid first-shot
// evidence and the second first-frame run. No provider calls and no overwrites.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { createStoryScriptSource, renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { validateStoryShotAssessment } from '../server/story-media-review.ts'
import { requireConcatCurrentAcceptance } from '../server/video-concat-acceptance.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const GENERATED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const hash = createJsonHasher(), sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a === undefined || b === undefined ? a === b : hash(a) === hash(b)
const fail = message => { throw Error(`STORY_SECOND_RETAKE_INVALID: ${message}`) }

function parseArgs() {
  const result = {}, argv = process.argv.slice(2), names = { '--source': 'sourceId', '--id': 'id', '--out': 'out',
    '--plan': 'plan', '--end-image': 'endImage', '--expected-end-image-sha256': 'endImageSha256',
    '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5', '--expected-edges-md5': 'edgesMd5',
    '--expected-assets-sha256': 'assetsSha256', '--expected-plan-sha256': 'planSha256' }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dry-run' || flag === '--apply') { if (result.mode) fail('Choose one mode'); result.mode = flag.slice(2); continue }
    const key = names[flag]
    if (!key || result[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Unknown/duplicate argument ${flag}`)
    result[key] = argv[++i]
  }
  if (!/^record-[\w-]+$/.test(result.sourceId ?? '') || !/^record-[\w-]+$/.test(result.id ?? '') || result.sourceId === result.id
    || !result.plan || !result.endImage || !result.endImageSha256 || !result.out || !result.mode) fail('Require distinct source/id, plan, end-image/hash, out and explicit mode')
  for (const key of ['sourceMd5', 'workflowMd5', 'edgesMd5']) if (result[key] && !/^[a-f\d]{32}$/i.test(result[key])) fail(`Invalid ${key}`)
  for (const key of ['endImageSha256', 'assetsSha256', 'planSha256']) if (result[key] && !/^[a-f\d]{64}$/i.test(result[key])) fail(`Invalid ${key}`)
  if (result.mode === 'apply' && ['sourceMd5', 'workflowMd5', 'edgesMd5', 'assetsSha256', 'planSha256'].some(key => !result[key])) fail('Apply requires all reviewed CAS locks')
  return result
}

async function asset(url, image = false) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.(?:mp4|png|jpe?g|webp|json)$/.test(url)) fail('Expected immutable local generated media')
  const base = await realpath(GENERATED), file = await realpath(path.join(base, path.basename(url)))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('Unsafe asset')
  const bytes = await readFile(file), result = { url, sha256: sha256(bytes) }
  if (image) {
    const decoder = sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 }), meta = await decoder.metadata()
    await decoder.raw().toBuffer()
    if (!meta.width || !meta.height || Math.abs(meta.width / meta.height - 9 / 16) > .04) fail('Expected decoded portrait image')
    Object.assign(result, { width: meta.width, height: meta.height })
  }
  return result
}

async function mediaAssets(runs, options) {
  const firstEvidence = runs[7].output?.storyMediaReview?.videoEvidence
  const rejectedEvidence = runs[11].output?.storyMediaReview?.videoEvidence
  const originalUrl = runs[10].output?.url
  const rejectedUrl = rejectedEvidence?.url || (/^\/generated\/[\w.-]+\.mp4$/.test(originalUrl ?? '') ? originalUrl
    : typeof originalUrl === 'string' ? `/generated/verified-${sha256(originalUrl).slice(0, 20)}.mp4` : '')
  const urls = [runs[5].output.url, runs[6].output.url, firstEvidence.url, firstEvidence.evidenceUrl,
    ...(firstEvidence.frames ?? []), runs[8].output.url, runs[9].output.url, rejectedUrl,
    ...(rejectedEvidence ? [rejectedEvidence.evidenceUrl, ...(rejectedEvidence.frames ?? [])].filter(Boolean) : [])]
  const assets = await Promise.all([...new Set(urls)].map(url => asset(url, url === runs[9].output.url)))
  const endImage = await asset(options.endImage, true)
  if (endImage.sha256 !== options.endImageSha256.toLowerCase() || endImage.sha256 === assets.find(a => a.url === runs[9].output.url).sha256) fail('End image changed or duplicates the first frame')
  if (assets.find(a => a.url === firstEvidence.url)?.sha256 !== firstEvidence.sha256
    || rejectedEvidence?.sha256 && assets.find(a => a.url === rejectedUrl)?.sha256 !== rejectedEvidence.sha256) fail('Local video bytes differ from saved review evidence')
  for (const e of [firstEvidence, rejectedEvidence].filter(e => e?.evidenceUrl)) {
    const saved = JSON.parse(await readFile(path.join(GENERATED, path.basename(e.evidenceUrl)), 'utf8'))
    if (saved.sha256 !== e.sha256 || saved.url !== e.url || !same(saved.frames, e.frames) || !same(saved.frameTimes, e.frameTimes)) fail('Saved evidence receipt differs')
  }
  return { assets: [...assets, endImage], assetsSha256: hash([...assets, endImage]), endImage, rejectedUrl }
}

async function prepare(source, workflow, media, plan, planFileSha256, options) {
  const original = decodeExecutionState(source.result), runs = original.nodeRuns
  if (source.id !== options.sourceId || original.id !== source.id || source.workflow_id !== 'wf-story' || workflow.schema_version !== 5) fail('Source/workflow identity mismatch')
  upgradeStoryQualityWorkflow({ ...workflow, schemaVersion: 5 })
  const ids = ['node-input', 'node-model-images', 'node-script', 'node-script-review', 'node-loop',
    'node-image', 'node-video', 'node-video-review', 'node-video-concat', 'node-image', 'node-video', 'node-video-review', 'node-video-concat']
  if (runs.length !== 13 || runs.some((r, i) => r.node.id !== ids[i] || r.status === 'running')
    || runs.slice(0, 11).some(r => r.status !== 'success') || runs[11].status !== 'failed'
    || runs[11].output?.storyMediaReview?.passed !== false || runs[12].status !== 'idle' || runs[12].output !== undefined) fail('Wait for stopped failed second review; require successful prefix and pending concat')
  const shots = structuredClone(runs[3].output.shots), priorSecond = structuredClone(shots[1])
  if (runs[3].output.passed !== true || shots.length !== 2 || !same(runs[11].inputContext.shot, priorSecond)
    || !same(runs[11].inputContext.video_shot, runs[10].output)) fail('Second failed review is not bound to current source')
  const firstReview = runs[7].output.storyMediaReview
  if (!validateStoryShotAssessment(shots[0], firstReview.videoEvidence, firstReview.observations, firstReview.assessment).passed
    || requireConcatCurrentAcceptance(runs[7].output).sourceSha256 !== firstReview.videoEvidence.sha256
    || !runs[8].output.sourceSha256?.includes(firstReview.videoEvidence.sha256)) fail('First-shot accepted evidence/concat binding is invalid')
  if (!plan || Object.keys(plan).some(key => !['duration', 'camera', 'visualBeats'].includes(key))
    || plan.duration !== 12 || !Array.isArray(plan.visualBeats) || plan.visualBeats.length !== 3
    || JSON.stringify(plan.visualBeats.map(b => [b.startSecond, b.endSecond])) !== '[[0,4],[4,8],[8,10]]'
    || typeof plan.camera !== 'string' || !plan.camera.startsWith(priorSecond.camera)
    || plan.camera.length > priorSecond.camera.length + 160) fail('Plan must be explicit 12-second/3-beat revision; camera may only append a short framing clarification')
  shots[1] = { ...priorSecond, ...structuredClone(plan), content: plan.visualBeats.map(b => `${b.startSecond}—${b.endSecond}秒，${b.action}`).join('；') }
  shots[1].timedActions = renderStoryShotTimedActions(shots[1])
  const binding = createStoryScriptSource({ shots }, { sourceExecutionId: options.id, sourceRunId: runs[2].id })
  validateStoryShotTimingOutput(shots, { expectedCount: 2, source: binding })
  if (!same(shots[0], runs[3].output.shots[0]) || shots[1].firstFramePrompt !== priorSecond.firstFramePrompt
    || shots[1].title !== priorSecond.title || shots[1].mood !== priorSecond.mood) fail('First shot or preserved second identity/start state changed')
  const videoNode = workflow.nodes.find(n => n.id === 'node-video'), endParam = videoNode.params.filter(p => (p.englishName || p.name) === 'endImage')
  if (endParam.length !== 1 || endParam[0].required || endParam[0].value !== '' || Object.keys(runs[10].paramOverrides ?? {}).length) fail('Video end-image config or existing overrides require reconciliation')
  const recipe = { sourceId: source.id, newId: options.id, sourceMd5: source.result_md5, workflowMd5: workflow.nodes_md5,
    edgesMd5: workflow.edges_md5, assetsSha256: media.assetsSha256, planFileSha256, revisedShotsSha256: hash(shots) }
  const provenance = { version: 'story-second-shot-editorial-retake-v1', method: 'AI-editor-directed-new-action-plan-and-endframe-retake',
    authoredBy: 'AI-editor', createdAt: new Date().toISOString(), sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    workflowNodesMd5: workflow.nodes_md5, workflowEdgesMd5: workflow.edges_md5, modelCallsOnFork: 0, humanAccepted: false,
    sourceFailedReviewPreserved: true, sourceSecondVideoAccepted: false, nextSecondVideoRequiresFreshMediaReview: true,
    sourceSecondReviewStatus: runs[11].output.storyMediaReview.reviewStatus,
    sourceSecondVideoRunSha256: hash(runs[10]), sourceFailedReviewOutputSha256: hash(runs[11].output),
    preservedFirstShotRunsSha256: hash(runs.slice(5, 9)), preservedSecondFirstFrameRunSha256: hash(runs[9]),
    originalSecondShot: priorSecond, revisedSecondShot: shots[1], planFileSha256, sourceBindingSha256: hash(binding),
    assetsSha256: media.assetsSha256, endImage: media.endImage, rejectedSecondVideoUrl: media.rejectedUrl,
    limitation: 'New action choreography to regenerate the second video; does not relax a contract to accept the failed take. First-shot editorial acceptance lineage stays unchanged.' }
  const next = structuredClone(runs), prefix = { ...next[1].context, storyScriptSource: binding }
  const script = { model: 'agent-second-shot-editorial-replan', shots, items: shots, text: JSON.stringify(shots, null, 2), editorialRetake: provenance }
  next[2] = { ...next[2], output: script, inputContext: prefix, context: { ...prefix, script_generation: script }, durationMs: 0,
    startedAt: undefined, revision: (next[2].revision ?? 0) + 1, editorialRetake: provenance }
  const review = await executeBuiltinNode(null, { operation: 'story.script-review', params: { script, expectedCount: 2, source: binding } })
  if (review.passed !== true || review.repairAttempt?.attempted !== false || !same(review.shots, shots)) fail('Actual builtin script review did not pass without model calls')
  next[3] = { ...next[3], output: review, inputs: { script, expectedCount: 2, source: binding }, inputContext: next[2].context,
    context: { ...next[2].context, script_review: review }, durationMs: 0, startedAt: undefined, revision: (next[3].revision ?? 0) + 1 }
  next[4] = { ...next[4], inputContext: next[3].context, context: { ...next[3].context, [next[4].node.resultVar]: next[4].output } }
  for (let i = 10; i <= 12; i++) next[i] = { ...invalidateRunExecution(next[i]), node: workflow.nodes.find(n => n.id === next[i].node.id),
    loopItem: shots[1], loopPrevious: undefined, attempt: 1, errorAttempt: 1, revision: (next[i].revision ?? 0) + 1 }
  next[10] = { ...next[10], routeInputContext: { ...next[4].context, first_frame: next[9].output },
    paramOverrides: { [endParam[0].id]: media.endImage.url }, editorialRetake: provenance }
  const refreshed = refreshPendingExecutionNodes({ ...workflow, schemaVersion: 5 }, next)
  const ctx = prepareWorkflowRunContext(refreshed, 10).inputContext
  const effective = { ...refreshed[10].node, params: refreshed[10].node.params.map(p => ({ ...p, value: refreshed[10].paramOverrides?.[p.id] ?? p.value })) }
  const duration = effective.params.find(p => p.englishName === 'duration')
  if (!same(ctx.shot, shots[1]) || !same(ctx.script_review, review) || !same(ctx.first_frame, runs[9].output)
    || !same(ctx.loop.previous.stage_video, runs[8].output) || ctx.video_shot || ctx.video_review || ctx.stage_video
    || resolveTemplateJsonValue(duration.value, ctx) !== 12 || !renderWorkflowTemplate(effective.prompt, ctx).includes(shots[1].timedActions)
    || effective.params.find(p => p.id === endParam[0].id).value !== media.endImage.url) fail('Refreshed paid video request does not bind the new plan, prior concat, original first frame and target end frame')
  if (!same(next.slice(0, 2), runs.slice(0, 2)) || !same(next.slice(5, 10), runs.slice(5, 10))
    || next.slice(10).some(r => r.status !== 'idle' || r.output !== undefined || r.error !== undefined)) fail('Preserved paid prefix or pending state changed')
  const state = { ...structuredClone(original), id: options.id, parentExecutionId: source.id, requestScopeId: original.requestScopeId ?? source.id,
    generationScopeId: options.id, historical: false, mode: 'step', nodeRuns: next, context: ctx, selectedNodeId: 'node-video', storySecondShotRetake: provenance,
    logs: [...(original.logs ?? []), `从 ${source.id} 新建第二镜 AI 编辑重拍方案：出窝、侧躺托下巴、舒展四肢，12秒。`,
      '首镜实际媒体、验收、拼接及第二镜首帧请求快照全部保留；原失败第二片保留在来源记录。',
      '实际内置剧本校验通过；新第二视频、媒体复核和最终拼接全部待执行，未声明媒体通过或人工接受。'] }
  const encoded = encodeExecutionState(state)
  if (!same(decodeExecutionState(JSON.parse(JSON.stringify(encoded))), state)) fail('State encoding changed')
  return { encoded, proof: { ...provenance, newRecordId: options.id, planSha256: hash(recipe), assets: media.assets,
    firstPendingIndex: 10, firstPendingNodeId: 'node-video', builtinScriptReviewPassed: true, originalPaidPrefixRunsExactlyPreserved: true,
    firstShotPlanExactlyPreserved: true, secondFirstFrameRunExactlyPreserved: true, targetEndImageOnlySecondVideo: true,
    futureVideoContextVerifiedAfterRefresh: true, completedRuns: 10, pendingRuns: 3, recipe } }
}

async function main() {
  const options = parseArgs(), out = path.resolve(options.out)
  if (out === GENERATED || out.startsWith(GENERATED + path.sep)) fail('Proof must be outside media')
  try { if ((await readdir(out)).length) fail('Require fresh empty output directory') } catch (e) { if (e.code !== 'ENOENT') throw e }
  await mkdir(out, { recursive: true })
  const outReal = await realpath(out), mediaReal = await realpath(GENERATED)
  if (outReal === mediaReal || outReal.startsWith(mediaReal + path.sep)) fail('Proof directory resolves into media')
  const planBytes = await readFile(options.plan), plan = JSON.parse(planBytes), planFileSha256 = sha256(planBytes)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const applying = options.mode === 'apply', lock = applying ? ' FOR SHARE' : ''
    await db.query(applying ? 'BEGIN' : 'BEGIN READ ONLY')
    const source = (await db.query(`SELECT *,md5(result::text) result_md5 FROM execution_records WHERE id=$1${lock}`, [options.sourceId])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !workflow || (await db.query('SELECT id FROM execution_records WHERE id=$1', [options.id])).rowCount) fail('Source/workflow missing or destination exists')
    const runs = decodeExecutionState(source.result).nodeRuns
    if (runs.some(r => r.status === 'running')) fail('Source still running; wait for original review to finish')
    const media = await mediaAssets(runs, options), prepared = await prepare(source, workflow, media, plan, planFileSha256, options)
    const locks = { sourceMd5: source.result_md5, workflowMd5: workflow.nodes_md5, edgesMd5: workflow.edges_md5,
      assetsSha256: media.assetsSha256, planSha256: prepared.proof.planSha256 }
    for (const [key, value] of Object.entries(locks)) if (options[key] && options[key].toLowerCase() !== value) fail(`${key} changed since dry-run`)
    if (applying) {
      await db.query(`INSERT INTO execution_records (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,10,0,13)`, [options.id, source.workflow_id, source.workflow_name,
        `打工猫第二镜出窝重拍 · ${source.id}`, JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(prepared.encoded)])
      if (!same((await db.query('SELECT result FROM execution_records WHERE id=$1', [options.id])).rows[0].result, prepared.encoded)) fail('Inserted fork differs')
    }
    const unchanged = (await db.query('SELECT md5(result::text) md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]
    const current = (await db.query("SELECT md5(nodes::text) nodes_md5,md5(edges::text) edges_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]
    if (unchanged.md5 !== source.result_md5 || current.nodes_md5 !== workflow.nodes_md5 || current.edges_md5 !== workflow.edges_md5
      || (await mediaAssets(runs, options)).assetsSha256 !== media.assetsSha256 || sha256(await readFile(options.plan)) !== planFileSha256) fail('Source/workflow/media/plan changed during preparation')
    await db.query('COMMIT')
    const file = path.join(out, 'second-shot-retake-fork.json')
    await writeFile(file, JSON.stringify({ ...prepared.proof, applied: applying }, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ proof: file, applied: applying, firstPendingIndex: 10, builtinScriptReviewPassed: true,
      paidPrefixPreserved: true, modelCallsOnFork: 0, targetEndImageOnlySecondVideo: true, locks }, null, 2))
  } catch (e) { await db.query('ROLLBACK'); throw e } finally { await db.end() }
}

main().catch(e => { console.error(String(e?.message ?? e).replace(/https?:\/\/[^\s"'<>]+/gi, '[remote omitted]').replace(/data:[^\s"'<>]+/gi, '[data omitted]').slice(0, 3000)); process.exitCode = 1 })
