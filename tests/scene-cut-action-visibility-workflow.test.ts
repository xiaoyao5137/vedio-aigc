import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertSceneCutReviewLedgerRecord } from '../server/scene-cut-frame-runtime.ts'
import { deriveSceneCutOpeningPlan } from '../server/scene-cut-opening-plan.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V170 } from '../src/scene-cut-opening-projection-workflow.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V171 } from '../src/scene-cut-ellipsis-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V172, SCENE_CUT_FRAME_REVIEW_PROMPT_V172,
  sceneCutActionPerformerFeetRequired, upgradeSceneCutActionVisibilityWorkflow,
  validateSceneCutActionVisibilityReview } from '../src/scene-cut-action-visibility-workflow.ts'
import { validateSceneCutTravelStartReview } from '../src/scene-cut-travel-start-workflow.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const streetShot = { id: 'scene-street', continuity: { mode: 'scene_cut' },
  visualTreatment: 'live_action', characters: ['主将', '俘虏'],
  visualPrompt: '东汉战后街口，首帧斜侧全景：主将在左，俘虏在右，近身军士在两侧及侧后方，身前尚留缺口；近身军士持绳，俘虏双腕未缚。动作执行：主将示意合拢，军士缚腕，主将走近。',
  camera: '斜侧全景，35毫米，俘虏双腕清楚可见。主将随后向俘虏走近，镜头跟摇。',
  pacing: { scheduleHash: 'street-schedule', beats: [
    { id: 'close', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '主将抬手示意军士合拢，封住俘虏身前的缺口' } },
    { id: 'bind', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '军士将俘虏双腕缚住' } },
    { id: 'approach', kind: 'action', completion: { requiredThisClip: true,
      evidenceAnchor: '主将走到俘虏面前' } },
  ], schedule: [{ beatId: 'close', startSecond: 0 }, { beatId: 'bind', startSecond: 2.5 },
    { beatId: 'approach', startSecond: 7.5 }] } }

test('schema172 updates only source plate and two managed prompts, then stays stable', () => {
  const archive = { id: 'sanguo-scene-cut-source-archive', params: [
    { id: 'other', englishName: 'shot', value: '${shot_script}' },
    { id: 'sc-source-identity-plate-version', englishName: 'identityPlateVersion',
      value: 'scene-cut-identity-plate-v3' }] }
  const image = { id: 'sanguo-scene-cut-first-frame', prompt: SCENE_CUT_FIRST_FRAME_PROMPT_V170 }
  const review = { id: 'sanguo-scene-cut-review', prompt: SCENE_CUT_FRAME_REVIEW_PROMPT_V171 }
  const plan = { id: 'sanguo-scene-cut-opening-plan', prompt: 'preserved plan' }
  const manual = { id: 'manual', prompt: 'user edit' }
  const graph = { id: 'wf-sanguo-history-drama', schemaVersion: 171,
    nodes: [archive, image, review, plan, manual], edges: [{ id: 'e', from: 'manual', to: 'plan' }] }
  const upgraded = upgradeSceneCutActionVisibilityWorkflow(graph)
  assert.equal(upgraded.schemaVersion, 172)
  assert.equal(upgraded.edges, graph.edges)
  assert.deepEqual(upgraded.nodes.filter((node, index) => node !== graph.nodes[index]).map(node => node.id),
    [archive.id, image.id, review.id])
  assert.deepEqual(upgraded.nodes[0].params?.[0], archive.params[0])
  assert.equal(upgraded.nodes[0].params?.[1].value, 'scene-cut-identity-plate-v4')
  assert.equal(upgraded.nodes[1].prompt, SCENE_CUT_FIRST_FRAME_PROMPT_V172)
  assert.equal(upgraded.nodes[2].prompt, SCENE_CUT_FRAME_REVIEW_PROMPT_V172)
  assert.equal(upgraded.nodes[3], plan)
  assert.equal(upgraded.nodes[4], manual)
  assert.equal(upgradeSceneCutActionVisibilityWorkflow(upgraded), upgraded)
  assert.equal(upgradeSceneCutActionVisibilityWorkflow({ ...upgraded, schemaVersion: 173 }).schemaVersion, 173)
  const manuallyEdited = { ...graph,
    nodes: [archive, { ...image, prompt: 'manual image edit' }, review, plan, manual] }
  assert.equal(upgradeSceneCutActionVisibilityWorkflow(manuallyEdited), manuallyEdited)
})

test('schema172 first-frame prompt stages action performers, clear rope ends and continuous garment proportions', () => {
  const plan = deriveSceneCutOpeningPlan(streetShot, 3)
  const rendered = renderWorkflowTemplate(SCENE_CUT_FIRST_FRAME_PROMPT_V172,
    { scene_cut_opening_state: plan })
  assert.match(rendered, /上方左块.*上方右块.*下方是同一正面原图.*腰以下只缩放一次/s)
  assert.doesNotMatch(rendered, /2×2 局部参考板|左下为革带|右下为内层下摆/)
  assert.match(rendered, /动作执行者.*纯背景人物.*两侧、侧后方/s)
  assert.match(rendered, /全景.*脚掌、脚跟和接触地面.*近景.*不为拍脚扩大画幅/s)
  assert.match(rendered, /待缚双腕.*持绳手.*工作段.*自由端.*不能盖住双腕/s)
  assert.match(rendered, /外袍.*内层下摆.*宽窄.*露出的裤腿和鞋靴比例/s)
  assert.doesNotMatch(rendered, /动作执行：|镜头跟摇|主将走到俘虏面前。/)
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V172,
    /纯背景军士不算必需动作执行者.*全景.*guardsBeforeClosure/su)
})

