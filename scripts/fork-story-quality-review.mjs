#!/usr/bin/env node
// Preserve a paid story clip while putting its next decision into the visible
// quality-review topology. A dry run is read-only; --apply inserts a NEW record.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { upgradeStoryQualityWorkflow } from '../src/story-quality-workflow.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const SOURCE_ID = 'record-story-shot1-visual-v1'
const GENERATED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const fail = message => { throw Error(`STORY_QUALITY_FORK_INVALID: ${message}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function parseArguments(args) {
  const options = { apply: false, id: `record-story-quality-${randomUUID().slice(0, 8)}` }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (args[i] === '--help') { options.help = true; continue }
    const key = { '--id': 'id', '--expected-source-md5': 'sourceMd5', '--expected-workflow-md5': 'workflowMd5' }[args[i]]
    if (!key || options[`seen_${key}`] || !args[i + 1] || args[i + 1].startsWith('--')) fail(`unknown or incomplete argument ${args[i]}`)
    options[key] = args[++i]
    options[`seen_${key}`] = true
  }
  if (options.help) return options
  if (!/^record-[\w-]+$/.test(options.id) || options.id === SOURCE_ID) fail('fork requires a new record ID')
  for (const name of ['sourceMd5', 'workflowMd5']) if (options[name] && !/^[a-f\d]{32}$/i.test(options[name])) fail(`${name} must be MD5`)
  if (options.apply && (!options.seen_id || !options.sourceMd5 || !options.workflowMd5)) {
    fail('--apply requires reviewed --id and source/workflow MD5 locks')
  }
  return options
}

export function targetStoryQualityWorkflow(row, { allowProjection = false } = {}) {
  if (!row || row.id !== 'wf-story' || !Array.isArray(row.nodes) || !Array.isArray(row.edges)) fail('wf-story configuration missing')
  const stored = { id: row.id, schemaVersion: row.schema_version, nodes: row.nodes, edges: row.edges }
  const workflow = row.schema_version === 4 && allowProjection ? upgradeStoryQualityWorkflow(stored) : stored
  if (workflow.schemaVersion !== 5) fail('schema 5 must be saved before applying the fork')
  const byId = new Map(workflow.nodes.map(node => [node.id, node]))
  const scriptReview = byId.get('node-script-review'), mediaReview = byId.get('node-video-review')
  const loop = byId.get('node-loop'), image = byId.get('node-image'), video = byId.get('node-video'), concat = byId.get('node-video-concat')
  if (byId.size !== workflow.nodes.length || !scriptReview || !mediaReview || !loop || !image || !video || !concat
    || scriptReview.kind !== 'validation' || scriptReview.operation !== 'story.script-review'
    || mediaReview.kind !== 'validation' || mediaReview.operation !== 'story.media-review'
    || loop.kind !== 'loop' || loop.loop?.sourcePath !== 'script_review.shots'
    || JSON.stringify(loop.childIds) !== JSON.stringify(['node-image', 'node-video', 'node-video-review', 'node-video-concat'])
    || !video.prompt.includes('${shot.timedActions}')
    || !video.params.some(p => p.englishName === 'promptOverflowPolicy' && p.value === 'reject')
    || !concat.params.some(p => p.englishName === 'currentVideo' && p.value === '${video_review}')) {
    fail('workflow does not contain the reviewed explicit quality chain')
  }
  const edge = (from, to) => workflow.edges.some(item => item.from === from && item.to === to && !item.branch)
  if (!edge('node-script', scriptReview.id) || !edge(scriptReview.id, loop.id)
    || !edge(video.id, mediaReview.id) || !edge(mediaReview.id, concat.id)
    || edge('node-script', loop.id) || edge(video.id, concat.id)) fail('quality review can be bypassed')
  return { workflow, byId }
}

async function verifiedLocalVideo(url, claimedSha256) {
  const name = /^\/generated\/([\w.-]+\.mp4)$/.exec(url)?.[1]
  if (!name || !/^[a-f\d]{64}$/.test(claimedSha256 || '')) fail('source video URL/hash invalid')
  const base = await realpath(GENERATED)
  const file = await realpath(path.join(base, name))
  if (!file.startsWith(base + path.sep) || !(await stat(file)).isFile()) fail('source video file unavailable')
  const sha256 = digest(await readFile(file))
  if (sha256 !== claimedSha256) fail('source video bytes changed')
  return { url, sha256 }
}

function idleReviewRun(node, loopNode, sourceRun, loopItem, childIndex, routeInputContext) {
  return {
    id: `${node.id}-${sourceRun.loopGroupId}-${sourceRun.loopIndex}-${childIndex}`,
    node, output: undefined, context: {}, inputs: {}, inputContext: {},
    ...(routeInputContext ? { routeInputContext } : {}),
    label: `第 ${sourceRun.loopIndex + 1} 轮 / ${node.title} -> ${node.resultVar}`,
    status: 'idle', durationMs: 0, loopNode, loopGroupId: sourceRun.loopGroupId,
    loopIndex: sourceRun.loopIndex, loopItem, loopPrevious: sourceRun.loopPrevious,
    loopIsLast: node.id === 'node-video-concat' && sourceRun.loopIndex === 1,
  }
}

/** Pure aside from a deterministic, model-free call to the same built-in
 * script reviewer used by the visible node. Existing paid outputs are exact. */
export async function prepareStoryQualityReviewFork(source, target, media, id, createdAt = new Date().toISOString()) {
  if (!source || source.id !== SOURCE_ID || source.workflow_id !== 'wf-story' || !object(source.result)) fail('unexpected source record')
  const { workflow, byId } = targetStoryQualityWorkflow(target, { allowProjection: true })
  const old = decodeExecutionState(source.result)
  const originalRuns = old.nodeRuns
  const ids = ['node-input', 'node-model-images', 'node-script', 'node-loop', 'node-image', 'node-video', 'node-image', 'node-video']
  if (old.id !== source.id || old.workflowId !== source.workflow_id || !Array.isArray(originalRuns)
    || originalRuns.length !== ids.length || originalRuns.some((run, i) => run.node?.id !== ids[i]
      || run.status !== (i < 6 ? 'success' : 'idle')) || originalRuns[4].loopIndex !== 0
    || originalRuns[5].loopIndex !== 0 || originalRuns[6].loopIndex !== 1 || originalRuns[7].loopIndex !== 1
    || !originalRuns[5].loopGroupId || originalRuns.slice(4).some(run => run.loopGroupId !== originalRuns[5].loopGroupId)) {
    fail('source run topology/status changed')
  }
  const [input, modelImages, script, oldLoop, image1, video1, image2, video2] = originalRuns
  if (old.runtimeInputs?.input?.vedio_count !== 2 || source.runtime_inputs?.input?.vedio_count !== 2
    || video1.output?.url !== media.url || video1.output?.videoEvidence?.sha256 !== media.sha256
    || video1.output?.storyMediaReview?.reviewStatus !== 'uncertain'
    || video1.output.storyMediaReview.passed !== false
    || old.humanStoryReview?.verdict !== 'pass' || old.humanStoryReview?.video?.sha256 !== media.sha256
    || old.humanStoryReview?.video?.url !== media.url) fail('source clip or existing review evidence differs')
  const scriptReview = await executeBuiltinNode(null, {
    operation: 'story.script-review', params: { script: script.output, expectedCount: 2 },
  })
  if (!object(scriptReview) || scriptReview.passed !== true || !Array.isArray(scriptReview.shots)
    || scriptReview.shots.length !== 2 || scriptReview.shots.some(shot => typeof shot.timedActions !== 'string')) {
    fail(`saved script cannot pass deterministic review: ${JSON.stringify(scriptReview?.issues ?? [])}`)
  }
  const hash = createJsonHasher()
  const sourceVideoOutputHash = hash(video1.output)
  const scriptReviewNode = byId.get('node-script-review'), mediaReviewNode = byId.get('node-video-review')
  const loopNode = byId.get('node-loop'), concatNode = byId.get('node-video-concat')
  const reviewContext = { ...script.context, script_review: scriptReview }
  const reviewedScriptRun = {
    id: 'node-script-review-restored-3', node: scriptReviewNode, status: 'success', durationMs: 0,
    inputs: { script: script.output, expectedCount: 2 }, inputContext: script.context,
    output: scriptReview, context: reviewContext,
    label: `${scriptReviewNode.title} -> ${scriptReviewNode.resultVar}`,
    reviewMigration: { mode: 'retroactive-deterministic-check', sourceExecutionId: source.id,
      sourceRunId: script.id, sourceScriptOutputSha256: hash(script.output) },
  }
  const loopRun = { ...oldLoop, node: loopNode, inputContext: reviewContext,
    context: { ...oldLoop.context, script_review: scriptReview },
    migrationNote: '原循环已在旧拓扑执行；新质检为追溯校验，不声明原视频调用前曾运行。' }
  // The saved run output is authoritative. Prior forks may have cloned the
  // context value separately even when its visible URL is the same.
  const firstReviewContext = { ...video1.context, video_shot: video1.output, script_review: scriptReview }
  const firstMediaReview = idleReviewRun(mediaReviewNode, loopNode, video1, scriptReview.shots[0], 2, firstReviewContext)
  const firstConcat = idleReviewRun(concatNode, loopNode, video1, scriptReview.shots[0], 3)
  const secondImage = { ...image2, node: byId.get('node-image'), loopNode,
    loopItem: scriptReview.shots[1], loopIsLast: false }
  const secondVideo = { ...video2, node: byId.get('node-video'), loopNode,
    loopItem: scriptReview.shots[1], loopIsLast: false }
  const secondMediaReview = idleReviewRun(mediaReviewNode, loopNode, video2, scriptReview.shots[1], 2)
  const secondConcat = idleReviewRun(concatNode, loopNode, video2, scriptReview.shots[1], 3)
  const runs = [input, modelImages, script, reviewedScriptRun, loopRun, image1, video1,
    firstMediaReview, firstConcat, secondImage, secondVideo, secondMediaReview, secondConcat]
  const firstPending = runs.findIndex(run => run.status === 'idle')
  if (firstPending !== 7 || hash(runs[5].output) !== hash(image1.output) || hash(runs[6].output) !== sourceVideoOutputHash
    || runs.slice(7).some(run => run.node.kind === 'video' && run.status !== 'idle')) fail('paid-prefix protection failed')
  const recovery = {
    version: 'story-quality-visible-fork-v1', createdAt, sourceExecutionId: source.id,
    sourceResultMd5: source.result_md5, workflowNodesMd5: target.nodes_md5,
    sourceScriptOutputSha256: hash(script.output), sourceVideoOutputSha256: sourceVideoOutputHash,
    sourceVideo: media, sourceAutomaticReviewStatus: 'uncertain', sourceHumanReviewVerdict: 'pass',
    scriptReviewMode: 'retroactive-deterministic-check', firstPendingNodeId: mediaReviewNode.id,
    note: '原视频发生在质检节点加入之前；本分支不声明它通过事前拦截，也不重新生成。',
  }
  const state = { ...old, id, parentExecutionId: source.id, generationScopeId: id,
    requestScopeId: old.requestScopeId ?? old.id, historical: false, mode: 'step',
    nodeRuns: runs, context: firstReviewContext, selectedNodeId: mediaReviewNode.id,
    logs: [...(old.logs ?? []), `${scriptReviewNode.title} -> 追溯确定性校验通过`,
      `从 ${source.id} 创建显式质检恢复记录；首镜视频字节保持，等待成片质检。`],
    storyQualityVisibleFork: recovery }
  const encoded = encodeExecutionState(state)
  if (hash(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hash(state)) fail('storage round trip changed fork')
  return { state, encoded, proof: { ...recovery, targetSchemaVersion: workflow.schemaVersion,
    newRecordId: id, totalRuns: runs.length, completedRuns: runs.filter(run => run.status === 'success').length,
    firstPendingIndex: firstPending, paidVideoRunId: video1.id, paidVideoOutputPreserved: true,
    secondVideoStillIdle: runs[10].status === 'idle', modelCalls: 0, sourceUnchanged: true } }
}

export async function forkStoryQualityReview(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [SOURCE_ID])).rows[0]
    if (!source) fail('source record missing')
    if (options.sourceMd5 && options.sourceMd5.toLowerCase() !== source.result_md5) fail('source MD5 changed')
    const target = (await client.query(`SELECT *, md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${options.apply ? ' FOR SHARE' : ''}`)).rows[0]
    if (!target) fail('workflow missing')
    if (options.workflowMd5 && options.workflowMd5.toLowerCase() !== target.nodes_md5) fail('workflow MD5 changed')
    if (options.apply && target.schema_version !== 5) fail('schema 5 must be saved before apply')
    const old = decodeExecutionState(source.result)
    const url = old.nodeRuns?.[5]?.output?.url
    const sha = old.nodeRuns?.[5]?.output?.videoEvidence?.sha256
    const media = await verifiedLocalVideo(url, sha)
    const prepared = await prepareStoryQualityReviewFork(source, target, media, options.id)
    if (options.apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `打工猫显式质检恢复 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
        prepared.proof.completedRuns, prepared.proof.totalRuns,
      ])
      const saved = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!saved || createJsonHasher()(decodeExecutionState(saved.result)) !== createJsonHasher()(state)) fail('inserted fork changed')
    }
    const after = (await client.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [SOURCE_ID])).rows[0]?.md5
    if (after !== source.result_md5) fail('source record changed during fork')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: options.apply, sourceResultMd5After: after,
      projectedWorkflow: target.schema_version !== 5 }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-story-quality-review.mjs [--id NEW_ID] [--expected-source-md5 MD5 --expected-workflow-md5 MD5 --apply]')
    return
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    const client = await pool.connect()
    try { console.log(JSON.stringify(await forkStoryQualityReview(client, options), null, 2)) }
    finally { client.release() }
  } finally { await pool.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
