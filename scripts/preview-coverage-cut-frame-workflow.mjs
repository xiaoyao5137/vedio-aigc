#!/usr/bin/env node
// Read-only DB topology and preserved 610 execution rehearsal. No provider call.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import pg from 'pg'
import ts from 'typescript'
import { executeCodeNode } from '../server/code-node.ts'
import { validateCoverageCutPaidResume } from '../server/coverage-cut-runtime.ts'
import { COVERAGE_CUT_PRECHECK_CODE, COVERAGE_CUT_VIDEO_REFERENCES_CODE,
  upgradeCoverageCutFrameWorkflow } from '../src/coverage-cut-frame-gate.ts'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { insertMissingExecutionNodes } from '../src/execution-topology.ts'
import { executionRouteEdges, orderRouteNodes, branchConfigurationErrors } from '../src/workflow-branch.ts'
import { scopedLoopNodes } from '../src/workflow-core.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { renderWorkflowTemplate, resolveTemplateJsonValue, stringifyTemplateValue } from '../src/workflow-template.ts'

const outputIndex = process.argv.indexOf('--out')
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1]
  : 'logs/dramatic-expression/live-20260928/coverage-cut-frame-gate-preview')
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await client.connect()
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const saved = (await client.query("select id,name,schema_version,nodes,edges from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  assert.ok(saved?.schema_version >= 154, 'Map schema 154 not ready')
  const source = { ...saved, schemaVersion: saved.schema_version }
  const upgraded = upgradeCoverageCutFrameWorkflow(source)
  assert.notEqual(upgraded, source, 'Coverage graph was not applied in memory')
  assert.equal(upgradeCoverageCutFrameWorkflow(upgraded), upgraded, 'Migration not idempotent')
  assert.equal(upgraded.schemaVersion, Math.max(156, saved.schema_version + 1))
  const expectedIds = ['sanguo-coverage-precheck', 'sanguo-coverage-source-archive', 'sanguo-coverage-first-frame',
    'sanguo-coverage-evidence-plan', 'sanguo-coverage-evidence', 'sanguo-coverage-review',
    'sanguo-coverage-approval', 'sanguo-video-reference-router', 'sanguo-video']
  const ordered = orderRouteNodes(upgraded)
  assert.equal(ordered.hasCycle, false)
  assert.deepEqual(branchConfigurationErrors(upgraded), [])
  const graph = { ...upgraded, edges: executionRouteEdges(upgraded) }
  assert.equal(graph.edges.some(edge => edge.from === 'sanguo-first-frame-branch' && edge.to === 'sanguo-video'), false,
    'The old direct paid-video edge must be removed')
  assert.equal(graph.edges.some(edge => edge.from === 'sanguo-video-reference-router' && edge.to === 'sanguo-video'), true)
  const loopNodes = scopedLoopNodes(graph, 'sanguo-scene-loop', ordered.ordered)
  const loopOrder = loopNodes.map(node => node.id)
  for (let index = 1; index < expectedIds.length; index++) {
    assert.ok(loopOrder.indexOf(expectedIds[index - 1]) < loopOrder.indexOf(expectedIds[index]),
      `Coverage gate is not before ${expectedIds[index]}`)
  }
  const branch = upgraded.nodes.find(node => node.id === 'sanguo-first-frame-branch')
  const image = upgraded.nodes.find(node => node.id === 'sanguo-coverage-first-frame')
  const video = upgraded.nodes.find(node => node.id === 'sanguo-video')
  const appSource = await readFile(path.resolve('src/App.tsx'), 'utf8')
  const resolverStart = appSource.indexOf('function resolvePath(')
  const resolverEnd = appSource.indexOf('function uploadedImageOutput(', resolverStart)
  assert.ok(resolverStart > 0 && resolverEnd > resolverStart)
  const resolverJs = ts.transpileModule(appSource.slice(resolverStart, resolverEnd),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const nodeParamValues = vm.runInNewContext(`${resolverJs}\nnodeParamValues`,
    { stringifyTemplateValue, renderWorkflowTemplate, resolveTemplateJsonValue })
  assert.equal(image?.kind, 'image')
  assert.equal(image?.modelId, 'kling-image-3')
  assert.equal(image?.params?.find(item => item.englishName === 'referenceImage')?.value, '${coverage_sources.previousTail.url}')
  assert.equal(image?.params?.find(item => item.englishName === 'imageEdit')?.value, 'true')
  assert.equal(video?.params?.find(item => item.englishName === 'referenceImage')?.value, '${first_frame.url}')
  assert.equal(video?.params?.find(item => item.englishName === 'coverageCutFrameGate')?.value, '${coverage_frame_gate}')
  const model = (await client.query('select id,provider,capability,settings from model_configs where id=$1', [image.modelId])).rows[0]
  assert.equal(model?.provider, 'Kling'); assert.equal(model?.capability, 'image')
  assert.match(String(model.settings?.model), /^kling-v3/)
  const record = (await client.query('select id,result,md5(result::text) as source_md5 from execution_records where id=$1',
    ['record-610-scene4-voice-repair-20260928-v1'])).rows[0]
  assert.equal(record?.source_md5, 'df7ddd75cf661ae5ee5d60656854989c')
  const state = decodeExecutionState(record.result)
  const branchIndex = state.nodeRuns.findIndex(item => item.node.id === branch.id && item.loopIndex === 2)
  assert.ok(branchIndex >= 0)
  const context = prepareWorkflowRunContext(state.nodeRuns, branchIndex).inputContext
  const oldShot = context.shot_script
  const candidateShot = { ...oldShot, firstFrameMode: 'reference',
    continuity: { ...oldShot.continuity, mode: 'coverage_cut', bridgeType: 'cut' } }
  // The old input snapshot includes choices for episode 518; production 610
  // selection filtering gives this branch the empty 610-specific selection.
  const input = { ...context.input, characterAssetSelections: {} }
  const branchOutput = await executeCodeNode({ code: branch.code,
    context: { ...context, input, shot_script: candidateShot } })
  assert.equal(branchOutput.shouldGenerateCoverageFrame, true)
  assert.equal(branchOutput.shouldReusePreviousTail, false)
  const precheck = await executeCodeNode({ code: COVERAGE_CUT_PRECHECK_CODE, params: {
    previousLastFrame: context.loop.previous.last_frame,
    previousVideoShot: context.loop.previous.video_shot,
    referenceBindings: branchOutput.referenceRequest.referenceBindings,
    referenceImages: branchOutput.referenceRequest.referenceImages,
  } })
  assert.equal(precheck.previousTail.source, 'extracted-from-video')
  assert.equal(precheck.previousTail.url, context.loop.previous.video_shot.lastFrameUrl)
  assert.equal(precheck.referenceBindings.length, 2)
  const legacyRoutes = []
  for (const loopIndex of [0, 1, 2]) {
    const legacyIndex = state.nodeRuns.findIndex(item => item.node.id === branch.id && item.loopIndex === loopIndex)
    assert.ok(legacyIndex >= 0)
    const prior = prepareWorkflowRunContext(state.nodeRuns, legacyIndex).inputContext
    const legacy = await executeCodeNode({ code: branch.code,
      context: { ...prior, input: { ...prior.input, characterAssetSelections: {} } } })
    assert.equal(legacy.shouldGenerateCoverageFrame, false, `Old loop ${loopIndex} unexpectedly buys a coverage image`)
    const routed = await executeCodeNode({ code: COVERAGE_CUT_VIDEO_REFERENCES_CODE,
      params: { branch: legacy, sources: undefined } })
    assert.deepEqual(routed.referenceImages, legacy.referenceRequest.referenceImages)
    assert.deepEqual(routed.referenceBindings, legacy.referenceRequest.referenceBindings)
    assert.equal(routed.referenceMode, legacy.referenceRequest.referenceMode)
    const actualResolved = nodeParamValues(video, { ...prior, first_frame_branch: legacy,
      coverage_video_references: routed })
    assert.equal(actualResolved.coverageCutFrameGate, undefined)
    assert.equal(actualResolved.coveragePreviousTail, undefined)
    assert.equal(JSON.stringify(actualResolved.coverageShot), JSON.stringify(prior.shot_script))
    assert.equal(JSON.stringify(actualResolved.referenceImages), JSON.stringify(routed.referenceImages))
    assert.equal(JSON.stringify(actualResolved.referenceBindings), JSON.stringify(routed.referenceBindings))
    legacyRoutes.push({ loopIndex, continuityMode: prior.shot_script.continuity?.mode,
      visualTreatment: prior.shot_script.visualTreatment,
      shouldGenerateCoverageFrame: legacy.shouldGenerateCoverageFrame,
      shouldReusePreviousTail: legacy.shouldReusePreviousTail, referenceCount: routed.referenceImages.length,
      absentCoverageGateAndTailResolveToUndefined: true, coverageShotResolvesToCurrentShot: true })
  }
  const preserved = insertMissingExecutionNodes(upgraded, state.nodeRuns)
  for (const original of state.nodeRuns.filter(item => item.status === 'success' && ['image', 'video', 'audio'].includes(item.node.kind))) {
    const after = preserved.find(item => item.id === original.id)
    assert.equal(after?.status, 'success', `Paid run ${original.id} would be invalidated`)
    assert.equal(after.output, original.output, `Paid output ${original.id} would be overwritten`)
  }
  const paidPrefixPreserved = preserved === state.nodeRuns
  const retakeRequest = JSON.parse(await readFile('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-candidate-20260928-v1/request-private.json', 'utf8'))
  const retakeLedger = (await client.query(`select task_id,workflow_id,node_id,model_id,provider,capability,status,request_data
    from model_execution_records where task_id=$1 order by created_at desc limit 1`, ['933484061220827179'])).rows[0]
  const retakeModel = (await client.query('select id,provider,capability,settings from model_configs where id=$1',
    [retakeRequest.modelId])).rows[0]
  assert.ok(retakeLedger && retakeModel)
  validateCoverageCutPaidResume(retakeLedger, { model: retakeModel, prompt: retakeRequest.prompt,
    params: { ...retakeRequest.params, resumeTaskId: retakeLedger.task_id },
    executionContext: { workflowId: 'wf-sanguo-history-drama', nodeId: 'sanguo-video',
      requestKey: retakeRequest.requestKey } })
  const report = { format: 'coverage-cut-frame-workflow-readonly-preview-v1', at: new Date().toISOString(),
    savedSchema: saved.schema_version, projectedSchema: upgraded.schemaVersion, savedGraphSha256: sha([saved.nodes, saved.edges]),
    savedExecutionMd5: record.source_md5, inMemoryNodeCount: upgraded.nodes.length,
    addedIds: expectedIds.slice(0, -1), loopOrder: expectedIds.map(id => ({ id, index: loopOrder.indexOf(id) })),
    branchFlagFromActual610: branchOutput.shouldGenerateCoverageFrame, actualPreviousTail: precheck.previousTail,
    legacyRoutes,
    videoInboundEdges: upgraded.edges.filter(edge => edge.to === 'sanguo-video').map(edge => edge.from),
    referenceBindings: precheck.referenceBindings.map(item => ({ characterName: item.characterName, assetId: item.assetId,
      source: item.url.startsWith('/generated/') ? 'local' : 'remote-needs-archive' })),
    imageModel: { id: model.id, provider: model.provider, capability: model.capability, model: model.settings.model },
    paidProviderRunsPreserved: true, oldRunObjectReused: paidPrefixPreserved,
    realPaidTaskResumeLedgerBound: true,
    noCycle: true, branchErrors: [], databaseWrites: 0, mediaRequests: 0,
    runtimeIntegrated: false, deploymentBoundary: 'API routes, image persistence, paid video gate and CAS saved-workflow migration not installed' }
  await client.query('ROLLBACK')
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'preview.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) { await client.query('ROLLBACK'); throw error }
finally { await client.end() }
