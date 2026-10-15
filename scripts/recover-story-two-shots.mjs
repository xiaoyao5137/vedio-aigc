#!/usr/bin/env node
// Create an auditable, unpaid timing-replan fork of record-a7c0ix.
// The default mode is a read-only preview. --apply only inserts a NEW
// execution record; it never invokes a model or changes the source record.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue } from '../src/workflow-template.ts'
import { createStoryScriptSource, renderStoryShotTimedActions, validateStoryShotTimingOutput } from '../src/story-shot-timing.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const sourceId = 'record-a7c0ix'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const image1Suffix = 'image-f9d550085f556e1e9b8e894f6e052fbc.png'
const image2Placement = ' 柴犬位于蓝猫身体后侧，犬口鼻正对猫背部中段，猫背中段完整无遮挡；犬下巴与猫背留有几厘米可见空隙。'
const completion = [
  ['硬币停在柴犬前爪可触及处', '纸袋停在蓝猫前爪可触及处，包子可见'],
  ['柴犬下巴明确搭在蓝猫背部中段，保持接触', '蓝猫睁眼侧瞥柴犬，身体继续趴卧'],
]
const sha256 = value => createHash('sha256').update(value).digest('hex')
const fail = message => { throw Error(`STORY_TWO_SHOT_RECOVERY_INVALID: ${message}`) }
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function optionsFromArgs(args) {
  const options = { apply: false, id: `record-story-duration-${randomUUID().slice(0, 8)}` }
  for (let at = 0; at < args.length; at++) {
    const flag = args[at]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--id': 'id', '--expected-source-md5': 'expectedMd5', '--expected-workflow-md5': 'expectedWorkflowMd5' }[flag]
    if (!key || !args[at + 1] || args[at + 1].startsWith('--') || options[`seen_${key}`]) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++at]
    options[`seen_${key}`] = true
  }
  if (options.help) return options
  if (!/^record-[a-zA-Z0-9_-]+$/.test(options.id) || options.id === sourceId) fail('new --id must be a distinct record ID')
  if (options.expectedMd5 && !/^[a-f\d]{32}$/i.test(options.expectedMd5)) fail('--expected-source-md5 must be a 32-digit MD5')
  if (options.expectedWorkflowMd5 && !/^[a-f\d]{32}$/i.test(options.expectedWorkflowMd5)) fail('--expected-workflow-md5 must be a 32-digit MD5')
  if (options.apply && (!options.seen_id || !options.expectedMd5 || !options.expectedWorkflowMd5)) fail('--apply requires a reviewed --id and both source/workflow MD5 values')
  return options
}

function resetPendingRun(run, shot, currentNode) {
  if (run.paramOverrides !== undefined && Object.keys(run.paramOverrides).length) fail(`cannot discard ${run.id} parameter overrides`)
  return { ...invalidateRunExecution(run), node: currentNode, loopItem: shot, loopPrevious: undefined,
    attempt: 1, errorAttempt: 1, revision: (run.revision ?? 0) + 1 }
}

function currentMediaNodes(workflow, video1, video2, image2) {
  if (!isObject(workflow) || workflow.id !== 'wf-story' || !Array.isArray(workflow.nodes) || workflow.schema_version < 2) fail('current wf-story configuration is missing or old')
  const image = workflow.nodes.find(node => node.id === 'node-image')
  const video = workflow.nodes.find(node => node.id === 'node-video')
  if (!image || image.kind !== 'image' || image.modelId !== image2.node.modelId
    || image.prompt !== image2.node.prompt || !Array.isArray(image.params)) fail('current first-frame config differs from reviewed source')
  const imageParams = Object.fromEntries(image.params.map(param => [param.englishName, param.value]))
  if (imageParams.referenceImages !== '${model_images.items}' || imageParams.size !== '576x1024' || imageParams.singleFrame !== 'true') fail('current first-frame refs/size differ from reviewed source')
  if (!video || video.kind !== 'video' || video.modelId !== video1.node.modelId || video.modelId !== video2.node.modelId
    || !video.prompt.includes('${shotTimedActions}') || video.prompt.includes('${shot.content}')
    || !video.prompt.includes('至少 1 秒') || !Array.isArray(video.params)) fail('current video config lacks the reviewed timing contract')
  const videoParams = Object.fromEntries(video.params.map(param => [param.englishName, param.value]))
  if (videoParams.duration !== '${shot.duration}' || videoParams.referenceImage !== '${first_frame}'
    || videoParams.camera !== '${shot.camera}' || videoParams.mood !== '${shot.mood}' || videoParams.sound !== 'on') fail('current video params differ from the reviewed timing/first-frame contract')
  return { image, video }
}

