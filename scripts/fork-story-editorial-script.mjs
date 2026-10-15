#!/usr/bin/env node
/** Fork a reviewed wf-story script into a new idle script-review execution.
 * The completed writer run remains byte-equivalent in the child; the edited
 * script is an explicit route input, never a replacement model result. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { hasExecutionPlanMismatch, refreshPendingExecutionNodes } from '../src/workflow-core.ts'
import { STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { createStoryScriptSource } from '../src/story-shot-timing.ts'
import { resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = createJsonHasher()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (left, right) => left === undefined || right === undefined
  ? left === right : hash(left) === hash(right)
const fail = detail => { throw Error(`STORY_EDITORIAL_FORK_INVALID: ${detail}`) }
const safe = value => String(value).replace(/https?:\/\/[^\s"'<>]+/gi, '[remote omitted]')
  .replace(/data:[^\s"'<>]+/gi, '[image data omitted]').slice(0, 2000)

export function parseArguments(argv) {
  const options = { apply: false }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--dry-run') continue
    if (flag === '--help') { options.help = true; continue }
    const key = { '--source': 'source', '--id': 'id', '--shots': 'shots', '--out': 'out', '--expect': 'expect' }[flag]
    if (!key || options[key] || !argv[index + 1] || argv[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = argv[++index]
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.source ?? '') || !/^record-[\w-]+$/.test(options.id ?? '')
    || options.source === options.id || !options.shots || !options.out) {
    fail('require distinct --source/--id plus --shots and --out')
  }
  if (options.apply && !options.expect) fail('--apply requires a reviewed dry-run receipt via --expect')
  if (!options.apply && options.expect) fail('--expect is only used with --apply')
  return options
}

const prefixIds = ['node-input', 'node-model-images', 'node-script', 'node-script-review', 'node-loop']
const loopChildIds = ['node-image', 'node-video', 'node-video-review', 'node-video-concat']
const routedLoopChildIds = ['node-image', 'node-video', 'node-video-review',
  STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID, 'node-video-concat']

/** The source's four child runs are historical shells. Insert only an idle
 * result-branch shell per shot so the edited child matches the current
 * schema-6 graph before its loop builds fresh shot-scoped runs. */
export function addPendingStoryResultBranchRuns(runs, workflow, count) {
  const branch = workflow.nodes.find(node => node.id === STORY_VIDEO_REVIEW_RESULT_BRANCH_NODE_ID)
  const loop = workflow.nodes.find(node => node.id === 'node-loop')
  if (workflow.schemaVersion !== 6 || !branch || branch.kind !== 'branch'
    || !same(loop?.childIds, routedLoopChildIds) || runs.length !== prefixIds.length + count * loopChildIds.length) {
    fail('current schema-6 result route does not match the reviewed source loop')
  }
  const expanded = runs.slice(0, prefixIds.length)
  for (let shotIndex = 0; shotIndex < count; shotIndex++) {
    const first = prefixIds.length + shotIndex * loopChildIds.length
    const children = runs.slice(first, first + loopChildIds.length)
    if (!same(children.map(run => run.node?.id), loopChildIds)
      || children.some(run => run.status !== 'idle' || run.output !== undefined)) {
      fail(`shot ${shotIndex + 1} has a non-idle or changed source loop shell`)
    }
    const [image, video, review, concat] = children
    expanded.push(image, video, review, {
      ...invalidateRunExecution(concat),
      id: `${branch.id}-${shotIndex}-editorial-${concat.id}`,
      node: branch,
      label: `第 ${shotIndex + 1} 轮 / ${branch.title} -> ${branch.resultVar}`,
      revision: 0, attempt: 1, errorAttempt: 1,
    }, concat)
  }
  return expanded
}