test('schema172 checks action performers in a wide shot without demanding background soldiers feet', () => {
  assert.equal(sceneCutActionPerformerFeetRequired(streetShot), true)
  const review = { wardrobeHemCheck: { applicable: true, matches: true,
    originalHemAndFootwear: '外袍、宽内摆、靴',
    candidateHemAndFootwear: '相同宽内摆与露靴比例' },
  requiredVisualActionChecks: [
    { beatId: 'close', gestureClosureStartCheck: { actionHandsUnoccluded: true,
      actionPerformersFeetAndGroundVisible: true,
      visibilityEvidence: '左侧主将垂手，两名合拢军士各脚与地面可见；远景背景兵被遮不计' } },
    { beatId: 'bind', bindingStartCheck: { operatorHandAndRopeEndsVisible: true,
      targetRegionUnoccluded: true, actionPerformersFeetAndGroundVisible: true,
      visibilityEvidence: '近身持绳军士手与两端分开，俘虏双腕可见且未绕绳，足部接地' } },
    { beatId: 'approach', travelStartCheck: { applicable: true, atApprovedOrigin: true,
      feetInspectionRequired: true, allParticipantsFeetGrounded: true,
      noStrideInProgress: true, destinationNotReached: true, routeStillPossible: true,
      pixelEvidence: '主将双脚落地，与俘虏仍有两步间距' } },
  ] }
  assert.equal(validateSceneCutActionVisibilityReview(review, streetShot), true)
  assert.equal(validateSceneCutTravelStartReview(review, streetShot, 3,
    sceneCutActionPerformerFeetRequired(streetShot)), true)
  assert.throws(() => validateSceneCutTravelStartReview(review, streetShot, 3),
    /SCENE_CUT_FRAME_REJECTED/, 'old narrow framing predicate cannot claim a wide shot has no feet')
  for (const [index, key] of [[0, 'actionPerformersFeetAndGroundVisible'],
    [0, 'actionHandsUnoccluded'], [1, 'operatorHandAndRopeEndsVisible'],
    [1, 'targetRegionUnoccluded'], [1, 'actionPerformersFeetAndGroundVisible']] as const) {
    const rejected = structuredClone(review)
    const check = rejected.requiredVisualActionChecks[index]
    const detail = index === 0 ? check.gestureClosureStartCheck : check.bindingStartCheck
    ;(detail as Record<string, unknown>)[key] = false
    assert.throws(() => validateSceneCutActionVisibilityReview(rejected, streetShot),
      /SCENE_CUT_FRAME_REJECTED/)
  }
  const badHem = structuredClone(review)
  badHem.wardrobeHemCheck.matches = false
  assert.throws(() => validateSceneCutActionVisibilityReview(badHem, streetShot),
    /SCENE_CUT_FRAME_REJECTED/)
  const closeShot = { ...streetShot,
    visualPrompt: '东汉街口近景，主将和俘虏及近身军士的上半身与双腕入画。',
    camera: '稳定近景，脚部不入画。' }
  assert.equal(sceneCutActionPerformerFeetRequired(closeShot), false)
  const closeReview = structuredClone(review)
  closeReview.requiredVisualActionChecks[0].gestureClosureStartCheck.actionPerformersFeetAndGroundVisible = false
  closeReview.requiredVisualActionChecks[1].bindingStartCheck.actionPerformersFeetAndGroundVisible = false
  assert.equal(validateSceneCutActionVisibilityReview(closeReview, closeShot), true)
})

test('schema172 reviewer ledger requires the current managed prompt, not the previous one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-cut-v172-ledger-'))
  try {
    await mkdir(path.join(root, 'public/generated'), { recursive: true })
    const image = Buffer.from('candidate image bytes')
    await writeFile(path.join(root, 'public/generated/candidate.jpg'), image)
    const expected = { evidence: { evidenceUrl: '/generated/evidence.json' }, shot: streetShot,
      sources: { sourceContext: { approvedOutline: { scenes: [] } } },
      reviewImages: ['/generated/candidate.jpg'],
      openingStatePlan: deriveSceneCutOpeningPlan(streetShot, 3) }
    const review = { passed: false, issues: ['action guard foot is occluded'] }
    const prompt = renderWorkflowTemplate(SCENE_CUT_FRAME_REVIEW_PROMPT_V172,
      { scene_cut_evidence: expected.evidence, shot_script: expected.shot,
        scene_cut_sources: expected.sources, scene_cut_opening_state: expected.openingStatePlan })
    const row = { id: 'model-run-v172-visibility', channel: 'workflow',
      workflow_id: 'wf-sanguo-history-drama', node_id: 'sanguo-scene-cut-review',
      model_id: 'codex-local-vision', capability: 'text', provider: 'Codex', status: 'succeeded',
      request_data: { fingerprint: 'a'.repeat(64), params: expected, prompt,
        reviewImageHashes: [{ url: expected.reviewImages[0],
          sha256: createHash('sha256').update(image).digest('hex') }] },
      response_data: { text: JSON.stringify(review) } }
    assert.equal(assertSceneCutReviewLedgerRecord(row, { ...review, model: row.model_id },
      expected, root, 172), row.id)
    assert.throws(() => assertSceneCutReviewLedgerRecord({ ...row,
      request_data: { ...row.request_data,
        prompt: renderWorkflowTemplate(SCENE_CUT_FRAME_REVIEW_PROMPT_V171,
          { scene_cut_evidence: expected.evidence, shot_script: expected.shot,
            scene_cut_sources: expected.sources, scene_cut_opening_state: expected.openingStatePlan }) } },
    { ...review, model: row.model_id }, expected, root, 172), /SCENE_CUT_FRAME_BLOCKED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