function verifyPendingMediaContracts(runs, shots) {
  return [0, 1].map(index => {
    const runIndex = index === 0 ? 5 : 7
    const run = runs[runIndex]
    const prepared = prepareWorkflowRunContext(runs, runIndex)
    const durationParam = run.node.params.find(param => param.englishName === 'duration')
    if (!prepared || !durationParam) fail(`shot ${index + 1} video context or duration param is missing`)
    const duration = resolveTemplateJsonValue(durationParam.value, prepared.inputContext)
    const timedActions = renderStoryShotTimedActions(shots[index])
    const renderedPrompt = renderWorkflowTemplate(run.node.prompt, { ...prepared.inputContext, shotTimedActions: timedActions })
    if (duration !== 8 || prepared.inputContext.shot?.duration !== 8
      || !renderedPrompt.includes(timedActions) || renderedPrompt.includes('${') || !renderedPrompt.includes('8 秒内')) {
      fail(`shot ${index + 1} video does not resolve to an 8-second timed-action request`)
    }
    return { index, resolvedDuration: duration, usesTimedActions: true, terminalHold: '7–8 秒' }
  })
}

/** Pure transformation: no model calls, DB writes or file changes. */
export function prepareStoryTwoShotRecovery(source, workflow, id, createdAt = new Date().toISOString()) {
  if (!isObject(source) || source.id !== sourceId || source.workflow_id !== 'wf-story' || !isObject(source.result)) fail('unexpected source record')
  if (!/^record-[a-zA-Z0-9_-]+$/.test(id) || id === sourceId) fail('invalid new record ID')
  const hasher = createJsonHasher()
  const decoded = decodeExecutionState(source.result)
  if (decoded.id !== sourceId || decoded.workflowId !== 'wf-story' || !Array.isArray(decoded.nodeRuns)) fail('source execution identity is inconsistent')
  const original = structuredClone(decoded)
  const expectedNodes = ['node-input', 'node-model-images', 'node-script', 'node-loop', 'node-image', 'node-video', 'node-image', 'node-video']
  if (original.nodeRuns.length !== expectedNodes.length || original.nodeRuns.some((run, index) =>
    run.node?.id !== expectedNodes[index] || run.status !== 'success')) fail('source is not the completed, exact two-shot topology')
  const [input, modelImages, script, loop, image1, video1, image2, video2] = original.nodeRuns
  if (image1.loopIndex !== 0 || video1.loopIndex !== 0 || image2.loopIndex !== 1 || video2.loopIndex !== 1
    || !image1.loopGroupId || [video1, image2, video2].some(run => run.loopGroupId !== image1.loopGroupId)) fail('loop order/group is inconsistent')
  if (script.node.modelId !== 'codex-local-vision' || image1.node.modelId !== 'codex-gpt-image-2'
    || image2.node.modelId !== 'codex-gpt-image-2' || video1.node.modelId !== 'keling3' || video2.node.modelId !== 'keling3') fail('model configuration differs from reviewed source')
  const currentNodes = currentMediaNodes(workflow, video1, video2, image2)
  if (image1.output?.url !== `/generated/${image1Suffix}` || image1.output?.model !== 'codex-gpt-image-2'
    || !Array.isArray(image1.inputs?.referenceImages) || image1.inputs.referenceImages.length !== 4
    || image1.inputs.size !== '576x1024') fail('shot 1 first-frame evidence differs from reviewed source')
  if (hasher(image1.inputs.referenceImages) !== hasher(modelImages.output?.items)) fail('shot 1 character references differ from the saved model images')

  const sourceStory = createStoryScriptSource(script.output, { sourceExecutionId: sourceId, sourceRunId: script.id })
  if (sourceStory.shots.length !== 2 || sourceStory.shots.some(shot => shot.requiredActions.length !== 2)) fail('expected two original actions in each of two shots')
  if (sourceStory.shots[0].firstFramePrompt !== image1.loopItem?.firstFramePrompt
    || !image1.output.prompt?.includes(sourceStory.shots[0].firstFramePrompt)) fail('shot 1 image does not bind the original first-frame prompt')
  if (script.output.shots.some((shot, index) => shot.duration !== 3 || shot.title !== sourceStory.shots[index].title)) fail('source no longer matches reviewed three-second shots')
  const shots = script.output.shots.map((shot, index) => {
    const actions = sourceStory.shots[index].requiredActions
    return {
      ...shot,
      duration: 8,
      content: `0—4秒，${actions[0]}；4—7秒，${actions[1]}。`,
      firstFramePrompt: index === 1 ? shot.firstFramePrompt + image2Placement : shot.firstFramePrompt,
      visualBeats: actions.map((action, beatIndex) => ({
        id: `shot-${index + 1}-beat-${beatIndex + 1}`, action, completion: completion[index][beatIndex],
        startSecond: beatIndex === 0 ? 0 : 4, endSecond: beatIndex === 0 ? 4 : 7,
      })),
    }
  })
  validateStoryShotTimingOutput(shots, { expectedCount: 2, source: sourceStory })
  if (shots[0].firstFramePrompt !== sourceStory.shots[0].firstFramePrompt) fail('shot 1 first-frame prompt was changed')

  const sourceScriptOutputHash = hasher(script.output)
  const recovery = {
    version: 'story-two-shot-manual-timing-replan-v1', method: 'agent-authored-timing-replan',
    createdAt, sourceExecutionId: sourceId, sourceRunId: script.id, sourceScriptOutputSha256: sourceScriptOutputHash,
    sourceImage1RunId: image1.id, reusedImage1Url: image1.output.url,
    scope: 'preserve original story actions and shot 1 first frame; regenerate shot 2 first frame and both videos',
  }
  const revisedScriptOutput = {
    raw: { recovery }, text: JSON.stringify(shots, null, 2), items: shots, shots,
    model: 'manual-timing-replan-v1', recovery,
  }
  const nextScript = { ...script, output: revisedScriptOutput, context: { ...script.inputContext, script_generation: revisedScriptOutput },
    startedAt: undefined, durationMs: 0, revision: (script.revision ?? 0) + 1 }
  const nextLoop = { ...loop, inputContext: nextScript.context, context: { ...nextScript.context, shot_loop: loop.output },
    startedAt: undefined, durationMs: 0, revision: (loop.revision ?? 0) + 1 }
  let runs = [input, modelImages, nextScript, nextLoop,
    { ...image1, loopItem: shots[0] }, resetPendingRun(video1, shots[0], currentNodes.video),
    resetPendingRun(image2, shots[1], currentNodes.image), resetPendingRun(video2, shots[1], currentNodes.video)]
  const preparedImage = prepareWorkflowRunContext(runs, 4)
  if (!preparedImage) fail('cannot rebuild shot 1 image context')
  const nextImage1 = { ...runs[4], inputContext: preparedImage.inputContext,
    context: { ...preparedImage.inputContext, first_frame: image1.output } }
  runs = [...runs.slice(0, 4), nextImage1, ...runs.slice(5)]
  if (hasher(image1.output) !== hasher(nextImage1.output) || hasher(image1.inputs) !== hasher(nextImage1.inputs)
    || nextImage1.inputContext.shot?.firstFramePrompt !== shots[0].firstFramePrompt) fail('shot 1 paid image changed during reuse')
  const pendingMediaContracts = verifyPendingMediaContracts(runs, shots)
  const firstPending = runs.findIndex(run => run.status === 'idle')
  if (firstPending !== 5 || runs.slice(5).some(run => run.output !== undefined || Object.keys(run.context).length)) fail('pending media was not fully invalidated')
  const state = {
    ...original, id, parentExecutionId: sourceId, generationScopeId: id,
    requestScopeId: original.requestScopeId ?? sourceId, historical: false, mode: 'step',
    nodeRuns: runs, context: nextImage1.context, selectedNodeId: runs[firstPending].node.id,
    logs: [...runs.slice(0, firstPending).map(run => run.label ?? `${run.node.title} -> ${run.node.resultVar}`),
      `从 ${sourceId} 创建人工时长重排分支；原剧情动作保留、首镜图片复用，后续图片与视频待生成。`],
    storyTwoShotRecovery: recovery,
  }
  const encoded = encodeExecutionState(state)
  if (hasher(decodeExecutionState(JSON.parse(JSON.stringify(encoded)))) !== hasher(state)) fail('storage round trip changed the fork')
  if (hasher(decodeExecutionState(source.result)) !== hasher(decoded)) fail('preparation changed the source state')
  return { state, encoded, proof: {
    version: recovery.version, sourceRecordId: sourceId, sourceResultMd5: source.result_md5,
    sourceResultSha256: hasher(source.result), newRecordId: id, createdAt,
    workflowNodesMd5: workflow.nodes_md5, workflowSchemaVersion: workflow.schema_version,
    sourceScriptOutputSha256: sourceScriptOutputHash, sourceImage1RunId: image1.id,
    reusedImage1Url: image1.output.url, reusedImage1OutputSha256: hasher(image1.output),
    reusedImage1InputsSha256: hasher(image1.inputs), preservedPrefixRunIds: runs.slice(0, 2).map(run => run.id),
    firstPendingIndex: firstPending, firstPendingNodeId: runs[firstPending].node.id,
    pendingNodes: runs.slice(firstPending).map(run => ({ id: run.node.id, loopIndex: run.loopIndex })),
    pendingMediaContracts,
    shots: shots.map((shot, index) => ({ title: shot.title, duration: shot.duration,
      firstFramePromptChanged: shot.firstFramePrompt !== sourceStory.shots[index].firstFramePrompt,
      content: shot.content, timedActions: renderStoryShotTimedActions(shot) })),
    sourceUnchanged: true, modelCalls: 0,
  } }
}

