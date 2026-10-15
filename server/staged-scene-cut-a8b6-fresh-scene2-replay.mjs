/** Source-bound replay of the original scene-02 script after the *new* 14s
 * first shot has completed. The caller must obtain `prepared` from the real
 * first-shot rows with prepareScene2RegenerationPreflight. This module never
 * calls an image, video, or review provider. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { applyNodeOutputToContext } from '../src/workflow-core.ts'
import { sceneFromStoryboardSegment, storyboardContinuityContext } from '../src/storyboard-runtime.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { assertOriginalSecondShotCreativeLock } from '../scripts/replay-original-second-shot-candidate.mjs'

const ORIGINAL_ID = 'record-4x5m31'
const ORIGINAL_MD5 = '74e5e2f8afcf8f829694aef350629950'
const NODES_MD5 = '3ed9cf16e56b311458f4c6fa7e7f1e2e'
const EDGES_MD5 = '1d0a75acb3d4778a122a4cfd96a23b49'
const CANDIDATE_SHA = '6dbe6da0108dfcc1a22f74ef5556306dbc8382b185ba1d853340d7c10beb8cad'
const ACCEPTED_SHA = 'a0bd06afdcf6f8019f36c0a5d44b9209d27ec97673550090d72faea1ff31a8e3'
const OUTLINE_SHA = '74f1456f01fdf39d58a391e069c5e7b8f289b87ae4554c86b23acc330f13c712'
const SCENE2_SHA = '86a2b90b3c4c6f8745eaeec9563e44b3158e03a4100cf758df13e8305892ad44'
const SHA = /^[a-f0-9]{64}$/
const MD5 = /^[a-f0-9]{32}$/
const fail = reason => { throw Error(`A8B6_FRESH_SCENE2_REPLAY_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
const first = (runs, nodeId, loopIndex) => runs.find(run => run.node?.id === nodeId
  && (loopIndex === undefined || run.loopIndex === loopIndex))?.output

export function assertFreshA8B6Scene2ReplayBoundary(source, original, workflow, prepared) {
  const state = decodeExecutionState(source?.result ?? {}), runs = state.nodeRuns
  const originalRuns = decodeExecutionState(original?.result ?? {}).nodeRuns
  const lineage = prepared?.plan?.source?.firstShotLineage
  const marker = state.sceneCutCompositeRecovery
  if (original?.id !== ORIGINAL_ID || original.result_md5 !== ORIGINAL_MD5
    || original.workflow_id !== 'wf-sanguo-history-drama'
    || !Array.isArray(originalRuns) || originalRuns.length !== 408
    || !/^record-[\w-]+$/.test(String(source?.id)) || !MD5.test(String(source.result_md5))
    || source.workflow_id !== original.workflow_id || state.id !== source.id
    || workflow?.id !== source.workflow_id || workflow.schema_version !== 180
    || workflow.nodes_md5 !== NODES_MD5 || workflow.edges_md5 !== EDGES_MD5
    || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)
    || !Array.isArray(runs) || runs.length !== 464
    || runs.slice(0, 65).some(run => !['success', 'skipped'].includes(run.status))
    || runs.slice(65).some(run => run.status !== 'idle' || run.output !== undefined)
    || runs[64]?.node?.id !== 'sanguo-last-frame'
    || runs[65]?.node?.id !== 'sanguo-shot-script' || runs[65].loopIndex !== 1
    || runs[66]?.node?.id !== 'sanguo-shot-script-review' || runs[66].loopIndex !== 1
    || runs[67]?.node?.id !== 'sanguo-shot-script-accept' || runs[67].loopIndex !== 1
    || runs[11]?.output?.id !== 'scene-01' || runs[11].output.duration !== 14
    || marker?.version !== 'source-bound-composite-a8b6-fresh-first-shot-v1'
    || marker.planId !== lineage?.planId
    || marker.manifestSha256 !== lineage.manifestSha256
    || marker.receiptSha256 !== lineage.receiptSha256
    || marker.workflowApprovalSha256 !== lineage.workflowApprovalSha256
    || marker.compositeVideoUrl !== prepared.plan.source.firstAcceptedVideoUrl
    || marker.compositeVideoSha256 !== prepared.plan.source.firstAcceptedVideoSha256
    || prepared.status !== 'ready-for-new-image-review-only'
    || prepared.plan.version !== 'scene2-regeneration-preflight-a8b6-fresh-v1'
    || prepared.scene2Accepted !== false || prepared.providerCalls !== 0
    || prepared.databaseWrites !== 0
    || prepared.plan.source.firstExecutionId !== source.id
    || prepared.plan.source.firstResultMd5 !== source.result_md5
    || prepared.plan.source.actualFirstTailUrl !== runs[64].output?.url
    || !SHA.test(String(prepared.plan.source.actualFirstTailSha256))
    || prepared.plan.source.firstAcceptSha256
      !== sceneCutRebindSha256(runs[59].output)
    || prepared.plan.source.approvedScene2ScriptSha256 !== ACCEPTED_SHA
    || lineage.version !== 'source-bound-composite-a8b6-fresh-first-shot-v1'
    || lineage.approvedDurationSeconds !== 14
    || !Number.isInteger(lineage.nativeFrameCount)
    || lineage.nativeFrameCount < 335 || lineage.nativeFrameCount > 339
    || !SHA.test(String(prepared.planSha256)))
    fail('formal first shot, signed fresh receipt, actual tail, or graph is not bound')
  const originalOutline = first(originalRuns, 'sanguo-scene-outline-accept')
  const candidate = originalRuns[58]?.output, accepted = originalRuns[60]?.output
  const creative = assertOriginalSecondShotCreativeLock(candidate, accepted)
  if (sha(originalOutline) !== OUTLINE_SHA
    || sha(originalOutline?.scenes?.[1]) !== SCENE2_SHA
    || creative.candidateSha256 !== CANDIDATE_SHA
    || creative.acceptedSha256 !== ACCEPTED_SHA
    || !isDeepStrictEqual(first(runs, 'sanguo-scene-outline-accept'), originalOutline)
    || !isDeepStrictEqual(prepared.plan.source.identityPlates.map(plate => plate.characterName),
      ['张飞', '严颜']))
    fail('original second-shot creative decision or frozen identities changed')
  const graphNodes = new Map(workflow.nodes.map(node => [node.id, node]))
  if (graphNodes.size !== workflow.nodes.length
    || runs.slice(65).some(run => !isDeepStrictEqual(run.node, graphNodes.get(run.node.id))))
    fail('pending scene-02 route differs from schema180')
  const preparedContext = prepareWorkflowRunContext(runs, 65)
  const context = preparedContext?.inputContext
  if (preparedContext?.run?.node?.id !== 'sanguo-shot-script'
    || !isDeepStrictEqual(context?.approved_scene_outline?.scenes, originalOutline.scenes)
    || !isDeepStrictEqual(context?.scene, originalOutline.scenes[1])
    || !isDeepStrictEqual(context?.loop?.previous?.shot_script, runs[11].output)
    || !isDeepStrictEqual(context?.loop?.previous?.video_shot, runs[59].output)
    || !isDeepStrictEqual(context?.loop?.previous?.last_frame, runs[64].output))
    fail('scene-02 context lost the new 14s shot, accepted video, or actual tail')
  storyboardContinuityContext(context)
  return { state, runs, originalOutline, candidate, context, creative }
}

export function prepareFreshA8B6Scene2Replay(source, original, workflow, prepared, {
  id = 'record-a8b6-fresh-scene2-replay-preview',
} = {}) {
  if (!/^record-[\w-]+$/.test(id) || id === source?.id || id === ORIGINAL_ID)
    fail('new replay identity is invalid')
  const { state, runs, originalOutline, candidate, context } =
    assertFreshA8B6Scene2ReplayBoundary(source, original, workflow, prepared)
  const outline = context.scene_outline, scene = originalOutline.scenes[1]
  if (!Array.isArray(outline?.scenes)
    || outline.scenes[1]?.id !== 'scene-02'
    || !isDeepStrictEqual(outline.scenes[1], scene))
    fail('scene-02 outline was modified before replay')
  const projected = sceneFromStoryboardSegment(scene, candidate, 0, 1)
  const scenes = outline.scenes.map((item, index) => ({
    ...(index === 1 ? projected : item), sequence: index + 1,
  }))
  const expanded = { ...context,
    scene_outline: { ...outline, scenes, count: scenes.length,
      totalDuration: scenes.reduce((sum, item) => sum + Number(item.targetDuration), 0) },
    ...(context.scene_loop && typeof context.scene_loop === 'object'
      ? { scene_loop: { ...context.scene_loop, count: scenes.length } } : {}),
  }
  const candidateContext = applyNodeOutputToContext(expanded,
    runs[65].node.resultVar, candidate)
  const nodeRuns = runs.map((run, index) => index === 65
    ? { ...run, output: candidate, context: candidateContext,
      inputContext: context, status: 'success', durationMs: 1 }
    : run)
  const ready = prepareWorkflowRunContext(nodeRuns, 66)
  if (sha(ready?.inputContext?.shot_candidate) !== CANDIDATE_SHA
    || ready?.inputContext?.scene?.id !== 'scene-02'
    || !isDeepStrictEqual(ready.inputContext.loop?.previous?.last_frame, runs[64].output)
    || nodeRuns.findIndex(run => run.status === 'idle') !== 66)
    fail('scene-02 review input is not the original candidate and actual first tail')
  const firstLineage = prepared.plan.source.firstShotLineage
  const recovery = {
    version: 'a8b6-fresh-scene2-script-replay-v1',
    sourceExecutionId: source.id, sourceResultMd5: source.result_md5,
    originalExecutionId: ORIGINAL_ID, originalResultMd5: ORIGINAL_MD5,
    workflowSchemaVersion: 180, workflowNodesMd5: NODES_MD5,
    workflowEdgesMd5: EDGES_MD5,
    originalCandidateSha256: CANDIDATE_SHA,
    originalAcceptedSha256: ACCEPTED_SHA,
    approvedOutlineSha256: OUTLINE_SHA,
    firstShotPlanId: firstLineage.planId,
    firstShotManifestSha256: firstLineage.manifestSha256,
    firstShotReceiptSha256: firstLineage.receiptSha256,
    firstShotWorkflowApprovalSha256: firstLineage.workflowApprovalSha256,
    firstAcceptedVideoSha256: prepared.plan.source.firstAcceptedVideoSha256,
    firstActualTailUrl: prepared.plan.source.actualFirstTailUrl,
    firstActualTailSha256: prepared.plan.source.actualFirstTailSha256,
    firstShotResultSha256: sceneCutRebindSha256(runs[59].output),
    sourceFirstShotPrefixLength: 65,
    sourceFirstShotPrefixSha256: sceneCutRebindSha256(runs.slice(0, 65)),
    preservedPrefixLength: 66,
    preservedPrefixSha256: sceneCutRebindSha256(nodeRuns.slice(0, 66)),
    firstPendingIndex: 66,
    firstPendingNodeId: 'sanguo-shot-script-review',
  }
  const next = { ...state, id, parentExecutionId: source.id,
    generationScopeId: id, requestScopeId: state.requestScopeId ?? source.id,
    historical: false, mode: 'step', nodeRuns, context: candidateContext,
    selectedNodeId: 'sanguo-shot-script-review', branchHistory: [],
    breakpointRollback: undefined, breakpointRollbackHistory: undefined,
    sceneCutFirstFrameRecovery: recovery,
    secondShotReplayRecovery: recovery,
    logs: [...(Array.isArray(state.logs) ? state.logs : []),
      '沿正式14秒首镜的真实尾帧，复用原第二镜候选脚本；从第二镜脚本质检继续。'],
  }
  if (sceneCutRebindSha256(decodeExecutionState(JSON.parse(JSON.stringify(
    encodeExecutionState(next))))) !== sceneCutRebindSha256(next))
    fail('execution storage round trip altered second-shot checkpoint')
  return { state: next, proof: { ...recovery,
    newExecutionId: id, sourceFirstShotCompleted: true,
    secondShotProviderCalls: 0, databaseWrites: 0,
    firstPendingIndex: 66, roundTripVerified: true } }
}