/** Hash a paid first frame in its source record without copying its URL into the fork or receipt. */
export async function inspectSupersededPaidImage(run, reviewedShot, mediaRoot = path.join(ROOT, 'public/generated')) {
  const output = run?.output
  const url = output?.url
  const image = output?.raw?.raw?.image
  if (run?.node?.id !== 'node-image' || run.status !== 'success'
    || typeof url !== 'string' || !/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(url)
    || !same(output.urls, [url]) || !same(output.items, [{ url }])
    || !same(run.loopItem, reviewedShot) || !same(run.inputContext?.shot, reviewedShot)
    || !same(output.params?.storyShot, reviewedShot)
    || image?.url !== url || !/^[a-f0-9]{64}$/i.test(image.sha256 ?? '')
    || !Number.isSafeInteger(image.bytes) || image.bytes <= 0) {
    fail('completed paid image is not bound to the reviewed first shot and one archived asset')
  }
  const root = await realpath(mediaRoot)
  const file = await realpath(path.join(root, url.slice('/generated/'.length)))
  if (path.dirname(file) !== root) fail('completed paid image archive escapes generated media')
  const bytes = await readFile(file)
  const assetSha256 = sha(bytes)
  if (assetSha256 !== image.sha256 || bytes.length !== image.bytes) {
    fail('completed paid image archive differs from its saved generation result')
  }
  return { sourceRunId: run.id, loopIndex: run.loopIndex,
    outputSha256: hash(output), archivedAssetSha256: assetSha256, archivedAssetBytes: bytes.length,
    reviewedShotSha256: hash(reviewedShot) }
}