async function verifyImage1(url) {
  if (url !== `/generated/${image1Suffix}`) fail('unexpected image URL')
  const generated = await realpath(path.join(root, 'public/generated'))
  const filename = await realpath(path.join(generated, image1Suffix))
  if (!filename.startsWith(generated + path.sep) || !(await stat(filename)).isFile()) fail('shot 1 first-frame file is missing or unsafe')
  const bytes = await readFile(filename)
  if (bytes.length < 1000) fail('shot 1 first-frame file is too small')
  return { path: filename, bytes: bytes.length, sha256: sha256(bytes) }
}

async function run(client, options) {
  await client.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${options.apply ? ' FOR SHARE' : ''}`, [sourceId])).rows[0]
    if (!source) fail('source execution record does not exist')
    if (options.expectedMd5 && source.result_md5 !== options.expectedMd5.toLowerCase()) fail('source record changed since the reviewed dry run')
    const workflow = (await client.query(`SELECT *, md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'${options.apply ? ' FOR SHARE' : ''}`)).rows[0]
    if (!workflow) fail('wf-story workflow configuration does not exist')
    if (options.expectedWorkflowMd5 && workflow.nodes_md5 !== options.expectedWorkflowMd5.toLowerCase()) fail('workflow config changed since the reviewed dry run')
    const prepared = prepareStoryTwoShotRecovery(source, workflow, options.id)
    const imageEvidence = await verifyImage1(prepared.proof.reusedImage1Url)
    if (options.apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,'step',$4,$5::jsonb,$6::jsonb,$7,0,$8)`, [
        state.id, source.workflow_id, source.workflow_name, `打工猫两镜时长恢复 · ${sourceId}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('inserted fork differs from prepared state')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [sourceId])).rows[0]?.result_md5
    if (sourceAfter !== source.result_md5) fail('source changed during recovery preparation')
    const workflowAfter = (await client.query("SELECT md5(nodes::text) AS nodes_md5 FROM workflow_configs WHERE id='wf-story'")).rows[0]?.nodes_md5
    if (workflowAfter !== workflow.nodes_md5) fail('workflow changed during recovery preparation')
    await client.query('COMMIT')
    return { ...prepared.proof, reusedImage1File: imageEvidence, sourceResultMd5After: sourceAfter,
      workflowNodesMd5After: workflowAfter, applied: options.apply }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/recover-story-two-shots.mjs [--id NEW_RECORD] [--expected-source-md5 MD5] [--expected-workflow-md5 MD5] [--apply]\nDefault is read-only. --apply requires a reviewed ID and both source/workflow MD5 values and only inserts one new execution record.')
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