export async function prepareEditorialFork(source, workflowRow, planBytes, options) {
  const original = decodeExecutionState(source.result)
  const runs = original.nodeRuns
  const count = Number(original.runtimeInputs?.input?.vedio_count)
  const expectedIds = Number.isSafeInteger(count) && count > 0
    ? [...prefixIds, ...Array.from({ length: count }, () => loopChildIds).flat()]
    : []
  if (source.workflow_id !== 'wf-story' || original.workflowId !== 'wf-story' || original.id !== source.id
    || workflowRow.id !== 'wf-story' || ![5, 6].includes(workflowRow.schema_version)
    || !Array.isArray(runs) || runs.length !== expectedIds.length
    || runs.some((run, index) => run.node?.id !== expectedIds[index])
    || runs.slice(0, 4).some(run => run.status !== 'success')
    || runs[3].output?.passed !== true || runs[3].output?.version !== 'story-script-review-v1') {
    fail('expected a reviewed execution with a successful writer prefix and four child runs per shot')
  }
  const reviewedOnly = runs.slice(4).every(run => run.status === 'idle' && run.output === undefined)
  const firstImageComplete = runs[4].status === 'success' && runs[4].output?.count === count
    && runs[5].status === 'success' && runs[5].output !== undefined
    && runs.slice(6).every(run => run.status === 'idle' && run.output === undefined)
  if (!reviewedOnly && !firstImageComplete) {
    fail('only a reviewed-only source or one completed first image with all later media idle can be forked')
  }
  const originalShots = runs[2].output?.shots
  const priorReviewedShots = runs[3].output?.shots
  if (!Array.isArray(originalShots) || originalShots.length !== count
    || !Array.isArray(priorReviewedShots) || priorReviewedShots.length !== count
    || runs[4].node.loop?.sourcePath !== 'script_review.shots') {
    fail('original model script, review or loop binding is incomplete')
  }
  const supersededPaidImages = firstImageComplete
    ? [await inspectSupersededPaidImage(runs[5], priorReviewedShots[0])]
    : []
  let parsed
  try { parsed = JSON.parse(planBytes) } catch { fail('edited shots file must contain JSON') }
  const shots = Array.isArray(parsed) ? parsed : parsed?.shots
  const shotFields = originalShots.map(shot => shot && typeof shot === 'object' && !Array.isArray(shot)
    ? Object.keys(shot).sort() : [])
  if (!Array.isArray(shots) || shots.length !== count || !shots.every((shot, index) => shot && typeof shot === 'object'
    && !Array.isArray(shot) && !Object.hasOwn(shot, 'timedActions')
    && same(Object.keys(shot).sort(), shotFields[index]))) {
    fail('edited plan must contain raw script shots with exactly the original model shot fields and no timedActions')
  }
  const changes = []
  for (let index = 0; index < shots.length; index++) {
    for (const key of shotFields[index]) {
      const before = originalShots[index]?.[key], after = shots[index]?.[key]
      if (!same(before, after)) changes.push({ shotIndex: index, field: key,
        beforeSha256: hash(before ?? null), afterSha256: hash(after ?? null) })
    }
  }
  if (!changes.length) fail('editorial plan is identical to the original model script')
  const activeReviewedShots = priorReviewedShots.map(({ timedActions: _compiled, ...shot }) => shot)
  const changesFromActive = []
  for (let index = 0; index < shots.length; index++) {
    for (const key of shotFields[index]) {
      if (!same(activeReviewedShots[index]?.[key], shots[index]?.[key])) {
        changesFromActive.push({ shotIndex: index, field: key,
          beforeSha256: hash(activeReviewedShots[index]?.[key] ?? null),
          afterSha256: hash(shots[index]?.[key] ?? null) })
      }
    }
  }
  if (!changesFromActive.length) fail('editorial plan is identical to the source record\'s active reviewed script')
  const originalDraftSource = createStoryScriptSource(runs[2].output,
    { sourceExecutionId: source.id, sourceRunId: runs[2].id })
  const editorialScript = { shots, editorialOrigin: {
    method: 'explicit-preproduction-editorial-fork', originalExecutionId: source.id,
    originalWriterRunId: runs[2].id, originalWriterOutputSha256: hash(runs[2].output),
    originalModelOutputPreserved: true, newModelGeneration: false, humanAccepted: false } }
  const editorialSource = createStoryScriptSource(editorialScript,
    { sourceExecutionId: options.id, sourceRunId: 'editorial-script-input' })
  const workflow = upgradeStoryQualityWorkflow({ id: workflowRow.id,
    schemaVersion: workflowRow.schema_version, nodes: workflowRow.nodes, edges: workflowRow.edges })
  const reviewNode = workflow.nodes.find(node => node.id === 'node-script-review')
  const scriptParams = reviewNode?.params?.filter(param => (param.englishName || param.name) === 'script') ?? []
  if (reviewNode?.kind !== 'validation' || reviewNode.operation !== 'story.script-review'
    || scriptParams.length !== 1 || workflow.schemaVersion !== 6 || workflow.nodes.length !== 10) {
    fail('current workflow lacks the native script-review and routed media-review contract')
  }
  const next = structuredClone(runs)
  next[3] = { ...invalidateRunExecution(next[3]), node: reviewNode,
    revision: (next[3].revision ?? 0) + 1, attempt: 1, errorAttempt: 1, attempts: undefined,
    paramOverrides: { [scriptParams[0].id]: '${editorialScript}' },
    routeInputOverrides: { editorialScript, storyScriptSource: editorialSource } }
  next[4] = { ...invalidateRunExecution(next[4]), attempts: undefined }
  // These are only old loop shells. The loop node regenerates its children
  // from the new reviewed shots before any paid child can execute.
  for (let index = 5; index < next.length; index++) {
    next[index] = { ...invalidateRunExecution(next[index]), loopItem: undefined,
      loopPrevious: undefined, loopNode: undefined, loopGroupId: undefined,
      loopIndex: undefined, loopIsLast: undefined, attempts: undefined, paramOverrides: undefined }
  }
  const refreshed = refreshPendingExecutionNodes(workflow,
    addPendingStoryResultBranchRuns(next, workflow, count))
  const prepared = prepareWorkflowRunContext(refreshed, 3)
  const values = Object.fromEntries(refreshed[3].node.params.map(param => [param.englishName || param.name,
    resolveTemplateJsonValue(refreshed[3].paramOverrides?.[param.id] ?? param.value, prepared.inputContext)]))
  if (!same(refreshed.slice(0, 3), runs.slice(0, 3)) || !same(values.script, editorialScript)
    || !same(values.source, editorialSource) || Number(values.expectedCount) !== count
    || !same(prepared.inputContext.script_generation, runs[2].output)
    || prepared.inputContext.script_review !== undefined
    || refreshed.slice(3).some(run => run.status !== 'idle' || run.output !== undefined)
    || refreshed.slice(5).some(run => run.loopItem !== undefined)
    || hasExecutionPlanMismatch(workflow, refreshed)) {
    fail('refresh/context did not preserve the writer and route only the editorial script to pending review')
  }
  const preflight = await executeBuiltinNode(null, { operation: 'story.script-review', params: values,
    executionContext: { workflowId: 'wf-story', nodeId: 'node-script-review', requestKey: `editorial-preflight-${options.id}` } })
  if (preflight.passed !== true || preflight.repairAttempt?.attempted !== false
    || !same(preflight.shots.map(({ timedActions: _compiled, ...shot }) => shot), shots)) {
    fail(`deterministic current script-review rejected the editorial plan: ${safe(preflight.issues ?? preflight.code ?? 'unknown')}`)
  }
  const simulation = structuredClone(refreshed)
  simulation[3] = { ...simulation[3], status: 'success', output: preflight,
    inputContext: prepared.inputContext, context: { ...prepared.inputContext, script_review: preflight } }
  const loopContext = prepareWorkflowRunContext(simulation, 4).inputContext
  if (!same(loopContext.script_review.shots, preflight.shots)
    || simulation[4].node.loop.sourcePath !== 'script_review.shots') {
    fail('future loop is not bound to the newly reviewed shots')
  }
  const recipe = { version: 'story-editorial-fork-v2', sourceId: source.id, forkId: options.id,
    sourceResultMd5: source.result_md5, sourceRuntimeInputsMd5: source.runtime_inputs_md5,
    workflowNodesMd5: workflowRow.nodes_md5, workflowEdgesMd5: workflowRow.edges_md5,
    workflowSchemaVersion: workflowRow.schema_version, executableSchemaVersion: workflow.schemaVersion,
    routedReviewBranchCount: count,
    planFileSha256: sha(planBytes), editedShotsSha256: hash(shots), originalModelShotsSha256: hash(originalShots),
    originalWriterOutputSha256: hash(runs[2].output), originalReviewOutputSha256: hash(runs[3].output),
    activeReviewedShotsSha256: hash(activeReviewedShots), sourceCompletedRunCount: firstImageComplete ? 6 : 4,
    supersededPaidImageCount: supersededPaidImages.length, supersededPaidImages,
    preservedPrefixSha256: hash(runs.slice(0, 3)), originalDraftSourceSha256: hash(originalDraftSource),
    activeEditorialSourceSha256: hash(editorialSource), changes, changesFromActive,
    helperSha256: sha(await readFile(fileURLToPath(import.meta.url))) }
  const planSha256 = hash(recipe)
  const provenance = { ...recipe, planSha256, method: 'explicit-preproduction-editorial-fork',
    sourceParentExecutionId: original.parentExecutionId ?? null, originalDraftSource,
    originalModelOutputPreserved: true, originalSuccessfulReviewPreservedInSource: true,
    originalSourceBindingReplacedExplicitly: true, modelCallsOnPreparation: 0,
    humanAccepted: false, nativeReviewPending: true }
  const state = { ...structuredClone(original), id: options.id, parentExecutionId: source.id,
    requestScopeId: original.requestScopeId ?? source.id, generationScopeId: options.id,
    historical: false, mode: 'step', nodeRuns: refreshed, context: runs[2].context,
    selectedNodeId: 'node-script-review', storyEditorialFork: provenance,
    logs: [
      `从 ${source.id} 创建明确的分镜编辑子记录；仅保留原模型成功节点 0–2，来源记录中的旧审核与已付费首帧由哈希留证，编辑稿将重新质检。`,
      '本记录尚未执行编辑稿质检、首帧、视频生成或成片验收。'] }
  const encoded = encodeExecutionState(state)
  if (!same(decodeExecutionState(JSON.parse(JSON.stringify(encoded))), state)) fail('fork serialization changed')
  return { state, encoded, proof: { ...recipe, planSha256, recipe,
    firstPendingIndex: 3, actualReviewStatus: 'idle', sourceRunCount: runs.length,
    originalModelOutputPreserved: true, originalReviewUnchangedInSource: true,
    supersededPaidImageCount: supersededPaidImages.length, paidImagePreservedInSourceOnly: true,
    activeBindingMethod: 'explicit-editorialScript-with-matching-storyScriptSource',
    oldLoopItemsCleared: true, contextVerifiedAfterRefresh: true, builtinPreflightPassed: true,
    preflightIsNotPersistedNodeSuccess: true, loopPreviewUsesEditedReview: true,
    currentSchema6ExecutionPlanVerified: true,
    humanAccepted: false, providerCalls: 0 } }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-editorial-script.mjs --source record-SOURCE --id record-FORK --shots SHOTS.json --out DRY_RUN_RECEIPT.json [--apply --expect REVIEWED_DRY_RUN_RECEIPT.json]\nDefault dry-run; --apply inserts one new idle-review child after exact source/workflow/edit/helper CAS checks. Never modifies source/workflow or calls a provider.')
    return
  }
  const out = path.resolve(options.out)
  if (out.startsWith(path.join(ROOT, 'public/generated') + path.sep)) fail('receipt must be outside generated media')
  try { await stat(out); fail('receipt already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const planBytes = await readFile(options.shots, 'utf8')
  const expected = options.expect ? JSON.parse(await readFile(options.expect, 'utf8')) : undefined
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  let committed = false
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const lock = options.apply ? ' FOR SHARE' : ''
    const source = (await db.query(`SELECT *,md5(result::text) AS result_md5,
      md5(runtime_inputs::text) AS runtime_inputs_md5 FROM execution_records WHERE id=$1${lock}`,
    [options.source])).rows[0]
    const workflow = (await db.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'${lock}`)).rows[0]
    if (!source || !workflow || (await db.query('SELECT 1 FROM execution_records WHERE id=$1', [options.id])).rowCount) {
      fail('source/workflow missing or destination already exists')
    }
    const prepared = await prepareEditorialFork(source, workflow, planBytes, options)
    if (expected && (expected.applied !== false || expected.transactionCommitted !== true
      || expected.planSha256 !== prepared.proof.planSha256 || hash(expected.recipe) !== expected.planSha256)) {
      fail('source/workflow/edited script/helper changed since reviewed dry run')
    }
    if (options.apply) {
      await db.query(`INSERT INTO execution_records
        (id,workflow_id,workflow_name,mode,title,runtime_inputs,result,succeeded_count,failed_count,total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,3,0,$7)`,
      [options.id, source.workflow_id, source.workflow_name,
        `猫狗舍友分镜编辑 · ${source.id}`, JSON.stringify(source.runtime_inputs), JSON.stringify(prepared.encoded),
        prepared.state.nodeRuns.length])
      const inserted = (await db.query('SELECT result FROM execution_records WHERE id=$1', [options.id])).rows[0]
      if (!inserted || !same(decodeExecutionState(inserted.result), prepared.state)) fail('inserted fork differs from reviewed state')
    }
    const sourceAfter = (await db.query(`SELECT md5(result::text) AS result_md5,
      md5(runtime_inputs::text) AS runtime_inputs_md5 FROM execution_records WHERE id=$1`, [source.id])).rows[0]
    const workflowAfter = (await db.query(`SELECT md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id='wf-story'`)).rows[0]
    if (sha(await readFile(options.shots)) !== prepared.proof.planFileSha256
      || sha(await readFile(fileURLToPath(import.meta.url))) !== prepared.proof.helperSha256
      || sourceAfter?.result_md5 !== source.result_md5
      || sourceAfter?.runtime_inputs_md5 !== source.runtime_inputs_md5
      || workflowAfter?.nodes_md5 !== workflow.nodes_md5
      || workflowAfter?.edges_md5 !== workflow.edges_md5) fail('source/workflow/plan/helper changed during preparation')
    const proof = { ...prepared.proof, applied: options.apply, createdAt: new Date().toISOString() }
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, JSON.stringify({ ...proof, transactionCommitted: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await db.query('COMMIT')
    committed = true
    await writeFile(out, JSON.stringify({ ...proof, transactionCommitted: true }, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ receipt: out, applied: options.apply, forkId: options.id,
      sourceId: source.id, firstPendingIndex: 3, planSha256: proof.planSha256,
      changedFields: proof.changes.map(change => `${change.shotIndex}.${change.field}`), providerCalls: 0 }))
  } catch (error) {
    if (!committed) await db.query('ROLLBACK')
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(safe(error?.message ?? error)); process.exitCode = 1 })
}
